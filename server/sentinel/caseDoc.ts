import type { CaseDoc } from "./engine/types";
import { tenantOf } from "./config";
import type { InvestigationRecord } from "./types";

/** The engine case is a pure projection of the stored row. The tenant comes from the row's workspace, never from any payload. */
export const caseFromRecord = (r: InvestigationRecord): CaseDoc => ({
  case_id: r.id,
  tenant: tenantOf(r.workspaceId),
  objective: r.objective,
  alert: { title: r.title, severity: r.severity, service: r.service, fired_at: r.firedAt, description: r.description },
  operator_notes: r.operatorNotes,
  inventory: { services: r.inventory.services, hosts: r.inventory.hosts },
  allowed_tools: r.allowedTools,
  limits: r.limits,
});
