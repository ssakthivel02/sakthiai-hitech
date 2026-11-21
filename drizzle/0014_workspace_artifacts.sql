CREATE TABLE `artifacts` (
  `id` int AUTO_INCREMENT NOT NULL,
  `workspaceId` int NOT NULL,
  `projectId` int,
  `createdByUserId` int NOT NULL,
  `kind` varchar(32) NOT NULL DEFAULT 'chat_answer',
  `title` varchar(180) NOT NULL,
  `language` enum('en','ta') NOT NULL DEFAULT 'en',
  `content` mediumtext NOT NULL,
  `contentHash` char(64) NOT NULL,
  `citationsJson` text,
  `sourceConversationId` int,
  `sourceMessageId` int,
  `searchText` mediumtext NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `artifacts_id` PRIMARY KEY(`id`),
  CONSTRAINT `artifacts_workspace_source_message_uq` UNIQUE(`workspaceId`,`sourceMessageId`)
);
--> statement-breakpoint
CREATE INDEX `artifacts_workspace_updated_idx` ON `artifacts` (`workspaceId`,`updatedAt`);
--> statement-breakpoint
CREATE INDEX `artifacts_workspace_project_idx` ON `artifacts` (`workspaceId`,`projectId`);
