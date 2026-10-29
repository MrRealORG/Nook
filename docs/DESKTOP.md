# Nook Desktop — Tauri + Rust shell

Nook is now a real desktop app. The web app (Next.js + Prisma + SQLite) is
unchanged; a Rust shell (Tauri v2) wraps it:

- spawns the Next.js **standalone server** on a free `localhost` port,
- points a native webview at it (**WebView2 on Windows** — preinstalled on
  Windows 10/11),
- points Prisma's `DATABASE_URL` at `%LOCALAPPDATA%\Nook\custom.db`, seeding
  the vault (notes, pet Mochi, folders, marketplace) on first run,
- single instance, tray icon, minimize-to-tray, auto-start (Windows Run key),
  window size/maximized state saved across launches, Ctrl+Q to quit.

## Repo layout (new)

```
src-tauri/
  Cargo.toml          Rust crate + deps (tauri 2, tauri-plugin-log, serde, url)
  src/main.rs         shell entry: server spawn, tray, single instance, commands
  tauri.conf.json     app identity, CSP, MSI/NSIS package config
  icons/              icon.png (tray), icon.ico (Windows taskbar/MSI), sizes
  resources/db/custom.db  seed SQLite vault (copied to %LOCALAPPDATA% on first run)
src/lib/tauri.ts      frontend bridge (window.__TAURI__ — no extra npm dep)
docs/DESKTOP.md       this file
```

## Build on Windows

### Prerequisites

1. **Node.js LTS** (the embedded server runs on `node`). `node` must be on
   `PATH` — the installer target machine needs this too.
2. **Rust toolchain** — https://rustup.rs (rustup + cargo). The sandbox that
   produced this scaffold has no `crates.io` access, so `cargo tauri build`
   must run on your Windows machine with internet.
3. Tauri CLI: `cargo install cargo-tauri` (needs crates.io).

### One-time setup

```powershell
cd /path/to/Nook
npm install          # node_modules + @prisma client (win32 query engine)
npm run dev          # sanity check: http://localhost:3000
```

### Dev mode (desktop window + hot reload)

```powershell
cargo tauri dev
```

This runs `npm run dev` (`beforeDevCommand`) and opens the webview at
`http://localhost:3000`.

### Release installer

```powershell
cargo tauri build
```

Output: `src-tauri/target/release/bundle/msi/Nook-0.2.1.msi` (and/or
`nsis/Nook-0.2.1-setup.exe` depending on targets installed).

### What ships next to `Nook.exe`

The Rust shell runs `node .next/standalone/server.js` from the install
directory, so after building, place this next to `Nook.exe` (the MSI/NSIS
`File` entries in `src-tauri/tauri.conf.json` can be extended to bundle them
automatically):

```
Nook.exe
.next/standalone/   (from npm run build)
.next/server/
.next/static/
public/
node_modules/       (production install: npm install --omit=dev)
```

`src-tauri/src/main.rs::install_dir()` resolves the directory next to the exe
first, then the bundle resource dir, so the server starts regardless of exact
layout as long as `.next/standalone/server.js` is reachable.

The seed DB (`resources/db/custom.db`) is copied into `%LOCALAPPDATA%\Nook\`
on first launch; user notes and pet state live there thereafter. Logs:
`%LOCALAPPDATA%\Nook\server.log`.

## Desktop behavior (Windows)

| Interaction | Behavior |
|---|---|
| First launch | Seeds `%LOCALAPPDATA%\Nook\custom.db`, opens WebView2 window |
| Second launch | Brings the existing window forward (single instance) |
| Minimize (default) | Windows taskbar |
| Minimize with "Minimize to tray" on | Hides to notification area; click tray icon to restore |
| [X] / Ctrl+Q | Quits Nook and stops the embedded server |
| External links (https) | Open in default browser |
| Window size/maximize | Remembered across launches |

## Caveats / to verify before shipping

- This scaffold was written for **Tauri v2** but could not be compiled in
  this environment (no Rust toolchain, no `crates.io` access). Run
  `cargo check` / `cargo tauri build` on Windows and adjust any v2 API names
  if needed (`WebviewWindowBuilder`, `SystemTrayBuilder`, `WindowUrl::External`
  are the surface used).
- `tauri.conf.json` has `"windows": []` because the main window is created
  in `src/main.rs` (needed to bind a dynamic localhost port). If
  `cargo tauri dev` expects a window entry, add one to `tauri.windows` with
  `"url": "http://localhost:3000"`.
- The CSP in `tauri.conf.json` is intentionally permissive (localhost dev
  server). Tighten it before public release.
- `sharp` and other optional native deps resolve from `node_modules` next to
  the exe — ship a production `node_modules` generated on Windows.
