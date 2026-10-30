import type { IconName } from "@/components/icons";
import type { Mood } from "@/lib/sprite";
import type { Pet, Species } from "@/lib/types";
import { clamp } from "@/lib/util";

export const SPECIES: Record<Species, { label: string; blurb: string; hi: string; end: string; says: string[] }> = {
  cat: {
    label: "Cat",
    blurb: "Curious, aloof, secretly clingy.",
    hi: "Mrrp!",
    end: "*purrs*",
    says: ["Mrrp.", "I knocked a note off the desk. Sorry not sorry.", "Is that a new idea? Looks tasty.", "Pet me. No. Wait. Yes.", "Writing time is nap time. For me."],
  },
  bunny: {
    label: "Bunny",
    blurb: "Bouncy, gentle, always listening.",
    hi: "*nose twitch*",
    end: "*thump*",
    says: ["*nose twitch*", "Binky! A new thought!", "Your notes smell like clover.", "Hop hop. Keep writing!", "I can hear you typing. It is soothing."],
  },
  blob: {
    label: "Blob",
    blurb: "Squishy, glossy, eats pure ideas.",
    hi: "blip!",
    end: "~bloop~",
    says: ["blip.", "I absorbed a thought. It was crunchy.", "bloop bloop.", "I am 90% note and 10% jelly.", "Squish. Write. Squish."],
  },
  dog: {
    label: "Pup",
    blurb: "Loyal, loud, proud of you.",
    hi: "Woof!",
    end: "*tail wag*",
    says: ["Woof! You are doing great!", "Is it walk time? No? Okay, write time!", "I am guarding your notes.", "Good human. Good words.", "Fetch a note? I can fetch a note!"],
  },
  fox: {
    label: "Fox",
    blurb: "Clever, swift, collects shiny ideas.",
    hi: "Yip!",
    end: "*floofs tail*",
    says: ["Yip yip! Shiny thought spotted!", "I buried three notes in the garden.", "What does the fox write? This.", "Swift like fox, sneaky like fox.", "Your plot twists are delicious."],
  },
  panda: {
    label: "Panda",
    blurb: "Chill, snacky, rarely in a hurry.",
    hi: "Munch.",
    end: "*rolls over*",
    says: ["Munch munch… oh, writing?", "I nap so you can focus.", "Bamboo? No. Notes? Yes.", "Slow and steady fills the page.", "That paragraph deserves a snack."],
  },
  frog: {
    label: "Frog",
    blurb: "Hoppy, damp, surprisingly wise.",
    hi: "Ribbit!",
    end: "*croak*",
    says: ["Ribbit! Fresh lily-pad ideas!", "I kissed a typo and it hopped away.", "Leap into that draft!", "Rain is just sky typewriter.", "Croak. Translate: keep going."],
  },
  penguin: {
    label: "Penguin",
    blurb: "Dapper, waddly, always formal.",
    hi: "Ork!",
    end: "*bows politely*",
    says: ["Ork! A formal greeting, of course.", "Slid here on purpose. Mostly.", "Your notes? Impeccable. Tuxedo-level.", "Waddle we write today?", "Ice to meet you. Again."],
  },
  ghost: {
    label: "Ghost",
    blurb: "Spooky, soft, haunted by drafts.",
    hi: "Boo!",
    end: "*fades slightly*",
    says: ["Boo! Did the draft scare you?", "I am 90% sheet, 10% ideas.", "Spooky fact: your words float here forever.", "Passing through walls and writer's block.", "Ghost writer. Literally."],
  },
  dragon: {
    label: "Dragon",
    blurb: "Tiny, fierce, hoards coins.",
    hi: "Rawr!",
    end: "*snorts spark*",
    says: ["Rawr! That means good luck in dragon.", "My coin hoard loves your writing.", "Breathes tiny sparks, huge ideas.", "Quest status: complete. Snack?", "Scales polished, pages turning."],
  },
  axolotl: {
    label: "Axolotl",
    blurb: "Perma-smile, aquatic, regenerates.",
    hi: "Blub!",
    end: "*gill wiggle*",
    says: ["Blub blub! Smiling is my whole thing.", "Bad day? I regrow good ones.", "Water you writing today?", "Gills certified, ideas certified.", "Stay soft. Stay smiley."],
  },
  owl: {
    label: "Owl",
    blurb: "Wise, nocturnal, cites sources.",
    hi: "Hoot!",
    end: "*head turn*",
    says: ["Hoot! Fun fact incoming…", "I read that chapter at 3am.", "Who? Who? You. You wrote this.", "Wisdom: take the break.", "Night owl hours are writing hours."],
  },
};

