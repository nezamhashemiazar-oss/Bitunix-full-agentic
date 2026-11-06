import { db } from "@/db";
import {
  tradingState,
  positions,
  trades,
  tpslEvents,
  signals,
  engineEvents,
  equityPoints,
  chatSessions,
  messages,
} from "@/db/schema";
import { desc, eq, lt, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_SETTINGS,
  ALLOWED_TIMEFRAMES,
  type EngineSettings,
  type AggregatedSignal,
  type Direction,
  type TimeframeVote,
} from "./types";
import { scanCandles, STRATEGIES } from "./strategies";
import { fmt } from "./indicators";
import {
  fetchPrices,
  fetchKlinesSafe,
  placeOrder,
  flashClosePosition,
  getPendingPositions,
  type LiveCredentials,
} from "./bitunix";
import { getCfg } from "@/lib/agent/config";

const STATE_ID = "main";
const MMR_PCT = 0.5; // approximate maintenance margin rate (tier-1) for liq math

/* ------------------------------- state io ------------------------------- */

export async function ensureState(): Promise<EngineSettings> {
  const rows = await db.select().from(tradingState).where(eq(tradingState.id, STATE_ID)).limit(1);
  if (rows.length === 0) {
    const settings = { ...DEFAULT_SETTINGS };
    await db.insert(tradingState).values({ id: STATE_ID, settings });
    return settings;
  }
  return { ...DEFAULT_SETTINGS, ...(rows[0].settings as Partial<EngineSettings>) };
}

export async function saveSettings(patch: Partial<EngineSettings>): Promise<EngineSettings> {
  const cur = await ensureState();
  const next = { ...cur, ...patch };
  await db
    .update(tradingState)
    .set({ settings: next, updatedAt: new Date() })
    .where(eq(tradingState.id, STATE_ID));
  return next;
}

export async function logEvent(kind: string, text: string) {
  await db.insert(engineEvents).values({ kind, text });
  // housekeeping: keep the log bounded
  if (Math.random() < 0.05) {
    await db.delete(engineEvents).where(
      lt(engineEvents.id, sql`(select coalesce(max(id),0) - 2000 from engine_events)`)
    );
  }
}

async function liveCreds(): Promise<LiveCredentials | null> {
  const apiKey = await getCfg("bitunixKey");
  const secretKey = await getCfg("bitunixSecret");
  return apiKey && secretKey ? { apiKey, secretKey } : null;
}

/* ------------------------------ price cache ------------------------------ */

const g = globalThis as typeof globalThis & {
  __jrockPriceCache?: { map: Map<string, number>; at: number; offline: boolean };
  __jrockLastScan?: AggregatedSignal[];
};

async function getPrices(symbols: string[]) {
  const c = g.__jrockPriceCache;
  if (c && Date.now() - c.at < 6000 && symbols.every((s) => c.map.has(s))) return c;
  const { prices, offline } = await fetchPrices(symbols);
  g.__jrockPriceCache = { map: prices, at: Date.now(), offline };
  return g.__jrockPriceCache;
}

/* ------------------------------- PnL math -------------------------------- */

function roiOf(side: string, entry: number, mark: number, leverage: number) {
  const raw = side === "LONG" ? (mark - entry) / entry : (entry - mark) / entry;
  return raw * leverage * 100;
}
function pnlOf(side: string, entry: number, mark: number, qty: number) {
  return side === "LONG" ? qty * (mark - entry) : qty * (entry - mark);
}
function priceForRoi(side: string, entry: number, roi: number, leverage: number) {
  const delta = roi / (leverage * 100);
  return side === "LONG" ? entry * (1 + delta) : entry * (1 - delta);
}
function liqPrice(entry: number, side: string, leverage: number) {
  const d = Math.max(0.1, 100 / leverage - MMR_PCT) / 100;
  return side === "LONG" ? entry * (1 - d) : entry * (1 + d);
}

/** Agent-computed TP/SL. SL sits `liqSlDistancePct` ROI-% away from liquidation;
 *  TP scales with signal confidence (R multiple). Returns honest annotations. */
function computeTpSl(
  side: Direction,
  entry: number,
  leverage: number,
  confidence: number,
  liqSlDistancePct: number
) {
  const liq = liqPrice(entry, side, leverage);
  const liqDistPct = (Math.abs(entry - liq) / entry) * 100 * leverage; // ROI% at liq (~100%)
  let slRoi = -Math.min(liqSlDistancePct, liqDistPct * 0.92);
  const clamped = slRoi !== -liqSlDistancePct;
  const slPrice = priceForRoi(side, entry, slRoi, leverage);
  const slDistPct = Math.abs(slPrice - entry) / entry;
  const r = 1.3 + Math.max(0, Math.min(1, (confidence - 60) / 40)) * 1.5; // 1.3R .. 2.8R
  const tpPrice = side === "LONG" ? entry * (1 + slDistPct * r) : entry * (1 - slDistPct * r);
  return {
    liq,
    slPrice,
    tpPrice,
    rMultiple: +r.toFixed(2),
    slRoi,
    clamped,
  };
}

/* -------------------------------- scanning ------------------------------- */

