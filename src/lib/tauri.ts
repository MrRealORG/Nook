/**
 * Nook desktop bridge — Tauri v2 IPC surface.
 *
 * The Rust shell (`src-tauri/`) exposes commands through `window.__TAURI__`,
 * so no extra npm package is required. When Nook runs in a browser (or under
 * `next dev` without Tauri) every helper gracefully no-ops or throws a clear
 * error, so the web build is completely untouched.
 */

type InvokeArgs = Record<string, unknown>;

const tauri = (() => {
  if (typeof window === "undefined") return null;
  const t = (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  const core = (t as { core?: { invoke?: unknown } } | undefined)?.core;
  return core && typeof (core as { invoke?: unknown }).invoke === "function"
    ? (t as {
        core: { invoke: (cmd: string, args?: InvokeArgs) => Promise<unknown> };
      })
    : null;
})();

/** True when running inside the Tauri desktop shell (WebView2 on Windows). */
export const isDesktop = !!tauri;

async function invoke(cmd: string, args: InvokeArgs = {}): Promise<unknown> {
  if (!tauri) {
    throw new Error(`[tauri] ${cmd} — Nook is not running as a desktop app`);
  }
  return tauri.core.invoke(cmd, args);
}

/** Directory where Nook keeps its vault. Windows: %LOCALAPPDATA%\Nook */
export async function getDataDir(): Promise<string> {
  return String(await invoke("get_data_dir"));
}

/** Version of the desktop shell (from Cargo.toml). */
export async function appVersion(): Promise<string> {
  return String(await invoke("app_version"));
}

/** Window placement, persisted to <dataDir>/window-state.json. */
export interface WindowPlacement {
  maximized: boolean;
  width: number;
  height: number;
}

export async function saveWindowState(state: WindowPlacement): Promise<void> {
  await invoke("save_window_state", state);
}

export async function loadWindowState(): Promise<WindowPlacement | null> {
  const v = await invoke("load_window_state");
  return v ? (v as WindowPlacement) : null;
}

export async function desktopIsMaximized(): Promise<boolean> {
  return Boolean(await invoke("is_maximized"));
}

export async function desktopMinimize(): Promise<void> {
  await invoke("minimize_window");
}

export async function desktopRestore(): Promise<void> {
  await invoke("restore_window");
}

export async function desktopToggleMaximize(): Promise<void> {
  await invoke("toggle_maximize");
}

/** Quit Nook — also kills the embedded Next.js server. */
export async function desktopQuit(): Promise<void> {
  await invoke("close_window");
}

/** Open a URL in the user's default browser. */
export async function openExternal(url: string): Promise<void> {
  await invoke("open_external", { url });
}

/** Launch Nook on Windows startup (HKCU Run key). Windows only. */
export async function setAutoStart(on: boolean): Promise<void> {
  await invoke("set_auto_start", { enable: on });
}

export async function getAutoStart(): Promise<boolean> {
  return Boolean(await invoke("get_auto_start"));
}

/** When on, minimizing hides Nook to the tray instead of the taskbar. */
export async function setMinimizeToTray(on: boolean): Promise<void> {
  await invoke("set_minimize_to_tray", { on });
}

export async function getMinimizeToTray(): Promise<boolean> {
  return Boolean(await invoke("get_minimize_to_tray"));
}
