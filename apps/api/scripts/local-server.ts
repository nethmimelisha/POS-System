/**
 * Runs the whole backend locally with no Postgres install: embedded PostgreSQL + migrations + seed + API.
 *   npm run local            persistent data in apps/api/.local-pg, demo data included
 * Environment: PORT (4000), PG_PORT (54330), LOCAL_PG_DIR, LOCAL_PG_FRESH=1 (start from an empty database),
 * SEED_DEMO=0 (skip demo users and products), SEED_ADMIN_PASSWORD, DEMO_PASSWORD.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";

const pgPort = Number(process.env.PG_PORT ?? 54330);
const dir = path.resolve(process.env.LOCAL_PG_DIR ?? ".local-pg");

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("The local development server cannot run with NODE_ENV=production");
  if (process.env.LOCAL_PG_FRESH === "1") fs.rmSync(dir, { recursive: true, force: true });
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: "pos", password: "pos", port: pgPort, persistent: true });
  if (!fs.existsSync(path.join(dir, "PG_VERSION"))) await pg.initialise();
  await pg.start();
  try {
    await pg.createDatabase("pos");
  } catch {
    // Already exists from a previous run.
  }

  const url = `postgresql://pos:pos@localhost:${pgPort}/pos`;
  process.env.DATABASE_URL = url;
  process.env.SEED_ADMIN_PASSWORD ??= "Admin12345!";
  execSync("npx prisma migrate deploy", { env: process.env, stdio: "inherit" });
  execSync("npx tsx prisma/seed.ts", { env: process.env, stdio: "inherit" });

  if (process.env.SEED_DEMO !== "0") {
    const { PrismaClient } = await import("@prisma/client");
    const { seedDemo, DEMO_PASSWORD } = await import("../prisma/seed-demo.js");
    const prisma = new PrismaClient();
    await seedDemo(prisma);
    await prisma.$disconnect();
    console.log(`Demo users: admin / ${process.env.SEED_ADMIN_PASSWORD}, manager / ${DEMO_PASSWORD}, cashier / ${DEMO_PASSWORD}`);
  }

  const stop = async () => {
    await pg.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await import("../src/server.js");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
