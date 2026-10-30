
import { useEffect } from "react";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/icons";
import { useStore } from "@/lib/store";

type Row = { keys: string[]; label: string; icon: IconName };

const GROUPS: { title: string; rows: Row[] }[] = [
  {
    title: "Getting around",
    rows: [
      { keys: ["Ctrl", "K"], label: "Command palette — search & run anything", icon: "search" },
      { keys: ["Alt", "1…8"], label: "Notes · Graph · Canvas · Den · Focus · Arcade · Team · Market", icon: "layout" },
      { keys: ["Alt", "0"], label: "Activity (app time) ·  Alt+R the rulebook · Alt+– Settings", icon: "sliders-h" },
      { keys: ["Alt", "N"], label: "New note", icon: "plus" },
      { keys: ["Ctrl", "G"], label: "Jump to graph", icon: "algorithm" },
      { keys: ["Alt", "Z"], label: "Zen mode (hide everything but your note)", icon: "minus" },
      { keys: ["?"], label: "This help overlay", icon: "keyboard" },
    ],
  },
  {
    title: "Writing",
    rows: [
      { keys: ["/"], label: "Slash commands in notes — headings, tables, date, voice typing, send-line-to-tasks…", icon: "slash-cmd" },
      { keys: ["@"], label: "Mention a task, note or person — chips are clickable (notes + task bar)", icon: "at" },
      { keys: ["Mic"], label: "Voice-to-text — download Moonshine or Whisper in Settings → Voice first", icon: "mic" },
      { keys: ["Ctrl", "B"], label: "Bold · Ctrl+I italic · Tab indents lists", icon: "pencil" },
      { keys: ["Ctrl", "E"], label: "Cycle write / split / read mode", icon: "book-open" },
      { keys: ["[["], label: "Link to another note — they appear in the graph", icon: "link" },
      { keys: ["#"], label: "Tag a note — tags become graph hubs", icon: "hash" },
      { keys: ["- [ ]"], label: "Task checkboxes, tracked per note", icon: "checkbox-on" },
      { keys: ["Paste/Drop"], label: "Paste or drop images & files to attach them to a note", icon: "paperclip" },
    ],
  },
  {
    title: "Canvas & rules",
    rows: [
      { keys: ["P / E"], label: "Canvas: freehand pen · eraser (colors pop when pen is on)", icon: "pen-ruler" },
      { keys: ["Ctrl", "Z"], label: "Canvas undo · Ctrl+Shift+Z redo · arrows nudge selection", icon: "undo" },
      { keys: ["Alt", "R"], label: "The rulebook — block sites, app limits, quiet hours, shield", icon: "shield" },
    ],
  },
  {
    title: "Panels & comfort",
    rows: [
      { keys: ["Ctrl", "B"], label: "Toggle note sidebar", icon: "notes" },
      { keys: ["Ctrl", "J"], label: "Toggle right panel (info / AI chat)", icon: "message-text" },
      { keys: ["Alt", "S"], label: "Mute / unmute sound effects", icon: "coins" },
    ],
  },
  {
    title: "Daily loop",
    rows: [
      { keys: ["Write"], label: "Every 20 words = 1 coin + XP (higher pet level = coin perk!)", icon: "coins" },
      { keys: ["Play"], label: "Arcade games pay coins and raise joy", icon: "gamepad" },
      { keys: ["Focus"], label: "Finish a 25-min session for +10 coins", icon: "hourglass" },
      { keys: ["Tricks"], label: "Teach the pet tricks in the Den — they perform for XP and joy", icon: "star" },
      { keys: ["Bug?"], label: "Report bugs from the status bar — logs ride along automatically", icon: "bug" },
      { keys: ["Claim"], label: "Daily quests on the dashboard — bonus rewards", icon: "flag" },
    ],
  },
];

export function HelpOverlay() {
  const open = useStore((s) => s.help);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useStore.setState({ help: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;
  const close = () => useStore.setState({ help: false });

  return (
    <div
      className="fixed inset-0 z-[86] grid place-items-center bg-black/45 p-4"
      style={{ animation: "pop .18s ease both" }}
      onPointerDown={(e) => e.target === e.currentTarget && close()}
      role="dialog"
      aria-label="Keyboard shortcuts"
    >
      <div className="panel panel-solid scroll max-h-[86vh] w-[min(720px,94vw)] overflow-auto rounded-[22px] p-6" style={{ backdropFilter: "none" }}>
        <div className="mb-4 flex items-center gap-3">
          <span className="game-icon">
            <Icon name="keyboard" size={20} />
          </span>
          <div>
            <div className="pixel-font text-[21px] leading-tight">Nook handbook</div>
            <div className="text-[12.5px] text-dim">Every shortcut, ritual and trick — all in one page.</div>
          </div>
          <div className="flex-1" />
          <button className="icon-btn" onClick={close} aria-label="Close help">
            <Icon name="close" size={15} />
          </button>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <div className="label mb-2">{g.title}</div>
              <div className="space-y-1.5">
                {g.rows.map((r) => (
                  <div key={r.label} className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 transition-colors hover:bg-panel2">
                    <span className="grid h-7 w-7 flex-none place-items-center rounded-lg border border-line bg-panel2 text-accent">
                      <Icon name={r.icon} size={13} />
                    </span>
                    <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-dim">{r.label}</span>
                    <span className="flex flex-none gap-1">
                      {r.keys.map((k) => (
                        <kbd key={k} className="kbd">
                          {k}
                        </kbd>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>

        <div className="inset mt-5 flex items-start gap-3 p-4">
          <Icon name="lightbulb" size={16} className="mt-0.5 text-accent" />
          <div className="text-[12.5px] leading-relaxed text-dim">
            <b className="text-ink">Tip:</b> type <code className="kbd">[[</code> in any note to link it, then open the Graph and spin your mind in 3D. Your pet earns coins
            while you write — spend them in the <button className="text-accent underline decoration-dotted" onClick={() => { close(); useStore.getState().setView("market"); }}>Marketplace</button> or the Den closet.
          </div>
        </div>
      </div>
    </div>
  );
}
