/**
 * Onboarding sky: a low-res pixel canvas (1/3 of the window, upscaled with nearest-neighbour)
 * with a dithered gradient sky, three parallax layers of gently bobbing pixel clouds, hills,
 * twinkles and — on the last step — a confetti burst.
 *
 * Cost: one capped `frameLoop` (30 fps; 20 fps in low-power mode; a single static frame when
 * the OS asks for reduced motion). It stops while the window is hidden and is torn down the
 * moment the onboarding closes — the app's idle budget (0 rAF) is untouched.
 */
import { useEffect, useRef } from "react";
import { frameLoop, isLowPower } from "@/lib/power";

type Cloud = { x: number; y: number; spr: HTMLCanvasElement; speed: number; phase: number; layer: number };
type Bit = { x: number; y: number; vx: number; vy: number; c: string; life: number };

const SCALE = 3;

function cloudSprite(w: number, h: number, seed: number, dark: boolean): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const nb = 5 + Math.floor(rnd() * 3);
  const blobs = Array.from({ length: nb }, (_, i) => ({
    x: (w * (i + 0.6)) / (nb + 0.2),
    y: h * 0.62 - rnd() * h * 0.28,
    r: h * (0.26 + rnd() * 0.18),
  }));
  const body = dark ? "#c9b8f5" : "#ffffff";
  const shade = dark ? "#9b86d6" : "#e3dcfb";
  const light = dark ? "#e8defe" : "#ffffff";
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const inside = blobs.some((b) => (x - b.x) ** 2 + (y - b.y) ** 2 <= b.r * b.r) || (y > h * 0.55 && y < h * 0.86 && x > w * 0.08 && x < w * 0.92);
      if (!inside) continue;
      const below = !blobs.some((b) => (x - b.x) ** 2 + (y + 3 - b.y) ** 2 <= b.r * b.r) && y > h * 0.7;
      g.fillStyle = y > h * 0.74 || below ? shade : y < h * 0.38 ? light : body;
      g.fillRect(x, y, 1, 1);
    }
  return c;
}

function skyCanvas(w: number, h: number, dark: boolean): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  const stops = dark ? ["#120f2b", "#1f1848", "#342468", "#55367f", "#7a4b8e", "#a7629a"] : ["#7fb0ff", "#98bcff", "#b3c3ff", "#cbbfff", "#e6c4f4", "#ffd4e4"];
  const bands = 18;
  const bh = Math.ceil(h / bands);
  const lerp = (a: string, b: string, t: number) => {
    const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
    const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
    return `rgb(${pa.map((v, i) => Math.round(v + (pb[i] - v) * t)).join(",")})`;
  };
  for (let i = 0; i < bands; i++) {
    const t = (i / (bands - 1)) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(t));
    g.fillStyle = lerp(stops[k], stops[k + 1], t - k);
    g.fillRect(0, i * bh, w, bh);
    // ordered-dither seam between bands
    g.fillStyle = lerp(stops[k], stops[k + 1], Math.min(1, t - k + 0.5 / stops.length));
    for (let x = (i % 2); x < w; x += 2) g.fillRect(x, i * bh + bh - 1, 1, 1);
  }
  // stars (dark) / sun glow (light)
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  if (dark) {
    g.fillStyle = "#ffffff";
    for (let i = 0; i < Math.floor((w * h) / 900); i++) g.fillRect(Math.floor(rnd() * w), Math.floor(rnd() * h * 0.6), 1, 1);
    g.fillStyle = "#fff4c9";
    const mx = Math.floor(w * 0.8), my = Math.floor(h * 0.16), r = 9;
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r && (x + 3) ** 2 + (y - 2) ** 2 > 60) g.fillRect(mx + x, my + y, 1, 1);
  } else {
    const mx = Math.floor(w * 0.8), my = Math.floor(h * 0.17);
    for (const [r, col] of [[16, "rgba(255,240,190,.35)"], [12, "#fff3c4"], [9, "#ffe58a"]] as [number, string][]) {
      g.fillStyle = col;
      for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r) g.fillRect(mx + x, my + y, 1, 1);
    }
  }
  return c;
}

