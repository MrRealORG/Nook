
/**
 * Parametric game engines — reusable mini-game implementations driven entirely
 * by a JSON config (CustomGameDef). Powers the "Game Maker" feature: users
 * create custom games without code and share them as "nook-games" JSON packs.
 *
 * All 6 engines live in ONE component (EngineGame) and share a single rAF loop
 * + live-ref pattern copied from CatchGame.tsx, rendered as absolutely
 * positioned DOM divs inside a relative full-size container (no canvas).
 */

import { useEffect, useReducer, useRef, type ReactNode } from "react";
import type { GameComponentProps } from "@/components/games/GameShell";
import { clamp, uid } from "@/lib/util";

// ── types ────────────────────────────────────────────────────────────────────

export type EngineId = "dodge" | "catcher" | "shooter" | "quiz" | "memory" | "flappy";

export type GameParams = {
  // shared
  playerColor?: string;
  enemyColor?: string;
  bgColor?: string;
  speed?: number; // 0.5–2 multiplier
  // dodge: player moves left/right at bottom, dodge falling blocks, survive to score
  fallRate?: number; // spawns per second (dodge, also used for catcher spawns)
  // catcher: move basket, catch falling goodies, avoid bombs
  goodRatio?: number; // 0.1–0.9 ratio of goodies vs bombs
  // shooter: move at bottom, shoot ascending enemies
  fireRate?: number; // bullets per second
  // quiz: rapidfire math questions with 4 answer buttons
  questionCount?: number;
  timePerQ?: number;
  // memory: flip-card grid
  gridSize?: number; // 4|6
  // flappy: tap to fly through gaps
  gapSize?: number;
};

export type CustomGameDef = {
  id: string;
  title: string;
  blurb: string;
  controls: string;
  tip: string;
  engine: EngineId;
  params: GameParams;
  accent?: string;
  icon?: string;
  createdAt?: number;
  origin?: "custom" | "imported";
};

export type GamePack = { format: "nook-games"; version: 1; exportedAt: string; games: CustomGameDef[] };

type MergedParams = Required<Pick<GameParams, "speed">> & Partial<GameParams>;

// ── metadata & defaults ──────────────────────────────────────────────────────

export const ENGINE_META: { id: EngineId; label: string; icon: string; desc: string }[] = [
  { id: "dodge", label: "Dodge", icon: "☄️", desc: "Dodge the falling junk" },
  { id: "catcher", label: "Catcher", icon: "🧺", desc: "Catch goodies, dodge bombs" },
  { id: "shooter", label: "Shooter", icon: "👾", desc: "Blast the invaders" },
  { id: "quiz", label: "Quiz", icon: "🧠", desc: "Rapid-fire quiz" },
  { id: "memory", label: "Memory", icon: "🃏", desc: "Flip & match pairs" },
  { id: "flappy", label: "Flappy", icon: "🐤", desc: "Tap to fly through gaps" },
];

const ENGINE_IDS: EngineId[] = ENGINE_META.map((m) => m.id);

export const DEFAULT_PARAMS: Record<EngineId, Required<Pick<GameParams, "speed">> & Partial<GameParams>> = {
  dodge: { speed: 1, fallRate: 2.2 },
  catcher: { speed: 1, goodRatio: 0.68, fallRate: 2.6 },
  shooter: { speed: 1, fireRate: 1.6 },
  quiz: { speed: 1, questionCount: 8, timePerQ: 10 },
  memory: { speed: 1, gridSize: 4 },
  flappy: { speed: 1, gapSize: 110 },
};

export function engineBlurb(e: EngineId): string {
  return ENGINE_META.find((m) => m.id === e)?.desc ?? "A custom mini-game";
}

const CONTROLS: Record<EngineId, string> = {
  dodge: "Slide with your mouse or ← → keys",
  catcher: "Slide the basket with your mouse",
  shooter: "Move with ← → · Space or click to fire",
  quiz: "Tap the right answer before the timer ends",
  memory: "Click cards to flip — find every pair",
  flappy: "Tap or press Space to flap",
};

