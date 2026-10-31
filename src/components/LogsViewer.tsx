/**
 * 1.3.1 Settings ▸ Logs — live tail of the app log (UI + Rust), level filter, search, copy,
 * clear, "Open log folder" and the verbose-logging toggle (off by default).
 *
 * The UI ring is pushed live; Rust lines are pulled from the shell (`logs_since`) once a second
 * ONLY while this viewer is mounted and the window is visible — zero work otherwise.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Icon } from "@/components/Icon";
import { clearLogs, getLogs, isVerbose, setVerbose, subscribe, type LogEntry } from "@/lib/logger";
import { everyActive } from "@/lib/power";
import { useStore } from "@/lib/store";

type Row = { key: string; t: number; level: string; source: string; msg: string };
const LEVELS = ["all", "info", "warn", "error"] as const;
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const EMPTY: LogEntry[] = [];

export function LogsViewer() {
  const ui = useSyncExternalStore(subscribe, getLogs, () => EMPTY);
  const [rust, setRust] = useState<Row[]>([]);
  const [level, setLevel] = useState<(typeof LEVELS)[number]>("all");
  const [q, setQ] = useState("");
  const [verbose, setV] = useState(isVerbose());
  const [dir, setDir] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri) return;
    let since = 0;
    let alive = true;
    const pull = async () => {
      try {
        const c = await import("@tauri-apps/api/core");
        const lines = await c.invoke<{ id: number; t: number; level: string; source: string; msg: string }[]>("logs_since", { since });
        if (!alive || !lines.length) return;
        since = lines[lines.length - 1].id;
        // UI lines are mirrored into the Rust ring too: keep only the Rust-side ones here
        const mine = lines.filter((l) => !l.source.startsWith("ui"));
        if (mine.length) setRust((r) => [...r, ...mine.map((l) => ({ key: `r${l.id}`, t: l.t, level: l.level, source: l.source, msg: l.msg }))].slice(-600));
      } catch {}
    };
    void pull();
    void import("@tauri-apps/api/core").then((c) => c.invoke<{ logDir?: string }>("system_info")).then((s) => alive && setDir(s.logDir ?? null)).catch(() => {});
    const stop = everyActive(() => void pull(), 1000);
    return () => {
      alive = false;
      stop();
    };
  }, []);

  const rows = useMemo(() => {
    const all: Row[] = [...ui.map((e) => ({ key: `u${e.id}`, t: e.t, level: e.level, source: e.where ? `ui:${e.where}` : "ui", msg: e.msg })), ...rust];
    const ql = q.trim().toLowerCase();
    return all
      .filter((r) => (level === "all" || r.level === level) && (!ql || r.msg.toLowerCase().includes(ql) || r.source.toLowerCase().includes(ql)))
      .sort((a, b) => a.t - b.t)
      .slice(-400);
  }, [ui, rust, level, q]);

  const text = () => rows.map((r) => `${new Date(r.t).toISOString()} ${r.level.toUpperCase().padEnd(5)} [${r.source}] ${r.msg}`).join("\n");
  const copy = async () => {
    await navigator.clipboard?.writeText(text()).catch(() => {});
    useStore.getState().toast(`Copied ${rows.length} log lines`, "copy");
  };
  const clear = async () => {
    clearLogs();
    setRust([]);
    if (isTauri) await import("@tauri-apps/api/core").then((c) => c.invoke("logs_clear")).catch(() => {});
  };
  const openFolder = async () => {
    if (!isTauri) return useStore.getState().toast("The log folder is available in the desktop app (%APPDATA%\\Nook\\logs)", "folder");
    try {
      const c = await import("@tauri-apps/api/core");
      await c.invoke("open_log_folder");
    } catch (e) {
      useStore.getState().toast(`Couldn't open the log folder: ${String(e)}`, "alert");
    }
  };

  return (
    <div className="paper p-5" data-testid="logs-viewer">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="label">App logs</div>
        <span className="text-[11px] text-faint">{dir ? `saved to ${dir} (5 × 1 MB, rotated)` : "UI + desktop logs, live"}</span>
        <span className="flex-1" />
        <label className="flex items-center gap-1.5 text-[12px]" title="Also record debug-level detail (off by default)">
          <input type="checkbox" checked={verbose} onChange={(e) => { setVerbose(e.target.checked); setV(e.target.checked); }} data-testid="logs-verbose" /> Verbose
        </label>
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {LEVELS.map((l) => (
          <button key={l} className="chip" data-on={level === l} onClick={() => setLevel(l)} data-testid={`logs-level-${l}`}>{l}</button>
        ))}
        <input className="input !h-8 min-w-[160px] flex-1" placeholder="Search logs…" value={q} onChange={(e) => setQ(e.target.value)} data-testid="logs-search" />
        <button className="btn btn-sm" onClick={() => void copy()} data-testid="logs-copy"><Icon name="copy" size={12} /> Copy</button>
        <button className="btn btn-sm" onClick={() => void clear()} data-testid="logs-clear"><Icon name="trash" size={12} /> Clear</button>
        <button className="btn btn-sm" onClick={() => void openFolder()} data-testid="logs-folder"><Icon name="folder" size={12} /> Open log folder</button>
      </div>
      <div className="max-h-[420px] overflow-auto rounded-lg border border-line bg-[color:var(--hover)] p-2 font-mono text-[11.5px] leading-[1.45]" data-testid="logs-list">
        {rows.length === 0 && <div className="p-3 text-center text-faint">No log lines{level !== "all" || q ? " match" : " yet"}.</div>}
        {rows.map((r) => (
          <div key={r.key} className="flex gap-2 whitespace-pre-wrap break-words" data-level={r.level} data-testid="log-row">
            <span className="flex-none text-faint">{new Date(r.t).toLocaleTimeString()}</span>
            <span className="w-[42px] flex-none font-bold" style={{ color: r.level === "error" ? "#e0684f" : r.level === "warn" ? "#e0a84f" : r.level === "info" ? "var(--accent)" : "var(--faint)" }}>{r.level.toUpperCase()}</span>
            <span className="flex-none text-faint">[{r.source}]</span>
            <span className="min-w-0">{r.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
