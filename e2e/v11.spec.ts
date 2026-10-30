import { expect, test, type Page } from "@playwright/test";

/* v1.1 features against the real Rust backend: Timelens, journal, search, Kanban, links, chat. */

const API = "http://127.0.0.1:3210";
let errors: string[] = [];

async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(API + path, init);
  return (await r.json()) as T;
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function boot(page: Page, path = "/") {
  errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|WebSocket|ERR_CONNECTION/.test(m.text())) errors.push(m.text());
  });
  await page.addInitScript(() => {
    (window as unknown as { __NOOK_E2E__: boolean }).__NOOK_E2E__ = true;
    if (!localStorage.getItem("nook:prefs")) localStorage.setItem("nook:prefs", JSON.stringify({ tourDone: true }));
  });
  await page.goto(path);
  await page.waitForFunction(() => !!(window as any).__nook, null, { timeout: 30_000 });
}
const st = (page: Page, fn: string) => page.evaluate(`(() => { const s = window.__nook.getState(); return (${fn})(s); })()`);

test.describe.serial("Nook 1.1", () => {
  test.beforeAll(async () => {
    // other suites may have left a cloud provider configured — v1.1 tests run on the offline brain
    await fetch(`${API}/api/ai-config`, json("PUT", { provider: "local" }));
  });

  test("Timelens: seeded day renders timeline, apps, goals; pause + settings round-trip", async ({ page }) => {
    const seeded = await fetch(`${API}/api/timelens/seed`, { method: "POST" });
    expect(seeded.ok).toBe(true);
    const sum = await api<any>(`/api/timelens/summary`);
    expect(sum.activeSecs).toBeGreaterThan(0);
    await boot(page);
    await st(page, `(s) => s.setView("timelens")`);
    await expect(page.getByTestId("timelens")).toBeVisible();
    await expect(page.getByTestId("tl-timeline")).toBeVisible();
    await expect(page.getByTestId("tl-donut")).toBeVisible();
    await expect(page.getByTestId("tl-apps")).toContainText(sum.topApp ?? /./);
    await expect(page.getByTestId("tl-heatmap")).toBeVisible();
    // pause from the view
    const before = (await api<any>("/api/timelens/config")).paused;
    await page.getByTestId("tl-pause").click();
    await expect.poll(async () => (await api<any>("/api/timelens/config")).paused).toBe(!before);
    // settings tab: exclusion list, redaction, retention, a category rule and a goal
    await st(page, `(s) => { s.setView("settings"); s.set({ settingsSection: "timelens" }); }`);
    const tl = page.getByTestId("settings-timelens");
    await expect(tl).toBeVisible();
    await tl.getByLabel("Exclude app").fill("KeePass");
    await tl.getByLabel("Exclude app").press("Enter");
    await tl.getByLabel("Redact window titles").check();
    await tl.getByLabel("Rule match").fill("jira");
    await tl.getByLabel("Rule category").selectOption("productive");
    await tl.getByRole("button", { name: /add rule/ }).click();
    await tl.getByLabel("Goal minutes").fill("45");
    await tl.getByLabel("Goal target").fill("focus");
    await tl.getByRole("button", { name: /add goal/ }).click();
    await expect
      .poll(async () => {
        const c = await api<any>("/api/timelens/config");
        return c.exclude.includes("KeePass") && c.redactTitles && c.rules.some((r: any) => r.match === "jira") && c.goals.some((g: any) => g.target === "focus" && g.mins === 45);
      })
      .toBe(true);
    // Focus sessions land in Timelens as focus time
    const f0 = (await api<any>("/api/timelens/summary")).focusSecs;
    await fetch(`${API}/api/timelens/focus`, json("POST", { start: Date.now() - 25 * 60_000, end: Date.now(), label: "Focus: e2e" }));
    await expect.poll(async () => (await api<any>("/api/timelens/summary")).focusSecs).toBeGreaterThan(f0);
    await st(page, `(s) => s.setView("focus")`);
    await expect(page.getByTestId("focus-stats")).toContainText(/Timelens: \d+m focus/);
    await fetch(`${API}/api/timelens/pause`, json("POST", { paused: false }));
    expect(errors).toEqual([]);
  });

  test("Backup + Import settings tabs", async ({ page }) => {
    await boot(page);
    await st(page, `(s) => { s.setView("settings"); s.set({ settingsSection: "import" }); }`);
    const imp = page.getByTestId("settings-import");
    await expect(imp).toBeVisible();
    await imp.getByLabel("Import files").setInputFiles([{ name: "Imported e2e.md", mimeType: "text/markdown", buffer: Buffer.from("# Imported e2e\n\nlinks to [[Graph view]] #imported") }]);
    await expect(imp.getByRole("status")).toContainText(/Imported 1 note/);
    await expect.poll(async () => (await api<any[]>("/api/notes")).some((n) => n.title === "Imported e2e")).toBe(true);
    await st(page, `(s) => s.set({ settingsSection: "backup" })`);
    const bk = page.getByTestId("settings-backup");
    await expect(bk).toBeVisible();
    await bk.getByLabel("Backup folder").fill("/tmp/nook-e2e-backups");
    await bk.getByLabel("Backup password").fill("correct horse");
    await bk.getByRole("button", { name: /back up now/ }).click();
    await expect(bk.getByRole("status")).toContainText(/Encrypted backup written/);
    expect(errors).toEqual([]);
  });

  test("AI chat view: offline fallback answers with sources; ask-my-notes from the editor", async ({ page }) => {
    await boot(page);
    await st(page, `(s) => s.setView("chat")`);
    await expect(page.getByTestId("model-offline")).toBeVisible();
    await page.getByRole("tab", { name: /Ask my notes/ }).click();
    const box = page.getByPlaceholder("Ask anything about your notes…");
    await box.fill("what is the graph view?");
    await box.press("Enter");
    await expect(page.getByText(/offline · asknotes/).first()).toBeVisible({ timeout: 20_000 });
    // editor hand-off: select text, Ctrl+Shift+K → chat in ask-my-notes mode, question sent
    await st(page, `(s) => { s.setView("notes"); s.set({ editorMode: "write" }); s.openNote("n-graph"); }`);
    const ta = page.locator("textarea.editor-ta");
    await expect(ta).toBeVisible();
    await ta.evaluate((el: HTMLTextAreaElement) => {
      const i = el.value.indexOf("wikilink");
      el.focus();
      el.setSelectionRange(i, i + "wikilink".length);
    });
    await ta.press("Control+Shift+K");
    await expect(page.getByText(/What do my notes say about: "wikilink"/).first()).toBeVisible();
    await expect(page.getByRole("tab", { name: /Ask my notes/ })).toHaveAttribute("aria-selected", "true");
    expect(errors).toEqual([]);
  });

  test("wikilinks navigate and backlinks are listed", async ({ page }) => {
    await boot(page);
    const bl = await api<any[]>("/api/notes/n-graph/backlinks");
    expect(bl.some((b) => b.id === "n-welcome")).toBe(true);
    await st(page, `(s) => { s.setView("notes"); s.set({ editorMode: "read" }); s.openNote("n-welcome"); }`);
    await page.locator(".wl", { hasText: "Graph view" }).first().click();
    await expect.poll(() => st(page, `(s) => s.activeId`)).toBe("n-graph");
    await expect(page.getByText(/Linked mentions · [1-9]/)).toBeVisible();
    await st(page, `(s) => s.set({ editorMode: "write" })`);
    expect(errors).toEqual([]);
  });

  test("daily notes: today's note from the journal is created once", async ({ page }) => {
    await boot(page);
    await st(page, `(s) => s.setView("calendar")`);
    await expect(page.getByTestId("calendar")).toBeVisible();
    await page.getByTestId("open-today").click();
    await expect.poll(() => st(page, `(s) => s.view`)).toBe("notes");
    const id1 = await st(page, `(s) => s.activeId`);
    expect(id1).toBeTruthy();
    const d = new Date();
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const again = await api<any>(`/api/daily?date=${key}`);
    expect(again.note?.id ?? again.id).toBe(id1);
    expect(again.created ?? false).toBe(false);
    expect(errors).toEqual([]);
  });

  test("full-text search dialog finds note body text", async ({ page }) => {
    await boot(page);
    const hits = await api<any>("/api/search?q=wikilink");
    expect(JSON.stringify(hits)).toContain("n-graph");
    await st(page, `(s) => s.setView("notes")`);
    await page.keyboard.press("Control+Shift+F");
    const dlg = page.getByTestId("search-dialog");
    await expect(dlg).toBeVisible();
    await dlg.getByLabel("Full-text search").fill("wikilink");
    await expect(page.getByTestId("search-results")).toContainText("Graph view");
    expect(errors).toEqual([]);
  });

  test("Kanban: add a card, drag it to Doing, then Done", async ({ page }) => {
    await boot(page);
    await st(page, `(s) => s.setView("tasks")`);
    await page.getByTestId("kanban-toggle").click();
    await expect(page.getByTestId("kanban")).toBeVisible();
    const title = `KB card ${Date.now()}`;
    await page.getByLabel("Add a card to To do").fill(title);
    await page.getByLabel("Add a card to To do").press("Enter");
    const card = page.locator(".kb-card", { hasText: title });
    await expect(card).toBeVisible();
    await card.dragTo(page.locator('[data-col="doing"]'));
    await expect.poll(async () => (await api<any[]>("/api/tasks")).find((t) => t.title === title)?.status).toBe("doing");
    await page.locator(".kb-card", { hasText: title }).dragTo(page.locator('[data-col="done"]'));
    await expect.poll(async () => (await api<any[]>("/api/tasks")).find((t) => t.title === title)?.done).toBe(true);
    expect(errors).toEqual([]);
  });

  test("links: http opens externally, nook:// opens a note, nook://share opens the reader", async ({ page }) => {
    await boot(page);
    expect(await page.evaluate(() => (window as any).__nookLink("https://example.com/x"))).toBe("external");
    expect(await page.evaluate(() => (window as any).__nookLink("nook://note/n-graph"))).toBe("deeplink");
    expect(await page.evaluate(() => (window as any).__nookLink("nook://share/abc"))).toBe("share");
    const id = (await st(page, `(s) => s.createNote({ title: "Link lab", content: "# Link lab\\n\\n[site](https://example.com/nook) and [pet](nook://note/n-pet)" })`)) as string;
    await st(page, `(s) => { s.setView("notes"); s.set({ editorMode: "read" }); s.openNote("${id}"); }`);
    await page.getByRole("link", { name: "site" }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__nookOpened ?? [])).toContain("https://example.com/nook");
    await page.getByRole("link", { name: "pet" }).click();
    await expect.poll(() => st(page, `(s) => s.activeId`)).toBe("n-pet");
    await st(page, `(s) => s.set({ editorMode: "write" })`);
    // share deep link → in-app reader
    const sh = await api<any>("/api/share", json("POST", { noteId: "n-garden", mode: "read" }));
    await page.evaluate((u) => {
      const a = document.createElement("a");
      a.href = u;
      a.textContent = "shared";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, `nook://share/${sh.id}`);
    await expect(page.getByText("Pixel garden project").first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("widget: renders Timelens tile and answers offline quickly", async ({ page }) => {
    errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto("/widget.html");
    await expect(page.getByTestId("widget")).toBeVisible();
    await page.getByLabel("Ask the AI").fill("how many notes are in my vault stats?");
    const t0 = Date.now();
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await expect(page.getByTestId("widget-answer")).toContainText(/Vault/i, { timeout: 15_000 });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(errors).toEqual([]);
  });
});
