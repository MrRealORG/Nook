/**
 * 1.3 look pickers shared by the onboarding and Settings ▸ Appearance:
 *  - theme presets with live mini previews (Pixel dark / Pixel light / Clean light / Clean dark /
 *    Obsidian / Classic), applied instantly;
 *  - the icon style (Pixel sprites / Clean lucide), independent of the colour theme;
 *  - the layout (Nook style / Obsidian style), with previews.
 */
import { Icon } from "@/components/Icon";
import { PixelIcon } from "@/components/PixelIcon";
import { setFollow } from "@/lib/systemTheme";
import { useStore } from "@/lib/store";
import type { ThemeId } from "@/lib/themes";
import type { UiStyleId } from "@/lib/uiStyles";
import "@/looks.css";
import { Bell, CheckSquare, FileText, Folder, Gamepad2, Settings, Sparkles } from "lucide-react";

export type Preset = { id: string; name: string; ui: UiStyleId; theme: ThemeId; c: { bg: string; panel: string; line: string; ink: string; dim: string; accent: string }; pixel: boolean };

export const PRESETS: Preset[] = [
  { id: "pixel-dark", name: "Pixel dark", ui: "pixel", theme: "dark", pixel: true, c: { bg: "#13111b", panel: "#1c1928", line: "#2d2842", ink: "#ece8fa", dim: "#6d6790", accent: "#a58cff" } },
  { id: "pixel-light", name: "Pixel light", ui: "pixel", theme: "light", pixel: true, c: { bg: "#f1ecf9", panel: "#fffdf9", line: "#e0d6f0", ink: "#2d2443", dim: "#9c91b8", accent: "#7b5cf5" } },
  { id: "clean-light", name: "Clean light", ui: "clean", theme: "light", pixel: false, c: { bg: "#f4f5f8", panel: "#ffffff", line: "#e3e6ec", ink: "#171a21", dim: "#959cab", accent: "#5468e8" } },
  { id: "clean-dark", name: "Clean dark", ui: "clean", theme: "dark", pixel: false, c: { bg: "#0f1115", panel: "#171a20", line: "#262a33", ink: "#e8eaef", dim: "#6c7380", accent: "#8b9bff" } },
  { id: "obsidian", name: "Obsidian", ui: "obsidian", theme: "dark", pixel: false, c: { bg: "#1e1e1e", panel: "#262626", line: "#363636", ink: "#dadada", dim: "#6e6e6e", accent: "#a882ff" } },
  { id: "classic", name: "Classic", ui: "nook", theme: "graphite", pixel: true, c: { bg: "#0d0e10", panel: "#1b1d21", line: "#2c2f35", ink: "#e9ebee", dim: "#626872", accent: "#9db7d0" } },
];

export function applyPreset(p: Preset) {
  const st = useStore.getState();
  setFollow({ on: false });
  st.setUiStyle(p.ui, true);
  if (st.theme !== p.theme) st.setTheme(p.theme);
}

export const presetOf = (ui: UiStyleId, theme: ThemeId) => PRESETS.find((p) => p.ui === ui && p.theme === theme)?.id ?? null;

/** a tiny live window in the preset's own colours and chrome */
function MiniWindow({ p }: { p: Preset }) {
  const { c } = p;
  const bw = p.pixel ? 2 : 1;
  const r = p.pixel ? 4 : p.ui === "obsidian" ? 3 : 6;
  const sh = p.pixel ? `0 2px 0 rgba(0,0,0,.25)` : "none";
  const box = { background: c.panel, border: `${bw}px solid ${c.line}`, borderRadius: r, boxShadow: sh };
  return (
    <span className="ob-mini" style={{ background: c.bg }}>
      <span className="ob-mini-rail" style={box}>
        {p.pixel ? (
          <>
            <PixelIcon name="notes" size={12} />
            <PixelIcon name="tasks" size={12} />
            <PixelIcon name="chat" size={12} />
          </>
        ) : (
          <>
            <FileText size={11} color={c.accent} />
            <CheckSquare size={11} color={c.dim} />
            <Sparkles size={11} color={c.dim} />
          </>
        )}
      </span>
      <span className="ob-mini-main" style={box}>
        <i style={{ background: c.ink, width: "54%", height: 6, borderRadius: p.pixel ? 0 : 3 }} />
        <i style={{ background: c.dim, width: "88%" }} />
        <i style={{ background: c.dim, width: "70%" }} />
        <i style={{ background: c.dim, width: "78%" }} />
        <b style={{ background: c.accent, borderRadius: p.pixel ? 2 : 6, boxShadow: p.pixel ? `0 2px 0 rgba(0,0,0,.3)` : "none" }} />
      </span>
    </span>
  );
}

