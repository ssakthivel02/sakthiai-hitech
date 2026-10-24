-- PROPOSAL ONLY: not in drizzle/meta/_journal.json, not applied by `pnpm db:push`, not part of drizzle/schema.ts
-- (so /readyz schema checks and the 0011/0012 migration review are unchanged).
-- Shared fixed-window counters for the authenticated request limiter when RATE_LIMIT_STORE=mysql.
-- Additive, no foreign keys, no user content: the key is "<policy>:user:<id>". Rows expire and are pruned by the app.
-- To adopt: owner approval, then move into drizzle/ with the next journal number and add the table to schema.ts.
-- Rollback: DROP TABLE `rateLimitWindows`; (counters only; dropping loses at most one window of counts).
CREATE TABLE `rateLimitWindows` (
  `bucketKey` varchar(191) NOT NULL,
  `windowStart` bigint NOT NULL,
  `count` int NOT NULL DEFAULT 0,
  `expiresAt` bigint NOT NULL,
  CONSTRAINT `rateLimitWindows_bucketKey` PRIMARY KEY(`bucketKey`)
);
--> statement-breakpoint
CREATE INDEX `rateLimitWindows_expiresAt_idx` ON `rateLimitWindows` (`expiresAt`);
