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
    // P-G10: infrastructure probes are operator-only. A normal user (who owns a personal workspace) gets nothing from them.
    expect((await trpcQuery(page.request, "creator.preflight", { workspaceId: ws })).code).toBe("FORBIDDEN");
    expect((await trpcMutate(page.request, "creator.verifyRuntime", { workspaceId: ws })).code).toBe("FORBIDDEN");

    await page.goto("/creator/runtime");
    await expect(page.getByRole("heading", { name: "Creator runtime status is restricted to administrators." })).toBeVisible();
    await expect(page.getByText("Paid generation readiness")).toHaveCount(0);
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

test.describe("Creator speech, consent and avatar panel", () => {
  test("consent can be recorded and revoked from the UI; speech is refused while paid generation is off; no horizontal overflow", async ({ page }) => {
    await login(page, newIdentity("creator-speech"));
    const ws = await myWorkspaceId(page.request);
    const project = await trpcMutate<{ id: number }>(page.request, "creator.workspace.createProject", { workspaceId: ws, name: "E2E Speech" });
    const scene = await trpcMutate<{ id: number }>(page.request, "creator.workspace.createScene", { workspaceId: ws, creatorProjectId: project.data!.id, sceneIndex: 0, title: "Song" });
    await trpcMutate(page.request, "creator.workspace.createShot", { workspaceId: ws, creatorProjectId: project.data!.id, sceneId: scene.data!.id, shotIndex: 0, title: "Verse one", prompt: "Temple" });

    await page.goto("/creator");
    await page.getByRole("button", { name: /E2E Speech/ }).click();
    const panel = page.getByTestId("creator-speech-avatar");
    await expect(panel).toBeVisible();
    await expect(panel.getByText("No generated speech is waiting for review.")).toBeVisible();
    await expect(panel.getByText(/No approved, locked audio yet/)).toBeVisible();

    // Consent: the record button stays disabled until the owner confirms and gives a valid reference.
    const record = panel.getByRole("button", { name: "Record consent" });
    await panel.getByLabel("HeyGen avatar ID").fill("avatar_e2e_01");
    await panel.getByLabel("Consent evidence reference").fill("release-e2e-0001");
    await expect(record).toBeDisabled();
    await panel.getByLabel(/I hold signed consent/).check();
    await expect(record).toBeEnabled();
    await record.click();
    await expect(panel.getByText(/avatar_e2e_01 · avatar_video/)).toBeVisible();
    await expect(panel.getByText(/· Active ·/)).toBeVisible();
    await expect(panel.getByRole("combobox", { name: "Avatar (active consent)" }).locator("option", { hasText: "avatar_e2e_01" })).toHaveCount(1);
    await panel.getByRole("button", { name: "Revoke" }).click();
    await expect(panel.getByText(/· Revoked/)).toBeVisible();
    await expect(panel.getByRole("combobox", { name: "Avatar (active consent)" }).locator("option", { hasText: "avatar_e2e_01" })).toHaveCount(0);

    // Speech: refused server-side with the paid switch off; nothing generated, explained to the user.
    await panel.getByRole("combobox", { name: "Shot" }).first().selectOption({ index: 1 });
    await panel.getByPlaceholder("முருகா வேல் வேல்…").fill("முருகா வேல் வேல்");
    await panel.getByRole("button", { name: "Generate speech" }).click();
    const notice = page.getByTestId("creator-error");
    await expect(notice).toHaveAttribute("data-error-code", "CREATOR_PAID_GENERATION_DISABLED");
    const after = await trpcQuery<{ generations: unknown[] }>(page.request, "creator.workspace.getProject", { workspaceId: ws, creatorProjectId: project.data!.id });
    expect(after.data?.generations ?? []).toHaveLength(0);

    const layout = await page.evaluate(() => ({ inner: window.innerWidth, scroll: document.documentElement.scrollWidth }));
    expect(layout.scroll, JSON.stringify(layout)).toBeLessThanOrEqual(layout.inner + 1);
  });
});

