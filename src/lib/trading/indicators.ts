import type { Candle } from "./types";

/* ------------------------------------------------------------------ */
/* Series helpers. All functions return series aligned to the input.   */
/* Warmup positions are NaN.                                           */
/* ------------------------------------------------------------------ */

export function smaSeries(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function emaSeries(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  const k = 2 / (period + 1);
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    if (Number.isNaN(prev)) {
      if (i >= period - 1) {
        let s = 0;
        for (let j = i - period + 1; j <= i; j++) s += values[j];
        prev = s / period;
        out[i] = prev;
      }
      continue;
    }
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Double Exponential Moving Average: DEMA = 2*E1 - E2 */
export function demaSeries(values: number[], period: number): number[] {
  const e1 = emaSeries(values, period);
  const e2 = emaSeries(e1.map((v) => (Number.isNaN(v) ? values[0] : v)), period);
  return e1.map((v, i) => (Number.isNaN(v) || Number.isNaN(e2[i]) ? NaN : 2 * v - e2[i]));
}

/** Triple Exponential Moving Average: TEMA = 3*E1 - 3*E2 + E3 */
export function temaSeries(values: number[], period: number): number[] {
  const e1 = emaSeries(values, period);
  const e2 = emaSeries(e1.map((v) => (Number.isNaN(v) ? values[0] : v)), period);
  const e3 = emaSeries(e2.map((v) => (Number.isNaN(v) ? values[0] : v)), period);
  return e1.map((v, i) =>
    Number.isNaN(v) || Number.isNaN(e2[i]) || Number.isNaN(e3[i])
      ? NaN
      : 3 * v - 3 * e2[i] + e3[i]
  );
}

/** Wilder RSI */
export function rsiSeries(closes: number[], period = 14): number[] {
  const out = new Array<number>(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export interface Macd {
  macd: number[];
  signal: number[];
  hist: number[];
}

export function macdSeries(closes: number[], fast = 12, slow = 26, sig = 9): Macd {
  const ef = emaSeries(closes, fast);
  const es = emaSeries(closes, slow);
  const macd = closes.map((_, i) =>
    Number.isNaN(ef[i]) || Number.isNaN(es[i]) ? NaN : ef[i] - es[i]
  );
  const first = macd.findIndex((v) => !Number.isNaN(v));
  const signal = new Array<number>(closes.length).fill(NaN);
  if (first >= 0) {
    const sub = emaSeries(macd.slice(first), sig);
    for (let i = 0; i < sub.length; i++) signal[first + i] = sub[i];
  }
  const hist = macd.map((v, i) =>
    Number.isNaN(v) || Number.isNaN(signal[i]) ? NaN : v - signal[i]
  );
  return { macd, signal, hist };
}

export interface Bollinger {
  upper: number[];
  mid: number[];
  lower: number[];
}

export function bollingerSeries(closes: number[], period = 20, mult = 2): Bollinger {
  const mid = smaSeries(closes, period);
  const upper = new Array<number>(closes.length).fill(NaN);
  const lower = new Array<number>(closes.length).fill(NaN);
  for (let i = period - 1; i < closes.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return { upper, mid, lower };
}

/** Session-approximated VWAP over the provided candle window. */
export function vwapSeries(candles: Candle[]): number[] {
  const out = new Array<number>(candles.length).fill(NaN);
  let pv = 0;
  let vv = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const typical = (c.high + c.low + c.close) / 3;
    const vol = c.volume || 0;
    pv += typical * vol;
    vv += vol;
    out[i] = vv > 0 ? pv / vv : c.close;
  }
  return out;
}

export function atrSeries(candles: Candle[], period = 14): number[] {
  const out = new Array<number>(candles.length).fill(NaN);
  if (candles.length <= period) return out;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    trs.push(
      Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close))
    );
  }
  let atr = 0;
  for (let i = 0; i < period; i++) atr += trs[i];
  atr /= period;
  out[period] = atr;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    out[i + 1] = atr;
  }
  return out;
}

/* ------------------------------ utilities ------------------------------ */

export const last = (s: number[]) => s[s.length - 1];
export const prev = (s: number[]) => s[s.length - 2];
export const ok = (v: number) => !Number.isNaN(v) && Number.isFinite(v);

export function crossUp(a: number[], b: number[]): boolean {
  const n = a.length;
  if (n < 2 || !ok(a[n - 1]) || !ok(b[n - 1]) || !ok(a[n - 2]) || !ok(b[n - 2]))
    return false;
  return a[n - 2] <= b[n - 2] && a[n - 1] > b[n - 1];
}

