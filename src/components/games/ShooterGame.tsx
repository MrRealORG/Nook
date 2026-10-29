"use client";

import { useEffect, useRef } from "react";
import { useSpeciesPalette } from "@/components/PetView";
import { drawPet, SH, SW, type Mood } from "@/lib/sprite";
import { useStore } from "@/lib/store";
import { THEMES } from "@/lib/themes";
import { clamp } from "@/lib/util";
import type { GameComponentProps } from "@/components/games/GameShell";

const GW = 400, GH = 300, GROUND = 292;
const ROWS = 5, COLS = 6, EX = 46, EY = 26;
const SHIP_H = 78, SHIP_TOP = GROUND - SHIP_H, DANGER_Y = SHIP_TOP - 6;

export default function ShooterGame({ running, onEnd, play }: GameComponentProps) {
  const cv = useRef<HTMLCanvasElement>(null);
  const shootRef = useRef<() => void>(() => {});
    const theme = useStore((s) => s.theme);
  const pet = useStore((s) => s.pet);
  const pal = useSpeciesPalette(pet.species);
  const G = useRef({
    px: GW / 2, target: GW / 2, bullets: [] as { x: number; y: number }[], ebullets: [] as { x: number; y: number; vy: number }[],
    alive: [] as boolean[], count: ROWS * COLS, ox: (GW - (COLS - 1) * EX) / 2, oy: 38, dir: 1, fire: 1.5,
    score: 0, lives: 3, t: 0, cool: 0, invuln: 0, held: false,
    mood: "idle" as Mood, moodUntil: 0, last: 0, finished: false,
    stars: [] as { x: number; y: number; s: number }[],
  });
  const live = useRef({ pal, theme, species: pet.species, hat: pet.hat, running, onEnd, play });
  useEffect(() => {
    live.current = { pal, theme, species: pet.species, hat: pet.hat, running, onEnd, play };
  });

  // RESET all state when a new run starts
  useEffect(() => {
    if (!running) return;
    const g = G.current;
    g.px = GW / 2; g.target = GW / 2; g.bullets = []; g.ebullets = [];
    g.alive = Array.from({ length: ROWS * COLS }, () => true);
    g.count = ROWS * COLS; g.ox = (GW - (COLS - 1) * EX) / 2; g.oy = 38; g.dir = 1; g.fire = 1.5;
    g.score = 0; g.lives = 3; g.t = 0; g.cool = 0; g.invuln = 0; g.held = false;
    g.mood = "idle"; g.moodUntil = 0; g.last = 0; g.finished = false;
    g.stars = Array.from({ length: 34 }, () => ({ x: Math.random() * GW, y: 8 + Math.random() * (DANGER_Y - 20), s: Math.random() * 6 }));
  }, [running]);

  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    const off = document.createElement("canvas");
    off.width = SW;
    off.height = SH;
    const octx = off.getContext("2d")!;
    let raf = 0, frame = 0;
    const keys = new Set<string>();
    const kd = (e: KeyboardEvent) => {
      if (["ArrowLeft", "ArrowRight", "a", "d", " "].includes(e.key)) e.preventDefault();
      keys.add(e.key);
    };
    const ku = (e: KeyboardEvent) => keys.delete(e.key);
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);

    const finish = () => {
      const g = G.current;
      if (g.finished) return;
      g.finished = true;
      live.current.onEnd(g.score);
    };

    const shoot = () => {
      const g = G.current;
      const L = live.current;
      if (!L.running || g.finished || g.cool > 0) return;
      g.bullets.push({ x: g.px, y: SHIP_TOP - 6 });
      g.cool = 0.26;
      L.play("shoot");
    };
    shootRef.current = shoot;

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const g = G.current;
      const L = live.current;
      const isRun = L.running && !g.finished;
      if (!g.last) g.last = now;
      const dt = Math.min(0.04, (now - g.last) / 1000);
      g.last = now;

      const ex = (i: number) => g.ox + (i % COLS) * EX;
      const ey = (i: number) => g.oy + Math.floor(i / COLS) * EY;

      if (isRun) {
        g.t += dt;
        // player movement (keyboard steers a target, pointer sets it directly)
        if (keys.has("ArrowLeft") || keys.has("a")) g.target -= 300 * dt;
        if (keys.has("ArrowRight") || keys.has("d")) g.target += 300 * dt;
        g.target = clamp(g.target, 38, GW - 38);
        g.px += (g.target - g.px) * Math.min(1, dt * 14);
        // shooting (hold space or pointer)
        g.cool -= dt;
        if (g.held || keys.has(" ")) shoot();
        // swarm: march side to side, drop on every pass, speed up as it thins out
        const deadFrac = (ROWS * COLS - g.count) / (ROWS * COLS);
        const speed = 26 + deadFrac * 115 + Math.min(24, g.t * 0.8);
        g.ox += g.dir * speed * dt;
        let minC = COLS, maxC = -1, maxR = -1;
        for (let i = 0; i < g.alive.length; i++) {
          if (!g.alive[i]) continue;
          const cc = i % COLS, rr = Math.floor(i / COLS);
          if (cc < minC) minC = cc;
          if (cc > maxC) maxC = cc;
          if (rr > maxR) maxR = rr;
        }
        if (maxC < 0) {
          // all enemies destroyed: +100 bonus, win
          g.score += 100;
          L.play("star");
          g.mood = "happy";
          g.moodUntil = now + 3000;
          finish();
        } else {
          if (g.dir > 0 && g.ox + maxC * EX + 14 > GW - 8) { g.dir = -1; g.oy += 13; }
          else if (g.dir < 0 && g.ox + minC * EX - 14 < 8) { g.dir = 1; g.oy += 13; }
          if (g.oy + maxR * EY > DANGER_Y) {
            L.play("gameover"); // the bugs broke through
            finish();
          }
          // enemies occasionally shoot back
          g.fire -= dt;
          if (g.fire <= 0) {
            const living: number[] = [];
            for (let i = 0; i < g.alive.length; i++) if (g.alive[i]) living.push(i);
            const i = living[Math.floor(Math.random() * living.length)];
            if (i !== undefined) g.ebullets.push({ x: ex(i), y: ey(i) + 10, vy: 95 + deadFrac * 90 });
            g.fire = Math.max(0.45, 1.6 - g.t * 0.012 - deadFrac * 0.9) * (0.7 + Math.random() * 0.7);
          }
        }
        // player bullets
        for (const b of g.bullets) b.y -= 340 * dt;
        g.bullets = g.bullets.filter((b) => {
          if (b.y < -12) return false;
          for (let i = 0; i < g.alive.length; i++) {
            if (!g.alive[i]) continue;
            if (Math.abs(b.x - ex(i)) < 14 && Math.abs(b.y - ey(i)) < 11) {
              g.alive[i] = false;
              g.count--;
              g.score += 20;
              g.mood = "happy";
              g.moodUntil = now + 380;
              L.play("hit");
              return false;
            }
          }
          return true;
        });
        // enemy bullets
        for (const b of g.ebullets) b.y += b.vy * dt;
        g.ebullets = g.ebullets.filter((b) => {
          if (b.y > GH + 8) return false;
          if (b.y > SHIP_TOP + 6 && b.y < GROUND - 4 && Math.abs(b.x - g.px) < 30) {
            if (g.invuln <= 0) {
              g.lives--;
              g.invuln = 1.3;
              g.mood = "sad";
              g.moodUntil = now + 700;
              L.play("hit");
              if (g.lives <= 0) finish();
            }
            return false;
          }
          return true;
        });
        g.invuln -= dt;
        if (now > g.moodUntil) g.mood = "idle";
      }

      // ---- draw ----
      const th = THEMES[L.theme];
      ctx.clearRect(0, 0, GW, GH);
      ctx.fillStyle = th.ramp[0];
      ctx.fillRect(0, 0, GW, GH);
      for (const s of g.stars) {
        ctx.globalAlpha = 0.25 + 0.45 * Math.abs(Math.sin(now / 700 + s.s));
        ctx.fillStyle = th.ramp[4];
        ctx.fillRect(Math.round(s.x), Math.round(s.y), 2, 2);
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = th.ramp[1];
      for (let x = 4; x < GW; x += 14) ctx.fillRect(x, DANGER_Y, 7, 1);

      // enemies (pixel bugs)
      for (let i = 0; i < g.alive.length; i++) {
        if (!g.alive[i]) continue;
        const x = Math.round(ex(i)), y = Math.round(ey(i));
        ctx.fillStyle = th.ramp[0];
        ctx.fillRect(x - 7, y - 5, 14, 10);
        ctx.fillRect(x - 10, y - 2, 20, 4);
        ctx.fillStyle = th.ramp[2];
        ctx.fillRect(x - 6, y - 4, 12, 8);
        ctx.fillStyle = th.accent;
        ctx.fillRect(x - 4, y - 2, 2, 2);
        ctx.fillRect(x + 2, y - 2, 2, 2);
        ctx.fillStyle = th.ramp[0];
        const leg = Math.floor(now / 120 + i) % 2;
        ctx.fillRect(x - 9 + leg * 2, y + 5, 2, 3);
        ctx.fillRect(x + 7, y + 5, 2, 3);
      }

      // bullets
      for (const b of g.bullets) {
        ctx.fillStyle = th.accent;
        ctx.fillRect(Math.round(b.x) - 1, Math.round(b.y), 3, 10);
        ctx.fillStyle = th.ramp[4];
        ctx.fillRect(Math.round(b.x), Math.round(b.y) - 2, 1, 3);
      }
      for (const b of g.ebullets) {
        ctx.fillStyle = th.ink;
        ctx.fillRect(Math.round(b.x) - 1, Math.round(b.y), 3, 8);
      }

      // the pet's little ship (pet drawn at 2x inside the hull)
      if (frame++ % 2 === 0) drawPet(octx, L.species, { mood: isRun ? g.mood : "idle", t: now / 1000, blink: (now / 1000) % 3.8 < 0.14 }, L.pal, L.hat);
      const px = Math.round(g.px);
      ctx.globalAlpha = g.invuln > 0 && Math.floor(now / 90) % 2 === 0 ? 0.35 : 1;
      const fl = 5 + (Math.floor(now / 70) % 3) * 3;
      ctx.fillStyle = th.accent;
      ctx.fillRect(px - 20, GROUND - 8, 8, fl);
      ctx.fillRect(px + 12, GROUND - 8, 8, fl);
      ctx.fillStyle = th.ramp[3];
      ctx.fillRect(px - 30, GROUND - 34, 60, 12);
      ctx.fillRect(px - 24, GROUND - 22, 48, 14);
      ctx.fillRect(px - 38, GROUND - 28, 8, 6);
      ctx.fillRect(px + 30, GROUND - 28, 8, 6);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, px - SW, SHIP_TOP + 2, SW * 2, SH * 2);
      ctx.fillStyle = th.ramp[3];
      ctx.fillRect(px - 30, GROUND - 30, 60, 5);
      ctx.fillStyle = th.ramp[2];
      ctx.fillRect(px - 30, GROUND - 30, 60, 2);
      ctx.globalAlpha = 1;

      // ground
      ctx.fillStyle = th.ramp[2];
      ctx.fillRect(0, GROUND, GW, 2);
      ctx.fillStyle = th.ramp[3];
      ctx.globalAlpha = 0.25;
      for (let x = 0; x < GW; x += 6) ctx.fillRect(x, GROUND + 3 + ((x / 6) % 2) * 2, 3, 2);
      ctx.globalAlpha = 1;

      // HUD: score + lives
      ctx.font = "14px monospace";
      ctx.fillStyle = th.ink;
      ctx.textAlign = "left";
      ctx.fillText(`${g.score}`, 12, 22);
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = i < g.lives ? th.accent : th.ramp[1];
        ctx.fillRect(GW - 24 - i * 16, 12, 11, 11);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
    };
  }, []);

  return (
    <div className="grid h-full w-full place-items-center p-2">
      <canvas
        ref={cv}
        width={GW}
        height={GH}
        tabIndex={0}
        className="pixelated max-h-full max-w-full rounded-2xl outline-none"
        style={{ aspectRatio: `${GW}/${GH}`, cursor: running ? "crosshair" : "default", touchAction: "none" }}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          G.current.target = clamp(((e.clientX - r.left) / r.width) * GW, 38, GW - 38);
        }}
        onPointerDown={() => {
          const g = G.current;
          if (!live.current.running || g.finished) return;
          g.held = true;
          shootRef.current();
        }}
        onPointerUp={() => { G.current.held = false; }}
        onPointerLeave={() => { G.current.held = false; }}
      />
    </div>
  );
}
