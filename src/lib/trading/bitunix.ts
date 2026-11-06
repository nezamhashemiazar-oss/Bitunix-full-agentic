import crypto from "node:crypto";
import type { Candle } from "./types";

/* ------------------------------------------------------------------ */
/* Bitunix Futures OpenAPI client.                                     */
/* Docs: https://www.bitunix.com/api-docs (futures)                    */
/* Public market data needs no auth. Private endpoints use the         */
/* double-SHA256 signature scheme:                                     */
/*   digest = sha256(nonce + timestamp + apiKey + queryParams + body)  */
/*   sign   = sha256(digest + secretKey)                               */
/* ------------------------------------------------------------------ */

const BASE = "https://fapi.bitunix.com";

async function httpGet(path: string, query: Record<string, string>, timeoutMs = 7000) {
  const qs = new URLSearchParams(query).toString();
  const url = `${BASE}${path}${qs ? `?${qs}` : ""}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as { code: number; data: unknown; msg: string };
  } finally {
    clearTimeout(t);
  }
}

function signHeaders(
  apiKey: string,
  secretKey: string,
  queryParams: string,
  body: string
) {
  const nonce = crypto.randomBytes(16).toString("hex");
  const timestamp = Date.now().toString();
  const digest = crypto
    .createHash("sha256")
    .update(nonce + timestamp + apiKey + queryParams + body)
    .digest("hex");
  const sign = crypto
    .createHash("sha256")
    .update(digest + secretKey)
    .digest("hex");
  return {
    "api-key": apiKey,
    sign,
    nonce,
    timestamp,
    language: "en-US",
    "Content-Type": "application/json",
  } as Record<string, string>;
}

function buildQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${k}${params[k]}`)
    .join("");
}

async function signedRequest<T = unknown>(
  method: "GET" | "POST",
  path: string,
  apiKey: string,
  secretKey: string,
  params: Record<string, string> = {},
  bodyObj: Record<string, unknown> | null = null,
  timeoutMs = 8000
): Promise<T> {
  const qp = buildQuery(params);
  const body = bodyObj ? JSON.stringify(bodyObj) : "";
  const headers = signHeaders(apiKey, secretKey, qp, body);
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE}${path}${method === "GET" && qs ? `?${qs}` : ""}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: method === "POST" ? body : undefined,
      signal: ctl.signal,
      cache: "no-store",
    });
    const json = (await res.json()) as { code: number; data: T; msg: string };
    if (json.code !== 0) {
      throw new Error(`Bitunix error ${json.code}: ${json.msg || "unknown"}`);
    }
    return json.data;
  } finally {
    clearTimeout(t);
  }
}

/* ---------------------------- Public market ----------------------------- */

export interface Ticker {
  symbol: string;
  lastPrice: number;
  high: number;
  low: number;
  baseVolume: number;
  quoteVolume: number;
}

export async function getTickers(symbols: string[]): Promise<Map<string, Ticker>> {
  const json = await httpGet("/api/v1/futures/market/tickers", {
    symbols: symbols.join(","),
  });
  const map = new Map<string, Ticker>();
  const arr = (json.data as Record<string, string>[]) || [];
  for (const t of arr) {
    map.set(t.symbol, {
      symbol: t.symbol,
      lastPrice: parseFloat(t.lastPrice),
      high: parseFloat(t.high ?? t.highPrice ?? "0"),
      low: parseFloat(t.low ?? t.lowPrice ?? "0"),
      baseVolume: parseFloat(t.baseVol ?? t.baseVolume ?? "0"),
      quoteVolume: parseFloat(t.quoteVol ?? t.quoteVolume ?? "0"),
    });
  }
  if (map.size === 0) throw new Error("No ticker data returned");
  return map;
}

export async function getKlines(
  symbol: string,
  interval: string,
  limit = 200
): Promise<Candle[]> {
  const json = await httpGet("/api/v1/futures/market/kline", {
    symbol,
    interval,
    limit: String(Math.min(200, limit)),
  });
  const arr = (json.data as Record<string, string | number>[]) || [];
  const candles: Candle[] = arr
    .map((k) => ({
      time: Number(k.time),
      open: parseFloat(String(k.open)),
      high: parseFloat(String(k.high)),
      low: parseFloat(String(k.low)),
      close: parseFloat(String(k.close)),
      volume: parseFloat(String(k.baseVol ?? "0")),
      quoteVolume: parseFloat(String(k.quoteVol ?? "0")),
    }))
    .sort((a, b) => a.time - b.time);
  if (candles.length < 30) throw new Error(`Too few klines (${candles.length})`);
  return candles;
}

