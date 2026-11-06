import { NextRequest, NextResponse } from "next/server";
import { handleUserMessage, listSessions, sessionMessages, deleteSession } from "@/lib/agent/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { sessionId?: string | null; message?: string };
    const message = (body.message ?? "").trim();
    if (!message) return NextResponse.json({ error: "message required" }, { status: 400 });
    const out = await handleUserMessage(body.sessionId ?? null, message.slice(0, 20000));
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const sessionId = req.nextUrl.searchParams.get("sessionId");
    const sessions = await listSessions();
    if (!sessionId) return NextResponse.json({ sessions, messages: [] });
    const msgs = await sessionMessages(sessionId);
    return NextResponse.json({ sessions, messages: msgs });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId");
  if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  await deleteSession(sessionId);
  return NextResponse.json({ ok: true });
}
