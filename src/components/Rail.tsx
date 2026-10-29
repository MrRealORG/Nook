"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/icons";
import { PetView } from "@/components/PetView";
import { onCtx, type CtxItem } from "@/components/ContextMenu";
import { levelOf } from "@/lib/pet";
import { RAIL_DEFAULT_ICONS, RAIL_DEFAULT_ORDER, RAIL_ICON_CHOICES, useStore, type View } from "@/lib/store";

const META: Record<View, { label: string; key: string }> = {
  notes: { label: "Notes", key: "1" },
  graph: { label: "Graph", key: "2" },
  canvas: { label: "Canvas", key: "3" },
  tasks: { label: "Tasks", key: "4" },
  den: { label: "Pet den", key: "5" },
  focus: { label: "Focus", key: "6" },
  arcade: { label: "Arcade", key: "7" },
  team: { label: "Team room", key: "8" },
  market: { label: "Marketplace", key: "9" },
  activity: { label: "Activity", key: "0" },
  rules: { label: "Rules", key: "R" },
  settings: { label: "Settings", key: "-" },
};

export function ShieldChip() {
  const shieldOn = useStore((s) => s.rules.shieldOn);
  const blockedAttempts = useStore((s) => s.blockedAttempts);
  const limited = useStore((s) => Object.keys(s.rules.limits).length + s.rules.blocklist.filter((b) => b.enabled).length);
  if (!shieldOn && limited === 0) return null;
  return (
    <button
      className="rail-btn flex-none"
      data-on={shieldOn}
      onClick={() => useStore.getState().setView("rules")}
      title={shieldOn ? "Shield is up — tap to open Rules" : "You have rules — tap to open"}
      aria-label="Rules status"
    >
      <Icon name={shieldOn ? "shield-on" : "shield"} size={20} style={shieldOn ? { color: "#7fc48f" } : undefined} />
      {blockedAttempts > 0 && <span className="rail-badge" style={{ background: "#e08a6a" }}>{blockedAttempts}</span>}
      <span className="tip">{shieldOn ? "Shield up" : "Rules set"}{blockedAttempts ? ` · ${blockedAttempts} bounced` : ""}</span>
    </button>
  );
}

/** icon picker popover for one rail item (edit mode) */
function IconPicker({ view, onClose }: { view: View; onClose: () => void }) {
  const current = useStore((s) => s.railIcons[view] ?? RAIL_DEFAULT_ICONS[view]);
  const railPos = useStore((s) => s.railPos);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    setTimeout(() => {
      window.addEventListener("pointerdown", onDown);
      window.addEventListener("keydown", onKey);
    }, 10);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const horizontal = railPos === "dock";
  const pos: React.CSSProperties = horizontal
    ? { bottom: 72, left: "50%", transform: "translateX(-50%)", position: "fixed", zIndex: 96 }
    : railPos === "right"
      ? { right: 68, top: 90, position: "fixed", zIndex: 96 }
      : { left: 68, top: 90, position: "fixed", zIndex: 96 };
  return (
    <div ref={ref} className="panel panel-solid pet-chat-pop !flex !w-[248px] flex-col gap-2 p-2.5" style={pos} role="dialog" aria-label={`Icon for ${META[view].label}`}>
      <div className="flex items-center gap-2">
        <span className="pixel-font flex-1 text-[12px]">{META[view].label}</span>
        {view !== "notes" && view !== "settings" && (
          <button className="icon-btn !h-6 !w-6" title={useStore.getState().railHidden.includes(view) ? "Show in sidebar" : "Hide from sidebar"} onClick={() => useStore.getState().toggleRailHidden(view)}>
            <Icon name={useStore.getState().railHidden.includes(view) ? "eye" : "close"} size={12} />
          </button>
        )}
        <button className="icon-btn !h-6 !w-6" title="Move up" onClick={() => useStore.getState().moveRailItem(view, -1)}><Icon name="arrow-up" size={12} /></button>
        <button className="icon-btn !h-6 !w-6" title="Move down" onClick={() => useStore.getState().moveRailItem(view, 1)}><Icon name="arrow-down" size={12} /></button>
      </div>
      <div className="grid grid-cols-6 gap-1">
        {RAIL_ICON_CHOICES.map((ic) => (
          <button
            key={ic}
            className="grid h-8 place-items-center rounded-lg border border-line transition-transform hover:-translate-y-0.5"
            data-on={current === ic}
            onClick={() => { useStore.getState().setRailIcon(view, ic); sfxP(); }}
            title={ic}
          >
            <Icon name={ic} size={15} />
          </button>
        ))}
      </div>
      <button className="btn btn-sm" onClick={() => { useStore.getState().setRailIcon(view, RAIL_DEFAULT_ICONS[view]); }}>
        <Icon name="reload" size={12} /> default icon
      </button>
    </div>
  );
}
function sfxP() {
  import("@/lib/sfx").then((m) => m.sfx("pop"));
}