export function ThemePresets({ compact }: { compact?: boolean }) {
  const ui = useStore((s) => s.uiStyle);
  const theme = useStore((s) => s.theme);
  const cur = presetOf(ui, theme);
  return (
    <div className={compact ? "ob-presets ob-presets-compact" : "ob-presets"} role="radiogroup" aria-label="Theme">
      {PRESETS.map((p) => (
        <button key={p.id} role="radio" aria-checked={cur === p.id} data-on={cur === p.id} className="ob-preset" data-testid={`preset-${p.id}`} onClick={() => applyPreset(p)}>
          <MiniWindow p={p} />
          <span className="ob-preset-name">
            {p.name}
            {cur === p.id && <Icon name="check" size={12} className="text-accent" />}
          </span>
        </button>
      ))}
    </div>
  );
}

export function IconStylePicker() {
  const iconStyle = useStore((s) => s.iconStyle);
  const opts = [
    { id: "pixel" as const, name: "Pixel", hint: "Colour pixel-art sprites", demo: <>{["notes", "calendar", "chat", "focus", "arcade", "settings"].map((n) => <PixelIcon key={n} name={n} size={16} />)}</> },
    { id: "clean" as const, name: "Clean", hint: "Crisp line icons", demo: <>{[FileText, Bell, Sparkles, Folder, Gamepad2, Settings].map((C, i) => <C key={i} size={15} strokeWidth={1.75} />)}</> },
  ];
  return (
    <div className="ob-iconstyle" role="radiogroup" aria-label="Icon style" data-testid="icon-style">
      {opts.map((o) => (
        <button key={o.id} role="radio" aria-checked={iconStyle === o.id} data-on={iconStyle === o.id} className="ob-iconstyle-opt" data-testid={`icon-style-${o.id}`} onClick={() => useStore.getState().setIconStyle(o.id)}>
          <span className="ob-iconstyle-demo">{o.demo}</span>
          <span className="ob-iconstyle-name">{o.name}</span>
          <span className="ob-iconstyle-hint">{o.hint}</span>
        </button>
      ))}
    </div>
  );
}

function LayoutPreview({ kind }: { kind: "nook" | "obsidian" }) {
  if (kind === "nook")
    return (
      <span className="ob-lay">
        <span className="ob-lay-rail">{[0, 1, 2, 3, 4].map((i) => <i key={i} data-on={i === 0} />)}</span>
        <span className="ob-lay-list">{[0, 1, 2, 3].map((i) => <i key={i} />)}</span>
        <span className="ob-lay-main"><b /><i /><i /><i /></span>
        <span className="ob-lay-side"><i /><i /></span>
      </span>
    );
  return (
    <span className="ob-lay ob-lay-obs">
      <span className="ob-lay-ribbon">{[0, 1, 2, 3].map((i) => <i key={i} />)}</span>
      <span className="ob-lay-tree">{[0, 1, 2, 3, 4, 5].map((i) => <i key={i} style={{ marginLeft: i % 3 ? 6 : 0 }} />)}</span>
      <span className="ob-lay-center">
        <span className="ob-lay-tabs"><u data-on="true" /><u /><u /></span>
        <span className="ob-lay-main"><b /><i /><i /><i /></span>
      </span>
      <span className="ob-lay-right"><em /><i /><i /><i /></span>
    </span>
  );
}

export function LayoutPicker() {
  const layout = useStore((s) => s.layout);
  const opts = [
    { id: "nook" as const, name: "Nook style", hint: "Sidebar rail + notes list + editor + info pane" },
    { id: "obsidian" as const, name: "Obsidian style", hint: "Ribbon · file tree · tabbed editor · backlinks / outline / graph" },
  ];
  return (
    <div className="ob-layouts" role="radiogroup" aria-label="Layout">
      {opts.map((o) => (
        <button key={o.id} role="radio" aria-checked={layout === o.id} data-on={layout === o.id} className="ob-layout" data-testid={`layout-${o.id}`} onClick={() => useStore.getState().setLayout(o.id)}>
          <LayoutPreview kind={o.id} />
          <span className="ob-preset-name">{o.name}{layout === o.id && <Icon name="check" size={12} className="text-accent" />}</span>
          <span className="ob-iconstyle-hint">{o.hint}</span>
        </button>
      ))}
    </div>
  );
}
