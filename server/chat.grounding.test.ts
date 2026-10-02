import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import type { User } from "../drizzle/schema";
import { createProviderGateway, loadGatewayConfig, setProviderGatewayForTests } from "./gateway";
import { normalizeCompletion } from "./gateway/openaiCompatible";

/**
 * Behavioural tests for chat.send grounding. The real tRPC procedure, real
 * retrieval ranking (rankChunkCandidates, embeddings unavailable) and real
 * grounding resolution run, and chat now goes through the REAL Provider Gateway
 * (routing, circuit breaker, error classification). Only the persistence layer
 * (in-memory) and the provider TRANSPORT (a stub adapter standing in for the HTTP
 * call, backed by llm.invokeLLM) are replaced, so no paid or external model call
 * can occur (a global fetch spy proves it).
 */

type Row = {
  id: number; documentId: number; workspaceId: number; chunkIndex: number;
  page: number | null; section: string | null; paragraph: number | null;
  content: string; sourceStart: number | null; sourceEnd: number | null; embeddingJson: string | null;
};

const state = vi.hoisted(() => ({
  chunks: [] as Array<{ chunk: any; document: { filename: string; mimeType: string } }>,
  inserted: [] as Array<{ table: string; values: any }>,
}));
const llm = vi.hoisted(() => ({ invokeLLM: vi.fn() }));
let gatewayUnderTest: ReturnType<typeof createProviderGateway>;
let gatewayInvoke: ReturnType<typeof vi.spyOn>;

vi.mock("./db", async () => {
  const schema = await vi.importActual<typeof import("../drizzle/schema")>("../drizzle/schema");
  const retrieval = await vi.importActual<typeof import("./retrieval")>("./retrieval");
  const tableName = (table: unknown) =>
    table === schema.conversations ? "conversations" : table === schema.messages ? "messages" : "other";
  const select = () => {
    const chain: any = { from: () => chain, where: () => chain, orderBy: () => chain, limit: async () => [{ id: 11 }] };
    return chain;
  };
  return {
    getDb: vi.fn(async () => ({
      select,
      insert: (table: unknown) => ({
        values: async (values: any) => { state.inserted.push({ table: tableName(table), values }); },
      }),
    })),
    getWorkspaceForUser: vi.fn(async (_userId: number, workspaceId: number) => ({ id: workspaceId })),
    // Same scoring path as db.searchChunks, over in-memory tenant-filtered rows.
    searchChunks: vi.fn(async (workspaceId: number, query: string) =>
      retrieval.rankChunkCandidates(
        state.chunks.filter(row => row.chunk.workspaceId === workspaceId),
        query,
        null,
      ),
    ),
    ensureWorkspace: vi.fn(),
    listUserWorkspaces: vi.fn(),
    listProjects: vi.fn(),
    listDocuments: vi.fn(),
    getConversationMessages: vi.fn(),
    getUserByOpenId: vi.fn(),
    projects: schema.projects,
    documents: schema.documents,
    documentChunks: schema.documentChunks,
    conversations: schema.conversations,
    messages: schema.messages,
  };
});
vi.mock("./storage", () => ({ storagePut: vi.fn() }));
vi.mock("./provenance", () => ({ extractDocument: vi.fn() }));
vi.mock("./security/malwareScanner", () => ({ malwareScannerConfigurationStatus: () => "not_configured" }));
vi.mock("./creator/router", async () => {
  const { router } = await import("./_core/trpc");
  return { creatorRouter: router({}) };
});

import { appRouter } from "./routers";
import { embeddingStatus } from "./embeddings";
import { modelUnavailableMessage, resolveGroundedOutcome } from "./grounding";
import type { TrpcContext } from "./_core/context";

const TAMIL_QUERY = "முருகன் கோவில் எங்கு உள்ளது?";
const TAMIL_CHUNK = "முருகன் கோவில் பழநியில் உள்ளது; எங்கு செல்வது என்பதை வழிகாட்டி கூறும்.";
const ENGLISH_CHUNK = "The Murugan temple opens at 6am and closes at 8pm.";
const MIXED_CHUNK = "முருகன் வழிபாடு (Murugan worship) 2026 timings";
const RAIN_CHUNK = "பருவமழை காலத்தில் வயல்களில் நீர் நிறைந்தது";

function chunk(id: number, content: string, filename: string, workspaceId = 1) {
  const row: Row = { id, documentId: id * 10, workspaceId, chunkIndex: 0, page: 1, section: null, paragraph: null, content, sourceStart: 0, sourceEnd: content.length, embeddingJson: null };
  return { chunk: row, document: { filename, mimeType: "text/plain" } };
}

