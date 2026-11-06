import http from "node:http";
import https from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { classifyHost, normalizeHost } from "./hostClass";

/**
 * A `fetch` whose connection is PINNED to the addresses that passed the address policy.
 *
 * Why it exists: checking a hostname's DNS answer and then calling fetch() resolves the name twice. A name that answers "internal address" to the
 * check and "169.254.169.254" (or any other forbidden address) to the connection (DNS rebinding, or just a short-TTL flip) passes the check and is dialled
 * anyway. Here the policy runs INSIDE the `lookup` that the socket uses to connect, on the same answer that is dialled, so there is no second
 * resolution to race. IP literals never reach `lookup`, so they are checked before the request is made.
 *
 * Behaviour (matches `fetch(..., { redirect: "error" })` as the callers use it): any 3xx is a network failure and is never followed; the response is
 * a standard `Response`; an abort signal destroys the socket; `accept-encoding: identity` is sent so the body is never transparently decompressed; no
 * connection is reused across requests (`agent: false`), so every request re-validates. Only string / Uint8Array bodies are supported.
 * Nothing here logs or includes a URL, host, header or body in an error.
 */
export type AddressPolicy = (address: string, hostname: string) => string | null; // null = allowed; a string = why it is refused
export type PinnedResolver = (hostname: string) => Promise<string[]>;

export class PinnedFetchRefusal extends Error {
  constructor(readonly reason: string) { super("destination refused by address policy"); this.name = "PinnedFetchRefusal"; }
}

export type PinnedFetchOptions = {
  policy: AddressPolicy;
  /** Test seam. Default: the system resolver, every address, verbatim order. */
  resolve?: PinnedResolver;
  /** Builds the error thrown when the policy refuses (so a caller can raise its own terminal error class). Default: PinnedFetchRefusal. */
  refusal?: (reason: string) => Error;
  /** Test seam: extra trusted CA for https. Certificate and hostname verification are never disabled; there is deliberately no `rejectUnauthorized` option. */
  tls?: { ca?: string | Buffer };
};

const defaultResolve: PinnedResolver = async (hostname) => (await dnsLookup(hostname, { all: true, verbatim: true })).map((r) => r.address);
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/** Policy for the LOCAL model slots (chat and embeddings): loopback and private-network only; link-local / cloud-metadata and everything public refused. */
export const localSlotAddressPolicy: AddressPolicy = (address) => {
  const c = classifyHost(address);
  if (c === "loopback" || c === "private") return null;
  return c === "blocked" ? "link-local or cloud-metadata address" : "not a loopback or private-network address";
};

export function createPinnedFetch(options: PinnedFetchOptions): typeof fetch {
  const resolve = options.resolve ?? defaultResolve;
  const refuse = (reason: string): Error => (options.refusal ? options.refusal(reason) : new PinnedFetchRefusal(reason));

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("unsupported protocol");
    const body = init?.body;
    if (body !== undefined && body !== null && typeof body !== "string" && !(body instanceof Uint8Array)) throw new TypeError("unsupported request body");
    const host = normalizeHost(url.hostname);
    if (isIP(host)) {
      const why = options.policy(host, host);
      if (why) throw refuse(why); // an IP literal is dialled directly (no lookup), so it is judged here
    }

    const headers = new Headers(init?.headers);
    if (!headers.has("accept-encoding")) headers.set("accept-encoding", "identity");
    if (body !== undefined && body !== null && !headers.has("content-length")) headers.set("content-length", String(Buffer.byteLength(body)));

    let refused: Error | null = null;
    const lookup = ((hostname: string, lookupOptions: { all?: boolean }, callback: (...args: unknown[]) => void) => {
      resolve(normalizeHost(hostname)).then((addresses) => {
        if (addresses.length === 0) { refused = refuse("name did not resolve"); return callback(refused); }
        for (const address of addresses) {
          const why = options.policy(address, host);
          if (why) { refused = refuse(why); return callback(refused); } // EVERY answer must pass: a mixed answer is refused
        }
        if (lookupOptions?.all) callback(null, addresses.map((address) => ({ address, family: isIP(address) })));
        else callback(null, addresses[0], isIP(addresses[0]!));
      }, () => { refused = refuse("name did not resolve"); callback(refused); });
    }) as unknown as NonNullable<http.RequestOptions["lookup"]>;

    return await new Promise<Response>((resolveResponse, reject) => {
      const request = (url.protocol === "https:" ? https : http).request({
        protocol: url.protocol, hostname: host, port: url.port || undefined, path: `${url.pathname}${url.search}`,
        method: init?.method ?? "GET", headers: Object.fromEntries(headers), lookup, agent: false, signal: init?.signal ?? undefined,
        ...(url.protocol === "https:" && options.tls?.ca ? { ca: options.tls.ca } : {}),
      }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) { res.destroy(); reject(new TypeError("fetch failed: redirect refused")); return; }
        const responseHeaders = new Headers();
        for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
          try { responseHeaders.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!); } catch { /* an unrepresentable header is dropped */ }
        }
        try {
          resolveResponse(new Response(NULL_BODY_STATUS.has(status) ? null : (Readable.toWeb(res) as unknown as ReadableStream), { status, statusText: res.statusMessage ?? "", headers: responseHeaders }));
        } catch { res.destroy(); reject(new TypeError("fetch failed")); }
      });
      request.on("error", (error) => reject(refused ?? error));
      if (body !== undefined && body !== null) request.write(body);
      request.end();
    });
  }) as typeof fetch;
}
