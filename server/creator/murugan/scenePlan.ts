import { createHash } from "node:crypto";
import { estimateCreatorCost, type CreatorModelCost, type CreatorPaidConfig } from "../paidPolicy";

/**
 * Murugan Creator scene planner. Pure and deterministic: no provider call, no spend, no storage.
 *
 * It turns HUMAN-APPROVED lines (start/end taken from the approved audio master, plus a human-authored visual intent)
 * into a request in the repository's existing VGEN schema (scripts/validate-video-generation-request.mjs), so the
 * existing validator is the gate. It does not invent devotional content: every shot's subject/action/environment come
 * from the approved line. What it adds is continuity — one character bible (Murugan, one Vel, one peacock) injected into
 * every shot that includes that element, anchor-still bookkeeping, and exact timeline coverage.
 *
 * The default bible is DRAFT_FOR_OWNER_REVIEW: a human reviewer must approve it before any paid generation.
 */
export type MuruganElement = "murugan" | "vel" | "peacock";

export type CharacterBible = {
  bibleId: string;
  status: "DRAFT_FOR_OWNER_REVIEW" | "OWNER_APPROVED";
  murugan: string;
  vel: string;
  peacock: string;
  style: string;
  negativeConstraints: readonly string[];
};

export const DEFAULT_CHARACTER_BIBLE: CharacterBible = {
  bibleId: "murugan-bible-v1",
  status: "DRAFT_FOR_OWNER_REVIEW",
  murugan: "Lord Murugan (Kandan): youthful, serene and dignified, in traditional South Indian temple-art styling, with the same face, crown, jewellery and attire in every shot",
  vel: "exactly one Vel: a slender spear with a leaf-shaped blade on a straight shaft, never a trident, never two",
  peacock: "exactly one peacock, Murugan's vahana: anatomically correct, a full fan of tail feathers with eye-spot markings, no extra heads or legs",
  style: "reverent devotional cinematic illustration, warm temple-lamp lighting, consistent colour palette",
  negativeConstraints: [
    "no text, captions, logos, watermarks or foreign symbols anywhere in frame",
    "no distorted hands, faces, eyes or limbs",
    "no second Vel, no trident, no second peacock",
  ],
};

export type CameraShotSize = "ECU" | "CU" | "MCU" | "MS" | "MLS" | "WS" | "EWS";
export type CameraMovement = "LOCKED" | "PAN" | "TILT" | "DOLLY_IN" | "DOLLY_OUT" | "TRACK" | "ORBIT" | "CRANE" | "HANDHELD_CONTROLLED";

export type ApprovedLine = {
  lineId: string;
  /** From the approved audio master (or its approved excerpt). */
  startMs: number;
  endMs: number;
  /** Human-authored visual intent for this line. */
  subject: string;
  action: string;
  environment: string;
  elements: readonly MuruganElement[];
  camera?: { shotSize: CameraShotSize; movement: CameraMovement };
  activeMotionCount?: 0 | 1 | 2;
};

export type ScenePlanInput = {
  projectName: string;
  /** Approved audio master identity — the plan is bound to it. */
  audio: { sha256: string; durationMs: number };
  lines: readonly ApprovedLine[];
  /** Asset ids of the approved Murugan/Vel/peacock reference set (required: identity lock). */
  referenceAssetIds: readonly string[];
  bible?: CharacterBible;
  target?: { width: number; height: number; fps: number };
};

export const PROVIDER_CLIP_SECONDS = [4, 6, 8] as const;
const MAX_SHOT_MS = 8000;
const MIN_SHOT_MS = 1000;

export type PlannedShot = {
  shotId: string; // SHOT-001 (VGEN pattern)
  sceneId: string; // SCENE-001
  lineId: string;
  sceneIndex: number;
  shotIndex: number;
  startMs: number;
  endMs: number;
  durationSeconds: number;
  /** Generated clip length requested from the provider; the render trims it to the span. */
  providerClipSeconds: 4 | 6 | 8;
  elements: readonly MuruganElement[];
  /** Elements whose reference/anchor still is first generated in this shot. */
  anchorFor: readonly MuruganElement[];
  /** Earlier shot whose approved still supplies the same elements, for identity conditioning. */
  referenceFromShot?: string;
  firstFramePrompt: string;
  videoPrompt: string;
};

