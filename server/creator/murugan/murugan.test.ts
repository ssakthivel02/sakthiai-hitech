import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { batchShots, buildScenePlan, estimatePlanCost, selectAcceptanceSlice, verifyScenePlan, type ApprovedLine } from "./scenePlan";
import { buildCaptionCues, graphemeCount, normalizeTamilText, verifyCaptionsMatchSource } from "./captions";
import { serializeSrt } from "../renderPlan";

const SHA = "a".repeat(64);
const refs = ["asset-murugan-face-01", "asset-vel-01", "asset-peacock-01"];

function lines(count: number, spanMs = 5000): ApprovedLine[] {
  return Array.from({ length: count }, (_, i) => ({
    lineId: `L${String(i + 1).padStart(3, "0")}`,
    startMs: i * spanMs, endMs: (i + 1) * spanMs,
    subject: i % 3 === 0 ? "Murugan standing before the hill shrine" : i % 3 === 1 ? "Murugan with the Vel beside the peacock" : "Temple lamps and devotees at dawn",
    action: "stands calmly as lamp light moves", environment: "a hill temple courtyard at dawn",
    elements: i % 3 === 0 ? ["murugan"] : i % 3 === 1 ? ["murugan", "vel", "peacock"] : [],
  }));
}

describe("Murugan scene plan", () => {
  it("covers the audio exactly with contiguous shots and clip lengths the provider supports", () => {
    const plan = buildScenePlan({ projectName: "Murugan acceptance", audio: { sha256: SHA, durationMs: 30_000 }, lines: lines(6), referenceAssetIds: refs });
    expect(verifyScenePlan(plan)).toEqual([]);
    expect(plan.shots).toHaveLength(6);
    expect(plan.shots.every(s => [4, 6, 8].includes(s.providerClipSeconds) && s.durationSeconds * 1000 <= s.providerClipSeconds * 1000)).toBe(true);
    expect(plan.shots.at(-1)!.endMs).toBe(30_000);
  });

  it("splits lines longer than 8 s into equal sub-shots and keeps the timeline exact", () => {
    const plan = buildScenePlan({ projectName: "p", audio: { sha256: SHA, durationMs: 20_000 }, lines: lines(1, 20_000), referenceAssetIds: refs });
    expect(plan.shots.map(s => s.durationSeconds)).toEqual([6.667, 6.666, 6.667]);
    expect(plan.shots.reduce((sum, s) => sum + (s.endMs - s.startMs), 0)).toBe(20_000);
    expect(verifyScenePlan(plan)).toEqual([]);
  });

  it("injects the identity block only where the element appears and tracks first-appearance anchors", () => {
    const plan = buildScenePlan({ projectName: "p", audio: { sha256: SHA, durationMs: 30_000 }, lines: lines(6), referenceAssetIds: refs });
    const [s1, s2, s3, s4] = plan.shots;
    expect(s1.anchorFor).toEqual(["murugan"]);
    expect(s2.anchorFor).toEqual(["vel", "peacock"]);
    expect(s2.referenceFromShot).toBe("SHOT-001");
    expect(s2.referenceFromShotByElement).toEqual({ murugan: "SHOT-001" });
    expect(s4.referenceFromShotByElement).toEqual({ murugan: "SHOT-001" });
    expect(s3.elements).toEqual([]);
    expect(s3.firstFramePrompt).not.toContain(plan.bible.peacock);
    expect(s4.anchorFor).toEqual([]);
    expect(s4.firstFramePrompt).toContain(plan.bible.murugan);
    expect(s2.firstFramePrompt).toContain("exactly one Vel");
    expect(s2.firstFramePrompt).toContain("exactly one peacock");
  });

  it("preserves separate Murugan, Vel and peacock anchors in a mixed-element continuation shot", () => {
    const approvedLines = lines(3);
    approvedLines[2] = { ...approvedLines[2], elements: ["murugan", "vel", "peacock"] };
    const plan = buildScenePlan({ projectName: "p", audio: { sha256: SHA, durationMs: 15_000 }, lines: approvedLines, referenceAssetIds: refs });
    const continuation = plan.shots[2];
    expect(continuation.referenceFromShotByElement).toEqual({ murugan: "SHOT-001", vel: "SHOT-002", peacock: "SHOT-002" });
    expect(verifyScenePlan(plan)).toEqual([]);
    const missing = { ...continuation, referenceFromShotByElement: { murugan: "SHOT-001" } };
    expect(verifyScenePlan({ ...plan, shots: [...plan.shots.slice(0, 2), missing] })).toContain("SHOT-003 missing vel anchor reference");
  });

  it("is deterministic and bound to the audio master", () => {
    const a = buildScenePlan({ projectName: "p", audio: { sha256: SHA, durationMs: 30_000 }, lines: lines(6), referenceAssetIds: refs });
    const b = buildScenePlan({ projectName: "p", audio: { sha256: SHA, durationMs: 30_000 }, lines: lines(6), referenceAssetIds: refs });
    const c = buildScenePlan({ projectName: "p", audio: { sha256: "b".repeat(64), durationMs: 30_000 }, lines: lines(6), referenceAssetIds: refs });
    expect(a.planId).toBe(b.planId);
    expect(a.planId).not.toBe(c.planId);
  });

  it("refuses gaps, overlaps, short lines, missing intent, missing references and uncovered audio", () => {
    const base = { projectName: "p", audio: { sha256: SHA, durationMs: 10_000 }, lines: lines(2), referenceAssetIds: refs };
    expect(() => buildScenePlan({ ...base, lines: [lines(2)[0], { ...lines(2)[1], startMs: 5200 }] })).toThrow("MURUGAN_LINE_GAP:L002");
    expect(() => buildScenePlan({ ...base, lines: [lines(2)[0], { ...lines(2)[1], startMs: 4800 }] })).toThrow("MURUGAN_LINE_OVERLAP:L002");
    expect(() => buildScenePlan({ ...base, lines: [{ ...lines(1)[0], endMs: 500 }] })).toThrow("MURUGAN_LINE_TOO_SHORT:L001");
    expect(() => buildScenePlan({ ...base, lines: [{ ...lines(2)[0], subject: " " }, lines(2)[1]] })).toThrow("MURUGAN_LINE_INTENT_MISSING:L001:subject");
    expect(() => buildScenePlan({ ...base, referenceAssetIds: [] })).toThrow("MURUGAN_REFERENCE_ASSETS_REQUIRED");
    expect(() => buildScenePlan({ ...base, audio: { sha256: SHA, durationMs: 12_000 } })).toThrow("MURUGAN_LINES_DO_NOT_COVER_AUDIO");
    expect(() => buildScenePlan({ ...base, audio: { sha256: "zz", durationMs: 10_000 } })).toThrow("MURUGAN_AUDIO_SHA256_INVALID");
  });

  it("emits a request the repository's existing VGEN validator accepts (5-shot slice and 84-scene production)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vgen-"));
    try {
      for (const count of [6, 84]) {
        const plan = buildScenePlan({ projectName: "p", audio: { sha256: SHA, durationMs: count * 5000 }, lines: lines(count), referenceAssetIds: refs });
        const file = join(dir, `req-${count}.json`);
        writeFileSync(file, JSON.stringify(plan.request));
        const run = spawnSync("node", [join(process.cwd(), "scripts/validate-video-generation-request.mjs"), file], { encoding: "utf8" });
        expect(run.stderr).toBe("");
        expect(run.status).toBe(0);
        expect(JSON.parse(run.stdout).status).toBe("VIDEO_GENERATION_REQUEST_PASS");
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("cannot self-approve paid providers or production", () => {
    const plan = buildScenePlan({ projectName: "p", audio: { sha256: SHA, durationMs: 10_000 }, lines: lines(2), referenceAssetIds: refs });
    expect(plan.request.qualityPolicy).toMatchObject({ productionApproved: false, paidProviderApproved: false });
    expect(plan.bible.status).toBe("DRAFT_FOR_OWNER_REVIEW");
  });

  it("selects the bounded 20-40 s / 4-6 shot acceptance slice from the 84-scene plan without depending on the rest", () => {
    const plan = buildScenePlan({ projectName: "p", audio: { sha256: SHA, durationMs: 84 * 5000 }, lines: lines(84), referenceAssetIds: refs });
    const slice = selectAcceptanceSlice(plan);
    expect(slice.shotCount).toBe(6);
    expect(slice.endMs).toBe(30_000);
    expect(() => selectAcceptanceSlice(plan, { minShots: 7 })).toThrow("MURUGAN_SLICE_TOO_FEW_SHOTS");
    expect(() => selectAcceptanceSlice(plan, { minMs: 35_000 })).toThrow("MURUGAN_SLICE_TOO_SHORT");
    const batches = batchShots(plan.shots, 10);
    expect(batches).toHaveLength(9);
    expect(batches.flat()).toHaveLength(plan.shots.length);
    expect(plan.totals.sceneCount).toBe(84);
  });

  it("estimates cost with the repository formula and denies when a model is unpriced", () => {
    const plan = buildScenePlan({ projectName: "p", audio: { sha256: SHA, durationMs: 30_000 }, lines: lines(6), referenceAssetIds: refs });
    const costs = new Map([["img", { perGeneration: 0.04 }], ["vid", { perSecond: 0.1 }]]);
    const estimate = estimatePlanCost(plan.shots, { costs, imageModel: "img", videoModel: "vid" })!;
    expect(estimate.images).toBeCloseTo(0.24, 6);
    expect(estimate.videos).toBeCloseTo(0.1 * plan.totals.providerClipSeconds, 6);
    expect(estimatePlanCost(plan.shots, { costs, imageModel: "img", videoModel: "missing" })).toBeUndefined();
  });
});

describe("Tamil caption builder", () => {
  const approved = [
    { lineId: "L1", startMs: 0, endMs: 6000, textTa: "முருகா முருகா வேலா வேலா கந்தா கடம்பா கார்த்திகேயா சரவணா" },
    { lineId: "L2", startMs: 6000, endMs: 9000, textTa: "வெற்றி வேல் முருகனுக்கு அரோகரா" },
  ];

  it("keeps the approved text intact, never locks cues, and covers each line window exactly", () => {
    const built = buildCaptionCues(approved, 9000);
    expect(built.humanReviewRequired).toBe(true);
    expect(built.timing).toBe("PROPORTIONAL_UNVERIFIED");
    expect(built.cues.every(cue => cue.locked === false && cue.language === "ta")).toBe(true);
    expect(verifyCaptionsMatchSource(built.cues, approved)).toEqual([]);
    expect(built.cues.every(cue => graphemeCount(cue.text) <= 40 || !cue.text.includes(" "))).toBe(true);
    const l1 = built.cues.filter(c => c.lineId === "L1");
    expect(l1[0].startMs).toBe(0);
    expect(l1.at(-1)!.endMs).toBe(6000);
    for (let i = 1; i < built.cues.length; i += 1) expect(built.cues[i].startMs).toBe(built.cues[i - 1].endMs);
  });

  it("refuses to render until a human locks the cues, then serializes a valid SRT", () => {
    const built = buildCaptionCues(approved, 9000);
    expect(() => serializeSrt(built.cues, 9000)).toThrow("CREATOR_RENDER_CAPTION_NOT_LOCKED");
    const locked = built.cues.map(cue => ({ ...cue, locked: true }));
    expect(serializeSrt(locked, 9000)).toContain("00:00:00,000 -->");
  });

  it("uses real word alignment when supplied and labels the timing AUDIO_ALIGNED", () => {
    const line = { lineId: "L1", startMs: 0, endMs: 2000, textTa: "முருகா வேலா கந்தா", wordTimings: [{ startMs: 100, endMs: 600 }, { startMs: 700, endMs: 1300 }, { startMs: 1400, endMs: 1900 }] };
    const built = buildCaptionCues([line], 2000);
    expect(built.timing).toBe("AUDIO_ALIGNED");
    expect(built.cues[0].startMs).toBe(100);
    expect(built.cues.at(-1)!.endMs).toBe(1900);
    expect(() => buildCaptionCues([{ ...line, wordTimings: line.wordTimings.slice(1) }], 2000)).toThrow("CAPTION_WORD_TIMINGS_MISMATCH:L1");
  });

  it("detects dropped, duplicated and substituted words", () => {
    const built = buildCaptionCues(approved, 9000);
    const dropped = built.cues.map((cue, i) => (i === 0 ? { ...cue, text: cue.text.split(" ").slice(1).join(" ") } : cue));
    expect(verifyCaptionsMatchSource(dropped, approved)[0]).toMatchObject({ code: "CAPTION_TEXT_DROPPED", lineId: "L1" });
    const dup = [...built.cues, { ...built.cues[0] }];
    expect(verifyCaptionsMatchSource(dup, approved)[0]).toMatchObject({ code: "CAPTION_TEXT_DUPLICATED_OR_ADDED" });
    const sub = built.cues.map((cue, i) => (i === 0 ? { ...cue, text: cue.text.replace("வேலா", "வேல") } : cue));
    expect(verifyCaptionsMatchSource(sub, approved)[0]).toMatchObject({ code: "CAPTION_TEXT_SUBSTITUTED" });
  });

  it("rejects lines outside the audio, overlapping lines and flags unexpected characters and dense cues", () => {
    expect(() => buildCaptionCues([{ lineId: "L1", startMs: 0, endMs: 9500, textTa: "வேல்" }], 9000)).toThrow("CAPTION_LINE_OUTSIDE_AUDIO:L1");
    expect(() => buildCaptionCues([approved[0], { ...approved[1], startMs: 5000 }], 9000)).toThrow("CAPTION_LINE_OVERLAP:L2");
    const odd = buildCaptionCues([{ lineId: "L1", startMs: 0, endMs: 3000, textTa: "வேல் � 中文" }], 3000);
    expect(odd.issues.some(issue => issue.code === "CAPTION_UNEXPECTED_CHARACTERS")).toBe(true);
    const dense = buildCaptionCues([{ lineId: "L1", startMs: 0, endMs: 900, textTa: `${approved[0].textTa} ${approved[0].textTa} ${approved[0].textTa}` }], 900);
    expect(dense.issues.some(issue => issue.code === "CAPTION_CUE_DENSE")).toBe(true);
    expect(dense.cues.at(-1)!.endMs).toBe(900);
  });

  it("normalises Unicode form and invisible characters but preserves ZWJ/ZWNJ", () => {
    expect(normalizeTamilText("  வேல்​  முருகா ")).toBe("வேல் முருகா");
    expect(normalizeTamilText("க‍ஷ")).toBe("க‍ஷ");
  });
});
