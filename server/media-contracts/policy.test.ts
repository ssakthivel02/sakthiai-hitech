import { describe, expect, it } from "vitest";
import { evaluateMediaEnginePolicy, mediaPolicyError, selectMediaFallback } from "./policy";
import type { MediaCapabilityDescriptor, MediaRequestContext } from "./types";

const baseContext: MediaRequestContext = {
  requestId: "req-1",
  tenantId: "tenant-1",
  idempotencyKey: "idem-1",
  allowExternalProviders: false,
  allowMeteredSpend: false,
  rights: [],
};

const externalVideo: MediaCapabilityDescriptor = {
  id: "external-video",
  engineKind: "video",
  providerKind: "external",
  billingMode: "metered_api",
  runtimeEnabled: true,
  capabilities: ["text_to_video"],
  supportsCancellation: true,
  supportsProgressEvents: true,
  supportsIdempotency: true,
};

describe("media policy", () => {
  it("fails closed when an external metered provider is not approved", () => {
    const decision = evaluateMediaEnginePolicy(externalVideo, baseContext);
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toEqual(
      expect.arrayContaining(["external-provider-not-approved", "metered-spend-not-approved"]),
    );
  });

  it("requires structured voice rights evidence instead of a consent boolean", () => {
    const localVoice: MediaCapabilityDescriptor = {
      ...externalVideo,
      id: "local-voice",
      engineKind: "text_to_speech",
      providerKind: "self_hosted",
      billingMode: "local_compute",
    };

    const blocked = evaluateMediaEnginePolicy(localVoice, baseContext, { requiresRightsFor: "voice" });
    expect(blocked.allowed).toBe(false);
    expect(mediaPolicyError(blocked)?.code).toBe("RIGHTS_OR_CONSENT_REQUIRED");

    const allowed = evaluateMediaEnginePolicy(
      localVoice,
      {
        ...baseContext,
        rights: [{ recordId: "voice-consent-1", subjectType: "voice", purpose: "approved test", revocable: true }],
      },
      { requiresRightsFor: "voice" },
    );
    expect(allowed.allowed).toBe(true);
  });

  it("never silently falls back to a paid cloud engine in zero-spend mode", () => {
    const decision = selectMediaFallback(
      [
        { engineId: "cloud-a", providerKind: "external", billingMode: "metered_api", materiallyDegraded: false },
        { engineId: "local-lite", providerKind: "local", billingMode: "local_compute", materiallyDegraded: true },
      ],
      baseContext,
    );

    expect(decision.selected?.engineId).toBe("local-lite");
    expect(decision.blocked[0]).toEqual({
      engineId: "cloud-a",
      reasons: ["external-provider-not-approved", "metered-spend-not-approved"],
    });
    expect(decision.userNoticeRequired).toBe(true);
  });

  it("requires a user-visible notice for materially degraded fallback", () => {
    const decision = selectMediaFallback(
      [{ engineId: "local-small", providerKind: "local", billingMode: "local_compute", materiallyDegraded: true }],
      baseContext,
    );
    expect(decision.selected?.engineId).toBe("local-small");
    expect(decision.userNoticeRequired).toBe(true);
  });

  it("does not select any candidate when every fallback violates policy", () => {
    const decision = selectMediaFallback(
      [{ engineId: "cloud-only", providerKind: "external", billingMode: "metered_api", materiallyDegraded: false }],
      baseContext,
    );
    expect(decision.selected).toBeUndefined();
    expect(decision.blocked).toHaveLength(1);
  });
});
