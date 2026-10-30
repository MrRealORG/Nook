
import { useMemo, useRef, useState } from "react";
import { DecorArt } from "@/components/DecorArt";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/icons";
import { PetView } from "@/components/PetView";
import { DECOR, FOODS, HATS, SPECIES } from "@/lib/pet";
import { markSaleSeen } from "@/lib/marketWatch";
import { applyFontPack, savePackToServer, usePackStore, type CustomPack } from "@/lib/packs";
import { useStore } from "@/lib/store";
import { sfx } from "@/lib/sfx";
import { THEMES, PREMIUM_THEMES, type ThemeId } from "@/lib/themes";
import type { CustomGameDef } from "@/lib/gameEngines";
import type { Listing, ListingKind, ListingPricePoint, Pet } from "@/lib/types";
import { timeAgo, uid } from "@/lib/util";

const KIND_META: Record<ListingKind, { label: string; icon: IconName }> = {
  hat: { label: "Hats", icon: "shirt" },
  pet: { label: "Pets", icon: "dog" },
  food: { label: "Food", icon: "fish" },
  theme: { label: "Themes", icon: "sparkle" },
  decor: { label: "Den", icon: "home" },
  iconpack: { label: "Icon packs", icon: "palette" },
  fontpack: { label: "Font packs", icon: "type" },
  wallpaper: { label: "Wallpapers", icon: "image" },
  game: { label: "Games", icon: "gamepad" },
};

function ListingArt({ kind, itemId, payload }: { kind: ListingKind; itemId: string; payload?: Record<string, unknown> }) {
  const payloadPack = payload?.pack as CustomPack | undefined;
  const payloadGame = payload?.game as { engine?: string; accent?: string } | undefined;
  if (kind === "pet") {
    const sp = (SPECIES as Record<string, unknown>)[itemId] ? (itemId as never) : "cat";
    return (
      <div className="grid h-[74px] place-items-end justify-center overflow-hidden rounded-xl border border-line bg-panel2">
        <PetView species={sp} scale={1.6} fps={6} style={{ marginBottom: -4 }} />
      </div>
    );
  }
  if (kind === "decor") {
    return (
      <div className="grid h-[74px] w-full place-items-center rounded-xl border border-line" style={{ background: "color-mix(in srgb, var(--bg) 45%, var(--panel2))" }}>
        <DecorArt id={itemId} />
      </div>
    );
  }
  if (kind === "iconpack" || kind === "fontpack" || kind === "wallpaper") {
    const pack = (payloadPack as CustomPack | undefined) ?? undefined;
    return (
      <div className="grid h-[74px] w-full place-items-center overflow-hidden rounded-xl border border-line" style={{ background: pack?.preview ? `url(${pack.preview}) center / cover` : "color-mix(in srgb, var(--bg) 45%, var(--panel2))" }}>
        {!pack?.preview && <Icon name={kind === "fontpack" ? "type" : kind === "wallpaper" ? "image" : "palette"} size={26} />}
      </div>
    );
  }
  if (kind === "game") {
    const g = payloadGame;
    return (
      <div className="grid h-[74px] w-full place-items-center overflow-hidden rounded-xl border border-line" style={{ background: `color-mix(in srgb, ${g?.accent ?? "#e0a05a"} 22%, var(--panel2))` }}>
        <div className="text-center">
          <Icon name="gamepad" size={22} style={{ color: g?.accent ?? "#e0a05a" }} />
          <div className="tiny-font mt-0.5 text-[9px] uppercase tracking-wider text-faint">{g?.engine ?? "custom"} engine</div>
        </div>
      </div>
    );
  }
  if (kind === "theme") {
    const th = THEMES[itemId as keyof typeof THEMES];
    if (th) {
      return (
        <div className="relative h-[74px] w-full overflow-hidden rounded-xl border border-line">
          <div className="flex h-full w-full">
            {th.ramp.map((c, i) => <i key={i} className="flex-1" style={{ background: c }} />)}
          </div>
          <span className="pixel-font absolute bottom-1.5 left-2 rounded-md bg-black/45 px-1.5 py-0.5 text-[10px] text-white/90">{th.name}</span>
          {th.premium && <span className="rare-chip absolute right-2 top-2">rare</span>}
        </div>
      );
    }
  }
  const icon: IconName = kind === "hat" ? "shirt" : kind === "food" ? (FOODS.find((f) => f.id === itemId)?.icon ?? "fish") : "sparkle";
  return (
    <div className="game-icon mx-auto h-[74px] w-full" style={{ background: "var(--panel2)" }}>
      <Icon name={icon} size={30} />
    </div>
  );
}

