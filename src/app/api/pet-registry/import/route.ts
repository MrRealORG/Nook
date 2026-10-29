import { db } from "@/db";
import { ensureReady } from "@/db/ensure";
import { SPECIES_IDS } from "@/db/serialize";

export const dynamic = "force-dynamic";

type PackPet = { name?: unknown; species?: unknown; folderName?: unknown; folder?: unknown; look?: unknown; origin?: unknown };
type PackFolder = { name?: unknown; position?: unknown };

/** POST /api/pet-registry/import — bulk import a nook-pets pack (creates folders as needed) */
export async function POST(req: Request) {
  await ensureReady();
  const body = (await req.json().catch(() => ({}))) as { folders?: PackFolder[]; pets?: PackPet[] };
  const pets = Array.isArray(body.pets) ? body.pets.slice(0, 200) : [];
  if (pets.length === 0) return Response.json({ ok: false, error: "no pets in pack" }, { status: 400 });

  // existing folders by name → reuse; otherwise create from the pack (or on demand)
  const existing = await db.petFolder.findMany();
  const byName = new Map(existing.map((f) => [f.name.toLowerCase(), f.id]));
  let maxPos = existing.reduce((a, f) => Math.max(a, f.position), 0);

  const folderIdFor = async (name: string): Promise<string | null> => {
    const key = name.trim().toLowerCase();
    if (!key) return null;
    if (byName.has(key)) return byName.get(key)!;
    const id = crypto.randomUUID();
    await db.petFolder.create({ data: { id, name: name.trim().slice(0, 24), position: ++maxPos } });
    byName.set(key, id);
    return id;
  };

  // pre-create folders listed in the pack so ordering survives
  for (const f of (Array.isArray(body.folders) ? body.folders : []).slice(0, 40)) {
    const name = String(f.name ?? "").trim();
    if (!name) continue;
    await folderIdFor(name);
  }

  let created = 0;
  for (const p of pets) {
    const name = String(p.name ?? "").trim().slice(0, 24) || "Imported pet";
    const species = (SPECIES_IDS as readonly string[]).includes(String(p.species)) ? String(p.species) : "cat";
    const look = p.look && typeof p.look === "object" ? p.look : {};
    const rawFolder = String(p.folderName ?? p.folder ?? "").trim();
    const folderId = rawFolder ? await folderIdFor(rawFolder) : null;
    const origin = "imported";
    await db.petBlueprint.create({ data: { id: crypto.randomUUID(), name, species, look: JSON.stringify(look), folderId, origin } });
    created++;
  }
  return Response.json({ ok: true, created });
}
