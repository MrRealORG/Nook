import { db } from "@/db";
import { ensureReady } from "@/db/ensure";

export const dynamic = "force-dynamic";

/** Custom games (nook-games JSON) live in the Setting store under "custom-games". */
export async function GET() {
  await ensureReady();
  const row = await db.setting.findUnique({ where: { id: "custom-games" } });
  try {
    const games = JSON.parse(row?.value ?? "[]");
    return Response.json(Array.isArray(games) ? games : []);
  } catch {
    return Response.json([]);
  }
}

export async function PUT(req: Request) {
  await ensureReady();
  const b = (await req.json()) as { games?: unknown };
  if (!Array.isArray(b.games)) return Response.json({ error: "games array required" }, { status: 400 });
  const payload = JSON.stringify(b.games.slice(0, 60));
  if (payload.length > 2_000_000) return Response.json({ error: "too large" }, { status: 413 });
  await db.setting.upsert({
    where: { id: "custom-games" },
    update: { value: payload, updatedAt: new Date() },
    create: { id: "custom-games", value: payload },
  });
  return Response.json({ ok: true, count: b.games.length });
}

export async function DELETE() {
  await ensureReady();
  await db.setting.deleteMany({ where: { id: "custom-games" } });
  return Response.json({ ok: true });
}
