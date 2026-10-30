// Offline "brain": TF-IDF retrieval, extractive summaries, keyword tags, rewrites.
// Runs anywhere (server or browser). No network, no keys.
import type { AiLink, Note, Species } from "@/lib/types";
import { SPECIES } from "@/lib/pet";
import { parseNote, plain, timeAgo, titleKey } from "@/lib/util";

const STOP = new Set(
  "a about above after again all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its just me more most my no nor not now of off on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up very was we were what when where which while who why will with would you your it's i'm don't can't dont cant im ive really like get got one two want need make use using used also well will".split(" "),
);

export function tokens(s: string): string[] {
  const m = plain(s).toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) ?? [];
  return m.filter((w) => !STOP.has(w));
}

function tf(ts: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of ts) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

export function keywords(text: string, k = 6): string[] {
  const t = tf(tokens(text));
  const meta = parseNote(text);
  for (const h of meta.headings) for (const w of tokens(h.text)) t.set(w, (t.get(w) ?? 0) + 2);
  for (const tag of meta.tags) t.set(tag, (t.get(tag) ?? 0) + 2);
  for (const l of meta.links) for (const w of tokens(l)) t.set(w, (t.get(w) ?? 0) + 2);
  return [...t.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, k)
    .map(([w]) => w);
}

