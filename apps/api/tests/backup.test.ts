import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { PASSWORD } from "./helpers.js";

const TOOLS = process.env.PG_TOOLS_DIR ?? "C:\\Users\\STZ\\pgtools\\bin";
const exe = (n: string) => path.join(TOOLS, process.platform === "win32" ? `${n}.exe` : n);
const haveTools = ["pg_dump", "pg_restore", "psql"].every((n) => fs.existsSync(exe(n)));

// Needs the PostgreSQL client tools (set PG_TOOLS_DIR). Skipped, loudly, where they are not installed.
describe.skipIf(!haveTools)("encrypted backup and restore", () => {
  let dir: string;
  let lib: typeof import("../src/ops/backupLib.js");
  const KEY = Buffer.alloc(32, 7).toString("base64");

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-backup-"));
    process.env.PG_DUMP_PATH = exe("pg_dump");
    process.env.PG_RESTORE_PATH = exe("pg_restore");
    process.env.PSQL_PATH = exe("psql");
    process.env.BACKUP_DIR = dir;
    process.env.BACKUP_ENCRYPTION_KEY = KEY;
    lib = await import("../src/ops/backupLib.js");
    await prisma.user.upsert({ where: { username: "bk_user" }, update: {}, create: { username: "bk_user", fullName: "Backup User", role: "CASHIER", passwordHash: PASSWORD } });
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("creates an encrypted backup that is not a readable dump", async () => {
    const { file, manifest } = await lib.createBackup();
    const raw = fs.readFileSync(file);
    expect(raw.subarray(0, 6).toString()).toBe("POSBK1");
    expect(raw.includes(Buffer.from("PGDMP"))).toBe(false);
    expect(raw.includes(Buffer.from("bk_user"))).toBe(false);
    expect(manifest.fingerprint.rowCounts.User).toBeGreaterThan(0);
    expect(JSON.parse(fs.readFileSync(`${file}.manifest.json`, "utf8")).sha256).toBe(manifest.sha256);
    expect((await lib.readStatus())?.ok).toBe(true);
  });

  it("restores into an isolated database and matches the source exactly", async () => {
    const file = (await lib.listBackups())[0].file;
    const result = await lib.verifyRestore(file);
    expect(result.mismatches).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.restoredRows).toBeGreaterThan(0);
    const left = await prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) AS n FROM pg_database WHERE datname LIKE 'pos_restore_check_%'`;
    expect(Number(left[0].n)).toBe(0);
  });

  it("detects a tampered backup and a wrong key", async () => {
    const file = (await lib.listBackups())[0].file;
    const tampered = path.join(dir, "tampered.dump.enc");
    const bytes = fs.readFileSync(file);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    fs.writeFileSync(tampered, bytes);
    await expect(lib.decryptBackup(tampered, path.join(dir, "x.dump"))).rejects.toThrow(/integrity/);
    expect(fs.existsSync(path.join(dir, "x.dump"))).toBe(false);

    process.env.BACKUP_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    await expect(lib.decryptBackup(file, path.join(dir, "y.dump"))).rejects.toThrow(/integrity/);
    process.env.BACKUP_ENCRYPTION_KEY = KEY;
  });

  it("refuses restoring over the live database without confirmation", () => {
    expect(lib.targetsLiveDatabase(process.env.DATABASE_URL!)).toBe(true);
    expect(lib.targetsLiveDatabase("postgresql://u:p@localhost:5/other")).toBe(false);
  });

  it("applies retention but always keeps the newest backups", async () => {
    for (const n of ["pos-old1.dump.enc", "pos-old2.dump.enc", "pos-old3.dump.enc"]) {
      const f = path.join(dir, n);
      fs.writeFileSync(f, "x");
      fs.utimesSync(f, new Date(Date.now() - 90 * 86_400_000), new Date(Date.now() - 90 * 86_400_000));
    }
    process.env.BACKUP_RETENTION_DAYS = "30";
    process.env.BACKUP_MIN_KEEP = "1";
    const removed = await lib.applyRetention();
    expect(removed.sort()).toEqual(["pos-old1.dump.enc", "pos-old2.dump.enc", "pos-old3.dump.enc"]);
    expect((await lib.listBackups()).length).toBeGreaterThanOrEqual(1);
    process.env.BACKUP_MIN_KEEP = "7";
  });

  it("alerts when the backup is stale and when a backup fails", async () => {
    const received: unknown[] = [];
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        received.push(JSON.parse(body));
        res.end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env.ALERT_WEBHOOK_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`;
    try {
      const stale = await lib.checkBackupFreshness(Date.now() + 72 * 3_600_000);
      expect(stale.ok).toBe(false);
      expect(received).toHaveLength(1);

      const savedUrl = process.env.DATABASE_URL;
      process.env.DATABASE_URL = "postgresql://pos:wrong@localhost:54329/pos_test";
      const job = await lib.runBackupJob();
      process.env.DATABASE_URL = savedUrl;
      expect(job.ok).toBe(false);
      expect(received).toHaveLength(2);
      expect(JSON.stringify(received[1])).not.toContain("wrong@");
      expect((await lib.readStatus())?.ok).toBe(false);
    } finally {
      delete process.env.ALERT_WEBHOOK_URL;
      server.close();
    }
  });
});