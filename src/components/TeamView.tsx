
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TeamSocket, teamUrl } from "@/lib/teamSocket";
import { useDesktopInfo } from "@/lib/desktop";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/icons";
import { Leaderboard } from "@/components/Leaderboard";
import { PetView } from "@/components/PetView";
import { sfx } from "@/lib/sfx";
import { useStore } from "@/lib/store";
import { THEMES } from "@/lib/themes";
import type { Listing } from "@/lib/types";
import type { Species } from "@/lib/types";
import { timeAgo } from "@/lib/util";

// ---------- wire types (mirrors mini-services/collab-service) ----------
type Pt = { x: number; y: number };
type Member = { id: string; name: string; species: string; joinedAt: number; bot?: boolean };
type ChatMsg = { id: string; from: string; text: string; at: number; species?: string; bot?: boolean; sys?: boolean; clientId?: string };
type Stroke = { id: string; points: Pt[]; color: string; size: number };
type Leaderboard = Record<string, { name: string; score: number; at: number }[]>;
type Status = "connecting" | "live" | "off";

const SPECIES_TAG: Record<string, string> = {
  cat: "🐱", bunny: "🐰", blob: "🫧", dog: "🐶", fox: "🦊", panda: "🐼",
  frog: "🐸", penguin: "🐧", ghost: "👻", dragon: "🐲", axolotl: "🦎", owl: "🦉",
};
const tagOf = (species?: string) => SPECIES_TAG[species ?? ""] ?? "✦";

function stableClientId(): string {
  try {
    const key = "nook:cid";
    let id = sessionStorage.getItem(key);
    if (!id) {
      id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem(key, id);
    }
    return id;
  } catch {
    return Math.random().toString(36).slice(2);
  }
}

function localUid(): string {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}

const timeOf = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const KIND_ICON: Record<string, IconName> = { hat: "shirt", pet: "dog", food: "fish", theme: "sparkle", decor: "home" };

/** Live feed from the team bazaar — sourced from the store listings the global watcher keeps fresh. */
function MarketBulletin() {
  const listings = useStore((s) => s.listings);
  const feed = useMemo(() => [...listings].sort((a, b) => b.createdAt - a.createdAt).slice(0, 4), [listings]);
  if (!feed.length) return null;
  return (
    <section className="panel p-3" aria-label="Bazaar bulletin">
      <div className="label mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5">
          <Icon name="coins" size={11} /> bazaar bulletin
        </span>
        <span className="presence-dot" />
      </div>
      <div className="flex flex-col gap-1.5">
        {feed.map((l) => (
          <BulletinRow key={l.id} l={l} />
        ))}
      </div>
      <button className="btn btn-sm mt-2 w-full justify-center" onClick={() => useStore.getState().setView("market")}>
        <Icon name="coins" size={12} /> visit the bazaar
      </button>
    </section>
  );
}

function BulletinRow({ l }: { l: Listing }) {
  const fresh = Date.now() - l.createdAt < 15 * 60_000 && !l.sold;
  return (
    <button
      className="bulletin-row"
      onClick={() => useStore.getState().setView("market")}
      title={`${l.name} · ${l.price} coins · seller ${l.seller}${l.sold ? " · sold" : ""}`}
    >
      <span className="game-icon !h-7 !w-7 flex-none">
        <Icon name={KIND_ICON[l.kind] ?? "gift"} size={13} />
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="pixel-font block truncate text-[12.5px] leading-tight">{l.name}</span>
        <span className="label">{l.seller} · {timeAgo(l.createdAt)}</span>
      </span>
      {l.sold ? (
        <span className="chip opacity-70"><Icon name="check" size={10} /> sold</span>
      ) : (
        <span className="price-tag !text-[11px]"><Icon name="coins" size={10} /> {l.price}</span>
      )}
      {fresh && <span className="rare-chip !text-[8px]">new</span>}
    </button>
  );
}

