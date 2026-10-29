import { db } from "@/db";
import { ensureReady } from "@/db/ensure";

export const dynamic = "force-dynamic";

const KEY = "activity-rules";

/** GET /api/rules — the persisted rule-set (defaults when never saved) */
export async function GET() {
  await ensureReady();
  try {
    const row = await db.setting.findUnique({ where: { id: KEY } });
    if (!row) return Response.json({ ok: true, rules: null });
    return Response.json({ ok: true, rules: JSON.parse(row.value) });
  } catch {
    return Response.json({ ok: false, rules: null });
  }
}

/** PUT /api/rules — save the whole rule-set (client + AI harness both write here) */
export async function PUT(req: Request) {
  await ensureReady();
  try {
    const body = (await req.json()) as { rules?: unknown };
    if (!body?.rules || typeof body.rules !== "object") return Response.json({ error: "rules object required" }, { status: 400 });
    const value = JSON.stringify(body.rules);
    await db.setting.upsert({ where: { id: KEY }, create: { id: KEY, value }, update: { value } });
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "save failed" }, { status: 500 });
  }
}
