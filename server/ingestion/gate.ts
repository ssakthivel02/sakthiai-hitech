import { TRPCError } from "@trpc/server";

/**
 * Single explicit switch for EVERY server-side upload path (files.upload, files.resumable.*, Creator audio/reference ingest).
 * Default OFF. It is deliberately independent of malware-scanner configuration: a configured scanner is a prerequisite for
 * enabling uploads, never a reason they are enabled. The flag keeps its original name so existing deployments need no change.
 */
export const FILE_UPLOADS_ENV = "FILE_INGESTION_BACKEND_ENABLED";
export const FILE_UPLOADS_DISABLED_MESSAGE = "File uploads are not enabled in this beta";

export const fileUploadsEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env[FILE_UPLOADS_ENV] === "true";

/** Call FIRST in every upload-accepting procedure, before any database, scanner, extraction or storage work. */
export function assertFileUploadsEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (!fileUploadsEnabled(env)) throw new TRPCError({ code: "FORBIDDEN", message: FILE_UPLOADS_DISABLED_MESSAGE });
}
