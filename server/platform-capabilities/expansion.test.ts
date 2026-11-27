import { describe, expect, it } from "vitest";
import {
  COMPLETE_SAKTHIAI_CAPABILITIES,
  COMPLETE_SAKTHIAI_CAPABILITY_COUNT,
  SAKTHIAI_SCOPE_EXTENSIONS,
  SCOPE_EXTENSION_COUNT,
  validateCompleteCapabilityRegistry,
} from "./expansion";
import { EXTERNAL_SPECIALIST_CONTRACTS, EXTERNAL_SPECIALISTS } from "./externalAgents";

describe("SakthiAI complete-platform expansion", () => {
  it("extends the existing master into a broader complete-platform inventory", () => {
    expect(SCOPE_EXTENSION_COUNT).toBeGreaterThanOrEqual(250);
    expect(COMPLETE_SAKTHIAI_CAPABILITY_COUNT).toBeGreaterThanOrEqual(550);
    expect(SAKTHIAI_SCOPE_EXTENSIONS.length).toBe(SCOPE_EXTENSION_COUNT);
  });

  it("keeps the combined capability registry duplicate-free", () => {
    expect(validateCompleteCapabilityRegistry()).toEqual([]);
    const ids = COMPLETE_SAKTHIAI_CAPABILITIES.map(item => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("tracks bounded external specialist roles instead of independent product owners", () => {
    expect(EXTERNAL_SPECIALIST_CONTRACTS.map(item => item.id).sort()).toEqual([...EXTERNAL_SPECIALISTS].sort());
    for (const contract of EXTERNAL_SPECIALIST_CONTRACTS) {
      expect(contract.prohibited.some(rule => rule.includes("Do not merge"))).toBe(true);
      expect(contract.requiredReturn.length).toBeGreaterThanOrEqual(5);
    }
  });

  it("keeps HeyGen generation behind an approval gate", () => {
    const heygen = EXTERNAL_SPECIALIST_CONTRACTS.find(item => item.id === "heygen")!;
    expect(heygen.spendPolicy).toBe("approval_before_spend");
    expect(heygen.repoWritePolicy).toBe("read_only");
  });

  it("keeps Claude, Gemini and Manus repository writes disabled by default", () => {
    for (const id of ["claude", "gemini", "manus"] as const) {
      expect(EXTERNAL_SPECIALIST_CONTRACTS.find(item => item.id === id)?.repoWritePolicy).toBe("read_only");
    }
  });
});
