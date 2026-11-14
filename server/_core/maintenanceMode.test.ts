import { describe, expect, it } from "vitest";
import { maintenanceModeFromEnv } from "./maintenanceMode";

describe("maintenance mode switch", () => {
  it("is off when unset, empty or false; on only for true; any other value fails closed (on, with a warning)", () => {
    expect(maintenanceModeFromEnv({})).toEqual({ enabled: false });
    expect(maintenanceModeFromEnv({ SAKTHIAI_MAINTENANCE_MODE: "" })).toEqual({ enabled: false });
    expect(maintenanceModeFromEnv({ SAKTHIAI_MAINTENANCE_MODE: " FALSE " })).toEqual({ enabled: false });
    expect(maintenanceModeFromEnv({ SAKTHIAI_MAINTENANCE_MODE: "true" })).toEqual({ enabled: true });
    expect(maintenanceModeFromEnv({ SAKTHIAI_MAINTENANCE_MODE: "True" })).toEqual({ enabled: true });
    for (const v of ["1", "yes", "on", "ture"]) {
      const s = maintenanceModeFromEnv({ SAKTHIAI_MAINTENANCE_MODE: v });
      expect(s.enabled, v).toBe(true);
      expect(s.warning, v).toMatch(/fail closed/);
    }
  });
});
