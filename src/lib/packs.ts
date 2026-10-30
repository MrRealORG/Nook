
/**
 * Packs studio — 38 icon packs + 24 font packs, plus drag-&-drop .zip import.
 *
 * Icon packs are style transforms over the app's pixel icon set (38 radically distinct
 * treatments: outline, neon, duotone, sticker, gradients, emoji swaps, tiles, scanlines,
 * turbulence wobble, photographic lamps…). Imported zips containing SVGs become custom
 * icon packs keyed by file name; zips with font files register real FontFaces; zips with
 * images become wallpaper packs; nook-games JSON zips feed the arcade importer.
 * The "Icon maker" dialog (IconMaker.tsx) builds a persistent custom pack (MAKER_PACK_ID)
 * out of tuned single icons via the upsertMakerIcon/removeMakerIcon helpers below.
 */

import { unzipSync, zipSync, strToU8 } from "fflate";
import { create } from "zustand";
import type { IconName } from "@/components/icons";

// ---------- types ----------
export type IconPackStyle = {
  stroke?: boolean; // render as outline instead of fill
  strokeWidth?: number;
  dash?: boolean; // dashed outline
  opacity?: number;
  rotate?: number; // deg
  scale?: number;
  skewX?: number; // deg lean for fake isometric depth
  stretchY?: number; // vertical squash (paired with skewX)
  glow?: boolean;
  shadow?: boolean;
  shadowColor?: string; // colored drop shadow (defaults to black)
  rotateJitter?: number; // deterministic per-icon ±deg tilt (sticker-sheet feel)
  sticker?: boolean; // white cut-line behind the glyph
  invert?: boolean; // panel-colored glyph with ink outline
  filter?: string; // css filter on the svg
  gradient?: [string, string]; // two-tone gradient fill
  gradientId?: string;
  gradientHard?: boolean; // crisp 50/50 two-tone split (origami fold)
  outline?: string; // contrasting outline stroke around the fill (candy/emboss)
  outlineWidth?: number;
  crisp?: boolean; // keep crispEdges (pixel look)
  tile?: { bg: string; fg: string; radius?: number }; // filled rounded-square tile behind the glyph
  lamp?: string; // radial "photographic" light backdrop behind outline glyphs
  scanlines?: boolean; // CRT scanline overlay on top of the glyph
  sketchWobble?: boolean; // feTurbulence displacement for hand-drawn wobble
  emoji?: Partial<Record<IconName, string>>; // swap the SVG for an emoji glyph entirely
};

export type IconPack = {
  id: string;
  name: string;
  blurb: string;
  builtin: true;
  style: IconPackStyle;
};

export type FontPack = {
  id: string;
  name: string;
  css: string;
  note: string;
  builtin: true;
  cap?: "sans" | "serif" | "mono" | "display" | "script" | "pixel";
};

export type CustomPack = {
  id: string;
  kind: "icons" | "fonts" | "wallpapers";
  name: string;
  blurb: string;
  preview?: string; // dataURL
  createdAt: number;
  icons?: Record<string, string>; // icon name → svg dataURL (custom icon packs)
  fonts?: { name: string; dataURL: string }[]; // custom font packs
  wallpapers?: { name: string; dataURL: string }[];
};

export type PackKind = CustomPack["kind"];

