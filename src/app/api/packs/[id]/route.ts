import { db } from "@/db";
import { ensureReady } from "@/db/ensure";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureReady();
  const { id } = await params;
  if (!/^[\w:-]{3,60}$/.test(id)) return Response.json({ error: "bad id" }, { status: 400 });
  await db.setting.deleteMany({ where: { id: `pack:${id}` } });
  return Response.json({ ok: true });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureReady();
  const { id } = await params;
  if (!/^[\w:-]{3,60}$/.test(id)) return Response.json({ error: "bad id" }, { status: 400 });
  const row = await db.setting.findUnique({ where: { id: `pack:${id}` } });
  if (!row) return Response.json({ error: "not found" }, { status: 404 });
  try {
    return Response.json(JSON.parse(row.value));
  } catch {
    return Response.json({ error: "corrupt" }, { status: 500 });
  }
}
