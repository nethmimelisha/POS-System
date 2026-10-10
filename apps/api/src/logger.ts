import pino from "pino";
import { config } from "./config.js";

/** Paths whose values are removed from every log line. Cookies, credentials and customer personal data. */
export const REDACT_PATHS = [
  "password",
  "*.password",
  "currentPassword",
  "newPassword",
  "*.currentPassword",
  "*.newPassword",
  "passwordHash",
  "*.passwordHash",
  "token",
  "*.token",
  "tokenHash",
  "*.tokenHash",
  "authorization",
  "cookie",
  "req.headers.authorization",
  "req.headers.cookie",
  "headers.authorization",
  "headers.cookie",
  "email",
  "*.email",
  "phone",
  "*.phone",
  "address",
  "*.address",
  "customerName",
  "*.customerName",
  "databaseUrl",
  "DATABASE_URL",
];

// Database URLs carry the password and Prisma sometimes quotes them in error messages.
const URL_SECRET = /\b(postgres(?:ql)?):\/\/[^\s'"@]*@/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;

export const scrub = (text: string) => text.replace(URL_SECRET, "$1://***@").replace(BEARER, "$1 ***");

export function serializeError(err: unknown) {
  if (!(err instanceof Error)) return { message: scrub(String(err)) };
  return {
    type: err.name,
    message: scrub(err.message),
    stack: config.isProd ? undefined : err.stack ? scrub(err.stack) : undefined,
    code: (err as { code?: string }).code,
  };
}

export function createLogger(level: string = config.logLevel, destination?: pino.DestinationStream) {
  return pino(
    {
      level,
      base: { service: "pos-api", env: config.env },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
      serializers: { err: serializeError },
      formatters: { level: (label) => ({ level: label }) },
    },
    destination,
  );
}

export const logger = createLogger();
