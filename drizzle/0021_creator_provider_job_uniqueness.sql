ALTER TABLE `creatorProviderJobs`
  ADD CONSTRAINT `creatorProviderJobs_workspace_job_uq`
  UNIQUE (`workspaceId`, `providerJobId`);
