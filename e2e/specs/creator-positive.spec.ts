import { createHash, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createConnection } from "mysql2/promise";
import { login, myWorkspaceId, newIdentity, trpcMutate, trpcQuery } from "../support/helpers";
import { urls } from "../support/ports";

/**
 * Positive Creator browser journey using ONLY disposable E2E MySQL, fake S3,
 * and visibly synthetic media. No generation provider, rights claim, paid
 * operation, human-approved Murugan footage or publishing is involved.
 *
 * Render remains OFF in the browser stack. A real FFmpeg/MinIO candidate is
 * qualified separately by creatorMuruganVerticalSlice.minio.test.ts.
 */
const syntheticPngs = [
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAJCAIAAAC0SDtlAAAAF0lEQVR4nGP8EBDAQApgIkn1qAZaaQAAv+gBovcl+zUAAAAASUVORK5CYII=",
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAJCAIAAAC0SDtlAAAAF0lEQVR4nGNUSFjAQApgIkn1qAZaaQAA/qkBMkM7YoAAAAAASUVORK5CYII=",
];

function syntheticWav(): Buffer {
  const samples = 16_000; // 2 seconds at 8 kHz; test-only silence.
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(samples * 2, 40);
  return wav;
}

test.describe("Creator browser positive synthetic visual approval", () => {
  test("approves two verified stored images, persists full Tamil timeline and refuses disabled fenced render", async ({ page }) => {
    const databaseUrl = process.env.E2E_CREATOR_DATABASE_URL;
    expect(databaseUrl, "only the global-setup disposable database may be seeded").toMatch(/^mysql:\/\/.*\/[^/]+$/);
    const connection = await createConnection(databaseUrl!);
    try {
      await login(page, newIdentity("creator-positive-synthetic"));
      const workspaceId = await myWorkspaceId(page.request);
      const project = await trpcMutate<{ id: number }>(page.request, "creator.workspace.createProject", {
        workspaceId, name: "E2E Synthetic Positive Slice",
      });
      expect(project.status, JSON.stringify(project)).toBe(200);
      const creatorProjectId = project.data!.id;
      const scene = await trpcMutate<{ id: number }>(page.request, "creator.workspace.createScene", {
        workspaceId, creatorProjectId, sceneIndex: 0, title: "Disposable two-shot storyboard",
        startMs: 0, endMs: 2000,
      });
      expect(scene.status, JSON.stringify(scene)).toBe(200);
      const shotIds: number[] = [];
      for (let index = 0; index < 2; index++) {
        const shot = await trpcMutate<{ id: number }>(page.request, "creator.workspace.createShot", {
          workspaceId, creatorProjectId, sceneId: scene.data!.id, shotIndex: index,
          title: `Synthetic visual ${index + 1}`, prompt: "Not a provider generation",
          startMs: index * 1000, endMs: (index + 1) * 1000,
        });
        expect(shot.status, JSON.stringify(shot)).toBe(200);
        shotIds.push(shot.data!.id);
      }

      // The owner action is simulated solely inside the disposable E2E stack.
      const audio = await trpcMutate<{ assetId: number; timelineId: number }>(
        page.request, "creator.audio.ingestApprovedMaster", {
          workspaceId, creatorProjectId, filename: "synthetic-silence.wav",
          mimeType: "audio/wav", dataBase64: syntheticWav().toString("base64"), approved: true,
        },
      );
      expect(audio.status, JSON.stringify(audio)).toBe(200);
      const cues = await trpcMutate(page.request, "creator.audio.replaceCaptionCues", {
        workspaceId, creatorProjectId, timelineId: audio.data!.timelineId,
        humanTamilReviewed: true,
        cues: [
          { startMs: 0, endMs: 1000, text: "வேல் முருகா", language: "ta" },
          { startMs: 1000, endMs: 2000, text: "அரோகரா", language: "ta" },
        ],
      });
      expect(cues.status, JSON.stringify(cues)).toBe(200);

      // Provider rows are test fixtures, NOT evidence of a real Gemini/Veo call.
      const visualIds: number[] = [];
      for (let index = 0; index < 2; index++) {
        const bytes = Buffer.from(syntheticPngs[index], "base64");
        const checksum = createHash("sha256").update(bytes).digest("hex");
        const storageKey = `creator/${workspaceId}/${creatorProjectId}/synthetic-e2e-${randomUUID()}.png`;
        const put = await fetch(`${urls.s3}/e2e/${storageKey}`, {
          method: "PUT", headers: { "content-type": "image/png" },
          body: new Uint8Array(bytes),
        });
        expect(put.status, "synthetic object stored in loopback fake S3").toBe(200);
        const [generationInsert] = await connection.execute(
          "INSERT INTO creatorGenerations (workspaceId, creatorProjectId, shotId, kind, provider, model, parametersJson, status) VALUES (?, ?, ?, 'IMAGE', 'synthetic-e2e', 'fixture', '{}', 'SUCCEEDED')",
          [workspaceId, creatorProjectId, shotIds[index]],
        );
        const generationId = (generationInsert as { insertId: number }).insertId;
        const providerJobId = `synthetic-e2e-${randomUUID()}`;
        await connection.execute(
          "INSERT INTO creatorProviderJobs (workspaceId, creatorProjectId, generationId, provider, providerJobId, status) VALUES (?, ?, ?, 'synthetic-e2e', ?, 'SUCCEEDED')",
          [workspaceId, creatorProjectId, generationId, providerJobId],
        );
        const provenance = JSON.stringify({
          schemaVersion: 1, creatorProjectId, shotId: shotIds[index],
          generationId, provider: "synthetic-e2e", providerJobId, checksumSha256: checksum,
          fixtureOnly: true,
        });
        const [assetInsert] = await connection.execute(
          "INSERT INTO creatorAssets (workspaceId, creatorProjectId, shotId, assetType, mimeType, storageKey, checksumSha256, byteSize, immutable, provenanceJson, reviewDecision) VALUES (?, ?, ?, 'IMAGE', 'image/png', ?, ?, ?, 1, ?, 'PENDING')",
          [workspaceId, creatorProjectId, shotIds[index], storageKey, checksum, bytes.length, provenance],
        );
        const assetId = (assetInsert as { insertId: number }).insertId;
        visualIds.push(assetId);
        await connection.execute("UPDATE creatorGenerations SET outputAssetId = ? WHERE id = ?", [assetId, generationId]);
      }

      await page.goto("/creator");
      await page.getByRole("button", { name: /E2E Synthetic Positive Slice/ }).click();
      const render = page.getByRole("button", { name: "Render 16:9 candidate" });
      await expect(render).toBeDisabled();
      const pendingSelect = page.getByLabel("Pending generated artifact");
      const approve = page.getByRole("button", { name: "Approve for timeline" });
      for (const assetId of visualIds) {
        await pendingSelect.selectOption(String(assetId));
        const preview = page.getByRole("img", { name: `Generated visual asset ${assetId} for human review` });
        await expect(preview).toBeVisible();
        await expect.poll(() => preview.evaluate(image =>
          (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0,
        )).toBe(true);
        await expect(approve).toBeDisabled();
        await page.getByLabel(/I inspected this exact asset and confirm this is my human decision/).check();
        await page.getByPlaceholder(/Record Tamil iconography, character continuity/).fill(
          "Synthetic fixture inspected; no cultural or provider approval implied.",
        );
        await expect(approve).toBeEnabled();
        await approve.click();
        await expect.poll(async () => {
          const current = await trpcQuery<{ assets: Array<{ id: number; reviewDecision: string }> }>(
            page.request, "creator.workspace.getProject", { workspaceId, creatorProjectId },
          );
          return current.data?.assets.find(asset => asset.id === assetId)?.reviewDecision;
        }).toBe("APPROVED");
      }
      await expect(page.getByText(/No generated IMAGE\/VIDEO assets are awaiting owner review/)).toBeVisible();

      const build = page.getByRole("button", { name: "Build draft from approved, timed shot assets" });
      await expect(build).toBeEnabled();
      await build.click();
      const save = page.getByRole("button", { name: "Validate/save timeline" });
      await expect(save).toBeEnabled();
      await save.click();
      await expect.poll(async () => {
        const current = await trpcQuery<{ timelineItems: Array<{ assetId: number; startMs: number; endMs: number }> }>(
          page.request, "creator.workspace.getProject", { workspaceId, creatorProjectId },
        );
        return current.data?.timelineItems.map(item => [item.assetId, item.startMs, item.endMs]);
      }).toEqual([[visualIds[0], 0, 1000], [visualIds[1], 1000, 2000]]);
      await expect(render).toBeEnabled();
      await expect(page.getByText(/Missing: none/)).toBeVisible();

      // This browser stack deliberately has CREATOR_FENCED_RENDER_ENABLED unset.
      // Readiness never authorizes FFmpeg without the independent server gate.
      await render.click();
      await expect(page.getByTestId("creator-error")).toHaveAttribute("data-error-code", "PRECONDITION_FAILED");
      const state = await trpcQuery<{
        assets: Array<{ assetType: string }>; exports: unknown[]; generations: unknown[];
      }>(page.request, "creator.workspace.getProject", { workspaceId, creatorProjectId });
      expect(state.data?.exports).toHaveLength(0);
      expect(state.data?.assets.filter(asset => asset.assetType === "RENDER")).toHaveLength(0);
      expect(state.data?.generations).toHaveLength(2);
      await expect(page.getByRole("button", { name: "Promote approved 16:9 final master" })).toBeDisabled();
    } finally {
      await connection.end();
    }
  });
});