export type FoodItem = { id: string; name: string; icon: IconName; cost: number; food: number; joy: number; energy: number; blurb: string };
export const FOODS: FoodItem[] = [
  { id: "berry", name: "Pixel berry", icon: "leaf", cost: 0, food: 14, joy: 3, energy: 0, blurb: "Free. Tiny. Reliable." },
  { id: "fish", name: "Fish snack", icon: "fish", cost: 3, food: 32, joy: 6, energy: 0, blurb: "A proper meal." },
  { id: "cake", name: "Moon cake", icon: "cake", cost: 8, food: 20, joy: 28, energy: 0, blurb: "Pure happiness." },
  { id: "coffee", name: "Warm drink", icon: "coffee", cost: 5, food: 4, joy: 4, energy: 36, blurb: "Wakes everyone up." },
  { id: "honey", name: "Golden honey", icon: "sparkle", cost: 6, food: 22, joy: 14, energy: 8, blurb: "Sticky sweet success." },
  { id: "taco", name: "Pixel taco", icon: "gift", cost: 7, food: 30, joy: 18, energy: 6, blurb: "Crunchy fiesta." },
];

export type HatItem = { id: string; name: string; cost: number; blurb: string };
export const HATS: HatItem[] = [
  { id: "none", name: "Bare head", cost: 0, blurb: "Natural look." },
  { id: "bow", name: "Soft bow", cost: 8, blurb: "Tiny and tasteful." },
  { id: "beanie", name: "Cozy beanie", cost: 12, blurb: "Warm ears." },
  { id: "shades", name: "Pixel shades", cost: 15, blurb: "Deal with it." },
  { id: "wizard", name: "Wizard hat", cost: 30, blurb: "+10 to note magic." },
  { id: "crown", name: "Royal crown", cost: 40, blurb: "Archive royalty." },
  { id: "party", name: "Party hat", cost: 14, blurb: "Confetti not included." },
  { id: "tophat", name: "Top hat", cost: 22, blurb: "Fancy schmancy." },
];

// ---------- tricks ----------
/** teachable pet tricks — learn with coins, perform any time (wave + spin come pre-learned) */
export type TrickItem = { id: string; name: string; icon: IconName; cost: number; mood: Mood; ms: number; xp: number; joy: number; says: string[]; blurb: string };

export const TRICKS: TrickItem[] = [
  { id: "wave", name: "Wave hello", icon: "wave-hand", cost: 0, mood: "happy", ms: 1800, xp: 2, joy: 3, says: ["Hi there! 👋", "Hello hello!", "*waves paw*"], blurb: "The classic. Comes free." },
  { id: "spin", name: "Spin around", icon: "reload", cost: 0, mood: "spin", ms: 1900, xp: 2, joy: 4, says: ["Wheee!", "Ta-da!", "Round and round!"], blurb: "A dizzy little pirouette." },
  { id: "backflip", name: "Backflip", icon: "zap", cost: 12, mood: "spin", ms: 2600, xp: 5, joy: 8, says: ["CORKSCREW!", "Nailed it!", "10 from the judges!"], blurb: "Pure acrobatics. Worth every coin." },
  { id: "highfive", name: "High five", icon: "hand", cost: 10, mood: "happy", ms: 1600, xp: 3, joy: 6, says: ["Up top!", "*slap* Teamwork!", "Right here! ✋"], blurb: "For a job well done." },
  { id: "speak", name: "Speak up", icon: "message-text", cost: 8, mood: "look", ms: 2000, xp: 3, joy: 4, says: ["Woof! …I mean, meow?", "I have opinions!", "Quote of the day: me."], blurb: "A dramatic monologue." },
  { id: "dance", name: "Disco dance", icon: "sparkles", cost: 16, mood: "happy", ms: 3200, xp: 6, joy: 10, says: ["💃 Boogie!", "*funky moves*", "Dance break!"], blurb: "Boots and cats and boots." },
  { id: "meditate", name: "Zen master", icon: "moon", cost: 20, mood: "sleep", ms: 4200, xp: 8, joy: 6, says: ["Ommm…", "I am one with the notes.", "*floats slightly*"], blurb: "Restores a little energy too." },
  { id: "stand", name: "Stand still", icon: "target", cost: 25, mood: "idle", ms: 2600, xp: 10, joy: 2, says: ["…", "*statue mode*", "I am a rock."], blurb: "The hardest trick of all." },
];

export const STARTER_TRICKS = ["wave", "spin"];

export function levelOf(xp: number) {
  const level = Math.floor(Math.sqrt(xp / 30)) + 1;
  const cur = (level - 1) ** 2 * 30;
  const next = level ** 2 * 30;
  return { level, cur, next, pct: clamp((xp - cur) / (next - cur), 0, 1) };
}

// ---------- evolution stages ----------
export type Stage = { id: 1 | 2 | 3; name: string; desc: string; scale: number; aura: number };

export const STAGES: Stage[] = [
  { id: 1, name: "Baby", desc: "Tiny, wobbly, endlessly curious.", scale: 1, aura: 0 },
  { id: 2, name: "Spry", desc: "A spring in every step — I grew!", scale: 1.13, aura: 0.35 },
  { id: 3, name: "Radiant", desc: "Legendary. Glows with note wisdom.", scale: 1.26, aura: 0.6 },
];

export function stageOf(level: number): Stage {
  return level >= 5 ? STAGES[2] : level >= 3 ? STAGES[1] : STAGES[0];
}

