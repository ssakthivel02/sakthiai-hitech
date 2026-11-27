ALTER TABLE `creatorGenerations`
  ADD COLUMN `idempotencyKey` varchar(64),
  MODIFY COLUMN `status` enum('QUEUED','SUBMISSION_UNKNOWN','SUBMITTED','RUNNING','SUCCEEDED','FAILED','CANCELLED','RETRYABLE') NOT NULL DEFAULT 'QUEUED',
  ADD CONSTRAINT `creatorGenerations_workspaceId_idempotencyKey_unique` UNIQUE(`workspaceId`,`idempotencyKey`);
