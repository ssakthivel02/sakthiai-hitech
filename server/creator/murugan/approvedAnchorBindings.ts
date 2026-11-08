import { createHash } from "node:crypto";
import type { MuruganElement, ScenePlan } from "./scenePlan";

/**
 * Pure pre-generation gate for the Murugan continuity graph. The caller MUST obtain
 * rows from the tenant-scoped DB resolver; this function never trusts client-supplied
 * asset metadata, performs no provider calls, and does not imply human approval.
 */
export type ApprovedAnchorReferenceRow = {
  referenceId: number;
  assetId: number;
  workspaceId: number;
  creatorProjectId: number;
  kind: "CHARACTER" | "STYLE" | "LOCATION" | "OBJECT";
  label: string;
  referenceImmutable: number;
  approvedAt: Date | null;
  assetType: string;
  assetImmutable: number;
  reviewDecision: string;
  mimeType: string;
  checksumSha256: string;
  storageKey: string;
};

export type MuruganAnchorSelection = Partial<Record<MuruganElement, {
  referenceId: number;
  assetId: number;
  /** Must match the human-approved reference's exact label. */
  label: string;
}>>;

export type BoundMuruganAnchor = {
  element: MuruganElement;
  anchorShotId: string;
  referenceId: number;
  assetId: number;
  checksumSha256: string;
  storageKey: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
};

export type BoundMuruganShot = {
  shotId: string;
  startMs: number;
  endMs: number;
  /** One immutable, approved reference asset per visible identity element. */
  anchors: Partial<Record<MuruganElement, BoundMuruganAnchor>>;
};

const ELEMENTS: readonly MuruganElement[] = ["murugan", "vel", "peacock"];
const REQUIRED_KIND: Record<MuruganElement, ApprovedAnchorReferenceRow["kind"]> = {
  murugan: "CHARACTER", vel: "OBJECT", peacock: "OBJECT",
};
const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
const SHA256 = /^[0-9a-f]{64}$/;

