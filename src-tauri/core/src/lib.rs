//! nook-core — everything that runs behind the Nook UI, without any webview dependency:
//! the SQLite vault, the API router (1:1 with the original Next.js routes), the
//! OpenAI-compatible AI client, the agent tool harness, the MCP server and the team room.

pub mod agent;
pub mod ai;
pub mod bridge;
pub mod api;
pub mod db;
pub mod ext;
pub mod timelens;
pub mod tlapps;
pub mod sites;
pub mod shield;
pub mod mcp;
pub mod server;
pub mod team;
pub mod util;

pub use api::{handle, ApiRequest, ApiResponse, Body, Ctx};
pub use db::Db;
