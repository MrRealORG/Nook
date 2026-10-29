import { db } from "@/db";
import { ensureReady } from "@/db/ensure";

export const dynamic = "force-dynamic";

/** GET /api/bugs — newest first, 60 max */
export async function GET() {
  await ensureReady();
  const rows = await db.bug.findMany({ orderBy: { createdAt: "desc" }, take: 60 });
  return Response.json(rows);
}

/** POST /api/bugs — file a report from the in-app reporter (or the AI harness) */
export async function POST(req: Request) {
  await ensureReady();
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const desc = String(b.desc ?? "").trim().slice(0, 2000);
  if (!desc) return Response.json({ ok: false, error: "desc required" }, { status: 400 });
  const severity = ["minor", "normal", "blocker"].includes(String(b.severity)) ? String(b.severity) : "normal";
  const id = typeof b.id === "string" && b.id ? b.id.slice(0, 40) : crypto.randomUUID();
  try {
    const row = await db.bug.create({
      data: {
        id,
        desc,
        severity,
        page: String(b.page ?? "").slice(0, 200),
        ua: String(b.ua ?? "").slice(0, 400),
        logs: String(b.logs ?? "").slice(0, 40_000),
        screenshot: String(b.screenshot ?? "").slice(0, 1_600_000), // base64 jpeg (~1.2MB decoded)
        status: "open",
      },
    });
    return Response.json(row);
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
