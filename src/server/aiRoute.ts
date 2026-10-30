/**
 * Port of `src/app/api/ai/route.ts`. Runs in the webview (no Node server any more):
 *  - the offline brain (`ai-local.ts`) answers instantly with no key and no network
 *  - when an OpenAI-compatible provider is configured (Settings → AI), its answer replaces
 *    the local one; the request goes through Rust (`/api/ai-chat`, key in the OS keyring)
 *  - the tool-using harness ("agent") runs the same JSON tool protocol as before; tools
 *    execute in Rust (`/api/agent-tools`) against the SQLite vault
 * Streaming: pass `onDelta` to receive tokens as they arrive.
 */
import { ask, brainstorm, continueText, flavor, linkSuggestions, outline, rewrite, search, suggestTags, suggestTitle, summarize } from "@/lib/ai-local";
import { DEV_API, invoke, isTauri } from "@/lib/platform";
import type { AiEffect, AiResult, AiTool, Note, Species } from "@/lib/types";
import { parseNote } from "@/lib/util";

export type AiBody = {
  action: string;
  noteId?: string;
  title?: string;
  text?: string;
  question?: string;
  style?: string;
  persona?: { name?: string; species?: Species };
};

type ChatMsg = { role: "system" | "assistant" | "user"; content: string };
type OnDelta = (full: string) => void;

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  return (await r.json()) as T;
}
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** One-shot completion via the configured provider; null when unavailable (→ local fallback). */
export async function cloud(messages: ChatMsg[]): Promise<string | null> {
  try {
    const r = await json<{ ok: boolean; content: string | null }>("/api/ai-chat", post({ messages }));
    return r.ok && r.content ? r.content.trim() : null;
  } catch {
    return null;
  }
}

/** Streaming completion; falls back to `null` like `cloud()`. */
export async function cloudStream(messages: ChatMsg[], onDelta: OnDelta): Promise<string | null> {
  let full = "";
  try {
    if (isTauri) {
      const { Channel } = await import("@tauri-apps/api/core");
      const ch = new Channel<{ type: string; text?: string; error?: string }>();
      ch.onmessage = (m) => {
        if (m.type === "delta" && m.text) {
          full += m.text;
          onDelta(full);
        }
      };
      const res = await invoke<{ ok: boolean; text?: string }>("ai_stream", { messages, onEvent: ch });
      return res.ok ? (res.text ?? full).trim() || null : null;
    }
    const r = await fetch(`${DEV_API}/api/ai-stream`, post({ messages }));
    if (!r.body) return null;
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let ok = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 2);
        if (!line.startsWith("data:")) continue;
        const ev = JSON.parse(line.slice(5)) as { type: string; text?: string };
        if (ev.type === "delta" && ev.text) {
          full += ev.text;
          onDelta(full);
        } else if (ev.type === "done") ok = true;
      }
    }
    return ok ? full.trim() || null : null;
  } catch {
    return full.trim() || null;
  }
}

async function executeTools(calls: { name: string; args?: Record<string, unknown> }[]): Promise<{ trace: AiTool[]; feedback: string }> {
  try {
    return await json<{ trace: AiTool[]; feedback: string }>("/api/agent-tools", post({ calls }));
  } catch (e) {
    return { trace: [], feedback: `tools unavailable: ${e instanceof Error ? e.message : e}` };
  }
}

let catalogCache: string | null = null;
async function toolCatalog(): Promise<string> {
  if (!catalogCache) catalogCache = (await json<{ catalog: string }>("/api/agent-tools")).catalog;
  return catalogCache;
}

// ------------------------- the harness (tool-using agent) -------------------------

