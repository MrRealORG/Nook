//! Nook AI — talks to a LOCAL Ollama server (http://127.0.0.1:11434) the
//! user runs themselves. Nothing is bundled, nothing leaves the PC, and if
//! Ollama isn't running the app stays 100% usable without it.

use serde_json::json;
use std::time::Duration;

use crate::{es, CmdResult};

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(3))
        .timeout_read(Duration::from_secs(600))
        .timeout_write(Duration::from_secs(30))
        .build()
}

fn clean_base(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

#[tauri::command]
pub fn ai_models(url: String) -> CmdResult<Vec<String>> {
    let base = clean_base(&url);
    let resp = agent()
        .get(&format!("{base}/api/tags"))
        .call()
        .map_err(|e| format!("Could not reach Ollama at {base} — is it running? ({e})"))?;
    let body: serde_json::Value = resp.into_json().map_err(es)?;
    Ok(body["models"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| m["name"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default())
}

#[tauri::command]
pub fn ai_generate(
    url: String,
    model: String,
    prompt: String,
    system: Option<String>,
) -> CmdResult<String> {
    let base = clean_base(&url);
    let mut body = json!({ "model": model, "prompt": prompt, "stream": false });
    if let Some(sys) = system {
        body["system"] = json!(sys);
    }
    let resp = agent()
        .post(&format!("{base}/api/generate"))
        .send_json(body)
        .map_err(|e| format!("Ollama request failed: {e}"))?;
    let body: serde_json::Value = resp.into_json().map_err(es)?;
    Ok(body["response"].as_str().unwrap_or("").to_string())
}
