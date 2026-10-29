import { db } from "@/db";
import { ensureReady } from "@/db/ensure";
import { serializeCanvas, serializeListing, serializeNote, serializePet } from "@/db/serialize";
import type { ListingPricePoint } from "@/lib/types";
import { App } from "@/components/App";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  await ensureReady();
  const [n, c, p, f, l, ev] = await Promise.all([
    db.note.findMany({ orderBy: { updatedAt: "desc" } }),
    db.canvas.findMany({ orderBy: { createdAt: "asc" } }),
    db.pet.findFirst(),
    db.folder.findMany({ orderBy: { position: "asc" } }),
    db.listing.findMany({ orderBy: { createdAt: "desc" } }),
    db.listingEvent.findMany({ orderBy: { createdAt: "asc" } }),
  ]);
  const historyById = new Map<string, ListingPricePoint[]>();
  for (const e of ev) {
    const arr = historyById.get(e.listingId) ?? [];
    arr.push({ p: e.price, k: e.kind as ListingPricePoint["k"], at: e.createdAt.getTime() });
    historyById.set(e.listingId, arr);
  }
  return (
    <App
      initial={{
        notes: n.map(serializeNote),
        canvases: c.map(serializeCanvas),
        pet: serializePet(p),
        folders: f.map((x) => ({ id: x.id, name: x.name, icon: x.icon, color: x.color, position: x.position })),
        listings: l.map((x) => ({ ...serializeListing(x), history: historyById.get(x.id) ?? [] })),
      }}
    />
  );
}
