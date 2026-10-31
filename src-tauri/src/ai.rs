//! Nook AI — talks to ANY OpenAI-compatible chat endpoint:
//!   OpenRouter · Z.ai (GLM) · OpenAI · Groq · Gemini (OpenAI mode) ·
//!   Ollama (local) · LM Studio (local) · any custom base URL.
//!
//! The user's API key never leaves this PC except to the provider they
//! chose. Streaming is done with SSE and forwarded to the UI through
//! `ai://chunk` / `ai://done` / `ai://error` events, so the interface never
//! blocks. Every stream can be aborted with `ai_stop`.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::{es, CmdResult};

// ---------------------------------------------------------------- state ----

pub struct AiState {
    /// requestId -> abort flag (set by ai_stop). Arc-shared with worker
    /// threads so the Tauri State itself never crosses a thread boundary.
    stops: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl AiState {
    pub fn new() -> Self {
        Self {
            stops: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn register_stop(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.stops
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id.to_string(), flag.clone());
        flag
    }

    fn unregister_stop(stops: &Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>, id: &str) {
        stops
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(id);
    }
}

// ---------------------------------------------------------------- http ----

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(180))
        .timeout_write(Duration::from_secs(30))
        .build()
}

fn clean_base(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

fn auth_headers(req: ureq::Request, api_key: &str) -> ureq::Request {
    let req = if api_key.trim().is_empty() {
        req
    } else {
        req.set("Authorization", &format!("Bearer {}", api_key.trim()))
    };
    req.set("X-Title", "NookNook")
}

/// Extracts a human-readable message from a ureq error (incl. provider body).
fn http_err_text(e: ureq::Error) -> String {
    if let ureq::Error::Status(_code, resp) = e {
        let body = resp
            .into_string()
            .unwrap_or_else(|_| String::from("response unreadable"));
        // try to surface the provider's own "error.message" field
        if let Ok(v) = serde_json::from_str::<Value>(&body) {
            let m = v["error"]["message"]
                .as_str()
                .or_else(|| v["error"].as_str())
                .or_else(|| v["message"].as_str())
                .unwrap_or("");
            if !m.is_empty() {
                return m.to_string();
            }
        }
        return format!("HTTP {}", body.chars().take(220).collect::<String>());
    }
    es(e)
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ChatEvent {
    id: String,
    delta: Option<String>,
    error: Option<String>,
}

fn emit_chunk(app: &AppHandle, id: &str, delta: Option<&str>, error: Option<String>) {
    let _ = app.emit(
        "ai://event",
        ChatEvent {
            id: id.to_string(),
            delta: delta.map(String::from),
            error,
        },
    );
}

// ------------------------------------------------------------- commands ----

/// Lists models from an OpenAI-compatible endpoint (GET /models).
/// Runs on a worker thread — the UI can never freeze while we wait on the
/// network (this was THE v0.7 "click and it gets stuck" bug).
#[tauri::command]
pub async fn ai_list_models(base_url: String, api_key: Option<String>) -> CmdResult<Vec<String>> {
    tauri::async_runtime::spawn_blocking(move || ai_list_models_blocking(base_url, api_key))
        .await
        .map_err(|e| es(e))?
}

fn ai_list_models_blocking(base_url: String, api_key: Option<String>) -> CmdResult<Vec<String>> {
    let base = clean_base(&base_url);
    let req = auth_headers(agent().get(&format!("{base}/models")), api_key.unwrap_or_default().as_str());
    let resp = req
        .call()
        .map_err(|e| format!("Could not reach {base}/models — {}", http_err_text(e)))?;
    let body: Value = resp.into_json().map_err(es)?;
    let mut models: Vec<String> = body["data"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| m["id"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    // newest / most capable first for OpenRouter-style long lists stays
    // untouched — just dedupe + sort alphabetically for a stable display
    models.sort();
    models.dedup();
    Ok(models)
}

/// One-shot completion (used for note summaries / action items / titles).
/// Worker thread — see ai_list_models.
#[tauri::command]
pub async fn ai_complete(
    base_url: String,
    api_key: Option<String>,
    model: String,
    messages: String,
) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        ai_complete_blocking(base_url, api_key, model, messages)
    })
    .await
    .map_err(|e| es(e))?
}

fn ai_complete_blocking(
    base_url: String,
    api_key: Option<String>,
    model: String,
    messages: String,
) -> CmdResult<String> {
    let base = clean_base(&base_url);
    let msgs: Value =
        serde_json::from_str(&messages).map_err(|e| format!("Bad messages payload: {e}"))?;
    let body = json!({ "model": model, "messages": msgs, "stream": false });
    let resp = auth_headers(
        agent().post(&format!("{base}/chat/completions")),
        api_key.unwrap_or_default().as_str(),
    )
    .send_json(body)
    .map_err(|e| format!("AI request failed — {}", http_err_text(e)))?;
    let v: Value = resp.into_json().map_err(es)?;
    let out = v["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string();
    if out.is_empty() {
        return Err("The model returned an empty response".into());
    }
    Ok(out)
}

/// Streaming chat — returns immediately, streams via `ai://event`.
/// Frontend listens for { id, delta, error } payloads.
#[tauri::command]
pub async fn ai_chat(
    app: AppHandle,
    state: State<'_, AiState>,
    request_id: String,
    base_url: String,
    api_key: Option<String>,
    model: String,
    messages: String,
    temperature: Option<f64>,
) -> CmdResult<()> {
    let base = clean_base(&base_url);
    let msgs: Value =
        serde_json::from_str(&messages).map_err(|e| format!("Bad messages payload: {e}"))?;
    let key = api_key.unwrap_or_default();
    let rid = request_id.clone();
    let abort = state.register_stop(&rid);
    let stops = state.stops.clone();

    std::thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            let mut body = json!({ "model": model, "messages": msgs, "stream": true });
            if let Some(t) = temperature {
                body["temperature"] = json!(t);
            }
            let req = auth_headers(
                agent().post(&format!("{base}/chat/completions")),
                key.as_str(),
            );

            // ---- try streaming first ----
            let resp = match req.clone().send_json(body.clone()) {
                Ok(r) => r,
                Err(_e) => {
                    // streaming rejected by the endpoint — fall back to one shot
                    body["stream"] = json!(false);
                    let resp2 = req.send_json(body).map_err(|e2| http_err_text(e2))?;
                    let v: Value = resp2.into_json().map_err(es)?;
                    let text = v["choices"][0]["message"]["content"]
                        .as_str()
                        .unwrap_or("")
                        .to_string();
                    if !text.is_empty() {
                        emit_chunk(&app, &rid, Some(&text), None);
                    }
                    return Ok(());
                }
            };

            let reader = resp.into_reader();
            let mut lines = BufReader::new(reader).lines();
            while let Some(line) = lines.next() {
                if abort.load(Ordering::Relaxed) {
                    return Ok(()); // user pressed stop
                }
                let line = match line {
                    Ok(l) => l,
                    Err(e) => return Err(es(e)),
                };
                let line = line.trim().to_string();
                if line.is_empty() || line.starts_with(':') {
                    continue; // SSE comment / keep-alive
                }
                let Some(data) = line.strip_prefix("data:") else {
                    continue;
                };
                let data = data.trim();
                if data == "[DONE]" {
                    return Ok(());
                }
                let Ok(v) = serde_json::from_str::<Value>(data) else {
                    continue;
                };
                if let Some(errmsg) = v["error"]["message"].as_str() {
                    return Err(errmsg.to_string());
                }
                if let Some(delta) = v["choices"][0]["delta"]["content"].as_str() {
                    if !delta.is_empty() {
                        emit_chunk(&app, &rid, Some(delta), None);
                    }
                }
            }
            Ok(())
        })();

        AiState::unregister_stop(&stops, &rid);
        match result {
            Ok(()) => emit_chunk(&app, &rid, None, None), // delta=None + no error = done
            Err(e) => emit_chunk(&app, &rid, None, Some(e)),
        }
    });

    Ok(())
}

