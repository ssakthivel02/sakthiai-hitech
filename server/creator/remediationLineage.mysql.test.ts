import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";

const holder = vi.hoisted(() => ({ db: undefined as unknown, verify: vi.fn(async (_key: string, _size: number, _sha: string) => undefined) }));
vi.mock("../db", async importOriginal => ({
  ...(await importOriginal<typeof import("../db")>()), getDb: async () => holder.db,
}));
vi.mock("../storage", async importOriginal => ({
  ...(await importOriginal<typeof import("../storage")>()),
  storageVerifySha256: (...args: [string, number, string]) => holder.verify(...args),
}));
import { linkCreatorRemediationReplacement } from "./remediationLineage";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
describe.skipIf(skipMysqlSuite())("Creator immutable remediation lineage (real MySQL)", { timeout: 60_000 }, () => {
  let database: TestDatabase;
  let projectId: number;
  let timelineId: number;
  const run = (query: ReturnType<typeof sql>) => database.db.execute(query);
  const one = async <T>(query: ReturnType<typeof sql>) => ((await run(query)) as unknown as [T[]])[0][0] as T;

  beforeAll(async () => {
    database = await createTestDatabase();
    holder.db = database.db;
    await run(sql`INSERT INTO creatorProjects (workspaceId, name) VALUES (7, 'lineage-test')`);
    projectId = (await one<{ id: number }>(sql`SELECT id FROM creatorProjects WHERE name = 'lineage-test'`)).id;
    await run(sql`INSERT INTO creatorAssets (workspaceId, creatorProjectId, assetType, mimeType, storageKey, checksumSha256, byteSize, immutable, provenanceJson, reviewDecision)
      VALUES (7, ${projectId}, 'AUDIO_MASTER', 'audio/wav', 'audio/master.wav', ${hash("audio")}, 100, 1, '{}', 'APPROVED')`);
    const audioId = (await one<{ id: number }>(sql`SELECT id FROM creatorAssets WHERE storageKey = 'audio/master.wav'`)).id;
    await run(sql`INSERT INTO creatorTimelines (workspaceId, creatorProjectId, name, audioMasterAssetId, width, height, fps)
      VALUES (7, ${projectId}, 'main', ${audioId}, 1920, 1080, 24)`);
    timelineId = (await one<{ id: number }>(sql`SELECT id FROM creatorTimelines WHERE creatorProjectId = ${projectId}`)).id;
  });
  afterAll(async () => { await database?.close(); });

  async function candidate(label: string, quality: "REGENERATE" | "PASS" | null = null) {
    const checksum = hash(label);
    const key = `render/${label}.mp4`;
    const audioId = (await one<{ id: number }>(sql`SELECT audioMasterAssetId AS id FROM creatorTimelines WHERE id = ${timelineId}`)).id;
    await run(sql`INSERT INTO creatorExports (workspaceId, creatorProjectId, timelineId, status, width, height, format, renderer, checksumSha256)
      VALUES (7, ${projectId}, ${timelineId}, 'SUCCEEDED', 1920, 1080, 'mp4', 'ffmpeg', ${checksum})`);
    const exportId = (await one<{ id: number }>(sql`SELECT MAX(id) AS id FROM creatorExports WHERE creatorProjectId = ${projectId}`)).id;
    const provenance = JSON.stringify({ source: "deterministic-creator-render", exportId, timelineId,
      audioMasterAssetId: audioId, audioMasterChecksumSha256: hash("audio"), width: 1920, height: 1080, fps: 24, durationMs: 4000 });
    await run(sql`INSERT INTO creatorAssets (workspaceId, creatorProjectId, assetType, mimeType, storageKey, checksumSha256, byteSize, immutable, provenanceJson, reviewDecision)
      VALUES (7, ${projectId}, 'RENDER', 'video/mp4', ${key}, ${checksum}, 1000, 1, ${provenance}, 'PENDING')`);
    const assetId = (await one<{ id: number }>(sql`SELECT id FROM creatorAssets WHERE storageKey = ${key}`)).id;
    await run(sql`UPDATE creatorExports SET assetId = ${assetId} WHERE id = ${exportId}`);
    let qualityId: number | undefined;
    if (quality) {
      const scoresJson = JSON.stringify({ candidateArtifact: { storageKey: key, checksumSha256: checksum, byteSize: 1000 } });
      await run(sql`INSERT INTO creatorReviews (workspaceId, creatorProjectId, assetId, reviewType, decision, reviewerUserId, scoresJson)
        VALUES (7, ${projectId}, ${assetId}, 'QUALITY', ${quality}, 501, ${scoresJson})`);
      qualityId = (await one<{ id: number }>(sql`SELECT MAX(id) AS id FROM creatorReviews WHERE assetId = ${assetId}`)).id;
    }
    return { assetId, qualityId, checksum };
  }
  const input = (source: Awaited<ReturnType<typeof candidate>>, replacement: Awaited<ReturnType<typeof candidate>>) => ({
    workspaceId: 7, creatorProjectId: projectId, reviewerUserId: 501,
    sourceCandidateAssetId: source.assetId, sourceQualityReviewId: source.qualityId!,
    replacementCandidateAssetId: replacement.assetId,
    expectedSourceChecksumSha256: source.checksum,
    expectedReplacementChecksumSha256: replacement.checksum,
  });

  it("records exact source quality, both immutable checksums and distinct replacement without inheriting approvals", async () => {
    const source = await candidate("lineage-good-source", "REGENERATE");
    const replacement = await candidate("lineage-good-replacement");
    const linked = await linkCreatorRemediationReplacement(input(source, replacement));
    expect(linked).toMatchObject({ sourceQualityReviewId: source.qualityId,
      replacementCandidateAssetId: replacement.assetId, finalMaster: false,
      replacementRequiresFreshQuality: true, replacementRequiresFreshTamilReview: true,
      replacementRequiresFreshVisualReview: true });
    const row = await one<{ sourceChecksumSha256: string; replacementChecksumSha256: string }>(sql`
      SELECT sourceChecksumSha256, replacementChecksumSha256 FROM creatorRemediationLineage WHERE id = ${linked.lineageId}`);
    expect(row).toEqual({ sourceChecksumSha256: source.checksum, replacementChecksumSha256: replacement.checksum });
    expect(Number((await one<{ n: number }>(sql`SELECT COUNT(*) AS n FROM creatorReviews WHERE assetId = ${replacement.assetId}`)).n)).toBe(0);
    await expect(linkCreatorRemediationReplacement(input(source, replacement))).rejects.toThrow("CREATOR_REMEDIATION_ALREADY_LINKED");
  });

  it("rejects a source without a failed quality decision", async () => {
    const source = await candidate("lineage-pass-source", "PASS");
    const replacement = await candidate("lineage-pass-replacement");
    await expect(linkCreatorRemediationReplacement(input(source, replacement))).rejects.toThrow("CREATOR_REMEDIATION_FAILED_QUALITY_REQUIRED");
  });

  it("rejects replacement candidates that have already been reviewed", async () => {
    const source = await candidate("lineage-reviewed-source", "REGENERATE");
    const replacement = await candidate("lineage-reviewed-replacement", "PASS");
    await expect(linkCreatorRemediationReplacement(input(source, replacement))).rejects.toThrow("CREATOR_REMEDIATION_REPLACEMENT_ALREADY_REVIEWED");
  });

  it("rejects changed stored bytes and leaves no lineage record", async () => {
    const source = await candidate("lineage-corrupt-source", "REGENERATE");
    const replacement = await candidate("lineage-corrupt-replacement");
    holder.verify.mockRejectedValueOnce(new Error("storage checksum mismatch"));
    await expect(linkCreatorRemediationReplacement(input(source, replacement))).rejects.toThrow("CREATOR_REMEDIATION_STORAGE_UNVERIFIED");
    const count = await one<{ n: number }>(sql`SELECT COUNT(*) AS n FROM creatorRemediationLineage WHERE sourceQualityReviewId = ${source.qualityId!}`);
    expect(Number(count.n)).toBe(0);
  });

  it("rejects a replacement checksum substitution before recording lineage", async () => {
    const source = await candidate("lineage-drift-source", "REGENERATE");
    const replacement = await candidate("lineage-drift-replacement");
    await expect(linkCreatorRemediationReplacement({ ...input(source, replacement), expectedReplacementChecksumSha256: hash("wrong") }))
      .rejects.toThrow("CREATOR_REMEDIATION_CANDIDATE_INVALID");
  });
});
