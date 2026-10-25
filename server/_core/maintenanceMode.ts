import type { NextFunction, Request, Response } from "express";

/**
 * Application maintenance mode: a tested containment path for builds that contain it.
 *
 * SAKTHIAI_MAINTENANCE_MODE=true makes the server refuse every route except /healthz, /readyz and /releasez with 503
 * before any body parsing, authentication, database, storage, OAuth, tRPC or static handler runs. /healthz stays 200 so
 * the host does not restart-loop; /readyz reports not ready; background runners do not start.
 * Fail closed: any value other than unset, "" or "false" (for example a typo such as "yes") enables it and is logged.
 * Changing the variable needs a restart. Builds before this commit (including 469c668) do not have it: for them the only
 * containment is suspending the service.
 */
export type MaintenanceState = { enabled: boolean; warning?: string };

export function maintenanceModeFromEnv(env: NodeJS.ProcessEnv = process.env): MaintenanceState {
  const raw = env.SAKTHIAI_MAINTENANCE_MODE?.trim().toLowerCase() ?? "";
  if (raw === "" || raw === "false") return { enabled: false };
  if (raw === "true") return { enabled: true };
  return { enabled: true, warning: `SAKTHIAI_MAINTENANCE_MODE=${JSON.stringify(raw.slice(0, 16))} is not "true" or "false"; maintenance mode enabled (fail closed)` };
}

const OPERATIONAL = new Set(["/healthz", "/readyz", "/releasez"]);
export const MAINTENANCE_RETRY_AFTER_SECONDS = 300;

export function maintenanceGate(state: MaintenanceState) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!state.enabled || OPERATIONAL.has(req.path)) return next();
    res.setHeader("Retry-After", String(MAINTENANCE_RETRY_AFTER_SECONDS));
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    if (req.path.startsWith("/api/")) {
      res.status(503).json({ error: { code: "SERVICE_UNAVAILABLE", reason: "MAINTENANCE", message: "SakthiAI is temporarily unavailable for maintenance." } });
      return;
    }
    res.status(503).type("html").send('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SakthiAI maintenance</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>Temporarily unavailable</h1><p>SakthiAI is down for maintenance. Please try again later.</p></body></html>');
  };
}
