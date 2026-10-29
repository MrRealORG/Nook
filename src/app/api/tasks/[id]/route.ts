import { db } from "@/db";
import { ensureReady } from "@/db/ensure";
import { serializeTask } from "../route";

export const dynamic = "force-dynamic";

const LISTS = new Set(["today", "upcoming", "someday"]);

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureReady();
  const { id } = await params;
  const b = (await req.json()) as { title?: string; list?: string; priority?: number; due?: number | null; done?: boolean; noteId?: string | null; tags?: string[] };
  const row = await db.task.findUnique({ where: { id } });
  if (!row) return Response.json({ error: "not found" }, { status: 404 });
  const done = typeof b.done === "boolean" ? b.done : row.done;
  const updated = await db.task.update({
    where: { id },
    data: {
      title: typeof b.title === "string" && b.title.trim() ? b.title.trim().slice(0, 200) : row.title,
      list: b.list && LISTS.has(b.list) ? b.list : row.list,
      priority: typeof b.priority === "number" ? Math.min(2, Math.max(0, Math.round(b.priority))) : row.priority,
      due: b.due === null ? null : typeof b.due === "number" && Number.isFinite(b.due) ? BigInt(Math.round(b.due)) : row.due,
      done,
      noteId: b.noteId === null ? null : typeof b.noteId === "string" ? b.noteId : row.noteId,
      tags: Array.isArray(b.tags) ? JSON.stringify(b.tags.filter((t) => typeof t === "string").map((t) => t.slice(0, 24)).slice(0, 12)) : row.tags,
      completedAt: done && !row.done ? new Date() : !done ? null : row.completedAt,
    },
  });
  return Response.json(serializeTask(updated));
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureReady();
  const { id } = await params;
  await db.task.deleteMany({ where: { id } });
  return Response.json({ ok: true });
}
