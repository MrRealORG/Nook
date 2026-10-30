
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/icons";
import { PetView } from "@/components/PetView";
import { categorize, useStore, type AppCat } from "@/lib/store";
import { AppLogo } from "@/lib/appLogos";
import { matchesRule } from "@/lib/rules";
import { todayKey, yesterdayKey } from "@/lib/quests";

/** apps a person is likely toggling to — the manual dock mirrors TimeLens' desktop agent for the web */
export const DOCK: { id: string; label: string; icon: IconName }[] = [
  { id: "youtube", label: "YouTube", icon: "play" },
  { id: "discord", label: "Discord", icon: "message-text" },
  { id: "chrome", label: "Browser", icon: "globe" },
  { id: "vscode", label: "VS Code", icon: "code" },
  { id: "spotify", label: "Spotify", icon: "waves" },
  { id: "games", label: "Games", icon: "gamepad" },
  { id: "docs", label: "Docs", icon: "file-text" },
  { id: "terminal", label: "Terminal", icon: "terminal" },
];

export const CATS: { id: AppCat; label: string; color: string; hint: string }[] = [
  { id: "productive", label: "Productive", color: "#7fc48f", hint: "counts toward your daily goal" },
  { id: "neutral", label: "Neutral", color: "#d9c98a", hint: "neither here nor there" },
  { id: "distraction", label: "Distraction", color: "#e08a6a", hint: "the sneaky stuff" },
];

