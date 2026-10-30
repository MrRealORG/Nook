/** Which glyph family <Icon> draws: "crisp" (lucide) for the Clean/Obsidian styles, "pixel" otherwise. */
import { useSyncExternalStore } from "react";

export type IconFamily = "crisp" | "pixel";
const subs = new Set<() => void>();
let family: IconFamily = typeof document !== "undefined" && /^(clean|obsidian)$/.test(document.documentElement.dataset.ui ?? "clean") ? "crisp" : "pixel";

export function setIconFamilyForUi(ui: string) {
  const next: IconFamily = ui === "clean" || ui === "obsidian" ? "crisp" : "pixel";
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
