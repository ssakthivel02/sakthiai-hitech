import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { compareCommits, effectiveLayerState, evidenceFreshness, isRuntimeHealthy, normalizeLayerState, shortSha } from "@shared/releaseStatus";

const NOW = new Date("2026-10-24T03:00:00Z");

describe("release status helpers", () => {
  it("never treats unknown or unrecognised states as healthy", () => {
    expect(normalizeLayerState("healthy")).toBe("unknown");
    expect(normalizeLayerState(undefined)).toBe("unknown");
    expect(isRuntimeHealthy("unknown")).toBe(false);
    expect(isRuntimeHealthy("ci_passed")).toBe(false);
    expect(isRuntimeHealthy("source_implemented")).toBe(false);
    expect(isRuntimeHealthy("live_verified")).toBe(true);
  });

  it("degrades a stale or undated observation to unknown", () => {
    const fresh = evidenceFreshness("2026-10-23T03:00:00Z", 7, NOW);
    expect(fresh).toEqual({ status: "fresh", ageDays: 1 });
    expect(effectiveLayerState("deployed", fresh)).toBe("deployed");
    const stale = evidenceFreshness("2026-10-01T00:00:00Z", 7, NOW);
    expect(stale.status).toBe("stale");
    expect(effectiveLayerState("deployed", stale)).toBe("unknown");
    expect(evidenceFreshness("not a date", 7, NOW).status).toBe("unknown");
    expect(evidenceFreshness("2026-10-23T03:00:00Z", 0, NOW).status).toBe("unknown");
    expect(evidenceFreshness("2026-11-30T00:00:00Z", 7, NOW).status).toBe("unknown");
  });

  it("matches commits only on two known, equal full SHAs", () => {
    const a = "0a48dc3164e35218c3e2789e2b8d34b177c3e48b";
    expect(compareCommits(a, a.toUpperCase())).toBe("match");
    expect(compareCommits(a, "469c668e71ceaae800e8605c5814e7017035fdbc")).toBe("differs");
    expect(compareCommits(a, "unknown")).toBe("unknown");
    expect(compareCommits(a, "0a48dc3")).toBe("unknown");
    expect(shortSha(a)).toBe("0a48dc3");
    expect(shortSha("unknown")).toBe("unknown");
  });

  it("the committed ledger shows no runtime-healthy layer while both verdicts are no-go", () => {
    const ledger = JSON.parse(readFileSync("release/release-status.json", "utf8"));
    expect(ledger.verdicts).toEqual({ preview: "no-go", production: "no-go" });
    expect(compareCommits(ledger.candidate.lastCiVerifiedCommit, ledger.deployment.observedCommit)).toBe("differs");
  });
});
