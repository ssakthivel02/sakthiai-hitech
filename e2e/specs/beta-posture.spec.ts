import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import mysql from "mysql2/promise";
import { BETA_IDENTITIES, BETA_ORIGIN } from "../support/ports";
import { ask, llm, login, myWorkspaceId, setNextUser, trpcMutate, trpcQuery, uploadText } from "../support/helpers";

/**
 * The private-beta posture, exactly as it will be deployed: file uploads OFF (flag unset), NO object-storage settings,
 * a scanner configured anyway, a login allowlist, and sources that arrive only through the operator-only synthetic import.
 * Reproduces (and now guards) the five reviewed defects through the real built server and a real browser.
 */
test.use({ baseURL: BETA_ORIGIN });
test.beforeEach(async () => { await llm.reset(); });

const { alice, bob, carol, mallory } = BETA_IDENTITIES;
const DB_URL = () => process.env.E2E_BETA_DATABASE_URL!;
const DB_NAME = () => process.env.E2E_BETA_DATABASE_NAME!;

/** The real operator CLI, against the beta database, with the beta allowlist. Never pipes secrets into the output. */
function operator(args: string[]) {
  const run = spawnSync("pnpm", ["exec", "tsx", "scripts/import-beta-sources.ts", ...args], {
    encoding: "utf8", timeout: 120_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: DB_URL(), DATABASE_EXPECTED_NAME: DB_NAME(), AUTH_ALLOWED_SUBJECTS: process.env.E2E_BETA_ALLOWED_SUBJECTS },
  });
  let json: any = null;
  try { json = JSON.parse(run.stdout); } catch { /* refusal paths print to stderr */ }
  return { code: run.status, json, stderr: run.stderr };
}
async function sql<T = any>(query: string, params: unknown[] = []): Promise<T[]> {
  const conn = await mysql.createConnection(DB_URL());
  try { const [rows] = await conn.query(query, params); return rows as T[]; } finally { await conn.end(); }
}
const documentCount = async (workspaceId: number) => Number((await sql("SELECT COUNT(*) n FROM documents WHERE workspaceId = ?", [workspaceId]))[0].n);

test.describe.configure({ mode: "serial" });

