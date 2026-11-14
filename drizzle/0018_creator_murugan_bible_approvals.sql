CREATE TABLE `creatorMuruganBibleApprovals` (
  `id` int AUTO_INCREMENT NOT NULL,
  `workspaceId` int NOT NULL,
  `creatorProjectId` int NOT NULL,
  `bibleId` varchar(120) NOT NULL,
  `contentSha256` varchar(64) NOT NULL,
  `contentJson` text NOT NULL,
  `approvedByUserId` int NOT NULL,
  `approvedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `revokedAt` timestamp NULL,
  `revokedByUserId` int NULL,
  CONSTRAINT `creatorMuruganBibleApprovals_id` PRIMARY KEY(`id`),
  CONSTRAINT `creatorMuruganBibleApprovals_identity_uq` UNIQUE (`workspaceId`,`creatorProjectId`,`bibleId`)
);
