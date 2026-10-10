import type { Express, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "../drizzle/schema";

const sessionState = vi.hoisted(() => ({ user: null as User | null }));
const dbMocks = vi.hoisted(() => ({
  getUserByOpenId: vi.fn(async () => sessionState.user ?? undefined),
  advanceUserSessionGeneration: vi.fn(async (openId: string) => {
    if (!sessionState.user || sessionState.user.openId !== openId) {
      throw new Error("User not found");
    }

    const nextGeneration = new Date(
      Math.floor(sessionState.user.lastSignedIn.getTime() / 1_000) * 1_000 + 1_000,
    );
    sessionState.user = { ...sessionState.user, lastSignedIn: nextGeneration };
    return nextGeneration;
  }),
}));

vi.mock("./db", () => ({
  ...dbMocks,
  getDb: vi.fn(),
  ensureWorkspace: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  listUserWorkspaces: vi.fn(),
  listProjects: vi.fn(),
  listDocuments: vi.fn(),
  searchChunks: vi.fn(),
  getConversationMessages: vi.fn(),
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
vi.mock("./security/malwareScanner", () => ({
  malwareScannerConfigurationStatus: () => "not_configured",
}));
vi.mock("./creator/router", async () => {
  const { router } = await import("./_core/trpc");
  return { creatorRouter: router({}) };
});

vi.mock("./_core/env", async importOriginal => {
  const actual = await importOriginal<typeof import("./_core/env")>();
  return {
    ...actual,
    ENV: {
      ...actual.ENV,
      appId: "sakthiai-logout-test",
      cookieSecret: "logout-test-secret-with-sufficient-entropy",
    },
  };
});

import { appRouter } from "./routers";
import { COOKIE_NAME } from "../shared/const";
import type { TrpcContext } from "./_core/context";
import { registerOAuthRoutes } from "./_core/oauth";
import { sdk } from "./_core/sdk";
import { sessionGenerationFromDate } from "./_core/sessionRevocation";

type CookieCall = {
  name: string;
  options: Record<string, unknown>;
};

function createUser(): User {
  return {
    id: 1,
    openId: "sample-user",
    email: "sample@example.com",
    name: "Sample User",
    loginMethod: "test",
    role: "user",
    createdAt: new Date("2026-09-25T08:00:00.000Z"),
    updatedAt: new Date("2026-09-25T08:00:00.000Z"),
    lastSignedIn: new Date("2026-09-25T08:00:00.000Z"),
  };
}

async function createCredential() {
  const user = sessionState.user;
  if (!user) throw new Error("Test user is missing");
  const sessionGeneration = sessionGenerationFromDate(user.lastSignedIn);
  if (sessionGeneration === null) throw new Error("Test generation is invalid");

  const token = await sdk.createSessionToken(user.openId, {
    name: user.name ?? "User",
    sessionGeneration,
  });
  const req = {
    protocol: "https",
    headers: { authorization: `Bearer ${token}` },
  } as Request;

  return { req, token, user: await sdk.authenticateRequest(req) };
}

function createAuthContext(req: Request, user: User): { ctx: TrpcContext; clearedCookies: CookieCall[] } {
  const clearedCookies: CookieCall[] = [];

  const ctx: TrpcContext = {
    user,
    req,
    res: {
      headersSent: false,
      setHeader: vi.fn(),
      clearCookie: (name: string, options: Record<string, unknown>) => {
        clearedCookies.push({ name, options });
      },
    } as TrpcContext["res"],
    requestId: "logout-revocation-test",
  };

  return { ctx, clearedCookies };
}

describe("auth.logout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.user = createUser();
  });

  it("revokes the authenticated session before reporting success", async () => {
    const { req, user } = await createCredential();
    const { ctx, clearedCookies } = createAuthContext(req, user);
    const caller = appRouter.createCaller(ctx);

    const result = await caller.auth.logout();

    expect(result).toEqual({ success: true });
    expect(dbMocks.advanceUserSessionGeneration).toHaveBeenCalledWith(user.openId);
    expect(clearedCookies).toHaveLength(1);
    expect(clearedCookies[0]?.name).toBe(COOKIE_NAME);
    expect(clearedCookies[0]?.options).toMatchObject({
      maxAge: -1,
      secure: true,
      sameSite: "lax",
      httpOnly: true,
      path: "/",
    });
    await expect(sdk.authenticateRequest(req)).rejects.toThrow("Session revoked");
  });

  it("keeps POST /api/auth/revoke-all replay-resistant", async () => {
    const { req } = await createCredential();
    let revokeAllHandler:
      | ((request: Request, response: Response) => void | Promise<void>)
      | undefined;
    const app = {
      get: vi.fn(),
      post: vi.fn((path: string, handler: typeof revokeAllHandler) => {
        if (path === "/api/auth/revoke-all") revokeAllHandler = handler;
      }),
    } as unknown as Express;
    registerOAuthRoutes(app);
    expect(revokeAllHandler).toBeTypeOf("function");

    const responseState = { statusCode: 200 };
    const res = {
      headersSent: false,
      clearCookie: vi.fn(),
      setHeader: vi.fn(),
      status(code: number) {
        responseState.statusCode = code;
        return this;
      },
      json() {
        return this;
      },
      end() {
        return this;
      },
    } as unknown as Response;

    await revokeAllHandler!(req, res);

    expect(responseState.statusCode).toBe(204);
    expect(res.clearCookie).toHaveBeenCalledWith(
      COOKIE_NAME,
      expect.objectContaining({ secure: true, sameSite: "lax", httpOnly: true, path: "/" }),
    );
    await expect(sdk.authenticateRequest(req)).rejects.toThrow("Session revoked");
  });
});
