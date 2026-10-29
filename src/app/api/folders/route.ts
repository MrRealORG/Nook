import { db } from "@/db";
import { ensureReady } from "@/db/ensure";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureReady();
  const rows = await db.folder.findMany({ orderBy: { position: "asc" } });
  return Response.json(rows);
}

export async function POST(req: Request) {
  await ensureReady();
  const b = (await req.json()) as { id?: string; name?: string; icon?: string; color?: string; position?: number };
  const id = b.id && /^[\w-]{3,40}$/.test(b.id) ? b.id : crypto.randomUUID();
  try {
    await db.folder.create({
      data: {
        id,
        name: (b.name ?? "New folder").slice(0, 80),
        icon: (b.icon ?? "folder").slice(0, 32),
        color: (b.color ?? "").slice(0, 16),
        position: typeof b.position === "number" ? Math.round(b.position) : 0,
      },
    });
  } catch {}
  return Response.json({ id });
}