// ---------- emoji render path (pack "emoji") ----------
export const EMOJI_MAP: Partial<Record<IconName, string>> = {
  notes: "📝", note: "📄", "sticky-note": "🗒️", "file-text": "📃", notebook: "📒", book: "📕", "book-open": "📖", library: "📚",
  bookmark: "🔖", "bulletlist": "📋", tasklist: "🗒️", "quote-text-inline": "❝", heading: "🔠", type: "🔤", "text-colums": "📰",
  search: "🔍", "zoom-in": "🔎", "zoom-out": "🔍", plus: "➕", minus: "➖", close: "✖️", expand: "⬌", move: "✥",
  pencil: "✏️", "pen-ruler": "📐", "magic-edit": "🪄", wand: "🪄", sparkles: "✨", sparkle: "⭐", star: "🌟", heart: "❤️",
  zap: "⚡", fire: "🔥", leaf: "🍃", moon: "🌙", "moon-star": "🌘", sun: "☀️", "sun-snow": "⛅", cloud: "☁️", waves: "🌊",
  coffee: "☕", cake: "🎂", gift: "🎁", bell: "🔔", calendar: "📅", clock: "🕒", hourglass: "⏳", gauge: "🎚️",
  sliders: "🎛️", "sliders-h": "🔧", palette: "🎨", image: "🖼️", monitor: "🖥️", "app-windows": "🪟", keyboard: "⌨️", mouse: "🖱️",
  terminal: "💻", cpu: "🧠", database: "🗄️", globe: "🌍", "map-pin": "📍", flag: "🚩", target: "🎯", trophy: "🏆",
  crown: "👑", coins: "🪙", gamepad: "🎮", play: "▶️", pause: "⏸️", stop: "⏹️", reload: "🔄", refresh: "🔁",
  undo: "↩️", redo: "↪️", check: "✅", "check-double": "☑️", checkbox: "🔲", "checkbox-on": "☑️", user: "👤", "robot-face": "🤖",
  dog: "🐶", fish: "🐟", "wave-hand": "👋", hand: "✋", pointer: "👆", eye: "👁️", mic: "🎤", bug: "🐛",
  lock: "🔒", unlock: "🔓", shield: "🛡️", "shield-on": "🛡️", alert: "⚠️", magnet: "🧲", hash: "#️⃣", label: "🏷️",
  logs: "🧾", "message-text": "💬", send: "📨", inbox: "📥", archive: "🗃️", folder: "📁", "folder-plus": "🗂️", trash: "🗑️",
  save: "💾", copy: "📋", cut: "✂️", paperclip: "📎", link: "🔗", download: "⬇️", upload: "⬆️", "external-arrow": "↗️",
  home: "🏠", circle: "⭕", block: "🚫", shirt: "👕", algorithm: "🧮", shapes: "🔷", lightbulb: "💡", chart: "📊",
  activity: "📈", "google-drive": "🗂️", code: "⌨️", grid: "▦", layout: "🪟", "at": "📧",
};

