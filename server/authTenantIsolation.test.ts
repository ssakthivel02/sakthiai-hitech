import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getWorkspaceForUser: vi.fn(),
  listUserWorkspaces: vi.fn(),
  ensureWorkspace: vi.fn(),
  listProjects: vi.fn(),
  listDocuments: vi.fn(),
  searchChunks: vi.fn(),
  getConversationMessages: vi.fn(),
  getDb: vi.fn(),
}));

vi.mock("./db", () => ({
  ...dbMocks,
  projects: {},
  documents: {},
  documentChunks: {},
  conversations: {},
  messages: {},
}));

vi.mock("./storage", () => ({ storagePut: vi.fn() }));
vi.mock("./provenance", () => ({ extractDocument: vi.fn() }));
vi.mock("./embeddings", () => ({
  embeddingStatus: () => ({ status: "disabled" }),
  tryEmbed: vi.fn(),
  serializeEmbedding: vi.fn(),
}));
vi.mock("./_core/llm", () => ({ invokeLLM: vi.fn() }));

import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

function responseStub(): TrpcContext["res"] {
  return {
    headersSent: false,
    setHeader: vi.fn(),
  } as unknown as TrpcContext["res"];
}

function userContext(id = 101): TrpcContext {
  const now = new Date();
  return {
    req: {} as TrpcContext["req"],
    res: responseStub(),
    requestId: "tenant-isolation-test",
    user: {
      id,
      openId: `user-${id}`,
      name: `User ${id}`,
      email: `user-${id}@example.invalid`,
      loginMethod: "test",
      role: "user",
      createdAt: now,
      updatedAt: now,
      lastSignedIn: now,
    },
  };
}

function anonymousContext(): TrpcContext {
  return {
    req: {} as TrpcContext["req"],
    res: responseStub(),
    requestId: "anonymous-test",
    user: null,
  };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("auth/session and tenant-isolation negative matrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.getWorkspaceForUser.mockResolvedValue(null);
  });

  it("rejects anonymous access to protected workspace procedures", async () => {
    const caller = appRouter.createCaller(anonymousContext());
    await expectCode(caller.workspace.list(), "UNAUTHORIZED");
    expect(dbMocks.listUserWorkspaces).not.toHaveBeenCalled();
  });

  it("rejects project listing for a workspace the authenticated user does not belong to", async () => {
    const caller = appRouter.createCaller(userContext(101));
    await expectCode(caller.projects.list({ workspaceId: 202 }), "FORBIDDEN");
    expect(dbMocks.getWorkspaceForUser).toHaveBeenCalledWith(101, 202);
    expect(dbMocks.listProjects).not.toHaveBeenCalled();
  });

  it("rejects document listing for a foreign workspace before any document query", async () => {
    const caller = appRouter.createCaller(userContext(101));
    await expectCode(caller.files.list({ workspaceId: 202 }), "FORBIDDEN");
    expect(dbMocks.getWorkspaceForUser).toHaveBeenCalledWith(101, 202);
    expect(dbMocks.listDocuments).not.toHaveBeenCalled();
  });

  it("rejects conversation history access for a foreign workspace before message lookup", async () => {
    const caller = appRouter.createCaller(userContext(101));
    await expectCode(
      caller.chat.history({ workspaceId: 202, conversationId: 303 }),
      "FORBIDDEN",
    );
    expect(dbMocks.getWorkspaceForUser).toHaveBeenCalledWith(101, 202);
    expect(dbMocks.getConversationMessages).not.toHaveBeenCalled();
    expect(dbMocks.getDb).not.toHaveBeenCalled();
  });

  it("rejects chat send into a foreign workspace before retrieval, persistence, or LLM work", async () => {
    const caller = appRouter.createCaller(userContext(101));
    await expectCode(
      caller.chat.send({ workspaceId: 202, message: "cross-tenant probe", language: "en" }),
      "FORBIDDEN",
    );
    expect(dbMocks.getWorkspaceForUser).toHaveBeenCalledWith(101, 202);
    expect(dbMocks.getDb).not.toHaveBeenCalled();
    expect(dbMocks.searchChunks).not.toHaveBeenCalled();
  });
});
