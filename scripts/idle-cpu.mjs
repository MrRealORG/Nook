// Idle-CPU profiler for the Nook UI (headless Chromium, real Rust backend).
//
// For every main view (and the widget) it lets the page settle, then measures an idle window
// with CDP `Performance.getMetrics` (TaskDuration = main-thread busy time) and counts
// requestAnimationFrame callbacks + timer callbacks fired during the window.
//   main-thread CPU % = ΔTaskDuration / wall time
// It also measures a "hidden" window (document.visibilityState = hidden) for the main app,
// which is what a minimised / tray-hidden Nook does on Windows.
//
//   node scripts/idle-cpu.mjs [--secs 10] [--json out.json] [--max 10]
// Needs the dev servers (nook-dev-api :3210 + vite preview :4173). Exit 1 when any view's
// idle main-thread CPU exceeds --max percent.
import { chromium } from "@playwright/test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

/** utime+stime (clock ticks) of a pid and all its descendants (Linux /proc). Whole-browser CPU:
 *  renderer + GPU/compositor + browser process — the closest thing to Task Manager's number. */
function treeTicks(root) {
  if (!root || process.platform !== "linux") return 0;
  const kids = new Map();
  const ticks = new Map();
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = readFileSync(`/proc/${d}/stat`, "utf8");
      const f = st.slice(st.lastIndexOf(")") + 2).split(" ");
      const ppid = Number(f[1]);
      ticks.set(Number(d), Number(f[11]) + Number(f[12]));
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(Number(d));
    } catch {}
  }
  let sum = 0;
  const stack = [root];
  while (stack.length) {
    const p = stack.pop();
    sum += ticks.get(p) ?? 0;
    for (const k of kids.get(p) ?? []) stack.push(k);
  }
  return sum;
}

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const navigatorCores = (await import("node:os")).cpus().length;
const SECS = Number(arg("--secs", "10"));
const MAX = Number(arg("--max", "10"));
const OUT = arg("--json", "");
const BASE = process.env.NOOK_BASE || "http://localhost:4173";
const PREFS = arg("--prefs", "");

await fetch("http://127.0.0.1:3210/api/timelens/seed", { method: "POST" }).catch(() => {});

const VIEWS = ["notes", "graph", "canvas", "tasks", "den", "focus", "arcade", "team", "market", "activity", "calendar", "timelens", "chat", "settings"];

// instrument rAF + timers before any app code runs
const INSTRUMENT = () => {
  const w = window;
  w.__NOOK_E2E__ = true;
  w.__cpu = { raf: 0, timers: 0 };
  const raf = w.requestAnimationFrame.bind(w);
  w.requestAnimationFrame = (cb) => raf((t) => { w.__cpu.raf++; cb(t); });
  const si = w.setInterval.bind(w);
  w.setInterval = (cb, ms, ...a) => si((...x) => { w.__cpu.timers++; typeof cb === "function" && cb(...x); }, ms, ...a);
  const st = w.setTimeout.bind(w);
  w.setTimeout = (cb, ms, ...a) => st((...x) => { w.__cpu.timers++; typeof cb === "function" && cb(...x); }, ms, ...a);
};

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  // keep timers honest: headless otherwise never throttles background pages either way
  args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
});
const BROWSER_PID = browser.process?.()?.pid ?? 0;
const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
await ctx.addInitScript(INSTRUMENT);
await ctx.addInitScript((prefs) => {
  if (!localStorage.getItem("nook:prefs")) localStorage.setItem("nook:prefs", prefs || JSON.stringify({ tourDone: true }));
}, PREFS);

async function measure(page, label) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable", { timeDomain: "threadTicks" }).catch(() => cdp.send("Performance.enable"));
  const metric = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  const c0 = await page.evaluate(() => ({ ...window.__cpu }));
  const p0 = treeTicks(BROWSER_PID);
  const m0 = await metric();
  const t0 = Date.now();
  await page.waitForTimeout(SECS * 1000);
  const m1 = await metric();
  const c1 = await page.evaluate(() => ({ ...window.__cpu }));
  const p1 = treeTicks(BROWSER_PID);
  const wall = (Date.now() - t0) / 1000;
  await cdp.detach();
  const d = (k) => (m1[k] ?? 0) - (m0[k] ?? 0);
  return {
    view: label,
    cpuPct: +((d("TaskDuration") / wall) * 100).toFixed(2),
    // all Chromium processes (renderer+GPU+browser), % of ONE core
    procPct: +((((p1 - p0) / 100) / wall) * 100).toFixed(2),
    scriptMs: +(d("ScriptDuration") * 1000).toFixed(1),
    layoutMs: +(d("LayoutDuration") * 1000).toFixed(1),
    styleMs: +(d("RecalcStyleDuration") * 1000).toFixed(1),
    layouts: d("LayoutCount"),
    styleRecalcs: d("RecalcStyleCount"),
    rafPerSec: +((c1.raf - c0.raf) / wall).toFixed(1),
    timersPerSec: +((c1.timers - c0.timers) / wall).toFixed(2),
  };
}

const rows = [];
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.goto(BASE + "/");
await page.waitForFunction(() => !!window.__nook, null, { timeout: 30000 });
await page.waitForTimeout(2500);
for (const v of VIEWS) {
  await page.evaluate((v) => window.__nook.getState().setView(v), v);
  await page.waitForTimeout(2500); // let entry animations + lazy chunks finish
  rows.push(await measure(page, v));
}
// hidden window (minimised / closed-to-tray): fake visibility = hidden
await page.evaluate(() => window.__nook.getState().setView("notes"));
await page.waitForTimeout(1500);
await page.evaluate(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
  document.dispatchEvent(new Event("visibilitychange"));
});
await page.waitForTimeout(1500);
rows.push(await measure(page, "notes (hidden)"));

const w = await ctx.newPage();
await w.setViewportSize({ width: 320, height: 400 });
await w.goto(BASE + "/widget.html");
await w.waitForTimeout(3000);
rows.push(await measure(w, "widget"));
await browser.close();

console.table(rows);
const worst = rows.reduce((a, r) => (r.cpuPct > a.cpuPct ? r : a), rows[0]);
const avg = rows.reduce((a, r) => a + r.cpuPct, 0) / rows.length;
const avgProc = rows.reduce((a, r) => a + r.procPct, 0) / rows.length;
const worstProc = rows.reduce((a, r) => (r.procPct > a.procPct ? r : a), rows[0]);
console.log(`idle main-thread CPU: avg ${avg.toFixed(2)}%  worst ${worst.cpuPct}% (${worst.view})  window ${SECS}s/view`);
console.log(`idle whole-browser CPU (one core): avg ${avgProc.toFixed(2)}%  worst ${worstProc.procPct}% (${worstProc.view})  [${navigatorCores} cores]`);
if (OUT) writeFileSync(OUT, JSON.stringify({ secs: SECS, rows, avg, worst, avgProc, worstProc }, null, 2));
process.exit(worst.cpuPct > MAX ? 1 : 0);
