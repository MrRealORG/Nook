"use client";

import { useEffect, useReducer, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { GameComponentProps } from "@/components/games/GameShell";
import { useStore } from "@/lib/store";
import { THEMES } from "@/lib/themes";

// ---- Minesweeper — the real classic ----------------------------------------
// First click is always safe (mines are laid AFTER it, never on the clicked
// cell), flood-fill reveal, right-click / long-press flagging, chording on
// satisfied numbers, timer + mine counter, question marks (optional) and the
// classic smiley reset. Three authentic difficulties; Expert scrolls.

type Diff = {
  id: "beginner" | "intermediate" | "expert";
  label: string;
  cols: number;
  rows: number;
  mines: number;
  mult: number; // score multiplier per difficulty
  cell: number; // px per cell
};

const DIFFS: Diff[] = [
  { id: "beginner", label: "9×9 · 10", cols: 9, rows: 9, mines: 10, mult: 1, cell: 34 },
  { id: "intermediate", label: "16×16 · 40", cols: 16, rows: 16, mines: 40, mult: 2, cell: 27 },
  { id: "expert", label: "30×16 · 99", cols: 30, rows: 16, mines: 99, mult: 4, cell: 23 },
];

type Mark = "none" | "flag" | "question";
type Cell = { mine: boolean; adj: number; revealed: boolean; mark: Mark; boom: boolean; wrong: boolean };
type Status = "playing" | "won" | "lost";

type GameData = {
  diff: Diff;
  cells: Cell[];
  laid: boolean; // mines placed (after first click)
  started: boolean; // timer started
  status: Status;
  elapsed: number;
  ended: boolean; // onEnd already scheduled
};

function makeBoard(d: Diff): Cell[] {
  return Array.from({ length: d.cols * d.rows }, () => ({ mine: false, adj: 0, revealed: false, mark: "none" as Mark, boom: false, wrong: false }));
}

function makeGame(d: Diff): GameData {
  return { diff: d, cells: makeBoard(d), laid: false, started: false, status: "playing", elapsed: 0, ended: false };
}

function neighborsOf(i: number, d: Diff): number[] {
  const x = i % d.cols;
  const y = Math.floor(i / d.cols);
  const out: number[] = [];
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= d.cols || ny >= d.rows) continue;
      out.push(ny * d.cols + nx);
    }
  return out;
}

/** classic per-number ink, readable on both light & dark revealed cells */
const NUM_COLORS = ["", "#5b8fd9", "#58a365", "#d96a5b", "#7a6fc9", "#b05f6e", "#4aaaaa", "#71717d", "#4a4a55"];

const pad3 = (n: number) => String(Math.max(0, Math.min(999, Math.floor(n)))).padStart(3, "0");
const led3 = (n: number) => (n < 0 ? "-" + String(Math.min(99, -n)).padStart(2, "0") : pad3(n));

/** win reveal: auto-flag every remaining mine (module-level so the board stays a plain data structure) */
function autoFlagMines(cells: Cell[]) {
  for (const c of cells) if (c.mine && c.mark !== "flag") c.mark = "flag";
}

/** lose reveal: show every unflagged mine and cross out wrong flags */
function revealAllMines(cells: Cell[]) {
  for (const c of cells) {
    if (c.mine && c.mark !== "flag") c.revealed = true;
    if (!c.mine && c.mark === "flag") c.wrong = true;
  }
}

