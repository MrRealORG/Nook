import { db } from "@/db";
import { ensureReady } from "@/db/ensure";

export const dynamic = "force-dynamic";

/** Custom packs (icon/font/wallpaper) live in the Setting key/value store as rows "pack:<id>". */
export async function GET() {
  await ensureReady();
  const rows = await db.setting.findMany({ where: { id: { startsWith: "pack:" } } });
  const packs = rows
    .map((r) => {
      try {
        return JSON.parse(r.value) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((p): p is Record<string, unknown> => !!p && typeof p.id === "string" && typeof p.kind === "string")
    .sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0));
  return Response.json(packs);
}

export async function POST(req: Request) {
  await ensureReady();
  const b = (await req.json()) as { id?: string; kind?: string; name?: string };
  if (!b.id || !/^[\w:-]{3,60}$/.test(b.id)) return Response.json({ error: "id required" }, { status: 400 });
  if (!["icons", "fonts", "wallpapers"].includes(b.kind ?? "")) return Response.json({ error: "bad kind" }, { status: 400 });
  if (JSON.stringify(b).length > 12_000_000) return Response.json({ error: "pack too large (12MB cap)" }, { status: 413 });
  await db.setting.upsert({
    where: { id: `pack:${b.id}` },
    update: { value: JSON.stringify(b), updatedAt: new Date() },
    create: { id: `pack:${b.id}`, value: JSON.stringify(b) },
  });
  return Response.json({ ok: true });
}
