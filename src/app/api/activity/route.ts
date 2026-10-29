import { db } from "@/db";
import { ensureReady } from "@/db/ensure";

export const dynamic = "force-dynamic";

export type AppUseRow = { app: string; cat: string; day: string; secs: number; src: string };

function dayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** GET /api/activity?days=7 → merged per-app-per-day buckets (all sources combined) */
export async function GET(req: Request) {
  await ensureReady();
  const url = new URL(req.url);
  const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days") ?? 7)));
  const cutoff = new Date(Date.now() - (days - 1) * 86_400_000);
  const rows = await db.appUse.findMany({ where: { day: { gte: dayKey(cutoff) } } });
  // merge (app, day) across sources
  const merged = new Map<string, AppUseRow>();
  for (const r of rows) {
    const key = `${r.app}|${r.day}`;
    const hit = merged.get(key);
    if (hit) hit.secs += r.secs;
    else merged.set(key, { app: r.app, cat: r.cat, day: r.day, secs: r.secs, src: r.src });
  }
  return Response.json([...merged.values()]);
}

/** POST /api/activity — ingest usage: { entries: [{app, secs, day?, cat?, src?}] } upsert-increments secs */
export async function POST(req: Request) {
  await ensureReady();
  const b = (await req.json()) as {
    entries?: { app?: string; secs?: number; day?: string; cat?: string; src?: string }[];
  };
  const entries = (Array.isArray(b.entries) ? b.entries : []).slice(0, 60);
  let saved = 0;
  for (const e of entries) {
    const app = String(e.app ?? "").trim().slice(0, 40);
    const secs = Math.round(Number(e.secs ?? 0));
    if (!app || !Number.isFinite(secs) || secs === 0) continue;
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(e.day ?? "")) ? String(e.day) : dayKey();
    const cat = e.cat === "productive" || e.cat === "distraction" ? e.cat : "neutral";
    const src = e.src === "manual" || e.src === "agent" || e.src === "web" ? e.src : "web";
    const id = `${src}:${app}:${day}`;
    try {
      await db.appUse.upsert({
        where: { id },
        create: { id, app, day, cat, src, secs: Math.min(secs, 86_400) },
        update: { secs: { increment: Math.min(secs, 86_400) }, cat },
      });
      saved++;
    } catch {
      /* ignore one bad entry */
    }
  }
  return Response.json({ ok: true, saved });
}

/** PATCH — re-categorize an app across all rows */
export async function PATCH(req: Request) {
  await ensureReady();
  const b = (await req.json()) as { app?: string; cat?: string };
  const app = String(b.app ?? "").trim();
  if (!app || (b.cat !== "productive" && b.cat !== "neutral" && b.cat !== "distraction"))
    return Response.json({ error: "app + cat required" }, { status: 400 });
  await db.appUse.updateMany({ where: { app }, data: { cat: b.cat } });
  return Response.json({ ok: true });
}
