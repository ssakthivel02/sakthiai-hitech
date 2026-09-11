import { afterEach, describe, expect, it } from "vitest";
import type { Request } from "express";
import { getSessionCookieOptions } from "./cookies";

const originalNodeEnv = process.env.NODE_ENV;

function request(protocol: "http" | "https", forwardedProto?: string): Request {
  return {
    protocol,
    headers: forwardedProto ? { "x-forwarded-proto": forwardedProto } : {},
  } as unknown as Request;
}

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

describe("session cookie security contract", () => {
  it("uses HttpOnly host-only Lax session cookies", () => {
    process.env.NODE_ENV = "development";
    expect(getSessionCookieOptions(request("http"))).toEqual({
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: false,
    });
  });

  it("always marks production session cookies Secure", () => {
    process.env.NODE_ENV = "production";
    expect(getSessionCookieOptions(request("http")).secure).toBe(true);
  });

  it("marks a directly HTTPS development request Secure", () => {
    process.env.NODE_ENV = "development";
    expect(getSessionCookieOptions(request("https")).secure).toBe(true);
  });

  it("does not trust caller-controlled X-Forwarded-Proto as transport proof", () => {
    process.env.NODE_ENV = "development";
    expect(getSessionCookieOptions(request("http", "https")).secure).toBe(false);
  });
});
