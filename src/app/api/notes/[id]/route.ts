import { db } from "@/db";
import { ensureReady } from "@/db/ensure";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  await ensureReady();
  const { id } = await ctx.params;
  const b = (await req.json()) as { title?: string; content?: string; cover?: string | null; pinned?: boolean; folderId?: string | null; tags?: string[] };
  const patch: { title?: string; content?: string; cover?: string | null; pinned?: boolean; folderId?: string | null; tags?: string; updatedAt: Date } = { updatedAt: new Date() };
  if (typeof b.title === "string") patch.title = b.title.slice(0, 200);
  if (typeof b.content === "string") patch.content = b.content.slice(0, 400_000);
  if (b.cover === null || typeof b.cover === "string") patch.cover = b.cover;
  if (typeof b.pinned === "boolean") patch.pinned = b.pinned;
  if (b.folderId === null || typeof b.folderId === "string") patch.folderId = b.folderId;
  if (Array.isArray(b.tags)) patch.tags = JSON.stringify(b.tags.filter((t) => typeof t === "string").map((t) => t.slice(0, 24)).slice(0, 12));
  try {
    await db.note.update({ where: { id }, data: patch });
  } catch {}
  return Response.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  await ensureReady();
  const { id } = await ctx.params;
  try {
    await db.note.delete({ where: { id } });
  } catch {}
  return Response.json({ ok: true });
}
