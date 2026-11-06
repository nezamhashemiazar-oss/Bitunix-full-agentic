import { NextRequest, NextResponse } from "next/server";
import { pushProjectToGitHub } from "@/lib/agent/github";
import { getCfg, setCfg } from "@/lib/agent/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { repo?: string; message?: string; token?: string };
    const token = body.token || (await getCfg("githubToken"));
    if (!token) return NextResponse.json({ error: "No GitHub PAT configured (Settings → GitHub)." }, { status: 400 });
    const repo = (body.repo || (await getCfg("githubRepo")) || "").trim();
    if (!repo) return NextResponse.json({ error: "repo required (owner/repo or URL)" }, { status: 400 });
    const r = await pushProjectToGitHub(token, repo, body.message || `J+ROCK sync ${new Date().toISOString().slice(0, 16)}`);
    await setCfg("githubRepo", repo);
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
