
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/icons";
import { Leaderboard } from "@/components/Leaderboard";
import { PetView } from "@/components/PetView";
import { PHASE_TINT, PhaseCelestial, useAmbience } from "@/lib/ambience";
import { levelOf, moodFor, stageOf } from "@/lib/pet";
import { feedPet, patPet } from "@/lib/petActions";
import { DAILY_REWARDS, pendingGiftDay, useStore } from "@/lib/store";
import { QUESTS, achievementInfo, bonusQuestOf, type QuestDef } from "@/lib/quests";
import { parseNote, timeAgo } from "@/lib/util";

const greetByHour = () => {
  const h = new Date().getHours();
  return h < 5 ? "Still up" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};

function CountUp({ to }: { to: number }) {
  const [v, setV] = useState(0);
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const loop = (now: number) => {
      const k = Math.min(1, (now - t0) / 900);
      setV(Math.round(to * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [to]);
  return <>{v.toLocaleString()}</>;
}

function Stat({ label, v, icon, onClick }: { label: string; v: number; icon: IconName; onClick?: () => void }) {
  return (
    <button className="mini-stat" onClick={onClick} style={{ animation: "rise .5s var(--ease-soft) both" }} tabIndex={onClick ? 0 : -1}>
      <span className="mini-stat-num"><CountUp to={v} /></span>
      <span className="mini-stat-label"><Icon name={icon} size={11} /> {label}</span>
    </button>
  );
}

/** ULTRA-MINIMAL dashboard: one quiet column, hairlines, air — everything else lives in its own room. */
export function Dashboard() {
  const notes = useStore((s) => s.notes);
  const pet = useStore((s) => s.pet);
  const quests = useStore((s) => s.quests);
  const tasks = useStore((s) => s.tasks);
  const streak = useStore((s) => s.streak);
  const dailyGift = useStore((s) => s.dailyGift);
  const st = useStore.getState;

  const stats = useMemo(() => {
    let words = 0, links = 0;
    for (const n of notes) {
      const m = parseNote(n.content);
      words += m.words;
      links += m.links.length;
    }
    return { words, links };
  }, [notes]);

  const openTasks = tasks.filter((t) => !t.done).length;
  const recent = useMemo(() => [...notes].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3), [notes]);
  const { level, pct } = levelOf(pet.xp);
  const stage = stageOf(level);
  const phase = useAmbience();
  const giftDay = pendingGiftDay(dailyGift);
  const allQuests = useMemo<QuestDef[]>(() => [...QUESTS, bonusQuestOf()], []);
  const claimable = allQuests.filter((q) => !quests.claimed[q.id] && (quests.progress[q.id] ?? 0) >= q.goal);
  const doneQuests = allQuests.filter((q) => quests.claimed[q.id]).length;
  const achievements = useStore((s) => s.achievements);
  const focusLog = useStore((s) => s.focusLog);
  const focusToday = useMemo(() => {
    const d = new Date();
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return focusLog[key] ?? 0;
  }, [focusLog]);

  return (
    <div className="scroll h-full">
      <div className="mx-auto max-w-[720px] px-2 pb-12 pt-6 sm:px-6">
        {/* greeting */}
        <header style={{ animation: "rise .5s var(--ease-soft) both" }}>
          <div className="label">{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</div>
          <h1 className="pixel-font mt-1 text-[30px] leading-tight sm:text-[34px]">{greetByHour()}.</h1>
          <p className="mt-1.5 text-[13.5px] text-dim">
            {notes.length} notes · {stats.words.toLocaleString()} words · {openTasks > 0 ? <><b className="text-ink">{openTasks}</b> open task{openTasks > 1 ? "s" : ""}</> : "all tasks clear"} {moodFor(pet) === "sad" ? <span className="text-accent">· {pet.name} misses you</span> : null}
          </p>
        </header>

        {/* stats strip */}
        <div className="mt-6 grid grid-cols-4 gap-2" style={{ animation: "rise .55s var(--ease-soft) both", animationDelay: "60ms" }}>
          <Stat label="notes" v={notes.length} icon="notes" onClick={() => st().createNote()} />
          <Stat label="words" v={stats.words} icon="file-text" />
          <Stat label="tasks" v={openTasks} icon="tasklist" onClick={() => st().setView("tasks")} />
          <Stat label="focus min" v={focusToday} icon="hourglass" onClick={() => st().setView("focus")} />
        </div>

        {/* wall of fame — compact room leaderboard */}
        <section className="mt-7" style={{ animation: "rise .55s var(--ease-soft) both", animationDelay: "90ms" }}>
          <div className="mb-2.5 flex items-center gap-2">
            <span className="label flex-1">wall of fame</span>
            <button className="tiny-font text-[10px] text-faint transition-colors hover:text-accent" onClick={() => st().setView("team")}>
              full room →
            </button>
          </div>
          <div className="paper p-3.5">
            <Leaderboard board={{}} compact />
          </div>
        </section>

        {/* pet strip — the whole den in one quiet line */}
        <section className="mt-7" style={{ animation: "rise .55s var(--ease-soft) both", animationDelay: "110ms" }}>
          <div className="mb-2.5 flex items-center gap-2">
            <span className="label flex-1">companion</span>
            <span className="tiny-font text-[10px] text-faint">{PHASE_TINT[phase].label}</span>
          </div>
          <button className="pet-line group w-full text-left" onClick={() => st().setView("den")} aria-label="Visit the den">
            <span className="pet-line-den" style={{ background: "url(/art/den.webp) center / cover" }}>
              <span className="absolute inset-0 transition-all duration-1000" style={{ background: PHASE_TINT[phase].sky, opacity: 0.55 }} />
              <span className="absolute right-2 top-2" style={{ animation: "floaty 5.5s ease-in-out infinite" }}>
                <PhaseCelestial phase={phase} size={16} />
              </span>
              <PetView species={pet.species} tint={pet.look} hat={pet.hat} mood={moodFor(pet)} scale={2.2} fps={7} style={{ marginBottom: -4 }} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="pixel-font text-[15.5px]">{pet.name}</span>
                <span className="chip !py-0 !text-[10.5px]" data-on="true">Lv {level}{stage.id > 1 ? ` · ${stage.name}` : ""}</span>
              </span>
              <span className="mt-1.5 block h-[5px] w-full max-w-[220px] overflow-hidden rounded-full bg-panel2">
                <i className="block h-full bg-accent transition-all duration-700" style={{ width: `${pct * 100}%` }} />
              </span>
              <span className="mt-2 flex gap-3 text-[11.5px] text-faint">
                <span><Icon name="fish" size={11} className="mr-1 text-accent" />{Math.round(pet.food)}</span>
                <span><Icon name="zap" size={11} className="mr-1 text-accent" />{Math.round(pet.energy)}</span>
                <span><Icon name="heart" size={11} className="mr-1 text-accent" />{Math.round(pet.joy)}</span>
                <span><Icon name="fire" size={11} className="mr-1 text-accent" />{streak.count}d</span>
              </span>
            </span>
            <Icon name="chevron-right" size={15} className="flex-none text-faint transition-transform group-hover:translate-x-0.5" />
          </button>
          {/* pat / feed hotbuttons overlay on the right — wire them without nested-button issues */}
          <div className="mt-1.5 flex gap-2">
            <button className="chip" onClick={patPet}><Icon name="heart" size={11} /> pat</button>
            <button className="chip" onClick={() => feedPet("berry")}><Icon name="leaf" size={11} /> berry</button>
            <button className="chip" onClick={() => st().setView("den")}><Icon name="dog" size={11} /> den</button>
          </div>
        </section>

        {/* continue — the only cards that earn their place */}
        {recent.length > 0 && (
          <section className="mt-7" style={{ animation: "rise .55s var(--ease-soft) both", animationDelay: "160ms" }}>
            <div className="mb-2.5 flex items-center gap-2">
              <span className="label flex-1">continue</span>
              <button className="tiny-font text-[10.5px] text-faint hover:text-accent" onClick={() => st().set({ notesDrawer: true })}>ALL NOTES →</button>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              {recent.map((n) => {
                const m = parseNote(n.content);
                return (
                  <button key={n.id} className="quiet-card" onClick={() => st().openNote(n.id)} style={{ animation: "rise .5s var(--ease-soft) both" }}>
                    <span className="pixel-font block truncate text-[14px]">{n.title}</span>
                    <span className="mt-1 block line-clamp-2 text-[11.5px] leading-snug text-faint">{m.snippet || "empty note"}</span>
                    <span className="mt-2 block text-[10.5px] text-faint">{timeAgo(n.updatedAt)}</span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* today — quests + gift collapsed into one hairline row each */}
        <section className="mt-7" style={{ animation: "rise .55s var(--ease-soft) both", animationDelay: "210ms" }}>
          <div className="mb-2.5 flex items-center gap-2">
            <span className="label flex-1">today</span>
            <span className="tiny-font text-[10px] text-faint">{doneQuests}/{allQuests.length} quests · resets midnight</span>
          </div>
          <div className="quiet-panel divide-y divide-[var(--line)]">
            {claimable.length > 0 && (
              <div className="flex items-center gap-2.5 px-3.5 py-2.5">
                <Icon name="gift" size={13} className="text-accent" />
                <span className="min-w-0 flex-1 truncate text-[13px]">
                  <b className="pixel-font">{claimable.length}</b> reward{claimable.length > 1 ? "s" : ""} ready — {claimable[0].title}{claimable.length > 1 ? ` +${claimable.length - 1} more` : ""}
                </span>
                <button className="btn btn-accent btn-sm" style={{ animation: "pop .3s var(--ease-soft) both" }} onClick={() => st().claimQuest(claimable[0].id)}>Claim</button>
              </div>
            )}
            {giftDay !== null && (
              <div className="flex items-center gap-2.5 px-3.5 py-2.5">
                <Icon name="gift" size={13} className="text-accent" />
                <span className="min-w-0 flex-1 truncate text-[13px]">Daily gift day {giftDay} — +{DAILY_REWARDS[giftDay - 1].coins} coins waiting</span>
                <button className="btn btn-sm" onClick={() => st().claimDailyGift()}>Open</button>
              </div>
            )}
            <div className="flex items-center gap-2.5 px-3.5 py-2.5">
              <Icon name="flag" size={13} className="text-faint" />
              <span className="min-w-0 flex-1 truncate text-[13px] text-dim">
                {doneQuests === allQuests.length ? "Every quest claimed — perfect day!" : allQuests.filter((q) => !quests.claimed[q.id]).slice(0, 2).map((q) => q.title).join(" · ")}
              </span>
              <button className="chip flex-none" onClick={() => st().set({ notesDrawer: true })} title="Open the all-notes drawer"><Icon name="library" size={11} /></button>
            </div>
          </div>
        </section>

        {/* quiet extras — collapsed by default to stay minimal */}
        <details className="quiet-details mt-7">
          <summary className="label">achievements · {achievements.length} earned</summary>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {achievements.slice(0, 24).map((k) => {
              const info = achievementInfo(k);
              return (
                <span key={k} className="achv-badge" style={{ animation: "pop .3s var(--ease-soft) both" }} title={info.desc}>
                  <span className="game-icon !h-6 !w-6"><Icon name={info.icon} size={12} /></span>
                  <span className="pixel-font text-[11.5px]">{info.title}</span>
                </span>
              );
            })}
            {achievements.length === 0 && <span className="text-[11.5px] text-faint">Earn your first one — finish a focus session or claim a quest.</span>}
          </div>
        </details>

        {/* whisper footer */}
        <div className="mt-10 flex items-center justify-between border-t border-line pt-3 text-[11px] text-faint">
          <span className="tiny-font">the nook · your second brain</span>
          <button className="tiny-font hover:text-accent" onClick={() => st().startTour()}>replay the tour</button>
        </div>
      </div>
    </div>
  );
}
