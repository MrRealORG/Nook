/**
 * MCP bearer-token helpers (client side). The original imported the Prisma-backed server
 * module straight into the Settings page; here the token lives in the Rust vault and the UI
 * only learns whether one is set — it is never read back.
 */
export async function getMcpToken(): Promise<string | null> {
  try {
    const r = await fetch("/api/mcp-token");
    const j = (await r.json()) as { set?: boolean };
    return j.set ? "••••••••" : null;
  } catch {
    return null;
  }
}

export async function setMcpToken(token: string | null): Promise<void> {
  await fetch("/api/mcp-token", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: token ?? "" }) });
}
