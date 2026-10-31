// 1.3.1 screenshot set: onboarding welcome / profile / theme, Settings ▸ Logs, Report a bug,
// Settings ▸ Performance (background CPU limit). Needs the dev servers (:3210 + :4173).
//   node scripts/shots-v131.mjs <outdir>
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
const OUT = process.argv[2] || "shots/v131";
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const report = [];
const errors = [];

async function snap(page, name, wait = 800) {
  await page.waitForTimeout(wait);
  const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight }));
  await page.screenshot({ path: `${OUT}/${name}.png` });
  report.push(`${name}${ov.sw > ov.cw ? `  ⚠ horizontal overflow ${ov.sw}>${ov.cw}` : ""}${ov.sh > ov.ch ? `  ⚠ vertical overflow ${ov.sh}>${ov.ch}` : ""}`);
}

async function open(prefs, scheme = "dark") {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
  await ctx.addInitScript((p) => {
    window.__NOOK_E2E__ = true;
    if (!sessionStorage.getItem("seeded")) {
      localStorage.clear();
      if (p) localStorage.setItem("nook:prefs", JSON.stringify(p));
      sessionStorage.setItem("seeded", "1");
    }
  }, prefs);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:4173/");
  await page.waitForFunction(() => !!window.__nook, null, { timeout: 30_000 });
  return { ctx, page };
}

// onboarding
{
  const { ctx, page } = await open({ theme: "dark", uiStyle: "pixel", v13: true });
  await page.getByTestId("onboarding").waitFor();
  await page.waitForTimeout(2600);
  await snap(page, "onboarding-1-welcome");
  await page.getByTestId("ob-start").click();
  const name = page.getByTestId("profile-name").or(page.getByPlaceholder(/name/i)).first();
  if (await name.count()) await name.fill("Ahmad");
  await snap(page, "onboarding-2-profile", 1200);
  await page.getByTestId("ob-next").click();
  await snap(page, "onboarding-3-theme", 1200);
  await ctx.close();
}

// logs + bug report + performance
{
  const { ctx, page } = await open({ theme: "dark", uiStyle: "pixel", onboarded: true, tourDone: true, v13: true });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    console.info("Nook started");
    console.warn("sync: provider slow (2.3 s)");
    console.error("ai: request failed apiKey=sk-or-v1-FAKEFAKEFAKEFAKEFAKE");
    const s = window.__nook.getState();
    s.set({ settingsSection: "logs" });
    s.setView("settings");
  });
  await page.getByTestId("logs-viewer").waitFor();
  await snap(page, "settings-logs");
  await page.evaluate(() => window.__nook.getState().set({ settingsSection: "about" }));
  await page.getByTestId("about-report-bug").click();
  await page.getByTestId("bug-report").waitFor();
  await page.getByTestId("bug-what").fill("The theme step froze after I picked Light.");
  await page.getByTestId("bug-steps").fill("1. Open Nook\n2. Pick Light on the theme step\n3. Click Next");
  await snap(page, "bug-report");
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__nook.getState().set({ settingsSection: "performance" }));
  await page.getByTestId("perf-settings").waitFor();
  await snap(page, "settings-performance");
  await ctx.close();
}
await browser.close();
console.log(report.join("\n"));
if (errors.length) console.log("PAGE ERRORS:\n" + errors.join("\n"));
