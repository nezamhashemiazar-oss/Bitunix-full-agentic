"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Send, TerminalSquare, ShieldQuestion, Trash2, Plus } from "lucide-react";
import { Markdown } from "./Markdown";

export interface Msg {
  id: number;
  role: string;
  kind: string;
  content: string;
  meta?: { reasoning?: string; model?: string } | null;
  createdAt: string;
}

export interface SessionLite {
  id: string;
  title: string;
  updatedAt: string;
}

const COMMAND_MENU: { cmd: string; hint: string }[] = [
  { cmd: "/help", hint: "full command manual" },
  { cmd: "/models", hint: "discover models working with your key" },
  { cmd: "/set_model auto", hint: "AutoSetModelByKey → best model" },
  { cmd: "/set_model ", hint: "set a specific model id" },
  { cmd: "/connect_provider ", hint: "[kind] [baseUrl] <apiKey>" },
  { cmd: "/think", hint: "toggle extended reasoning" },
  { cmd: "/memory", hint: "list · /memory add <text>" },
  { cmd: "/add_skill ", hint: "<name> | <instructions>" },
  { cmd: "/skill", hint: "list / toggle skills" },
  { cmd: "/add_soul ", hint: "persona text steering the agent" },
  { cmd: "/soul", hint: "view current soul" },
  { cmd: "/add_mcp ", hint: "<name> <server url>" },
  { cmd: "/mcp", hint: "list MCP servers" },
  { cmd: "/code_review ", hint: "<code|path> deep review" },
  { cmd: "/bug_fix ", hint: "<error|code|path> patch" },
  { cmd: "/verify", hint: "typecheck gate (needs terminal perm)" },
  { cmd: "/simplify ", hint: "<code|path> refactor" },
  { cmd: "/team_spawn ", hint: "<task> specialist sub-agents" },
  { cmd: "/check_ai", hint: "provider/model health" },
  { cmd: "/check_system", hint: "DB/feed/engine/permissions" },
  { cmd: "/autopsy", hint: "post-mortem losses & errors" },
  { cmd: "/diagnose", hint: "full diagnostic" },
  { cmd: "/push ", hint: "owner/repo — GitHub sync (PAT)" },
  { cmd: "/auto_accept", hint: "toggle auto-accept edits" },
];

const QUICK = ["status", "scan now", "pnl", "start trading", "stop trading", "engine on", "engine off", "/check_system"];

const KIND_COLOR: Record<string, string> = {
  command: "text-[#3dffa8]",
  report: "text-[#3dffa8]",
  review: "text-[#ffc24b]",
  diagnostic: "text-[#b48cff]",
  permission: "text-[#ff5470]",
  team: "text-[#29e6ff]",
  help: "text-[#7fd8ff]",
  memory: "text-[#7fd8ff]",
  models: "text-[#7fd8ff]",
  soul: "text-[#ff9ee6]",
  tool: "text-[#ffc24b]",
};

