import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "../../drizzle/schema";

/**
 * Defect D1 (reproduced RED on candidate 42682d1 before the fix): files.upload had no explicit gate, so with a clean scanner
 * configured a direct API call reached extraction, object storage and the database even though uploads are OFF in the beta.
 * Every server path that accepts file bytes must be OFF unless FILE_INGESTION_BACKEND_ENABLED is exactly "true",
 * independently of whether a scanner is configured.
 */
const calls = vi.hoisted(() => ({ extract: 0, put: 0, inserts: 0 }));
const fakeDb = vi.hoisted(() => {
  const make = () => {
    const chain: any = {};
    for (const m of ["select", "from", "where", "limit", "orderBy", "values"]) chain[m] = () => chain;
    // After the single insert, the post-insert lookup finds the row; before it (duplicate check) nothing exists.
    chain.then = (resolve: (rows: unknown[]) => void) => resolve(calls.inserts > 0 ? [{ id: 1, filename: "note.txt", pageCount: 1 }] : []);
    return chain;
  };
  return { select: () => make(), insert: () => { calls.inserts += 1; return make(); }, delete: () => make(), update: () => make() };
});
vi.mock("../db", () => ({
  getDb: vi.fn(async () => fakeDb), getWorkspaceForUser: vi.fn(async () => ({ id: 7 })), getWorkspaceRole: vi.fn(async () => "owner"),
  ensureWorkspace: vi.fn(), listUserWorkspaces: vi.fn(async () => []), listProjects: vi.fn(async () => []), listDocuments: vi.fn(async () => []),
  searchChunks: vi.fn(async () => []), getConversationMessages: vi.fn(async () => []), getUserByOpenId: vi.fn(),
  projects: {}, documents: {}, documentChunks: {}, conversations: {}, messages: {},
}));
vi.mock("../storage", () => ({ storagePut: vi.fn(async () => { calls.put += 1; return { key: "k", url: "u" }; }) }));
vi.mock("../provenance", () => ({ extractDocument: vi.fn(async () => { calls.extract += 1; return { text: "hello", segments: [{ content: "hello", sourceStart: 0, sourceEnd: 5 }], pageCount: 1 }; }) }));
vi.mock("../embeddings", () => ({ embeddingStatus: () => ({ status: "disabled" }), tryEmbed: vi.fn(async () => null), serializeEmbedding: vi.fn() }));
vi.mock("../creator/router", async () => { const { router } = await import("../_core/trpc"); return { creatorRouter: router({}) }; });

import { appRouter } from "../routers";
import type { TrpcContext } from "../_core/context";

const user: User = { id: 1, openId: "u1", email: "a@example.com", name: "A", loginMethod: "test", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() };
const ctx = (): TrpcContext => ({ user, req: { protocol: "https", headers: {} } as never, res: { setHeader() {}, headersSent: false } as never, requestId: "gate" });
const caller = () => appRouter.createCaller(ctx());
const b64 = (text: string) => Buffer.from(text).toString("base64");
const upload = () => caller().files.upload({ workspaceId: 7, filename: "note.txt", mimeType: "text/plain", dataBase64: b64("hello world") });
const scannerConfigured = () => { vi.stubEnv("MALWARE_SCANNER_HOST", "scanner.internal"); vi.stubEnv("MALWARE_SCANNER_PORT", "3310"); };

