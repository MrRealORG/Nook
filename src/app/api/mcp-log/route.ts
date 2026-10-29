/**
 * MCP agent activity log — GET returns the recent tools/call entries recorded by
 * /api/mcp (newest first), DELETE clears the log.
 *
 * The log lives in the Setting key/value store under id "mcp-log" as JSON:
 *   [{ t, tool, ok, ms, error? }, ...]   (max 40 entries)
 */

import { db } from "@/lib/db";
import { ensureReady } from "@/db/ensure";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type McpLogEntry = { t: number; tool: string; ok: boolean; ms: number; error?: string };

async function readLog(): Promise<McpLogEntry[]> {
  try {
    const row = await db.setting.findUnique({ where: { id: "mcp-log" } });
    const v = JSON.parse(row?.value ?? "[]");
    return Array.isArray(v) ? (v as McpLogEntry[]) : [];
  } catch {
    return [];
  }
}

export async function GET() {
  await ensureReady();
  const log = await readLog();
  const calls = log.length;
  const failed = log.filter((e) => !e.ok).length;
  const avgMs = calls ? Math.round(log.reduce((s, e) => s + (e.ms || 0), 0) / calls) : 0;
  const last = log[0]?.t ?? null;
  return Response.json(
    { ok: true, count: calls, failed, avgMs, last, entries: log },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function DELETE() {
  await ensureReady();
  try {
    await db.setting.delete({ where: { id: "mcp-log" } });
  } catch {
    /* no row — already clear */
  }
  return Response.json({ ok: true, cleared: true }, { headers: { "cache-control": "no-store" } });
}