export function RailButtons({ horizontal }: { horizontal?: boolean }) {
  const view = useStore((s) => s.view);
  const marketUnread = useStore((s) => s.marketUnread);
  const railIcons = useStore((s) => s.railIcons);
  const railOrder = useStore((s) => s.railOrder);
  const railHidden = useStore((s) => s.railHidden);
  const railEdit = useStore((s) => s.railEdit);
  const openTasks = useStore((s) => s.tasks.filter((t) => !t.done).length);
  const [picking, setPicking] = useState<View | null>(null);

  const order = railOrder.length ? RAIL_DEFAULT_ORDER.filter((v) => railOrder.includes(v)).sort((a, b) => railOrder.indexOf(a) - railOrder.indexOf(b)) : RAIL_DEFAULT_ORDER;
  const visible = order.filter((v) => !railHidden.includes(v));

  /** every sidebar tab has its own right-click menu */
  const railMenu = (v: View): CtxItem[] => {
    const hidden = railHidden.includes(v);
    const custom = !!railIcons[v] && railIcons[v] !== RAIL_DEFAULT_ICONS[v];
    return [
      { icon: "external-link", label: `Open ${META[v].label}`, run: () => useStore.getState().setView(v) },
      { sep: true },
      { icon: "palette", label: "Change icon…", run: () => { useStore.setState({ railEdit: true }); setPicking(v); } },
      { icon: "arrow-up", label: "Move up", disabled: order.indexOf(v) <= 0, run: () => useStore.getState().moveRailItem(v, -1) },
      { icon: "arrow-down", label: "Move down", disabled: order.indexOf(v) >= order.length - 1, run: () => useStore.getState().moveRailItem(v, 1) },
      { icon: hidden ? "eye" : "close", label: hidden ? "Show in sidebar" : "Hide from sidebar", disabled: v === "notes", run: () => useStore.getState().toggleRailHidden(v) },
      { icon: "reload", label: "Reset icon", disabled: !custom, run: () => useStore.getState().setRailIcon(v, RAIL_DEFAULT_ICONS[v]) },
      { sep: true },
      { icon: "sliders", label: "Sidebar settings…", run: () => { useStore.getState().setView("settings"); useStore.setState({ settingsSection: "sidebar" }); } },
    ];
  };

  const btn = (v: View, extraBadge?: number) => {
    const icon = railIcons[v] ?? RAIL_DEFAULT_ICONS[v];
    const hidden = railHidden.includes(v);
    return (
      <button
        key={v}
        className="rail-btn"
        style={hidden || (railEdit && railHidden.includes(v)) ? { opacity: 0.38 } : undefined}
        data-on={view === v}
        onClick={() => (railEdit ? setPicking(picking === v ? null : v) : useStore.getState().setView(v))}
        onContextMenu={onCtx(() => railMenu(v), { icon: RAIL_DEFAULT_ICONS[v], title: META[v].label })}
        aria-label={META[v].label + (extraBadge ? ` — ${extraBadge} new` : "")}
      >
        <Icon name={icon} size={22} />
        {!!extraBadge && extraBadge > 0 && !railEdit && (
          <span key={extraBadge} className="rail-badge" style={{ animation: "pop .3s var(--ease-soft) both" }}>
            {extraBadge > 9 ? "9+" : extraBadge}
          </span>
        )}
        {railEdit && hidden && <span className="rail-badge" style={{ background: "var(--faint)" }}>off</span>}
        <span className="tip" style={horizontal ? { display: "none" } : undefined}>
          {META[v].label}
          {extraBadge ? ` · ${extraBadge} new` : ""} <span className="tiny-font ml-1 opacity-60">{railEdit ? "EDIT" : `ALT ${META[v].key}`}</span>
        </span>
      </button>
    );
  };

  const mainViews = visible.filter((v) => v !== "activity" && v !== "rules" && v !== "settings");
  const tailViews = visible.filter((v) => v === "activity" || v === "rules" || v === "settings");

  return (
    <>
      {mainViews.map((v) => btn(v, v === "market" ? marketUnread : v === "tasks" ? openTasks : 0))}
      {tailViews.map((v) => btn(v))}
      <div className={horizontal ? "my-0 mx-1 h-7 w-px flex-none bg-line" : "my-1 h-px w-7 flex-none bg-line"} />
      {!railEdit && <ShieldChip />}
      {railEdit && picking && <IconPicker view={picking} onClose={() => setPicking(null)} />}
    </>
  );
}

