//! v1.4 — websites by DOMAIN, not by page title.
//!
//! 1.3 grouped browser time by the last " - " part of the tab title, so Discord
//! ("(1463) Discord | #general | Danger Zone"), X ("Home / X") or Hark ("Chat · Hark") each produced
//! dozens of rows with no domain (→ no favicon, letter tiles). Now:
//!
//! 1. the Windows sampler reads the real address from the browser's address bar (UI Automation,
//!    only when the tab title changes) → `host_of(url)`;
//! 2. otherwise the title is split on every separator browsers and sites use (` - `, ` | `, ` · `,
//!    ` — `, ` / `, ` – `, `: `) and each part is looked up in a table of well-known sites, or
//!    taken as a domain when it already looks like one (`docs.rs`, `github.com/...`).
//!
//! Site category overrides (`{domain: cat}`) live in the `timelens-site-cats` setting and are
//! applied as `field: "domain"` rules ahead of everything else, so changing a site's category
//! recomputes all history.

use crate::db::{setting_get, setting_put};
use rusqlite::Connection;
use serde_json::{json, Map, Value};

pub const SITE_CATS_KEY: &str = "timelens-site-cats";

/// Well-known sites: a lower-case name as it shows up in a tab title → domain.
const KNOWN: &[(&str, &str)] = &[
    ("youtube", "youtube.com"), ("youtube studio", "studio.youtube.com"), ("youtube music", "music.youtube.com"), ("github", "github.com"),
    ("gmail", "mail.google.com"), ("google", "google.com"), ("google search", "google.com"), ("google docs", "docs.google.com"),
    ("google sheets", "docs.google.com"), ("google slides", "docs.google.com"), ("google drive", "drive.google.com"), ("google calendar", "calendar.google.com"),
    ("google gemini", "gemini.google.com"), ("gemini", "gemini.google.com"), ("google ai studio", "aistudio.google.com"), ("google maps", "maps.google.com"),
    ("google translate", "translate.google.com"), ("google meet", "meet.google.com"), ("google keep", "keep.google.com"), ("google photos", "photos.google.com"),
    ("reddit", "reddit.com"), ("twitter", "x.com"), ("x", "x.com"), ("facebook", "facebook.com"), ("messenger", "messenger.com"), ("instagram", "instagram.com"),
    ("linkedin", "linkedin.com"), ("netflix", "netflix.com"), ("prime video", "primevideo.com"), ("twitch", "twitch.tv"), ("kick", "kick.com"), ("tiktok", "tiktok.com"),
    ("stack overflow", "stackoverflow.com"), ("wikipedia", "wikipedia.org"), ("chatgpt", "chatgpt.com"), ("claude", "claude.ai"), ("perplexity", "perplexity.ai"),
    ("deepseek", "chat.deepseek.com"), ("grok", "grok.com"), ("lmarena", "lmarena.ai"), ("arena", "lmarena.ai"), ("code arena", "lmarena.ai"),
    ("groqcloud", "console.groq.com"), ("groq", "groq.com"), ("hugging face", "huggingface.co"), ("openrouter", "openrouter.ai"), ("z.ai", "z.ai"),
    ("notion", "notion.so"), ("figma", "figma.com"), ("canva", "canva.com"), ("slack", "slack.com"), ("discord", "discord.com"), ("whatsapp", "web.whatsapp.com"),
    ("telegram", "web.telegram.org"), ("telegram web", "web.telegram.org"), ("amazon", "amazon.com"), ("daraz", "daraz.pk"), ("aliexpress", "aliexpress.com"),
    ("outlook", "outlook.live.com"), ("medium", "medium.com"), ("dev community", "dev.to"), ("vercel", "vercel.com"), ("railway", "railway.app"),
    ("supabase", "supabase.com"), ("cloudflare", "cloudflare.com"), ("tauri", "tauri.app"), ("mdn web docs", "developer.mozilla.org"), ("mdn", "developer.mozilla.org"),
    ("docs.rs", "docs.rs"), ("crates.io", "crates.io"), ("crates.io: rust package registry", "crates.io"), ("npm", "npmjs.com"), ("spotify", "open.spotify.com"),
    ("spotify – web player", "open.spotify.com"), ("9gag", "9gag.com"), ("hacker news", "news.ycombinator.com"), ("fiverr", "fiverr.com"), ("upwork", "upwork.com"),
    ("brave search", "search.brave.com"), ("bing", "bing.com"), ("duckduckgo", "duckduckgo.com"), ("cricbuzz", "cricbuzz.com"), ("espncricinfo", "espncricinfo.com"),
    ("pinterest", "pinterest.com"), ("quora", "quora.com"), ("udemy", "udemy.com"), ("coursera", "coursera.org"), ("w3schools", "w3schools.com"),
    ("leetcode", "leetcode.com"), ("codepen", "codepen.io"), ("replit", "replit.com"), ("gitlab", "gitlab.com"), ("bitbucket", "bitbucket.org"),
    ("trello", "trello.com"), ("jira", "atlassian.net"), ("dribbble", "dribbble.com"), ("behance", "behance.net"), ("snapchat", "snapchat.com"),
];

