//! Team room — replaces the original socket.io `collab-service` (port 3031) with a tiny
//! WebSocket room inside the app's local server (`/team`). Same events, same payloads:
//! presence (+ a permanent Nook Bot), chat with 60-message history and bot replies,
//! per-game top-10 leaderboard, a shared whiteboard (200-stroke buffer) and typing.
//! Wire format: `{"event": "<name>", "data": <payload>}` text frames.

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};

const BOT_ID: &str = "nook-bot";
const BOT_LINES: &[&str] = &[
    "Nice one, {name}! 🎉",
    "{name}, that's the spirit. Keep the streak going!",
    "Beep boop — logged it, {name}.",
    "Has anyone fed their pet today? 🍓",
    "Fun fact: Blocks pays the most coins per minute.",
    "I'd rate that message 10/10, {name}.",
    "The bazaar has fresh hats today 🎩",
];

#[derive(Default)]
struct RoomState {
    members: Vec<Value>,
    history: Vec<Value>,
    strokes: Vec<Value>,
    leaderboard: serde_json::Map<String, Value>,
    rng: u64,
}

impl RoomState {
    fn rand(&mut self) -> f64 {
        // xorshift — no extra dependency needed for bot chatter
        if self.rng == 0 {
            self.rng = (crate::db::now_ms() as u64) | 1;
        }
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.rng = x;
        (x % 10_000) as f64 / 10_000.0
    }
}

#[derive(Clone)]
pub struct TeamRoom {
    state: Arc<Mutex<RoomState>>,
    /// (exclude connection id, frame)
    tx: broadcast::Sender<(Option<String>, String)>,
}

impl Default for TeamRoom {
    fn default() -> Self {
        Self::new()
    }
}

fn frame(event: &str, data: Value) -> String {
    json!({ "event": event, "data": data }).to_string()
}

fn bot_member() -> Value {
    json!({ "id": BOT_ID, "name": "Nook Bot", "species": "ghost", "joinedAt": 0, "bot": true })
}

fn short_id() -> String {
    crate::db::new_id().replace('-', "")[..12].to_string()
}

