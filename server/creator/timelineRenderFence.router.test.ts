import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

/**
 * Real tRPC protected router, mocked dispatch boundary. No storage, MySQL,
 * paid generation, provider, rendering or live service is ever contacted.
 */
const mocks = vi.hoisted(() => ({
  fencedDispatch: vi.fn(),
  rawExport: vi.fn(),
  requireOwner: vi.fn(),
}));
vi.mock("./renderDispatch", async importOriginal => ({
  ...(await importOriginal<typeof import("./renderDispatch")>()),
  dispatchReservedCreatorRender: mocks.fencedDispatch,
}));
vi.mock("./renderService", async importOriginal => ({
  ...(await importOriginal<typeof import("./renderService")>()),
  executeCreatorTimelineExport: mocks.rawExport,
}));
vi.mock("./paidGeneration", async importOriginal => ({
  ...(await importOriginal<typeof import("./paidGeneration")>()),
  requireCreatorWorkspaceOwner: mocks.requireOwner,
}));

import { creatorTimelineRouter } from "./timelineRouter";
import type { TrpcContext } from "../_core/context";

function caller(userId: number | null) {
  const now = new Date();
  const user = userId === null ? null : {
    id: userId, openId: "creator-render-test-" + userId,
    name: "creator-render-test", email: "test@example.invalid",
    loginMethod: "google" as const, role: "user" as const,
    createdAt: now, updatedAt: now, lastSignedIn: now,
  };
  return creatorTimelineRouter.createCaller({
    req: {} as TrpcContext["req"],
    res: { headersSent: false, setHeader: vi.fn() } as unknown as TrpcContext["res"],
    requestId: "creator-render-fence-regression",
    user,
  } as TrpcContext);
}
const input = { workspaceId: 7, creatorProjectId: 11, timelineId: 13, confirmCandidateOnly: true as const };
const derivative = { workspaceId: 7, creatorProjectId: 11, timelineId: 13, finalMasterAssetId: 17 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireOwner.mockImplementation(async (userId: number, workspaceId: number) => {
    if (userId !== 501 || workspaceId !== 7) {
      throw new TRPCError({ code: "FORBIDDEN", message: "CREATOR_WORKSPACE_OWNER_REQUIRED" });
    }
  });
  mocks.fencedDispatch.mockResolvedValue({ dispatched: true, claimId: 61, exportId: 62, assetId: 63 });
  mocks.rawExport.mockImplementation(() => { throw new Error("UNFENCED_RENDER_MUST_NEVER_BE_CALLED"); });
});
afterEach(() => vi.unstubAllEnvs());

