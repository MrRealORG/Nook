import { DECOR, FOODS, HATS, TRICKS } from "@/lib/pet";
import { sfx } from "@/lib/sfx";
import { useStore } from "@/lib/store";
import type { AiResult, Listing } from "@/lib/types";
import { clamp, uid } from "@/lib/util";

const S = () => useStore.getState();

export function patPet() {
  const s = S();
  s.questProgress("care");
  s.patchPet((p) => ({ ...p, joy: clamp(p.joy + 8, 0, 100), stats: { ...p.stats, pats: p.stats.pats + 1 } }));
  sfx("happy");
  s.doAct("happy", 1900);
  const n = s.pet.stats.pats + 1;
  if (n % 10 === 0) {
    s.gain(1, 2);
    s.say("That was the 10th pat! +1 coin for you.");
  }
}

export function feedPet(id: string): boolean {
  const s = S();
  const f = FOODS.find((x) => x.id === id);
  if (!f) return false;
  if (s.pet.coins < f.cost) {
    sfx("error");
    s.toast(`Need ${f.cost} coins — write a little more!`, "coins");
    s.say("Hungry… but we need coins.");
    s.doAct("sad", 1800);
    return false;
  }
  if (f.energy === 0 && s.pet.food >= 98) {
    s.say("I'm stuffed!");
    return false;
  }
  sfx("eat");
  s.questProgress("care");
  s.patchPet((p) => ({
    ...p,
    coins: p.coins - f.cost,
    food: clamp(p.food + f.food, 0, 100),
    joy: clamp(p.joy + f.joy, 0, 100),
    energy: clamp(p.energy + f.energy, 0, 100),
    xp: p.xp + 2,
    stats: { ...p.stats, fed: p.stats.fed + 1 },
  }));
  s.doAct("eat", 2300);
  s.say(["Nom nom nom!", "Delicious!", "More please?"][Math.floor(Math.random() * 3)]);
  return true;
}

export function napPet() {
  const s = S();
  if (s.act?.mood === "sleep") return;
  s.doAct("sleep", 6500);
  s.say("zzz…", undefined, 2500);
  setTimeout(() => {
    S().patchPet((p) => ({ ...p, energy: clamp(p.energy + 40, 0, 100) }));
    S().say("Ahh, fresh as a pixel!");
  }, 6500);
}

export function trickPet() {
  const s = S();
  const learned = s.pet.tricks?.length ? s.pet.tricks : ["wave", "spin"];
  performTrick(learned[Math.floor(Math.random() * learned.length)]);
}

/** learn a new trick (paying coins) — tricks unlock permanent pet skills */
export function learnTrick(id: string) {
  const s = S();
  const t = TRICKS.find((x) => x.id === id);
  if (!t || s.pet.tricks.includes(id)) return;
  if (s.pet.coins < t.cost) {
    sfx("error");
    s.toast(`${t.name} costs ${t.cost} coins — write or play to earn more!`, "coins");
    s.doAct("sad", 1600);
    return;
  }
  sfx("buy");
  s.patchPet((p) => ({ ...p, coins: p.coins - t.cost, tricks: [...(p.tricks ?? []), id], joy: clamp(p.joy + 5, 0, 100) }));
  s.toast(`${s.pet.name} learned “${t.name}”!`, t.icon);
  s.notify(`${s.pet.name} learned a new trick — ${t.name}`, t.icon, "pet");
  s.say(`Ooh, ${t.name}? Let me try! Click perform!`);
  s.doAct("happy", 2200);
  s.unlock("trick-1", "Trickster", "Taught your pet its first trick", "star");
  if (s.pet.tricks.length + 1 >= TRICKS.length) s.unlock("trick-all", "Full Curriculum", "Every trick learned", "trophy");
}

/** perform a learned trick — animation + speech + tiny xp/joy */
export function performTrick(id: string) {
  const s = S();
  const t = TRICKS.find((x) => x.id === id);
  if (!t || !s.pet.tricks?.includes(id)) return;
  s.doAct(t.mood, t.ms);
  sfx("happy");
  s.say(t.says[Math.floor(Math.random() * t.says.length)], undefined, t.ms);
  s.patchPet((p) => ({
    ...p,
    joy: clamp(p.joy + t.joy, 0, 100),
    energy: id === "meditate" ? clamp(p.energy + 10, 0, 100) : clamp(p.energy - 1, 0, 100),
    xp: p.xp + t.xp,
    stats: { ...p.stats, tricks: (p.stats.tricks ?? 0) + 1 },
  }));
  s.questProgress("care");
  const perf = (S().pet.stats.tricks ?? 0);
  if (perf >= 10) S().unlock("stage-presence", "Stage Presence", "Watched 10 trick performances", "star");
  if (perf >= 40) S().unlock("showstopper", "Showstopper", "40 trick performances — a true star", "crown");
}

