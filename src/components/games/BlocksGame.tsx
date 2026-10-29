"use client";

import { useEffect, useRef } from "react";
import type { GameComponentProps } from "@/components/games/GameShell";
import { useStore } from "@/lib/store";
import { THEMES, type Theme, type ThemeId } from "@/lib/themes";

// ---- Falling Blocks: classic stacker on a 10x18 field inside a 400x300 canvas.
// HUD (score / lines / level / next piece) is drawn on the right side.

const GW = 400, GH = 300;
const COLS = 10, ROWS = 18, CELL = 16;
const PW = COLS * CELL, PH = ROWS * CELL; // 160 x 288
const PX = 20, PY = 6;

type Play = GameComponentProps["play"];
type Live = { running: boolean; onEnd: (score: number) => void; play: Play; theme: ThemeId };

// I, O, T, S, Z, J, L
const SHAPES: number[][][] = [
  [[1, 1, 1, 1]],
  [[1, 1], [1, 1]],
  [[0, 1, 0], [1, 1, 1]],
  [[0, 1, 1], [1, 1, 0]],
  [[1, 1, 0], [0, 1, 1]],
  [[1, 0, 0], [1, 1, 1]],
  [[0, 0, 1], [1, 1, 1]],
];

type Piece = { k: number; m: number[][]; x: number; y: number };

type State = {
  grid: number[]; // COLS*ROWS, 0 empty, else kind+1
  cur: Piece | null;
  nextK: number;
  bag: number[];
  score: number;
  lines: number;
  level: number;
  acc: number;
  last: number;
  over: boolean;
  finished: boolean;
  flashRows: number[];
  flashT: number;
  moveSndAt: number;
};

