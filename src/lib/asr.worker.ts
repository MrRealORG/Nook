/**
 * 1.3.1 — speech-to-text worker. transformers.js (bundled as a lazily loaded local chunk, not a
 * CDN import) runs here so the UI thread never freezes while a model loads or transcribes.
 * WebGPU when the adapter is available, WASM otherwise (and as the fallback if WebGPU fails).
 *
 * in:  { type: "load", id, repo, dtype }
 *      { type: "transcribe", id, repo, dtype, pcm: Float32Array, whisper: boolean }
 * out: { type: "progress", progress } | { type: "ready", device } | { type: "result", text, ms }
 *      | { type: "error", error }
 */
/// <reference lib="webworker" />

// the ONNX Runtime wasm ships inside the app (hashed asset) — never fetched from a CDN
// (relative path: the file is not in onnxruntime-web's exports map)
import ortWasmUrl from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url";

type Msg = { type: "load" | "transcribe"; id: number; repo: string; dtype: string | Record<string, string>; pcm?: Float32Array; whisper?: boolean };
type Pipe = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;

let pipe: Pipe | null = null;
let pipeKey = "";
let device = "wasm";
let loading: Promise<Pipe> | null = null;

const post = (m: Record<string, unknown>) => (self as unknown as Worker).postMessage(m);

async function hasWebGPU(): Promise<boolean> {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
    if (!gpu) return false;
    return !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

async function load(m: Msg, id: number): Promise<Pipe> {
  const key = `${m.repo}|${JSON.stringify(m.dtype)}`;
  if (pipe && pipeKey === key) return pipe;
  if (loading) return loading;
  loading = (async () => {
    const tf = await import("@huggingface/transformers");
    tf.env.allowLocalModels = false;
    tf.env.useBrowserCache = true;
    const onnx = tf.env.backends.onnx as { wasm?: { wasmPaths?: string | { wasm?: string; mjs?: string }; numThreads?: number; proxy?: boolean } };
    if (onnx.wasm) {
      onnx.wasm.wasmPaths = { wasm: new URL(ortWasmUrl, self.location.href).href };
      // threads need cross-origin isolation (SharedArrayBuffer), which a Tauri page doesn't have
      if (!(self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated) onnx.wasm.numThreads = 1;
    }
    const files = new Map<string, { loaded: number; total: number }>();
    let lastPct = -1;
    const progress_callback = (d: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (d.status !== "progress" || !d.file) return;
      files.set(d.file, { loaded: d.loaded ?? 0, total: d.total ?? 0 });
      let l = 0, t = 0;
      for (const f of files.values()) {
        l += f.loaded;
        t += f.total;
      }
      const pct = t ? Math.min(99, Math.floor((l / t) * 100)) : 0;
      if (pct !== lastPct) {
        lastPct = pct;
        post({ type: "progress", id, progress: pct });
      }
    };
    const tryDevice = async (dev: "webgpu" | "wasm") => {
      const dtype = dev === "webgpu" ? { encoder_model: "fp32", decoder_model_merged: "q4" } : m.dtype;
      return (await tf.pipeline("automatic-speech-recognition", m.repo, { device: dev, dtype: dtype as never, progress_callback })) as unknown as Pipe;
    };
    let p: Pipe;
    if (await hasWebGPU()) {
      try {
        p = await tryDevice("webgpu");
        device = "webgpu";
      } catch {
        p = await tryDevice("wasm");
        device = "wasm";
      }
    } else {
      p = await tryDevice("wasm");
      device = "wasm";
    }
    pipe = p;
    pipeKey = key;
    return p;
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

self.onmessage = async (e: MessageEvent<Msg>) => {
  const m = e.data;
  try {
    const p = await load(m, m.id);
    if (m.type === "load") return post({ type: "ready", id: m.id, device });
    const pcm = m.pcm!;
    const t0 = performance.now();
    const opts: Record<string, unknown> = m.whisper ? { chunk_length_s: 30, stride_length_s: 5, task: "transcribe" } : {};
    const out = await p(pcm, opts);
    const text = (Array.isArray(out) ? out.map((o) => o.text).join(" ") : out.text).trim();
    post({ type: "result", id: m.id, text, ms: Math.round(performance.now() - t0), device });
  } catch (err) {
    post({ type: "error", id: m.id, error: err instanceof Error ? err.message : String(err) });
  }
};