export async function scanNow(settings: EngineSettings): Promise<AggregatedSignal[]> {
  const results: AggregatedSignal[] = [];
  let offline = false;

  await Promise.all(
    settings.symbols.map(async (symbol) => {
      const votes: TimeframeVote[] = [];
      for (const tf of settings.timeframes) {
        try {
          const { candles, offline: off } = await fetchKlinesSafe(symbol, tf, 200);
          offline = offline || off;
          const hits = scanCandles(candles).filter((h) => h.signal.confidence >= settings.tfMinConfidence);
          if (hits.length === 0) continue;
          const price = candles[candles.length - 1].close;
          for (const h of hits) {
            await db.insert(signals).values({
              symbol,
              timeframe: tf,
              strategy: h.strategy.id,
              category: h.strategy.category,
              direction: h.signal.direction,
              confidence: h.signal.confidence,
              price,
              reasons: h.signal.reasons,
            });
          }
          const longs = hits.filter((h) => h.signal.direction === "LONG");
          const shorts = hits.filter((h) => h.signal.direction === "SHORT");
          const dom = longs.length >= shorts.length ? longs : shorts;
          if (dom.length === 0) continue;
          votes.push({
            timeframe: tf,
            direction: longs.length >= shorts.length ? "LONG" : "SHORT",
            confidence: dom.reduce((a, b) => a + b.signal.confidence, 0) / dom.length,
            agreeing: dom.length,
            strategies: dom.map((h) => h.strategy.name),
          });
        } catch {
          /* timeframe feed failed — skip honestly */
        }
      }
      if (votes.length === 0) return;
      const longScore = votes.filter((v) => v.direction === "LONG").reduce((a, v) => a + v.confidence * v.agreeing, 0);
      const shortScore = votes.filter((v) => v.direction === "SHORT").reduce((a, v) => a + v.confidence * v.agreeing, 0);
      const direction: Direction = longScore >= shortScore ? "LONG" : "SHORT";
      const aligned = votes.filter((v) => v.direction === direction);
      const agreeing = aligned.reduce((a, v) => a + v.agreeing, 0);
      const confidence =
        aligned.reduce((a, v) => a + v.confidence * v.agreeing, 0) / Math.max(1, agreeing);
      const cache = g.__jrockPriceCache;
      const price = cache?.map.get(symbol) ?? 0;
      results.push({
        symbol,
        direction,
        confidence: Math.round(confidence * 10) / 10,
        agreeing,
        price,
        votes,
        reasons: [...new Set(aligned.flatMap((v) => v.strategies))].slice(0, 8),
      });
    })
  );

  if (Math.random() < 0.08) {
    await db.delete(signals).where(lt(signals.id, sql`(select coalesce(max(id),0) - 1500 from signals)`));
  }
  if (offline && settings.dataSource !== "offline-sim") await saveSettings({ dataSource: "offline-sim" });
  if (!offline && settings.dataSource !== "bitunix") await saveSettings({ dataSource: "bitunix" });
  return results;
}

/* ------------------------------ order routing ----------------------------- */

