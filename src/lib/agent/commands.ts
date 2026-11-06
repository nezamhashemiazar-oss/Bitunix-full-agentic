import { db } from "@/db";
import { memories, skills, mcps, trades, engineEvents, positions } from "@/db/schema";
import { desc, sql, eq } from "drizzle-orm";
import { getCfg, setCfg, mask } from "./config";
import {
  resolveProvider,
  autoSetModelByKey,
  listModels,
  chooseDefaultModel,
  validateModel,
  providerLabel,
  hasLlm,
  completion,
  type ChatMsg,
} from "./providers";
import { executeEngineCommand, getFullStatus, ensureState } from "@/lib/trading/engine";
import { getTickers } from "@/lib/trading/bitunix";

export interface PendingAction {
  kind: "github_push" | "apply_fix" | "tool";
  summary: string;
  payload: Record<string, unknown>;
}

export interface SlashResult {
  reply: string;
  kind?: string;
  meta?: Record<string, unknown>;
  pendingAction?: PendingAction;
}

const slug = (s: string) => s.trim();

/* ------------------------------ code heuristics ------------------------------ */

interface Finding {
  severity: "high" | "medium" | "low";
  rule: string;
  detail: string;
  line?: number;
}

export function analyzeCode(code: string): Finding[] {
  const lines = code.split("\n");
  const findings: Finding[] = [];
  const py = /^\s*(def |import |from |print\()/m.test(code);
  lines.forEach((l, i) => {
    if (/\bvar\s+[A-Za-z_$]/.test(l)) findings.push({ severity: "low", rule: "no-var", detail: "Prefer let/const over var", line: i + 1 });
    if (!py && /[^=!<>]==[^=]/.test(l)) findings.push({ severity: "medium", rule: "eqeqeq", detail: "Loose equality == — use ===", line: i + 1 });
    if (!py && /[^!]!=[^=]/.test(l)) findings.push({ severity: "medium", rule: "eqeqeq", detail: "Loose inequality != — use !==", line: i + 1 });
    if (/\beval\s*\(/.test(l)) findings.push({ severity: "high", rule: "no-eval", detail: "eval() — arbitrary code execution risk", line: i + 1 });
    if (/innerHTML\s*=/.test(l)) findings.push({ severity: "high", rule: "no-innerhtml", detail: "innerHTML assignment — XSS risk if data is untrusted", line: i + 1 });
    if (/console\.(log|debug)\(/.test(l)) findings.push({ severity: "low", rule: "no-console", detail: "Stray console logging", line: i + 1 });
    if (/catch\s*\([^)]*\)\s*{\s*}/.test(l)) findings.push({ severity: "medium", rule: "no-empty-catch", detail: "Empty catch swallows errors silently", line: i + 1 });
    if (/:\s*any\b/.test(l) && !py) findings.push({ severity: "low", rule: "no-any", detail: "TypeScript 'any' erases type safety", line: i + 1 });
    if (py && /except\s*:/.test(l)) findings.push({ severity: "medium", rule: "no-bare-except", detail: "Bare except: catches SystemExit/KeyboardInterrupt too", line: i + 1 });
    if (py && /=\s*\[\s*\]\s*[,)]/.test(l) && /def /.test(l)) findings.push({ severity: "high", rule: "mutable-default", detail: "Mutable default argument — shared across calls", line: i + 1 });
  });
  if (lines.length > 150) findings.push({ severity: "low", rule: "size", detail: `${lines.length} lines — consider splitting into smaller units` });
  const awaitCount = (code.match(/\bawait\b/g) ?? []).length;
  const asyncCount = (code.match(/\basync\b/g) ?? []).length;
  if (!py && asyncCount > awaitCount && /fetch\(|axios|\.then\(/.test(code) && awaitCount === 0)
    findings.push({ severity: "medium", rule: "floating-promise", detail: "Async code without await — possible floating promises" });
  return findings;
}

export function autoFixCode(code: string): { fixed: string; changes: string[] } {
  let fixed = code;
  const changes: string[] = [];
  const varCount = (fixed.match(/\bvar\s+/g) ?? []).length;
  if (varCount) {
    fixed = fixed.replace(/\bvar\s+/g, "let ");
    changes.push(`var → let (${varCount})`);
  }
  const lines = fixed.split("\n");
  let eqCount = 0;
  const out = lines.map((l) => {
    if (l.includes('"') && l.includes("'")) return l;
    if (/^\s*(\/\/|#|\*)/.test(l)) return l;
    let r = l;
    r = r.replace(/([^=!<>]|^)==([^=])/g, (_m, a, b) => { eqCount++; return `${a}===${b}`; });
    r = r.replace(/([^!])!=([^=])/g, (_m, a, b) => { eqCount++; return `${a}!==${b}`; });
    return r;
  });
  fixed = out.join("\n");
  if (eqCount) changes.push(`loose equality → strict (${eqCount})`);
  const trailing = (fixed.match(/ +$/gm) ?? []).length;
  fixed = fixed.replace(/ +$/gm, "");
  if (trailing) changes.push(`trimmed trailing whitespace (${trailing} lines)`);
  return { fixed, changes };
}

function extractCodeOrPath(rest: string): { code?: string; path?: string; note?: string } {
  const fence = rest.match(/```(?:\w+)?\n([\s\S]*?)```/);
  if (fence) return { code: fence[1] };
  const trimmed = rest.replace(/^```(?:\w+)?|```$/g, "").trim();
  if (!trimmed) return {};
  if (/^[\w./@-]+\.\w{1,6}$/.test(trimmed) && !trimmed.includes(" ")) return { path: trimmed };
  if (trimmed.includes("\n") || trimmed.length > 60) return { code: trimmed };
  if (/^[\w./@-]+$/.test(trimmed)) return { path: trimmed };
  return { code: trimmed };
}

async function llmEnrich(system: string, user: string, maxTokens = 1200): Promise<string | null> {
  const prov = await resolveProvider();
  if (!hasLlm(prov)) return null;
  try {
    const msgs: ChatMsg[] = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
    const r = await completion(prov, msgs, { maxTokens, temperature: 0.25 });
    return r.content;
  } catch {
    return null;
  }
}

/* --------------------------------- HELP ----------------------------------- */

const HELP_TEXT = `J+ROCK COMMAND MANUAL

CORE
  /help                       this manual
  /models                     discover models that work with your key (AutoSetModelByKey)
  /set_model <id|auto>        set or auto-pick the active model
  /connect_provider [kind] [baseUrl] <key>   connect + auto-detect working models
  /think [on|off]             extended reasoning mode
  /memory [add|del]           durable memory bank
  /add_skill <name> | <instructions>        define a callable skill
  /skill [name]               list / toggle skills
  /add_soul <text> · /soul    persona ("soul") that steers every answer
  /add_mcp <name> <url> · /mcp  MCP server registry
  /push [owner/repo] [msg]    push the whole project to GitHub (PAT in Settings)

CODE OPS (auto-fix applies with auto-accept ON or after approval)
  /code_review <code|path>    deep review + fix proposals
  /bug_fix <error|code|path>  root-cause + patch
  /verify                     typecheck/lint gate (needs terminal permission)
  /simplify <code|path>       reduce complexity

INTEL
  /team_spawn <task>          spin up specialist sub-agents and synthesize
  /check_ai                   provider/model health + latency
  /check_system               DB, exchange feed, engine, perms
  /autopsy                    post-mortem of losing trades & engine errors
  /diagnose                   full diagnostic + recommended actions

TRADER (also plain language: "start trading", "pnl", "status"...)
  start/stop trading · engine on/off · scan on/off/now
  status · settings trade · pnl · report on/off/interval
  trades_history · tpsl_history · positions history
  close position [SYMBOL|all|#id] · mid management trigger [SYMBOL]
  leverage N · symbols … · timeframes … · max open positions N
  margin mode isolated|cross · position mode hedge|one way
  min confidence N · tf min confidence N · min agreeing strategies N
  breakeven threshold N · trailing trigger N · liq sl distance N
  reversal=true|false · reversal_confidence=N · mode sim|live

Truth policy: I never fabricate results, prices or permissions. If data is
unavailable or an action is refused, I say so and why.`;

/* ------------------------------- dispatcher -------------------------------- */

export async function handleSlash(input: string): Promise<SlashResult> {
  const sp = input.indexOf(" ");
  const cmd = (sp === -1 ? input : input.slice(0, sp)).toLowerCase().replace("/", "");
  const rest = sp === -1 ? "" : input.slice(sp + 1);

  switch (cmd) {
    case "help":
      return { reply: HELP_TEXT, kind: "help" };

    case "models": {
      const p = await resolveProvider();
      if (!p || !p.apiKey)
        return { reply: "No provider key configured. Use /connect_provider [kind] [baseUrl] <key> or Settings → Provider, then /models." };
      const { models, source, warning } = await listModels(p);
      const current = await getCfg("model");
      const list = models.slice(0, 40).map((m) => (m === current ? `→ ${m}   (active)` : `  ${m}`)).join("\n");
      return {
        reply: `MODELS on ${providerLabel(p.kind, p.baseUrl)} (${p.baseUrl}) — ${source === "live" ? "live discovery" : "fallback list"}:\n${list}${models.length > 40 ? `\n  …and ${models.length - 40} more` : ""}${warning ? `\n\nNOTE: ${warning}` : ""}\n\nPick with /set_model <id> or /set_model auto.`,
        kind: "models",
        meta: { models, current },
      };
    }

    case "set_model": {
      const arg = slug(rest);
      if (!arg) return { reply: "Usage: /set_model <model-id> | /set_model auto" };
      const p0 = await resolveProvider();
      if (arg === "auto") {
        if (!p0 || !p0.apiKey) return { reply: "No API key stored. Connect a provider first: /connect_provider <key>" };
        const r = await autoSetModelByKey(p0.baseUrl, p0.apiKey, p0.kind);
        await setCfg("model", r.model);
        return {
          reply: `AutoSetModelByKey → ${r.model}\nprobe: ${r.probe.ok ? `verified working (${r.probe.latencyMs}ms)` : `NOT answering — ${r.probe.error}`}\nsource: ${r.source}${r.warning ? `\n${r.warning}` : ""}`,
          kind: "models",
        };
      }
      const base = p0 ?? (await resolveProvider({ apiKey: "" }));
      if (!base || !base.apiKey) return { reply: "No API key stored. Connect a provider first." };
      const prov = { ...base, model: arg };
      const probe = await validateModel(prov);
      if (!probe.ok)
        return { reply: `Model "${arg}" rejected by the provider: ${probe.error}\nNot setting it. Try /models to see what your key can actually run.` };
      await setCfg("model", arg);
      return { reply: `Active model = ${arg} (verified live, ${probe.latencyMs}ms round-trip).` };
    }

    case "connect_provider": {
      const tokens = rest.split(/\s+/).filter(Boolean);
      if (!tokens.length)
        return {
          reply:
            "Usage: /connect_provider [openai|anthropic|gemini] [baseUrl] <apiKey>\nExamples:\n  /connect_provider openai sk-...\n  /connect_provider https://openrouter.ai/api/v1 sk-or-...\n  /connect_provider anthropic sk-ant-...\nOr paste values in Settings → Provider.",
          meta: { openSettings: "provider" },
        };
      const kinds = new Set(["openai", "anthropic", "gemini", "openrouter", "groq", "deepseek", "xai", "together", "local"]);
      let kind = "";
      let baseUrl = "";
      let key = "";
      for (const t of tokens) {
        const tl = t.toLowerCase();
        if (kinds.has(tl) && !kind) kind = tl;
        else if (/^https?:\/\//.test(t)) baseUrl = t;
        else if (t.length >= 8) key = t;
      }
      if (!key) return { reply: "I couldn't find an API key in that. Paste the key (or use Settings). Nothing was stored." };
      const kindMap: Record<string, string> = { openrouter: "openai", groq: "openai", deepseek: "openai", xai: "openai", together: "openai", local: "openai" };
      const baseMap: Record<string, string> = {
        openrouter: "https://openrouter.ai/api/v1",
        groq: "https://api.groq.com/openai/v1",
        deepseek: "https://api.deepseek.com",
        xai: "https://api.x.ai/v1",
        together: "https://api.together.xyz/v1",
        local: "http://localhost:11434/v1",
        openai: "https://api.openai.com/v1",
        anthropic: "https://api.anthropic.com",
        gemini: "https://generativelanguage.googleapis.com",
      };
      const prov = kindMap[kind] ?? kind;
      const base = baseUrl || baseMap[kind] || "";
      const r = await autoSetModelByKey(base, key, prov || undefined);
      await setCfg("apiKey", key);
      await setCfg("baseUrl", r.baseUrl);
      await setCfg("provider", r.kind);
      await setCfg("model", r.model);
      return {
        reply:
          `PROVIDER CONNECTED: ${providerLabel(r.kind, r.baseUrl)}\n` +
          `key stored server-side: ${mask(key)}\n` +
          `AutoSetModelByKey → ${r.model} (${r.source} discovery)` +
          `${r.probe.ok ? ` — verified live in ${r.probe.latencyMs}ms` : ` — WARNING probe failed: ${r.probe.error}`}` +
          `${r.warning ? `\n${r.warning}` : ""}` +
          `\nAvailable: ${r.models.slice(0, 8).join(", ")}${r.models.length > 8 ? ` +${r.models.length - 8} more` : ""}\nSwitch with /set_model <id>.`,
        kind: "models",
        meta: { models: r.models, current: r.model },
      };
    }

    case "think": {
      const cur = (await getCfg("thinkOn")) === "true";
      const on = rest ? /^(on|true|1)$/i.test(rest.trim()) : !cur;
      await setCfg("thinkOn", String(on));
      return { reply: `Think mode ${on ? "ON — I reason step-by-step and expose the chain where the provider supports it" : "OFF"}.` };
    }

    case "memory": {
      const m = rest.match(/^(add|del|delete|clear)\s*(.*)$/i);
      if (m && /^add$/i.test(m[1])) {
        if (!m[2].trim()) return { reply: "Usage: /memory add <fact or preference>" };
        await db.insert(memories).values({ content: m[2].trim().slice(0, 2000), kind: "note", source: "user" });
        return { reply: `Memory saved: "${m[2].trim()}"` };
      }
      if (m && /^(del|delete)$/i.test(m[1])) {
        const id = parseInt(m[2], 10);
        if (!id) return { reply: "Usage: /memory del <id>" };
        await db.delete(memories).where(eq(memories.id, id));
        return { reply: `Memory #${id} deleted.` };
      }
      if (m && /^clear$/i.test(m[1])) {
        await db.delete(memories);
        return { reply: "All memories wiped." };
      }
      const rows = await db.select().from(memories).orderBy(desc(memories.id)).limit(20);
      if (!rows.length) return { reply: "Memory bank empty. Add with /memory add <text> — I also auto-learn from your corrections." };
      return {
        reply: "MEMORY BANK (latest 20):\n" + rows.map((r) => `#${r.id} [${r.kind}] ${r.content}`).join("\n"),
        kind: "memory",
      };
    }

    case "add_skill": {
      const pipe = rest.indexOf("|");
      const name = slug(pipe === -1 ? rest : rest.slice(0, pipe)).toLowerCase().replace(/\s+/g, "_");
      const instructions = pipe === -1 ? "" : rest.slice(pipe + 1).trim();
      if (!name) return { reply: 'Usage: /add_skill <name> | <instructions>\ne.g. /add_skill security_audit | Always check auth, injection and secret handling.' };
      const existing = await db.select().from(skills).where(eq(skills.name, name)).limit(1);
      if (existing.length) {
        await db.update(skills).set({ instructions, description: instructions.slice(0, 120), active: true }).where(eq(skills.name, name));
      } else {
        await db.insert(skills).values({ name, instructions, description: instructions.slice(0, 120), active: true });
      }
      return { reply: `Skill "${name}" registered and ACTIVATED${instructions ? "" : " (no instructions yet — add some with the | separator)"}. Toggle: /skill ${name}` };
    }

    case "skill": {
      const name = slug(rest).toLowerCase();
      if (name) {
        const rows = await db.select().from(skills).where(eq(skills.name, name)).limit(1);
        if (!rows.length) return { reply: `No skill "${name}". Create it: /add_skill ${name} | <instructions>` };
        await db.update(skills).set({ active: !rows[0].active }).where(eq(skills.name, name));
        return { reply: `Skill "${name}" ${!rows[0].active ? "ACTIVATED" : "deactivated"}.${!rows[0].active ? "\nInstructions: " + rows[0].instructions : ""}` };
      }
      const rows = await db.select().from(skills).orderBy(desc(skills.createdAt));
      if (!rows.length) return { reply: "No skills defined. /add_skill <name> | <instructions>" };
      return { reply: "SKILLS:\n" + rows.map((s) => `${s.active ? "●" : "○"} ${s.name} — ${s.description || "(no description)"}`).join("\n") };
    }

    case "add_soul": {
      const soul = rest.trim();
      if (!soul) return { reply: "Usage: /add_soul <persona text> — defines how I speak and decide." };
      await setCfg("soul", soul.slice(0, 3000));
      return { reply: `Soul updated (${soul.length} chars). Every answer, review and trade decision now routes through it.\nPreview: "${soul.slice(0, 140)}${soul.length > 140 ? "…" : ""}"`, kind: "soul" };
    }

    case "soul": {
      const soul = await getCfg("soul");
      return {
        reply: soul ? `CURRENT SOUL (${soul.length} chars):\n${soul}` : "No custom soul set — I'm running the default J+ROCK persona: precise, honest, security-aware, zero hype. Set one with /add_soul <text>.",
        kind: "soul",
      };
    }

    case "add_mcp": {
      const parts = rest.split(/\s+/).filter(Boolean);
      if (parts.length < 2) return { reply: "Usage: /add_mcp <name> <server-url>" };
      const [name, url] = parts;
      let status = "registered";
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "jrock", version: "1.0" } } }),
          signal: AbortSignal.timeout(6000),
        });
        status = res.ok ? "reachable" : `unreachable (HTTP ${res.status})`;
      } catch {
        status = "unreachable (network refused)";
      }
      const existing = await db.select().from(mcps).where(eq(mcps.name, name)).limit(1);
      if (existing.length) await db.update(mcps).set({ url, status }).where(eq(mcps.name, name));
      else await db.insert(mcps).values({ name, url, status });
      return { reply: `MCP "${name}" → ${url}\ninitialize probe: ${status}` };
    }

    case "mcp": {
      const rows = await db.select().from(mcps).orderBy(desc(mcps.createdAt));
      if (!rows.length) return { reply: "No MCP servers registered. /add_mcp <name> <url>" };
      return { reply: "MCP REGISTRY:\n" + rows.map((r) => `• ${r.name} — ${r.url} [${r.status}]`).join("\n") };
    }

    case "code_review":
    case "code_reveiew": {
      const got = extractCodeOrPath(rest);
      let code = got.code;
      let source = "pasted code";
      if (got.path) {
        try {
          const { executeTool } = await import("./tools");
          code = await executeTool("fs_read", { path: got.path, limit: 1200 });
          source = got.path;
        } catch (e) {
          return { reply: `Cannot read ${got.path}: ${e instanceof Error ? e.message : e}` };
        }
      }
      if (!code) return { reply: "Give me code (paste after the command, fenced or not) or a project path:\n/code_review src/lib/trading/engine.ts" };
      const findings = analyzeCode(code);
      const deep = await llmEnrich(
        "You are a brutally honest senior code reviewer. List concrete bugs, risks and improvements with line references. Be terse, no filler, no invented issues.",
        `FILE: ${source}\n\`\`\`\n${code.slice(0, 12000)}\n\`\`\``
      );
      const header = `CODE REVIEW — ${source}\nstatic analysis: ${findings.length} finding(s)\n`;
      const stat = findings.length
        ? findings.slice(0, 25).map((f) => `  [${f.severity.toUpperCase()}] L${f.line ?? "?"} ${f.rule}: ${f.detail}`).join("\n")
        : "  clean on heuristic pass";
      const body = deep ? `\n\nDEEP REVIEW (LLM):\n${deep}` : `\n\n(No LLM connected — heuristic pass only. /connect_provider for deep review.)`;
      const auto = (await getCfg("autoAccept")) === "true";
      const { changes } = autoFixCode(code);
      return {
        reply: header + stat + body + (changes.length ? `\n\nAvailable SAFE auto-fixes: ${changes.join(", ")}${auto ? " (auto-accept ON — use /bug_fix with same input to apply to files)" : " — reply /bug_fix <same input> and approve to apply"}."` : ""),
        kind: "review",
        meta: { findings: findings.length },
      };
    }

    case "bug_fix": {
      const got = extractCodeOrPath(rest);
      let code = got.code;
      let targetPath = got.path;
      if (got.path) {
        try {
          const { executeTool } = await import("./tools");
          const raw = await executeTool("fs_read", { path: got.path, limit: 1200 });
          code = raw.split("\n").map((l) => l.replace(/^\d+: /, "")).join("\n");
        } catch (e) {
          return { reply: `Cannot read ${got.path}: ${e instanceof Error ? e.message : e}` };
        }
      }
      if (!code) return { reply: "Paste the broken code or error, or give a path: /bug_fix src/app/api/chat/route.ts" };
      const findings = analyzeCode(code);
      const deep = await llmEnrich(
        "You are a debugging engine. Find the root cause, then output a corrected version in a single fenced block. If you are not sure, say exactly what to instrument. Never invent fixes.",
        `\`\`\`\n${code.slice(0, 12000)}\n\`\`\``
      );
      const auto = (await getCfg("autoAccept")) === "true";
      if (targetPath) {
        const { fixed, changes } = autoFixCode(code);
        if (changes.length) {
          if (auto) {
            const { executeTool } = await import("./tools");
            const w = await executeTool("fs_write", { path: targetPath, content: fixed });
            return { reply: `BUG FIX APPLIED (auto-accept ON) → ${w}\nchanges: ${changes.join(", ")}\nstatic findings addressed where safe; ${findings.length} heuristic finding(s) total.${deep ? `\n\nLLM analysis:\n${deep}` : ""}\nRun /verify to confirm the tree still compiles.`, kind: "review" };
          }
          return {
            reply: `BUG FIX READY for ${targetPath} (not applied — auto-accept is OFF).\nchanges: ${changes.join(", ")}\nheuristics: ${findings.length} finding(s).${deep ? `\n\nLLM analysis:\n${deep}` : ""}\n\nType "yes" to apply the safe patch to the file.`,
            kind: "permission",
            pendingAction: { kind: "apply_fix", summary: `Apply ${changes.join(", ")} to ${targetPath}`, payload: { path: targetPath, content: fixed } },
          };
        }
        return { reply: `No safe auto-patch found for ${targetPath}.${deep ? `\nLLM analysis:\n${deep}` : " Connect an LLM (/connect_provider) for semantic fixes."}`, kind: "review" };
      }
      return { reply: `BUG ANALYSIS:\nheuristics: ${findings.length ? findings.map((f) => `[${f.severity}] L${f.line ?? "?"} ${f.detail}`).join("\n") : "none"}${deep ? `\n\nROOT CAUSE + FIX (LLM):\n${deep}` : "\n(No LLM connected.)"}`, kind: "review" };
    }

    case "simplify":
    case "simpilfy": {
      const got = extractCodeOrPath(rest);
      let code = got.code;
      let source = "pasted code";
      if (got.path) {
        try {
          const { executeTool } = await import("./tools");
          code = await executeTool("fs_read", { path: got.path, limit: 1200 });
          source = got.path;
        } catch (e) {
          return { reply: `Cannot read ${got.path}: ${e instanceof Error ? e.message : e}` };
        }
      }
      if (!code) return { reply: "Usage: /simplify <code|path>" };
      const deep = await llmEnrich(
        "Refactor for simplicity: fewer concepts, shorter functions, remove dead code, keep behavior identical. Return the simplified code in one fenced block plus a 3-bullet rationale.",
        `FILE: ${source}\n\`\`\`\n${code.slice(0, 12000)}\n\`\`\``
      );
      if (deep) return { reply: `SIMPLIFY — ${source}\n${deep}`, kind: "review" };
      const lines = code.split("\n");
      const { fixed, changes } = autoFixCode(code);
      return {
        reply: `SIMPLIFY (heuristic mode — connect an LLM for real refactoring)\n${source}: ${lines.length} lines, ${analyzeCode(code).length} finding(s).\nCosmetic simplifications available: ${changes.join(", ") || "none"}.\nSemantic simplification needs an LLM — it would be dishonest to "simplify" blindly.`,
        kind: "review",
        meta: { preview: fixed.slice(0, 2000) },
      };
    }

    case "verify": {
      const term = (await getCfg("allowTerminal")) === "true";
      const auto = (await getCfg("autoAccept")) === "true";
      const run = async () => {
        const { executeTool } = await import("./tools");
        const t1 = await executeTool("run_terminal", { command: "npx tsc --noEmit --pretty false 2>&1 | head -30", timeoutMs: 120000 });
        return t1;
      };
      if (!term) return { reply: "TERMINAL PERMISSION OFF — I can't execute tsc/eslint without your consent. Enable it in Settings → Permissions (terminal access), then /verify again. I refuse to bypass this.", meta: { openSettings: "permissions" } };
      if (!auto) {
        return {
          reply: `VERIFY will execute: npx tsc --noEmit\nApprove? (type "yes", or turn auto-accept on)`,
          kind: "permission",
          pendingAction: { kind: "tool", summary: "Run npx tsc --noEmit", payload: { name: "run_terminal", args: { command: "npx tsc --noEmit --pretty false 2>&1 | head -30", timeoutMs: 120000 } } },
        };
      }
      const out = await run();
      return { reply: `VERIFY RESULT (auto-accept ON):\n\`\`\`\n${out || "clean"}\n\`\`\``, kind: "diagnostic" };
    }

    case "team_spawn": {
      const task = rest.trim();
      if (!task) return { reply: "Usage: /team_spawn <task or code> — spawns ARCHITECT, ENGINEER and QA/SECURITY sub-agents and synthesizes their verdicts." };
      const prov = await resolveProvider();
      const personas = [
        { name: "ARCHITECT", sys: "You are ARCHITECT, a systems designer. Assess structure, boundaries, data flow, failure modes. Bullet points only." },
        { name: "ENGINEER", sys: "You are ENGINEER, a pragmatic implementer. Give the concrete implementation plan and code-level pitfalls. Bullet points only." },
        { name: "QA-SECURITY", sys: "You are QA-SECURITY. Hunt edge cases, races, injection, secret leakage, test plan. Bullet points only." },
      ];
      if (!hasLlm(prov)) {
        return {
          reply:
            `TEAM SPAWNED (local heuristics — no LLM connected)\n\n` +
            personas.map((p) => `▸ ${p.name}\n  - Connect a provider (/connect_provider) for this agent's genuine analysis.\n  - Heuristic pass: task length ${task.length} chars, code findings: ${analyzeCode(task).length}`).join("\n\n") +
            `\n\nSYNTHESIS: I will not fabricate specialist opinions without a model behind them.`,
          kind: "team",
        };
      }
      const verdicts: string[] = [];
      for (const persona of personas) {
        try {
          const r = await completion(prov, [
            { role: "system", content: persona.sys },
            { role: "user", content: task.slice(0, 6000) },
          ], { maxTokens: 700, temperature: 0.4 });
          verdicts.push(`▸ ${persona.name}\n${r.content.trim()}`);
        } catch (e) {
          verdicts.push(`▸ ${persona.name}\n  (failed: ${e instanceof Error ? e.message : e})`);
        }
      }
      return { reply: `TEAM SPAWNED — ${personas.length} sub-agents on: "${task.slice(0, 80)}${task.length > 80 ? "…" : ""}"\n\n${verdicts.join("\n\n")}`, kind: "team", meta: { agents: personas.map((p) => p.name) } };
    }

    case "check_ai": {
      const p = await resolveProvider();
      const thinkOn = (await getCfg("thinkOn")) === "true";
      const auto = (await getCfg("autoAccept")) === "true";
      const term = (await getCfg("allowTerminal")) === "true";
      if (!p || !p.apiKey)
        return {
          reply: `AI HEALTH\nprovider: none connected (running local cognition)\nmodel: —\ntoggles: think=${thinkOn} autoAccept=${auto} terminal=${term}\n\n→ /connect_provider [kind] [baseUrl] <key> then /models`,
          kind: "diagnostic",
        };
      const probe = p.model ? await validateModel(p) : { ok: false, latencyMs: 0, error: "no model set" };
      const { models, source } = await listModels(p);
      return {
        reply:
          `AI HEALTH\nprovider: ${providerLabel(p.kind, p.baseUrl)} (${p.baseUrl})\nkey: ${mask(p.apiKey)}\nmodel: ${p.model || "(none)"} — ${probe.ok ? `responding in ${probe.latencyMs}ms` : `FAILING: ${probe.error}`}\ndiscovery: ${models.length} model(s) visible to this key (${source})\ntoggles: think=${thinkOn} autoAccept=${auto} terminal=${term}` +
          (!probe.ok ? `\n\nRECOMMEND: /set_model auto` : ""),
        kind: "diagnostic",
      };
    }

    case "check_system": {
      return { reply: await systemCheck(), kind: "diagnostic" };
    }

    case "autopsy": {
      return { reply: await autopsy(), kind: "diagnostic" };
    }

    case "diagnose": {
      const sys = await systemCheck();
      const aut = await autopsy();
      return { reply: `DIAGNOSIS\n\n=== SYSTEM ===\n${sys}\n\n=== AUTOPSY ===\n${aut}`, kind: "diagnostic" };
    }

    case "push":
    case "github": {
      const parts = rest.split(/\s+/).filter(Boolean);
      const repo = parts[0]?.includes("/") || parts[0]?.includes("github.com") ? parts.shift()! : await getCfg("githubRepo");
      const message = parts.join(" ") || `sync ${new Date().toISOString().slice(0, 16)}`;
      const token = await getCfg("githubToken");
      if (!token) return { reply: "No GitHub PAT stored. Add it in Settings → GitHub (or GITHUB_TOKEN env), then /push owner/repo.", meta: { openSettings: "github" } };
      if (!repo) return { reply: "Which repo? /push owner/repo [message] — or save a default in Settings → GitHub." };
      const auto = (await getCfg("autoAccept")) === "true";
      if (auto) {
        try {
          const { pushProjectToGitHub } = await import("./github");
          const r = await pushProjectToGitHub(token, repo, message);
          await setCfg("githubRepo", repo);
          return { reply: `PUSHED (auto-accept ON)\nrepo: ${r.url}\nbranch: ${r.branch} · commit ${r.commitSha.slice(0, 7)} · ${r.files} files`, kind: "command" };
        } catch (e) {
          return { reply: `PUSH FAILED: ${e instanceof Error ? e.message : e}\n(Reported honestly — check PAT scope "repo" and repo name.)` };
        }
      }
      return {
        reply: `READY TO PUSH → ${repo}\nmessage: "${message}"\nThis creates the repo if missing and uploads project files (src/, configs; .env/node_modules excluded). Type "yes" to execute, or enable auto-accept.`,
        kind: "permission",
        pendingAction: { kind: "github_push", summary: `Push project to github.com/${repo.replace(/^https?:\/\/github\.com\//, "")}`, payload: { repo, message } },
      };
    }

    case "auto_accept": {
      const cur = (await getCfg("autoAccept")) === "true";
      const on = rest ? /^(on|true|1)$/i.test(rest.trim()) : !cur;
      await setCfg("autoAccept", String(on));
      return { reply: `Auto-accept edits ${on ? "ON — patches/pushes execute without per-action approval (terminal still needs its own toggle)" : "OFF"}.` };
    }

    default:
      // slash-form of trading commands: /trade start etc.
      {
        const asText = `${cmd} ${rest}`.trim();
        const eng = await executeEngineCommand(asText);
        if (eng.handled) return { reply: eng.reply, kind: "command" };
      }
      return { reply: `Unknown command /${cmd}. /help for the manual.` };
  }
}

