"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/icons";
import { useStore } from "@/lib/store";
import { THEME_IDS, THEMES, isPremiumTheme } from "@/lib/themes";
import { UI_STYLES, UI_STYLE_IDS } from "@/lib/uiStyles";
import { isDesktop, desktopQuit, getMinimizeToTray, setMinimizeToTray } from "@/lib/tauri";

const LABEL = { notes: "Notes", graph: "Graph", canvas: "Canvas", den: "Den", focus: "Focus", arcade: "Arcade", team: "Team room", market: "Marketplace", tasks: "Tasks", activity: "Activity", rules: "Rules", settings: "Settings" } as const;

function fmt(s: number) {
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function Toggle({ on, onClick, label, icon }: { on: boolean; onClick: () => void; label: string; icon: IconName }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-panel2">
      <Icon name={icon} size={16} className="text-dim" />
      <span className="pixel-font flex-1 text-[14px]">{label}</span>
      <span className="relative h-[18px] w-[32px] rounded-full border border-line transition-colors" style={{ background: on ? "var(--accent)" : "var(--panel2)" }}>
        <span className="absolute top-[2px] h-[12px] w-[12px] rounded-full bg-ink transition-all" style={{ left: on ? 16 : 2, background: on ? "var(--accent-ink)" : "var(--dim)" }} />
      </span>
    </button>
  );
}

function AvatarChip() {
  const avatar = useStore((s) => s.profile.avatar);
  const displayName = useStore((s) => s.profile.displayName);
  const hasAccount = useStore((s) => !!s.profile.passHash);
  return (
    <button
      className="relative flex h-8 flex-none items-center gap-1.5 rounded-full border border-line pr-2.5 pl-0.5 transition-all hover:border-[color:var(--accent)]/50"
      onClick={() => useStore.getState().setView("settings")}
      title={displayName ? `${displayName} — profile & settings` : "Set up your profile in Settings"}
      aria-label="Your profile"
    >
      {avatar ? (
        <img src={avatar} alt="" className="h-[26px] w-[26px] rounded-full object-cover" />
      ) : (
        <span className="grid h-[26px] w-[26px] place-items-center rounded-full bg-panel2"><Icon name="user" size={14} className="text-faint" /></span>
      )}
      {displayName && <span className="pixel-font hidden text-[12.5px] text-dim sm:inline">{displayName}</span>}
      {hasAccount && <i className="absolute -right-0.5 -top-0.5 h-[7px] w-[7px] rounded-full" style={{ background: "#7fc48f" }} title="password set" />}
    </button>
  );
}

function DesktopTrayToggle() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!isDesktop) return;
    (async () => {
      try {
        setOn(await getMinimizeToTray());
      } catch {}
    })();
  }, []);
  if (!isDesktop) return null;
  return (
    <Toggle
      on={on}
      onClick={async () => {
        const next = !on;
        setOn(next);
        await setMinimizeToTray(next);
      }}
      label="Minimize to tray"
      icon="monitor"
    />
  );
}

