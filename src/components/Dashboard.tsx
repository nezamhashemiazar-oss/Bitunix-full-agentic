"use client";

import { useMemo, useState } from "react";
import {
  Power,
  Radar,
  BotMessageSquare,
  Megaphone,
  XOctagon,
  Activity,
  ChevronDown,
  ChevronRight,
  Zap,
} from "lucide-react";

export interface EngineStatus {
  settings: {
    engineOn: boolean;
    scanOn: boolean;
    autotradeOn: boolean;
    reportOn: boolean;
    mode: string;
    dataSource: string;
    symbols: string[];
    timeframes: string[];
    leverage: number;
    marginMode: string;
    positionMode: string;
    maxOpenPositions: number;
    riskPerTradePct: number;
    simEquity: number;
    minConfidence: number;
    tfMinConfidence: number;
    minAgreeingStrategies: number;
    scanIntervalSec: number;
    reportIntervalSec: number;
    breakevenThresholdPct: number;
    trailingTriggerRoiPct: number;
    liqSlDistancePct: number;
    reversalEnabled: boolean;
    reversalConfidence: number;
  };
  prices: Record<string, number>;
  positions: {
    id: number;
    symbol: string;
    side: string;
    entryPrice: number;
    markPrice: number | null;
    qty: number;
    leverage: number;
    liqPrice: number | null;
    tpPrice: number | null;
    slPrice: number | null;
    roi: number;
    unrealized: number;
    confidence: number;
    mode: string;
  }[];
  signals: { id: number; symbol: string; timeframe: string; strategy: string; direction: string; confidence: number; createdAt: string }[];
  events: { id: number; kind: string; text: string; createdAt: string }[];
  equityCurve: { t: string; equity: number }[];
  pnl: { realized: number; unrealized: number; total: number; openCount: number; closedCount: number; winRate: number };
  strategies: { id: string; name: string; category: string; description: string; indicators: string[] }[];
  lastScan: { symbol: string; direction: string; confidence: number; agreeing: number }[];
}

const fnum = (n: number | null | undefined, dp = 4) => {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000) return n.toFixed(2);
  if (Math.abs(n) >= 1) return n.toFixed(dp === 4 ? 3 : dp);
  return n.toFixed(6);
};

function Sparkline({ data }: { data: { t: string; equity: number }[] }) {
  const path = useMemo(() => {
    if (data.length < 2) return "";
    const vals = data.map((d) => d.equity);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    return vals
      .map((v, i) => `${((i / (vals.length - 1)) * 100).toFixed(2)},${(30 - ((v - min) / span) * 26).toFixed(2)}`)
      .join(" ");
  }, [data]);
  const up = data.length > 1 && data[data.length - 1].equity >= data[0].equity;
  return (
    <svg viewBox="0 0 100 32" preserveAspectRatio="none" className="h-12 w-full">
      {path && (
        <polyline points={path} fill="none" stroke={up ? "#3dffa8" : "#ff5470"} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
      )}
      {!path && <text x="50" y="18" textAnchor="middle" fill="#33455a" fontSize="6">collecting equity points…</text>}
    </svg>
  );
}

function QSet(props: { label: string; value: string; onApply: (v: string) => void; suffix?: string }) {
  const [v, setV] = useState(props.value);
  return (
    <label className="flex items-center gap-1 text-[10px] text-[#5b7484]">
      <span className="w-[86px] shrink-0 truncate" title={props.label}>{props.label}</span>
      <input
        className="input !w-14 !px-1.5 !py-1 text-center"
        defaultValue={props.value}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && props.onApply(v)}
      />
      <button className="btn !px-1.5 !py-1 text-[9px]" onClick={() => props.onApply(v)}>
        set
      </button>
    </label>
  );
}