let nextUserId = 100;
function installGateway() {
  // Real gateway, real routing/breaker; only the HTTP transport is stubbed. The stub reuses the
  // adapter's real response normalisation so malformed/empty replies fail exactly as in production.
  const config = loadGatewayConfig({ LOCAL_LLM_API_URL: "http://127.0.0.1:9", LOCAL_LLM_MODEL: "test-model" });
  gatewayUnderTest = createProviderGateway(config, {
    log: () => undefined,
    adapterFactory: binding => ({
      providerId: binding.providerId,
      complete: async call => ({ ...normalizeCompletion(await llm.invokeLLM({ messages: call.messages })), attempts: 1 }),
    }),
  });
  gatewayInvoke = vi.spyOn(gatewayUnderTest, "invoke");
  setProviderGatewayForTests(gatewayUnderTest);
}

function caller() {
  const user = { id: nextUserId++, openId: "u", email: null, name: "u", loginMethod: "test", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() } as User;
  const ctx: TrpcContext = {
    user,
    req: { protocol: "https", headers: {} } as Request,
    res: { headersSent: false, setHeader: vi.fn(), clearCookie: vi.fn() } as unknown as TrpcContext["res"],
    requestId: "grounding-test",
  };
  return appRouter.createCaller(ctx);
}
const assistantRow = () => state.inserted.filter(r => r.table === "messages" && r.values.role === "assistant").at(-1)!.values;
const fetchSpy = vi.spyOn(globalThis, "fetch");

