//! Nook meeting recorder — captures the microphone with cpal (WASAPI on
//! Windows) and streams raw samples straight to a 16-bit PCM WAV file.
//! No codecs, no ffmpeg, no network. Files live in <appdata>/recordings.

use std::fs::File;
use std::io::{Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::{civil_from_days, es, now_ms, CmdResult};

pub struct RecorderState {
    recording: Arc<AtomicBool>,
    stop_flag: Arc<AtomicBool>,
    started_at: AtomicI64,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
    current_path: Mutex<Option<PathBuf>>,
    last_error: Arc<Mutex<Option<String>>>,
}

impl RecorderState {
    pub fn new() -> Self {
        Self {
            recording: Arc::new(AtomicBool::new(false)),
            stop_flag: Arc::new(AtomicBool::new(false)),
            started_at: AtomicI64::new(0),
            thread: Mutex::new(None),
            current_path: Mutex::new(None),
            last_error: Arc::new(Mutex::new(None)),
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

/// Duration of a 16-bit PCM wav in ms (falls back to file-size math).
pub fn wav_duration_ms(path: &PathBuf) -> i64 {
    let len = match std::fs::metadata(path) {
        Ok(m) => m.len() as i64,
        Err(_) => return 0,
    };
    if len < 44 {
        return 0;
    }
    let mut head = [0u8; 44];
    let rate = std::fs::File::open(path)
        .and_then(|mut f| {
            use std::io::Read;
            f.read_exact(&mut head)?;
            Ok(())
        })
        .ok()
        .and_then(|_| {
            let riff_ok = &head[0..4] == b"RIFF" && &head[8..12] == b"WAVE";
            if !riff_ok {
                return None;
            }
            let channels = u16::from_le_bytes([head[22], head[23]]) as i64;
            let rate = u32::from_le_bytes([head[24], head[25], head[26], head[27]]) as i64;
            if rate <= 0 || channels <= 0 {
                return None;
            }
            Some((rate, channels))
        });
    let (rate, channels) = match rate {
        Some(v) => v,
        None => return 0,
    };
    let data_bytes = (len - 44).max(0);
    let frames = data_bytes / (channels * 2);
    (frames * 1000) / rate
}

// --------------------------------------------------------------- commands ----

#[tauri::command]
pub fn recorder_devices() -> CmdResult<Vec<String>> {
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
}

#[tauri::command]
pub fn recorder_status(state: State<'_, RecorderState>) -> CmdResult<RecorderStatus> {
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

#[tauri::command]
pub fn recorder_start(
    app: AppHandle,
    state: State<'_, RecorderState>,
    device: Option<String>,
) -> CmdResult<()> {
    if state.recording.load(Ordering::Relaxed) {
        return Err("Already recording".into());
    }

    let host = cpal::default_host();
    let dev = match device.as_deref().filter(|s| !s.is_empty()) {
        Some(name) => host
            .input_devices()
            .map_err(es)?
            .find(|d| d.name().map(|n| n == name).unwrap_or(false))
            .ok_or_else(|| format!("Microphone \"{name}\" not found"))?,
        None => host
            .default_input_device()
            .ok_or("No microphone found on this PC")?,
    };
    let cfg = dev.default_input_config().map_err(es)?;
    let (sample_rate, channels) = (cfg.sample_rate().0, cfg.channels());

    let dir = recordings_dir(&app)?;
    let (y, m, d) = civil_from_days(now_ms().div_euclid(86_400_000));
    let secs = now_ms().rem_euclid(86_400_000);
    let (hh, mm, ss) = (secs / 3_600_000, (secs / 60_000) % 60, (secs / 1000) % 60);
    let path = rec_file(
        &dir,
        &format!("rec-{y:04}{m:02}{d:02}-{hh:02}{mm:02}{ss:02}.wav"),
    );

    let file = File::create(&path).map_err(es)?;

    let (tx, rx) = mpsc::channel::<Vec<i16>>();
    let last_error = state.last_error.clone();
    *last_error.lock().unwrap_or_else(|p| p.into_inner()) = None;

    let stream = match cfg.sample_format() {
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
                *last_error.lock().unwrap_or_else(|p| p.into_inner()) = Some(err.to_string());
            },
            None,
        ),
        cpal::SampleFormat::I16 => dev.build_input_stream(
            &cfg.config(),
            move |data: &[i16], _| {
                let _ = tx.send(data.to_vec());
            },
            move |err| {
                *last_error.lock().unwrap_or_else(|p| p.into_inner()) = Some(err.to_string());
            },
            None,
        ),
        cpal::SampleFormat::U16 => dev.build_input_stream(
            &cfg.config(),
            move |data: &[u16], _| {
                let v: Vec<i16> = data.iter().map(|s| (s as i32 - 32_768) as i16).collect();
                let _ = tx.send(v);
            },
            move |err| {
                *last_error.lock().unwrap_or_else(|p| p.into_inner()) = Some(err.to_string());
            },
            None,
        ),
        other => return Err(format!("Unsupported mic sample format: {other}")),
    }
    .map_err(es)?;
    stream.play().map_err(es)?;

    state.recording.store(true, Ordering::Relaxed);
    state.stop_flag.store(false, Ordering::Relaxed);
    state.started_at.store(now_ms(), Ordering::Relaxed);
    *state.current_path.lock().unwrap_or_else(|p| p.into_inner()) = Some(path.clone());

    // the stream must stay alive for as long as we write — move it into the
    // writer thread; dropping it is what stops the capture.
    let stop = state.stop_flag.clone();
    let rec = state.recording.clone();
    let handle = std::thread::spawn(move || {
        let mut file = file;
        let _ = write_wav_header(&mut file, sample_rate, channels);
        let mut total: u64 = 0;
        loop {
            match rx.recv_timeout(Duration::from_millis(150)) {
                Ok(chunk) => {
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
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        let _ = patch_wav_header(&mut file, total);
        drop(stream);
        rec.store(false, Ordering::Relaxed);
    });
    *state.thread.lock().unwrap_or_else(|p| p.into_inner()) = Some(handle);
    Ok(())
}

#[tauri::command]
pub fn recorder_stop(state: State<'_, RecorderState>) -> CmdResult<Option<RecordingInfo>> {
    if !state.recording.load(Ordering::Relaxed) {
        return Ok(None);
    }
    state.stop_flag.store(true, Ordering::Relaxed);
    if let Some(h) = state
        .thread
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take()
    {
        let _ = h.join();
    }
    let path = state
        .current_path
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take();
    let Some(path) = path else { return Ok(None) };
    let meta = std::fs::metadata(&path).map_err(es)?;
    let created_at = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or_else(now_ms);
    Ok(Some(RecordingInfo {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: path.to_string_lossy().into_owned(),
        bytes: meta.len() as i64,
        duration_ms: wav_duration_ms(&path),
        created_at,
    }))
}

#[tauri::command]
pub fn list_recordings(app: AppHandle) -> CmdResult<Vec<RecordingInfo>> {
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
pub fn rename_recording(app: AppHandle, from: String, to: String) -> CmdResult<()> {
    let dir = recordings_dir(&app)?;
    let from = rec_file(&dir, safe_name(&from).ok_or("Invalid file name")?);
    let to = rec_file(&dir, safe_name(&to).ok_or("Invalid new name")?);
    std::fs::rename(from, to).map_err(es)?;
    Ok(())
}

#[tauri::command]
pub fn delete_recording(app: AppHandle, name: String) -> CmdResult<()> {
    let dir = recordings_dir(&app)?;
    let p = rec_file(&dir, safe_name(&name).ok_or("Invalid file name")?);
    std::fs::remove_file(p).map_err(es)?;
    Ok(())
}

#[tauri::command]
pub fn export_recording(app: AppHandle, name: String) -> CmdResult<Option<String>> {
    let dir = recordings_dir(&app)?;
    let src = rec_file(&dir, safe_name(&name).ok_or("Invalid file name")?);
    let path = rfd::FileDialog::new()
        .set_title("Save recording as…")
        .set_file_name(name.as_str())
        .add_filter("WAV audio", &["wav"])
        .save_file();
    match path {
        Some(dest) => {
            std::fs::copy(&src, &dest).map_err(es)?;
            Ok(Some(dest.to_string_lossy().into_owned()))
        }
        None => Ok(None),
    }
}
