/**
 * v1.4 Rules: the real Shield engine (Rust background tracker) — warning banner, what to do on a
 * hit (minimise / close / kill apps, close tab / minimise browser for sites), the opt-in hosts
 * file, and live engine status from `GET /api/shield` (+ `nook://shield-*` events).
 */
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { subscribe } from "@/lib/events";
import { everyActive } from "@/lib/power";
import { useStore } from "@/lib/store";
import type { AppAction, SiteAction } from "@/lib/rules";

export type ShieldStatus = {
  on: boolean;
  active: boolean;
  hasRules: boolean;
  running: boolean;
  enforces: boolean;
  bouncedToday: number;
  lastEvent: { type: string; app?: string; domain?: string | null; reason?: string; action?: string; done?: boolean; text?: string; at?: number } | null;
  hosts: string;
  usage: Record<string, number>;
  trackerPaused: boolean;
};

const APP_ACTIONS: { id: AppAction; label: string; hint: string }[] = [
  { id: "minimize", label: "Minimise", hint: "Safe: the window is minimised, nothing is lost" },
  { id: "close", label: "Close window", hint: "Asks the app to close (it may prompt to save)" },
  { id: "kill", label: "Kill process", hint: "Ends the process at once — unsaved work is lost" },
];
const SITE_ACTIONS: { id: SiteAction; label: string; hint: string }[] = [
  { id: "close-tab", label: "Close the tab", hint: "Sends Ctrl+W to the browser — only that tab closes" },
  { id: "minimize", label: "Minimise browser", hint: "Minimises the whole browser window" },
];

export function engineState(s: ShieldStatus | null): { tone: "ok" | "warn" | "off"; text: string } {
  if (!s) return { tone: "off", text: "Checking the engine…" };
  if (!s.running) return { tone: "warn", text: "Engine not running — the background tracker hasn't started (Timelens disabled?)" };
  if (!s.on) return { tone: "off", text: "Shield is down — rules are tracked, not enforced" };
  if (s.trackerPaused) return { tone: "warn", text: "Timelens is paused — the Shield can't see the foreground app" };
  if (!s.hasRules) return { tone: "warn", text: "Shield is up but there are no rules yet — add a blocked site, a limit or quiet hours" };
  if (!s.enforces) return { tone: "warn", text: "Rules are checked, but enforcement (minimise / close / kill) only works in the Windows app" };
  return { tone: "ok", text: "Engine running — rules are enforced in the background" };
}

export function ShieldEngine() {
  const rules = useStore((s) => s.rules);
  const st = useStore.getState;
  const [status, setStatus] = useState<ShieldStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      fetch("/api/shield")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((s: ShieldStatus) => {
          setStatus(s);
          setErr(null);
        })
        .catch((e: Error) => setErr(e.message));
    void load();
    const stop = everyActive(load, 10_000);
    const off = subscribe({
      "nook://shield-bounce": () => void load(),
      "nook://shield-nudge": () => void load(),
    });
    return () => {
      stop();
      off();
    };
  }, [rules]);

  const e = engineState(status);
  const tone = e.tone === "ok" ? "#2fa36b" : e.tone === "warn" ? "#d08a2a" : "var(--faint)";
  const last = status?.lastEvent;
  return (
    <div className="mt-3 grid gap-3" data-testid="shield-engine">
      {rules.shieldOn && (
        <div className="shield-banner" role="alert" data-testid="shield-banner">
          <Icon name="alert" size={16} />
          <div>
            <b>Shield is on.</b> When a rule fires, Nook acts on the window in the foreground:{" "}
            apps are <b>{APP_ACTIONS.find((a) => a.id === rules.appAction)?.label.toLowerCase()}</b>, sites get <b>{SITE_ACTIONS.find((a) => a.id === rules.siteAction)?.label.toLowerCase()}</b>.
            {rules.appAction === "kill" && " Killing a process loses unsaved work."} Nook, Explorer and Task Manager are never touched.
          </div>
        </div>
      )}
      <div className="paper p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="tl-dot" style={{ background: tone }} />
          <b className="text-[13.5px]" data-testid="shield-engine-status">{err ? `Engine status unavailable (${err})` : e.text}</b>
          <div className="flex-1" />
          {status && <span className="chip !text-[11px]">{status.bouncedToday} bounced today</span>}
        </div>
        {last && (
          <div className="mt-2 text-[12px] text-dim" data-testid="shield-last">
            Last: {last.text ?? `${last.type} ${last.app ?? ""}`}
            {last.at ? ` · ${new Date(last.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}
            {last.done === false && " · could not act (window protected or gone)"}
          </div>
        )}
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <fieldset>
            <legend className="mb-1.5 text-[12px] font-semibold text-faint">When an app breaks a rule</legend>
            <div className="grid gap-1">
              {APP_ACTIONS.map((a) => (
                <label key={a.id} className="shield-opt" data-on={rules.appAction === a.id}>
                  <input type="radio" name="appAction" checked={rules.appAction === a.id} onChange={() => st().setRules({ appAction: a.id })} />
                  <span><b>{a.label}</b><span className="block text-[11.5px] text-faint">{a.hint}</span></span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend className="mb-1.5 text-[12px] font-semibold text-faint">When a website breaks a rule</legend>
            <div className="grid gap-1">
              {SITE_ACTIONS.map((a) => (
                <label key={a.id} className="shield-opt" data-on={rules.siteAction === a.id}>
                  <input type="radio" name="siteAction" checked={rules.siteAction === a.id} onChange={() => st().setRules({ siteAction: a.id })} />
                  <span><b>{a.label}</b><span className="block text-[11.5px] text-faint">{a.hint}</span></span>
                </label>
              ))}
            </div>
            <label className="shield-opt mt-2" data-on={rules.hostsFile}>
              <input type="checkbox" checked={rules.hostsFile} onChange={(ev) => st().setRules({ hostsFile: ev.target.checked })} data-testid="shield-hosts" />
              <span>
                <b>Also block in the hosts file</b>
                <span className="block text-[11.5px] text-faint">Blocked domains stop loading in every browser. Needs Nook to run as administrator once.{status?.hosts ? ` Status: ${status.hosts}` : ""}</span>
              </span>
            </label>
          </fieldset>
        </div>
      </div>
    </div>
  );
}
