// Build-time VITE_* values are compiled into the browser bundle and served to every visitor.
// No credential-shaped variable may be read from client code (the Q8 rule: no API key in browser bundles).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

describe("browser bundle inputs", () => {
  it("client code reads no VITE_* variable whose name suggests a credential", () => {
    const offenders = [];
    for (const file of walk(path.join(root, "client", "src")).filter(f => /\.(ts|tsx|js|jsx)$/.test(f))) {
      for (const m of fs.readFileSync(file, "utf8").matchAll(/import\.meta\.env\.(VITE_[A-Z0-9_]+)/g)) {
        if (/(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE)/.test(m[1])) offenders.push(`${path.relative(root, file)}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
