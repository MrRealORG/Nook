import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { checkForUpdate, refreshDesktopInfo, setDesktopSettings, useDesktopInfo, type DesktopSettings } from "@/lib/desktop";
import { invoke, isTauri } from "@/lib/platform";
import { TEAM_URL_KEY } from "@/lib/teamSocket";
import { useStore } from "@/lib/store";

function Row({ label, hint, on, onChange, disabled }: { label: string; hint: string; on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-panel2 disabled:opacity-50" onClick={() => onChange(!on)} disabled={disabled} role="switch" aria-checked={on} aria-label={label}>
      <span className="min-w-0 flex-1">
        <span className="pixel-font block text-[13.5px]">{label}</span>
        <span className="block text-[11.5px] text-faint">{hint}</span>
      </span>
      <span className="relative h-[18px] w-[32px] flex-none rounded-full border border-line" style={{ background: on ? "var(--accent)" : "var(--panel2)" }}>
        <span className="absolute top-[2px] h-[12px] w-[12px] rounded-full transition-all" style={{ left: on ? 16 : 2, background: on ? "var(--accent-ink)" : "var(--dim)" }} />
      </span>
    </button>
  );
}

/** Settings → Desktop: widget, tray, hotkeys, autostart, glass, local server, updates. */
export function DesktopSection() {
  const info = useDesktopInfo();
  const s = info.settings;
  const [port, setPort] = useState(String(s.mcpPort));
  const [teamUrl, setTeamUrl] = useState(() => localStorage.getItem(TEAM_URL_KEY) ?? "");
  useEffect(() => setPort(String(s.mcpPort)), [s.mcpPort]);
  useEffect(() => {
    void refreshDesktopInfo();
  }, []);
  const patch = async (p: Partial<DesktopSettings>) => {
    try {
      await setDesktopSettings(p);
    } catch (e) {
      useStore.getState().toast(`Could not apply: ${e}`, "close");
    }
  };

  if (!isTauri)
    return (
      <div className="paper p-5 text-[12.5px] text-dim">
        Desktop features (widget, tray, global hotkeys, autostart, Mica, updates) are available in the Nook desktop app.
      </div>
    );

  return (
    <div className="space-y-4" data-testid="desktop-settings">
      <div className="paper p-2.5">
        <div className="label px-3 pb-1 pt-2">Desktop</div>
        <Row label="Desktop widget" hint="A frameless mini-Nook pinned to your desktop: quick capture, today's tasks, your pet and a mini AI ask." on={s.widget} onChange={(v) => void patch({ widget: v })} />
        <Row label="Global hotkeys" hint="Ctrl+Alt+N quick capture · Ctrl+Alt+H show / hide Nook — work from any app." on={s.hotkeys} onChange={(v) => void patch({ hotkeys: v })} />
        <Row label="Start with Windows" hint="Launch quietly into the tray when you sign in (off by default)." on={s.autostart} onChange={(v) => void patch({ autostart: v })} />
        <Row label="Close to tray" hint="The close button hides Nook to the tray so your pet and agents keep running. Quit from the tray menu." on={s.closeToTray} onChange={(v) => void patch({ closeToTray: v })} />
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <span className="pixel-font flex-1 text-[13.5px]">Window backdrop</span>
          {(["off", "mica", "acrylic"] as const).map((g) => (
            <button key={g} className="chip" data-on={s.glass === g} onClick={() => void patch({ glass: g })}>
              {g === "off" ? "Solid" : g === "mica" ? "Mica (Win 11)" : "Acrylic"}
            </button>
          ))}
        </div>
      </div>

      <div className="paper p-2.5">
        <div className="label px-3 pb-1 pt-2">Local server — MCP, team room & share links</div>
        <Row label="Run the local server" hint={info.mcpRunning ? `Listening on 127.0.0.1:${info.mcpPort}` : info.mcpError ? `Not running: ${info.mcpError}` : "Off — MCP agents, team room and share links are unavailable"} on={s.mcpEnabled} onChange={(v) => void patch({ mcpEnabled: v })} />
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <span className="text-[12.5px] text-dim">Port</span>
          <input className="input !h-[30px] w-[100px]" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, "").slice(0, 5))} aria-label="Server port" />
          <button className="btn btn-sm" onClick={() => void patch({ mcpPort: Number(port) || 3000 })} disabled={Number(port) === s.mcpPort}>Apply</button>
        </div>
        <Row
          label="Share on my network"
          hint={s.lanShare ? `Reachable at http://${info.lanIp ?? "your-ip"}:${info.mcpPort} — set an MCP token in Settings → MCP!` : "Workers and teammates on your Wi-Fi can open share links and join the team room"}
          on={s.lanShare}
          onChange={(v) => void patch({ lanShare: v })}
        />
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <span className="text-[12.5px] text-dim">Team room</span>
          <input className="input !h-[30px] min-w-[220px] flex-1" value={teamUrl} placeholder={`ws://127.0.0.1:${info.mcpPort}/team (this computer)`} onChange={(e) => setTeamUrl(e.target.value)} aria-label="Team room address" />
          <button
            className="btn btn-sm"
            onClick={() => {
              if (teamUrl.trim()) localStorage.setItem(TEAM_URL_KEY, teamUrl.trim());
              else localStorage.removeItem(TEAM_URL_KEY);
              useStore.getState().toast(teamUrl.trim() ? "Team room address saved" : "Using this computer's room", "waves");
            }}
          >
            Save
          </button>
        </div>
      </div>

      <div className="paper p-5">
        <div className="label mb-2">Updates</div>
        {info.updaterConfigured ? (
          <>
            <Row label="Check for updates automatically" hint="Signed releases from GitHub — checked at startup." on={s.autoUpdate} onChange={(v) => void patch({ autoUpdate: v })} />
            <div className="mt-2 flex flex-wrap gap-2 px-3">
              <button className="btn btn-sm" onClick={() => void checkForUpdate()}>
                <Icon name="refresh" size={12} /> Check now
              </button>
              {info.update?.available && (
                <button className="btn btn-sm" onClick={() => void invoke("install_update").catch((e) => useStore.getState().toast(String(e), "close"))}>
                  <Icon name="download" size={12} /> Install {info.update.version}
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="text-[12px] text-faint">This build has no updater signing key, so in-app updates are off. Grab new versions from GitHub Releases.</div>
        )}
        <div className="mt-3 text-[11.5px] text-faint">
          Nook {info.version} · {info.platform} · vault: <span className="selectable">{info.dbPath}</span>
        </div>
      </div>
    </div>
  );
}
