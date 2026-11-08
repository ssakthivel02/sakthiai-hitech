import { describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { router } from "../_core/trpc";
import type { TrpcContext } from "../_core/context";
import { createSentinelRouter } from "./router";
import { InMemorySentinelStore } from "./testing";
import { WS } from "./testkit";

/**
 * sentinel.create through the REAL authenticated-request middleware and the real (per-process) limiter: no mock. Each create queues a durable task that can
 * make dozens of model calls, so it carries the tight "sentinel-create" policy (6 per minute per user), not the default 180.
 */
const CONNECTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
class Tasks {
  n = 0;
  async create() { this.n++; return { task: { id: `00000000-0000-4000-8000-${String(this.n).padStart(12, "0")}` } as never, created: true }; }
  async get() { return null; }
  async cancel() { return null; }
}

describe("sentinel.create is rate limited per user by the authenticated middleware", () => {
  it("allows 6 creates a minute, then 429 with Retry-After and nothing queued; another user is unaffected; reads keep the default budget", async () => {
    const store = new InMemorySentinelStore(); const tasks = new Tasks();
    const api = router({ sentinel: createSentinelRouter({
      store: () => store, tasks: () => tasks as never, enabled: () => true, workerEnabled: () => true, maxActive: () => 50,
      mcp: () => ({ list: async () => [{ id: CONNECTOR, name: "synthetic", endpoint: "http://127.0.0.1:9100/mcp", enabled: true, hasSecret: false, allowedTools: null, timeoutMs: 8000, maxResponseBytes: 262144 }], discover: async () => ({ tools: [{ name: "search_logs" }] }) }) as never,
      requireWorkspace: async () => ({}), isWorkspaceOwner: async () => false,
    }) });
    const headers: Record<string, string> = {};
    const as = (id: number) => api.createCaller({ req: {} as TrpcContext["req"], res: { headersSent: false, setHeader: vi.fn((k: string, v: string) => { headers[k] = v; }) } as unknown as TrpcContext["res"], requestId: "t", user: { id: id, openId: `rl${id}`, name: "U", email: null, loginMethod: null, role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() } as never }).sentinel;
    const input = { workspaceId: WS, title: "Write failures on orders-db", service: "orders-db", description: "Writes fail intermittently", bindings: [{ tool: "logs.search" as const, connectorId: CONNECTOR, mcpTool: "search_logs", targetParam: "service" }] };
    for (let i = 0; i < 6; i++) await as(9101).create(input);
    const error = await as(9101).create(input).then(() => null, (e) => e as TRPCError);
    expect(error).toBeInstanceOf(TRPCError);
    expect(error!.code).toBe("TOO_MANY_REQUESTS");
    expect(headers["Retry-After"]).toBeDefined();
    expect(tasks.n).toBe(6);                                         // the refused call queued nothing
    await as(9102).create(input);                                   // the limit is per user
    expect(tasks.n).toBe(7);
    await expect(as(9101).list({ workspaceId: WS })).resolves.toBeDefined();   // other procedures are on the default policy
  });
});
