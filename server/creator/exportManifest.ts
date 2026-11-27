import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { creatorAssets, creatorCaptionCues, creatorExports, creatorGenerations, creatorReviews } from "../../drizzle/schema";
import { getDb } from "../db";

/**
 * Export provenance manifest: what exactly produced an export. Read-only, workspace-scoped, built only from persisted
 * rows (never from the client). Contains identifiers, checksums and decisions, never storage keys, signed URLs,
 * prompts' secrets or provider credentials. Caption text is represented by a hash plus counts.
 */
type Json = Record<string, unknown>;
const parse = (value: string | null | undefined): Json => { try { return value ? JSON.parse(value) as Json : {}; } catch { return {}; } };
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export type ManifestInput = {
  exportRow: { id: number; timelineId: number; status: string; width: number; height: number; format: string; renderer: string; parametersJson: string | null; checksumSha256: string | null; createdAt: Date; completedAt: Date | null };
  renderAsset?: { id: number; checksumSha256: string; byteSize: number | null; reviewDecision: string; immutable: number; provenanceJson: string };
  audioMaster?: { id: number; checksumSha256: string; reviewDecision: string };
  visualAssets: Array<{ id: number; assetType: string; checksumSha256: string; reviewDecision: string; immutable: number; shotId: number | null; provenanceJson: string }>;
  generations: Array<{ id: number; kind: string; provider: string; model: string; status: string; parametersJson: string }>;
  captions: Array<{ startMs: number; endMs: number; language: string; text: string; locked: number }>;
  reviews: Array<{ id: number; assetId: number | null; reviewType: string; decision: string; reviewerUserId: number | null; createdAt: Date }>;
};

export function buildExportManifest(input: ManifestInput, generatedAt = new Date()) {
  const render = parse(input.renderAsset?.provenanceJson);
  const generationById = new Map(input.generations.map(g => [g.id, g]));
  const isMaster = render.source === "deterministic-creator-render";
  const captionCanonical = input.captions.map(c => `${c.startMs}|${c.endMs}|${c.language}|${c.text.normalize("NFC")}`).join("\n");
  const reviewsFor = (assetId: number | undefined) => input.reviews.filter(r => r.assetId === assetId).map(r => ({ reviewId: r.id, type: r.reviewType, decision: r.decision, reviewerUserId: r.reviewerUserId, at: r.createdAt.toISOString() }));
  const humanGate = (type: string) => input.reviews.some(r => r.assetId === input.renderAsset?.id && r.reviewType === type && r.decision === "PASS" && r.reviewerUserId);

  return {
    schema: "sakthiai.creator.export-manifest/v1",
    generatedAt: generatedAt.toISOString(),
    export: {
      exportId: input.exportRow.id, timelineId: input.exportRow.timelineId, status: input.exportRow.status,
      width: input.exportRow.width, height: input.exportRow.height, format: input.exportRow.format, renderer: input.exportRow.renderer,
      parameters: parse(input.exportRow.parametersJson), createdAt: input.exportRow.createdAt.toISOString(),
      completedAt: input.exportRow.completedAt?.toISOString() ?? null,
    },
    output: input.renderAsset ? {
      assetId: input.renderAsset.id, checksumSha256: input.renderAsset.checksumSha256, byteSize: input.renderAsset.byteSize,
      kind: isMaster ? "MASTER" : render.source === "deterministic-creator-derivative" ? "DELIVERY_DERIVATIVE" : "UNKNOWN",
      derivativeOf: isMaster ? null : { renderAssetId: render.derivativeOfRenderAssetId ?? null, checksumSha256: render.derivativeOfChecksumSha256 ?? null },
      reviewDecision: input.renderAsset.reviewDecision, finalMaster: isMaster && input.renderAsset.reviewDecision === "APPROVED",
      deliveryApproved: input.renderAsset.reviewDecision === "APPROVED",
      durationMs: render.durationMs ?? null, frameCount: render.frameCount ?? null, fps: render.fps ?? null,
    } : null,
    audioMaster: input.audioMaster ? { assetId: input.audioMaster.id, checksumSha256: input.audioMaster.checksumSha256, reviewDecision: input.audioMaster.reviewDecision } : null,
    visuals: input.visualAssets.map(asset => {
      const p = parse(asset.provenanceJson);
      const generation = typeof p.generationId === "number" ? generationById.get(p.generationId) : undefined;
      const params = parse(generation?.parametersJson);
      return {
        assetId: asset.id, assetType: asset.assetType, shotId: asset.shotId, checksumSha256: asset.checksumSha256,
        reviewDecision: asset.reviewDecision, immutable: asset.immutable === 1,
        origin: generation
          ? { type: "GENERATED", generationId: generation.id, kind: generation.kind, provider: generation.provider, model: generation.model,
              providerJobId: p.providerJobId ?? null, sourceAssetIds: p.sourceAssetIds ?? null,
              consentId: generation.kind === "AVATAR_VIDEO" ? params.consentId ?? null : undefined,
              providerTestMode: generation.kind === "AVATAR_VIDEO" ? params.providerTestMode ?? null : undefined }
          : { type: "NOT_GENERATED_HERE" },
      };
    }),
    captions: {
      count: input.captions.length, locked: input.captions.every(c => c.locked === 1),
      languages: [...new Set(input.captions.map(c => c.language))].sort(), sha256: sha256(captionCanonical),
    },
    reviews: { output: reviewsFor(input.renderAsset?.id) },
    gates: {
      quality: humanGate("QUALITY"), humanTamil: humanGate("HUMAN_TAMIL"), humanVisual: humanGate("HUMAN_VISUAL"),
      publishApproved: false, automaticPublish: false,
    },
  };
}

