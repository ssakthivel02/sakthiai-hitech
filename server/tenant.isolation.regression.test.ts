import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const routers = fs.readFileSync(path.resolve(process.cwd(), "server/routers.ts"), "utf8");
const db = fs.readFileSync(path.resolve(process.cwd(), "server/db.ts"), "utf8");

describe("tenant isolation regression guards", () => {
  it("filters retrieval by workspace before scoring or fusion", () => {
    expect(db).toContain("eq(documentChunks.workspaceId, workspaceId)");
    expect(db).toContain("eq(documents.workspaceId, workspaceId)");
    expect(db.indexOf("eq(documentChunks.workspaceId, workspaceId)")).toBeLessThan(db.indexOf("const scored = rows.map"));
  });

  it("requires uploaded project ids to belong to the same workspace", () => {
    expect(routers).toContain("eq(projects.id, input.projectId)");
    expect(routers).toContain("eq(projects.workspaceId, input.workspaceId)");
    expect(routers).toContain("Project access denied");
  });

  it("re-selects newly persisted documents inside the current workspace", () => {
    expect(routers).toContain("and(eq(documents.workspaceId, input.workspaceId), eq(documents.contentHash, contentHash))");
  });

  it("requires conversation ownership for history and continuation", () => {
    expect(routers).toContain("requireOwnedConversation(ctx.user.id, input.workspaceId, input.conversationId)");
    expect(routers).toContain("if (conversationId) await requireOwnedConversation(ctx.user.id, input.workspaceId, conversationId)");
  });

  it("scopes newly-created conversation lookup to both workspace and user", () => {
    expect(routers).toContain("and(eq(conversations.workspaceId, input.workspaceId), eq(conversations.userId, ctx.user.id))");
  });
});
