
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { DURATIONS, useStore, type TimerMode } from "@/lib/store";

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Last 7 days of focus minutes — Mon-first week, pixel bars. */
function FocusWeek() {
  const focusLog = useStore((s) => s.focusLog);
  const days = useMemo(() => {
    const now = new Date();
    const out: { key: string; label: string; mins: number; today: boolean }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      out.push({ key: dayKey(d), label: d.toLocaleDateString(undefined, { weekday: "narrow" }), mins: focusLog[dayKey(d)] ?? 0, today: i === 0 });
    }
    return out;
  }, [focusLog]);
  const max = Math.max(30, ...days.map((d) => d.mins));
  const total = days.reduce((a, d) => a + d.mins, 0);
  return (
    <div className="paper w-full max-w-[560px] p-4" style={{ animation: "rise .5s var(--ease-soft) both" }}>
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <Icon name="hourglass" size={13} className="text-accent" />
        <span className="label">This week</span>
        <span className="chip">{total} min focused</span>
        {total >= 120 && <span className="chip" data-on="true"><Icon name="fire" size={11} className="text-accent" /> deep week</span>}
      </div>
      <div className="flex items-end justify-between gap-2">
        {days.map((d) => (
          <div key={d.key} className="flex min-w-0 flex-1 flex-col items-center gap-1.5" title={`${d.mins} min · ${d.key}`}>
            <span className="pixel-font text-[10px] text-faint">{d.mins > 0 ? d.mins : ""}</span>
            <div className="flex h-[56px] w-full items-end rounded-sm bg-panel2 px-[3px]">
              <div
                className="focus-bar w-full"
                data-today={d.today}
                style={{ height: `${Math.max(d.mins > 0 ? 8 : 2, (d.mins / max) * 100)}%` }}
              />
            </div>
            <span className="pixel-font text-[10.5px]" style={{ color: d.today ? "var(--accent)" : "var(--faint)" }}>{d.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}


/** Pomodoro stats: today, streak, best day, 30-day average, plus Timelens' view of today's focus. */
export function focusStats(focusLog: Record<string, number>, sessions: Record<string, number>, now = new Date()) {
  const key = (i: number) => dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i));
  let streak = 0;
  for (let i = (focusLog[key(0)] ?? 0) > 0 ? 0 : 1; i < 400 && (focusLog[key(i)] ?? 0) > 0; i++) streak++;
  let month = 0, monthSessions = 0, best = 0, bestKey = "";
  for (let i = 0; i < 30; i++) {
    const m = focusLog[key(i)] ?? 0;
    month += m;
    monthSessions += sessions[key(i)] ?? 0;
    if (m > best) { best = m; bestKey = key(i); }
  }
  return { todayMins: focusLog[key(0)] ?? 0, todaySessions: sessions[key(0)] ?? 0, streak, best, bestKey, avg: Math.round(month / 30), monthSessions, total: Object.values(focusLog).reduce((a, b) => a + b, 0) };
}

function FocusStats() {
  const focusLog = useStore((s) => s.focusLog);
  const sessionsToday = useStore((s) => s.timer.sessions);
  const [tlFocus, setTlFocus] = useState<number | null>(null);
  const sessions = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem("nook:focusSessions") ?? "{}") as Record<string, number>;
    } catch {
      return {};
    }
    // re-read when a session completes
  }, [sessionsToday, focusLog]);
  useEffect(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    let live = true;
    fetch(`/api/timelens/summary?from=${d.getTime()}&to=${Date.now() + 1}`)
      .then((r) => r.json())
      .then((x: { focusSecs?: number }) => live && setTlFocus(Math.round((x.focusSecs ?? 0) / 60)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [focusLog]);
  const s = focusStats(focusLog, sessions);
  const tiles: [string, string, string][] = [
    ["Today", `${s.todayMins}m`, `${s.todaySessions} session${s.todaySessions === 1 ? "" : "s"}`],
    ["Streak", `${s.streak}d`, s.streak > 0 ? "days in a row" : "start one today"],
    ["Best day", `${s.best}m`, s.bestKey || "—"],
    ["30-day avg", `${s.avg}m`, `${s.monthSessions} sessions`],
  ];
  return (
    <div className="paper w-full max-w-[560px] p-4" data-testid="focus-stats">
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <Icon name="star" size={13} className="text-accent" />
        <span className="label">Pomodoro stats</span>
        {tlFocus !== null && <span className="chip" title="Focus blocks recorded in Timelens today"><Icon name="clock" size={11} /> Timelens: {tlFocus}m focus</span>}
        <button className="chip ml-auto" onClick={() => useStore.getState().setView("timelens")}>open Timelens</button>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tiles.map(([l, v, sub]) => (
          <div key={l} className="rounded-xl bg-panel2 px-3 py-2">
            <div className="tiny-font text-[9px] text-faint">{l.toUpperCase()}</div>
            <div className="pixel-font text-[22px] leading-tight tabular-nums">{v}</div>
            <div className="truncate text-[11.5px] text-dim">{sub}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- ambient brown noise (WebAudio, generated — no files) ----
let ctx: AudioContext | null = null;
let gain: GainNode | null = null;
let src: AudioBufferSourceNode | null = null;
function ambient(on: boolean) {
  if (on) {
    ctx ??= new AudioContext();
    void ctx.resume();
    const len = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = last * 3.2; }
    src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 520;
    gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(lp).connect(gain).connect(ctx.destination);
    src.start();
    gain.gain.linearRampToValueAtTime(0.35, ctx.currentTime + 1.2);
  } else if (gain && ctx && src) {
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.5);
    const s = src;
    setTimeout(() => s.stop(), 600);
    src = null;
  }
}

const SEG = 60;
const MODES: [TimerMode, string][] = [["focus", "Focus"], ["short", "Short break"], ["long", "Long break"]];

export function FocusView() {
  const timer = useStore((s) => s.timer);
  const activeNote = useStore((s) => s.notes.find((n) => n.id === s.activeId));
  const [noise, setNoise] = useState(false);
  const st = useStore.getState;

  useEffect(() => () => { if (src) ambient(false); }, []);

  const lit = Math.round(((timer.total - timer.remaining) / timer.total) * SEG);
  const mm = String(Math.floor(timer.remaining / 60)).padStart(2, "0");
  const ss = String(timer.remaining % 60).padStart(2, "0");
  const focusing = timer.running && timer.mode === "focus";

  return (
    <div className="panel relative h-full overflow-y-auto rounded-[20px]">
      <div className="absolute inset-0 opacity-[0.28]" style={{ background: "url(/art/den.webp) center / cover", filter: "blur(2px) saturate(.6)" }} />
      <div className="absolute inset-0" style={{ background: "radial-gradient(600px 500px at 50% 45%, transparent, var(--panel-solid) 85%)" }} />

      <div className="relative flex min-h-full flex-col items-center justify-center gap-5 py-6">
        <div className="seg">
          {MODES.map(([m, l]) => (
            <button key={m} data-on={timer.mode === m} onClick={() => st().resetTimer(m)}>{l} <span className="opacity-60">{DURATIONS[m] / 60}</span></button>
          ))}
        </div>

        <div className="relative h-[372px] w-[372px]">
          <svg viewBox="-200 -200 400 400" className="absolute inset-0" shapeRendering="crispEdges">
            {Array.from({ length: SEG }, (_, i) => {
              const on = i < lit;
              const head = i === lit - 1;
              return (
                <rect key={i} className="timer-seg" x={-3.5} y={-176} width={7} height={head ? 24 : 18} rx={1} transform={`rotate(${(i * 360) / SEG})`} fill={on ? "var(--accent)" : "var(--faint)"} opacity={on ? 1 : 0.35} style={head && timer.running ? { filter: "drop-shadow(0 0 6px var(--accent))" } : undefined} />
              );
            })}
          </svg>
          <div className="absolute inset-0 grid place-items-center">
            <div className="text-center">
              <div className="label mb-1">{timer.mode === "focus" ? (focusing ? "deep work" : "ready") : "rest"}</div>
              <div className="pixel-font text-[84px] font-semibold leading-none tracking-wide tabular-nums">{mm}<span style={{ opacity: timer.running ? undefined : 1, animation: timer.running ? "caret 1s steps(1) infinite" : undefined }}>:</span>{ss}</div>
              <div className="pixel-font mt-2 text-[14px] text-dim">{timer.sessions} session{timer.sessions === 1 ? "" : "s"} today</div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button className="btn btn-accent !h-11 !px-6 !text-[17px]" onClick={() => (timer.running ? st().pauseTimer() : st().startTimer())}>
            <Icon name={timer.running ? "pause" : "play"} size={18} /> {timer.running ? "Pause" : timer.remaining < timer.total ? "Resume" : "Start"}
          </button>
          <button className="btn !h-11" onClick={() => st().resetTimer()}><Icon name="reload" size={16} /> Reset</button>
          <button className="btn !h-11" data-on={noise} style={noise ? { background: "var(--hl)", borderColor: "var(--accent)" } : undefined} onClick={() => { ambient(!noise); setNoise(!noise); }}>
            <Icon name="waves" size={16} /> Brown noise
          </button>
        </div>

        <div className="flex items-center gap-3 text-[13px] text-dim">
          {activeNote ? (
            <button className="chip" onClick={() => st().openNote(activeNote.id)}><Icon name="note" size={12} /> Working on: {activeNote.title}</button>
          ) : (
            <button className="chip" onClick={() => st().setView("notes")}><Icon name="notes" size={12} /> Pick a note to work on</button>
          )}
          <span className="chip"><Icon name="coins" size={12} /> +10 coins per focus session</span>
        </div>

        <FocusStats />
        <FocusWeek />
      </div>

    </div>
  );
}
