import { describe, expect, it, vi } from "vitest";
import type { CreatorRenderIntentInput } from "./renderIntent";
import type { CreatorRenderDispatchDependencies } from "./renderDispatch";
import { dispatchReservedCreatorRender } from "./renderDispatch";

const fingerprint = "a".repeat(64);
const input = { workspaceId: 1, creatorProjectId: 2, timelineId: 3 };
const config = { rendererVersion: "ffmpeg-v1", fontFamily: "Noto Sans Tamil" };
const intent: CreatorRenderIntentInput = {
  ...input,
  mode: "MASTER_CANDIDATE",
  audioMaster: { assetId: 11, checksumSha256: "b".repeat(64), durationMs: 1000 },
  visuals: [{
    assetId: 12, checksumSha256: "c".repeat(64), assetType: "IMAGE",
    shotId: 13, startMs: 0, endMs: 1000, track: 1, sortOrder: 0,
  }],
  captions: [{ startMs: 0, endMs: 1000, text: "முருகா", language: "ta", locked: true }],
  output: {
    width: 1920, height: 1080, fps: 24, fit: "pad",
    rendererVersion: "ffmpeg-v1", fontFamily: "Noto Sans Tamil",
  },
};
const rendered = {
  storageKey: "creator/1/2/renders/timeline-3/export-22.mp4",
  url: "https://storage.invalid/render",
  checksumSha256: "d".repeat(64),
  byteSize: 1234, durationMs: 1000, frameCount: 24,
  visualAssetIds: [12], renderer: "ffmpeg" as const,
  width: 1920, height: 1080, fps: 24,
};
const reservation = {
  created: true as const, claimId: 21, exportId: 22,
  leaseToken: "00000000-0000-4000-8000-000000000001",
  state: "RUNNING" as const, fingerprint,
};

function setup() {
  const reserve = vi.fn(async () => reservation);
  const read = vi.fn(async () => ({ intent, fingerprint }));
  const resolveMedia = vi.fn(async () => ({
    audioSourceUrl: "https://storage.invalid/audio",
    visualItems: [{
      assetId: 12, shotId: 13, assetType: "IMAGE" as const,
      sourceUrl: "https://storage.invalid/image", startMs: 0,
      endMs: 1000, track: 1, sortOrder: 0, approved: true,
    }],
  }));
  const render = vi.fn(async () => rendered);
  const workerLeaseToken = "00000000-0000-4000-8000-000000000002";
  const acquired = {
    claimId: reservation.claimId,
    exportId: reservation.exportId,
    scope: { ...input, mode: "MASTER_CANDIDATE" as const, fingerprint },
    leaseToken: workerLeaseToken,
  };
  const acquireQueuedExport = vi.fn(async () => acquired);
  const heartbeat = vi.fn(async () => true);
  const markUnknown = vi.fn(async () => true);
  const finalizeVerifiedExport = vi.fn(async () => ({
    assetId: 44, exportId: 22, reviewDecision: "PENDING" as const,
  }));
  const deps: CreatorRenderDispatchDependencies = {
    reserve, read, resolveMedia, render,
    claims: { acquireQueuedExport, heartbeat, markUnknown, finalizeVerifiedExport },
    leaseSeconds: 10, heartbeatIntervalMs: 100,
  };
  return { deps, reserve, read, resolveMedia, render, acquireQueuedExport,
    workerLeaseToken, heartbeat, markUnknown, finalizeVerifiedExport };
}

