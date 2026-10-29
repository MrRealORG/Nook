"use client";

import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import { drawPet, makePalette, SH, SW, type Mood, type Palette, type Pose, type Species } from "@/lib/sprite";
import { useStore } from "@/lib/store";
import { THEMES } from "@/lib/themes";

/** Per-species tint: [rampOverride, accentOverride] — null = use theme colours. */
const SPECIES_PALETTES: Partial<Record<Species, { ramp?: string[]; accent: string }>> = {
  cat: { accent: "#9db7d0" },
  bunny: { ramp: ["#12100e", "#4a4038", "#8a7a6c", "#cbbfb2", "#f6f0e7"], accent: "#d8a8b8" },
  blob: { ramp: ["#0c1110", "#2e4a42", "#5f8577", "#9dc0ae", "#e8f5ec"], accent: "#8fd6c0" },
  dog: { ramp: ["#14100c", "#54402c", "#8a6c48", "#c0a074", "#f3e6d0"], accent: "#c98f5a" },
  fox: { ramp: ["#160e08", "#5c3018", "#a05a28", "#d09048", "#f8e8d8"], accent: "#e8853c" },
  panda: { ramp: ["#0f0f10", "#3c3c40", "#787886", "#b8b8c4", "#f4f4f6"], accent: "#8a9aac" },
  frog: { ramp: ["#0c1208", "#34502a", "#6a8a4c", "#a8c484", "#eef8dc"], accent: "#86c46a" },
  penguin: { ramp: ["#0c0e14", "#33394a", "#626c86", "#a2acc4", "#f0f4fa"], accent: "#e8a844" },
  ghost: { ramp: ["#0e0c14", "#3c3a52", "#74729a", "#b2b0d4", "#f2f0fc"], accent: "#a8a0e8" },
  dragon: { ramp: ["#100a10", "#4a2440", "#844868", "#c0889c", "#f8e8ec"], accent: "#e05878" },
  axolotl: { ramp: ["#140c12", "#583a52", "#98708c", "#d0a8c4", "#fbeef8"], accent: "#f088b0" },
  owl: { ramp: ["#120e0a", "#4a3c2c", "#84705a", "#c0ac90", "#f5efe4"], accent: "#d8a050" },
};

/** theme-only palette (no species tint) — used by ambient pet renderers */
export function usePalette() {
  const theme = useStore((s) => s.theme);
  return useMemo(() => {
    const t = THEMES[theme];
    return makePalette(t.ramp, t.accent);
  }, [theme]);
}

/** palette for a species — optionally overridden by a custom pet-library look (5-shade ramp + accent) */
export function useSpeciesPalette(species: Species, tint?: { ramp?: string[]; accent?: string } | null) {
  const theme = useStore((s) => s.theme);
  const rampKey = tint?.ramp?.join(",") ?? "";
  const accentKey = tint?.accent ?? "";
  return useMemo<Palette>(() => {
    const t = THEMES[theme];
    const sp = SPECIES_PALETTES[species];
    const ramp = Array.isArray(tint?.ramp) && tint!.ramp!.length === 5 ? tint!.ramp! : sp?.ramp ?? t.ramp;
    return makePalette(ramp, tint?.accent || sp?.accent || t.accent);
  }, [theme, species, rampKey, accentKey]);
}

type Props = {
  species: Species;
  /** custom palette override from the pet library — ramp (5 shades dark→light) + accent colour */
  tint?: { ramp?: string[]; accent?: string } | null;
  hat?: string;
  mood?: Mood;
  scale?: number;
  facing?: 1 | -1;
  look?: { x: number; y: number };
  getPose?: () => Partial<Pose>;
  fps?: number;
  className?: string;
  style?: CSSProperties;
};

export function PetView({ species, tint, hat = "none", mood = "idle", scale = 3, facing = 1, look, getPose, fps = 12, className, style }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const pal = useSpeciesPalette(species, tint);
  const live = useRef({ species, hat, mood, facing, look, getPose, pal });
  useEffect(() => {
    live.current = { species, hat, mood, facing, look, getPose, pal };
  });

  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const t0 = performance.now() + Math.random() * 3000;
    let raf = 0;
    let last = -1e9;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden || now - last < 1000 / fps) return;
      last = now;
      const L = live.current;
      const t = (now - t0) / 1000;
      const x = L.getPose?.() ?? {};
      drawPet(ctx, L.species, { mood: x.mood ?? L.mood, t, facing: x.facing ?? L.facing, look: x.look ?? L.look, blink: t % 3.8 < 0.14 }, L.pal, L.hat);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [fps]);

  return <canvas ref={ref} width={SW} height={SH} className={`pixelated ${className ?? ""}`} style={{ width: SW * scale, height: SH * scale, ...style }} />;
}
