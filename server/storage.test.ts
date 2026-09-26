import { describe, expect, it, vi } from "vitest";
import { storageRoundTripProbe } from "./storage";

describe("storageRoundTripProbe", () => {
  it("requires write, read, byte equality and delete", async () => {
    const payloads = new Map<string, Uint8Array>();
    const remove = vi.fn(async (key: string) => { payloads.delete(key); });
    const result = await storageRoundTripProbe({
      put: async (_key, data) => {
        const key = "creator/runtime-probes/storage-canary_test.txt";
        payloads.set(key, Buffer.from(data));
        return { key, url: `/api/storage/${key}` };
      },
      read: async key => payloads.get(key) ?? new Uint8Array(),
      delete: remove,
    });

    expect(result.pass).toBe(true);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("fails acceptance when delete fails after a successful write/read", async () => {
    let stored = new Uint8Array();
    const result = await storageRoundTripProbe({
      put: async (_key, data) => {
        stored = Buffer.from(data);
        return { key: "probe.txt", url: "/api/storage/probe.txt" };
      },
      read: async () => stored,
      delete: async () => { throw new Error("delete denied"); },
    });

    expect(result).toEqual({ pass: false, detail: "Storage delete verification failed." });
  });

  it("preserves the primary read/write failure when cleanup also fails", async () => {
    const result = await storageRoundTripProbe({
      put: async () => ({ key: "probe.txt", url: "/api/storage/probe.txt" }),
      read: async () => { throw new Error("read failed"); },
      delete: async () => { throw new Error("delete failed"); },
    });

    expect(result).toEqual({ pass: false, detail: "Storage write/read round-trip failed." });
  });
});