// ---------- built-in icon packs (38, all visually distinct) ----------
export const ICON_PACKS: IconPack[] = [
  { id: "pixel", name: "Pixel Classic", blurb: "The original crisp 24px grid", builtin: true, style: { crisp: true } },
  { id: "outline", name: "Fine Outline", blurb: "Light 1.5px rounded strokes", builtin: true, style: { stroke: true, strokeWidth: 1.5 } },
  { id: "boldline", name: "Bold Line", blurb: "Chunky confident strokes", builtin: true, style: { stroke: true, strokeWidth: 2.4 } },
  { id: "heavystroke", name: "Marker", blurb: "Thick 3px hand-marker feel", builtin: true, style: { stroke: true, strokeWidth: 3 } },
  { id: "duotone", name: "Duotone Fade", blurb: "Accent-to-transparent gradient", builtin: true, style: { gradient: ["var(--accent)", "color-mix(in srgb, var(--accent) 18%, transparent)"], gradientId: "pk-duo" } },
  { id: "neon", name: "Neon Glow", blurb: "Saturated with a soft glow", builtin: true, style: { glow: true, filter: "saturate(1.6) brightness(1.15)" } },
  { id: "pastel", name: "Pastel Wash", blurb: "Soft, low-contrast, friendly", builtin: true, style: { opacity: 0.72, filter: "saturate(0.75)" } },
  { id: "mono", name: "Ink Mono", blurb: "Flat pure-ink silhouettes", builtin: true, style: { opacity: 0.86, filter: "contrast(1.2) saturate(0)" } },
  { id: "blueprint", name: "Blueprint", blurb: "Schematic cyan linework", builtin: true, style: { stroke: true, strokeWidth: 1.4, filter: "hue-rotate(165deg) saturate(1.5)", dash: true } },
  { id: "sunset", name: "Sunset Pop", blurb: "Orange-pink gradient fill", builtin: true, style: { gradient: ["#ff9a62", "#e5609c"], gradientId: "pk-sunset" } },
  { id: "forest", name: "Forest Floor", blurb: "Deep green gradient", builtin: true, style: { gradient: ["#5d8a58", "#a8c98a"], gradientId: "pk-forest" } },
  { id: "bubble", name: "Bubblegum", blurb: "Rounded, scaled-down, cute", builtin: true, style: { stroke: true, strokeWidth: 2, scale: 0.86, opacity: 0.9 } },
  { id: "sketch", name: "Sketchpad", blurb: "Dashed pencil outline", builtin: true, style: { stroke: true, strokeWidth: 1.2, dash: true } },
  { id: "ghost", name: "Ghost Set", blurb: "Barely-there translucent", builtin: true, style: { opacity: 0.32 } },
  { id: "crimson", name: "Crimson", blurb: "Bold red-tinted glyphs", builtin: true, style: { filter: "hue-rotate(-35deg) saturate(1.5)" } },
  { id: "gold", name: "Golden Hoard", blurb: "Amber glow, dragon approved", builtin: true, style: { glow: true, filter: "hue-rotate(8deg) saturate(1.7) brightness(1.1)" } },
  { id: "mint", name: "Mint Chip", blurb: "Cool mint tint", builtin: true, style: { filter: "hue-rotate(95deg) saturate(0.9)", opacity: 0.92 } },
  { id: "tilt", name: "Off-Axis", blurb: "Everything leans −8°", builtin: true, style: { rotate: -8 } },
  { id: "pop", name: "Pop Scale", blurb: "Big, bold, drop-shadowed", builtin: true, style: { scale: 1.14, shadow: true } },
  { id: "sticker", name: "Sticker Sheet", blurb: "White cut-line behind glyphs", builtin: true, style: { sticker: true } },
  { id: "invert", name: "Blueberry Invert", blurb: "Panel-filled with ink outline", builtin: true, style: { invert: true } },
  { id: "vaporwave", name: "Vaporwave", blurb: "Pink-to-cyan dreamscape", builtin: true, style: { gradient: ["#ff6ec7", "#4de3e0"], gradientId: "pk-vapor", glow: true } },
  { id: "vintage", name: "Sepia Print", blurb: "Aged-paper warmth", builtin: true, style: { filter: "sepia(0.65) saturate(0.85)", opacity: 0.9 } },
  { id: "micro", name: "Miniature", blurb: "Tiny, precise, adorable", builtin: true, style: { scale: 0.72 } },
  // ---- round 2: radically different render paths (emoji, tiles, scanlines, wobble, lamps) ----
  { id: "emoji", name: "Emoji", blurb: "Real emoji swap in for the pixel glyphs", builtin: true, style: { emoji: EMOJI_MAP } },
  { id: "sticker3d", name: "Sticker 3D", blurb: "Thick cutline, candy shadow, every sticker tilts", builtin: true, style: { sticker: true, shadow: true, shadowColor: "rgba(230,80,140,0.5)", rotateJitter: 5, scale: 1.05 } },
  { id: "isometric", name: "Isometric", blurb: "Everything leans into fake 3D depth", builtin: true, style: { skewX: -16, rotate: -9, stretchY: 0.94, scale: 0.9, filter: "saturate(1.25) contrast(1.08)" } },
  { id: "tile", name: "Inverted Tile", blurb: "Glyphs knocked out of dark rounded tiles", builtin: true, style: { tile: { bg: "#20232b", fg: "#eef0f4", radius: 6 } } },
  { id: "candy", name: "Candy", blurb: "Saturated duotone with a white sugar stroke", builtin: true, style: { gradient: ["#ff3d7f", "#ffb03a"], gradientId: "pk-candy", outline: "#ffffff", outlineWidth: 1.9, filter: "saturate(1.5) brightness(1.06)" } },
  { id: "origami", name: "Origami", blurb: "Hard two-tone fold, crisp paper edges", builtin: true, style: { gradient: ["#d94f3d", "#f2a33c"], gradientId: "pk-origami", gradientHard: true, filter: "contrast(1.12) saturate(1.15)" } },
  { id: "sketchy", name: "Sketchy", blurb: "Hand-drawn wobble — turbulence displacement", builtin: true, style: { stroke: true, strokeWidth: 1.25, sketchWobble: true } },
  { id: "blueprint-tile", name: "Blueprint Tile", blurb: "Dashed white drafting lines on deep blue", builtin: true, style: { stroke: true, strokeWidth: 1.4, dash: true, tile: { bg: "#123a6e", fg: "#eaf3ff", radius: 5 } } },
  { id: "neonsign", name: "Neon Sign", blurb: "Multi-layer tube glow, street-bar pink", builtin: true, style: { stroke: true, strokeWidth: 1.5, filter: "drop-shadow(0 0 1.2px rgba(255,215,236,.95)) drop-shadow(0 0 4px rgba(255,77,182,.8)) drop-shadow(0 0 9px rgba(255,45,149,.5))" } },
  { id: "emboss", name: "Gold Emboss", blurb: "Gold gradient, dark engraving, lifted shadow", builtin: true, style: { gradient: ["#f8e08e", "#b8860b"], gradientId: "pk-emboss", outline: "#4a3407", outlineWidth: 1.1, shadow: true, filter: "saturate(1.35) brightness(1.05)" } },
  { id: "vaporgrid", name: "Vaporwave Grid", blurb: "Magenta-cyan wash under CRT scanlines", builtin: true, style: { gradient: ["#ff6ec7", "#26d9e3"], gradientId: "pk-vaporgrid", scanlines: true, filter: "saturate(1.35)" } },
  { id: "chalk", name: "Chalk", blurb: "Rough white chalk on a slate board", builtin: true, style: { stroke: true, strokeWidth: 1.6, tile: { bg: "#33403c", fg: "#f3f6f0", radius: 7 }, sketchWobble: true } },
  { id: "minimono", name: "Mini Mono", blurb: "Hairline strokes, tiny footprint, wide-tracked energy", builtin: true, style: { stroke: true, strokeWidth: 0.9, scale: 0.78, opacity: 0.85 } },
  { id: "lamp", name: "Photographic", blurb: "Outline glyphs lit by a warm studio lamp", builtin: true, style: { stroke: true, strokeWidth: 1.5, lamp: "#ffd9a0", scale: 0.8 } },
];

