import { createHash } from "node:crypto";

/** Canonical JSON (sorted keys, undefined dropped) so hashes are stable across runs. */
export function canon(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canon(o[k])).join(",") + "}";
}
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
export const hashOf = (v: unknown): string => sha256(canon(v));
export const h8 = (...p: Array<string | number>): string => sha256(p.join(":")).slice(0, 8);
