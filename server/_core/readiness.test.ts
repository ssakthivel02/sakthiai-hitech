import { describe, expect, it, vi } from "vitest";
import { compareSchema, expectedSchema, probeDatabaseReadiness, probeSchemaReadiness, storageReadiness } from "./readiness";

describe("database readiness", () => {
  it("passes only when the live database query succeeds", async () => {
    const liveProbe = vi.fn().mockResolvedValue(undefined);

    await expect(probeDatabaseReadiness(liveProbe)).resolves.toBe(true);
    expect(liveProbe).toHaveBeenCalledOnce();
  });

  it("fails closed when a cached database handle can no longer execute a live query", async () => {
    const staleHandleProbe = vi.fn().mockRejectedValue(new Error("ECONNRESET"));

    await expect(probeDatabaseReadiness(staleHandleProbe)).resolves.toBe(false);
    expect(staleHandleProbe).toHaveBeenCalledOnce();
  });
});

describe("schema readiness", () => {
  const expected = new Map([["users", ["id", "openId"]], ["fileUploadSessions", ["id", "workspaceId"]]]);

  it("is current only when every declared table and column exists (extra objects are fine)", () => {
    const present = [["users", "id"], ["users", "openId"], ["users", "legacyExtra"], ["fileUploadSessions", "id"], ["fileUploadSessions", "workspaceId"], ["other", "x"]].map(([t, c]) => ({ t, c }));
    expect(compareSchema(expected, present)).toEqual({ status: "current", expectedTables: 2, missingTables: [], missingColumns: 0 });
  });

  it("reports a database missing newer migrations as behind, naming the missing tables", () => {
    expect(compareSchema(expected, [{ t: "users", c: "id" }, { t: "users", c: "openId" }])).toEqual({ status: "behind", expectedTables: 2, missingTables: ["fileUploadSessions"], missingColumns: 0 });
    expect(compareSchema(expected, [{ t: "users", c: "id" }, { t: "fileUploadSessions", c: "id" }, { t: "fileUploadSessions", c: "workspaceId" }])).toMatchObject({ status: "behind", missingTables: [], missingColumns: 1 });
  });

  it("derives the expectation from this build's Drizzle schema, including the tables and columns of migrations 0005-0010", () => {
    const schema = expectedSchema();
    for (const table of ["users", "workspaces", "documentChunks", "providerWorkspacePolicies", "oauthLoginTransactions", "durableTasks", "mcpConnectors", "fileUploadSessions"]) expect(schema.has(table)).toBe(true);
    expect(schema.get("documentChunks")).toContain("searchText");
  });

  it("fails closed as unknown when the schema cannot be read", async () => {
    await expect(probeSchemaReadiness(() => Promise.reject(new Error("ECONNRESET")))).resolves.toMatchObject({ status: "unknown" });
  });
});

describe("storage readiness follows the enabled beta paths (defect D5)", () => {
  it("is not required, and does not fail readiness, while uploads are OFF and storage is unconfigured", () => {
    expect(storageReadiness({ uploadsEnabled: false, configured: false })).toEqual({ state: "not_required", ok: true });
  });
  it("reports configured (still ok) when uploads are OFF but storage happens to be configured", () => {
    expect(storageReadiness({ uploadsEnabled: false, configured: true })).toEqual({ state: "configured", ok: true });
  });
  it("is required, and fails readiness when missing, as soon as uploads are enabled", () => {
    expect(storageReadiness({ uploadsEnabled: true, configured: false })).toEqual({ state: "missing_configuration", ok: false });
    expect(storageReadiness({ uploadsEnabled: true, configured: true })).toEqual({ state: "configured", ok: true });
  });
});
