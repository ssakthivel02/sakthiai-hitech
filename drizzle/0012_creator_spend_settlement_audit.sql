ALTER TABLE `creatorSpendHolds` ADD COLUMN `settledBy` varchar(64);
--> statement-breakpoint
ALTER TABLE `creatorSpendHolds` ADD COLUMN `settlementNote` varchar(255);
