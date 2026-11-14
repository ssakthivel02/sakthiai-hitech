import { describe, expect, it, vi } from "vitest";
import {
  runCreatorRenderQueueBatch,
  type QueuedCreatorRenderRow,
} from "./renderAsyncWorker";

const fingerprint = "a".repeat(64);
const row: QueuedCreatorRenderRow = {
  claimId: 10, exportId: 11, workspaceId: 12,
  creatorProjectId: 13, timelineId: 14,
  mode: "MASTER_CANDIDATE", fingerprint,
  parametersJson: JSON.stringify({
    intentFingerprint: fingerprint, mode: "MASTER_CANDIDATE",
    rendererVersion: "ffmpeg-v1", fontFamily: "Noto Sans Tamil",
    derivativeOfRenderAssetId: null,
  }),
};
const enabled = { CREATOR_ASYNC_RENDER_WORKER_ENABLED: "true" };
const disabled = { CREATOR_ASYNC_RENDER_WORKER_ENABLED: "false" };

describe("bounded Creator render queue consumer", () => {
  it("is default-off and never scans the database when disabled", async () => {
    const load = vi.fn(async () => [row]);
    await expect(runCreatorRenderQueueBatch(1, { env: disabled, load }))
      .rejects.toThrow("CREATOR_RENDER_ASYNC_WORKER_DISABLED");
    expect(load).not.toHaveBeenCalled();
  });

  it("uses the existing queued identity without a reservation lease token", async () => {
    const dispatch = vi.fn(async () => ({ reviewDecision: "PENDING" }));
    const result = await runCreatorRenderQueueBatch(1, {
      env: enabled, load: async () => [row], dispatch,
    });
    expect(result).toMatchObject({ attempted: 1, dispatched: 1, skipped: 0, failed: 0 });
    expect(dispatch).toHaveBeenCalledWith(
      { workspaceId: 12, creatorProjectId: 13, timelineId: 14 },
      { rendererVersion: "ffmpeg-v1", fontFamily: "Noto Sans Tamil" },
      { claimId: 10, exportId: 11, fingerprint },
    );
  });

  it("deduplicates scanned claim IDs within the bounded pass", async () => {
    const dispatch = vi.fn(async () => ({}));
    const result = await runCreatorRenderQueueBatch(3, {
      env: enabled, load: async () => [row, row, row], dispatch,
    });
    expect(result.attempted).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("never launches media when the persisted snapshot differs", async () => {
    const dispatch = vi.fn(async () => ({}));
    const result = await runCreatorRenderQueueBatch(1, {
      env: enabled, load: async () => [{
        ...row, parametersJson: JSON.stringify({
          intentFingerprint: "b".repeat(64), mode: "MASTER_CANDIDATE",
          rendererVersion: "ffmpeg-v1", fontFamily: "Noto Sans Tamil",
        }),
      }], dispatch,
    });
    expect(result).toMatchObject({ dispatched: 0, failed: 1 });
    expect(result.results[0].code).toBe("CREATOR_RENDER_QUEUE_SNAPSHOT_DRIFT");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("reports competing acquisition without retrying or quarantining another worker", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("CREATOR_RENDER_DISPATCH_WORKER_NOT_ACQUIRED");
    });
    const result = await runCreatorRenderQueueBatch(1, {
      env: enabled, load: async () => [row], dispatch,
    });
    expect(result).toMatchObject({ attempted: 1, dispatched: 0, skipped: 1, failed: 0 });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not retry failed renders or leak internal errors", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("S3 credentials: private data");
    });
    const result = await runCreatorRenderQueueBatch(1, {
      env: enabled, load: async () => [row], dispatch,
    });
    expect(result).toMatchObject({ dispatched: 0, failed: 1 });
    expect(result.results[0].code).toBe("CREATOR_RENDER_QUEUE_EXECUTION_FAILED");
    expect(JSON.stringify(result)).not.toContain("private data");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid batch size before scanning", async () => {
    const load = vi.fn(async () => [row]);
    await expect(runCreatorRenderQueueBatch(9, { env: enabled, load }))
      .rejects.toThrow("CREATOR_RENDER_QUEUE_BATCH_LIMIT_INVALID");
    expect(load).not.toHaveBeenCalled();
  });

  it("derives vertical source identity from persisted snapshot only", async () => {
    const dispatch = vi.fn(async () => ({}));
    const derivative = {
      ...row, mode: "VERTICAL_DERIVATIVE" as const,
      parametersJson: JSON.stringify({
        intentFingerprint: fingerprint, mode: "VERTICAL_DERIVATIVE",
        rendererVersion: "ffmpeg-v1", fontFamily: "Noto Sans Tamil",
        derivativeOfRenderAssetId: 55,
      }),
    };
    await runCreatorRenderQueueBatch(1, {
      env: enabled, load: async () => [derivative], dispatch,
    });
    expect(dispatch).toHaveBeenCalledWith(
      { workspaceId: 12, creatorProjectId: 13, timelineId: 14, verticalDerivativeOf: 55 },
      expect.anything(), expect.anything(),
    );
  });
  it("does not scan when shutdown is already requested", async () => {
    const controller = new AbortController();
    controller.abort();
    const load = vi.fn(async () => [row]);
    await expect(runCreatorRenderQueueBatch(1, {
      env: enabled, load, abortSignal: controller.signal,
    })).rejects.toThrow("CREATOR_RENDER_WORKER_STOP_REQUESTED");
    expect(load).not.toHaveBeenCalled();
  });

  it("does not dispatch a claim if shutdown happens during discovery", async () => {
    const controller = new AbortController();
    const dispatch = vi.fn(async () => ({}));
    const result = await runCreatorRenderQueueBatch(1, {
      env: enabled, abortSignal: controller.signal,
      load: async () => { controller.abort(); return [row]; }, dispatch,
    });
    expect(result).toMatchObject({
      attempted: 0, dispatched: 0, failed: 0, interrupted: true,
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("stops before a second claim after supervised shutdown", async () => {
    const controller = new AbortController();
    const second = { ...row, claimId: 20, exportId: 21 };
    const dispatch = vi.fn(async () => {
      controller.abort();
      return { reviewDecision: "PENDING" };
    });
    const result = await runCreatorRenderQueueBatch(2, {
      env: enabled, abortSignal: controller.signal,
      load: async () => [row, second], dispatch,
    });
    expect(result).toMatchObject({
      attempted: 1, dispatched: 1, failed: 0, interrupted: true,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("reports interruption even when the final claim finishes as shutdown arrives", async () => {
    const controller = new AbortController();
    const result = await runCreatorRenderQueueBatch(1, {
      env: enabled, abortSignal: controller.signal,
      load: async () => [row],
      dispatch: async () => { controller.abort(); return {}; },
    });
    expect(result).toMatchObject({
      attempted: 1, dispatched: 1, interrupted: true,
    });
  });

});
