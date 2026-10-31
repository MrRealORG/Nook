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

installApiShim();
installDesktopGlue();
installPower();

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
        setApp(() => mod.App);
        setData(j);
        void import("@/lib/desktop").then((d) => d.initDesktop());
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
