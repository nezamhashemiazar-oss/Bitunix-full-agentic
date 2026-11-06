import { promises as fsp } from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import type { ToolDef } from "./providers";
import { getCfg, setCfg } from "./config";
import { executeEngineCommand, getFullStatus, scanNow, ensureState } from "@/lib/trading/engine";
import { db } from "@/db";
import { memories } from "@/db/schema";

/* ------------------------------------------------------------------ */
/* Function-calling tool registry. Dangerous tools require permission  */
/* (auto-accept toggle or explicit user approval).                     */
/* ------------------------------------------------------------------ */

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "fs_list",
    description: "List files and directories under a project path (relative to project root).",
    parameters: { type: "object", properties: { path: { type: "string", description: "relative path, default root" } } },
  },
  {
    name: "fs_read",
    description: "Read a project file with line numbers.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
      required: ["path"],
    },
  },
  {
    name: "fs_write",
    description: "Create or overwrite a project file. REQUIRES user permission.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "fs_search",
    description: "Regex search across project files (grep).",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" }, glob: { type: "string", description: "e.g. *.ts" } },
      required: ["pattern"],
    },
  },
  {
    name: "run_terminal",
    description: "Execute a shell command in the project sandbox. REQUIRES terminal permission.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" }, timeoutMs: { type: "number" } },
      required: ["command"],
    },
  },
  {
    name: "engine_command",
    description: "Send any trading-engine command (e.g. 'start trading', 'status', 'leverage 20', 'symbols BTCUSDT ETHUSDT').",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "market_status",
    description: "Get engine status: prices, open positions, signals, PnL.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "market_scan",
    description: "Force an immediate multi-timeframe strategy scan and return candidates.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "memory_save",
    description: "Persist a durable memory (user preference, correction, learning).",
    parameters: {
      type: "object",
      properties: { content: { type: "string" }, kind: { type: "string", description: "note|preference|learning|correction" } },
      required: ["content"],
    },
  },
  {
    name: "github_push",
    description: "Push the whole project to a GitHub repo using the stored PAT. REQUIRES user permission.",
    parameters: {
      type: "object",
      properties: { repo: { type: "string", description: "owner/repo or URL (optional if stored)" }, message: { type: "string" } },
    },
  },
];

export const PERMISSION_TOOLS = new Set(["fs_write", "run_terminal", "github_push"]);

const ROOT = process.cwd();
const BLOCKED = ["node_modules", ".git", ".next", ".env"];

function safePath(p: string): string {
  const abs = path.resolve(ROOT, p || ".");
  if (!abs.startsWith(ROOT)) throw new Error("Path escapes project root — refused.");
  const rel = abs.slice(ROOT.length + 1);
  const top = rel.split(path.sep)[0];
  if (BLOCKED.includes(top) || rel === ".env") throw new Error(`Access to ${top || rel} is blocked for safety.`);
  return abs;
}

function sh(command: string, timeoutMs = 60000): Promise<string> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd: ROOT, timeout: Math.min(timeoutMs, 120000), maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = [stdout, stderr].filter(Boolean).join("\n").slice(0, 6000);
        resolve((err && !stdout ? `exit ${err.code}\n` : "") + (out || "(no output)"));
      }
    );
  });
}

async function walk(dir: string, depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    if (BLOCKED.includes(e.name) || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, depth + 1)));
    else out.push(full);
  }
  return out;
}

export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "fs_list": {
      const dir = safePath(String(args.path ?? "."));
      const files = await walk(dir);
      const rel = files.map((f) => f.slice(ROOT.length + 1));
      return rel.slice(0, 200).join("\n") || "(empty)";
    }
    case "fs_read": {
      const abs = safePath(String(args.path ?? ""));
      const raw = await fsp.readFile(abs, "utf8");
      const lines = raw.split("\n");
      const offset = Math.max(0, Number(args.offset ?? 1) - 1);
      const limit = Math.min(2000, Number(args.limit ?? 400));
      return lines
        .slice(offset, offset + limit)
        .map((l, i) => `${offset + i + 1}: ${l}`)
        .join("\n")
        .slice(0, 20000);
    }
    case "fs_write": {
      const abs = safePath(String(args.path ?? ""));
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, String(args.content ?? ""), "utf8");
      return `WROTE ${String(args.path)} (${String(args.content ?? "").length} bytes)`;
    }
    case "fs_search": {
      const pattern = String(args.pattern ?? "");
      const glob = args.glob ? `--include='${String(args.glob).replace(/'/g, "")}'` : "";
      return sh(`grep -rnE ${glob} -- "${pattern.replace(/"/g, '\\"')}" src 2>/dev/null | head -60`);
    }
    case "run_terminal": {
      const allowed = (await getCfg("allowTerminal")) === "true";
      if (!allowed)
        return "TERMINAL ACCESS DENIED — enable it in Settings (the user explicitly controls this) or run /check_system to see toggles.";
      return sh(String(args.command ?? ""), Number(args.timeoutMs ?? 60000));
    }
    case "engine_command": {
      const res = await executeEngineCommand(String(args.text ?? ""));
      return res.handled ? res.reply : `Not an engine command: "${args.text}"`;
    }
    case "market_status": {
      const st = await getFullStatus();
      return JSON.stringify(
        {
          engine: st.settings.engineOn,
          mode: st.settings.mode,
          feed: st.settings.dataSource,
          prices: st.prices,
          open: st.positions.map((p) => ({ symbol: p.symbol, side: p.side, roi: +p.roi.toFixed(1), pnl: +p.unrealized.toFixed(2) })),
          pnl: st.pnl,
        },
        null,
        1
      );
    }
    case "market_scan": {
      const s = await ensureState();
      const aggs = await scanNow(s);
      return aggs.length
        ? aggs.map((a) => `${a.symbol} ${a.direction} conf ${a.confidence}% agreeing ${a.agreeing}`).join("\n")
        : "No qualifying signals right now.";
    }
    case "memory_save": {
      await db.insert(memories).values({ content: String(args.content ?? "").slice(0, 2000), kind: String(args.kind ?? "note"), source: "agent" });
      return "Memory saved.";
    }
    case "github_push": {
      const { pushProjectToGitHub } = await import("./github");
      const token = await getCfg("githubToken");
      const repo = String(args.repo ?? (await getCfg("githubRepo")) ?? "");
      if (!token) return "GITHUB TOKEN MISSING — set it in Settings → GitHub (or GITHUB_TOKEN env). Not pushing anything without the user's PAT.";
      if (!repo) return "TARGET REPO MISSING — pass repo as owner/repo or store it in Settings.";
      const r = await pushProjectToGitHub(token, repo, String(args.message ?? "J+ROCK sync"));
      await setCfg("githubRepo", repo);
      return `PUSHED ${r.files} files → ${r.url} (branch ${r.branch}, commit ${r.commitSha.slice(0, 7)})`;
    }
    default:
      return `Unknown tool: ${name}`;
  }
}
