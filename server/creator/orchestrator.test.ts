import { describe, expect, it } from "vitest";
import { creatorRequestProvenance } from "./orchestrator";

describe("Creator provider-neutral orchestration provenance", () => {
  it("records reference asset identities without persisting inline image bytes", () => {
    const result = creatorRequestProvenance({
      kind: "VIDEO",
      prompt: "Murugan cinematic shot",
      aspectRatio: "16:9",
      resolution: "1080p",
      durationSeconds: 8,
      firstFrame: { mimeType: "image/png", dataBase64: "aGVsbG8=", assetId: 41 },
      references: [{ mimeType: "image/png", dataBase64: "d29ybGQ=", assetId: 42 }],
    });
    expect(result).toMatchObject({
      kind: "VIDEO",
      firstFrameAssetId: 41,
      referenceAssetIds: [42],
      referenceCount: 1,
    });
    expect(JSON.stringify(result)).not.toContain("aGVsbG8=");
    expect(JSON.stringify(result)).not.toContain("d29ybGQ=");
  });
});
