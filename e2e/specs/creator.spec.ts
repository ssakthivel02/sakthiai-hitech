import { expect, test } from "@playwright/test";
import { login, myWorkspaceId, newIdentity, trpcMutate, trpcQuery } from "../support/helpers";

test.describe("Creator paid generation is off by default", () => {
  test("Image submission is refused before any provider call and the UI explains why; the spend admin panel is hidden from non-admins", async ({ page }) => {
    await login(page, newIdentity("creator"));
    const ws = await myWorkspaceId(page.request);
    const project = await trpcMutate<{ id: number }>(page.request, "creator.workspace.createProject", { workspaceId: ws, name: "E2E Murugan" });
    expect(project.data?.id, JSON.stringify(project)).toBeTruthy();
    const scene = await trpcMutate<{ id: number }>(page.request, "creator.workspace.createScene", { workspaceId: ws, creatorProjectId: project.data!.id, sceneIndex: 0, title: "Dawn" });
    expect(scene.data?.id, JSON.stringify(scene)).toBeTruthy();
    const shot = await trpcMutate(page.request, "creator.workspace.createShot", { workspaceId: ws, creatorProjectId: project.data!.id, sceneId: scene.data!.id, shotIndex: 0, title: "Temple", prompt: "Temple at dawn" });
    expect(shot.status, JSON.stringify(shot)).toBe(200);

    // Server: the default deployment refuses paid generation outright.
    const direct = await trpcMutate(page.request, "creator.submitImage", { workspaceId: ws, creatorProjectId: project.data!.id, shotId: 1, idempotencyKey: crypto.randomUUID(), prompt: "x" });
    expect(direct).toMatchObject({ code: "FORBIDDEN", message: "CREATOR_PAID_GENERATION_DISABLED" });
    // Admin spend endpoints are not reachable for a normal user.
    expect((await trpcQuery(page.request, "creator.spend.summary")).code).toBe("FORBIDDEN");

    await page.goto("/creator");
    await expect(page.getByTestId("creator-spend-admin")).toHaveCount(0);
    await page.getByRole("button", { name: /E2E Murugan/ }).click();
    await expect(page.getByRole("button", { name: "Image", exact: true })).toBeVisible();
    // No horizontal overflow: the shot controls must be reachable on a phone-width viewport.
    // innerWidth alone is not enough: an over-wide page silently widens the mobile layout viewport (zoomed-out page).
    const layout = await page.evaluate(() => ({ inner: window.innerWidth, scroll: document.documentElement.scrollWidth, screen: window.screen.width }));
    expect(layout.scroll, JSON.stringify(layout)).toBeLessThanOrEqual(layout.inner + 1);
    if (layout.screen < 600) expect(layout.inner, JSON.stringify(layout)).toBeLessThanOrEqual(layout.screen + 1);
    await page.getByRole("button", { name: "Image", exact: true }).click();
    const notice = page.getByTestId("creator-error");
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute("role", "alert");
    await expect(notice).toHaveAttribute("data-error-code", "CREATOR_PAID_GENERATION_DISABLED");
    await expect(notice).toContainText("Paid generation is switched off");
    await expect(notice).toContainText("nothing was charged");

    const generations = await trpcQuery<{ generations: unknown[] }>(page.request, "creator.workspace.getProject", { workspaceId: ws, creatorProjectId: project.data!.id });
    expect(generations.data?.generations ?? []).toHaveLength(0); // no generation row, no provider job
  });
});
