/**
 * Nook client logger — a tiny ring-buffer logger that:
 *  - captures console.error / console.warn + uncaught errors + unhandled rejections
 *  - records app events (logEvent) with levels
 *  - persists the last 150 entries to localStorage so a crash after reload is still reportable
 *  - lets subscribers (the Logs & Bugs panel) re-render live
 *  - exports text/JSON for bug reports
 */

export type LogLevel = "error" | "warn" | "info" | "debug";
export type LogEntry = { id: number; t: number; level: LogLevel; msg: string; where?: string };

const MAX = 150;
const STORE_KEY = "nook:logs";

let seq = 1;
let entries: LogEntry[] = [];
const subs = new Set<() => void>();
let installed = false;

/** how many error-level entries arrived this session (drives the status-bar badge) */
export let errorCount = 0;

function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(entries.slice(-MAX)));
  } catch {}
}

function emit() {
  for (const fn of subs) {
    try {
      fn();
    } catch {}
  }
}

export function push(level: LogLevel, msg: string, where?: string) {
  const e: LogEntry = { id: seq++, t: Date.now(), level, msg: String(msg).slice(0, 500), where };
  entries = [...entries.slice(-(MAX - 1)), e];
  if (level === "error") errorCount++;
  persist();
  emit();
  return e;
}

export function getLogs(): LogEntry[] {
  return entries;
}

export function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

export function clearLogs() {
  entries = [];
  errorCount = 0;
  persist();
  emit();
}

/** app-level event (use for interesting flows: voice transcribed, bug filed, harness ran…) */
export function logEvent(msg: string, level: LogLevel = "info", where?: string) {
  return push(level, msg, where);
}

/** last N entries as readable text (for the bug report payload) */
export function logsAsText(n = 40): string {
  return entries
    .slice(-n)
    .map((e) => `[${new Date(e.t).toLocaleTimeString()}] ${e.level.toUpperCase()}${e.where ? ` (${e.where})` : ""}: ${e.msg}`)
    .join("\n");
}

/** install global handlers once — safe to call from any client entry point */
export function installLogger() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as LogEntry[];
    if (Array.isArray(saved)) {
      entries = saved.slice(-MAX).map((e) => ({ ...e, id: seq++ }));
      errorCount = entries.filter((e) => e.level === "error").length;
    }
  } catch {}

  const origError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    push("error", args.map((a) => (typeof a === "string" ? a : a instanceof Error ? `${a.message}` : safeJson(a))).join(" "));
    origError(...args);
  };
  const origWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    push("warn", args.map((a) => (typeof a === "string" ? a : safeJson(a))).join(" "));
    origWarn(...args);
  };

  window.addEventListener("error", (ev) => {
    const msg = ev.error instanceof Error ? `${ev.error.message}\n${String(ev.error.stack ?? "").split("\n")[1] ?? ""}` : ev.message;
    push("error", msg, ev.filename?.split("/").pop());
  });
  window.addEventListener("unhandledrejection", (ev) => {
    const r = (ev as PromiseRejectionEvent).reason;
    push("error", r instanceof Error ? r.message : String(r).slice(0, 400), "promise");
  });
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)?.slice(0, 220) ?? String(v);
  } catch {
    return String(v);
  }
}