export const ICON_PACK_IDS = ICON_PACKS.map((p) => p.id);
export const DEFAULT_ICON_PACK = "pixel";

// ---------- built-in font packs (24) ----------
export const FONT_PACKS: FontPack[] = [
  { id: "nook", name: "Nook Sans", css: '-apple-system, "Segoe UI", system-ui, sans-serif', note: "the classic — clean & soft", builtin: true, cap: "sans" },
  { id: "pixel", name: "Pixel Arcade", css: "var(--f-pixel), ui-monospace, monospace", note: "full arcade mode", builtin: true, cap: "pixel" },
  { id: "silk", name: "Silkscreen", css: "var(--f-silk), ui-monospace, monospace", note: "chunky 8-bit labels", builtin: true, cap: "pixel" },
  { id: "bookish", name: "Bookish Serif", css: 'Georgia, "Iowan Old Style", "Times New Roman", serif', note: "long reading sessions", builtin: true, cap: "serif" },
  { id: "terminal", name: "Terminal Mono", css: '"Cascadia Code", "SF Mono", Consolas, monospace', note: "hacker vibes", builtin: true, cap: "mono" },
  { id: "round", name: "Comic Round", css: '"Comic Sans MS", "Chalkboard SE", "Segoe UI", sans-serif', note: "soft & friendly", builtin: true, cap: "script" },
  { id: "palatino", name: "Palatino", css: 'Palatino, "Palatino Linotype", "Book Antiqua", Georgia, serif', note: "renaissance bookface", builtin: true, cap: "serif" },
  { id: "garamond", name: "Garamond", css: 'Garamond, "Apple Garamond", "EB Garamond", serif', note: "old-world elegance", builtin: true, cap: "serif" },
  { id: "baskerville", name: "Baskerville", css: 'Baskerville, "Baskerville Old Face", "Times New Roman", serif', note: "crisp enlightenment", builtin: true, cap: "serif" },
  { id: "didot", name: "Didot", css: 'Didot, "Bodoni MT", "Bodoni 72", serif', note: "fashion-magazine drama", builtin: true, cap: "serif" },
  { id: "courier", name: "Courier Prime", css: '"Courier New", Courier, monospace', note: "typewriter scripts", builtin: true, cap: "mono" },
  { id: "menlo", name: "Menlo Code", css: 'Menlo, Monaco, "Lucida Console", monospace', note: "macOS dev classic", builtin: true, cap: "mono" },
  { id: "impact", name: "Impact", css: 'Impact, "Haettenschweiler", "Arial Narrow Bold", sans-serif', note: "MEME ENERGY", builtin: true, cap: "display" },
  { id: "black", name: "Arial Black", css: '"Arial Black", "Arial Bold", Gadget, sans-serif', note: "heavy poster weight", builtin: true, cap: "display" },
  { id: "verdana", name: "Verdana", css: "Verdana, Geneva, sans-serif", note: "screen-legibility king", builtin: true, cap: "sans" },
  { id: "tahoma", name: "Tahoma", css: "Tahoma, Verdana, sans-serif", note: "compact UI workhorse", builtin: true, cap: "sans" },
  { id: "trebuchet", name: "Trebuchet", css: '"Trebuchet MS", "Lucida Grande", sans-serif', note: "friendly web 1.0", builtin: true, cap: "sans" },
  { id: "optima", name: "Optima", css: 'Optima, Candara, "Segoe UI", sans-serif', note: "humanist flared stems", builtin: true, cap: "sans" },
  { id: "futura", name: "Futura", css: 'Futura, "Century Gothic", "Jost", sans-serif', note: "geometric bauhaus", builtin: true, cap: "sans" },
  { id: "rockwell", name: "Rockwell Slab", css: 'Rockwell, "Roboto Slab", "Courier Bold", serif', note: "sturdy slab serif", builtin: true, cap: "display" },
  { id: "copperplate", name: "Copperplate", css: 'Copperplate, "Copperplate Gothic Light", "Segoe UI", sans-serif', note: "engraved plaques", builtin: true, cap: "display" },
  { id: "chalk", name: "Chalkboard", css: '"Chalkboard SE", "Comic Sans MS", cursive', note: "classroom doodles", builtin: true, cap: "script" },
  { id: "marker", name: "Marker Felt", css: '"Marker Felt", "Comic Sans MS", cursive', note: "handwritten to-dos", builtin: true, cap: "script" },
  { id: "brush", name: "Brush Script", css: '"Brush Script MT", "Snell Roundhand", cursive', note: "signed with a flourish", builtin: true, cap: "script" },
  { id: "papyrus", name: "Papyrus", css: 'Papyrus, "Segoe Print", cursive', note: "ancient scrolls ahoy", builtin: true, cap: "script" },
];

