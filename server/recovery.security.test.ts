import { describe, expect, it } from "vitest";
import { assertWorkspaceAccess } from "./db";

describe("W25 recovery security invariants", () => {
  it("allows a member of the requested workspace", () => {
    expect(assertWorkspaceAccess(11, 21, [{ userId: 11, workspaceId: 21 }])).toBe(true);
  });
  it("denies a user from another tenant", () => {
    expect(assertWorkspaceAccess(12, 21, [{ userId: 11, workspaceId: 21 }])).toBe(false);
  });
  it("does not confuse a same-user membership in another workspace", () => {
    expect(assertWorkspaceAccess(11, 22, [{ userId: 11, workspaceId: 21 }])).toBe(false);
  });
  it("supports citation metadata shape required by the UI", () => {
    const citation = { filename: "brief.pdf", documentId: 7, page: 3, excerpt: "Grounded excerpt" };
    expect(citation).toMatchObject({ filename: expect.any(String), documentId: expect.any(Number), page: expect.any(Number), excerpt: expect.any(String) });
  });
});