test.describe("private-beta posture", () => {
  test("D5: readiness is 200 with uploads OFF and no object storage configured", async ({ request }) => {
    const res = await request.get("/readyz");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ready");
    expect(body.dependencies.storage).toBe("not_required");
    expect(body.dependencies.scanner.configuration).toBe("configured_unverified");
    expect(body.dependencies.scanner.fileIngestion).toBe("coming_soon");
  });

  test("D1: direct upload API calls are refused even though a scanner is configured; nothing is stored", async ({ page }) => {
    await login(page, alice);
    const ws = await myWorkspaceId(page.request);
    const before = await documentCount(ws);
    const direct = await uploadText(page.request, ws, "note.txt", "hello world");
    expect(direct.status).toBe(403);
    expect(direct.message).toBe("File uploads are not enabled in this beta");
    const resumable = await trpcMutate(page.request, "files.resumable.begin", { workspaceId: ws, filename: "a.txt", mimeType: "text/plain", sizeBytes: 5, sha256: "a".repeat(64), chunkSize: 5 });
    expect(resumable.status).toBe(403);
    expect(await documentCount(ws)).toBe(before);
    await expect(page.locator('input[type="file"]')).toBeDisabled();
  });

  test("D2: a fresh workspace has no approved sources — the answer says so and no model is called", async ({ page }) => {
    await login(page, bob);
    await ask(page, "What are the library opening hours on Saturday?");
    await expect(page.locator(".answer-area")).toContainText("INSUFFICIENT_EVIDENCE");
    await expect(page.locator(".answer-note")).toContainText("No approved source in this workspace matches your question");
    expect((await llm.local()).calls).toBe(0);
  });

  test("D2: the operator-only import gates, then makes English and Tamil questions reach the (fake) model with citations", async ({ page }) => {
    await login(page, alice);
    const ws = await myWorkspaceId(page.request);

    // Bob's workspace exists too (previous test); a workspace owned by a user who is NOT on the allowlist is created directly.
    await sql("INSERT INTO users (openId, email, loginMethod) VALUES ('beta-outsider', 'outsider@example.test', 'e2e') ON DUPLICATE KEY UPDATE email = email");
    const outsiderUser = (await sql("SELECT id FROM users WHERE openId = 'beta-outsider'"))[0].id;
    await sql("INSERT INTO workspaces (ownerUserId, name, slug) VALUES (?, 'outsider', 'e2e-outsider') ON DUPLICATE KEY UPDATE name = name", [outsiderUser]);
    const outsiderWs = (await sql("SELECT id FROM workspaces WHERE slug = 'e2e-outsider'"))[0].id;

    // list is read-only and shows who is designated
    const listed = operator(["--list-workspaces"]);
    expect(listed.code).toBe(0);
    const mine = listed.json.workspaces.find((w: any) => w.workspaceId === ws);
    expect(mine.ownerOnAllowlist).toBe(true);
    expect(listed.json.workspaces.find((w: any) => w.workspaceId === outsiderWs).ownerOnAllowlist).toBe(false);
    expect(JSON.stringify(listed.json)).not.toMatch(/@example\.test|beta-alice/); // no emails or subjects in operator output

    // cross-tenant / non-designated: refused as a whole, nothing written
    const cross = operator(["--workspace-id", String(ws), "--workspace-id", String(outsiderWs)]);
    expect(cross.code).toBe(2);
    expect(cross.json.plan.ok).toBe(false);
    expect(cross.json.plan.reasons.join(" ")).toContain("not on the beta allowlist");
    expect(await documentCount(outsiderWs)).toBe(0);
    const missing = operator(["--workspace-id", "999999"]);
    expect(missing.code).toBe(2);

    // dry run writes nothing and returns the token
    const before = await documentCount(ws);
    const dry = operator(["--workspace-id", String(ws)]);
    expect(dry.code).toBe(0);
    expect(dry.json).toMatchObject({ mode: "dry-run", wrote: false });
    expect(await documentCount(ws)).toBe(before);
    const token = dry.json.confirmationToken as string;
    expect(token).toMatch(/^IMPORT-[0-9A-F]{16}$/);

    // apply needs the right token and the exact database name
    expect(operator(["--workspace-id", String(ws), "--apply", "--confirm", "IMPORT-0000000000000000", "--expect-database", DB_NAME()]).code).toBe(2);
    expect(operator(["--workspace-id", String(ws), "--apply", "--confirm", token, "--expect-database", "not_the_database"]).code).toBe(2);
    expect(await documentCount(ws)).toBe(before);
    const applied = operator(["--workspace-id", String(ws), "--apply", "--confirm", token, "--expect-database", DB_NAME()]);
    expect(applied.code, applied.stderr).toBe(0);
    expect(applied.json.verification.every((v: any) => v.ok)).toBe(true);
    expect(await documentCount(ws)).toBe(6);
    const again = operator(["--workspace-id", String(ws), "--apply", "--confirm", token, "--expect-database", DB_NAME()]);
    expect(again.json.report.totals).toMatchObject({ inserted: 0, alreadyPresent: 6 });
    expect(await documentCount(ws)).toBe(6);

    // the imported sources are listed to their owner and ONLY to their owner
    await page.reload();
    await expect(page.locator("#files").getByText("synthetic-en-library-hours.txt")).toBeVisible();
    await ask(page, "What are the library opening hours on Saturday?");
    await expect(page.getByText("[local] Per the sources the temple opens at 6am")).toBeVisible();
    await expect(page.getByText("CITATIONS")).toBeVisible();
    await expect(page.locator(".citation strong", { hasText: "synthetic-en-library-hours.txt" }).first()).toBeVisible();
    expect((await llm.local()).calls).toBe(1);

    await page.getByRole("button", { name: "தமிழ்", exact: true }).click();
    await ask(page, "அடிப்படைக் கணினிப் பயிற்சி கட்டணம் என்ன?");
    await expect(page.getByText("[local] ஆதாரத்தின்படி பதில்")).toBeVisible();
    await expect(page.locator(".citation").first()).toContainText("synthetic-ta-center-courses.txt");
    expect((await llm.local()).last?.language).toBe("ta");
  });

  test("tenant isolation: the imported corpus is invisible to another beta user", async ({ page }) => {
    await login(page, bob);
    const ws = await myWorkspaceId(page.request);
    const listed = await trpcQuery<Array<{ filename: string }>>(page.request, "files.list", { workspaceId: ws });
    expect(listed.data).toEqual([]);
    await ask(page, "What are the library opening hours on Saturday?");
    await expect(page.locator(".answer-area")).toContainText("INSUFFICIENT_EVIDENCE");
    expect((await llm.local()).calls).toBe(0);
  });

  test("D4: a denied identity gets a readable page with a recovery route, never raw JSON, and no session", async ({ page, context }) => {
    await setNextUser(mallory);
    await page.goto("/");
    await page.getByRole("button", { name: "Sign in securely" }).click();
    await expect(page.getByRole("heading", { name: "This account is not approved for the private beta" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "இந்தக் கணக்கு தனியார் பீட்டாவுக்கு அனுமதிக்கப்படவில்லை" })).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("No SakthiAI account or session was created");
    expect(await page.content()).not.toContain('{"error"');
    expect((await context.cookies()).some(c => c.name === "app_session_id")).toBe(false);
    expect((await sql("SELECT COUNT(*) n FROM users WHERE openId = ?", [mallory.sub]))[0].n).toBe(0);
    await page.getByRole("link", { name: /Back to sign-in/ }).click();
    await expect(page).toHaveURL(`${BETA_ORIGIN}/`);
    await expect(page.getByRole("button", { name: "Sign in securely" })).toBeVisible();
  });

  test("D3: a model outage is shown with a retry that recovers", async ({ page }) => {
    await login(page, alice);
    await llm.mode("down");
    await ask(page, "What are the library opening hours on Saturday?");
    const alert = page.getByRole("alert").filter({ hasText: "That did not work" });
    await expect(alert).toContainText("The answer service could not respond right now");
    await expect(alert).not.toContainText(/503|fake provider|ECONN|http/i);
    await llm.mode("ok");
    await alert.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText("[local] Per the sources the temple opens at 6am")).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "That did not work" })).toHaveCount(0);
  });

  test("D3: hitting the real chat rate limit is explained with a wait time", async ({ page }) => {
    await login(page, carol);
    const ws = await myWorkspaceId(page.request);
    let last: Awaited<ReturnType<typeof trpcMutate>> | undefined;
    for (let i = 0; i < 22; i += 1) last = await trpcMutate(page.request, "chat.send", { workspaceId: ws, message: `quarkgluon zzyzx ${i}`, language: "en" });
    expect(last?.status).toBe(429);
    await ask(page, "quarkgluon zzyzx once more");
    const alert = page.getByRole("alert").filter({ hasText: "That did not work" });
    await expect(alert).toContainText("too quickly");
    await expect(alert).toContainText(/\d+ seconds/);
    await expect(alert.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  test("D3: a failed project save is visible, leaks nothing, and Try again saves it", async ({ page }) => {
    await login(page, bob);
    let fail = true;
    await page.route("**/api/trpc/projects.create*", route => fail
      ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify([{ error: { json: { message: "Database unavailable mysql://user:s3cr3t@db.internal/app", code: -32603, data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 503 } } } }]) })
      : route.continue());
    await page.getByPlaceholder(/project/i).fill("Beta pilot");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const alert = page.getByRole("alert").filter({ hasText: "That did not work" });
    await expect(alert).toContainText("The service is having trouble right now");
    await expect(alert).not.toContainText(/mysql|s3cr3t|db\.internal/);
    fail = false;
    await alert.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Project added." })).toBeAttached();
    await expect(page.locator("#projects").getByText("Beta pilot").first()).toBeVisible();
  });
});
