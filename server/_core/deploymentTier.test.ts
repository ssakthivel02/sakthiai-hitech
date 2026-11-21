import { describe, expect, it } from "vitest";
import { deploymentTier, runtimeMode } from "./deploymentTier";

const tier = (value?: string) => deploymentTier({ SAKTHIAI_DEPLOY_ENV: value, NODE_ENV: "production" });

describe("deploymentTier", () => {
  it("never derives the tier from NODE_ENV", () => {
    expect(tier(undefined)).toBe("unspecified");
    expect(tier("")).toBe("unspecified");
    expect(deploymentTier({ NODE_ENV: "production" })).toBe("unspecified");
  });

  it("accepts only allowlisted tiers, case- and whitespace-insensitive", () => {
    expect(tier("preview")).toBe("preview");
    expect(tier(" Staging ")).toBe("staging");
    expect(tier("PRODUCTION")).toBe("production");
    expect(tier("local")).toBe("local");
  });

  it("rejects unknown or injected values", () => {
    expect(tier("prod")).toBe("unspecified");
    expect(tier("production; drop")).toBe("unspecified");
    expect(tier("<script>")).toBe("unspecified");
  });
});

describe("runtimeMode", () => {
  it("reports NODE_ENV as the runtime mode only", () => {
    expect(runtimeMode({ NODE_ENV: "production" })).toBe("production");
    expect(runtimeMode({})).toBe("unknown");
    expect(runtimeMode({ NODE_ENV: "  " })).toBe("unknown");
  });
});
