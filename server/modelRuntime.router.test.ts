import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getWorkspaceRole: vi.fn(), getWorkspaceForUser: vi.fn(), getDb: vi.fn() }));
vi.mock("./db", () => ({ ...dbMocks, ensureWorkspace: vi.fn(), listUserWorkspaces: vi.fn(), listProjects: vi.fn(), listDocuments: vi.fn(), searchChunks: vi.fn(), getConversationMessages: vi.fn(), projects: {}, documents: {}, documentChunks: {}, conversations: {}, messages: {} }));
vi.mock("./storage", () => ({ storagePut: vi.fn() }));
vi.mock("./provenance", () => ({ extractDocument: vi.fn() }));
vi.mock("./embeddings", () => ({ embeddingStatus: () => ({ status: "disabled" }), tryEmbed: vi.fn(), serializeEmbedding: vi.fn() }));

import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

const ctx = (id: number | null): TrpcContext => ({ req: {} as never, res: { headersSent: false, setHeader: vi.fn() } as never, requestId: "t", user: id === null ? null : { id, openId: `u${id}`, name: "U", email: "u@example.invalid", loginMethod: "test", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() } as never });

describe("modelRuntime.status authorisation", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it("rejects anonymous callers", async () => {
    await expect(appRouter.createCaller(ctx(null)).modelRuntime.status({ workspaceId: 1 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
  it("rejects a non-owner member and a stranger", async () => {
    dbMocks.getWorkspaceRole.mockResolvedValue("member");
    await expect(appRouter.createCaller(ctx(5)).modelRuntime.status({ workspaceId: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    dbMocks.getWorkspaceRole.mockResolvedValue(null);
    await expect(appRouter.createCaller(ctx(6)).modelRuntime.status({ workspaceId: 99 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("returns a secret-free snapshot to the workspace owner", async () => {
    dbMocks.getWorkspaceRole.mockResolvedValue("owner");
    const r = await appRouter.createCaller(ctx(7)).modelRuntime.status({ workspaceId: 1 });
    expect(r.providers.length).toBeGreaterThan(0); expect(r.workspace.costBasis).toMatch(/not an invoice/);
    expect(JSON.stringify(r)).not.toMatch(/https?:\/\/|apiKey|authorization/i);
    expect(dbMocks.getWorkspaceRole).toHaveBeenCalledWith(7, 1);
  });
});
