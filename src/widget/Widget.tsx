import { TILE_FEATURE, featuresFromPrefs } from "@/lib/features";
/**
 * Desktop widget (1.2) — a small (300×380), rounded, translucent card in its own frameless
 * window. Tiles (quick capture, today's tasks, Timelens with top-app icons, focus timer, mini AI,
 * pet) are toggled and reordered in Settings → Desktop. Collapses to a 200×48 pill; the window
 * remembers its position/size (window-state plugin) and the expanded size across pill toggles.
 *
 * Built to idle at ~0 CPU: no animation loops (the pet is a static sprite), data refreshes at most
 * once a minute and only while visible (plus instantly on change events), and nothing but the
 * header renders while the window is hidden. It does not load the main app's store.
 */
import { createElement, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { invoke, isTauri } from "@/lib/platform";
import { subscribe } from "@/lib/events";
import { drawPet, makePalette, SH, SW, type Mood, type Species } from "@/lib/sprite";
import { THEMES, THEME_IDS, type ThemeId } from "@/lib/themes";
import type { AiResult, Pet } from "@/lib/types";
import { uid } from "@/lib/util";
import { PILL_SIZE, readWidgetCfg, writeWidgetCfg, type TileId, type WidgetCfg } from "@/widget/config";
import { brandLogoFor } from "@/lib/appLogos";
import { brandSrc, type BrandTone } from "@/lib/brandSrc";
import { fmtElapsed, isLive, meetingsApi, watchLive, type MeetingLive } from "@/lib/meetings";

/** 1.3: no real icon yet → the built-in brand mark (inline SVG), else a letter */
function BrandOrLetter({ app }: { app: string }) {
  const Logo = brandLogoFor(app);
  return Logo ? <span className="wg-brand" data-testid="widget-app-brand" style={{ display: "inline-grid", width: 16, height: 16 }}>{createElement(Logo, { size: 16 })}</span> : <i className="wg-letter">{app[0]}</i>;
}

const MicButton = lazy(() => import("@/components/MicButton").then((m) => ({ default: m.MicButton })));

type Task = { id: string; title: string; done: boolean; list?: string; priority?: number; completedAt?: number | null };
type Tl = { activeSecs: number; productiveSecs?: number; focusedSecs?: number; topApp: string | null; paused: boolean; apps: { app: string; secs: number; cat: string }[]; current: { app: string; afk: boolean; running: boolean } };

const fmt = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m` : `${Math.round(s / 60)}m`);
const post = (url: string, body: unknown, method = "POST") => fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const notifyMain = () => {
  if (isTauri) void invoke("broadcast", { event: "data-changed", payload: { source: "widget" } }).catch(() => {});
};

/** before the main window has saved any prefs (fresh install), follow the OS like the app does */
const osTheme = (): ThemeId => (typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

function readLook(): { theme: ThemeId; ui: string } {
  try {
    const p = JSON.parse(localStorage.getItem("nook:prefs") ?? "{}");
    const theme = THEME_IDS.includes(p.theme) ? (p.theme as ThemeId) : osTheme();
    return { theme, ui: typeof p.uiStyle === "string" ? p.uiStyle : "clean" };
  } catch {
    return { theme: osTheme(), ui: "clean" };
  }
}

/** static pet sprite: one draw per change, no loop */
function PetSprite({ pet, mood, scale = 1.25 }: { pet: Pet; mood: Mood; scale?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const theme = readLook().theme;
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    const t = THEMES[theme] ?? THEMES.light;
    const look = pet.look as { ramp?: string[]; accent?: string } | undefined;
    const pal = makePalette(look?.ramp?.length === 5 ? look.ramp : t.ramp, look?.accent || t.accent);
    drawPet(ctx, pet.species as Species, { mood, t: 0.5, facing: 1 }, pal, pet.hat);
  }, [pet, mood, theme]);
  return <canvas ref={ref} width={SW} height={SH} className="pixelated" style={{ width: SW * scale, height: SH * scale }} />;
}

let iconCache: Record<string, string> = {};

export function Widget() {
  const [cfg, setCfg] = useState<WidgetCfg>(() => readWidgetCfg());
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  const [pet, setPet] = useState<Pet | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [tl, setTl] = useState<Tl | null>(null);
  const [icons, setIcons] = useState(iconCache);
  const [capture, setCapture] = useState("");
  const [asTask, setAsTask] = useState(false);
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [mood, setMood] = useState<Mood>("idle");
  const [flash, setFlash] = useState("");
  const [onTop, setOnTop] = useState(false);
  // v1.4: small recording pill while a meeting is being recorded (hotkey / tray / main window)
  const [meet, setMeet] = useState<MeetingLive | null>(null);
  useEffect(() => {
    if (featuresFromPrefs().meetings === false) return;
    return watchLive(setMeet, 1000);
  }, []);
  const capRef = useRef<HTMLTextAreaElement>(null);
  const lastLoad = useRef(0);

  // 1.3: tiles of switched-off features never show (features live in the shared prefs)
  const feats = featuresFromPrefs();
  const live = (id: TileId) => !TILE_FEATURE[id] || feats[TILE_FEATURE[id]] !== false;
  const on = (id: TileId) => live(id) && cfg.tiles.some((t) => t.id === id && t.on);

  const load = useCallback(async (force = false) => {
    // at most one refresh per 30 s unless something told us data changed
    if (!force && Date.now() - lastLoad.current < 30_000) return;
    lastLoad.current = Date.now();
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    try {
      const [p, t, s] = await Promise.all([
        fetch("/api/pet").then((r) => r.json()),
        fetch("/api/tasks").then((r) => r.json()),
        featuresFromPrefs().timelens === false ? Promise.resolve(null) : fetch(`/api/timelens/summary?from=${d.getTime()}&to=${Date.now() + 1}`).then((r) => r.json()).catch(() => null),
      ]);
      if (p) setPet(p as Pet);
      setTasks(Array.isArray(t) ? (t as Task[]) : []);
      if (s) setTl(s as Tl);
      if (!Object.keys(iconCache).length || force) {
        iconCache = await fetch("/api/timelens/icons").then((r) => r.json()).catch(() => iconCache);
        setIcons(iconCache);
      }
    } catch {
      /* vault busy — next tick */
    }
  }, []);

  // look (theme + ui style) follows the main window live — the brand icon too
  const [tone, setTone] = useState<BrandTone>(() => (THEMES[readLook().theme]?.dark === false ? "light" : "dark"));
  useEffect(() => {
    const apply = () => {
      const l = readLook();
      document.documentElement.dataset.theme = l.theme;
      document.documentElement.dataset.ui = l.ui;
      setTone(THEMES[l.theme]?.dark === false ? "light" : "dark");
    };
    apply();
    const onStorage = (e: StorageEvent) => {
      if (e.key === "nook:prefs") apply();
      if (e.key === "nook:widget") setCfg(readWidgetCfg());
    };
    const onLocal = () => setCfg(readWidgetCfg());
    window.addEventListener("storage", onStorage);
    window.addEventListener("nook-widget-cfg", onLocal);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("nook-widget-cfg", onLocal);
    };
  }, []);

  // refresh: on mount, on change events, and once a minute while visible
  useEffect(() => {
    void load(true);
    const onVis = () => {
      const v = document.visibilityState !== "hidden";
      setVisible(v);
      if (v) void load();
    };
    document.addEventListener("visibilitychange", onVis);
    const iv = setInterval(() => document.visibilityState !== "hidden" && void load(), 60_000);
    // v1.4: race-free listeners, dropped on unmount *and* when Rust says the window is closing
    // (a destroyed WebView2 with live listeners was one cause of the widget-close crash)
    let tlAt = 0;
    const off = subscribe({
      "nook://data-changed": (p: { source?: string } | null) => p?.source !== "widget" && void load(true),
      "nook://capture": () => capRef.current?.focus(),
      // the tracker pushes foreground changes; refresh the Timelens tile at most every 20 s
      "nook://timelens-live": () => {
        if (document.visibilityState === "hidden" || Date.now() - tlAt < 20_000) return;
        tlAt = Date.now();
        void load(true);
      },
      "nook://widget-closing": () => cleanup(),
    });
    if (isTauri) void invoke<{ settings?: { widgetOnTop?: boolean } }>("app_info").then((i) => setOnTop(!!i.settings?.widgetOnTop)).catch(() => {});
    const cleanup = () => {
      document.removeEventListener("visibilitychange", onVis);
      clearInterval(iv);
      off();
    };
    window.addEventListener("pagehide", cleanup);
    return () => {
      window.removeEventListener("pagehide", cleanup);
      cleanup();
    };
  }, [load]);

  const ping = (m: Mood, text: string) => {
    setMood(m);
    setFlash(text);
    setTimeout(() => setMood("idle"), 1800);
    setTimeout(() => setFlash(""), 2200);
  };

  // ---------------------------------------------------------------- window: pill / expand / pin
  const setCompact = async (compact: boolean) => {
    const next = { ...cfg, compact };
    if (isTauri) {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const { LogicalSize } = await import("@tauri-apps/api/dpi");
        const w = getCurrentWindow();
        if (compact) {
          const f = await w.scaleFactor();
          const sz = (await w.innerSize()).toLogical(f);
          next.expanded = { w: Math.round(sz.width), h: Math.round(sz.height) };
          await w.setSize(new LogicalSize(PILL_SIZE.w, PILL_SIZE.h));
        } else {
          await w.setSize(new LogicalSize(cfg.expanded.w, cfg.expanded.h));
        }
      } catch {
        /* window API unavailable — the CSS pill still works */
      }
    }
    setCfg(next);
    writeWidgetCfg(next);
  };
  const togglePin = async () => {
    const v = !onTop;
    setOnTop(v);
    if (isTauri) await invoke("desktop_settings_set", { patch: { widgetOnTop: v } }).catch(() => {});
  };
  const openMain = (route?: string) => (isTauri ? void invoke("focus_main", { route: route ?? null }) : undefined);

  // ---------------------------------------------------------------- actions
  const save = async () => {
    const text = capture.trim();
    if (!text) return;
    if (asTask) {
      await post("/api/tasks", { id: uid(), title: text.split("\n")[0].slice(0, 200), list: "today" });
      ping("happy", "Task added");
    } else {
      const first = text.split("\n")[0].replace(/^#+\s*/, "").slice(0, 80) || "Quick note";
      const body = text.startsWith("#") ? text : `# ${first}\n\n${text.split("\n").slice(1).join("\n")}`.trimEnd() + "\n";
      await post("/api/notes", { id: uid(), title: first, content: body });
      ping("happy", "Note saved");
    }
    setCapture("");
    notifyMain();
    void load(true);
  };
  const fromClipboard = async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) return ping("sad", "Clipboard is empty");
      setCapture(text);
      setAsTask(false);
      capRef.current?.focus();
    } catch {
      ping("sad", "Clipboard blocked");
    }
  };
  const toggle = async (t: Task) => {
    setTasks((ts) => ts.map((x) => (x.id === t.id ? { ...x, done: !x.done, completedAt: !x.done ? Date.now() : null } : x)));
    await post(`/api/tasks/${t.id}`, { done: !t.done }, "PATCH");
    if (!t.done) ping("happy", "Nice!");
    notifyMain();
  };
  const toggleTl = async () => {
    const r = await (await post("/api/timelens/pause", { paused: !tl?.paused })).json();
    ping(r.paused ? "sleep" : "happy", r.paused ? "Timelens paused" : "Timelens on");
    void load(true);
    notifyMain();
  };
  const askAi = async () => {
    const question = q.trim();
    if (!question || busy) return;
    setBusy(true);
    setMood("think");
    setAnswer("");
    try {
      const { handleAiRequest } = await import("@/server/aiRoute");
      const res: AiResult = await handleAiRequest({ action: "agent", question, persona: { name: pet?.name, species: pet?.species } }, (full) => setAnswer(full));
      setAnswer(res.text);
      if (res.tools?.length) {
        notifyMain();
        void load(true);
      }
      setMood("happy");
    } catch {
      setAnswer("My brain wires got tangled. Try again?");
      setMood("sad");
    } finally {
      setBusy(false);
      setQ("");
      setTimeout(() => setMood("idle"), 1600);
    }
  };

  const today = useMemo(() => tasks.filter((t) => t.list === "today" && (!t.done || (t.completedAt ?? 0) > Date.now() - 6 * 3600_000)).slice(0, 8), [tasks]);
  const shellStyle = { ["--wbg" as string]: `color-mix(in srgb, var(--panel-solid) ${Math.round(cfg.opacity * 100)}%, transparent)` };

  const recPill = isLive(meet) ? <RecPill live={meet!} onOpen={() => openMain("meetings")} /> : null;

  // ---------------------------------------------------------------- pill
  if (cfg.compact) {
    if (recPill) return <div className="wg wg-pill" data-testid="widget" data-compact="true" style={shellStyle} data-tauri-drag-region>{recPill}</div>;
    return (
      <div className="wg wg-pill" data-testid="widget" data-compact="true" style={shellStyle} data-tauri-drag-region>
        <span className="wg-dot" data-state={tl?.paused ? "off" : tl?.current?.running && !tl.current.afk ? "on" : "idle"} data-tauri-drag-region />
        <b className="wg-pill-time" data-tauri-drag-region>{tl ? fmt(tl.activeSecs) : "—"}</b>
        <span className="wg-pill-app" data-tauri-drag-region>{tl?.current?.running && !tl.current.afk ? tl.current.app : `${today.filter((t) => !t.done).length} tasks`}</span>
        <button className="wg-ib" title="Expand widget" aria-label="Expand widget" data-testid="widget-expand" onClick={() => void setCompact(false)}><Icon name="expand" size={14} /></button>
      </div>
    );
  }

  const tile = (id: TileId) => {
    if (!visible) return null;
    switch (id) {
      case "capture":
        return (
          <section key={id} className="wg-tile">
            <textarea
              ref={capRef}
              className="wg-input wg-capture"
              placeholder={asTask ? "New task for today…" : "Quick note… (Ctrl+Enter)"}
              value={capture}
              onChange={(e) => setCapture(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey || asTask)) {
                  e.preventDefault();
                  void save();
                }
              }}
              aria-label="Quick capture"
            />
            <div className="wg-row">
              <label className="wg-check"><input type="checkbox" checked={asTask} onChange={(e) => setAsTask(e.target.checked)} /> as task</label>
              <button className="wg-ib" title="Paste from clipboard" aria-label="Paste from clipboard" onClick={() => void fromClipboard()}><Icon name="copy" size={13} /></button>
              <Suspense fallback={null}><MicButton compact onText={(t) => setCapture((c) => (c ? `${c} ${t}` : t))} /></Suspense>
              <span className="flex-1" />
              <button className="wg-btn wg-primary" onClick={() => void save()} disabled={!capture.trim()}>Save</button>
            </div>
          </section>
        );
      case "timelens":
        return tl ? (
          <section key={id} className="wg-tile wg-tl" data-testid="widget-timelens">
            <div className="wg-row">
              <span className="wg-dot" data-state={tl.paused ? "off" : tl.current.running && !tl.current.afk ? "on" : "idle"} />
              <b className="wg-big">{fmt(tl.activeSecs)}</b>
              <span className="wg-muted min-w-0 flex-1 truncate">{tl.paused ? "paused" : tl.current.running ? (tl.current.afk ? "away" : tl.current.app) : "today"}</span>
              <button className="wg-ib" onClick={() => void toggleTl()} aria-label={tl.paused ? "Resume Timelens" : "Pause Timelens"} title={tl.paused ? "Resume Timelens" : "Pause Timelens"}><Icon name={tl.paused ? "play" : "pause"} size={13} /></button>
            </div>
            {tl.apps?.length > 0 && (
              <div className="wg-apps" data-testid="widget-top-apps">
                {tl.apps.slice(0, 4).map((a) => (
                  <span key={a.app} className="wg-app" title={`${a.app} · ${fmt(a.secs)}`}>
                    {icons[a.app] ? <img src={icons[a.app]} alt="" width={16} height={16} data-testid="widget-app-icon" /> : <BrandOrLetter app={a.app} />}
                    <span>{fmt(a.secs)}</span>
                  </span>
                ))}
              </div>
            )}
          </section>
        ) : null;
      case "tasks":
        return (
          <section key={id} className="wg-tile wg-tasks">
            <div className="wg-head2">
              <span>Today</span>
              <button className="wg-link" onClick={() => openMain("tasks")}>All tasks</button>
            </div>
            {today.length === 0 && <div className="wg-muted py-1">Nothing due today.</div>}
            {today.map((t) => (
              <label key={t.id} className="widget-task" data-done={t.done}>
                <input type="checkbox" checked={t.done} onChange={() => void toggle(t)} />
                <span className="min-w-0 flex-1 break-words">{t.title}</span>
                {t.priority === 2 && <span className="text-[10px] text-accent">!!</span>}
              </label>
            ))}
          </section>
        );
      case "focus":
        return <FocusTile key={id} onDone={() => { ping("happy", "Focus done!"); notifyMain(); }} />;
      case "ai":
        return (
          <section key={id} className="wg-tile">
            <div className="wg-row">
              <input className="wg-input flex-1" placeholder={`Ask ${pet?.name ?? "your pet"}…`} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void askAi()} aria-label="Ask the AI" />
              <button className="wg-btn" onClick={() => void askAi()} disabled={busy || !q.trim()}>{busy ? "…" : "Ask"}</button>
            </div>
            {answer && <div className="wg-answer selectable" data-testid="widget-answer">{answer}</div>}
          </section>
        );
      case "pet":
        return pet ? (
          <section key={id} className="wg-tile wg-row wg-pet" data-testid="widget-pet">
            <PetSprite pet={pet} mood={mood} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold">{pet.name}</div>
              <div className="wg-muted truncate">{flash || `${pet.coins} coins · joy ${Math.round(pet.joy)}`}</div>
            </div>
          </section>
        ) : null;
    }
  };

  return (
    <div className="wg" data-testid="widget" data-compact="false" style={shellStyle}>
      <header className="wg-header" data-tauri-drag-region>
        <img src={brandSrc(tone)} alt="" width={16} height={16} className="rounded-[4px]" data-tone={tone} data-testid="widget-brand" data-tauri-drag-region />
        <span className="wg-title" data-tauri-drag-region>{flash || pet?.name || "Nook"}</span>
        <button className="wg-ib" data-on={onTop} title={onTop ? "Unpin (sit on the desktop)" : "Keep on top"} aria-label="Keep widget on top" onClick={() => void togglePin()}><Icon name="map-pin" size={13} /></button>
        <button className="wg-ib" title="Collapse to a pill" aria-label="Collapse widget" data-testid="widget-collapse" onClick={() => void setCompact(true)}><Icon name="minus" size={14} /></button>
        <button className="wg-ib" title="Open Nook" aria-label="Open Nook" onClick={() => openMain()}><Icon name="external-arrow" size={13} /></button>
        <button className="wg-ib" title="Hide widget" aria-label="Hide widget" onClick={() => isTauri && void invoke("widget_toggle", { show: false })}><Icon name="close" size={13} /></button>
      </header>
      {recPill && <div className="wg-rec-row">{recPill}</div>}
      <div className="wg-body">{cfg.tiles.filter((t) => t.on && live(t.id)).map((t) => tile(t.id))}</div>
    </div>
  );
}

