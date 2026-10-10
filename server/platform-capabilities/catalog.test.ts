import { describe, expect, it } from "vitest";
import { CAPABILITY_DOMAINS, MASTER_CAPABILITY_COUNT, SAKTHIAI_MASTER_CAPABILITIES } from "./catalog";
import { COMPETITOR_CAPABILITY_REFERENCES, COMPETITOR_REFERENCE_COUNT } from "./competitors";

describe("SakthiAI master capability register", () => {
  it("tracks a broad end-to-end platform scope rather than a narrow chat product", () => {
    expect(MASTER_CAPABILITY_COUNT).toBeGreaterThanOrEqual(300);
  });

  it("keeps every capability id globally unique", () => {
    const ids = SAKTHIAI_MASTER_CAPABILITIES.map(capability => capability.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers every declared platform domain", () => {
    for (const domain of CAPABILITY_DOMAINS) {
      expect(SAKTHIAI_MASTER_CAPABILITIES.some(capability => capability.domain === domain)).toBe(true);
    }
  });

  it("preserves the two current implementation lanes", () => {
    expect(SAKTHIAI_MASTER_CAPABILITIES.some(capability => capability.ownerLane === "core-intelligence-pr25")).toBe(true);
    expect(SAKTHIAI_MASTER_CAPABILITIES.some(capability => capability.ownerLane === "creator-pr7")).toBe(true);
  });

  it("starts competitor research from evidence-backed references and can expand toward 100+", () => {
    expect(COMPETITOR_REFERENCE_COUNT).toBeGreaterThanOrEqual(10);
    for (const competitor of COMPETITOR_CAPABILITY_REFERENCES) {
      expect(competitor.publicStrengths.length).toBeGreaterThan(0);
      expect(competitor.publicTradeoffsToBeat.length).toBeGreaterThan(0);
      expect(competitor.sakthiAIResponse.length).toBeGreaterThan(0);
      expect(competitor.evidenceSource.length).toBeGreaterThan(0);
    }
  });
});
