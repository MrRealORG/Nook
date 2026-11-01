//! OpenAI-compatible chat client (replaces the cloud-only `z-ai-web-dev-sdk`).
//!
//! Works with OpenAI, OpenRouter, Groq, Gemini's OpenAI endpoint, Ollama, LM Studio or any
//! custom base URL. Non-secret config lives in the `Setting` table (`ai-config`), API keys
//! go through a [`KeyStore`] — the desktop app plugs in the OS keyring.

use crate::db::Db;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
}

/// Secret storage for provider API keys.
pub trait KeyStore: Send + Sync {
    fn get(&self, provider: &str) -> Option<String>;
    fn set(&self, provider: &str, key: Option<&str>) -> Result<(), String>;
}

/// In-memory key store (tests, dev server). Optionally seeded from `NOOK_AI_KEY`.
#[derive(Default)]
pub struct MemoryKeyStore(Mutex<HashMap<String, String>>);

impl KeyStore for MemoryKeyStore {
    fn get(&self, provider: &str) -> Option<String> {
        let m = self.0.lock().ok()?;
        m.get(provider).cloned().or_else(|| std::env::var("NOOK_AI_KEY").ok().filter(|k| !k.is_empty()))
    }
    fn set(&self, provider: &str, key: Option<&str>) -> Result<(), String> {
        let mut m = self.0.lock().map_err(|e| e.to_string())?;
        match key {
            Some(k) if !k.is_empty() => {
                m.insert(provider.into(), k.into());
            }
            _ => {
                m.remove(provider);
            }
        }
        Ok(())
    }
}

pub struct Preset {
    pub id: &'static str,
    pub name: &'static str,
    pub base_url: &'static str,
    pub model: &'static str,
    pub needs_key: bool,
    pub key_url: &'static str,
    /// suggested (free-tier where the provider has one) models for the model picker
    pub models: &'static [&'static str],
}

