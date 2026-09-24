import type {
  ComputeEnvelope,
  ModelCapability,
  ModelProfile,
  RankedCandidate,
  RejectedCandidate,
  RoutingDecision,
  RoutingRequest,
} from "./types";

const DEFAULT_COMPUTE: ComputeEnvelope = {
  cpuCores: Number.POSITIVE_INFINITY,
  ramGb: Number.POSITIVE_INFINITY,
  vramGb: Number.POSITIVE_INFINITY,
  gpuCount: Number.POSITIVE_INFINITY,
  networkAllowed: true,
};

function missingCapabilities(model: ModelProfile, required: readonly ModelCapability[]): ModelCapability[] {
  const supported = new Set(model.capabilities);
  return required.filter(capability => !supported.has(capability));
}

function computeFits(model: ModelProfile, provided?: Partial<ComputeEnvelope>): boolean {
  if (!provided) return true;
  const compute = { ...DEFAULT_COMPUTE, ...provided };
  return (
    compute.cpuCores >= model.resourceFloor.cpuCores &&
    compute.ramGb >= model.resourceFloor.ramGb &&
    compute.vramGb >= model.resourceFloor.vramGb &&
    compute.gpuCount >= model.resourceFloor.gpuCount
  );
}

function rejectionReasons(model: ModelProfile, request: RoutingRequest): string[] {
  const reasons: string[] = [];
  if (!model.runtimeEnabled) reasons.push("runtime-disabled");
  if (model.providerKind === "external" && request.allowExternalProviders !== true) reasons.push("external-provider-disabled");
  if (model.billingMode === "metered_api" && request.allowMeteredBilling !== true) reasons.push("metered-billing-disabled");
  if (model.providerKind === "external" && request.compute?.networkAllowed === false) reasons.push("network-disabled");

  const missing = missingCapabilities(model, request.requiredCapabilities ?? []);
  if (missing.length) reasons.push(`missing-capabilities:${missing.join(",")}`);
  if (!computeFits(model, request.compute)) reasons.push("insufficient-compute");
  if (request.reasoningEffort && !model.reasoningEfforts.includes(request.reasoningEffort)) {
    reasons.push(`unsupported-reasoning:${request.reasoningEffort}`);
  }
  return reasons;
}

function scoreCandidate(model: ModelProfile, request: RoutingRequest): RankedCandidate {
  let score = model.qualityTier * 100;
  const reasons: string[] = [`quality-tier:${model.qualityTier}`];

  for (const intent of request.intents) {
    if (model.preferredIntents.includes(intent)) {
      score += 35;
      reasons.push(`preferred-intent:${intent}`);
    }
  }

  for (const capability of request.optionalCapabilities ?? []) {
    if (model.capabilities.includes(capability)) {
      score += 12;
      reasons.push(`optional-capability:${capability}`);
    }
  }

  if (request.reasoningEffort && model.reasoningEfforts.includes(request.reasoningEffort)) {
    score += request.reasoningEffort === "max" ? 30 : request.reasoningEffort === "high" ? 24 : 16;
    reasons.push(`reasoning:${request.reasoningEffort}`);
  }

  if (model.billingMode === "local_compute") {
    score += 25;
    reasons.push("zero-metered-api");
  }

  if (model.providerKind === "local") {
    score += 15;
    reasons.push("local-first");
  } else if (model.providerKind === "self_hosted") {
    score += 10;
    reasons.push("self-hosted");
  }

  const resourceWeight =
    model.resourceFloor.cpuCores +
    model.resourceFloor.ramGb / 4 +
    model.resourceFloor.vramGb / 2 +
    model.resourceFloor.gpuCount * 4;
  score -= resourceWeight;
  reasons.push(`resource-weight:${resourceWeight.toFixed(1)}`);

  return { model, score, reasons };
}

export function routeModel(models: readonly ModelProfile[], request: RoutingRequest): RoutingDecision {
  const rejected: RejectedCandidate[] = [];
  const ranked: RankedCandidate[] = [];

  for (const model of models) {
    const reasons = rejectionReasons(model, request);
    if (reasons.length) {
      rejected.push({ modelId: model.id, reasons });
      continue;
    }
    ranked.push(scoreCandidate(model, request));
  }

  ranked.sort((left, right) => right.score - left.score || left.model.id.localeCompare(right.model.id));
  rejected.sort((left, right) => left.modelId.localeCompare(right.modelId));

  return {
    selected: ranked[0],
    alternatives: ranked.slice(1),
    rejected,
  };
}
