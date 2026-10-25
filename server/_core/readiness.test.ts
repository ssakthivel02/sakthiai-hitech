import { describe, expect, it, vi } from "vitest";
import { probeDatabaseReadiness } from "./readiness";

describe("database readiness", () => {
  it("passes only when the live database query succeeds", async () => {
    const liveProbe = vi.fn().mockResolvedValue(undefined);

    await expect(probeDatabaseReadiness(liveProbe)).resolves.toBe(true);
    expect(liveProbe).toHaveBeenCalledOnce();
  });

  it("fails closed when a cached database handle can no longer execute a live query", async () => {
    const staleHandleProbe = vi.fn().mockRejectedValue(new Error("ECONNRESET"));

    await expect(probeDatabaseReadiness(staleHandleProbe)).resolves.toBe(false);
    expect(staleHandleProbe).toHaveBeenCalledOnce();
  });
});
