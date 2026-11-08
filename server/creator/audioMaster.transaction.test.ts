import { beforeEach, describe, expect, it, vi } from "vitest";
import { creatorAssets, creatorTimelines } from "../../drizzle/schema";

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));
vi.mock("../db", () => ({ getDb: getDbMock }));

import { replaceLockedCaptionCues } from "./audioMaster";

type SavedCue = { text: string; startMs: number; endMs: number; locked: number };
const request = {
  workspaceId: 11,
  creatorProjectId: 22,
  timelineId: 33,
  cues: [{ startMs: 0, endMs: 900, text: "முருகா", language: "ta" as const }],
};

function transactionalDb(options: { failInsert?: boolean; failDelete?: boolean; missingTimeline?: boolean } = {}) {
  let persisted: SavedCue[] = [{ text: "முந்தைய வரி", startMs: 0, endMs: 800, locked: 1 }];
  let deletes = 0;
  let inserts = 0;
  let locks = 0;
  const transaction = vi.fn(async (run: (tx: any) => Promise<unknown>) => {
    // This is a rollback-capable transactional fake: writes affect only the
    // snapshot until the callback succeeds. A rejected callback discards it.
    let staged = structuredClone(persisted);
    const tx = {
      select: () => ({
        from: (table: unknown) => {
          const rows = table === creatorTimelines
            ? options.missingTimeline ? [] : [{ id: 33, audioMasterAssetId: 44 }]
            : table === creatorAssets
              ? [{ id: 44, assetType: "AUDIO_MASTER", immutable: 1, provenanceJson: '{"durationMs":1000}' }]
              : [];
          return {
            where: () => ({
              limit: () => ({
                for: async (mode: string) => {
                  expect(mode).toBe("update");
                  locks++;
                  return rows;
                },
                then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
                  Promise.resolve(rows).then(resolve, reject),
              }),
            }),
          };
        },
      }),
      delete: () => ({
        where: async () => {
          deletes++;
          if (options.failDelete) throw new Error("INJECTED_DELETE_FAILURE");
          staged = [];
        },
      }),
      insert: () => ({
        values: async (rows: SavedCue[]) => {
          inserts++;
          staged.push(...rows);
          if (options.failInsert) throw new Error("INJECTED_INSERT_FAILURE");
        },
      }),
    };
    const result = await run(tx);
    persisted = staged;
    return result;
  });
  getDbMock.mockResolvedValue({ transaction });
  return {
    get saved() { return persisted; },
    get deletes() { return deletes; },
    get inserts() { return inserts; },
    get locks() { return locks; },
    transaction,
  };
}

describe("Creator caption replacement atomicity", () => {
  beforeEach(() => getDbMock.mockReset());

  it("commits validated Tamil cues and locks the timeline row", async () => {
    const db = transactionalDb();
    const result = await replaceLockedCaptionCues(request);
    expect(result).toMatchObject({ timelineId: 33, audioMasterAssetId: 44, cueCount: 1, locked: true });
    expect(db.saved).toMatchObject([{ text: "முருகா", startMs: 0, endMs: 900, locked: 1 }]);
    expect(db.locks).toBe(1);
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it("rolls back deletion when insertion fails after staging a new row", async () => {
    const db = transactionalDb({ failInsert: true });
    await expect(replaceLockedCaptionCues(request)).rejects.toThrow("INJECTED_INSERT_FAILURE");
    expect(db.deletes).toBe(1);
    expect(db.inserts).toBe(1);
    expect(db.saved).toEqual([{ text: "முந்தைய வரி", startMs: 0, endMs: 800, locked: 1 }]);
  });

  it("preserves previous cues when deletion fails", async () => {
    const db = transactionalDb({ failDelete: true });
    await expect(replaceLockedCaptionCues(request)).rejects.toThrow("INJECTED_DELETE_FAILURE");
    expect(db.inserts).toBe(0);
    expect(db.saved[0].text).toBe("முந்தைய வரி");
  });

  it("rejects invalid cue bounds without deleting prior approval", async () => {
    const db = transactionalDb();
    await expect(replaceLockedCaptionCues({
      ...request, cues: [{ startMs: 0, endMs: 1001, text: "முருகா" }],
    })).rejects.toThrow("CREATOR_CAPTION_OUTSIDE_AUDIO_MASTER");
    expect(db.deletes).toBe(0);
    expect(db.saved[0].text).toBe("முந்தைய வரி");
  });

  it("rejects unknown timelines without touching any captions", async () => {
    const db = transactionalDb({ missingTimeline: true });
    await expect(replaceLockedCaptionCues(request)).rejects.toThrow("CREATOR_TIMELINE_NOT_FOUND");
    expect(db.deletes).toBe(0);
  });

  it("commits an explicit empty replacement as an intentional clear", async () => {
    const db = transactionalDb();
    const result = await replaceLockedCaptionCues({ ...request, cues: [] });
    expect(result.cueCount).toBe(0);
    expect(db.saved).toEqual([]);
    expect(db.inserts).toBe(0);
  });
});
