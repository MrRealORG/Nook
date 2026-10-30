
/**
 * Icon maker — a self-contained dialog for building your own icon pack.
 *
 * Pick any built-in app icon, tune it (base color, outline/bold/filled preset,
 * sidebar size, optional single-emoji override), preview it big + in a sidebar
 * mock, then add it to a persistent custom pack ("My Icon Pack") through the
 * normal packs pipeline (localStorage mirror + /api/packs server sync). The
 * pack then appears in Settings → Pack studio next to the built-ins and can be
 * applied like any other icon pack. Icons the pack doesn't override keep their
 * active pack look, so you can mix-and-match.
 */

import { useEffect, useMemo, useState } from "react";
import { ICONS, type IconName } from "@/components/icons";
import { Icon } from "@/components/Icon";
import {
  DEFAULT_MAKER_PACK_NAME,
  MAKER_PACK_ID,
  makerPack,
  persistPackPrefs,
  removeMakerIcon,
  savePackToServer,
  upsertMakerIcon,
  usePackStore,
} from "@/lib/packs";

type IconPreset = "outline" | "bold" | "filled";

const PRESETS: { id: IconPreset; label: string }[] = [
  { id: "outline", label: "Outline" },
  { id: "bold", label: "Bold" },
  { id: "filled", label: "Filled" },
];

const SWATCHES = ["#e0533d", "#f2a33c", "#e3b341", "#5d8a58", "#2a9d8f", "#d94f6e", "#8f5aa8", "#23252b"] as const;

/** keep only the first grapheme (emoji clusters survive via Intl.Segmenter) */
function firstGrapheme(s: string): string {
  const t = s.trim();
  if (!t) return "";
  try {
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const first = seg.segment(t)[Symbol.iterator]().next();
    return first.value?.segment ?? "";
  } catch {
    return [...t][0] ?? "";
  }
}

function buildIconSvg(name: IconName, color: string, preset: IconPreset): string {
  const d = ICONS[name];
  const attrs =
    preset === "filled"
      ? `fill="${color}" shape-rendering="crispEdges"`
      : `fill="none" stroke="${color}" stroke-width="${preset === "bold" ? 2.6 : 1.5}" stroke-linecap="round" stroke-linejoin="round"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><path d="${d}" ${attrs}/></svg>`;
}

function svgToDataURL(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return `data:image/svg+xml;base64,${btoa(bin)}`;
}

function emojiToDataURL(emoji: string): string {
  try {
    const c = document.createElement("canvas");
    c.width = 96;
    c.height = 96;
    const ctx = c.getContext("2d");
    if (ctx) {
      ctx.clearRect(0, 0, 96, 96);
      ctx.font = "72px 'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(emoji, 48, 54);
      return c.toDataURL("image/png");
    }
  } catch {}
  // canvas unavailable → inline <text> svg (UTF-8 safe encoding)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><text x="12" y="17" font-size="14" text-anchor="middle">${emoji}</text></svg>`;
  return svgToDataURL(svg);
}

