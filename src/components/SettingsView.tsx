"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/icons";
import { ICONS } from "@/components/icons";
import type { View } from "@/lib/store";
import { sfx } from "@/lib/sfx";
import { PetView } from "@/components/PetView";
import { IconMaker } from "@/components/IconMaker";
import { ASR_MODELS, clearASRCache, loadASR, isModelCached } from "@/lib/asr";
import { logEvent } from "@/lib/logger";
import { levelOf } from "@/lib/pet";
import { RAIL_DEFAULT_ICONS, RAIL_DEFAULT_ORDER, RAIL_ICON_CHOICES } from "@/lib/store";
import { sha256 } from "@/lib/rules";
import { THEMES, isPremiumTheme, type ThemeId } from "@/lib/themes";
import { UI_STYLES, UI_STYLE_IDS } from "@/lib/uiStyles";
import { useStore, type FontId, type NotifKinds } from "@/lib/store";
import { FONT_PACKS, ICON_PACKS, deletePack, exportPackZip, importPackZip, savePackToServer, usePackStore, applyFontPack, persistPackPrefs } from "@/lib/packs";
import { WALLPAPERS, wallpaperCss } from "@/lib/wallpapers";
import { getMcpToken, setMcpToken } from "@/lib/mcpTokens";

type Section = "account" | "look" | "packs" | "sidebar" | "features" | "mcp" | "sound" | "voice" | "notif" | "pet" | "ai" | "data" | "keys";

const SECTIONS: { id: Section; label: string; icon: IconName }[] = [
  { id: "account", label: "Profile & account", icon: "user" },
  { id: "look", label: "Appearance & wallpapers", icon: "sun" },
  { id: "packs", label: "Icon & font packs", icon: "palette" },
  { id: "sidebar", label: "Sidebar & dock", icon: "layout" },
  { id: "features", label: "Features on/off", icon: "checkbox-on" },
  { id: "mcp", label: "MCP & AI agents", icon: "cpu" },
  { id: "sound", label: "Sound", icon: "zap" },
  { id: "voice", label: "Voice & speech", icon: "mic" },
  { id: "notif", label: "Notifications", icon: "bell" },
  { id: "pet", label: "Companion", icon: "heart" },
  { id: "ai", label: "AI harness", icon: "sparkles" },
  { id: "data", label: "Data & logs", icon: "database" },
  { id: "keys", label: "Shortcuts", icon: "keyboard" },
];

const FONTS: { id: FontId; name: string; css: string; note: string }[] = [
  { id: "sans", name: "Nook Sans", css: '-apple-system, "Segoe UI", system-ui, sans-serif', note: "the classic — clean & soft" },
  { id: "pixel", name: "Pixel everywhere", css: 'var(--f-pixel), ui-monospace, monospace', note: "full arcade mode" },
  { id: "silk", name: "Silkscreen", css: 'var(--f-silk), ui-monospace, monospace', note: "chunky 8-bit labels" },
  { id: "serif", name: "Bookish Serif", css: 'Georgia, "Iowan Old Style", "Times New Roman", serif', note: "for long reading sessions" },
  { id: "mono", name: "Terminal Mono", css: '"Cascadia Code", "SF Mono", Consolas, monospace', note: "hacker vibes" },
  { id: "round", name: "Rounded", css: '"Comic Sans MS", "Chalkboard SE", "Segoe UI", sans-serif', note: "soft & friendly" },
];
const SCALES: { v: number; label: string }[] = [
  { v: 0.9, label: "Cozy 90%" },
  { v: 1, label: "Default 100%" },
  { v: 1.1, label: "Big 110%" },
  { v: 1.22, label: "Huge 122%" },
];

const SHORTCUTS: [string, string][] = [
  ["Ctrl/⌘ + K", "Command palette"],
  ["Alt + 1…8", "Jump between views"],
  ["Alt + 0 / R / −", "Activity · Rulebook · Settings"],
  ["Ctrl/⌘ + B", "Toggle sidebar"],
  ["Ctrl/⌘ + J", "Toggle AI/info panel"],
  ["Alt + N", "New note"],
  ["Alt + Z", "Zen mode"],
  ["Alt + S", "Mute sounds"],
  ["Ctrl/⌘ + E", "Cycle write/split/read"],
  ["/ (in a note)", "Slash command menu"],
  ["@ (in notes/tasks)", "Mention a task, note or person"],
  ["?", "Help overlay"],
];

const NOTIF_KINDS: { id: keyof NotifKinds; label: string; hint: string }[] = [
  { id: "achievement", label: "Achievements", hint: "awards and milestones" },
  { id: "quest", label: "Quests & rewards", hint: "daily quests, streaks, gifts" },
  { id: "sale", label: "Marketplace", hint: "sales and price drops" },
  { id: "level", label: "Pet levels", hint: "level-ups and evolutions" },
  { id: "task", label: "Tasks", hint: "task rewards and reminders" },
  { id: "pet", label: "Pet events", hint: "tricks learned, care events" },
  { id: "info", label: "General", hint: "everything else" },
];

/** per-view icon picker + order/visibility for the rail (mirrors the in-rail edit mode) */
const RAIL_POS_OPTIONS: { id: "left" | "right" | "dock" | "float"; label: string; hint: string; icon: IconName }[] = [
  { id: "left", label: "Left rail", hint: "the classic side rail", icon: "layout" },
  { id: "right", label: "Right rail", hint: "park it on the right edge", icon: "text-colums" },
  { id: "dock", label: "Bottom dock", hint: "macOS-style horizontal dock", icon: "app-windows" },
  { id: "float", label: "Floating pill", hint: "drag it anywhere on screen", icon: "move" },
];

/** ultra-clean mode card — hides every side thing for one focused column (big title-bar button does the same) */
function CleanModeCard() {
  const clean = useStore((s) => s.cleanMode);
  const notesList = useStore((s) => s.notesList);
  const rightOpen = useStore((s) => s.rightOpen);
  const st = useStore.getState;
  return (
    <div className="paper mb-4 p-4" style={clean ? { borderColor: "color-mix(in srgb, var(--accent) 55%, var(--line))" } : undefined}>
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="collapse" size={16} className={clean ? "text-accent" : "text-dim"} />
        <div className="min-w-0 flex-1">
          <div className="pixel-font text-[14px]">Ultra clean mode</div>
          <div className="text-[11.5px] text-faint">Hides the rail, the notes list and the right panel at once — just the big button up top (where “Nook” lives) and your work. Ctrl+\ toggles it anywhere.</div>
        </div>
        <button className={`btn btn-sm ${clean ? "btn-accent" : ""}`} onClick={() => st().toggleClean()}>
          {clean ? <><Icon name="check" size={12} /> Clean is on</> : <><Icon name="collapse" size={12} /> Go clean</>}
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button className="btn btn-sm" data-on={notesList} onClick={() => st().set({ notesList: !notesList, ...(clean ? { cleanMode: false } : {}) })}>
          <Icon name="note" size={12} /> Notes list: {notesList ? "shown" : "hidden"}
        </button>
        <button className="btn btn-sm" data-on={rightOpen} onClick={() => st().set({ rightOpen: !rightOpen, ...(clean ? { cleanMode: false } : {}) })}>
          <Icon name="notebook" size={12} /> Right panel: {rightOpen ? "shown" : "hidden"}
        </button>
      </div>
    </div>
  );
}

