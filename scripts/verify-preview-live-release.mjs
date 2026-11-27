#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Fail-closed artifact identity check before any real preview test credentials become available. */
export function assertApprovedPreviewReleaseIdentity(release, approvedCommit) {
  if (typeof approvedCommit !== "string" || !/^[0-9a-f]{40}$/.test(approvedCommit)) {
    throw new Error("Approved release must be an exact lowercase 40-character commit.");
  }
  if (!release || typeof release !== "object" || Array.isArray(release)) {
    throw new Error("Preview release identity is missing or malformed.");
  }
  if (release.service !== "sakthiai" || release.repository !== "ssakthivel02/sakthiai-hitech") {
    throw new Error("Preview release has an unexpected service or repository identity.");
  }
  if (release.exactCommitKnown !== true || typeof release.commit !== "string" ||
      release.commit.toLowerCase() !== approvedCommit) {
    throw new Error("Preview does not serve the exact approved commit.");
  }
  const artifact = release.artifact;
  if (!artifact || artifact.state !== "verified" ||
      typeof artifact.manifestCommit !== "string" ||
      artifact.manifestCommit.toLowerCase() !== approvedCommit) {
    throw new Error("Preview artifact is unverified or not bound to the approved commit.");
  }
  if (typeof artifact.digest !== "string" || !/^[0-9a-f]{64}$/.test(artifact.digest)) {
    throw new Error("Preview artifact has no valid SHA-256 digest.");
  }
  return approvedCommit;
}

// Invoked by the secret-free identity step, before the real-account browser step.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [reportFile, approvedCommit] = process.argv.slice(2);
  if (!reportFile) throw new Error("Release report path required.");
  const release = JSON.parse(readFileSync(reportFile, "utf8"));
  const verified = assertApprovedPreviewReleaseIdentity(release, approvedCommit);
  console.log("Preview exact-commit and artifact-identity gate PASS:", verified);
}
