import { describe, expect, it } from "vitest";
import { describeApiError, describeModelFailure, describeNoEvidence, ERROR_UI_TEXT } from "@shared/userFacingError";

/** Defect D3: chat/project/upload failures were invisible. The mapper is pure, bilingual and never echoes raw server text. */
const trpc = (code: string, message: string, httpStatus?: number) => ({ message, data: { code, httpStatus } });
const SECRET_LIKE = "mysql://user:s3cr3t@db.internal:3306/app; stack at /srv/app/server.ts:42; Bearer sk-live-abc";

describe("describeApiError", () => {
  it("rate limit: names the wait time", () => {
    const e = describeApiError(trpc("TOO_MANY_REQUESTS", "Rate limit exceeded. Retry in 17 seconds.", 429));
    expect(e).toMatchObject({ kind: "rate_limit", retryable: true, retryAfterSeconds: 17 });
    expect(e.message).toContain("17 seconds");
  });
  it("rate limit without a number still works, and the wait is capped", () => {
    expect(describeApiError(trpc("TOO_MANY_REQUESTS", "x", 429)).retryAfterSeconds).toBeUndefined();
    expect(describeApiError(trpc("TOO_MANY_REQUESTS", "Rate limit exceeded. Retry in 99999 seconds.")).retryAfterSeconds).toBeLessThanOrEqual(3600);
  });
  it("shared limiter unavailable (fail-closed costly route) is distinct and retryable", () => {
    const e = describeApiError(trpc("SERVICE_UNAVAILABLE", "Request limits are temporarily unavailable. Retry in 5 seconds.", 503));
    expect(e).toMatchObject({ kind: "limits_unavailable", retryable: true, retryAfterSeconds: 5 });
    expect(e.message).toMatch(/was not run/);
  });
  it("database / server failure is retryable and never leaks internals", () => {
    const e = describeApiError(trpc("INTERNAL_SERVER_ERROR", `Database unavailable ${SECRET_LIKE}`, 500));
    expect(e).toMatchObject({ kind: "unavailable", retryable: true });
    expect(e.message).not.toMatch(/mysql|s3cr3t|Bearer|server\.ts|Database unavailable/);
  });
  it("session, denied, uploads-off and invalid input are mapped and not retryable", () => {
    expect(describeApiError(trpc("UNAUTHORIZED", "Please login (10001)", 401))).toMatchObject({ kind: "session", retryable: false });
    expect(describeApiError(trpc("FORBIDDEN", "Workspace access denied", 403))).toMatchObject({ kind: "denied", retryable: false });
    expect(describeApiError(trpc("FORBIDDEN", "File uploads are not enabled in this beta", 403))).toMatchObject({ kind: "uploads_off", retryable: false });
    expect(describeApiError(trpc("BAD_REQUEST", "zod issue list", 400))).toMatchObject({ kind: "invalid", retryable: false });
    expect(describeApiError(trpc("CONFLICT", "Duplicate document already exists", 409))).toMatchObject({ kind: "invalid" });
  });
  it("network failure is reported as offline and retryable", () => {
    expect(describeApiError(new TypeError("Failed to fetch"))).toMatchObject({ kind: "offline", retryable: true });
  });
  it("anything unrecognised becomes a fixed generic message, never the raw text", () => {
    for (const input of [new Error(SECRET_LIKE), SECRET_LIKE, null, undefined, 42, {}]) {
      const e = describeApiError(input);
      expect(e.kind).toBe("unknown");
      expect(e.message).not.toContain("s3cr3t");
      expect(e.message).not.toContain("mysql");
    }
  });
  it("Tamil text is returned for language=ta and is non-empty for every kind", () => {
    const samples = [trpc("TOO_MANY_REQUESTS", "x", 429), trpc("UNAUTHORIZED", "x", 401), trpc("FORBIDDEN", "x", 403), trpc("BAD_REQUEST", "x", 400), trpc("INTERNAL_SERVER_ERROR", "x", 500), new TypeError("Failed to fetch"), {}];
    for (const sample of samples) {
      const ta = describeApiError(sample, "ta").message; const en = describeApiError(sample, "en").message;
      expect(ta).toMatch(/[஀-௿]/); expect(ta).not.toBe(en);
    }
  });
});

describe("describeModelFailure", () => {
  it("budget and policy denials are not retryable; every other reason is a retryable model outage", () => {
    expect(describeModelFailure("budget_denied")).toMatchObject({ kind: "budget", retryable: false });
    expect(describeModelFailure("policy_denied")).toMatchObject({ kind: "budget", retryable: false });
    for (const reason of ["no_eligible_provider", "all_candidates_skipped", "internal_error", "timeout", undefined]) {
      expect(describeModelFailure(reason)).toMatchObject({ kind: "model_unavailable", retryable: true });
    }
  });
  it("never echoes the reason string itself", () => {
    expect(describeModelFailure("upstream said sk-live-abc").message).not.toContain("sk-live");
  });
});

describe("describeNoEvidence", () => {
  it("separates 'no matching source, no model used' from 'model said insufficient'", () => {
    expect(describeNoEvidence(false)).toMatch(/no model was used/);
    expect(describeNoEvidence(true)).toMatch(/do not contain enough information/);
    expect(describeNoEvidence(false, "ta")).toMatch(/[஀-௿]/);
  });
});

describe("ERROR_UI_TEXT", () => {
  it("has English and Tamil controls", () => {
    for (const lang of ["en", "ta"] as const) for (const key of ["title", "retry", "dismiss", "projectAdded"] as const) expect(ERROR_UI_TEXT[lang][key].length).toBeGreaterThan(0);
  });
});
