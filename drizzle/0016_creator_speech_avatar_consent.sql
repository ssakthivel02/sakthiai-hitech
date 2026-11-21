ALTER TABLE `creatorGenerations` MODIFY COLUMN `kind` enum('IMAGE','IMAGE_EDIT','VIDEO','VIDEO_EXTENSION','SPEECH','AVATAR_VIDEO') NOT NULL;
--> statement-breakpoint
ALTER TABLE `creatorReviews` MODIFY COLUMN `reviewType` enum('QUALITY','HUMAN_TAMIL','HUMAN_VISUAL','HUMAN_SPEECH') NOT NULL;
--> statement-breakpoint
CREATE TABLE `creatorConsents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `workspaceId` int NOT NULL,
  `purpose` enum('avatar_video','custom_voice') NOT NULL,
  `provider` varchar(80) NOT NULL,
  `providerSubjectId` varchar(128) NOT NULL,
  `evidenceReference` varchar(500) NOT NULL,
  `grantedByUserId` int NOT NULL,
  `validUntil` timestamp NULL,
  `revokedAt` timestamp NULL,
  `revokedByUserId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `creatorConsents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `creatorConsents_workspace_subject_idx` ON `creatorConsents` (`workspaceId`,`provider`,`providerSubjectId`,`purpose`);