export default function Chat(props: {
  messages: Msg[];
  sessions: SessionLite[];
  sessionId: string | null;
  onSelectSession: (id: string | null) => void;
  onDeleteSession: (id: string) => void;
  busy: boolean;
  onSend: (text: string) => void;
}) {
  const { messages, sessions, sessionId, busy, onSend } = props;
  const [input, setInput] = useState("");
  const [menuIdx, setMenuIdx] = useState(0);
  const [showReason, setShowReason] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, busy]);

  const menu = useMemo(() => {
    if (!input.startsWith("/")) return [];
    const q = input.toLowerCase();
    return COMMAND_MENU.filter((c) => c.cmd.slice(0, q.length) === q || c.cmd.includes(q)).slice(0, 9);
  }, [input]);

  useEffect(() => setMenuIdx(0), [menu.length]);

  const lastPermissionId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].kind === "permission") return messages[i].id;
    return null;
  }, [messages]);

  const submit = (raw?: string) => {
    const text = (raw ?? input).trim();
    if (!text || busy) return;
    setInput("");
    onSend(text);
  };

  return (
    <div className="flex h-full min-w-0">
      {/* sessions rail */}
      <div className="hidden w-44 shrink-0 flex-col border-r border-[#12202e] bg-[#060a10] md:flex">
        <div className="flex items-center justify-between px-3 py-2 text-[10px] uppercase tracking-[0.15em] text-[#4a6376]">
          sessions
          <button className="text-[#29e6ff] hover:text-white" onClick={() => props.onSelectSession(null)} title="New session">
            <Plus size={13} />
          </button>
        </div>
        <div className="flex-1 space-y-1 overflow-y-auto px-2 pb-2">
          {sessions.map((s) => (
            <div
              key={s.id}
              onClick={() => props.onSelectSession(s.id)}
              className={`group flex cursor-pointer items-center gap-1 rounded border px-2 py-1.5 text-[11px] ${
                s.id === sessionId ? "border-[#1d3448] bg-[#0b1420] text-[#bfeaff]" : "border-transparent text-[#5b7484] hover:border-[#12202e] hover:text-[#9fc4d8]"
              }`}
            >
              <TerminalSquare size={11} className="shrink-0 opacity-60" />
              <span className="min-w-0 flex-1 truncate">{s.title}</span>
              <button
                className="opacity-0 transition group-hover:opacity-100 hover:text-[#ff5470]"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onDeleteSession(s.id);
                }}
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
          {sessions.length === 0 && <div className="px-2 text-[10px] text-[#3a4f61]">no history yet</div>}
        </div>
      </div>

      {/* stream */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="quickbar flex flex-wrap gap-1 border-b border-[#12202e] px-3 py-2">
          {QUICK.map((q) => (
            <button key={q} className="chip text-[#5b7484] hover:border-[#2a4358] hover:text-[#9fd8ec]" onClick={() => submit(q)}>
              {q}
            </button>
          ))}
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {messages.length === 0 && (
            <div className="mt-10 text-center text-[#4a6376]">
              <div className="glow-cyan mb-2 text-lg tracking-[0.3em]">J+ROCK</div>
              <div className="text-[11px]">
                type <span className="text-[#29e6ff]">/help</span> · talk to me · or command the engine:{" "}
                <span className="text-[#3dffa8]">start trading</span>
              </div>
              <div className="mt-1 text-[10px] opacity-70">i never fabricate results — simulated outcomes are labeled, missing data is admitted.</div>
            </div>
          )}
          {messages.map((m) => {
            const isUser = m.role === "user";
            const isEngine = m.role === "engine";
            const accent = isUser ? "#ffc24b" : isEngine ? "#3dffa8" : "#29e6ff";
            return (
              <div key={m.id} className="msg-in" style={{ borderLeft: `2px solid ${accent}33` }}>
                <div className="flex items-center gap-2 pl-2 text-[9px] uppercase tracking-[0.18em]">
                  <span style={{ color: accent }}>{isUser ? "you" : isEngine ? "engine" : "j+rock"}</span>
                  <span className={KIND_COLOR[m.kind] ?? "text-[#3a4f61]"}>{m.kind}</span>
                  {m.meta?.model && <span className="text-[#3a4f61]">{m.meta.model}</span>}
                  <span className="ml-auto text-[#2b3f50]">{new Date(m.createdAt).toLocaleTimeString()}</span>
                </div>
                <div className="pl-3 pt-0.5 text-[12.5px]">
                  <Markdown text={m.content} />
                  {m.meta?.reasoning && (
                    <button className="mt-1 text-[10px] text-[#4a6376] underline hover:text-[#7fd8ff]" onClick={() => setShowReason(showReason === m.id ? null : m.id)}>
                      {showReason === m.id ? "hide reasoning" : "show reasoning"}
                    </button>
                  )}
                  {showReason === m.id && m.meta?.reasoning && (
                    <pre className="code-block mt-1 whitespace-pre-wrap text-[#5b7484]">{m.meta.reasoning}</pre>
                  )}
                  {m.kind === "permission" && m.id === lastPermissionId && (
                    <div className="mt-2 flex items-center gap-2">
                      <ShieldQuestion size={13} className="text-[#ff5470]" />
                      <button className="btn btn-green" onClick={() => submit("yes")} disabled={busy}>
                        APPROVE
                      </button>
                      <button className="btn btn-danger" onClick={() => submit("no")} disabled={busy}>
                        REJECT
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {busy && <div className="pl-3 text-[11px] text-[#29e6ff]"><span className="typing">thinking</span></div>}
          <div ref={bottomRef} />
        </div>

        {/* input */}
        <div className="relative border-t border-[#12202e] p-3">
          {menu.length > 0 && (
            <div className="panel absolute bottom-full left-3 right-3 z-20 mb-1 overflow-hidden">
              {menu.map((c, i) => (
                <button
                  key={c.cmd}
                  className={`flex w-full items-baseline gap-3 px-3 py-1.5 text-left text-[11px] hover:bg-[#0d1a26] ${i === menuIdx ? "bg-[#0d1a26] text-[#bfeaff]" : "text-[#7c9cae]"}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setInput(c.cmd);
                    taRef.current?.focus();
                  }}
                >
                  <span className="text-[#29e6ff]">{c.cmd}</span>
                  <span className="truncate text-[10px] text-[#4a6376]">{c.hint}</span>
                </button>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
            <span className="glow-cyan pb-2 text-sm select-none">❯</span>
            <textarea
              ref={taRef}
              className="input max-h-36 min-h-[38px] flex-1 resize-none"
              placeholder="/help · ask anything · or command the engine"
              value={input}
              rows={1}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = Math.min(140, e.target.scrollHeight) + "px";
              }}
              onKeyDown={(e) => {
                if (menu.length > 0 && e.key === "ArrowDown") {
                  e.preventDefault();
                  setMenuIdx((menuIdx + 1) % menu.length);
                } else if (menu.length > 0 && e.key === "ArrowUp") {
                  e.preventDefault();
                  setMenuIdx((menuIdx - 1 + menu.length) % menu.length);
                } else if (menu.length > 0 && (e.key === "Tab" || (e.key === "Enter" && input.startsWith("/") && !input.includes(" ")))) {
                  e.preventDefault();
                  setInput(menu[menuIdx]?.cmd ?? input);
                } else if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                } else if (e.key === "Escape") {
                  setInput("");
                }
              }}
            />
            <button className="btn btn-primary flex items-center gap-1" onClick={() => submit()} disabled={busy || !input.trim()}>
              <Send size={13} /> SEND
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
