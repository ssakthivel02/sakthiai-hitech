CREATE TABLE `creatorArtifactLeases` (
  `generationId` int NOT NULL,
  `workspaceId` int NOT NULL,
  `creatorProjectId` int NOT NULL,
  `providerJobId` varchar(512) NOT NULL,
  `leaseToken` char(36) NOT NULL,
  `leaseUntil` datetime(3) NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`generationId`),
  KEY `creatorArtifactLeases_workspace_until_idx` (`workspaceId`, `leaseUntil`)
) ENGINE=InnoDB;
