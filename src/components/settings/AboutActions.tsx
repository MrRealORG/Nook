/** 1.3.1 Settings ▸ About: Check for updates (+ automatic toggle), Report a bug, Copy debug info, logs. */
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { collectLogs, collectSysInfo, openBugReport } from "@/components/BugReport";
import { redact, settingsSummary } from "@/lib/bugreport";
import { useStore } from "@/lib/store";
import { autoUpdatesOn, checkForUpdates, setAutoUpdates, useUpdater } from "@/lib/updater";

export async function debugInfoText(): Promise<string> {
  const [sys, logs] = await Promise.all([collectSysInfo(), collectLogs()]);
  const settings = settingsSummary(useStore.getState() as unknown as Record<string, unknown>);
  return redact(
    [
      `Nook ${sys.version ?? ""}`,
      `OS: ${[sys.os, sys.osVersion, sys.arch].filter(Boolean).join(" ")}`,
      `WebView: ${sys.webview ?? navigator.userAgent}`,
      sys.logDir ? `Logs: ${sys.logDir}` : "",
      sys.perf ? `Background CPU limit: ${JSON.stringify(sys.perf)}` : "",
      `Settings: ${JSON.stringify(settings)}`,
      "",
      "--- recent logs ---",
      logs.slice(-12000),
    ]
      .filter((l) => l !== "")
      .join("\n"),
  );
}

export function AboutActions() {
  const phase = useUpdater((s) => s.phase);
  const [auto, setAuto] = useState(autoUpdatesOn());
  const st = useStore.getState;
  return (
    <div className="mt-2 flex w-full max-w-[460px] flex-col items-center gap-3">
      <div className="flex flex-wrap justify-center gap-2">
        <button className="btn btn-sm" onClick={() => void checkForUpdates(false)} disabled={phase === "checking" || phase === "downloading"} data-testid="about-check-updates">
          <Icon name="refresh" size={12} /> {phase === "checking" ? "Checking…" : "Check for updates"}
        </button>
        <button className="btn btn-sm" onClick={() => openBugReport()} data-testid="about-report-bug">
          <Icon name="bug" size={12} /> Report a bug
        </button>
        <button
          className="btn btn-sm"
          data-testid="about-copy-debug"
          onClick={() =>
            void debugInfoText().then(async (t) => {
              await navigator.clipboard?.writeText(t).catch(() => {});
              (window as unknown as { __lastDebugInfo?: string }).__lastDebugInfo = t;
              st().toast("Debug info copied (no API keys)", "copy");
            })
          }
        >
          <Icon name="copy" size={12} /> Copy debug info
        </button>
        <button className="btn btn-sm" onClick={() => st().set({ settingsSection: "logs" })} data-testid="about-logs">
          <Icon name="database" size={12} /> Logs
        </button>
      </div>
      <label className="flex items-center gap-2 text-[12.5px] text-dim">
        <input type="checkbox" checked={auto} onChange={(e) => { setAutoUpdates(e.target.checked); setAuto(e.target.checked); }} data-testid="about-auto-updates" />
        Check for updates automatically (signed releases from GitHub)
      </label>
    </div>
  );
}
