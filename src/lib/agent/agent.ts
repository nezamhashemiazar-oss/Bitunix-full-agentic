import { db } from "@/db";
import { chatSessions, messages, memories, skills } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getCfg } from "./config";
import { resolveProvider, hasLlm, completion, type ChatMsg } from "./providers";
import { handleSlash, type PendingAction } from "./commands";
import { TOOL_DEFS, PERMISSION_TOOLS, executeTool } from "./tools";
import { executeEngineCommand, getFullStatus, tick } from "@/lib/trading/engine";
import { setCfg } from "./config";

export interface AgentMessage {
  id: number;
  sessionId: string;
  role: string;
  kind: string;
  content: string;
  meta: unknown;
  createdAt: Date;
}

/* ----------------------------- session helpers ---------------------------- */

export async function getOrCreateSession(sessionId?: string | null) {
  if (sessionId) {
    const rows = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId)).limit(1);
    if (rows.length) return rows[0];
  }
  const id = randomUUID();
  await db.insert(chatSessions).values({ id, title: "New session" });
  return (await db.select().from(chatSessions).where(eq(chatSessions.id, id)).limit(1))[0];
}

async function addMessage(sessionId: string, role: string, content: string, kind = "text", meta?: unknown): Promise<AgentMessage> {
  const ins = await db.insert(messages).values({ sessionId, role, content, kind, meta }).returning();
  await db.update(chatSessions).set({ updatedAt: new Date() }).where(eq(chatSessions.id, sessionId));
  return ins[0] as AgentMessage;
}

/* ------------------------------ system prompt ----------------------------- */

async function buildSystemPrompt(): Promise<string> {
  const soul = await getCfg("soul");
  const thinkOn = (await getCfg("thinkOn")) === "true";
  const memRows = await db.select().from(memories).orderBy(desc(memories.id)).limit(12);
  const skillRows = await db.select().from(skills).where(eq(skills.active, true));
  let trade = "";
  try {
    const st = await getFullStatus();
    trade = `\nTRADING ENGINE STATE: engine=${st.settings.engineOn} mode=${st.settings.mode} feed=${st.settings.dataSource} scan=${st.settings.scanOn} autotrade=${st.settings.autotradeOn} open=${st.positions.length} equity=${st.settings.simEquity.toFixed(2)}USDT. You may drive it with the engine_command tool.`;
  } catch {
    /* engine not ready yet */
  }
  const parts = [
    `You are J+ROCK — a full agentic assistant fused with a crypto futures trading engine. You can read/write project files, run an approved terminal, query and drive the trading engine, search code, save memories, and push to GitHub — always under the user's permission model.`,
    `HONESTY LAW (absolute): never fabricate results, prices, trade outcomes, files read, or permissions. If something failed or is unknown, say so plainly with the reason. Label simulated vs live results. Refuse unsafe actions; explain refusals.`,
    `Be concise, technical, direct. Use monospace-friendly formatting. No emojis.`,
  ];
  if (soul) parts.push(`SOUL (user-defined persona — adopt its tone and values):\n${soul}`);
  if (skillRows.length) parts.push(`ACTIVE SKILLS (follow these instructions):\n${skillRows.map((s) => `• ${s.name}: ${s.instructions || s.description}`).join("\n")}`);
  if (memRows.length) parts.push(`DURABLE MEMORIES:\n${memRows.map((m) => `• ${m.content}`).join("\n")}`);
  if (thinkOn) parts.push(`THINK MODE: reason step by step internally; then give a short "Reasoning:" outline before the answer.`);
  parts.push(trade);
  parts.push(`When the user asks about trading control, use the engine_command tool with the exact plain-language command. When fixing code, prefer reading the actual file with fs_read before proposing changes.`);
  return parts.filter(Boolean).join("\n\n");
}

/* --------------------------- permission machinery -------------------------- */

async function runPendingAction(action: PendingAction): Promise<string> {
  if (action.kind === "github_push") {
    const { pushProjectToGitHub } = await import("./github");
    const token = await getCfg("githubToken");
    const r = await pushProjectToGitHub(token, String(action.payload.repo), String(action.payload.message ?? "J+ROCK sync"));
    await setCfg("githubRepo", String(action.payload.repo));
    return `APPROVED → PUSHED ${r.files} files to ${r.url} (branch ${r.branch}, commit ${r.commitSha.slice(0, 7)})`;
  }
  if (action.kind === "apply_fix") {
    const res = await executeTool("fs_write", { path: action.payload.path, content: action.payload.content });
    return `APPROVED → ${res}. Run /verify to confirm the build.`;
  }
  if (action.kind === "tool") {
    const res = await executeTool(String(action.payload.name), (action.payload.args ?? {}) as Record<string, unknown>);
    return `APPROVED → ${String(action.payload.name)} result:\n\`\`\`\n${res.slice(0, 3000)}\n\`\`\``;
  }
  return "Unknown pending action — ignored.";
}

