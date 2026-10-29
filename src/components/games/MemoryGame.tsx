"use client";

import { useEffect, useRef, useState } from "react";
import type { GameComponentProps } from "@/components/games/GameShell";
import { useStore } from "@/lib/store";
import { THEMES } from "@/lib/themes";

// 8 tiny pixel-art icons: 1 char = 1 pixel, scaled up via CSS (image-rendering: pixelated)
// a = accent, b = ramp[3], c = ramp[2], d = ramp[1], e = ramp[4]
const ICONS: string[][] = [
  [".aa..aa.", "aaaaaaaa", "aaaaaaaa", ".aaaaaa.", "..aaaa..", "...aa..."], // heart
  ["...aa...", "..aaaa..", "aaaaaaaa", ".aaaaaa.", "..aaaa..", ".aa..aa."], // star
  ["....aaaa", "....a...", "....a...", "....a...", "..aaaaa.", "..aaaaa.", "...aaa.."], // note
  ["......c.", ".....c..", "..aaaa..", ".aaaaaa.", ".aaaaaa.", ".aaaaaa.", "..aaaa.."], // berry
  ["..bbbb..", ".bbbbbb.", "bbbbbbbb", "bbbbbbbb", ".bbbbbb."], // cloud
  ["....aaa.", "...aaa..", "..aaaa..", "....aa..", "...aa...", "..aa....", ".aa....."], // bolt
  [".....cc.", "...cccc.", ".cccccc.", ".ccccccc", "...cccc.", ".....cd."], // leaf
  ["..eaae..", ".aaaaaa.", "aaaaaaaa", ".aaaaaa.", "..aaaa..", "...aa...", "....a..."], // gem
];
const NAMES = ["heart", "star", "note", "berry", "cloud", "bolt", "leaf", "gem"];

type Card = { icon: number; matched: boolean };

function deal(): Card[] {
  const icons = [...Array(8).keys(), ...Array(8).keys()];
  for (let i = icons.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [icons[i], icons[j]] = [icons[j], icons[i]];
  }
  return icons.map((icon) => ({ icon, matched: false }));
}

function IconCanvas({ icon }: { icon: number }) {
  const theme = useStore((s) => s.theme);
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const th = THEMES[theme];
    const colors: Record<string, string> = { a: th.accent, b: th.ramp[3], c: th.ramp[2], d: th.ramp[1], e: th.ramp[4] };
    ctx.clearRect(0, 0, c.width, c.height);
    ICONS[icon].forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const ch = row[x];
        if (ch === ".") continue;
        ctx.fillStyle = colors[ch] ?? th.ink;
        ctx.fillRect(x, y, 1, 1);
      }
    });
  }, [icon, theme]);
  const rows = ICONS[icon];
  return (
    <canvas
      ref={ref}
      width={rows[0].length}
      height={rows.length}
      className="pixelated"
      style={{ width: rows[0].length * 8 }}
      aria-hidden="true"
    />
  );
}

export default function MemoryGame({ running, onEnd, play }: GameComponentProps) {
  const [cards, setCards] = useState<Card[]>(deal);
  const [flipped, setFlipped] = useState<number[]>([]);
  const [moves, setMoves] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [started, setStarted] = useState(false);
  const startedAt = useRef(0);
  const finishedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef({ running, onEnd, play });
  // keep latest props reachable from handlers without re-subscribing
  useEffect(() => {
    live.current = { running, onEnd, play };
  });

  const matched = cards.filter((c) => c.matched).length / 2;
  const done = matched === 8;

  // reset when a fresh run begins; clear pending timers on unmount
  const prevRun = useRef(running);
  useEffect(() => {
    if (running && !prevRun.current) {
      setCards(deal());
      setFlipped([]);
      setMoves(0);
      setSeconds(0);
      setStarted(false);
      startedAt.current = 0;
      finishedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    }
    prevRun.current = running;
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [running]);

  // match timer
  useEffect(() => {
    if (!running || !started || done) return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [running, started, done]);

  const click = (i: number) => {
    const L = live.current;
    if (!L.running || finishedRef.current || done) return;
    if (flipped.length >= 2 || flipped.includes(i) || cards[i].matched) return;
    if (!started) {
      setStarted(true);
      startedAt.current = Date.now();
    }
    L.play("flip");
    const next = [...flipped, i];
    setFlipped(next);
    if (next.length < 2) return;

    const [a, b] = next;
    const newMoves = moves + 1;
    setMoves(newMoves);
    if (cards[a].icon === cards[b].icon) {
      L.play("match");
      const wasLast = cards.filter((c) => c.matched).length === 14;
      timerRef.current = setTimeout(() => {
        setCards((cs) => cs.map((c, idx) => (idx === a || idx === b ? { ...c, matched: true } : c)));
        setFlipped([]);
      }, 300);
      if (wasLast) {
        const secs = startedAt.current ? Math.floor((Date.now() - startedAt.current) / 1000) : 0;
        const score = Math.max(0, 1000 - newMoves * 10 - secs * 2);
        timerRef.current = setTimeout(() => {
          if (finishedRef.current) return;
          finishedRef.current = true;
          L.onEnd(score);
        }, 650);
      }
    } else {
      timerRef.current = setTimeout(() => setFlipped([]), 700);
    }
  };

  return (
    <div className="grid h-full w-full place-items-center p-2">
      <div className="flex flex-col items-center gap-3">
        <div className="flex flex-wrap items-center justify-center gap-2">
          <span className="chip">Moves {moves}</span>
          <span className="chip">Time {seconds}s</span>
          <span className="chip" style={done ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}>
            {matched}/8 pairs
          </span>
        </div>

        <div className="grid grid-cols-4 gap-2.5" style={{ width: "min(86vw, 336px)" }}>
          {cards.map((c, i) => {
            const open = c.matched || flipped.includes(i);
            return (
              <button
                key={i}
                onClick={() => click(i)}
                aria-label={open ? `${NAMES[c.icon]} card` : `Hidden card ${i + 1}`}
                disabled={c.matched}
                style={{ aspectRatio: "1 / 1", padding: 0, background: "transparent", border: "none", cursor: "pointer", perspective: 600 }}
              >
                <div
                  style={{
                    position: "relative",
                    width: "100%",
                    height: "100%",
                    transformStyle: "preserve-3d",
                    transition: "transform .3s ease",
                    transform: open ? "rotateY(180deg)" : "rotateY(0deg)",
                  }}
                >
                  {/* card back */}
                  <div
                    className="grid place-items-center"
                    style={{ position: "absolute", inset: 0, backfaceVisibility: "hidden", borderRadius: 10, border: "1px solid var(--line)", background: "var(--panel2)" }}
                  >
                    <span className="pixel-font text-[18px]" style={{ color: "var(--accent)" }}>?</span>
                  </div>
                  {/* card face */}
                  <div
                    className="grid place-items-center"
                    style={{
                      position: "absolute",
                      inset: 0,
                      backfaceVisibility: "hidden",
                      transform: "rotateY(180deg)",
                      borderRadius: 10,
                      border: `1px solid ${c.matched ? "var(--accent)" : "var(--line)"}`,
                      background: "var(--panel2)",
                      boxShadow: c.matched ? "0 0 0 2px color-mix(in srgb, var(--accent) 30%, transparent)" : "none",
                    }}
                  >
                    <IconCanvas icon={c.icon} />
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {!started && (
          <div className="pixel-font text-[12px]" style={{ color: "var(--ink)" }}>
            Click two cards to find a pair
          </div>
        )}
      </div>
    </div>
  );
}
