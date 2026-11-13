import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../../testing/mysqlTestDb";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("../../db", async importOriginal => ({
  ...(await importOriginal<typeof import("../../db")>()),
  getDb: async () => state.db,
}));

import { admitAvatarConsentDispatch, revokeConsent } from "./consentStore";

describe.skipIf(skipMysqlSuite())("Creator avatar consent dispatch linearization (disposable MySQL)", { timeout: 60_000 }, () => {
  let fixture: TestDatabase;
  let id = 0;
  const input = () => ({ workspaceId: 7, consentId: id, purpose: "avatar_video" as const, provider: "heygen-avatar", providerSubjectId: "avatar_fixture_01" });
  const insert = async () => {
    await fixture.db.execute(sql`INSERT INTO creatorConsents
      (workspaceId, purpose, provider, providerSubjectId, evidenceReference, grantedByUserId)
      VALUES (7, 'avatar_video', 'heygen-avatar', 'avatar_fixture_01', 'consent-fixture-2026-11', 1)`);
    const [rows] = await fixture.db.execute(sql`SELECT MAX(id) AS id FROM creatorConsents WHERE workspaceId = 7`) as unknown as [{ id: number }[]];
    id = Number(rows[0].id);
  };

  beforeAll(async () => {
    fixture = await createTestDatabase();
    state.db = fixture.db;
  });
  afterAll(async () => { state.db = undefined; await fixture?.close(); });

  it("rejects admission after revocation has committed", async () => {
    await insert();
    await revokeConsent({ workspaceId: 7, userId: 1, consentId: id });
    await expect(admitAvatarConsentDispatch(input())).rejects.toThrow("CREATOR_CONSENT_REVOKED_OR_NOT_ACTIVE");
  });

  it("records admission before later revocation, but never admits again afterward", async () => {
    await insert();
    await expect(admitAvatarConsentDispatch(input())).resolves.toMatchObject({ admitted: true, consentId: id });
    const [before] = await fixture.db.execute(sql`SELECT lastDispatchAdmittedAt AS stamp FROM creatorConsents WHERE id = ${id}`) as unknown as [{ stamp: Date | null }[]];
    expect(before[0].stamp).not.toBeNull();
    await revokeConsent({ workspaceId: 7, userId: 1, consentId: id });
    await expect(admitAvatarConsentDispatch(input())).rejects.toThrow("CREATOR_CONSENT_REVOKED_OR_NOT_ACTIVE");
  });

  it("permits repeated active admissions but refuses revoked, expired or mismatched consent", async () => {
    await insert();
    await expect(admitAvatarConsentDispatch(input())).resolves.toMatchObject({ admitted: true });
    await expect(admitAvatarConsentDispatch(input())).resolves.toMatchObject({ admitted: true });
    await expect(admitAvatarConsentDispatch({ ...input(), workspaceId: 8 })).rejects.toThrow("CREATOR_CONSENT_REVOKED_OR_NOT_ACTIVE");
    await expect(admitAvatarConsentDispatch({ ...input(), providerSubjectId: "other_avatar_01" })).rejects.toThrow("CREATOR_CONSENT_REVOKED_OR_NOT_ACTIVE");
    await fixture.db.execute(sql`UPDATE creatorConsents SET validUntil = DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 1 DAY) WHERE id = ${id}`);
    await expect(admitAvatarConsentDispatch(input())).rejects.toThrow("CREATOR_CONSENT_REVOKED_OR_NOT_ACTIVE");
  });

  it("serializes a revocation held in another transaction against admission on another connection", async () => {
    await insert();
    const locked = await fixture.pool.promise().getConnection();
    let release!: () => void;
    let resolveStarted!: () => void;
    const started = new Promise<void>(resolve => { resolveStarted = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    try {
      await locked.beginTransaction();
      await locked.query("UPDATE creatorConsents SET revokedAt = CURRENT_TIMESTAMP, revokedByUserId = 1 WHERE id = ?", [id]);
      let settled = false;
      const admission = (async () => {
        resolveStarted();
        try { return await admitAvatarConsentDispatch(input()); }
        finally { settled = true; }
      })();
      await started;
      // Releasing the lock commits revocation; the waiting UPDATE must then see revokedAt.
      await locked.commit();
      release();
      await gate;
      await expect(admission).rejects.toThrow("CREATOR_CONSENT_REVOKED_OR_NOT_ACTIVE");
      expect(settled).toBe(true);
    } finally {
      await locked.rollback().catch(() => undefined);
      locked.release();
    }
  });
});