const YES = /^(yes|y|approve|approved|confirm|ok|go)$/i;
const NO = /^(no|n|cancel|reject|stop)$/i;

/* ------------------------------- local brain ------------------------------- */

function localBrain(text: string): string {
  const t = text.toLowerCase();
  if (/^(hi|hey|hello|yo|sup)\b/.test(t))
    return `J+ROCK online — running LOCAL COGNITION (no LLM connected yet).\nI can still execute every command, run the trading engine, review code heuristically, and push to GitHub.\nNext step for full cognition: /connect_provider [kind] [baseUrl] <key> — I'll AutoSetModelByKey for you.\n/help for the manual.`;
  if (t.includes("what can you do") || t.includes("capab"))
    return `Offline I can: run all trader commands (status, scan now, pnl...), /code_review & /bug_fix heuristically, /team_spawn (template mode), /check_system, /autopsy, /diagnose, memory/skills/soul, GitHub push with your PAT.\nWith a provider key I add: full LLM reasoning, function-calling over fs/terminal/engine/github tools, deep code fixes, real team-spawn debates.\n/connect_provider to upgrade me.`;
  const priceMatch = t.match(/price (?:of )?([a-z0-9]+)/);
  if (priceMatch) return `For a real quote, try: symbols ${priceMatch[1].toUpperCase()}USDT then status — that prints the live engine feed. (No fabricated numbers from me.)`;
  if (t.includes("who are you"))
    return `J+ROCK — agentic assistant + Bitunix futures trading engine in one body. Honest by law, permission-gated, self-diagnosing. /help.`;
  return `I'm on LOCAL COGNITION (no LLM key connected), so I won't pretend to "think" — but here's what I can do right now:\n• trading engine: "status", "scan now", "start trading", "pnl"…\n• diagnostics: /check_system /check_ai /autopsy /diagnose\n• code ops: /code_review /bug_fix /verify /simplify (heuristic until you connect a provider)\n• /connect_provider [kind] [baseUrl] <key> → full agentic mode with tool calling.`;
}

/* ------------------------------ main pipeline ------------------------------ */