function shuffledBag(): number[] {
  const b = [0, 1, 2, 3, 4, 5, 6];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

function nextFromBag(g: State): number {
  if (!g.bag.length) g.bag = shuffledBag();
  return g.bag.pop() ?? 0;
}

function makeState(): State {
  const g: State = {
    grid: new Array(COLS * ROWS).fill(0),
    cur: null,
    nextK: 0,
    bag: shuffledBag(),
    score: 0,
    lines: 0,
    level: 1,
    acc: 0,
    last: 0,
    over: false,
    finished: false,
    flashRows: [],
    flashT: 0,
    moveSndAt: 0,
  };
  g.nextK = nextFromBag(g);
  return g;
}

function collides(grid: number[], m: number[][], x: number, y: number): boolean {
  for (let r = 0; r < m.length; r++)
    for (let c = 0; c < m[r].length; c++) {
      if (!m[r][c]) continue;
      const gx = x + c;
      const gy = y + r;
      if (gx < 0 || gx >= COLS || gy >= ROWS) return true;
      if (gy >= 0 && grid[gy * COLS + gx]) return true;
    }
  return false;
}

/** rotate clockwise: transpose + reverse rows */
function rotateMat(m: number[][]): number[][] {
  return m[0].map((_, i) => m.map((row) => row[i]).reverse());
}

function dropInterval(level: number): number {
  return Math.max(0.07, 0.55 - (level - 1) * 0.055);
}

function spawnCur(g: State, L: Live) {
  const k = g.nextK;
  g.nextK = nextFromBag(g);
  const m = SHAPES[k].map((row) => [...row]);
  const p: Piece = { k, m, x: Math.floor((COLS - m[0].length) / 2), y: 0 };
  g.cur = p;
  g.acc = 0;
  if (collides(g.grid, m, p.x, p.y)) {
    g.over = true;
    L.play("hit");
    if (!g.finished) {
      g.finished = true;
      L.onEnd(g.score);
    }
  }
}

function lockPiece(g: State, L: Live) {
  const p = g.cur;
  if (!p) return;
  for (let r = 0; r < p.m.length; r++)
    for (let c = 0; c < p.m[r].length; c++) {
      if (!p.m[r][c]) continue;
      const gy = p.y + r;
      const gx = p.x + c;
      if (gy >= 0 && gy < ROWS && gx >= 0 && gx < COLS) g.grid[gy * COLS + gx] = p.k + 1;
    }
  g.cur = null;
  const rows: number[] = [];
  for (let y = 0; y < ROWS; y++) {
    let full = true;
    for (let x = 0; x < COLS; x++)
      if (!g.grid[y * COLS + x]) {
        full = false;
        break;
      }
    if (full) rows.push(y);
  }
  if (rows.length) {
    g.flashRows = rows;
    g.flashT = 0.26;
    g.score += 100 * rows.length * rows.length;
    g.lines += rows.length;
    const nl = Math.floor(g.lines / 5) + 1;
    if (nl > g.level) {
      g.level = nl;
      L.play("level");
    }
    L.play(rows.length >= 4 ? "star" : "match");
  } else {
    L.play("pop");
  }
}

function removeRows(g: State) {
  const gone = new Set(g.flashRows);
  const kept: number[] = [];
  for (let y = ROWS - 1; y >= 0; y--) {
    if (gone.has(y)) continue;
    kept.push(...g.grid.slice(y * COLS, y * COLS + COLS));
  }
  const fresh: number[] = new Array(COLS * ROWS).fill(0);
  for (let i = 0; i < kept.length; i++) fresh[COLS * ROWS - 1 - i] = kept[i];
  g.grid = fresh;
  g.flashRows = [];
}

function tryMove(g: State, dx: number, dy: number): boolean {
  const p = g.cur;
  if (!p || collides(g.grid, p.m, p.x + dx, p.y + dy)) return false;
  p.x += dx;
  p.y += dy;
  return true;
}

function rotatePiece(g: State): boolean {
  const p = g.cur;
  if (!p) return false;
  const rm = rotateMat(p.m);
  for (const kick of [0, -1, 1, -2, 2]) {
    if (!collides(g.grid, rm, p.x + kick, p.y)) {
      p.m = rm;
      p.x += kick;
      return true;
    }
  }
  return false;
}

function hardDrop(g: State): number {
  const p = g.cur;
  if (!p) return 0;
  let n = 0;
  while (!collides(g.grid, p.m, p.x, p.y + 1)) {
    p.y++;
    n++;
  }
  return n;
}

function throttledMoveSnd(g: State, L: Live) {
  const now = performance.now();
  if (now - g.moveSndAt > 70) {
    g.moveSndAt = now;
    L.play("move");
  }
}

function blendHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const mix = (sa: number, sb: number) => Math.round(sa * (1 - t) + sb * t);
  return `rgb(${mix((pa >> 16) & 255, (pb >> 16) & 255)},${mix((pa >> 8) & 255, (pb >> 8) & 255)},${mix(pa & 255, pb & 255)})`;
}

/** 7 distinct piece colours from the theme ramp + accent */
function pieceColors(th: Theme): string[] {
  return [
    th.accent,
    th.ramp[4],
    th.ramp[3],
    th.ramp[2],
    blendHex(th.accent, th.ramp[4], 0.55),
    blendHex(th.ramp[3], th.accent, 0.5),
    blendHex(th.ramp[2], th.ramp[4], 0.6),
  ];
}

