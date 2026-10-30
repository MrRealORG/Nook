
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { useStore } from "@/lib/store";
import { THEMES } from "@/lib/themes";
import { clamp, parseNote, titleKey } from "@/lib/util";
import { isActive, motionAllowed, onPowerChange } from "@/lib/power";

type Kind = "note" | "ghost" | "tag";
type GNode = { id: string; label: string; kind: Kind; x: number; y: number; z: number; vx: number; vy: number; vz: number; deg: number; pinned: boolean };
type Opts = { labels: boolean; ghosts: boolean; tags: boolean; local: boolean; orbit: boolean };
type RGB = [number, number, number];

type World = {
  nodes: GNode[];
  edges: [number, number][];
  alpha: number;
  yaw: number; pitch: number; yawT: number; pitchT: number; yaw3: number; pitch3: number;
  pf: number; pfT: number; zoom: number; px: number; py: number;
  hover: number; sel: string | null; active: string | null; query: string; opts: Opts; three: boolean;
  w: number; h: number; dpr: number; PX: number;
  quiet: number; fitted: boolean; pausedUntil: number; dragging: boolean;
  sx: Float32Array; sy: Float32Array; sd: Float32Array; sr: Int16Array; vis: Uint8Array;
  ramp: RGB[]; accent: RGB; panel: string; ink: RGB; font: string; stars: number[];
  kick: () => void;
};

const FOV = 900;
const hex = (h: string): RGB => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const mix = (a: RGB, b: RGB, t: number) => `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`;

function simStep(W: World) {
  const { nodes, edges } = W;
  const n = nodes.length;
  const a = W.alpha;
  for (let i = 0; i < n; i++) {
    const A = nodes[i];
    for (let j = i + 1; j < n; j++) {
      const B = nodes[j];
      const dx = A.x - B.x, dy = A.y - B.y, dz = A.z - B.z;
      const d2 = dx * dx + dy * dy + dz * dz + 80;
      const inv = 1 / Math.sqrt(d2);
      const f = (5200 * inv * inv * a) * inv;
      A.vx += dx * f; A.vy += dy * f; A.vz += dz * f;
      B.vx -= dx * f; B.vy -= dy * f; B.vz -= dz * f;
    }
  }
  for (const [i, j] of edges) {
    const A = nodes[i], B = nodes[j];
    const dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01;
    const L = A.kind === "tag" || B.kind === "tag" ? 70 : 95;
    const k = ((d - L) / d) * 0.045 * a;
    A.vx += dx * k; A.vy += dy * k; A.vz += dz * k;
    B.vx -= dx * k; B.vy -= dy * k; B.vz -= dz * k;
  }
  for (const N of nodes) {
    N.vx -= N.x * 0.012 * a; N.vy -= N.y * 0.012 * a; N.vz -= N.z * 0.012 * a;
    if (!W.three) N.vz -= N.z * 0.3;
    N.vx *= 0.8; N.vy *= 0.8; N.vz *= 0.8;
    if (N.pinned) { N.vx = N.vy = N.vz = 0; continue; }
    N.x += N.vx; N.y += N.vy; N.z += N.vz;
  }
  W.alpha *= 0.991;
}

