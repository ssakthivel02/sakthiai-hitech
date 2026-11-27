CREATE TABLE `oauthLoginTransactions` (
  `nonceHash` char(64) NOT NULL,
  `challengeHash` char(64) NOT NULL,
  `createdAt` datetime(3) NOT NULL,
  `expiresAt` datetime(3) NOT NULL,
  `consumedAt` datetime(3),
  CONSTRAINT `oauthLoginTransactions_nonceHash` PRIMARY KEY(`nonceHash`)
);
--> statement-breakpoint
CREATE INDEX `oauthLoginTransactions_expiresAt_idx` ON `oauthLoginTransactions` (`expiresAt`);
