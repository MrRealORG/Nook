/**
 * "Follow system" theme: when on, Nook switches between a chosen light and dark theme as the OS
 * (Windows "Choose your mode", macOS Appearance, GTK) flips `prefers-color-scheme`.
 * Kept in its own localStorage key so it never fights the main prefs blob.
 */
import { useStore } from "@/lib/store";
import { THEMES, isPremiumTheme, type ThemeId } from "@/lib/themes";

export type FollowCfg = { on: boolean; light: ThemeId; dark: ThemeId };
const KEY = "nook:themeFollow";
const DEFAULTS: FollowCfg = { on: false, light: "light", dark: "dark" };
const listeners = new Set<() => void>();

export function getFollow(): FollowCfg {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<FollowCfg>;
    return {
      on: !!raw.on,
      light: raw.light && THEMES[raw.light] && !THEMES[raw.light].dark ? raw.light : DEFAULTS.light,
      dark: raw.dark && THEMES[raw.dark]?.dark ? raw.dark : DEFAULTS.dark,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

const mq = () => (typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null);
export const systemIsDark = () => !!mq()?.matches;

export function applySystemTheme() {
  const cfg = getFollow();
  if (!cfg.on) return;
  let id = systemIsDark() ? cfg.dark : cfg.light;
  const s = useStore.getState();
  if (isPremiumTheme(id) && !s.pet.owned.includes(id)) id = systemIsDark() ? DEFAULTS.dark : DEFAULTS.light;
  if (s.theme !== id) {
    document.documentElement.dataset.theme = id;
    s.set({ theme: id });
  }
}

export function setFollow(p: Partial<FollowCfg>) {
  const next = { ...getFollow(), ...p };
  localStorage.setItem(KEY, JSON.stringify(next));
  applySystemTheme();
  listeners.forEach((f) => f());
}

/** A manual theme pick while following the system updates that mode's slot instead of being overridden. */
export function rememberThemeChoice(id: ThemeId) {
  const cfg = getFollow();
  if (!cfg.on) return;
  setFollow(THEMES[id].dark ? { dark: id } : { light: id });
}

export function onFollowChange(f: () => void) {
  listeners.add(f);
  return () => listeners.delete(f);
}

let installed = false;
export function installSystemTheme() {
  if (installed) return;
  installed = true;
  applySystemTheme();
  mq()?.addEventListener?.("change", applySystemTheme);
}
