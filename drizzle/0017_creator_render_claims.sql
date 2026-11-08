-- Additive, review-only until the Creator render dispatcher is deliberately integrated.
-- MySQL/InnoDB uniqueness is the cross-process serialization boundary.
CREATE TABLE `creatorRenderClaims` (
  `id` int AUTO_INCREMENT NOT NULL,
  `workspaceId` int NOT NULL,
  `creatorProjectId` int NOT NULL,
  `timelineId` int NOT NULL,
  `mode` enum('MASTER_CANDIDATE','VERTICAL_DERIVATIVE') NOT NULL,
  `fingerprint` char(64) NOT NULL,
  `leaseToken` char(36) NOT NULL,
  `leaseUntil` datetime(3) NOT NULL,
  `state` enum('RUNNING','SUCCEEDED','NEEDS_RECONCILIATION') NOT NULL DEFAULT 'RUNNING',
  `exportId` int,
  `outputAssetId` int,
  `outputChecksumSha256` char(64),
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `completedAt` timestamp NULL,
  CONSTRAINT `creatorRenderClaims_id_pk` PRIMARY KEY (`id`),
  CONSTRAINT `creatorRenderClaims_scope_fingerprint_uq` UNIQUE (`workspaceId`,`creatorProjectId`,`timelineId`,`mode`,`fingerprint`)
);
--> statement-breakpoint
CREATE INDEX `creatorRenderClaims_state_lease_idx` ON `creatorRenderClaims` (`state`,`leaseUntil`);
