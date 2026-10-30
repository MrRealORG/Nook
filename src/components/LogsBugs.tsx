
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/icons";
import { clearLogs, getLogs, logEvent, logsAsText, subscribe, type LogEntry, type LogLevel } from "@/lib/logger";
import { downloadText, reportHtml, reportMarkdown } from "@/lib/bugshare";
import { useStore } from "@/lib/store";
import { sfx } from "@/lib/sfx";

export type BugRow = { id: string; desc: string; severity: string; page: string; ua: string; logs: string; screenshot?: string; status: string; createdAt: string };

/** downscale an image blob to ≤1280px-wide JPEG data-url so screenshots stay small */
async function toShotDataUrl(src: Blob): Promise<string | null> {
  try {
    const url = URL.createObjectURL(src);
    const img = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("img")); img.src = url; });
    URL.revokeObjectURL(url);
    const scale = Math.min(1, 1280 / Math.max(img.width, 1));
    const cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(img.width * scale));
    cv.height = Math.max(1, Math.round(img.height * scale));
    const ctx = cv.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    return cv.toDataURL("image/jpeg", 0.75);
  } catch {
    return null;
  }
}

/** grab one frame of the screen via getDisplayMedia (Chromium) */
async function captureScreenShot(): Promise<string | null> {
  const md = navigator.mediaDevices as MediaDevices & { getDisplayMedia?: (c: MediaStreamConstraints) => Promise<MediaStream> };
  if (!md?.getDisplayMedia) return null;
  const stream = await md.getDisplayMedia({ video: true });
  try {
    const track = stream.getVideoTracks()[0] as MediaStreamTrack & { grabFrame?: () => Promise<ImageBitmap> };
    if (!track.grabFrame) return null;
    const frame = await track.grabFrame();
    const cv = document.createElement("canvas");
    cv.width = frame.width;
    cv.height = frame.height;
    cv.getContext("2d")?.drawImage(frame, 0, 0);
    return cv.toDataURL("image/jpeg", 0.75);
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

const EMPTY_LOGS: LogEntry[] = [];

function useLogs(): LogEntry[] {
  return useSyncExternalStore(
    (cb) => subscribe(cb),
    () => getLogs(),
    () => EMPTY_LOGS,
  );
}

const LEVEL_TINT: Record<LogLevel, string> = {
  error: "#e0684f",
  warn: "#e0a84f",
  info: "var(--accent)",
  debug: "var(--faint)",
};

/** The Logs & Bugs center — report problems, browse the live log, track filed reports. */
export function LogsBugs() {
  const open = useStore((s) => s.bugOpen);
  const tab = useStore((s) => s.bugTab);
  const logs = useLogs();
  const [desc, setDesc] = useState("");
  const [severity, setSeverity] = useState<"minor" | "normal" | "blocker">("normal");
  const [withLogs, setWithLogs] = useState(true);
  const [shot, setShot] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [sending, setSending] = useState(false);
  const [rows, setRows] = useState<BugRow[] | null>(null);
  const [logQ, setLogQ] = useState("");
  const [levelFilter, setLevelFilter] = useState<LogLevel | "all">("all");
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [shareId, setShareId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const st = useStore.getState;

  // paste a screenshot straight into the report form (Ctrl+V after any screenshot tool)
  useEffect(() => {
    if (!open || tab !== "report") return;
    const onPaste = async (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
      if (!item) return;
      const blob = item.getAsFile();
      if (!blob) return;
      const url = await toShotDataUrl(blob);
      if (url) { setShot(url); st().toast("Screenshot attached", "image"); }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [open, tab]);

  const loadRows = () => {
    void fetch("/api/bugs")
      .then((r) => r.json())
      .then((d) => setRows(Array.isArray(d) ? d : []))
      .catch(() => setRows([]));
  };

  useEffect(() => {
    if (open && tab === "reports") loadRows();
  }, [open, tab]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && useStore.setState({ bugOpen: false });
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const shown = useMemo(() => {
    const q = logQ.toLowerCase();
    return logs
      .filter((l) => (levelFilter === "all" || l.level === levelFilter) && (!q || l.msg.toLowerCase().includes(q)))
      .slice(-80)
      .reverse();
  }, [logs, logQ, levelFilter]);

  if (!open) return null;

  const submit = async () => {
    if (!desc.trim() || sending) return;
    setSending(true);
    try {
      const r = await fetch("/api/bugs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          desc: desc.trim(),
          severity,
          page: `${location.pathname}#${st().view}`,
          ua: navigator.userAgent,
          logs: withLogs ? logsAsText(30) : "",
          screenshot: shot ?? "",
        }),
      });
      if (r.ok) {
        sfx("achieve");
        st().toast("Bug report filed — thank you!", "bug");
        st().notify("Bug report received — tracked in Logs & Bugs", "bug", "info");
        st().unlock("bug-hunter", "Bug Hunter", "Filed your first bug report", "bug");
        setDesc("");
        setShot(null);
        logEvent("bug report filed", "info", "bugs");
      } else {
        sfx("error");
        st().toast("Could not file the report — is the server up?", "alert");
      }
    } catch {
      sfx("error");
      st().toast("Could not file the report", "alert");
    } finally {
      setSending(false);
    }
  };

  const grabScreen = async () => {
    setCapturing(true);
    try {
      const url = await captureScreenShot();
      if (url) { setShot(url); st().toast("Screen captured", "image"); }
      else st().toast("Screen capture isn't supported here — paste or pick an image instead", "alert");
    } catch {
      st().toast("Capture cancelled", "close");
    } finally {
      setCapturing(false);
    }
  };

  const shareReport = async (r: BugRow, how: "copy" | "html" | "native" | "mail") => {
    const md = reportMarkdown(r);
    if (how === "copy") {
      await navigator.clipboard.writeText(md).catch(() => {});
      st().toast("Report copied as markdown", "copy");
    } else if (how === "html") {
      downloadText(`nook-bug-${r.id.slice(0, 8)}.html`, reportHtml(r));
      st().toast("Report downloaded — send it to anyone", "download");
    } else if (how === "native") {
      const nav = navigator as Navigator & { share?: (d: { title?: string; text?: string }) => Promise<void> };
      if (nav.share) { await nav.share({ title: `Bug report (${r.severity})`, text: md }).catch(() => {}); }
      else st().toast("Web Share not available here — try Copy or Download", "alert");
    } else {
      window.location.href = `mailto:?subject=${encodeURIComponent("Bug report — " + r.severity)}&body=${encodeURIComponent(md.slice(0, 1800))}`;
    }
    sfx("pop");
  };

  const downloadLogs = () => {
    const blob = new Blob([JSON.stringify(logs, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `nook-logs-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };

  const patchBug = async (id: string, status: string) => {
    setRows((rs) => (rs ?? []).map((r) => (r.id === id ? { ...r, status } : r)));
    await fetch(`/api/bugs/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) }).catch(() => {});
  };

  const deleteBug = async (id: string) => {
    setRows((rs) => (rs ?? []).filter((r) => r.id !== id));
    await fetch(`/api/bugs/${id}`, { method: "DELETE" }).catch(() => {});
    sfx("trash");
  };

  const errs = logs.filter((l) => l.level === "error").length;

  return (
    <>
      <div className="fixed inset-0 z-[92] grid place-items-center bg-black/40 p-4" onPointerDown={() => useStore.setState({ bugOpen: false })}>
        <div
          className="panel panel-solid flex max-h-[86vh] w-full max-w-[640px] flex-col overflow-hidden rounded-[20px]"
          style={{ animation: "pop .22s var(--ease-soft) both", backdropFilter: "none" }}
          onPointerDown={(e) => e.stopPropagation()}
          role="dialog"
          aria-label="Logs and bug reports"
        >
          <header className="flex flex-none items-center gap-2 border-b border-line px-4 py-3">
            <Icon name="bug" size={15} className="text-accent" />
            <span className="label !text-[11px]">Logs &amp; Bugs</span>
            {errs > 0 && <span className="chip" style={{ color: "#e0684f" }}>{errs} error{errs === 1 ? "" : "s"} this session</span>}
            <span className="flex-1" />
            <button className="icon-btn !h-6 !w-6 !rounded-md" onClick={() => useStore.setState({ bugOpen: false })} aria-label="Close">
              <Icon name="close" size={13} />
            </button>
          </header>

          <div className="flex flex-none gap-1 border-b border-line px-3 py-2">
            {([["report", "Report a bug", "bug"], ["logs", "Live log", "logs"], ["reports", "My reports", "archive"]] as [typeof tab, string, IconName][]).map(([t, l, ic]) => (
              <button key={t} className="chip !normal-case !tracking-normal" data-on={tab === t} onClick={() => useStore.setState({ bugTab: t })}>
                <Icon name={ic} size={11} /> {l}
              </button>
            ))}
          </div>

          <div className="scroll min-h-0 flex-1 overflow-y-auto p-4">
            {tab === "report" && (
              <div className="space-y-3">
                <p className="text-[12.5px] text-dim">
                  Something look off? Describe it below — the report lands in <b>My reports</b> and your companion gets notified. Crash logs can ride along so bugs are easier to squash.
                </p>
                <textarea
                  className="input min-h-[110px] w-full resize-y"
                  placeholder="What happened? What did you expect instead? (steps help!)"
                  value={desc}
                  onChange={(e) => setDesc(e.target.value)}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <span className="label !text-[10px]">Severity</span>
                  <div className="seg seg-compact">
                    {(["minor", "normal", "blocker"] as const).map((s) => (
                      <button key={s} data-on={severity === s} onClick={() => setSeverity(s)}>
                        {s === "blocker" && <Icon name="alert" size={11} />}
                        {s}
                      </button>
                    ))}
                  </div>
                  <label className="flex cursor-pointer items-center gap-1.5 text-[12.5px] text-dim">
                    <input type="checkbox" checked={withLogs} onChange={(e) => setWithLogs(e.target.checked)} />
                    attach last 30 log lines
                  </label>
                  <span className="flex-1" />
                  <button className="btn btn-accent btn-sm" disabled={!desc.trim() || sending} onClick={() => void submit()}>
                    <Icon name="send" size={13} /> {sending ? "Filing…" : "File report"}
                  </button>
                </div>
                {/* screenshot attach row */}
                <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-line px-3 py-2.5">
                  <Icon name="image" size={14} className="text-accent" />
                  <span className="text-[11.5px] text-faint">Screenshot:</span>
                  <button className="btn btn-sm" disabled={capturing} onClick={() => void grabScreen()} title="Capture your screen (Chromium)">
                    <Icon name="monitor" size={12} /> {capturing ? "Capturing…" : "Capture"}
                  </button>
                  <button className="btn btn-sm" onClick={() => fileRef.current?.click()} title="Pick an image file">
                    <Icon name="upload" size={12} /> Pick file
                  </button>
                  <span className="hidden text-[11px] text-faint sm:inline">or paste with Ctrl+V</span>
                  <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { const u = await toShotDataUrl(f); if (u) setShot(u); } e.target.value = ""; }} />
                  {shot && (
                    <span className="ml-auto flex items-center gap-2">
                      <img src={shot} alt="attached screenshot" className="h-10 w-16 cursor-pointer rounded-md border border-line object-cover" onClick={() => setLightbox(shot)} title="Click to enlarge" />
                      <button className="icon-btn !h-6 !w-6" title="Remove screenshot" onClick={() => setShot(null)}><Icon name="close" size={11} /></button>
                    </span>
                  )}
                </div>
                <div className="rounded-xl border border-dashed border-line px-3 py-2.5 text-[11.5px] text-faint">
                  Tip: the pet can file reports too — ask it in chat: <span className="pixel-font">“report a bug: the graph looks empty”</span>.
                </div>
              </div>
            )}

            {tab === "logs" && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <input className="input !py-1 !text-[13px] min-w-[160px] flex-1" placeholder="Filter log text…" value={logQ} onChange={(e) => setLogQ(e.target.value)} />
                  <div className="seg seg-compact">
                    {(["all", "error", "warn", "info"] as const).map((l) => (
                      <button key={l} data-on={levelFilter === l} onClick={() => setLevelFilter(l)}>
                        {l}
                      </button>
                    ))}
                  </div>
                  <button className="icon-btn !h-7 !w-7" title="Download logs (JSON)" onClick={downloadLogs}>
                    <Icon name="download" size={13} />
                  </button>
                  <button className="icon-btn !h-7 !w-7" title="Clear the log" onClick={() => { clearLogs(); sfx("trash"); }}>
                    <Icon name="trash" size={13} />
                  </button>
                </div>
                {shown.length === 0 ? (
                  <div className="grid place-items-center gap-1.5 py-10 text-center">
                    <Icon name="logs" size={24} className="text-faint" />
                    <div className="pixel-font text-[13px] text-dim">Log is clean</div>
                    <div className="text-[11.5px] text-faint">errors, warnings and app events will appear here live</div>
                  </div>
                ) : (
                  <div className="space-y-1 font-mono text-[11px] leading-snug">
                    {shown.map((l) => (
                      <div key={l.id} className="flex gap-2 rounded-md border border-line/60 px-2 py-1" style={{ borderLeft: `3px solid ${LEVEL_TINT[l.level]}` }}>
                        <span className="flex-none text-faint">{new Date(l.t).toLocaleTimeString()}</span>
                        <span className="flex-none font-semibold" style={{ color: LEVEL_TINT[l.level] }}>{l.level}</span>
                        <span className="min-w-0 flex-1 break-words">{l.msg}</span>
                        {l.where && <span className="flex-none text-faint">{l.where}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {tab === "reports" && (
              <div className="space-y-2">
                {rows === null ? (
                  <div className="pixel-font py-8 text-center text-[13px] text-faint">loading reports…</div>
                ) : rows.length === 0 ? (
                  <div className="grid place-items-center gap-1.5 py-10 text-center">
                    <Icon name="bug" size={24} className="text-faint" />
                    <div className="pixel-font text-[13px] text-dim">No reports filed</div>
                    <div className="text-[11.5px] text-faint">either everything works, or you haven&apos;t tried hard enough</div>
                  </div>
                ) : (
                  rows.map((r) => (
                    <div key={r.id} className="rounded-xl border border-line p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="chip !py-0 !text-[10px]" style={{ color: r.severity === "blocker" ? "#e0684f" : r.severity === "minor" ? "var(--faint)" : "var(--accent)" }}>
                          {r.severity}
                        </span>
                        <span className="chip !py-0 !text-[10px]" data-on={r.status !== "open"}>
                          {r.status}
                        </span>
                        <span className="text-[11px] text-faint">{new Date(r.createdAt).toLocaleString()}</span>
                        <span className="flex-1" />
                        <button className="btn btn-sm !px-2 !text-[11px]" data-on={shareId === r.id} onClick={() => setShareId(shareId === r.id ? null : r.id)} title="Send this report to someone">
                          <Icon name="send" size={11} /> Share
                        </button>
                        <div className="seg seg-compact">
                          {(["open", "fixing", "fixed"] as const).map((s) => (
                            <button key={s} data-on={r.status === s} onClick={() => void patchBug(r.id, s)}>
                              {s}
                            </button>
                          ))}
                        </div>
                        <button className="icon-btn !h-6 !w-6" title="Delete report" onClick={() => void deleteBug(r.id)}>
                          <Icon name="close" size={11} />
                        </button>
                      </div>
                      <div className="mt-1.5 whitespace-pre-wrap text-[13px] leading-snug">{r.desc}</div>
                      {r.screenshot && (
                        <img
                          src={r.screenshot}
                          alt="bug screenshot"
                          className="mt-2 max-h-40 cursor-zoom-in rounded-lg border border-line object-contain"
                          onClick={() => setLightbox(r.screenshot ?? null)}
                          title="Click to enlarge"
                        />
                      )}
                      {shareId === r.id && (
                        <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-xl border border-dashed border-line p-2" style={{ animation: "pop .2s var(--ease-soft) both" }}>
                          <span className="label !text-[10px]">Send to anyone:</span>
                          <button className="btn btn-sm !text-[11px]" onClick={() => void shareReport(r, "copy")}><Icon name="copy" size={11} /> Copy markdown</button>
                          <button className="btn btn-sm !text-[11px]" onClick={() => void shareReport(r, "html")}><Icon name="download" size={11} /> Download HTML</button>
                          <button className="btn btn-sm !text-[11px]" onClick={() => void shareReport(r, "native")}><Icon name="external-link" size={11} /> Share…</button>
                          <button className="btn btn-sm !text-[11px]" onClick={() => void shareReport(r, "mail")}><Icon name="send" size={11} /> Email</button>
                        </div>
                      )}
                      {r.logs && <details className="mt-1.5"><summary className="cursor-pointer text-[11px] text-faint">attached log tail</summary><pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-panel2 p-2 font-mono text-[10px]">{r.logs}</pre></details>}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* screenshot lightbox */}
      {lightbox && (
        <div className="fixed inset-0 z-[99] grid cursor-zoom-out place-items-center bg-black/80 p-8" style={{ animation: "fadeIn .18s var(--ease-soft) both" }} onClick={() => setLightbox(null)} role="dialog" aria-label="Screenshot preview">
          <img src={lightbox} alt="screenshot enlarged" className="max-h-full max-w-full rounded-xl border border-line/40 object-contain" style={{ boxShadow: "0 30px 80px rgba(0,0,0,.6)" }} />
          <button className="icon-btn absolute right-4 top-4 !h-9 !w-9" onClick={() => setLightbox(null)} aria-label="Close preview"><Icon name="close" size={16} /></button>
        </div>
      )}
    </>
  );
}
