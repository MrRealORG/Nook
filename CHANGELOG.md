# Changelog

## 1.4.0 — Meetings, Timelens websites, Rules Shield

### New
- **Meetings.** Record any call from the new Meetings view, the tray, the widget or
  **Ctrl+Alt+M** anywhere. Nook records two aligned tracks on Windows (WASAPI): your microphone
  ("You") and what you hear through loopback ("Them"), as 16 kHz WAV chunks under the app data
  folder. Live timer, You/Them level meters, pause/resume, stop. After you stop, the meeting is
  transcribed with cloud speech-to-text (Groq / OpenAI-compatible / Gemini, using your AI keys), or
  with the on-device Whisper model when no key is set. The two tracks are merged into one
  speaker-labelled transcript; mic bleed and Whisper's silence hallucinations are dropped. Your AI
  model (or a local Ollama) then writes a summary with key points, decisions, action items
  (owner + due date) and open questions, saved as a `#meeting` note you can open from the view.
  You can copy the transcript, replay either track, rename, re-summarise and delete.
  A small **REC pill** on the desktop widget shows the timer with pause/stop while recording.
  A missing or blocked microphone (or no output device) still records the other side and shows
  a warning. When nothing can be opened you get a plain explanation and how to fix it
  (Windows microphone privacy setting, no device, device busy).
- **Timelens ▸ Websites.** Reads the site from the browser address bar (UI Automation: Chrome,
  Edge, Firefox, Brave, Opera, Vivaldi). Shows time per domain with favicons, the pages under each
  domain and a per-site category picker. Timelens and the widget now update live from tracker
  events (foreground hook) instead of polling.
- **Rules / Shield.** Shield is on by default, with a warning banner, per-app and per-site action
  settings, an opt-in hosts-file mode and live engine status.

### Improved
- **Notes:** one-click delete (context menu and editor) with a 6 s **Undo** toast. Pending deletes
  are flushed on exit.
- **AI:** stronger system prompt (date, vault overview, open-note context) and conversation
  memory within a character budget. Provider errors now show up as a toast and an inline notice
  instead of a silent fallback.

### Fixed
- **Desktop widget crashes (Windows).** Event listeners can no longer race, and the widget
  window is created and destroyed on a deferred, crash-safe path, so a WebView2 is never torn
  down from inside its own call. Position saves are throttled and sane.
- Windows build: UI Automation `VARIANT` needs `Win32_System_Ole` (`cargo test -p nook-core`
  failed on its own without feature unification). `UrlReader` is `Send`.

### Build
- New CI workflow **Windows build (v1.4)**: runs typecheck, `cargo check` (all targets) and
  `cargo test -p nook-core` on Windows, then builds the unsigned NSIS installer as an artifact.

## 1.3.1 — bug-fix release

Fixes for "it gets stuck on the onboarding, crashes, opens the full app first and then the
onboarding", plus working voice input, logs, bug reports, a profile step and auto-updates.

### Fixed
- **Onboarding stutter / freezes / "stuck" / ghost rectangles (Windows).** 1.3.0 put the whole
  Nook process tree — including the WebView2 renderer and GPU processes — in a Job Object with a
  10 % **hard** CPU cap, all the time. The compositor was starved: frames were dropped, stale
  tiles stayed on screen (the grey "ghost" cloud rectangles), animations froze and the window
  could hang. The cap is now **opt-in (off by default)** and, when enabled, applied **only while
  no Nook window is on screen** (hidden to tray / minimised). Foreground work — and onboarding —
  is never capped. The process no longer starts at BELOW_NORMAL priority (it was inherited by the
  renderer). Low idle CPU still comes from the JS idle logic (0 idle rAF, visible-only timers).
- **Desktop showing through the window edge / artifacts.** The Windows window was created with
  `transparent: true`; transparent WebView2 windows composite badly with an animated canvas.
  It is now opaque (`transparent: false`, solid background colour).
- **Full app flashing before the onboarding.** The onboarding flag was read in an effect after
  the app shell had already rendered, and the onboarding chunk was lazy-loaded behind an empty
  Suspense fallback. Now the flag is read synchronously from localStorage *and* mirrored in the
  vault (`/api/ui-state`, delivered with `/api/bootstrap`), the onboarding chunk is fetched in
  parallel with the app chunk, and on a fresh profile only the onboarding is mounted. The window
  starts hidden and is shown by the UI (`app_ready`) after its first decided frame (6 s fallback).
  Background services (market watcher, task/game loads, crash offer, update check) start after
  the first paint and never while the onboarding is up.
- **Stuck on the AI step.** Every request the onboarding/AI setup makes is bounded (4 s for
  config / model listing / Ollama `/api/tags`, 20 s for a test call) with a clear message. Next,
  Back, Skip and Esc never wait on anything.
- **Crashes.** Error boundaries around the onboarding and every view (Try again / Go to notes /
  Skip onboarding / Report a bug). Global error + unhandled-rejection logging from the first line
  of `main.tsx`. Release builds use `panic = "unwind"` (was `abort`, so any panic in a request
  handler killed the app); a panic hook logs it and leaves `last-crash.txt`. The vault open is
  retried (Windows file locks) and a failure shows a native dialog instead of a silent exit.
- Onboarding sky: full `clearRect` every frame, integer positions, 30 fps cap (20 in low-power),
  pauses when hidden, and a **reduced-effects** fallback that turns on by itself when frames take
  more than 50 ms. No `backdrop-filter` in the onboarding; the grain/noise overlays are hidden
  while it is open.

### Voice (Whisper) — now actually works
- transformers.js is a **bundled, lazily loaded local chunk** running in a **Web Worker** (it was
  a runtime import from jsDelivr on the UI thread). The ONNX Runtime WASM ships with the app.
- Default model **Whisper Tiny** (fp32 encoder + q8 decoder — a quantised encoder made accuracy
  poor), WebGPU when available, WASM otherwise. Whisper Base added.
- Correct 16 kHz mono resampling (OfflineAudioContext), download progress on the mic button,
  Retry after a failed download, clear microphone-permission messages.
- Tested in headless Chromium with a real recording (file path *and* a fake microphone).

### Added
- **Profile step first in onboarding**: picture (upload + circular crop with drag/zoom, stored
  locally as 256 px WebP) or a preset Mochi avatar, your name, optional dashboard banner
  (≤ 1600 px WebP). Shown in the title bar, AI chat bubbles and the dashboard greeting; editable
  in Settings ▸ Profile.
- **More fun onboarding**: Mochi hops when you pick a theme, sends a heart when you set your
  picture, thinks on the AI step; typewriter speech bubble; small particle bursts and quips on
  Next; animated layout previews; "Welcome home, <name>!" confetti finale with your picture.
- **Settings ▸ Logs**: live tail of UI + Rust logs, level filter, search, copy, clear, Open log
  folder, verbose toggle (off by default). Logs persist to `%APPDATA%\Nook\logs` (5 × 1 MB).
- **Report a bug** (Settings ▸ About, error screen, command palette, and offered on the launch
  after a crash): opens a prefilled GitHub issue; Save report .txt / Copy for the full logs.
  API keys, tokens and passwords are stripped. **Copy debug info** in Settings ▸ About.
- **Auto-updater** (Tauri updater plugin, signed GitHub Releases): checked 30 s after first paint,
  at most every 6 h, never during onboarding; "Nook X.Y.Z is available" card with notes, Update
  now / Later / Skip this version and a progress bar; "Check for updates" in Settings ▸ About;
  automatic checks on by default. Offline / no release → logged, silent.
- CI: release builds are signed and publish `latest.json`; Linux check installs `libdbus-1-dev`.
