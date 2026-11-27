/**
 * Endpoint profiles for the EXTERNAL provider binding.
 *
 * The default profile ("openai-v1") is the historical behaviour: operator-supplied base URL plus the standard OpenAI-style route.
 * Pinned profiles exist because some hosted providers expose an OpenAI-compatible route at a different path
 * (for example Gemini's `/v1beta/openai/` route). A pinned profile:
 *   - is chosen ONLY by operator configuration (LLM_ENDPOINT_PROFILE); nothing from a user, a prompt or a model response can select or alter it;
 *   - requires https on the default port, no credentials, no query/fragment and no path in the configured base URL;
 *   - allows exactly the listed hosts (exact match, no wildcard, no suffix match);
 *   - has its request path fixed in code by the adapter, so the operator cannot point the API key at an arbitrary route;
 *   - is called with redirects disabled, so a credential-bearing request can never be forwarded to another host.
 * Whether a profile actually works against the live provider is NOT established by this module; that needs an owner-approved probe.
 */
export type EndpointProfileId = "openai-v1" | "gemini-openai" | "sarvam-chat";

type PinnedProfile = { hosts: readonly string[]; label: string };

const PINNED: Readonly<Record<Exclude<EndpointProfileId, "openai-v1">, PinnedProfile>> = {
  "gemini-openai": { hosts: ["generativelanguage.googleapis.com"], label: "Google Gemini (OpenAI-compatible route)" },
  "sarvam-chat": { hosts: ["api.sarvam.ai"], label: "Sarvam AI chat completions" },
};

export const ENDPOINT_PROFILE_IDS: readonly EndpointProfileId[] = ["openai-v1", "gemini-openai", "sarvam-chat"];

export const isEndpointProfileId = (value: string): value is EndpointProfileId => (ENDPOINT_PROFILE_IDS as readonly string[]).includes(value);

/** True for profiles whose host and path are fixed by this module (and whose requests must not follow redirects). */
export const isPinnedProfile = (id: EndpointProfileId): boolean => id !== "openai-v1";

export function describeEndpointProfile(id: EndpointProfileId): string {
  return id === "openai-v1" ? "OpenAI-compatible (operator base URL, standard route)" : PINNED[id].label;
}

export type EndpointResolution = { ok: true; origin: string } | { ok: false; reason: string };

/**
 * Pure validation. Returns the allowlisted origin a pinned profile may call, or why the base URL is refused.
 * The request PATH for each profile is owned by the adapter (openaiCompatible.ts), the single module allowed to build chat-completions requests.
 */
export function validatePinnedOrigin(id: Exclude<EndpointProfileId, "openai-v1">, baseUrl: string): EndpointResolution {
  const profile = PINNED[id];
  let parsed: URL;
  try { parsed = new URL(baseUrl.trim()); } catch { return { ok: false, reason: "not a valid URL" }; }
  if (parsed.protocol !== "https:") return { ok: false, reason: `${id} requires https` };
  if (parsed.username || parsed.password) return { ok: false, reason: "must not embed credentials" };
  if (parsed.port && parsed.port !== "443") return { ok: false, reason: `${id} requires the default https port` };
  if (!profile.hosts.includes(parsed.hostname.toLowerCase())) return { ok: false, reason: `host is not allowed for ${id} (allowed: ${profile.hosts.join(", ")})` };
  if (parsed.search || parsed.hash) return { ok: false, reason: "must not include a query string or fragment" };
  if (parsed.pathname !== "/" && parsed.pathname !== "") return { ok: false, reason: `${id} fixes the request path itself; set LLM_API_URL to the origin only (https://${profile.hosts[0]})` };
  return { ok: true, origin: `https://${profile.hosts[0]}` };
}
