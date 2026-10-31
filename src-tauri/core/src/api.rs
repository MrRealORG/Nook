//! The API router: a 1:1 port of every `src/app/api/**/route.ts` handler of the original
//! Next.js app. The desktop app calls it through a single Tauri command (`api`), the dev
//! server and tests call it over HTTP — same code path, same JSON shapes.

use crate::ai::{AiConfig, AiState, ChatMsg};
use crate::db::{iso, new_id, now_ms, seed_pet_registry, setting_get, setting_put, Db, SPECIES_IDS};
use crate::util::*;
use crate::{agent, mcp};
use base64::Engine;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Debug, Clone, Default)]
pub struct ApiRequest {
    pub method: String,
    /// path without query, e.g. `/api/notes/n-1`
    pub path: String,
    pub query: HashMap<String, String>,
    pub body: Option<Value>,
    /// raw Authorization header (MCP bearer auth)
    pub auth: Option<String>,
}

impl ApiRequest {
    pub fn new(method: &str, url: &str, body: Option<Value>) -> Self {
        let (path, q) = url.split_once('?').unwrap_or((url, ""));
        ApiRequest { method: method.to_uppercase(), path: path.to_string(), query: parse_query(q), body, auth: None }
    }
}

pub fn parse_query(q: &str) -> HashMap<String, String> {
    q.split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            (pct_decode(k), pct_decode(v))
        })
        .collect()
}

pub fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => {
                let h = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|x| u8::from_str_radix(x, 16).ok());
                match h {
                    Some(v) => {
                        out.push(v);
                        i += 2;
                    }
                    None => out.push(b'%'),
                }
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[derive(Debug, Clone)]
pub enum Body {
    Json(Value),
    Bytes { mime: String, name: String, data: Vec<u8> },
    Html(String),
    Empty,
}

#[derive(Debug, Clone)]
pub struct ApiResponse {
    pub status: u16,
    pub body: Body,
}

impl ApiResponse {
    pub fn json(v: Value) -> Self {
        ApiResponse { status: 200, body: Body::Json(v) }
    }
    pub fn status(status: u16, v: Value) -> Self {
        ApiResponse { status, body: Body::Json(v) }
    }
    pub fn err(status: u16, msg: &str) -> Self {
        ApiResponse { status, body: Body::Json(json!({ "error": msg })) }
    }
    pub fn ok() -> Self {
        Self::json(json!({ "ok": true }))
    }
    pub fn json_value(&self) -> Option<&Value> {
        match &self.body {
            Body::Json(v) => Some(v),
            _ => None,
        }
    }
}

/// Everything a request handler may need.
#[derive(Clone)]
pub struct Ctx {
    pub db: Db,
    pub ai: Arc<AiState>,
}

impl Ctx {
    pub fn new(db: Db, ai: Arc<AiState>) -> Self {
        Ctx { db, ai }
    }
}

type R = ApiResponse;

fn body_obj(req: &ApiRequest) -> Map<String, Value> {
    match &req.body {
        Some(Value::Object(m)) => m.clone(),
        _ => Map::new(),
    }
}

/// Main entry: route a request to its handler.
/// Fetch `https://<domain>/favicon.ico` once per domain (Privacy can turn this off) and cache it.
async fn favicons_fetch(ctx: &Ctx, b: &Map<String, Value>) -> ApiResponse {
    let now = crate::db::now_ms();
    let domains: Vec<String> = b.get("domains").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
    let want = {
        let c = ctx.db.conn();
        if !crate::timelens::load_config(&c).favicons {
            return R::json(json!({ "ok": false, "disabled": true, "favicons": crate::tlapps::favicons_map(&c) }));
        }
        crate::tlapps::favicons_missing(&c, &domains, now)
    };
    let client = ctx.ai.http().clone();
    let jobs = want.into_iter().map(|d| {
        let client = client.clone();
        async move {
            let url = format!("https://{d}/favicon.ico");
            let res = client.get(&url).timeout(std::time::Duration::from_secs(6)).send().await;
            let data = match res {
                Ok(r) if r.status().is_success() => match r.bytes().await {
                    Ok(bytes) => crate::tlapps::favicon_mime(&bytes).map(|m| crate::tlapps::data_url(m, &bytes)).unwrap_or_default(),
                    Err(_) => String::new(),
                },
                _ => String::new(),
            };
            (d, data)
        }
    });
    let got = futures_util::future::join_all(jobs).await;
    let c = ctx.db.conn();
    for (d, data) in &got {
        crate::tlapps::favicon_store(&c, d, data, now);
    }
    R::json(json!({ "ok": true, "fetched": got.iter().filter(|(_, d)| !d.is_empty()).count(), "favicons": crate::tlapps::favicons_map(&c) }))
}

