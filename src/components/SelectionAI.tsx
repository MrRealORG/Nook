/** Inline AI on the editor selection: summarize, rewrite, translate, explain. */
import { useEffect, useRef, useState, type RefObject } from "react";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/icons";
import { Markdown } from "@/components/Markdown";
import { useStore } from "@/lib/store";

type Act = { action: string; label: string; icon: IconName; style?: string; replace: boolean };
const ACTS: Act[] = [
  { action: "summarize", label: "Summarize", icon: "file-text", replace: false },
  { action: "rewrite", label: "Rewrite", icon: "wand", style: "tidy", replace: true },
  { action: "translate", label: "Translate", icon: "globe", replace: true },
  { action: "explain", label: "Explain", icon: "lightbulb", replace: false },
];
const LANGS = ["English", "Urdu", "Spanish", "French", "German", "Arabic", "Chinese", "Japanese", "Hindi", "Turkish"];

export function SelectionAI({ taRef, noteId }: { taRef: RefObject<HTMLTextAreaElement | null>; noteId: string }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [range, setRange] = useState<[number, number] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [out, setOut] = useState<{ act: Act; text: string } | null>(null);
  const [lang, setLang] = useState(() => localStorage.getItem("nook:translate-lang") ?? "English");
  const mouse = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    const onMove = (e: MouseEvent) => (mouse.current = { x: e.clientX, y: e.clientY });
    const check = () => {
      const a = ta.selectionStart;
      const b = ta.selectionEnd;
      if (b - a >= 3 && ta.value.slice(a, b).trim()) {
        const r = ta.getBoundingClientRect();
        const x = Math.min(Math.max(mouse.current.x || r.left + 40, r.left + 8), r.right - 330);
        const y = Math.max((mouse.current.y || r.top + 30) - 44, 50);
        setRange([a, b]);
        setPos({ x, y });
      } else if (!busy && !out) {
        setPos(null);
        setRange(null);
      }
    };
    const onUp = () => setTimeout(check, 0);
    ta.addEventListener("mousemove", onMove);
    ta.addEventListener("mouseup", onUp);
    ta.addEventListener("keyup", onUp);
    ta.addEventListener("select", onUp);
    return () => {
      ta.removeEventListener("mousemove", onMove);
      ta.removeEventListener("mouseup", onUp);
      ta.removeEventListener("keyup", onUp);
      ta.removeEventListener("select", onUp);
    };
  }, [taRef, busy, out]);

  if (!pos || !range) return null;

  const run = async (act: Act) => {
    const ta = taRef.current;
    if (!ta) return;
    const text = ta.value.slice(range[0], range[1]);
    setBusy(act.action);
    try {
      const { handleAiRequest } = await import("@/server/aiRoute");
      const pet = useStore.getState().pet;
      const res = await handleAiRequest({ action: act.action, text, style: act.action === "translate" ? lang : act.style, noteId, persona: { name: pet.name, species: pet.species } });
      setOut({ act, text: res.text.trim() });
    } catch {
      useStore.getState().toast("The AI couldn't do that right now", "close");
    } finally {
      setBusy(null);
    }
  };
  const apply = (mode: "replace" | "below") => {
    const ta = taRef.current;
    if (!ta || !out) return;
    const st = useStore.getState();
    const note = st.notes.find((n) => n.id === noteId);
    if (!note) return;
    const v = note.content;
    const [a, b] = range;
    const next = mode === "replace" ? v.slice(0, a) + out.text + v.slice(b) : v.slice(0, b) + "\n\n" + out.text + "\n" + v.slice(b);
    st.updateNote(noteId, { content: next });
    st.toast(mode === "replace" ? "Replaced the selection" : "Inserted below", "check");
    setOut(null);
    setPos(null);
  };

  return (
    <div className="sel-ai" style={{ position: "fixed", left: pos.x, top: pos.y, flexDirection: out ? "column" : "row", maxWidth: 420 }} data-testid="selection-ai" onMouseDown={(e) => e.preventDefault()}>
      {!out ? (
        <>
          {ACTS.map((a) => (
            <button key={a.action} onClick={() => void run(a)} disabled={!!busy} title={a.action === "translate" ? `Translate to ${lang}` : a.label}>
              <Icon name={a.icon} size={12} /> {busy === a.action ? "…" : a.label}
            </button>
          ))}
          <select
            className="rounded-md bg-transparent px-1 text-[11.5px] text-dim outline-none"
            value={lang}
            onChange={(e) => {
              setLang(e.target.value);
              localStorage.setItem("nook:translate-lang", e.target.value);
            }}
            aria-label="Translate to"
          >
            {LANGS.map((l) => <option key={l}>{l}</option>)}
          </select>
          <button onClick={() => setPos(null)} aria-label="Close"><Icon name="close" size={11} /></button>
        </>
      ) : (
        <div className="w-[400px] max-w-[80vw] p-1.5">
          <div className="tiny-font mb-1 text-[10px] text-faint">{out.act.label.toUpperCase()}</div>
          <div className="selectable max-h-[220px] overflow-auto text-[12.5px]" data-testid="selection-ai-out"><Markdown source={out.text} titles={new Set()} onLink={() => {}} /></div>
          <div className="mt-2 flex flex-wrap gap-1">
            {out.act.replace && <button onClick={() => apply("replace")}><Icon name="check" size={11} /> Replace</button>}
            <button onClick={() => apply("below")}><Icon name="plus" size={11} /> Insert below</button>
            <button onClick={() => void navigator.clipboard?.writeText(out.text).catch(() => {})}><Icon name="copy" size={11} /> Copy</button>
            <button onClick={() => { setOut(null); setPos(null); }}><Icon name="close" size={11} /> Dismiss</button>
          </div>
        </div>
      )}
    </div>
  );
}
