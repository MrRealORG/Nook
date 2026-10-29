/**
 * MCP (Model Context Protocol) endpoint — JSON-RPC 2.0 over HTTP.
 *
 * POST /api/mcp  → single JSON-RPC request {jsonrpc,id,method,params} or a batch array.
 * GET  /api/mcp  → friendly server info (HTML for browsers, JSON otherwise).
 * OPTIONS        → CORS preflight (all responses carry permissive CORS headers so
 *                  external CLIs can hit this cross-origin).
 *
 * Methods: initialize · notifications/initialized · ping · tools/list · tools/call
 * Optional auth: if a Setting row "mcp-token" exists, tools other than
 * initialize/tools/list/ping require `Authorization: Bearer <token>`.
 */

import { db } from "@/lib/db";
import { ensureReady } from "@/db/ensure";
import { getMcpToken } from "@/lib/mcpTokens";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SERVER_NAME = "Nook Workspace MCP";
const SERVER_VERSION = "1.0.0";
const PROTOCOL_VERSION = "2025-03-26";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, mcp-session-id, authorization, mcp-protocol-version",
  "Access-Control-Expose-Headers": "mcp-session-id",
  "Access-Control-Max-Age": "86400",
};

const EXEMPT_METHODS = new Set(["initialize", "notifications/initialized", "ping", "tools/list"]);

const LISTS = new Set(["today", "upcoming", "someday"]);

/* ---------------------------------- types --------------------------------- */

type RpcId = string | number | null;
type RpcParams = Record<string, unknown>;
type ToolContent = { type: "text"; text: string };
type ToolResult = { content: ToolContent[]; isError?: boolean };
type JsonSchemaProp = { type: string; description?: string; enum?: string[]; items?: { type: string } };
type ToolDef = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, JsonSchemaProp>; required?: string[] };
};

/* --------------------------------- helpers -------------------------------- */

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}

function ok(id: RpcId, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id: RpcId, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function strArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string").map((s) => s.slice(0, 60)).slice(0, 30);
}
/** accept an ISO date string (preferred) or epoch-ms number → epoch ms | null */
function dueToMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}
/** Task.tags / Note.tags are stored as JSON strings — never trust them */
function parseTags(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function dayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}


/**
 * Task.due is an Int (32-bit) SQLite column — epoch-ms values (≈1.7e12) can never
 * fit, and Prisma rejects the write. We can't migrate the schema from here, so
 * persist best-effort and surface an explicit warning instead of failing the call.
 */
function persistDue(ms: number | null): { due: bigint | null; dueWarning?: string } {
  if (ms === null || !Number.isFinite(ms)) return { due: null };
  return { due: BigInt(Math.round(ms)) };
}

function taskOut(t: {
  id: string; title: string; list: string; priority: number; due: bigint | number | null; done: boolean;
  noteId: string | null; tags: string; by: string; createdAt: Date; completedAt: Date | null;
}) {
  const dueMs = t.due == null ? null : typeof t.due === "bigint" ? Number(t.due) : t.due;
  return {
    id: t.id,
    title: t.title,
    list: t.list,
    priority: t.priority,
    due: dueMs != null && Number.isFinite(dueMs) ? new Date(dueMs).toISOString() : null,
    done: t.done,
    noteId: t.noteId,
    tags: parseTags(t.tags),
    by: t.by,
    createdAt: t.createdAt instanceof Date ? t.createdAt.toISOString() : String(t.createdAt),
    completedAt: t.completedAt instanceof Date ? t.completedAt.toISOString() : null,
  };
}

/* ------------------------------ tool catalog ------------------------------ */

