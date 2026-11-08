import { expect, request as playwrightRequest, test, type APIRequestContext } from "@playwright/test";
import { APP_ORIGIN } from "../support/ports";
import { TAMIL_DOC, apiLogin, llm, myWorkspaceId, newIdentity, trpcMutate, trpcQuery, uploadText } from "../support/helpers";

// API-level journey against the REAL built server (no browser): save a grounded answer -> persist -> search -> reopen, plus isolation.
test.beforeEach(async () => { await llm.reset(); });

async function signedIn(tag: string): Promise<{ request: APIRequestContext; ws: number }> {
  const request = await playwrightRequest.newContext({ baseURL: APP_ORIGIN });
  await apiLogin(request, newIdentity(tag));
  return { request, ws: await myWorkspaceId(request) };
}

test.describe("persistent artifacts and workspace search", () => {
  test("grounded answer -> saved artifact (idempotent) -> found by search -> reopened with its evidence", async () => {
    const { request, ws } = await signedIn("artifact-journey");
    expect((await uploadText(request, ws, "temple.txt", TAMIL_DOC)).status).toBe(200);

    const answer = await trpcMutate<any>(request, "chat.send", { workspaceId: ws, message: "When does the Murugan temple open?", language: "en" });
    expect(answer.data.grounding).toBe("GROUNDED_EVIDENCE");
    expect(answer.data.assistantMessageId).toBeGreaterThan(0);

    const input = { workspaceId: ws, conversationId: answer.data.conversationId, messageId: answer.data.assistantMessageId };
    const saved = await trpcMutate<any>(request, "artifacts.saveFromMessage", input);
    expect(saved.status, JSON.stringify(saved)).toBe(200);
    expect(saved.data.created).toBe(true);
    const again = await trpcMutate<any>(request, "artifacts.saveFromMessage", input);
    expect(again.data.created).toBe(false);
    expect(again.data.artifact.id).toBe(saved.data.artifact.id);

    const found = await trpcQuery<any>(request, "search.workspace", { workspaceId: ws, query: "Murugan temple" });
    expect(found.status).toBe(200);
    expect(found.data.artifacts.map((a: any) => a.id)).toEqual([saved.data.artifact.id]);
    expect(found.data.documents.map((d: any) => d.filename)).toContain("temple.txt");

    const reopened = await trpcQuery<any>(request, "artifacts.get", { workspaceId: ws, artifactId: saved.data.artifact.id });
    expect(reopened.data.content).toContain("[local] Per the sources the temple opens at 6am");
    expect(JSON.stringify(reopened.data.citations)).toContain("temple.txt");
    const listed = await trpcQuery<any[]>(request, "artifacts.list", { workspaceId: ws });
    expect(listed.data?.map(a => a.id)).toEqual([saved.data.artifact.id]);

    // the SPA route serves from the built server
    const page = await request.get(`/artifacts/${saved.data.artifact.id}`);
    expect(page.status()).toBe(200);
    expect(page.headers()["content-type"]).toContain("text/html");
    expect((await llm.external()).calls, "external provider must never be contacted").toBe(0);
    await request.dispose();
  });

  test("lifecycle on the built server: rename is searchable, move between projects, delete removes it; other tenants cannot touch it", async () => {
    const alice = await signedIn("artifact-lifecycle"); const bob = await signedIn("artifact-lifecycle-bob");
    expect((await uploadText(alice.request, alice.ws, "temple.txt", TAMIL_DOC)).status).toBe(200);
    const project = await trpcMutate<any>(alice.request, "projects.create", { workspaceId: alice.ws, name: "Lifecycle project" });
    const projectId = (await trpcQuery<any[]>(alice.request, "projects.list", { workspaceId: alice.ws })).data!.find(p => p.name === "Lifecycle project")!.id;
    expect(project.status).toBe(200);

    const answer = await trpcMutate<any>(alice.request, "chat.send", { workspaceId: alice.ws, message: "When does the Murugan temple open?", language: "en" });
    const saved = await trpcMutate<any>(alice.request, "artifacts.saveFromMessage", { workspaceId: alice.ws, conversationId: answer.data.conversationId, messageId: answer.data.assistantMessageId });
    const id = saved.data.artifact.id;

    const renamed = await trpcMutate<any>(alice.request, "artifacts.update", { workspaceId: alice.ws, artifactId: id, title: "Quokkaterminal opening hours", projectId });
    expect(renamed.status, JSON.stringify(renamed)).toBe(200);
    expect(renamed.data).toMatchObject({ title: "Quokkaterminal opening hours", projectId });
    const byTitle = await trpcQuery<any>(alice.request, "search.workspace", { workspaceId: alice.ws, query: "quokkaterminal" });
    expect(byTitle.data.artifacts.map((a: any) => a.id)).toEqual([id]);
    expect((await trpcQuery<any[]>(alice.request, "artifacts.list", { workspaceId: alice.ws, projectId })).data!.map(a => a.id)).toEqual([id]);

    expect((await trpcMutate(bob.request, "artifacts.update", { workspaceId: alice.ws, artifactId: id, title: "pwned" })).code).toBe("FORBIDDEN");
    expect((await trpcMutate(bob.request, "artifacts.delete", { workspaceId: bob.ws, artifactId: id })).code).toBe("NOT_FOUND");
    expect((await trpcMutate(alice.request, "artifacts.update", { workspaceId: alice.ws, artifactId: id })).status).toBe(400);

    expect((await trpcMutate<any>(alice.request, "artifacts.delete", { workspaceId: alice.ws, artifactId: id })).data).toEqual({ deleted: true });
    expect((await trpcQuery(alice.request, "artifacts.get", { workspaceId: alice.ws, artifactId: id })).code).toBe("NOT_FOUND");
    expect(((await trpcQuery<any>(alice.request, "search.workspace", { workspaceId: alice.ws, query: "quokkaterminal" })).data.artifacts)).toEqual([]);
    expect((await trpcMutate(alice.request, "artifacts.delete", { workspaceId: alice.ws, artifactId: id })).code).toBe("NOT_FOUND");
    await alice.request.dispose(); await bob.request.dispose();
  });

  test("file links on the built server: link an existing file by id (nothing copied), other tenants cannot link or see it, unlink, delete clears links", async () => {
    const alice = await signedIn("artifact-links"); const bob = await signedIn("artifact-links-bob");
    expect((await uploadText(alice.request, alice.ws, "temple.txt", TAMIL_DOC)).status).toBe(200);
    expect((await uploadText(bob.request, bob.ws, "bob-private.txt", "Bob private notes about the Murugan temple")).status).toBe(200);
    const aliceFile = (await trpcQuery<any[]>(alice.request, "files.list", { workspaceId: alice.ws })).data!.find(f => f.filename === "temple.txt")!.id;
    const bobFile = (await trpcQuery<any[]>(bob.request, "files.list", { workspaceId: bob.ws })).data!.find(f => f.filename === "bob-private.txt")!.id;

    const answer = await trpcMutate<any>(alice.request, "chat.send", { workspaceId: alice.ws, message: "When does the Murugan temple open?", language: "en" });
    const id = (await trpcMutate<any>(alice.request, "artifacts.saveFromMessage", { workspaceId: alice.ws, conversationId: answer.data.conversationId, messageId: answer.data.assistantMessageId })).data.artifact.id;

    const linked = await trpcMutate<any>(alice.request, "artifacts.attachFile", { workspaceId: alice.ws, artifactId: id, documentId: aliceFile });
    expect(linked.status, JSON.stringify(linked)).toBe(200);
    expect(linked.data).toMatchObject({ created: true, reference: { documentId: aliceFile, status: "available", filename: "temple.txt" } });
    expect(JSON.stringify(linked.data)).not.toMatch(/extractedText|storageKey/);
    expect((await trpcMutate(alice.request, "artifacts.attachFile", { workspaceId: alice.ws, artifactId: id, documentId: bobFile })).code).toBe("NOT_FOUND");
    expect((await trpcMutate(bob.request, "artifacts.attachFile", { workspaceId: alice.ws, artifactId: id, documentId: bobFile })).code).toBe("FORBIDDEN");
    expect((await trpcQuery(bob.request, "artifacts.get", { workspaceId: alice.ws, artifactId: id })).code).toBe("FORBIDDEN");

    const opened = await trpcQuery<any>(alice.request, "artifacts.get", { workspaceId: alice.ws, artifactId: id });
    expect(opened.data.fileReferences.map((r: any) => [r.documentId, r.status])).toEqual([[aliceFile, "available"]]);
    expect((await trpcMutate<any>(alice.request, "artifacts.detachFile", { workspaceId: alice.ws, artifactId: id, documentId: aliceFile })).data).toEqual({ detached: true });
    expect((await trpcQuery<any>(alice.request, "artifacts.get", { workspaceId: alice.ws, artifactId: id })).data.fileReferences).toEqual([]);

    expect((await trpcMutate<any>(alice.request, "artifacts.attachFile", { workspaceId: alice.ws, artifactId: id, documentId: aliceFile })).status).toBe(200);
    expect((await trpcMutate<any>(alice.request, "artifacts.delete", { workspaceId: alice.ws, artifactId: id })).data).toEqual({ deleted: true });
    expect((await trpcQuery<any[]>(alice.request, "files.list", { workspaceId: alice.ws })).data!.map(f => f.id)).toContain(aliceFile);
    await alice.request.dispose(); await bob.request.dispose();
  });

  test("answers without evidence, or with the model unavailable, cannot be saved", async () => {
    const { request, ws } = await signedIn("artifact-refusals");
    expect((await uploadText(request, ws, "temple.txt", TAMIL_DOC)).status).toBe(200);

    const none = await trpcMutate<any>(request, "chat.send", { workspaceId: ws, message: "zebrafish launch quarterly", language: "en" });
    expect(none.data.grounding).toBe("INSUFFICIENT_EVIDENCE");
    const refusedNone = await trpcMutate(request, "artifacts.saveFromMessage", { workspaceId: ws, conversationId: none.data.conversationId, messageId: none.data.assistantMessageId });
    expect(refusedNone.code).toBe("PRECONDITION_FAILED");

    await llm.mode("down");
    const down = await trpcMutate<any>(request, "chat.send", { workspaceId: ws, message: "When does the Murugan temple open?", language: "en" });
    expect(down.data.grounding).toBe("MODEL_UNAVAILABLE");
    const refusedDown = await trpcMutate(request, "artifacts.saveFromMessage", { workspaceId: ws, conversationId: down.data.conversationId, messageId: down.data.assistantMessageId });
    expect(refusedDown.code).toBe("PRECONDITION_FAILED");

    expect(((await trpcQuery<any[]>(request, "artifacts.list", { workspaceId: ws })).data ?? []).length).toBe(0);
    await request.dispose();
  });

  test("another tenant can neither read, list, search nor forge-save someone else's artifact", async () => {
    const alice = await signedIn("artifact-alice"); const bob = await signedIn("artifact-bob");
    expect(alice.ws).not.toBe(bob.ws);
    expect((await uploadText(alice.request, alice.ws, "temple.txt", TAMIL_DOC)).status).toBe(200);
    const answer = await trpcMutate<any>(alice.request, "chat.send", { workspaceId: alice.ws, message: "When does the Murugan temple open?", language: "en" });
    const saved = await trpcMutate<any>(alice.request, "artifacts.saveFromMessage", { workspaceId: alice.ws, conversationId: answer.data.conversationId, messageId: answer.data.assistantMessageId });
    const id = saved.data.artifact.id;

    expect((await trpcQuery(bob.request, "artifacts.get", { workspaceId: alice.ws, artifactId: id })).code).toBe("FORBIDDEN");
    expect((await trpcQuery(bob.request, "artifacts.list", { workspaceId: alice.ws })).code).toBe("FORBIDDEN");
    expect((await trpcQuery(bob.request, "search.workspace", { workspaceId: alice.ws, query: "Murugan" })).code).toBe("FORBIDDEN");
    expect((await trpcMutate(bob.request, "artifacts.saveFromMessage", { workspaceId: alice.ws, conversationId: answer.data.conversationId, messageId: answer.data.assistantMessageId })).code).toBe("FORBIDDEN");

    // own workspace: a foreign id is indistinguishable from a missing one; search finds nothing; forged save is refused
    expect((await trpcQuery(bob.request, "artifacts.get", { workspaceId: bob.ws, artifactId: id })).code).toBe("NOT_FOUND");
    const empty = await trpcQuery<any>(bob.request, "search.workspace", { workspaceId: bob.ws, query: "Murugan temple" });
    expect(empty.data.artifacts).toEqual([]); expect(empty.data.documents).toEqual([]);
    expect((await trpcMutate(bob.request, "artifacts.saveFromMessage", { workspaceId: bob.ws, conversationId: answer.data.conversationId, messageId: answer.data.assistantMessageId })).code).toBe("FORBIDDEN");
    expect(((await trpcQuery<any[]>(bob.request, "artifacts.list", { workspaceId: bob.ws })).data ?? []).length).toBe(0);
    await alice.request.dispose(); await bob.request.dispose();
  });

  test("unauthenticated callers are rejected by every artifact and search procedure", async ({ request }) => {
    expect((await trpcQuery(request, "artifacts.list", { workspaceId: 1 })).code).toBe("UNAUTHORIZED");
    expect((await trpcQuery(request, "artifacts.get", { workspaceId: 1, artifactId: 1 })).code).toBe("UNAUTHORIZED");
    expect((await trpcQuery(request, "search.workspace", { workspaceId: 1, query: "x" })).code).toBe("UNAUTHORIZED");
    expect((await trpcMutate(request, "artifacts.saveFromMessage", { workspaceId: 1, conversationId: 1, messageId: 1 })).code).toBe("UNAUTHORIZED");
    expect((await trpcMutate(request, "artifacts.update", { workspaceId: 1, artifactId: 1, title: "x" })).code).toBe("UNAUTHORIZED");
    expect((await trpcMutate(request, "artifacts.delete", { workspaceId: 1, artifactId: 1 })).code).toBe("UNAUTHORIZED");
    expect((await trpcMutate(request, "artifacts.attachFile", { workspaceId: 1, artifactId: 1, documentId: 1 })).code).toBe("UNAUTHORIZED");
    expect((await trpcMutate(request, "artifacts.detachFile", { workspaceId: 1, artifactId: 1, documentId: 1 })).code).toBe("UNAUTHORIZED");
  });
});
