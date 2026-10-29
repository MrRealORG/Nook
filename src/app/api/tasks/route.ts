import { db } from "@/db";
import { ensureReady } from "@/db/ensure";

export const dynamic = "force-dynamic";

export type TaskRow = {
  id: string;
  title: string;
  list: string;
  priority: number;
  due: number | null;
  done: boolean;
  noteId: string | null;
  tags: string[];
  by: string;
  createdAt: number;
  completedAt: number | null;
};

export function parseTags(raw: string | null | undefined): string[] {
  try {
    const arr = JSON.parse(raw ?? "[]");
    return Array.isArray(arr) ? arr.filter((t) => typeof t === "string").slice(0, 12) : [];
  } catch {
    return [];
  }
}

export function serializeTask(t: {
  id: string; title: string; list: string; priority: number; due: bigint | number | null; done: boolean; noteId: string | null; tags?: string | null; by: string; createdAt: Date; completedAt: Date | null;
}): TaskRow {
  const due = t.due == null ? null : typeof t.due === "bigint" ? Number(t.due) : t.due;
  return {
    id: t.id, title: t.title, list: t.list, priority: t.priority, due, done: t.done,
    noteId: t.noteId, tags: parseTags(t.tags), by: t.by, createdAt: t.createdAt.getTime(),
    completedAt: t.completedAt ? t.completedAt.getTime() : null,
  };
}

const LISTS = new Set(["today", "upcoming", "someday"]);

export async function GET() {
  await ensureReady();
  const rows = await db.task.findMany({ orderBy: [{ done: "asc" }, { createdAt: "desc" }] });
  return Response.json(rows.map(serializeTask));
}

export async function POST(req: Request) {
  await ensureReady();
  const b = (await req.json()) as { id?: string; title?: string; list?: string; priority?: number; due?: number | null; noteId?: string | null; tags?: string[]; by?: string };
  const id = b.id && /^[\w-]{3,40}$/.test(b.id) ? b.id : crypto.randomUUID();
  const title = (b.title ?? "").trim().slice(0, 200);
  if (!title) return Response.json({ error: "title required" }, { status: 400 });
  const row = await db.task.create({
    data: {
      id,
      title,
      list: b.list && LISTS.has(b.list) ? b.list : "today",
      priority: typeof b.priority === "number" ? Math.min(2, Math.max(0, Math.round(b.priority))) : 1,
      due: typeof b.due === "number" && Number.isFinite(b.due) ? BigInt(Math.round(b.due)) : null,
      noteId: typeof b.noteId === "string" ? b.noteId : null,
      tags: JSON.stringify(Array.isArray(b.tags) ? b.tags.filter((t) => typeof t === "string").map((t) => t.slice(0, 24)).slice(0, 12) : []),
      by: b.by === "ai" ? "ai" : b.by === "agent" ? "agent" : "you",
    },
  });
  return Response.json(serializeTask(row));
}