// ---------- den decorations ----------
export type DecorItem = { id: string; name: string; icon: IconName; cost: number; blurb: string };

export const DECOR: DecorItem[] = [
  { id: "decor-rug", name: "Cozy rug", icon: "circle", cost: 12, blurb: "A soft spot for floor naps." },
  { id: "decor-fern", name: "Pixel fern", icon: "leaf", cost: 14, blurb: "Photosynthesizes ideas." },
  { id: "decor-poster", name: "Note poster", icon: "note", cost: 10, blurb: "Vintage archive print." },
  { id: "decor-cushion", name: "Cloud cushion", icon: "cloud", cost: 16, blurb: "Nine of ten pets nap here." },
  { id: "decor-lamp", name: "Glow lamp", icon: "lightbulb", cost: 18, blurb: "Warm light for late drafts." },
  { id: "decor-window", name: "Star window", icon: "sparkles", cost: 22, blurb: "Watch pixels fall outside." },
  { id: "decor-boombox", name: "Boombox", icon: "play", cost: 24, blurb: "Lo-fi beats for the den." },
  { id: "decor-trophy", name: "Trophy shelf", icon: "trophy", cost: 28, blurb: "Shows off your achievements." },
];

const DECAY = { food: 0.32, energy: 0.16, joy: 0.28 }; // per minute

// ---------- species abilities ----------
/** every species has a passive ability — shown in the Den and applied by the store */
export type Ability = {
  id: string;
  name: string;
  desc: string;
  icon: IconName;
  /** coin multiplier when earning (e.g. 1.1 = +10% coins) */
  coinMult?: number;
  /** xp multiplier when earning */
  xpMult?: number;
  /** energy decay multiplier (0.5 = half decay) */
  energyDecayMult?: number;
  /** food decay multiplier */
  foodDecayMult?: number;
  /** chance per minute to find a coin while you work */
  coinFindChance?: number;
  /** focus timer length multiplier */
  focusMult?: number;
  /** sale earnings multiplier on the marketplace */
  saleMult?: number;
};

export const ABILITIES: Record<Species, Ability> = {
  cat: { id: "nine-lives", name: "Nine Lives", desc: "+8% XP from everything — curiosity compounds.", icon: "sparkle", xpMult: 1.08 },
  bunny: { id: "lucky-foot", name: "Lucky Foot", desc: "12% chance per minute to find a coin while you work.", icon: "coins", coinFindChance: 0.12 },
  blob: { id: "slow-metabolism", name: "Slow Metabolism", desc: "Gets hungry 35% slower than everyone else.", icon: "leaf", foodDecayMult: 0.65 },
  dog: { id: "loyal-heart", name: "Loyal Heart", desc: "+10% coins from every reward — good boys get paid.", icon: "coins", coinMult: 1.1 },
  fox: { id: "shrewd-trader", name: "Shrewd Trader", desc: "+15% coins when items sell on the marketplace.", icon: "hand", saleMult: 1.15 },
  panda: { id: "zen-rest", name: "Zen Rest", desc: "Loses energy 30% slower — naps are a lifestyle.", icon: "moon", energyDecayMult: 0.7 },
  frog: { id: "spring-step", name: "Spring Step", desc: "+6% XP and +4% coins on everything.", icon: "zap", xpMult: 1.06, coinMult: 1.04 },
  penguin: { id: "formal-focus", name: "Formal Focus", desc: "Focus timer sessions run 10% longer, free.", icon: "hourglass", focusMult: 1.1 },
  ghost: { id: "phase-shift", name: "Phase Shift", desc: "Needs 25% less energy — barely mortal.", icon: "moon-star", energyDecayMult: 0.75 },
  dragon: { id: "coin-hoard", name: "Coin Hoard", desc: "+18% coins from marketplace sales, +6% coins everywhere.", icon: "crown", saleMult: 1.18, coinMult: 1.06 },
  axolotl: { id: "regenerate", name: "Regenerate", desc: "Recovers: food and energy both decay 20% slower.", icon: "heart", foodDecayMult: 0.8, energyDecayMult: 0.8 },
  owl: { id: "night-wisdom", name: "Night Wisdom", desc: "+12% XP — wise birds learn twice.", icon: "book", xpMult: 1.12 },
};

export function abilityOf(species: Species): Ability {
  return ABILITIES[species] ?? ABILITIES.cat;
}

export function decayed(p: Pet, now = Date.now()): Pet {
  const mins = clamp((now - p.tickAt) / 60_000, 0, 600);
  if (mins < 0.05) return p;
  const ab = abilityOf(p.species);
  return {
    ...p,
    food: clamp(p.food - DECAY.food * mins * (ab.foodDecayMult ?? 1), 6, 100),
    energy: clamp(p.energy - DECAY.energy * mins * (ab.energyDecayMult ?? 1), 6, 100),
    joy: clamp(p.joy - DECAY.joy * mins, 6, 100),
    tickAt: now,
  };
}

export function moodFor(p: Pet): "idle" | "sad" {
  return Math.min(p.food, p.joy, p.energy) < 22 ? "sad" : "idle";
}
