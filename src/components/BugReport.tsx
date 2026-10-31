/**
 * 1.3.1 "Report a bug" — from Settings ▸ About, the error-boundary screen and the command palette
 * (and offered automatically on the launch after a crash).
 *
 * Send = open a prefilled GitHub issue (title + body in the URL, trimmed to fit). The full report
 * (with logs) can also be saved as .txt or copied, so it can be attached by hand. API keys and
 * other secrets are stripped (lib/bugreport.ts) — never included.
 */
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { Icon } from "@/components/Icon";
import { buildReport, githubIssueUrl, settingsSummary, type SysInfo } from "@/lib/bugreport";
import { logsAsText, push } from "@/lib/logger";
import { useStore } from "@/lib/store";
import { version as APP_VERSION } from "../../package.json";

type ReportState = { open: boolean; draft: string; crash: string | null; openWith: (draft?: string, crash?: string | null) => void; close: () => void };
export const useBugReport = create<ReportState>((set) => ({
  open: false,
  draft: "",
  crash: null,
  openWith: (draft = "", crash = null) => set({ open: true, draft, crash }),
  close: () => set({ open: false }),
}));
export const openBugReport = (draft?: string, crash?: string | null) => useBugReport.getState().openWith(draft, crash);

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauri) return null;
  try {
    const c = await import("@tauri-apps/api/core");
    return await c.invoke<T>(cmd, args);
  } catch {
    return null;
  }
}

export async function collectSysInfo(): Promise<SysInfo> {
  const native = await tauriInvoke<SysInfo>("system_info");
  return { version: APP_VERSION, os: navigator.platform, userAgent: navigator.userAgent, ...(native ?? {}) };
}

export async function collectLogs(): Promise<string> {
  const ui = logsAsText(80);
  const file = await tauriInvoke<string>("logs_tail", { max: 24 * 1024 });
  return file ? `${file.trim()}\n--- ui ring ---\n${ui}` : ui;
}

/** the user's own API keys never appear in a report, even if they ended up in a log line */
function knownSecrets(): string[] {
  try {
    const out: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) ?? "";
      if (/key|token|secret/i.test(k)) out.push(localStorage.getItem(k) ?? "");
    }
    return out.filter((s) => s.length >= 8 && s.length < 400);
  } catch {
    return [];
  }
}

function saveText(name: string, text: string) {
  // desktop: native "Save as…" dialog; browser: a download
  void import("@/lib/platform").then((m) => m.saveFile(name, text, "text/plain")).catch(() => {});
}

