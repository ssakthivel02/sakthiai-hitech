CREATE TABLE `creatorProjects` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`projectId` int,
	`name` varchar(180) NOT NULL,
	`status` enum('DRAFT','ACTIVE','APPROVAL_LOCKED','ARCHIVED') NOT NULL DEFAULT 'DRAFT',
	`canonicalLyrics` text,
	`lyricsApprovedAt` timestamp,
	`audioMasterAssetId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `creatorProjects_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `creatorScenes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`creatorProjectId` int NOT NULL,
	`sceneIndex` int NOT NULL,
	`title` varchar(180) NOT NULL,
	`startMs` int,
	`endMs` int,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `creatorScenes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `creatorShots` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`creatorProjectId` int NOT NULL,
	`sceneId` int NOT NULL,
	`shotIndex` int NOT NULL,
	`title` varchar(180) NOT NULL,
	`prompt` text,
	`startMs` int,
	`endMs` int,
	`status` enum('PLANNED','GENERATING','READY','REVIEW','APPROVED','REJECTED') NOT NULL DEFAULT 'PLANNED',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `creatorShots_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `creatorAssets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`creatorProjectId` int NOT NULL,
	`sceneId` int,
	`shotId` int,
	`assetType` enum('REFERENCE','IMAGE','VIDEO','AUDIO_MASTER','AUDIO','SUBTITLE','RENDER','OTHER') NOT NULL,
	`mimeType` varchar(160) NOT NULL,
	`storageKey` text NOT NULL,
	`checksumSha256` varchar(64) NOT NULL,
	`byteSize` int,
	`immutable` int NOT NULL DEFAULT 0,
	`provenanceJson` text NOT NULL,
	`reviewDecision` enum('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `creatorAssets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `creatorReferences` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`creatorProjectId` int NOT NULL,
	`assetId` int NOT NULL,
	`kind` enum('CHARACTER','STYLE','LOCATION','OBJECT') NOT NULL,
	`label` varchar(180) NOT NULL,
	`immutable` int NOT NULL DEFAULT 1,
	`approvedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `creatorReferences_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `creatorGenerations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`creatorProjectId` int NOT NULL,
	`sceneId` int,
	`shotId` int,
	`kind` enum('IMAGE','IMAGE_EDIT','VIDEO','VIDEO_EXTENSION') NOT NULL,
	`provider` varchar(80) NOT NULL,
	`model` varchar(160) NOT NULL,
	`parametersJson` text NOT NULL,
	`sourceAssetIdsJson` text,
	`status` enum('QUEUED','SUBMITTED','RUNNING','SUCCEEDED','FAILED','CANCELLED','RETRYABLE') NOT NULL DEFAULT 'QUEUED',
	`outputAssetId` int,
	`attempt` int NOT NULL DEFAULT 1,
	`failureClass` varchar(80),
	`errorMessage` text,
	`costMicros` int,
	`currency` varchar(3),
	`latencyMs` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`completedAt` timestamp,
	CONSTRAINT `creatorGenerations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `creatorProviderJobs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`creatorProjectId` int NOT NULL,
	`generationId` int NOT NULL,
	`provider` varchar(80) NOT NULL,
	`providerJobId` varchar(512) NOT NULL,
	`status` enum('SUBMITTED','RUNNING','SUCCEEDED','FAILED','CANCELLED','RETRYABLE') NOT NULL DEFAULT 'SUBMITTED',
	`snapshotJson` text,
	`failureClass` varchar(80),
	`costMicros` int,
	`currency` varchar(3),
	`latencyMs` int,
	`submittedAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`completedAt` timestamp,
	CONSTRAINT `creatorProviderJobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `creatorTimelines` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`creatorProjectId` int NOT NULL,
	`name` varchar(180) NOT NULL,
	`audioMasterAssetId` int,
	`width` int NOT NULL DEFAULT 1920,
	`height` int NOT NULL DEFAULT 1080,
	`fps` int NOT NULL DEFAULT 24,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `creatorTimelines_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `creatorTimelineItems` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`creatorProjectId` int NOT NULL,
	`timelineId` int NOT NULL,
	`shotId` int,
	`assetId` int NOT NULL,
	`track` int NOT NULL DEFAULT 1,
	`sortOrder` int NOT NULL DEFAULT 0,
	`startMs` int NOT NULL,
	`endMs` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `creatorTimelineItems_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `creatorCaptionCues` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`creatorProjectId` int NOT NULL,
	`timelineId` int NOT NULL,
	`language` enum('ta','en') NOT NULL DEFAULT 'ta',
	`startMs` int NOT NULL,
	`endMs` int NOT NULL,
	`text` text NOT NULL,
	`locked` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `creatorCaptionCues_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `creatorReviews` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`creatorProjectId` int NOT NULL,
	`generationId` int,
	`shotId` int,
	`assetId` int,
	`reviewType` enum('QUALITY','HUMAN_TAMIL','HUMAN_VISUAL') NOT NULL,
	`decision` enum('PENDING','PASS','ASSISTED_HUMAN_REVIEW','REGENERATE','REJECT') NOT NULL DEFAULT 'PENDING',
	`reviewerUserId` int,
	`scoresJson` text,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `creatorReviews_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `creatorExports` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`creatorProjectId` int NOT NULL,
	`timelineId` int NOT NULL,
	`assetId` int,
	`status` enum('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED') NOT NULL DEFAULT 'QUEUED',
	`width` int NOT NULL DEFAULT 1920,
	`height` int NOT NULL DEFAULT 1080,
	`format` varchar(32) NOT NULL DEFAULT 'mp4',
	`renderer` varchar(80) NOT NULL DEFAULT 'ffmpeg',
	`parametersJson` text,
	`checksumSha256` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	CONSTRAINT `creatorExports_id` PRIMARY KEY(`id`)
);
