//! Small helpers shared by the API router, agent tools and MCP server.

use serde_json::Value;

/// JS-style `String(v ?? "").trim().slice(0, max)` (char based).
pub fn s(v: Option<&Value>, max: usize) -> String {
    let raw = match v {
        Some(Value::String(x)) => x.clone(),
        Some(Value::Null) | None => String::new(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(other) => other.to_string(),
    };
    take(raw.trim(), max)
}

/// `.slice(0, max)` on chars.
pub fn take(x: &str, max: usize) -> String {
    match x.char_indices().nth(max) {
        Some((i, _)) => x[..i].to_string(),
        None => x.to_string(),
    }
}

/// Only accept real strings (like `typeof v === "string"`).
pub fn str_of(v: Option<&Value>) -> Option<&str> {
    v.and_then(|x| x.as_str())
}

/// `typeof v === "number" && isFinite(v)`
pub fn num_of(v: Option<&Value>) -> Option<f64> {
    v.and_then(|x| x.as_f64()).filter(|f| f.is_finite())
}

/// JS `Number(v)` for loosely typed tool args (strings like "3" are accepted).
pub fn loose_num(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(x)) => x.trim().parse::<f64>().ok(),
        Some(Value::Bool(b)) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
    .filter(|f| f.is_finite())
}

/// `/^[\w-]{min,max}$/`
pub fn is_word_id(id: &str, min: usize, max: usize, extra: &[char]) -> bool {
    let n = id.chars().count();
    n >= min && n <= max && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || extra.contains(&c))
}

/// `/^#[0-9a-fA-F]{3,8}$/`
pub fn is_hex_color(x: &str) -> bool {
    let b = x.as_bytes();
    b.len() >= 4 && b.len() <= 9 && b[0] == b'#' && b[1..].iter().all(|c| c.is_ascii_hexdigit())
}

pub fn clean_tags(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Array(a)) => a.iter().filter_map(|t| t.as_str()).map(|t| take(t, 24)).take(12).collect(),
        _ => vec![],
    }
}

pub fn parse_tags(raw: &str) -> Vec<String> {
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Array(a)) => a.iter().filter_map(|t| t.as_str().map(String::from)).take(12).collect(),
        _ => vec![],
    }
}

pub fn parse_json_obj(raw: &str) -> Value {
    match serde_json::from_str::<Value>(raw) {
        Ok(v @ Value::Object(_)) => v,
        _ => Value::Object(Default::default()),
    }
}

pub fn title_key(t: &str) -> String {
    t.trim().to_lowercase()
}

/// Lightweight port of `parseNote()` from the frontend: links, tags, words, todo counts.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct NoteMeta {
    pub links: Vec<String>,
    pub tags: Vec<String>,
    pub words: usize,
    pub tasks_done: usize,
    pub tasks_total: usize,
}

pub fn todo_line(line: &str) -> Option<(bool, &str)> {
    let t = line.trim_start();
    let mut ch = t.chars();
    let bullet = ch.next()?;
    if !matches!(bullet, '-' | '*' | '+') {
        return None;
    }
    let rest = &t[1..];
    let rest2 = rest.trim_start();
    if rest2.len() == rest.len() {
        return None; // needs whitespace after bullet
    }
    let b = rest2.as_bytes();
    if b.len() < 3 || b[0] != b'[' || b[2] != b']' || !matches!(b[1], b' ' | b'x' | b'X') {
        return None;
    }
    let after = &rest2[3..];
    let text = after.trim_start();
    if text.len() == after.len() && !after.is_empty() {
        return None;
    }
    Some((b[1] != b' ', text))
}

