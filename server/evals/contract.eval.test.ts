import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import type { User } from "../../drizzle/schema";
import { createOpenAiCompatibleAdapter, createProviderGateway, loadGatewayConfig, setProviderGatewayForTests, type GatewayOutcome } from "../gateway";
import { buildReport, type CaseResult, type EvalDimensionId, type StepMetrics } from "./metrics";

/**
 * CONTRACT / EVAL HARNESS (deterministic, replayed provider responses).
 *
 * Drives the REAL appRouter chat.send, REAL retrieval ranking, REAL grounding resolution and the REAL
 * Provider Gateway (routing, breaker, budget, adapter) against fixed fixtures. Only persistence (in-memory,
 * tenant-filtered like db.searchChunks) and the HTTP transport (in-process replay) are substituted.
 * This is NOT a measure of real-model answer quality and makes no network or paid call.
 */

const state = vi.hoisted(() => ({
  chunks: [] as Array<{ chunk: any; document: { filename: string; mimeType: string } }>,
  inserted: [] as Array<{ table: string; values: any }>,
}));

vi.mock("../db", async () => {
  const schema = await vi.importActual<typeof import("../../drizzle/schema")>("../../drizzle/schema");
  const retrieval = await vi.importActual<typeof import("../retrieval")>("../retrieval");
  const tableName = (table: unknown) => (table === schema.conversations ? "conversations" : table === schema.messages ? "messages" : "other");
  const select = () => {
    const chain: any = { from: () => chain, where: () => chain, orderBy: () => chain, limit: async () => [{ id: 11 }] };
    return chain;
  };
  return {
    getDb: vi.fn(async () => ({ select, insert: (table: unknown) => ({ values: async (values: any) => { state.inserted.push({ table: tableName(table), values }); } }) })),
    getWorkspaceForUser: vi.fn(async (_userId: number, workspaceId: number) => ({ id: workspaceId })),
    searchChunks: vi.fn(async (workspaceId: number, query: string) =>
      retrieval.rankChunkCandidates(state.chunks.filter(row => row.chunk.workspaceId === workspaceId), query, null)),
    ensureWorkspace: vi.fn(), listUserWorkspaces: vi.fn(), listProjects: vi.fn(), listDocuments: vi.fn(), getConversationMessages: vi.fn(), getUserByOpenId: vi.fn(),
    projects: schema.projects, documents: schema.documents, documentChunks: schema.documentChunks, conversations: schema.conversations, messages: schema.messages,
  };
});
vi.mock("../storage", () => ({ storagePut: vi.fn() }));
vi.mock("../provenance", () => ({ extractDocument: vi.fn() }));
vi.mock("../security/malwareScanner", () => ({ malwareScannerConfigurationStatus: () => "not_configured" }));
vi.mock("../creator/router", async () => {
  const { router } = await import("../_core/trpc");
  return { creatorRouter: router({}) };
});

import { appRouter } from "../routers";
import type { TrpcContext } from "../_core/context";

// ---------- fixtures ----------
const LOCAL_HOST = "local.eval.invalid";
const EXTERNAL_HOST = "external.eval.invalid";
const TAMIL_CHUNK = "முருகன் கோவில் பழநியில் உள்ளது; எங்கு செல்வது என்பதை வழிகாட்டி கூறும்.";
const ENGLISH_CHUNK = "The Murugan temple opens at 6am and closes at 8pm.";
const MIXED_CHUNK = "முருகன் வழிபாடு (Murugan worship) 2026 timings";
const RAIN_CHUNK = "பருவமழை காலத்தில் வயல்களில் நீர் நிறைந்தது";
const TENANT2_EN = "ZEPHYR-BUDGET-MARKER the confidential quarterly zephyr budget is ninety thousand";
const TENANT2_TA = "ரகசிய ஆவணம் முருகன் கோவில் TENANT2-SECRET-TA";
const OTHER_TENANT_MARKERS = ["ZEPHYR-BUDGET-MARKER", "TENANT2-SECRET-TA"];

