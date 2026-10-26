import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { login, myWorkspaceId, newIdentity, trpcQuery, type Identity } from "../support/helpers";

/**
 * Sentinel in a real browser against the real built server. Needs the Sentinel-enabled stack: E2E_SENTINEL=1 (SENTINEL_ENABLED + TASK_WORKER_ENABLED
 * and the proposed 0013 tables applied to the THROWAWAY database only). Local fake model, no external provider, no spend.
 * Covers: truthful status, the owner-only runtime panel (keyboard, no secrets/URLs in the DOM), owner/stranger isolation, accessibility and mobile layout.
 * Not covered here: running an investigation through a connector (covered by the integration tests with a synthetic MCP server).
 */
test.skip(process.env.E2E_SENTINEL !== "1", "needs the Sentinel-enabled E2E stack (E2E_SENTINEL=1)");

/** The shared login helper expects the landing page, so sign in there first and then open Sentinel (an unauthenticated /sentinel shows its own sign-in screen). */
async function openSentinel(page: Page, identity: Identity) {
  await login(page, identity);
  await page.goto("/sentinel");
  // Wait for the status query to settle: scanning the loading state would test a transient (the action button is disabled and faded until status arrives).
  await expect(page.getByRole("heading", { name: "Incident investigations" })).toBeVisible();
  await expect(page.getByText("Task worker", { exact: true })).toBeVisible();
}

async function axeBlocking(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return r.violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

test.describe("Sentinel page", () => {
  test("enabled stack: heading, read-only badge and truthful runtime status; no sample data", async ({ page }) => {
    await openSentinel(page, newIdentity("sn"));
    await expect(page.getByRole("heading", { name: "Incident investigations" })).toBeVisible();
    await expect(page.getByText("Read-only", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Sentinel is turned off for this deployment")).toHaveCount(0);
    // nothing has been created: the page must say so rather than show examples
    await expect(page.getByRole("heading", { name: "Start your first investigation" })).toBeVisible();
  });

  test("owner runtime panel opens by keyboard and shows providers and budget with no URL, key or prompt in the page", async ({ page }) => {
    await openSentinel(page, newIdentity("snrt"));
    const panel = page.getByTestId("model-runtime");
    await expect(panel).toBeVisible();
    const summary = panel.locator("summary");
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(panel.getByRole("list", { name: "Providers" })).toBeVisible();
    const text = await page.locator("main").innerText();
    expect(text).not.toContain("e2e-not-a-real-key");
    expect(text).not.toMatch(/127\.0\.0\.1|localhost:431/);
    // the external provider is configured but not allowed: the panel must not present it as usable
    await expect(panel.getByRole("list", { name: "Providers" })).toContainText(/external/i);
    await expect(panel).toContainText("no hosted-model spend can occur");
  });

  test("modelRuntime.status: the owner gets a secret-free payload; another user is refused", async ({ browser }) => {
    const ownerCtx = await browser.newContext(); const owner = await ownerCtx.newPage();
    await login(owner, newIdentity("own"));
    const wsId = await myWorkspaceId(ownerCtx.request);
    const ok = await trpcQuery<Record<string, unknown>>(ownerCtx.request, "modelRuntime.status", { workspaceId: wsId });
    expect(ok.status).toBe(200);
    const body = JSON.stringify(ok.data);
    expect(body).not.toContain("e2e-not-a-real-key");
    expect(body).not.toMatch(/https?:\/\//);

    const otherCtx = await browser.newContext(); const other = await otherCtx.newPage();
    await login(other, newIdentity("str"));
    const denied = await trpcQuery(otherCtx.request, "modelRuntime.status", { workspaceId: wsId });
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied)).not.toContain("providers");
    const anon = await (await browser.newContext()).request.get(`/api/trpc/modelRuntime.status?input=${encodeURIComponent(JSON.stringify({ json: { workspaceId: wsId } }))}`);
    expect(anon.status()).toBe(401);
    await ownerCtx.close(); await otherCtx.close();
  });

  test("no serious or critical accessibility violations on the investigations and connectors pages", async ({ page }) => {
    await openSentinel(page, newIdentity("a11y"));
    await expect(page.getByRole("heading", { name: "Incident investigations" })).toBeVisible();
    expect(await axeBlocking(page), "investigations").toEqual([]);
    await page.getByRole("link", { name: "Connectors" }).click();
    await expect(page).toHaveURL(/\/sentinel\/connectors$/);
    expect(await axeBlocking(page), "connectors").toEqual([]);
  });

  test("layout: no horizontal page scroll at this viewport", async ({ page }) => {
    await openSentinel(page, newIdentity("lay"));
    await expect(page.getByRole("heading", { name: "Incident investigations" })).toBeVisible();
    const r = await page.evaluate(() => {
      const w = document.documentElement.clientWidth;
      return { overflow: document.documentElement.scrollWidth - w, offenders: [...document.querySelectorAll("body *")].filter((el) => el.getBoundingClientRect().right > w + 1).slice(0, 6).map((el) => `${el.tagName.toLowerCase()}.${(el as HTMLElement).className}`.slice(0, 80)) };
    });
    expect(r.overflow, `offenders: ${r.offenders.join(" | ")}`).toBeLessThanOrEqual(1);
  });
});
