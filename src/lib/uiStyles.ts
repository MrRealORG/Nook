/**
 * Full-app UI styles — three complete looks, switchable from Settings → Appearance
 * (or the big Clean/Layout button in the title bar):
 *
 *   clean    — 1.2 default: system UI type (Segoe UI Variable on Windows), opaque surfaces,
 *              hairline borders, soft shadows, crisp lucide icons. Light + dark.
 *   nook     — the classic Nook look: tinted monochrome, pixel accents, soft glass panels
 *   pixel    — "Pixelated Soft": pastel cream/lavender, chunky 2px borders, stepped
 *              hard shadows, everything rounded and squishy — a soft pixel toy box
 *   obsidian — "Obsidian": same-to-same with the Obsidian app — near-black panels,
 *              hairline borders, flat chrome, purple accent, clean sans typography
 *
 * A UI style fully restyles the chrome (colors, borders, radii, shadows, fonts) on
 * top of whichever tint theme is selected; the tint still colors small accents.
 */

export type UiStyleId = "clean" | "nook" | "pixel" | "obsidian";

export type UiStyle = {
  id: UiStyleId;
  name: string;
  blurb: string;
  dark: boolean;
  /** 5-swatch preview strip shown on the style cards */
  ramp: [string, string, string, string, string];
  accent: string;
};

export const UI_STYLES: Record<UiStyleId, UiStyle> = {
  clean: {
    id: "clean",
    name: "Clean",
    blurb: "Modern and calm — system type, crisp icons, soft surfaces. The 1.2 default.",
    dark: false,
    ramp: ["#f7f8fa", "#e6e9ef", "#b8bfcc", "#5468e8", "#171a21"],
    accent: "#5468e8",
  },
  nook: {
    id: "nook",
    name: "Classic pixel",
    blurb: "The classic Nook look — glassy panels, pixel type, tinted monochrome.",
    dark: true,
    ramp: ["#0d0e10", "#3d4147", "#767c85", "#b4bac2", "#eef0f3"],
    accent: "#9db7d0",
  },
  pixel: {
    id: "pixel",
    name: "Pixel Soft",
    blurb: "Pastel pixel toy box — chunky borders, stepped shadows, squishy pastels.",
    dark: false,
    ramp: ["#f4effb", "#e4d9f3", "#c7b2e8", "#9a7ad6", "#453a5c"],
    accent: "#9a7ad6",
  },
  obsidian: {
    id: "obsidian",
    name: "Obsidian",
    blurb: "Same-to-same with the Obsidian app — flat black panels, purple accent, hairline borders.",
    dark: true,
    ramp: ["#1e1e1e", "#262626", "#3f3f42", "#a882ff", "#dadada"],
    accent: "#a882ff",
  },
};

export const UI_STYLE_IDS = Object.keys(UI_STYLES) as UiStyleId[];

export function isUiStyle(v: unknown): v is UiStyleId {
  return typeof v === "string" && v in UI_STYLES;
}
