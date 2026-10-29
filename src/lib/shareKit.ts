/**
 * shareKit — plain helpers for Nook note sharing. NO store imports, NO React:
 * safe to use from client components AND server route handlers (the route
 * imports `parseTodoItems` so the share parser and the reader never drift).
 *
 * Shares live in the Setting key/value store as rows "share:<id>" (same
 * pattern as "pack:<id>" in /api/packs), JSON-blob per share.
 */

export type ShareMode = "read" | "collab";

export type ShareItem = {
  text: string;
  done: boolean;
  doneBy: string | null;
  doneAt: number | null;
};

export type ShareRecord = {
  id: string;
  noteId: string;
  noteTitle: string;
  mode: ShareMode;
  createdAt: number;
  items: ShareItem[];
  views: number;
  revoked?: boolean;
  /** full markdown snapshot of the note at share time (refreshed on idempotent re-create) */
  content: string;
  updatedAt: number;
  folderColor: string | null;
  cover?: string | null;
};

/** matches `- [ ]` / `- [x]` / `* [X]` / `+ [ ]` todo lines (same set the Markdown renderer ticks) */
export const TODO_RE = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/;

/** texts of every markdown todo line, trimmed — used for quick counts/previews */
export function parseTodos(content: string): string[] {
  const out: string[] = [];
  for (const line of content.split("\n")) {
    const m = TODO_RE.exec(line);
    if (m) out.push(m[2].trim());
  }
  return out;
}

/** full ShareItem list (keeps the `[x]` done state) — the API route uses this */
export function parseTodoItems(content: string): ShareItem[] {
  const items: ShareItem[] = [];
  for (const line of content.split("\n")) {
    const m = TODO_RE.exec(line);
    if (m) {
      items.push({
        text: m[2].trim().slice(0, 500),
        done: m[1] !== " ",
        doneBy: m[1] !== " " ? "Note" : null,
        doneAt: null,
      });
    }
    if (items.length >= 200) break;
  }
  return items;
}

/* ---------------------------------- api ---------------------------------- */

async function jfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(j.error || `Request failed (${res.status})`);
  return j;
}

/** every share, newest first; optional filter for one note */
export async function fetchShares(noteId?: string): Promise<ShareRecord[]> {
  return jfetch<ShareRecord[]>(`/api/share${noteId ? `?noteId=${encodeURIComponent(noteId)}` : ""}`);
}

/** one share (public read). `countView` bumps the view counter ONCE — polls must not pass it. */
export async function getShare(shareId: string, countView = false): Promise<ShareRecord> {
  return jfetch<ShareRecord>(`/api/share?shareId=${encodeURIComponent(shareId)}${countView ? "&countView=1" : ""}`);
}

/**
 * Create (or idempotently fetch) the share for a note+mode.
 * The server parses the note's markdown TODO checkboxes into items.
 */
export async function createShare(noteId: string, mode: ShareMode): Promise<ShareRecord> {
  return jfetch<ShareRecord>("/api/share", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ noteId, mode }),
  });
}

/** flip one todo item (collab shares only). `by` defaults to "Worker". */
export async function toggleItem(shareId: string, index: number, done: boolean, by = "Worker"): Promise<ShareRecord> {
  return jfetch<ShareRecord>("/api/share", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ shareId, index, done, by }),
  });
}

/** soft-revoke: the row is kept for audit but the link stops working */
export async function revokeShare(shareId: string): Promise<ShareRecord> {
  return jfetch<ShareRecord>(`/api/share?shareId=${encodeURIComponent(shareId)}`, { method: "DELETE" });
}

/* --------------------------------- links --------------------------------- */

export function shareUrl(id: string): string {
  if (typeof location === "undefined") return `/?share=${id}`;
  return `${location.origin}/?share=${id}`;
}

/**
 * Copy a share link to the clipboard, with graceful fallbacks.
 * Why the fallback: sandboxed iframes / non-secure contexts (and some
 * webviews) block clipboard.writeText — and clipboard.readText outright —
 * so we degrade to a legacy execCommand copy and finally to prompt(),
 * which always works and still lets the user copy by hand.
 */
export async function copyShareLink(record: ShareRecord, notify?: (text: string, icon?: string) => void): Promise<boolean> {
  const url = shareUrl(record.id);
  const say = (text: string, icon = "copy") => notify?.(text, icon);
  try {
    await navigator.clipboard.writeText(url);
    say("Share link copied — send it to anyone", "copy");
    return true;
  } catch {
    // try the hidden-textarea + execCommand trick before giving up
    try {
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      if (ok) {
        say("Share link copied — send it to anyone", "copy");
        return true;
      }
      throw new Error("execCommand refused");
    } catch {
      // last resort: prompt() — sandbox-proof, user can still Ctrl+C the value
      prompt("Copy this share link:", url);
      say("Copy the link from the prompt", "link");
      return false;
    }
  }
}