/// Aborts a running stream.
#[tauri::command]
pub fn ai_stop(state: State<'_, AiState>, request_id: String) -> CmdResult<()> {
    if let Some(flag) = state
        .stops
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&request_id)
    {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// Quick connectivity + key check used by Settings → "Test connection".
/// Worker thread — see ai_list_models.
#[tauri::command]
pub async fn ai_test(base_url: String, api_key: Option<String>, model: String) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || ai_test_blocking(base_url, api_key, model))
        .await
        .map_err(|e| es(e))?
}

fn ai_test_blocking(base_url: String, api_key: Option<String>, model: String) -> CmdResult<String> {
    let base = clean_base(&base_url);
    let body = json!({
        "model": model,
        "messages": [{ "role": "user", "content": "Reply with exactly: OK" }],
        "max_tokens": 200,
        "stream": false
    });
    let resp = auth_headers(
        agent().post(&format!("{base}/chat/completions")),
        api_key.unwrap_or_default().as_str(),
    )
    .send_json(body)
    .map_err(|e| format!("Connection failed — {}", http_err_text(e)))?;
    let v: Value = resp.into_json().map_err(es)?;
    let out = v["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    if out.is_empty() {
        Err("The model replied with nothing — check the model name".into())
    } else {
        Ok(format!("Connected — model replied: {}", out.chars().take(60).collect::<String>()))
    }
}
