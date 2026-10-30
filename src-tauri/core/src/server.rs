//! Local HTTP server (axum) — runs inside the desktop app on 127.0.0.1:<port> (default 3000).
//!
//! * `/mcp` (and `/api/mcp` alias): MCP over JSON-RPC 2.0, streamable-HTTP compatible
//! * `/team`: WebSocket team room
//! * `/share/<id>` + `/share-api`: public reader for shared notes / work orders (LAN)
//! * `/api/*`: the full API — only when `full_api` is on (dev server / browser testing)

use crate::api::{self, ApiRequest, Body as ApiBody, Ctx};
use crate::mcp;
use crate::team::TeamRoom;
use axum::body::{Body, Bytes};
use axum::extract::{ws::WebSocketUpgrade, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::Router;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::oneshot;

#[derive(Clone, Debug)]
pub struct ServerOpts {
    pub host: String,
    pub port: u16,
    /// expose every `/api/*` route (dev/testing only — never on in the desktop build)
    pub full_api: bool,
    /// allow browser pages from any Origin (off: only localhost/tauri origins, DNS-rebinding guard)
    pub any_origin: bool,
}

impl Default for ServerOpts {
    fn default() -> Self {
        ServerOpts { host: "127.0.0.1".into(), port: mcp::DEFAULT_PORT, full_api: false, any_origin: false }
    }
}

#[derive(Clone)]
struct AppState {
    ctx: Ctx,
    team: TeamRoom,
    opts: ServerOpts,
}

pub struct ServerHandle {
    pub addr: SocketAddr,
    stop: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}

impl ServerHandle {
    pub fn port(&self) -> u16 {
        self.addr.port()
    }
    pub async fn stop(mut self) {
        if let Some(s) = self.stop.take() {
            let _ = s.send(());
        }
        let _ = self.task.await;
    }
}

const CORS_HEADERS: &[(&str, &str)] = &[
    ("access-control-allow-origin", "*"),
    ("access-control-allow-methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS"),
    ("access-control-allow-headers", "content-type, mcp-session-id, authorization, mcp-protocol-version, last-event-id"),
    ("access-control-expose-headers", "mcp-session-id"),
    ("access-control-max-age", "86400"),
];

fn with_cors(mut r: Response) -> Response {
    let h = r.headers_mut();
    for (k, v) in CORS_HEADERS {
        h.insert(*k, HeaderValue::from_static(v));
    }
    h.insert("cache-control", HeaderValue::from_static("no-store"));
    r
}

fn json_resp(status: u16, v: &Value) -> Response {
    with_cors((StatusCode::from_u16(status).unwrap_or(StatusCode::OK), [(header::CONTENT_TYPE, "application/json; charset=utf-8")], v.to_string()).into_response())
}

fn origin_ok(opts: &ServerOpts, headers: &HeaderMap) -> bool {
    if opts.any_origin {
        return true;
    }
    match headers.get(header::ORIGIN).and_then(|o| o.to_str().ok()) {
        None | Some("null") => true,
        Some(o) => {
            let host = o.split("://").nth(1).unwrap_or("").split(':').next().unwrap_or("").split('/').next().unwrap_or("");
            o.starts_with("tauri://") || matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "tauri.localhost") || host.ends_with(".localhost")
        }
    }
}

pub async fn start(ctx: Ctx, opts: ServerOpts) -> Result<ServerHandle, String> {
    let state = AppState { ctx, team: TeamRoom::new(), opts: opts.clone() };
    let mut app = Router::new()
        .route("/", get(root))
        .route("/health", get(|| async { with_cors(axum::Json(json!({ "ok": true, "app": "nook" })).into_response()) }))
        .route("/mcp", any(mcp_route))
        .route("/api/mcp", any(mcp_route))
        .route("/team", get(team_ws))
        .route("/share/{id}", get(share_page))
        .route("/share-api", any(share_api));
    if opts.full_api {
        app = app.route("/api/ai-stream", any(ai_stream)).route("/api/{*rest}", any(full_api));
    }
    let app = app.with_state(state);
    let addr: SocketAddr = format!("{}:{}", opts.host, opts.port).parse().map_err(|e| format!("bad address: {e}"))?;
    let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| format!("could not bind {addr}: {e}"))?;
    let addr = listener.local_addr().map_err(|e| e.to_string())?;
    let (tx, rx) = oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = rx.await;
            })
            .await;
    });
    log::info!("nook server listening on http://{addr}");
    Ok(ServerHandle { addr, stop: Some(tx), task })
}

