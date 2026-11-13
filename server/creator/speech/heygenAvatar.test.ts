import { describe, expect, it, vi } from "vitest";
import { buildAvatarGeneratePayload, downloadAvatarVideo, HEYGEN_ENDPOINTS, mapAvatarStatus, runAvatarVideo } from "./heygenAvatar";
import { makePcmWav } from "./wav";

const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypmp42"), Buffer.alloc(32)]);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function scriptedFetch(statuses: string[]) {
  let poll = 0;
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === HEYGEN_ENDPOINTS.upload) return json({ code: 100, data: { id: "asset_abc123" } });
    if (url === HEYGEN_ENDPOINTS.generate) return json({ code: 100, data: { video_id: "vid_abc123" } });
    if (url.startsWith(HEYGEN_ENDPOINTS.status)) {
      const status = statuses[Math.min(poll++, statuses.length - 1)];
      return json({ code: 100, data: { status, video_url: status === "completed" ? "https://resource.heygen.ai/v.mp4" : null, duration: 3.2 } });
    }
    if (url.startsWith("https://resource.heygen.ai/")) return new Response(new Uint8Array(mp4), { status: 200 });
    throw new Error(`unexpected url ${url} ${init?.method}`);
  });
}

const base = { audio: makePcmWav(800), audioContentType: "audio/wav" as const, avatarId: "avatar_consented_01", callbackId: "creator-idem-0001" };

