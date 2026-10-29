import { describe, expect, it } from "vitest";
import { InMemoryBudgetStore, type ReserveInput } from "./budget";
import { CircuitBreaker, InMemoryBreakerStore } from "./circuitBreaker";
import { estimateTokens } from "./gateway";
import { chatCompletionsUrl, normalizeCompletion } from "./openaiCompatible";
import { ProviderCallError } from "./types";

const reserveInput = (over: Partial<ReserveInput> = {}): ReserveInput => ({ workspaceId: 1, providerId: "p", requestId: "r", estimatedTokens: 100, policy: { externalEnabled: true, maxRequests: 2 }, ...over });

describe("InMemoryBudgetStore", () => {
  it("denies when external is disabled, when no limit exists, and when a cost ceiling has no trustworthy estimate", async () => {
    const store = new InMemoryBudgetStore();
    expect(await store.reserve(reserveInput({ policy: { externalEnabled: false, maxRequests: 5 } }))).toEqual({ ok: false, reason: "external_disabled" });
    expect(await store.reserve(reserveInput({ policy: { externalEnabled: true } }))).toEqual({ ok: false, reason: "no_limits_configured" });
    expect(await store.reserve(reserveInput({ policy: { externalEnabled: true, maxCost: 1 } }))).toEqual({ ok: false, reason: "cost_metadata_missing" });
    expect(await store.usage(1)).toMatchObject({ requests: 0, tokens: 0 });
  });

  it("enforces request, token and cost ceilings and returns the exact reason", async () => {
    const store = new InMemoryBudgetStore();
    expect((await store.reserve(reserveInput())).ok).toBe(true);
    expect((await store.reserve(reserveInput())).ok).toBe(true);
    expect(await store.reserve(reserveInput())).toEqual({ ok: false, reason: "requests_exhausted" });
    const t = new InMemoryBudgetStore();
    expect(await t.reserve(reserveInput({ estimatedTokens: 600, policy: { externalEnabled: true, maxTokens: 1000 } }))).toMatchObject({ ok: true });
    expect(await t.reserve(reserveInput({ estimatedTokens: 600, policy: { externalEnabled: true, maxTokens: 1000 } }))).toEqual({ ok: false, reason: "tokens_exhausted" });
    const c = new InMemoryBudgetStore();
    const policy = { externalEnabled: true, maxCost: 1 };
    expect(await c.reserve(reserveInput({ estimatedCost: 0.8, policy }))).toMatchObject({ ok: true });
    expect(await c.reserve(reserveInput({ estimatedCost: 0.8, policy }))).toEqual({ ok: false, reason: "cost_exhausted" });
  });

  it("commit replaces the estimate with actual usage (idempotently); release returns the hold", async () => {
    const store = new InMemoryBudgetStore();
    const policy = { externalEnabled: true, maxRequests: 10 };
    const a = await store.reserve(reserveInput({ estimatedTokens: 500, policy }));
    const b = await store.reserve(reserveInput({ estimatedTokens: 500, policy }));
    if (!a.ok || !b.ok) throw new Error("reserve failed");
    await store.commit(a.reservation, { tokens: 120, source: "provider_reported" });
    await store.commit(a.reservation, { tokens: 9999, source: "provider_reported" }); // second commit ignored
    await store.release(b.reservation);
    await store.release(b.reservation); // idempotent
    expect(await store.usage(1)).toMatchObject({ requests: 1, tokens: 120, estimatedCommits: 0 });
  });

  it("windows are per UTC day and per workspace", async () => {
    let now = Date.UTC(2026, 0, 1, 23, 59, 0);
    const store = new InMemoryBudgetStore(() => now);
    const policy = { externalEnabled: true, maxRequests: 1 };
    expect((await store.reserve(reserveInput({ policy }))).ok).toBe(true);
    expect((await store.reserve(reserveInput({ policy }))).ok).toBe(false);
    expect((await store.reserve(reserveInput({ policy, workspaceId: 2 }))).ok).toBe(true);
    now += 2 * 60 * 1000; // next UTC day
    expect((await store.reserve(reserveInput({ policy }))).ok).toBe(true);
  });
});