/// Titles of browser chrome pages / new tabs (never a site).
const NOT_SITES: &[&str] = &["new tab", "new private tab", "inprivate", "start page", "settings", "history", "downloads", "extensions", "untitled", "loading…", "loading..."];

/// `https://www.Discord.com:443/channels/1?x` → `discord.com`. Also accepts the scheme-less text
/// Chrome shows in its omnibox (`discord.com/channels/…`). None for search text / chrome:// pages.
pub fn host_of(url: &str) -> Option<String> {
    let u = url.trim();
    if u.is_empty() || u.contains(' ') {
        return None;
    }
    let lower = u.to_lowercase();
    for bad in ["chrome://", "edge://", "about:", "brave://", "opera://", "vivaldi://", "file://", "chrome-extension://", "moz-extension://", "view-source:"] {
        if lower.starts_with(bad) {
            return None;
        }
    }
    let rest = lower.split_once("://").map(|(_, r)| r).unwrap_or(&lower);
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.rsplit_once('@').map(|(_, h)| h).unwrap_or(host);
    let host = host.split(':').next().unwrap_or("");
    let host = host.trim_start_matches("www.").trim_end_matches('.');
    crate::tlapps::valid_domain(host).then(|| host.to_string())
}

/// Split a tab title into its meaningful parts (browser names dropped).
pub fn title_parts(title: &str) -> Vec<String> {
    let norm = title.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut parts: Vec<String> = vec![norm];
    for sep in [" - ", " — ", " – ", " | ", " · ", " • ", " / ", " :: ", ": "] {
        parts = parts.iter().flat_map(|p| p.split(sep).map(|x| x.to_string()).collect::<Vec<_>>()).collect();
    }
    let noise = ["google chrome", "microsoft edge", "microsoft\u{200b} edge", "mozilla firefox", "firefox", "brave", "opera", "vivaldi", "arc", "chromium"];
    parts
        .into_iter()
        .map(|p| {
            // "(1463) Discord" → "Discord"; Edge: "Bing and 3 more pages"
            let p = p.trim();
            let p = if p.starts_with('(') { p.split_once(") ").map(|(_, r)| r).unwrap_or(p) } else { p };
            let p = match p.find(" and ") {
                Some(i) if p[i..].contains("more page") => &p[..i],
                _ => p,
            };
            p.trim().to_string()
        })
        .filter(|p| {
            let l = p.to_lowercase();
            !p.is_empty() && !noise.contains(&l.as_str()) && !l.starts_with("profile ") && !l.starts_with("personal") && l != "work"
        })
        .collect()
}

