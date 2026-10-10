import { spawnSync } from "node:child_process";
import { ENV } from "../_core/env";
import { listCreatorProviderStatuses } from "./providerRegistry";

export type CreatorPreflightCheck = {
  id: string;
  required: boolean;
  pass: boolean;
  detail: string;
};

export type CreatorRuntimePreflight = {
  readyForPaidGeneration: boolean;
  productionApproved: false;
  checks: CreatorPreflightCheck[];
};

function configured(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

export function probeFfmpeg(command = process.env.FFMPEG_PATH?.trim() || "ffmpeg"): {
  pass: boolean;
  detail: string;
} {
  try {
    const result = spawnSync(command, ["-version"], {
      encoding: "utf-8",
      timeout: 3000,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      return { pass: false, detail: "FFmpeg executable is not available to the Creator render worker." };
    }
    const firstLine = String(result.stdout || "").split(/\r?\n/, 1)[0]?.trim();
    return { pass: true, detail: firstLine || "FFmpeg executable responded successfully." };
  } catch {
    return { pass: false, detail: "FFmpeg executable probe failed." };
  }
}

export function buildCreatorRuntimePreflight(input?: {
  ffmpegProbe?: { pass: boolean; detail: string };
}): CreatorRuntimePreflight {
  const providerStatuses = listCreatorProviderStatuses();
  const imageProvider = providerStatuses.find(provider => provider.provider === "google-gemini-image");
  const videoProvider = providerStatuses.find(provider => provider.provider === "google-veo");
  const ffmpeg = input?.ffmpegProbe ?? probeFfmpeg();

  const storageCredentialsConsistent =
    configured(ENV.storageAccessKeyId) === configured(ENV.storageSecretAccessKey);
  const storageConfigured = configured(ENV.storageBucket) && storageCredentialsConsistent;

  const checks: CreatorPreflightCheck[] = [
    {
      id: "DATABASE_CONFIGURED",
      required: true,
      pass: configured(ENV.databaseUrl),
      detail: configured(ENV.databaseUrl)
        ? "Database connection string is configured. Migration/application state must still be verified in the runtime."
        : "DATABASE_URL is not configured.",
    },
    {
      id: "STORAGE_CONFIGURED",
      required: true,
      pass: storageConfigured,
      detail: !configured(ENV.storageBucket)
        ? "STORAGE_BUCKET is not configured."
        : storageCredentialsConsistent
          ? "S3-compatible storage configuration is structurally present; write/read acceptance still required."
          : "Storage credentials are incomplete: access-key ID and secret must be supplied together, or both omitted for ambient credentials.",
    },
    {
      id: "IMAGE_PROVIDER_CONFIGURED",
      required: true,
      pass: Boolean(imageProvider?.configured),
      detail: imageProvider?.configured
        ? `Image provider configured (${imageProvider.defaultModel}).`
        : "Google image provider is not configured with an authorised runtime credential.",
    },
    {
      id: "VIDEO_PROVIDER_CONFIGURED",
      required: true,
      pass: Boolean(videoProvider?.configured),
      detail: videoProvider?.configured
        ? `Video provider configured (${videoProvider.defaultModel}).`
        : "Google Veo provider is not configured with an authorised runtime credential.",
    },
    {
      id: "FFMPEG_AVAILABLE",
      required: true,
      pass: ffmpeg.pass,
      detail: ffmpeg.detail,
    },
  ];

  return {
    readyForPaidGeneration: checks.filter(check => check.required).every(check => check.pass),
    productionApproved: false,
    checks,
  };
}