function frame(W: World, ctx: CanvasRenderingContext2D, t: number) {
  const { w, h, dpr, PX } = W;
  // camera easing
  W.yaw += (W.yawT - W.yaw) * 0.16;
  W.pitch += (W.pitchT - W.pitch) * 0.16;
  W.pf += (W.pfT - W.pf) * 0.14;
  if (W.opts.orbit && W.three && !W.dragging && t > W.pausedUntil) { W.yaw3 += 0.0045; W.yaw = W.yawT = W.yaw3; }

  if (W.alpha > 0.014) simStep(W);

  ctx.clearRect(0, 0, w, h);
  const n = W.nodes.length;
  const cy = Math.cos(W.yaw), sy = Math.sin(W.yaw), cp = Math.cos(W.pitch), sp = Math.sin(W.pitch);
  const s0 = W.zoom * dpr;
  const [r0, r1, r2, r3, r4] = W.ramp;
  void r0; void r2;
  const half = PX / 2;
  const snap = (v: number) => Math.round(v / PX) * PX;

  // backdrop: stars (3D) or dot grid (2D)
  ctx.fillStyle = mix(W.ramp[3], W.ramp[3], 0);
  if (W.pf > 0.4) {
    for (let i = 0; i < W.stars.length; i += 4) {
      const x = W.stars[i], y = W.stars[i + 1], z = W.stars[i + 2];
      const x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
      const y2 = y * cp - z1 * sp;
      const tw = 0.25 + 0.35 * Math.abs(Math.sin(t * 0.0007 + W.stars[i + 3]));
      ctx.globalAlpha = tw * (W.pf - 0.3);
      ctx.fillRect(snap(w / 2 + x1 * 0.5 * dpr + W.px * 0.1), snap(h / 2 + y2 * 0.5 * dpr + W.py * 0.1), PX - 1, PX - 1);
    }
    // floor ring
    ctx.globalAlpha = 0.28 * W.pf;
    for (let k = 0; k < 90; k++) {
      const a = (k / 90) * Math.PI * 2;
      const x = Math.cos(a) * 420, z = Math.sin(a) * 420, y = 230;
      const x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
      const y2 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
      const p = FOV / (FOV + z2 * W.pf);
      ctx.fillRect(snap(w / 2 + W.px + x1 * s0 * p), snap(h / 2 + W.py + y2 * s0 * p), PX - 1, PX - 1);
    }
  }
  if (W.pf < 0.6) {
    const gap = 30 * dpr * clamp(W.zoom, 0.6, 1.6);
    ctx.globalAlpha = 0.16 * (1 - W.pf);
    const ox = ((w / 2 + W.px) % gap + gap) % gap, oy = ((h / 2 + W.py) % gap + gap) % gap;
    for (let x = ox; x < w; x += gap) for (let y = oy; y < h; y += gap) ctx.fillRect(snap(x), snap(y), PX - 1, PX - 1);
  }
  ctx.globalAlpha = 1;
  if (n === 0) return;

  // project
  for (let i = 0; i < n; i++) {
    const N = W.nodes[i];
    const x1 = N.x * cy + N.z * sy, z1 = -N.x * sy + N.z * cy;
    const y2 = N.y * cp - z1 * sp, z2 = N.y * sp + z1 * cp;
    const p = FOV / (FOV + z2 * W.pf);
    W.sx[i] = w / 2 + W.px + x1 * s0 * p;
    W.sy[i] = h / 2 + W.py + y2 * s0 * p;
    W.sd[i] = z2;
    const base = N.kind === "note" ? 2 + Math.min(4, Math.sqrt(N.deg)) : N.kind === "tag" ? 2.5 : 1.6;
    W.sr[i] = Math.max(1, Math.round(base * p * clamp(Math.sqrt(W.zoom), 0.7, 1.5)));
  }

  // visibility (local mode)
  const focusId = W.sel ?? W.active;
  const neigh = new Set<number>();
  const focusIdx = focusId ? W.nodes.findIndex((q) => q.id === focusId) : -1;
  if (focusIdx >= 0) {
    neigh.add(focusIdx);
    for (const [a, b] of W.edges) { if (a === focusIdx) neigh.add(b); if (b === focusIdx) neigh.add(a); }
  }
  W.vis.fill(1);
  if (W.opts.local && focusIdx >= 0) {
    const d2 = new Set(neigh);
    for (const [a, b] of W.edges) { if (neigh.has(a)) d2.add(b); if (neigh.has(b)) d2.add(a); }
    for (let i = 0; i < n; i++) W.vis[i] = d2.has(i) ? 1 : 0;
  }
  const q = W.query.trim().toLowerCase();
  const match = (i: number) => q.length > 0 && W.nodes[i].label.toLowerCase().includes(q);
  const dimOthers = (W.sel !== null && focusIdx >= 0) || q.length > 0;

  // edges
  const dot = (x0: number, y0: number, x1: number, y1: number, step: number) => {
    const dx = x1 - x0, dy = y1 - y0;
    const m = Math.max(1, Math.floor(Math.hypot(dx, dy) / step));
    for (let k = 0; k <= m; k++) ctx.fillRect(snap(x0 + (dx * k) / m) - half, snap(y0 + (dy * k) / m) - half, PX - 1, PX - 1);
  };
  for (const hot of [false, true]) {
    ctx.fillStyle = hot ? `rgb(${W.accent})` : mix(r3, r3, 0);
    for (const [a, b] of W.edges) {
      if (!W.vis[a] || !W.vis[b]) continue;
      const isHot = a === W.hover || b === W.hover || (focusIdx >= 0 && (a === focusIdx || b === focusIdx) && (W.sel !== null || W.hover < 0));
      if (isHot !== hot) continue;
      const depth = clamp(1 - (((W.sd[a] + W.sd[b]) / 2 + 300) / 900), 0.12, 1);
      ctx.globalAlpha = hot ? 0.95 : (dimOthers ? 0.07 : 0.3) * depth + 0.05;
      const ghostEdge = W.nodes[a].kind === "ghost" || W.nodes[b].kind === "ghost";
      dot(W.sx[a], W.sy[a], W.sx[b], W.sy[b], hot ? PX * 1.4 : ghostEdge ? PX * 3.4 : PX * 2.4);
    }
  }
  ctx.globalAlpha = 1;

  // nodes sorted far -> near
  const order: number[] = [];
  for (let i = 0; i < n; i++) if (W.vis[i]) order.push(i);
  if (W.pf > 0.2) order.sort((a, b) => W.sd[b] - W.sd[a]);

  const disc = (cx: number, cyy: number, r: number, kind: Kind) => {
    for (let dy = -r; dy <= r; dy++) {
      const wd = kind === "tag" ? r - Math.abs(dy) : Math.floor(Math.sqrt(r * r + r * 0.8 - dy * dy));
      ctx.fillRect(cx - wd * PX - half, cyy + dy * PX - half, (2 * wd + 1) * PX - 1, PX - 1);
    }
  };
  const ring = (cx: number, cyy: number, r: number, kind: Kind) => {
    for (let dy = -r; dy <= r; dy++) {
      const wd = kind === "tag" ? r - Math.abs(dy) : Math.floor(Math.sqrt(r * r + r * 0.8 - dy * dy));
      const edge = Math.abs(dy) === r;
      if (edge) ctx.fillRect(cx - wd * PX - half, cyy + dy * PX - half, (2 * wd + 1) * PX - 1, PX - 1);
      else { ctx.fillRect(cx - wd * PX - half, cyy + dy * PX - half, PX - 1, PX - 1); ctx.fillRect(cx + wd * PX - half, cyy + dy * PX - half, PX - 1, PX - 1); }
    }
  };

  const labels: { i: number; x: number; y: number; a: number; hot: boolean }[] = [];
  for (const i of order) {
    const N = W.nodes[i];
    const cx = snap(W.sx[i]), cyy = snap(W.sy[i]);
    if (cx < -60 || cyy < -60 || cyy > h + 60 || cx > w + 60) continue;
    const r = W.sr[i];
    const depth = clamp((W.sd[i] + 380) / 760, 0, 1); // 0 near -> 1 far
    const isActive = N.id === W.active;
    const isSel = N.id === W.sel;
    const isHover = i === W.hover;
    const isMatch = match(i);
    const related = focusIdx < 0 || neigh.has(i);
    let alpha = 1 - depth * 0.55 * W.pf;
    if (dimOthers && !related && !isMatch) alpha *= 0.22;
    if (q && !isMatch) alpha *= 0.3;
    ctx.globalAlpha = alpha;

    if (N.kind === "ghost") {
      ctx.fillStyle = mix(r3, r1, depth);
      ring(cx, cyy, r, "ghost");
    } else {
      const col: RGB = isActive || isSel || isMatch ? W.accent : N.kind === "tag" ? r3 : W.ramp[4];
      const lit = mix(col, r4, 0.35);
      const body = mix(col, r1, 0.15 + depth * 0.55);
      const shade = mix(col, r0, 0.5 + depth * 0.2);
      ctx.fillStyle = shade;
      disc(cx, cyy, r, N.kind);
      if (r >= 2) {
        ctx.fillStyle = body;
        disc(cx - Math.round(PX * 0.0), cyy, r - 1, N.kind);
        ctx.fillStyle = lit;
        disc(cx - PX, cyy - PX, Math.max(1, r - 2), N.kind);
        ctx.fillStyle = "rgb(255,255,255)";
        ctx.globalAlpha = alpha * 0.8;
        ctx.fillRect(cx - Math.floor(r / 2) * PX - PX - half, cyy - Math.floor(r / 2) * PX - PX - half, PX - 1, PX - 1);
      } else {
        ctx.fillStyle = body;
        ctx.fillRect(cx - half, cyy - half, PX - 1, PX - 1);
      }
    }
    if (isHover || isSel || isActive) {
      ctx.globalAlpha = isHover || isSel ? 1 : 0.55;
      ctx.fillStyle = `rgb(${isHover ? W.ink : W.accent})`;
      ring(cx, cyy, r + 2, N.kind);
    }
    if (N.pinned) { ctx.globalAlpha = 1; ctx.fillStyle = `rgb(${W.accent})`; ctx.fillRect(cx - half, cyy - (r + 3) * PX - half, PX - 1, PX - 1); }
    const showLabel = isHover || isSel || isActive || isMatch || (W.opts.labels && (W.sr[i] >= 3 || W.zoom > 1.15) && depth < 0.82 && (!dimOthers || related));
    if (showLabel) labels.push({ i, x: cx + (r + 1) * PX + 7 * dpr, y: cyy, a: isHover || isSel ? 1 : clamp(alpha + 0.15, 0.35, 1), hot: isHover || isSel || isActive });
  }
  ctx.globalAlpha = 1;

  // labels
  ctx.font = `${Math.round(12.5 * dpr)}px ${W.font}`;
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = 4 * dpr;
  ctx.strokeStyle = W.panel;
  for (const L of labels) {
    const text = W.nodes[L.i].kind === "tag" ? `#${W.nodes[L.i].label}` : W.nodes[L.i].label;
    ctx.globalAlpha = L.a;
    ctx.strokeText(text, L.x, L.y);
    ctx.fillStyle = L.hot ? `rgb(${W.ink})` : mix(r4, r3, 0.4);
    ctx.fillText(text, L.x, L.y);
  }
  ctx.globalAlpha = 1;
}

