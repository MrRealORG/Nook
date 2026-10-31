//! Timelens app registry: which executable each tracked app is, its real icon (extracted once
//! per exe and cached on disk + in SQLite), per-app category overrides and exclusions, and the
//! website favicon cache.
//!
//! Icons on Windows come from the exe itself (`SHDefExtractIconW` → HICON → 32-bit DIB → PNG)
//! or, for Store/UWP apps living under `WindowsApps`, from the package logo named in
//! `AppxManifest.xml`. Everything else gets a coloured letter avatar in the UI.

use crate::db::now_ms;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

// ------------------------------------------------------------------ PNG (no dependencies)

fn crc32(data: &[u8]) -> u32 {
    static T: OnceLock<[u32; 256]> = OnceLock::new();
    let t = T.get_or_init(|| {
        let mut t = [0u32; 256];
        for (i, e) in t.iter_mut().enumerate() {
            let mut c = i as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            }
            *e = c;
        }
        t
    });
    let mut c = 0xFFFF_FFFFu32;
    for &b in data {
        c = t[((c ^ b as u32) & 0xFF) as usize] ^ (c >> 8);
    }
    c ^ 0xFFFF_FFFF
}

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for &x in data {
        a = (a + x as u32) % 65_521;
        b = (b + a) % 65_521;
    }
    (b << 16) | a
}

/// Encode straight (non-premultiplied) RGBA pixels as a PNG. Stored (uncompressed) deflate
/// blocks — icons are tiny (48×48×4 ≈ 9 KB), so a real compressor isn't worth a dependency.
pub fn encode_png(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
    assert_eq!(rgba.len(), (w * h * 4) as usize, "rgba size");
    let mut raw = Vec::with_capacity(((w * 4 + 1) * h) as usize);
    for row in rgba.chunks((w * 4) as usize) {
        raw.push(0); // filter: none
        raw.extend_from_slice(row);
    }
    let mut z = vec![0x78, 0x01];
    let mut chunks = raw.chunks(65_535).peekable();
    if chunks.peek().is_none() {
        z.extend_from_slice(&[1, 0, 0, 0xFF, 0xFF]);
    }
    while let Some(c) = chunks.next() {
        z.push(if chunks.peek().is_none() { 1 } else { 0 });
        let len = c.len() as u16;
        z.extend_from_slice(&len.to_le_bytes());
        z.extend_from_slice(&(!len).to_le_bytes());
        z.extend_from_slice(c);
    }
    z.extend_from_slice(&adler32(&raw).to_be_bytes());
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    let mut chunk = |ty: &[u8; 4], data: &[u8]| {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let mut c = Vec::with_capacity(4 + data.len());
        c.extend_from_slice(ty);
        c.extend_from_slice(data);
        out.extend_from_slice(&c);
        out.extend_from_slice(&crc32(&c).to_be_bytes());
    };
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]); // 8-bit RGBA
    chunk(b"IHDR", &ihdr);
    chunk(b"IDAT", &z);
    chunk(b"IEND", &[]);
    out
}

/// BGRA (as GDI hands it out) → straight RGBA.
///
/// * `premultiplied`: the source carries premultiplied alpha (`IShellItemImageFactory` bitmaps);
///   icon bitmaps from `GetIconInfo` are straight alpha and must NOT be un-premultiplied.
/// * When the bitmap has no alpha at all (old-style icons, or a DDB whose alpha byte came back
///   0 everywhere), `mask_opaque` decides per pixel (from the AND mask); without a mask the
///   whole bitmap is treated as opaque.
pub fn bgra_to_rgba(bgra: &[u8], mask_opaque: Option<&[bool]>, premultiplied: bool) -> Vec<u8> {
    let has_alpha = bgra.chunks(4).any(|p| p[3] != 0);
    let mut out = Vec::with_capacity(bgra.len());
    for (i, p) in bgra.chunks(4).enumerate() {
        let (b, g, r) = (p[0], p[1], p[2]);
        let a = if has_alpha { p[3] } else if mask_opaque.and_then(|m| m.get(i)).copied().unwrap_or(true) { 255 } else { 0 };
        let un = |c: u8| if premultiplied && has_alpha && a > 0 && a < 255 { ((c as u32 * 255 + a as u32 / 2) / a as u32).min(255) as u8 } else { c };
        out.extend_from_slice(&[un(r), un(g), un(b), a]);
    }
    out
}

/// An extraction that produced nothing visible (every pixel transparent, or every pixel black
/// with no alpha information) — treated as a failure so the next method gets a turn.
pub fn is_blank(rgba: &[u8]) -> bool {
    rgba.is_empty() || rgba.chunks(4).all(|p| p[3] == 0) || rgba.chunks(4).all(|p| p[0] == 0 && p[1] == 0 && p[2] == 0)
}

