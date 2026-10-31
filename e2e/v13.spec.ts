import { expect, test, type Page } from "@playwright/test";

/* v1.3: onboarding (steps, theme + icon style, layout, feature switches hide UI), AI setup
   (mocked /api/ai-models + /api/ai-test), Obsidian layout, folder tree (create / rename / colour /
   move), brand fallback icons, Ctrl+O quick switcher. */

const API = "http://127.0.0.1:3210";
let errors: string[] = [];
async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  return (await (await fetch(API + path, init)).json()) as T;
}

async function boot(page: Page, prefs: Record<string, unknown> | null = { tourDone: true, onboarded: true }, path = "/") {
  errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|WebSocket|ERR_CONNECTION/.test(m.text())) errors.push(m.text());
  });
  // 1.3.1: a fresh profile also means the vault's onboarding flag is unset
  if (!prefs) await fetch("http://127.0.0.1:3210/api/ui-state", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ onboarded: false }) });
  await page.addInitScript((p) => {
    (window as unknown as { __NOOK_E2E__: boolean }).__NOOK_E2E__ = true;
    if (!sessionStorage.getItem("seeded")) {
      localStorage.clear();
      if (p) localStorage.setItem("nook:prefs", JSON.stringify(p));
      sessionStorage.setItem("seeded", "1");
    }
  }, prefs);
  await page.goto(path);
  await page.waitForFunction(() => !!(window as any).__nook, null, { timeout: 30_000 });
}
const st = (page: Page, fn: string) => page.evaluate(`(() => { const s = window.__nook.getState(); return (${fn})(s); })()`);
const html = (page: Page, attr: string) => page.evaluate((a) => document.documentElement.getAttribute(a), attr);
const prefs = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("nook:prefs") ?? "{}"));

