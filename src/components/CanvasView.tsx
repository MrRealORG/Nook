"use client";

import { memo, useEffect, useRef, useState, type PointerEvent as RPE } from "react";
import { Icon } from "@/components/Icon";
import { useStore } from "@/lib/store";
import type { Canvas, CanvasData, CanvasNode } from "@/lib/types";
import { clamp, parseNote, uid } from "@/lib/util";

const ASSETS = [
  { src: "/art/hero.webp", name: "Moon lake" },
  { src: "/art/den.webp", name: "Cozy den" },
  { src: "/art/cover-peaks.webp", name: "Peaks" },
  { src: "/art/cover-city.webp", name: "City" },
  { src: "/art/cover-forest.webp", name: "Forest" },
  { src: "/art/plant.webp", name: "Plant" },
];
const TONES = [
  "var(--panel-solid)",
  "color-mix(in srgb, var(--accent) 16%, var(--panel-solid))",
  "color-mix(in srgb, var(--ink) 9%, var(--panel-solid))",
  "color-mix(in srgb, var(--accent) 34%, var(--panel-solid))",
  "color-mix(in srgb, #7fc48f 22%, var(--panel-solid))",
  "color-mix(in srgb, #e08a6a 22%, var(--panel-solid))",
];
const PEN_COLORS = ["var(--accent)", "#7fc48f", "#e08a6a", "#d9c98a", "#e9ebee", "#c98279"];
const GRID = 28;
const snapv = (v: number, on: boolean) => (on ? Math.round(v / GRID) * GRID : Math.round(v));

type Anchor = { x: number; y: number; dx: number; dy: number };
function strokePath(points: number[]): string {
  let d = "";
  for (let i = 0; i < points.length; i += 2) d += (i === 0 ? "M" : "L") + points[i] + " " + points[i + 1] + " ";
  return d;
}
function anchor(n: CanvasNode, ox: number, oy: number): Anchor {
  const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
  const vx = ox - cx, vy = oy - cy;
  if (Math.abs(vx) / n.w > Math.abs(vy) / n.h) return { x: vx > 0 ? n.x + n.w : n.x, y: cy, dx: vx > 0 ? 1 : -1, dy: 0 };
  return { x: cx, y: vy > 0 ? n.y + n.h : n.y, dx: 0, dy: vy > 0 ? 1 : -1 };
}
function curve(a: Anchor, b: Anchor) {
  const k = clamp(Math.hypot(b.x - a.x, b.y - a.y) * 0.4, 40, 170);
  const c1 = [a.x + a.dx * k, a.y + a.dy * k], c2 = [b.x + b.dx * k, b.y + b.dy * k];
  return { d: `M${a.x} ${a.y} C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${b.x} ${b.y}`, mx: (a.x + 3 * c1[0] + 3 * c2[0] + b.x) / 8, my: (a.y + 3 * c1[1] + 3 * c2[1] + b.y) / 8 };
}

type CardProps = {
  n: CanvasNode;
  selected: boolean;
  smooth: boolean;
  onDown: (e: RPE, n: CanvasNode) => void;
  onResize: (e: RPE, n: CanvasNode) => void;
  onConnect: (e: RPE, n: CanvasNode) => void;
  onDelete: (id: string) => void;
  onText: (id: string, t: string) => void;
  onTone: (id: string) => void;
};