/// Raw 32-bit top-down BGRA from GDI → PNG, or None when the result would be blank.
pub fn bgra_icon_png(w: u32, h: u32, bgra: &[u8], mask_opaque: Option<&[bool]>, premultiplied: bool) -> Option<Vec<u8>> {
    if w == 0 || h == 0 || bgra.len() != (w * h * 4) as usize {
        return None;
    }
    let rgba = bgra_to_rgba(bgra, mask_opaque, premultiplied);
    (!is_blank(&rgba)).then(|| encode_png(w, h, &rgba))
}

pub fn data_url(mime: &str, bytes: &[u8]) -> String {
    use base64::Engine;
    format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

// ------------------------------------------------------------------ Store / UWP package logos

/// For an exe inside a packaged app (`…\WindowsApps\<pkg>\…\App.exe`), find the package's logo
/// PNG via `AppxManifest.xml` and pick the best scaled variant on disk. Pure file I/O, so it is
/// unit-tested everywhere.
pub fn package_logo(exe: &str) -> Option<Vec<u8>> {
    let p = Path::new(exe);
    let mut dir = p.parent()?;
    let manifest = loop {
        let m = dir.join("AppxManifest.xml");
        if m.is_file() {
            break m;
        }
        dir = dir.parent()?;
    };
    let xml = std::fs::read_to_string(&manifest).ok()?;
    let attr = |name: &str| -> Option<String> {
        let i = xml.find(&format!("{name}=\""))? + name.len() + 2;
        Some(xml[i..].split('"').next()?.to_string())
    };
    let elem = |name: &str| -> Option<String> {
        let i = xml.find(&format!("<{name}>"))? + name.len() + 2;
        Some(xml[i..].split('<').next()?.trim().to_string())
    };
    let logo = attr("Square44x44Logo").or_else(|| attr("Square150x150Logo")).or_else(|| elem("Logo"))?;
    let rel = logo.replace('\\', "/");
    let logo_path = dir.join(&rel);
    if logo_path.is_file() {
        return std::fs::read(&logo_path).ok();
    }
    let parent = logo_path.parent()?;
    let stem = logo_path.file_stem()?.to_string_lossy().to_lowercase();
    let mut best: Option<(i32, PathBuf)> = None;
    for e in std::fs::read_dir(parent).ok()?.flatten() {
        let name = e.file_name().to_string_lossy().to_lowercase();
        if !name.starts_with(&format!("{stem}.")) || !name.ends_with(".png") || name.contains("contrast-") {
            continue;
        }
        let mut score = 0;
        if name.contains("targetsize-48") {
            score += 50;
        } else if name.contains("targetsize-64") {
            score += 45;
        } else if name.contains("targetsize-32") {
            score += 40;
        } else if name.contains("targetsize-") {
            score += 20;
        } else if name.contains("scale-200") {
            score += 35;
        } else if name.contains("scale-100") {
            score += 25;
        } else if name.contains("scale-") {
            score += 15;
        }
        if name.contains("altform-unplated") {
            score += 8;
        }
        if name.contains("altform-lightunplated") {
            score -= 2;
        }
        if best.as_ref().map(|(s, _)| score > *s).unwrap_or(true) {
            best = Some((score, e.path()));
        }
    }
    std::fs::read(best?.1).ok()
}

// ------------------------------------------------------------------ icon sources

/// Where icons come from. Mocked in tests.
pub trait IconSource: Send {
    /// PNG bytes for an executable (None when there is no usable icon).
    fn icon_png(&self, exe: &str) -> Option<Vec<u8>>;
}

pub struct PlatformIcons;

impl IconSource for PlatformIcons {
    fn icon_png(&self, exe: &str) -> Option<Vec<u8>> {
        if exe.is_empty() {
            return None;
        }
        if exe.to_lowercase().contains("windowsapps") {
            if let Some(b) = package_logo(exe) {
                return Some(b);
            }
        }
        #[cfg(windows)]
        {
            win::exe_icon_png(exe, 48)
        }
        #[cfg(not(windows))]
        {
            None
        }
    }
}

static ICON_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Disk cache for extracted icons (`<app data>/icons`). Set once by the desktop shell.
pub fn set_icon_dir(dir: PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    let _ = ICON_DIR.set(dir);
}

fn fnv(s: &str) -> u64 {
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    for b in s.to_lowercase().bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

fn disk_path(exe: &str) -> Option<PathBuf> {
    ICON_DIR.get().map(|d| d.join(format!("{:016x}.png", fnv(exe))))
}

/// Icon for an exe: disk cache first, then the source (written back to disk).
pub fn icon_for(exe: &str, src: &dyn IconSource) -> Option<Vec<u8>> {
    if let Some(p) = disk_path(exe) {
        if let Ok(b) = std::fs::read(&p) {
            if b.starts_with(&[0x89, b'P', b'N', b'G']) {
                return Some(b);
            }
        }
    }
    let b = src.icon_png(exe)?;
    if let Some(p) = disk_path(exe) {
        let _ = std::fs::write(p, &b);
    }
    Some(b)
}

// ------------------------------------------------------------------ registry

/// A failed icon extraction is retried after this long (and on every "Refresh icons").
const ICON_RETRY_MS: i64 = 6 * 3_600_000;
/// Favicon fetch failures are retried weekly.
const FAVICON_RETRY_MS: i64 = 7 * 86_400_000;

/// Record apps seen by the tracker (`(app, exe, ts)`), extracting icons for new exes.
/// Called from the tracker's batched flush, never on the sampling path.
pub fn register(c: &Connection, seen: &[(String, String, i64)], icons: &dyn IconSource) {
    for (app, exe, ts) in seen {
        if app == "AFK" || app.is_empty() {
            continue;
        }
        let row: Option<(String, String, i64)> =
            c.query_row(r#"SELECT "exe","icon","iconAt" FROM "TimelensApp" WHERE "app"=?1"#, params![app], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional().ok().flatten();
        let (old_exe, icon, icon_at) = row.clone().unwrap_or_default();
        // a demo-seeded row is a placeholder: its stand-in icon never blocks the real one
        let (old_exe, icon, icon_at) = if is_demo_exe(&old_exe) { (String::new(), String::new(), 0) } else { (old_exe, icon, icon_at) };
        let exe_now = if exe.is_empty() { old_exe.clone() } else { exe.clone() };
        let want_icon = !exe_now.is_empty() && (icon.is_empty() && (icon_at == 0 || ts - icon_at > ICON_RETRY_MS) || (exe_now != old_exe && !old_exe.is_empty()));
        let new_icon = if want_icon { icon_for(&exe_now, icons).map(|b| data_url("image/png", &b)) } else { None };
        if row.is_none() {
            let _ = c.execute(
                r#"INSERT INTO "TimelensApp" ("app","exe","icon","iconAt","firstSeen","lastSeen") VALUES (?1,?2,?3,?4,?5,?5)"#,
                params![app, exe_now, new_icon.clone().unwrap_or_default(), if want_icon { *ts } else { 0 }, ts],
            );
        } else {
            let _ = c.execute(r#"UPDATE "TimelensApp" SET "exe"=?2, "lastSeen"=MAX("lastSeen",?3) WHERE "app"=?1"#, params![app, exe_now, ts]);
            if want_icon {
                let _ = c.execute(r#"UPDATE "TimelensApp" SET "icon"=?2, "iconAt"=?3 WHERE "app"=?1"#, params![app, new_icon.unwrap_or(icon), ts]);
            }
        }
    }
}

/// Exe paths written by the demo seed (`/api/timelens/seed`), never real executables.
pub fn is_demo_exe(exe: &str) -> bool {
    let l = exe.to_lowercase();
    l.starts_with("c:\\users\\demo\\") || l == "c:\\program files\\windowsapps\\microsoft.windowsterminal\\windowsterminal.exe"
}

/// v1.2's demo seed stored generated coloured squares as app icons, and (when the demo was
/// loaded on a real install) those squares then blocked the real exe icon from ever being
/// extracted. Clear them so the real icon (or the built-in brand fallback) shows. Idempotent.
pub fn purge_demo_icons(c: &Connection) -> usize {
    let mut n = 0;
    if let Ok(mut st) = c.prepare(r#"SELECT "app","exe" FROM "TimelensApp" WHERE "icon" != '' OR "iconAt" != 0"#) {
        let rows: Vec<(String, String)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map(|r| r.flatten().collect()).unwrap_or_default();
        for (app, _) in rows.into_iter().filter(|(_, e)| is_demo_exe(e)) {
            n += c.execute(r#"UPDATE "TimelensApp" SET "icon"='', "iconAt"=0 WHERE "app"=?1"#, params![app]).unwrap_or(0);
        }
    }
    n
}

/// Every registered (app, exe) with a real executable path — the work list for a refresh.
pub fn refresh_targets(c: &Connection) -> Vec<(String, String)> {
    let mut out = vec![];
    if let Ok(mut st) = c.prepare(r#"SELECT "app","exe" FROM "TimelensApp" WHERE "exe" != ''"#) {
        if let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
            out = rows.flatten().filter(|(_, e)| !is_demo_exe(e)).collect();
        }
    }
    out
}

/// "Refresh icons": re-extract every app's icon, bypassing (and rewriting) the disk cache.
/// The extraction runs with NO database lock held; results are written back in one pass.
pub fn refresh_icons(db: &crate::db::Db, icons: &dyn IconSource, now: i64) -> Value {
    let targets = {
        let c = db.conn();
        purge_demo_icons(&c);
        refresh_targets(&c)
    };
    let mut got = vec![];
    for (app, exe) in &targets {
        if let Some(p) = disk_path(exe) {
            let _ = std::fs::remove_file(p);
        }
        got.push((app.clone(), icon_for(exe, icons).map(|b| data_url("image/png", &b))));
    }
    let c = db.conn();
    let mut ok = 0;
    for (app, icon) in &got {
        if let Some(i) = icon {
            ok += 1;
            let _ = c.execute(r#"UPDATE "TimelensApp" SET "icon"=?2, "iconAt"=?3 WHERE "app"=?1"#, params![app, i, now]);
        } else {
            // keep an older good icon; just stamp the attempt
            let _ = c.execute(r#"UPDATE "TimelensApp" SET "iconAt"=?2 WHERE "app"=?1"#, params![app, now]);
        }
    }
    json!({ "ok": true, "apps": targets.len(), "extracted": ok, "failed": targets.len() - ok, "icons": icons_map(&c) })
}

/// Category overrides as Timelens rules (exact app match), placed ahead of user rules so a
/// change re-categorises all history (categories are computed at read time).
pub fn override_rules(c: &Connection) -> Vec<Value> {
    let mut out = vec![];
    if let Ok(mut st) = c.prepare(r#"SELECT "app","category" FROM "TimelensApp" WHERE "category" IS NOT NULL AND "category" != ''"#) {
        if let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
            for (app, cat) in rows.flatten() {
                out.push(json!({ "match": app, "field": "appexact", "cat": cat }));
            }
        }
    }
    out
}

pub fn excluded_apps(c: &Connection) -> Vec<String> {
    let mut out = vec![];
    if let Ok(mut st) = c.prepare(r#"SELECT "app" FROM "TimelensApp" WHERE "excluded"=1"#) {
        if let Ok(rows) = st.query_map([], |r| r.get::<_, String>(0)) {
            out = rows.flatten().collect();
        }
    }
    out
}

/// `app → data:image/png…` for every app with a cached icon.
pub fn icons_map(c: &Connection) -> Value {
    let mut m = Map::new();
    if let Ok(mut st) = c.prepare(r#"SELECT "app","icon" FROM "TimelensApp" WHERE "icon" != ''"#) {
        if let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
            for (a, i) in rows.flatten() {
                m.insert(a, Value::String(i));
            }
        }
    }
    Value::Object(m)
}

/// Every app ever registered (plus any app that only exists in spans), with time in range.
pub fn apps_list(c: &Connection, secs_by_app: &std::collections::HashMap<String, i64>, cat_of: &dyn Fn(&str) -> &'static str) -> Vec<Value> {
    let mut out: Vec<Value> = vec![];
    let mut seen = std::collections::HashSet::new();
    if let Ok(mut st) = c.prepare(r#"SELECT "app","exe","icon" != '',"category","excluded","firstSeen","lastSeen" FROM "TimelensApp""#) {
        if let Ok(rows) = st.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, bool>(2)?, r.get::<_, Option<String>>(3)?, r.get::<_, i64>(4)?, r.get::<_, i64>(5)?, r.get::<_, i64>(6)?))
        }) {
            for (app, exe, has_icon, cat, excl, first, last) in rows.flatten() {
                seen.insert(app.clone());
                out.push(json!({
                    "app": app, "exe": exe, "hasIcon": has_icon, "override": cat, "excluded": excl != 0,
                    "firstSeen": first, "lastSeen": last, "secs": secs_by_app.get(&app).copied().unwrap_or(0), "cat": cat_of(&app),
                }));
            }
        }
    }
    for (app, secs) in secs_by_app {
        if !seen.contains(app) {
            out.push(json!({ "app": app, "exe": "", "hasIcon": false, "override": null, "excluded": false, "firstSeen": 0, "lastSeen": 0, "secs": secs, "cat": cat_of(app) }));
        }
    }
    out.sort_by(|a, b| b["secs"].as_i64().cmp(&a["secs"].as_i64()).then_with(|| a["app"].as_str().cmp(&b["app"].as_str())));
    out
}

/// Apply `{ category?: "productive"|"neutral"|"distracting"|null, excluded?: bool, purge?: bool }`.
pub fn patch_app(c: &Connection, app: &str, b: &Map<String, Value>) -> Result<Value, String> {
    let app = crate::util::take(app.trim(), 200);
    if app.is_empty() {
        return Err("app required".into());
    }
    let _ = c.execute(r#"INSERT OR IGNORE INTO "TimelensApp" ("app","firstSeen","lastSeen") VALUES (?1,?2,?2)"#, params![app, now_ms()]);
    if let Some(v) = b.get("category") {
        let cat = match v.as_str() {
            Some("productive") => Some("productive"),
            Some("neutral") => Some("neutral"),
            Some("distracting") => Some("distracting"),
            _ => None,
        };
        c.execute(r#"UPDATE "TimelensApp" SET "category"=?2 WHERE "app"=?1"#, params![app, cat]).map_err(|e| e.to_string())?;
    }
    if let Some(x) = b.get("excluded").and_then(|v| v.as_bool()) {
        c.execute(r#"UPDATE "TimelensApp" SET "excluded"=?2 WHERE "app"=?1"#, params![app, x as i64]).map_err(|e| e.to_string())?;
    }
    let mut purged = 0;
    if b.get("purge").and_then(|v| v.as_bool()) == Some(true) {
        purged = c.execute(r#"DELETE FROM "TimeSpan" WHERE "app"=?1 AND "focus"=0"#, params![app]).map_err(|e| e.to_string())?;
    }
    crate::timelens::mark_config_dirty();
    Ok(json!({ "ok": true, "app": app, "purged": purged }))
}

// ------------------------------------------------------------------ websites + favicons

/// Common sites by the name browsers put in the tab title → their domain.
const SITES: &[(&str, &str)] = &[
    ("youtube", "youtube.com"), ("github", "github.com"), ("gmail", "mail.google.com"), ("google", "google.com"), ("google search", "google.com"),
    ("google docs", "docs.google.com"), ("google sheets", "docs.google.com"), ("google drive", "drive.google.com"), ("google calendar", "calendar.google.com"),
    ("reddit", "reddit.com"), ("twitter", "x.com"), ("x", "x.com"), ("facebook", "facebook.com"), ("instagram", "instagram.com"), ("linkedin", "linkedin.com"),
    ("netflix", "netflix.com"), ("twitch", "twitch.tv"), ("tiktok", "tiktok.com"), ("stack overflow", "stackoverflow.com"), ("wikipedia", "wikipedia.org"),
    ("chatgpt", "chatgpt.com"), ("claude", "claude.ai"), ("notion", "notion.so"), ("figma", "figma.com"), ("slack", "slack.com"), ("discord", "discord.com"),
    ("whatsapp", "web.whatsapp.com"), ("amazon", "amazon.com"), ("outlook", "outlook.live.com"), ("medium", "medium.com"), ("dev community", "dev.to"),
    ("vercel", "vercel.com"), ("railway", "railway.app"), ("supabase", "supabase.com"), ("cloudflare", "cloudflare.com"), ("tauri", "tauri.app"),
    ("mdn web docs", "developer.mozilla.org"), ("mdn", "developer.mozilla.org"), ("docs.rs", "docs.rs"), ("crates.io", "crates.io"), ("npm", "npmjs.com"),
    ("spotify", "open.spotify.com"), ("9gag", "9gag.com"), ("hacker news", "news.ycombinator.com"), ("fiverr", "fiverr.com"), ("upwork", "upwork.com"),
];

pub fn valid_domain(d: &str) -> bool {
    let d = d.trim().to_lowercase();
    d.len() >= 4
        && d.len() <= 253
        && d.contains('.')
        && !d.starts_with('.')
        && !d.ends_with('.')
        && d.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        && d.parse::<std::net::Ipv4Addr>().is_err()
        && !d.ends_with(".local")
        && !d.ends_with(".localhost")
        && !d.ends_with(".internal")
        && d.rsplit('.').next().map(|tld| tld.chars().all(|c| c.is_ascii_alphabetic())).unwrap_or(false)
}

/// Best-effort domain for a browser "site" label (the last part of a tab title).
pub fn domain_for_site(site: &str) -> Option<String> {
    let l = site.trim().to_lowercase();
    if l.is_empty() {
        return None;
    }
    if let Some((_, d)) = SITES.iter().find(|(k, _)| *k == l) {
        return Some(d.to_string());
    }
    let cand = l.trim_start_matches("www.").split(['/', ' ']).next().unwrap_or("");
    valid_domain(cand).then(|| cand.to_string())
}

pub fn favicons_map(c: &Connection) -> Value {
    let mut m = Map::new();
    if let Ok(mut st) = c.prepare(r#"SELECT "domain","data" FROM "TimelensFavicon" WHERE "data" != ''"#) {
        if let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
            for (d, x) in rows.flatten() {
                m.insert(d, Value::String(x));
            }
        }
    }
    Value::Object(m)
}

/// Domains that still need a favicon fetch (never tried, or a failed try older than a week).
pub fn favicons_missing(c: &Connection, domains: &[String], now: i64) -> Vec<String> {
    domains
        .iter()
        .map(|d| d.trim().to_lowercase())
        .filter(|d| valid_domain(d))
        .filter(|d| {
            let row: Option<(String, i64)> = c.query_row(r#"SELECT "data","fetchedAt" FROM "TimelensFavicon" WHERE "domain"=?1"#, params![d], |r| Ok((r.get(0)?, r.get(1)?))).optional().ok().flatten();
            match row {
                None => true,
                Some((data, at)) => data.is_empty() && now - at > FAVICON_RETRY_MS,
            }
        })
        .take(24)
        .collect()
}

pub fn favicon_store(c: &Connection, domain: &str, data: &str, now: i64) {
    let _ = c.execute(
        r#"INSERT INTO "TimelensFavicon" ("domain","data","fetchedAt") VALUES (?1,?2,?3) ON CONFLICT("domain") DO UPDATE SET "data"=excluded."data","fetchedAt"=excluded."fetchedAt""#,
        params![domain, data, now],
    );
}

/// Sniff the image type of fetched favicon bytes (rejects HTML error pages).
pub fn favicon_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() < 8 || bytes.len() > 200_000 {
        return None;
    }
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("image/png")
    } else if bytes.starts_with(&[0, 0, 1, 0]) {
        Some("image/x-icon")
    } else if bytes.starts_with(b"GIF8") {
        Some("image/gif")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        let head = String::from_utf8_lossy(&bytes[..bytes.len().min(256)]).to_lowercase();
        (head.contains("<svg") && !head.contains("<html")).then_some("image/svg+xml")
    }
}

// ------------------------------------------------------------------ Windows icon extraction

#[cfg(windows)]
#[path = "tlapps_win.rs"]
pub mod win;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    struct FakeIcons(std::sync::atomic::AtomicUsize);
    impl IconSource for FakeIcons {
        fn icon_png(&self, exe: &str) -> Option<Vec<u8>> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            (!exe.contains("noicon")).then(|| encode_png(1, 1, &[255, 0, 0, 255]))
        }
    }

    #[test]
    fn png_encoder_produces_a_valid_png() {
        let px: Vec<u8> = (0..(3 * 2)).flat_map(|i| [i as u8 * 40, 10, 200, 255]).collect();
        let png = encode_png(3, 2, &px);
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
        assert_eq!(&png[12..16], b"IHDR");
        assert_eq!(u32::from_be_bytes(png[16..20].try_into().unwrap()), 3);
        assert!(png.ends_with(&[0xAE, 0x42, 0x60, 0x82]), "IEND crc");
        assert_eq!(crc32(b"IEND"), 0xAE42_6082);
        assert_eq!(adler32(b"Wikipedia"), 0x11E6_0398);
        // larger than one stored block
        let big = vec![7u8; 200 * 100 * 4];
        assert!(encode_png(200, 100, &big).len() > 80_000);
    }

    #[test]
    fn bgra_conversion_unpremultiplies_and_uses_mask() {
        let px = bgra_to_rgba(&[10, 20, 30, 255, 5, 5, 5, 128], None, true);
        assert_eq!(&px[..4], &[30, 20, 10, 255]);
        assert_eq!(px[7], 128);
        assert_eq!(px[4], 10); // 5 * 255 / 128 ≈ 10
        // straight alpha (GetIconInfo bitmaps) is passed through untouched
        let px = bgra_to_rgba(&[10, 20, 30, 255, 5, 5, 5, 128], None, false);
        assert_eq!(&px[4..8], &[5, 5, 5, 128]);
        let px = bgra_to_rgba(&[1, 2, 3, 0, 4, 5, 6, 0], Some(&[true, false]), false);
        assert_eq!((px[3], px[7]), (255, 0));
    }

    /// Minimal decoder for the PNGs `encode_png` writes (stored deflate, filter 0) so the whole
    /// GDI → PNG path can be checked pixel-for-pixel on Linux.
    fn decode_stored_png(png: &[u8]) -> (u32, u32, Vec<u8>) {
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
        let (mut i, mut w, mut h, mut idat) = (8usize, 0, 0, vec![]);
        while i < png.len() {
            let len = u32::from_be_bytes(png[i..i + 4].try_into().unwrap()) as usize;
            let ty = &png[i + 4..i + 8];
            let data = &png[i + 8..i + 8 + len];
            let crc = u32::from_be_bytes(png[i + 8 + len..i + 12 + len].try_into().unwrap());
            assert_eq!(crc, crc32(&png[i + 4..i + 8 + len]), "chunk crc");
            match ty {
                b"IHDR" => {
                    w = u32::from_be_bytes(data[0..4].try_into().unwrap());
                    h = u32::from_be_bytes(data[4..8].try_into().unwrap());
                    assert_eq!(&data[8..10], &[8, 6], "8-bit RGBA");
                }
                b"IDAT" => idat.extend_from_slice(data),
                _ => {}
            }
            i += 12 + len;
        }
        let mut raw = vec![];
        let mut j = 2;
        loop {
            let last = idat[j] & 1;
            let n = u16::from_le_bytes([idat[j + 1], idat[j + 2]]) as usize;
            raw.extend_from_slice(&idat[j + 5..j + 5 + n]);
            j += 5 + n;
            if last == 1 {
                break;
            }
        }
        assert_eq!(u32::from_be_bytes(idat[j..j + 4].try_into().unwrap()), adler32(&raw));
        let mut px = vec![];
        for row in raw.chunks((w * 4 + 1) as usize) {
            assert_eq!(row[0], 0, "filter none");
            px.extend_from_slice(&row[1..]);
        }
        (w, h, px)
    }

    #[test]
    fn synthetic_bgra_icon_round_trips_through_png() {
        // a 48x48 32-bit top-down BGRA "icon": opaque blue square, soft edge, transparent corners
        let n = 48u32;
        let mut bgra = vec![0u8; (n * n * 4) as usize];
        for y in 0..n {
            for x in 0..n {
                let i = ((y * n + x) * 4) as usize;
                let edge = x == 4 || y == 4 || x == 43 || y == 43;
                let inside = (4..=43).contains(&x) && (4..=43).contains(&y);
                if inside {
                    bgra[i..i + 4].copy_from_slice(&if edge { [200, 100, 20, 128] } else { [230, 120, 30, 255] });
                }
            }
        }
        // straight alpha (HICON path)
        let png = bgra_icon_png(n, n, &bgra, None, false).expect("visible icon");
        let (w, h, px) = decode_stored_png(&png);
        assert_eq!((w, h), (48, 48));
        assert_eq!(&px[0..4], &[0, 0, 0, 0], "transparent corner");
        let c = ((20 * n + 20) * 4) as usize;
        assert_eq!(&px[c..c + 4], &[30, 120, 230, 255], "BGRA -> RGBA");
        let e = ((4 * n + 20) * 4) as usize;
        assert_eq!(&px[e..e + 4], &[20, 100, 200, 128], "straight alpha kept");
        // premultiplied (IShellItemImageFactory path): edge colour is un-premultiplied
        let (_, _, px) = decode_stored_png(&bgra_icon_png(n, n, &bgra, None, true).unwrap());
        assert_eq!(&px[e..e + 4], &[40, 199, 255, 128]);
        // the whole bitmap with alpha 0 (DDB that lost its alpha) + an AND mask → mask decides
        let mut no_alpha = bgra.clone();
        no_alpha.chunks_mut(4).for_each(|p| p[3] = 0);
        let mask: Vec<bool> = no_alpha.chunks(4).map(|p| p[0] != 0).collect();
        let (_, _, px) = decode_stored_png(&bgra_icon_png(n, n, &no_alpha, Some(&mask), false).unwrap());
        assert_eq!(px[3], 0, "masked corner stays transparent");
        assert_eq!(px[c + 3], 255, "mask-opaque pixel becomes opaque");
        // ...and without a mask the bitmap is made opaque instead of invisible
        let (_, _, px) = decode_stored_png(&bgra_icon_png(n, n, &no_alpha, None, false).unwrap());
        assert!(px.chunks(4).all(|p| p[3] == 255));
        // blank extractions are failures (so the next method is tried)
        assert!(bgra_icon_png(n, n, &vec![0u8; (n * n * 4) as usize], None, false).is_none());
        assert!(bgra_icon_png(n, n, &vec![0u8; 8], None, false).is_none(), "size mismatch");
        let fully_masked: Vec<bool> = vec![false; (n * n) as usize];
        assert!(bgra_icon_png(n, n, &no_alpha, Some(&fully_masked), false).is_none());
    }

    #[test]
    fn demo_seed_icons_never_block_real_ones() {
        let db = Db::open_in_memory().unwrap();
        let src = FakeIcons(Default::default());
        {
            let c = db.conn();
            c.execute(r#"INSERT INTO "TimelensApp" ("app","exe","icon","iconAt","firstSeen","lastSeen") VALUES ('Slack','C:\Users\demo\AppData\Local\slack\slack.exe','data:image/png;base64,SQUARE',5,5,5)"#, []).unwrap();
            // the real Slack shows up: the demo placeholder must not block the extraction
            register(&c, &[("Slack".into(), "C:\\Users\\me\\AppData\\Local\\slack\\slack.exe".into(), 10)], &src);
            assert_ne!(icons_map(&c)["Slack"], "data:image/png;base64,SQUARE");
            c.execute(r#"INSERT INTO "TimelensApp" ("app","exe","icon","iconAt","firstSeen","lastSeen") VALUES ('Figma','C:\Users\demo\AppData\Local\Figma\Figma.exe','data:image/png;base64,SQUARE',5,5,5)"#, []).unwrap();
            assert_eq!(purge_demo_icons(&c), 1);
            assert!(icons_map(&c).get("Figma").is_none());
            c.execute(r#"INSERT INTO "TimelensApp" ("app","exe","icon","iconAt","firstSeen","lastSeen") VALUES ('Broken','C:\noicon.exe','',5,5,5)"#, []).unwrap();
        }
        // refresh: every real exe re-extracted, demo rows skipped, failures reported
        let r = refresh_icons(&db, &src, 100);
        assert_eq!(r["apps"], 2);
        assert_eq!(r["extracted"], 1);
        assert_eq!(r["failed"], 1);
        assert!(r["icons"]["Slack"].as_str().unwrap().starts_with("data:image/png;base64,"));
        // a failed extraction is retried after the retry window (not a week later)
        let calls = src.0.load(std::sync::atomic::Ordering::SeqCst);
        register(&db.conn(), &[("Broken".into(), "C:\\noicon.exe".into(), 100 + ICON_RETRY_MS + 1)], &src);
        assert_eq!(src.0.load(std::sync::atomic::Ordering::SeqCst), calls + 1);
    }

    #[test]
    fn uwp_package_logo_picks_best_variant() {
        let d = tempfile::tempdir().unwrap();
        let pkg = d.path().join("WindowsApps").join("Microsoft.WindowsCalculator_11.0_x64__8wekyb3d8bbwe");
        std::fs::create_dir_all(pkg.join("Assets")).unwrap();
        std::fs::write(pkg.join("AppxManifest.xml"), r#"<Package><Applications><Application><uap:VisualElements Square44x44Logo="Assets\CalculatorAppList.png" /></Application></Applications></Package>"#).unwrap();
        for f in ["CalculatorAppList.scale-100.png", "CalculatorAppList.targetsize-48_altform-unplated.png", "CalculatorAppList.contrast-black_scale-200.png", "CalculatorAppList.targetsize-16.png"] {
            std::fs::write(pkg.join("Assets").join(f), f.as_bytes()).unwrap();
        }
        let exe = pkg.join("CalculatorApp.exe");
        let got = package_logo(&exe.to_string_lossy()).unwrap();
        assert_eq!(got, b"CalculatorAppList.targetsize-48_altform-unplated.png");
        assert!(package_logo("/nowhere/app.exe").is_none());
    }

    #[test]
    fn registry_extracts_icons_once_and_overrides_apply() {
        let db = Db::open_in_memory().unwrap();
        let c = db.conn();
        let src = FakeIcons(Default::default());
        register(&c, &[("VS Code".into(), "C:\\Code.exe".into(), 1000), ("Mystery".into(), "C:\\noicon.exe".into(), 1000)], &src);
        register(&c, &[("VS Code".into(), "C:\\Code.exe".into(), 2000), ("Mystery".into(), "C:\\noicon.exe".into(), 2000)], &src);
        assert_eq!(src.0.load(std::sync::atomic::Ordering::SeqCst), 2, "one extraction per exe, failures not retried within the retry window");
        let icons = icons_map(&c);
        assert!(icons["VS Code"].as_str().unwrap().starts_with("data:image/png;base64,"));
        assert!(icons.get("Mystery").is_none());
        let mut b = Map::new();
        b.insert("category".into(), json!("distracting"));
        patch_app(&c, "VS Code", &b).unwrap();
        assert_eq!(override_rules(&c)[0]["cat"], "distracting");
        let mut b = Map::new();
        b.insert("excluded".into(), json!(true));
        patch_app(&c, "Mystery", &b).unwrap();
        assert_eq!(excluded_apps(&c), vec!["Mystery".to_string()]);
        let secs = std::collections::HashMap::from([("VS Code".to_string(), 60i64), ("Other".to_string(), 5)]);
        let list = apps_list(&c, &secs, &|_| "neutral");
        assert_eq!(list.len(), 3);
        assert_eq!(list[0]["app"], "VS Code");
        assert_eq!(list[0]["hasIcon"], true);
    }

    #[test]
    fn domains_and_favicons() {
        assert_eq!(domain_for_site("YouTube").as_deref(), Some("youtube.com"));
        assert_eq!(domain_for_site("docs.rs").as_deref(), Some("docs.rs"));
        assert_eq!(domain_for_site("Some Random Page"), None);
        assert!(!valid_domain("192.168.1.1"));
        assert!(!valid_domain("printer.local"));
        assert!(!valid_domain("localhost"));
        assert_eq!(favicon_mime(&[0, 0, 1, 0, 1, 0, 16, 16]), Some("image/x-icon"));
        assert_eq!(favicon_mime(b"<!doctype html><html>"), None);
        let db = Db::open_in_memory().unwrap();
        let c = db.conn();
        let want = favicons_missing(&c, &["github.com".into(), "bad domain".into()], 10);
        assert_eq!(want, vec!["github.com".to_string()]);
        favicon_store(&c, "github.com", "", 10);
        assert!(favicons_missing(&c, &["github.com".into()], 20).is_empty(), "failed fetch not retried within a week");
        favicon_store(&c, "github.com", "data:image/png;base64,AA==", 30);
        assert_eq!(favicons_map(&c)["github.com"], "data:image/png;base64,AA==");
    }
}
