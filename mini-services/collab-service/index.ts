// Nook collab-service — live team room: presence, chat (+ Nook Bot), shared
// leaderboard, live whiteboard sync, typing indicators.
// Runs on hardcoded port 3031 (routed by the Caddy gateway via ?XTransformPort=3031).

import { createServer } from "http";
import { Server, type Socket } from "socket.io";

const PORT = 3031;
const ROOM = "nook";

// ---------- types ----------
type Pt = { x: number; y: number };
type Member = { id: string; name: string; species: string; joinedAt: number; bot?: boolean };
type ChatMsg = {
  id: string;
  from: string;
  text: string;
  at: number;
  species?: string;
  bot?: boolean;
  sys?: boolean;
  clientId?: string;
};
type Stroke = { id: string; points: Pt[]; color: string; size: number };
type Score = { name: string; score: number; at: number };

// ---------- state (in-memory, single room) ----------
const BOT_JOINED_AT = Date.now();
const bot: Member = { id: "nook-bot", name: "Nook Bot", species: "ghost", joinedAt: BOT_JOINED_AT, bot: true };
const members = new Map<string, Member>(); // socket.id -> member
const chatHistory: ChatMsg[] = []; // last 60
const strokes: Stroke[] = []; // rolling buffer, last 200
const leaderboard = new Map<string, Score[]>(); // game -> top 10

const HISTORY_MAX = 60;
const STROKES_MAX = 200;
const STROKE_POINTS_MAX = 600;
const BATCH_MAX = 64; // max points accepted per stroke event
const TEXT_MAX = 400;

const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);

const presenceList = () => [bot, ...members.values()];
const leaderboardObj = () => Object.fromEntries(leaderboard);

// ---------- Nook Bot ----------
const BOT_LINES = [
  "paw-some! {name} is on a roll today ✧",
  "wow {name}… that deserves a treat 🍪",
  "nook news: {name} just raised the vibes meter",
  "beep! saving that to the hall of fame",
  "the pixels are loading… 100% approved by me",
  "{name} said something smart again. typical.",
  "you're doing amazing, {name}. the scoreboard believes in you",
  "brb, telling every pet in the den about this",
  "snack break? you earned it, {name}!",
  "that's the good stuff. more pixels like that, {name}!",
  "if focus were a game, {name} would top the leaderboard",
  "hypothesis: {name} is secretly a genius. proven.",
];

// ---------- Nook Bot goes shopping (market buyer) ----------
// Every few minutes the bot browses the marketplace and buys one listing made
// by the local pet, paying full price — the seller earns 90% via the API.
const MARKET_API = process.env.MARKET_API ?? "http://localhost:3000/api/listings";
const BOT_BUY_MIN_MS = 1000 * 60 * 2.5; // every 2.5–4.5 min
const BOT_BUY_MAX_MS = 1000 * 60 * 4.5;