export async function getCreatorExportManifest(input: { workspaceId: number; creatorProjectId: number; exportId: number }) {
  const db = await getDb();
  if (!db) throw new Error("CREATOR_DATABASE_UNAVAILABLE");
  const scope = (table: typeof creatorAssets | typeof creatorCaptionCues | typeof creatorReviews) =>
    and(eq(table.workspaceId, input.workspaceId), eq(table.creatorProjectId, input.creatorProjectId));
  const [exportRow] = await db.select().from(creatorExports).where(and(
    eq(creatorExports.id, input.exportId), eq(creatorExports.workspaceId, input.workspaceId), eq(creatorExports.creatorProjectId, input.creatorProjectId),
  )).limit(1);
  if (!exportRow) throw new Error("CREATOR_EXPORT_NOT_FOUND");

  const [renderAsset] = exportRow.assetId
    ? await db.select().from(creatorAssets).where(and(eq(creatorAssets.id, exportRow.assetId), scope(creatorAssets))).limit(1)
    : [];
  const render = parse(renderAsset?.provenanceJson);
  const params = parse(exportRow.parametersJson);
  const visualIds = (Array.isArray(render.visualAssetIds) ? render.visualAssetIds : Array.isArray(params.visualAssetIds) ? params.visualAssetIds : []).filter((v): v is number => Number.isInteger(v));
  const audioId = Number(render.audioMasterAssetId ?? params.audioMasterAssetId);

  const [visualAssets, audioRows, captions, reviews] = await Promise.all([
    visualIds.length ? db.select().from(creatorAssets).where(and(inArray(creatorAssets.id, visualIds), scope(creatorAssets))) : Promise.resolve([]),
    Number.isInteger(audioId) ? db.select().from(creatorAssets).where(and(eq(creatorAssets.id, audioId), scope(creatorAssets))).limit(1) : Promise.resolve([]),
    db.select().from(creatorCaptionCues).where(and(scope(creatorCaptionCues), eq(creatorCaptionCues.timelineId, exportRow.timelineId))).orderBy(creatorCaptionCues.startMs, creatorCaptionCues.id),
    renderAsset ? db.select().from(creatorReviews).where(and(scope(creatorReviews), eq(creatorReviews.assetId, renderAsset.id))) : Promise.resolve([]),
  ]);
  const generationIds = visualAssets.map(a => parse(a.provenanceJson).generationId).filter((v): v is number => Number.isInteger(v));
  const generations = generationIds.length
    ? await db.select().from(creatorGenerations).where(and(inArray(creatorGenerations.id, generationIds), eq(creatorGenerations.workspaceId, input.workspaceId), eq(creatorGenerations.creatorProjectId, input.creatorProjectId)))
    : [];
  const ordered = visualIds.map(id => visualAssets.find(a => a.id === id)).filter((a): a is (typeof visualAssets)[number] => Boolean(a));
  return buildExportManifest({ exportRow, renderAsset, audioMaster: audioRows[0], visualAssets: ordered, generations, captions, reviews });
}