/// Best-effort domain from a browser tab title. Parts are tried from the END (sites put their
/// name last: "Inbox - Gmail", "Home / X", "Chat · Hark"), then from the start ("Discord | #general").
pub fn domain_from_title(title: &str) -> Option<String> {
    let parts = title_parts(title);
    if parts.is_empty() {
        return None;
    }
    let lookup = |p: &str| -> Option<String> {
        let l = p.trim().to_lowercase();
        if NOT_SITES.contains(&l.as_str()) {
            return None;
        }
        if let Some((_, d)) = KNOWN.iter().find(|(k, _)| *k == l) {
            return Some(d.to_string());
        }
        host_of(&l)
    };
    for p in parts.iter().rev() {
        if let Some(d) = lookup(p) {
            return Some(d);
        }
    }
    // a known site name as the first word of a part ("GitHub Copilot", "Gmail inbox")
    for p in parts.iter().rev() {
        let first = p.split_whitespace().next().unwrap_or("").to_lowercase();
        if first.len() >= 4 {
            if let Some((_, d)) = KNOWN.iter().find(|(k, _)| *k == first) {
                return Some(d.to_string());
            }
        }
    }
    None
}

/// Domain for a stored span: the recorded address-bar domain, else the title mapping.
pub fn span_domain(stored: &str, title: &str) -> Option<String> {
    if !stored.is_empty() {
        return Some(stored.to_string());
    }
    domain_from_title(title)
}

/// Display name for a domain: `mail.google.com` → `Gmail`, `discord.com` → `Discord`.
pub fn site_name(domain: &str) -> String {
    const NAMES: &[(&str, &str)] = &[
        ("mail.google.com", "Gmail"), ("docs.google.com", "Google Docs"), ("drive.google.com", "Google Drive"), ("calendar.google.com", "Google Calendar"),
        ("gemini.google.com", "Gemini"), ("aistudio.google.com", "Google AI Studio"), ("studio.youtube.com", "YouTube Studio"), ("music.youtube.com", "YouTube Music"),
        ("x.com", "X"), ("youtube.com", "YouTube"), ("github.com", "GitHub"), ("chatgpt.com", "ChatGPT"), ("claude.ai", "Claude"), ("lmarena.ai", "LMArena"),
        ("web.whatsapp.com", "WhatsApp"), ("open.spotify.com", "Spotify"), ("news.ycombinator.com", "Hacker News"), ("search.brave.com", "Brave Search"),
        ("console.groq.com", "GroqCloud"), ("stackoverflow.com", "Stack Overflow"), ("developer.mozilla.org", "MDN"), ("linkedin.com", "LinkedIn"),
        ("tiktok.com", "TikTok"), ("chat.deepseek.com", "DeepSeek"), ("huggingface.co", "Hugging Face"), ("web.telegram.org", "Telegram"),
    ];
    if let Some((_, n)) = NAMES.iter().find(|(d, _)| *d == domain) {
        return n.to_string();
    }
    // registrable label: discord.com → Discord, en.wikipedia.org → Wikipedia, daraz.com.pk → Daraz
    let labels: Vec<&str> = domain.split('.').collect();
    let main = if labels.len() >= 3 && matches!(labels[labels.len() - 2], "co" | "com" | "org" | "net" | "gov" | "edu" | "ac") {
        labels[labels.len() - 3]
    } else if labels.len() >= 2 {
        labels[labels.len() - 2]
    } else {
        domain
    };
    let mut c = main.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => domain.to_string(),
    }
}

