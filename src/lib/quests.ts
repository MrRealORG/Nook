import type { IconName } from "@/components/icons";

export type QuestDef = {
  id: string;
  title: string;
  desc: string;
  icon: IconName;
  goal: number;
  coins: number;
  xp: number;
};

export const QUESTS: QuestDef[] = [
  { id: "words", title: "Scribe", desc: "Write 60 words", icon: "pencil", goal: 60, coins: 10, xp: 15 },
  { id: "games", title: "Arcade rookie", desc: "Play 2 arcade games", icon: "gamepad", goal: 2, coins: 8, xp: 12 },
  { id: "focus", title: "Deep diver", desc: "Finish a focus session", icon: "hourglass", goal: 1, coins: 12, xp: 20 },
  { id: "care", title: "Best friend", desc: "Pat or feed your pet 3 times", icon: "heart", goal: 3, coins: 6, xp: 8 },
  { id: "market", title: "Merchant", desc: "Buy or list a marketplace item", icon: "coins", goal: 1, coins: 8, xp: 10 },
  { id: "tasks", title: "Taskmaster", desc: "Complete 3 tasks", icon: "checkbox-on", goal: 3, coins: 10, xp: 14 },
  { id: "agent", title: "Summon the helper", desc: "Have your AI companion do something real", icon: "sparkles", goal: 1, coins: 12, xp: 18 },
];

/** Bonus quest: rotates daily (harder goal, better pay). Progress rides the same streams. */
export type BonusQuestDef = QuestDef & { stream: string };

export const BONUS_QUESTS: BonusQuestDef[] = [
  { id: "bonus", title: "Grand scribe", desc: "Write 150 words", icon: "pencil", goal: 150, coins: 16, xp: 24, stream: "words" },
  { id: "bonus", title: "Arcade marathon", desc: "Play 5 arcade games", icon: "gamepad", goal: 5, coins: 14, xp: 20, stream: "games" },
  { id: "bonus", title: "Double dive", desc: "Finish 2 focus sessions", icon: "hourglass", goal: 2, coins: 18, xp: 28, stream: "focus" },
  { id: "bonus", title: "Cuddle bug", desc: "Pat or feed your pet 6 times", icon: "heart", goal: 6, coins: 10, xp: 14, stream: "care" },
  { id: "bonus", title: "Market mogul", desc: "Buy or list 3 items", icon: "coins", goal: 3, coins: 15, xp: 22, stream: "market" },
  { id: "bonus", title: "Checklist hero", desc: "Complete 6 tasks", icon: "checkbox-on", goal: 6, coins: 16, xp: 24, stream: "tasks" },
  { id: "bonus", title: "Weekend wordsmith", desc: "Write 120 words", icon: "pencil", goal: 120, coins: 14, xp: 20, stream: "words" },
  { id: "bonus", title: "Tournament day", desc: "Play 4 arcade games", icon: "gamepad", goal: 4, coins: 14, xp: 20, stream: "games" },
];

export function dayOfYear(): number {
  const d = new Date();
  return Math.floor((d.getTime() - new Date(d.getFullYear(), 0, 0).getTime()) / 86_400_000);
}

/** Deterministic daily rotation through the bonus quest wheel. */
export function bonusQuestOf(): BonusQuestDef {
  return BONUS_QUESTS[dayOfYear() % BONUS_QUESTS.length];
}

/** Tomorrow's rotating bonus quest — shown as a heads-up chip on the dashboard. */
export function tomorrowBonus(): BonusQuestDef {
  return BONUS_QUESTS[(dayOfYear() + 1) % BONUS_QUESTS.length];
}