export async function handleUserMessage(
  sessionId: string | null,
  text: string
): Promise<{ sessionId: string; replies: AgentMessage[] }> {
  const session = await getOrCreateSession(sessionId);
  const replies: AgentMessage[] = [];
  replies.push(await addMessage(session.id, "user", text));
  if (session.title === "New session") {
    await db.update(chatSessions).set({ title: text.slice(0, 60) }).where(eq(chatSessions.id, session.id));
  }

  // 1. pending permission flow
  const pending = session.pendingAction as PendingAction | null;
  if (pending) {
    if (YES.test(text.trim())) {
      await db.update(chatSessions).set({ pendingAction: null }).where(eq(chatSessions.id, session.id));
      let out: string;
      try {
        out = await runPendingAction(pending);
      } catch (e) {
        out = `APPROVED but FAILED: ${e instanceof Error ? e.message : e}`;
      }
      replies.push(await addMessage(session.id, "agent", out, "tool"));
      return { sessionId: session.id, replies };
    }
    if (NO.test(text.trim())) {
      await db.update(chatSessions).set({ pendingAction: null }).where(eq(chatSessions.id, session.id));
      replies.push(await addMessage(session.id, "agent", "Cancelled — nothing was executed.", "tool"));
      return { sessionId: session.id, replies };
    }
    await db.update(chatSessions).set({ pendingAction: null }).where(eq(chatSessions.id, session.id));
    // fall through — treat text as a new message
  }

  // 2. inline auto-memory ("remember that ...")
  const rem = text.match(/\bremember(?: that)?[:,]?\s+(.{4,400})/i);
  if (rem) {
    await db.insert(memories).values({ content: rem[1].trim(), kind: "preference", source: "user" });
    replies.push(await addMessage(session.id, "agent", `Noted into long-term memory: "${rem[1].trim()}"`, "memory"));
  }

  // 3. trading-engine plain-language commands
  const eng = await executeEngineCommand(text);
  if (eng.handled) {
    replies.push(await addMessage(session.id, "engine", eng.reply, "command"));
    if (/^(start trading|engine on|scan now)/i.test(text)) {
      tick().catch(() => undefined); // kick the loop immediately
    }
    return { sessionId: session.id, replies };
  }

  // 4. slash commands
  if (text.startsWith("/")) {
    const r = await handleSlash(text);
    if (r.pendingAction) {
      await db.update(chatSessions).set({ pendingAction: r.pendingAction }).where(eq(chatSessions.id, session.id));
    }
    replies.push(await addMessage(session.id, "agent", r.reply, r.kind ?? "command", r.meta));
    return { sessionId: session.id, replies };
  }

  // 5. LLM tool loop (or local cognition fallback)
  const prov = await resolveProvider();
  const autoAccept = (await getCfg("autoAccept")) === "true";
  if (!hasLlm(prov)) {
    replies.push(await addMessage(session.id, "agent", localBrain(text)));
    return { sessionId: session.id, replies };
  }

  const historyRows = await db.select().from(messages).where(eq(messages.sessionId, session.id)).orderBy(desc(messages.id)).limit(24);
  const history: ChatMsg[] = historyRows
    .reverse()
    .filter((m) => m.role === "user" || m.role === "agent" || m.role === "engine")
    .map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: `[${m.kind}] ${m.content}`.slice(0, 4000) }));

  const convo: ChatMsg[] = [{ role: "system", content: await buildSystemPrompt() }, ...history];
  const toolTranscript: string[] = [];

  for (let round = 0; round < 6; round++) {
    let result;
    try {
      result = await completion(prov, convo, { tools: TOOL_DEFS, maxTokens: 3000 });
    } catch (e) {
      replies.push(
        await addMessage(
          session.id,
          "agent",
          `LLM call failed: ${e instanceof Error ? e.message : e}\n(Falling back to honest silence beats inventing an answer. /check_ai for provider health.)`
        )
      );
      return { sessionId: session.id, replies };
    }

    if (!result.toolCalls.length) {
      const content = (result.content || "").trim() || "(empty response from model)";
      replies.push(await addMessage(session.id, "agent", content, "text", result.reasoning ? { reasoning: result.reasoning, model: result.model, tools: toolTranscript } : { model: result.model, tools: toolTranscript }));
      return { sessionId: session.id, replies };
    }

    convo.push({ role: "assistant", content: result.content, toolCalls: result.toolCalls });
    for (const call of result.toolCalls) {
      if (PERMISSION_TOOLS.has(call.name) && !autoAccept) {
        const action: PendingAction = { kind: "tool", summary: `${call.name}(${JSON.stringify(call.args).slice(0, 120)})`, payload: { name: call.name, args: call.args } };
        await db.update(chatSessions).set({ pendingAction: action }).where(eq(chatSessions.id, session.id));
        const ask = `I want to run **${call.name}** with:\n\`\`\`json\n${JSON.stringify(call.args, null, 1).slice(0, 800)}\n\`\`\`\n${call.name === "run_terminal" ? "(terminal session)" : call.name === "fs_write" ? "(modifies project files)" : "(external side effect)"}\nType "yes" to approve once, "no" to cancel — or toggle auto-accept in Settings.`;
        if (result.content.trim()) replies.push(await addMessage(session.id, "agent", result.content, "text"));
        replies.push(await addMessage(session.id, "agent", ask, "permission", { tool: call.name }));
        return { sessionId: session.id, replies };
      }
      const out = await executeTool(call.name, call.args).catch((e) => `TOOL ERROR: ${e instanceof Error ? e.message : e}`);
      toolTranscript.push(`${call.name} → ${out.slice(0, 80)}`);
      convo.push({ role: "tool", toolCallId: call.id, name: call.name, content: out.slice(0, 6000) });
    }
  }

  replies.push(await addMessage(session.id, "agent", "Stopped after 6 tool rounds to avoid loops. Ask me to continue if needed.", "text"));
  return { sessionId: session.id, replies };
}

export async function listSessions() {
  return db.select().from(chatSessions).orderBy(desc(chatSessions.updatedAt)).limit(40);
}

export async function sessionMessages(sessionId: string) {
  return db.select().from(messages).where(eq(messages.sessionId, sessionId)).orderBy(messages.id).limit(400);
}

export async function deleteSession(sessionId: string) {
  await db.delete(messages).where(eq(messages.sessionId, sessionId));
  await db.delete(chatSessions).where(eq(chatSessions.id, sessionId));
}