function row(id: number, content: string, filename: string, workspaceId = 1) {
  return { chunk: { id, documentId: id * 10, workspaceId, chunkIndex: 0, page: 1, section: null, paragraph: null, content, sourceStart: 0, sourceEnd: content.length, embeddingJson: null }, document: { filename, mimeType: "text/plain" } };
}
const corpus = () => [
  row(1, RAIN_CHUNK, "rain.txt"), row(2, TAMIL_CHUNK, "temples-ta.txt"), row(3, ENGLISH_CHUNK, "temples-en.txt"), row(4, MIXED_CHUNK, "mixed.txt"),
  row(5, TENANT2_EN, "tenant2-budget.txt", 2), row(6, TENANT2_TA, "tenant2-secret-ta.txt", 2),
];

type Behaviour = { ok: string; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } } | { status: number } | { hang: true };
type Script = { local?: Behaviour[]; external?: Behaviour[] };
type Expect = {
  grounding: "GROUNDED_EVIDENCE" | "INSUFFICIENT_EVIDENCE" | "MODEL_UNAVAILABLE";
  retrievalHit?: boolean;
  provider?: "local" | "external" | null;
  failureReason?: string;
  gatewayCalled?: boolean;
  citedFilenames?: string[];
  noCitationsFrom?: number;
  fallbacks?: number;
  timeout?: boolean;
  budget?: "allowed" | `denied:${string}`;
  externalHits?: number;
  localHits?: number;
  tokens?: number;
};
type Step = { query: string; language?: "en" | "ta"; workspaceId?: number; script?: Script; expect: Expect };
type EvalCase = { id: string; dimension: EvalDimensionId; description: string; env: Record<string, string>; steps: Step[] };

const LOCAL_ENV = { LOCAL_LLM_API_URL: `http://${LOCAL_HOST}`, LOCAL_LLM_MODEL: "local-eval-model" };
const EXTERNAL_ENV = { LLM_API_URL: `https://${EXTERNAL_HOST}`, LLM_MODEL: "ext-eval-model", LLM_API_KEY: "eval-key-not-a-secret" };
const ALLOW_EXT = { GATEWAY_ALLOW_EXTERNAL: "true" };
const ALLOW_METERED = { GATEWAY_ALLOW_METERED: "true", GATEWAY_BUDGET_STORE: "memory", GATEWAY_EXTERNAL_MAX_REQUESTS_PER_DAY: "100" };
const ok = (content: string, usage?: Behaviour extends infer B ? any : never): Behaviour => ({ ok: content, ...(usage ? { usage } : {}) });