async fn root(State(s): State<AppState>) -> Response {
    with_cors((StatusCode::OK, [(header::CONTENT_TYPE, "text/html; charset=utf-8")], mcp::info_html(s.opts.port)).into_response())
}

async fn mcp_route(State(s): State<AppState>, method: Method, headers: HeaderMap, body: Bytes) -> Response {
    if !origin_ok(&s.opts, &headers) {
        return json_resp(403, &mcp::rpc_err(&Value::Null, -32003, "Forbidden origin"));
    }
    let accept = headers.get(header::ACCEPT).and_then(|a| a.to_str().ok()).unwrap_or("").to_string();
    match method {
        Method::OPTIONS => with_cors(StatusCode::NO_CONTENT.into_response()),
        Method::GET => {
            if accept.contains("text/event-stream") && !accept.contains("text/html") {
                // no server-initiated stream: spec-compliant 405
                return with_cors((StatusCode::METHOD_NOT_ALLOWED, "SSE stream not offered; POST JSON-RPC messages to /mcp").into_response());
            }
            if accept.contains("text/html") {
                return with_cors((StatusCode::OK, [(header::CONTENT_TYPE, "text/html; charset=utf-8")], mcp::info_html(s.opts.port)).into_response());
            }
            json_resp(200, &mcp::server_info_json())
        }
        Method::DELETE => with_cors(StatusCode::OK.into_response()),
        Method::POST => {
            let parsed: Option<Value> = serde_json::from_slice(&body).ok();
            let is_init = parsed.as_ref().map(|v| v.get("method").and_then(|m| m.as_str()) == Some("initialize")).unwrap_or(false);
            let auth = headers.get(header::AUTHORIZATION).and_then(|a| a.to_str().ok()).map(String::from);
            let db = s.ctx.db.clone();
            let (status, out) = tokio::task::spawn_blocking(move || mcp::handle_http(&db, parsed, auth.as_deref())).await.unwrap_or((500, None));
            let mut resp = match out {
                None => with_cors(StatusCode::from_u16(status).unwrap_or(StatusCode::ACCEPTED).into_response()),
                Some(v) if accept.contains("text/event-stream") && !accept.contains("application/json") => with_cors(
                    (StatusCode::from_u16(status).unwrap_or(StatusCode::OK), [(header::CONTENT_TYPE, "text/event-stream")], format!("event: message\ndata: {v}\n\n")).into_response(),
                ),
                Some(v) => json_resp(status, &v),
            };
            if is_init {
                if let Ok(h) = HeaderValue::from_str(&crate::db::new_id()) {
                    resp.headers_mut().insert("mcp-session-id", h);
                }
            }
            resp
        }
        _ => with_cors(StatusCode::METHOD_NOT_ALLOWED.into_response()),
    }
}

async fn team_ws(State(s): State<AppState>, headers: HeaderMap, ws: WebSocketUpgrade) -> Response {
    let _ = headers;
    let room = s.team.clone();
    ws.on_upgrade(move |socket| room.handle_socket(socket))
}

async fn share_api(State(s): State<AppState>, method: Method, Query(q): Query<HashMap<String, String>>, body: Bytes) -> Response {
    let c = s.ctx.db.conn();
    let r = match method {
        Method::OPTIONS => return with_cors(StatusCode::NO_CONTENT.into_response()),
        Method::GET => {
            if !q.contains_key("shareId") {
                return json_resp(400, &json!({ "error": "shareId required" }));
            }
            api::share_get(&c, &q)
        }
        Method::PATCH => {
            let b: serde_json::Map<String, Value> = serde_json::from_slice(&body).unwrap_or_default();
            api::share_patch(&c, &b)
        }
        _ => return json_resp(405, &json!({ "error": "method not allowed" })),
    };
    json_resp(r.status, r.json_value().unwrap_or(&Value::Null))
}

async fn share_page(Path(id): Path<String>) -> Response {
    if !crate::util::is_word_id(&id, 6, 64, &[]) {
        return (StatusCode::BAD_REQUEST, "bad share id").into_response();
    }
    (StatusCode::OK, [(header::CONTENT_TYPE, "text/html; charset=utf-8")], SHARE_HTML.replace("__SHARE_ID__", &id)).into_response()
}