async function openPosition(settings: EngineSettings, agg: AggregatedSignal, price: number) {
  const open = await db.select().from(positions).where(eq(positions.status, "OPEN"));
  if (open.length >= settings.maxOpenPositions) return false;
  if (open.some((p) => p.symbol === agg.symbol && (settings.positionMode === "ONE_WAY" || p.side === agg.direction)))
    return false;

  const lockedMargin = open.reduce((a, p) => a + p.margin, 0);
  const available = settings.simEquity - lockedMargin;
  let margin = (settings.simEquity * settings.riskPerTradePct) / 100;
  if (settings.mode !== "sim") margin = Math.min(margin, 1000); // live: conservative default cap unless user ups risk
  if (margin > available && settings.mode === "sim") margin = available * 0.95;
  if (margin < 5) {
    await logEvent("warn", `SKIP ${agg.symbol}: insufficient margin (available ${available.toFixed(2)} USDT)`);
    return false;
  }
  const notional = margin * settings.leverage;
  const qty = notional / price;
  const tpsl = computeTpSl(agg.direction, price, settings.leverage, agg.confidence, settings.liqSlDistancePct);

  let orderId = `sim-${randomUUID().slice(0, 8)}`;
  if (settings.mode === "live") {
    const creds = await liveCreds();
    if (!creds) {
      await logEvent("error", "LIVE order aborted: Bitunix API key/secret not configured (/api config or env).");
      return false;
    }
    try {
      const res = await placeOrder(creds, {
        symbol: agg.symbol,
        side: agg.direction === "LONG" ? "BUY" : "SELL",
        tradeSide: "OPEN",
        qty: qty.toFixed(6),
        orderType: "MARKET",
        clientId: orderId,
        tpPrice: tpsl.tpPrice.toFixed(6),
        tpStopType: "LAST_PRICE",
        tpOrderType: "MARKET",
        slPrice: tpsl.slPrice.toFixed(6),
        slStopType: "LAST_PRICE",
        slOrderType: "MARKET",
      });
      orderId = res.orderId;
      await logEvent("trade", `LIVE ORDER placed: ${agg.symbol} ${agg.direction} orderId=${res.orderId}`);
    } catch (e) {
      await logEvent("error", `LIVE order failed for ${agg.symbol}: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }

  const tfStr = agg.votes.map((v) => v.timeframe).join(",");
  const ins = await db
    .insert(positions)
    .values({
      symbol: agg.symbol,
      side: agg.direction,
      status: "OPEN",
      mode: settings.mode,
      entryPrice: price,
      markPrice: price,
      qty,
      notional,
      margin,
      leverage: settings.leverage,
      liqPrice: tpsl.liq,
      tpPrice: tpsl.tpPrice,
      slPrice: tpsl.slPrice,
      initialSlPrice: tpsl.slPrice,
      confidence: agg.confidence,
      timeframe: tfStr,
      strategies: agg.reasons,
      reasons: agg.votes.map((v) => `${v.timeframe} ${v.direction} ${v.confidence.toFixed(0)}% (${v.agreeing})`),
      orderId,
    })
    .returning({ id: positions.id });
  await db.insert(trades).values({
    positionId: ins[0].id,
    symbol: agg.symbol,
    side: agg.direction,
    action: "OPEN",
    price,
    qty,
    confidence: agg.confidence,
    reason: `${agg.agreeing} strategies agree @ ${agg.confidence}% | TP ${fmt(tpsl.tpPrice)} / SL ${fmt(tpsl.slPrice)} (R=${tpsl.rMultiple}${tpsl.clamped ? ", SL clamped inside liq" : ""})`,
    mode: settings.mode,
  });
  await logEvent(
    "trade",
    `OPEN ${agg.direction} ${agg.symbol} @ ${fmt(price)} | conf ${agg.confidence}% (${agg.agreeing} strategies) | TP ${fmt(tpsl.tpPrice)} SL ${fmt(tpsl.slPrice)} | ${settings.mode.toUpperCase()}`
  );
  return true;
}

export async function closePositionById(id: number, price: number, reason: string) {
  const rows = await db.select().from(positions).where(eq(positions.id, id)).limit(1);
  if (!rows.length || rows[0].status !== "OPEN") return false;
  const p = rows[0];
  const pnl = pnlOf(p.side, p.entryPrice, price, p.qty);
  const roi = roiOf(p.side, p.entryPrice, price, p.leverage);

  if (p.mode === "live") {
    const creds = await liveCreds();
    if (creds) {
      try {
        const live = (await getPendingPositions(creds)) as { positionList?: { positionId: string; symbol: string; side: string }[] };
        const match = (live?.positionList ?? []).find((lp) => lp.symbol === p.symbol);
        if (match) await flashClosePosition(creds, String(match.positionId));
      } catch (e) {
        await logEvent("error", `LIVE close failed for ${p.symbol}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  await db
    .update(positions)
    .set({ status: "CLOSED", closePrice: price, realizedPnl: pnl, closeReason: reason, closedAt: new Date() })
    .where(eq(positions.id, p.id));
  await db.insert(trades).values({
    positionId: p.id,
    symbol: p.symbol,
    side: p.side,
    action: reason.startsWith("REVERSAL") ? "CLOSE" : "CLOSE",
    price,
    qty: p.qty,
    roi,
    pnl,
    reason,
    mode: p.mode,
  });
  if (["TP_HIT", "SL_HIT", "TRAILING_SL", "LIQ", "REVERSAL", "MID_MGMT"].some((k) => reason.startsWith(k))) {
    await db.insert(tpslEvents).values({
      positionId: p.id,
      symbol: p.symbol,
      kind: reason.split(":")[0],
      detail: `${p.side} closed @ ${fmt(price)} | ROI ${roi.toFixed(1)}% | PnL ${pnl.toFixed(2)} USDT`,
      price,
      roi,
    });
  }
  const settings = await ensureState();
  if (p.mode === "sim") {
    await saveSettings({ simEquity: +(settings.simEquity + pnl).toFixed(2) });
  }
  await snapshotEquity(true);
  await logEvent(
    pnl >= 0 ? "trade" : "warn",
    `CLOSE ${p.side} ${p.symbol} @ ${fmt(price)} [${reason}] ROI ${roi.toFixed(1)}% PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDT`
  );
  return true;
}

/* --------------------------- position management ------------------------- */

async function managePositions(settings: EngineSettings, priceMap: Map<string, number>) {
  const open = await db.select().from(positions).where(eq(positions.status, "OPEN"));
  const lastAggs = g.__jrockLastScan ?? [];
  for (const p of open) {
    const mark = priceMap.get(p.symbol);
    if (!mark) continue;
    const roi = roiOf(p.side, p.entryPrice, mark, p.leverage);
    const best = Math.max(p.bestRoi, roi);
    let sl = p.slPrice;
    let changedBestOrSl = best !== p.bestRoi;

    // liquidation guard (approximate, isolated margin)
    if (p.liqPrice && (p.side === "LONG" ? mark <= p.liqPrice : mark >= p.liqPrice)) {
      await closePositionById(p.id, mark, "LIQ: price crossed estimated liquidation level");
      continue;
    }
    // take profit
    if (p.tpPrice && (p.side === "LONG" ? mark >= p.tpPrice : mark <= p.tpPrice)) {
      await closePositionById(p.id, mark, "TP_HIT: take-profit target reached");
      continue;
    }
    // stop loss
    if (sl && (p.side === "LONG" ? mark <= sl : mark >= sl)) {
      const trailing = p.breakevenArmed && sl !== p.initialSlPrice;
      await closePositionById(p.id, mark, trailing ? "TRAILING_SL: trailing stop executed" : "SL_HIT: stop-loss executed");
      continue;
    }
    // breakeven move
    if (!p.breakevenArmed && roi >= settings.breakevenThresholdPct && sl) {
      const bePrice = priceForRoi(p.side as Direction, p.entryPrice, 1.5, p.leverage);
      const better = p.side === "LONG" ? bePrice > sl : bePrice < sl;
      if (better) {
        sl = bePrice;
        changedBestOrSl = true;
        await db.insert(tpslEvents).values({
          positionId: p.id,
          symbol: p.symbol,
          kind: "BREAKEVEN",
          detail: `ROI ${roi.toFixed(1)}% ≥ ${settings.breakevenThresholdPct}% → SL moved to breakeven+ (${fmt(bePrice)})`,
          price: mark,
          roi,
        });
      }
      await db.update(positions).set({ breakevenArmed: true }).where(eq(positions.id, p.id));
    }
    // trailing
    if (roi >= settings.trailingTriggerRoiPct) {
      const gap = Math.max(6, settings.trailingTriggerRoiPct - settings.breakevenThresholdPct);
      const lock = Math.max(1.5, best - gap);
      const trailPrice = priceForRoi(p.side as Direction, p.entryPrice, lock, p.leverage);
      const better = sl == null || (p.side === "LONG" ? trailPrice > sl : trailPrice < sl);
      if (better && lock > 0) {
        sl = trailPrice;
        changedBestOrSl = true;
        await db.insert(tpslEvents).values({
          positionId: p.id,
          symbol: p.symbol,
          kind: "TRAILING",
          detail: `ROI ${roi.toFixed(1)}% → trailing SL locks ~${lock.toFixed(1)}% ROI @ ${fmt(trailPrice)}`,
          price: mark,
          roi,
        });
      }
    }
    // reversal check
    if (settings.reversalEnabled) {
      const contra = lastAggs.find(
        (a: AggregatedSignal) => a.symbol === p.symbol && a.direction !== p.side && a.confidence >= settings.reversalConfidence
      );
      if (contra && roi < -5) {
        await closePositionById(p.id, mark, `REVERSAL: opposite signal ${contra.confidence}% ≥ ${settings.reversalConfidence}%`);
        if (settings.autotradeOn) {
          await openPosition(settings, { ...contra, price: mark }, mark);
        }
        continue;
      }
    }
    await db
      .update(positions)
      .set({ markPrice: mark, bestRoi: best, slPrice: sl })
      .where(eq(positions.id, p.id));
  }
}



/* -------------------------------- reports -------------------------------- */

async function snapshotEquity(force = false) {
  const st = await ensureState();
  const open = await db.select().from(positions).where(eq(positions.status, "OPEN"));
  const unreal = open.reduce((a, p) => a + (p.markPrice ? pnlOf(p.side, p.entryPrice, p.markPrice, p.qty) : 0), 0);
  const eqv = st.simEquity + unreal;
  const lastRows = await db.select().from(equityPoints).orderBy(desc(equityPoints.id)).limit(1);
  if (!force && lastRows.length && Date.now() - new Date(lastRows[0].createdAt).getTime() < 45000) return;
  await db.insert(equityPoints).values({ equity: +eqv.toFixed(2) });
  if (Math.random() < 0.05) {
    await db.delete(equityPoints).where(lt(equityPoints.id, sql`(select coalesce(max(id),0) - 2000 from equity_points)`));
  }
}

async function buildReport(settings: EngineSettings, priceMap: Map<string, number>) {
  const lines: string[] = [`ENGINE REPORT — ${new Date().toISOString().slice(11, 19)} UTC (${settings.dataSource === "offline-sim" ? "OFFLINE-SIM DATA" : "BITUNIX LIVE DATA"}, ${settings.mode.toUpperCase()} MODE)`];
  const lastAggs = g.__jrockLastScan ?? [];
  for (const s of settings.symbols) {
    const price = priceMap.get(s);
    const agg = lastAggs.find((a) => a.symbol === s);
    lines.push(
      `• ${s}: ${price ? fmt(price) : "—"} | bias ${agg ? `${agg.direction} ${agg.confidence}% (${agg.agreeing} strategies)` : "no qualifying signal"}`
    );
  }
  const open = await db.select().from(positions).where(eq(positions.status, "OPEN"));
  if (open.length === 0) lines.push("• No open positions.");
  for (const p of open) {
    const mark = priceMap.get(p.symbol) ?? p.markPrice ?? p.entryPrice;
    const roi = roiOf(p.side, p.entryPrice, mark, p.leverage);
    const pnl = pnlOf(p.side, p.entryPrice, mark, p.qty);
    lines.push(
      `• OPEN ${p.side} ${p.symbol} @ ${fmt(p.entryPrice)} → ${fmt(mark)} | ROI ${roi.toFixed(1)}% | PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} | TP ${fmt(p.tpPrice ?? NaN)} SL ${fmt(p.slPrice ?? NaN)}`
    );
  }
  lines.push(`• SIM equity ${settings.simEquity.toFixed(2)} USDT | scan ${settings.scanOn ? "on" : "off"} | autotrade ${settings.autotradeOn ? "on" : "off"}`);
  return lines.join("\n");
}

async function publishReport(text: string) {
  await db.insert(engineEvents).values({ kind: "report", text });
  const sessions = await db.select().from(chatSessions).orderBy(desc(chatSessions.updatedAt)).limit(1);
  if (sessions.length) {
    await db.insert(messages).values({ sessionId: sessions[0].id, role: "engine", kind: "report", content: text });
  }
}

/* --------------------------------- tick ---------------------------------- */

export async function tick() {
  const settings = await ensureState();
  if (!settings.engineOn) return { idle: true };
  const { map: priceMap, offline } = await getPrices(settings.symbols);
  if (offline && settings.dataSource !== "offline-sim") await saveSettings({ dataSource: "offline-sim" });
  if (!offline && settings.dataSource !== "bitunix") await saveSettings({ dataSource: "bitunix" });
  const s2 = await ensureState();

  const now = Date.now();
  if (s2.scanOn && now - s2.lastScanAt >= s2.scanIntervalSec * 1000) {
    const aggs = await scanNow(s2);
    g.__jrockLastScan = aggs;
    await saveSettings({ lastScanAt: now });
    if (s2.autotradeOn) {
      for (const agg of aggs) {
        if (agg.confidence >= s2.minConfidence && agg.agreeing >= s2.minAgreeingStrategies) {
          const price = priceMap.get(agg.symbol) ?? agg.price;
          if (price) await openPosition(s2, agg, price);
        }
      }
    }
  }

  await managePositions(s2, priceMap);
  await snapshotEquity();

  if (s2.reportOn && now - s2.lastReportAt >= s2.reportIntervalSec * 1000) {
    await publishReport(await buildReport(s2, priceMap));
    await saveSettings({ lastReportAt: now });
  }
  await saveSettings({ lastTickAt: now });
  return { idle: false };
}

/* ------------------------------- commands -------------------------------- */

export interface EngineCommandResult {
  handled: boolean;
  reply: string;
}

const num = (s: string) => parseFloat(s.replace(/[^\d.\-]/g, ""));
const yn = (b: boolean) => (b ? "ON" : "OFF");

function settingsDump(s: EngineSettings): string {
  return [
    `ENGINE        ${yn(s.engineOn)}   | mode ${s.mode.toUpperCase()} (${s.dataSource === "offline-sim" ? "offline-sim feed" : "bitunix feed"})`,
    `scanner=${yn(s.scanOn)} autotrade=${yn(s.autotradeOn)} report=${yn(s.reportOn)} every ${s.reportIntervalSec}s | scan interval ${s.scanIntervalSec}s`,
    `symbols: ${s.symbols.join(", ")} | timeframes: ${s.timeframes.join(", ")}`,
    `leverage ${s.leverage}x | margin ${s.marginMode} | position mode ${s.positionMode} | max open ${s.maxOpenPositions}`,
    `thresholds: minConfidence ${s.minConfidence}% | tfMinConfidence ${s.tfMinConfidence}% | minAgreeing ${s.minAgreeingStrategies}`,
    `risk/trade ${s.riskPerTradePct}% | breakeven≥${s.breakevenThresholdPct}% ROI | trailing≥${s.trailingTriggerRoiPct}% ROI | SL ${s.liqSlDistancePct}% ROI from liq`,
    `reversal=${s.reversalEnabled} (conf≥${s.reversalConfidence}%) | SIM equity ${s.simEquity.toFixed(2)} USDT`,
  ].join("\n");
}

export async function executeEngineCommand(raw: string): Promise<EngineCommandResult> {
  const text = raw.trim().replace(/\s+/g, " ");
  const low = text.toLowerCase();
  const s = await ensureState();
  const done = (reply: string): EngineCommandResult => ({ handled: true, reply });

  if (/^(start trading|autotrade on|auto trade on)$/.test(low)) {
    const patch: Partial<EngineSettings> = { autotradeOn: true };
    let extra = "";
    if (!s.engineOn) {
      patch.engineOn = true;
      extra = "\nMaster engine was OFF — switched ON as well (scanner + trader + autotrade).";
    }
    const n = await saveSettings(patch);
    await logEvent("info", "Autotrade enabled by user command");
    return done(`Autotrade ON. Risk ${n.riskPerTradePct}%/trade, ${n.leverage}x, max ${n.maxOpenPositions} positions, minConfidence ${n.minConfidence}%, minAgreeing ${n.minAgreeingStrategies}.` + extra);
  }
  if (/^(stop trading|autotrade off|auto trade off)$/.test(low)) {
    await saveSettings({ autotradeOn: false });
    await logEvent("info", "Autotrade disabled by user command");
    return done("Autotrade OFF. Open positions remain under TP/SL management; no new entries will be taken.");
  }
  if (/^engine (on|off)$/.test(low)) {
    const on = low.endsWith("on");
    await saveSettings({ engineOn: on });
    await logEvent("info", `Engine ${yn(on)} by user command`);
    return done(on ? "Engine ON — scanner, trader and autotrade subsystems active." : "Engine OFF — all scanning, trading and management halted. Open live exchange TP/SL orders remain on Bitunix.");
  }
  if (/^scan (on|off)$/.test(low)) {
    const on = low.endsWith("on");
    await saveSettings({ scanOn: on });
    return done(`Scanner ${yn(on)}.`);
  }
  if (/^(scan now|force scan)$/.test(low)) {
    if (!s.engineOn) return done("Engine is OFF — run `engine on` first.");
    const aggs = await scanNow(s);
    g.__jrockLastScan = aggs;
    await saveSettings({ lastScanAt: Date.now() });
    if (!aggs.length) return done("Scan complete — no qualifying signals above tfMinConfidence on any watched symbol/timeframe.");
    const lines = aggs.map(
      (a) => `• ${a.symbol} ${a.direction} conf ${a.confidence}% agreeing ${a.agreeing} [${a.votes.map((v) => v.timeframe).join("/")}]`
    );
    return done(`Scan complete (${aggs.length} candidate${aggs.length > 1 ? "s" : ""}):\n${lines.join("\n")}`);
  }
  if (/^report (on|off)$/.test(low)) {
    const on = low.endsWith("on");
    await saveSettings({ reportOn: on, lastReportAt: 0 });
    return done(`Report ${yn(on)}${on ? ` — broadcasting signals + prices + PnL every ${s.reportIntervalSec}s (engine must be ON).` : "."}`);
  }
  if (/^report interval (?:sec(?:onds)? )?(\d+)$/.test(low)) {
    const v = Math.max(10, Math.min(3600, parseInt(low.match(/(\d+)/)![1], 10)));
    await saveSettings({ reportIntervalSec: v });
    return done(`Report interval = ${v}s.`);
  }
  if (/^(status|engine status)$/.test(low)) {
    const open = await db.select().from(positions).where(eq(positions.status, "OPEN"));
    const { map } = await getPrices(s.symbols);
    const lines = [settingsDump(s), `open positions: ${open.length}/${s.maxOpenPositions}`];
    for (const p of open) {
      const m = map.get(p.symbol) ?? p.entryPrice;
      lines.push(`  ${p.side} ${p.symbol} @ ${fmt(p.entryPrice)} → ROI ${roiOf(p.side, p.entryPrice, m, p.leverage).toFixed(1)}%`);
    }
    return done(lines.join("\n"));
  }
  if (/^settings( trade| engine)?$/.test(low)) return done(settingsDump(s));
  if (/^(trades?_history|trade history|trades history)$/.test(low)) {
    const rows = await db.select().from(trades).orderBy(desc(trades.id)).limit(15);
    if (!rows.length) return done("No trades recorded yet.");
    return done(
      "TRADE HISTORY (latest 15):\n" + rows.map((t) => `#${t.id} ${t.action} ${t.side} ${t.symbol} @ ${fmt(t.price)} ${t.pnl != null ? `| PnL ${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)}` : ""} | ${t.reason.slice(0, 90)}`).join("\n")
    );
  }
  if (/^(tpsl_history|tp sl history|tpsl history)$/.test(low)) {
    const rows = await db.select().from(tpslEvents).orderBy(desc(tpslEvents.id)).limit(15);
    if (!rows.length) return done("No TP/SL events recorded yet.");
    return done("TP/SL HISTORY (latest 15):\n" + rows.map((e) => `#${e.id} [${e.kind}] ${e.symbol} — ${e.detail}`).join("\n"));
  }
  if (/^(positions?_?history|closed positions)$/.test(low)) {
    const rows = await db.select().from(positions).where(eq(positions.status, "CLOSED")).orderBy(desc(positions.id)).limit(15);
    if (!rows.length) return done("No closed positions yet.");
    return done(
      "POSITION HISTORY (latest 15):\n" + rows.map((p) => `#${p.id} ${p.side} ${p.symbol} ${fmt(p.entryPrice)}→${fmt(p.closePrice ?? NaN)} | ${p.realizedPnl != null ? (p.realizedPnl >= 0 ? "+" : "") + p.realizedPnl.toFixed(2) : "?"} USDT | ${p.closeReason ?? ""}`).join("\n")
    );
  }
  if (/^pnl$/.test(low)) {
    const closed = await db.select().from(trades).where(sql`${trades.pnl} is not null`);
    const realized = closed.reduce((a, t) => a + (t.pnl ?? 0), 0);
    const wins = closed.filter((t) => (t.pnl ?? 0) > 0).length;
    const open = await db.select().from(positions).where(eq(positions.status, "OPEN"));
    const unreal = open.reduce((a, p) => a + (p.markPrice ? pnlOf(p.side, p.entryPrice, p.markPrice, p.qty) : 0), 0);
    return done(
      `PNL (${s.mode.toUpperCase()}):\nrealized: ${realized >= 0 ? "+" : ""}${realized.toFixed(2)} USDT across ${closed.length} closes (win rate ${closed.length ? ((wins / closed.length) * 100).toFixed(0) : "0"}%)\nunrealized: ${unreal >= 0 ? "+" : ""}${unreal.toFixed(2)} USDT on ${open.length} open\nSIM equity: ${s.simEquity.toFixed(2)} USDT`
    );
  }
  let m: RegExpMatchArray | null;
  if ((m = low.match(/^(mid management( position)? trigger|mid manage|mid mgmt)(?: (\S+))?$/))) {
    return done(await midManage(m[3]?.toUpperCase()));
  }
  if ((m = low.match(/^reversal\s*[= ]\s*(true|false|on|off)$/))) {
    const on = ["true", "on"].includes(m[1]);
    await saveSettings({ reversalEnabled: on });
    return done(`Reversal engine ${yn(on)} (triggers at ≥${s.reversalConfidence}% opposite confidence on losing positions).`);
  }
  if ((m = low.match(/^reversal[_ ]confidence\s*[= ]\s*(\d+)$/))) {
    const v = Math.max(50, Math.min(99, parseInt(m[1], 10)));
    await saveSettings({ reversalConfidence: v });
    return done(`Reversal confidence = ${v}%.`);
  }
  if ((m = low.match(/^scans? interval (?:sec(?:onds)? )?(\d+)$/))) {
    const v = Math.max(5, Math.min(600, parseInt(m[1], 10)));
    await saveSettings({ scanIntervalSec: v });
    return done(`Scan interval = ${v}s.`);
  }
  if ((m = low.match(/^breakeven threshold (?:pct )?(\d+(?:\.\d+)?)$/))) {
    const v = Math.max(5, Math.min(90, num(m[1])));
    await saveSettings({ breakevenThresholdPct: v, trailingTriggerRoiPct: Math.max(s.trailingTriggerRoiPct, v + 10) });
    return done(`Breakeven threshold = ${v}% ROI (trailing trigger adjusted to ≥ ${v + 10}% to stay above it).`);
  }
  if ((m = low.match(/^trailing (?:trigger )?(?:stop )?(?:roi )?(?:pct )?(\d+(?:\.\d+)?)$/)) || (m = low.match(/^trailing trigger stop roi pct (\d+(?:\.\d+)?)$/))) {
    const v = Math.max(s.breakevenThresholdPct + 5, Math.min(150, num(m[1])));
    await saveSettings({ trailingTriggerRoiPct: v });
    return done(`Trailing trigger = ${v}% ROI. Beyond it, SL trails to lock ~${v - Math.max(6, v - s.breakevenThresholdPct)}→(peak − gap)% ROI.`);
  }
  if ((m = low.match(/^(?:liq sl distance|liq distance)(?: pct)? ?(\d+)$/))) {
    const v = Math.max(10, Math.min(90, parseInt(m[1], 10)));
    await saveSettings({ liqSlDistancePct: v });
    return done(`SL distance = ${v}% ROI away from liquidation price (applied at entry, agent set).`);
  }
  if ((m = low.match(/^min agreeing strategies (\d+)$/))) {
    const v = Math.max(1, Math.min(STRATEGIES.length, parseInt(m[1], 10)));
    await saveSettings({ minAgreeingStrategies: v });
    return done(`Min agreeing strategies = ${v}.`);
  }
  if ((m = low.match(/^timeframes? (.+)$/))) {
    const list = m[1].split(/[ ,]+/).filter((t) => ALLOWED_TIMEFRAMES.includes(t));
    if (!list.length) return done(`No valid timeframes. Allowed: ${ALLOWED_TIMEFRAMES.join(", ")}`);
    await saveSettings({ timeframes: list });
    return done(`Timeframes = ${list.join(", ")}.`);
  }
  if ((m = low.match(/^tf min confidence (\d+)$/))) {
    const v = Math.max(30, Math.min(99, parseInt(m[1], 10)));
    await saveSettings({ tfMinConfidence: v });
    return done(`Per-timeframe min confidence = ${v}%.`);
  }
  if ((m = low.match(/^min confidence (\d+)$/))) {
    const v = Math.max(30, Math.min(99, parseInt(m[1], 10)));
    await saveSettings({ minConfidence: v });
    return done(`Aggregate min confidence = ${v}%.`);
  }
  if ((m = low.match(/^max open positions (\d+)$/))) {
    const v = Math.max(1, Math.min(15, parseInt(m[1], 10)));
    await saveSettings({ maxOpenPositions: v });
    return done(`Max open positions = ${v}.`);
  }
  if ((m = low.match(/^leverage (\d+)$/))) {
    const v = Math.max(1, Math.min(125, parseInt(m[1], 10)));
    await saveSettings({ leverage: v });
    return done(`Leverage = ${v}x. Note: higher leverage pulls liquidation closer; SL is still placed ${s.liqSlDistancePct}% ROI before liq.`);
  }
  if ((m = low.match(/^risk per trade (\d+(?:\.\d+)?)$/))) {
    const v = Math.max(0.5, Math.min(20, num(m[1])));
    await saveSettings({ riskPerTradePct: v });
    return done(`Risk per trade = ${v}% of equity (as isolated margin).`);
  }
  if ((m = low.match(/^margin mode (isolated|isolation|cross|crossed)$/))) {
    const v = ["cross", "crossed"].includes(m[1]) ? "CROSSED" : "ISOLATED";
    await saveSettings({ marginMode: v as EngineSettings["marginMode"] });
    return done(`Margin mode = ${v}. ${s.mode === "live" ? "Applied via Bitunix change_margin_mode on next live order." : "Recorded for live mode."}`);
  }
  if ((m = low.match(/^position mode (hedge|one[\s-]?way|oneway)$/))) {
    const v = m[1] === "hedge" ? "HEDGE" : "ONE_WAY";
    await saveSettings({ positionMode: v as EngineSettings["positionMode"] });
    return done(`Position mode = ${v}.`);
  }
  if ((m = low.match(/^symbols? ([a-z0-9, ]+)$/))) {
    const list = m[1].toUpperCase().split(/[ ,]+/).map((x) => x.trim()).filter((x) => /^[A-Z0-9]{2,20}$/.test(x));
    if (!list.length) return done("No valid symbols parsed. Example: `symbols BTCUSDT ETHUSDT SOLUSDT`");
    await saveSettings({ symbols: list.slice(0, 12) });
    return done(`Watching symbols = ${list.slice(0, 12).join(", ")}.`);
  }
  if ((m = low.match(/^close position(?: (\S+))?$/))) {
    const arg = m[1];
    const open = await db.select().from(positions).where(eq(positions.status, "OPEN"));
    const { map } = await getPrices(s.symbols);
    let targets = open;
    if (arg && arg !== "all") {
      targets = open.filter((p) => p.symbol === arg.toUpperCase() || String(p.id) === arg);
      if (!targets.length) return done(`No open position matching "${arg}". Open: ${open.map((p) => `${p.symbol}#${p.id}`).join(", ") || "none"}`);
    }
    if (!targets.length) return done("No open positions.");
    for (const p of targets) await closePositionById(p.id, map.get(p.symbol) ?? p.markPrice ?? p.entryPrice, "MANUAL: closed by user command");
    return done(`Closed ${targets.length} position(s) at market: ${targets.map((p) => `${p.symbol} #${p.id}`).join(", ")}.`);
  }
  if ((m = low.match(/^mode (sim|paper|live)$/))) {
    const want = m[1] === "live" ? "live" : "sim";
    if (want === "live") {
      const creds = await liveCreds();
      if (!creds)
        return done("Refusing to go LIVE: no Bitunix API key/secret configured. Set them in Settings → Exchange (or BITUNIX_API_KEY / BITUNIX_SECRET_KEY env). I will not pretend to trade real money without credentials.");
      await saveSettings({ mode: "live" });
      await logEvent("warn", "ENGINE SWITCHED TO LIVE MODE by user command — real orders will be placed on Bitunix.");
      return done("LIVE MODE ACTIVE. Real orders will hit Bitunix futures with agent-computed TP/SL attached. Margin per live trade is conservatively capped at 1000 USDT unless you raise `risk per trade`. Confirm keys have futures trade permission and avoid IP whitelist conflicts.");
    }
    await saveSettings({ mode: "sim" });
    return done("SIM mode — paper trading on live Bitunix market data (or offline-sim feed if the exchange is unreachable).");
  }
  if ((m = low.match(/^(?:set )?equity (\d+(?:\.\d+)?)$/))) {
    const v = Math.max(100, Math.min(1_000_000, num(m[1])));
    await saveSettings({ simEquity: v });
    return done(`SIM equity set to ${v.toFixed(2)} USDT (open positions keep their margin accounting).`);
  }
  if (/^(help trade|trade help|trading help)$/.test(low)) {
    return done(
      [
        "TRADER COMMANDS (also work as plain language):",
        "  start trading / stop trading        autotrade on/off",
        "  engine on / engine off              master switch (scanner+trader+autotrade)",
        "  scan on / scan off / scan now       scanner control",
        "  status · settings trade · pnl       telemetry",
        "  report on/off · report interval N   periodic signal+price+pnl broadcast",
        "  trades_history · tpsl_history · positions history",
        "  close position [SYMBOL|all|#id]",
        "  symbols BTCUSDT ETHUSDT …           watchlist",
        "  timeframes 1m,3m,5m,15m             scan TFs",
        "  leverage N · margin mode isolated|cross · position mode hedge|one way",
        "  max open positions N · risk per trade N",
        "  min confidence N · tf min confidence N · min agreeing strategies N",
        "  breakeven threshold N · trailing trigger N · liq sl distance N",
        "  reversal=true|false · reversal_confidence=N",
        "  mid management trigger [SYMBOL]     manual position intervention",
        "  scan interval N · mode sim|live · equity N",
      ].join("\n")
    );
  }
  return { handled: false, reply: "" };
}

/* --------------------------- mid-management ------------------------------ */

async function midManage(symbol?: string): Promise<string> {
  const s = await ensureState();
  const open = await db.select().from(positions).where(eq(positions.status, "OPEN"));
  const targets = symbol ? open.filter((p) => p.symbol === symbol.toUpperCase()) : open;
  if (!targets.length) return symbol ? `No open position on ${symbol.toUpperCase()}.` : "No open positions to manage.";
  const { map } = await getPrices(s.symbols);
  const aggs = g.__jrockLastScan ?? [];
  const out: string[] = [];
  for (const p of targets) {
    const mark = map.get(p.symbol) ?? p.markPrice ?? p.entryPrice;
    const roi = roiOf(p.side, p.entryPrice, mark, p.leverage);
    const contra = aggs.find((a) => a.symbol === p.symbol && a.direction !== p.side);
    if (contra && roi < 0 && contra.confidence >= s.tfMinConfidence) {
      await closePositionById(p.id, mark, `MID_MGMT: manual trigger, opposite signal ${contra.confidence}%`);
      out.push(`${p.symbol}: closed manually (ROI ${roi.toFixed(1)}%) — opposite ${contra.direction} signal at ${contra.confidence}%.`);
      continue;
    }
    if (roi >= s.breakevenThresholdPct) {
      const bePrice = priceForRoi(p.side as Direction, p.entryPrice, 2, p.leverage);
      const better = p.slPrice == null || (p.side === "LONG" ? bePrice > p.slPrice : bePrice < p.slPrice);
      if (better) {
        await db.update(positions).set({ slPrice: bePrice, breakevenArmed: true }).where(eq(positions.id, p.id));
        await db.insert(tpslEvents).values({ positionId: p.id, symbol: p.symbol, kind: "MID_MGMT", detail: `Manual trigger: SL tightened to breakeven+ (${fmt(bePrice)}) at ROI ${roi.toFixed(1)}%`, price: mark, roi });
        out.push(`${p.symbol}: ROI ${roi.toFixed(1)}% — SL tightened to breakeven+ at ${fmt(bePrice)}.`);
        continue;
      }
    }
    out.push(`${p.symbol}: ROI ${roi.toFixed(1)}% — no safe improvement (no qualifying opposite signal, SL already ${p.slPrice ? "at " + fmt(p.slPrice) : "unset"}). Left untouched — I won't fake an action.`);
  }
  return out.join("\n");
}

/* ------------------------------- status API ------------------------------ */

export async function getFullStatus() {
  const s = await ensureState();
  const open = await db.select().from(positions).where(eq(positions.status, "OPEN"));
  const { map } = await getPrices(s.symbols).catch(() => ({ map: new Map<string, number>(), at: 0, offline: true }));
  const openWithPnl = open.map((p) => {
    const mark = map.get(p.symbol) ?? p.markPrice ?? p.entryPrice;
    return {
      ...p,
      markPrice: mark,
      roi: roiOf(p.side, p.entryPrice, mark, p.leverage),
      unrealized: pnlOf(p.side, p.entryPrice, mark, p.qty),
    };
  });
  const [recentTrades, recentTpsl, recentSignals, recentEvents, curve] = await Promise.all([
    db.select().from(trades).orderBy(desc(trades.id)).limit(20),
    db.select().from(tpslEvents).orderBy(desc(tpslEvents.id)).limit(20),
    db.select().from(signals).orderBy(desc(signals.id)).limit(40),
    db.select().from(engineEvents).orderBy(desc(engineEvents.id)).limit(40),
    db.select().from(equityPoints).orderBy(desc(equityPoints.id)).limit(120),
  ]);
  const closesPnls = recentTrades.filter((t) => t.pnl != null);
  const allClosed = await db.select({ pnl: trades.pnl }).from(trades).where(sql`${trades.pnl} is not null`);
  const realized = allClosed.reduce((a, t) => a + (t.pnl ?? 0), 0);
  const wins = allClosed.filter((t) => (t.pnl ?? 0) > 0).length;
  const unreal = openWithPnl.reduce((a, p) => a + p.unrealized, 0);
  const prices: Record<string, number> = {};
  for (const sym of s.symbols) prices[sym] = map.get(sym) ?? 0;
  return {
    settings: s,
    prices,
    positions: openWithPnl,
    trades: recentTrades,
    tpsl: recentTpsl,
    signals: recentSignals,
    events: recentEvents,
    equityCurve: curve.reverse().map((c) => ({ t: c.createdAt, equity: c.equity })),
    lastScan: (g.__jrockLastScan ?? []) as AggregatedSignal[],
    pnl: {
      realized,
      unrealized: unreal,
      total: realized + unreal,
      openCount: open.length,
      closedCount: allClosed.length,
      winRate: allClosed.length ? (wins / allClosed.length) * 100 : 0,
      sampleNote: closesPnls.length ? "" : "no closed trades yet",
    },
    strategies: STRATEGIES.map((x) => ({ id: x.id, name: x.name, category: x.category, description: x.description, indicators: x.indicators })),
  };
}
