CREATE TABLE `durableTasks` (
  `id` char(36) NOT NULL,
  `workspaceId` int NOT NULL,
  `createdByUserId` int,
  `type` varchar(96) NOT NULL,
  `state` enum('QUEUED','RUNNING','WAITING','SUCCEEDED','FAILED','CANCELLED') NOT NULL DEFAULT 'QUEUED',
  `idempotencyKey` varchar(128),
  `inputHash` char(64) NOT NULL,
  `inputJson` text NOT NULL,
  `checkpointJson` text,
  `checkpointSeq` int NOT NULL DEFAULT 0,
  `progressPercent` int,
  `progressNote` varchar(255),
  `resultJson` text,
  `attempt` int NOT NULL DEFAULT 0,
  `maxAttempts` int NOT NULL DEFAULT 3,
  `retryAfter` datetime(3),
  `leaseOwner` varchar(96),
  `leaseExpiresAt` datetime(3),
  `cancelRequested` boolean NOT NULL DEFAULT false,
  `failureClass` enum('RETRYABLE','NON_RETRYABLE','PROVIDER_UNAVAILABLE','BUDGET_DENIED','POLICY_DENIED','LEASE_EXPIRED','INTERNAL'),
  `errorMessage` varchar(500),
  `createdAt` datetime(3) NOT NULL,
  `updatedAt` datetime(3) NOT NULL,
  `startedAt` datetime(3),
  `finishedAt` datetime(3),
  CONSTRAINT `durableTasks_id` PRIMARY KEY(`id`),
  CONSTRAINT `durableTasks_workspace_idempotency_uq` UNIQUE(`workspaceId`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE INDEX `durableTasks_state_retry_idx` ON `durableTasks` (`state`,`retryAfter`,`createdAt`);
--> statement-breakpoint
CREATE INDEX `durableTasks_workspace_created_idx` ON `durableTasks` (`workspaceId`,`createdAt`);
--> statement-breakpoint
CREATE TABLE `durableTaskEffects` (
  `taskId` char(36) NOT NULL,
  `effectKey` varchar(128) NOT NULL,
  `resultJson` text,
  `createdAt` datetime(3) NOT NULL,
  CONSTRAINT `durableTaskEffects_taskId_effectKey_pk` PRIMARY KEY(`taskId`,`effectKey`)
);
