//! SQLite vault: connection, migrations (mirroring the original Prisma schema) and seed data.
//!
//! All DateTime columns are stored as INTEGER epoch milliseconds (what Prisma itself uses
//! for SQLite), `@updatedAt` columns are maintained explicitly by the API layer.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

pub type DbResult<T> = Result<T, String>;

/// Shared, thread-safe handle to the vault.
#[derive(Clone)]
pub struct Db {
    inner: Arc<Mutex<Connection>>,
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn iso(ms: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Local-time `YYYY-MM-DD` for an epoch-ms instant (matches the JS `dayKey()` helper).
pub fn day_key(ms: i64) -> String {
    use chrono::TimeZone;
    chrono::Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| "1970-01-01".into())
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

const MIGRATIONS: &[&str] = &[
    // v1 — the Prisma schema of the original Next.js app
    r#"
CREATE TABLE IF NOT EXISTS "Folder" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "icon" TEXT NOT NULL DEFAULT 'folder',
  "color" TEXT NOT NULL DEFAULT '',
  "position" INTEGER NOT NULL DEFAULT 0,
  "createdAt" INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "Note" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "title" TEXT NOT NULL DEFAULT 'Untitled',
  "content" TEXT NOT NULL DEFAULT '',
  "cover" TEXT,
  "pinned" INTEGER NOT NULL DEFAULT 0,
  "folderId" TEXT REFERENCES "Folder"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "tags" TEXT NOT NULL DEFAULT '[]',
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "Note_folderId_idx" ON "Note"("folderId");
CREATE INDEX IF NOT EXISTS "Note_updatedAt_idx" ON "Note"("updatedAt");
CREATE TABLE IF NOT EXISTS "Canvas" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL DEFAULT 'Untitled board',
  "data" TEXT NOT NULL DEFAULT '{}',
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "Pet" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL DEFAULT 'Mochi',
  "species" TEXT NOT NULL DEFAULT 'cat',
  "food" INTEGER NOT NULL DEFAULT 80,
  "energy" INTEGER NOT NULL DEFAULT 90,
  "joy" INTEGER NOT NULL DEFAULT 70,
  "xp" INTEGER NOT NULL DEFAULT 0,
  "coins" INTEGER NOT NULL DEFAULT 120,
  "hat" TEXT NOT NULL DEFAULT 'none',
  "owned" TEXT NOT NULL DEFAULT '["none"]',
  "tricks" TEXT NOT NULL DEFAULT '[]',
  "stats" TEXT NOT NULL DEFAULT '{}',
  "look" TEXT NOT NULL DEFAULT '{}',
  "tickAt" INTEGER NOT NULL,
  "createdAt" INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "Bug" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "desc" TEXT NOT NULL,
  "severity" TEXT NOT NULL DEFAULT 'minor',
  "page" TEXT NOT NULL DEFAULT '',
  "ua" TEXT NOT NULL DEFAULT '',
  "logs" TEXT NOT NULL DEFAULT '',
  "screenshot" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'open',
  "createdAt" INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "PetFolder" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "createdAt" INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "PetBlueprint" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "folderId" TEXT REFERENCES "PetFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "name" TEXT NOT NULL,
  "species" TEXT NOT NULL,
  "look" TEXT NOT NULL DEFAULT '{}',
  "origin" TEXT NOT NULL DEFAULT 'custom',
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "PetBlueprint_folderId_idx" ON "PetBlueprint"("folderId");
CREATE TABLE IF NOT EXISTS "Listing" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "kind" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "blurb" TEXT NOT NULL DEFAULT '',
  "price" INTEGER NOT NULL,
  "seller" TEXT NOT NULL DEFAULT 'Nook Team',
  "payload" TEXT NOT NULL DEFAULT '{}',
  "sold" INTEGER NOT NULL DEFAULT 0,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "Listing_sold_idx" ON "Listing"("sold");
CREATE TABLE IF NOT EXISTS "ListingEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "listingId" TEXT NOT NULL REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "price" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "createdAt" INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "ListingEvent_listingId_idx" ON "ListingEvent"("listingId");
CREATE TABLE IF NOT EXISTS "Achievement" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "key" TEXT NOT NULL UNIQUE,
  "title" TEXT NOT NULL,
  "desc" TEXT NOT NULL DEFAULT '',
  "icon" TEXT NOT NULL DEFAULT 'star',
  "createdAt" INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "Task" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "title" TEXT NOT NULL,
  "list" TEXT NOT NULL DEFAULT 'today',
  "priority" INTEGER NOT NULL DEFAULT 1,
  "due" INTEGER,
  "done" INTEGER NOT NULL DEFAULT 0,
  "noteId" TEXT,
  "tags" TEXT NOT NULL DEFAULT '[]',
  "by" TEXT NOT NULL DEFAULT 'you',
  "createdAt" INTEGER NOT NULL,
  "completedAt" INTEGER
);
CREATE TABLE IF NOT EXISTS "AppUse" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "app" TEXT NOT NULL,
  "cat" TEXT NOT NULL DEFAULT 'neutral',
  "day" TEXT NOT NULL,
  "secs" INTEGER NOT NULL DEFAULT 0,
  "src" TEXT NOT NULL DEFAULT 'web',
  "updatedAt" INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "AppUse_app_day_src_key" ON "AppUse"("app", "day", "src");
CREATE INDEX IF NOT EXISTS "AppUse_day_idx" ON "AppUse"("day");
CREATE TABLE IF NOT EXISTS "Attachment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "noteId" TEXT NOT NULL REFERENCES "Note"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "name" TEXT NOT NULL,
  "mime" TEXT NOT NULL DEFAULT 'application/octet-stream',
  "size" INTEGER NOT NULL DEFAULT 0,
  "data" TEXT NOT NULL DEFAULT '',
  "createdAt" INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "Attachment_noteId_idx" ON "Attachment"("noteId");
CREATE TABLE IF NOT EXISTS "Setting" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "value" TEXT NOT NULL DEFAULT '{}',
  "updatedAt" INTEGER NOT NULL
);
"#,
    // v2 — Nook 1.1: full-text search, version history, templates, AI conversations,
    // task reminders/recurrence/kanban status, Timelens spans
    r#"
CREATE VIRTUAL TABLE IF NOT EXISTS "NoteFts" USING fts5("title", "content", tokenize = 'unicode61 remove_diacritics 2');
INSERT INTO "NoteFts"("rowid","title","content") SELECT rowid, "title", "content" FROM "Note";
CREATE TRIGGER IF NOT EXISTS "Note_fts_ai" AFTER INSERT ON "Note" BEGIN
  INSERT INTO "NoteFts"("rowid","title","content") VALUES (new.rowid, new."title", new."content");
END;
CREATE TRIGGER IF NOT EXISTS "Note_fts_ad" AFTER DELETE ON "Note" BEGIN
  DELETE FROM "NoteFts" WHERE rowid = old.rowid;
END;
CREATE TRIGGER IF NOT EXISTS "Note_fts_au" AFTER UPDATE OF "title", "content" ON "Note" BEGIN
  DELETE FROM "NoteFts" WHERE rowid = old.rowid;
  INSERT INTO "NoteFts"("rowid","title","content") VALUES (new.rowid, new."title", new."content");
END;
CREATE TABLE IF NOT EXISTS "NoteVersion" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "noteId" TEXT NOT NULL REFERENCES "Note"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "title" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "createdAt" INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "NoteVersion_noteId_idx" ON "NoteVersion"("noteId", "createdAt");
CREATE TRIGGER IF NOT EXISTS "Note_version_au" AFTER UPDATE OF "content" ON "Note"
WHEN old."content" <> new."content" AND length(old."content") > 0 AND NOT EXISTS (
  SELECT 1 FROM "NoteVersion" WHERE "noteId" = old."id" AND "createdAt" > CAST(strftime('%s','now') AS INTEGER) * 1000 - 300000
) BEGIN
  INSERT INTO "NoteVersion"("id","noteId","title","content","createdAt")
    VALUES (lower(hex(randomblob(16))), old."id", old."title", old."content", CAST(strftime('%s','now') AS INTEGER) * 1000);
  DELETE FROM "NoteVersion" WHERE "noteId" = old."id" AND "id" NOT IN (
    SELECT "id" FROM "NoteVersion" WHERE "noteId" = old."id" ORDER BY "createdAt" DESC LIMIT 50);
END;
CREATE TABLE IF NOT EXISTS "Template" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "icon" TEXT NOT NULL DEFAULT 'file-text',
  "content" TEXT NOT NULL DEFAULT '',
  "builtin" INTEGER NOT NULL DEFAULT 0,
  "createdAt" INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "Conversation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "title" TEXT NOT NULL DEFAULT 'New chat',
  "model" TEXT NOT NULL DEFAULT '',
  "messages" TEXT NOT NULL DEFAULT '[]',
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL
);
ALTER TABLE "Task" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'todo';
ALTER TABLE "Task" ADD COLUMN "remindAt" INTEGER;
ALTER TABLE "Task" ADD COLUMN "repeat" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Task" ADD COLUMN "notifiedAt" INTEGER;
UPDATE "Task" SET "status" = 'done' WHERE "done" = 1;
CREATE TABLE IF NOT EXISTS "TimeSpan" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "app" TEXT NOT NULL,
  "title" TEXT NOT NULL DEFAULT '',
  "start" INTEGER NOT NULL,
  "end" INTEGER NOT NULL,
  "afk" INTEGER NOT NULL DEFAULT 0,
  "focus" INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "TimeSpan_start_idx" ON "TimeSpan"("start");