const TEMPLE_Q = "Murugan temple opening hours";
const CASES: EvalCase[] = [
  { id: "en-grounded-local", dimension: "english_grounded_retrieval", description: "English query, evidence retrieved, local provider answers", env: LOCAL_ENV,
    steps: [{ query: TEMPLE_Q, script: { local: [ok("It opens at 6am. [1]")] }, expect: { grounding: "GROUNDED_EVIDENCE", retrievalHit: true, provider: "local", citedFilenames: ["temples-en.txt"], externalHits: 0 } }] },
  { id: "en-grounded-closing-time", dimension: "english_grounded_retrieval", description: "Second English phrasing retrieves the same evidence", env: LOCAL_ENV,
    steps: [{ query: "When does the Murugan temple close?", script: { local: [ok("It closes at 8pm. [1]")] }, expect: { grounding: "GROUNDED_EVIDENCE", retrievalHit: true, provider: "local", citedFilenames: ["temples-en.txt"] } }] },
  { id: "en-usage-reported", dimension: "english_grounded_retrieval", description: "Provider-reported token usage is surfaced, not fabricated", env: LOCAL_ENV,
    steps: [{ query: TEMPLE_Q, script: { local: [ok("Opens at 6am. [1]", { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 })] }, expect: { grounding: "GROUNDED_EVIDENCE", retrievalHit: true, provider: "local", tokens: 48 } }] },
  { id: "ta-grounded-location", dimension: "tamil_grounded_retrieval", description: "Tamil query retrieves the Tamil evidence", env: LOCAL_ENV,
    steps: [{ query: "முருகன் கோவில் எங்கு உள்ளது?", language: "ta", script: { local: [ok("பழநியில் உள்ளது. [1]")] }, expect: { grounding: "GROUNDED_EVIDENCE", retrievalHit: true, provider: "local", citedFilenames: ["temples-ta.txt"] } }] },
  { id: "ta-grounded-rain", dimension: "tamil_grounded_retrieval", description: "Tamil inflected query matches Tamil rain evidence", env: LOCAL_ENV,
    steps: [{ query: "பருவமழை காலத்தில் என்ன நடந்தது?", language: "ta", script: { local: [ok("வயல்களில் நீர் நிறைந்தது. [1]")] }, expect: { grounding: "GROUNDED_EVIDENCE", retrievalHit: true, provider: "local", citedFilenames: ["rain.txt"] } }] },
  { id: "mixed-english-query-mixed-doc", dimension: "mixed_tamil_english", description: "English query matches mixed-script evidence", env: LOCAL_ENV,
    steps: [{ query: "Murugan worship timings", script: { local: [ok("See the timings. [1]")] }, expect: { grounding: "GROUNDED_EVIDENCE", retrievalHit: true, provider: "local", citedFilenames: ["mixed.txt"] } }] },
  { id: "mixed-tamil-query-mixed-doc", dimension: "mixed_tamil_english", description: "Tamil term in a mixed query matches mixed-script evidence", env: LOCAL_ENV,
    steps: [{ query: "முருகன் worship 2026", language: "ta", script: { local: [ok("காண்க. [1]")] }, expect: { grounding: "GROUNDED_EVIDENCE", retrievalHit: true, provider: "local", citedFilenames: ["mixed.txt"] } }] },
  { id: "no-evidence-skips-model", dimension: "no_evidence", description: "No retrieval hit: INSUFFICIENT_EVIDENCE, gateway never called", env: LOCAL_ENV,
    steps: [{ query: "quantum chromodynamics lattice", expect: { grounding: "INSUFFICIENT_EVIDENCE", retrievalHit: false, gatewayCalled: false, localHits: 0 } }] },
  { id: "no-evidence-model-declines", dimension: "no_evidence", description: "Evidence present but model answers exactly INSUFFICIENT_EVIDENCE", env: LOCAL_ENV,
    steps: [{ query: TEMPLE_Q, script: { local: [ok("INSUFFICIENT_EVIDENCE")] }, expect: { grounding: "INSUFFICIENT_EVIDENCE", retrievalHit: true, provider: "local" } }] },
  { id: "unavailable-all-5xx", dimension: "provider_unavailable", description: "Provider 503: MODEL_UNAVAILABLE, evidence preserved, no fabricated answer", env: LOCAL_ENV,
    steps: [{ query: TEMPLE_Q, script: { local: [{ status: 503 }] }, expect: { grounding: "MODEL_UNAVAILABLE", retrievalHit: true, provider: null, failureReason: "server_error", citedFilenames: ["temples-en.txt"] } }] },
  { id: "unavailable-not-configured", dimension: "provider_unavailable", description: "No provider configured: MODEL_UNAVAILABLE, no network", env: {},
    steps: [{ query: TEMPLE_Q, expect: { grounding: "MODEL_UNAVAILABLE", retrievalHit: true, provider: null, failureReason: "no_eligible_provider", localHits: 0, externalHits: 0 } }] },
  { id: "unavailable-auth-failure-terminal", dimension: "provider_unavailable", description: "401 is terminal: no retry storm, no fallback to external", env: { ...LOCAL_ENV, ...EXTERNAL_ENV, ...ALLOW_EXT, ...ALLOW_METERED },
    steps: [{ query: TEMPLE_Q, script: { local: [{ status: 401 }], external: [ok("x [1]")] }, expect: { grounding: "MODEL_UNAVAILABLE", retrievalHit: true, provider: null, failureReason: "auth_failed", fallbacks: 0, externalHits: 0, localHits: 1 } }] },
  { id: "timeout-classified", dimension: "provider_timeout", description: "Hung provider is aborted and classified as timeout", env: { ...LOCAL_ENV, GATEWAY_TIMEOUT_MS: "40", GATEWAY_MAX_ATTEMPTS: "1" },
    steps: [{ query: TEMPLE_Q, script: { local: [{ hang: true }] }, expect: { grounding: "MODEL_UNAVAILABLE", retrievalHit: true, provider: null, failureReason: "timeout", timeout: true } }] },
  { id: "timeout-then-retry-recovers", dimension: "provider_timeout", description: "First attempt times out, bounded retry succeeds", env: { ...LOCAL_ENV, GATEWAY_TIMEOUT_MS: "40", GATEWAY_MAX_ATTEMPTS: "2" },
    steps: [{ query: TEMPLE_Q, script: { local: [{ hang: true }, ok("Opens at 6am. [1]")] }, expect: { grounding: "GROUNDED_EVIDENCE", retrievalHit: true, provider: "local", localHits: 2 } }] },
  { id: "citation-persisted-matches-response", dimension: "citation_consistency", description: "Citations map to real same-tenant chunks and match the persisted message", env: LOCAL_ENV,
    steps: [{ query: "Murugan temple 6am", script: { local: [ok("Opens at 6am. [1]")] }, expect: { grounding: "GROUNDED_EVIDENCE", retrievalHit: true, provider: "local" } }] },
  { id: "isolation-ws1-cannot-see-ws2-english", dimension: "cross_workspace_isolation", description: "Workspace 1 query for workspace 2 content finds nothing", env: LOCAL_ENV,
    steps: [{ query: "confidential quarterly zephyr budget", expect: { grounding: "INSUFFICIENT_EVIDENCE", retrievalHit: false, gatewayCalled: false } }] },
  { id: "isolation-ws1-cannot-see-ws2-tamil", dimension: "cross_workspace_isolation", description: "Tamil query cannot surface workspace 2 Tamil secret; prompt carries no foreign evidence", env: LOCAL_ENV,
    steps: [{ query: "ரகசிய ஆவணம்", language: "ta", expect: { grounding: "INSUFFICIENT_EVIDENCE", retrievalHit: false, gatewayCalled: false } }] },
  { id: "isolation-ws2-gets-own-evidence-only", dimension: "cross_workspace_isolation", description: "Workspace 2 retrieves its own evidence and never workspace 1's", env: LOCAL_ENV,
    steps: [{ query: "confidential quarterly zephyr budget", workspaceId: 2, script: { local: [ok("Ninety thousand. [1]")] }, expect: { grounding: "GROUNDED_EVIDENCE", retrievalHit: true, provider: "local", citedFilenames: ["tenant2-budget.txt"], noCitationsFrom: 1 } }] },
  { id: "routing-local-preferred-when-both-allowed", dimension: "local_routing_policy", description: "Local and external both eligible: local wins, external never contacted", env: { ...LOCAL_ENV, ...EXTERNAL_ENV, ...ALLOW_EXT, ...ALLOW_METERED },
    steps: [{ query: TEMPLE_Q, script: { local: [ok("6am [1]")], external: [ok("external [1]")] }, expect: { grounding: "GROUNDED_EVIDENCE", retrievalHit: true, provider: "local", externalHits: 0 } }] },
  { id: "optin-external-denied-without-flag", dimension: "external_opt_in_requirement", description: "External configured but not opted in: never called", env: { ...EXTERNAL_ENV },
    steps: [{ query: TEMPLE_Q, script: { external: [ok("x [1]")] }, expect: { grounding: "MODEL_UNAVAILABLE", retrievalHit: true, provider: null, failureReason: "no_eligible_provider", externalHits: 0 } }] },
  { id: "optin-external-not-used-when-local-down", dimension: "external_opt_in_requirement", description: "Local down and external not opted in: no silent external fallback", env: { ...LOCAL_ENV, ...EXTERNAL_ENV },
    steps: [{ query: TEMPLE_Q, script: { local: [{ status: 503 }], external: [ok("x [1]")] }, expect: { grounding: "MODEL_UNAVAILABLE", retrievalHit: true, provider: null, externalHits: 0 } }] },
  { id: "optin-subscription-external-still-requires-flag", dimension: "external_opt_in_requirement", description: "Subscription-billed external (no metering gate) still needs the explicit external opt-in", env: { ...EXTERNAL_ENV, LLM_BILLING_MODE: "subscription" },
    steps: [{ query: TEMPLE_Q, script: { external: [ok("x [1]")] }, expect: { grounding: "MODEL_UNAVAILABLE", retrievalHit: true, provider: null, failureReason: "no_eligible_provider", externalHits: 0 } }] },
  { id: "optin-external-allowed-with-budget", dimension: "external_opt_in_requirement", description: "Explicit opt-in + metered opt-in + budget: external is used", env: { ...EXTERNAL_ENV, ...ALLOW_EXT, ...ALLOW_METERED },
    steps: [{ query: TEMPLE_Q, script: { external: [ok("6am [1]")] }, expect: { grounding: "GROUNDED_EVIDENCE", retrievalHit: true, provider: "external", budget: "allowed", externalHits: 1 } }] },
  { id: "budget-metered-without-budget-fails-closed", dimension: "budget_denial", description: "Metered external without a budget store is denied (fail closed)", env: { ...EXTERNAL_ENV, ...ALLOW_EXT, GATEWAY_ALLOW_METERED: "true" },
    steps: [{ query: TEMPLE_Q, script: { external: [ok("x [1]")] }, expect: { grounding: "MODEL_UNAVAILABLE", retrievalHit: true, provider: null, failureReason: "budget_denied", budget: "denied:budget_store_unavailable", externalHits: 0 } }] },
  { id: "budget-exhausted-second-request", dimension: "budget_denial", description: "Daily request budget of 1: second request denied before reaching the provider", env: { ...EXTERNAL_ENV, ...ALLOW_EXT, GATEWAY_ALLOW_METERED: "true", GATEWAY_BUDGET_STORE: "memory", GATEWAY_EXTERNAL_MAX_REQUESTS_PER_DAY: "1" },
    steps: [
      { query: TEMPLE_Q, script: { external: [ok("6am [1]")] }, expect: { grounding: "GROUNDED_EVIDENCE", retrievalHit: true, provider: "external", budget: "allowed", externalHits: 1 } },
      { query: TEMPLE_Q, expect: { grounding: "MODEL_UNAVAILABLE", retrievalHit: true, provider: null, failureReason: "budget_denied", budget: "denied:requests_exhausted", externalHits: 1 } },
    ] },
  { id: "fallback-local-down-external-allowed", dimension: "fallback_behaviour", description: "Local 503 + external opted in: one fallback to external, grounded", env: { ...LOCAL_ENV, ...EXTERNAL_ENV, ...ALLOW_EXT, ...ALLOW_METERED, GATEWAY_MAX_ATTEMPTS: "1" },
    steps: [{ query: TEMPLE_Q, script: { local: [{ status: 503 }], external: [ok("6am [1]")] }, expect: { grounding: "GROUNDED_EVIDENCE", retrievalHit: true, provider: "external", fallbacks: 1, budget: "allowed" } }] },
  { id: "fallback-breaker-open-skips-local", dimension: "fallback_behaviour", description: "Breaker opens after threshold; next request skips local without contacting it", env: { ...LOCAL_ENV, ...EXTERNAL_ENV, ...ALLOW_EXT, ...ALLOW_METERED, GATEWAY_MAX_ATTEMPTS: "1", GATEWAY_BREAKER_THRESHOLD: "1" },
    steps: [
      { query: TEMPLE_Q, script: { local: [{ status: 503 }], external: [ok("6am [1]")] }, expect: { grounding: "GROUNDED_EVIDENCE", retrievalHit: true, provider: "external", fallbacks: 1, localHits: 1 } },
      { query: TEMPLE_Q, expect: { grounding: "GROUNDED_EVIDENCE", retrievalHit: true, provider: "external", fallbacks: 1, localHits: 1 } },
    ] },
  { id: "fallback-none-available-honest-failure", dimension: "fallback_behaviour", description: "Every eligible provider fails: honest MODEL_UNAVAILABLE", env: { ...LOCAL_ENV, ...EXTERNAL_ENV, ...ALLOW_EXT, ...ALLOW_METERED, GATEWAY_MAX_ATTEMPTS: "1" },
    steps: [{ query: TEMPLE_Q, script: { local: [{ status: 503 }], external: [{ status: 503 }] }, expect: { grounding: "MODEL_UNAVAILABLE", retrievalHit: true, provider: null, fallbacks: 0, localHits: 1, externalHits: 1 } }] },
];