impl TeamRoom {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(512);
        TeamRoom { state: Arc::new(Mutex::new(RoomState::default())), tx }
    }

    fn send_all(&self, except: Option<&str>, event: &str, data: Value) {
        let _ = self.tx.send((except.map(String::from), frame(event, data)));
    }

    async fn presence(&self) {
        let st = self.state.lock().await;
        let mut list = vec![bot_member()];
        list.extend(st.members.iter().cloned());
        drop(st);
        self.send_all(None, "presence", Value::Array(list));
    }

    async fn push_chat(&self, msg: Value) {
        let mut st = self.state.lock().await;
        st.history.push(msg.clone());
        let n = st.history.len();
        if n > 60 {
            st.history.drain(..n - 60);
        }
        drop(st);
        self.send_all(None, "chat", msg);
    }

    pub async fn member_count(&self) -> usize {
        self.state.lock().await.members.len()
    }

    /// Drive one WebSocket connection until it closes.
    pub async fn handle_socket(self, socket: WebSocket) {
        let sid = short_id();
        let (mut sink, mut stream) = socket.split();
        let mut rx = self.tx.subscribe();
        let (direct_tx, mut direct_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let me = sid.clone();
        let writer = tokio::spawn(async move {
            loop {
                tokio::select! {
                    Some(f) = direct_rx.recv() => { if sink.send(Message::Text(f.into())).await.is_err() { break; } }
                    r = rx.recv() => match r {
                        Ok((except, f)) => {
                            if except.as_deref() == Some(me.as_str()) {
                                continue;
                            }
                            if sink.send(Message::Text(f.into())).await.is_err() {
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(_) => break,
                    },
                    else => break,
                }
            }
        });
        let _ = direct_tx.send(frame("connected", json!({ "id": sid })));
        let mut name = String::from("Guest");
        let mut species = String::from("cat");
        let mut joined = false;
        while let Some(Ok(msg)) = stream.next().await {
            let text = match msg {
                Message::Text(t) => t.to_string(),
                Message::Close(_) => break,
                _ => continue,
            };
            if text.len() > 64_000 {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
            let ev = v["event"].as_str().unwrap_or("");
            let d = &v["data"];
            match ev {
                "join" => {
                    name = crate::util::s(d.get("name"), 24);
                    if name.is_empty() {
                        name = "Guest".into();
                    }
                    species = crate::util::s(d.get("species"), 16);
                    let member = json!({ "id": sid, "name": name, "species": species, "joinedAt": crate::db::now_ms(), "clientId": crate::util::s(d.get("clientId"), 64) });
                    {
                        let mut st = self.state.lock().await;
                        st.members.retain(|m| m["id"] != sid.as_str());
                        st.members.push(member);
                        let _ = direct_tx.send(frame("chat:history", Value::Array(st.history.clone())));
                        let _ = direct_tx.send(frame("board:sync", Value::Array(st.strokes.clone())));
                        let _ = direct_tx.send(frame("leaderboard", Value::Object(st.leaderboard.clone())));
                    }
                    if !joined {
                        joined = true;
                        self.push_chat(json!({ "id": short_id(), "from": "room", "text": format!("{name} joined the room"), "at": crate::db::now_ms(), "sys": true })).await;
                    }
                    self.presence().await;
                }
                "chat" => {
                    let text = crate::util::s(d.get("text"), 500);
                    if text.is_empty() {
                        continue;
                    }
                    let msg = json!({ "id": short_id(), "from": name, "text": text, "at": crate::db::now_ms(), "species": species, "clientId": crate::util::s(d.get("clientId"), 64) });
                    self.push_chat(msg).await;
                    let roll = self.state.lock().await.rand();
                    if roll < 0.3 {
                        let room = self.clone();
                        let who = name.clone();
                        tokio::spawn(async move {
                            tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
                            let pick = (room.state.lock().await.rand() * BOT_LINES.len() as f64) as usize % BOT_LINES.len();
                            let line = BOT_LINES[pick].replace("{name}", &who);
                            room.push_chat(json!({ "id": short_id(), "from": "Nook Bot", "text": line, "at": crate::db::now_ms(), "species": "ghost", "bot": true })).await;
                        });
                    }
                }
                "score" => {
                    let game = crate::util::s(d.get("game"), 32);
                    let score = d.get("score").and_then(|x| x.as_f64()).filter(|f| f.is_finite() && *f >= 0.0).map(|f| f.round() as i64);
                    let (false, Some(score)) = (game.is_empty(), score) else { continue };
                    let who = Some(crate::util::s(d.get("name"), 24)).filter(|x| !x.is_empty()).unwrap_or_else(|| name.clone());
                    let lb = {
                        let mut st = self.state.lock().await;
                        let entry = st.leaderboard.entry(game).or_insert_with(|| json!([]));
                        let arr = entry.as_array_mut().unwrap();
                        match arr.iter_mut().find(|e| e["name"] == who.as_str()) {
                            Some(e) if e["score"].as_i64().unwrap_or(0) < score => {
                                e["score"] = json!(score);
                                e["at"] = json!(crate::db::now_ms());
                            }
                            Some(_) => {}
                            None => arr.push(json!({ "name": who, "score": score, "at": crate::db::now_ms() })),
                        }
                        arr.sort_by_key(|e| -e["score"].as_i64().unwrap_or(0));
                        arr.truncate(10);
                        Value::Object(st.leaderboard.clone())
                    };
                    self.send_all(None, "leaderboard", lb);
                }
                "stroke:start" => {
                    let stroke = json!({ "id": crate::util::s(d.get("id"), 64), "points": clamp_points(d.get("points")), "color": crate::util::s(d.get("color"), 32), "size": d.get("size").and_then(|x| x.as_f64()).unwrap_or(3.0).clamp(1.0, 40.0) });
                    {
                        let mut st = self.state.lock().await;
                        st.strokes.push(stroke.clone());
                        let n = st.strokes.len();
                        if n > 200 {
                            st.strokes.drain(..n - 200);
                        }
                    }
                    self.send_all(Some(&sid), "stroke:start", stroke);
                }
                "stroke:progress" | "stroke:end" => {
                    let id = crate::util::s(d.get("id"), 64);
                    let pts = clamp_points(d.get("points"));
                    {
                        let mut st = self.state.lock().await;
                        if let Some(s) = st.strokes.iter_mut().rev().find(|s| s["id"] == id.as_str()) {
                            if let (Some(a), Some(new)) = (s["points"].as_array_mut(), pts.as_array()) {
                                if a.len() < 4000 {
                                    a.extend(new.iter().cloned());
                                }
                            }
                        }
                    }
                    self.send_all(Some(&sid), ev, json!({ "id": id, "points": pts }));
                }
                "board:clear" => {
                    self.state.lock().await.strokes.clear();
                    self.send_all(Some(&sid), "board:clear", Value::Null);
                }
                "typing" => {
                    self.send_all(Some(&sid), "typing", json!({ "id": sid, "name": name, "typing": d.get("typing").and_then(|x| x.as_bool()).unwrap_or(false) }));
                }
                _ => {}
            }
        }
        writer.abort();
        let was = {
            let mut st = self.state.lock().await;
            let before = st.members.len();
            st.members.retain(|m| m["id"] != sid.as_str());
            before != st.members.len()
        };
        if was {
            self.push_chat(json!({ "id": short_id(), "from": "room", "text": format!("{name} left"), "at": crate::db::now_ms(), "sys": true })).await;
            self.presence().await;
        }
    }
}

fn clamp_points(v: Option<&Value>) -> Value {
    match v {
        Some(Value::Array(a)) => Value::Array(
            a.iter()
                .take(500)
                .filter_map(|p| Some(json!({ "x": p.get("x")?.as_f64()?.clamp(-10.0, 2000.0), "y": p.get("y")?.as_f64()?.clamp(-10.0, 2000.0) })))
                .collect(),
        ),
        _ => json!([]),
    }
}