export const FONT_PACK_IDS = FONT_PACKS.map((p) => p.id);
export const DEFAULT_FONT_PACK = "nook";

// ---------- pack store (tiny, isolated so Icon stays cheap) ----------
type PackState = {
  iconPack: string;
  fontPack: string;
  customPacks: CustomPack[]; // metadata + full data (local app, fine)
  setIconPack: (id: string) => void;
  setFontPack: (id: string) => void;
  upsertPack: (p: CustomPack) => void;
  removePack: (id: string) => void;
  setPacks: (list: CustomPack[]) => void;
};

export const usePackStore = create<PackState>()((set) => ({
  iconPack: DEFAULT_ICON_PACK,
  fontPack: DEFAULT_FONT_PACK,
  customPacks: [],
  setIconPack: (id) => set({ iconPack: id }),
  setFontPack: (id) => set({ fontPack: id }),
  upsertPack: (p) => set((s) => ({ customPacks: [...s.customPacks.filter((x) => x.id !== p.id), p] })),
  removePack: (id) => set((s) => ({ customPacks: s.customPacks.filter((x) => x.id !== id) })),
  setPacks: (list) => set({ customPacks: list }),
}));

/** the active icon pack for rendering — subscription-free read for hot paths */
export function activeIconPack(): IconPack | null {
  const id = usePackStore.getState().iconPack;
  if (id === DEFAULT_ICON_PACK) return null;
  return ICON_PACKS.find((p) => p.id === id) ?? null;
}

/** custom icon map for the active custom pack (svg name → dataURL), or null */
export function activeCustomIcons(): Record<string, string> | null {
  const s = usePackStore.getState();
  if (!s.iconPack.startsWith("cst-")) return null;
  return s.customPacks.find((p) => p.id === s.iconPack)?.icons ?? null;
}

// ---------- font application ----------
let registeredFonts = new Set<string>();

