CREATE TABLE `fileUploadSessions` (
  `id` char(36) NOT NULL,
  `workspaceId` int NOT NULL,
  `userId` int NOT NULL,
  `projectId` int,
  `filename` varchar(255) NOT NULL,
  `mimeType` varchar(160) NOT NULL,
  `declaredBytes` int NOT NULL,
  `declaredSha256` char(64) NOT NULL,
  `chunkSize` int NOT NULL,
  `totalChunks` int NOT NULL,
  `state` enum('OPEN','FINALIZING','COMPLETED','REJECTED','EXPIRED','ABORTED') NOT NULL DEFAULT 'OPEN',
  `rejectReason` varchar(64),
  `lastError` varchar(160),
  `scanStatus` varchar(16),
  `scanEngine` varchar(32),
  `documentId` int,
  `createdAt` datetime(3) NOT NULL,
  `updatedAt` datetime(3) NOT NULL,
  `expiresAt` datetime(3) NOT NULL,
  CONSTRAINT `fileUploadSessions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `fileUploadSessions_workspace_state_idx` ON `fileUploadSessions` (`workspaceId`,`state`);
--> statement-breakpoint
CREATE INDEX `fileUploadSessions_state_expires_idx` ON `fileUploadSessions` (`state`,`expiresAt`);
--> statement-breakpoint
CREATE TABLE `fileUploadChunks` (
  `uploadId` char(36) NOT NULL,
  `chunkIndex` int NOT NULL,
  `bytes` int NOT NULL,
  `sha256` char(64) NOT NULL,
  `data` mediumblob NOT NULL,
  CONSTRAINT `fileUploadChunks_uploadId_chunkIndex` PRIMARY KEY(`uploadId`,`chunkIndex`)
);