pub async fn handle(ctx: &Ctx, req: ApiRequest) -> ApiResponse {
    let path = req.path.trim_end_matches('/');
    let rest = path.strip_prefix("/api").unwrap_or(path);
    let segs: Vec<String> = rest.split('/').filter(|s| !s.is_empty()).map(pct_decode).collect();
    let seg: Vec<&str> = segs.iter().map(|s| s.as_str()).collect();
    let m = req.method.as_str();
    let b = body_obj(&req);

    // async (network) routes first
    match (m, seg.as_slice()) {
        ("POST", ["ai-chat"]) => return ai_chat(ctx, &b).await,
        ("POST", ["agent-tools"]) => return agent_exec(ctx, &b).await,
        ("POST", ["ai-test"]) => return ai_test(ctx, &req).await,
        ("POST", ["ai-models"]) => return ai_models(ctx, &req).await,
        ("POST", ["timelens", "favicons", "fetch"]) => return favicons_fetch(ctx, &b).await,
        ("POST", ["timelens", "icons", "refresh"]) => {
            // icon extraction is blocking Win32/COM work: off the async runtime, no DB lock held
            let db = ctx.db.clone();
            let v = tokio::task::spawn_blocking(move || crate::tlapps::refresh_icons(&db, &crate::tlapps::PlatformIcons, crate::db::now_ms())).await;
            return match v {
                Ok(v) => R::json(v),
                Err(e) => R::err(500, &e.to_string()),
            };
        }
        _ => {}
    }
    if seg.first() == Some(&"mcp") {
        return match m {
            "POST" => {
                let (status, body) = mcp::handle_http(&ctx.db, req.body.clone(), req.auth.as_deref());
                match body {
                    Some(v) => R::status(status, v),
                    None => ApiResponse { status, body: Body::Empty },
                }
            }
            "GET" => R::json(mcp::server_info_json()),
            "OPTIONS" => ApiResponse { status: 204, body: Body::Empty },
            _ => R::err(405, "method not allowed"),
        };
    }

    let db = &ctx.db;
    let c = db.conn();
    if let Some(r) = crate::ext::route(&c, m, seg.as_slice(), &b, &req.query) {
        return r;
    }
    match (m, seg.as_slice()) {
        ("GET", []) => R::json(json!({ "message": "Hello, world!" })),
        ("GET", ["health"]) => match c.query_row("select 1", [], |r| r.get::<_, i64>(0)) {
            Ok(_) => R::json(json!({ "ok": true })),
            Err(_) => R::status(500, json!({ "ok": false })),
        },
        ("GET", ["bootstrap"]) => R::json(bootstrap(&c)),
        // ---------------- notes
        ("GET", ["notes"]) => R::json(Value::Array(all_notes(&c))),
        ("POST", ["notes"]) => notes_create(&c, &b),
        ("PATCH", ["notes", id]) => notes_patch(&c, id, &b),
        ("DELETE", ["notes", id]) => {
            let _ = c.execute(r#"DELETE FROM "Note" WHERE "id"=?1"#, params![id]);
            R::ok()
        }
        ("GET", ["notes", id, "attachments"]) => R::json(attachments_list(&c, id)),
        ("POST", ["notes", id, "attachments"]) => attachments_create(&c, id, &b),
        ("GET", ["attachments", id]) => attachment_get(&c, id),
        ("DELETE", ["attachments", id]) => {
            let _ = c.execute(r#"DELETE FROM "Attachment" WHERE "id"=?1"#, params![id]);
            R::ok()
        }
        // ---------------- folders
        ("GET", ["folders"]) => R::json(folders_list(&c)),
        // 1.3 feature switches mirrored for the background loops (reminders, backups, timelens)
        ("GET", ["features"]) => R::json(crate::db::setting_get(&c, "features").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!({}))),
        ("PUT", ["features"]) => {
            let clean: Map<String, Value> = b.iter().filter(|(_, v)| v.is_boolean()).map(|(k, v)| (take(k, 32), v.clone())).collect();
            let _ = crate::db::setting_put(&c, "features", &Value::Object(clean.clone()).to_string());
            R::json(Value::Object(clean))
        }
        // 1.3.1 UI state mirrored server-side (onboarding-done survives a wiped WebView2 profile)
        ("GET", ["ui-state"]) => R::json(ui_state(&c)),
        ("PUT", ["ui-state"]) => {
            let mut cur = ui_state(&c);
            if let (Some(o), Some(onb)) = (cur.as_object_mut(), b.get("onboarded").and_then(Value::as_bool)) {
                o.insert("onboarded".into(), Value::Bool(onb));
            }
            let _ = crate::db::setting_put(&c, "ui-state", &cur.to_string());
            R::json(cur)
        }
        ("POST", ["folders"]) => folders_create(&c, &b),
        ("PATCH", ["folders", id]) => folders_patch(&c, id, &b),
        ("DELETE", ["folders", id]) => {
            // notes and sub-folders move up to the deleted folder's parent (top level if none)
            let parent: Option<String> = c.query_row(r#"SELECT "parentId" FROM "Folder" WHERE "id"=?1"#, params![id], |r| r.get(0)).ok().flatten();
            let _ = c.execute(r#"UPDATE "Note" SET "folderId"=?2 WHERE "folderId"=?1"#, params![id, parent]);
            let _ = c.execute(r#"UPDATE "Folder" SET "parentId"=?2 WHERE "parentId"=?1"#, params![id, parent]);
            let _ = c.execute(r#"DELETE FROM "Folder" WHERE "id"=?1"#, params![id]);
            R::ok()
        }
        // ---------------- canvases
        ("GET", ["canvases"]) => R::json(canvases_list(&c)),
        ("POST", ["canvases"]) => canvases_create(&c, &b),
        ("PATCH", ["canvases", id]) => canvases_patch(&c, id, &b),
        ("DELETE", ["canvases", id]) => {
            let _ = c.execute(r#"DELETE FROM "Canvas" WHERE "id"=?1"#, params![id]);
            R::ok()
        }
        // ---------------- pet
        ("GET", ["pet"]) => R::json(pet_get(&c).unwrap_or(Value::Null)),
        ("PUT", ["pet"]) => pet_put(&c, &b),
        // ---------------- tasks
        ("GET", ["tasks"]) => R::json(tasks_list(&c)),
        ("POST", ["tasks"]) => tasks_create(&c, &b),
        ("PATCH", ["tasks", id]) => tasks_patch(&c, id, &b),
        ("DELETE", ["tasks", id]) => {
            let _ = c.execute(r#"DELETE FROM "Task" WHERE "id"=?1"#, params![id]);
            R::ok()
        }
        // ---------------- settings-backed stores
        ("GET", ["rules"]) => match setting_get(&c, "activity-rules") {
            None => R::json(json!({ "ok": true, "rules": null })),
            Some(v) => match serde_json::from_str::<Value>(&v) {
                Ok(r) => R::json(json!({ "ok": true, "rules": r })),
                Err(_) => R::json(json!({ "ok": false, "rules": null })),
            },
        },
        ("PUT", ["rules"]) => match b.get("rules") {
            Some(r @ Value::Object(_)) => match setting_put(&c, "activity-rules", &r.to_string()) {
                Ok(_) => R::ok(),
                Err(e) => R::err(500, &e),
            },
            _ => R::err(400, "rules object required"),
        },
        ("GET", ["games"]) => {
            let v = setting_get(&c, "custom-games").and_then(|x| serde_json::from_str::<Value>(&x).ok());
            R::json(match v {
                Some(a @ Value::Array(_)) => a,
                _ => json!([]),
            })
        }
        ("PUT", ["games"]) => match b.get("games") {
            Some(Value::Array(a)) => {
                let total = a.len();
                let payload = Value::Array(a.iter().take(60).cloned().collect()).to_string();
                if payload.len() > 2_000_000 {
                    return R::err(413, "too large");
                }
                let _ = setting_put(&c, "custom-games", &payload);
                R::json(json!({ "ok": true, "count": total }))
            }
            _ => R::err(400, "games array required"),
        },
        ("DELETE", ["games"]) => {
            let _ = c.execute(r#"DELETE FROM "Setting" WHERE "id"='custom-games'"#, []);
            R::ok()
        }
        ("GET", ["packs"]) => R::json(packs_list(&c)),
        ("POST", ["packs"]) => packs_create(&c, req.body.as_ref().unwrap_or(&Value::Null)),
        ("GET", ["packs", id]) => {
            if !is_word_id(id, 3, 60, &[':']) {
                return R::err(400, "bad id");
            }
            match setting_get(&c, &format!("pack:{id}")) {
                None => R::err(404, "not found"),
                Some(v) => match serde_json::from_str::<Value>(&v) {
                    Ok(p) => R::json(p),
                    Err(_) => R::err(500, "corrupt"),
                },
            }
        }
        ("DELETE", ["packs", id]) => {
            if !is_word_id(id, 3, 60, &[':']) {
                return R::err(400, "bad id");
            }
            let _ = c.execute(r#"DELETE FROM "Setting" WHERE "id"=?1"#, params![format!("pack:{id}")]);
            R::ok()
        }
        // ---------------- bugs
        ("GET", ["bugs"]) => R::json(bugs_list(&c)),
        ("POST", ["bugs"]) => bugs_create(&c, &b),
        ("PATCH", ["bugs", id]) => {
            let st = s(b.get("status"), 20);
            if !["open", "fixing", "fixed"].contains(&st.as_str()) {
                return R::status(400, json!({ "ok": false }));
            }
            match c.execute(r#"UPDATE "Bug" SET "status"=?1 WHERE "id"=?2"#, params![st, id]) {
                Ok(1) => R::ok(),
                _ => R::status(404, json!({ "ok": false })),
            }
        }
        ("DELETE", ["bugs", id]) => match c.execute(r#"DELETE FROM "Bug" WHERE "id"=?1"#, params![id]) {
            Ok(1) => R::ok(),
            _ => R::status(404, json!({ "ok": false })),
        },
        // ---------------- activity
        ("GET", ["activity"]) => {
            let days = req.query.get("days").and_then(|d| d.parse::<f64>().ok()).unwrap_or(7.0).clamp(1.0, 30.0) as i64;
            R::json(activity_get(&c, days))
        }
        ("POST", ["activity"]) => activity_post(&c, &b),
        ("PATCH", ["activity"]) => {
            let app = s(b.get("app"), 200);
            let cat = s(b.get("cat"), 20);
            if app.is_empty() || !["productive", "neutral", "distraction"].contains(&cat.as_str()) {
                return R::err(400, "app + cat required");
            }
            let _ = c.execute(r#"UPDATE "AppUse" SET "cat"=?1, "updatedAt"=?2 WHERE "app"=?3"#, params![cat, now_ms(), app]);
            R::ok()
        }
        // ---------------- market
        ("GET", ["listings"]) => R::json(listings_list(&c)),
        ("POST", ["listings"]) => listings_create(&c, &b),
        ("DELETE", ["listings", id]) => {
            let _ = c.execute(r#"DELETE FROM "Listing" WHERE "id"=?1"#, params![id]);
            R::ok()
        }
        ("POST", ["listings", id]) => listing_action(&c, id, &b),
        // ---------------- mcp log
        ("GET", ["mcp-log"]) => R::json(mcp::log_summary(&c)),
        ("DELETE", ["mcp-log"]) => {
            let _ = c.execute(r#"DELETE FROM "Setting" WHERE "id"='mcp-log'"#, []);
            R::json(json!({ "ok": true, "cleared": true }))
        }
        ("GET", ["mcp-token"]) => R::json(json!({ "ok": true, "set": mcp::get_token(&c).is_some() })),
        ("PUT", ["mcp-token"]) => {
            let t = s(b.get("token"), 200);
            match mcp::set_token(&c, if t.is_empty() { None } else { Some(&t) }) {
                Ok(_) => R::json(json!({ "ok": true, "set": !t.is_empty() })),
                Err(e) => R::err(500, &e),
            }
        }
        // ---------------- pet library
        ("GET", ["pet-registry"]) => {
            let _ = seed_pet_registry(&c);
            R::json(json!({ "folders": pet_folders(&c), "blueprints": blueprints(&c) }))
        }
        ("POST", ["pet-registry"]) => registry_save(&c, &b),
        ("POST", ["pet-registry", "folders"]) => registry_folder_create(&c, &b),
        ("POST", ["pet-registry", "import"]) => registry_import(&c, &b),
        ("PATCH", ["pet-registry", id]) => registry_patch(&c, id, &b, req.query.get("type").map(|x| x == "folder").unwrap_or(false)),
        ("DELETE", ["pet-registry", id]) => registry_delete(&c, id, req.query.get("type").map(|x| x == "folder").unwrap_or(false)),
        // ---------------- share
        ("GET", ["share"]) => share_get(&c, &req.query),
        ("POST", ["share"]) => share_create(&c, &b),
        ("PATCH", ["share"]) => share_patch(&c, &b),
        ("DELETE", ["share"]) => share_revoke(&c, req.query.get("shareId").map(|x| x.as_str()).unwrap_or("")),
        // ---------------- AI provider config (key lives in the OS keyring, never in SQLite)
        ("GET", ["ai-config"]) => {
            drop(c);
            R::json(ctx.ai.public_config(&ctx.db))
        }
        ("PUT", ["ai-config"]) => {
            drop(c);
            match ctx.ai.save_config(&ctx.db, &Value::Object(b)) {
                Ok(v) => R::json(v),
                Err(e) => R::err(400, &e),
            }
        }
        ("GET", ["agent-tools"]) => R::json(json!({ "catalog": agent::tool_catalog(), "tools": agent::tool_names() })),
        _ => R::err(404, &format!("no route for {m} {path}")),
    }
}

// ============================================================== serializers

pub fn note_row(r: &Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, String>("id")?,
        "title": r.get::<_, String>("title")?,
        "content": r.get::<_, String>("content")?,
        "cover": r.get::<_, Option<String>>("cover")?,
        "pinned": r.get::<_, i64>("pinned")? != 0,
        "folderId": r.get::<_, Option<String>>("folderId")?,
        "tags": parse_tags(&r.get::<_, String>("tags")?),
        "createdAt": r.get::<_, i64>("createdAt")?,
        "updatedAt": r.get::<_, i64>("updatedAt")?,
    }))
}

pub fn all_notes(c: &Connection) -> Vec<Value> {
    query_vec(c, r#"SELECT * FROM "Note" ORDER BY "updatedAt" DESC"#, [], note_row)
}

pub fn query_vec<P: rusqlite::Params>(c: &Connection, sql: &str, p: P, f: impl Fn(&Row) -> rusqlite::Result<Value>) -> Vec<Value> {
    let mut st = match c.prepare(sql) {
        Ok(s) => s,
        Err(e) => {
            log::error!("prepare failed: {e} — {sql}");
            return vec![];
        }
    };
    let rows = st.query_map(p, |r| f(r));
    match rows {
        Ok(it) => it.filter_map(|x| x.ok()).collect(),
        Err(_) => vec![],
    }
}

fn canvas_row(r: &Row) -> rusqlite::Result<Value> {
    let d = parse_json_obj(&r.get::<_, String>("data")?);
    let arr = |k: &str| match d.get(k) {
        Some(Value::Array(a)) => Value::Array(a.clone()),
        _ => json!([]),
    };
    Ok(json!({
        "id": r.get::<_, String>("id")?,
        "name": r.get::<_, String>("name")?,
        "updatedAt": r.get::<_, i64>("updatedAt")?,
        "data": { "nodes": arr("nodes"), "edges": arr("edges"), "view": d.get("view").cloned().filter(|v| v.is_object()).unwrap_or(json!({"x":0,"y":0,"z":1})) },
    }))
}

fn canvases_list(c: &Connection) -> Value {
    Value::Array(query_vec(c, r#"SELECT * FROM "Canvas" ORDER BY "createdAt" ASC"#, [], canvas_row))
}

fn folder_row(r: &Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, String>("id")?,
        "name": r.get::<_, String>("name")?,
        "icon": r.get::<_, String>("icon")?,
        "color": r.get::<_, String>("color")?,
        "position": r.get::<_, i64>("position")?,
        "parentId": r.get::<_, Option<String>>("parentId")?,
        "pinned": r.get::<_, i64>("pinned")? != 0,
        "createdAt": iso(r.get::<_, i64>("createdAt")?),
    }))
}

fn folders_list(c: &Connection) -> Value {
    Value::Array(query_vec(c, r#"SELECT * FROM "Folder" ORDER BY "position" ASC"#, [], folder_row))
}

const DEFAULT_STATS: &str = r#"{"words":0,"fed":0,"pats":0,"games":0,"focus":0,"best":0,"sold":0,"earned":0,"sales":0,"tricks":0}"#;

fn pet_row(r: &Row) -> rusqlite::Result<Value> {
    let owned: Vec<String> = match serde_json::from_str::<Value>(&r.get::<_, String>("owned")?) {
        Ok(Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(String::from)).collect(),
        _ => vec!["none".into()],
    };
    let mut tricks: Vec<String> = match serde_json::from_str::<Value>(&r.get::<_, String>("tricks")?) {
        Ok(Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(String::from)).collect(),
        _ => vec!["wave".into(), "spin".into()],
    };
    if !tricks.iter().any(|t| t == "wave") {
        tricks.insert(0, "wave".into());
    }
    if !tricks.iter().any(|t| t == "spin") {
        tricks.push("spin".into());
    }
    let mut stats = parse_json_obj(DEFAULT_STATS);
    if let Value::Object(extra) = parse_json_obj(&r.get::<_, String>("stats")?) {
        for (k, v) in extra {
            stats[k] = v;
        }
    }
    let raw_look = parse_json_obj(&r.get::<_, String>("look")?);
    let mut look = json!({});
    if let Some(Value::Array(a)) = raw_look.get("ramp") {
        look["ramp"] = json!(a.iter().filter_map(|x| x.as_str()).take(5).collect::<Vec<_>>());
    }
    if let Some(Value::String(a)) = raw_look.get("accent") {
        look["accent"] = json!(a);
    }
    let species: String = r.get("species")?;
    Ok(json!({
        "id": r.get::<_, String>("id")?,
        "name": r.get::<_, String>("name")?,
        "species": if SPECIES_IDS.contains(&species.as_str()) { species } else { "cat".into() },
        "food": r.get::<_, i64>("food")?,
        "energy": r.get::<_, i64>("energy")?,
        "joy": r.get::<_, i64>("joy")?,
        "xp": r.get::<_, i64>("xp")?,
        "coins": r.get::<_, i64>("coins")?,
        "hat": r.get::<_, String>("hat")?,
        "owned": owned,
        "tricks": tricks,
        "stats": stats,
        "look": look,
        "tickAt": r.get::<_, i64>("tickAt")?,
    }))
}

pub fn pet_get(c: &Connection) -> Option<Value> {
    c.query_row(r#"SELECT * FROM "Pet" LIMIT 1"#, [], pet_row).optional().ok().flatten()
}

fn default_pet() -> Value {
    json!({ "id": "pet-1", "name": "Mochi", "species": "cat", "food": 80, "energy": 90, "joy": 70, "xp": 0, "coins": 120, "hat": "none",
        "owned": ["none"], "tricks": ["wave", "spin"], "stats": parse_json_obj(DEFAULT_STATS), "look": {}, "tickAt": now_ms() })
}

fn listing_row(r: &Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, String>("id")?,
        "kind": r.get::<_, String>("kind")?,
        "itemId": r.get::<_, String>("itemId")?,
        "name": r.get::<_, String>("name")?,
        "blurb": r.get::<_, String>("blurb")?,
        "price": r.get::<_, i64>("price")?,
        "seller": r.get::<_, String>("seller")?,
        "payload": parse_json_obj(&r.get::<_, String>("payload")?),
        "sold": r.get::<_, i64>("sold")? != 0,
        "createdAt": r.get::<_, i64>("createdAt")?,
    }))
}

fn listings_list(c: &Connection) -> Value {
    let mut hist: HashMap<String, Vec<Value>> = HashMap::new();
    if let Ok(mut st) = c.prepare(r#"SELECT "listingId","price","kind","createdAt" FROM "ListingEvent" ORDER BY "createdAt" ASC, rowid ASC"#) {
        if let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?))) {
            for (lid, p, k, at) in rows.flatten() {
                hist.entry(lid).or_default().push(json!({ "p": p, "k": k, "at": at }));
            }
        }
    }
    let rows = query_vec(c, r#"SELECT * FROM "Listing" ORDER BY "createdAt" DESC, rowid DESC"#, [], listing_row);
    Value::Array(
        rows.into_iter()
            .map(|mut l| {
                let id = l["id"].as_str().unwrap_or("").to_string();
                l["history"] = Value::Array(hist.remove(&id).unwrap_or_default());
                l
            })
            .collect(),
    )
}

fn ui_state(c: &Connection) -> Value {
    let v = crate::db::setting_get(c, "ui-state").and_then(|s| serde_json::from_str::<Value>(&s).ok()).unwrap_or(json!({}));
    json!({ "onboarded": v.get("onboarded").and_then(Value::as_bool).unwrap_or(false) })
}

fn bootstrap(c: &Connection) -> Value {
    let folders: Vec<Value> = match folders_list(c) {
        Value::Array(a) => a
            .into_iter()
            .map(|f| json!({ "id": f["id"], "name": f["name"], "icon": f["icon"], "color": f["color"], "position": f["position"] }))
            .collect(),
        _ => vec![],
    };
    json!({
        "ui": ui_state(c),
        "notes": all_notes(c),
        "canvases": canvases_list(c),
        "pet": pet_get(c).unwrap_or_else(default_pet),
        "folders": folders,
        "listings": listings_list(c),
    })
}

// ============================================================== notes

fn valid_or_uuid(id: Option<&Value>) -> String {
    match str_of(id) {
        Some(x) if is_word_id(x, 3, 40, &[]) => x.to_string(),
        _ => new_id(),
    }
}

fn notes_create(c: &Connection, b: &Map<String, Value>) -> R {
    let id = valid_or_uuid(b.get("id"));
    let now = now_ms();
    let title = take(str_of(b.get("title")).unwrap_or("Untitled"), 200);
    let content = take(str_of(b.get("content")).unwrap_or(""), 400_000);
    let cover = str_of(b.get("cover")).map(String::from);
    let folder = str_of(b.get("folderId")).map(String::from);
    let tags = Value::from(clean_tags(b.get("tags"))).to_string();
    let r = c.execute(
        r#"INSERT INTO "Note" ("id","title","content","cover","pinned","folderId","tags","createdAt","updatedAt") VALUES (?1,?2,?3,?4,0,?5,?6,?7,?7)"#,
        params![id, title, content, cover, folder, tags, now],
    );
    match r {
        Ok(_) => R::json(c.query_row(r#"SELECT * FROM "Note" WHERE "id"=?1"#, params![id], note_row).unwrap_or(json!({ "id": id }))),
        Err(_) => R::json(json!({ "id": id })),
    }
}

fn notes_patch(c: &Connection, id: &str, b: &Map<String, Value>) -> R {
    let mut sets: Vec<String> = vec![r#""updatedAt"=?"#.into()];
    let mut vals: Vec<rusqlite::types::Value> = vec![now_ms().into()];
    if let Some(t) = str_of(b.get("title")) {
        sets.push(r#""title"=?"#.into());
        vals.push(take(t, 200).into());
    }
    if let Some(t) = str_of(b.get("content")) {
        sets.push(r#""content"=?"#.into());
        vals.push(take(t, 400_000).into());
    }
    match b.get("cover") {
        Some(Value::Null) => {
            sets.push(r#""cover"=NULL"#.into());
        }
        Some(Value::String(x)) => {
            sets.push(r#""cover"=?"#.into());
            vals.push(x.clone().into());
        }
        _ => {}
    }
    if let Some(Value::Bool(p)) = b.get("pinned") {
        sets.push(r#""pinned"=?"#.into());
        vals.push((*p as i64).into());
    }
    match b.get("folderId") {
        Some(Value::Null) => sets.push(r#""folderId"=NULL"#.into()),
        Some(Value::String(x)) => {
            sets.push(r#""folderId"=?"#.into());
            vals.push(x.clone().into());
        }
        _ => {}
    }
    if let Some(Value::Array(_)) = b.get("tags") {
        sets.push(r#""tags"=?"#.into());
        vals.push(Value::from(clean_tags(b.get("tags"))).to_string().into());
    }
    vals.push(id.to_string().into());
    let sql = format!(r#"UPDATE "Note" SET {} WHERE "id"=?"#, sets.join(", "));
    if let Err(e) = c.execute(&sql, params_from_iter(vals)) {
        log::warn!("note patch failed: {e}");
    }
    R::ok()
}

fn att_meta(r: &Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, String>("id")?,
        "noteId": r.get::<_, String>("noteId")?,
        "name": r.get::<_, String>("name")?,
        "mime": r.get::<_, String>("mime")?,
        "size": r.get::<_, i64>("size")?,
        "createdAt": iso(r.get::<_, i64>("createdAt")?),
    }))
}

fn attachments_list(c: &Connection, note: &str) -> Value {
    Value::Array(query_vec(
        c,
        r#"SELECT "id","noteId","name","mime","size","createdAt" FROM "Attachment" WHERE "noteId"=?1 ORDER BY "createdAt" ASC, rowid ASC"#,
        params![note],
        att_meta,
    ))
}

fn attachments_create(c: &Connection, note: &str, b: &Map<String, Value>) -> R {
    let name = str_of(b.get("name")).unwrap_or("");
    let data = match str_of(b.get("dataB64")) {
        Some(d) if !name.is_empty() => d,
        _ => return R::err(400, "name and dataB64 required"),
    };
    if data.len() > 12_000_000 {
        return R::err(413, "file too large (max ~8MB)");
    }
    let exists: bool = c.query_row(r#"SELECT 1 FROM "Note" WHERE "id"=?1"#, params![note], |_| Ok(true)).optional().ok().flatten().unwrap_or(false);
    if !exists {
        return R::err(404, "note not found");
    }
    let now = now_ms();
    let id = format!("att-{}-{}", radix36(now as u64), &new_id().replace('-', "")[..6]);
    let mime = str_of(b.get("mime")).filter(|m| !m.is_empty()).unwrap_or("application/octet-stream");
    let size = num_of(b.get("size")).unwrap_or(0.0).round().max(0.0) as i64;
    let r = c.execute(
        r#"INSERT INTO "Attachment" ("id","noteId","name","mime","size","data","createdAt") VALUES (?1,?2,?3,?4,?5,?6,?7)"#,
        params![id, note, take(name, 180), take(mime, 120), size, data, now],
    );
    match r {
        Ok(_) => {
            let v = c.query_row(r#"SELECT "id","noteId","name","mime","size","createdAt" FROM "Attachment" WHERE "id"=?1"#, params![id], att_meta).unwrap_or(json!({ "id": id }));
            R::status(201, v)
        }
        Err(e) => R::err(500, &e.to_string()),
    }
}

fn attachment_get(c: &Connection, id: &str) -> R {
    let row = c
        .query_row(r#"SELECT "name","mime","data" FROM "Attachment" WHERE "id"=?1"#, params![id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        })
        .optional()
        .ok()
        .flatten();
    match row {
        None => R::err(404, "Not found"),
        Some((name, mime, data)) => {
            let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).unwrap_or_default();
            ApiResponse { status: 200, body: Body::Bytes { mime: if mime.is_empty() { "application/octet-stream".into() } else { mime }, name, data: bytes } }
        }
    }
}

pub fn radix36(mut n: u64) -> String {
    const A: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = vec![];
    while n > 0 {
        out.push(A[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

// ============================================================== folders & canvases

fn folders_create(c: &Connection, b: &Map<String, Value>) -> R {
    let id = valid_or_uuid(b.get("id"));
    let _ = c.execute(
        r#"INSERT INTO "Folder" ("id","name","icon","color","position","createdAt","parentId") VALUES (?1,?2,?3,?4,?5,?6,?7)"#,
        params![
            id,
            take(str_of(b.get("name")).unwrap_or("New folder"), 80),
            take(str_of(b.get("icon")).unwrap_or("folder"), 32),
            take(str_of(b.get("color")).unwrap_or(""), 16),
            num_of(b.get("position")).map(|p| p.round() as i64).unwrap_or(0),
            now_ms(),
            str_of(b.get("parentId")).filter(|p| !p.is_empty()),
        ],
    );
    R::json(json!({ "id": id }))
}

fn folders_patch(c: &Connection, id: &str, b: &Map<String, Value>) -> R {
    for (k, max) in [("name", 80), ("icon", 32), ("color", 16)] {
        if let Some(v) = str_of(b.get(k)) {
            let _ = c.execute(&format!(r#"UPDATE "Folder" SET "{k}"=?1 WHERE "id"=?2"#), params![take(v, max), id]);
        }
    }
    if let Some(p) = num_of(b.get("position")) {
        let _ = c.execute(r#"UPDATE "Folder" SET "position"=?1 WHERE "id"=?2"#, params![p.round() as i64, id]);
    }
    if let Some(p) = b.get("pinned").and_then(|v| v.as_bool()) {
        let _ = c.execute(r#"UPDATE "Folder" SET "pinned"=?1 WHERE "id"=?2"#, params![p as i64, id]);
    }
    if let Some(v) = b.get("parentId") {
        // move into another folder (null / "" = top level); never into itself or a descendant
        let parent = v.as_str().filter(|p| !p.is_empty() && *p != id).map(String::from);
        if parent.as_deref().map(|p| !folder_is_descendant(c, p, id)).unwrap_or(true) {
            let _ = c.execute(r#"UPDATE "Folder" SET "parentId"=?1 WHERE "id"=?2"#, params![parent, id]);
        } else {
            return R::err(400, "can't move a folder into itself");
        }
    }
    R::ok()
}

/// Is `node` inside `ancestor` (following parent links, cycle-safe)?
fn folder_is_descendant(c: &Connection, node: &str, ancestor: &str) -> bool {
    let mut cur = Some(node.to_string());
    for _ in 0..64 {
        let Some(n) = cur else { return false };
        if n == ancestor {
            return true;
        }
        cur = c.query_row(r#"SELECT "parentId" FROM "Folder" WHERE "id"=?1"#, params![n], |r| r.get::<_, Option<String>>(0)).ok().flatten();
    }
    true
}

fn canvases_create(c: &Connection, b: &Map<String, Value>) -> R {
    let id = valid_or_uuid(b.get("id"));
    let data = b.get("data").filter(|d| !d.is_null()).cloned().unwrap_or(json!({ "nodes": [], "edges": [], "view": { "x": 0, "y": 0, "z": 1 } }));
    let now = now_ms();
    let _ = c.execute(
        r#"INSERT INTO "Canvas" ("id","name","data","createdAt","updatedAt") VALUES (?1,?2,?3,?4,?4)"#,
        params![id, take(str_of(b.get("name")).unwrap_or("Untitled board"), 120), data.to_string(), now],
    );
    R::json(json!({ "id": id }))
}

fn canvases_patch(c: &Connection, id: &str, b: &Map<String, Value>) -> R {
    let now = now_ms();
    let _ = c.execute(r#"UPDATE "Canvas" SET "updatedAt"=?1 WHERE "id"=?2"#, params![now, id]);
    if let Some(n) = str_of(b.get("name")) {
        let _ = c.execute(r#"UPDATE "Canvas" SET "name"=?1 WHERE "id"=?2"#, params![take(n, 120), id]);
    }
    if let Some(d @ Value::Object(_)) = b.get("data") {
        let _ = c.execute(r#"UPDATE "Canvas" SET "data"=?1 WHERE "id"=?2"#, params![d.to_string(), id]);
    }
    R::ok()
}

// ============================================================== pet

fn pet_put(c: &Connection, b: &Map<String, Value>) -> R {
    let row = c
        .query_row(r#"SELECT "id","name","species","food","energy","joy","xp","coins","hat" FROM "Pet" LIMIT 1"#, [], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                [r.get::<_, i64>(3)?, r.get::<_, i64>(4)?, r.get::<_, i64>(5)?, r.get::<_, i64>(6)?, r.get::<_, i64>(7)?],
                r.get::<_, String>(8)?,
            ))
        })
        .optional()
        .ok()
        .flatten();
    let Some((pid, name, species, nums, hat)) = row else {
        return R::status(404, json!({ "ok": false }));
    };
    let n = |k: &str, lo: f64, hi: f64, d: i64| num_of(b.get(k)).map(|v| v.clamp(lo, hi).round() as i64).unwrap_or(d);
    let new_name = str_of(b.get("name")).map(|x| take(x.trim(), 16)).filter(|x| !x.is_empty()).unwrap_or(name);
    let new_species = str_of(b.get("species")).filter(|x| SPECIES_IDS.contains(x)).map(String::from).unwrap_or(species);
    let strs = |k: &str, max: usize| -> Option<String> {
        match b.get(k) {
            Some(Value::Array(a)) => Some(Value::from(a.iter().filter_map(|x| x.as_str().map(String::from)).take(max).collect::<Vec<_>>()).to_string()),
            _ => None,
        }
    };
    let obj = |k: &str| -> Option<String> { b.get(k).filter(|v| v.is_object()).map(|v| v.to_string()) };
    let r = c.execute(
        r#"UPDATE "Pet" SET "name"=?1,"species"=?2,"food"=?3,"energy"=?4,"joy"=?5,"xp"=?6,"coins"=?7,"hat"=?8,
           "owned"=COALESCE(?9,"owned"),"tricks"=COALESCE(?10,"tricks"),"stats"=COALESCE(?11,"stats"),"look"=COALESCE(?12,"look"),"tickAt"=?13 WHERE "id"=?14"#,
        params![
            new_name,
            new_species,
            n("food", 0.0, 100.0, nums[0]),
            n("energy", 0.0, 100.0, nums[1]),
            n("joy", 0.0, 100.0, nums[2]),
            n("xp", 0.0, 10_000_000.0, nums[3]),
            n("coins", 0.0, 10_000_000.0, nums[4]),
            str_of(b.get("hat")).map(|h| take(h, 24)).unwrap_or(hat),
            strs("owned", 60),
            strs("tricks", 20),
            obj("stats"),
            obj("look"),
            now_ms(),
            pid
        ],
    );
    if let Err(e) = r {
        log::warn!("pet put failed: {e}");
    }
    R::ok()
}

// ============================================================== tasks

pub fn task_row(r: &Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, String>("id")?,
        "title": r.get::<_, String>("title")?,
        "list": r.get::<_, String>("list")?,
        "priority": r.get::<_, i64>("priority")?,
        "due": r.get::<_, Option<i64>>("due")?,
        "done": r.get::<_, i64>("done")? != 0,
        "noteId": r.get::<_, Option<String>>("noteId")?,
        "tags": parse_tags(&r.get::<_, String>("tags")?),
        "by": r.get::<_, String>("by")?,
        "createdAt": r.get::<_, i64>("createdAt")?,
        "completedAt": r.get::<_, Option<i64>>("completedAt")?,
        "status": r.get::<_, String>("status").unwrap_or_else(|_| "todo".into()),
        "remindAt": r.get::<_, Option<i64>>("remindAt").unwrap_or(None),
        "repeat": r.get::<_, String>("repeat").unwrap_or_default(),
    }))
}

const LISTS: &[&str] = &["today", "upcoming", "someday"];

fn tasks_list(c: &Connection) -> Value {
    Value::Array(query_vec(c, r#"SELECT * FROM "Task" ORDER BY "done" ASC, "createdAt" DESC, rowid DESC"#, [], task_row))
}

fn tasks_create(c: &Connection, b: &Map<String, Value>) -> R {
    let id = valid_or_uuid(b.get("id"));
    let title = take(str_of(b.get("title")).unwrap_or("").trim(), 200);
    if title.is_empty() {
        return R::err(400, "title required");
    }
    let list = str_of(b.get("list")).filter(|l| LISTS.contains(l)).unwrap_or("today");
    let priority = num_of(b.get("priority")).map(|p| p.round().clamp(0.0, 2.0) as i64).unwrap_or(1);
    let due = num_of(b.get("due")).map(|d| d.round() as i64);
    let note = str_of(b.get("noteId")).map(String::from);
    let by = match str_of(b.get("by")) {
        Some("ai") => "ai",
        Some("agent") => "agent",
        _ => "you",
    };
    let status = str_of(b.get("status")).filter(|s| crate::ext::STATUSES.contains(s) && *s != "done").unwrap_or("todo");
    let remind = num_of(b.get("remindAt")).map(|d| d.round() as i64);
    let repeat = str_of(b.get("repeat")).filter(|s| crate::ext::REPEATS.contains(s)).unwrap_or("");
    let r = c.execute(
        r#"INSERT INTO "Task" ("id","title","list","priority","due","done","noteId","tags","by","createdAt","completedAt","status","remindAt","repeat") VALUES (?1,?2,?3,?4,?5,0,?6,?7,?8,?9,NULL,?10,?11,?12)"#,
        params![id, title, list, priority, due, note, Value::from(clean_tags(b.get("tags"))).to_string(), by, now_ms(), status, remind, repeat],
    );
    match r {
        Ok(_) => R::json(c.query_row(r#"SELECT * FROM "Task" WHERE "id"=?1"#, params![id], task_row).unwrap_or(Value::Null)),
        Err(e) => R::err(409, &e.to_string()),
    }
}

fn tasks_patch(c: &Connection, id: &str, b: &Map<String, Value>) -> R {
    let Some(row) = c.query_row(r#"SELECT * FROM "Task" WHERE "id"=?1"#, params![id], task_row).optional().ok().flatten() else {
        return R::err(404, "not found");
    };
    let was_done = row["done"].as_bool().unwrap_or(false);
    // kanban status and done stay in sync: status wins when both are sent
    let status_in = str_of(b.get("status")).filter(|s| crate::ext::STATUSES.contains(s));
    let done = match status_in {
        Some(st) => st == "done",
        None => b.get("done").and_then(|v| v.as_bool()).unwrap_or(was_done),
    };
    let status = match status_in {
        Some(st) => st.to_string(),
        None if done => "done".to_string(),
        None if was_done && !done => "todo".to_string(),
        None => row["status"].as_str().unwrap_or("todo").to_string(),
    };
    let remind = match b.get("remindAt") {
        Some(Value::Null) => None,
        Some(v) if num_of(Some(v)).is_some() => num_of(Some(v)).map(|d| d.round() as i64),
        _ => row["remindAt"].as_i64(),
    };
    let remind_changed = remind != row["remindAt"].as_i64();
    let repeat = str_of(b.get("repeat")).filter(|s| crate::ext::REPEATS.contains(s)).map(String::from).unwrap_or_else(|| row["repeat"].as_str().unwrap_or("").to_string());
    let title = str_of(b.get("title")).map(|t| take(t.trim(), 200)).filter(|t| !t.is_empty()).unwrap_or_else(|| row["title"].as_str().unwrap_or("").to_string());
    let list = str_of(b.get("list")).filter(|l| LISTS.contains(l)).map(String::from).unwrap_or_else(|| row["list"].as_str().unwrap_or("today").to_string());
    let priority = num_of(b.get("priority")).map(|p| p.round().clamp(0.0, 2.0) as i64).unwrap_or(row["priority"].as_i64().unwrap_or(1));
    let due = match b.get("due") {
        Some(Value::Null) => None,
        Some(v) if num_of(Some(v)).is_some() => num_of(Some(v)).map(|d| d.round() as i64),
        _ => row["due"].as_i64(),
    };
    let note = match b.get("noteId") {
        Some(Value::Null) => None,
        Some(Value::String(x)) => Some(x.clone()),
        _ => row["noteId"].as_str().map(String::from),
    };
    let tags = match b.get("tags") {
        Some(Value::Array(_)) => Value::from(clean_tags(b.get("tags"))).to_string(),
        _ => row["tags"].to_string(),
    };
    let completed = if done && !was_done {
        Some(now_ms())
    } else if !done {
        None
    } else {
        row["completedAt"].as_i64()
    };
    let _ = c.execute(
        r#"UPDATE "Task" SET "title"=?1,"list"=?2,"priority"=?3,"due"=?4,"done"=?5,"noteId"=?6,"tags"=?7,"completedAt"=?8,"status"=?10,"remindAt"=?11,"repeat"=?12 WHERE "id"=?9"#,
        params![title, list, priority, due, done as i64, note, tags, completed, id, status, remind, repeat],
    );
    if remind_changed {
        let _ = c.execute(r#"UPDATE "Task" SET "notifiedAt"=NULL WHERE "id"=?1"#, params![id]);
    }
    let next = if done && !was_done { crate::ext::spawn_next_occurrence(c, id) } else { None };
    let mut out = c.query_row(r#"SELECT * FROM "Task" WHERE "id"=?1"#, params![id], task_row).unwrap_or(Value::Null);
    if let (Some(n), Value::Object(m)) = (next, &mut out) {
        m.insert("next".into(), n);
    }
    R::json(out)
}

// ============================================================== packs / bugs / activity

fn packs_list(c: &Connection) -> Value {
    let rows = query_vec(c, r#"SELECT "value" FROM "Setting" WHERE "id" LIKE 'pack:%'"#, [], |r| Ok(Value::String(r.get(0)?)));
    let mut packs: Vec<Value> = rows
        .into_iter()
        .filter_map(|v| serde_json::from_str::<Value>(v.as_str().unwrap_or("")).ok())
        .filter(|p| p.get("id").map(|x| x.is_string()).unwrap_or(false) && p.get("kind").map(|x| x.is_string()).unwrap_or(false))
        .collect();
    packs.sort_by(|a, b| {
        let f = |v: &Value| v.get("createdAt").and_then(|x| x.as_f64()).unwrap_or(0.0);
        f(b).partial_cmp(&f(a)).unwrap_or(std::cmp::Ordering::Equal)
    });
    Value::Array(packs)
}

fn packs_create(c: &Connection, b: &Value) -> R {
    let id = b.get("id").and_then(|x| x.as_str()).unwrap_or("");
    if !is_word_id(id, 3, 60, &[':']) {
        return R::err(400, "id required");
    }
    if !["icons", "fonts", "wallpapers"].contains(&b.get("kind").and_then(|x| x.as_str()).unwrap_or("")) {
        return R::err(400, "bad kind");
    }
    let raw = b.to_string();
    if raw.len() > 12_000_000 {
        return R::err(413, "pack too large (12MB cap)");
    }
    let _ = setting_put(c, &format!("pack:{id}"), &raw);
    R::ok()
}

fn bug_row(r: &Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, String>("id")?,
        "desc": r.get::<_, String>("desc")?,
        "severity": r.get::<_, String>("severity")?,
        "page": r.get::<_, String>("page")?,
        "ua": r.get::<_, String>("ua")?,
        "logs": r.get::<_, String>("logs")?,
        "screenshot": r.get::<_, String>("screenshot")?,
        "status": r.get::<_, String>("status")?,
        "createdAt": iso(r.get::<_, i64>("createdAt")?),
    }))
}

fn bugs_list(c: &Connection) -> Value {
    Value::Array(query_vec(c, r#"SELECT * FROM "Bug" ORDER BY "createdAt" DESC, rowid DESC LIMIT 60"#, [], bug_row))
}

pub fn bugs_insert(c: &Connection, b: &Map<String, Value>) -> Result<Value, String> {
    let desc = s(b.get("desc"), 2000);
    if desc.is_empty() {
        return Err("desc required".into());
    }
    let sev = s(b.get("severity"), 10);
    let severity = if ["minor", "normal", "blocker"].contains(&sev.as_str()) { sev } else { "normal".into() };
    let id = match str_of(b.get("id")) {
        Some(x) if !x.is_empty() => take(x, 40),
        _ => new_id(),
    };
    c.execute(
        r#"INSERT INTO "Bug" ("id","desc","severity","page","ua","logs","screenshot","status","createdAt") VALUES (?1,?2,?3,?4,?5,?6,?7,'open',?8)"#,
        params![id, desc, severity, s(b.get("page"), 200), s(b.get("ua"), 400), s(b.get("logs"), 40_000), s(b.get("screenshot"), 1_600_000), now_ms()],
    )
    .map_err(|e| e.to_string())?;
    c.query_row(r#"SELECT * FROM "Bug" WHERE "id"=?1"#, params![id], bug_row).map_err(|e| e.to_string())
}

fn bugs_create(c: &Connection, b: &Map<String, Value>) -> R {
    match bugs_insert(c, b) {
        Ok(v) => R::json(v),
        Err(e) if e == "desc required" => R::status(400, json!({ "ok": false, "error": e })),
        Err(e) => R::status(500, json!({ "ok": false, "error": e })),
    }
}

fn activity_get(c: &Connection, days: i64) -> Value {
    let cutoff = crate::db::day_key(now_ms() - (days - 1) * 86_400_000);
    let mut order: Vec<String> = vec![];
    let mut merged: HashMap<String, Value> = HashMap::new();
    let rows = query_vec(c, r#"SELECT "app","cat","day","secs","src" FROM "AppUse" WHERE "day" >= ?1 ORDER BY rowid"#, params![cutoff], |r| {
        Ok(json!({ "app": r.get::<_, String>(0)?, "cat": r.get::<_, String>(1)?, "day": r.get::<_, String>(2)?, "secs": r.get::<_, i64>(3)?, "src": r.get::<_, String>(4)? }))
    });
    for r in rows {
        let key = format!("{}|{}", r["app"].as_str().unwrap_or(""), r["day"].as_str().unwrap_or(""));
        if let Some(hit) = merged.get_mut(&key) {
            hit["secs"] = json!(hit["secs"].as_i64().unwrap_or(0) + r["secs"].as_i64().unwrap_or(0));
        } else {
            order.push(key.clone());
            merged.insert(key, r);
        }
    }
    Value::Array(order.into_iter().filter_map(|k| merged.remove(&k)).collect())
}

fn activity_post(c: &Connection, b: &Map<String, Value>) -> R {
    let entries = match b.get("entries") {
        Some(Value::Array(a)) => a.iter().take(60).cloned().collect::<Vec<_>>(),
        _ => vec![],
    };
    let mut saved = 0;
    for e in entries {
        let app = s(e.get("app"), 40);
        let secs = loose_num(e.get("secs")).map(|x| x.round() as i64).unwrap_or(0);
        if app.is_empty() || secs == 0 {
            continue;
        }
        let d = s(e.get("day"), 20);
        let day = if d.len() == 10 && d.as_bytes()[4] == b'-' && d.as_bytes()[7] == b'-' && d.chars().filter(|c| c.is_ascii_digit()).count() == 8 { d } else { crate::db::day_key(now_ms()) };
        let cat = str_of(e.get("cat")).filter(|x| ["productive", "distraction"].contains(x)).unwrap_or("neutral");
        let src = str_of(e.get("src")).filter(|x| ["manual", "agent", "web"].contains(x)).unwrap_or("web");
        let id = format!("{src}:{app}:{day}");
        let inc = secs.min(86_400);
        let r = c.execute(
            r#"INSERT INTO "AppUse" ("id","app","cat","day","secs","src","updatedAt") VALUES (?1,?2,?3,?4,?5,?6,?7)
               ON CONFLICT("id") DO UPDATE SET "secs" = "secs" + excluded."secs", "cat" = excluded."cat", "updatedAt" = excluded."updatedAt""#,
            params![id, app, cat, day, inc, src, now_ms()],
        );
        if r.is_ok() {
            saved += 1;
        }
    }
    R::json(json!({ "ok": true, "saved": saved }))
}

// ============================================================== market

fn listings_create(c: &Connection, b: &Map<String, Value>) -> R {
    let id = valid_or_uuid(b.get("id"));
    let price = loose_num(b.get("price")).filter(|p| *p != 0.0).unwrap_or(1.0).round().clamp(1.0, 9999.0) as i64;
    let now = now_ms();
    let payload = b.get("payload").filter(|p| !p.is_null()).cloned().unwrap_or(json!({}));
    let r = c.execute(
        r#"INSERT INTO "Listing" ("id","kind","itemId","name","blurb","price","seller","payload","sold","createdAt","updatedAt") VALUES (?1,?2,?3,?4,?5,?6,?7,?8,0,?9,?9)"#,
        params![
            id,
            take(str_of(b.get("kind")).unwrap_or("hat"), 16),
            take(str_of(b.get("itemId")).unwrap_or(""), 40),
            take(str_of(b.get("name")).unwrap_or("Item"), 80),
            take(str_of(b.get("blurb")).unwrap_or(""), 160),
            price,
            take(str_of(b.get("seller")).unwrap_or("Trader"), 24),
            payload.to_string(),
            now
        ],
    );
    match r {
        Ok(_) => {
            let _ = c.execute(r#"INSERT INTO "ListingEvent" ("id","listingId","price","kind","createdAt") VALUES (?1,?2,?3,'list',?4)"#, params![new_id(), id, price, now]);
            R::json(c.query_row(r#"SELECT * FROM "Listing" WHERE "id"=?1"#, params![id], listing_row).unwrap_or(json!({ "id": id })))
        }
        Err(_) => R::status(400, json!({ "id": id })),
    }
}

fn listing_action(c: &Connection, id: &str, b: &Map<String, Value>) -> R {
    let Some(listing) = c.query_row(r#"SELECT * FROM "Listing" WHERE "id"=?1"#, params![id], listing_row).optional().ok().flatten() else {
        return R::status(404, json!({ "ok": false, "error": "Listing not found" }));
    };
    if listing["sold"].as_bool().unwrap_or(false) {
        return R::status(409, json!({ "ok": false, "error": "Already sold" }));
    }
    let Some((pet_id, pet_name, coins)) = c
        .query_row(r#"SELECT "id","name","coins" FROM "Pet" LIMIT 1"#, [], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))
        .optional()
        .ok()
        .flatten()
    else {
        return R::status(404, json!({ "ok": false, "error": "No pet" }));
    };
    let price = listing["price"].as_i64().unwrap_or(0);
    let seller = listing["seller"].as_str().unwrap_or("").to_string();
    let now = now_ms();
    let mut sold_listing = listing.clone();
    sold_listing["sold"] = json!(true);
    let sold_event = |c: &Connection| {
        let _ = c.execute(r#"INSERT INTO "ListingEvent" ("id","listingId","price","kind","createdAt") VALUES (?1,?2,?3,'sold',?4)"#, params![new_id(), id, price, now]);
    };
    match str_of(b.get("action")).unwrap_or("") {
        "buy" => {
            if coins < price {
                return R::status(402, json!({ "ok": false, "error": "Not enough coins" }));
            }
            let earned = if seller == pet_name { (price as f64 * 0.8).round() as i64 } else { 0 };
            let tx = (|| -> rusqlite::Result<()> {
                c.execute_batch("BEGIN")?;
                c.execute(r#"UPDATE "Pet" SET "coins" = "coins" - ?1 + ?2 WHERE "id"=?3"#, params![price, earned, pet_id])?;
                c.execute(r#"UPDATE "Listing" SET "sold"=1, "updatedAt"=?1 WHERE "id"=?2"#, params![now, id])?;
                c.execute_batch("COMMIT")
            })();
            if let Err(e) = tx {
                let _ = c.execute_batch("ROLLBACK");
                return R::status(500, json!({ "ok": false, "error": e.to_string() }));
            }
            sold_event(c);
            R::json(json!({ "ok": true, "action": "buy", "listing": sold_listing, "earned": earned }))
        }
        "botbuy" => {
            let buyer = match b.get("buyer") {
                None | Some(Value::Null) => "Nook Bot".to_string(),
                Some(Value::String(x)) => take(x, 24),
                Some(other) => take(&other.to_string(), 24),
            };
            let earned = if seller == pet_name { (price as f64 * 0.9).round() as i64 } else { 0 };
            let tx = (|| -> rusqlite::Result<()> {
                c.execute_batch("BEGIN")?;
                c.execute(r#"UPDATE "Listing" SET "sold"=1, "updatedAt"=?1 WHERE "id"=?2"#, params![now, id])?;
                if earned > 0 {
                    c.execute(r#"UPDATE "Pet" SET "coins" = "coins" + ?1 WHERE "id"=?2"#, params![earned, pet_id])?;
                }
                c.execute_batch("COMMIT")
            })();
            if let Err(e) = tx {
                let _ = c.execute_batch("ROLLBACK");
                return R::status(500, json!({ "ok": false, "error": e.to_string() }));
            }
            sold_event(c);
            R::json(json!({ "ok": true, "action": "botbuy", "listing": sold_listing, "earned": earned, "buyer": buyer}))
        }
        "reprice" => {
            if seller != pet_name {
                return R::status(403, json!({ "ok": false, "error": "Not your booth" }));
            }
            let np = loose_num(b.get("price")).filter(|p| *p != 0.0).unwrap_or(price as f64).round().clamp(1.0, 9999.0) as i64;
            if np == price {
                return R::json(json!({ "ok": true, "action": "reprice", "listing": listing, "price": np }));
            }
            let _ = c.execute(r#"UPDATE "Listing" SET "price"=?1, "updatedAt"=?2 WHERE "id"=?3"#, params![np, now, id]);
            let _ = c.execute(r#"INSERT INTO "ListingEvent" ("id","listingId","price","kind","createdAt") VALUES (?1,?2,?3,'reprice',?4)"#, params![new_id(), id, np, now]);
            let updated = c.query_row(r#"SELECT * FROM "Listing" WHERE "id"=?1"#, params![id], listing_row).unwrap_or(listing);
            R::json(json!({ "ok": true, "action": "reprice", "listing": updated, "price": np }))
        }
        "sell" => R::json(json!({ "ok": true, "action": "sell", "listing": listing })),
        _ => R::status(400, json!({ "ok": false, "error": "Unknown action" })),
    }
}

// ============================================================== pet library

fn pet_folders(c: &Connection) -> Value {
    Value::Array(query_vec(c, r#"SELECT "id","name","position" FROM "PetFolder" ORDER BY "position" ASC"#, [], |r| {
        Ok(json!({ "id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "position": r.get::<_, i64>(2)? }))
    }))
}

fn blueprint_row(r: &Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, String>("id")?,
        "folderId": r.get::<_, Option<String>>("folderId")?,
        "name": r.get::<_, String>("name")?,
        "species": r.get::<_, String>("species")?,
        "look": parse_json_obj(&r.get::<_, String>("look")?),
        "origin": r.get::<_, String>("origin")?,
        "updatedAt": r.get::<_, i64>("updatedAt")?,
    }))
}

fn blueprints(c: &Connection) -> Value {
    Value::Array(query_vec(c, r#"SELECT * FROM "PetBlueprint" ORDER BY "updatedAt" DESC, rowid DESC"#, [], blueprint_row))
}

fn clean_look(l: &Value) -> Value {
    let mut out = json!({});
    if let Some(Value::Array(a)) = l.get("ramp") {
        out["ramp"] = json!(a.iter().filter_map(|x| x.as_str()).filter(|x| is_hex_color(x)).take(5).collect::<Vec<_>>());
    }
    if let Some(Value::String(a)) = l.get("accent") {
        if is_hex_color(a) {
            out["accent"] = json!(a);
        }
    }
    if let Some(Value::Array(a)) = l.get("says") {
        out["says"] = json!(a.iter().filter_map(|x| x.as_str()).take(12).collect::<Vec<_>>());
    }
    if let Some(Value::String(a)) = l.get("blurb") {
        out["blurb"] = json!(take(a, 200));
    }
    out
}

fn species_or_cat(v: Option<&Value>) -> String {
    let x = s(v, 20);
    if SPECIES_IDS.contains(&x.as_str()) {
        x
    } else {
        "cat".into()
    }
}

fn registry_save(c: &Connection, b: &Map<String, Value>) -> R {
    let name = Some(s(b.get("name"), 24)).filter(|x| !x.is_empty()).unwrap_or_else(|| "New pet".into());
    let species = species_or_cat(b.get("species"));
    let look = b.get("look").filter(|l| l.is_object()).map(|l| clean_look(l).to_string()).unwrap_or_else(|| "{}".into());
    let folder = str_of(b.get("folderId")).filter(|x| !x.is_empty()).map(String::from);
    let o = s(b.get("origin"), 20);
    let origin = if ["builtin", "custom", "imported"].contains(&o.as_str()) { o } else { "custom".into() };
    let now = now_ms();
    let res = match str_of(b.get("id")).filter(|x| !x.is_empty()) {
        Some(id) => c
            .execute(
                r#"UPDATE "PetBlueprint" SET "name"=?1,"species"=?2,"look"=?3,"folderId"=?4,"origin"=?5,"updatedAt"=?6 WHERE "id"=?7"#,
                params![name, species, look, folder, origin, now, id],
            )
            .map_err(|e| e.to_string())
            .and_then(|n| if n == 1 { Ok(id.to_string()) } else { Err("Record to update not found.".into()) }),
        None => {
            let id = new_id();
            c.execute(
                r#"INSERT INTO "PetBlueprint" ("id","folderId","name","species","look","origin","createdAt","updatedAt") VALUES (?1,?2,?3,?4,?5,?6,?7,?7)"#,
                params![id, folder, name, species, look, origin, now],
            )
            .map(|_| id)
            .map_err(|e| e.to_string())
        }
    };
    match res {
        Ok(id) => R::json(c.query_row(r#"SELECT * FROM "PetBlueprint" WHERE "id"=?1"#, params![id], blueprint_row).unwrap_or(Value::Null)),
        Err(e) => R::status(400, json!({ "ok": false, "error": e })),
    }
}

fn registry_folder_create(c: &Connection, b: &Map<String, Value>) -> R {
    let name = Some(s(b.get("name"), 24)).filter(|x| !x.is_empty()).unwrap_or_else(|| "new folder".into());
    if let Some(dup) = c
        .query_row(r#"SELECT "id","name","position" FROM "PetFolder" WHERE "name"=?1"#, params![name], |r| {
            Ok(json!({ "id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "position": r.get::<_, i64>(2)? }))
        })
        .optional()
        .ok()
        .flatten()
    {
        return R::json(dup);
    }
    let max: Option<i64> = c.query_row(r#"SELECT MAX("position") FROM "PetFolder""#, [], |r| r.get(0)).unwrap_or(None);
    let id = new_id();
    let pos = max.unwrap_or(-1) + 1;
    let _ = c.execute(r#"INSERT INTO "PetFolder" ("id","name","position","createdAt") VALUES (?1,?2,?3,?4)"#, params![id, name, pos, now_ms()]);
    R::json(json!({ "id": id, "name": name, "position": pos }))
}

fn registry_import(c: &Connection, b: &Map<String, Value>) -> R {
    let pets: Vec<Value> = match b.get("pets") {
        Some(Value::Array(a)) => a.iter().take(200).cloned().collect(),
        _ => vec![],
    };
    if pets.is_empty() {
        return R::status(400, json!({ "ok": false, "error": "no pets in pack" }));
    }
    let existing = query_vec(c, r#"SELECT "id","name","position" FROM "PetFolder""#, [], |r| {
        Ok(json!({ "id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "position": r.get::<_, i64>(2)? }))
    });
    let mut by_name: HashMap<String, String> = existing.iter().map(|f| (f["name"].as_str().unwrap_or("").to_lowercase(), f["id"].as_str().unwrap_or("").to_string())).collect();
    let mut max_pos = existing.iter().map(|f| f["position"].as_i64().unwrap_or(0)).max().unwrap_or(0).max(0);
    let now = now_ms();
    let mut folder_for = |c: &Connection, name: &str| -> Option<String> {
        let key = name.trim().to_lowercase();
        if key.is_empty() {
            return None;
        }
        if let Some(id) = by_name.get(&key) {
            return Some(id.clone());
        }
        let id = new_id();
        max_pos += 1;
        let _ = c.execute(r#"INSERT INTO "PetFolder" ("id","name","position","createdAt") VALUES (?1,?2,?3,?4)"#, params![id, take(name.trim(), 24), max_pos, now]);
        by_name.insert(key, id.clone());
        Some(id)
    };
    if let Some(Value::Array(fs)) = b.get("folders") {
        for f in fs.iter().take(40) {
            let n = s(f.get("name"), 200);
            if !n.is_empty() {
                folder_for(c, &n);
            }
        }
    }
    let mut created = 0;
    for (i, p) in pets.iter().enumerate() {
        let name = Some(s(p.get("name"), 24)).filter(|x| !x.is_empty()).unwrap_or_else(|| "Imported pet".into());
        let species = species_or_cat(p.get("species"));
        let look = p.get("look").filter(|l| l.is_object()).cloned().unwrap_or(json!({}));
        let raw_folder = {
            let a = s(p.get("folderName"), 200);
            if a.is_empty() {
                s(p.get("folder"), 200)
            } else {
                a
            }
        };
        let folder = if raw_folder.is_empty() { None } else { folder_for(c, &raw_folder) };
        let r = c.execute(
            r#"INSERT INTO "PetBlueprint" ("id","folderId","name","species","look","origin","createdAt","updatedAt") VALUES (?1,?2,?3,?4,?5,'imported',?6,?6)"#,
            params![new_id(), folder, name, species, look.to_string(), now + i as i64],
        );
        if r.is_ok() {
            created += 1;
        }
    }
    R::json(json!({ "ok": true, "created": created }))
}

fn registry_patch(c: &Connection, id: &str, b: &Map<String, Value>, folder: bool) -> R {
    if folder {
        let name = Some(s(b.get("name"), 24)).filter(|x| !x.is_empty()).unwrap_or_else(|| "folder".into());
        return match c.execute(r#"UPDATE "PetFolder" SET "name"=?1 WHERE "id"=?2"#, params![name, id]) {
            Ok(1) => R::json(json!({ "id": id, "name": name })),
            _ => R::status(400, json!({ "ok": false, "error": "Record to update not found." })),
        };
    }
    let exists = c.query_row(r#"SELECT 1 FROM "PetBlueprint" WHERE "id"=?1"#, params![id], |_| Ok(())).optional().ok().flatten().is_some();
    if !exists {
        return R::status(400, json!({ "ok": false, "error": "Record to update not found." }));
    }
    let now = now_ms();
    if let Some(n) = str_of(b.get("name")).map(|x| take(x.trim(), 24)).filter(|x| !x.is_empty()) {
        let _ = c.execute(r#"UPDATE "PetBlueprint" SET "name"=?1 WHERE "id"=?2"#, params![n, id]);
    }
    match b.get("folderId") {
        Some(Value::Null) => {
            let _ = c.execute(r#"UPDATE "PetBlueprint" SET "folderId"=NULL WHERE "id"=?1"#, params![id]);
        }
        Some(Value::String(f)) => {
            let f = if f.is_empty() { None } else { Some(f.clone()) };
            let _ = c.execute(r#"UPDATE "PetBlueprint" SET "folderId"=?1 WHERE "id"=?2"#, params![f, id]);
        }
        _ => {}
    }
    if let Some(l @ Value::Object(_)) = b.get("look") {
        let _ = c.execute(r#"UPDATE "PetBlueprint" SET "look"=?1 WHERE "id"=?2"#, params![l.to_string(), id]);
    }
    let _ = c.execute(r#"UPDATE "PetBlueprint" SET "updatedAt"=?1 WHERE "id"=?2"#, params![now, id]);
    R::json(c.query_row(r#"SELECT * FROM "PetBlueprint" WHERE "id"=?1"#, params![id], blueprint_row).unwrap_or(Value::Null))
}

fn registry_delete(c: &Connection, id: &str, folder: bool) -> R {
    if folder {
        let in_use: i64 = c.query_row(r#"SELECT COUNT(*) FROM "PetBlueprint" WHERE "folderId"=?1"#, params![id], |r| r.get(0)).unwrap_or(0);
        if in_use > 0 {
            return R::status(409, json!({ "ok": false, "error": format!("{in_use} pet(s) still in this folder") }));
        }
        return match c.execute(r#"DELETE FROM "PetFolder" WHERE "id"=?1"#, params![id]) {
            Ok(1) => R::ok(),
            _ => R::status(400, json!({ "ok": false, "error": "Record to delete does not exist." })),
        };
    }
    match c.execute(r#"DELETE FROM "PetBlueprint" WHERE "id"=?1"#, params![id]) {
        Ok(1) => R::ok(),
        _ => R::status(400, json!({ "ok": false, "error": "Record to delete does not exist." })),
    }
}

// ============================================================== share

const MAX_SHARE: usize = 400_000;

fn load_share(c: &Connection, id: &str) -> Option<Value> {
    setting_get(c, &format!("share:{id}")).and_then(|v| serde_json::from_str::<Value>(&v).ok()).filter(|v| v.get("id").map(|x| x.is_string()).unwrap_or(false))
}

fn all_shares(c: &Connection) -> Vec<Value> {
    query_vec(c, r#"SELECT "value" FROM "Setting" WHERE "id" LIKE 'share:%'"#, [], |r| Ok(Value::String(r.get(0)?)))
        .into_iter()
        .filter_map(|v| serde_json::from_str::<Value>(v.as_str().unwrap_or("")).ok())
        .filter(|v| v.get("id").map(|x| x.is_string()).unwrap_or(false))
        .collect()
}

fn save_share(c: &Connection, rec: &Value) -> Result<(), String> {
    let v = rec.to_string();
    if v.len() > MAX_SHARE {
        return Err("too-large".into());
    }
    setting_put(c, &format!("share:{}", rec["id"].as_str().unwrap_or("")), &v)
}

fn revoked_stub(s: &Value) -> Value {
    json!({ "id": s["id"], "noteId": s["noteId"], "noteTitle": s.get("noteTitle").cloned().unwrap_or(json!("Note")), "mode": s["mode"],
        "createdAt": s["createdAt"], "views": s.get("views").cloned().unwrap_or(json!(0)), "revoked": true, "items": [], "content": "",
        "updatedAt": s.get("updatedAt").cloned().unwrap_or(s.get("createdAt").cloned().unwrap_or(json!(0))), "folderColor": null })
}

pub fn share_get(c: &Connection, q: &HashMap<String, String>) -> R {
    if let Some(sid) = q.get("shareId") {
        if !is_word_id(sid, 6, 64, &[]) {
            return R::err(400, "bad shareId");
        }
        let Some(mut rec) = load_share(c, sid) else {
            return R::err(404, "Share not found");
        };
        if rec.get("revoked").and_then(|x| x.as_bool()).unwrap_or(false) {
            return R::json(revoked_stub(&rec));
        }
        if q.get("countView").map(|x| x == "1").unwrap_or(false) {
            rec["views"] = json!(rec.get("views").and_then(|x| x.as_i64()).unwrap_or(0) + 1);
            let _ = save_share(c, &rec);
        }
        return R::json(rec);
    }
    let note = q.get("noteId").cloned();
    let mut list: Vec<Value> = all_shares(c)
        .into_iter()
        .filter(|s| s.get("createdAt").map(|x| x.is_number()).unwrap_or(false) && note.as_ref().map(|n| s["noteId"].as_str() == Some(n)).unwrap_or(true))
        .collect();
    list.sort_by_key(|s| -s["createdAt"].as_i64().unwrap_or(0));
    R::json(Value::Array(list))
}

pub fn share_create(c: &Connection, b: &Map<String, Value>) -> R {
    let note_id = str_of(b.get("noteId")).unwrap_or("");
    let mode = str_of(b.get("mode")).filter(|m| ["read", "collab"].contains(m)).unwrap_or("");
    if note_id.is_empty() {
        return R::err(400, "noteId required");
    }
    if mode.is_empty() {
        return R::err(400, "mode must be 'read' or 'collab'");
    }
    let note = c
        .query_row(
            r#"SELECT n."title", n."content", n."cover", f."color" FROM "Note" n LEFT JOIN "Folder" f ON f."id" = n."folderId" WHERE n."id"=?1"#,
            params![note_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, Option<String>>(3)?)),
        )
        .optional()
        .ok()
        .flatten();
    let Some((title, content, cover, color)) = note else {
        return R::err(404, "Note not found");
    };
    let now = now_ms();
    if let Some(mut existing) = all_shares(c).into_iter().find(|s| s["noteId"].as_str() == Some(note_id) && s["mode"].as_str() == Some(mode) && !s.get("revoked").and_then(|x| x.as_bool()).unwrap_or(false)) {
        existing["noteTitle"] = json!(title);
        existing["content"] = json!(content);
        existing["folderColor"] = json!(color);
        existing["cover"] = json!(cover);
        existing["updatedAt"] = json!(now);
        if !existing.get("items").map(|x| x.is_array()).unwrap_or(false) {
            existing["items"] = json!([]);
        }
        return match save_share(c, &existing) {
            Ok(_) => R::json(existing),
            Err(_) => R::err(413, "Note too large to share (400KB cap)"),
        };
    }
    let rec = json!({ "id": new_id(), "noteId": note_id, "noteTitle": title, "mode": mode, "createdAt": now, "items": todo_items(&content),
        "views": 0, "content": content, "updatedAt": now, "folderColor": color, "cover": cover });
    match save_share(c, &rec) {
        Ok(_) => R::json(rec),
        Err(_) => R::err(413, "Note too large to share (400KB cap)"),
    }
}

pub fn share_patch(c: &Connection, b: &Map<String, Value>) -> R {
    let sid = str_of(b.get("shareId")).unwrap_or("");
    let idx = b.get("index").and_then(|x| x.as_f64()).filter(|f| f.fract() == 0.0);
    let (true, Some(idx)) = (!sid.is_empty(), idx) else {
        return R::err(400, "shareId and index required");
    };
    let Some(mut rec) = load_share(c, sid) else {
        return R::err(404, "Share not found");
    };
    if rec.get("revoked").and_then(|x| x.as_bool()).unwrap_or(false) {
        return R::err(410, "This share link was revoked");
    }
    if rec["mode"].as_str() != Some("collab") {
        return R::err(403, "Read-only share — the owner did not allow editing");
    }
    let len = rec.get("items").and_then(|x| x.as_array()).map(|a| a.len()).unwrap_or(0);
    if idx < 0.0 || idx as usize >= len {
        return R::err(400, "Item index out of range");
    }
    let done = b.get("done").map(|v| match v {
        Value::Bool(x) => *x,
        Value::Null => false,
        Value::Number(n) => n.as_f64().unwrap_or(0.0) != 0.0,
        Value::String(x) => !x.is_empty(),
        _ => true,
    }).unwrap_or(false);
    let by = Some(s(b.get("by"), 40)).filter(|x| !x.is_empty() && b.get("by").map(|v| v.is_string()).unwrap_or(false)).unwrap_or_else(|| "Worker".into());
    let now = now_ms();
    let item = &mut rec["items"][idx as usize];
    item["done"] = json!(done);
    item["doneBy"] = if done { json!(by) } else { Value::Null };
    item["doneAt"] = if done { json!(now) } else { Value::Null };
    rec["updatedAt"] = json!(now);
    let _ = save_share(c, &rec);
    R::json(rec)
}

pub fn share_revoke(c: &Connection, sid: &str) -> R {
    if sid.is_empty() {
        return R::err(400, "shareId required");
    }
    let Some(mut rec) = load_share(c, sid) else {
        return R::err(404, "Share not found");
    };
    rec["revoked"] = json!(true);
    rec["updatedAt"] = json!(now_ms());
    let _ = save_share(c, &rec);
    R::json(rec)
}

// ============================================================== AI glue

async fn ai_chat(ctx: &Ctx, b: &Map<String, Value>) -> R {
    let msgs: Vec<ChatMsg> = match b.get("messages") {
        Some(v) => serde_json::from_value(v.clone()).unwrap_or_default(),
        None => vec![],
    };
    if msgs.is_empty() {
        return R::err(400, "messages required");
    }
    let cfg: AiConfig = ctx.ai.config(&ctx.db);
    if !cfg.is_usable() {
        return R::json(json!({ "ok": false, "content": null, "reason": "not-configured" }));
    }
    match ctx.ai.chat(&cfg, &msgs).await {
        Ok(text) => R::json(json!({ "ok": true, "content": text, "model": cfg.model, "provider": cfg.provider })),
        Err(e) => R::json(json!({ "ok": false, "content": null, "reason": e })),
    }
}

fn req_json(req: &ApiRequest) -> Value {
    req.body.clone().unwrap_or(Value::Null)
}

/// Test a provider. With a body (`{provider, baseUrl?, model?, apiKey?}`) the draft settings are
/// tested without saving (onboarding / Settings "Test connection"); without one, the saved config.
async fn ai_test(ctx: &Ctx, req: &ApiRequest) -> R {
    let cfg = match ctx.ai.draft_config(&ctx.db, &req_json(req)) {
        Ok(c) => c,
        Err(e) => return R::json(json!({ "ok": false, "error": e })),
    };
    if !cfg.is_usable() {
        return R::json(json!({ "ok": false, "error": "Pick a provider and model (and an API key for cloud providers) first." }));
    }
    let t0 = std::time::Instant::now();
    let msgs = vec![ChatMsg { role: "user".into(), content: "Reply with exactly: pong".into() }];
    match ctx.ai.chat(&cfg, &msgs).await {
        Ok(t) => R::json(json!({ "ok": true, "reply": take(&t, 200), "ms": t0.elapsed().as_millis() as u64, "model": cfg.model })),
        Err(e) => R::json(json!({ "ok": false, "error": e })),
    }
}

/// Model picker: `{provider, baseUrl?, apiKey?}` → `{ ok, models }` (Ollama: installed models).
async fn ai_models(ctx: &Ctx, req: &ApiRequest) -> R {
    let cfg = match ctx.ai.draft_config(&ctx.db, &req_json(req)) {
        Ok(c) => c,
        Err(e) => return R::json(json!({ "ok": false, "error": e, "models": [] })),
    };
    match ctx.ai.list_models(&cfg).await {
        Ok(m) => R::json(json!({ "ok": true, "models": m, "provider": cfg.provider })),
        Err(e) => R::json(json!({ "ok": false, "error": e, "models": [], "provider": cfg.provider })),
    }
}

async fn agent_exec(ctx: &Ctx, b: &Map<String, Value>) -> R {
    let calls: Vec<Value> = match b.get("calls") {
        Some(Value::Array(a)) => a.clone(),
        _ => vec![],
    };
    let (trace, feedback) = agent::execute_tools(&ctx.db, &calls).await;
    R::json(json!({ "trace": trace, "feedback": feedback }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::{AiState, MemoryKeyStore};

    fn ctx() -> Ctx {
        Ctx::new(Db::open_in_memory().unwrap(), Arc::new(AiState::new(Box::new(MemoryKeyStore::default()))))
    }

    async fn call(ctx: &Ctx, m: &str, url: &str, body: Option<Value>) -> (u16, Value) {
        let r = handle(ctx, ApiRequest::new(m, url, body)).await;
        let v = match r.body {
            Body::Json(v) => v,
            Body::Bytes { data, .. } => json!({ "bytes": data.len() }),
            _ => Value::Null,
        };
        (r.status, v)
    }

    #[tokio::test]
    async fn notes_crud_roundtrip() {
        let c = ctx();
        let (_, list) = call(&c, "GET", "/api/notes", None).await;
        assert_eq!(list.as_array().unwrap().len(), 14);
        let (_, n) = call(&c, "POST", "/api/notes", Some(json!({ "id": "n-test", "title": "Hello", "content": "# Hello #tag", "tags": ["a", 3, "b"] }))).await;
        assert_eq!(n["id"], "n-test");
        assert_eq!(n["tags"], json!(["a", "b"]));
        let (_, _) = call(&c, "PATCH", "/api/notes/n-test", Some(json!({ "title": "Renamed", "pinned": true, "folderId": "f-guides", "cover": null }))).await;
        let (_, list) = call(&c, "GET", "/api/notes", None).await;
        let first = &list[0];
        assert_eq!(first["id"], "n-test");
        assert_eq!(first["title"], "Renamed");
        assert_eq!(first["pinned"], true);
        assert_eq!(first["folderId"], "f-guides");
        call(&c, "DELETE", "/api/notes/n-test", None).await;
        let (_, list) = call(&c, "GET", "/api/notes", None).await;
        assert_eq!(list.as_array().unwrap().len(), 14);
        // invalid id falls back to a uuid
        let (_, n) = call(&c, "POST", "/api/notes", Some(json!({ "id": "bad id!", "title": "x" }))).await;
        assert_eq!(n["id"].as_str().unwrap().len(), 36);
    }

    #[tokio::test]
    async fn attachments_roundtrip() {
        let c = ctx();
        let (st, a) = call(&c, "POST", "/api/notes/n-welcome/attachments", Some(json!({ "name": "hi.txt", "mime": "text/plain", "size": 2, "dataB64": "aGk=" }))).await;
        assert_eq!(st, 201);
        let id = a["id"].as_str().unwrap().to_string();
        let (_, l) = call(&c, "GET", "/api/notes/n-welcome/attachments", None).await;
        assert_eq!(l.as_array().unwrap().len(), 1);
        let r = handle(&c, ApiRequest::new("GET", &format!("/api/attachments/{id}"), None)).await;
        match r.body {
            Body::Bytes { data, mime, .. } => {
                assert_eq!(data, b"hi");
                assert_eq!(mime, "text/plain");
            }
            _ => panic!("expected bytes"),
        }
        let (st, _) = call(&c, "POST", "/api/notes/nope/attachments", Some(json!({ "name": "x", "dataB64": "" }))).await;
        assert_eq!(st, 404);
        let (st, _) = call(&c, "POST", "/api/notes/n-welcome/attachments", Some(json!({ "name": "x" }))).await;
        assert_eq!(st, 400);
    }

    #[tokio::test]
    async fn folders_and_canvases() {
        let c = ctx();
        let (_, f) = call(&c, "POST", "/api/folders", Some(json!({ "id": "f-new", "name": "New", "position": 9 }))).await;
        assert_eq!(f["id"], "f-new");
        call(&c, "PATCH", "/api/folders/f-new", Some(json!({ "name": "Renamed", "color": "#fff" }))).await;
        let (_, l) = call(&c, "GET", "/api/folders", None).await;
        assert_eq!(l.as_array().unwrap().last().unwrap()["name"], "Renamed");
        call(&c, "DELETE", "/api/folders/f-guides", None).await;
        let (_, notes) = call(&c, "GET", "/api/notes", None).await;
        assert!(notes.as_array().unwrap().iter().all(|n| n["folderId"] != "f-guides"));
        let (_, cv) = call(&c, "POST", "/api/canvases", Some(json!({ "name": "Board" }))).await;
        let id = cv["id"].as_str().unwrap();
        call(&c, "PATCH", &format!("/api/canvases/{id}"), Some(json!({ "data": { "nodes": [{ "id": "x" }], "edges": [] } }))).await;
        let (_, boot) = call(&c, "GET", "/api/bootstrap", None).await;
        assert_eq!(boot["canvases"].as_array().unwrap().len(), 2);
        assert_eq!(boot["canvases"][1]["data"]["nodes"][0]["id"], "x");
        assert_eq!(boot["pet"]["name"], "Mochi");
        assert_eq!(boot["listings"].as_array().unwrap().len(), 17);
    }

    #[tokio::test]
    async fn tasks_lifecycle() {
        let c = ctx();
        let (st, _) = call(&c, "POST", "/api/tasks", Some(json!({ "title": "  " }))).await;
        assert_eq!(st, 400);
        let (_, t) = call(&c, "POST", "/api/tasks", Some(json!({ "title": "Write", "list": "upcoming", "priority": 7, "due": 1_900_000_000_000i64, "by": "ai" }))).await;
        assert_eq!(t["priority"], 2);
        assert_eq!(t["due"], 1_900_000_000_000i64);
        assert_eq!(t["by"], "ai");
        let id = t["id"].as_str().unwrap();
        let (_, t2) = call(&c, "PATCH", &format!("/api/tasks/{id}"), Some(json!({ "done": true }))).await;
        assert!(t2["completedAt"].is_number());
        let (_, t3) = call(&c, "PATCH", &format!("/api/tasks/{id}"), Some(json!({ "done": false, "due": null }))).await;
        assert!(t3["completedAt"].is_null() && t3["due"].is_null());
        let (st, _) = call(&c, "PATCH", "/api/tasks/missing", Some(json!({}))).await;
        assert_eq!(st, 404);
    }

    #[tokio::test]
    async fn pet_put_clamps() {
        let c = ctx();
        call(&c, "PUT", "/api/pet", Some(json!({ "name": "  Bo  ", "species": "dragon", "food": 400, "coins": -5, "owned": ["none", "crown"], "stats": { "words": 5 } }))).await;
        let (_, p) = call(&c, "GET", "/api/pet", None).await;
        assert_eq!(p["name"], "Bo");
        assert_eq!(p["species"], "dragon");
        assert_eq!(p["food"], 100);
        assert_eq!(p["coins"], 0);
        assert_eq!(p["owned"], json!(["none", "crown"]));
        assert_eq!(p["stats"]["words"], 5);
        assert_eq!(p["tricks"], json!(["wave", "spin"]));
    }

    #[tokio::test]
    async fn market_buy_botbuy_reprice() {
        let c = ctx();
        let (st, r) = call(&c, "POST", "/api/listings/l-1", Some(json!({ "action": "buy" }))).await;
        assert_eq!(st, 200, "{r}");
        let (_, p) = call(&c, "GET", "/api/pet", None).await;
        assert_eq!(p["coins"], 120 - 9);
        let (st, _) = call(&c, "POST", "/api/listings/l-1", Some(json!({ "action": "buy" }))).await;
        assert_eq!(st, 409);
        let (st, _) = call(&c, "POST", "/api/listings/l-5", Some(json!({ "action": "buy" }))).await;
        assert_eq!(st, 402);
        let (_, mine) = call(&c, "POST", "/api/listings", Some(json!({ "kind": "hat", "itemId": "bow", "name": "Bow", "price": 20, "seller": "Mochi" }))).await;
        let mid = mine["id"].as_str().unwrap().to_string();
        let (_, rp) = call(&c, "POST", &format!("/api/listings/{mid}"), Some(json!({ "action": "reprice", "price": 15 }))).await;
        assert_eq!(rp["price"], 15);
        let (st, _) = call(&c, "POST", "/api/listings/l-2", Some(json!({ "action": "reprice", "price": 3 }))).await;
        assert_eq!(st, 403);
        let (_, bb) = call(&c, "POST", &format!("/api/listings/{mid}"), Some(json!({ "action": "botbuy", "buyer": "Robo" }))).await;
        assert_eq!(bb["earned"], 14);
        assert_eq!(bb["buyer"], "Robo");
        let (_, list) = call(&c, "GET", "/api/listings", None).await;
        let l = list.as_array().unwrap().iter().find(|l| l["id"] == mid.as_str()).unwrap().clone();
        let kinds: Vec<&str> = l["history"].as_array().unwrap().iter().map(|h| h["k"].as_str().unwrap()).collect();
        assert_eq!(kinds, vec!["list", "reprice", "sold"]);
    }

    #[tokio::test]
    async fn settings_backed_routes() {
        let c = ctx();
        let (_, r) = call(&c, "GET", "/api/rules", None).await;
        assert!(r["rules"].is_null());
        let (st, _) = call(&c, "PUT", "/api/rules", Some(json!({ "rules": 3 }))).await;
        assert_eq!(st, 400);
        call(&c, "PUT", "/api/rules", Some(json!({ "rules": { "shieldOn": true } }))).await;
        let (_, r) = call(&c, "GET", "/api/rules", None).await;
        assert_eq!(r["rules"]["shieldOn"], true);
        call(&c, "PUT", "/api/games", Some(json!({ "games": [{ "id": "g1" }] }))).await;
        let (_, g) = call(&c, "GET", "/api/games", None).await;
        assert_eq!(g[0]["id"], "g1");
        let (st, _) = call(&c, "POST", "/api/packs", Some(json!({ "id": "p1x", "kind": "nope" }))).await;
        assert_eq!(st, 400);
        call(&c, "POST", "/api/packs", Some(json!({ "id": "p1x", "kind": "icons", "createdAt": 1 }))).await;
        call(&c, "POST", "/api/packs", Some(json!({ "id": "p2x", "kind": "fonts", "createdAt": 2 }))).await;
        let (_, p) = call(&c, "GET", "/api/packs", None).await;
        assert_eq!(p[0]["id"], "p2x");
        call(&c, "DELETE", "/api/packs/p2x", None).await;
        let (_, p) = call(&c, "GET", "/api/packs/p1x", None).await;
        assert_eq!(p["kind"], "icons");
    }

    #[tokio::test]
    async fn bugs_and_activity() {
        let c = ctx();
        let (st, _) = call(&c, "POST", "/api/bugs", Some(json!({ "desc": "" }))).await;
        assert_eq!(st, 400);
        let (_, bug) = call(&c, "POST", "/api/bugs", Some(json!({ "desc": "broken", "severity": "blocker", "logs": "x" }))).await;
        let id = bug["id"].as_str().unwrap();
        let (st, _) = call(&c, "PATCH", &format!("/api/bugs/{id}"), Some(json!({ "status": "fixed" }))).await;
        assert_eq!(st, 200);
        let (_, l) = call(&c, "GET", "/api/bugs", None).await;
        assert_eq!(l[0]["status"], "fixed");
        call(&c, "POST", "/api/activity", Some(json!({ "entries": [{ "app": "Code", "secs": 60, "cat": "productive" }, { "app": "Code", "secs": 30, "src": "agent" }, { "app": "", "secs": 5 }] }))).await;
        call(&c, "POST", "/api/activity", Some(json!({ "entries": [{ "app": "Code", "secs": 15, "cat": "productive" }] }))).await;
        let (_, a) = call(&c, "GET", "/api/activity?days=7", None).await;
        assert_eq!(a.as_array().unwrap().len(), 1);
        assert_eq!(a[0]["secs"], 105);
        call(&c, "PATCH", "/api/activity", Some(json!({ "app": "Code", "cat": "distraction" }))).await;
        let (_, a) = call(&c, "GET", "/api/activity", None).await;
        assert_eq!(a[0]["cat"], "distraction");
    }

    #[tokio::test]
    async fn pet_registry_flow() {
        let c = ctx();
        let (_, reg) = call(&c, "GET", "/api/pet-registry", None).await;
        assert_eq!(reg["folders"].as_array().unwrap().len(), 12);
        let (_, f) = call(&c, "POST", "/api/pet-registry/folders", Some(json!({ "name": "mine" }))).await;
        assert_eq!(f["position"], 12);
        let (_, dup) = call(&c, "POST", "/api/pet-registry/folders", Some(json!({ "name": "mine" }))).await;
        assert_eq!(dup["id"], f["id"]);
        let (_, bp) = call(&c, "POST", "/api/pet-registry", Some(json!({ "name": "Zed", "species": "owl", "look": { "accent": "#123456", "ramp": ["#000", "red"] }, "folderId": f["id"] }))).await;
        assert_eq!(bp["look"]["ramp"], json!(["#000"]));
        let (st, _) = call(&c, "DELETE", &format!("/api/pet-registry/{}?type=folder", f["id"].as_str().unwrap()), None).await;
        assert_eq!(st, 409);
        let (_, imp) = call(&c, "POST", "/api/pet-registry/import", Some(json!({ "folders": [{ "name": "Pack" }], "pets": [{ "name": "A", "species": "fox", "folderName": "pack" }, { "name": "B", "species": "zzz" }] }))).await;
        assert_eq!(imp["created"], 2);
        let (_, reg) = call(&c, "GET", "/api/pet-registry", None).await;
        assert_eq!(reg["folders"].as_array().unwrap().len(), 14);
        assert_eq!(reg["blueprints"].as_array().unwrap().len(), 15);
    }

    #[tokio::test]
    async fn share_lifecycle() {
        let c = ctx();
        let (st, _) = call(&c, "POST", "/api/share", Some(json!({ "noteId": "n-welcome", "mode": "x" }))).await;
        assert_eq!(st, 400);
        let (_, s1) = call(&c, "POST", "/api/share", Some(json!({ "noteId": "n-welcome", "mode": "collab" }))).await;
        let sid = s1["id"].as_str().unwrap().to_string();
        assert_eq!(s1["items"].as_array().unwrap().len(), 5);
        let (_, again) = call(&c, "POST", "/api/share", Some(json!({ "noteId": "n-welcome", "mode": "collab" }))).await;
        assert_eq!(again["id"], sid.as_str());
        let (_, p) = call(&c, "PATCH", "/api/share", Some(json!({ "shareId": sid, "index": 1, "done": true, "by": "Sam" }))).await;
        assert_eq!(p["items"][1]["doneBy"], "Sam");
        let (st, _) = call(&c, "PATCH", "/api/share", Some(json!({ "shareId": sid, "index": 99, "done": true }))).await;
        assert_eq!(st, 400);
        let (_, v) = call(&c, "GET", &format!("/api/share?shareId={sid}&countView=1"), None).await;
        assert_eq!(v["views"], 1);
        call(&c, "DELETE", &format!("/api/share?shareId={sid}"), None).await;
        let (_, v) = call(&c, "GET", &format!("/api/share?shareId={sid}"), None).await;
        assert_eq!(v["revoked"], true);
        assert_eq!(v["content"], "");
        let (st, _) = call(&c, "PATCH", "/api/share", Some(json!({ "shareId": sid, "index": 0, "done": true }))).await;
        assert_eq!(st, 410);
        let (_, list) = call(&c, "GET", "/api/share?noteId=n-welcome", None).await;
        assert_eq!(list.as_array().unwrap().len(), 1);
        let (_, r) = call(&c, "POST", "/api/share", Some(json!({ "noteId": "n-welcome", "mode": "read" }))).await;
        let (st, _) = call(&c, "PATCH", "/api/share", Some(json!({ "shareId": r["id"], "index": 0, "done": true }))).await;
        assert_eq!(st, 403);
    }

    #[tokio::test]
    async fn unknown_route_404() {
        let c = ctx();
        let (st, _) = call(&c, "GET", "/api/nope", None).await;
        assert_eq!(st, 404);
        assert_eq!(pct_decode("a%20b+c%2F"), "a b c/");
    }

    #[tokio::test]
    async fn nested_folders_move_pin_and_delete_up() {
        let c = ctx();
        let (_, a) = call(&c, "POST", "/api/folders", Some(json!({ "name": "Projects", "color": "#e0a13d" }))).await;
        let a = a["id"].as_str().unwrap().to_string();
        let (_, b) = call(&c, "POST", "/api/folders", Some(json!({ "name": "Nook", "parentId": a }))).await;
        let b = b["id"].as_str().unwrap().to_string();
        let (_, list) = call(&c, "GET", "/api/folders", None).await;
        let nook = list.as_array().unwrap().iter().find(|f| f["id"] == b.as_str()).unwrap().clone();
        assert_eq!(nook["parentId"], a.as_str());
        assert_eq!(nook["pinned"], false);
        // can't move a folder into its own child
        let (st, _) = call(&c, "PATCH", &format!("/api/folders/{a}"), Some(json!({ "parentId": b }))).await;
        assert_eq!(st, 400);
        let (st, _) = call(&c, "PATCH", &format!("/api/folders/{b}"), Some(json!({ "pinned": true, "icon": "🚀", "position": 3, "parentId": null }))).await;
        assert_eq!(st, 200);
        let (_, list) = call(&c, "GET", "/api/folders", None).await;
        let nook = list.as_array().unwrap().iter().find(|f| f["id"] == b.as_str()).unwrap().clone();
        assert_eq!((nook["pinned"].clone(), nook["icon"].clone(), nook["position"].clone(), nook["parentId"].clone()), (json!(true), json!("🚀"), json!(3), Value::Null));
        // deleting a parent lifts its children + notes one level up
        call(&c, "PATCH", &format!("/api/folders/{b}"), Some(json!({ "parentId": a }))).await;
        let (_, n) = call(&c, "POST", "/api/notes", Some(json!({ "title": "In projects", "folderId": a }))).await;
        call(&c, "DELETE", &format!("/api/folders/{a}"), None).await;
        let (_, list) = call(&c, "GET", "/api/folders", None).await;
        assert_eq!(list.as_array().unwrap().iter().find(|f| f["id"] == b.as_str()).unwrap()["parentId"], Value::Null);
        let (_, notes) = call(&c, "GET", "/api/notes", None).await;
        let notes = notes.as_array().cloned().or_else(|| notes["notes"].as_array().cloned()).unwrap();
        let note = notes.iter().find(|x| x["id"] == n["id"]).unwrap();
        assert_eq!(note["folderId"], Value::Null);
    }
}