const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
const MEMO = ["🌵", "🍄", "🌸", "🌟", "🍀", "🐟", "🦴", "🌙", "⭐", "🎃", "🧁", "🎈", "🚀", "☂️", "💎", "🐣", "🍭", "🪐"];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isEngine = (v: unknown): v is EngineId => typeof v === "string" && (ENGINE_IDS as string[]).includes(v);
/** #rgb → #rgba isn't valid, so only 7-char hex gets an alpha suffix */
const hexA = (h: string, a: string) => (h.length === 7 ? h + a : h);

// ── safe parsing / import / export ───────────────────────────────────────────

/** Safe parser for imported JSON: checks fields, clamps params, fills defaults, regenerates id if missing. */
export function validateGameDef(x: unknown): CustomGameDef | null {
  if (!isObj(x) || !isEngine(x.engine)) return null;
  const engine: EngineId = x.engine;
  const meta = ENGINE_META.find((m) => m.id === engine);
  const d = DEFAULT_PARAMS[engine];
  const p = isObj(x.params) ? x.params : {};
  const num = (v: unknown, dflt: number, lo: number, hi: number) =>
    clamp(typeof v === "number" && Number.isFinite(v) ? v : dflt, lo, hi);
  const str = (v: unknown, dflt: string, max = 60) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : dflt);
  const color = (v: unknown) => (typeof v === "string" && HEX_RE.test(v) ? v : undefined);
  const params: GameParams = {
    speed: num(p.speed, d.speed, 0.5, 2),
    fallRate: num(p.fallRate, d.fallRate ?? 2.2, 0.2, 8),
    goodRatio: num(p.goodRatio, d.goodRatio ?? 0.68, 0.1, 0.9),
    fireRate: num(p.fireRate, d.fireRate ?? 1.6, 0.5, 8),
    questionCount: Math.round(num(p.questionCount, d.questionCount ?? 8, 3, 20)),
    timePerQ: num(p.timePerQ, d.timePerQ ?? 10, 3, 30),
    gridSize: num(p.gridSize, d.gridSize ?? 4, 4, 6) >= 5 ? 6 : 4,
    gapSize: num(p.gapSize, d.gapSize ?? 110, 40, 200),
    playerColor: color(p.playerColor),
    enemyColor: color(p.enemyColor),
    bgColor: color(p.bgColor),
  };
  return {
    id: str(x.id, uid(), 40),
    title: str(x.title, `${meta?.label ?? "Custom"} game`),
    blurb: str(x.blurb, engineBlurb(engine), 90),
    controls: str(x.controls, CONTROLS[engine], 90),
    tip: str(x.tip, "", 140),
    engine,
    params,
    accent: color(x.accent),
    icon: str(x.icon, meta?.icon ?? "🎮", 8),
    createdAt: typeof x.createdAt === "number" && Number.isFinite(x.createdAt) ? x.createdAt : Date.now(),
    origin: x.origin === "custom" || x.origin === "imported" ? x.origin : "custom",
  };
}

export function packFromDefs(defs: CustomGameDef[]): GamePack {
  return { format: "nook-games", version: 1, exportedAt: new Date().toISOString(), games: defs };
}

/** Accepts {format:"nook-games", games:[…]}, a bare array of defs, or a single def. Invalid entries are dropped. */
export function parseGamePack(json: unknown): CustomGameDef[] {
  let arr: unknown[] = [];
  if (Array.isArray(json)) arr = json;
  else if (isObj(json)) {
    const g = json.games;
    arr = Array.isArray(g) ? g : [json];
  }
  const out: CustomGameDef[] = [];
  for (const raw of arr) {
    const v = validateGameDef(raw);
    if (v) out.push({ ...v, origin: "imported" });
  }
  return out;
}

/** Closure component suitable for GameShell's GameDef.Component field. */
export function gameFromDef(def: CustomGameDef): (props: GameComponentProps) => ReactNode {
  return (props) => <EngineGame def={def} {...props} />;
}

// ── engine state (deterministic — no Math.random until effects/loops) ────────

