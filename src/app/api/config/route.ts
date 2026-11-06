import { NextRequest, NextResponse } from "next/server";
import { getAllCfg, setCfg, mask } from "@/lib/agent/config";
import { db } from "@/db";
import { skills, mcps, memories } from "@/db/schema";
import { desc } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WRITABLE = new Set([
  "provider",
  "baseUrl",
  "apiKey",
  "model",
  "thinkOn",
  "autoAccept",
  "allowTerminal",
  "soul",
  "bitunixKey",
  "bitunixSecret",
  "githubToken",
  "githubRepo",
]);

export async function GET() {
  const cfg = await getAllCfg();
  const [skillRows, mcpRows, memRows] = await Promise.all([
    db.select().from(skills).orderBy(desc(skills.createdAt)),
    db.select().from(mcps).orderBy(desc(mcps.createdAt)),
    db.select().from(memories).orderBy(desc(memories.id)).limit(20),
  ]);
  return NextResponse.json({
    provider: cfg.provider || "",
    baseUrl: cfg.baseUrl || "",
    model: cfg.model || "",
    apiKeyMasked: mask(cfg.apiKey),
    hasApiKey: !!cfg.apiKey,
    thinkOn: cfg.thinkOn === "true",
    autoAccept: cfg.autoAccept === "true",
    allowTerminal: cfg.allowTerminal === "true",
    soul: cfg.soul || "",
    bitunixKeyMasked: mask(cfg.bitunixKey),
    hasBitunix: !!(cfg.bitunixKey && cfg.bitunixSecret),
    githubTokenMasked: mask(cfg.githubToken),
    hasGithub: !!cfg.githubToken,
    githubRepo: cfg.githubRepo || "",
    skills: skillRows,
    mcps: mcpRows,
    memories: memRows,
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Record<string, string>;
    const patched: string[] = [];
    for (const [k, v] of Object.entries(body)) {
      if (!WRITABLE.has(k)) continue;
      await setCfg(k, String(v).slice(0, 4096));
      patched.push(k);
    }
    return NextResponse.json({ ok: true, patched });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
