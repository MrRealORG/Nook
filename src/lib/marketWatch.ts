import type { Listing } from "@/lib/types";
import { flyCoins } from "@/lib/coinFly";
import { sfx } from "@/lib/sfx";
import { useStore } from "@/lib/store";

/**
 * Global marketplace watcher.
 *
 * Nook Bot buys listings server-side (the API credits the seller's coins in the
 * DB). If the client never notices, its next pet save overwrites that increment
 * and the sale money vanishes — so the watcher polls from ANY view, pays the
 * client-side mirror of the server increment, toasts, and raises a badge.
 *
 * It also keeps the store `listings` fresh everywhere (market grid, team bulletin).
 */

let timer: ReturnType<typeof setInterval> | null = null;
let started = false;
/** sold listing ids already accounted for (payout shown or pre-existing) */
const seen = new Set<string>();
/** wished listing ids whose "sold out" notice already fired */
const seenWishSold = new Set<string>();
let primed = false;

const PAYOUT = 0.9;

async function tick() {
  if (typeof document !== "undefined" && document.hidden) return;
  const s = useStore.getState();
  try {
    const r = await fetch("/api/listings", { cache: "no-store" });
    if (!r.ok) return;
    const fresh = (await r.json()) as Listing[];

    if (!primed) {
      // first snapshot of the session: everything already sold is history
      primed = true;
      for (const l of fresh) if (l.sold) seen.add(l.id);
      // ...and wished-but-sold listings must not re-fire their sold-out notice every reload
      const w = useStore.getState().wishlist;
      for (const l of fresh) if (l.sold && w[l.id] != null) seenWishSold.add(l.id);
    }

    let gained = 0;
    const bought: Listing[] = [];
    for (const l of fresh) {
      if (l.sold && !seen.has(l.id)) {
        seen.add(l.id);
        if (l.seller === s.pet.name) {
          bought.push(l);
          gained += Math.round(l.price * PAYOUT);
        }
      }
    }

    const changed =
      bought.length > 0 ||
      fresh.some((f) => {
        const old = s.listings.find((x) => x.id === f.id);
        return !old || old.sold !== f.sold || old.price !== f.price;
      }) ||
      fresh.length !== s.listings.length;

    if (bought.length) {
      const st = useStore.getState();
      st.patchPet((p) => ({
        ...p,
        coins: p.coins + gained,
        stats: {
          ...p.stats,
          earned: (p.stats.earned ?? 0) + gained,
          sales: (p.stats.sales ?? 0) + bought.length,
        },
      }));
      st.unlock("shopkeeper", "Shopkeeper", "Earned coins from a marketplace sale", "hand");
      if ((useStore.getState().pet.stats.sales ?? 0) >= 3) st.unlock("sale-3", "Hot Stall", "Nook Bot bought 3 of your listings", "hand");
      st.doAct("happy", 2400);
      // speech bubble in the den — the pet celebrates the sale by name
      st.say(
        bought.length === 1
          ? `Someone bought my ${bought[0].name}! Cha-ching!`
          : `${bought.length} sales while you were away! Cha-ching!`,
        undefined,
        3600,
      );
      // coins fly in from the top edge (sale happened away from the keyboard)
      flyCoins(gained, { from: { x: window.innerWidth / 2 - 7, y: 8 } });
      sfx("sell");
      const label = bought.length === 1 ? `Nook Bot bought ${bought[0].name}` : `Nook Bot bought ${bought.length} items`;
      st.toast(`${label} — +${gained} coins!`, "coins");
      st.notify(`${label} — +${gained} coins`, "coins", "sale");
      for (const l of bought) st.pushMarket(`${l.seller} sold ${l.name} (+${Math.round(l.price * PAYOUT)})`, "coins", "sold");
      if (useStore.getState().view !== "market") {
        useStore.setState({ marketUnread: useStore.getState().marketUnread + bought.length });
      }
    }

    if (changed) useStore.setState({ listings: fresh });

    // ---------- wishlist alerts ----------
    // wished listing got cheaper → bell notice once per drop (the stored target
    // ratchets down to the new price, so a further drop alerts again)
    // wished listing sold out → "sold out" notice once per listing
    const wishes = useStore.getState().wishlist;
    if (Object.keys(wishes).length) {
      const st2 = useStore.getState();
      const nextWishes = { ...wishes };
      let alerted = 0;
      let soldOut = 0;
      for (const l of fresh) {
        const target = wishes[l.id];
        if (target == null) continue;
        if (l.sold) {
          if (!seenWishSold.has(l.id)) {
            seenWishSold.add(l.id);
            soldOut++;
            st2.notify(`Wish alert — ${l.name} sold out before you jumped in!`, "heart", "sale");
          }
          continue;
        }
        if (l.price < target) {
          alerted++;
          nextWishes[l.id] = l.price;
          st2.notify(`Wish alert — ${l.name} dropped to ${l.price}c (was ${target}c)`, "heart", "sale");
        }
      }
      if (alerted > 0) st2.set({ wishlist: nextWishes });
      if (alerted > 0 || soldOut > 0) {
        sfx("star");
        st2.toast(alerted > 0 ? `Wish alert — ${alerted > 1 ? `${alerted} prices` : "a price"} dropped!` : "Wish alert — sold out!", "heart");
      }
    }
  } catch {
    /* market stall momentarily closed */
  }
}

/** Start polling (idempotent, browser only). */
export function startMarketWatcher() {
  if (started || typeof window === "undefined") return;
  started = true;
  void tick();
  timer = setInterval(() => void tick(), 15_000);
}

export function stopMarketWatcher() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

/** Register a listing id whose sale/claim the client itself caused (no double payout). Only for SOLD states. */
export function markSaleSeen(id: string) {
  seen.add(id);
}
