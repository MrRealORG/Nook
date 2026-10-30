//! MCP (Model Context Protocol) server logic — port of `src/app/api/mcp/route.ts`.
//! JSON-RPC 2.0: initialize · notifications/initialized · ping · tools/list · tools/call,
//! batches, optional bearer-token auth (Setting `mcp-token`), activity log (`mcp-log`).
//! Transport (HTTP / streamable HTTP / stdio bridge) lives in `server.rs` and `bin/nook-mcp.rs`.

use crate::api::{query_vec, task_row};
use crate::db::{day_key, iso, new_id, now_ms, setting_get, setting_put, Db};
use crate::util::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use std::time::Instant;

pub const SERVER_NAME: &str = "Nook Workspace MCP";
pub const SERVER_VERSION: &str = "1.1.0";
pub const PROTOCOL_VERSION: &str = "2025-03-26";
pub const SUPPORTED_PROTOCOLS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];
pub const DEFAULT_PORT: u16 = 3000;

const EXEMPT: &[&str] = &["initialize", "notifications/initialized", "ping", "tools/list"];
const LISTS: &[&str] = &["today", "upcoming", "someday"];

pub fn tool_catalog() -> Value {
    let mut v = base_catalog();
    if let Value::Array(a) = &mut v {
        a.extend(crate::ext::mcp_catalog());
    }
    v
}

fn base_catalog() -> Value {
    let lists = json!(["today", "upcoming", "someday"]);
    json!([
        { "name": "list_tasks", "description": "List the user's todo tasks. Filter by status (open/done/all) and by list (today/upcoming/someday).",
          "inputSchema": { "type": "object", "properties": { "status": { "type": "string", "enum": ["open", "done", "all"], "description": "default: all" }, "list": { "type": "string", "enum": lists, "description": "which task list" } } } },
        { "name": "create_task", "description": "Create a todo task on the user's behalf (marked as created by 'agent').",
          "inputSchema": { "type": "object", "properties": {
              "title": { "type": "string", "description": "task title (max 200 chars)" },
              "list": { "type": "string", "enum": lists, "description": "default: today" },
              "priority": { "type": "number", "description": "0 low · 1 normal · 2 high (default 1)" },
              "due": { "type": "string", "description": "ISO date string, e.g. 2025-06-01 (or epoch ms)" },
              "tags": { "type": "array", "items": { "type": "string" }, "description": "optional tag strings" } }, "required": ["title"] } },
        { "name": "complete_task", "description": "Mark a task as done (sets completedAt to now).",
          "inputSchema": { "type": "object", "properties": { "id": { "type": "string", "description": "task id" } }, "required": ["id"] } },
        { "name": "update_task", "description": "Patch-edit a task: title, list, priority, due and/or done.",
          "inputSchema": { "type": "object", "properties": { "id": { "type": "string", "description": "task id" }, "title": { "type": "string" }, "list": { "type": "string", "enum": lists },
              "priority": { "type": "number" }, "due": { "type": "string", "description": "ISO date string (or epoch ms); null clears it" }, "done": { "type": "boolean" } }, "required": ["id"] } },
        { "name": "delete_task", "description": "Permanently delete a task by id.",
          "inputSchema": { "type": "object", "properties": { "id": { "type": "string", "description": "task id" } }, "required": ["id"] } },
        { "name": "list_notes", "description": "Search the user's notes by keyword (case-insensitive match on title/content). Returns id, title, tags, updatedAt and a 160-char snippet.",
          "inputSchema": { "type": "object", "properties": { "query": { "type": "string", "description": "keyword to search for (omit to list recent notes)" }, "limit": { "type": "number", "description": "max notes to return, 1-50 (default 20)" } } } },
        { "name": "read_note", "description": "Read one note in full: id, title, content, tags, updatedAt.",
          "inputSchema": { "type": "object", "properties": { "id": { "type": "string", "description": "note id" } }, "required": ["id"] } },
        { "name": "write_note", "description": "Create a new note with the given title and (markdown) content.",
          "inputSchema": { "type": "object", "properties": { "title": { "type": "string" }, "content": { "type": "string" }, "tags": { "type": "array", "items": { "type": "string" } } }, "required": ["title", "content"] } },
        { "name": "append_note", "description": "Append content to the end of an existing note (separated by a newline).",
          "inputSchema": { "type": "object", "properties": { "id": { "type": "string", "description": "note id" }, "content": { "type": "string" } }, "required": ["id", "content"] } },
        { "name": "rename_note", "description": "Rename an existing note (change its title only, content is untouched).",
          "inputSchema": { "type": "object", "properties": { "id": { "type": "string", "description": "note id" }, "title": { "type": "string", "description": "new title (max 200 chars)" } }, "required": ["id", "title"] } },
        { "name": "delete_note", "description": "Permanently delete a note by id. Destructive — prefer append/rename when unsure.",
          "inputSchema": { "type": "object", "properties": { "id": { "type": "string", "description": "note id" } }, "required": ["id"] } },
        { "name": "list_tags", "description": "All tags in use across the workspace's notes and tasks, with usage counts — handy before tagging something new.",
          "inputSchema": { "type": "object", "properties": {} } },
        { "name": "today_brief", "description": "One-glance daily brief: open tasks (today first), recently touched notes, the pet's status and today's productive minutes. Great as a first call to orient.",
          "inputSchema": { "type": "object", "properties": {} } },
        { "name": "pet_status", "description": "Current state of the user's desktop pet companion: name, species, xp, level, coins and food/energy/joy stats.",
          "inputSchema": { "type": "object", "properties": {} } },
        { "name": "activity_summary", "description": "Per-app usage seconds tracked over the last N days (default 1), including productive/neutral/distraction category totals.",
          "inputSchema": { "type": "object", "properties": { "days": { "type": "number", "description": "lookback window in days, 1-30 (default 1)" } } } },
        { "name": "server_info", "description": "Static info about this workspace: counts of notes, tasks, open tasks, canvases and pets.",
          "inputSchema": { "type": "object", "properties": {} } }
    ])
}

