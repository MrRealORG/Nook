/**
 * Desktop integration on the UI side: app info, deep links (nook://), global-hotkey quick
 * capture, tray routing, Mica/acrylic, native notifications and the opt-in updater.
 * Everything is a no-op in a plain browser.
 */
import { create } from "zustand";
import { DEV_API, invoke, isTauri, nativeNotify } from "@/lib/platform";
import { setShareHost } from "@/lib/shareKit";

export type DesktopSettings = {
  mcpEnabled: boolean;
  mcpPort: number;
  lanShare: boolean;
  widget: boolean;
  autostart: boolean;
  hotkeys: boolean;
  closeToTray: boolean;
  glass: "off" | "mica" | "acrylic";
  autoUpdate: boolean;
  /** 1.2: hard CPU cap (Windows Job Object), % of the machine, 5–50 */
  cpuCap: number;
  cpuCapOn: boolean;
  widgetOnTop: boolean;
};

export type PerfStatus = { supported: boolean; applied: boolean; capPct: number; belowNormal: boolean; eco: boolean; childrenInJob: number; childrenAdopted: number; error: string | null };

export type DesktopInfo = {
  ready: boolean;
  desktop: boolean;
  version: string;
  platform: string;
  dataDir: string;
  dbPath: string;
  exePath: string;
  mcpRunning: boolean;
  mcpPort: number;
  mcpError: string | null;
  lanIp: string | null;
  updaterConfigured: boolean;
  perf?: PerfStatus;
  settings: DesktopSettings;
  update: { available: boolean; version?: string; notes?: string } | null;
};

const DEFAULTS: DesktopSettings = { mcpEnabled: true, mcpPort: 3000, lanShare: false, widget: false, autostart: false, hotkeys: true, closeToTray: true, glass: "off", autoUpdate: false, cpuCap: 10, cpuCapOn: true, widgetOnTop: false };

export const useDesktopInfo = create<DesktopInfo>(() => ({
  ready: false,
  desktop: isTauri,
  version: "1.2.0",
  platform: "web",
  dataDir: "",
  dbPath: "",
  exePath: "",
  mcpRunning: !isTauri,
  mcpPort: 3000,
  mcpError: null,
  lanIp: null,
  updaterConfigured: false,
  settings: DEFAULTS,
  update: null,
}));

export async function refreshDesktopInfo(): Promise<void> {
  if (!isTauri) {
    useDesktopInfo.setState({ ready: true });
    return;
  }
  const info = await invoke<Omit<DesktopInfo, "ready" | "desktop" | "update">>("app_info");
  useDesktopInfo.setState({ ...info, settings: { ...DEFAULTS, ...info.settings }, ready: true });
  document.documentElement.dataset.platform = info.platform;
}

export async function setDesktopSettings(patch: Partial<DesktopSettings>): Promise<void> {
  if (!isTauri) return;
  const info = await invoke<Omit<DesktopInfo, "ready" | "desktop" | "update">>("desktop_settings_set", { patch });
  useDesktopInfo.setState({ ...info, settings: { ...DEFAULTS, ...info.settings } });
}

/** Tell other windows (widget ↔ main) that data changed. */
export function broadcast(event: "data-changed", payload?: unknown): void {
  if (isTauri) void invoke("broadcast", { event, payload: payload ?? null }).catch(() => {});
}

