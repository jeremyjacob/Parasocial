import { defineConfig } from "@playwright/test";

// E2E against the dev stack (`bun run dev`: Postgres + zero-cache in docker, app :5173,
// engine origin :5174, engine pool :5190). Passkeys use a CDP virtual authenticator.
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /.*\.spec\.ts/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  // the dev machine is shared; a retry separates load flakes (reported as "flaky") from failures
  retries: 1,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:5173", viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" },
  webServer: { command: "bun scripts/dev.ts", url: "http://localhost:5173/api/auth/session", reuseExistingServer: true, timeout: 180_000 },
});
