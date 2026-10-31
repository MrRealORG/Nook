/**
 * 1.3 "Obsidian style" layout — a real layout mode (Settings ▸ Appearance / onboarding):
 *   ribbon (left icon strip) · file tree · tabbed editor (centre) · right sidebar with
 *   Backlinks / Outline / local Graph. Every view still works in the centre pane; switched-off
 *   features never appear on the ribbon. The local graph is a static SVG (no animation loop).
 */
import { useDeferredValue, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { NoteList } from "@/components/NoteList";
import { NavIcon, META } from "@/components/Rail";
import { ViewHost } from "@/components/ViewHost";
import { RAIL_DEFAULT_ICONS, railOrderOf, useActiveNote, useStore, type View } from "@/lib/store";
import { viewEnabled } from "@/lib/features";
import { parseNote, titleKey } from "@/lib/util";
import "@/obsidian-layout.css";

type RightTab = "backlinks" | "outline" | "graph";

function Ribbon() {
  const view = useStore((s) => s.view);
  const features = useStore((s) => s.features);
  const railOrder = useStore((s) => s.railOrder);
  const railHidden = useStore((s) => s.railHidden);
  const st = useStore.getState;
  const views = railOrderOf(railOrder).filter((v) => v !== "settings" && viewEnabled(features, v) && !railHidden.includes(v));
  return (
    <nav className="obs-ribbon" aria-label="Ribbon" data-testid="obs-ribbon">
      <button className="obs-rb" title="Quick switcher (Ctrl O)" aria-label="Quick switcher" onClick={() => useStore.setState({ switcherOpen: true })}>
        <NavIcon sprite="search" icon="search" size={18} />
      </button>
      <button className="obs-rb" title="Today's daily note" aria-label="Daily note" onClick={() => st().openDailyNote()}>
        <NavIcon sprite="calendar" icon="calendar" size={18} />
      </button>
      <span className="obs-rb-sep" />
      {views.map((v: View) => (
        <button key={v} className="obs-rb" data-on={view === v} title={META[v].label} aria-label={META[v].label} data-testid={`ribbon-${v}`} onClick={() => st().setView(v)}>
          <NavIcon view={v} icon={RAIL_DEFAULT_ICONS[v]} size={18} />
        </button>
      ))}
      <span className="flex-1" />
      <button className="obs-rb" data-on={view === "settings"} title="Settings" aria-label="Settings" onClick={() => st().setView("settings")}>
        <NavIcon view="settings" icon="sliders" size={18} />
      </button>
    </nav>
  );
}

function LocalGraph({ id }: { id: string }) {
  const notes = useDeferredValue(useStore((s) => s.notes));
  const data = useMemo(() => {
    const me = notes.find((n) => n.id === id);
    if (!me) return null;
    const byTitle = new Map(notes.map((n) => [titleKey(n.title), n]));
    const out = parseNote(me.content).links.map((l) => byTitle.get(titleKey(l))).filter(Boolean) as typeof notes;
    const inn = notes.filter((n) => n.id !== id && parseNote(n.content).links.some((l) => titleKey(l) === titleKey(me.title)));
    const all = [...new Map([...out, ...inn].map((n) => [n.id, n])).values()].slice(0, 14);
    return { me, all };
  }, [notes, id]);
  if (!data) return null;
  const R = 78, cx = 120, cy = 104;
  return (
    <svg viewBox="0 0 240 208" className="obs-graph" data-testid="obs-graph" role="img" aria-label="Local graph">
      {data.all.map((n, i) => {
        const a = (i / Math.max(1, data.all.length)) * Math.PI * 2 - Math.PI / 2;
        return <line key={`l${n.id}`} x1={cx} y1={cy} x2={cx + Math.cos(a) * R} y2={cy + Math.sin(a) * R} />;
      })}
      {data.all.map((n, i) => {
        const a = (i / Math.max(1, data.all.length)) * Math.PI * 2 - Math.PI / 2;
        const x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
        return (
          <g key={n.id} className="obs-gn" onClick={() => useStore.getState().openNote(n.id)}>
            <rect x={x - 4} y={y - 4} width={8} height={8} />
            <text x={x} y={y + 15} textAnchor="middle">{(n.title || "Untitled").slice(0, 14)}</text>
          </g>
        );
      })}
      <rect x={cx - 7} y={cy - 7} width={14} height={14} className="obs-gme" />
      <text x={cx} y={cy + 21} textAnchor="middle" className="obs-gme-t">{(data.me.title || "Untitled").slice(0, 18)}</text>
      {data.all.length === 0 && <text x={cx} y={cy + 44} textAnchor="middle" className="obs-g-empty">No links yet — try [[a note]]</text>}
    </svg>
  );
}

function RightSidebar() {
  const [tab, setTab] = useState<RightTab>("backlinks");
  const note = useActiveNote();
  const notes = useStore((s) => s.notes);
  const content = useDeferredValue(note?.content ?? "");
  const meta = useMemo(() => parseNote(content), [content]);
  const backlinks = useMemo(() => (note ? notes.filter((n) => n.id !== note.id && parseNote(n.content).links.some((l) => titleKey(l) === titleKey(note.title))) : []), [notes, note]);
  const st = useStore.getState;
  return (
    <aside className="obs-right" data-testid="obs-right">
      <div className="obs-rtabs" role="tablist">
        {([["backlinks", "link", "Backlinks"], ["outline", "bulletlist", "Outline"], ["graph", "algorithm", "Graph"]] as const).map(([id, ic, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} data-on={tab === id} title={label} data-testid={`obs-tab-${id}`} onClick={() => setTab(id)}>
            <Icon name={ic} size={14} /> <span>{label}</span>
          </button>
        ))}
      </div>
      <div className="scroll obs-rbody">
        {!note && <div className="obs-empty">Open a note to see its links and outline.</div>}
        {note && tab === "backlinks" && (
          <>
            <div className="obs-h">Linked mentions · {backlinks.length}</div>
            {backlinks.map((n) => (
              <button key={n.id} className="obs-item" onClick={() => st().openNote(n.id)}>
                <Icon name="note" size={12} /> <span className="truncate">{n.title || "Untitled"}</span>
              </button>
            ))}
            {backlinks.length === 0 && <div className="obs-empty">No backlinks yet.</div>}
            <div className="obs-h mt-3">Outgoing links · {meta.links.length}</div>
            {meta.links.map((l, i) => (
              <button key={i} className="obs-item" onClick={() => st().openByTitle(l)}>
                <Icon name="link" size={12} /> <span className="truncate">{l}</span>
              </button>
            ))}
          </>
        )}
        {note && tab === "outline" && (
          <>
            {meta.headings.map((h, i) => (
              <button key={i} className="obs-item" style={{ paddingLeft: 8 + (h.level - 1) * 12 }} onClick={() => window.dispatchEvent(new CustomEvent("nook:jump", { detail: { line: h.line, idx: i } }))}>
                <span className="obs-hl">H{h.level}</span> <span className="truncate">{h.text}</span>
              </button>
            ))}
            {meta.headings.length === 0 && <div className="obs-empty">No headings — add one with “# ”.</div>}
          </>
        )}
        {note && tab === "graph" && <LocalGraph id={note.id} />}
      </div>
    </aside>
  );
}

export default function ObsidianLayout() {
  const [left, setLeft] = useState(true);
  const [right, setRight] = useState(true);
  return (
    <div className="obs-layout" data-testid="obsidian-layout">
      <Ribbon />
      {left && (
        <div className="obs-left" data-testid="obs-left">
          <NoteList embedded />
        </div>
      )}
      <main className="obs-center">
        <div className="obs-center-bar">
          <button className="icon-btn !h-7 !w-7" onClick={() => setLeft(!left)} title={left ? "Hide file tree" : "Show file tree"} aria-label="Toggle file tree">
            <Icon name="layout" size={14} />
          </button>
          <span className="flex-1" />
          <button className="icon-btn !h-7 !w-7" onClick={() => setRight(!right)} title={right ? "Hide right sidebar" : "Show right sidebar"} aria-label="Toggle right sidebar">
            <Icon name="text-colums" size={14} />
          </button>
        </div>
        <ViewHost />
      </main>
      {right && <RightSidebar />}
    </div>
  );
}
