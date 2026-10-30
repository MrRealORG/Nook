
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/icons";
import { Markdown } from "@/components/Markdown";
import { PetView } from "@/components/PetView";
import { SPECIES } from "@/lib/pet";
import { useStore, type AiMsg } from "@/lib/store";
import { titleKey } from "@/lib/util";

const QUICK: { action: string; label: string; icon: IconName; style?: string }[] = [
  { action: "summarize", label: "Summarize", icon: "file-text" },
  { action: "continue", label: "Continue", icon: "pencil" },
  { action: "tags", label: "Tags", icon: "hash" },
  { action: "title", label: "Title", icon: "label" },
  { action: "links", label: "Links", icon: "link" },
  { action: "outline", label: "Outline", icon: "bulletlist" },
  { action: "brainstorm", label: "Sparks", icon: "lightbulb" },
  { action: "rewrite", label: "Tidy", icon: "wand", style: "tidy" },
  { action: "rewrite", label: "Concise", icon: "cut", style: "concise" },
  { action: "rewrite", label: "Bullets", icon: "bulletlist", style: "bullets" },
  { action: "rewrite", label: "Tasks", icon: "checkbox-on", style: "tasks" },
];

/** harness quick runs — the AI acts for real instead of just chatting */
const AGENT: { q: string; label: string; icon: IconName }[] = [
  { q: "Give me a status report: vault stats, open tasks, my pet's mood and today's tracked time.", label: "Status report", icon: "gauge" },
  { q: "Check my open tasks and the vault, then create up to 4 focused tasks for today.", label: "Plan my day", icon: "tasklist" },
  { q: "Tidy up: clear every completed task and tell me what's left.", label: "Tidy tasks", icon: "wand" },
  { q: "How much time did I track today and which app dominated?", label: "Time report", icon: "activity" },
];

