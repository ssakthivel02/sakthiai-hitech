import { describe, expect, it, vi } from "vitest";
import { MAX_STORAGE_KEY_LENGTH, parseStorageObjectKey, resolveAuthorizedStorageKey } from "./storageAccess";

describe("parseStorageObjectKey", () => {
  it("accepts keys in the shapes SakthiAI generates", () => {
    for (const key of [
      "1/1/report_ab12cd34.pdf",
      "creator/5/shots/3/generation-9.png",
      "creator/2/7/renders/timeline-1/export-2.mp4",
      "creator/2/7/references/character/0123456789abcdef-hero_01.png",
    ]) {
      expect(parseStorageObjectKey(key)).toBe(key);
    }
  });

  it("rejects non-strings, empty, oversized, traversal, separators and control/unsafe characters", () => {
    const bad: unknown[] = [
      undefined, null, 7, {}, [], "",
      "a".repeat(MAX_STORAGE_KEY_LENGTH + 1),
      "/abs/key", "a//b", "a/", "./a", "a/./b", "../a", "a/../b", "a/..",
      "a\\b", "a%2fb", "a%2e%2e/b", "a\u0000b", "a\nb", "a\r\nb", "a\u007fb",
      "a\ud800b", "a\udc00b",
    ];
    for (const value of bad) expect(parseStorageObjectKey(value), JSON.stringify(value)).toBeNull();
  });

  it("does not treat a well-formed key as authorized (structure grants nothing)", async () => {
    const findOwners = vi.fn(async () => []);
    const getWorkspaceForUser = vi.fn();
    expect(await resolveAuthorizedStorageKey({ id: 1 }, "1/1/x_12345678.pdf", { findOwners, getWorkspaceForUser })).toBeNull();
    expect(getWorkspaceForUser).not.toHaveBeenCalled();
  });
});

describe("resolveAuthorizedStorageKey", () => {
  const key = "1/1/report_ab12cd34.pdf";

  it("never queries ownership for structurally invalid keys", async () => {
    const findOwners = vi.fn(async () => [{ workspaceId: 1, storageKey: key }]);
    const getWorkspaceForUser = vi.fn(async () => ({ id: 1 }));
    expect(await resolveAuthorizedStorageKey({ id: 1 }, "../1/1/report_ab12cd34.pdf", { findOwners, getWorkspaceForUser })).toBeNull();
    expect(findOwners).not.toHaveBeenCalled();
  });

  it("requires membership of the owning workspace, taken from the row rather than the key", async () => {
    const findOwners = vi.fn(async () => [{ workspaceId: 9, storageKey: key }]);
    const getWorkspaceForUser = vi.fn(async (userId: number, workspaceId: number) => (workspaceId === 9 && userId === 2 ? { id: 9 } : undefined));
    expect(await resolveAuthorizedStorageKey({ id: 1 }, key, { findOwners, getWorkspaceForUser })).toBeNull();
    expect(await resolveAuthorizedStorageKey({ id: 2 }, key, { findOwners, getWorkspaceForUser })).toBe(key);
    expect(getWorkspaceForUser).toHaveBeenCalledWith(1, 9);
  });

  it("ignores rows whose key differs from the request (case-insensitive SQL matches, null keys, bad workspace ids)", async () => {
    const getWorkspaceForUser = vi.fn(async () => ({ id: 1 }));
    const findOwners = vi.fn(async () => [
      { workspaceId: 1, storageKey: key.toUpperCase() },
      { workspaceId: 1, storageKey: null },
      { workspaceId: 0, storageKey: key },
      { workspaceId: -3, storageKey: key },
      { workspaceId: 1.5, storageKey: key },
    ]);
    expect(await resolveAuthorizedStorageKey({ id: 1 }, key, { findOwners, getWorkspaceForUser })).toBeNull();
    expect(getWorkspaceForUser).not.toHaveBeenCalled();
  });

  it("propagates database failures so callers fail closed", async () => {
    const findOwners = vi.fn(async () => { throw new Error("Database unavailable"); });
    await expect(resolveAuthorizedStorageKey({ id: 1 }, key, { findOwners, getWorkspaceForUser: vi.fn() })).rejects.toThrow("Database unavailable");
  });
});
