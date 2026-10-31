/**
 * 1.3.1 boot decisions that must be made BEFORE the first React render.
 *
 *  • `localOnboarded()` reads the onboarding-done flag synchronously from localStorage (it is
 *    also mirrored server-side in /api/ui-state, delivered with /api/bootstrap).
 *  • `preloaded.Onboarding` holds the already-imported onboarding component so the first paint
 *    on a fresh profile IS the onboarding (no React.lazy suspense gap where the app shows).
 *  • `markOnboarded()` writes the flag to both places.
 *  • `appReady()` tells the desktop shell to show its (initially hidden) window after the first
 *    decided frame.
 *  • `withTimeout()` bounds any await the onboarding makes so Next/Skip can never hang.
 */
import type { ComponentType } from "react";

const PREFS = "nook:prefs";
const FLAG = "nook:onboarded";

export const preloaded: { Onboarding: ComponentType | null } = { Onboarding: null };

export function localOnboarded(): boolean {
  try {
    if (localStorage.getItem(FLAG) === "1") return true;
    const p = JSON.parse(localStorage.getItem(PREFS) || "{}") as { onboarded?: boolean; tourDone?: boolean };
    return p.onboarded ?? !!p.tourDone;
  } catch {
    return false;
  }
}

/** write onboarding-done locally (sync) and to the server (fire-and-forget, bounded) */
export function markOnboarded(done = true) {
  try {
    if (done) localStorage.setItem(FLAG, "1");
    else localStorage.removeItem(FLAG);
    const p = JSON.parse(localStorage.getItem(PREFS) || "{}");
    p.onboarded = done;
    localStorage.setItem(PREFS, JSON.stringify(p));
  } catch {}
  void withTimeout(fetch("/api/ui-state", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ onboarded: done }) }), 4000).catch(() => {});
}

let readySent = false;
/** after the next two frames (= the first decided frame is on screen) show the desktop window */
export function appReady() {
  if (readySent) return;
  readySent = true;
  const send = () => {
    (window as unknown as { __nookReady?: boolean }).__nookReady = true;
    if (!("__TAURI_INTERNALS__" in window)) return;
    void import("@tauri-apps/api/core").then((c) => c.invoke("app_ready")).catch(() => {});
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => requestAnimationFrame(send));
  else setTimeout(send, 16);
  // a hidden/occluded WebView may never run rAF: make sure the window still appears
  setTimeout(send, 400);
}

/** reject after `ms` — use around every await that talks to the network or a model */
export function withTimeout<T>(p: Promise<T>, ms = 4000, label = "request"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)} s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
