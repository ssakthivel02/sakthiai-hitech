import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "../drizzle/schema";

/**
 * Behavioural tests for GET /api/storage/*. The real Express route, the real
 * SakthiAI session machinery (sdk.authenticateRequest, including revocation) and
 * the real authorization resolver run. Only persistence and the S3 signer are
 * replaced: persistence by in-memory tables (so ownership comes from "database"
 * rows, never from key names) and the signer by a spy so every test can prove
 * that no signed URL is minted for a rejected request.
 */

const SIGNED = "https://signed.example.invalid/object?sig=test";

const store = vi.hoisted(() => ({
  users: [] as User[],
  memberships: [] as Array<{ userId: number; workspaceId: number }>,
  documents: [] as Array<{ workspaceId: number; storageKey: string | null }>,
  creatorAssets: [] as Array<{ workspaceId: number; storageKey: string }>,
  dbAvailable: true,
}));

const signer = vi.hoisted(() => ({ storageGetSignedUrl: vi.fn() }));

vi.mock("./db", () => ({
  getUserByOpenId: vi.fn(async (openId: string) => store.users.find(user => user.openId === openId)),
  advanceUserSessionGeneration: vi.fn(),
  getWorkspaceForUser: vi.fn(async (userId: number, workspaceId: number) =>
    store.memberships.some(m => m.userId === userId && m.workspaceId === workspaceId)
      ? { id: workspaceId }
      : undefined,
  ),
  // Emulates a case-insensitive SQL collation so the resolver's exact-match guard is exercised.
  findStorageObjectOwners: vi.fn(async (key: string) => {
    if (!store.dbAvailable) throw new Error("Database unavailable");
    const ci = (a: string | null) => a !== null && a.toLowerCase() === key.toLowerCase();
    return [
      ...store.documents.filter(row => ci(row.storageKey)),
      ...store.creatorAssets.filter(row => ci(row.storageKey)),
    ];
  }),
}));

vi.mock("./storage", () => signer);

vi.mock("./_core/env", async importOriginal => {
  const actual = await importOriginal<typeof import("./_core/env")>();
  return {
    ...actual,
    ENV: { ...actual.ENV, appId: "sakthiai-storage-test", cookieSecret: "storage-test-secret-with-sufficient-entropy" },
  };
});

import { COOKIE_NAME } from "../shared/const";
import { registerStorageProxy } from "./_core/storageProxy";
import { sdk } from "./_core/sdk";
import { sessionGenerationFromDate } from "./_core/sessionRevocation";

const DOC_KEY = "1/1/report_ab12cd34.pdf"; // workspace 1 document
const ASSET_KEY = "creator/5/shots/3/generation-9.png"; // workspace 1 creator asset; key names no workspace
const FOREIGN_KEY = "2/2/notes_ffeeddcc.txt"; // workspace 2 document
const LOOKALIKE_KEY = "1/1/lookalike_deadbeef.pdf"; // key *names* user1/workspace1 but row belongs to workspace 2

function makeUser(id: number, openId: string): User {
  return {
    id,
    openId,
    email: `${openId}@example.test`,
    name: openId,
    loginMethod: "test",
    role: "user",
    createdAt: new Date("2026-09-26T00:00:00.000Z"),
    updatedAt: new Date("2026-09-26T00:00:00.000Z"),
    lastSignedIn: new Date("2026-09-26T00:00:00.000Z"),
  };
}

async function tokenFor(openId: string): Promise<string> {
  const user = store.users.find(candidate => candidate.openId === openId)!;
  return sdk.createSessionToken(openId, {
    name: openId,
    sessionGeneration: sessionGenerationFromDate(user.lastSignedIn)!,
  });
}

type Reply = { status: number; location?: string; body: string };

