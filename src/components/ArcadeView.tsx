
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/icons";
import { CatchGame } from "@/components/games/CatchGame";
import { GameShell, type GameComponentProps, type GameDef } from "@/components/games/GameShell";
import { ENGINE_META, DEFAULT_PARAMS, engineBlurb, gameFromDef, packFromDefs, parseGamePack, validateGameDef, type CustomGameDef, type EngineId, type GameParams } from "@/lib/gameEngines";
import { masteryOf } from "@/lib/mastery";
import { useStore } from "@/lib/store";
import { sfx } from "@/lib/sfx";
import { timeAgo, uid } from "@/lib/util";

type GameEntry = {
  id: string;
  title: string;
  icon: IconName;
  blurb: string;
  controls: string;
  tip: string;
  load: () => Promise<{ default: (props: GameComponentProps) => React.ReactNode }>;
  custom?: CustomGameDef;
};

const ENTRIES: GameEntry[] = [
  { id: "catch", title: "Catch the Notes", icon: "note", blurb: "Classic", controls: "Move with the mouse or ← →. Catch notes (+1) and stars (+3). Dodge the bugs! 40 seconds.", tip: "Stars are worth 3× a note — sweep side to side under them instead of chasing every note.", load: async () => ({ default: CatchGame }) },
  { id: "minesweeper", title: "Minesweeper", icon: "grid", blurb: "Real classics", controls: "Left-click to reveal, right-click (or long-press on touch) to flag. Click a revealed number whose flags match to chord. Clear every safe cell — first click is always safe!", tip: "Open corners and edges first, and never place a flag until the number above it is fully accounted for.", load: () => import("@/components/games/MinesweeperGame") },
  { id: "snake", title: "Pixel Snake", icon: "arrow-right", blurb: "Classic", controls: "Arrow keys or WASD to steer. Eat berries to grow — rocks appear from level 4! SPACE pauses. Toggle walls vs wrap edges and pick a speed above the board.", tip: "Hug the walls in a spiral — you only get trapped if you fill the middle first.", load: () => import("@/components/games/SnakeGame") },
  { id: "flappy", title: "Flappy Pet", icon: "arrow-up", blurb: "Arcade", controls: "Click / tap / press Space to flap. Fly through the gaps. One hit ends the run.", tip: "Tap in a steady rhythm and aim for the middle of each gap — panic-flapping is the #1 killer.", load: () => import("@/components/games/FlappyGame") },
  { id: "breakout", title: "Breakout", icon: "shapes", blurb: "Classic", controls: "Mouse or ← → to move the paddle. Three levels, powerups (W wide, S slow, + life) and 3 lives. SPACE/P pauses!", tip: "Hit the ball with the edge of the paddle to steepen its angle — great for reaching corner bricks.", load: () => import("@/components/games/BreakoutGame") },
  { id: "memory", title: "Memory Match", icon: "copy", blurb: "Puzzle", controls: "Click cards to flip them. Match all pairs in as few moves as possible.", tip: "Always re-flip the card you saw most recently — pairs are usually revealed one flip apart.", load: () => import("@/components/games/MemoryGame") },
  { id: "whack", title: "Whack-a-Note", icon: "pointer", blurb: "Reflex", controls: "Click the notes as they pop up. Avoid the bugs. 30 seconds of mayhem!", tip: "Park your cursor near the center — the notes cluster there and you'll waste less travel time.", load: () => import("@/components/games/WhackGame") },
  { id: "reaction", title: "Reaction Test", icon: "zap", blurb: "Reflex", controls: "Wait for GREEN, then click as fast as you can. 5 rounds. Lower ms is better.", tip: "Breathe out and stay loose — anticipating the green adds a false-start penalty.", load: () => import("@/components/games/ReactionGame") },
  { id: "simon", title: "Simon Says", icon: "lightbulb", blurb: "Memory", controls: "Watch the pattern, repeat it. Each round adds one more step. How far can you go?", tip: "Narrate the colors out loud (or in your head) — verbal cues survive longer than visual ones.", load: () => import("@/components/games/SimonGame") },
  { id: "shooter", title: "Star Defender", icon: "star", blurb: "Arcade", controls: "← → or mouse to move, Space / click to shoot. Blast the descending bug squad!", tip: "Hold fire constantly and aim by positioning — your shots form a column, so stand under the bug.", load: () => import("@/components/games/ShooterGame") },
  { id: "g2048", title: "2048", icon: "hash", blurb: "Puzzle", controls: "Arrows or swipe to slide tiles and merge equal numbers. One-step undo (Ctrl+Z). Stuck? Restart the board or bank your score.", tip: "Pick one corner and never press the key that pulls your big tile out of it.", load: () => import("@/components/games/Game2048") },
  { id: "math", title: "Math Blitz", icon: "algorithm", blurb: "Brain", controls: "Pick the right answer before the timer runs out. Streaks multiply your score!", tip: "Guard the streak: a wrong answer costs more than a slow right one. Skip-hesitate, never guess.", load: () => import("@/components/games/MathGame") },
  { id: "blocks", title: "Falling Blocks", icon: "app-windows", blurb: "Classic", controls: "← → move, ↑ rotate, ↓ soft drop. Clear lines before the stack reaches the top!", tip: "Keep the stack flat and save the I-piece for a 4-line clear — that's where the big points live.", load: () => import("@/components/games/BlocksGame") },
];

