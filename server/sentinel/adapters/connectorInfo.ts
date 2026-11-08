import net from "node:net";
import { allowedEndpointOrigins } from "../../connectors/mcp/policy";
import type { EnvLike } from "../../connectors/mcp/policy";

/**
 * Honest classification of where a connector endpoint lives. Sentinel cannot prove that a remote endpoint is a genuine production monitoring
 * system, so the strongest claim it ever makes is "remote": it only distinguishes loopback/dev endpoints (synthetic) from everything else.
 */
export type Locality = "local" | "private-network" | "remote";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);
const isPrivateV4 = (ip: string): boolean => {
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
};

export function classifyEndpoint(endpoint: string): Locality {
  let host: string;
  try { host = new URL(endpoint).hostname.replace(/^\[|\]$/g, "").toLowerCase(); } catch { return "remote"; }
  if (LOOPBACK.has(host)) return "local";
  if (net.isIPv4(host) && isPrivateV4(host)) return host.startsWith("127.") ? "local" : "private-network";
  if (net.isIPv6(host) && (host.startsWith("fc") || host.startsWith("fd"))) return "private-network";
  return "remote";
}

export const LOCALITY_LABEL: Record<Locality, string> = {
  local: "Local / synthetic (loopback) - not a production monitoring system",
  "private-network": "Private network endpoint - not verified as production monitoring",
  remote: "Remote endpoint - not verified as production monitoring",
};

const SECRET_REF = /^[A-Z][A-Z0-9_]{0,63}$/;
export interface ConnectorCatalog {
  approvedOrigins: Array<{ origin: string; locality: Locality }>;
  loopbackHttpAllowed: boolean;
  privateNetworkAllowed: boolean;
  /** Names only (never values) of operator-provisioned secret references the owner may attach to a connector. */
  secretRefs: string[];
}

/** Operator configuration the owner needs to register a connector. Contains no secret values and no credentials. */
export function connectorCatalog(env: EnvLike): ConnectorCatalog {
  const secretRefs = Object.keys(env).filter((k) => k.startsWith("MCP_SECRET_") && !!env[k]).map((k) => k.slice("MCP_SECRET_".length)).filter((n) => SECRET_REF.test(n)).sort();
  return {
    approvedOrigins: allowedEndpointOrigins(env).map((origin) => ({ origin, locality: classifyEndpoint(origin) })),
    loopbackHttpAllowed: env.MCP_ALLOW_LOOPBACK_HTTP === "true",
    privateNetworkAllowed: env.MCP_ALLOW_PRIVATE_NETWORK === "true",
    secretRefs,
  };
}
