-- PROPOSAL ONLY. Not in drizzle/meta/_journal.json, not applied anywhere, not referenced by drizzle-kit.
-- Review, then (with explicit owner approval) move into drizzle/ with the next journal entry and apply with the normal migration flow.
-- Purely additive: three new tables, no change to any existing table. Rollback: DROP TABLE sentinelAudit; DROP TABLE sentinelEvents; DROP TABLE sentinelInvestigations;
--
-- Design: sentinelEvents is the durable source of truth (append-only, hash-chained per investigation: prev/hash). Everything the UI shows and the
-- row summary on sentinelInvestigations are derived from it. workspaceId is repeated on every event row so that reads can be scoped
-- without a join, and every store query filters by it (tenant isolation).
-- sentinelAudit has no FK on purpose: audit rows are retained after an investigation is deleted (accountability).
-- Writers are serialised per investigation with SELECT ... FOR UPDATE on the sentinelInvestigations row (see store.mysql.ts); InnoDB is required.

CREATE TABLE `sentinelInvestigations` (
  `id` char(36) NOT NULL,
  `workspaceId` int NOT NULL,
  `createdByUserId` int NOT NULL,
  `taskId` char(36),
  `title` varchar(200) NOT NULL,
  `severity` enum('low','medium','high','critical') NOT NULL,
  `service` varchar(120) NOT NULL,
  `firedAt` varchar(40) NOT NULL,
  `description` text NOT NULL,
  `objective` text NOT NULL,
  `specJson` mediumtext NOT NULL,
  `status` enum('QUEUED','RUNNING','COMPLETED','ABSTAINED','FAILED','CANCELLED') NOT NULL DEFAULT 'QUEUED',
  `stopReason` varchar(64),
  `outcome` enum('DIAGNOSIS','ABSTAIN'),
  `label` varchar(64),
  `confidence` double,
  `verified` boolean,
  `traceHead` char(64),
  `eventCount` int NOT NULL DEFAULT 0,
  `errorMessage` varchar(500),
  `createdAt` datetime(3) NOT NULL,
  `updatedAt` datetime(3) NOT NULL,
  `startedAt` datetime(3),
  `finishedAt` datetime(3),
  CONSTRAINT `sentinelInvestigations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `sentinelInvestigations_workspace_created_idx` ON `sentinelInvestigations` (`workspaceId`,`createdAt`);
--> statement-breakpoint
CREATE INDEX `sentinelInvestigations_workspace_status_idx` ON `sentinelInvestigations` (`workspaceId`,`status`,`createdAt`);
--> statement-breakpoint
CREATE INDEX `sentinelInvestigations_task_idx` ON `sentinelInvestigations` (`taskId`);
--> statement-breakpoint
CREATE TABLE `sentinelEvents` (
  `investigationId` char(36) NOT NULL,
  `workspaceId` int NOT NULL,
  `seq` int NOT NULL,
  `type` varchar(48) NOT NULL,
  `vt` double NOT NULL,
  `payloadJson` mediumtext NOT NULL,
  `prev` char(64) NOT NULL,
  `hash` char(64) NOT NULL,
  `createdAt` datetime(3) NOT NULL,
  CONSTRAINT `sentinelEvents_investigationId_seq_pk` PRIMARY KEY(`investigationId`,`seq`)
);
--> statement-breakpoint
CREATE INDEX `sentinelEvents_workspace_idx` ON `sentinelEvents` (`workspaceId`,`investigationId`,`seq`);
--> statement-breakpoint
CREATE TABLE `sentinelAudit` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `investigationId` char(36) NOT NULL,
  `workspaceId` int NOT NULL,
  `actorUserId` int NOT NULL,
  `action` enum('CREATE','CANCEL_REQUESTED','EXPORT_REPORT','DELETE') NOT NULL,
  `detail` varchar(500),
  `createdAt` datetime(3) NOT NULL,
  CONSTRAINT `sentinelAudit_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `sentinelAudit_investigation_idx` ON `sentinelAudit` (`workspaceId`,`investigationId`,`id`);
