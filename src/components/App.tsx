import { lazy, Suspense, useEffect, useRef, useState, type ComponentType } from "react";
import { CommandPalette } from "@/components/CommandPalette";
import { Dashboard } from "@/components/Dashboard";
import { DesktopPet } from "@/components/DesktopPet";
import { DockRail, FloatRail, Rail } from "@/components/Rail";
import { Editor } from "@/components/Editor";
import { GuidedTour } from "@/components/GuidedTour";
import { HelpOverlay } from "@/components/HelpOverlay";
import { LogsBugs } from "@/components/LogsBugs";
import { NotesDrawer } from "@/components/NotesDrawer";
import { NoteList } from "@/components/NoteList";
import { NoteTabs } from "@/components/NoteTabs";
import { ContextMenuHost } from "@/components/ContextMenu";
import ShareReader from "@/components/ShareReader";
import { NotificationCenter } from "@/components/NotificationCenter";
import { PetQuickChat } from "@/components/PetQuickChat";
import { RightPanel } from "@/components/RightPanel";
import { StatusBar, Toasts } from "@/components/StatusBar";
import { TitleBar } from "@/components/TitleBar";
import { flushAll, useStore, rulesDirtyAt, type EditorMode } from "@/lib/store";
import { setMuted, setVolume, startMusic, unlockAudio } from "@/lib/sfx";
import { installLogger, logEvent } from "@/lib/logger";
import { startMarketWatcher } from "@/lib/marketWatch";
import { initCoinFly } from "@/lib/coinFly";
import { activity } from "@/lib/activity";
import { categorize } from "@/lib/store";
import { DEFAULT_RULES, type RulesState } from "@/lib/rules";
import { wallpaperCss } from "@/lib/wallpapers";
import type { InitialData } from "@/lib/types";

const Loading = () => (
  <div className="grid h-full place-items-center">
    <div className="pixel-font text-dim shimmer rounded-xl px-5 py-3">loading…</div>
  </div>
);
/** code-split heavy views: each loads on first visit, with the same pixel "loading…" placeholder */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lazyView(load: () => Promise<{ default: ComponentType<any> }>) {
  const L = lazy(load);
  const View = () => (
    <Suspense fallback={<Loading />}>
      <L />
    </Suspense>
  );
  return View;
}
const GraphView = lazyView(() => import("@/components/GraphView").then((m) => ({ default: m.GraphView })));
const CanvasView = lazyView(() => import("@/components/CanvasView").then((m) => ({ default: m.CanvasView })));
const PetDen = lazyView(() => import("@/components/PetDen").then((m) => ({ default: m.PetDen })));
const FocusView = lazyView(() => import("@/components/FocusView").then((m) => ({ default: m.FocusView })));
const ArcadeView = lazyView(() => import("@/components/ArcadeView").then((m) => ({ default: m.ArcadeView })));
const TeamView = lazyView(() => import("@/components/TeamView").then((m) => ({ default: m.TeamView })));
const MarketView = lazyView(() => import("@/components/MarketView").then((m) => ({ default: m.MarketView })));
const TasksView = lazyView(() => import("@/components/TasksView").then((m) => ({ default: m.TasksView })));
const ActivityView = lazyView(() => import("@/components/ActivityView").then((m) => ({ default: m.ActivityView })));
const RulesView = lazyView(() => import("@/components/RulesView").then((m) => ({ default: m.RulesView })));
const SettingsView = lazyView(() => import("@/components/SettingsView").then((m) => ({ default: m.SettingsView })));

const VIEWS = ["notes", "graph", "canvas", "tasks", "den", "focus", "arcade", "team", "market", "activity"] as const;
const MODES: EditorMode[] = ["write", "split", "read"];

/** rule enforcement nags are rate-limited per app (one toast each 5 min) */
const ruleNagAt = new Map<string, number>();

/**
 * Pet proactive nags — the pet watches how you spend time and speaks up:
 * "don't waste your time" on distraction apps, task nudges, writing nudges.
 * Rate-limited (one nag per 6 min), fully off-able (Settings / title bar).
 */