describe("Creator legacy render endpoints never bypass the durable claim", () => {
  it.each([undefined, "", "false", "TRUE", "1", "yes"])(
    "flag %s: both master entrypoints fail closed even for owner, no dispatch",
    async value => {
      vi.stubEnv("CREATOR_FENCED_RENDER_ENABLED", value as unknown as string);
      const api = caller(501);
      await expect(api.renderCandidate(input)).rejects.toMatchObject({
        code: "PRECONDITION_FAILED", message: "CREATOR_FENCED_RENDER_DISABLED",
      });
      await expect(api.renderFencedCandidate(input)).rejects.toMatchObject({
        code: "PRECONDITION_FAILED", message: "CREATOR_FENCED_RENDER_DISABLED",
      });
      expect(mocks.fencedDispatch).not.toHaveBeenCalled();
      expect(mocks.rawExport).not.toHaveBeenCalled();
    },
  );

  it("owner-only: member cannot activate either path with the feature switch enabled", async () => {
    vi.stubEnv("CREATOR_FENCED_RENDER_ENABLED", "true");
    const api = caller(502);
    await expect(api.renderCandidate(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(api.renderFencedCandidate(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(api.renderVerticalDerivative(derivative)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.fencedDispatch).not.toHaveBeenCalled();
    expect(mocks.rawExport).not.toHaveBeenCalled();
  });

  it("authorized alias uses the identical fenced claim dispatcher and never leaks a lease token", async () => {
    vi.stubEnv("CREATOR_FENCED_RENDER_ENABLED", "true");
    const api = caller(501);
    const submitted = await api.renderCandidate(input);
    expect(submitted).toMatchObject({
      dispatched: true, claimId: 61, exportId: 62, assetId: 63,
      reviewDecision: "PENDING", finalMaster: false, publishApproved: false,
    });
    expect(JSON.stringify(submitted)).not.toContain("leaseToken");
    expect(mocks.fencedDispatch).toHaveBeenCalledTimes(1);
    expect(mocks.fencedDispatch).toHaveBeenCalledWith({
      workspaceId: 7, creatorProjectId: 11, timelineId: 13,
    }, {
      rendererVersion: "ffmpeg-v1", fontFamily: expect.any(String),
    });
    mocks.fencedDispatch.mockResolvedValueOnce({
      dispatched: false, claimId: 61, exportId: 62, state: "RUNNING",
    });
    const duplicate = await api.renderFencedCandidate(input);
    expect(duplicate).toMatchObject({
      dispatched: false, claimId: 61, exportId: 62,
      state: "RUNNING", nextGate: "EXISTING_RENDER_CLAIM",
    });
    expect(JSON.stringify(duplicate)).not.toContain("leaseToken");
    expect(mocks.rawExport).not.toHaveBeenCalled();
  });

  it("vertical derivative is separately default-off even when master rendering is enabled", async () => {
    vi.stubEnv("CREATOR_FENCED_RENDER_ENABLED", "true");
    vi.stubEnv("CREATOR_FENCED_DERIVATIVE_ENABLED", undefined as unknown as string);
    await expect(caller(501).renderVerticalDerivative(derivative)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED", message: "CREATOR_FENCED_DERIVATIVE_DISABLED",
    });
    expect(mocks.rawExport).not.toHaveBeenCalled();
    expect(mocks.fencedDispatch).not.toHaveBeenCalled();
  });

  it("owner-only 9:16 dispatch requires both flags and binds the final master through the fenced claim", async () => {
    vi.stubEnv("CREATOR_FENCED_RENDER_ENABLED", "true");
    vi.stubEnv("CREATOR_FENCED_DERIVATIVE_ENABLED", "true");
    const result = await caller(501).renderVerticalDerivative(derivative);
    expect(result).toMatchObject({
      dispatched: true, claimId: 61, exportId: 62, assetId: 63,
      aspectRatio: "9:16", derivative: true, humanCropCheckRequired: true,
      reviewDecision: "PENDING", finalMaster: false, publishApproved: false,
    });
    expect(mocks.fencedDispatch).toHaveBeenCalledTimes(1);
    expect(mocks.fencedDispatch).toHaveBeenCalledWith({
      workspaceId: 7, creatorProjectId: 11, timelineId: 13, verticalDerivativeOf: 17,
    }, { rendererVersion: "ffmpeg-v1", fontFamily: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain("leaseToken");
    expect(mocks.rawExport).not.toHaveBeenCalled();
  });

  it("a duplicate 9:16 render claim reveals only safe read-only status", async () => {
    vi.stubEnv("CREATOR_FENCED_RENDER_ENABLED", "true");
    vi.stubEnv("CREATOR_FENCED_DERIVATIVE_ENABLED", "true");
    mocks.fencedDispatch.mockResolvedValueOnce({ dispatched: false, claimId: 61, exportId: 62, state: "RUNNING" });
    const result = await caller(501).renderVerticalDerivative(derivative);
    expect(result).toMatchObject({
      dispatched: false, claimId: 61, exportId: 62, state: "RUNNING",
      aspectRatio: "9:16", derivative: true, humanCropCheckRequired: true,
      nextGate: "EXISTING_RENDER_CLAIM", finalMaster: false, publishApproved: false,
    });
    expect(JSON.stringify(result)).not.toContain("leaseToken");
    expect(mocks.rawExport).not.toHaveBeenCalled();
  });

  it("anonymous callers never invoke the dispatcher", async () => {
    vi.stubEnv("CREATOR_FENCED_RENDER_ENABLED", "true");
    await expect(caller(null).renderCandidate(input)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller(null).renderVerticalDerivative(derivative)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(mocks.rawExport).not.toHaveBeenCalled();
    expect(mocks.fencedDispatch).not.toHaveBeenCalled();
  });
});