function hills(w: number, h: number, dark: boolean, layer: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w + 40;
  c.height = h;
  const g = c.getContext("2d")!;
  const col = dark ? (layer ? ["#2a1f4f", "#3a2c66"] : ["#1a1436", "#251c48"]) : layer ? ["#b7a3f0", "#c9b8f8"] : ["#8f7ad8", "#a08ce4"];
  const base = h * (layer ? 0.8 : 0.88);
  for (let x = 0; x < c.width; x++) {
    const y = Math.round(base - (Math.sin(x / (layer ? 23 : 37) + layer) * (layer ? 7 : 10) + Math.sin(x / 11) * 2));
    g.fillStyle = col[1];
    g.fillRect(x, y, 1, 1);
    g.fillStyle = col[0];
    g.fillRect(x, y + 1, 1, h - y);
  }
  return c;
}

/** 1.3.1: frame-time watchdog. If frames take > 50 ms (a starved WebView2 renderer / GPU), the
 *  scene drops to "reduced effects": one static frame, no drifting clouds, only short bursts. */
export const SLOW_FRAME_MS = 50;

export function Scene({ dark, burst, pop = 0, onReduced }: { dark: boolean; burst: number; pop?: number; onReduced?: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const burstRef = useRef(burst);
  const popRef = useRef(pop);
  const loopRef = useRef<{ kick: () => void } | null>(null);
  const onReducedRef = useRef(onReduced);
  onReducedRef.current = onReduced;
  useEffect(() => {
    burstRef.current = burst;
    // a burst must wake a loop that settled (reduced motion draws one frame and stops)
    loopRef.current?.kick();
  }, [burst]);
  useEffect(() => {
    popRef.current = pop;
    loopRef.current?.kick();
  }, [pop]);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d")!;
    let reduced = (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) || localStorage.getItem("nook:obFx") === "reduced" || (window as unknown as { __nookReducedFx?: boolean }).__nookReducedFx === true;
    if (reduced) onReducedRef.current?.();
    let slow = 0, frames = 0, prevNow = 0;
    const low = isLowPower();
    let W = 0, H = 0;
    let sky: HTMLCanvasElement, hill0: HTMLCanvasElement, hill1: HTMLCanvasElement;
    let clouds: Cloud[] = [];
    const bits: Bit[] = [];
    let seenBurst = burstRef.current;
    let seenPop = popRef.current;
    let mouse = 0, px = 0;
    const setup = () => {
      W = Math.ceil(window.innerWidth / SCALE);
      H = Math.ceil(window.innerHeight / SCALE);
      cv.width = W;
      cv.height = H;
      sky = skyCanvas(W, H, dark);
      hill0 = hills(W, H, dark, 0);
      hill1 = hills(W, H, dark, 1);
      const n = low ? 6 : 10;
      clouds = Array.from({ length: n }, (_, i) => {
        const layer = i % 3;
        const sz = [22, 34, 48][layer];
        return { x: (i * W) / n + (i * 37) % 40, y: 8 + ((i * 53) % Math.max(10, Math.floor(H * 0.45))), spr: cloudSprite(sz, Math.round(sz * 0.5), 11 + i * 97, dark), speed: [0.05, 0.11, 0.2][layer], phase: i * 1.7, layer };
      });
      clouds.sort((a, b) => a.layer - b.layer);
    };
    setup();
    const onMove = (e: PointerEvent) => (mouse = (e.clientX / window.innerWidth - 0.5) * 2);
    const onResize = () => {
      setup();
      loop.kick();
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("resize", onResize);
    let last = performance.now();
    const draw = (now: number) => {
      const t0 = performance.now();
      const dt = Math.min(80, now - last) / 16.7;
      last = now;
      px += (mouse - px) * 0.06;
      // full clear every frame (no stale pixels can survive under translucent sprites)
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(sky, 0, 0);
      for (const c of clouds) {
        if (c.layer < 2) {
          c.x += c.speed * dt;
          if (c.x > W + 10) c.x = -c.spr.width - 10;
          const bob = Math.round(Math.sin(now / 1400 + c.phase) * (c.layer + 1) * 0.6);
          ctx.globalAlpha = c.layer === 0 ? 0.65 : 0.85;
          ctx.drawImage(c.spr, Math.round(c.x - px * (c.layer + 1) * 2), Math.round(c.y + bob));
        }
      }
      ctx.globalAlpha = 1;
      ctx.drawImage(hill1, Math.round(-20 - px * 3), 0);
      for (const c of clouds) {
        if (c.layer === 2) {
          c.x += c.speed * dt;
          if (c.x > W + 10) c.x = -c.spr.width - 10;
          const bob = Math.round(Math.sin(now / 1100 + c.phase) * 1.4);
          ctx.drawImage(c.spr, Math.round(c.x - px * 6), Math.round(c.y + H * 0.08 + bob));
        }
      }
      ctx.drawImage(hill0, Math.round(-20 - px * 5), 0);
      // twinkles
      for (let i = 0; i < 6; i++) {
        const t = (now / 900 + i * 1.3) % 3;
        if (t > 1) continue;
        const x = Math.round(((i * 71) % 97) / 97 * W), y = Math.round(((i * 43) % 61) / 61 * H * 0.55);
        const a = 1 - Math.abs(t - 0.5) * 2;
        ctx.fillStyle = `rgba(255,248,214,${a.toFixed(2)})`;
        ctx.fillRect(x, y - 1, 1, 3);
        ctx.fillRect(x - 1, y, 3, 1);
      }
      // confetti burst (last step)
      if (burstRef.current !== seenBurst) {
        seenBurst = burstRef.current;
        const cols = ["#ffd44f", "#ff8fae", "#a58cff", "#5fd29b", "#69b3f5", "#ffa06d"];
        for (let i = 0; i < (low ? 70 : 140); i++) {
          const a = Math.random() * Math.PI * 2, v = 1 + Math.random() * 3.2;
          bits.push({ x: W / 2, y: H * 0.45, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 2.2, c: cols[i % cols.length], life: 90 + Math.random() * 50 });
        }
      }
      // small burst by the Next button on every step change
      if (popRef.current !== seenPop) {
        seenPop = popRef.current;
        const cols = ["#ffd44f", "#ff8fae", "#a58cff", "#5fd29b"];
        const ox = Math.round(W / 2 + Math.min(W * 0.42, 860 / SCALE / 2) - 14), oy = H - Math.round(48 / SCALE);
        for (let i = 0; i < (low ? 10 : 18); i++) {
          const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2, v = 0.8 + Math.random() * 1.6;
          bits.push({ x: ox, y: oy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.6, c: cols[i % cols.length], life: 34 + Math.random() * 18 });
        }
      }
      for (let i = bits.length - 1; i >= 0; i--) {
        const b = bits[i];
        b.vy += 0.07 * dt;
        b.vx *= 0.99;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.life -= dt;
        if (b.life <= 0 || b.y > H) {
          bits.splice(i, 1);
          continue;
        }
        ctx.fillStyle = b.c;
        ctx.fillRect(Math.round(b.x), Math.round(b.y), 2, (Math.floor(b.life / 6) % 2) + 1);
      }
      // watchdog: the work of a frame, or the gap since the previous one (a starved timer), > 50 ms
      const work = performance.now() - t0;
      const gap = prevNow ? now - prevNow : 0;
      prevNow = now;
      if (!reduced && ++frames > 3 && (work > SLOW_FRAME_MS || gap > period + SLOW_FRAME_MS)) {
        if (++slow >= 5) {
          reduced = true;
          try {
            localStorage.setItem("nook:obFx", "reduced");
          } catch {}
          onReducedRef.current?.();
        }
      } else if (slow > 0 && work < SLOW_FRAME_MS / 2) slow--;
      return !reduced || bits.length > 0;
    };
    const fps = reduced ? 4 : low ? 20 : 30;
    const period = 1000 / fps;
    const loop = frameLoop(draw, fps, cv);
    loopRef.current = loop;
    return () => {
      loopRef.current = null;
      loop.stop();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("resize", onResize);
    };
  }, [dark]);

  return <canvas ref={ref} className="ob-sky" aria-hidden data-testid="ob-sky" />;
}
