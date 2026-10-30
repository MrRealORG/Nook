/** Timelens secondary tabs (lazy chunk): Analytics, Goals, Focus mode, Settings & privacy. */
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Markdown } from "@/components/Markdown";
import { TimelensSettings } from "@/components/settings/TimelensSettings";
import { saveFile } from "@/lib/platform";
import { useStore } from "@/lib/store";
import { AppIcon, CAT_COLOR, CAT_LABEL, clock, dayStart, fmt, j, send, type Cat, type Goal, type History, type RegApp, type Summary } from "@/components/timelens/shared";

const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// ================================================================ analytics

export function Analytics() {
  const st = useStore.getState;
  const [range, setRange] = useState<7 | 30>(7);
  const [hist, setHist] = useState<History | null>(null);
  const [sum, setSum] = useState<Summary | null>(null);
  const [insight, setInsight] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const from = dayStart() - (range - 1) * 86_400_000;
    void Promise.all([j<History>(`/api/timelens/history?days=${range}`), j<Summary>(`/api/timelens/summary?from=${from}&to=${Date.now() + 1}`)])
      .then(([h, s]) => {
        setHist(h);
        setSum(s);
      })
      .catch(() => {});
  }, [range]);
  const summarize = async () => {
    setBusy(true);
    try {
      const label = range === 7 ? "this week" : "this month";
      const from = dayStart() - (range - 1) * 86_400_000;
      const base = await j<{ text: string }>(`/api/timelens/insights?from=${from}&to=${Date.now() + 1}&label=${encodeURIComponent(label)}`);
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
  const exportAs = async (format: "csv" | "json") => {
    const from = dayStart() - (range - 1) * 86_400_000;
    const r = await fetch(`/api/timelens/export?format=${format}&from=${from}&to=${Date.now() + 1}`);
    const ok = await saveFile(`timelens-${new Date().toISOString().slice(0, 10)}.${format}`, await r.blob(), format === "csv" ? "text/csv" : "application/json");
    if (ok) st().toast(`Exported ${format.toUpperCase()}`, "download");
  };
  if (!hist || !sum) return <div className="grid h-40 place-items-center text-[13px] text-faint">Loading…</div>;
  const maxDay = Math.max(1, ...hist.days.map((d) => d.activeSecs));
  const heatMax = Math.max(1, ...hist.heatmap.flat());
  const total = hist.days.reduce((a, d) => a + d.activeSecs, 0);
  const prod = hist.days.reduce((a, d) => a + d.productive, 0);
  const activeDays = hist.days.filter((d) => d.activeSecs > 0).length || 1;
  const bestHours = sum.hourlyProductive.map((v, h) => [h, v] as const).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return (
    <div className="grid gap-3" data-testid="tl-analytics">
      <div className="flex flex-wrap items-center gap-2">
        <div className="seg" role="group" aria-label="Analytics range">
          <button data-on={range === 7} onClick={() => setRange(7)}>Week</button>
          <button data-on={range === 30} onClick={() => setRange(30)}>Month</button>
        </div>
        <span className="flex-1" />
        <button className="btn btn-sm" onClick={() => void exportAs("csv")}><Icon name="download" size={13} /> CSV</button>
        <button className="btn btn-sm" onClick={() => void exportAs("json")}><Icon name="download" size={13} /> JSON</button>
        <button className="btn btn-sm btn-accent" onClick={() => void summarize()} disabled={busy}><Icon name="sparkles" size={13} /> {busy ? "Thinking…" : "AI insights"}</button>
      </div>
      <div className="tl-stats">
        <div className="tl-card tl-stat"><div className="tl-stat-label"><i style={{ background: "var(--accent)" }} />Total</div><div className="tl-stat-value">{fmt(total)}</div><div className="tl-stat-sub">{fmt(total / activeDays)} per active day</div></div>
        <div className="tl-card tl-stat"><div className="tl-stat-label"><i style={{ background: CAT_COLOR.productive }} />Productive</div><div className="tl-stat-value">{fmt(prod)}</div><div className="tl-stat-sub">{total ? Math.round((prod / total) * 100) : 0}% of tracked time</div></div>
        <div className="tl-card tl-stat"><div className="tl-stat-label"><i style={{ background: CAT_COLOR.focus }} />Focused</div><div className="tl-stat-value">{fmt(sum.focusedSecs)}</div><div className="tl-stat-sub">{sum.focusBlocks.length} deep-work blocks</div></div>
        <div className="tl-card tl-stat"><div className="tl-stat-label"><i style={{ background: CAT_COLOR.neutral }} />Streak</div><div className="tl-stat-value">{hist.streak}d</div><div className="tl-stat-sub">productive days in a row</div></div>
      </div>
      <div className="tl-card">
        <div className="tl-card-head"><span>Daily time by category</span></div>
        <div className="tl-bars" data-testid="tl-history">
          {hist.days.map((d) => (
            <div key={d.day} className="tl-bar" title={`${d.day} · ${fmt(d.activeSecs)} · score ${d.score}`}>
              <div className="tl-bar-stack" style={{ height: `${(d.activeSecs / maxDay) * 100}%` }}>
                {(["distracting", "neutral", "productive"] as Cat[]).map((k) => <i key={k} style={{ flex: d[k] || 0, background: CAT_COLOR[k] }} />)}
              </div>
              <span>{range === 7 ? WD[(new Date(d.day + "T12:00").getDay() + 6) % 7] : Number(d.day.slice(8))}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="tl-grid2">
        <div className="tl-card">
          <div className="tl-card-head"><span>When you work</span><span className="text-faint">weekday × hour</span></div>
          <div className="tl-heat" data-testid="tl-heatmap">
            {hist.heatmap.map((row, wd) => (
              <div key={wd} className="contents">
                <span className="tl-heat-label">{WD[wd]}</span>
                {row.map((v, h) => <i key={h} title={`${WD[wd]} ${String(h).padStart(2, "0")}:00 · ${fmt(v)}`} style={{ background: v ? `color-mix(in srgb, var(--accent) ${Math.round(12 + (v / heatMax) * 88)}%, transparent)` : "var(--panel2)" }} />)}
              </div>
            ))}
            <span />
            {Array.from({ length: 24 }, (_, h) => <span key={h} className="tl-heat-h">{h % 6 === 0 ? h : ""}</span>)}
          </div>
        </div>
        <div className="tl-card">
          <div className="tl-card-head"><span>Focus patterns</span></div>
          <div className="grid gap-2 text-[13px]">
            {bestHours.length === 0 && <div className="text-faint">Not enough data yet.</div>}
            {bestHours.map(([h, v], i) => (
              <div key={h} className="flex items-center gap-2">
                <span className="w-5 text-faint">{i + 1}.</span>
                <span className="flex-1">{String(h).padStart(2, "0")}:00 – {String((h + 1) % 24).padStart(2, "0")}:00</span>
                <b>{fmt(v)}</b>
              </div>
            ))}
            <div className="mt-1 text-[12px] text-faint">Your most productive hours across the period — schedule deep work there.</div>
            <div className="label mt-2">Categories</div>
            {(["productive", "neutral", "distracting"] as Cat[]).map((k) => (
              <div key={k} className="flex items-center gap-2">
                <i className="h-2.5 w-2.5 rounded-full" style={{ background: CAT_COLOR[k] }} />
                <span className="flex-1 text-dim">{CAT_LABEL[k]}</span>
                <span className="w-12 text-right text-faint">{sum.activeSecs ? Math.round((sum.categories[k] / sum.activeSecs) * 100) : 0}%</span>
                <b className="w-16 text-right">{fmt(sum.categories[k])}</b>
              </div>
            ))}
          </div>
        </div>
      </div>
      {insight && (
        <div className="tl-card" data-testid="tl-insights">
          <div className="tl-card-head"><span>Insights</span><button className="tl-link" onClick={() => { const id = st().createNote({ title: `Timelens — ${new Date().toLocaleDateString()}`, content: insight }); setTimeout(() => st().openNote(id), 50); }}>Save as note →</button></div>
          <div className="md text-[14px]"><Markdown source={insight} titles={new Set()} onLink={() => {}} /></div>
        </div>
      )}
    </div>
  );
}

// ================================================================ goals

export function Goals() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [apps, setApps] = useState<string[]>([]);
  const [g, setG] = useState({ target: "distracting", kind: "limit" as "goal" | "limit", mins: 60 });
  const load = useCallback(async () => {
    setGoals(await j<Goal[]>("/api/timelens/goals").catch(() => []));
    setApps((await j<RegApp[]>("/api/timelens/apps?days=30").catch(() => [])).map((a) => a.app));
  }, []);
  useEffect(() => void load(), [load]);
  const save = async (next: { id: string; target: string; kind: string; mins: number }[]) => {
    await send("/api/timelens/config", "PUT", { goals: next });
    void load();
  };
  const raw = goals.map(({ id, target, kind, mins }) => ({ id, target, kind, mins }));
  return (
    <div className="grid gap-3" data-testid="tl-goals">
      <div className="tl-card">
        <div className="tl-card-head"><span>Today's goals & limits</span></div>
        <div className="grid gap-2">
          {goals.length === 0 && <div className="text-[13px] text-faint">No goals yet — add one below.</div>}
          {goals.map((x) => {
            const color = x.kind === "limit" ? (x.exceeded ? CAT_COLOR.distracting : CAT_COLOR.neutral) : CAT_COLOR.productive;
            return (
              <div key={x.id} className="tl-goal">
                <div className="flex items-center gap-2">
                  {["productive", "neutral", "distracting"].includes(x.target) ? <i className="h-3 w-3 rounded-full" style={{ background: CAT_COLOR[x.target] }} /> : <AppIcon app={x.target} size={18} />}
                  <b className="capitalize">{x.target}</b>
                  <span className="text-dim">{x.kind === "goal" ? "at least" : "at most"} {x.mins}m a day</span>
                  <span className="flex-1" />
                  <span style={{ color }}>{x.usedMins}m {x.achieved ? "· done" : x.exceeded ? "· over" : ""}</span>
                  <button className="icon-btn !h-7 !w-7" aria-label={`Remove goal ${x.target}`} onClick={() => void save(raw.filter((y) => y.id !== x.id))}><Icon name="close" size={12} /></button>
                </div>
                <div className="tl-progress"><i style={{ width: `${Math.min(100, x.pct)}%`, background: color }} /></div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="tl-card flex flex-wrap items-center gap-2 text-[13px]">
        <select className="input !h-8 !w-auto" value={g.kind} onChange={(e) => setG({ ...g, kind: e.target.value as "goal" | "limit" })} aria-label="New goal kind">
          <option value="limit">Limit (at most)</option>
          <option value="goal">Goal (at least)</option>
        </select>
        <input className="input !h-8 !w-[180px]" value={g.target} onChange={(e) => setG({ ...g, target: e.target.value })} placeholder="category or app" aria-label="New goal target" list="tl-goal-list" />
        <datalist id="tl-goal-list">{["productive", "neutral", "distracting", ...apps].map((x) => <option key={x} value={x} />)}</datalist>
        <input className="input !h-8 !w-[90px]" type="number" min={5} value={g.mins} onChange={(e) => setG({ ...g, mins: Number(e.target.value) || 30 })} aria-label="New goal minutes" />
        <span className="text-faint">min / day</span>
        <button className="btn btn-sm btn-accent" onClick={() => g.target.trim() && void save([...raw, { id: `g-${Date.now()}`, ...g, target: g.target.trim() }])}><Icon name="plus" size={13} /> Add</button>
      </div>
    </div>
  );
}

// ================================================================ focus mode

export function FocusMode({ sum }: { sum: Summary }) {
  const timer = useStore((s) => s.timer);
  const shieldOn = useStore((s) => s.rules.shieldOn);
  const st = useStore.getState;
  const mm = String(Math.floor(timer.remaining / 60)).padStart(2, "0");
  const ss = String(timer.remaining % 60).padStart(2, "0");
  return (
    <div className="grid gap-3" data-testid="tl-focus">
      <div className="tl-grid2">
        <div className="tl-card grid place-items-center gap-3 py-6">
          <div className="text-[12px] font-semibold uppercase tracking-wide text-faint">{timer.mode === "focus" ? "Focus session" : "Break"}</div>
          <div className="text-[52px] font-semibold tabular-nums leading-none">{mm}:{ss}</div>
          <div className="flex gap-2">
            {timer.running ? (
              <button className="btn" onClick={() => st().pauseTimer()}><Icon name="pause" size={14} /> Pause</button>
            ) : (
              <button className="btn btn-accent" onClick={() => st().startTimer()} data-testid="tl-focus-start"><Icon name="play" size={14} /> Start focus</button>
            )}
            <button className="btn" onClick={() => st().resetTimer("focus")}><Icon name="reload" size={14} /> Reset</button>
          </div>
          <div className="text-[12px] text-faint">Finished sessions are recorded in Timelens as focus time.</div>
        </div>
        <div className="tl-card grid gap-3">
          <div className="tl-card-head"><span>Distraction shield</span></div>
          <label className="flex items-center gap-3 text-[13px]">
            <input type="checkbox" checked={shieldOn} onChange={(e) => st().setRules({ shieldOn: e.target.checked })} />
            <span>Nudge me when I open blocked or over-limit apps</span>
          </label>
          <button className="btn btn-sm justify-self-start" onClick={() => st().setView("rules")}><Icon name="shield" size={13} /> Edit block list & limits</button>
          <div className="label mt-2">Deep work today</div>
          {sum.focusBlocks.length === 0 && <div className="text-[13px] text-faint">No deep-work blocks yet (10+ minutes of uninterrupted productive work).</div>}
          {sum.focusBlocks.map(([a, b]) => (
            <div key={a} className="flex items-center gap-2 text-[13px]">
              <i className="h-2.5 w-2.5 rounded-full" style={{ background: CAT_COLOR.focus }} />
              <span className="flex-1">{clock(a)} – {clock(b)}</span>
              <b>{fmt((b - a) / 1000)}</b>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ================================================================ settings & privacy

export function Privacy({ onChange }: { onChange: () => void }) {
  const st = useStore.getState;
  const [cfg, setCfg] = useState<{ favicons: boolean; excludeApps: string[] } | null>(null);
  const load = useCallback(() => void j<{ favicons: boolean; excludeApps: string[] }>("/api/timelens/config").then(setCfg).catch(() => {}), []);
  useEffect(load, [load]);
  const setFav = async (on: boolean) => {
    await send("/api/timelens/config", "PUT", { favicons: on });
    load();
  };
  const include = async (app: string) => {
    await send(`/api/timelens/apps/${encodeURIComponent(app)}`, "PATCH", { excluded: false });
    load();
    onChange();
  };
  const purge = async (app: string) => {
    await send(`/api/timelens/apps/${encodeURIComponent(app)}`, "PATCH", { excluded: true, purge: true });
    st().toast(`Deleted all ${app} history`, "trash");
    load();
    onChange();
  };
  const wipeToday = async () => {
    await fetch(`/api/timelens/spans?from=${dayStart()}&to=${Date.now() + 1}`, { method: "DELETE" });
    st().toast("Today's tracking deleted", "trash");
    onChange();
  };
  return (
    <div className="grid gap-3" data-testid="tl-privacy">
      <div className="tl-card grid gap-3 text-[13px]">
        <div className="tl-card-head"><span>Privacy</span></div>
        <div className="flex items-start gap-3"><Icon name="lock" size={16} className="mt-0.5 text-accent" /><div>Everything Timelens records stays in your local vault. Nothing is uploaded.</div></div>
        <label className="flex items-center gap-3">
          <input type="checkbox" checked={!!cfg?.favicons} onChange={(e) => void setFav(e.target.checked)} aria-label="Fetch website favicons" />
          <span>Fetch website icons (one request to <code>https://site/favicon.ico</code> per site, then cached)</span>
        </label>
        <div>
          <div className="label mb-1">Excluded apps</div>
          {!cfg?.excludeApps.length && <div className="text-faint">None — exclude an app from the Apps tab.</div>}
          <div className="grid gap-1">
            {cfg?.excludeApps.map((a) => (
              <div key={a} className="tl-row">
                <AppIcon app={a} size={20} />
                <span className="tl-row-name">{a}</span>
                <button className="btn btn-sm" onClick={() => void include(a)}>Track again</button>
                <button className="btn btn-sm" onClick={() => void purge(a)}><Icon name="trash" size={12} /> Delete history</button>
              </div>
            ))}
          </div>
        </div>
        <button className="btn btn-sm justify-self-start" onClick={() => void wipeToday()}><Icon name="trash" size={13} /> Delete today's data</button>
      </div>
      <TimelensSettings />
    </div>
  );
}