function SidebarSection() {
  const railIcons = useStore((s) => s.railIcons);
  const railOrder = useStore((s) => s.railOrder);
  const railHidden = useStore((s) => s.railHidden);
  const railPos = useStore((s) => s.railPos);
  const st = useStore.getState;
  const order = railOrder.length ? RAIL_DEFAULT_ORDER.filter((v) => railOrder.includes(v)).sort((a, b) => railOrder.indexOf(a) - railOrder.indexOf(b)) : RAIL_DEFAULT_ORDER;
  const labels: Record<string, string> = { notes: "Notes", graph: "Graph", canvas: "Canvas", tasks: "Tasks", den: "Pet den", focus: "Focus", arcade: "Arcade", team: "Team room", market: "Marketplace", activity: "Activity", rules: "Rules", settings: "Settings" };
  return (
    <div className="space-y-4">
      <div className="paper p-5">
        <div className="label mb-3">Where does the sidebar live?</div>
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {RAIL_POS_OPTIONS.map((o) => (
            <button key={o.id} className="btn !h-auto flex-col !items-start !gap-1 !py-2.5 text-left" data-on={railPos === o.id} onClick={() => st().setRailPos(o.id)} title={o.hint}>
              <Icon name={o.icon} size={16} className={railPos === o.id ? "text-accent" : undefined} />
              <span className="pixel-font text-[12.5px]">{o.label}</span>
              <span className="text-[10px] leading-tight text-faint">{o.hint}</span>
            </button>
          ))}
        </div>
        <CleanModeCard />
        <div className="mb-3 flex items-center gap-2">
          <span className="label flex-1">Sidebar layout</span>
          <button className="btn btn-sm" onClick={() => useStore.getState().resetRail()}>
            <Icon name="reload" size={12} /> Reset to default
          </button>
        </div>
        <div className="text-[11.5px] text-faint">Pick a new icon for any spot, reorder with the arrows, or hide a view from the rail. You can also do this live from the pencil button at the bottom of the sidebar.</div>
        <div className="mt-3 space-y-2">
          {order.map((v, i) => {
            const hidden = railHidden.includes(v);
            return (
              <div key={v} className="flex flex-wrap items-center gap-2 rounded-xl border border-line p-2" style={hidden ? { opacity: 0.55 } : undefined}>
                <Icon name={railIcons[v] ?? RAIL_DEFAULT_ICONS[v]} size={18} className="flex-none text-accent" />
                <span className="pixel-font min-w-[92px] flex-none text-[12.5px]">{labels[v]}</span>
                <div className="flex flex-1 flex-wrap gap-1">
                  {RAIL_ICON_CHOICES.slice(0, 18).map((ic) => (
                    <button
                      key={ic}
                      className={"grid h-7 w-7 place-items-center rounded-md border transition-transform hover:-translate-y-0.5 " + ((railIcons[v] ?? RAIL_DEFAULT_ICONS[v]) === ic ? "border-accent bg-panel2" : "border-line")}
                      onClick={() => useStore.getState().setRailIcon(v, ic)}
                      title={ic}
                      aria-label={`${labels[v]} icon ${ic}`}
                    >
                      <Icon name={ic} size={13} />
                    </button>
                  ))}
                </div>
                <div className="flex flex-none items-center gap-1">
                  <button className="icon-btn !h-6 !w-6" title="Move up" onClick={() => useStore.getState().moveRailItem(v, -1)}><Icon name="arrow-up" size={12} /></button>
                  <button className="icon-btn !h-6 !w-6" title="Move down" onClick={() => useStore.getState().moveRailItem(v, 1)}><Icon name="arrow-down" size={12} /></button>
                  {v !== "notes" && v !== "settings" && (
                    <button className="icon-btn !h-6 !w-6" title={hidden ? "Show in sidebar" : "Hide from sidebar"} onClick={() => useStore.getState().toggleRailHidden(v)}>
                      <Icon name={hidden ? "eye" : "close"} size={12} />
                    </button>
                  )}
                  <span className="w-8 text-right text-[10px] text-faint">#{i + 1}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="paper p-5">
        <div className="label mb-2">Desktop pet widget</div>
        <Toggle
          on={useStore((s) => s.roam)}
          onChange={(v) => useStore.getState().set({ roam: v })}
          label="Desktop pet widget"
          hint="Your companion wanders the screen — hover for the quick toolbar, right-click for the full menu"
        />
        <Toggle
          on={useStore((s) => s.desktopPrefs.petOnDesktop)}
          onChange={(v) => useStore.getState().setDesktopPrefs({ petOnDesktop: v })}
          label="Pet on the desktop"
          hint="The companion appears on normal windows — hidden during games, fullscreen and ultra-clean mode"
        />
        <Toggle
          on={useStore((s) => s.desktopPrefs.petHideGames)}
          onChange={(v) => useStore.getState().setDesktopPrefs({ petHideGames: v })}
          label="Hide pet during games"
          hint="The pet steps aside while you play in the Arcade"
        />
        <div className="label mb-1 mt-2">Ultra performance</div>
        <div className="seg mb-2 w-full px-2 pb-2">
          {["balanced", "max"] as const.map((mode) => (
            <button
              key={mode}
              className={`flex-1 justify-center text-[11px] rounded-lg px-2 py-1.5 border transition-colors ${
                useStore((s) => s.desktopPrefs.perfMode) === mode
                  ? "bg-accent text-accent-ink border-accent"
                  : "border-line text-dim hover:bg-panel2"
              }`}
              onClick={() => useStore.getState().setDesktopPrefs({ perfMode: mode })}
              title={`Performance mode: ${mode === "max" ? "lower FPS + fewer effects" : "smooth"}`}
            >
              {mode === "max" ? "Max (no lag)" : "Balanced"}
            </button>
          ))}
        </div>
        <Toggle
          on={useStore((s) => s.follow)}
          onChange={(v) => useStore.getState().set({ follow: v })}
          label="Follow my cursor"
          hint="The pet trails behind your pointer as you work"
        />
      </div>

      <div className="paper p-5">
        <div className="label mb-2">Desktop shell (Windows)</div>
        <Toggle
          on={useStore((s) => s.desktopPrefs.alwaysOnTop)}
          onChange={(v) => useStore.getState().setDesktopPrefs({ alwaysOnTop: v })}
          label="Always on top"
          hint="Keep Nook above every other window"
        />
        <Toggle
          on={useStore((s) => s.desktopPrefs.minimizeToTray)}
          onChange={(v) => useStore.getState().setDesktopPrefs({ minimizeToTray: v })}
          label="Minimize to tray"
          hint="Hiding the window parks Nook in the notification area"
        />
        <Toggle
          on={useStore((s) => s.desktopPrefs.autoStart)}
          onChange={(v) => useStore.getState().setDesktopPrefs({ autoStart: v })}
          label="Open Nook on startup"
          hint="Launch Nook automatically when you sign in to Windows"
        />
      </div>
    </div>
  );
}

function Toggle({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <button className="set-row" onClick={() => onChange(!on)} role="switch" aria-checked={on}>
      <span className="min-w-0 flex-1 text-left">
        <span className="block text-[14.5px]">{label}</span>
        {hint && <span className="block text-[11.5px] text-faint">{hint}</span>}
      </span>
      <span className="toggle" data-on={on} aria-hidden><i /></span>
    </button>
  );
}


// ==================== wallpaper grid ====================
function WallpaperGrid() {
  const wallpaper = useStore((s) => s.wallpaper);
  const customPacks = usePackStore((s) => s.customPacks);
  const st = useStore.getState;
  const wallRef = useRef<HTMLInputElement>(null);
  const customWalls = customPacks.flatMap((p) => (p.wallpapers ?? []).map((w, i) => ({ id: `${p.id}#${i}`, name: w.name, img: w.dataURL })));
  const upload = (file: File) => {
    const img = new Image();
    img.onload = () => {
      const MAX = 1600;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
      const url = c.toDataURL("image/jpeg", 0.82);
      st().setWallpaper({ id: "custom", img: url, dim: 0.55, blur: 2 });
      sfx("pop");
      st().toast("Wallpaper set — looking cozy!", "image");
      st().unlock("decorator-app", "Interior Decorator", "Set a custom wallpaper", "image");
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
  };
  return (
    <div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {WALLPAPERS.map((w) => (
          <button
            key={w.id}
            className="theme-card"
            data-on={wallpaper.id === w.id && !wallpaper.img}
            onClick={() => { st().setWallpaper({ id: w.id, img: undefined }); sfx("pop"); }}
            title={w.name}
          >
            <span className="theme-swatch" style={{ background: w.css, backgroundSize: "cover" }} />
            <span className="pixel-font truncate text-[12px]">{w.name}</span>
          </button>
        ))}
        {customWalls.map((w) => (
          <button key={w.id} className="theme-card" data-on={wallpaper.id === w.id} onClick={() => { st().setWallpaper({ id: w.id, img: w.img }); sfx("pop"); }}>
            <span className="theme-swatch" style={{ background: `url(${w.img}) center / cover` }} />
            <span className="pixel-font truncate text-[12px]">{w.name}</span>
          </button>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button className="btn btn-sm" onClick={() => wallRef.current?.click()}>
          <Icon name="upload" size={12} /> Upload your own image
        </button>
        <input ref={wallRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
        <label className="flex items-center gap-2 text-[12px] text-dim">
          dim
          <input type="range" min={0} max={0.9} step={0.05} value={wallpaper.dim} onChange={(e) => st().setWallpaper({ dim: Number(e.target.value) })} className="w-[110px]" />
          <span className="pixel-font w-8 text-right text-[11px]">{Math.round(wallpaper.dim * 100)}%</span>
        </label>
        <label className="flex items-center gap-2 text-[12px] text-dim">
          blur
          <input type="range" min={0} max={10} step={1} value={wallpaper.blur} onChange={(e) => st().setWallpaper({ blur: Number(e.target.value) })} className="w-[110px]" />
          <span className="pixel-font w-8 text-right text-[11px]">{wallpaper.blur}px</span>
        </label>
      </div>
      <div className="mt-2 text-[11.5px] text-faint">Tip: import a .zip of images in the Pack studio to get a whole wallpaper gallery.</div>
    </div>
  );
}

// ==================== packs studio ====================
function PackCard({ active, name, blurb, preview, onUse, onExport, onDelete, used }: { active: boolean; name: string; blurb: string; preview?: React.ReactNode; onUse: () => void; onExport?: () => void; onDelete?: () => void; used?: boolean }) {
  return (
    <div className="font-card !items-stretch !text-left" data-on={active}>
      <div className="grid h-[64px] w-full place-items-center overflow-hidden rounded-xl border border-line bg-panel2">{preview}</div>
      <span className="pixel-font mt-1.5 flex items-center gap-1.5 text-[13px]">
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {active && <span className="chip !py-0 !text-[9px]" data-on="true">active</span>}
      </span>
      <span className="min-h-[1.6em] text-[10.5px] leading-tight text-faint">{blurb}</span>
      <span className="mt-1 flex items-center gap-1">
        <button className="btn btn-sm !py-1 !text-[11px]" onClick={onUse}>{active ? "in use" : "Use"}</button>
        {onExport && <button className="icon-btn !h-6 !w-6" title="Export as .zip" onClick={onExport}><Icon name="download" size={12} /></button>}
        {onDelete && <button className="icon-btn !h-6 !w-6" title="Delete pack" onClick={onDelete}><Icon name="trash" size={12} /></button>}
        {used && !onDelete && <span className="chip !py-0 !text-[9px]">zip</span>}
      </span>
    </div>
  );
}

function IconPackPreview({ style }: { style: { stroke?: boolean; strokeWidth?: number; dash?: boolean; opacity?: number; rotate?: number; scale?: number; glow?: boolean; shadow?: boolean; sticker?: boolean; invert?: boolean; filter?: string; gradient?: [string, string]; gradientId?: string; crisp?: boolean } }) {
  const glyphs: { name: IconName; x: number; y: number }[] = [
    { name: "notes", x: 0, y: 0 }, { name: "dog", x: 1, y: 0 }, { name: "gamepad", x: 2, y: 0 },
    { name: "heart", x: 0, y: 1 }, { name: "zap", x: 1, y: 1 }, { name: "star", x: 2, y: 1 },
  ];
  const grad = style.gradient;
  const gid = style.gradientId ?? "pk-prev";
  return (
    <svg width={72} height={48} viewBox="0 0 36 24" style={style.filter ? { filter: style.filter } : undefined}>
      {grad && (
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={grad[0]} />
            <stop offset="1" stopColor={grad[1]} />
          </linearGradient>
        </defs>
      )}
      {glyphs.map((g) => {
        const common: Record<string, unknown> = {};
        if (grad) common.fill = `url(#${gid})`;
        if (style.invert) { common.fill = "var(--panel2)"; common.stroke = "currentColor"; common.strokeWidth = 1.1; }
        if (style.stroke) {
          common.fill = "none";
          common.stroke = "currentColor";
          common.strokeWidth = style.strokeWidth ?? 1.5;
          common.strokeLinecap = "round";
          common.strokeLinejoin = "round";
          if (style.dash) common.strokeDasharray = "2.4 1.8";
        }
        if (style.sticker) { common.stroke = "var(--panel-solid, #fff)"; common.strokeWidth = 3; common.paintOrder = "stroke"; }
        if (!style.stroke && !grad && !style.invert) common.shapeRendering = "crispEdges";
        return (
          <g key={g.name} transform={`translate(${g.x * 12}, ${g.y * 12}) scale(${style.scale ?? 0.62}) rotate(${style.rotate ?? 0} 12 12)`} opacity={style.opacity ?? 1}>
            <path d={ICONS[g.name]} {...common} />
          </g>
        );
      })}
    </svg>
  );
}

function PacksSection() {
  const [makerOpen, setMakerOpen] = useState(false);
  const customPacks = usePackStore((s) => s.customPacks);
  const iconPack = usePackStore((s) => s.iconPack);
  const fontPack = usePackStore((s) => s.fontPack);
  const [dragOver, setDragOver] = useState(false);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const st = useStore.getState;

  const importFiles = async (files: FileList | File[]) => {
    setBusy(true);
    setMsg("");
    let imported = 0;
    let games = 0;
    for (const f of Array.from(files)) {
      try {
        if (f.name.toLowerCase().endsWith(".json")) {
          const { parseGamePack, validateGameDef } = await import("@/lib/gameEngines");
          const defs = parseGamePack(JSON.parse(await f.text())).map((d) => validateGameDef(d)).filter((d): d is NonNullable<typeof d> => !!d);
          if (defs.length) {
            await st().addCustomGames(defs);
            games += defs.length;
            imported++;
          }
          continue;
        }
        const { pack, games: packGames } = await importPackZip(f);
        if (packGames?.length) {
          const { parseGamePack, validateGameDef } = await import("@/lib/gameEngines");
          const defs = parseGamePack(packGames).map((d) => validateGameDef(d)).filter((d): d is NonNullable<typeof d> => !!d);
          if (defs.length) {
            await st().addCustomGames(defs);
            games += defs.length;
          }
          imported++;
          continue;
        }
        await savePackToServer(pack);
        imported++;
      } catch (e) {
        setMsg(e instanceof Error ? e.message : "Import failed");
      }
    }
    setBusy(false);
    if (imported > 0) {
      sfx("buy");
      setMsg(`Imported ${imported} pack${imported > 1 ? "s" : ""}${games ? ` · ${games} game${games > 1 ? "s" : ""} sent to the Arcade` : ""}`);
      st().unlock("pack-rat", "Pack Rat", "Imported a pack of goodies", "upload");
    }
  };

  const customs = { icons: customPacks.filter((p) => p.kind === "icons"), fonts: customPacks.filter((p) => p.kind === "fonts"), wallpapers: customPacks.filter((p) => p.kind === "wallpapers") };

  const dropZone = (
    <div
      className="grid cursor-pointer place-items-center gap-1 rounded-2xl border-2 border-dashed border-line px-4 py-6 text-center transition-colors"
      style={dragOver ? { borderColor: "var(--accent)", background: "color-mix(in srgb, var(--accent) 8%, transparent)" } : undefined}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files.length) void importFiles(e.dataTransfer.files);
      }}
      onClick={() => fileRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && fileRef.current?.click()}
      aria-label="Import pack zip"
    >
      <Icon name={busy ? "refresh" : "upload"} size={22} className={busy ? "animate-spin text-accent" : "text-accent"} />
      <span className="pixel-font text-[13.5px]">{busy ? "unzipping…" : "Drop a .zip pack here — or click to browse"}</span>
      <span className="text-[11.5px] text-faint">Icon packs (SVGs) · font packs (TTF/OTF/WOFF) · wallpaper packs (images) · game packs (.json or .zip)</span>
      <input ref={fileRef} type="file" accept=".zip,.json" multiple className="hidden" onChange={(e) => { if (e.target.files?.length) void importFiles(e.target.files); e.target.value = ""; }} />
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="paper p-5">
        <div className="mb-1 flex items-center gap-2">
          <Icon name="palette" size={14} className="text-accent" />
          <span className="label">Pack studio</span>
          <span className="chip">{ICON_PACKS.length} built-in icon packs</span>
          <span className="chip">{FONT_PACKS.length} built-in font packs</span>
          <button className="btn btn-sm ml-auto" onClick={() => setMakerOpen(true)} title="Design your own icons — colors, presets, emoji">
            <Icon name="wand" size={13} /> Icon maker
          </button>
        </div>
        <div className="mb-3 text-[12px] text-dim">Every pack restyles the whole app. Import zips from friends or the Marketplace — previews show up the moment they land.</div>
        {dropZone}
        {msg && <div className="mt-2 text-[12px] text-accent" role="status">{msg}</div>}
      </div>

      <div className="paper p-5">
        <div className="label mb-3">Icon packs · {customs.icons.length} imported</div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {ICON_PACKS.map((p) => (
            <PackCard
              key={p.id}
              active={iconPack === p.id}
              name={p.name}
              blurb={p.blurb}
              preview={<IconPackPreview style={p.style} />}
              onUse={() => {
                usePackStore.getState().setIconPack(p.id);
                persistPackPrefs();
                sfx("pop");
                st().unlock("style-swapper", "Style Swapper", "Switched icon packs", "palette");
              }}
            />
          ))}
          {customs.icons.map((p) => (
            <PackCard
              key={p.id}
              active={iconPack === p.id}
              name={p.name}
              blurb={`${Object.keys(p.icons ?? {}).length} icons${p.preview ? " · imported" : ""}`}
              preview={p.preview ? <img src={p.preview} alt="" className="h-[48px] w-[72px] object-contain" /> : <Icon name="grid" size={22} />}
              onUse={() => {
                usePackStore.getState().setIconPack(p.id);
                persistPackPrefs();
                sfx("pop");
              }}
              onExport={() => void exportPackZip(p)}
              onDelete={() => void deletePack(p.id)}
            />
          ))}
        </div>
      </div>

      <div className="paper p-5">
        <div className="label mb-3">Font packs · {customs.fonts.length} imported</div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {FONT_PACKS.map((f) => (
            <PackCard
              key={f.id}
              active={fontPack === f.id}
              name={f.name}
              blurb={f.note}
              preview={<span className="text-[26px] leading-none" style={{ fontFamily: f.css }}>Aa</span>}
              onUse={() => {
                applyFontPack(f.id);
                persistPackPrefs();
                st().set({ font: f.id });
                sfx("pop");
                st().unlock("font-fiddler", "Font Fiddler", "Changed the whole app's font", "type");
              }}
            />
          ))}
          {customs.fonts.map((p) => (
            <PackCard
              key={p.id}
              active={fontPack === p.id}
              name={p.name}
              blurb={`${p.fonts?.length ?? 0} font file(s) · imported`}
              preview={<span className="text-[26px] leading-none" style={{ fontFamily: fontPack === p.id ? "inherit" : undefined }}>Aa</span>}
              onUse={() => {
                applyFontPack(p.id);
                persistPackPrefs();
                st().set({ font: p.id });
                sfx("pop");
              }}
              onExport={() => void exportPackZip(p)}
              onDelete={() => void deletePack(p.id)}
            />
          ))}
        </div>
      </div>

      {customs.wallpapers.length > 0 && (
        <div className="paper p-5">
          <div className="label mb-3">Imported wallpapers · {customs.wallpapers.length}</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {customs.wallpapers.flatMap((p) =>
              (p.wallpapers ?? []).map((w, i) => (
                <button
                  key={`${p.id}-${i}`}
                  className="theme-card"
                  data-on={useStore.getState().wallpaper.id === `${p.id}#${i}`}
                  onClick={() => {
                    st().setWallpaper({ id: `${p.id}#${i}`, img: w.dataURL, dim: 0.5, blur: 2 });
                    sfx("pop");
                  }}
                >
                  <span className="theme-swatch" style={{ background: `url(${w.dataURL}) center / cover` }} />
                  <span className="pixel-font truncate text-[12px]">{w.name}</span>
                </button>
              )),
            )}
          </div>
          <div className="mt-2 text-[11.5px] text-faint">Find them again under Appearance → Wallpaper.</div>
        </div>
      )}
      <IconMaker open={makerOpen} onClose={() => setMakerOpen(false)} />
    </div>
  );
}

// ==================== features on/off ====================
const FEATURE_LABELS: Record<string, string> = { notes: "Notes", graph: "Graph", canvas: "Canvas", tasks: "Tasks", den: "Pet den", focus: "Focus timer", arcade: "Arcade", team: "Team room", market: "Marketplace", activity: "Activity", rules: "Rules", settings: "Settings" };

function FeaturesSection() {
  const petEnabled = useStore((s) => s.petEnabled);
  const petNagOn = useStore((s) => s.petNag);
  const railHidden = useStore((s) => s.railHidden);
  const railOrder = useStore((s) => s.railOrder);
  const pet = useStore((s) => s.pet);
  const st = useStore.getState;
  const order = railOrder.length ? railOrder : (RAIL_DEFAULT_ORDER as View[]);
  const allViews = RAIL_DEFAULT_ORDER.filter((v) => order.includes(v) || railHidden.includes(v));
  const hiddenCount = railHidden.length;
  return (
    <div className="space-y-4">
      <div className="paper p-5">
        <div className="label mb-3">Companion</div>
        <Toggle
          on={petEnabled}
          onChange={(v) => st().setPetEnabled(v)}
          label={`${pet.name} is on duty`}
          hint={petEnabled ? "The desktop pet, quick chat and den buddy are active" : "Pet is fully hidden — no roaming, no chat, no nagging"}
        />
        <div className="mt-2" />
        <Toggle
          on={petNagOn}
          onChange={(v) => st().set({ petNag: v })}
          label="Pet nags — “don't waste your time”"
          hint={petNagOn ? "The pet speaks up when you linger on distraction apps, have open tasks or haven't written" : "The pet stays quiet unless you talk to it"}
        />
      </div>
      <div className="paper p-5">
        <div className="mb-1 flex items-center gap-2">
          <span className="label">Tabs in the sidebar</span>
          {hiddenCount > 0 && <span className="chip">{hiddenCount} hidden</span>}
        </div>
        <div className="mb-3 text-[12px] text-dim">Turn any tab off — it vanishes from the sidebar (keyboard shortcuts still work, nothing is deleted).</div>
        <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          {allViews.map((v) => (
            <Toggle
              key={v}
              on={!railHidden.includes(v)}
              onChange={() => st().toggleRailHidden(v)}
              label={FEATURE_LABELS[v] ?? v}
              hint={railHidden.includes(v) ? "hidden from the sidebar" : "visible"}
            />
          ))}
        </div>
        {hiddenCount > 0 && (
          <button className="btn btn-sm mt-3" onClick={() => st().resetRail()}>
            <Icon name="reload" size={12} /> Show all tabs again
          </button>
        )}
      </div>
    </div>
  );
}

// ==================== mcp & agents ====================
const AGENT_SNIPPETS: { id: string; label: string; note: string; cfg: string }[] = [
  {
    id: "claude",
    label: "Claude Code",
    note: "add to ~/.claude.json or .mcp.json",
    cfg: `"mcpServers": {
  "nook": {
    "type": "http",
    "url": "http://localhost:3000/api/mcp"
  }
}`,
  },
  {
    id: "cursor",
    label: "Cursor",
    note: "~/.cursor/mcp.json",
    cfg: `{
  "mcpServers": {
    "nook": { "url": "http://localhost:3000/api/mcp" }
  }
}`,
  },
  {
    id: "codex",
    label: "Codex CLI",
    note: "~/.codex/config.toml",
    cfg: `[mcp_servers.nook]
url = "http://localhost:3000/api/mcp"`,
  },
  {
    id: "opencode",
    label: "OpenCode",
    note: "opencode.json",
    cfg: `{
  "mcp": {
    "nook": { "type": "remote", "url": "http://localhost:3000/api/mcp" }
  }
}`,
  },
];

type McpLogEntry = { t: number; tool: string; ok: boolean; ms: number; error?: string };

function McpSection() {
  const [token, setTokenState] = useState<string | null>(null);
  const [newToken, setNewToken] = useState("");
  const [copied, setCopied] = useState("");
  const [openAgent, setOpenAgent] = useState("claude");
  const [tools, setTools] = useState<string[]>([]);
  // live connection test
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; ms: number; server?: string; version?: string; err?: string } | null>(null);
  // agent activity feed (server-recorded tools/call log)
  const [log, setLog] = useState<McpLogEntry[] | null>(null);
  const loadLog = () =>
    void fetch("/api/mcp-log")
      .then((r) => r.json())
      .then((j) => setLog(Array.isArray(j?.entries) ? j.entries : []))
      .catch(() => setLog([]));
  useEffect(() => {
    void getMcpToken().then(setTokenState);
    void fetch("/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })
      .then((r) => r.json())
      .then((j) => setTools((j?.result?.tools ?? []).map((t: { name: string }) => t.name)))
      .catch(() => setTools([]));
    loadLog();
    const iv = setInterval(loadLog, 6000);
    return () => clearInterval(iv);
  }, []);
  // the embedded server binds a free port on desktop; window.origin covers both web & desktop
  const MCP_URL = `${window.location.origin}/api/mcp`;
  const runTest = async () => {
    setTesting(true);
    setTest(null);
    const t0 = performance.now();
    try {
      const init = await fetch("/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "nook-selftest", version: "1.0.0" } } }),
      });
      const j = await init.json();
      const ms = Math.round(performance.now() - t0);
      if (j?.result?.serverInfo) {
        setTest({ ok: true, ms, server: j.result.serverInfo.name, version: j.result.serverInfo.version });
        sfx("win");
      } else {
        setTest({ ok: false, ms, err: j?.error?.message ?? "unexpected response" });
        sfx("error");
      }
    } catch (e) {
      setTest({ ok: false, ms: Math.round(performance.now() - t0), err: e instanceof Error ? e.message : "connection failed" });
      sfx("error");
    }
    setTesting(false);
    loadLog();
  };
  const saveToken = async () => {
    const t = newToken.trim();
    await setMcpToken(t || null);
    setTokenState(t || null);
    setNewToken("");
    useStore.getState().toast(t ? "MCP token set — agents now need it" : "MCP token cleared", "cpu");
  };
  const failedCount = log?.filter((e) => !e.ok).length ?? 0;
  return (
    <div className="space-y-4">
      <div className="paper p-5">
        <div className="mb-1 flex items-center gap-2">
          <Icon name="cpu" size={14} className="text-accent" />
          <span className="label">MCP server — connect your AI coding agents</span>
        </div>
        <div className="mb-3 text-[12px] text-dim">
          Let Claude Code, Cursor, Codex CLI or OpenCode read & work on your tasks and notes. They connect to the workspace MCP endpoint — your agent can literally tick off tasks for you.
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="kbd">POST {MCP_URL}</span>
          {tools.length > 0 && <span className="chip" data-on="true"><Icon name="check" size={11} /> {tools.length} tools live</span>}
          <span className="chip">JSON-RPC 2.0</span>
          <button className="btn btn-sm ml-auto" onClick={() => void runTest()} disabled={testing}>
            <Icon name={testing ? "hourglass" : "zap"} size={12} /> {testing ? "testing…" : "Test connection"}
          </button>
        </div>
        {test && (
          <div className="inset mb-3 flex flex-wrap items-center gap-2 px-3 py-2 text-[12px]" style={test.ok ? { borderColor: "#7fc48f" } : { borderColor: "#a5594f" }}>
            <Icon name={test.ok ? "check" : "close"} size={13} style={{ color: test.ok ? "#7fc48f" : "#e08a6a" }} />
            {test.ok ? (
              <>
                <span className="pixel-font">{test.server} v{test.version}</span>
                <span className="text-faint">responded in</span>
                <span className="chip">{test.ms} ms</span>
                <span className="text-faint">— agents can connect.</span>
              </>
            ) : (
              <span>Connection failed: {test.err}</span>
            )}
          </div>
        )}
        <div className="mb-3 flex flex-wrap gap-1.5">
          {tools.slice(0, 24).map((t) => (
            <span key={t} className="pulse-chip !py-0.5"><Icon name="terminal" size={10} /> <span className="tiny-font">{t}</span></span>
          ))}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {AGENT_SNIPPETS.map((a) => (
            <div key={a.id} className="inset overflow-hidden">
              <button className="flex w-full items-center gap-2 px-3 py-2 text-left" onClick={() => setOpenAgent(openAgent === a.id ? "" : a.id)} aria-expanded={openAgent === a.id}>
                <Icon name={openAgent === a.id ? "chevron-down" : "chevron-right"} size={12} />
                <span className="pixel-font flex-1 text-[13px]">{a.label}</span>
                <span className="tiny-font text-[9px] text-faint">{a.note}</span>
              </button>
              {openAgent === a.id && (
                <div className="border-t border-line px-3 py-2">
                  <pre className="overflow-x-auto text-[11px] leading-relaxed text-dim">{a.cfg.replace("http://localhost:3000/api/mcp", MCP_URL)}</pre>
                  <button
                    className="btn btn-sm mt-2"
                    onClick={() => {
                      void navigator.clipboard?.writeText(a.cfg.replace("http://localhost:3000/api/mcp", MCP_URL)).catch(() => {});
                      setCopied(a.id);
                      sfx("pop");
                      setTimeout(() => setCopied(""), 1600);
                    }}
                  >
                    <Icon name={copied === a.id ? "check" : "copy"} size={12} /> {copied === a.id ? "copied!" : "copy config"}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* agent activity — live feed of what external agents did via MCP */}
      <div className="paper p-5">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Icon name="activity" size={14} className="text-accent" />
          <span className="label">Agent activity — live MCP tool calls</span>
          {log && log.length > 0 && (
            <>
              <span className="chip">{log.length} calls</span>
              {failedCount > 0 && <span className="chip" style={{ color: "#e08a6a" }}>{failedCount} failed</span>}
            </>
          )}
          <button className="btn btn-sm ml-auto" onClick={() => { void fetch("/api/mcp-log", { method: "DELETE" }).then(loadLog); }} disabled={!log?.length}>
            <Icon name="trash" size={12} /> clear
          </button>
        </div>
        <div className="text-[11.5px] text-faint">Every tool an external agent runs through the MCP endpoint is recorded here — so you always know what Claude, Cursor or Codex touched.</div>
        <div className="scroll mt-2 max-h-56 space-y-1">
          {!log && <div className="px-1 py-2 text-[12px] text-faint">loading…</div>}
          {log?.length === 0 && (
            <div className="inset flex items-center gap-2 px-3 py-3 text-[12px] text-faint">
              <Icon name="robot-face" size={14} />
              No agent activity yet. Connect Claude Code / Cursor / Codex / OpenCode and watch calls land here in real time.
            </div>
          )}
          {log?.map((e, i) => (
            <div key={`${e.t}-${i}`} className="inset flex flex-wrap items-center gap-2 px-3 py-1.5 text-[12px]">
              <Icon name={e.ok ? "check" : "close"} size={11} style={{ color: e.ok ? "#7fc48f" : "#e08a6a" }} />
              <span className="tiny-font text-[11px] text-accent">{e.tool}</span>
              <span className="chip !h-[18px] !px-1.5 !text-[10px]">{e.ms} ms</span>
              <span className="text-faint">{new Date(e.t).toLocaleTimeString()}</span>
              {!e.ok && e.error && <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: "#e08a6a" }}>{e.error}</span>}
            </div>
          ))}
        </div>
      </div>

      <div className="paper p-5">
        <div className="label mb-2">Access token (optional)</div>
        <div className="mb-2 text-[12px] text-dim">Leave empty for open local access. Set a token to require <span className="kbd">Authorization: Bearer …</span> from agents.</div>
        <div className="flex flex-wrap items-center gap-2">
          <input className="input !w-[220px]" placeholder={token ? "•••••••• (set)" : "no token — open access"} value={newToken} onChange={(e) => setNewToken(e.target.value)} maxLength={64} />
          <button className="btn btn-sm" onClick={() => void saveToken()} disabled={!newToken.trim() && !token}>
            <Icon name="save" size={12} /> {newToken.trim() ? "Save token" : "Clear token"}
          </button>
          {token && <span className="chip" data-on="true"><Icon name="lock" size={11} /> token required</span>}
        </div>
      </div>
    </div>
  );
}

export function SettingsView() {
  const pet = useStore((s) => s.pet);
  const theme = useStore((s) => s.theme);
  const uiStyle = useStore((s) => s.uiStyle);
  const obsLight = useStore((s) => s.obsLight);
  const petNag = useStore((s) => s.petNag);
  const grain = useStore((s) => s.grain);
  const effects = useStore((s) => s.effects);
  const muted = useStore((s) => s.muted);
  const volume = useStore((s) => s.volume);
  const music = useStore((s) => s.music);
  const roam = useStore((s) => s.roam);
  const follow = useStore((s) => s.follow);
  const activityGoal = useStore((s) => s.activityGoal);
  const notes = useStore((s) => s.notes);
  const tasks = useStore((s) => s.tasks);
  const profile = useStore((s) => s.profile);
  const font = useStore((s) => s.font);
  const appScale = useStore((s) => s.appScale);
  const dnd = useStore((s) => s.dnd);
  const notifKinds = useStore((s) => s.notifKinds);
  const voiceModel = useStore((s) => s.voiceModel);
  const asr = useStore((s) => s.asr);
  const deepLink = useStore((s) => s.settingsSection);
  const [section, setSectionState] = useState<Section>("account");
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [email, setEmail] = useState(profile.email);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [pwMsg, setPwMsg] = useState("");
  const [googleOpen, setGoogleOpen] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const [voiceCached, setVoiceCached] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const avatarRef = useRef<HTMLInputElement>(null);
  const st = useStore.getState;

  // honor deep links (notification-center footer, mic errors → voice section)
  const setSection = (s: Section) => {
    setSectionState(s);
    if (deepLink) st().set({ settingsSection: null });
  };
  useEffect(() => {
    if (deepLink) {
      setSectionState(deepLink as Section);
      st().set({ settingsSection: null });
    }
  }, [deepLink, st]);

  useEffect(() => {
    void isModelCached().then(setVoiceCached);
  }, [asr.status]);

  useEffect(() => {
    document.documentElement.dataset.grain = grain ? "on" : "off";
    document.documentElement.dataset.fx = effects ? "on" : "off";
  }, [grain, effects]);

  const lvl = levelOf(pet.xp).level;

  /** resize an image file to a square dataURL (max 144px) so avatars stay tiny */
  const pickAvatar = (file: File) => {
    if (!file.type.startsWith("image/")) {
      st().toast("Pick an image file (png/jpg/webp)", "close");
      return;
    }
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      const S = 144;
      c.width = S;
      c.height = S;
      const ctx = c.getContext("2d")!;
      const side = Math.min(img.width, img.height);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S);
      st().patchProfile({ avatar: c.toDataURL("image/png") });
      st().toast("Avatar updated — looking sharp!", "image");
      sfxSafePop();
    };
    img.src = URL.createObjectURL(file);
  };
  const sfxSafePop = () => import("@/lib/sfx").then((m) => m.sfx("pop")).catch(() => {});

  const savePassword = async () => {
    if (pw.length < 4) {
      setPwMsg("Use at least 4 characters.");
      return;
    }
    if (pw !== pw2) {
      setPwMsg("Passwords don't match.");
      return;
    }
    const hash = await sha256(pw);
    st().patchProfile({ passHash: hash });
    setPw("");
    setPw2("");
    setPwMsg("Password saved (hashed, stays in this browser).");
    st().unlock("keymaster", "Keymaster", "Set a local account password", "lock");
  };

  const downloadBackup = () => {
    const data = {
      app: "nook", version: 2, exportedAt: Date.now(),
      notes, folders: useStore.getState().folders,
      tasks,
      prefs: { theme, grain, effects, activityGoal, muted, volume, music, roam, follow },
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nook-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    st().toast("Full backup downloaded", "download");
    st().unlock("archivist", "Archivist", "Exported your notes as a JSON backup", "download");
  };

  const importBackup = async (file: File) => {
    try {
      const data = JSON.parse(await file.text()) as {
        notes?: { id: string; title: string; content: string; cover: string | null; folderId: string | null; createdAt: number; updatedAt: number }[];
        tasks?: { id: string; title: string; list: string; priority: number; due: number | null; done: boolean; noteId: string | null; by: string }[];
        prefs?: Record<string, unknown>;
      };
      let addedNotes = 0, addedTasks = 0;
      const existing = new Set(notes.map((n) => n.title.toLowerCase()));
      for (const n of data.notes ?? []) {
        if (!n.title || existing.has(n.title.toLowerCase())) continue;
        await fetch("/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(n) });
        addedNotes++;
      }
      for (const t of data.tasks ?? []) {
        if (tasks.some((x) => x.title === t.title)) continue;
        await fetch("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(t) });
        addedTasks++;
      }
      if (data.prefs) {
        const p = data.prefs;
        if (typeof p.grain === "boolean") st().set({ grain: p.grain });
        if (typeof p.effects === "boolean") st().set({ effects: p.effects });
        if (typeof p.activityGoal === "number") st().set({ activityGoal: p.activityGoal });
        if (typeof p.theme === "string") document.documentElement.dataset.theme = p.theme;
      }
      void st().loadTasks();
      setSyncMsg(`Restored ${addedNotes} notes + ${addedTasks} tasks.`);
      st().toast(`Backup restored — ${addedNotes} notes, ${addedTasks} tasks`, "upload");
    } catch {
      setSyncMsg("That file didn't look like a Nook backup.");
      st().toast("Not a valid backup file", "close");
    }
  };

  return (
    <div className="scroll h-full">
      <div className="mx-auto max-w-[860px] px-1 pb-10">
        <div className="mb-4">
          <div className="pixel-font text-[26px] leading-tight">Settings</div>
          <div className="text-[13px] text-dim">Tune the Nook until it feels like yours.</div>
        </div>

        <div className="seg mb-4 flex-wrap" role="tablist" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button key={s.id} role="tab" aria-selected={section === s.id} data-on={section === s.id} onClick={() => setSection(s.id)}>
              <Icon name={s.icon} size={12} /> {s.label}
            </button>
          ))}
        </div>

        {/* ---------------- account ---------------- */}
        {section === "account" && (
          <div className="space-y-4">
            <div className="paper p-5">
              <div className="label mb-3">Your profile</div>
              <div className="flex flex-wrap items-center gap-4">
                {/* avatar */}
                <button
                  className="group relative grid h-[72px] w-[72px] flex-none place-items-center overflow-hidden rounded-2xl border border-line bg-panel2 transition-all hover:border-[color:var(--accent)]/60"
                  onClick={() => avatarRef.current?.click()}
                  title="Upload a profile logo/avatar"
                  aria-label="Upload avatar"
                >
                  {profile.avatar ? (
                    <img src={profile.avatar} alt="Your avatar" className="h-full w-full object-cover" />
                  ) : (
                    <span className="grid place-items-center gap-1 text-faint"><Icon name="image" size={20} /><span className="tiny-font text-[8.5px]">UPLOAD</span></span>
                  )}
                  <span className="absolute inset-0 hidden place-items-center bg-black/55 text-white group-hover:grid"><Icon name="upload" size={16} /></span>
                </button>
                <input ref={avatarRef} type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && pickAvatar(e.target.files[0])} />
                {profile.avatar && (
                  <button className="btn btn-sm" style={{ color: "#e0684f" }} onClick={() => st().patchProfile({ avatar: "" })}>
                    <Icon name="trash" size={12} /> remove
                  </button>
                )}
                <div className="min-w-[200px] flex-1 space-y-2">
                  <label className="block">
                    <span className="tiny-font mb-1 block text-[9.5px] text-faint">DISPLAY NAME</span>
                    <input
                      className="input"
                      placeholder="your name…"
                      maxLength={24}
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      onBlur={() => st().patchProfile({ displayName: displayName.trim() })}
                      aria-label="Display name"
                    />
                  </label>
                  <div className="text-[11.5px] text-faint">Companion: {pet.name} · Level {lvl} · {pet.coins} coins · {notes.length} notes · {tasks.length} tasks</div>
                </div>
              </div>
            </div>

            <div className="paper p-5">
              <div className="label mb-3">Local account</div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="tiny-font mb-1 block text-[9.5px] text-faint">EMAIL</span>
                  <input className="input" type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} onBlur={() => st().patchProfile({ email: email.trim() })} aria-label="Email" />
                </label>
                <div className="inset flex items-center gap-2 px-3 py-2.5 text-[12.5px]">
                  <Icon name="lock" size={14} className="text-accent" />
                  {profile.passHash ? <span>Password is set — <button className="underline" onClick={() => void st().patchProfile({ passHash: "" })}>remove</button></span> : <span>No password yet</span>}
                </div>
                <label className="block">
                  <span className="tiny-font mb-1 block text-[9.5px] text-faint">NEW PASSWORD</span>
                  <input className="input" type="password" placeholder="••••••••" value={pw} onChange={(e) => setPw(e.target.value)} aria-label="New password" />
                </label>
                <label className="block">
                  <span className="tiny-font mb-1 block text-[9.5px] text-faint">REPEAT</span>
                  <div className="flex gap-2">
                    <input className="input" type="password" placeholder="repeat…" value={pw2} onChange={(e) => setPw2(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void savePassword()} aria-label="Repeat password" />
                    <button className="btn btn-accent flex-none" onClick={() => void savePassword()}>
                      <Icon name="check" size={13} /> save
                    </button>
                  </div>
                </label>
              </div>
              {pwMsg && <div className="mt-2 text-[12px] text-accent">{pwMsg}</div>}
              <div className="mt-2 text-[11.5px] text-faint">Everything here lives in your browser only — hashed with SHA-256, never uploaded anywhere.</div>
            </div>

            <div className="paper p-5">
              <div className="label mb-1">Sign in & sync</div>
              <div className="mb-3 text-[12.5px] text-dim">Your data already lives in your own database. Connect sync to carry it across devices.</div>
              <div className="flex flex-wrap gap-2">
                <button className="btn" onClick={() => setGoogleOpen((v) => !v)}>
                  <Icon name="globe" size={14} /> Connect Google
                </button>
                <button className="btn" onClick={downloadBackup}>
                  <Icon name="download" size={14} /> Download backup
                </button>
                <button className="btn" onClick={() => fileRef.current?.click()}>
                  <Icon name="upload" size={14} /> Restore backup
                </button>
                <input ref={fileRef} type="file" accept="application/json" className="hidden" onChange={(e) => e.target.files?.[0] && void importBackup(e.target.files[0])} />
              </div>
              {googleOpen && (
                <div className="mt-3 rounded-xl border border-line bg-panel2 p-3.5 text-[12.5px] leading-relaxed text-dim">
                  <b className="text-ink">Google sign-in (OAuth) — 2-step enable:</b>
                  <ol className="ml-4 mt-1.5 list-decimal space-y-1">
                    <li>Create OAuth credentials at <span className="text-accent">console.cloud.google.com</span> → APIs & Services → Credentials (type: Web, redirect <code>/api/auth/callback/google</code>).</li>
                    <li>Set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> in your <code>.env</code> — the Sign in with Google button lights up automatically.</li>
                  </ol>
                  <div className="mt-2">Until then, <b className="text-ink">backup files</b> above are the sync path — download here, restore anywhere.</div>
                </div>
              )}
              {syncMsg && <div className="mt-2 text-[12px] text-accent">{syncMsg}</div>}
            </div>
          </div>
        )}

        {/* ---------------- voice & speech ---------------- */}
        {section === "voice" && (
          <div className="space-y-4">
            <div className="paper p-5">
              <div className="label mb-1">Voice-to-text engine</div>
              <div className="mb-3 text-[12.5px] leading-relaxed text-dim">
                Notes can take dictation! Pick a speech model below — it downloads <b className="text-ink">once into your browser</b> (nothing is uploaded, it even works offline afterwards) and powers the <Icon name="mic" size={11} className="inline text-accent" /> mic button in the note editor and the task bar.
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {ASR_MODELS.map((m) => {
                  const active = voiceModel === m.id;
                  const busy = asr.status === "loading" && asr.model === m.id;
                  return (
                    <div key={m.id} className="inset p-3" data-on={active} style={active ? { borderColor: "var(--accent)" } : undefined}>
                      <div className="flex items-center gap-2">
                        <Icon name="mic" size={14} className="text-accent" />
                        <span className="pixel-font text-[13.5px]">{m.name}</span>
                        <span className="chip !py-0 !text-[10px]">{m.size}</span>
                        <span className="flex-1" />
                        {active && <span className="chip !py-0 !text-[10px]" data-on="true">selected</span>}
                      </div>
                      <div className="mt-1 text-[11px] text-faint">{m.by} · {m.langs} · {m.blurb}</div>
                      {busy ? (
                        <div className="mt-2">
                          <div className="h-[7px] overflow-hidden rounded-full bg-panel2">
                            <i className="block h-full bg-accent transition-all" style={{ width: `${asr.progress}%` }} />
                          </div>
                          <div className="mt-1 text-[10.5px] text-faint">downloading… {asr.progress}% (one-time)</div>
                        </div>
                      ) : (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <button
                            className="btn btn-sm"
                            onClick={() => {
                              st().set({ voiceModel: m.id });
                              void loadASR(m.id)
                                .then(() => {
                                  st().toast(`${m.name} ready — the mic button is live`, "mic");
                                  st().unlock("voice-setup", "Voice Assistant", "Downloaded a local speech model", "mic");
                                  logEvent(`voice model downloaded: ${m.id}`, "info", "settings");
                                })
                                .catch(() => st().toast("Download failed — check your internet and retry", "alert"));
                            }}
                          >
                            <Icon name="download" size={12} /> {active ? "Re-download" : "Download & use"}
                          </button>
                          {!active && <button className="btn btn-sm" onClick={() => { st().set({ voiceModel: m.id }); st().toast(`${m.name} selected — download it to enable the mic`, "mic"); }}>Select only</button>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <div className="chip" data-on={asr.status === "ready"}>
                  <Icon name={asr.status === "ready" ? "check" : "mic"} size={11} />
                  {asr.status === "ready" ? "model loaded — ready to dictate" : asr.status === "error" ? "last download failed" : "not downloaded yet"}
                </div>
                {voiceCached && (
                  <button
                    className="btn btn-sm"
                    style={{ color: "#e0684f" }}
                    onClick={() => {
                      if (!confirm("Delete the downloaded voice model from this browser?")) return;
                      void clearASRCache().then(() => {
                        setVoiceCached(false);
                        st().toast("Voice model deleted from the browser cache", "trash");
                      });
                    }}
                  >
                    <Icon name="trash" size={12} /> delete downloaded model
                  </button>
                )}
              </div>
              {asr.status === "error" && asr.error && <div className="mt-2 rounded-lg border border-line bg-panel2 p-2 font-mono text-[10.5px] text-faint">{asr.error}</div>}
              <div className="mt-2 text-[11.5px] text-faint">First run downloads from the Hugging Face CDN; after that the model is cached in your browser (Cache Storage → transformers-cache). Moonshine = fastest for English voice notes; Whisper = multilingual.</div>
            </div>
            <div className="paper p-5">
              <div className="label mb-2">How to dictate</div>
              <ol className="ml-4 list-decimal space-y-1 text-[12.5px] text-dim">
                <li>Click the <Icon name="mic" size={11} className="inline text-accent" /> mic in the note toolbar (or the task bar, or run <span className="pixel-font">/Voice typing</span> in a note).</li>
                <li>Speak your thought — the button pulses while recording.</li>
                <li>Click it again — the transcript drops straight in at your cursor.</li>
              </ol>
            </div>
          </div>
        )}

        {/* ---------------- notifications ---------------- */}
        {section === "notif" && (
          <div className="space-y-4">
            <div className="paper p-2.5">
              <Toggle on={dnd} onChange={(v) => st().set({ dnd: v })} label="Do not disturb" hint="Toast popups go quiet — the bell inbox keeps recording everything" />
              <div className="set-row" onClick={() => useStore.setState({ noticeOpen: true })} role="button">
                <span className="min-w-0 flex-1 text-left">
                  <span className="block text-[14.5px]">Open the notification center</span>
                  <span className="block text-[11.5px] text-faint">search, filter and mark-read the bell inbox</span>
                </span>
                <Icon name="chevron-right" size={14} className="text-faint" />
              </div>
            </div>
            <div className="paper p-5">
              <div className="label mb-1">What lands in the bell</div>
              <div className="mb-3 text-[12px] text-faint">Turn kinds off and they skip the inbox entirely (toasts follow the same switch).</div>
              <div className="space-y-1">
                {NOTIF_KINDS.map((k) => (
                  <Toggle
                    key={k.id}
                    on={notifKinds[k.id] !== false}
                    onChange={(v) => st().set({ notifKinds: { ...notifKinds, [k.id]: v } })}
                    label={k.label}
                    hint={k.hint}
                  />
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ---------------- appearance ---------------- */}
        {section === "look" && (
          <div className="space-y-4">
            <div className="paper p-5">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="label">UI style — the whole look</span>
                <span className="chip">3 styles</span>
              </div>
              <div className="mb-3 text-[11.5px] text-faint">A full restyle of every panel, button and font — switch anytime, it applies instantly.</div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {UI_STYLE_IDS.map((id) => {
                  const s = UI_STYLES[id];
                  const on = uiStyle === id;
                  const bw = id === "pixel" ? 2 : 1;
                  const rad = id === "obsidian" ? 4 : id === "pixel" ? 8 : 10;
                  const sh = id === "pixel" ? `2px 2px 0 ${s.ramp[2]}` : id === "obsidian" ? "none" : `0 6px 14px -8px rgba(0,0,0,.6)`;
                  return (
                    <button
                      key={id}
                      className="theme-card !items-stretch !p-2 text-left"
                      data-on={on}
                      onClick={() => st().setUiStyle(id)}
                      title={s.blurb}
                    >
                      {/* mini mock window in the style's own chrome */}
                      <span className="mb-2 flex h-[84px] w-full gap-1.5 rounded-[8px] p-1.5" style={{ background: s.ramp[0] }}>
                        <span className="grid" style={{ width: 16, borderRadius: rad, background: s.ramp[1], border: `${bw}px solid ${s.ramp[2]}`, boxShadow: sh }}>
                          <i className="m-1 block" style={{ height: 3, borderRadius: 2, background: s.ramp[3] }} />
                          <i className="mx-1 block" style={{ height: 3, borderRadius: 2, background: s.ramp[2] }} />
                          <i className="mx-1 block" style={{ height: 3, borderRadius: 2, background: s.ramp[2] }} />
                        </span>
                        <span className="flex flex-1 flex-col gap-1 p-1.5" style={{ borderRadius: rad, background: s.ramp[1], border: `${bw}px solid ${s.ramp[2]}`, boxShadow: sh }}>
                          <i className="block" style={{ height: 6, width: "52%", borderRadius: 3, background: s.ramp[3] }} />
                          <i className="block" style={{ height: 4, width: "86%", borderRadius: 2, background: s.ramp[2] }} />
                          <i className="block" style={{ height: 4, width: "72%", borderRadius: 2, background: s.ramp[2] }} />
                          <i className="mt-auto block" style={{ height: 8, width: "38%", borderRadius: 4, background: s.ramp[3] }} />
                        </span>
                        <span style={{ width: 26, borderRadius: rad, background: s.ramp[1], border: `${bw}px solid ${s.ramp[2]}`, boxShadow: sh }} />
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="pixel-font text-[13.5px]">{s.name}</span>
                        {on && <Icon name="check" size={12} className="text-accent" />}
                      </span>
                      <span className="text-[10.5px] leading-snug text-faint">{s.blurb}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="paper p-5">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="label">Obsidian mode</span>
                <span className="chip">only in Obsidian style</span>
              </div>
              <div className="mb-3 text-[11.5px] text-faint">Obsidian comes in dark and light — exactly like the real app. Switch anytime.</div>
              <div className="seg w-fit">
                <button data-on={uiStyle === "obsidian" && !obsLight} onClick={() => { st().setUiStyle("obsidian"); st().setObsLight(false); }}>
                  <Icon name="moon" size={13} /> Dark (default)
                </button>
                <button data-on={uiStyle === "obsidian" && obsLight} onClick={() => { st().setUiStyle("obsidian"); st().setObsLight(true); }}>
                  <Icon name="sun" size={13} /> Light
                </button>
              </div>
            </div>
            <div className="paper p-5">
              <div className="label mb-3">App font</div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {FONTS.map((f) => (
                  <button
                    key={f.id}
                    className="font-card"
                    data-on={font === f.id}
                    onClick={() => st().setFont(f.id)}
                  >
                    <span className="font-card-preview" style={{ fontFamily: f.css }}>Aa</span>
                    <span className="pixel-font text-[13px]">{f.name}</span>
                    <span className="text-[10.5px] text-faint">{f.note}</span>
                  </button>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-[11.5px] text-faint">Changes the entire app instantly — titles, buttons, everything.</span>
                <button className="btn btn-sm ml-auto" onClick={() => setSection("packs")}>
                  <Icon name="palette" size={12} /> 24+ font packs & custom zips →
                </button>
              </div>
            </div>
            <div className="paper p-5">
              <div className="mb-3 flex items-center gap-2">
                <span className="label">Wallpaper — the whole app background</span>
                {useStore.getState().wallpaper.id !== "none" && (
                  <button className="btn btn-sm" onClick={() => { st().setWallpaper({ id: "none", img: undefined }); }}>
                    <Icon name="close" size={12} /> remove
                  </button>
                )}
              </div>
              <WallpaperGrid />
            </div>
            <div className="paper p-5">
              <div className="label mb-1">UI scale — make everything bigger or smaller</div>
              <div className="mb-3 text-[11.5px] text-faint">Zooms the whole app. The keyboard shortcut Ctrl+= / Ctrl+- also works.</div>
              <div className="flex flex-wrap items-center gap-3">
                <button className="icon-btn" onClick={() => st().setAppScale(appScale - 0.05)} title="Smaller" aria-label="Smaller UI">
                  <Icon name="zoom-out" size={15} />
                </button>
                <input
                  type="range" min={85} max={135} step={5} value={Math.round(appScale * 100)}
                  onChange={(e) => st().setAppScale(Number(e.target.value) / 100)}
                  className="h-1 w-[190px] cursor-pointer appearance-none rounded-full"
                  style={{ background: `linear-gradient(90deg, var(--accent) ${((appScale - 0.85) / 0.5) * 100}%, var(--panel2) ${((appScale - 0.85) / 0.5) * 100}%)` }}
                  aria-label="UI scale"
                />
                <button className="icon-btn" onClick={() => st().setAppScale(appScale + 0.05)} title="Bigger" aria-label="Bigger UI">
                  <Icon name="zoom-in" size={15} />
                </button>
                <span className="text-[12px] tabular-nums text-dim">{Math.round(appScale * 100)}%</span>
                <span className="flex-1" />
                {SCALES.map((s) => (
                  <button key={s.v} className="btn btn-sm" data-on={Math.abs(appScale - s.v) < 0.01} onClick={() => st().setAppScale(s.v)}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="paper p-5">
              <div className="label mb-3">Theme</div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {(Object.keys(THEMES) as ThemeId[]).map((id) => {
                  const t = THEMES[id];
                  const locked = isPremiumTheme(id) && !pet.owned.includes(id);
                  return (
                    <button
                      key={id}
                      className="theme-card"
                      data-on={theme === id}
                      onClick={() => (locked ? st().toast(`“${t.name}” is a rare theme — win it in the Marketplace!`, "lock") : st().setTheme(id))}
                      style={{ ["--tc" as string]: t.accent }}
                    >
                      <span className="theme-swatch" style={{ background: `linear-gradient(135deg, ${t.ramp[4]}, ${t.ramp[2]})` }}>
                        {locked && <Icon name="lock" size={12} />}
                      </span>
                      <span className="pixel-font text-[13px]">{t.name}</span>
                      {locked && <span className="tiny-font text-[9px] text-faint">marketplace</span>}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="paper p-2.5">
              <Toggle on={grain} onChange={(v) => st().set({ grain: v })} label="Film grain & texture" hint="That cozy analog wash over everything" />
              <Toggle on={effects} onChange={(v) => st().set({ effects: v })} label="Motion & effects" hint="Confetti, coin flights, hover lifts — turn off for calm mode" />
            </div>
          </div>
        )}

        {/* ---------------- sidebar customization ---------------- */}
        {section === "packs" && <PacksSection />}

        {/* ---------------- sidebar customization ---------------- */}
        {section === "sidebar" && <SidebarSection />}

        {/* ---------------- features on/off ---------------- */}
        {section === "features" && <FeaturesSection />}

        {/* ---------------- mcp & agents ---------------- */}
        {section === "mcp" && <McpSection />}

        {/* ---------------- sound ---------------- */}
        {section === "sound" && (
          <div className="paper p-2.5">
            <Toggle on={!muted} onChange={(v) => st().set({ muted: !v })} label="Sound effects" hint="Pops, coins, wins — the good pixel noises" />
            <Toggle on={music} onChange={(v) => st().set({ music: v })} label="Lo-fi ambience" hint="A gentle generated loop while you work" />
            <div className="set-row" role="group" aria-label="Volume">
              <span className="min-w-0 flex-1 text-left"><span className="block text-[14.5px]">Volume</span></span>
              <input type="range" min={0} max={100} value={Math.round(volume * 100)} onChange={(e) => st().set({ volume: Number(e.target.value) / 100 })} className="w-[160px]" />
              <span className="pixel-font w-[34px] text-right text-[13px]">{Math.round(volume * 100)}</span>
            </div>
          </div>
        )}

        {/* ---------------- pet ---------------- */}
        {section === "pet" && (
          <div className="paper p-2.5">
            <Toggle on={roam} onChange={(v) => st().set({ roam: v })} label="Desktop pet" hint={`${pet.name} strolls along the bottom of the screen`} />
            <Toggle on={follow} onChange={(v) => st().set({ follow: v })} label="Follow my cursor" hint="A loyal little shadow" />
            <div className="set-row" onClick={() => st().setView("den")}>
              <span className="min-w-0 flex-1 text-left">
                <span className="block text-[14.5px]">Visit the den</span>
                <span className="block text-[11.5px] text-faint">Feed, decorate, play — everything companion lives there</span>
              </span>
              <Icon name="chevron-right" size={14} className="text-faint" />
            </div>
            <div className="set-row" onClick={() => st().startTour()}>
              <span className="min-w-0 flex-1 text-left">
                <span className="block text-[14.5px]">Replay the welcome tour</span>
                <span className="block text-[11.5px] text-faint">{pet.name} walks you through the whole Nook again</span>
              </span>
              <Icon name="map-pin" size={14} className="text-faint" />
            </div>
          </div>
        )}

        {/* ---------------- AI harness ---------------- */}
        {section === "ai" && (
          <div className="space-y-4">
            <div className="paper p-5">
              <div className="label mb-2">The harness</div>
              <div className="text-[12.5px] leading-relaxed text-dim">
                {pet.name} isn't just chat — a tool loop runs server-side. Ask in any chat box:
                <ul className="ml-4 mt-2 list-disc space-y-1">
                  <li><b className="text-ink">“add task: water the plants”</b> → really creates it in Tasks</li>
                  <li><b className="text-ink">“tidy my finished tasks”</b> → clears them for real</li>
                  <li><b className="text-ink">“how much time did I spend on youtube this week?”</b> → reads your activity log</li>
                  <li><b className="text-ink">“research pixel art trends”</b> → live web search + page reading</li>
                  <li><b className="text-ink">“how's my pet? feed them a taco”</b> → checks stats, feeds (coins!)</li>
                  <li><b className="text-ink">“summarize my vault”</b> → real numbers from the database</li>
                </ul>
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {["notes ×6", "folders", "tasks ×5", "pet ×3", "market", "activity", "rules ×5", "vault stats", "web search", "read URL"].map((t) => (
                    <span key={t} className="chip !text-[11px]">{t}</span>
                  ))}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button className="btn btn-sm" onClick={() => { st().setView("notes"); st().set({ rightOpen: true, rightTab: "ai" }); }}>
                  <Icon name="sparkles" size={12} /> Open chat
                </button>
                <button className="btn btn-sm" onClick={() => void st().runAi("agent", { question: "Give me a quick status report: vault stats, my open tasks, my pet's mood and today's tracked time." })}>
                  <Icon name="terminal" size={12} /> Try a status report
                </button>
              </div>
            </div>
            <div className="paper p-2.5">
              <Toggle on={effects} onChange={(v) => st().set({ effects: v })} label="Harness effects" hint="Navigate, confetti and theme changes the assistant requests" />
            </div>
          </div>
        )}

        {/* ---------------- data ---------------- */}
        {section === "data" && (
          <div className="space-y-4">
            <div className="paper p-5">
              <div className="label mb-2">Where things live</div>
              <div className="grid grid-cols-2 gap-2 text-[12.5px] sm:grid-cols-3">
                {([["Notes & folders", "SQLite (server)"], ["Canvases", "SQLite (server)"], ["Tasks", "SQLite (server)"], ["App-time log", "SQLite + local"], ["Pet & coins", "SQLite (server)"], ["Quests, prefs", "your browser"]]).map(([a, b]) => (
                  <div key={a} className="inset p-2.5"><div className="pixel-font text-[13px]">{a}</div><div className="text-[11px] text-faint">{b}</div></div>
                ))}
              </div>
            </div>
            <div className="paper p-5">
              <div className="label mb-2">Danger zone</div>
              <div className="flex flex-wrap gap-2">
                <button
                  className="btn btn-sm"
                  style={{ color: "#e0684f" }}
                  onClick={() => {
                    if (!confirm("Reset EVERYTHING local (prefs, quests, achievements, tracked time)? Notes/tasks/pet on the server are kept.")) return;
                    localStorage.removeItem("nook:prefs");
                    location.reload();
                  }}
                >
                  <Icon name="trash" size={12} /> Reset local progress
                </button>
                <button className="btn btn-sm" onClick={() => useStore.setState({ bugOpen: true, bugTab: "logs" })}>
                  <Icon name="logs" size={12} /> Open the live log
                </button>
                <button className="btn btn-sm" onClick={() => useStore.setState({ bugOpen: true, bugTab: "reports" })}>
                  <Icon name="bug" size={12} /> Bug reports
                </button>
              </div>
              <div className="mt-1.5 text-[11.5px] text-faint">Server data (notes, tasks, pet, market) survives — only browser-side progress resets.</div>
            </div>
          </div>
        )}

        {/* ---------------- shortcuts ---------------- */}
        {section === "keys" && (
          <div className="paper p-5">
            <div className="label mb-3">Keyboard shortcuts</div>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {SHORTCUTS.map(([k, d]) => (
                <div key={k} className="inset flex items-center justify-between gap-2 px-3 py-2">
                  <span className="text-[13px] text-dim">{d}</span>
                  <kbd className="chip pixel-font !text-[11px]">{k}</kbd>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
