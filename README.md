# Nook 🐸

A cozy little notes desk for your PC — **a real, native desktop app**.

No servers. No accounts. No internet. No loading screens.
Nook is built with **Rust + Tauri 2** and stores everything in a local **SQLite** database on your machine.

![Nook](public/favicon.svg)

## Features

- **Notes** — write in Markdown with live preview, auto-save as you type
- **Pin & favorite** — keep important notes on top
- **Folders** — keep your nook tidy
- **Tasks** — a simple to-do desk with a progress bar
- **Search** — instant search across every note (Ctrl+F)
- **Trash** — deleted notes rest here until you empty it
- **Export** — save any note as a `.md` file
- **Two themes** — Cozy Midnight & Paper Light
- **Instant start** — native window, opens in under a second
- **100% offline** — your notes never leave this PC

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+N` | New note |
| `Ctrl+F` | Search notes |
| `Ctrl+E` | Toggle Markdown preview |
| `Ctrl+S` | Save now |

## Download

Grab the latest installer from the [Releases](../../releases) page.
Run the setup, install, open — that's it. Nothing else is required.

## Build from source

```bash
npm install
npm run tauri build
```

Requires Node.js 18+ and the Rust toolchain. Installers land in
`src-tauri/target/release/bundle/`.

## Tech

- **Rust** (Tauri 2) — window, storage, native dialogs, OS integration
- **SQLite** (rusqlite, bundled) — notes, folders, tasks, settings
- **Vanilla JS + Vite** — a small, fast UI with zero frameworks

## Privacy

Nook is offline-first. The only network-like call it ever makes is opening
a link from a note in your browser, when *you* click it. Everything else —
your notes, tasks, folders — stays in `%APPDATA%\Nook\nook.db`.
