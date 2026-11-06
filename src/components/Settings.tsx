"use client";

import { useState } from "react";
import { X, KeyRound, Cpu, GitBranch, ShieldCheck, Landmark, Wand2 } from "lucide-react";

export interface ConfigView {
  provider: string;
  baseUrl: string;
  model: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  thinkOn: boolean;
  autoAccept: boolean;
  allowTerminal: boolean;
  soul: string;
  bitunixKeyMasked: string;
  hasBitunix: boolean;
  githubTokenMasked: string;
  hasGithub: boolean;
  githubRepo: string;
  skills: { name: string; description: string; active: boolean }[];
  mcps: { name: string; url: string; status: string }[];
  memories: { id: number; kind: string; content: string }[];
}

const TABS = ["provider", "brain", "permissions", "exchange", "github"] as const;
type Tab = (typeof TABS)[number];

export default function Settings(props: {
  open: boolean;
  onClose: () => void;
  view: ConfigView | null;
  initialTab?: Tab;
  onRefresh: () => void;
  onCommand: (text: string) => void;
}) {
  const { open, view } = props;
  const [tab, setTab] = useState<Tab>(props.initialTab ?? "provider");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>("");

  const [kind, setKind] = useState("auto");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [probe, setProbe] = useState("");
  const [soul, setSoul] = useState<string | null>(null);
  const [bxKey, setBxKey] = useState("");
  const [bxSecret, setBxSecret] = useState("");
  const [ghToken, setGhToken] = useState("");
  const [ghRepo, setGhRepo] = useState("");
  const [skillName, setSkillName] = useState("");
  const [skillInstr, setSkillInstr] = useState("");
  const [mcpName, setMcpName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");

  if (!open) return null;

  const post = async (patch: Record<string, string>) => {
    setBusy(true);
    try {
      await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      props.onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const probeModels = async (save: boolean) => {
    if (!apiKey.trim()) {
      setProbe("paste an API key first — I probe with the real key, I don't guess.");
      return;
    }
    setBusy(true);
    setProbe("probing provider…");
    try {
      const res = await fetch("/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl, apiKey, provider: kind === "auto" ? undefined : kind, save }),
      });
      const j = await res.json();
      if (j.error) {
        setProbe(`FAILED: ${j.error}`);
        return;
      }
      setModels(j.models ?? []);
      setProbe(
        `${j.provider} @ ${j.baseUrl}\nfound ${j.models?.length ?? 0} model(s) (${j.source}) · auto-picked: ${j.model}\nlive probe: ${j.probe?.ok ? `OK (${j.probe.latencyMs}ms)` : `FAIL — ${j.probe?.error}`}${j.warning ? `\n${j.warning}` : ""}${save ? "\nSAVED as active provider." : ""}`
      );
      if (save) props.onRefresh();
    } catch (e) {
      setProbe(`FAILED: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  };

  const pushGithub = async () => {
    setBusy(true);
    setNote("pushing to GitHub…");
    try {
      if (ghToken) await post({ githubToken: ghToken });
      if (ghRepo) await post({ githubRepo: ghRepo });
      const res = await fetch("/api/github", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      const j = await res.json();
      setNote(j.error ? `PUSH FAILED (honestly): ${j.error}` : `PUSHED ${j.files} files → ${j.url}\nbranch ${j.branch} · commit ${j.commitSha?.slice(0, 7)}`);
      props.onRefresh();
    } catch (e) {
      setNote(`PUSH FAILED: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  };

  const Toggle = (o: { label: string; desc: string; on: boolean; cfgKey: string }) => (
    <div className="flex items-center justify-between rounded border border-[#12202e] p-2">
      <div>
        <div className="text-[11px] text-[#bfeaff]">{o.label}</div>
        <div className="text-[10px] text-[#4a6376]">{o.desc}</div>
      </div>
      <button className={`btn ${o.on ? "btn-green" : ""}`} disabled={busy} onClick={() => post({ [o.cfgKey]: String(!o.on) })}>
        {o.on ? "ON" : "OFF"}
      </button>
    </div>
  );

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={props.onClose}>
      <div className="panel flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-[#12202e] px-4 py-2.5">
          <div className="flex gap-1">
            {TABS.map((t) => (
              <button
                key={t}
                className={`rounded px-2.5 py-1 text-[11px] uppercase tracking-wider ${tab === t ? "bg-[#0d1a26] text-[#29e6ff]" : "text-[#5b7484] hover:text-[#9fd8ec]"}`}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </div>
          <button className="text-[#5b7484] hover:text-white" onClick={props.onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-4 text-[11px]">
          {tab === "provider" && (
            <>
              <div className="text-[#5b7484]">
                Paste any provider key — <span className="text-[#29e6ff]">AutoSetModelByKey</span> discovers which models the key can run, auto-picks the best and live-probes it. No hallucinated model lists.
              </div>
              <div className="text-[10px] text-[#4a6376]">current: {view?.hasApiKey ? `${view.apiKeyMasked} · ${view.provider || "auto"} · model ${view.model || "unset"}` : "none configured"}</div>
              <div className="grid grid-cols-[110px_1fr] items-center gap-2">
                <span className="text-[#5b7484]">kind</span>
                <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
                  {["auto", "openai", "anthropic", "gemini"].map((k) => (
                    <option key={k} value={k}>{k}</option>
                  ))}
                </select>
                <span className="text-[#5b7484]">base url</span>
                <input className="input" placeholder="https://api.openai.com/v1 · openrouter · groq · deepseek · localhost…" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
                <span className="text-[#5b7484]">api key</span>
                <input className="input" type="password" placeholder="sk-… / sk-ant-… / AIza… / gsk_…" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
              </div>
              <div className="flex gap-2">
                <button className="btn btn-primary flex items-center gap-1.5" onClick={() => probeModels(false)} disabled={busy}>
                  <Cpu size={12} /> PROBE MODELS
                </button>
                <button className="btn btn-green flex items-center gap-1.5" onClick={() => probeModels(true)} disabled={busy}>
                  <Wand2 size={12} /> PROBE + CONNECT (AutoSet)
                </button>
              </div>
              {probe && <pre className="code-block whitespace-pre-wrap text-[10px] text-[#9fd8ec]">{probe}</pre>}
              {models.length > 0 && (
                <div className="max-h-40 overflow-y-auto rounded border border-[#12202e] p-2">
                  {models.slice(0, 60).map((m) => (
                    <button key={m} className="block w-full truncate text-left text-[10px] text-[#7c9cae] hover:text-[#29e6ff]" onClick={() => post({ model: m })}>
                      {m === view?.model ? "→ " : "  "}{m}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {tab === "brain" && (
            <>
              <div className="text-[10px] uppercase tracking-[0.18em] text-[#4a6376]">soul — persona injected into every answer</div>
              <textarea
                className="input min-h-[90px]"
                placeholder={"e.g. Cold, precise systems engineer. Never hype. Always cite evidence. Risk-first mindset."}
                value={soul ?? view?.soul ?? ""}
                onChange={(e) => setSoul(e.target.value)}
              />
              <button className="btn btn-primary" disabled={busy} onClick={() => post({ soul: soul ?? "" }).then(() => props.onRefresh())}>
                SAVE SOUL
              </button>

              <div className="pt-2 text-[10px] uppercase tracking-[0.18em] text-[#4a6376]">skills</div>
              <div className="flex flex-wrap gap-1.5">
                {(view?.skills ?? []).map((s) => (
                  <button key={s.name} className={`chip ${s.active ? "border-[#3dffa8]/50 text-[#3dffa8]" : "text-[#5b7484]"}`} title={s.description} onClick={() => props.onCommand(`/skill ${s.name}`)}>
                    {s.active ? "●" : "○"} {s.name}
                  </button>
                ))}
                {!(view?.skills ?? []).length && <span className="text-[10px] text-[#3a4f61]">none yet</span>}
              </div>
              <div className="grid grid-cols-[140px_1fr_auto] gap-1.5">
                <input className="input" placeholder="skill name" value={skillName} onChange={(e) => setSkillName(e.target.value)} />
                <input className="input" placeholder="instructions (what it makes me do)" value={skillInstr} onChange={(e) => setSkillInstr(e.target.value)} />
                <button className="btn" disabled={!skillName.trim()} onClick={() => { props.onCommand(`/add_skill ${skillName} | ${skillInstr}`); setSkillName(""); setSkillInstr(""); }}>
                  ADD
                </button>
              </div>

              <div className="pt-2 text-[10px] uppercase tracking-[0.18em] text-[#4a6376]">mcp servers</div>
              <div className="flex flex-wrap gap-1.5">
                {(view?.mcps ?? []).map((m) => (
                  <span key={m.name} className="chip text-[#7c9cae]">{m.name} · {m.status}</span>
                ))}
                {!(view?.mcps ?? []).length && <span className="text-[10px] text-[#3a4f61]">none registered</span>}
              </div>
              <div className="grid grid-cols-[140px_1fr_auto] gap-1.5">
                <input className="input" placeholder="name" value={mcpName} onChange={(e) => setMcpName(e.target.value)} />
                <input className="input" placeholder="https://mcp-server.example/sse" value={mcpUrl} onChange={(e) => setMcpUrl(e.target.value)} />
                <button className="btn" disabled={!mcpName.trim() || !mcpUrl.trim()} onClick={() => { props.onCommand(`/add_mcp ${mcpName} ${mcpUrl}`); setMcpName(""); setMcpUrl(""); }}>
                  ADD
                </button>
              </div>

              <div className="pt-2 text-[10px] uppercase tracking-[0.18em] text-[#4a6376]">memory bank</div>
              <div className="max-h-32 space-y-1 overflow-y-auto text-[10px] text-[#5b7484]">
                {(view?.memories ?? []).map((m) => (
                  <div key={m.id}>#{m.id} [{m.kind}] {m.content}</div>
                ))}
                {!(view?.memories ?? []).length && <span>empty — say "remember that …" or /memory add</span>}
              </div>
            </>
          )}

          {tab === "permissions" && view && (
            <>
              <div className="text-[#5b7484]">You own the blast radius. Nothing destructive runs without these gates.</div>
              <Toggle label="Auto-accept edits" desc="File writes, fixes and pushes execute without per-action approval" on={view.autoAccept} cfgKey="autoAccept" />
              <Toggle label="Terminal access" desc="Allow me to execute shell commands in the project sandbox (/verify, git…)" on={view.allowTerminal} cfgKey="allowTerminal" />
              <Toggle label="Think mode" desc="Extended reasoning — slower, surfaced reasoning when provider supports it" on={view.thinkOn} cfgKey="thinkOn" />
            </>
          )}

          {tab === "exchange" && (
            <>
              <div className="flex items-center gap-2 rounded border border-[#ffc24b]/30 bg-[#ffc24b]/5 p-2 text-[#ffc24b]">
                <Landmark size={13} />
                <span>Bitunix futures keys. Stored server-side only. Without them the engine runs in SIM on real/public market data — it never fakes fills.</span>
              </div>
              <div className="text-[10px] text-[#4a6376]">current: {view?.hasBitunix ? `key ${view.bitunixKeyMasked}` : "not configured"}</div>
              <div className="grid grid-cols-[110px_1fr] items-center gap-2">
                <span className="text-[#5b7484]">api key</span>
                <input className="input" type="password" value={bxKey} onChange={(e) => setBxKey(e.target.value)} />
                <span className="text-[#5b7484]">secret</span>
                <input className="input" type="password" value={bxSecret} onChange={(e) => setBxSecret(e.target.value)} />
              </div>
              <div className="flex gap-2">
                <button className="btn btn-primary" disabled={busy || !bxKey || !bxSecret} onClick={() => post({ bitunixKey: bxKey, bitunixSecret: bxSecret })}>
                  <span className="flex items-center gap-1"><KeyRound size={11} /> SAVE KEYS</span>
                </button>
                <button className="btn" onClick={() => props.onCommand("mode sim")}>SIM MODE</button>
                <button className="btn btn-danger" onClick={() => props.onCommand("mode live")}>GO LIVE (real orders)</button>
              </div>
              <div className="text-[10px] text-[#3a4f61]">
                live mode refuses to arm unless keys exist. engine signs requests with the Bitunix double-SHA256 scheme; TP/SL are attached per order (LAST_PRICE trigger, MARKET execution).
              </div>
            </>
          )}

          {tab === "github" && (
            <>
              <div className="flex items-center gap-2 text-[#5b7484]">
                <GitBranch size={13} />
                <span>Personal Access Token (classic, scope: <b>repo</b>) + target. I create the repo if missing and push the project tree.</span>
              </div>
              <div className="text-[10px] text-[#4a6376]">
                current: {view?.hasGithub ? `token ${view.githubTokenMasked}` : "no token"} · repo {view?.githubRepo || "unset"}
              </div>
              <div className="grid grid-cols-[110px_1fr] items-center gap-2">
                <span className="text-[#5b7484]">PAT token</span>
                <input className="input" type="password" placeholder="ghp_… / github_pat_…" value={ghToken} onChange={(e) => setGhToken(e.target.value)} />
                <span className="text-[#5b7484]">repo</span>
                <input className="input" placeholder="owner/repo or https://github.com/owner/repo" value={ghRepo} onChange={(e) => setGhRepo(e.target.value)} />
              </div>
              <div className="flex gap-2">
                <button className="btn" disabled={busy} onClick={() => post({ ...(ghToken ? { githubToken: ghToken } : {}), ...(ghRepo ? { githubRepo: ghRepo } : {}) })}>
                  SAVE
                </button>
                <button className="btn btn-green flex items-center gap-1.5" disabled={busy} onClick={pushGithub}>
                  <ShieldCheck size={12} /> PUSH NOW
                </button>
              </div>
              {note && <pre className="code-block whitespace-pre-wrap text-[10px] text-[#9fd8ec]">{note}</pre>}
              <div className="text-[10px] text-[#3a4f61]">excludes: node_modules, .next, .git, .env* — secrets never leave the sandbox.</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
