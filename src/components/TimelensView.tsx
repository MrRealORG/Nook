/**
 * Timelens (1.2, TimeLet-style) — local, private desktop time tracking. Everything is read from
 * the spans the Rust tracker wrote to SQLite:
 *   Dashboard · Timeline · Apps · Websites · Analytics · Goals · Focus · Settings & privacy
 * Real app icons come from the exe (extracted once on Windows, cached on disk + in the vault);
 * websites get their favicon once per domain (can be switched off in Privacy).
 * Light: one summary request per day viewed, refreshed once a minute only while visible.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { everyActive } from "@/lib/power";
import { subscribe } from "@/lib/events";
import { useStore } from "@/lib/store";
import {
  addDays, AppIcon, CAT_COLOR, CAT_LABEL, CatChip, clock, dayStart, fmt, j, loadFavicons, loadIcons, send, SiteIcon,
  type Cat, type RegApp, type Seg, type SiteRow, type Summary,
} from "@/components/timelens/shared";

const Analytics = lazy(() => import("@/components/timelens/More").then((m) => ({ default: m.Analytics })));
const Goals = lazy(() => import("@/components/timelens/More").then((m) => ({ default: m.Goals })));
const FocusMode = lazy(() => import("@/components/timelens/More").then((m) => ({ default: m.FocusMode })));
const Privacy = lazy(() => import("@/components/timelens/More").then((m) => ({ default: m.Privacy })));

export { CAT_COLOR };

type Tab = "dashboard" | "timeline" | "apps" | "websites" | "analytics" | "goals" | "focus" | "settings";
const TABS: { id: Tab; label: string; icon: Parameters<typeof Icon>[0]["name"] }[] = [
  { id: "dashboard", label: "Dashboard", icon: "layout" },
  { id: "timeline", label: "Timeline", icon: "clock" },
  { id: "apps", label: "Apps", icon: "app-windows" },
  { id: "websites", label: "Websites", icon: "globe" },
  { id: "analytics", label: "Analytics", icon: "chart" },
  { id: "goals", label: "Goals", icon: "target" },
  { id: "focus", label: "Focus mode", icon: "hourglass" },
  { id: "settings", label: "Settings", icon: "shield" },
];

const Spinner = () => <div className="grid h-40 place-items-center text-[13px] text-faint">Loading…</div>;

export default function TimelensView() {
  const st = useStore.getState;
  const [tab, setTab] = useState<Tab>("dashboard");
  const [day, setDay] = useState(() => dayStart());
  const [sum, setSum] = useState<Summary | null>(null);
  const isToday = day === dayStart();

  const load = useCallback(async () => {
    try {
      const to = isToday ? Date.now() + 1 : addDays(day, 1);
      setSum(await j<Summary>(`/api/timelens/summary?from=${day}&to=${to}`));
    } catch {
      /* backend restarting — next tick */
    }
  }, [day, isToday]);

  useEffect(() => {
    void load();
    loadIcons(true);
    // today's numbers move; past days don't. Once a minute, visible-only.
    if (!isToday) return;
    return everyActive(() => {
      void load();
      loadIcons();
    }, 60_000);
  }, [load, isToday]);

  // v1.4 live: the tracker pushes `timelens-live` on every foreground change (desktop). Update
  // the "Tracking …" header at once and re-read today's numbers at most every 10 s. In a plain
  // browser (no events) a light 15 s poll of /live keeps the header honest.
  const lastReload = useRef(0);
  useEffect(() => {
    if (!isToday) return;
    const apply = (l: Partial<Summary["current"]> & { app?: string }) => {
      setSum((s) => (s ? { ...s, current: { ...s.current, ...l, running: true } as Summary["current"] } : s));
      if (Date.now() - lastReload.current > 10_000 && document.visibilityState !== "hidden") {
        lastReload.current = Date.now();
        void load();
      }
    };
    const off = subscribe({ "nook://timelens-live": (p: Partial<Summary["current"]>) => p && apply(p) });
    const stop = everyActive(() => {
      void j<Summary["current"] & { paused: boolean }>("/api/timelens/live").then((l) => l && setSum((s) => (s ? { ...s, paused: l.paused, current: { ...s.current, ...l } } : s))).catch(() => {});
    }, 15_000);
    return () => {
      off();
      stop();
    };
  }, [isToday, load]);

  useEffect(() => {
    void claim(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pause = async () => {
    const r = await (await send("/api/timelens/pause", "POST", { paused: !sum?.paused })).json();
    st().toast(r.paused ? "Timelens paused — nothing is recorded" : "Timelens resumed", r.paused ? "pause" : "play");
    void load();
  };
  const claim = async (quiet = false) => {
    const r = await j<{ xp: number; coins: number }>("/api/timelens/reward", { method: "POST" }).catch(() => ({ xp: 0, coins: 0 }));
    if (r.xp > 0) {
      st().toast(`Productive day! +${r.xp} XP, +${r.coins} coins`, "star");
      st().doAct("happy", 1800);
      const pet = await j<Record<string, unknown>>("/api/pet");
      if (pet && typeof pet === "object") useStore.setState({ pet: { ...st().pet, ...pet } as ReturnType<typeof st>["pet"] });
    } else if (!quiet) st().toast("No unclaimed productive days yet", "bell");
  };
  const seed = async () => {
    await send("/api/timelens/seed", "POST", {});
    st().toast("Loaded a demo day", "sparkles");
    loadIcons(true);
    void load();
  };

  const dayLabel = isToday ? "Today" : day === addDays(dayStart(), -1) ? "Yesterday" : new Date(day).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const live = sum?.current;

  return (
    <div className="tl scroll h-full" data-testid="timelens">
      <div className="tl-wrap">
        <header className="tl-head">
          <div className="min-w-0 flex-1">
            <h1 className="tl-title">Timelens</h1>
            <div className="tl-sub">
              <span className="tl-dot" data-state={sum?.paused ? "paused" : live?.running ? (live.afk ? "away" : "on") : "off"} />
              {sum?.paused ? "Paused — nothing is being recorded" : live?.running ? (live.afk ? "Away from keyboard" : <span data-testid="tl-live">Tracking <b className="text-ink">{live.app}</b>{live.domain ? <> · <b className="text-ink">{live.domain}</b></> : null} · since {clock(live.since)}</span>) : "Private, on-device time tracking"}
            </div>
          </div>
          <div className="tl-daynav" role="group" aria-label="Day">
            <button className="icon-btn" aria-label="Previous day" onClick={() => setDay(addDays(day, -1))}><Icon name="chevron-left" size={16} /></button>
            <button className="tl-daylabel" onClick={() => setDay(dayStart())} title="Back to today" data-testid="tl-day">{dayLabel}</button>
            <button className="icon-btn" aria-label="Next day" disabled={isToday} onClick={() => setDay(addDays(day, 1))}><Icon name="chevron-right" size={16} /></button>
          </div>
          <button className="btn btn-sm" onClick={() => void pause()} data-testid="tl-pause">
            <Icon name={sum?.paused ? "play" : "pause"} size={13} /> {sum?.paused ? "Resume" : "Pause"}
          </button>
        </header>

        <nav className="tl-tabs" role="tablist" aria-label="Timelens sections">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} data-on={tab === t.id} data-testid={`tl-tab-${t.id}`} onClick={() => setTab(t.id)}>
              <Icon name={t.icon} size={14} /> {t.label}
            </button>
          ))}
        </nav>

        {!sum ? (
          <Spinner />
        ) : (
          <>
            {tab === "dashboard" && <Dashboard sum={sum} isToday={isToday} onSeed={seed} onClaim={() => void claim(false)} openTab={setTab} />}
            {tab === "timeline" && <TimelineTab sum={sum} day={day} />}
            {tab === "apps" && <AppsTab day={day} onChange={load} />}
            {tab === "websites" && <WebsitesTab sum={sum} onChange={load} />}
            <Suspense fallback={<Spinner />}>
              {tab === "analytics" && <Analytics />}
              {tab === "goals" && <Goals />}
              {tab === "focus" && <FocusMode sum={sum} />}
              {tab === "settings" && <Privacy onChange={load} />}
            </Suspense>
          </>
        )}
      </div>
    </div>
  );
}

