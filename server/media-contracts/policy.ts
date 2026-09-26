import type {
  MediaCapabilityDescriptor,
  MediaEngineError,
  MediaRequestContext,
  RightsReference,
} from "./types";

export interface MediaPolicyDecision {
  allowed: boolean;
  reasons: string[];
}

export interface MediaFallbackCandidate {
  engineId: string;
  providerKind: MediaCapabilityDescriptor["providerKind"];
  billingMode: MediaCapabilityDescriptor["billingMode"];
  materiallyDegraded: boolean;
}

export interface MediaFallbackDecision {
  selected?: MediaFallbackCandidate;
  blocked: Array<{ engineId: string; reasons: string[] }>;
  userNoticeRequired: boolean;
}

export function hasUsableRightsReference(rights: readonly RightsReference[], subjectType: RightsReference["subjectType"]): boolean {
  const now = Date.now();
  return rights.some(record => {
    if (record.subjectType !== subjectType) return false;
    if (!record.validUntil) return true;
    const expires = Date.parse(record.validUntil);
    return Number.isFinite(expires) && expires > now;
  });
}

export function evaluateMediaEnginePolicy(
  descriptor: MediaCapabilityDescriptor,
  context: MediaRequestContext,
  options: { requiresRightsFor?: RightsReference["subjectType"] } = {},
): MediaPolicyDecision {
  const reasons: string[] = [];

  if (!descriptor.runtimeEnabled) reasons.push("runtime-disabled");
  if (descriptor.providerKind === "external" && !context.allowExternalProviders) {
    reasons.push("external-provider-not-approved");
  }
  if (descriptor.billingMode === "metered_api" && !context.allowMeteredSpend) {
    reasons.push("metered-spend-not-approved");
  }
  if (options.requiresRightsFor && !hasUsableRightsReference(context.rights, options.requiresRightsFor)) {
    reasons.push(`rights-or-consent-required:${options.requiresRightsFor}`);
  }
  if (!context.idempotencyKey.trim()) reasons.push("idempotency-key-required");
  if (!context.tenantId.trim()) reasons.push("tenant-id-required");

  return { allowed: reasons.length === 0, reasons };
}

/**
 * Select a fallback without silently bypassing provider/spend policy.
 * A materially degraded fallback may be selected, but the caller must surface a user notice.
 */
export function selectMediaFallback(
  candidates: readonly MediaFallbackCandidate[],
  context: MediaRequestContext,
): MediaFallbackDecision {
  const blocked: MediaFallbackDecision["blocked"] = [];

  for (const candidate of candidates) {
    const reasons: string[] = [];
    if (candidate.providerKind === "external" && !context.allowExternalProviders) {
      reasons.push("external-provider-not-approved");
    }
    if (candidate.billingMode === "metered_api" && !context.allowMeteredSpend) {
      reasons.push("metered-spend-not-approved");
    }
    if (reasons.length) {
      blocked.push({ engineId: candidate.engineId, reasons });
      continue;
    }

    return {
      selected: candidate,
      blocked,
      userNoticeRequired: candidate.materiallyDegraded,
    };
  }

  return { blocked, userNoticeRequired: false };
}

export function mediaPolicyError(decision: MediaPolicyDecision): MediaEngineError | undefined {
  if (decision.allowed) return undefined;
  if (decision.reasons.some(reason => reason.startsWith("rights-or-consent-required:"))) {
    return {
      code: "RIGHTS_OR_CONSENT_REQUIRED",
      message: "Required rights or consent evidence is missing or expired.",
      retryable: false,
      preserveInputs: true,
    };
  }
  if (decision.reasons.includes("external-provider-not-approved")) {
    return {
      code: "EXTERNAL_PROVIDER_NOT_APPROVED",
      message: "External provider use is not approved for this request.",
      retryable: false,
      preserveInputs: true,
    };
  }
  if (decision.reasons.includes("metered-spend-not-approved")) {
    return {
      code: "METERED_SPEND_NOT_APPROVED",
      message: "Metered provider spend is not approved for this request.",
      retryable: false,
      preserveInputs: true,
    };
  }
  return {
    code: "ENGINE_UNAVAILABLE",
    message: decision.reasons.join(", "),
    retryable: false,
    preserveInputs: true,
  };
}
