/** 1.3 quick switcher (Ctrl+O): fuzzy-jump to any note; Enter on no match creates it. Lazy-loaded. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { useStore } from "@/lib/store";
import { timeAgo } from "@/lib/util";

function score(q: string, t: string): number {
  if (!q) return 1;
  const s = t.toLowerCase();
  const i = s.indexOf(q);
  if (i >= 0) return 3 - i / 100 + (i === 0 ? 1 : 0);
  let j = 0;
  for (const ch of s) if (ch === q[j]) j++;
  return j === q.length ? 1 : 0;
}

export default function QuickSwitcher() {
  const notes = useStore((s) => s.notes);
  const folders = useStore((s) => s.folders);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  const close = () => useStore.setState({ switcherOpen: false });
  useEffect(() => ref.current?.focus(), []);
  const list = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return notes
      .map((n) => ({ n, s: score(ql, n.title || "Untitled") + (ql ? 0 : n.updatedAt / 1e14) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 12)
      .map((x) => x.n);
  }, [notes, q]);
  const go = (i: number) => {
    const n = list[i];
    if (n) useStore.getState().openNote(n.id);
    else if (q.trim()) useStore.getState().createNote({ title: q.trim() });
    close();
  };
  const fname = (id: string | null) => folders.find((f) => f.id === id)?.name;
  return (
    <div className="fixed inset-0 z-[220] grid place-items-start justify-center bg-black/30 pt-[14vh]" onMouseDown={close} data-testid="quick-switcher">
      <div className="panel panel-solid w-[min(560px,92vw)] overflow-hidden" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Quick switcher">
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Icon name="search" size={15} className="text-faint" />
          <input
            ref={ref}
            className="h-12 flex-1 bg-transparent text-[15px] outline-none"
            placeholder="Jump to a note… (Enter on a new name creates it)"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setIdx(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
              else if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(list.length - 1, i + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
              else if (e.key === "Enter") { e.preventDefault(); go(list.length ? idx : -1); }
            }}
            aria-label="Note name"
          />
          <span className="kbd">Ctrl O</span>
        </div>
        <div className="scroll max-h-[46vh] p-1.5">
          {list.map((n, i) => (
            <button key={n.id} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left" style={{ background: i === idx ? "var(--hl)" : undefined }} onMouseEnter={() => setIdx(i)} onClick={() => go(i)} data-testid="qs-item">
              <Icon name="note" size={13} className="text-faint" />
              <span className="min-w-0 flex-1 truncate text-[13.5px]">{n.title || "Untitled"}</span>
              {fname(n.folderId) && <span className="chip !h-5 !text-[10.5px]">{fname(n.folderId)}</span>}
              <span className="text-[11px] text-faint">{timeAgo(n.updatedAt)}</span>
            </button>
          ))}
          {list.length === 0 && (
            <button className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left" style={{ background: "var(--hl)" }} onClick={() => go(-1)}>
              <Icon name="plus" size={13} /> Create “{q.trim()}”
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
