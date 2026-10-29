"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/icons";
import { flyCoins } from "@/lib/coinFly";
import { masteryBonus, masteryOf } from "@/lib/mastery";
import { useStore } from "@/lib/store";
import { sfx } from "@/lib/sfx";
import { clamp } from "@/lib/util";

export type GameComponentProps = {
  /** true while the game is running */
  running: boolean;
  /** call once when the run ends, with the final score */
  onEnd: (score: number) => void;
  /** call for sound effects during play */
  play: (name: Parameters<typeof sfx>[0]) => void;
};

export type GameDef = {
  id: string;
  title: string;
  icon: IconName;
  blurb: string;
  controls: string;
  /** one-line coaching hint shown on the start & game-over screens */
  tip?: string;
  accent?: string;
  Component: (props: GameComponentProps) => ReactNode;
};

export function GameShell({ def }: { def: GameDef }) {
  const [phase, setPhase] = useState<"idle" | "play" | "over">("idle");
  const [result, setResult] = useState({ score: 0, coins: 0, record: false, margin: 0, mUp: null as null | { level: number; tier: string; color: string; bonus: number } });
  const best = useStore((s) => s.gameScores[def.id] ?? 0);
  const gameXp = useStore((s) => s.gameStats[def.id]?.xp ?? 0);
  const m = masteryOf(gameXp);
  const pet = useStore((s) => s.pet);
  const games = pet.stats.games;
  const [runKey, setRunKey] = useState(0);

  const start = useCallback(() => {
    sfx("start");
    setResult({ score: 0, coins: 0, record: false, margin: 0, mUp: null });
    setRunKey((k) => k + 1);
    setPhase("play");
  }, []);

  const onEnd = useCallback(
    (score: number) => {
      const st = useStore.getState();
      const prevBest = st.gameScores[def.id] ?? 0;
      const record = score > prevBest;
      const coins = Math.max(1, Math.floor(score / 2));
      st.patchPet((p) => ({
        ...p,
        coins: p.coins + coins,
        xp: p.xp + score,
        joy: clamp(p.joy + 10, 0, 100),
        stats: { ...p.stats, games: p.stats.games + 1, best: Math.max(p.stats.best, score) },
      }));
      st.set({ gameScores: { ...st.gameScores, [def.id]: Math.max(prevBest, score) } });
      // arcade stats center: plays / total xp / last played
      const gs = st.gameStats[def.id] ?? { plays: 0, xp: 0, last: 0 };
      const stats: Record<string, { plays: number; xp: number; last: number }> = {
        ...st.gameStats,
        [def.id]: { plays: gs.plays + 1, xp: gs.xp + score, last: Date.now() },
      };
      // mastery: did this run push the game into a new tier?
      const mBefore = masteryOf(gs.xp);
      const mAfter = masteryOf(gs.xp + score);
      const mUp: { level: number; tier: string; color: string; bonus: number } | null =
        mAfter.level > mBefore.level ? { level: mAfter.level, tier: mAfter.tier, color: mAfter.color, bonus: masteryBonus(mAfter.level) } : null;
      // trend history: last 12 scores, oldest → newest (sparklines in stats center)
      const runs: Record<string, number[]> = { ...st.gameRuns, [def.id]: [...(st.gameRuns[def.id] ?? []), score].slice(-12) };
      st.set({ gameStats: stats, gameRuns: runs });
      flyCoins(coins + (mUp?.bonus ?? 0));
      if (mUp) {
        st.patchPet((p) => ({ ...p, coins: p.coins + mUp.bonus }));
        sfx("evolve");
        st.toast(`${def.title} mastery up — ${mUp.tier} L${mUp.level} · +${mUp.bonus} coins`, "star");
        st.notify(`${def.title} mastery reached ${mUp.tier} (L${mUp.level}) — +${mUp.bonus} bonus coins`, "star", "achievement");
        st.say(`I'm getting seriously good at ${def.title}!`);
        if (mUp.level >= 3) st.unlock("mastery-3", "Seasoned Player", "Any game reached Veteran mastery", "star");
        if (mUp.level >= 5) st.unlock("mastery-5", "Arcade Master", "Any game reached Master mastery", "crown");
      }
      const totalPlays = Object.values(stats).reduce((a, b) => a + b.plays, 0);
      if (totalPlays >= 25) st.unlock("plays-25", "Arcade Regular", "Played 25 arcade rounds", "gamepad");
      const scored = Object.values(st.gameScores).filter((v) => v > 0).length;
      if (scored >= 5) st.unlock("arcade-star", "Arcade Star", "Set a record in 5 different games", "trophy");
      st.questProgress("games");
      if (record && score > 0) {
        const margin = score - prevBest;
        st.say(`New ${def.title} record! ${score} points!`, undefined, 3600);
        st.notify(`New ${def.title} record — ${score} pts (+${margin} over your best)`, "trophy", "achievement");
        if (Object.values(st.gameScores).filter((v) => v > 0).length >= 10) st.unlock("arcade-legend", "Arcade Legend", "Set a record in 10 different games", "crown");
      }
      sfx(score >= 10 ? "win" : "gameover");
      st.doAct(coins > 3 ? "happy" : "idle", 2500);
      setResult({ score, coins: coins + (mUp?.bonus ?? 0), record, margin: record ? score - prevBest : 0, mUp });
      setPhase("over");
    },
    [def.id, def.title],
  );

  const play = useCallback((name: Parameters<typeof sfx>[0]) => sfx(name), []);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="pixel-font flex items-center gap-2 text-[19px]">
          <span className="game-icon" style={{ width: 34, height: 34 }}>
            <Icon name={def.icon} size={18} />
          </span>
          {def.title}
        </div>
        <span className="chip">{def.blurb}</span>
        {m.level > 0 && (
          <span className="mastery-chip" style={{ color: m.color }} title={`${m.tier} mastery — ${m.next != null ? `${m.pct}% to the next tier` : "maxed out"}`}>
            <Icon name="star" size={11} /> L{m.level} {m.tier}
          </span>
        )}
        <div className="flex-1" />
        <span className="hud-pill text-dim">
          <Icon name="trophy" size={13} className="text-accent" /> {best}
        </span>
        <span className="hud-pill text-dim">
          <Icon name="coins" size={13} className="text-accent" /> {pet.coins}
        </span>
        <span className="hud-pill hidden text-dim sm:inline-flex">{games} played</span>
      </div>

      <div className="paper relative min-h-0 flex-1 overflow-hidden">
        <div className={phase === "play" ? "pointer-events-auto absolute inset-0" : "pointer-events-none absolute inset-0 opacity-0"}>
          <def.Component key={runKey} running={phase === "play"} onEnd={onEnd} play={play} />
        </div>
        {phase !== "play" && (
          <div className="absolute inset-0 grid place-items-center overflow-y-auto p-4 text-center" style={{ animation: "pop .25s ease both" }}>
            <div className="max-w-[420px]">
              <div className="game-icon mx-auto mb-3" style={{ width: 56, height: 56 }}>
                <Icon name={def.icon} size={28} />
              </div>
              <div className="pixel-font text-[22px]">{phase === "over" ? (result.record ? "New record!" : "Game over") : def.title}</div>
              {phase === "over" ? (
                <div className="pixel-font mt-2 text-[16px] text-dim">
                  Score {result.score} · <span className="text-accent">+{result.coins} coins</span> · +{result.score} XP
                </div>
              ) : (
                <div className="mt-2 text-[13px] leading-relaxed text-dim">{def.controls}</div>
              )}
              {phase === "over" && result.record && result.score > 0 && (
                <div
                  className="record-banner mt-2 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1"
                  style={{ animation: "pop .35s var(--ease-soft) both .15s" }}
                >
                  <Icon name="trophy" size={12} className="text-accent" />
                  <span className="text-[12px] text-dim">beat your old best by {result.margin}</span>
                </div>
              )}
              {phase === "over" && result.mUp && (
                <div
                  className="mastery-up mt-2 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1"
                  style={{ color: result.mUp.color, animation: "pop .4s var(--ease-soft) both .3s" }}
                >
                  <Icon name="star" size={12} />
                  <span className="pixel-font text-[11px] tracking-wide uppercase">
                    mastery {result.mUp.tier} · L{result.mUp.level} · +{result.mUp.bonus} coins
                  </span>
                </div>
              )}
              {def.tip && (
                <div className="tip-chip mt-3 inline-flex max-w-full items-start gap-1.5 rounded-lg px-2.5 py-1.5 text-left" style={{ animation: "rise .4s var(--ease-soft) both .1s" }}>
                  <Icon name="lightbulb" size={13} className="mt-px flex-none text-accent" />
                  <span className="text-[12px] leading-snug text-dim">
                    <span className="tiny-font mr-1 uppercase tracking-wider text-accent">pro tip</span> {def.tip}
                  </span>
                </div>
              )}
              <div>
                <button className="btn btn-accent mt-4" onClick={start}>
                  <Icon name="play" size={14} /> {phase === "over" ? "Play again" : "Start"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