pub fn tool_names() -> Vec<String> {
    tool_catalog().as_array().map(|a| a.iter().filter_map(|t| t["name"].as_str().map(String::from)).collect()).unwrap_or_default()
}

// ------------------------------------------------------------------ token + log

pub fn get_token(c: &Connection) -> Option<String> {
    let raw = setting_get(c, "mcp-token")?;
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    match serde_json::from_str::<Value>(raw) {
        Ok(v) => v.get("token").and_then(|t| t.as_str()).map(|t| t.trim().to_string()).filter(|t| !t.is_empty()),
        Err(_) => Some(raw.to_string()),
    }
}

pub fn set_token(c: &Connection, token: Option<&str>) -> Result<(), String> {
    match token.map(str::trim).filter(|t| !t.is_empty()) {
        None => {
            c.execute(r#"DELETE FROM "Setting" WHERE "id"='mcp-token'"#, []).map_err(|e| e.to_string())?;
            Ok(())
        }
        Some(t) => setting_put(c, "mcp-token", &json!({ "token": t }).to_string()),
    }
}

fn read_log(c: &Connection) -> Vec<Value> {
    setting_get(c, "mcp-log").and_then(|v| serde_json::from_str::<Value>(&v).ok()).and_then(|v| v.as_array().cloned()).unwrap_or_default()
}

fn append_log(c: &Connection, entry: Value) {
    let mut list = read_log(c);
    list.truncate(39);
    list.insert(0, entry);
    let _ = setting_put(c, "mcp-log", &Value::Array(list).to_string());
}

pub fn log_summary(c: &Connection) -> Value {
    let log = read_log(c);
    let calls = log.len();
    let failed = log.iter().filter(|e| !e["ok"].as_bool().unwrap_or(false)).count();
    let avg = if calls > 0 { (log.iter().map(|e| e["ms"].as_f64().unwrap_or(0.0)).sum::<f64>() / calls as f64).round() as i64 } else { 0 };
    json!({ "ok": true, "count": calls, "failed": failed, "avgMs": avg, "last": log.first().map(|e| e["t"].clone()).unwrap_or(Value::Null), "entries": log })
}

// ------------------------------------------------------------------ tools

type TResult = Result<Value, String>;

fn arg_str<'a>(a: &'a Map<String, Value>, k: &str) -> &'a str {
    a.get(k).and_then(|v| v.as_str()).unwrap_or("")
}

fn str_arr(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str()).map(|x| take(x, 60)).take(30).collect(),
        _ => vec![],
    }
}

/// ISO date string (preferred) or epoch-ms number → epoch ms.
pub fn due_to_ms(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_f64().filter(|f| f.is_finite()).map(|f| f.round() as i64),
        Value::String(s) => {
            let s = s.trim();
            if let Ok(d) = chrono::DateTime::parse_from_rfc3339(s) {
                return Some(d.timestamp_millis());
            }
            if let Ok(d) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S") {
                return Some(d.and_utc().timestamp_millis());
            }
            if let Ok(d) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M") {
                return Some(d.and_utc().timestamp_millis());
            }
            if let Ok(d) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
                return d.and_hms_opt(0, 0, 0).map(|x| x.and_utc().timestamp_millis());
            }
            s.parse::<f64>().ok().filter(|f| f.is_finite()).map(|f| f.round() as i64)
        }
        _ => None,
    }
}

