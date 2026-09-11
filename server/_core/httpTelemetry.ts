const REQUEST_ID_MAX_LENGTH = 128;

export type HttpRequestLog = {
  event: "http_request";
  requestId: string;
  method: string;
  routeClass: string;
  status: number;
  latencyMs: number;
};

export function sanitizeRequestId(value: string | undefined, fallback: string): string {
  const candidate = (value || "").trim();
  if (!candidate) return fallback;

  const safe = candidate
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, REQUEST_ID_MAX_LENGTH);

  return safe || fallback;
}

export function classifyRequestPath(path: string): string {
  if (path === "/healthz" || path === "/readyz" || path === "/releasez") {
    return path;
  }
  if (path === "/api/trpc" || path.startsWith("/api/trpc/")) return "/api/trpc";
  if (path.startsWith("/oauth/")) return "/oauth/*";
  if (path.startsWith("/api/storage") || path.startsWith("/storage/")) return "/storage/*";
  if (path.startsWith("/api/")) return "/api/*";
  if (path.startsWith("/assets/")) return "/assets/*";
  return "/app";
}

export function buildHttpRequestLog(input: {
  requestId: string;
  method: string;
  path: string;
  status: number;
  latencyMs: number;
}): HttpRequestLog {
  return {
    event: "http_request",
    requestId: input.requestId,
    method: input.method.toUpperCase().slice(0, 16),
    routeClass: classifyRequestPath(input.path),
    status: Number.isInteger(input.status) ? input.status : 0,
    latencyMs: Math.max(0, Math.round(input.latencyMs)),
  };
}
