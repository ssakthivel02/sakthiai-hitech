# OAuth login transactions (multi-instance)

`startLogin()` now calls `POST /api/oauth/begin` with the S256 PKCE challenge. The server generates the nonce (32 random bytes), stores only SHA-256 digests of nonce and challenge in `oauthLoginTransactions` (migration 0007) with a 10-minute database-clock expiry, and returns the nonce, which the client places in the existing `__Host-` state cookie. The callback (existing nonce-cookie, PKCE and redirect checks unchanged) then consumes the transaction with a single conditional `UPDATE ... WHERE nonceHash=? AND challengeHash=? AND consumedAt IS NULL AND expiresAt > NOW(3)`; exactly one concurrent callback can win, on any instance.

Fail-closed behaviour: unknown/forged nonce, wrong challenge, expired, replayed or malformed -> 403; store unreachable -> 503 (no session, no detail). `begin` is rate limited per client IP as seen by Express (600/min; behind a proxy without trust-proxy that is effectively a shared flood guard; in-process) and answers 503 if the store is down. Rows expired for more than 60 s are deleted every 5 minutes; live transactions are never removed.
Deploy: apply migration 0007 BEFORE the new build, otherwise logins answer 503 (safe). Without `DATABASE_URL` a process-local store is used (development/tests only).
Not claimed: distributed rate limiting for `begin`; real IdP.