/// `{domain: "productive"|"neutral"|"distracting"}`
pub fn site_cats(c: &Connection) -> Map<String, Value> {
    setting_get(c, SITE_CATS_KEY).and_then(|s| serde_json::from_str::<Value>(&s).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default()
}

/// Site overrides as categorisation rules (exact domain or any subdomain of it).
pub fn site_rules(c: &Connection) -> Vec<Value> {
    site_cats(c).into_iter().filter_map(|(d, cat)| cat.as_str().map(|cat| json!({ "match": d, "field": "domain", "cat": cat }))).collect()
}

/// Set (or clear with None) a site's category.
pub fn set_site_cat(c: &Connection, domain: &str, cat: Option<&str>) -> Result<Value, String> {
    let d = host_of(domain).ok_or_else(|| format!("not a domain: {domain}"))?;
    let mut m = site_cats(c);
    match cat {
        Some(k @ ("productive" | "neutral" | "distracting")) => {
            m.insert(d.clone(), json!(k));
        }
        None => {
            m.remove(&d);
        }
        Some(other) => return Err(format!("unknown category: {other}")),
    }
    setting_put(c, SITE_CATS_KEY, &Value::Object(m).to_string())?;
    crate::timelens::mark_config_dirty();
    Ok(json!({ "ok": true, "domain": d, "category": cat }))
}

/// Does `domain` equal `m` or sit under it (`m = "google.com"` matches `mail.google.com`)?
pub fn domain_matches(domain: &str, m: &str) -> bool {
    let m = m.trim().trim_start_matches("www.").to_lowercase();
    !domain.is_empty() && !m.is_empty() && (domain == m || domain.ends_with(&format!(".{m}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    #[test]
    fn hosts_from_addresses() {
        assert_eq!(host_of("https://www.Discord.com:443/channels/1?x=2").as_deref(), Some("discord.com"));
        assert_eq!(host_of("discord.com/channels/123").as_deref(), Some("discord.com"));
        assert_eq!(host_of("gemini.google.com/app").as_deref(), Some("gemini.google.com"));
        assert_eq!(host_of("chrome://settings"), None);
        assert_eq!(host_of("how to center a div"), None, "search text in the omnibox is not a site");
        assert_eq!(host_of("localhost:3000"), None);
        assert_eq!(host_of("http://192.168.1.1/"), None);
    }

    #[test]
    fn domains_from_titles_like_the_bug_report() {
        assert_eq!(domain_from_title("(1463) Discord | #general | Danger Zone - Google Chrome").as_deref(), Some("discord.com"));
        assert_eq!(domain_from_title("(1496) Discord | @Talha xD").as_deref(), Some("discord.com"));
        assert_eq!(domain_from_title("Home / X - Brave").as_deref(), Some("x.com"));
        assert_eq!(domain_from_title("Chat · Hark"), None, "unknown site: grouped by its name; the address bar gives the real domain");
        assert_eq!(domain_from_title("Google Gemini").as_deref(), Some("gemini.google.com"));
        assert_eq!(domain_from_title("Lo-fi beats - YouTube - Google Chrome").as_deref(), Some("youtube.com"));
        assert_eq!(domain_from_title("YouTube Studio").as_deref(), Some("studio.youtube.com"));
        assert_eq!(domain_from_title("Inbox (3) - ahmad@gmail.com - Gmail").as_deref(), Some("mail.google.com"));
        assert_eq!(domain_from_title("Arena | Benchmark & Compare the Best AI Models").as_deref(), Some("lmarena.ai"));
        assert_eq!(domain_from_title("GroqCloud").as_deref(), Some("console.groq.com"));
        assert_eq!(domain_from_title("Brave Search").as_deref(), Some("search.brave.com"));
        assert_eq!(domain_from_title("serde_json - Rust - docs.rs").as_deref(), Some("docs.rs"));
        assert_eq!(domain_from_title("New Tab - Google Chrome"), None);
        assert_eq!(domain_from_title("Cricket match winner"), None, "unknown page with no site in it");
    }

    #[test]
    fn names_and_overrides() {
        assert_eq!(site_name("discord.com"), "Discord");
        assert_eq!(site_name("en.wikipedia.org"), "Wikipedia");
        assert_eq!(site_name("daraz.com.pk"), "Daraz");
        assert_eq!(site_name("x.com"), "X");
        assert!(domain_matches("mail.google.com", "google.com"));
        assert!(!domain_matches("notgoogle.com", "google.com"));
        let db = Db::open_in_memory().unwrap();
        let c = db.conn();
        set_site_cat(&c, "https://discord.com/x", Some("distracting")).unwrap();
        assert_eq!(site_cats(&c)["discord.com"], "distracting");
        assert_eq!(site_rules(&c)[0]["field"], "domain");
        assert!(set_site_cat(&c, "discord.com", Some("weird")).is_err());
        set_site_cat(&c, "discord.com", None).unwrap();
        assert!(site_cats(&c).is_empty());
    }
}