fn task_out(t: &Value) -> Value {
    json!({
        "id": t["id"], "title": t["title"], "list": t["list"], "priority": t["priority"],
        "due": t["due"].as_i64().map(|d| Value::from(iso(d))).unwrap_or(Value::Null),
        "done": t["done"], "noteId": t["noteId"], "tags": t["tags"], "by": t["by"],
        "createdAt": iso(t["createdAt"].as_i64().unwrap_or(0)),
        "completedAt": t["completedAt"].as_i64().map(|d| Value::from(iso(d))).unwrap_or(Value::Null),
    })
}

fn get_task(c: &Connection, id: &str) -> TResult {
    c.query_row(r#"SELECT * FROM "Task" WHERE "id"=?1"#, params![id], task_row).optional().map_err(|e| e.to_string())?.ok_or_else(|| format!("task not found: {id}"))
}

fn note_by_id(c: &Connection, id: &str) -> TResult {
    c.query_row(r#"SELECT "id","title","content","tags","updatedAt" FROM "Note" WHERE "id"=?1"#, params![id], |r| {
        Ok(json!({ "id": r.get::<_, String>(0)?, "title": r.get::<_, String>(1)?, "content": r.get::<_, String>(2)?, "tags": parse_tags(&r.get::<_, String>(3)?), "updatedAt": iso(r.get::<_, i64>(4)?) }))
    })
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("note not found: {id}"))
}

fn required_id(a: &Map<String, Value>) -> Result<String, String> {
    let id = arg_str(a, "id").trim().to_string();
    if id.is_empty() {
        Err("id is required".into())
    } else {
        Ok(id)
    }
}

