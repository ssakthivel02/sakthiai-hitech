import { describe, expect, it } from "vitest";
import { loadGatewayConfig, validateLocalSlotUrl, LOCAL_PROVIDER_ID } from "./config";
import { createProviderGateway } from "./gateway";
import type { GatewayRequest } from "./types";

/**
 * The local slot (LOCAL_LLM_*) is classed self_hosted / local_compute and is therefore exempt from the external-provider policy flags
 * and from the workspace spend budget. These tests pin that a hosted provider cannot be configured into that slot to escape both.
 * Configuration-only: no network is reachable from this file.
 */
const req: GatewayRequest = { requestId: "r1", workspaceId: 1, messages: [{ role: "user", content: "hi" }] };
const local = (url: string, extra: Record<string, string> = {}) => ({ LOCAL_LLM_API_URL: url, LOCAL_LLM_MODEL: "m", ...extra });

describe("local slot cannot front a hosted provider", () => {
  it("a hosted URL in the local slot yields no binding and no eligible provider (previously it was served as local_compute with no policy or budget)", async () => {
    // With the guard in place the config is invalid, so no binding exists and nothing is eligible.
    const config = loadGatewayConfig(local("https://api.sarvam.ai"));
    expect(config.bindings).toHaveLength(0);
    expect(config.invalid[0]).toMatchObject({ providerId: LOCAL_PROVIDER_ID });
    expect(config.invalid[0]!.reason).toMatch(/hosted provider/i);
    let called = 0;
    const gw = createProviderGateway(config, { adapterFactory: () => ({ providerId: "x", complete: async () => { called += 1; throw new Error("must not be called"); } }) as never });
    const out = await gw.invoke(req);
    expect(out.status).not.toBe("returned");
    expect(called).toBe(0);
  });

  it.each([
    "https://api.sarvam.ai", "https://api.sarvam.ai/v1", "https://generativelanguage.googleapis.com/v1beta/openai", "https://api.openai.com/v1",
    "https://api.anthropic.com", "https://openrouter.ai/api", "https://eu.api.mistral.ai", "http://api.groq.com", "https://API.SARVAM.AI.", "https://my-resource.openai.azure.com",
  ])("refuses the known hosted provider %s regardless of scheme or case", (url) => {
    expect(validateLocalSlotUrl(url, {})).toMatch(/hosted provider/i);
    expect(loadGatewayConfig(local(url)).bindings).toHaveLength(0);
  });

  it("the legacy override flag does NOT unlock a known hosted provider, and is not honoured for any public destination", () => {
    expect(validateLocalSlotUrl("https://api.sarvam.ai", { LOCAL_LLM_ALLOW_PUBLIC_HOST: "true" })).toMatch(/hosted provider/i);
    const reason = validateLocalSlotUrl("https://llm.example-vendor.com/v1", { LOCAL_LLM_ALLOW_PUBLIC_HOST: "true" });
    expect(reason).toMatch(/public destination/i);
    expect(reason).toMatch(/no longer honoured/i);
    expect(loadGatewayConfig(local("https://llm.example-vendor.com/v1", { LOCAL_LLM_ALLOW_PUBLIC_HOST: "true" })).bindings).toHaveLength(0);
  });

  // The bypass reproduced on v6 (72752a8): every one of these was bound as self_hosted/local_compute, i.e. exempt from policy and budget.
  const PUBLIC = [
    "http://llm.example-vendor.com/v1", "https://llm.example-vendor.com/v1", "http://8.8.8.8:11434", "https://8.8.8.8", "http://[::ffff:8.8.8.8]:11434",
    "http://[2001:4860:4860::8888]/v1", "http://localhost.example.com/v1", "http://127.0.0.1.nip.io/v1", "http://0.0.0.0:11434", "http://[::]:11434",
    "http://172.32.0.1:11434", "http://100.128.0.1", "http://[64:ff9b::7f00:1]", "http://[::127.0.0.1]", "http://LLM.Example-Vendor.com.", "http://internal.example.com",
  ];
  it.each(PUBLIC)("a public destination %s gets no local privileges, with or without any override", (url) => {
    for (const extra of [{}, { LOCAL_LLM_ALLOW_PUBLIC_HOST: "true" }, { LOCAL_LLM_ALLOWED_HOSTS: "llm.example-vendor.com,8.8.8.8,0.0.0.0,172.32.0.1,100.128.0.1,internal.example.com" }]) {
      const c = loadGatewayConfig(local(url, extra));
      expect(c.bindings, JSON.stringify(extra)).toHaveLength(0);
      expect(c.invalid[0]).toMatchObject({ providerId: LOCAL_PROVIDER_ID });
    }
  });

  it("URL tricks resolve to the real host: userinfo is refused outright, and a decoy after a backslash, # or ? cannot make a public host look local", () => {
    for (const url of ["http://127.0.0.1@evil.example.com/", "http://127.0.0.1:80@8.8.8.8/", "http://localhost:x@evil.example.com/"]) expect(loadGatewayConfig(local(url)).bindings, url).toHaveLength(0);
    for (const url of ["http://evil.example.com\\@127.0.0.1/", "http://evil.example.com#@127.0.0.1/", "http://evil.example.com?@127.0.0.1/"]) expect(loadGatewayConfig(local(url)).bindings, url).toHaveLength(0);
  });

  it("the override cannot turn a public destination into an unmetered local provider: no binding, the adapter is never reached, and the same URL as the EXTERNAL provider is still denied by policy", async () => {
    const env = { LOCAL_LLM_API_URL: "https://llm.example-vendor.com/v1", LOCAL_LLM_MODEL: "m", LOCAL_LLM_ALLOW_PUBLIC_HOST: "true", LOCAL_LLM_ALLOWED_HOSTS: "llm.example-vendor.com" };
    const config = loadGatewayConfig(env);
    expect(config.bindings).toHaveLength(0);
    let called = 0;
    const factory = () => ({ providerId: "x", complete: async () => { called += 1; throw new Error("must not be called"); } }) as never;
    expect((await createProviderGateway(config, { adapterFactory: factory }).invoke(req)).status).not.toBe("returned");
    const ext = loadGatewayConfig({ LLM_API_URL: "https://llm.example-vendor.com/v1", LLM_MODEL: "m", LLM_API_KEY: "k" });
    expect((await createProviderGateway(ext, { adapterFactory: factory }).invoke(req)).status).not.toBe("returned");
    expect(called).toBe(0);
  });

  it.each([
    "http://127.0.0.1:11434", "http://127.0.0.1:11434/v1", "http://localhost:11434", "http://localhost:11434/v1", "http://LOCALHOST.:11434", "http://[::1]:8000",
    "http://127.5.5.5:8000", "https://localhost:8443", "http://0x7f.1:11434", "http://2130706433:11434", "http://[::ffff:127.0.0.1]:11434", "http://local.rt.invalid",
  ])("still accepts loopback inference (Ollama and friends) with no configuration: %s", (url) => {
    expect(validateLocalSlotUrl(url, {})).toBeNull();
    const c = loadGatewayConfig(local(url));
    expect(c.bindings).toHaveLength(1);
    expect(c.bindings[0]).toMatchObject({ kind: "self_hosted", billingMode: "local_compute" });
  });

  const PRIVATE = [
    "http://10.1.2.3:8000", "http://192.168.1.20:11434", "http://172.20.0.5:8000", "http://100.64.0.9:11434", "http://[fd00::5]:8000",
    "http://ollama:11434", "http://ollama.internal:11434", "https://llm.corp.lan", "http://gpu-box.local:8000", "https://llm.svc.cluster.local", "http://a.localhost:8000",
  ];
  it.each(PRIVATE)("private-network target %s is refused until the exact host is listed in LOCAL_LLM_ALLOWED_HOSTS", (url) => {
    expect(validateLocalSlotUrl(url, {})).toMatch(/not approved/i);
    expect(loadGatewayConfig(local(url)).bindings).toHaveLength(0);
    expect(loadGatewayConfig(local(url, { LOCAL_LLM_ALLOWED_HOSTS: "somewhere-else.internal, 10.99.99.99" })).bindings).toHaveLength(0);
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
    const c = loadGatewayConfig(local(url, { LOCAL_LLM_ALLOWED_HOSTS: ` x.lan , ${hostname.toUpperCase()}. ` }));
    expect(c.bindings, url).toHaveLength(1);
    expect(c.bindings[0]).toMatchObject({ kind: "self_hosted", billingMode: "local_compute" });
  });

  const BLOCKED = [
    "http://169.254.169.254/v1", "http://169.254.10.10:8000", "http://[fe80::1]:8000", "http://[::ffff:169.254.169.254]/", "http://[::ffff:a9fe:a9fe]/", "http://[64:ff9b::a9fe:a9fe]/",
    "http://[fd00:ec2::254]/", "http://100.100.100.200/", "http://metadata.google.internal/", "http://metadata/", "http://instance-data/", "https://x.metadata.goog/",
    "http://2852039166/", "http://0xa9fea9fe/",
  ];
  it.each(BLOCKED)("link-local / cloud-metadata target %s is refused even when the exact host IS listed in the allowlist (no override exists)", (url) => {
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
    for (const allow of [undefined, hostname, `${hostname}, ${new URL(url).host}`]) {
      const env = allow === undefined ? {} : { LOCAL_LLM_ALLOWED_HOSTS: allow };
      expect(validateLocalSlotUrl(url, env), `${url} / ${allow}`).toMatch(/link-local or cloud-metadata/i);
      const c = loadGatewayConfig(local(url, env));
      expect(c.bindings, url).toHaveLength(0);
      expect(c.invalid).toHaveLength(1);
      expect(JSON.stringify(c.invalid).replace("link-local or cloud-metadata", "")).not.toContain(hostname); // the reason never echoes the configured host (the fixed wording is excluded)
    }
  });

  it("wildcards, CIDR ranges and port-suffixed entries in the allowlist approve nothing", () => {
    expect(loadGatewayConfig(local("http://box.lan:8000", { LOCAL_LLM_ALLOWED_HOSTS: "*.lan" })).bindings).toHaveLength(0);
    expect(loadGatewayConfig(local("http://box.lan:8000", { LOCAL_LLM_ALLOWED_HOSTS: "box.lan:8000" })).bindings).toHaveLength(0);
    expect(loadGatewayConfig(local("http://10.0.0.5:8000", { LOCAL_LLM_ALLOWED_HOSTS: "10.0.0.0/8" })).bindings).toHaveLength(0);
  });

  it("refusal reasons never contain the configured host (the owner-visible runtime status must not leak internal names)", () => {
    for (const url of ["http://secret-gpu.corp.lan:8000", "http://llm.example-vendor.com", "http://10.20.30.40"]) {
      expect(JSON.stringify(loadGatewayConfig(local(url)).invalid)).not.toMatch(/secret-gpu|example-vendor|10\.20\.30/);
    }
  });

  it("a name gets a request-time resolution guard; IP literals, localhost and .invalid do not need one", () => {
    expect(loadGatewayConfig(local("http://ollama:11434", { LOCAL_LLM_ALLOWED_HOSTS: "ollama" })).bindings[0]!.resolveGuard).toBe(true);
    expect(loadGatewayConfig(local("http://10.0.0.5:11434", { LOCAL_LLM_ALLOWED_HOSTS: "10.0.0.5" })).bindings[0]!.resolveGuard).toBeUndefined();
    expect(loadGatewayConfig(local("http://localhost:11434")).bindings[0]!.resolveGuard).toBeUndefined();
    expect(loadGatewayConfig(local("http://local.rt.invalid")).bindings[0]!.resolveGuard).toBeUndefined();
  });

  it("does not affect the external binding, which keeps its own policy path", () => {
    const c = loadGatewayConfig({ LLM_API_URL: "https://api.openai.com/v1", LLM_MODEL: "x", LLM_API_KEY: "k" });
    expect(c.bindings.map((b) => b.kind)).toEqual(["external"]);
  });
});
