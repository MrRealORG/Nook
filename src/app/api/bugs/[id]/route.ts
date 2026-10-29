import { db } from "@/db";
import { ensureReady } from "@/db/ensure";

export const dynamic = "force-dynamic";

/** PATCH /api/bugs/:id — move a report through open → fixing → fixed */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureReady();
  const { id } = await params;
  const b = (await req.json().catch(() => ({}))) as { status?: string };
  const status = ["open", "fixing", "fixed"].includes(String(b.status)) ? String(b.status) : null;
  if (!status) return Response.json({ ok: false }, { status: 400 });
  try {
    await db.bug.update({ where: { id }, data: { status } });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 404 });
  }
}

/** DELETE /api/bugs/:id */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureReady();
  const { id } = await params;
  try {
    await db.bug.delete({ where: { id } });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 404 });
  }
}
