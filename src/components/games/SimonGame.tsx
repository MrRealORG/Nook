"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { THEMES } from "@/lib/themes";
import type { GameComponentProps } from "@/components/games/GameShell";

const TONES = ["pop", "click", "tick", "flip"] as const;
const RED = "#c1504e";
const PAD = 110;

// blend two hex colors (t = 0 → a, t = 1 → b)
function mixHex(a: string, b: string, t: number) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (sh: number) => Math.round(((pa >> sh) & 255) * (1 - t) + ((pb >> sh) & 255) * t);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

export default function SimonGame({ running, onEnd, play }: GameComponentProps) {
  const theme = useStore((s) => s.theme);
  const [seq, setSeq] = useState<number[]>([]);
  const [step, setStep] = useState(0);
  const [lit, setLit] = useState(-1);
  const [watch, setWatch] = useState(false);
  const [score, setScore] = useState(0);
  const [wrong, setWrong] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const finished = useRef(false);
  const live = useRef({ running, onEnd, play });
  useEffect(() => {
    live.current = { running, onEnd, play };
  });

  const addTimer = useCallback((t: ReturnType<typeof setTimeout>) => {
    timers.current.push(t);
  }, []);
  const clearTimers = useCallback(() => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
  }, []);

  const flash = useCallback(
    (i: number, ms: number, tone?: (typeof TONES)[number]) => {
      setLit(i);
      if (tone) live.current.play(tone);
      addTimer(setTimeout(() => setLit(-1), ms));
    },
    [addTimer],
  );

  // play the sequence back, speeding up slightly as it grows
  const playback = useCallback(
    (s: number[]) => {
      setWatch(true);
      const gap = Math.max(210, 500 - s.length * 26);
      s.forEach((pad, i) => {
        addTimer(setTimeout(() => flash(pad, gap * 0.55, TONES[pad]), 350 + i * gap));
      });
      addTimer(
        setTimeout(() => {
          setWatch(false);
          setStep(0);
        }, 350 + s.length * gap),
      );
    },
    [addTimer, flash],
  );

  // First run kick-off. GameShell remounts the component for every run
  // (key={runKey}), so state always starts fresh; this only starts round 1.
  // Pending timers are cancelled when the run stops / the component unmounts.
  const startRun = useCallback(() => {
    finished.current = false;
    const first = [Math.floor(Math.random() * 4)];
    setSeq(first);
    setStep(0);
    setLit(-1);
    setWatch(false);
    setScore(0);
    setWrong(false);
    playback(first);
  }, [playback]);

  useEffect(() => {
    if (!running) return;
    const t = setTimeout(startRun, 30);
    timers.current.push(t);
    return clearTimers;
  }, [running, startRun, clearTimers]);

  const onPad = (i: number) => {
    const L = live.current;
    if (!L.running || finished.current || watch || seq.length === 0) return;
    flash(i, 170, TONES[i]);
    if (seq[step] === i) {
      const next = step + 1;
      if (next === seq.length) {
        // round complete: +10 × round, grow the pattern, play again
        setScore(score + 10 * seq.length);
        L.play("match");
        const grown = [...seq, Math.floor(Math.random() * 4)];
        setSeq(grown);
        setStep(0);
        setWatch(true); // block input between rounds
        addTimer(setTimeout(() => playback(grown), 700));
      } else {
        setStep(next);
      }
    } else {
      // wrong pad ends the game
      L.play("error");
      setWrong(true);
      finished.current = true;
      addTimer(setTimeout(() => L.onEnd(score), 750));
    }
  };

  const th = THEMES[theme];
  const padColors = [th.accent, mixHex(th.accent, th.ramp[4], 0.55), mixHex(th.accent, th.ramp[0], 0.5), th.ramp[2]];

  return (
    <div className="grid h-full w-full place-items-center p-2">
      <div className="flex flex-col items-center gap-3">
        <div className="pixel-font flex items-center justify-between text-[13px] text-dim" style={{ width: PAD * 2 + 12 }}>
          <span>ROUND {Math.max(1, seq.length)}</span>
          <span>SCORE {score}</span>
        </div>

        <div className="grid grid-cols-2 gap-3" role="group" aria-label="Simon pads">
          {padColors.map((c, i) => (
            <button
              key={i}
              type="button"
              aria-label={`Pad ${i + 1}`}
              onClick={() => onPad(i)}
              className="pixel-font grid place-items-center rounded-xl border-[3px] text-[24px] transition-all duration-100"
              style={{
                width: PAD,
                height: PAD,
                background: c,
                borderColor: wrong ? RED : lit === i ? th.ramp[4] : "var(--line)",
                color: th.ink,
                filter: lit === i ? "brightness(1.3) saturate(1.15)" : "brightness(0.55) saturate(0.8)",
                transform: lit === i ? "scale(0.95)" : "none",
                boxShadow: lit === i ? "0 0 18px -2px var(--accent)" : "none",
                cursor: watch ? "default" : "pointer",
              }}
            >
              {i + 1}
            </button>
          ))}
        </div>

        <div className="pixel-font h-5 text-[13px]" style={{ color: wrong ? RED : "var(--dim)" }}>
          {watch ? "Watch the pattern…" : wrong ? "Wrong pad!" : seq.length ? "Your turn — repeat it!" : "Get ready…"}
        </div>
      </div>
    </div>
  );
}
