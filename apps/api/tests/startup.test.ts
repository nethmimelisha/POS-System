import { execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { prisma } from "../src/db.js";

const root = path.resolve(import.meta.dirname, "..");
const PW = "Prod-Start-Pw-4471";
const DB = "pos_prod_start";
const PORT = 4191;
let url: string;

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, NODE_ENV: "production", DATABASE_URL: url, CORS_ORIGIN: "https://pos.example.lk", PORT: String(PORT), LOG_LEVEL: "warn", ...extra };
}

function start(extra: Record<string, string> = {}): ChildProcess {
  return spawn(process.execPath, ["dist/src/server.js"], { cwd: root, env: env(extra), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

const exited = (p: ChildProcess, ms = 20_000) =>
  new Promise<number | null>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("process did not exit")), ms);
    p.on("exit", (code) => (clearTimeout(t), resolve(code)));
  });

async function waitFor(path_: string, p: ChildProcess) {
  for (let i = 0; i < 80; i++) {
    if (p.exitCode !== null) throw new Error(`server exited early with ${p.exitCode}`);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}${path_}`);
      return r;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error("server did not start");
}

describe("production build and startup", () => {
  beforeAll(async () => {
    execSync("npm run build", { cwd: root, stdio: "pipe", shell: process.platform === "win32" ? "cmd.exe" : undefined });
    await prisma.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prod_start') THEN CREATE ROLE prod_start LOGIN SUPERUSER PASSWORD '${PW}'; END IF; END $$`);
    await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await prisma.$executeRawUnsafe(`CREATE DATABASE ${DB}`);
    const u = new URL(process.env.DATABASE_URL!);
    u.username = "prod_start";
    u.password = PW;
    u.pathname = `/${DB}`;
    url = u.toString();
    execSync("npx prisma migrate deploy", { cwd: root, env: { ...process.env, DATABASE_URL: url }, stdio: "pipe", shell: process.platform === "win32" ? "cmd.exe" : undefined });
  }, 240_000);
  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
  });

  it("produces a runnable build", () => {
    expect(fs.existsSync(path.join(root, "dist/src/server.js"))).toBe(true);
    for (const f of ["backup", "backupScheduler", "restore", "verifyRestore", "provisionAdmin"]) expect(fs.existsSync(path.join(root, `dist/src/ops/${f}.js`))).toBe(true);
  });

  it("starts in production mode, reports healthy and shuts down cleanly", async () => {
    const p = start();
    try {
      expect((await waitFor("/health", p)).status).toBe(200);
      const ready = await fetch(`http://127.0.0.1:${PORT}/ready`);
      expect(ready.status).toBe(200);
      const plain = await fetch(`http://127.0.0.1:${PORT}/api/v1/auth/me`);
      expect(plain.status).toBe(426);
      const secure = await fetch(`http://127.0.0.1:${PORT}/api/v1/auth/me`, { headers: { "x-forwarded-proto": "https" } });
      expect(secure.status).toBe(401);
      expect(secure.headers.get("strict-transport-security")).toBeTruthy();
    } finally {
      p.kill("SIGTERM");
      await exited(p).catch(() => p.kill("SIGKILL"));
    }
  }, 60_000);

  it("refuses to start with unsafe production configuration", async () => {
    for (const bad of [{ CORS_ORIGIN: "*" }, { SEED_DEMO: "1" }, { ENFORCE_HTTPS: "false" }] as Record<string, string>[]) {
      const p = start(bad);
      expect(await exited(p)).not.toBe(0);
    }
  }, 60_000);

  it("refuses to start when default demo credentials exist", async () => {
    const demoUrl = new URL(url);
    const { PrismaClient } = await import("@prisma/client");
    const client = new PrismaClient({ datasources: { db: { url: demoUrl.toString() } } });
    await client.user.upsert({ where: { username: "admin" }, update: { passwordHash: bcrypt.hashSync("Admin12345!", 4) }, create: { username: "admin", fullName: "Admin", role: "ADMIN", passwordHash: bcrypt.hashSync("Admin12345!", 4) } });
    const p = start();
    const code = await exited(p);
    await client.user.deleteMany({ where: { username: "admin" } });
    await client.$disconnect();
    expect(code).not.toBe(0);
  }, 60_000);
});