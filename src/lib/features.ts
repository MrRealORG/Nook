/**
 * Feature switches (1.3) — onboarding's "Features" step and Settings ▸ Features.
 *
 * A feature that is OFF is gone everywhere, not just hidden:
 *  - its views leave the sidebar, the ribbon, the command palette and the Alt shortcuts
 *    (a direct `setView` to it falls back to Notes), so its lazy chunk is never loaded;
 *  - its background work stops: the Timelens sampler is disabled in Rust, the marketplace
 *    watcher stops polling, the pet/nag loops never mount, the rule engine and the in-app
 *    usage tracker skip their ticks, the desktop widget closes and drops its tiles.
 * Everything is reversible — nothing is deleted.
 */
import type { IconName } from "@/components/icons";
import type { View } from "@/lib/store";

export type FeatureId =
  | "timelens" | "pet" | "widget" | "chat" | "arcade" | "team" | "market" | "graph" | "canvas"
  | "tasks" | "journal" | "focus" | "rules" | "reminders" | "backups" | "activity";

export type FeatureDef = { id: FeatureId; label: string; desc: string; icon: IconName; views: View[]; group: "core" | "time" | "fun" | "system" };

export const FEATURES: FeatureDef[] = [
  { id: "tasks", label: "Tasks & Kanban", desc: "Todo lists, a kanban board and checklists synced from notes", icon: "tasklist", views: ["tasks"], group: "core" },
  { id: "journal", label: "Journal", desc: "A calendar of daily notes and what you did each day", icon: "calendar", views: ["calendar"], group: "core" },
  { id: "chat", label: "AI chat", desc: "Chat with your notes — offline brain or your own model", icon: "sparkles", views: ["chat"], group: "core" },
  { id: "graph", label: "Graph", desc: "See how your notes link together", icon: "algorithm", views: ["graph"], group: "core" },
  { id: "canvas", label: "Canvas", desc: "An infinite whiteboard for cards, notes and arrows", icon: "shapes", views: ["canvas"], group: "core" },
  { id: "focus", label: "Focus / Pomodoro", desc: "A focus timer with breaks and a weekly chart", icon: "hourglass", views: ["focus"], group: "time" },
  { id: "timelens", label: "Timelens", desc: "Automatic, private time tracking of apps and sites", icon: "gauge", views: ["timelens"], group: "time" },
  { id: "activity", label: "Activity", desc: "In-app usage stats and the manual app dock", icon: "activity", views: ["activity"], group: "time" },
  { id: "rules", label: "Rules Shield", desc: "Block or limit distracting apps, quiet hours", icon: "shield", views: ["rules"], group: "time" },
  { id: "reminders", label: "Reminders", desc: "Task reminders and due-date notifications", icon: "bell", views: [], group: "time" },
  { id: "pet", label: "Pet companion", desc: "Mochi roams, chats, cheers you on and lives in the den", icon: "dog", views: ["den"], group: "fun" },
  { id: "arcade", label: "Arcade", desc: "Pixel mini-games that pay out coins and XP", icon: "gamepad", views: ["arcade"], group: "fun" },
  { id: "market", label: "Marketplace", desc: "Trade themes, packs and pets with coins", icon: "coins", views: ["market"], group: "fun" },
  { id: "team", label: "Team room", desc: "Live shared room for notes and chat on your LAN", icon: "message-text", views: ["team"], group: "fun" },
  { id: "widget", label: "Desktop widget", desc: "A floating pill with capture, tasks and Timelens", icon: "app-windows", views: [], group: "system" },
  { id: "backups", label: "Backups", desc: "Automatic daily vault backups", icon: "archive", views: [], group: "system" },
];

export const FEATURE_IDS = FEATURES.map((f) => f.id);
export type Features = Record<FeatureId, boolean>;
export const ALL_ON: Features = Object.fromEntries(FEATURE_IDS.map((id) => [id, true])) as Features;

export function normFeatures(raw: unknown): Features {
  const out = { ...ALL_ON };
  if (raw && typeof raw === "object") for (const id of FEATURE_IDS) if ((raw as Record<string, unknown>)[id] === false) out[id] = false;
  return out;
}

const VIEW_FEATURE: Partial<Record<View, FeatureId>> = Object.fromEntries(FEATURES.flatMap((f) => f.views.map((v) => [v, f.id])));

/** the feature that owns a view (notes and settings belong to none and are always on) */
export const featureOfView = (v: View): FeatureId | undefined => VIEW_FEATURE[v];
export const viewEnabled = (f: Features, v: View) => {
  const id = featureOfView(v);
  return !id || f[id] !== false;
};

/** widget tile → the feature it belongs to (the widget reads features from the shared prefs) */
export const TILE_FEATURE: Record<string, FeatureId> = { tasks: "tasks", timelens: "timelens", focus: "focus", ai: "chat", pet: "pet" };

/** read features straight from persisted prefs (for the widget window, which has no store) */
export function featuresFromPrefs(): Features {
  try {
    return normFeatures(JSON.parse(localStorage.getItem("nook:prefs") ?? "{}").features);
  } catch {
    return { ...ALL_ON };
  }
}
