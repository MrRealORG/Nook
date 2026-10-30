
import { useCallback, useEffect, useRef, useState } from "react";
import type { GameComponentProps } from "@/components/games/GameShell";

// ---- Math Blitz: 45s round. Questions grow with difficulty (up every 5 correct).
// Correct = +10 x streak multiplier; wrong = -3s + streak reset.

const ROUND_MS = 45_000;
const MAX_DIFF = 6;

type Sym = "+" | "−" | "×";
type Q = { a: number; b: number; sym: Sym; ans: number; options: number[] };

// operand ranges per difficulty level (index 0 = difficulty 1)
const RANGES: { add: [number, number]; sub: [number, number]; mul: [number, number] }[] = [
  { add: [1, 10], sub: [1, 10], mul: [1, 5] },
  { add: [5, 25], sub: [5, 25], mul: [2, 7] },
  { add: [10, 50], sub: [10, 50], mul: [3, 9] },
  { add: [15, 80], sub: [15, 80], mul: [4, 12] },
  { add: [25, 120], sub: [25, 120], mul: [5, 15] },
  { add: [30, 199], sub: [30, 199], mul: [6, 19] },
];

function shuffled<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function optionSet(a: number, b: number, ans: number): number[] {
  const cands = [ans + 1, ans - 1, ans + 2, ans - 2, ans + 10, ans - 10, ans + 5, ans - 5, a + b, a - b, Math.abs(a - b) + 1, b * 2];
  const pool: number[] = [];
  for (const c of cands) if (c >= 0 && c !== ans && !pool.includes(c)) pool.push(c);
  const picked = shuffled(pool).slice(0, 3);
  let extra = 1;
  while (picked.length < 3) {
    const v = ans + extra * 3 + 1;
    if (v !== ans && !picked.includes(v)) picked.push(v);
    extra++;
  }
  return shuffled([ans, ...picked]);
}

function makeQuestion(diff: number): Q {
  const t = RANGES[Math.min(RANGES.length, Math.max(1, diff)) - 1];
  const sym: Sym = (["+", "−", "×"] as const)[Math.floor(Math.random() * 3)];
  const rnd = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));
  let a: number;
  let b: number;
  let ans: number;
  if (sym === "+") {
    a = rnd(t.add[0], t.add[1]);
    b = rnd(t.add[0], t.add[1]);
    ans = a + b;
  } else if (sym === "−") {
    a = rnd(t.sub[0], t.sub[1]);
    b = rnd(t.sub[0], t.sub[1]);
    if (b > a) [a, b] = [b, a];
    ans = a - b;
  } else {
    a = rnd(t.mul[0], t.mul[1]);
    b = rnd(t.mul[0], t.mul[1]);
    ans = a * b;
  }
  return { a, b, sym, ans, options: optionSet(a, b, ans) };
}

