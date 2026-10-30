import type { AppCat } from "@/lib/store";

/** a blocked site/app rule — `match` is a substring matched case-insensitively against the app name */
export type BlockRule = { id: string; match: string; enabled: boolean; createdAt: number };
/** per-app daily time limit in minutes (0 = remove) */
export type AppLimits = Record<string, number>;
/** quiet hours: outside these hours only productive apps are allowed (when shield is on) */
export type QuietHours = { enabled: boolean; from: number; to: number }; // hours 0-23
/** category pattern rule: apps containing `match` are auto-triaged into `cat` */
export type CatPattern = { id: string; match: string; cat: AppCat; createdAt: number };
/** full rule-set persisted in prefs (browser-local — rules are personal, not server data) */
export type RulesState = {
  shieldOn: boolean;
  blocklist: BlockRule[];
  limits: AppLimits;
  quiet: QuietHours;
  patterns: CatPattern[];
  /** sha-256 of the optional admin PIN; "" = no PIN */
  pinHash: string;
};

export const DEFAULT_RULES: RulesState = {
  shieldOn: false,
  blocklist: [],
  limits: {},
  quiet: { enabled: false, from: 9, to: 12 },
  patterns: [],
  pinHash: "",
};

/** sha-256 hex of a string (WebCrypto, browser only) */
export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function matchesRule(app: string, match: string): boolean {
  if (!match) return false;
  return app.toLowerCase().includes(match.toLowerCase());
}

export type Verdict = {
  blocked: boolean; // matches an enabled block rule
  limited: boolean; // has a limit rule
  limitMins: number;
  usedSecs: number;
  limitPct: number; // 0..1 (can exceed 1 when over)
  over: boolean;
  quietViolate: boolean; // non-productive during enabled quiet hours
};

/** pure verdict for an app given the current rules + today's usage */
export function verdictFor(
  app: string,
  rules: RulesState,
  usedSecsToday: number,
  catOf: (app: string) => AppCat,
  nowHour: number,
): Verdict {
  const key = app.toLowerCase();
  const blocked = rules.blocklist.some((b) => b.enabled && matchesRule(key, b.match));
  const limitMins = rules.limits[key] ?? 0;
  const limited = limitMins > 0;
  const limitPct = limited ? usedSecsToday / (limitMins * 60) : 0;
  const quietViolate = rules.shieldOn && rules.quiet.enabled && catOf(app) !== "productive" && inQuiet(nowHour, rules.quiet);
  return { blocked, limited, limitMins, usedSecs: usedSecsToday, limitPct, over: limited && usedSecsToday > limitMins * 60, quietViolate };
}

/** is `hour` (0-23) inside the quiet window? windows may wrap midnight (e.g. 22 → 7) */
export function inQuiet(hour: number, q: QuietHours): boolean {
  if (!q.enabled) return false;
  return q.from <= q.to ? hour >= q.from && hour < q.to : hour >= q.from || hour < q.to;
}
