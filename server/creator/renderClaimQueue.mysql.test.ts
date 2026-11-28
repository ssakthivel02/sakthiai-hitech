import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mysql from "mysql2";
import { drizzle } from "drizzle-orm/mysql2";
import { sql } from "drizzle-orm";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";
import { MysqlCreatorRenderClaims } from "./renderClaims";
import { type CreatorRenderIntentInput } from "./renderIntent";

/**
 * Stage 3 tests: real transactional claim+export insertion with InnoDB.
 * This does NOT run FFmpeg, alter a production database, or prove crash recovery.
 */
describe.skipIf(skipMysqlSuite())("Creator render queue reservation atomicity (real MySQL)", () => {
  let database: TestDatabase;
  const pools: Array<ReturnType<typeof mysql.createPool>> = [];
  const instance = () => {
    const url = new URL(database.url);
    const pool = mysql.createPool({
      host: url.hostname, port: Number(url.port), user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password), database: database.name, connectionLimit: 10,
    });
    pools.push(pool);
    return new MysqlCreatorRenderClaims(() => Promise.resolve(drizzle(pool)));
  };

  const intent = (): CreatorRenderIntentInput => ({
    workspaceId: 101,
    creatorProjectId: 202,
    timelineId: 303,
    mode: "MASTER_CANDIDATE",
    audioMaster: { assetId: 10, checksumSha256: "a".repeat(64), durationMs: 8000 },
    visuals: [{
      assetId: 11, checksumSha256: "b".repeat(64), assetType: "VIDEO",
      shotId: 21, startMs: 0, endMs: 8000, track: 1, sortOrder: 0,
    }],
    captions: [{ startMs: 0, endMs: 8000, text: "வேல் முருகா", language: "ta", locked: true }],
    output: { width: 1920, height: 1080, fps: 24, fit: "pad", rendererVersion: "ffmpeg-test-v1", fontFamily: "Noto Sans Tamil" },
  });

  const queuedRows = async () => {
    const [rows] = await database.pool.promise().query(
      "SELECT id, workspaceId, creatorProjectId, timelineId, status, width, height, parametersJson FROM creatorExports WHERE workspaceId = 101 ORDER BY id",
    ) as unknown as [Array<{
      id: number; workspaceId: number; creatorProjectId: number; timelineId: number;
      status: string; width: number; height: number; parametersJson: string;
    }>];
    return rows;
  };
  const claims = async () => {
    const [rows] = await database.pool.promise().query(
      "SELECT id, state, exportId, fingerprint, outputAssetId FROM creatorRenderClaims WHERE workspaceId = 101 ORDER BY id",
    ) as unknown as [Array<{
      id: number; state: string; exportId: number | null; fingerprint: string; outputAssetId: number | null;
    }>];
    return rows;
  };

  beforeAll(async () => { database = await createTestDatabase(); });
  afterAll(async () => {
    for (const pool of pools) await pool.promise().end().catch(() => undefined);
    await database?.close();
  });
  beforeEach(async () => {
    await database.db.execute(sql`DELETE FROM creatorRenderClaims WHERE workspaceId = 101`);
    await database.db.execute(sql`DELETE FROM creatorExports WHERE workspaceId = 101`);
  });

  it("20 concurrent identical requests across two pools yield exactly one claim AND one export", async () => {
    const a = instance(), b = instance();
    const result = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).claimAndQueueExport(intent())));
    const creator = result.filter(x => x.created);
    expect(creator).toHaveLength(1);
    expect(result.every(x => x.claimId === creator[0].claimId && x.exportId === creator[0].exportId)).toBe(true);
    expect(result.filter(x => !x.created).every(x => !("leaseToken" in x))).toBe(true);
    expect(await claims()).toHaveLength(1);
    const exports = await queuedRows();
    expect(exports).toHaveLength(1);
    expect(exports[0]).toMatchObject({ status: "QUEUED", width: 1920, height: 1080, workspaceId: 101, creatorProjectId: 202, timelineId: 303 });
    expect((await claims())[0]).toMatchObject({ exportId: exports[0].id, state: "RUNNING" });
    const snapshot = JSON.parse(exports[0].parametersJson);
    expect(snapshot).toMatchObject({ intentVersion: "creator-render-intent/v1", intentFingerprint: creator[0].fingerprint, visualAssetIds: [11], captionCueCount: 1 });
    expect(exports[0].parametersJson).not.toContain("https://");
  });

  it("changed Tamil subtitle or source checksum creates a new claim and export, never reuses a stale one", async () => {
    const a = instance();
    const original = await a.claimAndQueueExport(intent());
    const captionChanged = intent();
    captionChanged.captions[0].text = "முருகா சரணம்";
    const second = await a.claimAndQueueExport(captionChanged);
    const audioChanged = intent();
    audioChanged.audioMaster.checksumSha256 = "c".repeat(64);
    const third = await a.claimAndQueueExport(audioChanged);
    expect([original.created, second.created, third.created]).toEqual([true, true, true]);
    expect(new Set([original.claimId, second.claimId, third.claimId]).size).toBe(3);
    expect(new Set([original.exportId, second.exportId, third.exportId]).size).toBe(3);
    expect(await queuedRows()).toHaveLength(3);
    expect(await claims()).toHaveLength(3);
  });

  it("distinguishes vertical derivatives and refuses invalid intent without creating database rows", async () => {
    const a = instance();
    const master = await a.claimAndQueueExport(intent());
    const derivative = intent();
    derivative.mode = "VERTICAL_DERIVATIVE";
    derivative.output = { ...derivative.output, width: 1080, height: 1920, fit: "cover" };
    derivative.derivativeOf = { assetId: 88, checksumSha256: "d".repeat(64) };
    const vertical = await a.claimAndQueueExport(derivative);
    expect(vertical.claimId).not.toBe(master.claimId);
    expect((await queuedRows()).map(x => [x.width, x.height])).toEqual([[1920, 1080], [1080, 1920]]);
    const invalid = intent();
    invalid.output.width = 1080;
    await expect(a.claimAndQueueExport(invalid)).rejects.toThrow("CREATOR_RENDER_INTENT_INVALID:outputProfile");
    expect(await claims()).toHaveLength(2);
    expect(await queuedRows()).toHaveLength(2);
  });

  it("an export-insert failure rolls back the claim, permitting a clean subsequent attempt", async () => {
    const a = instance();
    await database.pool.promise().query(
      "CREATE TRIGGER creatorExportInjectedAbort BEFORE INSERT ON creatorExports FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected queue insert failure'",
    );
    try {
      let failure: unknown;
      try {
        await a.claimAndQueueExport(intent());
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      // Drizzle wraps the server SIGNAL as a failed query; retain the SQL
      // cause check instead of assuming the top-level message is unwrapped.
      const chain: string[] = [];
      for (let cause: unknown = failure, depth = 0; cause && depth < 6; depth++) {
        if (cause instanceof Error) {
          chain.push(cause.message);
          cause = (cause as Error & { cause?: unknown }).cause;
        } else break;
      }
      expect(chain.join("\n")).toContain("injected queue insert failure");
      expect(await claims()).toHaveLength(0);
      expect(await queuedRows()).toHaveLength(0);
    } finally {
      await database.pool.promise().query("DROP TRIGGER IF EXISTS creatorExportInjectedAbort");
    }
    const retry = await a.claimAndQueueExport(intent());
    expect(retry.created).toBe(true);
    expect(await claims()).toHaveLength(1);
    expect(await queuedRows()).toHaveLength(1);
  });
});
