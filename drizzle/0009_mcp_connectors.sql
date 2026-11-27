CREATE TABLE `mcpConnectors` (
  `id` char(36) NOT NULL,
  `workspaceId` int NOT NULL,
  `name` varchar(96) NOT NULL,
  `endpoint` varchar(500) NOT NULL,
  `enabled` boolean NOT NULL DEFAULT false,
  `secretRef` varchar(64),
  `allowedToolsJson` text,
  `timeoutMs` int NOT NULL DEFAULT 8000,
  `maxResponseBytes` int NOT NULL DEFAULT 262144,
  `createdByUserId` int,
  `createdAt` datetime(3) NOT NULL,
  `updatedAt` datetime(3) NOT NULL,
  CONSTRAINT `mcpConnectors_id` PRIMARY KEY(`id`),
  CONSTRAINT `mcpConnectors_workspace_name_uq` UNIQUE(`workspaceId`,`name`)
);
--> statement-breakpoint
CREATE TABLE `mcpConnectorAudit` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `workspaceId` int NOT NULL,
  `connectorId` char(36) NOT NULL,
  `actorUserId` int,
  `action` enum('REGISTER','ENABLE','DISABLE','REMOVE','DISCOVER','READ_RESOURCE','CALL_TOOL') NOT NULL,
  `target` varchar(255),
  `outcome` enum('OK','DENIED','ERROR','TIMEOUT','TOO_LARGE','INVALID') NOT NULL,
  `detail` varchar(255),
  `responseBytes` int,
  `createdAt` datetime(3) NOT NULL,
  CONSTRAINT `mcpConnectorAudit_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `mcpConnectorAudit_workspace_created_idx` ON `mcpConnectorAudit` (`workspaceId`,`createdAt`);