export function units(md: string): string[] {
  const out: string[] = [];
  for (const line of md.replace(/```[\s\S]*?```/g, "").split("\n")) {
    const p = plain(line);
    if (!p || p.length < 18) continue;
    for (const s of p.split(/(?<=[.!?])\s+/)) if (s.length >= 18) out.push(s.slice(0, 280));
  }
  return out;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

export function summarize(text: string, n = 3): string {
  const us = units(text);
  if (us.length === 0) return "There is not enough text yet to summarize. Write a little more and ask again.";
  const f = tf(tokens(text));
  const scored = us.map((u, i) => {
    const ts = tokens(u);
    const s = ts.reduce((a, w) => a + (f.get(w) ?? 0), 0) / Math.sqrt(ts.length + 1) + (i === 0 ? 0.8 : 0);
    return { u, i, s };
  });
  const top = scored.sort((a, b) => b.s - a.s).slice(0, n).sort((a, b) => a.i - b.i);
  const kw = keywords(text, 4);
  return `**Key points**\n${top.map((t) => `- ${t.u}`).join("\n")}\n\n*Themes: ${kw.join(", ")}*`;
}

export function suggestTags(text: string, vaultTags: string[]): string[] {
  const have = new Set(parseNote(text).tags);
  const low = text.toLowerCase();
  const out: string[] = [];
  for (const t of vaultTags) if (!have.has(t) && low.includes(t) && !out.includes(t)) out.push(t);
  for (const k of keywords(text, 12)) {
    if (out.length >= 5) break;
    if (k.length > 3 && !have.has(k) && !out.includes(k)) out.push(k);
  }
  return out.slice(0, 5);
}

export function suggestTitle(text: string): string {
  const h = parseNote(text).headings[0];
  if (h) return h.text;
  const u = units(text)[0];
  if (u) return titleCase(u.split(/\s+/).slice(0, 6).join(" ").replace(/[.,;:!?]+$/, ""));
  const k = keywords(text, 3);
  return k.length ? titleCase(k.join(" ")) : "Untitled";
}

export function continueText(text: string): string {
  const kws = keywords(text, 4);
  const [a = "this idea", b = "the bigger picture"] = kws;
  const open = text.split("\n").find((l) => /^\s*[-*+]\s+\[ \]/.test(l));
  const lines = [
    "",
    "## Next up",
    `- What is the smallest next step for **${a}**?`,
    `- How does **${a}** connect to **${b}**?`,
    `- What would I regret not trying with **${a}**?`,
  ];
  if (open) lines.push(`- [ ] Finish: ${plain(open)}`);
  else lines.push(`- [ ] Draft a first version of ${a}`);
  return lines.join("\n");
}

const FILLER = /\b(really|very|just|actually|basically|quite|simply|literally|totally|honestly)\b\s*/gi;

export function rewrite(text: string, style: string): string {
  const tidy = (s: string) =>
    s
      .replace(/[ \t]+/g, " ")
      .replace(/ +([,.;:!?])/g, "$1")
      .replace(/\n{3,}/g, "\n\n")
      .split("\n")
      .map((l) => {
        if (/^\s*(#|```|>|\|)/.test(l) || !l.trim()) return l.trimEnd();
        const m = /^(\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?)?(.*)$/.exec(l)!;
        const body = m[2].trim();
        return (m[1] ?? "") + cap(body);
      })
      .join("\n")
      .trim();
  switch (style) {
    case "concise":
      return tidy(text.replace(FILLER, "").replace(/\bin order to\b/gi, "to").replace(/\bdue to the fact that\b/gi, "because").replace(/\b(kind of|sort of)\b\s*/gi, ""));
    case "bullets": {
      const out: string[] = [];
      for (const para of text.split(/\n{2,}/)) {
        if (/^\s*(#|[-*+]|\d+\.|>|```|\|)/.test(para)) out.push(para.trim());
        else for (const s of plain(para).split(/(?<=[.!?])\s+/)) if (s.trim()) out.push(`- ${s.trim()}`);
      }
      return tidy(out.join("\n"));
    }
    case "tasks": {
      const out: string[] = [];
      for (const line of text.split("\n")) {
        if (/^\s*#/.test(line) || !line.trim()) { out.push(line); continue; }
        if (/^\s*[-*+]\s+\[[ xX]\]/.test(line)) { out.push(line); continue; }
        const p = plain(line);
        if (p) out.push(`- [ ] ${cap(p)}`);
      }
      return out.join("\n").trim();
    }
    default:
      return tidy(text);
  }
}

// ---------- retrieval ----------
type Vec = Map<string, number>;

function buildVectors(notes: Note[]) {
  const docs = notes.map((n) => tf(tokens(`${n.title} ${n.title} ${n.content}`)));
  const df = new Map<string, number>();
  for (const d of docs) for (const k of d.keys()) df.set(k, (df.get(k) ?? 0) + 1);
  const N = notes.length;
  const idf = (w: string) => Math.log(1 + N / (df.get(w) ?? 1));
  const vecs: Vec[] = docs.map((d) => {
    const v: Vec = new Map();
    let norm = 0;
    for (const [w, c] of d) {
      const x = (1 + Math.log(c)) * idf(w);
      v.set(w, x);
      norm += x * x;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [w, x] of v) v.set(w, x / norm);
    return v;
  });
  return { vecs, idf };
}

function cos(a: Vec, b: Vec) {
  let s = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const [w, x] of small) {
    const y = big.get(w);
    if (y) s += x * y;
  }
  return s;
}

export function related(noteId: string, notes: Note[], k = 5): { note: Note; score: number; shared: string[] }[] {
  const idx = notes.findIndex((n) => n.id === noteId);
  if (idx < 0 || notes.length < 2) return [];
  const { vecs } = buildVectors(notes);
  const me = vecs[idx];
  return notes
    .map((n, i) => ({ note: n, score: i === idx ? 0 : cos(me, vecs[i]), i }))
    .filter((r) => r.score > 0.04)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((r) => {
      const shared = [...me.keys()].filter((w) => vecs[r.i].has(w)).sort((x, y) => (me.get(y)! * vecs[r.i].get(y)!) - (me.get(x)! * vecs[r.i].get(x)!)).slice(0, 3);
      return { note: r.note, score: r.score, shared };
    });
}

export function search(query: string, notes: Note[], k = 4) {
  const q = tf(tokens(query));
  if (q.size === 0 || notes.length === 0) return [];
  const { vecs, idf } = buildVectors(notes);
  const qv: Vec = new Map();
  let norm = 0;
  for (const [w, c] of q) {
    const x = (1 + Math.log(c)) * idf(w);
    qv.set(w, x);
    norm += x * x;
  }
  norm = Math.sqrt(norm) || 1;
  for (const [w, x] of qv) qv.set(w, x / norm);
  return notes
    .map((n, i) => ({ note: n, score: cos(qv, vecs[i]) }))
    .filter((r) => r.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export function linkSuggestions(note: Pick<Note, "id" | "title" | "content">, notes: Note[]): AiLink[] {
  const linked = new Set(parseNote(note.content).links.map(titleKey));
  const low = note.content.toLowerCase();
  const out: AiLink[] = [];
  for (const n of notes) {
    if (n.id === note.id || n.title.length < 3 || linked.has(titleKey(n.title))) continue;
    const re = new RegExp(`\\b${n.title.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (re.test(low)) out.push({ id: n.id, title: n.title, reason: "mentioned in your text — make it a link" });
  }
  for (const r of related(note.id, notes, 6)) {
    if (linked.has(titleKey(r.note.title)) || out.some((o) => o.id === r.note.id)) continue;
    out.push({ id: r.note.id, title: r.note.title, reason: r.shared.length ? `shares ${r.shared.join(", ")}` : "similar topic" });
  }
  return out.slice(0, 6);
}

export function brainstorm(title: string, text: string): string {
  const k = keywords(text, 5);
  const [a = title || "this", b = "people", c = "time", d = "limits", e = "a tiny version"] = k;
  return [
    "**Sparks**",
    `- What if **${a}** had to work with zero budget?`,
    `- Combine **${a}** with **${b}** — what appears?`,
    `- Explain **${a}** to a ten year old. What stays?`,
    `- What does **${c}** change about it a year from now?`,
    `- Remove **${d}**. Then try ${e}.`,
  ].join("\n");
}

export function outline(text: string): string {
  const hs = parseNote(text).headings;
  if (hs.length) return "**Outline**\n" + hs.map((h) => `${"  ".repeat(h.level - 1)}- ${h.text}`).join("\n");
  const k = keywords(text, 5);
  return "**Suggested outline**\n" + ["Context", ...k.map(cap), "Next steps"].map((s) => `- ${s}`).join("\n");
}

export function flavor(sp: Species, name: string, text: string, kind: "hi" | "end" | "both" = "both") {
  const f = SPECIES[sp] ?? SPECIES.cat;
  void name;
  return `${kind !== "end" ? f.hi + " " : ""}${text}${kind !== "hi" ? "\n\n" + f.end : ""}`;
}

export type AskOut = { text: string; sources: { id: string; title: string }[] };

export function ask(question: string, notes: Note[]): AskOut {
  const q = question.toLowerCase();
  const now = Date.now();
  const src = (ns: Note[]) => ns.map((n) => ({ id: n.id, title: n.title }));
  if (/\b(tasks?|to-?dos?|open items?|unfinished|pending|checklists?)\b/.test(q)) {
    const items: { t: string; n: Note }[] = [];
    for (const n of notes) for (const l of n.content.split("\n")) if (/^\s*[-*+]\s+\[ \]/.test(l)) items.push({ t: plain(l), n });
    if (!items.length) return { text: "No open tasks anywhere. Your vault is spotless.", sources: [] };
    return {
      text: `**${items.length} open tasks**\n` + items.slice(0, 9).map((i) => `- [ ] ${i.t} — [[${i.n.title}]]`).join("\n"),
      sources: src([...new Set(items.slice(0, 9).map((i) => i.n))]),
    };
  }
  if (/\b(forgot|forgotten|stale|neglected?|untouched|oldest|dusty|haven'?t touched)\b/.test(q)) {
    const old = [...notes].sort((a, b) => a.updatedAt - b.updatedAt).slice(0, 4);
    return { text: "**Gathering dust**\n" + old.map((n) => `- [[${n.title}]] — ${timeAgo(n.updatedAt, now)}`).join("\n"), sources: src(old) };
  }
  if (/\b(orphans?|unlinked|no links?|disconnected|lonely)\b/.test(q)) {
    const titles = new Set<string>();
    for (const n of notes) for (const l of parseNote(n.content).links) titles.add(titleKey(l));
    const orph = notes.filter((n) => parseNote(n.content).links.length === 0 && !titles.has(titleKey(n.title)));
    if (!orph.length) return { text: "Every note is connected to something. Beautiful web.", sources: [] };
    return { text: "**Lonely notes**\n" + orph.slice(0, 8).map((n) => `- [[${n.title}]]`).join("\n"), sources: src(orph.slice(0, 8)) };
  }
  if (/\b(tags?|topics?|themes?)\b/.test(q) && !/\babout\b/.test(q)) {
    const c = new Map<string, number>();
    for (const n of notes) for (const t of parseNote(n.content).tags) c.set(t, (c.get(t) ?? 0) + 1);
    const top = [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    return { text: top.length ? "**Your topics**\n" + top.map(([t, n]) => `- #${t} · ${n} note${n > 1 ? "s" : ""}`).join("\n") : "No tags yet. Type #idea anywhere to start one.", sources: [] };
  }
  if (/\b(recent|latest|last|today|newest)\b/.test(q)) {
    const r = [...notes].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4);
    return { text: "**Latest activity**\n" + r.map((n) => `- [[${n.title}]] — ${timeAgo(n.updatedAt, now)}`).join("\n"), sources: src(r) };
  }
  if (/\b(how many|stats|count|total)\b/.test(q)) {
    let words = 0, links = 0;
    for (const n of notes) { const m = parseNote(n.content); words += m.words; links += m.links.length; }
    return { text: `**Vault stats**\n- ${notes.length} notes\n- ${words.toLocaleString()} words\n- ${links} links`, sources: [] };
  }
  const hits = search(question, notes, 3);
  if (!hits.length) return { text: "I looked everywhere and found nothing about that. Maybe it deserves a brand new note?", sources: [] };
  const qt = new Set(tokens(question));
  const lines: string[] = [];
  for (const h of hits) {
    const us = units(h.note.content)
      .map((u) => ({ u, s: tokens(u).filter((w) => qt.has(w)).length }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 2)
      .filter((x) => x.s > 0);
    if (us.length) for (const x of us) lines.push(`- ${x.u} — [[${h.note.title}]]`);
    else lines.push(`- Related: [[${h.note.title}]]`);
  }
  return { text: `**Here is what your notes say**\n${lines.join("\n")}`, sources: src(hits.map((h) => h.note)) };
}
