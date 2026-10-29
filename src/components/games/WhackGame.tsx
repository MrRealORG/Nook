"use client";

import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { useStore } from "@/lib/store";
import { THEMES } from "@/lib/themes";
import type { GameComponentProps } from "@/components/games/GameShell";

const GW = 400, GH = 300, TIME = 30;
const COLS = 3, CELL = 84;
const GX = (GW - COLS * CELL) / 2, GY = 40;
const HOLE_W = 64, HOLE_H = 20;

type Kind = "note" | "bug";
type Hole = { kind: Kind | null; p: number; dur: number };
type Fx = { x: number; y: number; vx: number; vy: number; life: number; c: string };
const blankHoles = (): Hole[] => Array.from({ length: COLS * COLS }, () => ({ kind: null, p: 0, dur: 800 }));

export default function WhackGame({ running, onEnd, play }: GameComponentProps) {
  const cv = useRef<HTMLCanvasElement>(null);
  const theme = useStore((s) => s.theme);
  const G = useRef({ holes: blankHoles(), score: 0, t: 0, spawn: 0.4, stunUntil: 0, fx: [] as Fx[], hover: -1, last: 0, finished: false });
  const live = useRef({ theme, running, onEnd, play });
  useEffect(() => {
    live.current = { theme, running, onEnd, play };
  });

  // RESET all state when a new run starts
  useEffect(() => {
    if (!running) return;
    const g = G.current;
    g.holes = blankHoles();
    g.score = 0; g.t = 0; g.spawn = 0.4; g.stunUntil = 0;
    g.fx = []; g.hover = -1; g.last = 0; g.finished = false;
  }, [running]);

  const burst = (x: number, y: number, color: string, n: number) => {
    const g = G.current;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, sp = 60 + Math.random() * 140;
      g.fx.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 70, life: 0.45 + Math.random() * 0.25, c: color });
    }
  };

  const cellCenter = (i: number) => ({ x: GX + (i % COLS) * CELL + CELL / 2, y: GY + Math.floor(i / COLS) * CELL + CELL - 16 });

  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    let raf = 0;

    const finish = () => {
      const g = G.current;
      if (g.finished) return;
      g.finished = true;
      live.current.onEnd(g.score);
    };

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const g = G.current;
      const L = live.current;
      const isRun = L.running && !g.finished;
      if (!g.last) g.last = now;
      const dt = Math.min(0.04, (now - g.last) / 1000);
      g.last = now;

      if (isRun) {
        g.t += dt;
        g.spawn -= dt;
        if (g.spawn <= 0) {
          const empty: number[] = [];
          for (let i = 0; i < g.holes.length; i++) if (!g.holes[i].kind) empty.push(i);
          if (empty.length) {
            const i = empty[Math.floor(Math.random() * empty.length)];
            const bug = Math.random() < 0.24;
            g.holes[i] = { kind: bug ? "bug" : "note", p: 0, dur: bug ? 850 + Math.random() * 350 : 600 + Math.random() * 400 };
          }
          g.spawn = Math.max(0.36, 0.8 - g.t * 0.013) + Math.random() * 0.25;
        }
        for (const h of g.holes) if (h.kind) { h.p += (dt * 1000) / h.dur; if (h.p >= 1) h.kind = null; }
        for (const f of g.fx) { f.life -= dt; f.x += f.vx * dt; f.y += f.vy * dt; f.vy += 430 * dt; }
        g.fx = g.fx.filter((f) => f.life > 0 && f.y < GH);
        if (g.t >= TIME) finish();
      }

      // ---- draw ----
      const th = THEMES[L.theme];
      ctx.clearRect(0, 0, GW, GH);
      const grad = ctx.createLinearGradient(0, 0, 0, GH);
      grad.addColorStop(0, th.ramp[1] + "55");
      grad.addColorStop(1, th.ramp[0] + "00");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, GW, GH);

      ctx.font = "14px monospace";
      ctx.fillStyle = th.ink;
      ctx.textAlign = "left";
      ctx.fillText(`SCORE ${g.score}`, 12, 24);
      ctx.textAlign = "right";
      ctx.fillText(`${Math.max(0, Math.ceil(TIME - g.t))}s`, GW - 12, 24);
      ctx.textAlign = "left";
      ctx.fillStyle = th.ramp[1];
      ctx.fillRect(GW / 2 - 55, 15, 110, 7);
      ctx.fillStyle = th.accent;
      ctx.fillRect(GW / 2 - 55, 15, 110 * Math.max(0, 1 - g.t / TIME), 7);

      const stunned = L.running && now < g.stunUntil;
      if (stunned) {
        ctx.fillStyle = th.ramp[0] + "66";
        ctx.fillRect(0, 30, GW, GH - 30);
        ctx.font = "16px monospace";
        ctx.fillStyle = th.ink;
        ctx.textAlign = "center";
        ctx.fillText("* DIZZY *", GW / 2, GY + 24);
        ctx.textAlign = "left";
      }

      for (let i = 0; i < g.holes.length; i++) {
        const col = i % COLS, row = Math.floor(i / COLS);
        const { x: cx, y: cy } = cellCenter(i);
        // cell plate (brightens on hover)
        ctx.fillStyle = th.ramp[1] + (i === g.hover && !stunned && isRun ? "55" : "2a");
        ctx.fillRect(GX + col * CELL + 3, GY + row * CELL + 3, CELL - 6, CELL - 6);
        if (i === g.hover && !stunned && isRun) {
          ctx.strokeStyle = th.accent;
          ctx.lineWidth = 2;
          ctx.strokeRect(GX + col * CELL + 4, GY + row * CELL + 4, CELL - 8, CELL - 8);
        }
        // hole back
        ctx.fillStyle = th.ramp[0];
        ctx.beginPath();
        ctx.ellipse(cx, cy, HOLE_W / 2, HOLE_H / 2, 0, 0, Math.PI * 2);
        ctx.fill();
        // rising sprite (shrinks as its lifetime runs out)
        const h = g.holes[i];
        if (h.kind) {
          const up = h.p < 0.22 ? h.p / 0.22 : h.p > 0.78 ? (1 - h.p) / 0.22 : 1;
          const s = 1 - h.p * 0.38;
          ctx.save();
          ctx.translate(cx, cy + 10 - up * 34);
          ctx.scale(s, s);
          if (h.kind === "note") {
            ctx.fillStyle = th.ramp[4];
            ctx.fillRect(-8, -26, 16, 26);
            ctx.fillStyle = th.ramp[2];
            ctx.fillRect(8, -26, 4, 12);
            ctx.fillStyle = th.ramp[1];
            ctx.fillRect(-8, -19, 16, 2);
            ctx.fillRect(-8, -12, 16, 2);
            ctx.fillStyle = th.ramp[0];
            ctx.fillRect(-5, -24, 3, 4);
            ctx.fillRect(2, -24, 3, 4);
          } else {
            ctx.fillStyle = th.ramp[0];
            ctx.fillRect(-10, -7, 20, 12);
            ctx.fillRect(-13, -3, 26, 5);
            ctx.fillStyle = th.ramp[2];
            ctx.fillRect(-9, -5, 18, 9);
            ctx.fillStyle = th.accent;
            ctx.fillRect(-5, -3, 3, 3);
            ctx.fillRect(2, -3, 3, 3);
            ctx.fillStyle = th.ramp[0];
            const leg = Math.floor(now / 110) % 2;
            ctx.fillRect(-11 + leg * 2, 5, 2, 4);
            ctx.fillRect(9, 5, 2, 4);
          }
          ctx.restore();
        }
        // hole front lip occludes the sprite's bottom
        ctx.fillStyle = th.ramp[0];
        ctx.beginPath();
        ctx.ellipse(cx, cy, HOLE_W / 2, HOLE_H / 2, 0, 0, Math.PI);
        ctx.fill();
      }

      for (const f of g.fx) {
        ctx.globalAlpha = Math.min(1, f.life * 2.5);
        ctx.fillStyle = f.c;
        ctx.fillRect(Math.round(f.x), Math.round(f.y), 3, 3);
      }
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const cellAt = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * GW;
    const y = ((e.clientY - r.top) / r.height) * GH;
    const col = Math.floor((x - GX) / CELL), row = Math.floor((y - GY) / CELL);
    if (col < 0 || col >= COLS || row < 0 || row >= COLS) return -1;
    return row * COLS + col;
  };

  const onDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const g = G.current;
    const L = live.current;
    if (!L.running || g.finished) return;
    const i = cellAt(e);
    g.hover = i;
    if (i < 0 || performance.now() < g.stunUntil) return;
    const h = g.holes[i];
    if (!h.kind) return;
    const { x: cx, y: cy } = cellCenter(i);
    const th = THEMES[L.theme];
    if (h.kind === "note") {
      g.score += 10;
      L.play("pop");
      burst(cx, cy - 34, th.accent, 9);
    } else {
      g.score = Math.max(0, g.score - 20);
      L.play("hit");
      burst(cx, cy - 26, th.ramp[2], 12);
      g.stunUntil = performance.now() + 400;
    }
    h.kind = null;
  };

  return (
    <div className="grid h-full w-full place-items-center p-2">
      <canvas
        ref={cv}
        width={GW}
        height={GH}
        tabIndex={0}
        className="pixelated max-h-full max-w-full rounded-2xl outline-none"
        style={{ aspectRatio: `${GW}/${GH}`, cursor: running ? "crosshair" : "default", touchAction: "none" }}
        onPointerMove={(e) => { G.current.hover = cellAt(e); }}
        onPointerLeave={() => { G.current.hover = -1; }}
        onPointerDown={onDown}
      />
    </div>
  );
}
