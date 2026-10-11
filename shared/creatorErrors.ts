/**
 * Human-readable explanations for Creator server error codes. Pure; shared by the client (display) and tests.
 * The raw code is always kept so support can match it to server logs. Unknown messages pass through unchanged,
 * except provider/internal failures, which are never shown verbatim.
 */
export type CreatorErrorView = { title: string; detail: string; code: string; action?: string; kind: "blocked" | "limit" | "retry" | "error" };

const SCOPE: Record<string, string> = { global: "the platform-wide", workspace: "this workspace's", user: "your" };

export function describeCreatorError(raw: string | null | undefined): CreatorErrorView {
  const message = (raw ?? "").trim();
  const [code, arg] = message.split(":", 2) as [string, string | undefined];

  switch (code) {
    case "CREATOR_PAID_GENERATION_DISABLED":
      return { code, kind: "blocked", title: "Paid generation is switched off", detail: "Image and video generation is disabled on this deployment. No request was sent to any provider and nothing was charged.", action: "Ask the administrator to enable paid generation." };
    case "CREATOR_PAID_GENERATION_NOT_AUTHORIZED":
      return { code: message, kind: "blocked", title: `Not approved for paid ${arg === "VIDEO" ? "video" : "image"} generation`, detail: `Your account is not on the approved list for ${arg === "VIDEO" ? "video" : "image"} generation. Image approval does not include video.`, action: "Ask the administrator to approve your account." };
    case "CREATOR_WORKSPACE_OWNER_REQUIRED":
      return { code, kind: "blocked", title: "Workspace owner required", detail: "Only the workspace owner can submit, retry or cancel paid generations." };
    case "CREATOR_SPEND_POLICY_INVALID":
      return { code, kind: "blocked", title: "Spending limits are not configured", detail: "Paid generation is enabled but its prices or daily limits are missing or invalid, so every request is refused.", action: "The administrator must complete the spend policy." };
    case "CREATOR_MODEL_NOT_PRICED":
      return { code: message, kind: "blocked", title: "Model has no configured price", detail: `${arg ?? "This model"} has no server-side price, so its cost cannot be budgeted. Nothing was submitted.`, action: "Choose another model or ask the administrator to add its price." };
    case "CREATOR_BUDGET_EXHAUSTED":
      return { code: message, kind: "limit", title: "Daily budget reached", detail: `This request would exceed ${SCOPE[arg ?? ""] ?? "a"} daily generation or cost limit. Nothing was submitted or charged.`, action: "Try again after 00:00 UTC, or ask the administrator to raise the limit." };
    case "CREATOR_SPEND_LEDGER_UNAVAILABLE":
      return { code, kind: "retry", title: "Spend control unavailable", detail: "The budget ledger could not be reached, so the request was refused to protect against unbudgeted charges.", action: "Try again in a few minutes." };
    case "CREATOR_RUNTIME_ACCEPTANCE_BLOCKED":
      return { code: message, kind: "blocked", title: "Creator runtime is not ready", detail: `A required dependency failed its readiness check (${arg ?? "unknown"}). Nothing was submitted.` };
    case "CREATOR_SUBMISSION_RECONCILIATION_REQUIRED":
      return { code, kind: "blocked", title: "Submission outcome unknown", detail: "The provider may or may not have accepted this job. It will not be resubmitted automatically; an administrator must reconcile it." };
    case "CREATOR_PROVIDER_REQUEST_FAILED":
      return { code, kind: "retry", title: "The provider request failed", detail: "The generation provider returned an error. Check the generation list before trying again." };
  }
  if (/^Rate limit exceeded/i.test(message)) return { code: "TOO_MANY_REQUESTS", kind: "limit", title: "Too many requests", detail: message };
  if (message.startsWith("CREATOR_")) return { code: message, kind: "error", title: "Creator request refused", detail: message };
  return { code: message || "UNKNOWN", kind: "error", title: "Creator operation failed", detail: message || "Unknown error" };
}
