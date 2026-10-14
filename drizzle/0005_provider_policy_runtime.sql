CREATE TABLE `providerWorkspacePolicies` (
  `workspaceId` int NOT NULL,
  `externalEnabled` boolean NOT NULL DEFAULT false,
  `meteredEnabled` boolean NOT NULL DEFAULT false,
  `maxRequestsPerDay` bigint,
  `maxTokensPerDay` bigint,
  `maxCostPerDay` decimal(18,6),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `providerWorkspacePolicies_workspaceId` PRIMARY KEY(`workspaceId`)
);
--> statement-breakpoint
CREATE TABLE `providerUsageWindows` (
  `workspaceId` int NOT NULL,
  `windowStart` date NOT NULL,
  `requests` bigint NOT NULL DEFAULT 0,
  `tokens` bigint NOT NULL DEFAULT 0,
  `cost` decimal(18,6) NOT NULL DEFAULT 0,
  `estimatedCommits` bigint NOT NULL DEFAULT 0,
  CONSTRAINT `providerUsageWindows_workspaceId_windowStart_pk` PRIMARY KEY(`workspaceId`,`windowStart`)
);
--> statement-breakpoint
CREATE TABLE `providerUsageHolds` (
  `id` varchar(64) NOT NULL,
  `workspaceId` int NOT NULL,
  `providerId` varchar(96) NOT NULL,
  `windowStart` date NOT NULL,
  `tokens` bigint NOT NULL,
  `cost` decimal(18,6) NOT NULL DEFAULT 0,
  `state` enum('HELD','COMMITTED','RELEASED') NOT NULL DEFAULT 'HELD',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `providerUsageHolds_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `providerUsageHolds_state_createdAt_idx` ON `providerUsageHolds` (`state`,`createdAt`);
--> statement-breakpoint
CREATE TABLE `providerBreakerStates` (
  `providerId` varchar(96) NOT NULL,
  `state` enum('CLOSED','OPEN','HALF_OPEN') NOT NULL DEFAULT 'CLOSED',
  `consecutiveFailures` int NOT NULL DEFAULT 0,
  `openedAt` bigint NOT NULL DEFAULT 0,
  `probeInFlightSince` bigint,
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `providerBreakerStates_providerId` PRIMARY KEY(`providerId`)
);