function PriceSpark({ history, price, sold }: { history?: ListingPricePoint[]; price: number; sold: boolean }) {
  const pts = history ?? [];
  if (pts.length < 2) {
    // one event so far (just listed) — a whisper of a timeline, or nothing at all
    if (pts.length === 0) return null;
    return <span className="market-spark-hint">price untouched</span>;
  }
  const W = 58, H = 20, PAD = 3;
  const prices = pts.map((p) => p.p);
  const min = Math.min(...prices), max = Math.max(...prices);
  const span = max - min || 1;
  const step = (W - PAD * 2) / (pts.length - 1);
  const xy = pts.map((pt, i) => [PAD + i * step, H - PAD - ((pt.p - min) / span) * (H - PAD * 2)] as const);
  const path = xy.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const last = xy[xy.length - 1];
  const dropped = pts[pts.length - 1].p < pts[0].p;
  const tip = pts.map((pt) => `${pt.k === "list" ? "listed" : pt.k === "reprice" ? "repriced" : "sold"} · ${pt.p}c`).join("\n");
  return (
    <span className="market-spark" data-dropped={dropped} data-sold={sold} title={tip}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden>
        <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" opacity="0.55" />
        {xy.slice(1).map(([x, y], i) => {
          const px = xy[i][0];
          return <line key={i} x1={px} x2={x} y1={xy[i][1]} y2={y} stroke="currentColor" strokeWidth="2.2" opacity="0.25" />;
        })}
        <circle cx={last[0]} cy={last[1]} r="2.6" fill="currentColor" />
      </svg>
      <span className="tiny-font">{sold ? "sold" : dropped ? "dropped" : "timeline"} {price}c</span>
    </span>
  );
}

function ListingCard({ l, i, coins, owned, mine, wished, onBuy, onCancel, onSweeten, onWish }: {
  l: Listing;
  i: number;
  coins: number;
  owned: boolean;
  mine: boolean;
  wished: boolean;
  onBuy: (l: Listing) => void;
  onCancel: (l: Listing) => void;
  onSweeten: (l: Listing) => void;
  onWish: (l: Listing) => void;
}) {
  const afford = coins >= l.price;
  const wishable = !l.sold && !mine;
  return (
    <div className="market-card" data-sold={l.sold} data-mine={mine} data-wish={wished} style={{ ["--i" as string]: Math.min(i, 12) }}>
      <div className="flex items-center gap-2 text-[12px] text-dim">
        <Icon name={KIND_META[l.kind]?.icon ?? "gift"} size={13} />
        <span className="tiny-font uppercase tracking-wider">{KIND_META[l.kind]?.label ?? l.kind}</span>
        {l.kind === "theme" && THEMES[l.itemId as keyof typeof THEMES]?.premium && <span className="rare-chip">rare</span>}
        {mine && <span className="tiny-font ml-auto rounded-md bg-panel2 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-accent">your booth</span>}
        {!mine && <span className="flex-1" />}
        {wishable && (
          <button
            className="wish-btn"
            data-on={wished}
            onClick={() => onWish(l)}
            aria-pressed={wished}
            aria-label={wished ? `Remove ${l.name} from wishlist` : `Add ${l.name} to wishlist`}
            title={wished ? "Remove from wishlist" : "Wishlist — get pinged when the price drops"}
          >
            <Icon name="heart" size={13} />
          </button>
        )}
        <span className="pixel-font">{timeAgo(l.createdAt)}</span>
      </div>
      <ListingArt kind={l.kind} itemId={l.itemId} payload={l.payload} />
      <div>
        <div className="pixel-font truncate text-[15.5px] leading-tight">{l.name}</div>
        <div className="mt-0.5 line-clamp-2 min-h-[2.4em] text-[12px] leading-snug text-dim">{l.blurb || "No description."}</div>
      </div>
      <div className="mt-auto flex items-center justify-between gap-2">
        <span className="price-tag">
          <Icon name="coins" size={14} /> {l.price}
        </span>
        {l.sold ? (
          <span className="chip opacity-70"><Icon name="check" size={11} /> sold</span>
        ) : mine ? (
          <div className="flex items-center gap-1.5">
            <button className="btn btn-sm" onClick={() => onBuy(l)} title="Buy back your own listing — 20% market fee applies">
              <Icon name="undo" size={12} /> reclaim
            </button>
            <button className="icon-btn !h-7 !w-7 !rounded-md" onClick={() => onSweeten(l)} title="Sweeten the deal — cut the price 10% (Nook Bot loves a bargain)">
              <Icon name="label" size={13} />
            </button>
            <button className="icon-btn !h-7 !w-7 !rounded-md" onClick={() => onCancel(l)} title="Take the listing down (item returns to your closet)">
              <Icon name="close" size={13} />
            </button>
          </div>
        ) : (
          <button className="btn btn-accent btn-sm" disabled={!afford} onClick={() => onBuy(l)} title={afford ? "Buy" : "Not enough coins"}>
            {owned ? "own it" : afford ? "Buy" : "too pricey"}
          </button>
        )}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <PriceSpark history={l.history} price={l.price} sold={l.sold} />
        <span className="flex-1" />
        <span className="tiny-font truncate text-[9px] uppercase tracking-wider text-faint">seller · {l.seller}</span>
      </div>
    </div>
  );
}

