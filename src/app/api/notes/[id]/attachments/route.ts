import { db } from "@/db";
import { ensureReady } from "@/db/ensure";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/notes/[id]/attachments — list attachments (metadata only, no bytes) */
export async function GET(_req: Request, ctx: Ctx) {
  await ensureReady();
  const { id } = await ctx.params;
  const rows = await db.attachment.findMany({
    where: { noteId: id },
    orderBy: { createdAt: "asc" },
    select: { id: true, noteId: true, name: true, mime: true, size: true, createdAt: true },
  });
  return Response.json(rows);
}

/** POST /api/notes/[id]/attachments — attach a file (JSON {name, mime, size, dataB64}) */
export async function POST(req: Request, ctx: Ctx) {
  await ensureReady();
  const { id } = await ctx.params;
  const b = (await req.json()) as { name?: string; mime?: string; size?: number; dataB64?: string };
  if (!b.name || typeof b.dataB64 !== "string") return Response.json({ error: "name and dataB64 required" }, { status: 400 });
  if (b.dataB64.length > 12_000_000) return Response.json({ error: "file too large (max ~8MB)" }, { status: 413 });
  const note = await db.note.findUnique({ where: { id }, select: { id: true } });
  if (!note) return Response.json({ error: "note not found" }, { status: 404 });
  const att = await db.attachment.create({
    data: {
      id: `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      noteId: id,
      name: b.name.slice(0, 180),
      mime: (b.mime || "application/octet-stream").slice(0, 120),
      size: Math.max(0, Math.round(b.size ?? 0)),
      data: b.dataB64,
    },
    select: { id: true, noteId: true, name: true, mime: true, size: true, createdAt: true },
  });
  return Response.json(att, { status: 201 });
}