function injectFontCss(id: string, css: string) {
  let el = document.getElementById("pack-font-style") as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = "pack-font-style";
    document.head.appendChild(el);
  }
  const rule = `html[data-font="${id}"] body, html[data-font="${id}"] button, html[data-font="${id}"] input, html[data-font="${id}"] textarea { font-family: ${css}; }\nhtml[data-font="${id}"] .pixel-font, html[data-font="${id}"] h1, html[data-font="${id}"] h2, html[data-font="${id}"] h3 { font-family: ${css}; }`;
  const parts = (el.textContent ?? "").split("/*--pack-rule--*/").filter(Boolean);
  const kept = parts.filter((r) => !r.includes(`html[data-font="${id}"]`));
  el.textContent = [...kept, rule].join("/*--pack-rule--*/");
}

/** apply a font pack: registers FontFaces for custom packs and flips data-font */
export function applyFontPack(id: string) {
  const built = FONT_PACKS.find((p) => p.id === id);
  if (built) {
    document.documentElement.dataset.font = built.id;
    usePackStore.getState().setFontPack(built.id);
    return;
  }
  const custom = usePackStore.getState().customPacks.find((p) => p.id === id && p.kind === "fonts");
  if (!custom?.fonts?.length) return;
  const fam = `pkf-${custom.id.replace(/[^a-z0-9-]/gi, "")}`;
  for (const f of custom.fonts) {
    const key = `${fam}:${f.name}`;
    if (!registeredFonts.has(key)) {
      try {
        const face = new FontFace(fam, `url(${f.dataURL})`);
        void face.load().then((loaded) => {
          document.fonts.add(loaded);
          registeredFonts.add(key);
        });
      } catch {}
    }
  }
  injectFontCss(id, `"${fam}"`);
  document.documentElement.dataset.font = id;
  usePackStore.getState().setFontPack(id);
}

// ---------- persistence (server-side via /api/packs, mirrored to localStorage) ----------
const LS_KEY = "nook:packs";

export function loadPacksFromLocal() {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_KEY) ?? "[]") as CustomPack[];
    if (Array.isArray(arr)) usePackStore.getState().setPacks(arr.filter((p) => p && p.id && p.kind));
  } catch {}
  try {
    const prefs = JSON.parse(localStorage.getItem("nook:prefs") ?? "{}");
    const icon = prefs.iconPack as string | undefined;
    const font = prefs.fontPack as string | undefined;
    if (icon) usePackStore.getState().setIconPack(icon);
    if (font) {
      usePackStore.getState().setFontPack(font);
      document.documentElement.dataset.font = font;
    }
  } catch {}
}

export function persistPackPrefs() {
  try {
    const prefs = JSON.parse(localStorage.getItem("nook:prefs") ?? "{}");
    localStorage.setItem("nook:prefs", JSON.stringify({ ...prefs, iconPack: usePackStore.getState().iconPack, fontPack: usePackStore.getState().fontPack }));
  } catch {}
}

export async function syncPacksFromServer() {
  try {
    const r = await fetch("/api/packs");
    const rows = (await r.json()) as CustomPack[];
    if (Array.isArray(rows) && rows.length) {
      usePackStore.getState().setPacks(rows);
      localStorage.setItem(LS_KEY, JSON.stringify(rows));
    }
  } catch {}
}

export async function savePackToServer(p: CustomPack) {
  usePackStore.getState().upsertPack(p);
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(usePackStore.getState().customPacks));
  } catch {}
  try {
    await fetch("/api/packs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p) });
  } catch {}
}

export async function deletePack(id: string) {
  usePackStore.getState().removePack(id);
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(usePackStore.getState().customPacks));
  } catch {}
  try {
    await fetch(`/api/packs/${id}`, { method: "DELETE" });
  } catch {}
}

// ---------- icon maker (persistent custom pack built by the IconMaker dialog) ----------
export const MAKER_PACK_ID = "cst-iconmaker";
export const DEFAULT_MAKER_PACK_NAME = "My Icon Pack";

/** the icon-maker custom pack, if it exists yet */
export function makerPack(): CustomPack | null {
  return usePackStore.getState().customPacks.find((p) => p.id === MAKER_PACK_ID) ?? null;
}

