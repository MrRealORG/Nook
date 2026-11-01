/**
 * v1.4 AI prompt building — pure, unit-testable, shared by every AI entry point.
 *
 *  - `systemPrompt()`  one clear persona + rules + today's date + a small vault overview, and the
 *                      note the user is looking at (title + content, clipped) as context.
 *  - `trimHistory()`   conversation memory: the newest turns that fit a character budget, never a
 *                      dangling assistant turn first, errors dropped.
 *  - `providerError()` turns a provider failure into one human sentence for the UI.
 */
import type { Note } from "@/lib/types";

export type Turn = { role: "user" | "assistant"; content: string };

export type PromptCtx = {
  name: string;
  species: string;
  /** notes in the vault (only titles + recency are used for the overview) */
  notes?: Pick<Note, "id" | "title" | "updatedAt">[];
  /** the note open in the editor — sent as context */
  current?: { title: string; content: string } | null;
  /** extra role line ("You are a productivity coach.") */
  role?: string;
  now?: Date;
};

export const CURRENT_NOTE_CHARS = 6000;
export const HISTORY_CHARS = 12_000;
export const HISTORY_TURNS = 24;

export function systemPrompt(c: PromptCtx): string {
  const now = c.now ?? new Date();
  const date = now.toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const lines = [
    `You are ${c.name}, a friendly pixel ${c.species} who lives inside Nook, the user's private markdown notes app.${c.role ? ` ${c.role}` : ""}`,
    `Today is ${date}.`,
    "How to answer:",
    "- Be direct and useful first, warm second. Lead with the answer; no filler or preamble.",
    "- Use markdown (short paragraphs, bullets, **bold** for key terms). Keep [[wikilinks]] and formatting intact when you edit text.",
    "- When you rely on a note, cite it as [[Note title]]. Never invent notes, quotes, numbers or facts that are not in the context; say plainly when you don't know.",
    "- Remember the conversation so far and build on it; don't repeat earlier answers.",
    "- If the request is ambiguous, make the most sensible assumption and say it in one short line.",
  ];
  const notes = (c.notes ?? []).filter((n) => n.title);
  if (notes.length) {
    const recent = [...notes].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, 12).map((n) => `[[${n.title}]]`);
    lines.push(`The vault has ${notes.length} note${notes.length === 1 ? "" : "s"}. Recently edited: ${recent.join(", ")}.`);
  }
  if (c.current && (c.current.title || c.current.content)) {
    const body = c.current.content.length > CURRENT_NOTE_CHARS ? `${c.current.content.slice(0, CURRENT_NOTE_CHARS)}\n…(note continues)` : c.current.content;
    lines.push("", `The user currently has this note open — use it as context when the question is about "this", "the note", or its topic:`, `<<<NOTE title="${c.current.title || "Untitled"}">>>`, body, "<<<END NOTE>>>");
  }
  return lines.join("\n");
}

/** newest turns within the budget, oldest first; starts with a user turn */
export function trimHistory(history: Turn[] | undefined, maxChars = HISTORY_CHARS, maxTurns = HISTORY_TURNS): Turn[] {
  const clean = (history ?? []).filter((t) => (t.role === "user" || t.role === "assistant") && typeof t.content === "string" && t.content.trim());
  const out: Turn[] = [];
  let used = 0;
  for (let i = clean.length - 1; i >= 0 && out.length < maxTurns; i--) {
    const content = clean[i].content.length > 4000 ? `${clean[i].content.slice(0, 4000)}…` : clean[i].content;
    if (used + content.length > maxChars && out.length) break;
    used += content.length;
    out.unshift({ role: clean[i].role, content });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

/** one readable sentence for a provider failure (Rust gives the raw reason) */
export function providerError(reason: string | null | undefined): string {
  const r = String(reason ?? "").trim();
  if (!r || r === "not-configured") return "";
  if (/401|unauthor|invalid.*key|api key/i.test(r)) return `The AI provider rejected the API key (${r.slice(0, 160)}). Check it in Settings → AI.`;
  if (/429|rate|quota|exhaust/i.test(r)) return `The AI provider is rate-limiting or out of quota (${r.slice(0, 160)}). Try again in a minute.`;
  if (/timed? ?out|timeout/i.test(r)) return `The AI provider timed out (${r.slice(0, 160)}).`;
  if (/connect|dns|network|refused|unreachable/i.test(r)) return `Couldn't reach the AI provider (${r.slice(0, 160)}). Check your connection or the base URL.`;
  return `AI provider error: ${r.slice(0, 240)}`;
}
