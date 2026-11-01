//! v1.4 Meeting recorder.
//!
//! Records both sides of a call as two tracks:
//! * **You**  — the default microphone (WASAPI capture endpoint on Windows)
//! * **Them** — whatever the PC plays (WASAPI *loopback* of the default render endpoint)
//!
//! Low CPU by design: one recorder thread wakes every 100 ms, drains both endpoints, downmixes to
//! mono, resamples to **16 kHz / 16-bit** and appends to **30-second WAV chunks** per track
//! (`<meetings dir>/<id>/you-0003.wav`). Silent chunks are skipped for transcription. Loopback
//! delivers no packets while nothing plays, so both tracks are padded with silence to the wall
//! clock — they always stay aligned.
//!
//! Transcription is per chunk: cloud STT when a key is set (Groq `whisper-large-v3`, any
//! OpenAI-compatible `/audio/transcriptions`, or Gemini audio), otherwise the UI runs the local
//! Whisper worker and posts the segments back. `merge_transcript` interleaves both tracks into a
//! speaker-labelled, timestamped transcript (dropping mic bleed of the other side), and the summary
//! (summary, key points, decisions, action items with owners) is written into a note that links
//! the audio.

use crate::db::{now_ms, Db};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const RATE: u32 = 16_000;
pub const CHUNK_SECS: u32 = 30;
/// RMS below this (on a 0..1 scale) counts as silence — chunk is not sent to STT
pub const SILENCE_RMS: f32 = 0.004;

// ------------------------------------------------------------------ storage dir

static DIR: OnceLock<PathBuf> = OnceLock::new();

/// The desktop shell points this at `%APPDATA%/Nook/meetings` once at startup.
pub fn set_dir(p: PathBuf) {
    let _ = DIR.set(p);
}
pub fn dir() -> PathBuf {
    DIR.get().cloned().unwrap_or_else(|| std::env::var_os("NOOK_MEETINGS_DIR").map(PathBuf::from).unwrap_or_else(|| std::env::temp_dir().join("nook-meetings")))
}
fn meeting_dir(id: &str) -> PathBuf {
    dir().join(id)
}

// ------------------------------------------------------------------ tracks

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Track {
    You,
    Them,
}
impl Track {
    pub fn key(self) -> &'static str {
        match self {
            Track::You => "you",
            Track::Them => "them",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Track::You => "You",
            Track::Them => "Them",
        }
    }
    pub fn parse(s: &str) -> Option<Track> {
        match s {
            "you" | "mic" => Some(Track::You),
            "them" | "system" | "loopback" => Some(Track::Them),
            _ => None,
        }
    }
}

// ------------------------------------------------------------------ audio sources

/// One capture endpoint. `read` appends whatever arrived since the last call as **mono f32 at
/// 16 kHz** (the implementation downmixes and resamples).
pub trait AudioSource {
    fn read(&mut self, out: &mut Vec<f32>) -> Result<(), String>;
    fn name(&self) -> String;
}

/// Opens sources. Called *on the recorder thread* (WASAPI/COM objects are thread-bound).
pub trait AudioBackend: Send + Sync {
    fn open(&self, track: Track) -> Result<Box<dyn AudioSource>, String>;
}

/// Not Windows and no fake audio: recording is unavailable with a clear reason.
pub struct Unsupported;
impl AudioBackend for Unsupported {
    fn open(&self, _t: Track) -> Result<Box<dyn AudioSource>, String> {
        Err("Meeting recording uses Windows audio (WASAPI) — it works in the Windows app.".into())
    }
}

/// Synthetic audio (dev server / tests / screenshots: `NOOK_FAKE_AUDIO=1`): a quiet tone with
/// speech-like bursts, different per track.
pub struct FakeBackend;
pub struct FakeSource {
    track: Track,
    t0: Instant,
    produced: u64,
}
impl AudioBackend for FakeBackend {
    fn open(&self, track: Track) -> Result<Box<dyn AudioSource>, String> {
        Ok(Box::new(FakeSource { track, t0: Instant::now(), produced: 0 }))
    }
}
impl AudioSource for FakeSource {
    fn read(&mut self, out: &mut Vec<f32>) -> Result<(), String> {
        let want = (self.t0.elapsed().as_secs_f64() * RATE as f64) as u64;
        let f = if self.track == Track::You { 220.0 } else { 330.0 };
        for i in self.produced..want {
            let t = i as f64 / RATE as f64;
            // talk in turns: "you" in even 3 s windows, "them" in odd ones
            let turn = ((t / 3.0) as u64 % 2 == 0) == (self.track == Track::You);
            let amp = if turn { 0.2 * (0.5 + 0.5 * (t * 3.1).sin().abs()) } else { 0.0 };
            out.push((amp * (2.0 * std::f64::consts::PI * f * t).sin()) as f32);
        }
        self.produced = want;
        Ok(())
    }
    fn name(&self) -> String {
        format!("Fake {}", self.track.label())
    }
}

pub fn platform_backend() -> Arc<dyn AudioBackend> {
    if std::env::var("NOOK_FAKE_AUDIO").map(|v| v == "1").unwrap_or(false) {
        return Arc::new(FakeBackend);
    }
    #[cfg(windows)]
    {
        Arc::new(win::WasapiBackend)
    }
    #[cfg(not(windows))]
    {
        Arc::new(Unsupported)
    }
}

static BACKEND: OnceLock<Arc<dyn AudioBackend>> = OnceLock::new();
/// Tests / dev can swap the backend before the first recording.
pub fn set_backend(b: Arc<dyn AudioBackend>) {
    let _ = BACKEND.set(b);
}
fn backend() -> Arc<dyn AudioBackend> {
    BACKEND.get_or_init(platform_backend).clone()
}

// ------------------------------------------------------------------ DSP helpers (pure)

/// Streaming box-filter resampler: averages the input samples that fall into each output
/// sample's window (a cheap anti-alias for 44.1/48 kHz → 16 kHz).
#[derive(Debug, Clone)]
pub struct Resampler {
    step: f64,
    pos: f64,
    sum: f32,
    n: u32,
}
impl Resampler {
    pub fn new(src_rate: u32) -> Self {
        Resampler { step: src_rate.max(1) as f64 / RATE as f64, pos: 0.0, sum: 0.0, n: 0 }
    }
    pub fn push(&mut self, mono: &[f32], out: &mut Vec<f32>) {
        if (self.step - 1.0).abs() < 1e-9 {
            out.extend_from_slice(mono);
            return;
        }
        for &s in mono {
            self.sum += s;
            self.n += 1;
            self.pos += 1.0;
            if self.pos >= self.step {
                self.pos -= self.step;
                out.push(self.sum / self.n as f32);
                self.sum = 0.0;
                self.n = 0;
            }
        }
    }
}

/// Interleaved frames → mono (average of channels).
pub fn downmix(interleaved: &[f32], channels: usize, out: &mut Vec<f32>) {
    let ch = channels.max(1);
    for f in interleaved.chunks_exact(ch) {
        out.push(f.iter().sum::<f32>() / ch as f32);
    }
}

