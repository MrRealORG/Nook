import { db } from "@/db";
import { ensureReady } from "@/db/ensure";
import { serializeNote } from "@/db/serialize";
import {
  ask,
  brainstorm,
  continueText,
  flavor,
  linkSuggestions,
  outline,
  rewrite,
  search,
  suggestTags,
  suggestTitle,
  summarize,
} from "@/lib/ai-local";
import { executeTools, toolCatalog } from "@/lib/agent-tools";
import type { AiEffect, AiResult, AiTool, Species } from "@/lib/types";
import { parseNote } from "@/lib/util";

export const dynamic = "force-dynamic";

type Body = {
  action: string;
  noteId?: string;
  title?: string;
  text?: string;
  question?: string;
  style?: string;
  persona?: { name?: string; species?: Species };
};

type ChatMsg = { role: "assistant" | "user"; content: string };

async function cloudFetch(messages: ChatMsg[]): Promise<string | null> {
  try {
    const { default: ZAI } = await import("z-ai-web-dev-sdk");
    const zai = await ZAI.create();
    const completion = await zai.chat.completions.create({
      messages,
      thinking: { type: "disabled" },
    });
    return completion.choices[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

/** Cloud call with a hard timeout so the desktop shell falls back to the
 * offline local agent quickly when there's no network. */
async function cloud(messages: ChatMsg[]): Promise<string | null> {
  const timeout = new Promise<null>((res) => setTimeout(() => res(null), 6000));
  return Promise.race([cloudFetch(messages), timeout]);
}

// ------------------------- the harness (tool-using agent) -------------------------

function extractJson(raw: string): { say?: unknown; tools?: unknown; effects?: unknown } | null {
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

const VIEWS_OK = new Set(["notes", "graph", "canvas", "den", "focus", "arcade", "team", "market", "tasks", "activity", "settings"]);

function sanitizeEffects(raw: unknown): AiEffect[] {
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

function agentSystem(name: string, species: string): string {
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
    `- "effects" is optional (max 3): {"type":"navigate","view":"notes|graph|canvas|den|focus|arcade|team|market|tasks|activity|settings"} · {"type":"theme","id":"<theme id>"} · {"type":"pet","mood":"happy|think|spin"} · {"type":"confetti"}.`,
    `- Keep "say" brief, warm, in character. Markdown bullets and [[Note Title]] links welcome.`,
    ``,
    `TOOLS:`,
    toolCatalog(),
  ].join("\n");
}

/** Offline fallback: heuristic intents so the harness still does real work without the cloud model. */
async function localAgent(question: string): Promise<Partial<AiResult>> {
  const q = question.toLowerCase();
  const call = async (name: string, args: Record<string, unknown>) => (await executeTools([{ name, args }])).trace;
  const pick = async (runs: AiTool[], text: string): Promise<Partial<AiResult>> => ({ mode: "local", text, tools: runs.filter(Boolean), acted: runs.length > 0 });

  const due = /(\d+)\s*days?/.exec(q);
  const days = /week/.test(q) ? 7 : due ? Number(due[1]) : 1;

  const mTask = /(?:add|create|new|remember)\s+(?:a\s+|an\s+)?(?:task|todo|to-do)s?(?::|\s)+(?!.*list)(.+)/.exec(question) ?? /remind me to\s+(.+)/i.exec(question);
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
    const frag = q.replace(/.*(mark|complete|finish|tick)\s*(the\s*)?(task|todo)?\s*/i, "").trim();
    const runs = await call("complete_task", { title: frag });
    return pick(runs, `Marked it done ✅`);
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
  const mSearch = /(?:search|google|look ?up|research|find)\s+(?:the web\s+)?(?:for\s+)?(.+)/.exec(question);
  if (mSearch && /search|google|look ?up|research/.test(q)) {
    const runs = await call("web_search", { query: mSearch[1].slice(0, 180) });
    return pick(runs, "Fresh from the live web 🌐");
  }
  if (/(vault|stats|overview|how many notes|summary of my vault)/.test(q)) {
    const runs = await call("vault_stats", {});
    return pick(runs, "Vault report ready 🗄");
  }
  const mNote = /(?:create|make|new)\s+(?:a\s+)?note(?:\s+(?:called|named|titled))?\s+(.+)/.exec(question);
  if (mNote) {
    const runs = await call("create_note", { title: mNote[1].trim().slice(0, 80), content: `# ${mNote[1].trim().slice(0, 80)}\n\n` });
    return pick(runs, "Fresh note created ✍️");
  }
  return {};
}

async function runAgent(b: Body, rows: Awaited<ReturnType<typeof allNotesSafe>>, species: Species, name: string): Promise<Partial<AiResult>> {
  const question = (b.question ?? "").slice(0, 900);
  const overview = rows
    .slice(0, 10)
    .map((n) => `# ${n.title} · ${parseNote(n.content).words}w · ${new Date(n.updatedAt).toISOString().slice(0, 10)}`)
    .join("\n");
  const messages: ChatMsg[] = [
    { role: "assistant", content: agentSystem(name, species) },
    { role: "user", content: `VAULT OVERVIEW (newest first):\n${overview || "(empty vault)"}\n\nCurrently open note: ${b.title || "none"}\n\nUSER REQUEST: ${question}` },
  ];
  const tools: AiTool[] = [];
  const effects: AiEffect[] = [];
  let say = "";
  let mode: "local" | "cloud" = "local";
  for (let round = 0; round < 4; round++) {
    const out = await cloud(messages);
    if (!out) break; // cloud unavailable → fall through to local heuristics
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
  const merged: Partial<AiResult> = {
    ...local,
    tools: [...tools, ...(local.tools ?? [])],
    effects: [...effects, ...(local.effects ?? [])],
    acted: [...tools, ...(local.tools ?? [])].length > 0,
  };
  if (!merged.text) {
    const a = ask(question, rows);
    merged.text = flavor(species, name, a.text, "hi");
    merged.sources = a.sources;
  }
  return merged;
}

async function allNotesSafe() {
  const rows = await db.note.findMany({ orderBy: { updatedAt: "desc" } });
  return rows.map(serializeNote);
}

export async function POST(req: Request) {
  await ensureReady();
  const b = (await req.json()) as Body;
  const rows = (await db.note.findMany({ orderBy: { updatedAt: "desc" } })).map(serializeNote);
  const species: Species = b.persona?.species ?? "cat";
  const name = b.persona?.name ?? "Mochi";
  const current = rows.find((n) => n.id === b.noteId);
  const text = (b.text ?? current?.content ?? "").slice(0, 20_000);
  const title = b.title ?? current?.title ?? "";
  const res: AiResult = { mode: "local", text: "" };
  const sys = `You are ${name}, a tiny pixel ${species} living inside a markdown notes app. Be warm, brief and useful. Keep markdown and [[wikilinks]] intact.`;
  let useCloud: ChatMsg[] | null = null;

  switch (b.action) {
    case "summarize":
      res.text = flavor(species, name, summarize(text), "hi");
      useCloud = [{ role: "assistant", content: sys }, { role: "user", content: `Summarize this note in 3-5 concise markdown bullets.\n\n${text}` }];
      break;
    case "continue":
      res.text = continueText(text);
      useCloud = [{ role: "assistant", content: sys }, { role: "user", content: `Continue this note with the next logical section, same voice. Output only markdown to append.\n\nTitle: ${title}\n\n${text}` }];
      break;
    case "rewrite":
      res.text = rewrite(text, b.style ?? "tidy");
      useCloud = [{ role: "assistant", content: sys }, { role: "user", content: `Rewrite this text in "${b.style ?? "tidy"}" style (tidy = fix grammar & clarity, concise = shorter, bullets = bullet list, tasks = checklist). Output only the rewritten markdown.\n\n${text}` }];
      break;
    case "brainstorm":
      res.text = brainstorm(title, text);
      useCloud = [{ role: "assistant", content: sys }, { role: "user", content: `Give 5 creative, concrete sparks to extend this note.\n\nTitle: ${title}\n\n${text}` }];
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
      const links = linkSuggestions({ id: b.noteId ?? "", title, content: text }, rows);
      res.links = links;
      res.text = links.length ? "Notes you might want to link:" : "No obvious links right now. Your note stands alone (for now).";
      break;
    }
    case "fetch": {
      const old = [...rows].sort((a, b2) => a.updatedAt - b2.updatedAt).filter((n) => n.id !== b.noteId);
      const pick = old[Math.floor(Math.random() * Math.min(4, old.length))];
      res.text = pick ? `I dug up **[[${pick.title}]]**. Want to read it again?` : "Nothing to fetch yet!";
      if (pick) res.sources = [{ id: pick.id, title: pick.title }];
      break;
    }
    case "agent": {
      // full tool-using harness: the model plans, tools execute server-side, results feed back
      const out = await runAgent(b, rows, species, name);
      Object.assign(res, out);
      return Response.json(res);
    }
    case "ask":
    default: {
      const q = (b.question ?? "").slice(0, 600);
      const a = ask(q, rows);
      res.text = flavor(species, name, a.text, "hi");
      res.sources = a.sources;
      const ctx = search(q, rows, 4)
        .map((h) => `# ${h.note.title}\n${h.note.content.slice(0, 1400)}`)
        .join("\n\n---\n\n");
      useCloud = [
        { role: "assistant", content: `${sys} Answer ONLY from the notes provided and cite them as [[Title]]. If they don't contain the answer, say so.` },
        { role: "user", content: `Question: ${q}\n\nNotes:\n${ctx || "(no notes matched)"}` },
      ];
    }
  }

  if (useCloud) {
    const out = await cloud(useCloud);
    if (out) {
      res.text = out;
      res.mode = "cloud";
    }
  }
  return Response.json(res);
}
