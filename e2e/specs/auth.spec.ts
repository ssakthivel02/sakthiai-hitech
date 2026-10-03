import { expect, test } from "@playwright/test";
import { APP_ORIGIN, urls } from "../support/ports";
import { login, newIdentity, sessionCookie, setNextUser, trpcQuery } from "../support/helpers";

test.describe("authentication, safe return destination, revocation", () => {
  test("fake OIDC login (PKCE) establishes a session and the workspace loads", async ({ page, context }) => {
    const me = newIdentity("login");
    await login(page, me);
    // the identity block collapses to the avatar + log-out control on narrow viewports; log-out must stay reachable everywhere
    await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
    if (test.info().project.name === "desktop") await expect(page.getByText(me.name)).toBeVisible();
    const cookies = await context.cookies();
    const session = cookies.find(c => c.name === "app_session_id")!;
    expect(session.httpOnly).toBe(true);
    expect(session.sameSite).toBe("Lax");
    // single-use transaction cookies are cleared by the callback
    expect(cookies.some(c => c.name.includes("oauth_state") || c.name.includes("oauth_pkce"))).toBe(false);
  });

  const callback = async (page: import("@playwright/test").Page, returnTo: string | undefined, who = newIdentity("rt")) => {
    await page.goto("/");
    const { state, challenge, nonce, verifier } = await page.evaluate(async rt => {
      const b64u = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const nonce = crypto.randomUUID();
      const verifier = b64u(crypto.getRandomValues(new Uint8Array(32)));
      const challenge = b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
      document.cookie = `__Host-oauth_state=${nonce}; Path=/; Max-Age=600; SameSite=Lax; Secure`;
      document.cookie = `__Host-oauth_pkce=${verifier}; Path=/; Max-Age=600; SameSite=Lax; Secure`;
      const state = btoa(JSON.stringify({ redirectUri: `${location.origin}/api/oauth/callback`, nonce, challenge, ...(rt ? { returnTo: rt } : {}) }));
      return { state, challenge, nonce, verifier };
    }, returnTo);
    const { code } = await (await fetch(`${urls.oidc}/__control/code`, { method: "POST", body: JSON.stringify({ identity: who, challenge }) })).json();
    return { url: `/api/oauth/callback?code=${code}&state=${encodeURIComponent(state)}`, state, nonce, verifier, code };
  };

  test("a same-site relative returnTo is honoured", async ({ page }) => {
    const { url } = await callback(page, "/?landed=1");
    await page.goto(url);
    await expect(page).toHaveURL(`${APP_ORIGIN}/?landed=1`);
    await expect(page.getByText("SECURE WORKSPACE", { exact: true })).toBeVisible();
  });

  for (const hostile of ["https://evil.example.com/steal", "//evil.example.com/x", "/\\evil.example.com", "javascript:alert(1)", "/%2F%2Fevil.example.com", "http://localhost:9/other-origin"]) {
    test(`hostile returnTo ${JSON.stringify(hostile)} never leaves the app origin`, async ({ page }) => {
      const { url } = await callback(page, hostile);
      await page.goto(url);
      expect(new URL(page.url()).origin).toBe(APP_ORIGIN);
      await expect(page).toHaveURL(`${APP_ORIGIN}/`);
    });
  }

  test("a callback state cannot be replayed, and a mismatched nonce/PKCE verifier is rejected", async ({ page, request }) => {
    const first = await callback(page, undefined);
    await page.goto(first.url);
    await expect(page.getByText("SECURE WORKSPACE", { exact: true })).toBeVisible();
    // replay in a fresh browser context without the transaction cookies: rejected
    const replay = await request.get(first.url, { maxRedirects: 0 });
    expect(replay.status()).toBe(403);

    // tampered nonce in state (cookie holds the real one)
    const second = await callback(page, undefined);
    const tampered = JSON.parse(Buffer.from(second.state, "base64").toString("utf8"));
    tampered.nonce = "attacker-nonce";
    const bad = await page.request.get(`/api/oauth/callback?code=${second.code}&state=${encodeURIComponent(Buffer.from(JSON.stringify(tampered)).toString("base64"))}`, { maxRedirects: 0 });
    expect(bad.status()).toBe(403);
  });

  test("UI logout revokes the server-side session: the old cookie is dead even if replayed", async ({ page, context, browser }) => {
    const me = newIdentity("logout");
    await login(page, me);
    const token = (await sessionCookie(context))!;
    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page.getByRole("button", { name: "Sign in securely" })).toBeVisible();

    const other = await browser.newContext({ baseURL: APP_ORIGIN });
    await other.addCookies([{ name: "app_session_id", value: token, url: APP_ORIGIN, httpOnly: true, sameSite: "Lax" }]);
    const replayed = await trpcQuery(other.request, "auth.me");
    expect(replayed.status).toBe(200);
    expect(replayed.data ?? null).toBeNull(); // not authenticated
    expect((await other.request.post("/api/auth/revoke-all")).status()).toBe(401);
    await other.close();
  });

  test("a newer login for the same account revokes the older session", async ({ browser }) => {
    const me = newIdentity("twice");
    await setNextUser(me);
    const a = await browser.newContext({ baseURL: APP_ORIGIN });
    const pageA = await a.newPage();
    await login(pageA, me);
    expect((await trpcQuery(a.request, "auth.me")).data?.openId).toBe(me.sub);

    await new Promise(r => setTimeout(r, 1100)); // generation has one-second granularity
    const b = await browser.newContext({ baseURL: APP_ORIGIN });
    const pageB = await b.newPage();
    await login(pageB, me);
    expect((await trpcQuery(b.request, "auth.me")).data?.openId).toBe(me.sub);
    expect((await trpcQuery(a.request, "auth.me")).data ?? null).toBeNull();
    await a.close(); await b.close();
  });
});
