/**
 * Desktop widget — a second frameless, transparent window pinned to the desktop.
 * Quick-capture note, today's tasks, the pet, and a mini AI ask. Talks to the same Rust
 * vault as the main window and tells it when something changed.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { PetView } from "@/components/PetView";
import { MicButton } from "@/components/MicButton";
import { invoke, isTauri } from "@/lib/platform";
import { useStore, type Task } from "@/lib/store";
import { THEME_IDS, type ThemeId } from "@/lib/themes";
import type { AiResult, Pet } from "@/lib/types";
import { uid } from "@/lib/util";

type Mood = "idle" | "happy" | "think" | "sleep" | "sad";

function readTheme(): ThemeId {
  try {
    const t = JSON.parse(localStorage.getItem("nook:prefs") ?? "{}").theme as ThemeId;
    return THEME_IDS.includes(t) ? t : "graphite";
  } catch {
    return "graphite";
  }
}

const notifyMain = () => {
  if (isTauri) void invoke("broadcast", { event: "data-changed", payload: { source: "widget" } }).catch(() => {});
};

export function Widget() {
  const [pet, setPet] = useState<Pet | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [capture, setCapture] = useState("");
  const [asTask, setAsTask] = useState(false);
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [mood, setMood] = useState<Mood>("idle");
  const [flash, setFlash] = useState("");
  const capRef = useRef<HTMLTextAreaElement>(null);
  const [tl, setTl] = useState<{ activeSecs: number; topApp: string | null; paused: boolean; current: { app: string; afk: boolean; running: boolean } } | null>(null);

  const loadTl = useCallback(async () => {
    try {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      setTl(await (await fetch(`/api/timelens/summary?from=${d.getTime()}&to=${Date.now() + 1}`)).json());
    } catch {
      /* tracker not ready */
    }
  }, []);
  const toggleTl = async () => {
    const r = await (await fetch("/api/timelens/pause", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paused: !tl?.paused }) })).json();
    ping(r.paused ? "sleep" : "happy", r.paused ? "Timelens paused" : "Timelens on");
    void loadTl();
    notifyMain();
  };
  /** Clipboard quick-capture: paste whatever is on the clipboard as a note. */
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

  const load = useCallback(async () => {
    try {
      const [p, t] = await Promise.all([fetch("/api/pet").then((r) => r.json()), fetch("/api/tasks").then((r) => r.json())]);
      if (p) {
        setPet(p as Pet);
        useStore.setState({ pet: p as Pet });
      }
      setTasks(Array.isArray(t) ? (t as Task[]) : []);
    } catch {
      /* vault busy — next tick */
    }
  }, []);

  useEffect(() => {
    const theme = readTheme();
    document.documentElement.dataset.theme = theme;
    useStore.setState({ theme });
    void load();
    void loadTl();
    const iv = setInterval(() => {
      void load();
      void loadTl();
    }, 60_000);
    const offs: (() => void)[] = [];
    if (isTauri) {
      void import("@tauri-apps/api/event").then(async ({ listen }) => {
        offs.push(await listen<{ source?: string }>("nook://data-changed", (e) => e.payload?.source !== "widget" && void load()));
        offs.push(await listen("nook://capture", () => capRef.current?.focus()));
      });
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key === "nook:prefs") {
        const t = readTheme();
        document.documentElement.dataset.theme = t;
        useStore.setState({ theme: t });
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      clearInterval(iv);
      offs.forEach((f) => f());
      window.removeEventListener("storage", onStorage);
    };
  }, [load, loadTl]);

  const ping = (m: Mood, text: string) => {
    setMood(m);
    setFlash(text);
    setTimeout(() => setMood("idle"), 1800);
    setTimeout(() => setFlash(""), 2200);
  };

  const save = async () => {
    const text = capture.trim();
    if (!text) return;
    if (asTask) {
      await fetch("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: uid(), title: text.split("\n")[0].slice(0, 200), list: "today" }) });
      ping("happy", "Task added ✓");
    } else {
      const first = text.split("\n")[0].replace(/^#+\s*/, "").slice(0, 80) || "Quick note";
      const body = text.startsWith("#") ? text : `# ${first}\n\n${text.split("\n").slice(1).join("\n")}`.trimEnd() + "\n";
      await fetch("/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: uid(), title: first, content: body }) });
      ping("happy", "Note saved ✓");
    }
    setCapture("");
    notifyMain();
    void load();
  };

  const toggle = async (t: Task) => {
    setTasks((ts) => ts.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x)));
    await fetch(`/api/tasks/${t.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ done: !t.done }) });
    if (!t.done) ping("happy", "Nice!");
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
        void load();
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

  const today = tasks.filter((t) => t.list === "today" && (!t.done || (t.completedAt ?? 0) > Date.now() - 6 * 3600_000)).slice(0, 8);
  const openMain = (route?: string) => (isTauri ? void invoke("focus_main", { route: route ?? null }) : undefined);

  return (
    <div className="widget-shell" data-testid="widget">
      <div className="widget-head" data-tauri-drag-region>
        <img src="/art/logo.webp" alt="" width={18} height={18} className="pixelated rounded-[5px]" data-tauri-drag-region />
        <span className="pixel-font flex-1 text-[14px]" data-tauri-drag-region>Nook</span>
        <button className="icon-btn" title="Open Nook" onClick={() => openMain()} style={{ width: 26, height: 26 }}>↗</button>
        <button className="icon-btn" title="Hide widget" onClick={() => isTauri && void invoke("widget_toggle", { show: false })} style={{ width: 26, height: 26 }}>×</button>
      </div>

      {pet && (
        <div className="flex items-center gap-2">
          <PetView species={pet.species} tint={pet.look} hat={pet.hat} mood={mood} scale={2} />
          <div className="min-w-0 flex-1">
            <div className="pixel-font truncate text-[13px]">{pet.name}</div>
            <div className="text-[11px] text-faint">{flash || `🪙 ${pet.coins} · food ${Math.round(pet.food)} · joy ${Math.round(pet.joy)}`}</div>
          </div>
        </div>
      )}

      <div className="widget-card">
        <textarea
          ref={capRef}
          className="input !h-[64px] w-full resize-none !text-[12.5px]"
          placeholder={asTask ? "New task for today…" : "Quick note… (Ctrl+Enter to save)"}
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
        <div className="mt-1.5 flex items-center gap-2">
          <label className="flex items-center gap-1 text-[11px] text-dim">
            <input type="checkbox" checked={asTask} onChange={(e) => setAsTask(e.target.checked)} /> as task
          </label>
          <button className="icon-btn" style={{ width: 24, height: 24 }} title="Paste from clipboard" aria-label="Paste from clipboard" onClick={() => void fromClipboard()}>📋</button>
          <MicButton compact onText={(t) => setCapture((c) => (c ? `${c} ${t}` : t))} />
          <button className="btn btn-sm ml-auto" onClick={() => void save()} disabled={!capture.trim()}>Save</button>
        </div>
      </div>

      {tl && (
        <div className="widget-card flex items-center gap-2 !py-1.5 text-[11.5px]" data-testid="widget-timelens">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: tl.paused ? "var(--faint)" : tl.current.running && !tl.current.afk ? "#7fc48f" : "#d9c98a" }} />
          <span className="min-w-0 flex-1 truncate">
            <b className="pixel-font">{Math.floor(tl.activeSecs / 3600)}h {Math.round((tl.activeSecs % 3600) / 60)}m</b>
            <span className="text-faint"> · {tl.paused ? "paused" : tl.current.running ? (tl.current.afk ? "away" : tl.current.app) : (tl.topApp ?? "nothing yet")}</span>
          </span>
          <button className="btn btn-sm !h-6 !px-2 !text-[11px]" onClick={() => void toggleTl()} aria-label={tl.paused ? "Resume Timelens" : "Pause Timelens"}>{tl.paused ? "▶" : "⏸"}</button>
        </div>
      )}

      <div className="widget-card min-h-0 flex-1 overflow-auto">
        <div className="label mb-1 flex items-center justify-between">
          <span>Today</span>
          <button className="text-[10px] text-faint hover:text-ink" onClick={() => openMain("tasks")}>all tasks →</button>
        </div>
        {today.length === 0 && <div className="py-2 text-[12px] text-faint">Nothing due today. 🌿</div>}
        {today.map((t) => (
          <label key={t.id} className="widget-task" data-done={t.done}>
            <input type="checkbox" checked={t.done} onChange={() => void toggle(t)} />
            <span className="min-w-0 flex-1 break-words">{t.title}</span>
            {t.priority === 2 && <span className="text-[10px] text-accent">!!</span>}
          </label>
        ))}
      </div>

      <div className="widget-card">
        <div className="flex gap-1.5">
          <input
            className="input !h-[30px] flex-1 !text-[12.5px]"
            placeholder={`Ask ${pet?.name ?? "your pet"}…`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void askAi()}
            aria-label="Ask the AI"
          />
          <button className="btn btn-sm" onClick={() => void askAi()} disabled={busy || !q.trim()}>{busy ? "…" : "Ask"}</button>
        </div>
        {answer && <div className="mt-1.5 max-h-[110px] overflow-auto whitespace-pre-wrap text-[12px] text-dim selectable" data-testid="widget-answer">{answer}</div>}
      </div>
    </div>
  );
}
