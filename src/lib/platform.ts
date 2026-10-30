/**
 * Platform bridge — the only place that knows whether we run inside the Tauri desktop
 * shell or in a plain browser (dev server / Playwright against `nook-dev-api`).
 * Everything Tauri-specific is imported lazily so the browser build never loads it.
 */

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Where the dev API server lives when running in a normal browser (`npm run dev:api`). */
export const DEV_API: string =
  (typeof window !== "undefined" && (window as unknown as { __NOOK_API__?: string }).__NOOK_API__) ||
  (import.meta.env.VITE_NOOK_API as string | undefined) ||
  "http://127.0.0.1:3210";

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(cmd, args);
}

/** Fire-and-forget invoke that never throws (desktop niceties are optional). */
export function tryInvoke(cmd: string, args?: Record<string, unknown>): void {
  if (!isTauri) return;
  void invoke(cmd, args).catch((e) => console.warn(`[nook] ${cmd} failed`, e));
}

/** What clicking a link should do. Pure — unit-tested from e2e via `window.__nookLink`. */
export type LinkAction = "external" | "deeplink" | "share" | "download" | "internal";
export function classifyLink(href: string, origin = typeof location !== "undefined" ? location.origin : ""): LinkAction {
  const h = href.trim();
  if (/^nook:\/\/share\//i.test(h)) return "share";
  if (/^nook:/i.test(h)) return "deeplink";
  if (/^(blob:|data:)/i.test(h)) return "download";
  if (/^(https?:|mailto:)/i.test(h) && !(origin && h.startsWith(origin))) return "external";
  return "internal";
}

/** Open an external URL in the system browser (desktop) or a new tab (browser). */
export async function openExternal(url: string): Promise<void> {
  if (typeof window !== "undefined" && (window as unknown as { __NOOK_E2E__?: boolean }).__NOOK_E2E__) {
    (window as unknown as { __nookOpened: string[] }).__nookOpened = [...((window as unknown as { __nookOpened?: string[] }).__nookOpened ?? []), url];
    if (!isTauri) return; // e2e: record instead of spawning tabs
  }
  if (isTauri) {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
      return;
    } catch (e) {
      console.warn("[nook] openUrl failed", e);
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Save bytes through the native "Save as…" dialog (desktop) or a browser download. */
export async function saveFile(name: string, data: Blob | string, mime = "application/octet-stream"): Promise<boolean> {
  const blob = typeof data === "string" ? new Blob([data], { type: mime }) : data;
  if (isTauri) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    const saved = await invoke<string | null>("save_file", { name, dataB64: btoa(bin) });
    return !!saved;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  (nativeAnchorClick ?? HTMLAnchorElement.prototype.click).call(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return true;
}

let nativeAnchorClick: (() => void) | null = null;
const blobRegistry = new Map<string, Blob>();

/**
 * Desktop glue for code written for the browser:
 *  - `<a download>` clicks (every export in the app) → native save dialog
 *  - external links / `window.open(http…)` / mailto: → system browser
 */
export function installDesktopGlue(): void {
  if (typeof window !== "undefined") (window as unknown as { __nookLink: typeof classifyLink }).__nookLink = classifyLink;
  // nook:// links inside notes, chat replies and exported HTML work in the browser build too
  if (!isTauri && typeof document !== "undefined") {
    document.addEventListener(
      "click",
      (e) => {
        const a = (e.target as HTMLElement | null)?.closest?.("a");
        const href = a?.getAttribute("href") ?? "";
        const kind = a ? classifyLink(href) : "internal";
        if (kind === "deeplink" || kind === "share") {
          e.preventDefault();
          void import("@/lib/desktop").then((d) => d.handleDeepLink(href));
        } else if (kind === "external" && (window as unknown as { __NOOK_E2E__?: boolean }).__NOOK_E2E__) {
          e.preventDefault();
          void openExternal(href);
        }
      },
      true,
    );
  }
  if (!isTauri || nativeAnchorClick) return;
  nativeAnchorClick = HTMLAnchorElement.prototype.click;
  const createObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (obj: Blob | MediaSource) => {
    const url = createObjectURL(obj);
    if (obj instanceof Blob) {
      blobRegistry.set(url, obj);
      if (blobRegistry.size > 64) blobRegistry.delete(blobRegistry.keys().next().value as string);
    }
    return url;
  };
  const handleAnchor = (a: HTMLAnchorElement): boolean => {
    const href = a.getAttribute("href") ?? "";
    if (a.hasAttribute("download") && (href.startsWith("blob:") || href.startsWith("data:"))) {
      const name = a.getAttribute("download") || "download";
      const blob = blobRegistry.get(href);
      if (blob) void saveFile(name, blob);
      else void fetch(href).then((r) => r.blob()).then((b) => saveFile(name, b));
      return true;
    }
    const kind = classifyLink(href);
    if (kind === "external") {
      void openExternal(href);
      return true;
    }
    if (kind === "deeplink" || kind === "share") {
      void import("@/lib/desktop").then((d) => d.handleDeepLink(href));
      return true;
    }
    return false;
  };
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    if (!handleAnchor(this)) nativeAnchorClick!.call(this);
  };
  document.addEventListener(
    "click",
    (e) => {
      const a = (e.target as HTMLElement | null)?.closest?.("a");
      if (a && handleAnchor(a as HTMLAnchorElement)) e.preventDefault();
    },
    true,
  );
  const open = window.open.bind(window);
  window.open = ((url?: string | URL, target?: string, features?: string) => {
    const u = String(url ?? "");
    if (/^(https?:|mailto:)/i.test(u) && !u.startsWith(location.origin)) {
      void openExternal(u);
      return null;
    }
    return open(url, target, features);
  }) as typeof window.open;
}

/** Native OS notification when the window is hidden (desktop only). */
export async function nativeNotify(title: string, body: string): Promise<void> {
  if (!isTauri) return;
  try {
    const n = await import("@tauri-apps/plugin-notification");
    let ok = await n.isPermissionGranted();
    if (!ok) ok = (await n.requestPermission()) === "granted";
    if (ok) n.sendNotification({ title, body });
  } catch {
    /* notifications are best-effort */
  }
}
