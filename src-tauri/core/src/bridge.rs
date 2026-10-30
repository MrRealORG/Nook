//! stdio bridge for MCP clients that speak stdio (Claude Desktop, Cursor, VS Code…).
//!
//! Reads newline-delimited JSON-RPC from stdin and answers on stdout.
//! * If the Nook app is running, requests are proxied to its local server
//!   (http://127.0.0.1:<port>/mcp, bearer token from `--token` / `NOOK_MCP_TOKEN`).
//! * If it is not, the bridge opens the vault database directly (WAL mode, safe to share),
//!   so agents keep working while the app is closed.
//!
//! Usage: nook-mcp [--port 3000] [--token TOKEN] [--db PATH] [--direct]

use crate::{mcp, Db};
use serde_json::Value;
use std::path::PathBuf;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub const APP_IDENTIFIER: &str = "com.realhackers.nook";

pub fn default_db() -> PathBuf {
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support")).unwrap_or_else(|| PathBuf::from("."))
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
            .unwrap_or_else(|| PathBuf::from("."))
    };
    base.join(APP_IDENTIFIER).join("nook.db")
}

/// The MCP port the desktop app was configured with (Settings → Desktop), if any.
fn configured_port(db: &std::path::Path) -> Option<u16> {
    if !db.exists() {
        return None;
    }
    let conn = rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let raw: String = conn.query_row(r#"SELECT "value" FROM "Setting" WHERE "id"='desktop'"#, [], |r| r.get(0)).ok()?;
    serde_json::from_str::<Value>(&raw).ok()?.get("mcpPort")?.as_u64().map(|p| p as u16)
}

/// Run the stdio bridge until stdin closes. `args` are the CLI arguments (flags only).
pub async fn run_stdio(args: Vec<String>) {
    let get = |flag: &str| args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        eprintln!("nook-mcp [--port 3000] [--token TOKEN] [--db PATH] [--direct]\nDefault db: {}", default_db().display());
        return;
    }
    let port: u16 = get("--port")
        .or_else(|| std::env::var("NOOK_MCP_PORT").ok())
        .and_then(|p| p.parse().ok())
        .or_else(|| configured_port(&get("--db").map(PathBuf::from).unwrap_or_else(default_db)))
        .unwrap_or(mcp::DEFAULT_PORT);
    let token = get("--token").or_else(|| std::env::var("NOOK_MCP_TOKEN").ok()).filter(|t| !t.is_empty());
    let force_direct = args.iter().any(|a| a == "--direct");
    let url = format!("http://127.0.0.1:{port}/mcp");
    let client = reqwest::Client::builder().no_proxy().timeout(std::time::Duration::from_secs(60)).build().expect("http client");
    let mut direct: Option<Db> = None;

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut out = tokio::io::stdout();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parsed: Option<Value> = serde_json::from_str(line).ok();
        let mut reply: Option<Value> = None;
        let mut proxied = false;
        if !force_direct {
            let mut rq = client.post(&url).header("content-type", "application/json").header("accept", "application/json").body(line.to_string());
            if let Some(t) = &token {
                rq = rq.bearer_auth(t);
            }
            if let Ok(r) = rq.send().await {
                proxied = true;
                let text = r.text().await.unwrap_or_default();
                if !text.trim().is_empty() {
                    reply = serde_json::from_str(&text).ok();
                }
            }
        }
        if !proxied {
            if direct.is_none() {
                let path = get("--db").map(PathBuf::from).unwrap_or_else(default_db);
                match Db::open(&path) {
                    Ok(db) => direct = Some(db),
                    Err(e) => {
                        let id = parsed.as_ref().and_then(|v| v.get("id").cloned()).unwrap_or(Value::Null);
                        reply = Some(mcp::rpc_err(&id, -32603, &format!("Nook is not running and the vault could not be opened at {}: {e}", path.display())));
                    }
                }
            }
            if let Some(db) = &direct {
                // direct mode runs as the local user — the bearer token guards network callers only
                reply = mcp::handle_local(db, parsed).1;
            }
        }
        if let Some(r) = reply {
            let mut s = r.to_string();
            s.push('\n');
            if out.write_all(s.as_bytes()).await.is_err() {
                break;
            }
            let _ = out.flush().await;
        }
    }
}
