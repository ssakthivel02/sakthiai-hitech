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

  it("does not mistake a consent watermark for a per-generation provider receipt after a crash", async () => {
    await insert();
    // The first generation reaches the submission-unknown state before any
    // consent admission or provider call. This is an intentionally ambiguous
    // crash window and must not be automatically retried.
    await fixture.db.execute(sql`INSERT INTO creatorGenerations
      (workspaceId, creatorProjectId, idempotencyKey, kind, provider, model, parametersJson, status)
      VALUES (7, 1, '00000000-0000-4000-8000-000000000091',
              'AVATAR_VIDEO', 'heygen-avatar', 'heygen-v3', '{}', 'SUBMISSION_UNKNOWN')`);
    const [before] = await fixture.db.execute(sql`
      SELECT lastDispatchAdmittedAt AS stamp FROM creatorConsents WHERE id = ${id}
    `) as unknown as [{ stamp: Date | null }[]];
    expect(before[0].stamp).toBeNull();

    // A different request can update the shared consent watermark. That
    // does NOT establish whether the earlier unknown generation was dispatched.
    await admitAvatarConsentDispatch(input());
    const [rows] = await fixture.db.execute(sql`
      SELECT g.status AS status, g.idempotencyKey AS requestKey,
             (SELECT lastDispatchAdmittedAt FROM creatorConsents WHERE id = ${id}) AS watermark
      FROM creatorGenerations g
      WHERE g.workspaceId = 7
        AND g.idempotencyKey = '00000000-0000-4000-8000-000000000091'
    `) as unknown as [{ status: string; requestKey: string; watermark: Date | null }[]];
    expect(rows[0]).toMatchObject({ status: "SUBMISSION_UNKNOWN", watermark: expect.any(Date) });
    // No provider job ID and no proof of network acceptance: hold/reconcile,
    // never infer a safe retry from the shared consent timestamp.
    const [jobs] = await fixture.db.execute(sql`
      SELECT COUNT(*) AS count FROM creatorProviderJobs
      WHERE workspaceId = 7 AND generationId = (
        SELECT id FROM creatorGenerations WHERE workspaceId = 7
          AND idempotencyKey = '00000000-0000-4000-8000-000000000091'
      )
    `) as unknown as [{ count: number }[]];
    expect(Number(jobs[0].count)).toBe(0);
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
