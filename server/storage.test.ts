import { describe, expect, it, vi } from "vitest";
import { storageRoundTripProbe } from "./storage";

describe("storageRoundTripProbe", () => {
  it("uses exact ranged SHA-256 verification for runtime readiness and deletes the canary", async () => {
    const payloads = new Map<string, Buffer>();
    const verify = vi.fn(async (key: string, size: number, checksum: string) => {
      const bytes = payloads.get(key);
      expect(bytes).toBeDefined();
      expect(size).toBe(bytes!.byteLength);
      expect(checksum).toMatch(/^[0-9a-f]{64}$/);
      const { createHash } = await import("node:crypto");
      expect(checksum).toBe(createHash("sha256").update(bytes!).digest("hex"));
    });
    const remove = vi.fn(async (key: string) => { payloads.delete(key); });
    const result = await storageRoundTripProbe({
      put: async (_key, data) => {
        const key = "creator/runtime-probes/storage-canary_verified.txt";
        payloads.set(key, Buffer.from(data));
        return { key, url: `/api/storage/${key}` };
      },
      verify,
      delete: remove,
    });
    expect(result.pass).toBe(true);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(payloads.size).toBe(0);
  });

  it("fails readiness and still deletes the canary when ranged verification fails", async () => {
    const remove = vi.fn(async () => undefined);
    const result = await storageRoundTripProbe({
      put: async () => ({ key: "creator/runtime-probes/failing.txt", url: "/u" }),
      verify: async () => { throw new Error("CREATOR_STORAGE_RANGE_NOT_HONORED"); },
      delete: remove,
    });
    expect(result).toEqual({ pass: false, detail: "Storage write/read round-trip failed." });
    expect(remove).toHaveBeenCalledTimes(1);
  });

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

    expect(result).toEqual({ pass: true, detail: "Storage write/verified-read/delete round-trip succeeded; canary SHA-256 matched." });
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
