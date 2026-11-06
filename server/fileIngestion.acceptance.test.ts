import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import { extractDocument } from "./provenance";
import type { MalwareScanner } from "./security/malwareScanner";

const cleanScanner: MalwareScanner = {
  engine: "fixture-clean",
  async scan() {
    return { status: "clean", engine: "fixture-clean" };
  },
};

const infectedScanner: MalwareScanner = {
  engine: "fixture-infected",
  async scan() {
    return {
      status: "infected",
      engine: "fixture-infected",
      signature: "Eicar-Signature",
    };
  },
};

describe("file ingestion extraction acceptance", () => {
  it("extracts UTF-8 text only after an explicit clean scan", async () => {
    const input = "alpha ".repeat(250) + "omega";
    const result = await extractDocument(Buffer.from(input, "utf8"), "text/plain", {
      scanner: cleanScanner,
    });
    expect(result.text).toBe(input.trim());
    expect(result.pageCount).toBe(1);
    expect(result.segments.length).toBeGreaterThan(1);
    for (const segment of result.segments) {
      expect(segment.content.length).toBeLessThanOrEqual(1200);
      expect(segment.sourceEnd - segment.sourceStart).toBe(segment.content.length);
      expect(segment.sourceStart).toBeGreaterThanOrEqual(0);
      expect(segment.sourceEnd).toBeLessThanOrEqual(result.text.length);
    }
  });

  it("returns no segments for clean whitespace-only text", async () => {
    const result = await extractDocument(Buffer.from("  \n\t  ", "utf8"), "text/plain", {
      scanner: cleanScanner,
    });
    expect(result.text).toBe("");
    expect(result.segments).toEqual([]);
    expect(result.pageCount).toBe(1);
  });

  it("rejects unsupported MIME types after the malware gate", async () => {
    await expect(
      extractDocument(Buffer.from("not an image"), "image/png", { scanner: cleanScanner }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    } satisfies Partial<TRPCError>);
  });

  it("fails closed when malware scanning is unavailable", async () => {
    await expect(
      extractDocument(Buffer.from("unscanned"), "text/plain", { scanner: null }),
    ).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "Malware scanner unavailable; upload blocked",
    } satisfies Partial<TRPCError>);
  });

  it("quarantines infected content before extraction", async () => {
    await expect(
      extractDocument(Buffer.from("infected"), "text/plain", { scanner: infectedScanner }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Upload quarantined by malware policy",
    } satisfies Partial<TRPCError>);
  });
});
