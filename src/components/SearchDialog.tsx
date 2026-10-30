/** Ctrl+Shift+F — fast full-text search (SQLite FTS5 in Rust) with folder / tag / date filters. */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { useStore } from "@/lib/store";
import { useUi11 } from "@/lib/ui11";

type Hit = { id: string; title: string; folderId: string | null; tags: string[]; updatedAt: number; snippet: string };
type Res = { total: number; ms: number; hits: Hit[] };

function Snippet({ text }: { text: string }) {
  const parts = text.split(/\[\[hl\]\]|\[\[\/hl\]\]/);
  return (
    <>
      {parts.map((p, i) => (i % 2 ? <mark key={i} className="search-hl">{p}</mark> : <Fragment key={i}>{p}</Fragment>))}
    </>
  );
}

export default function SearchDialog() {
  const close = () => useUi11.getState().set({ searchOpen: false });
  const folders = useStore((s) => s.folders);
  const [q, setQ] = useState("");
  const [folder, setFolder] = useState("");
  const [tag, setTag] = useState("");
  const [when, setWhen] = useState("any");
  const [res, setRes] = useState<Res | null>(null);
  const [sel, setSel] = useState(0);
  const inRef = useRef<HTMLInputElement>(null);
  useEffect(() => inRef.current?.focus(), []);

  const params = useMemo(() => {
    const p = new URLSearchParams({ q, limit: "40" });
    if (folder) p.set("folder", folder);
    if (tag.trim()) p.set("tag", tag.trim());
    if (when !== "any") p.set("from", String(Date.now() - Number(when) * 86_400_000));
    return p.toString();
  }, [q, folder, tag, when]);

  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        setRes((await (await fetch(`/api/search?${params}`)).json()) as Res);
        setSel(0);
      } catch {
        /* ignore */
      }
    }, 90);
    return () => clearTimeout(t);
  }, [params]);

  const open = (h: Hit) => {
    const st = useStore.getState();
    st.setView("notes");
    st.openNote(h.id);
    close();
  };

  return (
    <div className="fixed inset-0 z-[90] grid place-items-start justify-center bg-black/45 pt-[9vh]" onMouseDown={(e) => e.target === e.currentTarget && close()} data-testid="search-dialog">
      <div className="panel panel-solid flex max-h-[76vh] w-[min(720px,94vw)] flex-col overflow-hidden rounded-[18px]" style={{ animation: "pop .18s var(--ease-soft) both" }}>
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Icon name="search" size={16} className="text-accent" />
          <input
            ref={inRef}
            className="flex-1 bg-transparent text-[15px] outline-none"
            placeholder="Search every word in your vault…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
              if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min((res?.hits.length ?? 1) - 1, s + 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
              if (e.key === "Enter" && res?.hits[sel]) open(res.hits[sel]);
            }}
            aria-label="Full-text search"
          />
          <span className="tiny-font text-[10px] text-faint">{res ? `${res.total} · ${res.ms.toFixed(1)}ms` : ""}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2 text-[12px]">
          <select className="input !h-7 !w-auto !text-[12px]" value={folder} onChange={(e) => setFolder(e.target.value)} aria-label="Folder filter">
            <option value="">All folders</option>
            <option value="none">No folder</option>
            {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <input className="input !h-7 !w-[130px] !text-[12px]" placeholder="#tag" value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Tag filter" />
          <select className="input !h-7 !w-auto !text-[12px]" value={when} onChange={(e) => setWhen(e.target.value)} aria-label="Date filter">
            <option value="any">Any time</option>
            <option value="1">Last 24 hours</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
          </select>
          <span className="ml-auto text-faint">↑↓ to move · Enter to open · Esc to close</span>
        </div>
        <div className="scroll min-h-0 flex-1 p-1.5" data-testid="search-results">
          {res && res.hits.length === 0 && <div className="px-3 py-6 text-center text-[13px] text-faint">No notes match. Try fewer words or clear a filter.</div>}
          {res?.hits.map((h, i) => (
            <button key={h.id} data-on={i === sel} className="block w-full rounded-xl px-3 py-2 text-left hover:bg-panel2 data-[on=true]:bg-panel2" onMouseEnter={() => setSel(i)} onClick={() => open(h)}>
              <div className="pixel-font flex items-center gap-2 text-[14px]">
                <Icon name="file-text" size={13} className="text-accent" /> <span className="truncate">{h.title}</span>
                <span className="ml-auto text-[10.5px] text-faint">{new Date(h.updatedAt).toLocaleDateString()}</span>
              </div>
              <div className="mt-0.5 line-clamp-2 text-[12px] text-dim"><Snippet text={h.snippet} /></div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
