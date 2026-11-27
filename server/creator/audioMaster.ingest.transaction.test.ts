import { beforeEach, describe, expect, it, vi } from "vitest";
import { creatorAssets, creatorProjects, creatorTimelines } from "../../drizzle/schema";

const { getDbMock, storagePutMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  storagePutMock: vi.fn(),
}));
vi.mock("../db", () => ({ getDb: getDbMock }));
vi.mock("../storage", () => ({ storagePut: storagePutMock }));

import { ingestApprovedAudioMaster } from "./audioMaster";

const makeWav = () => {
  const buffer = Buffer.alloc(44 + 16000);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(16000, 40);
  return buffer;
};

const input = () => ({
  workspaceId: 11,
  creatorProjectId: 22,
  filename: "முருகன் master.wav",
  mimeType: "audio/wav" as const,
  data: makeWav(),
  approvedByUserId: 55,
});

type Asset = { id: number; assetType: string; storageKey: string; checksumSha256: string };
type Timeline = { id: number; audioMasterAssetId: number };
type Options = {
  alreadyLocked?: boolean;
  duplicateAtPreflight?: boolean;
  lockedAfterPreflight?: boolean;
  duplicateAfterPreflight?: boolean;
  failAssetInsert?: boolean;
  failProjectUpdate?: boolean;
  failTimelineInsert?: boolean;
  failTimelineId?: boolean;
};

function fakeDb(options: Options = {}) {
  let pointer: number | null = options.alreadyLocked ? 90 : null;
  let assets: Asset[] = [];
  let timelines: Timeline[] = [];
  let locks = 0;
  const selectRows = (table: unknown, inTransaction: boolean) => {
    if (table === creatorProjects) return [{
      id: 22,
      audioMasterAssetId: inTransaction && options.lockedAfterPreflight ? 91 : pointer,
    }];
    if (table === creatorAssets) {
      if (!inTransaction && options.duplicateAtPreflight) return [{ id: 77 }];
      if (inTransaction && options.duplicateAfterPreflight) return [{ id: 78 }];
      return assets.map(({ id }) => ({ id }));
    }
    return [];
  };
  const select = (inTransaction: boolean) => () => ({
    from: (table: unknown) => ({
      where: () => ({
        limit: () => ({
          then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve(selectRows(table, inTransaction)).then(resolve, reject),
          for: async (mode: string) => {
            expect(mode).toBe("update");
            locks++;
            return selectRows(table, inTransaction);
          },
        }),
      }),
    }),
  });
  const transaction = vi.fn(async (run: (tx: any) => Promise<unknown>) => {
    let stagedPointer = pointer;
    const stagedAssets = structuredClone(assets);
    const stagedTimelines = structuredClone(timelines);
    const tx = {
      select: select(true),
      insert: (table: unknown) => ({
        values: async (value: Record<string, any>) => {
          if (table === creatorAssets) {
            if (options.failAssetInsert) throw new Error("INJECTED_ASSET_INSERT");
            stagedAssets.push({
              id: 101,
              assetType: value.assetType,
              storageKey: value.storageKey,
              checksumSha256: value.checksumSha256,
            });
            return [{ insertId: 101 }];
          }
          if (table === creatorTimelines) {
            if (options.failTimelineInsert) throw new Error("INJECTED_TIMELINE_INSERT");
            stagedTimelines.push({ id: 202, audioMasterAssetId: value.audioMasterAssetId });
            return [{ insertId: options.failTimelineId ? 0 : 202 }];
          }
          throw new Error("UNEXPECTED_TABLE");
        },
      }),
      update: (table: unknown) => {
        expect(table).toBe(creatorProjects);
        return {
          set: (values: { audioMasterAssetId: number }) => ({
            where: async () => {
              if (options.failProjectUpdate) throw new Error("INJECTED_PROJECT_UPDATE");
              stagedPointer = values.audioMasterAssetId;
            },
          }),
        };
      },
    };
    const result = await run(tx);
    pointer = stagedPointer;
    assets = stagedAssets;
    timelines = stagedTimelines;
    return result;
  });
  getDbMock.mockResolvedValue({ select: select(false), transaction });
  return {
    get pointer() { return pointer; },
    get assets() { return assets; },
    get timelines() { return timelines; },
    get locks() { return locks; },
    transaction,
  };
}

