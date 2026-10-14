import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routers = readFileSync(new URL("./routers.ts", import.meta.url), "utf8");
const db = readFileSync(new URL("./db.ts", import.meta.url), "utf8");

describe("P0 tenant isolation regression guards", () => {
  it("filters retrieval by workspace in SQL before scoring and fusion (every candidate source, chunk AND document scoped)", () => {
    const store = readFileSync(new URL("./retrievalStore.ts", import.meta.url), "utf8");
    // three candidate queries (lexical, legacy, semantic), each spreading the two-sided workspace predicate
    expect(store.split("...scopedTo(workspaceId)").length - 1).toBe(3);
    expect(store).toContain("eq(documentChunks.workspaceId, workspaceId), eq(documents.workspaceId, workspaceId)");
    expect(store.indexOf("fetchRetrievalCandidates(db, workspaceId, query")).toBeLessThan(store.indexOf("rankChunkCandidates(rows, query"));
    // db.ts delegates with the caller's workspace id and never fetches a global candidate set
    expect(db).toContain("searchWorkspaceChunks(db, workspaceId, query");
    expect(db).not.toMatch(/from\(documentChunks\)[^;]*\.limit\(/);
  });

  it("requires uploaded project to belong to the selected workspace", () => {
    expect(routers).toContain("eq(projects.id, input.projectId)");
    expect(routers).toContain("eq(projects.workspaceId, input.workspaceId)");
    expect(routers).toContain("Project access denied");
  });

  it("reselects a persisted document within the current workspace", () => {
    expect(routers).toContain("and(eq(documents.workspaceId, input.workspaceId), eq(documents.contentHash, contentHash))");
  });

  it("requires user ownership for conversation history and continuation", () => {
    const ownerPredicate = "eq(conversations.userId, ctx.user.id)";
    expect(routers.split(ownerPredicate).length - 1).toBeGreaterThanOrEqual(3);
    expect(routers).toContain("Conversation access denied");
  });

  it("scopes newly-created conversation lookup to workspace and user", () => {
    expect(routers).toContain("where(and(eq(conversations.workspaceId, input.workspaceId), eq(conversations.userId, ctx.user.id)))");
  });
});
