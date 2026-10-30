
import { useCallback, useEffect, useRef, useState } from "react";
import type { GameComponentProps } from "@/components/games/GameShell";
import { useStore } from "@/lib/store";

// ---- 2048: 4x4 sliding-tile puzzle. Tiles are absolutely positioned divs with
// stable ids so CSS transitions animate the slide; merges pop via keyframes.
// Real one-step undo (button + Ctrl+Z), swipe + arrow input, a persistent best
// score (same arcade store every game uses) and a proper game-over overlay
// with restart / bank-score — no move ends the run until you bank it.

const SIZE = 4;

type Tile = { id: number; r: number; c: number; v: number; merged: boolean; fresh: boolean; dying: boolean };
type Dir = { dr: number; dc: number };
type Snapshot = { tiles: Tile[]; score: number };

const DIRS: Record<string, Dir> = {
  ArrowLeft: { dr: 0, dc: -1 },
  ArrowRight: { dr: 0, dc: 1 },
  ArrowUp: { dr: -1, dc: 0 },
  ArrowDown: { dr: 1, dc: 0 },
};

function spawnTile(tiles: Tile[], id: number): Tile | null {
  const occ = new Set(tiles.filter((t) => !t.dying).map((t) => t.r * SIZE + t.c));
  const free: number[] = [];
  for (let i = 0; i < SIZE * SIZE; i++) if (!occ.has(i)) free.push(i);
  if (!free.length) return null;
  const i = free[Math.floor(Math.random() * free.length)];
  return { id, r: Math.floor(i / SIZE), c: i % SIZE, v: Math.random() < 0.9 ? 2 : 4, merged: false, fresh: true, dying: false };
}

function newGameTiles(): Tile[] {
  const tiles: Tile[] = [];
  let id = 1;
  const a = spawnTile(tiles, id++);
  if (a) tiles.push(a);
  const b = spawnTile(tiles, id++);
  if (b) tiles.push(b);
  return tiles;
}

/** Pure-ish: mutates the (already copied) tiles; returns move outcome. */
function applyMove(tiles: Tile[], dir: Dir): { moved: boolean; gained: number; merged: boolean } {
  for (const t of tiles) {
    t.merged = false;
    t.fresh = false;
  }
  const horizontal = dir.dc !== 0;
  const forward = horizontal ? dir.dc : dir.dr;
  const step = forward < 0 ? 1 : -1;
  let moved = false;
  let gained = 0;
  let merged = false;
  for (let k = 0; k < SIZE; k++) {
    const line = tiles
      .filter((t) => !t.dying && (horizontal ? t.r === k : t.c === k))
      .sort((a, b) => {
        const av = horizontal ? a.c : a.r;
        const bv = horizontal ? b.c : b.r;
        return forward < 0 ? av - bv : bv - av;
      });
    let pos = forward < 0 ? 0 : SIZE - 1;
    let last: Tile | null = null;
    for (const t of line) {
      if (last && last.v === t.v && !last.merged) {
        last.v *= 2;
        last.merged = true;
        gained += last.v;
        merged = true;
        moved = true;
        t.r = last.r;
        t.c = last.c;
        t.dying = true;
      } else {
        if (horizontal) {
          if (t.c !== pos) moved = true;
          t.c = pos;
        } else {
          if (t.r !== pos) moved = true;
          t.r = pos;
        }
        pos += step;
        last = t;
      }
    }
  }
  return { moved, gained, merged };
}

function canMove(tiles: Tile[]): boolean {
  const alive = tiles.filter((t) => !t.dying);
  if (alive.length < SIZE * SIZE) return true;
  const grid: number[][] = [...Array(SIZE)].map(() => Array(SIZE).fill(0));
  for (const t of alive) grid[t.r][t.c] = t.v;
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++) {
      const v = grid[r][c];
      if (!v) continue;
      if (c + 1 < SIZE && grid[r][c + 1] === v) return true;
      if (r + 1 < SIZE && grid[r + 1][c] === v) return true;
    }
  return false;
}

