import { db } from "@/db";
import { ensureReady } from "@/db/ensure";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  await ensureReady();
  const { id } = await ctx.params;
  const b = (await req.json()) as { name?: string; icon?: string; color?: string };
  const patch: { name?: string; icon?: string; color?: string } = {};
  if (typeof b.name === "string") patch.name = b.name.slice(0, 80);
  if (typeof b.icon === "string") patch.icon = b.icon.slice(0, 32);
  if (typeof b.color === "string") patch.color = b.color.slice(0, 16);
  try {
    await db.folder.update({ where: { id }, data: patch });
  } catch {}
  return Response.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  await ensureReady();
  const { id } = await ctx.params;
  try {
    await db.note.updateMany({ where: { folderId: id }, data: { folderId: null } });
    await db.folder.delete({ where: { id } });
  } catch {}
  return Response.json({ ok: true });
}
