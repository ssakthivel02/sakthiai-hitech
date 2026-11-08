import { expect, test } from "@playwright/test";
import { EICAR, TAMIL_DOC, ask, llm, login, myWorkspaceId, newIdentity, trpcMutate, trpcQuery, uploadText } from "../support/helpers";

test.beforeEach(async () => { await llm.reset(); });

test.describe("document upload + grounded chat", () => {
  test("upload via the authenticated API is scanned and listed; the UI keeps its owner-approval gate closed", async ({ page }) => {
    await login(page, newIdentity("upload"));
    const ws = await myWorkspaceId(page.request);

    // UI truth: the upload control is disabled until owner approval + runtime evidence flags exist in the release contract.
    await expect(page.getByRole("status").filter({ hasText: "Safe document upload is not enabled" })).toBeVisible();
    await expect(page.locator('input[type="file"]')).toBeDisabled();
    await expect(page.getByRole("button", { name: "Coming Soon", exact: true })).toBeDisabled();

    const clean = await uploadText(page.request, ws, "temple.txt", TAMIL_DOC);
    expect(clean.status, JSON.stringify(clean)).toBe(200);
    const infected = await uploadText(page.request, ws, "eicar.txt", EICAR);
    expect(infected.status).toBeGreaterThanOrEqual(400);

    const listed = await trpcQuery<Array<{ filename: string }>>(page.request, "files.list", { workspaceId: ws });
    expect(listed.data?.map(f => f.filename)).toEqual(["temple.txt"]);
    await page.reload();
    await expect(page.locator("#files").getByText("temple.txt")).toBeVisible();
  });

  test("English, Tamil and mixed-script questions are grounded with citations through the LOCAL provider only", async ({ page }) => {
    await login(page, newIdentity("grounded"));
    const ws = await myWorkspaceId(page.request);
    expect((await uploadText(page.request, ws, "temple.txt", TAMIL_DOC)).status).toBe(200);

    await ask(page, "When does the Murugan temple open?");
    await expect(page.getByText("[local] Per the sources the temple opens at 6am")).toBeVisible();
    await expect(page.getByText("CITATIONS")).toBeVisible();
    await expect(page.locator(".citation strong", { hasText: "temple.txt" }).first()).toBeVisible();

    await page.getByRole("button", { name: "தமிழ்", exact: true }).click();
    await ask(page, "முருகன் கோவில் எங்கே உள்ளது?");
    await expect(page.getByText("[local] ஆதாரத்தின்படி பதில்")).toBeVisible();
    await expect(page.locator(".citation").first()).toContainText("temple.txt");
    expect((await llm.local()).last?.language).toBe("ta");

    await ask(page, "Murugan கோவில் opens எப்போது");
    await expect(page.locator(".citation").first()).toContainText("temple.txt");
    await expect.poll(async () => (await llm.local()).calls).toBe(3);

    expect((await llm.external()).calls, "external provider must never be contacted by default").toBe(0);
  });

  test("no matching evidence → INSUFFICIENT_EVIDENCE without calling any model", async ({ page }) => {
    await login(page, newIdentity("insufficient"));
    const ws = await myWorkspaceId(page.request);
    expect((await uploadText(page.request, ws, "temple.txt", TAMIL_DOC)).status).toBe(200);
    await ask(page, "quarkgluon zzyzx entanglement");
    await expect(page.locator(".answer-area")).toContainText("INSUFFICIENT_EVIDENCE");
    await expect(page.getByText("CITATIONS")).toHaveCount(0);
    expect((await llm.local()).calls).toBe(0);
    expect((await llm.external()).calls).toBe(0);
  });

  test("the model itself declaring the evidence insufficient is shown as INSUFFICIENT_EVIDENCE with no citations", async ({ page }) => {
    await login(page, newIdentity("declared"));
    const ws = await myWorkspaceId(page.request);
    expect((await uploadText(page.request, ws, "temple.txt", TAMIL_DOC)).status).toBe(200);
    await llm.mode("insufficient");
    await ask(page, "When does the Murugan temple open?");
    await expect(page.locator(".answer-area")).toContainText("INSUFFICIENT_EVIDENCE");
    await expect(page.getByText("CITATIONS")).toHaveCount(0);
  });

  test("local provider down → MODEL_UNAVAILABLE (truthful, evidence still listed) and the configured external provider is BLOCKED by default", async ({ page }) => {
    await login(page, newIdentity("down"));
    const ws = await myWorkspaceId(page.request);
    expect((await uploadText(page.request, ws, "temple.txt", TAMIL_DOC)).status).toBe(200);
    await llm.mode("down");

    await ask(page, "When does the Murugan temple open?");
    await expect(page.getByText("The answer could not be generated right now.")).toBeVisible();
    await expect(page.locator(".citation").first()).toContainText("temple.txt");
    await expect.poll(async () => (await llm.local()).calls).toBeGreaterThan(0);
    expect((await llm.external()).calls, "external is configured but not allowed: zero requests").toBe(0);

    // API-level truth: grounding state + gateway outcome
    const direct = await trpcMutate<any>(page.request, "chat.send", { workspaceId: ws, message: "Murugan temple opens", language: "en" });
    expect(direct.data.grounding).toBe("MODEL_UNAVAILABLE");
    expect(direct.data.observability.gateway.status).toBe("failed");
    expect((await llm.external()).calls).toBe(0);

    // recovery without restart
    await llm.mode("ok");
    const recovered = await trpcMutate<any>(page.request, "chat.send", { workspaceId: ws, message: "Murugan temple opens", language: "en" });
    expect(recovered.data.grounding).toBe("GROUNDED_EVIDENCE");
    expect(recovered.data.observability.gateway.providerId).toMatch(/local/i);
    expect((await llm.external()).calls).toBe(0);
  });
});

