import { expect, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { OAUTH_PKCE_COOKIE, OAUTH_STATE_COOKIE, encodeOAuthState } from "../../shared/const";
import { APP_ORIGIN, urls } from "./ports";

export const TAMIL_DOC = "முருகன் கோவில் பழநியில் உள்ளது. The Murugan temple opens at 6am.\nவழிபாடு காலை ஆறு மணிக்கு தொடங்கும்.";
export const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

export type Identity = { sub: string; name: string; email: string };
export const newIdentity = (tag: string): Identity => {
  const id = `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return { sub: `e2e-${id}`, name: `User ${id}`, email: `${id}@example.test` };
};

const post = (url: string, body: unknown) => fetch(url, { method: "POST", body: JSON.stringify(body) });
export const setNextUser = (identity: Identity) => post(`${urls.oidc}/__control/next-user`, identity);
export const llm = {
  async reset() { await post(`${urls.local}/__reset`, {}); await post(`${urls.external}/__reset`, {}); },
  async mode(mode: "ok" | "insufficient" | "down") { await post(`${urls.local}/__control`, { mode }); },
  local: async () => (await fetch(`${urls.local}/__stats`)).json() as Promise<{ calls: number; last: { language: string; userMessage: string } | null }>,
  external: async () => (await fetch(`${urls.external}/__stats`)).json() as Promise<{ calls: number }>,
};

/** Real UI login through the fake OIDC provider (PKCE + nonce cookies, callback, session cookie). */
export async function login(page: Page, identity: Identity, returnTo = "/") {
  await setNextUser(identity);
  await page.goto(returnTo);
  await page.getByRole("button", { name: "Sign in securely" }).click();
  await expect(page.getByText("SECURE WORKSPACE", { exact: true })).toBeVisible();
}

export async function sessionCookie(context: BrowserContext) {
  const cookie = (await context.cookies()).find(c => c.name === "app_session_id");
  return cookie?.value;
}

type TrpcResult<T> = { status: number; data?: T; code?: string; message?: string };
async function unwrap<T>(response: Awaited<ReturnType<APIRequestContext["get"]>>): Promise<TrpcResult<T>> {
  const body = await response.json().catch(() => null);
  if (body?.result) return { status: response.status(), data: body.result.data?.json as T };
  return { status: response.status(), code: body?.error?.json?.data?.code, message: body?.error?.json?.message };
}
export const trpcQuery = async <T = any>(request: APIRequestContext, procedure: string, input?: unknown) =>
  unwrap<T>(await request.get(`/api/trpc/${procedure}${input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`}`));
export const trpcMutate = async <T = any>(request: APIRequestContext, procedure: string, input?: unknown) =>
  unwrap<T>(await request.post(`/api/trpc/${procedure}`, { data: { json: input ?? null }, headers: { "content-type": "application/json" } }));

export async function myWorkspaceId(request: APIRequestContext): Promise<number> {
  const list = await trpcQuery<Array<{ workspace: { id: number } }>>(request, "workspace.list");
  if (list.data?.[0]) return list.data[0].workspace.id;
  const ensured = await trpcMutate<{ id: number }>(request, "workspace.ensure");
  return ensured.data!.id;
}

export const uploadText = (request: APIRequestContext, workspaceId: number, filename: string, text: string) =>
  trpcMutate<{ documentId?: number; id?: number }>(request, "files.upload", { workspaceId, filename, mimeType: "text/plain", dataBase64: Buffer.from(text, "utf8").toString("base64") });

export async function ask(page: Page, text: string) {
  const box = page.locator("textarea");
  await box.fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

/**
 * Browser-less login through the fake OIDC provider: the same server-issued nonce, S256 PKCE, state and callback the UI uses,
 * driven over HTTP. The session cookie lands in `request`'s own cookie jar. Use for API-level journeys; use `login(page)` for UI checks.
 */
export async function apiLogin(request: APIRequestContext, identity: Identity, returnTo = "/") {
  await setNextUser(identity);
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const begin = await request.post(`${APP_ORIGIN}/api/oauth/begin`, { data: { challenge }, headers: { "content-type": "application/json" } });
  expect(begin.ok(), `oauth begin (${begin.status()})`).toBe(true);
  const { nonce } = (await begin.json()) as { nonce: string };
  const state = encodeOAuthState({ redirectUri: `${APP_ORIGIN}/api/oauth/callback`, nonce, challenge, returnTo });
  const authorize = new URL(urls.oidcAuthorize);
  authorize.search = new URLSearchParams({ response_type: "code", client_id: "sakthiai-e2e", redirect_uri: `${APP_ORIGIN}/api/oauth/callback`, scope: "openid profile email", state, code_challenge: challenge, code_challenge_method: "S256" }).toString();
  const granted = await request.get(authorize.toString(), { maxRedirects: 0 });
  expect(granted.status(), "oidc authorize").toBe(302);
  const callback = await request.get(granted.headers()["location"]!, { maxRedirects: 0, headers: { cookie: `${OAUTH_STATE_COOKIE}=${nonce}; ${OAUTH_PKCE_COOKIE}=${verifier}` } });
  expect(callback.status(), `oauth callback: ${await callback.text().catch(() => "")}`).toBe(302);
  const me = await trpcQuery<{ id: number } | null>(request, "auth.me");
  expect(me.data, "session established").toBeTruthy();
}