let lastNagAt = 0;
const NAG_LINES = {
  waste: [
    (app: string) => `Hey boss — you've been on ${app} for a bit. Don't waste your time!`,
    (app: string) => `${app} again? Don't waste your time — let's do something real.`,
    (app: string) => `I'm watching that ${app} tab… tick tock! Back to work?`,
    () => "Don't waste your time, boss. Your future self is watching.",
    (app: string) => `A whole lot of ${app} isn't on today's plan. Just saying!`,
  ],
  tasks: [
    (n: number) => `You have ${n} open tasks. Want to knock one out?`,
    (n: number) => `${n} tasks are waiting patiently… too patiently. Let's go!`,
    (n: number) => `Quick win? ${n} open tasks in the list.`,
  ],
  write: [
    () => "It's quiet in here… a blank page never hurt anyone. Write a line?",
    () => "No words today yet. Even one sentence counts!",
    () => "Your notes miss you. One idea, that's all I ask.",
  ],
  focus: [
    () => "A 25-minute focus sprint would feel SO good right now.",
    () => "Timer's ready when you are. Focus mode?",
  ],
};
const pick = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];

function usePetNag() {
  useEffect(() => {
    const iv = setInterval(() => {
      const s = useStore.getState();
      if (!s.petNag || s.dnd || document.hidden) return;
      const now = Date.now();
      if (now - lastNagAt < 6 * 60_000) return;
      const roll = Math.random();
      if (roll > 0.34) return; // nag at most ~1/3 of checks
      let line: string | null = null;
      const app = s.currentApp?.toLowerCase();
      const secsOnApp = app ? s.appUse[`${new Date().toISOString().slice(0, 10)}|${app}`] ?? 0 : 0;
      const openTasks = s.tasks.filter((t) => !t.done).length;
      if (app && secsOnApp > 4 * 60 && categorize(app, s.appCat, s.rules.patterns) === "distraction") {
        line = pick(NAG_LINES.waste)(s.currentApp!);
        s.doAct("sad", 2200);
      } else if (openTasks >= 3 && Math.random() < 0.55) {
        line = pick(NAG_LINES.tasks)(openTasks);
      } else if (Object.values(s.activity).reduce((a, b) => a + b, 0) === 0 || !Object.keys(s.activity).includes(new Date().toISOString().slice(0, 10))) {
        line = pick(NAG_LINES.write)();
      } else if (Math.random() < 0.25) {
        line = pick(NAG_LINES.focus)();
      }
      if (line) {
        lastNagAt = now;
        s.say(line);
        s.toast(line, "message-text");
      }
    }, 45_000);
    return () => clearInterval(iv);
  }, []);
}

