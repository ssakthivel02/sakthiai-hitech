import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";
import { MysqlCreatorRenderClaims } from "./renderClaims";

/**
 * Disposable MySQL 8.0/8.4: owner-scoped status polling cannot disclose
 * lease tokens, relaunch expired jobs, or promote outputs automatically.
 */
describe.skipIf(skipMysqlSuite())("Creator fenced render claim polling", { timeout: 60_000 }, () => {
  let d: TestDatabase;
  let claims: MysqlCreatorRenderClaims;
  const scope = { workspaceId: 701, creatorProjectId: 702, timelineId: 703 };

  beforeAll(async () => {
    d = await createTestDatabase();
    claims = new MysqlCreatorRenderClaims(async () => d.db);
  });
  afterAll(async () => { await d?.close(); });

  async function insertClaim(leaseOffsetSeconds: number) {
    const fingerprint = randomBytes(32).toString("hex");
    const token = randomUUID();
    const result = await d.db.execute(sql`
      INSERT INTO creatorRenderClaims
        (workspaceId, creatorProjectId, timelineId, mode, fingerprint,
         leaseToken, leaseUntil, state)
      VALUES (${scope.workspaceId}, ${scope.creatorProjectId}, ${scope.timelineId},
        'MASTER_CANDIDATE', ${fingerprint}, ${token},
        DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${leaseOffsetSeconds} SECOND), 'RUNNING')
    `);
    const id = Number((result[0] as { insertId?: number }).insertId);
    expect(id).toBeGreaterThan(0);
    return { id, token };
  }

  it("polls a running claim without leaking its lease token", async () => {
    const { id, token } = await insertClaim(600);
    const status = await claims.pollClaim({ ...scope, claimId: id });
    expect(status).toMatchObject({
      claimId: id, state: "RUNNING", exportId: null, outputAssetId: null,
      requiresReconciliation: false, reviewRequired: false,
      finalMaster: false, publishApproved: false,
    });
    expect(JSON.stringify(status)).not.toContain(token);
    expect(Object.keys(status)).not.toContain("leaseToken");
  });

  it("quarantines an expired claim without renewing or redispatching it", async () => {
    const { id } = await insertClaim(-10);
    const first = await claims.pollClaim({ ...scope, claimId: id });
    const second = await claims.pollClaim({ ...scope, claimId: id });
    expect(first.state).toBe("NEEDS_RECONCILIATION");
    expect(first.requiresReconciliation).toBe(true);
    expect(second).toEqual(first);
    const [rows] = await d.db.execute(sql`
      SELECT state FROM creatorRenderClaims WHERE id = ${id}
    `) as unknown as [[{ state: string }]];
    expect(rows[0].state).toBe("NEEDS_RECONCILIATION");
  });

  it("enforces workspace, project and timeline isolation", async () => {
    const { id } = await insertClaim(600);
    await expect(claims.pollClaim({ ...scope, claimId: id, workspaceId: 999 }))
      .rejects.toThrow("CREATOR_RENDER_CLAIM_NOT_FOUND");
    await expect(claims.pollClaim({ ...scope, claimId: id, creatorProjectId: 999 }))
      .rejects.toThrow("CREATOR_RENDER_CLAIM_NOT_FOUND");
    await expect(claims.pollClaim({ ...scope, claimId: id, timelineId: 999 }))
      .rejects.toThrow("CREATOR_RENDER_CLAIM_NOT_FOUND");
    expect((await claims.pollClaim({ ...scope, claimId: id })).state).toBe("RUNNING");
  });

  it("requires human review even when a claim is already succeeded", async () => {
    const { id } = await insertClaim(600);
    await d.db.execute(sql`
      UPDATE creatorRenderClaims SET state = 'SUCCEEDED', outputAssetId = 12345
      WHERE id = ${id}
    `);
    const status = await claims.pollClaim({ ...scope, claimId: id });
    expect(status).toMatchObject({
      state: "SUCCEEDED", outputAssetId: 12345,
      reviewRequired: true, finalMaster: false, publishApproved: false,
    });
  });
});