const MEDALS = ["#ffd166", "#c8cbd4", "#d78a5c"];

/** category filter derived from the blurb field — every game tags itself */
const CATEGORIES = ["All", "Classic", "Real classics", "Arcade", "Puzzle", "Reflex", "Memory", "Brain"] as const;
const CAT_ICONS: Record<string, IconName> = { All: "app-windows", Classic: "gamepad", "Real classics": "shield", Arcade: "target", Puzzle: "shapes", Reflex: "zap", Memory: "lightbulb", Brain: "algorithm" };
/** per-category accent — tints the cards so the grid reads like a real arcade wall */
const CAT_COLORS: Record<string, string> = { All: "var(--accent)", Classic: "#8fb7c9", "Real classics": "#c9b7a0", Arcade: "#e0a05a", Puzzle: "#b59fd0", Reflex: "#e0685f", Memory: "#7fc48f", Brain: "#d9c98a" };

/** mini trend bars for the last runs — last bar glows, arrow compares latest vs previous average */
function Sparkline({ runs }: { runs: number[] }) {
  const shown = runs.slice(-8);
  const max = Math.max(1, ...shown);
  const prev = shown.slice(0, -1);
  const prevAvg = prev.length ? prev.reduce((a, b) => a + b, 0) / prev.length : 0;
  const last = shown[shown.length - 1] ?? 0;
  const up = last > prevAvg * 1.08;
  const down = !up && last < prevAvg * 0.92;
  return (
    <span className="spark-wrap" title={`Last ${shown.length} run${shown.length > 1 ? "s" : ""}: ${shown.join(", ")}`}>
      <span className="spark-bars">
        {shown.map((v, i) => (
          <i key={i} data-last={i === shown.length - 1} style={{ height: `${Math.max(18, (v / max) * 100)}%` }} />
        ))}
      </span>
      {up ? (
        <span className="spark-trend" data-dir="up"><Icon name="arrow-up" size={11} /></span>
      ) : down ? (
        <span className="spark-trend" data-dir="down"><Icon name="arrow-down" size={11} /></span>
      ) : (
        <span className="spark-trend" data-dir="flat"><Icon name="arrow-right" size={11} /></span>
      )}
      <span className="pixel-font text-[9px] text-faint">{last}</span>
    </span>
  );
}

