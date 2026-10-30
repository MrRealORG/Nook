export type ThemeId = "light" | "dark" | "graphite" | "moss" | "dusk" | "bone" | "mist" | "sunset" | "sakura" | "aurora" | "noir" | "seafoam";

export type Theme = {
  id: ThemeId;
  name: string;
  dark: boolean;
  ramp: [string, string, string, string, string];
  accent: string;
  panel: string; // opaque-ish panel colour for canvas rendering
  ink: string;
  dim: string;
  /** premium themes must be bought from the team marketplace before use */
  premium?: boolean;
};

export const THEMES: Record<ThemeId, Theme> = {
  // 1.2 defaults — clean, neutral, soft indigo accent (light + dark)
  light: { id: "light", name: "Light", dark: false, ramp: ["#1b1f27", "#4b5261", "#8b93a3", "#d9dde5", "#f7f8fa"], accent: "#5468e8", panel: "#ffffff", ink: "#171a21", dim: "#5b6372" },
  dark: { id: "dark", name: "Dark", dark: true, ramp: ["#0f1115", "#2a2f39", "#5d6472", "#a3aab7", "#eceef2"], accent: "#8b9bff", panel: "#171a20", ink: "#e8eaef", dim: "#9ba2ae" },
  graphite: { id: "graphite", name: "Graphite", dark: true, ramp: ["#0d0e10", "#3d4147", "#767c85", "#b4bac2", "#eef0f3"], accent: "#9db7d0", panel: "#16181b", ink: "#e9ebee", dim: "#9aa0a8" },
  moss: { id: "moss", name: "Moss", dark: true, ramp: ["#0b100c", "#37443a", "#728268", "#aebca3", "#eef3e8"], accent: "#bccb92", panel: "#131a15", ink: "#e3ebe0", dim: "#98a893" },
  dusk: { id: "dusk", name: "Dusk", dark: true, ramp: ["#0f0e14", "#3f3b52", "#7a7494", "#b9b3d1", "#f1eff7"], accent: "#cba5ba", panel: "#17151f", ink: "#e8e6f0", dim: "#a29fb5" },
  bone: { id: "bone", name: "Bone", dark: false, ramp: ["#2a2520", "#6b6258", "#a29789", "#d6cdbf", "#f7f3ea"], accent: "#b0714f", panel: "#f1ece1", ink: "#2a2520", dim: "#6e665b" },
  mist: { id: "mist", name: "Mist", dark: false, ramp: ["#1d2327", "#566067", "#8c9aa2", "#c3ccd1", "#f2f5f6"], accent: "#4f7d96", panel: "#eef2f3", ink: "#1d2327", dim: "#5c6870" },
  sunset: { id: "sunset", name: "Sunset", dark: true, ramp: ["#140d0c", "#4a2f28", "#8a5c48", "#c99a7a", "#f7e8d8"], accent: "#e0966a", panel: "#1d1310", ink: "#f5e9dc", dim: "#b08d78" },
  sakura: { id: "sakura", name: "Sakura", dark: false, ramp: ["#3a2430", "#7d5568", "#b18aa0", "#ddb8cb", "#f9eef4"], accent: "#c96f92", panel: "#f7e9ef", ink: "#3a2430", dim: "#836576" },
  aurora: { id: "aurora", name: "Aurora", dark: true, ramp: ["#081210", "#2a4a41", "#5f8f7f", "#a3ccbd", "#eafff7"], accent: "#7fd4b6", panel: "#10201b", ink: "#e6f7ef", dim: "#8fb5a7", premium: true },
  noir: { id: "noir", name: "Noir", dark: true, ramp: ["#0a0a0b", "#332f26", "#6f6650", "#b3a67f", "#f4ecd7"], accent: "#d4b06a", panel: "#14130f", ink: "#efe9d9", dim: "#a29a85", premium: true },
  seafoam: { id: "seafoam", name: "Seafoam", dark: false, ramp: ["#1f3835", "#4d6f68", "#83a8a0", "#bed9d2", "#f0faf7"], accent: "#2f8f78", panel: "#eef8f4", ink: "#1f3835", dim: "#5c7f77", premium: true },
};

/** Theme ids that only unlock via a marketplace purchase. */
export const PREMIUM_THEMES = (Object.values(THEMES).filter((t) => t.premium).map((t) => t.id) as ThemeId[]);

export function isPremiumTheme(id: ThemeId) {
  return !!THEMES[id].premium;
}

export const THEME_IDS = Object.keys(THEMES) as ThemeId[];

/** the 1.1 default (uiStyle "nook" + "graphite") — users still on it are moved to the 1.2 default */
export const LEGACY_DEFAULT_THEME: ThemeId = "graphite";
