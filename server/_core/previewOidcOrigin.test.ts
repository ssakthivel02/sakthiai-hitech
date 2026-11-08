import { describe, expect, it } from "vitest";
import { realOidcLogin } from "../../e2e/live-preview/support/realLogin";
import type { Page } from "@playwright/test";

/** Exercise the real login driver using a deterministic fake page, never real accounts. */
function fakePage(redirectAfterEmail: string | null) {
  let currentUrl = "https://sakthiai-hitech-preview.onrender.com/";
  let nextCount = 0;
  const filled: Array<{ field: string; value: string }> = [];
  const page = {
    url: () => currentUrl,
    goto: async () => { currentUrl = "https://sakthiai-hitech-preview.onrender.com/"; },
    waitForURL: async (check: (url: URL) => boolean) => {
      if (!check(new URL(currentUrl))) throw new Error(`Unexpected page origin: ${new URL(currentUrl).origin}`);
    },
    locator: (field: string) => ({ fill: async (value: string) => { filled.push({ field, value }); } }),
    getByText: () => ({ isVisible: async () => false }),
    getByRole: (_role: string, options: { name: string | RegExp }) => ({
      click: async () => {
        if (typeof options.name === "string") currentUrl = "https://accounts.google.com/signin";
        else if (++nextCount === 1) currentUrl = redirectAfterEmail ?? "https://accounts.google.com/signin/v2/password";
        else currentUrl = "https://sakthiai-hitech-preview.onrender.com/";
      },
    }),
  };
  return { page: page as unknown as Page, filled };
}

describe("real OIDC login driver: credential-origin pinning", () => {
  const account = { email: "fixture@example.invalid", password: "TEST-PASSWORD-NEVER-SEND" };

  it("refuses a non-Google redirect after email without entering the password", async () => {
    const fixture = fakePage("https://attacker.invalid/steal-password");
    await expect(realOidcLogin(fixture.page, account, "google")).rejects.toThrow(/Refusing password credential entry/);
    expect(fixture.filled.map(f => f.field)).toEqual(['input[type="email"]']);
    expect(fixture.filled.some(f => f.value === account.password)).toBe(false);
  });

  it("rejects a lookalike Google subdomain after the email step", async () => {
    const fixture = fakePage("https://accounts.google.com.attacker.invalid/signin");
    await expect(realOidcLogin(fixture.page, account, "google")).rejects.toThrow(/Refusing password credential entry/);
    expect(fixture.filled.some(f => f.value === account.password)).toBe(false);
  });

  it("allows the expected Google email/password flow back to the pinned app origin", async () => {
    const fixture = fakePage(null);
    await expect(realOidcLogin(fixture.page, account, "google")).resolves.toBeUndefined();
    expect(fixture.filled.map(f => f.field)).toEqual(['input[type="email"]', 'input[type="password"]']);
  });
});
