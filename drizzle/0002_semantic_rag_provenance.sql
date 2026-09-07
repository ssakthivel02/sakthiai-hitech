ALTER TABLE `documents` ADD COLUMN `contentHash` varchar(64) NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `documentChunks` ADD COLUMN `section` varchar(500);
--> statement-breakpoint
ALTER TABLE `documentChunks` ADD COLUMN `paragraph` int;
--> statement-breakpoint
ALTER TABLE `documentChunks` ADD COLUMN `sourceStart` int;
--> statement-breakpoint
ALTER TABLE `documentChunks` ADD COLUMN `sourceEnd` int;
--> statement-breakpoint
ALTER TABLE `documentChunks` ADD COLUMN `embeddingJson` text;
--> statement-breakpoint
ALTER TABLE `documentChunks` ADD COLUMN `embeddingModel` varchar(160);
--> statement-breakpoint
CREATE INDEX `documents_workspace_hash_idx` ON `documents` (`workspaceId`,`contentHash`);
--> statement-breakpoint
CREATE INDEX `chunks_workspace_document_idx` ON `documentChunks` (`workspaceId`,`documentId`);
