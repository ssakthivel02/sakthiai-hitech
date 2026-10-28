import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { loadLivePreviewEnv, type LivePreviewAccount } from "./support/env";
import { realOidcLogin } from "./support/realLogin";

/**
 * Minimal live-preview browser check: REAL authentication only (the actual "Sign in securely" button,
 * the actual external OIDC provider's own login page, the actual callback — see realLogin.ts), against
 * the deployed Render preview named by PREVIEW_URL. No stub OIDC endpoint, no injected session, no
 * internal shortcut. Dispatch-gated and pinned to EXPECTED_COMMIT (checked in the companion workflow's
 * bind job, mirroring preview-db-setup.yml) so this never runs against the wrong deployment.
 *
 * Deliberately small: one real login, one cross-account workspace-isolation negative case, one
 * artifacts + search round trip. This is a smoke check for the live deployment, not a replacement for
 * the full local/CI suite (which already covers every case in depth against a disposable stack).
 */

const unwrap = async (response: Awaited<ReturnType<APIRequestContext["get"]>>) => {
  const body = await response.json().catch(() => null);
  if (body?.result) return { status: response.status(), data: body.result.data?.json };
  return { status: response.status(), code: body?.error?.json?.data?.code, message: body?.error?.json?.message };
};
const trpcQuery = async (request: APIRequestContext, procedure: string, input?: unknown) =>
  unwrap(await request.get(`/api/trpc/${procedure}${input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`}`));
const trpcMutate = async (request: APIRequestContext, procedure: string, input?: unknown) =>
  unwrap(await request.post(`/api/trpc/${procedure}`, { data: { json: input ?? null }, headers: { "content-type": "application/json" } }));

async function signIn(page: Page, account: LivePreviewAccount, providerName: string): Promise<number> {
  await realOidcLogin(page, account, providerName);
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible({ timeout: 15_000 });
  const workspaces = await trpcQuery(page.request, "workspace.list");
  const existing = (workspaces.data as Array<{ workspace: { id: number } }> | undefined)?.[0];
  if (existing) return existing.workspace.id;
  const ensured = await trpcMutate(page.request, "workspace.ensure");
  return (ensured.data as { id: number }).id;
}

async function signOut(page: Page): Promise<void> {
  await trpcMutate(page.request, "auth.logout");
  await page.reload();
  await expect(page.getByRole("button", { name: "Sign in securely" })).toBeVisible({ timeout: 10_000 });
}

test.describe("live preview — real authentication, workspace isolation, artifacts + search", () => {
  test("a dedicated real test account can sign in, and session revocation on logout actually takes effect", async ({ page }) => {
    const env = loadLivePreviewEnv();
    await signIn(page, env.accountA, "google");

    const cookies = await page.context().cookies();
    const session = cookies.find(c => c.name === "app_session_id");
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe("Lax");

    await signOut(page);
    const afterLogout = await trpcQuery(page.request, "workspace.list");
    expect(afterLogout.status, "a revoked session must not still authorize API calls").not.toBe(200);
  });

  test("two real, separately-authenticated accounts never see each other's workspace, artifacts or search results", async ({ browser }) => {
    const env = loadLivePreviewEnv();
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    // Note on "dedicated test workspace": the app exposes no workspace.create (server/routers.ts only has
    // workspace.list/ensure — one workspace per account, no on-demand fresh workspace per run). So each
    // dedicated test account's own ensure()d workspace IS its dedicated test workspace; there is no API to
    // mint a disposable one instead. The marker below is still unique per run so retained data (if cleanup
    // below ever fails) is always identifiable and attributable to one specific run.
    const marker = `live-preview-check ${Date.now()}`;
    let artifactId: number | undefined;
    let wsA: number | undefined;
    // Set only once every assertion in the try block has passed. Read in the finally block below to
    // decide whether a cleanup failure may throw: throwing from `finally` after the try block already
    // threw would REPLACE that original assertion error, hiding the real failure behind a cleanup
    // message. So a cleanup failure throws (and fails the test) only when nothing already failed; when
    // an assertion above already failed, cleanup failure is still fully reported (see below) but the
    // original assertion error is left to propagate on its own.
    let assertionsPassed = false;

    try {
      wsA = await signIn(pageA, env.accountA, "google");
      const wsB = await signIn(pageB, env.accountB, "google");
      expect(wsA, "the two dedicated test accounts must land in distinct workspaces for this check to be meaningful").not.toBe(wsB);

      const sent = await trpcMutate(pageA.request, "chat.send", { workspaceId: wsA, message: marker, language: "en" });
      expect(sent.status, JSON.stringify(sent)).toBe(200);
      const conversationId = (sent.data as any).conversationId;
      const assistantMessageId = (sent.data as any).assistantMessageId;

      // No supported API deletes a conversation or message (see support/env.ts's header comment — the
      // chat router exposes only history/send/sendAsync, and artifacts.delete removes only the artifact
      // row, never its source chat). This conversation is therefore permanently retained on the live
      // preview. Retention for this run was already required to be explicitly accepted before this file
      // could even load (PREVIEW_TEST_ACKNOWLEDGE_CHAT_RETENTION) — this still logs and attaches the exact
      // retained identifiers, unconditionally and regardless of what happens below, so what was retained
      // stays traceable rather than merely "accepted in the abstract".
      const chatRetentionMessage =
        `[live-preview cleanup] RETAINED chat conversation id=${conversationId}, assistant message ` +
        `id=${assistantMessageId}, workspace=${wsA} (marker: "${marker}"). No supported API exists to ` +
        "delete a conversation or message, so this data remains on the live preview by design; its " +
        "retention for this run was accepted in advance via PREVIEW_TEST_ACKNOWLEDGE_CHAT_RETENTION.";
      console.warn(chatRetentionMessage);
      test.info().annotations.push({ type: "retained-test-data", description: chatRetentionMessage });

      const saved = await trpcMutate(pageA.request, "artifacts.saveFromMessage", {
        workspaceId: wsA,
        conversationId,
        messageId: assistantMessageId,
      });
      expect(saved.status, JSON.stringify(saved)).toBe(200);
      artifactId = (saved.data as any).artifact.id;

      // Account A can see its own artifact.
      const ownList = await trpcQuery(pageA.request, "artifacts.list", { workspaceId: wsA });
      expect((ownList.data as any[])?.map(a => a.id)).toContain(artifactId);

      // Account B must never see it. Each check below asserts the SPECIFIC expected authorization
      // outcome (status + tRPC error code, or a successful-but-empty result) rather than treating "the
      // artifact id is absent" alone as success — that alone would also be satisfied by an unrelated
      // failure (a typo'd procedure name, a 500, a dropped connection), which would make the negative
      // test pass for the wrong reason and hide a real authorization regression.

      // B has no membership in A's workspace, so reading it at all must be denied with FORBIDDEN (403),
      // not merely "fail to return the artifact" for some other reason.
      const crossList = await trpcQuery(pageB.request, "artifacts.list", { workspaceId: wsA });
      expect(crossList.status, JSON.stringify(crossList)).toBe(403);
      expect(crossList.code, JSON.stringify(crossList)).toBe("FORBIDDEN");

      const crossGet = await trpcQuery(pageB.request, "artifacts.get", { workspaceId: wsA, artifactId });
      expect(crossGet.status, JSON.stringify(crossGet)).toBe(403);
      expect(crossGet.code, JSON.stringify(crossGet)).toBe("FORBIDDEN");

      // Same denial when B searches A's workspace directly (a second, independent cross-tenant check,
      // not a restatement of the one above: search has its own authorization check in the router).
      const crossWorkspaceSearch = await trpcQuery(pageB.request, "search.workspace", { workspaceId: wsA, query: marker });
      expect(crossWorkspaceSearch.status, JSON.stringify(crossWorkspaceSearch)).toBe(403);
      expect(crossWorkspaceSearch.code, JSON.stringify(crossWorkspaceSearch)).toBe("FORBIDDEN");

      // Searching B's OWN workspace is a different case: it must succeed (200) — B is a legitimate member
      // of wsB — and the cross-tenant guarantee here is that A's artifact never appears in B's own,
      // correctly-scoped results, not that the call fails.
      const ownWorkspaceSearch = await trpcQuery(pageB.request, "search.workspace", { workspaceId: wsB, query: marker });
      expect(ownWorkspaceSearch.status, JSON.stringify(ownWorkspaceSearch)).toBe(200);
      expect((ownWorkspaceSearch.data as any)?.artifacts?.map((a: any) => a.id) ?? []).not.toContain(artifactId);

      assertionsPassed = true;
    } finally {
      // Clean up the test artifact this run created, regardless of whether the assertions above passed.
      // A cleanup failure is NEVER silent: it is always logged and attached to the test report, naming
      // the exact retained artifact so owner authorization can be sought to remove it by hand. Whether it
      // also fails the test depends on assertionsPassed (see the comment above where it's declared).
      if (artifactId !== undefined && wsA !== undefined) {
        const deleted = await trpcMutate(pageA.request, "artifacts.delete", { workspaceId: wsA, artifactId }).catch(
          (error: unknown) => ({ status: -1, message: error instanceof Error ? error.message : String(error) }),
        );
        if (deleted.status !== 200) {
          const retainedDataMessage =
            `[live-preview cleanup] FAILED to delete test artifact id=${artifactId} in workspace=${wsA} ` +
            `(marker: "${marker}"). Response: ${JSON.stringify(deleted)}. ` +
            "This test data was NOT removed from the live preview. Owner authorization and manual " +
            "cleanup (or explicit sign-off to leave it) is required before this account/workspace is reused.";
          console.error(retainedDataMessage);
          test.info().annotations.push({ type: "retained-test-data", description: retainedDataMessage });
          if (assertionsPassed) {
            // Nothing else is failing this test — a silently-retained artifact must not pass as green.
            throw new Error(retainedDataMessage);
          }
          // An assertion above already failed: that original error is what must surface, so this
          // function returns normally here and lets it propagate, instead of throwing a second error
          // that would replace it. The retained-data report above has already been logged and attached.
        }
      }

      await signOut(pageA).catch(() => {});
      await signOut(pageB).catch(() => {});
      await contextA.close();
      await contextB.close();
    }
  });
});
