/* Shared trading-engine types */

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
}

export type Direction = "LONG" | "SHORT";

export interface StrategySignal {
  strategyId: string;
  direction: Direction;
  confidence: number; // 0-100
  reasons: string[];
}

export interface Strategy {
  id: string;
  name: string;
  description: string;
  category: "classic" | "risk" | "reversal" | "breakout" | "trend";
  indicators: string[];
  evaluate: (candles: Candle[]) => StrategySignal | null;
}

export interface EngineSettings {
  engineOn: boolean;
  scanOn: boolean;
  autotradeOn: boolean;
  reportOn: boolean;
  mode: "sim" | "live";
  symbols: string[];
  timeframes: string[];
  leverage: number;
  marginMode: "ISOLATED" | "CROSSED";
  positionMode: "HEDGE" | "ONE_WAY";
  maxOpenPositions: number;
  riskPerTradePct: number;
  simEquity: number;
  minConfidence: number;
  tfMinConfidence: number;
  minAgreeingStrategies: number;
  scanIntervalSec: number;
  reportIntervalSec: number;
  breakevenThresholdPct: number; // ROI % at which SL moves to breakeven
  trailingTriggerRoiPct: number; // ROI % at which trailing stop activates
  liqSlDistancePct: number; // SL placed this many ROI-% away from liquidation
  reversalEnabled: boolean;
  reversalConfidence: number;
  lastScanAt: number;
  lastReportAt: number;
  lastTickAt: number;
  dataSource: "bitunix" | "offline-sim";
}

export const DEFAULT_SETTINGS: EngineSettings = {
  engineOn: false,
  scanOn: true,
  autotradeOn: false,
  reportOn: false,
  mode: "sim",
  symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
  timeframes: ["1m", "3m", "5m", "15m"],
  leverage: 10,
  marginMode: "ISOLATED",
  positionMode: "HEDGE",
  maxOpenPositions: 3,
  riskPerTradePct: 2,
  simEquity: 10000,
  minConfidence: 70,
  tfMinConfidence: 60,
  minAgreeingStrategies: 3,
  scanIntervalSec: 15,
  reportIntervalSec: 30,
  breakevenThresholdPct: 25,
  trailingTriggerRoiPct: 45,
  liqSlDistancePct: 50,
  reversalEnabled: true,
  reversalConfidence: 80,
  lastScanAt: 0,
  lastReportAt: 0,
  lastTickAt: 0,
  dataSource: "bitunix",
};

export const ALLOWED_TIMEFRAMES = [
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "1d",
];

export interface TimeframeVote {
  timeframe: string;
  direction: Direction;
  confidence: number;
  agreeing: number;
  strategies: string[];
}

export interface AggregatedSignal {
  symbol: string;
  direction: Direction;
  confidence: number; // aggregate confidence
  agreeing: number; // total agreeing strategy votes (post tfMinConfidence filter)
  price: number;
  votes: TimeframeVote[];
  reasons: string[];
}