describe("HeyGen avatar adapter (contract-tested; no live call)", () => {
  it("defaults to provider test mode and only goes live when asked", () => {
    const common = { avatarId: "avatar_consented_01", audioAssetId: "asset_abc123", callbackId: "creator-idem-0001" };
    expect(buildAvatarGeneratePayload(common).test).toBe(true);
    expect(buildAvatarGeneratePayload({ ...common, live: true }).test).toBe(false);
    expect(buildAvatarGeneratePayload(common).video_inputs[0].voice).toEqual({ type: "audio", audio_asset_id: "asset_abc123" });
    expect(() => buildAvatarGeneratePayload({ ...common, avatarId: "bad id!" })).toThrow("AVATAR_ID_INVALID");
    expect(() => buildAvatarGeneratePayload({ ...common, width: 100 })).toThrow("AVATAR_DIMENSION_INVALID");
  });

  it("runs upload -> submit -> poll -> download, persisting the provider job id before polling", async () => {
    const fetchMock = scriptedFetch(["pending", "processing", "completed"]);
    const order: string[] = [];
    const result = await runAvatarVideo(base, { onProviderJob: job => { order.push(`job:${job.videoId}:${job.testMode}`); } }, { fetch: fetchMock, apiKey: "k", sleep: async () => { order.push("sleep"); }, pollIntervalMs: 1 });
    expect(result).toMatchObject({ state: "SUCCEEDED", videoId: "vid_abc123", testMode: true, durationSeconds: 3.2 });
    expect(order[0]).toBe("job:vid_abc123:true"); // before any poll-sleep
    expect(order.filter(entry => entry === "sleep")).toHaveLength(2);
    const submitBody = JSON.parse(fetchMock.mock.calls.find(call => call[0] === HEYGEN_ENDPOINTS.generate)![1]!.body as string);
    expect(submitBody.callback_id).toBe("creator-idem-0001");
    expect((fetchMock.mock.calls[0][1]!.headers as Record<string, string>)["x-api-key"]).toBe("k");
  });

  it("reports local cancellation honestly: polling stops, provider cancel is not claimed", async () => {
    const controller = new AbortController();
    const fetchMock = scriptedFetch(["processing"]);
    const result = await runAvatarVideo(base, { signal: controller.signal }, {
      fetch: fetchMock, apiKey: "k", pollIntervalMs: 1,
      sleep: async () => { controller.abort(); throw Object.assign(new Error("aborted"), { name: "AbortError" }); },
    });
    expect(result).toMatchObject({ state: "CANCELLED_LOCAL", videoId: "vid_abc123", providerCancelSupported: false });
  });

  it("fails on a provider render failure and on an exceeded wait budget (retryable)", async () => {
    await expect(runAvatarVideo(base, {}, { fetch: scriptedFetch(["failed"]), apiKey: "k", sleep: async () => undefined })).rejects.toMatchObject({ code: "AVATAR_PROVIDER_RENDER_FAILED" });
    await expect(runAvatarVideo(base, {}, { fetch: scriptedFetch(["processing"]), apiKey: "k", sleep: async () => undefined, maxWaitMs: -1 })).rejects.toMatchObject({ code: "AVATAR_RENDER_WAIT_EXCEEDED", retryable: true });
  });

  it("refuses an unrecognized provider status rather than guessing", () => {
    expect(() => mapAvatarStatus({ data: { status: "teleporting" } })).toThrow("AVATAR_STATUS_UNRECOGNIZED");
    expect(mapAvatarStatus({ data: { status: "completed", video_url: null } })).toMatchObject({ state: "FAILED", errorMessage: "AVATAR_OUTPUT_URL_MISSING" });
  });

  it("only downloads https MP4s from allowlisted hosts and never follows redirects", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array(mp4), { status: 200 }));
    await expect(downloadAvatarVideo("http://resource.heygen.ai/v.mp4", {}, { fetch: fetchMock })).rejects.toMatchObject({ code: "AVATAR_DOWNLOAD_HOST_NOT_ALLOWED" });
    await expect(downloadAvatarVideo("https://evil.example/v.mp4", {}, { fetch: fetchMock })).rejects.toMatchObject({ code: "AVATAR_DOWNLOAD_HOST_NOT_ALLOWED" });
    await expect(downloadAvatarVideo("https://resource.heygen.ai.evil.example/v.mp4", {}, { fetch: fetchMock })).rejects.toMatchObject({ code: "AVATAR_DOWNLOAD_HOST_NOT_ALLOWED" });
    expect(fetchMock).not.toHaveBeenCalled();
    const good = await downloadAvatarVideo("https://resource.heygen.ai/v.mp4", {}, { fetch: fetchMock });
    expect(good.mimeType).toBe("video/mp4");
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe("error");
    const html = vi.fn(async () => new Response("<html>login</html>-padding-padding", { status: 200 }));
    await expect(downloadAvatarVideo("https://resource.heygen.ai/v.mp4", {}, { fetch: html })).rejects.toMatchObject({ code: "AVATAR_DOWNLOAD_NOT_MP4" });
  });

  it("streams an MP4 with unknown length without using Response.arrayBuffer", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(mp4.subarray(0, 6)));
        controller.enqueue(new Uint8Array(mp4.subarray(6)));
        controller.close();
      },
    });
    const response = new Response(body, { status: 200 });
    const arraySpy = vi.spyOn(response, "arrayBuffer");
    const fetchMock = vi.fn(async () => response);
    const output = await downloadAvatarVideo("https://resource.heygen.ai/v.mp4", {}, { fetch: fetchMock });
    expect(output.data.equals(mp4)).toBe(true);
    expect(arraySpy).not.toHaveBeenCalled();
  });

  it("rejects a declared oversized video and cancels without buffering", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      status: 200,
      headers: { "Content-Length": String(512 * 1024 * 1024 + 1) },
    });
    const fetchMock = vi.fn(async () => response);
    await expect(downloadAvatarVideo("https://resource.heygen.ai/v.mp4", {}, { fetch: fetchMock }))
      .rejects.toMatchObject({ code: "AVATAR_DOWNLOAD_TOO_LARGE" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown-length oversized chunks before allocation", async () => {
    const oversized = new Uint8Array([1, 2, 3]);
    Object.defineProperty(oversized, "byteLength", { get: () => 512 * 1024 * 1024 + 1 });
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(oversized); },
      cancel,
    }));
    await expect(downloadAvatarVideo("https://resource.heygen.ai/v.mp4", {}, {
      fetch: vi.fn(async () => response),
    })).rejects.toMatchObject({ code: "AVATAR_DOWNLOAD_TOO_LARGE" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("refuses bogus Content-Length and cancels error bodies", async () => {
    const oversized = new Response(new ReadableStream<Uint8Array>({ cancel: vi.fn() }), {
      headers: { "Content-Length": "NaN" },
    });
    await expect(downloadAvatarVideo("https://resource.heygen.ai/v.mp4", {}, {
      fetch: vi.fn(async () => oversized),
    })).rejects.toMatchObject({ code: "AVATAR_DOWNLOAD_LENGTH_INVALID" });
    const cancel = vi.fn();
    const denied = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 503 });
    const arraySpy = vi.spyOn(denied, "arrayBuffer");
    await expect(downloadAvatarVideo("https://resource.heygen.ai/v.mp4", {}, {
      fetch: vi.fn(async () => denied),
    })).rejects.toMatchObject({ code: "AVATAR_PROVIDER_HTTP_503" });
    expect(arraySpy).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("fails closed without a dedicated key and classifies provider HTTP errors", async () => {
    const prior = process.env.CREATOR_AVATAR_HEYGEN_API_KEY;
    delete process.env.CREATOR_AVATAR_HEYGEN_API_KEY;
    try {
      await expect(runAvatarVideo(base, {}, { fetch: vi.fn() as never })).rejects.toMatchObject({ code: "AVATAR_PROVIDER_NOT_CONFIGURED" });
    } finally {
      if (prior !== undefined) process.env.CREATOR_AVATAR_HEYGEN_API_KEY = prior;
    }
    const denied = vi.fn(async () => new Response("no", { status: 403 }));
    await expect(runAvatarVideo(base, {}, { fetch: denied, apiKey: "k" })).rejects.toMatchObject({ failureClass: "AUTH", retryable: false });
  });
});