/** insert or replace one tuned icon (icon id → svg/png dataURL) in the maker pack */
export async function upsertMakerIcon(icon: string, dataURL: string, opts?: { name?: string }): Promise<void> {
  const prev = makerPack();
  const icons = { ...(prev?.icons ?? {}), [icon]: dataURL };
  const pack: CustomPack = {
    id: MAKER_PACK_ID,
    kind: "icons",
    name: opts?.name?.trim() || prev?.name || DEFAULT_MAKER_PACK_NAME,
    blurb: prev?.blurb || "Made in the Nook icon maker",
    preview: Object.values(icons)[0],
    createdAt: prev?.createdAt ?? Date.now(),
    icons,
  };
  await savePackToServer(pack);
}

/** drop one icon from the maker pack; deletes the pack entirely when it runs empty */
export async function removeMakerIcon(icon: string): Promise<void> {
  const prev = makerPack();
  if (!prev?.icons || !(icon in prev.icons)) return;
  const icons = { ...prev.icons };
  delete icons[icon];
  if (Object.keys(icons).length === 0) {
    await deletePack(MAKER_PACK_ID);
    return;
  }
  await savePackToServer({ ...prev, icons, preview: Object.values(icons)[0] });
}

// ---------- zip import ----------
const b64 = (buf: Uint8Array): string => {
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode(...buf.subarray(i, i + CH));
  return `data:application/octet-stream;base64,${btoa(bin)}`;
};

const imgB64 = (buf: Uint8Array, mime: string): string => `data:${mime};base64,${btoa(String.fromCharCode(...Array.from(buf.length > 2_000_000 ? buf.subarray(0, 2_000_000) : buf)))}`;

function classify(name: string): "svg" | "font" | "image" | "json" | "other" {
  const n = name.toLowerCase();
  if (n.endsWith(".svg")) return "svg";
  if (n.endsWith(".ttf") || n.endsWith(".otf") || n.endsWith(".woff") || n.endsWith(".woff2")) return "font";
  if (n.endsWith(".png") || n.endsWith(".jpg") || n.endsWith(".jpeg") || n.endsWith(".webp") || n.endsWith(".gif")) return "image";
  if (n.endsWith(".json")) return "json";
  return "other";
}

export type ImportResult = { pack: CustomPack; games?: unknown[] };

/**
 * Import a .zip pack. Detects the kind from contents:
 *  - *.svg files        → custom icon pack (file names map to icon ids)
 *  - *.ttf/otf/woff     → custom font pack (FontFace registered on apply)
 *  - *.png/jpg images   → wallpaper pack
 *  - nook-games JSON    → { games } returned for the arcade importer
 */
