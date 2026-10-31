// 1.2 screenshot set: notes, sidebar expanded/collapsed, every Timelens tab, Performance & widget
// and Desktop settings, in Clean light and Clean dark, at 1366×768, 1920×1080 and 1920×1080 @125 %,
// plus the widget card and pill. Needs the dev servers (nook-dev-api :3210 + vite preview :4173).
//   node scripts/shots-v12.mjs <outdir>
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
const OUT = process.argv[2] || "shots/v12";
mkdirSync(OUT, { recursive: true });
const API = "http://127.0.0.1:3210";
await fetch(`${API}/api/timelens/seed`, { method: "POST" }).catch(() => {});

const TL_TABS = ["dashboard", "timeline", "apps", "websites", "analytics", "goals", "focus", "settings"];
const sizes = [
  ["1366x768", { width: 1366, height: 768 }, 1],
  ["1920x1080", { width: 1920, height: 1080 }, 1],
  ["1920x1080@125", { width: 1536, height: 864 }, 1.25],
];
const run = (page, fn) => page.evaluate(`(() => { const s = window.__nook.getState(); return (${fn})(s); })()`);
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const report = [];
const errors = [];

async function snap(page, name) {
  await page.waitForTimeout(700);
  const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  await page.screenshot({ path: `${OUT}/${name}.png` });
  report.push(`${name}${ov.sw > ov.cw ? `  ⚠ horizontal overflow ${ov.sw}>${ov.cw}` : ""}`);
}

for (const scheme of ["light", "dark"]) {
  for (const [tag, viewport, dsf] of sizes) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: dsf, colorScheme: scheme });
    await ctx.addInitScript(() => {
      window.__NOOK_E2E__ = true;
      if (!sessionStorage.getItem("seeded")) {
        localStorage.setItem("nook:prefs", JSON.stringify({ tourDone: true }));
        sessionStorage.setItem("seeded", "1");
      }
    });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`${tag} ${scheme}: ${e.message}`));
    await page.goto("http://localhost:4173/");
    await page.waitForFunction(() => !!window.__nook, null, { timeout: 30_000 });
    await run(page, `(s) => { s.setView("notes"); s.openNote("n-welcome"); }`);
    await snap(page, `notes-${scheme}-${tag}`);
    if (scheme === "light") {
      await page.getByTestId("sidebar-collapse").click();
      await snap(page, `sidebar-collapsed-${scheme}-${tag}`);
      await page.getByTestId("sidebar-collapse").click();
    }
    await run(page, `(s) => s.setView("timelens")`);
    for (const t of scheme === "light" ? TL_TABS : ["dashboard", "apps"]) {
      await page.getByTestId(`tl-tab-${t}`).click();
      await snap(page, `timelens-${t}-${scheme}-${tag}`);
    }
    await run(page, `(s) => { s.setView("settings"); s.set({ settingsSection: "performance" }); }`);
    await snap(page, `settings-performance-${scheme}-${tag}`);
    if (scheme === "light") {
      await run(page, `(s) => { s.set({ settingsSection: "desktop" }); }`);
      await snap(page, `settings-desktop-${scheme}-${tag}`);
    }
    await ctx.close();
  }
  // the widget window is a fixed-size transparent card / pill
  const ctx = await browser.newContext({ viewport: { width: 300, height: 380 }, deviceScaleFactor: 2, colorScheme: scheme });
  const w = await ctx.newPage();
  w.on("pageerror", (e) => errors.push(`widget ${scheme}: ${e.message}`));
  await w.goto("http://localhost:4173/widget.html");
  await w.waitForTimeout(1500);
  await w.screenshot({ path: `${OUT}/widget-card-${scheme}.png` });
  report.push(`widget-card-${scheme}`);
  await w.getByTestId("widget-collapse").click();
  await w.setViewportSize({ width: 200, height: 48 });
  await w.waitForTimeout(400);
  await w.screenshot({ path: `${OUT}/widget-pill-${scheme}.png` });
  report.push(`widget-pill-${scheme}`);
  await ctx.close();
}
await browser.close();
console.log(report.join("\n"));
console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no page errors");
