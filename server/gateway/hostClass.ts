import { isIPv4, isIPv6 } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

/**
 * Network classification for the LOCAL (self-hosted) provider slot. The slot is exempt from the external-provider policy flags and from the spend
 * budget, so it may only ever point at the operator's own compute: this machine, or a private-network host the operator named explicitly.
 *
 *   loopback   localhost, 127.0.0.0/8, ::1 (also the IPv4-mapped form of those)
 *   private    RFC 1918, 169.254/16, 100.64/10 (CGNAT, e.g. tailnets), fc00::/7, fe80::/10 (and IPv4-mapped forms of those)
 *   internal   a name that is not a global DNS name: single label, or .local .internal .lan .home.arpa .svc .cluster.local .localdomain .localhost
 *   unroutable *.invalid (RFC 6761: can never resolve, so no destination can be reached)
 *   public     everything else, including 0.0.0.0, public IP literals, and every ordinary DNS name
 *
 * Pure functions plus one injectable resolver. Nothing here performs a request.
 */
export type HostClass = "loopback" | "private" | "internal" | "unroutable" | "public";

const INTERNAL_SUFFIXES: readonly string[] = [".local", ".internal", ".lan", ".home.arpa", ".svc", ".cluster.local", ".localdomain", ".localhost"];

/** Lower-case, no brackets, no trailing dot. Input is a WHATWG `URL.hostname`, which is already canonical for IP forms (decimal/octal/hex IPv4 become dotted). */
export function normalizeHost(hostname: string): string {
  let h = hostname.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return h.replace(/\.$/, "");
}

function classifyIpv4(host: string): HostClass {
  const o = host.split(".").map(Number);
  const [a, b] = [o[0]!, o[1]!];
  if (a === 127) return "loopback";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) return "private";
  return "public"; // includes 0.0.0.0/8, multicast, reserved and every global address
}

/** Parse an IPv6 literal into eight 16-bit groups, or null if malformed. */
function parseIpv6(host: string): number[] | null {
  let s = host;
  const zone = s.indexOf("%");
  if (zone >= 0) return null; // zone ids are never a legitimate configuration here
  if (s.includes(".")) { // embedded dotted IPv4 tail
    const i = s.lastIndexOf(":");
    const v4 = s.slice(i + 1);
    if (!isIPv4(v4)) return null;
    const p = v4.split(".").map(Number);
    s = `${s.slice(0, i + 1)}${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}

function classifyIpv6(host: string): HostClass {
  const g = parseIpv6(host);
  if (!g) return "public"; // unparseable: never treat as local
  if (g.slice(0, 7).every((x) => x === 0)) return g[7] === 1 ? "loopback" : "public"; // ::1 only; :: and ::a.b.c.d (deprecated) are not local
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) { // IPv4-mapped ::ffff:a.b.c.d
    return classifyIpv4(`${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`);
  }
  if ((g[0]! & 0xfe00) === 0xfc00) return "private"; // fc00::/7
  if ((g[0]! & 0xffc0) === 0xfe80) return "private"; // fe80::/10
  return "public"; // includes 64:ff9b::/96 (NAT64), 2002::/16 (6to4), 2001::/32 (Teredo) and all global unicast
}

export function classifyHost(hostname: string): HostClass {
  const host = normalizeHost(hostname);
  if (!host) return "public";
  if (isIPv4(host)) return classifyIpv4(host);
  if (isIPv6(host)) return classifyIpv6(host);
  if (!/^[a-z0-9._-]+$/.test(host)) return "public"; // anything that is not a plain DNS-label string (stray colons, brackets, zone ids, unicode) is never local
  if (host === "localhost") return "loopback";
  if (host === "invalid" || host.endsWith(".invalid")) return "unroutable";
  if (!host.includes(".") || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) return "internal";
  return "public";
}

/** True when the host is a NAME whose address is decided by DNS at request time (so the resolved addresses must be checked). */
export function needsResolutionCheck(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (!host || isIPv4(host) || isIPv6(host) || host === "localhost") return false;
  return classifyHost(host) === "internal";
}

/** Parse LOCAL_LLM_ALLOWED_HOSTS: comma/space separated exact hosts. Wildcards, ports, schemes and paths are not accepted (they are dropped). */
export function parseAllowedHosts(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of (raw ?? "").split(/[\s,]+/)) {
    const h = normalizeHost(part);
    if (!h || /[*\/\\@?#%\s]/.test(h)) continue;
    if (h.includes(":") && !isIPv6(h)) continue; // a port or other garbage; IPv6 literals are the only colon form accepted
    out.add(h);
  }
  return out;
}

export type Resolver = (hostname: string) => Promise<string[]>;
const defaultResolver: Resolver = async (hostname) => (await dnsLookup(hostname, { all: true, verbatim: true })).map((r) => r.address);

/**
 * Request-time check for a hostname that passed configuration: EVERY address it resolves to must be loopback or private. An empty or failed
 * resolution fails closed. Limitation (documented): the HTTP client resolves again when it connects, so a name that flips between this check and the
 * connection (DNS rebinding) is not excluded; use an IP literal in LOCAL_LLM_ALLOWED_HOSTS to remove that window.
 */
export function createResolvedAddressGuard(resolve: Resolver = defaultResolver): (hostname: string) => Promise<boolean> {
  return async (hostname) => {
    try {
      const addresses = await resolve(normalizeHost(hostname));
      if (addresses.length === 0) return false;
      return addresses.every((a) => { const c = classifyHost(a); return c === "loopback" || c === "private"; });
    } catch {
      return false;
    }
  };
}
