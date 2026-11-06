import type { Request } from "express";

/**
 * Browser-facing pages for sign-in callback failures. The callback is a top-level browser navigation, so a raw JSON body
 * leaves the person on a blank page with no way forward. API clients (anything not asking for HTML) still get the JSON body.
 * Static, bilingual text only: no identity, token, provider detail or request input is ever rendered.
 */
export type SignInFailure = "not_authorized" | "link_invalid" | "unavailable" | "failed";

type Copy = { title: string; body: string; titleTa: string; bodyTa: string };
const COPY: Record<SignInFailure, Copy> = {
  not_authorized: {
    title: "This account is not approved for the private beta",
    body: "You signed in with your identity provider, but this account is not on the beta access list. No SakthiAI account or session was created. If you were invited, sign in with the same account the invitation was sent to, or ask the person who invited you.",
    titleTa: "இந்தக் கணக்கு தனியார் பீட்டாவுக்கு அனுமதிக்கப்படவில்லை",
    bodyTa: "நீங்கள் உங்கள் அடையாள வழங்குநரில் உள்நுழைந்தீர்கள்; ஆனால் இந்தக் கணக்கு பீட்டா அணுகல் பட்டியலில் இல்லை. SakthiAI கணக்கோ அமர்வோ உருவாக்கப்படவில்லை. உங்களுக்கு அழைப்பு வந்திருந்தால், அழைப்பு அனுப்பப்பட்ட அதே கணக்கில் உள்நுழையவும் அல்லது உங்களை அழைத்தவரிடம் கேட்கவும்.",
  },
  link_invalid: {
    title: "This sign-in link is no longer valid",
    body: "The sign-in took longer than 10 minutes, cookies were blocked, or the link was opened in a different browser. Nothing was changed. Start again from the home page.",
    titleTa: "இந்த உள்நுழைவு இணைப்பு இனி செல்லாது",
    bodyTa: "உள்நுழைவு 10 நிமிடங்களைத் தாண்டியது, cookies தடுக்கப்பட்டன, அல்லது இணைப்பு வேறு உலாவியில் திறக்கப்பட்டது. எதுவும் மாற்றப்படவில்லை. முகப்புப் பக்கத்திலிருந்து மீண்டும் தொடங்கவும்.",
  },
  unavailable: {
    title: "Sign-in is temporarily unavailable",
    body: "The service could not safely complete your sign-in right now. You are not signed in. Please try again in a minute.",
    titleTa: "உள்நுழைவு தற்காலிகமாகக் கிடைக்கவில்லை",
    bodyTa: "உங்கள் உள்நுழைவை இப்போது பாதுகாப்பாக முடிக்க இயலவில்லை. நீங்கள் உள்நுழையவில்லை. ஒரு நிமிடம் கழித்து மீண்டும் முயலவும்.",
  },
  failed: {
    title: "Sign-in could not be completed",
    body: "Something went wrong while finishing your sign-in. You are not signed in. Please try again. If it keeps happening, report it with the time it happened and the reference below.",
    titleTa: "உள்நுழைவை முடிக்க இயலவில்லை",
    bodyTa: "உள்நுழைவை முடிக்கும்போது ஏதோ தவறு நேர்ந்தது. நீங்கள் உள்நுழையவில்லை. மீண்டும் முயலவும். தொடர்ந்தால், நிகழ்ந்த நேரத்துடனும் கீழுள்ள குறிப்பு எண்ணுடனும் தெரிவிக்கவும்.",
  },
};

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** True only when the client explicitly prefers HTML (a browser navigation), never for fetch/curl/API consumers. */
export function prefersHtml(req: Pick<Request, "headers">): boolean {
  const accept = String(req.headers.accept ?? "");
  const html = accept.indexOf("text/html");
  if (html < 0) return false;
  const json = accept.indexOf("application/json");
  return json < 0 || html < json;
}

export function renderSignInFailurePage(kind: SignInFailure, requestId?: string): string {
  const c = COPY[kind];
  const ref = requestId && /^[A-Za-z0-9._-]{1,128}$/.test(requestId) ? `<small>Reference / குறிப்பு எண்: <code>${escapeHtml(requestId)}</code></small>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(c.title)} · SakthiAI</title>
<style>body{margin:0;font-family:system-ui,'Noto Sans Tamil',sans-serif;background:#f5f7f2;color:#172119}main{min-height:100vh;display:grid;place-items:center;padding:24px}.card{max-width:520px;background:#fff;border:1px solid #dfe5dc;border-radius:14px;padding:28px}h1{font-size:1.4rem;margin:0 0 10px}p{line-height:1.6;color:#3d4a40}a{display:inline-block;margin-top:14px;padding:11px 18px;border-radius:8px;background:#173b2e;color:#fff;text-decoration:none}a:focus-visible{outline:3px solid #ccff5b;outline-offset:2px}small{display:block;margin-top:18px;color:#6b786d}hr{border:0;border-top:1px solid #dfe5dc;margin:18px 0}</style></head>
<body><main><div class="card" role="alert"><h1>${escapeHtml(c.title)}</h1><p>${escapeHtml(c.body)}</p><hr><h1 lang="ta">${escapeHtml(c.titleTa)}</h1><p lang="ta">${escapeHtml(c.bodyTa)}</p><a href="/">Back to sign-in · உள்நுழைவுக்குத் திரும்புக</a>${ref}</div></main></body></html>`;
}
