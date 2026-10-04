import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { conversations, getDb, messages, searchChunks } from "../db";
import { groundedSystemPrompt, toCitations, type EvidenceMatches, type ToolEvidence } from "../chat/grounded";
import { listSelectableTools, mcpReadPolicyAllows, parseToolChoice, runSelectedTool, toolSelectionMessages, type McpStageResult } from "../chat/mcpTools";
import type { McpConnectorService } from "../connectors/mcp";
import type { Citation } from "../db";
import { resolveGroundedOutcome, type ModelResult } from "../grounding";
import { TaskFatalError, TaskRetryableError } from "./types";
import type { TaskHandler } from "./worker";

/** The one workflow wired into durable execution: grounded chat answer (retrieve → model via gateway → persist). */
export const CHAT_ANSWER_TASK = "chat.answer";

export const chatAnswerInput = z.object({
  conversationId: z.number().int().positive(),
  userId: z.number().int().positive(),
  message: z.string().min(1).max(12000),
  language: z.enum(["en", "ta"]).default("en"),
});
export type ChatAnswerInput = z.infer<typeof chatAnswerInput>;
export type ChatAnswerResult = { conversationId: number; answer: string; grounding: string; citations: unknown[] };

type Deps = {
  search?: (workspaceId: number, query: string) => Promise<EvidenceMatches>; db?: typeof getDb;
  /** Governed read-only MCP tools. Absent (or policy off) => no tool is ever offered or called. */
  mcp?: { service: Pick<McpConnectorService, "list" | "discover" | "callTool">; enabled?: () => boolean };
};

export function createChatAnswerHandler(deps: Deps = {}): TaskHandler<unknown, { evidenceCount: number }> {
  const search = deps.search ?? searchChunks;
  const dbFor = deps.db ?? getDb;
  return async ctx => {
    const parsed = chatAnswerInput.safeParse(ctx.input);
    if (!parsed.success) throw new TaskFatalError("invalid chat.answer input", "NON_RETRYABLE");
    const input = parsed.data;
    // Tenant is ALWAYS the task's workspace, never anything inside the payload.
    const workspaceId = ctx.task.workspaceId;
    const db = await dbFor();
    if (!db) throw new TaskRetryableError("database unavailable", "INTERNAL");
    const owned = await db.select({ id: conversations.id }).from(conversations)
      .where(and(eq(conversations.id, input.conversationId), eq(conversations.workspaceId, workspaceId), eq(conversations.userId, input.userId))).limit(1);
    if (!owned[0]) throw new TaskFatalError("conversation not found in task workspace", "NON_RETRYABLE");

    await ctx.effect("persist-question", async () => { await db.insert(messages).values({ conversationId: input.conversationId, workspaceId, role: "user", content: input.message }); return true; });
    await ctx.saveCheckpoint({ evidenceCount: -1 }, { percent: 20, note: "question stored" });

    const matches = await search(workspaceId, input.message);
    ctx.throwIfCancelled();

    // Optional governed MCP stage: ONE read-only call, workspace = task workspace, durable via ctx.effect (never repeated on resume).
    let tool: McpStageResult = { status: "skipped", reason: "disabled" };
    if (deps.mcp && (deps.mcp.enabled ?? mcpReadPolicyAllows)()) {
      const mcp = deps.mcp;
      tool = await ctx.effect<McpStageResult>("mcp-tool", async () => {
        const actor = { workspaceId, userId: input.userId };
        const offered = await listSelectableTools(mcp.service, actor);
        if (!offered.length) return { status: "skipped", reason: "no_tools" };
        let raw: string;
        try { raw = await ctx.invokeModel({ messages: toolSelectionMessages(offered, input.message), intents: ["conversation"], requiredCapabilities: ["chat"] }); }
        catch (error) { if (error instanceof TaskRetryableError || error instanceof TaskFatalError) return { status: "skipped", reason: "unavailable" }; throw error; }
        const parsed = parseToolChoice(raw);
        if (parsed.kind === "none") return { status: "skipped", reason: "no_choice" };
        if (parsed.kind === "invalid") return { status: "refused", reason: parsed.reason };
        return runSelectedTool(mcp.service, actor, offered, parsed.choice);
      });
    }
    const toolEvidence: ToolEvidence[] = tool.status === "used" ? [{ label: tool.citation.filename, text: tool.text }] : [];
    const toolCitations: Citation[] = tool.status === "used" ? [tool.citation] : [];
    const evidenceCount = matches.length + toolEvidence.length;

    let outcome: { answer: string; grounding: string; includeCitations: boolean };
    if (!evidenceCount) {
      outcome = { answer: "INSUFFICIENT_EVIDENCE", grounding: "INSUFFICIENT_EVIDENCE", includeCitations: false };
    } else {
      await ctx.saveCheckpoint({ evidenceCount }, { percent: 50, note: "evidence retrieved" });
      let model: ModelResult = { status: "failed" };
      try {
        const content = await ctx.invokeModel({
          messages: [{ role: "system", content: groundedSystemPrompt(input.language, matches, toolEvidence) }, { role: "user", content: input.message }],
          intents: ["conversation"], requiredCapabilities: ["chat"], optionalCapabilities: input.language === "ta" ? ["multilingual"] : [],
        });
        model = { status: "returned", content };
      } catch (error) {
        // Transient provider trouble: let the worker retry with backoff until attempts are exhausted.
        if (error instanceof TaskRetryableError && ctx.attempt < ctx.task.maxAttempts) throw error;
        if (!(error instanceof TaskRetryableError) && !(error instanceof TaskFatalError)) throw error;
        // Exhausted retries, or a budget/policy refusal: record the truthful MODEL_UNAVAILABLE state (evidence still shown).
      }
      outcome = resolveGroundedOutcome({ language: input.language, evidenceCount, model });
    }
    const citations = outcome.includeCitations ? [...toCitations(matches), ...toolCitations] : [];
    await ctx.effect("persist-answer", async () => { await db.insert(messages).values({ conversationId: input.conversationId, workspaceId, role: "assistant", content: outcome.answer, citationsJson: JSON.stringify(citations) }); return true; });
    return { conversationId: input.conversationId, answer: outcome.answer, grounding: outcome.grounding, citations } satisfies ChatAnswerResult;
  };
}
