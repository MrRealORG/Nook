import { db } from "@/db";
import { ensureReady } from "@/db/ensure";
import { parseTodoItems, type ShareMode, type ShareRecord } from "@/lib/shareKit";

export const dynamic = "force-dynamic";

/**
 * Note sharing, stored in the Setting key/value store as rows "share:<id>"
 * (same JSON-blob pattern as /api/packs "pack:<id>"). Soft-revoke keeps the
 * row for audit; revoked records never leak content back to readers.
 */

const MAX_JSON = 400_000; // 400KB per share blob

type Stored = Partial<ShareRecord> & { id?: string };

function parseRow(value: string): Stored | null {
  try {
    const p = JSON.parse(value) as Stored;
    return p && typeof p.id === "string" ? p : null;
  } catch {
    return null;
  }
}

async function loadShare(shareId: string): Promise<Stored | null> {
  const row = await db.setting.findUnique({ where: { id: `share:${shareId}` } });
  return row ? parseRow(row.value) : null;
}

async function allShares(): Promise<Stored[]> {
  const rows = await db.setting.findMany({ where: { id: { startsWith: "share:" } } });
  return rows.map((r) => parseRow(r.value)).filter((s): s is Stored => !!s);
}

async function saveShare(record: ShareRecord) {
  const value = JSON.stringify(record);
  if (value.length > MAX_JSON) throw new Error("too-large");
  await db.setting.upsert({
    where: { id: `share:${record.id}` },
    update: { value, updatedAt: new Date() },
    create: { id: `share:${record.id}`, value },
  });
}

/** public stub for revoked shares — enough for the reader UI, no content leak */
function revokedStub(s: Stored) {
  return { id: s.id, noteId: s.noteId, noteTitle: s.noteTitle ?? "Note", mode: s.mode, createdAt: s.createdAt, views: s.views ?? 0, revoked: true, items: [], content: "", updatedAt: s.updatedAt ?? s.createdAt ?? 0, folderColor: null };
}

export async function GET(req: Request) {
  await ensureReady();
  const url = new URL(req.url);
  const shareId = url.searchParams.get("shareId");

  // single share — public read (no auth in this local app)
  if (shareId) {
    if (!/^[\w-]{6,64}$/.test(shareId)) return Response.json({ error: "bad shareId" }, { status: 400 });
    const s = await loadShare(shareId);
    if (!s) return Response.json({ error: "Share not found" }, { status: 404 });
    if (s.revoked) return Response.json(revokedStub(s));
    let record = s as ShareRecord;
    // bump the view counter only when explicitly asked (readers do this once, never on polls)
    if (url.searchParams.get("countView") === "1") {
      record = { ...record, views: (record.views ?? 0) + 1 };
      await saveShare(record);
    }
    return Response.json(record);
  }

  // list all shares, newest first; optional ?noteId= filter
  const noteId = url.searchParams.get("noteId");
  const shares = await allShares();
  const list = shares
    .filter((s) => typeof s.createdAt === "number" && (!noteId || s.noteId === noteId))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return Response.json(list);
}

export async function POST(req: Request) {
  await ensureReady();
  const b = (await req.json().catch(() => ({}))) as { noteId?: string; mode?: string };
  const noteId = typeof b.noteId === "string" ? b.noteId : "";
  const mode = b.mode === "collab" || b.mode === "read" ? (b.mode as ShareMode) : null;
  if (!noteId) return Response.json({ error: "noteId required" }, { status: 400 });
  if (!mode) return Response.json({ error: "mode must be 'read' or 'collab'" }, { status: 400 });

  const note = await db.note.findUnique({ where: { id: noteId }, include: { folder: true } });
  if (!note) return Response.json({ error: "Note not found" }, { status: 404 });

  // idempotent: an existing active share for the same note+mode is returned
  // (its snapshot of title/content is refreshed, worker progress is kept)
  const existing = (await allShares()).find((s) => s.noteId === noteId && s.mode === mode && !s.revoked);
  if (existing) {
    const items = Array.isArray(existing.items) ? existing.items : [];
    const refreshed = {
      ...existing,
      noteTitle: note.title,
      content: note.content,
      folderColor: note.folder?.color ?? null,
      cover: note.cover,
      updatedAt: Date.now(),
      items,
    } as ShareRecord;
    const value = JSON.stringify(refreshed);
    if (value.length > MAX_JSON) return Response.json({ error: "Note too large to share (400KB cap)" }, { status: 413 });
    await db.setting.upsert({
      where: { id: `share:${existing.id}` },
      update: { value, updatedAt: new Date() },
      create: { id: `share:${existing.id}`, value },
    });
    return Response.json(refreshed);
  }

  const record: ShareRecord = {
    id: crypto.randomUUID(),
    noteId,
    noteTitle: note.title,
    mode,
    createdAt: Date.now(),
    items: parseTodoItems(note.content),
    views: 0,
    content: note.content,
    updatedAt: Date.now(),
    folderColor: note.folder?.color ?? null,
    cover: note.cover,
  };
  try {
    await saveShare(record);
  } catch {
    return Response.json({ error: "Note too large to share (400KB cap)" }, { status: 413 });
  }
  return Response.json(record);
}

export async function PATCH(req: Request) {
  await ensureReady();
  const b = (await req.json().catch(() => ({}))) as { shareId?: string; index?: number; done?: boolean; by?: string };
  const idx = typeof b.index === "number" && Number.isInteger(b.index) ? b.index : NaN;
  if (!b.shareId || Number.isNaN(idx)) return Response.json({ error: "shareId and index required" }, { status: 400 });
  const s = await loadShare(b.shareId);
  if (!s) return Response.json({ error: "Share not found" }, { status: 404 });
  if (s.revoked) return Response.json({ error: "This share link was revoked" }, { status: 410 });
  if (s.mode !== "collab") return Response.json({ error: "Read-only share — the owner did not allow editing" }, { status: 403 });
  const items = Array.isArray(s.items) ? s.items : [];
  if (idx < 0 || idx >= items.length) return Response.json({ error: "Item index out of range" }, { status: 400 });

  const done = !!b.done;
  const by = typeof b.by === "string" && b.by.trim() ? b.by.trim().slice(0, 40) : "Worker";
  items[idx] = { ...items[idx], done, doneBy: done ? by : null, doneAt: done ? Date.now() : null };
  const record = { ...(s as ShareRecord), items, updatedAt: Date.now() };
  await saveShare(record);
  return Response.json(record);
}

export async function DELETE(req: Request) {
  await ensureReady();
  const shareId = new URL(req.url).searchParams.get("shareId");
  if (!shareId) return Response.json({ error: "shareId required" }, { status: 400 });
  const s = await loadShare(shareId);
  if (!s) return Response.json({ error: "Share not found" }, { status: 404 });
  // soft revoke — keep the row for audit, flip the flag
  const record = { ...(s as ShareRecord), revoked: true, updatedAt: Date.now() };
  await saveShare(record);
  return Response.json(record);
}
