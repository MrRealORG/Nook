/**
 * v1.4 Meetings — client for the Rust recorder (`/api/meetings/*`) plus the small pure helpers the
 * view, the widget pill and the tests share.
 *
 * Flow: start → (pause / resume) → stop → transcribe → summarize → note.
 *  - Recording is native (WASAPI mic + loopback, two aligned 16 kHz tracks in 30 s chunks).
 *  - Transcription uses cloud STT when a Groq / OpenAI-compatible / Gemini key is set; otherwise
 *    the server answers `{ engine: "local", pending }` and we run the on-device Whisper worker
 *    here, chunk by chunk, posting the segments back.
 *  - The summary uses the configured AI model (Ollama as a local fallback) and writes a note.
 */
import { subscribe } from "@/lib/events";

export type MeetingState = "idle" | "starting" | "recording" | "paused" | "stopping";

export type MeetingLive = {
  id: string | null;
  state: MeetingState;
  startedAt: number;
  elapsedMs: number;
  levelYou: number;
  levelThem: number;
  devices: Record<string, string>;
  warnings: string[];
  error: string | null;
};

export type Line = { speaker: "You" | "Them" | string; startMs: number; endMs: number; text: string };
export type ActionItem = { task: string; owner?: string | null; due?: string | null };
export type Summary = { title?: string | null; summary: string; keyPoints: string[]; decisions: string[]; actionItems: ActionItem[]; openQuestions: string[] };

export type MeetingStatus = "recording" | "recorded" | "transcribing" | "transcribed" | "summarizing" | "summarized" | "error";

export type Meeting = {
  id: string;
  title: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  status: MeetingStatus | string;
  devices: { devices?: Record<string, string>; warnings?: string[] } | null;
  chunks: { track: string; n: number; rms: number; silent: boolean }[] | null;
  transcript: Line[] | null;
  summary: Summary | null;
  noteId: string | null;
  error: string | null;
  engine: string | null;
};

export type MeetingConfig = { stt: "auto" | "local" | "groq" | "openai" | "gemini"; sttModel?: string | null; language: string; autoSummarize: boolean };
export type Pending = { track: "you" | "them"; n: number; url: string };

export const IDLE: MeetingLive = { id: null, state: "idle", startedAt: 0, elapsedMs: 0, levelYou: 0, levelThem: 0, devices: {}, warnings: [], error: null };
export const CHUNK_MS = 30_000;
/** the record / stop hotkey (registered by the desktop shell) */
export const MEETING_HOTKEY = "Ctrl+Alt+M";

// ------------------------------------------------------------------ pure helpers (unit-tested)

/** 0:07 · 12:34 · 1:02:05 */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export const isLive = (s: MeetingLive | null | undefined) => !!s && (s.state === "recording" || s.state === "paused" || s.state === "starting" || s.state === "stopping");

/** a 0..1 level → how many of `bars` meter bars are lit (a small floor so speech is visible) */
export function levelBars(level: number, bars = 12): number {
  if (!Number.isFinite(level) || level <= 0.01) return 0;
  return Math.max(1, Math.min(bars, Math.round(Math.sqrt(Math.min(1, level)) * bars)));
}

export function statusLabel(m: Pick<Meeting, "status" | "error">): { text: string; tone: "ok" | "busy" | "warn" | "err" | "muted" } {
  switch (m.status) {
    case "recording": return { text: "Recording", tone: "busy" };
    case "recorded": return { text: m.error ? "Needs transcript" : "Recorded", tone: m.error ? "warn" : "muted" };
    case "transcribing": return { text: "Transcribing…", tone: "busy" };
    case "transcribed": return { text: m.error ? "Summary failed" : "Transcribed", tone: m.error ? "warn" : "ok" };
    case "summarizing": return { text: "Summarising…", tone: "busy" };
    case "summarized": return { text: "Summarised", tone: "ok" };
    case "error": return { text: "Error", tone: "err" };
    default: return { text: String(m.status), tone: "muted" };
  }
}

/** human explanation for a start failure (no mic, blocked permission, no output device, non-Windows) */
export function explainStartError(raw: string): { title: string; hint: string } {
  const e = raw.toLowerCase();
  if (e.includes("wasapi") && e.includes("windows app")) return { title: "Recording needs the Windows app", hint: "Meeting recording captures Windows audio (your mic + what you hear). Open Nook on Windows to record; you can still read past meetings here." };
  if (e.includes("access") || e.includes("denied") || e.includes("0x80070005") || e.includes("permission"))
    return { title: "Microphone access is blocked", hint: "Turn on Settings → Privacy & security → Microphone → “Let desktop apps access your microphone”, then try again." };
  if (e.includes("no audio device") || e.includes("not found") || e.includes("0x80070490") || e.includes("element not found"))
    return { title: "No audio device found", hint: "Plug in or enable a microphone / speakers (Sound settings → Input and Output), then try again." };
  if (e.includes("already being recorded")) return { title: "Already recording", hint: "Stop the current meeting first." };
  if (e.includes("did not respond")) return { title: "Audio devices didn't respond", hint: "Another app may hold the device in exclusive mode. Close it or pick another default device, then retry." };
  return { title: "Couldn't start recording", hint: raw };
}

