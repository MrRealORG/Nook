import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@/globals.css";
import "@/desktop.css";
import "@/clean.css";
import "@/pixel.css";
import { installApiShim } from "@/lib/apiShim";
import { installDesktopGlue } from "@/lib/platform";
import { installPower } from "@/lib/power";
import type { InitialData } from "@/lib/types";
import { appReady, localOnboarded, preloaded } from "@/lib/boot";
import { installLogger, push } from "@/lib/logger";

installApiShim();
installDesktopGlue();
installPower();
// 1.3.1: global error / unhandled-rejection capture from the very first line (it also mirrors
// to the desktop log file), not only once the app shell mounted
installLogger();
// E2E handle: load the speech-to-text module on demand (feeds real audio without a mic)
(window as unknown as Record<string, unknown>).__nookLoadAsr = () => import("@/lib/asr");
(window as unknown as Record<string, unknown>).__nookLoadUpdater = () => import("@/lib/updater");
// decided synchronously, before React renders anything: fresh profile → onboarding first
const needsOnboardingLocal = !localOnboarded();
// fetch the onboarding chunk in parallel with the app chunk so its first paint has no gap
const onboardingChunk = needsOnboardingLocal ? import("@/components/Onboarding") : null;

function Boot() {
  const [data, setData] = useState<InitialData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [App, setApp] = useState<null | ((p: { initial: InitialData }) => React.ReactNode)>(null);
  useEffect(() => {
    let alive = true;
    const load = async (attempt = 0): Promise<void> => {
      try {
        const [r, mod] = await Promise.all([fetch("/api/bootstrap"), import("@/components/App")]);
        if (!r.ok) throw new Error(`bootstrap HTTP ${r.status}`);
        const j = (await r.json()) as InitialData;
        if (!alive) return;
        // server says onboarding is done (e.g. a wiped WebView2 profile): trust it and mirror it
        const serverDone = j.ui?.onboarded === true;
        const needsOnboarding = needsOnboardingLocal && !serverDone;
        const { useStore } = await import("@/lib/store");
        if (needsOnboarding) {
          try {
            preloaded.Onboarding = (await onboardingChunk!).default;
          } catch (e) {
            push("error", `onboarding failed to load: ${e instanceof Error ? e.message : String(e)}`, "boot");
          }
          useStore.setState({ onboarded: false, onboardingOpen: !!preloaded.Onboarding });
        } else {
          if (needsOnboardingLocal) {
            try {
              localStorage.setItem("nook:onboarded", "1");
              const p = JSON.parse(localStorage.getItem("nook:prefs") || "{}");
              localStorage.setItem("nook:prefs", JSON.stringify({ ...p, onboarded: true }));
            } catch {}
          }
          useStore.setState({ onboarded: true, onboardingOpen: false });
        }
        setApp(() => mod.App);
        setData(j);
        // desktop glue (tray, deep links, updater…) after the first paint
        setTimeout(() => void import("@/lib/desktop").then((d) => d.initDesktop()).catch(() => {}), 50);
      } catch (e) {
        if (attempt < 20) return void setTimeout(() => void load(attempt + 1), 400);
        setErr(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (err || (data && App)) appReady();
  }, [err, data, App]);
  if (err)
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div>
          <div className="pixel-font text-[20px]">Nook couldn't open your vault</div>
          <div className="mt-2 text-[13px] text-dim">{err}</div>
          <button className="btn mt-4" onClick={() => location.reload()}>Try again</button>
        </div>
      </div>
    );
  if (!data || !App)
    return (
      <div className="grid h-full place-items-center">
        <div className="pixel-font text-dim shimmer rounded-xl px-5 py-3">loading…</div>
      </div>
    );
  return <App initial={data} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Boot />
  </StrictMode>,
);
