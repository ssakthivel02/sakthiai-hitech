import { afterEach, describe, expect, it, vi } from "vitest";
import { googleImageProvider } from "./googleImage";
import { pollGoogleVeo, submitGoogleVeo } from "./googleVeo";

/**
 * The Google Creator adapters authenticate with the x-goog-api-key header. Unlike Authorization, fetch does NOT drop a custom header on a
 * cross-origin redirect (reproduced on 0a48dc3 with Node 22: the redirect target received the key). Every keyed call must therefore refuse
 * redirects. These tests assert the request option; they make no network call and spend nothing.
 */
const image = { mimeType: "image/png" as const, dataBase64: Buffer.from("creator-test-image").toString("base64") };

describe("Creator provider calls never follow redirects", () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); seen.length = 0; });
  const stub = (body: unknown) => {
    vi.stubEnv("GEMINI_API_KEY", "TEST-KEY-NOT-REAL");
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => { seen.push({ url: String(url), init }); return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }); }));
  };

  it("Veo submit and poll", async () => {
    stub({ name: "models/veo-3.1-fast-generate-preview/operations/abc123" });
    await submitGoogleVeo({ prompt: "test", firstFrame: image, lastFrame: image, resolution: "720p", durationSeconds: 8 } as any);
    await pollGoogleVeo("models/veo-3.1-fast-generate-preview/operations/abc123");
    expect(seen).toHaveLength(2);
    for (const call of seen) {
      expect(call.init?.redirect).toBe("error");
      expect((call.init?.headers as Record<string, string>)["x-goog-api-key"]).toBe("TEST-KEY-NOT-REAL");
    }
  });

  it("Gemini image submit and poll", async () => {
    stub({ id: "interaction-1", status: "in_progress" });
    await googleImageProvider.submit({ kind: "IMAGE", prompt: "test", aspectRatio: "16:9" } as any);
    await googleImageProvider.poll("interaction-1");
    expect(seen).toHaveLength(2);
    for (const call of seen) expect(call.init?.redirect).toBe("error");
  });
});
