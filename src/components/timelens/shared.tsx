/** Timelens shared bits: types, formatting, the app-icon / favicon cache and avatars. */
import { memo, useEffect, useState, useSyncExternalStore } from "react";

export type Cat = "productive" | "neutral" | "distracting";
export type Seg = { app: string; title: string; start: number; end: number; afk: boolean; focus: boolean; cat: string };
export type AppRow = { app: string; secs: number; cat: string };
export type SiteRow = { site: string; domain: string | null; secs: number; cat: string; browser: string };
export type Summary = {
  from: number; to: number; activeSecs: number; afkSecs: number; focusSecs: number; score: number;
  totalSecs: number; productiveSecs: number; focusedSecs: number; focusBlocks: [number, number][];
  firstActivity: number | null; lastActivity: number | null;
  categories: Record<Cat, number>;
  apps: AppRow[]; titles: { app: string; title: string; secs: number }[]; sites: SiteRow[]; hourly: number[]; hourlyProductive: number[];
  timeline: Seg[]; topApp: string | null; peakHour: number | null; intervalSecs: number;
  current: { app: string; title: string; afk: boolean; since: number; running: boolean }; paused: boolean; enabled: boolean;
};
export type Day = { day: string; activeSecs: number; productive: number; neutral: number; distracting: number; score: number; productiveDay: boolean };
export type History = { days: Day[]; heatmap: number[][]; streak: number };
export type Goal = { id: string; target: string; kind: "goal" | "limit"; mins: number; usedMins: number; pct: number; exceeded: boolean; achieved: boolean };
export type RegApp = { app: string; exe: string; hasIcon: boolean; override: Cat | null; excluded: boolean; firstSeen: number; lastSeen: number; secs: number; cat: Cat };

export const CAT_COLOR: Record<string, string> = { productive: "#2fa36b", neutral: "#c9a227", distracting: "#e05656", afk: "color-mix(in srgb, var(--ink) 14%, transparent)", focus: "#5468e8" };
export const CAT_LABEL: Record<string, string> = { productive: "Productive", neutral: "Neutral", distracting: "Distracting", afk: "Away", focus: "Focus" };

export const fmt = (s: number) => {
  const m = Math.round(s / 60);
  if (m < 1) return s > 0 ? `${Math.max(1, Math.round(s))}s` : "0m";
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};
export const dayStart = (t = Date.now()) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
export const addDays = (t: number, n: number) => {
  const d = new Date(t);
  d.setDate(d.getDate() + n);
  return dayStart(d.getTime());
};
export const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
export const j = async <T,>(url: string, init?: RequestInit) => (await (await fetch(url, init)).json()) as T;
export const send = (url: string, method: string, body?: unknown) => fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

// ---------------------------------------------------------------- icon + favicon caches

type Maps = { icons: Record<string, string>; favicons: Record<string, string>; v: number };
let maps: Maps = { icons: {}, favicons: {}, v: 0 };
const subs = new Set<() => void>();
let iconsLoaded = 0;
const bump = (p: Partial<Maps>) => {
  maps = { ...maps, ...p, v: maps.v + 1 };
  subs.forEach((f) => f());
};

/** fetch the app-icon map (one request, cached; refreshed at most every 2 min) */
export function loadIcons(force = false) {
  if (!force && Date.now() - iconsLoaded < 120_000) return;
  iconsLoaded = Date.now();
  void j<Record<string, string>>("/api/timelens/icons")
    .then((m) => m && typeof m === "object" && bump({ icons: m }))
    .catch(() => {});
}

let favRequested = new Set<string>();
/** cached favicons, plus a one-time background fetch (Rust side, once per domain) for new ones */
export function loadFavicons(domains: string[], allowFetch: boolean) {
  void j<Record<string, string>>("/api/timelens/favicons").then((m) => m && bump({ favicons: m })).catch(() => {});
  const want = domains.filter((d) => d && !favRequested.has(d));
  if (!allowFetch || !want.length) return;
  want.forEach((d) => favRequested.add(d));
  void j<{ favicons?: Record<string, string> }>("/api/timelens/favicons/fetch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ domains: want }) })
    .then((r) => r.favicons && bump({ favicons: r.favicons }))
    .catch(() => {});
}
export function __resetIconCaches() {
  iconsLoaded = 0;
  favRequested = new Set();
}

function useMaps() {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => maps,
    () => maps,
  );
}

const PALETTE = ["#5468e8", "#2fa36b", "#e05656", "#c9a227", "#8b5cf6", "#0ea5a4", "#ef7b2d", "#db4f9c", "#3b82f6", "#64748b"];
export function hueFor(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function Letter({ name, size }: { name: string; size: number }) {
  const c = hueFor(name);
  return (
    <span
      aria-hidden
      className="tl-letter"
      data-testid="tl-letter"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.48), borderRadius: Math.round(size * 0.26), background: `color-mix(in srgb, ${c} 16%, transparent)`, color: c }}
    >
      {(name.replace(/[^\p{L}\p{N}]/gu, "")[0] ?? "?").toUpperCase()}
    </span>
  );
}

/** The real app icon (extracted from the exe on Windows), else a coloured letter avatar. */
export const AppIcon = memo(function AppIcon({ app, size = 20 }: { app: string; size?: number }) {
  const m = useMaps();
  useEffect(() => loadIcons(), []);
  if (app === "AFK") return <span className="tl-letter" aria-hidden style={{ width: size, height: size, borderRadius: Math.round(size * 0.26), background: "var(--panel2)", color: "var(--faint)", fontSize: Math.round(size * 0.5) }}>☾</span>;
  if (app === "Focus") return <Letter name="Focus" size={size} />;
  const src = m.icons[app];
  if (src) return <img src={src} alt="" aria-hidden width={size} height={size} data-testid="tl-app-icon" className="tl-icon" style={{ width: size, height: size }} draggable={false} />;
  return <Letter name={app} size={size} />;
});

export const SiteIcon = memo(function SiteIcon({ site, domain, size = 20 }: { site: string; domain: string | null; size?: number }) {
  const m = useMaps();
  const [bad, setBad] = useState(false);
  const src = domain ? m.favicons[domain] : undefined;
  if (src && !bad) return <img src={src} alt="" aria-hidden width={size} height={size} className="tl-icon" data-testid="tl-favicon" style={{ width: size, height: size, borderRadius: 4 }} onError={() => setBad(true)} draggable={false} />;
  return <Letter name={site} size={size} />;
});

export function CatChip({ cat }: { cat: string }) {
  return (
    <span className="tl-chip" style={{ color: CAT_COLOR[cat] ?? "var(--dim)", background: `color-mix(in srgb, ${CAT_COLOR[cat] ?? "var(--dim)"} 12%, transparent)` }}>
      {CAT_LABEL[cat] ?? cat}
    </span>
  );
}