export function bindApprovedMuruganAnchors(input: {
  plan: ScenePlan;
  workspaceId: number;
  creatorProjectId: number;
  selection: MuruganAnchorSelection;
  /** Authoritative rows from creatorReferences INNER JOIN creatorAssets. */
  rows: readonly ApprovedAnchorReferenceRow[];
}): { planId: string; bindingId: string; shots: BoundMuruganShot[]; referenceAssetIds: number[] } {
  const { plan, selection, rows } = input;
  if (!Number.isSafeInteger(input.workspaceId) || input.workspaceId <= 0 ||
      !Number.isSafeInteger(input.creatorProjectId) || input.creatorProjectId <= 0) {
    throw new Error("MURUGAN_ANCHOR_SCOPE_INVALID");
  }
  if (plan.bible.status !== "OWNER_APPROVED" || plan.request.continuity.characterBibleStatus !== "OWNER_APPROVED") {
    throw new Error("MURUGAN_ANCHOR_BIBLE_NOT_APPROVED");
  }
  if (!SHA256.test(plan.planId)) throw new Error("MURUGAN_ANCHOR_PLAN_ID_INVALID");

  // Independently check shot graph continuity, rather than trusting the plan's
  // externally supplied referenceFromShotByElement fields.
  const firstAnchorShot = new Map<MuruganElement, string>();
  let cursor = 0;
  const seenShots = new Set<string>();
  const usedElements = new Set<MuruganElement>();
  for (const shot of plan.shots) {
    if (seenShots.has(shot.shotId) || shot.startMs !== cursor || shot.endMs <= shot.startMs) {
      throw new Error("MURUGAN_ANCHOR_SHOT_GRAPH_INVALID");
    }
    seenShots.add(shot.shotId);
    cursor = shot.endMs;
    const elements = new Set(shot.elements);
    if (elements.size !== shot.elements.length || shot.elements.some(element => !ELEMENTS.includes(element))) {
      throw new Error("MURUGAN_ANCHOR_ELEMENTS_INVALID");
    }
    for (const element of shot.elements) {
      usedElements.add(element);
      const first = firstAnchorShot.get(element);
      if (!first) {
        if (!shot.anchorFor.includes(element) || shot.referenceFromShotByElement[element]) {
          throw new Error(`MURUGAN_ANCHOR_GRAPH_MISMATCH:${shot.shotId}:${element}`);
        }
        firstAnchorShot.set(element, shot.shotId);
      } else if (shot.anchorFor.includes(element) || shot.referenceFromShotByElement[element] !== first) {
        throw new Error(`MURUGAN_ANCHOR_GRAPH_MISMATCH:${shot.shotId}:${element}`);
      }
    }
    if (shot.anchorFor.some(element => !elements.has(element))) {
      throw new Error("MURUGAN_ANCHOR_GRAPH_INVALID_FIRST_APPEARANCE");
    }
  }
  if (!plan.shots.length || cursor !== plan.audio.durationMs || !usedElements.size) {
    throw new Error("MURUGAN_ANCHOR_SHOT_GRAPH_INVALID");
  }

  const selected = new Map<MuruganElement, ApprovedAnchorReferenceRow>();
  const selectedIds = new Set<number>();
  const selectedReferenceIds = new Set<number>();
  const planIds = new Set(plan.request.continuity.referenceAssetIds);
  for (const element of ELEMENTS) {
    const chosen = selection[element];
    if (!usedElements.has(element)) {
      if (chosen) throw new Error(`MURUGAN_ANCHOR_UNUSED_ELEMENT:${element}`);
      continue;
    }
    if (!chosen || !Number.isSafeInteger(chosen.assetId) || chosen.assetId <= 0 ||
        !Number.isSafeInteger(chosen.referenceId) || chosen.referenceId <= 0 || !chosen.label.trim()) {
      throw new Error(`MURUGAN_ANCHOR_SELECTION_MISSING:${element}`);
    }
    if (selectedIds.has(chosen.assetId) || selectedReferenceIds.has(chosen.referenceId)) {
      throw new Error("MURUGAN_ANCHOR_REFERENCE_REUSED");
    }
    if (!planIds.has(String(chosen.assetId))) throw new Error(`MURUGAN_ANCHOR_PLAN_ASSET_MISMATCH:${element}`);
    const row = rows.find(row => row.referenceId === chosen.referenceId && row.assetId === chosen.assetId);
    if (!row) throw new Error(`MURUGAN_ANCHOR_REFERENCE_NOT_FOUND:${element}`);
    if (row.workspaceId !== input.workspaceId || row.creatorProjectId !== input.creatorProjectId) {
      throw new Error(`MURUGAN_ANCHOR_SCOPE_MISMATCH:${element}`);
    }
    if (row.kind !== REQUIRED_KIND[element] || row.label !== chosen.label) {
      throw new Error(`MURUGAN_ANCHOR_IDENTITY_MISMATCH:${element}`);
    }
    if (row.assetType !== "REFERENCE" || row.referenceImmutable !== 1 || row.assetImmutable !== 1 ||
        row.reviewDecision !== "APPROVED" || !row.approvedAt) {
      throw new Error(`MURUGAN_ANCHOR_REFERENCE_NOT_APPROVED:${element}`);
    }
    if (!IMAGE_MIME.has(row.mimeType) || !SHA256.test(row.checksumSha256) || !row.storageKey.trim()) {
      throw new Error(`MURUGAN_ANCHOR_REFERENCE_CORRUPT:${element}`);
    }
    selected.set(element, row);
    selectedIds.add(chosen.assetId);
    selectedReferenceIds.add(chosen.referenceId);
  }
  if (planIds.size !== selectedIds.size || [...planIds].some(id => !selectedIds.has(Number(id)))) {
    throw new Error("MURUGAN_ANCHOR_PLAN_REFERENCE_SET_MISMATCH");
  }

  // Bind the existing plan identity to the exact approved DB asset checksums.
  // The older planId alone does not include reference asset identities.
  const bindingId = createHash("sha256").update(JSON.stringify({
    planId: plan.planId, workspaceId: input.workspaceId, creatorProjectId: input.creatorProjectId,
    references: ELEMENTS.flatMap(element => {
      const row = selected.get(element);
      return row ? [[element, row.referenceId, row.assetId, row.checksumSha256]] : [];
    }),
  })).digest("hex");
  return {
    planId: plan.planId, bindingId,
    referenceAssetIds: ELEMENTS.flatMap(element => selected.has(element) ? [selected.get(element)!.assetId] : []),
    shots: plan.shots.map(shot => {
      const anchors: Partial<Record<MuruganElement, BoundMuruganAnchor>> = {};
      for (const element of shot.elements) {
        const row = selected.get(element)!;
        anchors[element] = {
          element, anchorShotId: firstAnchorShot.get(element)!, referenceId: row.referenceId,
          assetId: row.assetId, checksumSha256: row.checksumSha256, storageKey: row.storageKey,
          mimeType: row.mimeType as BoundMuruganAnchor["mimeType"],
        };
      }
      return { shotId: shot.shotId, startMs: shot.startMs, endMs: shot.endMs, anchors };
    }),
  };
}