test.describe("workspace isolation", () => {
  test("another user can neither read, search, upload to, nor chat against someone else's workspace", async ({ browser }) => {
    const alice = await browser.newContext(); const bob = await browser.newContext();
    const pa = await alice.newPage(); const pb = await bob.newPage();
    await login(pa, newIdentity("alice")); await login(pb, newIdentity("bob"));
    const wsA = await myWorkspaceId(alice.request); const wsB = await myWorkspaceId(bob.request);
    expect(wsA).not.toBe(wsB);
    expect((await uploadText(alice.request, wsA, "alice-secret.txt", "Alice private roadmap: the zebrafish launch is in March.")).status).toBe(200);

    const list = await trpcQuery(bob.request, "files.list", { workspaceId: wsA });
    expect(list.status).toBe(403); expect(list.code).toBe("FORBIDDEN");
    expect((await trpcMutate(bob.request, "chat.send", { workspaceId: wsA, message: "zebrafish launch", language: "en" })).code).toBe("FORBIDDEN");
    expect((await uploadText(bob.request, wsA, "evil.txt", "planted")).code).toBe("FORBIDDEN");
    expect((await trpcMutate(bob.request, "projects.create", { workspaceId: wsA, name: "planted" })).code).toBe("FORBIDDEN");

    // Bob asking in his OWN workspace about Alice's content finds nothing
    await ask(pb, "zebrafish launch March");
    await expect(pb.locator(".answer-area")).toContainText("INSUFFICIENT_EVIDENCE");
    await expect(pb.getByText("alice-secret.txt")).toHaveCount(0);
    await alice.close(); await bob.close();
  });

  test("unauthenticated callers are rejected by every protected procedure", async ({ request }) => {
    expect((await trpcQuery(request, "workspace.list")).code).toBe("UNAUTHORIZED");
    expect((await trpcMutate(request, "chat.send", { workspaceId: 1, message: "x", language: "en" })).code).toBe("UNAUTHORIZED");
    expect((await trpcMutate(request, "files.upload", { workspaceId: 1, filename: "a.txt", mimeType: "text/plain", dataBase64: "YQ==" })).code).toBe("UNAUTHORIZED");
  });
});

test("readiness reports configured dependencies and never claims the scanner or model were probed", async ({ request }) => {
  const response = await request.get("/readyz");
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.status).toBe("ready");
  expect(body.dependencies.database).toBe("configured");
  expect(body.dependencies.databaseSchema).toMatchObject({ status: "current", missingTables: 0, missingColumns: 0 });
  expect(body.dependencies.scanner.liveProbe).toBe("not_checked");
  expect(body.dependencies.llm).toBe("configured");
});