pub const PRESETS: &[Preset] = &[
    Preset { id: "openai", name: "OpenAI", base_url: "https://api.openai.com/v1", model: "gpt-4o-mini", needs_key: true, key_url: "https://platform.openai.com/api-keys", models: &["gpt-4o-mini", "gpt-4.1-mini", "gpt-4o"] },
    Preset { id: "openrouter", name: "OpenRouter", base_url: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini", needs_key: true, key_url: "https://openrouter.ai/keys", models: &["openai/gpt-4o-mini", "meta-llama/llama-3.3-70b-instruct:free", "google/gemini-2.0-flash-exp:free", "deepseek/deepseek-chat-v3-0324:free"] },
    Preset { id: "groq", name: "Groq", base_url: "https://api.groq.com/openai/v1", model: "llama-3.1-8b-instant", needs_key: true, key_url: "https://console.groq.com/keys", models: &["llama-3.1-8b-instant", "llama-3.3-70b-versatile"] },
    // v1.4: Gemini 1.5 models are retired (404 "model not found") — 2.5 Flash is the default
    Preset { id: "gemini", name: "Google Gemini", base_url: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash", needs_key: true, key_url: "https://aistudio.google.com/apikey", models: &["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash", "gemini-2.5-pro"] },
    Preset { id: "glm", name: "GLM / Zhipu (bigmodel.cn)", base_url: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash", needs_key: true, key_url: "https://open.bigmodel.cn/usercenter/apikeys", models: &["glm-4-flash", "glm-4-flash-250414", "glm-4.5-flash", "glm-4-air", "glm-4-plus"] },
    Preset { id: "zai", name: "GLM / Z.ai (international)", base_url: "https://api.z.ai/api/paas/v4", model: "glm-4.5-flash", needs_key: true, key_url: "https://z.ai/manage-apikey/apikey-list", models: &["glm-4.5-flash", "glm-4-flash", "glm-4.5-air", "glm-4.5"] },
    Preset { id: "ollama", name: "Ollama (local)", base_url: "http://localhost:11434/v1", model: "llama3.2", needs_key: false, key_url: "https://ollama.com/download", models: &[] },
    Preset { id: "lmstudio", name: "LM Studio (local)", base_url: "http://127.0.0.1:1234/v1", model: "local-model", needs_key: false, key_url: "https://lmstudio.ai", models: &[] },
    Preset { id: "custom", name: "Custom (OpenAI-compatible)", base_url: "", model: "", needs_key: false, key_url: "", models: &[] },
];

pub fn preset(id: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.id == id)
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    /// "local" (offline heuristics only) or a preset id
    pub provider: String,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub temperature: Option<f64>,
    /// resolved at call time from the key store — never persisted in SQLite
    #[serde(skip)]
    pub api_key: Option<String>,
}

impl AiConfig {
    pub fn is_usable(&self) -> bool {
        if self.provider.is_empty() || self.provider == "local" || self.base_url.trim().is_empty() || self.model.trim().is_empty() {
            return false;
        }
        let needs_key = preset(&self.provider).map(|p| p.needs_key).unwrap_or(false);
        !needs_key || self.api_key.as_deref().map(|k| !k.is_empty()).unwrap_or(false)
    }
    fn endpoint(&self) -> String {
        format!("{}/chat/completions", self.base_url.trim().trim_end_matches('/'))
    }
}

pub struct AiState {
    keys: Box<dyn KeyStore>,
    client: reqwest::Client,
    /// loopback providers (Ollama, LM Studio) must never go through a system proxy
    local_client: reqwest::Client,
}

pub fn is_loopback_url(url: &str) -> bool {
    let host = url.split("://").nth(1).unwrap_or("").split('/').next().unwrap_or("");
    let host = host.rsplit_once(':').map(|(h, p)| if p.chars().all(|c| c.is_ascii_digit()) { h } else { host }).unwrap_or(host);
    matches!(host, "127.0.0.1" | "localhost" | "[::1]" | "0.0.0.0") || host.ends_with(".localhost")
}

impl AiState {
    pub fn new(keys: Box<dyn KeyStore>) -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .user_agent(concat!("Nook/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default();
        let local_client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .no_proxy()
            .user_agent(concat!("Nook/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default();
        AiState { keys, client, local_client }
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.client
    }

    /// v1.4: the stored key for a provider (meeting speech-to-text reuses the AI keys).
    pub fn key_for(&self, provider: &str) -> Option<String> {
        self.keys.get(provider).filter(|k| !k.is_empty())
    }

    /// Effective config (with key resolved).
    pub fn config(&self, db: &Db) -> AiConfig {
        let mut cfg: AiConfig = db
            .setting_get("ai-config")
            .and_then(|v| serde_json::from_str(&v).ok())
            .unwrap_or_else(|| AiConfig { provider: "local".into(), ..Default::default() });
        if let Some(p) = preset(&cfg.provider) {
            if cfg.base_url.trim().is_empty() {
                cfg.base_url = p.base_url.into();
            }
            if cfg.model.trim().is_empty() {
                cfg.model = p.model.into();
            }
        }
        cfg.api_key = self.keys.get(&cfg.provider);
        cfg
    }

    /// Config for the Settings screen: never leaks the key, only whether one is stored.
    pub fn public_config(&self, db: &Db) -> Value {
        let cfg = self.config(db);
        let presets: Vec<Value> = PRESETS
            .iter()
            .map(|p| json!({ "id": p.id, "name": p.name, "baseUrl": p.base_url, "model": p.model, "needsKey": p.needs_key, "keyUrl": p.key_url, "models": p.models, "hasKey": self.keys.get(p.id).is_some() }))
            .collect();
        json!({
            "provider": cfg.provider,
            "baseUrl": cfg.base_url,
            "model": cfg.model,
            "temperature": cfg.temperature,
            "hasKey": cfg.api_key.is_some(),
            "usable": cfg.is_usable(),
            "presets": presets,
        })
    }

    /// Save config. Body: { provider, baseUrl?, model?, temperature?, apiKey? (""=delete) }
    pub fn save_config(&self, db: &Db, b: &Value) -> Result<Value, String> {
        let provider = b.get("provider").and_then(|v| v.as_str()).unwrap_or("local").to_string();
        if provider != "local" && preset(&provider).is_none() {
            return Err(format!("unknown provider: {provider}"));
        }
        let base_url = b.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if !base_url.is_empty() && !(base_url.starts_with("http://") || base_url.starts_with("https://")) {
            return Err("base URL must start with http:// or https://".into());
        }
        let cfg = AiConfig {
            provider: provider.clone(),
            base_url,
            model: b.get("model").and_then(|v| v.as_str()).unwrap_or("").trim().to_string(),
            temperature: b.get("temperature").and_then(|v| v.as_f64()).map(|t| t.clamp(0.0, 2.0)),
            api_key: None,
        };
        if let Some(k) = b.get("apiKey").and_then(|v| v.as_str()) {
            self.keys.set(&provider, Some(k.trim()).filter(|k| !k.is_empty()))?;
        }
        db.setting_put("ai-config", &serde_json::to_string(&cfg).map_err(|e| e.to_string())?)?;
        Ok(self.public_config(db))
    }

    /// A not-yet-saved config from a request body (`{ provider, baseUrl?, model?, apiKey? }`) —
    /// used by "Test connection" / the model picker in onboarding and Settings ▸ AI. Missing
    /// fields fall back to the preset, a missing key to the stored one. Never persisted.
    pub fn draft_config(&self, db: &Db, b: &Value) -> Result<AiConfig, String> {
        let Some(provider) = b.get("provider").and_then(|v| v.as_str()) else {
            return Ok(self.config(db));
        };
        let p = preset(provider).ok_or_else(|| format!("unknown provider: {provider}"))?;
        let s = |k: &str| b.get(k).and_then(|v| v.as_str()).map(str::trim).filter(|v| !v.is_empty()).map(String::from);
        let base_url = s("baseUrl").unwrap_or_else(|| p.base_url.to_string());
        if !(base_url.starts_with("http://") || base_url.starts_with("https://")) {
            return Err("base URL must start with http:// or https://".into());
        }
        Ok(AiConfig {
            provider: provider.into(),
            base_url,
            model: s("model").unwrap_or_else(|| p.model.to_string()),
            temperature: None,
            api_key: s("apiKey").or_else(|| self.keys.get(provider)),
        })
    }

    /// Installed / available models. Ollama: `GET <root>/api/tags`; everything else: the
    /// OpenAI-compatible `GET <base>/models`, falling back to the preset's suggested list.
    pub async fn list_models(&self, cfg: &AiConfig) -> Result<Vec<String>, String> {
        let base = cfg.base_url.trim().trim_end_matches('/');
        let local = is_loopback_url(base);
        let http = if local { &self.local_client } else { &self.client };
        if cfg.provider == "ollama" {
            let root = base.strip_suffix("/v1").unwrap_or(base);
            let res = http.get(format!("{root}/api/tags")).timeout(Duration::from_secs(5)).send().await.map_err(|e| format!("Ollama isn't reachable at {root} — is it running? ({e})"))?;
            if !res.status().is_success() {
                return Err(format!("Ollama answered HTTP {}", res.status().as_u16()));
            }
            let v: Value = res.json().await.map_err(|e| format!("bad JSON from Ollama: {e}"))?;
            return Ok(parse_ollama_tags(&v));
        }
        let fallback = || preset(&cfg.provider).map(|p| p.models.iter().map(|m| m.to_string()).collect::<Vec<_>>()).unwrap_or_default();
        let mut rq = http.get(format!("{base}/models")).timeout(Duration::from_secs(8));
        if let Some(k) = cfg.api_key.as_deref().filter(|k| !k.is_empty()) {
            rq = rq.bearer_auth(k);
        }
        match rq.send().await {
            Ok(r) if r.status().is_success() => {
                let v: Value = r.json().await.unwrap_or(Value::Null);
                let mut ids: Vec<String> = v["data"].as_array().map(|a| a.iter().filter_map(|m| m["id"].as_str()).map(|id| id.trim_start_matches("models/").to_string()).collect()).unwrap_or_default();
                if ids.is_empty() {
                    return Ok(fallback());
                }
                // suggested (free) models first, then the rest
                let pref = fallback();
                ids.sort_by_key(|id| pref.iter().position(|p| p == id).unwrap_or(usize::MAX));
                ids.dedup();
                Ok(ids)
            }
            Ok(r) if r.status().as_u16() == 401 || r.status().as_u16() == 403 => Err(format!("HTTP {}: the API key was rejected", r.status().as_u16())),
            _ => Ok(fallback()),
        }
    }

    fn request(&self, cfg: &AiConfig, msgs: &[ChatMsg], stream: bool) -> reqwest::RequestBuilder {
        let local = is_loopback_url(&cfg.base_url);
        let mut body = json!({ "model": cfg.model, "messages": msgs, "stream": stream });
        if let Some(t) = cfg.temperature {
            body["temperature"] = json!(t);
        }
        // v1.4: GLM 4.5+ "think" for many seconds before the first token by default — for chat,
        // notes and the agent's JSON tool calls that only adds latency
        if matches!(cfg.provider.as_str(), "glm" | "zai") && (cfg.model.starts_with("glm-4.5") || cfg.model.starts_with("glm-4.6") || cfg.model.starts_with("glm-4.7")) {
            body["thinking"] = json!({ "type": "disabled" });
        }
        let mut rq = if local { &self.local_client } else { &self.client }
            .post(cfg.endpoint())
            .timeout(Duration::from_secs(if local { 300 } else { 120 }))
            .json(&body);
        if let Some(k) = cfg.api_key.as_deref().filter(|k| !k.is_empty()) {
            rq = rq.bearer_auth(k);
        }
        if cfg.provider == "openrouter" {
            rq = rq.header("HTTP-Referer", "https://github.com/MrRealORG/Nook").header("X-Title", "Nook");
        }
        rq
    }

    /// Send with one retry on a transient failure (network, 429, 5xx) — free tiers rate-limit a lot.
    async fn send_retry(&self, cfg: &AiConfig, msgs: &[ChatMsg], stream: bool) -> Result<reqwest::Response, String> {
        let mut last = String::new();
        for attempt in 0..2 {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_millis(1200)).await;
            }
            match self.request(cfg, msgs, stream).send().await {
                Ok(r) if r.status().as_u16() == 429 || r.status().is_server_error() => {
                    let code = r.status().as_u16();
                    let body = r.text().await.unwrap_or_default();
                    last = friendly_error(cfg, code, &error_message(&body));
                }
                Ok(r) if !r.status().is_success() => {
                    let code = r.status().as_u16();
                    let body = r.text().await.unwrap_or_default();
                    return Err(friendly_error(cfg, code, &error_message(&body)));
                }
                Ok(r) => return Ok(r),
                Err(e) => last = network_error(cfg, &e),
            }
        }
        Err(last)
    }

    /// One-shot completion → assistant text.
    pub async fn chat(&self, cfg: &AiConfig, msgs: &[ChatMsg]) -> Result<String, String> {
        let res = self.send_retry(cfg, msgs, false).await?;
        let text = res.text().await.map_err(|e| e.to_string())?;
        let v: Value = serde_json::from_str(&text).map_err(|e| format!("bad JSON from provider: {e}"))?;
        let content = v["choices"][0]["message"]["content"].as_str().unwrap_or("").trim().to_string();
        if content.is_empty() {
            return Err("empty completion".into());
        }
        Ok(content)
    }

    /// Streaming completion (SSE). Calls `on_delta` for every token chunk, returns the full text.
    pub async fn chat_stream<F: FnMut(&str) + Send>(&self, cfg: &AiConfig, msgs: &[ChatMsg], mut on_delta: F) -> Result<String, String> {
        let res = self.send_retry(cfg, msgs, true).await?;
        let mut full = String::new();
        // v1.4: a BYTE buffer split on '\n' — 1.3 decoded every network chunk on its own, so a
        // multi-byte character (Urdu, emoji) cut across two chunks turned into "\u{FFFD}" garbage
        let mut buf: Vec<u8> = Vec::new();
        let mut stream = res.bytes_stream();
        let mut done = false;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| if full.is_empty() { format!("network: {e}") } else { format!("the stream was cut off: {e}") })?;
            buf.extend_from_slice(&chunk);
            while let Some(nl) = buf.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = buf.drain(..=nl).collect();
                let line = String::from_utf8_lossy(&line);
                if let Some(delta) = parse_sse_line(line.trim_end_matches(['\r', '\n']), &mut done) {
                    full.push_str(&delta);
                    on_delta(&delta);
                }
            }
            if done {
                break;
            }
        }
        if !done && !buf.is_empty() {
            let rest = String::from_utf8_lossy(&buf).to_string();
            if let Some(delta) = parse_sse_line(rest.trim(), &mut done) {
                full.push_str(&delta);
                on_delta(&delta);
            }
        }
        if full.trim().is_empty() {
            return Err("empty completion".into());
        }
        Ok(full)
    }
}

