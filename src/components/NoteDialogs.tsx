/** Version history (with restore) and "new note from template" dialogs. */
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Markdown } from "@/components/Markdown";
import { flushAll, useStore } from "@/lib/store";
import type { Note } from "@/lib/types";
import { useUi11 } from "@/lib/ui11";

type Version = { id: string; title: string; content: string; words: number; createdAt: number };
type Template = { id: string; name: string; icon: string; content: string; builtin: boolean };

function Shell({ title, onClose, children, testid }: { title: string; onClose: () => void; children: React.ReactNode; testid: string }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/45 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()} data-testid={testid}>
      <div className="panel panel-solid flex max-h-[82vh] w-[min(860px,94vw)] flex-col overflow-hidden rounded-[18px]" style={{ animation: "pop .18s var(--ease-soft) both" }}>
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <span className="pixel-font flex-1 text-[16px]">{title}</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" size={14} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Versions({ noteId }: { noteId: string }) {
  const close = () => useUi11.getState().set({ versionsFor: null });
  const note = useStore((s) => s.notes.find((n) => n.id === noteId));
  const [list, setList] = useState<Version[] | null>(null);
  const [sel, setSel] = useState<Version | null>(null);
  const load = async () => {
    const v = (await (await fetch(`/api/notes/${noteId}/versions`)).json()) as Version[];
    setList(v);
    setSel(v[0] ?? null);
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);
  const snapshot = async () => {
    await flushAll();
    await fetch(`/api/notes/${noteId}/versions`, { method: "POST" });
    useStore.getState().toast("Snapshot saved", "check");
    void load();
  };
  const restore = async (v: Version) => {
    const r = await fetch(`/api/notes/${noteId}/versions/${v.id}/restore`, { method: "POST" });
    if (!r.ok) return;
    const n = (await r.json()) as Note;
    useStore.setState((s) => ({ notes: s.notes.map((x) => (x.id === noteId ? { ...x, ...n } : x)) }));
    useStore.getState().toast(`Restored the version from ${new Date(v.createdAt).toLocaleString()}`, "refresh");
    close();
  };
  return (
    <Shell title={`Version history — ${note?.title ?? ""}`} onClose={close} testid="versions-dialog">
      <div className="grid min-h-0 flex-1 grid-cols-[240px_1fr]">
        <div className="scroll border-r border-line p-2">
          <button className="btn btn-sm mb-2 w-full justify-center" onClick={() => void snapshot()}><Icon name="plus" size={12} /> Save snapshot now</button>
          {list?.length === 0 && <div className="px-2 py-3 text-[12px] text-faint">No earlier versions yet. Nook keeps one every 5 minutes of editing (up to 50).</div>}
          {list?.map((v) => (
            <button key={v.id} data-on={sel?.id === v.id} className="block w-full rounded-lg px-2 py-1.5 text-left text-[12.5px] hover:bg-panel2 data-[on=true]:bg-panel2" onClick={() => setSel(v)}>
              <div>{new Date(v.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>
              <div className="text-[11px] text-faint">{v.words} words · {v.title}</div>
            </button>
          ))}
        </div>
        <div className="flex min-h-0 flex-col">
          <div className="scroll selectable min-h-0 flex-1 p-4 text-[13px]">{sel ? <Markdown source={sel.content} titles={new Set()} onLink={() => {}} /> : <div className="text-faint">Pick a version.</div>}</div>
          {sel && (
            <div className="flex items-center gap-2 border-t border-line px-4 py-2.5">
              <span className="text-[12px] text-faint">Restoring keeps your current text as a version too.</span>
              <span className="flex-1" />
              <button className="btn btn-accent btn-sm" onClick={() => void restore(sel)} data-testid="restore-version"><Icon name="refresh" size={12} /> Restore this version</button>
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}

function Templates() {
  const close = () => useUi11.getState().set({ templatesOpen: false });
  const [list, setList] = useState<Template[]>([]);
  const [sel, setSel] = useState<Template | null>(null);
  const [title, setTitle] = useState("");
  useEffect(() => {
    void (async () => {
      const t = (await (await fetch("/api/templates")).json()) as Template[];
      setList(t);
      setSel(t[0] ?? null);
    })();
  }, []);
  const create = async () => {
    if (!sel) return;
    const r = (await (await fetch(`/api/templates/${sel.id}/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) })).json()) as { title: string; content: string };
    const st = useStore.getState();
    st.setView("notes");
    st.createNote({ title: r.title, content: r.content });
    close();
  };
  const saveCurrent = async () => {
    const st = useStore.getState();
    const n = st.notes.find((x) => x.id === st.activeId);
    if (!n) return st.toast("Open a note first", "note");
    await fetch("/api/templates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: n.title, content: n.content }) });
    setList((await (await fetch("/api/templates")).json()) as Template[]);
    st.toast("Saved as a template", "check");
  };
  const remove = async (t: Template) => {
    await fetch(`/api/templates/${t.id}`, { method: "DELETE" });
    setList((l) => l.filter((x) => x.id !== t.id));
  };
  return (
    <Shell title="New note from a template" onClose={close} testid="templates-dialog">
      <div className="grid min-h-0 flex-1 grid-cols-[240px_1fr]">
        <div className="scroll border-r border-line p-2">
          {list.map((t) => (
            <div key={t.id} className="group flex items-center">
              <button data-on={sel?.id === t.id} className="flex flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] hover:bg-panel2 data-[on=true]:bg-panel2" onClick={() => setSel(t)}>
                <Icon name="file-text" size={13} className="text-accent" /> {t.name}
              </button>
              {!t.builtin && <button className="icon-btn !h-6 !w-6 opacity-0 group-hover:opacity-100" onClick={() => void remove(t)} aria-label="Delete template"><Icon name="trash" size={11} /></button>}
            </div>
          ))}
          <button className="btn btn-sm mt-2 w-full justify-center" onClick={() => void saveCurrent()}><Icon name="plus" size={12} /> Save open note as template</button>
        </div>
        <div className="flex min-h-0 flex-col">
          <div className="scroll selectable min-h-0 flex-1 p-4 text-[13px]">{sel && <Markdown source={sel.content.replace(/\{\{(\w+)\}\}/g, "‹$1›")} titles={new Set()} onLink={() => {}} />}</div>
          <div className="flex items-center gap-2 border-t border-line px-4 py-2.5">
            <input className="input !h-8 flex-1" placeholder={sel ? `Title (default: ${sel.name})` : "Title"} value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void create()} aria-label="New note title" />
            <button className="btn btn-accent btn-sm" onClick={() => void create()} disabled={!sel} data-testid="create-from-template"><Icon name="plus" size={12} /> Create note</button>
          </div>
        </div>
      </div>
    </Shell>
  );
}

export default function NoteDialogs() {
  const versionsFor = useUi11((s) => s.versionsFor);
  const templatesOpen = useUi11((s) => s.templatesOpen);
  return (
    <>
      {versionsFor && <Versions noteId={versionsFor} />}
      {templatesOpen && <Templates />}
    </>
  );
}
