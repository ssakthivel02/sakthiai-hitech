import dns from "node:dns/promises";
import net from "node:net";

/**
 * Connector governance: which endpoints may ever be contacted, which tools count as read-only.
 * Everything fails closed. The model/agent never supplies a URL: endpoints come from approved configuration only.
 */
export type EnvLike = Record<string, string | undefined>;

/** MCP_ALLOWED_ENDPOINTS: comma-separated exact origins (https://host[:port]) an operator has approved. */
export function allowedEndpointOrigins(env: EnvLike): string[] {
  return (env.MCP_ALLOWED_ENDPOINTS ?? "").split(",").map(v => v.trim()).filter(Boolean);
}

export type EndpointVerdict = { ok: true; url: URL } | { ok: false; reason: string };

export function checkEndpointSyntax(raw: string, env: EnvLike): EndpointVerdict {
  let url: URL;
  try { url = new URL(raw); } catch { return { ok: false, reason: "endpoint is not a valid URL" }; }
  if (url.username || url.password) return { ok: false, reason: "endpoint must not contain credentials" };
  if (url.search || url.hash) return { ok: false, reason: "endpoint must not contain a query string or fragment" };
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "http:") {
    if (!(loopback && env.MCP_ALLOW_LOOPBACK_HTTP === "true")) return { ok: false, reason: "endpoint must use https (plain http is allowed only for loopback when MCP_ALLOW_LOOPBACK_HTTP=true)" };
  } else if (url.protocol !== "https:") return { ok: false, reason: "endpoint must use https" };
  if (!allowedEndpointOrigins(env).includes(url.origin)) return { ok: false, reason: "endpoint origin is not in the operator-approved allowlist (MCP_ALLOWED_ENDPOINTS)" };
  return { ok: true, url };
}

const isPrivateV4 = (ip: string) => {
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
};
const isLinkLocalV4 = (ip: string) => ip.startsWith("169.254.");
const isMetadata = (ip: string) => ip === "169.254.169.254" || ip.toLowerCase() === "fd00:ec2::254";

/** Resolved-address check (DNS rebinding / internal-network pivots). Link-local and metadata addresses are never allowed. */
export async function assertResolvedAddressAllowed(url: URL, env: EnvLike, lookup: typeof dns.lookup = dns.lookup): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(host) ? [host] : (await lookup(host, { all: true })).map(a => a.address);
  const loopbackAllowed = env.MCP_ALLOW_LOOPBACK_HTTP === "true" && ["localhost", "127.0.0.1", "::1"].includes(host);
  for (const ip of addresses) {
    const v6 = ip.includes(":");
    const lower = ip.toLowerCase();
    if (isMetadata(ip) || (!v6 && isLinkLocalV4(ip)) || (v6 && lower.startsWith("fe80:"))) throw new Error("endpoint resolves to a link-local/metadata address");
    const priv = v6 ? lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") : isPrivateV4(ip);
    if (priv && !loopbackAllowed && env.MCP_ALLOW_PRIVATE_NETWORK !== "true") throw new Error("endpoint resolves to a private address (set MCP_ALLOW_PRIVATE_NETWORK=true only for an approved internal server)");
  }
}

const MUTATION_WORD = /(^|[^a-z])(create|delete|remove|update|write|send|post|put|patch|execute|exec|run|shell|deploy|publish|set|insert|drop|kill|move|rename|upload|commit|push|merge|approve|grant|revoke|install|start|stop|restart|apply|edit|modify|save|add|clear|reset|truncate|purge|invoke|call|trigger|submit|transfer|pay|buy|order)([^a-z]|$)/i;
const camelSplit = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2");

export type ToolDecision = { allowed: true } | { allowed: false; reason: string };
/**
 * A tool is usable ONLY when the server explicitly declares readOnlyHint=true, does not declare destructiveHint,
 * the name does not look like a mutation, and (when configured) the operator allowlist contains it.
 * Missing or ambiguous annotations are denied. Server-supplied descriptions never influence the decision.
 */
export function decideTool(tool: { name: string; annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown } }, allowlist?: readonly string[] | null): ToolDecision {
  if (tool.annotations?.destructiveHint === true) return { allowed: false, reason: "tool is declared destructive" };
  if (tool.annotations?.readOnlyHint !== true) return { allowed: false, reason: "tool is not explicitly declared read-only" };
  if (MUTATION_WORD.test(camelSplit(tool.name))) return { allowed: false, reason: "tool name looks like a mutation" };
  if (allowlist && allowlist.length > 0 && !allowlist.includes(tool.name)) return { allowed: false, reason: "tool is not in the connector allowlist" };
  return { allowed: true };
}

/** Removes secrets from any text that may reach a model or a log: exact secret values plus common credential shapes. */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) if (secret && secret.length >= 6) out = out.split(secret).join("[REDACTED]");
  return out
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\b(sk|pk|rk|ghp|gho|ghu|ghs|xox[abprs]|AKIA|AIza)[-_A-Za-z0-9]{12,}/g, "[REDACTED]")
    .replace(/(["']?(?:password|passwd|secret|api[_-]?key|token|authorization)["']?\s*[:=]\s*)(["']?)[^\s"',}]{6,}\2/gi, "$1[REDACTED]");
}
