import { expect, test, type Page } from "@playwright/test";

/* v1.2: Clean theme + migration, the grouped/collapsible sidebar, TimeLet-style Timelens tabs,
   real app icons (mocked), the widget pill/expand + tiles, Performance (low-power, CPU cap). */

const API = "http://127.0.0.1:3210";
let errors: string[] = [];
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  return (await (await fetch(API + path, init)).json()) as T;
}

/** a 2×2 PNG in a recognisable colour — the "real icon" our mocked icon endpoint serves */
const MOCK_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8Dwn4GBgYGJgYGBAQAvJAMB9Xr3nAAAAABJRU5ErkJggg==";

async function boot(page: Page, prefs: Record<string, unknown> | null = { tourDone: true }, path = "/") {
  errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|WebSocket|ERR_CONNECTION/.test(m.text())) errors.push(m.text());
  });
  await page.addInitScript((p) => {
    (window as unknown as { __NOOK_E2E__: boolean }).__NOOK_E2E__ = true;
    if (p && !sessionStorage.getItem("seeded")) {
      localStorage.setItem("nook:prefs", JSON.stringify(p));
      sessionStorage.setItem("seeded", "1");
    }
  }, prefs);
  await page.goto(path);
  await page.waitForFunction(() => !!(window as any).__nook, null, { timeout: 30_000 });
}
const st = (page: Page, fn: string) => page.evaluate(`(() => { const s = window.__nook.getState(); return (${fn})(s); })()`);
const html = (page: Page, attr: string) => page.evaluate((a) => document.documentElement.getAttribute(a), attr);

