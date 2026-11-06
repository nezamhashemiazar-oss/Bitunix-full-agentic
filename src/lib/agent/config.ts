import { db } from "@/db";
import { config } from "@/db/schema";
import { eq } from "drizzle-orm";

/* Server-side key/value config, seeded from env once. */

const g = globalThis as typeof globalThis & { __jrockCfgSeeded?: boolean };

export async function seedConfigFromEnv() {
  if (g.__jrockCfgSeeded) return;
  g.__jrockCfgSeeded = true;
  const seeds: Record<string, string | undefined> = {
    apiKey: process.env.AGENT_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || "",
    baseUrl: process.env.AGENT_BASE_URL || process.env.OPENAI_BASE_URL || "",
    provider: process.env.AGENT_PROVIDER || "",
    model: process.env.AGENT_MODEL || "",
    bitunixKey: process.env.BITUNIX_API_KEY || "",
    bitunixSecret: process.env.BITUNIX_SECRET_KEY || "",
    githubToken: process.env.GITHUB_TOKEN || "",
    githubRepo: process.env.GITHUB_REPO || "",
  };
  for (const [key, value] of Object.entries(seeds)) {
    if (!value) continue;
    const existing = await db.select().from(config).where(eq(config.key, key)).limit(1);
    if (existing.length === 0) {
      await db.insert(config).values({ key, value });
    }
  }
}

export async function getCfg(key: string, def = ""): Promise<string> {
  await seedConfigFromEnv();
  const rows = await db.select().from(config).where(eq(config.key, key)).limit(1);
  return rows.length ? rows[0].value : def;
}

export async function setCfg(key: string, value: string) {
  await seedConfigFromEnv();
  const rows = await db.select().from(config).where(eq(config.key, key)).limit(1);
  if (rows.length) {
    await db.update(config).set({ value, updatedAt: new Date() }).where(eq(config.key, key));
  } else {
    await db.insert(config).values({ key, value });
  }
}

export async function getAllCfg(): Promise<Record<string, string>> {
  await seedConfigFromEnv();
  const rows = await db.select().from(config);
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function maskSecret(v: string | undefined | null): string {
  if (!v) return "";
  if (v.length <= 8) return "••••";
  return `${v.slice(0, 3)}••••••${v.slice(-4)}`;
}

export const mask = maskSecret;
