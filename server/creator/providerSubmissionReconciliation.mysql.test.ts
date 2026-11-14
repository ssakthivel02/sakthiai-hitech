import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("../db", async importOriginal => ({
  ...(await importOriginal<typeof import("../db")>()),
  getDb: async () => state.db,
}));

import { attachReconciledAvatarProviderJob } from "./providerSubmissionReconciliation";

describe.skipIf(skipMysqlSuite())("Creator provider-response-loss reconciliation (disposable MySQL)", { timeout: 60_000 }, () => {
  let fixture: TestDatabase;
  let seq = 200;

  beforeAll(async () => {
    fixture = await createTestDatabase();
    state.db = fixture.db;
  });
  afterAll(async () => { state.db = undefined; await fixture?.close(); });

  async function unknownGeneration(overrides?: { workspaceId?: number; callbackId?: string; provider?: string; model?: string }) {
    const workspaceId = overrides?.workspaceId ?? 7;
    const callbackId = overrides?.callbackId ?? `00000000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;
    const provider = overrides?.provider ?? "heygen-avatar";
    const model = overrides?.model ?? "heygen-v3";
    await fixture.db.execute(sql`INSERT INTO creatorGenerations
      (workspaceId, creatorProjectId, idempotencyKey, kind, provider, model, parametersJson, status)
      VALUES (${workspaceId}, 1, ${callbackId}, 'AVATAR_VIDEO', ${provider}, ${model}, '{}', 'SUBMISSION_UNKNOWN')`);
    const [rows] = await fixture.db.execute(sql`SELECT id FROM creatorGenerations
      WHERE workspaceId = ${workspaceId} AND idempotencyKey = ${callbackId}`) as unknown as [{ id: number }[]];
    const generationId = Number(rows[0].id);
    await fixture.db.execute(sql`INSERT INTO creatorAvatarDispatchAdmissions
      (generationId, workspaceId, consentId, callbackId)
      VALUES (${generationId}, ${workspaceId}, 1, ${callbackId})`);
    return { workspaceId, generationId, callbackId, provider, model };
  }

  it("atomically attaches an authoritative existing provider job without re-submission", async () => {
    const g = await unknownGeneration();
    const result = await attachReconciledAvatarProviderJob({ ...g, providerJobId: "vid_reconcile_001", evidence: { source: "verified-provider-event" } });
    expect(result).toEqual({ generationId: g.generationId, providerJobId: "vid_reconcile_001", attached: true, state: "SUBMITTED" });

    const [generations] = await fixture.db.execute(sql`SELECT status FROM creatorGenerations WHERE id = ${g.generationId}`) as unknown as [{ status: string }[]];
    const [jobs] = await fixture.db.execute(sql`SELECT provider, providerJobId, status FROM creatorProviderJobs
      WHERE workspaceId = ${g.workspaceId} AND generationId = ${g.generationId}`) as unknown as [{ provider: string; providerJobId: string; status: string }[]];
    expect(generations[0].status).toBe("SUBMITTED");
    expect(jobs).toEqual([{ provider: "heygen-avatar", providerJobId: "vid_reconcile_001", status: "SUBMITTED" }]);
  });

  it("is idempotent for duplicate delivery of the same authoritative job", async () => {
    const g = await unknownGeneration();
    await expect(attachReconciledAvatarProviderJob({ ...g, providerJobId: "vid_reconcile_002" })).resolves.toMatchObject({ attached: true });
    await expect(attachReconciledAvatarProviderJob({ ...g, providerJobId: "vid_reconcile_002" })).resolves.toMatchObject({ attached: false });
    const [rows] = await fixture.db.execute(sql`SELECT COUNT(*) AS n FROM creatorProviderJobs
      WHERE workspaceId = ${g.workspaceId} AND generationId = ${g.generationId}`) as unknown as [{ n: number }[]];
    expect(Number(rows[0].n)).toBe(1);
  });

  it("fails closed on callback, provider, or model mismatch", async () => {
    const g = await unknownGeneration();
    await expect(attachReconciledAvatarProviderJob({ ...g, callbackId: "00000000-0000-4000-8000-999999999999", providerJobId: "vid_reconcile_003" }))
      .rejects.toThrow("CREATOR_RECONCILIATION_CONFLICT");
    await expect(attachReconciledAvatarProviderJob({ ...g, provider: "other-provider", providerJobId: "vid_reconcile_003" }))
      .rejects.toThrow("CREATOR_RECONCILIATION_CONFLICT");
    await expect(attachReconciledAvatarProviderJob({ ...g, model: "other-model", providerJobId: "vid_reconcile_003" }))
      .rejects.toThrow("CREATOR_RECONCILIATION_CONFLICT");
  });

  it("fails closed when a different provider job is already attached", async () => {
    const g = await unknownGeneration();
    await attachReconciledAvatarProviderJob({ ...g, providerJobId: "vid_reconcile_004a" });
    await expect(attachReconciledAvatarProviderJob({ ...g, providerJobId: "vid_reconcile_004b" }))
      .rejects.toThrow("CREATOR_RECONCILIATION_CONFLICT");
  });

  it("prevents one provider job from being attached to another generation in the same workspace", async () => {
    const first = await unknownGeneration();
    const second = await unknownGeneration();
    await attachReconciledAvatarProviderJob({ ...first, providerJobId: "vid_reconcile_shared" });
    await expect(attachReconciledAvatarProviderJob({ ...second, providerJobId: "vid_reconcile_shared" }))
      .rejects.toThrow("CREATOR_RECONCILIATION_CONFLICT");
  });

  it("requires the immutable generation-scoped admission receipt", async () => {
    const g = await unknownGeneration();
    await fixture.db.execute(sql`DELETE FROM creatorAvatarDispatchAdmissions WHERE generationId = ${g.generationId}`);
    await expect(attachReconciledAvatarProviderJob({ ...g, providerJobId: "vid_reconcile_006" }))
      .rejects.toThrow("CREATOR_RECONCILIATION_CONFLICT");
  });
});
