/**
 * Local voice-to-text for Nook — 100% on-device via transformers.js.
 *
 * 1.3.1 rework (it was a runtime `import()` from the jsDelivr CDN, fragile behind the Tauri CSP
 * and some networks, and ran on the UI thread):
 *  • transformers.js is a lazily loaded LOCAL chunk inside a Web Worker (asr.worker.ts) — the
 *    initial bundle stays small and the UI never freezes while a model loads or transcribes.
 *  • The ONNX Runtime WASM binary ships with the app (hashed asset); models download once from
 *    huggingface.co into Cache Storage (CSP allows huggingface.co, *.hf.co), then work offline.
 *  • WebGPU when available, WASM otherwise. Default model: Whisper Tiny (q8).
 *  • Audio is decoded and resampled to 16 kHz mono with an OfflineAudioContext.
 *  • Download progress, retry, and clear mic-permission errors.
 */
import { push } from "@/lib/logger";
import { useStore } from "@/lib/store";

export type AsrModelId = "whisper-tiny" | "whisper-base" | "moonshine-tiny" | "moonshine-base" | "whisper-small";

export const DEFAULT_ASR: AsrModelId = "whisper-tiny";
const WHISPER_DTYPE = { encoder_model: "fp32", decoder_model_merged: "q8" };

export const ASR_MODELS: {
  id: AsrModelId;
  repo: string;
  name: string;
  by: string;
  size: string;
  langs: string;
  blurb: string;
  /** WASM dtype: a string, or per-file (whisper: fp32 encoder — a quantised encoder hurts accuracy a lot — + q8 decoder) */
  dtype: string | Record<string, string>;
}[] = [
  { id: "whisper-tiny", repo: "onnx-community/whisper-tiny", name: "Whisper Tiny", by: "OpenAI", size: "~60 MB", langs: "99 languages", blurb: "Default. Small, fast, multilingual.", dtype: WHISPER_DTYPE },
  { id: "whisper-base", repo: "onnx-community/whisper-base", name: "Whisper Base", by: "OpenAI", size: "~130 MB", langs: "99 languages", blurb: "More accurate than Tiny, still quick.", dtype: WHISPER_DTYPE },
  { id: "moonshine-tiny", repo: "onnx-community/moonshine-tiny-ONNX", name: "Moonshine Tiny", by: "Useful Sensors", size: "~55 MB", langs: "English", blurb: "Very fast English for short notes.", dtype: "fp32" },
  { id: "moonshine-base", repo: "onnx-community/moonshine-base-ONNX", name: "Moonshine Base", by: "Useful Sensors", size: "~120 MB", langs: "English", blurb: "More accurate English.", dtype: "fp32" },
  { id: "whisper-small", repo: "onnx-community/whisper-small", name: "Whisper Small", by: "OpenAI", size: "~250 MB", langs: "99 languages", blurb: "Most accurate. Heavier download.", dtype: "q8" },
];

type Pending = { resolve: (v: { text?: string; device?: string; ms?: number }) => void; reject: (e: Error) => void; onProgress?: (p: number) => void };

let worker: Worker | null = null;
let seq = 1;
const pending = new Map<number, Pending>();
let readyModel: AsrModelId | null = null;
let device: string | null = null;

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./asr.worker.ts", import.meta.url), { type: "module", name: "nook-asr" });
  worker.onmessage = (e: MessageEvent<{ type: string; id: number; progress?: number; text?: string; device?: string; ms?: number; error?: string }>) => {
    const m = e.data;
    const p = pending.get(m.id);
    if (!p) return;
    if (m.type === "progress") return p.onProgress?.(m.progress ?? 0);
    pending.delete(m.id);
    if (m.type === "error") p.reject(new Error(m.error ?? "voice model error"));
    else p.resolve({ text: m.text, device: m.device, ms: m.ms });
  };
  worker.onerror = (e) => {
    const err = new Error(e.message || "voice worker crashed");
    push("error", `ASR worker: ${err.message}`, "asr");
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    worker?.terminate();
    worker = null;
    readyModel = null;
  };
  return worker;
}

function call(type: "load" | "transcribe", def: (typeof ASR_MODELS)[number], extra: Record<string, unknown> = {}, onProgress?: (p: number) => void, transfer: Transferable[] = []) {
  const id = seq++;
  return new Promise<{ text?: string; device?: string; ms?: number }>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ type, id, repo: def.repo, dtype: def.dtype, ...extra }, transfer);
  });
}

export function currentModelId(): AsrModelId {
  const m = useStore.getState().voiceModel;
  return (ASR_MODELS.some((x) => x.id === m) ? m : DEFAULT_ASR) as AsrModelId;
}

const setAsr = (patch: Partial<{ status: "idle" | "loading" | "ready" | "error"; progress: number; model: string | null; error: string | null }>) =>
  useStore.setState({ asr: { ...useStore.getState().asr, ...patch } as never });