describe("chat.send grounding truthfulness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.inserted = [];
    state.chunks = [
      chunk(1, RAIN_CHUNK, "rain.txt"),
      chunk(2, TAMIL_CHUNK, "temples-ta.txt"),
      chunk(3, ENGLISH_CHUNK, "temples-en.txt"),
      chunk(4, MIXED_CHUNK, "mixed.txt"),
      chunk(5, "முருகன் கோவில் ரகசிய ஆவணம்", "other-tenant.txt", 2),
    ];
    llm.invokeLLM.mockReset();
    installGateway();
  });
  afterEach(() => {
    expect(fetchSpy).not.toHaveBeenCalled(); // no external/paid provider reached from tests
  });

  it("retrieval empty -> INSUFFICIENT_EVIDENCE, model never called, no citations", async () => {
    const result = await caller().chat.send({ workspaceId: 1, message: "quantum chromodynamics lattice" });
    expect(gatewayInvoke).not.toHaveBeenCalled(); // no evidence -> the gateway is never reached
    expect(result.grounding).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.answer).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.citations).toEqual([]);
    expect(llm.invokeLLM).not.toHaveBeenCalled();
    expect(assistantRow()).toMatchObject({ content: "INSUFFICIENT_EVIDENCE", citationsJson: "[]" });
  });

  it("evidence + model success -> GROUNDED_EVIDENCE with internally consistent citations", async () => {
    llm.invokeLLM.mockResolvedValue({ choices: [{ message: { content: "The temple opens at 6am. [1]" } }] });
    const result = await caller().chat.send({ workspaceId: 1, message: "Murugan temple opening hours" });

    expect(result.grounding).toBe("GROUNDED_EVIDENCE");
    expect(result.answer).toBe("The temple opens at 6am. [1]");
    expect(result.citations.length).toBeGreaterThan(0);
    for (const citation of result.citations) {
      const source = state.chunks.find(row => row.chunk.id === citation.chunkId)!;
      expect(source.chunk.workspaceId).toBe(1); // tenant-scoped evidence only
      expect(source.chunk.content.startsWith(citation.excerpt.slice(0, 20))).toBe(true);
      expect(citation.filename).toBe(source.document.filename);
      expect(citation.retrievalScore).toBeGreaterThan(0);
    }
    expect(JSON.parse(assistantRow().citationsJson)).toEqual(JSON.parse(JSON.stringify(result.citations)));
    expect(assistantRow().content).toBe(result.answer);
    const prompt = llm.invokeLLM.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain("Answer in English");
    expect(prompt).toContain("Use only the supplied evidence");
  });

  it("evidence + model throws -> never GROUNDED_EVIDENCE, no fabricated answer, evidence preserved", async () => {
    llm.invokeLLM.mockRejectedValue(new Error("LLM invoke failed: 503 Service Unavailable"));
    const result = await caller().chat.send({ workspaceId: 1, message: "Murugan temple opening hours" });

    expect(result.grounding).toBe("MODEL_UNAVAILABLE");
    expect(result.grounding).not.toBe("GROUNDED_EVIDENCE");
    expect(result.answer).toBe(modelUnavailableMessage("en", result.citations.length));
    expect(result.answer).not.toMatch(/I found \d+ relevant source excerpt|I can help with that/);
    expect(result.answer).not.toContain("6am"); // no evidence text posing as an answer
    expect(result.citations.map(c => c.chunkId)).toContain(3); // useful evidence preserved
    expect(JSON.parse(assistantRow().citationsJson)).toEqual(JSON.parse(JSON.stringify(result.citations)));
    expect(assistantRow().content).toBe(result.answer);
  });

  it("provider timeout/abort/rate-limit failures are all MODEL_UNAVAILABLE", async () => {
    const failures = [
      Object.assign(new Error("The operation timed out"), { name: "TimeoutError" }),
      Object.assign(new Error("aborted"), { name: "AbortError" }),
      new Error("LLM invoke failed: 429 Too Many Requests"),
      new Error("LLM_API_URL is not configured"),
      "plain string rejection",
    ];
    for (const failure of failures) {
      llm.invokeLLM.mockReset();
      llm.invokeLLM.mockRejectedValue(failure);
      const result = await caller().chat.send({ workspaceId: 1, message: "Murugan temple opening hours" });
      expect(result.grounding, String(failure)).toBe("MODEL_UNAVAILABLE");
      expect(result.citations.length).toBeGreaterThan(0);
    }
  });

  it("an empty or malformed model response is not a grounded answer", async () => {
    const responses: unknown[] = [
      { choices: [{ message: { content: "" } }] },
      { choices: [{ message: { content: "   \n" } }] },
      { choices: [{ message: { content: null } }] },
      { choices: [{ message: { content: [{ type: "text", text: "x" }] } }] },
      { choices: [] },
      {},
    ];
    for (const response of responses) {
      llm.invokeLLM.mockReset();
      llm.invokeLLM.mockResolvedValue(response);
      const result = await caller().chat.send({ workspaceId: 1, message: "Murugan temple opening hours" });
      expect(result.grounding, JSON.stringify(response)).toBe("MODEL_UNAVAILABLE");
    }
  });

  it("a model that declares the evidence insufficient yields INSUFFICIENT_EVIDENCE with no citations", async () => {
    for (const content of ["INSUFFICIENT_EVIDENCE", "  INSUFFICIENT_EVIDENCE.\n"]) {
      llm.invokeLLM.mockReset();
      llm.invokeLLM.mockResolvedValue({ choices: [{ message: { content } }] });
      const result = await caller().chat.send({ workspaceId: 1, message: "Murugan temple opening hours" });
      expect(result.grounding).toBe("INSUFFICIENT_EVIDENCE");
      expect(result.answer).toBe("INSUFFICIENT_EVIDENCE");
      expect(result.citations).toEqual([]);
      expect(assistantRow().citationsJson).toBe("[]");
    }
  });

  it("Tamil query retrieves Tamil evidence with embeddings unavailable and grounds the answer", async () => {
    expect(embeddingStatus().status).toBe("unavailable");
    llm.invokeLLM.mockResolvedValue({ choices: [{ message: { content: "முருகன் கோவில் பழநியில் உள்ளது. [1]" } }] });
    const result = await caller().chat.send({ workspaceId: 1, message: TAMIL_QUERY, language: "ta" });

    expect(result.grounding).toBe("GROUNDED_EVIDENCE");
    expect(result.citations.map(c => c.chunkId)).toEqual(expect.arrayContaining([2]));
    expect(result.citations[0]).toMatchObject({ chunkId: 2, filename: "temples-ta.txt", retrievalMethod: "lexical" });
    expect(result.citations.some(c => c.chunkId === 1)).toBe(false); // irrelevant Tamil content excluded
    expect(result.citations.some(c => c.chunkId === 5)).toBe(false); // other tenant's chunk excluded
    const prompt = llm.invokeLLM.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain("Answer in Tamil");
    expect(prompt).toContain(TAMIL_CHUNK);
  });

  it("Tamil query over only-irrelevant Tamil evidence -> INSUFFICIENT_EVIDENCE (no false positive, model not called)", async () => {
    state.chunks = [chunk(1, RAIN_CHUNK, "rain.txt")];
    const result = await caller().chat.send({ workspaceId: 1, message: TAMIL_QUERY, language: "ta" });
    expect(result.grounding).toBe("INSUFFICIENT_EVIDENCE");
    expect(llm.invokeLLM).not.toHaveBeenCalled();
  });

  it("Tamil query + model failure -> MODEL_UNAVAILABLE in Tamil, evidence preserved", async () => {
    llm.invokeLLM.mockRejectedValue(new Error("down"));
    const result = await caller().chat.send({ workspaceId: 1, message: TAMIL_QUERY, language: "ta" });
    expect(result.grounding).toBe("MODEL_UNAVAILABLE");
    expect(result.answer).toBe(modelUnavailableMessage("ta", result.citations.length));
    expect(result.answer).toMatch(/[஀-௿]/u);
    expect(result.citations[0]).toMatchObject({ chunkId: 2 });
  });

  it("mixed-language evidence and query ground against both Tamil and English chunks", async () => {
    llm.invokeLLM.mockResolvedValue({ choices: [{ message: { content: "Both sources cover Murugan. [1][2]" } }] });
    const result = await caller().chat.send({ workspaceId: 1, message: "Murugan temple முருகன் கோவில்" });
    expect(result.grounding).toBe("GROUNDED_EVIDENCE");
    const ids = result.citations.map(c => c.chunkId);
    expect(ids).toEqual(expect.arrayContaining([2, 3, 4]));
    expect(ids).not.toContain(1);
    const prompt = llm.invokeLLM.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain(ENGLISH_CHUNK);
    expect(prompt).toContain(MIXED_CHUNK);
  });
});