export function RailUtilities({ horizontal }: { horizontal?: boolean }) {
  const noticeOpen = useStore((s) => s.noticeOpen);
  const railEdit = useStore((s) => s.railEdit);
  const pet = useStore((s) => s.pet);
  const freshNotices = useStore((s) => s.notices.reduce((a, n) => a + (n.fresh ? 1 : 0), 0));
  const lvl = levelOf(pet.xp).level;
  if (railEdit) {
    return (
      <>
        <button
          className="rail-btn flex-none"
          data-on={railEdit}
          onClick={() => useStore.setState({ railEdit: false })}
          title="Done customizing"
          aria-label="Customize sidebar"
        >
          <Icon name="check" size={20} />
          <span className="tip">Done — save layout</span>
        </button>
        <button className="rail-btn flex-none" onClick={() => useStore.getState().resetRail()} title="Reset to the default layout" aria-label="Reset sidebar">
          <Icon name="reload" size={20} />
          <span className="tip">Reset to default</span>
        </button>
      </>
    );
  }
  return (
    <>
      <button
        className="rail-btn flex-none"
        data-on={noticeOpen}
        onClick={() => useStore.setState((s) => ({ noticeOpen: !s.noticeOpen }))}
        aria-label={`Notifications${freshNotices > 0 ? ` — ${freshNotices} new` : ""}`}
      >
        <Icon name="bell" size={22} />
        {freshNotices > 0 && (
          <span key={freshNotices} className="rail-badge" style={{ animation: "pop .3s var(--ease-soft) both" }}>
            {freshNotices > 9 ? "9+" : freshNotices}
          </span>
        )}
        <span className="tip" style={horizontal ? { display: "none" } : undefined}>Notifications{freshNotices > 0 ? ` · ${freshNotices} new` : ""}</span>
      </button>
      <button
        className="rail-btn flex-none"
        onClick={() => useStore.setState({ notesDrawer: true })}
        aria-label="All notes drawer"
      >
        <Icon name="library" size={22} />
        <span className="tip" style={horizontal ? { display: "none" } : undefined}>All notes drawer</span>
      </button>
      <button
        className="rail-btn flex-none"
        data-on={!!useStore.getState().quickChat}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          useStore.getState().openQuickChat("rail", r.right, r.top);
        }}
        aria-label="Quick chat with pet"
      >
        <Icon name="sparkles" size={22} />
        <span className="tip" style={horizontal ? { display: "none" } : undefined}>Quick chat with {pet.name}</span>
      </button>
      <button
        className="relative grid flex-none place-items-center overflow-hidden rounded-2xl transition-transform hover:-translate-y-0.5"
        onClick={() => useStore.getState().setView("den")}
        onContextMenu={onCtx(() => {
          const s = useStore.getState();
          return [
            { icon: "dog", label: `Open ${s.pet.name}'s den`, run: () => s.setView("den") },
            { icon: "message-text", label: "Quick chat", run: () => s.openQuickChat("rail", window.innerWidth - 100, window.innerHeight - 200) },
            { sep: true },
            { icon: "mouse", label: s.follow ? "Stop following cursor" : "Follow my cursor", run: () => s.set({ follow: !s.follow }) },
            { icon: "moon", label: s.roam ? "Stop roaming" : "Let it roam", run: () => s.set({ roam: !s.roam }) },
          ];
        }, { title: `${pet.name} · level ${lvl}` })}
        title={`${pet.name} · level ${lvl}`}
      >
        <div className={horizontal ? "grid h-[44px] w-[46px] place-items-end justify-center overflow-hidden" : "grid h-[54px] w-[50px] place-items-end justify-center overflow-hidden"}>
          <PetView species={pet.species} tint={pet.look} hat={pet.hat} scale={horizontal ? 1.35 : 1.7} fps={8} style={{ marginBottom: -5 }} />
        </div>
        <span className="tiny-font absolute -right-0.5 top-0 rounded-md bg-accent px-1 py-px text-[9px] text-accent-ink">L{lvl}</span>
      </button>
    </>
  );
}

