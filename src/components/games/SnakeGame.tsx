"use client";

import { useEffect, useRef, useState } from "react";
import type { GameComponentProps } from "@/components/games/GameShell";
import { useStore } from "@/lib/store";
import { THEMES } from "@/lib/themes";

// ---- Pixel Snake — the real thing -------------------------------------------
// Toggleable walls (die at edges) vs wrap-around edges, three speeds, growing
// rock obstacles from level 4, space = pause, interpolated movement, a death
// flash, and your arcade best score drawn on the HUD (store-backed, so it
// persists exactly like every other game's record).

const GW = 400, GH = 300;
const COLS = 20, ROWS = 15, CELL = 20;

type Cell = { x: number; y: number };
type Dir = { x: number; y: number };
type SpeedId = 0 | 1 | 2;

const DIRS: Record<string, Dir> = {
  ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 }, ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 },
  w: { x: 0, y: -1 }, s: { x: 0, y: 1 }, a: { x: -1, y: 0 }, d: { x: 1, y: 0 },
};

const SPEEDS: { label: string; base: number; min: number }[] = [
  { label: "Slow", base: 0.16, min: 0.095 },
  { label: "Normal", base: 0.12, min: 0.068 },
  { label: "Fast", base: 0.09, min: 0.052 },
];

type State = {
  snake: Cell[]; dir: Dir; pending: Dir[]; food: Cell; obstacles: Cell[];
  eaten: number; score: number; dead: boolean; deadT: number; flash: number;
  acc: number; last: number; finished: boolean; sndAt: number;
  walls: boolean; speedId: SpeedId; paused: boolean; level: number; grew: boolean;
};

function makeState(): State {
  return {
    snake: [{ x: 9, y: 7 }, { x: 8, y: 7 }, { x: 7, y: 7 }],
    dir: { x: 1, y: 0 },
    pending: [],
    food: { x: 14, y: 7 },
    obstacles: [],
    eaten: 0, score: 0, dead: false, deadT: 0, flash: 0, acc: 0, last: 0, finished: false, sndAt: 0,
    walls: true, speedId: 1, paused: false, level: 1, grew: false,
  };
}

