/** Settings → Performance & widget: low-power mode, the optional background CPU limit, desktop-widget tiles. */
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { refreshDesktopInfo, setDesktopSettings, useDesktopInfo } from "@/lib/desktop";
import { isTauri } from "@/lib/platform";
import { isLowPower, onPowerChange, setLowPower } from "@/lib/power";
import { useStore } from "@/lib/store";
import { moveTile, readWidgetCfg, TILE_LABEL, writeWidgetCfg, type WidgetCfg } from "@/widget/config";

const CAP_KEY = "nook:cpuCap";

export function PerformanceSection() {
  const info = useDesktopInfo();
  const [low, setLow] = useState(isLowPower);
  useEffect(() => onPowerChange(() => setLow(isLowPower())), []);
  // the cap lives in the desktop settings; the browser build mirrors it locally so the UI works
  const [cap, setCap] = useState<number>(() => (isTauri ? info.settings.cpuCap : Number(JSON.parse(localStorage.getItem(CAP_KEY) ?? "{}").cap) || 10));
  const [capOn, setCapOn] = useState<boolean>(() => (isTauri ? info.settings.cpuCapOn : JSON.parse(localStorage.getItem(CAP_KEY) ?? "{}").on === true));
  const [w, setW] = useState<WidgetCfg>(readWidgetCfg);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (isTauri) void refreshDesktopInfo();
  }, []);
  useEffect(() => {
    if (!isTauri || !info.ready) return;
    setCap(info.settings.cpuCap);
    setCapOn(info.settings.cpuCapOn);
  }, [info.ready, info.settings.cpuCap, info.settings.cpuCapOn]);

  const saveCap = async (pct: number, on: boolean) => {
    const v = Math.max(5, Math.min(50, Math.round(pct)));
    setCap(v);
    setCapOn(on);
    localStorage.setItem(CAP_KEY, JSON.stringify({ cap: v, on }));
    if (isTauri) {
      try {
        await setDesktopSettings({ cpuCap: v, cpuCapOn: on });
      } catch (e) {
        useStore.getState().toast(`Could not apply the background CPU limit: ${e}`, "close");
      }
    }
  };
  const saveW = (next: WidgetCfg) => {
    setW(next);
    writeWidgetCfg(next);
  };
  const perf = info.perf;

  return (
    <div className="space-y-4" data-testid="perf-settings">
      <div className="paper p-4">
        <div className="label pb-2">Performance</div>
        <label className="flex items-start gap-3 py-1.5 text-[13px]">
          <input type="checkbox" className="mt-1" checked={low} onChange={(e) => setLowPower(e.target.checked)} aria-label="Low-power mode" data-testid="low-power" />
          <span>
            <span className="block font-medium">Low-power mode <span className="text-faint">(recommended)</span></span>
            <span className="block text-[12px] text-faint">Turns off decorative motion: roaming pet, idle animations, blur and grain. Everything else works the same.</span>
          </span>
        </label>
        <div className="mt-3 border-t border-line pt-3">
          <label className="flex items-center gap-3 text-[13px]">
            <input type="checkbox" checked={capOn} onChange={(e) => void saveCap(cap, e.target.checked)} aria-label="Limit Nook's CPU" data-testid="cpu-cap-on" />
            <span className="flex-1">
              <span className="block font-medium">Limit CPU in the background <span className="text-faint">(optional)</span></span>
              <span className="block text-[12px] text-faint">Off by default. Only applies while Nook is hidden or minimised — never while you're using it.</span>
            </span>
            <b className="tabular-nums" data-testid="cpu-cap-value">{capOn ? `${cap}%` : "off"}</b>
          </label>
          <input
            type="range"
            min={5}
            max={50}
            step={1}
            value={cap}
            disabled={!capOn}
            onChange={(e) => {
              const v = Number(e.target.value);
              setCap(v);
              // apply once the slider settles (one desktop call, not one per pixel)
              if (debounce.current) clearTimeout(debounce.current);
              debounce.current = setTimeout(() => void saveCap(v, capOn), 250);
            }}
            className="mt-2 w-full accent-[var(--accent)]"
            aria-label="Background CPU limit percent"
            data-testid="cpu-cap"
          />
          <div className="flex justify-between text-[11px] text-faint"><span>5%</span><span>default 10%</span><span>50%</span></div>
          <div className="mt-2 text-[12px] text-faint">
            When on, Windows limits Nook and its WebView2 processes together to this share of the whole machine — but only while Nook is in the background. As soon as you bring Nook back, the limit lifts so nothing feels slow. Nook also runs at below-normal priority and in efficiency mode while hidden, with or without this.
            {isTauri && perf && (
              <span className="mt-1 block" data-testid="cpu-cap-status">
                {perf.supported ? (perf.error ? `Not available — ${perf.error}` : !capOn || !perf.capPct ? "Off" : perf.applied ? `Limiting now (Nook is in the background) · ${perf.childrenInJob} child process${perf.childrenInJob === 1 ? "" : "es"} covered` : "On · waits until Nook is in the background") : "Not supported on this OS"}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="paper p-4" data-testid="widget-tiles">
        <div className="label pb-2">Desktop widget tiles</div>
        <div className="grid gap-1">
          {w.tiles.map((t, i) => (
            <div key={t.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-panel2">
              <input type="checkbox" checked={t.on} onChange={(e) => saveW({ ...w, tiles: w.tiles.map((x) => (x.id === t.id ? { ...x, on: e.target.checked } : x)) })} aria-label={`Show ${TILE_LABEL[t.id]}`} />
              <span className="flex-1 text-[13px]">{TILE_LABEL[t.id]}</span>
              <button className="icon-btn !h-7 !w-7" disabled={i === 0} aria-label={`Move ${TILE_LABEL[t.id]} up`} onClick={() => saveW(moveTile(w, t.id, -1))}><Icon name="arrow-up" size={13} /></button>
              <button className="icon-btn !h-7 !w-7" disabled={i === w.tiles.length - 1} aria-label={`Move ${TILE_LABEL[t.id]} down`} onClick={() => saveW(moveTile(w, t.id, 1))}><Icon name="arrow-down" size={13} /></button>
            </div>
          ))}
        </div>
        <label className="mt-3 flex items-center gap-3 text-[13px]">
          <span className="w-24">Opacity</span>
          <input type="range" min={60} max={100} value={Math.round(w.opacity * 100)} onChange={(e) => saveW({ ...w, opacity: Number(e.target.value) / 100 })} className="flex-1 accent-[var(--accent)]" aria-label="Widget opacity" />
          <span className="w-10 text-right tabular-nums">{Math.round(w.opacity * 100)}%</span>
        </label>
        {isTauri && (
          <label className="mt-2 flex items-center gap-3 text-[13px]">
            <input type="checkbox" checked={info.settings.widgetOnTop} onChange={(e) => void setDesktopSettings({ widgetOnTop: e.target.checked })} aria-label="Keep the widget on top" />
            <span>Keep the widget above other windows</span>
          </label>
        )}
      </div>
    </div>
  );
}
