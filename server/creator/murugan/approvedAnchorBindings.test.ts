import { describe, expect, it } from "vitest";
import { buildScenePlan, type ApprovedLine, type CharacterBible } from "./scenePlan";
import { bindApprovedMuruganAnchors, type ApprovedAnchorReferenceRow, type MuruganAnchorSelection } from "./approvedAnchorBindings";

const bible: CharacterBible = {
  bibleId: "owner-approved-murugan-bible-v1", status: "OWNER_APPROVED",
  murugan: "Murugan identity", vel: "single Vel", peacock: "single peacock",
  style: "approved style", negativeConstraints: ["no watermark"],
};
const selection: MuruganAnchorSelection = {
  murugan: { referenceId: 11, assetId: 101, label: "Murugan" },
  vel: { referenceId: 12, assetId: 102, label: "Vel" },
  peacock: { referenceId: 13, assetId: 103, label: "Peacock" },
};
const rows: ApprovedAnchorReferenceRow[] = [
  { referenceId: 11, assetId: 101, workspaceId: 7, creatorProjectId: 8, kind: "CHARACTER", label: "Murugan", referenceImmutable: 1, approvedAt: new Date(), assetType: "REFERENCE", assetImmutable: 1, reviewDecision: "APPROVED", mimeType: "image/png", checksumSha256: "a".repeat(64), storageKey: "creator/7/8/references/murugan" },
  { referenceId: 12, assetId: 102, workspaceId: 7, creatorProjectId: 8, kind: "OBJECT", label: "Vel", referenceImmutable: 1, approvedAt: new Date(), assetType: "REFERENCE", assetImmutable: 1, reviewDecision: "APPROVED", mimeType: "image/jpeg", checksumSha256: "b".repeat(64), storageKey: "creator/7/8/references/vel" },
  { referenceId: 13, assetId: 103, workspaceId: 7, creatorProjectId: 8, kind: "OBJECT", label: "Peacock", referenceImmutable: 1, approvedAt: new Date(), assetType: "REFERENCE", assetImmutable: 1, reviewDecision: "APPROVED", mimeType: "image/webp", checksumSha256: "c".repeat(64), storageKey: "creator/7/8/references/peacock" },
];
const lines: ApprovedLine[] = [
  { lineId: "L1", startMs: 0, endMs: 5000, subject: "Murugan", action: "stands calmly", environment: "temple", elements: ["murugan"] },
  { lineId: "L2", startMs: 5000, endMs: 10000, subject: "Vel and peacock", action: "appear", environment: "temple", elements: ["vel", "peacock"] },
  { lineId: "L3", startMs: 10000, endMs: 15000, subject: "Murugan with Vel and peacock", action: "stands", environment: "temple", elements: ["murugan", "vel", "peacock"] },
];
const plan = buildScenePlan({ projectName: "Murugan", audio: { sha256: "d".repeat(64), durationMs: 15000 }, lines, referenceAssetIds: ["101", "102", "103"], bible });
const input = { plan, workspaceId: 7, creatorProjectId: 8, selection, rows };

