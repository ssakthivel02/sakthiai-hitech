import { describe, expect, it } from "vitest";
import { backoffFor, failureFromGateway } from "./worker";
import { TaskFatalError, TaskRetryableError } from "./types";

const failed = (reason: string) => failureFromGateway({ status: "failed", reason: reason as never, attempts: [], latencyMs: 1 });

describe("task retry classification", () => {
  it("budget and policy refusals and caller faults are fatal (a retry could never succeed and must not hammer the gateway)", () => {
    for (const [reason, cls] of [["budget_denied", "BUDGET_DENIED"], ["policy_denied", "POLICY_DENIED"], ["auth_failed", "NON_RETRYABLE"], ["bad_request", "NON_RETRYABLE"]] as const) {
      const error = failed(reason);
      expect(error).toBeInstanceOf(TaskFatalError);
      expect((error as TaskFatalError).failureClass).toBe(cls);
    }
  });
  it("outages and exhausted candidates are retryable PROVIDER_UNAVAILABLE", () => {
    for (const reason of ["timeout", "network", "rate_limited", "server_error", "no_eligible_provider", "all_candidates_skipped", "internal_error", "malformed_response"]) {
      const error = failed(reason);
      expect(error).toBeInstanceOf(TaskRetryableError);
      expect((error as TaskRetryableError).failureClass).toBe("PROVIDER_UNAVAILABLE");
    }
  });
  it("backoff doubles per attempt and is capped", () => {
    expect([1, 2, 3, 4].map(a => backoffFor(a, 100, 10_000))).toEqual([100, 200, 400, 800]);
    expect(backoffFor(20, 100, 1000)).toBe(1000);
    expect(backoffFor(0, 100, 1000)).toBe(100);
  });
  it("error messages never embed provider response bodies (only the provider-neutral reason)", () => {
    expect(failed("server_error").message).toBe("model provider unavailable (server_error)");
  });
});