/** 25-minute focus timer; ticks once a second only while running (and pauses its UI when hidden). */
function FocusTile({ onDone }: { onDone: () => void }) {
  const KEY = "nook:widgetFocus";
  const [endsAt, setEndsAt] = useState<number | null>(() => Number(localStorage.getItem(KEY)) || null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!endsAt) return;
    const iv = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(iv);
  }, [endsAt]);
  useEffect(() => {
    if (endsAt && now >= endsAt) {
      localStorage.removeItem(KEY);
      setEndsAt(null);
      void post("/api/timelens/focus", { start: endsAt - 25 * 60_000, end: endsAt, label: "Focus session (widget)" });
      onDone();
    }
  }, [now, endsAt, onDone]);
  const left = endsAt ? Math.max(0, Math.ceil((endsAt - now) / 1000)) : 25 * 60;
  const start = () => {
    const t = Date.now() + 25 * 60_000;
    localStorage.setItem(KEY, String(t));
    setNow(Date.now());
    setEndsAt(t);
  };
  const stop = () => {
    localStorage.removeItem(KEY);
    setEndsAt(null);
  };
  return (
    <section className="wg-tile wg-row" data-testid="widget-focus">
      <Icon name="hourglass" size={15} className="text-accent" />
      <b className="wg-big tabular-nums">{String(Math.floor(left / 60)).padStart(2, "0")}:{String(left % 60).padStart(2, "0")}</b>
      <span className="wg-muted flex-1">{endsAt ? "focusing" : "focus"}</span>
      {endsAt ? <button className="wg-btn" onClick={stop}>Stop</button> : <button className="wg-btn wg-primary" onClick={start}>Start</button>}
    </section>
  );
}

/** v1.4: "● REC 12:34" with pause / stop — shown while a meeting is recorded */
function RecPill({ live, onOpen }: { live: MeetingLive; onOpen: () => void }) {
  const paused = live.state === "paused";
  return (
    <div className="wg-rec" data-testid="widget-rec" data-state={live.state} data-tauri-drag-region>
      <span className="wg-rec-dot" data-paused={paused} data-tauri-drag-region />
      <button className="wg-rec-time" onClick={onOpen} title="Open Meetings">{paused ? "Paused" : "REC"} {fmtElapsed(live.elapsedMs)}</button>
      <button className="wg-ib" title={paused ? "Resume" : "Pause"} aria-label={paused ? "Resume recording" : "Pause recording"} onClick={() => void meetingsApi.pause(!paused).catch(() => {})}><Icon name={paused ? "play" : "pause"} size={13} /></button>
      <button className="wg-ib" title="Stop recording" aria-label="Stop recording" data-testid="widget-rec-stop" onClick={() => void meetingsApi.stop().then(onOpen).catch(() => {})}><Icon name="stop" size={13} /></button>
    </div>
  );
}