/** TimeLens-style in-app usage tracker: accumulates seconds per view while the tab is visible & the user active */
function useAppTimeTracker() {
  const view = useStore((s) => s.view);
  useEffect(() => {
    let lastInput = Date.now();
    const onMove = () => (activity.lastInput = lastInput = Date.now());
    const onKey = () => (activity.lastInput = lastInput = Date.now());
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("keydown", onKey);
    const iv = setInterval(() => {
      if (document.hidden || Date.now() - lastInput > 120_000) return; // hidden or idle >2min → don't count
      const s = useStore.getState();
      const app = s.currentApp ? s.currentApp.toLowerCase() : `nook:${s.view}`;
      // ---- rule engine: blocked apps + limits (shield must be up) ----
      if (s.currentApp && s.rules.shieldOn) {
        const v = s.checkAppRules(s.currentApp);
        const now = Date.now();
        if (v.blocked) {
          if (now - (ruleNagAt.get(app) ?? 0) > 60_000) {
            ruleNagAt.set(app, now);
            s.set({ blockedAttempts: s.blockedAttempts + 1 });
            s.toast(`${s.currentApp} is blocked by your rules!`, "block");
            s.doAct("sad", 2000);
            s.say(`${s.currentApp} is on the blocklist — the shield says no!`);
            if (s.blockedAttempts + 1 >= 5) s.unlock("bouncer", "Bouncer", "Bounced 5 blocked-app attempts", "shield");
          }
        } else if (v.over && now - (ruleNagAt.get(`lim:${app}`) ?? 0) > 300_000) {
          ruleNagAt.set(`lim:${app}`, now);
          s.toast(`${s.currentApp} is over its ${v.limitMins}m limit`, "alert");
          s.say(`You've blown past your ${s.currentApp} budget. One more scroll won't help.`);
          s.doAct("sad", 1800);
        } else if (v.quietViolate && now - (ruleNagAt.get(`q:${app}`) ?? 0) > 300_000) {
          ruleNagAt.set(`q:${app}`, now);
          s.toast(`Quiet hours — ${s.currentApp} isn't productive`, "moon");
          s.say("Quiet hours! Something productive, maybe?");
        }
      }
      s.trackApp(app, 15);
    }, 15_000);
    return () => {
      clearInterval(iv);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
}

export function App({ initial }: { initial: InitialData }) {
  const hydrated = useRef(false);
  if (!hydrated.current) {
    useStore.getState().hydrate(initial);
    hydrated.current = true;
  }
  const view = useStore((s) => s.view);
  const zen = useStore((s) => s.zen);
  const sidebar = useStore((s) => s.sidebar);
  const notesList = useStore((s) => s.notesList);
  const rightOpen = useStore((s) => s.rightOpen);
  const cleanMode = useStore((s) => s.cleanMode);
  const activeId = useStore((s) => s.activeId);
  const muted = useStore((s) => s.muted);
  const volume = useStore((s) => s.volume);
  const music = useStore((s) => s.music);
  const railPos = useStore((s) => s.railPos);
  const petEnabled = useStore((s) => s.petEnabled);
  const wallpaper = useStore((s) => s.wallpaper);
  useAppTimeTracker();
  usePetNag();

  /** public share links (?share=<id>) render as a full-screen reader overlay */
  const [shareId, setShareId] = useState<string | null>(null);
  useEffect(() => {
    const check = () => {
      const m = /(?:^|\?|&)share=([\w-]+)/.exec(window.location.search);
      setShareId(m ? m[1] : null);
    };
    check();
    window.addEventListener("popstate", check);
    return () => window.removeEventListener("popstate", check);
  }, []);

  useEffect(() => {
    const st = useStore.getState();
    st.loadPrefs();
    // dev-only debug/E2E handle
    if (import.meta.env.DEV || (window as unknown as { __NOOK_E2E__?: boolean }).__NOOK_E2E__) (window as unknown as Record<string, unknown>).__nook = useStore;
    document.documentElement.dataset.theme = useStore.getState().theme;
    setMuted(useStore.getState().muted);
    setVolume(useStore.getState().volume);
    const iv1 = setInterval(() => useStore.getState().tick(), 1000);
    const iv2 = setInterval(() => useStore.getState().tickPet(), 30_000);
    // live bazaar: bot sales anywhere in the app (coins + badge), listings kept fresh
    startMarketWatcher();
    // remember click points so coin rewards can fly from where the user clicked
    initCoinFly();
    // global error/warn/rejection capture → the Logs & Bugs center
    installLogger();
    logEvent("nook booted", "info", "app");
    // tasks hydrate + first-visit pet tour
    void st.loadTasks();
    void st.loadCustomGames();
    // keep the rulebook in sync with the server (the AI harness and other browsers write there too)
    const ivRules = setInterval(() => {
      void fetch("/api/rules")
        .then((r) => r.json())
        .then((j) => {
          if (!j?.rules) return;
          if (Date.now() - rulesDirtyAt < 10_000) return; // local edit just happened — don't clobber it
          const cur = useStore.getState().rules;
          if (JSON.stringify(cur) !== JSON.stringify(j.rules)) useStore.setState({ rules: { ...DEFAULT_RULES, ...(j.rules as RulesState) } });
        })
        .catch(() => {});
    }, 30_000);
    const tour = setTimeout(() => {
      if (!useStore.getState().tourDone) useStore.getState().startTour();
    }, 1600);
    const flush = () => flushAll();
    const vis = () => document.hidden && flush();
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", vis);
    const hi = setTimeout(() => {
      const p = useStore.getState().pet;
      useStore.getState().say(p.food < 30 ? "I'm hungry… visit the Den?" : `${p.name} is here. Let's write something!`);
    }, 1400);

    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });

    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === "k") {
        e.preventDefault();
        useStore.setState({ palette: !s.palette });
      } else if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag !== "INPUT" && tag !== "TEXTAREA" && !(e.target as HTMLElement)?.isContentEditable) {
          e.preventDefault();
          useStore.setState({ help: !s.help });
        }
      } else if (mod && e.shiftKey && k === "n") {
        e.preventDefault();
        useStore.setState({ notesDrawer: !s.notesDrawer });
      } else if (e.altKey && !mod) {
        if (k === "n") { e.preventDefault(); s.createNote({ content: "" }); }
        else if (k === "z") { e.preventDefault(); useStore.setState({ zen: !s.zen }); }
        else if (k === "s") { e.preventDefault(); useStore.setState({ muted: !s.muted }); }
        else if (k === "d") { e.preventDefault(); useStore.setState({ notesDrawer: !s.notesDrawer }); }
        else if (k === "r") { e.preventDefault(); s.setView("rules"); }
        else if (/^[1-9]$/.test(k)) { e.preventDefault(); s.setView(VIEWS[Number(k) - 1]); }
        else if (k === "0") { e.preventDefault(); s.setView("activity"); }
        // Alt+- → Settings (was unreachable in the original: shadowed by this Alt branch)
        else if (e.key === "-" || e.code === "Minus") { e.preventDefault(); s.setView("settings"); }
      } else if (mod && k === "b") {
        e.preventDefault();
        s.set({ sidebar: !s.sidebar });
      } else if (mod && k === "\\") {
        e.preventDefault();
        s.toggleClean();
      } else if (mod && k === "j") {
        e.preventDefault();
        s.set({ rightOpen: !s.rightOpen });
      } else if (mod && k === "e" && s.view === "notes") {
        e.preventDefault();
        s.set({ editorMode: MODES[(MODES.indexOf(s.editorMode) + 1) % 3] });
      } else if (mod && k === "g") {
        e.preventDefault();
        s.setView("graph");
      } else if (mod && (k === "=" || k === "+")) {
        e.preventDefault();
        s.setAppScale(Math.min(1.35, s.appScale + 0.05));
      } else if (mod && k === "-") {
        e.preventDefault();
        s.setAppScale(Math.max(0.85, s.appScale - 0.05));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(iv1);
      clearInterval(iv2);
      clearInterval(ivRules);
      clearTimeout(hi);
      clearTimeout(tour);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", vis);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    setMuted(muted);
    setVolume(volume);
  }, [muted, volume]);

  useEffect(() => {
    if (!music || muted) return;
    const stop = startMusic();
    return stop;
  }, [music, muted]);

  return (
    <div className="fixed inset-0 flex flex-col gap-2 p-2 pb-0" data-clean={cleanMode}>
      {/* whole-app wallpaper layer (behind everything) */}
      {wallpaper.id !== "none" && (
        <div aria-hidden className="pointer-events-none fixed inset-0 z-0" style={{ background: wallpaperCss(wallpaper.id, wallpaper.img), filter: wallpaper.blur ? `blur(${wallpaper.blur}px)` : undefined, transform: wallpaper.blur ? "scale(1.04)" : undefined }}>
          <div className="absolute inset-0" style={{ background: "var(--bg)", opacity: wallpaper.dim }} />
        </div>
      )}
      <div className="relative z-[1] flex min-h-0 flex-1 flex-col gap-2">
      <TitleBar />
      <div className="flex min-h-0 flex-1 gap-2">
        {!zen && !cleanMode && railPos === "left" && sidebar && <Rail />}
        <main className="flex min-w-0 flex-1 gap-2">
          {view === "notes" && notesList && sidebar && !zen && !cleanMode && <NoteList />}
          <section key={view} data-view={view} className="view-enter relative min-w-0 flex-1 overflow-hidden">
            {view === "notes" && (
              <div className="flex h-full min-h-0 flex-col">
                <NoteTabs />
                <div className="min-h-0 flex-1">
                  {activeId ? <Editor key={activeId} id={activeId} /> : <Dashboard />}
                </div>
              </div>
            )}
            {view === "graph" && <GraphView />}
            {view === "canvas" && <CanvasView />}
            {view === "den" && <PetDen />}
            {view === "focus" && <FocusView />}
            {view === "arcade" && <ArcadeView />}
            {view === "team" && <TeamView />}
            {view === "market" && <MarketView />}
            {view === "tasks" && <TasksView />}
            {view === "activity" && <ActivityView />}
            {view === "rules" && <RulesView />}
            {view === "settings" && <SettingsView />}
          </section>
          {view === "notes" && rightOpen && !zen && !cleanMode && <RightPanel />}
        </main>
        {!zen && !cleanMode && railPos === "right" && sidebar && <Rail />}
      </div>
      <StatusBar />
      {!zen && !cleanMode && railPos === "dock" && sidebar && <DockRail />}
      </div>
      {!zen && !cleanMode && railPos === "float" && sidebar && <FloatRail />}
      {petEnabled && <DesktopPet />}
      {petEnabled && <PetQuickChat />}
      <NotesDrawer />
      <GuidedTour />
      <NotificationCenter />
      <LogsBugs />
      <CommandPalette />
      <HelpOverlay />
      <ContextMenuHost />
      {shareId && (
        <div className="fixed inset-0 z-[300]" style={{ background: "var(--bg)" }}>
          <ShareReader
            shareId={shareId}
            onExit={() => {
              const u = new URL(window.location.href);
              u.searchParams.delete("share");
              window.history.replaceState({}, "", u.pathname + (u.searchParams.toString() ? `?${u.searchParams}` : ""));
              setShareId(null);
            }}
          />
        </div>
      )}
      <Toasts />
    </div>
  );
}