// ================================================================ dashboard

function Stat({ label, value, sub, color, testid }: { label: string; value: string; sub?: string; color?: string; testid?: string }) {
  return (
    <div className="tl-card tl-stat" data-testid={testid}>
      <div className="tl-stat-label"><i style={{ background: color ?? "var(--accent)" }} />{label}</div>
      <div className="tl-stat-value">{value}</div>
      {sub && <div className="tl-stat-sub">{sub}</div>}
    </div>
  );
}

function Dashboard({ sum, isToday, onSeed, onClaim, openTab }: { sum: Summary; isToday: boolean; onSeed: () => void; onClaim: () => void; openTab: (t: Tab) => void }) {
  const empty = sum.activeSecs === 0 && sum.timeline.length === 0;
  const pct = (n: number) => (sum.activeSecs ? `${Math.round((n / sum.activeSecs) * 100)}% of active time` : "—");
  const cats = sum.categories;
  const C = 2 * Math.PI * 46;
  let acc = 0;
  return (
    <div className="grid gap-3">
      <div className="tl-stats" data-testid="tl-cards">
        <Stat label="Total tracked" value={fmt(sum.activeSecs)} sub={sum.firstActivity ? `${clock(sum.firstActivity)} – ${clock(sum.lastActivity ?? Date.now())}` : "No activity yet"} color="var(--accent)" testid="tl-total" />
        <Stat label="Productive time" value={fmt(sum.productiveSecs)} sub={pct(sum.productiveSecs)} color={CAT_COLOR.productive} testid="tl-productive" />
        <Stat label="Focused time" value={fmt(sum.focusedSecs)} sub={`${sum.focusBlocks.length} deep-work block${sum.focusBlocks.length === 1 ? "" : "s"} ≥ 10 min`} color={CAT_COLOR.focus} testid="tl-focused" />
        <Stat label="Idle / away" value={fmt(sum.afkSecs)} sub={sum.intervalSecs ? `sampling every ${sum.intervalSecs}s` : undefined} color="var(--faint)" testid="tl-idle" />
      </div>

      {empty && (
        <div className="tl-card flex flex-wrap items-center gap-3" data-testid="tl-empty">
          <Icon name="clock" size={20} className="text-faint" />
          <div className="min-w-0 flex-1 text-[13px] text-dim">
            {isToday ? "Nothing tracked yet today. Timelens records the active window every few seconds while the desktop app runs — everything stays on this computer." : "Nothing was tracked on this day."}
          </div>
          {isToday && <button className="btn btn-sm" onClick={onSeed}><Icon name="sparkles" size={13} /> Load a demo day</button>}
        </div>
      )}

      <div className="tl-card">
        <div className="tl-card-head">
          <span>Timeline</span>
          <button className="tl-link" onClick={() => openTab("timeline")}>Open timeline →</button>
        </div>
        <DayStrip sum={sum} />
      </div>

      <div className="tl-grid2">
        <div className="tl-card">
          <div className="tl-card-head">
            <span>Top apps</span>
            <button className="tl-link" onClick={() => openTab("apps")}>All apps →</button>
          </div>
          <div className="grid gap-1" data-testid="tl-apps">
            {sum.apps.length === 0 && <div className="py-3 text-[13px] text-faint">No apps yet.</div>}
            {sum.apps.slice(0, 7).map((a) => (
              <div key={a.app} className="tl-row">
                <AppIcon app={a.app} size={22} />
                <span className="tl-row-name">{a.app}</span>
                <span className="tl-row-bar"><i style={{ width: `${Math.max(3, (a.secs / (sum.apps[0]?.secs || 1)) * 100)}%`, background: CAT_COLOR[a.cat] }} /></span>
                <span className="tl-row-time">{fmt(a.secs)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="tl-card">
          <div className="tl-card-head"><span>Categories</span><span className="text-faint">score {sum.score}</span></div>
          <div className="flex items-center gap-5">
            <svg viewBox="0 0 120 120" width={132} height={132} data-testid="tl-donut" role="img" aria-label={`Productivity score ${sum.score}`}>
              <circle cx="60" cy="60" r="46" fill="none" stroke="var(--panel2)" strokeWidth="14" />
              {(["productive", "neutral", "distracting"] as Cat[]).map((k) => {
                const v = sum.activeSecs ? cats[k] / sum.activeSecs : 0;
                const el = <circle key={k} cx="60" cy="60" r="46" fill="none" stroke={CAT_COLOR[k]} strokeWidth="14" strokeDasharray={`${v * C} ${C}`} strokeDashoffset={-acc * C} transform="rotate(-90 60 60)" />;
                acc += v;
                return el;
              })}
              <text x="60" y="58" textAnchor="middle" fontSize="24" fontWeight="650" fill="var(--ink)">{sum.score}</text>
              <text x="60" y="76" textAnchor="middle" fontSize="10" fill="var(--faint)">score</text>
            </svg>
            <div className="grid flex-1 gap-2">
              {(["productive", "neutral", "distracting"] as Cat[]).map((k) => (
                <div key={k} className="flex items-center gap-2 text-[13px]">
                  <i className="h-2.5 w-2.5 rounded-full" style={{ background: CAT_COLOR[k] }} />
                  <span className="flex-1 text-dim">{CAT_LABEL[k]}</span>
                  <b className="font-semibold">{fmt(cats[k])}</b>
                </div>
              ))}
              <button className="btn btn-sm mt-1 justify-self-start" onClick={onClaim} title="Productive days pay your pet XP and coins"><Icon name="coins" size={12} /> Claim rewards</button>
            </div>
          </div>
        </div>
      </div>

      <div className="tl-card">
        <div className="tl-card-head"><span>Hour by hour</span>{sum.peakHour != null && <span className="text-faint">peak {String(sum.peakHour).padStart(2, "0")}:00</span>}</div>
        <div className="tl-hours" data-testid="tl-hourly">
          {sum.hourly.map((v, h) => {
            const max = Math.max(1, ...sum.hourly);
            return (
              <div key={h} className="tl-hour" title={`${String(h).padStart(2, "0")}:00 · ${fmt(v)} active · ${fmt(sum.hourlyProductive[h])} productive`}>
                <i style={{ height: `${(v / max) * 100}%` }}><b style={{ height: `${v ? (sum.hourlyProductive[h] / v) * 100 : 0}%` }} /></i>
                <span>{h % 3 === 0 ? h : ""}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** compact whole-day strip (dashboard) */
function DayStrip({ sum }: { sum: Summary }) {
  const from = sum.from;
  const W = 24 * 3600_000;
  return (
    <div>
      <div className="tl-strip" data-testid="tl-timeline">
        {sum.timeline.map((s, i) => (
          <i
            key={i}
            title={`${s.app}${s.title ? ` — ${s.title}` : ""}\n${clock(s.start)}–${clock(s.end)} · ${fmt((s.end - s.start) / 1000)}`}
            style={{ left: `${((s.start - from) / W) * 100}%`, width: `max(1px, ${((s.end - s.start) / W) * 100}%)`, background: s.focus ? CAT_COLOR.focus : CAT_COLOR[s.cat] ?? "var(--faint)" }}
          />
        ))}
      </div>
      <div className="tl-axis">{[0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => <span key={h} style={{ left: `${(h / 24) * 100}%` }}>{h === 24 ? "" : `${String(h).padStart(2, "0")}:00`}</span>)}</div>
    </div>
  );
}

// ================================================================ timeline

const ZOOMS = [1, 2, 4, 8, 16];

function TimelineTab({ sum, day }: { sum: Summary; day: number }) {
  const [zoom, setZoom] = useState(2);
  const [hover, setHover] = useState<{ x: number; y: number; seg: Seg } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const W = 24 * 3600_000;
  // scroll to the first activity on open / zoom
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const t = sum.firstActivity ?? day + 8 * 3600_000;
    el.scrollLeft = Math.max(0, ((t - day) / W) * el.scrollWidth - 40);
  }, [zoom, day, sum.firstActivity, W]);
  const segs = sum.timeline;
  const lanes: { id: string; label: string; test: (s: Seg) => boolean }[] = [
    { id: "activity", label: "Activity", test: (s) => !s.afk },
    { id: "away", label: "Away", test: (s) => s.afk },
  ];
  const hours = Array.from({ length: 25 }, (_, h) => h);
  return (
    <div className="grid gap-3">
      <div className="tl-card">
        <div className="tl-card-head">
          <span>Day timeline</span>
          <div className="flex items-center gap-2">
            <span className="text-faint">Zoom</span>
            <div className="seg seg-compact" role="group" aria-label="Zoom">
              {ZOOMS.map((z) => <button key={z} data-on={zoom === z} onClick={() => setZoom(z)} aria-label={`Zoom ${z}x`}>{z}×</button>)}
            </div>
          </div>
        </div>
        <div className="tl-tl scroll" ref={box} data-testid="tl-day-timeline" onPointerLeave={() => setHover(null)} onWheel={(e) => {
          if (!e.ctrlKey) return;
          e.preventDefault();
          setZoom((z) => ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, ZOOMS.indexOf(z) + (e.deltaY < 0 ? 1 : -1)))]);
        }}>
          <div style={{ width: `${zoom * 100}%`, minWidth: "100%" }} className="relative">
            <div className="tl-tl-axis">
              {hours.map((h) => (zoom >= 2 || h % 2 === 0) && <span key={h} style={{ left: `${(h / 24) * 100}%` }}>{h < 24 ? `${String(h).padStart(2, "0")}:00` : ""}</span>)}
            </div>
            {lanes.map((lane) => (
              <div key={lane.id} className="tl-lane" data-lane={lane.id}>
                {hours.map((h) => <i key={h} className="tl-grid" style={{ left: `${(h / 24) * 100}%` }} />)}
                {segs.filter(lane.test).map((s, i) => {
                  const left = ((s.start - day) / W) * 100;
                  const width = ((s.end - s.start) / W) * 100;
                  const px = (width / 100) * zoom * 900;
                  return (
                    <div
                      key={i}
                      className="tl-seg"
                      data-testid="tl-seg"
                      style={{ left: `${left}%`, width: `max(2px, ${width}%)`, ["--c" as string]: s.focus ? CAT_COLOR.focus : CAT_COLOR[s.cat] ?? "var(--faint)" }}
                      onPointerEnter={(e) => setHover({ x: e.clientX, y: e.clientY, seg: s })}
                      onPointerMove={(e) => setHover({ x: e.clientX, y: e.clientY, seg: s })}
                    >
                      {px > 26 && <AppIcon app={s.app} size={16} />}
                      {px > 90 && <span className="tl-seg-name">{s.app}</span>}
                    </div>
                  );
                })}
              </div>
            ))}
            {day === dayStart() && <i className="tl-now" style={{ left: `${((Date.now() - day) / W) * 100}%` }} />}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-3 text-[12px] text-dim">
          {(["productive", "neutral", "distracting", "focus", "afk"] as const).map((k) => <span key={k} className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm" style={{ background: CAT_COLOR[k] }} />{CAT_LABEL[k]}</span>)}
          <span className="ml-auto text-faint">Ctrl + scroll to zoom</span>
        </div>
      </div>

      <div className="tl-card">
        <div className="tl-card-head"><span>Sessions</span><span className="text-faint">{segs.filter((s) => !s.afk).length}</span></div>
        <div className="grid gap-0.5" data-testid="tl-sessions">
          {segs.filter((s) => !s.afk && s.end - s.start >= 60_000).slice(-60).reverse().map((s, i) => (
            <div key={i} className="tl-row">
              <AppIcon app={s.app} size={20} />
              <span className="tl-row-name">{s.app}<span className="ml-2 text-faint">{s.title}</span></span>
              <CatChip cat={s.focus ? "focus" : s.cat} />
              <span className="tl-row-time tl-row-range">{clock(s.start)} – {clock(s.end)}</span>
              <span className="tl-row-time">{fmt((s.end - s.start) / 1000)}</span>
            </div>
          ))}
        </div>
      </div>

      {hover && (
        <div className="tl-tip" style={{ left: Math.min(hover.x + 14, window.innerWidth - 300), top: hover.y + 16 }} role="tooltip" data-testid="tl-hover">
          <div className="flex items-center gap-2">
            <AppIcon app={hover.seg.app} size={20} />
            <b className="min-w-0 flex-1 truncate">{hover.seg.focus ? "Focus session" : hover.seg.afk ? "Away" : hover.seg.app}</b>
            <CatChip cat={hover.seg.focus ? "focus" : hover.seg.afk ? "afk" : hover.seg.cat} />
          </div>
          {hover.seg.title && <div className="mt-1 line-clamp-2 text-dim">{hover.seg.title}</div>}
          <div className="mt-1 text-faint">{clock(hover.seg.start)} – {clock(hover.seg.end)} · {fmt((hover.seg.end - hover.seg.start) / 1000)}</div>
        </div>
      )}
    </div>
  );
}

// ================================================================ apps

type Sort = "time" | "name" | "category" | "recent";

function AppsTab({ day, onChange }: { day: number; onChange: () => void }) {
  const st = useStore.getState;
  const [range, setRange] = useState<"day" | "week" | "month">("week");
  const [apps, setApps] = useState<RegApp[] | null>(null);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("time");
  const [showExcluded, setShowExcluded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  /** 1.3: re-extract every app's real icon (Windows) — bypasses the icon cache */
  const refreshIcons = async () => {
    setRefreshing(true);
    try {
      const r = await j<{ ok: boolean; apps: number; extracted: number; failed: number }>("/api/timelens/icons/refresh", { method: "POST" });
      loadIcons(true);
      st().toast(r.apps ? `Icons refreshed — ${r.extracted} of ${r.apps} apps${r.failed ? ` (${r.failed} use a built-in icon)` : ""}` : "No app executables to read icons from yet", "reload");
    } catch {
      st().toast("Couldn't refresh icons", "alert");
    }
    setRefreshing(false);
  };
  const load = useCallback(async () => {
    const from = range === "day" ? day : addDays(dayStart(), range === "week" ? -6 : -29);
    const to = range === "day" ? Math.min(addDays(day, 1), Date.now() + 1) : Date.now() + 1;
    setApps(await j<RegApp[]>(`/api/timelens/apps?from=${from}&to=${to}`).catch(() => []));
  }, [range, day]);
  useEffect(() => {
    void load();
    loadIcons(true);
  }, [load]);
  const patch = async (app: string, body: Record<string, unknown>, msg: string) => {
    await send(`/api/timelens/apps/${encodeURIComponent(app)}`, "PATCH", body);
    st().toast(msg, "check");
    void load();
    onChange();
  };
  const list = useMemo(() => {
    let l = (apps ?? []).filter((a) => (showExcluded ? a.excluded : !a.excluded) && a.app.toLowerCase().includes(q.trim().toLowerCase()));
    l = [...l].sort((a, b) =>
      sort === "name" ? a.app.localeCompare(b.app) : sort === "category" ? a.cat.localeCompare(b.cat) || b.secs - a.secs : sort === "recent" ? b.lastSeen - a.lastSeen : b.secs - a.secs,
    );
    return l;
  }, [apps, q, sort, showExcluded]);
  const max = Math.max(1, ...list.map((a) => a.secs));
  const excludedCount = (apps ?? []).filter((a) => a.excluded).length;
  return (
    <div className="tl-card">
      <div className="tl-toolbar">
        <div className="tl-search">
          <Icon name="search" size={14} />
          <input className="input" placeholder="Search apps…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search apps" data-testid="tl-app-search" />
        </div>
        <div className="seg seg-compact" role="group" aria-label="Range">
          {(["day", "week", "month"] as const).map((r) => <button key={r} data-on={range === r} onClick={() => setRange(r)}>{r === "day" ? "Day" : r === "week" ? "7 days" : "30 days"}</button>)}
        </div>
        <select className="input !h-8 !w-auto" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort apps" data-testid="tl-app-sort">
          <option value="time">Most used</option>
          <option value="name">Name</option>
          <option value="category">Category</option>
          <option value="recent">Recently used</option>
        </select>
        <button className="btn btn-sm" onClick={() => void refreshIcons()} disabled={refreshing} data-testid="tl-refresh-icons" title="Re-read every app's real icon from its .exe">
          <Icon name="reload" size={13} /> {refreshing ? "Refreshing…" : "Refresh icons"}
        </button>
        <button className="btn btn-sm" data-on={showExcluded} onClick={() => setShowExcluded(!showExcluded)} disabled={!excludedCount && !showExcluded}>
          <Icon name="eye" size={13} /> {showExcluded ? "Back to apps" : `Excluded (${excludedCount})`}
        </button>
      </div>
      <div className="tl-apphead"><span>App</span><span>Time</span><span>Category</span><span /></div>
      <div className="grid" data-testid="tl-apps-list">
        {apps === null && <Spinner />}
        {apps && list.length === 0 && <div className="py-6 text-center text-[13px] text-faint">{q ? "No app matches." : showExcluded ? "No excluded apps." : "No apps tracked in this range."}</div>}
        {list.map((a) => (
          <div key={a.app} className="tl-approw" data-testid="tl-app-row" data-app={a.app}>
            <AppIcon app={a.app} size={28} />
            <div className="min-w-0">
              <div className="truncate text-[13.5px] font-medium">{a.app}</div>
              <div className="truncate text-[11.5px] text-faint" title={a.exe}>{a.exe ? a.exe.split(/[\\/]/).pop() : "—"}{a.override && " · custom category"}</div>
            </div>
            <div className="flex items-center gap-2">
              <span className="tl-row-bar"><i style={{ width: `${Math.max(2, (a.secs / max) * 100)}%`, background: CAT_COLOR[a.cat] }} /></span>
              <span className="tl-row-time">{fmt(a.secs)}</span>
            </div>
            <select
              className="tl-catsel"
              value={a.cat}
              style={{ color: CAT_COLOR[a.cat] }}
              aria-label={`Category for ${a.app}`}
              data-testid="tl-app-cat"
              onChange={(e) => void patch(a.app, { category: e.target.value }, `${a.app} → ${CAT_LABEL[e.target.value]} (history updated)`)}
            >
              {(["productive", "neutral", "distracting"] as Cat[]).map((c) => <option key={c} value={c}>{CAT_LABEL[c]}</option>)}
            </select>
            <div className="flex justify-end gap-1">
              {a.override && <button className="icon-btn" title="Reset to the default category" aria-label={`Reset category for ${a.app}`} onClick={() => void patch(a.app, { category: null }, `${a.app} category reset`)}><Icon name="reload" size={13} /></button>}
              <button
                className="icon-btn"
                title={a.excluded ? "Track this app again" : "Exclude: stop tracking and hide it everywhere"}
                aria-label={a.excluded ? `Include ${a.app}` : `Exclude ${a.app}`}
                onClick={() => void patch(a.app, { excluded: !a.excluded }, a.excluded ? `${a.app} is tracked again` : `${a.app} excluded`)}
              >
                <Icon name={a.excluded ? "eye" : "block"} size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ================================================================ websites

function WebsitesTab({ sum, onChange }: { sum: Summary; onChange: () => void }) {
  const st = useStore.getState;
  const [cfg, setCfg] = useState<{ favicons: boolean } | null>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [catFilter, setCatFilter] = useState<Cat | "all">("all");
  useEffect(() => {
    void j<{ favicons: boolean }>("/api/timelens/config").then(setCfg).catch(() => setCfg({ favicons: false }));
  }, []);
  const domains = useMemo(() => sum.sites.map((s) => s.domain ?? "").filter(Boolean).sort().join(","), [sum.sites]);
  useEffect(() => {
    if (!cfg || !domains) return;
    loadFavicons(domains.split(","), cfg.favicons);
  }, [cfg, domains]);
  const setCat = async (s: SiteRow, category: Cat | null) => {
    if (!s.domain) return;
    const r = await send(`/api/timelens/sites/${encodeURIComponent(s.domain)}`, "PATCH", { category });
    if (!r.ok) {
      st().toast(`Couldn't change ${s.site}: ${(await r.json().catch(() => ({}))).error ?? r.status}`, "alert");
      return;
    }
    st().toast(category ? `${s.site} → ${CAT_LABEL[category]} (history updated)` : `${s.site} category reset`, "globe");
    onChange();
  };
  const needle = q.trim().toLowerCase();
  const list = sum.sites.filter(
    (s) =>
      (catFilter === "all" || s.cat === catFilter) &&
      (!needle || s.site.toLowerCase().includes(needle) || (s.domain ?? "").includes(needle) || (s.titles ?? []).some((t) => t.title.toLowerCase().includes(needle))),
  );
  const max = Math.max(1, ...list.map((s) => s.secs));
  const total = sum.sites.reduce((a, s) => a + s.secs, 0);
  const live = sum.current?.domain ?? null;
  return (
    <div className="tl-card">
      <div className="tl-toolbar">
        <div className="tl-search">
          <Icon name="search" size={14} />
          <input className="input" placeholder="Search websites or pages…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search websites" data-testid="tl-site-search" />
        </div>
        <div className="seg seg-compact" role="group" aria-label="Category filter">
          {(["all", "productive", "neutral", "distracting"] as const).map((c) => (
            <button key={c} data-on={catFilter === c} onClick={() => setCatFilter(c)}>{c === "all" ? "All" : CAT_LABEL[c]}</button>
          ))}
        </div>
        <span className="ml-auto text-[12px] text-faint">{fmt(total)} on {sum.sites.length} site{sum.sites.length === 1 ? "" : "s"}{cfg?.favicons === false ? " · favicons off (Privacy)" : ""}</span>
      </div>
      <div className="tl-sitehead"><span>Website</span><span>Time</span><span>Category</span></div>
      <div className="grid gap-0.5" data-testid="tl-sites">
        {list.length === 0 && (
          <div className="py-6 text-center text-[13px] text-faint">
            {q || catFilter !== "all" ? "No website matches." : "No websites yet — Timelens reads the site from the browser's address bar (Chrome, Edge, Firefox, Brave, Opera, Vivaldi)."}
          </div>
        )}
        {list.map((s) => {
          const key = s.domain ?? s.site;
          const isOpen = open === key;
          const pages = s.titles ?? [];
          return (
            <div key={key} className="tl-siteblock" data-open={isOpen}>
              <div className="tl-siterow" data-testid="tl-site-row" data-domain={s.domain ?? ""}>
                <button className="tl-siteopen" aria-expanded={isOpen} aria-label={`${isOpen ? "Hide" : "Show"} pages on ${s.site}`} onClick={() => setOpen(isOpen ? null : key)} disabled={!pages.length}>
                  <Icon name={isOpen ? "chevron-down" : "chevron-right"} size={13} />
                </button>
                <SiteIcon site={s.site} domain={s.domain} size={24} />
                <div className="min-w-0">
                  <div className="truncate text-[13.5px] font-medium">
                    {s.site}
                    {live && live === s.domain && <span className="tl-livebadge" title="Open in the foreground right now">live</span>}
                  </div>
                  <div className="truncate text-[11.5px] text-faint">{s.domain ?? "unknown domain"}{s.browser ? ` · ${s.browser}` : ""}{pages.length ? ` · ${pages.length} page${pages.length === 1 ? "" : "s"}` : ""}{s.override ? " · custom category" : ""}</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="tl-row-bar"><i style={{ width: `${Math.max(2, (s.secs / max) * 100)}%`, background: CAT_COLOR[s.cat] }} /></span>
                  <span className="tl-row-time">{fmt(s.secs)}</span>
                </div>
                <div className="flex items-center justify-end gap-1">
                  <select
                    className="tl-catsel"
                    value={s.cat}
                    style={{ color: CAT_COLOR[s.cat] }}
                    aria-label={`Category for ${s.site}`}
                    data-testid="tl-site-cat"
                    disabled={!s.domain}
                    onChange={(e) => void setCat(s, e.target.value as Cat)}
                  >
                    {(["productive", "neutral", "distracting"] as Cat[]).map((c) => <option key={c} value={c}>{CAT_LABEL[c]}</option>)}
                  </select>
                  {s.override ? (
                    <button className="icon-btn" title="Reset to the default category" aria-label={`Reset category for ${s.site}`} onClick={() => void setCat(s, null)}><Icon name="reload" size={13} /></button>
                  ) : (
                    <span className="inline-block w-7" />
                  )}
                </div>
              </div>
              {isOpen && (
                <div className="tl-pages" data-testid="tl-site-pages">
                  {pages.map((p) => (
                    <div key={p.title} className="tl-page">
                      <span className="truncate" title={p.title}>{p.title || "(untitled tab)"}</span>
                      <span className="tl-row-time">{fmt(p.secs)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
