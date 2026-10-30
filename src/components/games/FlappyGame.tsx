
import { useCallback, useEffect, useRef } from "react";
import { useSpeciesPalette } from "@/components/PetView";
import type { GameComponentProps } from "@/components/games/GameShell";
import { useStore } from "@/lib/store";
import { drawPet, SH, SW, type Mood, type Species as SpriteSpecies } from "@/lib/sprite";
import { THEMES } from "@/lib/themes";
import { clamp } from "@/lib/util";

const GW = 400, GH = 300, GROUND = GH - 20;
const PX = 78; // pet x (center)
const GRAV = 1500, FLAP = -370;
const GAP = 116, PW = 54;
const HW = 15, HH = 17; // hitbox half sizes

type Pipe = { x: number; gy: number; passed: boolean };
type Cloud = { x: number; y: number; s: number };

type State = {
  y: number; vy: number; started: boolean; dead: boolean;
  pipes: Pipe[]; score: number; t: number; dist: number;
  moodUntil: number; last: number; finished: boolean; clouds: Cloud[];
};

function makeState(): State {
  return {
    y: 150, vy: 0, started: false, dead: false,
    pipes: [], score: 0, t: 0, dist: 0, moodUntil: 0, last: 0, finished: false,
    clouds: [
      { x: 80, y: 62, s: 0.4 },
      { x: 230, y: 104, s: 0.7 },
      { x: 340, y: 44, s: 0.55 },
    ],
  };
}

