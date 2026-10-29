import { db } from "@/db";
import { ensureReady } from "@/db/ensure";

export const dynamic = "force-dynamic";

/** POST /api/pet-registry/folders — create a new pet-library folder */
export async function POST(req: Request) {
  await ensureReady();
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const name = String(b.name ?? "").trim().slice(0, 24) || "new folder";
  const dup = await db.petFolder.findFirst({ where: { name: { equals: name } } });
  if (dup) return Response.json({ id: dup.id, name: dup.name, position: dup.position });
  const max = await db.petFolder.aggregate({ _max: { position: true } });
  const row = await db.petFolder.create({ data: { id: crypto.randomUUID(), name, position: (max._max.position ?? -1) + 1 } });
  return Response.json({ id: row.id, name: row.name, position: row.position });
}
