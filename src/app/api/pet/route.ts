import { db } from "@/db";
import { ensureReady } from "@/db/ensure";
import { serializePet } from "@/db/serialize";
import { SPECIES_IDS } from "@/db/serialize";

export const dynamic = "force-dynamic";

const n = (v: unknown, a: number, b: number, d: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(Math.min(b, Math.max(a, v))) : d;

export async function GET() {
  await ensureReady();
  const row = await db.pet.findFirst();
  return Response.json(row ? serializePet(row) : null);
}

export async function PUT(req: Request) {
  await ensureReady();
  const b = (await req.json()) as Record<string, unknown>;
  const row = await db.pet.findFirst();
  if (!row) return Response.json({ ok: false }, { status: 404 });
  const species = (SPECIES_IDS as readonly string[]).includes(String(b.species)) ? String(b.species) : row.species;
  try {
    await db.pet.update({
      where: { id: row.id },
      data: {
        name: typeof b.name === "string" ? b.name.trim().slice(0, 16) || row.name : row.name,
        species,
        food: n(b.food, 0, 100, row.food),
        energy: n(b.energy, 0, 100, row.energy),
        joy: n(b.joy, 0, 100, row.joy),
        xp: n(b.xp, 0, 10_000_000, row.xp),
        coins: n(b.coins, 0, 10_000_000, row.coins),
        hat: typeof b.hat === "string" ? b.hat.slice(0, 24) : row.hat,
        owned: Array.isArray(b.owned) ? JSON.stringify((b.owned as unknown[]).filter((x) => typeof x === "string").slice(0, 60)) : row.owned,
        tricks: Array.isArray(b.tricks) ? JSON.stringify((b.tricks as unknown[]).filter((x) => typeof x === "string").slice(0, 20)) : row.tricks,
        stats: b.stats && typeof b.stats === "object" ? JSON.stringify(b.stats) : row.stats,
        look: b.look && typeof b.look === "object" ? JSON.stringify(b.look) : row.look,
        tickAt: new Date(),
      },
    });
  } catch {}
  return Response.json({ ok: true });
}
