ALTER TABLE `creatorArtifactLeases` ADD COLUMN `stagedStorageKey` varchar(600);
--> statement-breakpoint
ALTER TABLE `creatorArtifactLeases` ADD COLUMN `stagedChecksumSha256` char(64);
--> statement-breakpoint
ALTER TABLE `creatorArtifactLeases` ADD COLUMN `stagedByteSize` int;
--> statement-breakpoint
ALTER TABLE `creatorArtifactLeases` ADD COLUMN `stagedMimeType` varchar(100);