/** Raw HTTP so dot-segments/encodings reach the server exactly as written. */
function request(port: number, path: string, headers: Record<string, string> = {}, method = "GET"): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("GET /api/storage/* tenant-safe authorization", () => {
  let server: http.Server;
  let port: number;
  let cookieA: Record<string, string>;
  let cookieB: Record<string, string>;
  const get = (path: string, headers?: Record<string, string>) => request(port, path, headers);

  beforeAll(async () => {
    const app = express();
    registerStorageProxy(app);
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signer.storageGetSignedUrl.mockImplementation(async () => SIGNED);
    store.dbAvailable = true;
    store.users = [makeUser(1, "tenant-a-user"), makeUser(2, "tenant-b-user")];
    store.memberships = [
      { userId: 1, workspaceId: 1 },
      { userId: 2, workspaceId: 2 },
    ];
    store.documents = [
      { workspaceId: 1, storageKey: DOC_KEY },
      { workspaceId: 2, storageKey: FOREIGN_KEY },
      { workspaceId: 2, storageKey: LOOKALIKE_KEY },
      { workspaceId: 1, storageKey: null },
    ];
    store.creatorAssets = [{ workspaceId: 1, storageKey: ASSET_KEY }];
    cookieA = { cookie: `${COOKIE_NAME}=${await tokenFor("tenant-a-user")}` };
    cookieB = { cookie: `${COOKIE_NAME}=${await tokenFor("tenant-b-user")}` };
  });

  it("1. denies unauthenticated requests (no credential, garbage credential, HEAD) without signing", async () => {
    for (const reply of [
      await get(`/api/storage/${DOC_KEY}`),
      await get(`/api/storage/${DOC_KEY}`, { cookie: `${COOKIE_NAME}=not-a-jwt` }),
      await get(`/api/storage/${DOC_KEY}`, { authorization: "Bearer not-a-jwt" }),
      await request(port, `/api/storage/${DOC_KEY}`, {}, "HEAD"),
    ]) {
      expect(reply.status).toBe(401);
      expect(reply.location).toBeUndefined();
    }
    expect(signer.storageGetSignedUrl).not.toHaveBeenCalled();
  });

  it("2. allows an authenticated member to fetch their own document and creator asset (signing the persisted key)", async () => {
    const doc = await get(`/api/storage/${DOC_KEY}`, cookieA);
    expect(doc.status).toBe(307);
    expect(doc.location).toBe(SIGNED);
    expect(signer.storageGetSignedUrl).toHaveBeenLastCalledWith(DOC_KEY);

    const asset = await get(`/api/storage/${ASSET_KEY}`, cookieA);
    expect(asset.status).toBe(307);
    expect(signer.storageGetSignedUrl).toHaveBeenLastCalledWith(ASSET_KEY);
    expect(signer.storageGetSignedUrl).toHaveBeenCalledTimes(2);
  });

  it("2b. accepts Bearer authentication through the same canonical machinery", async () => {
    const reply = await get(`/api/storage/${DOC_KEY}`, { authorization: `Bearer ${await tokenFor("tenant-a-user")}` });
    expect(reply.status).toBe(307);
  });

  it("3. denies tenant B even when it knows tenant A's exact storage key (and vice versa)", async () => {
    expect((await get(`/api/storage/${DOC_KEY}`, cookieB)).status).toBe(404);
    expect((await get(`/api/storage/${ASSET_KEY}`, cookieB)).status).toBe(404);
    expect((await get(`/api/storage/${FOREIGN_KEY}`, cookieA)).status).toBe(404);
    expect(signer.storageGetSignedUrl).not.toHaveBeenCalled();
  });

  it("4. denies guessed keys", async () => {
    for (const key of ["1/1/report.pdf", "1/1/secret_00000000.pdf", "creator/1/1/audio-master/a.wav", "2/2/notes.txt"]) {
      expect((await get(`/api/storage/${key}`, cookieA)).status).toBe(404);
      expect((await get(`/api/storage/${key}`, cookieB)).status).toBe(404);
    }
    expect(signer.storageGetSignedUrl).not.toHaveBeenCalled();
  });

  it("5. denies a valid-looking user/workspace prefix with an altered suffix or prefix", async () => {
    for (const key of ["1/1/report_ab12cd35.pdf", "1/1/report_ab12cd34.pdf.bak", "1/1/report_ab12cd34", "2/2/report_ab12cd34.pdf", "1/2/report_ab12cd34.pdf"]) {
      expect((await get(`/api/storage/${key}`, cookieA)).status).toBe(404);
      expect((await get(`/api/storage/${key}`, cookieB)).status).toBe(404);
    }
    expect(signer.storageGetSignedUrl).not.toHaveBeenCalled();
  });

  it("6. returns the identical safe 404 for nonexistent, malformed and forbidden objects (no existence oracle)", async () => {
    const forbidden = await get(`/api/storage/${DOC_KEY}`, cookieB);
    const missing = await get(`/api/storage/1/1/never-existed_12345678.pdf`, cookieB);
    const empty = await get(`/api/storage/`, cookieB);
    const nullKeyRow = await get(`/api/storage/null`, cookieA);
    for (const reply of [forbidden, missing, empty, nullKeyRow]) {
      expect(reply.status).toBe(404);
      expect(reply.body).toBe(forbidden.body);
    }
    expect(forbidden.body).not.toMatch(/bucket|key|workspace|tenant|sql|s3/i);
    expect(signer.storageGetSignedUrl).not.toHaveBeenCalled();
  });

  it("7. denies a revoked session (and a deleted user) without signing", async () => {
    expect((await get(`/api/storage/${DOC_KEY}`, cookieA)).status).toBe(307);
    signer.storageGetSignedUrl.mockClear();

    // Same effect as sdk.revokeAllSessions(): the persisted generation advances.
    store.users[0] = { ...store.users[0], lastSignedIn: new Date("2026-09-26T00:00:05.000Z") };
    expect((await get(`/api/storage/${DOC_KEY}`, cookieA)).status).toBe(401);
    expect((await get(`/api/storage/${DOC_KEY}`, { authorization: cookieA.cookie.replace(`${COOKIE_NAME}=`, "Bearer ") })).status).toBe(401);

    store.users = store.users.filter(user => user.openId !== "tenant-b-user");
    expect((await get(`/api/storage/${FOREIGN_KEY}`, cookieB)).status).toBe(401);
    expect(signer.storageGetSignedUrl).not.toHaveBeenCalled();
  });

  it("8. derives authorization from database ownership, not from key naming", async () => {
    // Key names user 1 / workspace 1, but the persisted row belongs to workspace 2.
    expect((await get(`/api/storage/${LOOKALIKE_KEY}`, cookieA)).status).toBe(404);
    expect(signer.storageGetSignedUrl).not.toHaveBeenCalled();
    expect((await get(`/api/storage/${LOOKALIKE_KEY}`, cookieB)).status).toBe(307);
    expect(signer.storageGetSignedUrl).toHaveBeenCalledWith(LOOKALIKE_KEY);

    // A key that names no workspace at all is still authorized by its row.
    expect((await get(`/api/storage/${ASSET_KEY}`, cookieA)).status).toBe(307);

    // Ownership moves in the database => access moves, with the key unchanged.
    signer.storageGetSignedUrl.mockClear();
    store.documents[0] = { workspaceId: 2, storageKey: DOC_KEY };
    expect((await get(`/api/storage/${DOC_KEY}`, cookieA)).status).toBe(404);
    expect((await get(`/api/storage/${DOC_KEY}`, cookieB)).status).toBe(307);

    // Membership removed => access removed.
    signer.storageGetSignedUrl.mockClear();
    store.memberships = store.memberships.filter(m => m.userId !== 2);
    expect((await get(`/api/storage/${DOC_KEY}`, cookieB)).status).toBe(404);
    expect(signer.storageGetSignedUrl).not.toHaveBeenCalled();
  });

  it("9. never invokes the signer for any unauthorized, malformed or adversarial request", async () => {
    const enc = encodeURIComponent;
    const adversarial = [
      `/api/storage/%2e%2e/1/1/report_ab12cd34.pdf`,
      `/api/storage/1/1/../1/report_ab12cd34.pdf`,
      `/api/storage/1/./1/report_ab12cd34.pdf`,
      `/api/storage//1/1/report_ab12cd34.pdf`,
      `/api/storage/1//1/report_ab12cd34.pdf`,
      `/api/storage/${DOC_KEY}/`,
      `/api/storage/%252e%252e/1/1/report_ab12cd34.pdf`,
      `/api/storage/1%252F1%252Freport_ab12cd34.pdf`,
      `/api/storage/1%5C1%5Creport_ab12cd34.pdf`,
      `/api/storage/1/1/report_ab12cd34.pdf%00.png`,
      `/api/storage/1/1/report_ab12cd34.pdf%0d%0aX-Injected:1`,
      `/api/storage/${enc("１/１/report_ab12cd34.pdf")}`, // full-width digits (NFKC lookalike)
      `/api/storage/1${enc("／")}1${enc("／")}report_ab12cd34.pdf`, // full-width solidus
      `/api/storage/1/1/report_ab12cd34.pdf${enc("‮")}`,
      `/api/storage/${"a/".repeat(700)}x`,
      `/api/storage/1/1/${"a".repeat(2000)}`,
      `/api/storage/${DOC_KEY}?bucket=other&key=${FOREIGN_KEY}`,
      `/api/storage/${DOC_KEY.toUpperCase()}`, // case variant; SQL fake is case-insensitive
    ];
    for (const path of adversarial) {
      const asB = await get(path, cookieB);
      expect(asB.status, `tenant B: ${path.slice(0, 80)}`).not.toBe(307);
      expect(asB.location).toBeUndefined();
    }
    // Tenant A must not be able to redirect via encodings to anything but its own persisted key.
    for (const path of adversarial) {
      const asA = await get(path, cookieA);
      if (asA.status === 307) {
        // Only the exact-key-with-query case is legitimately allowed; it must sign the persisted key.
        expect(path.startsWith(`/api/storage/${DOC_KEY}?`)).toBe(true);
      }
    }
    for (const call of signer.storageGetSignedUrl.mock.calls) expect([DOC_KEY, ASSET_KEY]).toContain(call[0]);
  });

  it("9b. malformed percent-encoding is rejected before any authorization or signing", async () => {
    const reply = await get(`/api/storage/%E0%A4%A`, cookieA);
    expect(reply.status).toBe(400);
    expect(reply.location).toBeUndefined();
    expect(signer.storageGetSignedUrl).not.toHaveBeenCalled();
  });

  it("10. accepts an encoded separator only as an alias of the same persisted key", async () => {
    const owner = await get(`/api/storage/1%2F1%2Freport_ab12cd34.pdf`, cookieA);
    expect(owner.status).toBe(307);
    expect(signer.storageGetSignedUrl).toHaveBeenLastCalledWith(DOC_KEY);
    signer.storageGetSignedUrl.mockClear();
    expect((await get(`/api/storage/1%2F1%2Freport_ab12cd34.pdf`, cookieB)).status).toBe(404);
    expect(signer.storageGetSignedUrl).not.toHaveBeenCalled();
  });

  it("11. signs the persisted key, never a case-variant supplied by the caller", async () => {
    const reply = await get(`/api/storage/${DOC_KEY.toUpperCase()}`, cookieA);
    expect(reply.status).toBe(404);
    expect(signer.storageGetSignedUrl).not.toHaveBeenCalled();
  });

  it("12. Bearer vs cookie: the cookie takes precedence and a bad cookie is never rescued by a valid Bearer", async () => {
    const bearerB = `Bearer ${await tokenFor("tenant-b-user")}`;
    // Valid cookie (A) + Bearer (B) => authenticated as A only.
    expect((await get(`/api/storage/${DOC_KEY}`, { ...cookieA, authorization: bearerB })).status).toBe(307);
    expect((await get(`/api/storage/${FOREIGN_KEY}`, { ...cookieA, authorization: bearerB })).status).toBe(404);
    signer.storageGetSignedUrl.mockClear();
    // Invalid cookie + valid Bearer => rejected (no silent fallback).
    const mixed = await get(`/api/storage/${FOREIGN_KEY}`, { cookie: `${COOKIE_NAME}=garbage`, authorization: bearerB });
    expect(mixed.status).toBe(401);
    expect(signer.storageGetSignedUrl).not.toHaveBeenCalled();
  });

  it("13. fails closed when the authorization database is unavailable, and when the signer fails after authorization", async () => {
    store.dbAvailable = false;
    const down = await get(`/api/storage/${DOC_KEY}`, cookieA);
    expect(down.status).toBe(503);
    expect(down.location).toBeUndefined();
    expect(signer.storageGetSignedUrl).not.toHaveBeenCalled();

    store.dbAvailable = true;
    signer.storageGetSignedUrl.mockRejectedValueOnce(new Error("bucket sakthiai-secret credentials AKIA..."));
    const failed = await get(`/api/storage/${DOC_KEY}`, cookieA);
    expect(failed.status).toBe(502);
    expect(failed.body).not.toMatch(/bucket|AKIA|credential|sakthiai-secret/i);
  });

  it("responses are never cacheable", async () => {
    const reply = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: `/api/storage/${DOC_KEY}`, headers: cookieB }, res => {
        res.resume();
        res.on("end", () => resolve(res.headers));
      }).on("error", reject);
    });
    expect(reply["cache-control"]).toContain("no-store");
  });
});
