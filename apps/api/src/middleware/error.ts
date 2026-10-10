import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { config } from "../config.js";
import { logger } from "../logger.js";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestId = req.id;
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err instanceof ZodError) {
    return res.status(400).json({ error: "Validation failed", issues: err.issues });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      // Column names are internal detail; only development clients get them.
      return res.status(409).json({ error: "Duplicate value", ...(config.isProd ? {} : { target: err.meta?.target }) });
    }
    if (err.code === "P2025") return res.status(404).json({ error: "Not found" });
    if (err.code === "P2003") return res.status(409).json({ error: "Referenced record missing or in use" });
  }
  // Errors raised by Express middleware (body parser, CORS) carry a status and a safe type.
  const e = err as { type?: string; status?: number; message?: string };
  if (e?.type === "entity.too.large") return res.status(413).json({ error: "Request body too large" });
  if (e?.type === "entity.parse.failed") return res.status(400).json({ error: "Malformed JSON body" });
  if (e?.message === "Origin not allowed") return res.status(403).json({ error: "Origin not allowed" });

  logger.error({ err, requestId, method: req.method, path: req.path, userId: req.user?.id }, "unhandled error");
  // The client gets a correlation id, never a message, stack or SQL.
  res.status(500).json({ error: "Internal server error", requestId });
}
