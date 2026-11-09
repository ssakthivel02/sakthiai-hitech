import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";
import { creatorRenderIntentFingerprint } from "./renderIntent";
import { readCreatorRenderIntentFromDatabase, reserveCreatorRenderIntentFromDatabase } from "./renderIntentDb";

/** Real disposable SQL: no FFmpeg invocation, signed URLs or provider calls. */
describe.skipIf(skipMysqlSuite())("Creator server-owned render intent", { timeout: 60_000 }, () => {
  let d: TestDatabase;
  const ids: Record<string, number> = {};
  const exec = (s: ReturnType<typeof sql>) => d.db.execute(s);
  const first = async <T>(s: ReturnType<typeof sql>): Promise<T> => {
    const [rows] = await exec(s) as unknown as [T[]];
    if (!rows[0]) throw new Error("TEST_ROW_MISSING");
    return rows[0];
  };
  const scope = () => ({ workspaceId: 7, creatorProjectId: ids.project, timelineId: ids.timeline });
  const config = { rendererVersion: "ffmpeg-probe-1", fontFamily: "Noto Sans Tamil" };
  const read = (overrides = {}) =>
    readCreatorRenderIntentFromDatabase({ ...scope(), ...overrides }, config, async () => d.db);

  beforeAll(async () => {
    d = await createTestDatabase();
    await exec(sql`INSERT INTO creatorProjects (workspaceId, name) VALUES (7, 'render-intent-owner'), (8, 'render-intent-foreign')`);
    ids.project = (await first<{id:number}>(sql`SELECT id FROM creatorProjects WHERE name = 'render-intent-owner'`)).id;
    ids.foreignProject = (await first<{id:number}>(sql`SELECT id FROM creatorProjects WHERE name = 'render-intent-foreign'`)).id;
    await exec(sql`INSERT INTO creatorScenes (workspaceId, creatorProjectId, sceneIndex, title) VALUES
      (7, ${ids.project}, 0, 'main'), (8, ${ids.foreignProject}, 0, 'outside')`);
    ids.scene = (await first<{id:number}>(sql`SELECT id FROM creatorScenes WHERE creatorProjectId = ${ids.project}`)).id;
    ids.foreignScene = (await first<{id:number}>(sql`SELECT id FROM creatorScenes WHERE creatorProjectId = ${ids.foreignProject}`)).id;
    await exec(sql`INSERT INTO creatorShots (workspaceId, creatorProjectId, sceneId, shotIndex, title) VALUES
      (7, ${ids.project}, ${ids.scene}, 0, 'shot-one'),
      (7, ${ids.project}, ${ids.scene}, 1, 'shot-two'),
      (8, ${ids.foreignProject}, ${ids.foreignScene}, 0, 'foreign-shot')`);
    ids.shot1 = (await first<{id:number}>(sql`SELECT id FROM creatorShots WHERE title = 'shot-one'`)).id;
    ids.shot2 = (await first<{id:number}>(sql`SELECT id FROM creatorShots WHERE title = 'shot-two'`)).id;
    ids.foreignShot = (await first<{id:number}>(sql`SELECT id FROM creatorShots WHERE title = 'foreign-shot'`)).id;
    await exec(sql`INSERT INTO creatorAssets
      (workspaceId, creatorProjectId, shotId, assetType, mimeType, storageKey, checksumSha256, byteSize, immutable, provenanceJson, reviewDecision)
      VALUES
      (7, ${ids.project}, NULL, 'AUDIO_MASTER','audio/wav','intent/audio.wav',${"a".repeat(64)},128,1,'{"durationMs":4000}','APPROVED'),
      (7, ${ids.project}, ${ids.shot1}, 'VIDEO','video/mp4','intent/clip.mp4',${"b".repeat(64)},128,1,'{}','APPROVED'),
      (7, ${ids.project}, NULL, 'IMAGE','image/png','intent/montage.png',${"c".repeat(64)},128,1,'{}','APPROVED')`);
    ids.audio = (await first<{id:number}>(sql`SELECT id FROM creatorAssets WHERE storageKey='intent/audio.wav'`)).id;
    ids.clip = (await first<{id:number}>(sql`SELECT id FROM creatorAssets WHERE storageKey='intent/clip.mp4'`)).id;
    ids.montage = (await first<{id:number}>(sql`SELECT id FROM creatorAssets WHERE storageKey='intent/montage.png'`)).id;
    await exec(sql`INSERT INTO creatorTimelines (workspaceId, creatorProjectId, name, audioMasterAssetId, width, height, fps)
      VALUES (7, ${ids.project},'main', ${ids.audio}, 1920,1080,24)`);
    ids.timeline = (await first<{id:number}>(sql`SELECT id FROM creatorTimelines WHERE creatorProjectId = ${ids.project}`)).id;
    await exec(sql`INSERT INTO creatorTimelineItems (workspaceId, creatorProjectId, timelineId, assetId, shotId, track, sortOrder, startMs, endMs)
      VALUES (7,${ids.project},${ids.timeline},${ids.clip},${ids.shot1},1,0,0,2000),
             (7,${ids.project},${ids.timeline},${ids.montage},${ids.shot2},1,1,2000,4000)`);
    await exec(sql`INSERT INTO creatorCaptionCues (workspaceId,creatorProjectId,timelineId,startMs,endMs,text,language,locked)
      VALUES (7,${ids.project},${ids.timeline},0,3000,'முருகா வேல்','ta',1)`);
  });
  afterAll(async () => { await d?.close(); });
  beforeEach(async () => {
    await exec(sql`DELETE FROM creatorRenderClaims WHERE timelineId = ${ids.timeline}`);
    await exec(sql`DELETE FROM creatorExports WHERE timelineId = ${ids.timeline}`);
    await exec(sql`UPDATE creatorAssets SET immutable=1, reviewDecision='APPROVED' WHERE id IN (${ids.audio},${ids.clip},${ids.montage})`);
    await exec(sql`UPDATE creatorAssets SET checksumSha256=${"b".repeat(64)} WHERE id=${ids.clip}`);
    await exec(sql`UPDATE creatorTimelines SET audioMasterAssetId=${ids.audio} WHERE id=${ids.timeline}`);
    await exec(sql`DELETE FROM creatorCaptionCues WHERE timelineId=${ids.timeline}`);
    await exec(sql`INSERT INTO creatorCaptionCues (workspaceId,creatorProjectId,timelineId,startMs,endMs,text,language,locked)
      VALUES (7,${ids.project},${ids.timeline},0,3000,'முருகா வேல்','ta',1)`);
    await exec(sql`DELETE FROM creatorTimelineItems WHERE timelineId=${ids.timeline}`);
    await exec(sql`INSERT INTO creatorTimelineItems (workspaceId,creatorProjectId,timelineId,assetId,shotId,track,sortOrder,startMs,endMs)
      VALUES (7,${ids.project},${ids.timeline},${ids.clip},${ids.shot1},1,0,0,2000),
             (7,${ids.project},${ids.timeline},${ids.montage},${ids.shot2},1,1,2000,4000)`);
  });

  it("reads only database-persisted source identity and emits a stable content fingerprint", async () => {
    const a = await read(); const b = await read();
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(a.fingerprint).toBe(creatorRenderIntentFingerprint(a.intent).fingerprint);
    expect(a.intent).toMatchObject({
      workspaceId: 7, creatorProjectId: ids.project, timelineId: ids.timeline,
      mode: "MASTER_CANDIDATE", audioMaster: {assetId:ids.audio, durationMs:4000},
      visuals: [{assetId:ids.clip, shotId:ids.shot1}, {assetId:ids.montage, shotId:ids.shot2}],
      captions: [{text:"முருகா வேல்", locked:true, language:"ta"}],
      output:{width:1920,height:1080,fit:"pad",fps:24},
    });
    expect(JSON.stringify(a.intent)).not.toContain("intent/audio.wav");
    expect(JSON.stringify(a.intent)).not.toContain("signed");
    const [rows] = await exec(sql`SELECT COUNT(*) AS n FROM creatorRenderClaims`) as unknown as [[{n:number}]];
    expect(Number(rows[0].n)).toBe(0);
  });

  it("changes identity on persisted Tamil caption or approved source checksum", async () => {
    const firstKey=(await read()).fingerprint;
    await exec(sql`UPDATE creatorCaptionCues SET text='முருகா சரணம்' WHERE timelineId=${ids.timeline}`);
    const captionKey=(await read()).fingerprint;
    expect(captionKey).not.toBe(firstKey);
    await exec(sql`UPDATE creatorAssets SET checksumSha256=${"d".repeat(64)} WHERE id=${ids.clip}`);
    const assetKey=(await read()).fingerprint;
    expect(assetKey).not.toBe(captionKey);
  });

  it("fails closed on unapproved/unlocked source, captions, and incomplete track", async () => {
    await exec(sql`UPDATE creatorAssets SET immutable=0 WHERE id=${ids.clip}`);
    await expect(read()).rejects.toThrow("CREATOR_RENDER_INTENT_SOURCE_NOT_IMMUTABLE_APPROVED");
    await exec(sql`UPDATE creatorAssets SET immutable=1 WHERE id=${ids.clip}`);
    await exec(sql`UPDATE creatorCaptionCues SET locked=0 WHERE timelineId=${ids.timeline}`);
    await expect(read()).rejects.toThrow("CREATOR_RENDER_INTENT_INVALID:caption");
    await exec(sql`UPDATE creatorCaptionCues SET locked=1 WHERE timelineId=${ids.timeline}`);
    await exec(sql`UPDATE creatorTimelineItems SET endMs=1800 WHERE assetId=${ids.clip} AND timelineId=${ids.timeline}`);
    await expect(read()).rejects.toThrow("CREATOR_RENDER_INTENT_GAP");
  });

  it("rejects foreign tenant shot attribution, even with a locally approved unbound montage asset", async () => {
    await exec(sql`UPDATE creatorTimelineItems SET shotId=${ids.foreignShot} WHERE timelineId=${ids.timeline} AND assetId=${ids.montage}`);
    await expect(read()).rejects.toThrow("CREATOR_RENDER_INTENT_FOREIGN_SHOT");
    await expect(read({ workspaceId: 8 })).rejects.toThrow("CREATOR_RENDER_INTENT_TIMELINE_NOT_FOUND");
  });

  it("allows only an approved, immutable, matching 16:9 parent for a 9:16 derivative", async () => {
    await exec(sql`INSERT INTO creatorAssets
      (workspaceId,creatorProjectId,assetType,mimeType,storageKey,checksumSha256,byteSize,immutable,provenanceJson,reviewDecision)
      VALUES (7,${ids.project},'RENDER','video/mp4','intent/master.mp4',${"e".repeat(64)},100,1,
      ${JSON.stringify({source:"deterministic-creator-render",timelineId:ids.timeline,visualAssetIds:[ids.clip,ids.montage],audioMasterChecksumSha256:"a".repeat(64)})},'APPROVED')`);
    const master=(await first<{id:number}>(sql`SELECT id FROM creatorAssets WHERE storageKey='intent/master.mp4'`)).id;
    const d1=await read({verticalDerivativeOf:master});
    expect(d1.intent).toMatchObject({mode:"VERTICAL_DERIVATIVE",derivativeOf:{assetId:master},output:{width:1080,height:1920,fit:"cover"}});
    await exec(sql`UPDATE creatorAssets SET reviewDecision='PENDING' WHERE id=${master}`);
    await expect(read({verticalDerivativeOf:master})).rejects.toThrow("CREATOR_RENDER_INTENT_SOURCE_NOT_IMMUTABLE_APPROVED");
    await exec(sql`UPDATE creatorAssets SET reviewDecision='APPROVED', provenanceJson=${JSON.stringify({source:"deterministic-creator-render",timelineId:ids.timeline,visualAssetIds:[ids.montage,ids.clip],audioMasterChecksumSha256:"a".repeat(64)})} WHERE id=${master}`);
    await expect(read({verticalDerivativeOf:master})).rejects.toThrow("CREATOR_RENDER_INTENT_DERIVATIVE_SOURCE_DRIFT");
  });
  it("reserves one source-derived claim and QUEUED export; duplicate never receives a lease token", async () => {
    const reservation = () => reserveCreatorRenderIntentFromDatabase(scope(), config, async () => d.db);
    const first = await reservation();
    expect(first.created).toBe(true);
    if (!first.created) throw new Error("EXPECTED_FIRST_RESERVATION");
    const second = await reservation();
    expect(second).toMatchObject({
      created: false, claimId: first.claimId, exportId: first.exportId,
      fingerprint: first.fingerprint,
    });
    expect("leaseToken" in second).toBe(false);
    const [rows] = await exec(sql`SELECT COUNT(*) AS n FROM creatorExports WHERE timelineId = ${ids.timeline}`) as unknown as [[{ n: number }]];
    expect(Number(rows[0].n)).toBe(1);

    // A new approved Tamil cue snapshot is a DIFFERENT export reservation.
    await exec(sql`UPDATE creatorCaptionCues SET text = 'வேல் முருகா சரணம்' WHERE timelineId = ${ids.timeline}`);
    const changed = await reservation();
    expect(changed.created).toBe(true);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
  });

  it("rolls back both claim and export when queue insertion fails", async () => {
    await exec(sql`CREATE TRIGGER creatorIntentQueueAbort BEFORE INSERT ON creatorExports
      FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected atomic reservation failure'`);
    try {
      await expect(reserveCreatorRenderIntentFromDatabase(scope(), config, async () => d.db)).rejects.toThrow();
      const [rows] = await exec(sql`SELECT COUNT(*) AS n FROM creatorRenderClaims WHERE timelineId = ${ids.timeline}`) as unknown as [[{ n: number }]];
      expect(Number(rows[0].n)).toBe(0);
    } finally {
      await exec(sql`DROP TRIGGER IF EXISTS creatorIntentQueueAbort`);
    }
  });


  it("finalizeVerifiedExport commits verified asset, export and claim together; duplicates cannot complete", async () => {
    const { MysqlCreatorRenderClaims } = await import("./renderClaims");
    const reserved = await reserveCreatorRenderIntentFromDatabase(scope(), config, async () => d.db);
    expect(reserved.created).toBe(true);
    if (!reserved.created) throw new Error("TEST_RESERVATION_NOT_CREATED");
    const store = new MysqlCreatorRenderClaims(async () => d.db);
    const key = `creator/7/${ids.project}/renders/timeline-${ids.timeline}/export-${reserved.exportId}.mp4`;
    const output = {
      storageKey: key, checksumSha256: "d".repeat(64), byteSize: 256,
      width: 1920, height: 1080, fps: 24, durationMs: 4000, frameCount: 96,
      visualAssetIds: [ids.clip, ids.montage], renderer: "ffmpeg" as const,
    };
    const renderScope = { ...scope(), mode: "MASTER_CANDIDATE" as const, fingerprint: reserved.fingerprint };
    let verified = 0;
    const verify = async (storedKey: string, bytes: number, sha: string) => {
      expect(storedKey).toBe(key); expect(bytes).toBe(256);
      expect(sha).toBe(output.checksumSha256); verified++;
    };
    const done = await store.finalizeVerifiedExport(renderScope, reserved.leaseToken, reserved.exportId, output, verify);
    expect(done).toMatchObject({ exportId: reserved.exportId, reviewDecision: "PENDING" });
    expect(verified).toBe(1);
    const [assets] = await exec(sql`SELECT id, reviewDecision, immutable, provenanceJson
      FROM creatorAssets WHERE id = ${done.assetId}`) as unknown as [Array<{
        id: number; reviewDecision: string; immutable: number; provenanceJson: string;
      }>];
    expect(assets[0]).toMatchObject({ reviewDecision: "PENDING", immutable: 1 });
    expect(JSON.parse(assets[0].provenanceJson).intentFingerprint).toBe(reserved.fingerprint);
    const [exports] = await exec(sql`SELECT status, assetId FROM creatorExports WHERE id=${reserved.exportId}`) as unknown as [Array<{status:string;assetId:number}>];
    expect(exports[0]).toMatchObject({ status: "SUCCEEDED", assetId: done.assetId });
    const [claims] = await exec(sql`SELECT state, outputAssetId FROM creatorRenderClaims WHERE id=${reserved.claimId}`) as unknown as [Array<{state:string;outputAssetId:number}>];
    expect(claims[0]).toMatchObject({ state: "SUCCEEDED", outputAssetId: done.assetId });
    await expect(store.finalizeVerifiedExport(renderScope, reserved.leaseToken, reserved.exportId, output, verify))
      .rejects.toThrow("CREATOR_RENDER_FINALIZE_FENCE_LOST");
  });

  it("rejects corrupt readback, forged tokens and expired leases without creating render assets", async () => {
    const { MysqlCreatorRenderClaims } = await import("./renderClaims");
    const reserved = await reserveCreatorRenderIntentFromDatabase(scope(), config, async () => d.db);
    if (!reserved.created) throw new Error("TEST_RESERVATION_NOT_CREATED");
    const store = new MysqlCreatorRenderClaims(async () => d.db);
    const output = {
      storageKey: `creator/7/${ids.project}/renders/timeline-${ids.timeline}/export-${reserved.exportId}.mp4`,
      checksumSha256: "d".repeat(64), byteSize: 256,
      width: 1920, height: 1080, fps: 24, durationMs: 4000, frameCount: 96,
      visualAssetIds: [ids.clip, ids.montage], renderer: "ffmpeg" as const,
    };
    const renderScope = { ...scope(), mode: "MASTER_CANDIDATE" as const, fingerprint: reserved.fingerprint };
    const ok = async () => undefined;
    const corrupt = async () => { throw new Error("STORAGE_SHA256_MISMATCH"); };
    await expect(store.finalizeVerifiedExport(renderScope, reserved.leaseToken, reserved.exportId, output, corrupt))
      .rejects.toThrow("STORAGE_SHA256_MISMATCH");
    await expect(store.finalizeVerifiedExport(renderScope, "00000000-0000-4000-8000-000000000000",
      reserved.exportId, output, ok)).rejects.toThrow("CREATOR_RENDER_FINALIZE_FENCE_LOST");
    await exec(sql`UPDATE creatorRenderClaims SET leaseUntil=DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND)
      WHERE id=${reserved.claimId}`);
    await expect(store.finalizeVerifiedExport(renderScope, reserved.leaseToken, reserved.exportId, output, ok))
      .rejects.toThrow("CREATOR_RENDER_FINALIZE_FENCE_LOST");
    const [assets] = await exec(sql`SELECT COUNT(*) AS n FROM creatorAssets
      WHERE storageKey=${output.storageKey}`) as unknown as [[{n:number}]];
    expect(Number(assets[0].n)).toBe(0);
    const [exports] = await exec(sql`SELECT status, assetId FROM creatorExports WHERE id=${reserved.exportId}`) as unknown as [Array<{status:string;assetId:number|null}>];
    expect(exports[0]).toMatchObject({ status: "QUEUED", assetId: null });
  });

  it("rolls back render asset insertion if export finalization fails", async () => {
    const { MysqlCreatorRenderClaims } = await import("./renderClaims");
    const reserved = await reserveCreatorRenderIntentFromDatabase(scope(), config, async () => d.db);
    if (!reserved.created) throw new Error("TEST_RESERVATION_NOT_CREATED");
    const store = new MysqlCreatorRenderClaims(async () => d.db);
    const output = {
      storageKey: `creator/7/${ids.project}/renders/timeline-${ids.timeline}/export-${reserved.exportId}.mp4`,
      checksumSha256: "d".repeat(64), byteSize: 256,
      width: 1920, height: 1080, fps: 24, durationMs: 4000, frameCount: 96,
      visualAssetIds: [ids.clip, ids.montage], renderer: "ffmpeg" as const,
    };
    const renderScope = { ...scope(), mode: "MASTER_CANDIDATE" as const, fingerprint: reserved.fingerprint };
    await exec(sql`CREATE TRIGGER creatorFinalizeAbort BEFORE UPDATE ON creatorExports
      FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected export finalization failure'`);
    try {
      await expect(store.finalizeVerifiedExport(renderScope, reserved.leaseToken, reserved.exportId, output,
        async () => undefined)).rejects.toThrow();
      const [assets] = await exec(sql`SELECT COUNT(*) AS n FROM creatorAssets WHERE storageKey=${output.storageKey}`) as unknown as [[{n:number}]];
      expect(Number(assets[0].n)).toBe(0);
      const [claims] = await exec(sql`SELECT state FROM creatorRenderClaims WHERE id=${reserved.claimId}`) as unknown as [Array<{state:string}>];
      expect(claims[0].state).toBe("RUNNING");
    } finally {
      await exec(sql`DROP TRIGGER IF EXISTS creatorFinalizeAbort`);
    }
  });


});