describe("Creator render dispatch staging", () => {
  it("never starts work or exposes a token for a duplicate reservation", async () => {
    const x = setup();
    // A duplicate response does not carry a lease token; exercise the real union shape.
    x.deps.reserve = async () => ({
      created: false, claimId: 21, exportId: 22, outputAssetId: null,
      state: "RUNNING", fingerprint,
    });
    const result = await dispatchReservedCreatorRender(input, config, x.deps);
    expect(result.dispatched).toBe(false);
    expect(x.acquireQueuedExport).not.toHaveBeenCalled();
    expect(x.read).not.toHaveBeenCalled();
    expect(x.render).not.toHaveBeenCalled();
    expect(x.heartbeat).not.toHaveBeenCalled();
  });

  it("renders once, checks the snapshot twice, then finalizes under its lease", async () => {
    const x = setup();
    const result = await dispatchReservedCreatorRender(input, config, x.deps);
    expect(result).toMatchObject({
      claimId: 21, exportId: 22, assetId: 44, dispatched: true, reviewDecision: "PENDING",
    });
    expect(x.acquireQueuedExport).toHaveBeenCalledExactlyOnceWith({
      ...input, claimId: reservation.claimId,
    }, 10);
    expect(x.read).toHaveBeenCalledTimes(2);
    expect(x.resolveMedia).toHaveBeenCalledTimes(1);
    expect(x.render).toHaveBeenCalledTimes(1);
    expect(x.heartbeat).toHaveBeenCalledTimes(2);
    expect(x.heartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ fingerprint }), x.workerLeaseToken, 10,
    );
    expect(x.heartbeat).not.toHaveBeenCalledWith(
      expect.anything(), reservation.leaseToken, 10,
    );
    expect(x.finalizeVerifiedExport).toHaveBeenCalledTimes(1);
    expect(x.finalizeVerifiedExport).toHaveBeenCalledWith(
      expect.objectContaining({ fingerprint }), x.workerLeaseToken, 22,
      rendered, input, config, undefined,
    );
    expect(x.markUnknown).not.toHaveBeenCalled();
  });

  it("does not start FFmpeg or quarantine another worker when acquisition is denied", async () => {
    const x = setup();
    x.acquireQueuedExport.mockResolvedValueOnce(null as never);
    await expect(dispatchReservedCreatorRender(input, config, x.deps))
      .rejects.toThrow("CREATOR_RENDER_DISPATCH_WORKER_NOT_ACQUIRED");
    expect(x.read).not.toHaveBeenCalled();
    expect(x.resolveMedia).not.toHaveBeenCalled();
    expect(x.render).not.toHaveBeenCalled();
    expect(x.heartbeat).not.toHaveBeenCalled();
    expect(x.markUnknown).not.toHaveBeenCalled();
  });

  it("fails closed and quarantines a mismatched acquired export before media access", async () => {
    const x = setup();
    x.acquireQueuedExport.mockResolvedValueOnce({
      claimId: reservation.claimId, exportId: 999,
      scope: { ...input, mode: "MASTER_CANDIDATE", fingerprint },
      leaseToken: x.workerLeaseToken,
    });
    await expect(dispatchReservedCreatorRender(input, config, x.deps))
      .rejects.toThrow("CREATOR_RENDER_DISPATCH_ACQUISITION_SCOPE_DRIFT");
    expect(x.read).not.toHaveBeenCalled();
    expect(x.render).not.toHaveBeenCalled();
    expect(x.markUnknown).toHaveBeenCalledWith(
      expect.objectContaining({ fingerprint }), x.workerLeaseToken,
    );
  });

  it("permits only one competing dispatcher to launch FFmpeg", async () => {
    const x = setup();
    // Even if a reservation service incorrectly reports created:true twice,
    // the atomic worker acquisition remains the final execution fence.
    x.acquireQueuedExport.mockResolvedValueOnce({
      claimId: reservation.claimId, exportId: reservation.exportId,
      scope: { ...input, mode: "MASTER_CANDIDATE", fingerprint },
      leaseToken: x.workerLeaseToken,
    }).mockResolvedValueOnce(null as never);
    const results = await Promise.allSettled([
      dispatchReservedCreatorRender(input, config, x.deps),
      dispatchReservedCreatorRender(input, config, x.deps),
    ]);
    expect(results.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(x => x.status === "rejected")).toHaveLength(1);
    expect(x.render).toHaveBeenCalledTimes(1);
    expect(x.finalizeVerifiedExport).toHaveBeenCalledTimes(1);
    expect(x.markUnknown).not.toHaveBeenCalled();
  });

  it("quarantines source drift before signing media or launching FFmpeg", async () => {
    const x = setup();
    x.read.mockResolvedValueOnce({ intent, fingerprint: "e".repeat(64) });
    await expect(dispatchReservedCreatorRender(input, config, x.deps))
      .rejects.toThrow("CREATOR_RENDER_DISPATCH_SOURCE_CHANGED");
    expect(x.resolveMedia).not.toHaveBeenCalled();
    expect(x.render).not.toHaveBeenCalled();
    expect(x.markUnknown).toHaveBeenCalledTimes(1);
  });

  it("quarantines a lost lease before running FFmpeg", async () => {
    const x = setup();
    x.heartbeat.mockResolvedValueOnce(false);
    await expect(dispatchReservedCreatorRender(input, config, x.deps))
      .rejects.toThrow("CREATOR_RENDER_DISPATCH_LEASE_LOST");
    expect(x.render).not.toHaveBeenCalled();
    expect(x.finalizeVerifiedExport).not.toHaveBeenCalled();
    expect(x.markUnknown).toHaveBeenCalledTimes(1);
  });

  it("quarantines an ambiguous render error without retrying", async () => {
    const x = setup();
    x.render.mockRejectedValueOnce(new Error("FFMPEG_FAILURE"));
    await expect(dispatchReservedCreatorRender(input, config, x.deps))
      .rejects.toThrow("FFMPEG_FAILURE");
    expect(x.render).toHaveBeenCalledTimes(1);
    expect(x.markUnknown).toHaveBeenCalledTimes(1);
    expect(x.finalizeVerifiedExport).not.toHaveBeenCalled();
  });

  it("quarantines Tamil-caption drift after rendering but before finalization", async () => {
    const x = setup();
    x.read.mockResolvedValueOnce({ intent, fingerprint })
      .mockResolvedValueOnce({ intent, fingerprint: "e".repeat(64) });
    await expect(dispatchReservedCreatorRender(input, config, x.deps))
      .rejects.toThrow("CREATOR_RENDER_DISPATCH_SOURCE_CHANGED");
    expect(x.render).toHaveBeenCalledTimes(1);
    expect(x.finalizeVerifiedExport).not.toHaveBeenCalled();
    expect(x.markUnknown).toHaveBeenCalledTimes(1);
  });

  it("rejects noncanonical Tamil font before any database reservation", async () => {
    const x = setup();
    await expect(dispatchReservedCreatorRender(input, { ...config, fontFamily: "Arial" }, x.deps))
      .rejects.toThrow("CREATOR_RENDER_DISPATCH_FONT_IDENTITY_INVALID");
    expect(x.reserve).not.toHaveBeenCalled();
  });
});
