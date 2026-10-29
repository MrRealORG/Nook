"use client";

import { useDeferredValue, useMemo } from "react";
import { AiChat } from "@/components/AiChat";
import { Icon } from "@/components/Icon";
import { Empty } from "@/components/ui";
import { related } from "@/lib/ai-local";
import { useActiveNote, useStore } from "@/lib/store";
import { parseNote, timeAgo, titleKey } from "@/lib/util";

function Section({ title, icon, children }: { title: string; icon: "link" | "hash" | "bulletlist" | "sparkle" | "file-text"; children: React.ReactNode }) {
  return (
    <section className="px-1">
      <div className="label mb-2 flex items-center gap-1.5"><Icon name={icon} size={11} />{title}</div>
      {children}
    </section>
  );
}

function Row({ label, hint, ghost, onClick }: { label: string; hint?: string; ghost?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className="group flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left transition-colors hover:bg-panel2">
      <span className="pixel-font min-w-0 flex-1 truncate text-[14.5px]" style={{ color: ghost ? "var(--faint)" : "var(--ink)", borderBottom: ghost ? "1px dashed var(--faint)" : undefined, width: "fit-content", flex: "0 1 auto" }}>{label}</span>
      {hint && <span className="ml-auto truncate text-[11.5px] text-faint">{hint}</span>}
    </button>
  );
}

function InfoTab() {
  const note = useActiveNote();
  const notes = useStore((s) => s.notes);
  const dn = useDeferredValue(notes);
  const content = useDeferredValue(note?.content ?? "");
  const st = useStore.getState;
  const meta = useMemo(() => parseNote(content), [content]);
  const byTitle = useMemo(() => new Map(notes.map((n) => [titleKey(n.title), n])), [notes]);
  const backlinks = useMemo(() => (note ? notes.filter((n) => n.id !== note.id && parseNote(n.content).links.some((l) => titleKey(l) === titleKey(note.title))) : []), [notes, note]);
  const rel = useMemo(() => (note ? related(note.id, dn, 4) : []), [dn, note]);

  if (!note) {
    let words = 0, links = 0;
    for (const n of notes) { const m = parseNote(n.content); words += m.words; links += m.links.length; }
    return (
      <div className="scroll min-h-0 flex-1 space-y-4 px-3 pb-4">
        <Empty icon={<Icon name="notes" size={28} />} title="No note open" hint="Pick a note on the left, or ask the AI tab anything about your vault." />
        <div className="grid grid-cols-3 gap-2">
          {[["notes", notes.length], ["words", words], ["links", links]].map(([l, v]) => (
            <div key={l} className="inset p-3 text-center"><div className="pixel-font text-[22px] text-accent">{v}</div><div className="label">{l}</div></div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="scroll min-h-0 flex-1 space-y-5 px-3 pb-5">
      <div className="grid grid-cols-3 gap-2">
        {[["words", meta.words], ["links", meta.links.length], ["tasks", meta.tasks.total ? `${meta.tasks.done}/${meta.tasks.total}` : "–"]].map(([l, v]) => (
          <div key={l} className="inset p-2.5 text-center"><div className="pixel-font text-[20px] text-accent">{v}</div><div className="label">{l}</div></div>
        ))}
      </div>
      <div className="pixel-font px-1 text-[12.5px] text-faint">Created {timeAgo(note.createdAt)} · edited {timeAgo(note.updatedAt)}</div>

      {meta.headings.length > 0 && (
        <Section title="Outline" icon="bulletlist">
          {meta.headings.map((h, i) => (
            <button key={i} onClick={() => window.dispatchEvent(new CustomEvent("nook:jump", { detail: { line: h.line, idx: i } }))} className="pixel-font block w-full truncate rounded-lg py-1 text-left text-[14px] text-dim transition-colors hover:text-accent" style={{ paddingLeft: 8 + (h.level - 1) * 14 }}>
              {h.text}
            </button>
          ))}
        </Section>
      )}

      {meta.tags.length > 0 && (
        <Section title="Tags" icon="hash">
          <div className="flex flex-wrap gap-1.5">
            {meta.tags.map((t) => <button key={t} className="chip" onClick={() => st().set({ tag: t })}>#{t}</button>)}
          </div>
        </Section>
      )}

      <Section title={`Links out · ${meta.links.length}`} icon="link">
        {meta.links.length === 0 && <div className="px-2.5 text-[12.5px] text-faint">Type [[ to link another note.</div>}
        {meta.links.map((l) => {
          const hit = byTitle.get(titleKey(l));
          return <Row key={l} label={l} ghost={!hit} hint={hit ? undefined : "create"} onClick={() => st().openByTitle(l)} />;
        })}
      </Section>

      <Section title={`Linked from · ${backlinks.length}`} icon="link">
        {backlinks.length === 0 && <div className="px-2.5 text-[12.5px] text-faint">No backlinks yet.</div>}
        {backlinks.map((b) => <Row key={b.id} label={b.title} hint={timeAgo(b.updatedAt)} onClick={() => st().openNote(b.id)} />)}
      </Section>

      {rel.length > 0 && (
        <Section title="Related · by meaning" icon="sparkle">
          {rel.map((r) => (
            <Row key={r.note.id} label={r.note.title} hint={r.shared.slice(0, 2).join(", ")} onClick={() => st().openNote(r.note.id)} />
          ))}
        </Section>
      )}
    </div>
  );
}

export function RightPanel() {
  const tab = useStore((s) => s.rightTab);
  const st = useStore.getState;
  return (
    <aside className="panel flex w-[338px] flex-none flex-col rounded-[18px]">
      <div className="flex items-center gap-2 p-3">
        <div className="seg flex-1">
          <button className="flex-1 justify-center" data-on={tab === "info"} onClick={() => useStore.setState({ rightTab: "info" })}><Icon name="file-text" size={13} /> Info</button>
          <button className="flex-1 justify-center" data-on={tab === "ai"} onClick={() => useStore.setState({ rightTab: "ai" })}><Icon name="sparkles" size={13} /> AI</button>
        </div>
        <button className="icon-btn" onClick={() => st().set({ rightOpen: false })} title="Hide panel (Ctrl+J)"><Icon name="close" size={15} /></button>
      </div>
      {tab === "info" ? <InfoTab /> : <AiChat compact />}
    </aside>
  );
}
