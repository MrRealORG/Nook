import { db } from "@/db";
import { ensureReady } from "@/db/ensure";

export const dynamic = "force-dynamic";

/** PATCH /api/pet-registry/[id] — rename, recolor, or move a blueprint; also folder renames via ?type=folder */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureReady();
  const { id } = await params;
  const url = new URL(req.url);
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    if (url.searchParams.get("type") === "folder") {
      const row = await db.petFolder.update({ where: { id }, data: { name: String(b.name ?? "").trim().slice(0, 24) || "folder" } });
      return Response.json({ id: row.id, name: row.name });
    }
    const data: Record<string, unknown> = {};
    if (typeof b.name === "string" && b.name.trim()) data.name = b.name.trim().slice(0, 24);
    if (typeof b.folderId === "string" || b.folderId === null) data.folderId = b.folderId || null;
    if (b.look && typeof b.look === "object") data.look = JSON.stringify(b.look);
    const row = await db.petBlueprint.update({ where: { id }, data });
    let look: Record<string, unknown> = {};
    try { look = JSON.parse(row.look ?? "{}") as Record<string, unknown>; } catch {}
    return Response.json({ id: row.id, folderId: row.folderId, name: row.name, species: row.species, look, origin: row.origin, updatedAt: row.updatedAt.getTime() });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 400 });
  }
}

/** DELETE /api/pet-registry/[id] — remove a blueprint (?type=folder removes an empty folder) */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureReady();
  const { id } = await params;
  const url = new URL(req.url);
  try {
    if (url.searchParams.get("type") === "folder") {
      const inUse = await db.petBlueprint.count({ where: { folderId: id } });
      if (inUse > 0) return Response.json({ ok: false, error: `${inUse} pet(s) still in this folder` }, { status: 409 });
      await db.petFolder.delete({ where: { id } });
    } else {
      await db.petBlueprint.delete({ where: { id } });
    }
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 400 });
  }
}