export default function FlappyGame({ running, onEnd, play }: GameComponentProps) {
  const cv = useRef<HTMLCanvasElement>(null);
    const theme = useStore((s) => s.theme);
  const species = useStore((s) => s.pet.species) as SpriteSpecies;
  const hat = useStore((s) => s.pet.hat);
  const pal = useSpeciesPalette(species);
  const G = useRef(makeState());
  const live = useRef({ running, onEnd, play, theme, pal, species, hat });
  // keep latest props reachable from the rAF loop without re-subscribing
  useEffect(() => {
    live.current = { running, onEnd, play, theme, pal, species, hat };
  });

  // reset when a fresh run begins
  const prevRun = useRef(running);
  useEffect(() => {
    if (running && !prevRun.current) G.current = makeState();
    prevRun.current = running;
  }, [running]);

  const flap = useCallback(() => {
    const g = G.current, L = live.current;
    if (!L.running || g.finished || g.dead) return;
    if (!g.started) g.started = true;
    g.vy = FLAP;
    L.play("pop");
  }, []);

  // keyboard — attached only while running
  useEffect(() => {
    if (!running) return;
    const kd = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (e.key === " " || e.key.startsWith("Arrow") || k === "w") e.preventDefault();
      if (!e.repeat && (e.key === " " || e.key === "ArrowUp" || k === "w")) flap();
    };
    window.addEventListener("keydown", kd);
    return () => window.removeEventListener("keydown", kd);
  }, [running, flap]);

  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    const off = document.createElement("canvas");
    off.width = SW;
    off.height = SH;
    const octx = off.getContext("2d")!;
    let raf = 0, frame = 0;

    const finish = () => {
      const g = G.current;
      if (g.finished) return;
      g.finished = true;
      live.current.onEnd(g.score);
    };

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const g = G.current, L = live.current;
      if (!g.last) g.last = now;
      const dt = Math.min(0.04, (now - g.last) / 1000);
      g.last = now;

      if (L.running && !g.finished) {
        if (g.dead) {
          g.vy += GRAV * dt;
          g.y += g.vy * dt;
          if (g.y + HH >= GROUND + 6) {
            g.y = GROUND + 6 - HH;
            finish();
          }
        } else {
          g.t += dt;
          const speed = Math.min(200, 130 + g.score * 3);
          if (g.started) {
            g.vy += GRAV * dt;
            g.y += g.vy * dt;
            if (g.y < HH + 4) {
              g.y = HH + 4;
              g.vy = 0;
            }
            g.dist += speed * dt;
            const lastP = g.pipes[g.pipes.length - 1];
            if (!lastP || lastP.x < GW - 185) {
              const gy = 96 + Math.random() * 100;
              g.pipes.push({ x: GW + 30, gy, passed: false });
            }
            for (const p of g.pipes) p.x -= speed * dt;
            g.pipes = g.pipes.filter((p) => p.x > -PW - 12);
            for (const p of g.pipes) {
              if (!p.passed && p.x + PW < PX - HW) {
                p.passed = true;
                g.score++;
                g.moodUntil = now + 320;
                L.play("coin");
              }
              if (PX + HW > p.x && PX - HW < p.x + PW && (g.y - HH < p.gy - GAP / 2 || g.y + HH > p.gy + GAP / 2)) {
                g.dead = true;
                g.vy = -150;
                L.play("hit");
                break;
              }
            }
            if (!g.dead && g.y + HH >= GROUND) {
              g.dead = true;
              g.vy = 0;
              L.play("hit");
            }
          } else {
            g.y = 150 + Math.sin(g.t * 3) * 8;
          }
        }
      }

      // ---- draw ----
      const th = THEMES[L.theme];
      ctx.clearRect(0, 0, GW, GH);
      const grad = ctx.createLinearGradient(0, 0, 0, GH);
      grad.addColorStop(0, th.ramp[1] + "55");
      grad.addColorStop(1, th.ramp[0] + "00");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, GW, GH);

      // drifting pixel clouds
      const scroll = g.dist + g.t * 26;
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = th.ramp[4];
      for (const cl of g.clouds) {
        const cx = ((((cl.x - scroll * cl.s) % (GW + 120)) + GW + 120) % (GW + 120)) - 60;
        ctx.fillRect(cx, cl.y, 34, 10);
        ctx.fillRect(cx + 6, cl.y - 6, 18, 8);
        ctx.fillRect(cx + 14, cl.y - 10, 12, 6);
      }
      ctx.globalAlpha = 1;

      // pipes
      for (const p of g.pipes) {
        const topH = p.gy - GAP / 2;
        const botY = p.gy + GAP / 2;
        ctx.fillStyle = th.ramp[2];
        ctx.fillRect(p.x, 0, PW, topH);
        ctx.fillRect(p.x, botY, PW, GROUND - botY);
        ctx.fillStyle = th.ramp[3];
        ctx.fillRect(p.x + 2, 0, 4, topH);
        ctx.fillRect(p.x + 2, botY, 4, GROUND - botY);
        ctx.fillStyle = th.ramp[1];
        ctx.fillRect(p.x + PW - 4, 0, 4, topH);
        ctx.fillRect(p.x + PW - 4, botY, 4, GROUND - botY);
        ctx.fillStyle = th.ramp[3];
        ctx.fillRect(p.x - 4, topH - 12, PW + 8, 12);
        ctx.fillRect(p.x - 4, botY, PW + 8, 12);
        ctx.fillStyle = th.ramp[1];
        ctx.fillRect(p.x - 4, topH - 2, PW + 8, 2);
        ctx.fillRect(p.x - 4, botY + 10, PW + 8, 2);
      }

      // ground
      ctx.fillStyle = th.ramp[1];
      ctx.fillRect(0, GROUND, GW, GH - GROUND);
      ctx.fillStyle = th.ramp[2];
      ctx.fillRect(0, GROUND, GW, 2);
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = th.ramp[3];
      for (let x = 0; x < GW; x += 6) ctx.fillRect(x, GROUND + 5 + ((x / 6) % 2) * 3, 3, 2);
      ctx.globalAlpha = 1;

      // pet (drawn offscreen at native 32x38, blitted x2)
      if (frame++ % 2 === 0) {
        const mood: Mood = g.dead ? "sad" : now < g.moodUntil ? "happy" : "held";
        drawPet(octx, L.species, { mood, t: now / 1000, blink: (now / 1000) % 3.8 < 0.14, facing: 1 }, L.pal, L.hat);
      }
      ctx.imageSmoothingEnabled = false;
      ctx.save();
      ctx.translate(PX, Math.round(g.y));
      ctx.rotate(g.dead ? 1.3 : clamp(g.vy / 700, -0.5, 1.15));
      ctx.drawImage(off, -SW, -SH, SW * 2, SH * 2);
      ctx.restore();

      // hud
      ctx.textAlign = "center";
      ctx.font = "bold 24px monospace";
      ctx.fillStyle = th.ink;
      ctx.fillText(String(g.score), GW / 2, 40);
      if (!g.started && !g.dead && Math.floor(now / 450) % 2 === 0) {
        ctx.font = "13px monospace";
        ctx.fillStyle = th.dim;
        ctx.fillText("CLICK / TAP / SPACE TO FLAP", GW / 2, 92);
      }
      ctx.textAlign = "left";
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
        aria-label="Flappy Pet game"
        className="pixelated max-h-full max-w-full rounded-2xl outline-none"
        style={{ aspectRatio: `${GW}/${GH}`, touchAction: "none", cursor: running ? "pointer" : "default" }}
        onPointerDown={(e) => {
          e.preventDefault();
          flap();
        }}
      />
    </div>
  );
}