// ---------- harness ----------
type Hit = { host: string; body: string };
let hits: Hit[] = [];
let queues: Record<string, Behaviour[]> = {};
const fetchGuard = vi.spyOn(globalThis, "fetch");

function transport(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const host = new URL(String(input)).hostname;
    hits.push({ host, body: String(init?.body ?? "") });
    const queue = queues[host] ?? [];
    const behaviour = queue.length > 1 ? queue.shift()! : queue[0];
    if (!behaviour) return new Response("{}", { status: 500 });
    if ("hang" in behaviour) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    }
    if ("status" in behaviour) return new Response(JSON.stringify({ error: "fixture" }), { status: behaviour.status });
    return new Response(JSON.stringify({ choices: [{ message: { content: behaviour.ok }, finish_reason: "stop" }], ...(behaviour.usage ? { usage: behaviour.usage } : {}) }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function gatewayFor(env: Record<string, string>) {
  const config = loadGatewayConfig({ GATEWAY_BACKOFF_BASE_MS: "1", GATEWAY_BACKOFF_MAX_MS: "1", ...env });
  const fetchImpl = transport();
  const gateway = createProviderGateway(config, {
    log: () => undefined,
    adapterFactory: binding => createOpenAiCompatibleAdapter({
      providerId: binding.providerId, baseUrl: binding.baseUrl, apiKey: binding.apiKey, timeoutMs: binding.timeoutMs,
      maxAttempts: config.retry.maxAttempts, totalDeadlineMs: config.retry.totalDeadlineMs, backoffBaseMs: config.retry.backoffBaseMs, backoffMaxMs: config.retry.backoffMaxMs,
      fetchImpl, sleep: async () => undefined, random: () => 0.5,
    }),
  });
  const outcomes: GatewayOutcome[] = [];
  const real = gateway.invoke.bind(gateway);
  gateway.invoke = async request => { const outcome = await real(request); outcomes.push(outcome); return outcome; };
  return { config, gateway, outcomes };
}

let userSeq = 5000;
function caller() {
  const user = { id: userSeq++, openId: "eval", email: null, name: "eval", loginMethod: "test", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() } as User;
  const ctx: TrpcContext = { user, req: { protocol: "https", headers: {} } as Request, res: { headersSent: false, setHeader: vi.fn(), clearCookie: vi.fn() } as unknown as TrpcContext["res"], requestId: "contract-eval" };
  return appRouter.createCaller(ctx);
}

async function runCase(evalCase: EvalCase): Promise<CaseResult> {
  state.inserted = [];
  state.chunks = corpus();
  hits = [];
  queues = {};
  const { config, gateway, outcomes } = gatewayFor(evalCase.env);
  setProviderGatewayForTests(gateway);
  const externalAllowed = config.policy.allowExternal;
  const api = caller();
  const failures: string[] = [];
  const steps: StepMetrics[] = [];

  for (const [index, step] of evalCase.steps.entries()) {
    const at = `${evalCase.id}#${index + 1}`;
    const check = (condition: boolean, message: string) => { if (!condition) failures.push(`${at}:${message}`); };
    if (step.script?.local) queues[LOCAL_HOST] = [...step.script.local];
    if (step.script?.external) queues[EXTERNAL_HOST] = [...step.script.external];
    const hitsBefore = hits.length;
    const outcomesBefore = outcomes.length;
    const workspaceId = step.workspaceId ?? 1;
    const started = performance.now();
    const result = await api.chat.send({ workspaceId, message: step.query, ...(step.language ? { language: step.language } : {}) });
    const fixtureLatencyMs = Math.round(performance.now() - started);
    const stepHits = hits.slice(hitsBefore);
    const outcome = outcomes.length > outcomesBefore ? outcomes[outcomes.length - 1] : null;
    const e = step.expect;

    // citation consistency against the source rows + persisted assistant message
    let consistent = 0;
    let leaks = 0;
    for (const citation of result.citations) {
      const source = state.chunks.find(candidate => candidate.chunk.id === citation.chunkId);
      const good = !!source && source.chunk.workspaceId === workspaceId && source.document.filename === citation.filename && source.chunk.content.startsWith(citation.excerpt.slice(0, 20)) && citation.retrievalScore > 0;
      if (good) consistent += 1;
      if (source && source.chunk.workspaceId !== workspaceId) leaks += 1;
    }
    const persisted = state.inserted.filter(entry => entry.table === "messages" && entry.values.role === "assistant").at(-1)?.values;
    const persistedOk = !!persisted && persisted.content === result.answer && JSON.stringify(JSON.parse(persisted.citationsJson)) === JSON.stringify(JSON.parse(JSON.stringify(result.citations)));
    check(persistedOk, "persisted-message-mismatch");
    // foreign evidence must not reach any provider prompt either
    for (const hit of stepHits) if (workspaceId === 1 && OTHER_TENANT_MARKERS.some(marker => hit.body.includes(marker))) leaks += 1;

    const external = stepHits.filter(hit => hit.host === EXTERNAL_HOST).length;
    const local = stepHits.filter(hit => hit.host === LOCAL_HOST).length;
    const unknownHosts = stepHits.filter(hit => hit.host !== EXTERNAL_HOST && hit.host !== LOCAL_HOST).length;
    let policyViolations = unknownHosts;
    if (external > 0 && !externalAllowed) policyViolations += 1;
    if (external > 0 && config.policy.allowExternal && !config.policy.allowMetered && evalCase.env.LLM_BILLING_MODE !== "subscription") policyViolations += 1;

    const returned = outcome?.status === "returned" ? outcome : null;
    const providerSelected = returned ? (returned.providerId.startsWith("local") ? "local" : "external") : null;
    const fallbackCount = returned ? returned.attempts.filter(attempt => attempt.providerId !== returned.providerId).length : 0;
    const attempts = outcome?.attempts ?? [];
    const budgetSkip = attempts.find(attempt => attempt.outcome.startsWith("skipped:budget:"));
    const budgetDecision: StepMetrics["budgetDecision"] = budgetSkip ? `denied:${budgetSkip.outcome.slice("skipped:budget:".length)}` : returned && returned.billingMode === "metered_api" ? "allowed" : "not_applicable";
    const timeoutObserved = outcome?.status === "failed" && outcome.reason === "timeout";

    const metrics: StepMetrics = {
      retrievalExpected: e.retrievalHit === true,
      retrievalMissExpected: e.retrievalHit === false,
      // Evidence "hit" = retrieval produced evidence that reached the model boundary (citations are
      // legitimately cleared when the model itself declines, so they are not the signal).
      retrievalHit: e.retrievalHit === undefined ? null : outcome !== null,
      citationCount: result.citations.length,
      consistentCitations: consistent,
      groundingExpected: e.grounding,
      groundingActual: result.grounding,
      groundingCorrect: result.grounding === e.grounding,
      providerSelected,
      fallbackCount,
      policyViolations,
      timeoutExpected: e.timeout === true,
      timeoutClassified: e.timeout ? timeoutObserved : null,
      reportedTokens: returned && returned.usage.source === "provider_reported" ? (returned.usage.totalTokens ?? null) : null,
      budgetDecision,
      crossWorkspaceLeaks: leaks,
      fixtureLatencyMs,
    };
    steps.push(metrics);

    check(metrics.groundingCorrect, `grounding:${result.grounding}!=${e.grounding}`);
    if (e.retrievalHit !== undefined) check(metrics.retrievalHit === e.retrievalHit, `retrieval:${metrics.retrievalHit}!=${e.retrievalHit}`);
    if (e.gatewayCalled !== undefined) check((outcome !== null) === e.gatewayCalled, `gatewayCalled:${outcome !== null}`);
    if (e.provider !== undefined) check(providerSelected === e.provider, `provider:${providerSelected}!=${e.provider}`);
    if (e.failureReason) check(outcome?.status === "failed" && outcome.reason === e.failureReason, `failureReason:${outcome?.status === "failed" ? outcome.reason : outcome?.status}!=${e.failureReason}`);
    if (e.citedFilenames) for (const name of e.citedFilenames) check(result.citations.some(c => c.filename === name), `missing-citation:${name}`);
    if (e.noCitationsFrom !== undefined) check(result.citations.every(c => state.chunks.find(s => s.chunk.id === c.chunkId)?.chunk.workspaceId !== e.noCitationsFrom), "foreign-citation");
    if (e.fallbacks !== undefined) check(fallbackCount === e.fallbacks, `fallbacks:${fallbackCount}!=${e.fallbacks}`);
    if (e.budget) check(budgetDecision === e.budget, `budget:${budgetDecision}!=${e.budget}`);
    if (e.externalHits !== undefined) check(hits.filter(hit => hit.host === EXTERNAL_HOST).length === e.externalHits, `externalHits:${hits.filter(h => h.host === EXTERNAL_HOST).length}!=${e.externalHits}`);
    if (e.localHits !== undefined) check(hits.filter(hit => hit.host === LOCAL_HOST).length === e.localHits, `localHits:${hits.filter(h => h.host === LOCAL_HOST).length}!=${e.localHits}`);
    if (e.tokens !== undefined) check(metrics.reportedTokens === e.tokens, `tokens:${metrics.reportedTokens}!=${e.tokens}`);
    if (result.grounding === "MODEL_UNAVAILABLE") check(!/\b(6am|8pm)\b/.test(result.answer), "evidence-posing-as-answer");
  }
  return { id: evalCase.id, dimension: evalCase.dimension, description: evalCase.description, passed: failures.length === 0, failures, steps };
}

const results: CaseResult[] = [];
beforeEach(() => { vi.clearAllMocks(); });
afterAll(() => {
  setProviderGatewayForTests(null);
  const target = process.env.EVAL_REPORT_PATH;
  if (!target) return;
  let commit = process.env.GITHUB_SHA ?? "unknown";
  if (commit === "unknown") { try { commit = execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { /* not a git checkout */ } }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(buildReport(results, { commit }), null, 2)}\n`);
});

describe("CONTRACT_HARNESS: capability + intelligence contracts (no real model, no network)", () => {
  for (const evalCase of CASES) {
    it(`[${evalCase.dimension}] ${evalCase.id}`, async () => {
      const result = await runCase(evalCase);
      results.push(result);
      expect(result.failures).toEqual([]);
      expect(fetchGuard).not.toHaveBeenCalled(); // nothing escaped the in-process transport
    });
  }

  it("aggregate regression thresholds hold over the whole suite", () => {
    expect(results.length).toBe(CASES.length);
    const report = buildReport(results);
    expect(report.thresholds.failures).toEqual([]);
    expect(report.thresholds.passed).toBe(true);
    expect(report.realModelQuality).toBe("NOT_MEASURED");
    expect(report.paidProviderCalls).toBe(0);
    expect(report.coreBenchmarkCoverage.complete).toBe(false); // never rounded up to a pass
  });
});
