-- Fail closed if legacy data already contains duplicate workspace/job identities.
-- The UNIQUE DDL fails with ER_DUP_ENTRY; it never rewrites or deletes provider evidence.
-- Preflight before migration: SELECT workspaceId, providerJobId, COUNT(*) AS n
--   FROM creatorProviderJobs GROUP BY workspaceId, providerJobId HAVING COUNT(*) > 1;
ALTER TABLE `creatorProviderJobs`
  ADD CONSTRAINT `creatorProviderJobs_workspace_job_uq`
  UNIQUE (`workspaceId`, `providerJobId`);
