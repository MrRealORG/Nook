/**
 * 1.3 vault explorer — a real folder tree (used by the Nook layout's notes column and by the
 * Obsidian layout's left sidebar):
 *  - pixel folders that open/close, a colour or emoji per folder, note counts (recursive);
 *  - indent guides and smooth expand/collapse (CSS grid rows, no JS animation);
 *  - drag & drop: notes into folders, folders into folders or before/after a sibling, with a
 *    drop indicator; drop on "Vault" to move to the top level;
 *  - inline rename (double-click or F2), right-click menus (new note, new folder, rename,
 *    colour, icon, pin, delete), a Pinned section, sort options, empty-folder state.
 */
import "@/tree.css";
import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/icons";
import { PIXEL_SPRITES } from "@/components/PixelIcon";
import { pickImportFile } from "@/lib/io";
import { TEMPLATES } from "@/lib/templates";
import ShareDialog from "@/components/ShareDialog";
import { onCtx, type CtxItem } from "@/components/ContextMenu";
import { useStore } from "@/lib/store";
import { useIconFamily } from "@/lib/iconStyle";
import { sfx } from "@/lib/sfx";
import { parseNote } from "@/lib/util";
import type { Folder, Note } from "@/lib/types";

type SortId = "manual" | "az" | "edited" | "created";
const SORTS: { id: SortId; label: string; icon: IconName }[] = [
  { id: "manual", label: "Folders: manual · notes: recent", icon: "move" },
  { id: "az", label: "Name A → Z", icon: "heading" },
  { id: "edited", label: "Recently edited", icon: "clock" },
  { id: "created", label: "Recently created", icon: "sparkle" },
];
export const FOLDER_COLORS = [
  { c: "#f2c14e", n: "Amber" }, { c: "#ffa06d", n: "Peach" }, { c: "#f27ba0", n: "Rose" }, { c: "#a98bf0", n: "Lavender" },
  { c: "#6fb4f2", n: "Sky" }, { c: "#5fd29b", n: "Mint" }, { c: "#9fd458", n: "Leaf" }, { c: "#aab1c6", n: "Slate" },
];
const EMOJI = ["📁", "📚", "💡", "🚀", "🎨", "🧠", "📝", "💼", "🏠", "🎮", "🌱", "⭐", "🔥", "🎵", "✈️", "🧪"];
const isEmoji = (s: string) => !!s && s !== "folder" && /\p{Extended_Pictographic}/u.test(s);

const prefKey = "nook:tree";
function loadTree(): { open: string[]; sort: SortId } {
  try {
    const v = JSON.parse(localStorage.getItem(prefKey) ?? "{}");
    return { open: Array.isArray(v.open) ? v.open : [], sort: ["manual", "az", "edited", "created"].includes(v.sort) ? v.sort : "manual" };
  } catch {
    return { open: [], sort: "manual" };
  }
}

/** a pixel folder sprite recoloured to the folder's colour (open / closed) */
export const FolderGlyph = memo(function FolderGlyph({ color, open, size = 16, icon }: { color?: string; open?: boolean; size?: number; icon?: string }) {
  const family = useIconFamily();
  if (icon && isEmoji(icon)) return <span className="ft-emoji" style={{ width: size, height: size, fontSize: size - 2 }} aria-hidden>{icon}</span>;
  if (family === "crisp") return <Icon name="folder" size={size} style={{ color: color || "var(--accent)" }} />;
  const s = PIXEL_SPRITES[open ? "folder-open" : "folder"];
  const c = color || "#f2c14e";
  const fill: Record<string, string> = { o: "var(--px-o, #3a2e52)", h: `color-mix(in srgb, ${c} 45%, #fff)`, a: c, d: `color-mix(in srgb, ${c} 70%, #000)` };
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges" className="px-icon ft-folder" aria-hidden data-open={!!open}>
      {(["o", "h", "a", "d"] as const).map((t) => (s.d[t] ? <path key={t} d={s.d[t]} fill={fill[t]} /> : null))}
    </svg>
  );
});

type Drop = { id: string; where: "into" | "before" | "after" } | null;