test.describe.serial("Nook 1.2", () => {
  test.beforeAll(async () => {
    await fetch(`${API}/api/timelens/seed`, { method: "POST" });
    await fetch(`${API}/api/timelens/pause`, json("POST", { paused: false }));
  });

  test("theme: new installs get Clean, follow the OS; old default migrates; custom picks are kept", async ({ browser }) => {
    // fresh install, light OS
    let ctx = await browser.newContext({ colorScheme: "light" });
    let page = await ctx.newPage();
    await boot(page, null);
    expect(await html(page, "data-ui")).toBe("clean");
    expect(await html(page, "data-theme")).toBe("light");
    expect(await html(page, "data-power")).toBe("low");
    const font = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(font).toContain("Segoe UI Variable");
    // crisp (lucide) icons in the Clean style
    await expect(page.locator("svg.lucide").first()).toBeVisible();
    await ctx.close();
    // fresh install, dark OS
    ctx = await browser.newContext({ colorScheme: "dark" });
    page = await ctx.newPage();
    await boot(page, null);
    expect(await html(page, "data-theme")).toBe("dark");
    await ctx.close();
    // 1.1 user on the old default (classic + graphite) → Clean dark
    ctx = await browser.newContext();
    page = await ctx.newPage();
    await boot(page, { tourDone: true, theme: "graphite", uiStyle: "nook" });
    expect(await html(page, "data-ui")).toBe("clean");
    expect(await html(page, "data-theme")).toBe("dark");
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("nook:prefs") ?? "{}").v12)).toBe(true);
    await ctx.close();
    // a customised 1.1 look is respected; pixel themes still exist
    ctx = await browser.newContext();
    page = await ctx.newPage();
    await boot(page, { tourDone: true, theme: "moss", uiStyle: "pixel" });
    expect(await html(page, "data-ui")).toBe("pixel");
    expect(await html(page, "data-theme")).toBe("moss");
    await st(page, `(s) => s.setUiStyle("clean")`);
    expect(await html(page, "data-ui")).toBe("clean");
    expect(errors).toEqual([]);
    await ctx.close();
  });

  test("sidebar: grouped sections, collapse to an icon rail with tooltips, persisted, reorder kept", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await boot(page, { tourDone: true, sidebarCollapsed: false });
    const nav = page.getByTestId("sidebar");
    await expect(nav).toBeVisible();
    await expect(nav).toHaveAttribute("data-collapsed", "false");
    for (const g of ["Workspace", "Create", "Productivity", "Play"]) await expect(nav.getByRole("group", { name: g })).toBeVisible();
    await expect(page.getByTestId("nav-notes")).toHaveAttribute("data-on", "true");
    await page.getByTestId("nav-timelens").click();
    await expect(page.getByTestId("timelens")).toBeVisible();
    await expect(page.getByTestId("nav-timelens")).toHaveAttribute("aria-current", "page");
    // collapse
    const wide = (await nav.boundingBox())!.width;
    await page.getByTestId("sidebar-collapse").click();
    await expect(nav).toHaveAttribute("data-collapsed", "true");
    expect((await nav.boundingBox())!.width).toBeLessThan(wide / 2);
    await expect(page.getByTestId("nav-tasks").locator(".nav-label")).toBeHidden();
    await page.getByTestId("nav-tasks").hover();
    await expect(page.getByRole("tooltip")).toContainText("Tasks");
    // persisted across reloads
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__nook);
    await expect(page.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "true");
    await page.getByTestId("sidebar-collapse").click();
    await expect(page.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "false");
    // reordering still works (within the group)
    const order = async () => page.getByTestId("sidebar").getByRole("group", { name: "Workspace" }).locator("[data-testid^=nav-]").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
    const before = await order();
    await page.getByTestId("nav-tasks").click({ button: "right" });
    await page.getByRole("button", { name: "Move up" }).or(page.getByRole("menuitem", { name: "Move up" })).first().click();
    const after = await order();
    expect(after.indexOf("nav-tasks")).toBe(before.indexOf("nav-tasks") - 1);
    await st(page, `(s) => s.resetRail()`);
    expect(errors).toEqual([]);
  });

  test("Timelens: dashboard cards and every tab render with seeded data", async ({ page }) => {
    await boot(page);
    await st(page, `(s) => s.setView("timelens")`);
    for (const id of ["tl-total", "tl-productive", "tl-focused", "tl-idle"]) await expect(page.getByTestId(id)).toBeVisible();
    await expect(page.getByTestId("tl-total")).toContainText(/\dh|\dm/);
    await expect(page.getByTestId("tl-timeline")).toBeVisible();
    // timeline: zoom + hover details
    await page.getByTestId("tl-tab-timeline").click();
    const segs = page.getByTestId("tl-seg");
    expect(await segs.count()).toBeGreaterThan(3);
    await page.getByRole("button", { name: "Zoom 8x" }).click();
    await segs.first().hover();
    await expect(page.getByTestId("tl-hover")).toBeVisible();
    await expect(page.getByTestId("tl-sessions")).toContainText("VS Code");
    // day navigation
    await page.getByRole("button", { name: "Previous day" }).click();
    await expect(page.getByTestId("tl-day")).toHaveText("Yesterday");
    await page.getByTestId("tl-day").click();
    await expect(page.getByTestId("tl-day")).toHaveText("Today");
    // websites
    await page.getByTestId("tl-tab-websites").click();
    await expect(page.getByTestId("tl-sites")).toContainText("YouTube");
    await expect(page.getByTestId("tl-sites")).toContainText("youtube.com");
    // analytics, goals, focus, settings
    await page.getByTestId("tl-tab-analytics").click();
    await expect(page.getByTestId("tl-heatmap")).toBeVisible();
    await expect(page.getByTestId("tl-history")).toBeVisible();
    await page.getByTestId("tl-tab-goals").click();
    await expect(page.getByTestId("tl-goals")).toBeVisible();
    await page.getByTestId("tl-tab-focus").click();
    await expect(page.getByTestId("tl-focus")).toBeVisible();
    await page.getByTestId("tl-tab-settings").click();
    await expect(page.getByTestId("tl-privacy")).toBeVisible();
    await expect(page.getByTestId("settings-timelens")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("Timelens apps: every app, real icons (mocked), search, sort, re-categorise retroactively, exclude", async ({ page }) => {
    // mocked icon source: the endpoint the UI reads icons from
    await page.route("**/api/timelens/icons", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ "VS Code": MOCK_ICON, Chrome: MOCK_ICON }) }));
    await boot(page);
    await st(page, `(s) => s.setView("timelens")`);
    await page.getByTestId("tl-tab-apps").click();
    const rows = page.getByTestId("tl-app-row");
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThanOrEqual(6);
    const code = page.locator('[data-testid=tl-app-row][data-app="VS Code"]');
    await expect(code.getByTestId("tl-app-icon")).toHaveAttribute("src", MOCK_ICON);
    // an app without an icon gets a letter avatar
    await expect(page.locator('[data-testid=tl-app-row][data-app="Nook"]').getByTestId("tl-letter")).toHaveText("N");
    // search
    await page.getByTestId("tl-app-search").fill("fig");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute("data-app", "Figma");
    await page.getByTestId("tl-app-search").fill("");
    // sort by name
    await page.getByTestId("tl-app-sort").selectOption("name");
    const names = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-app") ?? ""));
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    // re-categorise: history follows
    const before = (await api<any>("/api/timelens/summary")).categories;
    await code.getByTestId("tl-app-cat").selectOption("distracting");
    await expect.poll(async () => (await api<any>("/api/timelens/summary")).categories.distracting).toBeGreaterThan(before.distracting);
    await expect(code.getByTestId("tl-app-cat")).toHaveValue("distracting");
    await code.getByRole("button", { name: "Reset category for VS Code" }).click();
    await expect.poll(async () => (await api<any>("/api/timelens/summary")).categories.distracting).toBe(before.distracting);
    // exclude → hidden everywhere; include again
    await page.locator('[data-testid=tl-app-row][data-app="Spotify"]').getByRole("button", { name: "Exclude Spotify" }).click();
    await expect.poll(async () => (await api<any>("/api/timelens/summary")).apps.some((a: any) => a.app === "Spotify")).toBe(false);
    await expect(page.locator('[data-testid=tl-app-row][data-app="Spotify"]')).toHaveCount(0);
    await fetch(`${API}/api/timelens/apps/Spotify`, json("PATCH", { excluded: false }));
    // real icons are served by the backend too (demo vault icons are generated PNGs)
    const icons = await api<Record<string, string>>("/api/timelens/icons");
    expect(icons["VS Code"]).toMatch(/^data:image\/png;base64,/);
    expect(errors).toEqual([]);
  });

  test("widget: small card, collapse to a pill and expand (remembered), configurable tiles", async ({ page }) => {
    await page.setViewportSize({ width: 300, height: 380 });
    errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.addInitScript(() => {
      if (!sessionStorage.getItem("w")) {
        localStorage.removeItem("nook:widget");
        sessionStorage.setItem("w", "1");
      }
    });
    await page.goto("/widget.html");
    const w = page.getByTestId("widget");
    await expect(w).toHaveAttribute("data-compact", "false");
    await expect(page.getByLabel("Quick capture")).toBeVisible();
    await expect(page.getByTestId("widget-timelens")).toBeVisible();
    await expect(page.getByTestId("widget-top-apps")).toBeVisible();
    expect(await page.getByTestId("widget-app-icon").count()).toBeGreaterThan(0);
    // pill
    await page.getByTestId("widget-collapse").click();
    await expect(w).toHaveAttribute("data-compact", "true");
    await expect(page.getByLabel("Quick capture")).toHaveCount(0);
    const box = (await w.boundingBox())!;
    expect(box.height).toBeLessThanOrEqual(48);
    await page.reload();
    await expect(page.getByTestId("widget")).toHaveAttribute("data-compact", "true");
    await page.getByTestId("widget-expand").click();
    await expect(page.getByTestId("widget")).toHaveAttribute("data-compact", "false");
    // tiles: turn the focus timer + pet on, timelens off (as Settings → Performance & widget does)
    await page.evaluate(() => {
      const c = JSON.parse(localStorage.getItem("nook:widget") ?? "{}");
      c.tiles = [{ id: "focus", on: true }, { id: "pet", on: true }, { id: "capture", on: true }, { id: "timelens", on: false }, { id: "tasks", on: true }, { id: "ai", on: true }];
      localStorage.setItem("nook:widget", JSON.stringify(c));
      window.dispatchEvent(new CustomEvent("nook-widget-cfg"));
    });
    await expect(page.getByTestId("widget-focus")).toBeVisible();
    await expect(page.getByTestId("widget-pet")).toBeVisible();
    await expect(page.getByTestId("widget-timelens")).toHaveCount(0);
    // focus tile is first now
    const first = await page.locator(".wg-body > section").first().getAttribute("data-testid");
    expect(first).toBe("widget-focus");
    expect(errors).toEqual([]);
  });

  test("performance settings: low-power default, CPU cap slider 5–50 (default 10), widget tiles editor", async ({ page }) => {
    await boot(page);
    await st(page, `(s) => { s.setView("settings"); s.set({ settingsSection: "performance" }); }`);
    const perf = page.getByTestId("perf-settings");
    await expect(perf).toBeVisible();
    await expect(page.getByTestId("low-power")).toBeChecked();
    const cap = page.getByTestId("cpu-cap");
    await expect(cap).toHaveAttribute("min", "5");
    await expect(cap).toHaveAttribute("max", "50");
    await expect(cap).toHaveValue("10");
    await expect(page.getByTestId("cpu-cap-value")).toHaveText("10%");
    await cap.fill("25");
    await expect(page.getByTestId("cpu-cap-value")).toHaveText("25%");
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("nook:cpuCap") ?? "{}").cap)).toBe(25);
    await page.getByTestId("cpu-cap-on").uncheck();
    await expect(page.getByTestId("cpu-cap-value")).toHaveText("off");
    await expect(cap).toBeDisabled();
    await page.getByTestId("cpu-cap-on").check();
    // low power off → decorative motion allowed; back on
    await page.getByTestId("low-power").uncheck();
    expect(await html(page, "data-power")).toBe("full");
    await page.getByTestId("low-power").check();
    expect(await html(page, "data-power")).toBe("low");
    // widget tiles editor writes the shared config
    await page.getByLabel("Show Focus timer").check();
    await page.getByRole("button", { name: "Move Focus timer up" }).click();
    const cfg = await page.evaluate(() => JSON.parse(localStorage.getItem("nook:widget") ?? "{}"));
    const i = cfg.tiles.findIndex((t: any) => t.id === "focus");
    expect(cfg.tiles[i].on).toBe(true);
    expect(i).toBe(2);
    expect(errors).toEqual([]);
  });

  test("idle: low-power mode runs no animation frames on the main views and stops timers while hidden", async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as any;
      w.__raf = 0;
      const raf = w.requestAnimationFrame.bind(w);
      w.requestAnimationFrame = (cb: FrameRequestCallback) => raf((t: number) => { w.__raf++; cb(t); });
    });
    await boot(page);
    for (const v of ["notes", "graph", "den", "market", "timelens"]) {
      await st(page, `(s) => s.setView("${v}")`);
      await page.waitForTimeout(1500); // settle (graph layout, lazy chunks)
      const r0 = await page.evaluate(() => (window as any).__raf);
      await page.waitForTimeout(2000);
      const r1 = await page.evaluate(() => (window as any).__raf);
      // 1.1 ran 85–230 frames/s here; idle low-power must be (near) zero
      expect((r1 - r0) / 2, `rAF/s on ${v}`).toBeLessThan(3);
    }
    // hidden window: power governor reports inactive and freezes CSS animation
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(await html(page, "data-active")).toBe("false");
    expect(errors).toEqual([]);
  });
});
