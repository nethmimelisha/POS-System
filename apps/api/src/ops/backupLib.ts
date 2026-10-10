import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { scrub } from "../logger.js";

// Everything here reads process.env directly so the backup tooling keeps working even if the web app's config would refuse to load.

const MAGIC = Buffer.from("POSBK1");
const IV_LEN = 12;
const TAG_LEN = 16;

export interface DbTarget {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
}

export function parseDbUrl(url: string): DbTarget {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port || "5432",
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, "")),
  };
}

export function buildDbUrl(t: DbTarget, database = t.database): string {
  return `postgresql://${encodeURIComponent(t.user)}:${encodeURIComponent(t.password)}@${t.host}:${t.port}/${encodeURIComponent(database)}`;
}

const pgEnv = (t: DbTarget) => ({ ...process.env, PGPASSWORD: t.password, PGCONNECT_TIMEOUT: "10" });
const connArgs = (t: DbTarget) => ["-h", t.host, "-p", t.port, "-U", t.user];

export const tool = (name: "pg_dump" | "pg_restore" | "psql") => process.env[`${name.toUpperCase()}_PATH`] || name;

export function encryptionKey(): Buffer {
  const raw = process.env.BACKUP_ENCRYPTION_KEY;
  if (!raw) throw new Error("BACKUP_ENCRYPTION_KEY is not set (base64 of 32 random bytes)");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("BACKUP_ENCRYPTION_KEY must be base64 of exactly 32 bytes (AES-256)");
  return key;
}

export const generateKey = () => crypto.randomBytes(32).toString("base64");

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(new Error(`Cannot run ${path.basename(cmd)}: ${e.message}`)));
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(cmd)} exited ${code}: ${scrub(err.trim()).slice(0, 1500)}`))));
    if (input !== undefined) child.stdin.end(input);
  });
}

export const psql = (t: DbTarget, sql: string, database = t.database) =>
  run(tool("psql"), [...connArgs(t), "-d", database, "-X", "-At", "-F", ",", "-v", "ON_ERROR_STOP=1", "-c", sql], pgEnv(t));

const COUNT_SQL = `SELECT table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
  FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations' ORDER BY 1`;

export interface Fingerprint {
  rowCounts: Record<string, number>;
  salesGrandTotal: string | null;
}

/** Row counts per table plus the sum of all sale totals; compared before and after a restore. */
export async function fingerprint(t: DbTarget): Promise<Fingerprint> {
  const rows = (await psql(t, COUNT_SQL)).trim().split(/\r?\n/).filter(Boolean);
  const rowCounts: Record<string, number> = {};
  for (const line of rows) {
    const [name, n] = line.split(",");
    rowCounts[name] = Number(n);
  }
  const total = (await psql(t, `SELECT COALESCE(SUM("grandTotal"), 0)::text FROM "Sale"`).catch(() => "")).trim();
  return { rowCounts, salesGrandTotal: total || null };
}

export interface Manifest {
  file: string;
  createdAt: string;
  database: string;
  sizeBytes: number;
  sha256: string;
  encryption: "aes-256-gcm";
  fingerprint: Fingerprint;
}

export interface BackupStatus {
  ok: boolean;
  at: string;
  file?: string;
  error?: string;
}

export const backupDir = () => path.resolve(process.env.BACKUP_DIR || "./backups");
const statusPath = () => path.join(backupDir(), "last-backup.json");

async function writeStatus(s: BackupStatus) {
  await fsp.mkdir(backupDir(), { recursive: true });
  await fsp.writeFile(statusPath(), JSON.stringify(s, null, 2));
}

export async function readStatus(): Promise<BackupStatus | null> {
  try {
    return JSON.parse(await fsp.readFile(statusPath(), "utf8")) as BackupStatus;
  } catch {
    return null;
  }
}

export async function sendAlert(subject: string, detail: string): Promise<void> {
  console.error(`[backup-alert] ${subject}: ${detail}`);
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // "text" is understood by Slack/Mattermost/Discord-style webhooks, the rest by generic receivers.
      body: JSON.stringify({ text: `POS backup alert: ${subject}\n${detail}`, subject, detail, at: new Date().toISOString() }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error(`[backup-alert] webhook responded ${res.status}`);
  } catch (e) {
    console.error(`[backup-alert] webhook failed: ${(e as Error).message}`);
  }
}

function sha256OfFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (d) => h.update(d)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

