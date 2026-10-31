//! Nook meeting recorder — captures the microphone with cpal (WASAPI on
//! Windows) and streams raw samples straight to a 16-bit PCM WAV file.
//! No codecs, no ffmpeg, no network. Files live in <appdata>/recordings.
//!
//! v0.7 FIX — "recording gets stuck": start/stop used to BLOCK the UI
//! thread (Tauri sync commands run on the main thread) waiting on channel
//! handshakes and thread joins. If a mic driver took long to initialise
//! the whole window froze. Now every command returns instantly and the
//! capture thread reports progress through `recorder://event`:
//!   { kind: "started" }
//!   { kind: "saved",   info: RecordingInfo }
//!   { kind: "error",   message: String, saved: bool }
//! The whole capture (device + stream + file) still runs inside one
//! dedicated thread: cpal::Stream is !Send, so it must never cross threads.

use std::fs::File;
use std::io::{Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{civil_from_days, es, now_ms, CmdResult};

pub struct RecorderState {
    recording: Arc<AtomicBool>,
    stop_flag: Arc<AtomicBool>,
    started_at: AtomicI64,
    last_error: Mutex<Option<String>>,
}

impl RecorderState {
    pub fn new() -> Self {
        Self {
            recording: Arc::new(AtomicBool::new(false)),
            stop_flag: Arc::new(AtomicBool::new(false)),
            started_at: AtomicI64::new(0),
            last_error: Mutex::new(None),
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecordingInfo {
    pub name: String,
    pub path: String,
    pub bytes: i64,
    pub duration_ms: i64,
    pub created_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecorderStatus {
    pub recording: bool,
    pub elapsed_ms: i64,
    pub error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RecEvent {
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    info: Option<RecordingInfo>,
}

fn emit_event(app: &AppHandle, kind: &str, message: Option<String>, info: Option<RecordingInfo>) {
    let _ = app.emit(
        "recorder://event",
        RecEvent {
            kind: kind.to_string(),
            message,
            info,
        },
    );
}

fn recordings_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(es)?.join("recordings");
    std::fs::create_dir_all(&dir).map_err(es)?;
    Ok(dir)
}

fn rec_file(dir: &PathBuf, name: &str) -> PathBuf {
    dir.join(name)
}

fn safe_name(name: &str) -> Option<String> {
    let name = name.trim();
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || !name.to_lowercase().ends_with(".wav")
    {
        return None;
    }
    Some(name.to_string())
}

// ------------------------------------------------------------- wav bits ----

fn write_wav_header(w: &mut File, sample_rate: u32, channels: u16) -> std::io::Result<()> {
    let bits = 16u16;
    let byte_rate = sample_rate * channels as u32 * (bits as u32) / 8;
    let block_align = channels * (bits / 8);
    w.write_all(b"RIFF")?;
    w.write_all(&0u32.to_le_bytes())?; // patched on stop
    w.write_all(b"WAVE")?;
    w.write_all(b"fmt ")?;
    w.write_all(&16u32.to_le_bytes())?;
    w.write_all(&1u16.to_le_bytes())?; // PCM
    w.write_all(&channels.to_le_bytes())?;
    w.write_all(&sample_rate.to_le_bytes())?;
    w.write_all(&byte_rate.to_le_bytes())?;
    w.write_all(&block_align.to_le_bytes())?;
    w.write_all(&bits.to_le_bytes())?;
    w.write_all(b"data")?;
    w.write_all(&0u32.to_le_bytes())?; // patched on stop
    Ok(())
}

fn patch_wav_header(w: &mut File, data_bytes: u64) -> std::io::Result<()> {
    let riff_size = (36u64 + data_bytes) as u32;
    w.seek(SeekFrom::Start(4))?;
    w.write_all(&riff_size.to_le_bytes())?;
    w.seek(SeekFrom::Start(40))?;
    w.write_all(&(data_bytes as u32).to_le_bytes())?;
    w.flush()
}

/// Duration of a 16-bit PCM wav in ms (falls back to 0 for broken files).
pub fn wav_duration_ms(path: &PathBuf) -> i64 {
    let len = match std::fs::metadata(path) {
        Ok(m) => m.len() as i64,
        Err(_) => return 0,
    };
    if len < 44 {
        return 0;
    }
    use std::io::Read;
    let mut head = [0u8; 44];
    if std::fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut head))
        .is_err()
    {
        return 0;
    }
    if &head[0..4] != b"RIFF" || &head[8..12] != b"WAVE" {
        return 0;
    }
    let channels = u16::from_le_bytes([head[22], head[23]]) as i64;
    let rate = u32::from_le_bytes([head[24], head[25], head[26], head[27]]) as i64;
    if rate <= 0 || channels <= 0 {
        return 0;
    }
    let data_bytes = (len - 44).max(0);
    let frames = data_bytes / (channels * 2);
    (frames * 1000) / rate
}

// --------------------------------------------------------- capture thread ----

/// Runs the entire recording session in its own thread. Reports progress
/// through `recorder://event` — never through blocking channel handshakes.
fn capture_session(
    app: AppHandle,
    device: Option<String>,
    path: PathBuf,
    stop: Arc<AtomicBool>,
    rec: Arc<AtomicBool>,
) {
    let abort = |msg: String| {
        rec.store(false, Ordering::Relaxed);
        emit_event(&app, "error", Some(msg), None);
    };

    let host = cpal::default_host();
    let dev = match device.as_deref().filter(|s| !s.is_empty()) {
        Some(name) => match host.input_devices().map_err(es).and_then(|mut ds| {
            ds.find(|d| d.name().map(|n| n == name).unwrap_or(false))
                .ok_or_else(|| format!("Microphone \"{name}\" not found"))
        }) {
            Ok(d) => d,
            Err(e) => return abort(e),
        },
        None => match host.default_input_device() {
            Some(d) => d,
            None => return abort("No microphone found on this PC".into()),
        },
    };

    let cfg = match dev.default_input_config() {
        Ok(c) => c,
        Err(e) => return abort(format!("Could not open the microphone: {}", es(e))),
    };
    let (sample_rate, channels) = (cfg.sample_rate().0, cfg.channels());

    let (tx, rx) = mpsc::channel::<Vec<i16>>();
    let stream_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let cb_error = stream_error.clone();

    let build = |dev: &cpal::Device, cfg: &cpal::SupportedStreamConfig| match cfg.sample_format() {
        cpal::SampleFormat::F32 => dev.build_input_stream(
            &cfg.config(),
            move |data: &[f32], _| {
                let v: Vec<i16> = data
                    .iter()
                    .map(|s| (s.clamp(-1.0, 1.0) * 32_767.0) as i16)
                    .collect();
                let _ = tx.send(v);
            },
            move |err| {
                *cb_error.lock().unwrap_or_else(|p| p.into_inner()) = Some(err.to_string());
            },
            None,
        ),
        cpal::SampleFormat::I16 => dev.build_input_stream(
            &cfg.config(),
            move |data: &[i16], _| {
                let _ = tx.send(data.to_vec());
            },
            move |err| {
                *cb_error.lock().unwrap_or_else(|p| p.into_inner()) = Some(err.to_string());
            },
            None,
        ),
        cpal::SampleFormat::U16 => dev.build_input_stream(
            &cfg.config(),
            move |data: &[u16], _| {
                let v: Vec<i16> = data.iter().map(|s| (*s as i32 - 32_768) as i16).collect();
                let _ = tx.send(v);
            },
            move |err| {
                *cb_error.lock().unwrap_or_else(|p| p.into_inner()) = Some(err.to_string());
            },
            None,
        ),
        _other => Err(cpal::BuildStreamError::StreamConfigNotSupported),
    };

    // builds the input stream for whatever sample format the device offers;
    // `tx` is consumed into the first successful stream's data callback
    let stream = match build(&dev, &cfg) {
        Ok(s) => s,
        Err(e) => return abort(format!("Could not start the microphone: {}", es(e))),
    };

    if let Err(e) = stream.play() {
        return abort(format!("Could not start the microphone: {}", es(e)));
    }

    let mut file = match File::create(&path) {
        Ok(f) => f,
        Err(e) => return abort(format!("Could not create the file: {}", es(e))),
    };
    if let Err(e) = write_wav_header(&mut file, sample_rate, channels) {
        return abort(format!("Could not write the file: {}", es(e)));
    }

    // microphone is live — tell the UI
    emit_event(&app, "started", None, None);

    let mut total: u64 = 0;
    let mut err_streak: u32 = 0;
    let mut stop_pressed = false;
    loop {
        match rx.recv_timeout(Duration::from_millis(150)) {
            Ok(chunk) => {
                err_streak = 0;
                let mut bytes = Vec::with_capacity(chunk.len() * 2);
                for s in chunk {
                    bytes.extend_from_slice(&s.to_le_bytes());
                }
                if file.write_all(&bytes).is_ok() {
                    total += bytes.len() as u64;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if stop.load(Ordering::Relaxed) {
                    stop_pressed = true;
                    break;
                }
                // if the device errored out and stays silent, end the session
                // instead of spinning forever on a dead stream
                let has_err = stream_error
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .is_some();
                if has_err {
                    err_streak += 1;
                    if err_streak >= 10 {
                        break; // ~1.5 s of silence after an error
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    let _ = patch_wav_header(&mut file, total);
    drop(stream); // stops the capture on the thread that created it

    let info = std::fs::metadata(&path).ok().map(|meta| RecordingInfo {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: path.to_string_lossy().into_owned(),
        bytes: meta.len() as i64,
        duration_ms: wav_duration_ms(&path),
        created_at: now_ms(),
    });

    rec.store(false, Ordering::Relaxed);

    let stream_err = stream_error
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();

    if stop_pressed && stream_err.is_none() {
        if let Some(info) = info {
            emit_event(&app, "saved", None, Some(info));
            return;
        }
        emit_event(&app, "error", Some("Could not save the recording".into()), None);
        return;
    }

    // ended because of a device error (or the channel died)
    let msg = stream_err.unwrap_or_else(|| "The microphone stopped unexpectedly".into());
    match info {
        Some(i) if i.bytes > 44 => emit_event(
            &app,
            "error",
            Some(format!("{msg} — audio captured so far was saved")),
            Some(i),
        ),
        _ => emit_event(&app, "error", Some(msg), None),
    }
}

// --------------------------------------------------------------- commands ----

#[tauri::command]
pub async fn recorder_devices() -> CmdResult<Vec<String>> {
    // device enumeration can take seconds on some audio drivers — worker thread
    tauri::async_runtime::spawn_blocking(|| {
        let host = cpal::default_host();
        let mut names: Vec<String> = Vec::new();
        for d in host
            .input_devices()
            .map_err(es)?
            .filter_map(|d| d.name().ok())
        {
            names.push(d);
        }
        Ok(names)
    })
    .await
    .map_err(|e| es(e))?
}

#[tauri::command]
pub async fn recorder_status(state: State<'_, RecorderState>) -> CmdResult<RecorderStatus> {
    let recording = state.recording.load(Ordering::Relaxed);
    let elapsed = if recording {
        now_ms() - state.started_at.load(Ordering::Relaxed)
    } else {
        0
    };
    Ok(RecorderStatus {
        recording,
        elapsed_ms: elapsed,
        error: state
            .last_error
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone(),
    })
}

/// Returns instantly — the UI gets `recorder://event` when the mic is live
/// (or when it fails). NEVER blocks the main/UI thread.
#[tauri::command]
pub async fn recorder_start(app: AppHandle, state: State<'_, RecorderState>, device: Option<String>) -> CmdResult<()> {
    if state.recording.load(Ordering::Relaxed) {
        return Err("Already recording".into());
    }

    let dir = recordings_dir(&app)?;
    let (y, m, d) = civil_from_days(now_ms().div_euclid(86_400_000));
    let secs = now_ms().rem_euclid(86_400_000);
    let (hh, mm, ss) = (secs / 3_600_000, (secs / 60_000) % 60, (secs / 1000) % 60);
    let path = rec_file(
        &dir,
        &format!("rec-{y:04}{m:02}{d:02}-{hh:02}{mm:02}{ss:02}.wav"),
    );

    state.stop_flag.store(false, Ordering::Relaxed);
    state.recording.store(true, Ordering::Relaxed);
    state.started_at.store(now_ms(), Ordering::Relaxed);
    *state.last_error.lock().unwrap_or_else(|p| p.into_inner()) = None;

    let stop = state.stop_flag.clone();
    let rec = state.recording.clone();
    std::thread::spawn(move || {
        capture_session(app, device, path, stop, rec);
    });

    Ok(())
}

/// Returns instantly — the capture thread finalises the WAV and reports
/// back through `recorder://event` ("saved"). NEVER blocks the UI thread.
#[tauri::command]
pub async fn recorder_stop(state: State<'_, RecorderState>) -> CmdResult<()> {
    if !state.recording.load(Ordering::Relaxed) {
        return Ok(());
    }
    state.stop_flag.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn list_recordings(app: AppHandle) -> CmdResult<Vec<RecordingInfo>> {
    let dir = recordings_dir(&app)?;
    let mut out: Vec<RecordingInfo> = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(es)?.flatten() {
        let p = entry.path();
        if p.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("wav"))
            != Some(true)
        {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_file() {
            continue;
        }
        let created_at = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        out.push(RecordingInfo {
            name: p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            path: p.to_string_lossy().into_owned(),
            bytes: meta.len() as i64,
            duration_ms: wav_duration_ms(&p),
            created_at,
        });
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

#[tauri::command]
pub async fn rename_recording(app: AppHandle, from: String, to: String) -> CmdResult<()> {
    let dir = recordings_dir(&app)?;
    let from_name = safe_name(&from).ok_or("Invalid file name")?;
    let to_name = safe_name(&to).ok_or("Invalid new name")?;
    let from = rec_file(&dir, &from_name);
    let to = rec_file(&dir, &to_name);
    std::fs::rename(from, to).map_err(es)?;
    Ok(())
}

#[tauri::command]
pub async fn delete_recording(app: AppHandle, name: String) -> CmdResult<()> {
    let dir = recordings_dir(&app)?;
    let name_ok = safe_name(&name).ok_or("Invalid file name")?;
    let p = rec_file(&dir, &name_ok);
    std::fs::remove_file(p).map_err(es)?;
    Ok(())
}

#[tauri::command]
pub async fn export_recording(app: AppHandle, name: String) -> CmdResult<Option<String>> {
    let dir = recordings_dir(&app)?;
    let name_ok = safe_name(&name).ok_or("Invalid file name")?;
    let src_path = rec_file(&dir, &name_ok);
    tauri::async_runtime::spawn_blocking(move || {
        let path = rfd::FileDialog::new()
            .set_title("Save recording as…")
            .set_file_name(name.as_str())
            .add_filter("WAV audio", &["wav"])
            .save_file();
        match path {
            Some(dest) => {
                std::fs::copy(&src_path, &dest).map_err(es)?;
                Ok(Some(dest.to_string_lossy().into_owned()))
            }
            None => Ok(None),
        }
    })
    .await
    .map_err(|e| es(e))?
}
