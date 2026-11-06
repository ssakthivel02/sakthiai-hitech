import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { creatorIntentKey, creatorPersistentIntentKey } from "../client/src/lib/creatorIntent";

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

  it("keeps the same billable key after a new component instance/tab reload without persisting raw content", async () => {
    const store = new Map<string, string>();
    const written: string[] = [];
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { written.push(key + ":" + value); store.set(key, value); },
    };
    let generated = 0;
    const key = () => { generated++; return "aaaaaaaa-aaaa-4aaa-8aaa-" + String(generated).padStart(12, "0"); };
    const payload = { workspaceId: 7, creatorProjectId: 12, shotId: 3, prompt: "PRIVATE_PROMPT_NEVER_IN_STORAGE", consent: "PRIVATE_CONSENT" };
    const first = await creatorPersistentIntentKey({}, "IMAGE:3", payload, key, storage);
    const again = await creatorPersistentIntentKey({}, "IMAGE:3", { ...payload }, key, storage);
    expect(again).toBe(first);
    expect(generated).toBe(1);
    expect(written.join("\\n")).not.toContain(payload.prompt);
    expect(written.join("\\n")).not.toContain(payload.consent);
    expect([...store.keys()][0]).toMatch(/^sakthiai\.creator\.intent\.v1:[0-9a-f]{64}$/);
    const different = await creatorPersistentIntentKey({}, "VIDEO:3", payload, key, storage);
    expect(different).not.toBe(first);
    expect(generated).toBe(2);
  });

  it("fails closed without a writable tab mapping and never generates an untracked retry", async () => {
    const intents: Record<string, { key: string; fingerprint: string }> = {};
    const blocked = {
      getItem: () => null,
      setItem: () => { throw new Error("QuotaExceededError"); },
    };
    await expect(creatorPersistentIntentKey(intents, "IMAGE:3", { prompt: "A" },
      () => "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", blocked)).rejects.toThrow("CREATOR_IDEMPOTENCY_STORAGE_UNAVAILABLE");
    expect(creator).toContain("await idempotencyKeyFor(`IMAGE:${shot.id}`, payload)");
    expect(creator).toContain("await idempotencyKeyFor(`VIDEO:${shot.id}`, payload)");
    expect(panel).toContain('await keyFor("speech", payload)');
    expect(panel).toContain('await keyFor("avatar", payload)');
  });

  it("keeps speech and avatar idempotency after mutation success", () => {
    expect(panel).toContain('creatorPersistentIntentKey(intents.current, scope, payload');
    expect(panel).toContain("const submitSpeech = trpc.creator.speechAvatar.submitSpeech.useMutation({ onSuccess: done, onError });");
    expect(panel).toContain("const submitAvatar = trpc.creator.speechAvatar.submitAvatarVideo.useMutation({ onSuccess: done, onError });");
    expect(panel).not.toContain("delete intents.current.speech");
    expect(panel).not.toContain("delete intents.current.avatar");
  });

  it("keeps image/video idempotency after accepted submissions, consistent with backend deduplication", () => {
    expect(creator).toContain("creatorPersistentIntentKey(generationIntents.current, scope, payload");
    expect(creator).not.toContain("clearGenerationIntent(");
    expect(creator).toContain("const submitImage = trpc.creator.submitImage.useMutation({ onSuccess: () => project.refetch() });");
    expect(creator).toContain("const submitVideo = trpc.creator.submitVideo.useMutation({ onSuccess: () => project.refetch() });");
    expect(persistence).toContain("assertSameGenerationIntent(existing, intent)");
    expect(persistence).toContain("return { generationId: existing.id, created: false as const };");
  });
});
