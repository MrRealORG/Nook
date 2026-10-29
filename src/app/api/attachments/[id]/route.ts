import { db } from "@/db";
import { ensureReady } from "@/db/ensure";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/attachments/[id] — download the raw file bytes */
export async function GET(_req: Request, ctx: Ctx) {
  await ensureReady();
  const { id } = await ctx.params;
  const att = await db.attachment.findUnique({ where: { id } });
  if (!att) return new Response("Not found", { status: 404 });
  const bytes = Buffer.from(att.data, "base64");
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": att.mime || "application/octet-stream",
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(att.name)}`,
      "cache-control": "private, max-age=86400",
    },
  });
}

/** DELETE /api/attachments/[id] */
export async function DELETE(_req: Request, ctx: Ctx) {
  await ensureReady();
  const { id } = await ctx.params;
  try {
    await db.attachment.delete({ where: { id } });
  } catch {}
  return Response.json({ ok: true });
}
