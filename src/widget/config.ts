/**
 * Desktop widget layout (shared by the widget window and Settings → Desktop through
 * localStorage; both windows listen to the `storage` event so changes apply live).
 */
export type TileId = "capture" | "tasks" | "timelens" | "focus" | "ai" | "pet";
export type Tile = { id: TileId; on: boolean };
export type WidgetCfg = { tiles: Tile[]; compact: boolean; expanded: { w: number; h: number }; opacity: number };

export const TILE_LABEL: Record<TileId, string> = {
  capture: "Quick capture",
  tasks: "Today's tasks",
  timelens: "Timelens today",
  focus: "Focus timer",
  ai: "Mini AI",
  pet: "Pet",
};
export const WIDGET_SIZE = { w: 300, h: 380 };
export const PILL_SIZE = { w: 200, h: 48 };
const KEY = "nook:widget";

export const DEFAULT_WIDGET: WidgetCfg = {
  tiles: [
    { id: "capture", on: true },
    { id: "timelens", on: true },
    { id: "tasks", on: true },
    { id: "focus", on: false },
    { id: "ai", on: true },
    { id: "pet", on: false },
  ],
  compact: false,
  expanded: { ...WIDGET_SIZE },
  opacity: 0.94,
};

export function readWidgetCfg(): WidgetCfg {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<WidgetCfg>;
    const known = new Set(DEFAULT_WIDGET.tiles.map((t) => t.id));
    const saved = Array.isArray(raw.tiles) ? raw.tiles.filter((t) => t && known.has(t.id)).map((t) => ({ id: t.id, on: !!t.on })) : [];
    const tiles = [...saved, ...DEFAULT_WIDGET.tiles.filter((t) => !saved.some((s) => s.id === t.id))];
    return {
      tiles,
      compact: !!raw.compact,
      expanded: raw.expanded && raw.expanded.w >= 220 && raw.expanded.h >= 160 ? raw.expanded : { ...WIDGET_SIZE },
      opacity: typeof raw.opacity === "number" ? Math.min(1, Math.max(0.6, raw.opacity)) : DEFAULT_WIDGET.opacity,
    };
  } catch {
    return { ...DEFAULT_WIDGET, tiles: DEFAULT_WIDGET.tiles.map((t) => ({ ...t })) };
  }
}

export function writeWidgetCfg(cfg: WidgetCfg) {
  try {
    localStorage.setItem(KEY, JSON.stringify(cfg));
  } catch {}
  // same-window listeners (the storage event only fires in other windows)
  window.dispatchEvent(new CustomEvent("nook-widget-cfg"));
}

export function moveTile(cfg: WidgetCfg, id: TileId, dir: -1 | 1): WidgetCfg {
  const i = cfg.tiles.findIndex((t) => t.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= cfg.tiles.length) return cfg;
  const tiles = [...cfg.tiles];
  [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
  return { ...cfg, tiles };
}