const TOOL_CATALOG: ToolDef[] = [
  {
    name: "list_tasks",
    description: "List the user's todo tasks. Filter by status (open/done/all) and by list (today/upcoming/someday).",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "done", "all"], description: "default: all" },
        list: { type: "string", enum: ["today", "upcoming", "someday"], description: "which task list" },
      },
    },
  },
  {
    name: "create_task",
    description: "Create a todo task on the user's behalf (marked as created by 'agent').",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "task title (max 200 chars)" },
        list: { type: "string", enum: ["today", "upcoming", "someday"], description: "default: today" },
        priority: { type: "number", description: "0 low · 1 normal · 2 high (default 1)" },
        due: { type: "string", description: "ISO date string, e.g. 2025-06-01 (persisted best-effort — the Task.due column is Int32 and cannot store epoch ms, so the response may include a dueWarning)" },
        tags: { type: "array", items: { type: "string" }, description: "optional tag strings" },
      },
      required: ["title"],
    },
  },
  {
    name: "complete_task",
    description: "Mark a task as done (sets completedAt to now).",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "task id" } }, required: ["id"] },
  },
  {
    name: "update_task",
    description: "Patch-edit a task: title, list, priority, due and/or done.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "task id" },
        title: { type: "string" },
        list: { type: "string", enum: ["today", "upcoming", "someday"] },
        priority: { type: "number" },
        due: { type: "string", description: "ISO date string (or epoch ms) — see create_task note about the Int32 due column" },
        done: { type: "boolean" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_task",
    description: "Permanently delete a task by id.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "task id" } }, required: ["id"] },
  },
  {
    name: "list_notes",
    description: "Search the user's notes by keyword (case-insensitive match on title/content). Returns id, title, tags, updatedAt and a 160-char snippet.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "keyword to search for (omit to list recent notes)" },
        limit: { type: "number", description: "max notes to return, 1-50 (default 20)" },
      },
    },
  },
  {
    name: "read_note",
    description: "Read one note in full: id, title, content, tags, updatedAt.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "note id" } }, required: ["id"] },
  },
  {
    name: "write_note",
    description: "Create a new note with the given title and (markdown) content.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "append_note",
    description: "Append content to the end of an existing note (separated by a newline).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "note id" }, content: { type: "string" } },
      required: ["id", "content"],
    },
  },
  {
    name: "rename_note",
    description: "Rename an existing note (change its title only, content is untouched).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "note id" }, title: { type: "string", description: "new title (max 200 chars)" } },
      required: ["id", "title"],
    },
  },
  {
    name: "delete_note",
    description: "Permanently delete a note by id. Destructive — prefer append/rename when unsure.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "note id" } }, required: ["id"] },
  },
  {
    name: "list_tags",
    description: "All tags in use across the workspace's notes and tasks, with usage counts — handy before tagging something new.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "today_brief",
    description: "One-glance daily brief: open tasks (today first), recently touched notes, the pet's status and today's productive minutes. Great as a first call to orient.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pet_status",
    description: "Current state of the user's desktop pet companion: name, species, xp, level, coins and food/energy/joy stats.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "activity_summary",
    description: "Per-app usage seconds tracked over the last N days (default 1), including productive/neutral/distraction category totals.",
    inputSchema: {
      type: "object",
      properties: { days: { type: "number", description: "lookback window in days, 1-30 (default 1)" } },
    },
  },
  {
    name: "server_info",
    description: "Static info about this workspace: counts of notes, tasks, open tasks, canvases and pets.",
    inputSchema: { type: "object", properties: {} },
  },
];

/* ------------------------------ tool handlers ------------------------------ */

async function toolListTasks(a: RpcParams) {
  const status = str(a.status, "all");
  const where: { done?: boolean; list?: string } = {};
  if (status === "open") where.done = false;
  else if (status === "done") where.done = true;
  const list = str(a.list);
  if (LISTS.has(list)) where.list = list;
  const rows = await db.task.findMany({
    where,
    orderBy: [{ done: "asc" }, { createdAt: "desc" }],
    take: 200,
  });
  return { ok: true, count: rows.length, tasks: rows.map(taskOut) };
}

async function toolCreateTask(a: RpcParams) {
  const title = str(a.title).trim().slice(0, 200);
  if (!title) throw new Error("title is required");
  const list = LISTS.has(str(a.list)) ? str(a.list) : "today";
  const priority = Math.min(2, Math.max(0, Math.round(num(a.priority) ?? 1)));
  const { due, dueWarning } = persistDue(dueToMs(a.due));
  const row = await db.task.create({
    data: {
      id: crypto.randomUUID(),
      title,
      list,
      priority,
      due,
      tags: JSON.stringify(strArr(a.tags)),
      by: "agent",
    },
  });
  return { ok: true, task: taskOut(row), ...(dueWarning ? { dueWarning } : {}) };
}

