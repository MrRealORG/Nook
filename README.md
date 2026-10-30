# Nook — Tauri + Rust edition

A pixel-art AI notes super app for Windows 10/11. It has notes, graph, canvas, tasks, focus, arcade (13 games), a desktop pet, market, team room, AI agent, an MCP server and a desktop widget. It's built with Tauri v2 and a Rust backend, so there's no bundled Chromium and no Node server at runtime. It uses Windows' built-in WebView2.

## Get the .exe from GitHub (easiest)

1. Push this folder to a GitHub repo, e.g. `MrRealORG/Nook`:
   ```bash
   git remote add origin https://github.com/MrRealORG/Nook.git
   git push -u origin master --force   # replaces the old Next.js code
   ```
2. **Actions → Build & Release** runs on every push. Open the finished run and download the **Nook-Windows-installers** artifact. It contains `Nook_1.0.0_x64-setup.exe` (NSIS) and an `.msi`.
3. For a public Release with the installer attached, tag a version:
   ```bash
   git tag v1.0.0 && git push origin v1.0.0
   ```
   The workflow builds and publishes **Releases → Nook v1.0.0 → Nook_1.0.0_x64-setup.exe**.

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

When Nook is running it serves MCP at `http://127.0.0.1:3000/mcp`, with 16 tools for notes, tasks, folders and more. You can set a bearer token in **Settings → MCP**, which also has ready-made snippets for Claude Desktop/Code, Cursor, VS Code, Codex and OpenCode.

Stdio (Claude Desktop):
```json
{ "mcpServers": { "nook": { "command": "C:\\Users\\YOU\\AppData\\Local\\Nook\\nook.exe", "args": ["--mcp-stdio"] } } }
```
This works even when the app is closed, because it opens the database directly.

## Desktop widget and comforts

- **Widget**: turn it on in **Settings → Desktop & widget** or from the tray. It's a small transparent window pinned to the desktop, with quick capture, today's tasks, your pet and a mini AI ask. It remembers its position.
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