type Falling = { x: number; y: number; vy: number; w: number; h: number; bad: boolean; nm: boolean };
type Bullet = { x: number; y: number };
type Invader = { x: number; y: number; alive: boolean };
type Pipe = { x: number; gapY: number; passed: boolean };
type Card = { emo: string; open: boolean; done: boolean };
type Q = { a: number; b: number; op: string; correct: number; answers: number[] };

function makeState(def: CustomGameDef) {
  const cards: Card[] = [];
  if (def.engine === "memory") {
    const gs = def.params?.gridSize === 6 ? 6 : 4;
    const pairs = (gs * gs) / 2;
    for (let i = 0; i < pairs; i++) {
      const e = MEMO[i % MEMO.length];
      cards.push({ emo: e, open: false, done: false }, { emo: e, open: false, done: false });
    }
  }
  const invaders: Invader[] = [];
  if (def.engine === "shooter") {
    for (let r = 0; r < 3; r++) for (let c = 0; c < 8; c++) invaders.push({ x: 52 + c * 46, y: 30 + r * 34, alive: true });
  }
  return {
    finished: false,
    last: 0,
    W: 480,
    H: 320,
    centered: false,
    px: 240, // player x (center)
    target: 240,
    py: 140, // flappy bird y
    vy: 0,
    score: 0,
    t: 0, // seconds this run
    spawn: 0.7,
    fire: 0.3,
    blocks: [] as Falling[],
    items: [] as Falling[],
    bullets: [] as Bullet[],
    invaders,
    invDir: 1,
    wave: 0,
    pipes: [] as Pipe[],
    near: 0,
    // quiz
    qIdx: 0,
    qTime: 10,
    q: null as Q | null,
    msg: "",
    msgAt: 0,
    // memory
    cards,
    opens: [] as number[],
    moves: 0,
    matched: 0,
    unflip: 0, // Date.now() deadline to flip mismatches back
  };
}

// ── the one component to rule all 6 engines ──────────────────────────────────

