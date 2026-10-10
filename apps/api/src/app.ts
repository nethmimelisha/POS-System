import express from "express";
import cookieParser from "cookie-parser";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { errorHandler } from "./middleware/error.js";
import { apiLimiter, corsMiddleware, noStore, requestLogger, requireHttps, securityHeaders, sensitiveLimiter } from "./middleware/security.js";
import { requireAuth } from "./middleware/auth.js";
import { authRouter } from "./routes/auth.js";
import { usersRouter } from "./routes/users.js";
import { productsRouter } from "./routes/products.js";
import { inventoryRouter } from "./routes/inventory.js";
import { salesRouter } from "./routes/sales.js";
import { returnsRouter } from "./routes/returns.js";
import { exchangesRouter } from "./routes/exchanges.js";
import { shiftsRouter } from "./routes/shifts.js";
import { customersRouter } from "./routes/customers.js";
import { reportsRouter } from "./routes/reports.js";
import { exportsRouter } from "./routes/exports.js";
import { paymentMethodsRouter, registersRouter } from "./routes/reference.js";
import { brandsRouter, categoriesRouter, settingsRouter, taxRatesRouter } from "./routes/catalog.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxyHops);
  app.use(requestLogger);
  app.use(securityHeaders);

  // Liveness: the process is up. Readiness: it can reach the database. Neither exposes details.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.get("/ready", async (_req, res) => {
    try {
      await Promise.race([
        prisma.$queryRaw`SELECT 1`,
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000).unref()),
      ]);
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });

  app.use(requireHttps);
  app.use(corsMiddleware);
  app.use(express.json({ limit: config.jsonBodyLimit }));
  app.use(cookieParser());

  const api = express.Router();
  api.use(noStore, apiLimiter);
  api.use("/auth", authRouter);
  api.use(requireAuth);
  api.use("/users", sensitiveLimiter, usersRouter);
  api.use("/settings", settingsRouter);
  api.use("/tax-rates", taxRatesRouter);
  api.use("/categories", categoriesRouter);
  api.use("/brands", brandsRouter);
  api.use("/products", productsRouter);
  api.use("/inventory", inventoryRouter);
  api.use("/registers", registersRouter);
  api.use("/payment-methods", paymentMethodsRouter);
  api.use("/sales", salesRouter);
  api.use("/returns", sensitiveLimiter, returnsRouter);
  api.use("/exchanges", sensitiveLimiter, exchangesRouter);
  api.use("/exports", sensitiveLimiter, exportsRouter);
  api.use("/shifts", shiftsRouter);
  api.use("/customers", customersRouter);
  api.use("/reports", reportsRouter);
  app.use("/api/v1", api);

  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  app.use(errorHandler);
  return app;
}