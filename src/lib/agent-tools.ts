import { db } from "@/db";
import { ensureReady } from "@/db/ensure";
import { serializeNote } from "@/db/serialize";
import { FOODS, levelOf, stageOf } from "@/lib/pet";
import type { Species } from "@/lib/types";
import { clamp, parseNote, titleKey } from "@/lib/util";

/**
 * The AI harness — a registry of real tools the assistant can execute server-side.
 * Both the cloud model (JSON tool-call protocol) and the offline local fallback
 * (intent heuristics) route through the same executors, so the AI can ACTUALLY do work:
 * create notes/tasks, tidy the vault, check the pet, inspect the market, report app
 * usage and even search the live web.
 */

export type ToolRun = { ok: boolean; summary: string; data?: unknown };
export type ToolTrace = { name: string; args: Record<string, unknown>; ok: boolean; summary: string; ms: number };
export type Effect =
  | { type: "navigate"; view: string }
  | { type: "theme"; id: string }
  | { type: "pet"; mood: "happy" | "think" | "spin" }
  | { type: "confetti" };

type ToolDef = {
  name: string;
  group: "notes" | "tasks" | "pet" | "market" | "activity" | "vault" | "web" | "rules";
  desc: string;
  args: Record<string, string>; // arg name → short description for the model
  exec: (a: Record<string, unknown>) => Promise<ToolRun>;
};

const S = (v: unknown, max = 200): string => String(v ?? "").trim().slice(0, max);
const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

async function allNotes() {
  const rows = await db.note.findMany({ orderBy: { updatedAt: "desc" } });
  return rows.map(serializeNote);
}

