"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { usePalette } from "@/components/PetView";
import { drawPet, SH, SW, type Mood } from "@/lib/sprite";
import { useStore } from "@/lib/store";
import { THEMES } from "@/lib/themes";
import { clamp } from "@/lib/util";

const GW = 360, GH = 280, GROUND = 252, TIME = 40;
type Item = { x: number; y: number; vy: number; k: "note" | "star" | "bug"; s: number };

export function CatchGame() {
  const cv = useRef<HTMLCanvasElement>(null);
  const pal = usePalette();
  const theme = useStore((s) => s.theme);
  const pet = useStore((s) => s.pet);
  const best = pet.stats.best;
  const [phase, setPhase] = useState<"idle" | "play" | "over">("idle");
  const [result, setResult] = useState({ score: 0, coins: 0, record: false });
  const G = useRef({ run: false, px: GW / 2, target: GW / 2, items: [] as Item[], score: 0, lives: 3, t: 0, spawn: 0, mood: "idle" as Mood, moodUntil: 0, last: 0 });
  const live = useRef({ pal, theme, species: pet.species, hat: pet.hat });
  live.current = { pal, theme, species: pet.species, hat: pet.hat };

  const finish = () => {
    const g = G.current;
    g.run = false;
    const coins = Math.floor(g.score / 2);
    const st = useStore.getState();
    const record = g.score > st.pet.stats.best;
    st.patchPet((p) => ({ ...p, coins: p.coins + coins, xp: p.xp + g.score, joy: clamp(p.joy + 10, 0, 100), stats: { ...p.stats, games: p.stats.games + 1, best: Math.max(p.stats.best, g.score) } }));
    if (record) st.say("New record! I'm so proud!");
    st.doAct(coins > 3 ? "happy" : "idle", 2500);
    setResult({ score: g.score, coins, record });
    setPhase("over");
  };

  const start = () => {
    const g = G.current;
    Object.assign(g, { run: true, items: [], score: 0, lives: 3, t: 0, spawn: 0, last: performance.now(), mood: "idle" as Mood, moodUntil: 0 });
    setPhase("play");
    cv.current?.focus();
  };

  useEffect(() => {
    const c = cv.current!;
    const ctx = c.getContext("2d")!;
    const off = document.createElement("canvas");
    off.width = SW; off.height = SH;
    const octx = off.getContext("2d")!;
    let raf = 0, frame = 0;
    const keys = new Set<string>();
    const kd = (e: KeyboardEvent) => keys.add(e.key);
    const ku = (e: KeyboardEvent) => keys.delete(e.key);
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const g = G.current;
      const L = live.current;
      const th = THEMES[L.theme];
      const dt = Math.min(0.04, (now - g.last) / 1000);
      g.last = now;
      if (g.run) {
        g.t += dt;
        if (keys.has("ArrowLeft") || keys.has("a")) g.target -= 300 * dt;
        if (keys.has("ArrowRight") || keys.has("d")) g.target += 300 * dt;
        g.target = clamp(g.target, 30, GW - 30);
        const moving = Math.abs(g.target - g.px) > 3;
        g.px += (g.target - g.px) * Math.min(1, dt * 14);
        g.spawn -= dt;
        if (g.spawn <= 0) {
          const r = Math.random();
          g.items.push({ x: 20 + Math.random() * (GW - 40), y: -14, vy: 70 + g.t * 3 + Math.random() * 50, k: r < 0.62 ? "note" : r < 0.78 ? "star" : "bug", s: Math.random() * 6 });
          g.spawn = Math.max(0.28, 0.85 - g.t * 0.012);
        }
        for (const it of g.items) it.y += it.vy * dt;
        g.items = g.items.filter((it) => {
          if (it.y > GROUND - 40 && it.y < GROUND - 6 && Math.abs(it.x - g.px) < 26) {
            if (it.k === "bug") { g.lives--; g.mood = "sad"; g.moodUntil = now + 600; }
            else { g.score += it.k === "star" ? 3 : 1; g.mood = "happy"; g.moodUntil = now + 380; }
            return false;
          }
          return it.y < GH + 10;
        });
        if (now > g.moodUntil) g.mood = moving ? "walk" : "idle";
        if (g.lives <= 0 || g.t >= TIME) finish();
      }
      // draw
      ctx.clearRect(0, 0, GW, GH);
      const grad = ctx.createLinearGradient(0, 0, 0, GH);
      grad.addColorStop(0, th.ramp[1] + "55");
      grad.addColorStop(1, th.ramp[0] + "00");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, GW, GH);
      ctx.fillStyle = th.ramp[3];
      ctx.globalAlpha = 0.25;
      for (let x = 0; x < GW; x += 6) ctx.fillRect(x, GROUND + 1 + ((x / 6) % 2) * 2, 3, 2);
      ctx.globalAlpha = 1;
      ctx.fillStyle = th.ramp[2];
      ctx.fillRect(0, GROUND, GW, 2);
      for (const it of g.items) {
        const x = Math.round(it.x), y = Math.round(it.y);
        if (it.k === "note") {
          ctx.fillStyle = th.ramp[4]; ctx.fillRect(x - 6, y - 8, 12, 16);
          ctx.fillStyle = th.ramp[1]; ctx.fillRect(x - 3, y - 4, 6, 2); ctx.fillRect(x - 3, y, 6, 2); ctx.fillRect(x - 3, y + 4, 4, 2);
          ctx.fillStyle = th.ramp[2]; ctx.fillRect(x + 3, y - 8, 3, 3);
        } else if (it.k === "star") {
          ctx.fillStyle = th.accent;
          ctx.fillRect(x - 2, y - 8, 4, 16); ctx.fillRect(x - 8, y - 2, 16, 4); ctx.fillRect(x - 5, y - 5, 10, 10);
          ctx.fillStyle = th.ramp[4]; ctx.fillRect(x - 2, y - 2, 4, 4);
        } else {
          ctx.fillStyle = th.ramp[0]; ctx.fillRect(x - 7, y - 5, 14, 10); ctx.fillRect(x - 10, y - 2, 20, 4);
          ctx.fillStyle = th.ramp[2]; ctx.fillRect(x - 6, y - 4, 12, 8);
          ctx.fillStyle = th.ramp[0]; ctx.fillRect(x - 4, y - 2, 2, 2); ctx.fillRect(x + 2, y - 2, 2, 2);
          ctx.fillRect(x - 9 + (Math.floor(now / 120 + it.s) % 2) * 2, y + 5, 2, 3); ctx.fillRect(x + 7, y + 5, 2, 3);
        }
      }
      if (frame++ % 2 === 0) drawPet(octx, L.species, { mood: g.run ? g.mood : "idle", t: now / 1000, blink: (now / 1000) % 3.8 < 0.14, facing: g.target >= g.px ? 1 : -1 }, L.pal, L.hat);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, Math.round(g.px - SW), GROUND - SH * 2 + 6, SW * 2, SH * 2);
      if (g.run) {
        ctx.font = "16px var(--f-pixel), monospace";
        ctx.fillStyle = th.ink;
        ctx.fillText(`${g.score}`, 12, 24);
        for (let i = 0; i < 3; i++) { ctx.fillStyle = i < g.lives ? th.accent : th.ramp[1]; ctx.fillRect(GW - 24 - i * 16, 12, 11, 11); }
        ctx.fillStyle = th.ramp[1]; ctx.fillRect(GW / 2 - 60, 14, 120, 6);
        ctx.fillStyle = th.accent; ctx.fillRect(GW / 2 - 60, 14, 120 * (1 - g.t / TIME), 6);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("keydown", kd); window.removeEventListener("keyup", ku); };
     
  }, []);

  return (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded-2xl border border-line" style={{ background: "url(/art/den.webp) center / cover" }}>
        <div className="absolute inset-0" style={{ background: "color-mix(in srgb, var(--panel-solid) 72%, transparent)" }} />
        <canvas
          ref={cv}
          width={GW}
          height={GH}
          tabIndex={0}
          className="pixelated relative block w-full outline-none"
          style={{ aspectRatio: `${GW}/${GH}`, cursor: phase === "play" ? "none" : "default", touchAction: "none" }}
          onPointerMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); G.current.target = ((e.clientX - r.left) / r.width) * GW; }}
        />
        {phase !== "play" && (
          <div className="absolute inset-0 grid place-items-center bg-black/30 p-4 text-center" style={{ animation: "pop .25s ease both" }}>
            <div>
              <div className="pixel-font text-[22px]">{phase === "over" ? (result.record ? "New record!" : "Time!") : "Catch the notes"}</div>
              {phase === "over" ? (
                <div className="pixel-font mt-1 text-[15px] text-dim">Score {result.score} · +{result.coins} coins</div>
              ) : (
                <div className="mx-auto mt-1 max-w-[250px] text-[12.5px] leading-snug text-dim">Move with the mouse or ← →. Catch notes (+1) and stars (+3). Dodge the bugs!</div>
              )}
              <button className="btn btn-accent mt-3" onClick={start}><Icon name="play" size={14} /> {phase === "over" ? "Play again" : "Start"}</button>
            </div>
          </div>
        )}
      </div>
      <div className="pixel-font flex items-center justify-between px-1 text-[14px] text-dim">
        <span className="flex items-center gap-1.5"><Icon name="trophy" size={14} className="text-accent" /> Best {best}</span>
        <span>{pet.stats.games} games played</span>
      </div>
    </div>
  );
}
