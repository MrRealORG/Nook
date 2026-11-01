
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/icons";
import { pickImportFile } from "@/lib/io";
import { FOODS } from "@/lib/pet";
import { feedPet, fetchForgotten, napPet, patPet, trickPet } from "@/lib/petActions";
import type { FeatureId } from "@/lib/features";
import { useStore } from "@/lib/store";
import { TEMPLATES } from "@/lib/templates";
import { THEME_IDS, THEMES } from "@/lib/themes";
import { plain } from "@/lib/util";

type Item = { id: string; label: string; hint?: string; icon: IconName; kind: "cmd" | "note"; run: () => void; score?: number };

function fuzzy(q: string, t: string): number {
  if (!q) return 1;
  t = t.toLowerCase();
  if (t === q) return 10;
  if (t.startsWith(q)) return 6;
  if (t.includes(q)) return 4;
  let i = 0;
  for (const c of t) if (c === q[i]) i++;
  return i === q.length ? 1.5 : 0;
}

/** which feature a command belongs to — commands of switched-off features are not offered */
const CMD_FEATURE: [RegExp, FeatureId][] = [
  [/^(v-graph)$/, "graph"], [/^(v-canvas|canvas-new)$/, "canvas"], [/^(v-tasks|task-add)$/, "tasks"],
  [/^(v-den|trick-random|pet-|feed-|roam|daily-gift)/, "pet"], [/^(v-focus|focus-go)$/, "focus"], [/^(v-arcade|arcade-stats)$/, "arcade"],
  [/^v-team$/, "team"], [/^(v-market|my-booth)$/, "market"], [/^(v-activity|csv)$/, "activity"], [/^(v-rules|shield-toggle)$/, "rules"], [/^(v-meetings|meeting-)/, "meetings"],
  [/^(ai|plan-day|status-report)$/, "chat"],
];
const cmdFeature = (id: string) => CMD_FEATURE.find(([re]) => re.test(id))?.[1];

