//! `nook-mcp` — standalone stdio bridge for MCP clients (Claude Desktop, Cursor, VS Code…).
//! The desktop app ships the same bridge built in: `nook.exe --mcp-stdio`.
//! Usage: nook-mcp [--port 3000] [--token TOKEN] [--db PATH] [--direct]

#[tokio::main(flavor = "current_thread")]
async fn main() {
    nook_core::bridge::run_stdio(std::env::args().skip(1).collect()).await;
}
