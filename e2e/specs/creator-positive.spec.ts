import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createConnection } from "mysql2/promise";
import { login, myWorkspaceId, newIdentity, trpcMutate, trpcQuery } from "../support/helpers";
import { urls } from "../support/ports";
import { startDisposableFencedCreatorServer } from "../support/fencedServer";

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
    test.setTimeout(180_000);
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
        // The same fixture must satisfy FFmpeg's open-ended HTTP Range,
        // not just the exact 206 reads used by SHA-256 storage approval.
        const openEnded = await fetch(`${urls.s3}/e2e/${storageKey}`, {
          headers: { range: "bytes=0-" },
        });
        expect(openEnded.status).toBe(206);
        expect(Buffer.from(await openEnded.arrayBuffer()).equals(bytes)).toBe(true);
        const suffix = await fetch(`${urls.s3}/e2e/${storageKey}`, {
          headers: { range: "bytes=-4" },
        });
        expect(suffix.status).toBe(206);
        expect(Buffer.from(await suffix.arrayBuffer()).equals(bytes.subarray(-4))).toBe(true);
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
      await expect(page.getByTestId("creator-error")).toHaveAttribute("data-error-code", "CREATOR_FENCED_RENDER_DISABLED");
      const state = await trpcQuery<{
        assets: Array<{ assetType: string }>; exports: unknown[]; generations: unknown[];
      }>(page.request, "creator.workspace.getProject", { workspaceId, creatorProjectId });
      expect(state.data?.exports).toHaveLength(0);
      expect(state.data?.assets.filter(asset => asset.assetType === "RENDER")).toHaveLength(0);
      expect(state.data?.generations).toHaveLength(2);
      await expect(page.getByRole("button", { name: "Promote approved 16:9 final master" })).toBeDisabled();

      
      // Run the existing fenced dispatcher through the actual Creator browser
      // using a separate disposable process. The default E2E server stays OFF.
      const fenced = await startDisposableFencedCreatorServer();
      try {
        await page.goto(fenced.origin + "/creator");
        await page.getByRole("button", { name: /E2E Synthetic Positive Slice/ }).click();
        const fencedRender = page.getByRole("button", { name: "Render 16:9 candidate" });
        await expect(fencedRender).toBeEnabled();
        await fencedRender.click();
        await expect.poll(async () => {
          const current = await trpcQuery<{
            exports: Array<{ id: number; status: string; assetId: number | null }>;
          }>(page.request, "creator.workspace.getProject", { workspaceId, creatorProjectId });
          return current.data?.exports.find(item => item.status === "SUCCEEDED")?.assetId ?? null;
        }, { timeout: 120_000 }).toBeGreaterThan(0);

        const rendered = await trpcQuery<{
          exports: Array<{ id: number; status: string; assetId: number | null }>;
          assets: Array<{ id: number; assetType: string; reviewDecision: string;
            checksumSha256: string; byteSize: number; storageKey: string; provenanceJson: string }>;
        }>(page.request, "creator.workspace.getProject", { workspaceId, creatorProjectId });
        expect(rendered.status).toBe(200);
        expect(rendered.data!.exports).toHaveLength(1);
        const candidate = rendered.data!.assets.find(asset => asset.assetType === "RENDER");
        expect(candidate, "one actual FFmpeg output must be persisted").toBeDefined();
        expect(candidate!.reviewDecision).toBe("PENDING");
        expect(rendered.data!.exports[0]).toMatchObject({
          status: "SUCCEEDED", assetId: candidate!.id,
        });
        const provenance = JSON.parse(candidate!.provenanceJson) as Record<string, unknown>;
        expect(provenance).toMatchObject({
          source: "deterministic-creator-render", renderer: "ffmpeg",
          outputEvidence: { width: 1920, height: 1080, fps: 24, hasAudio: true },
        });

        // Read the persisted MP4 back from disposable S3, hash its actual
        // bytes, and independently inspect its video and audio with FFprobe.
        const key = candidate!.storageKey.split("/").map(encodeURIComponent).join("/");
        const object = await fetch(urls.s3 + "/e2e/" + key);
        expect(object.status).toBe(200);
        const bytes = Buffer.from(await object.arrayBuffer());
        expect(bytes.length).toBe(candidate!.byteSize);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(candidate!.checksumSha256);
        const directory = mkdtempSync(join(tmpdir(), "creator-fenced-browser-"));
        try {
          const videoFile = join(directory, "synthetic-candidate.mp4");
          writeFileSync(videoFile, bytes);
          const probe = JSON.parse(execFileSync("ffprobe", [
            "-v", "error", "-show_entries",
            "stream=codec_type,width,height,avg_frame_rate,nb_frames",
            "-of", "json", videoFile,
          ], { encoding: "utf8", timeout: 15_000 })) as {
            streams: Array<{ codec_type: string; width?: number; height?: number;
              avg_frame_rate?: string; nb_frames?: string }>;
          };
          expect(probe.streams.find(stream => stream.codec_type === "video")).toMatchObject({
            width: 1920, height: 1080, avg_frame_rate: "24/1", nb_frames: "48",
          });
          expect(probe.streams.some(stream => stream.codec_type === "audio")).toBe(true);
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }

        // Replaying the exact same authorized intent must reuse the existing
        // claim, not create another export, render, storage object or charge.
        const duplicateResponse = await page.request.post(
          fenced.origin + "/api/trpc/creator.timeline.renderCandidate", {
            data: { json: {
              workspaceId, creatorProjectId, timelineId: audio.data!.timelineId,
              confirmCandidateOnly: true,
            } },
            headers: { "content-type": "application/json" },
          },
        );
        expect(duplicateResponse.status()).toBe(200);
        const duplicate = await duplicateResponse.json();
        expect(duplicate.result.data.json).toMatchObject({
          dispatched: false, exportId: rendered.data!.exports[0].id,
          state: "SUCCEEDED", finalMaster: false, publishApproved: false,
        });
        const [claims] = await connection.execute(
          "SELECT state, outputAssetId FROM creatorRenderClaims WHERE workspaceId = ? AND creatorProjectId = ?",
          [workspaceId, creatorProjectId],
        );
        expect(claims).toHaveLength(1);
        expect((claims as Array<{ state: string; outputAssetId: number }>)[0]).toMatchObject({
          state: "SUCCEEDED", outputAssetId: candidate!.id,
        });

        const denied = await page.request.post(
          fenced.origin + "/api/trpc/creator.review.finalizeMaster", {
            data: { json: { workspaceId, creatorProjectId, assetId: candidate!.id } },
            headers: { "content-type": "application/json" },
          },
        );
        expect(denied.status()).toBe(400);
        await expect(page.getByRole("button", { name: "Promote approved 16:9 final master" })).toBeDisabled();
        const after = await trpcQuery<{
          exports: unknown[]; assets: Array<{ assetType: string; reviewDecision: string }>;
        }>(page.request, "creator.workspace.getProject", { workspaceId, creatorProjectId });
        expect(after.data?.exports).toHaveLength(1);
        expect(after.data?.assets.filter(asset => asset.assetType === "RENDER")).toHaveLength(1);
        expect(after.data?.assets.find(asset => asset.assetType === "RENDER")?.reviewDecision).toBe("PENDING");
      } finally {
        await fenced.close();
      }
    } finally {
      await connection.end();
    }
  });
});
