/** 1.3.1 — "Nook X.Y.Z is available" card (bottom-right). Renders nothing unless an update was found. */
import { Icon } from "@/components/Icon";
import { installUpdate, later, skipVersion, useUpdater } from "@/lib/updater";

export function UpdateCard() {
  const { cardOpen, phase, info, progress, error } = useUpdater();
  if (!cardOpen || !info?.version) return null;
  const busy = phase === "downloading" || phase === "installed";
  return (
    <div className="update-card paper fixed bottom-12 right-4 z-[880] w-[340px] p-4" role="dialog" aria-label="Update available" data-testid="update-card">
      <div className="flex items-center gap-2">
        <Icon name="download" size={15} className="text-accent" />
        <div className="pixel-font text-[14px]">Nook {info.version} is available</div>
      </div>
      {info.current && <div className="mt-0.5 text-[11px] text-faint">You have {info.current}</div>}
      {info.notes && <div className="mt-2 max-h-[140px] overflow-auto whitespace-pre-wrap rounded-lg bg-[color:var(--hover)] p-2 text-[12px] text-dim" data-testid="update-notes">{info.notes}</div>}
      {busy && (
        <div className="mt-3">
          <div className="h-[7px] overflow-hidden rounded-full bg-panel2">
            <i className="block h-full bg-accent transition-[width]" style={{ width: `${progress}%` }} data-testid="update-progress" />
          </div>
          <div className="mt-1 text-[11px] text-faint">{phase === "installed" ? "Installed — relaunching…" : `Downloading… ${progress}%`}</div>
        </div>
      )}
      {phase === "error" && <div className="mt-2 text-[11.5px]" style={{ color: "#e0684f" }}>Update failed: {error}</div>}
      {!busy && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          <button className="btn btn-sm btn-primary" onClick={() => void installUpdate()} data-testid="update-now">Update now</button>
          <button className="btn btn-sm" onClick={later} data-testid="update-later">Later</button>
          <button className="btn btn-sm" onClick={skipVersion} data-testid="update-skip">Skip this version</button>
        </div>
      )}
    </div>
  );
}