describe("CircuitBreaker (unit)", () => {
  it("rejects invalid configuration", () => {
    expect(() => new CircuitBreaker(new InMemoryBreakerStore(), { failureThreshold: 0, cooldownMs: 1 })).toThrow();
    expect(() => new CircuitBreaker(new InMemoryBreakerStore(), { failureThreshold: 1, cooldownMs: -1 })).toThrow();
  });

  it("successes reset the failure streak; only CONSECUTIVE failures open the circuit", async () => {
    const b = new CircuitBreaker(new InMemoryBreakerStore(), { failureThreshold: 3, cooldownMs: 1000 }, () => 0);
    await b.recordFailure("p"); await b.recordFailure("p"); await b.recordSuccess("p"); await b.recordFailure("p"); await b.recordFailure("p");
    expect(await b.state("p")).toBe("CLOSED");
    await b.recordFailure("p");
    expect(await b.state("p")).toBe("OPEN");
  });

  it("a half-open probe that never reports back expires after one cooldown; neutral results release the slot", async () => {
    let now = 0;
    const b = new CircuitBreaker(new InMemoryBreakerStore(), { failureThreshold: 1, cooldownMs: 1000 }, () => now);
    await b.recordFailure("p");
    expect((await b.admit("p")).allowed).toBe(false);
    now = 1000;
    expect(await b.admit("p")).toMatchObject({ allowed: true, probe: true, state: "HALF_OPEN" });
    expect((await b.admit("p")).allowed).toBe(false); // probe in flight
    now = 2000;
    expect((await b.admit("p")).allowed).toBe(true); // stuck probe expired
    await b.recordNeutral("p");
    expect((await b.admit("p")).allowed).toBe(true); // slot released by a neutral result
  });
});

describe("OpenAI-compatible normalisation", () => {
  const ok = (extra: object = {}) => ({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }], ...extra });

  it("extracts provider-reported usage, derives total, and ignores junk numbers", () => {
    expect(normalizeCompletion(ok({ usage: { prompt_tokens: 3, completion_tokens: 4 } })).usage).toEqual({ promptTokens: 3, completionTokens: 4, totalTokens: 7 });
    expect(normalizeCompletion(ok({ usage: { prompt_tokens: -1, completion_tokens: "x", total_tokens: NaN } })).usage).toBeNull();
    expect(normalizeCompletion(ok()).usage).toBeNull();
    expect(normalizeCompletion(ok()).finishReason).toBe("stop");
  });

  it("throws typed errors that carry no body", () => {
    for (const [payload, cls] of [[null, "malformed_response"], [{ choices: [{ message: { content: "" } }] }, "empty_response"], [{ choices: [{ message: { content: "x" } }] }, undefined]] as const) {
      if (!cls) { expect(() => normalizeCompletion(payload)).not.toThrow(); continue; }
      try { normalizeCompletion(payload); throw new Error("expected throw"); } catch (error) {
        expect(error).toBeInstanceOf(ProviderCallError);
        expect((error as ProviderCallError).errorClass).toBe(cls);
        expect((error as Error).message).not.toMatch(/payload|content/);
      }
    }
  });

  it("builds the completions URL for bare, /v1 and trailing-slash bases", () => {
    expect(chatCompletionsUrl("http://h:1")).toBe("http://h:1/v1/chat/completions");
    expect(chatCompletionsUrl("http://h:1/")).toBe("http://h:1/v1/chat/completions");
    expect(chatCompletionsUrl("http://h:1/v1")).toBe("http://h:1/v1/chat/completions");
    expect(chatCompletionsUrl("http://h:1/v1/")).toBe("http://h:1/v1/chat/completions");
  });

  it("token estimates grow with input and always include the output allowance", () => {
    const small = estimateTokens([{ role: "user", content: "a" }], 100);
    const big = estimateTokens([{ role: "user", content: "a".repeat(3000) }], 100);
    expect(small).toBeGreaterThanOrEqual(100);
    expect(big).toBeGreaterThan(small + 900);
  });
});
