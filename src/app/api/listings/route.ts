import { db } from "@/db";
import { ensureReady } from "@/db/ensure";
import { serializeListing } from "@/db/serialize";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureReady();
  const rows = await db.listing.findMany({ orderBy: { createdAt: "desc" } });
  const events = await db.listingEvent.findMany({ orderBy: { createdAt: "asc" } });
  const byListing = new Map<string, { p: number; k: string; at: number }[]>();
  for (const e of events) {
    const arr = byListing.get(e.listingId) ?? [];
    arr.push({ p: e.price, k: e.kind, at: e.createdAt.getTime() });
    byListing.set(e.listingId, arr);
  }
  return Response.json(rows.map((r) => ({ ...serializeListing(r), history: byListing.get(r.id) ?? [] })));
}

export async function POST(req: Request) {
  await ensureReady();
  const b = (await req.json()) as {
    id?: string; kind?: string; itemId?: string; name?: string; blurb?: string; price?: number; seller?: string; payload?: Record<string, unknown>;
  };
  const id = b.id && /^[\w-]{3,40}$/.test(b.id) ? b.id : crypto.randomUUID();
  const price = Math.max(1, Math.min(9999, Math.round(Number(b.price) || 1)));
  try {
    const row = await db.listing.create({
      data: {
        id,
        kind: (b.kind ?? "hat").slice(0, 16),
        itemId: (b.itemId ?? "").slice(0, 40),
        name: (b.name ?? "Item").slice(0, 80),
        blurb: (b.blurb ?? "").slice(0, 160),
        price,
        seller: (b.seller ?? "Trader").slice(0, 24),
        payload: JSON.stringify(b.payload ?? {}),
      },
    });
    // open the price timeline with the list event
    await db.listingEvent.create({ data: { id: crypto.randomUUID(), listingId: id, price, kind: "list" } });
    return Response.json(serializeListing(row));
  } catch {
    return Response.json({ id }, { status: 400 });
  }
}