pub fn rms(x: &[f32]) -> f32 {
    if x.is_empty() {
        return 0.0;
    }
    (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
}

/// 16-bit mono PCM WAV header for `samples` samples.
pub fn wav_header(samples: u32) -> [u8; 44] {
    let data = samples * 2;
    let mut h = [0u8; 44];
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&(36 + data).to_le_bytes());
    h[8..12].copy_from_slice(b"WAVE");
    h[12..16].copy_from_slice(b"fmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes());
    h[20..22].copy_from_slice(&1u16.to_le_bytes()); // PCM
    h[22..24].copy_from_slice(&1u16.to_le_bytes()); // mono
    h[24..28].copy_from_slice(&RATE.to_le_bytes());
    h[28..32].copy_from_slice(&(RATE * 2).to_le_bytes());
    h[32..34].copy_from_slice(&2u16.to_le_bytes());
    h[34..36].copy_from_slice(&16u16.to_le_bytes());
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&data.to_le_bytes());
    h
}

pub fn to_i16(x: &[f32]) -> Vec<u8> {
    let mut v = Vec::with_capacity(x.len() * 2);
    for s in x {
        let i = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        v.extend_from_slice(&i.to_le_bytes());
    }
    v
}

pub fn chunk_path(id: &str, track: Track, n: u32) -> PathBuf {
    meeting_dir(id).join(format!("{}-{n:04}.wav", track.key()))
}

/// Writes one track as consecutive fixed-length WAV chunks.
struct ChunkWriter {
    id: String,
    track: Track,
    n: u32,
    buf: Vec<f32>,
    total: u64,
    /// (chunk, rms) of finished chunks
    done: Vec<(u32, f32)>,
}
impl ChunkWriter {
    fn new(id: &str, track: Track) -> Self {
        ChunkWriter { id: id.into(), track, n: 0, buf: Vec::with_capacity((RATE * CHUNK_SECS) as usize), total: 0, done: vec![] }
    }
    fn push(&mut self, x: &[f32]) -> Result<(), String> {
        let cap = (RATE * CHUNK_SECS) as usize;
        let mut rest = x;
        while !rest.is_empty() {
            let take = (cap - self.buf.len()).min(rest.len());
            self.buf.extend_from_slice(&rest[..take]);
            self.total += take as u64;
            rest = &rest[take..];
            if self.buf.len() >= cap {
                self.flush()?;
            }
        }
        Ok(())
    }
    fn flush(&mut self) -> Result<(), String> {
        if self.buf.is_empty() {
            return Ok(());
        }
        let p = chunk_path(&self.id, self.track, self.n);
        let mut bytes = wav_header(self.buf.len() as u32).to_vec();
        bytes.extend(to_i16(&self.buf));
        std::fs::write(&p, bytes).map_err(|e| format!("can't write {}: {e}", p.display()))?;
        self.done.push((self.n, rms(&self.buf)));
        self.n += 1;
        self.buf.clear();
        Ok(())
    }
}

// ------------------------------------------------------------------ live session

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LiveStatus {
    pub id: Option<String>,
    pub state: String, // idle | starting | recording | paused | stopping
    pub started_at: i64,
    pub elapsed_ms: i64,
    pub level_you: f32,
    pub level_them: f32,
    pub devices: Map<String, Value>,
    pub warnings: Vec<String>,
    pub error: Option<String>,
}

struct Session {
    id: String,
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

fn live() -> &'static Mutex<LiveStatus> {
    static L: OnceLock<Mutex<LiveStatus>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(LiveStatus { state: "idle".into(), ..Default::default() }))
}
fn session() -> &'static Mutex<Option<Session>> {
    static S: OnceLock<Mutex<Option<Session>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

pub fn status() -> LiveStatus {
    live().lock().map(|g| g.clone()).unwrap_or_default()
}

fn announce() {
    let s = status();
    crate::timelens::emit_event("meeting-state", serde_json::to_value(&s).unwrap_or(Value::Null));
}