function useTyped(text: string, fresh: boolean, done: () => void) {
  const [n, setN] = useState(fresh ? 0 : text.length);
  useEffect(() => {
    if (!fresh) return;
    let raf = 0;
    const t0 = performance.now();
    const loop = (now: number) => {
      const k = Math.min(text.length, Math.floor(((now - t0) / 1000) * 260));
      setN(k);
      if (k < text.length) raf = requestAnimationFrame(loop);
      else done();
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
     
  }, [text, fresh]);
  return text.slice(0, n);
}

function Msg({ m }: { m: AiMsg }) {
  const st = useStore.getState;
  const species = useStore((s) => s.pet.species);
  const notes = useStore((s) => s.notes);
  const activeId = useStore((s) => s.activeId);
  const shown = useTyped(m.text, !!m.fresh, () => st().markAiSeen(m.id));
  const typing = m.fresh && shown.length < m.text.length;
  const titles = new Set(notes.map((n) => titleKey(n.title)));
  const res = m.res;
  const hi = SPECIES[species].hi;
  const clean = (t: string) => (t.startsWith(hi) ? t.slice(hi.length).replace(/\n\n\*.*\*\s*$/, "").trim() : t).trim();
  const note = notes.find((n) => n.id === activeId);

  const append = (text: string) => {
    if (!note) return st().toast("Open a note first", "note");
    st().updateNote(note.id, { content: note.content.replace(/\s*$/, "") + "\n\n" + text.trim() + "\n" });
    st().toast("Added to your note", "check");
  };
  const addTag = (t: string) => {
    if (!note) return;
    const lines = note.content.replace(/\s*$/, "").split("\n");
    const last = lines[lines.length - 1] ?? "";
    if (/^(#[\w-]+\s*)+$/.test(last.trim()) && last.trim()) lines[lines.length - 1] = `${last.trim()} #${t}`;
    else lines.push("", `#${t}`);
    st().updateNote(note.id, { content: lines.join("\n") + "\n" });
    st().doAct("happy", 900);
  };

  if (m.role === "user")
    return (
      <div className="flex justify-end" style={{ animation: "rise .3s var(--ease-soft)" }}>
        <div className="pixel-font max-w-[88%] rounded-2xl rounded-br-md bg-accent px-3.5 py-2 text-[14px] text-accent-ink">{m.text}</div>
      </div>
    );

  const tools = res?.tools ?? [];
  const canInsert = !!note && ["continue", "summarize", "brainstorm", "outline", "rewrite"].includes(m.action ?? "");
  return (
    <div className="flex gap-2.5" style={{ animation: "rise .35s var(--ease-soft)" }}>
      <div className="relative mt-1 h-7 w-7 flex-none overflow-hidden rounded-lg border border-line bg-panel2">
        <PetView species={species} scale={0.9} fps={4} style={{ marginTop: -2, marginLeft: 1 }} />
        {!!tools.length && <i className="tool-badge" />}
      </div>
      <div className="min-w-0 flex-1">
        {/* harness tool cards — proof of real work */}
        {!typing && tools.length > 0 && (
          <div className="mb-1.5 space-y-1">
            {tools.map((t, i) => (
              <details key={`${t.name}-${i}`} className="tool-card" data-ok={t.ok} style={{ animation: `rise .35s var(--ease-soft) both`, animationDelay: `${i * 60}ms` }}>
                <summary>
                  <span className="tool-dot" />
                  <span className="pixel-font flex-1 truncate">{t.name.replace(/_/g, " ")}</span>
                  <span className="tiny-font text-[9.5px] opacity-70">{t.ms}ms</span>
                  <Icon name={t.ok ? "check" : "close"} size={11} style={{ color: t.ok ? "var(--accent)" : "#e0684f" }} />
                </summary>
                <div className="px-2.5 pb-2 pt-1 text-[11.5px] leading-snug text-dim">{t.summary}</div>
              </details>
            ))}
            <div className="tool-proof"><Icon name="sparkles" size={11} /> real work — {tools.length} tool{tools.length > 1 ? "s" : ""} ran on the server</div>
          </div>
        )}
        <div className={`rounded-2xl rounded-tl-md border border-line bg-panel2 px-3.5 py-2.5 ${typing ? "typing" : ""}`}>
          <div className="text-[14px] leading-relaxed [&_.md]:text-[14px] [&_.md]:leading-[1.65] [&_.md_li]:my-0.5">
            <Markdown source={shown} titles={titles} onLink={(t) => st().openByTitle(t)} />
          </div>
          {!typing && res?.tags && res.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {res.tags.map((t) => (
                <button key={t} className="chip" onClick={() => addTag(t)} title="Add to note">+ #{t}</button>
              ))}
            </div>
          )}
          {!typing && res?.title && note && (
            <button className="btn btn-sm mt-2" onClick={() => { st().renameNote(note.id, res.title!); st().toast("Title updated", "label"); }}>
              <Icon name="check" size={12} /> Use this title
            </button>
          )}
          {!typing && res?.links && res.links.length > 0 && (
            <div className="mt-2 space-y-1">
              {res.links.map((l) => (
                <div key={l.id} className="flex items-center gap-2 rounded-xl border border-line px-2.5 py-1.5">
                  <button className="pixel-font min-w-0 flex-1 text-left text-[14px]" onClick={() => st().openNote(l.id)}>
                    <div className="truncate text-accent">{l.title}</div>
                    <div className="truncate text-[11.5px] text-faint">{l.reason}</div>
                  </button>
                  <button className="icon-btn !h-7 !w-7" title="Insert [[link]]" onClick={() => append(`[[${l.title}]]`)}>
                    <Icon name="plus" size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        {!typing && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-faint">
            {canInsert && (
              <button className="chip" onClick={() => append(clean(m.text))}><Icon name="plus" size={11} /> Insert</button>
            )}
            {canInsert && m.action === "rewrite" && note && (
              <button className="chip" onClick={() => { st().updateNote(note.id, { content: clean(m.text) }); st().toast("Note rewritten", "wand"); }}>Replace note</button>
            )}
            <button className="chip" onClick={() => { void navigator.clipboard?.writeText(clean(m.text)); st().toast("Copied", "copy"); }}><Icon name="copy" size={11} /></button>
            {res?.sources?.slice(0, 3).map((s) => (
              <button key={s.id} className="chip" onClick={() => st().openNote(s.id)}><Icon name="note" size={11} />{s.title}</button>
            ))}
            <span className="tiny-font ml-auto opacity-70">{res?.mode === "cloud" ? "cloud model" : "local brain"}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function AiChat({ compact = false }: { compact?: boolean }) {
  const log = useStore((s) => s.aiLog);
  const busy = useStore((s) => s.aiBusy);
  const pet = useStore((s) => s.pet);
  const hasNote = useStore((s) => !!s.activeId);
  const [q, setQ] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const st = useStore.getState;

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [log.length, busy, log[log.length - 1]?.fresh]);

  const send = () => {
    const t = q.trim();
    if (!t) return;
    setQ("");
    void st().runAi("agent", { question: t });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="scroll min-h-0 flex-1 space-y-3.5 px-3.5 pb-3 pt-1">
        {log.length === 0 && (
          <div className="grid place-items-center gap-3 px-3 pb-4 pt-6 text-center">
            <PetView species={pet.species} tint={pet.look} hat={pet.hat} scale={compact ? 3 : 4} mood="think" />
            <div className="pixel-font text-[17px]">Ask {pet.name} — I can do things</div>
            <div className="max-w-[270px] text-[12.5px] leading-relaxed text-dim">
              I run real tools: create & tidy tasks, read your vault, feed me, report your app time, even search the live web. Try:
            </div>
            <div className="flex flex-wrap justify-center gap-1.5">
              {["add task: stretch for 5 minutes", "status report", "tidy finished tasks", "what did I track today?"].map((x) => (
                <button key={x} className="chip" onClick={() => void st().runAi("agent", { question: x })}>{x}</button>
              ))}
            </div>
          </div>
        )}
        {log.map((m) => <Msg key={m.id} m={m} />)}
        {busy && (
          <div className="flex items-center gap-2.5 pl-1">
            <div className="research-avatar"><PetView species={pet.species} tint={pet.look} hat={pet.hat} mood="think" scale={1} fps={9} /></div>
            <div className="min-w-0 flex-1">
              <div className="pixel-font typing text-[13px] text-dim">{pet.name} is researching</div>
              <div className="research-line mt-1.5"><i /></div>
            </div>
          </div>
        )}
        <div ref={end} />
      </div>
      <div className="border-t border-line px-3 pb-3 pt-2.5">
        {/* harness row — always available, no note needed */}
        <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1">
          {AGENT.map((a) => (
            <button key={a.label} className="chip flex-none" disabled={busy} onClick={() => void st().runAi("agent", { question: a.q })} title={a.q}>
              <Icon name={a.icon} size={11} /> {a.label}
            </button>
          ))}
        </div>
        <div className="mb-2 flex flex-wrap gap-1.5" style={{ opacity: hasNote ? 1 : 0.45 }}>
          {QUICK.map((a) => (
            <button key={a.label} className="chip" disabled={!hasNote || busy} onClick={() => void st().runAi(a.action, { style: a.style, label: a.style ? `Rewrite: ${a.label.toLowerCase()}` : undefined })}>
              <Icon name={a.icon} size={11} /> {a.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <input
            className="input"
            placeholder={`Ask ${pet.name} to do something…`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
          />
          <button className="btn btn-accent !w-[38px] !px-0" onClick={send} disabled={busy || !q.trim()} aria-label="Send">
            <Icon name="send" size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
