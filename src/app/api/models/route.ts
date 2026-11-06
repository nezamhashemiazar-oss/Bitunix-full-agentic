import { NextRequest, NextResponse } from "next/server";
import { autoSetModelByKey } from "@/lib/agent/providers";
import { setCfg } from "@/lib/agent/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* AutoSetModelByKey endpoint: probe a baseUrl+key, find working models,
   pick the best, optionally persist. */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { baseUrl?: string; apiKey?: string; provider?: string; save?: boolean; model?: string };
    const apiKey = body.apiKey ?? "";
    if (!apiKey) return NextResponse.json({ error: "apiKey required" }, { status: 400 });
    const r = await autoSetModelByKey(body.baseUrl ?? "", apiKey, body.provider);
    if (body.save) {
      await setCfg("apiKey", apiKey);
      await setCfg("baseUrl", r.baseUrl);
      await setCfg("provider", r.kind);
      await setCfg("model", body.model && r.models.includes(body.model) ? body.model : r.model);
    }
    return NextResponse.json({
      provider: r.kind,
      baseUrl: r.baseUrl,
      model: body.model && r.models.includes(body.model) ? body.model : r.model,
      models: r.models,
      source: r.source,
      warning: r.warning,
      probe: r.probe,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