async function getTaskOrThrow(id: string) {
  const existing = await db.task.findUnique({ where: { id } });
  if (!existing) throw new Error(`task not found: ${id}`);
  return existing;
}

async function toolCompleteTask(a: RpcParams) {
  const id = str(a.id).trim();
  if (!id) throw new Error("id is required");
  await getTaskOrThrow(id);
  const row = await db.task.update({ where: { id }, data: { done: true, completedAt: new Date() } });
  return { ok: true, task: taskOut(row) };
}

async function toolUpdateTask(a: RpcParams) {
  const id = str(a.id).trim();
  if (!id) throw new Error("id is required");
  await getTaskOrThrow(id);
  const data: { title?: string; list?: string; priority?: number; due?: bigint | null; done?: boolean } = {};
  if (typeof a.title === "string") {
    const t = a.title.trim().slice(0, 200);
    if (!t) throw new Error("title cannot be empty");
    data.title = t;
  }
  if (typeof a.list === "string") {
    if (!LISTS.has(a.list)) throw new Error("list must be one of: today, upcoming, someday");
    data.list = a.list;
  }
  if (num(a.priority) !== undefined) data.priority = Math.min(2, Math.max(0, Math.round(a.priority as number)));
  let dueWarning: string | undefined;
  if (a.due !== undefined) {
    const persisted = persistDue(dueToMs(a.due));
    data.due = persisted.due;
    dueWarning = persisted.dueWarning;
  }
  if (typeof a.done === "boolean") data.done = a.done;
  if (Object.keys(data).length === 0) throw new Error("nothing to update (pass title/list/priority/due/done)");
  const row = await db.task.update({ where: { id }, data });
  return { ok: true, task: taskOut(row), ...(dueWarning ? { dueWarning } : {}) };
}

async function toolDeleteTask(a: RpcParams) {
  const id = str(a.id).trim();
  if (!id) throw new Error("id is required");
  await getTaskOrThrow(id);
  await db.task.delete({ where: { id } });
  return { ok: true, deleted: id };
}

async function toolListNotes(a: RpcParams) {
  const q = str(a.query).trim().toLowerCase();
  const limit = Math.min(50, Math.max(1, Math.round(num(a.limit) ?? 20)));
  const rows = await db.note.findMany({ orderBy: { updatedAt: "desc" } });
  const filtered = q
    ? rows.filter((r) => r.title.toLowerCase().includes(q) || r.content.toLowerCase().includes(q))
    : rows;
  return {
    ok: true,
    query: q || undefined,
    count: filtered.length,
    notes: filtered.slice(0, limit).map((r) => ({
      id: r.id,
      title: r.title,
      tags: parseTags(r.tags),
      updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : String(r.updatedAt),
      snippet: r.content.slice(0, 160),
    })),
  };
}

async function toolReadNote(a: RpcParams) {
  const id = str(a.id).trim();
  if (!id) throw new Error("id is required");
  const n = await db.note.findUnique({ where: { id } });
  if (!n) throw new Error(`note not found: ${id}`);
  return {
    id: n.id,
    title: n.title,
    content: n.content,
    tags: parseTags(n.tags),
    updatedAt: n.updatedAt instanceof Date ? n.updatedAt.toISOString() : String(n.updatedAt),
  };
}

async function toolWriteNote(a: RpcParams) {
  const title = str(a.title).trim().slice(0, 200);
  if (!title) throw new Error("title is required");
  const content = str(a.content);
  const row = await db.note.create({
    data: {
      id: crypto.randomUUID(),
      title,
      content,
      tags: JSON.stringify(strArr(a.tags)),
    },
  });
  return { ok: true, id: row.id, title: row.title };
}

async function toolAppendNote(a: RpcParams) {
  const id = str(a.id).trim();
  if (!id) throw new Error("id is required");
  const content = str(a.content);
  if (!content.trim()) throw new Error("content is required");
  const n = await db.note.findUnique({ where: { id } });
  if (!n) throw new Error(`note not found: ${id}`);
  const merged = n.content.trim() ? `${n.content.replace(/\s+$/, "")}\n\n${content}` : content;
  const row = await db.note.update({ where: { id }, data: { content: merged } });
  return {
    ok: true,
    id: row.id,
    title: row.title,
    content: row.content,
    tags: parseTags(row.tags),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
  };
}