/** floating sidebar pill — drag the grip to park it anywhere on screen */
export function FloatRail() {
  const railFloat = useStore((s) => s.railFloat);
  const railEdit = useStore((s) => s.railEdit);
  const wrap = useRef<HTMLDivElement>(null);
  const drag = useRef({ on: false, dx: 0, dy: 0 });
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!drag.current.on) return;
      const x = Math.min(window.innerWidth - 74, Math.max(6, e.clientX - drag.current.dx));
      const y = Math.min(window.innerHeight - 60, Math.max(6, e.clientY - drag.current.dy));
      useStore.getState().setRailFloat(x, y);
    };
    const onUp = () => {
      if (drag.current.on) {
        drag.current.on = false;
        setDragging(false);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  const x = Math.min(Math.max(railFloat.x, 6), Math.max(6, window.innerWidth - 74));
  const y = Math.min(Math.max(railFloat.y, 6), Math.max(6, window.innerHeight - 60));

  return (
    <div
      ref={wrap}
      className="panel scroll fixed z-[70] flex w-[62px] flex-col items-center gap-1.5 rounded-[18px] py-2.5"
      style={{ left: x, top: y, maxHeight: "calc(100vh - 24px)", touchAction: dragging ? "none" : undefined, boxShadow: dragging ? "0 12px 32px rgba(0,0,0,.4)" : undefined }}
      data-rail-edit={railEdit}
    >
      <button
        className="icon-btn !h-5 !w-5 cursor-grab active:cursor-grabbing"
        title="Drag to move the sidebar anywhere"
        aria-label="Drag sidebar"
        onPointerDown={(e) => {
          const r = wrap.current!.getBoundingClientRect();
          drag.current = { on: true, dx: e.clientX - r.left, dy: e.clientY - r.top };
          setDragging(true);
        }}
      >
        <Icon name="arrows-horizontal" size={12} />
      </button>
      <RailButtons />
      <div className="my-0.5 h-px w-7 flex-none bg-line" />
      <RailUtilities />
    </div>
  );
}

/** bottom dock (macOS-style horizontal sidebar) */
export function DockRail() {
  const railEdit = useStore((s) => s.railEdit);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[70] flex justify-center pb-1.5">
      <nav
        className="panel pointer-events-auto flex max-w-[96vw] items-center gap-1 overflow-x-auto rounded-[18px] px-2.5 py-1.5"
        data-rail-edit={railEdit}
        aria-label="Sidebar dock"
      >
        <RailButtons horizontal />
        <div className="mx-0.5 h-7 w-px flex-none bg-line" />
        <RailUtilities horizontal />
      </nav>
    </div>
  );
}

export function Rail() {
  const railEdit = useStore((s) => s.railEdit);
  return (
    <nav className="panel scroll flex w-[62px] flex-none flex-col items-center gap-1.5 rounded-[18px] py-3" data-rail-edit={railEdit}>
      <RailButtons />
      <div className="my-1 h-px w-7 flex-none bg-line" />
      <RailUtilities />
    </nav>
  );
}