export const fmt = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m` : s <= 0 ? "0m" : `${Math.max(1, Math.round(s / 60))}m`);
export const CAT_COLOR: Record<AppCat, string> = { productive: "#7fc48f", neutral: "#d9c98a", distraction: "#e08a6a" };

type DbRow = { app: string; cat: string; day: string; secs: number };

export function ActivityView() {
  const appUse = useStore((s) => s.appUse);
  const appTimeline = useStore((s) => s.appTimeline);
  const appCat = useStore((s) => s.appCat);
  const currentApp = useStore((s) => s.currentApp);
  const activityGoal = useStore((s) => s.activityGoal);
  const focusLog = useStore((s) => s.focusLog);
  const pet = useStore((s) => s.pet);
  const rules = useStore((s) => s.rules);
  const customDock = useStore((s) => s.customDock);
  const blockedAttempts = useStore((s) => s.blockedAttempts);
  const [range, setRange] = useState<1 | 7>(1);
  const [db, setDb] = useState<DbRow[]>([]);
  const [manual, setManual] = useState({ app: "", mins: "30" });
  const [copied, setCopied] = useState(false);
  const [newDock, setNewDock] = useState("");
  const [blockTest, setBlockTest] = useState("");
  const st = useStore.getState;

  // merged data: live local buckets + DB (manual entries + external agents + older web data)
  useEffect(() => {
    void fetch("/api/activity?days=7")
      .then((r) => r.json())
      .then((rows: DbRow[]) => setDb(Array.isArray(rows) ? rows : []))
      .catch(() => setDb([]));
  }, [appUse]);
  const merged = useMemo(() => {
    const m = new Map<string, number>(); // app|day → secs
    for (const r of db) m.set(`${r.app}|${r.day}`, (m.get(`${r.app}|${r.day}`) ?? 0) + r.secs);
    for (const [k, v] of Object.entries(appUse)) {
      const [day, app] = [k.slice(0, 10), k.slice(11)];
      m.set(`${app}|${day}`, Math.max(m.get(`${app}|${day}`) ?? 0, v));
    }
    return m;
  }, [db, appUse]);

  const catOf = (app: string): AppCat => categorize(app, appCat, rules.patterns);

  const perApp = useMemo(() => {
    const days = range === 1 ? [todayKey()] : undefined;
    const m = new Map<string, number>();
    for (const [k, v] of merged) {
      const [app, day] = [k.slice(0, k.lastIndexOf("|")), k.slice(k.lastIndexOf("|") + 1)];
      if (days && !days.includes(day)) continue;
      if (range === 7 && !db.some((r) => r.day === day) && day !== todayKey() && day !== yesterdayKey()) continue;
      m.set(app, (m.get(app) ?? 0) + v);
    }
    return [...m.entries()].filter(([, v]) => v > 30).sort((a, b) => b[1] - a[1]);
  }, [merged, range, db]);

  const totals = useMemo(() => {
    const t: Record<AppCat, number> = { productive: 0, neutral: 0, distraction: 0 };
    for (const [app, v] of perApp) t[categorize(app, appCat, rules.patterns)] += v;
    return t;
  }, [perApp, appCat, rules.patterns]);

  const total = totals.productive + totals.neutral + totals.distraction;
  const focusMin = focusLog[todayKey()] ?? 0;
  const goalPct = Math.min(1, totals.productive / 60 / activityGoal);
  const maxSecs = Math.max(1, ...(perApp.map(([, v]) => v)));

  // productivity score 0–100: productive share minus distraction drag
  const score = useMemo(() => {
    if (!total) return null;
    const pShare = totals.productive / total;
    const dShare = totals.distraction / total;
    return Math.max(0, Math.min(100, Math.round(pShare * 100 - dShare * 35 + (focusMin > 0 ? 5 : 0))));
  }, [total, totals, focusMin]);

  // 7-day totals + score trend (from DB rows + local buckets)
  const week = useMemo(() => {
    const days: { day: string; label: string; secs: number; byCat: Record<AppCat, number> }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      days.push({ day: key, label: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()], secs: 0, byCat: { productive: 0, neutral: 0, distraction: 0 } });
    }
    const idx = new Map(days.map((d, i) => [d.day, i]));
    for (const [k, v] of merged) {
      const day = k.slice(k.lastIndexOf("|") + 1);
      const i = idx.get(day);
      if (i == null) continue;
      const app = k.slice(0, k.lastIndexOf("|"));
      days[i].secs += v;
      days[i].byCat[categorize(app, appCat, rules.patterns)] += v;
    }
    return days;
  }, [merged, appCat, rules.patterns]);
  const weekMax = Math.max(1, ...week.map((d) => d.secs));

  // auto insights
  const insights = useMemo(() => {
    const out: { icon: IconName; text: string }[] = [];
    if (!perApp.length) return out;
    const top = perApp[0];
    const topLabel = top[0].startsWith("nook:") ? `Nook · ${top[0].slice(5)}` : top[0];
    out.push({ icon: "crown", text: `${topLabel} owns the day with ${fmt(top[1])}` });
    const hourTotals = new Array(24).fill(0) as number[];
    for (const [k, v] of Object.entries(appTimeline)) {
      if (!k.startsWith(todayKey())) continue;
      hourTotals[Number(k.split("|")[1])] += v;
    }
    const peak = hourTotals.indexOf(Math.max(...hourTotals));
    if (hourTotals[peak] > 0) out.push({ icon: "sun", text: `Your peak hour is ${String(peak).padStart(2, "0")}:00 — ${fmt(hourTotals[peak])} tracked` });
    const dist = perApp.filter(([a]) => catOf(a) === "distraction").sort((a, b) => b[1] - a[1])[0];
    if (dist) out.push({ icon: "alert", text: `${dist[0]} ate ${fmt(dist[1])} of focus — cap it in Rules?` });
    const prodApps = perApp.filter(([a]) => catOf(a) === "productive").length;
    if (prodApps >= 3) out.push({ icon: "check-double", text: `${prodApps} productive apps in rotation — nice spread` });
    return out;
  }, [perApp, appTimeline, appCat, rules.patterns]);

  const usedTodayFor = (app: string) => appUse[`${todayKey()}|${app}`] ?? 0;
  const limitFor = (app: string) => rules.limits[app.toLowerCase()] ?? 0;

  const exportCsv = () => {
    const rows = ["app,day,category,minutes"];
    for (const [k, v] of merged) {
      const app = k.slice(0, k.lastIndexOf("|"));
      const day = k.slice(k.lastIndexOf("|") + 1);
      rows.push(`"${app}",${day},${categorize(app, appCat, rules.patterns)},${Math.round(v / 60)}`);
    }
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nook-activity-${todayKey()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    st().toast("Activity exported as CSV", "download");
  };

  // yesterday comparison for trend chips
  const yTotal = useMemo(() => {
    let s = 0;
    for (const [k, v] of merged) if (k.endsWith(`|${yesterdayKey()}`)) s += v;
    return s;
  }, [merged]);

  // today's hourly timeline strip (category colors)
  const timeline = useMemo(() => {
    const cells: { h: number; cats: { cat: AppCat; secs: number }[] }[] = [];
    for (let h = 0; h < 24; h++) {
      const cats: { cat: AppCat; secs: number }[] = [];
      for (const c of CATS) {
        const v = appTimeline[`${todayKey()}|${h}|${c.id}`] ?? 0;
        if (v > 0) cats.push({ cat: c.id, secs: v });
      }
      cats.sort((a, b) => b.secs - a.secs);
      cells.push({ h, cats });
    }
    return cells;
  }, [appTimeline]);

  return (
    <div className="scroll h-full">
      <div className="mx-auto max-w-[900px] px-1 pb-10">
        {/* header */}
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div>
            <div className="pixel-font text-[26px] leading-tight">Activity</div>
            <div className="text-[13px] text-dim">A timeline of where the day really went — tracked live, apps you toggle to, and anything an agent reports.</div>
          </div>
          <div className="flex-1" />
          <div className="seg">
            <button data-on={range === 1} onClick={() => setRange(1)}>today</button>
            <button data-on={range === 7} onClick={() => setRange(7)}>7 days</button>
          </div>
          <button className="btn btn-sm" onClick={exportCsv} title="Download the raw log">
            <Icon name="download" size={12} /> CSV
          </button>
          <button className="btn btn-sm btn-accent" onClick={() => st().setView("rules")} title="Manage rules">
            <Icon name="shield" size={12} /> Rules
          </button>
        </div>

        {/* top numbers */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <div className="paper p-4">
            <div className="label">Total tracked</div>
            <div className="pixel-font mt-1 text-[26px] leading-none">{fmt(total)}</div>
            {range === 1 && yTotal > 0 && (
              <div className="mt-1 text-[11.5px]" style={{ color: total >= yTotal ? "var(--accent)" : "var(--faint)" }}>
                <Icon name={total >= yTotal ? "arrow-up" : "arrow-down"} size={11} /> vs yesterday {fmt(yTotal)}
              </div>
            )}
          </div>
          {/* productivity score */}
          <div className="paper p-4" title="Productive share − distraction drag + focus bonus">
            <div className="label">Focus score</div>
            {score === null ? (
              <div className="mt-1 text-[12.5px] text-faint">track some time to score the day</div>
            ) : (
              <>
                <div className="pixel-font mt-1 flex items-baseline gap-1 text-[26px] leading-none" style={{ color: score >= 70 ? "#7fc48f" : score >= 40 ? "#d9c98a" : "#e08a6a" }}>
                  {score}
                  <span className="text-[13px] text-faint">/100</span>
                </div>
                <div className="score-bar mt-2"><i style={{ width: `${score}%`, background: score >= 70 ? "#7fc48f" : score >= 40 ? "#d9c98a" : "#e08a6a" }} /></div>
                {score >= 70 && <div className="mt-1 text-[11px]" style={{ color: "#7fc48f" }}>strong day 🔥</div>}
              </>
            )}
          </div>
          {CATS.map((c) => (
            <div key={c.id} className="paper p-4" title={c.hint}>
              <div className="label flex items-center gap-1.5"><i className="inline-block h-[8px] w-[8px]" style={{ background: c.color }} />{c.label}</div>
              <div className="pixel-font mt-1 text-[26px] leading-none" style={{ color: c.color }}>{fmt(totals[c.id])}</div>
              <div className="mt-1 text-[11.5px] text-faint">{total ? Math.round((totals[c.id] / total) * 100) : 0}% of tracked</div>
            </div>
          ))}
        </div>

        {/* insights strip */}
        {insights.length > 0 && (
          <div className="paper mt-3 flex flex-wrap items-center gap-2 p-3">
            <span className="label mr-1">Insights</span>
            {insights.map((n, i) => (
              <span key={i} className="chip !text-[11.5px]" style={{ animation: `rise .35s var(--ease-soft) both`, animationDelay: `${i * 60}ms` }}>
                <Icon name={n.icon} size={12} className="text-accent" /> {n.text}
              </span>
            ))}
          </div>
        )}

        {/* 7-day stacked bars */}
        <div className="paper mt-4 p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Icon name="chart" size={13} className="text-accent" />
            <span className="label">Week at a glance</span>
            <span className="flex-1" />
            {CATS.map((c) => (
              <span key={c.id} className="tiny-font flex items-center gap-1 text-[10px] text-faint">
                <i className="inline-block h-[7px] w-[7px]" style={{ background: c.color }} />{c.label}
              </span>
            ))}
          </div>
          <div className="flex items-end gap-2" style={{ height: 92 }}>
            {week.map((d) => {
              const dayScore = d.secs ? Math.round((d.byCat.productive / d.secs) * 100) : null;
              const isToday = d.day === todayKey();
              return (
                <div key={d.day} className="flex min-w-0 flex-1 flex-col items-center gap-1" title={`${d.label} · ${fmt(d.secs)} total${dayScore !== null ? ` · ${dayScore}% productive` : ""}`}>
                  <div className="flex w-full max-w-[44px] flex-1 flex-col justify-end overflow-hidden rounded-[5px]" style={{ background: "var(--panel2)" }}>
                    {CATS.map((c) => {
                      const v = d.byCat[c.id];
                      if (!v) return null;
                      return <i key={c.id} className="block w-full" style={{ height: `${(v / weekMax) * 100}%`, background: c.color, opacity: 0.85 }} />;
                    })}
                  </div>
                  <span className="tiny-font text-[9.5px]" style={{ color: isToday ? "var(--accent)" : "var(--faint)" }}>{d.label}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* goal ring + focus */}
        <div className="paper mt-4 flex flex-wrap items-center gap-5 p-4">
          <div className="goal-ring !h-[76px] !w-[76px]" style={{ ["--p" as string]: Math.round(goalPct * 100) }} title="Daily productive-time goal">
            <div className="grid place-items-center">
              <span className="pixel-font text-[15px]">{Math.round(goalPct * 100)}%</span>
              <span className="text-[9.5px] text-faint">goal</span>
            </div>
          </div>
          <div className="min-w-[180px] flex-1">
            <div className="label mb-1">Daily productive goal</div>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={30}
                max={600}
                step={30}
                value={activityGoal}
                onChange={(e) => st().set({ activityGoal: Number(e.target.value) })}
                className="min-w-[120px] flex-1"
                aria-label="Daily productive goal in minutes"
              />
              <span className="pixel-font text-[14px] text-accent">{Math.floor(activityGoal / 60)}h {activityGoal % 60 ? `${activityGoal % 60}m` : ""}</span>
            </div>
          </div>
          <div className="chip" data-on={focusMin > 0} title="Focused minutes today come from your Focus sessions">
            <Icon name="hourglass" size={12} className="text-accent" /> {focusMin} focus min today
          </div>
        </div>

        {/* timeline strip */}
        {range === 1 && (
          <div className="paper mt-4 p-4">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Icon name="activity" size={13} className="text-accent" />
              <span className="label">Timeline — today</span>
              <span className="flex-1" />
              {CATS.map((c) => (
                <span key={c.id} className="tiny-font flex items-center gap-1 text-[10px] text-faint">
                  <i className="inline-block h-[7px] w-[7px]" style={{ background: c.color }} />
                  {c.label}
                </span>
              ))}
            </div>
            <div className="tl-strip" role="img" aria-label="Hourly timeline of today's tracked activity">
              {timeline.map((c) => (
                <div key={c.h} className="tl-cell" title={`${String(c.h).padStart(2, "0")}:00 — ${c.cats.length ? c.cats.map((x) => `${x.cat} ${fmt(x.secs)}`).join(", ") : "no data"}`} data-active={c.cats.length > 0}>
                  {c.cats.map((x, i) => (
                    <i key={x.cat} style={{ background: CAT_COLOR[x.cat], opacity: i === 0 ? 1 : 0.55, height: `${Math.max(14, Math.min(100, (x.secs / 900) * 100))}%` }} />
                  ))}
                </div>
              ))}
            </div>
            <div className="mt-1 flex justify-between text-[9.5px] text-faint">
              {[0, 6, 12, 18, 23].map((h) => <span key={h}>{String(h).padStart(2, "0")}:00</span>)}
            </div>
          </div>
        )}

        {/* app dock — what are you doing right now? */}
        <div className="paper mt-4 p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Icon name="app-windows" size={13} className="text-accent" />
            <span className="label">What are you using right now?</span>
            <span className="flex-1" />
            <span className="text-[11px] text-faint">tap before you hop over — it keeps the log honest</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {DOCK.map((d) => (
              <button
                key={d.id}
                className={`dock-btn ${currentApp === d.id ? "!border-accent" : ""}`}
                data-on={currentApp === d.id}
                onClick={() => st().setCurrentApp(currentApp === d.id ? null : d.id)}
                title={currentApp === d.id ? `Stop logging ${d.label}` : `Log time as ${d.label}`}
              >
                <AppLogo app={d.id} size={15} />
                {d.label}
                {currentApp === d.id && <i className="rec-dot" />}
              </button>
            ))}
            {customDock.map((a) => (
              <button
                key={a}
                className="dock-btn custom-dock-btn"
                data-on={currentApp === a}
                onClick={() => st().setCurrentApp(currentApp === a ? null : a)}
                title={`${currentApp === a ? `Stop logging ${a}` : `Log time as ${a}`} · right-click to remove`}
                onContextMenu={(e) => { e.preventDefault(); st().removeCustomDock(a); }}
              >
                <Icon name="app-windows" size={13} />
                {a}
                {currentApp === a && <i className="rec-dot" />}
              </button>
            ))}
            <div className="flex items-center gap-1">
              <input className="input !h-[30px] !w-[118px] !text-[12px]" placeholder="+ your app…" value={newDock} onChange={(e) => setNewDock(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (st().addCustomDock(newDock), setNewDock(""))} aria-label="Add a dock app" />
              <div className="flex w-full flex-wrap items-center gap-1" title="Tap a real app to add it with its logo">
                {["github", "figma", "slack", "notion", "telegram", "steam", "twitch", "reddit"].filter((a) => !customDock.some((c) => c.toLowerCase() === a)).map((a) => (
                  <button key={a} className="pulse-chip !py-0.5" onClick={() => st().addCustomDock(a)} aria-label={`Add ${a} to dock`}>
                    <AppLogo app={a} size={12} /> <span className="tiny-font">{a}</span>
                  </button>
                ))}
              </div>
              {newDock.trim() && <button className="btn btn-sm !h-[30px]" onClick={() => { st().addCustomDock(newDock); setNewDock(""); }}><Icon name="plus" size={12} /></button>}
            </div>
            {currentApp && (
              <button className="btn btn-sm" onClick={() => st().setCurrentApp(null)}>
                <Icon name="stop" size={12} /> stop
              </button>
            )}
          </div>
          {/* manual backfill */}
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <input className="input !w-[150px]" placeholder="app name…" value={manual.app} onChange={(e) => setManual({ ...manual, app: e.target.value })} />
            <input className="input !w-[86px]" type="number" min={1} max={720} value={manual.mins} onChange={(e) => setManual({ ...manual, mins: e.target.value })} aria-label="minutes" />
            <span className="text-[12px] text-faint">min</span>
            <button
              className="btn btn-sm"
              disabled={!manual.app.trim()}
              onClick={() => {
                void st().logManualApp(manual.app.trim(), Number(manual.mins) || 30);
                setManual({ app: "", mins: "30" });
              }}
            >
              <Icon name="plus" size={12} /> backfill
            </button>
            <span className="text-[11px] text-faint">forgot to tap? add the time retroactively</span>
          </div>
        </div>

        {/* app rows */}
        <div className="paper mt-4 p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Icon name="chart" size={13} className="text-accent" />
            <span className="label">{range === 1 ? "Today" : "Last 7 days"} by app</span>
            <span className="flex-1" />
            <span className="text-[11px] text-faint">click a category dot to re-triage an app</span>
          </div>
          {perApp.length === 0 ? (
            <div className="flex items-center gap-3 py-4 text-[13px] text-faint">
              <PetView species={pet.species} tint={pet.look} hat={pet.hat} mood="think" scale={2} fps={5} />
              No time tracked yet — keep the Nook open, use the dock above, or backfill manually. {pet.name} is watching the clock.
            </div>
          ) : (
            <div className="space-y-1.5">
              {perApp.map(([app, secs], i) => {
                const cat = catOf(app);
                const label = app.startsWith("nook:") ? `Nook · ${app.slice(5)}` : app;
                const share = (secs / total) * 100;
                const blocked = rules.blocklist.some((b) => b.enabled && matchesRule(app, b.match));
                const limitMins = limitFor(app);
                const usedToday = range === 1 ? secs : usedTodayFor(app);
                const limitPct = limitMins ? Math.min(1, usedToday / (limitMins * 60)) : 0;
                const over = limitMins > 0 && usedToday > limitMins * 60;
                return (
                  <div key={app} className="app-row" style={{ animation: "rise .35s var(--ease-soft) both", animationDelay: `${Math.min(i, 10) * 35}ms` }}>
                    <span className="app-badge pixel-font !p-0" title={label}>
                      {app.startsWith("nook:") ? label.slice(0, 2).toUpperCase() : <AppLogo app={app} size={17} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-[14px]">{label}</span>
                        {app.startsWith("nook:") && <span className="tiny-font text-[9px] text-faint">in-app</span>}
                        {blocked && <span className="chip !py-0 !text-[9.5px]" style={{ color: "#e08a6a", borderColor: "#e08a6a55" }}><Icon name="block" size={10} /> blocked</span>}
                        {limitMins > 0 && <span className="chip !py-0 !text-[9.5px]" style={over ? { color: "#e08a6a" } : undefined}>{over ? "over " : ""}limit {Math.round(limitPct * 100)}%</span>}
                      </span>
                      <span className="relative mt-1 block h-[5px] overflow-hidden rounded-sm bg-panel2">
                        <i className="block h-full rounded-sm" style={{ width: `${(secs / maxSecs) * 100}%`, background: CAT_COLOR[cat], opacity: 0.85 }} />
                        {limitMins > 0 && <i className="absolute inset-y-0 w-[2px]" style={{ left: `${Math.min(100, (limitMins * 60 / Math.max(maxSecs, limitMins * 60)) * 100)}%`, background: over ? "#e08a6a" : "var(--accent)", opacity: 0.9 }} title={`limit ${limitMins}m`} />}
                      </span>
                    </span>
                    <span className="seg seg-compact flex-none" role="group" aria-label={`Category for ${label}`}>
                      {CATS.map((c) => (
                        <button key={c.id} data-on={cat === c.id} title={`${c.label} — ${c.hint}`} onClick={() => st().setAppCat(app, c.id)} style={cat === c.id ? { color: c.color } : undefined}>
                          <i className="inline-block h-[7px] w-[7px]" style={{ background: CAT_COLOR[c.id], opacity: cat === c.id ? 1 : 0.4 }} />
                        </button>
                      ))}
                    </span>
                    <span className="pixel-font w-[64px] flex-none text-right text-[13px]">{fmt(secs)}</span>
                    <span className="w-[38px] flex-none text-right text-[11px] text-faint">{Math.round(share)}%</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* shield & blocklist quick card */}
        <div className="paper mt-4 p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Icon name="shield" size={13} style={{ color: rules.shieldOn ? "#7fc48f" : "var(--accent)" }} />
            <span className="label">Shield & site blocking</span>
            <span className="flex-1" />
            <span className="chip !text-[11px]" data-on={rules.shieldOn} title="Master switch lives in the Rules tab">
              {rules.shieldOn ? "shield UP" : "shield down"}
            </span>
            {blockedAttempts > 0 && <span className="chip !text-[11px]" style={{ color: "#e08a6a" }}>{blockedAttempts} bounced today</span>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {rules.blocklist.length === 0 ? (
              <span className="text-[12.5px] text-faint">No blocked sites yet — add troublemakers and the shield keeps them out of your day.</span>
            ) : (
              rules.blocklist.map((b) => (
                <span key={b.id} className="chip !text-[11.5px]" style={b.enabled ? { color: "#e08a6a", borderColor: "#e08a6a44" } : { opacity: 0.5 }}>
                  <Icon name={b.enabled ? "block" : "eye"} size={11} /> {b.match}
                </span>
              ))
            )}
            <div className="flex-1" />
            <input className="input !h-[30px] !w-[170px] !text-[12px]" placeholder="test a name, e.g. reddit…" value={blockTest} onChange={(e) => setBlockTest(e.target.value)} aria-label="Test blocklist" />
            {blockTest.trim() && (
              <span className="chip !text-[11.5px]" style={rules.blocklist.some((b) => b.enabled && matchesRule(blockTest, b.match)) ? { color: "#e08a6a" } : undefined}>
                {rules.blocklist.some((b) => b.enabled && matchesRule(blockTest, b.match)) ? "would be blocked" : "allowed"}
              </span>
            )}
            <button className="btn btn-sm btn-accent" onClick={() => st().setView("rules")}>
              <Icon name="external-arrow" size={12} /> manage
            </button>
          </div>
        </div>

        {/* external agents */}
        <div className="paper mt-4 p-4">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <Icon name="shield" size={13} className="text-accent" />
            <span className="label">Desktop agents & privacy</span>
          </div>
          <div className="text-[12.5px] leading-relaxed text-dim">
            TimeLens-style tracking without the spyware: the Nook only counts <b>what you tell it</b> — in-app time, your dock taps, manual backfills, and anything an external agent reports to this endpoint:
          </div>
          <div className="mt-2 flex items-center gap-2">
            <code className="inset min-w-0 flex-1 overflow-x-auto px-2.5 py-1.5 text-[11.5px]">POST /api/activity · {"{ entries: [{ app: \"YouTube\", secs: 90, src: \"agent\" }] }"}</code>
            <button
              className="btn btn-sm"
              onClick={() => {
                void navigator.clipboard?.writeText(`curl -X POST "$NOOK_URL/api/activity" -H "content-type: application/json" -d '{"entries":[{"app":"Discord","secs":120,"src":"agent"}]}'`);
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              }}
            >
              <Icon name={copied ? "check" : "copy"} size={12} /> {copied ? "copied" : "copy curl"}
            </button>
          </div>
          <div className="mt-2 text-[11.5px] text-faint">No keystrokes, no window titles, no screenshots — ever. Everything stays in your own database.</div>
        </div>
      </div>
    </div>
  );
}
