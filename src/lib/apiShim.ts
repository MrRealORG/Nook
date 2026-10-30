/**
 * The thin API layer: every `fetch("/api/...")` the original Next.js components make is
 * intercepted here and routed to the Rust backend —
 *   desktop  → one Tauri command (`api`) that runs the Rust router in-process
 *   browser  → the `nook-dev-api` HTTP server (same Rust router)
 * `/api/ai` is the exception: its orchestration (offline brain + harness loop) runs in the
 * webview (`src/server/aiRoute.ts`) and calls Rust only for tools and the LLM.
 * Components keep calling `fetch` exactly as before.
 */
import { DEV_API, invoke, isTauri } from "@/lib/platform";

type RustResponse = { status: number; contentType: string; body: string; base64: boolean };

let realFetch: typeof fetch | null = null;

function apiPath(input: RequestInfo | URL): string | null {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (raw.startsWith("/api/") || raw === "/api") return raw;
  try {
    const u = new URL(raw, location.href);
    if (u.origin === location.origin && u.pathname.startsWith("/api")) return u.pathname + u.search;
  } catch {
    /* not a URL */
  }
  return null;
}

async function bodyText(input: RequestInfo | URL, init?: RequestInit): Promise<string | undefined> {
  const b = init?.body;
  if (typeof b === "string") return b;
  if (b instanceof Blob) return b.text();
  if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return new TextDecoder().decode(b as ArrayBuffer);
  if (b == null && input instanceof Request && !["GET", "HEAD"].includes(input.method)) return input.text();
  return undefined;
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Call the Rust router directly (used by the shim and by non-fetch callers). */
export async function rustApi(method: string, path: string, body?: unknown): Promise<Response> {
  if (isTauri) {
    const r = await invoke<RustResponse>("api", { method, url: path, body: body === undefined ? null : body });
    const payload = r.base64 ? b64ToBytes(r.body) : r.body;
    return new Response(r.status === 204 || r.status === 202 ? null : payload, { status: r.status, headers: { "content-type": r.contentType } });
  }
  const f = realFetch ?? fetch;
  return f(`${DEV_API}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function installApiShim(): void {
  if (realFetch) return;
  realFetch = window.fetch.bind(window);
  const shim = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = apiPath(input);
    if (!path) return realFetch!(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const text = await bodyText(input, init);
    let body: unknown = undefined;
    if (text !== undefined && text !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        return new Response(JSON.stringify({ error: "body must be JSON" }), { status: 400, headers: { "content-type": "application/json" } });
      }
    }
    const bare = path.split("?")[0];
    if (bare === "/api/ai" && method === "POST") {
      const { handleAiRequest } = await import("@/server/aiRoute");
      const res = await handleAiRequest(body as Parameters<typeof handleAiRequest>[0]);
      return new Response(JSON.stringify(res), { status: 200, headers: { "content-type": "application/json" } });
    }
    try {
      return await rustApi(method, path, body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ error: msg }), { status: 503, headers: { "content-type": "application/json" } });
    }
  };
  window.fetch = shim as typeof fetch;
}

/** Load attachment bytes as an object URL (desktop has no HTTP origin for `/api/attachments`). */
const attCache = new Map<string, Promise<string>>();
export function attachmentUrl(id: string): Promise<string> {
  let p = attCache.get(id);
  if (!p) {
    p = fetch(`/api/attachments/${encodeURIComponent(id)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
      .then((b) => URL.createObjectURL(b));
    p.catch(() => attCache.delete(id));
    attCache.set(id, p);
  }
  return p;
}
