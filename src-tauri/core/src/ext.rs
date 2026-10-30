//! Nook 1.1 features: FTS5 search, backlinks, daily notes + calendar, templates, version
//! history, export (md/html) + import (Markdown/Obsidian folders), AI conversations, task
//! reminders + recurrence, encrypted backups, the maintenance tick, and the extra agent/MCP tools.

use crate::api::{all_notes, note_row, query_vec, task_row, ApiResponse as R, Body};
use crate::db::{new_id, now_ms, setting_get, setting_put, Db};
use crate::timelens;
use crate::util::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

// ============================================================== routing

/// Routes added in 1.1. Returns None when the path is not ours.
pub fn route(c: &Connection, m: &str, seg: &[&str], b: &Map<String, Value>, q: &HashMap<String, String>) -> Option<R> {
    let now = now_ms();
    Some(match (m, seg) {
        ("GET", ["search"]) => R::json(search(c, q)),
        ("GET", ["notes", id, "backlinks"]) => R::json(json!(backlinks(c, id))),
        ("GET", ["notes", id, "versions"]) => R::json(json!(versions(c, id))),
        ("POST", ["notes", id, "versions"]) => match snapshot(c, id) {
            Ok(v) => R::json(v),
            Err(e) => R::err(404, &e),
        },
        ("POST", ["notes", id, "versions", vid, "restore"]) => match restore_version(c, id, vid) {
            Ok(v) => R::json(v),
            Err(e) => R::err(404, &e),
        },
        ("GET", ["notes", id, "export"]) => export_note(c, id, q.get("format").map(String::as_str).unwrap_or("md")),
        ("POST", ["import"]) => R::json(import(c, b)),
        ("GET", ["templates"]) => R::json(json!(templates(c))),
        ("POST", ["templates"]) => template_save(c, b),
        ("DELETE", ["templates", id]) => {
            let n = c.execute(r#"DELETE FROM "Template" WHERE "id"=?1 AND "builtin"=0"#, params![id]).unwrap_or(0);
            R::json(json!({ "ok": n == 1 }))
        }
        ("POST", ["templates", id, "apply"]) => {
            let t: Option<(String, String)> = c.query_row(r#"SELECT "name","content" FROM "Template" WHERE "id"=?1"#, params![id], |r| Ok((r.get(0)?, r.get(1)?))).optional().ok().flatten();
            match t {
                Some((name, content)) => {
                    let title = s(b.get("title"), 200);
                    let title = if title.is_empty() { name } else { title };
                    R::json(json!({ "title": title.clone(), "content": fill_template(&content, &title, now) }))
                }
                None => R::err(404, "no such template"),
            }
        }
        ("GET", ["daily"]) => {
            let date = q.get("date").cloned().unwrap_or_else(|| timelens::local_day_key(now));
            match daily_note(c, &date, true) {
                Ok(n) => R::json(n),
                Err(e) => R::err(400, &e),
            }
        }
        ("GET", ["calendar"]) => R::json(calendar(c, q.get("month").map(String::as_str).unwrap_or(""))),
        ("GET", ["conversations"]) => R::json(Value::Array(query_vec(c, r#"SELECT "id","title","model","createdAt","updatedAt", json_array_length("messages") AS "count" FROM "Conversation" ORDER BY "updatedAt" DESC LIMIT 200"#, [], |r| {
            Ok(json!({ "id": r.get::<_, String>(0)?, "title": r.get::<_, String>(1)?, "model": r.get::<_, String>(2)?, "createdAt": r.get::<_, i64>(3)?, "updatedAt": r.get::<_, i64>(4)?, "count": r.get::<_, i64>(5)? }))
        }))),
        ("GET", ["conversations", id]) => match conversation(c, id) {
            Some(v) => R::json(v),
            None => R::err(404, "not found"),
        },
        ("PUT", ["conversations", id]) | ("POST", ["conversations", id]) => conversation_save(c, id, b),
        ("DELETE", ["conversations", id]) => {
            let n = c.execute(r#"DELETE FROM "Conversation" WHERE "id"=?1"#, params![id]).unwrap_or(0);
            R::json(json!({ "ok": n == 1 }))
        }
        ("GET", ["reminders", "due"]) => R::json(json!(due_reminders(c, now, true))),
        ("GET", ["backup"]) => R::json(backup_config_public(c)),
        ("PUT", ["backup"]) => backup_config_put(c, b),
        ("POST", ["backup"]) => {
            let cfg = backup_config(c);
            let dir = str_of(b.get("dir")).map(String::from).or(cfg.0);
            let pw = str_of(b.get("password")).map(String::from).or(cfg.1);
            match (dir, pw) {
                (Some(d), Some(p)) if !p.is_empty() => match backup_to(c, Path::new(&d), &p) {
                    Ok(path) => R::json(json!({ "ok": true, "file": path.to_string_lossy() })),
                    Err(e) => R::err(500, &e),
                },
                _ => R::err(400, "dir and password required"),
            }
        }
        ("POST", ["restore"]) => {
            let file = s(b.get("file"), 2000);
            let pw = str_of(b.get("password")).map(String::from).or(backup_config(c).1).unwrap_or_default();
            match restore_from(c, Path::new(&file), &pw) {
                Ok(_) => R::json(json!({ "ok": true })),
                Err(e) => R::err(400, &e),
            }
        }
        ("GET", ["backups"]) => {
            let dir = q.get("dir").cloned().or(backup_config(c).0).unwrap_or_default();
            R::json(json!(list_backups(Path::new(&dir))))
        }
        ("GET", ["maintenance"]) | ("POST", ["maintenance"]) => R::json(json!(maintenance(c, now))),
        ("GET", ["timelens", rest @ ..]) | ("POST", ["timelens", rest @ ..]) | ("PUT", ["timelens", rest @ ..]) | ("PATCH", ["timelens", rest @ ..]) | ("DELETE", ["timelens", rest @ ..]) => {
            return timelens::route(c, m, rest, b, q).or_else(|| Some(R::err(404, "no such timelens route")));
        }
        _ => return None,
    })
}

// ============================================================== search

/// Turn free text into a safe FTS5 query: every word becomes a quoted prefix term.
pub fn fts_query(q: &str) -> String {
    q.split(|ch: char| !ch.is_alphanumeric() && ch != '_' && ch != '-')
        .map(|w| w.trim_matches('-'))
        .filter(|w| !w.is_empty())
        .take(12)
        .map(|w| format!("\"{}\"*", w.replace('"', "")))
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn search(c: &Connection, q: &HashMap<String, String>) -> Value {
    let text = q.get("q").map(String::as_str).unwrap_or("").trim();
    let limit = q.get("limit").and_then(|l| l.parse::<i64>().ok()).unwrap_or(20).clamp(1, 100);
    let folder = q.get("folder").filter(|f| !f.is_empty());
    let tag = q.get("tag").map(|t| t.trim_start_matches('#').to_lowercase()).filter(|t| !t.is_empty());
    let from = q.get("from").and_then(|v| v.parse::<i64>().ok());
    let to = q.get("to").and_then(|v| v.parse::<i64>().ok());
    let mut sql = String::from(r#"SELECT n."id", n."title", n."folderId", n."tags", n."updatedAt", "#);
    let fq = fts_query(text);
    let mut p: Vec<rusqlite::types::Value> = vec![];
    if fq.is_empty() {
        sql.push_str(r#"substr(n."content",1,160) AS snip, 0.0 AS rank FROM "Note" n WHERE 1=1"#);
    } else {
        sql.push_str(r#"snippet("NoteFts", 1, '[[hl]]', '[[/hl]]', '…', 14) AS snip, bm25("NoteFts", 8.0, 1.0) AS rank FROM "NoteFts" JOIN "Note" n ON n.rowid = "NoteFts".rowid WHERE "NoteFts" MATCH ?"#);
        p.push(fq.clone().into());
    }
    if let Some(f) = folder {
        if f == "none" {
            sql.push_str(r#" AND n."folderId" IS NULL"#);
        } else {
            sql.push_str(r#" AND n."folderId" = ?"#);
            p.push(f.clone().into());
        }
    }
    if let Some(f) = from {
        sql.push_str(r#" AND n."updatedAt" >= ?"#);
        p.push(f.into());
    }
    if let Some(t) = to {
        sql.push_str(r#" AND n."updatedAt" <= ?"#);
        p.push(t.into());
    }
    sql.push_str(if fq.is_empty() { r#" ORDER BY n."updatedAt" DESC LIMIT 400"# } else { " ORDER BY rank LIMIT 400" });
    let t0 = std::time::Instant::now();
    let mut hits: Vec<Value> = query_vec(c, &sql, rusqlite::params_from_iter(p.iter()), |r| {
        Ok(json!({ "id": r.get::<_, String>(0)?, "title": r.get::<_, String>(1)?, "folderId": r.get::<_, Option<String>>(2)?, "tags": parse_tags(&r.get::<_, String>(3)?),
                   "updatedAt": r.get::<_, i64>(4)?, "snippet": r.get::<_, String>(5)?, "rank": r.get::<_, f64>(6)? }))
    });
    if let Some(t) = tag {
        let needle = format!("#{t}");
        let contents: HashMap<String, String> = all_notes(c).into_iter().map(|n| (n["id"].as_str().unwrap_or("").to_string(), n["content"].as_str().unwrap_or("").to_lowercase())).collect();
        hits.retain(|h| {
            h["tags"].as_array().map(|a| a.iter().any(|x| x.as_str().map(|s| s.to_lowercase() == t).unwrap_or(false))).unwrap_or(false)
                || contents.get(h["id"].as_str().unwrap_or("")).map(|c| c.contains(&needle)).unwrap_or(false)
        });
    }
    let total = hits.len();
    hits.truncate(limit as usize);
    json!({ "query": text, "fts": fq, "total": total, "ms": t0.elapsed().as_micros() as f64 / 1000.0, "hits": hits })
}

// ============================================================== backlinks

/// Notes linking to `id` via [[Title]] / [[Title|alias]] / [[Title#heading]].
pub fn backlinks(c: &Connection, id: &str) -> Vec<Value> {
    let Some(title) = c.query_row(r#"SELECT "title" FROM "Note" WHERE "id"=?1"#, params![id], |r| r.get::<_, String>(0)).optional().ok().flatten() else {
        return vec![];
    };
    let key = title_key(&title);
    let mut out = vec![];
    for n in all_notes(c) {
        if n["id"].as_str() == Some(id) {
            continue;
        }
        let content = n["content"].as_str().unwrap_or("");
        let mut ctx_line: Option<String> = None;
        for line in content.lines() {
            if wikilinks(line).iter().any(|l| title_key(l) == key) {
                ctx_line = Some(take(line.trim(), 200));
                break;
            }
        }
        if let Some(line) = ctx_line {
            out.push(json!({ "id": n["id"], "title": n["title"], "context": line, "updatedAt": n["updatedAt"] }));
        }
    }
    out
}

/// `[[Target|alias]]` → `Target` (heading/alias stripped).
pub fn wikilinks(text: &str) -> Vec<String> {
    let mut out = vec![];
    let mut rest = text;
    while let Some(i) = rest.find("[[") {
        let after = &rest[i + 2..];
        match after.find("]]") {
            Some(j) => {
                let inner = &after[..j];
                let target = inner.split(['|', '#']).next().unwrap_or("").trim();
                if !target.is_empty() {
                    out.push(target.to_string());
                }
                rest = &after[j + 2..];
            }
            None => break,
        }
    }
    out
}

// ============================================================== versions

pub fn versions(c: &Connection, id: &str) -> Vec<Value> {
    query_vec(c, r#"SELECT "id","title","content","createdAt" FROM "NoteVersion" WHERE "noteId"=?1 ORDER BY "createdAt" DESC LIMIT 50"#, params![id], |r| {
        let content: String = r.get(2)?;
        Ok(json!({ "id": r.get::<_, String>(0)?, "title": r.get::<_, String>(1)?, "content": content, "words": content.split_whitespace().count(), "createdAt": r.get::<_, i64>(3)? }))
    })
}

pub fn snapshot(c: &Connection, id: &str) -> Result<Value, String> {
    let (title, content): (String, String) = c.query_row(r#"SELECT "title","content" FROM "Note" WHERE "id"=?1"#, params![id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|_| "note not found".to_string())?;
    let vid = new_id();
    let now = now_ms();
    c.execute(r#"INSERT INTO "NoteVersion"("id","noteId","title","content","createdAt") VALUES (?1,?2,?3,?4,?5)"#, params![vid, id, title, content, now]).map_err(|e| e.to_string())?;
    Ok(json!({ "id": vid, "createdAt": now }))
}

pub fn restore_version(c: &Connection, id: &str, vid: &str) -> Result<Value, String> {
    let (title, content): (String, String) = c
        .query_row(r#"SELECT "title","content" FROM "NoteVersion" WHERE "id"=?1 AND "noteId"=?2"#, params![vid, id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|_| "version not found".to_string())?;
    snapshot(c, id)?; // keep the current text restorable too
    c.execute(r#"UPDATE "Note" SET "title"=?1,"content"=?2,"updatedAt"=?3 WHERE "id"=?4"#, params![title, content, now_ms(), id]).map_err(|e| e.to_string())?;
    c.query_row(r#"SELECT * FROM "Note" WHERE "id"=?1"#, params![id], note_row).map_err(|e| e.to_string())
}

// ============================================================== templates

const BUILTIN_TEMPLATES: &[(&str, &str, &str, &str)] = &[
    ("tpl-daily", "Daily note", "calendar", "# {{date}}\n\n## Focus\n- [ ] \n\n## Notes\n\n\n## Done today\n\n"),
    ("tpl-meeting", "Meeting notes", "users", "# {{title}}\n\n**Date:** {{date}} {{time}}\n**People:** \n\n## Agenda\n- \n\n## Notes\n\n## Action items\n- [ ] \n"),
    ("tpl-project", "Project brief", "rocket", "# {{title}}\n\n## Goal\n\n## Why it matters\n\n## Milestones\n- [ ] \n\n## Links\n- \n\n#project\n"),
    ("tpl-book", "Book notes", "book", "# {{title}}\n\n**Author:** \n**Started:** {{date}}\n\n## Big ideas\n- \n\n## Quotes\n> \n\n## What I'll do differently\n- \n\n#reading\n"),
    ("tpl-weekly", "Weekly review", "chart", "# Week of {{date}}\n\n## Wins\n- \n\n## What slipped\n- \n\n## Next week's top 3\n- [ ] \n- [ ] \n- [ ] \n"),
];

pub fn seed_templates(c: &Connection) {
    for (id, name, icon, content) in BUILTIN_TEMPLATES {
        let _ = c.execute(r#"INSERT OR IGNORE INTO "Template"("id","name","icon","content","builtin","createdAt") VALUES (?1,?2,?3,?4,1,?5)"#, params![id, name, icon, content, now_ms()]);
    }
}

pub fn templates(c: &Connection) -> Vec<Value> {
    query_vec(c, r#"SELECT "id","name","icon","content","builtin" FROM "Template" ORDER BY "builtin" DESC, "createdAt" ASC"#, [], |r| {
        Ok(json!({ "id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "icon": r.get::<_, String>(2)?, "content": r.get::<_, String>(3)?, "builtin": r.get::<_, i64>(4)? != 0 }))
    })
}

fn template_save(c: &Connection, b: &Map<String, Value>) -> R {
    let name = s(b.get("name"), 80);
    let content = s(b.get("content"), 50_000);
    if name.is_empty() {
        return R::err(400, "name required");
    }
    let id = str_of(b.get("id")).filter(|x| is_word_id(x, 3, 60, &[]) && !x.starts_with("tpl-")).map(String::from).unwrap_or_else(|| format!("utpl-{}", &new_id()[..8]));
    let icon = str_of(b.get("icon")).unwrap_or("file-text");
    match c.execute(
        r#"INSERT INTO "Template"("id","name","icon","content","builtin","createdAt") VALUES (?1,?2,?3,?4,0,?5) ON CONFLICT("id") DO UPDATE SET "name"=?2,"icon"=?3,"content"=?4"#,
        params![id, name, icon, content, now_ms()],
    ) {
        Ok(_) => R::json(json!({ "ok": true, "id": id })),
        Err(e) => R::err(500, &e.to_string()),
    }
}

pub fn fill_template(t: &str, title: &str, now: i64) -> String {
    use chrono::TimeZone;
    let dt = chrono::Local.timestamp_millis_opt(now).single().unwrap_or_else(chrono::Local::now);
    t.replace("{{title}}", title).replace("{{date}}", &dt.format("%Y-%m-%d").to_string()).replace("{{time}}", &dt.format("%H:%M").to_string()).replace("{{weekday}}", &dt.format("%A").to_string())
}

// ============================================================== daily notes + calendar

fn valid_date(d: &str) -> bool {
    chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").is_ok()
}

/// The daily note for `date` (YYYY-MM-DD), creating it from the Daily template when asked.
pub fn daily_note(c: &Connection, date: &str, create: bool) -> Result<Value, String> {
    if !valid_date(date) {
        return Err("date must be YYYY-MM-DD".into());
    }
    if let Some(n) = c.query_row(r#"SELECT * FROM "Note" WHERE "title"=?1 ORDER BY "createdAt" ASC LIMIT 1"#, params![date], note_row).optional().map_err(|e| e.to_string())? {
        return Ok(json!({ "note": n, "created": false }));
    }
    if !create {
        return Err("no daily note".into());
    }
    let tpl: String = c.query_row(r#"SELECT "content" FROM "Template" WHERE "id"='tpl-daily'"#, [], |r| r.get(0)).unwrap_or_else(|_| "# {{date}}\n\n".into());
    let content = tpl.replace("{{date}}", date).replace("{{title}}", date);
    let folder: Option<String> = c.query_row(r#"SELECT "id" FROM "Folder" WHERE lower("name")='journal' LIMIT 1"#, [], |r| r.get(0)).optional().ok().flatten();
    let id = new_id();
    let now = now_ms();
    c.execute(
        r#"INSERT INTO "Note"("id","title","content","cover","pinned","folderId","tags","createdAt","updatedAt") VALUES (?1,?2,?3,NULL,0,?4,'["daily"]',?5,?5)"#,
        params![id, date, content, folder, now],
    )
    .map_err(|e| e.to_string())?;
    let n = c.query_row(r#"SELECT * FROM "Note" WHERE "id"=?1"#, params![id], note_row).map_err(|e| e.to_string())?;
    Ok(json!({ "note": n, "created": true }))
}

/// Append markdown to a day's daily note (used by Timelens auto-journal and agent tools).
pub fn append_daily(c: &Connection, date: &str, text: &str) -> Result<Value, String> {
    let d = daily_note(c, date, true)?;
    let id = d["note"]["id"].as_str().unwrap_or("").to_string();
    let content = d["note"]["content"].as_str().unwrap_or("").trim_end().to_string();
    let next = format!("{content}\n\n{}\n", text.trim());
    c.execute(r#"UPDATE "Note" SET "content"=?1,"updatedAt"=?2 WHERE "id"=?3"#, params![next, now_ms(), id]).map_err(|e| e.to_string())?;
    Ok(json!({ "id": id, "title": date }))
}

/// Month overview: which days have a daily note, notes edited, tasks due.
pub fn calendar(c: &Connection, month: &str) -> Value {
    use chrono::{Datelike, NaiveDate, TimeZone};
    let first = NaiveDate::parse_from_str(&format!("{month}-01"), "%Y-%m-%d").unwrap_or_else(|_| {
        let t = chrono::Local::now().date_naive();
        NaiveDate::from_ymd_opt(t.year(), t.month(), 1).unwrap_or(t)
    });
    let next = if first.month() == 12 { NaiveDate::from_ymd_opt(first.year() + 1, 1, 1) } else { NaiveDate::from_ymd_opt(first.year(), first.month() + 1, 1) }.unwrap_or(first);
    let ms = |d: NaiveDate| chrono::Local.from_local_datetime(&d.and_hms_opt(0, 0, 0).unwrap_or_default()).earliest().map(|x| x.timestamp_millis()).unwrap_or(0);
    let (from, to) = (ms(first), ms(next));
    let mut days: HashMap<String, Value> = HashMap::new();
    let key = |ts: i64| timelens::local_day_key(ts);
    for n in all_notes(c) {
        let title = n["title"].as_str().unwrap_or("");
        if valid_date(title) && title >= first.format("%Y-%m-%d").to_string().as_str() && title < next.format("%Y-%m-%d").to_string().as_str() {
            let e = days.entry(title.to_string()).or_insert_with(|| json!({ "edited": 0, "due": 0 }));
            e["daily"] = json!(n["id"]);
            e["words"] = json!(n["content"].as_str().unwrap_or("").split_whitespace().count());
        }
        let u = n["updatedAt"].as_i64().unwrap_or(0);
        if u >= from && u < to {
            let e = days.entry(key(u)).or_insert_with(|| json!({ "edited": 0, "due": 0 }));
            e["edited"] = json!(e["edited"].as_i64().unwrap_or(0) + 1);
        }
    }
    for t in query_vec(c, r#"SELECT * FROM "Task" WHERE "due" >= ?1 AND "due" < ?2"#, params![from, to], task_row) {
        let e = days.entry(key(t["due"].as_i64().unwrap_or(0))).or_insert_with(|| json!({ "edited": 0, "due": 0 }));
        e["due"] = json!(e["due"].as_i64().unwrap_or(0) + 1);
        let mut list = e["tasks"].as_array().cloned().unwrap_or_default();
        list.push(json!({ "id": t["id"], "title": t["title"], "done": t["done"] }));
        e["tasks"] = Value::Array(list);
    }
    json!({ "month": first.format("%Y-%m").to_string(), "firstWeekday": first.weekday().num_days_from_monday(), "daysInMonth": (next - first).num_days(), "days": days, "today": key(now_ms()) })
}

// ============================================================== export / import

pub fn md_to_html(md: &str, title: &str) -> String {
    fn esc(s: &str) -> String {
        s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
    }
    fn inline(s: &str) -> String {
        let mut out = esc(s);
        // code spans first so their content is left alone
        let mut res = String::new();
        let mut code = false;
        for (i, part) in out.split('`').enumerate() {
            if i > 0 {
                code = !code;
                res.push_str(if code { "<code>" } else { "</code>" });
            }
            if code {
                res.push_str(part);
            } else {
                let mut p = part.to_string();
                p = replace_pairs(&p, "**", "<strong>", "</strong>");
                p = replace_pairs(&p, "*", "<em>", "</em>");
                p = replace_pairs(&p, "~~", "<del>", "</del>");
                p = links(&p);
                res.push_str(&p);
            }
        }
        if code {
            res.push_str("</code>");
        }
        out = res;
        out
    }
    fn replace_pairs(s: &str, mark: &str, open: &str, close: &str) -> String {
        let parts: Vec<&str> = s.split(mark).collect();
        if parts.len() < 3 {
            return s.to_string();
        }
        let mut out = String::new();
        let pairs = (parts.len() - 1) / 2 * 2;
        for (i, p) in parts.iter().enumerate() {
            if i > 0 {
                if i <= pairs {
                    out.push_str(if i % 2 == 1 { open } else { close });
                } else {
                    out.push_str(mark);
                }
            }
            out.push_str(p);
        }
        out
    }
    fn links(s: &str) -> String {
        // [[wikilink]] → <a class="wikilink">, [text](url) → <a href>
        let mut out = String::new();
        let mut rest = s;
        while let Some(i) = rest.find("[[") {
            out.push_str(&rest[..i]);
            let after = &rest[i + 2..];
            if let Some(j) = after.find("]]") {
                let inner = &after[..j];
                let shown = inner.split('|').nth(1).unwrap_or(inner.split('|').next().unwrap_or(inner));
                out.push_str(&format!("<a class=\"wikilink\" href=\"nook://note/{}\">{}</a>", inner.split(['|', '#']).next().unwrap_or("").trim().replace(' ', "%20"), shown));
                rest = &after[j + 2..];
            } else {
                out.push_str("[[");
                rest = after;
            }
        }
        out.push_str(rest);
        let mut res = String::new();
        let mut rest = out.as_str();
        while let Some(i) = rest.find('[') {
            let after = &rest[i + 1..];
            match (after.find("]("), after.find(')')) {
                (Some(j), Some(k)) if k > j => {
                    let text = &after[..j];
                    let url = &after[j + 2..k];
                    if url.starts_with("http://") || url.starts_with("https://") || url.starts_with("nook://") || url.starts_with("mailto:") {
                        res.push_str(&rest[..i]);
                        res.push_str(&format!("<a href=\"{url}\">{text}</a>"));
                        rest = &after[k + 1..];
                        continue;
                    }
                    res.push_str(&rest[..=i]);
                    rest = after;
                }
                _ => {
                    res.push_str(&rest[..=i]);
                    rest = after;
                }
            }
        }
        res.push_str(rest);
        res
    }
    let mut html = String::new();
    let mut in_code = false;
    let mut list: Option<&str> = None;
    let close_list = |html: &mut String, list: &mut Option<&str>| {
        if let Some(l) = list.take() {
            html.push_str(&format!("</{l}>\n"));
        }
    };
    for raw in md.lines() {
        let line = raw.trim_end();
        if line.trim_start().starts_with("```") {
            close_list(&mut html, &mut list);
            html.push_str(if in_code { "</code></pre>\n" } else { "<pre><code>" });
            in_code = !in_code;
            continue;
        }
        if in_code {
            html.push_str(&esc(raw));
            html.push('\n');
            continue;
        }
        let t = line.trim_start();
        if t.is_empty() {
            close_list(&mut html, &mut list);
            continue;
        }
        let hashes = t.chars().take_while(|c| *c == '#').count();
        if (1..=6).contains(&hashes) && t[hashes..].starts_with(' ') {
            close_list(&mut html, &mut list);
            html.push_str(&format!("<h{hashes}>{}</h{hashes}>\n", inline(t[hashes..].trim())));
        } else if let Some((done, text)) = todo_line(t) {
            if list != Some("ul") {
                close_list(&mut html, &mut list);
                html.push_str("<ul class=\"tasks\">\n");
                list = Some("ul");
            }
            html.push_str(&format!("<li><input type=\"checkbox\" disabled{}> {}</li>\n", if done { " checked" } else { "" }, inline(text)));
        } else if let Some(rest) = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")) {
            if list != Some("ul") {
                close_list(&mut html, &mut list);
                html.push_str("<ul>\n");
                list = Some("ul");
            }
            html.push_str(&format!("<li>{}</li>\n", inline(rest)));
        } else if t.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) && t.contains(". ") && t.split(". ").next().map(|n| n.chars().all(|c| c.is_ascii_digit())).unwrap_or(false) {
            if list != Some("ol") {
                close_list(&mut html, &mut list);
                html.push_str("<ol>\n");
                list = Some("ol");
            }
            html.push_str(&format!("<li>{}</li>\n", inline(t.split_once(". ").map(|x| x.1).unwrap_or(""))));
        } else if let Some(q) = t.strip_prefix('>') {
            close_list(&mut html, &mut list);
            html.push_str(&format!("<blockquote>{}</blockquote>\n", inline(q.trim())));
        } else if t == "---" || t == "***" {
            close_list(&mut html, &mut list);
            html.push_str("<hr>\n");
        } else {
            close_list(&mut html, &mut list);
            html.push_str(&format!("<p>{}</p>\n", inline(t)));
        }
    }
    if in_code {
        html.push_str("</code></pre>\n");
    }
    close_list(&mut html, &mut list);
    format!(
        "<!doctype html>\n<html><head><meta charset=\"utf-8\"><title>{}</title><style>body{{font:16px/1.6 -apple-system,'Segoe UI',system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 24px;color:#1d1f23}}h1,h2,h3{{line-height:1.25}}code{{background:#f1f2f4;padding:1px 5px;border-radius:4px}}pre{{background:#f1f2f4;padding:12px;border-radius:8px;overflow:auto}}pre code{{background:none;padding:0}}blockquote{{border-left:3px solid #c9ccd2;margin:0;padding-left:14px;color:#555}}a{{color:#3b6fd4}}ul.tasks{{list-style:none;padding-left:4px}}@media print{{body{{margin:0}}}}</style></head><body>\n{}</body></html>\n",
        esc(title),
        html
    )
}

fn safe_file_name(t: &str) -> String {
    let n: String = t.chars().filter(|c| !"\\/:*?\"<>|".contains(*c)).collect::<String>().trim().chars().take(80).collect();
    if n.is_empty() {
        "note".into()
    } else {
        n
    }
}

fn export_note(c: &Connection, id: &str, format: &str) -> R {
    let Some(n) = c.query_row(r#"SELECT * FROM "Note" WHERE "id"=?1"#, params![id], note_row).optional().ok().flatten() else {
        return R::err(404, "not found");
    };
    let title = n["title"].as_str().unwrap_or("note");
    let content = n["content"].as_str().unwrap_or("");
    let has_h1 = content.trim_start().starts_with("# ");
    let md = if has_h1 { content.to_string() } else { format!("# {title}\n\n{content}") };
    match format {
        "html" => R { status: 200, body: Body::Bytes { mime: "text/html; charset=utf-8".into(), name: format!("{}.html", safe_file_name(title)), data: md_to_html(&md, title).into_bytes() } },
        _ => {
            let tags = n["tags"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(", ")).unwrap_or_default();
            let front = format!("---\ntitle: \"{}\"\ntags: [{}]\ncreated: {}\nupdated: {}\n---\n\n", title.replace('"', "'"), tags, crate::db::iso(n["createdAt"].as_i64().unwrap_or(0)), crate::db::iso(n["updatedAt"].as_i64().unwrap_or(0)));
            R { status: 200, body: Body::Bytes { mime: "text/markdown; charset=utf-8".into(), name: format!("{}.md", safe_file_name(title)), data: (front + &md).into_bytes() } }
        }
    }
}

/// Split YAML front matter: returns (title, tags, body).
pub fn parse_front_matter(text: &str) -> (Option<String>, Vec<String>, String) {
    let t = text.trim_start_matches('\u{feff}');
    if let Some(rest) = t.strip_prefix("---\n").or_else(|| t.strip_prefix("---\r\n")) {
        if let Some(end) = rest.find("\n---") {
            let fm = &rest[..end];
            let body = rest[end + 4..].trim_start_matches(['\r', '\n']).to_string();
            let mut title = None;
            let mut tags = vec![];
            let mut in_tags = false;
            for line in fm.lines() {
                let l = line.trim();
                if let Some(v) = l.strip_prefix("title:") {
                    title = Some(v.trim().trim_matches(['"', '\'']).to_string()).filter(|s| !s.is_empty());
                    in_tags = false;
                } else if let Some(v) = l.strip_prefix("tags:") {
                    let v = v.trim();
                    in_tags = v.is_empty();
                    tags.extend(v.trim_matches(['[', ']']).split(',').map(|x| x.trim().trim_matches(['"', '\'', '#']).to_string()).filter(|x| !x.is_empty()));
                } else if in_tags && l.starts_with("- ") {
                    tags.push(l[2..].trim().trim_matches(['"', '\'', '#']).to_string());
                } else {
                    in_tags = false;
                }
            }
            return (title, tags, body);
        }
    }
    (None, vec![], t.to_string())
}

/// Import Markdown files (Obsidian vault folders included): `{ files: [{ path, content }] }`.
/// Directories become folders (first path segment), front matter becomes title/tags.
pub fn import(c: &Connection, b: &Map<String, Value>) -> Value {
    let files = b.get("files").and_then(|f| f.as_array()).cloned().unwrap_or_default();
    let mut created = 0;
    let mut skipped = 0;
    let mut folders: HashMap<String, String> = HashMap::new();
    let now = now_ms();
    for f in files.iter().take(5000) {
        let path = f["path"].as_str().unwrap_or("").replace('\\', "/");
        let content = f["content"].as_str().unwrap_or("");
        if !(path.ends_with(".md") || path.ends_with(".markdown") || path.ends_with(".txt")) || path.split('/').any(|p| p.starts_with('.')) {
            skipped += 1;
            continue;
        }
        let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
        let file = parts.last().copied().unwrap_or("note.md");
        let stem = file.rsplit_once('.').map(|x| x.0).unwrap_or(file);
        // root folder of an uploaded vault is the vault name itself; use the next level
        let folder_name = if parts.len() >= 3 { Some(parts[parts.len() - 2]) } else { None };
        let folder_id = folder_name.map(|name| {
            folders
                .entry(name.to_string())
                .or_insert_with(|| {
                    let existing: Option<String> = c.query_row(r#"SELECT "id" FROM "Folder" WHERE "name"=?1"#, params![name], |r| r.get(0)).optional().ok().flatten();
                    existing.unwrap_or_else(|| {
                        let id = new_id();
                        let pos: i64 = c.query_row(r#"SELECT COALESCE(MAX("position"),0)+1 FROM "Folder""#, [], |r| r.get(0)).unwrap_or(0);
                        let _ = c.execute(r#"INSERT INTO "Folder"("id","name","icon","color","position","createdAt") VALUES (?1,?2,'folder','',?3,?4)"#, params![id, take(name, 60), pos, now]);
                        id
                    })
                })
                .clone()
        });
        let (fm_title, tags, body) = parse_front_matter(content);
        let title = take(&fm_title.unwrap_or_else(|| stem.to_string()), 200);
        let tags_json = Value::from(tags.into_iter().take(20).collect::<Vec<_>>()).to_string();
        let r = c.execute(
            r#"INSERT INTO "Note"("id","title","content","cover","pinned","folderId","tags","createdAt","updatedAt") VALUES (?1,?2,?3,NULL,0,?4,?5,?6,?6)"#,
            params![new_id(), title, take(&body, 500_000), folder_id, tags_json, now],
        );
        if r.is_ok() {
            created += 1;
        } else {
            skipped += 1;
        }
    }
    json!({ "ok": true, "created": created, "skipped": skipped, "folders": folders.len() })
}

// ============================================================== conversations

fn conversation(c: &Connection, id: &str) -> Option<Value> {
    c.query_row(r#"SELECT "id","title","model","messages","createdAt","updatedAt" FROM "Conversation" WHERE "id"=?1"#, params![id], |r| {
        Ok(json!({ "id": r.get::<_, String>(0)?, "title": r.get::<_, String>(1)?, "model": r.get::<_, String>(2)?, "messages": serde_json::from_str::<Value>(&r.get::<_, String>(3)?).unwrap_or(json!([])),
                   "createdAt": r.get::<_, i64>(4)?, "updatedAt": r.get::<_, i64>(5)? }))
    })
    .optional()
    .ok()
    .flatten()
}

fn conversation_save(c: &Connection, id: &str, b: &Map<String, Value>) -> R {
    if !is_word_id(id, 3, 60, &[]) {
        return R::err(400, "bad id");
    }
    let msgs = match b.get("messages") {
        Some(Value::Array(a)) => Value::Array(a.iter().rev().take(200).rev().cloned().collect()),
        _ => conversation(c, id).map(|v| v["messages"].clone()).unwrap_or(json!([])),
    };
    let first_user = msgs.as_array().and_then(|a| a.iter().find(|m| m["role"] == "user")).and_then(|m| m["text"].as_str().or(m["content"].as_str())).map(|t| take(t.lines().next().unwrap_or(""), 60));
    let title = str_of(b.get("title")).map(|t| take(t, 80)).or(first_user).unwrap_or_else(|| "New chat".into());
    let model = s(b.get("model"), 120);
    let now = now_ms();
    let r = c.execute(
        r#"INSERT INTO "Conversation"("id","title","model","messages","createdAt","updatedAt") VALUES (?1,?2,?3,?4,?5,?5)
           ON CONFLICT("id") DO UPDATE SET "title"=?2, "model"=CASE WHEN ?3='' THEN "model" ELSE ?3 END, "messages"=?4, "updatedAt"=?5"#,
        params![id, title, model, msgs.to_string(), now],
    );
    match r {
        Ok(_) => R::json(conversation(c, id).unwrap_or(Value::Null)),
        Err(e) => R::err(500, &e.to_string()),
    }
}

// ============================================================== tasks: recurrence + reminders

/// Next due date for a repeating task.
pub fn next_due(due: i64, repeat: &str) -> Option<i64> {
    use chrono::{Datelike, Duration, TimeZone};
    let dt = chrono::Local.timestamp_millis_opt(due).single()?;
    let next = match repeat {
        "daily" => dt + Duration::days(1),
        "weekly" => dt + Duration::days(7),
        "weekdays" => {
            let mut d = dt + Duration::days(1);
            while d.weekday().num_days_from_monday() >= 5 {
                d += Duration::days(1);
            }
            d
        }
        "monthly" => {
            let (y, m) = if dt.month() == 12 { (dt.year() + 1, 1) } else { (dt.year(), dt.month() + 1) };
            let day = dt.day().min(28);
            dt.with_day(1)?.with_year(y)?.with_month(m)?.with_day(day)?
        }
        _ => return None,
    };
    Some(next.timestamp_millis())
}

pub const REPEATS: &[&str] = &["", "daily", "weekdays", "weekly", "monthly"];
pub const STATUSES: &[&str] = &["todo", "doing", "done"];

/// Called after a task flips to done: spawn the next occurrence of a repeating task.
pub fn spawn_next_occurrence(c: &Connection, id: &str) -> Option<Value> {
    let t = c.query_row(r#"SELECT * FROM "Task" WHERE "id"=?1"#, params![id], task_row).optional().ok().flatten()?;
    let repeat = t["repeat"].as_str().unwrap_or("");
    if repeat.is_empty() {
        return None;
    }
    let base = t["due"].as_i64().unwrap_or_else(now_ms);
    let due = next_due(base, repeat)?;
    let remind = t["remindAt"].as_i64().map(|r| r + (due - base));
    let nid = new_id();
    c.execute(
        r#"INSERT INTO "Task"("id","title","list","priority","due","done","noteId","tags","by","createdAt","completedAt","status","remindAt","repeat") VALUES (?1,?2,?3,?4,?5,0,?6,?7,?8,?9,NULL,'todo',?10,?11)"#,
        params![nid, t["title"].as_str(), t["list"].as_str(), t["priority"].as_i64(), due, t["noteId"].as_str(), t["tags"].to_string(), t["by"].as_str(), now_ms(), remind, repeat],
    )
    .ok()?;
    // the finished one stops repeating so it isn't spawned twice
    let _ = c.execute(r#"UPDATE "Task" SET "repeat"='' WHERE "id"=?1"#, params![id]);
    c.query_row(r#"SELECT * FROM "Task" WHERE "id"=?1"#, params![nid], task_row).ok()
}

/// Open tasks whose reminder time has come. `mark` stamps them so each fires once.
pub fn due_reminders(c: &Connection, now: i64, mark: bool) -> Vec<Value> {
    let rows = query_vec(c, r#"SELECT * FROM "Task" WHERE "done"=0 AND "remindAt" IS NOT NULL AND "remindAt" <= ?1 AND "notifiedAt" IS NULL ORDER BY "remindAt" ASC LIMIT 20"#, params![now], task_row);
    if mark {
        for t in &rows {
            let _ = c.execute(r#"UPDATE "Task" SET "notifiedAt"=?1 WHERE "id"=?2"#, params![now, t["id"].as_str()]);
        }
    }
    rows
}

// ============================================================== encrypted backup

const MAGIC: &[u8; 8] = b"NOOKBAK1";
const KDF_ITERS: u32 = 120_000;

fn derive_key(password: &str, salt: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(password.as_bytes(), salt, KDF_ITERS, &mut key);
    key
}

/// Encrypt bytes: MAGIC | salt(16) | nonce(12) | ChaCha20-Poly1305 ciphertext.
pub fn encrypt(data: &[u8], password: &str) -> Result<Vec<u8>, String> {
    use chacha20poly1305::aead::{Aead, KeyInit};
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 12];
    getrandom::fill(&mut salt).map_err(|e| e.to_string())?;
    getrandom::fill(&mut nonce).map_err(|e| e.to_string())?;
    let key = derive_key(password, &salt);
    let cipher = chacha20poly1305::ChaCha20Poly1305::new((&key).into());
    let ct = cipher.encrypt((&nonce).into(), data).map_err(|_| "encryption failed".to_string())?;
    let mut out = Vec::with_capacity(36 + ct.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

pub fn decrypt(blob: &[u8], password: &str) -> Result<Vec<u8>, String> {
    use chacha20poly1305::aead::{Aead, KeyInit};
    if blob.len() < 36 || &blob[..8] != MAGIC {
        return Err("not a Nook backup".into());
    }
    let key = derive_key(password, &blob[8..24]);
    let cipher = chacha20poly1305::ChaCha20Poly1305::new((&key).into());
    let nonce: [u8; 12] = blob[24..36].try_into().map_err(|_| "corrupt header".to_string())?;
    cipher.decrypt((&nonce).into(), &blob[36..]).map_err(|_| "wrong password or corrupted backup".to_string())
}

fn tmp_path(tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!("nook-{tag}-{}.db", &new_id()[..8]))
}

/// Snapshot the live vault (VACUUM INTO), encrypt it and write it into `dir`.
pub fn backup_to(c: &Connection, dir: &Path, password: &str) -> Result<PathBuf, String> {
    if password.len() < 4 {
        return Err("password must be at least 4 characters".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("can't create {}: {e}", dir.display()))?;
    let tmp = tmp_path("snap");
    c.execute("VACUUM INTO ?1", params![tmp.to_string_lossy()]).map_err(|e| e.to_string())?;
    let bytes = std::fs::read(&tmp).map_err(|e| e.to_string());
    let _ = std::fs::remove_file(&tmp);
    let blob = encrypt(&bytes?, password)?;
    let name = format!("nook-backup-{}.nookbak", chrono::Local::now().format("%Y%m%d-%H%M%S"));
    let path = dir.join(name);
    std::fs::write(&path, blob).map_err(|e| e.to_string())?;
    setting_put(c, "backup-last", &now_ms().to_string())?;
    // keep the 14 newest
    let mut all = list_backups(dir);
    if all.len() > 14 {
        for old in all.drain(14..) {
            if let Some(p) = old["path"].as_str() {
                let _ = std::fs::remove_file(p);
            }
        }
    }
    Ok(path)
}

/// Decrypt a backup and copy it over the live vault (SQLite online backup API).
pub fn restore_from(c: &Connection, file: &Path, password: &str) -> Result<(), String> {
    let blob = std::fs::read(file).map_err(|e| format!("can't read backup: {e}"))?;
    let db = decrypt(&blob, password)?;
    let tmp = tmp_path("restore");
    std::fs::write(&tmp, db).map_err(|e| e.to_string())?;
    let src = Connection::open(&tmp).map_err(|e| e.to_string())?;
    let ok: String = src.query_row("PRAGMA integrity_check", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if ok != "ok" {
        let _ = std::fs::remove_file(&tmp);
        return Err("backup failed its integrity check".into());
    }
    // keep the backup settings of THIS install
    let keep = setting_get(c, "backup-config");
    {
        let backup = rusqlite::backup::Backup::new(&src, unsafe_conn(c)).map_err(|e| e.to_string())?;
        backup.run_to_completion(256, std::time::Duration::from_millis(0), None).map_err(|e| e.to_string())?;
    }
    drop(src);
    let _ = std::fs::remove_file(&tmp);
    if let Some(k) = keep {
        let _ = setting_put(c, "backup-config", &k);
    }
    Ok(())
}

/// rusqlite's Backup wants `&mut Connection`; the vault hands out a shared guard. The backup
/// API is safe on the same connection object, so we cast away the shared borrow here.
#[allow(invalid_reference_casting, clippy::mut_from_ref)]
fn unsafe_conn(c: &Connection) -> &mut Connection {
    // SAFETY: the caller holds the vault mutex guard for the duration of the restore, so no
    // other reference uses this connection concurrently.
    unsafe { &mut *(c as *const Connection as *mut Connection) }
}

pub fn list_backups(dir: &Path) -> Vec<Value> {
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    let mut v: Vec<Value> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".nookbak"))
        .map(|e| {
            let md = e.metadata().ok();
            json!({ "name": e.file_name().to_string_lossy(), "path": e.path().to_string_lossy(), "size": md.as_ref().map(|m| m.len()).unwrap_or(0) })
        })
        .collect();
    v.sort_by(|a, b| b["name"].as_str().cmp(&a["name"].as_str()));
    v
}

/// (dir, password, auto)
fn backup_config(c: &Connection) -> (Option<String>, Option<String>) {
    let v: Value = setting_get(c, "backup-config").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!({}));
    (v["dir"].as_str().filter(|s| !s.is_empty()).map(String::from), v["password"].as_str().filter(|s| !s.is_empty()).map(String::from))
}

fn backup_config_public(c: &Connection) -> Value {
    let v: Value = setting_get(c, "backup-config").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!({}));
    let last = setting_get(c, "backup-last").and_then(|s| s.parse::<i64>().ok());
    json!({ "dir": v["dir"], "auto": v["auto"].as_bool().unwrap_or(false), "hasPassword": v["password"].as_str().map(|p| !p.is_empty()).unwrap_or(false), "last": last,
            "backups": v["dir"].as_str().map(|d| list_backups(Path::new(d))).unwrap_or_default() })
}

fn backup_config_put(c: &Connection, b: &Map<String, Value>) -> R {
    let mut v: Value = setting_get(c, "backup-config").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!({}));
    for k in ["dir", "auto", "password"] {
        if let Some(x) = b.get(k) {
            v[k] = x.clone();
        }
    }
    match setting_put(c, "backup-config", &v.to_string()) {
        Ok(_) => R::json(backup_config_public(c)),
        Err(e) => R::err(500, &e),
    }
}

/// Daily auto-backup when enabled and due.
fn auto_backup(c: &Connection, now: i64) -> Option<Value> {
    let v: Value = setting_get(c, "backup-config").and_then(|s| serde_json::from_str(&s).ok())?;
    if !v["auto"].as_bool().unwrap_or(false) {
        return None;
    }
    let last = setting_get(c, "backup-last").and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
    if now - last < 86_400_000 {
        return None;
    }
    let (dir, pw) = backup_config(c);
    let r = backup_to(c, Path::new(&dir?), &pw?);
    Some(match r {
        Ok(p) => json!({ "kind": "backup", "title": "Backup saved", "body": format!("Encrypted backup written to {}", p.display()) }),
        Err(e) => json!({ "kind": "backup", "title": "Backup failed", "body": e }),
    })
}

// ============================================================== maintenance tick

/// Run every minute by the desktop shell (and on demand). Returns native notifications to show.
pub fn maintenance(c: &Connection, now: i64) -> Vec<Value> {
    let mut out: Vec<Value> = due_reminders(c, now, true)
        .into_iter()
        .map(|t| json!({ "kind": "reminder", "title": "Task reminder", "body": t["title"], "taskId": t["id"] }))
        .collect();
    out.extend(timelens::maintenance(c, now));
    if let Some(n) = auto_backup(c, now) {
        out.push(n);
    }
    out
}

pub fn maintenance_db(db: &Db) -> Vec<Value> {
    maintenance(&db.conn(), now_ms())
}

// ============================================================== agent + MCP tools

pub struct ExtTool {
    pub name: &'static str,
    pub desc: &'static str,
    pub args: &'static [(&'static str, &'static str)],
}

pub const EXT_TOOLS: &[ExtTool] = &[
    ExtTool { name: "fts_search", desc: "Fast full-text search (SQLite FTS5) with optional folder/tag filters; returns ranked hits with highlighted snippets.", args: &[("query", "words to find"), ("tag", "optional tag filter"), ("limit", "max hits (default 8)")] },
    ExtTool { name: "daily_note", desc: "Open (creating if needed) the daily journal note for a date and optionally append markdown to it.", args: &[("date", "YYYY-MM-DD (default today)"), ("append", "markdown to append (optional)")] },
    ExtTool { name: "backlinks", desc: "List notes that link to a note via [[wikilinks]].", args: &[("title", "note title"), ("id", "or note id")] },
    ExtTool { name: "note_from_template", desc: "Create a note from a template (Daily note, Meeting notes, Project brief, Book notes, Weekly review or a custom one).", args: &[("template", "template name"), ("title", "note title")] },
    ExtTool { name: "set_reminder", desc: "Set a reminder (native notification) on a task, optionally repeating daily/weekdays/weekly/monthly.", args: &[("title", "task title (created if missing)"), ("at", "epoch ms or ISO date-time"), ("repeat", "optional: daily | weekdays | weekly | monthly")] },
    ExtTool { name: "move_task", desc: "Move a task on the Kanban board: todo, doing or done.", args: &[("title", "task title fragment"), ("id", "or task id"), ("status", "todo | doing | done")] },
    ExtTool { name: "timelens_today", desc: "Today's tracked computer time: active/AFK totals, productivity score, top apps, categories and current activity.", args: &[] },
    ExtTool { name: "timelens_range", desc: "Tracked time per day over the last N days with productivity scores and the current streak.", args: &[("days", "how many days (default 7)")] },
    ExtTool { name: "timelens_top_apps", desc: "Top apps (and browser sites) by time for today or the last N days.", args: &[("days", "1 = today (default)"), ("limit", "max rows (default 8)")] },
    ExtTool { name: "timelens_pause", desc: "Pause or resume the Timelens tracker.", args: &[("paused", "true to pause, false to resume (omit to toggle)")] },
];

fn find_task(c: &Connection, a: &Map<String, Value>) -> Option<Value> {
    if let Some(id) = str_of(a.get("id")) {
        if let Some(t) = c.query_row(r#"SELECT * FROM "Task" WHERE "id"=?1"#, params![id], task_row).optional().ok().flatten() {
            return Some(t);
        }
    }
    let t = s(a.get("title"), 200).to_lowercase();
    if t.is_empty() {
        return None;
    }
    query_vec(c, r#"SELECT * FROM "Task" ORDER BY "done" ASC, "createdAt" DESC"#, [], task_row).into_iter().find(|x| x["title"].as_str().unwrap_or("").to_lowercase().contains(&t))
}

fn parse_when(v: Option<&Value>) -> Option<i64> {
    match v {
        Some(Value::Number(n)) => n.as_i64(),
        Some(Value::String(s)) => s.parse::<i64>().ok().or_else(|| {
            use chrono::TimeZone;
            chrono::DateTime::parse_from_rfc3339(s).map(|d| d.timestamp_millis()).ok().or_else(|| {
                chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M").or_else(|_| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M")).ok().and_then(|n| chrono::Local.from_local_datetime(&n).earliest()).map(|d| d.timestamp_millis())
            })
        }),
        _ => None,
    }
}

/// Run an extension tool. `(ok, summary, data)`; None when the name isn't ours.
pub fn run_tool(c: &Connection, name: &str, a: &Map<String, Value>) -> Option<(bool, String, Option<Value>)> {
    let now = now_ms();
    Some(match name {
        "fts_search" => {
            let mut q = HashMap::new();
            q.insert("q".to_string(), s(a.get("query"), 200));
            q.insert("limit".to_string(), loose_num(a.get("limit")).unwrap_or(8.0).to_string().replace(".0", ""));
            if let Some(t) = str_of(a.get("tag")) {
                q.insert("tag".into(), t.to_string());
            }
            let r = search(c, &q);
            let hits = r["hits"].as_array().cloned().unwrap_or_default();
            let summary = if hits.is_empty() { "No notes matched.".to_string() } else { format!("{} hit(s): {}", r["total"], hits.iter().take(6).map(|h| format!("“{}”", h["title"].as_str().unwrap_or(""))).collect::<Vec<_>>().join(", ")) };
            (true, summary, Some(json!(hits.iter().map(|h| json!({ "id": h["id"], "title": h["title"], "snippet": h["snippet"].as_str().unwrap_or("").replace("[[hl]]", "").replace("[[/hl]]", "") })).collect::<Vec<_>>())))
        }
        "daily_note" => {
            let date = str_of(a.get("date")).map(String::from).unwrap_or_else(|| timelens::local_day_key(now));
            let text = s(a.get("append"), 8000);
            let r = if text.is_empty() { daily_note(c, &date, true).map(|d| d["note"].clone()) } else { append_daily(c, &date, &text) };
            match r {
                Ok(n) => (true, if text.is_empty() { format!("Daily note {date} is ready.") } else { format!("Appended to daily note {date}.") }, Some(json!({ "id": n["id"], "title": date }))),
                Err(e) => (false, e, None),
            }
        }
        "backlinks" => {
            let id = str_of(a.get("id")).map(String::from).or_else(|| {
                let t = s(a.get("title"), 200);
                all_notes(c).into_iter().find(|n| title_key(n["title"].as_str().unwrap_or("")) == title_key(&t)).and_then(|n| n["id"].as_str().map(String::from))
            });
            match id {
                Some(id) => {
                    let bl = backlinks(c, &id);
                    (true, if bl.is_empty() { "No notes link here yet.".into() } else { format!("Linked from: {}", bl.iter().map(|b| format!("“{}”", b["title"].as_str().unwrap_or(""))).collect::<Vec<_>>().join(", ")) }, Some(json!(bl)))
                }
                None => (false, "Note not found.".into(), None),
            }
        }
        "note_from_template" => {
            let tname = s(a.get("template"), 80).to_lowercase();
            let tpl = templates(c).into_iter().find(|t| t["name"].as_str().unwrap_or("").to_lowercase().contains(&tname) || t["id"].as_str() == Some(tname.as_str()));
            match tpl {
                Some(t) => {
                    let title = s(a.get("title"), 200);
                    let title = if title.is_empty() { t["name"].as_str().unwrap_or("Untitled").to_string() } else { title };
                    let content = fill_template(t["content"].as_str().unwrap_or(""), &title, now);
                    let id = new_id();
                    match c.execute(r#"INSERT INTO "Note"("id","title","content","cover","pinned","folderId","tags","createdAt","updatedAt") VALUES (?1,?2,?3,NULL,0,NULL,'[]',?4,?4)"#, params![id, title, content, now]) {
                        Ok(_) => (true, format!("Created “{title}” from {}.", t["name"].as_str().unwrap_or("template")), Some(json!({ "id": id, "title": title }))),
                        Err(e) => (false, e.to_string(), None),
                    }
                }
                None => (false, format!("No template like “{tname}”. Try: {}", templates(c).iter().map(|t| t["name"].as_str().unwrap_or("")).collect::<Vec<_>>().join(", ")), None),
            }
        }
        "set_reminder" => {
            let Some(at) = parse_when(a.get("at")) else { return Some((false, "A time is required (epoch ms or ISO date-time).".into(), None)) };
            let repeat = s(a.get("repeat"), 12);
            let repeat = if REPEATS.contains(&repeat.as_str()) { repeat } else { String::new() };
            let task = match find_task(c, a) {
                Some(t) => t,
                None => {
                    let title = s(a.get("title"), 200);
                    if title.is_empty() {
                        return Some((false, "A task title is required.".into(), None));
                    }
                    let id = new_id();
                    let _ = c.execute(r#"INSERT INTO "Task"("id","title","list","priority","due","done","noteId","tags","by","createdAt","completedAt") VALUES (?1,?2,'today',1,?3,0,NULL,'[]','ai',?4,NULL)"#, params![id, title, at, now]);
                    c.query_row(r#"SELECT * FROM "Task" WHERE "id"=?1"#, params![id], task_row).ok()?
                }
            };
            let id = task["id"].as_str().unwrap_or("");
            let _ = c.execute(r#"UPDATE "Task" SET "remindAt"=?1,"notifiedAt"=NULL,"repeat"=?2,"due"=COALESCE("due",?1) WHERE "id"=?3"#, params![at, repeat, id]);
            (true, format!("Reminder set for “{}” at {}{}.", task["title"].as_str().unwrap_or(""), crate::db::iso(at), if repeat.is_empty() { String::new() } else { format!(", repeating {repeat}") }), Some(json!({ "id": id, "remindAt": at })))
        }
        "move_task" => {
            let status = s(a.get("status"), 10);
            if !STATUSES.contains(&status.as_str()) {
                return Some((false, "status must be todo, doing or done".into(), None));
            }
            match find_task(c, a) {
                Some(t) => {
                    let done = status == "done";
                    let id = t["id"].as_str().unwrap_or("");
                    let _ = c.execute(r#"UPDATE "Task" SET "status"=?1,"done"=?2,"completedAt"=CASE WHEN ?2=1 THEN COALESCE("completedAt",?3) ELSE NULL END WHERE "id"=?4"#, params![status, done as i64, now, id]);
                    if done && !t["done"].as_bool().unwrap_or(false) {
                        spawn_next_occurrence(c, id);
                    }
                    (true, format!("Moved “{}” to {status}.", t["title"].as_str().unwrap_or("")), Some(json!({ "id": id, "status": status })))
                }
                None => (false, "Task not found.".into(), None),
            }
        }
        "timelens_today" => {
            let s = timelens::summary(c, timelens::local_day_start(now), now + 1);
            let summary = format!(
                "Today: {} active, score {}/100, top app {}. Productive {}, distracting {}.",
                timelens::fmt_secs(s["activeSecs"].as_i64().unwrap_or(0)),
                s["score"],
                s["topApp"].as_str().unwrap_or("—"),
                timelens::fmt_secs(s["categories"]["productive"].as_i64().unwrap_or(0)),
                timelens::fmt_secs(s["categories"]["distracting"].as_i64().unwrap_or(0))
            );
            let mut d = s.clone();
            if let Value::Object(m) = &mut d {
                m.remove("timeline");
            }
            (true, summary, Some(d))
        }
        "timelens_range" => {
            let days = loose_num(a.get("days")).unwrap_or(7.0).clamp(1.0, 90.0) as i64;
            let h = timelens::history(c, days, now);
            let total: i64 = h["days"].as_array().map(|a| a.iter().map(|d| d["activeSecs"].as_i64().unwrap_or(0)).sum()).unwrap_or(0);
            (true, format!("{} tracked over {days} day(s); streak {} productive day(s).", timelens::fmt_secs(total), h["streak"]), Some(json!({ "days": h["days"], "streak": h["streak"] })))
        }
        "timelens_top_apps" => {
            let days = loose_num(a.get("days")).unwrap_or(1.0).clamp(1.0, 90.0) as i64;
            let lim = loose_num(a.get("limit")).unwrap_or(8.0).clamp(1.0, 30.0) as usize;
            let from = timelens::local_day_start(now - (days - 1) * 86_400_000);
            let s = timelens::summary(c, from, now + 1);
            let apps: Vec<Value> = s["apps"].as_array().cloned().unwrap_or_default().into_iter().take(lim).collect();
            let txt = apps.iter().map(|x| format!("{} {}", x["app"].as_str().unwrap_or(""), timelens::fmt_secs(x["secs"].as_i64().unwrap_or(0)))).collect::<Vec<_>>().join(", ");
            (true, if txt.is_empty() { "Nothing tracked yet.".into() } else { format!("Top apps: {txt}") }, Some(json!({ "apps": apps, "sites": s["titles"] })))
        }
        "timelens_pause" => {
            let p = a.get("paused").and_then(|v| v.as_bool().or_else(|| v.as_str().map(|s| s == "true")));
            match timelens::set_paused(c, p) {
                Ok(p) => (true, if p { "Timelens paused — nothing is being recorded.".into() } else { "Timelens resumed.".into() }, Some(json!({ "paused": p }))),
                Err(e) => (false, e, None),
            }
        }
        _ => return None,
    })
}

/// MCP schemas for the extension tools.
pub fn mcp_catalog() -> Vec<Value> {
    EXT_TOOLS
        .iter()
        .map(|t| {
            let props: Map<String, Value> = t.args.iter().map(|(k, d)| (k.to_string(), json!({ "type": if *k == "paused" { "boolean" } else if ["limit", "days"].contains(k) { "number" } else { "string" }, "description": d }))).collect();
            json!({ "name": t.name, "description": t.desc, "inputSchema": { "type": "object", "properties": props } })
        })
        .collect()
}

pub fn mcp_call(c: &Connection, name: &str, a: &Map<String, Value>) -> Option<Result<Value, String>> {
    run_tool(c, name, a).map(|(ok, summary, data)| if ok { Ok(json!({ "ok": true, "summary": summary, "data": data })) } else { Err(summary) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Db {
        Db::open_in_memory().unwrap()
    }
    fn q(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }

    #[test]
    fn fts_search_ranks_filters_and_tracks_edits() {
        let d = db();
        let c = d.conn();
        let r = search(&c, &q(&[("q", "graph")]));
        assert!(r["total"].as_u64().unwrap() > 0);
        assert_eq!(r["hits"][0]["title"], "Graph view", "title matches rank first");
        assert!(r["hits"][0]["snippet"].as_str().unwrap().contains("[[hl]]"));
        // triggers keep the index fresh
        c.execute(r#"UPDATE "Note" SET "content"='zebracorn appears' WHERE "id"='n-graph'"#, []).unwrap();
        assert_eq!(search(&c, &q(&[("q", "zebracorn")]))["total"], 1);
        c.execute(r#"DELETE FROM "Note" WHERE "id"='n-graph'"#, []).unwrap();
        assert_eq!(search(&c, &q(&[("q", "zebracorn")]))["total"], 0);
        // hostile input never breaks the query
        assert!(search(&c, &q(&[("q", "\"AND OR (* NEAR")]))["hits"].is_array());
        assert_eq!(fts_query("hello wor-ld!"), "\"hello\"* \"wor-ld\"*");
    }

    #[test]
    fn backlinks_and_wikilinks() {
        let d = db();
        let c = d.conn();
        assert_eq!(wikilinks("see [[Graph view|the graph]] and [[Arcade#games]]"), vec!["Graph view", "Arcade"]);
        let bl = backlinks(&c, "n-graph");
        assert!(bl.iter().any(|b| b["id"] == "n-welcome"));
    }

    #[test]
    fn version_history_snapshot_and_restore() {
        let d = db();
        let c = d.conn();
        c.execute(r#"UPDATE "Note" SET "content"='v2 text' WHERE "id"='n-graph'"#, []).unwrap();
        let v = versions(&c, "n-graph");
        assert_eq!(v.len(), 1, "trigger snapshots the previous text");
        assert!(v[0]["content"].as_str().unwrap().len() > 10);
        c.execute(r#"UPDATE "Note" SET "content"='v3 text' WHERE "id"='n-graph'"#, []).unwrap();
        assert_eq!(versions(&c, "n-graph").len(), 1, "throttled to one per 5 minutes");
        let restored = restore_version(&c, "n-graph", v[0]["id"].as_str().unwrap()).unwrap();
        assert_eq!(restored["content"], v[0]["content"]);
        assert!(versions(&c, "n-graph").iter().any(|x| x["content"] == "v3 text"), "restore keeps the replaced text");
    }

    #[test]
    fn templates_daily_notes_and_calendar() {
        let d = db();
        let c = d.conn();
        assert!(templates(&c).len() >= 5);
        assert!(fill_template("# {{title}} {{date}}", "X", now_ms()).starts_with("# X 20"));
        let n1 = daily_note(&c, "2026-03-05", true).unwrap();
        assert_eq!(n1["created"], true);
        assert!(n1["note"]["content"].as_str().unwrap().starts_with("# 2026-03-05"));
        assert_eq!(daily_note(&c, "2026-03-05", true).unwrap()["created"], false);
        assert!(daily_note(&c, "nope", true).is_err());
        append_daily(&c, "2026-03-05", "hello journal").unwrap();
        assert!(daily_note(&c, "2026-03-05", false).unwrap()["note"]["content"].as_str().unwrap().contains("hello journal"));
        let cal = calendar(&c, "2026-03");
        assert_eq!(cal["daysInMonth"], 31);
        assert!(cal["days"]["2026-03-05"]["daily"].is_string());
    }

    #[test]
    fn export_html_and_markdown_import() {
        let d = db();
        let c = d.conn();
        let html = md_to_html("# Hi\n\n- [x] done **bold** [[Graph view]]\n\n```\n<code>\n```\n[site](https://example.com)", "Hi");
        assert!(html.contains("<h1>Hi</h1>"));
        assert!(html.contains("checked"));
        assert!(html.contains("<strong>bold</strong>"));
        assert!(html.contains("&lt;code&gt;"));
        assert!(html.contains("href=\"https://example.com\""));
        assert!(html.contains("class=\"wikilink\""));
        let r = export_note(&c, "n-graph", "md");
        assert!(matches!(r.body, Body::Bytes { ref name, .. } if name == "Graph view.md"));
        let files = json!([
            { "path": "Vault/Ideas/one.md", "content": "---\ntitle: First idea\ntags: [a, b]\n---\nbody one" },
            { "path": "Vault/two.md", "content": "plain two" },
            { "path": "Vault/.obsidian/app.json", "content": "{}" },
            { "path": "Vault/pic.png", "content": "" }
        ]);
        let mut b = Map::new();
        b.insert("files".into(), files);
        let r = import(&c, &b);
        assert_eq!(r["created"], 2);
        assert_eq!(r["skipped"], 2);
        let n = all_notes(&c).into_iter().find(|n| n["title"] == "First idea").unwrap();
        assert_eq!(n["content"], "body one");
        assert_eq!(n["tags"], json!(["a", "b"]));
        assert!(n["folderId"].is_string());
    }

    #[test]
    fn recurrence_and_reminders() {
        let d = db();
        let c = d.conn();
        let due = timelens::local_day_start(now_ms()) + 9 * 3_600_000;
        assert_eq!(next_due(due, "daily").unwrap() - due, 86_400_000);
        assert!(next_due(due, "weekly").unwrap() - due >= 7 * 86_400_000 - 3_600_000);
        assert!(next_due(due, "nope").is_none());
        c.execute(r#"INSERT INTO "Task"("id","title","list","priority","due","done","tags","by","createdAt","repeat","remindAt") VALUES ('t-r','Water plants','today',1,?1,0,'[]','you',?1,'daily',?2)"#, params![due, now_ms() - 1000]).unwrap();
        let r = due_reminders(&c, now_ms(), true);
        assert_eq!(r.len(), 1);
        assert!(due_reminders(&c, now_ms(), true).is_empty(), "fires once");
        let next = spawn_next_occurrence(&c, "t-r").unwrap();
        assert_eq!(next["due"].as_i64().unwrap() - due, 86_400_000);
        assert_eq!(next["repeat"], "daily");
        assert!(spawn_next_occurrence(&c, "t-r").is_none(), "finished task stops repeating");
    }

    #[test]
    fn encrypted_backup_roundtrip() {
        let d = db();
        let dir = tempfile::tempdir().unwrap();
        let c = d.conn();
        let file = backup_to(&c, dir.path(), "hunter22").unwrap();
        let raw = std::fs::read(&file).unwrap();
        assert_eq!(&raw[..8], MAGIC);
        assert!(!raw.windows(15).any(|w| w == b"SQLite format 3"), "backup is encrypted");
        assert!(decrypt(&raw, "wrong-pass").is_err());
        c.execute(r#"DELETE FROM "Note""#, []).unwrap();
        assert_eq!(all_notes(&c).len(), 0);
        restore_from(&c, &file, "hunter22").unwrap();
        assert!(all_notes(&c).len() >= 10);
        assert_eq!(list_backups(dir.path()).len(), 1);
    }

    #[test]
    fn conversations_crud() {
        let d = db();
        let c = d.conn();
        let mut b = Map::new();
        b.insert("messages".into(), json!([{ "role": "user", "text": "hello there\nmore" }, { "role": "assistant", "text": "hi" }]));
        b.insert("model".into(), json!("gpt-x"));
        let r = conversation_save(&c, "conv-1", &b);
        assert_eq!(r.json_value().unwrap()["title"], "hello there");
        assert_eq!(conversation(&c, "conv-1").unwrap()["messages"].as_array().unwrap().len(), 2);
        assert!(route(&c, "DELETE", &["conversations", "conv-1"], &Map::new(), &HashMap::new()).is_some());
        assert!(conversation(&c, "conv-1").is_none());
    }

    #[test]
    fn ext_tools_run() {
        let d = db();
        let c = d.conn();
        let a = |v: Value| v.as_object().cloned().unwrap();
        assert!(run_tool(&c, "fts_search", &a(json!({ "query": "pet" }))).unwrap().0);
        assert!(run_tool(&c, "daily_note", &a(json!({ "date": "2026-01-02", "append": "agent was here" }))).unwrap().0);
        assert!(run_tool(&c, "backlinks", &a(json!({ "title": "Graph view" }))).unwrap().0);
        assert!(run_tool(&c, "note_from_template", &a(json!({ "template": "meeting", "title": "Standup" }))).unwrap().0);
        assert!(run_tool(&c, "set_reminder", &a(json!({ "title": "Call mom", "at": now_ms() + 60_000, "repeat": "weekly" }))).unwrap().0);
        assert!(run_tool(&c, "move_task", &a(json!({ "title": "Call mom", "status": "doing" }))).unwrap().0);
        assert!(run_tool(&c, "timelens_today", &Map::new()).unwrap().0);
        assert!(run_tool(&c, "timelens_range", &a(json!({ "days": 3 }))).unwrap().0);
        assert!(run_tool(&c, "timelens_top_apps", &Map::new()).unwrap().0);
        let p = run_tool(&c, "timelens_pause", &a(json!({ "paused": true }))).unwrap();
        assert!(p.0 && p.1.contains("paused"));
        assert!(run_tool(&c, "nope", &Map::new()).is_none());
        assert_eq!(mcp_catalog().len(), EXT_TOOLS.len());
    }
}