async fn full_api(State(s): State<AppState>, method: Method, uri: Uri, headers: HeaderMap, body: Bytes) -> Response {
    if !origin_ok(&s.opts, &headers) {
        return json_resp(403, &json!({ "error": "forbidden origin" }));
    }
    if method == Method::OPTIONS {
        return with_cors(StatusCode::NO_CONTENT.into_response());
    }
    let mut req = ApiRequest::new(method.as_str(), &uri.to_string(), if body.is_empty() { None } else { serde_json::from_slice(&body).ok() });
    req.path = uri.path().to_string();
    req.auth = headers.get(header::AUTHORIZATION).and_then(|a| a.to_str().ok()).map(String::from);
    let res = api::handle(&s.ctx, req).await;
    match res.body {
        ApiBody::Json(v) => json_resp(res.status, &v),
        ApiBody::Html(h) => with_cors((StatusCode::from_u16(res.status).unwrap_or(StatusCode::OK), [(header::CONTENT_TYPE, "text/html; charset=utf-8")], h).into_response()),
        ApiBody::Empty => with_cors(StatusCode::from_u16(res.status).unwrap_or(StatusCode::OK).into_response()),
        ApiBody::Bytes { mime, name, data } => {
            let mut r = Response::new(Body::from(data));
            *r.status_mut() = StatusCode::from_u16(res.status).unwrap_or(StatusCode::OK);
            if let Ok(v) = HeaderValue::from_str(&mime) {
                r.headers_mut().insert(header::CONTENT_TYPE, v);
            }
            if let Ok(v) = HeaderValue::from_str(&format!("inline; filename*=UTF-8''{}", pct_encode(&name))) {
                r.headers_mut().insert(header::CONTENT_DISPOSITION, v);
            }
            with_cors(r)
        }
    }
}

/// Dev-only SSE streaming endpoint mirroring the desktop `ai_stream` command.
async fn ai_stream(State(s): State<AppState>, body: Bytes) -> Response {
    let b: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let msgs: Vec<crate::ai::ChatMsg> = serde_json::from_value(b["messages"].clone()).unwrap_or_default();
    let cfg = s.ctx.ai.config(&s.ctx.db);
    if !cfg.is_usable() || msgs.is_empty() {
        return with_cors((StatusCode::OK, [(header::CONTENT_TYPE, "text/event-stream")], format!("data: {}\n\n", json!({ "type": "error", "error": "not-configured" }))).into_response());
    }
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Result<String, std::io::Error>>();
    let ai = s.ctx.ai.clone();
    tokio::spawn(async move {
        let tx2 = tx.clone();
        let r = ai.chat_stream(&cfg, &msgs, move |d| {
            let _ = tx2.send(Ok(format!("data: {}\n\n", json!({ "type": "delta", "text": d }))));
        }).await;
        let last = match r {
            Ok(full) => json!({ "type": "done", "text": full }),
            Err(e) => json!({ "type": "error", "error": e }),
        };
        let _ = tx.send(Ok(format!("data: {last}\n\n")));
    });
    let stream = tokio_stream_from(rx);
    let mut r = Response::new(Body::from_stream(stream));
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
    with_cors(r)
}

fn tokio_stream_from(mut rx: tokio::sync::mpsc::UnboundedReceiver<Result<String, std::io::Error>>) -> impl futures_util::Stream<Item = Result<String, std::io::Error>> {
    futures_util::stream::poll_fn(move |cx| rx.poll_recv(cx))
}

