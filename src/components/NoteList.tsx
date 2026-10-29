"use client";

/**
 * Ultra-minimal notes sidebar — Obsidian vault explorer style.
 * Tiny icon toolbar, thin search, folder rows, one-line note rows,
 * tags collapsed at the bottom, right-click menus everywhere.
 */

import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/icons";
import { Empty } from "@/components/ui";
import { pickImportFile } from "@/lib/io";
import { TEMPLATES } from "@/lib/templates";
import ShareDialog from "@/components/ShareDialog";
import { onCtx, openCtx, type CtxItem } from "@/components/ContextMenu";
import { useStore } from "@/lib/store";
import { sfx } from "@/lib/sfx";
import { parseNote } from "@/lib/util";

type SortId = "edited" | "created" | "az";
const SORTS: { id: SortId; label: string; icon: IconName }[] = [
  { id: "edited", label: "Recently edited", icon: "clock" },
  { id: "created", label: "Recently created", icon: "sparkle" },
  { id: "az", label: "Title A → Z", icon: "heading" },
];
const loadSort = (): SortId => {
  try {
    const v = JSON.parse(localStorage.getItem("nook:prefs") ?? "{}")?.notesSort;
    return v === "created" || v === "az" ? v : "edited";
  } catch {
    return "edited";
  }
};

