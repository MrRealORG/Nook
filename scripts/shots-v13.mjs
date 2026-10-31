// 1.3 screenshot set: every onboarding step (Pixel dark + light), Pixel dark/light notes + sidebar,
// Obsidian layout, folder tree (nested, coloured), quick switcher, Timelens Apps, Settings ▸ AI /
// Features. Needs the dev servers (nook-dev-api :3210 + vite preview :4173).
//   node scripts/shots-v13.mjs <outdir> [filter]
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
const OUT = process.argv[2] || "shots/v13";
const FILTER = process.argv[3] || "";
mkdirSync(OUT, { recursive: true });
const API = "http://127.0.0.1:3210";
await fetch(`${API}/api/timelens/seed`, { method: "POST" }).catch(() => {});

const run = (page, fn) => page.evaluate(`(() => { const s = window.__nook.getState(); return (${fn})(s); })()`);
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const report = [];
const errors = [];
const want = (name) => !FILTER || name.includes(FILTER);

async function snap(page, name, wait = 700) {
  if (!want(name)) return;
  await page.waitForTimeout(wait);
  const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight }));
  await page.screenshot({ path: `${OUT}/${name}.png` });
  report.push(`${name}${ov.sw > ov.cw ? `  ⚠ horizontal overflow ${ov.sw}>${ov.cw}` : ""}${ov.sh > ov.ch ? `  ⚠ vertical overflow ${ov.sh}>${ov.ch}` : ""}`);
}

