import { db } from "@/db";
import { ensureReady } from "@/db/ensure";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  await ensureReady();
  const b = (await req.json()) as { id?: string; name?: string; data?: unknown };
  const id = b.id && /^[\w-]{3,40}$/.test(b.id) ? b.id : crypto.randomUUID();
  try {
    await db.canvas.create({
      data: {
        id,
        name: (b.name ?? "Untitled board").slice(0, 120),
        data: JSON.stringify(b.data ?? { nodes: [], edges: [], view: { x: 0, y: 0, z: 1 } }),
      },
    });
  } catch {}
  return Response.json({ id });
}
