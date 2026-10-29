"use client";

import { useCallback, useEffect, useRef } from "react";
import type { GameComponentProps } from "@/components/games/GameShell";
import { useStore } from "@/lib/store";
import { THEMES } from "@/lib/themes";
import { clamp } from "@/lib/util";

// ---- Breakout — three real levels -------------------------------------------
// Three hand-laid brick patterns (classic wall → checkerboard → the diamond),
// falling powerups (WIDE paddle / SLOW ball / +1 life) dropped by ~1 in 5
// bricks, 3 lives (up to 5 via powerups), a level transition screen and
// space/P pause. Ball speeds up as you clear and with every level.

const GW = 400, GH = 300;
const PADH = 9, PADY = GH - 18;
const PADW = 64, PADW_WIDE = 96;
const ROWS = 6, COLS = 8, BW = 44, BH = 12, BGAP = 4, BX0 = 10, BY0 = 34, BSTEP = 16;
const BALL = 6;
const ROWVAL = [6, 5, 4, 3, 2, 1];

type PowerKind = "wide" | "slow" | "life";
type Power = { x: number; y: number; kind: PowerKind };
type Phase = "serve" | "play" | "levelup";

/** per-level brick patterns on the 6×8 grid */
const LEVELS: { name: string; build: (r: number, c: number) => boolean }[] = [
  { name: "the classic wall", build: () => true },
  { name: "the checkerboard", build: (r, c) => r < 2 || (r + c) % 2 === 0 },
  { name: "the diamond", build: (r, c) => Math.abs(r - 2.5) + Math.abs(c - 3.5) <= 4.4 },
];

function buildLevel(level: number): boolean[] {
  const spec = LEVELS[Math.min(LEVELS.length, level) - 1];
  return Array.from({ length: ROWS * COLS }, (_, i) => spec.build(Math.floor(i / COLS), i % COLS));
}

type State = {
  px: number; target: number;
  bx: number; by: number; vx: number; vy: number; stuck: boolean; serveT: number;
  bricks: boolean[]; score: number; lives: number; broken: number; speed: number;
  flash: number; last: number; finished: boolean;
  level: number; phase: Phase; levelT: number;
  powers: Power[]; wideT: number; slowT: number; padW: number; powerCd: number;
  paused: boolean;
};

function makeState(): State {
  return {
    px: GW / 2, target: GW / 2,
    bx: GW / 2, by: PADY - BALL / 2 - 1, vx: 0, vy: 0, stuck: true, serveT: 1,
    bricks: buildLevel(1),
    score: 0, lives: 3, broken: 0, speed: 170, flash: 0, last: 0, finished: false,
    level: 1, phase: "serve", levelT: 0,
    powers: [], wideT: 0, slowT: 0, padW: PADW, powerCd: 0,
    paused: false,
  };
}

