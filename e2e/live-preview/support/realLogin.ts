import type { Page } from "@playwright/test";
import type { LivePreviewAccount } from "./env";

/**
 * Drives the REAL "Sign in securely" button on the deployed app, the REAL external OIDC provider's own
 * hosted login page, and the REAL callback — exactly the path a human uses. No stub OIDC endpoint, no
 * `/api/oauth/begin` shortcut, no injected cookie or code. This is deliberately the only supported way
 * to authenticate in this suite.
 *
 * Known fragility (flagged, not worked around): most hosted identity providers run anti-automation
 * defenses (device/browser verification, step-up challenges, CAPTCHA) against default Chromium automation
 * that have nothing to do with whether the credentials are correct. If the provider blocks the attempt,
 * this throws with the provider's own wording rather than attempting to solve or bypass the challenge —
 * doing so would itself be exactly the kind of bypass this suite must not perform. Treat a block here as
 * an account/provider-configuration problem for the owner to resolve (a dedicated low-risk test identity,
 * or the provider's documented automation-testing accommodation), never as a reason to add a workaround.
 */
// The ONLY destination the departure redirect may land on for each provider — not "any origin different
// from the app", which would also accept an open-redirect bug in /api/oauth/begin or a misconfigured
// OIDC issuer URL, let googleHostedLogin() blindly type real credentials into whatever loaded there, and
// call that a successful sign-in. Add a new provider only with its own real, specific pattern here.
const PROVIDER_LOGIN_URL_PATTERNS: Record<string, RegExp> = {
  google: /^https:\/\/accounts\.google\.com\//,
};

export async function realOidcLogin(page: Page, account: LivePreviewAccount, providerName: string): Promise<void> {
  const loginUrlPattern = PROVIDER_LOGIN_URL_PATTERNS[providerName];
  if (!loginUrlPattern) {
    throw new Error(
      `No login driver implemented for OIDC provider "${providerName}". Add one deliberately — ` +
        "never fall back to a generic selector guess against an unknown provider's real login page.",
    );
  }

  await page.goto("/");
  // Captured ONCE, before any navigation away from the app. Both waits below check the live URL's
  // origin against this fixed value, never against a freshly re-read `page.url()` — re-reading it live
  // made the first wait a tautology (comparing the in-flight URL's origin to itself) and made the final
  // "back on the app" wait pass for ANY origin the moment navigation settled, not just the real app's.
  // Pinning to the origin captured here is also the actual redirect-destination security check: the
  // callback must land back on the exact origin we started from, not merely "some origin different
  // from whatever the URL happened to be a moment ago."
  const appOrigin = new URL(page.url()).origin;

  await page.getByRole("button", { name: "Sign in securely" }).click();
  // Must land specifically on the expected provider's own login page — not merely "somewhere else".
  await page.waitForURL(url => loginUrlPattern.test(url.href), { timeout: 20_000 });
  if (!loginUrlPattern.test(page.url())) {
    throw new Error(
      `Expected the OIDC redirect to land on the real ${providerName} login page (matching ` +
        `${loginUrlPattern}), but got ${page.url()} instead. Refusing to enter credentials anywhere else.`,
    );
  }

  switch (providerName) {
    case "google":
      await googleHostedLogin(page, account);
      break;
  }

  // Back on the app, authenticated: the callback has run and set the real session cookie. Validated
  // against the ORIGINAL app origin captured above, not the current in-flight URL.
  await page.waitForURL(url => url.origin === appOrigin, { timeout: 20_000 });
  if (new URL(page.url()).origin !== appOrigin) {
    throw new Error(
      `Post-login redirect landed on ${new URL(page.url()).origin}, not the original app origin ${appOrigin}. ` +
        "Refusing to treat this as a successful sign-in.",
    );
  }
}

async function googleHostedLogin(page: Page, account: LivePreviewAccount): Promise<void> {
  const blocked = page.getByText(/couldn.?t sign you in|this browser or app may not be secure/i);

  await page.locator('input[type="email"]').fill(account.email);
  await page.getByRole("button", { name: /next/i }).click();

  if (await blocked.isVisible({ timeout: 3_000 }).catch(() => false)) {
    throw new Error(
      "Google blocked this automated sign-in attempt before any password was sent " +
        "(device/browser verification). This is an account/provider accommodation gap, not a credential " +
        "problem — see realLogin.ts's header comment. Not retried, not worked around.",
    );
  }

  await page.locator('input[type="password"]').fill(account.password);
  await page.getByRole("button", { name: /next/i }).click();

  if (await blocked.isVisible({ timeout: 5_000 }).catch(() => false)) {
    throw new Error("Google blocked this automated sign-in attempt after the password step (step-up challenge). Not retried, not worked around.");
  }
}
