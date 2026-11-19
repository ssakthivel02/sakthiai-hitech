import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { inspectCreatorRecordedStages } from "./recordedStageReconciliation";

const provider = "google-veo";
const jobId = "veo-job-59";
const checksum = "c".repeat(64);
const hash = createHash("sha256").update(provider).update("\0").update(jobId).digest("hex").slice(0, 32);
const nowMs = Date.parse("2026-11-11T02:00:00Z");
const makeStage = (generationId = 7) => ({
  workspaceId: 5, creatorProjectId: 6, generationId, providerJobId: jobId,
  leaseUntil: new Date(nowMs - 1),
  stagedStorageKey: `creator/5/6/staged/generation-${generationId}/job-${hash}/${checksum}.mp4`,
  stagedChecksumSha256: checksum, stagedByteSize: 12, stagedMimeType: "video/mp4",
});
const makeEvidence = (stage = makeStage()) => ({
  generation: { id: stage.generationId, workspaceId: 5, creatorProjectId: 6,
    provider, status: "RUNNING", outputAssetId: null },
  latestJob: { workspaceId: 5, creatorProjectId: 6, generationId: stage.generationId,
    provider, providerJobId: jobId, status: "SUCCEEDED" },
  lease: stage, assets: [],
});
const deps = (stage = makeStage()) => ({
  loadPage: vi.fn(async () => [stage]),
  loadEvidence: vi.fn(async () => makeEvidence(stage)),
  verify: vi.fn(async (_key: string, _size: number, _sha: string) => undefined),
  isMissing: (error: unknown) => (error as { name?: string })?.name === "NoSuchKey",
});

describe("read-only DB-first recorded-stage reconciliation", () => {
  it("reports a confirmed missing S3 object after validating expired-lease ownership", async () => {
    const d = deps();
    d.verify.mockImplementationOnce(async () => { throw { name: "NoSuchKey" }; });
    const result = await inspectCreatorRecordedStages({ workspaceId: 5, nowMs }, d);
    expect(result.findings).toEqual([{
      generationId: 7, key: makeStage().stagedStorageKey, finding: "MISSING_OBJECT",
    }]);
    expect(result.complete).toBe(true);
    expect(d.verify).toHaveBeenCalledWith(makeStage().stagedStorageKey, 12, checksum);
  });

  it("verifies an existing expired stage and marks it recoverable", async () => {
    const d = deps();
    const result = await inspectCreatorRecordedStages({ workspaceId: 5, nowMs }, d);
    expect(result.findings[0].finding).toBe("RECOVERABLE_STAGE");
    expect(d.verify).toHaveBeenCalledOnce();
  });

  it("does not probe or call a missing object while an upload lease is active", async () => {
    const stage = makeStage(); stage.leaseUntil = new Date(nowMs + 30_000);
    const d = deps(stage);
    const result = await inspectCreatorRecordedStages({ workspaceId: 5, nowMs }, d);
    expect(result.findings[0].finding).toBe("ACTIVE_UPLOAD");
    expect(d.verify).not.toHaveBeenCalled();
  });

  it("never mistakes a timeout or checksum failure for a missing object", async () => {
    const d = deps();
    d.verify.mockImplementationOnce(async () => { throw new Error("timeout"); });
    const result = await inspectCreatorRecordedStages({ workspaceId: 5, nowMs }, d);
    expect(result.findings[0].finding).toBe("STORAGE_UNVERIFIED");
  });

  it("fails closed on superseded jobs and malformed stage identity before storage access", async () => {
    const d = deps();
    d.loadEvidence.mockImplementationOnce(async () => ({
      ...makeEvidence(), latestJob: { ...makeEvidence().latestJob, providerJobId: "superseded" },
    }));
    const result = await inspectCreatorRecordedStages({ workspaceId: 5, nowMs }, d);
    expect(result.findings[0].finding).toBe("OWNERSHIP_CONFLICT");
    expect(d.verify).not.toHaveBeenCalled();
    const invalid = makeStage(); invalid.stagedStorageKey = "creator/5/6/staged/bad";
    const bad = deps(invalid);
    const malformed = await inspectCreatorRecordedStages({ workspaceId: 5, nowMs }, bad);
    expect(malformed.findings[0].finding).toBe("INVALID_STAGE_KEY");
    expect(bad.loadEvidence).not.toHaveBeenCalled();
  });

  it("preserves a continuation cursor when the DB page is incomplete", async () => {
    const first = makeStage(7), second = makeStage(8);
    const d = deps(first);
    d.loadPage.mockImplementationOnce(async () => [first, second]);
    const result = await inspectCreatorRecordedStages({ workspaceId: 5, maxRows: 1, nowMs }, d);
    expect(result).toMatchObject({
      scannedRecords: 1, complete: false, nextAfterGenerationId: 7,
    });
    expect(d.loadPage).toHaveBeenCalledWith(5, 0, 2);
    expect(d.loadEvidence).toHaveBeenCalledTimes(1);
  });

  it("rejects unsorted, duplicate and cross-tenant DB results", async () => {
    const d = deps();
    d.loadPage.mockImplementationOnce(async () => [makeStage(7), makeStage(7)]);
    await expect(inspectCreatorRecordedStages({ workspaceId: 5, maxRows: 2 }, d))
      .rejects.toThrow("CREATOR_RECORDED_STAGE_PAGE_SCOPE_OR_ORDER_INVALID");
    const other = makeStage(); other.workspaceId = 6;
    const wrong = deps(other);
    await expect(inspectCreatorRecordedStages({ workspaceId: 5 }, wrong))
      .rejects.toThrow("CREATOR_RECORDED_STAGE_PAGE_SCOPE_OR_ORDER_INVALID");
  });

  it("rejects mismatched DB evidence and invalid unbounded requests", async () => {
    const d = deps();
    d.loadEvidence.mockImplementationOnce(async () => ({
      ...makeEvidence(), lease: { ...makeStage(), generationId: 999 },
    }));
    await expect(inspectCreatorRecordedStages({ workspaceId: 5 }, d))
      .rejects.toThrow("CREATOR_RECORDED_STAGE_EVIDENCE_SCOPE_MISMATCH");
    await expect(inspectCreatorRecordedStages({ workspaceId: 0 }, d))
      .rejects.toThrow("CREATOR_RECORDED_STAGE_WORKSPACE_INVALID");
    await expect(inspectCreatorRecordedStages({ workspaceId: 5, maxRows: 101 }, d))
      .rejects.toThrow("CREATOR_RECORDED_STAGE_LIMIT_INVALID");
    await expect(inspectCreatorRecordedStages({ workspaceId: 5, afterGenerationId: -1 }, d))
      .rejects.toThrow("CREATOR_RECORDED_STAGE_CURSOR_INVALID");
  });
});
