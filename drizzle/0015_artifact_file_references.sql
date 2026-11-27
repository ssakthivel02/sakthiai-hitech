CREATE TABLE `artifactFileReferences` (
  `id` int AUTO_INCREMENT NOT NULL,
  `workspaceId` int NOT NULL,
  `artifactId` int NOT NULL,
  `documentId` int NOT NULL,
  `addedByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `artifactFileReferences_id` PRIMARY KEY(`id`),
  CONSTRAINT `artifactFileReferences_artifact_document_uq` UNIQUE(`artifactId`,`documentId`)
);
--> statement-breakpoint
CREATE INDEX `artifactFileReferences_workspace_document_idx` ON `artifactFileReferences` (`workspaceId`,`documentId`);
