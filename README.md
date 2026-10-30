# Nook — Tauri + Rust edition

A pixel-art AI notes super app for Windows 10/11. It has notes, graph, canvas, tasks, focus, arcade (13 games), a desktop pet, market, team room, AI agent, an MCP server and a desktop widget. It's built with Tauri v2 and a Rust backend, so there's no bundled Chromium and no Node server at runtime. It uses Windows' built-in WebView2.

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

Timelens records which app and window is in the foreground (Windows: `GetForegroundWindow` + `QueryFullProcessImageNameW`, sampled every 2 s) and when you are away (`GetLastInputInfo`, 3 min idle by default; the lock screen counts as away). Everything is stored in the local SQLite vault and never leaves the PC.

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
2. **Actions → Build & Release** runs on every push. Open the finished run and download the **Nook-Windows-installers** artifact. It contains `Nook_1.1.0_x64-setup.exe` (NSIS) and an `.msi`.
3. For a public Release with the installer attached, tag a version:
   ```bash
   git tag v1.1.0 && git push origin v1.1.0
   ```
   The workflow builds and publishes **Releases → Nook v1.1.0 → Nook_1.1.0_x64-setup.exe**.

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