/* --------------------------- composite checks ------------------------------ */

async function systemCheck(): Promise<string> {
  const lines: string[] = [];
  try {
    await db.execute(sql`select 1`);
    lines.push("postgres: connected");
  } catch (e) {
    lines.push(`postgres: FAIL — ${e instanceof Error ? e.message : e}`);
  }
  const t0 = Date.now();
  try {
    await getTickers(["BTCUSDT"]);
    lines.push(`bitunix fapi: reachable (${Date.now() - t0}ms)`);
  } catch (e) {
    lines.push(`bitunix fapi: UNREACHABLE (${e instanceof Error ? e.message : e}) — engine falls back to offline-sim feed, flagged in UI`);
  }
  const s = await ensureState();
  lines.push(`engine: ${s.engineOn ? "ON" : "OFF"} | scan=${s.scanOn} autotrade=${s.autotradeOn} mode=${s.mode} feed=${s.dataSource}`);
  const open = await db.select({ id: positions.id }).from(positions).where(eq(positions.status, "OPEN"));
  lines.push(`positions open: ${open.length}/${s.maxOpenPositions} | sim equity ${s.simEquity.toFixed(2)} USDT`);
  const p = await resolveProvider();
  lines.push(`llm: ${p?.apiKey ? `${providerLabel(p.kind, p.baseUrl)} model=${p.model || "unset"}` : "not connected"}`);
  lines.push(`perms: autoAccept=${await getCfg("autoAccept")} terminal=${await getCfg("allowTerminal")}`);
  const mem = process.memoryUsage();
  lines.push(`process: rss ${(mem.rss / 1048576).toFixed(0)}MB · heap ${(mem.heapUsed / 1048576).toFixed(0)}MB · node ${process.version}`);
  return lines.join("\n");
}