export type VideoGenerationRequest = {
  schemaVersion: "1.0.0";
  requestId: string;
  capabilityId: "GM-I2V";
  target: { width: number; height: number; fps: number; durationSeconds: number; aspectRatio: "16:9" };
  continuity: { referenceAssetIds: string[]; identityLockRequired: true; characterBibleId: string; characterBibleStatus: CharacterBible["status"] };
  textPolicy: { criticalOnScreenTextAllowedInGeneration: false; criticalTextHandling: "CAPTION_LAYER" };
  audioPolicy: { audioRequired: true; lipSyncRequired: false; tamilHumanReviewRequiredWhenApplicable: true };
  shots: Array<{
    shotId: string; durationSeconds: number; subject: string; action: string; environment: string;
    camera: { shotSize: CameraShotSize; movement: CameraMovement }; activeMotionCount: number; negativeConstraints: string[];
  }>;
  qualityPolicy: { regenerateFailedShotsOnly: true; maximumWholeVideoRetriesBeforeDiagnosis: 0; postGenerationSpecId: "SAI-VIDEO-QUALITY"; productionApproved: false; paidProviderApproved: false };
};

export type ScenePlan = {
  planId: string;
  projectName: string;
  audio: ScenePlanInput["audio"];
  bible: CharacterBible;
  shots: PlannedShot[];
  request: VideoGenerationRequest;
  totals: { sceneCount: number; shotCount: number; providerClipSeconds: number; durationMs: number };
};

const pad = (n: number, width = 3) => String(n).padStart(width, "0");

function assertLines(input: ScenePlanInput): void {
  if (!input.referenceAssetIds.length) throw new Error("MURUGAN_REFERENCE_ASSETS_REQUIRED");
  if (!/^[0-9a-f]{64}$/.test(input.audio.sha256)) throw new Error("MURUGAN_AUDIO_SHA256_INVALID");
  if (!Number.isInteger(input.audio.durationMs) || input.audio.durationMs <= 0) throw new Error("MURUGAN_AUDIO_DURATION_INVALID");
  if (!input.lines.length) throw new Error("MURUGAN_LINES_REQUIRED");
  const ids = new Set<string>();
  let cursor = 0;
  for (const line of input.lines) {
    if (ids.has(line.lineId)) throw new Error(`MURUGAN_LINE_DUPLICATE:${line.lineId}`);
    ids.add(line.lineId);
    if (!Number.isInteger(line.startMs) || !Number.isInteger(line.endMs) || line.endMs <= line.startMs) throw new Error(`MURUGAN_LINE_RANGE_INVALID:${line.lineId}`);
    if (line.startMs !== cursor) throw new Error(line.startMs < cursor ? `MURUGAN_LINE_OVERLAP:${line.lineId}` : `MURUGAN_LINE_GAP:${line.lineId}`);
    if (line.endMs - line.startMs < MIN_SHOT_MS) throw new Error(`MURUGAN_LINE_TOO_SHORT:${line.lineId}`);
    for (const field of ["subject", "action", "environment"] as const) {
      if (line[field].trim().length < 3) throw new Error(`MURUGAN_LINE_INTENT_MISSING:${line.lineId}:${field}`);
    }
    cursor = line.endMs;
  }
  if (cursor !== input.audio.durationMs) throw new Error("MURUGAN_LINES_DO_NOT_COVER_AUDIO");
}

function clipSecondsFor(spanMs: number): 4 | 6 | 8 {
  const seconds = Math.ceil(spanMs / 1000);
  return (PROVIDER_CLIP_SECONDS.find(option => option >= seconds) ?? 8) as 4 | 6 | 8;
}

function elementBlock(bible: CharacterBible, elements: readonly MuruganElement[]): string {
  return elements.map(element => bible[element]).join("; ");
}

