import { db } from "@/db";
import { ensureReady } from "@/db/ensure";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  await ensureReady();
  const { id } = await ctx.params;
  const b = (await req.json()) as { name?: string; data?: unknown };
  const patch: { name?: string; data?: string; updatedAt: Date } = { updatedAt: new Date() };
  if (typeof b.name === "string") patch.name = b.name.slice(0, 120);
  if (b.data && typeof b.data === "object") patch.data = JSON.stringify(b.data);
  try {
    await db.canvas.update({ where: { id }, data: patch });
  } catch {}
  return Response.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  await ensureReady();
  const { id } = await ctx.params;
  try {
    await db.canvas.delete({ where: { id } });
  } catch {}
  return Response.json({ ok: true });
}
