import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { creatorIntentKey } from "../client/src/lib/creatorIntent";

const creator = readFileSync(new URL("../client/src/pages/Creator.tsx", import.meta.url), "utf8");
const panel = readFileSync(new URL("../client/src/pages/CreatorSpeechAvatarPanel.tsx", import.meta.url), "utf8");
const persistence = readFileSync(new URL("../server/creator/persistence.ts", import.meta.url), "utf8");

describe("Creator paid requests retain the same idempotency key after success", () => {
  it("keeps unchanged requests stable across repeated clicks and server acceptance", () => {
    const keys: Record<string, { key: string; fingerprint: string }> = {};
    let newKeys = 0;
    const uuid = () => `new-key-${++newKeys}`;
    const request = { workspaceId: 1, creatorProjectId: 2, shotId: 3, prompt: "Murugan", kind: "IMAGE" };
    const first = creatorIntentKey(keys, "IMAGE:3", request, uuid);
    expect(creatorIntentKey(keys, "IMAGE:3", { ...request }, uuid)).toBe(first);
    // A successful mutation does not clear the key, so this is a reused job.
    expect(creatorIntentKey(keys, "IMAGE:3", request, uuid)).toBe(first);
    expect(newKeys).toBe(1);
  });

  it("issues a new key only for a changed request or a distinct kind/shot", () => {
    const keys: Record<string, { key: string; fingerprint: string }> = {};
    let n = 0;
    const uuid = () => String(++n);
    const image = { shotId: 3, prompt: "First shot" };
    const a = creatorIntentKey(keys, "IMAGE:3", image, uuid);
    const b = creatorIntentKey(keys, "IMAGE:3", { ...image, prompt: "Updated shot" }, uuid);
    const c = creatorIntentKey(keys, "VIDEO:3", image, uuid);
    const d = creatorIntentKey(keys, "IMAGE:4", image, uuid);
    expect(new Set([a, b, c, d]).size).toBe(4);
    expect(creatorIntentKey(keys, "VIDEO:3", image, uuid)).toBe(c);
  });

  it("reuses the original key when an earlier paid request is restored (A -> B -> A)", () => {
    const intents: Record<string, { key: string; fingerprint: string; keysByFingerprint?: Record<string, string> }> = {};
    let issued = 0;
    const uuid = () => `new-key-${++issued}`;
    const a = { workspaceId: 1, creatorProjectId: 2, shotId: 3, prompt: "A" };
    const b = { ...a, prompt: "B" };
    const original = creatorIntentKey(intents, "IMAGE:3", a, uuid);
    const revised = creatorIntentKey(intents, "IMAGE:3", b, uuid);
    expect(revised).not.toBe(original);
    expect(creatorIntentKey(intents, "IMAGE:3", { ...a }, uuid)).toBe(original);
    expect(creatorIntentKey(intents, "IMAGE:3", b, uuid)).toBe(revised);
    expect(issued).toBe(2);
    // Scope isolation: the same payload in another project/media scope is a distinct intent.
    expect(creatorIntentKey(intents, "VIDEO:3", a, uuid)).not.toBe(original);
    expect(issued).toBe(3);
  });

  it("keeps speech and avatar idempotency after mutation success", () => {
    expect(panel).toContain('creatorIntentKey(intents.current, scope, payload');
    expect(panel).toContain("const submitSpeech = trpc.creator.speechAvatar.submitSpeech.useMutation({ onSuccess: done, onError });");
    expect(panel).toContain("const submitAvatar = trpc.creator.speechAvatar.submitAvatarVideo.useMutation({ onSuccess: done, onError });");
    expect(panel).not.toContain("delete intents.current.speech");
    expect(panel).not.toContain("delete intents.current.avatar");
  });

  it("keeps image/video idempotency after accepted submissions, consistent with backend deduplication", () => {
    expect(creator).toContain("creatorIntentKey(generationIntents.current, scope, payload");
    expect(creator).not.toContain("clearGenerationIntent(");
    expect(creator).toContain("const submitImage = trpc.creator.submitImage.useMutation({ onSuccess: () => project.refetch() });");
    expect(creator).toContain("const submitVideo = trpc.creator.submitVideo.useMutation({ onSuccess: () => project.refetch() });");
    expect(persistence).toContain("assertSameGenerationIntent(existing, intent)");
    expect(persistence).toContain("return { generationId: existing.id, created: false as const };");
  });
});
