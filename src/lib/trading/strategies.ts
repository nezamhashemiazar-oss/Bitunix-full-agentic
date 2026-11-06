import type { Candle, Strategy } from "./types";
import {
  smaSeries,
  emaSeries,
  rsiSeries,
  macdSeries,
  bollingerSeries,
  vwapSeries,
  temaSeries,
  demaSeries,
  closes,
  last,
  prev,
  ok,
  crossUp,
  crossDown,
  rising,
  falling,
  volumeSma,
  isHammer,
  isShootingStar,
  isMorningStar,
  isDarkCloudCover,
  isThreeWhiteSoldiers,
  bullishDivergence,
  clampConfidence,
} from "./indicators";

/* ------------------------------------------------------------------ */
/* Every strategy evaluates the latest closed candle context and       */
/* returns a directional vote with a confidence, or null.              */
/* ------------------------------------------------------------------ */

function nearLow(candles: Candle[], lookback = 20): boolean {
  const n = candles.length;
  const lows = candles.slice(Math.max(0, n - lookback)).map((c) => c.low);
  return candles[n - 1].low <= Math.min(...lows) * 1.01;
}

function nearHigh(candles: Candle[], lookback = 20): boolean {
  const n = candles.length;
  const highs = candles.slice(Math.max(0, n - lookback)).map((c) => c.high);
  return candles[n - 1].high >= Math.max(...highs) * 0.99;
}

