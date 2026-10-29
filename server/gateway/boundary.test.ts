import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Architectural guard for the Provider Gateway: the gateway is the ONLY chat-model invocation
 * boundary. These checks inspect real import specifiers (not comments) and the module's actual exports,
 * and are complemented by the behavioural tests in chat.grounding.test.ts (the real chat.send procedure
 * reaches the model only through gateway.invoke) and gateway.test.ts (fake HTTP providers).
 */

const serverRoot = path.resolve(__dirname, "..");
const ALLOWED_LLM_IMPORTERS = new Set([path.join("gateway", "openaiCompatible.ts")]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const pattern = /(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(pattern)) specs.push(match[1] ?? match[2] ?? match[3]);
  return specs;
}

describe("Provider Gateway is the only chat-model boundary", () => {
  const files = sourceFiles(serverRoot);

  it("no production module except the gateway's OpenAI-compatible adapter imports the provider client module", () => {
    const offenders = files
      .filter(file => importSpecifiers(fs.readFileSync(file, "utf8")).some(spec => /(^|\/)_core\/llm$/.test(spec) || spec === "./llm"))
      .map(file => path.relative(serverRoot, file))
      .filter(relative => !ALLOWED_LLM_IMPORTERS.has(relative) && relative !== path.join("_core", "llm.ts"));
    expect(offenders).toEqual([]);
  });

  it("no module outside the adapter builds a chat-completions HTTP request", () => {
    const offenders = files
      .filter(file => /\/(v1\/)?chat\/completions/.test(fs.readFileSync(file, "utf8")))
      .map(file => path.relative(serverRoot, file))
      .filter(relative => relative !== path.join("gateway", "openaiCompatible.ts"));
    expect(offenders).toEqual([]);
  });

  it("the former direct client is gone: _core/llm exports no invoke function", async () => {
    const llm = (await import("../_core/llm")) as Record<string, unknown>;
    expect(llm.invokeLLM).toBeUndefined();
    expect(llm.listLLMModels).toBeUndefined();
    expect(typeof llm.isRetryableHttpStatus).toBe("function");
  });

  it("routers.ts reaches the model only via the gateway and never imports a provider client", () => {
    const routers = fs.readFileSync(path.join(serverRoot, "routers.ts"), "utf8");
    const specs = importSpecifiers(routers);
    expect(specs).toContain("./gateway");
    expect(specs.some(spec => /_core\/llm|openaiCompatible/.test(spec))).toBe(false);
    expect(routers).toContain("getProviderGateway().invoke(");
    expect(routers).not.toMatch(/\binvokeLLM\b/);
  });

  it("the gateway never reaches a provider except through an adapter (no direct fetch in gateway.ts/config.ts/budget.ts)", () => {
    for (const name of ["gateway.ts", "config.ts", "budget.ts", "circuitBreaker.ts", "types.ts", "index.ts"]) {
      expect(fs.readFileSync(path.join(serverRoot, "gateway", name), "utf8"), name).not.toMatch(/\bfetch\s*\(/);
    }
  });

  it("the Creator media-provider path is untouched by the chat gateway (separate boundary)", () => {
    const creatorFiles = files.filter(file => file.includes(`${path.sep}creator${path.sep}`));
    expect(creatorFiles.length).toBeGreaterThan(0);
    for (const file of creatorFiles) {
      expect(importSpecifiers(fs.readFileSync(file, "utf8")).some(spec => /gateway/.test(spec)), path.relative(serverRoot, file)).toBe(false);
    }
  });
});