/// Start recording. Opens both endpoints on the recorder thread and returns once they are open
/// (or failed): a missing / blocked mic still records the other side (with a warning); when
/// neither side can be opened the error explains why.
pub fn start(db: &Db, title: Option<&str>) -> Result<LiveStatus, String> {
    let mut sess = session().lock().map_err(|e| e.to_string())?;
    if sess.is_some() {
        return Err("A meeting is already being recorded.".into());
    }
    let c = db.conn();
    ensure_schema(&c)?;
    let id = format!("m-{}", crate::timelens::id_for_tests());
    let now = now_ms();
    std::fs::create_dir_all(meeting_dir(&id)).map_err(|e| format!("can't create the recordings folder: {e}"))?;
    let title = title.map(str::trim).filter(|t| !t.is_empty()).map(String::from).unwrap_or_else(|| default_title(now));
    c.execute(r#"INSERT INTO "Meeting"("id","title","startedAt","status") VALUES (?1,?2,?3,'recording')"#, params![id, title, now]).map_err(|e| e.to_string())?;
    drop(c);

    let stop = Arc::new(AtomicBool::new(false));
    let paused = Arc::new(AtomicBool::new(false));
    let (tx, rx) = std::sync::mpsc::channel::<Result<(Map<String, Value>, Vec<String>), String>>();
    let (db2, id2, stop2, paused2) = (db.clone(), id.clone(), stop.clone(), paused.clone());
    if let Ok(mut l) = live().lock() {
        *l = LiveStatus { id: Some(id.clone()), state: "starting".into(), started_at: now, ..Default::default() };
    }
    let thread = std::thread::Builder::new()
        .name("meeting-rec".into())
        .spawn(move || record_loop(db2, id2, stop2, paused2, tx))
        .map_err(|e| e.to_string())?;
    match rx.recv_timeout(Duration::from_secs(8)) {
        Ok(Ok((devices, warnings))) => {
            if let Ok(mut l) = live().lock() {
                l.state = "recording".into();
                l.devices = devices.clone();
                l.warnings = warnings.clone();
            }
            let c = db.conn();
            let _ = c.execute(r#"UPDATE "Meeting" SET "devices"=?2 WHERE "id"=?1"#, params![id, json!({ "devices": devices, "warnings": warnings }).to_string()]);
            *sess = Some(Session { id: id.clone(), stop, paused, thread: Some(thread) });
            drop(sess);
            announce();
            Ok(status())
        }
        Ok(Err(e)) => {
            let _ = thread.join();
            fail_start(db, &id, &e);
            Err(e)
        }
        Err(_) => {
            stop.store(true, Ordering::SeqCst);
            let e = "The audio devices did not respond within 8 s.".to_string();
            fail_start(db, &id, &e);
            Err(e)
        }
    }
}

fn fail_start(db: &Db, id: &str, e: &str) {
    let c = db.conn();
    let _ = c.execute(r#"DELETE FROM "Meeting" WHERE "id"=?1"#, params![id]);
    let _ = std::fs::remove_dir_all(meeting_dir(id));
    if let Ok(mut l) = live().lock() {
        *l = LiveStatus { state: "idle".into(), error: Some(e.to_string()), ..Default::default() };
    }
    announce();
}

pub fn set_paused(p: bool) -> Result<LiveStatus, String> {
    let sess = session().lock().map_err(|e| e.to_string())?;
    let s = sess.as_ref().ok_or("Nothing is being recorded.")?;
    s.paused.store(p, Ordering::SeqCst);
    if let Ok(mut l) = live().lock() {
        l.state = if p { "paused".into() } else { "recording".into() };
    }
    drop(sess);
    announce();
    Ok(status())
}

/// Stop and finalise (flush the last chunks, write duration). Returns the meeting row.
pub fn stop(db: &Db) -> Result<Value, String> {
    let s = session().lock().map_err(|e| e.to_string())?.take().ok_or("Nothing is being recorded.")?;
    if let Ok(mut l) = live().lock() {
        l.state = "stopping".into();
    }
    s.stop.store(true, Ordering::SeqCst);
    if let Some(t) = s.thread {
        let _ = t.join();
    }
    if let Ok(mut l) = live().lock() {
        *l = LiveStatus { state: "idle".into(), ..Default::default() };
    }
    announce();
    let c = db.conn();
    get(&c, &s.id).ok_or_else(|| "meeting vanished".to_string())
}

/// Toggle for the global hotkey / tray.
pub fn toggle(db: &Db) -> Result<LiveStatus, String> {
    let recording = session().lock().map(|s| s.is_some()).unwrap_or(false);
    if recording {
        stop(db)?;
        Ok(status())
    } else {
        start(db, None)
    }
}

pub fn is_recording() -> bool {
    session().lock().map(|s| s.is_some()).unwrap_or(false)
}

fn record_loop(db: Db, id: String, stop: Arc<AtomicBool>, paused: Arc<AtomicBool>, ready: std::sync::mpsc::Sender<Result<(Map<String, Value>, Vec<String>), String>>) {
    let be = backend();
    let mut warnings = vec![];
    let mut devices = Map::new();
    let mut open = |t: Track| match be.open(t) {
        Ok(s) => {
            devices.insert(t.key().into(), json!(s.name()));
            Some(s)
        }
        Err(e) => {
            warnings.push(format!("{}: {e}", if t == Track::You { "Microphone" } else { "System audio" }));
            None
        }
    };
    let mut mic = open(Track::You);
    let mut sys = open(Track::Them);
    if mic.is_none() && sys.is_none() {
        let _ = ready.send(Err(format!("No audio device could be opened. {}", warnings.join(" "))));
        return;
    }
    let _ = ready.send(Ok((devices, warnings)));
    let mut w_you = ChunkWriter::new(&id, Track::You);
    let mut w_them = ChunkWriter::new(&id, Track::Them);
    let (mut b_you, mut b_them) = (Vec::<f32>::new(), Vec::<f32>::new());
    let mut active = Duration::ZERO;
    let mut last = Instant::now();
    let mut err: Option<String> = None;
    let slack = (RATE / 5) as u64; // allow 200 ms of device jitter before padding with silence
    loop {
        let stopping = stop.load(Ordering::SeqCst);
        b_you.clear();
        b_them.clear();
        if let Some(m) = mic.as_mut() {
            if let Err(e) = m.read(&mut b_you) {
                err = Some(format!("Microphone stopped: {e}"));
                mic = None;
            }
        }
        if let Some(s) = sys.as_mut() {
            if let Err(e) = s.read(&mut b_them) {
                err = Some(format!("System audio stopped: {e}"));
                sys = None;
            }
        }
        let now = Instant::now();
        let is_paused = paused.load(Ordering::SeqCst);
        if !is_paused {
            active += now - last;
            let target = (active.as_secs_f64() * RATE as f64) as u64;
            for (w, b) in [(&mut w_you, &mut b_you), (&mut w_them, &mut b_them)] {
                // never run ahead of the wall clock; pad gaps (silent loopback, missing device)
                let room = target.saturating_sub(w.total) as usize;
                b.truncate(room);
                let after = w.total + b.len() as u64;
                if after + slack < target || stopping {
                    b.resize(b.len() + (target - after.min(target)) as usize, 0.0);
                }
                if let Err(e) = w.push(b) {
                    err = Some(e);
                }
            }
        }
        last = now;
        if let Ok(mut l) = live().lock() {
            l.elapsed_ms = active.as_millis() as i64;
            l.level_you = if is_paused { 0.0 } else { (rms(&b_you) * 4.0).min(1.0) };
            l.level_them = if is_paused { 0.0 } else { (rms(&b_them) * 4.0).min(1.0) };
            if let Some(e) = err.take() {
                l.warnings.push(e);
            }
        }
        if stopping || (mic.is_none() && sys.is_none()) {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = w_you.flush();
    let _ = w_them.flush();
    let chunks: Vec<Value> = [&w_you, &w_them]
        .iter()
        .flat_map(|w| w.done.iter().map(move |(n, r)| json!({ "track": w.track.key(), "n": n, "rms": r, "silent": *r < SILENCE_RMS })))
        .collect();
    let c = db.conn();
    let _ = c.execute(
        r#"UPDATE "Meeting" SET "endedAt"=?2, "durationMs"=?3, "status"='recorded', "chunks"=?4 WHERE "id"=?1"#,
        params![id, now_ms(), active.as_millis() as i64, Value::Array(chunks).to_string()],
    );
    if mic.is_none() && sys.is_none() && !stop.load(Ordering::SeqCst) {
        // both devices died: end the session ourselves
        if let Ok(mut s) = session().lock() {
            *s = None;
        }
        if let Ok(mut l) = live().lock() {
            *l = LiveStatus { state: "idle".into(), error: Some("Recording stopped: the audio devices went away.".into()), ..Default::default() };
        }
        announce();
    }
}

fn default_title(now: i64) -> String {
    use chrono::TimeZone;
    chrono::Local.timestamp_millis_opt(now).single().map(|d| format!("Meeting {}", d.format("%a %d %b, %H:%M"))).unwrap_or_else(|| "Meeting".into())
}

// ------------------------------------------------------------------ schema + rows

pub fn ensure_schema(c: &Connection) -> Result<(), String> {
    c.execute_batch(
        r#"CREATE TABLE IF NOT EXISTS "Meeting" (
            "id" TEXT PRIMARY KEY, "title" TEXT NOT NULL, "startedAt" INTEGER NOT NULL, "endedAt" INTEGER,
            "durationMs" INTEGER NOT NULL DEFAULT 0, "status" TEXT NOT NULL, "devices" TEXT, "chunks" TEXT,
            "transcript" TEXT, "summary" TEXT, "noteId" TEXT, "error" TEXT, "engine" TEXT
        );
        CREATE TABLE IF NOT EXISTS "MeetingSeg" (
            "meetingId" TEXT NOT NULL, "track" TEXT NOT NULL, "chunk" INTEGER NOT NULL, "segments" TEXT NOT NULL,
            "engine" TEXT NOT NULL, PRIMARY KEY ("meetingId","track","chunk")
        );"#,
    )
    .map_err(|e| e.to_string())
}

fn row_json(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    let parse = |s: Option<String>| s.and_then(|s| serde_json::from_str::<Value>(&s).ok()).unwrap_or(Value::Null);
    Ok(json!({
        "id": r.get::<_, String>(0)?, "title": r.get::<_, String>(1)?, "startedAt": r.get::<_, i64>(2)?,
        "endedAt": r.get::<_, Option<i64>>(3)?, "durationMs": r.get::<_, i64>(4)?, "status": r.get::<_, String>(5)?,
        "devices": parse(r.get(6)?), "chunks": parse(r.get(7)?), "transcript": parse(r.get(8)?), "summary": parse(r.get(9)?),
        "noteId": r.get::<_, Option<String>>(10)?, "error": r.get::<_, Option<String>>(11)?, "engine": r.get::<_, Option<String>>(12)?,
    }))
}
const COLS: &str = r#""id","title","startedAt","endedAt","durationMs","status","devices","chunks","transcript","summary","noteId","error","engine""#;

pub fn get(c: &Connection, id: &str) -> Option<Value> {
    let _ = ensure_schema(c);
    c.query_row(&format!(r#"SELECT {COLS} FROM "Meeting" WHERE "id"=?1"#), params![id], row_json).optional().ok().flatten()
}

pub fn list(c: &Connection) -> Vec<Value> {
    let _ = ensure_schema(c);
    let Ok(mut st) = c.prepare(&format!(r#"SELECT {COLS} FROM "Meeting" ORDER BY "startedAt" DESC LIMIT 200"#)) else { return vec![] };
    st.query_map([], row_json).map(|r| r.flatten().collect()).unwrap_or_default()
}

pub fn set_status(c: &Connection, id: &str, status: &str, error: Option<&str>) {
    let _ = c.execute(r#"UPDATE "Meeting" SET "status"=?2, "error"=?3 WHERE "id"=?1"#, params![id, status, error]);
}

/// Chunks that still need a transcript (non-silent, no segments yet), oldest first.
pub fn pending_chunks(c: &Connection, id: &str) -> Vec<(Track, u32)> {
    let Some(m) = get(c, id) else { return vec![] };
    let done: Vec<(String, i64)> = c
        .prepare(r#"SELECT "track","chunk" FROM "MeetingSeg" WHERE "meetingId"=?1"#)
        .and_then(|mut s| s.query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?))).map(|r| r.flatten().collect()))
        .unwrap_or_default();
    m["chunks"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|x| !x["silent"].as_bool().unwrap_or(false))
                .filter_map(|x| Some((Track::parse(x["track"].as_str()?)?, x["n"].as_u64()? as u32)))
                .filter(|(t, n)| !done.iter().any(|(dt, dn)| dt == t.key() && *dn == *n as i64))
                .collect()
        })
        .unwrap_or_default()
}

pub fn save_segments(c: &Connection, id: &str, track: Track, chunk: u32, segs: &[Seg], engine: &str) -> Result<(), String> {
    ensure_schema(c)?;
    c.execute(
        r#"INSERT OR REPLACE INTO "MeetingSeg"("meetingId","track","chunk","segments","engine") VALUES (?1,?2,?3,?4,?5)"#,
        params![id, track.key(), chunk, serde_json::to_string(segs).unwrap_or_default(), engine],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Rebuild the merged transcript from every chunk's segments.
pub fn rebuild_transcript(c: &Connection, id: &str) -> Vec<Line> {
    let rows: Vec<(String, i64, String, String)> = c
        .prepare(r#"SELECT "track","chunk","segments","engine" FROM "MeetingSeg" WHERE "meetingId"=?1"#)
        .and_then(|mut s| s.query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).map(|r| r.flatten().collect()))
        .unwrap_or_default();
    let (mut you, mut them) = (vec![], vec![]);
    let mut engines: Vec<String> = vec![];
    for (t, n, s, e) in rows {
        let off = n * CHUNK_SECS as i64 * 1000;
        let segs: Vec<Seg> = serde_json::from_str(&s).unwrap_or_default();
        let target = if t == "you" { &mut you } else { &mut them };
        target.extend(segs.into_iter().map(|g| Seg { start_ms: g.start_ms + off, end_ms: g.end_ms + off, text: g.text }));
        if !engines.contains(&e) {
            engines.push(e);
        }
    }
    let lines = merge_transcript(&you, &them);
    let _ = c.execute(
        r#"UPDATE "Meeting" SET "transcript"=?2, "engine"=?3 WHERE "id"=?1"#,
        params![id, serde_json::to_string(&lines).unwrap_or_default(), engines.join("+")],
    );
    lines
}

pub fn delete(c: &Connection, id: &str) -> Result<(), String> {
    if session().lock().map(|s| s.as_ref().map(|x| x.id == id).unwrap_or(false)).unwrap_or(false) {
        return Err("Stop the recording first.".into());
    }
    ensure_schema(c)?;
    c.execute(r#"DELETE FROM "MeetingSeg" WHERE "meetingId"=?1"#, params![id]).map_err(|e| e.to_string())?;
    c.execute(r#"DELETE FROM "Meeting" WHERE "id"=?1"#, params![id]).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(meeting_dir(id));
    Ok(())
}

/// A whole track as one WAV (chunks concatenated) — what the note's audio link plays.
pub fn track_wav(id: &str, track: Track) -> Option<Vec<u8>> {
    let mut pcm = vec![];
    for n in 0.. {
        let p = chunk_path(id, track, n);
        let Ok(b) = std::fs::read(&p) else { break };
        if b.len() > 44 {
            pcm.extend_from_slice(&b[44..]);
        }
    }
    if pcm.is_empty() {
        return None;
    }
    let mut out = wav_header((pcm.len() / 2) as u32).to_vec();
    out.extend(pcm);
    Some(out)
}

pub fn chunk_wav(id: &str, track: Track, n: u32) -> Option<Vec<u8>> {
    std::fs::read(chunk_path(id, track, n)).ok()
}

// ------------------------------------------------------------------ transcript merge (pure)

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Seg {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    pub speaker: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

/// Whisper's favourite hallucinations on silence / music.
fn is_noise(t: &str) -> bool {
    let n: String = t.to_lowercase().chars().filter(|c| c.is_alphanumeric() || c.is_whitespace()).collect();
    let n = n.trim();
    n.is_empty()
        || matches!(n, "you" | "thank you" | "thanks for watching" | "thank you for watching" | "bye" | "music" | "blank audio" | "silence" | "applause")
        || t.trim().starts_with('[') && t.trim().ends_with(']')
        || t.trim().starts_with('(') && t.trim().ends_with(')')
}

fn words(t: &str) -> std::collections::HashSet<String> {
    t.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| w.len() > 1).map(String::from).collect()
}

/// Word overlap of two texts (Jaccard), 0..1.
pub fn similarity(a: &str, b: &str) -> f64 {
    let (wa, wb) = (words(a), words(b));
    if wa.is_empty() || wb.is_empty() {
        return 0.0;
    }
    wa.intersection(&wb).count() as f64 / wa.union(&wb).count() as f64
}

/// Interleave both tracks by time into speaker-labelled lines.
/// * drops whitespace / known Whisper hallucinations
/// * drops a "You" segment that is the other side bleeding into the mic (overlaps a "Them"
///   segment in time and says mostly the same words)
/// * joins consecutive segments of the same speaker when the gap is ≤ 2 s (max ~600 chars)
pub fn merge_transcript(you: &[Seg], them: &[Seg]) -> Vec<Line> {
    let clean = |s: &[Seg]| -> Vec<Seg> { s.iter().filter(|g| !is_noise(&g.text)).map(|g| Seg { text: g.text.trim().to_string(), ..g.clone() }).collect() };
    let (you, them) = (clean(you), clean(them));
    let mut all: Vec<(Track, Seg)> = vec![];
    for y in you {
        let bleed = them.iter().any(|t| t.start_ms < y.end_ms + 1_000 && y.start_ms < t.end_ms + 1_000 && similarity(&y.text, &t.text) >= 0.6);
        if !bleed {
            all.push((Track::You, y));
        }
    }
    all.extend(them.into_iter().map(|t| (Track::Them, t)));
    all.sort_by(|a, b| a.1.start_ms.cmp(&b.1.start_ms).then(a.1.end_ms.cmp(&b.1.end_ms)));
    let mut out: Vec<Line> = vec![];
    for (t, s) in all {
        match out.last_mut() {
            Some(l) if l.speaker == t.label() && s.start_ms - l.end_ms <= 2_000 && l.text.len() + s.text.len() < 600 => {
                l.text.push(' ');
                l.text.push_str(&s.text);
                l.end_ms = l.end_ms.max(s.end_ms);
            }
            _ => out.push(Line { speaker: t.label().into(), start_ms: s.start_ms, end_ms: s.end_ms, text: s.text }),
        }
    }
    out
}

pub fn stamp(ms: i64) -> String {
    let s = ms.max(0) / 1000;
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
    } else {
        format!("{:02}:{:02}", s / 60, s % 60)
    }
}

pub fn transcript_text(lines: &[Line]) -> String {
    lines.iter().map(|l| format!("[{}] {}: {}", stamp(l.start_ms), l.speaker, l.text)).collect::<Vec<_>>().join("\n")
}

// ------------------------------------------------------------------ summary (pure parts)

/// Upper bound for the transcript sent to the model (characters); the middle is elided.
pub const SUMMARY_MAX_CHARS: usize = 60_000;

pub fn summary_prompt(title: &str, duration_ms: i64, lines: &[Line]) -> Vec<crate::ai::ChatMsg> {
    let mut t = transcript_text(lines);
    if t.len() > SUMMARY_MAX_CHARS {
        let head: String = t.chars().take(SUMMARY_MAX_CHARS * 2 / 3).collect();
        let tail: String = t.chars().rev().take(SUMMARY_MAX_CHARS / 3).collect::<Vec<_>>().into_iter().rev().collect();
        t = format!("{head}\n[… middle of the transcript omitted for length …]\n{tail}");
    }
    let sys = "You are an expert meeting note-taker. You turn a raw two-speaker call transcript into accurate, concise meeting notes. \
\"You\" is the person who recorded the call (the user); \"Them\" is everyone on the other side of the call (they may be several people — use names when the transcript makes them clear). \
Only use facts stated in the transcript; never invent names, numbers, dates or commitments. Transcripts come from speech recognition and may contain errors — fix obvious mis-hearings silently. \
Reply with ONE JSON object and nothing else.";
    let user = format!(
        "Meeting: {title}\nDuration: {}\n\nReturn JSON exactly in this shape:\n{{\n  \"title\": \"short descriptive title (max 8 words)\",\n  \"summary\": \"2-4 sentence overview of what the meeting was about and its outcome\",\n  \"keyPoints\": [\"important point discussed\", ...],\n  \"decisions\": [\"decision that was agreed\", ...],\n  \"actionItems\": [{{ \"task\": \"concrete next step\", \"owner\": \"You | Them | a person's name | Unassigned\", \"due\": \"deadline if one was mentioned, else null\" }}],\n  \"openQuestions\": [\"unresolved question\", ...]\n}}\nUse empty arrays when there is nothing. Keep each item to one line.\n\nTranscript:\n{t}",
        stamp(duration_ms)
    );
    vec![crate::ai::ChatMsg { role: "system".into(), content: sys.into() }, crate::ai::ChatMsg { role: "user".into(), content: user }]
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActionItem {
    pub task: String,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub due: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub key_points: Vec<String>,
    #[serde(default)]
    pub decisions: Vec<String>,
    #[serde(default)]
    pub action_items: Vec<ActionItem>,
    #[serde(default)]
    pub open_questions: Vec<String>,
}

/// Parse the model's reply (tolerates code fences / prose around the JSON); falls back to the
/// raw text as the summary.
pub fn parse_summary(raw: &str) -> Summary {
    let s = raw.trim();
    if let (Some(a), Some(b)) = (s.find('{'), s.rfind('}')) {
        if b > a {
            if let Ok(v) = serde_json::from_str::<Value>(&s[a..=b]) {
                let strs = |k: &str| v[k].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.trim().to_string())).filter(|s| !s.is_empty()).collect()).unwrap_or_default();
                let items = v["actionItems"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| {
                                if let Some(t) = x.as_str() {
                                    return Some(ActionItem { task: t.to_string(), owner: None, due: None });
                                }
                                let task = x["task"].as_str()?.trim().to_string();
                                let owner = x["owner"].as_str().map(str::trim).filter(|o| !o.is_empty() && !o.eq_ignore_ascii_case("null")).map(String::from);
                                let due = x["due"].as_str().map(str::trim).filter(|o| !o.is_empty() && !o.eq_ignore_ascii_case("null")).map(String::from);
                                (!task.is_empty()).then_some(ActionItem { task, owner, due })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                return Summary {
                    title: v["title"].as_str().map(str::trim).filter(|t| !t.is_empty()).map(String::from),
                    summary: v["summary"].as_str().unwrap_or("").trim().to_string(),
                    key_points: strs("keyPoints"),
                    decisions: strs("decisions"),
                    action_items: items,
                    open_questions: strs("openQuestions"),
                };
            }
        }
    }
    Summary { summary: s.to_string(), ..Default::default() }
}

/// The note written for a summarised meeting.
pub fn note_markdown(meeting: &Value, sum: &Summary, lines: &[Line], api_base: &str) -> String {
    let id = meeting["id"].as_str().unwrap_or("");
    let mut md = String::new();
    let started = meeting["startedAt"].as_i64().unwrap_or(0);
    let when = {
        use chrono::TimeZone;
        chrono::Local.timestamp_millis_opt(started).single().map(|d| d.format("%A %d %B %Y, %H:%M").to_string()).unwrap_or_default()
    };
    md.push_str(&format!("> 🎙️ Recorded {when} · {} · #meeting\n\n", stamp(meeting["durationMs"].as_i64().unwrap_or(0))));
    md.push_str("## Summary\n\n");
    md.push_str(if sum.summary.is_empty() { "_No summary._" } else { &sum.summary });
    md.push_str("\n\n");
    let list = |md: &mut String, h: &str, xs: &[String]| {
        if !xs.is_empty() {
            md.push_str(&format!("## {h}\n\n"));
            for x in xs {
                md.push_str(&format!("- {x}\n"));
            }
            md.push('\n');
        }
    };
    list(&mut md, "Key points", &sum.key_points);
    list(&mut md, "Decisions", &sum.decisions);
    if !sum.action_items.is_empty() {
        md.push_str("## Action items\n\n");
        for a in &sum.action_items {
            let owner = a.owner.as_deref().unwrap_or("Unassigned");
            let due = a.due.as_deref().map(|d| format!(" · due {d}")).unwrap_or_default();
            md.push_str(&format!("- [ ] {} — **{owner}**{due}\n", a.task));
        }
        md.push('\n');
    }
    list(&mut md, "Open questions", &sum.open_questions);
    md.push_str("## Recording\n\n");
    md.push_str(&format!("- [🎧 Your side (mic)]({api_base}/api/meetings/{id}/audio/you)\n- [🔊 Their side (system audio)]({api_base}/api/meetings/{id}/audio/them)\n\n"));
    if !lines.is_empty() {
        md.push_str("## Transcript\n\n");
        for l in lines {
            md.push_str(&format!("**[{}] {}:** {}\n\n", stamp(l.start_ms), l.speaker, l.text));
        }
    }
    md
}

// ------------------------------------------------------------------ STT (cloud)

#[derive(Debug, Clone, PartialEq)]
pub enum Stt {
    Local,
    /// OpenAI-compatible `/audio/transcriptions` (Groq, OpenAI, …)
    OpenAiCompat { base: String, model: String, key: String, provider: String },
    Gemini { model: String, key: String },
}

/// Pick the speech-to-text engine: an explicit choice in Meeting settings, else the first
/// provider with a stored key (Groq → OpenAI → Gemini), else the local Whisper worker.
pub fn pick_stt(choice: &str, model: Option<&str>, key_of: &dyn Fn(&str) -> Option<String>, ai_cfg: &crate::ai::AiConfig) -> Stt {
    let groq = |k: String| Stt::OpenAiCompat { base: "https://api.groq.com/openai/v1".into(), model: model.unwrap_or("whisper-large-v3").into(), key: k, provider: "groq".into() };
    let openai = |k: String| {
        // a custom OpenAI-compatible base from Settings → AI wins over api.openai.com
        let base = if ai_cfg.provider == "openai" || ai_cfg.provider == "custom" { ai_cfg.base_url.trim_end_matches('/').to_string() } else { String::new() };
        Stt::OpenAiCompat { base: if base.is_empty() { "https://api.openai.com/v1".into() } else { base }, model: model.unwrap_or("whisper-1").into(), key: k, provider: "openai".into() }
    };
    let gemini = |k: String| Stt::Gemini { model: model.unwrap_or("gemini-2.5-flash").into(), key: k };
    let k = |p: &str| key_of(p).filter(|k| !k.is_empty());
    match choice {
        "local" => Stt::Local,
        "groq" => k("groq").map(groq).unwrap_or(Stt::Local),
        "openai" => k("openai").or_else(|| k("custom")).map(openai).unwrap_or(Stt::Local),
        "gemini" => k("gemini").map(gemini).unwrap_or(Stt::Local),
        _ => k("groq").map(groq).or_else(|| k("openai").map(openai)).or_else(|| k("gemini").map(gemini)).unwrap_or(Stt::Local),
    }
}

impl Stt {
    pub fn engine(&self) -> String {
        match self {
            Stt::Local => "local-whisper".into(),
            Stt::OpenAiCompat { provider, model, .. } => format!("{provider}:{model}"),
            Stt::Gemini { model, .. } => format!("gemini:{model}"),
        }
    }
}

/// `verbose_json` / Gemini JSON → segments (ms). A plain `text` becomes one segment.
pub fn parse_stt(v: &Value, chunk_ms: i64) -> Vec<Seg> {
    let num = |x: &Value| x.as_f64().or_else(|| x.as_str().and_then(|s| s.trim_end_matches('s').parse().ok()));
    let arr = v["segments"].as_array().or_else(|| v.as_array());
    if let Some(a) = arr {
        let segs: Vec<Seg> = a
            .iter()
            .filter_map(|s| {
                let text = s["text"].as_str()?.trim().to_string();
                let start = num(&s["start"]).unwrap_or(0.0);
                let end = num(&s["end"]).unwrap_or(start);
                (!text.is_empty()).then_some(Seg { start_ms: (start * 1000.0) as i64, end_ms: ((end * 1000.0) as i64).min(chunk_ms.max(1)), text })
            })
            .collect();
        if !segs.is_empty() {
            return segs;
        }
    }
    match v["text"].as_str().map(str::trim) {
        Some(t) if !t.is_empty() => vec![Seg { start_ms: 0, end_ms: chunk_ms, text: t.to_string() }],
        _ => vec![],
    }
}

pub async fn transcribe_chunk(http: &reqwest::Client, stt: &Stt, wav: Vec<u8>, language: Option<&str>) -> Result<Vec<Seg>, String> {
    let chunk_ms = (((wav.len().saturating_sub(44)) / 2) as i64 * 1000) / RATE as i64;
    match stt {
        Stt::Local => Err("local".into()),
        Stt::OpenAiCompat { base, model, key, provider } => {
            let part = reqwest::multipart::Part::bytes(wav).file_name("chunk.wav").mime_str("audio/wav").map_err(|e| e.to_string())?;
            let mut form = reqwest::multipart::Form::new().part("file", part).text("model", model.clone()).text("response_format", "verbose_json").text("temperature", "0");
            if let Some(l) = language.filter(|l| !l.is_empty() && *l != "auto") {
                form = form.text("language", l.to_string());
            }
            let r = http
                .post(format!("{}/audio/transcriptions", base.trim_end_matches('/')))
                .bearer_auth(key)
                .multipart(form)
                .timeout(Duration::from_secs(120))
                .send()
                .await
                .map_err(|e| format!("{provider}: {e}"))?;
            let code = r.status();
            let body = r.text().await.map_err(|e| e.to_string())?;
            if !code.is_success() {
                return Err(format!("{provider} speech-to-text failed ({code}): {}", body.chars().take(300).collect::<String>()));
            }
            let v: Value = serde_json::from_str(&body).unwrap_or_else(|_| json!({ "text": body }));
            Ok(parse_stt(&v, chunk_ms))
        }
        Stt::Gemini { model, key } => {
            use base64::Engine;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&wav);
            let prompt = "Transcribe this audio verbatim. Return ONLY a JSON array of segments: [{\"start\": seconds, \"end\": seconds, \"text\": \"...\"}]. Split at sentence or speaker pauses. Return [] if there is no speech.";
            let body = json!({
                "contents": [{ "parts": [{ "text": prompt }, { "inline_data": { "mime_type": "audio/wav", "data": b64 } }] }],
                "generationConfig": { "temperature": 0, "responseMimeType": "application/json" }
            });
            let r = http
                .post(format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"))
                .header("x-goog-api-key", key)
                .json(&body)
                .timeout(Duration::from_secs(120))
                .send()
                .await
                .map_err(|e| format!("gemini: {e}"))?;
            let code = r.status();
            let txt = r.text().await.map_err(|e| e.to_string())?;
            if !code.is_success() {
                return Err(format!("Gemini speech-to-text failed ({code}): {}", txt.chars().take(300).collect::<String>()));
            }
            let v: Value = serde_json::from_str(&txt).map_err(|e| e.to_string())?;
            let out = v["candidates"][0]["content"]["parts"][0]["text"].as_str().unwrap_or("[]");
            let (a, b) = (out.find('['), out.rfind(']'));
            let parsed: Value = match (a, b) {
                (Some(a), Some(b)) if b > a => serde_json::from_str(&out[a..=b]).unwrap_or(Value::Null),
                _ => json!({ "text": out }),
            };
            Ok(parse_stt(&parsed, chunk_ms))
        }
    }
}

// ------------------------------------------------------------------ settings

pub fn config(c: &Connection) -> Value {
    let v = crate::db::setting_get(c, "meeting-config").and_then(|s| serde_json::from_str::<Value>(&s).ok()).unwrap_or(json!({}));
    json!({
        "stt": v["stt"].as_str().unwrap_or("auto"),
        "sttModel": v["sttModel"].as_str(),
        "language": v["language"].as_str().unwrap_or("auto"),
        "autoSummarize": v["autoSummarize"].as_bool().unwrap_or(true),
    })
}

pub fn patch_config(c: &Connection, b: &Map<String, Value>) -> Result<Value, String> {
    let mut cur = config(c);
    for k in ["stt", "sttModel", "language", "autoSummarize"] {
        if let Some(v) = b.get(k) {
            cur[k] = v.clone();
        }
    }
    if !matches!(cur["stt"].as_str(), Some("auto" | "local" | "groq" | "openai" | "gemini")) {
        return Err("stt must be auto, local, groq, openai or gemini".into());
    }
    crate::db::setting_put(c, "meeting-config", &cur.to_string())?;
    Ok(cur)
}

/// `/api/meetings/live` and friends (sync routes; the network ones live in api.rs).
pub fn route(c: &Connection, m: &str, rest: &[&str], b: &Map<String, Value>) -> Option<crate::api::ApiResponse> {
    use crate::api::{ApiResponse as R, Body};
    let _ = ensure_schema(c);
    Some(match (m, rest) {
        ("GET", []) => R::json(json!(list(c))),
        ("GET", ["live"]) => R::json(serde_json::to_value(status()).unwrap_or(Value::Null)),
        ("GET", ["config"]) => R::json(config(c)),
        ("PUT", ["config"]) | ("PATCH", ["config"]) => match patch_config(c, b) {
            Ok(v) => R::json(v),
            Err(e) => R::err(400, &e),
        },
        ("POST", ["pause"]) => match set_paused(b.get("paused").and_then(|v| v.as_bool()).unwrap_or(true)) {
            Ok(s) => R::json(serde_json::to_value(s).unwrap_or(Value::Null)),
            Err(e) => R::err(409, &e),
        },
        ("GET", [id]) => match get(c, id) {
            Some(v) => R::json(v),
            None => R::err(404, "no such meeting"),
        },
        ("PATCH", [id]) => {
            if let Some(t) = b.get("title").and_then(|v| v.as_str()).map(str::trim).filter(|t| !t.is_empty()) {
                let _ = c.execute(r#"UPDATE "Meeting" SET "title"=?2 WHERE "id"=?1"#, params![id, t]);
            }
            match get(c, id) {
                Some(v) => R::json(v),
                None => R::err(404, "no such meeting"),
            }
        }
        ("DELETE", [id]) => match delete(c, id) {
            Ok(_) => R::ok(),
            Err(e) => R::err(409, &e),
        },
        ("GET", [id, "pending"]) => R::json(json!(pending_chunks(c, id).into_iter().map(|(t, n)| json!({ "track": t.key(), "n": n, "url": format!("/api/meetings/{id}/chunks/{}/{n}", t.key()) })).collect::<Vec<_>>())),
        ("POST", [id, "segments"]) => {
            let (Some(t), Some(n)) = (b.get("track").and_then(|v| v.as_str()).and_then(Track::parse), b.get("n").and_then(|v| v.as_u64())) else {
                return Some(R::err(400, "track and n required"));
            };
            let segs: Vec<Seg> = b.get("segments").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
            match save_segments(c, id, t, n as u32, &segs, b.get("engine").and_then(|v| v.as_str()).unwrap_or("local-whisper")) {
                Ok(_) => {
                    let lines = rebuild_transcript(c, id);
                    let left = pending_chunks(c, id).len();
                    if left == 0 {
                        set_status(c, id, "transcribed", None);
                    }
                    R::json(json!({ "ok": true, "lines": lines.len(), "pending": left }))
                }
                Err(e) => R::err(500, &e),
            }
        }
        ("GET", [id, "chunks", t, n]) => match Track::parse(t).zip(n.parse::<u32>().ok()).and_then(|(tr, n)| chunk_wav(id, tr, n)) {
            Some(data) => R { status: 200, body: Body::Bytes { mime: "audio/wav".into(), name: format!("{t}-{n}.wav"), data } },
            None => R::err(404, "no such chunk"),
        },
        ("GET", [id, "audio", t]) => match Track::parse(t).and_then(|tr| track_wav(id, tr)) {
            Some(data) => R { status: 200, body: Body::Bytes { mime: "audio/wav".into(), name: format!("{id}-{t}.wav"), data } },
            None => R::err(404, "no audio for this track"),
        },
        _ => return None,
    })
}

#[cfg(windows)]
#[path = "meeting_win.rs"]
mod win;

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(a: i64, b: i64, t: &str) -> Seg {
        Seg { start_ms: a, end_ms: b, text: t.into() }
    }

    #[test]
    fn merge_interleaves_by_time_and_labels_speakers() {
        let you = vec![seg(0, 2_000, "Hi, thanks for joining."), seg(9_000, 11_000, "Sounds good, I'll send the deck.")];
        let them = vec![seg(2_500, 5_000, "Happy to be here."), seg(5_200, 8_000, "Can we ship on Friday?")];
        let l = merge_transcript(&you, &them);
        assert_eq!(l.iter().map(|x| x.speaker.as_str()).collect::<Vec<_>>(), vec!["You", "Them", "You"]);
        assert_eq!(l[1].text, "Happy to be here. Can we ship on Friday?", "same speaker within 2 s is joined");
        assert_eq!((l[1].start_ms, l[1].end_ms), (2_500, 8_000));
        assert_eq!(transcript_text(&l).lines().next().unwrap(), "[00:00] You: Hi, thanks for joining.");
    }

    #[test]
    fn merge_drops_mic_bleed_and_hallucinations() {
        let them = vec![seg(1_000, 4_000, "We need the budget approved by Monday")];
        let you = vec![seg(1_200, 4_100, "need the budget approved by Monday"), seg(5_000, 5_500, "Thank you."), seg(6_000, 7_000, "[BLANK_AUDIO]"), seg(8_000, 9_000, "Okay, approved.")];
        let l = merge_transcript(&you, &them);
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].speaker, "Them");
        assert_eq!(l[1].text, "Okay, approved.");
    }

    #[test]
    fn merge_keeps_long_monologues_split_and_respects_gaps() {
        let you = vec![seg(0, 1_000, "one"), seg(4_000, 5_000, "two")];
        let l = merge_transcript(&you, &[]);
        assert_eq!(l.len(), 2, "a 3 s pause starts a new line");
        assert_eq!(stamp(3_725_000), "1:02:05");
    }

    #[test]
    fn summary_prompt_has_schema_speakers_and_transcript() {
        let lines = vec![Line { speaker: "Them".into(), start_ms: 65_000, end_ms: 70_000, text: "Ship Friday".into() }];
        let p = summary_prompt("Weekly sync", 1_800_000, &lines);
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].role, "system");
        assert!(p[0].content.contains("\"You\" is the person who recorded"));
        assert!(p[0].content.contains("never invent"));
        for k in ["\"summary\"", "\"keyPoints\"", "\"decisions\"", "\"actionItems\"", "\"owner\"", "\"due\""] {
            assert!(p[1].content.contains(k), "schema mentions {k}");
        }
        assert!(p[1].content.contains("Meeting: Weekly sync"));
        assert!(p[1].content.contains("Duration: 30:00"));
        assert!(p[1].content.contains("[01:05] Them: Ship Friday"));
        // very long transcripts are clipped with a marker, never sent whole
        let long: Vec<Line> = (0..5_000).map(|i| Line { speaker: "You".into(), start_ms: i * 1000, end_ms: i * 1000 + 900, text: "lorem ipsum dolor sit amet".into() }).collect();
        let p = summary_prompt("x", 0, &long);
        assert!(p[1].content.len() < SUMMARY_MAX_CHARS + 2_000);
        assert!(p[1].content.contains("omitted for length"));
    }

    #[test]
    fn parses_summary_json_even_with_fences() {
        let raw = "Sure!\n```json\n{\"title\":\"Launch plan\",\"summary\":\"We agreed to ship.\",\"keyPoints\":[\"QA done\"],\"decisions\":[\"Ship Friday\"],\"actionItems\":[{\"task\":\"Send deck\",\"owner\":\"You\",\"due\":\"Thursday\"},{\"task\":\"Book room\",\"owner\":null},\"Loose item\"],\"openQuestions\":[]}\n```";
        let s = parse_summary(raw);
        assert_eq!(s.title.as_deref(), Some("Launch plan"));
        assert_eq!(s.decisions, vec!["Ship Friday".to_string()]);
        assert_eq!(s.action_items.len(), 3);
        assert_eq!(s.action_items[0], ActionItem { task: "Send deck".into(), owner: Some("You".into()), due: Some("Thursday".into()) });
        assert_eq!(s.action_items[1].owner, None);
        assert_eq!(parse_summary("just prose").summary, "just prose");
        let md = note_markdown(&json!({ "id": "m-1", "startedAt": 0, "durationMs": 60_000 }), &s, &[Line { speaker: "You".into(), start_ms: 0, end_ms: 1, text: "hi".into() }], "");
        assert!(md.contains("- [ ] Send deck — **You** · due Thursday"));
        assert!(md.contains("- [ ] Book room — **Unassigned**"));
        assert!(md.contains("/api/meetings/m-1/audio/them"));
        assert!(md.contains("**[00:00] You:** hi"));
    }

    #[test]
    fn stt_choice_and_parsing() {
        let cfg = crate::ai::AiConfig::default();
        let keys = |p: &str| (p == "gemini").then(|| "g-key".to_string());
        assert!(matches!(pick_stt("auto", None, &keys, &cfg), Stt::Gemini { .. }));
        assert_eq!(pick_stt("groq", None, &keys, &cfg), Stt::Local, "no groq key → local");
        let keys2 = |p: &str| (p == "groq").then(|| "gsk".to_string());
        match pick_stt("auto", None, &keys2, &cfg) {
            Stt::OpenAiCompat { base, model, .. } => assert_eq!((base.as_str(), model.as_str()), ("https://api.groq.com/openai/v1", "whisper-large-v3")),
            s => panic!("{s:?}"),
        }
        let v = json!({ "text": "a b", "segments": [{ "start": 0.0, "end": 1.5, "text": " a " }, { "start": "1.5s", "end": 40.0, "text": "b" }] });
        assert_eq!(parse_stt(&v, 30_000), vec![seg(0, 1_500, "a"), seg(1_500, 30_000, "b")]);
        assert_eq!(parse_stt(&json!({ "text": "hello" }), 30_000), vec![seg(0, 30_000, "hello")]);
        assert!(parse_stt(&json!([]), 1).is_empty());
    }

    #[test]
    fn dsp_resample_downmix_and_wav() {
        let mut r = Resampler::new(48_000);
        let mut out = vec![];
        r.push(&vec![0.5f32; 48_000], &mut out);
        assert_eq!(out.len(), 16_000);
        assert!((out[100] - 0.5).abs() < 1e-6);
        let mut m = vec![];
        downmix(&[1.0, 0.0, 0.5, 0.5], 2, &mut m);
        assert_eq!(m, vec![0.5, 0.5]);
        let h = wav_header(16_000);
        assert_eq!(&h[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes([h[40], h[41], h[42], h[43]]), 32_000);
        assert!(rms(&[0.0; 10]) < SILENCE_RMS);
    }

    #[test]
    fn records_two_aligned_tracks_with_fake_audio() {
        let tmp = tempfile::tempdir().unwrap();
        set_dir(tmp.path().to_path_buf());
        set_backend(Arc::new(FakeBackend));
        let db = Db::open_in_memory().unwrap();
        let st = start(&db, Some("Test call")).unwrap();
        assert_eq!(st.state, "recording");
        assert!(start(&db, None).is_err(), "one recording at a time");
        std::thread::sleep(Duration::from_millis(700));
        set_paused(true).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        set_paused(false).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let m = stop(&db).unwrap();
        assert_eq!(m["status"], "recorded");
        let dur = m["durationMs"].as_i64().unwrap();
        assert!((800..1_600).contains(&dur), "paused time is excluded: {dur}");
        let you = track_wav(m["id"].as_str().unwrap(), Track::You).unwrap();
        let them = track_wav(m["id"].as_str().unwrap(), Track::Them).unwrap();
        assert_eq!(you.len(), them.len(), "tracks stay aligned");
        let c = db.conn();
        let id = m["id"].as_str().unwrap();
        let pend = pending_chunks(&c, id);
        assert!(!pend.is_empty());
        save_segments(&c, id, Track::Them, 0, &[seg(0, 500, "hello there")], "test").unwrap();
        save_segments(&c, id, Track::You, 0, &[seg(600, 900, "hi")], "test").unwrap();
        let lines = rebuild_transcript(&c, id);
        assert_eq!(lines.len(), 2);
        assert_eq!(get(&c, id).unwrap()["transcript"][0]["speaker"], "Them");
        delete(&c, id).unwrap();
        assert!(get(&c, id).is_none());
    }
}
