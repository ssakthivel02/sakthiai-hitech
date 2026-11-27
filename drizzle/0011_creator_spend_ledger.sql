CREATE TABLE `creatorSpendWindows` (
  `scope` varchar(64) NOT NULL,
  `windowStart` date NOT NULL,
  `generations` int NOT NULL DEFAULT 0,
  `cost` decimal(18,6) NOT NULL DEFAULT 0,
  CONSTRAINT `creatorSpendWindows_scope_windowStart_pk` PRIMARY KEY(`scope`,`windowStart`)
);
--> statement-breakpoint
CREATE TABLE `creatorSpendHolds` (
  `id` varchar(96) NOT NULL,
  `workspaceId` int NOT NULL,
  `userId` int NOT NULL,
  `generationId` int,
  `kind` varchar(16) NOT NULL,
  `model` varchar(128) NOT NULL,
  `windowStart` date NOT NULL,
  `cost` decimal(18,6) NOT NULL DEFAULT 0,
  `state` enum('HELD','COMMITTED','RELEASED') NOT NULL DEFAULT 'HELD',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `settledAt` timestamp NULL,
  CONSTRAINT `creatorSpendHolds_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `creatorSpendHolds_state_createdAt_idx` ON `creatorSpendHolds` (`state`,`createdAt`);
--> statement-breakpoint
CREATE INDEX `creatorSpendHolds_workspaceId_createdAt_idx` ON `creatorSpendHolds` (`workspaceId`,`createdAt`);
