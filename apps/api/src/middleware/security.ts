import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { config } from "../config.js";
import { logger } from "../logger.js";

declare module "express-serve-static-core" {
  interface Request {
    id?: string;
  }
}

/** Correlates a client-visible error with the log line, and logs one structured line per request. */
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const incoming = req.get("x-request-id");
  req.id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader("X-Request-Id", req.id);
  const started = process.hrtime.bigint();
  res.on("finish", () => {
    // Health probes are noisy; query strings may hold search terms (names, phones) so only the path is logged.
    if (req.path === "/health" || req.path === "/ready") return;
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    logger[res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info"](
      { requestId: req.id, method: req.method, path: req.path, status: res.statusCode, ms: Math.round(ms), userId: req.user?.id },
      "request",
    );
  });
  next();
}

/** TLS ends at the reverse proxy. Anything that did not arrive over HTTPS is refused in production. */
export function requireHttps(req: Request, res: Response, next: NextFunction) {
  if (!config.enforceHttps || req.secure || req.path === "/health" || req.path === "/ready") return next();
  res.status(426).json({ error: "HTTPS is required" });
}

export const securityHeaders = helmet({
  // This service only emits JSON, PDF and CSV. Nothing it sends should ever be rendered or framed.
  contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } },
  referrerPolicy: { policy: "no-referrer" },
  hsts: config.isProd ? { maxAge: 31_536_000, includeSubDomains: true, preload: false } : false,
  crossOriginResourcePolicy: { policy: "same-site" },
});

export const noStore = (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "no-store");
  next();
};

export const corsMiddleware = cors({
  origin(origin, cb) {
    // Same-origin and non-browser requests carry no Origin header.
    if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
    cb(new Error("Origin not allowed"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  maxAge: 600,
});

const keyOf = (req: Request) => req.user?.id ?? req.ip ?? "unknown";
const limiter = (limit: number, windowMs: number, message: string) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: keyOf,
    handler: (_req, res) => res.status(429).json({ error: message }),
  });

export const loginLimiter = limiter(config.loginRateLimitMax, 15 * 60_000, "Too many sign-in attempts. Try again later.");
export const apiLimiter = limiter(config.apiRateLimitMax, 60_000, "Too many requests. Slow down.");
// Refunds, voids, exchanges, exports and user administration: rare, high-impact operations.
export const sensitiveLimiter = limiter(config.sensitiveRateLimitMax, 60_000, "Too many sensitive operations. Try again shortly.");
