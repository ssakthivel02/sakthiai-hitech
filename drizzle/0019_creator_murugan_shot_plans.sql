CREATE TABLE `creatorMuruganShotPlans` (
  `id` int AUTO_INCREMENT NOT NULL,
  `workspaceId` int NOT NULL,
  `creatorProjectId` int NOT NULL,
  `planId` varchar(64) NOT NULL,
  `contentSha256` varchar(64) NOT NULL,
  `snapshotJson` text NOT NULL,
  `approvedByUserId` int NOT NULL,
  `approvedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `revokedAt` timestamp NULL,
  `revokedByUserId` int NULL,
  CONSTRAINT `creatorMuruganShotPlans_id` PRIMARY KEY(`id`),
  CONSTRAINT `creatorMuruganShotPlans_identity_uq` UNIQUE (`workspaceId`,`creatorProjectId`,`contentSha256`)
);
