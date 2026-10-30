//! The AI harness tool registry — port of `src/lib/agent-tools.ts`.
//! Both the cloud model (JSON tool-call protocol) and the offline local fallback route
//! through these executors, so the assistant can actually create notes/tasks, tidy the
//! vault, care for the pet, read the market, report app usage, manage rules and search the web.

use crate::api::{all_notes, bugs_insert, query_vec};
use crate::db::{day_key, new_id, now_ms, setting_get, setting_put, Db};
use crate::util::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

pub struct ToolRun {
    pub ok: bool,
    pub summary: String,
    pub data: Option<Value>,
}

fn ok(summary: impl Into<String>, data: Option<Value>) -> ToolRun {
    ToolRun { ok: true, summary: summary.into(), data }
}
fn fail(summary: impl Into<String>) -> ToolRun {
    ToolRun { ok: false, summary: summary.into(), data: None }
}

pub struct ToolDef {
    pub name: &'static str,
    pub group: &'static str,
    pub desc: &'static str,
    pub args: &'static [(&'static str, &'static str)],
}

pub const TOOLS: &[ToolDef] = &[
    ToolDef { name: "list_notes", group: "notes", desc: "List notes in the vault (newest first). Optionally filter by a text query.", args: &[("query", "optional text filter"), ("limit", "optional max rows (default 12)")] },
    ToolDef { name: "read_note", group: "notes", desc: "Read the full markdown of one note by id or exact-ish title.", args: &[("id", "note id"), ("title", "or note title")] },
    ToolDef { name: "search_notes", group: "notes", desc: "Full-text search across the whole vault with ranked snippets.", args: &[("query", "text to search for"), ("limit", "optional max hits (default 5)")] },
    ToolDef { name: "create_note", group: "notes", desc: "Create a new markdown note in the vault.", args: &[("title", "note title"), ("content", "markdown body (optional)"), ("folder", "folder name to file it into (optional)")] },
    ToolDef { name: "append_to_note", group: "notes", desc: "Append markdown to the end of a note (by id or title).", args: &[("id", "note id"), ("title", "or note title"), ("text", "markdown to append")] },
    ToolDef { name: "create_folder", group: "notes", desc: "Create a folder to organize notes.", args: &[("name", "folder name")] },
    ToolDef { name: "vault_stats", group: "vault", desc: "Overview of the vault: note/word/link counts, open tasks, top tags, streak-ish facts.", args: &[] },
    ToolDef { name: "list_tasks", group: "tasks", desc: "List tasks. Filter by list (today/upcoming/someday) or done state.", args: &[("list", "today | upcoming | someday (optional)"), ("done", "true/false filter (optional)")] },
    ToolDef { name: "create_task", group: "tasks", desc: "Create a task/todo. Priority 0=low 1=normal 2=high. list: today/upcoming/someday.", args: &[("title", "task title"), ("list", "today | upcoming | someday (default today)"), ("priority", "0-2 (optional)"), ("due", "epoch ms (optional)")] },
    ToolDef { name: "complete_task", group: "tasks", desc: "Mark a task done by id or (part of) its title.", args: &[("id", "task id"), ("title", "or task title fragment")] },
    ToolDef { name: "delete_task", group: "tasks", desc: "Delete a task permanently by id or title fragment.", args: &[("id", "task id"), ("title", "or task title fragment")] },
    ToolDef { name: "clear_done_tasks", group: "tasks", desc: "Delete every completed task (spring cleaning).", args: &[] },
    ToolDef { name: "pet_status", group: "pet", desc: "Check the pet's mood: food, energy, joy, level, coins and lifetime stats.", args: &[] },
    ToolDef { name: "feed_pet", group: "pet", desc: "Feed the pet a snack (costs coins like feeding by hand). Options: berry(free), fish, cake, coffee, honey, taco.", args: &[("food", "food id (default berry)")] },
    ToolDef { name: "cheer_pet", group: "pet", desc: "Cheer the pet up (small free joy boost, once per conversation).", args: &[] },
    ToolDef { name: "list_market", group: "market", desc: "Browse open marketplace listings (hats, pets, food, themes, decor) with prices.", args: &[("kind", "hat | pet | food | theme | decor (optional)"), ("limit", "max rows (default 10)")] },
    ToolDef { name: "activity_report", group: "activity", desc: "Report tracked app/screen time (TimeLens-style): totals per app + productive vs distraction split.", args: &[("days", "how many days back (default 1 = today)")] },
    ToolDef { name: "rules_report", group: "rules", desc: "Read the user's activity rulebook: shield state, blocked sites, per-app limits, quiet hours and category patterns.", args: &[] },
    ToolDef { name: "rule_block_site", group: "rules", desc: "Block a site/app by keyword (substring match). The shield then bounces anything whose name contains it.", args: &[("match", "keyword to block, e.g. 'reddit'")] },
    ToolDef { name: "rule_unblock_site", group: "rules", desc: "Remove a keyword from the blocklist.", args: &[("match", "keyword to unblock")] },
    ToolDef { name: "rule_set_limit", group: "rules", desc: "Set a daily minute budget for an app (0 removes it).", args: &[("app", "app name"), ("mins", "minutes per day")] },
    ToolDef { name: "rule_set_shield", group: "rules", desc: "Turn the shield ON or OFF — when up, blocked sites are bounced and limits/quiet hours are enforced.", args: &[("on", "true or false")] },
    ToolDef { name: "web_search", group: "web", desc: "Search the live web and return top results with snippets. Use for research and fresh facts.", args: &[("query", "what to search for"), ("num", "number of results (default 5, max 8)")] },
    ToolDef { name: "read_url", group: "web", desc: "Fetch and read a web page (article text) — great after a web_search.", args: &[("url", "page url (https://…)")] },
    ToolDef { name: "report_bug", group: "web", desc: "File a bug/problem report on behalf of the user into the in-app Logs & Bugs tracker. Use when the user says something is broken or asks to report a bug.", args: &[("desc", "clear description of the problem (steps help)"), ("severity", "minor | normal | blocker (default normal)")] },
];