/** load (download once, then cached) the model in the worker; progress goes to the store */
export async function loadASR(modelId: AsrModelId = currentModelId()): Promise<void> {
  if (readyModel === modelId) return;
  const def = ASR_MODELS.find((m) => m.id === modelId) ?? ASR_MODELS[0];
  setAsr({ status: "loading", progress: 0, model: modelId, error: null });
  try {
    const r = await call("load", def, {}, (p) => setAsr({ status: "loading", progress: p }));
    readyModel = modelId;
    device = r.device ?? null;
    setAsr({ status: "ready", progress: 100, model: modelId, error: null });
    push("info", `Voice model ready: ${def.name} (${device})`, "asr");
  } catch (e) {
    readyModel = null;
    const msg = e instanceof Error ? e.message : String(e);
    setAsr({ status: "error", progress: 0, model: modelId, error: friendlyLoadError(msg) });
    push("error", `Voice model failed: ${msg}`, "asr");
    throw new Error(friendlyLoadError(msg));
  }
}

function friendlyLoadError(msg: string) {
  if (/fetch|network|Failed to load|404|ENOTFOUND|offline/i.test(msg)) return `Couldn't download the voice model — check your internet connection and retry. (${msg.slice(0, 120)})`;
  return msg.slice(0, 220);
}

/** retry after a failed download (drops the worker so a half-initialised runtime is discarded) */
export async function retryASR(): Promise<void> {
  worker?.terminate();
  worker = null;
  readyModel = null;
  await loadASR(currentModelId());
}

export function warmupASR() {
  void loadASR(currentModelId()).catch(() => {});
}

export function asrDevice() {
  return device;
}

/** true when Cache Storage holds transformers.js model files */
export async function isModelCached(): Promise<boolean> {
  try {
    const names = await caches.keys();
    return names.some((n) => n.includes("transformers") || n.includes("huggingface"));
  } catch {
    return false;
  }
}

export async function clearASRCache(): Promise<void> {
  try {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.includes("transformers") || n.includes("huggingface")).map((n) => caches.delete(n)));
  } catch {}
  worker?.terminate();
  worker = null;
  readyModel = null;
  setAsr({ status: "idle", progress: 0, model: null, error: null });
}

/** decode any audio (wav/webm/ogg/mp3…) and resample to 16 kHz mono Float32 — what ASR models expect */
export async function decodeToPCM16k(buf: ArrayBuffer): Promise<Float32Array> {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(buf.slice(0));
  } finally {
    void ctx.close();
  }
  if (decoded.sampleRate === 16000 && decoded.numberOfChannels === 1) return decoded.getChannelData(0).slice();
  const len = Math.max(1, Math.ceil(decoded.duration * 16000));
  const off = new OfflineAudioContext(1, len, 16000);
  const src = off.createBufferSource();
  src.buffer = decoded; // a stereo source into a mono destination is down-mixed (speakers rules)
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  return out.getChannelData(0).slice();
}

/** transcribe 16 kHz mono PCM with the current model (downloads it first if needed) */
export async function transcribePCM(pcm: Float32Array, onStatus?: (s: string) => void): Promise<string> {
  const modelId = currentModelId();
  if (readyModel !== modelId) {
    onStatus?.("loading model…");
    await loadASR(modelId);
  }
  if (pcm.length < 1600) return "";
  onStatus?.("transcribing…");
  const def = ASR_MODELS.find((m) => m.id === modelId)!;
  const copy = pcm.slice();
  const r = await call("transcribe", def, { pcm: copy, whisper: def.id.startsWith("whisper") }, undefined, [copy.buffer]);
  const text = (r.text ?? "").trim();
  push("info", `Voice transcribed ${(pcm.length / 16000).toFixed(1)} s → ${text.length} chars in ${r.ms} ms (${r.device})`, "asr");
  return text;
}

/** transcribe a recorded/loaded audio blob */
export async function transcribeBlob(blob: Blob, onStatus?: (s: string) => void): Promise<string> {
  const pcm = await decodeToPCM16k(await blob.arrayBuffer());
  return transcribePCM(pcm, onStatus);
}

/** human message for getUserMedia failures */
export function micErrorMessage(e: unknown): string {
  const name = (e as { name?: string })?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access is blocked — allow Nook in Windows Settings ▸ Privacy ▸ Microphone, then try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone found — plug one in or pick a default input device.";
  if (name === "NotReadableError" || name === "AbortError") return "The microphone is busy in another app — close it there and try again.";
  return `Couldn't start the microphone (${(e as Error)?.message ?? name ?? "unknown error"}).`;
}

// E2E / debug handle: feed audio through the real transcription path without a mic
if (typeof window !== "undefined" && (import.meta.env.DEV || (window as unknown as { __NOOK_E2E__?: boolean }).__NOOK_E2E__)) {
  (window as unknown as Record<string, unknown>).__nookAsr = { transcribeBlob, transcribePCM, decodeToPCM16k, loadASR, asrDevice };
}