describe("uploads are OFF unless FILE_INGESTION_BACKEND_ENABLED is exactly \"true\"", () => {
  beforeEach(() => { calls.extract = calls.put = calls.inserts = 0; vi.unstubAllEnvs(); });

  it("files.upload is FORBIDDEN with a scanner configured, before any extraction, storage or insert", async () => {
    scannerConfigured();
    vi.stubEnv("FILE_INGESTION_BACKEND_ENABLED", "");
    await expect(upload()).rejects.toMatchObject({ code: "FORBIDDEN", message: "File uploads are not enabled in this beta" });
    expect(calls).toEqual({ extract: 0, put: 0, inserts: 0 });
  });

  it("files.upload is FORBIDDEN when the flag is unset", async () => {
    scannerConfigured();
    delete process.env.FILE_INGESTION_BACKEND_ENABLED;
    await expect(upload()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(calls).toEqual({ extract: 0, put: 0, inserts: 0 });
  });

  it.each(["1", "True", "yes", "TRUE", " true"])("does not treat %j as enabled", async value => {
    scannerConfigured();
    vi.stubEnv("FILE_INGESTION_BACKEND_ENABLED", value);
    await expect(upload()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(calls).toEqual({ extract: 0, put: 0, inserts: 0 });
  });

  it("every resumable route is refused while OFF", async () => {
    scannerConfigured();
    const id = "00000000-0000-4000-8000-000000000000";
    const resumable = caller().files.resumable;
    const refused = [
      resumable.begin({ workspaceId: 7, filename: "a.txt", mimeType: "text/plain", sizeBytes: 5, sha256: "a".repeat(64), chunkSize: 5 }),
      resumable.putChunk({ workspaceId: 7, uploadId: id, index: 0, dataBase64: b64("hello") }),
      resumable.finalize({ workspaceId: 7, uploadId: id }),
    ];
    for (const attempt of refused) await expect(attempt).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(calls).toEqual({ extract: 0, put: 0, inserts: 0 });
  });

  it("the explicit opt-in still works: with the flag exactly \"true\" the same call reaches extraction, storage and the database", async () => {
    vi.stubEnv("FILE_INGESTION_BACKEND_ENABLED", "true");
    const result = await upload();
    expect(result).toMatchObject({ id: 1, filename: "note.txt" });
    expect(calls).toEqual({ extract: 1, put: 1, inserts: 2 }); // document row + chunk rows
  });

  it("an unauthenticated caller is still rejected before the gate matters", async () => {
    const anonymous = appRouter.createCaller({ ...ctx(), user: null } as TrpcContext);
    await expect(anonymous.files.upload({ workspaceId: 7, filename: "a.txt", mimeType: "text/plain", dataBase64: b64("x") })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("inventory: every server procedure that accepts file bytes is gated", () => {
  const root = process.cwd();
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
    }
    return out;
  };
  const rel = (f: string) => path.relative(root, f).split(path.sep).join("/");
  const inputsWithBytes = walk(path.join(root, "server")).filter(f => /dataBase64:\s*z\./.test(readFileSync(f, "utf8"))).map(rel).sort();

  it("the set of files declaring a bytes input is exactly the reviewed set (a new one must be reviewed and gated)", () => {
    expect(inputsWithBytes).toEqual(["server/creator/audioRouter.ts", "server/creator/referenceRouter.ts", "server/creator/router.ts", "server/routers.ts"]);
  });

  it.each(["server/routers.ts", "server/creator/audioRouter.ts", "server/creator/referenceRouter.ts"])("%s calls assertFileUploadsEnabled()", file => {
    expect(readFileSync(path.join(root, file), "utf8")).toMatch(/assertFileUploadsEnabled\(\)/);
  });

  it("resumable ingestion delegates its switch to the same gate", () => {
    expect(readFileSync(path.join(root, "server/ingestion/service.ts"), "utf8")).toMatch(/fileUploadsEnabled\(env\)/);
  });

  it("creator inline reference images (provider-bound, not stored) sit behind the paid-Creator gate, which stays OFF", () => {
    const source = readFileSync(path.join(root, "server/creator/router.ts"), "utf8");
    expect(source).toMatch(/requirePaidCreatorAccess/);
    const beta = JSON.parse(readFileSync(path.join(root, "release/beta-capability-contract.json"), "utf8"));
    expect(JSON.stringify(beta)).not.toMatch(/"(creator|paidCreator)[^"]*":\s*"available"/i);
  });
});