/// `{"models":[{"name":"llama3.2:latest",…}]}` → model names (Ollama `/api/tags`).
pub fn parse_ollama_tags(v: &Value) -> Vec<String> {
    v["models"].as_array().map(|a| a.iter().filter_map(|m| m["name"].as_str().or(m["model"].as_str())).map(String::from).collect()).unwrap_or_default()
}

/// Parse one SSE line of an OpenAI-style stream into a content delta.
pub fn parse_sse_line(line: &str, done: &mut bool) -> Option<String> {
    let data = line.strip_prefix("data:")?.trim();
    if data == "[DONE]" {
        *done = true;
        return None;
    }
    let v: Value = serde_json::from_str(data).ok()?;
    let d = v["choices"][0]["delta"]["content"].as_str().or_else(|| v["choices"][0]["message"]["content"].as_str())?;
    if d.is_empty() {
        None
    } else {
        Some(d.to_string())
    }
}

/// A provider error the user can act on.
pub fn friendly_error(cfg: &AiConfig, code: u16, msg: &str) -> String {
    let who = preset(&cfg.provider).map(|p| p.name).unwrap_or("the AI provider");
    let hint = match code {
        400 if msg.to_lowercase().contains("api key") => format!("{who} rejected the API key — check it in Settings → AI."),
        401 | 403 => format!("{who} rejected the API key — check it in Settings → AI."),
        404 => format!("{who} doesn't know the model \"{}\" — pick another model in Settings → AI.", cfg.model),
        429 => format!("{who} is rate-limiting or the free quota is used up — wait a minute or switch model."),
        500..=599 => format!("{who} is having trouble right now (HTTP {code}) — try again shortly."),
        _ => format!("{who} answered HTTP {code}."),
    };
    if msg.is_empty() {
        hint
    } else {
        format!("{hint} ({})", crate::util::take(msg, 180))
    }
}