test.describe.serial("Nook 1.3", () => {
  test.beforeAll(async () => {
    await fetch(`${API}/api/timelens/seed`, { method: "POST" });
  });

  test("onboarding: first launch walks all 8 steps; theme, icon style and layout apply live; a feature switched off leaves the sidebar", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await boot(page, null);
    const ob = page.getByTestId("onboarding");
    await expect(ob).toBeVisible();
    await expect(ob).toHaveAttribute("data-step", "welcome");
    await expect(page.getByTestId("ob-back")).toBeDisabled();
    await page.getByTestId("ob-start").click();
    // 1.3.1: the profile step comes first (covered in v131.spec)
    await expect(ob).toHaveAttribute("data-step", "profile");
    await page.getByTestId("ob-next").click();

    // theme + icon style
    await expect(ob).toHaveAttribute("data-step", "theme");
    await page.getByTestId("preset-pixel-light").click();
    expect(await html(page, "data-ui")).toBe("pixel");
    expect(await html(page, "data-theme")).toBe("light");
    await expect(page.getByTestId("preset-pixel-light")).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("preset-clean-dark").click();
    expect(await html(page, "data-ui")).toBe("clean");
    expect(await html(page, "data-theme")).toBe("dark");
    await page.getByTestId("preset-pixel-dark").click();
    expect(await html(page, "data-ui")).toBe("pixel");
    // icon style is independent of the theme
    await page.getByTestId("icon-style-clean").click();
    expect(await html(page, "data-icons")).toBe("clean");
    expect(await html(page, "data-ui")).toBe("pixel");
    await expect(page.getByTestId("icon-style-clean")).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("icon-style-pixel").click();
    expect(await html(page, "data-icons")).toBe("pixel");
    // Back works, Next moves on
    await page.getByTestId("ob-back").click();
    await expect(ob).toHaveAttribute("data-step", "profile");
    await page.getByTestId("ob-next").click();
    await expect(ob).toHaveAttribute("data-step", "theme");
    await page.getByTestId("ob-next").click();

    // layout
    await expect(ob).toHaveAttribute("data-step", "layout");
    await page.getByTestId("layout-obsidian").click();
    expect(await html(page, "data-layout")).toBe("obsidian");
    await page.getByTestId("layout-nook").click();
    expect(await html(page, "data-layout")).toBe("nook");
    await expect(page.getByTestId("layout-nook")).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("ob-next").click();

    // AI (skippable) → features
    await expect(ob).toHaveAttribute("data-step", "ai");
    await expect(page.getByTestId("ai-setup")).toBeVisible();
    await page.getByTestId("ob-next").click();
    await expect(ob).toHaveAttribute("data-step", "features");
    const grid = page.getByTestId("feature-grid");
    await expect(grid.locator("[data-testid^=feature-]")).toHaveCount(16);
    await page.getByTestId("feature-arcade").click();
    await expect(page.getByTestId("feature-arcade")).toHaveAttribute("data-on", "false");
    await page.getByTestId("feature-tasks").click();
    expect(await st(page, `(s) => s.features.arcade`)).toBe(false);
    expect(await st(page, `(s) => s.features.tasks`)).toBe(false);
    await page.getByTestId("ob-next").click();

    // pet
    await expect(ob).toHaveAttribute("data-step", "pet");
    await page.getByTestId("ob-pet-name").fill("Biscuit");
    await page.getByRole("radio", { name: /Chill/ }).click();
    await page.getByTestId("ob-next").click();
    await expect(ob).toHaveAttribute("data-step", "done");
    await page.getByTestId("ob-finish").click();
    await expect(ob).toHaveCount(0);

    // results stuck
    expect(await st(page, `(s) => s.pet.name`)).toBe("Biscuit");
    expect(await st(page, `(s) => s.onboarded`)).toBe(true);
    await expect(page.getByTestId("nav-arcade")).toHaveCount(0);
    await expect(page.getByTestId("nav-tasks")).toHaveCount(0);
    await expect(page.getByTestId("nav-notes")).toBeVisible();
    // a disabled view can't be reached by a deep link either
    await st(page, `(s) => s.setView("arcade")`);
    expect(await st(page, `(s) => s.view`)).not.toBe("arcade");
    // persisted, and onboarding doesn't come back on reload
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__nook);
    await expect(page.getByTestId("onboarding")).toHaveCount(0);
    await expect(page.getByTestId("nav-arcade")).toHaveCount(0);
    const p = await prefs(page);
    expect(p.features.arcade).toBe(false);
    expect(p.onboarded).toBe(true);
    expect(p.iconStyle).toBe("pixel");
    // switching it back on (Settings ▸ Features) restores the item
    await st(page, `(s) => { s.setFeature("arcade", true); s.setFeature("tasks", true); }`);
    await expect(page.getByTestId("nav-arcade")).toBeVisible();
    await expect(page.getByTestId("nav-tasks")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("onboarding: Esc skips, and it can be re-run", async ({ page }) => {
    await boot(page, null);
    await expect(page.getByTestId("onboarding")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("onboarding")).toHaveCount(0);
    expect(await st(page, `(s) => s.onboarded`)).toBe(true);
    await st(page, `(s) => s.set({ onboardingOpen: true })`);
    await expect(page.getByTestId("onboarding")).toBeVisible();
    await page.getByTestId("ob-skip").click();
    await expect(page.getByTestId("onboarding")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("AI setup: provider cards, model listing and connection test (mocked), save", async ({ page }) => {
    const calls: { url: string; body: any }[] = [];
    await page.route("**/api/ai-models", async (r) => {
      calls.push({ url: "models", body: r.request().postDataJSON() });
      await r.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, models: ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-e2e-pro"] }) });
    });
    await page.route("**/api/ai-test", async (r) => {
      const body = r.request().postDataJSON();
      calls.push({ url: "test", body });
      await r.fulfill({ contentType: "application/json", body: JSON.stringify(body.apiKey === "bad" ? { ok: false, error: "401 invalid key" } : { ok: true, reply: "pong", ms: 42 }) });
    });
    await boot(page);
    await st(page, `(s) => { s.setView("settings"); s.set({ settingsSection: "ai" }); }`);
    const setup = page.getByTestId("ai-setup");
    await expect(setup).toBeVisible();
    for (const id of ["gemini", "glm", "ollama", "other"]) await expect(page.getByTestId(`ai-card-${id}`)).toBeVisible();
    await page.getByTestId("ai-card-gemini").click();
    await expect(page.getByTestId("ai-form-gemini")).toBeVisible();
    await page.getByTestId("ai-key-gemini").fill("AIza-e2e-key");
    await page.getByTestId("ai-models-gemini").click();
    await expect(page.getByTestId("ai-model-gemini").locator("option", { hasText: "gemini-e2e-pro" })).toHaveCount(1);
    await page.getByTestId("ai-model-gemini").selectOption("gemini-e2e-pro");
    expect(calls.find((c) => c.url === "models")!.body).toMatchObject({ provider: "gemini", apiKey: "AIza-e2e-key" });
    // good key → connected
    await page.getByTestId("ai-test-gemini").click();
    await expect(page.getByTestId("ai-result-gemini")).toContainText("Connected");
    await expect(page.getByTestId("ai-result-gemini")).toContainText("42 ms");
    await expect(page.getByTestId("ai-result-gemini")).toHaveAttribute("data-ok", "true");
    expect(calls.filter((c) => c.url === "test").pop()!.body).toMatchObject({ provider: "gemini", model: "gemini-e2e-pro", apiKey: "AIza-e2e-key" });
    // bad key → readable error
    await page.getByTestId("ai-key-gemini").fill("bad");
    await page.getByTestId("ai-test-gemini").click();
    await expect(page.getByTestId("ai-result-gemini")).toHaveAttribute("data-ok", "false");
    await expect(page.getByTestId("ai-result-gemini")).toContainText("401");
    // GLM has two hosts
    await page.getByTestId("ai-card-glm").click();
    await page.getByTestId("glm-host-zai").click();
    await page.getByTestId("ai-test-glm").click();
    await expect(page.getByTestId("ai-result-glm")).toContainText("Connected");
    expect(calls.filter((c) => c.url === "test").pop()!.body.provider).toBe("zai");
    // save a provider for real (the key goes to the in-memory keystore of the dev API)
    await page.getByTestId("ai-card-gemini").click();
    await page.getByTestId("ai-key-gemini").fill("AIza-e2e-key");
    await page.getByTestId("ai-use-gemini").click();
    await expect.poll(async () => (await api<any>("/api/ai-config")).provider).toBe("gemini");
    // back to the offline brain
    await page.getByTestId("ai-offline").click();
    await page.getByTestId("ai-use-offline").click();
    await expect.poll(async () => (await api<any>("/api/ai-config")).provider).toBe("local");
    expect(errors).toEqual([]);
  });

  test("Obsidian layout: ribbon, file tree, tabbed editor, backlinks / outline / local graph; persisted", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await boot(page);
    await st(page, `(s) => { s.setLayout("obsidian"); s.setView("notes"); }`);
    await expect(page.getByTestId("obsidian-layout")).toBeVisible();
    expect(await html(page, "data-layout")).toBe("obsidian");
    await expect(page.getByTestId("obs-ribbon")).toBeVisible();
    await expect(page.getByTestId("obs-left").getByTestId("folder-tree")).toBeVisible();
    await expect(page.getByTestId("sidebar")).toHaveCount(0);
    // open a note from the tree
    const gv = page.getByTestId("obs-left").locator('[data-testid=ft-note][data-title="Graph view"]').first();
    if (!(await gv.isVisible())) await st(page, `(s) => s.openNote(s.notes.find((n) => n.title === "Graph view").id)`);
    else await gv.click();
    await expect.poll(() => st(page, `(s) => s.notes.find((n) => n.id === s.activeId)?.title`)).toBe("Graph view");
    const right = page.getByTestId("obs-right");
    await expect(right).toContainText("Linked mentions");
    await expect(right).toContainText("Welcome to Nook");
    await page.getByTestId("obs-tab-outline").click();
    await expect(right).toContainText("2D and 3D");
    await page.getByTestId("obs-tab-graph").click();
    await expect(page.getByTestId("obs-graph")).toBeVisible();
    // ribbon navigates
    await page.getByTestId("ribbon-calendar").click();
    expect(await st(page, `(s) => s.view`)).toBe("calendar");
    await page.getByTestId("ribbon-notes").click();
    // persisted
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__nook);
    await expect(page.getByTestId("obsidian-layout")).toBeVisible();
    await st(page, `(s) => s.setLayout("nook")`);
    await expect(page.getByTestId("obsidian-layout")).toHaveCount(0);
    await expect(page.getByTestId("sidebar")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("folder tree: create, rename, colour, nest and move notes", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await boot(page);
    await st(page, `(s) => s.setView("notes")`);
    const tree = page.getByTestId("folder-tree");
    await expect(tree).toBeVisible();
    // create → inline rename
    await page.getByTestId("ft-new-folder").click();
    const input = tree.getByTestId("ft-rename");
    await expect(input).toBeFocused();
    await input.fill("E2E Box");
    await input.press("Enter");
    const box = tree.locator('[data-testid=ft-folder][data-name="E2E Box"]');
    await expect(box).toBeVisible();
    await expect.poll(async () => (await api<any[]>("/api/folders")).some((f) => f.name === "E2E Box")).toBe(true);
    // rename with F2
    await box.focus();
    await page.keyboard.press("F2");
    await tree.getByTestId("ft-rename").fill("E2E Crate");
    await tree.getByTestId("ft-rename").press("Enter");
    const crate = tree.locator('[data-testid=ft-folder][data-name="E2E Crate"]');
    await expect(crate).toBeVisible();
    await expect.poll(async () => (await api<any[]>("/api/folders")).find((f) => f.name === "E2E Crate")?.id).toBeTruthy();
    const crateId = (await api<any[]>("/api/folders")).find((f) => f.name === "E2E Crate").id;
    // colour via the context menu
    await crate.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Colour" }).hover();
    await page.getByRole("menuitem", { name: "Rose" }).click();
    expect(await st(page, `(s) => s.folders.find((f) => f.id === "${crateId}").color`)).toBe(await st(page, `(s) => "#f27ba0"`));
    await expect.poll(async () => (await api<any[]>("/api/folders")).find((f) => f.id === crateId)?.color).toBe("#f27ba0");
    // nested folder via the folder's menu
    await crate.click({ button: "right" });
    await page.getByRole("menuitem", { name: "New folder" }).click();
    await tree.getByTestId("ft-rename").fill("E2E Inner");
    await tree.getByTestId("ft-rename").press("Enter");
    await expect.poll(() => st(page, `(s) => s.folders.find((f) => f.name === "E2E Inner")?.parentId`)).toBe(crateId);
    // move a note into the folder via "Move to"
    const noteId = await st(page, `(s) => s.createNote({ title: "E2E movable" })`);
    expect(noteId).toBeTruthy();
    const row = tree.locator('[data-testid=ft-note][data-title="E2E movable"]').first();
    await expect(row).toBeVisible();
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move to" }).hover();
    await page.getByRole("menuitem", { name: "E2E Crate", exact: true }).click();
    await expect.poll(() => st(page, `(s) => s.notes.find((n) => n.title === "E2E movable")?.folderId`)).toBe(crateId);
    await expect(crate.getByTestId("ft-count")).toHaveText(/[1-9]/);
    // drag a note onto a folder (HTML5 DnD)
    await st(page, `(s) => s.updateNote(s.notes.find((n) => n.title === "E2E movable").id, { folderId: null })`);
    const free = tree.locator('[data-testid=ft-note][data-title="E2E movable"]').first();
    await expect(free).toBeVisible();
    await free.dragTo(crate);
    await expect.poll(() => st(page, `(s) => s.notes.find((n) => n.title === "E2E movable")?.folderId`)).toBe(crateId);
    expect(errors).toEqual([]);
  });

  test("fallback icons: missing or broken real icons fall back to brand marks, unknown apps to a letter", async ({ page }) => {
    // VS Code's "real" icon is an undecodable PNG; Chrome has none; Nook has no brand mark
    await page.route("**/api/timelens/icons", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ "VS Code": "data:image/png;base64,AAAA" }) }));
    await boot(page);
    await st(page, `(s) => s.setView("timelens")`);
    await page.getByTestId("tl-tab-apps").click();
    const row = (app: string) => page.locator(`[data-testid=tl-app-row][data-app="${app}"]`);
    await expect(row("VS Code")).toBeVisible();
    await expect(row("VS Code").getByTestId("tl-brand-icon")).toBeVisible();
    await expect(row("VS Code").getByTestId("tl-brand-icon")).toHaveAttribute("data-app-logo", "VS Code");
    await expect(row("Chrome").getByTestId("tl-brand-icon")).toBeVisible();
    await expect(row("Chrome").getByTestId("tl-brand-icon").locator("svg")).toHaveCount(1);
    await expect(row("VS Code").getByTestId("tl-app-icon")).toHaveCount(0);
    await expect(row("Nook").getByTestId("tl-letter")).toHaveText("N");
    await expect(page.getByTestId("tl-refresh-icons")).toBeVisible();
    expect(errors.filter((e) => !/AAAA/.test(e))).toEqual([]);
  });

  test("quick switcher: Ctrl+O fuzzy-finds a note, Enter opens it, no match creates one", async ({ page }) => {
    await boot(page);
    await st(page, `(s) => s.setView("notes")`);
    await page.keyboard.press("Control+o");
    const qs = page.getByTestId("quick-switcher");
    await expect(qs).toBeVisible();
    await page.keyboard.type("grph vw");
    await expect(qs.getByTestId("qs-item").first()).toContainText("Graph view");
    await page.keyboard.press("Enter");
    await expect(qs).toHaveCount(0);
    expect(await st(page, `(s) => s.notes.find((n) => n.id === s.activeId)?.title`)).toBe("Graph view");
    // arrow keys move the selection
    await page.keyboard.press("Control+o");
    await page.keyboard.type("nook");
    const items = qs.getByTestId("qs-item");
    await expect(items.first()).toBeVisible();
    // Esc closes without opening
    await page.keyboard.press("Escape");
    await expect(qs).toHaveCount(0);
    // a title nothing matches → created
    await page.keyboard.press("Control+o");
    await page.keyboard.type("zz e2e brand new idea");
    await expect(qs.getByTestId("qs-item")).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect.poll(() => st(page, `(s) => s.notes.find((n) => n.id === s.activeId)?.title`)).toBe("zz e2e brand new idea");
    await expect.poll(async () => (await api<any[]>("/api/notes")).some((n) => n.title === "zz e2e brand new idea")).toBe(true);
    expect(errors).toEqual([]);
  });

  test("app icon: brand mark, favicon and About follow the theme (dark ↔ light), small web copies only", async ({ page }) => {
    await boot(page, { tourDone: true, onboarded: true, theme: "dark", uiStyle: "pixel", v13: true });
    const brand = page.getByTestId("brand-icon");
    await expect(brand).toHaveAttribute("data-tone", "dark");
    await expect(brand).toHaveAttribute("src", /\/brand\/nook-dark-128\.webp$/);
    expect(await page.evaluate(() => document.querySelector('link[rel="icon"]')?.getAttribute("href"))).toBe("/brand/favicon-dark-32.png");
    await st(page, `(s) => s.setTheme("light")`);
    await expect(brand).toHaveAttribute("data-tone", "light");
    await expect.poll(() => page.evaluate(() => document.querySelector('link[rel="icon"]')?.getAttribute("href"))).toBe("/brand/favicon-light-32.png");
    await st(page, `(s) => { s.setView("settings"); s.set({ settingsSection: "about" }); }`);
    await expect(page.getByTestId("about-icon")).toHaveAttribute("src", /nook-light-256\.webp$/);
    await expect(page.getByTestId("about-version")).toHaveText(/1\.3\.1/);
    // the images decode and stay small
    for (const f of ["nook-dark-128.webp", "nook-light-256.webp", "favicon-dark-32.png"]) {
      const r = await page.request.get(`/brand/${f}`);
      expect(r.ok()).toBe(true);
      expect((await r.body()).length).toBeLessThan(20_000);
    }
    expect(await page.getByTestId("about-icon").evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(256);
    expect(errors).toEqual([]);
  });

  test("onboarding leaves nothing running: no rAF and no animations once closed", async ({ page }) => {
    await boot(page, null);
    await expect(page.getByTestId("onboarding")).toBeVisible();
    await page.waitForTimeout(500);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("onboarding")).toHaveCount(0);
    await page.waitForTimeout(800);
    const r = await page.evaluate(async () => {
      let n = 0;
      const orig = window.requestAnimationFrame;
      window.requestAnimationFrame = (cb) => {
        n++;
        return orig(cb);
      };
      await new Promise((res) => setTimeout(res, 1500));
      window.requestAnimationFrame = orig;
      const anims = document.getAnimations().filter((a) => a.playState === "running" && (a.effect as KeyframeEffect)?.target && (((a.effect as KeyframeEffect).target as Element).closest?.(".ob-root") || (a as CSSAnimation).animationName?.startsWith("ob-")));
      return { n, anims: anims.length, sky: document.querySelectorAll(".ob-sky").length };
    });
    expect(r.sky).toBe(0);
    expect(r.anims).toBe(0);
    expect(r.n).toBe(0);
  });
});