function GameCard({ e, i, best, xp, onPick, onEdit, onDelete }: { e: GameEntry; i: number; best: number; xp: number; onPick: () => void; onEdit?: () => void; onDelete?: () => void }) {
  const m = masteryOf(xp);
  const color = e.custom?.accent ?? CAT_COLORS[e.blurb] ?? "var(--accent)";
  return (
    <div
      className="game-card group cursor-pointer select-none"
      data-played={best > 0}
      style={{ ["--gc" as string]: color, ["--i" as string]: Math.min(i, 12) }}
      onClick={onPick}
      onKeyDown={(ev) => (ev.key === "Enter" || ev.key === " ") && (ev.preventDefault(), onPick())}
      role="button"
      tabIndex={0}
      title={`Pro tip: ${e.tip}`}
    >
      <div className="flex items-center gap-2.5">
        <span className="game-icon" style={{ color, borderColor: `color-mix(in srgb, ${color} 45%, transparent)`, background: `color-mix(in srgb, ${color} 10%, transparent)` }}>
          <Icon name={e.icon} size={20} />
        </span>
        <div className="min-w-0">
          <div className="pixel-font truncate text-[15.5px] leading-tight">{e.title}</div>
          <div className="tiny-font text-[9.5px] uppercase tracking-wider" style={{ color }}>
            {e.custom ? e.custom.origin === "imported" ? "imported" : "made by you" : e.blurb}
          </div>
        </div>
        {e.custom && (
          <span className="ml-auto flex flex-none items-center gap-1">
            {onEdit && <button className="icon-btn !h-6 !w-6" title="Edit in the game maker" onClick={(ev) => { ev.stopPropagation(); onEdit(); }}><Icon name="pencil" size={12} /></button>}
            <button
              className="icon-btn !h-6 !w-6"
              title="Export this game (.json — shareable nook-games pack)"
              onClick={(ev) => {
                ev.stopPropagation();
                const blob = new Blob([JSON.stringify(packFromDefs([e.custom!]), null, 2)], { type: "application/json" });
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = `${e.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.nook-game.json`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 3000);
              }}
            >
              <Icon name="download" size={12} />
            </button>
            {onDelete && <button className="icon-btn !h-6 !w-6" title="Remove from the arcade" onClick={(ev) => { ev.stopPropagation(); onDelete(); }}><Icon name="trash" size={12} /></button>}
          </span>
        )}
        <span className="ml-auto text-faint opacity-0 transition-opacity duration-200 [.game-card:hover_&]:opacity-100" title={`Pro tip: ${e.tip}`}>
          <Icon name="lightbulb" size={13} />
        </span>
      </div>
      {m.level > 0 && (
        <div className="mastery-wrap" title={`${m.tier} mastery · ${m.next != null ? `${xp}/${m.next} XP to next tier` : "max tier reached"}`}>
          <span className="mastery-chip !py-0.5" style={{ color: m.color }}>
            <Icon name="star" size={10} /> L{m.level} {m.tier}
          </span>
          <span className="mastery-bar" aria-hidden>
            <i style={{ width: `${m.pct}%`, background: m.color }} />
          </span>
        </div>
      )}
      <div className="pixel-font mt-1 flex items-center justify-between text-[13px] text-dim">
        <span className="flex items-center gap-1">
          <Icon name="trophy" size={12} style={{ color: best > 0 ? color : undefined }} /> {best > 0 ? best : "\u2014"}
        </span>
        <span className="play-hint tiny-font text-[9px]">PLAY ▸</span>
      </div>
      <i className="card-shine" aria-hidden />
    </div>
  );
}