async function toolRenameNote(a: RpcParams) {
  const id = str(a.id).trim();
  if (!id) throw new Error("id is required");
  const title = str(a.title).trim().slice(0, 200);
  if (!title) throw new Error("title is required");
  const n = await db.note.findUnique({ where: { id } });
  if (!n) throw new Error(`note not found: ${id}`);
  const row = await db.note.update({ where: { id }, data: { title } });
  return { ok: true, id: row.id, title: row.title, updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt) };
}

async function toolDeleteNote(a: RpcParams) {
  const id = str(a.id).trim();
  if (!id) throw new Error("id is required");
  const n = await db.note.findUnique({ where: { id } });
  if (!n) throw new Error(`note not found: ${id}`);
  await db.note.delete({ where: { id } });
  return { ok: true, deleted: id, title: n.title };
}

async function toolListTags() {
  const [notes, tasks] = await Promise.all([db.note.findMany({ select: { tags: true } }), db.task.findMany({ select: { tags: true } })]);
  const counts = new Map<string, number>();
  for (const r of [...notes, ...tasks]) for (const t of parseTags(r.tags)) counts.set(t, (counts.get(t) ?? 0) + 1);
  const tags = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count }));
  return { ok: true, count: tags.length, tags };
}

async function toolTodayBrief() {
  const today = dayKey(new Date());
  const [openTasks, recentNotes, pet, usage] = await Promise.all([
    db.task.findMany({ where: { done: false }, orderBy: [{ priority: "desc" }, { createdAt: "desc" }], take: 12 }),
    db.note.findMany({ orderBy: { updatedAt: "desc" }, take: 5, select: { id: true, title: true, updatedAt: true } }),
    db.pet.findFirst(),
    db.appUse.findMany({ where: { day: today } }),
  ]);
  const productiveSecs = usage.filter((u) => u.cat === "productive").reduce((s, u) => s + u.secs, 0);
  const totalSecs = usage.reduce((s, u) => s + u.secs, 0);
  return {
    ok: true,
    date: today,
    openTasks: openTasks.map((t) => ({ id: t.id, title: t.title, list: t.list, priority: t.priority, by: t.by, tags: parseTags(t.tags) })),
    recentNotes: recentNotes.map((n) => ({ id: n.id, title: n.title, updatedAt: n.updatedAt instanceof Date ? n.updatedAt.toISOString() : String(n.updatedAt) })),
    pet: pet ? { name: pet.name, species: pet.species, level: Math.floor(Math.sqrt(pet.xp / 30)) + 1, coins: pet.coins } : null,
    focus: { productiveMinutes: Math.round(productiveSecs / 60), totalTrackedMinutes: Math.round(totalSecs / 60) },
  };
}

async function toolPetStatus() {
  const pet = await db.pet.findFirst();
  if (!pet) throw new Error("no pet found — open the app once so it can hatch");
  return {
    ok: true,
    name: pet.name,
    species: pet.species,
    xp: pet.xp,
    level: Math.floor(Math.sqrt(pet.xp / 30)) + 1,
    coins: pet.coins,
    stats: { food: pet.food, energy: pet.energy, joy: pet.joy },
  };
}

async function toolActivitySummary(a: RpcParams) {
  const days = Math.min(30, Math.max(1, Math.round(num(a.days) ?? 1)));
  const from = dayKey(new Date(Date.now() - (days - 1) * 86_400_000));
  const to = dayKey();
  const rows = await db.appUse.findMany({ where: { day: { gte: from } } });
  const perAppMap = new Map<string, { app: string; cat: string; secs: number }>();
  const categoryTotals: Record<string, number> = { productive: 0, neutral: 0, distraction: 0 };
  for (const r of rows) {
    const hit = perAppMap.get(r.app);
    if (hit) hit.secs += r.secs;
    else perAppMap.set(r.app, { app: r.app, cat: r.cat, secs: r.secs });
    categoryTotals[r.cat] = (categoryTotals[r.cat] ?? 0) + r.secs;
  }
  const perApp = [...perAppMap.values()].sort((x, y) => y.secs - x.secs);
  return {
    ok: true,
    days,
    from,
    to,
    totalSecs: perApp.reduce((s, x) => s + x.secs, 0),
    perApp,
    categoryTotals,
  };
}

