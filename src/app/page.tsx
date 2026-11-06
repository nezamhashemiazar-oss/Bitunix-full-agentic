"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Chat, { type Msg, type SessionLite } from "@/components/Chat";
import Dashboard, { type EngineStatus } from "@/components/Dashboard";
import Settings, { type ConfigView } from "@/components/Settings";
import { Settings2, GitBranch, Hexagon, PanelRight, PanelRightClose, Plus } from "lucide-react";

export const dynamic = "force-dynamic";

export default function Page() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionLite[]>([]);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [cfg, setCfg] = useState<ConfigView | null>(null);
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"provider" | "brain" | "permissions" | "exchange" | "github">("provider");
  const [showDash, setShowDash] = useState(true);
  const sessionRef = useRef<string | null>(null);
  sessionRef.current = sessionId;

  const loadConfig = useCallback(async () => {
    try {
      const r = await fetch("/api/config", { cache: "no-store" });
      setCfg(await r.json());
    } catch {
      /* transient */
    }
  }, []);

  const loadChat = useCallback(async () => {
    try {
      const sid = sessionRef.current;
      const r = await fetch(sid ? `/api/chat?sessionId=${sid}` : "/api/chat", { cache: "no-store" });
      const j = await r.json();
      setSessions(j.sessions ?? []);
      if (sid) setMessages(j.messages ?? []);
      else if (!sessionRef.current && j.sessions?.length) {
        // stay on fresh composer; don't auto-open old sessions
      }
    } catch {
      /* transient */
    }
  }, []);

  // engine tick = heartbeat; advances scanner/trader and returns status
  useEffect(() => {
    let dead = false;
    const beat = async () => {
      try {
        const r = await fetch("/api/engine", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tick: true }),
        });
        if (!dead && r.ok) setStatus(await r.json());
      } catch {
        /* transient */
      }
    };
    beat();
    const i = setInterval(beat, 4500);
    return () => {
      dead = true;
      clearInterval(i);
    };
  }, []);

  useEffect(() => {
    loadChat();
    const i = setInterval(loadChat, 4000);
    return () => clearInterval(i);
  }, [loadChat]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const send = useCallback(
    async (text: string) => {
      setBusy(true);
      const optimistic: Msg = { id: -Date.now(), role: "user", kind: "text", content: text, createdAt: new Date().toISOString() };
      setMessages((m) => [...m, optimistic]);
      try {
        const r = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: sessionRef.current, message: text }),
        });
        const j = await r.json();
        if (j.sessionId && !sessionRef.current) setSessionId(j.sessionId);
        if (j.replies) {
          setMessages((cur) => [...cur.filter((m) => m.id !== optimistic.id), ...(j.replies as Msg[])]);
        }
        loadConfig();
      } catch (e) {
        setMessages((cur) => [
          ...cur,
          { id: -Date.now() - 1, role: "agent", kind: "text", content: `transport error: ${e instanceof Error ? e.message : e}`, createdAt: new Date().toISOString() },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [loadConfig]
  );

  const deleteSession = useCallback(
    async (id: string) => {
      await fetch(`/api/chat?sessionId=${id}`, { method: "DELETE" }).catch(() => undefined);
      if (sessionId === id) {
        setSessionId(null);
        setMessages([]);
      }
      loadChat();
    },
    [loadChat, sessionId]
  );

  // dashboard quick commands → engine route (with reply surfaced to dashboard note)
  const dashCommand = useCallback(async (text: string): Promise<string | void> => {
    const r = await fetch("/api/engine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const j = await r.json();
    if (r.ok) {
      const pr = await fetch("/api/engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tick: true }),
      }).catch(() => null);
      if (pr && pr.ok) setStatus(await pr.json());
    }
    return j.reply;
  }, []);

  // settings quick commands → chat pipeline (silent, results appear in stream)
  const silentCommand = useCallback(
    (text: string) => {
      fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sessionRef.current, message: text }),
      }).then(() => loadChat());
    },
    [loadChat]
  );

  const s = status?.settings;
  const chips = [
    { label: "ENGINE", on: !!s?.engineOn },
    { label: "AUTOTRADE", on: !!s?.autotradeOn },
    { label: s?.mode === "live" ? "LIVE" : "SIM", warn: s?.mode === "live" },
    { label: s?.dataSource === "offline-sim" ? "OFFLINE FEED" : "BITUNIX FEED", on: s?.dataSource !== "offline-sim", dim: true },
  ];

  return (
    <div className="scanlines flex h-screen flex-col overflow-hidden">
      {/* header */}
      <header className="relative z-10 flex items-center gap-3 border-b border-[#12202e] bg-[#05090f]/90 px-4 py-2 backdrop-blur">
        <div className="flex items-center gap-2">
          <Hexagon size={17} className="text-[#29e6ff]" />
          <span className="glow-cyan text-sm font-bold tracking-[0.25em]">J+ROCK</span>
          <span className="hidden text-[9px] uppercase tracking-[0.2em] text-[#4a6376] sm:inline">agentic trading console</span>
        </div>
        <div className="hidden gap-1.5 md:flex">
          {chips.map((c) => (
            <span key={c.label} className="chip">
              <span className={`dot ${c.warn ? "warn" : c.on ? "on" : "off"}`} />
              <span className={c.warn ? "text-[#ff5470]" : c.dim ? "text-[#5b7484]" : ""}>{c.label}</span>
            </span>
          ))}
          <span className="chip text-[#5b7484]">
            {cfg?.model ? cfg.model : "no-llm"} · acc:{cfg?.autoAccept ? "on" : "off"} · term:{cfg?.allowTerminal ? "on" : "off"}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <button className="btn flex items-center gap-1" onClick={() => setSessionId(null)} title="New session">
            <Plus size={13} />
            <span className="hidden sm:inline">NEW</span>
          </button>
          <button
            className="btn flex items-center gap-1"
            onClick={() => {
              setSettingsTab("github");
              setSettingsOpen(true);
            }}
          >
            <GitBranch size={13} />
            <span className="hidden sm:inline">GITHUB</span>
          </button>
          <button className="btn flex items-center gap-1 btn-primary" onClick={() => setSettingsOpen(true)}>
            <Settings2 size={13} />
            <span className="hidden sm:inline">SETTINGS</span>
          </button>
          <button className="btn lg:hidden" onClick={() => setShowDash(!showDash)}>
            {showDash ? <PanelRightClose size={13} /> : <PanelRight size={13} />}
          </button>
        </div>
      </header>

      {/* body */}
      <main className="relative z-10 flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <Chat
            messages={messages}
            sessions={sessions}
            sessionId={sessionId}
            onSelectSession={(id) => {
              setSessionId(id);
              if (!id) setMessages([]);
            }}
            onDeleteSession={deleteSession}
            busy={busy}
            onSend={send}
          />
        </div>
        <aside className={`w-[340px] shrink-0 border-l border-[#12202e] bg-[#05090f] ${showDash ? "" : "hidden"} hidden lg:block`}>
          <Dashboard status={status} onCommand={dashCommand} />
        </aside>
        {showDash && (
          <div className="fixed inset-x-0 bottom-0 top-12 z-30 bg-[#05090f] lg:hidden">
            <Dashboard status={status} onCommand={dashCommand} />
          </div>
        )}
      </main>

      <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        view={cfg}
        initialTab={settingsTab}
        onRefresh={loadConfig}
        onCommand={silentCommand}
      />
    </div>
  );
}
