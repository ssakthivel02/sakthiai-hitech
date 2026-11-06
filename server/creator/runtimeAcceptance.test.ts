import { describe, expect, it, vi } from "vitest";
import { verifyCreatorRuntimeAcceptance } from "./runtimeAcceptance";

const configured = {
  readyForPaidGeneration: true,
  productionApproved: false as const,
  checks: [
    { id: "DATABASE_CONFIGURED", required: true, pass: true, detail: "configured" },
    { id: "STORAGE_CONFIGURED", required: true, pass: true, detail: "configured" },
    { id: "IMAGE_PROVIDER_CONFIGURED", required: true, pass: true, detail: "configured" },
    { id: "VIDEO_PROVIDER_CONFIGURED", required: true, pass: true, detail: "configured" },
    { id: "FFMPEG_AVAILABLE", required: true, pass: true, detail: "available" },
  ],
};

describe("Creator runtime acceptance", () => {
  it("requires live database and storage evidence before paid generation", async () => {
    const result = await verifyCreatorRuntimeAcceptance({
      configuration: configured,
      databaseProbe: async () => ({ pass: true, detail: "db ok" }),
      storageProbe: async () => ({ pass: true, detail: "storage ok" }),
    });

    expect(result.readyForPaidGeneration).toBe(true);
    expect(result.productionApproved).toBe(false);
    expect(result.checks.map(check => check.id)).toContain("CREATOR_DATABASE_QUERYABLE");
    expect(result.checks.map(check => check.id)).toContain("STORAGE_WRITE_READ_VERIFIED");
  });

  it("blocks paid generation when the Creator migration is missing", async () => {
    const result = await verifyCreatorRuntimeAcceptance({
      configuration: configured,
      databaseProbe: async () => ({ pass: false, detail: "migration missing" }),
      storageProbe: async () => ({ pass: true, detail: "storage ok" }),
    });

    expect(result.readyForPaidGeneration).toBe(false);
  });

  it("blocks paid generation when storage cannot round-trip bytes", async () => {
    const result = await verifyCreatorRuntimeAcceptance({
      configuration: configured,
      databaseProbe: async () => ({ pass: true, detail: "db ok" }),
      storageProbe: async () => ({ pass: false, detail: "storage failed" }),
    });

    expect(result.readyForPaidGeneration).toBe(false);
  });

  it("does not touch unavailable data planes when configuration is absent", async () => {
    const databaseProbe = vi.fn(async () => ({ pass: true, detail: "unexpected" }));
    const storageProbe = vi.fn(async () => ({ pass: true, detail: "unexpected" }));
    const result = await verifyCreatorRuntimeAcceptance({
      configuration: {
        ...configured,
        readyForPaidGeneration: false,
        checks: configured.checks.map(check =>
          check.id === "DATABASE_CONFIGURED" || check.id === "STORAGE_CONFIGURED"
            ? { ...check, pass: false }
            : check,
        ),
      },
      databaseProbe,
      storageProbe,
    });

    expect(result.readyForPaidGeneration).toBe(false);
    expect(databaseProbe).not.toHaveBeenCalled();
    expect(storageProbe).not.toHaveBeenCalled();
  });
});