CREATE INDEX IF NOT EXISTS "TimeSpan_end_idx" ON "TimeSpan"("end");
"#,
    // v1.2 — Timelens app registry (exe path, cached icon, category override, exclusion) + favicon cache
    r#"
CREATE TABLE IF NOT EXISTS "TimelensApp" (
  "app" TEXT NOT NULL PRIMARY KEY,
  "exe" TEXT NOT NULL DEFAULT '',
  "icon" TEXT NOT NULL DEFAULT '',
  "iconAt" INTEGER NOT NULL DEFAULT 0,
  "category" TEXT,
  "excluded" INTEGER NOT NULL DEFAULT 0,
  "firstSeen" INTEGER NOT NULL DEFAULT 0,
  "lastSeen" INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS "TimelensFavicon" (
  "domain" TEXT NOT NULL PRIMARY KEY,
  "data" TEXT NOT NULL DEFAULT '',
  "fetchedAt" INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "TimeSpan_app_idx" ON "TimeSpan"("app");
"#,
    // v1.3: nested folders (drag a folder into another), pinned folders
    r#"
ALTER TABLE "Folder" ADD COLUMN "parentId" TEXT;
ALTER TABLE "Folder" ADD COLUMN "pinned" INTEGER NOT NULL DEFAULT 0;
"#,
    // v1.4: Timelens stores the browser site's domain per span (address bar / title mapping), and
    // favicon lookups that failed under 1.3's /favicon.ico-only fetch get one fresh try
    r#"
ALTER TABLE "TimeSpan" ADD COLUMN "domain" TEXT NOT NULL DEFAULT '';
DELETE FROM "TimelensFavicon" WHERE "data" = '';
"#,
];

impl Db {
    /// Open (or create) the vault at `path`, run migrations and seed a fresh vault.
    pub fn open(path: &Path) -> DbResult<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        Self::from_conn(conn)
    }

    /// In-memory vault (tests).
    pub fn open_in_memory() -> DbResult<Self> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        Self::from_conn(conn)
    }

    fn from_conn(conn: Connection) -> DbResult<Self> {
        conn.execute_batch(
            "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 4000;",
        )
        .map_err(|e| e.to_string())?;
        migrate(&conn)?;
        seed(&conn)?;
        Ok(Db { inner: Arc::new(Mutex::new(conn)) })
    }

    pub fn conn(&self) -> MutexGuard<'_, Connection> {
        match self.inner.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        }
    }

    // ---------- key/value Setting store helpers ----------
    pub fn setting_get(&self, id: &str) -> Option<String> {
        setting_get(&self.conn(), id)
    }
    pub fn setting_put(&self, id: &str, value: &str) -> DbResult<()> {
        setting_put(&self.conn(), id, value)
    }
    pub fn setting_delete(&self, id: &str) -> DbResult<usize> {
        self.conn()
            .execute(r#"DELETE FROM "Setting" WHERE "id" = ?1"#, params![id])
            .map_err(|e| e.to_string())
    }
}