export default function BlocksGame({ running, onEnd, play }: GameComponentProps) {
  const cv = useRef<HTMLCanvasElement>(null);
  const theme = useStore((s) => s.theme);
  const G = useRef(makeState());
  const live = useRef({ running, onEnd, play, theme });
  // keep latest props reachable from the rAF loop without re-subscribing
  useEffect(() => {
    live.current = { running, onEnd, play, theme };
  });

  // reset when a fresh run begins (component may stay mounted between runs)
  const prevRun = useRef(running);
  useEffect(() => {
    if (running && !prevRun.current) G.current = makeState();
    prevRun.current = running;
  }, [running]);

  // controls — attached only while running
  useEffect(() => {
    if (!running) return;
    const kd = (e: KeyboardEvent) => {
      if (e.key.startsWith("Arrow") || e.key === " ") e.preventDefault();
      const g = G.current;
      const L = live.current;
      if (!L.running || g.finished || g.over || !g.cur || g.flashT > 0) return;
      switch (e.key) {
        case "ArrowLeft":
          if (tryMove(g, -1, 0)) throttledMoveSnd(g, L);
          break;
        case "ArrowRight":
          if (tryMove(g, 1, 0)) throttledMoveSnd(g, L);
          break;
        case "ArrowDown":
          if (tryMove(g, 0, 1)) {
            g.acc = 0;
            throttledMoveSnd(g, L);
          } else lockPiece(g, L);
          break;
        case "ArrowUp":
          if (!e.repeat && rotatePiece(g)) L.play("flip");
          break;
        case " ":
          if (!e.repeat) {
            hardDrop(g);
            L.play("bounce");
            lockPiece(g, L);
          }
          break;
      }
    };
    window.addEventListener("keydown", kd);
    return () => window.removeEventListener("keydown", kd);
  }, [running]);

  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    let raf = 0;

    const drawCell = (x: number, y: number, size: number, color: string) => {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, size, size);
      ctx.fillStyle = "rgba(255,255,255,0.22)";
      ctx.fillRect(x, y, size, 3);
      ctx.fillRect(x, y, 3, size);
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      ctx.fillRect(x, y + size - 3, size, 3);
      ctx.fillRect(x + size - 3, y, 3, size);
    };

    const draw = (g: State, L: Live) => {
      const th = THEMES[L.theme];
      const cols = pieceColors(th);
      ctx.clearRect(0, 0, GW, GH);
      const grad = ctx.createLinearGradient(0, 0, 0, GH);
      grad.addColorStop(0, th.ramp[1] + "44");
      grad.addColorStop(1, th.ramp[0] + "00");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, GW, GH);

      // playfield panel + grid lines
      ctx.fillStyle = th.panel;
      ctx.fillRect(PX, PY, PW, PH);
      ctx.globalAlpha = 0.13;
      ctx.strokeStyle = th.ramp[2];
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 1; x < COLS; x++) {
        ctx.moveTo(PX + x * CELL + 0.5, PY);
        ctx.lineTo(PX + x * CELL + 0.5, PY + PH);
      }
      for (let y = 1; y < ROWS; y++) {
        ctx.moveTo(PX, PY + y * CELL + 0.5);
        ctx.lineTo(PX + PW, PY + y * CELL + 0.5);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;

      // settled cells
      for (let y = 0; y < ROWS; y++)
        for (let x = 0; x < COLS; x++) {
          const v = g.grid[y * COLS + x];
          if (v) drawCell(PX + x * CELL, PY + y * CELL, CELL, cols[v - 1] ?? th.accent);
        }

      // ghost + active piece
      if (g.cur && !g.over) {
        const p = g.cur;
        let gy = p.y;
        while (!collides(g.grid, p.m, p.x, gy + 1)) gy++;
        if (gy !== p.y) {
          ctx.globalAlpha = 0.3;
          ctx.strokeStyle = cols[p.k] ?? th.accent;
          ctx.lineWidth = 1;
          for (let r = 0; r < p.m.length; r++)
            for (let cc = 0; cc < p.m[r].length; cc++)
              if (p.m[r][cc] && gy + r >= 0)
                ctx.strokeRect(PX + (p.x + cc) * CELL + 1.5, PY + (gy + r) * CELL + 1.5, CELL - 3, CELL - 3);
          ctx.globalAlpha = 1;
        }
        for (let r = 0; r < p.m.length; r++)
          for (let cc = 0; cc < p.m[r].length; cc++)
            if (p.m[r][cc] && p.y + r >= 0) drawCell(PX + (p.x + cc) * CELL, PY + (p.y + r) * CELL, CELL, cols[p.k] ?? th.accent);
      }

      // line-clear flash
      if (g.flashT > 0 && g.flashRows.length) {
        ctx.globalAlpha = Math.max(0, Math.min(1, g.flashT / 0.26));
        ctx.fillStyle = th.ramp[4];
        for (const y of g.flashRows) ctx.fillRect(PX, PY + y * CELL, PW, CELL);
        ctx.globalAlpha = 1;
      }

      // frame + corner accents
      ctx.strokeStyle = th.ramp[2];
      ctx.lineWidth = 2;
      ctx.strokeRect(PX - 1, PY - 1, PW + 2, PH + 2);
      ctx.fillStyle = th.accent;
      for (const [ax, ay] of [[PX - 4, PY - 4], [PX + PW - 2, PY - 4], [PX - 4, PY + PH - 2], [PX + PW - 2, PY + PH - 2]])
        ctx.fillRect(ax, ay, 6, 6);

      // HUD
      ctx.textAlign = "left";
      ctx.font = "10px monospace";
      ctx.fillStyle = th.dim;
      ctx.fillText("SCORE", 200, 26);
      ctx.font = "bold 18px monospace";
      ctx.fillStyle = th.ink;
      ctx.fillText(String(g.score), 200, 47);
      ctx.font = "10px monospace";
      ctx.fillStyle = th.dim;
      ctx.fillText("LINES", 200, 78);
      ctx.fillText("LEVEL", 298, 78);
      ctx.font = "bold 16px monospace";
      ctx.fillStyle = th.ink;
      ctx.fillText(String(g.lines), 200, 98);
      ctx.fillText(String(g.level), 298, 98);

      ctx.font = "10px monospace";
      ctx.fillStyle = th.dim;
      ctx.fillText("NEXT", 200, 130);
      ctx.strokeStyle = th.ramp[2];
      ctx.lineWidth = 1;
      ctx.strokeRect(200.5, 140.5, 148, 72);
      const nm = SHAPES[g.nextK] ?? SHAPES[0];
      const cw = 14;
      const mw = (nm[0]?.length ?? 4) * cw;
      const mh = nm.length * cw;
      const ox = 200 + (148 - mw) / 2;
      const oy = 140 + (72 - mh) / 2;
      for (let r = 0; r < nm.length; r++)
        for (let cc = 0; cc < (nm[r]?.length ?? 0); cc++)
          if (nm[r][cc]) drawCell(ox + cc * cw, oy + r * cw, cw, cols[g.nextK] ?? th.accent);

      ctx.font = "9px monospace";
      ctx.fillStyle = th.dim;
      ctx.textAlign = "center";
      ctx.fillText("←→ move · ↑ rotate", 274, 234);
      ctx.fillText("↓ soft · space drop", 274, 248);
      ctx.fillText(`${g.score >= 1000 ? "nice stack" : "clear lines = 100 x n²"}`, 274, 274);
      ctx.textAlign = "left";
    };

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const g = G.current;
      const L = live.current;
      if (!g.last) g.last = now;
      const dt = Math.min(0.05, (now - g.last) / 1000);
      g.last = now;

      if (L.running && !g.finished && !g.over) {
        if (g.flashT > 0) {
          g.flashT -= dt;
          if (g.flashT <= 0) {
            g.flashT = 0;
            removeRows(g);
          }
        } else if (g.cur) {
          g.acc += dt;
          const interval = dropInterval(g.level);
          let guard = 0;
          while (g.acc >= interval && !g.over && guard++ < 4) {
            g.acc -= interval;
            if (g.cur && !collides(g.grid, g.cur.m, g.cur.x, g.cur.y + 1)) g.cur.y++;
            else {
              lockPiece(g, L);
              break;
            }
          }
        } else {
          spawnCur(g, L);
        }
      }

      draw(g, L);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="grid h-full w-full place-items-center p-2">
      <canvas
        ref={cv}
        width={GW}
        height={GH}
        tabIndex={0}
        aria-label="Falling Blocks game: stack pieces and clear lines"
        className="pixelated max-h-full max-w-full rounded-2xl outline-none"
        style={{ aspectRatio: `${GW}/${GH}`, touchAction: "none" }}
      />
    </div>
  );
}
