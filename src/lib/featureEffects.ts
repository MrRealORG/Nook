/**
 * Background side of the feature switches: stop/start the work a feature owns.
 * Loaded lazily (only when a switch flips, or once at boot when something is off).
 */
import type { FeatureId, Features } from "@/lib/features";
import { startMarketWatcher, stopMarketWatcher } from "@/lib/marketWatch";
import { isTauri } from "@/lib/platform";

const send = (url: string, method: string, body: unknown) =>
  fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);

export async function applyFeature(id: FeatureId, on: boolean): Promise<void> {
  switch (id) {
    case "timelens":
      // the Rust sampler thread sleeps while Timelens is disabled — zero sampling cost
      await send("/api/timelens/config", "PATCH", { enabled: on });
      break;
    case "market":
      if (on) startMarketWatcher();
      else stopMarketWatcher();
      break;
    case "widget":
      if (!on && isTauri) {
        const { setDesktopSettings } = await import("@/lib/desktop");
        await setDesktopSettings({ widget: false });
      }
      break;
    default:
      break;
  }
  // the widget window reads the shared prefs; nudge it to re-read its tiles
  try {
    window.dispatchEvent(new CustomEvent("nook-widget-cfg"));
    if (isTauri) {
      const { broadcast } = await import("@/lib/desktop");
      broadcast("data-changed", { source: "features" });
    }
  } catch {}
}

/** mirror the switches into the vault so Rust's background loops (reminders, backups, Timelens
 *  maintenance) skip what is off */
export async function syncFeatures(f: Features): Promise<void> {
  await send("/api/features", "PUT", f);
}

/** boot: make the background state match the saved switches (only the ones that are off) */
export async function applyFeaturesAtBoot(f: Features): Promise<void> {
  const off = (Object.keys(f) as FeatureId[]).filter((id) => f[id] === false);
  if (!off.length) return;
  await syncFeatures(f);
  for (const id of off) await applyFeature(id, false);
}
