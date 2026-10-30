//! Dev/test server: serves the FULL `/api/*` router over HTTP so the SPA can run in a normal
//! browser (`npm run dev`) and Playwright can drive it without a webview.
//!   cargo run -p nook-core --bin nook-dev-api -- [--port 3210] [--db ./dev.db]

use nook_core::ai::{AiState, MemoryKeyStore};
use nook_core::server::{start, ServerOpts};
use nook_core::{Ctx, Db};
use std::sync::Arc;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let get = |flag: &str| args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned();
    let port: u16 = get("--port").and_then(|p| p.parse().ok()).unwrap_or(3210);
    let db = match get("--db") {
        Some(p) if p == ":memory:" => Db::open_in_memory(),
        Some(p) => Db::open(std::path::Path::new(&p)),
        None => Db::open_in_memory(),
    }
    .expect("open db");
    let ctx = Ctx::new(db, Arc::new(AiState::new(Box::new(MemoryKeyStore::default()))));
    let h = start(ctx, ServerOpts { host: "127.0.0.1".into(), port, full_api: true, any_origin: true }).await.expect("start server");
    println!("nook-dev-api listening on http://{}", h.addr);
    tokio::signal::ctrl_c().await.ok();
    h.stop().await;
}
