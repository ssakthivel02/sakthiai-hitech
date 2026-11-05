import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { loadLivePreviewEnv, type LivePreviewAccount } from "./support/env";
import { realOidcLogin } from "./support/realLogin";

/**
 * Live-preview smoke with REAL Google OIDC and independently authenticated accounts.
 * No stub login, injected session, chat generation, embedding, or model-provider calls.
 *
 * Both dedicated accounts need separate existing workspaces. Account A also needs
 * one grounded artifact, provisioned through the approved app before dispatch.
 * This test only reads that artifact and fails clearly if the fixture is absent.
 */
const unwrap = async (response: Awaited<ReturnType<APIRequestContext["get"]>>) => {
  const body = await response.json().catch(() => null);
  if (body?.result) return { status: response.status(), data: body.result.data?.json };
  return { status: response.status(), code: body?.error?.json?.data?.code, message: body?.error?.json?.message };
};
const trpcQuery = async (request: APIRequestContext, procedure: string, input?: unknown) =>
  unwrap(await request.get("/api/trpc/" + procedure +
    (input === undefined ? "" : "?input=" + encodeURIComponent(JSON.stringify({ json: input })))));
const trpcMutate = async (request: APIRequestContext, procedure: string, input?: unknown) =>
  unwrap(await request.post("/api/trpc/" + procedure, {
    data: { json: input ?? null }, headers: { "content-type": "application/json" },
  }));

// Server isLowInformationQuery("the") returns true before any embedding lookup.
const NO_PROVIDER_QUERY = "the";

async function signIn(page: Page, account: LivePreviewAccount): Promise<number[]> {
  await realOidcLogin(page, account, "google");
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible({ timeout: 15_000 });
  const workspaces = await trpcQuery(page.request, "workspace.list");
  expect(workspaces.status, JSON.stringify(workspaces)).toBe(200);
  const ids = [...new Set(((workspaces.data as Array<{ workspace: { id: number } }> | undefined) ?? [])
    .map(item => item.workspace?.id).filter((id): id is number => typeof id === "number" && Number.isInteger(id) && id > 0))];
  if (!ids.length) {
    throw new Error("Dedicated test account has no workspace. Prepare it via the approved app; " +
      "this smoke intentionally does not call workspace.ensure.");
  }
  // The server does not guarantee ordering for workspace.list. Do not assume
  // the first workspace contains the positive grounded-artifact fixture.
  return ids;
}

async function signOut(page: Page): Promise<void> {
  await trpcMutate(page.request, "auth.logout");
  await page.reload();
  await expect(page.getByRole("button", { name: "Sign in securely" })).toBeVisible({ timeout: 10_000 });
}

test.describe("live preview — real OIDC and no-provider tenant isolation", () => {
  test("a dedicated real test account signs in and logout revokes its session", async ({ page }) => {
    const env = loadLivePreviewEnv();
    await signIn(page, env.accountA);
    const cookies = await page.context().cookies();
    const session = cookies.find(c => c.name === "app_session_id");
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe("Lax");
    await signOut(page);
    const afterLogout = await trpcQuery(page.request, "workspace.list");
    expect(afterLogout.status, "A revoked session must not authorize workspace access").not.toBe(200);
  });

  test("two real accounts cannot read A's seeded artifact, workspace or searches", async ({ browser }) => {
    const env = loadLivePreviewEnv();
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    try {
      const workspacesA = await signIn(pageA, env.accountA);
      const workspacesB = await signIn(pageB, env.accountB);
      const wsB = workspacesB[0];

      // Select a seeded fixture from A's *private* workspaces. workspace.list
      // has no ORDER BY; a fixed first-workspace assumption yields false failures.
      // All operations below are authenticated, scoped, bounded, and read-only.
      let fixture: { wsA: number; artifactId: number } | undefined;
      for (const wsA of workspacesA.slice(0, 20)) {
        if (workspacesB.includes(wsA)) continue; // shared workspace is not an isolation fixture
        const ownList = await trpcQuery(pageA.request, "artifacts.list", { workspaceId: wsA });
        expect(ownList.status, JSON.stringify(ownList)).toBe(200);
        const artifacts = ownList.data as Array<{ id: number }> | undefined;
        const artifactId = artifacts?.find(item => Number.isInteger(item.id) && item.id > 0)?.id;
        if (artifactId) { fixture = { wsA, artifactId }; break; }
      }
      if (!fixture) {
        throw new Error("Test account A has no grounded artifact in a workspace inaccessible to B. " +
          "Seed one through the approved app before this run; do not generate chat, fabricate citations or spend on a model.");
      }
      const { wsA, artifactId } = fixture;
      expect(workspacesB, "Account B must not belong to A's fixture workspace").not.toContain(wsA);
      const ownGet = await trpcQuery(pageA.request, "artifacts.get", { workspaceId: wsA, artifactId });
      expect(ownGet.status, JSON.stringify(ownGet)).toBe(200);
      const ownArtifact = ownGet.data as { id?: number; citations?: unknown[] } | undefined;
      expect(ownArtifact?.id).toBe(artifactId);
      expect(Array.isArray(ownArtifact?.citations), "Fixture must be a genuinely cited artifact").toBe(true);
      expect(ownArtifact?.citations?.length, "Grounded fixture must have at least one citation").toBeGreaterThan(0);

      // Positive authorized B list: neither a status error nor an accidentally empty search
      // can stand in for tenant isolation. No embeddings, model calls or writes.
      const ownBList = await trpcQuery(pageB.request, "artifacts.list", { workspaceId: wsB, limit: 200 });
      expect(ownBList.status, JSON.stringify(ownBList)).toBe(200);
      expect(((ownBList.data as Array<{ id: number }> | undefined) ?? []).map(item => item.id)).not.toContain(artifactId);

      const crossList = await trpcQuery(pageB.request, "artifacts.list", { workspaceId: wsA });
      expect(crossList.status, JSON.stringify(crossList)).toBe(403);
      expect(crossList.code, JSON.stringify(crossList)).toBe("FORBIDDEN");

      const crossGet = await trpcQuery(pageB.request, "artifacts.get", { workspaceId: wsA, artifactId });
      expect(crossGet.status, JSON.stringify(crossGet)).toBe(403);
      expect(crossGet.code, JSON.stringify(crossGet)).toBe("FORBIDDEN");

      // Membership denial occurs before the low-information search short-circuit.
      const crossSearch = await trpcQuery(pageB.request, "search.workspace", { workspaceId: wsA, query: NO_PROVIDER_QUERY });
      expect(crossSearch.status, JSON.stringify(crossSearch)).toBe(403);
      expect(crossSearch.code, JSON.stringify(crossSearch)).toBe("FORBIDDEN");

      const ownSearch = await trpcQuery(pageB.request, "search.workspace", { workspaceId: wsB, query: NO_PROVIDER_QUERY });
      expect(ownSearch.status, JSON.stringify(ownSearch)).toBe(200);
      expect((ownSearch.data as { lowInformation?: boolean } | undefined)?.lowInformation).toBe(true);
      expect(((ownSearch.data as { artifacts?: Array<{ id: number }> } | undefined)?.artifacts ?? []).map(a => a.id)).not.toContain(artifactId);
      test.info().annotations.push({
        type: "fixture-artifact-id", description: "Existing artifact id=" + artifactId + ", workspace=" + wsA,
      });
    } finally {
      await signOut(pageA).catch(() => {});
      await signOut(pageB).catch(() => {});
      await contextA.close();
      await contextB.close();
    }
  });
});