export function buildScenePlan(input: ScenePlanInput): ScenePlan {
  assertLines(input);
  const bible = input.bible ?? DEFAULT_CHARACTER_BIBLE;
  const target = input.target ?? { width: 1920, height: 1080, fps: 24 };
  const shots: PlannedShot[] = [];
  const firstSeen = new Map<MuruganElement, string>();

  input.lines.forEach((line, sceneIndex) => {
    const span = line.endMs - line.startMs;
    const parts = Math.max(1, Math.ceil(span / MAX_SHOT_MS));
    for (let part = 0; part < parts; part += 1) {
      const start = line.startMs + Math.round((span * part) / parts);
      const end = part === parts - 1 ? line.endMs : line.startMs + Math.round((span * (part + 1)) / parts);
      const shotId = `SHOT-${pad(shots.length + 1)}`;
      const elements = [...new Set(line.elements)];
      const anchorFor = elements.filter(element => !firstSeen.has(element));
      anchorFor.forEach(element => firstSeen.set(element, shotId));
      const referenceFromShot = elements.map(element => firstSeen.get(element)).find(id => id && id !== shotId);
      const scene = `${line.subject.trim()}, ${line.action.trim()}, in ${line.environment.trim()}`;
      const identity = elementBlock(bible, elements);
      const firstFramePrompt = [scene, identity, bible.style, `Avoid: ${bible.negativeConstraints.join("; ")}`].filter(Boolean).join(". ");
      shots.push({
        shotId, sceneId: `SCENE-${pad(sceneIndex + 1)}`, lineId: line.lineId, sceneIndex, shotIndex: part,
        startMs: start, endMs: end, durationSeconds: (end - start) / 1000, providerClipSeconds: clipSecondsFor(end - start),
        elements, anchorFor, referenceFromShot,
        firstFramePrompt,
        videoPrompt: `${scene}. Gentle, plausible motion only; keep the identity and objects of the first frame unchanged. ${identity}. ${bible.style}. Avoid: ${bible.negativeConstraints.join("; ")}`,
      });
    }
  });

  const requestShots = shots.map(shot => {
    const line = input.lines[shot.sceneIndex];
    return {
      shotId: shot.shotId, durationSeconds: shot.durationSeconds,
      subject: line.subject.trim(), action: line.action.trim(), environment: line.environment.trim(),
      camera: line.camera ?? { shotSize: "MS" as const, movement: "LOCKED" as const },
      activeMotionCount: line.activeMotionCount ?? 1,
      negativeConstraints: [...bible.negativeConstraints],
    };
  });

  const canonical = JSON.stringify({ a: input.audio, b: bible, p: input.projectName, s: shots.map(s => [s.shotId, s.lineId, s.startMs, s.endMs, s.firstFramePrompt]) });
  const planId = createHash("sha256").update(canonical).digest("hex");
  const request: VideoGenerationRequest = {
    schemaVersion: "1.0.0",
    requestId: `VGEN-MURUGAN-${planId.slice(0, 12).toUpperCase()}`,
    capabilityId: "GM-I2V",
    target: { ...target, durationSeconds: input.audio.durationMs / 1000, aspectRatio: "16:9" },
    continuity: { referenceAssetIds: [...input.referenceAssetIds], identityLockRequired: true, characterBibleId: bible.bibleId, characterBibleStatus: bible.status },
    textPolicy: { criticalOnScreenTextAllowedInGeneration: false, criticalTextHandling: "CAPTION_LAYER" },
    audioPolicy: { audioRequired: true, lipSyncRequired: false, tamilHumanReviewRequiredWhenApplicable: true },
    shots: requestShots,
    qualityPolicy: { regenerateFailedShotsOnly: true, maximumWholeVideoRetriesBeforeDiagnosis: 0, postGenerationSpecId: "SAI-VIDEO-QUALITY", productionApproved: false, paidProviderApproved: false },
  };

  return {
    planId, projectName: input.projectName, audio: input.audio, bible, shots, request,
    totals: {
      sceneCount: input.lines.length, shotCount: shots.length,
      providerClipSeconds: shots.reduce((sum, shot) => sum + shot.providerClipSeconds, 0),
      durationMs: input.audio.durationMs,
    },
  };
}

