import { expect, test, type Page } from "@playwright/test";
import http from "node:http";

/* Full click-through of the SPA against the real Rust backend (nook-dev-api). */

const API = "http://127.0.0.1:3210";
let errors: string[] = [];
let mock: http.Server;
const mockCalls: { stream: boolean; agent: boolean }[] = [];

/** Mock OpenAI-compatible provider: echoes, streams, and drives the agent tool protocol. */
test.beforeAll(async () => {
  mock = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const b = JSON.parse(raw || "{}") as { stream?: boolean; messages: { role: string; content: string }[] };
      const sys = b.messages[0]?.content ?? "";
      const last = b.messages[b.messages.length - 1]?.content ?? "";
      const agent = sys.includes("STRICT JSON");
      mockCalls.push({ stream: !!b.stream, agent });
      let reply: string;
      if (agent) {
        reply = last.includes("TOOL RESULTS")
          ? JSON.stringify({ say: "Mock agent finished: created **Mock agent task**.", effects: [{ type: "confetti" }] })
          : JSON.stringify({ say: "working…", tools: [{ name: "create_task", args: { title: "Mock agent task", priority: 2 } }] });
      } else reply = `MOCK REPLY to: ${last.slice(0, 40)}`;
      if (b.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const w of reply.split(/(?<= )/)) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`);
        res.end("data: [DONE]\n\n");
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: reply } }] }));
      }
    });
  });
  await new Promise<void>((r) => mock.listen(3299, "127.0.0.1", () => r()));
});
test.afterAll(() => mock?.close());

async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(API + path, init);
  return (await r.json()) as T;
}

async function boot(page: Page) {
  errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|WebSocket|ERR_CONNECTION/.test(m.text())) errors.push(m.text());
  });
  await page.addInitScript(() => {
    (window as unknown as { __NOOK_E2E__: boolean }).__NOOK_E2E__ = true;
    if (!localStorage.getItem("nook:prefs")) localStorage.setItem("nook:prefs", JSON.stringify({ tourDone: true }));
  });
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__nook, null, { timeout: 30_000 });
}

const st = (page: Page, fn: string) => page.evaluate(`(() => { const s = window.__nook.getState(); return (${fn})(s); })()`);
const view = async (page: Page, label: string) => {
  await page.getByRole("button", { name: new RegExp(`^${label}`) }).first().click();
};

test.describe.serial("Nook SPA", () => {
  test("boots with the seeded vault and no errors", async ({ page }) => {
    await boot(page);
    await expect(page.getByText("Welcome to Nook").first()).toBeVisible();
    await expect(page.getByText(/14 notes/).first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("notes: create, edit (autosave), search, delete", async ({ page }) => {
    await boot(page);
    await page.keyboard.press("Alt+n");
    const ta = page.locator("textarea.editor-ta");
    await expect(ta).toBeVisible();
    await ta.fill("# E2E Lighthouse\n\nThe keeper writes #e2e notes with [[Graph view]].\n- [ ] climb the stairs");
    await expect.poll(async () => (await api<any[]>("/api/notes")).some((n) => n.content.includes("keeper writes")), { timeout: 15_000 }).toBe(true);
    const created = (await api<any[]>("/api/notes")).find((n) => n.content.includes("keeper writes"));
    await st(page, `(s) => s.renameNote(${JSON.stringify(created.id)}, "E2E Lighthouse")`);
    await expect.poll(async () => (await api<any[]>("/api/notes")).find((n) => n.id === created.id)?.title, { timeout: 10_000 }).toBe("E2E Lighthouse");
    // command-palette search opens it
    await page.keyboard.press("Control+k");
    await page.getByPlaceholder("Search notes, or type > for commands").fill("Lighthouse");
    await page.keyboard.press("Enter");
    await expect(ta).toHaveValue(/E2E Lighthouse/);
    // sidebar filter
    await page.getByPlaceholder("Find or filter…").fill("lighthouse");
    await expect(page.getByText("E2E Lighthouse").first()).toBeVisible();
    await page.getByPlaceholder("Find or filter…").fill("");
    // delete
    const id = (await api<any[]>("/api/notes")).find((n) => n.title === "E2E Lighthouse").id;
    await st(page, `(s) => s.deleteNote(${JSON.stringify(id)})`);
    await expect.poll(async () => (await api<any[]>("/api/notes")).some((n) => n.id === id), { timeout: 10_000 }).toBe(false);
    expect(errors).toEqual([]);
  });

  test("folders: create, rename, move a note, delete", async ({ page }) => {
    await boot(page);
    await st(page, `(s) => s.createFolder("E2E Folder")`);
    await expect.poll(async () => (await api<any[]>("/api/folders")).some((f) => f.name === "E2E Folder")).toBe(true);
    const f = (await api<any[]>("/api/folders")).find((x) => x.name === "E2E Folder");
    await st(page, `(s) => s.renameFolder(${JSON.stringify(f.id)}, "E2E Renamed")`);
    await st(page, `(s) => s.updateNote("n-someday", { folderId: ${JSON.stringify(f.id)} })`);
    await expect(page.getByText("E2E Renamed").first()).toBeVisible();
    await expect.poll(async () => (await api<any[]>("/api/notes")).find((n) => n.id === "n-someday").folderId).toBe(f.id);
    await expect.poll(async () => (await api<any[]>("/api/folders")).find((x) => x.id === f.id)?.name).toBe("E2E Renamed");
    await st(page, `(s) => s.deleteFolder(${JSON.stringify(f.id)})`);
    await expect.poll(async () => (await api<any[]>("/api/notes")).find((n) => n.id === "n-someday").folderId).toBe(null);
  });

  test("tasks: add via UI, complete, persist", async ({ page }) => {
    await boot(page);
    await view(page, "Tasks");
    const input = page.getByPlaceholder("Add a task… type @ to mention, Enter to save");
    await input.fill("E2E water the plants");
    await input.press("Enter");
    await expect(page.getByText("E2E water the plants").first()).toBeVisible();
    await expect.poll(async () => (await api<any[]>("/api/tasks")).some((t) => t.title === "E2E water the plants")).toBe(true);
    const t = (await api<any[]>("/api/tasks")).find((x) => x.title === "E2E water the plants");
    await st(page, `(s) => s.toggleTask(${JSON.stringify(t.id)})`);
    await expect.poll(async () => (await api<any[]>("/api/tasks")).find((x) => x.id === t.id).done).toBe(true);
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__nook);
    await expect.poll(() => st(page, `(s) => s.tasks.find((x) => x.id === ${JSON.stringify(t.id)})?.done`)).toBe(true);
  });

  test("canvas: board renders, node added and saved", async ({ page }) => {
    await boot(page);
    await view(page, "Canvas");
    await expect(page.locator("[data-view=canvas]")).toBeVisible();
    const id = await st(page, `(s) => s.createCanvas("E2E board")`);
    await st(page, `(s) => s.setCanvasData(${JSON.stringify(id)}, (d) => ({ ...d, nodes: [...d.nodes, { id: "e2e", type: "text", x: 10, y: 10, w: 200, h: 100, text: "hello board" }] }))`);
    await expect.poll(async () => JSON.stringify((await api<any>("/api/bootstrap")).canvases), { timeout: 15_000 }).toContain("hello board");
  });

  test("pet: den, feed, species change persist", async ({ page }) => {
    await boot(page);
    await view(page, "Pet den");
    await expect(page.locator("[data-view=den] canvas").first()).toBeVisible();
    await st(page, `(s) => s.setSpecies("fox")`);
    await st(page, `(s) => s.patchPet((p) => ({ ...p, coins: p.coins + 5 }))`);
    await expect.poll(async () => (await api<any>("/api/pet")).species, { timeout: 10_000 }).toBe("fox");
    const lib = await api<any>("/api/pet-registry");
    expect(lib.folders.length).toBe(12);
  });

  test("arcade: all 13 games load and start", async ({ page }) => {
    await boot(page);
    await view(page, "Arcade");
    const titles = ["Catch the Notes", "Minesweeper", "Pixel Snake", "Flappy Pet", "Breakout", "Memory Match", "Whack-a-Note", "Reaction Test", "Simon Says", "Star Defender", "2048", "Math Blitz", "Falling Blocks"];
    for (const title of titles) {
      await page.locator(".game-card", { hasText: title }).first().click();
      const start = page.getByRole("button", { name: /Start/ });
      await expect(start).toBeVisible();
      await start.click();
      await page.waitForTimeout(400);
      await page.getByRole("button", { name: /All games/ }).click();
      await expect(page.locator(".game-card").first()).toBeVisible();
    }
    expect(errors).toEqual([]);
  });

  test("every view renders without errors", async ({ page }) => {
    await boot(page);
    for (const v of ["notes", "graph", "canvas", "tasks", "den", "focus", "arcade", "team", "market", "activity", "rules", "settings"]) {
      await st(page, `(s) => s.setView(${JSON.stringify(v)})`);
      await expect(page.locator(`[data-view=${v}]`)).toBeVisible();
      await page.waitForTimeout(350);
      await expect(page.locator(`[data-view=${v}]`).getByText("loading…")).toHaveCount(0, { timeout: 10_000 });
    }
    // team room connects to the Rust WebSocket room
    await st(page, `(s) => s.setView("team")`);
    await expect(page.getByText(/Nook Bot/).first()).toBeVisible({ timeout: 15_000 });
    expect(errors).toEqual([]);
  });

  test("market: buy a listing with coins", async ({ page }) => {
    await boot(page);
    const before = (await api<any>("/api/pet")).coins;
    const r = await page.evaluate(async () => (await fetch("/api/listings/l-3", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "buy" }) })).json());
    expect(r.ok).toBe(true);
    expect((await api<any>("/api/pet")).coins).toBe(before - 12);
  });

  test("settings persist across reloads", async ({ page }) => {
    await boot(page);
    await st(page, `(s) => s.setTheme("moss")`);
    await st(page, `(s) => s.set({ petNag: false })`);
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__nook);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "moss");
    expect(await st(page, `(s) => s.petNag`)).toBe(false);
    await st(page, `(s) => s.setTheme("graphite")`);
  });

  test("AI chat: offline brain + harness tools with no provider", async ({ page }) => {
    await boot(page);
    await page.request.put(`${API}/api/ai-config`, { data: { provider: "local" } });
    await st(page, `(s) => s.runAi("agent", { question: "add task: e2e offline brain task" })`);
    await expect.poll(() => st(page, `(s) => s.aiBusy`)).toBe(false);
    const last = await st(page, `(s) => s.aiLog[s.aiLog.length - 1]`) as any;
    expect(last.res.mode).toBe("local");
    expect(last.res.tools[0].name).toBe("create_task");
    expect((await api<any[]>("/api/tasks")).some((t) => t.title === "e2e offline brain task")).toBe(true);
    await st(page, `(s) => s.runAi("ask", { question: "what is the graph view?" })`);
    await expect.poll(() => st(page, `(s) => s.aiBusy`)).toBe(false);
    const ans = await st(page, `(s) => s.aiLog[s.aiLog.length - 1]`) as any;
    expect(ans.res.sources.length).toBeGreaterThan(0);
  });

  test("AI chat: mock OpenAI provider — streaming + agent tool loop", async ({ page }) => {
    await boot(page);
    const cfg = await (await page.request.put(`${API}/api/ai-config`, { data: { provider: "custom", baseUrl: "http://127.0.0.1:3299/v1", model: "mock-1" } })).json();
    expect(cfg.usable).toBe(true);
    // UI path: settings card test button
    await st(page, `(s) => { s.setView("settings"); s.set({ settingsSection: "ai" }); }`);
    await expect(page.getByTestId("ai-provider")).toBeVisible();
    await page.getByTestId("ai-provider").getByRole("button", { name: /Test/ }).click();
    await expect(page.getByText(/Connected: “MOCK REPLY/)).toBeVisible();
    // streamed answer through the chat
    await st(page, `(s) => { s.setView("notes"); s.openNote("n-graph"); s.runAi("summarize"); }`);
    await expect.poll(() => st(page, `(s) => s.aiBusy`)).toBe(false);
    const sum = await st(page, `(s) => s.aiLog[s.aiLog.length - 1]`) as any;
    expect(sum.res.mode).toBe("cloud");
    expect(sum.text).toContain("MOCK REPLY to: Summarize this note");
    expect(mockCalls.some((c) => c.stream)).toBe(true);
    // agent loop: model asks for a tool, Rust runs it, model answers
    await st(page, `(s) => s.runAi("agent", { question: "plan my day" })`);
    await expect.poll(() => st(page, `(s) => s.aiBusy`), { timeout: 20_000 }).toBe(false);
    const ag = await st(page, `(s) => s.aiLog[s.aiLog.length - 1]`) as any;
    expect(ag.res.mode).toBe("cloud");
    expect(ag.res.tools[0]).toMatchObject({ name: "create_task", ok: true });
    expect(ag.text).toContain("Mock agent finished");
    expect((await api<any[]>("/api/tasks")).find((t) => t.title === "Mock agent task")?.by).toBe("ai");
    // AI chat panel shows it
    await page.getByRole("button", { name: /^AI$/ }).first().click().catch(() => {});
    await page.request.put(`${API}/api/ai-config`, { data: { provider: "local" } });
    expect(errors).toEqual([]);
  });

  test("share: create link, worker ticks item, reader page", async ({ page }) => {
    await boot(page);
    const sh = await page.evaluate(async () => (await fetch("/api/share", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ noteId: "n-garden", mode: "collab" }) })).json());
    await page.goto(`${API}/share/${sh.id}`);
    await expect(page.getByText("Pixel garden project").first()).toBeVisible();
    await page.locator(".todo").nth(4).click();
    await expect.poll(async () => (await api<any>(`/api/share?shareId=${sh.id}`)).items[4].done).toBe(true);
    // in-app reader
    await page.goto(`/?share=${sh.id}`);
    await expect(page.getByText("Pixel garden project").first()).toBeVisible();
  });

  test("desktop widget page: capture, tasks, mini ask", async ({ page }) => {
    errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto("/widget.html");
    await expect(page.getByTestId("widget")).toBeVisible();
    await expect(page.getByText("Mochi").first()).toBeVisible();
    await page.getByLabel("Quick capture").fill("Widget idea\nfrom the desktop");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => (await api<any[]>("/api/notes")).some((n) => n.title === "Widget idea")).toBe(true);
    await page.getByLabel("as task").check();
    const wt = `Widget task ${Date.now()}`;
    await page.getByLabel("Quick capture").fill(wt);
    await page.getByLabel("Quick capture").press("Enter");
    await expect(page.getByText(wt).first()).toBeVisible();
    await page.locator(".widget-task", { hasText: wt }).locator("input").check();
    await expect.poll(async () => (await api<any[]>("/api/tasks")).find((t) => t.title === wt)?.done).toBe(true);
    await page.getByLabel("Ask the AI").fill("how many notes are in my vault stats?");
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await expect(page.getByTestId("widget-answer")).toContainText(/Vault/i, { timeout: 15_000 });
    expect(errors).toEqual([]);
  });

  test("MCP endpoint reachable from the settings self-test", async ({ page }) => {
    await boot(page);
    await st(page, `(s) => { s.setView("settings"); s.set({ settingsSection: "mcp" }); }`);
    await page.getByRole("button", { name: /Test connection/ }).click();
    await expect(page.getByText(/Nook Workspace MCP v/)).toBeVisible();
    await expect(page.getByText(/26 tools live/)).toBeVisible();
  });
});