describe("resolveGroundedOutcome", () => {
  const base = { language: "en" as const, evidenceCount: 3 };
  it("only a non-empty model answer is grounded", () => {
    expect(resolveGroundedOutcome({ ...base, model: { status: "returned", content: "ok [1]" } })).toEqual({ answer: "ok [1]", grounding: "GROUNDED_EVIDENCE", includeCitations: true });
    for (const content of ["", "  ", null, undefined, 7, {}, []]) {
      expect(resolveGroundedOutcome({ ...base, model: { status: "returned", content } }).grounding).toBe("MODEL_UNAVAILABLE");
    }
    expect(resolveGroundedOutcome({ ...base, model: { status: "failed" } })).toMatchObject({ grounding: "MODEL_UNAVAILABLE", includeCitations: true });
  });
  it("model-declared insufficiency drops citations", () => {
    expect(resolveGroundedOutcome({ ...base, model: { status: "returned", content: "INSUFFICIENT_EVIDENCE" } })).toEqual({ answer: "INSUFFICIENT_EVIDENCE", grounding: "INSUFFICIENT_EVIDENCE", includeCitations: false });
  });
  it("a model answer that merely mentions the sentinel is still an answer", () => {
    expect(resolveGroundedOutcome({ ...base, model: { status: "returned", content: "Answer: x. (not INSUFFICIENT_EVIDENCE)" } }).grounding).toBe("GROUNDED_EVIDENCE");
  });
});

describe("chat.send -> Provider Gateway boundary", () => {
  beforeEach(() => {
    state.inserted = [];
    state.chunks = [chunk(2, TAMIL_CHUNK, "temples-ta.txt"), chunk(3, ENGLISH_CHUNK, "temples-en.txt")];
    llm.invokeLLM.mockReset();
    installGateway();
  });

  it("evidence path calls the gateway exactly once with the caller's workspace and request id, and surfaces provider metadata", async () => {
    llm.invokeLLM.mockResolvedValue({ choices: [{ message: { content: "The temple opens at 6am. [1]" } }] });
    const result = await caller().chat.send({ workspaceId: 1, message: "Murugan temple timing" });
    expect(gatewayInvoke).toHaveBeenCalledTimes(1);
    const call = gatewayInvoke.mock.calls[0][0] as { workspaceId: number; requestId: string; intents: string[]; messages: unknown[] };
    expect(call.workspaceId).toBe(1);
    expect(call.requestId).toBeTruthy();
    expect(call.intents).toEqual(["conversation"]);
    expect(result.grounding).toBe("GROUNDED_EVIDENCE");
    expect(result.observability.gateway).toMatchObject({ status: "returned", providerId: "local-openai-compatible", attempts: 1 });
  });

  it.each([
    ["no provider configured", undefined, "no_eligible_provider"],
    ["provider failure", new Error("boom"), "network"],
  ])("gateway failure (%s) -> MODEL_UNAVAILABLE with evidence preserved and the reason exposed", async (_label, error, reason) => {
    if (!error) setProviderGatewayForTests(createProviderGateway(loadGatewayConfig({}), { log: () => undefined })); // nothing configured
    else llm.invokeLLM.mockRejectedValue(error);
    const result = await caller().chat.send({ workspaceId: 1, message: "Murugan temple timing" });
    expect(result.grounding).toBe("MODEL_UNAVAILABLE");
    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.observability.gateway).toMatchObject({ status: "failed", failureReason: reason });
  });

  it("a gateway that throws unexpectedly still yields MODEL_UNAVAILABLE with evidence, never a grounded answer", async () => {
    gatewayInvoke.mockRejectedValue(new Error("unexpected"));
    const result = await caller().chat.send({ workspaceId: 1, message: "Murugan temple timing" });
    expect(result.grounding).toBe("MODEL_UNAVAILABLE");
    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.observability.gateway).toMatchObject({ status: "failed", failureReason: "internal_error" });
  });
});
