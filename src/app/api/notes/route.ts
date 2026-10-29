import { db } from "@/db";
import { ensureReady } from "@/db/ensure";
import { serializeNote } from "@/db/serialize";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureReady();
  const rows = await db.note.findMany({ orderBy: { updatedAt: "desc" } });
  return Response.json(rows.map(serializeNote));
}

export async function POST(req: Request) {
  await ensureReady();
  const b = (await req.json()) as { id?: string; title?: string; content?: string; cover?: string | null; folderId?: string | null; tags?: string[]; createdAt?: number };
  const id = b.id && /^[\w-]{3,40}$/.test(b.id) ? b.id : crypto.randomUUID();
  try {
    const row = await db.note.create({
      data: {
        id,
        title: (b.title ?? "Untitled").slice(0, 200),
        content: (b.content ?? "").slice(0, 400_000),
        cover: b.cover ?? null,
        folderId: typeof b.folderId === "string" ? b.folderId : null,
        tags: JSON.stringify(Array.isArray(b.tags) ? b.tags.filter((t) => typeof t === "string").map((t) => t.slice(0, 24)).slice(0, 12) : []),
      },
    });
    return Response.json(serializeNote(row));
  } catch {
    return Response.json({ id });
  }
}