export function NoteList() {
  const notes = useStore((s) => s.notes);
  const folders = useStore((s) => s.folders);
  const activeFolder = useStore((s) => s.activeFolder);
  const activeId = useStore((s) => s.activeId);
  const tag = useStore((s) => s.tag);
  const [q, setQ] = useState("");
  const [sure, setSure] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [showFolders, setShowFolders] = useState(true);
  const [showTags, setShowTags] = useState(false);
  const [sort, setSort] = useState<SortId>(loadSort);
  const [shareId, setShareId] = useState<string | null>(null);
  const dq = useDeferredValue(q);
  const st = useStore.getState;

  useEffect(() => {
    try {
      const p = JSON.parse(localStorage.getItem("nook:prefs") ?? "{}");
      localStorage.setItem("nook:prefs", JSON.stringify({ ...p, notesSort: sort }));
    } catch {}
  }, [sort]);

  const tags = useMemo(() => {
    const c = new Map<string, number>();
    for (const n of notes) {
      for (const t of parseNote(n.content).tags) c.set(t, (c.get(t) ?? 0) + 1);
      for (const t of n.tags ?? []) c.set(t, (c.get(t) ?? 0) + 1);
    }
    return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18);
  }, [notes]);

  const filtered = useMemo(() => {
    const ql = dq.trim().toLowerCase();
    return notes
      .filter((n) => (!tag || parseNote(n.content).tags.includes(tag) || (n.tags ?? []).includes(tag)) && (!ql || n.title.toLowerCase().includes(ql) || n.content.toLowerCase().includes(ql)))
      .filter((n) => (activeFolder ? n.folderId === activeFolder : true));
  }, [notes, dq, tag, activeFolder]);

  const list = useMemo(() => {
    const arr = [...filtered];
    if (sort === "az") arr.sort((a, b) => (a.title || "Untitled").localeCompare(b.title || "Untitled"));
    else if (sort === "created") arr.sort((a, b) => b.createdAt - a.createdAt);
    else arr.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
    return arr;
  }, [filtered, sort]);

  const folderCounts = useMemo(() => {
    const c = new Map<string, number>();
    for (const n of notes) if (n.folderId) c.set(n.folderId, (c.get(n.folderId) ?? 0) + 1);
    return c;
  }, [notes]);

  const dropToFolder = (folderId: string | null) => (e: React.DragEvent) => {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/note-id");
    setDropTarget(null);
    if (id) {
      st().updateNote(id, { folderId });
      sfx("pop");
      st().toast(folderId ? "Moved to folder" : "Moved out of folder", "folder");
    }
  };

  /** the note's own right-click menu — every row gets its own actions */
  const noteMenu = (id: string): CtxItem[] => {
    const n = st().notes.find((x) => x.id === id);
    if (!n) return [];
    const m = parseNote(n.content);
    const moveTargets: CtxItem[] = [
      ...folders.map<CtxItem>((f) => ({
        icon: "folder",
        label: f.name,
        disabled: n.folderId === f.id,
        run: () => {
          st().updateNote(id, { folderId: f.id });
          st().toast(`Moved to ${f.name}`, "folder");
        },
      })),
      { sep: true },
      { icon: "inbox", label: "No folder", disabled: !n.folderId, run: () => st().updateNote(id, { folderId: null }) },
    ];
    return [
      { icon: "note", label: "Open", run: () => st().openNote(id) },
      { icon: "external-link", label: "Open in new tab", run: () => st().openNote(id) },
      { icon: "bookmark", label: n.pinned ? "Unpin" : "Pin to top", run: () => st().updateNote(id, { pinned: !n.pinned }) },
      { sep: true },
      {
        icon: "copy",
        label: "Duplicate",
        run: () => {
          const nid = st().createNote({ title: `${n.title} copy`, content: n.content, cover: n.cover, folderId: n.folderId });
          st().toast("Note duplicated", "copy");
          setTimeout(() => st().openNote(nid), 60);
        },
      },
      { icon: "send", label: "Share…", run: () => setShareId(id) },
      { icon: "folder", label: "Move to folder", sub: moveTargets },
      { sep: true },
      {
        icon: "file-text",
        label: "Copy markdown",
        run: async () => {
          await navigator.clipboard.writeText(n.content).catch(() => {});
          st().toast("Markdown copied", "copy");
        },
      },
      {
        icon: "download",
        label: "Export as .md",
        run: () => {
          const blob = new Blob([`# ${n.title}\n\n${n.content}`], { type: "text/markdown" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `${n.title.replace(/[\\/:*?"<>|]/g, "").slice(0, 40) || "note"}.md`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        },
      },
      ...(m.tasks.total > 0
        ? [{ icon: "tasklist" as IconName, label: `Send ${m.tasks.total - m.tasks.done} TODOs to Tasks`, run: () => { st().setView("tasks"); st().toast("Open Tasks to sync the checklist", "tasklist"); } }]
        : []),
      { sep: true },
      {
        icon: "trash",
        label: sure === id ? "Really delete?" : "Delete",
        danger: true,
        run: () => {
          if (sure === id) {
            st().deleteNote(id);
            setSure(null);
          } else {
            setSure(id);
            setTimeout(() => setSure((s) => (s === id ? null : s)), 2400);
          }
        },
      },
    ];
  };

  const folderMenu = (id: string): CtxItem[] => [
    {
      icon: "note",
      label: "New note here",
      run: () => {
        st().setActiveFolder(id);
        st().createNote();
      },
    },
    { icon: "pencil", label: "Rename folder", run: () => setRenaming(id) },
    {
      icon: "trash",
      label: "Delete folder (notes kept)",
      danger: true,
      run: () => st().deleteFolder(id),
    },
  ];

  return (
    <aside className="panel flex w-[248px] flex-none flex-col rounded-[18px]" data-vault onContextMenu={(e) => e.stopPropagation()}>
      {/* toolbar — tiny icons only */}
      <div className="flex h-[38px] flex-none items-center gap-0.5 border-b border-line px-2">
        <div className="relative">
          <button
            className="icon-btn !h-7 !w-7"
            data-on={newOpen}
            onClick={() => setNewOpen(!newOpen)}
            title="New note (Alt+N) — hold for templates"
            aria-label="New note"
          >
            <Icon name="plus" size={15} />
          </button>
          {newOpen && (
            <>
              <div className="fixed inset-0 z-[60]" onClick={() => setNewOpen(false)} />
              <div className="new-menu panel panel-solid absolute left-0 top-9 z-[61] w-[230px]" style={{ backdropFilter: "none" }}>
                <button
                  className="new-menu-item"
                  onClick={() => {
                    setNewOpen(false);
                    st().createNote();
                  }}
                >
                  <span className="t-icon"><Icon name="note" size={15} /></span>
                  <span className="min-w-0">
                    <span className="block text-[13.5px]">Blank note</span>
                    <span className="block text-[11px] text-faint">A fresh page, zero pressure</span>
                  </span>
                </button>
                <div className="my-1 h-px bg-line" />
                <button
                  className="new-menu-item"
                  onClick={() => {
                    setNewOpen(false);
                    st().openDailyNote();
                  }}
                >
                  <span className="t-icon"><Icon name="calendar" size={15} /></span>
                  <span className="min-w-0">
                    <span className="block text-[13.5px]">Today's daily note</span>
                    <span className="block text-[11px] text-faint">Wins · grateful · TODOs</span>
                  </span>
                </button>
                <div className="my-1 h-px bg-line" />
                {TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    className="new-menu-item"
                    onClick={() => {
                      setNewOpen(false);
                      st().createNote({ title: t.title, content: t.content });
                      st().toast(`New ${t.name.toLowerCase()} created`, t.icon);
                    }}
                  >
                    <span className="t-icon"><Icon name={t.icon} size={15} /></span>
                    <span className="min-w-0">
                      <span className="block text-[13.5px]">{t.name}</span>
                      <span className="block truncate text-[11px] text-faint">{t.blurb}</span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <button className="icon-btn !h-7 !w-7" onClick={() => st().createFolder(`Folder ${folders.length + 1}`)} title="New folder" aria-label="New folder">
          <Icon name="folder-plus" size={14} />
        </button>
        <div className="relative">
          <button className="icon-btn !h-7 !w-7" data-on={moreOpen} onClick={() => setMoreOpen(!moreOpen)} title="Sort, tags, import & export" aria-label="More">
            <Icon name="more-horizontal" size={15} />
          </button>
          {moreOpen && (
            <>
              <div className="fixed inset-0 z-[60]" onClick={() => setMoreOpen(false)} />
              <div className="menu panel panel-solid absolute left-0 top-9 z-[61] w-[218px] p-1.5" style={{ backdropFilter: "none" }}>
                <div className="label px-2 pb-1 pt-0.5">Sort notes</div>
                {SORTS.map((s) => (
                  <button
                    key={s.id}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-panel2"
                    onClick={() => {
                      setSort(s.id);
                      setMoreOpen(false);
                    }}
                  >
                    <Icon name={s.icon} size={13} className={sort === s.id ? "text-accent" : "text-faint"} />
                    {s.label}
                    {sort === s.id && <Icon name="check" size={12} className="ml-auto text-accent" />}
                  </button>
                ))}
                <div className="my-1 h-px bg-line" />
                <button className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-panel2" onClick={() => { st().exportNotes(); setMoreOpen(false); }}>
                  <Icon name="download" size={13} /> Export backup (JSON)
                </button>
                <button className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-panel2" onClick={() => { pickImportFile(); setMoreOpen(false); }}>
                  <Icon name="upload" size={13} /> Import backup
                </button>
                <div className="my-1 h-px bg-line" />
                <button className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-panel2" onClick={() => { st().openDailyNote(); setMoreOpen(false); }}>
                  <Icon name="calendar" size={13} /> Open daily note
                </button>
              </div>
            </>
          )}
        </div>
        <span className="flex-1" />
        <span className="text-[11.5px] tabular-nums text-faint">{list.length}</span>
      </div>

      {/* search — thin */}
      <div className="px-2 pb-1.5 pt-1.5">
        <div className="relative">
          <Icon name="search" size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <input className="input !h-[28px] !pl-7 !text-[12.5px]" placeholder="Find or filter…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      {/* folders — collapsible section */}
      <div className="min-h-0 flex-none">
        <button className="flex w-full items-center gap-1 px-2 py-1 text-left" onClick={() => setShowFolders(!showFolders)} aria-expanded={showFolders}>
          <Icon name={showFolders ? "chevron-down" : "chevron-right"} size={11} className="text-faint" />
          <span className="text-[10.5px] font-semibold tracking-[0.14em] text-faint">FOLDERS</span>
          <span className="flex-1" />
          <span className="text-[10.5px] text-faint">{folders.length}</span>
        </button>
        {showFolders && (
          <div className="scroll max-h-[150px] space-y-px px-1.5 pb-1" data-folders>
            {folders.map((f) => (
              <div
                key={f.id}
                className="folder-row !h-[27px] !gap-1.5 !rounded-[5px] !px-1.5"
                data-on={activeFolder === f.id}
                style={dropTarget === f.id ? { borderColor: "var(--accent)", background: "var(--hl)" } : undefined}
                onClick={() => st().setActiveFolder(f.id)}
                onContextMenu={onCtx(() => folderMenu(f.id), { icon: "folder", title: f.name })}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropTarget(f.id);
                }}
                onDragLeave={() => setDropTarget((t) => (t === f.id ? null : t))}
                onDrop={dropToFolder(f.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && st().setActiveFolder(f.id)}
              >
                <span className="folder-dot" style={{ background: f.color || "var(--accent)" }} />
                {renaming === f.id ? (
                  <input
                    autoFocus
                    className="input !h-[22px] !px-1.5 !py-0 !text-[12px]"
                    defaultValue={f.name}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      st().renameFolder(f.id, e.target.value);
                      setRenaming(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        st().renameFolder(f.id, (e.target as HTMLInputElement).value);
                        setRenaming(null);
                      }
                      if (e.key === "Escape") setRenaming(null);
                    }}
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate text-[13px] text-dim" data-on-text={activeFolder === f.id}>{f.name}</span>
                )}
                <span className="text-[10.5px] tabular-nums text-faint">{folderCounts.get(f.id) ?? 0}</span>
              </div>
            ))}
            {folders.length === 0 && <div className="px-2 pb-1 pt-0.5 text-[11.5px] leading-snug text-faint">Right-click → New folder, or use the folder+ button above.</div>}
          </div>
        )}
      </div>

      {/* notes — one line each */}
      <div className="scroll min-h-0 flex-1 space-y-px px-1.5 pb-2">
        {activeFolder && (
          <button className="folder-row !h-[27px] !rounded-[5px] !px-1.5" data-on="true" onClick={() => st().setActiveFolder(null)} onDragOver={(e) => e.preventDefault()} onDrop={dropToFolder(null)}>
            <Icon name="inbox" size={12} style={{ color: "var(--accent)" }} />
            <span className="flex-1 truncate text-left text-[13px]">All notes</span>
          </button>
        )}
        {list.length === 0 && <Empty icon={<Icon name="search" size={24} />} title="Nothing here" hint={activeFolder ? "This folder is empty — drag notes in." : "Try another word, or create a new note."} />}
        {list.map((n) => {
          const m = parseNote(n.content);
          return (
            <div
              key={n.id}
              className="note-row group"
              role="button"
              tabIndex={0}
              data-on={n.id === activeId}
              draggable
              onDragStart={(e) => e.dataTransfer.setData("text/note-id", n.id)}
              onClick={() => st().openNote(n.id)}
              onKeyDown={(e) => e.key === "Enter" && st().openNote(n.id)}
              onContextMenu={onCtx(() => noteMenu(n.id), { icon: "note", title: n.title || "Untitled" })}
              title={n.title || "Untitled"}
            >
              {n.pinned && <Icon name="bookmark" size={11} className="flex-none text-accent" />}
              <span className="min-w-0 flex-1 truncate text-[13px]">{n.title || "Untitled"}</span>
              {m.tasks.total > 0 && (
                <span className="flex-none text-[10px] tabular-nums text-faint">
                  {m.tasks.done}/{m.tasks.total}
                </span>
              )}
              <button
                className="icon-btn !h-5 !w-5 !rounded-[4px] opacity-0 transition-opacity group-hover:opacity-100"
                style={sure === n.id ? { background: "#a5594f", color: "#fff", opacity: 1 } : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  if (sure === n.id) {
                    st().deleteNote(n.id);
                    setSure(null);
                  } else {
                    setSure(n.id);
                    setTimeout(() => setSure((s) => (s === n.id ? null : s)), 2400);
                  }
                }}
                title={sure === n.id ? "Click again to delete" : "Delete"}
                aria-label="Delete note"
              >
                <Icon name="trash" size={11} />
              </button>
            </div>
          );
        })}
      </div>

      {/* tags — collapsed by default, ultra quiet */}
      {tags.length > 0 && (
        <div className="flex-none border-t border-line">
          <button className="flex w-full items-center gap-1 px-2 py-1.5 text-left" onClick={() => setShowTags(!showTags)} aria-expanded={showTags}>
            <Icon name={showTags ? "chevron-down" : "chevron-right"} size={11} className="text-faint" />
            <span className="text-[10.5px] font-semibold tracking-[0.14em] text-faint">TAGS</span>
            <span className="flex-1" />
            <span className="text-[10.5px] text-faint">{tags.length}</span>
          </button>
          {showTags && (
            <div className="scroll flex max-h-[92px] flex-wrap gap-1 px-2 pb-2">
              {tags.map(([t, n]) => (
                <button key={t} className="chip !h-[20px] !px-1.5 !text-[10.5px]" data-on={tag === t} onClick={() => st().set({ tag: tag === t ? null : t })}>
                  #{t}
                  <span className="opacity-60">{n}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {shareId && <ShareDialog noteId={shareId} noteTitle={notes.find((n) => n.id === shareId)?.title || "Untitled"} onClose={() => setShareId(null)} />}
    </aside>
  );
}
