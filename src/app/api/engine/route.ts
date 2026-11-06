import { NextRequest, NextResponse } from "next/server";
import { tick, getFullStatus, executeEngineCommand } from "@/lib/trading/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const status = await getFullStatus();
    return NextResponse.json(status);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { text?: string; tick?: boolean };
    if (body.tick) {
      await tick();
      const status = await getFullStatus();
      return NextResponse.json(status);
    }
    if (body.text) {
      const res = await executeEngineCommand(body.text);
      if (!res.handled) return NextResponse.json({ handled: false, reply: "Not an engine command." }, { status: 200 });
      // commands flow straight back into the tick loop so effects are immediate
      if (/start trading|engine on|scan now|close position/i.test(body.text)) tick().catch(() => undefined);
      return NextResponse.json(res);
    }
    return NextResponse.json({ error: "text or tick required" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
