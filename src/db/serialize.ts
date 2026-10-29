import type { Canvas, CanvasData, ListingKind, Note, Pet, PetLook, PetStats, Species } from "@/lib/types";

export const SPECIES_IDS = ["cat", "bunny", "blob", "dog", "fox", "panda", "frog", "penguin", "ghost", "dragon", "axolotl", "owl"] as const;

function parseTags(raw: string | null | undefined): string[] {
  try {
    const arr = JSON.parse(raw ?? "[]");
    return Array.isArray(arr) ? arr.filter((t) => typeof t === "string").slice(0, 12) : [];
  } catch {
    return [];
  }
}

export function serializeNote(r: {
  id: string; title: string; content: string; cover: string | null; pinned: boolean; folderId: string | null; tags?: string | null; createdAt: Date; updatedAt: Date;
}): Note {
  return {
    id: r.id,
    title: r.title,
    content: r.content,
    cover: r.cover,
    pinned: r.pinned,
    folderId: r.folderId ?? null,
    tags: parseTags(r.tags),
    createdAt: r.createdAt.getTime(),
    updatedAt: r.updatedAt.getTime(),
  };
}

export function serializeCanvas(r: { id: string; name: string; data: string; updatedAt: Date }): Canvas {
  let d: Partial<CanvasData> = {};
  try {
    d = JSON.parse(r.data ?? "{}") as Partial<CanvasData>;
  } catch {}
  return {
    id: r.id,
    name: r.name,
    updatedAt: r.updatedAt.getTime(),
    data: {
      nodes: Array.isArray(d.nodes) ? d.nodes : [],
      edges: Array.isArray(d.edges) ? d.edges : [],
      view: d.view ?? { x: 0, y: 0, z: 1 },
    },
  };
}

const DEFAULT_STATS: PetStats = { words: 0, fed: 0, pats: 0, games: 0, focus: 0, best: 0, sold: 0, earned: 0, sales: 0, tricks: 0 };

export function serializePet(r: {
  id: string; name: string; species: string; food: number; energy: number; joy: number; xp: number; coins: number; hat: string; owned: string; tricks: string; stats: string; look: string; tickAt: Date;
} | null | undefined): Pet {
  if (!r) {
    return { id: "pet-1", name: "Mochi", species: "cat", food: 80, energy: 90, joy: 70, xp: 0, coins: 120, hat: "none", owned: ["none"], tricks: ["wave", "spin"], stats: { ...DEFAULT_STATS }, look: {}, tickAt: Date.now() };
  }
  let owned: string[] = ["none"];
  try {
    const o = JSON.parse(r.owned ?? "[]");
    if (Array.isArray(o)) owned = o.filter((x) => typeof x === "string");
  } catch {}
  let tricks: string[] = ["wave", "spin"];
  try {
    const t = JSON.parse(r.tricks ?? "[]");
    if (Array.isArray(t)) tricks = t.filter((x) => typeof x === "string");
  } catch {}
  if (!tricks.includes("wave")) tricks.unshift("wave");
  if (!tricks.includes("spin")) tricks.push("spin");
  let stats: Partial<PetStats> = {};
  try {
    stats = JSON.parse(r.stats ?? "{}") as Partial<PetStats>;
  } catch {}
  let look: PetLook = {};
  try {
    const l = JSON.parse(r.look ?? "{}") as PetLook;
    if (Array.isArray(l.ramp)) look.ramp = l.ramp.filter((x) => typeof x === "string").slice(0, 5);
    if (typeof l.accent === "string") look.accent = l.accent;
  } catch {}
  return {
    id: r.id,
    name: r.name,
    species: (SPECIES_IDS as readonly string[]).includes(r.species) ? (r.species as Species) : "cat",
    food: r.food,
    energy: r.energy,
    joy: r.joy,
    xp: r.xp,
    coins: r.coins,
    hat: r.hat,
    owned,
    tricks,
    stats: { ...DEFAULT_STATS, ...stats },
    look,
    tickAt: r.tickAt.getTime(),
  };
}

export function serializeListing(r: {
  id: string; kind: string; itemId: string; name: string; blurb: string; price: number; seller: string; payload: string; sold: boolean; createdAt: Date; updatedAt: Date;
}) {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(r.payload ?? "{}") as Record<string, unknown>;
  } catch {}
  return {
    id: r.id,
    kind: r.kind as ListingKind,
    itemId: r.itemId,
    name: r.name,
    blurb: r.blurb,
    price: r.price,
    seller: r.seller,
    payload,
    sold: r.sold,
    createdAt: r.createdAt.getTime(),
  };
}