/** pg_dump (custom format) -> AES-256-GCM -> file. The GCM tag is appended so tampering or truncation is detected on restore. */
export async function createBackup(databaseUrl = process.env.DATABASE_URL): Promise<{ file: string; manifest: Manifest }> {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const target = parseDbUrl(databaseUrl);
  const key = encryptionKey();
  const dir = backupDir();
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `pos-${stamp()}.dump.enc`);
  const partial = `${file}.partial`;

  try {
    const before = await fingerprint(target);
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const dump = spawn(tool("pg_dump"), [...connArgs(target), "-d", target.database, "-Fc", "--no-owner", "--no-privileges"], { env: pgEnv(target), windowsHide: true });
    let stderr = "";
    dump.stderr.on("data", (d) => (stderr += d));
    const exited = new Promise<void>((resolve, reject) => {
      dump.on("error", (e) => reject(new Error(`Cannot run pg_dump: ${e.message}`)));
      dump.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump exited ${code}: ${scrub(stderr.trim()).slice(0, 1500)}`))));
    });
    const out = fs.createWriteStream(partial, { mode: 0o600 });
    out.write(Buffer.concat([MAGIC, iv]));
    await Promise.all([pipeline(dump.stdout, cipher, new Transform({ transform: (c, _e, cb) => cb(null, c), flush(cb) { cb(); } }), out, { end: false }), exited]);
    await new Promise<void>((resolve, reject) => out.end(cipher.getAuthTag(), (e?: Error | null) => (e ? reject(e) : resolve())));

    const size = (await fsp.stat(partial)).size;
    if (size <= MAGIC.length + IV_LEN + TAG_LEN + 100) throw new Error("Backup file is implausibly small");
    await fsp.rename(partial, file);

    const manifest: Manifest = {
      file: path.basename(file),
      createdAt: new Date().toISOString(),
      database: target.database,
      sizeBytes: size,
      sha256: await sha256OfFile(file),
      encryption: "aes-256-gcm",
      fingerprint: before,
    };
    await fsp.writeFile(`${file}.manifest.json`, JSON.stringify(manifest, null, 2));
    await writeStatus({ ok: true, at: manifest.createdAt, file: manifest.file });
    return { file, manifest };
  } catch (e) {
    await fsp.rm(partial, { force: true });
    throw e;
  }
}

/** Runs a backup, records the outcome, prunes old files and raises an alert on failure. */
export async function runBackupJob(): Promise<{ ok: boolean; file?: string }> {
  try {
    const { file } = await createBackup();
    await applyRetention();
    console.log(`[backup] ok ${path.basename(file)}`);
    return { ok: true, file };
  } catch (e) {
    const message = scrub((e as Error).message);
    await writeStatus({ ok: false, at: new Date().toISOString(), error: message }).catch(() => undefined);
    await sendAlert("backup FAILED", message);
    return { ok: false };
  }
}

export async function listBackups(): Promise<{ file: string; mtime: number }[]> {
  const dir = backupDir();
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  const files = await Promise.all(
    names.filter((n) => n.endsWith(".dump.enc")).map(async (n) => ({ file: path.join(dir, n), mtime: (await fsp.stat(path.join(dir, n))).mtimeMs })),
  );
  return files.sort((a, b) => b.mtime - a.mtime);
}

/** Deletes backups older than BACKUP_RETENTION_DAYS, always keeping the newest BACKUP_MIN_KEEP. */
export async function applyRetention(now = Date.now()): Promise<string[]> {
  const days = Number(process.env.BACKUP_RETENTION_DAYS ?? 30);
  const keep = Number(process.env.BACKUP_MIN_KEEP ?? 7);
  const cutoff = now - days * 86_400_000;
  const removed: string[] = [];
  const all = await listBackups();
  for (const [i, b] of all.entries()) {
    if (i < keep || b.mtime >= cutoff) continue;
    await fsp.rm(b.file, { force: true });
    await fsp.rm(`${b.file}.manifest.json`, { force: true });
    removed.push(path.basename(b.file));
  }
  return removed;
}

/** Alerts when the newest successful backup is older than BACKUP_MAX_AGE_HOURS or the last attempt failed. */
export async function checkBackupFreshness(now = Date.now()): Promise<{ ok: boolean; reason?: string }> {
  const maxAgeMs = Number(process.env.BACKUP_MAX_AGE_HOURS ?? 26) * 3_600_000;
  const status = await readStatus();
  const newest = (await listBackups())[0];
  let reason: string | undefined;
  if (!newest) reason = "no backup files found";
  else if (now - newest.mtime > maxAgeMs) reason = `latest backup is ${Math.round((now - newest.mtime) / 3_600_000)}h old (limit ${process.env.BACKUP_MAX_AGE_HOURS ?? 26}h)`;
  else if (status && !status.ok) reason = `last backup attempt failed: ${status.error}`;
  if (reason) {
    await sendAlert("backup is stale or failing", reason);
    return { ok: false, reason };
  }
  return { ok: true };
}

/** Decrypts to a temporary .dump file after verifying the GCM tag. Caller deletes it. */
export async function decryptBackup(file: string, outFile: string): Promise<void> {
  const key = encryptionKey();
  const { size } = await fsp.stat(file);
  const headerLen = MAGIC.length + IV_LEN;
  if (size < headerLen + TAG_LEN) throw new Error("Backup file is truncated");
  const fd = await fsp.open(file, "r");
  const head = Buffer.alloc(headerLen);
  const tag = Buffer.alloc(TAG_LEN);
  await fd.read(head, 0, headerLen, 0);
  await fd.read(tag, 0, TAG_LEN, size - TAG_LEN);
  await fd.close();
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Not a POS backup file");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, head.subarray(MAGIC.length));
  decipher.setAuthTag(tag);
  try {
    await pipeline(fs.createReadStream(file, { start: headerLen, end: size - TAG_LEN - 1 }), decipher, fs.createWriteStream(outFile, { mode: 0o600 }));
  } catch (e) {
    await fsp.rm(outFile, { force: true });
    throw new Error(`Backup failed integrity check (wrong key or file was modified): ${(e as Error).message}`);
  }
}

export interface RestoreOptions {
  file: string;
  targetUrl: string;
  /** Replace objects in a database that already has data. */
  clean?: boolean;
}

export async function restoreBackup(opts: RestoreOptions): Promise<void> {
  const target = parseDbUrl(opts.targetUrl);
  const tmp = path.join(backupDir(), `.restore-${crypto.randomUUID()}.dump`);
  await fsp.mkdir(backupDir(), { recursive: true });
  await decryptBackup(opts.file, tmp);
  try {
    const args = [...connArgs(target), "-d", target.database, "--no-owner", "--no-privileges", "--exit-on-error"];
    if (opts.clean) args.push("--clean", "--if-exists");
    await run(tool("pg_restore"), [...args, tmp], pgEnv(target));
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

const sameDb = (a: DbTarget, b: DbTarget) => a.host === b.host && a.port === b.port && a.database === b.database;

/** True when the restore target is the live database configured in DATABASE_URL. */
export function targetsLiveDatabase(targetUrl: string, liveUrl = process.env.DATABASE_URL): boolean {
  return !!liveUrl && sameDb(parseDbUrl(targetUrl), parseDbUrl(liveUrl));
}

export interface VerifyResult {
  ok: boolean;
  database: string;
  mismatches: string[];
  restoredRows: number;
  sourceSalesTotal: string | null;
  restoredSalesTotal: string | null;
}

/** Restores into a throw-away database on the same server, compares it with the manifest, then drops it. */
export async function verifyRestore(file: string, serverUrl = process.env.DATABASE_URL): Promise<VerifyResult> {
  if (!serverUrl) throw new Error("DATABASE_URL is not set");
  const server = parseDbUrl(serverUrl);
  const manifestPath = `${file}.manifest.json`;
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8")) as Manifest;
  const actualSha = await sha256OfFile(file);
  const mismatches: string[] = [];
  if (actualSha !== manifest.sha256) mismatches.push("file checksum differs from manifest");

  const scratch = `pos_restore_check_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
  await psql(server, `CREATE DATABASE "${scratch}"`, "postgres");
  try {
    await restoreBackup({ file, targetUrl: buildDbUrl(server, scratch) });
    const restored = await fingerprint({ ...server, database: scratch });
    const names = new Set([...Object.keys(manifest.fingerprint.rowCounts), ...Object.keys(restored.rowCounts)]);
    for (const n of names) {
      if (manifest.fingerprint.rowCounts[n] !== restored.rowCounts[n]) mismatches.push(`${n}: backup ${manifest.fingerprint.rowCounts[n]} vs restored ${restored.rowCounts[n]}`);
    }
    if (manifest.fingerprint.salesGrandTotal !== restored.salesGrandTotal) mismatches.push("sum of sale totals differs");
    return {
      ok: mismatches.length === 0,
      database: scratch,
      mismatches,
      restoredRows: Object.values(restored.rowCounts).reduce((a, b) => a + b, 0),
      sourceSalesTotal: manifest.fingerprint.salesGrandTotal,
      restoredSalesTotal: restored.salesGrandTotal,
    };
  } finally {
    await psql(server, `DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`, "postgres").catch((e) => console.error(`could not drop ${scratch}: ${e.message}`));
  }
}
