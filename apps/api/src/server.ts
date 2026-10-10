import type { Server } from "node:http";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { logger } from "./logger.js";
import { findDefaultCredentials, hasDemoCatalog } from "./ops/demoGuard.js";

async function main() {
  if (config.isProd) {
    // Development and demo credentials must never be reachable in production, even by accident.
    const weak = await findDefaultCredentials();
    if (weak.length || (await hasDemoCatalog())) {
      logger.fatal({ accounts: weak }, "Refusing to start: demo data or default passwords found in the production database. Run `npm run provision:admin` and remove demo data.");
      process.exit(1);
    }
  }

  const server: Server = createApp().listen(config.port, () => {
    logger.info({ port: config.port, env: config.env }, "POS API listening");
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 65_000; // above typical proxy idle timeouts

  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting down");
    server.close(async () => {
      await prisma.$disconnect().catch(() => undefined);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 15_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

process.on("unhandledRejection", (reason) => logger.error({ err: reason }, "unhandled rejection"));

main().catch((err) => {
  logger.fatal({ err }, "startup failed");
  process.exit(1);
});