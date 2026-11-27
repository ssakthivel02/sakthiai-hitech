CREATE TABLE `creatorAvatarDispatchAdmissions` (
  `generationId` int NOT NULL,
  `workspaceId` int NOT NULL,
  `consentId` int NOT NULL,
  `callbackId` varchar(64) NOT NULL,
  `admittedAt` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT `creatorAvatarDispatchAdmissions_generation_pk` PRIMARY KEY (`generationId`),
  CONSTRAINT `creatorAvatarDispatchAdmissions_workspace_callback_uq` UNIQUE (`workspaceId`, `callbackId`)
);
--> statement-breakpoint
CREATE INDEX `creatorAvatarDispatchAdmissions_consent_idx` ON `creatorAvatarDispatchAdmissions` (`workspaceId`, `consentId`);
