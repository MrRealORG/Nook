/**
 * Local voice-to-text for the Nook notes — runs 100% in the browser via transformers.js
 * (WebGPU when available, WASM fallback). Models download once from the Hugging Face CDN
 * into the browser's Cache Storage, then work offline.
 *
 * Offered models (Settings → Voice):
 *  - Moonshine Tiny / Base  (Useful Sensors — fastest, English, great for short notes)
 *  - Whisper Tiny / Small   (OpenAI Whisper ONNX — multilingual, more accurate)
 */
import { push } from "@/lib/logger";
import { useStore } from "@/lib/store";

const TRANSFORMERS_CDN = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6/+esm";

export type AsrModelId = "moonshine-tiny" | "moonshine-base" | "whisper-tiny" | "whisper-small";

export const ASR_MODELS: {
  id: AsrModelId;
  repo: string;
  name: string;
  by: string;
  size: string;
  langs: string;
  blurb: string;
  dtype?: "q8" | "fp32" | "q4";
}[] = [
  { id: "moonshine-tiny", repo: "onnx-community/moonshine-tiny-ONNX", name: "Moonshine Tiny", by: "Useful Sensors", size: "~55 MB", langs: "English", blurb: "Fastest. Built for short voice notes.", dtype: "fp32" },
  { id: "moonshine-base", repo: "onnx-community/moonshine-base-ONNX", name: "Moonshine Base", by: "Useful Sensors", size: "~120 MB", langs: "English", blurb: "More accurate than Tiny, still quick.", dtype: "fp32" },
  { id: "whisper-tiny", repo: "onnx-community/whisper-tiny", name: "Whisper Tiny", by: "OpenAI", size: "~45 MB", langs: "99 languages", blurb: "Tiny multilingual all-rounder.", dtype: "q8" },
  { id: "whisper-small", repo: "onnx-community/whisper-small", name: "Whisper Small", by: "OpenAI", size: "~250 MB", langs: "99 languages", blurb: "Most accurate. Heavier download.", dtype: "q8" },
];

type AsrPipeline = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text: string }>;

let pipe: AsrPipeline | null = null;
let pipeModel: string | null = null;
let loading = false;

/** aggregate per-file download progress into one 0-100 number */
function makeProgressCB() {
  const files = new Map<string, { loaded: number; total: number }>();
  return (data: { status: string; file?: string; loaded?: number; total?: number; progress?: number }) => {
    if (data.status === "progress" && data.file) {
      files.set(data.file, { loaded: data.loaded ?? 0, total: data.total ?? 0 });
      let loaded = 0;
      let total = 0;
      for (const f of files.values()) {
        loaded += f.loaded;
        total += f.total;
      }
      if (total > 0) useStore.setState({ asr: { ...useStore.getState().asr, status: "loading", progress: Math.min(99, Math.round((loaded / total) * 100)) } });
    }
  };
}

/** load (and cache) the pipeline for a model id; writes progress into the store */
export async function loadASR(modelId: AsrModelId): Promise<AsrPipeline> {
  if (pipe && pipeModel === modelId) return pipe;
  if (loading) throw new Error("A voice model is already loading…");
  loading = true;
  useStore.setState({ asr: { status: "loading", progress: 0, model: modelId, error: null } });
  try {
    const def = ASR_MODELS.find((m) => m.id === modelId) ?? ASR_MODELS[0];
    // transformers.js is optional and never bundled (keeps the installer tiny): it loads from
    // the jsDelivr CDN the first time a voice model is enabled, then the browser caches it.
    const tf = (await import(/* @vite-ignore */ TRANSFORMERS_CDN)) as {
      env: { allowLocalModels: boolean; useBrowserCache: boolean };
      pipeline: (task: string, model: string, opts: Record<string, unknown>) => Promise<unknown>;
    };
    tf.env.allowLocalModels = false;
    tf.env.useBrowserCache = true;
    pipe = (await tf.pipeline("automatic-speech-recognition", def.repo, {
      dtype: def.dtype ?? "q8",
      progress_callback: makeProgressCB(),
    })) as unknown as AsrPipeline;
    pipeModel = modelId;
    useStore.setState({ asr: { status: "ready", progress: 100, model: modelId, error: null } });
    push("info", `Voice model ready: ${def.name}`, "asr");
    return pipe;
  } catch (e) {
    pipe = null;
    pipeModel = null;
    const msg = e instanceof Error ? e.message : String(e);
    useStore.setState({ asr: { status: "error", progress: 0, model: modelId, error: msg.slice(0, 220) } });
    push("error", `Voice model failed: ${msg}`, "asr");
    throw e;
  } finally {
    loading = false;
  }
}

export function warmupASR() {
  void loadASR(currentModelId()).catch(() => {});
}

export function currentModelId(): AsrModelId {
  const m = useStore.getState().voiceModel;
  return (ASR_MODELS.some((x) => x.id === m) ? m : "moonshine-tiny") as AsrModelId;
}

/** true when the Cache Storage holds the chosen model (approximate: any transformers-cache exists) */
export async function isModelCached(): Promise<boolean> {
  try {
    const names = await caches.keys();
    return names.some((n) => n.includes("transformers") || n.includes("huggingface"));
  } catch {
    return false;
  }
}

/** delete downloaded model files from the browser cache */
export async function clearASRCache(): Promise<void> {
  try {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.includes("transformers") || n.includes("huggingface")).map((n) => caches.delete(n)));
    pipe = null;
    pipeModel = null;
    useStore.setState({ asr: { status: "idle", progress: 0, model: null, error: null } });
  } catch {}
}

/** decode any recorded audio blob to 16 kHz mono Float32 (what the models expect) */
async function blobToPCM(blob: Blob): Promise<Float32Array> {
  const buf = await blob.arrayBuffer();
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx({ sampleRate: 16000 });
  try {
    const decoded = await ctx.decodeAudioData(buf);
    // mono downmix
    if (decoded.numberOfChannels === 1) return decoded.getChannelData(0);
    const out = new Float32Array(decoded.length);
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      const d = decoded.getChannelData(ch);
      for (let i = 0; i < d.length; i++) out[i] += d[i] / decoded.numberOfChannels;
    }
    return out;
  } finally {
    void ctx.close();
  }
}

/** transcribe a recorded blob with the current model (downloads it first if needed) */
export async function transcribeBlob(blob: Blob, onStatus?: (s: string) => void): Promise<string> {
  const modelId = currentModelId();
  onStatus?.("loading model…");
  const p = await loadASR(modelId);
  onStatus?.("listening back…");
  const pcm = await blobToPCM(blob);
  if (pcm.length < 1600) return "";
  const def = ASR_MODELS.find((m) => m.id === modelId)!;
  const opts = def.id.startsWith("whisper") ? { chunk_length_s: 30, stride_length_s: 5 } : {};
  const out = await p(pcm, opts);
  const text = (out?.text ?? "").trim();
  push("info", `Voice transcribed ${Math.round(pcm.length / 16000)}s → ${text.length} chars`, "asr");
  return text;
}