pub fn tool_names() -> Vec<&'static str> {
    TOOLS.iter().map(|t| t.name).collect()
}

/// English description of the tool list for the system prompt.
pub fn tool_catalog() -> String {
    TOOLS
        .iter()
        .map(|t| format!("- {}({}): {}", t.name, t.args.iter().map(|a| a.0).collect::<Vec<_>>().join(", "), t.desc))
        .collect::<Vec<_>>()
        .join("\n")
}

fn http() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Nook/1.0")
            .build()
            .unwrap_or_default()
    })
}

const FOODS: &[(&str, &str, i64, i64, i64, i64)] = &[
    // id, name, cost, food, joy, energy
    ("berry", "Pixel berry", 0, 14, 3, 0),
    ("fish", "Fish snack", 3, 32, 6, 0),
    ("cake", "Moon cake", 8, 20, 28, 0),
    ("coffee", "Warm drink", 5, 4, 4, 36),
    ("honey", "Golden honey", 6, 22, 14, 8),
    ("taco", "Pixel taco", 7, 30, 18, 6),
];

fn find_note(c: &Connection, a: &Map<String, Value>) -> Option<Value> {
    let notes = all_notes(c);
    let id = s(a.get("id"), 200);
    let t = title_key(&s(a.get("title"), 200));
    notes
        .iter()
        .find(|n| !id.is_empty() && n["id"].as_str() == Some(&id))
        .or_else(|| notes.iter().find(|n| !t.is_empty() && title_key(n["title"].as_str().unwrap_or("")) == t))
        .cloned()
}

fn empty_rules() -> Value {
    json!({ "shieldOn": false, "blocklist": [], "limits": {}, "quiet": { "enabled": false, "from": 9, "to": 12 }, "patterns": [], "pinHash": "" })
}

fn load_rules(c: &Connection) -> Option<Value> {
    setting_get(c, "activity-rules").and_then(|v| serde_json::from_str(&v).ok())
}

fn fmt_secs(s: i64) -> String {
    format!("{}h {}m", s / 3600, ((s % 3600) as f64 / 60.0).round() as i64)
}