export function TitleBar() {
  const view = useStore((s) => s.view);
  const coins = useStore((s) => s.pet.coins);
  const timer = useStore((s) => s.timer);
  const theme = useStore((s) => s.theme);
  const uiStyle = useStore((s) => s.uiStyle);
  const cleanMode = useStore((s) => s.cleanMode);
  const sidebar = useStore((s) => s.sidebar);
  const notesList = useStore((s) => s.notesList);
  const rightOpen = useStore((s) => s.rightOpen);
  const railPos = useStore((s) => s.railPos);
  const roam = useStore((s) => s.roam);
  const follow = useStore((s) => s.follow);
  const muted = useStore((s) => s.muted);
  const volume = useStore((s) => s.volume);
  const music = useStore((s) => s.music);
  const obsLight = useStore((s) => s.obsLight);
  const appScale = useStore((s) => s.appScale);
  const title = useStore((s) => s.notes.find((n) => n.id === s.activeId)?.title);
  const owned = useStore((s) => s.pet.owned);
  const [menu, setMenu] = useState(false);
  const [layout, setLayout] = useState(false);
  const [grain, setGrain] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const layoutBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const h = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setMenu(false);
    window.addEventListener("pointerdown", h);
    return () => window.removeEventListener("pointerdown", h);
  }, [menu]);

  useEffect(() => {
    if (!layout) return;
    const h = (e: PointerEvent) => !layoutBox.current?.contains(e.target as Node) && setLayout(false);
    window.addEventListener("pointerdown", h);
    return () => window.removeEventListener("pointerdown", h);
  }, [layout]);

  const toggleGrain = () => {
    const next = !grain;
    setGrain(next);
    if (next) delete document.documentElement.dataset.grain;
    else document.documentElement.dataset.grain = "off";
    try {
      const p = JSON.parse(localStorage.getItem("nook:prefs") ?? "{}");
      localStorage.setItem("nook:prefs", JSON.stringify({ ...p, grain: next }));
    } catch {}
  };

  const st = useStore.getState;
  /** open one side thing → automatically leave ultra-clean mode */
  const showSide = (p: Partial<{ sidebar: boolean; notesList: boolean; rightOpen: boolean }>) =>
    st().set({ ...p, ...(cleanMode ? { cleanMode: false } : {}) });

  return (
    <header className="panel flex h-12 flex-none items-center gap-2.5 rounded-[16px] pl-1.5 pr-1.5">
      {/* THE big clean button — first thing on the top bar, toggles every side panel at once */}
      <button
        className="clean-toggle"
        data-on={cleanMode}
        onClick={() => st().toggleClean()}
        title={cleanMode ? "Bring everything back (Ctrl+\\)" : "Ultra clean — hide all the side stuff (Ctrl+\\)"}
        aria-pressed={cleanMode}
      >
        <Icon name={cleanMode ? "layout" : "collapse"} size={16} />
        <span className="pixel-font hidden text-[14px] sm:inline">{cleanMode ? "Show sides" : "Clean"}</span>
      </button>

      {/* layout popover — per-panel toggles + sidebar position + UI style */}
      <div ref={layoutBox} className="relative">
        <button className="icon-btn" data-on={layout} onClick={() => setLayout(!layout)} title="Layout — side panels, sidebar position, UI style">
          <Icon name="layout" size={16} />
        </button>
        {layout && (
          <div className="menu panel panel-solid absolute left-0 top-11 z-[80] w-[268px] p-2" style={{ backdropFilter: "none" }}>
            <div className="label px-3 pb-2 pt-1.5">Show &amp; hide</div>
            <Toggle on={sidebar && !cleanMode} onClick={() => showSide({ sidebar: !sidebar })} label="Sidebar rail" icon="layout" />
            <Toggle on={notesList && !cleanMode} onClick={() => showSide({ notesList: !notesList })} label="Notes list" icon="note" />
            <Toggle on={rightOpen && !cleanMode} onClick={() => showSide({ rightOpen: !rightOpen })} label="Right panel" icon="notebook" />
            <Toggle on={cleanMode} onClick={() => st().toggleClean()} label="Ultra clean (all hidden)" icon="collapse" />
            <div className="my-1 h-px bg-line" />
            <div className="label px-3 pb-2">Sidebar position</div>
            <div className="seg mb-1 w-full px-2 pb-2">
              {(["left", "right", "dock", "float"] as const).map((p) => (
                <button key={p} className="flex-1 justify-center" data-on={railPos === p} onClick={() => { st().setRailPos(p); }} title={`Sidebar: ${p}`}>
                  {p === "left" ? "Left" : p === "right" ? "Right" : p === "dock" ? "Dock" : "Float"}
                </button>
              ))}
            </div>
            <div className="my-1 h-px bg-line" />
            <div className="label px-3 pb-2">UI style</div>
            <div className="grid grid-cols-3 gap-2 px-2 pb-2">
              {UI_STYLE_IDS.map((id) => (
                <button key={id} onClick={() => st().setUiStyle(id)} className="grid gap-1.5" title={UI_STYLES[id].blurb}>
                  <span className="flex h-8 overflow-hidden rounded-[8px] border transition-all" style={{ borderColor: uiStyle === id ? "var(--accent)" : "var(--line)", boxShadow: uiStyle === id ? "0 0 0 2px var(--hl)" : "none" }}>
                    {UI_STYLES[id].ramp.map((c, i) => <i key={i} className="flex-1" style={{ background: c }} />)}
                  </span>
                  <span className="pixel-font text-center text-[11px]" style={{ color: uiStyle === id ? "var(--accent)" : "var(--dim)" }}>{UI_STYLES[id].name}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <button className="flex items-center gap-2" onClick={() => { st().set({ activeId: null }); st().setView("notes"); }} title="Home">
        <Image src="/art/logo.webp" alt="" width={28} height={28} className="pixelated rounded-[8px]" priority />
        <span className="pixel-font text-[19px] font-semibold tracking-wide">Nook</span>
      </button>
      <div className="pixel-font hidden items-center gap-1.5 text-[14px] text-faint md:flex">
        <span>/</span>
        <span className="text-dim">{LABEL[view]}</span>
        {view === "notes" && title && (
          <>
            <span>/</span>
            <span className="max-w-[200px] truncate text-ink">{title}</span>
          </>
        )}
      </div>

      <button
        onClick={() => useStore.setState({ palette: true })}
        className="mx-auto flex h-8 w-full max-w-[420px] items-center gap-2 rounded-[11px] border border-line bg-panel2 px-3 text-faint transition-all hover:border-[color:var(--accent)]/40 hover:text-dim"
      >
        <Icon name="search" size={15} />
        <span className="pixel-font flex-1 truncate text-left text-[14px]"><span className="hidden min-[560px]:inline">Search notes, run commands…</span></span>
        <span className="kbd hidden min-[560px]:inline">CTRL K</span>
      </button>

      {timer.running && (
        <button onClick={() => st().setView("focus")} className="chip" data-on="true" style={{ height: 26 }}>
          <Icon name="hourglass" size={13} />
          {fmt(timer.remaining)}
        </button>
      )}
      <button onClick={() => st().setView("den")} data-coin-counter className="chip" style={{ height: 28, fontSize: 14 }} title="Coins — earn them by writing">
        <Icon name="coins" size={14} style={{ color: "var(--accent)" }} />
        <span key={coins} className="coin-bump">{coins}</span>
      </button>

      <AvatarChip />

      <div ref={box} className="relative">
        <button className="icon-btn" data-on={menu} onClick={() => setMenu(!menu)} title="Appearance">
          <Icon name="sliders" size={17} />
        </button>
        {menu && (
          <div className="menu panel panel-solid absolute right-0 top-11 z-[80] w-[272px] p-2" style={{ backdropFilter: "none" }}>
            <div className="label flex items-center gap-1.5 px-3 pb-2 pt-1.5">UI style · full look
              <button className="ml-auto text-[10px] text-dim underline decoration-dotted hover:text-accent" onClick={() => { setMenu(false); st().setView("settings"); useStore.setState({ settingsSection: "look" }); }}>more in settings</button>
            </div>
            <div className="grid grid-cols-3 gap-2 px-2 pb-2">
              {UI_STYLE_IDS.map((id) => (
                <button key={id} onClick={() => st().setUiStyle(id)} className="grid gap-1.5" title={UI_STYLES[id].blurb}>
                  <span className="flex h-9 overflow-hidden rounded-[10px] border transition-all" style={{ borderColor: uiStyle === id ? "var(--accent)" : "var(--line)", boxShadow: uiStyle === id ? "0 0 0 2px var(--hl)" : "none" }}>
                    {UI_STYLES[id].ramp.map((c, i) => <i key={i} className="flex-1" style={{ background: c }} />)}
                  </span>
                  <span className="pixel-font text-center text-[11.5px]" style={{ color: uiStyle === id ? "var(--accent)" : "var(--dim)" }}>{UI_STYLES[id].name}</span>
                </button>
              ))}
            </div>
            <div className="my-1 h-px bg-line" />
            <div className="label flex items-center gap-1.5 px-3 pb-2 pt-1.5">Theme · tinted monochrome
              <span className="rare-chip ml-auto">3 rare</span>
            </div>
            <div className="grid grid-cols-4 gap-2 px-2 pb-2">
              {THEME_IDS.map((id) => {
                const locked = isPremiumTheme(id) && !owned.includes(id);
                return (
                  <button
                    key={id}
                    onClick={() => st().setTheme(id)}
                    title={locked ? `${THEMES[id].name} — a rare theme, buy it in the Marketplace` : THEMES[id].name}
                    className="group relative grid gap-1.5"
                  >
                    <span className="flex h-9 overflow-hidden rounded-[10px] border transition-all group-hover:-translate-y-0.5" style={{ borderColor: theme === id ? "var(--accent)" : "var(--line)", boxShadow: theme === id ? "0 0 0 2px var(--hl)" : "none" }}>
                      {THEMES[id].ramp.map((c, i) => <i key={i} className="flex-1" style={{ background: c }} />)}
                    </span>
                    <span className="pixel-font text-center text-[11.5px]" style={{ color: theme === id ? "var(--accent)" : "var(--dim)" }}>{THEMES[id].name}</span>
                    {locked && (
                      <span className="absolute right-1 top-1 grid h-[18px] w-[18px] place-items-center rounded-md bg-black/55 text-white/90 backdrop-blur-sm">
                        <Icon name="lock" size={10} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="my-1 h-px bg-line" />
            {uiStyle === "obsidian" && (
              <>
                <div className="label flex items-center gap-1.5 px-3 pb-2 pt-1.5">Obsidian mode
                  <span className="ml-auto flex items-center gap-1">
                    <button className="icon-btn !h-6 !w-6" data-on={!obsLight} onClick={() => st().setObsLight(false)} title="Obsidian dark"><Icon name="moon" size={12} /></button>
                    <button className="icon-btn !h-6 !w-6" data-on={obsLight} onClick={() => st().setObsLight(true)} title="Obsidian light"><Icon name="sun" size={12} /></button>
                  </span>
                </div>
                <div className="my-1 h-px bg-line" />
              </>
            )}
            <div className="flex items-center gap-2 px-3 py-1.5">
              <Icon name="expand" size={14} className="text-dim" />
              <span className="pixel-font flex-1 text-[13.5px]">UI size</span>
              <button className="icon-btn !h-6 !w-6" onClick={() => st().setAppScale(appScale - 0.05)} title="Smaller UI" aria-label="Smaller UI"><Icon name="zoom-out" size={12} /></button>
              <span className="pixel-font w-[42px] text-center text-[12px] tabular-nums text-dim">{Math.round(appScale * 100)}%</span>
              <button className="icon-btn !h-6 !w-6" onClick={() => st().setAppScale(appScale + 0.05)} title="Bigger UI" aria-label="Bigger UI"><Icon name="zoom-in" size={12} /></button>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5">
              <Icon name="coins" size={15} className="text-dim" />
              <span className="pixel-font flex-1 text-[13.5px]">Volume</span>
              <input
                type="range" min={0} max={100} value={Math.round(volume * 100)}
                onChange={(e) => st().set({ volume: Number(e.target.value) / 100 })}
                className="h-1 w-[110px] cursor-pointer appearance-none rounded-full"
                style={{ background: `linear-gradient(90deg, var(--accent) ${volume * 100}%, var(--panel2) ${volume * 100}%)` }}
                aria-label="Sound volume"
              />
            </div>
            <Toggle on={!muted} onClick={() => st().set({ muted: !muted })} label="Sound effects" icon="coins" />
            <Toggle on={music} onClick={() => st().set({ music: !music })} label="Ambient music" icon="gamepad" />
            <DesktopTrayToggle />
            <div className="my-1 h-px bg-line" />
            <Toggle on={grain} onClick={toggleGrain} label="Film grain & textures" icon="sparkle" />
            <Toggle on={roam} onClick={() => st().set({ roam: !roam })} label="Desktop pet" icon="dog" />
            <Toggle on={follow} onClick={() => st().set({ follow: !follow })} label="Pet follows cursor" icon="mouse" />
          </div>
        )}
      </div>

      <div className="mx-0.5 h-5 w-px bg-line" />
      <div className="flex items-center">
        <button className="icon-btn" title="Zen mode (Alt+Z)" onClick={() => useStore.setState((s) => ({ zen: !s.zen }))} style={{ borderRadius: 8, width: 36 }}>
          <Icon name="minus" size={15} />
        </button>
        <button
          className="icon-btn"
          title="Fullscreen"
          style={{ borderRadius: 8, width: 36 }}
          onClick={() => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.())}
        >
          <Icon name="expand" size={14} />
        </button>
        <button
          className="icon-btn hover:!bg-[#a5594f] hover:!text-white"
          title="Close"
          style={{ borderRadius: 8, width: 36 }}
          onClick={() => {
            if (isDesktop()) {
              void desktopQuit();
            } else {
              st().say("Nooo, don't close me! I'll be lonely.");
              st().doAct("sad", 2600);
              st().toast("Nook never really closes — your pet won't let you", "heart");
            }
          }}
        >
          <Icon name="close" size={15} />
        </button>
      </div>
    </header>
  );
}