function Palette() {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const notes = useStore((s) => s.notes);
  const features = useStore((s) => s.features);
  const list = useRef<HTMLDivElement>(null);
  const st = useStore.getState;
  const close = () => useStore.setState({ palette: false });

  const commands = useMemo<Item[]>(() => {
    const go = (v: Parameters<ReturnType<typeof useStore.getState>["setView"]>[0]) => () => st().setView(v);
    const c = (id: string, label: string, icon: IconName, run: () => void, hint?: string): Item => ({ id, label, icon, run, hint, kind: "cmd" });
    return [
      c("new", "New note", "plus", () => st().createNote(), "Alt N"),
      ...TEMPLATES.map((t) => c(`tpl-${t.id}`, `New note: ${t.name}`, t.icon, () => st().createNote({ title: t.title, content: t.content }), t.blurb)),
      c("export", "Export notes (JSON backup)", "download", () => st().exportNotes()),
      c("bug-report", "Report a bug", "bug", () => void import("@/components/BugReport").then((m) => m.openBugReport())),
      c("logs", "Open logs", "database", () => { st().set({ settingsSection: "logs" }); st().setView("settings"); }),
      c("updates", "Check for updates", "refresh", () => void import("@/lib/updater").then((m) => m.checkForUpdates(false))),
      c("import", "Import notes from backup", "upload", () => pickImportFile()),
      c("v-notes", "Go to Notes", "notes", go("notes"), "Alt 1"),
      c("v-graph", "Go to Graph (2D / 3D)", "algorithm", go("graph"), "Alt 2"),
      c("v-canvas", "Go to Canvas", "shapes", go("canvas"), "Alt 3"),
      c("v-tasks", "Go to Tasks & todos", "tasklist", go("tasks"), "Alt 4"),
      c("v-den", "Go to Pet den", "dog", go("den"), "Alt 5"),
      c("v-focus", "Go to Focus timer", "hourglass", go("focus"), "Alt 6"),
      c("v-arcade", "Go to Arcade (12 games)", "gamepad", go("arcade"), "Alt 7"),
      c("v-team", "Go to Team room", "message-text", go("team"), "Alt 8"),
      c("v-market", "Go to Marketplace", "coins", go("market"), "Alt 9"),
      c("arcade-stats", "Arcade stats (records, plays, XP)", "trophy", () => { useStore.setState({ view: "arcade", arcadeStats: true }); }),
      c("my-booth", "Open my market booth", "map-pin", () => { useStore.setState({ view: "market" }); }),
      c("v-activity", "Go to Activity (app time)", "activity", go("activity"), "Alt 0"),
      c("v-rules", "Go to Rules (block sites, limits, quiet hours)", "shield", go("rules"), "Alt R"),
      c("v-meetings", "Go to Meetings (record, transcribe, summarise calls)", "mic", go("meetings"), "Alt M"),
      c("meeting-toggle", "Start / stop recording a meeting", "mic", () => { void import("@/lib/meetings").then(async ({ meetingsApi, isLive }) => { const l = await meetingsApi.live().catch(() => null); if (isLive(l)) await meetingsApi.stop(); else await meetingsApi.start(); }).catch((e) => st().toast(String(e instanceof Error ? e.message : e), "alert")); go("meetings")(); }, "Ctrl Alt M"),
      c("v-settings", "Go to Settings", "sliders", go("settings")),
      c("shield-toggle", "Toggle shield mode (rule enforcement)", "shield-on", () => {
        const next = !st().rules.shieldOn;
        st().setRules({ shieldOn: next });
        st().toast(next ? "Shield up — rules enforced" : "Shield down", "shield");
      }),
      c("csv", "Export activity log as CSV", "download", () => { go("activity")(); }),
      c("drawer", "Open the all-notes drawer", "library", () => useStore.setState({ notesDrawer: true }), "Alt D"),
      c("tour", "Replay the welcome tour", "map-pin", () => st().startTour()),
      c("task-add", "New task (Tasks room)", "checkbox-on", () => { useStore.setState({ view: "tasks" }); }),
      c("plan-day", "AI: plan my day (real tasks)", "sparkles", () => { useStore.setState({ view: "notes", rightOpen: true, rightTab: "ai" }); void st().runAi("agent", { question: "Plan my day: look at my vault, notes and open tasks, then create up to 5 focused tasks for today. Briefly say why." }); }),
      c("status-report", "AI: full status report", "gauge", () => { useStore.setState({ view: "notes", rightOpen: true, rightTab: "ai" }); void st().runAi("agent", { question: "Give me a status report: vault stats, open tasks, my pet's mood and today's tracked time." }); }),
      c("notices", "Notification center (bell inbox)", "bell", () => useStore.setState({ noticeOpen: true })),
      c("dnd", "Toggle do-not-disturb (quiet popups)", "moon", () => {
        const next = !st().dnd;
        st().set({ dnd: next });
        st().toast(next ? "Do not disturb on — popups muted, bell keeps recording" : "Do not disturb off", "moon");
      }),
      c("bug-report", "Report a bug (with logs attached)", "bug", () => useStore.setState({ bugOpen: true, bugTab: "report" })),
      c("bug-logs", "Open the live log viewer", "logs", () => useStore.setState({ bugOpen: true, bugTab: "logs" })),
      c("bug-tracker", "My bug reports (tracker)", "archive", () => useStore.setState({ bugOpen: true, bugTab: "reports" })),
      c("voice-models", "Voice typing: download a speech model", "mic", () => { st().set({ settingsSection: "voice" }); go("settings")(); }),
      c("trick-random", "Ask your pet for a random trick", "star", () => { st().setView("den"); trickPet(); }),
      c("daily-gift", "Claim the daily gift", "gift", () => { st().claimDailyGift(); useStore.setState({ view: "notes" }); }, "resets daily"),
      c("ai", "Ask the AI", "sparkles", () => { useStore.setState({ view: "notes", rightOpen: true, rightTab: "ai" }); }, "Ctrl J"),
      c("canvas-new", "New canvas board", "shapes", () => { st().createCanvas(); st().setView("canvas"); }),
      c("folder-new", "New folder", "folder", () => { st().createFolder(); st().setView("notes"); }),
      c("focus-go", "Start a focus session", "hourglass", () => { st().resetTimer("focus"); st().startTimer(); st().setView("focus"); }),
      c("zen", "Toggle zen mode", "minus", () => useStore.setState((s) => ({ zen: !s.zen })), "Alt Z"),
      c("clean", "Toggle ultra-clean mode (hide all side panels)", "collapse", () => st().toggleClean(), "Ctrl \\"),
      c("side", "Toggle sidebar", "layout", () => st().set({ sidebar: !st().sidebar }), "Ctrl B"),
      c("notelist", "Toggle notes list", "note", () => st().set({ notesList: !st().notesList })),
      c("style-nook", "UI style: Nook classic", "sparkle", () => st().setUiStyle("nook")),
      c("style-pixel", "UI style: Pixel", "shapes", () => st().setUiStyle("pixel")),
      c("style-obsidian", "UI style: Obsidian", "book", () => st().setUiStyle("obsidian")),
      c("obs-light", "Obsidian: toggle light / dark mode", "moon", () => st().setObsLight(!st().obsLight)),
      c("daily", "Open today's daily note", "calendar", () => st().openDailyNote()),
      c("ui-bigger", "Make the UI bigger", "zoom-in", () => st().setAppScale(Math.min(1.35, st().appScale + 0.05)), "Ctrl +"),
      c("ui-smaller", "Make the UI smaller", "zoom-out", () => st().setAppScale(Math.max(0.85, st().appScale - 0.05)), "Ctrl -"),
      c("sound", "Toggle sound effects", "coins", () => st().set({ muted: !st().muted }), "Alt S"),
      c("music", "Toggle ambient music", "gamepad", () => st().set({ music: !st().music })),
      c("pet-pat", "Pet your companion", "heart", patPet),
      c("pet-nap", "Let your pet nap", "moon", napPet),
      c("pet-trick", "Ask for a trick", "star", trickPet),
      c("pet-fetch", "Fetch a forgotten note", "archive", () => void fetchForgotten()),
      ...FOODS.map((f) => c(`feed-${f.id}`, `Feed: ${f.name}`, f.icon, () => feedPet(f.id), f.cost ? `${f.cost} coins` : "free")),
      ...THEME_IDS.map((t) => c(`theme-${t}`, `Theme: ${THEMES[t].name}`, THEMES[t].dark ? "moon" : "sun", () => st().setTheme(t))),
      c("roam", "Toggle desktop pet", "dog", () => st().set({ roam: !st().roam })),
      c("help", "Open the Nook handbook (all shortcuts)", "keyboard", () => useStore.setState({ help: true }), "?"),
      // 1.3
      c("switcher", "Quick switcher — jump to a note", "search", () => useStore.setState({ switcherOpen: true, palette: false }), "Ctrl O"),
      c("layout-obsidian", "Layout: Obsidian style (file tree · tabs · right sidebar)", "layout", () => st().setLayout("obsidian")),
      c("layout-nook", "Layout: Nook style (rail + panes)", "layout", () => st().setLayout("nook")),
      c("icons-pixel", "Icon style: Pixel", "shapes", () => st().setIconStyle("pixel")),
      c("icons-clean", "Icon style: Clean", "sparkle", () => st().setIconStyle("clean")),
      c("style-clean", "UI style: Clean", "sparkle", () => st().setUiStyle("clean")),
      c("onboarding", "Run the welcome onboarding again", "sparkles", () => useStore.setState({ onboardingOpen: true, palette: false })),
      c("features", "Turn features on / off", "checkbox-on", () => { st().set({ settingsSection: "features" }); go("settings")(); }),
    ].filter((x) => {
      const f = cmdFeature(x.id);
      return !f || features[f] !== false;
    });
  }, [features]);

  const results = useMemo(() => {
    const raw = q.trim().toLowerCase();
    const cmdOnly = raw.startsWith(">");
    const ql = cmdOnly ? raw.slice(1).trim() : raw;
    const out: Item[] = [];
    for (const c of commands) {
      const s = fuzzy(ql, c.label);
      if (s > 0) out.push({ ...c, score: s + (ql ? 0 : 0.5) });
    }
    if (!cmdOnly) {
      for (const n of notes) {
        let s = fuzzy(ql, n.title) * 1.4;
        let hint: string | undefined;
        if (ql && s === 0) {
          const at = n.content.toLowerCase().indexOf(ql);
          if (at >= 0) {
            s = 0.8;
            hint = "…" + plain(n.content.slice(Math.max(0, at - 24), at + 48)) + "…";
          }
        }
        if (s > 0) out.push({ id: n.id, label: n.title, hint, icon: "note", kind: "note", run: () => st().openNote(n.id), score: s + (ql ? 0 : 1.2) });
      }
    }
    return out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 40);
     
  }, [q, notes, commands]);

  const [syncedQ, setSyncedQ] = useState(q);
  if (q !== syncedQ) {
    setSyncedQ(q);
    setIdx(0);
  }
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${idx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  const run = (it?: Item) => {
    if (!it) return;
    close();
    it.run();
  };

  return (
    <div className="fixed inset-0 z-[85] grid place-items-start justify-center bg-black/40 pt-[14vh]" style={{ animation: "pop .18s ease both" }} onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="panel panel-solid w-[min(620px,92vw)] overflow-hidden rounded-[22px]" style={{ animation: "pop .28s var(--ease-soft) both", backdropFilter: "none" }}>
        <div className="flex items-center gap-3 border-b border-line px-5">
          <Icon name="search" size={18} className="text-accent" />
          <input
            autoFocus
            className="pixel-font h-14 flex-1 bg-transparent text-[18px] outline-none placeholder:text-faint"
            placeholder="Search notes, or type > for commands"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(results.length - 1, i + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
              else if (e.key === "Enter") run(results[idx]);
              else if (e.key === "Escape") close();
            }}
          />
          <span className="kbd">ESC</span>
        </div>
        <div ref={list} className="scroll max-h-[48vh] p-2">
          {results.length === 0 && <div className="pixel-font px-4 py-8 text-center text-[15px] text-faint">Nothing found. Press Enter to create “{q}”?</div>}
          {results.map((it, i) => (
            <button
              key={it.kind + it.id}
              data-i={i}
              onMouseMove={() => setIdx(i)}
              onClick={() => run(it)}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors"
              style={{ background: i === idx ? "var(--hl)" : "transparent" }}
            >
              <span className="grid h-8 w-8 flex-none place-items-center rounded-lg border border-line bg-panel2" style={{ color: it.kind === "cmd" ? "var(--accent)" : "var(--dim)" }}>
                <Icon name={it.icon} size={16} />
              </span>
              <span className="pixel-font min-w-0 flex-1 truncate text-[16px]">{it.label}</span>
              {it.hint && <span className="max-w-[45%] truncate text-[12px] text-faint">{it.hint}</span>}
              <span className="tiny-font text-[9px] text-faint">{it.kind === "cmd" ? "CMD" : "NOTE"}</span>
            </button>
          ))}
        </div>
        <div className="pixel-font flex items-center gap-4 border-t border-line px-5 py-2.5 text-[12.5px] text-faint">
          <span><span className="kbd">↑↓</span> navigate</span>
          <span><span className="kbd">↵</span> open</span>
          <span><span className="kbd">&gt;</span> commands only</span>
          <span className="flex-1" />
          <span>{results.length} results</span>
        </div>
      </div>
    </div>
  );
}

export function CommandPalette() {
  const open = useStore((s) => s.palette);
  return open ? <Palette /> : null;
}
