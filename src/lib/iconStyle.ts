/**
 * Which glyph family <Icon> draws (1.3: chosen by the user, independent of the colour theme):
 *   "pixel" — the pixel-art set (default), "crisp" — the Clean lucide set.
 */
import { useSyncExternalStore } from "react";

export type IconStyle = "pixel" | "clean";
export type IconFamily = "crisp" | "pixel";
const subs = new Set<() => void>();
let family: IconFamily = typeof document !== "undefined" && document.documentElement.dataset.icons === "clean" ? "crisp" : "pixel";

export function setIconStyle(style: IconStyle) {
  if (typeof document !== "undefined") document.documentElement.dataset.icons = style;
  const next: IconFamily = style === "clean" ? "crisp" : "pixel";
  if (next === family) return;
  family = next;
  subs.forEach((f) => f());
}

export function useIconFamily(): IconFamily {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => family,
    () => family,
  );
}
