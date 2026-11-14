import { describe, expect, it } from "vitest";
import { assertCreatorRenderStorageKey } from "./renderStorageKey";

const identity = { workspaceId: 7, creatorProjectId: 11, timelineId: 13, exportId: 17 };
const prefix = "creator/7/11/renders/timeline-13/export-17";

describe("Creator fenced render object identity", () => {
  it("accepts the exact canonical fixture key", () => {
    expect(() => assertCreatorRenderStorageKey(`${prefix}.mp4`, identity)).not.toThrow();
  });

  it("accepts the actual eight-hex suffix appended by storagePut", () => {
    expect(() => assertCreatorRenderStorageKey(`${prefix}_a0b1c2d3.mp4`, identity)).not.toThrow();
  });

  it("accepts a wider claim scope without treating mode or fingerprint as numeric IDs", () => {
    // finalizeVerifiedExport passes { ...scope, exportId }, where scope also
    // carries mode and the immutable source fingerprint.
    const claimScope = { ...identity, mode: "MASTER_CANDIDATE", fingerprint: "a".repeat(64) };
    expect(() => assertCreatorRenderStorageKey(`${prefix}.mp4`, claimScope)).not.toThrow();
    expect(() => assertCreatorRenderStorageKey(`${prefix}_a0b1c2d3.mp4`, claimScope)).not.toThrow();
    expect(() => assertCreatorRenderStorageKey(`${prefix}.mp4`, { ...claimScope, exportId: 0 }))
      .toThrow("CREATOR_RENDER_OUTPUT_IDENTITY_INVALID");
    expect(() => assertCreatorRenderStorageKey(`${prefix}.mp4`, { ...claimScope, workspaceId: -1 }))
      .toThrow("CREATOR_RENDER_OUTPUT_IDENTITY_INVALID");
  });

  it.each([
    "creator/8/11/renders/timeline-13/export-17_a0b1c2d3.mp4",
    "creator/7/12/renders/timeline-13/export-17_a0b1c2d3.mp4",
    "creator/7/11/renders/timeline-14/export-17_a0b1c2d3.mp4",
    "creator/7/11/renders/timeline-13/export-18_a0b1c2d3.mp4",
    `${prefix}_a0b1c2d3.mp4/../export-17.mp4`,
    `${prefix}_a0b1c2d3.mp4?version=1`,
    `${prefix}_a0b1c2d3.MP4`,
    `${prefix}_a0b1c2d.mp4`,
    `${prefix}_a0b1c2d3e.mp4`,
    `${prefix}_A0B1C2D3.mp4`,
    `${prefix}_zzzzzzzz.mp4`,
    `${prefix}_a0b1c2d3.webm`,
    `${prefix}-a0b1c2d3.mp4`,
    `${prefix}.mp4/evil`,
  ])("rejects a foreign, ambiguous or malformed object key: %s", key => {
    expect(() => assertCreatorRenderStorageKey(key, identity))
      .toThrow("CREATOR_RENDER_OUTPUT_IDENTITY_INVALID");
  });

  it("rejects invalid numeric identity without accepting an arbitrary key", () => {
    expect(() => assertCreatorRenderStorageKey(`${prefix}.mp4`, { ...identity, exportId: 0 }))
      .toThrow("CREATOR_RENDER_OUTPUT_IDENTITY_INVALID");
    expect(() => assertCreatorRenderStorageKey(`${prefix}.mp4`, { ...identity, workspaceId: 1.2 }))
      .toThrow("CREATOR_RENDER_OUTPUT_IDENTITY_INVALID");
  });
});