/** Invariants every plan must satisfy; used by tests and by consumers before spending. */
export function verifyScenePlan(plan: ScenePlan): string[] {
  const problems: string[] = [];
  let cursor = 0;
  const seen = new Set<string>();
  for (const shot of plan.shots) {
    if (seen.has(shot.shotId)) problems.push(`duplicate ${shot.shotId}`);
    seen.add(shot.shotId);
    if (shot.startMs !== cursor) problems.push(`${shot.shotId} not contiguous`);
    if (shot.endMs - shot.startMs > shot.providerClipSeconds * 1000) problems.push(`${shot.shotId} longer than its clip`);
    if (shot.endMs - shot.startMs > MAX_SHOT_MS) problems.push(`${shot.shotId} exceeds ${MAX_SHOT_MS}ms`);
    cursor = shot.endMs;
    if (shot.firstFramePrompt.length > 8000) problems.push(`${shot.shotId} prompt too long`);
    for (const element of shot.elements) {
      if (!shot.firstFramePrompt.includes(plan.bible[element])) problems.push(`${shot.shotId} lacks ${element} identity block`);
    }
  }
  if (cursor !== plan.audio.durationMs) problems.push("plan does not cover the audio master");
  return problems;
}

export type AcceptanceSliceOptions = { minMs?: number; maxMs?: number; minShots?: number; maxShots?: number };

/**
 * The bounded first acceptance sequence (runbook §1/§4): the leading shots covering ~20–40 s in 4–6 shots. The 84-scene
 * production is not a prerequisite for it. The slice must be paired with an approved audio excerpt of `endMs` length.
 */
export function selectAcceptanceSlice(plan: ScenePlan, options: AcceptanceSliceOptions = {}) {
  const { minMs = 20_000, maxMs = 40_000, minShots = 4, maxShots = 6 } = options;
  const shots: PlannedShot[] = [];
  for (const shot of plan.shots) {
    if (shots.length >= maxShots || shot.endMs > maxMs) break;
    shots.push(shot);
  }
  const endMs = shots.at(-1)?.endMs ?? 0;
  if (shots.length < minShots) throw new Error("MURUGAN_SLICE_TOO_FEW_SHOTS");
  if (endMs < minMs) throw new Error("MURUGAN_SLICE_TOO_SHORT");
  return { shots, startMs: 0, endMs, shotCount: shots.length };
}

export type PlanPrices = { costs: ReadonlyMap<string, CreatorModelCost>; imageModel: string; videoModel: string };

/** Dry-run estimate with the repository's own pricing formula. One first-frame image + one image-to-video clip per shot. */
export function estimatePlanCost(shots: readonly PlannedShot[], prices: PlanPrices): { images: number; videos: number; total: number } | undefined {
  const config = { costs: prices.costs, imageUsers: new Set<string>(), videoUsers: new Set<string>(), speechUsers: new Set<string>(), avatarUsers: new Set<string>(), limits: { globalGenerations: 1, globalCost: 1, workspaceGenerations: 1, workspaceCost: 1, userGenerations: 1, userCost: 1 } } as CreatorPaidConfig;
  let images = 0;
  let videos = 0;
  for (const shot of shots) {
    const image = estimateCreatorCost(config, prices.imageModel, { kind: "IMAGE", prompt: shot.firstFramePrompt });
    const video = estimateCreatorCost(config, prices.videoModel, { kind: "VIDEO", prompt: shot.videoPrompt, durationSeconds: shot.providerClipSeconds });
    if (image === undefined || video === undefined) return undefined;
    images += image;
    videos += video;
  }
  const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
  return { images: round(images), videos: round(videos), total: round(images + videos) };
}

/** Split a large plan (e.g. 84 scenes) into bounded batches so no single run is unbounded in shots or spend. */
export function batchShots(shots: readonly PlannedShot[], maxShotsPerBatch: number): PlannedShot[][] {
  if (!Number.isInteger(maxShotsPerBatch) || maxShotsPerBatch < 1) throw new Error("MURUGAN_BATCH_SIZE_INVALID");
  const batches: PlannedShot[][] = [];
  for (let i = 0; i < shots.length; i += maxShotsPerBatch) batches.push(shots.slice(i, i + maxShotsPerBatch));
  return batches;
}
