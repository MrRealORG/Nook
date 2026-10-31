/**
 * 1.3.1 auto-updater (Tauri v2 updater plugin; signed releases on GitHub:
 * https://github.com/MrRealORG/Nook/releases/latest/download/latest.json).
 *
 *  • Automatic check: once, 30 s after the first paint, at most every 6 h, never while the
 *    onboarding is open, and only if "Check for updates automatically" is on (default on).
 *    One timer — no polling, zero idle CPU.
 *  • Offline / no release yet / no latest.json → logged, silent.
 *  • "Nook X.Y.Z is available" card: release notes, Update now / Later / Skip this version,
 *    download progress, then the app relaunches.
 *  • E2E: `window.__nookMockUpdate` replaces the native check/install.
 */
import { create } from "zustand";
import { push } from "@/lib/logger";

export type UpdateInfo = { configured: boolean; available?: boolean; version?: string; notes?: string; date?: string; current?: string; quietError?: string; error?: string };
type Phase = "idle" | "checking" | "available" | "downloading" | "installed" | "error";
type UState = { phase: Phase; info: UpdateInfo | null; progress: number; error: string | null; cardOpen: boolean };

export const useUpdater = create<UState>(() => ({ phase: "idle", info: null, progress: 0, error: null, cardOpen: false }));

const AUTO_KEY = "nook:autoUpdate";
const LAST_KEY = "nook:lastUpdateCheck";
const SKIP_KEY = "nook:skipVersion";
export const CHECK_EVERY_MS = 6 * 3600_000;
export const FIRST_CHECK_DELAY_MS = 30_000;

type Mock = { check: () => Promise<UpdateInfo>; install?: (onProgress: (d: number, t: number) => void) => Promise<void> };
const mock = () => (window as unknown as { __nookMockUpdate?: Mock }).__nookMockUpdate;
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function autoUpdatesOn(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) !== "0";
  } catch {
    return true;
  }
}
export function setAutoUpdates(on: boolean) {
  try {
    localStorage.setItem(AUTO_KEY, on ? "1" : "0");
  } catch {}
}

/** due for an automatic check? (pure, for tests) */
export function isDue(lastCheck: number | null, now: number, every = CHECK_EVERY_MS): boolean {
  return !lastCheck || now - lastCheck >= every;
}

async function nativeCheck(): Promise<UpdateInfo> {
  const m = mock();
  if (m) return m.check();
  if (!isTauri) return { configured: false };
  const c = await import("@tauri-apps/api/core");
  return c.invoke<UpdateInfo>("check_update");
}

/** check now. `quiet`: no toast when up to date / failing (the automatic check). */
export async function checkForUpdates(quiet = false): Promise<UpdateInfo | null> {
  if (useUpdater.getState().phase === "checking" || useUpdater.getState().phase === "downloading") return null;
  useUpdater.setState({ phase: "checking", error: null });
  try {
    localStorage.setItem(LAST_KEY, String(Date.now()));
  } catch {}
  const { useStore } = await import("@/lib/store");
  try {
    const info = await nativeCheck();
    if (!info.configured) {
      useUpdater.setState({ phase: "idle", info });
      if (!quiet) useStore.getState().toast("In-app updates aren't available in this build", "alert");
      return info;
    }
    if (info.quietError) push("info", `update check skipped: ${info.quietError}${info.error ? ` (${info.error})` : ""}`, "updater");
    const skipped = (() => {
      try {
        return localStorage.getItem(SKIP_KEY);
      } catch {
        return null;
      }
    })();
    if (info.available && info.version && (!quiet || skipped !== info.version)) {
      useUpdater.setState({ phase: "available", info, cardOpen: true });
      push("info", `update available: ${info.version}`, "updater");
    } else {
      useUpdater.setState({ phase: "idle", info });
      if (!quiet) useStore.getState().toast(info.quietError === "offline" ? "You're offline — couldn't check for updates" : `You're on the latest Nook${info.current ? ` (${info.current})` : ""}`, info.quietError === "offline" ? "alert" : "check");
    }
    return info;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    push("warn", `update check failed: ${msg}`, "updater");
    useUpdater.setState({ phase: "idle", error: msg });
    if (!quiet) useStore.getState().toast(`Update check failed: ${msg.slice(0, 100)}`, "alert");
    return null;
  }
}

let scheduled = false;
/** the automatic check: call once after the first paint (and again when onboarding closes) */
export function scheduleAutoCheck(isOnboarding: () => boolean, delay = FIRST_CHECK_DELAY_MS) {
  if (scheduled || !autoUpdatesOn()) return;
  let last: number | null = null;
  try {
    last = Number(localStorage.getItem(LAST_KEY)) || null;
  } catch {}
  if (!isDue(last, Date.now())) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    if (isOnboarding() || !autoUpdatesOn()) return;
    void checkForUpdates(true);
  }, delay);
}

export async function installUpdate() {
  const st = useUpdater.getState();
  if (st.phase === "downloading") return;
  useUpdater.setState({ phase: "downloading", progress: 0, error: null });
  const onProgress = (got: number, total: number | null) => useUpdater.setState({ progress: total ? Math.min(100, Math.round((got / total) * 100)) : 0 });
  try {
    const m = mock();
    if (m?.install) {
      await m.install((d, t) => onProgress(d, t));
    } else {
      const c = await import("@tauri-apps/api/core");
      const ch = new c.Channel<{ type: string; downloaded?: number; total?: number | null }>();
      ch.onmessage = (ev) => ev.type === "progress" && onProgress(ev.downloaded ?? 0, ev.total ?? null);
      await c.invoke("install_update", { onEvent: ch });
    }
    useUpdater.setState({ phase: "installed", progress: 100 });
    push("info", "update installed — relaunching", "updater");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    push("error", `update install failed: ${msg}`, "updater");
    useUpdater.setState({ phase: "error", error: msg });
  }
}

export function skipVersion() {
  const v = useUpdater.getState().info?.version;
  if (v)
    try {
      localStorage.setItem(SKIP_KEY, v);
    } catch {}
  useUpdater.setState({ cardOpen: false, phase: "idle" });
}

export function later() {
  useUpdater.setState({ cardOpen: false });
}
