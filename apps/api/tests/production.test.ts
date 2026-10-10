import { Writable } from "node:stream";
import bcrypt from "bcryptjs";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { prisma } from "../src/db.js";
import { base, login, makeUser, PASSWORD } from "./helpers.js";

const GOOD_DB = "postgresql://pos_app:Xk9v-long-random-pw@db.internal:5432/pos";
const prodEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: "production",
  DATABASE_URL: GOOD_DB,
  CORS_ORIGIN: "https://pos.example.lk",
  ...extra,
});

describe("production configuration validation", () => {
  it("accepts a safe production configuration", () => {
    const cfg = loadConfig(prodEnv());
    expect(cfg.isProd).toBe(true);
    expect(cfg.corsOrigins).toEqual(["https://pos.example.lk"]);
    expect(cfg.enforceHttps).toBe(true);
  });

  it.each([
    ["missing database url", { DATABASE_URL: "" }, /DATABASE_URL/],
    ["wildcard CORS", { CORS_ORIGIN: "*" }, /CORS_ORIGIN/],
    ["http CORS", { CORS_ORIGIN: "http://pos.example.lk" }, /https/],
    ["localhost CORS", { CORS_ORIGIN: "https://localhost" }, /localhost/],
    ["CORS with path", { CORS_ORIGIN: "https://pos.example.lk/app" }, /bare origins/],
    ["demo seeding", { SEED_DEMO: "1" }, /SEED_DEMO/],
    ["demo users", { ENABLE_DEMO_USERS: "true" }, /ENABLE_DEMO_USERS/],
    ["demo password", { DEMO_PASSWORD: "Demo12345!" }, /DEMO_PASSWORD/],
    ["seed admin password", { SEED_ADMIN_PASSWORD: "x" }, /SEED_ADMIN_PASSWORD/],
    ["https enforcement off", { ENFORCE_HTTPS: "false" }, /ENFORCE_HTTPS/],
    ["no trusted proxy", { TRUST_PROXY_HOPS: "0" }, /TRUST_PROXY_HOPS/],
    ["default db password", { DATABASE_URL: "postgresql://pos:pos@db:5432/pos" }, /default password/],
    ["bad port", { PORT: "99999" }, /PORT/],
    ["bad body limit", { JSON_BODY_LIMIT: "huge" }, /size/],
  ])("refuses %s", (_name, extra, message) => {
    expect(() => loadConfig(prodEnv(extra))).toThrow(ConfigError);
    expect(() => loadConfig(prodEnv(extra))).toThrow(message);
  });

  it("does not leak secrets in configuration errors", () => {
    try {
      loadConfig(prodEnv({ SEED_ADMIN_PASSWORD: "SuperSecret-Value-1" }));
    } catch (e) {
      expect((e as Error).message).not.toContain("SuperSecret-Value-1");
    }
  });

  it("allows development conveniences outside production", () => {
    const cfg = loadConfig({ NODE_ENV: "development", DATABASE_URL: "postgresql://pos:pos@localhost:5432/pos", SEED_DEMO: "1" });
    expect(cfg.isProd).toBe(false);
  });
});

describe("session security (test mode)", () => {
  it("stores only a hash of the session token and invalidates it on logout", async () => {
    const { user } = await makeUser("sec_user", "CASHIER");
    const res = await request((await import("./helpers.js")).app).post(`${base}/auth/login`).send({ username: "sec_user", password: PASSWORD }).expect(200);
    const cookie = (res.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith("pos_session="))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(JSON.stringify(res.body)).not.toMatch(/token/i);
    const token = decodeURIComponent(cookie.split(";")[0].split("=")[1]);
    expect(await prisma.session.count({ where: { tokenHash: token } })).toBe(0);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBeGreaterThan(0);

    await request((await import("./helpers.js")).app).post(`${base}/auth/logout`).set("Cookie", `pos_session=${token}`).expect(200);
    const replay = await request((await import("./helpers.js")).app).get(`${base}/auth/me`).set("Cookie", `pos_session=${token}`);
    expect(replay.status).toBe(401);
  });

  it("rejects wrong passwords with a generic message and disabled users", async () => {
    await makeUser("sec_user2", "CASHIER");
    const { app } = await import("./helpers.js");
    const bad = await request(app).post(`${base}/auth/login`).send({ username: "sec_user2", password: "wrong-password" });
    const unknown = await request(app).post(`${base}/auth/login`).send({ username: "nobody_here", password: "wrong-password" });
    expect(bad.status).toBe(401);
    expect(bad.body).toEqual(unknown.body);
    await prisma.user.update({ where: { username: "sec_user2" }, data: { isActive: false } });
    await request(app).post(`${base}/auth/login`).send({ username: "sec_user2", password: PASSWORD }).expect(401);
  });
});

