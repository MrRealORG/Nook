import { db } from "@/lib/db";

/**
 * MCP bearer-token helpers.
 *
 * The token lives in the Setting key/value store under id "mcp-token",
 * stored as JSON: {"token":"..."}. When no row exists the MCP endpoint is
 * open to local callers (local-first app). Set a token to lock down
 * tools/call for external agents.
 */

const KEY = "mcp-token";

/** Read the MCP bearer token, or null when not set / malformed. */
export async function getMcpToken(): Promise<string | null> {
  try {
    const row = await db.setting.findUnique({ where: { id: KEY } });
    if (!row) return null;
    const raw = (row.value ?? "").trim();
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { token?: unknown };
      if (typeof parsed?.token === "string" && parsed.token.trim()) return parsed.token.trim();
      return null;
    } catch {
      // graceful fallback: the raw value itself is the token
      return raw;
    }
  } catch {
    return null;
  }
}

/** Set (upsert) the MCP bearer token, or delete the row when token is null/empty. */
export async function setMcpToken(token: string | null): Promise<void> {
  const t = typeof token === "string" ? token.trim() : "";
  if (!t) {
    try {
      await db.setting.delete({ where: { id: KEY } });
    } catch {
      /* row already gone — fine */
    }
    return;
  }
  await db.setting.upsert({
    where: { id: KEY },
    create: { id: KEY, value: JSON.stringify({ token: t }) },
    update: { value: JSON.stringify({ token: t }) },
  });
}