/** Per-game records, plays, XP and mastery — the arcade stats center. */
function StatsCenter() {
  const scores = useStore((s) => s.gameScores);
  const gameStats = useStore((s) => s.gameStats);
  const gameRuns = useStore((s) => s.gameRuns);
  const pet = useStore((s) => s.pet);
  const rows = useMemo(
    () =>
      ENTRIES.map((e) => ({
        e,
        best: scores[e.id] ?? 0,
        plays: gameStats[e.id]?.plays ?? 0,
        xp: gameStats[e.id]?.xp ?? 0,
        last: gameStats[e.id]?.last ?? 0,
        runs: gameRuns[e.id] ?? [],
      })).sort((a, b) => b.best - a.best || b.plays - a.plays),
    [scores, gameStats, gameRuns],
  );
  const maxBest = Math.max(1, ...rows.map((r) => r.best));
  const totalPlays = rows.reduce((a, r) => a + r.plays, 0);
  const totalXp = rows.reduce((a, r) => a + r.xp, 0);
  const records = rows.filter((r) => r.best > 0).length;
  const favorite = [...rows].sort((a, b) => b.plays - a.plays)[0];
  const mastered = rows.filter((r) => masteryOf(r.xp).level >= 3).length;

  return (
    <div className="paper mt-4 p-5" style={{ animation: "rise .35s var(--ease-soft) both" }}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Icon name="trophy" size={14} className="text-accent" />
        <span className="label">Arcade stats</span>
        <span className="chip">{pet.stats.games} rounds lifetime</span>
        <span className="chip" data-on="true"><Icon name="zap" size={12} className="text-accent" /> {totalXp.toLocaleString()} game XP</span>
        <span className="chip">{records}/{ENTRIES.length} games with records</span>
        {mastered > 0 && <span className="chip" data-on="true" title="Games at Veteran mastery or beyond"><Icon name="star" size={12} className="text-accent" /> {mastered} mastered</span>}
        {favorite && favorite.plays > 0 && (
          <span className="chip" title="Your most played game">
            <Icon name={favorite.e.icon} size={12} className="text-accent" /> favorite: {favorite.e.title}
          </span>
        )}
        <div className="flex-1" />
        <span className="text-[11.5px] text-faint">every point becomes XP · every 2 points a coin</span>
      </div>

      {totalPlays === 0 ? (
        <div className="flex items-center gap-2 py-3 text-[12.5px] text-faint">
          <Icon name="gamepad" size={15} /> No rounds yet — pick any game above and your stats will appear here.
        </div>
      ) : (
        <div className="stat-table">
          {rows.map((r, i) => (
            <div key={r.e.id} className="stat-row" data-top={i < 3 && r.best > 0} style={{ animation: "rise .4s var(--ease-soft) both", animationDelay: `${Math.min(i, 10) * 35}ms` }}>
              <span className="stat-rank" style={i < 3 && r.best > 0 ? { color: MEDALS[i] } : undefined}>
                {i < 3 && r.best > 0 ? <Icon name="crown" size={13} /> : <span className="pixel-font">{i + 1}</span>}
              </span>
              <span className="game-icon !h-8 !w-8 flex-none">
                <Icon name={r.e.icon} size={15} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="pixel-font block truncate text-[14.5px] leading-tight">{r.e.title}</span>
                  {r.runs.length >= 2 && <Sparkline runs={r.runs} />}
                  {masteryOf(r.xp).level > 0 && (
                    <span className="mastery-chip !py-0.5" style={{ color: masteryOf(r.xp).color }} title={`${masteryOf(r.xp).tier} mastery`}>
                      <Icon name="star" size={10} /> L{masteryOf(r.xp).level}
                    </span>
                  )}
                </span>
                <span className="mt-1 flex h-[5px] w-full overflow-hidden rounded-sm bg-panel2">
                  <i className="stat-bar" style={{ width: `${(r.best / maxBest) * 100}%` }} />
                </span>
              </span>
              <span className="stat-num" title="Personal best">
                <Icon name="trophy" size={11} className="text-accent" /> {r.best}
              </span>
              <span className="stat-num" title="Rounds played">
                <Icon name="play" size={11} /> {r.plays}
              </span>
              <span className="stat-num" title="XP earned here">
                <Icon name="zap" size={11} /> {r.xp.toLocaleString()}
              </span>
              <span className="stat-ago" title="Last played">{r.last ? timeAgo(r.last) : "—"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Always-visible lifetime arcade strip — fills the space under the grid with your arcade life. */
function ArcadeLife({ onPlay }: { onPlay: (id: string) => void }) {
  const scores = useStore((s) => s.gameScores);
  const gameStats = useStore((s) => s.gameStats);
  const pet = useStore((s) => s.pet);
  const recent = useMemo(
    () =>
      ENTRIES.filter((e) => (gameStats[e.id]?.plays ?? 0) > 0)
        .sort((a, b) => (gameStats[b.id]?.last ?? 0) - (gameStats[a.id]?.last ?? 0))
        .slice(0, 4),
    [gameStats],
  );
  const totalXp = Object.values(gameStats).reduce((a, b) => a + b.xp, 0);
  const totalPlays = Object.values(gameStats).reduce((a, b) => a + b.plays, 0);
  const records = ENTRIES.filter((e) => (scores[e.id] ?? 0) > 0).length;
  const favorite = [...ENTRIES].sort((a, b) => (gameStats[b.id]?.plays ?? 0) - (gameStats[a.id]?.plays ?? 0))[0];

  return (
    <div className="paper arcade-life mt-4 p-4" style={{ animation: "rise .4s var(--ease-soft) both" }}>
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="gamepad" size={14} className="text-accent" />
        <span className="label">Arcade life</span>
        <span className="chip" title="Rounds played, lifetime (from your pet's memory)">
          <Icon name="play" size={11} /> {pet.stats.games} rounds
        </span>
        <span className="chip" data-on={totalXp > 0} title="XP earned inside arcade games">
          <Icon name="zap" size={11} className="text-accent" /> {totalXp.toLocaleString()} game XP
        </span>
        <span className="chip" title="Games where you hold a personal best">
          <Icon name="trophy" size={11} className="text-accent" /> {records}/{ENTRIES.length} records
        </span>
        {totalPlays > 0 && favorite && (
          <span className="chip" title="Your most played game">
            <Icon name={favorite.icon} size={11} className="text-accent" /> favorite: {favorite.title}
          </span>
        )}
        <span className="flex-1" />
        <span className="text-[11px] text-faint">every point → XP · every 2 points → 1 coin</span>
      </div>
      {recent.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="label !text-[10px] text-faint">recently played</span>
          {recent.map((e) => (
            <button
              key={e.id}
              className="pulse-chip"
              onClick={() => onPlay(e.id)}
              title={`Play ${e.title} again — best ${scores[e.id] ?? 0}`}
            >
              <Icon name={e.icon} size={12} className="text-accent" />
              <span className="pixel-font">{e.title}</span>
              <span className="opacity-70">{timeAgo(gameStats[e.id]?.last ?? 0)}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-2 text-[12.5px] text-faint">
          <Icon name="lightbulb" size={13} className="text-accent" />
          Pick a game above — your rounds, XP and records will live here.
        </div>
      )}
    </div>
  );
}

/** A unified playable entry: built-in games load real components, custom games run on the engines. */
type Playable = {
  id: string;
  title: string;
  icon: IconName;
  blurb: string;
  controls: string;
  tip: string;
  load: () => Promise<{ default: (props: GameComponentProps) => React.ReactNode }>;
  custom?: CustomGameDef;
};

const paramRow = (label: string, key: keyof GameParams, min: number, max: number, step: number, def: GameParams | undefined) => {
  const val = typeof def?.[key] === "number" ? (def[key] as number) : min;
  void val;
  return { label, key, min, max, step };
};

/** no-code game maker: pick an engine, tune sliders, save it into the arcade */
function GameMaker({ edit, onClose }: { edit?: CustomGameDef; onClose: () => void }) {
  const [engine, setEngine] = useState<EngineId>(edit?.engine ?? "dodge");
  const [title, setTitle] = useState(edit?.title ?? "");
  const [blurb, setBlurb] = useState(edit?.blurb ?? "");
  const [params, setParams] = useState<GameParams>(edit?.params ?? { ...DEFAULT_PARAMS["dodge"] });
  const [accent, setAccent] = useState(edit?.accent ?? "#e0a05a");
  const st = useStore.getState;

  const pickEngine = (id: EngineId) => {
    setEngine(id);
    setParams({ ...DEFAULT_PARAMS[id] });
    if (!title.trim()) setTitle(`${id[0].toUpperCase()}${id.slice(1)} Rush`);
    sfx("pop");
  };

  const save = () => {
    const def: CustomGameDef = {
      id: edit?.id ?? uid(),
      title: title.trim() || "Untitled game",
      blurb: blurb.trim() || engineBlurb(engine),
      controls: engineControls(engine),
      tip: "Made in the Nook game maker — tune the sliders to rebalance it any time.",
      engine,
      params,
      accent,
      icon: "gamepad",
      createdAt: Date.now(),
      origin: edit ? edit.origin : "custom",
    };
    void st().addCustomGames([def]);
    sfx("buy");
    st().toast(`${def.title} added to the arcade!`, "gamepad");
    onClose();
  };

  const sliders: { label: string; key: keyof GameParams; min: number; max: number; step: number }[] = [
    paramRow("Speed", "speed", 0.5, 2, 0.1, params),
    ...(engine === "dodge" ? [paramRow("Fall rate (spawn/s)", "fallRate", 0.4, 4, 0.1, params)] : []),
    ...(engine === "catcher" ? [paramRow("Goodie ratio", "goodRatio", 0.2, 0.9, 0.05, params)] : []),
    ...(engine === "shooter" ? [paramRow("Fire rate (shots/s)", "fireRate", 1, 8, 0.5, params)] : []),
    ...(engine === "quiz" ? [paramRow("Questions", "questionCount", 5, 30, 1, params), paramRow("Seconds each", "timePerQ", 3, 15, 1, params)] : []),
    ...(engine === "flappy" ? [paramRow("Gap size (px)", "gapSize", 90, 220, 5, params)] : []),
  ];
  const shown = sliders.filter((s) => s.key !== "speed" || true);

  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/50 p-4" style={{ animation: "fade .2s ease both" }} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="panel panel-solid scroll max-h-[86vh] w-full max-w-[560px] rounded-2xl p-5" style={{ animation: "pop .28s var(--ease-soft) both" }} role="dialog" aria-label="Game maker">
        <div className="mb-3 flex items-center gap-2">
          <Icon name="wand" size={16} className="text-accent" />
          <span className="pixel-font text-[17px]">{edit ? "Edit game" : "Game maker"}</span>
          <div className="flex-1" />
          <button className="icon-btn !h-7 !w-7" onClick={onClose} aria-label="Close"><Icon name="close" size={14} /></button>
        </div>
        <div className="mb-2 text-[12px] text-dim">Pick an engine, tune the feel, name it — your game lands in the arcade and can be exported/imported like any pack.</div>
        <div className="mb-3 grid grid-cols-3 gap-1.5">
          {ENGINE_META.map((m) => (
            <button key={m.id} className="btn btn-sm !flex-col !items-start !gap-0.5 !py-2 text-left" data-on={engine === m.id} onClick={() => pickEngine(m.id)} title={m.desc}>
              <span className="pixel-font text-[12.5px]">{m.label}</span>
              <span className="text-[10px] leading-tight text-faint">{m.desc}</span>
            </button>
          ))}
        </div>
        <div className="mb-3 grid gap-2 sm:grid-cols-2">
          <label className="block">
            <span className="label mb-1 block">Game name</span>
            <input className="input w-full" maxLength={28} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Meteor Dodge" />
          </label>
          <label className="block">
            <span className="label mb-1 block">Tagline</span>
            <input className="input w-full" maxLength={60} value={blurb} onChange={(e) => setBlurb(e.target.value)} placeholder={engineBlurb(engine)} />
          </label>
        </div>
        <div className="mb-3 grid grid-cols-[repeat(8,22px)] gap-1.5" role="radiogroup" aria-label="Accent color">
          {["#e0a05a", "#7fc48f", "#e0685f", "#b59fd0", "#8fb7c9", "#d9c98a", "#e0689e", "#4de3e0"].map((c) => (
            <button key={c} className="h-[22px] w-[22px] rounded-md border border-line" style={{ background: c, outline: accent === c ? "2px solid var(--ink)" : undefined }} onClick={() => setAccent(c)} aria-label={`Accent ${c}`} />
          ))}
        </div>
        <div className="space-y-2">
          {shown.map((s) => {
            const v = typeof params[s.key] === "number" ? (params[s.key] as number) : s.min;
            return (
              <label key={String(s.key)} className="flex items-center gap-3">
                <span className="label w-[130px] flex-none">{s.label}</span>
                <input
                  type="range"
                  className="flex-1"
                  min={s.min}
                  max={s.max}
                  step={s.step}
                  value={v}
                  onChange={(e) => setParams((p) => ({ ...p, [s.key]: Number(e.target.value) }))}
                />
                <span className="pixel-font w-10 flex-none text-right text-[12px] text-dim">{v}</span>
              </label>
            );
          })}
        </div>
        <div className="mt-4 flex items-center gap-2">
          <button className="btn btn-accent" onClick={save}><Icon name="save" size={13} /> {edit ? "Save changes" : "Create game"}</button>
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function engineControls(e: EngineId): string {
  return {
    dodge: "Move with the mouse or ← →. Dodge the falling junk. Survive to score!",
    catcher: "Move the basket with the mouse. Catch goodies, avoid bombs. 45 seconds.",
    shooter: "← → or mouse to move. Space / click fires (auto-fire on). Blast them all!",
    quiz: "Pick the right answer before the timer bar empties. Streaks multiply!",
    memory: "Flip cards to find pairs. Fewer moves = bigger score.",
    flappy: "Tap / click / Space to flap. Fly through the gaps!",
  }[e];
}

export function ArcadeView() {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [cat, setCatState] = useState<(typeof CATEGORIES)[number] | "Mine">("All");
  const setCat = (c: (typeof CATEGORIES)[number] | "Mine") => setCatState(c);
  const [maker, setMaker] = useState<{ open: boolean; edit?: CustomGameDef }>({ open: false });
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const scores = useStore((s) => s.gameScores);
  const gameStats = useStore((s) => s.gameStats);
  const statsOpen = useStore((s) => s.arcadeStats);
  const customGames = useStore((s) => s.customGames);
  const totalPlays = useStore((s) => Object.values(s.gameStats).reduce((a, b) => a + b.plays, 0));
  const fileRef = useRef<HTMLInputElement>(null);
  const st = useStore.getState;

  const customEntries: GameEntry[] = useMemo(
    () =>
      customGames.map((g) => ({
        id: g.id,
        title: g.title,
        icon: "gamepad",
        blurb: engineBlurb(g.engine),
        controls: g.controls,
        tip: g.tip,
        custom: g,
        load: async () => ({ default: gameFromDef(g) }),
      })),
    [customGames],
  );
  const all = useMemo(() => [...ENTRIES, ...customEntries], [customEntries]);
  const active = useMemo(() => all.find((e) => e.id === activeId) ?? null, [activeId, all]);
  const shown = useMemo(() => (cat === "All" ? all : all.filter((e) => e.custom || e.blurb === cat)), [cat, all]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { All: all.length, Mine: customEntries.length };
    for (const e of ENTRIES) c[e.blurb] = (c[e.blurb] ?? 0) + 1;
    return c;
  }, [all, customEntries]);

  const importFile = async (file: File) => {
    try {
      const text = await file.text();
      const defs = parseGamePack(JSON.parse(text)).map((d) => validateGameDef(d)).filter((d): d is CustomGameDef => !!d);
      if (!defs.length) throw new Error("no games found");
      await st().addCustomGames(defs);
      sfx("buy");
      st().toast(`Imported ${defs.length} game${defs.length > 1 ? "s" : ""}!`, "gamepad");
      st().notify(`Imported ${defs.length} game${defs.length > 1 ? "s" : ""} into the arcade`, "gamepad", "info");
    } catch {
      sfx("error");
      st().toast("That file isn't a nook-games pack (.json)", "alert");
    }
  };

  if (active) return <ActiveGame key={active.id} entry={active} onBack={() => setActiveId(null)} />;

  return (
    <div className="scroll h-full">
      <div className="mx-auto max-w-[980px] px-1 pb-8">
        {/* arcade marquee hero */}
        <div className="arcade-hero mb-4" style={{ animation: "rise .5s var(--ease-soft) both" }}>
          <div className="flex flex-wrap items-end gap-3 p-5">
            <div>
              <div className="pixel-font arcade-title text-[26px] leading-tight">Arcade</div>
              <div className="text-[13px] text-dim">Thirteen tiny classics + your own creations. Every point becomes XP, every two points a coin.</div>
            </div>
            <div className="flex-1" />
            <button className="btn btn-sm btn-accent" onClick={() => setMaker({ open: true })} title="Build a game without code">
              <Icon name="wand" size={13} /> Game maker
            </button>
            <button className="btn btn-sm" onClick={() => fileRef.current?.click()} title="Import a .json or .zip game pack">
              <Icon name="upload" size={13} /> Import
            </button>
            {customEntries.length > 0 && (
              <button
                className="btn btn-sm"
                title="Export all your games as one nook-games pack"
                onClick={() => {
                  const blob = new Blob([JSON.stringify(packFromDefs(customEntries.map((e) => e.custom!)), null, 2)], { type: "application/json" });
                  const a = document.createElement("a");
                  a.href = URL.createObjectURL(blob);
                  a.download = "nook-games-pack.json";
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
                }}
              >
                <Icon name="download" size={13} /> Export {customEntries.length}
              </button>
            )}
            {totalPlays > 0 && (
              <button className="btn btn-sm" data-on={statsOpen} onClick={() => st().set({ arcadeStats: !statsOpen })}>
                <Icon name="trophy" size={13} /> {statsOpen ? "Hide stats" : "Stats"}
              </button>
            )}
            <span className="chip">
              <Icon name="gamepad" size={13} /> {all.length} games
            </span>
            <input
              ref={fileRef}
              type="file"
              accept=".json,.zip,application/json,application/zip"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importFile(f);
                e.target.value = "";
              }}
            />
          </div>
          <i className="arcade-glow" aria-hidden />
        </div>
        <div className="seg mb-3" role="tablist" aria-label="Game categories">
          {(["All", "Mine", ...CATEGORIES.filter((c) => c !== "All")] as string[]).filter((c) => (counts[c] ?? 0) > 0).map((c) => (
            <button
              key={c}
              data-on={cat === c}
              onClick={() => setCat(c as (typeof CATEGORIES)[number] | "Mine")}
              role="tab"
              aria-selected={cat === c}
              style={cat === c && c !== "All" ? { color: c === "Mine" ? "#e0689e" : (CAT_COLORS as Record<string, string>)[c] } : undefined}
            >
              <Icon name={c === "Mine" ? "wand" : CAT_ICONS[c] ?? "gamepad"} size={13} /> {c}
              <span className="opacity-60">{counts[c]}</span>
            </button>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((e, i) => (
            <GameCard
              key={e.id}
              e={e}
              i={i}
              best={scores[e.id] ?? 0}
              xp={gameStats[e.id]?.xp ?? 0}
              onPick={() => setActiveId(e.id)}
              onEdit={e.custom ? () => setMaker({ open: true, edit: e.custom }) : undefined}
              onDelete={
                e.custom
                  ? () => {
                      if (confirmDelete === e.id) {
                        void st().removeCustomGame(e.id);
                        setConfirmDelete(null);
                        st().toast(`${e.title} removed from the arcade`, "trash");
                      } else {
                        setConfirmDelete(e.id);
                        setTimeout(() => setConfirmDelete((c) => (c === e.id ? null : c)), 2600);
                      }
                    }
                  : undefined
              }
            />
          ))}
        </div>
        {confirmDelete && <div className="mt-2 text-center text-[12px] text-dim">Tap the trash again on “{all.find((e) => e.id === confirmDelete)?.title}” to confirm removal.</div>}
        <ArcadeLife onPlay={setActiveId} />
        {statsOpen && totalPlays > 0 && <StatsCenter />}
        {maker.open && <GameMaker edit={maker.edit} onClose={() => setMaker({ open: false })} />}
      </div>
    </div>
  );
}

function ActiveGame({ entry, onBack }: { entry: GameEntry; onBack: () => void }) {
  const [Comp, setComp] = useState<GameDef["Component"] | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.resolve(entry.load())
      .then((m) => {
        if (alive) setComp(() => m.default);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [entry]);

  if (!Comp) {
    return (
      <div className="grid h-full place-items-center">
        <div className="pixel-font text-dim shimmer rounded-xl px-5 py-3">loading…</div>
      </div>
    );
  }

  const gameDef: GameDef = {
    id: entry.id,
    title: entry.title,
    icon: entry.icon,
    blurb: entry.blurb,
    controls: entry.controls,
    tip: entry.tip,
    Component: Comp,
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <button className="btn btn-sm mb-2 self-start" onClick={onBack}>
        <Icon name="arrow-left" size={13} /> All games
      </button>
      <div className="min-h-0 flex-1">
        <GameShell def={gameDef} />
      </div>
    </div>
  );
}
