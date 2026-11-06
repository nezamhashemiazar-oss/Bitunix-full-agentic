import { promises as fsp } from "node:fs";
import path from "node:path";

/* GitHub push via the REST Git Data API — works without a git binary.  */

const GH = "https://api.github.com";

async function gh<T = unknown>(token: string, method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url.startsWith("http") ? url : `${GH}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "jrock-agent",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 204) return {} as T;
  const text = await res.text();
  let json: unknown = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* non-json */
  }
  if (!res.ok) {
    const msg = (json as { message?: string }).message ?? text.slice(0, 200);
    throw new Error(`GitHub ${method} ${url} → ${res.status}: ${msg}`);
  }
  return json as T;
}

export function parseRepoSpec(spec: string): { owner: string; repo: string } | { repo: string } {
  const clean = spec.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
  const parts = clean.split("/").filter(Boolean);
  if (parts.length >= 2) return { owner: parts[parts.length - 2], repo: parts[parts.length - 1] };
  return { repo: parts[0] ?? "" };
}

const INCLUDE_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".json", ".css", ".md", ".html", ".sql", ".txt"]);
const INCLUDE_ROOT = new Set([
  "package.json",
  "tsconfig.json",
  "next.config.ts",
  "postcss.config.mjs",
  "eslint.config.mjs",
  "drizzle.config.json",
  ".gitignore",
]);
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".vercel", "dist", "coverage"]);

async function collectFiles(root: string): Promise<{ rel: string; content: Buffer }[]> {
  const out: { rel: string; content: Buffer }[] = [];
  async function walk(dir: string, depth: number) {
    if (depth > 6 || out.length > 400) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else {
        const ext = path.extname(e.name);
        const isRootInclude = depth === 0 && INCLUDE_ROOT.has(e.name);
        const inSrc = rel.startsWith("src/") || rel.startsWith("public/");
        if (e.name === ".env" || e.name.endsWith(".env")) continue;
        if (!isRootInclude && !(inSrc && INCLUDE_EXT.has(ext))) continue;
        if (!isRootInclude && !inSrc && !INCLUDE_EXT.has(ext)) continue;
        try {
          const buf = await fsp.readFile(full);
          if (buf.length > 900_000) continue;
          out.push({ rel, content: buf });
        } catch {
          /* unreadable file skipped */
        }
      }
    }
  }
  await walk(root, 0);
  return out;
}

const README = `# J+ROCK — Agentic Trading Console

Full agentic AI assistant with function-calling tools, slash-command system,
multi-provider LLM support (OpenAI-compatible / Anthropic / Gemini) with
AutoSetModelByKey model discovery, a soul/persona layer, skills, memory,
MCP registry, self-review (/code_review, /bug_fix, /verify, /simplify),
multi-agent spawn (/team_spawn), diagnostics (/check_system, /autopsy,
/diagnose) and a built-in Bitunix futures trading engine with 16 strategies,
agent-managed TP/SL (liquidation-aware stops, breakeven + trailing) and
paper/live modes.

Self-deployed by J+ROCK.
`;

export interface PushResult {
  url: string;
  branch: string;
  files: number;
  commitSha: string;
}

export async function pushProjectToGitHub(token: string, spec: string, message: string): Promise<PushResult> {
  const parsed = parseRepoSpec(spec);
  let owner = "owner" in parsed ? parsed.owner : "";
  const repoName = parsed.repo;
  if (!repoName) throw new Error("Repository name required (owner/repo or URL).");

  const authHeaders = "ok";
  void authHeaders;
  if (!owner) {
    const user = await gh<{ login: string }>(token, "GET", "/user");
    owner = user.login;
  }
  const repoPath = `/repos/${owner}/${repoName}`;

  let exists = true;
  try {
    await gh(token, "GET", repoPath);
  } catch {
    exists = false;
  }
  if (!exists) {
    await gh(token, "POST", "/user/repos", { name: repoName, private: false, auto_init: false });
  }

  const files = await collectFiles(process.cwd());
  files.push({ rel: "README.md", content: Buffer.from(README, "utf8") });

  // create blobs
  const treeItems: { path: string; mode: string; type: string; sha: string }[] = [];
  const CONCURRENCY = 6;
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    const blobs = await Promise.all(
      batch.map((f) =>
        gh<{ sha: string }>(token, "POST", `${repoPath}/git/blobs`, {
          content: f.content.toString("base64"),
          encoding: "base64",
        })
      )
    );
    batch.forEach((f, j) => treeItems.push({ path: f.rel, mode: "100644", type: "blob", sha: blobs[j].sha }));
  }

  const branch = "main";
  let baseCommit: string | null = null;
  let baseTree: string | null = null;
  try {
    const ref = await gh<{ object: { sha: string } }>(token, "GET", `${repoPath}/git/ref/heads/${branch}`);
    baseCommit = ref.object.sha;
    const commit = await gh<{ tree: { sha: string } }>(token, "GET", `${repoPath}/git/commits/${baseCommit}`);
    baseTree = commit.tree.sha;
  } catch {
    /* fresh repo — no base */
  }

  const tree = await gh<{ sha: string }>(token, "POST", `${repoPath}/git/trees`, {
    ...(baseTree ? { base_tree: baseTree } : {}),
    tree: treeItems,
  });
  const commit = await gh<{ sha: string }>(token, "POST", `${repoPath}/git/commits`, {
    message: `[J+ROCK] ${message}`.slice(0, 72),
    tree: tree.sha,
    ...(baseCommit ? { parents: [baseCommit] } : {}),
  });
  if (baseCommit) {
    await gh(token, "PATCH", `${repoPath}/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
  } else {
    await gh(token, "POST", `${repoPath}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
  }
  return { url: `https://github.com/${owner}/${repoName}`, branch, files: files.length, commitSha: commit.sha };
}