/* ---------------------------- Private REST ------------------------------ */

export interface LiveCredentials {
  apiKey: string;
  secretKey: string;
}

export async function getAccount(c: LiveCredentials, marginCoin = "USDT") {
  return signedRequest("GET", "/api/v1/futures/account", c.apiKey, c.secretKey, { marginCoin });
}

export async function getPendingPositions(c: LiveCredentials) {
  return signedRequest("GET", "/api/v1/futures/position/get_pending_positions", c.apiKey, c.secretKey, {});
}

export async function changeLeverage(c: LiveCredentials, symbol: string, leverage: number, marginCoin = "USDT") {
  return signedRequest("POST", "/api/v1/futures/account/change_leverage", c.apiKey, c.secretKey, {}, {
    symbol,
    leverage: String(leverage),
    marginCoin,
  });
}

export async function changeMarginMode(c: LiveCredentials, symbol: string, marginMode: "ISOLATION" | "CROSS", marginCoin = "USDT") {
  return signedRequest("POST", "/api/v1/futures/account/change_margin_mode", c.apiKey, c.secretKey, {}, {
    symbol,
    marginMode,
    marginCoin,
  });
}

export async function changePositionMode(c: LiveCredentials, mode: "HEDGE" | "ONE_WAY") {
  return signedRequest("POST", "/api/v1/futures/account/change_position_mode", c.apiKey, c.secretKey, {}, { positionMode: mode });
}

export interface PlaceOrderInput {
  symbol: string;
  side: "BUY" | "SELL";
  tradeSide?: "OPEN" | "CLOSE";
  qty: string;
  orderType: "MARKET" | "LIMIT";
  price?: string;
  positionId?: string;
  reduceOnly?: boolean;
  clientId?: string;
  tpPrice?: string;
  tpStopType?: "LAST_PRICE" | "MARK_PRICE";
  tpOrderType?: "MARKET" | "LIMIT";
  tpOrderPrice?: string;
  slPrice?: string;
  slStopType?: "LAST_PRICE" | "MARK_PRICE";
  slOrderType?: "MARKET" | "LIMIT";
  slOrderPrice?: string;
}

export async function placeOrder(c: LiveCredentials, input: PlaceOrderInput) {
  return signedRequest<{ orderId: string; clientId: string }>(
    "POST",
    "/api/v1/futures/trade/place_order",
    c.apiKey,
    c.secretKey,
    {},
    input as unknown as Record<string, unknown>
  );
}

export async function flashClosePosition(c: LiveCredentials, positionId: string) {
  return signedRequest("POST", "/api/v1/futures/trade/flash_close_position", c.apiKey, c.secretKey, {}, { positionId });
}

export async function placePositionTpSl(
  c: LiveCredentials,
  input: { positionId: string; symbol: string; tpPrice?: string; slPrice?: string; tpStopType?: string; slStopType?: string; tpOrderType?: string; slOrderType?: string }
) {
  return signedRequest("POST", "/api/v1/futures/position/place_position_tp_sl", c.apiKey, c.secretKey, {}, input as unknown as Record<string, unknown>);
}

export async function getHistoryOrders(c: LiveCredentials, symbol?: string, limit = 20) {
  return signedRequest("GET", "/api/v1/futures/trade/get_history_orders", c.apiKey, c.secretKey, {
    ...(symbol ? { symbol } : {}),
    limit: String(limit),
  });
}

export async function getHistoryPositions(c: LiveCredentials, limit = 20) {
  return signedRequest("GET", "/api/v1/futures/position/get_history_positions", c.apiKey, c.secretKey, { limit: String(limit) });
}

export async function getHistoryTpSl(c: LiveCredentials, limit = 20) {
  return signedRequest("GET", "/api/v1/futures/tpsl/get_history_tp_sl_order", c.apiKey, c.secretKey, { limit: String(limit) });
}