describe("production HTTP hardening", () => {
  const PROD_PW = "Prod-Role-Pw-91x7";
  let app: import("express").Express;
  let errorHandler: typeof import("../src/middleware/error.js").errorHandler;
  const xfp = { "x-forwarded-proto": "https" };
  const ORIGIN = "https://pos.example.lk";

  beforeAll(async () => {
    // A dedicated role, because production refuses the well-known test password.
    await prisma.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prod_sim') THEN CREATE ROLE prod_sim LOGIN SUPERUSER PASSWORD '${PROD_PW}'; END IF; END $$`);
    const url = new URL(process.env.DATABASE_URL!);
    url.username = "prod_sim";
    url.password = PROD_PW;
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", url.toString());
    vi.stubEnv("CORS_ORIGIN", ORIGIN);
    vi.stubEnv("LOGIN_RATE_LIMIT_MAX", "4");
    vi.stubEnv("LOG_LEVEL", "silent");
    vi.stubEnv("TRUST_PROXY_HOPS", "1");
    app = (await import("../src/app.js")).createApp();
    errorHandler = (await import("../src/middleware/error.js")).errorHandler;
    await prisma.user.create({ data: { username: "prod_cashier", fullName: "Prod Cashier", role: "CASHIER", passwordHash: await bcrypt.hash(PASSWORD, 4) } });
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("serves liveness and readiness without HTTPS", async () => {
    await request(app).get("/health").expect(200);
    const ready = await request(app).get("/ready").expect(200);
    expect(ready.body.status).toBe("ready");
  });

  it("refuses plain-HTTP API traffic", async () => {
    const res = await request(app).get(`${base}/auth/me`);
    expect(res.status).toBe(426);
  });

  it("sets security headers and never advertises Express", async () => {
    const res = await request(app).get(`${base}/auth/me`).set(xfp);
    expect(res.status).toBe(401);
    expect(res.headers["strict-transport-security"]).toMatch(/max-age=\d+/);
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("issues a __Host- session cookie that is Secure, HttpOnly and SameSite", async () => {
    const res = await request(app).post(`${base}/auth/login`).set(xfp).send({ username: "prod_cashier", password: PASSWORD });
    expect(res.status).toBe(200);
    const cookie = (res.headers["set-cookie"] as unknown as string[])[0];
    expect(cookie).toMatch(/^__Host-pos_session=/);
    expect(cookie).toMatch(/; Secure/i);
    expect(cookie).toMatch(/; HttpOnly/i);
    expect(cookie).toMatch(/; SameSite=Lax/i);
    expect(cookie).toMatch(/; Path=\//i);
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it("allows only the configured CORS origin", async () => {
    const ok = await request(app).get(`${base}/auth/me`).set(xfp).set("Origin", ORIGIN);
    expect(ok.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(ok.headers["access-control-allow-credentials"]).toBe("true");
    const bad = await request(app).get(`${base}/auth/me`).set(xfp).set("Origin", "https://evil.example");
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
    expect(bad.status).toBe(403);
    expect(JSON.stringify(bad.body)).not.toContain(ORIGIN);
  });

  it("limits request body size", async () => {
    const res = await request(app).post(`${base}/auth/login`).set(xfp).send({ username: "x", password: "y".repeat(400_000) });
    expect(res.status).toBe(413);
  });

  it("rate limits repeated login attempts", async () => {
    const attempt = () => request(app).post(`${base}/auth/login`).set(xfp).set("X-Forwarded-For", "203.0.113.9").send({ username: "prod_cashier", password: "wrong-wrong-1" });
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await attempt()).status);
    expect(codes.slice(0, 2)).toEqual([401, 401]);
    expect(codes).toContain(429);
  });

  it("returns safe 500s without stack traces or internals", () => {
    let status = 0;
    let body: unknown;
    const res = { status: (s: number) => ((status = s), res), json: (b: unknown) => ((body = b), res), headersSent: false, setHeader: () => res } as never;
    errorHandler(new Error("connect ECONNREFUSED postgresql://pos_app:TopSecret@db:5432/pos"), { id: "req-1", method: "GET", originalUrl: "/x" } as never, res, () => undefined);
    expect(status).toBe(500);
    const text = JSON.stringify(body);
    expect(text).not.toContain("TopSecret");
    expect(text).not.toContain("ECONNREFUSED");
    expect(text).not.toContain("stack");
    expect(text).toContain("req-1");
  });

  it("redacts secrets and personal data from logs", async () => {
    vi.stubEnv("LOG_LEVEL", "info");
    const { createLogger } = await import("../src/logger.js");
    const lines: string[] = [];
    const sink = new Writable({ write(chunk, _e, cb) { lines.push(chunk.toString()); cb(); } });
    const log = createLogger("info", sink);
    log.info({ password: "hunter2-secret", user: { email: "a@b.lk", phone: "0771234567" }, req: { headers: { cookie: "__Host-pos_session=abc", authorization: "Bearer zzz" } }, customerName: "Nimal" }, "login");
    log.error({ err: new Error("failed postgresql://u:DbPassw0rd@h/db with Bearer tok123") }, "boom");
    const out = lines.join("");
    for (const secret of ["hunter2-secret", "a@b.lk", "0771234567", "abc", "zzz", "Nimal", "DbPassw0rd", "tok123"]) expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED]");
  });

  it("ignores unauthenticated access to protected routes", async () => {
    const agent = await login("admin", "TestPass123!").catch(() => null);
    expect(agent).not.toBeNull();
    await request(app).get(`${base}/users`).set(xfp).expect(401);
  });
});