export function IconMaker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<IconName>("star");
  const [color, setColor] = useState<string>("#e0533d");
  const [preset, setPreset] = useState<IconPreset>("outline");
  const [mockSize, setMockSize] = useState(18);
  const [emojiOverride, setEmojiOverride] = useState("");
  const [myIcons, setMyIcons] = useState<Record<string, string>>({});
  const [packName, setPackName] = useState(DEFAULT_MAKER_PACK_NAME);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [applied, setApplied] = useState(false);
  const iconPack = usePackStore((s) => s.iconPack);

  // fresh read of the persisted maker pack each time the dialog opens
  useEffect(() => {
    if (!open) return;
    const p = makerPack();
    setMyIcons({ ...(p?.icons ?? {}) });
    setPackName(p?.name ?? DEFAULT_MAKER_PACK_NAME);
    setApplied(false);
    setSaved(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = Object.keys(ICONS) as IconName[];
    return q ? all.filter((id) => id.includes(q)) : all;
  }, [query]);

  // the exact artifact that gets saved — a dataURL rendered through the same
  // custom-icon path (<img>) the pack system uses everywhere
  const generated = useMemo(() => {
    const e = emojiOverride.trim();
    if (e) return emojiToDataURL(e);
    return svgToDataURL(buildIconSvg(selectedId, color, preset));
  }, [selectedId, color, preset, emojiOverride]);

  const entries = useMemo(() => Object.entries(myIcons), [myIcons]);
  const count = entries.length;

  async function addToPack() {
    setBusy(true);
    try {
      await upsertMakerIcon(selectedId, generated, { name: packName });
      setMyIcons({ ...(makerPack()?.icons ?? {}) });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } finally {
      setBusy(false);
    }
  }

  async function removeFromPack(icon: string) {
    setBusy(true);
    try {
      await removeMakerIcon(icon);
      setMyIcons({ ...(makerPack()?.icons ?? {}) });
    } finally {
      setBusy(false);
    }
  }

  async function commitName() {
    const prev = makerPack();
    const name = packName.trim() || DEFAULT_MAKER_PACK_NAME;
    setPackName(name);
    if (prev && prev.name !== name) await savePackToServer({ ...prev, name });
  }

  function useNow() {
    usePackStore.getState().setIconPack(MAKER_PACK_ID);
    persistPackPrefs();
    setApplied(true);
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[95] grid place-items-center bg-black/45 p-4"
      style={{ animation: "fade .2s ease both" }}
      role="dialog"
      aria-modal="true"
      aria-label="Icon maker"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="panel panel-solid scroll max-h-[92vh] w-[min(96vw,660px)] overflow-y-auto rounded-2xl p-5">
        {/* header */}
        <div className="mb-4 flex items-center gap-2">
          <Icon name="wand" size={16} className="text-accent" />
          <span className="label">Icon maker</span>
          <span className="chip">{count} in pack</span>
          <span className="flex-1" />
          <button className="icon-btn !h-7 !w-7" title="Close (Esc)" aria-label="Close icon maker" onClick={onClose}>
            <Icon name="close" size={13} />
          </button>
        </div>

        <div className="grid gap-4 md:grid-cols-[1.25fr_1fr]">
          {/* left: pick + tune */}
          <div className="space-y-4">
            <div>
              <div className="label mb-1.5">1 · Pick an app icon</div>
              <input
                className="input mb-2 w-full"
                placeholder="Filter icons…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Filter icons by name"
              />
              <div
                className="scroll grid max-h-52 grid-cols-[repeat(auto-fill,minmax(36px,1fr))] gap-1 overflow-y-auto rounded-xl border p-1.5"
                style={{ borderColor: "var(--line)", background: "color-mix(in srgb, var(--panel2) 55%, transparent)" }}
              >
                {filtered.map((id) => (
                  <button
                    key={id}
                    type="button"
                    title={id}
                    aria-pressed={selectedId === id}
                    onClick={() => setSelectedId(id)}
                    className="grid h-9 w-full place-items-center rounded-lg transition-transform hover:-translate-y-0.5"
                    style={
                      selectedId === id
                        ? { background: "var(--hl)", boxShadow: "inset 0 0 0 2px var(--accent)" }
                        : undefined
                    }
                  >
                    <Icon name={id} size={18} />
                  </button>
                ))}
                {filtered.length === 0 && <div className="col-span-full p-3 text-center text-[11px] text-dim">No icons match “{query}”.</div>}
              </div>
            </div>

            <div>
              <div className="label mb-1.5">2 · Tune it</div>
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                {SWATCHES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    title={c}
                    aria-label={`Use color ${c}`}
                    aria-pressed={color === c}
                    onClick={() => setColor(c)}
                    className="h-6 w-6 rounded-full border transition-transform hover:scale-110"
                    style={{
                      background: c,
                      borderColor: color === c ? "var(--accent)" : "var(--line)",
                      boxShadow: color === c ? "0 0 0 2px var(--hl)" : undefined,
                    }}
                  />
                ))}
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  title="Custom color"
                  aria-label="Custom base color"
                  className="h-6 w-8 cursor-pointer rounded border bg-transparent p-0"
                  style={{ borderColor: "var(--line)" }}
                />
              </div>
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                {PRESETS.map((p) => (
                  <button key={p.id} type="button" className="chip" data-on={preset === p.id} aria-pressed={preset === p.id} onClick={() => setPreset(p.id)}>
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-dim">
                <label className="flex items-center gap-1.5">
                  Size
                  <input
                    type="range"
                    min={14}
                    max={28}
                    value={mockSize}
                    onChange={(e) => setMockSize(Number(e.target.value))}
                    className="w-24"
                    aria-label="Sidebar icon size"
                  />
                  <span className="font-mono">{mockSize}px</span>
                </label>
                <label className="flex items-center gap-1.5">
                  Emoji override
                  <input
                    className="input !h-7 !w-16 text-center"
                    value={emojiOverride}
                    onChange={(e) => setEmojiOverride(firstGrapheme(e.target.value))}
                    placeholder="—"
                    maxLength={8}
                    aria-label="Emoji override (single emoji)"
                  />
                </label>
                {emojiOverride && (
                  <button type="button" className="chip !py-0" onClick={() => setEmojiOverride("")}>
                    clear emoji
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* right: previews + pack */}
          <div className="space-y-4">
            <div>
              <div className="label mb-1.5">Preview · 64px</div>
              <div
                className="grid min-h-[104px] place-items-center rounded-xl border p-4"
                style={{ borderColor: "var(--line)", background: "color-mix(in srgb, var(--panel2) 55%, transparent)" }}
              >
                <img
                  src={generated}
                  width={64}
                  height={64}
                  alt={`Preview of custom ${selectedId}`}
                  style={{ width: 64, height: 64, objectFit: "contain" }}
                  draggable={false}
                />
              </div>
            </div>

            <div>
              <div className="label mb-1.5">In your sidebar</div>
              <div className="panel w-fit rounded-xl p-1.5" aria-hidden>
                <span className="grid h-9 w-9 place-items-center rounded-lg opacity-60">
                  <Icon name="note" size={Math.min(20, mockSize)} />
                </span>
                <span className="grid h-9 w-9 place-items-center rounded-lg" style={{ background: "var(--hl)" }}>
                  <img src={generated} alt="" width={mockSize} height={mockSize} style={{ width: mockSize, height: mockSize, objectFit: "contain" }} draggable={false} />
                </span>
                <span className="grid h-9 w-9 place-items-center rounded-lg opacity-60">
                  <Icon name="search" size={Math.min(20, mockSize)} />
                </span>
              </div>
            </div>

            <div>
              <div className="label mb-1.5">3 · My pack</div>
              <div className="scroll mb-2 flex max-h-24 flex-wrap gap-1 overflow-y-auto">
                {count === 0 && <span className="text-[11px] text-dim">Nothing yet — tune an icon and add it.</span>}
                {entries.map(([id, url]) => (
                  <span key={id} className="chip !gap-1">
                    <img src={url} alt="" className="h-3.5 w-3.5" style={{ objectFit: "contain" }} draggable={false} />
                    {id}
                    <button
                      type="button"
                      title={`Remove ${id}`}
                      aria-label={`Remove ${id} from pack`}
                      disabled={busy}
                      onClick={() => void removeFromPack(id)}
                      className="ml-0.5 text-[13px] leading-none opacity-60 hover:opacity-100"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <input
                className="input mb-2 w-full"
                value={packName}
                onChange={(e) => setPackName(e.target.value)}
                onBlur={() => void commitName()}
                placeholder="Pack name"
                aria-label="Pack name"
              />
              <div className="flex flex-wrap gap-2">
                <button className="btn btn-accent" disabled={busy} onClick={() => void addToPack()}>
                  <Icon name="plus" size={13} /> Add to my pack
                </button>
                <button className="btn" disabled={count === 0} onClick={useNow}>
                  <Icon name="check" size={13} /> Use pack now
                </button>
              </div>
              <p className="mt-2 text-[11px] leading-snug text-dim">
                {applied || iconPack === MAKER_PACK_ID
                  ? "Your pack is live — icons without a custom version keep their usual look."
                  : "The saved pack shows up in Settings → Pack studio next to the built-ins."}
              </p>
              {saved && (
                <p className="mt-1 text-[11px] text-accent" role="status">
                  “{selectedId}” added to {packName.trim() || DEFAULT_MAKER_PACK_NAME} ✓
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