export const STRATEGIES: Strategy[] = [
  {
    id: "vegas_bear",
    name: "Vegas Tunnel Trend-Confirmed Bearish",
    description: "Tunnel-down death cross short",
    category: "classic",
    indicators: ["EMA144", "EMA169", "EMA12"],
    evaluate(cs: Candle[]) {
      const c = closes(cs);
      const e144 = emaSeries(c, 144);
      const e169 = emaSeries(c, 169);
      const e12 = emaSeries(c, 12);
      if (!ok(last(e144)) || !ok(last(e169)) || !ok(last(e12))) return null;
      const tunnelDown = last(e144) < last(e169);
      const freshCross = crossDown(e144, e169) || (tunnelDown && crossDown(e12, e144));
      const priceBelow = last(c) < last(e144);
      if (!(tunnelDown && priceBelow)) return null;
      const sep = Math.abs(last(e144) - last(e169)) / last(c);
      const conf = clampConfidence(58 + (freshCross ? 14 : 6) + Math.min(20, sep * 4000) + (falling(e144, 4) ? 6 : 0));
      return {
        strategyId: "vegas_bear",
        direction: "SHORT",
        confidence: conf,
        reasons: [
          freshCross ? "Fresh EMA144/169 tunnel death cross" : "Vegas tunnel (144<169) established",
          `EMA12 (${last(e12).toFixed(4)}) below tunnel`,
          "Price trading under the tunnel",
        ],
      };
    },
  },
  {
    id: "golden_cross",
    name: "Golden Cross 50/200 Enhanced Long",
    description: "Golden cross with volume confirmation",
    category: "classic",
    indicators: ["SMA50", "SMA200", "VOLUME"],
    evaluate(cs: Candle[]) {
      const c = closes(cs);
      const s50 = smaSeries(c, 50);
      const s200 = smaSeries(c, 200);
      if (!ok(last(s200)) || !ok(prev(s200))) return null;
      const crossed = crossUp(s50, s200);
      const above = last(s50) > last(s200);
      if (!crossed && !(above && crossUp(c.map(() => 0).map((_, i) => c[i]), s200))) return null;
      const volAvg = volumeSma(cs);
      const volOk = volAvg > 0 && cs[cs.length - 1].volume > volAvg * 1.1;
      if (!crossed && !volOk) return null;
      const conf = clampConfidence(60 + (crossed ? 16 : 8) + (volOk ? 12 : -6) + (rising(s50, 5) ? 6 : 0));
      return {
        strategyId: "golden_cross",
        direction: "LONG",
        confidence: conf,
        reasons: [
          crossed ? "SMA50 crossed above SMA200 (golden cross)" : "SMA50/200 golden alignment",
          volOk ? `Volume ${(cs[cs.length - 1].volume / (volAvg || 1)).toFixed(2)}x average` : "Volume below average (weaker)",
        ],
      };
    },
  },
  {
    id: "death_cross",
    name: "Death Cross 50/200 Enhanced Short",
    description: "Death cross with weak volume",
    category: "classic",
    indicators: ["SMA50", "SMA200", "VOLUME"],
    evaluate(cs: Candle[]) {
      const c = closes(cs);
      const s50 = smaSeries(c, 50);
      const s200 = smaSeries(c, 200);
      if (!ok(last(s200)) || !ok(prev(s200))) return null;
      const crossed = crossDown(s50, s200);
      const below = last(s50) < last(s200) && last(c) < last(s200);
      if (!crossed && !below) return null;
      const volAvg = volumeSma(cs);
      const weakVol = volAvg === 0 || cs[cs.length - 1].volume <= volAvg * 1.15;
      const conf = clampConfidence(58 + (crossed ? 16 : 7) + (weakVol ? 10 : 2) + (falling(s50, 5) ? 6 : 0));
      return {
        strategyId: "death_cross",
        direction: "SHORT",
        confidence: conf,
        reasons: [
          crossed ? "SMA50 crossed below SMA200 (death cross)" : "SMA50/200 bearish alignment",
          weakVol ? "Weak sell volume — drift-down profile" : "Elevated volume",
        ],
      };
    },
  },
  {
    id: "vwap_breakdown",
    name: "VWAP Breakdown Alert",
    description: "Intraday risk alert: price loses VWAP with bearish MACD",
    category: "risk",
    indicators: ["VWAP", "MACD"],
    evaluate(cs: Candle[]) {
      const c = closes(cs);
      const vwap = vwapSeries(cs);
      const m = macdSeries(c);
      if (!ok(last(vwap)) || !ok(last(m.hist))) return null;
      const below = last(c) < last(vwap);
      const lostVwap = prev(c) >= prev(vwap) && below;
      if (!below || last(m.hist) >= 0) return null;
      const conf = clampConfidence(55 + (lostVwap ? 14 : 6) + (last(m.hist) < prev(m.hist) ? 8 : 0));
      return {
        strategyId: "vwap_breakdown",
        direction: "SHORT",
        confidence: conf,
        reasons: [
          lostVwap ? "Price just lost VWAP" : "Price below VWAP",
          "MACD histogram negative" + (last(m.hist) < prev(m.hist) ? " and falling" : ""),
        ],
      };
    },
  },
  {
    id: "hammer_bounce",
    name: "Hammer Oversold Bounce",
    description: "Hammer candle at oversold lows",
    category: "reversal",
    indicators: ["Candlestick", "RSI", "EMA200"],
    evaluate(cs: Candle[]) {
      const c = closes(cs);
      const rsi = rsiSeries(c);
      const e200 = emaSeries(c, 200);
      const cur = cs[cs.length - 1];
      if (!ok(last(rsi)) || !isHammer(cur)) return null;
      if (!(last(rsi) < 38 || nearLow(cs))) return null;
      const conf = clampConfidence(56 + (38 - Math.min(38, last(rsi))) + (nearLow(cs) ? 8 : 0) + (ok(last(e200)) && last(c) > last(e200) * 0.97 ? 6 : 0));
      return {
        strategyId: "hammer_bounce",
        direction: "LONG",
        confidence: conf,
        reasons: [
          `Hammer candle (lower wick ≥ 2× body)`,
          `RSI ${last(rsi).toFixed(1)} — oversold zone`,
          nearLow(cs) ? "Formed at local lows" : "Formed above local lows",
        ],
      };
    },
  },
  {
    id: "morning_star",
    name: "Morning Star Bullish Divergence",
    description: "Bottom pattern with divergence",
    category: "reversal",
    indicators: ["Candlestick", "MACD"],
    evaluate(cs: Candle[]) {
      const c = closes(cs);
      const n = cs.length;
      if (n < 3) return null;
      const pattern = isMorningStar(cs[n - 3], cs[n - 2], cs[n - 1]);
      const m = macdSeries(c);
      const div = bullishDivergence(c, m.macd);
      if (!pattern && !div) return null;
      if (!pattern && div && last(m.hist) < 0) return null;
      const conf = clampConfidence(54 + (pattern ? 16 : 0) + (div ? 16 : 0) + (last(m.hist) > prev(m.hist) ? 6 : 0));
      return {
        strategyId: "morning_star",
        direction: "LONG",
        confidence: conf,
        reasons: [
          pattern ? "Morning star 3-candle bottom" : "No morning star body (divergence-led)",
          div ? "Bullish MACD divergence (price LL, MACD HL)" : "No MACD divergence",
        ],
      };
    },
  },
  {
    id: "shooting_star",
    name: "Shooting Star Overbought Alert",
    description: "Overbought shooting star warning",
    category: "reversal",
    indicators: ["Candlestick", "RSI", "EMA50"],
    evaluate(cs: Candle[]) {
      const c = closes(cs);
      const rsi = rsiSeries(c);
      const e50 = emaSeries(c, 50);
      const cur = cs[cs.length - 1];
      if (!ok(last(rsi)) || !isShootingStar(cur)) return null;
      if (!(last(rsi) > 62 || nearHigh(cs))) return null;
      const conf = clampConfidence(56 + (Math.min(100, last(rsi)) - 62) * 0.6 + (nearHigh(cs) ? 8 : 0) + (ok(last(e50)) && last(e50) > prev(e50) ? 4 : 0));
      return {
        strategyId: "shooting_star",
        direction: "SHORT",
        confidence: conf,
        reasons: [
          "Shooting star (upper wick ≥ 2× body)",
          `RSI ${last(rsi).toFixed(1)} — overbought zone`,
          nearHigh(cs) ? "Formed at local highs" : "Formed below local highs",
        ],
      };
    },
  },
  {
    id: "dark_cloud",
    name: "Dark Cloud Cover Death Cross",
    description: "Bearish top with MACD cross",
    category: "reversal",
    indicators: ["Candlestick", "MACD"],
    evaluate(cs: Candle[]) {
      const c = closes(cs);
      const n = cs.length;
      if (n < 2) return null;
      const pattern = isDarkCloudCover(cs[n - 2], cs[n - 1]);
      const m = macdSeries(c);
      const macdDown = crossDown(m.macd, m.signal);
      if (!pattern && !macdDown) return null;
      if (!pattern) return null;
      const conf = clampConfidence(55 + 14 + (macdDown ? 14 : 0) + (nearHigh(cs) ? 8 : 0));
      return {
        strategyId: "dark_cloud",
        direction: "SHORT",
        confidence: conf,
        reasons: [
          "Dark cloud cover at the top",
          macdDown ? "MACD crossed down" : "MACD cross pending",
        ],
      };
    },
  },
  {
    id: "bollinger_breakout",
    name: "Bollinger Upper Band Breakout",
    description: "Upper band breakout with momentum",
    category: "breakout",
    indicators: ["BB(20,2)", "RSI", "VOLUME"],
    evaluate(cs: Candle[]) {
      const c = closes(cs);
      const bb = bollingerSeries(c);
      const rsi = rsiSeries(c);
      if (!ok(last(bb.upper)) || !ok(last(rsi))) return null;
      const broke = last(c) > last(bb.upper) && prev(c) <= prev(bb.upper);
      const riding = last(c) > last(bb.upper);
      if (!riding) return null;
      const volAvg = volumeSma(cs);
      const volUp = volAvg > 0 && cs[cs.length - 1].volume > volAvg;
      const conf = clampConfidence(57 + (broke ? 12 : 5) + (last(rsi) > 55 && last(rsi) < 74 ? 10 : 2) + (volUp ? 8 : 0));
      return {
        strategyId: "bollinger_breakout",
        direction: "LONG",
        confidence: conf,
        reasons: [
          broke ? "Fresh close above upper Bollinger band" : "Riding the upper band",
          `RSI ${last(rsi).toFixed(1)} momentum ${last(rsi) > 55 ? "confirmed" : "weak"}`,
          volUp ? "Above-average volume" : "Flat volume",
        ],
      };
    },
  },
  {
    id: "midband_macd",
    name: "Mid-Band MACD Cross",
    description: "Bullish MACD above mid-band",
    category: "breakout",
    indicators: ["MACD", "BB(20,2)", "RSI"],
    evaluate(cs: Candle[]) {
      const c = closes(cs);
      const bb = bollingerSeries(c);
      const m = macdSeries(c);
      const rsi = rsiSeries(c);
      if (!ok(last(bb.mid)) || !ok(last(m.macd)) || !ok(last(m.signal))) return null;
      const aboveMid = last(c) > last(bb.mid);
      const crossed = crossUp(m.macd, m.signal);
      const bullishAbove = aboveMid && last(m.macd) > last(m.signal);
      if (!bullishAbove || (ok(last(rsi)) && last(rsi) < 48)) return null;
      const conf = clampConfidence(55 + (crossed ? 15 : 6) + (ok(last(rsi)) ? (last(rsi) - 50) * 0.4 : 0));
      return {
        strategyId: "midband_macd",
        direction: "LONG",
        confidence: conf,
        reasons: [
          "Price above Bollinger mid-band",
          crossed ? "Fresh MACD bullish cross" : "MACD above signal line",
        ],
      };
    },
  },
  {
    id: "ma200_macd",
    name: "MA200 Cross MACD Confirm",
    description: "Major trend turn bullish",
    category: "trend",
    indicators: ["MA200", "MACD"],
    evaluate(cs: Candle[]) {
      const c = closes(cs);
      const s200 = smaSeries(c, 200);
      if (!ok(last(s200)) || !ok(prev(s200))) return null;
      const cross = crossUp(c, s200);
      const above = last(c) > s200[s200.length - 1];
      const m = macdSeries(c);
      const macdOk = ok(last(m.macd)) && ok(last(m.signal)) && last(m.macd) > last(m.signal);
      if (!above || !macdOk) return null;
      const conf = clampConfidence(57 + (cross ? 16 : 7) + (last(m.hist) > prev(m.hist) ? 8 : 0));
      return {
        strategyId: "ma200_macd",
        direction: "LONG",
        confidence: conf,
        reasons: [
          cross ? "Price crossed above MA200" : "Price holding above MA200",
          "MACD above signal line",
        ],
      };
    },
  },
  {
    id: "vegas_bull",
    name: "Vegas Tunnel Trend-Confirmed Bullish",
    description: "Tunnel-up golden cross long",
    category: "trend",
    indicators: ["EMA144", "EMA169", "EMA12"],
    evaluate(cs: Candle[]) {
      const c = closes(cs);
      const e144 = emaSeries(c, 144);
      const e169 = emaSeries(c, 169);
      const e12 = emaSeries(c, 12);
      if (!ok(last(e144)) || !ok(last(e169)) || !ok(last(e12))) return null;
      const tunnelUp = last(e144) > last(e169);
      const freshCross = crossUp(e144, e169) || (tunnelUp && crossUp(e12, e144));
      const priceAbove = last(c) > last(e144);
      if (!(tunnelUp && priceAbove)) return null;
      const sep = Math.abs(last(e144) - last(e169)) / last(c);
      const conf = clampConfidence(58 + (freshCross ? 14 : 6) + Math.min(20, sep * 4000) + (rising(e144, 4) ? 6 : 0));
      return {
        strategyId: "vegas_bull",
        direction: "LONG",
        confidence: conf,
        reasons: [
          freshCross ? "Fresh EMA144/169 tunnel golden cross" : "Vegas tunnel (144>169) established",
          `EMA12 (${last(e12).toFixed(4)}) above tunnel`,
          "Price trading over the tunnel",
        ],
      };
    },
  },
  {
    id: "tema_vwap",
    name: "TEMA Cross Above VWAP Confirm",
    description: "Intraday bullish alignment",
    category: "trend",
    indicators: ["TEMA30", "VWAP"],
    evaluate(cs: Candle[]) {
      const c = closes(cs);
      const tema = temaSeries(c, 30);
      const vwap = vwapSeries(cs);
      if (!ok(last(tema)) || !ok(last(vwap))) return null;
      const cross = crossUp(tema, vwap);
      const aligned = last(tema) > last(vwap) && last(c) > last(vwap);
      if (!aligned) return null;
      const conf = clampConfidence(55 + (cross ? 16 : 7) + (rising(tema, 3) ? 8 : 0));
      return {
        strategyId: "tema_vwap",
        direction: "LONG",
        confidence: conf,
        reasons: [
          cross ? "TEMA30 crossed above VWAP" : "TEMA30 above VWAP",
          "Price above VWAP",
        ],
      };
    },
  },
  {
    id: "dema55_macd",
    name: "DEMA55 Bullish Trend Follow",
    description: "Mid-term bullish momentum",
    category: "trend",
    indicators: ["DEMA55", "MACD"],
    evaluate(cs: Candle[]) {
      const c = closes(cs);
      const dema = demaSeries(c, 55);
      const m = macdSeries(c);
      if (!ok(last(dema)) || !ok(last(m.macd))) return null;
      const upTrend = rising(dema, 4) && last(c) > last(dema);
      const macdOk = last(m.macd) > 0 || (ok(last(m.hist)) && last(m.hist) > 0);
      if (!upTrend || !macdOk) return null;
      const conf = clampConfidence(56 + 10 + (last(m.hist) > prev(m.hist) ? 8 : 0));
      return {
        strategyId: "dema55_macd",
        direction: "LONG",
        confidence: conf,
        reasons: ["DEMA55 rising with price above it", "MACD positive territory"],
      };
    },
  },
  {
    id: "vwap_bull",
    name: "VWAP Bullish Confirmation",
    description: "Intraday bullish confirmation",
    category: "trend",
    indicators: ["MACD", "PRICE", "VWAP"],
    evaluate(cs: Candle[]) {
      const c = closes(cs);
      const vwap = vwapSeries(cs);
      const m = macdSeries(c);
      if (!ok(last(vwap)) || !ok(last(m.hist))) return null;
      const above = last(c) > last(vwap);
      const reclaimed = prev(c) <= prev(vwap) && above;
      if (!above || last(m.hist) <= 0) return null;
      const conf = clampConfidence(54 + (reclaimed ? 14 : 6) + (last(m.hist) > prev(m.hist) ? 8 : 0));
      return {
        strategyId: "vwap_bull",
        direction: "LONG",
        confidence: conf,
        reasons: [
          reclaimed ? "Price reclaimed VWAP" : "Price holding above VWAP",
          "MACD histogram positive" + (last(m.hist) > prev(m.hist) ? " and rising" : ""),
        ],
      };
    },
  },
  {
    id: "three_soldiers",
    name: "Three White Soldiers Trend Confirm",
    description: "Three White Soldiers continuation",
    category: "trend",
    indicators: ["Candlestick", "RSI", "EMA20"],
    evaluate(cs: Candle[]) {
      const c = closes(cs);
      const n = cs.length;
      if (n < 3) return null;
      const pattern = isThreeWhiteSoldiers(cs[n - 3], cs[n - 2], cs[n - 1]);
      if (!pattern) return null;
      const rsi = rsiSeries(c);
      const e20 = emaSeries(c, 20);
      const rsiOk = ok(last(rsi)) && last(rsi) > 50 && last(rsi) < 74;
      const emaOk = ok(last(e20)) && rising(e20, 3);
      const conf = clampConfidence(60 + (rsiOk ? 10 : 2) + (emaOk ? 10 : 2));
      return {
        strategyId: "three_soldiers",
        direction: "LONG",
        confidence: conf,
        reasons: [
          "Three white soldiers printed",
          rsiOk ? `RSI ${last(rsi).toFixed(1)} in continuation band` : "RSI extended or weak",
          emaOk ? "EMA20 rising" : "EMA20 flat",
        ],
      };
    },
  },
];

export const STRATEGY_BY_ID = new Map(STRATEGIES.map((s) => [s.id, s]));

export function scanCandles(candles: Candle[]) {
  const out: { strategy: Strategy; signal: NonNullable<ReturnType<Strategy["evaluate"]>> }[] = [];
  for (const s of STRATEGIES) {
    try {
      const sig = s.evaluate(candles);
      if (sig) out.push({ strategy: s, signal: sig });
    } catch {
      /* defective data window — skip strategy honestly */
    }
  }
  return out;
}
