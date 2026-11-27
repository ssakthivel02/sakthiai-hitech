ALTER TABLE `documentChunks` ADD COLUMN `searchText` text;
--> statement-breakpoint
CREATE INDEX `documentChunks_documentId_chunkIndex_idx` ON `documentChunks` (`documentId`,`chunkIndex`);
--> statement-breakpoint
CREATE INDEX `documents_workspaceId_createdAt_idx` ON `documents` (`workspaceId`,`createdAt`);
--> statement-breakpoint
CREATE INDEX `documents_storageKey_idx` ON `documents` (`storageKey`(191));
--> statement-breakpoint
CREATE INDEX `creatorAssets_storageKey_idx` ON `creatorAssets` (`storageKey`(191));
--> statement-breakpoint
CREATE INDEX `messages_workspaceId_conversationId_createdAt_idx` ON `messages` (`workspaceId`,`conversationId`,`createdAt`);
--> statement-breakpoint
CREATE INDEX `workspaceMembers_userId_workspaceId_idx` ON `workspaceMembers` (`userId`,`workspaceId`);
--> statement-breakpoint
CREATE INDEX `projects_workspaceId_idx` ON `projects` (`workspaceId`);