async function toolServerInfo() {
  const [notes, tasks, openTasks, canvases, pets] = await Promise.all([
    db.note.count(),
    db.task.count(),
    db.task.count({ where: { done: false } }),
    db.canvas.count(),
    db.pet.count(),
  ]);
  return {
    ok: true,
    server: { name: SERVER_NAME, version: SERVER_VERSION, protocolVersion: PROTOCOL_VERSION },
    workspace: { notes, tasks, openTasks, canvases, pets },
    time: new Date().toISOString(),
  };
}

const TOOL_HANDLERS: Record<string, (a: RpcParams) => Promise<unknown>> = {
  list_tasks: toolListTasks,
  create_task: toolCreateTask,
  complete_task: toolCompleteTask,
  update_task: toolUpdateTask,
  delete_task: toolDeleteTask,
  list_notes: toolListNotes,
  read_note: toolReadNote,
  write_note: toolWriteNote,
  append_note: toolAppendNote,
  rename_note: toolRenameNote,
  delete_note: toolDeleteNote,
  list_tags: () => toolListTags(),
  today_brief: () => toolTodayBrief(),
  pet_status: () => toolPetStatus(),
  activity_summary: toolActivitySummary,
  server_info: () => toolServerInfo(),
};

/** Run one tool; every result is wrapped MCP-style as text content. */
async function callTool(name: string, args: RpcParams): Promise<ToolResult> {
  try {
    const handler = TOOL_HANDLERS[name];
    if (!handler) throw new Error(name ? `Unknown tool: ${name}` : "tool name is required");
    const result = await handler(args);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
  }
}

/* ------------------------- agent activity log (server) -------------------- */

const MCP_LOG_ROW = "mcp-log";
const MCP_LOG_MAX = 40;

type McpLogEntry = { t: number; tool: string; ok: boolean; ms: number; error?: string };

async function appendMcpLog(entry: McpLogEntry) {
  try {
    const row = await db.setting.findUnique({ where: { id: MCP_LOG_ROW } });
    const list: McpLogEntry[] = (() => {
      try {
        const v = JSON.parse(row?.value ?? "[]");
        return Array.isArray(v) ? (v as McpLogEntry[]).slice(0, MCP_LOG_MAX - 1) : [];
      } catch {
        return [];
      }
    })();
    list.unshift(entry);
    const value = JSON.stringify(list);
    if (row) await db.setting.update({ where: { id: MCP_LOG_ROW }, data: { value } });
    else await db.setting.create({ data: { id: MCP_LOG_ROW, value } });
  } catch {
    /* logging must never break the RPC */
  }
}

/* ------------------------------ RPC dispatch ------------------------------ */

type Handled = { status: number; body?: unknown };

async function handleOne(msg: unknown, req: Request): Promise<Handled> {
  if (!msg || typeof msg !== "object" || typeof (msg as RpcParams).method !== "string") {
    const id = msg && typeof msg === "object" && "id" in msg ? ((msg as RpcParams).id as RpcId) : null;
    return { status: 200, body: rpcError(id, -32600, "Invalid Request: expected {jsonrpc, method, ...}") };
  }
  const m = msg as RpcParams;
  const hasId = "id" in m && m.id !== undefined;
  const id = hasId ? (m.id as RpcId) : null;
  const method = m.method as string;
  const params = m.params && typeof m.params === "object" ? (m.params as RpcParams) : {};

  // optional bearer token — exempt the cheap/safe methods
  if (!EXEMPT_METHODS.has(method)) {
    const token = await getMcpToken();
    if (token) {
      const auth = req.headers.get("authorization") ?? "";
      if (auth !== `Bearer ${token}`) {
        return { status: 401, body: rpcError(id, -32001, "Unauthorized: missing or invalid bearer token") };
      }
    }
  }

  // notifications expect no response body → 202 Accepted
  if (!hasId || method === "notifications/initialized" || method.startsWith("notifications/")) {
    return { status: 202, body: undefined };
  }

  try {
    switch (method) {
      case "initialize":
        return {
          status: 200,
          body: ok(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          }),
        };
      case "ping":
        return { status: 200, body: ok(id, {}) };
      case "tools/list":
        return { status: 200, body: ok(id, { tools: TOOL_CATALOG }) };
      case "tools/call": {
        const name = str(params.name).trim();
        const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as RpcParams) : {};
        const t0 = Date.now();
        const result = await callTool(name, args);
        void appendMcpLog({ t: Date.now(), tool: name || "?", ok: !result.isError, ms: Date.now() - t0, ...(result.isError ? { error: result.content[0]?.text.slice(0, 140) } : {}) });
        return { status: 200, body: ok(id, result) };
      }
      default:
        return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
    }
  } catch (e) {
    const msg2 = e instanceof Error ? e.message : String(e);
    return { status: 200, body: rpcError(id, -32603, `Internal error: ${msg2}`) };
  }
}