type Tab = ListingKind | "all" | "booth" | "wish";

export function MarketView() {
  const listings = useStore((s) => s.listings);
  const pet = useStore((s) => s.pet);
  const achievements = useStore((s) => s.achievements);
  const marketFeed = useStore((s) => s.marketFeed);
  const wishlist = useStore((s) => s.wishlist);
  const [tab, setTab] = useState<Tab>("all");
  const [listingOpen, setListingOpen] = useState(false);
  const st = useStore.getState;
  const mySales = useRef(new Set(listings.filter((l) => l.sold).map((l) => l.id)));

  const filtered = useMemo(
    () =>
      tab === "all"
        ? listings
        : tab === "booth"
          ? listings.filter((l) => l.seller === pet.name)
          : tab === "wish"
            ? listings.filter((l) => wishlist[l.id] != null)
            : listings.filter((l) => l.kind === tab),
    [listings, tab, pet.name, wishlist],
  );
  const wishCount = Object.keys(wishlist).length;
  const earned = pet.stats.earned ?? 0;
  const myUnsold = listings.filter((l) => l.seller === pet.name && !l.sold).length;
  const soldToMe = listings.filter((l) => l.seller === pet.name && l.sold).length;

  // NOTE: live sale detection lives in the global market watcher (src/lib/marketWatch.ts)
  // so bot purchases pay out from ANY view and raise the rail badge.

  const buy = async (l: Listing) => {
    const s = st();
    const mine = l.seller === s.pet.name;
    if (!mine && s.pet.coins < l.price) {
      sfx("error");
      s.toast("Not enough coins — write or play more!", "coins");
      return;
    }
    try {
      const r = await fetch(`/api/listings/${l.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "buy" }) });
      const j = (await r.json()) as { ok: boolean; error?: string; earned?: number };
      if (!j.ok) {
        sfx("error");
        s.toast(j.error ?? "Purchase failed", "close");
        return;
      }
      s.questProgress("market");
      markSaleSeen(l.id);
      mySales.current.add(l.id);
      // Apply the purchase locally
      s.patchPet((p) => {
        const owned = p.owned.includes(l.itemId) ? p.owned : [...p.owned, l.itemId];
        const hat = l.kind === "hat" ? l.itemId : p.hat;
        const species = l.kind === "pet" ? (l.itemId as Pet["species"]) : p.species;
        return { ...p, coins: p.coins - l.price + (j.earned ?? 0), owned, hat: owned.includes(hat) ? hat : p.hat, species };
      });
      // bought it — the wish served its purpose
      if (s.wishlist[l.id] != null) {
        const wishlist = { ...s.wishlist };
        delete wishlist[l.id];
        s.set({ wishlist });
      }
      if ((j.earned ?? 0) > 0) {
        s.patchPet((p) => ({ ...p, stats: { ...p.stats, earned: (p.stats.earned ?? 0) + (j.earned ?? 0) } }));
        s.unlock("shopkeeper", "Shopkeeper", "Earned coins from a marketplace sale", "hand");
      }
      s.set({ listings: s.listings.map((x) => (x.id === l.id ? { ...x, sold: true } : x)) });
      sfx("buy");
      s.doAct("happy", 2400);
      s.toast((j.earned ?? 0) > 0 ? `Reclaimed ${l.name} · sold it again for +${j.earned} coins` : `Bought ${l.name}!`, "gift");
      s.pushMarket((j.earned ?? 0) > 0 ? `${l.seller} sold ${l.name} (+${j.earned})` : `you bought ${l.name} (−${l.price})`, "gift", (j.earned ?? 0) > 0 ? "sold" : "bought");
      if (l.kind === "pet") s.say(`A new friend! ${l.name} says hi!`);
      // packs & games install themselves the moment they are bought
      if (l.kind === "iconpack" || l.kind === "fontpack" || l.kind === "wallpaper") {
        const pack = (l.payload as { pack?: CustomPack } | null)?.pack;
        if (pack?.id) {
          await savePackToServer(pack);
          if (l.kind === "fontpack") applyFontPack(pack.id);
          if (l.kind === "wallpaper" && pack.wallpapers?.length) s.setWallpaper({ id: `${pack.id}#0`, img: pack.wallpapers[0].dataURL });
          s.toast(`${pack.name} installed${l.kind === "wallpaper" ? " and applied" : ""}!`, "download");
          s.unlock("pack-collector", "Pack Collector", "Bought a pack from the marketplace", "palette");
        }
      }
      if (l.kind === "game") {
        const game = (l.payload as { game?: CustomGameDef } | null)?.game;
        if (game) {
          await s.addCustomGames([game]);
          s.toast(`${game.title} added to your arcade!`, "gamepad");
        }
      }
      if (l.kind === "theme") {
        // rare themes apply themselves the moment they are bought
        s.setTheme(l.itemId as ThemeId);
        if (PREMIUM_THEMES.every((t) => useStore.getState().pet.owned.includes(t)))
          s.unlock("theme-collector", "Theme Collector", "Owned every rare theme", "sparkle");
      }
      s.unlock("first-buy", "First Purchase", "Bought something from the marketplace", "gift");
      if (!s.achievements.includes("collector") && s.pet.owned.length >= 8) s.unlock("collector", "Collector", "Own 8 items", "crown");
    } catch {
      sfx("error");
      s.toast("The market cart rolled away… try again", "close");
    }
  };

  const cancel = async (l: Listing) => {
    const s = st();
    try {
      await fetch(`/api/listings/${l.id}`, { method: "DELETE" });
      s.set({ listings: s.listings.filter((x) => x.id !== l.id) });
      // physical items (hats / decor) go back to the closet
      if (l.kind === "hat" || l.kind === "decor") {
        s.patchPet((p) => (p.owned.includes(l.itemId) ? p : { ...p, owned: [...p.owned, l.itemId] }));
      }
      sfx("pop");
      s.toast(`Took ${l.name} off the market — back to the closet`, "home");
      s.pushMarket(`${l.seller} took ${l.name} down`, "close", "removed");
    } catch {
      sfx("error");
      s.toast("Could not reach the market stall", "close");
    }
  };

  const sweeten = async (l: Listing) => {
    const s = st();
    // guarantee progress: always at least 1 coin under the current price
    const next = Math.max(1, Math.min(l.price - 1, Math.round(l.price * 0.9)));
    if (next >= l.price) {
      sfx("error");
      s.toast("That price can't go lower", "close");
      return;
    }
    try {
      const r = await fetch(`/api/listings/${l.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "reprice", price: next }),
      });
      const j = (await r.json()) as { ok: boolean; error?: string };
      if (!j.ok) {
        sfx("error");
        s.toast(j.error ?? "Reprice failed", "close");
        return;
      }
      s.set({
        listings: s.listings.map((x) =>
          x.id === l.id ? { ...x, price: next, history: [...(x.history ?? []), { p: next, k: "reprice" as const, at: Date.now() }] } : x,
        ),
      });
      sfx("coin");
      s.toast(`Sweetened ${l.name} — now ${next} coins`, "label");
      s.pushMarket(`${l.seller} sweetened ${l.name} · ${next}c`, "label", "listed");
      s.unlock("negotiator", "Negotiator", "Sweetened a listing's price", "label");
    } catch {
      sfx("error");
      s.toast("Could not reprice the item", "close");
    }
  };

  const listItem = async (kind: ListingKind, itemId: string, name: string, blurb: string, price: number, payload: Record<string, unknown> = {}) => {
    const s = st();
    const id = uid();
    try {
      const r = await fetch("/api/listings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, kind, itemId, name, blurb, price, seller: pet.name, payload }),
      });
      const created = (await r.json()) as Listing;
      s.set({ listings: [created, ...s.listings] });
      s.questProgress("market");
      sfx("sell");
      s.toast(`Listed ${name} for ${price} coins`, "coins");
      s.pushMarket(`${pet.name} listed ${name} · ${price}c`, "upload", "listed");
      s.patchPet((p) => ({ ...p, stats: { ...p.stats, sold: (p.stats.sold ?? 0) + 1 } }));
      s.unlock("trader", "Trader", "Listed your first item", "coins");
    } catch {
      sfx("error");
      s.toast("Could not list the item", "close");
    }
  };

  const sellable = useMemo(
    () => ({
      hats: HATS.filter((h) => h.id !== "none" && pet.owned.includes(h.id) && pet.hat !== h.id),
      decor: DECOR.filter((d) => pet.owned.includes(d.id)),
      foods: FOODS.filter((f) => f.cost > 0),
    }),
    [pet.owned, pet.hat],
  );

  return (
    <div className="scroll h-full">
      <div className="mx-auto max-w-[1020px] px-1 pb-8">
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div>
            <div className="pixel-font text-[26px] leading-tight">Marketplace</div>
            <div className="text-[13px] text-dim">The team bazaar — buy treasures, sell your spares, earn your fortune.</div>
          </div>
          <div className="flex-1" />
          <span className="hud-pill">
            <Icon name="coins" size={14} className="text-accent" /> {pet.coins}
          </span>
          {wishCount > 0 && (
            <span className="chip" data-on="true" title="Items on your wishlist">
              <Icon name="heart" size={12} className="text-accent" /> {wishCount} wished
            </span>
          )}
          <span className="hud-pill hidden text-dim sm:inline-flex">
            <Icon name="trophy" size={14} /> {earned} earned
          </span>
          {soldToMe > 0 && (
            <span className="chip" data-on="true" title="Times Nook Bot or a teammate bought from your booth">
              <Icon name="hand" size={12} className="text-accent" /> {soldToMe} sold
            </span>
          )}
          <button className="btn btn-accent btn-sm" onClick={() => setListingOpen(!listingOpen)}>
            <Icon name="upload" size={13} /> Sell something
          </button>
        </div>

        {listingOpen && (
          <div className="paper mb-4 p-4" style={{ animation: "pop .25s ease both" }}>
            <div className="pixel-font mb-2 text-[16px]">Create a listing</div>
            <div className="flex flex-wrap gap-2">
              {sellable.hats.map((h) => (
                <button key={h.id} className="chip" onClick={() => void listItem("hat", h.id, h.name, h.blurb, Math.max(2, Math.round(h.cost * 0.8)), { from: "closet" })} title="List this hat">
                  <Icon name="shirt" size={12} /> {h.name} · {Math.max(2, Math.round(h.cost * 0.8))}
                </button>
              ))}
              {sellable.decor.map((d) => (
                <button key={d.id} className="chip" onClick={() => void listItem("decor", d.id, d.name, d.blurb, Math.max(2, Math.round(d.cost * 0.85)), { from: "den" })} title="List this den decoration">
                  <Icon name="home" size={12} /> {d.name} · {Math.max(2, Math.round(d.cost * 0.85))}
                </button>
              ))}
              {sellable.foods.map((f) => (
                <button key={f.id} className="chip" onClick={() => void listItem("food", f.id, `${f.name} ×2`, `${f.blurb} Bundle of two.`, Math.max(2, f.cost * 2 - 1), { food: f.id, qty: 2 })} title="List food bundle">
                  <Icon name={f.icon} size={12} /> {f.name} ×2 · {f.cost * 2 - 1}
                </button>
              ))}
              <button
                className="chip"
                onClick={() => void listItem("food", "cake", `${pet.name}’s care pack`, "A mystery bundle of treats, hand-packed.", 12, { food: "cake", qty: 2 })}
              >
                <Icon name="gift" size={12} /> Care pack · 12
              </button>
            </div>
            <div className="label mb-1.5 mt-3">Sell your creations — packs, fonts & games you made or imported</div>
            <div className="flex flex-wrap gap-2">
              {usePackStore.getState().customPacks.filter((p) => p.kind === "icons").map((p) => (
                <button key={p.id} className="chip" data-on="true" onClick={() => void listItem("iconpack", p.id, `Icon pack: ${p.name}`, `${Object.keys(p.icons ?? {}).length} custom icons for the whole app`, 25, { pack: p })} title="List this icon pack">
                  <Icon name="palette" size={12} /> {p.name} · 25
                </button>
              ))}
              {usePackStore.getState().customPacks.filter((p) => p.kind === "fonts").map((p) => (
                <button key={p.id} className="chip" data-on="true" onClick={() => void listItem("fontpack", p.id, `Font pack: ${p.name}`, `${p.fonts?.length ?? 0} custom font(s) for the whole app`, 25, { pack: p })} title="List this font pack">
                  <Icon name="type" size={12} /> {p.name} · 25
                </button>
              ))}
              {usePackStore.getState().customPacks.filter((p) => p.kind === "wallpapers").map((p) => (
                <button key={p.id} className="chip" data-on="true" onClick={() => void listItem("wallpaper", p.id, `Wallpapers: ${p.name}`, `${p.wallpapers?.length ?? 0} wallpaper(s) — sets the whole app background`, 18, { pack: p })} title="List this wallpaper pack">
                  <Icon name="image" size={12} /> {p.name} · 18
                </button>
              ))}
              {useStore.getState().customGames.map((g) => (
                <button key={g.id} className="chip" data-on="true" onClick={() => void listItem("game", g.id, `Game: ${g.title}`, `${g.blurb} (${g.engine} engine)`, 30, { game: g })} title="List this game">
                  <Icon name="gamepad" size={12} /> {g.title} · 30
                </button>
              ))}
              {usePackStore.getState().customPacks.length === 0 && useStore.getState().customGames.length === 0 && (
                <span className="text-[11.5px] text-faint">Import or create packs/games first (Settings → Packs, Arcade → Game maker) — then sell them here.</span>
              )}
            </div>
            <div className="mt-2 text-[12px] text-faint">
              Listings are visible to the whole team — and keep an eye out, Nook Bot loves to shop! 80–85% of shelf price · reclaiming costs a 20% fee.
            </div>
          </div>
        )}

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="seg">
            {(["all", "wish", "booth", "hat", "pet", "food", "theme", "decor", "iconpack", "fontpack", "wallpaper", "game"] as const).map((t) => (
              <button key={t} data-on={tab === t} onClick={() => setTab(t)}>
                <Icon name={t === "all" ? "app-windows" : t === "booth" ? "map-pin" : t === "wish" ? "heart" : KIND_META[t].icon} size={13} />
                {t === "all" ? "All" : t === "booth" ? `My booth${myUnsold ? ` ${myUnsold}` : ""}` : t === "wish" ? `Wishlist${wishCount ? ` ${wishCount}` : ""}` : KIND_META[t].label}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          {achievements.includes("trader") && <span className="chip">trader ✓</span>}
        </div>

        {/* market pulse — live feed of recent trades */}
        {marketFeed.length > 0 && (
          <div className="pulse-strip mb-3" role="status" aria-label="Recent market activity">
            <span className="label flex-none items-center gap-1.5 !text-[10px]" style={{ display: "inline-flex" }}>
              <span className="presence-dot" /> pulse
            </span>
            <div className="scroll flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pb-0.5">
              {marketFeed.map((ev) => (
                <span key={ev.id} className="pulse-chip flex-none" data-kind={ev.kind} style={{ animation: "pop .3s var(--ease-soft) both" }} title={ev.text}>
                  <Icon name={ev.icon} size={11} />
                  <span className="truncate">{ev.text}</span>
                  <span className="opacity-60">{timeAgo(ev.at)}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {filtered.map((l, i) => (
            <ListingCard
              key={l.id}
              l={l}
              i={i}
              coins={pet.coins}
              owned={pet.owned.includes(l.itemId)}
              mine={l.seller === pet.name}
              wished={wishlist[l.id] != null}
              onBuy={(x) => void buy(x)}
              onCancel={(x) => void cancel(x)}
              onSweeten={(x) => void sweeten(x)}
              onWish={(x) => useStore.getState().toggleWish(x.id, x.price)}
            />
          ))}
        </div>
        {filtered.length === 0 && (
          <div className="grid place-items-center gap-2 py-16 text-center text-dim">
            <Icon name={tab === "wish" ? "heart" : "inbox"} size={30} />
            <div className="pixel-font text-[15px] text-ink">{tab === "booth" ? "Your booth is empty" : tab === "wish" ? "Your wishlist is empty" : "Empty shelf"}</div>
            <div className="max-w-[240px] text-[12.5px]">
              {tab === "booth"
                ? "List a hat, a decoration or a food bundle — Nook Bot drops by regularly to buy things!"
                : tab === "wish"
                  ? "Tap the heart on any listing and you'll get a bell ping the moment its price drops."
                  : "Nothing in this aisle yet. Be the first to list something!"}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