fn exec_sync(c: &Connection, name: &str, a: &Map<String, Value>) -> Option<ToolRun> {
    let now = now_ms();
    Some(match name {
        "list_notes" => {
            let q = s(a.get("query"), 200).to_lowercase();
            let lim = loose_num(a.get("limit")).filter(|n| *n > 0.0).unwrap_or(12.0).min(30.0) as usize;
            let hit: Vec<Value> = all_notes(c)
                .into_iter()
                .filter(|n| q.is_empty() || n["title"].as_str().unwrap_or("").to_lowercase().contains(&q) || n["content"].as_str().unwrap_or("").to_lowercase().contains(&q))
                .take(lim)
                .collect();
            let summary = if hit.is_empty() {
                "No notes matched.".to_string()
            } else {
                format!("{} note(s): {}", hit.len(), hit.iter().map(|n| format!("“{}”", n["title"].as_str().unwrap_or(""))).collect::<Vec<_>>().join(", "))
            };
            ok(summary, Some(Value::Array(hit.iter().map(|n| json!({ "id": n["id"], "title": n["title"], "words": note_meta(n["content"].as_str().unwrap_or("")).words, "updatedAt": n["updatedAt"] })).collect())))
        }
        "read_note" => match find_note(c, a) {
            None => fail("Note not found."),
            Some(n) => {
                let content = n["content"].as_str().unwrap_or("");
                ok(format!("Read “{}” ({} words).", n["title"].as_str().unwrap_or(""), note_meta(content).words), Some(json!({ "id": n["id"], "title": n["title"], "content": take(content, 6000) })))
            }
        },
        "search_notes" => {
            let raw = s(a.get("query"), 200);
            let q = raw.to_lowercase();
            if q.is_empty() {
                return Some(fail("A query is required."));
            }
            let lim = loose_num(a.get("limit")).filter(|n| *n > 0.0).unwrap_or(5.0).min(10.0) as usize;
            let mut hits: Vec<(i64, Value)> = all_notes(c)
                .into_iter()
                .filter_map(|n| {
                    let content = n["content"].as_str().unwrap_or("");
                    let body = content.to_lowercase();
                    let score = if n["title"].as_str().unwrap_or("").to_lowercase().contains(&q) { 3 } else { 0 } + body.matches(&q).count() as i64;
                    if score == 0 {
                        return None;
                    }
                    let snippet = match body.find(&q) {
                        Some(idx) => {
                            // map the lowercase byte index back onto char positions of the original
                            let ci = body[..idx].chars().count();
                            content.chars().skip(ci.saturating_sub(40)).take(160.min(ci.min(40) + 120)).collect::<String>()
                        }
                        None => String::new(),
                    };
                    Some((score, json!({ "id": n["id"], "title": n["title"], "snippet": snippet })))
                })
                .collect();
            hits.sort_by_key(|h| std::cmp::Reverse(h.0));
            let hits: Vec<Value> = hits.into_iter().take(lim).map(|h| h.1).collect();
            let summary = if hits.is_empty() { format!("Nothing in the vault matches “{raw}”.") } else { format!("{} hit(s) for “{raw}”.", hits.len()) };
            ok(summary, Some(Value::Array(hits)))
        }
        "create_note" => {
            let title = s(a.get("title"), 120);
            if title.is_empty() {
                return Some(fail("A title is required."));
            }
            let fname = s(a.get("folder"), 60);
            let mut folder_id: Option<String> = None;
            if !fname.is_empty() {
                let found: Option<String> = c.query_row(r#"SELECT "id" FROM "Folder" WHERE "name"=?1 LIMIT 1"#, params![fname], |r| r.get(0)).optional().ok().flatten();
                folder_id = Some(match found {
                    Some(id) => id,
                    None => {
                        let id = new_id();
                        let pos: i64 = c.query_row(r#"SELECT COUNT(*) FROM "Folder""#, [], |r| r.get(0)).unwrap_or(0);
                        let _ = c.execute(r#"INSERT INTO "Folder" ("id","name","icon","color","position","createdAt") VALUES (?1,?2,'folder','',?3,?4)"#, params![id, fname, pos, now]);
                        id
                    }
                });
            }
            let id = new_id();
            let body = Some(s(a.get("content"), 30_000)).filter(|x| !x.is_empty()).unwrap_or_else(|| format!("# {title}\n\n"));
            if let Err(e) = c.execute(
                r#"INSERT INTO "Note" ("id","title","content","pinned","folderId","tags","createdAt","updatedAt") VALUES (?1,?2,?3,0,?4,'[]',?5,?5)"#,
                params![id, title, body, folder_id, now],
            ) {
                return Some(fail(e.to_string()));
            }
            ok(format!("Created note “{title}”{}.", if fname.is_empty() { String::new() } else { format!(" in {fname}") }), Some(json!({ "id": id, "title": title })))
        }
        "append_to_note" => {
            let Some(n) = find_note(c, a) else { return Some(fail("Note not found.")) };
            let text = s(a.get("text"), 8000);
            if text.is_empty() {
                return Some(fail("Nothing to append."));
            }
            let merged = format!("{}\n\n{}\n", n["content"].as_str().unwrap_or("").trim_end(), text);
            let _ = c.execute(r#"UPDATE "Note" SET "content"=?1, "updatedAt"=?2 WHERE "id"=?3"#, params![merged, now, n["id"].as_str()]);
            ok(format!("Appended {} words to “{}”.", text.split_whitespace().count(), n["title"].as_str().unwrap_or("")), None)
        }
        "create_folder" => {
            let name = s(a.get("name"), 60);
            if name.is_empty() {
                return Some(fail("A folder name is required."));
            }
            let exists = c.query_row(r#"SELECT 1 FROM "Folder" WHERE "name"=?1"#, params![name], |_| Ok(())).optional().ok().flatten().is_some();
            if exists {
                return Some(fail(format!("Folder “{name}” already exists.")));
            }
            let id = new_id();
            let pos: i64 = c.query_row(r#"SELECT COUNT(*) FROM "Folder""#, [], |r| r.get(0)).unwrap_or(0);
            let _ = c.execute(r#"INSERT INTO "Folder" ("id","name","icon","color","position","createdAt") VALUES (?1,?2,'folder','',?3,?4)"#, params![id, name, pos, now]);
            ok(format!("Created folder “{name}”."), Some(json!({ "id": id })))
        }
        "vault_stats" => {
            let notes = all_notes(c);
            let (mut words, mut links, mut nt, mut open_nt) = (0usize, 0usize, 0usize, 0usize);
            let mut tag_count: Vec<(String, usize)> = vec![];
            for n in &notes {
                let m = note_meta(n["content"].as_str().unwrap_or(""));
                words += m.words;
                links += m.links.len();
                nt += m.tasks_total;
                open_nt += m.tasks_total - m.tasks_done;
                for t in m.tags {
                    match tag_count.iter_mut().find(|x| x.0 == t) {
                        Some(x) => x.1 += 1,
                        None => tag_count.push((t, 1)),
                    }
                }
            }
            let _ = nt;
            let open: i64 = c.query_row(r#"SELECT COUNT(*) FROM "Task" WHERE "done"=0"#, [], |r| r.get(0)).unwrap_or(0);
            tag_count.sort_by_key(|t| std::cmp::Reverse(t.1));
            let top: Vec<String> = tag_count.iter().take(6).map(|(t, n)| format!("#{t}×{n}")).collect();
            ok(
                format!("Vault: {} notes · {} words · {} links · {} open tasks ({} inside notes).", notes.len(), thousands(words), links, open, open_nt),
                Some(json!({ "notes": notes.len(), "words": words, "links": links, "openTasks": open, "openNoteTasks": open_nt, "topTags": top })),
            )
        }
        "list_tasks" => {
            let list = s(a.get("list"), 20);
            let done = s(a.get("done"), 10);
            let mut sql = r#"SELECT * FROM "Task" WHERE 1=1"#.to_string();
            let mut vals: Vec<rusqlite::types::Value> = vec![];
            if !list.is_empty() {
                sql.push_str(r#" AND "list"=?"#);
                vals.push(list.into());
            }
            if done == "true" || done == "false" {
                sql.push_str(r#" AND "done"=?"#);
                vals.push(((done == "true") as i64).into());
            }
            sql.push_str(r#" ORDER BY "done" ASC, "createdAt" DESC, rowid DESC LIMIT 40"#);
            let rows = query_vec(c, &sql, rusqlite::params_from_iter(vals), crate::api::task_row);
            let label = if rows.is_empty() {
                "No tasks in that view.".to_string()
            } else {
                rows.iter()
                    .map(|t| format!("{} {}{}", if t["done"].as_bool().unwrap_or(false) { "☑" } else { "☐" }, t["title"].as_str().unwrap_or(""), if t["priority"] == 2 { " (!!)" } else { "" }))
                    .collect::<Vec<_>>()
                    .join("; ")
            };
            ok(label, Some(Value::Array(rows.iter().map(|t| json!({ "id": t["id"], "title": t["title"], "list": t["list"], "priority": t["priority"], "done": t["done"], "due": t["due"] })).collect())))
        }
        "create_task" => {
            let title = s(a.get("title"), 160);
            if title.is_empty() {
                return Some(fail("A task title is required."));
            }
            let l = s(a.get("list"), 20);
            let list = if ["today", "upcoming", "someday"].contains(&l.as_str()) { l } else { "today".into() };
            let pr = loose_num(a.get("priority")).filter(|p| [0.0, 1.0, 2.0].contains(p)).unwrap_or(1.0) as i64;
            let due = loose_num(a.get("due")).filter(|d| *d > 0.0).map(|d| d.round() as i64);
            let id = new_id();
            let _ = c.execute(
                r#"INSERT INTO "Task" ("id","title","list","priority","due","done","tags","by","createdAt") VALUES (?1,?2,?3,?4,?5,0,'[]','ai',?6)"#,
                params![id, title, list, pr, due, now],
            );
            ok(format!("Added task “{title}” to {list}{}.", if pr == 2 { " (high priority)" } else { "" }), Some(json!({ "id": id })))
        }
        "complete_task" => {
            let id = s(a.get("id"), 80);
            let mut t: Option<(String, String)> = None;
            if !id.is_empty() {
                t = c.query_row(r#"SELECT "id","title" FROM "Task" WHERE "id"=?1"#, params![id], |r| Ok((r.get(0)?, r.get(1)?))).optional().ok().flatten();
            }
            let frag = s(a.get("title"), 200).to_lowercase();
            if t.is_none() && !frag.is_empty() {
                let rows = query_vec(c, r#"SELECT "id","title" FROM "Task" WHERE "done"=0 ORDER BY rowid LIMIT 50"#, [], |r| Ok(json!([r.get::<_, String>(0)?, r.get::<_, String>(1)?])));
                t = rows.iter().find(|x| x[1].as_str().unwrap_or("").to_lowercase().contains(&frag)).map(|x| (x[0].as_str().unwrap_or("").into(), x[1].as_str().unwrap_or("").into()));
            }
            match t {
                None => fail("Task not found."),
                Some((id, title)) => {
                    let _ = c.execute(r#"UPDATE "Task" SET "done"=1, "completedAt"=?1 WHERE "id"=?2"#, params![now, id]);
                    ok(format!("Completed “{title}”."), None)
                }
            }
        }
        "delete_task" => {
            let id = s(a.get("id"), 80);
            if !id.is_empty() {
                let n = c.execute(r#"DELETE FROM "Task" WHERE "id"=?1"#, params![id]).unwrap_or(0);
                return Some(if n > 0 { ok("Task deleted.", None) } else { fail("Task not found.") });
            }
            let frag = s(a.get("title"), 200).to_lowercase();
            if frag.is_empty() {
                return Some(fail("Give me the task id or part of the title."));
            }
            let rows = query_vec(c, r#"SELECT "id","title" FROM "Task" ORDER BY rowid LIMIT 60"#, [], |r| Ok(json!([r.get::<_, String>(0)?, r.get::<_, String>(1)?])));
            match rows.iter().find(|x| x[1].as_str().unwrap_or("").to_lowercase().contains(&frag)) {
                None => fail("Task not found."),
                Some(x) => {
                    let _ = c.execute(r#"DELETE FROM "Task" WHERE "id"=?1"#, params![x[0].as_str()]);
                    ok(format!("Deleted “{}”.", x[1].as_str().unwrap_or("")), None)
                }
            }
        }
        "clear_done_tasks" => {
            let n = c.execute(r#"DELETE FROM "Task" WHERE "done"=1"#, []).unwrap_or(0);
            ok(format!("Cleared {n} completed task{}.", if n == 1 { "" } else { "s" }), None)
        }
        "pet_status" | "feed_pet" | "cheer_pet" => {
            let row = c
                .query_row(r#"SELECT "id","name","species","food","energy","joy","xp","coins","hat","owned","stats" FROM "Pet" LIMIT 1"#, [], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        json!({ "name": r.get::<_, String>(1)?, "species": r.get::<_, String>(2)?, "food": r.get::<_, i64>(3)?, "energy": r.get::<_, i64>(4)?, "joy": r.get::<_, i64>(5)?,
                            "xp": r.get::<_, i64>(6)?, "coins": r.get::<_, i64>(7)?, "hat": r.get::<_, String>(8)?,
                            "owned": serde_json::from_str::<Value>(&r.get::<_, String>(9)?).unwrap_or(json!([])),
                            "stats": parse_json_obj(&r.get::<_, String>(10)?) }),
                    ))
                })
                .optional()
                .ok()
                .flatten();
            let Some((pid, p)) = row else { return Some(fail("No pet yet.")) };
            let g = |k: &str| p[k].as_i64().unwrap_or(0);
            let pname = p["name"].as_str().unwrap_or("Pet").to_string();
            match name {
                "pet_status" => {
                    let lv = level_of(g("xp"));
                    ok(format!("{pname} (Lv {lv} {}) — food {}/100, energy {}/100, joy {}/100, {} coins.", stage_name(lv), g("food"), g("energy"), g("joy"), g("coins")), Some(p))
                }
                "feed_pet" => {
                    let want = Some(s(a.get("food"), 20)).filter(|x| !x.is_empty()).unwrap_or_else(|| "berry".into());
                    let f = FOODS.iter().find(|f| f.0 == want).unwrap_or(&FOODS[0]);
                    if g("coins") < f.2 {
                        return Some(fail(format!("Not enough coins for {} ({}c). {pname} has {}c.", f.1, f.2, g("coins"))));
                    }
                    let _ = c.execute(
                        r#"UPDATE "Pet" SET "food"=?1,"joy"=?2,"energy"=?3,"coins"=?4,"xp"=?5,"tickAt"=?6 WHERE "id"=?7"#,
                        params![(g("food") + f.3).clamp(0, 100), (g("joy") + f.4).clamp(0, 100), (g("energy") + f.5).clamp(0, 100), g("coins") - f.2, g("xp") + 2, now, pid],
                    );
                    let mut msg = format!("Fed {} to {pname}: +{} food", f.1, f.3);
                    if f.4 > 0 {
                        msg.push_str(&format!(" +{} joy", f.4));
                    }
                    if f.5 > 0 {
                        msg.push_str(&format!(" +{} energy", f.5));
                    }
                    if f.2 > 0 {
                        msg.push_str(&format!(" (-{} coins)", f.2));
                    }
                    msg.push('.');
                    ok(msg, None)
                }
                _ => {
                    let _ = c.execute(r#"UPDATE "Pet" SET "joy"=?1,"tickAt"=?2 WHERE "id"=?3"#, params![(g("joy") + 3).clamp(0, 100), now, pid]);
                    ok(format!("{pname} beams! +3 joy."), None)
                }
            }
        }
        "list_market" => {
            let kind = s(a.get("kind"), 20);
            let lim = loose_num(a.get("limit")).filter(|n| *n > 0.0).unwrap_or(10.0).min(20.0) as i64;
            let rows = if kind.is_empty() {
                query_vec(c, r#"SELECT "id","name","kind","price" FROM "Listing" WHERE "sold"=0 ORDER BY "price" ASC LIMIT ?1"#, params![lim], mrow)
            } else {
                query_vec(c, r#"SELECT "id","name","kind","price" FROM "Listing" WHERE "sold"=0 AND "kind"=?2 ORDER BY "price" ASC LIMIT ?1"#, params![lim, kind], mrow)
            };
            let summary = if rows.is_empty() {
                "The bazaar shelves are empty right now.".to_string()
            } else {
                format!("Cheapest first: {}", rows.iter().map(|l| format!("{} {}c", l["name"].as_str().unwrap_or(""), l["price"])).collect::<Vec<_>>().join(", "))
            };
            ok(summary, Some(Value::Array(rows)))
        }
        "activity_report" => {
            let days = loose_num(a.get("days")).filter(|d| *d != 0.0).unwrap_or(1.0).clamp(1.0, 14.0) as i64;
            let cutoff = day_key(now - (days - 1) * 86_400_000);
            let rows = query_vec(c, r#"SELECT "app","cat","secs" FROM "AppUse" WHERE "day">=?1 ORDER BY rowid"#, params![cutoff], |r| {
                Ok(json!([r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?]))
            });
            if rows.is_empty() {
                return Some(ok(if days == 1 { "No app usage tracked today yet.".to_string() } else { format!("No app usage tracked in the last {days} days.") }, None));
            }
            let mut per_app: Vec<(String, i64)> = vec![];
            let (mut prod, mut neu, mut dis) = (0i64, 0i64, 0i64);
            for r in &rows {
                let (app, cat, secs) = (r[0].as_str().unwrap_or(""), r[1].as_str().unwrap_or(""), r[2].as_i64().unwrap_or(0));
                match per_app.iter_mut().find(|x| x.0 == app) {
                    Some(x) => x.1 += secs,
                    None => per_app.push((app.into(), secs)),
                }
                match cat {
                    "productive" => prod += secs,
                    "neutral" => neu += secs,
                    "distraction" => dis += secs,
                    _ => {}
                }
            }
            per_app.sort_by_key(|x| std::cmp::Reverse(x.1));
            let top: Vec<(String, i64)> = per_app.into_iter().take(8).collect();
            let total = top.iter().map(|x| x.1).sum::<i64>();
            let mut per = Map::new();
            for (k, v) in &top {
                per.insert(k.clone(), json!(v));
            }
            ok(
                format!(
                    "Last {days} day(s): {} tracked. Top: {}. Productive {} · neutral {} · distraction {}.",
                    fmt_secs(total),
                    top.iter().map(|(ap, v)| format!("{ap} {}", fmt_secs(*v))).collect::<Vec<_>>().join(", "),
                    fmt_secs(prod),
                    fmt_secs(neu),
                    fmt_secs(dis)
                ),
                Some(json!({ "perApp": per, "perCat": { "productive": prod, "neutral": neu, "distraction": dis }, "days": days })),
            )
        }
        "rules_report" => {
            let Some(r) = load_rules(c) else {
                return Some(ok("No rules saved yet — the rulebook is empty (shield off, nothing blocked).", None));
            };
            let blocks: Vec<String> = r["blocklist"].as_array().map(|a| a.iter().filter(|b| b["enabled"].as_bool().unwrap_or(false)).filter_map(|b| b["match"].as_str().map(String::from)).collect()).unwrap_or_default();
            let limits: Vec<String> = r["limits"].as_object().map(|m| m.iter().map(|(k, v)| format!("{k} {v}m/day")).collect()).unwrap_or_default();
            let quiet = if r["quiet"]["enabled"].as_bool().unwrap_or(false) { format!("{}:00–{}:00", r["quiet"]["from"], r["quiet"]["to"]) } else { "off".into() };
            ok(
                format!(
                    "Shield {}. Blocked: {}. Limits: {}. Quiet hours: {quiet}. Patterns: {}.",
                    if r["shieldOn"].as_bool().unwrap_or(false) { "UP" } else { "down" },
                    if blocks.is_empty() { "none".into() } else { blocks.join(", ") },
                    if limits.is_empty() { "none".into() } else { limits.join(", ") },
                    r["patterns"].as_array().map(|a| a.len()).unwrap_or(0)
                ),
                Some(r),
            )
        }
        "rule_block_site" => {
            let m = s(a.get("match"), 60).to_lowercase();
            if m.is_empty() {
                return Some(fail("A keyword is required."));
            }
            let mut r = load_rules(c).unwrap_or_else(empty_rules);
            if !r["blocklist"].is_array() {
                r["blocklist"] = json!([]);
            }
            let list = r["blocklist"].as_array_mut().unwrap();
            if list.iter().any(|b| b["match"].as_str() == Some(&m)) {
                return Some(ok(format!("“{m}” is already on the blocklist."), None));
            }
            list.push(json!({ "id": format!("ai-{}", crate::api::radix36(now as u64)), "match": m, "enabled": true, "createdAt": now }));
            let n = list.len();
            let _ = setting_put(c, "activity-rules", &r.to_string());
            ok(format!("Blocked “{m}” ({n} rules total). It will be bounced whenever the shield is up."), None)
        }
        "rule_unblock_site" => {
            let m = s(a.get("match"), 60).to_lowercase();
            let Some(mut r) = load_rules(c) else { return Some(fail("No rules saved — nothing to unblock.")) };
            let Some(list) = r["blocklist"].as_array_mut() else { return Some(fail(format!("“{m}” wasn't on the blocklist."))) };
            let before = list.len();
            list.retain(|b| b["match"].as_str() != Some(&m));
            if list.len() == before {
                return Some(fail(format!("“{m}” wasn't on the blocklist.")));
            }
            let _ = setting_put(c, "activity-rules", &r.to_string());
            ok(format!("Unblocked “{m}”."), None)
        }
        "rule_set_limit" => {
            let app = s(a.get("app"), 40).to_lowercase();
            let mins = loose_num(a.get("mins")).map(|m| m.round() as i64);
            if app.is_empty() {
                return Some(fail("An app name is required."));
            }
            let Some(mins) = mins.filter(|m| (0..=720).contains(m)) else { return Some(fail("mins must be 0–720.")) };
            let mut r = load_rules(c).unwrap_or_else(empty_rules);
            if !r["limits"].is_object() {
                r["limits"] = json!({});
            }
            let lim = r["limits"].as_object_mut().unwrap();
            if mins == 0 {
                lim.remove(&app);
            } else {
                lim.insert(app.clone(), json!(mins));
            }
            let _ = setting_put(c, "activity-rules", &r.to_string());
            ok(if mins == 0 { format!("Removed the limit for {app}.") } else { format!("{app} is now limited to {mins} min/day.") }, None)
        }
        "rule_set_shield" => {
            let on = matches!(a.get("on"), Some(Value::Bool(true))) || matches!(a.get("on").and_then(|v| v.as_str()), Some("true") | Some("on"));
            let mut r = load_rules(c).unwrap_or_else(empty_rules);
            r["shieldOn"] = json!(on);
            let _ = setting_put(c, "activity-rules", &r.to_string());
            ok(if on { "Shield is UP — rules are enforced." } else { "Shield is down — tracking only." }, None)
        }
        "report_bug" => {
            let desc = s(a.get("desc"), 1200);
            if desc.is_empty() {
                return Some(fail("A description is required."));
            }
            let sev = s(a.get("severity"), 10);
            let severity = if ["minor", "normal", "blocker"].contains(&sev.as_str()) { sev } else { "normal".into() };
            let mut b = Map::new();
            b.insert("desc".into(), json!(desc));
            b.insert("severity".into(), json!(severity));
            b.insert("page".into(), json!("ai-harness"));
            b.insert("ua".into(), json!("filed-by-assistant"));
            match bugs_insert(c, &b) {
                Ok(row) => {
                    let id = row["id"].as_str().unwrap_or("").to_string();
                    ok(format!("Bug report #{} filed ({severity}). The user can track it in Logs & Bugs.", take(&id, 6)), Some(json!({ "id": id, "severity": severity })))
                }
                Err(e) => fail(e),
            }
        }
        _ => return None,
    })
}

fn mrow(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({ "id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "kind": r.get::<_, String>(2)?, "price": r.get::<_, i64>(3)? }))
}

fn thousands(n: usize) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

// ------------------------------------------------------------------ web tools

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#x27;", "'").replace("&#39;", "'").replace("&nbsp;", " ")
}

pub fn strip_tags(html: &str) -> String {
    let lower = html.to_lowercase();
    let mut out = String::with_capacity(html.len() / 2);
    let mut i = 0;
    let bytes = html.as_bytes();
    while i < bytes.len() {
        if bytes[i] == b'<' {
            // drop script/style/noscript blocks wholesale
            let mut skipped = false;
            for tag in ["script", "style", "noscript", "svg", "head"] {
                if lower[i..].starts_with(&format!("<{tag}")) {
                    if let Some(end) = lower[i..].find(&format!("</{tag}>")) {
                        i += end + tag.len() + 3;
                        skipped = true;
                        break;
                    }
                }
            }
            if skipped {
                out.push(' ');
                continue;
            }
            match html[i..].find('>') {
                Some(e) => i += e + 1,
                None => break,
            }
            out.push(' ');
        } else {
            let ch = html[i..].chars().next().unwrap_or(' ');
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    decode_entities(&out).split_whitespace().collect::<Vec<_>>().join(" ")
}

fn between<'a>(s: &'a str, a: &str, b: &str) -> Option<&'a str> {
    let i = s.find(a)? + a.len();
    let j = s[i..].find(b)?;
    Some(&s[i..i + j])
}

/// Parse DuckDuckGo's HTML results page.
pub fn parse_ddg(html: &str, max: usize) -> Vec<Value> {
    let mut out = vec![];
    for block in html.split("class=\"result__a\"").skip(1) {
        let href = between(block, "href=\"", "\"").unwrap_or("");
        let title = between(block, ">", "</a>").map(strip_tags).unwrap_or_default();
        let snippet = between(block, "class=\"result__snippet\"", "</a>").and_then(|x| x.split_once('>').map(|y| y.1)).map(strip_tags).unwrap_or_default();
        let mut url = decode_entities(href);
        if let Some(enc) = url.split("uddg=").nth(1) {
            url = crate::api::pct_decode(enc.split('&').next().unwrap_or(""));
        }
        if url.starts_with("//") {
            url = format!("https:{url}");
        }
        if !url.starts_with("http") || url.contains("duckduckgo.com/y.js") {
            continue;
        }
        let host = url.split("//").nth(1).and_then(|x| x.split('/').next()).unwrap_or("").to_string();
        out.push(json!({ "title": title, "url": url, "snippet": take(&snippet, 240), "host": host, "date": "" }));
        if out.len() >= max {
            break;
        }
    }
    out
}

async fn web_search(a: &Map<String, Value>) -> ToolRun {
    let query = s(a.get("query"), 200);
    if query.is_empty() {
        return fail("A search query is required.");
    }
    let num = loose_num(a.get("num")).filter(|n| *n != 0.0).unwrap_or(5.0).clamp(1.0, 8.0) as usize;
    let base = std::env::var("NOOK_SEARCH_URL").unwrap_or_else(|_| "https://html.duckduckgo.com/html/".into());
    let res = http().post(&base).form(&[("q", query.as_str())]).send().await;
    let html = match res {
        Ok(r) if r.status().is_success() => r.text().await.unwrap_or_default(),
        _ => return fail("Web search is unavailable right now (offline or rate-limited)."),
    };
    let items = parse_ddg(&html, num);
    if items.is_empty() {
        return ok(format!("The web search returned nothing for “{query}”."), None);
    }
    let heads: Vec<String> = items.iter().take(3).map(|i| i["title"].as_str().filter(|t| !t.is_empty()).or(i["host"].as_str()).unwrap_or("").to_string()).collect();
    ok(format!("Found {} web results for “{query}”: {}…", items.len(), heads.join("; ")), Some(Value::Array(items)))
}

async fn read_url(a: &Map<String, Value>) -> ToolRun {
    let url = s(a.get("url"), 400);
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return fail("A full http(s) URL is required.");
    }
    let html = match http().get(&url).send().await {
        Ok(r) if r.status().is_success() => r.text().await.unwrap_or_default(),
        _ => return fail("That page could not be fetched."),
    };
    let title = between(&html, "<title", "</title>").and_then(|t| t.split_once('>').map(|x| x.1)).map(|t| decode_entities(t.trim())).filter(|t| !t.is_empty()).unwrap_or_else(|| url.clone());
    let text = strip_tags(&html);
    if text.is_empty() {
        return fail("Could not extract text from that page.");
    }
    ok(format!("Read “{title}” ({} chars).", text.chars().count().min(9999)), Some(json!({ "title": title, "text": take(&text, 3000) })))
}

/// Execute a batch of tool calls (max 6). Returns the trace + a text blob for the model.
pub async fn execute_tools(db: &Db, calls: &[Value]) -> (Vec<Value>, String) {
    let mut trace = vec![];
    let mut lines = vec![];
    for call in calls.iter().take(6) {
        let name = call.get("name").and_then(|n| n.as_str()).unwrap_or("?").to_string();
        let args = call.get("args").and_then(|a| a.as_object()).cloned().unwrap_or_default();
        let args_v = Value::Object(args.clone());
        let t0 = Instant::now();
        if !TOOLS.iter().any(|t| t.name == name) {
            trace.push(json!({ "name": name, "args": args_v, "ok": false, "summary": "Unknown tool.", "ms": 0 }));
            lines.push(format!("{name}: ERROR unknown tool"));
            continue;
        }
        let run = match name.as_str() {
            "web_search" => web_search(&args).await,
            "read_url" => read_url(&args).await,
            other => {
                let c = db.conn();
                exec_sync(&c, other, &args).unwrap_or_else(|| fail("Unknown tool."))
            }
        };
        let ms = t0.elapsed().as_millis() as u64;
        let data = run.data.as_ref().map(|d| format!(" | data: {}", take(&d.to_string(), 1400))).unwrap_or_default();
        lines.push(format!("{name}({}): {} — {}{data}", args_v, if run.ok { "OK" } else { "FAILED" }, run.summary));
        trace.push(json!({ "name": name, "args": args_v, "ok": run.ok, "summary": run.summary, "ms": ms }));
    }
    let feedback = if lines.is_empty() { "No tools ran.".to_string() } else { lines.join("\n") };
    (trace, feedback)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn run(db: &Db, name: &str, args: Value) -> Value {
        let (t, _) = execute_tools(db, &[json!({ "name": name, "args": args })]).await;
        t[0].clone()
    }

    #[tokio::test]
    async fn every_local_tool_runs() {
        let db = Db::open_in_memory().unwrap();
        assert!(run(&db, "list_notes", json!({ "query": "graph" })).await["ok"].as_bool().unwrap());
        assert!(run(&db, "read_note", json!({ "title": "graph view" })).await["summary"].as_str().unwrap().contains("Graph view"));
        assert!(run(&db, "search_notes", json!({ "query": "pixel" })).await["summary"].as_str().unwrap().contains("hit"));
        let r = run(&db, "create_note", json!({ "title": "Agent note", "folder": "Inbox" })).await;
        assert!(r["ok"].as_bool().unwrap(), "{r}");
        assert!(run(&db, "append_to_note", json!({ "title": "Agent note", "text": "more words here" })).await["ok"].as_bool().unwrap());
        assert!(!run(&db, "create_folder", json!({ "name": "Inbox" })).await["ok"].as_bool().unwrap());
        assert!(run(&db, "vault_stats", json!({})).await["summary"].as_str().unwrap().starts_with("Vault: 15 notes"));
        assert!(run(&db, "create_task", json!({ "title": "Ship it", "priority": "2" })).await["summary"].as_str().unwrap().contains("high priority"));
        assert!(run(&db, "list_tasks", json!({ "done": "false" })).await["summary"].as_str().unwrap().contains("Ship it"));
        assert!(run(&db, "complete_task", json!({ "title": "ship" })).await["ok"].as_bool().unwrap());
        assert!(run(&db, "clear_done_tasks", json!({})).await["summary"].as_str().unwrap().contains("Cleared 1"));
        run(&db, "create_task", json!({ "title": "Temp" })).await;
        assert!(run(&db, "delete_task", json!({ "title": "temp" })).await["ok"].as_bool().unwrap());
        assert!(run(&db, "pet_status", json!({})).await["summary"].as_str().unwrap().contains("Mochi (Lv 1 Baby)"));
        assert!(run(&db, "feed_pet", json!({ "food": "cake" })).await["summary"].as_str().unwrap().contains("-8 coins"));
        assert!(run(&db, "cheer_pet", json!({})).await["ok"].as_bool().unwrap());
        assert!(run(&db, "list_market", json!({ "kind": "hat" })).await["summary"].as_str().unwrap().starts_with("Cheapest first: Cozy beanie 9c"));
        assert!(run(&db, "activity_report", json!({})).await["summary"].as_str().unwrap().contains("No app usage"));
        assert!(run(&db, "rules_report", json!({})).await["summary"].as_str().unwrap().contains("empty"));
        assert!(run(&db, "rule_block_site", json!({ "match": "Reddit" })).await["ok"].as_bool().unwrap());
        assert!(run(&db, "rule_set_limit", json!({ "app": "youtube", "mins": 30 })).await["ok"].as_bool().unwrap());
        assert!(run(&db, "rule_set_shield", json!({ "on": "true" })).await["ok"].as_bool().unwrap());
        let rep = run(&db, "rules_report", json!({})).await;
        assert!(rep["summary"].as_str().unwrap().contains("Shield UP. Blocked: reddit. Limits: youtube 30m/day"), "{rep}");
        assert!(run(&db, "rule_unblock_site", json!({ "match": "reddit" })).await["ok"].as_bool().unwrap());
        assert!(run(&db, "report_bug", json!({ "desc": "it broke", "severity": "blocker" })).await["ok"].as_bool().unwrap());
        assert!(!run(&db, "read_url", json!({ "url": "notaurl" })).await["ok"].as_bool().unwrap());
        assert!(!run(&db, "web_search", json!({})).await["ok"].as_bool().unwrap());
        assert_eq!(run(&db, "nope", json!({})).await["summary"], "Unknown tool.");
    }

    #[test]
    fn parses_ddg_html() {
        let html = r#"<div><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=x">Example <b>A</b></a>
        <a class="result__snippet" href="x">Snippet &amp; more</a></div>
        <div><a rel="nofollow" class="result__a" href="https://rust-lang.org/">Rust</a><a class="result__snippet" href="y">Fast</a></div>"#;
        let r = parse_ddg(html, 5);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0]["url"], "https://example.com/a");
        assert_eq!(r[0]["title"], "Example A");
        assert_eq!(r[0]["snippet"], "Snippet & more");
        assert_eq!(r[1]["host"], "rust-lang.org");
        assert_eq!(strip_tags("<p>Hi<script>x()</script> <b>there</b></p>"), "Hi there");
        assert!(tool_catalog().contains("- web_search(query, num)"));
        assert_eq!(TOOLS.len(), 25);
    }
}
