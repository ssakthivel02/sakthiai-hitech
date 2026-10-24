import { describe, expect, it } from "vitest";
import { createEmbeddingGateway, loadEmbeddingConfig, LOCAL_EMBEDDING_ID } from "./gateway";

/**
 * The embedding gateway has its own local slot (LOCAL_EMBEDDING_*), exempt from EMBEDDING_ALLOW_EXTERNAL and sent document text. It must obey the same
 * rules as the chat local slot: loopback by default, private-network only by explicit allowlist, never public, never redirected.
 */
const env = (url: string, extra: Record<string, string> = {}) => ({ LOCAL_EMBEDDING_API_URL: url, LOCAL_EMBEDDING_MODEL: "bge-m3", ...extra });
const OK = () => new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200, headers: { "content-type": "application/json" } });

describe("embedding local slot", () => {
  it.each([
    "http://embed.example-vendor.com", "https://embed.example-vendor.com/v1", "http://8.8.8.8:11434", "http://[::ffff:8.8.8.8]", "http://localhost.example.com", "http://0.0.0.0:11434",
    "https://api.openai.com/v1", "https://generativelanguage.googleapis.com/v1beta/openai", "http://127.0.0.1.nip.io",
  ])("public or hosted destination %s gets no local privileges, with or without overrides", (url) => {
    for (const extra of [{}, { LOCAL_LLM_ALLOW_PUBLIC_HOST: "true" }, { LOCAL_EMBEDDING_ALLOWED_HOSTS: "embed.example-vendor.com,8.8.8.8,0.0.0.0" }]) {
      const c = loadEmbeddingConfig(env(url, extra));
      expect(c.providers.filter((p) => p.kind === "self_hosted"), JSON.stringify(extra)).toHaveLength(0);
      expect(c.invalid[0]).toMatchObject({ providerId: LOCAL_EMBEDDING_ID });
    }
  });

  it.each(["http://127.0.0.1:11434", "http://localhost:11434/v1", "http://[::1]:8000", "http://local.embed.invalid"])("loopback needs no configuration: %s", (url) => {
    expect(loadEmbeddingConfig(env(url)).providers.map((p) => p.providerId)).toEqual([LOCAL_EMBEDDING_ID]);
  });

  it("a private-network host is refused until it is listed in LOCAL_EMBEDDING_ALLOWED_HOSTS (the chat allowlist does not approve it)", () => {
    for (const url of ["http://10.0.0.7:8000", "http://gpu-box.lan:8000", "http://ollama:11434"]) {
      const host = new URL(url).hostname;
      expect(loadEmbeddingConfig(env(url)).providers).toHaveLength(0);
      expect(loadEmbeddingConfig(env(url)).invalid[0]!.reason).toMatch(/LOCAL_EMBEDDING_ALLOWED_HOSTS/);
      expect(loadEmbeddingConfig(env(url, { LOCAL_LLM_ALLOWED_HOSTS: host })).providers).toHaveLength(0);
      expect(loadEmbeddingConfig(env(url, { LOCAL_EMBEDDING_ALLOWED_HOSTS: host })).providers).toHaveLength(1);
    }
  });

  it("the external embedding provider is unaffected and still needs EMBEDDING_ALLOW_EXTERNAL", () => {
    const c = loadEmbeddingConfig({ EMBEDDING_API_URL: "https://external.embed.invalid", EMBEDDING_MODEL: "m" });
    expect(c.providers.map((p) => p.kind)).toEqual(["external"]);
    expect(c.allowExternal).toBe(false);
  });

  it("redirects are refused for the local provider", async () => {
    let init: RequestInit | undefined;
    const gw = createEmbeddingGateway(loadEmbeddingConfig(env("http://127.0.0.1:11434")), { fetchImpl: (async (_u: unknown, i?: RequestInit) => { init = i; return OK(); }) as typeof fetch, sleep: async () => undefined });
    expect((await gw.embed("hello")).status).toBe("ok");
    expect(init?.redirect).toBe("error");
  });

  it("redirects are refused for the external provider too (document text is never re-sent elsewhere)", async () => {
    let init: RequestInit | undefined;
    const cfg = loadEmbeddingConfig({ EMBEDDING_API_URL: "https://external.embed.invalid", EMBEDDING_MODEL: "m", EMBEDDING_ALLOW_EXTERNAL: "true" });
    const gw = createEmbeddingGateway(cfg, { fetchImpl: (async (_u: unknown, i?: RequestInit) => { init = i; return OK(); }) as typeof fetch, sleep: async () => undefined });
    expect((await gw.embed("hello")).status).toBe("ok");
    expect(init?.redirect).toBe("error");
  });

  it("a name that does not resolve to loopback/private addresses is refused before any request, with no retry", async () => {
    let fetches = 0; let asked = 0;
    const cfg = loadEmbeddingConfig(env("http://gpu-box.lan:8000", { LOCAL_EMBEDDING_ALLOWED_HOSTS: "gpu-box.lan" }));
    expect(cfg.providers[0]!.resolveGuard).toBe(true);
    const refusing = createEmbeddingGateway(cfg, { fetchImpl: (async () => { fetches += 1; return OK(); }) as typeof fetch, hostGuard: async () => { asked += 1; return false; }, sleep: async () => undefined });
    const out = await refusing.embed("document text");
    expect(out.status).toBe("failed");
    expect(fetches).toBe(0);
    expect(asked).toBe(1);
    const approving = createEmbeddingGateway(cfg, { fetchImpl: (async () => { fetches += 1; return OK(); }) as typeof fetch, hostGuard: async () => true, sleep: async () => undefined });
    expect((await approving.embed("document text")).status).toBe("ok");
    expect(fetches).toBe(1);
  });
});