export async function importPackZip(file: File): Promise<ImportResult> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(buf);
  } catch {
    throw new Error("Not a readable .zip file");
  }
  const entries = Object.entries(files).filter(([n]) => !n.startsWith("__MACOSX") && !n.split("/").pop()?.startsWith("."));
  if (!entries.length) throw new Error("The zip is empty");

  // manifest (optional)
  let manifest: { name?: string; blurb?: string } = {};
  const manifestEntry = entries.find(([n]) => n.toLowerCase().endsWith("manifest.json"));
  if (manifestEntry) {
    try {
      manifest = JSON.parse(new TextDecoder().decode(manifestEntry[1])) as { name?: string; blurb?: string };
    } catch {}
  }

  const svgs = entries.filter(([n]) => classify(n) === "svg");
  const fonts = entries.filter(([n]) => classify(n) === "font");
  const images = entries.filter(([n]) => classify(n) === "image");
  const jsons = entries.filter(([n]) => classify(n) === "json");

  // games pack?
  for (const [n, data] of jsons) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(data)) as unknown;
      const games = extractGames(parsed);
      if (games.length) {
        return { pack: { id: `cst-${crypto.randomUUID()}`, kind: "icons", name: manifest.name ?? file.name.replace(/\.zip$/i, ""), blurb: manifest.blurb ?? "", createdAt: Date.now() }, games };
      }
    } catch {}
  }

  const packName = manifest.name?.trim() || file.name.replace(/\.zip$/i, "").replace(/[-_]+/g, " ") || "Imported pack";
  const packId = `cst-${crypto.randomUUID()}`;
  const base = (n: string) => (n.split("/").pop() ?? n).replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9-]/g, "");

  if (svgs.length) {
    const icons: Record<string, string> = {};
    let preview: string | undefined;
    for (const [n, data] of svgs.slice(0, 200)) {
      const key = base(n);
      if (!key) continue;
      const url = `data:image/svg+xml;base64,${btoa(new TextDecoder().decode(data))}`;
      icons[key] = url;
      if (!preview) preview = url;
    }
    const pngPrev = images.find(([n]) => /preview|cover|thumb/i.test(n));
    if (pngPrev) preview = imgB64(pngPrev[1], pngPrev[0].toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg");
    const pack: CustomPack = { id: packId, kind: "icons", name: packName, blurb: manifest.blurb ?? `${Object.keys(icons).length} icons from ${file.name}`, preview, createdAt: Date.now(), icons };
    return { pack };
  }

  if (fonts.length) {
    const pack: CustomPack = {
      id: packId,
      kind: "fonts",
      name: packName,
      blurb: manifest.blurb ?? `${fonts.length} font${fonts.length > 1 ? "s" : ""} from ${file.name}`,
      createdAt: Date.now(),
      fonts: fonts.map(([n, data]) => ({ name: (n.split("/").pop() ?? n).replace(/\.[^.]+$/, ""), dataURL: b64(data) })),
    };
    return { pack };
  }

  if (images.length) {
    const pack: CustomPack = {
      id: packId,
      kind: "wallpapers",
      name: packName,
      blurb: manifest.blurb ?? `${images.length} wallpaper${images.length > 1 ? "s" : ""} from ${file.name}`,
      preview: imgB64(images[0][1], mimeOf(images[0][0])),
      createdAt: Date.now(),
      wallpapers: images.slice(0, 24).map(([n, data]) => ({ name: (n.split("/").pop() ?? n).replace(/\.[^.]+$/, ""), dataURL: imgB64(data, mimeOf(n)) })),
    };
    return { pack };
  }

  throw new Error("No icons, fonts or images found in that zip");
}

function mimeOf(name: string): string {
  const n = name.toLowerCase();
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

function extractGames(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    if (o.format === "nook-games" && Array.isArray(o.games)) return o.games;
    if (Array.isArray((o as { games?: unknown }).games)) return o.games as unknown[];
  }
  return [];
}

// ---------- zip export ----------
export async function exportPackZip(pack: CustomPack) {
  const files: Record<string, Uint8Array> = {};
  files["manifest.json"] = strToU8(JSON.stringify({ kind: pack.kind, name: pack.name, blurb: pack.blurb, version: 1 }, null, 2));
  if (pack.kind === "icons" && pack.icons) {
    for (const [name, url] of Object.entries(pack.icons)) {
      const raw = url.split(",")[1] ?? "";
      try {
        files[`${name}.svg`] = new Uint8Array(Array.from(atob(raw)).map((c) => c.charCodeAt(0)));
      } catch {}
    }
  } else if (pack.kind === "fonts" && pack.fonts) {
    for (const f of pack.fonts) {
      const raw = f.dataURL.split(",")[1] ?? "";
      try {
        files[`${f.name}.ttf`] = new Uint8Array(Array.from(atob(raw)).map((c) => c.charCodeAt(0)));
      } catch {}
    }
  } else if (pack.kind === "wallpapers" && pack.wallpapers) {
    pack.wallpapers.forEach((w, i) => {
      const raw = w.dataURL.split(",")[1] ?? "";
      const ext = w.dataURL.startsWith("data:image/png") ? "png" : "jpg";
      try {
        files[`${i}-${w.name.replace(/[^a-z0-9-]/gi, "_") || "wallpaper"}.${ext}`] = new Uint8Array(Array.from(atob(raw)).map((c) => c.charCodeAt(0)));
      } catch {}
    });
  }
  const zipped = zipSync(files);
  const blob = new Blob([new Uint8Array(zipped)], { type: "application/zip" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${pack.name.replace(/[^a-z0-9-]+/gi, "-").toLowerCase() || "pack"}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/** preview thumbnail element source for a pack (custom: preview dataURL; builtin: rendered live) */
export function packPreviewUrl(packId: string): string | null {
  const p = usePackStore.getState().customPacks.find((x) => x.id === packId);
  return p?.preview ?? null;
}
