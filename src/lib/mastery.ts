/**
 * Arcade mastery — a per-game progression derived purely from the XP a game has
 * earned you (gameStats[id].xp), so it needs no extra persisted state and works
 * retroactively for every existing save.
 *
 * Levels are cumulative XP thresholds; each tier has a name + badge color that
 * the arcade cards, game shell and stats center all share.
 */

export type MasteryTier = { at: number; name: string; color: string };

export const MASTERY_TIERS: MasteryTier[] = [
  { at: 0, name: "Newcomer", color: "#9aa3ad" },
  { at: 100, name: "Novice", color: "#9dbb7a" },
  { at: 250, name: "Regular", color: "#7fb069" },
  { at: 500, name: "Veteran", color: "#e0b589" },
  { at: 900, name: "Ace", color: "#cba5ba" },
  { at: 1500, name: "Master", color: "#ffd166" },
];

export type Mastery = {
  /** 0-5 tier index */
  level: number;
  tier: string;
  color: string;
  /** xp where the current tier starts */
  cur: number;
  /** xp where the next tier starts (null at Master) */
  next: number | null;
  /** 0-100 progress inside the current tier (100 at Master) */
  pct: number;
};

export function masteryOf(xp: number): Mastery {
  let level = 0;
  for (let i = 0; i < MASTERY_TIERS.length; i++) if (xp >= MASTERY_TIERS[i].at) level = i;
  const cur = MASTERY_TIERS[level];
  const next = MASTERY_TIERS[level + 1] ?? null;
  const pct = next ? Math.min(100, Math.round(((xp - cur.at) / (next.at - cur.at)) * 100)) : 100;
  return { level, tier: cur.name, color: cur.color, cur: cur.at, next: next?.at ?? null, pct };
}

/** coins granted when a game climbs to a new mastery tier (paid on top of the run payout) */
export function masteryBonus(level: number): number {
  return level * 5;
}