const Card = memo(function Card({ n, selected, smooth, onDown, onResize, onConnect, onDelete, onText, onTone }: CardProps) {
  const note = useStore((s) => (n.type === "note" ? s.notes.find((x) => x.id === n.noteId) : undefined));
  const meta = note ? parseNote(note.content) : null;
  const st = useStore.getState;
  const dots: [string, React.CSSProperties][] = [
    ["r", { right: -7, top: "50%", marginTop: -6 }], ["l", { left: -7, top: "50%", marginTop: -6 }],
    ["t", { top: -7, left: "50%", marginLeft: -6 }], ["b", { bottom: -7, left: "50%", marginLeft: -6 }],
  ];
  return (
    <div
      data-card={n.id}
      className="group/card paper absolute flex flex-col"
      style={{
        left: n.x, top: n.y, width: n.w, height: n.h,
        background: n.type === "text" ? TONES[n.tone ?? 0] : undefined,
        boxShadow: selected ? "0 0 0 2px var(--accent), 0 18px 40px -16px rgba(0,0,0,.6)" : "0 10px 30px -18px rgba(0,0,0,.55)",
        transition: smooth ? "left .45s var(--ease-soft), top .45s var(--ease-soft), width .3s, height .3s" : "box-shadow .2s",
        zIndex: selected ? 5 : 1,
      }}
      onPointerDown={(e) => onDown(e, n)}
      onDoubleClick={() => n.type === "note" && n.noteId && st().openNote(n.noteId)}
    >
      <div className="flex h-8 flex-none cursor-grab items-center gap-1.5 px-2.5 text-faint active:cursor-grabbing">
        <Icon name={n.type === "note" ? "note" : n.type === "image" ? "image" : "sticky-note"} size={13} />
        <span className="tiny-font text-[9px] tracking-wider">{n.type === "note" ? "NOTE" : n.type === "image" ? "ART" : "STICKY"}</span>
        <span className="flex-1" />
        <span className="flex gap-0.5 opacity-0 transition-opacity group-hover/card:opacity-100" style={{ opacity: selected ? 1 : undefined }}>
          {n.type === "text" && <button className="icon-btn !h-6 !w-6 !rounded-md" onPointerDown={(e) => e.stopPropagation()} onClick={() => onTone(n.id)} title="Change tint"><Icon name="circle" size={13} /></button>}
          {n.type === "note" && n.noteId && <button className="icon-btn !h-6 !w-6 !rounded-md" onPointerDown={(e) => e.stopPropagation()} onClick={() => st().openNote(n.noteId!)} title="Open note"><Icon name="external-link" size={13} /></button>}
          <button className="icon-btn !h-6 !w-6 !rounded-md" onPointerDown={(e) => e.stopPropagation()} onClick={() => onDelete(n.id)} title="Remove"><Icon name="close" size={13} /></button>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden px-3.5 pb-3">
        {n.type === "note" &&
          (note ? (
            <>
              <div className="pixel-font text-[18px] leading-tight">{note.title}</div>
              <div className="mt-1.5 text-[12.5px] leading-snug text-dim" style={{ display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: Math.max(2, Math.floor((n.h - 90) / 17)), overflow: "hidden" }}>{meta?.snippet}</div>
              {meta && meta.tags.length > 0 && n.h > 120 && <div className="mt-2 flex flex-wrap gap-1">{meta.tags.slice(0, 3).map((t) => <span key={t} className="pixel-font text-[12px] text-accent">#{t}</span>)}</div>}
            </>
          ) : (
            <div className="pixel-font text-[14px] text-faint">Note was deleted</div>
          ))}
        {n.type === "text" && (
          <textarea
            className="pixel-font selectable h-full w-full resize-none bg-transparent text-[16px] leading-snug outline-none"
            value={n.text ?? ""}
            placeholder="Write something…"
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => onText(n.id, e.target.value)}
          />
        )}
        {n.type === "image" && (
           
          <img src={n.src} alt="" draggable={false} loading="lazy" decoding="async" className="h-full w-full rounded-lg object-cover" />
        )}
      </div>
      <div className="absolute bottom-0 right-0 h-5 w-5 cursor-nwse-resize opacity-0 transition-opacity group-hover/card:opacity-100" style={{ opacity: selected ? 1 : undefined }} onPointerDown={(e) => onResize(e, n)}>
        <svg viewBox="0 0 10 10" className="h-full w-full text-faint" fill="currentColor"><rect x="6" y="2" width="2" height="2" /><rect x="2" y="6" width="2" height="2" /><rect x="6" y="6" width="2" height="2" /></svg>
      </div>
      {dots.map(([k, s]) => (
        <span key={k} onPointerDown={(e) => onConnect(e, n)} className="absolute z-10 h-3 w-3 cursor-crosshair rounded-[3px] border-2 border-accent bg-panel-solid opacity-0 transition-all hover:scale-150 group-hover/card:opacity-100" style={{ ...s, opacity: selected ? 1 : undefined, background: "var(--panel-solid)" }} />
      ))}
    </div>
  );
});

function Board({ canvas }: { canvas: Canvas }) {
  const id = canvas.id;
  const data = canvas.data;
  const box = useRef<HTMLDivElement>(null);
  const mini = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState(data.view);
  const [sel, setSel] = useState<string[]>([]);
  const [tmp, setTmp] = useState<{ x: number; y: number; from: string } | null>(null);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  const [menu, setMenu] = useState<null | "boards" | "note" | "image" | "import-export">(null);
  const [editing, setEditing] = useState(false);
  const [smooth, setSmooth] = useState(false);
  const [q, setQ] = useState("");
  const [url, setUrl] = useState("");
  // ---- new: draw tool / undo-redo / grid-snap ----
  const [tool, setTool] = useState<"move" | "pen" | "eraser">("move");
  const [penColor, setPenColor] = useState(PEN_COLORS[0]);
  const [penW, setPenW] = useState(3);
  const [gridOn, setGridOn] = useState(true);
  const [snapOn, setSnapOn] = useState(false);
  const past = useRef<CanvasData[]>([]);
  const future = useRef<CanvasData[]>([]);
  const [histLen, setHistLen] = useState(0);
  const notes = useStore((s) => s.notes);
  const canvases = useStore((s) => s.canvases);
  const R = useRef({ view, data, sel });
  useEffect(() => {
    R.current = { view, data, sel };
  });
  const st = useStore.getState;
  const pushUndo = () => {
    past.current = [...past.current.slice(-39), JSON.parse(JSON.stringify(R.current.data)) as CanvasData];
    future.current = [];
    setHistLen(past.current.length);
  };
  const mutate = (fn: (d: CanvasData) => CanvasData, record = true) => {
    if (record) pushUndo();
    st().setCanvasData(id, fn);
  };
  const undo = () => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current = [...future.current, JSON.parse(JSON.stringify(R.current.data)) as CanvasData];
    st().setCanvasData(id, () => prev);
    setHistLen(past.current.length);
    sfxSafe("move");
  };
  const redo = () => {
    const next = future.current.pop();
    if (!next) return;
    past.current = [...past.current, JSON.parse(JSON.stringify(R.current.data)) as CanvasData];
    st().setCanvasData(id, () => next);
    setHistLen(past.current.length);
    sfxSafe("move");
  };
  const sfxSafe = (n: "move" | "pop" | "star") => void import("@/lib/sfx").then((m) => m.sfx(n)).catch(() => {});
  const byId = new Map(data.nodes.map((n) => [n.id, n]));

  // persist the viewport (debounced)
  useEffect(() => {
    const v = R.current.data.view;
    if (v.x === view.x && v.y === view.y && v.z === view.z) return;
    const t = setTimeout(() => mutate((d) => ({ ...d, view })), 700);
    return () => clearTimeout(t);
     
  }, [view]);

  useEffect(() => {
    const el = box.current!;
    const h = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const v = R.current.view;
      const z2 = clamp(v.z * Math.exp(-e.deltaY * 0.0016), 0.15, 2.5);
      const mx = e.clientX - r.left, my = e.clientY - r.top, k = z2 / v.z;
      setView({ z: z2, x: mx - (mx - v.x) * k, y: my - (my - v.y) * k });
    };
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, []);

  const toWorld = (cx: number, cy: number) => {
    const r = box.current!.getBoundingClientRect();
    const v = R.current.view;
    return { x: (cx - r.left - v.x) / v.z, y: (cy - r.top - v.y) / v.z };
  };
  const track = (move: (e: PointerEvent) => void, end: (e: PointerEvent) => void) => {
    const up = (e: PointerEvent) => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); end(e); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const flash = () => { setSmooth(true); setTimeout(() => setSmooth(false), 600); };

  const onBgDown = (e: RPE) => {
    if (e.button !== 0 && e.button !== 1) return;
    setMenu(null);
    box.current?.focus();
    // ---- pen: freehand draw a stroke as a live "draw" node ----
    if (tool === "pen" && e.button === 0) {
      const p0 = toWorld(e.clientX, e.clientY);
      const node: CanvasNode = { id: uid(), type: "draw", x: p0.x, y: p0.y, w: 1, h: 1, points: [p0.x, p0.y], color: penColor, sw: penW };
      mutate((d) => ({ ...d, nodes: [...d.nodes, node] }));
      let pts: number[] = [p0.x, p0.y];
      let minX = p0.x, minY = p0.y, maxX = p0.x, maxY = p0.y;
      track(
        (ev) => {
          const p = toWorld(ev.clientX, ev.clientY);
          if (Math.hypot(p.x - pts[pts.length - 2], p.y - pts[pts.length - 1]) < 2.5) return;
          pts = [...pts, p.x, p.y];
          minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
          st().setCanvasData(id, (d) => ({ ...d, nodes: d.nodes.map((m) => (m.id === node.id ? { ...m, points: pts, x: minX, y: minY, w: maxX - minX, h: maxY - minY } : m)) }));
        },
        () => {},
      );
      return;
    }
    // ---- eraser: scrub draw strokes away ----
    if (tool === "eraser" && e.button === 0) {
      const eraseAt = (cx: number, cy: number) => {
        const p = toWorld(cx, cy);
        const hit = R.current.data.nodes.filter((n) => n.type === "draw" && n.points && n.points.some((v, i) => i % 2 === 0 && Math.hypot(v - p.x, n.points![i + 1] - p.y) < 14));
        if (hit.length) {
          const ids = hit.map((n) => n.id);
          mutate((d) => ({ ...d, nodes: d.nodes.filter((n) => !ids.includes(n.id)) }));
          sfxSafe("move");
        }
      };
      eraseAt(e.clientX, e.clientY);
      track(
        (ev) => eraseAt(ev.clientX, ev.clientY),
        () => {},
      );
      return;
    }
    const sx = e.clientX, sy = e.clientY, v0 = R.current.view;
    let moved = false;
    track(
      (ev) => { const dx = ev.clientX - sx, dy = ev.clientY - sy; if (Math.hypot(dx, dy) > 3) moved = true; setView({ ...v0, x: v0.x + dx, y: v0.y + dy }); },
      () => { if (!moved) setSel([]); },
    );
  };

  const onCardDown = (e: RPE, n: CanvasNode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    box.current?.focus();
    setMenu(null);
    let ids = R.current.sel;
    if (!ids.includes(n.id)) ids = e.shiftKey ? [...ids, n.id] : [n.id];
    setSel(ids);
    pushUndo();
    const orig = new Map(R.current.data.nodes.filter((x) => ids.includes(x.id)).map((x) => [x.id, { x: x.x, y: x.y }]));
    const sx = e.clientX, sy = e.clientY;
    let raf = 0, last: PointerEvent | null = null, moved = false;
    const apply = () => {
      raf = 0;
      if (!last) return;
      const z = R.current.view.z, dx = (last.clientX - sx) / z, dy = (last.clientY - sy) / z;
      mutate((d) => ({ ...d, nodes: d.nodes.map((m) => { const o = orig.get(m.id); return o ? { ...m, x: snapv(o.x + dx, snapOn), y: snapv(o.y + dy, snapOn) } : m; }) }), false);
    };
    track(
      (ev) => { if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return; moved = true; last = ev; if (!raf) raf = requestAnimationFrame(apply); },
      () => { if (raf) cancelAnimationFrame(raf); if (moved) apply(); },
    );
  };

  const onResize = (e: RPE, n: CanvasNode) => {
    e.stopPropagation();
    const sx = e.clientX, sy = e.clientY;
    let raf = 0, last: PointerEvent | null = null;
    const apply = () => {
      raf = 0;
      if (!last) return;
      const z = R.current.view.z;
      mutate((d) => ({ ...d, nodes: d.nodes.map((m) => (m.id === n.id ? { ...m, w: Math.max(150, Math.round(n.w + (last!.clientX - sx) / z)), h: Math.max(90, Math.round(n.h + (last!.clientY - sy) / z)) } : m)) }));
    };
    track((ev) => { last = ev; if (!raf) raf = requestAnimationFrame(apply); }, () => { if (raf) cancelAnimationFrame(raf); apply(); });
  };

  const onConnect = (e: RPE, n: CanvasNode) => {
    e.stopPropagation();
    e.preventDefault();
    setTmp({ ...toWorld(e.clientX, e.clientY), from: n.id });
    track(
      (ev) => setTmp({ ...toWorld(ev.clientX, ev.clientY), from: n.id }),
      (ev) => {
        setTmp(null);
        const to = document.elementFromPoint(ev.clientX, ev.clientY)?.closest("[data-card]")?.getAttribute("data-card");
        const es = R.current.data.edges;
        if (to && to !== n.id && !es.some((x) => (x.from === n.id && x.to === to) || (x.from === to && x.to === n.id))) mutate((d) => ({ ...d, edges: [...d.edges, { id: uid(), from: n.id, to }] }));
      },
    );
  };

  const removeIds = (ids: string[]) => {
    mutate((d) => ({ ...d, nodes: d.nodes.filter((n) => !ids.includes(n.id)), edges: d.edges.filter((e) => !ids.includes(e.from) && !ids.includes(e.to)) }));
    setSel([]);
  };

  const add = (p: Partial<CanvasNode> & { type: CanvasNode["type"] }, at?: { x: number; y: number }) => {
    const r = box.current!.getBoundingClientRect();
    const c = at ?? toWorld(r.left + r.width / 2, r.top + r.height / 2);
    const w = p.w ?? 240, h = p.h ?? 150, j = () => (at ? 0 : (Math.random() - 0.5) * 70);
    const node: CanvasNode = { id: uid(), x: snapv(c.x - w / 2 + j(), snapOn), y: snapv(c.y - h / 2 + j(), snapOn), w, h, ...p };
    mutate((d) => ({ ...d, nodes: [...d.nodes, node] }));
    setSel([node.id]);
    setMenu(null);
    return node;
  };

  const exportBoard = () => {
    const blob = new Blob([JSON.stringify({ app: "nook-board", name: canvas.name, data: R.current.data }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${canvas.name.replace(/[^\w-]+/g, "_") || "board"}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    setMenu(null);
    sfxSafe("pop");
    st().toast("Board exported as JSON", "download");
  };

  const importBoard = async (file: File) => {
    try {
      const j = JSON.parse(await file.text()) as { app?: string; data?: CanvasData };
      if (!j?.data?.nodes) throw new Error("bad");
      pushUndo();
      st().setCanvasData(id, () => j.data!);
      setMenu(null);
      sfxSafe("star");
      st().toast(`Imported ${j.data.nodes.length} items into “${canvas.name}”`, "upload");
      setTimeout(fit, 100);
    } catch {
      st().toast("That file wasn't a Nook board export", "close");
    }
  };

  const fit = () => {
    const ns = R.current.data.nodes;
    const r = box.current!.getBoundingClientRect();
    flash();
    if (!ns.length) return setView({ x: 0, y: 0, z: 1 });
    const x0 = Math.min(...ns.map((n) => n.x)), y0 = Math.min(...ns.map((n) => n.y));
    const x1 = Math.max(...ns.map((n) => n.x + n.w)), y1 = Math.max(...ns.map((n) => n.y + n.h));
    const z = clamp(Math.min((r.width - 140) / (x1 - x0), (r.height - 200) / (y1 - y0)), 0.2, 1.4);
    setView({ z, x: (r.width - (x1 - x0) * z) / 2 - x0 * z, y: (r.height - (y1 - y0) * z) / 2 - y0 * z - 20 });
  };

  const tidy = () => {
    const ns = [...R.current.data.nodes].sort((a, b) => a.y - b.y || a.x - b.x);
    if (!ns.length) return;
    const cols = Math.ceil(Math.sqrt(ns.length * 1.4));
    const cw = Math.max(...ns.map((n) => n.w)) + 56;
    const rowH: number[] = [];
    ns.forEach((n, i) => { const r = Math.floor(i / cols); rowH[r] = Math.max(rowH[r] ?? 0, n.h); });
    const tops: number[] = [];
    rowH.reduce((acc, h, i) => { tops[i] = acc; return acc + h + 56; }, 0);
    const pos = new Map(ns.map((n, i) => [n.id, { x: (i % cols) * cw, y: tops[Math.floor(i / cols)] }]));
    flash();
    mutate((d) => ({ ...d, nodes: d.nodes.map((n) => ({ ...n, ...(pos.get(n.id) ?? {}) })) }));
    setTimeout(fit, 80);
  };

  // minimap
  useEffect(() => {
    const c = mini.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    const ns = data.nodes;
    ctx.clearRect(0, 0, c.width, c.height);
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const vx0 = -view.x / view.z, vy0 = -view.y / view.z, vw = r.width / view.z, vh = r.height / view.z;
    const x0 = Math.min(vx0, ...ns.map((n) => n.x)) - 40, y0 = Math.min(vy0, ...ns.map((n) => n.y)) - 40;
    const x1 = Math.max(vx0 + vw, ...ns.map((n) => n.x + n.w)) + 40, y1 = Math.max(vy0 + vh, ...ns.map((n) => n.y + n.h)) + 40;
    const s = Math.min(c.width / (x1 - x0), c.height / (y1 - y0));
    const cs = getComputedStyle(document.documentElement);
    ctx.fillStyle = cs.getPropertyValue("--dim").trim() || "#999";
    ctx.globalAlpha = 0.8;
    for (const n of ns) ctx.fillRect((n.x - x0) * s, (n.y - y0) * s, Math.max(2, n.w * s), Math.max(2, n.h * s));
    ctx.globalAlpha = 1;
    ctx.strokeStyle = cs.getPropertyValue("--accent").trim() || "#fff";
    ctx.lineWidth = 2;
    ctx.strokeRect((vx0 - x0) * s, (vy0 - y0) * s, vw * s, vh * s);
  }, [data.nodes, view]);

  const usedNotes = new Set(data.nodes.map((n) => n.noteId));
  const pickNotes = notes.filter((n) => n.title.toLowerCase().includes(q.toLowerCase())).slice(0, 30);

  return (
    <div
      ref={box}
      tabIndex={-1}
      className="panel relative h-full overflow-hidden rounded-[20px] outline-none"
      style={{ backgroundImage: `radial-gradient(circle, var(--grid) 1.3px, transparent 1.7px), linear-gradient(160deg, var(--hi), transparent 38%)`, backgroundSize: `${(gridOn ? GRID : 0) * view.z}px ${(gridOn ? GRID : 0) * view.z}px, auto`, backgroundPosition: `${view.x}px ${view.y}px, 0 0`, cursor: tool === "pen" ? "crosshair" : tool === "eraser" ? "cell" : "grab" }}
      onPointerDown={onBgDown}
      onDoubleClick={(e) => { if (tool === "move" && (e.target === e.currentTarget || (e.target as HTMLElement).dataset.world)) add({ type: "text", text: "", w: 220, h: 130 }, toWorld(e.clientX, e.clientY)); }}
      onKeyDown={(e) => {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "TEXTAREA" || tag === "INPUT") return;
        const mod = e.ctrlKey || e.metaKey;
        if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
        else if ((e.key === "Delete" || e.key === "Backspace") && sel.length) { e.preventDefault(); removeIds(sel); }
        else if (e.key === "Escape") { setSel([]); setTool("move"); }
        else if (e.key === "p" && !mod) setTool((t) => (t === "pen" ? "move" : "pen"));
        else if (e.key === "e" && !mod) setTool((t) => (t === "eraser" ? "move" : "eraser"));
        else if (e.key.startsWith("Arrow") && sel.length) {
          e.preventDefault();
          const d = e.shiftKey ? GRID : 1;
          const dx = e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0;
          const dy = e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0;
          mutate((dd) => ({ ...dd, nodes: dd.nodes.map((m) => (sel.includes(m.id) ? { ...m, x: m.x + dx, y: m.y + dy } : m)) }));
        }
        else if (mod && e.key === "d" && sel.length) {
          e.preventDefault();
          const copies = data.nodes.filter((n) => sel.includes(n.id)).map((n) => ({ ...n, id: uid(), x: n.x + 28, y: n.y + 28 }));
          mutate((d) => ({ ...d, nodes: [...d.nodes, ...copies] }));
          setSel(copies.map((c) => c.id));
        } else if (mod && e.key === "a") { e.preventDefault(); setSel(data.nodes.map((n) => n.id)); }
      }}
    >
      <div data-world="1" className="absolute left-0 top-0 h-0 w-0" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`, transformOrigin: "0 0", transition: smooth ? "transform .5s var(--ease-soft)" : undefined }}>
        <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width="1" height="1">
          <defs>
            <marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z" fill="var(--accent)" /></marker>
          </defs>
          {data.nodes.filter((n) => n.type === "draw" && n.points && n.points.length >= 2).map((n) => (
            <path
              key={n.id}
              d={strokePath(n.points!)}
              fill="none"
              stroke={n.color ?? "var(--accent)"}
              strokeWidth={n.sw ?? 3}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
          {data.edges.map((e) => {
            const a = byId.get(e.from), b = byId.get(e.to);
            if (!a || !b) return null;
            const A = anchor(a, b.x + b.w / 2, b.y + b.h / 2), B = anchor(b, a.x + a.w / 2, a.y + a.h / 2);
            const c = curve(A, B);
            const hot = hoverEdge === e.id || sel.includes(e.from) || sel.includes(e.to);
            return (
              <g key={e.id}>
                <path d={c.d} fill="none" stroke={hot ? "var(--accent)" : "var(--dim)"} strokeWidth={hot ? 3 : 2.4} strokeDasharray="3 6" strokeLinecap="square" markerEnd="url(#arr)" style={{ animation: "dash 1.1s linear infinite", opacity: hot ? 1 : 0.7 }} />
                <path d={c.d} fill="none" stroke="transparent" strokeWidth={18} style={{ pointerEvents: "stroke", cursor: "pointer" }} onPointerEnter={() => setHoverEdge(e.id)} onPointerLeave={() => setHoverEdge((h) => (h === e.id ? null : h))} onPointerDown={(ev) => ev.stopPropagation()} onDoubleClick={() => mutate((d) => ({ ...d, edges: d.edges.filter((x) => x.id !== e.id) }))} />
              </g>
            );
          })}
          {tmp && byId.get(tmp.from) && (() => { const n = byId.get(tmp.from)!; const c = curve(anchor(n, tmp.x, tmp.y), { x: tmp.x, y: tmp.y, dx: 0, dy: 0 }); return <path d={c.d} fill="none" stroke="var(--accent)" strokeWidth={2.6} strokeDasharray="3 5" />; })()}
        </svg>
        {data.edges.map((e) => {
          if (hoverEdge !== e.id) return null;
          const a = byId.get(e.from), b = byId.get(e.to);
          if (!a || !b) return null;
          const c = curve(anchor(a, b.x + b.w / 2, b.y + b.h / 2), anchor(b, a.x + a.w / 2, a.y + a.h / 2));
          return (
            <button key={e.id} className="btn btn-sm absolute z-20 !h-7 !w-7 !rounded-full !px-0" style={{ left: c.mx - 14, top: c.my - 14, transform: `scale(${1 / view.z})` }} onPointerEnter={() => setHoverEdge(e.id)} onPointerDown={(ev) => ev.stopPropagation()} onClick={() => mutate((d) => ({ ...d, edges: d.edges.filter((x) => x.id !== e.id) }))} title="Remove connection">
              <Icon name="close" size={12} />
            </button>
          );
        })}
        {data.nodes.filter((n) => n.type !== "draw").map((n) => (
          <Card key={n.id} n={n} selected={sel.includes(n.id)} smooth={smooth} onDown={onCardDown} onResize={onResize} onConnect={onConnect} onDelete={(i) => removeIds([i])} onText={(i, t) => mutate((d) => ({ ...d, nodes: d.nodes.map((m) => (m.id === i ? { ...m, text: t } : m)) }))} onTone={(i) => mutate((d) => ({ ...d, nodes: d.nodes.map((m) => (m.id === i ? { ...m, tone: ((m.tone ?? 0) + 1) % TONES.length } : m)) }))} />
        ))}
      </div>

      {data.nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="pixel-font text-center text-[16px] text-dim"><div className="mb-2 text-[22px] text-ink">An empty board</div>Double-click to drop a sticky · add notes & art from the toolbar</div>
        </div>
      )}

      {/* board switcher */}
      <div className="absolute left-4 top-4 z-20" onPointerDown={(e) => e.stopPropagation()}>
        <div className="panel panel-solid flex items-center gap-1 rounded-2xl p-1.5" style={{ backdropFilter: "none" }}>
          <Icon name="shapes" size={16} className="ml-2 text-accent" />
          {editing ? (
            <input autoFocus className="input !h-8 !w-[170px]" defaultValue={canvas.name} onBlur={(e) => { st().renameCanvas(id, e.target.value); setEditing(false); }} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
          ) : (
            <button className="pixel-font max-w-[190px] truncate px-2 text-[16px]" onDoubleClick={() => setEditing(true)} onClick={() => setMenu(menu === "boards" ? null : "boards")} title="Double-click to rename">{canvas.name}</button>
          )}
          <button className="icon-btn !h-8 !w-8" onClick={() => setMenu(menu === "boards" ? null : "boards")}><Icon name="chevron-down" size={14} /></button>
        </div>
        {menu === "boards" && (
          <div className="menu panel panel-solid mt-2 w-[240px] p-1.5" style={{ backdropFilter: "none", transformOrigin: "top left" }}>
            {canvases.map((c) => (
              <button key={c.id} className="pixel-font flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[15px] hover:bg-panel2" style={{ color: c.id === id ? "var(--accent)" : undefined }} onClick={() => { useStore.setState({ activeCanvas: c.id }); setMenu(null); }}>
                <Icon name="shapes" size={14} />
                <span className="flex-1 truncate">{c.name}</span>
                <span className="text-[12px] text-faint">{c.data.nodes.length}</span>
              </button>
            ))}
            <div className="my-1 h-px bg-line" />
            <button className="pixel-font flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[15px] hover:bg-panel2" onClick={() => { st().createCanvas(); setMenu(null); }}><Icon name="plus" size={14} /> New board</button>
            <button className="pixel-font flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[15px] hover:bg-panel2" onClick={exportBoard}><Icon name="download" size={14} /> Export board (JSON)</button>
            <label className="pixel-font flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-[15px] hover:bg-panel2">
              <Icon name="upload" size={14} /> Import a board…
              <input type="file" accept="application/json" className="hidden" onChange={(e) => e.target.files?.[0] && void importBoard(e.target.files[0])} />
            </label>
            {canvases.length > 1 && <button className="pixel-font flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[15px] text-[#c98279] hover:bg-panel2" onClick={() => { st().deleteCanvas(id); setMenu(null); }}><Icon name="trash" size={14} /> Delete this board</button>}
          </div>
        )}
      </div>

      {/* minimap */}
      <div className="panel panel-solid absolute right-4 top-4 z-10 overflow-hidden rounded-xl p-1.5" style={{ backdropFilter: "none" }} onPointerDown={(e) => e.stopPropagation()}>
        <canvas ref={mini} width={170} height={104} className="block rounded-lg" style={{ background: "var(--panel2)" }} />
      </div>

      {/* toolbar */}
      <div className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2" onPointerDown={(e) => e.stopPropagation()}>
        {menu === "note" && (
          <div className="menu panel panel-solid absolute bottom-[58px] left-0 w-[290px] p-2" style={{ backdropFilter: "none", transformOrigin: "bottom left" }}>
            <input autoFocus className="input mb-1.5" placeholder="Find a note…" value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="scroll max-h-[260px]">
              <button className="pixel-font flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[15px] text-accent hover:bg-panel2" onClick={() => { const id2 = st().createNote({ title: "Canvas note", content: "# Canvas note\n\n" }); useStore.setState({ view: "canvas" }); add({ type: "note", noteId: id2, w: 250, h: 150 }); }}><Icon name="plus" size={14} /> New note card</button>
              {pickNotes.map((n) => (
                <button key={n.id} className="pixel-font flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[15px] hover:bg-panel2" onClick={() => add({ type: "note", noteId: n.id, w: 250, h: 150 })}>
                  <span className="flex-1 truncate">{n.title}</span>
                  {usedNotes.has(n.id) && <span className="text-[11px] text-faint">on board</span>}
                </button>
              ))}
            </div>
          </div>
        )}
        {menu === "image" && (
          <div className="menu panel panel-solid absolute bottom-[58px] left-0 w-[330px] p-2.5" style={{ backdropFilter: "none", transformOrigin: "bottom left" }}>
            <div className="label mb-2">Pixel art assets</div>
            <div className="grid grid-cols-3 gap-2">
              {ASSETS.map((a) => (
                <button key={a.src} className="group relative aspect-[4/3] overflow-hidden rounded-xl border border-line" onClick={() => add({ type: "image", src: a.src, w: 280, h: 170 })}>
                  { }
                  <img src={a.src} alt={a.name} loading="lazy" className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-110" />
                  <span className="pixel-font absolute inset-x-0 bottom-0 bg-black/55 px-1.5 py-0.5 text-left text-[11.5px] text-white">{a.name}</span>
                </button>
              ))}
            </div>
            <div className="mt-2.5 flex gap-1.5">
              <input className="input" placeholder="…or paste an image URL" value={url} onChange={(e) => setUrl(e.target.value)} />
              <button className="btn btn-sm !h-[34px]" disabled={!/^https?:\/\//.test(url)} onClick={() => { add({ type: "image", src: url, w: 280, h: 190 }); setUrl(""); }}>Add</button>
            </div>
          </div>
        )}
        <div className="panel panel-solid flex flex-wrap items-center justify-center gap-1 rounded-2xl p-1.5" style={{ backdropFilter: "none" }}>
          <button className="btn btn-sm !h-9" data-on={tool === "move"} onClick={() => setTool("move")} title="Select / pan (Esc)"><Icon name="pointer" size={14} /> Move</button>
          <button className="btn btn-sm !h-9" data-on={tool === "pen"} onClick={() => setTool(tool === "pen" ? "move" : "pen")} title="Freehand pen (P)"><Icon name="pen-ruler" size={14} /> Pen</button>
          <button className="btn btn-sm !h-9" data-on={tool === "eraser"} onClick={() => setTool(tool === "eraser" ? "move" : "eraser")} title="Eraser — scrub strokes (E)"><Icon name="cut" size={14} /> Erase</button>
          {tool === "pen" && (
            <span className="pen-palette flex items-center gap-1 px-1">
              {PEN_COLORS.map((c) => (
                <button key={c} className="pen-dot" data-on={penColor === c} style={{ background: c }} onClick={() => setPenColor(c)} aria-label={`Pen color ${c}`} />
              ))}
              <input type="range" min={2} max={10} value={penW} onChange={(e) => setPenW(Number(e.target.value))} className="!h-1 w-[56px]" title="Stroke width" aria-label="Stroke width" />
            </span>
          )}
          <button className="btn btn-sm !h-9" onClick={() => add({ type: "text", text: "", w: 220, h: 130, tone: 1 })}><Icon name="sticky-note" size={14} /> Sticky</button>
          <button className="btn btn-sm !h-9" data-on={menu === "note"} onClick={() => { setQ(""); setMenu(menu === "note" ? null : "note"); }}><Icon name="note" size={14} /> Note</button>
          <button className="btn btn-sm !h-9" onClick={() => setMenu(menu === "image" ? null : "image")}><Icon name="image" size={14} /> Art</button>
          <div className="mx-1 h-6 w-px bg-line" />
          <button className="icon-btn !h-9 !w-9" data-on={gridOn} onClick={() => setGridOn(!gridOn)} title="Toggle dot grid"><Icon name="grid" size={16} /></button>
          <button className="icon-btn !h-9 !w-9" data-on={snapOn} onClick={() => setSnapOn(!snapOn)} title="Snap to grid when moving"><Icon name="magnet" size={16} /></button>
          <button className="icon-btn !h-9 !w-9" onClick={undo} disabled={histLen === 0} title="Undo (Ctrl+Z)"><Icon name="undo" size={16} /></button>
          <button className="icon-btn !h-9 !w-9" onClick={redo} disabled={future.current.length === 0} title="Redo (Ctrl+Shift+Z)"><Icon name="redo" size={16} /></button>
          <button className="icon-btn !h-9 !w-9" onClick={tidy} title="Tidy into a grid"><Icon name="layout" size={16} /></button>
          <button className="icon-btn !h-9 !w-9" onClick={fit} title="Fit to content"><Icon name="target" size={16} /></button>
          <div className="mx-1 h-6 w-px bg-line" />
          <button className="icon-btn !h-9 !w-9" onClick={() => setView((v) => ({ ...v, z: clamp(v.z / 1.2, 0.15, 2.5) }))}><Icon name="zoom-out" size={16} /></button>
          <span className="pixel-font w-[44px] text-center text-[14px] text-dim">{Math.round(view.z * 100)}%</span>
          <button className="icon-btn !h-9 !w-9" onClick={() => setView((v) => ({ ...v, z: clamp(v.z * 1.2, 0.15, 2.5) }))}><Icon name="zoom-in" size={16} /></button>
          {sel.length > 0 && (
            <>
              <div className="mx-1 h-6 w-px bg-line" />
              <button className="btn btn-sm !h-9" onClick={() => removeIds(sel)}><Icon name="trash" size={14} /> {sel.length}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function CanvasView() {
  const canvases = useStore((s) => s.canvases);
  const active = useStore((s) => s.activeCanvas);
  const canvas = canvases.find((c) => c.id === active) ?? canvases[0] ?? null;
  if (!canvas)
    return (
      <div className="panel grid h-full place-items-center rounded-[20px]">
        <div className="text-center">
          <div className="pixel-font mb-3 text-[22px]">No boards yet</div>
          <button className="btn btn-accent" onClick={() => useStore.getState().createCanvas("My first board")}><Icon name="plus" size={14} /> Create a board</button>
        </div>
      </div>
    );
  return <Board key={canvas.id} canvas={canvas} />;
}