export default function SnakeGame({ running, onEnd, play }: GameComponentProps) {
  const cv = useRef<HTMLCanvasElement>(null);
  const theme = useStore((s) => s.theme);
  const best = useStore((s) => s.gameScores["snake"] ?? 0);
  const G = useRef(makeState());
  const [wallsUi, setWallsUi] = useState(true);
  const [speedUi, setSpeedUi] = useState<SpeedId>(1);
  const live = useRef({ running, onEnd, play, theme, best });
  // keep latest props reachable from the rAF loop without re-subscribing
  useEffect(() => {
    live.current = { running, onEnd, play, theme, best };
  });

  // reset when a fresh run begins (component may stay mounted between runs)
  const prevRun = useRef(running);
  useEffect(() => {
    if (running && !prevRun.current) G.current = makeState();
    prevRun.current = running;
  }, [running]);

  const pickWalls = (v: boolean) => {
    G.current.walls = v;
    setWallsUi(v);
    play("click");
  };
  const pickSpeed = (id: SpeedId) => {
    G.current.speedId = id;
    setSpeedUi(id);
    play("click");
  };

  // steering + pause — listeners attached only while running
  useEffect(() => {
    if (!running) return;
    const kd = (e: KeyboardEvent) => {
      if (e.key.startsWith("Arrow") || e.key === " ") e.preventDefault();
      if (e.key === " ") {
        const g = G.current;
        if (!g.dead && !g.finished) {
          g.paused = !g.paused;
          live.current.play("click");
        }
        return;
      }
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const d = DIRS[k];
      if (!d) return;
      const g = G.current;
      if (g.dead || g.finished) return;
      const last = g.pending[g.pending.length - 1] ?? g.dir;
      if ((d.x === last.x && d.y === last.y) || (d.x === -last.x && d.y === -last.y)) return;
      if (g.pending.length < 3) {
        g.pending.push(d);
        const now = performance.now();
        if (now - g.sndAt > 140) {
          g.sndAt = now;
          live.current.play("move");
        }
      }
    };
    window.addEventListener("keydown", kd);
    return () => window.removeEventListener("keydown", kd);
  }, [running]);

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

    const spawnFood = (g: State) => {
      const free: Cell[] = [];
      for (let y = 0; y < ROWS; y++)
        for (let x = 0; x < COLS; x++)
          if (!g.snake.some((s) => s.x === x && s.y === y) && !g.obstacles.some((o) => o.x === x && o.y === y)) free.push({ x, y });
      g.food = free[Math.floor(Math.random() * free.length)] ?? { x: 0, y: 0 };
    };

    const addObstacle = (g: State) => {
      for (let tries = 0; tries < 60; tries++) {
        const x = 1 + Math.floor(Math.random() * (COLS - 2));
        const y = 1 + Math.floor(Math.random() * (ROWS - 2));
        const far = Math.abs(x - g.snake[0].x) + Math.abs(y - g.snake[0].y) >= 4;
        if (!far) continue;
        if (g.snake.some((s) => s.x === x && s.y === y)) continue;
        if (g.obstacles.some((o) => o.x === x && o.y === y)) continue;
        if (g.food.x === x && g.food.y === y) continue;
        g.obstacles.push({ x, y });
        return;
      }
    };

    const die = () => {
      const g = G.current;
      g.dead = true;
      g.deadT = 0.85;
      g.flash = 0.5;
      live.current.play("hit");
    };

    const step = () => {
      const g = G.current;
      while (g.pending.length) {
        const d = g.pending.shift()!;
        if (d.x === -g.dir.x && d.y === -g.dir.y) continue;
        g.dir = d;
        break;
      }
      const head = g.snake[0];
      const nh = { x: head.x + g.dir.x, y: head.y + g.dir.y };
      if (g.walls && (nh.x < 0 || nh.y < 0 || nh.x >= COLS || nh.y >= ROWS)) {
        die();
        return;
      }
      // wrap-around mode: edges teleport
      nh.x = ((nh.x % COLS) + COLS) % COLS;
      nh.y = ((nh.y % ROWS) + ROWS) % ROWS;
      const eating = nh.x === g.food.x && nh.y === g.food.y;
      const body = eating ? g.snake : g.snake.slice(0, -1);
      if (body.some((s) => s.x === nh.x && s.y === nh.y) || g.obstacles.some((o) => o.x === nh.x && o.y === nh.y)) {
        die();
        return;
      }
      g.grew = eating;
      g.snake.unshift(nh);
      if (eating) {
        g.eaten++;
        g.score += 10;
        live.current.play("coin");
        const newLevel = 1 + Math.floor(g.eaten / 5);
        if (newLevel !== g.level) {
          g.level = newLevel;
          live.current.play("level");
          // from level 4 on, the arena grows a rock every level
          if (g.level > 3 && g.obstacles.length < 14) addObstacle(g);
        }
        spawnFood(g);
      } else {
        g.snake.pop();
      }
    };

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const g = G.current;
      const L = live.current;
      if (!g.last) g.last = now;
      const dt = Math.min(0.05, (now - g.last) / 1000);
      g.last = now;
      const sp = SPEEDS[g.speedId];
      const interval = Math.max(sp.min, sp.base - g.eaten * 0.0035);

      if (L.running && !g.finished && !g.dead && !g.paused) {
        g.acc += dt;
        let guard = 0;
        while (g.acc >= interval && !g.dead && guard++ < 4) {
          g.acc -= interval;
          step();
        }
      }
      // death animation: flash + freeze, then report the score
      if (g.dead && !g.finished) {
        g.deadT -= dt;
        if (g.deadT <= 0) finish();
      }
      if (g.flash > 0) g.flash = Math.max(0, g.flash - dt);

      // ---- draw ----
      const th = THEMES[L.theme];
      ctx.clearRect(0, 0, GW, GH);
      const grad = ctx.createLinearGradient(0, 0, 0, GH);
      grad.addColorStop(0, th.ramp[1] + "44");
      grad.addColorStop(1, th.ramp[0] + "00");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, GW, GH);

      ctx.globalAlpha = 0.05;
      ctx.fillStyle = th.ramp[2];
      for (let y = 0; y < ROWS; y++)
        for (let x = 0; x < COLS; x++)
          if ((x + y) % 2 === 0) ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      ctx.globalAlpha = 1;

      // berry
      const bob = Math.sin(now / 180) * 1.5;
      const cx = g.food.x * CELL + 10;
      const cy = g.food.y * CELL + 12 + bob;
      ctx.fillStyle = th.ramp[2];
      ctx.fillRect(cx - 2, Math.round(cy - 10), 5, 3);
      ctx.fillStyle = th.accent;
      ctx.fillRect(cx - 4, Math.round(cy - 6), 9, 9);
      ctx.fillRect(cx - 6, Math.round(cy - 4), 13, 5);
      ctx.fillStyle = th.ramp[0];
      ctx.fillRect(cx - 2, Math.round(cy - 3), 2, 2);
      ctx.fillRect(cx + 2, Math.round(cy), 2, 2);
      ctx.fillStyle = th.ramp[4];
      ctx.fillRect(cx - 3, Math.round(cy - 5), 2, 2);

      // rocks (level 4+)
      for (const o of g.obstacles) {
        const px = o.x * CELL, py = o.y * CELL;
        ctx.fillStyle = th.ramp[1];
        ctx.fillRect(px + 1, py + 1, CELL - 2, CELL - 2);
        ctx.fillStyle = th.ramp[2];
        ctx.fillRect(px + 3, py + 3, CELL - 6, 3);
        ctx.strokeStyle = th.ramp[0];
        ctx.lineWidth = 1;
        ctx.strokeRect(px + 1.5, py + 1.5, CELL - 3, CELL - 3);
      }

      // movement progress inside the current grid step (smooth interpolation)
      const p = !g.dead && !g.paused ? Math.max(0, Math.min(1, g.acc / interval)) : 0;

      // snake
      const len = g.snake.length;
      for (let i = len - 1; i >= 0; i--) {
        const s = g.snake[i];
        let px = s.x * CELL;
        let py = s.y * CELL;
        let w = CELL - 4;
        let h = CELL - 4;
        if (i === 0) {
          // head glides toward the next cell
          px += g.dir.x * p * CELL;
          py += g.dir.y * p * CELL;
        } else if (i === len - 1 && !g.grew && len > 1) {
          // tail retracts from its far edge
          const prev = g.snake[i - 1];
          const ddx = s.x - prev.x;
          const ddy = s.y - prev.y;
          if (Math.abs(ddx) <= 1 && Math.abs(ddy) <= 1) {
            if (ddx === 1) w -= p * CELL;
            else if (ddx === -1) { px += p * CELL; w -= p * CELL; }
            if (ddy === 1) h -= p * CELL;
            else if (ddy === -1) { py += p * CELL; h -= p * CELL; }
          }
        }
        if (i === 0) {
          ctx.fillStyle = g.dead ? th.ramp[2] : th.accent;
          ctx.fillRect(px + 2, py + 2, w, h);
          ctx.fillStyle = th.ramp[0];
          if (g.dir.x !== 0) {
            const ex = g.dir.x > 0 ? px + 11 : px + 6;
            ctx.fillRect(ex, py + 5, 3, 3);
            ctx.fillRect(ex, py + 12, 3, 3);
          } else {
            const ey = g.dir.y > 0 ? py + 11 : py + 6;
            ctx.fillRect(px + 5, ey, 3, 3);
            ctx.fillRect(px + 12, ey, 3, 3);
          }
        } else {
          ctx.fillStyle = g.dead ? th.ramp[2] : th.ramp[3];
          ctx.globalAlpha = i % 2 === 0 ? 0.72 : 1;
          ctx.fillRect(px + 2, py + 2, w, h);
          ctx.globalAlpha = 1;
        }
      }

      // arena border: solid when walls kill you, dashed when edges wrap
      ctx.strokeStyle = th.ramp[2];
      ctx.lineWidth = 2;
      if (g.walls) {
        ctx.setLineDash([]);
        ctx.strokeRect(1, 1, GW - 2, GH - 2);
        ctx.fillStyle = th.accent;
        for (const [ax, ay] of [[1, 1], [GW - 7, 1], [1, GH - 7], [GW - 7, GH - 7]]) ctx.fillRect(ax, ay, 6, 6);
      } else {
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(1, 1, GW - 2, GH - 2);
        ctx.setLineDash([]);
      }

      // hud
      ctx.font = "bold 15px monospace";
      ctx.fillStyle = th.ink;
      ctx.fillText(`SCORE ${g.score}`, 12, 24);
      ctx.font = "10px monospace";
      ctx.fillStyle = th.dim;
      ctx.fillText(`LV ${g.level}`, 12, 38);
      ctx.textAlign = "right";
      ctx.font = "11px monospace";
      ctx.fillText(`BEST ${L.best}  ·  LEN ${g.snake.length}`, GW - 12, 22);
      ctx.textAlign = "left";

      // pause overlay
      if (g.paused && !g.dead) {
        ctx.fillStyle = "rgba(0,0,0,.45)";
        ctx.fillRect(0, 0, GW, GH);
        ctx.textAlign = "center";
        ctx.font = "bold 20px monospace";
        ctx.fillStyle = th.ink;
        ctx.fillText("PAUSED", GW / 2, GH / 2 - 6);
        ctx.font = "11px monospace";
        ctx.fillStyle = th.dim;
        ctx.fillText("SPACE to resume", GW / 2, GH / 2 + 16);
        ctx.textAlign = "left";
      }

      // death flash
      if (g.dead) {
        ctx.globalAlpha = 0.16 + 0.13 * Math.abs(Math.sin(now / 70));
        ctx.fillStyle = "#c9413c";
        ctx.fillRect(0, 0, GW, GH);
        ctx.globalAlpha = 1;
      } else if (g.flash > 0) {
        ctx.globalAlpha = Math.min(0.5, g.flash);
        ctx.fillStyle = th.ramp[0];
        ctx.fillRect(0, 0, GW, GH);
        ctx.globalAlpha = 1;
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-2">
      <div className="flex flex-wrap items-center justify-center gap-2">
        <div className="seg seg-compact" role="group" aria-label="Edge mode">
          <button data-on={wallsUi} onClick={() => pickWalls(true)} title="Classic: hitting a wall ends the run">
            Walls on
          </button>
          <button data-on={!wallsUi} onClick={() => pickWalls(false)} title="Edges wrap around to the other side">
            Wrap edges
          </button>
        </div>
        <div className="seg seg-compact" role="group" aria-label="Speed">
          {SPEEDS.map((s, i) => (
            <button key={s.label} data-on={speedUi === i} onClick={() => pickSpeed(i as SpeedId)}>
              {s.label}
            </button>
          ))}
        </div>
        <span className="kbd hidden sm:inline-block">SPACE pause</span>
      </div>
      <canvas
        ref={cv}
        width={GW}
        height={GH}
        tabIndex={0}
        aria-label="Pixel Snake game board"
        className="pixelated max-h-full max-w-full rounded-2xl outline-none"
        style={{ aspectRatio: `${GW}/${GH}`, touchAction: "none" }}
      />
    </div>
  );
}