export function NoteList({ embedded }: { embedded?: boolean } = {}) {
  const notes = useStore((s) => s.notes);
  const folders = useStore((s) => s.folders);
  const activeFolder = useStore((s) => s.activeFolder);
  const activeId = useStore((s) => s.activeId);
  const tag = useStore((s) => s.tag);
  const [q, setQ] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [showTags, setShowTags] = useState(false);
  const [tree, setTree] = useState(loadTree);
  const [shareId, setShareId] = useState<string | null>(null);
  const dq = useDeferredValue(q);
  const st = useStore.getState;
  const dragKind = useRef<"note" | "folder" | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(prefKey, JSON.stringify(tree));
    } catch {}
  }, [tree]);
  const open = useMemo(() => new Set(tree.open), [tree.open]);
  const toggle = (id: string, force?: boolean) =>
    setTree((t) => {
      const on = force ?? !t.open.includes(id);
      return { ...t, open: on ? [...new Set([...t.open, id])] : t.open.filter((x) => x !== id) };
    });

  // reveal the active note's folder chain
  useEffect(() => {
    const n = notes.find((x) => x.id === activeId);
    if (!n?.folderId) return;
    const chain: string[] = [];
    let f = folders.find((x) => x.id === n.folderId);
    for (let k = 0; f && k < 32; k++) {
      chain.push(f.id);
      f = folders.find((x) => x.id === f!.parentId);
    }
    if (chain.some((id) => !open.has(id))) setTree((t) => ({ ...t, open: [...new Set([...t.open, ...chain])] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const tagged = useMemo(() => (tag ? notes.filter((n) => parseNote(n.content).tags.includes(tag) || (n.tags ?? []).includes(tag)) : notes), [notes, tag]);
  const sortNotes = (arr: Note[]) => {
    const a = [...arr];
    if (tree.sort === "az") a.sort((x, y) => (x.title || "Untitled").localeCompare(y.title || "Untitled"));
    else if (tree.sort === "created") a.sort((x, y) => y.createdAt - x.createdAt);
    else a.sort((x, y) => y.updatedAt - x.updatedAt);
    return a;
  };
  const sortFolders = (arr: Folder[]) => [...arr].sort((a, b) => (tree.sort === "az" ? a.name.localeCompare(b.name) : a.position - b.position || a.name.localeCompare(b.name)));

  const byParent = useMemo(() => {
    const m = new Map<string | null, Folder[]>();
    const ids = new Set(folders.map((f) => f.id));
    for (const f of folders) {
      const p = f.parentId && ids.has(f.parentId) ? f.parentId : null;
      m.set(p, [...(m.get(p) ?? []), f]);
    }
    return m;
  }, [folders]);
  const notesIn = useMemo(() => {
    const m = new Map<string | null, Note[]>();
    const ids = new Set(folders.map((f) => f.id));
    for (const n of tagged) {
      const k = n.folderId && ids.has(n.folderId) ? n.folderId : null;
      m.set(k, [...(m.get(k) ?? []), n]);
    }
    return m;
  }, [tagged, folders]);
  const countOf = useMemo(() => {
    const memo = new Map<string, number>();
    const go = (id: string, depth = 0): number => {
      if (memo.has(id)) return memo.get(id)!;
      const n = (notesIn.get(id)?.length ?? 0) + (depth > 30 ? 0 : (byParent.get(id) ?? []).reduce((a, f) => a + go(f.id, depth + 1), 0));
      memo.set(id, n);
      return n;
    };
    return go;
  }, [notesIn, byParent]);

  const results = useMemo(() => {
    const ql = dq.trim().toLowerCase();
    if (!ql) return null;
    return sortNotes(tagged.filter((n) => n.title.toLowerCase().includes(ql) || n.content.toLowerCase().includes(ql)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq, tagged, tree.sort]);

  const tags = useMemo(() => {
    const c = new Map<string, number>();
    for (const n of notes) {
      for (const t of parseNote(n.content).tags) c.set(t, (c.get(t) ?? 0) + 1);
      for (const t of n.tags ?? []) c.set(t, (c.get(t) ?? 0) + 1);
    }
    return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18);
  }, [notes]);

  // ---------------------------------------------------------------- actions
  const newNoteIn = (folderId: string | null) => {
    st().setActiveFolder(folderId);
    const id = st().createNote({ folderId });
    if (folderId) toggle(folderId, true);
    return id;
  };
  const newFolderIn = (parentId: string | null) => {
    const id = st().createFolder("New folder", parentId);
    if (parentId) toggle(parentId, true);
    setRenaming(id);
  };
  const isAncestor = (anc: string, node: string | null | undefined): boolean => {
    for (let k = 0, cur = node; cur && k < 40; k++) {
      if (cur === anc) return true;
      cur = folders.find((f) => f.id === cur)?.parentId ?? null;
    }
    return false;
  };
  const moveFolder = (id: string, target: Drop) => {
    if (!target || target.id === id) return;
    const tf = folders.find((f) => f.id === target.id);
    if (!tf) return;
    if (target.where === "into") {
      if (isAncestor(id, tf.id)) return st().toast("Can't move a folder into itself", "alert");
      st().updateFolder(id, { parentId: tf.id });
      toggle(tf.id, true);
    } else {
      const parent = tf.parentId ?? null;
      if (parent && isAncestor(id, parent)) return;
      const sibs = sortFolders((byParent.get(parent) ?? []).filter((f) => f.id !== id));
      const at = sibs.findIndex((f) => f.id === tf.id) + (target.where === "after" ? 1 : 0);
      const moved = folders.find((f) => f.id === id)!;
      sibs.splice(at, 0, moved);
      sibs.forEach((f, k) => {
        if (f.position !== k || (f.id === id && (f.parentId ?? null) !== parent)) st().updateFolder(f.id, f.id === id ? { position: k, parentId: parent } : { position: k });
      });
      if (tree.sort !== "manual") setTree((t) => ({ ...t, sort: "manual" }));
    }
    sfx("pop");
  };
  const onDrop = (target: Drop) => (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDrop(null);
    const nid = e.dataTransfer.getData("text/note-id");
    const fid = e.dataTransfer.getData("text/folder-id");
    if (nid) {
      const to = target?.id ?? null;
      const n = st().notes.find((x) => x.id === nid);
      if (n && n.folderId !== to) {
        st().updateNote(nid, { folderId: to });
        if (to) toggle(to, true);
        sfx("pop");
        st().toast(to ? `Moved to ${folders.find((f) => f.id === to)?.name ?? "folder"}` : "Moved to the vault root", "folder");
      }
    } else if (fid) {
      if (!target) {
        st().updateFolder(fid, { parentId: null });
        sfx("pop");
      } else moveFolder(fid, target);
    }
  };
  const overFolder = (f: Folder) => (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    const where: "into" | "before" | "after" = dragKind.current === "folder" ? (y < 0.28 ? "before" : y > 0.72 ? "after" : "into") : "into";
    if (drop?.id !== f.id || drop.where !== where) setDrop({ id: f.id, where });
  };

  const folderMenu = (f: Folder): CtxItem[] => [
    { icon: "note", label: "New note", run: () => newNoteIn(f.id) },
    { icon: "folder-plus", label: "New folder", run: () => newFolderIn(f.id) },
    { sep: true },
    { icon: "pencil", label: "Rename", shortcut: "F2", run: () => setRenaming(f.id) },
    { icon: "palette", label: "Colour", sub: FOLDER_COLORS.map(({ c, n }) => ({ label: f.color === c ? `${n}  ✓` : n, lead: <span aria-hidden style={{ display: "inline-block", width: 12, height: 12, borderRadius: 3, background: c, boxShadow: f.color === c ? "0 0 0 2px var(--panel-solid), 0 0 0 3.5px currentColor" : "inset 0 0 0 1px rgba(0,0,0,.2)" }} />, run: () => st().updateFolder(f.id, { color: c, icon: isEmoji(f.icon) ? "folder" : f.icon }) })) },
    { icon: "sparkle", label: "Emoji icon", sub: [...EMOJI.map<CtxItem>((em) => ({ label: `${em}  ${f.icon === em ? "✓" : ""}`, run: () => st().updateFolder(f.id, { icon: em }) })), { sep: true }, { icon: "folder", label: "Pixel folder (no emoji)", run: () => st().updateFolder(f.id, { icon: "folder" }) }] },
    { icon: "bookmark", label: f.pinned ? "Unpin" : "Pin to favourites", run: () => st().updateFolder(f.id, { pinned: !f.pinned }) },
    { icon: "arrow-up", label: "Move to top level", disabled: !f.parentId, run: () => st().updateFolder(f.id, { parentId: null }) },
    { sep: true },
    { icon: "trash", label: "Delete folder (notes kept)", danger: true, run: () => st().deleteFolder(f.id) },
  ];
  const noteMenu = (n: Note): CtxItem[] => [
    { icon: "note", label: "Open", run: () => st().openNote(n.id) },
    { icon: "pencil", label: "Rename", shortcut: "F2", run: () => setRenaming(n.id) },
    { icon: "bookmark", label: n.pinned ? "Unpin" : "Pin to favourites", run: () => st().updateNote(n.id, { pinned: !n.pinned }) },
    {
      icon: "copy",
      label: "Duplicate",
      run: () => {
        const nid = st().createNote({ title: `${n.title} copy`, content: n.content, cover: n.cover, folderId: n.folderId });
        setTimeout(() => st().openNote(nid), 60);
      },
    },
    { icon: "send", label: "Share…", run: () => setShareId(n.id) },
    {
      icon: "folder",
      label: "Move to",
      sub: [
        { icon: "inbox", label: "Vault root", disabled: !n.folderId, run: () => st().updateNote(n.id, { folderId: null }) },
        { sep: true },
        ...sortFolders(folders).map<CtxItem>((f) => ({ icon: "folder", label: f.name, disabled: n.folderId === f.id, run: () => st().updateNote(n.id, { folderId: f.id }) })),
      ],
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
    { sep: true },
    {
      icon: "trash",
      label: "Delete",
      danger: true,
      // v1.4: one click — the note goes at once and a toast offers Undo for 6 s
      run: () => st().deleteNote(n.id),
    },
  ];

  // ---------------------------------------------------------------- rows
  const renameInput = (value: string, done: (v: string) => void) => (
    <input
      autoFocus
      className="ft-rename"
      defaultValue={value}
      data-testid="ft-rename"
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => {
        done(e.target.value);
        setRenaming(null);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setRenaming(null);
      }}
    />
  );

  const noteRow = (n: Note, depth: number) => (
    <div
      key={n.id}
      className="ft-row ft-note"
      role="treeitem"
      tabIndex={0}
      aria-selected={n.id === activeId}
      data-on={n.id === activeId}
      data-testid="ft-note"
      data-title={n.title}
      style={{ ["--d" as string]: depth }}
      draggable={renaming !== n.id}
      onDragStart={(e) => {
        dragKind.current = "note";
        e.dataTransfer.setData("text/note-id", n.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={() => (dragKind.current = null)}
      onClick={() => st().openNote(n.id)}
      onDoubleClick={() => setRenaming(n.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter") st().openNote(n.id);
        if (e.key === "F2") setRenaming(n.id);
      }}
      onContextMenu={onCtx(() => noteMenu(n), { icon: "note", title: n.title || "Untitled" })}
      title={n.title || "Untitled"}
    >
      <span className="ft-note-ico" aria-hidden>{n.pinned ? "★" : ""}</span>
      {renaming === n.id ? renameInput(n.title, (v) => st().renameNote(n.id, v)) : <span className="ft-name">{n.title || "Untitled"}</span>}
    </div>
  );

  const folderNode = (f: Folder, depth: number, seen: Set<string>): React.ReactNode => {
    if (seen.has(f.id)) return null;
    const next = new Set(seen).add(f.id);
    const isOpen = open.has(f.id);
    const kids = sortFolders(byParent.get(f.id) ?? []);
    const ns = sortNotes(notesIn.get(f.id) ?? []);
    const d = drop?.id === f.id ? drop.where : undefined;
    return (
      <div key={f.id} className="ft-node" role="group">
        <div
          className="ft-row ft-folder-row"
          role="treeitem"
          aria-expanded={isOpen}
          tabIndex={0}
          data-testid="ft-folder"
          data-name={f.name}
          data-on={activeFolder === f.id}
          data-drop={d}
          style={{ ["--d" as string]: depth, ["--fc" as string]: f.color || "var(--accent)" }}
          draggable={renaming !== f.id}
          onDragStart={(e) => {
            dragKind.current = "folder";
            e.dataTransfer.setData("text/folder-id", f.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragEnd={() => {
            dragKind.current = null;
            setDrop(null);
          }}
          onDragOver={overFolder(f)}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop((x) => (x?.id === f.id ? null : x));
          }}
          onDrop={onDrop(drop?.id === f.id ? drop : { id: f.id, where: "into" })}
          onClick={() => {
            toggle(f.id);
            st().setActiveFolder(f.id);
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setRenaming(f.id);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggle(f.id);
            }
            if (e.key === "ArrowRight") toggle(f.id, true);
            if (e.key === "ArrowLeft") toggle(f.id, false);
            if (e.key === "F2") setRenaming(f.id);
          }}
          onContextMenu={onCtx(() => folderMenu(f), { icon: "folder", title: f.name })}
        >
          <Icon name="chevron-right" size={11} className="ft-chev" />
          <FolderGlyph color={f.color} open={isOpen} icon={f.icon} />
          {renaming === f.id ? renameInput(f.name, (v) => st().renameFolder(f.id, v)) : <span className="ft-name">{f.name}</span>}
          {f.pinned && <span className="ft-pin" title="Pinned">★</span>}
          <span className="ft-count" data-testid="ft-count">{countOf(f.id)}</span>
          <button className="ft-add" title="New note here" aria-label={`New note in ${f.name}`} onClick={(e) => { e.stopPropagation(); newNoteIn(f.id); }}>
            <Icon name="plus" size={11} />
          </button>
        </div>
        <div className="ft-kids" data-open={isOpen}>
          <div className="ft-kids-inner" style={{ ["--d" as string]: depth }}>
            {isOpen && (
              <>
                {kids.map((k) => folderNode(k, depth + 1, next))}
                {ns.map((n) => noteRow(n, depth + 1))}
                {kids.length === 0 && ns.length === 0 && (
                  <div className="ft-empty" style={{ ["--d" as string]: depth + 1 }} data-testid="ft-empty">
                    Empty — drag notes here or <button onClick={() => newNoteIn(f.id)}>add one</button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    );
  };

  const pinnedFolders = sortFolders(folders.filter((f) => f.pinned));
  const pinnedNotes = sortNotes(tagged.filter((n) => n.pinned));
  const rootFolders = sortFolders(byParent.get(null) ?? []);
  const rootNotes = sortNotes(notesIn.get(null) ?? []);

  return (
    <aside
      className={embedded ? "ft ft-embedded flex min-h-0 flex-1 flex-col" : "ft panel flex w-[264px] flex-none flex-col rounded-[18px]"}
      data-vault
      data-testid="folder-tree"
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="ft-bar">
        <div className="relative">
          <button className="icon-btn !h-7 !w-7" data-on={newOpen} onClick={() => setNewOpen(!newOpen)} title="New note (Alt+N) — templates" aria-label="New note">
            <Icon name="plus" size={15} />
          </button>
          {newOpen && (
            <>
              <div className="fixed inset-0 z-[60]" onClick={() => setNewOpen(false)} />
              <div className="new-menu panel panel-solid absolute left-0 top-9 z-[61] w-[230px]" style={{ backdropFilter: "none" }}>
                <button className="new-menu-item" onClick={() => { setNewOpen(false); newNoteIn(activeFolder); }}>
                  <span className="t-icon"><Icon name="note" size={15} /></span>
                  <span className="min-w-0"><span className="block text-[13.5px]">Blank note</span><span className="block text-[11px] text-faint">A fresh page, zero pressure</span></span>
                </button>
                <button className="new-menu-item" onClick={() => { setNewOpen(false); st().openDailyNote(); }}>
                  <span className="t-icon"><Icon name="calendar" size={15} /></span>
                  <span className="min-w-0"><span className="block text-[13.5px]">Today's daily note</span><span className="block text-[11px] text-faint">Wins · grateful · TODOs</span></span>
                </button>
                <div className="my-1 h-px bg-line" />
                {TEMPLATES.map((t) => (
                  <button key={t.id} className="new-menu-item" onClick={() => { setNewOpen(false); st().createNote({ title: t.title, content: t.content }); }}>
                    <span className="t-icon"><Icon name={t.icon} size={15} /></span>
                    <span className="min-w-0"><span className="block text-[13.5px]">{t.name}</span><span className="block truncate text-[11px] text-faint">{t.blurb}</span></span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <button className="icon-btn !h-7 !w-7" onClick={() => newFolderIn(null)} title="New folder" aria-label="New folder" data-testid="ft-new-folder">
          <Icon name="folder-plus" size={14} />
        </button>
        <div className="relative">
          <button className="icon-btn !h-7 !w-7" data-on={moreOpen} onClick={() => setMoreOpen(!moreOpen)} title="Sort, import & export" aria-label="Sort and more" data-testid="ft-sort">
            <Icon name="sliders" size={14} />
          </button>
          {moreOpen && (
            <>
              <div className="fixed inset-0 z-[60]" onClick={() => setMoreOpen(false)} />
              <div className="menu panel panel-solid absolute left-0 top-9 z-[61] w-[230px] p-1.5" style={{ backdropFilter: "none" }}>
                <div className="label px-2 pb-1 pt-0.5">Sort</div>
                {SORTS.map((s) => (
                  <button key={s.id} className="ft-menu-item" data-testid={`ft-sort-${s.id}`} onClick={() => { setTree((t) => ({ ...t, sort: s.id })); setMoreOpen(false); }}>
                    <Icon name={s.icon} size={13} className={tree.sort === s.id ? "text-accent" : "text-faint"} />
                    {s.label}
                    {tree.sort === s.id && <Icon name="check" size={12} className="ml-auto text-accent" />}
                  </button>
                ))}
                <div className="my-1 h-px bg-line" />
                <button className="ft-menu-item" onClick={() => { st().exportNotes(); setMoreOpen(false); }}><Icon name="download" size={13} /> Export backup (JSON)</button>
                <button className="ft-menu-item" onClick={() => { pickImportFile(); setMoreOpen(false); }}><Icon name="upload" size={13} /> Import backup</button>
              </div>
            </>
          )}
        </div>
        <button className="icon-btn !h-7 !w-7" onClick={() => setTree((t) => ({ ...t, open: t.open.length ? [] : folders.map((f) => f.id) }))} title={tree.open.length ? "Collapse all" : "Expand all"} aria-label="Collapse all">
          <Icon name={tree.open.length ? "collapse" : "expand"} size={14} />
        </button>
        <span className="flex-1" />
        <span className="ft-total">{tagged.length}</span>
      </div>

      <div className="px-2 pb-1.5">
        <div className="relative">
          <Icon name="search" size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <input className="input !h-[28px] !pl-7 !text-[12.5px]" placeholder="Find or filter…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {tag && (
          <button className="chip mt-1.5" data-on onClick={() => st().set({ tag: null })}>
            #{tag} <Icon name="close" size={10} />
          </button>
        )}
      </div>

      <div className="scroll ft-scroll min-h-0 flex-1" role="tree" aria-label="Vault">
        {results ? (
          <>
            <div className="ft-section">Results · {results.length}</div>
            {results.map((n) => noteRow(n, 0))}
            {results.length === 0 && <div className="ft-empty">Nothing matches “{q}”.</div>}
          </>
        ) : (
          <>
            {(pinnedFolders.length > 0 || pinnedNotes.length > 0) && (
              <>
                <div className="ft-section"><span>★</span> Pinned</div>
                <div data-testid="ft-pinned">
                  {pinnedFolders.map((f) => (
                    <div key={`p-${f.id}`} className="ft-row ft-folder-row" style={{ ["--d" as string]: 0, ["--fc" as string]: f.color }} onClick={() => { toggle(f.id, true); st().setActiveFolder(f.id); }} onContextMenu={onCtx(() => folderMenu(f), { icon: "folder", title: f.name })}>
                      <span className="ft-chev-space" />
                      <FolderGlyph color={f.color} icon={f.icon} />
                      <span className="ft-name">{f.name}</span>
                      <span className="ft-count">{countOf(f.id)}</span>
                    </div>
                  ))}
                  {pinnedNotes.map((n) => noteRow(n, 0))}
                </div>
              </>
            )}
            <div
              className="ft-section ft-root"
              data-drop={drop?.id === "__root" ? "into" : undefined}
              onDragOver={(e) => {
                e.preventDefault();
                setDrop({ id: "__root", where: "into" });
              }}
              onDragLeave={() => setDrop((x) => (x?.id === "__root" ? null : x))}
              onDrop={onDrop(null)}
              data-testid="ft-root"
            >
              <Icon name="library" size={11} /> Vault
            </div>
            {rootFolders.map((f) => folderNode(f, 0, new Set()))}
            {rootNotes.map((n) => noteRow(n, 0))}
            {folders.length === 0 && notes.length === 0 && <div className="ft-empty">Your vault is empty — press <b>+</b> to write your first note.</div>}
          </>
        )}
      </div>

      {tags.length > 0 && (
        <div className="flex-none border-t border-line">
          <button className="flex w-full items-center gap-1 px-2 py-1.5 text-left" onClick={() => setShowTags(!showTags)} aria-expanded={showTags}>
            <Icon name={showTags ? "chevron-down" : "chevron-right"} size={11} className="text-faint" />
            <span className="ft-section !p-0">Tags</span>
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
