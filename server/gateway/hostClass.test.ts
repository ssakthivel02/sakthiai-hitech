import { describe, expect, it } from "vitest";
import { classifyHost, createResolvedAddressGuard, needsResolutionCheck, normalizeHost, parseAllowedHosts, type HostClass } from "./hostClass";

/** classifyHost receives URL.hostname, so the WHATWG parser's canonical forms are part of what is under test. */
const host = (u: string) => new URL(u).hostname;

describe("classifyHost", () => {
  it.each<[string, HostClass]>([
    ["http://127.0.0.1", "loopback"], ["http://127.255.255.254", "loopback"], ["http://localhost", "loopback"], ["http://LOCALHOST.", "loopback"], ["http://[::1]", "loopback"],
    ["http://0x7f.1", "loopback"], ["http://2130706433", "loopback"], ["http://0177.0.0.1", "loopback"], ["http://[::ffff:127.0.0.1]", "loopback"], ["http://[::ffff:7f00:1]", "loopback"],
    ["http://10.0.0.1", "private"], ["http://10.255.255.255", "private"], ["http://172.16.0.0", "private"], ["http://172.31.255.255", "private"], ["http://192.168.0.1", "private"],
    ["http://169.254.1.1", "private"], ["http://100.64.0.1", "private"], ["http://100.127.255.255", "private"], ["http://[fc00::1]", "private"], ["http://[fd12:3456::1]", "private"],
    ["http://[fe80::1]", "private"], ["http://[febf::1]", "private"], ["http://[::ffff:10.0.0.1]", "private"], ["http://[::ffff:192.168.1.1]", "private"],
    ["http://172.15.255.255", "public"], ["http://172.32.0.1", "public"], ["http://100.63.255.255", "public"], ["http://100.128.0.1", "public"], ["http://11.0.0.1", "public"],
    ["http://192.169.0.1", "public"], ["http://8.8.8.8", "public"], ["http://0.0.0.0", "public"], ["http://0.1.2.3", "public"], ["http://255.255.255.255", "public"],
    ["http://[::]", "public"], ["http://[::2]", "public"], ["http://[::127.0.0.1]", "public"], ["http://[2001:4860:4860::8888]", "public"], ["http://[::ffff:8.8.8.8]", "public"],
    ["http://[64:ff9b::7f00:1]", "public"], ["http://[2002:7f00:1::1]", "public"], ["http://[fec0::1]", "public"], ["http://[fb00::1]", "public"], ["http://[fe00::1]", "public"],
    ["http://ollama", "internal"], ["http://ollama.internal", "internal"], ["http://box.local", "internal"], ["http://a.b.lan", "internal"], ["http://x.home.arpa", "internal"],
    ["http://svc.ns.svc", "internal"], ["http://svc.ns.svc.cluster.local", "internal"], ["http://a.localhost", "internal"], ["http://nas.localdomain", "internal"],
    ["http://local.rt.invalid", "unroutable"], ["http://invalid", "unroutable"],
    ["http://llm.example-vendor.com", "public"], ["http://localhost.example.com", "public"], ["http://127.0.0.1.nip.io", "public"], ["http://internal.example.com", "public"],
    ["http://notlocal", "internal"], ["http://evil.com.local.example.com", "public"], ["http://local", "internal"],
  ])("%s → %s", (url, expected) => {
    expect(classifyHost(host(url))).toBe(expected);
  });

  it("userinfo and backslash tricks resolve to the real host, not the decoy", () => {
    expect(classifyHost(host("http://127.0.0.1@evil.example.com/"))).toBe("public");
    expect(classifyHost(host("http://127.0.0.1:80@8.8.8.8/"))).toBe("public");
    expect(classifyHost(host("http://evil.example.com\\@127.0.0.1/"))).toBe("public");
    expect(classifyHost(host("http://evil.example.com#@127.0.0.1/"))).toBe("public");
    expect(classifyHost(host("http://127.0.0.1\\@evil.example.com/"))).toBe("loopback"); // WHATWG: backslash ends the authority; the host really is 127.0.0.1
  });

  it("empty and malformed input is never local", () => {
    expect(classifyHost("")).toBe("public");
    expect(classifyHost("[::1")).not.toBe("loopback");
    expect(classifyHost("::1::1")).toBe("public");
    expect(classifyHost("fe80::1%eth0")).toBe("public");
  });

  it("normalizeHost strips brackets, case and one trailing dot", () => {
    expect(normalizeHost("[::1]")).toBe("::1");
    expect(normalizeHost("Ollama.Internal.")).toBe("ollama.internal");
  });
});

describe("needsResolutionCheck", () => {
  it("is true only for internal NAMES whose address DNS decides", () => {
    for (const u of ["http://ollama", "http://box.local", "http://x.svc.cluster.local", "http://a.localhost"]) expect(needsResolutionCheck(host(u))).toBe(true);
    for (const u of ["http://127.0.0.1", "http://localhost", "http://[::1]", "http://10.0.0.5", "http://[fd00::5]", "http://local.rt.invalid", "http://api.example.com"]) expect(needsResolutionCheck(host(u))).toBe(false);
  });
});

describe("parseAllowedHosts", () => {
  it("accepts exact hosts and IP literals; drops wildcards, ports, schemes, paths and userinfo", () => {
    const set = parseAllowedHosts("Ollama.Internal., 10.0.0.5  [fd00::5] *.corp.lan box.lan:11434 http://x.lan a.lan/path u@h.lan");
    expect([...set].sort()).toEqual(["10.0.0.5", "fd00::5", "ollama.internal"]);
    expect(parseAllowedHosts(undefined).size).toBe(0);
    expect(parseAllowedHosts("").size).toBe(0);
  });
});

describe("createResolvedAddressGuard", () => {
  const guard = (addrs: string[] | Error) => createResolvedAddressGuard(async () => { if (addrs instanceof Error) throw addrs; return addrs; });
  it("passes only when every resolved address is loopback or private", async () => {
    expect(await guard(["10.0.0.5"])("ollama")).toBe(true);
    expect(await guard(["127.0.0.1", "::1"])("ollama")).toBe(true);
    expect(await guard(["fd00::5", "192.168.1.9"])("ollama")).toBe(true);
    expect(await guard(["::ffff:10.0.0.5"])("ollama")).toBe(true);
  });
  it("fails closed on any public address, a mix, an empty answer, or a resolver error", async () => {
    expect(await guard(["8.8.8.8"])("ollama")).toBe(false);
    expect(await guard(["10.0.0.5", "8.8.8.8"])("ollama")).toBe(false);
    expect(await guard(["::ffff:8.8.8.8"])("ollama")).toBe(false);
    expect(await guard(["2001:4860:4860::8888"])("ollama")).toBe(false);
    expect(await guard(["0.0.0.0"])("ollama")).toBe(false);
    expect(await guard([])("ollama")).toBe(false);
    expect(await guard(new Error("ENOTFOUND"))("ollama")).toBe(false);
  });
});
