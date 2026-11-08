import { describe, expect, it } from "vitest";
import { chooseCreatorScene } from "../../client/src/lib/creatorSceneSelection";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../client/src/pages/Creator.tsx", import.meta.url), "utf8");

describe("Creator scene selection", () => {
  const scenes = [
    { id: 11, sceneIndex: 0, title: "Opening" },
    { id: 18, sceneIndex: 1, title: "Battle" },
  ];

  it("falls back to the most recent scene before a user chooses one", () => {
    expect(chooseCreatorScene(scenes, null)?.id).toBe(18);
  });

  it("allows attaching a new shot to an earlier scene", () => {
    expect(chooseCreatorScene(scenes, 11)?.id).toBe(11);
  });

  it("does not reuse a stale scene ID from another project", () => {
    expect(chooseCreatorScene([{ id: 27, sceneIndex: 0 }], 11)?.id).toBe(27);
    expect(chooseCreatorScene([], 11)).toBeUndefined();
  });

  it("requires an explicit scene selector while preserving the existing shot-scoped API", () => {
    expect(source).toContain('aria-label="Select scene for new shot"');
    expect(source).toContain("setSelectedSceneId(e.target.value ? Number(e.target.value) : null)");
    expect(source).toContain("setSelectedSceneId(null); }, [projectId]");
    expect(source).toContain("sceneId: selectedScene!.id");
    expect(source).toContain("setSelectedSceneId(created.id)");
  });
});
