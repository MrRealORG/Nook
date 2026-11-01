//! Windows audio capture for the meeting recorder: WASAPI shared-mode capture of the default
//! microphone ("You") and loopback capture of the default speakers ("Them").
//!
//! Each source is created on the recorder thread (COM is initialised there, MTA) and polled every
//! 100 ms — no extra threads, no event handles. Whatever the mix format is (usually 48 kHz float
//! stereo) it is downmixed and box-resampled to 16 kHz mono by `super::Resampler`.

use super::{downmix, AudioBackend, AudioSource, Resampler, Track};
use windows::Win32::Media::Audio::{
    eCapture, eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_LOOPBACK, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED};

pub struct WasapiBackend;

const WAVE_FORMAT_PCM: u16 = 1;
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;
/// E_ACCESSDENIED — Windows privacy settings block microphone access for desktop apps
const E_ACCESSDENIED: i32 = 0x8007_0005u32 as i32;
/// AUDCLNT_E_DEVICE_INVALIDATED — device unplugged / default device changed
const AUDCLNT_E_DEVICE_INVALIDATED: i32 = 0x8889_0004u32 as i32;
/// E_NOTFOUND / ERROR_NOT_FOUND — there is no default endpoint of that kind
const E_NOTFOUND: i32 = 0x8007_0490u32 as i32;

#[derive(Clone, Copy, PartialEq)]
enum Sample {
    F32,
    I16,
    I32,
}

pub struct WasapiSource {
    client: IAudioClient,
    capture: IAudioCaptureClient,
    channels: usize,
    block_align: usize,
    fmt: Sample,
    rs: Resampler,
    name: String,
    scratch: Vec<f32>,
    mono: Vec<f32>,
}

fn explain(track: Track, e: &windows::core::Error) -> String {
    let code = e.code().0;
    match (track, code) {
        (Track::You, E_ACCESSDENIED) => "access denied — allow microphone access for desktop apps in Windows Settings → Privacy & security → Microphone.".into(),
        (Track::You, E_NOTFOUND) => "no microphone found — plug one in or pick a default input device in Sound settings.".into(),
        (Track::Them, E_NOTFOUND) => "no playback device found — the other side can't be captured.".into(),
        (_, AUDCLNT_E_DEVICE_INVALIDATED) => "the audio device was unplugged or changed.".into(),
        _ => format!("{} (0x{:08X})", e.message(), code as u32),
    }
}

impl AudioBackend for WasapiBackend {
    fn open(&self, track: Track) -> Result<Box<dyn AudioSource>, String> {
        // SAFETY: COM is initialised on this (the recorder) thread before any COM call; every
        // interface is used only on this thread; the mix-format pointer is freed with
        // CoTaskMemFree after it was copied/used by Initialize.
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| explain(track, &e))?;
            let flow = if track == Track::You { eCapture } else { eRender };
            let dev: IMMDevice = en.GetDefaultAudioEndpoint(flow, eConsole).map_err(|e| explain(track, &e))?;
            let client: IAudioClient = dev.Activate(CLSCTX_ALL, None).map_err(|e| explain(track, &e))?;
            let pwfx = client.GetMixFormat().map_err(|e| explain(track, &e))?;
            if pwfx.is_null() {
                return Err("the device reported no audio format".into());
            }
            let wf: WAVEFORMATEX = *pwfx;
            // copy the packed fields out before use (no references into a packed struct)
            let (tag, bits, rate, chans, align) = (wf.wFormatTag, wf.wBitsPerSample, wf.nSamplesPerSec, wf.nChannels, wf.nBlockAlign);
            let sub = if tag == WAVE_FORMAT_EXTENSIBLE {
                let ext = *(pwfx as *const WAVEFORMATEXTENSIBLE);
                // KSDATAFORMAT_SUBTYPE_PCM / _IEEE_FLOAT share the layout {0000000X-0000-0010-8000-00aa00389b71}
                ext.SubFormat.data1 as u16
            } else {
                tag
            };
            let fmt = match (sub, bits) {
                (WAVE_FORMAT_IEEE_FLOAT, 32) => Sample::F32,
                (WAVE_FORMAT_PCM, 16) => Sample::I16,
                (WAVE_FORMAT_PCM, 32) => Sample::I32,
                _ => {
                    CoTaskMemFree(Some(pwfx as *const _));
                    return Err(format!("unsupported device format (tag {sub}, {bits}-bit)"));
                }
            };
            let flags = if track == Track::Them { AUDCLNT_STREAMFLAGS_LOOPBACK } else { 0 };
            // 1 s shared buffer: we poll every 100 ms, so there's plenty of headroom
            let r = client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 10_000_000, 0, pwfx, None);
            CoTaskMemFree(Some(pwfx as *const _));
            r.map_err(|e| explain(track, &e))?;
            let capture: IAudioCaptureClient = client.GetService().map_err(|e| explain(track, &e))?;
            client.Start().map_err(|e| explain(track, &e))?;
            let name = format!("{} ({} Hz, {} ch)", if track == Track::You { "Default microphone" } else { "Speakers (loopback)" }, rate, chans);
            Ok(Box::new(WasapiSource {
                client,
                capture,
                channels: chans.max(1) as usize,
                block_align: align.max(1) as usize,
                fmt,
                rs: Resampler::new(rate),
                name,
                scratch: Vec::with_capacity(48_000),
                mono: Vec::with_capacity(48_000),
            }))
        }
    }
}

impl AudioSource for WasapiSource {
    fn read(&mut self, out: &mut Vec<f32>) -> Result<(), String> {
        self.scratch.clear();
        // SAFETY: GetBuffer/ReleaseBuffer are paired; `data` is valid for `frames * block_align`
        // bytes until ReleaseBuffer, and is only read inside that window.
        unsafe {
            loop {
                let packet = self.capture.GetNextPacketSize().map_err(|e| explain(Track::Them, &e))?;
                if packet == 0 {
                    break;
                }
                let mut data: *mut u8 = std::ptr::null_mut();
                let mut frames: u32 = 0;
                let mut flags: u32 = 0;
                self.capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None).map_err(|e| explain(Track::Them, &e))?;
                let n = frames as usize * self.channels;
                if flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data.is_null() {
                    self.scratch.resize(self.scratch.len() + n, 0.0);
                } else {
                    let bytes = std::slice::from_raw_parts(data, frames as usize * self.block_align);
                    match self.fmt {
                        Sample::F32 => self.scratch.extend(bytes.chunks_exact(4).take(n).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))),
                        Sample::I16 => self.scratch.extend(bytes.chunks_exact(2).take(n).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)),
                        Sample::I32 => self.scratch.extend(bytes.chunks_exact(4).take(n).map(|b| i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32 / 2_147_483_648.0)),
                    }
                }
                self.capture.ReleaseBuffer(frames).map_err(|e| explain(Track::Them, &e))?;
            }
        }
        self.mono.clear();
        downmix(&self.scratch, self.channels, &mut self.mono);
        self.rs.push(&self.mono, out);
        Ok(())
    }
    fn name(&self) -> String {
        self.name.clone()
    }
}

impl Drop for WasapiSource {
    fn drop(&mut self) {
        // SAFETY: stopping a started client on its own thread.
        unsafe {
            let _ = self.client.Stop();
        }
    }
}