export default function MinesweeperGame({ running, onEnd, play }: GameComponentProps) {
  const theme = useStore((s) => s.theme);
  const G = useRef<GameData>(makeGame(DIFFS[0]));
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const [questions, setQuestions] = useState(false); // allow flag → "?" → none cycling
  const [ooh, setOoh] = useState(false); // classic "surprised" face while pressing
  const endTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClick = useRef(false);
  const live = useRef({ running, onEnd, play });
  // keep latest props reachable from handlers without re-subscribing
  // (ref writes happen inside an effect, matching the other games — the
  // react-hooks/immutability rule rejects render-time ref writes)
  useEffect(() => {
    live.current = { running, onEnd, play };
  });

  useEffect(
    () => () => {
      if (endTimer.current) clearTimeout(endTimer.current);
      if (pressTimer.current) clearTimeout(pressTimer.current);
    },
    [],
  );

  // timer — one tick per second while a laid, unfinished board is on screen
  useEffect(() => {
    if (!running) return;
    const iv = setInterval(() => {
      const g = G.current;
      if (g.status === "playing" && g.started && g.elapsed < 999) {
        g.elapsed++;
        bump();
      }
    }, 1000);
    return () => clearInterval(iv);
  }, [running]);

  const finish = (score: number, delay: number) => {
    const g = G.current;
    if (g.ended) return;
    g.ended = true;
    if (endTimer.current) clearTimeout(endTimer.current);
    endTimer.current = setTimeout(() => live.current.onEnd(Math.max(0, Math.round(score))), delay);
  };

  const placeMines = (safe: number) => {
    const g = G.current;
    const d = g.diff;
    const pool: number[] = [];
    for (let i = 0; i < d.cols * d.rows; i++) if (i !== safe) pool.push(i);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    for (let k = 0; k < d.mines && k < pool.length; k++) g.cells[pool[k]].mine = true;
    for (let i = 0; i < g.cells.length; i++) if (!g.cells[i].mine) g.cells[i].adj = neighborsOf(i, d).filter((n) => g.cells[n].mine).length;
    g.laid = true;
    g.started = true;
  };

  /** iterative flood fill — returns number of newly revealed cells */
  const floodReveal = (start: number): number => {
    const g = G.current;
    const stack: number[] = [start];
    let n = 0;
    while (stack.length) {
      const i = stack.pop()!;
      const c = g.cells[i];
      if (c.revealed || c.mine || c.mark === "flag") continue;
      c.revealed = true;
      c.mark = "none";
      n++;
      if (c.adj === 0) for (const nb of neighborsOf(i, g.diff)) stack.push(nb);
    }
    return n;
  };

  const win = () => {
    const g = G.current;
    const d = g.diff;
    g.status = "won";
    autoFlagMines(g.cells); // auto-flag the rest
    live.current.play("win");
    const par = d.rows * d.cols; // ~1s per cell is par
    finish(d.mines * 10 * d.mult + Math.max(0, par - g.elapsed) * 2 * d.mult, 550);
  };

  const lose = (hit: number) => {
    const g = G.current;
    const d = g.diff;
    g.status = "lost";
    g.cells[hit].revealed = true;
    g.cells[hit].boom = true;
    revealAllMines(g.cells);
    live.current.play("error");
    const correct = g.cells.reduce((a, c) => a + (c.mine && c.mark === "flag" ? 1 : 0), 0);
    finish(correct * 5 * d.mult, 750);
  };

  const checkWin = () => {
    const g = G.current;
    if (g.status === "playing" && g.cells.every((c) => c.mine || c.revealed)) win();
  };

  const chord = (i: number) => {
    const g = G.current;
    const d = g.diff;
    const c = g.cells[i];
    if (!c.revealed || c.adj === 0) return;
    const nbs = neighborsOf(i, d);
    const flagged = nbs.reduce((a, j) => a + (g.cells[j].mark === "flag" ? 1 : 0), 0);
    if (flagged !== c.adj) {
      live.current.play("click");
      return;
    }
    const targets = nbs.filter((j) => {
      const t = g.cells[j];
      return !t.revealed && t.mark !== "flag";
    });
    if (!targets.length) return;
    const boom = targets.find((j) => g.cells[j].mine);
    if (boom !== undefined) {
      lose(boom);
      bump();
      return;
    }
    let n = 0;
    for (const j of targets) n += floodReveal(j);
    if (n > 0) live.current.play("pop");
    checkWin();
    bump();
  };

  const reveal = (i: number) => {
    const g = G.current;
    if (g.status !== "playing" || !live.current.running) return;
    if (!g.laid) placeMines(i); // first click is always safe
    const c = g.cells[i];
    if (c.revealed) {
      chord(i);
      return;
    }
    if (c.mark === "flag") return;
    if (c.mine) {
      lose(i);
      bump();
      return;
    }
    const n = floodReveal(i);
    if (n > 0) live.current.play("pop");
    checkWin();
    bump();
  };

  const toggleMark = (i: number) => {
    const g = G.current;
    if (g.status !== "playing" || !live.current.running) return;
    const c = g.cells[i];
    if (c.revealed) return;
    if (c.mark === "none") c.mark = "flag";
    else if (c.mark === "flag") c.mark = questions ? "question" : "none";
    else c.mark = "none";
    live.current.play("click");
    bump();
  };

  const reset = (nd?: Diff) => {
    if (endTimer.current) clearTimeout(endTimer.current);
    G.current = makeGame(nd ?? G.current.diff);
    live.current.play("click");
    bump();
  };

  // ---- pointer plumbing: long-press = flag on touch -------------------------
  const clearPress = () => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };

  const onCellPointerDown = (i: number, e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === "mouse") return;
    suppressClick.current = false;
    clearPress();
    pressTimer.current = setTimeout(() => {
      pressTimer.current = null;
      suppressClick.current = true;
      navigator.vibrate?.(30);
      toggleMark(i);
    }, 340);
  };

  const onCellClick = (i: number) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    reveal(i);
  };

  const onCellContext = (i: number) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    toggleMark(i);
  };

  // ---- render ---------------------------------------------------------------
  const g = G.current;
  const d = g.diff;
  const th = THEMES[theme];
  const flagCount = g.cells.reduce((a, c) => a + (c.mark === "flag" ? 1 : 0), 0);
  const minesLeft = d.mines - flagCount;
  const face = g.status === "won" ? "😎" : g.status === "lost" ? "😵" : ooh ? "😮" : "🙂";
  const playable = g.status === "playing" && running;

  const hiddenBg = th.dark ? th.ramp[3] : th.ramp[4];
  const hiddenLight = th.dark ? "rgba(255,255,255,.16)" : "rgba(255,255,255,.75)";
  const hiddenShadow = th.dark ? "rgba(0,0,0,.45)" : "rgba(0,0,0,.18)";
  const revealedBg = th.dark ? th.ramp[0] : th.panel;

  const cellStyle = (c: Cell): CSSProperties =>
    c.revealed
      ? {
          background: c.boom ? "#c9413c" : revealedBg,
          border: `1px solid color-mix(in srgb, ${th.ramp[1]} 55%, transparent)`,
          borderRadius: 3,
        }
      : {
          background: hiddenBg,
          borderRadius: 4,
          border: "1px solid transparent",
          boxShadow: `inset 1.5px 1.5px 0 ${hiddenLight}, inset -1.5px -1.5px 0 ${hiddenShadow}`,
        };

  return (
    <div className="flex h-full min-h-0 w-full flex-col items-center gap-2 p-2">
      {/* HUD — mine counter / smiley / timer */}
      <div className="flex flex-wrap items-center justify-center gap-2">
        <span
          className="pixel-font rounded-md px-2 py-0.5 text-[15px] tabular-nums"
          title="Mines left (mines − flags)"
          style={{ background: "#161110", color: "#ff5a4e", boxShadow: "inset 0 1px 4px rgba(0,0,0,.8)" }}
        >
          🚩 {led3(minesLeft)}
        </span>
        <button
          className="btn !p-0 text-[20px] leading-none"
          style={{ width: 40, height: 40 }}
          onClick={() => reset()}
          aria-label="New game"
          title="New game"
        >
          {face}
        </button>
        <span
          className="pixel-font rounded-md px-2 py-0.5 text-[15px] tabular-nums"
          title="Seconds elapsed"
          style={{ background: "#161110", color: "#ff5a4e", boxShadow: "inset 0 1px 4px rgba(0,0,0,.8)" }}
        >
          ⏱ {pad3(g.elapsed)}
        </span>
      </div>

      {/* difficulty + question-mark toggle */}
      <div className="flex flex-wrap items-center justify-center gap-2">
        <div className="seg seg-compact" role="group" aria-label="Difficulty">
          {DIFFS.map((df) => (
            <button key={df.id} data-on={d.id === df.id} onClick={() => reset(df)} title={`${df.cols}×${df.rows}, ${df.mines} mines`}>
              {df.label}
            </button>
          ))}
        </div>
        <button
          className="btn btn-sm"
          data-on={questions}
          onClick={() => setQuestions((q) => !q)}
          title="Cycle flags to '?' marks before clearing them"
          aria-pressed={questions}
        >
          ? marks {questions ? "on" : "off"}
        </button>
      </div>

      {/* board — scrolls horizontally for Expert */}
      <div className="scroll min-h-0 w-full flex-1 overflow-auto">
        <div className="mx-auto w-fit p-1">
          <div
            className="relative select-none rounded-lg"
            role="grid"
            aria-label={`Minesweeper board — ${d.cols} by ${d.rows}, ${d.mines} mines`}
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${d.cols}, ${d.cell}px)`,
              gap: 2,
              padding: 6,
              background: th.dark ? th.ramp[1] : th.ramp[3],
              border: `2px solid ${th.ramp[1]}`,
              boxShadow: `inset 1.5px 1.5px 0 ${hiddenShadow}, inset -1.5px -1.5px 0 ${hiddenLight}`,
              touchAction: "manipulation",
            }}
            onPointerDown={() => playable && setOoh(true)}
            onPointerUp={() => setOoh(false)}
            onPointerLeave={() => {
              setOoh(false);
              clearPress();
            }}
            onPointerCancel={() => {
              setOoh(false);
              clearPress();
            }}
            onContextMenu={(e) => e.preventDefault()}
          >
            {g.cells.map((c, i) => {
              const num = c.revealed && !c.mine && c.adj > 0;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => onCellClick(i)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onCellContext(i);
                  }}
                  onPointerDown={(e) => onCellPointerDown(i, e)}
                  onPointerUp={clearPress}
                  aria-label={c.revealed ? (c.mine ? "mine" : `revealed, ${c.adj}`) : c.mark === "flag" ? "flagged" : c.mark === "question" ? "questioned" : "hidden"}
                  className="grid place-items-center"
                  style={{
                    ...cellStyle(c),
                    position: "relative",
                    width: d.cell,
                    height: d.cell,
                    padding: 0,
                    cursor: playable && (!c.revealed || c.adj > 0) ? "pointer" : "default",
                    transition: "filter .12s ease",
                    filter: !c.revealed && playable ? "brightness(1)" : undefined,
                  }}
                  onMouseEnter={(e) => {
                    if (!c.revealed && playable) e.currentTarget.style.filter = "brightness(1.12)";
                  }}
                  onMouseLeave={(e) => {
                    if (!c.revealed) e.currentTarget.style.filter = "brightness(1)";
                  }}
                >
                  {c.wrong && (
                    <span aria-hidden className="absolute" style={{ fontSize: d.cell * 0.62, color: "#c9413c", zIndex: 2 }}>
                      ✖
                    </span>
                  )}
                  {c.revealed && c.mine ? (
                    <span aria-hidden style={{ fontSize: d.cell * 0.58, lineHeight: 1 }}>
                      💣
                    </span>
                  ) : c.revealed && num ? (
                    <span className="pixel-font" style={{ color: NUM_COLORS[c.adj], fontSize: d.cell * 0.55, lineHeight: 1 }}>
                      {c.adj}
                    </span>
                  ) : c.mark === "flag" ? (
                    <span aria-hidden style={{ fontSize: d.cell * 0.55, lineHeight: 1 }}>
                      🚩
                    </span>
                  ) : c.mark === "question" ? (
                    <span className="pixel-font" style={{ color: th.dim, fontSize: d.cell * 0.55, lineHeight: 1 }}>
                      ?
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="pixel-font text-center text-[11px]" style={{ color: "var(--dim)" }}>
        click reveal · right-click / long-press flag · click a satisfied number to chord
      </div>
    </div>
  );
}
