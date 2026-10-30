
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/icons";
import { useStore, type Notice } from "@/lib/store";
import { timeAgo } from "@/lib/util";

const KIND_META: Record<string, { label: string; tint: string }> = {
  sale: { label: "sales", tint: "#e0a84f" },
  achievement: { label: "awards", tint: "#d8a8b8" },
  quest: { label: "quests", tint: "#8fbfae" },
  level: { label: "levels", tint: "#e8853c" },
  task: { label: "tasks", tint: "#9db7d0" },
  pet: { label: "pet", tint: "#cba5ba" },
  info: { label: "nook", tint: "var(--dim)" },
};
type Filter = "all" | keyof typeof KIND_META;

/** where a notification row navigates when clicked (null = stay) */
function jumpFor(kind: string): string | null {
  if (kind === "sale") return "market";
  if (kind === "quest" || kind === "task") return "tasks";
  if (kind === "level" || kind === "pet") return "den";
  return null;
}

/** The bell inbox — a scrollable, filterable, searchable history of achievements, sales,
 *  quests, pet events and milestones, with do-not-disturb and per-kind controls. */
export function NotificationCenter() {
  const open = useStore((s) => s.noticeOpen);
  const notices = useStore((s) => s.notices);
  const questStreak = useStore((s) => s.questStreak);
  const dnd = useStore((s) => s.dnd);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const st = useStore.getState;

  // opening the panel marks everything as read (after a beat so fresh dots are visible)
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => st().markNoticesRead(), 900);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && useStore.setState({ noticeOpen: false });
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, st]);

  const unread = useMemo(() => notices.filter((n) => n.fresh).length, [notices]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: notices.length };
    for (const n of notices) c[n.kind] = (c[n.kind] ?? 0) + 1;
    return c;
  }, [notices]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return notices
      .filter((n) => (filter === "all" || n.kind === filter) && (!needle || n.text.toLowerCase().includes(needle)))
      .slice(0, 40);
  }, [notices, filter, q]);
  const filterFresh = useMemo(() => shown.filter((n) => n.fresh).length, [shown]);
  if (!open) return null;

  return (
    <>
      {/* click-away layer */}
      <div className="fixed inset-0 z-[90]" onPointerDown={() => useStore.setState({ noticeOpen: false })} aria-hidden />
      <aside
        className="notice-panel panel panel-solid flex flex-col overflow-hidden rounded-[18px]"
        role="dialog"
        aria-label="Notification center"
        style={{ animation: "pop .24s var(--ease-soft) both", backdropFilter: "none" }}
      >
        <header className="flex flex-none items-center gap-2 border-b border-line px-4 py-3">
          <Icon name="bell" size={15} className="text-accent" />
          <span className="label !text-[11px]">Notifications</span>
          {unread > 0 && <span className="chip" data-on="true">{unread} new</span>}
          {questStreak.count > 0 && (
            <span className="chip" title={`Perfect-day streak best: ${questStreak.best}`}>
              <Icon name="fire" size={11} className="text-accent" /> {questStreak.count} perfect {questStreak.count === 1 ? "day" : "days"}
            </span>
          )}
          <span className="flex-1" />
          <button
            className="icon-btn !h-6 !w-6 !rounded-md"
            data-on={dnd}
            onClick={() => {
              st().set({ dnd: !dnd });
              sfxSafe();
            }}
            title={dnd ? "Do not disturb is ON — click to allow popups again" : "Do not disturb — mute popups, the bell keeps recording"}
            aria-label="Toggle do not disturb"
          >
            <Icon name={dnd ? "moon" : "bell"} size={12} />
          </button>
          {notices.length > 0 && (
            <button className="icon-btn !h-6 !w-6 !rounded-md" onClick={() => st().clearNotices()} title="Clear all notifications" aria-label="Clear all notifications">
              <Icon name="trash" size={12} />
            </button>
          )}
          <button className="icon-btn !h-6 !w-6 !rounded-md" onClick={() => useStore.setState({ noticeOpen: false })} title="Close" aria-label="Close notifications">
            <Icon name="close" size={13} />
          </button>
        </header>

        <div className="flex flex-none flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
          {(["all", "sale", "achievement", "quest", "level", "task", "pet", "info"] as Filter[]).map((f) => {
            const n = counts[f] ?? 0;
            if (f !== "all" && n === 0) return null;
            return (
              <button key={f} className="chip !normal-case !tracking-normal" data-on={filter === f} onClick={() => setFilter(f)} title={`Show ${f === "all" ? "everything" : KIND_META[f].label}`}>
                {f === "all" ? "all" : KIND_META[f].label} · {n}
              </button>
            );
          })}
          <span className="flex-1" />
          <input
            className="input !h-7 !w-[110px] !py-0 !text-[12px]"
            placeholder="search…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search notifications"
          />
          {filterFresh > 0 && (
            <button
              className="chip !normal-case !tracking-normal text-accent"
              onClick={() => st().markNoticesReadKind(filter as Notice["kind"] | "all")}
              title={`Mark ${filterFresh} ${filter === "all" ? "notice" : KIND_META[filter].label} ${filterFresh === 1 ? "row" : "rows"} as read`}
            >
              <Icon name="check-double" size={11} /> mark {filterFresh} read
            </button>
          )}
        </div>

        <div ref={listRef} className="scroll max-h-[380px] min-h-0 flex-1 overflow-y-auto p-2">
          {notices.length === 0 ? (
            <div className="grid place-items-center gap-2 px-6 py-10 text-center">
              <Icon name="bell" size={26} className="text-faint" />
              <div className="pixel-font text-[14px] text-ink">All quiet in the nook</div>
              <div className="text-[12px] text-faint">
                Achievements, marketplace sales, quest rewards and milestones will collect here.
              </div>
            </div>
          ) : shown.length === 0 ? (
            <div className="grid place-items-center gap-1.5 px-6 py-8 text-center">
              <Icon name={filter === "all" ? "check" : "bell"} size={22} className="text-faint" />
              <div className="pixel-font text-[13px] text-dim">no {KIND_META[filter]?.label ?? "matching"} notices</div>
              <div className="text-[11.5px] text-faint">{q ? "try another search" : "try another filter"}</div>
            </div>
          ) : (
            shown.map((n, i) => {
              const meta = KIND_META[n.kind] ?? KIND_META.info;
              const jump = jumpFor(n.kind);
              return (
                <div
                  key={n.id}
                  className="notice-row"
                  data-fresh={n.fresh}
                  role={jump ? "button" : undefined}
                  tabIndex={jump ? 0 : undefined}
                  title={jump ? "Click to open" : n.fresh ? "Click to mark as read" : n.text}
                  style={{ animation: "rise .35s var(--ease-soft) both", animationDelay: `${Math.min(i, 10) * 30}ms`, cursor: jump || n.fresh ? "pointer" : undefined }}
                  onClick={() => {
                    if (n.fresh) st().markNoticeRead(n.id);
                    if (jump) {
                      useStore.setState({ noticeOpen: false });
                      if (jump === "tasks") st().setView("tasks");
                      else st().setView(jump as "market");
                    }
                  }}
                  onKeyDown={(e) => {
                    if (!jump) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      (e.currentTarget as HTMLElement).click();
                    }
                  }}
                >
                  <span className="game-icon !h-8 !w-8 flex-none" style={{ color: meta.tint }}>
                    <Icon name={n.icon as IconName} size={15} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] leading-snug text-ink" title={n.text}>{n.text}</span>
                    <span className="label !text-[10px]">{meta.label} · {timeAgo(n.at)}{jump ? " · click to open" : ""}</span>
                  </span>
                  {n.fresh ? (
                    <>
                      <span className="notice-dot" title="new" />
                      <button
                        className="icon-btn !h-5 !w-5 !rounded-md opacity-0 transition-opacity [.notice-row:hover_&]:opacity-100"
                        title="Mark as read"
                        aria-label="Mark as read"
                        onClick={(e) => {
                          e.stopPropagation();
                          st().markNoticeRead(n.id);
                        }}
                      >
                        <Icon name="check" size={11} />
                      </button>
                    </>
                  ) : null}
                </div>
              );
            })
          )}
        </div>

        <footer className="flex flex-none items-center justify-between border-t border-line px-4 py-2">
          <span className="tiny-font text-[9px] uppercase tracking-wider text-faint">last 40 events{dnd ? " · DND on" : ""}</span>
          <button
            className="tiny-font text-[9px] uppercase tracking-wider text-accent"
            onClick={() => {
              useStore.setState({ noticeOpen: false, settingsSection: "notifications" });
              st().setView("settings");
            }}
          >
            notification settings
          </button>
        </footer>
      </aside>
    </>
  );
}

function sfxSafe() {
  import("@/lib/sfx").then((m) => m.sfx("click")).catch(() => {});
}