fn network_error(cfg: &AiConfig, e: &reqwest::Error) -> String {
    if is_loopback_url(&cfg.base_url) {
        format!("Can't reach {} at {} — is it running?", preset(&cfg.provider).map(|p| p.name).unwrap_or("the local model server"), cfg.base_url)
    } else if e.is_timeout() {
        "The AI provider took too long to answer — try again.".into()
    } else {
        format!("Can't reach the AI provider — check your internet connection. ({e})")
    }
}

fn error_message(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().or(v["error"].as_str()).or(v["message"].as_str()).map(String::from))
        .unwrap_or_else(|| crate::util::take(body.trim(), 200))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::post, Json, Router};

    /// Mock OpenAI-compatible server: echoes the last user message, supports SSE streaming
    /// and checks the bearer token.
    async fn mock_server() -> String {
        async fn handler(headers: axum::http::HeaderMap, Json(b): Json<Value>) -> axum::response::Response {
            use axum::response::IntoResponse;
            if headers.get("authorization").and_then(|h| h.to_str().ok()) != Some("Bearer sk-test") {
                return (axum::http::StatusCode::UNAUTHORIZED, Json(json!({ "error": { "message": "bad key" } }))).into_response();
            }
            let last = b["messages"].as_array().and_then(|a| a.last()).and_then(|m| m["content"].as_str()).unwrap_or("").to_string();
            let reply = format!("echo: {last}");
            if b["stream"].as_bool().unwrap_or(false) {
                let mut sse = String::new();
                for w in reply.split_inclusive(' ') {
                    sse.push_str(&format!("data: {}\n\n", json!({ "choices": [{ "delta": { "content": w } }] })));
                }
                sse.push_str("data: [DONE]\n\n");
                return ([("content-type", "text/event-stream")], sse).into_response();
            }
            Json(json!({ "choices": [{ "message": { "role": "assistant", "content": reply } }], "model": b["model"] })).into_response()
        }
        let app = Router::new().route("/v1/chat/completions", post(handler));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}/v1")
    }

    fn state() -> (AiState, Db) {
        (AiState::new(Box::new(MemoryKeyStore::default())), Db::open_in_memory().unwrap())
    }

    #[tokio::test]
    async fn config_roundtrip_hides_key() {
        let (ai, db) = state();
        assert_eq!(ai.config(&db).provider, "local");
        assert!(!ai.config(&db).is_usable());
        let v = ai.save_config(&db, &json!({ "provider": "groq", "apiKey": "gsk_123" })).unwrap();
        assert_eq!(v["hasKey"], true);
        assert_eq!(v["baseUrl"], "https://api.groq.com/openai/v1");
        assert!(!v.to_string().contains("gsk_123"));
        assert!(ai.config(&db).is_usable());
        assert!(db.setting_get("ai-config").unwrap().find("gsk_123").is_none());
        assert!(ai.save_config(&db, &json!({ "provider": "evil" })).is_err());
        assert!(ai.save_config(&db, &json!({ "provider": "custom", "baseUrl": "ftp://x" })).is_err());
        // local providers need no key
        ai.save_config(&db, &json!({ "provider": "ollama" })).unwrap();
        assert!(ai.config(&db).is_usable());
    }

    #[tokio::test]
    async fn chat_against_mock_provider() {
        let base = mock_server().await;
        let (ai, db) = state();
        ai.save_config(&db, &json!({ "provider": "custom", "baseUrl": base, "model": "mock-1", "apiKey": "sk-test" })).unwrap();
        let cfg = ai.config(&db);
        let msgs = vec![ChatMsg { role: "system".into(), content: "be nice".into() }, ChatMsg { role: "user".into(), content: "hello there".into() }];
        assert_eq!(ai.chat(&cfg, &msgs).await.unwrap(), "echo: hello there");
        let mut parts = vec![];
        let full = ai.chat_stream(&cfg, &msgs, |d| parts.push(d.to_string())).await.unwrap();
        assert_eq!(full, "echo: hello there");
        assert!(parts.len() >= 3, "streamed in chunks: {parts:?}");
        // wrong key → readable error
        ai.save_config(&db, &json!({ "provider": "custom", "baseUrl": base, "model": "mock-1", "apiKey": "nope" })).unwrap();
        let err = ai.chat(&ai.config(&db), &msgs).await.unwrap_err();
        assert!(err.contains("rejected the API key") && err.contains("bad key"), "{err}");
    }

    #[test]
    fn friendly_errors_and_utf8_safe_streams() {
        let cfg = AiConfig { provider: "gemini".into(), base_url: "https://x".into(), model: "gemini-1.5-flash".into(), ..Default::default() };
        assert!(friendly_error(&cfg, 404, "models/gemini-1.5-flash is not found").contains("doesn't know the model \"gemini-1.5-flash\""));
        assert!(friendly_error(&cfg, 429, "").contains("rate-limiting"));
        assert!(friendly_error(&cfg, 401, "").starts_with("Google Gemini rejected the API key"));
        // an Urdu delta split across two network chunks must come out whole
        let line = "data: {\"choices\":[{\"delta\":{\"content\":\"سلام\"}}]}\n".as_bytes().to_vec();
        let (a, b) = line.split_at(45);
        let mut buf: Vec<u8> = vec![];
        let mut out = String::new();
        let mut done = false;
        for chunk in [a, b] {
            buf.extend_from_slice(chunk);
            while let Some(nl) = buf.iter().position(|x| *x == b'\n') {
                let l: Vec<u8> = buf.drain(..=nl).collect();
                if let Some(d) = parse_sse_line(String::from_utf8_lossy(&l).trim_end(), &mut done) {
                    out.push_str(&d);
                }
            }
        }
        assert_eq!(out, "سلام");
    }

    #[test]
    fn loopback_detection() {
        assert!(is_loopback_url("http://127.0.0.1:11434/v1"));
        assert!(is_loopback_url("http://localhost/v1"));
        assert!(!is_loopback_url("https://api.openai.com/v1"));
    }

    #[test]
    fn sse_parsing() {
        let mut done = false;
        assert_eq!(parse_sse_line(r#"data: {"choices":[{"delta":{"content":"hi"}}]}"#, &mut done).as_deref(), Some("hi"));
        assert_eq!(parse_sse_line(": keepalive", &mut done), None);
        assert_eq!(parse_sse_line("data: [DONE]", &mut done), None);
        assert!(done);
    }

    #[tokio::test]
    async fn ollama_tags_gemini_glm_drafts_and_streaming() {
        use axum::routing::get;
        // a fake Ollama: /api/tags lists installed models, /v1/chat/completions streams
        async fn tags() -> Json<Value> {
            Json(json!({ "models": [{ "name": "llama3.2:latest", "size": 1 }, { "name": "qwen2.5:0.5b" }] }))
        }
        async fn chat(Json(b): Json<Value>) -> axum::response::Response {
            use axum::response::IntoResponse;
            assert_eq!(b["model"], "qwen2.5:0.5b");
            if b["stream"].as_bool().unwrap_or(false) {
                let sse = format!("data: {}\n\ndata: {}\n\ndata: [DONE]\n\n", json!({ "choices": [{ "delta": { "content": "po" } }] }), json!({ "choices": [{ "delta": { "content": "ng" } }] }));
                return ([("content-type", "text/event-stream")], sse).into_response();
            }
            Json(json!({ "choices": [{ "message": { "content": "pong" } }] })).into_response()
        }
        let app = Router::new().route("/api/tags", get(tags)).route("/v1/chat/completions", post(chat));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let db = Db::open_in_memory().unwrap();
        let ai = AiState::new(Box::new(MemoryKeyStore::default()));
        let base = format!("http://localhost:{}/v1", addr.port());
        let cfg = ai.draft_config(&db, &json!({ "provider": "ollama", "baseUrl": base, "model": "qwen2.5:0.5b" })).unwrap();
        assert!(cfg.is_usable(), "ollama needs no key");
        assert_eq!(ai.list_models(&cfg).await.unwrap(), vec!["llama3.2:latest".to_string(), "qwen2.5:0.5b".into()]);
        assert_eq!(ai.chat(&cfg, &[ChatMsg { role: "user".into(), content: "ping".into() }]).await.unwrap(), "pong");
        let mut parts = vec![];
        ai.chat_stream(&cfg, &[ChatMsg { role: "user".into(), content: "ping".into() }], |d| parts.push(d.to_string())).await.unwrap();
        assert_eq!(parts, vec!["po", "ng"]);
        // ollama down → a readable hint
        let down = ai.draft_config(&db, &json!({ "provider": "ollama", "baseUrl": "http://127.0.0.1:9/v1" })).unwrap();
        assert!(ai.list_models(&down).await.unwrap_err().contains("is it running"));
        // drafts: presets fill gaps, a stored key is reused, nothing is saved
        let g = ai.draft_config(&db, &json!({ "provider": "gemini" })).unwrap();
        assert_eq!(g.model, "gemini-2.5-flash");
        assert!(g.base_url.contains("generativelanguage.googleapis.com"));
        assert!(!g.is_usable(), "gemini needs a key");
        ai.save_config(&db, &json!({ "provider": "glm", "apiKey": "zk-1" })).unwrap();
        let z = ai.draft_config(&db, &json!({ "provider": "glm" })).unwrap();
        assert_eq!((z.model.as_str(), z.base_url.as_str(), z.api_key.as_deref()), ("glm-4-flash", "https://open.bigmodel.cn/api/paas/v4", Some("zk-1")));
        assert_eq!(ai.draft_config(&db, &json!({ "provider": "zai" })).unwrap().base_url, "https://api.z.ai/api/paas/v4");
        assert!(ai.draft_config(&db, &json!({ "provider": "evil" })).is_err());
        let pc = ai.public_config(&db);
        let gem = pc["presets"].as_array().unwrap().iter().find(|p| p["id"] == "gemini").unwrap();
        assert!(gem["models"].as_array().unwrap().iter().any(|m| m == "gemini-2.5-flash-lite"));
        assert!(!pc.to_string().contains("zk-1"), "keys never leave the key store");
        assert_eq!(parse_ollama_tags(&json!({})), Vec::<String>::new());
    }
}
