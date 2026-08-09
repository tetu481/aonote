import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  outputDir: "/tmp/aonote-playwright-results",
  use: {
    baseURL: "http://127.0.0.1:8765",
    channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL === "bundled" ? undefined : "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "../.venv/bin/uvicorn aonote.main:app --host 127.0.0.1 --port 8765",
    url: "http://127.0.0.1:8765/healthz",
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === "true",
    timeout: 30_000,
    env: {
      ...process.env,
      AONOTE_ENV: "development",
      AONOTE_DATABASE: "/tmp/aonote-playwright.sqlite3",
    },
  },
});
