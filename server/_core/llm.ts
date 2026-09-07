import { ENV } from "./env";

export type Role = "system" | "user" | "assistant" | "tool" | "function";
export type TextContent = { type: "text"; text: string };
export type ImageContent = { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };
export type FileContent = { type: "file_url"; file_url: { url: string; mime_type?: "audio/mpeg" | "audio/wav" | "application/pdf" | "audio/mp4" | "video/mp4" } };
export type MessageContent = string | TextContent | ImageContent | FileContent;
export type Message = { role: Role; content: MessageContent | MessageContent[]; name?: string; tool_call_id?: string };
export type Tool = { type: "function"; function: { name: string; description?: string; parameters?: Record<string, unknown> } };
export type ToolChoicePrimitive = "none" | "auto" | "required";
export type ToolChoiceByName = { name: string };
export type ToolChoiceExplicit = { type: "function"; function: { name: string } };
export type ToolChoice = ToolChoicePrimitive | ToolChoiceByName | ToolChoiceExplicit;
export type JsonSchema = { name: string; schema: Record<string, unknown>; strict?: boolean };
export type OutputSchema = JsonSchema;
export type ResponseFormat = { type: "text" } | { type: "json_object" } | { type: "json_schema"; json_schema: JsonSchema };

export type InvokeParams = {
  messages: Message[];
  tools?: Tool[];
  toolChoice?: ToolChoice;
  tool_choice?: ToolChoice;
  maxTokens?: number;
  max_tokens?: number;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
  model?: string;
  thinking?: Record<string, unknown>;
  reasoning?: Record<string, unknown>;
};

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type InvokeResult = {
  id: string;
  created: number;
  model: string;
  choices: Array<{ index: number; message: { role: Role; content: string | Array<TextContent | ImageContent | FileContent>; tool_calls?: ToolCall[] }; finish_reason: string | null }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
};
export type ModelInfo = { id: string; object: string; created: number; owned_by: string };
export type ModelsResponse = { object: string; data: ModelInfo[] };

const RETRY_MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 30_000;

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

function getBaseUrl(): string {
  const value = ENV.llmApiUrl.trim();
  if (!value) throw new Error("LLM_API_URL is not configured");
  return value.replace(/\/$/, "");
}

function authHeaders(): Record<string, string> {
  return ENV.llmApiKey ? { authorization: `Bearer ${ENV.llmApiKey}` } : {};
}

const ensureArray = (value: MessageContent | MessageContent[]): MessageContent[] => Array.isArray(value) ? value : [value];

function normalizeMessage(message: Message) {
  const content = ensureArray(message.content);
  const normalized = content.map(part => typeof part === "string" ? { type: "text" as const, text: part } : part);
  const resolvedContent = normalized.length === 1 && normalized[0].type === "text" ? normalized[0].text : normalized;
  return { role: message.role, name: message.name, tool_call_id: message.tool_call_id, content: resolvedContent };
}

function normalizeToolChoice(choice: ToolChoice | undefined, tools: Tool[] | undefined): "none" | "auto" | ToolChoiceExplicit | undefined {
  if (!choice) return undefined;
  if (choice === "none" || choice === "auto") return choice;
  if (choice === "required") {
    if (!tools?.length) throw new Error("tool_choice 'required' needs at least one configured tool");
    if (tools.length !== 1) throw new Error("tool_choice 'required' needs one tool or an explicit tool name");
    return { type: "function", function: { name: tools[0].function.name } };
  }
  if ("name" in choice) return { type: "function", function: { name: choice.name } };
  return choice;
}

function normalizeResponseFormat(params: InvokeParams): ResponseFormat | undefined {
  const explicit = params.responseFormat ?? params.response_format;
  if (explicit) return explicit;
  const schema = params.outputSchema ?? params.output_schema;
  return schema ? { type: "json_schema", json_schema: schema } : undefined;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function computeBackoffDelay(attempt: number, retryAfterMs?: number): number {
  const cap = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
  const jittered = cap / 2 + Math.random() * (cap / 2);
  return Math.min(Math.max(jittered, retryAfterMs ?? 0), RETRY_MAX_DELAY_MS);
}

async function fetchWithBackoff(url: string, init: FetchInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (response.ok || attempt === RETRY_MAX_RETRIES) return response;
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      try { await response.body?.cancel(); } catch { /* noop */ }
      await sleep(computeBackoffDelay(attempt, retryAfter));
    } catch (error) {
      lastError = error;
      if (attempt === RETRY_MAX_RETRIES) throw error;
      await sleep(computeBackoffDelay(attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("LLM request failed after retries");
}

export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  const payload: Record<string, unknown> = { messages: params.messages.map(normalizeMessage) };
  const model = params.model || ENV.llmModel;
  if (model) payload.model = model;
  if (params.tools?.length) payload.tools = params.tools;

  const toolChoice = normalizeToolChoice(params.toolChoice ?? params.tool_choice, params.tools);
  if (toolChoice) payload.tool_choice = toolChoice;

  const maxTokens = params.max_tokens ?? params.maxTokens;
  if (typeof maxTokens === "number") payload.max_tokens = maxTokens;
  if (params.thinking) payload.thinking = params.thinking;
  if (params.reasoning) payload.reasoning = params.reasoning;

  const responseFormat = normalizeResponseFormat(params);
  if (responseFormat) payload.response_format = responseFormat;

  const response = await fetchWithBackoff(`${getBaseUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM invoke failed: ${response.status} ${response.statusText} – ${errorText}`);
  }
  return await response.json() as InvokeResult;
}

export async function listLLMModels(): Promise<ModelsResponse> {
  const response = await fetchWithBackoff(`${getBaseUrl()}/v1/models`, { headers: authHeaders() });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`List LLM models failed: ${response.status} ${response.statusText} – ${errorText}`);
  }
  return await response.json() as ModelsResponse;
}