export function EngineGame({ def, running, onEnd, play }: { def: CustomGameDef } & GameComponentProps) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const wrap = useRef<HTMLDivElement>(null);
  const keys = useRef(new Set<string>());
  const api = useRef({ flap: () => {}, shoot: () => {}, answer: (_n: number) => {}, flip: (_i: number) => {} });
  const G = useRef(makeState(def));
  const P: MergedParams = { ...DEFAULT_PARAMS[def.engine], ...def.params };
  const live = useRef({ def, running, onEnd, play, P });
  live.current = { def, running, onEnd, play, P };

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const g = G.current;
    let raf = 0;

    // shuffle memory deck (effect — allowed to be random)
    if (live.current.def.engine === "memory") {
      const cs = g.cards;
      for (let i = cs.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = cs[i];
        cs[i] = cs[j];
        cs[j] = tmp;
      }
    }

    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r && r.width > 40 && r.height > 40) {
        g.W = r.width;
        g.H = r.height;
      }
    });
    ro.observe(el);

    const finish = (s?: number) => {
      if (g.finished) return;
      g.finished = true;
      if (s != null) g.score = Math.max(0, Math.floor(s));
      live.current.onEnd(Math.max(0, Math.floor(g.score)));
    };

    const shoot = () => {
      const L = live.current;
      if (L.running && !g.finished && L.def.engine === "shooter" && g.bullets.length < 6) {
        g.bullets.push({ x: g.px, y: g.H - 46 });
        L.play("pop");
      }
    };

    const flap = () => {
      const L = live.current;
      if (L.running && !g.finished && L.def.engine === "flappy") {
        g.vy = -300;
        L.play("bounce");
      }
    };

    const mkQ = (): Q => {
      const s = clamp(live.current.P.speed ?? 1, 0.5, 2);
      const roll = Math.random();
      let a: number, b: number, op: string;
      if (roll < 0.4) {
        op = "+";
        const r = Math.max(2, Math.round(12 * s));
        a = 1 + Math.floor(Math.random() * r);
        b = 1 + Math.floor(Math.random() * r);
      } else if (roll < 0.75) {
        op = "−";
        const r = Math.max(2, Math.round(12 * s));
        a = 2 + Math.floor(Math.random() * r);
        b = 1 + Math.floor(Math.random() * (a - 1));
      } else {
        op = "×";
        const r = Math.max(2, Math.round(4 * s));
        a = 2 + Math.floor(Math.random() * r);
        b = 2 + Math.floor(Math.random() * r);
      }
      const c = op === "+" ? a + b : op === "−" ? a - b : a * b;
      const set = new Set<number>([c]);
      const spread = Math.max(2, Math.round(5 * s));
      let guard = 0;
      while (set.size < 4 && guard++ < 60) {
        const v = c + (Math.random() < 0.5 ? -1 : 1) * (1 + Math.floor(Math.random() * spread));
        if (v >= 0) set.add(v);
      }
      const answers = [...set];
      for (let i = answers.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = answers[i];
        answers[i] = answers[j];
        answers[j] = tmp;
      }
      return { a, b, op, correct: c, answers };
    };

    const nextQ = () => {
      const L = live.current;
      g.qIdx++;
      g.qTime = clamp(L.P.timePerQ ?? 10, 3, 30);
      if (g.qIdx >= Math.round(clamp(L.P.questionCount ?? 8, 3, 20))) finish();
      else g.q = mkQ();
    };

    const answer = (n: number) => {
      const L = live.current;
      if (!L.running || g.finished || !g.q) return;
      if (n === g.q.correct) {
        const gain = 10 + Math.max(0, Math.ceil(g.qTime));
        g.score += gain;
        g.msg = `+${gain}`;
        L.play("win");
      } else {
        g.msg = "miss";
        L.play("error");
      }
      g.msgAt = Date.now();
      nextQ();
      bump();
    };

    const flip = (i: number) => {
      const L = live.current;
      if (!L.running || g.finished || g.unflip) return;
      const c = g.cards[i];
      if (!c || c.open || c.done) return;
      c.open = true;
      L.play("flip");
      g.opens.push(i);
      if (g.opens.length === 2) {
        g.moves++;
        const a = g.opens[0], b = g.opens[1];
        const ca = a != null ? g.cards[a] : undefined;
        const cb = b != null ? g.cards[b] : undefined;
        if (ca && cb && ca.emo === cb.emo) {
          ca.done = true;
          cb.done = true;
          g.matched++;
          g.score += 20;
          g.opens = [];
          L.play("match");
          const pairs = g.cards.length / 2;
          if (g.matched >= pairs) finish(g.score - Math.max(0, g.moves - pairs) * 2);
        } else {
          g.unflip = Date.now() + 650;
        }
      }
      bump();
    };

    api.current = { flap, shoot, answer, flip };

    if (live.current.def.engine === "quiz") {
      g.q = mkQ();
      g.qTime = clamp(live.current.P.timePerQ ?? 10, 3, 30);
    }

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const L = live.current;
      const eng = L.def.engine;
      const spd = clamp(L.P.speed ?? 1, 0.5, 2);
      const isRun = L.running && !g.finished;
      if (!g.last) g.last = now;
      const dt = Math.min(0.04, (now - g.last) / 1000);
      g.last = now;
      if (!isRun) return;
      if (!g.centered) {
        g.centered = true;
        g.px = g.W / 2;
        g.target = g.W / 2;
      }
      g.t += dt;
      const key = keys.current;
      if (eng === "dodge") {
        if (key.has("ArrowLeft") || key.has("a")) g.target -= 320 * spd * dt;
        if (key.has("ArrowRight") || key.has("d")) g.target += 320 * spd * dt;
        g.target = clamp(g.target, 22, g.W - 22);
        g.px += (g.target - g.px) * Math.min(1, dt * 14);
        g.px = clamp(g.px, 22, g.W - 22);
        const fr = clamp(L.P.fallRate ?? 2.2, 0.2, 8) * (1 + Math.min(0.8, g.t * 0.02));
        g.spawn -= dt * fr;
        if (g.spawn <= 0) {
          g.spawn = 1;
          g.blocks.push({
            x: 24 + Math.random() * (g.W - 48),
            y: -34,
            vy: (110 + Math.random() * 80) * spd,
            w: 14 + Math.random() * 22,
            h: 14 + Math.random() * 20,
            bad: true,
            nm: false,
          });
        }
        const pTop = g.H - 36, pBot = g.H - 22;
        g.blocks = g.blocks.filter((b) => {
          b.y += b.vy * dt;
          if (b.y + b.h > pTop && b.y < pBot && Math.abs(b.x - g.px) < (b.w + 40) / 2 - 5) {
            L.play("error");
            finish();
            return false;
          }
          if (!b.nm && b.y + b.h >= pTop) {
            b.nm = true;
            if (Math.abs(b.x - g.px) < 60) {
              g.near++;
              L.play("tick");
            }
          }
          return b.y < g.H + 40;
        });
        g.score = Math.floor(g.t * 10) + g.near;
      } else if (eng === "catcher") {
        if (key.has("ArrowLeft") || key.has("a")) g.target -= 340 * spd * dt;
        if (key.has("ArrowRight") || key.has("d")) g.target += 340 * spd * dt;
        g.target = clamp(g.target, 26, g.W - 26);
        g.px += (g.target - g.px) * Math.min(1, dt * 16);
        g.px = clamp(g.px, 26, g.W - 26);
        const gr = clamp(L.P.goodRatio ?? 0.68, 0.1, 0.9);
        const fr = clamp(L.P.fallRate ?? 2.6, 0.3, 8);
        g.spawn -= dt * fr;
        if (g.spawn <= 0) {
          g.spawn = 1;
          g.items.push({
            x: 18 + Math.random() * (g.W - 36),
            y: -16,
            vy: (85 + Math.random() * 60) * spd + g.t * 2,
            w: 26,
            h: 26,
            bad: Math.random() > gr,
            nm: false,
          });
        }
        const bandTop = g.H - 52, bandBot = g.H - 26;
        g.items = g.items.filter((it) => {
          it.y += it.vy * dt;
          if (it.y + 10 > bandTop && it.y < bandBot && Math.abs(it.x - g.px) < 26) {
            if (it.bad) {
              L.play("error");
              finish();
              return false;
            }
            g.score += 10;
            L.play("pop");
            return false;
          }
          return it.y < g.H + 20;
        });
        if (g.t >= 45) finish();
      } else if (eng === "shooter") {
        if (key.has("ArrowLeft") || key.has("a")) g.target -= 300 * spd * dt;
        if (key.has("ArrowRight") || key.has("d")) g.target += 300 * spd * dt;
        g.target = clamp(g.target, 24, g.W - 24);
        g.px += (g.target - g.px) * Math.min(1, dt * 14);
        g.px = clamp(g.px, 24, g.W - 24);
        const rate = clamp(L.P.fireRate ?? 1.6, 0.5, 8);
        g.fire -= dt;
        if (g.fire <= 0) {
          shoot();
          g.fire = 1 / rate;
        }
        for (const b of g.bullets) b.y -= 340 * dt;
        const alive = g.invaders.filter((v) => v.alive);
        if (alive.length === 0) {
          g.wave++;
          for (let r = 0; r < 3; r++)
            for (let c = 0; c < 8; c++) g.invaders.push({ x: 52 + c * 46, y: 26 + r * 34, alive: true });
        } else {
          let minX = Infinity, maxX = -Infinity;
          for (const v of alive) {
            minX = Math.min(minX, v.x);
            maxX = Math.max(maxX, v.x);
          }
          const sp = (26 + g.wave * 8) * spd;
          let stepDown = false;
          for (const v of alive) {
            v.x += sp * dt * g.invDir;
            minX = Math.min(minX, v.x);
            maxX = Math.max(maxX, v.x);
          }
          if (g.invDir > 0 && maxX > g.W - 24) {
            g.invDir = -1;
            stepDown = true;
          } else if (g.invDir < 0 && minX < 24) {
            g.invDir = 1;
            stepDown = true;
          }
          for (const v of alive) if (stepDown) v.y += 14;
        }
        for (const b of g.bullets) {
          for (const v of g.invaders) {
            if (v.alive && Math.abs(v.x - b.x) < 16 && Math.abs(v.y - b.y) < 13) {
              v.alive = false;
              b.y = -99;
              g.score += 5;
              L.play("star");
            }
          }
        }
        g.bullets = g.bullets.filter((b) => b.y > -12);
        for (const v of g.invaders) {
          if (v.alive && v.y + 9 >= g.H - 40) {
            L.play("error");
            finish();
            break;
          }
        }
      } else if (eng === "quiz") {
        if (!g.q) g.q = mkQ();
        g.qTime -= dt;
        if (g.qTime <= 0) {
          g.msg = "too slow";
          g.msgAt = Date.now();
          L.play("error");
          nextQ();
        }
      } else if (eng === "memory") {
        if (g.unflip && Date.now() >= g.unflip) {
          for (const i of g.opens) {
            const c = g.cards[i];
            if (c) c.open = false;
          }
          g.opens = [];
          g.unflip = 0;
        }
        if (g.t >= 90) finish(g.score - Math.max(0, g.moves - g.cards.length / 2) * 2);
      } else if (eng === "flappy") {
        const gap = clamp(L.P.gapSize ?? 110, 40, 200);
        const birdX = g.W * 0.28;
        g.vy += 980 * spd * dt;
        g.py += g.vy * dt;
        if (g.py < 13) {
          g.py = 13;
          g.vy = 0;
        }
        g.spawn -= dt;
        if (g.spawn <= 0) {
          g.spawn = 1.55;
          g.pipes.push({
            x: g.W + 30,
            gapY: 60 + gap / 2 + Math.random() * Math.max(10, g.H - 120 - gap),
            passed: false,
          });
        }
        g.pipes = g.pipes.filter((p) => {
          p.x -= 130 * spd * dt;
          if (!p.passed && p.x + 52 < birdX - 11) {
            p.passed = true;
            g.score += 10;
            L.play("coin");
          }
          if (
            g.py + 11 > p.gapY - gap / 2 &&
            g.py - 11 < p.gapY + gap / 2 &&
            birdX + 11 > p.x &&
            birdX - 11 < p.x + 52
          ) {
            L.play("error");
            finish();
          }
          return p.x > -70;
        });
        if (g.py + 11 >= g.H - 14) {
          L.play("error");
          finish();
        }
      }
      bump();
    };
    raf = requestAnimationFrame(loop);
    bump();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  // keyboard listeners only while running
  useEffect(() => {
    if (!running) return;
    const eng = live.current.def.engine;
    const kd = (e: KeyboardEvent) => {
      if ((eng === "flappy" || eng === "shooter") && e.key === " ") e.preventDefault();
      if ((eng === "dodge" || eng === "catcher" || eng === "shooter") && (e.key === "ArrowLeft" || e.key === "ArrowRight"))
        e.preventDefault();
      if (e.key === " " && !e.repeat) {
        if (eng === "flappy") api.current.flap();
        if (eng === "shooter") api.current.shoot();
      }
      keys.current.add(e.key);
    };
    const ku = (e: KeyboardEvent) => keys.current.delete(e.key);
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    return () => {
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
      keys.current.clear();
    };
  }, [running]);

  // ── render ─────────────────────────────────────────────────────────────────
  const g = G.current;
  const eng = def.engine;
  const meta = ENGINE_META.find((m) => m.id === eng) ?? ENGINE_META[0];
  const prm = def.params ?? {};
  const player = prm.playerColor || "#7dd3fc";
  const enemy = prm.enemyColor || "#f87171";
  const bg = prm.bgColor || "transparent";
  const accent = def.accent || "#f59e0b";
  const qc = Math.round(clamp(P.questionCount ?? 8, 3, 20));
  const gap = clamp(P.gapSize ?? 110, 40, 200);
  const birdX = g.W * 0.28;
  const limit = eng === "catcher" ? 45 : eng === "memory" ? 90 : 0;
  const timePct =
    limit > 0
      ? clamp(1 - g.t / limit, 0, 1)
      : eng === "quiz"
        ? clamp(g.qTime / clamp(P.timePerQ ?? 10, 3, 30), 0, 1)
        : 0;
  const showMsg = eng === "quiz" && g.msg && Date.now() - g.msgAt < 900;
  const follow = running && (eng === "dodge" || eng === "catcher" || eng === "shooter");

  let body: ReactNode = null;
  if (eng === "dodge") {
    body = (
      <>
        <div className="absolute bottom-0 left-0 right-0" style={{ height: 8, background: "rgba(0,0,0,.07)" }} />
        {g.blocks.map((b, i) => (
          <div
            key={i}
            className="absolute rounded-[4px]"
            style={{ left: b.x - b.w / 2, top: b.y, width: b.w, height: b.h, background: enemy, boxShadow: `inset -5px -4px 0 rgba(0,0,0,.18)` }}
          />
        ))}
        <div
          className="absolute rounded-[5px]"
          style={{ left: g.px - 20, top: g.H - 36, width: 40, height: 14, background: player, boxShadow: `inset -6px -4px 0 rgba(0,0,0,.2)` }}
        />
        <div className="pixel-font pointer-events-none absolute bottom-1 right-2 text-[11px] text-dim">near miss ×{g.near}</div>
      </>
    );
  } else if (eng === "catcher") {
    body = (
      <>
        {g.items.map((it, i) => (
          <div
            key={i}
            className="pointer-events-none absolute grid place-items-center"
            style={{ left: it.x - 13, top: it.y - 13, width: 26, height: 26, fontSize: 21, lineHeight: 1, color: it.bad ? enemy : "#fbbf24", textShadow: "0 1px 1px rgba(0,0,0,.2)" }}
          >
            {it.bad ? "✹" : "✦"}
          </div>
        ))}
        <div
          className="pointer-events-none absolute"
          style={{ left: g.px - 24, top: g.H - 56, fontSize: 30, lineHeight: "34px", filter: "drop-shadow(0 2px 0 rgba(0,0,0,.15))" }}
        >
          🧺
        </div>
      </>
    );
  } else if (eng === "shooter") {
    body = (
      <>
        {g.invaders.map(
          (v, i) =>
            v.alive && (
              <div
                key={i}
                className="absolute rounded-[4px]"
                style={{ left: v.x - 12, top: v.y - 9, width: 24, height: 18, background: enemy, boxShadow: `inset -5px -4px 0 rgba(0,0,0,.22)` }}
              />
            ),
        )}
        {g.bullets.map((b, i) => (
          <div key={i} className="absolute rounded-[2px]" style={{ left: b.x - 2, top: b.y - 8, width: 4, height: 12, background: player }} />
        ))}
        <div
          className="absolute rounded-[5px]"
          style={{ left: g.px - 22, top: g.H - 30, width: 44, height: 12, background: player, boxShadow: `inset -6px -3px 0 rgba(0,0,0,.2)` }}
        />
        <div className="pixel-font pointer-events-none absolute bottom-1 right-2 text-[11px] text-dim">wave {g.wave + 1}</div>
      </>
    );
  } else if (eng === "quiz") {
    body = (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4">
        <div className="pixel-font text-[12px] text-dim">
          question {Math.min(g.qIdx + 1, qc)} / {qc}
        </div>
        <div className="pixel-font text-[28px] leading-none">{g.q ? `${g.q.a} ${g.q.op} ${g.q.b} = ?` : "…"}</div>
        {showMsg && (
          <div className="pixel-font text-[13px]" style={{ color: g.msg.startsWith("+") ? "#16a34a" : enemy }}>
            {g.msg}
          </div>
        )}
        <div className="grid w-full max-w-[300px] grid-cols-2 gap-2">
          {g.q?.answers.map((n, i) => (
            <button key={i} type="button" className="btn pixel-font text-[16px]" disabled={!running} onClick={() => api.current.answer(n)}>
              {n}
            </button>
          ))}
        </div>
        <div className="text-[11px] text-dim">{def.controls}</div>
      </div>
    );
  } else if (eng === "memory") {
    const gs = prm.gridSize === 6 ? 6 : 4;
    body = (
      <div className="absolute inset-0 grid place-items-center p-2">
        <div
          className="grid"
          style={{ gridTemplateColumns: `repeat(${gs}, minmax(0, 1fr))`, gap: 6, width: Math.max(150, Math.min(g.W - 16, g.H - 16, 520)) }}
        >
          {g.cards.map((c, i) => (
            <button
              key={i}
              type="button"
              onClick={() => api.current.flip(i)}
              className="relative border-0 bg-transparent p-0"
              style={{ aspectRatio: "1 / 1", perspective: 500, cursor: running ? "pointer" : "default" }}
            >
              <div
                className="absolute inset-0"
                style={{ transformStyle: "preserve-3d", transform: c.open || c.done ? "rotateY(180deg)" : "none", transition: "transform .28s var(--ease-soft, ease)" }}
              >
                <div
                  className="absolute inset-0 grid place-items-center rounded-lg"
                  style={{ backfaceVisibility: "hidden", background: hexA(accent, "22"), boxShadow: `inset 0 0 0 2px ${hexA(accent, "55")}` }}
                >
                  <span className="pixel-font text-[13px]" style={{ color: accent }}>
                    ?
                  </span>
                </div>
                <div
                  className="absolute inset-0 grid place-items-center rounded-lg"
                  style={{ backfaceVisibility: "hidden", transform: "rotateY(180deg)", background: "rgba(255,255,255,.85)", fontSize: 16, opacity: c.done ? 0.45 : 1, boxShadow: "inset 0 0 0 2px rgba(0,0,0,.06)" }}
                >
                  {c.emo}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  } else {
    // flappy
    body = (
      <>
        {g.pipes.map((p, i) => (
          <div key={i}>
            <div
              className="absolute rounded-[6px]"
              style={{ left: p.x, top: -4, width: 52, height: Math.max(0, p.gapY - gap / 2 + 4), background: enemy, boxShadow: `inset -6px 0 0 rgba(0,0,0,.12)` }}
            />
            <div
              className="absolute rounded-[6px]"
              style={{ left: p.x, top: p.gapY + gap / 2, width: 52, height: Math.max(0, g.H - p.gapY - gap / 2 + 4), background: enemy, boxShadow: `inset -6px 0 0 rgba(0,0,0,.12)` }}
            />
          </div>
        ))}
        <div className="absolute bottom-0 left-0 right-0" style={{ height: 14, background: "rgba(0,0,0,.08)" }} />
        <div
          className="absolute rounded-full"
          style={{ left: birdX - 11, top: g.py - 11, width: 22, height: 22, background: player, boxShadow: `inset -5px -4px 0 rgba(0,0,0,.18)` }}
        />
        <div className="pixel-font pointer-events-none absolute bottom-0.5 right-2 text-[10px] text-dim">tap / space to flap</div>
      </>
    );
  }

  return (
    <div
      ref={wrap}
      className="relative h-full w-full select-none overflow-hidden"
      style={{ background: bg, touchAction: "none", cursor: follow ? "none" : "default" }}
      onPointerMove={(e) => {
        const L = live.current;
        const e2 = L.def.engine;
        if (!L.running || (e2 !== "dodge" && e2 !== "catcher" && e2 !== "shooter")) return;
        const r = e.currentTarget.getBoundingClientRect();
        G.current.target = clamp(((e.clientX - r.left) / Math.max(1, r.width)) * G.current.W, 24, G.current.W - 24);
      }}
      onPointerDown={(e) => {
        const L = live.current;
        if (!L.running) return;
        const e2 = L.def.engine;
        if (e2 === "flappy") {
          api.current.flap();
        } else if (e2 === "shooter") {
          const r = e.currentTarget.getBoundingClientRect();
          G.current.target = clamp(((e.clientX - r.left) / Math.max(1, r.width)) * G.current.W, 24, G.current.W - 24);
          api.current.shoot();
        }
      }}
    >
      <div className="hud-pill pixel-font pointer-events-none absolute left-2 top-2 z-10">⭐ {Math.floor(g.score)}</div>
      {(limit > 0 || eng === "quiz") && (
        <div className="pointer-events-none absolute left-1/2 top-3 z-10 h-1.5 w-28 -translate-x-1/2 overflow-hidden rounded-full bg-black/10">
          <div className="h-full rounded-full" style={{ width: `${Math.round(timePct * 100)}%`, background: accent }} />
        </div>
      )}
      {body}
    </div>
  );
}
