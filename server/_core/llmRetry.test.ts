import { describe, expect, it } from "vitest";
import { isRetryableHttpStatus } from "./llm";

describe("LLM HTTP retry classification", () => {
  it.each([408, 429, 500, 502, 503, 504])("retries transient HTTP %s", status => {
    expect(isRetryableHttpStatus(status)).toBe(true);
  });

  it.each([400, 401, 403, 404, 409, 422])("fails fast for non-retryable HTTP %s", status => {
    expect(isRetryableHttpStatus(status)).toBe(false);
  });
});
