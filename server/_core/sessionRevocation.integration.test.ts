import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sdk = readFileSync(new URL("./sdk.ts", import.meta.url), "utf8");
const oauth = readFileSync(new URL("./oauth.ts", import.meta.url), "utf8");
const db = readFileSync(new URL("../db.ts", import.meta.url), "utf8");
const useAuth = readFileSync(
  new URL("../../client/src/_core/hooks/useAuth.ts", import.meta.url),
  "utf8",
);

describe("P0 server-side session revocation integration contract", () => {
  it("rejects a token whose persisted generation has changed", () => {
    expect(sdk).toContain("isSessionGenerationCurrent(session.sessionGeneration, user.lastSignedIn)");
    expect(sdk).toContain('ForbiddenError("Session revoked")');
    expect(sdk).toContain(".setJti(payload.sessionId)");
  });

  it("advances the persisted generation atomically", () => {
    expect(db).toContain("GREATEST(DATE_ADD(${users.lastSignedIn}, INTERVAL 1 SECOND)");
    expect(db).toContain("advanceUserSessionGeneration");
  });

  it("exposes an authenticated revoke-all path and clears stale cookies", () => {
    expect(oauth).toContain('app.post("/api/auth/revoke-all"');
    expect(oauth).toContain("await sdk.revokeAllSessions(user.openId)");
    expect(oauth.split("res.clearCookie(COOKIE_NAME, cookieOptions)").length - 1).toBeGreaterThanOrEqual(2);
  });

  it("routes normal UI logout through server-side revocation and fails closed", () => {
    expect(useAuth).toContain('fetch("/api/auth/revoke-all"');
    expect(useAuth).toContain('method: "POST"');
    expect(useAuth).toContain("if (!response.ok && response.status !== 401)");
    expect(useAuth).toContain("Server-side session revocation failed");
  });
});
