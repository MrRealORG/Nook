"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { useStore } from "@/lib/store";
import { parseNote, timeAgo } from "@/lib/util";

/** slide-in drawer with quick note access from anywhere in the app */
export function NotesDrawer() {
  const open = useStore((s) => s.notesDrawer);
  const notes = useStore((s) => s.notes);
  const folders = useStore((s) => s.folders);
  const activeId = useStore((s) => s.activeId);
  const [q, setQ] = useState("");
  const [folderId, setFolderId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 120);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && useStore.getState().set({ notesDrawer: false });
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const rows = useMemo(() => {
    const query = q.trim().toLowerCase();
    return notes
      .filter((n) => (folderId ? n.folderId === folderId : true))
      .filter((n) => !query || n.title.toLowerCase().includes(query) || n.content.toLowerCase().includes(query))
      .slice(0, 60);
  }, [notes, q, folderId]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[110]">
      <div className="absolute inset-0" style={{ background: "rgba(4,6,8,0.5)", animation: "fadeIn .2s ease both" }} onClick={() => useStore.getState().set({ notesDrawer: false })} />
      <aside className="drawer panel panel-solid absolute inset-y-0 left-0 flex w-[min(360px,92vw)] flex-col rounded-none rounded-r-[20px]" role="dialog" aria-label="Notes drawer">
        <div className="flex items-center gap-2 border-b border-line p-3">
          <Icon name="library" size={15} className="text-accent" />
          <span className="pixel-font flex-1 text-[15px]">All notes</span>
          <button
            className="btn btn-sm"
            onClick={() => {
              useStore.getState().createNote();
              useStore.getState().set({ notesDrawer: false });
            }}
          >
            <Icon name="plus" size={12} /> New
          </button>
          <button className="icon-btn" onClick={() => useStore.getState().set({ notesDrawer: false })} aria-label="Close drawer">
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="border-b border-line p-3 pb-2.5">
          <input ref={inputRef} className="input" placeholder="Search your vault…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="scroll mt-2 flex gap-1.5 overflow-x-auto pb-1">
            <button className="chip flex-none" data-on={folderId === null} onClick={() => setFolderId(null)}>all</button>
            {folders.map((f) => (
              <button key={f.id} className="chip flex-none" data-on={folderId === f.id} onClick={() => setFolderId(f.id)}>
                <i className="inline-block h-[7px] w-[7px] rounded-[2px]" style={{ background: f.color }} /> {f.name}
              </button>
            ))}
          </div>
        </div>
        <div className="scroll min-h-0 flex-1 p-2">
          {rows.length === 0 && <div className="px-3 py-6 text-center text-[12.5px] text-faint">Nothing matches — try another word.</div>}
          {rows.map((n, i) => {
            const m = parseNote(n.content);
            return (
              <button
                key={n.id}
                className="drawer-row"
                data-active={n.id === activeId}
                style={{ animation: "rise .3s var(--ease-soft) both", animationDelay: `${Math.min(i, 14) * 22}ms` }}
                onClick={() => {
                  useStore.getState().openNote(n.id);
                  useStore.getState().set({ notesDrawer: false });
                }}
              >
                <span className="game-icon !h-8 !w-8 flex-none">
                  {n.pinned ? <Icon name="bookmark" size={13} /> : <Icon name="note" size={13} />}
                </span>
                <span className="min-w-0 flex-1 text-left">
                  <span className="pixel-font block truncate text-[14px]">{n.title}</span>
                  <span className="block truncate text-[11.5px] text-faint">{m.snippet || `${m.words} words`}</span>
                </span>
                <span className="flex-none text-[10.5px] text-faint">{timeAgo(n.updatedAt)}</span>
              </button>
            );
          })}
        </div>
        <div className="border-t border-line px-3 py-2 text-[11px] text-faint">
          {notes.length} notes · {folders.length} folders · Esc closes
        </div>
      </aside>
    </div>
  );
}
