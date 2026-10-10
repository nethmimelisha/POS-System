import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";

const PORT = 54329;
const dir = path.join(os.tmpdir(), `pos-test-pg-${process.pid}`);
let pg: EmbeddedPostgres;

export async function setup() {
  pg = new EmbeddedPostgres({ databaseDir: dir, user: "pos", password: "pos", port: PORT, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("pos_test");
  const url = `postgresql://pos:pos@localhost:${PORT}/pos_test`;
  process.env.DATABASE_URL = url;
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
  execSync("npx tsx prisma/seed.ts", {
    env: { ...process.env, DATABASE_URL: url, SEED_ADMIN_PASSWORD: "TestPass123!" },
    stdio: "pipe",
  });
}

export async function teardown() {
  await pg?.stop();
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch {
    // Windows may keep files locked briefly; the temp dir is disposable.
  }
}
