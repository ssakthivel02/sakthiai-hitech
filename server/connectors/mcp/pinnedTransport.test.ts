import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPinnedFetch, PinnedFetchRefusal } from "../../gateway/pinnedFetch";
import { mcpAddressProblem, type EnvLike } from "./policy";

/**
 * Connection-time enforcement of the MCP address policy (the same composition McpConnectorService builds), on real sockets with a scripted resolver.
 * No database: this complements the MySQL-gated service.mysql.test.ts, which is skipped without MYSQL_TEST_URL.
 */
let server: http.Server; let decoy: http.Server;
let port = 0; let decoyPort = 0; let hits = 0; let decoyHits = 0; let mode: "ok" | "redirect" = "ok";

beforeAll(async () => {
  decoy = http.createServer((_q, r) => { decoyHits++; r.end("decoy"); });
  await new Promise<void>((r) => decoy.listen(0, "127.0.0.1", r)); decoyPort = (decoy.address() as AddressInfo).port;
  server = http.createServer((_q, r) => { hits++; if (mode === "redirect") { r.writeHead(302, { location: `http://127.0.0.1:${decoyPort}/x` }); r.end(); return; } r.writeHead(200); r.end("{}"); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); port = (server.address() as AddressInfo).port;
});
afterAll(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => decoy.close(r)); });

const reset = () => { hits = 0; decoyHits = 0; mode = "ok"; };
const transport = (env: EnvLike, answers: string[][]) => {
  const calls: string[] = [];
  const f = createPinnedFetch({
    policy: (address, hostname) => mcpAddressProblem(address, hostname, env),
    resolve: async (h) => { calls.push(h); return answers[Math.min(calls.length - 1, answers.length - 1)]!; },
  });
  return { f, calls };
};
const url = `http://mcp.internal`;

describe("MCP transport: policy enforced on the address actually dialled", () => {
  it("a private/loopback answer is refused unless MCP_ALLOW_PRIVATE_NETWORK=true; nothing is sent", async () => {
    reset();
    const { f } = transport({}, [["127.0.0.1"]]);
    await expect(f(`${url}:${port}/`, { method: "POST", body: "{}" })).rejects.toBeInstanceOf(PinnedFetchRefusal);
    expect(hits).toBe(0);
  });
  it("with the private-network flag a private answer is dialled", async () => {
    reset();
    const { f } = transport({ MCP_ALLOW_PRIVATE_NETWORK: "true" }, [["127.0.0.1"]]);
    expect((await f(`${url}:${port}/`, { method: "POST", body: "{}" })).status).toBe(200);
    expect(hits).toBe(1);
  });
  it.each([["metadata", "169.254.169.254"], ["mapped metadata", "::ffff:a9fe:a9fe"], ["nat64 metadata", "64:ff9b::a9fe:a9fe"], ["alibaba", "100.100.100.200"], ["aws ipv6", "fd00:ec2::254"], ["mapped private without flag", "::ffff:7f00:1"]])(
    "%s is refused even with the private-network flag set where it is metadata", async (label, address) => {
      reset();
      const flag = label === "mapped private without flag" ? {} : { MCP_ALLOW_PRIVATE_NETWORK: "true" };
      const { f } = transport(flag, [[address]]);
      await expect(f(`${url}:${port}/`, { method: "POST", body: "{}" })).rejects.toBeInstanceOf(PinnedFetchRefusal);
      expect(hits).toBe(0);
    });
  it("DNS re-resolution: each new connection re-resolves and is re-judged; a name that flips to metadata is refused before any packet", async () => {
    reset();
    const { f, calls } = transport({ MCP_ALLOW_PRIVATE_NETWORK: "true" }, [["127.0.0.1"], ["169.254.169.254"]]);
    expect((await f(`${url}:${port}/`, { method: "POST", body: "{}" })).status).toBe(200);
    await expect(f(`${url}:${port}/`, { method: "POST", body: "{}" })).rejects.toBeInstanceOf(PinnedFetchRefusal);
    expect(calls).toHaveLength(2);
    expect(hits).toBe(1);
  });
  it("a mixed answer containing any forbidden address is refused as a whole", async () => {
    reset();
    const { f } = transport({ MCP_ALLOW_PRIVATE_NETWORK: "true" }, [["127.0.0.1", "169.254.169.254"]]);
    await expect(f(`${url}:${port}/`, { method: "POST", body: "{}" })).rejects.toBeInstanceOf(PinnedFetchRefusal);
    expect(hits).toBe(0);
  });
  it("a redirect is never followed: the target receives nothing", async () => {
    reset(); mode = "redirect";
    const { f } = transport({ MCP_ALLOW_PRIVATE_NETWORK: "true" }, [["127.0.0.1"]]);
    await expect(f(`${url}:${port}/`, { method: "POST", body: "{}" })).rejects.toBeInstanceOf(TypeError);
    expect(hits).toBe(1); expect(decoyHits).toBe(0);
  });
});