async function autopsy(): Promise<string> {
  const closed = await db.select().from(trades).where(sql`${trades.pnl} is not null`).orderBy(desc(trades.id)).limit(30);
  const errors = await db.select().from(engineEvents).where(eq(engineEvents.kind, "error")).orderBy(desc(engineEvents.id)).limit(8);
  if (!closed.length && !errors.length) return "AUTOPSY: nothing to dissect — no closed trades or engine errors yet.";
  const losers = closed.filter((t) => (t.pnl ?? 0) < 0);
  const winners = closed.filter((t) => (t.pnl ?? 0) >= 0);
  const lines = [`AUTOPSY — last ${closed.length} closes: ${winners.length}W/${losers.length}L`];
  const byReason = new Map<string, { n: number; pnl: number }>();
  for (const t of losers) {
    const key = (t.reason || "unknown").split(":")[0];
    const cur = byReason.get(key) ?? { n: 0, pnl: 0 };
    byReason.set(key, { n: cur.n + 1, pnl: cur.pnl + (t.pnl ?? 0) });
  }
  for (const [k, v] of byReason) lines.push(`• ${k}: ${v.n} losses, ${v.pnl.toFixed(2)} USDT`);
  const avgConfW = winners.length ? winners.reduce((a, t) => a + (t.confidence ?? 0), 0) / winners.length : 0;
  const avgConfL = losers.length ? losers.reduce((a, t) => a + (t.confidence ?? 0), 0) / losers.length : 0;
  if (losers.length) {
    lines.push(`avg entry confidence — winners ${avgConfW.toFixed(1)}% vs losers ${avgConfL.toFixed(1)}%`);
    if (avgConfL >= avgConfW - 2) lines.push(`LESSON: confidence is not separating winners from losers — raise 'min confidence' and 'min agreeing strategies'.`);
    else lines.push(`LESSON: losers carried lower confidence — the thresholds are doing their job; keep them.`);
  }
  if (errors.length) {
    lines.push("recent engine errors:");
    for (const e of errors) lines.push(`  ✗ ${e.text.slice(0, 120)}`);
  }
  return lines.join("\n");
}