fn pct_encode(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

pub type SharedServer = Arc<tokio::sync::Mutex<Option<ServerHandle>>>;

const SHARE_HTML: &str = r##"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nook · shared note</title>
<style>body{background:#0d0e10;color:#e9ebee;font:15px/1.65 "Segoe UI",system-ui,sans-serif;margin:0;padding:28px 18px}main{max-width:760px;margin:0 auto;background:#1b1d21;border:1px solid #ffffff16;border-radius:16px;padding:26px 30px}
h1,h2,h3{line-height:1.25}h1{font-size:26px;margin:0 0 6px}.meta{color:#9aa0a8;font-size:12px;margin-bottom:18px}.chip{display:inline-block;border:1px solid #ffffff22;border-radius:99px;padding:1px 9px;margin-right:6px}
code{background:#ffffff10;padding:1px 5px;border-radius:5px}pre{background:#ffffff08;padding:12px;border-radius:10px;overflow:auto}blockquote{border-left:3px solid #9db7d0;margin:0;padding-left:12px;color:#9aa0a8}
.todo{display:flex;gap:10px;align-items:flex-start;padding:7px 10px;border-radius:10px;border:1px solid #ffffff12;margin:6px 0;cursor:pointer}.todo.done span{text-decoration:line-through;color:#9aa0a8}.todo small{color:#9db7d0;margin-left:auto;white-space:nowrap}
input#who{background:#0d0e10;border:1px solid #ffffff22;color:inherit;border-radius:8px;padding:6px 10px}.bar{height:6px;background:#ffffff12;border-radius:9px;overflow:hidden;margin:10px 0}.bar i{display:block;height:100%;background:#9db7d0}a{color:#9db7d0}</style></head>
<body><main id="app">Loading…</main><script>
const id="__SHARE_ID__";const esc=s=>s.replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const inline=s=>esc(s).replace(/`([^`]+)`/g,"<code>$1</code>").replace(/\*\*([^*]+)\*\*/g,"<b>$1</b>").replace(/\*([^*]+)\*/g,"<i>$1</i>").replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,(m,a,b)=>"<b>"+(b||a)+"</b>").replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g,'<a href="$2" target="_blank" rel="noreferrer">$1</a>');
function md(src){let out="",code=false;for(const l of src.split("\n")){if(l.startsWith("```")){out+=code?"</pre>":"<pre>";code=!code;continue}if(code){out+=esc(l)+"\n";continue}
let m;if(/^\s*[-*+]\s+\[[ xX]\]/.test(l))continue;if(m=/^(#{1,3})\s+(.*)/.exec(l)){out+=`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`}else if(m=/^\s*[-*+]\s+(.*)/.exec(l)){out+=`<li>${inline(m[1])}</li>`}else if(m=/^>\s?(.*)/.exec(l)){out+=`<blockquote>${inline(m[1])}</blockquote>`}else if(l.trim()){out+=`<p>${inline(l)}</p>`}}return out}
let rec=null;const who=()=>localStorage.getItem("nook:who")||"";
async function load(first){const r=await fetch("/share-api?shareId="+id+(first?"&countView=1":""));rec=await r.json();render()}
async function toggle(i){if(rec.mode!=="collab")return;const r=await fetch("/share-api",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({shareId:id,index:i,done:!rec.items[i].done,by:who()||"Worker"})});const j=await r.json();if(j.error){alert(j.error)}else{rec=j;render()}}
function render(){const a=document.getElementById("app");if(!rec||rec.error){a.innerHTML="<h1>Share not found</h1><p class=meta>The link may be wrong or expired.</p>";return}
if(rec.revoked){a.innerHTML=`<h1>${esc(rec.noteTitle||"Note")}</h1><p class=meta>This share link was revoked by its owner.</p>`;return}
const done=rec.items.filter(x=>x.done).length,n=rec.items.length;
a.innerHTML=`<h1>${esc(rec.noteTitle)}</h1><div class=meta><span class=chip>${rec.mode==="collab"?"work order":"read only"}</span>${rec.views} views · updated ${new Date(rec.updatedAt).toLocaleString()}</div>`+
(n?`<div class=meta>${done}/${n} done</div><div class=bar><i style="width:${n?done/n*100:0}%"></i></div>`:"")+
(rec.mode==="collab"?`<p>Your name: <input id=who value="${esc(who())}" placeholder="Worker" onchange="localStorage.setItem('nook:who',this.value)"></p>`:"")+
rec.items.map((t,i)=>`<div class="todo ${t.done?"done":""}" onclick="toggle(${i})">${t.done?"☑":"☐"} <span>${inline(t.text)}</span>${t.doneBy?`<small>${esc(t.doneBy)}</small>`:""}</div>`).join("")+md(rec.content||"")}
load(true);setInterval(()=>load(false),5000);
</script></body></html>"##;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::{AiState, MemoryKeyStore};
    use crate::db::Db;

    fn lc() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    async fn boot(full: bool) -> (ServerHandle, String, Ctx) {
        let ctx = Ctx::new(Db::open_in_memory().unwrap(), Arc::new(AiState::new(Box::new(MemoryKeyStore::default()))));
        let h = start(ctx.clone(), ServerOpts { port: 0, full_api: full, ..Default::default() }).await.unwrap();
        let base = format!("http://{}", h.addr);
        (h, base, ctx)
    }

    async fn post(base: &str, path: &str, body: Value, auth: Option<&str>) -> (u16, HeaderMap, String) {
        let mut rq = lc().post(format!("{base}{path}")).json(&body).header("accept", "application/json, text/event-stream");
        if let Some(a) = auth {
            rq = rq.header("authorization", a);
        }
        let r = rq.send().await.unwrap();
        let st = r.status().as_u16();
        let h = r.headers().clone();
        (st, h, r.text().await.unwrap())
    }

    #[tokio::test]
    async fn mcp_over_real_http() {
        let (h, base, ctx) = boot(false).await;
        let (st, hdr, body) = post(&base, "/mcp", json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": { "name": "test", "version": "1" } } }), None).await;
        assert_eq!(st, 200);
        assert!(hdr.get("mcp-session-id").is_some());
        assert_eq!(hdr.get("access-control-allow-origin").unwrap(), "*");
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["result"]["serverInfo"]["name"], mcp::SERVER_NAME);
        let (st, _, _) = post(&base, "/mcp", json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }), None).await;
        assert_eq!(st, 202);
        let (_, _, body) = post(&base, "/mcp", json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }), None).await;
        let v: Value = serde_json::from_str(&body).unwrap();
        let names: Vec<String> = v["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(names.len(), 16);
        // call every tool over HTTP
        let mut nid = String::from("n-welcome");
        let mut tid = String::new();
        for name in &names {
            let args = match name.as_str() {
                "create_task" => json!({ "title": "http task" }),
                "complete_task" | "update_task" | "delete_task" => json!({ "id": tid, "title": "edited" }),
                "write_note" => json!({ "title": "http note", "content": "x" }),
                "read_note" | "rename_note" | "append_note" | "delete_note" => json!({ "id": nid, "title": "renamed", "content": "y" }),
                _ => json!({}),
            };
            let (st, _, body) = post(&base, "/mcp", json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": name, "arguments": args } }), None).await;
            assert_eq!(st, 200, "{name}");
            let v: Value = serde_json::from_str(&body).unwrap();
            assert!(v["result"]["isError"].is_null(), "{name}: {body}");
            let inner: Value = serde_json::from_str(v["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
            if name == "create_task" {
                tid = inner["task"]["id"].as_str().unwrap().to_string();
            }
            if name == "write_note" {
                nid = inner["id"].as_str().unwrap().to_string();
                assert!(!nid.is_empty());
            }
        }
        // SSE response flavour for streamable-HTTP clients that only accept event streams
        let r = lc().post(format!("{base}/mcp")).header("accept", "text/event-stream").json(&json!({ "jsonrpc": "2.0", "id": 9, "method": "ping" })).send().await.unwrap();
        assert_eq!(r.headers().get("content-type").unwrap(), "text/event-stream");
        assert!(r.text().await.unwrap().starts_with("event: message\ndata: {"));
        // token auth — negative + positive
        mcp::set_token(&ctx.db.conn(), Some("tok-123")).unwrap();
        let (st, _, body) = post(&base, "/mcp", json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "server_info" } }), None).await;
        assert_eq!(st, 401, "{body}");
        let (st, _, _) = post(&base, "/mcp", json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "server_info" } }), Some("Bearer nope")).await;
        assert_eq!(st, 401);
        let (st, _, _) = post(&base, "/mcp", json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "server_info" } }), Some("Bearer tok-123")).await;
        assert_eq!(st, 200);
        // DNS-rebinding guard: foreign browser origins are refused
        let r = lc().post(format!("{base}/mcp")).header("origin", "https://evil.example").json(&json!({ "jsonrpc": "2.0", "id": 5, "method": "ping" })).send().await.unwrap();
        assert_eq!(r.status().as_u16(), 403);
        // preflight + info
        let r = lc().request(reqwest::Method::OPTIONS, format!("{base}/mcp")).send().await.unwrap();
        assert_eq!(r.status().as_u16(), 204);
        let info: Value = lc().get(format!("{base}/mcp")).send().await.unwrap().json().await.unwrap();
        assert_eq!(info["tools"].as_array().unwrap().len(), 16);
        // full API is NOT exposed in desktop mode
        assert_eq!(lc().get(format!("{base}/api/notes")).send().await.unwrap().status().as_u16(), 404);
        h.stop().await;
    }

    #[tokio::test]
    async fn full_api_and_share_reader() {
        let (h, base, _) = boot(true).await;
        let notes: Value = lc().get(format!("{base}/api/notes")).send().await.unwrap().json().await.unwrap();
        assert_eq!(notes.as_array().unwrap().len(), 14);
        let (_, _, body) = post(&base, "/api/share", json!({ "noteId": "n-ideas", "mode": "collab" }), None).await;
        let sh: Value = serde_json::from_str(&body).unwrap();
        let sid = sh["id"].as_str().unwrap();
        let page = lc().get(format!("{base}/share/{sid}")).send().await.unwrap().text().await.unwrap();
        assert!(page.contains(sid));
        let r = lc().patch(format!("{base}/share-api")).json(&json!({ "shareId": sid, "index": 0, "done": true, "by": "Worker Bee" })).send().await.unwrap();
        let v: Value = r.json().await.unwrap();
        assert_eq!(v["items"][0]["doneBy"], "Worker Bee");
        h.stop().await;
    }
}
