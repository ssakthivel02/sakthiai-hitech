import { defineConfig, devices } from "@playwright/test";

// Deliberately separate from playwright.config.ts: that one always boots its own disposable local
// stack (e2e/global-setup.ts) and must never be pointed at a real deployment. This config has NO
// globalSetup and talks only to a real, already-running PREVIEW_URL with real, dedicated test
// accounts (e2e/live-preview/support/env.ts) — never a stub identity, never a local server.
//
// PREVIEW_URL is restricted to the one approved Render preview, the same way preview-db-setup.yml
// hard-codes its Aiven host/db-name allowlist and preview-http-smoke.yml requires an HTTPS preview_url:
// this suite drives real sign-in against a real third-party identity provider with real test-account
// credentials, so it must never be pointable at an arbitrary or attacker-supplied host.
const APPROVED_PREVIEW_HOSTNAME = "sakthiai-hitech-preview.onrender.com";

const previewUrl = process.env.PREVIEW_URL;
if (!previewUrl) {
  throw new Error("PREVIEW_URL is required: this config targets a real, already-deployed preview, not a local stack.");
}

const parsedPreviewUrl = (() => {
  try {
    return new URL(previewUrl);
  } catch {
    throw new Error(`PREVIEW_URL "${previewUrl}" is not a valid URL.`);
  }
})();

if (parsedPreviewUrl.protocol !== "https:") {
  throw new Error(`PREVIEW_URL must be HTTPS. Got "${parsedPreviewUrl.protocol}" for "${previewUrl}".`);
}

if (parsedPreviewUrl.hostname !== APPROVED_PREVIEW_HOSTNAME) {
  throw new Error(
    `PREVIEW_URL's hostname "${parsedPreviewUrl.hostname}" is not the approved preview host ` +
      `"${APPROVED_PREVIEW_HOSTNAME}". Refusing to run real sign-in against an unapproved host.`,
  );
}

export default defineConfig({
  testDir: "e2e/live-preview",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  forbidOnly: !!process.env.CI,
  reporter: [["list"], ["json", { outputFile: "reports/live-preview/playwright-report.json" }]],
  outputDir: "reports/live-preview/artifacts",
  // trace/screenshot are deliberately OFF, unlike playwright.config.ts's defaults, and must stay off here.
  // This suite types real account credentials via realLogin.ts's page.locator(...).fill(account.email /
  // account.password). Playwright's trace format records the literal arguments passed to fill() in its
  // action call log, so a retained trace would embed the real test-account password in plain text inside
  // an artifact this workflow uploads via actions/upload-artifact (reports/live-preview/**) — a secret
  // leak into CI, not a debugging convenience. Screenshots cannot show the typed values directly (the
  // password field renders masked), but the email field would still render in clear text on a
  // failure-time screenshot, and PREVIEW_TEST_ACCOUNT_*_EMAIL is itself a protected secret, so screenshots
  // stay off too. Diagnosability instead comes from the thrown error messages and test.info().annotations
  // this suite already attaches on every failure path.
  use: { baseURL: previewUrl, trace: "off", screenshot: "off" },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } }],
});
