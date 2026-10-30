/**
 * Timelens — local, private desktop time tracking. Reads spans the Rust tracker wrote to
 * SQLite: today's timeline, per-app/category totals, hourly heatmap, week/month history,
 * productivity score, goals & limits, category rules, privacy controls and AI insights.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { Markdown } from "@/components/Markdown";
import { saveFile } from "@/lib/platform";
import { useStore } from "@/lib/store";

type Seg = { app: string; title: string; start: number; end: number; afk: boolean; focus: boolean; cat: string };
type AppRow = { app: string; secs: number; cat: string };
type Summary = {
  from: number; to: number; activeSecs: number; afkSecs: number; focusSecs: number; score: number;
  categories: { productive: number; neutral: number; distracting: number };
  apps: AppRow[]; titles: { app: string; title: string; secs: number }[]; hourly: number[]; hourlyProductive: number[];
  timeline: Seg[]; topApp: string | null; peakHour: number | null;
  current: { app: string; title: string; afk: boolean; since: number; running: boolean }; paused: boolean; enabled: boolean;
};
type Day = { day: string; activeSecs: number; productive: number; neutral: number; distracting: number; score: number; productiveDay: boolean };
type History = { days: Day[]; heatmap: number[][]; streak: number };
type Goal = { id: string; target: string; kind: "goal" | "limit"; mins: number; usedMins: number; pct: number; exceeded: boolean; achieved: boolean };
type Rule = { match: string; field: "app" | "title" | "any"; cat: "productive" | "neutral" | "distracting" };

export const CAT_COLOR: Record<string, string> = { productive: "#7fc48f", neutral: "#d9c98a", distracting: "#e0685f", afk: "#3a3f47", focus: "#8fb7c9" };
const fmt = (s: number) => {
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};
const dayStart = (t = Date.now()) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const j = async <T,>(url: string, init?: RequestInit) => (await (await fetch(url, init)).json()) as T;
const send = (url: string, method: string, body?: unknown) => fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

type Range = "today" | "week" | "month";

export default function TimelensView() {
  const st = useStore.getState;
  const [range, setRange] = useState<Range>("today");
  const [sum, setSum] = useState<Summary | null>(null);
  const [hist, setHist] = useState<History | null>(null);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [hover, setHover] = useState<{ x: number; seg: Seg } | null>(null);
  const [insight, setInsight] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"apps" | "goals" | "rules">("apps");
  const [newRule, setNewRule] = useState<Rule>({ match: "", field: "any", cat: "productive" });
  const [newGoal, setNewGoal] = useState({ target: "distracting", kind: "limit" as "goal" | "limit", mins: 60 });

  const span = useMemo(() => {
    const t = dayStart();
    return range === "today" ? { from: t, days: 7 } : range === "week" ? { from: t - 6 * 86_400_000, days: 7 } : { from: t - 29 * 86_400_000, days: 30 };
  }, [range]);

  const load = useCallback(async () => {
    try {
      const [s, h, g, cfg] = await Promise.all([
        j<Summary>(`/api/timelens/summary?from=${span.from}&to=${Date.now() + 1}`),
        j<History>(`/api/timelens/history?days=${span.days}`),
        j<Goal[]>("/api/timelens/goals"),
        j<{ rules: Rule[] }>("/api/timelens/config"),
      ]);
      setSum(s);
      setHist(h);
      setGoals(Array.isArray(g) ? g : []);
      setRules(cfg.rules ?? []);
    } catch {
      /* backend restarting — next tick */
    }
  }, [span]);

  useEffect(() => {
    void claim(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    void load();
    const iv = setInterval(() => !document.hidden && void load(), 30_000);
    return () => clearInterval(iv);
  }, [load]);

  const pause = async () => {
    const r = await (await send("/api/timelens/pause", "POST", { paused: !sum?.paused })).json();
    st().toast(r.paused ? "Timelens paused — nothing is recorded" : "Timelens resumed", r.paused ? "pause" : "play");
    void load();
  };
  const seed = async () => {
    await send("/api/timelens/seed", "POST", {});
    st().toast("Loaded a demo day", "sparkles");
    void load();
  };
  const exportAs = async (format: "csv" | "json") => {
    const r = await fetch(`/api/timelens/export?format=${format}&from=${span.from}&to=${Date.now() + 1}`);
    const ok = await saveFile(`timelens-${new Date().toISOString().slice(0, 10)}.${format}`, await r.blob(), format === "csv" ? "text/csv" : "application/json");
    if (ok) st().toast(`Exported ${format.toUpperCase()}`, "download");
  };
  const summarize = async () => {
    setBusy(true);
    try {
      const label = range === "today" ? "today" : range === "week" ? "this week" : "this month";
      const base = await j<{ text: string }>(`/api/timelens/insights?from=${span.from}&to=${Date.now() + 1}&label=${encodeURIComponent(label)}`);
      const { handleAiRequest } = await import("@/server/aiRoute");
      const pet = st().pet;
      const res = await handleAiRequest({ action: "timelens", text: base.text, title: label, persona: { name: pet.name, species: pet.species } }, (t) => setInsight(t));
      setInsight(res.text || base.text);
    } catch {
      setInsight("Couldn't summarize right now.");
    } finally {
      setBusy(false);
    }
  };
  const saveInsight = () => {
    const id = st().createNote({ title: `Timelens — ${new Date().toLocaleDateString()}`, content: insight });
    st().toast("Saved as a note", "check");
    setTimeout(() => st().openNote(id), 50);
  };
  const saveRules = async (next: Rule[]) => {
    setRules(next);
    await send("/api/timelens/config", "PUT", { rules: next });
    void load();
  };
  const saveGoals = async (next: { id: string; target: string; kind: string; mins: number }[]) => {
    await send("/api/timelens/config", "PUT", { goals: next });
    void load();
  };
  const claim = async (quiet = false) => {
    const r = await j<{ xp: number; coins: number; streak: number }>("/api/timelens/reward", { method: "POST" });
    if (r.xp > 0) {
      st().toast(`Productive day! +${r.xp} XP, +${r.coins} coins`, "star");
      st().doAct("happy", 1800);
      // the reward was written by Rust — pull the pet so the next autosave doesn't overwrite it
      const pet = await j<Record<string, unknown>>("/api/pet");
      if (pet && typeof pet === "object") useStore.setState({ pet: { ...st().pet, ...pet } as ReturnType<typeof st>["pet"] });
    } else if (!quiet) st().toast("No unclaimed productive days yet", "bell");
  };

  if (!sum) return <div className="grid h-full place-items-center"><div className="pixel-font text-dim shimmer rounded-xl px-5 py-3">loading…</div></div>;

  const empty = sum.activeSecs === 0 && sum.timeline.length === 0;
  const dayFrom = range === "today" ? sum.from : dayStart();
  const dayLen = 86_400_000;
  const total = sum.activeSecs || 1;
  const catTotal = sum.categories.productive + sum.categories.neutral + sum.categories.distracting || 1;
  const maxApp = Math.max(1, ...sum.apps.map((a) => a.secs));
  const maxHour = Math.max(1, ...sum.hourly);
  const heat = hist?.heatmap ?? [];
  const maxHeat = Math.max(1, ...heat.flat());
  const maxDay = Math.max(1, ...(hist?.days ?? []).map((d) => d.activeSecs));
  // donut arcs
  let acc = 0;
  const arcs = (["productive", "neutral", "distracting"] as const).map((k) => {
    const frac = sum.categories[k] / catTotal;
    const a = { k, start: acc, frac };
    acc += frac;
    return a;
  });

  return (
    <div className="scroll h-full" data-testid="timelens">
      <div className="mx-auto max-w-[1100px] px-1 pb-10">
        {/* header */}
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <div className="min-w-0">
            <div className="pixel-font flex items-center gap-2 text-[26px] leading-tight"><Icon name="gauge" size={22} className="text-accent" /> Timelens</div>
            <div className="text-[13px] text-dim">Where your day really went — tracked on this PC only, never uploaded.</div>
          </div>
          <span className="flex-1" />
          <div className="seg" role="tablist" aria-label="Range">
            {(["today", "week", "month"] as Range[]).map((r) => (
              <button key={r} role="tab" aria-selected={range === r} data-on={range === r} onClick={() => setRange(r)}>{r === "today" ? "Today" : r === "week" ? "7 days" : "30 days"}</button>
            ))}
          </div>
          <button className="btn btn-sm" onClick={() => void pause()} data-testid="tl-pause">
            <Icon name={sum.paused ? "play" : "pause"} size={13} /> {sum.paused ? "Resume" : "Pause"}
          </button>
          <button className="btn btn-sm" onClick={() => void exportAs("csv")} title="Export CSV"><Icon name="download" size={13} /> CSV</button>
          <button className="btn btn-sm" onClick={() => void exportAs("json")} title="Export JSON">JSON</button>
        </div>

        {/* live status */}
        <div className="paper mb-3 flex flex-wrap items-center gap-3 px-4 py-2.5 text-[12.5px]" data-testid="tl-live">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: sum.paused ? "var(--faint)" : sum.current.afk ? CAT_COLOR.neutral : sum.current.running ? CAT_COLOR.productive : "var(--faint)" }} />
          {sum.paused ? (
            <span className="text-dim">Paused — nothing is being recorded.</span>
          ) : sum.current.running ? (
            <span className="min-w-0 truncate">
              Now: <b className="pixel-font">{sum.current.afk ? "Away" : sum.current.app}</b>
              {sum.current.title && !sum.current.afk && <span className="text-dim"> · {sum.current.title}</span>}
              <span className="text-faint"> · since {clock(sum.current.since)}</span>
            </span>
          ) : (
            <span className="text-dim">The tracker runs in the desktop app. Spans you import or seed show up here too.</span>
          )}
          <span className="flex-1" />
          {hist && <span className="chip !text-[11px]" title="Consecutive productive days"><Icon name="fire" size={11} /> {hist.streak} day streak</span>}
          <button className="btn btn-sm" onClick={() => void claim(false)} title="Productive days pay your pet XP and coins"><Icon name="coins" size={12} /> Claim rewards</button>
        </div>

        {empty && (
          <div className="paper mb-3 flex flex-wrap items-center gap-3 p-4" data-testid="tl-empty">
            <Icon name="hourglass" size={22} className="text-accent" />
            <div className="min-w-0 flex-1">
              <div className="pixel-font text-[15px]">Nothing tracked {range === "today" ? "today" : "in this range"} yet</div>
              <div className="text-[12.5px] text-dim">Keep Nook running in the tray and Timelens fills in as you work. Want a preview?</div>
            </div>
            <button className="btn btn-accent btn-sm" onClick={() => void seed()}><Icon name="sparkles" size={13} /> Load a demo day</button>
          </div>
        )}

        {/* KPIs */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {[
            { k: "Active", v: fmt(sum.activeSecs), c: "var(--ink)" },
            { k: "Score", v: `${sum.score}`, c: sum.score >= 60 ? CAT_COLOR.productive : sum.score >= 40 ? CAT_COLOR.neutral : CAT_COLOR.distracting },
            { k: "Productive", v: fmt(sum.categories.productive), c: CAT_COLOR.productive },
            { k: "Distracting", v: fmt(sum.categories.distracting), c: CAT_COLOR.distracting },
            { k: "Focus", v: fmt(sum.focusSecs), c: CAT_COLOR.focus },
            { k: "Away", v: fmt(sum.afkSecs), c: "var(--dim)" },
          ].map((x) => (
            <div key={x.k} className="paper p-3">
              <div className="label">{x.k}</div>
              <div className="pixel-font mt-1 truncate text-[22px]" style={{ color: x.c }}>{x.v}</div>
            </div>
          ))}
        </div>

        {/* day timeline */}
        <div className="paper mt-3 p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Icon name="clock" size={13} className="text-accent" />
            <span className="label">Timeline — today</span>
            <span className="flex-1" />
            {Object.entries(CAT_COLOR).map(([k, c]) => (
              <span key={k} className="tiny-font flex items-center gap-1 text-[10px] text-faint"><i className="inline-block h-[7px] w-[7px]" style={{ background: c }} />{k}</span>
            ))}
          </div>
          <div
            className="relative h-9 overflow-hidden rounded-[8px] border border-line"
            style={{ background: "var(--panel2)" }}
            data-testid="tl-timeline"
            onMouseLeave={() => setHover(null)}
          >
            {(range === "today" ? sum.timeline : []).map((s, i) => {
              const left = ((s.start - dayFrom) / dayLen) * 100;
              const width = Math.max(0.15, ((s.end - s.start) / dayLen) * 100);
              const color = s.focus ? CAT_COLOR.focus : s.afk ? CAT_COLOR.afk : CAT_COLOR[s.cat] ?? CAT_COLOR.neutral;
              return (
                <i
                  key={i}
                  className="absolute block"
                  style={{ left: `${left}%`, width: `${width}%`, top: s.focus ? 0 : 6, bottom: s.focus ? "auto" : 0, height: s.focus ? 5 : undefined, background: color }}
                  onMouseEnter={(e) => setHover({ x: e.currentTarget.offsetLeft + e.currentTarget.offsetWidth / 2, seg: s })}
                />
              );
            })}
            {range === "today" && <i className="absolute bottom-0 top-0 w-[2px]" style={{ left: `${((Date.now() - dayFrom) / dayLen) * 100}%`, background: "var(--accent)" }} title="now" />}
            {hover && (
              <div className="panel panel-solid pointer-events-none absolute top-10 z-10 max-w-[280px] -translate-x-1/2 rounded-lg px-2.5 py-1.5 text-[11.5px]" style={{ left: Math.max(120, hover.x) }}>
                <b>{hover.seg.focus ? "Focus session" : hover.seg.afk ? "Away" : hover.seg.app}</b> · {fmt((hover.seg.end - hover.seg.start) / 1000)}
                <div className="truncate text-dim">{hover.seg.title || hover.seg.cat}</div>
                <div className="text-faint">{clock(hover.seg.start)} – {clock(hover.seg.end)}</div>
              </div>
            )}
          </div>
          <div className="tiny-font mt-1 flex justify-between text-[9.5px] text-faint">
            {["00:00", "06:00", "12:00", "18:00", "24:00"].map((t) => <span key={t}>{t}</span>)}
          </div>
          {/* hourly heat */}
          <div className="mt-3 grid gap-[3px]" style={{ gridTemplateColumns: "repeat(24, minmax(0, 1fr))" }} data-testid="tl-hourly">
            {sum.hourly.map((v, h) => (
              <div key={h} title={`${String(h).padStart(2, "0")}:00 · ${fmt(v)}`} className="h-5 rounded-[3px]" style={{ background: v ? `color-mix(in srgb, ${CAT_COLOR.productive} ${Math.round(20 + (v / maxHour) * 80)}%, var(--panel2))` : "var(--panel2)" }} />
            ))}
          </div>
        </div>

        <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_320px]">
          {/* apps / goals / rules */}
          <div className="paper min-w-0 p-4">
            <div className="seg mb-3" role="tablist">
              {([["apps", "Apps & sites"], ["goals", "Goals & limits"], ["rules", "Category rules"]] as const).map(([k, l]) => (
                <button key={k} role="tab" aria-selected={tab === k} data-on={tab === k} onClick={() => setTab(k)}>{l}</button>
              ))}
            </div>
            {tab === "apps" && (
              <div className="grid gap-1.5" data-testid="tl-apps">
                {sum.apps.length === 0 && <div className="py-3 text-[12.5px] text-faint">No apps tracked yet.</div>}
                {sum.apps.slice(0, 12).map((a) => (
                  <div key={a.app} className="grid grid-cols-[minmax(0,140px)_1fr_64px] items-center gap-2 text-[12.5px]">
                    <span className="truncate" title={a.app}>{a.app}</span>
                    <span className="h-3 overflow-hidden rounded-[3px] bg-panel2"><i className="block h-full" style={{ width: `${(a.secs / maxApp) * 100}%`, background: CAT_COLOR[a.cat] }} /></span>
                    <span className="text-right text-dim">{fmt(a.secs)}</span>
                  </div>
                ))}
                {sum.titles.length > 0 && <div className="label mt-3">Top windows & sites</div>}
                {sum.titles.slice(0, 6).map((t) => (
                  <div key={t.app + t.title} className="flex items-center gap-2 text-[12px]">
                    <span className="min-w-0 flex-1 truncate text-dim"><b className="text-ink">{t.app}</b> · {t.title}</span>
                    <span className="text-faint">{fmt(t.secs)}</span>
                  </div>
                ))}
              </div>
            )}
            {tab === "goals" && (
              <div className="grid gap-2" data-testid="tl-goals">
                {goals.map((g) => (
                  <div key={g.id} className="rounded-xl border border-line bg-panel2 p-2.5">
                    <div className="flex items-center gap-2 text-[12.5px]">
                      <Icon name={g.kind === "goal" ? "target" : "block"} size={13} className="text-accent" />
                      <b className="capitalize">{g.target}</b>
                      <span className="text-dim">{g.kind === "goal" ? "at least" : "at most"} {g.mins}m / day</span>
                      <span className="flex-1" />
                      <span style={{ color: g.exceeded ? CAT_COLOR.distracting : g.achieved ? CAT_COLOR.productive : "var(--dim)" }}>{g.usedMins}m</span>
                      <button className="icon-btn !h-6 !w-6" title="Remove" onClick={() => void saveGoals(goals.filter((x) => x.id !== g.id))}><Icon name="close" size={12} /></button>
                    </div>
                    <div className="mt-1.5 h-2 overflow-hidden rounded bg-[var(--panel)]"><i className="block h-full" style={{ width: `${Math.min(100, g.pct)}%`, background: g.kind === "limit" ? (g.exceeded ? CAT_COLOR.distracting : CAT_COLOR.neutral) : CAT_COLOR.productive }} /></div>
                  </div>
                ))}
                <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                  <select className="input !h-8 !w-auto" value={newGoal.kind} onChange={(e) => setNewGoal({ ...newGoal, kind: e.target.value as "goal" | "limit" })} aria-label="Goal kind">
                    <option value="limit">Limit</option>
                    <option value="goal">Goal</option>
                  </select>
                  <input className="input !h-8 !w-[150px]" value={newGoal.target} onChange={(e) => setNewGoal({ ...newGoal, target: e.target.value })} placeholder="category or app" aria-label="Goal target" list="tl-targets" />
                  <datalist id="tl-targets">{["productive", "neutral", "distracting", ...sum.apps.map((a) => a.app)].map((x) => <option key={x} value={x} />)}</datalist>
                  <input className="input !h-8 !w-[80px]" type="number" min={5} value={newGoal.mins} onChange={(e) => setNewGoal({ ...newGoal, mins: Number(e.target.value) })} aria-label="Minutes" />
                  <span className="text-dim">min/day</span>
                  <button className="btn btn-sm" disabled={!newGoal.target.trim()} onClick={() => void saveGoals([...goals.map(({ id, target, kind, mins }) => ({ id, target, kind, mins })), { id: `g-${Date.now().toString(36)}`, ...newGoal }])}>
                    <Icon name="plus" size={12} /> Add
                  </button>
                </div>
                <div className="text-[11.5px] text-faint">Crossing a limit sends a Windows notification once a day.</div>
              </div>
            )}
            {tab === "rules" && (
              <div className="grid gap-1.5" data-testid="tl-rules">
                <div className="text-[12px] text-dim">Your rules win over the built-in ones (VS Code = productive, YouTube in a browser title = distracting…). Browser tabs from Chrome, Edge and Firefox match by site.</div>
                {rules.map((r, i) => (
                  <div key={i} className="flex items-center gap-2 text-[12.5px]">
                    <i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: CAT_COLOR[r.cat] }} />
                    <b>{r.match}</b><span className="text-faint">in {r.field}</span><span className="text-dim">→ {r.cat}</span>
                    <span className="flex-1" />
                    <button className="icon-btn !h-6 !w-6" title="Remove rule" onClick={() => void saveRules(rules.filter((_, k) => k !== i))}><Icon name="close" size={12} /></button>
                  </div>
                ))}
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <input className="input !h-8 !w-[160px]" placeholder="e.g. figma, reddit" value={newRule.match} onChange={(e) => setNewRule({ ...newRule, match: e.target.value })} aria-label="Rule match" />
                  <select className="input !h-8 !w-auto" value={newRule.field} onChange={(e) => setNewRule({ ...newRule, field: e.target.value as Rule["field"] })} aria-label="Rule field">
                    <option value="any">app or title</option><option value="app">app</option><option value="title">title / site</option>
                  </select>
                  <select className="input !h-8 !w-auto" value={newRule.cat} onChange={(e) => setNewRule({ ...newRule, cat: e.target.value as Rule["cat"] })} aria-label="Rule category">
                    <option value="productive">productive</option><option value="neutral">neutral</option><option value="distracting">distracting</option>
                  </select>
                  <button className="btn btn-sm" disabled={!newRule.match.trim()} onClick={() => { void saveRules([{ ...newRule, match: newRule.match.trim() }, ...rules]); setNewRule({ ...newRule, match: "" }); }}><Icon name="plus" size={12} /> Add rule</button>
                </div>
              </div>
            )}
          </div>

          {/* donut */}
          <div className="paper flex flex-col items-center p-4">
            <div className="label self-start">Categories</div>
            <svg viewBox="0 0 120 120" width={150} height={150} className="my-2" data-testid="tl-donut" role="img" aria-label={`Productivity score ${sum.score}`}>
              <circle cx="60" cy="60" r="44" fill="none" stroke="var(--panel2)" strokeWidth="16" />
              {sum.activeSecs > 0 && arcs.map((a) => (
                <circle key={a.k} cx="60" cy="60" r="44" fill="none" stroke={CAT_COLOR[a.k]} strokeWidth="16" strokeDasharray={`${a.frac * 276.46} 276.46`} strokeDashoffset={-a.start * 276.46} transform="rotate(-90 60 60)" />
              ))}
              <text x="60" y="58" textAnchor="middle" fontSize="22" fill="var(--ink)" style={{ fontFamily: "var(--font-pixel)" }}>{sum.score}</text>
              <text x="60" y="74" textAnchor="middle" fontSize="9" fill="var(--faint)">score</text>
            </svg>
            {(["productive", "neutral", "distracting"] as const).map((k) => (
              <div key={k} className="flex w-full items-center gap-2 text-[12px]">
                <i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: CAT_COLOR[k] }} />
                <span className="capitalize">{k}</span><span className="flex-1" />
                <span className="text-dim">{fmt(sum.categories[k])} · {Math.round((sum.categories[k] / total) * 100)}%</span>
              </div>
            ))}
            {sum.peakHour !== null && <div className="mt-2 text-[11.5px] text-faint">Peak hour {String(sum.peakHour).padStart(2, "0")}:00</div>}
          </div>
        </div>

        {/* history + weekly heatmap */}
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <div className="paper p-4">
            <div className="label mb-2">{span.days === 30 ? "Last 30 days" : "Last 7 days"}</div>
            <div className="flex items-end gap-1" style={{ height: 96 }} data-testid="tl-history">
              {(hist?.days ?? []).map((d) => (
                <div key={d.day} className="flex min-w-0 flex-1 flex-col items-center gap-1" title={`${d.day} · ${fmt(d.activeSecs)} · score ${d.score}${d.productiveDay ? " · productive day ★" : ""}`}>
                  <div className="flex w-full max-w-[30px] flex-1 flex-col justify-end overflow-hidden rounded-[4px] bg-panel2">
                    {(["distracting", "neutral", "productive"] as const).map((k) => d[k] > 0 && <i key={k} className="block w-full" style={{ height: `${(d[k] / maxDay) * 100}%`, background: CAT_COLOR[k] }} />)}
                  </div>
                  {span.days <= 7 && <span className="tiny-font text-[9px] text-faint">{new Date(d.day + "T12:00").toLocaleDateString([], { weekday: "short" })}</span>}
                </div>
              ))}
            </div>
          </div>
          <div className="paper p-4">
            <div className="label mb-2">When you work (weekday × hour)</div>
            <div className="grid gap-[2px]" style={{ gridTemplateColumns: "28px repeat(24, minmax(0,1fr))" }} data-testid="tl-heatmap">
              {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((w, wi) => (
                <div key={w} className="contents">
                  <span className="tiny-font text-[9px] leading-[12px] text-faint">{w}</span>
                  {Array.from({ length: 24 }, (_, h) => {
                    const v = heat[wi]?.[h] ?? 0;
                    return <i key={h} className="block h-3 rounded-[2px]" title={`${w} ${h}:00 · ${fmt(v)}`} style={{ background: v ? `color-mix(in srgb, var(--accent) ${Math.round(15 + (v / maxHeat) * 85)}%, var(--panel2))` : "var(--panel2)" }} />;
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* AI insights */}
        <div className="paper mt-3 p-4" data-testid="tl-insights">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Icon name="sparkles" size={13} className="text-accent" />
            <span className="label">AI insights</span>
            <span className="flex-1" />
            <button className="btn btn-sm" onClick={() => void summarize()} disabled={busy}><Icon name="sparkles" size={12} /> {busy ? "Thinking…" : range === "today" ? "Summarize my day" : "Summarize my week"}</button>
            {insight && <button className="btn btn-sm" onClick={saveInsight}><Icon name="file-text" size={12} /> Save as note</button>}
          </div>
          {insight ? (
            <div className="selectable text-[13px]"><Markdown source={insight} titles={new Set()} onLink={() => {}} /></div>
          ) : (
            <div className="text-[12.5px] text-faint">Get a short read on your {range === "today" ? "day" : "week"}: what took your time, your best hours, and one thing to try. Works offline; uses your AI provider when one is set.</div>
          )}
        </div>
      </div>
    </div>
  );
}