export const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export const yesterdayKey = () => {
  const d = new Date(Date.now() - 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export type QuestsState = { date: string; progress: Record<string, number>; claimed: Record<string, boolean> };

export const freshQuests = (): QuestsState => ({ date: todayKey(), progress: {}, claimed: {} });

/** Achievement metadata registry — keys are stored in prefs; display info comes from here. */
export const ACHIEVEMENTS: Record<string, { title: string; desc: string; icon: IconName }> = {
  "first-focus": { title: "First Focus", desc: "Finished your first focus session", icon: "hourglass" },
  "focus-5": { title: "Deep Worker", desc: "5 focus sessions completed", icon: "hourglass" },
  "first-buy": { title: "First Purchase", desc: "Bought something from the marketplace", icon: "gift" },
  collector: { title: "Collector", desc: "Own 8 items", icon: "crown" },
  trader: { title: "Trader", desc: "Listed your first item", icon: "coins" },
  quester: { title: "Quest Seeker", desc: "Claimed your first daily quest", icon: "flag" },
  "perfect-day": { title: "Perfect Day", desc: "Claimed every daily quest", icon: "trophy" },
  evolved: { title: "Shiny and New", desc: "Your pet evolved into a new stage", icon: "sparkles" },
  decorator: { title: "Den Keeper", desc: "Bought 3 den decorations", icon: "home" },
  "interior-designer": { title: "Interior Designer", desc: "Every decoration placed in the den", icon: "home" },
  "streak-3": { title: "Warming Up", desc: "Visited 3 days in a row", icon: "fire" },
  "streak-7": { title: "Week Streak", desc: "Visited 7 days in a row", icon: "fire" },
  "theme-collector": { title: "Theme Collector", desc: "Owned every rare marketplace theme", icon: "sparkle" },
  archivist: { title: "Archivist", desc: "Exported your notes as a JSON backup", icon: "download" },
  "time-traveler": { title: "Time Traveler", desc: "Imported notes into the vault", icon: "upload" },
  "arcade-star": { title: "Arcade Star", desc: "Set a record in 5 different games", icon: "trophy" },
  "plays-25": { title: "Arcade Regular", desc: "Played 25 arcade rounds", icon: "gamepad" },
  shopkeeper: { title: "Shopkeeper", desc: "Earned coins from a marketplace sale", icon: "hand" },
  "bonus-5": { title: "Bonus Hunter", desc: "Claimed 5 rotating bonus quests", icon: "star" },
  "sale-3": { title: "Hot Stall", desc: "Nook Bot bought 3 of your listings", icon: "hand" },
  "qstreak-3": { title: "Consistent", desc: "Every daily quest claimed 3 days in a row", icon: "fire" },
  "qstreak-7": { title: "Flawless Week", desc: "7 perfect days in a row", icon: "fire" },
  "daily-1": { title: "Gifted", desc: "Claimed your first daily gift", icon: "gift" },
  "daily-7": { title: "Full Week", desc: "Completed a 7-day gift cycle", icon: "calendar" },
  negotiator: { title: "Negotiator", desc: "Sweetened a listing's price on the market", icon: "label" },
  "arcade-legend": { title: "Arcade Legend", desc: "Set a record in 10 different games", icon: "crown" },
  tourist: { title: "Guided by Paw", desc: "Finished the welcome tour with your pet", icon: "map-pin" },
  "task-10": { title: "Checklist Champ", desc: "Completed 10 tasks", icon: "checkbox-on" },
  "task-50": { title: "Task Machine", desc: "Completed 50 tasks", icon: "checkbox-on" },
  "tool-user": { title: "Teamwork!", desc: "Your AI companion ran a real tool for you", icon: "sparkles" },
  "tracker-1": { title: "Time Keeper", desc: "Tracked your first hour of app time", icon: "clock" },
};

export function achievementInfo(key: string): { title: string; desc: string; icon: IconName } {
  const known = ACHIEVEMENTS[key];
  if (known) return known;
  const m = /^level-(\d+)$/.exec(key);
  if (m) return { title: `Level ${m[1]}`, desc: "Your pet reached a new level", icon: "crown" };
  return { title: key, desc: "Mystery achievement", icon: "star" };
}
