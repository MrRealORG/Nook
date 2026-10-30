// Visual audit: screenshots of every view/dialog at several sizes + console capture.
// usage: node scripts/shots.mjs <outDir> [baseUrl] [sizes=1366x768,1920x1080,1024x700] [dpr=1]
import { chromium } from "@playwright/test";
import fs from "node:fs";

const out = process.argv[2] ?? "/tmp/shots";
const base = process.argv[3] ?? "http://localhost:4173";
const sizes = (process.argv[4] ?? "1366x768,1920x1080,1024x700").split(",").map((s) => s.split("x").map(Number));
const dpr = Number(process.argv[5] ?? 1);
const only = process.env.ONLY ? process.env.ONLY.split(",") : null;
fs.mkdirSync(out, { recursive: true });

const VIEWS = ["notes", "graph", "canvas", "tasks", "den", "focus", "arcade", "team", "market", "activity", "rules", "settings", "calendar", "kanban", "timelens", "chat"];
const SETTINGS = ["account","look","packs","sidebar","features","mcp","desktop","sound","voice","notif","pet","ai","data","keys","timelens","backup"];
const log = [];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
for (const [w, h] of sizes) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  let cur = "boot";
  page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && log.push(`[${w}x${h}] ${cur} ${m.type()}: ${m.text().slice(0, 300)}`));
  page.on("pageerror", (e) => log.push(`[${w}x${h}] ${cur} pageerror: ${e}`));
  await page.addInitScript(() => {
    window.__NOOK_E2E__ = true;
    if (!localStorage.getItem("nook:prefs")) localStorage.setItem("nook:prefs", JSON.stringify({ tourDone: true }));
  });
  await page.goto(base + "/");
  await page.waitForFunction(() => !!window.__nook, null, { timeout: 30000 });
  await page.waitForTimeout(800);
  const snap = async (name) => {
    if (only && !only.some((o) => name.startsWith(o))) return;
    await page.screenshot({ path: `${out}/${name}-${w}x${h}.png`, timeout: 15000 }).catch((e) => log.push(`snap ${name} failed ${e}`));
  };
  const st = (fn) => page.evaluate(`(() => { const s = window.__nook.getState(); return (${fn})(s); })()`);
  for (const v of VIEWS) {
    cur = v;
    const ok = await st(`(s) => { try { s.setView(${JSON.stringify(v)}); return true } catch { return false } }`);
    if (!ok) continue;
    await page.waitForTimeout(900);
    if (v === "notes") await st(`(s) => s.openNote && s.openNote("n-welcome")`);
    await page.waitForTimeout(300);
    await snap(`view-${v}`);
    if (v === "arcade" && w === 1366) {
      const cards = await page.locator(".game-card").count();
      for (let i = 0; i < cards; i++) {
        await page.locator(".game-card").nth(i).click();
        await page.waitForTimeout(300);
        await page.getByRole("button", { name: /Start/ }).first().click().catch(() => {});
        await page.waitForTimeout(500);
        await snap(`game-${i}`);
        await page.getByRole("button", { name: /All games/ }).click().catch(() => {});
        await page.waitForTimeout(200);
      }
    }
  }
  cur = "settings";
  await st(`(s) => s.setView("settings")`);
  for (const sec of SETTINGS) {
    await st(`(s) => s.set({ settingsSection: ${JSON.stringify(sec)} })`);
    await page.waitForTimeout(400);
    await snap(`settings-${sec}`);
  }
  await st(`(s) => s.setView("notes")`);
  await page.waitForTimeout(300);
  cur = "palette";
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(300);
  await snap("dlg-palette");
  await page.keyboard.press("Escape");
  cur = "help";
  await st(`(s) => s.set({ help: true })`);
  await page.waitForTimeout(300);
  await snap("dlg-help");
  await st(`(s) => s.set({ help: false })`);
  cur = "share";
  await page.locator('button[title="More note actions"]').first().click().catch(() => {});
  await page.getByRole("button", { name: /Share…/ }).first().click().catch(() => {});
  await page.waitForTimeout(400);
  await snap("dlg-share");
  await page.keyboard.press("Escape");
  cur = "notif";
  await st(`(s) => s.set({ noticeOpen: true })`);
  await page.waitForTimeout(300);
  await snap("dlg-notif");
  await st(`(s) => s.set({ noticeOpen: false })`);
  cur = "ctx";
  await page.locator("[data-note-id]").first().click({ button: "right" }).catch(() => {});
  await page.waitForTimeout(300);
  await snap("dlg-context");
  await page.keyboard.press("Escape");
  cur = "ai";
  await st(`(s) => s.set({ rightTab: "ai", rightOpen: true })`);
  await page.waitForTimeout(400);
  await snap("panel-ai");
  cur = "tour";
  await st(`(s) => s.set({ tourDone: false, tourOpen: true })`);
  await page.waitForTimeout(500);
  await snap("dlg-tour");
  await ctx.close();
}
// widget at its real size
for (const [w, h] of [[340, 560]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && log.push(`[widget] ${m.type()}: ${m.text().slice(0, 300)}`));
  page.on("pageerror", (e) => log.push(`[widget] pageerror: ${e}`));
  await page.goto(base + "/widget.html");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/widget-${w}x${h}.png` });
  await ctx.close();
}
await browser.close();
fs.writeFileSync(`${out}/console.log`, log.join("\n"));
console.log(`done: ${log.length} console lines`);
