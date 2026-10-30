// Screenshot the main views at common Windows resolutions (+ 125% scaling) against the dev servers.
import { chromium } from "@playwright/test";
const OUT = process.argv[2] || "shots";
const API = "http://127.0.0.1:3210";
await fetch(`${API}/api/timelens/seed`, { method: "POST" }).catch(() => {});
const views = [
  ["notes", `(s) => { s.setView("notes"); s.openNote("n-welcome"); }`],
  ["journal", `(s) => s.setView("calendar")`],
  ["chat", `(s) => s.setView("chat")`],
  ["tasks-kanban", `(s) => s.setView("tasks")`],
  ["focus", `(s) => s.setView("focus")`],
  ["timelens", `(s) => s.setView("timelens")`],
  ["graph", `(s) => s.setView("graph")`],
  ["settings-timelens", `(s) => { s.setView("settings"); s.set({ settingsSection: "timelens" }); }`],
];
const sizes = [
  ["1366x768", { width: 1366, height: 768 }, 1],
  ["1920x1080", { width: 1920, height: 1080 }, 1],
  ["1920x1080@125", { width: 1536, height: 864 }, 1.25],
];
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const report = [];
for (const [tag, viewport, dsf] of sizes) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: dsf });
  await ctx.addInitScript(() => {
    window.__NOOK_E2E__ = true;
    localStorage.setItem("nook:prefs", JSON.stringify({ tourDone: true }));
  });
  const page = await ctx.newPage();
  await page.goto("http://localhost:4173/");
  await page.waitForFunction(() => !!window.__nook, null, { timeout: 30000 });
  for (const [name, fn] of views) {
    await page.evaluate(`(() => { const s = window.__nook.getState(); return (${fn})(s); })()`);
    if (name === "tasks-kanban") await page.getByTestId("kanban-toggle").click().catch(() => {});
    await page.waitForTimeout(1200);
    // layout sanity: horizontal overflow of the document
    const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    if (ov.sw > ov.cw + 1) report.push(`${tag} ${name}: horizontal overflow ${ov.sw}>${ov.cw}`);
    await page.screenshot({ path: `${OUT}/${name}-${tag}.png` });
  }
  const w = await ctx.newPage();
  await w.setViewportSize({ width: 360, height: 560 });
  await w.goto("http://localhost:4173/widget.html");
  await w.waitForTimeout(1500);
  await w.screenshot({ path: `${OUT}/widget-${tag}.png` });
  await ctx.close();
}
await browser.close();
console.log(report.length ? report.join("\n") : "no document-level horizontal overflow");
