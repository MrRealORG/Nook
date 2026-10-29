import { db } from "@/db";
import { ensureReady } from "@/db/ensure";
import { SPECIES_IDS } from "@/db/serialize";

export const dynamic = "force-dynamic";

/** built-in folders + one signature blueprint each — seeded once, then fully user-editable */
const BUILTIN_LOOKS: Record<string, { ramp?: string[]; accent: string; blurb: string }> = {
  cat: { accent: "#9db7d0", blurb: "The original. Curious, aloof, secretly clingy." },
  bunny: { ramp: ["#12100e", "#4a4038", "#8a7a6c", "#cbbfb2", "#f6f0e7"], accent: "#d8a8b8", blurb: "Bouncy, gentle, always listening." },
  blob: { ramp: ["#0c1110", "#2e4a42", "#5f8577", "#9dc0ae", "#e8f5ec"], accent: "#8fd6c0", blurb: "Squishy, glossy, eats pure ideas." },
  dog: { ramp: ["#14100c", "#54402c", "#8a6c48", "#c0a074", "#f3e6d0"], accent: "#c98f5a", blurb: "Loyal, loud, proud of you." },
  fox: { ramp: ["#160e08", "#5c3018", "#a05a28", "#d09048", "#f8e8d8"], accent: "#e8853c", blurb: "Clever, swift, collects shiny ideas." },
  panda: { ramp: ["#0f0f10", "#3c3c40", "#787886", "#b8b8c4", "#f4f4f6"], accent: "#8a9aac", blurb: "Chill, snacky, rarely in a hurry." },
  frog: { ramp: ["#0c1208", "#34502a", "#6a8a4c", "#a8c484", "#eef8dc"], accent: "#86c46a", blurb: "Hoppy, damp, surprisingly wise." },
  penguin: { ramp: ["#0c0e14", "#33394a", "#626c86", "#a2acc4", "#f0f4fa"], accent: "#e8a844", blurb: "Dapper, waddly, always formal." },
  ghost: { ramp: ["#0e0c14", "#3c3a52", "#74729a", "#b2b0d4", "#f2f0fc"], accent: "#a8a0e8", blurb: "Spooky, soft, haunted by drafts." },
  dragon: { ramp: ["#100a10", "#4a2440", "#844868", "#c0889c", "#f8e8ec"], accent: "#e05878", blurb: "Tiny, fierce, hoards coins." },
  axolotl: { ramp: ["#140c12", "#583a52", "#98708c", "#d0a8c4", "#fbeef8"], accent: "#f088b0", blurb: "Perma-smile, aquatic, regenerates." },
  owl: { ramp: ["#120e0a", "#4a3c2c", "#84705a", "#c0ac90", "#f5efe4"], accent: "#d8a050", blurb: "Wise, nocturnal, cites sources." },
};

let seeding: Promise<void> | null = null;

async function seedBuiltins() {
  const count = await db.petFolder.count();
  if (count > 0) return;
  let pos = 0;
  for (const sp of SPECIES_IDS) {
    const folder = await db.petFolder.create({ data: { id: `pf-${sp}`, name: sp, position: pos++ } });
    const look = BUILTIN_LOOKS[sp] ?? { accent: "#9db7d0", blurb: "A friend." };
    const name = sp === "dog" ? "Biscuit" : sp === "cat" ? "Mochi" : sp.charAt(0).toUpperCase() + sp.slice(1);
    await db.petBlueprint.create({
      data: {
        id: `pb-${sp}`,
        folderId: folder.id,
        name,
        species: sp,
        look: JSON.stringify({ ramp: look.ramp, accent: look.accent, blurb: look.blurb }),
        origin: "builtin",
      },
    });
  }
}

function ensureSeed() {
  if (!seeding) seeding = seedBuiltins().catch((e) => { seeding = null; throw e; });
  return seeding;
}

export async function GET() {
  await ensureReady();
  await ensureSeed();
  const [folders, blueprints] = await Promise.all([
    db.petFolder.findMany({ orderBy: { position: "asc" } }),
    db.petBlueprint.findMany({ orderBy: { updatedAt: "desc" } }),
  ]);
  return Response.json({
    folders: folders.map((f) => ({ id: f.id, name: f.name, position: f.position })),
    blueprints: blueprints.map((b) => {
      let look: Record<string, unknown> = {};
      try { look = JSON.parse(b.look ?? "{}") as Record<string, unknown>; } catch {}
      return { id: b.id, folderId: b.folderId, name: b.name, species: b.species, look, origin: b.origin, updatedAt: b.updatedAt.getTime() };
    }),
  });
}

function cleanLook(l: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (Array.isArray(l.ramp)) out.ramp = l.ramp.filter((x) => typeof x === "string" && /^#[0-9a-fA-F]{3,8}$/.test(x)).slice(0, 5);
  if (typeof l.accent === "string" && /^#[0-9a-fA-F]{3,8}$/.test(l.accent)) out.accent = l.accent;
  if (Array.isArray(l.says)) out.says = l.says.filter((x) => typeof x === "string").slice(0, 12);
  if (typeof l.blurb === "string") out.blurb = l.blurb.slice(0, 200);
  return out;
}

/** POST /api/pet-registry — save a new (or update, when id is sent) pet blueprint */
export async function POST(req: Request) {
  await ensureReady();
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const name = String(b.name ?? "").trim().slice(0, 24) || "New pet";
  const species = (SPECIES_IDS as readonly string[]).includes(String(b.species)) ? String(b.species) : "cat";
  const look = b.look && typeof b.look === "object" ? JSON.stringify(cleanLook(b.look as Record<string, unknown>)) : "{}";
  const folderId = typeof b.folderId === "string" && b.folderId ? b.folderId : null;
  const origin = ["builtin", "custom", "imported"].includes(String(b.origin)) ? String(b.origin) : "custom";
  try {
    const row = typeof b.id === "string" && b.id
      ? await db.petBlueprint.update({ where: { id: b.id }, data: { name, species, look, folderId, origin } })
      : await db.petBlueprint.create({ data: { id: crypto.randomUUID(), name, species, look, folderId, origin } });
    return Response.json({ id: row.id, folderId: row.folderId, name: row.name, species: row.species, look: JSON.parse(row.look ?? "{}"), origin: row.origin, updatedAt: row.updatedAt.getTime() });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 400 });
  }
}