describe("Creator approved audio master ingestion atomicity", () => {
  beforeEach(() => {
    getDbMock.mockReset();
    storagePutMock.mockReset();
    storagePutMock.mockResolvedValue({ key: "creator/11/22/audio-master/unique-abc.wav", url: "/api/storage/unique-abc.wav" });
  });

  it("commits immutable approved asset, project lock and 16:9 timeline together", async () => {
    const db = fakeDb();
    const result = await ingestApprovedAudioMaster(input());
    expect(result).toMatchObject({ assetId: 101, timelineId: 202, durationMs: 1000, immutable: true });
    expect(db.pointer).toBe(101);
    expect(db.assets).toHaveLength(1);
    expect(db.assets[0].storageKey).toBe(result.storageKey);
    expect(db.timelines).toEqual([{ id: 202, audioMasterAssetId: 101 }]);
    expect(db.locks).toBe(1);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(storagePutMock).toHaveBeenCalledTimes(1);
  });

  it("rolls back asset and project pointer if timeline creation fails", async () => {
    const db = fakeDb({ failTimelineInsert: true });
    await expect(ingestApprovedAudioMaster(input())).rejects.toThrow("INJECTED_TIMELINE_INSERT");
    expect(db.pointer).toBeNull();
    expect(db.assets).toEqual([]);
    expect(db.timelines).toEqual([]);
    expect(db.locks).toBe(1);
  });

  it("rolls back when timeline returns an invalid insert ID", async () => {
    const db = fakeDb({ failTimelineId: true });
    await expect(ingestApprovedAudioMaster(input())).rejects.toThrow("CREATOR_TIMELINE_CREATE_FAILED");
    expect(db.pointer).toBeNull();
    expect(db.assets).toEqual([]);
    expect(db.timelines).toEqual([]);
  });

  it("rolls back if the project pointer update fails", async () => {
    const db = fakeDb({ failProjectUpdate: true });
    await expect(ingestApprovedAudioMaster(input())).rejects.toThrow("INJECTED_PROJECT_UPDATE");
    expect(db.pointer).toBeNull();
    expect(db.assets).toEqual([]);
  });

  it("rejects an asset insert failure without changing the project", async () => {
    const db = fakeDb({ failAssetInsert: true });
    await expect(ingestApprovedAudioMaster(input())).rejects.toThrow("INJECTED_ASSET_INSERT");
    expect(db.pointer).toBeNull();
    expect(db.assets).toEqual([]);
  });

  it("rechecks the master lock inside the transaction after object upload", async () => {
    const db = fakeDb({ lockedAfterPreflight: true });
    await expect(ingestApprovedAudioMaster(input())).rejects.toThrow("CREATOR_AUDIO_MASTER_ALREADY_LOCKED");
    expect(db.assets).toEqual([]);
    expect(db.timelines).toEqual([]);
    expect(db.locks).toBe(1);
  });

  it("rechecks duplicate checksum inside the transaction", async () => {
    const db = fakeDb({ duplicateAfterPreflight: true });
    await expect(ingestApprovedAudioMaster(input())).rejects.toThrow("CREATOR_AUDIO_DUPLICATE");
    expect(db.assets).toEqual([]);
    expect(db.timelines).toEqual([]);
  });

  it("rejects already locked project before writing to object storage", async () => {
    const db = fakeDb({ alreadyLocked: true });
    await expect(ingestApprovedAudioMaster(input())).rejects.toThrow("CREATOR_AUDIO_MASTER_ALREADY_LOCKED");
    expect(storagePutMock).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("rejects duplicate checksum before writing to object storage", async () => {
    const db = fakeDb({ duplicateAtPreflight: true });
    await expect(ingestApprovedAudioMaster(input())).rejects.toThrow("CREATOR_AUDIO_DUPLICATE");
    expect(storagePutMock).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("does not begin a transaction if object storage upload fails", async () => {
    const db = fakeDb();
    storagePutMock.mockRejectedValueOnce(new Error("INJECTED_STORAGE_FAILURE"));
    await expect(ingestApprovedAudioMaster(input())).rejects.toThrow("INJECTED_STORAGE_FAILURE");
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.pointer).toBeNull();
  });
});