export function GraphView() {
  const notes = useStore((s) => s.notes);
  const activeId = useStore((s) => s.activeId);
  const theme = useStore((s) => s.theme);
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const W = useRef<World | null>(null);
  const [three, setThree] = useState(true);
  const [opts, setOpts] = useState<Opts>({ labels: true, ghosts: true, tags: false, local: false, orbit: true });
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const st = useStore.getState;

  // ---- graph model ----
  const sig = notes.map((n) => { const m = parseNote(n.content); return `${n.id}|${n.title}|${m.links.join(",")}|${opts.tags ? m.tags.join(",") : ""}`; }).join("\n");
  const model = useMemo(() => {
    const nodes: { id: string; label: string; kind: Kind }[] = [];
    const edges: [string, string][] = [];
    const byTitle = new Map<string, string>();
    for (const n of notes) { byTitle.set(titleKey(n.title), n.id); nodes.push({ id: n.id, label: n.title || "Untitled", kind: "note" }); }
    const ghosts = new Set<string>();
    for (const n of notes) {
      const m = parseNote(n.content);
      for (const l of m.links) {
        const k = titleKey(l);
        const to = byTitle.get(k);
        if (to) { if (to !== n.id) edges.push([n.id, to]); }
        else if (opts.ghosts) {
          const gid = `g:${k}`;
          if (!ghosts.has(gid)) { ghosts.add(gid); nodes.push({ id: gid, label: l, kind: "ghost" }); }
          edges.push([n.id, gid]);
        }
      }
      if (opts.tags) for (const t of m.tags) {
        const tid = `t:${t}`;
        if (!nodes.some((x) => x.id === tid)) nodes.push({ id: tid, label: t, kind: "tag" });
        edges.push([n.id, tid]);
      }
    }
    return { nodes, edges };
     
  }, [sig, opts.ghosts, opts.tags]);

  const stats = useMemo(() => {
    const deg = new Map<string, number>();
    for (const [a, b] of model.edges) { deg.set(a, (deg.get(a) ?? 0) + 1); deg.set(b, (deg.get(b) ?? 0) + 1); }
    const orphans = model.nodes.filter((n) => n.kind === "note" && !deg.get(n.id)).length;
    return { notes: notes.length, links: model.edges.filter(([a, b]) => !a.startsWith("t:") && !b.startsWith("t:")).length, orphans };
  }, [model, notes.length]);

  // ---- setup canvas + loop ----
  useEffect(() => {
    const canvas = cv.current!;
    const box = wrap.current!;
    const ctx = canvas.getContext("2d")!;
    const th = THEMES[useStore.getState().theme];
    const stars: number[] = [];
    for (let i = 0; i < 150; i++) {
      const a = Math.random() * Math.PI * 2, b = Math.acos(2 * Math.random() - 1), r = 700 + Math.random() * 500;
      stars.push(r * Math.sin(b) * Math.cos(a), r * Math.cos(b), r * Math.sin(b) * Math.sin(a), Math.random() * 6);
    }
    const fam = getComputedStyle(document.documentElement).getPropertyValue("--f-pixel").trim();
    const world: World = {
      nodes: [], edges: [], alpha: 1,
      yaw: 0.6, pitch: 0.38, yawT: 0.6, pitchT: 0.38, yaw3: 0.6, pitch3: 0.38, pf: 1, pfT: 1, zoom: 1, px: 0, py: 0,
      hover: -1, sel: null, active: null, query: "", opts: { labels: true, ghosts: true, tags: false, local: false, orbit: true }, three: true,
      w: 800, h: 600, dpr: 1, PX: 3, quiet: 0, fitted: false, pausedUntil: 0, dragging: false,
      sx: new Float32Array(0), sy: new Float32Array(0), sd: new Float32Array(0), sr: new Int16Array(0), vis: new Uint8Array(0),
      ramp: th.ramp.map(hex), accent: hex(th.accent), panel: th.panel, ink: hex(th.ink), font: `${fam ? fam + "," : ""} ui-monospace, monospace`, stars,
      kick: () => {},
    };
    W.current = world;
    let raf = 0;
    let running = false;
    const loop = (t: number) => {
      running = false;
      frame(world, ctx, t);
      // 1.2: the idle orbit is decorative — off in low-power mode; nothing runs while hidden
      const moving = world.alpha > 0.014 || Math.abs(world.yaw - world.yawT) > 0.002 || Math.abs(world.pitch - world.pitchT) > 0.002 || Math.abs(world.pf - world.pfT) > 0.004 || (world.opts.orbit && world.three && !world.dragging && motionAllowed()) || world.dragging;
      if (moving && isActive()) { running = true; raf = requestAnimationFrame(loop); }
      if (!world.fitted && world.alpha < 0.35 && world.nodes.length) { world.fitted = true; fit(); }
    };
    world.kick = () => { if (!running) { running = true; raf = requestAnimationFrame(loop); } };
    const offPower = onPowerChange(() => world.kick());

    const fit = () => {
      let mx = 1;
      for (const N of world.nodes) mx = Math.max(mx, Math.abs(N.x) * 1.15, Math.abs(N.y) * 1.5, Math.abs(N.z) * 0.7);
      const target = Math.min(world.w, world.h * 1.3) / world.dpr / 2 / (mx + 40);
      world.zoom = clamp(target * 0.92, 0.3, 2.6);
      world.px = 0; world.py = 0;
      world.kick();
    };
    (world as World & { fit?: () => void }).fit = fit;

    const resize = () => {
      const r = box.getBoundingClientRect();
      world.dpr = Math.min(window.devicePixelRatio || 1, 2);
      world.PX = Math.max(2, Math.round(3 * world.dpr));
      world.w = Math.max(10, Math.round(r.width * world.dpr));
      world.h = Math.max(10, Math.round(r.height * world.dpr));
      canvas.width = world.w; canvas.height = world.h;
      world.kick();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(box);
    resize();

    const pick = (mx: number, my: number) => {
      let best = -1, bd = 1e9;
      for (let i = 0; i < world.nodes.length; i++) {
        if (!world.vis[i]) continue;
        const rr = world.sr[i] * world.PX + 7 * world.dpr;
        const dx = world.sx[i] - mx, dy = world.sy[i] - my;
        if (dx * dx + dy * dy < rr * rr && world.sd[i] < bd) { best = i; bd = world.sd[i]; }
      }
      return best;
    };

    let drag: { kind: "node" | "pan" | "rot"; idx: number; x: number; y: number; moved: boolean } | null = null;
    const pos = (e: PointerEvent | WheelEvent) => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * world.dpr, y: (e.clientY - r.top) * world.dpr }; };

    const down = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      const p = pos(e);
      const idx = pick(p.x, p.y);
      drag = { kind: idx >= 0 ? "node" : world.three && !e.shiftKey && e.button === 0 ? "rot" : "pan", idx, x: p.x, y: p.y, moved: false };
      world.dragging = true;
      world.kick();
    };
    const move = (e: PointerEvent) => {
      const p = pos(e);
      if (!drag) {
        const h = pick(p.x, p.y);
        if (h !== world.hover) { world.hover = h; canvas.style.cursor = h >= 0 ? "pointer" : "grab"; world.kick(); }
        return;
      }
      const dx = p.x - drag.x, dy = p.y - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 5 * world.dpr) return;
      drag.moved = true;
      drag.x = p.x; drag.y = p.y;
      world.pausedUntil = performance.now() + 3500;
      if (drag.kind === "node") {
        const N = world.nodes[drag.idx];
        const persp = FOV / (FOV + world.sd[drag.idx] * world.pf);
        const s = world.zoom * world.dpr * persp;
        const vx = dx / s, vy = dy / s;
        const cp = Math.cos(world.pitch), sp = Math.sin(world.pitch), cyw = Math.cos(world.yaw), syw = Math.sin(world.yaw);
        const z1 = -vy * sp;
        N.x += vx * cyw - z1 * syw; N.y += vy * cp; N.z += vx * syw + z1 * cyw;
        N.pinned = true; N.vx = N.vy = N.vz = 0;
        world.alpha = Math.max(world.alpha, 0.3);
      } else if (drag.kind === "rot") {
        world.yaw3 += dx * 0.006; world.pitch3 = clamp(world.pitch3 + dy * 0.006, -1.35, 1.35);
        world.yaw = world.yawT = world.yaw3; world.pitch = world.pitchT = world.pitch3;
      } else { world.px += dx; world.py += dy; }
      world.kick();
    };
    const up = () => {
      if (drag && !drag.moved) {
        const id = drag.idx >= 0 ? world.nodes[drag.idx].id : null;
        world.sel = id;
        setSel(id);
      }
      drag = null;
      world.dragging = false;
      world.kick();
    };
    const dbl = () => {
      if (world.hover < 0) { world.yaw3 = 0.6; world.pitch3 = 0.38; if (world.three) { world.yawT = 0.6; world.pitchT = 0.38; } fit(); return; }
      const N = world.nodes[world.hover];
      const s = useStore.getState();
      if (N.kind === "note") s.openNote(N.id);
      else if (N.kind === "ghost") s.openByTitle(N.label);
      else { s.set({ tag: N.label }); s.setView("notes"); }
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = pos(e);
      const z1 = world.zoom;
      const z2 = clamp(z1 * Math.exp(-e.deltaY * 0.0015), 0.25, 4);
      const k = z2 / z1;
      world.px = p.x - world.w / 2 - (p.x - world.w / 2 - world.px) * k;
      world.py = p.y - world.h / 2 - (p.y - world.h / 2 - world.py) * k;
      world.zoom = z2;
      world.kick();
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("dblclick", dbl);
    canvas.addEventListener("wheel", wheel, { passive: false });
    const vis = () => !document.hidden && world.kick();
    document.addEventListener("visibilitychange", vis);
    return () => {
      cancelAnimationFrame(raf);
      offPower();
      ro.disconnect();
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("dblclick", dbl);
      canvas.removeEventListener("wheel", wheel);
      document.removeEventListener("visibilitychange", vis);
      W.current = null;
    };
  }, []);

  // ---- sync model into the world (keep positions of existing nodes) ----
  useEffect(() => {
    const world = W.current;
    if (!world) return;
    const old = new Map(world.nodes.map((n) => [n.id, n]));
    const deg = new Map<string, number>();
    for (const [a, b] of model.edges) { deg.set(a, (deg.get(a) ?? 0) + 1); deg.set(b, (deg.get(b) ?? 0) + 1); }
    let fresh = 0;
    const nodes: GNode[] = model.nodes.map((m) => {
      const o = old.get(m.id);
      if (o) return { ...o, label: m.label, deg: deg.get(m.id) ?? 0 };
      fresh++;
      const a = Math.random() * Math.PI * 2, b = Math.acos(2 * Math.random() - 1), r = 90 + Math.random() * 90;
      return { id: m.id, label: m.label, kind: m.kind, x: r * Math.sin(b) * Math.cos(a), y: r * Math.cos(b) * 0.7, z: world.three ? r * Math.sin(b) * Math.sin(a) : 0, vx: 0, vy: 0, vz: 0, deg: deg.get(m.id) ?? 0, pinned: false };
    });
    const idx = new Map(nodes.map((n, i) => [n.id, i]));
    world.nodes = nodes;
    world.edges = model.edges.map(([a, b]) => [idx.get(a)!, idx.get(b)!] as [number, number]).filter(([a, b]) => a !== undefined && b !== undefined);
    // new nodes spawn next to a neighbour
    for (const [a, b] of world.edges) {
      const A = nodes[a], B = nodes[b];
      if (!old.has(A.id) && old.has(B.id)) { A.x = B.x + (Math.random() - 0.5) * 40; A.y = B.y + (Math.random() - 0.5) * 40; A.z = B.z + (Math.random() - 0.5) * 40; }
      if (!old.has(B.id) && old.has(A.id)) { B.x = A.x + (Math.random() - 0.5) * 40; B.y = A.y + (Math.random() - 0.5) * 40; B.z = A.z + (Math.random() - 0.5) * 40; }
    }
    const n = nodes.length;
    world.sx = new Float32Array(n); world.sy = new Float32Array(n); world.sd = new Float32Array(n); world.sr = new Int16Array(n); world.vis = new Uint8Array(n).fill(1);
    world.hover = -1;
    world.alpha = old.size === 0 ? 1 : Math.max(world.alpha, fresh ? 0.55 : 0.25);
    world.kick();
  }, [model]);

  // ---- sync props into the world ----
  useEffect(() => {
    const world = W.current;
    if (!world) return;
    world.opts = opts; world.query = query; world.active = activeId; world.sel = sel;
    const th = THEMES[theme];
    world.ramp = th.ramp.map(hex); world.accent = hex(th.accent); world.panel = th.panel; world.ink = hex(th.ink);
    world.kick();
  }, [opts, query, activeId, sel, theme]);

  useEffect(() => {
    const world = W.current;
    if (!world) return;
    world.three = three;
    if (three) {
      world.yawT = world.yaw3; world.pitchT = world.pitch3; world.pfT = 1;
      for (const N of world.nodes) N.z += (Math.random() - 0.5) * 60;
      world.alpha = Math.max(world.alpha, 0.5);
    } else { world.yawT = 0; world.pitchT = 0; world.pfT = 0; world.alpha = Math.max(world.alpha, 0.5); }
    world.kick();
  }, [three]);

  const selNode = sel ? model.nodes.find((n) => n.id === sel) : null;
  const selNote = selNode?.kind === "note" ? notes.find((n) => n.id === selNode.id) : null;
  const selMeta = selNote ? parseNote(selNote.content) : null;
  const set = (k: keyof Opts) => setOpts((o) => ({ ...o, [k]: !o[k] }));
  const call = (f: (w: World & { fit?: () => void }) => void) => { const w = W.current as (World & { fit?: () => void }) | null; if (w) { f(w); w.kick(); } };

  return (
    <div className="panel relative h-full overflow-hidden rounded-[20px]" ref={wrap} style={{ background: `radial-gradient(900px 600px at 50% 40%, var(--glow), transparent 70%), var(--panel)` }}>
      <canvas ref={cv} className="absolute inset-0 h-full w-full touch-none" style={{ cursor: "grab" }} />

      <div className="pointer-events-none absolute left-4 top-4 z-10 flex flex-col gap-2">
        <div className="pointer-events-auto panel panel-solid flex flex-wrap items-center gap-2 rounded-2xl p-2" style={{ backdropFilter: "none" }}>
          <div className="seg">
            <button data-on={!three} onClick={() => setThree(false)}>2D</button>
            <button data-on={three} onClick={() => setThree(true)}>3D</button>
          </div>
          {([["labels", "Labels"], ["ghosts", "Ghosts"], ["tags", "Tags"], ["local", "Local"], ["orbit", "Orbit"]] as const).map(([k, l]) => (
            <button key={k} className="chip" style={{ height: 26 }} data-on={opts[k]} onClick={() => set(k)} disabled={k === "orbit" && !three} title={k === "local" ? "Only show notes near the selection" : undefined}>{l}</button>
          ))}
        </div>
        <div className="pointer-events-auto relative w-[260px]">
          <Icon name="search" size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input className="input !pl-8" placeholder="Highlight a note…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            const hit = model.nodes.find((n) => n.label.toLowerCase().includes(query.trim().toLowerCase()));
            if (hit) { setSel(hit.id); const w = W.current; if (w) { w.sel = hit.id; w.kick(); } }
          }} />
        </div>
      </div>

      {selNode && (
        <div className="panel panel-solid absolute right-4 top-4 z-10 w-[290px] rounded-2xl p-4" style={{ animation: "pop .25s var(--ease-soft)", backdropFilter: "none" }}>
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="label mb-1">{selNode.kind === "note" ? "note" : selNode.kind === "ghost" ? "missing note" : "tag"}</div>
              <div className="pixel-font text-[19px] leading-tight">{selNode.kind === "tag" ? `#${selNode.label}` : selNode.label}</div>
            </div>
            <button className="icon-btn !h-7 !w-7" onClick={() => { setSel(null); if (W.current) { W.current.sel = null; W.current.kick(); } }}><Icon name="close" size={14} /></button>
          </div>
          {selMeta && <p className="mt-2 line-clamp-3 text-[12.5px] leading-snug text-dim">{selMeta.snippet}</p>}
          {selMeta && selMeta.tags.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{selMeta.tags.slice(0, 4).map((t) => <span key={t} className="chip">#{t}</span>)}</div>}
          <div className="mt-3 flex gap-2">
            {selNode.kind === "note" && <button className="btn btn-accent btn-sm" onClick={() => st().openNote(selNode.id)}><Icon name="note" size={13} /> Open</button>}
            {selNode.kind === "ghost" && <button className="btn btn-accent btn-sm" onClick={() => st().openByTitle(selNode.label)}><Icon name="plus" size={13} /> Create</button>}
            {selNode.kind === "tag" && <button className="btn btn-accent btn-sm" onClick={() => { st().set({ tag: selNode.label }); st().setView("notes"); }}>Show notes</button>}
            <button className="btn btn-sm" onClick={() => { setOpts((o) => ({ ...o, local: !o.local })); }}>Local view</button>
          </div>
        </div>
      )}

      <div className="pixel-font pointer-events-none absolute bottom-4 left-4 z-10 flex items-center gap-3 text-[13px] text-dim">
        <span className="panel panel-solid rounded-xl px-3 py-1.5" style={{ backdropFilter: "none" }}>
          {stats.notes} notes · {stats.links} links · {stats.orphans} orphans
        </span>
        <span className="hidden text-faint lg:inline">{three ? "drag: orbit · shift-drag: pan · scroll: zoom" : "drag: pan · scroll: zoom"} · double-click opens</span>
      </div>
      <div className="absolute bottom-4 right-4 z-10 flex gap-1.5">
        <button className="btn btn-sm" onClick={() => call((w) => { for (const N of w.nodes) N.pinned = false; w.alpha = 1; })} title="Release pinned nodes & re-settle"><Icon name="reload" size={13} /> Shake</button>
        <button className="btn btn-sm" onClick={() => call((w) => w.fit?.())} title="Fit to view"><Icon name="target" size={13} /> Fit</button>
        <button className="icon-btn !h-[26px] !w-[26px] border border-line" onClick={() => call((w) => { w.zoom = clamp(w.zoom * 1.25, 0.25, 4); })}><Icon name="zoom-in" size={14} /></button>
        <button className="icon-btn !h-[26px] !w-[26px] border border-line" onClick={() => call((w) => { w.zoom = clamp(w.zoom / 1.25, 0.25, 4); })}><Icon name="zoom-out" size={14} /></button>
      </div>
    </div>
  );
}
