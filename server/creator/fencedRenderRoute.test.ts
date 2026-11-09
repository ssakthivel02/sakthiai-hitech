import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import type { TrpcContext } from "../_core/context";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  owner: vi.fn(),
}));

vi.mock("./renderDispatch", () => ({
  dispatchReservedCreatorRender: mocks.dispatch,
}));
vi.mock("./paidGeneration", async importOriginal => ({
  ...(await importOriginal<typeof import("./paidGeneration")>()),
  requireCreatorWorkspaceOwner: mocks.owner,
}));

import { creatorTimelineRouter } from "./timelineRouter";

const input = { workspaceId: 7, creatorProjectId: 12, timelineId: 15, confirmCandidateOnly: true as const };
function caller(userId = 1) {
  const now = new Date();
  return creatorTimelineRouter.createCaller({
    req: {} as TrpcContext["req"],
    res: { headersSent: false, setHeader: () => undefined } as unknown as TrpcContext["res"],
    requestId: "fenced-render-test",
    user: {
      id: userId, openId: "user-" + userId, name: "Test", email: "test@example.invalid",
      loginMethod: "google", role: "user" as const,
      createdAt: now, updatedAt: now, lastSignedIn: now,
    },
  });
}

describe("default-off Creator lease-fenced render route", () => {
  beforeEach(() => {
    vi.stubEnv("CREATOR_FENCED_RENDER_ENABLED", "");
    mocks.dispatch.mockReset();
    mocks.owner.mockReset();
    mocks.owner.mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("refuses to reserve or run FFmpeg when the feature flag is absent", async () => {
    await expect(caller().renderFencedCandidate(input)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED", message: "CREATOR_FENCED_RENDER_DISABLED",
    });
    expect(mocks.owner).toHaveBeenCalledWith(1, 7);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("rejects non-owners before any feature-gate or render work", async () => {
    vi.stubEnv("CREATOR_FENCED_RENDER_ENABLED", "true");
    mocks.owner.mockRejectedValueOnce(new TRPCError({ code: "FORBIDDEN", message: "CREATOR_WORKSPACE_OWNER_REQUIRED" }));
    await expect(caller(2).renderFencedCandidate(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("requires explicit candidate-only confirmation", async () => {
    vi.stubEnv("CREATOR_FENCED_RENDER_ENABLED", "true");
    await expect(caller().renderFencedCandidate({ ...input, confirmCandidateOnly: false as true }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("uses server-owned render configuration and returns only a pending candidate", async () => {
    vi.stubEnv("CREATOR_FENCED_RENDER_ENABLED", "true");
    mocks.dispatch.mockResolvedValueOnce({
      dispatched: true, claimId: 101, exportId: 102, assetId: 103,
      leaseToken: "never-leak", reviewDecision: "PENDING",
    });
    const result = await caller().renderFencedCandidate(input);
    expect(mocks.dispatch).toHaveBeenCalledWith(
      { workspaceId: 7, creatorProjectId: 12, timelineId: 15 },
      { rendererVersion: "ffmpeg-v1", fontFamily: "Noto Sans Tamil" },
    );
    expect(result).toMatchObject({
      dispatched: true, claimId: 101, exportId: 102, assetId: 103,
      reviewDecision: "PENDING", finalMaster: false, publishApproved: false,
      nextGate: "VIDEO_QUALITY_AND_HUMAN_REVIEW",
    });
    expect(JSON.stringify(result)).not.toContain("leaseToken");
  });

  it("returns existing claim without exposing an execution token or implying a new render", async () => {
    vi.stubEnv("CREATOR_FENCED_RENDER_ENABLED", "true");
    mocks.dispatch.mockResolvedValueOnce({
      dispatched: false, claimId: 101, exportId: 102, state: "RUNNING",
      outputAssetId: null, leaseToken: "never-leak",
    });
    const result = await caller().renderFencedCandidate(input);
    expect(result).toMatchObject({
      dispatched: false, claimId: 101, exportId: 102, state: "RUNNING",
      nextGate: "EXISTING_RENDER_CLAIM", finalMaster: false, publishApproved: false,
    });
    expect(JSON.stringify(result)).not.toContain("leaseToken");
    expect(JSON.stringify(result)).not.toContain("assetId");
  });
});
