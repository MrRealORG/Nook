"use client";

import { useMemo, useSyncExternalStore } from "react";
import { Icon } from "@/components/Icon";
import { errorCount, subscribe } from "@/lib/logger";
import { levelOf } from "@/lib/pet";
import { useStore } from "@/lib/store";
import { parseNote } from "@/lib/util";

export function StatusBar() {
  const saving = useStore((s) => s.saving);
  const note = useStore((s) => (s.view === "notes" ? s.notes.find((n) => n.id === s.activeId) : undefined));
  const count = useStore((s) => s.notes.length);
  const pet = useStore((s) => s.pet);
  const streak = useStore((s) => s.streak);
  const shieldOn = useStore((s) => s.rules.shieldOn);
  const dnd = useStore((s) => s.dnd);
  const unread = useStore((s) => s.notices.filter((n) => n.fresh).length);
  const errs = useSyncExternalStore(
    (cb) => subscribe(cb),
    () => errorCount,
    () => 0,
  );
  const meta = useMemo(() => (note ? parseNote(note.content) : null), [note]);
  const { level, pct } = levelOf(pet.xp);
  return (
    <footer className="pixel-font flex h-[30px] flex-none items-center gap-4 px-4 text-[13px] text-dim">
      <span className="flex items-center gap-1.5">
        <i className="inline-block h-[7px] w-[7px]" style={{ background: saving ? "var(--accent)" : "var(--faint)", boxShadow: saving ? "0 0 8px var(--accent)" : "none", animation: saving ? "pulseRing 1s infinite" : undefined }} />
        {saving ? "Saving…" : "Saved"}
      </span>
      {meta ? (
        <span>{meta.words} words · {Math.max(1, Math.round(meta.words / 220))} min read</span>
      ) : (
        <span>{count} notes</span>
      )}
      <span className="flex-1" />
      <span className="hidden items-center gap-1.5 sm:flex" title={shieldOn ? "Shield is up — your rules are enforced" : "Rules are set but the shield is down"} style={shieldOn ? { color: "#7fc48f" } : undefined}>
        <Icon name={shieldOn ? "shield-on" : "shield"} size={12} />
        {shieldOn ? "shield" : ""}
      </span>
      {dnd && (
        <span className="hidden items-center gap-1.5 sm:flex" title="Do not disturb — popups muted, bell keeps recording" style={{ color: "#b59fd0" }}>
          <Icon name="moon" size={12} /> dnd
        </span>
      )}
      <button
        className="flex items-center gap-1.5"
        title={`${errs} error${errs === 1 ? "" : "s"} this session — open Logs & Bugs to report problems`}
        onClick={() => useStore.setState({ bugOpen: true, bugTab: errs > 0 ? "logs" : "report" })}
        style={errs > 0 ? { color: "#e0684f" } : undefined}
      >
        <Icon name="bug" size={12} />
        {errs > 0 && <span>{errs}</span>}
      </button>
      <button
        className="hidden items-center gap-1.5 sm:flex"
        title={`${unread} unread notifications — open the bell inbox`}
        onClick={() => useStore.setState({ noticeOpen: true })}
      >
        <Icon name="bell" size={12} className={unread ? "text-accent" : undefined} />
        {unread > 0 && <span className="text-accent">{unread}</span>}
      </button>
      <span className="hidden items-center gap-1.5 sm:flex" title={`${streak.count}-day streak · best ${streak.best}`}>
        <Icon name="fire" size={12} className="text-accent" />
        {streak.count}d streak
      </span>
      <span className="hidden items-center gap-1.5 sm:flex">
        <Icon name="sparkle" size={12} />
        local brain
      </span>
      <span className="flex items-center gap-2">
        {pet.name} · Lv {level}
        <span className="relative h-[6px] w-[64px] overflow-hidden rounded-full bg-panel2">
          <i className="absolute inset-y-0 left-0 bg-accent transition-all duration-700" style={{ width: `${pct * 100}%` }} />
        </span>
      </span>
    </footer>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed right-5 top-[68px] z-[95] flex flex-col items-end gap-2">
      {toasts.map((t) => (
        <div key={t.id} className="toast panel panel-solid pixel-font flex items-center gap-2.5 rounded-[14px] px-3.5 py-2.5 text-[14px]" style={{ backdropFilter: "none" }}>
          <Icon name={t.icon} size={16} style={{ color: "var(--accent)" }} />
          {t.text}
        </div>
      ))}
    </div>
  );
}
