CREATE TABLE `creatorRemediationLineage` (
  `id` int NOT NULL AUTO_INCREMENT,
  `workspaceId` int NOT NULL,
  `creatorProjectId` int NOT NULL,
  `timelineId` int NOT NULL,
  `sourceCandidateAssetId` int NOT NULL,
  `sourceQualityReviewId` int NOT NULL,
  `sourceChecksumSha256` char(64) NOT NULL,
  `replacementCandidateAssetId` int NOT NULL,
  `replacementChecksumSha256` char(64) NOT NULL,
  `createdByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `creatorRemediationLineage_id_pk` PRIMARY KEY (`id`),
  CONSTRAINT `creatorRemediationLineage_source_review_uq` UNIQUE (`sourceQualityReviewId`),
  CONSTRAINT `creatorRemediationLineage_replacement_uq` UNIQUE (`replacementCandidateAssetId`)
);
--> statement-breakpoint
CREATE INDEX `creatorRemediationLineage_scope_idx` ON `creatorRemediationLineage` (`workspaceId`, `creatorProjectId`, `timelineId`);