/** Tile colours escalate through the accent via color-mix. */
function tileLook(v: number): { background: string; color: string; border: string; fontSize: number } {
  const e = Math.max(1, Math.round(Math.log2(Math.max(2, v))));
  const t = Math.min(1, (e - 1) / 10); // 2 -> 0 ... 2048 -> 1
  return {
    background: `color-mix(in srgb, var(--accent) ${Math.round(12 + t * 88)}%, var(--panel-solid))`,
    color: t > 0.55 ? "var(--accent-ink)" : "var(--ink)",
    border: `1px solid color-mix(in srgb, var(--accent) ${Math.round(28 + t * 62)}%, var(--line))`,
    fontSize: v >= 4096 ? 21 : v >= 1024 ? 24 : 28,
  };
}

export default function Game2048({ running, onEnd, play }: GameComponentProps) {
  const [tiles, setTiles] = useState<Tile[]>(newGameTiles);
  const [score, setScore] = useState(0);
  const [over, setOver] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const best = useStore((s) => s.gameScores["g2048"] ?? 0);
  const scoreRef = useRef(0);
  const idRef = useRef(1);
  const finishedRef = useRef(false);
  const undoRef = useRef<Snapshot | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swipeRef = useRef<{ x: number; y: number; id: number } | null>(null);
  const live = useRef({ running, onEnd, play });
  // keep latest props reachable from handlers without re-subscribing
  useEffect(() => {
    live.current = { running, onEnd, play };
  });

  const maxTile = tiles.reduce((m, t) => (t.dying ? m : Math.max(m, t.v)), 0);

  const clearUndo = useCallback(() => {
    undoRef.current = null;
    setCanUndo(false);
  }, []);

  const restartBoard = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setTiles(newGameTiles());
    setScore(0);
    setOver(false);
    scoreRef.current = 0;
    clearUndo();
    live.current.play("start");
  }, [clearUndo]);

  const undo = useCallback(() => {
    const L = live.current;
    const snap = undoRef.current;
    if (!snap || !L.running || finishedRef.current) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    undoRef.current = null;
    setCanUndo(false);
    setTiles(snap.tiles.map((t) => ({ ...t, merged: false, fresh: false, dying: false })));
    scoreRef.current = snap.score;
    setScore(snap.score);
    setOver(false);
    L.play("receive");
  }, []);

  const bankScore = useCallback(() => {
    const L = live.current;
    if (finishedRef.current) return;
    finishedRef.current = true;
    setOver(false);
    L.onEnd(scoreRef.current);
  }, []);

  // reset when a fresh run begins; clear pending timers on unmount
  // (state updates are deferred out of the effect body to avoid cascading renders)
  const prevRun = useRef(running);
  useEffect(() => {
    if (running && !prevRun.current) {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        setTiles(newGameTiles());
        setScore(0);
        setOver(false);
        scoreRef.current = 0;
        idRef.current = 1;
        finishedRef.current = false;
        clearUndo();
      }, 0);
    }
    prevRun.current = running;
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [running, clearUndo]);

  const doMove = useCallback(
    (dir: Dir) => {
      const L = live.current;
      if (!L.running || finishedRef.current || over) return;
      const next = tiles.map((t) => ({ ...t }));
      const res = applyMove(next, dir);
      if (!res.moved) {
        L.play("tick");
        return;
      }
      // one-step undo: snapshot the pre-move board
      undoRef.current = { tiles: tiles.filter((t) => !t.dying).map((t) => ({ ...t })), score: scoreRef.current };
      setCanUndo(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      const nt = spawnTile(next, idRef.current++);
      if (nt) next.push(nt);
      if (res.merged) L.play(res.gained >= 128 ? "star" : "pop");
      else L.play("move");
      scoreRef.current += res.gained;
      setTiles(next);
      setScore(scoreRef.current);
      // retire merged-away tiles after their slide finishes
      timerRef.current = setTimeout(() => setTiles((ts) => ts.filter((t) => !t.dying)), 170);
      if (!canMove(next)) {
        setOver(true);
        L.play("sad");
      }
    },
    [tiles, over],
  );

  // arrow keys + Ctrl+Z — attached only while running
  useEffect(() => {
    if (!running) return;
    const kd = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
        return;
      }
      if (e.key.startsWith("Arrow") || e.key === " ") e.preventDefault();
      const dir = DIRS[e.key];
      if (dir) doMove(dir);
    };
    window.addEventListener("keydown", kd);
    return () => window.removeEventListener("keydown", kd);
  }, [running, doMove, undo]);

  return (
    <div className="grid h-full w-full place-items-center p-2">
      <div className="flex w-[min(340px,100%,62vh)] flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-1.5 pixel-font text-[13px]">
          <span className="chip">SCORE {score}</span>
          <span className="chip" style={score > best ? { color: "var(--accent)", borderColor: "var(--accent)" } : undefined}>
            BEST {Math.max(best, score)}
          </span>
          <span className="chip" style={maxTile >= 128 ? { color: "var(--accent)", borderColor: "var(--accent)" } : undefined}>
            TOP {maxTile}
          </span>
          <button
            className="btn btn-sm"
            disabled={!canUndo}
            onClick={undo}
            title="Undo one move (Ctrl+Z)"
            aria-label="Undo one move"
          >
            ↩ undo
          </button>
        </div>

        <div
          className="relative aspect-square w-full select-none rounded-2xl"
          style={{ background: "var(--panel2)", border: "1px solid var(--line)", touchAction: "none" }}
          role="grid"
          aria-label="2048 board"
          onPointerDown={(e) => {
            swipeRef.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
          }}
          onPointerUp={(e) => {
            const s = swipeRef.current;
            if (!s || s.id !== e.pointerId) return;
            swipeRef.current = null;
            const dx = e.clientX - s.x;
            const dy = e.clientY - s.y;
            const ax = Math.abs(dx);
            const ay = Math.abs(dy);
            if (Math.max(ax, ay) < 24) return;
            doMove(ax > ay ? { dr: 0, dc: dx > 0 ? 1 : -1 } : { dr: dy > 0 ? 1 : -1, dc: 0 });
          }}
          onPointerCancel={() => {
            swipeRef.current = null;
          }}
        >
          {/* empty cells */}
          {[...Array(SIZE * SIZE)].map((_, i) => (
            <div
              key={`cell-${i}`}
              aria-hidden="true"
              className="absolute"
              style={{ left: `${(i % SIZE) * 25}%`, top: `${Math.floor(i / SIZE) * 25}%`, width: "25%", height: "25%", padding: 4 }}
            >
              <div className="h-full w-full rounded-lg" style={{ background: "color-mix(in srgb, var(--ink) 7%, transparent)" }} />
            </div>
          ))}

          {/* tiles */}
          {tiles.map((t) => {
            const look = tileLook(t.v);
            const big = t.merged && t.v >= 128;
            return (
              <div
                key={t.id}
                className="absolute"
                style={{
                  left: `${t.c * 25}%`,
                  top: `${t.r * 25}%`,
                  width: "25%",
                  height: "25%",
                  padding: 4,
                  zIndex: t.dying ? 1 : t.merged ? 3 : 2,
                  transition: "left .13s ease, top .13s ease",
                  pointerEvents: "none",
                }}
              >
                <div
                  key={`${t.id}:${t.v}`}
                  className="pixel-font grid h-full w-full place-items-center rounded-lg"
                  style={{
                    background: look.background,
                    color: look.color,
                    border: look.border,
                    fontSize: look.fontSize,
                    animation: t.fresh ? "pop .18s ease .09s both" : t.merged ? "pop .22s ease both" : undefined,
                    boxShadow: t.merged
                      ? `0 0 ${big ? 22 : 14}px color-mix(in srgb, var(--accent) ${big ? 65 : 45}%, transparent)`
                      : undefined,
                  }}
                >
                  {t.v}
                </div>
              </div>
            );
          })}

          {/* game over — restart keeps the run alive, banking records the score */}
          {over && (
            <div
              className="absolute inset-0 grid place-items-center rounded-2xl"
              style={{ background: "color-mix(in srgb, var(--bg) 66%, transparent)", animation: "fade .25s ease both" }}
            >
              <div className="text-center">
                <div className="pixel-font text-[18px]">No moves left</div>
                <div className="pixel-font mt-1 text-[13px] text-dim">score {score}</div>
                <div className="mt-3 flex items-center justify-center gap-2">
                  <button className="btn btn-accent btn-sm" onClick={restartBoard}>
                    Restart board
                  </button>
                  <button className="btn btn-sm" onClick={bankScore}>
                    Bank score
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="pixel-font text-center text-[11px]" style={{ color: "var(--dim)" }}>
          arrows / swipe slide · equal tiles merge · ctrl+z undoes one move
        </div>
      </div>
    </div>
  );
}
