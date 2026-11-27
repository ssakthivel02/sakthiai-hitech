import { describe, expect, it } from "vitest";
import { MODEL_CATALOG } from "./catalog";
import { routeModel } from "./router";
import type { ModelProfile } from "./types";

const localLite: ModelProfile = {
  id: "local-lite",
  label: "Local Lite",
  family: "test",
  providerKind: "local",
  billingMode: "local_compute",
  openWeights: true,
  requiresApiKey: false,
  runtimeEnabled: true,
  implementationStatus: "available",
  capabilities: ["chat", "tool_use", "structured_output", "multilingual"],
  preferredIntents: ["conversation", "document_work"],
  reasoningEfforts: ["none", "low"],
  qualityTier: 2,
  resourceFloor: { cpuCores: 2, ramGb: 4, vramGb: 0, gpuCount: 0 },
};

const localReasoner: ModelProfile = {
  id: "local-reasoner",
  label: "Local Reasoner",
  family: "test",
  providerKind: "self_hosted",
  billingMode: "local_compute",
  openWeights: true,
  requiresApiKey: false,
  runtimeEnabled: true,
  implementationStatus: "available",
  capabilities: ["chat", "reasoning", "coding", "tool_use", "research", "agents", "structured_output"],
  preferredIntents: ["analysis", "research", "coding", "automation"],
  reasoningEfforts: ["low", "medium", "high", "max"],
  qualityTier: 4,
  resourceFloor: { cpuCores: 8, ramGb: 32, vramGb: 16, gpuCount: 1 },
};

const externalFrontier: ModelProfile = {
  id: "external-frontier",
  label: "External Frontier",
  family: "test",
  providerKind: "external",
  billingMode: "metered_api",
  openWeights: false,
  requiresApiKey: true,
  runtimeEnabled: true,
  implementationStatus: "available",
  capabilities: ["chat", "reasoning", "coding", "vision", "long_context", "tool_use", "research", "computer_use", "agents", "structured_output", "multilingual"],
  preferredIntents: ["conversation", "analysis", "research", "coding", "browser_work", "automation"],
  reasoningEfforts: ["none", "low", "medium", "high", "max"],
  qualityTier: 5,
  resourceFloor: { cpuCores: 1, ramGb: 1, vramGb: 0, gpuCount: 0 },
};

describe("routeModel", () => {
  it("keeps metered external providers out of the zero-spend path", () => {
    const result = routeModel([externalFrontier, localLite], {
      intents: ["conversation"],
      requiredCapabilities: ["chat"],
    });

    expect(result.selected?.model.id).toBe("local-lite");
    expect(result.rejected.find(item => item.modelId === "external-frontier")?.reasons).toEqual(
      expect.arrayContaining(["external-provider-disabled", "metered-billing-disabled"]),
    );
  });

  it("requires both external-provider and metered-billing approval", () => {
    const result = routeModel([externalFrontier], {
      intents: ["analysis"],
      requiredCapabilities: ["reasoning"],
      allowExternalProviders: true,
      allowMeteredBilling: false,
    });

    expect(result.selected).toBeUndefined();
    expect(result.rejected[0].reasons).toContain("metered-billing-disabled");
  });

  it("rejects a model that lacks a required capability", () => {
    const result = routeModel([localLite], {
      intents: ["coding"],
      requiredCapabilities: ["coding"],
    });

    expect(result.selected).toBeUndefined();
    expect(result.rejected[0].reasons).toContain("missing-capabilities:coding");
  });

  it("enforces the declared compute floor", () => {
    const result = routeModel([localReasoner], {
      intents: ["analysis"],
      requiredCapabilities: ["reasoning"],
      reasoningEffort: "high",
      compute: { cpuCores: 4, ramGb: 16, vramGb: 8, gpuCount: 1 },
    });

    expect(result.selected).toBeUndefined();
    expect(result.rejected[0].reasons).toContain("insufficient-compute");
  });

  it("prefers the stronger qualifying local reasoner for a hard reasoning task", () => {
    const general: ModelProfile = {
      ...localReasoner,
      id: "local-general",
      qualityTier: 3,
      resourceFloor: { cpuCores: 4, ramGb: 16, vramGb: 8, gpuCount: 1 },
      reasoningEfforts: ["low", "medium", "high"],
    };

    const result = routeModel([general, localReasoner], {
      intents: ["analysis", "research"],
      requiredCapabilities: ["reasoning", "research"],
      reasoningEffort: "high",
      compute: { cpuCores: 8, ramGb: 32, vramGb: 16, gpuCount: 1 },
    });

    expect(result.selected?.model.id).toBe("local-reasoner");
  });

  it("returns no model when every candidate is runtime-disabled", () => {
    const result = routeModel([{ ...localLite, runtimeEnabled: false }], {
      intents: ["conversation"],
      requiredCapabilities: ["chat"],
    });

    expect(result.selected).toBeUndefined();
    expect(result.rejected[0].reasons).toContain("runtime-disabled");
  });
});

describe("preferLocal routing", () => {
  const external = { ...MODEL_CATALOG.find(m => m.id === "frontier-external-reference")!, runtimeEnabled: true };
  const local = { ...MODEL_CATALOG.find(m => m.id === "sakthi-local-lite")!, runtimeEnabled: true };
  const request = { intents: ["conversation"] as const, requiredCapabilities: ["chat"] as const, allowExternalProviders: true, allowMeteredBilling: true };

  it("without preferLocal the higher-quality external model wins (existing behaviour unchanged)", () => {
    expect(routeModel([local, external], request).selected?.model.id).toBe("frontier-external-reference");
  });

  it("with preferLocal a lower-quality local model outranks external; external stays as the ordered fallback", () => {
    const decision = routeModel([external, local], { ...request, preferLocal: true });
    expect(decision.selected?.model.id).toBe("sakthi-local-lite");
    expect(decision.alternatives.map(a => a.model.id)).toEqual(["frontier-external-reference"]);
  });

  it("preferLocal never makes an ineligible external provider eligible", () => {
    const decision = routeModel([external, local], { ...request, allowExternalProviders: false, preferLocal: true });
    expect(decision.selected?.model.id).toBe("sakthi-local-lite");
    expect(decision.alternatives).toEqual([]);
    expect(decision.rejected.map(r => r.reasons)).toContainEqual(["external-provider-disabled"]);
  });
});