/** "Microphone: …" warnings → short chips for the UI */
export function warningChips(warnings: string[]): string[] {
  return warnings.map((w) => {
    const l = w.toLowerCase();
    if (l.startsWith("microphone") && (l.includes("denied") || l.includes("access"))) return "Mic blocked — only the other side is recorded";
    if (l.startsWith("microphone")) return "No mic — only the other side is recorded";
    if (l.startsWith("system audio")) return "No speaker output — only your mic is recorded";
    return w;
  });
}

/** `[mm:ss] You: …` — what "Copy transcript" puts on the clipboard */
export function transcriptPlain(lines: Line[]): string {
  return lines.map((l) => `[${fmtElapsed(l.startMs)}] ${l.speaker}: ${l.text}`).join("\n");
}

/** local Whisper output for one 30 s chunk → segments (relative to the chunk) */
export function localSegments(text: string, chunkMs = CHUNK_MS) {
  const t = text.replace(/\s+/g, " ").trim();
  return t ? [{ startMs: 0, endMs: chunkMs, text: t }] : [];
}

// ------------------------------------------------------------------ api

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error || `HTTP ${r.status}`);
  return j as T;
}

export const meetingsApi = {
  live: () => call<MeetingLive>("GET", "/api/meetings/live"),
  list: () => call<Meeting[]>("GET", "/api/meetings"),
  get: (id: string) => call<Meeting>("GET", `/api/meetings/${id}`),
  start: (title?: string) => call<MeetingLive>("POST", "/api/meetings/start", title ? { title } : {}),
  stop: () => call<Meeting>("POST", "/api/meetings/stop", {}),
  pause: (paused: boolean) => call<MeetingLive>("POST", "/api/meetings/pause", { paused }),
  rename: (id: string, title: string) => call<Meeting>("PATCH", `/api/meetings/${id}`, { title }),
  remove: (id: string) => call<{ ok: boolean }>("DELETE", `/api/meetings/${id}`),
  transcribe: (id: string) => call<{ ok: boolean; engine: string; pending: Pending[]; done?: number; lines?: number; error?: string | null }>("POST", `/api/meetings/${id}/transcribe`, {}),
  summarize: (id: string) => call<{ ok: boolean; noteId?: string; summary?: Summary; error?: string }>("POST", `/api/meetings/${id}/summarize`, {}),
  segments: (id: string, track: string, n: number, segments: { startMs: number; endMs: number; text: string }[], engine: string) =>
    call<{ ok: boolean; pending: number }>("POST", `/api/meetings/${id}/segments`, { track, n, segments, engine }),
  config: () => call<MeetingConfig>("GET", "/api/meetings/config"),
  setConfig: (patch: Partial<MeetingConfig>) => call<MeetingConfig>("PATCH", "/api/meetings/config", patch),
};

/** Transcribe pending chunks on-device with the Whisper worker (no STT key configured). */
export async function transcribeLocally(id: string, pending: Pending[], onProgress?: (done: number, total: number, status?: string) => void): Promise<void> {
  const { decodeToPCM16k, transcribePCM, currentModelId } = await import("@/lib/asr");
  let done = 0;
  onProgress?.(0, pending.length);
  for (const p of pending) {
    const buf = await (await fetch(p.url)).arrayBuffer();
    const pcm = await decodeToPCM16k(buf);
    const text = await transcribePCM(pcm, (s) => onProgress?.(done, pending.length, s));
    await meetingsApi.segments(id, p.track, p.n, localSegments(text), `local-${currentModelId()}`);
    done++;
    onProgress?.(done, pending.length);
  }
}

/**
 * After stop: transcribe (cloud, or local fallback) and — when enabled — summarise into a note.
 * Each step reports progress; errors are returned, never thrown, so the UI can show them inline.
 */
export async function processMeeting(id: string, opts: { summarize: boolean; onStep?: (s: string) => void }): Promise<{ noteId?: string; error?: string }> {
  try {
    opts.onStep?.("Transcribing…");
    const t = await meetingsApi.transcribe(id);
    if (t.engine === "local" && t.pending.length) {
      await transcribeLocally(id, t.pending, (d, n, s) => opts.onStep?.(s && s !== "ready" ? `On-device model: ${s}` : `Transcribing on this PC… ${d}/${n}`));
    } else if (!t.ok) {
      return { error: t.error || "Transcription failed" };
    }
    if (!opts.summarize) return {};
    opts.onStep?.("Summarising…");
    const s = await meetingsApi.summarize(id);
    if (!s.ok) return { error: s.error || "Summary failed" };
    return { noteId: s.noteId };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Live recorder state: the shell pushes `nook://meeting-state` on every transition; while a
 * recording is running we also poll `/api/meetings/live` (4×/s, visible only) for the timer and
 * the level meters. Returns a disposer.
 */
export function watchLive(onState: (s: MeetingLive) => void, fastMs = 250): () => void {
  let cur: MeetingLive = IDLE;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dead = false;
  const push = (s: MeetingLive | null | undefined) => {
    if (!s || dead) return;
    cur = { ...IDLE, ...s };
    onState(cur);
    schedule();
  };
  const tick = async () => {
    timer = null;
    if (dead) return;
    if (document.visibilityState === "hidden") return schedule();
    try {
      push(await meetingsApi.live());
    } catch {
      schedule();
    }
  };
  const schedule = () => {
    if (dead || timer) return;
    timer = setTimeout(() => void tick(), isLive(cur) ? fastMs : 5_000);
  };
  const off = subscribe({ "nook://meeting-state": (s: MeetingLive) => push(s) });
  void tick();
  return () => {
    dead = true;
    if (timer) clearTimeout(timer);
    off();
  };
}
