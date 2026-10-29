import { defineConfig, devices } from "@playwright/test";
import { APP_ORIGIN } from "./e2e/support/ports";

export default defineConfig({
  testDir: "e2e/specs",
  globalSetup: "./e2e/global-setup.ts",
  // One shared stack with mutable fakes (LLM mode, next OIDC identity): tests are serial and each creates its own unique user.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  reporter: [["list"], ["json", { outputFile: "reports/e2e/playwright-report.json" }], ["html", { outputFolder: "reports/e2e/html", open: "never" }]],
  outputDir: "reports/e2e/artifacts",
  use: { baseURL: APP_ORIGIN, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    { name: "mobile", use: { ...devices["Pixel 5"] } },
  ],
});