export function extractJson(raw: string): { say?: unknown; tools?: unknown; effects?: unknown } | null {
  const cleaned = raw.replace(/```json/gi, "```").trim();
  const fenced = cleaned.match(/```\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], cleaned].filter(Boolean) as string[];
  for (const c of candidates) {
    const start = c.indexOf("{");
    const end = c.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      const j = JSON.parse(c.slice(start, end + 1)) as { say?: unknown; tools?: unknown; effects?: unknown };
      if (j && typeof j === "object") return j;
    } catch {
      /* try next */
    }
  }
  return null;
}

const VIEWS_OK = new Set(["notes", "graph", "canvas", "den", "focus", "arcade", "team", "market", "tasks", "activity", "rules", "settings"]);

export function sanitizeEffects(raw: unknown): AiEffect[] {
  if (!Array.isArray(raw)) return [];
  const out: AiEffect[] = [];
  for (const e of raw.slice(0, 3)) {
    if (!e || typeof e !== "object") continue;
    const t = (e as { type?: string }).type;
    if (t === "navigate" && VIEWS_OK.has(String((e as { view?: string }).view))) out.push({ type: "navigate", view: String((e as { view?: string }).view) });
    else if (t === "theme") out.push({ type: "theme", id: String((e as { id?: string }).id ?? "") });
    else if (t === "pet" && ["happy", "think", "spin"].includes(String((e as { mood?: string }).mood))) out.push({ type: "pet", mood: (e as { mood?: "happy" }).mood as "happy" });
    else if (t === "confetti") out.push({ type: "confetti" });
  }
  return out;
}

async function agentSystem(name: string, species: string): Promise<string> {
  return [
    `You are ${name}, a tiny pixel ${species} living inside "the Nook" — a productivity app with a notes vault, tasks, focus timer, arcade, pet den, team room, marketplace and app-time tracking.`,
    `You have REAL tools. If the user asks you to do, find, check, tidy, plan or research something — actually DO it with tools instead of describing what you could do.`,
    ``,
    `Reply with STRICT JSON only, no markdown fences, nothing outside the JSON:`,
    `{"say":"<your friendly markdown reply>","tools":[{"name":"<tool>","args":{...}}],"effects":[...]}`,
    ``,
    `Rules:`,
    `- "tools" is optional (max 6 calls). You will receive TOOL RESULTS and may run one more round. When you have enough, reply with final JSON with NO tools.`,
    `- Weave REAL results (numbers, names) into "say". Never invent tool results.`,
    `- "effects" is optional (max 3): {"type":"navigate","view":"notes|graph|canvas|den|focus|arcade|team|market|tasks|activity|rules|settings"} · {"type":"theme","id":"<theme id>"} · {"type":"pet","mood":"happy|think|spin"} · {"type":"confetti"}.`,
    `- Keep "say" brief, warm, in character. Markdown bullets and [[Note Title]] links welcome.`,
    ``,
    `TOOLS:`,
    await toolCatalog(),
  ].join("\n");
}

/** Offline fallback: heuristic intents so the harness still does real work without a model. */
export async function localAgent(question: string): Promise<Partial<AiResult>> {
  const q = question.toLowerCase();
  const call = async (name: string, args: Record<string, unknown>) => (await executeTools([{ name, args }])).trace;
  const pick = (runs: AiTool[], text: string): Partial<AiResult> => ({ mode: "local", text, tools: runs.filter(Boolean), acted: runs.length > 0 });

  const due = /(\d+)\s*days?/.exec(q);
  const days = /week/.test(q) ? 7 : due ? Number(due[1]) : 1;

  const mTask = /(?:add|create|new|remember)\s+(?:a\s+|an\s+)?(?:task|todo|to-do)s?(?::|\s)+(?!.*list)(.+)/i.exec(question) ?? /remind me to\s+(.+)/i.exec(question);
  if (mTask) {
    const title = mTask[1].trim().replace(/\s+(today|tomorrow|asap)$/i, "");
    const list = /tomorrow|upcoming/i.test(q) ? "upcoming" : "today";
    const runs = await call("create_task", { title, list, priority: /asap|urgent|important/i.test(q) ? 2 : 1 });
    return pick(runs, `Done — added **${title}** to your ${list} list! 📌`);
  }
  if (/what (are|is) my (open )?(tasks|todos|to-?dos)|list (my )?tasks|show (my )?tasks/.test(q)) {
    const runs = await call("list_tasks", { done: "false" });
    return pick(runs, "Here's your task list ☝ — want me to add, complete or tidy anything?");
  }
  if (/(clean|clear|tidy).*(tasks|todos)|delete (all )?(done|completed)/.test(q)) {
    const runs = await call("clear_done_tasks", {});
    return pick(runs, "Swept the finished ones out of the way 🧹");
  }
  if (/(mark|complete|finish|tick).*(task|todo)/.test(q)) {
    const frag = q.replace(/.*(mark|complete|finish|tick)\s*(the\s*)?(task|todo)?\s*/i, "").replace(/\s*(as\s+)?(done|complete|completed|finished)\s*$/i, "").trim();
    const runs = await call("complete_task", { title: frag });
    return pick(runs, runs[0]?.ok ? "Marked it done ✅" : "I couldn't find that task — which one did you mean?");
  }
  if (/(how (much|long)|screen ?time|app usage|activity report|time (on|spent)|tracked)/.test(q)) {
    const runs = await call("activity_report", { days });
    return pick(runs, "Here's your time report 📊");
  }
  if (/feed/.test(q) && /(pet|him|her|them|mochi|berry|fish|cake|coffee|honey|taco|snack|food)/.test(q)) {
    const food = ["berry", "fish", "cake", "coffee", "honey", "taco"].find((f) => q.includes(f)) ?? "berry";
    const runs = await call("feed_pet", { food });
    return pick(runs, "Snack delivered 🍽");
  }
  if (/(how is|how's|pet status|check (on )?(the )?pet|mood).*(pet|him|her|mochi)?|pet status/.test(q) && /pet|mochi|status/.test(q)) {
    const runs = await call("pet_status", {});
    return pick(runs, "Status check complete 🐾");
  }
  const mUrl = /(https?:\/\/\S+)/.exec(question);
  if (mUrl && /(read|fetch|summar|open|what)/.test(q)) {
    const runs = await call("read_url", { url: mUrl[1] });
    return pick(runs, "I read the page — here's the gist 🔎");
  }
  const mSearch = /(?:search|google|look ?up|research|find)\s+(?:the web\s+)?(?:for\s+)?(.+)/i.exec(question);
  if (mSearch && /search|google|look ?up|research/.test(q)) {
    const runs = await call("web_search", { query: mSearch[1].slice(0, 180) });
    return pick(runs, "Fresh from the live web 🌐");
  }
  if (/(vault|stats|overview|how many notes|summary of my vault)/.test(q)) {
    const runs = await call("vault_stats", {});
    return pick(runs, "Vault report ready 🗄");
  }
  const mNote = /(?:create|make|new)\s+(?:a\s+)?note(?:\s+(?:called|named|titled))?\s+(.+)/i.exec(question);
  if (mNote) {
    const runs = await call("create_note", { title: mNote[1].trim().slice(0, 80), content: `# ${mNote[1].trim().slice(0, 80)}\n\n` });
    return pick(runs, "Fresh note created ✍️");
  }
  return {};
}

async function runAgent(b: AiBody, rows: Note[], species: Species, name: string): Promise<Partial<AiResult>> {
  const question = (b.question ?? "").slice(0, 900);
  const overview = rows
    .slice(0, 10)
    .map((n) => `# ${n.title} · ${parseNote(n.content).words}w · ${new Date(n.updatedAt).toISOString().slice(0, 10)}`)
    .join("\n");
  const messages: ChatMsg[] = [
    { role: "system", content: await agentSystem(name, species) },
    { role: "user", content: `VAULT OVERVIEW (newest first):\n${overview || "(empty vault)"}\n\nCurrently open note: ${b.title || "none"}\n\nUSER REQUEST: ${question}` },
  ];
  const tools: AiTool[] = [];
  const effects: AiEffect[] = [];
  let say = "";
  let mode: "local" | "cloud" = "local";
  for (let round = 0; round < 4; round++) {
    const out = await cloud(messages);
    if (!out) break; // provider unavailable → local heuristics
    mode = "cloud";
    const parsed = extractJson(out);
    if (!parsed) {
      say = out.trim();
      break;
    }
    say = String(parsed.say ?? "").trim();
    effects.push(...sanitizeEffects(parsed.effects));
    const calls = (Array.isArray(parsed.tools) ? parsed.tools : [])
      .filter((c): c is { name: string; args?: Record<string, unknown> } => !!c && typeof (c as { name?: unknown }).name === "string")
      .slice(0, 6);
    if (!calls.length) break;
    const { trace, feedback } = await executeTools(calls);
    tools.push(...trace);
    messages.push({ role: "assistant", content: out });
    messages.push({
      role: "user",
      content: `TOOL RESULTS (round ${round + 1}):\n${feedback}\n\nContinue with STRICT JSON: either more tools, or your final answer JSON with "say" and NO tools. Use the real numbers above.`,
    });
  }
  if (say) return { text: say, mode, tools: tools.length ? tools : undefined, effects: effects.length ? effects : undefined, acted: tools.length > 0 };

  const local = await localAgent(question);
  const allTools = [...tools, ...(local.tools ?? [])];
  const merged: Partial<AiResult> = { ...local, tools: allTools, effects: [...effects, ...(local.effects ?? [])], acted: allTools.length > 0 };
  if (!merged.text) {
    const a = ask(question, rows);
    merged.text = flavor(species, name, a.text, "hi");
    merged.sources = a.sources;
  }
  return merged;
}

/** POST /api/ai */
export async function handleAiRequest(b: AiBody, onDelta?: OnDelta): Promise<AiResult> {
  const body: AiBody = b && typeof b === "object" ? b : { action: "ask" };
  let rows: Note[] = [];
  try {
    const r = await json<Note[]>("/api/notes");
    rows = Array.isArray(r) ? r : [];
  } catch {
    rows = [];
  }
  const species: Species = body.persona?.species ?? "cat";
  const name = body.persona?.name ?? "Mochi";
  const current = rows.find((n) => n.id === body.noteId);
  const text = (body.text ?? current?.content ?? "").slice(0, 20_000);
  const title = body.title ?? current?.title ?? "";
  const res: AiResult = { mode: "local", text: "" };
  const sys = `You are ${name}, a tiny pixel ${species} living inside a markdown notes app. Be warm, brief and useful. Keep markdown and [[wikilinks]] intact.`;
  let useCloud: ChatMsg[] | null = null;

  switch (body.action) {
    case "summarize":
      res.text = flavor(species, name, summarize(text), "hi");
      useCloud = [{ role: "system", content: sys }, { role: "user", content: `Summarize this note in 3-5 concise markdown bullets.\n\n${text}` }];
      break;
    case "continue":
      res.text = continueText(text);
      useCloud = [{ role: "system", content: sys }, { role: "user", content: `Continue this note with the next logical section, same voice. Output only markdown to append.\n\nTitle: ${title}\n\n${text}` }];
      break;
    case "rewrite":
      res.text = rewrite(text, body.style ?? "tidy");
      useCloud = [{ role: "system", content: sys }, { role: "user", content: `Rewrite this text in "${body.style ?? "tidy"}" style (tidy = fix grammar & clarity, concise = shorter, bullets = bullet list, tasks = checklist). Output only the rewritten markdown.\n\n${text}` }];
      break;
    case "brainstorm":
      res.text = brainstorm(title, text);
      useCloud = [{ role: "system", content: sys }, { role: "user", content: `Give 5 creative, concrete sparks to extend this note.\n\nTitle: ${title}\n\n${text}` }];
      break;
    case "outline":
      res.text = outline(text);
      break;
    case "title": {
      const t = suggestTitle(text);
      res.title = t;
      res.text = `How about: **${t}**`;
      break;
    }
    case "tags": {
      const vault = new Set<string>();
      for (const n of rows) for (const t of parseNote(n.content).tags) vault.add(t);
      const tags = suggestTags(text, [...vault]);
      res.tags = tags;
      res.text = tags.length ? "Suggested tags — tap to add:" : "I can't find good tags yet. Write a bit more!";
      break;
    }
    case "links": {
      const links = linkSuggestions({ id: body.noteId ?? "", title, content: text }, rows);
      res.links = links;
      res.text = links.length ? "Notes you might want to link:" : "No obvious links right now. Your note stands alone (for now).";
      break;
    }
    case "fetch": {
      const old = [...rows].sort((a, b2) => a.updatedAt - b2.updatedAt).filter((n) => n.id !== body.noteId);
      const pick = old[Math.floor(Math.random() * Math.min(4, old.length))];
      res.text = pick ? `I dug up **[[${pick.title}]]**. Want to read it again?` : "Nothing to fetch yet!";
      if (pick) res.sources = [{ id: pick.id, title: pick.title }];
      break;
    }
    case "agent": {
      Object.assign(res, await runAgent(body, rows, species, name));
      return res;
    }
    case "ask":
    default: {
      const q = (body.question ?? "").slice(0, 600);
      const a = ask(q, rows);
      res.text = flavor(species, name, a.text, "hi");
      res.sources = a.sources;
      const ctx = search(q, rows, 4)
        .map((h) => `# ${h.note.title}\n${h.note.content.slice(0, 1400)}`)
        .join("\n\n---\n\n");
      useCloud = [
        { role: "system", content: `${sys} Answer ONLY from the notes provided and cite them as [[Title]]. If they don't contain the answer, say so.` },
        { role: "user", content: `Question: ${q}\n\nNotes:\n${ctx || "(no notes matched)"}` },
      ];
    }
  }

  if (useCloud) {
    const out = onDelta ? await cloudStream(useCloud, onDelta) : await cloud(useCloud);
    if (out) {
      res.text = out;
      res.mode = "cloud";
    }
  }
  return res;
}
