import { describe, expect, it } from "vitest";
import { selectLockedReferences, type LockedReferenceRow } from "./referenceResolution";

const rows: LockedReferenceRow[] = [
  { referenceId: 4, assetId: 104, kind: "OBJECT", label: "Vel", mimeType: "image/png", storageKey: "o", immutable: 1, reviewDecision: "APPROVED" },
  { referenceId: 3, assetId: 103, kind: "LOCATION", label: "Temple", mimeType: "image/png", storageKey: "l", immutable: 1, reviewDecision: "APPROVED" },
  { referenceId: 2, assetId: 102, kind: "STYLE", label: "Film look", mimeType: "image/png", storageKey: "s", immutable: 1, reviewDecision: "APPROVED" },
  { referenceId: 1, assetId: 101, kind: "CHARACTER", label: "Murugan", mimeType: "image/png", storageKey: "c", immutable: 1, reviewDecision: "APPROVED" },
  { referenceId: 5, assetId: 105, kind: "CHARACTER", label: "Rejected", mimeType: "image/png", storageKey: "r", immutable: 1, reviewDecision: "REJECTED" },
  { referenceId: 6, assetId: 106, kind: "CHARACTER", label: "Mutable", mimeType: "image/png", storageKey: "m", immutable: 0, reviewDecision: "APPROVED" },
];

describe("selectLockedReferences", () => {
  it("prioritises approved immutable character/style/location/object locks deterministically", () => {
    expect(selectLockedReferences(rows, 4).map(row => row.assetId)).toEqual([101, 102, 103, 104]);
  });

  it("respects provider reference limits without admitting rejected or mutable references", () => {
    expect(selectLockedReferences(rows, 3).map(row => row.assetId)).toEqual([101, 102, 103]);
  });

  it("rejects invalid limits", () => {
    expect(() => selectLockedReferences(rows, -1)).toThrow("CREATOR_REFERENCE_LIMIT_INVALID");
  });
});