pub fn note_meta(content: &str) -> NoteMeta {
    let mut m = NoteMeta::default();
    // [[links]]
    let mut rest = content;
    while let Some(i) = rest.find("[[") {
        let after = &rest[i + 2..];
        if let Some(j) = after.find("]]") {
            let inner = &after[..j];
            if !inner.contains('\n') {
                let t = inner.split(['|', '#']).next().unwrap_or("").trim();
                if !t.is_empty() && !m.links.iter().any(|l| title_key(l) == title_key(t)) {
                    m.links.push(t.to_string());
                }
            }
            rest = &after[j + 2..];
        } else {
            break;
        }
    }
    // #tags (preceded by start, whitespace or "(")
    let chars: Vec<char> = content.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '#' && (i == 0 || chars[i - 1].is_whitespace() || chars[i - 1] == '(') {
            let start = i + 1;
            if start < chars.len() && chars[start].is_ascii_alphabetic() {
                let mut j = start + 1;
                while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '_' || chars[j] == '-') && j - start < 31 {
                    j += 1;
                }
                if j - start >= 2 {
                    let tag: String = chars[start..j].iter().collect::<String>().to_lowercase();
                    if !m.tags.contains(&tag) {
                        m.tags.push(tag);
                    }
                }
                i = j;
                continue;
            }
        }
        i += 1;
    }
    let mut in_code = false;
    for line in content.lines() {
        if line.starts_with("```") {
            in_code = !in_code;
        }
        if in_code {
            continue;
        }
        if let Some((done, _)) = todo_line(line) {
            m.tasks_total += 1;
            if done {
                m.tasks_done += 1;
            }
        }
    }
    // words: letter/number runs (plus ' ’ -) outside code fences, ignoring markdown symbols
    let mut words = 0usize;
    let mut in_word = false;
    let mut code = false;
    for line in content.lines() {
        if line.trim_start().starts_with("```") {
            code = !code;
            continue;
        }
        if code {
            continue;
        }
        for c in line.chars() {
            let w = c.is_alphanumeric() || c == '\'' || c == '’' || (c == '-' && in_word);
            if w && !in_word {
                words += 1;
            }
            in_word = w;
        }
        in_word = false;
    }
    m.words = words;
    m
}

/// `parseTodoItems()` from shareKit — the collaborative checklist of a shared note.
pub fn todo_items(content: &str) -> Vec<Value> {
    let mut out = vec![];
    for line in content.split('\n') {
        if let Some((done, text)) = todo_line(line) {
            out.push(serde_json::json!({
                "text": take(text.trim(), 500),
                "done": done,
                "doneBy": if done { Value::from("Note") } else { Value::Null },
                "doneAt": Value::Null,
            }));
        }
        if out.len() >= 200 {
            break;
        }
    }
    out
}

pub fn level_of(xp: i64) -> i64 {
    ((xp.max(0) as f64 / 30.0).sqrt().floor() as i64) + 1
}

pub fn stage_name(level: i64) -> &'static str {
    if level >= 5 {
        "Radiant"
    } else if level >= 3 {
        "Spry"
    } else {
        "Baby"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meta_parses_links_tags_tasks_words() {
        let m = note_meta("# Title #start\nSee [[Graph view]] and [[graph view|alias]] (#ideas)\n- [x] one\n- [ ] two\n```\n- [ ] in code\n```\n");
        assert_eq!(m.links, vec!["Graph view"]);
        assert_eq!(m.tags, vec!["start", "ideas"]);
        assert_eq!((m.tasks_done, m.tasks_total), (1, 2));
        assert!(m.words >= 10);
    }

    #[test]
    fn todo_items_match_share_parser() {
        let items = todo_items("intro\n- [ ] a\n* [X] b\n+ [x]  c \n-[ ] nope\n");
        assert_eq!(items.len(), 3);
        assert_eq!(items[0]["text"], "a");
        assert_eq!(items[1]["done"], true);
        assert_eq!(items[2]["text"], "c");
    }

    #[test]
    fn helpers() {
        assert_eq!(take("héllo", 2), "hé");
        assert!(is_word_id("n-welcome", 3, 40, &[]));
        assert!(!is_word_id("a b", 3, 40, &[]));
        assert!(is_hex_color("#abc") && !is_hex_color("abc"));
        assert_eq!(level_of(0), 1);
        assert_eq!(level_of(30), 2);
        assert_eq!(level_of(120), 3);
    }
}