export function BugReportDialog() {
  const { open, draft, crash, close } = useBugReport();
  const [what, setWhat] = useState("");
  const [steps, setSteps] = useState("");
  const [withLogs, setWithLogs] = useState(true);
  const [shot, setShot] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ title: string; body: string; url: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setWhat(draft);
    setSteps("");
    setShot(null);
    setPreview(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, draft, close]);

  if (!open) return null;

  const build = async () => {
    const st = useStore.getState() as unknown as Record<string, unknown>;
    const [sys, logs] = withLogs ? await Promise.all([collectSysInfo(), collectLogs()]) : [undefined, undefined];
    const r = buildReport({ what, steps, includeLogs: withLogs, sys, settings: withLogs ? settingsSummary(st) : undefined, logs, crash: crash ?? undefined, hasScreenshot: !!shot, extraSecrets: knownSecrets() });
    const p = { ...r, url: githubIssueUrl(r.title, r.body) };
    setPreview(p);
    return p;
  };

  const send = async () => {
    const p = await build();
    push("info", `bug report opened on GitHub (${p.url.length} chars)`, "bugs");
    (window as unknown as { __lastIssueUrl?: string }).__lastIssueUrl = p.url;
    void import("@/lib/platform").then((m) => m.openExternal(p.url)).catch(() => window.open(p.url, "_blank"));
    useStore.getState().toast("Opening a GitHub issue — attach the saved report if it was trimmed", "bug");
  };
  const save = async () => {
    const p = await build();
    saveText(`nook-bug-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`, `${p.title}\n\n${p.body}\n`);
    if (shot) {
      const a = document.createElement("a");
      a.href = shot;
      a.download = "nook-bug-screenshot.jpg";
      a.click();
    }
  };
  const copy = async () => {
    const p = await build();
    await navigator.clipboard?.writeText(`${p.title}\n\n${p.body}`).catch(() => {});
    useStore.getState().toast("Report copied to the clipboard", "copy");
  };

  const pickShot = (f: File) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, 1280 / img.width);
      const cv = document.createElement("canvas");
      cv.width = Math.round(img.width * s);
      cv.height = Math.round(img.height * s);
      cv.getContext("2d")?.drawImage(img, 0, 0, cv.width, cv.height);
      setShot(cv.toDataURL("image/jpeg", 0.8));
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(f);
  };

  return (
    <div className="fixed inset-0 z-[950] grid place-items-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && close()} data-testid="bug-report">
      <div className="paper w-[min(560px,100%)] p-5" role="dialog" aria-label="Report a bug">
        <div className="mb-3 flex items-center gap-2">
          <Icon name="bug" size={16} className="text-accent" />
          <div className="pixel-font text-[16px]">Report a bug</div>
          <span className="flex-1" />
          <button className="icon-btn" onClick={close} aria-label="Close"><Icon name="close" size={14} /></button>
        </div>
        {crash && <div className="mb-2 rounded-lg bg-[color:var(--hover)] p-2 text-[11.5px] text-dim">Nook hit an error last time. The details are included below.</div>}
        <label className="mb-2 block">
          <span className="tiny-font mb-1 block text-[9.5px] text-faint">WHAT HAPPENED?</span>
          <textarea className="input min-h-[70px] w-full" value={what} onChange={(e) => setWhat(e.target.value)} data-testid="bug-what" autoFocus />
        </label>
        <label className="mb-2 block">
          <span className="tiny-font mb-1 block text-[9.5px] text-faint">STEPS TO REPRODUCE (OPTIONAL)</span>
          <textarea className="input min-h-[54px] w-full" value={steps} onChange={(e) => setSteps(e.target.value)} placeholder={"1. Open …\n2. Click …"} data-testid="bug-steps" />
        </label>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <button className="btn btn-sm" onClick={() => fileRef.current?.click()}><Icon name="image" size={12} /> {shot ? "Change screenshot" : "Attach screenshot"}</button>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && pickShot(e.target.files[0])} data-testid="bug-shot" />
          {shot && <img src={shot} alt="screenshot" className="h-10 rounded border border-line" />}
        </div>
        <label className="mb-3 flex items-center gap-2 text-[12.5px]">
          <input type="checkbox" checked={withLogs} onChange={(e) => setWithLogs(e.target.checked)} data-testid="bug-with-logs" />
          Include recent logs and system info (OS, version, WebView2, settings — API keys are never included)
        </label>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-primary" onClick={() => void send()} disabled={!what.trim()} data-testid="bug-send"><Icon name="external-link" size={12} /> Open GitHub issue</button>
          <button className="btn" onClick={() => void save()} disabled={!what.trim()} data-testid="bug-save"><Icon name="download" size={12} /> Save report .txt</button>
          <button className="btn" onClick={() => void copy()} disabled={!what.trim()} data-testid="bug-copy"><Icon name="copy" size={12} /> Copy</button>
        </div>
        {preview && <div className="mt-2 text-[11px] text-faint" data-testid="bug-preview-len">Issue link: {preview.url.length} characters{preview.url.includes("truncated") ? " (trimmed — attach the saved report)" : ""}</div>}
      </div>
    </div>
  );
}

/** on the launch after a crash (Rust panic or a UI error), offer the report once */
export async function offerCrashReport() {
  let crash: string | null = await tauriInvoke<string | null>("take_crash");
  try {
    const ui = localStorage.getItem("nook:lastCrash");
    if (ui) {
      localStorage.removeItem("nook:lastCrash");
      const j = JSON.parse(ui) as { t: number; msg: string };
      if (!crash && Date.now() - j.t < 7 * 86400_000) crash = j.msg;
    }
  } catch {}
  if (!crash) return;
  const st = useStore.getState();
  st.notify?.("Nook ran into a problem last time — want to send a bug report?", "bug", "info");
  openBugReport("", crash);
}