export function crossDown(a: number[], b: number[]): boolean {
  const n = a.length;
  if (n < 2 || !ok(a[n - 1]) || !ok(b[n - 1]) || !ok(a[n - 2]) || !ok(b[n - 2]))
    return false;
  return a[n - 2] >= b[n - 2] && a[n - 1] < b[n - 1];
}

export function rising(s: number[], lookback = 3): boolean {
  const n = s.length;
  if (n < lookback + 1) return false;
  for (let i = n - lookback; i < n - 1; i++) {
    if (!ok(s[i]) || !ok(s[i + 1]) || s[i + 1] <= s[i]) return false;
  }
  return true;
}

export function falling(s: number[], lookback = 3): boolean {
  const n = s.length;
  if (n < lookback + 1) return false;
  for (let i = n - lookback; i < n - 1; i++) {
    if (!ok(s[i]) || !ok(s[i + 1]) || s[i + 1] >= s[i]) return false;
  }
  return true;
}

export function closes(candles: Candle[]): number[] {
  return candles.map((c) => c.close);
}

export function volumeSma(candles: Candle[], period = 20): number {
  const n = candles.length;
  const from = Math.max(0, n - 1 - period);
  let s = 0;
  let c = 0;
  for (let i = from; i < n - 1; i++) {
    s += candles[i].volume;
    c++;
  }
  return c > 0 ? s / c : 0;
}

/* --------------------------- candlestick sets --------------------------- */

function body(c: Candle) {
  return Math.abs(c.close - c.open);
}
function upperWick(c: Candle) {
  return c.high - Math.max(c.close, c.open);
}
function lowerWick(c: Candle) {
  return Math.min(c.close, c.open) - c.low;
}

export function isHammer(c: Candle): boolean {
  const b = body(c);
  if (b <= 0) return false;
  return lowerWick(c) >= 2 * b && upperWick(c) <= 0.6 * b;
}

export function isShootingStar(c: Candle): boolean {
  const b = body(c);
  if (b <= 0) return false;
  return upperWick(c) >= 2 * b && lowerWick(c) <= 0.6 * b;
}

export function isMorningStar(a: Candle, b: Candle, c: Candle): boolean {
  const aBear = a.close < a.open && body(a) > (a.high - a.low) * 0.45;
  const bSmall = body(b) < body(a) * 0.4;
  const bGapsDown = Math.max(b.open, b.close) <= a.close;
  const cBull = c.close > c.open && c.close > (a.open + a.close) / 2;
  return aBear && bSmall && (bGapsDown || true) && cBull;
}

export function isDarkCloudCover(a: Candle, b: Candle): boolean {
  const aBull = a.close > a.open;
  const bBear = b.close < b.open;
  const opensAbove = b.open > a.high || b.open > a.close;
  const closesIntoBody = b.close < (a.open + a.close) / 2 && b.close > a.open;
  return aBull && bBear && opensAbove && closesIntoBody;
}

export function isThreeWhiteSoldiers(a: Candle, b: Candle, c: Candle): boolean {
  const bull = (x: Candle) => x.close > x.open && body(x) > (x.high - x.low) * 0.5;
  const stair = b.close > a.close && c.close > b.close;
  const opensInside =
    b.open > a.open && b.open < a.close && c.open > b.open && c.open < b.close;
  return bull(a) && bull(b) && bull(c) && stair && opensInside;
}

/** Simplified bullish divergence: price made a lower low while MACD histogram/macd made a higher low over the window. */
export function bullishDivergence(closesArr: number[], macdLine: number[], lookback = 40): boolean {
  const n = closesArr.length;
  if (n < lookback + 2) return false;
  const half = Math.floor(lookback / 2);
  const minOf = (arr: number[], from: number, to: number) => {
    let m = Infinity;
    for (let i = Math.max(0, from); i < Math.min(arr.length, to); i++)
      if (ok(arr[i]) && arr[i] < m) m = arr[i];
    return m;
  };
  const priceOld = minOf(closesArr, n - lookback, n - half);
  const priceNew = minOf(closesArr, n - half, n);
  const macdOld = minOf(macdLine, n - lookback, n - half);
  const macdNew = minOf(macdLine, n - half, n);
  return priceNew < priceOld && ok(macdOld) && ok(macdNew) && macdNew > macdOld;
}

export const clampConfidence = (v: number) => Math.max(35, Math.min(97, Math.round(v)));

export function fmt(n: number, dp = 4): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000) return n.toFixed(2);
  if (Math.abs(n) >= 1) return n.toFixed(dp > 2 ? 3 : dp);
  return n.toFixed(6);
}
