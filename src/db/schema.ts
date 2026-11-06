import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  doublePrecision,
} from "drizzle-orm/pg-core";

/* ------------------------------ Agent / Chat ------------------------------ */

export const chatSessions = pgTable("chat_sessions", {
  id: text("id").primaryKey(),
  title: text("title").notNull().default("New session"),
  pendingAction: jsonb("pending_action"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  role: text("role").notNull().default("agent"), // user | agent | engine | system
  kind: text("kind").notNull().default("text"), // text | command | report | review | diagnostic | permission | tool
  content: text("content").notNull(),
  meta: jsonb("meta"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const config = pgTable("config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const memories = pgTable("memories", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull().default("note"), // note | preference | learning | correction
  content: text("content").notNull(),
  source: text("source").notNull().default("user"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const skills = pgTable("skills", {
  name: text("name").primaryKey(),
  description: text("description").notNull().default(""),
  instructions: text("instructions").notNull().default(""),
  active: boolean("active").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const mcps = pgTable("mcps", {
  name: text("name").primaryKey(),
  url: text("url").notNull(),
  transport: text("transport").notNull().default("http"),
  status: text("status").notNull().default("registered"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* ----------------------------- Trading Engine ----------------------------- */

export const tradingState = pgTable("trading_state", {
  id: text("id").primaryKey(), // singleton: "main"
  settings: jsonb("settings").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const positions = pgTable("positions", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(), // LONG | SHORT
  status: text("status").notNull().default("OPEN"), // OPEN | CLOSED
  mode: text("mode").notNull().default("sim"), // sim | live
  entryPrice: doublePrecision("entry_price").notNull(),
  markPrice: doublePrecision("mark_price"),
  qty: doublePrecision("qty").notNull(),
  notional: doublePrecision("notional").notNull(),
  margin: doublePrecision("margin").notNull(),
  leverage: integer("leverage").notNull(),
  liqPrice: doublePrecision("liq_price"),
  tpPrice: doublePrecision("tp_price"),
  slPrice: doublePrecision("sl_price"),
  initialSlPrice: doublePrecision("initial_sl_price"),
  bestRoi: doublePrecision("best_roi").notNull().default(0),
  breakevenArmed: boolean("breakeven_armed").notNull().default(false),
  confidence: doublePrecision("confidence").notNull().default(0),
  timeframe: text("timeframe").notNull().default(""),
  strategies: jsonb("strategies"),
  reasons: jsonb("reasons"),
  orderId: text("order_id"),
  realizedPnl: doublePrecision("realized_pnl"),
  closePrice: doublePrecision("close_price"),
  closeReason: text("close_reason"),
  openedAt: timestamp("opened_at").defaultNow().notNull(),
  closedAt: timestamp("closed_at"),
});

export const trades = pgTable("trades", {
  id: serial("id").primaryKey(),
  positionId: integer("position_id"),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(),
  action: text("action").notNull(), // OPEN | CLOSE | REVERSE_OPEN | REDUCE
  price: doublePrecision("price").notNull(),
  qty: doublePrecision("qty").notNull(),
  roi: doublePrecision("roi"),
  pnl: doublePrecision("pnl"),
  confidence: doublePrecision("confidence"),
  reason: text("reason").notNull().default(""),
  mode: text("mode").notNull().default("sim"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const tpslEvents = pgTable("tpsl_events", {
  id: serial("id").primaryKey(),
  positionId: integer("position_id"),
  symbol: text("symbol").notNull(),
  kind: text("kind").notNull(), // TP_HIT | SL_HIT | TRAILING | BREAKEVEN | MID_MGMT | REVERSE | LIQ
  detail: text("detail").notNull().default(""),
  price: doublePrecision("price"),
  roi: doublePrecision("roi"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const signals = pgTable("signals", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  timeframe: text("timeframe").notNull(),
  strategy: text("strategy").notNull(),
  category: text("category").notNull().default(""),
  direction: text("direction").notNull(), // LONG | SHORT
  confidence: doublePrecision("confidence").notNull(),
  price: doublePrecision("price").notNull().default(0),
  reasons: jsonb("reasons"),
  status: text("status").notNull().default("NEW"), // NEW | EXECUTED | EXPIRED | REJECTED
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const engineEvents = pgTable("engine_events", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull().default("info"), // info | warn | error | report | trade
  text: text("text").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const equityPoints = pgTable("equity_points", {
  id: serial("id").primaryKey(),
  equity: doublePrecision("equity").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
