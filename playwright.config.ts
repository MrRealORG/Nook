import { defineConfig } from "@playwright/test";

/**
 * Headless E2E of the SPA against the REAL Rust backend (`nook-dev-api` serves the same
 * router the desktop app invokes), so every click goes UI → API layer → Rust → SQLite.
 *   npm run build && npm run test:e2e
 * Set CHROMIUM_PATH to use a system Chromium (e.g. on arm64 Linux).
 */
const api = process.env.NOOK_DEV_API_BIN
  ? `${process.env.NOOK_DEV_API_BIN} --port 3210`
  : "cargo run --quiet --manifest-path src-tauri/Cargo.toml -p nook-core --bin nook-dev-api -- --port 3210";

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:4173",
    viewport: { width: 1440, height: 900 },
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
    trace: "retain-on-failure",
  },
  webServer: [
    { command: api, url: "http://127.0.0.1:3210/api/health", reuseExistingServer: true, timeout: 300_000 },
    { command: "npx vite preview --port 4173 --strictPort", url: "http://localhost:4173", reuseExistingServer: true, timeout: 60_000 },
  ],
});