async function botShoppingTrip() {
  try {
    const pr = await fetch(`${MARKET_API.replace(/\/listings$/, "")}/pet`, { signal: AbortSignal.timeout(6000) });
    const pet = (await pr.json()) as { name?: string };
    const petName = String(pet.name ?? "").slice(0, 24);
    if (!petName) return;
    const r = await fetch(MARKET_API, { signal: AbortSignal.timeout(6000) });
    const listings = (await r.json()) as { id: string; sold: boolean; seller: string; name: string; price: number; kind: string }[];
    const buys = listings.filter((l) => !l.sold && l.seller === petName);
    if (!buys.length || members.size === 0) return; // only shop while someone is around to see it
    const pick = buys[Math.floor(Math.random() * buys.length)];
    const br = await fetch(`${MARKET_API}/${pick.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "botbuy", buyer: bot.name }),
      signal: AbortSignal.timeout(6000),
    });
    const j = (await br.json()) as { ok?: boolean; earned?: number };
    if (!j.ok) return;
    const line = bot.name + " bought " + pick.name + " from " + pick.seller + " for " + pick.price + " coins 🛍️";
    const msg = sysMsg(line + " — " + pick.seller + " earned " + (j.earned ?? 0) + "c!");
    pushChat(msg);
    io.to(ROOM).emit("chat", msg);
    console.log(`[botbuy] ${pick.name} (${pick.kind}) from ${pick.seller} for ${pick.price}c, seller earned ${j.earned}`);
  } catch {
    // market API asleep — no trip today
  }
}
function scheduleBotShopping() {
  const wait = BOT_BUY_MIN_MS + Math.random() * (BOT_BUY_MAX_MS - BOT_BUY_MIN_MS);
  setTimeout(() => {
    void botShoppingTrip();
    scheduleBotShopping();
  }, wait);
}
setTimeout(scheduleBotShopping, 45_000); // first trip ~45s after boot

function botReply(aboutName?: string): ChatMsg {
  const pals = [...members.values()];
  const who = aboutName || (pals.length ? pals[Math.floor(Math.random() * pals.length)].name : "friend");
  const line = BOT_LINES[Math.floor(Math.random() * BOT_LINES.length)].replaceAll("{name}", who);
  return { id: uid(), from: bot.name, text: line, at: Date.now(), species: bot.species, bot: true };
}

function sysMsg(text: string): ChatMsg {
  return { id: uid(), from: "nook", text, at: Date.now(), sys: true };
}

// ---------- helpers ----------
function pushChat(msg: ChatMsg) {
  chatHistory.push(msg);
  if (chatHistory.length > HISTORY_MAX) chatHistory.splice(0, chatHistory.length - HISTORY_MAX);
}

function normPt(p: unknown): Pt | null {
  if (!p || typeof p !== "object") return null;
  const q = p as Record<string, unknown>;
  const x = Number(q.x);
  const y = Number(q.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
}

function normPts(raw: unknown): Pt[] {
  if (!Array.isArray(raw)) return [];
  const out: Pt[] = [];
  for (const p of raw.slice(0, BATCH_MAX)) {
    const pt = normPt(p);
    if (pt) out.push(pt);
  }
  return out;
}

function recordScore(game: string, score: number, name: string) {
  const list = leaderboard.get(game) ?? [];
  list.push({ name, score, at: Date.now() });
  list.sort((a, b) => b.score - a.score);
  leaderboard.set(game, list.slice(0, 10));
}

// ---------- server ----------
const httpServer = createServer();
const io = new Server(httpServer, {
  // DO NOT change the path — Caddy forwards via XTransformPort
  path: "/",
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

io.on("connection", (socket: Socket) => {
  let joined = false;

  socket.on("join", (data: unknown) => {
    const d = (data ?? {}) as Record<string, unknown>;
    const name = String(d.name ?? "pet").slice(0, 24) || "pet";
    const species = String(d.species ?? "cat").slice(0, 16);
    members.set(socket.id, { id: socket.id, name, species, joinedAt: Date.now() });
    socket.join(ROOM);
    joined = true;

    // personal sync on join (and re-join after reconnect)
    socket.emit("presence", presenceList());
    socket.emit("chat:history", chatHistory.slice(-HISTORY_MAX));
    socket.emit("leaderboard", leaderboardObj());
    socket.emit("board:sync", strokes.slice(-STROKES_MAX));

    // everyone else learns about the new member
    io.to(ROOM).emit("presence", presenceList());
    const hello = sysMsg(`${name} the ${species} hopped into the nook`);
    pushChat(hello);
    io.to(ROOM).emit("chat", hello);
    console.log(`[join] ${name} (${species}) socket=${socket.id} members=${members.size}`);
  });

  socket.on("chat", (data: unknown) => {
    if (!joined) return;
    const me = members.get(socket.id);
    if (!me) return;
    const d = (data ?? {}) as Record<string, unknown>;
    const text = String(d.text ?? "").slice(0, TEXT_MAX).trim();
    if (!text) return;
    const msg: ChatMsg = { id: uid(), from: me.name, text, at: Date.now(), species: me.species, clientId: String(d.clientId ?? "").slice(0, 40) };
    pushChat(msg);
    io.to(ROOM).emit("chat", msg);

    // Nook Bot: 30% chance to cheer after a user message, 1.2s later
    if (Math.random() < 0.3) {
      setTimeout(() => {
        const reply = botReply(me.name);
        pushChat(reply);
        io.to(ROOM).emit("chat", reply);
      }, 1200);
    }
  });

  socket.on("score", (data: unknown) => {
    if (!joined) return;
    const me = members.get(socket.id);
    const d = (data ?? {}) as Record<string, unknown>;
    const game = String(d.game ?? "").slice(0, 32);
    const score = Number(d.score);
    if (!game || !Number.isFinite(score) || score < 0) return;
    const name = String(d.name ?? me?.name ?? "anon").slice(0, 24);
    recordScore(game, Math.floor(score), name);
    io.to(ROOM).emit("leaderboard", leaderboardObj());
    console.log(`[score] ${game}: ${score} by ${name}`);
  });

  // ---------- whiteboard ----------
  socket.on("stroke:start", (data: unknown) => {
    if (!joined) return;
    const d = (data ?? {}) as Record<string, unknown>;
    const points = normPts(d.points);
    if (!points.length) return;
    const stroke: Stroke = {
      id: String(d.id ?? uid()).slice(0, 40),
      points,
      color: String(d.color ?? "#888").slice(0, 24),
      size: Math.min(24, Math.max(1, Number(d.size) || 3)),
    };
    strokes.push(stroke);
    if (strokes.length > STROKES_MAX) strokes.splice(0, strokes.length - STROKES_MAX);
    socket.to(ROOM).emit("stroke:start", stroke);
  });

  socket.on("stroke:progress", (data: unknown) => {
    if (!joined) return;
    const d = (data ?? {}) as Record<string, unknown>;
    const id = String(d.id ?? "").slice(0, 40);
    const points = normPts(d.points);
    if (!id || !points.length) return;
    const stroke = strokes.find((s) => s.id === id);
    if (stroke) for (const p of points) if (stroke.points.length < STROKE_POINTS_MAX) stroke.points.push(p);
    socket.to(ROOM).emit("stroke:progress", { id, points });
  });

  socket.on("stroke:end", (data: unknown) => {
    if (!joined) return;
    const d = (data ?? {}) as Record<string, unknown>;
    const id = String(d.id ?? "").slice(0, 40);
    const points = normPts(d.points);
    if (!id) return;
    const stroke = strokes.find((s) => s.id === id);
    if (stroke && points.length) for (const p of points) if (stroke.points.length < STROKE_POINTS_MAX) stroke.points.push(p);
    socket.to(ROOM).emit("stroke:end", { id, points });
  });

  socket.on("board:clear", () => {
    if (!joined) return;
    strokes.length = 0;
    io.to(ROOM).emit("board:clear");
    console.log(`[board] cleared by ${members.get(socket.id)?.name ?? socket.id}`);
  });

  // ---------- typing ----------
  socket.on("typing", (data: unknown) => {
    if (!joined) return;
    const me = members.get(socket.id);
    if (!me) return;
    const d = (data ?? {}) as Record<string, unknown>;
    socket.to(ROOM).emit("typing", { id: socket.id, name: me.name, typing: !!d.typing });
  });

  socket.on("disconnect", () => {
    const me = members.get(socket.id);
    members.delete(socket.id);
    if (me) {
      io.to(ROOM).emit("presence", presenceList());
      const bye = sysMsg(`${me.name} the ${me.species} wandered off`);
      pushChat(bye);
      io.to(ROOM).emit("chat", bye);
      console.log(`[leave] ${me.name} socket=${socket.id} members=${members.size}`);
    }
  });

  socket.on("error", (err) => console.error(`[error] socket=${socket.id}`, err));
});

httpServer.listen(PORT, () => {
  console.log(`collab-service listening on http://localhost:${PORT} (room: ${ROOM})`);
});

process.on("SIGTERM", () => {
  httpServer.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  httpServer.close(() => process.exit(0));
});
