CREATE TABLE `conversations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`userId` int NOT NULL,
	`title` varchar(180) NOT NULL,
	`language` enum('en','ta') NOT NULL DEFAULT 'en',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `conversations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `documentChunks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`documentId` int NOT NULL,
	`workspaceId` int NOT NULL,
	`chunkIndex` int NOT NULL,
	`page` int,
	`content` text NOT NULL,
	CONSTRAINT `documentChunks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `documents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`projectId` int,
	`filename` varchar(255) NOT NULL,
	`mimeType` varchar(160) NOT NULL,
	`storageKey` text,
	`extractedText` text NOT NULL,
	`pageCount` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `documents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`conversationId` int NOT NULL,
	`workspaceId` int NOT NULL,
	`role` enum('user','assistant','system') NOT NULL,
	`content` text NOT NULL,
	`citationsJson` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `messages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`name` varchar(180) NOT NULL,
	`description` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `projects_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `workspaceMembers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`userId` int NOT NULL,
	`role` enum('owner','member') NOT NULL DEFAULT 'member',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspaceMembers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`name` varchar(160) NOT NULL,
	`slug` varchar(180) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspaces_id` PRIMARY KEY(`id`),
	CONSTRAINT `workspaces_slug_unique` UNIQUE(`slug`)
);
