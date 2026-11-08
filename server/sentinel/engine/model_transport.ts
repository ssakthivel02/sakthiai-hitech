import type { ModelProvenance } from "./types";
/**
 * Seam between the investigation engine and a language model.
 * Production wiring: `../taskModelTransport.ts` (routes through TaskContext.invokeModel -> Provider Gateway).
 * `MockModelTransport` is for tests only and is never registered by the handler.
 */
export interface ModelRequest { system: string; user: string; attempt: number; signal?: AbortSignal }
export interface ModelResponse { text: string; tokens_in?: number; tokens_out?: number; /** only transports that know which provider answered set this */ provenance?: ModelProvenance }
export interface ModelTransport { readonly id: string; readonly kind: "mock" | "local" | "remote"; complete(req: ModelRequest): Promise<ModelResponse> }

type Script = (req: ModelRequest, n: number) => string | ModelResponse | Promise<string | ModelResponse>;

/** Scripted transport for tests. Token counts are rough estimates (chars/4), not measurements. */
export class MockModelTransport implements ModelTransport {
  readonly id: string; readonly kind = "mock" as const;
  readonly calls: ModelRequest[] = [];
  private readonly script: Script;
  constructor(script: Script, id = "mock-scripted") { this.script = script; this.id = id; }
  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.calls.push(req);
    const out = await this.script(req, this.calls.length - 1);
    return typeof out === "string" ? { text: out, tokens_in: Math.ceil((req.system.length + req.user.length) / 4), tokens_out: Math.ceil(out.length / 4) } : out;
  }
}
