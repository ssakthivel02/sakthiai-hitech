/**
 * Human-readable explanations for Creator server error codes. Pure; shared by the client (display) and tests.
 * The raw code is always kept so support can match it to server logs. Unknown messages pass through unchanged,
 * except provider/internal failures, which are never shown verbatim.
 */
export type CreatorErrorView = { title: string; detail: string; code: string; action?: string; kind: "blocked" | "limit" | "retry" | "error" };

const KIND_LABEL: Record<string, string> = { IMAGE: "image", VIDEO: "video", SPEECH: "speech", AVATAR_VIDEO: "avatar video" };
const SCOPE: Record<string, string> = { global: "the platform-wide", workspace: "this workspace's", user: "your" };

export function describeCreatorError(raw: string | null | undefined): CreatorErrorView {
  const message = (raw ?? "").trim();
  const [code, arg] = message.split(":", 2) as [string, string | undefined];

  switch (code) {
    case "CREATOR_PAID_GENERATION_DISABLED":
      return { code, kind: "blocked", title: "Paid generation is switched off", detail: "Image and video generation is disabled on this deployment. No request was sent to any provider and nothing was charged.", action: "Ask the administrator to enable paid generation." };
    case "CREATOR_PAID_GENERATION_NOT_AUTHORIZED": {
      const label = KIND_LABEL[arg ?? ""] ?? "image";
      return { code: message, kind: "blocked", title: `Not approved for paid ${label} generation`, detail: `Your account is not on the approved list for ${label} generation. Each kind is approved separately: image approval does not include video, and speech approval does not include avatar video.`, action: "Ask the administrator to approve your account." };
    }
    case "CREATOR_CONSENT_NOT_FOUND":
    case "CREATOR_CONSENT_PURPOSE_MISMATCH":
    case "CREATOR_CONSENT_SUBJECT_MISMATCH":
      return { code, kind: "blocked", title: "No matching consent record", detail: "Avatar video needs an active consent record in this workspace for exactly this avatar and purpose. Nothing was submitted or charged.", action: "Ask the workspace owner to record the consent evidence first." };
    case "CREATOR_CONSENT_REVOKED_OR_NOT_ACTIVE":
    case "CREATOR_CONSENT_REVOKED":
      return { code, kind: "blocked", title: "Consent was revoked", detail: "The consent for this avatar has been revoked, so no new video can be generated with it. Nothing was submitted or charged." };
    case "CREATOR_CONSENT_EXPIRED":
      return { code, kind: "blocked", title: "Consent has expired", detail: "The consent for this avatar is past its validity date. Nothing was submitted or charged.", action: "Record renewed consent evidence." };
    case "CREATOR_AVATAR_AUDIO_NOT_APPROVED":
    case "CREATOR_AVATAR_AUDIO_MUTABLE":
      return { code, kind: "blocked", title: "Audio is not approved", detail: "Only approved, locked audio (such as the project's audio master) can drive an avatar. Nothing was submitted or charged." };
    case "CREATOR_AVATAR_AUDIO_NOT_FOUND":
    case "CREATOR_AVATAR_AUDIO_SCOPE_MISMATCH":
    case "CREATOR_AVATAR_AUDIO_NOT_AUDIO":
    case "CREATOR_AVATAR_AUDIO_MIME_UNSUPPORTED":
    case "CREATOR_AVATAR_AUDIO_INVALID_WAV":
    case "CREATOR_AVATAR_AUDIO_TOO_LARGE":
      return { code, kind: "blocked", title: "Audio cannot be used", detail: "The selected audio is not a usable WAV file of this project (or is too large). Nothing was submitted or charged." };
    case "CREATOR_SPEECH_REVIEW_ALREADY_FINAL":
      return { code, kind: "blocked", title: "Speech already reviewed", detail: "This audio already has a final review decision. Reviews cannot be changed; generate new speech to review again." };
    case "CREATOR_SPEECH_REVIEW_NOT_GENERATED_SPEECH":
    case "CREATOR_SPEECH_REVIEW_ASSET_NOT_FOUND":
      return { code, kind: "blocked", title: "Not reviewable speech", detail: "Only speech generated in this project can be reviewed here." };
    case "CREATOR_DERIVATIVE_MASTER_NOT_FINAL":
      return { code, kind: "blocked", title: "Approve the 16:9 master first", detail: "A 9:16 mobile version is made only from a 16:9 master that has passed quality, Tamil and visual review." };
    case "CREATOR_DERIVATIVE_SOURCE_DRIFT":
      return { code, kind: "blocked", title: "The timeline changed after approval", detail: "The visuals or audio no longer match the approved 16:9 master, so a 9:16 version would not match it. Render and approve a new master first." };
    case "CREATOR_DERIVATIVE_REVIEW_ALREADY_FINAL":
      return { code, kind: "blocked", title: "Crop already reviewed", detail: "This 9:16 version already has a final decision. Render a new 9:16 version to review again." };
    case "CREATOR_DERIVATIVE_REVIEW_NOT_FOUND":
      return { code, kind: "blocked", title: "Not a 9:16 version of this project", detail: "Only a 9:16 version rendered from this project's approved master can be crop-reviewed here." };
    case "CREATOR_DERIVATIVE_MASTER_NOT_FOUND":
    case "CREATOR_DERIVATIVE_TIMELINE_MISMATCH":
      return { code, kind: "blocked", title: "Not a 16:9 master of this timeline", detail: "Choose the approved 16:9 final master rendered from this timeline." };
    case "CREATOR_PROVIDER_CANCEL_UNSUPPORTED":
      return { code, kind: "blocked", title: "This provider cannot cancel", detail: "The provider offers no way to stop a render in progress, so cancellation was not attempted. The job may still complete and be charged." };
    case "CREATOR_WORKSPACE_OWNER_REQUIRED":
      return { code, kind: "blocked", title: "Workspace owner required", detail: "Only the workspace owner can do this: submit, retry or cancel paid generations, and record final review decisions or promote a final master." };
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
