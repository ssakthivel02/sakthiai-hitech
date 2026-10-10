import { describe, expect, it } from "vitest";
import { loadGatewayConfig } from "./config";
import { createProviderGateway } from "./gateway";

// /readyz must not report the model gateway as usable merely because LLM_API_URL/LLM_MODEL strings exist.
// readiness() is static: it must agree with what invoke() would do, without ever calling a provider.
const external = { LLM_API_URL: "https://llm.example.invalid/v1", LLM_MODEL: "m", LLM_API_KEY: "k", GATEWAY_BUDGET_STORE: "memory", GATEWAY_STATE_STORE: "memory" };
const local = { LOCAL_LLM_API_URL: "http://127.0.0.1:9/v1", LOCAL_LLM_MODEL: "local-model", GATEWAY_BUDGET_STORE: "memory", GATEWAY_STATE_STORE: "memory" };

function gatewayFor(env: Record<string, string>) {
  const calls = { n: 0 };
  const gateway = createProviderGateway(loadGatewayConfig(env), {
    adapterFactory: () => ({ complete: async () => { calls.n++; return { text: "ok", usage: { promptTokens: 1, completionTokens: 1 } }; } }) as never,
    log: () => {},
  });
  return { gateway, calls };
}

describe("model gateway readiness (static, zero-spend)", () => {
  const cases: Array<[string, Record<string, string>, string]> = [
    ["nothing configured", {}, "no_provider_configured"],
    ["render.yaml variables only (external, metered by default)", external, "not_permitted_by_policy"],
    ["external allowed, metered not allowed", { ...external, GATEWAY_ALLOW_EXTERNAL: "true" }, "not_permitted_by_policy"],
    ["metered allowed without any budget limit", { ...external, GATEWAY_ALLOW_EXTERNAL: "true", GATEWAY_ALLOW_METERED: "true" }, "default_budget_denies_metered"],
    ["metered allowed with a daily request cap", { ...external, GATEWAY_ALLOW_EXTERNAL: "true", GATEWAY_ALLOW_METERED: "true", GATEWAY_EXTERNAL_MAX_REQUESTS_PER_DAY: "50" }, "eligible"],
    ["subscription billing, external allowed", { ...external, LLM_BILLING_MODE: "subscription", GATEWAY_ALLOW_EXTERNAL: "true" }, "eligible"],
    ["local/self-hosted provider", local, "eligible"],
  ];

  it.each(cases)("%s -> %s, and invoke() agrees", async (_name, env, expected) => {
    const { gateway, calls } = gatewayFor(env);
    const r = gateway.readiness();
    expect(r.state).toBe(expected);
    expect(r.operational).toBe("unverified");
    expect(calls.n).toBe(0); // readiness never calls a provider
    const outcome = await gateway.invoke({ workspaceId: 1, messages: [{ role: "user", content: "hi" }], maxOutputTokens: 8 } as never);
    expect(outcome.status === "returned", `invoke for ${expected}`).toBe(expected === "eligible");
  });

  it("reports operational=verified only after a provider has actually answered", async () => {
    const { gateway } = gatewayFor(local);
    expect(gateway.readiness().operational).toBe("unverified");
    await gateway.invoke({ workspaceId: 1, messages: [{ role: "user", content: "hi" }], maxOutputTokens: 8 } as never);
    expect(gateway.readiness()).toMatchObject({ state: "eligible", operational: "verified" });
  });

  it("does not count a metered provider whose budget store is unavailable", () => {
    // budget store "mysql" without an injected store mirrors invoke()'s budget_store_unavailable
    const { gateway } = gatewayFor({ ...external, GATEWAY_ALLOW_EXTERNAL: "true", GATEWAY_ALLOW_METERED: "true", GATEWAY_EXTERNAL_MAX_REQUESTS_PER_DAY: "50", GATEWAY_BUDGET_STORE: "mysql" });
    expect(gateway.readiness().state).toBe("default_budget_denies_metered");
  });
});