pub fn call_tool(c: &Connection, name: &str, a: &Map<String, Value>) -> TResult {
    let now = now_ms();
    match name {
        "list_tasks" => {
            let mut sql = r#"SELECT * FROM "Task" WHERE 1=1"#.to_string();
            match arg_str(a, "status") {
                "open" => sql.push_str(r#" AND "done"=0"#),
                "done" => sql.push_str(r#" AND "done"=1"#),
                _ => {}
            }
            let list = arg_str(a, "list");
            let mut p: Vec<String> = vec![];
            if LISTS.contains(&list) {
                sql.push_str(r#" AND "list"=?1"#);
                p.push(list.into());
            }
            sql.push_str(r#" ORDER BY "done" ASC, "createdAt" DESC, rowid DESC LIMIT 200"#);
            let rows = query_vec(c, &sql, rusqlite::params_from_iter(p), task_row);
            Ok(json!({ "ok": true, "count": rows.len(), "tasks": rows.iter().map(task_out).collect::<Vec<_>>() }))
        }
        "create_task" => {
            let title = take(arg_str(a, "title").trim(), 200);
            if title.is_empty() {
                return Err("title is required".into());
            }
            let list = if LISTS.contains(&arg_str(a, "list")) { arg_str(a, "list") } else { "today" };
            let pr = num_of(a.get("priority")).unwrap_or(1.0).round().clamp(0.0, 2.0) as i64;
            let due = a.get("due").and_then(due_to_ms);
            let id = new_id();
            c.execute(
                r#"INSERT INTO "Task" ("id","title","list","priority","due","done","tags","by","createdAt") VALUES (?1,?2,?3,?4,?5,0,?6,'agent',?7)"#,
                params![id, title, list, pr, due, Value::from(str_arr(a.get("tags"))).to_string(), now],
            )
            .map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true, "task": task_out(&get_task(c, &id)?) }))
        }
        "complete_task" => {
            let id = required_id(a)?;
            get_task(c, &id)?;
            c.execute(r#"UPDATE "Task" SET "done"=1, "completedAt"=?1 WHERE "id"=?2"#, params![now, id]).map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true, "task": task_out(&get_task(c, &id)?) }))
        }
        "update_task" => {
            let id = required_id(a)?;
            let cur = get_task(c, &id)?;
            let mut changed = false;
            let mut title = cur["title"].as_str().unwrap_or("").to_string();
            let mut list = cur["list"].as_str().unwrap_or("today").to_string();
            let mut pr = cur["priority"].as_i64().unwrap_or(1);
            let mut due = cur["due"].as_i64();
            let mut done = cur["done"].as_bool().unwrap_or(false);
            if let Some(Value::String(t)) = a.get("title") {
                let t = take(t.trim(), 200);
                if t.is_empty() {
                    return Err("title cannot be empty".into());
                }
                title = t;
                changed = true;
            }
            if let Some(Value::String(l)) = a.get("list") {
                if !LISTS.contains(&l.as_str()) {
                    return Err("list must be one of: today, upcoming, someday".into());
                }
                list = l.clone();
                changed = true;
            }
            if let Some(p) = num_of(a.get("priority")) {
                pr = p.round().clamp(0.0, 2.0) as i64;
                changed = true;
            }
            if let Some(d) = a.get("due") {
                due = due_to_ms(d);
                changed = true;
            }
            let was_done = done;
            if let Some(Value::Bool(d)) = a.get("done") {
                done = *d;
                changed = true;
            }
            if !changed {
                return Err("nothing to update (pass title/list/priority/due/done)".into());
            }
            // keep completedAt consistent with done (the original left it stale)
            let completed = if done && !was_done { Some(now) } else if !done { None } else { cur["completedAt"].as_i64() };
            c.execute(
                r#"UPDATE "Task" SET "title"=?1,"list"=?2,"priority"=?3,"due"=?4,"done"=?5,"completedAt"=?6 WHERE "id"=?7"#,
                params![title, list, pr, due, done as i64, completed, id],
            )
            .map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true, "task": task_out(&get_task(c, &id)?) }))
        }
        "delete_task" => {
            let id = required_id(a)?;
            get_task(c, &id)?;
            c.execute(r#"DELETE FROM "Task" WHERE "id"=?1"#, params![id]).map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true, "deleted": id }))
        }
        "list_notes" => {
            let q = arg_str(a, "query").trim().to_lowercase();
            let limit = num_of(a.get("limit")).unwrap_or(20.0).round().clamp(1.0, 50.0) as usize;
            let rows = crate::api::all_notes(c);
            let filtered: Vec<&Value> = rows
                .iter()
                .filter(|r| q.is_empty() || r["title"].as_str().unwrap_or("").to_lowercase().contains(&q) || r["content"].as_str().unwrap_or("").to_lowercase().contains(&q))
                .collect();
            let notes: Vec<Value> = filtered
                .iter()
                .take(limit)
                .map(|r| json!({ "id": r["id"], "title": r["title"], "tags": r["tags"], "updatedAt": iso(r["updatedAt"].as_i64().unwrap_or(0)), "snippet": take(r["content"].as_str().unwrap_or(""), 160) }))
                .collect();
            let mut out = json!({ "ok": true, "count": filtered.len(), "notes": notes });
            if !q.is_empty() {
                out["query"] = json!(q);
            }
            Ok(out)
        }
        "read_note" => note_by_id(c, &required_id(a)?),
        "write_note" => {
            let title = take(arg_str(a, "title").trim(), 200);
            if title.is_empty() {
                return Err("title is required".into());
            }
            let id = new_id();
            c.execute(
                r#"INSERT INTO "Note" ("id","title","content","pinned","tags","createdAt","updatedAt") VALUES (?1,?2,?3,0,?4,?5,?5)"#,
                params![id, title, take(arg_str(a, "content"), 400_000), Value::from(str_arr(a.get("tags"))).to_string(), now],
            )
            .map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true, "id": id, "title": title }))
        }
        "append_note" => {
            let id = required_id(a)?;
            let content = arg_str(a, "content");
            if content.trim().is_empty() {
                return Err("content is required".into());
            }
            let n = note_by_id(c, &id)?;
            let old = n["content"].as_str().unwrap_or("");
            let merged = if old.trim().is_empty() { content.to_string() } else { format!("{}\n\n{}", old.trim_end(), content) };
            c.execute(r#"UPDATE "Note" SET "content"=?1, "updatedAt"=?2 WHERE "id"=?3"#, params![take(&merged, 400_000), now, id]).map_err(|e| e.to_string())?;
            let mut out = note_by_id(c, &id)?;
            out["ok"] = json!(true);
            Ok(out)
        }
        "rename_note" => {
            let id = required_id(a)?;
            let title = take(arg_str(a, "title").trim(), 200);
            if title.is_empty() {
                return Err("title is required".into());
            }
            note_by_id(c, &id)?;
            c.execute(r#"UPDATE "Note" SET "title"=?1, "updatedAt"=?2 WHERE "id"=?3"#, params![title, now, id]).map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true, "id": id, "title": title, "updatedAt": iso(now) }))
        }
        "delete_note" => {
            let id = required_id(a)?;
            let n = note_by_id(c, &id)?;
            c.execute(r#"DELETE FROM "Note" WHERE "id"=?1"#, params![id]).map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true, "deleted": id, "title": n["title"] }))
        }
        "list_tags" => {
            let mut counts: Vec<(String, i64)> = vec![];
            let raw = query_vec(c, r#"SELECT "tags" FROM "Note" UNION ALL SELECT "tags" FROM "Task""#, [], |r| Ok(Value::String(r.get(0)?)));
            for r in raw {
                for t in parse_tags(r.as_str().unwrap_or("[]")) {
                    match counts.iter_mut().find(|x| x.0 == t) {
                        Some(x) => x.1 += 1,
                        None => counts.push((t, 1)),
                    }
                }
            }
            counts.sort_by_key(|c| std::cmp::Reverse(c.1));
            Ok(json!({ "ok": true, "count": counts.len(), "tags": counts.iter().map(|(t, n)| json!({ "tag": t, "count": n })).collect::<Vec<_>>() }))
        }
        "today_brief" => {
            let today = day_key(now);
            let open = query_vec(c, r#"SELECT * FROM "Task" WHERE "done"=0 ORDER BY CASE "list" WHEN 'today' THEN 0 WHEN 'upcoming' THEN 1 ELSE 2 END, "priority" DESC, "createdAt" DESC LIMIT 12"#, [], task_row);
            let recent = query_vec(c, r#"SELECT "id","title","updatedAt" FROM "Note" ORDER BY "updatedAt" DESC LIMIT 5"#, [], |r| {
                Ok(json!({ "id": r.get::<_, String>(0)?, "title": r.get::<_, String>(1)?, "updatedAt": iso(r.get::<_, i64>(2)?) }))
            });
            let pet = c
                .query_row(r#"SELECT "name","species","xp","coins" FROM "Pet" LIMIT 1"#, [], |r| {
                    let xp: i64 = r.get(2)?;
                    Ok(json!({ "name": r.get::<_, String>(0)?, "species": r.get::<_, String>(1)?, "level": level_of(xp), "coins": r.get::<_, i64>(3)? }))
                })
                .optional()
                .ok()
                .flatten();
            let (prod, total): (i64, i64) = c
                .query_row(r#"SELECT COALESCE(SUM(CASE WHEN "cat"='productive' THEN "secs" ELSE 0 END),0), COALESCE(SUM("secs"),0) FROM "AppUse" WHERE "day"=?1"#, params![today], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap_or((0, 0));
            Ok(json!({
                "ok": true, "date": today,
                "openTasks": open.iter().map(|t| json!({ "id": t["id"], "title": t["title"], "list": t["list"], "priority": t["priority"], "by": t["by"], "tags": t["tags"] })).collect::<Vec<_>>(),
                "recentNotes": recent, "pet": pet,
                "focus": { "productiveMinutes": (prod as f64 / 60.0).round() as i64, "totalTrackedMinutes": (total as f64 / 60.0).round() as i64 }
            }))
        }
        "pet_status" => c
            .query_row(r#"SELECT "name","species","xp","coins","food","energy","joy" FROM "Pet" LIMIT 1"#, [], |r| {
                let xp: i64 = r.get(2)?;
                Ok(json!({ "ok": true, "name": r.get::<_, String>(0)?, "species": r.get::<_, String>(1)?, "xp": xp, "level": level_of(xp), "coins": r.get::<_, i64>(3)?,
                    "stats": { "food": r.get::<_, i64>(4)?, "energy": r.get::<_, i64>(5)?, "joy": r.get::<_, i64>(6)? } }))
            })
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "no pet found — open the app once so it can hatch".into()),
        "activity_summary" => {
            let days = num_of(a.get("days")).unwrap_or(1.0).round().clamp(1.0, 30.0) as i64;
            let from = day_key(now - (days - 1) * 86_400_000);
            let rows = query_vec(c, r#"SELECT "app","cat","secs" FROM "AppUse" WHERE "day">=?1 ORDER BY rowid"#, params![from], |r| {
                Ok(json!({ "app": r.get::<_, String>(0)?, "cat": r.get::<_, String>(1)?, "secs": r.get::<_, i64>(2)? }))
            });
            let mut per: Vec<Value> = vec![];
            let mut cats = json!({ "productive": 0, "neutral": 0, "distraction": 0 });
            for r in rows {
                let secs = r["secs"].as_i64().unwrap_or(0);
                let cat = r["cat"].as_str().unwrap_or("neutral").to_string();
                cats[&cat] = json!(cats[&cat].as_i64().unwrap_or(0) + secs);
                match per.iter_mut().find(|p| p["app"] == r["app"]) {
                    Some(p) => p["secs"] = json!(p["secs"].as_i64().unwrap_or(0) + secs),
                    None => per.push(r),
                }
            }
            per.sort_by_key(|p| -p["secs"].as_i64().unwrap_or(0));
            let total: i64 = per.iter().map(|p| p["secs"].as_i64().unwrap_or(0)).sum();
            Ok(json!({ "ok": true, "days": days, "from": from, "to": day_key(now), "totalSecs": total, "perApp": per, "categoryTotals": cats }))
        }
        "server_info" => {
            let cnt = |sql: &str| c.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap_or(0);
            Ok(json!({
                "ok": true,
                "server": { "name": SERVER_NAME, "version": SERVER_VERSION, "protocolVersion": PROTOCOL_VERSION },
                "workspace": { "notes": cnt(r#"SELECT COUNT(*) FROM "Note""#), "tasks": cnt(r#"SELECT COUNT(*) FROM "Task""#), "openTasks": cnt(r#"SELECT COUNT(*) FROM "Task" WHERE "done"=0"#),
                    "canvases": cnt(r#"SELECT COUNT(*) FROM "Canvas""#), "pets": cnt(r#"SELECT COUNT(*) FROM "Pet""#) },
                "time": iso(now)
            }))
        }
        "" => Err("tool name is required".into()),
        other => crate::ext::mcp_call(c, other, a).unwrap_or_else(|| Err(format!("Unknown tool: {other}"))),
    }
}

/// Run one tool, MCP-style result envelope.
fn wrap_tool(c: &Connection, name: &str, args: &Map<String, Value>) -> Value {
    match call_tool(c, name, args) {
        Ok(v) => json!({ "content": [{ "type": "text", "text": serde_json::to_string_pretty(&v).unwrap_or_default() }] }),
        Err(e) => json!({ "content": [{ "type": "text", "text": format!("Error: {e}") }], "isError": true }),
    }
}

fn rpc_ok(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}
pub fn rpc_err(id: &Value, code: i64, msg: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": msg } })
}

/// Handle one JSON-RPC message → (http status, optional body).
pub fn handle_one(db: &Db, msg: &Value, auth: Option<&str>) -> (u16, Option<Value>) {
    handle_one_inner(db, msg, auth, false)
}

fn handle_one_inner(db: &Db, msg: &Value, auth: Option<&str>, trusted: bool) -> (u16, Option<Value>) {
    let Some(method) = msg.get("method").and_then(|m| m.as_str()) else {
        let id = msg.get("id").cloned().unwrap_or(Value::Null);
        return (200, Some(rpc_err(&id, -32600, "Invalid Request: expected {jsonrpc, method, ...}")));
    };
    let has_id = msg.get("id").is_some();
    let id = msg.get("id").cloned().unwrap_or(Value::Null);
    let params = msg.get("params").and_then(|p| p.as_object()).cloned().unwrap_or_default();
    let c = db.conn();
    if !trusted && !EXEMPT.contains(&method) {
        if let Some(token) = get_token(&c) {
            if auth.map(str::trim) != Some(format!("Bearer {token}").as_str()) {
                return (401, Some(rpc_err(&id, -32001, "Unauthorized: missing or invalid bearer token")));
            }
        }
    }
    if !has_id || method.starts_with("notifications/") {
        return (202, None);
    }
    match method {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(|v| v.as_str()).unwrap_or(PROTOCOL_VERSION);
            let proto = if SUPPORTED_PROTOCOLS.contains(&asked) { asked } else { PROTOCOL_VERSION };
            (200, Some(rpc_ok(&id, json!({ "protocolVersion": proto, "capabilities": { "tools": { "listChanged": false } }, "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION },
                "instructions": "Nook workspace: notes, tasks, pet and activity. Call today_brief first to orient." }))))
        }
        "ping" => (200, Some(rpc_ok(&id, json!({})))),
        "tools/list" => (200, Some(rpc_ok(&id, json!({ "tools": tool_catalog() })))),
        "tools/call" => {
            let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("").trim().to_string();
            let args = params.get("arguments").and_then(|a| a.as_object()).cloned().unwrap_or_default();
            let t0 = Instant::now();
            let result = wrap_tool(&c, &name, &args);
            let is_err = result.get("isError").and_then(|v| v.as_bool()).unwrap_or(false);
            let mut entry = json!({ "t": now_ms(), "tool": if name.is_empty() { "?".to_string() } else { name.clone() }, "ok": !is_err, "ms": t0.elapsed().as_millis() as u64 });
            if is_err {
                entry["error"] = json!(take(result["content"][0]["text"].as_str().unwrap_or(""), 140));
            }
            append_log(&c, entry);
            (200, Some(rpc_ok(&id, result)))
        }
        "resources/list" => (200, Some(rpc_ok(&id, json!({ "resources": [] })))),
        "prompts/list" => (200, Some(rpc_ok(&id, json!({ "prompts": [] })))),
        other => (200, Some(rpc_err(&id, -32601, &format!("Method not found: {other}")))),
    }
}

/// Full HTTP POST semantics: parse errors, batches, notifications → 202.
pub fn handle_http(db: &Db, body: Option<Value>, auth: Option<&str>) -> (u16, Option<Value>) {
    handle_http_inner(db, body, auth, false)
}

/// In-process transport (stdio bridge in direct mode): the caller already has file access
/// to the vault, so bearer auth (which guards *network* callers) does not apply.
pub fn handle_local(db: &Db, body: Option<Value>) -> (u16, Option<Value>) {
    handle_http_inner(db, body, None, true)
}

fn handle_http_inner(db: &Db, body: Option<Value>, auth: Option<&str>, trusted: bool) -> (u16, Option<Value>) {
    let Some(body) = body else {
        return (400, Some(rpc_err(&Value::Null, -32700, "Parse error: body must be valid JSON")));
    };
    if let Value::Array(items) = &body {
        if items.is_empty() {
            return (200, Some(rpc_err(&Value::Null, -32600, "Invalid Request: empty batch")));
        }
        let out: Vec<Value> = items.iter().filter_map(|m| handle_one_inner(db, m, auth, trusted).1).collect();
        return if out.is_empty() { (202, None) } else { (200, Some(Value::Array(out))) };
    }
    handle_one_inner(db, &body, auth, trusted)
}

pub fn server_info_json() -> Value {
    json!({
        "name": SERVER_NAME, "version": SERVER_VERSION, "protocolVersion": PROTOCOL_VERSION, "endpoint": "/mcp",
        "transport": "JSON-RPC 2.0 over HTTP POST (MCP streamable HTTP; SSE responses on request)",
        "methods": ["initialize", "notifications/initialized", "ping", "tools/list", "tools/call"],
        "batch": true, "auth": "optional bearer token — set it in Nook → Settings → MCP", "tools": tool_names()
    })
}

pub fn info_html(port: u16) -> String {
    let rows: String = tool_catalog()
        .as_array()
        .map(|a| a.iter().map(|t| format!("<tr><td><code>{}</code></td><td>{}</td></tr>", t["name"].as_str().unwrap_or(""), t["description"].as_str().unwrap_or(""))).collect())
        .unwrap_or_default();
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{SERVER_NAME}</title><style>
body{{background:#14121b;color:#e8e2f4;font:14px/1.6 ui-monospace,Menlo,Consolas,monospace;padding:40px;max-width:860px;margin:0 auto}}
code{{background:#241f33;padding:2px 6px;border-radius:6px;color:#b9a8ff}}table{{border-collapse:collapse;width:100%;margin:16px 0}}td{{border-bottom:1px solid #2b2540;padding:8px 10px;vertical-align:top}}
pre{{background:#241f33;padding:14px;border-radius:10px;overflow:auto}}</style></head><body>
<h1>🔌 {SERVER_NAME} <span style="color:#8f86a8">v{SERVER_VERSION}</span></h1>
<p>Model Context Protocol server for this Nook workspace, JSON-RPC 2.0 at <code>http://127.0.0.1:{port}/mcp</code> (protocol <code>{PROTOCOL_VERSION}</code>).</p>
<pre>curl -s -X POST http://127.0.0.1:{port}/mcp -H 'content-type: application/json' -d '{{"jsonrpc":"2.0","id":1,"method":"tools/list"}}'</pre>
<table><tr><th>tool</th><th>description</th></tr>{rows}</table></body></html>"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rpc(db: &Db, method: &str, params: Value, auth: Option<&str>) -> (u16, Value) {
        let (s, b) = handle_http(db, Some(json!({ "jsonrpc": "2.0", "id": 7, "method": method, "params": params })), auth);
        (s, b.unwrap_or(Value::Null))
    }

    fn tool(db: &Db, name: &str, args: Value) -> Value {
        let (_, r) = rpc(db, "tools/call", json!({ "name": name, "arguments": args }), None);
        let res = &r["result"];
        let text = res["content"][0]["text"].as_str().unwrap_or("");
        if res["isError"].as_bool().unwrap_or(false) {
            json!({ "error": text })
        } else {
            serde_json::from_str(text).unwrap()
        }
    }

    #[test]
    fn initialize_ping_list() {
        let db = Db::open_in_memory().unwrap();
        let (_, r) = rpc(&db, "initialize", json!({ "protocolVersion": "2025-06-18" }), None);
        assert_eq!(r["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(r["result"]["serverInfo"]["name"], SERVER_NAME);
        assert_eq!(rpc(&db, "ping", json!({}), None).1["result"], json!({}));
        let (_, l) = rpc(&db, "tools/list", json!({}), None);
        assert_eq!(l["result"]["tools"].as_array().unwrap().len(), 16 + crate::ext::EXT_TOOLS.len());
        let (s, b) = handle_http(&db, Some(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })), None);
        assert_eq!((s, b), (202, None));
        let (_, e) = rpc(&db, "nope/x", json!({}), None);
        assert_eq!(e["error"]["code"], -32601);
        let (s, e) = handle_http(&db, None, None);
        assert_eq!(s, 400);
        assert_eq!(e.unwrap()["error"]["code"], -32700);
    }

    #[test]
    fn every_tool_works() {
        let db = Db::open_in_memory().unwrap();
        let t = tool(&db, "create_task", json!({ "title": "From agent", "due": "2030-01-02", "tags": ["mcp"], "priority": 2 }));
        let id = t["task"]["id"].as_str().unwrap().to_string();
        assert_eq!(t["task"]["by"], "agent");
        assert_eq!(t["task"]["due"], "2030-01-02T00:00:00.000Z");
        assert_eq!(tool(&db, "list_tasks", json!({ "status": "open" }))["count"], 1);
        let u = tool(&db, "update_task", json!({ "id": id, "title": "Renamed", "list": "someday", "done": true }));
        assert_eq!(u["task"]["list"], "someday");
        assert!(u["task"]["completedAt"].is_string());
        assert!(tool(&db, "update_task", json!({ "id": id }))["error"].as_str().unwrap().contains("nothing to update"));
        assert!(tool(&db, "update_task", json!({ "id": id, "list": "bad" }))["error"].is_string());
        tool(&db, "update_task", json!({ "id": id, "done": false }));
        assert_eq!(tool(&db, "complete_task", json!({ "id": id }))["task"]["done"], true);
        assert_eq!(tool(&db, "list_tasks", json!({ "status": "done", "list": "someday" }))["count"], 1);
        let n = tool(&db, "write_note", json!({ "title": "MCP note", "content": "hello", "tags": ["mcp", "x"] }));
        let nid = n["id"].as_str().unwrap().to_string();
        assert_eq!(tool(&db, "append_note", json!({ "id": nid, "content": "world" }))["content"], "hello\n\nworld");
        assert_eq!(tool(&db, "rename_note", json!({ "id": nid, "title": "Renamed note" }))["title"], "Renamed note");
        assert_eq!(tool(&db, "read_note", json!({ "id": nid }))["title"], "Renamed note");
        assert_eq!(tool(&db, "list_notes", json!({ "query": "renamed note", "limit": 5 }))["count"], 1);
        assert_eq!(tool(&db, "list_notes", json!({}))["notes"].as_array().unwrap().len(), 15);
        let tags = tool(&db, "list_tags", json!({}));
        assert_eq!(tags["tags"][0], json!({ "tag": "mcp", "count": 2 }));
        let brief = tool(&db, "today_brief", json!({}));
        assert_eq!(brief["pet"]["name"], "Mochi");
        assert_eq!(brief["recentNotes"][0]["title"], "Renamed note");
        assert_eq!(tool(&db, "pet_status", json!({}))["level"], 1);
        assert_eq!(tool(&db, "activity_summary", json!({ "days": 3 }))["days"], 3);
        assert_eq!(tool(&db, "server_info", json!({}))["workspace"]["notes"], 15);
        assert_eq!(tool(&db, "delete_note", json!({ "id": nid }))["deleted"], nid.as_str());
        assert!(tool(&db, "read_note", json!({ "id": nid }))["error"].as_str().unwrap().contains("not found"));
        assert_eq!(tool(&db, "delete_task", json!({ "id": id }))["ok"], true);
        assert!(tool(&db, "nope", json!({}))["error"].as_str().unwrap().contains("Unknown tool"));
        // every call is logged (newest first, capped at 40)
        let log = log_summary(&db.conn());
        assert!(log["count"].as_i64().unwrap() >= 20);
        assert!(log["failed"].as_i64().unwrap() >= 3);
        assert_eq!(log["entries"][0]["tool"], "nope");
    }

    #[test]
    fn bearer_token_auth() {
        let db = Db::open_in_memory().unwrap();
        set_token(&db.conn(), Some("s3cret")).unwrap();
        // exempt methods stay open
        assert_eq!(rpc(&db, "tools/list", json!({}), None).0, 200);
        assert_eq!(rpc(&db, "initialize", json!({}), None).0, 200);
        // tools/call needs the token
        let (s, r) = rpc(&db, "tools/call", json!({ "name": "server_info" }), None);
        assert_eq!(s, 401);
        assert_eq!(r["error"]["code"], -32001);
        assert_eq!(rpc(&db, "tools/call", json!({ "name": "server_info" }), Some("Bearer wrong")).0, 401);
        let (s, r) = rpc(&db, "tools/call", json!({ "name": "server_info" }), Some("Bearer s3cret"));
        assert_eq!(s, 200);
        assert!(r["result"]["isError"].is_null());
        set_token(&db.conn(), None).unwrap();
        assert_eq!(rpc(&db, "tools/call", json!({ "name": "server_info" }), None).0, 200);
    }

    #[test]
    fn batches() {
        let db = Db::open_in_memory().unwrap();
        let (s, b) = handle_http(&db, Some(json!([{ "jsonrpc": "2.0", "id": 1, "method": "ping" }, { "jsonrpc": "2.0", "method": "notifications/initialized" }, { "jsonrpc": "2.0", "id": 2, "method": "tools/list" }])), None);
        assert_eq!(s, 200);
        assert_eq!(b.unwrap().as_array().unwrap().len(), 2);
        let (s, b) = handle_http(&db, Some(json!([{ "jsonrpc": "2.0", "method": "notifications/initialized" }])), None);
        assert_eq!((s, b), (202, None));
        assert_eq!(due_to_ms(&json!("2025-06-01")), Some(1748736000000));
        assert_eq!(due_to_ms(&json!(5)), Some(5));
        assert_eq!(due_to_ms(&json!("garbage")), None);
    }
}