export default function Dashboard(props: {
  status: EngineStatus | null;
  onCommand: (text: string) => Promise<string | void>;
}) {
  const { status } = props;
  const [note, setNote] = useState("");
  const [showStrat, setShowStrat] = useState(false);
  const [busy, setBusy] = useState(false);

  const cmd = async (text: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await props.onCommand(text);
      if (typeof res === "string" && res) setNote(res);
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return <div className="flex h-full items-center justify-center text-[11px] text-[#4a6376]">engine telemetry loading…</div>;
  }
  const s = status.settings;

  const Toggle = (o: { on: boolean; label: string; icon: React.ReactNode; onClick: () => void }) => (
    <button className={`btn flex items-center gap-1.5 ${o.on ? "btn-green" : ""}`} onClick={o.onClick} disabled={busy}>
      {o.icon}
      {o.label} <span className={o.on ? "text-[#3dffa8]" : "text-[#5b7484]"}>{o.on ? "ON" : "off"}</span>
    </button>
  );

  return (
    <div className="flex h-full flex-col overflow-y-auto p-2.5 text-[11px]">
      {/* controls */}
      <div className="panel mb-2 p-2.5">
        <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-[0.18em] text-[#4a6376]">
          <span>trader engine</span>
          <span className={`chip ${s.mode === "live" ? "border-[#ff5470]/50 text-[#ff5470]" : "text-[#7fd8ff]"}`}>
            {s.mode === "live" ? "LIVE MONEY" : "SIM"} · {s.dataSource === "offline-sim" ? "offline feed" : "bitunix feed"}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <Toggle on={s.engineOn} label="ENGINE" icon={<Power size={12} />} onClick={() => cmd(s.engineOn ? "engine off" : "engine on")} />
          <Toggle on={s.scanOn} label="SCAN" icon={<Radar size={12} />} onClick={() => cmd(s.scanOn ? "scan off" : "scan on")} />
          <Toggle on={s.autotradeOn} label="AUTOTRADE" icon={<BotMessageSquare size={12} />} onClick={() => cmd(s.autotradeOn ? "stop trading" : "start trading")} />
          <Toggle on={s.reportOn} label="REPORT" icon={<Megaphone size={12} />} onClick={() => cmd(s.reportOn ? "report off" : "report on")} />
        </div>
        <div className="mt-2 flex gap-1.5">
          <button className="btn btn-primary flex-1" onClick={() => cmd("scan now")} disabled={busy || !s.engineOn}>
            <span className="flex items-center justify-center gap-1"><Zap size={11} /> SCAN NOW</span>
          </button>
          <button className="btn flex-1" onClick={() => cmd("mid management trigger")} disabled={busy || status.positions.length === 0}>
            MID-MGMT
          </button>
        </div>
        {note && <div className="code-block mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap text-[10px] text-[#9fd8ec]">{note}</div>}
      </div>

      {/* prices */}
      <div className="panel mb-2 p-2.5">
        <div className="mb-1.5 text-[10px] uppercase tracking-[0.18em] text-[#4a6376]">watchlist</div>
        <div className="flex flex-wrap gap-1.5">
          {s.symbols.map((sym) => (
            <span key={sym} className="chip">
              <span className="text-[#5b7484]">{sym.replace("USDT", "")}</span>
              <span className="text-[#bfeaff]">{fnum(status.prices[sym])}</span>
            </span>
          ))}
        </div>
      </div>

      {/* equity / pnl */}
      <div className="panel mb-2 p-2.5">
        <div className="mb-1 flex items-baseline justify-between">
          <span className="text-[10px] uppercase tracking-[0.18em] text-[#4a6376]">equity (sim)</span>
          <span className={`text-[15px] ${status.pnl.total >= 0 ? "glow-green" : "text-[#ff5470]"}`}>
            {s.simEquity.toFixed(2)} <span className="text-[9px] text-[#5b7484]">USDT</span>
          </span>
        </div>
        <Sparkline data={status.equityCurve} />
        <div className="mt-1.5 grid grid-cols-3 gap-1 text-center text-[10px]">
          <div className="rounded border border-[#12202e] p-1">
            <div className="text-[#4a6376]">realized</div>
            <div className={status.pnl.realized >= 0 ? "text-[#3dffa8]" : "text-[#ff5470]"}>
              {status.pnl.realized >= 0 ? "+" : ""}{status.pnl.realized.toFixed(2)}
            </div>
          </div>
          <div className="rounded border border-[#12202e] p-1">
            <div className="text-[#4a6376]">unrealized</div>
            <div className={status.pnl.unrealized >= 0 ? "text-[#3dffa8]" : "text-[#ff5470]"}>
              {status.pnl.unrealized >= 0 ? "+" : ""}{status.pnl.unrealized.toFixed(2)}
            </div>
          </div>
          <div className="rounded border border-[#12202e] p-1">
            <div className="text-[#4a6376]">win rate</div>
            <div className="text-[#bfeaff]">{status.pnl.closedCount ? status.pnl.winRate.toFixed(0) + "%" : "—"}</div>
          </div>
        </div>
      </div>

      {/* positions */}
      <div className="panel mb-2 p-2.5">
        <div className="mb-1.5 flex items-center justify-between text-[10px] uppercase tracking-[0.18em] text-[#4a6376]">
          <span>positions {status.positions.length}/{s.maxOpenPositions}</span>
          <span className="text-[9px]">{s.leverage}x {s.marginMode}</span>
        </div>
        {status.positions.length === 0 && <div className="py-1 text-[#3a4f61]">none open</div>}
        {status.positions.map((p) => (
          <div key={p.id} className="mb-1.5 rounded border border-[#12202e] bg-[#060b12] p-1.5">
            <div className="flex items-center justify-between">
              <span className={p.side === "LONG" ? "text-[#3dffa8]" : "text-[#ff5470]"}>
                {p.side} {p.symbol} <span className="text-[#4a6376]">#{p.id}</span>
              </span>
              <span className={p.roi >= 0 ? "text-[#3dffa8]" : "text-[#ff5470]"}>
                {p.roi >= 0 ? "+" : ""}{p.roi.toFixed(1)}% · {p.unrealized >= 0 ? "+" : ""}{p.unrealized.toFixed(2)}
              </span>
            </div>
            <div className="mt-0.5 grid grid-cols-4 gap-1 text-[9px] text-[#5b7484]">
              <span>in {fnum(p.entryPrice)}</span>
              <span>mk {fnum(p.markPrice)}</span>
              <span className="text-[#3dffa8]/80">tp {fnum(p.tpPrice)}</span>
              <span className="text-[#ff5470]/80">sl {fnum(p.slPrice)}</span>
            </div>
            <div className="mt-1 flex items-center justify-between text-[9px] text-[#4a6376]">
              <span>conf {p.confidence}% · liq {fnum(p.liqPrice)}</span>
              <button className="btn btn-danger !px-1.5 !py-0.5 text-[9px]" onClick={() => cmd(`close position ${p.id}`)} disabled={busy}>
                <XOctagon size={10} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* signals */}
      <div className="panel mb-2 p-2.5">
        <div className="mb-1.5 flex items-center gap-1 text-[10px] uppercase tracking-[0.18em] text-[#4a6376]">
          <Activity size={11} /> live signals
        </div>
        <div className="max-h-44 space-y-1 overflow-y-auto pr-1">
          {status.signals.slice(0, 14).map((sg) => (
            <div key={sg.id} className="flex items-center gap-2 text-[10px]">
              <span className={`w-9 text-center ${sg.direction === "LONG" ? "text-[#3dffa8]" : "text-[#ff5470]"}`}>{sg.direction === "LONG" ? "▲L" : "▼S"}</span>
              <span className="w-16 truncate text-[#7c9cae]">{sg.symbol.replace("USDT", "")}</span>
              <span className="w-8 text-[#4a6376]">{sg.timeframe}</span>
              <span className="min-w-0 flex-1 truncate text-[#5b7484]" title={sg.strategy}>{sg.strategy}</span>
              <span className="w-8 text-right text-[#bfeaff]">{sg.confidence}</span>
              <span className="relative h-1 w-10 overflow-hidden rounded bg-[#0d1a26]">
                <span
                  className={`absolute inset-y-0 left-0 ${sg.direction === "LONG" ? "bg-[#3dffa8]" : "bg-[#ff5470]"}`}
                  style={{ width: `${sg.confidence}%` }}
                />
              </span>
            </div>
          ))}
          {status.signals.length === 0 && <div className="text-[#3a4f61]">no qualifying signals yet — engine scans every {s.scanIntervalSec}s when ON</div>}
        </div>
      </div>

      {/* quick settings */}
      <div className="panel mb-2 p-2.5">
        <div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-[#4a6376]">quick settings</div>
        <div className="grid grid-cols-1 gap-1.5">
          <QSet label="leverage" value={String(s.leverage)} onApply={(v) => cmd(`leverage ${v}`)} />
          <QSet label="min confidence" value={String(s.minConfidence)} onApply={(v) => cmd(`min confidence ${v}`)} />
          <QSet label="tf min conf" value={String(s.tfMinConfidence)} onApply={(v) => cmd(`tf min confidence ${v}`)} />
          <QSet label="min agreeing" value={String(s.minAgreeingStrategies)} onApply={(v) => cmd(`min agreeing strategies ${v}`)} />
          <QSet label="max positions" value={String(s.maxOpenPositions)} onApply={(v) => cmd(`max open positions ${v}`)} />
          <QSet label="risk %/trade" value={String(s.riskPerTradePct)} onApply={(v) => cmd(`risk per trade ${v}`)} />
          <QSet label="scan interval" value={String(s.scanIntervalSec)} onApply={(v) => cmd(`scan interval ${v}`)} />
          <QSet label="report interval" value={String(s.reportIntervalSec)} onApply={(v) => cmd(`report interval ${v}`)} />
          <QSet label="breakeven %" value={String(s.breakevenThresholdPct)} onApply={(v) => cmd(`breakeven threshold ${v}`)} />
          <QSet label="trailing %" value={String(s.trailingTriggerRoiPct)} onApply={(v) => cmd(`trailing trigger ${v}`)} />
          <QSet label="liq-sl dist %" value={String(s.liqSlDistancePct)} onApply={(v) => cmd(`liq sl distance ${v}`)} />
          <QSet label="reversal conf" value={String(s.reversalConfidence)} onApply={(v) => cmd(`reversal_confidence=${v}`)} />
        </div>
        <div className="mt-2 grid grid-cols-3 gap-1.5">
          <button className="btn text-[9px]" onClick={() => cmd(`margin mode ${s.marginMode === "ISOLATED" ? "cross" : "isolated"}`)}>
            {s.marginMode}
          </button>
          <button className="btn text-[9px]" onClick={() => cmd(`position mode ${s.positionMode === "HEDGE" ? "one way" : "hedge"}`)}>
            {s.positionMode}
          </button>
          <button className="btn text-[9px]" onClick={() => cmd(`reversal=${!s.reversalEnabled}`)}>
            REV {s.reversalEnabled ? "ON" : "off"}
          </button>
        </div>
      </div>

      {/* strategies legend */}
      <div className="panel mb-2 p-2.5">
        <button className="flex w-full items-center justify-between text-[10px] uppercase tracking-[0.18em] text-[#4a6376]" onClick={() => setShowStrat(!showStrat)}>
          <span>{status.strategies.length} strategies loaded</span>
          {showStrat ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        {showStrat && (
          <div className="mt-2 space-y-1.5">
            {(["classic", "risk", "reversal", "breakout", "trend"] as const).map((cat) => (
              <div key={cat}>
                <div className="text-[9px] uppercase tracking-widest text-[#2f4a5e]">{cat}</div>
                {status.strategies.filter((x) => x.category === cat).map((x) => (
                  <div key={x.id} className="mt-0.5 text-[10px] text-[#7c9cae]">
                    <span className="text-[#9fd8ec]">{x.name}</span> — {x.description}
                    <span className="text-[#3a4f61]"> [{x.indicators.join(" + ")}]</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* event log */}
      <div className="panel flex-1 p-2.5">
        <div className="mb-1.5 text-[10px] uppercase tracking-[0.18em] text-[#4a6376]">engine log</div>
        <div className="max-h-56 space-y-1 overflow-y-auto pr-1 text-[10px]">
          {status.events.map((e) => (
            <div key={e.id} className="whitespace-pre-wrap break-words">
              <span className="text-[#2b3f50]">{new Date(e.createdAt).toLocaleTimeString()} </span>
              <span
                className={
                  e.kind === "error" ? "text-[#ff5470]" : e.kind === "warn" ? "text-[#ffc24b]" : e.kind === "trade" ? "text-[#3dffa8]" : e.kind === "report" ? "text-[#b48cff]" : "text-[#7c9cae]"
                }
              >
                {e.text}
              </span>
            </div>
          ))}
          {status.events.length === 0 && <div className="text-[#3a4f61]">log empty</div>}
        </div>
      </div>
    </div>
  );
}
