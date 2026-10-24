CREATE TABLE `rateLimitWindows` (
  `bucketKey` varchar(191) NOT NULL,
  `windowStart` bigint NOT NULL,
  `count` int NOT NULL DEFAULT 0,
  `expiresAt` bigint NOT NULL,
  CONSTRAINT `rateLimitWindows_bucketKey` PRIMARY KEY(`bucketKey`)
);
--> statement-breakpoint
CREATE INDEX `rateLimitWindows_expiresAt_idx` ON `rateLimitWindows` (`expiresAt`);