export default function MathGame({ running, onEnd, play }: GameComponentProps) {
  const [q, setQ] = useState<Q>(() => makeQuestion(1));
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [diff, setDiff] = useState(1);
  const [correct, setCorrect] = useState(0);
  const [remaining, setRemaining] = useState(ROUND_MS / 1000);
  const [flash, setFlash] = useState<"ok" | "bad" | null>(null);
  const [lock, setLock] = useState(false);

  const scoreRef = useRef(0);
  const endAt = useRef(0);
  const lastTick = useRef(99);
  const finishedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef({ running, onEnd, play });
  // keep latest props reachable from handlers/timers without re-subscribing
  useEffect(() => {
    live.current = { running, onEnd, play };
  });

  const finish = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    setRemaining(0);
    setLock(true);
    live.current.onEnd(scoreRef.current);
  }, []);

  // reset when a fresh run begins; clear pending timers on unmount
  const prevRun = useRef(running);
  useEffect(() => {
    if (running && !prevRun.current) {
      if (timerRef.current) clearTimeout(timerRef.current);
      scoreRef.current = 0;
      lastTick.current = 99;
      finishedRef.current = false;
      setQ(makeQuestion(1));
      setScore(0);
      setStreak(0);
      setDiff(1);
      setCorrect(0);
      setRemaining(ROUND_MS / 1000);
      setFlash(null);
      setLock(false);
    }
    prevRun.current = running;
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [running]);

  // round clock — (re)armed whenever a run starts
  useEffect(() => {
    if (!running) return;
    endAt.current = Date.now() + ROUND_MS;
    lastTick.current = 99;
    const iv = setInterval(() => {
      const rem = Math.max(0, (endAt.current - Date.now()) / 1000);
      setRemaining(rem);
      const sec = Math.ceil(rem);
      if (rem > 0 && rem <= 5.05 && sec !== lastTick.current) {
        lastTick.current = sec;
        live.current.play("tick");
      }
      if (rem <= 0) finish();
    }, 100);
    return () => clearInterval(iv);
  }, [running, finish]);

  const answer = (val: number) => {
    const L = live.current;
    if (!L.running || finishedRef.current || lock) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    const good = val === q.ans;
    if (good) {
      const ns = streak + 1;
      scoreRef.current += 10 * ns;
      setScore(scoreRef.current);
      setStreak(ns);
      L.play("coin");
      const nc = correct + 1;
      let nd = diff;
      if (nc % 5 === 0 && diff < MAX_DIFF) {
        nd = diff + 1;
        L.play("level");
      }
      setCorrect(nc);
      setDiff(nd);
      setQ(makeQuestion(nd));
      setFlash("ok");
    } else {
      setStreak(0);
      endAt.current = Math.max(Date.now(), endAt.current - 3000);
      setRemaining(Math.max(0, (endAt.current - Date.now()) / 1000));
      L.play("error");
      setFlash("bad");
    }
    setLock(true);
    timerRef.current = setTimeout(() => {
      setLock(false);
      setFlash(null);
    }, good ? 220 : 450);
  };

  const pct = Math.max(0, Math.min(100, (remaining / (ROUND_MS / 1000)) * 100));
  const urgency = remaining <= 10;

  return (
    <div className="grid h-full w-full place-items-center p-2">
      <div className="flex w-[min(380px,100%)] flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2 pixel-font text-[13px]">
          <span className="chip">SCORE {score}</span>
          <span
            className="chip"
            style={streak >= 2 ? { color: "var(--accent-ink)", background: "var(--accent)", borderColor: "transparent" } : undefined}
            aria-label={`Streak multiplier ${streak}`}
          >
            ×{streak} streak
          </span>
          <span className="chip">LVL {diff}</span>
        </div>

        <div
          className="h-2.5 w-full overflow-hidden rounded-full"
          style={{ background: "var(--panel2)", border: "1px solid var(--line)" }}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={45}
          aria-valuenow={Math.round(remaining)}
          aria-label="Time remaining"
        >
          <div
            className="h-full rounded-full"
            style={{
              width: `${pct}%`,
              background: "var(--accent)",
              transition: "width .12s linear",
              opacity: urgency ? 0.85 : 1,
            }}
          />
        </div>

        <div
          className="pixel-font grid place-items-center rounded-2xl px-3 py-6 text-[34px] leading-none"
          style={{
            border: `1px solid ${flash === "bad" ? "#c1504e" : flash === "ok" ? "var(--accent)" : "var(--line)"}`,
            background: flash === "bad" ? "rgba(193,80,78,0.12)" : flash === "ok" ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "var(--panel2)",
            transition: "border-color .15s ease, background .15s ease",
            color: "var(--ink)",
          }}
          aria-live="polite"
        >
          <span>
            {q.a} {q.sym} {q.b} <span style={{ color: "var(--dim)", fontSize: 24 }}>= ?</span>
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          {q.options.map((o, i) => (
            <button
              key={`${o}-${i}`}
              type="button"
              className="btn pixel-font text-[20px]"
              style={{ height: 48 }}
              onClick={() => answer(o)}
              disabled={lock}
              aria-label={`Answer ${o}`}
            >
              {o}
            </button>
          ))}
        </div>

        <div className="pixel-font text-center text-[11px]" style={{ color: "var(--dim)" }}>
          TIME {Math.ceil(remaining)}s · wrong = −3s · streaks multiply
        </div>
      </div>
    </div>
  );
}
