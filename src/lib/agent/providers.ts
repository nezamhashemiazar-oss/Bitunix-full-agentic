import { getCfg } from "./config";

/* ------------------------------------------------------------------ */
/* Provider adapters: OpenAI-compatible covers OpenAI, DeepSeek, Groq, */
/* OpenRouter, xAI, Together, Ollama/LM Studio, and any OpenAI-style   */
/* base URL. Anthropic and Gemini get their native shapes.             */
/* ------------------------------------------------------------------ */

export type ProviderKind = "openai" | "anthropic" | "gemini";

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatMsg {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface LlmResult {
  content: string;
  toolCalls: ToolCall[];
  reasoning?: string;
  model: string;
}

export interface ResolvedProvider {
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const DEFAULT_BASES: Record<ProviderKind, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
};

const FALLBACK_MODELS: Record<ProviderKind, string[]> = {
  openai: ["gpt-4o", "gpt-4o-mini", "o3-mini", "gpt-4.1", "gpt-4.1-mini"],
  anthropic: ["claude-sonnet-4-5-20250929", "claude-3-7-sonnet-20250224", "claude-3-5-haiku-20241022"],
  gemini: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
};

const PREFERRED = [
  "claude-sonnet-4-5",
  "claude-opus",
  "gpt-4o",
  "gpt-4.1",
  "o3",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "deepseek-chat",
  "deepseek-v3",
  "llama-3.3-70b",
  "grok-4",
  "grok-3",
  "qwen2.5-72b",
  "claude-3-7-sonnet",
  "gemini-2.0-flash",
];

export function detectProvider(apiKey: string, baseUrl: string): ProviderKind {
  const b = baseUrl.toLowerCase();
  if (b.includes("anthropic") || apiKey.startsWith("sk-ant")) return "anthropic";
  if (b.includes("generativelanguage") || apiKey.startsWith("AIza")) return "gemini";
  return "openai";
}

export function providerLabel(kind: ProviderKind, baseUrl: string): string {
  const b = baseUrl.toLowerCase();
  if (kind === "anthropic") return "Anthropic";
  if (kind === "gemini") return "Google Gemini";
  if (b.includes("openrouter")) return "OpenRouter";
  if (b.includes("groq")) return "Groq";
  if (b.includes("deepseek")) return "DeepSeek";
  if (b.includes("x.ai")) return "xAI";
  if (b.includes("together")) return "Together";
  if (b.includes("localhost") || b.includes("127.0.0.1")) return "Local (Ollama/LM Studio)";
  if (b.includes("openai")) return "OpenAI";
  return "OpenAI-compatible";
}

export async function resolveProvider(overrides?: {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}): Promise<ResolvedProvider | null> {
  const apiKey = overrides?.apiKey ?? (await getCfg("apiKey"));
  if (!apiKey && !overrides?.baseUrl) return null;
  const savedBase = overrides?.baseUrl ?? (await getCfg("baseUrl"));
  const savedKind = (overrides?.provider ?? (await getCfg("provider"))) as ProviderKind | "";
  const kind: ProviderKind = savedKind === "anthropic" || savedKind === "gemini" || savedKind === "openai" ? savedKind : detectProvider(apiKey, savedBase);
  const baseUrl = (savedBase || DEFAULT_BASES[kind]).replace(/\/+$/, "");
  const model = overrides?.model ?? (await getCfg("model"));
  return { kind, baseUrl, apiKey, model };
}

export function hasLlm(p: ResolvedProvider | null): p is ResolvedProvider {
  return !!p && !!p.apiKey && !!p.model;
}

/* --------------------------- AutoSetModelByKey --------------------------- */

export async function listModels(p: Omit<ResolvedProvider, "model">): Promise<{
  models: string[];
  source: "live" | "fallback";
  warning?: string;
}> {
  try {
    if (p.kind === "anthropic") {
      const res = await fetch(`${p.baseUrl}/v1/models?limit=100`, {
        headers: { "x-api-key": p.apiKey, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { data?: { id: string }[] };
      const models = (json.data ?? []).map((m) => m.id);
      if (!models.length) throw new Error("empty model list");
      return { models, source: "live" };
    }
    if (p.kind === "gemini") {
      const res = await fetch(`${p.baseUrl}/v1beta/models?key=${encodeURIComponent(p.apiKey)}&pageSize=200`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
      const models = (json.models ?? [])
        .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
        .map((m) => m.name.replace(/^models\//, ""))
        .filter((id) => /gemini/i.test(id) && !/embedding|aqa|imagen|tts/i.test(id));
      if (!models.length) throw new Error("empty model list");
      return { models, source: "live" };
    }
    const res = await fetch(`${p.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${p.apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { data?: { id: string }[] };
    const models = (json.data ?? [])
      .map((m) => m.id)
      .filter((id) => !/embed|whisper|tts|dall-e|moderation|babbage|davinci|audio/i.test(id));
    if (!models.length) throw new Error("empty model list");
    return { models, source: "live" };
  } catch (e) {
    return {
      models: FALLBACK_MODELS[p.kind],
      source: "fallback",
      warning: `Live model discovery failed (${e instanceof Error ? e.message : e}). Showing curated fallback list — the key may lack /models permission.`,
    };
  }
}

export function chooseDefaultModel(models: string[]): string {
  let best = models[0];
  let bestScore = Infinity;
  for (const m of models) {
    const idx = PREFERRED.findIndex((p) => m.toLowerCase().includes(p));
    const score = idx === -1 ? 100 : idx;
    if (score < bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}

export async function autoSetModelByKey(baseUrl: string, apiKey: string, provider?: string) {
  const kind: ProviderKind =
    provider === "anthropic" || provider === "gemini" || provider === "openai" ? provider : detectProvider(apiKey, baseUrl);
  const base = (baseUrl || DEFAULT_BASES[kind]).replace(/\/+$/, "");
  const { models, source, warning } = await listModels({ kind, baseUrl: base, apiKey });
  const model = chooseDefaultModel(models);
  const probe = await validateModel({ kind, baseUrl: base, apiKey, model });
  return { kind, baseUrl: base, models, model, source, warning, probe };
}

export async function validateModel(p: ResolvedProvider): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    await completion(p, [{ role: "user", content: "Reply with exactly: ok" }], { maxTokens: 8, temperature: 0 });
    return { ok: true, latencyMs: Date.now() - started };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
  }
}

/* ------------------------------ completion ------------------------------- */

async function errorFrom(res: Response, body: string): Promise<Error> {
  const snippet = body.slice(0, 300);
  if (res.status === 401 || res.status === 403) return new Error(`Auth failed (${res.status}) — check the API key. ${snippet}`);
  if (res.status === 404) return new Error(`Not found (404) — the model id or base URL looks wrong. ${snippet}`);
  if (res.status === 429) return new Error(`Rate limited (429). ${snippet}`);
  return new Error(`HTTP ${res.status}: ${snippet}`);
}

export async function completion(
  p: ResolvedProvider,
  messages: ChatMsg[],
  opts: { maxTokens?: number; temperature?: number; tools?: ToolDef[] } = {}
): Promise<LlmResult> {
  const { maxTokens = 2048, temperature = 0.35, tools } = opts;
  if (p.kind === "anthropic") return anthropicCompletion(p, messages, { maxTokens, temperature, tools });
  if (p.kind === "gemini") return geminiCompletion(p, messages, { maxTokens, temperature, tools });
  return openaiCompletion(p, messages, { maxTokens, temperature, tools });
}

async function openaiCompletion(
  p: ResolvedProvider,
  messages: ChatMsg[],
  opts: { maxTokens: number; temperature: number; tools?: ToolDef[] }
): Promise<LlmResult> {
  const body: Record<string, unknown> = {
    model: p.model,
    messages: messages.map((m) =>
      m.role === "tool"
        ? { role: "tool", tool_call_id: m.toolCallId, content: m.content }
        : m.role === "assistant" && m.toolCalls?.length
          ? {
              role: "assistant",
              content: m.content || null,
              tool_calls: m.toolCalls.map((t) => ({
                id: t.id,
                type: "function",
                function: { name: t.name, arguments: JSON.stringify(t.args) },
              })),
            }
          : { role: m.role, content: m.content }
    ),
    temperature: opts.temperature,
    max_tokens: opts.maxTokens,
  };
  if (opts.tools?.length) {
    body.tools = opts.tools.map((t) => ({ type: "function", function: t }));
    body.tool_choice = "auto";
  }
  const res = await fetch(`${p.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${p.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  if (!res.ok) throw await errorFrom(res, text);
  const json = JSON.parse(text) as {
    choices?: { message?: { content?: string | null; reasoning_content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
  };
  const msg = json.choices?.[0]?.message ?? {};
  const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((t, i) => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(t.function.arguments || "{}");
    } catch {
      args = {};
    }
    return { id: t.id || `call_${i}`, name: t.function.name, args };
  });
  return {
    content: msg.content ?? "",
    toolCalls,
    reasoning: msg.reasoning_content,
    model: p.model,
  };
}

async function anthropicCompletion(
  p: ResolvedProvider,
  messages: ChatMsg[],
  opts: { maxTokens: number; temperature: number; tools?: ToolDef[] }
): Promise<LlmResult> {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const rest = messages.filter((m) => m.role !== "system");
  const conv: Record<string, unknown>[] = [];
  for (const m of rest) {
    if (m.role === "tool") {
      conv.push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }] });
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      conv.push({
        role: "assistant",
        content: [
          ...(m.content ? [{ type: "text", text: m.content }] : []),
          ...m.toolCalls.map((t) => ({ type: "tool_use", id: t.id, name: t.name, input: t.args })),
        ],
      });
    } else {
      conv.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });
    }
  }
  const body: Record<string, unknown> = {
    model: p.model,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
    messages: conv.length ? conv : [{ role: "user", content: "Hello" }],
  };
  if (system) body.system = system;
  if (opts.tools?.length) {
    body.tools = opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  }
  const res = await fetch(`${p.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": p.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  if (!res.ok) throw await errorFrom(res, text);
  const json = JSON.parse(text) as {
    content?: ({ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> })[];
  };
  const toolCalls: ToolCall[] = [];
  let content = "";
  for (const block of json.content ?? []) {
    if (block.type === "text") content += block.text ?? "";
    if (block.type === "tool_use") toolCalls.push({ id: block.id ?? `toolu_${toolCalls.length}`, name: block.name ?? "", args: block.input ?? {} });
  }
  return { content, toolCalls, model: p.model };
}

async function geminiCompletion(
  p: ResolvedProvider,
  messages: ChatMsg[],
  opts: { maxTokens: number; temperature: number; tools?: ToolDef[] }
): Promise<LlmResult> {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const rest = messages.filter((m) => m.role !== "system");
  const contents: Record<string, unknown>[] = [];
  for (const m of rest) {
    if (m.role === "tool") {
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name: m.name ?? "tool", response: { result: m.content } } }],
      });
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      contents.push({
        role: "model",
        parts: [
          ...(m.content ? [{ text: m.content }] : []),
          ...m.toolCalls.map((t) => ({ functionCall: { name: t.name, args: t.args } })),
        ],
      });
    } else {
      contents.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] });
    }
  }
  const body: Record<string, unknown> = {
    contents: contents.length ? contents : [{ role: "user", parts: [{ text: "Hello" }] }],
    generationConfig: { maxOutputTokens: opts.maxTokens, temperature: opts.temperature },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (opts.tools?.length) {
    body.tools = [{ functionDeclarations: opts.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
  }
  const res = await fetch(
    `${p.baseUrl}/v1beta/models/${encodeURIComponent(p.model)}:generateContent?key=${encodeURIComponent(p.apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    }
  );
  const text = await res.text();
  if (!res.ok) throw await errorFrom(res, text);
  const json = JSON.parse(text) as {
    candidates?: { content?: { parts?: ({ text?: string; functionCall?: { name: string; args?: Record<string, unknown> } })[] } }[];
  };
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const toolCalls: ToolCall[] = [];
  let content = "";
  parts.forEach((part, i) => {
    if (part.text) content += part.text;
    if (part.functionCall) toolCalls.push({ id: `gc_${i}`, name: part.functionCall.name, args: part.functionCall.args ?? {} });
  });
  return { content, toolCalls, model: p.model };
}
