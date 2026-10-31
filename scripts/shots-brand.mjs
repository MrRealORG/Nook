// quick 1.3 brand check: onboarding welcome + sidebar/title bar + About, Pixel dark and light.
//   node scripts/shots-brand.mjs <outdir>
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
const OUT = process.argv[2] || "shots/v13";
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const errors = [];
for (const theme of ["dark", "light"]) {
  for (const onboarded of [false, true]) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
    await ctx.addInitScript((p) => {
      window.__NOOK_E2E__ = true;
      if (!sessionStorage.getItem("s")) { localStorage.clear(); localStorage.setItem("nook:prefs", JSON.stringify(p)); sessionStorage.setItem("s", "1"); }
    }, { theme, uiStyle: "pixel", v13: true, ...(onboarded ? { onboarded: true, tourDone: true } : {}) });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://localhost:4173/");
    await page.waitForFunction(() => !!window.__nook);
    if (!onboarded) {
      await page.getByTestId("onboarding").waitFor();
      await page.waitForTimeout(2800);
      await page.screenshot({ path: `${OUT}/brand-onboarding-welcome-${theme}.png` });
    } else {
      await page.evaluate(() => { const s = window.__nook.getState(); s.setView("notes"); s.openNote(s.notes[0]?.id); });
      await page.waitForTimeout(900);
      await page.screenshot({ path: `${OUT}/brand-sidebar-${theme}.png` });
      await page.screenshot({ path: `${OUT}/brand-titlebar-${theme}.png`, clip: { x: 0, y: 0, width: 520, height: 120 } });
      await page.evaluate(() => { const s = window.__nook.getState(); s.setView("settings"); s.set({ settingsSection: "about" }); });
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${OUT}/brand-about-${theme}.png` });
      const fav = await page.evaluate(() => document.querySelector('link[rel="icon"]')?.getAttribute("href"));
      console.log(theme, "favicon", fav);
    }
    await ctx.close();
  }
}
const w = await (await browser.newContext({ viewport: { width: 300, height: 380 }, deviceScaleFactor: 2 })).newPage();
await w.goto("http://localhost:4173/widget.html");
await w.waitForTimeout(1500);
await w.screenshot({ path: `${OUT}/brand-widget.png` });
await browser.close();
console.log(errors.length ? errors.join("\n") : "no page errors");