export function buyHat(id: string) {
  const s = S();
  const h = HATS.find((x) => x.id === id);
  if (!h) return;
  if (s.pet.owned.includes(id)) return;
  if (s.pet.coins < h.cost) {
    s.toast(`${h.name} costs ${h.cost} coins`, "coins");
    return;
  }
  sfx("buy");
  s.patchPet((p) => ({ ...p, coins: p.coins - h.cost, owned: [...p.owned, id], hat: id }));
  s.toast(`Bought ${h.name}!`, "shirt");
  s.doAct("happy", 2200);
  s.say("I look amazing, right?");
}

export function equipHat(id: string) {
  const s = S();
  if (!s.pet.owned.includes(id)) return;
  s.patchPet((p) => ({ ...p, hat: id }));
  sfx("equip");
  s.doAct("spin", 1400);
}

export function buyDecor(id: string) {
  const s = S();
  const d = DECOR.find((x) => x.id === id);
  if (!d || s.pet.owned.includes(id)) return;
  if (s.pet.coins < d.cost) {
    sfx("error");
    s.toast(`${d.name} costs ${d.cost} coins`, "coins");
    s.say("Ooh… but we need more coins.");
    s.doAct("sad", 1600);
    return;
  }
  sfx("buy");
  s.patchPet((p) => ({ ...p, coins: p.coins - d.cost, owned: [...p.owned, id], joy: clamp(p.joy + 3, 0, 100) }));
  s.toast(`${d.name} placed in the den!`, d.icon);
  s.doAct("happy", 2200);
  const count = DECOR.filter((x) => S().pet.owned.includes(x.id)).length;
  if (count >= 3) S().unlock("decorator", "Den Keeper", "Bought 3 den decorations", "home");
  if (count >= DECOR.length) S().unlock("interior-designer", "Interior Designer", "Every decoration placed in the den", "home");
}

export async function fetchForgotten() {
  const s = S();
  s.doAct("think", 3000);
  try {
    const r = await fetch("/api/ai", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "fetch", noteId: s.activeId ?? undefined }),
    });
    const res = (await r.json()) as AiResult;
    const src = res.sources?.[0];
    S().doAct("happy", 2200);
    if (src) {
      const n = S().notes.find((x) => x.id === src.id);
      const days = n ? Math.max(1, Math.round((Date.now() - n.updatedAt) / 86_400_000)) : 0;
      S().say(`I dug up “${src.title}” — untouched for ${days} day${days === 1 ? "" : "s"}!`, { label: "Open it", noteId: src.id });
      S().patchPet((p) => ({ ...p, joy: clamp(p.joy + 5, 0, 100), xp: p.xp + 2 }));
    } else S().say("Nothing to fetch yet. Write more notes!");
  } catch {
    S().say("The ball rolled away… try again?");
  }
}

/** List an owned hat/decor on the marketplace and hand the physical item over (removed from owned). */
export async function sellOwnedItem(kind: "hat" | "decor", itemId: string, name: string, price: number, blurb = "") {
  const s = S();
  if (!s.pet.owned.includes(itemId)) return false;
  const id = uid();
  try {
    const r = await fetch("/api/listings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, kind, itemId, name, blurb: blurb || "Gently used, loved once.", price, seller: s.pet.name, payload: { from: "closet" } }),
    });
    const created = (await r.json()) as Listing;
    // the item leaves the closet and appears in the market
    s.patchPet((p) => ({ ...p, owned: p.owned.filter((x) => x !== itemId), hat: p.hat === itemId ? "none" : p.hat }));
    s.set({ listings: [created, ...s.listings] });
    s.questProgress("market");
    sfx("sell");
    s.toast(`Listed ${name} for ${price} coins`, "coins");
    s.patchPet((p) => ({ ...p, stats: { ...p.stats, sold: (p.stats.sold ?? 0) + 1 } }));
    s.unlock("trader", "Trader", "Listed your first item", "coins");
    return true;
  } catch {
    sfx("error");
    s.toast("Could not list the item", "close");
    return false;
  }
}
