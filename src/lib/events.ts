/**
 * v1.4: race-free Tauri event subscriptions.
 *
 * `listen()` resolves asynchronously; the old pattern (`offs.push(await listen(...))` inside a
 * fire-and-forget promise) leaked a listener whenever the component unmounted — or the widget
 * window was destroyed — before the promise resolved. Destroyed windows with live listeners are
 * one of the ways WebView2 crashed on widget close. `subscribe()` returns a synchronous
 * disposer that also removes listeners that resolve *after* it was called.
 *
 * Outside Tauri (browser dev / Playwright) it falls back to `window` CustomEvents with the same
 * names, so the UI can be driven from tests: `window.dispatchEvent(new CustomEvent("nook://x", { detail }))`.
 */
import { isTauri } from "@/lib/platform";

export type Handler<T = unknown> = (payload: T) => void;

export function subscribe(map: Record<string, Handler<never>>): () => void {
  let disposed = false;
  const offs: (() => void)[] = [];
  const entries = Object.entries(map) as [string, Handler<unknown>][];
  // DOM fallback (always on: cheap, and lets tests and same-window code emit)
  for (const [name, fn] of entries) {
    const h = (e: Event) => fn((e as CustomEvent).detail);
    window.addEventListener(name, h);
    offs.push(() => window.removeEventListener(name, h));
  }
  if (isTauri) {
    void import("@tauri-apps/api/event")
      .then(async ({ listen }) => {
        for (const [name, fn] of entries) {
          const off = await listen(name, (e) => fn(e.payload));
          if (disposed) off();
          else offs.push(off);
        }
      })
      .catch(() => {});
  }
  return () => {
    if (disposed) return;
    disposed = true;
    offs.splice(0).forEach((f) => {
      try {
        f();
      } catch {
        /* window already gone */
      }
    });
  };
}

/** emit locally (DOM) — used by tests and by the browser-mode fallbacks */
export function emitLocal(name: string, detail?: unknown) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}