describe("Murugan approved anchor binding", () => {
  it("binds distinct first-seen element anchors to approved persisted asset IDs", () => {
    const graph = bindApprovedMuruganAnchors(input);
    expect(graph.referenceAssetIds).toEqual([101, 102, 103]);
    expect(graph.bindingId).toMatch(/^[0-9a-f]{64}$/);
    expect(graph.shots[0].anchors.murugan).toMatchObject({ assetId: 101, anchorShotId: "SHOT-001" });
    expect(graph.shots[1].anchors.vel).toMatchObject({ assetId: 102, anchorShotId: "SHOT-002" });
    expect(graph.shots[1].anchors.peacock).toMatchObject({ assetId: 103, anchorShotId: "SHOT-002" });
    expect(graph.shots[2].anchors.murugan?.anchorShotId).toBe("SHOT-001");
    expect(graph.shots[2].anchors.vel?.anchorShotId).toBe("SHOT-002");
    expect(graph.shots[2].anchors.peacock?.anchorShotId).toBe("SHOT-002");
  });
  it("rejects cross-workspace or cross-project asset references", () => {
    expect(() => bindApprovedMuruganAnchors({ ...input, rows: [{ ...rows[0], workspaceId: 9 }, ...rows.slice(1)] })).toThrow("MURUGAN_ANCHOR_SCOPE_MISMATCH:murugan");
    expect(() => bindApprovedMuruganAnchors({ ...input, rows: [{ ...rows[0], creatorProjectId: 9 }, ...rows.slice(1)] })).toThrow("MURUGAN_ANCHOR_SCOPE_MISMATCH:murugan");
  });
  it("rejects missing, rejected, mutable, unapproved and corrupt reference assets", () => {
    expect(() => bindApprovedMuruganAnchors({ ...input, rows: rows.slice(1) })).toThrow("MURUGAN_ANCHOR_REFERENCE_NOT_FOUND:murugan");
    for (const change of [{ reviewDecision: "REJECTED" }, { assetImmutable: 0 }, { referenceImmutable: 0 }, { approvedAt: null }]) {
      expect(() => bindApprovedMuruganAnchors({ ...input, rows: [{ ...rows[0], ...change }, ...rows.slice(1)] })).toThrow("MURUGAN_ANCHOR_REFERENCE_NOT_APPROVED:murugan");
    }
    expect(() => bindApprovedMuruganAnchors({ ...input, rows: [{ ...rows[0], checksumSha256: "bad" }, ...rows.slice(1)] })).toThrow("MURUGAN_ANCHOR_REFERENCE_CORRUPT:murugan");
  });
  it("rejects substituted identity labels and asset kinds", () => {
    expect(() => bindApprovedMuruganAnchors({ ...input, rows: [{ ...rows[0], label: "Other" }, ...rows.slice(1)] })).toThrow("MURUGAN_ANCHOR_IDENTITY_MISMATCH:murugan");
    expect(() => bindApprovedMuruganAnchors({ ...input, rows: [{ ...rows[0], kind: "OBJECT" }, ...rows.slice(1)] })).toThrow("MURUGAN_ANCHOR_IDENTITY_MISMATCH:murugan");
  });
  it("rejects reference substitutions not included in the immutable plan identity set", () => {
    expect(() => bindApprovedMuruganAnchors({ ...input, selection: { ...selection, murugan: { referenceId: 11, assetId: 999, label: "Murugan" } } })).toThrow("MURUGAN_ANCHOR_PLAN_ASSET_MISMATCH:murugan");
    expect(() => bindApprovedMuruganAnchors({ ...input, selection: { ...selection, peacock: selection.vel } })).toThrow("MURUGAN_ANCHOR_REFERENCE_REUSED");
  });
  it("rejects tampered shot graphs and missing anchors", () => {
    expect(() => bindApprovedMuruganAnchors({ ...input, plan: { ...plan, shots: plan.shots.map((shot, i) => i === 2 ? { ...shot, referenceFromShotByElement: { murugan: "SHOT-002", vel: "SHOT-002", peacock: "SHOT-002" } } : shot) } })).toThrow("MURUGAN_ANCHOR_GRAPH_MISMATCH:SHOT-003:murugan");
    expect(() => bindApprovedMuruganAnchors({ ...input, selection: { murugan: selection.murugan, vel: selection.vel } })).toThrow("MURUGAN_ANCHOR_SELECTION_MISSING:peacock");
  });
  it("changes the binding fingerprint when an approved asset checksum changes", () => {
    const first = bindApprovedMuruganAnchors(input);
    const second = bindApprovedMuruganAnchors({ ...input, rows: [{ ...rows[0], checksumSha256: "e".repeat(64) }, ...rows.slice(1)] });
    expect(first.planId).toBe(second.planId);
    expect(first.bindingId).not.toBe(second.bindingId);
  });
  it("requires owner-approved bible before binding", () => {
    expect(() => bindApprovedMuruganAnchors({ ...input, plan: { ...plan, bible: { ...plan.bible, status: "DRAFT_FOR_OWNER_REVIEW" } } })).toThrow("MURUGAN_ANCHOR_BIBLE_NOT_APPROVED");
  });
});
