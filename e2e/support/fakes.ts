import { createHash } from "node:crypto";
import http from "node:http";
import net from "node:net";

/**
 * Deterministic in-process fakes for the end-to-end stack. None of them performs any real network call:
 * every listener binds loopback only, and the "external" LLM exists purely so a test can PROVE it was never contacted.
 */
export type Closeable = { server: http.Server | net.Server; close(): Promise<void> };

const listen = <T extends http.Server | net.Server>(server: T, port: number) =>
  new Promise<Closeable>(resolve => {
    server.listen(port, "127.0.0.1", () =>
      resolve({ server, close: () => new Promise<void>(done => { (server as net.Server).close(() => done()); (server as http.Server).closeAllConnections?.(); }) }));
  });

const readBody = (req: http.IncomingMessage) =>
  new Promise<Buffer>(resolve => { const parts: Buffer[] = []; req.on("data", c => parts.push(c)); req.on("end", () => resolve(Buffer.concat(parts))); });
const json = (res: http.ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

// ---------------------------------------------------------------- fake OIDC provider
type Identity = { sub: string; name: string; email: string };
export function startFakeOidc(port: number) {
  let nextUser: Identity = { sub: "e2e-default", name: "E2E Default", email: "default@example.test" };
  const codes = new Map<string, { identity: Identity; challenge: string }>();
  const tokens = new Map<string, Identity>();
  let counter = 0;
  const issue = (identity: Identity, challenge: string) => { const code = `code-${++counter}-${Math.random().toString(36).slice(2)}`; codes.set(code, { identity, challenge }); return code; };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (req.method === "GET" && url.pathname === "/authorize") {
      const redirect = url.searchParams.get("redirect_uri") ?? "";
      const state = url.searchParams.get("state") ?? "";
      if (url.searchParams.get("code_challenge_method") !== "S256" || !url.searchParams.get("code_challenge")) return json(res, 400, { error: "pkce_required" });
      const code = issue(nextUser, url.searchParams.get("code_challenge")!);
      const target = new URL(redirect);
      target.searchParams.set("code", code); target.searchParams.set("state", state);
      res.writeHead(302, { location: target.toString() }); return res.end();
    }
    if (req.method === "POST" && url.pathname === "/token") {
      const form = new URLSearchParams((await readBody(req)).toString("utf8"));
      const entry = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? ""); // single use
      const verifier = form.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (!entry || entry.challenge !== challenge) return json(res, 400, { error: "invalid_grant" });
      const accessToken = `at-${Math.random().toString(36).slice(2)}`;
      tokens.set(accessToken, entry.identity);
      return json(res, 200, { access_token: accessToken, token_type: "Bearer" });
    }
    if (req.method === "GET" && url.pathname === "/userinfo") {
      const identity = tokens.get((req.headers.authorization ?? "").replace(/^Bearer /i, ""));
      return identity ? json(res, 200, identity) : json(res, 401, { error: "invalid_token" });
    }
    // test control surface
    if (req.method === "POST" && url.pathname === "/__control/next-user") { nextUser = JSON.parse((await readBody(req)).toString("utf8")); return json(res, 200, { ok: true }); }
    if (req.method === "POST" && url.pathname === "/__control/code") { const b = JSON.parse((await readBody(req)).toString("utf8")); return json(res, 200, { code: issue(b.identity, b.challenge) }); }
    json(res, 404, { error: "not_found" });
  });
  return listen(server, port);
}

// ---------------------------------------------------------------- fake OpenAI-compatible LLM (used for "local" and for the never-to-be-called "external")
export type LlmMode = "ok" | "insufficient" | "down";
export function startFakeLlm(port: number, label: string) {
  const state = { mode: "ok" as LlmMode, calls: 0, last: null as null | { language: string; userMessage: string; authorization: string | undefined } };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname === "/__control" && req.method === "POST") { Object.assign(state, JSON.parse((await readBody(req)).toString("utf8"))); return json(res, 200, { ok: true }); }
    if (url.pathname === "/__reset" && req.method === "POST") { state.mode = "ok"; state.calls = 0; state.last = null; return json(res, 200, { ok: true }); }
    if (url.pathname === "/__stats") return json(res, 200, { label, mode: state.mode, calls: state.calls, last: state.last });
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      state.calls += 1;
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      const system = String(body.messages?.find((m: any) => m.role === "system")?.content ?? "");
      const user = String(body.messages?.filter((m: any) => m.role === "user").at(-1)?.content ?? "");
      state.last = { language: /Answer in Tamil/.test(system) ? "ta" : "en", userMessage: user, authorization: req.headers.authorization };
      if (state.mode === "down") return json(res, 503, { error: { message: "fake provider down" } });
      const content = state.mode === "insufficient" ? "INSUFFICIENT_EVIDENCE" : state.last.language === "ta" ? `[${label}] ஆதாரத்தின்படி பதில்: கோவில் காலை ஆறு மணிக்கு திறக்கும் [1]` : `[${label}] Per the sources the temple opens at 6am [1]`;
      return json(res, 200, { id: `chatcmpl-${state.calls}`, object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
    }
    json(res, 404, { error: "not_found" });
  });
  return listen(server, port);
}

// ---------------------------------------------------------------- fake path-style S3 (put/get/delete/head)
export function startFakeS3(port: number) {
  const objects = new Map<string, { body: Buffer; type: string }>();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const key = decodeURIComponent(url.pathname);
    if (url.pathname === "/__stats") return json(res, 200, { objects: objects.size });
    if (req.method === "PUT") { const body = await readBody(req); objects.set(key, { body, type: String(req.headers["content-type"] ?? "") }); res.writeHead(200, { etag: '"fake"' }); return res.end(); }
    if (req.method === "GET" || req.method === "HEAD") {
      const object = objects.get(key);
      if (!object) { res.writeHead(404, { "content-type": "application/xml" }); return res.end("<Error><Code>NoSuchKey</Code></Error>"); }
      res.writeHead(200, { "content-type": object.type, "content-length": object.body.length, etag: '"fake"' }); return res.end(req.method === "HEAD" ? undefined : object.body);
    }
    if (req.method === "DELETE") { objects.delete(key); res.writeHead(204); return res.end(); }
    res.writeHead(405); res.end();
  });
  return listen(server, port);
}

// ---------------------------------------------------------------- fake clamd (INSTREAM protocol; flags the EICAR marker)
export function startFakeClamd(port: number) {
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const header = Buffer.from("zINSTREAM\0");
      if (buffer.length < header.length || !buffer.subarray(0, header.length).equals(header)) return;
      let offset = header.length; const parts: Buffer[] = [];
      while (buffer.length >= offset + 4) {
        const length = buffer.readUInt32BE(offset); offset += 4;
        if (length === 0) { socket.write(Buffer.concat(parts).toString("utf8").includes("EICAR-STANDARD-ANTIVIRUS-TEST-FILE") ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0"); return; }
        if (buffer.length < offset + length) return;
        parts.push(buffer.subarray(offset, offset + length)); offset += length;
      }
    });
    socket.on("error", () => undefined);
  });
  return listen(server, port);
}