// ====================================================================
export function TeamView() {
  const pet = useStore((s) => s.pet);
  const theme = useStore((s) => s.theme);
  const accent = THEMES[theme].accent;

  // identity — stable client id for the lifetime of this tab
  const [cid] = useState(stableClientId);

  // connection
  const [status, setStatus] = useState<Status>("connecting");
  const [mySid, setMySid] = useState<string | null>(null);
  const socketRef = useRef<TeamSocket | null>(null);
  const roomPort = useDesktopInfo((d) => d.mcpPort);

  // room state
  const [members, setMembers] = useState<Member[]>([]);
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [board, setBoard] = useState<Leaderboard>({});
  const [typers, setTypers] = useState<Record<string, string>>({});
  const typerTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // chat input
  const [draft, setDraft] = useState("");
  const typingSentUntil = useRef(0);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // whiteboard
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const currentRef = useRef<Stroke | null>(null);
  const sentCountRef = useRef(0);
  const drawingRef = useRef(false);

  const chatScrollRef = useRef<HTMLDivElement>(null);

  // ---------- canvas helpers ----------
  const ctx2d = () => canvasRef.current?.getContext("2d") ?? null;

  const drawSegment = useCallback((stroke: Stroke, fromIdx: number) => {
    const ctx = ctx2d();
    if (!ctx) return;
    const pts = stroke.points;
    if (fromIdx >= pts.length) return;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineWidth = stroke.size;
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, Math.max(1, stroke.size / 2), 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    const start = Math.max(0, fromIdx - 1);
    ctx.beginPath();
    ctx.moveTo(pts[start].x, pts[start].y);
    for (let i = start + 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }, []);

  const redrawAll = useCallback(() => {
    const ctx = ctx2d();
    if (!ctx) return;
    ctx.clearRect(0, 0, canvasRef.current?.width ?? 460, canvasRef.current?.height ?? 300);
    for (const s of strokesRef.current) drawSegment(s, 0);
  }, [drawSegment]);

  const clearBoardLocal = useCallback(() => {
    strokesRef.current = [];
    currentRef.current = null;
    drawingRef.current = false;
    redrawAll();
  }, [redrawAll]);

  // ---------- socket lifecycle ----------
  useEffect(() => {
    // the room lives in the Nook app's local server (or a teammate's — Settings → Desktop)
    const socket = new TeamSocket(teamUrl(roomPort), { reconnectionDelay: 1200 });
    socketRef.current = socket;

    const onConnect = () => {
      setMySid(socket.id ?? null);
      setStatus("live");
      const p = useStore.getState().pet;
      socket.emit("join", { name: p.name, species: p.species, clientId: cid });
    };
    const onDisconnect = () => setStatus("off");
    const onConnectError = () => setStatus("off");

    const onPresence = (list: Member[]) => {
      setMembers(list);
      // drop typing state for members who left
      const ids = new Set(list.map((m) => m.id));
      setTypers((prev) => {
        const next: Record<string, string> = {};
        for (const [id, name] of Object.entries(prev)) if (ids.has(id)) next[id] = name;
        return next;
      });
    };
    const onChatHistory = (history: ChatMsg[]) => setMsgs(history.slice(-80));
    const onChat = (m: ChatMsg) => {
      setMsgs((prev) => [...prev.slice(-79), m]);
      if (!m.sys && m.clientId !== cid) sfx("receive");
    };
    const onLeaderboard = (lb: Leaderboard) => setBoard(lb);

    const onTyping = (d: { id: string; name: string; typing: boolean }) => {
      const old = typerTimers.current.get(d.id);
      if (old) clearTimeout(old);
      setTypers((prev) => {
        const next = { ...prev };
        if (d.typing) next[d.id] = d.name;
        else delete next[d.id];
        return next;
      });
      if (d.typing) {
        typerTimers.current.set(
          d.id,
          setTimeout(() => {
            setTypers((prev) => {
              const next = { ...prev };
              delete next[d.id];
              return next;
            });
            typerTimers.current.delete(d.id);
          }, 5000),
        );
      }
    };

    // whiteboard sync
    const onBoardSync = (remote: Stroke[]) => {
      strokesRef.current = Array.isArray(remote) ? remote.slice(-200) : [];
      if (currentRef.current) strokesRef.current.push(currentRef.current);
      redrawAll();
    };
    const onStrokeStart = (s: Stroke) => {
      if (!s || !Array.isArray(s.points)) return;
      const stroke: Stroke = { id: s.id, points: s.points, color: s.color, size: s.size };
      strokesRef.current.push(stroke);
      if (strokesRef.current.length > 200) strokesRef.current.shift();
      drawSegment(stroke, 0);
    };
    const appendPoints = (id: string, points: Pt[]) => {
      const stroke = strokesRef.current.find((s) => s.id === id);
      if (!stroke || !Array.isArray(points) || !points.length) return;
      const from = stroke.points.length;
      stroke.points.push(...points);
      drawSegment(stroke, from);
    };
    const onStrokeProgress = (d: { id: string; points: Pt[] }) => appendPoints(d.id, d.points);
    const onStrokeEnd = (d: { id: string; points: Pt[] }) => appendPoints(d.id, d.points ?? []);
    const onBoardClear = () => clearBoardLocal();

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);
    socket.on("presence", onPresence);
    socket.on("chat:history", onChatHistory);
    socket.on("chat", onChat);
    socket.on("leaderboard", onLeaderboard);
    socket.on("typing", onTyping);
    socket.on("board:sync", onBoardSync);
    socket.on("stroke:start", onStrokeStart);
    socket.on("stroke:progress", onStrokeProgress);
    socket.on("stroke:end", onStrokeEnd);
    socket.on("board:clear", onBoardClear);

    return () => {
      socket.disconnect();
      socketRef.current = null;
      for (const t of typerTimers.current.values()) clearTimeout(t);
      typerTimers.current.clear();
      if (typingTimer.current) clearTimeout(typingTimer.current);
    };
  }, [cid, clearBoardLocal, drawSegment, redrawAll, roomPort]);

  // ---------- chat actions ----------
  const stopTyping = useCallback(() => {
    typingSentUntil.current = 0;
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = null;
    socketRef.current?.emit("typing", { typing: false });
  }, []);

  const sendChat = useCallback(() => {
    const text = draft.trim();
    const socket = socketRef.current;
    if (!text || !socket) return;
    socket.emit("chat", { text, clientId: cid });
    sfx("send");
    setDraft("");
    stopTyping();
  }, [cid, draft, stopTyping]);

  const onDraftChange = (v: string) => {
    setDraft(v);
    const socket = socketRef.current;
    if (!socket || !v.trim()) return;
    if (Date.now() > typingSentUntil.current) socket.emit("typing", { typing: true });
    typingSentUntil.current = Date.now() + 1400;
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      socket.emit("typing", { typing: false });
      typingSentUntil.current = 0;
    }, 1700);
  };

  const syncBests = useCallback(() => {
    const socket = socketRef.current;
    if (!socket) return;
    const scores = useStore.getState().gameScores;
    const entries = Object.entries(scores);
    if (!entries.length) return;
    for (const [game, score] of entries) socket.emit("score", { game, score, name: useStore.getState().pet.name });
    sfx("coin");
  }, []);

  // ---------- whiteboard pointer handling ----------
  const ptFrom = (e: React.PointerEvent<HTMLCanvasElement>): Pt => {
    const cv = canvasRef.current!;
    const r = cv.getBoundingClientRect();
    return {
      x: Math.round(((e.clientX - r.left) * (cv.width / r.width)) * 100) / 100,
      y: Math.round(((e.clientY - r.top) * (cv.height / r.height)) * 100) / 100,
    };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const cv = canvasRef.current;
    if (!cv) return;
    try {
      cv.setPointerCapture(e.pointerId);
    } catch {}
    drawingRef.current = true;
    const stroke: Stroke = { id: localUid(), points: [ptFrom(e)], color: accent, size: 3 };
    currentRef.current = stroke;
    sentCountRef.current = 1;
    strokesRef.current.push(stroke);
    if (strokesRef.current.length > 200) strokesRef.current.shift();
    drawSegment(stroke, 0);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const stroke = currentRef.current;
    if (!drawingRef.current || !stroke) return;
    stroke.points.push(ptFrom(e));
    drawSegment(stroke, stroke.points.length - 1);
    const unsent = stroke.points.length - sentCountRef.current;
    if (unsent >= 8) {
      socketRef.current?.emit("stroke:progress", { id: stroke.id, points: stroke.points.slice(sentCountRef.current) });
      sentCountRef.current = stroke.points.length;
    }
  };

  const endStroke = (e?: React.PointerEvent<HTMLCanvasElement>) => {
    const stroke = currentRef.current;
    if (!drawingRef.current || !stroke) return;
    drawingRef.current = false;
    if (e && canvasRef.current) {
      try {
        canvasRef.current.releasePointerCapture(e.pointerId);
      } catch {}
    }
    const remaining = stroke.points.slice(sentCountRef.current);
    if (remaining.length) socketRef.current?.emit("stroke:progress", { id: stroke.id, points: remaining });
    socketRef.current?.emit("stroke:end", { id: stroke.id, points: [] });
    currentRef.current = null;
  };

  const clearBoardRemote = () => {
    socketRef.current?.emit("board:clear");
    clearBoardLocal();
    sfx("pop");
  };

  // ---------- derived ----------
  const typingText = useMemo(() => {
    const names = Object.values(typers);
    if (!names.length) return null;
    return `${names.slice(0, 2).join(", ")}${names.length > 2 ? ` +${names.length - 2}` : ""} ${names.length === 1 ? "is" : "are"} typing…`;
  }, [typers]);

  const games = useMemo(() => Object.entries(board), [board]);

  // collapse runs of system messages (join/leave chatter) into one compact row: "— in ×2 · out ×3 —"
  const chatRows = useMemo(() => {
    type Row = { key: string; sys: boolean; text: string; count: number; msg?: ChatMsg };
    const rows: Row[] = [];
    for (const m of msgs) {
      if (m.sys) {
        const last = rows[rows.length - 1];
        if (last?.sys) {
          const hit = last as Row & { parts?: Map<string, number> };
          // merge into the running sys row, counting duplicates
          const parts = hit.parts ?? new Map<string, number>();
          parts.set(m.text, (parts.get(m.text) ?? 0) + 1);
          hit.parts = parts;
          // rebuild the display text: unique texts in order with counts
          hit.text = [...parts.entries()].map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(" · ");
          hit.count++;
        } else {
          rows.push({ key: m.id, sys: true, text: m.text, count: 1 });
        }
      } else {
        rows.push({ key: m.id, sys: false, text: m.text, count: 1, msg: m });
      }
    }
    return rows;
  }, [msgs]);

  // auto-scroll chat
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, typingText]);

  const live = status === "live";
  const statusLabel = live ? "Team room" : status === "connecting" ? "Connecting…" : "Reconnecting…";

  // ---------- render ----------
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* header */}
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="hud-pill pixel-font text-[14px]">
          {live ? <span className="presence-dot" /> : <span className="h-[9px] w-[9px] rounded-full" style={{ background: "var(--dim)" }} />}
          {statusLabel}
          <span className="chip">{members.length} online</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="chip">
            <Icon name="waves" size={11} /> room: nook
          </span>
          <button className="btn btn-sm" onClick={syncBests} disabled={!live} title="Broadcast your local high scores to the room">
            <Icon name="trophy" size={12} /> sync my bests
          </button>
        </div>
      </header>

      <div className="scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto lg:flex-row lg:overflow-visible">
        {/* left column: presence + leaderboard + bulletin */}
        <aside className="scroll flex w-full shrink-0 flex-col gap-3 lg:w-[268px] lg:min-h-0 lg:overflow-y-auto lg:pr-1">
          <section className="panel p-3" aria-label="Team members">
            <div className="label mb-2 flex items-center gap-1.5">
              <Icon name="user" size={11} /> in the nook
            </div>
            <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto scroll lg:max-h-none">
              {members.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center gap-2 rounded-xl border p-1.5"
                  style={{ borderColor: "var(--line)", background: m.id === mySid ? "var(--hl)" : "var(--panel2)" }}
                >
                  <div className="inset grid h-10 w-10 shrink-0 place-items-center overflow-hidden">
                    <PetView species={m.species as Species} scale={1.05} fps={8} />
                  </div>
                  <div className="min-w-0 flex-1 leading-tight">
                    <div className="pixel-font truncate text-[13px]">
                      {m.name}
                      {m.id === mySid && <span className="text-dim"> (you)</span>}
                    </div>
                    <div className="label">
                      {tagOf(m.species)} {m.species}
                      {m.bot ? " · bot" : ""}
                    </div>
                  </div>
                  {live && <span className="presence-dot" style={{ animationDelay: `${(m.joinedAt % 1000) / 1000}s` }} />}
                </div>
              ))}
            </div>
          </section>

          <Leaderboard board={board} />

          <section className="panel min-h-0 p-3" aria-label="Per-game high scores">
            <div className="label mb-2 flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <Icon name="trophy" size={11} /> per-game podiums
              </span>
              <span className="label">{games.length} game{games.length === 1 ? "" : "s"}</span>
            </div>
            {games.length === 0 ? (
              <p className="text-[12.5px]" style={{ color: "var(--faint)" }}>
                No scores yet. Play something in the arcade, then press <span className="pixel-font">sync my bests</span>.
              </p>
            ) : (
              <div className="flex max-h-64 flex-col gap-2.5 overflow-y-auto scroll pr-1">
                {games.map(([game, scores]) => (
                  <div key={game}>
                    <div className="pixel-font text-[13px]" style={{ color: "var(--accent)" }}>
                      {game}
                    </div>
                    {scores.slice(0, 3).map((s, i) => (
                      <div key={`${s.name}-${s.at}-${i}`} className="flex items-baseline justify-between text-[12.5px]">
                        <span className="truncate" style={{ color: "var(--dim)" }}>
                          {i + 1}. {s.name}
                        </span>
                        <span className="pixel-font pl-2">{s.score}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </section>

          <MarketBulletin />
        </aside>

        {/* middle column: chat */}
        <section className="panel flex h-[430px] shrink-0 flex-col p-3 lg:h-auto lg:min-h-0 lg:min-w-[280px] lg:flex-1" aria-label="Team chat">
          <div className="label mb-2 flex items-center justify-between">
            <span>room chat</span>
            <span className="h-4 truncate text-[10px] normal-case tracking-normal" style={{ color: "var(--faint)" }}>
              {typingText ? <span className="typing">{typingText}</span> : ""}
            </span>
          </div>

          <div ref={chatScrollRef} className="scroll min-h-0 flex-1 overflow-y-auto rounded-xl border p-2" style={{ borderColor: "var(--line)", background: "var(--panel2)" }}>
            {!live && (
              <p className="pixel-font py-6 text-center text-[13px]" style={{ color: "var(--dim)" }}>
                {status === "connecting" ? "connecting to the nook…" : "connection hiccup — retrying…"}
              </p>
            )}
            {live && msgs.length === 0 && (
              <p className="pixel-font py-6 text-center text-[13px]" style={{ color: "var(--faint)" }}>
                nobody has spoken yet — say hi! ✦
              </p>
            )}
            {chatRows.map((row) =>
              row.sys ? (
                <div key={row.key} className="chat-msg flex items-center justify-center gap-1.5 py-0.5 text-center text-[11.5px]" style={{ color: "var(--faint)" }} title={row.count > 1 ? `${row.count} room events` : undefined}>
                  <span className="truncate">— {row.text} —</span>
                  {row.count > 2 && <span className="sys-count">×{row.count}</span>}
                </div>
              ) : (
                <div key={row.key} className="chat-msg mb-1.5 rounded-lg px-2 py-1" style={{ background: row.msg!.clientId === cid ? "var(--hl)" : "transparent" }}>
                  <div className="flex items-baseline gap-1.5">
                    <span className="pixel-font text-[13px]" style={{ color: row.msg!.bot ? "var(--accent)" : "var(--ink)" }}>
                      {tagOf(row.msg!.species)} {row.msg!.from}
                    </span>
                    {row.msg!.bot && <span className="chip" style={{ height: 16, fontSize: 10 }}>bot</span>}
                    <span className="ml-auto text-[10px]" style={{ color: "var(--faint)" }}>
                      {timeOf(row.msg!.at)}
                    </span>
                  </div>
                  <div className="selectable break-words text-[13.5px]">{row.text}</div>
                </div>
              ),
            )}
          </div>

          <div className="mt-2 flex gap-2">
            <input
              className="input flex-1"
              value={draft}
              onChange={(e) => onDraftChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendChat();
                }
              }}
              placeholder={live ? `chat as ${pet.name}…` : "waiting for the room…"}
              maxLength={400}
              disabled={!live}
              aria-label="Chat message"
            />
            <button className="btn btn-accent px-3" onClick={sendChat} disabled={!live || !draft.trim()} aria-label="Send message">
              <Icon name="send" size={14} />
            </button>
          </div>
        </section>

        {/* right column: shared whiteboard */}
        <section className="panel flex w-full shrink-0 flex-col gap-2 p-3 lg:min-w-[300px] lg:max-w-[486px] lg:flex-[1_1_360px]" aria-label="Shared whiteboard">
          <div className="flex items-center justify-between">
            <div className="label flex items-center gap-1.5">
              <Icon name="trash" size={11} /> shared whiteboard
            </div>
            <div className="flex items-center gap-2">
              <span className="chip">
                <span className="h-2 w-2 rounded-sm" style={{ background: accent }} /> your ink
              </span>
              <button className="btn btn-sm" onClick={clearBoardRemote}>
                clear
              </button>
            </div>
          </div>
          <div className="paper relative w-full overflow-hidden">
            <canvas
              ref={canvasRef}
              width={460}
              height={300}
              className="block w-full max-w-[460px] cursor-crosshair"
              style={{ touchAction: "none" }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endStroke}
              onPointerCancel={(e) => endStroke(e)}
            />
          </div>
          <p className="text-[11.5px]" style={{ color: "var(--faint)" }}>
            draw together — every stroke appears live for the whole room, in your theme&apos;s ink.
          </p>
        </section>
      </div>
    </div>
  );
}