/** Handle nook:// links: nook://note/<id>, nook://share/<id>, nook://new?title=&text=, nook://view/<view>, nook://task?title= */
export async function handleDeepLink(raw: string): Promise<void> {
  const { useStore } = await import("@/lib/store");
  const st = useStore.getState();
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return;
  }
  const parts = `${u.hostname}${u.pathname}`.split("/").filter(Boolean).map(decodeURIComponent);
  const [kind, arg] = parts;
  switch (kind) {
    case "note": {
      // by id first, then by title (exported HTML and [[wikilinks]] link by title)
      const byId = arg ? st.notes.find((n) => n.id === arg) : undefined;
      const byTitle = arg ? st.notes.find((n) => n.title.trim().toLowerCase() === arg.trim().toLowerCase()) : undefined;
      const hit = byId ?? byTitle;
      if (hit) {
        st.setView("notes");
        st.openNote(hit.id);
      } else st.toast("That note isn't in this vault", "close");
      break;
    }
    case "daily": {
      const { openDaily } = await import("@/components/CalendarView");
      await openDaily(arg);
      break;
    }
    case "share":
      if (arg) {
        const url = new URL(location.href);
        url.searchParams.set("share", arg);
        history.pushState({}, "", url);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }
      break;
    case "new": {
      const title = u.searchParams.get("title") ?? "";
      const text = u.searchParams.get("text") ?? "";
      st.setView("notes");
      st.createNote({ title: title || undefined, content: title ? `# ${title}\n\n${text}` : text });
      break;
    }
    case "task": {
      const title = u.searchParams.get("title") ?? arg ?? "";
      if (title) st.createTask({ title });
      st.setView("tasks");
      break;
    }
    case "view":
      if (arg) st.setView(arg as Parameters<typeof st.setView>[0]);
      break;
    default:
      st.toast(`Unknown link: ${raw.slice(0, 60)}`, "link");
  }
}

let started = false;

export async function initDesktop(): Promise<void> {
  if (started) return;
  started = true;
  (window as unknown as { __nookDeepLink: typeof handleDeepLink }).__nookDeepLink = handleDeepLink;
  setShareHost(() => {
    if (!isTauri) return DEV_API;
    const d = useDesktopInfo.getState();
    if (!d.mcpRunning) return null;
    return `http://${d.settings.lanShare && d.lanIp ? d.lanIp : "127.0.0.1"}:${d.mcpPort}`;
  });
  await refreshDesktopInfo().catch(() => useDesktopInfo.setState({ ready: true }));
  if (!isTauri) return;
  const { listen } = await import("@tauri-apps/api/event");
  const { useStore } = await import("@/lib/store");
  const win = (await import("@tauri-apps/api/window")).getCurrentWindow();

  void listen<string>("nook://deep-link", (e) => void handleDeepLink(e.payload)).then(async () => {
    // links that launched the app (cold start) were parked by Rust until now
    const pending = await invoke<string[]>("pending_deep_links").catch(() => [] as string[]);
    for (const u of pending) await handleDeepLink(u);
  });
  void listen("nook://capture", () => {
    const st = useStore.getState();
    st.setView("notes");
    st.createNote({ content: "" });
    st.toast("Quick capture — start typing", "pencil");
  });
  void listen<string>("nook://route", (e) => {
    const [view, section] = String(e.payload).split(":");
    const st = useStore.getState();
    st.setView(view as Parameters<typeof st.setView>[0]);
    if (section) st.set({ settingsSection: section });
  });
  void listen<string>("nook://glass", (e) => {
    document.documentElement.dataset.glass = e.payload;
  });
  void listen("nook://desktop-settings", () => void refreshDesktopInfo());
  // the widget changed tasks/notes → re-sync
  void listen<{ source?: string }>("nook://data-changed", async (e) => {
    if (e.payload?.source === "main") return;
    const st = useStore.getState();
    void st.loadTasks();
    try {
      const notes = await (await fetch("/api/notes")).json();
      if (Array.isArray(notes)) useStore.setState({ notes });
    } catch {
      /* keep current */
    }
  });
  const glass = useDesktopInfo.getState().settings.glass;
  if (glass !== "off") document.documentElement.dataset.glass = await invoke<string>("set_glass", { mode: glass }).catch(() => "off");
  await win.show().catch(() => {});

  // native notifications for notices that land while the window is hidden/minimized
  useStore.subscribe((s, prev) => {
    if (s.notices.length <= prev.notices.length) return;
    const fresh = s.notices[0];
    if (!fresh || s.dnd || (document.visibilityState === "visible" && document.hasFocus())) return;
    void nativeNotify("Nook", fresh.text);
  });

  // 1.3.1: the automatic update check is scheduled by the app (lib/updater.ts) — 30 s after
  // first paint, at most every 6 h, never during onboarding
}

export async function checkForUpdate(quiet = false): Promise<void> {
  const m = await import("@/lib/updater");
  await m.checkForUpdates(quiet);
}