/* --------------------- Offline synthetic data fallback ------------------- */
/* Used ONLY when the exchange is unreachable, and clearly flagged via      */
/* dataSource="offline-sim" so the agent never lies about data provenance.  */

const g = globalThis as typeof globalThis & {
  __jrockPrices?: Map<string, number>;
  __jrockOffline?: boolean;
};

const BASE_PRICES: Record<string, number> = {
  BTCUSDT: 97240,
  ETHUSDT: 3412,
  SOLUSDT: 214.6,
  XRPUSDT: 2.18,
  DOGEUSDT: 0.3121,
  BNBUSDT: 692.4,
  ADAUSDT: 0.9821,
  LINKUSDT: 22.14,
};

function seedFrom(str: string) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

function prices(): Map<string, number> {
  if (!g.__jrockPrices) {
    g.__jrockPrices = new Map();
    for (const [s, p] of Object.entries(BASE_PRICES)) g.__jrockPrices.set(s, p);
  }
  return g.__jrockPrices;
}

export function markOffline(on: boolean) {
  g.__jrockOffline = on;
}
export function isOffline() {
  return g.__jrockOffline === true;
}

export function syntheticTick(symbol: string): number {
  const map = prices();
  const cur = map.get(symbol) ?? BASE_PRICES[symbol] ?? 100;
  const rnd = seedFrom(symbol + Math.floor(Date.now() / 4000));
  const next = cur * (1 + (rnd() - 0.5) * 0.0016);
  map.set(symbol, next);
  return next;
}

export function syntheticKlines(symbol: string, interval: string, limit = 200): Candle[] {
  const tfMs =
    { "1m": 60e3, "3m": 18e4, "5m": 3e5, "15m": 9e5, "30m": 18e5, "1h": 36e5, "2h": 72e5, "4h": 144e5, "1d": 864e5 }[
      interval
    ] ?? 60e3;
  const rnd = seedFrom(symbol + interval);
  const end = Math.floor(Date.now() / tfMs) * tfMs;
  let price = (BASE_PRICES[symbol] ?? 100) * (1 + (rnd() - 0.5) * 0.05);
  const candles: Candle[] = [];
  const drift = Math.sin(Date.now() / 3.6e6 + rnd() * 6) * 0.0004;
  for (let i = limit - 1; i >= 0; i--) {
    const vol = 0.0018 + rnd() * 0.002;
    const open = price;
    const close = open * (1 + drift + (rnd() - 0.5) * vol * 2);
    const high = Math.max(open, close) * (1 + rnd() * vol * 0.6);
    const low = Math.min(open, close) * (1 - rnd() * vol * 0.6);
    candles.push({
      time: end - i * tfMs,
      open,
      high,
      low,
      close,
      volume: 500 + rnd() * 4500,
      quoteVolume: close * (500 + rnd() * 4500),
    });
    price = close;
  }
  const map = prices();
  map.set(symbol, candles[candles.length - 1].close);
  return candles;
}

/** Price with cache + offline fallback. Returns {price, offline}. */
export async function fetchPrices(symbols: string[]): Promise<{
  prices: Map<string, number>;
  offline: boolean;
}> {
  try {
    const tickers = await getTickers(symbols);
    markOffline(false);
    const map = new Map<string, number>();
    for (const s of symbols) {
      const t = tickers.get(s);
      if (t) map.set(s, t.lastPrice);
    }
    if (map.size === 0) throw new Error("empty ticker map");
    return { prices: map, offline: false };
  } catch {
    markOffline(true);
    const map = new Map<string, number>();
    for (const s of symbols) map.set(s, syntheticTick(s));
    return { prices: map, offline: true };
  }
}

export async function fetchKlinesSafe(
  symbol: string,
  interval: string,
  limit = 200
): Promise<{ candles: Candle[]; offline: boolean }> {
  if (isOffline()) return { candles: syntheticKlines(symbol, interval, limit), offline: true };
  try {
    const candles = await getKlines(symbol, interval, limit);
    return { candles, offline: false };
  } catch {
    markOffline(true);
    return { candles: syntheticKlines(symbol, interval, limit), offline: true };
  }
}
