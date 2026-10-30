
/**
 * Obsidian-style workspace tabs for the notes view.
 * Open notes become tabs (created by openNote/createNote in the store),
 * right-click any tab for its own menu (close / close others / pin / move),
 * "+" opens a new note, and a collapsed tab list lives in the overflow "⋯".
 */

import { useState } from "react";
import { Icon } from "@/components/Icon";
import { onCtx } from "@/components/ContextMenu";
import { useStore } from "@/lib/store";

export function NoteTabs() {
  const openTabs = useStore((s) => s.openTabs);
  const tabPins = useStore((s) => s.tabPins);
  const notes = useStore((s) => s.notes);
  const activeId = useStore((s) => s.activeId);
  const st = useStore.getState;
  const [listOpen, setListOpen] = useState(false);

  if (openTabs.length === 0 && !listOpen) return null;

  const tabMenu = (id: string) => {
    const pinned = tabPins.includes(id);
    return [
      { icon: "external-link" as const, label: pinned ? "Unpin tab" : "Pin tab", shortcut: "", run: () => st().toggleTabPin(id) },
      { icon: "arrow-left" as const, label: "Move left", disabled: openTabs.indexOf(id) === 0, run: () => st().moveTab(id, -1) },
      { icon: "arrow-right" as const, label: "Move right", disabled: openTabs.indexOf(id) === openTabs.length - 1, run: () => st().moveTab(id, 1) },
      { sep: true as const },
      { icon: "copy" as const, label: "Open in new tab", run: () => st().openNote(id) },
      { icon: "close" as const, label: "Close tab", shortcut: "", run: () => st().closeTab(id) },
      { icon: "close" as const, label: "Close other tabs", disabled: openTabs.length < 2, run: () => st().closeOtherTabs(id) },
      { icon: "close" as const, label: "Close all tabs", run: () => st().closeAllTabs() },
    ];
  };

  return (
    <div className="tabs" data-tabs>
      {openTabs.map((id) => {
        const n = notes.find((x) => x.id === id);
        if (!n) return null;
        const pinned = tabPins.includes(id);
        return (
          <div
            key={id}
            className="tab"
            role="tab"
            aria-selected={id === activeId}
            tabIndex={0}
            data-on={id === activeId}
            onClick={() => st().set({ activeId: id })}
            onKeyDown={(e) => e.key === "Enter" && st().set({ activeId: id })}
            onAuxClick={(e) => {
              if (e.button === 1) st().closeTab(id);
            }}
            onContextMenu={onCtx(() => tabMenu(id), { icon: "note", title: n.title || "Untitled" })}
            title={n.title || "Untitled"}
          >
            {pinned && <Icon name="bookmark" size={11} className="flex-none text-accent" />}
            <span className="tab-title">{n.title || "Untitled"}</span>
            <button
              className="tab-x"
              data-pinned={pinned}
              aria-label={pinned ? "Pinned tab" : "Close tab"}
              title={pinned ? "Pinned — right-click to unpin" : "Close"}
              onClick={(e) => {
                e.stopPropagation();
                if (pinned) st().toggleTabPin(id);
                else st().closeTab(id);
              }}
            >
              <Icon name={pinned ? "bookmark" : "close"} size={11} />
            </button>
          </div>
        );
      })}

      <button className="tabs-add" onClick={() => st().createNote()} title="New note (Alt+N)" aria-label="New note">
        <Icon name="plus" size={15} />
      </button>

      <div className="relative">
        <button className="tabs-add" data-on={listOpen} onClick={() => setListOpen(!listOpen)} title="Open tabs list" aria-label="Tab list">
          <Icon name="arrows-horizontal" size={14} />
        </button>
        {listOpen && (
          <>
            <div className="fixed inset-0 z-[70]" onClick={() => setListOpen(false)} />
            <div className="menu panel panel-solid absolute right-1 top-9 z-[71] w-[240px] p-1.5" style={{ backdropFilter: "none" }}>
              <div className="label px-2 pb-1 pt-0.5">Open tabs — {openTabs.length}</div>
              {openTabs.length === 0 && <div className="px-2 py-2 text-[12px] text-faint">No tabs yet — open a note.</div>}
              {openTabs.map((id) => {
                const n = notes.find((x) => x.id === id);
                if (!n) return null;
                return (
                  <button
                    key={id}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-panel2"
                    style={{ background: id === activeId ? "var(--hl)" : undefined }}
                    onClick={() => {
                      st().set({ activeId: id });
                      setListOpen(false);
                    }}
                  >
                    {tabPins.includes(id) ? <Icon name="bookmark" size={12} className="flex-none text-accent" /> : <Icon name="note" size={12} className="flex-none text-faint" />}
                    <span className="truncate">{n.title || "Untitled"}</span>
                    <span className="flex-1" />
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label="Close tab"
                      className="grid h-5 w-5 place-items-center rounded-md text-faint hover:bg-panel2 hover:text-ink"
                      onClick={(e) => {
                        e.stopPropagation();
                        st().closeTab(id);
                      }}
                    >
                      <Icon name="close" size={11} />
                    </span>
                  </button>
                );
              })}
              {openTabs.length > 1 && (
                <button
                  className="mt-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-dim hover:bg-panel2"
                  onClick={() => {
                    st().closeAllTabs();
                    setListOpen(false);
                  }}
                >
                  <Icon name="close" size={12} /> Close all tabs
                </button>
              )}
            </div>
          </>
        )}
      </div>
      <div className="tabs-spacer" />
    </div>
  );
}
