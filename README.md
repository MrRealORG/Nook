# Nook — Tauri + Rust edition

A pixel-art AI notes super app for Windows 10/11. It has notes, graph, canvas, tasks, focus, arcade (13 games), a desktop pet, market, team room, AI agent, an MCP server and a desktop widget. It's built with Tauri v2 and a Rust backend, so there's no bundled Chromium and no Node server at runtime. It uses Windows' built-in WebView2.

## What's new in 1.3

- **New app icon.** A glassy squircle with a soft 3D white kitten peeking over a cloud. The dark version is the exe, taskbar, installer and tray icon. Inside the app, the light or dark version follows your theme for the favicon, the title-bar brand mark, the onboarding welcome, Settings ▸ About Nook and the desktop widget. Only small 128/256 px web copies ship in the bundle; the 1024 px masters live in `branding/`.
- **Pixel is the default again**, in **Pixel light** and **Pixel dark** (following Windows' light/dark mode on a fresh install). If 1.2 moved you to Clean automatically you're moved back; if you picked Clean yourself, it's kept. The **icon style** (colour Pixel sprites or crisp Clean line icons) is now a separate choice from the theme, with a 22-sprite pixel icon set.
- **First-run onboarding.** Seven quick steps on a pixel sky with drifting clouds, with Mochi walking in to talk you through it: welcome · theme + icon style · layout · AI setup · features · your pet · all set. Keyboard friendly (← → Enter, Esc to skip) and re-runnable from Settings. Every animation stops the moment it closes.
- **AI setup cards** for **Google Gemini** (free key), **GLM / Zhipu** (free glm-4-flash, bigmodel.cn or the international z.ai endpoint) and **Ollama** (local, models auto-detected), plus OpenRouter / OpenAI / Groq / LM Studio / any OpenAI-compatible URL. List models and **test the connection** before saving; keys stay in your OS keychain. Or skip it and use the offline brain.
- **Feature switches.** Sixteen features (Tasks, Journal, AI chat, Graph, Canvas, Focus, Timelens, Activity, Rules, Reminders, Pet, Arcade, Marketplace, Team room, Widget, Backups) can be turned off in onboarding or Settings ▸ Features. A switched-off feature disappears from the sidebar and stops its background work.
- **Obsidian layout.** Ribbon · file tree · tabbed editor · right sidebar with backlinks, outline and a local graph. Switch in onboarding, Settings ▸ Appearance or the command palette.
- **Redesigned folder tree.** Nested folders, colours (real swatches in the menu), emoji icons, pinned favourites, counts, inline rename (F2), drag-and-drop for notes and folders, and sorting.
- **Quick switcher (Ctrl+O).** Fuzzy-jump to any note; press Enter on no match to create it.
- **Windows app icons, fixed.** Real icons are pulled from each .exe using five extraction methods (inside a COM scope, with blank-icon detection). Placeholder demo icons no longer block real ones, missing icons are retried every 6 h, there's a **Refresh icons** button in Timelens ▸ Apps, and built-in brand icons fill in until the real one arrives (in the widget too).
- **Fixes.** With "follow system theme" on, a reload no longer resets your saved layout, theme and icon style. Picking a theme that doesn't match the OS mode now keeps it instead of being switched back.
- **Still light on CPU.** Idle views draw 0 animation frames, and the main thread averages about 0.2 % at idle (headless profile, `scripts/idle-cpu.mjs`).

## What's new in 1.2

- **Light on CPU by default.** Nook is built to sit quietly in the background:
  - **Hard CPU cap (Windows):** at startup, before WebView2 starts, Nook puts itself in a Windows Job Object with a hard CPU-rate cap. The WebView2 helper processes inherit the cap, so the whole app tree shares it. The default is **10 %** of the machine, adjustable from 5 % to 50 % (or off) in **Settings → Performance & widget**. Child processes that escape the job are found and added back. Nook also runs at below-normal priority and turns on Windows **EcoQoS** (efficiency mode) while no window is visible.
  - **Low-power mode (on by default):** turns off decorative motion (roaming pet, idle animations, blur, grain). Polling stops while the window is hidden or minimised to the tray, and catches up once when you come back. Idle views draw no animation frames.
  - **Timelens sampler:** samples every 5 s (never faster), backs off to 30 s while you're away, locked or paused, and writes to the database once a minute.
- **Clean theme.** New installs get a clean Light/Dark look that follows Windows, with Segoe UI Variable and crisp line icons. If you were on the old default you're moved to Clean automatically. A customised 1.1 theme is kept, and the pixel themes are still in Settings → Appearance.
- **New sidebar.** It's grouped into Workspace, Create, Productivity and Play, and it collapses to an icon rail with tooltips. It remembers its state. Right-click any item to move it within its group, hide it or change its icon.
- **Timelens, redesigned.** Its tabs are **Dashboard** (total / productive / focused / idle cards and today's timeline), **Timeline** (zoomable day view with hover details, sessions list and day navigation), **Apps** (every app with its real icon taken from the .exe, plus search, sort and exclude; changing a category also re-categorises past time), **Websites** (with favicons), **Analytics**, **Goals**, **Focus** and **Settings / Privacy**.
- **Desktop widget, rebuilt.** It's a small **300×380 card** that collapses to a **200×48 pill** and remembers which one you left it as. Choose its tiles and their order in Settings → Performance & widget: Quick capture, Today's tasks, Timelens today, Focus timer, Mini AI and Pet.

## What's new in 1.1

- **Timelens** — private, local time tracking (see below).
- **Journal**: daily notes on a calendar, templates, `nook://daily` links.
- **Knowledge**: full-text search (SQLite FTS5, `Ctrl+Shift+F`) with folder/tag/date filters, `[[wikilinks]]` with backlinks ("Linked mentions"), version history with restore, Markdown/Obsidian vault import, Markdown/HTML export.
- **AI chat view**: saved conversations, model picker, `@note` context, **Ask my notes** (answers only from your vault, with sources) and the tool-using agent. From the editor, select text and press `Ctrl+Shift+K` (or the ✦ button) to ask your notes about it. Works offline with the built-in brain when no provider is set.
- **Tasks**: Kanban board (drag between To do / Doing / Done), reminders with native notifications, recurring tasks (daily, weekdays, weekly, monthly).
- **Focus**: Pomodoro stats (today, streak, best day, 30-day average); every finished session is also logged to Timelens as focus time.
- **Encrypted backup** (Settings → Backup): ChaCha20-Poly1305 with a PBKDF2 key from your password, manual or daily, with one-click restore.
- **Appearance**: "Follow system light / dark" switches between a chosen light and dark theme with Windows' app mode.
- **Links**: `http(s)` links open in your browser, `[[wikilinks]]` and `nook://note/<id or title>` open notes, `nook://share/<id>` opens the share reader.

## Timelens

Timelens records which app and window is in the foreground (Windows: `GetForegroundWindow` + `QueryFullProcessImageNameW`, sampled every 5 s by default, never faster; 30 s back-off while away) and when you are away (`GetLastInputInfo`, 3 min idle by default; the lock screen counts as away). Everything is stored in the local SQLite vault and never leaves the PC.

- **View** (`Alt+L`): today / 7 days / 30 days, a timeline strip, hourly heatmap, per-app and per-window totals, a productivity score, history and streaks, AI insights, CSV/JSON export.
- **Categories**: productive / neutral / distracting via built-in rules plus your own (Settings → Timelens → Categories).
- **Goals & limits**: e.g. "at least 4 h productive", "at most 60 min distracting"; productive days earn XP and coins for your pet.
- **Privacy**: pause from the tray, widget or Settings; exclude apps/titles; redact window titles; retention (default 90 days), prune and delete-all.
- On Linux an X11 fallback uses `xdotool`/`xprintidle` if installed; macOS has no sampler yet (the view still shows imported/seeded data).

## Get the .exe from GitHub (easiest)

1. Push this folder to a GitHub repo, e.g. `MrRealORG/Nook`:
   ```bash
   git remote add origin https://github.com/MrRealORG/Nook.git
   git push -u origin master --force   # replaces the old Next.js code
   ```
2. **Actions → Build & Release** runs on every push. Open the finished run and download the **Nook-Windows-installers** artifact. It contains `Nook_1.2.0_x64-setup.exe` (NSIS) and an `.msi`.
3. For a public Release with the installer attached, tag a version:
   ```bash
   git tag v1.2.0 && git push origin v1.2.0
   ```
   The workflow builds and publishes **Releases → Nook v1.2.0 → Nook_1.2.0_x64-setup.exe**.

The installer installs per-user, needs no admin, and pulls WebView2 automatically if it's missing.

## Build locally on Windows

Prereqs: [Rust](https://rustup.rs) (stable, MSVC), [Node 22](https://nodejs.org), Visual Studio Build Tools (C++ workload), WebView2 (preinstalled on Win 10/11).

```bash
npm ci
npm run tauri dev      # run with hot reload
npm run tauri build    # installers in src-tauri/target/release/bundle/{nsis,msi}
```

## Checks

```bash
npm run typecheck && npm run lint && npm run build
cargo test -p nook-core --manifest-path src-tauri/Cargo.toml
cargo clippy --workspace --all-targets --manifest-path src-tauri/Cargo.toml -- -D warnings
npm run test:e2e       # Playwright click-through against the real Rust backend
```

## AI

**Settings → AI provider.** Pick from OpenAI, OpenRouter, Groq, Gemini, Ollama, LM Studio or a custom OpenAI-compatible base URL, then paste a key and choose a model. Keys are stored in Windows Credential Manager. With no key, Nook falls back to its built-in offline assistant, so AI buttons always work. The agent has 25 tools: notes, tasks, folders, pet, navigation, web search and more.

## MCP server

When Nook is running it serves MCP at `http://127.0.0.1:3000/mcp`, with 26 tools for notes, tasks, folders and more. You can set a bearer token in **Settings → MCP**, which also has ready-made snippets for Claude Desktop/Code, Cursor, VS Code, Codex and OpenCode.

Stdio (Claude Desktop):
```json
{ "mcpServers": { "nook": { "command": "C:\\Users\\YOU\\AppData\\Local\\Nook\\nook.exe", "args": ["--mcp-stdio"] } } }
```
This works even when the app is closed, because it opens the database directly.

## Desktop widget and comforts

- **Widget**: turn it on in **Settings → Desktop & widget** or from the tray. It's a small transparent window pinned to the desktop, with quick capture (or paste from clipboard), today's tasks, your pet, a Timelens tile with pause, and a mini AI ask. It remembers its position.
- **Hotkeys**: `Ctrl+Alt+N` quick capture, `Ctrl+Alt+H` show/hide Nook.
- Tray icon, single instance, `nook://` links, start with Windows (opt-in), Mica/acrylic window, native notifications, drag-and-drop attachments, native export dialogs.

## Auto-update (optional)

Off by default. To turn it on:
1. Generate a key with `npx tauri signer generate`.
2. Add the repo secrets `NOOK_UPDATER_PUBKEY` (the public key), `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
3. Set `"createUpdaterArtifacts": true` in `src-tauri/tauri.conf.json`.

## Layout

- `src/` React SPA (Vite). `fetch("/api/...")` calls are routed to Rust.
- `src-tauri/core/` Rust core: SQLite, API router, AI client, agent tools, MCP, team room. It has no webview dependency.
- `src-tauri/src/` desktop shell: windows, tray, widget, hotkeys, updater.
- `.github/workflows/build.yml` CI and Windows installers.
