import { db } from "@/db";
import { ensureReady } from "@/db/ensure";
import { serializeListing } from "@/db/serialize";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(_req: Request, ctx: Ctx) {
  await ensureReady();
  const { id } = await ctx.params;
  try {
    await db.listing.delete({ where: { id } });
  } catch {}
  return Response.json({ ok: true });
}

/** Purchase a listing: transfers coins from pet to a ledger record and marks sold. */
export async function POST(req: Request, ctx: Ctx) {
  await ensureReady();
  const { id } = await ctx.params;
  const b = (await req.json().catch(() => ({}))) as { action?: string; buyer?: string; price?: number };
  const listing = await db.listing.findUnique({ where: { id } });
  if (!listing) return Response.json({ ok: false, error: "Listing not found" }, { status: 404 });
  if (listing.sold) return Response.json({ ok: false, error: "Already sold" }, { status: 409 });

  const pet = await db.pet.findFirst();
  if (!pet) return Response.json({ ok: false, error: "No pet" }, { status: 404 });

  if (b.action === "buy") {
    if (pet.coins < listing.price) return Response.json({ ok: false, error: "Not enough coins" }, { status: 402 });
    // reclaiming your own listing pays the seller back 80% (20% market fee)
    const isMine = listing.seller === pet.name;
    const earned = isMine ? Math.round(listing.price * 0.8) : 0;
    const ops = [
      db.pet.update({ where: { id: pet.id }, data: { coins: { decrement: listing.price } } }),
      db.listing.update({ where: { id }, data: { sold: true } }),
    ];
    if (earned > 0) ops.push(db.pet.update({ where: { id: pet.id }, data: { coins: { increment: earned } } }));
    await db.$transaction(ops);
    // close the price timeline with the sale
    await db.listingEvent.create({ data: { id: crypto.randomUUID(), listingId: id, price: listing.price, kind: "sold" } });
    return Response.json({ ok: true, action: "buy", listing: serializeListing({ ...listing, sold: true }), earned });
  }

  if (b.action === "botbuy") {
    // Nook Bot goes shopping: pays full price, seller earns 90%.
    // Only the local pet's own listings pay out — seeded/teammade stalls earn nothing.
    const isLocalSeller = listing.seller === pet.name;
    const earned = isLocalSeller ? Math.round(listing.price * 0.9) : 0;
    await db.$transaction([
      db.listing.update({ where: { id }, data: { sold: true } }),
      ...(earned > 0 ? [db.pet.update({ where: { id: pet.id }, data: { coins: { increment: earned } } })] : []),
    ]);
    await db.listingEvent.create({ data: { id: crypto.randomUUID(), listingId: id, price: listing.price, kind: "sold" } });
    return Response.json({
      ok: true,
      action: "botbuy",
      listing: serializeListing({ ...listing, sold: true }),
      earned,
      buyer: String(b.buyer ?? "Nook Bot").slice(0, 24),
    });
  }

  if (b.action === "reprice") {
    // seller sweetens the deal: change the price of your own unsold listing
    if (listing.sold) return Response.json({ ok: false, error: "Already sold" }, { status: 409 });
    if (listing.seller !== pet.name) return Response.json({ ok: false, error: "Not your booth" }, { status: 403 });
    const price = Math.max(1, Math.min(9999, Math.round(Number(b.price) || listing.price)));
    if (price === listing.price) return Response.json({ ok: true, action: "reprice", listing: serializeListing(listing), price });
    const updated = await db.listing.update({ where: { id }, data: { price } });
    await db.listingEvent.create({ data: { id: crypto.randomUUID(), listingId: id, price, kind: "reprice" } });
    return Response.json({ ok: true, action: "reprice", listing: serializeListing(updated), price });
  }

  if (b.action === "sell") {
    // Seller lists an item — nothing else required; listing already exists.
    return Response.json({ ok: true, action: "sell", listing: serializeListing(listing) });
  }

  return Response.json({ ok: false, error: "Unknown action" }, { status: 400 });
}
