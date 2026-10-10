import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

// The suite runs against the REAL stack: embedded PostgreSQL + Express API + Vite dev server. Nothing is mocked.
const API_PORT = 4100;
const WEB_PORT = 5273;
const PG_PORT = 54331;
const webOrigin = `http://localhost:${WEB_PORT}`;

export default defineConfig({
  testDir: "e2e",
  outputDir: "e2e-results",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: webOrigin,
    channel: process.env.E2E_BROWSER ?? "msedge",
    viewport: { width: 1366, height: 800 },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "npm --prefix ../api run local",
      url: `http://localhost:${API_PORT}/health`,
      timeout: 180_000,
      reuseExistingServer: false,
      env: {
        PORT: String(API_PORT),
        PG_PORT: String(PG_PORT),
        LOCAL_PG_FRESH: "1",
        LOCAL_PG_DIR: path.join(os.tmpdir(), "pos-e2e-pg"),
        CORS_ORIGIN: webOrigin,
        // The login rate limiter is relaxed under NODE_ENV=test; it has its own backend tests.
        NODE_ENV: "test",
      },
    },
    {
      command: "npm run dev",
      url: webOrigin,
      timeout: 120_000,
      reuseExistingServer: false,
      env: { VITE_PORT: String(WEB_PORT), VITE_API_TARGET: `http://localhost:${API_PORT}` },
    },
  ],
});
