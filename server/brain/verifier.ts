import type {
  EvidenceArtifact,
  EvidenceKind,
  RiskLevel,
  VerificationPolicy,
  VerificationResult,
} from "./types";

const RISK_ORDER: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function hasTrustedEvidence(evidence: readonly EvidenceArtifact[], kind: EvidenceKind): boolean {
  return evidence.some(item => item.kind === kind && item.trusted);
}

export function verifyEvidence(
  policy: VerificationPolicy,
  evidence: readonly EvidenceArtifact[],
  risk: RiskLevel,
): VerificationResult {
  const reasons: string[] = [];
  const evidenceUsed = evidence.filter(item => item.trusted).map(item => item.id);

  for (const kind of policy.requiredEvidence) {
    if (!hasTrustedEvidence(evidence, kind)) reasons.push(`missing-trusted-evidence:${kind}`);
  }

  if (policy.minimumTrustedSources) {
    const trustedSources = evidence.filter(item => item.trusted && (item.kind === "source" || item.kind === "retrieval")).length;
    if (trustedSources < policy.minimumTrustedSources) {
      reasons.push(`insufficient-trusted-sources:${trustedSources}/${policy.minimumTrustedSources}`);
    }
  }

  if (policy.requireTestsForCoding && !hasTrustedEvidence(evidence, "test")) {
    reasons.push("missing-trusted-evidence:test");
  }

  if (
    policy.requireHumanApprovalForRisk &&
    RISK_ORDER[risk] >= RISK_ORDER[policy.requireHumanApprovalForRisk] &&
    !hasTrustedEvidence(evidence, "approval")
  ) {
    reasons.push(`approval-required-for-risk:${risk}`);
  }

  return {
    pass: reasons.length === 0,
    reasons,
    evidenceUsed,
  };
}
