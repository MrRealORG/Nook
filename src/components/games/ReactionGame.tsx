"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GameComponentProps } from "@/components/games/GameShell";

const ROUNDS = 5;
const PENALTY = 500;
const RED = "#c1504e";
const GREEN = "#57a85c";

type Phase = "wait" | "go" | "gap" | "done";

export default function ReactionGame({ running, onEnd, play }: GameComponentProps) {
  const [phase, setPhase] = useState<Phase>("wait");
  const [round, setRound] = useState(1);
  const [times, setTimes] = useState<number[]>([]);
  const [note, setNote] = useState("Get ready…");
  const goAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finished = useRef(false);
  const live = useRef({ onEnd, play });
  useEffect(() => {
    live.current = { onEnd, play };
  });

  const clearTimer = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  const later = useCallback(
    (fn: () => void, ms: number) => {
      clearTimer();
      timer.current = setTimeout(fn, ms);
    },
    [clearTimer],
  );

  // schedule a round: red "wait" phase, then green after a random 1-3s delay
  const arm = useCallback(
    (r: number) => {
      setRound(r + 1);
      setPhase("wait");
      setNote("Wait for green…");
      later(() => {
        goAt.current = performance.now();
        setPhase("go");
        setNote("CLICK NOW!");
        live.current.play("tick");
      }, 1000 + Math.random() * 2000);
    },
    [later],
  );

  // First run kick-off. GameShell remounts the component for every run
  // (key={runKey}), so state always starts fresh; this only arms round 1.
  // Timers are cleared when the run stops / the component unmounts.
  useEffect(() => {
    if (!running) return;
    const t = setTimeout(() => arm(0), 30);
    timer.current = t;
    return () => {
      clearTimeout(t);
      timer.current = null;
    };
  }, [running, arm]);

  const finish = (all: number[]) => {
    finished.current = true;
    setPhase("done");
    const avg = all.reduce((a, b) => a + b, 0) / all.length;
    live.current.onEnd(Math.max(0, Math.round(600 - avg)));
  };

  const record = (ms: number, tooSoon: boolean) => {
    const all = [...times, ms];
    setTimes(all);
    setPhase("gap");
    live.current.play(tooSoon ? "error" : ms < 250 ? "star" : ms < 400 ? "pop" : "click");
    setNote(tooSoon ? `Too soon! +${PENALTY}ms penalty` : `${ms} ms · ${ms < 250 ? "lightning fast!" : ms < 400 ? "nice reflexes!" : "not bad"}`);
    later(
      () => {
        if (all.length >= ROUNDS) finish(all);
        else arm(all.length);
      },
      1050,
    );
  };

  const click = () => {
    if (finished.current || phase === "gap" || phase === "done") return;
    if (phase === "wait") {
      clearTimer();
      record(PENALTY, true);
    } else {
      record(Math.max(1, Math.round(performance.now() - goAt.current)), false);
    }
  };

  const total = times.length;
  const avg = total ? Math.round(times.reduce((a, b) => a + b, 0) / total) : 0;
  const zoneBg = phase === "go" ? GREEN : phase === "wait" ? RED : "var(--panel2)";

  return (
    <div className="grid h-full w-full place-items-center p-2">
      <div className="flex w-full max-w-[440px] flex-col gap-3">
        <div className="pixel-font flex items-center justify-between text-[13px] text-dim">
          <span>
            ROUND {Math.min(round, ROUNDS)}/{ROUNDS}
          </span>
          <span>AVG {total ? `${avg} ms` : "—"}</span>
        </div>

        <div
          role="button"
          tabIndex={0}
          aria-label="Reaction click zone"
          onClick={click}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              click();
            }
          }}
          className="pixel-font grid h-44 select-none place-items-center rounded-2xl border-[3px] text-center outline-none"
          style={{
            background: zoneBg,
            borderColor: phase === "go" ? "#2e7a38" : phase === "wait" ? "#8c3a38" : "var(--line)",
            color: phase === "wait" || phase === "go" ? "#ffffff" : "var(--ink)",
            cursor: phase === "wait" || phase === "go" ? "pointer" : "default",
            transition: "background .12s",
          }}
        >
          <div className="px-4">
            <div className="text-[21px]">{phase === "go" ? "CLICK!" : phase === "wait" ? "Wait for green…" : phase === "gap" ? note : "Done!"}</div>
            {phase === "wait" && <div className="mt-2 text-[11px] opacity-80">click early = {PENALTY}ms penalty</div>}
            {phase === "gap" && <div className="mt-2 text-[11px] opacity-70">{total < ROUNDS ? "next round coming up…" : "calculating score…"}</div>}
          </div>
        </div>

        <div className="flex flex-wrap justify-center gap-2">
          {Array.from({ length: ROUNDS }, (_, i) => (
            <span
              key={i}
              className="pixel-font rounded-lg border px-2.5 py-1 text-[12px]"
              style={{
                borderColor: "var(--line)",
                background: "var(--panel2)",
                color: times[i] === undefined ? "var(--faint)" : times[i] === PENALTY ? RED : "var(--accent)",
              }}
            >
              R{i + 1} {times[i] !== undefined ? `${times[i]}ms` : "·"}
            </span>
          ))}
        </div>

        <div className="text-center text-[11px] text-dim">score = 600 − average ms · faster reactions = higher score</div>
      </div>
    </div>
  );
}