async function open(prefs, { viewport = { width: 1440, height: 900 }, scheme = "dark" } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme });
  await ctx.addInitScript((p) => {
    window.__NOOK_E2E__ = true;
    if (!sessionStorage.getItem("seeded")) {
      localStorage.clear();
      localStorage.setItem("nook:prefs", JSON.stringify(p));
      sessionStorage.setItem("seeded", "1");
    }
  }, prefs);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${e.message}`));
  await page.goto("http://localhost:4173/");
  await page.waitForFunction(() => !!window.__nook, null, { timeout: 30_000 });
  return { ctx, page };
}

const STEPS = ["welcome", "theme", "layout", "ai", "features", "pet", "done"];

// ---------------------------------------------------------------- onboarding, both schemes
for (const [theme, label] of [["dark", "dark"], ["light", "light"]]) {
  for (const [vtag, viewport] of [["1440", { width: 1440, height: 900 }], ["1366", { width: 1366, height: 768 }]]) {
    if (vtag === "1366" && theme === "light") continue;
    const { ctx, page } = await open({ theme, uiStyle: "pixel", v13: true }, { viewport });
    await page.getByTestId("onboarding").waitFor();
    await page.waitForTimeout(2600); // Mochi walks in
    for (let k = 0; k < STEPS.length; k++) {
      await snap(page, `onboarding-${k + 1}-${STEPS[k]}-pixel-${label}${vtag === "1366" ? "-1366" : ""}`, 900);
      if (k === 3 && want("onboarding-ai-gemini") && vtag === "1440") {
        await page.getByTestId("ai-card-gemini").click();
        await snap(page, `onboarding-ai-gemini-pixel-${label}`);
      }
      if (k < STEPS.length - 1) await (k === 0 ? page.getByTestId("ob-start") : page.getByTestId("ob-next")).click();
    }
    await ctx.close();
  }
}

// ---------------------------------------------------------------- main app, Pixel dark/light
for (const theme of ["dark", "light"]) {
  const { ctx, page } = await open({ theme, uiStyle: "pixel", onboarded: true, tourDone: true, v13: true }, { scheme: theme });
  // a small nested, coloured tree for the folder shots
  await run(
    page,
    `(s) => {
      if (s.folders.some((f) => f.name === "Website redesign")) return;
      const p = s.folders.find((f) => f.name === "Projects")?.id ?? s.createFolder("Projects");
      const w = s.createFolder("Website redesign", p);
      s.createFolder("Ideas");
      const r = s.createFolder("Reading list");
      s.updateFolder(r, { color: "#f27ba0" });
      const n = s.notes.slice(0, 3);
      if (n[0]) s.updateNote(n[0].id, { folderId: w });
      if (n[1]) s.updateNote(n[1].id, { folderId: p });
    }`,
  );
  await run(page, `(s) => { s.setView("notes"); s.openNote(s.notes[0]?.id); }`);
  await page.waitForTimeout(300);
  for (const name of ["Projects", "Website redesign"]) {
    const row = page.locator(`[data-testid="ft-folder"][data-name="${name}"]`);
    if ((await row.count()) && (await row.getAttribute("aria-expanded")) !== "true") await row.click();
  }
  await snap(page, `notes-pixel-${theme}`);
  if (want(`folder-tree-pixel-${theme}`)) {
    await page.waitForTimeout(500);
    await page.getByTestId("folder-tree").screenshot({ path: `${OUT}/folder-tree-pixel-${theme}.png` });
    report.push(`folder-tree-pixel-${theme}`);
  }
  if (want(`sidebar-pixel-${theme}`)) {
    await page.getByTestId("sidebar").screenshot({ path: `${OUT}/sidebar-pixel-${theme}.png` });
    report.push(`sidebar-pixel-${theme}`);
  }
  if (theme === "dark") {
    // folder context menu (colour submenu)
    await page.locator(`[data-testid="ft-folder"][data-name="Ideas"]`).click({ button: "right" });
    await page.waitForTimeout(300);
    const colour = page.getByRole("menuitem", { name: /Colour/ }).or(page.getByText("Colour", { exact: true })).first();
    if (await colour.count()) await colour.hover();
    await snap(page, `folder-menu-pixel-${theme}`);
    await page.keyboard.press("Escape");
    await page.mouse.click(700, 450);
  }
  // quick switcher
  await page.keyboard.press("Control+o");
  await page.getByTestId("quick-switcher").waitFor();
  await page.keyboard.type("we");
  await snap(page, `quick-switcher-pixel-${theme}`);
  await page.keyboard.press("Escape");
  // timelens apps
  await run(page, `(s) => s.setView("timelens")`);
  await page.getByTestId("tl-tab-apps").click();
  await snap(page, `timelens-apps-pixel-${theme}`, 1200);
  // settings
  await run(page, `(s) => { s.setView("settings"); s.set({ settingsSection: "ai" }); }`);
  await snap(page, `settings-ai-pixel-${theme}`);
  await run(page, `(s) => { s.set({ settingsSection: "features" }); }`);
  await snap(page, `settings-features-pixel-${theme}`);
  await run(page, `(s) => { s.set({ settingsSection: "look" }); }`);
  await snap(page, `settings-look-pixel-${theme}`);
  // obsidian layout
  await run(page, `(s) => { s.setLayout("obsidian"); s.setView("notes"); s.openNote(s.notes[0]?.id); }`);
  await snap(page, `obsidian-layout-pixel-${theme}`, 1000);
  if (theme === "dark") {
    for (const t of ["outline", "graph"]) {
      const tab = page.getByTestId(`obs-tab-${t}`);
      if (await tab.count()) {
        await tab.click();
        await snap(page, `obsidian-${t}-pixel-${theme}`);
      }
    }
  }
  await run(page, `(s) => s.setLayout("nook")`);
  await ctx.close();
}
// sidebar collapsed + Clean icon style for contrast
{
  const { ctx, page } = await open({ theme: "dark", uiStyle: "pixel", iconStyle: "clean", onboarded: true, tourDone: true, v13: true });
  await run(page, `(s) => { s.setView("notes"); s.openNote(s.notes[0]?.id); }`);
  await snap(page, "notes-pixel-dark-clean-icons");
  await page.getByTestId("sidebar-collapse").click();
  await snap(page, "sidebar-collapsed-pixel-dark");
  await ctx.close();
}
await browser.close();
console.log(report.join("\n"));
if (errors.length) console.log("PAGE ERRORS:\n" + [...new Set(errors)].join("\n"));
