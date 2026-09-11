import type { CookieOptions, Request } from "express";

/**
 * Session cookies are same-site application cookies. The OAuth authorization
 * response returns through a top-level GET callback, so SameSite=Lax preserves
 * the login flow without exposing the long-lived session cookie to general
 * cross-site subrequests.
 *
 * Production always emits Secure cookies. In development/test, HTTPS requests
 * also receive Secure cookies, but caller-controlled forwarding headers are not
 * trusted as transport evidence.
 */
export function getSessionCookieOptions(
  req: Request
): Pick<CookieOptions, "httpOnly" | "path" | "sameSite" | "secure"> {
  const production = process.env.NODE_ENV === "production";

  return {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: production || req.protocol === "https",
  };
}