export const TOOLS: ToolDef[] = [
  // ---------------- notes ----------------
  {
    name: "list_notes",
    group: "notes",
    desc: "List notes in the vault (newest first). Optionally filter by a text query.",
    args: { query: "optional text filter", limit: "optional max rows (default 12)" },
    exec: async (a) => {
      const rows = await allNotes();
      const q = S(a.query).toLowerCase();
      const hit = rows
        .filter((n) => !q || n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q))
        .slice(0, Math.min(30, Number(a.limit) || 12));
      return {
        ok: true,
        summary: hit.length ? `${hit.length} note(s): ${hit.map((n) => `“${n.title}”`).join(", ")}` : "No notes matched.",
        data: hit.map((n) => ({ id: n.id, title: n.title, words: parseNote(n.content).words, updatedAt: n.updatedAt })),
      };
    },
  },
  {
    name: "read_note",
    group: "notes",
    desc: "Read the full markdown of one note by id or exact-ish title.",
    args: { id: "note id", title: "or note title" },
    exec: async (a) => {
      const rows = await allNotes();
      const id = S(a.id);
      const t = titleKey(S(a.title));
      const n = rows.find((x) => x.id === id) ?? rows.find((x) => titleKey(x.title) === t);
      if (!n) return { ok: false, summary: "Note not found." };
      return { ok: true, summary: `Read “${n.title}” (${parseNote(n.content).words} words).`, data: { id: n.id, title: n.title, content: n.content.slice(0, 6000) } };
    },
  },
  {
    name: "search_notes",
    group: "notes",
    desc: "Full-text search across the whole vault with ranked snippets.",
    args: { query: "text to search for", limit: "optional max hits (default 5)" },
    exec: async (a) => {
      const q = S(a.query).toLowerCase();
      if (!q) return { ok: false, summary: "A query is required." };
      const rows = await allNotes();
      const hits = rows
        .map((n) => {
          const body = n.content.toLowerCase();
          const score = (n.title.toLowerCase().includes(q) ? 3 : 0) + (body.split(q).length - 1);
          const idx = body.indexOf(q);
          return { n, score, snippet: idx >= 0 ? n.content.slice(Math.max(0, idx - 40), idx + 120) : "" };
        })
        .filter((h) => h.score > 0)
        .sort((x, y) => y.score - x.score)
        .slice(0, Math.min(10, Number(a.limit) || 5));
      return {
        ok: true,
        summary: hits.length ? `${hits.length} hit(s) for “${S(a.query)}”.` : `Nothing in the vault matches “${S(a.query)}”.`,
        data: hits.map((h) => ({ id: h.n.id, title: h.n.title, snippet: h.snippet })),
      };
    },
  },
  {
    name: "create_note",
    group: "notes",
    desc: "Create a new markdown note in the vault.",
    args: { title: "note title", content: "markdown body (optional)", folder: "folder name to file it into (optional)" },
    exec: async (a) => {
      const title = S(a.title, 120);
      if (!title) return { ok: false, summary: "A title is required." };
      let folderId: string | null = null;
      const fname = S(a.folder, 60);
      if (fname) {
        const f = await db.folder.findFirst({ where: { name: { equals: fname, }, } });
        folderId = f?.id ?? (await db.folder.create({ data: { id: crypto.randomUUID(), name: fname, position: await db.folder.count() } })).id;
      }
      const id = crypto.randomUUID();
      await db.note.create({ data: { id, title, content: S(a.content, 30_000) || `# ${title}\n\n`, folderId } });
      return { ok: true, summary: `Created note “${title}”${fname ? ` in ${fname}` : ""}.`, data: { id, title } };
    },
  },
  {
    name: "append_to_note",
    group: "notes",
    desc: "Append markdown to the end of a note (by id or title).",
    args: { id: "note id", title: "or note title", text: "markdown to append" },
    exec: async (a) => {
      const rows = await allNotes();
      const id = S(a.id);
      const t = titleKey(S(a.title));
      const n = rows.find((x) => x.id === id) ?? rows.find((x) => titleKey(x.title) === t);
      const text = S(a.text, 8000);
      if (!n) return { ok: false, summary: "Note not found." };
      if (!text) return { ok: false, summary: "Nothing to append." };
      await db.note.update({ where: { id: n.id }, data: { content: `${n.content.replace(/\s*$/, "")}\n\n${text}\n` } });
      return { ok: true, summary: `Appended ${text.split(/\s+/).length} words to “${n.title}”.` };
    },
  },
  {
    name: "create_folder",
    group: "notes",
    desc: "Create a folder to organize notes.",
    args: { name: "folder name" },
    exec: async (a) => {
      const name = S(a.name, 60);
      if (!name) return { ok: false, summary: "A folder name is required." };
      const exists = await db.folder.findFirst({ where: { name } });
      if (exists) return { ok: false, summary: `Folder “${name}” already exists.` };
      const f = await db.folder.create({ data: { id: crypto.randomUUID(), name, position: await db.folder.count() } });
      return { ok: true, summary: `Created folder “${f.name}”.`, data: { id: f.id } };
    },
  },
  {
    name: "vault_stats",
    group: "vault",
    desc: "Overview of the vault: note/word/link counts, open tasks, top tags, streak-ish facts.",
    args: {},
    exec: async () => {
      const rows = await allNotes();
      let words = 0, links = 0, noteTasks = 0, openNoteTasks = 0;
      const tagCount = new Map<string, number>();
      for (const n of rows) {
        const m = parseNote(n.content);
        words += m.words; links += m.links.length;
        noteTasks += m.tasks.total; openNoteTasks += m.tasks.total - m.tasks.done;
        for (const t of m.tags) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
      }
      const openTasks = await db.task.count({ where: { done: false } });
      const topTags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t, c]) => `#${t}×${c}`);
      return {
        ok: true,
        summary: `Vault: ${rows.length} notes · ${words.toLocaleString()} words · ${links} links · ${openTasks} open tasks (${openNoteTasks} inside notes).`,
        data: { notes: rows.length, words, links, openTasks, openNoteTasks, topTags },
      };
    },
  },
  // ---------------- tasks ----------------
  {
    name: "list_tasks",
    group: "tasks",
    desc: "List tasks. Filter by list (today/upcoming/someday) or done state.",
    args: { list: "today | upcoming | someday (optional)", done: "true/false filter (optional)" },
    exec: async (a) => {
      const where: Record<string, unknown> = {};
      if (S(a.list)) where.list = S(a.list);
      if (S(a.done) === "true" || S(a.done) === "false") where.done = S(a.done) === "true";
      const rows = await db.task.findMany({ where, orderBy: [{ done: "asc" }, { createdAt: "desc" }], take: 40 });
      const label = rows.length ? rows.map((t) => `${t.done ? "☑" : "☐"} ${t.title}${t.priority === 2 ? " (!!)" : ""}`).join("; ") : "No tasks in that view.";
      return { ok: true, summary: label, data: rows.map((t) => ({ id: t.id, title: t.title, list: t.list, priority: t.priority, done: t.done, due: t.due })) };
    },
  },
  {
    name: "create_task",
    group: "tasks",
    desc: "Create a task/todo. Priority 0=low 1=normal 2=high. list: today/upcoming/someday.",
    args: { title: "task title", list: "today | upcoming | someday (default today)", priority: "0-2 (optional)", due: "epoch ms (optional)" },
    exec: async (a) => {
      const title = S(a.title, 160);
      if (!title) return { ok: false, summary: "A task title is required." };
      const list = ["today", "upcoming", "someday"].includes(S(a.list)) ? S(a.list) : "today";
      const t = await db.task.create({
        data: {
          id: crypto.randomUUID(), title, list, by: "ai",
          priority: [0, 1, 2].includes(Number(a.priority)) ? Number(a.priority) : 1,
          due: Number.isFinite(Number(a.due)) && Number(a.due) > 0 ? Number(a.due) : null,
        },
      });
      return { ok: true, summary: `Added task “${t.title}” to ${t.list}${t.priority === 2 ? " (high priority)" : ""}.`, data: { id: t.id } };
    },
  },
  {
    name: "complete_task",
    group: "tasks",
    desc: "Mark a task done by id or (part of) its title.",
    args: { id: "task id", title: "or task title fragment" },
    exec: async (a) => {
      let t = null as Awaited<ReturnType<typeof db.task.findFirst>>;
      if (S(a.id)) t = await db.task.findUnique({ where: { id: S(a.id) } });
      if (!t && S(a.title)) {
        const frag = S(a.title).toLowerCase();
        const rows = await db.task.findMany({ where: { done: false }, take: 50 });
        t = rows.find((x) => x.title.toLowerCase().includes(frag)) ?? null;
      }
      if (!t) return { ok: false, summary: "Task not found." };
      await db.task.update({ where: { id: t.id }, data: { done: true, completedAt: new Date() } });
      return { ok: true, summary: `Completed “${t.title}”.` };
    },
  },
  {
    name: "delete_task",
    group: "tasks",
    desc: "Delete a task permanently by id or title fragment.",
    args: { id: "task id", title: "or task title fragment" },
    exec: async (a) => {
      if (S(a.id)) {
        const r = await db.task.deleteMany({ where: { id: S(a.id) } });
        return r.count ? { ok: true, summary: "Task deleted." } : { ok: false, summary: "Task not found." };
      }
      const frag = S(a.title).toLowerCase();
      if (!frag) return { ok: false, summary: "Give me the task id or part of the title." };
      const rows = await db.task.findMany({ take: 60 });
      const t = rows.find((x) => x.title.toLowerCase().includes(frag));
      if (!t) return { ok: false, summary: "Task not found." };
      await db.task.delete({ where: { id: t.id } });
      return { ok: true, summary: `Deleted “${t.title}”.` };
    },
  },
  {
    name: "clear_done_tasks",
    group: "tasks",
    desc: "Delete every completed task (spring cleaning).",
    args: {},
    exec: async () => {
      const r = await db.task.deleteMany({ where: { done: true } });
      return { ok: true, summary: `Cleared ${r.count} completed task${r.count === 1 ? "" : "s"}.` };
    },
  },
  // ---------------- pet ----------------
  {
    name: "pet_status",
    group: "pet",
    desc: "Check the pet's mood: food, energy, joy, level, coins and lifetime stats.",
    args: {},
    exec: async () => {
      const row = await db.pet.findFirst();
      if (!row) return { ok: false, summary: "No pet yet." };
      const p = serializePetLike(row);
      const lv = levelOf(p.xp);
      const st = stageOf(lv.level);
      return {
        ok: true,
        summary: `${p.name} (Lv ${lv.level} ${st.name}) — food ${Math.round(p.food)}/100, energy ${Math.round(p.energy)}/100, joy ${Math.round(p.joy)}/100, ${p.coins} coins.`,
        data: p,
      };
    },
  },
  {
    name: "feed_pet",
    group: "pet",
    desc: "Feed the pet a snack (costs coins like feeding by hand). Options: berry(free), fish, cake, coffee, honey, taco.",
    args: { food: "food id (default berry)" },
    exec: async (a) => {
      const row = await db.pet.findFirst();
      if (!row) return { ok: false, summary: "No pet yet." };
      const p = serializePetLike(row);
      const f = FOODS.find((x) => x.id === (S(a.food) || "berry")) ?? FOODS[0];
      if (p.coins < f.cost) return { ok: false, summary: `Not enough coins for ${f.name} (${f.cost}c). ${p.name} has ${p.coins}c.` };
      const next = {
        food: clamp(p.food + f.food, 0, 100),
        joy: clamp(p.joy + f.joy, 0, 100),
        energy: clamp(p.energy + f.energy, 0, 100),
        coins: p.coins - f.cost,
        xp: p.xp + 2,
      };
      await db.pet.update({ where: { id: row.id }, data: { ...next, tickAt: new Date() } });
      return { ok: true, summary: `Fed ${f.name} to ${p.name}: +${f.food} food${f.joy ? ` +${f.joy} joy` : ""}${f.energy ? ` +${f.energy} energy` : ""}${f.cost ? ` (-${f.cost} coins)` : ""}.` };
    },
  },
  {
    name: "cheer_pet",
    group: "pet",
    desc: "Cheer the pet up (small free joy boost, once per conversation).",
    args: {},
    exec: async () => {
      const row = await db.pet.findFirst();
      if (!row) return { ok: false, summary: "No pet yet." };
      const p = serializePetLike(row);
      await db.pet.update({ where: { id: row.id }, data: { joy: clamp(p.joy + 3, 0, 100), tickAt: new Date() } });
      return { ok: true, summary: `${p.name} beams! +3 joy.` };
    },
  },
  // ---------------- market ----------------
  {
    name: "list_market",
    group: "market",
    desc: "Browse open marketplace listings (hats, pets, food, themes, decor) with prices.",
    args: { kind: "hat | pet | food | theme | decor (optional)", limit: "max rows (default 10)" },
    exec: async (a) => {
      const where: Record<string, unknown> = { sold: false };
      if (S(a.kind)) where.kind = S(a.kind);
      const rows = await db.listing.findMany({ where, orderBy: { price: "asc" }, take: Math.min(20, Number(a.limit) || 10) });
      return {
        ok: true,
        summary: rows.length ? `Cheapest first: ${rows.map((l) => `${l.name} ${l.price}c`).join(", ")}` : "The bazaar shelves are empty right now.",
        data: rows.map((l) => ({ id: l.id, name: l.name, kind: l.kind, price: l.price })),
      };
    },
  },
  // ---------------- activity ----------------
  {
    name: "activity_report",
    group: "activity",
    desc: "Report tracked app/screen time (TimeLens-style): totals per app + productive vs distraction split.",
    args: { days: "how many days back (default 1 = today)" },
    exec: async (a) => {
      const days = Math.min(14, Math.max(1, Number(a.days) || 1));
      const cutoff = new Date(Date.now() - (days - 1) * 86_400_000);
      const rows = await db.appUse.findMany({ where: { day: { gte: dayKey(cutoff) } } });
      if (!rows.length) return { ok: true, summary: days === 1 ? "No app usage tracked today yet." : `No app usage tracked in the last ${days} days.` };
      const perApp = new Map<string, number>();
      const perCat = { productive: 0, neutral: 0, distraction: 0 };
      for (const r of rows) {
        perApp.set(r.app, (perApp.get(r.app) ?? 0) + r.secs);
        if (r.cat in perCat) perCat[r.cat as keyof typeof perCat] += r.secs;
      }
      const top = [...perApp.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8);
      const fmt = (s: number) => `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
      const total = top.reduce((acc, [, v]) => acc + v, 0) || rows.reduce((acc, r) => acc + r.secs, 0);
      return {
        ok: true,
        summary: `Last ${days} day(s): ${fmt(total)} tracked. Top: ${top.map(([ap, v]) => `${ap} ${fmt(v)}`).join(", ")}. Productive ${fmt(perCat.productive)} · neutral ${fmt(perCat.neutral)} · distraction ${fmt(perCat.distraction)}.`,
        data: { perApp: Object.fromEntries(top), perCat, days },
      };
    },
  },
  // ---------------- rules (admin manager) ----------------
  {
    name: "rules_report",
    group: "rules",
    desc: "Read the user's activity rulebook: shield state, blocked sites, per-app limits, quiet hours and category patterns.",
    args: {},
    exec: async () => {
      const row = await db.setting.findUnique({ where: { id: "activity-rules" } });
      const rules = row ? JSON.parse(row.value) : null;
      if (!rules) return { ok: true, summary: "No rules saved yet — the rulebook is empty (shield off, nothing blocked)." };
      const s = rules as { shieldOn?: boolean; blocklist?: { match: string; enabled: boolean }[]; limits?: Record<string, number>; quiet?: { enabled: boolean; from: number; to: number }; patterns?: { match: string; cat: string }[] };
      const blocks = (s.blocklist ?? []).filter((b) => b.enabled).map((b) => b.match);
      const limits = Object.entries(s.limits ?? {});
      return {
        ok: true,
        summary: `Shield ${s.shieldOn ? "UP" : "down"}. Blocked: ${blocks.length ? blocks.join(", ") : "none"}. Limits: ${limits.length ? limits.map(([a, m]) => `${a} ${m}m/day`).join(", ") : "none"}. Quiet hours: ${s.quiet?.enabled ? `${s.quiet.from}:00–${s.quiet.to}:00` : "off"}. Patterns: ${(s.patterns ?? []).length}.`,
        data: rules,
      };
    },
  },
  {
    name: "rule_block_site",
    group: "rules",
    desc: "Block a site/app by keyword (substring match). The shield then bounces anything whose name contains it.",
    args: { match: "keyword to block, e.g. 'reddit'" },
    exec: async (a) => {
      const match = S(a.match, 60).toLowerCase();
      if (!match) return { ok: false, summary: "A keyword is required." };
      const row = await db.setting.findUnique({ where: { id: "activity-rules" } });
      const rules = (row ? JSON.parse(row.value) : { shieldOn: false, blocklist: [], limits: {}, quiet: { enabled: false, from: 9, to: 12 }, patterns: [], pinHash: "" }) as { blocklist: { id: string; match: string; enabled: boolean; createdAt: number }[] };
      if (rules.blocklist.some((b) => b.match === match)) return { ok: true, summary: `“${match}” is already on the blocklist.` };
      rules.blocklist.push({ id: `ai-${Date.now().toString(36)}`, match, enabled: true, createdAt: Date.now() });
      await db.setting.upsert({ where: { id: "activity-rules" }, create: { id: "activity-rules", value: JSON.stringify(rules) }, update: { value: JSON.stringify(rules) } });
      return { ok: true, summary: `Blocked “${match}” (${rules.blocklist.length} rules total). It will be bounced whenever the shield is up.` };
    },
  },
  {
    name: "rule_unblock_site",
    group: "rules",
    desc: "Remove a keyword from the blocklist.",
    args: { match: "keyword to unblock" },
    exec: async (a) => {
      const match = S(a.match, 60).toLowerCase();
      const row = await db.setting.findUnique({ where: { id: "activity-rules" } });
      if (!row) return { ok: false, summary: "No rules saved — nothing to unblock." };
      const rules = JSON.parse(row.value) as { blocklist: { match: string }[] };
      const before = rules.blocklist.length;
      rules.blocklist = rules.blocklist.filter((b) => b.match !== match);
      if (rules.blocklist.length === before) return { ok: false, summary: `“${match}” wasn't on the blocklist.` };
      await db.setting.upsert({ where: { id: "activity-rules" }, create: { id: "activity-rules", value: JSON.stringify(rules) }, update: { value: JSON.stringify(rules) } });
      return { ok: true, summary: `Unblocked “${match}”.` };
    },
  },
  {
    name: "rule_set_limit",
    group: "rules",
    desc: "Set a daily minute budget for an app (0 removes it).",
    args: { app: "app name", mins: "minutes per day" },
    exec: async (a) => {
      const app = S(a.app, 40).toLowerCase();
      const mins = Math.round(Number(a.mins));
      if (!app) return { ok: false, summary: "An app name is required." };
      if (!Number.isFinite(mins) || mins < 0 || mins > 720) return { ok: false, summary: "mins must be 0–720." };
      const row = await db.setting.findUnique({ where: { id: "activity-rules" } });
      const rules = (row ? JSON.parse(row.value) : { shieldOn: false, blocklist: [], limits: {}, quiet: { enabled: false, from: 9, to: 12 }, patterns: [], pinHash: "" }) as { limits: Record<string, number> };
      if (mins === 0) delete rules.limits[app];
      else rules.limits[app] = mins;
      await db.setting.upsert({ where: { id: "activity-rules" }, create: { id: "activity-rules", value: JSON.stringify(rules) }, update: { value: JSON.stringify(rules) } });
      return { ok: true, summary: mins === 0 ? `Removed the limit for ${app}.` : `${app} is now limited to ${mins} min/day.` };
    },
  },
  {
    name: "rule_set_shield",
    group: "rules",
    desc: "Turn the shield ON or OFF — when up, blocked sites are bounced and limits/quiet hours are enforced.",
    args: { on: "true or false" },
    exec: async (a) => {
      const on = a.on === true || a.on === "true" || a.on === "on";
      const row = await db.setting.findUnique({ where: { id: "activity-rules" } });
      const rules = (row ? JSON.parse(row.value) : { shieldOn: false, blocklist: [], limits: {}, quiet: { enabled: false, from: 9, to: 12 }, patterns: [], pinHash: "" }) as { shieldOn: boolean };
      rules.shieldOn = on;
      await db.setting.upsert({ where: { id: "activity-rules" }, create: { id: "activity-rules", value: JSON.stringify(rules) }, update: { value: JSON.stringify(rules) } });
      return { ok: true, summary: on ? "Shield is UP — rules are enforced." : "Shield is down — tracking only." };
    },
  },
  // ---------------- web ----------------
  {
    name: "web_search",
    group: "web",
    desc: "Search the live web and return top results with snippets. Use for research and fresh facts.",
    args: { query: "what to search for", num: "number of results (default 5, max 8)" },
    exec: async (a) => {
      const query = S(a.query, 200);
      if (!query) return { ok: false, summary: "A search query is required." };
      try {
        const { default: ZAI } = await import("z-ai-web-dev-sdk");
        const zai = await ZAI.create();
        const results = (await zai.functions.invoke("web_search", { query, num: Math.min(8, Math.max(1, Number(a.num) || 5)) })) as {
          url?: string; name?: string; snippet?: string; host_name?: string; date?: string;
        }[];
        const items = (Array.isArray(results) ? results : []).slice(0, 8).map((r) => ({
          title: r.name ?? r.url ?? "", url: r.url ?? "", snippet: (r.snippet ?? "").slice(0, 240), host: r.host_name ?? "", date: r.date ?? "",
        }));
        if (!items.length) return { ok: true, summary: `The web search returned nothing for “${query}”.` };
        return {
          ok: true,
          summary: `Found ${items.length} web results for “${query}”: ${items.slice(0, 3).map((i) => i.title || i.host).filter(Boolean).join("; ")}…`,
          data: items,
        };
      } catch {
        return { ok: false, summary: "Web search is unavailable right now (offline or rate-limited)." };
      }
    },
  },
  {
    name: "read_url",
    group: "web",
    desc: "Fetch and read a web page (article text) — great after a web_search.",
    args: { url: "page url (https://…)" },
    exec: async (a) => {
      const url = S(a.url, 400);
      if (!/^https?:\/\//.test(url)) return { ok: false, summary: "A full http(s) URL is required." };
      try {
        const { default: ZAI } = await import("z-ai-web-dev-sdk");
        const zai = await ZAI.create();
        const r = (await zai.functions.invoke("page_reader", { url })) as { title?: string; html?: string; text?: string };
        const text = (r.text ?? (r.html ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
        if (!text) return { ok: false, summary: "Could not extract text from that page." };
        return { ok: true, summary: `Read “${r.title ?? url}” (${Math.min(text.length, 9999)} chars).`, data: { title: r.title ?? url, text: text.slice(0, 3000) } };
      } catch {
        return { ok: false, summary: "That page could not be fetched." };
      }
    },
  },
  {
    name: "report_bug",
    group: "web",
    desc: "File a bug/problem report on behalf of the user into the in-app Logs & Bugs tracker. Use when the user says something is broken or asks to report a bug.",
    args: { desc: "clear description of the problem (steps help)", severity: "minor | normal | blocker (default normal)" },
    exec: async (a) => {
      const desc = S(a.desc, 1200);
      if (!desc) return { ok: false, summary: "A description is required." };
      const severity = ["minor", "normal", "blocker"].includes(S(a.severity, 10)) ? S(a.severity, 10) : "normal";
      const row = await db.bug.create({
        data: { id: crypto.randomUUID(), desc, severity, page: "ai-harness", ua: "filed-by-assistant", logs: "", status: "open" },
      });
      return { ok: true, summary: `Bug report #${row.id.slice(0, 6)} filed (${severity}). The user can track it in Logs & Bugs.`, data: { id: row.id, severity } };
    },
  },
];

// pet serializer without pulling the whole db/serialize module graph (it imports prisma types only, but keep this self-contained)
function serializePetLike(row: {
  name: string; species: string; food: number; energy: number; joy: number; xp: number; coins: number; hat: string; owned: string; stats: string;
}) {
  return {
    name: row.name,
    species: row.species as Species,
    food: row.food, energy: row.energy, joy: row.joy, xp: row.xp, coins: row.coins,
    hat: row.hat,
    owned: JSON.parse(row.owned || "[]") as string[],
    stats: JSON.parse(row.stats || "{}") as Record<string, number>,
  };
}

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/** Execute a batch of tool calls (max 6). Returns the trace + a text blob to feed back to the model. */
export async function executeTools(calls: { name: string; args?: Record<string, unknown> }[]): Promise<{ trace: ToolTrace[]; feedback: string }> {
  await ensureReady();
  const trace: ToolTrace[] = [];
  const lines: string[] = [];
  for (const call of calls.slice(0, 6)) {
    const tool = TOOL_MAP.get(call?.name);
    const t0 = Date.now();
    if (!tool) {
      trace.push({ name: call?.name ?? "?", args: call?.args ?? {}, ok: false, summary: "Unknown tool.", ms: 0 });
      lines.push(`${call?.name}: ERROR unknown tool`);
      continue;
    }
    try {
      const r = await tool.exec(call?.args ?? {});
      trace.push({ name: tool.name, args: call?.args ?? {}, ok: r.ok, summary: r.summary, ms: Date.now() - t0 });
      lines.push(`${tool.name}(${JSON.stringify(call?.args ?? {})}): ${r.ok ? "OK" : "FAILED"} — ${r.summary}${r.data !== undefined ? ` | data: ${JSON.stringify(r.data).slice(0, 1400)}` : ""}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "tool crashed";
      trace.push({ name: tool.name, args: call?.args ?? {}, ok: false, summary: msg, ms: Date.now() - t0 });
      lines.push(`${tool.name}: ERROR ${msg}`);
    }
  }
  return { trace, feedback: lines.join("\n") || "No tools ran." };
}

/** English description of the tool list for the system prompt. */
export function toolCatalog(): string {
  return TOOLS.map((t) => `- ${t.name}(${Object.keys(t.args).join(", ")}): ${t.desc}`).join("\n");
}
