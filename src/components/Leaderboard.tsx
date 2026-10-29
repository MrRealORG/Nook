"use client";

import { useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/icons";
import { PetView } from "@/components/PetView";
import { levelOf } from "@/lib/pet";
import type { Species } from "@/lib/types";
import { useStore } from "@/lib/store";

export type RoomBoard = Record<string, { name: string; score: number; at: number }[]>;

const MEDALS = ["#ffd166", "#c8cbd4", "#d78a5c"];
const GAME_LABELS: Record<string, string> = {
  catch: "Catch the Notes", snake: "Pixel Snake", flappy: "Flappy Pet", breakout: "Breakout",
  memory: "Memory Match", whack: "Whack-a-Note", reaction: "Reaction Test", simon: "Simon Says",
  shooter: "Star Defender", g2048: "2048", math: "Math Blitz", blocks: "Falling Blocks",
};

type WallRow = {
  name: string;
  species?: Species;
  best: number; // best single score
  total: number; // sum of bests across games
  games: number;
  me: boolean;
  xp?: number;
  level?: number;
};

/**
 * Wall of fame — ranks everyone in the room (you + every synced teammate/bot)
 * by their synced arcade bests, plus your lifetime XP standing. Shareable.
 */
export function Leaderboard({ board, compact }: { board: RoomBoard; compact?: boolean }) {
  const pet = useStore((s) => s.pet);
  const myName = useStore((s) => s.profile.displayName || s.pet.name);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const rows = useMemo<WallRow[]>(() => {
    const agg = new Map<string, WallRow>();
    for (const entries of Object.values(board)) {
      for (const e of entries) {
        const key = e.name;
        const row = agg.get(key) ?? { name: key, best: 0, total: 0, games: 0, me: false };
        row.best = Math.max(row.best, e.score);
        row.total += e.score;
        row.games += 1;
        agg.set(key, row);
      }
    }
    const lvl = levelOf(pet.xp);
    const me: WallRow = {
      name: myName,
      species: pet.species,
      best: Math.max(0, ...Object.values(useStore.getState().gameScores)),
      total: Object.values(useStore.getState().gameScores).reduce((a, b) => a + b, 0),
      games: Object.values(useStore.getState().gameScores).filter((v) => v > 0).length,
      me: true,
      xp: pet.xp,
      level: lvl.level,
    };
    const mine = agg.get(myName);
    if (mine) {
      me.best = Math.max(me.best, mine.best);
      me.total = Math.max(me.total, mine.total);
      me.games = Math.max(me.games, mine.games);
    }
    agg.delete(myName);
    return [...agg.values(), me].sort((a, b) => b.total - a.total || b.best - a.best).slice(0, compact ? 5 : 20);
  }, [board, myName, pet.species, pet.xp, compact]);

  const myRank = rows.findIndex((r) => r.me) + 1;

  const share = async () => {
    const lines = [
      `🏆 Nook Wall of Fame`,
      ...rows.map((r, i) => `${i + 1}. ${r.name}${r.level ? ` (Lv ${r.level})` : ""} — ${r.total} pts across ${r.games} game${r.games === 1 ? "" : "s"} · best ${r.best}`),
      `— shared from Nook workspace`,
    ];
    try {
      await navigator.clipboard?.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {}
  };

  const maxTotal = Math.max(1, ...rows.map((r) => r.total));

  return (
    <div className={compact ? "" : "panel p-3"}>
      <div className="mb-2 flex items-center gap-2">
        <Icon name="trophy" size={14} className="text-accent" />
        <span className="label">{compact ? "Wall of fame" : "Wall of fame — room leaderboard"}</span>
        {!compact && myRank > 0 && <span className="chip !py-0 !text-[10px]" data-on={myRank === 1}>you: #{myRank}</span>}
        <div className="flex-1" />
        {!compact && (
          <button className="icon-btn !h-6 !w-6" onClick={() => setExpanded((v) => !v)} title={expanded ? "Collapse" : "Per-game top scores"} aria-label="Toggle per-game scores">
            <Icon name={expanded ? "chevron-up" : "chevron-down"} size={12} />
          </button>
        )}
        <button className="icon-btn !h-6 !w-6" onClick={() => void share()} title="Copy the wall of fame (markdown) — share it anywhere" aria-label="Share leaderboard">
          <Icon name={copied ? "check" : "external-link"} size={12} style={copied ? { color: "#7fc48f" } : undefined} />
        </button>
      </div>
      <div className="flex flex-col gap-1">
        {rows.map((r, i) => (
          <div
            key={r.name}
            className="flex items-center gap-2 rounded-lg px-1.5 py-1"
            style={{ background: r.me ? "var(--hl)" : i < 3 ? "color-mix(in srgb, var(--panel2) 80%, transparent)" : undefined }}
          >
            <span className="w-5 flex-none text-center" style={{ color: i < 3 ? MEDALS[i] : "var(--faint)" }}>
              {i < 3 ? <Icon name="crown" size={13} /> : <span className="pixel-font text-[11px]">{i + 1}</span>}
            </span>
            {r.species ? (
              <span className="grid h-7 w-7 flex-none place-items-end justify-center overflow-hidden rounded-md border border-line">
                <PetView species={r.species} scale={0.72} fps={6} style={{ marginBottom: -2 }} />
              </span>
            ) : (
              <span className="grid h-7 w-7 flex-none place-items-center rounded-md border border-line bg-panel2 text-[10px] text-dim">{r.name.slice(0, 2).toUpperCase()}</span>
            )}
            <span className="min-w-0 flex-1">
              <span className="pixel-font block truncate text-[12.5px] leading-tight">
                {r.name} {r.me && <span className="tiny-font text-[9px] text-accent">(you)</span>}
              </span>
              <span className="mt-0.5 flex h-[4px] w-full overflow-hidden rounded-sm bg-panel2">
                <i className="block h-full rounded-sm transition-all duration-700" style={{ width: `${(r.total / maxTotal) * 100}%`, background: r.me ? "var(--accent)" : "color-mix(in srgb, var(--accent) 45%, transparent)" }} />
              </span>
            </span>
            <span className="flex-none text-right leading-tight">
              <span className="pixel-font block text-[12px] text-ink">{r.total.toLocaleString()}</span>
              <span className="tiny-font block text-[9px] text-faint">{r.level ? `Lv ${r.level} · ` : ""}{r.games} game{r.games === 1 ? "" : "s"}</span>
            </span>
          </div>
        ))}
        {rows.length === 0 && (
          <div className="flex items-center gap-2 py-2 text-[12px] text-faint">
            <Icon name="gamepad" size={14} /> Sync your arcade bests (or just play) to appear on the wall.
          </div>
        )}
      </div>
      {expanded && !compact && (
        <div className="mt-3 space-y-2 border-t border-line pt-2">
          {Object.entries(board)
            .filter(([, entries]) => entries.length > 0)
            .sort((a, b) => Math.max(...b[1].map((e) => e.score)) - Math.max(...a[1].map((e) => e.score)))
            .slice(0, 8)
            .map(([gid, entries]) => {
              const top = [...entries].sort((a, b) => b.score - a.score).slice(0, 3);
              return (
                <div key={gid} className="text-[11.5px]">
                  <span className="pixel-font text-[11px] text-dim">{GAME_LABELS[gid] ?? gid}</span>
                  <span className="ml-2 text-faint">
                    {top.map((e, i) => (
                      <span key={e.name + i} style={i === 0 ? { color: MEDALS[0] } : undefined}>
                        {i > 0 && " · "}
                        {e.name} {e.score}
                      </span>
                    ))}
                  </span>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
