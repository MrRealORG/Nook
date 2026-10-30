/**
 * Tiny socket.io-compatible client for the Team room (replaces socket.io-client, ~45 KB).
 * Speaks `{event, data}` JSON frames to the WebSocket room built into the Nook app's local
 * server (`ws://127.0.0.1:<port>/team`), reconnects automatically, and exposes the same
 * `on / off / emit / disconnect / id` surface TeamView was written against.
 */
import { DEV_API, isTauri } from "@/lib/platform";

type Handler = (data: any) => void;

export const TEAM_URL_KEY = "nook:team-url";

/** Default room address: this machine's Nook server (or a teammate's, set in Settings → Desktop). */
export function teamUrl(port?: number): string {
  try {
    const saved = localStorage.getItem(TEAM_URL_KEY);
    if (saved && /^wss?:\/\//.test(saved)) return saved;
  } catch {
    /* storage unavailable */
  }
  if (!isTauri) return `${DEV_API.replace(/^http/, "ws")}/team`;
  return `ws://127.0.0.1:${port ?? 3000}/team`;
}

export class TeamSocket {
  id: string | null = null;
  connected = false;
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private closed = false;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private url: string, private opts: { reconnectionDelay?: number } = {}) {
    this.open();
  }

  private open() {
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.fire("connect_error", new Error("bad room url"));
      return this.schedule();
    }
    this.ws = ws;
    ws.onmessage = (e) => {
      let msg: { event?: string; data?: unknown };
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (msg.event === "connected") {
        this.id = (msg.data as { id?: string })?.id ?? null;
        this.connected = true;
        this.retry = 0;
        this.fire("connect", undefined);
        return;
      }
      if (msg.event) this.fire(msg.event, msg.data);
    };
    ws.onerror = () => this.fire("connect_error", new Error("connection failed"));
    ws.onclose = () => {
      const was = this.connected;
      this.connected = false;
      this.ws = null;
      if (was) this.fire("disconnect", "transport close");
      this.schedule();
    };
  }

  private schedule() {
    if (this.closed) return;
    const base = this.opts.reconnectionDelay ?? 1200;
    const delay = Math.min(15_000, base * 2 ** Math.min(this.retry++, 4));
    this.timer = setTimeout(() => this.open(), delay);
  }

  private fire(event: string, data: unknown) {
    for (const h of this.handlers.get(event) ?? []) {
      try {
        h(data);
      } catch (err) {
        console.error(`[team] handler for ${event} failed`, err);
      }
    }
  }

  on(event: string, h: Handler): this {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(h);
    return this;
  }

  off(event: string, h?: Handler): this {
    if (!h) this.handlers.delete(event);
    else this.handlers.get(event)?.delete(h);
    return this;
  }

  emit(event: string, data?: unknown): this {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ event, data: data ?? null }));
    return this;
  }

  disconnect(): this {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
    this.connected = false;
    return this;
  }
}
