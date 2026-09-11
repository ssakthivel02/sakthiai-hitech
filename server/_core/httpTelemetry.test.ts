import { describe, expect, it } from "vitest";
import {
  buildHttpRequestLog,
  classifyRequestPath,
  sanitizeRequestId,
} from "./httpTelemetry";

describe("sanitizeRequestId", () => {
  it("uses the fallback for an empty incoming value", () => {
    expect(sanitizeRequestId("   ", "fallback-id")).toBe("fallback-id");
  });

  it("removes control characters and bounds caller-supplied identifiers", () => {
    const value = `abc\n\r${"x".repeat(200)}`;
    const safe = sanitizeRequestId(value, "fallback-id");
    expect(safe).not.toContain("\n");
    expect(safe).not.toContain("\r");
    expect(safe.length).toBeLessThanOrEqual(128);
  });
});

describe("classifyRequestPath", () => {
  it("keeps operational endpoints exact", () => {
    expect(classifyRequestPath("/healthz")).toBe("/healthz");
    expect(classifyRequestPath("/readyz")).toBe("/readyz");
    expect(classifyRequestPath("/releasez")).toBe("/releasez");
  });

  it("coarsens API, OAuth, storage, asset, and application paths", () => {
    expect(classifyRequestPath("/api/trpc/chat.send")).toBe("/api/trpc");
    expect(classifyRequestPath("/oauth/callback/provider-user-123")).toBe("/oauth/*");
    expect(classifyRequestPath("/storage/private-user@example.com/file.pdf")).toBe("/storage/*");
    expect(classifyRequestPath("/api/private/resource-123")).toBe("/api/*");
    expect(classifyRequestPath("/assets/hash-123.js")).toBe("/assets/*");
    expect(classifyRequestPath("/projects/private-project-123")).toBe("/app");
  });
});

describe("buildHttpRequestLog", () => {
  it("emits only the approved low-cardinality observability fields", () => {
    const log = buildHttpRequestLog({
      requestId: "request-123",
      method: "post",
      path: "/projects/customer@example.com/private-document-456",
      status: 200,
      latencyMs: 12.6,
    });

    expect(log).toEqual({
      event: "http_request",
      requestId: "request-123",
      method: "POST",
      routeClass: "/app",
      status: 200,
      latencyMs: 13,
    });
    expect(JSON.stringify(log)).not.toContain("customer@example.com");
    expect(JSON.stringify(log)).not.toContain("private-document-456");
    expect(Object.keys(log).sort()).toEqual(
      ["event", "latencyMs", "method", "requestId", "routeClass", "status"].sort(),
    );
  });
});
