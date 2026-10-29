"use client";

import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/icons";
import { Markdown } from "@/components/Markdown";
import { MicButton } from "@/components/MicButton";
import ShareDialog from "@/components/ShareDialog";
import { onCtx, openCtx, type CtxItem } from "@/components/ContextMenu";
import { Tilt } from "@/components/ui";
import { activity } from "@/lib/activity";
import { useStore, type EditorMode } from "@/lib/store";
import { countWords, parseNote, timeAgo, titleKey } from "@/lib/util";

const COVERS = [null, "/art/cover-peaks.webp", "/art/cover-city.webp", "/art/cover-forest.webp"];

function insertText(ta: HTMLTextAreaElement, text: string) {
  ta.focus();
  if (!document.execCommand("insertText", false, text)) {
    const s = ta.selectionStart;
    ta.setRangeText(text, s, ta.selectionEnd, "end");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

const MIRROR = ["box-sizing", "width", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "padding-top", "padding-right", "padding-bottom", "padding-left", "border-top-width", "border-left-width", "tab-size"];
const NO_ATTS: AttMetaT[] = [];
type AttMetaT = { id: string; noteId: string; name: string; mime: string; size: number; createdAt: string };
function caretXY(ta: HTMLTextAreaElement, pos: number) {
  const d = document.createElement("div");
  const cs = getComputedStyle(ta);
  MIRROR.forEach((p) => d.style.setProperty(p, cs.getPropertyValue(p)));
  Object.assign(d.style, { position: "absolute", visibility: "hidden", whiteSpace: "pre-wrap", overflowWrap: "break-word", top: "0", left: "-9999px" });
  d.textContent = ta.value.slice(0, pos);
  const span = document.createElement("span");
  span.textContent = "\u200b";
  d.appendChild(span);
  document.body.appendChild(d);
  const r = { x: span.offsetLeft, y: span.offsetTop, lh: parseFloat(cs.lineHeight) || 28 };
  document.body.removeChild(d);
  return r;
}

type PopKind = "link" | "slash" | "mention";
type Pop = { kind: PopKind; start: number; q: string; x: number; y: number; idx: number };

// ---------- slash commands ----------
type SlashHelpers = {
  replace: (text: string, caretBack?: number) => void;
  attach: () => void;
  voice: () => void;
};
type SlashCmd = { id: string; name: string; icon: IconName; hint: string; group: string; run: (h: SlashHelpers) => void };

const longDate = () => new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
const shortTime = () => new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

const SLASH_GROUPS = ["Text", "Insert", "Actions"];
const SLASH_COMMANDS: SlashCmd[] = [
  { id: "h1", name: "Heading 1", icon: "heading-1", hint: "Big section title", group: "Text", run: (h) => h.replace("# ") },
  { id: "h2", name: "Heading 2", icon: "heading-2", hint: "Section title", group: "Text", run: (h) => h.replace("## ") },
  { id: "h3", name: "Heading 3", icon: "heading-3", hint: "Small title", group: "Text", run: (h) => h.replace("### ") },
  { id: "bullet", name: "Bullet list", icon: "bulletlist", hint: "- item", group: "Text", run: (h) => h.replace("- ") },
  { id: "num", name: "Numbered list", icon: "tasklist", hint: "1. item", group: "Text", run: (h) => h.replace("1. ") },
  { id: "todo", name: "To-do checkbox", icon: "checkbox", hint: "- [ ] task", group: "Text", run: (h) => h.replace("- [ ] ") },
  { id: "quote", name: "Quote", icon: "quote-text-inline", hint: "> wisdom", group: "Text", run: (h) => h.replace("> ") },
  { id: "code", name: "Code block", icon: "code", hint: "``` fenced", group: "Text", run: (h) => h.replace("\n```\ncode\n```\n") },
  { id: "divider", name: "Divider", icon: "minus", hint: "--- line", group: "Text", run: (h) => h.replace("\n---\n") },
  { id: "table", name: "Table", icon: "grid", hint: "2 columns", group: "Insert", run: (h) => h.replace("\n| Column A | Column B |\n| --- | --- |\n|  |  |\n") },
  { id: "date", name: "Today's date", icon: "calendar", hint: longDate(), group: "Insert", run: (h) => h.replace(longDate()) },
  { id: "time", name: "Time now", icon: "clock", hint: shortTime(), group: "Insert", run: (h) => h.replace(shortTime()) },
  { id: "notelink", name: "Link to note", icon: "link", hint: "[[note]]", group: "Insert", run: (h) => h.replace("[[") },
  { id: "mention", name: "Mention someone", icon: "at", hint: "@task / note / person", group: "Insert", run: (h) => h.replace("@") },
  { id: "tag", name: "Tag", icon: "hash", hint: "#topic", group: "Insert", run: (h) => h.replace("#") },
  { id: "attach", name: "Attach file", icon: "paperclip", hint: "or drop / paste", group: "Insert", run: (h) => h.attach() },
  { id: "voice", name: "Voice typing", icon: "mic", hint: "speak, then click to stop", group: "Insert", run: (h) => h.voice() },
  { id: "askai", name: "Ask the AI", icon: "sparkles", hint: "open the companion panel", group: "Actions", run: () => useStore.setState({ rightOpen: true, rightTab: "ai" }) },
  { id: "totask", name: "Send line to Tasks", icon: "tasklist", hint: "create a task from this line", group: "Actions", run: (h) => h.replace("\u0000TASK") },
];

const TOOLS: { icon: IconName; tip: string; run: (ta: HTMLTextAreaElement) => void }[] = [];

/** Obsidian-style format helpers reused by the right-click menu */
const sel = (ta: HTMLTextAreaElement) => ta.value.slice(ta.selectionStart, ta.selectionEnd);
const hasSel = (ta: HTMLTextAreaElement) => ta.selectionStart !== ta.selectionEnd;
const pasteFromClipboard = async (ta: HTMLTextAreaElement, plain: boolean) => {
  try {
    const text = await navigator.clipboard.readText();
    insertText(ta, plain ? text.replace(/[*_`#>\[\]]/g, "") : text);
  } catch {
    useStore.getState().toast("Clipboard is blocked here — use Ctrl+V instead", "alert");
  }
};
/** build the full Obsidian-style editor context menu for the textarea */
function editorMenu(ta: HTMLTextAreaElement, extra: { attach: () => void; voice: () => void }): CtxItem[] {
  return [
    {
      icon: "link",
      label: "Add link",
      run: () => {
        const s = ta.selectionStart;
        insertText(ta, `[[${sel(ta) || ""}]]`);
        ta.setSelectionRange(s + 2, s + 2 + (sel(ta) ? 0 : 0));
        detectLater(ta);
      },
    },
    {
      icon: "external-link",
      label: "Add external link",
      run: () => {
        const label = sel(ta) || "label";
        insertText(ta, `[${label}](https://)`);
        const at = ta.value.indexOf("](https://)", ta.selectionStart - 1);
        if (at > -1) ta.setSelectionRange(at + 10, at + 18);
      },
    },
    { sep: true },
    {
      icon: "pen-ruler",
      label: "Format",
      sub: [
        { icon: "type", label: "Bold", shortcut: "Ctrl+B", disabled: !hasSel(ta), run: () => wrap(ta, "**") },
        { icon: "type", label: "Italic", shortcut: "Ctrl+I", disabled: !hasSel(ta), run: () => wrap(ta, "*") },
        { icon: "minus", label: "Strikethrough", disabled: !hasSel(ta), run: () => wrap(ta, "~~") },
        { icon: "code", label: "Code", disabled: !hasSel(ta), run: () => wrap(ta, "`") },
        { icon: "sparkle", label: "Highlight", disabled: !hasSel(ta), run: () => wrap(ta, "==") },
      ],
    },
    {
      icon: "heading",
      label: "Paragraph",
      sub: [
        { icon: "heading-1", label: "Heading 1", run: () => prefix(ta, "# ") },
        { icon: "heading-2", label: "Heading 2", run: () => prefix(ta, "## ") },
        { icon: "heading-3", label: "Heading 3", run: () => prefix(ta, "### ") },
        { icon: "quote-text-inline", label: "Quote", run: () => prefix(ta, "> ") },
        { icon: "bulletlist", label: "Bullet list", run: () => prefix(ta, "- ") },
        { icon: "checkbox", label: "To-do", run: () => prefix(ta, "- [ ] ") },
        { sep: true },
        {
          icon: "type",
          label: "Plain paragraph",
          run: () => {
            const pos = ta.selectionStart;
            const ls = ta.value.lastIndexOf("\n", pos - 1) + 1;
            const le = ta.value.indexOf("\n", ls) === -1 ? ta.value.length : ta.value.indexOf("\n", ls);
            const line = ta.value.slice(ls, le);
            ta.setSelectionRange(ls, le);
            insertText(ta, line.replace(/^(#{1,6}\s|>\s?|[-*+]\s|\d+\.\s|\[\s?\]\s?)/, ""));
          },
        },
      ],
    },
    {
      icon: "plus",
      label: "Insert",
      sub: [
        { icon: "grid", label: "Table", run: () => insertText(ta, "\n| Column | Column | Column |\n| --- | --- | --- |\n|  |  |  |\n") },
        { icon: "code", label: "Code block", run: () => insertText(ta, "\n```\ncode\n```\n") },
        { icon: "minus", label: "Divider", run: () => insertText(ta, "\n---\n") },
        { sep: true },
        { icon: "link", label: "Link to note", run: () => { insertText(ta, "[["); detectLater(ta); } },
        { icon: "hash", label: "Tag", run: () => { insertText(ta, "#"); detectLater(ta); } },
        { icon: "at", label: "Mention", run: () => { insertText(ta, "@"); detectLater(ta); } },
        { sep: true },
        { icon: "paperclip", label: "Attachment", run: extra.attach },
        { icon: "mic", label: "Voice typing", run: extra.voice },
        { icon: "calendar", label: "Today's date", run: () => insertText(ta, longDate()) },
      ],
    },
    { sep: true },
    {
      icon: "cut",
      label: "Cut",
      disabled: !hasSel(ta),
      run: () => {
        try { document.execCommand("cut"); } catch { /* noop */ }
      },
    },
    {
      icon: "copy",
      label: "Copy",
      disabled: !hasSel(ta),
      run: () => {
        try { document.execCommand("copy"); } catch { /* noop */ }
      },
    },
    { icon: "copy", label: "Paste", shortcut: "Ctrl+V", run: () => void pasteFromClipboard(ta, false) },
    { icon: "copy", label: "Paste as plain text", run: () => void pasteFromClipboard(ta, true) },
    { sep: true },
    { icon: "text-colums", label: "Select all", shortcut: "Ctrl+A", run: () => ta.select() },
  ];
}
/** re-run the [[ / @ / # popup detection after a menu insert */
function detectLater(ta: HTMLTextAreaElement) {
  setTimeout(() => ta.dispatchEvent(new Event("input", { bubbles: true })), 0);
}
function wrap(ta: HTMLTextAreaElement, a: string, b = a) {
  const s = ta.selectionStart, e = ta.selectionEnd;
  const sel = ta.value.slice(s, e) || "text";
  insertText(ta, a + sel + b);
  ta.setSelectionRange(s + a.length, s + a.length + sel.length);
}
function prefix(ta: HTMLTextAreaElement, p: string) {
  const pos = ta.selectionStart;
  const ls = ta.value.lastIndexOf("\n", pos - 1) + 1;
  const has = ta.value.startsWith(p, ls);
  ta.setSelectionRange(ls, has ? ls + p.length : ls);
  insertText(ta, has ? "" : p);
}
TOOLS.push(
  { icon: "heading-1", tip: "Heading 1", run: (t) => prefix(t, "# ") },
  { icon: "heading-2", tip: "Heading 2", run: (t) => prefix(t, "## ") },
  { icon: "bulletlist", tip: "Bullet list", run: (t) => prefix(t, "- ") },
  { icon: "checkbox", tip: "Checklist", run: (t) => prefix(t, "- [ ] ") },
  { icon: "quote-text-inline", tip: "Quote", run: (t) => prefix(t, "> ") },
  { icon: "code", tip: "Code", run: (t) => wrap(t, "`") },
  { icon: "link", tip: "Link to note", run: (t) => { insertText(t, "[["); } },
  { icon: "hash", tip: "Tag", run: (t) => insertText(t, "#") },
);

/** inline tag editor — chips with quick add/remove, saved to the note's tags column */
function TagEditor({ noteId, tags }: { noteId: string; tags: string[] }) {
  const [adding, setAdding] = useState(false);
  const [val, setVal] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);
  const commit = () => {
    const v = val.trim();
    if (v) useStore.getState().setNoteTags(noteId, [...tags, v]);
    setVal("");
    setAdding(false);
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {(tags ?? []).map((t) => (
        <span key={t} className="chip group !pr-1" data-on="true">
          <button className="inline-flex items-center gap-1" onClick={() => useStore.getState().set({ tag: t })} title={`Filter notes by #${t}`}>
            #{t}
          </button>
          <button
            className="opacity-40 transition-opacity hover:opacity-100"
            onClick={() => useStore.getState().setNoteTags(noteId, tags.filter((x) => x !== t))}
            title={`Remove tag #${t}`}
            aria-label={`Remove tag ${t}`}
          >
            ×
          </button>
        </span>
      ))}
      {adding ? (
        <input
          ref={inputRef}
          className="input !h-[24px] !w-[110px] !py-0 !text-[11px]"
          placeholder="tag name…"
          value={val}
          maxLength={24}
          onChange={(e) => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") { setVal(""); setAdding(false); }
          }}
        />
      ) : (
        <button className="chip !py-0 opacity-70 transition-opacity hover:opacity-100" onClick={() => setAdding(true)} title="Add a tag">
          <Icon name="label" size={11} /> tag
        </button>
      )}
    </span>
  );
}

export function Editor({ id }: { id: string }) {
  const note = useStore((s) => s.notes.find((n) => n.id === id));
  const notes = useStore((s) => s.notes);
  const mode = useStore((s) => s.editorMode);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState(note?.title ?? "");
  const [pop, setPop] = useState<Pop | null>(null);
  const [sure, setSure] = useState(false);
  const [noteMenu, setNoteMenu] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const content = note?.content ?? "";
  const deferred = useDeferredValue(content);
  const st = useStore.getState;

  const titlesKey = notes.map((n) => titleKey(n.title)).join("\n");
  const titles = useMemo(() => new Set(titlesKey.split("\n")), [titlesKey]);

  // note outline (headings) — powers the TOC popover
  const outline = useMemo(() => {
    const out: { line: number; level: number; text: string }[] = [];
    content.split("\n").forEach((l, i) => {
      const m = /^(#{1,3})\s+(.*)$/.exec(l);
      if (m) out.push({ line: i, level: m[1].length, text: m[2].trim() });
    });
    return out;
  }, [content]);

  const jumpToHeading = (h: { line: number; level: number; text: string }) => {
    const ta = taRef.current;
    if (ta && mode !== "read") {
      const lines = content.split("\n");
      const idx = lines.slice(0, h.line).reduce((a, l) => a + l.length + 1, 0);
      ta.focus();
      ta.setSelectionRange(idx, idx + lines[h.line].length);
      requestAnimationFrame(() => { ta.blur(); ta.focus(); });
    } else {
      const el = scroller.current;
      if (!el) return;
      const heads = Array.from(el.querySelectorAll("h1, h2, h3"));
      const target = heads.find((x) => (x.textContent ?? "").trim() === h.text);
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const [syncedTitle, setSyncedTitle] = useState(note?.title ?? "");
  if ((note?.title ?? "") !== syncedTitle) {
    setSyncedTitle(note?.title ?? "");
    setTitle(note?.title ?? "");
  }
  const attsMap = useStore((s) => s.attachments);
  const atts = attsMap[id] ?? NO_ATTS;
  const attBusy = useRef(false);
  const attInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void st().loadAtts(id);
  }, [id]);
  const uploadFiles = (files: FileList | File[]) => {
    if (attBusy.current) return;
    const list = [...files].filter((f) => f.size <= 8 * 1024 * 1024);
    if (!list.length) return;
    attBusy.current = true;
    void (async () => {
      for (const f of list) await st().uploadAtt(id, f);
      attBusy.current = false;
    })();
  };
  const voiceToggle = useRef<() => void>(() => {});
  useEffect(() => {
    if (note && note.title === "Untitled" && !note.content) titleRef.current?.select();

  }, []);

  const fit = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = `${Math.max(ta.scrollHeight, 360)}px`;
  };
  useLayoutEffect(fit, [content, mode]);
  useEffect(() => {
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  // outline jumps
  useEffect(() => {
    const h = (e: Event) => {
      const { line, idx } = (e as CustomEvent<{ line: number; idx: number }>).detail;
      const sc = scroller.current;
      const ta = taRef.current;
      if (ta && st().editorMode !== "read") {
        const off = content.split("\n").slice(0, line).reduce((a, l) => a + l.length + 1, 0);
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(off, off);
        const { y } = caretXY(ta, off);
        sc?.scrollTo({ top: ta.offsetTop + y - 140, behavior: "smooth" });
      } else {
        const el = scroller.current?.querySelectorAll(".md h1, .md h2, .md h3")[idx] as HTMLElement | undefined;
        if (el && sc) sc.scrollTo({ top: el.offsetTop - 100, behavior: "smooth" });
      }
    };
    window.addEventListener("nook:jump", h);
    return () => window.removeEventListener("nook:jump", h);
  }, [content, st]);

  const meta = useMemo(() => parseNote(deferred), [deferred]);
  const backlinks = useMemo(() => {
    if (!note) return [];
    const k = titleKey(note.title);
    const linkToken = `](note:${id})`;
    return notes.filter((n) => n.id !== id && (parseNote(n.content).links.some((l) => titleKey(l) === k) || n.content.includes(linkToken)));
  }, [notes, id, note]);

  // ---------- suggestion lists for the three popup kinds ----------
  const linkSugg = useMemo(() => {
    if (pop?.kind !== "link") return [];
    const q = pop.q.toLowerCase();
    const list = notes.filter((n) => n.id !== id && n.title.toLowerCase().includes(q)).slice(0, 6).map((n) => ({ title: n.title, create: false }));
    if (q && !notes.some((n) => titleKey(n.title) === q)) list.push({ title: pop.q, create: true });
    return list;
  }, [pop, notes, id]);

  const slashSugg = useMemo(() => {
    if (pop?.kind !== "slash") return [];
    const q = pop.q.trim().toLowerCase();
    return SLASH_COMMANDS.filter((c) => !q || c.name.toLowerCase().includes(q) || c.id.includes(q));
  }, [pop]);

  type MentionSugg = { label: string; sub: string; icon: IconName; insert: string };
  const mentionSugg = useMemo(() => {
    if (pop?.kind !== "mention") return [];
    const q = pop.q.trim().toLowerCase();
    const out: MentionSugg[] = [];
    for (const t of st().tasks.filter((t) => !t.done && t.title.toLowerCase().includes(q)).slice(0, 4))
      out.push({ label: t.title, sub: "task", icon: "checkbox-on", insert: `[@${t.title}](task:${t.id})` });
    for (const n of notes.filter((n) => n.id !== id && n.title.toLowerCase().includes(q)).slice(0, 4))
      out.push({ label: n.title, sub: "note", icon: "note", insert: `[@${n.title}](note:${n.id})` });
    const me = st().profile.displayName || "You";
    if ("you me".includes(q) || me.toLowerCase().includes(q)) out.push({ label: me, sub: "person", icon: "user", insert: `@${me}` });
    const pet = st().pet;
    if (pet.name.toLowerCase().includes(q)) out.push({ label: pet.name, sub: "companion", icon: "sparkle", insert: `@${pet.name}` });
    return out.slice(0, 9);
  }, [pop, notes, id, st]);

  const suggLen = pop?.kind === "link" ? linkSugg.length : pop?.kind === "slash" ? slashSugg.length : mentionSugg.length;

  if (!note) return null;

  const detect = (ta: HTMLTextAreaElement) => {
    const pos = ta.selectionStart;
    if (ta.selectionEnd !== pos) return setPop(null);
    // 1) [[note links
    const link = /\[\[([^\]\n]{0,40})$/.exec(ta.value.slice(0, pos));
    if (link) {
      const { x, y, lh } = caretXY(ta, pos - link[0].length);
      return setPop((p) => ({ kind: "link", start: pos - link[1].length, q: link[1], x: Math.min(x, ta.clientWidth - 270), y: y + lh, idx: p && p.kind === "link" && p.q === link[1] ? p.idx : 0 }));
    }
    // 2) / slash commands (typed at line start or after a space)
    const slash = /(^|\s)\/([\w -]{0,20})$/.exec(ta.value.slice(0, pos));
    if (slash) {
      const start = pos - slash[2].length - 1;
      const { x, y, lh } = caretXY(ta, start);
      return setPop((p) => ({ kind: "slash", start, q: slash[2], x: Math.min(x, ta.clientWidth - 300), y: y + lh, idx: p && p.kind === "slash" && p.q === slash[2] ? p.idx : 0 }));
    }
    // 3) @ mentions
    const at = /(^|\s)@([\w .-]{0,24})$/.exec(ta.value.slice(0, pos));
    if (at) {
      const start = pos - at[2].length - 1;
      const { x, y, lh } = caretXY(ta, start);
      return setPop((p) => ({ kind: "mention", start, q: at[2], x: Math.min(x, ta.clientWidth - 290), y: y + lh, idx: p && p.kind === "mention" && p.q === at[2] ? p.idx : 0 }));
    }
    setPop(null);
  };

  const replacePop = (text: string, caretBack = 0) => {
    const ta = taRef.current;
    if (!ta || !pop) return;
    ta.setSelectionRange(pop.start, ta.selectionStart);
    insertText(ta, text);
    if (caretBack) {
      const p = ta.selectionStart - caretBack;
      ta.setSelectionRange(p, p);
    }
    setPop(null);
  };

  const accept = (i: number) => {
    const ta = taRef.current;
    if (!ta || !pop) return;
    if (pop.kind === "link") {
      const it = linkSugg[i];
      if (!it) return;
      ta.setSelectionRange(pop.start, ta.selectionStart);
      insertText(ta, it.title + "]]");
      setPop(null);
      return;
    }
    if (pop.kind === "slash") {
      const cmd = slashSugg[i];
      if (!cmd) return;
      const helpers: SlashHelpers = {
        replace: (text, caretBack) => replacePop(text, caretBack),
        attach: () => {
          setPop(null);
          attInput.current?.click();
        },
        voice: () => {
          setPop(null);
          voiceToggle.current();
        },
      };
      // "send line to tasks" needs the current line — handle before token replacement
      if (cmd.id === "totask") {
        const line = ta.value.slice(ta.value.lastIndexOf("\n", ta.selectionStart - 1) + 1).split("\n")[0].replace(/^[-*+\d.\s\[\]x]*/, "").trim();
        if (line) {
          st().createTask({ title: line.slice(0, 120), list: "today" });
          st().toast(`Task created: “${line.slice(0, 40)}”`, "tasklist");
          replacePop("");
        } else {
          setPop(null);
          st().toast("Write something on the line first, then run /Send line to Tasks", "tasklist");
        }
        return;
      }
      cmd.run(helpers);
      // re-detect so [[ / @ hand off to their own menus
      if (cmd.id === "notelink" || cmd.id === "mention" || cmd.id === "tag") setTimeout(() => taRef.current && detect(taRef.current), 0);
      return;
    }
    // mention
    const it = mentionSugg[i];
    if (!it) return;
    ta.setSelectionRange(pop.start, ta.selectionStart);
    insertText(ta, it.insert + " ");
    setPop(null);
  };

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    const dw = countWords(next) - countWords(content);
    st().updateNote(id, { content: next });
    if (dw > 0) st().addWords(dw);
    activity.lastType = Date.now();
    detect(e.target);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    const mod = e.ctrlKey || e.metaKey;
    if (pop && suggLen > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setPop({ ...pop, idx: (pop.idx + (e.key === "ArrowDown" ? 1 : suggLen - 1)) % suggLen });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); accept(pop.idx); return; }
      if (e.key === "Escape") { e.preventDefault(); setPop(null); return; }
    }
    if (mod && (e.key === "b" || e.key === "i")) {
      e.preventDefault();
      e.stopPropagation();
      wrap(ta, e.key === "b" ? "**" : "*");
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey) {
        const ls = ta.value.lastIndexOf("\n", ta.selectionStart - 1) + 1;
        const m = /^( {1,2}|\t)/.exec(ta.value.slice(ls));
        if (m) { const p = ta.selectionStart; ta.setSelectionRange(ls, ls + m[0].length); insertText(ta, ""); ta.setSelectionRange(p - m[0].length, p - m[0].length); }
      } else insertText(ta, "  ");
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !mod && ta.selectionStart === ta.selectionEnd) {
      const pos = ta.selectionStart;
      const ls = ta.value.lastIndexOf("\n", pos - 1) + 1;
      const line = ta.value.slice(ls, pos);
      const m = /^(\s*)([-*+]|\d+\.)\s+(\[[ xX]\]\s+)?(.*)$/.exec(line);
      if (m) {
        e.preventDefault();
        if (!m[4].trim()) { ta.setSelectionRange(ls, pos); insertText(ta, ""); return; }
        const marker = /\d/.test(m[2]) ? `${parseInt(m[2], 10) + 1}.` : m[2];
        insertText(ta, `\n${m[1]}${marker} ${m[3] ? "[ ] " : ""}`);
      }
    }
  };

  const toggleTask = (line: number) => {
    const lines = content.split("\n");
    if (!/\[( |x|X)\]/.test(lines[line] ?? "")) return;
    const done = /\[ \]/.test(lines[line]);
    lines[line] = lines[line].replace(/\[( |x|X)\]/, done ? "[x]" : "[ ]");
    st().updateNote(id, { content: lines.join("\n") });
    if (done) {
      st().doAct("happy", 1400);
      st().gain(1, 2);
    }
  };

  const cover = note.cover;
  const wide = mode === "split";
  /** Obsidian-style live table editing — rewrite the table lines in the source (keeping the separator row) */
  const handleTableEdit = (startLine: number, lineCount: number, rows: string[][]) => {
    const lines = content.split("\n");
    const sep = `| ${rows[0].map(() => "---").join(" | ")} |`;
    const newLines: string[] = [];
    rows.forEach((r, i) => {
      newLines.push(`| ${r.join(" | ")} |`);
      if (i === 0) newLines.push(sep);
    });
    lines.splice(startLine, lineCount, ...newLines);
    st().updateNote(id, { content: lines.join("\n") });
  };
  const preview = (
    <Markdown source={deferred} titles={titles} onLink={(t) => st().openByTitle(t)} onTag={(t) => st().set({ tag: t })} onToggle={toggleTask} onMention={(kind, mid) => (kind === "task" ? st().jumpToTask(mid) : st().openNote(mid))} onTableEdit={handleTableEdit} />
  );

  const popHeader = pop?.kind === "link" ? "Link to note" : pop?.kind === "slash" ? "Commands — type / for this menu" : "Mention a task, note or person";

  return (
    <div className="panel flex h-full min-h-0 flex-col">
      <div
        ref={scroller}
        className="scroll min-h-0 flex-1 rounded-[20px]"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
        }}
      >
        <div className="group/cover relative">
          {cover ? (
            <div className="relative h-[170px] overflow-hidden rounded-t-[20px]">
              { }
              <img src={cover} alt="" className="pixelated h-full w-full object-cover" style={{ imageRendering: "auto" }} />
              <div className="absolute inset-0" style={{ background: "linear-gradient(to bottom, transparent 40%, var(--panel-solid))" }} />
            </div>
          ) : (
            <div className="h-5" />
          )}
          <button
            className="btn btn-sm absolute right-4 top-3 opacity-0 transition-opacity group-hover/cover:opacity-100"
            style={{ top: cover ? 12 : 4 }}
            onClick={() => st().updateNote(id, { cover: COVERS[(COVERS.indexOf(cover) + 1) % COVERS.length] })}
          >
            <Icon name="image" size={13} /> {cover ? "Change cover" : "Add cover"}
          </button>
        </div>

        <div className={`mx-auto w-full px-8 pb-28 sm:px-12 ${wide ? "max-w-[1240px]" : "max-w-[800px]"}`} style={{ marginTop: cover ? -30 : 0 }}>
          <input
            ref={titleRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => st().renameNote(id, title)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); st().renameNote(id, title); taRef.current?.focus(); }
            }}
            placeholder="Untitled"
            className="pixel-font selectable w-full bg-transparent text-[38px] font-semibold leading-tight outline-none placeholder:text-faint"
            spellCheck={false}
          />
          <div className="mb-3 mt-2 flex flex-wrap items-center gap-2 text-[12.5px] text-faint">
            <span className="pixel-font">Edited {timeAgo(note.updatedAt)}</span>
            <span>·</span>
            <span className="pixel-font">{meta.words} words</span>
            <TagEditor noteId={id} tags={note.tags ?? []} />
            <span className="flex-1" />
            {/* outline (table of contents) popover */}
            <div className="relative">
              <button className="icon-btn !h-7 !w-7" data-on={tocOpen} title="Outline — jump to a heading" onClick={() => setTocOpen((v) => !v)}>
                <Icon name="heading" size={15} />
              </button>
              {tocOpen && (
                <div className="panel panel-solid absolute right-0 top-9 z-30 max-h-[300px] w-[260px] overflow-y-auto rounded-xl p-1.5" style={{ animation: "pop .18s var(--ease-soft) both", filter: "drop-shadow(0 12px 30px rgba(0,0,0,.4))" }}>
                  <div className="pixel-font px-2 pb-1 pt-0.5 text-[11px] text-faint">OUTLINE</div>
                  {outline.length === 0 ? (
                    <div className="px-2 py-2 text-[12px] text-faint">No headings yet — type # Heading 1 in the note.</div>
                  ) : (
                    outline.map((h) => (
                      <button
                        key={h.line}
                        className="block w-full truncate rounded-lg px-2 py-1.5 text-left text-[12.5px] hover:bg-panel2"
                        style={{ paddingLeft: 8 + (h.level - 1) * 12 }}
                        onClick={() => { jumpToHeading(h); setTocOpen(false); }}
                      >
                        {h.text || "—"}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
            <button className="icon-btn !h-7 !w-7" data-on={note.pinned} onClick={() => st().updateNote(id, { pinned: !note.pinned })} title={note.pinned ? "Unpin" : "Pin"}>
              <Icon name="bookmark" size={15} />
            </button>
            {/* note menu — duplicate / export / copy */}
            <div className="relative">
              <button className="icon-btn !h-7 !w-7" data-on={noteMenu} title="More note actions" onClick={() => setNoteMenu((v) => !v)}>
                <Icon name="more-horizontal" size={15} />
              </button>
              {noteMenu && (
                <div className="panel panel-solid absolute right-0 top-9 z-30 w-[210px] rounded-xl p-1.5" style={{ animation: "pop .18s var(--ease-soft) both", filter: "drop-shadow(0 12px 30px rgba(0,0,0,.4))" }}>
                  {[
                    {
                      icon: "copy" as IconName,
                      label: "Duplicate note",
                      run: () => {
                        const newId = st().createNote({ title: `${note.title} copy`, content: note.content, cover: note.cover, folderId: note.folderId });
                        st().toast("Note duplicated", "copy");
                        setTimeout(() => st().openNote(newId), 60);
                      },
                    },
                    {
                      icon: "download" as IconName,
                      label: "Export as .md",
                      run: () => {
                        const blob = new Blob([`# ${note.title}\n\n${note.content}`], { type: "text/markdown" });
                        const a = document.createElement("a");
                        a.href = URL.createObjectURL(blob);
                        a.download = `${note.title.replace(/[\\/:*?"<>|]/g, "").slice(0, 40) || "note"}.md`;
                        a.click();
                        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
                        st().toast("Exported as markdown", "download");
                      },
                    },
                    {
                      icon: "file-text" as IconName,
                      label: "Copy markdown",
                      run: async () => {
                        await navigator.clipboard.writeText(note.content).catch(() => {});
                        st().toast("Markdown copied to clipboard", "copy");
                      },
                    },
                    {
                      icon: "send" as IconName,
                      label: "Share…",
                      run: () => setShareOpen(true),
                    },
                    {
                      icon: "tasklist" as IconName,
                      label: "Send TODOs to Tasks",
                      run: () => {
                        const m = parseNote(note.content);
                        if (m.tasks.total === 0) { st().toast("No TODO checkboxes in this note", "alert"); return; }
                        st().toast(`${m.tasks.total - m.tasks.done} open TODOs — open Tasks to sync`, "tasklist");
                        st().setView("tasks");
                      },
                    },
                  ].map((a) => (
                    <button key={a.label} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] hover:bg-panel2" onClick={() => { void a.run(); setNoteMenu(false); }}>
                      <Icon name={a.icon} size={13} className="text-accent" /> {a.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              className="icon-btn !h-7 !w-7"
              style={sure ? { background: "#a5594f", color: "#fff" } : undefined}
              title={sure ? "Click again to delete" : "Delete note"}
              onClick={() => (sure ? st().deleteNote(id) : (setSure(true), setTimeout(() => setSure(false), 2200)))}
            >
              <Icon name="trash" size={15} />
            </button>
          </div>

          <div className="sticky top-2 z-20 mb-5 flex items-center gap-1 rounded-[14px] border border-line px-1.5 py-1" style={{ background: "var(--panel-solid)", boxShadow: "0 10px 30px -18px rgba(0,0,0,.6)" }}>
            <div className="seg">
              {([["write", "pencil", "Write"], ["split", "layout", "Split"], ["read", "eye", "Read"]] as [EditorMode, IconName, string][]).map(([m, ic, l]) => (
                <button key={m} data-on={mode === m} onClick={() => st().set({ editorMode: m })} title={`${l} (Ctrl+E)`}>
                  <Icon name={ic} size={13} /> <span className="hidden md:inline">{l}</span>
                </button>
              ))}
            </div>
            {mode !== "read" && (
              <>
                <div className="mx-1 h-5 w-px bg-line" />
                <button className="icon-btn !h-8 !w-8 pixel-font text-[15px] font-bold" title="Bold (Ctrl+B)" onClick={() => taRef.current && wrap(taRef.current, "**")}>B</button>
                <button className="icon-btn !h-8 !w-8 pixel-font text-[15px] italic" title="Italic (Ctrl+I)" onClick={() => taRef.current && wrap(taRef.current, "*")}>I</button>
                {TOOLS.map((t) => (
                  <button key={t.icon} className="icon-btn !h-8 !w-8" title={t.tip} onClick={() => taRef.current && t.run(taRef.current)}>
                    <Icon name={t.icon} size={16} />
                  </button>
                ))}
                <button
                  className="icon-btn !h-8 !w-8 pixel-font"
                  title="Slash commands — type / in the note"
                  onClick={() => {
                    const ta = taRef.current;
                    if (!ta) return;
                    ta.focus();
                    insertText(ta, "/");
                    detect(ta);
                  }}
                >
                  <Icon name="slash-cmd" size={15} />
                </button>
                <button className="icon-btn !h-8 !w-8" title="Mention — type @ in the note" onClick={() => { const ta = taRef.current; if (!ta) return; ta.focus(); insertText(ta, "@"); detect(ta); }}>
                  <Icon name="at" size={15} />
                </button>
              </>
            )}
            <div className="flex-1" />
            <input ref={attInput} type="file" multiple className="hidden" onChange={(e) => { if (e.target.files) uploadFiles(e.target.files); e.target.value = ""; }} />
            {mode !== "read" && <MicButton onRegister={(fn) => (voiceToggle.current = fn)} onText={(text) => { const ta = taRef.current; if (ta) insertText(ta, text + " "); else st().createNote({ title: text.slice(0, 40), content: text }); }} />}
            <button className="icon-btn !h-8 !w-8" title="Attach files (or drop / paste them into the note)" onClick={() => attInput.current?.click()}>
              <Icon name="paperclip" size={15} />
            </button>
            <button className="btn btn-sm" onClick={() => useStore.setState({ rightOpen: true, rightTab: "ai" })}>
              <Icon name="sparkles" size={13} /> Ask AI
            </button>
          </div>

          {/* attachments strip */}
          {atts.length > 0 && (
            <div className="att-strip mb-4">
              {atts.map((a) =>
                a.mime.startsWith("image/") ? (
                  <a key={a.id} className="att-thumb" href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer" title={`${a.name} — open full size`}>
                    <img src={`/api/attachments/${a.id}`} alt={a.name} loading="lazy" />
                    <span className="att-name">{a.name}</span>
                    <button
                      className="att-del"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); void st().deleteAtt(id, a.id); }}
                      title="Remove attachment"
                      aria-label={`Remove ${a.name}`}
                    >
                      <Icon name="close" size={11} />
                    </button>
                  </a>
                ) : (
                  <a key={a.id} className="att-file" href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer" title={`${a.name} — download`}>
                    <Icon name="file-text" size={15} className="flex-none text-accent" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px]">{a.name}</span>
                      <span className="text-[10.5px] text-faint">{a.size > 1024 * 1024 ? `${(a.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(a.size / 1024))} KB`}</span>
                    </span>
                    <button
                      className="att-del"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); void st().deleteAtt(id, a.id); }}
                      title="Remove attachment"
                      aria-label={`Remove ${a.name}`}
                    >
                      <Icon name="close" size={11} />
                    </button>
                  </a>
                ),
              )}
            </div>
          )}

          <div className={wide ? "grid grid-cols-2 gap-8" : ""}>
            {mode !== "read" && (
              <div className="relative">
                <textarea
                  ref={taRef}
                  className="editor-ta selectable"
                  value={content}
                  onChange={onChange}
                  onKeyDown={onKeyDown}
                  onKeyUp={(e) => ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) && detect(e.currentTarget)}
                  onClick={(e) => detect(e.currentTarget)}
                  onBlur={() => setTimeout(() => setPop(null), 120)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    const ta = e.currentTarget;
                    ta.focus();
                    openCtx(editorMenu(ta, { attach: () => attInput.current?.click(), voice: () => voiceToggle.current() }), { x: e.clientX + 2, y: e.clientY + 2 });
                  }}
                  onPaste={(e) => {
                    const files = [...(e.clipboardData?.files ?? [])];
                    if (files.length) {
                      e.preventDefault();
                      uploadFiles(files);
                    }
                  }}
                  placeholder="Start writing… type / for commands, [[ to link, @ to mention, # for tags · paste or drop images to attach"
                  spellCheck
                />
                {pop && suggLen > 0 && (
                  <div className="menu panel panel-solid absolute z-30 w-[300px] p-1.5" style={{ left: Math.max(0, pop.x), top: pop.y, backdropFilter: "none", maxHeight: 320, overflowY: "auto" }}>
                    <div className="label px-2 pb-1 pt-0.5">{popHeader}</div>
                    {pop.kind === "link" &&
                      linkSugg.map((s, i) => (
                        <button key={s.title + i} onMouseDown={(e) => { e.preventDefault(); accept(i); }} onMouseEnter={() => setPop({ ...pop, idx: i })} className="pixel-font flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[14px]" style={{ background: i === pop.idx ? "var(--hl)" : "transparent" }}>
                          <Icon name={s.create ? "plus" : "note"} size={13} className="text-accent" />
                          <span className="truncate">{s.create ? `Create “${s.title}”` : s.title}</span>
                        </button>
                      ))}
                    {pop.kind === "slash" &&
                      SLASH_GROUPS.map((g) => {
                        const items = slashSugg.filter((c) => c.group === g);
                        if (!items.length) return null;
                        return (
                          <div key={g}>
                            <div className="label !text-[9.5px] px-2 pb-0.5 pt-1 opacity-60">{g}</div>
                            {items.map((c) => {
                              const gi = slashSugg.indexOf(c);
                              return (
                                <button key={c.id} onMouseDown={(e) => { e.preventDefault(); accept(gi); }} onMouseEnter={() => setPop({ ...pop, idx: gi })} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13.5px]" style={{ background: gi === pop.idx ? "var(--hl)" : "transparent" }}>
                                  <Icon name={c.icon} size={13} className="flex-none text-accent" />
                                  <span className="pixel-font flex-none">{c.name}</span>
                                  <span className="truncate text-[10.5px] text-faint">{c.hint}</span>
                                </button>
                              );
                            })}
                          </div>
                        );
                      })}
                    {pop.kind === "mention" &&
                      mentionSugg.map((s, i) => (
                        <button key={s.sub + s.label + i} onMouseDown={(e) => { e.preventDefault(); accept(i); }} onMouseEnter={() => setPop({ ...pop, idx: i })} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13.5px]" style={{ background: i === pop.idx ? "var(--hl)" : "transparent" }}>
                          <Icon name={s.icon} size={13} className="flex-none text-accent" />
                          <span className="truncate">{s.label}</span>
                          <span className="ml-auto chip !py-0 !text-[9.5px]">{s.sub}</span>
                        </button>
                      ))}
                  </div>
                )}
              </div>
            )}
            {mode !== "write" && (wide ? <div className="rounded-2xl border border-line bg-panel2 p-6">{preview}</div> : preview)}
          </div>

          <div className="mt-16">
            <div className="label mb-3 flex items-center gap-2"><Icon name="link" size={12} /> Linked mentions · {backlinks.length}</div>
            {backlinks.length === 0 ? (
              <div className="pixel-font rounded-2xl border border-dashed border-line px-4 py-5 text-[14px] text-faint">
                Nothing links here yet. In another note, type [[{note.title}]] or @-mention it to connect them.
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {backlinks.map((b) => {
                  const ctx = b.content.split("\n").find((l) => l.toLowerCase().includes(`[[${note.title.toLowerCase()}`) || l.includes(`](note:${id})`)) ?? "";
                  return (
                    <Tilt key={b.id} className="inset cursor-pointer p-4 hover:border-[color:var(--accent)]/40" onClick={() => st().openNote(b.id)}>
                      <div className="pixel-font text-[16px]">{b.title}</div>
                      <div className="mt-1 line-clamp-2 text-[12.5px] text-dim">{ctx.replace(/^[-*>\s]+/, "") || parseNote(b.content).snippet}</div>
                    </Tilt>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
      {shareOpen && <ShareDialog noteId={id} noteTitle={note.title} onClose={() => setShareOpen(false)} />}
    </div>
  );
}
