import { useEffect, useState } from "react";

/** Native-feeling caption buttons for the frameless desktop window (Windows 10/11 layout). */
export function WindowControls() {
  const [max, setMax] = useState(false);
  useEffect(() => {
    let off: (() => void) | undefined;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const w = getCurrentWindow();
      setMax(await w.isMaximized());
      off = await w.onResized(async () => setMax(await w.isMaximized()));
    });
    return () => off?.();
  }, []);
  const act = (fn: "minimize" | "toggleMaximize" | "close") => void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow()[fn]());
  return (
    <div className="win-controls" role="group" aria-label="Window controls">
      <button className="win-btn" title="Minimize" aria-label="Minimize" onClick={() => act("minimize")}>
        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" strokeWidth="1.2" /></svg>
      </button>
      <button className="win-btn" title={max ? "Restore" : "Maximize"} aria-label={max ? "Restore" : "Maximize"} onClick={() => act("toggleMaximize")}>
        {max ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1"><rect x="0.5" y="2.5" width="7" height="7" /><path d="M2.5 2.5V.5h7v7h-2" /></svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1"><rect x="0.5" y="0.5" width="9" height="9" /></svg>
        )}
      </button>
      <button className="win-btn" data-kind="close" title="Close to tray" aria-label="Close" onClick={() => act("close")}>
        <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.2"><path d="M0 0l10 10M10 0L0 10" /></svg>
      </button>
    </div>
  );
}
