/** built-in whole-app wallpapers — CSS-only backgrounds (no assets needed) */
export type WallpaperDef = {
  id: string;
  name: string;
  css: string;
  dark: boolean;
};

export const WALLPAPERS: WallpaperDef[] = [
  { id: "none", name: "None", css: "transparent", dark: true },
  { id: "aurora", name: "Aurora", css: "linear-gradient(160deg, #0c1b1e 0%, #14332e 38%, #1d5a4c 68%, #2a7d68 100%)", dark: true },
  { id: "dusk", name: "Dusk Ridge", css: "linear-gradient(180deg, #241b33 0%, #3d2a4d 45%, #6b3f56 78%, #a05a4e 100%)", dark: true },
  { id: "sunrise", name: "Pixel Sunrise", css: "linear-gradient(180deg, #2a1a3a 0%, #7a3b5e 40%, #d96a4e 72%, #ffc37a 100%)", dark: true },
  { id: "ocean", name: "Deep Ocean", css: "linear-gradient(180deg, #06121f 0%, #0b2436 50%, #12455c 100%)", dark: true },
  { id: "forest", name: "Mossy Woods", css: "linear-gradient(170deg, #0d1a10 0%, #16301c 55%, #26502c 100%)", dark: true },
  { id: "sakura", name: "Sakura Sky", css: "linear-gradient(180deg, #f7e9ef 0%, #f2d4e0 55%, #e8b9cf 100%)", dark: false },
  { id: "paper", name: "Warm Paper", css: "linear-gradient(160deg, #f7f3ea 0%, #efe6d4 60%, #e6d9c0 100%)", dark: false },
  { id: "grid", name: "Blueprint Grid", css: "repeating-linear-gradient(0deg, rgba(120,180,220,.14) 0 1px, transparent 1px 28px), repeating-linear-gradient(90deg, rgba(120,180,220,.14) 0 1px, transparent 1px 28px), linear-gradient(180deg, #10202e, #16303f)", dark: true },
  { id: "dots", name: "Dot Matrix", css: "radial-gradient(rgba(255,255,255,.10) 1.4px, transparent 1.6px) 0 0 / 22px 22px, linear-gradient(180deg, #191d24, #22272f)", dark: true },
  { id: "sunsetstrip", name: "Retro Strip", css: "repeating-linear-gradient(0deg, rgba(0,0,0,.12) 0 2px, transparent 2px 4px), linear-gradient(180deg, #3a1d4e 0%, #7a2d5e 45%, #d96a6a 80%, #ffb46a 100%)", dark: true },
  { id: "vapor", name: "Vapor Grid", css: "repeating-linear-gradient(90deg, rgba(255,110,199,.08) 0 1px, transparent 1px 34px), linear-gradient(180deg, #1a1030 0%, #3d1a4e 55%, #6e2a66 100%)", dark: true },
  { id: "leaf", name: "Leaf Lattice", css: "radial-gradient(circle at 20% 30%, rgba(168,201,138,.16), transparent 42%), radial-gradient(circle at 80% 70%, rgba(127,196,143,.13), transparent 45%), linear-gradient(180deg, #101a12, #1b2b1c)", dark: true },
];

export function wallpaperCss(id: string, img?: string): string {
  if (img) return `url(${img}) center / cover no-repeat`;
  return WALLPAPERS.find((w) => w.id === id)?.css ?? "transparent";
}