pub fn setting_get(c: &Connection, id: &str) -> Option<String> {
    c.query_row(r#"SELECT "value" FROM "Setting" WHERE "id" = ?1"#, params![id], |r| r.get::<_, String>(0))
        .optional()
        .ok()
        .flatten()
}

pub fn setting_put(c: &Connection, id: &str, value: &str) -> DbResult<()> {
    c.execute(
        r#"INSERT INTO "Setting" ("id","value","updatedAt") VALUES (?1, ?2, ?3)
           ON CONFLICT("id") DO UPDATE SET "value" = excluded."value", "updatedAt" = excluded."updatedAt""#,
        params![id, value, now_ms()],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

pub fn schema_version(c: &Connection) -> i64 {
    c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap_or(0)
}

fn migrate(c: &Connection) -> DbResult<()> {
    let v = schema_version(c) as usize;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(v) {
        c.execute_batch(&format!("BEGIN; {sql}; PRAGMA user_version = {}; COMMIT;", i + 1))
            .map_err(|e| format!("migration {} failed: {e}", i + 1))?;
    }
    Ok(())
}

fn count(c: &Connection, sql: &str) -> i64 {
    c.query_row(sql, [], |r| r.get(0)).unwrap_or(0)
}

// ------------------------------------------------------------------ seed data

const DAY: i64 = 86_400_000;

struct SeedNote {
    id: &'static str,
    title: &'static str,
    cover: Option<&'static str>,
    pinned: bool,
    folder: Option<&'static str>,
    age: i64,
    content: &'static str,
}

const SEED_FOLDERS: &[(&str, &str, &str, &str, i64)] = &[
    ("f-guides", "Guides", "book-open", "#9db7d0", 0),
    ("f-projects", "Projects", "shapes", "#bccb92", 1),
    ("f-pets", "Pets", "dog", "#cba5ba", 2),
    ("f-games", "Games", "gamepad", "#e0b589", 3),
    ("f-journal", "Journal", "notebook", "#b59fd0", 4),
];

const SEED_NOTES: &[SeedNote] = &[
    SeedNote { id: "n-welcome", title: "Welcome to Nook", cover: Some("/art/cover-peaks.webp"), pinned: true, folder: None, age: 0, content: include_str!("seed/welcome.md") },
    SeedNote { id: "n-graph", title: "Graph view", cover: None, pinned: false, folder: None, age: 1, content: include_str!("seed/graph.md") },
    SeedNote { id: "n-canvas", title: "Canvas boards", cover: None, pinned: false, folder: None, age: 2, content: include_str!("seed/canvas.md") },
    SeedNote { id: "n-pet", title: "Meet Mochi", cover: Some("/art/cover-forest.webp"), pinned: false, folder: Some("f-pets"), age: 1, content: include_str!("seed/pet.md") },
    SeedNote { id: "n-keys", title: "Keyboard shortcuts", cover: None, pinned: false, folder: Some("f-guides"), age: 3, content: include_str!("seed/keys.md") },
    SeedNote { id: "n-ideas", title: "Ideas garden", cover: None, pinned: false, folder: Some("f-projects"), age: 2, content: include_str!("seed/ideas.md") },
    SeedNote { id: "n-garden", title: "Pixel garden project", cover: None, pinned: false, folder: Some("f-projects"), age: 6, content: include_str!("seed/garden.md") },
    SeedNote { id: "n-reading", title: "Reading list", cover: None, pinned: false, folder: Some("f-guides"), age: 9, content: include_str!("seed/reading.md") },
    SeedNote { id: "n-focus", title: "Focus rituals", cover: None, pinned: false, folder: Some("f-guides"), age: 4, content: include_str!("seed/focus.md") },
    SeedNote { id: "n-weekly", title: "Weekly review", cover: None, pinned: false, folder: Some("f-journal"), age: 16, content: include_str!("seed/weekly.md") },
    SeedNote { id: "n-arcade", title: "Arcade", cover: None, pinned: false, folder: Some("f-games"), age: 1, content: include_str!("seed/arcade.md") },
    SeedNote { id: "n-team", title: "Team room", cover: None, pinned: false, folder: Some("f-guides"), age: 1, content: include_str!("seed/team.md") },
    SeedNote { id: "n-market", title: "Marketplace", cover: None, pinned: false, folder: Some("f-guides"), age: 1, content: include_str!("seed/market.md") },
    SeedNote { id: "n-someday", title: "Someday maybe", cover: None, pinned: false, folder: Some("f-journal"), age: 30, content: include_str!("seed/someday.md") },
];

type SeedListing = (&'static str, &'static str, &'static str, &'static str, &'static str, i64, &'static str, &'static str);

const SEED_LISTINGS: &[SeedListing] = &[
    ("l-1", "hat", "beanie", "Cozy beanie", "Warm ears, warmer heart. Gently used.", 9, "Fern", "{}"),
    ("l-2", "hat", "wizard", "Wizard hat", "+10 to note magic. Slightly enchanted.", 24, "Ozzy", "{}"),
    ("l-3", "hat", "shades", "Pixel shades", "Deal with it. No refunds on coolness.", 12, "Vex", "{}"),
    ("l-4", "pet", "fox", "Fox kit", "Curious, quick, steals socks. Trained.", 60, "Maple", "{}"),
    ("l-5", "pet", "dragon", "Baby dragon", "Hatched last week. Eats ideas.", 140, "Ember", "{}"),
    ("l-6", "pet", "axolotl", "Axolotl", "Perma-smile. Aquatic. Regrows bad moods.", 90, "Bloop", "{}"),
    ("l-7", "food", "cake", "Moon cake ×5", "Pure happiness, five slices.", 18, "Baker Bot", r#"{"food":"cake","qty":5}"#),
    ("l-8", "food", "coffee", "Warm drink ×5", "Wakes everyone up. Bundle deal.", 14, "Baker Bot", r#"{"food":"coffee","qty":5}"#),
    ("l-9", "theme", "sunset", "Sunset theme", "Golden hour, forever.", 30, "Skye", "{}"),
    ("l-10", "hat", "crown", "Royal crown", "Archive royalty. Only worn once.", 46, "Queen Bee", "{}"),
];

const SEED_DECOR: &[SeedListing] = &[
    ("l-11", "decor", "decor-window", "Star window", "The den deserves a view. Pixels twinkle at night.", 20, "Denkeeper", "{}"),
    ("l-12", "decor", "decor-boombox", "Boombox", "Lo-fi beats for the whole team.", 22, "Denkeeper", "{}"),
    ("l-13", "decor", "decor-trophy", "Trophy shelf", "Flex those achievements.", 26, "Denkeeper", "{}"),
    ("l-14", "decor", "decor-fern", "Pixel fern", "Photosynthesizes ideas. Water monthly.", 13, "Fern", "{}"),
];

const SEED_PREMIUM: &[SeedListing] = &[
    ("l-15", "theme", "aurora", "Aurora theme", "Rare. Northern lights over a pixel forest.", 60, "Borealis", r#"{"premium":true}"#),
    ("l-16", "theme", "noir", "Noir theme", "Rare. Gold on midnight — for serious detectives.", 80, "Detective Fox", r#"{"premium":true}"#),
    ("l-17", "theme", "seafoam", "Seafoam theme", "Rare. Tide-pool teal, sun-warmed paper.", 50, "Tidekeeper", r#"{"premium":true}"#),
];

pub const SPECIES_IDS: &[&str] = &["cat", "bunny", "blob", "dog", "fox", "panda", "frog", "penguin", "ghost", "dragon", "axolotl", "owl"];

fn seed_canvas() -> Value {
    json!({
        "view": { "x": 40, "y": 20, "z": 0.8 },
        "nodes": [
            { "id": "c1", "type": "image", "x": 40, "y": 40, "w": 360, "h": 190, "src": "/art/hero.webp" },
            { "id": "c2", "type": "note", "x": 470, "y": 30, "w": 250, "h": 150, "noteId": "n-welcome" },
            { "id": "c3", "type": "note", "x": 800, "y": 20, "w": 250, "h": 150, "noteId": "n-graph" },
            { "id": "c4", "type": "text", "x": 470, "y": 250, "w": 230, "h": 130, "text": "Idea: connect every project to a goal.\nUse the dot on the card edge to link.", "tone": 1 },
            { "id": "c5", "type": "note", "x": 800, "y": 250, "w": 250, "h": 150, "noteId": "n-ideas" },
            { "id": "c6", "type": "image", "x": 80, "y": 310, "w": 220, "h": 120, "src": "/art/plant.webp" },
            { "id": "c7", "type": "note", "x": 1120, "y": 140, "w": 250, "h": 150, "noteId": "n-pet" }
        ],
        "edges": [
            { "id": "e1", "from": "c2", "to": "c3" },
            { "id": "e2", "from": "c2", "to": "c4" },
            { "id": "e3", "from": "c3", "to": "c5" },
            { "id": "e4", "from": "c5", "to": "c7" },
            { "id": "e5", "from": "c1", "to": "c2" }
        ]
    })
}

fn insert_listing(c: &Connection, l: &SeedListing, now: i64) {
    let _ = c.execute(
        r#"INSERT OR IGNORE INTO "Listing" ("id","kind","itemId","name","blurb","price","seller","payload","sold","createdAt","updatedAt")
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,0,?9,?9)"#,
        params![l.0, l.1, l.2, l.3, l.4, l.5, l.6, l.7, now],
    );
}

/// Port of `ensureReady()` — seeds a fresh vault and tops up decor/premium listings on old ones.
pub fn seed(c: &Connection) -> DbResult<()> {
    let now = now_ms();
    if count(c, r#"SELECT COUNT(*) FROM "Folder""#) == 0 {
        for f in SEED_FOLDERS {
            let _ = c.execute(
                r#"INSERT OR IGNORE INTO "Folder" ("id","name","icon","color","position","createdAt") VALUES (?1,?2,?3,?4,?5,?6)"#,
                params![f.0, f.1, f.2, f.3, f.4, now],
            );
        }
    }
    if count(c, r#"SELECT COUNT(*) FROM "Note""#) == 0 {
        for (i, n) in SEED_NOTES.iter().enumerate() {
            let _ = c.execute(
                r#"INSERT OR IGNORE INTO "Note" ("id","title","content","cover","pinned","folderId","tags","createdAt","updatedAt")
                   VALUES (?1,?2,?3,?4,?5,?6,'[]',?7,?8)"#,
                params![
                    n.id,
                    n.title,
                    n.content,
                    n.cover,
                    n.pinned as i64,
                    n.folder,
                    now - (n.age + 2) * DAY,
                    now - n.age * DAY - (i as i64) * 60_000
                ],
            );
        }
    }
    if count(c, r#"SELECT COUNT(*) FROM "Canvas""#) == 0 {
        let _ = c.execute(
            r#"INSERT OR IGNORE INTO "Canvas" ("id","name","data","createdAt","updatedAt") VALUES ('b-welcome','Welcome board',?1,?2,?2)"#,
            params![seed_canvas().to_string(), now],
        );
    }
    if count(c, r#"SELECT COUNT(*) FROM "Pet""#) == 0 {
        let _ = c.execute(
            r#"INSERT OR IGNORE INTO "Pet" ("id","name","species","food","energy","joy","xp","coins","hat","owned","tricks","stats","look","tickAt","createdAt")
               VALUES ('pet-1','Mochi','cat',85,92,78,0,120,'none','["none","bow"]','[]',?1,'{}',?2,?2)"#,
            params![r#"{"words":0,"fed":0,"pats":0,"games":0,"focus":0,"best":0,"sold":0,"earned":0}"#, now],
        );
    }
    if count(c, r#"SELECT COUNT(*) FROM "Listing""#) == 0 {
        for l in SEED_LISTINGS {
            insert_listing(c, l, now);
        }
    }
    if count(c, r#"SELECT COUNT(*) FROM "Listing" WHERE "kind" = 'decor'"#) == 0 {
        for l in SEED_DECOR {
            insert_listing(c, l, now);
        }
    }
    if count(c, r#"SELECT COUNT(*) FROM "Listing" WHERE "kind" = 'theme' AND "itemId" IN ('aurora','noir','seafoam')"#) == 0 {
        for l in SEED_PREMIUM {
            insert_listing(c, l, now);
        }
    }
    crate::ext::seed_templates(c);
    Ok(())
}

/// built-in pet-library folders + one signature blueprint per species (seeded on first library read)
pub fn seed_pet_registry(c: &Connection) -> DbResult<()> {
    if count(c, r#"SELECT COUNT(*) FROM "PetFolder""#) > 0 {
        return Ok(());
    }
    let looks: &[(&str, Option<[&str; 5]>, &str, &str)] = &[
        ("cat", None, "#9db7d0", "The original. Curious, aloof, secretly clingy."),
        ("bunny", Some(["#12100e", "#4a4038", "#8a7a6c", "#cbbfb2", "#f6f0e7"]), "#d8a8b8", "Bouncy, gentle, always listening."),
        ("blob", Some(["#0c1110", "#2e4a42", "#5f8577", "#9dc0ae", "#e8f5ec"]), "#8fd6c0", "Squishy, glossy, eats pure ideas."),
        ("dog", Some(["#14100c", "#54402c", "#8a6c48", "#c0a074", "#f3e6d0"]), "#c98f5a", "Loyal, loud, proud of you."),
        ("fox", Some(["#160e08", "#5c3018", "#a05a28", "#d09048", "#f8e8d8"]), "#e8853c", "Clever, swift, collects shiny ideas."),
        ("panda", Some(["#0f0f10", "#3c3c40", "#787886", "#b8b8c4", "#f4f4f6"]), "#8a9aac", "Chill, snacky, rarely in a hurry."),
        ("frog", Some(["#0c1208", "#34502a", "#6a8a4c", "#a8c484", "#eef8dc"]), "#86c46a", "Hoppy, damp, surprisingly wise."),
        ("penguin", Some(["#0c0e14", "#33394a", "#626c86", "#a2acc4", "#f0f4fa"]), "#e8a844", "Dapper, waddly, always formal."),
        ("ghost", Some(["#0e0c14", "#3c3a52", "#74729a", "#b2b0d4", "#f2f0fc"]), "#a8a0e8", "Spooky, soft, haunted by drafts."),
        ("dragon", Some(["#100a10", "#4a2440", "#844868", "#c0889c", "#f8e8ec"]), "#e05878", "Tiny, fierce, hoards coins."),
        ("axolotl", Some(["#140c12", "#583a52", "#98708c", "#d0a8c4", "#fbeef8"]), "#f088b0", "Perma-smile, aquatic, regenerates."),
        ("owl", Some(["#120e0a", "#4a3c2c", "#84705a", "#c0ac90", "#f5efe4"]), "#d8a050", "Wise, nocturnal, cites sources."),
    ];
    let now = now_ms();
    for (pos, (sp, ramp, accent, blurb)) in looks.iter().enumerate() {
        let fid = format!("pf-{sp}");
        c.execute(
            r#"INSERT OR IGNORE INTO "PetFolder" ("id","name","position","createdAt") VALUES (?1,?2,?3,?4)"#,
            params![fid, sp, pos as i64, now],
        )
        .map_err(|e| e.to_string())?;
        let name = match *sp {
            "dog" => "Biscuit".to_string(),
            "cat" => "Mochi".to_string(),
            s => {
                let mut ch = s.chars();
                ch.next().map(|f| f.to_uppercase().collect::<String>() + ch.as_str()).unwrap_or_default()
            }
        };
        let mut look = json!({ "accent": accent, "blurb": blurb });
        if let Some(r) = ramp {
            look["ramp"] = json!(r);
        }
        c.execute(
            r#"INSERT OR IGNORE INTO "PetBlueprint" ("id","folderId","name","species","look","origin","createdAt","updatedAt")
               VALUES (?1,?2,?3,?4,?5,'builtin',?6,?6)"#,
            params![format!("pb-{sp}"), fid, name, sp, look.to_string(), now - pos as i64],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_and_seeds_fresh_vault() {
        let db = Db::open_in_memory().unwrap();
        let c = db.conn();
        assert_eq!(schema_version(&c), MIGRATIONS.len() as i64);
        assert_eq!(count(&c, r#"SELECT COUNT(*) FROM "Note""#), 14);
        assert_eq!(count(&c, r#"SELECT COUNT(*) FROM "Folder""#), 5);
        assert_eq!(count(&c, r#"SELECT COUNT(*) FROM "Canvas""#), 1);
        assert_eq!(count(&c, r#"SELECT COUNT(*) FROM "Pet""#), 1);
        assert_eq!(count(&c, r#"SELECT COUNT(*) FROM "Listing""#), 17);
    }

    #[test]
    fn reopen_is_idempotent_and_keeps_data() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("nook.db");
        {
            let db = Db::open(&p).unwrap();
            db.conn().execute(r#"DELETE FROM "Note" WHERE "id" = 'n-someday'"#, []).unwrap();
            db.setting_put("k", "v1").unwrap();
            db.setting_put("k", "v2").unwrap();
        }
        let db = Db::open(&p).unwrap();
        let c = db.conn();
        // a non-empty vault is never re-seeded
        assert_eq!(count(&c, r#"SELECT COUNT(*) FROM "Note""#), 13);
        assert_eq!(setting_get(&c, "k").as_deref(), Some("v2"));
    }

    #[test]
    fn foreign_keys_cascade_and_set_null() {
        let db = Db::open_in_memory().unwrap();
        let c = db.conn();
        c.execute(r#"INSERT INTO "Attachment" ("id","noteId","name","createdAt") VALUES ('a1','n-welcome','x.png',0)"#, []).unwrap();
        c.execute(r#"DELETE FROM "Note" WHERE "id"='n-welcome'"#, []).unwrap();
        assert_eq!(count(&c, r#"SELECT COUNT(*) FROM "Attachment""#), 0);
        c.execute(r#"DELETE FROM "Folder" WHERE "id"='f-guides'"#, []).unwrap();
        assert_eq!(count(&c, r#"SELECT COUNT(*) FROM "Note" WHERE "folderId"='f-guides'"#), 0);
        assert_eq!(count(&c, r#"SELECT COUNT(*) FROM "Note" WHERE "id"='n-keys' AND "folderId" IS NULL"#), 1);
    }

    #[test]
    fn pet_registry_seed() {
        let db = Db::open_in_memory().unwrap();
        let c = db.conn();
        seed_pet_registry(&c).unwrap();
        seed_pet_registry(&c).unwrap();
        assert_eq!(count(&c, r#"SELECT COUNT(*) FROM "PetFolder""#), 12);
        assert_eq!(count(&c, r#"SELECT COUNT(*) FROM "PetBlueprint""#), 12);
    }
}
