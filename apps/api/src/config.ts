import "dotenv/config";
import { z } from "zod";

/**
 * All environment variables are read and validated here, once, at startup.
 * `loadConfig` is pure (it takes the environment as an argument) so production rules can be tested.
 * In production an invalid or unsafe configuration stops the process instead of starting insecurely.
 */
const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: int(1, 65535).default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  SESSION_TTL_HOURS: int(1, 168).default(12),
  MAX_CASHIER_DISCOUNT_PCT: z.coerce.number().min(0).max(100).default(10),
  TRUST_PROXY_HOPS: int(0, 5).default(1),
  ENFORCE_HTTPS: bool.optional(),
  JSON_BODY_LIMIT: z.string().regex(/^\d+(kb|mb)$/i, "Use a size such as 256kb").default("256kb"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional(),
  LOGIN_RATE_LIMIT_MAX: int(1, 100_000).optional(),
  SENSITIVE_RATE_LIMIT_MAX: int(1, 100_000).optional(),
  API_RATE_LIMIT_MAX: int(1, 1_000_000).optional(),
  // Development helpers. They are refused in production below.
  SEED_DEMO: z.string().optional(),
  ENABLE_DEMO_USERS: z.string().optional(),
  DEMO_PASSWORD: z.string().optional(),
  SEED_ADMIN_PASSWORD: z.string().optional(),
});

export class ConfigError extends Error {}

const isLocalHost = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");

export function loadConfig(env: NodeJS.ProcessEnv) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "env"}: ${i.message}`);
    throw new ConfigError(`Invalid environment configuration:\n${lines.join("\n")}`);
  }
  const e = parsed.data;
  const isProd = e.NODE_ENV === "production";
  const isTest = e.NODE_ENV === "test";
  const origins = e.CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);
  const problems: string[] = [];

  if (!/^postgres(ql)?:\/\//.test(e.DATABASE_URL)) problems.push("DATABASE_URL must be a postgresql:// URL");

  for (const o of origins) {
    let url: URL;
    try {
      url = new URL(o);
    } catch {
      problems.push(`CORS_ORIGIN contains an invalid origin: ${o}`);
      continue;
    }
    if (url.origin !== o) problems.push(`CORS_ORIGIN entries must be bare origins without a path or trailing slash: ${o}`);
    if (isProd) {
      if (o.includes("*")) problems.push("CORS_ORIGIN must not contain wildcards in production");
      if (url.protocol !== "https:") problems.push(`CORS_ORIGIN must use https in production: ${o}`);
      if (isLocalHost(url.hostname)) problems.push(`CORS_ORIGIN must not point at localhost in production: ${o}`);
    }
  }
  if (!origins.length) problems.push("CORS_ORIGIN must list at least one origin");

  if (isProd) {
    if (e.SEED_DEMO !== undefined && e.SEED_DEMO !== "0") problems.push("SEED_DEMO must not be set in production");
    if (e.ENABLE_DEMO_USERS !== undefined) problems.push("ENABLE_DEMO_USERS must not be set in production");
    if (e.DEMO_PASSWORD) problems.push("DEMO_PASSWORD must not be set in production");
    if (e.SEED_ADMIN_PASSWORD) problems.push("SEED_ADMIN_PASSWORD must not be set in production; use `npm run provision:admin`");
    if (e.ENFORCE_HTTPS === false) problems.push("ENFORCE_HTTPS cannot be disabled in production");
    if (e.TRUST_PROXY_HOPS < 1) problems.push("TRUST_PROXY_HOPS must be at least 1 in production (the app sits behind a TLS-terminating proxy)");
    if (/:\/\/[^@/]*(pos|postgres):(pos|postgres|password|changeme)@/i.test(e.DATABASE_URL)) {
      problems.push("DATABASE_URL uses a well-known default password");
    }
  }
  if (problems.length) throw new ConfigError(`Unsafe configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);

  return {
    env: e.NODE_ENV,
    isProd,
    isTest,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    corsOrigins: origins,
    sessionTtlHours: e.SESSION_TTL_HOURS,
    maxCashierDiscountPct: e.MAX_CASHIER_DISCOUNT_PCT,
    trustProxyHops: e.TRUST_PROXY_HOPS,
    enforceHttps: e.ENFORCE_HTTPS ?? isProd,
    jsonBodyLimit: e.JSON_BODY_LIMIT,
    logLevel: e.LOG_LEVEL ?? (isTest ? "silent" : isProd ? "info" : "debug"),
    // Brute-force protection stays tight in production; tests lift it unless they set it explicitly.
    loginRateLimitMax: e.LOGIN_RATE_LIMIT_MAX ?? (isTest ? 1000 : 20),
    sensitiveRateLimitMax: e.SENSITIVE_RATE_LIMIT_MAX ?? (isTest ? 100_000 : 60),
    apiRateLimitMax: e.API_RATE_LIMIT_MAX ?? (isTest ? 1_000_000 : 1200),
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;

// Fail fast: a bad production configuration must never reach the point of serving requests.
function loadOrExit(): AppConfig {
  try {
    return loadConfig(process.env);
  } catch (e) {
    if (e instanceof ConfigError && process.env.NODE_ENV === "production") {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}

export const config = loadOrExit();

// __Host- cookies are only accepted by browsers when Secure, Path=/ and without a Domain, which pins the session to this host.
export const SESSION_COOKIE = config.isProd ? "__Host-pos_session" : "pos_session";

export const sessionCookieOptions = (cfg: Pick<AppConfig, "isProd">, expires?: Date) => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: cfg.isProd,
  path: "/",
  ...(expires ? { expires } : {}),
});