/* --------------------------------- routes --------------------------------- */

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(rpcError(null, -32700, "Parse error: body must be valid JSON"), 400);
  }
  await ensureReady();

  // batch support: array of requests → array of responses (notifications are skipped)
  if (Array.isArray(body)) {
    const out: unknown[] = [];
    for (const entry of body) {
      const r = await handleOne(entry, req);
      if (r.body !== undefined) out.push(r.body);
    }
    if (out.length === 0) return new Response(null, { status: 202, headers: CORS });
    return json(out, 200);
  }

  const r = await handleOne(body, req);
  if (r.body === undefined) return new Response(null, { status: r.status, headers: CORS });
  return json(r.body, r.status);
}

function infoHtml(): string {
  const rows = TOOL_CATALOG.map((t) => `<tr><td><code>${t.name}</code></td><td>${t.description}</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${SERVER_NAME}</title><style>
body{background:#14121b;color:#e8e2f4;font:14px/1.6 ui-monospace,Menlo,Consolas,monospace;margin:0;padding:40px;max-width:860px;margin-inline:auto}
h1{font-size:22px;letter-spacing:.5px} code{background:#241f33;padding:2px 6px;border-radius:6px;color:#b9a8ff}
table{border-collapse:collapse;width:100%;margin:16px 0}td{border-bottom:1px solid #2b2540;padding:8px 10px;vertical-align:top}
pre{background:#241f33;padding:14px;border-radius:10px;overflow:auto} a{color:#8ab4ff}
.k{color:#7ee2a8}</style></head><body>
<h1>🔌 ${SERVER_NAME} <span style="color:#8f86a8">v${SERVER_VERSION}</span></h1>
<p>Model Context Protocol server for this Nook workspace — tasks, notes, pet &amp; activity, over JSON-RPC 2.0 at <code>/api/mcp</code> (protocol <code>${PROTOCOL_VERSION}</code>).</p>
<pre><span class="k">curl</span> -s -X POST localhost:3000/api/mcp -H <span style="color:#ffb86c">'content-type: application/json'</span> \\
  -d <span style="color:#ffb86c">'{"jsonrpc":"2.0","id":1,"method":"tools/list"}'</span></pre>
<p>Methods: <code>initialize</code> · <code>notifications/initialized</code> · <code>ping</code> · <code>tools/list</code> · <code>tools/call</code> — batch requests (arrays) supported.
If a bearer token is configured, <code>tools/call</code> needs <code>Authorization: Bearer &lt;token&gt;</code>.</p>
<table><tr><th>tool</th><th>description</th></tr>${rows}</table>
<p style="color:#8f86a8">GET with <code>Accept: application/json</code> returns machine-readable info.</p>
</body></html>`;
}

export async function GET(req: Request) {
  await ensureReady();
  const accept = req.headers.get("accept") ?? "";
  if (accept.includes("text/html")) {
    return new Response(infoHtml(), { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...CORS } });
  }
  return json({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    endpoint: "/api/mcp",
    transport: "JSON-RPC 2.0 over HTTP POST (streamable-MCP style)",
    methods: ["initialize", "notifications/initialized", "ping", "tools/list", "tools/call"],
    batch: true,
    auth: "optional bearer token — Setting 'mcp-token' → {\"token\":\"...\"}",
    tools: TOOL_CATALOG.map((t) => t.name),
  });
}