export default function BreakoutGame({ running, onEnd, play }: GameComponentProps) {
  const cv = useRef<HTMLCanvasElement>(null);
  const theme = useStore((s) => s.theme);
  const G = useRef(makeState());
  const keys = useRef(new Set<string>());
  const live = useRef({ running, onEnd, play, theme });
  // keep latest props reachable from the rAF loop without re-subscribing
  useEffect(() => {
    live.current = { running, onEnd, play, theme };
  });

  // reset when a fresh run begins
  const prevRun = useRef(running);
  useEffect(() => {
    if (running && !prevRun.current) {
      G.current = makeState();
      keys.current.clear();
    }
    prevRun.current = running;
  }, [running]);

  const launch = useCallback(() => {
    const g = G.current, L = live.current;
    if (!L.running || g.finished || !g.stuck || g.paused || g.phase !== "serve") return;
    g.stuck = false;
    g.phase = "play";
    const a = Math.random() * 0.7 - 0.35;
    g.vx = g.speed * Math.sin(a);
    g.vy = -g.speed * Math.cos(a);
    L.play("bounce");
  }, []);

  const togglePause = useCallback(() => {
    const g = G.current;
    if (g.finished) return;
    g.paused = !g.paused;
    live.current.play("click");
  }, []);

  // keyboard — attached only while running
  useEffect(() => {
    if (!running) return;
    const kd = (e: KeyboardEvent) => {
      if (e.key.startsWith("Arrow") || e.key === " ") e.preventDefault();
      keys.current.add(e.key);
      if (e.key === " ") {
        const g = G.current;
        if (g.stuck && !g.paused) launch();
        else togglePause();
      }
      if (e.key === "p" || e.key === "P") togglePause();
    };
    const ku = (e: KeyboardEvent) => keys.current.delete(e.key);
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    return () => {
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
      keys.current.clear();
    };
  }, [running, launch, togglePause]);

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

    const resetBall = (g: State) => {
      g.stuck = true;
      g.serveT = 1.1;
      g.vx = 0;
      g.vy = 0;
      g.phase = "serve";
    };

    const clearBoosts = (g: State) => {
      g.powers = [];
      g.wideT = 0;
      g.slowT = 0;
    };

    const nextLevel = (g: State) => {
      g.level++;
      g.bricks = buildLevel(g.level);
      g.speed = Math.min(300, 170 + (g.level - 1) * 25);
      clearBoosts(g);
      resetBall(g);
    };

    const applyPower = (g: State, kind: PowerKind) => {
      if (kind === "wide") {
        g.wideT = 10;
        live.current.play("shield");
      } else if (kind === "slow") {
        g.slowT = 8;
        live.current.play("zoom");
      } else {
        g.lives = Math.min(5, g.lives + 1);
        live.current.play("happy");
      }
    };

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const g = G.current, L = live.current;
      if (!g.last) g.last = now;
      const dt = Math.min(0.04, (now - g.last) / 1000);
      g.last = now;

      if (L.running && !g.finished && !g.paused) {
        // paddle
        if (keys.current.has("ArrowLeft") || keys.current.has("a")) g.target -= 340 * dt;
        if (keys.current.has("ArrowRight") || keys.current.has("d")) g.target += 340 * dt;
        // boost timers + paddle width easing
        g.wideT = Math.max(0, g.wideT - dt);
        g.slowT = Math.max(0, g.slowT - dt);
        g.powerCd = Math.max(0, g.powerCd - dt);
        const wantW = g.wideT > 0 ? PADW_WIDE : PADW;
        g.padW += clamp(wantW - g.padW, -190 * dt, 190 * dt);
        g.target = clamp(g.target, g.padW / 2 + 2, GW - g.padW / 2 - 2);
        g.px += (g.target - g.px) * Math.min(1, dt * 16);

        // level transition countdown
        if (g.phase === "levelup") {
          g.levelT -= dt;
          if (g.levelT <= 0) {
            nextLevel(g);
          }
        } else if (g.stuck) {
          g.bx = g.px;
          g.by = PADY - BALL / 2 - 1;
          g.serveT -= dt;
          if (g.serveT <= 0) launch();
        } else {
          const f = g.slowT > 0 ? 0.68 : 1;
          const steps = Math.max(1, Math.min(4, Math.ceil(((Math.abs(g.vx) + Math.abs(g.vy)) * f * dt) / 6)));
          for (let i = 0; i < steps && !g.stuck && !g.finished; i++) {
            const sdt = dt / steps;
            g.bx += g.vx * f * sdt;
            g.by += g.vy * f * sdt;
            // walls
            if (g.bx < BALL / 2 + 2) { g.bx = BALL / 2 + 2; g.vx = Math.abs(g.vx); L.play("bounce"); }
            if (g.bx > GW - BALL / 2 - 2) { g.bx = GW - BALL / 2 - 2; g.vx = -Math.abs(g.vx); L.play("bounce"); }
            if (g.by < BALL / 2 + 2) { g.by = BALL / 2 + 2; g.vy = Math.abs(g.vy); L.play("bounce"); }
            // paddle
            if (g.vy > 0 && g.by + BALL / 2 >= PADY && g.by - BALL / 2 <= PADY + PADH && Math.abs(g.bx - g.px) <= g.padW / 2 + 3) {
              const rel = clamp((g.bx - g.px) / (g.padW / 2), -1, 1);
              const ang = rel * 1.05;
              g.vx = g.speed * Math.sin(ang);
              g.vy = -g.speed * Math.cos(ang);
              g.by = PADY - BALL / 2 - 0.5;
              L.play("bounce");
            }
            // bricks
            for (let idx = 0; idx < g.bricks.length; idx++) {
              if (!g.bricks[idx]) continue;
              const row = Math.floor(idx / COLS), col = idx % COLS;
              const cx = BX0 + col * (BW + BGAP) + BW / 2;
              const cy = BY0 + row * BSTEP + BH / 2;
              const dx = g.bx - cx, dy = g.by - cy;
              const penX = BW / 2 + BALL / 2 - Math.abs(dx);
              const penY = BH / 2 + BALL / 2 - Math.abs(dy);
              if (penX > 0 && penY > 0) {
                g.bricks[idx] = false;
                g.broken++;
                g.score += ROWVAL[row];
                if (penX < penY) {
                  g.vx = dx < 0 ? -Math.abs(g.vx) : Math.abs(g.vx);
                  g.bx += dx < 0 ? -penX : penX;
                } else {
                  g.vy = dy < 0 ? -Math.abs(g.vy) : Math.abs(g.vy);
                  g.by += dy < 0 ? -penY : penY;
                }
                L.play("pop");
                // ~1 in 5 bricks drops a powerup (never floods the screen)
                if (Math.random() < 0.22 && g.powerCd <= 0 && g.powers.length < 2) {
                  const r = Math.random();
                  const kind: PowerKind = r < 0.42 ? "wide" : r < 0.75 ? "slow" : "life";
                  g.powers.push({ x: cx, y: cy, kind });
                  g.powerCd = 1.4;
                }
                if (g.broken % 10 === 0 && g.speed < 290) {
                  g.speed += 18;
                  const m = Math.hypot(g.vx, g.vy) || 1;
                  g.vx *= g.speed / m;
                  g.vy *= g.speed / m;
                  L.play("star");
                }
                break;
              }
            }
            // fell below
            if (g.by > GH + 10) {
              g.lives--;
              g.flash = 0.35;
              L.play("hit");
              clearBoosts(g);
              if (g.lives <= 0) {
                finish();
                break;
              }
              resetBall(g);
              break;
            }
          }
          // falling powerups
          g.powers = g.powers.filter((p) => {
            p.y += 95 * dt;
            if (p.y > PADY - 8 && p.y < PADY + PADH + 6 && Math.abs(p.x - g.px) <= g.padW / 2 + 6) {
              applyPower(g, p.kind);
              return false;
            }
            return p.y < GH + 12;
          });
          // level cleared?
          if (!g.bricks.some(Boolean) && !g.finished && g.phase === "play") {
            g.score += 50 * g.level;
            if (g.level >= LEVELS.length) {
              g.score += 150; // full-clear bonus
              L.play("level");
              finish();
            } else {
              g.phase = "levelup";
              g.levelT = 1.7;
              clearBoosts(g);
              L.play("level");
            }
          }
        }
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

      // bricks (colour shifts one row per level)
      for (let idx = 0; idx < g.bricks.length; idx++) {
        if (!g.bricks[idx]) continue;
        const row = Math.floor(idx / COLS), col = idx % COLS;
        const x = BX0 + col * (BW + BGAP), y = BY0 + row * BSTEP;
        const rr = (row + g.level - 1) % ROWS;
        ctx.fillStyle = rr === 0 ? th.accent : rr === 1 ? th.ramp[4] : rr % 2 === 0 ? th.ramp[3] : th.ramp[2];
        ctx.fillRect(x, y, BW, BH);
        ctx.globalAlpha = 0.45;
        ctx.strokeStyle = th.ramp[0];
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, BW - 1, BH - 1);
        ctx.globalAlpha = 1;
      }

      // falling powerups
      for (const p of g.powers) {
        const col = p.kind === "wide" ? th.accent : p.kind === "slow" ? th.ramp[3] : th.ramp[4];
        ctx.fillStyle = col;
        ctx.fillRect(Math.round(p.x - 9), Math.round(p.y - 5), 18, 10);
        ctx.strokeStyle = th.ramp[0];
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(p.x - 9) + 0.5, Math.round(p.y - 5) + 0.5, 17, 9);
        ctx.fillStyle = th.ramp[0];
        ctx.font = "bold 9px monospace";
        ctx.textAlign = "center";
        ctx.fillText(p.kind === "wide" ? "W" : p.kind === "slow" ? "S" : "+", Math.round(p.x), Math.round(p.y) + 3);
        ctx.textAlign = "left";
      }

      // paddle
      ctx.fillStyle = th.accent;
      ctx.fillRect(Math.round(g.px - g.padW / 2), PADY, Math.round(g.padW), PADH);
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = th.ramp[4];
      ctx.fillRect(Math.round(g.px - 10), PADY + 2, 20, 2);
      ctx.globalAlpha = 1;

      // ball
      ctx.fillStyle = th.dark ? th.ramp[4] : th.ramp[0];
      ctx.fillRect(Math.round(g.bx - BALL / 2), Math.round(g.by - BALL / 2), BALL, BALL);

      // hud
      ctx.font = "bold 15px monospace";
      ctx.fillStyle = th.ink;
      ctx.fillText(`SCORE ${g.score}`, 12, 24);
      ctx.font = "11px monospace";
      ctx.fillStyle = th.dim;
      ctx.fillText(`LV ${g.level}/${LEVELS.length}`, 12, 40);
      const left = g.bricks.reduce((a, b) => a + (b ? 1 : 0), 0);
      ctx.fillText(`${left} BRICKS`, 12, 54);
      for (let i = 0; i < Math.max(3, Math.min(5, g.lives)); i++) {
        ctx.fillStyle = i < g.lives ? th.accent : th.ramp[1];
        ctx.fillRect(GW - 22 - i * 15, 12, 11, 11);
      }
      // active boost timers
      ctx.font = "9px monospace";
      if (g.wideT > 0) {
        ctx.fillStyle = th.accent;
        ctx.fillText(`WIDE ${Math.ceil(g.wideT)}s`, GW - 12, 38);
      }
      if (g.slowT > 0) {
        ctx.fillStyle = th.ramp[3];
        ctx.fillText(`SLOW ${Math.ceil(g.slowT)}s`, GW - 12, g.wideT > 0 ? 50 : 38);
      }

      // prompts & overlays
      ctx.textAlign = "center";
      if (g.phase === "levelup") {
        ctx.fillStyle = "rgba(0,0,0,.45)";
        ctx.fillRect(0, 0, GW, GH);
        ctx.font = "bold 19px monospace";
        ctx.fillStyle = th.ink;
        ctx.fillText(`LEVEL ${g.level} CLEARED!`, GW / 2, GH / 2 - 14);
        ctx.font = "11px monospace";
        ctx.fillStyle = th.dim;
        ctx.fillText(`next up: ${LEVELS[Math.min(LEVELS.length - 1, g.level)]?.name ?? ""}`, GW / 2, GH / 2 + 6);
        ctx.fillStyle = th.ramp[1];
        ctx.fillRect(GW / 2 - 60, GH / 2 + 16, 120, 5);
        ctx.fillStyle = th.accent;
        ctx.fillRect(GW / 2 - 60, GH / 2 + 16, 120 * (1 - Math.max(0, g.levelT) / 1.7), 5);
      } else if (g.paused) {
        ctx.fillStyle = "rgba(0,0,0,.45)";
        ctx.fillRect(0, 0, GW, GH);
        ctx.font = "bold 20px monospace";
        ctx.fillStyle = th.ink;
        ctx.fillText("PAUSED", GW / 2, GH / 2 - 6);
        ctx.font = "11px monospace";
        ctx.fillStyle = th.dim;
        ctx.fillText("SPACE or P to resume", GW / 2, GH / 2 + 16);
      } else if (g.stuck && L.running && !g.finished && Math.floor(now / 450) % 2 === 0) {
        ctx.font = "12px monospace";
        ctx.fillStyle = th.dim;
        ctx.fillText("CLICK OR SPACE TO LAUNCH", GW / 2, 200);
      }
      ctx.textAlign = "left";

      if (g.flash > 0) {
        ctx.globalAlpha = Math.min(0.45, g.flash);
        ctx.fillStyle = th.ramp[0];
        ctx.fillRect(0, 0, GW, GH);
        ctx.globalAlpha = 1;
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [launch, togglePause]);

  return (
    <div className="grid h-full w-full place-items-center p-2">
      <canvas
        ref={cv}
        width={GW}
        height={GH}
        tabIndex={0}
        aria-label="Breakout game"
        className="pixelated max-h-full max-w-full rounded-2xl outline-none"
        style={{ aspectRatio: `${GW}/${GH}`, touchAction: "none", cursor: running ? "none" : "default" }}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          G.current.target = ((e.clientX - r.left) / r.width) * GW;
        }}
        onPointerDown={(e) => {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          G.current.target = ((e.clientX - r.left) / r.width) * GW;
          launch();
        }}
      />
    </div>
  );
}
