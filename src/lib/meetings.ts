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

import { IDLE, isLive, localSegments, type MeetingConfig, type MeetingLive, type Meeting, type Pending, type Summary } from "@/lib/meetingsCore";

export * from "@/lib/meetingsCore";

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