/** Fully disposable browser acceptance: no generation providers, no Murugan source rights implied. */
function syntheticWav(durationMs = 2000): Buffer {
  const sampleRate = 8000;
  const samples = sampleRate * durationMs / 1000;
  const dataBytes = samples * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataBytes, 40);
  return wav; // 2s silence; test fixture, never a human-approved Murugan master.
}

test.describe("Creator browser vertical slice: synthetic audio and Tamil cues", () => {
  test("creates a storyboard, locks disposable WAV and Tamil cues, but refuses rendering without approved visuals", async ({ page }) => {
    await login(page, newIdentity("creator-tamil-p0"));
    const workspaceId = await myWorkspaceId(page.request);
    const created = await trpcMutate<{ id: number }>(page.request, "creator.workspace.createProject", {
      workspaceId, name: "E2E Synthetic Tamil Slice",
    });
    expect(created.data?.id, JSON.stringify(created)).toBeTruthy();
    const creatorProjectId = created.data!.id;

    await page.goto("/creator");
    await page.getByRole("button", { name: /E2E Synthetic Tamil Slice/ }).click();
    await page.getByPlaceholder("Scene title").fill("Synthetic storyboard");
    await page.getByRole("button", { name: "Scene", exact: true }).click();
    await expect(page.getByText("1. Synthetic storyboard")).toBeVisible();
    await page.getByPlaceholder("Shot title").fill("Synthetic opening shot");
    await page.getByPlaceholder("Generation prompt").fill("Disposable non-provider fixture");
    await page.getByRole("button", { name: "Shot", exact: true }).click();
    await expect(page.getByText(/Synthetic opening shot/)).toBeVisible();

    const lockAudio = page.getByRole("button", { name: "Lock approved audio master" });
    const render = page.getByRole("button", { name: "Render 16:9 candidate" });
    await expect(lockAudio).toBeDisabled();
    await expect(render).toBeDisabled();
    await page.locator('input[type="file"][accept="audio/wav,.wav"]').setInputFiles({
      name: "synthetic-p0-silence.wav", mimeType: "audio/wav", buffer: syntheticWav(),
    });
    await expect(lockAudio).toBeDisabled(); // explicit owner checkbox required
    await page.getByLabel(/I confirm this WAV is the approved immutable Murugan audio master/).check();
    await lockAudio.click();
    await expect(page.getByText(/Locked audio master asset \d+/)).toBeVisible();
    await expect(page.getByText(/1920×1080 @ 24fps/)).toBeVisible();

    const cueText = page.getByPlaceholder("Tamil caption text");
    const cueRow = cueText.locator("..");
    await cueRow.locator('input[type="number"]').nth(1).fill("1000");
    await cueText.fill("வேல் முருகா");
    await page.getByRole("button", { name: "Cue", exact: true }).click();
    await cueRow.locator('input[type="number"]').nth(1).fill("2000");
    await cueText.fill("அரோகரா");
    await page.getByRole("button", { name: "Cue", exact: true }).click();
    await page.getByRole("button", { name: "Validate and lock Tamil cues" }).click();

    await expect.poll(async () => {
      const current = await trpcQuery<{ captionCues: Array<{ text: string; language: string; locked: number }> }>(
        page.request, "creator.workspace.getProject", { workspaceId, creatorProjectId },
      );
      return current.data?.captionCues?.map(cue => [cue.text, cue.language, cue.locked]);
    }).toEqual([["வேல் முருகா", "ta", 1], ["அரோகரா", "ta", 1]]);

    // Audio and captions alone must not permit render, fabricated approval or export.
    await expect(render).toBeDisabled();
    await expect(page.getByText(/Missing: visuals/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Validate\/save timeline" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Promote approved 16:9 final master" })).toBeDisabled();
    const state = await trpcQuery<{ assets: Array<{ assetType: string }>; exports: unknown[]; generations: unknown[] }>(
      page.request, "creator.workspace.getProject", { workspaceId, creatorProjectId },
    );
    expect(state.data?.assets.filter(asset => asset.assetType === "AUDIO_MASTER")).toHaveLength(1);
    expect(state.data?.generations).toHaveLength(0);
    expect(state.data?.exports).toHaveLength(0);
  });
});
