import { expect, test, chromium, type Page, type Browser } from "@playwright/test";
import { readFileSync } from "node:fs";

/* v1.3.1 bug-fix release: no app flash before onboarding, onboarding never blocked by a hung
   request, error boundary recovery, Whisper transcribes real speech (file path + fake mic),
   profile step, logs viewer, bug-report URL builder (no secrets), updater (mocked). */

const API = "http://127.0.0.1:3210";
let errors: string[] = [];

async function resetServerOnboarding() {
  await fetch(`${API}/api/ui-state`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ onboarded: false }) });
}

async function boot(page: Page, prefs: Record<string, unknown> | null = { tourDone: true, onboarded: true }, path = "/") {
  errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|WebSocket|ERR_CONNECTION/.test(m.text())) errors.push(m.text());
  });
  if (!prefs) await resetServerOnboarding();
  await page.addInitScript((p) => {
    (window as unknown as { __NOOK_E2E__: boolean }).__NOOK_E2E__ = true;
    if (!sessionStorage.getItem("seeded")) {
      localStorage.clear();
      if (p) localStorage.setItem("nook:prefs", JSON.stringify(p));
      sessionStorage.setItem("seeded", "1");
    }
  }, prefs);
  await page.goto(path);
}
const ready = (page: Page) => page.waitForFunction(() => !!(window as any).__nook, null, { timeout: 30_000 });

/** Chromium for the tests that must reach huggingface.co through the sandbox proxy */
function proxyOpt() {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!raw) return undefined;
  const u = new URL(raw);
  return { server: `${u.protocol}//${u.host}`, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password), bypass: "127.0.0.1,localhost" };
}
async function launch(args: string[] = []): Promise<Browser> {
  return chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, proxy: proxyOpt(), args });
}

test.describe.serial("Nook 1.3.1", () => {
  test("fresh profile: the first decided frame is the onboarding — the app never paints first", async ({ page }) => {
    // record what every animation frame shows from the very first one
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as any).__frames = seen;
      const tick = () => {
        const ob = document.querySelector('[data-testid="onboarding"]');
        const app = document.querySelector("[data-view], .rail, [data-testid='rail']");
        const s = ob ? "onboarding" : app ? "app" : "blank";
        if (seen[seen.length - 1] !== s) seen.push(s);
        if (!ob || seen.length < 2) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await boot(page, null);
    // the moment the desktop window would be shown (app_ready)
    await page.waitForFunction(() => (window as any).__nookReady === true, null, { timeout: 30_000 });
    const atReady = await page.evaluate(() => ({ ob: !!document.querySelector('[data-testid="onboarding"]'), app: !!document.querySelector("[data-view]") }));
    expect(atReady).toEqual({ ob: true, app: false });
    const shot = await page.screenshot();
    expect(shot.byteLength).toBeGreaterThan(10_000);
    await expect(page.getByTestId("onboarding")).toBeVisible();
    const frames = await page.evaluate(() => (window as any).__frames as string[]);
    expect(frames).not.toContain("app");
    expect(frames[frames.length - 1]).toBe("onboarding");
    // finishing writes the flag to localStorage AND the server
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("onboarding")).toHaveCount(0);
    await expect(page.locator("[data-view]")).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("nook:onboarded"))).toBe("1");
    const ui = await (await fetch(`${API}/api/ui-state`)).json();
    expect(ui.onboarded).toBe(true);
  });

  test("returning user: the app paints directly, no onboarding even with a wiped local profile (server flag)", async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__sawOb = false;
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="onboarding"]')) (window as any).__sawOb = true;
      }).observe(document, { subtree: true, childList: true });
    });
    // server says onboarded (previous test), local storage is empty
    await page.addInitScript(() => {
      (window as unknown as { __NOOK_E2E__: boolean }).__NOOK_E2E__ = true;
      if (!sessionStorage.getItem("seeded")) {
        localStorage.clear();
        sessionStorage.setItem("seeded", "1");
      }
    });
    await page.goto("/");
    await ready(page);
    await expect(page.locator("[data-view]")).toBeVisible();
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => (window as any).__sawOb)).toBe(false);
  });

  test("onboarding: Next and Skip are never blocked by a hung request (never-resolving /api/ai-models)", async ({ page }) => {
    await page.route("**/api/ai-models", () => {
      /* never fulfilled */
    });
    await page.route("**/api/ai-test", () => {
      /* never fulfilled */
    });
    await boot(page, null);
    const ob = page.getByTestId("onboarding");
    await expect(ob).toBeVisible();
    // walk to the AI step
    await page.getByTestId("ob-start").click();
    while ((await ob.getAttribute("data-step")) !== "ai") await page.getByTestId("ob-next").click();
    await page.getByTestId("ai-card-ollama").click();
    // the auto-detect request is now hanging: Next must still move on immediately
    const t0 = Date.now();
    await page.getByTestId("ob-next").click();
    await expect(ob).not.toHaveAttribute("data-step", "ai");
    expect(Date.now() - t0).toBeLessThan(2000);
    // back to AI: the hung request times out with a clear message instead of spinning forever
    await page.getByTestId("ob-back").click();
    await expect(ob).toHaveAttribute("data-step", "ai");
    await page.getByTestId("ai-card-ollama").click();
    await expect(page.getByText(/timed out after 4 s/)).toBeVisible({ timeout: 8000 });
    // Skip always closes
    await page.getByTestId("ob-skip").click();
    await expect(ob).toHaveCount(0);
  });

  test("error boundary: a crashing view shows a recovery card; Try again / Go to notes recover; onboarding has its own", async ({ page }) => {
    await boot(page);
    await ready(page);
    await page.evaluate(() => {
      (window as any).__nookCrash = "tasks";
      (window as any).__nook.getState().setView("tasks");
    });
    await expect(page.getByTestId("error-boundary")).toBeVisible();
    await expect(page.getByTestId("error-boundary")).toContainText("test crash in tasks");
    await page.getByTestId("err-retry").click();
    await expect(page.getByTestId("error-boundary")).toHaveCount(0);
    await expect(page.locator('[data-view="tasks"]')).toBeVisible();
    // crash again → "Go to notes"
    await page.evaluate(() => {
      (window as any).__nookCrash = "graph";
      (window as any).__nook.getState().setView("graph");
    });
    await expect(page.getByTestId("error-boundary")).toBeVisible();
    await page.getByTestId("err-notes").click();
    await expect(page.locator('[data-view="notes"]')).toBeVisible();
    // the crash was logged
    const logged = await page.evaluate(() => JSON.parse(localStorage.getItem("nook:logs") ?? "[]").some((e: any) => /crashed: test crash in graph/.test(e.msg)));
    expect(logged).toBe(true);
    // onboarding crash → "Skip onboarding" always gets you into the app
    await page.evaluate(() => {
      (window as any).__nookCrash = "onboarding";
      (window as any).__nook.getState().set({ onboardingOpen: true });
    });
    await expect(page.getByTestId("error-boundary")).toBeVisible();
    await expect(page.getByTestId("bug-report")).toHaveCount(0); // never auto-opened over the card
    await page.getByTestId("err-skip-onboarding").click();
    await expect(page.getByTestId("error-boundary")).toHaveCount(0);
    await expect(page.getByTestId("onboarding")).toHaveCount(0);
  });

  test("Whisper: real speech WAV through the transcription path (worker, bundled runtime, model from huggingface.co)", async () => {
    test.setTimeout(900_000);
    const browser = await launch();
    const page = await browser.newPage();
    try {
      await page.addInitScript(() => {
        (window as any).__NOOK_E2E__ = true;
        localStorage.setItem("nook:onboarded", "1");
        localStorage.setItem("nook:prefs", JSON.stringify({ tourDone: true, onboarded: true }));
      });
      await page.goto("http://localhost:4173/");
      await page.waitForFunction(() => !!(window as any).__nook, null, { timeout: 30_000 });
      const run = (file: string) =>
        page.evaluate(async (b) => {
          const m = await (window as any).__nookLoadAsr();
          const bytes = Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
          const t0 = performance.now();
          const text = await m.transcribeBlob(new Blob([bytes], { type: "audio/wav" }));
          return { text: text as string, ms: Math.round(performance.now() - t0), device: m.asrDevice() as string };
        }, readFileSync(file).toString("base64"));
      // 1) a real human recording (JFK inaugural address, public domain; 22 kHz STEREO → tests resample + downmix)
      const jfk = await run("e2e/fixtures/jfk.wav");
      console.log(`[asr] jfk transcript: "${jfk.text}" (${jfk.ms} ms incl. model download/load, ${jfk.device})`);
      const j = jfk.text.toLowerCase().replace(/[^a-z ]/g, "");
      expect(j).toContain("ask not what your country can do for you");
      expect(j).toContain("what you can do for your country");
      // 2) synthetic speech (espeak-ng, robotic voice) — the key words must come through
      const syn = await run("e2e/fixtures/speech.wav");
      console.log(`[asr] espeak transcript: "${syn.text}" (${syn.ms} ms, model cached)`);
      expect(syn.text.toLowerCase()).toMatch(/quick/);
      expect(syn.text.toLowerCase()).toMatch(/jump/);
    } finally {
      await browser.close();
    }
  });

  test("Whisper: the mic flow (fake capture device playing the WAV) records, transcribes and inserts into a note", async () => {
    test.setTimeout(600_000);
    const browser = await launch(["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${process.cwd()}/e2e/fixtures/jfk.wav`]);
    const ctx = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    try {
      await page.addInitScript(() => {
        (window as any).__NOOK_E2E__ = true;
        localStorage.setItem("nook:onboarded", "1");
        localStorage.setItem("nook:prefs", JSON.stringify({ tourDone: true, onboarded: true, layout: "nook" }));
      });
      await page.goto("http://localhost:4173/");
      await page.waitForFunction(() => !!(window as any).__nook, null, { timeout: 30_000 });
      // model already cached by the previous test in its own profile? (different profile) → preload
      await page.evaluate(async () => {
        const s = (window as any).__nook.getState();
        await s.createNote({ title: "Voice memo", content: "" });
      });
      const mic = page.getByTestId("mic-btn").first();
      await expect(mic).toBeVisible({ timeout: 20_000 });
      await mic.click();
      await expect(mic).toHaveAttribute("data-state", "recording");
      await page.waitForTimeout(11500); // the recording is 11 s and loops
      await mic.click();
      await expect
        .poll(async () => (await page.evaluate(() => { const s = (window as any).__nook.getState(); return s.notes.find((n: any) => n.id === s.activeId)?.content ?? ""; })).toLowerCase(), { timeout: 540_000, intervals: [2000] })
        .toContain("your country");
      const content = await page.evaluate(() => { const s = (window as any).__nook.getState(); return s.notes.find((n: any) => n.id === s.activeId)?.content ?? ""; });
      console.log(`[asr-mic] inserted: "${content.trim()}"`);
    } finally {
      await browser.close();
    }
  });

  test("onboarding profile step: upload + circular crop (256 px WebP), preset avatar, name, banner → title bar, chat bubble, dashboard, finale", async ({ page }) => {
    await boot(page, null);
    const ob = page.getByTestId("onboarding");
    await expect(ob).toBeVisible();
    await page.getByTestId("ob-start").click();
    await expect(ob).toHaveAttribute("data-step", "profile");
    // name
    await page.getByTestId("profile-name").fill("Ahmad");
    // upload a photo → cropper → zoom → use
    await page.getByTestId("profile-file").setInputFiles("e2e/fixtures/photo.png");
    await expect(page.getByTestId("avatar-cropper")).toBeVisible();
    await page.getByTestId("avatar-zoom").fill("1.6");
    const view = page.locator(".pf-crop-view");
    const b = (await view.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + 30, b.y + b.height / 2 + 10, { steps: 4 });
    await page.mouse.up();
    await page.getByTestId("avatar-crop-done").click();
    await expect(page.getByTestId("ob-heart")).toBeVisible();
    const av = await page.evaluate(() => (window as any).__nook.getState().profile.avatar as string);
    expect(av.startsWith("data:image/webp")).toBe(true);
    const dims = await page.evaluate(async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      return [img.naturalWidth, img.naturalHeight];
    }, av);
    expect(dims).toEqual([256, 256]);
    // presets work too (and switch back to the photo afterwards)
    await page.getByTestId("avatar-preset-bun").click();
    const preset = await page.evaluate(() => (window as any).__nook.getState().profile.avatar as string);
    expect(preset).not.toBe(av);
    expect(preset.startsWith("data:image/")).toBe(true);
    await page.getByTestId("profile-file").setInputFiles("e2e/fixtures/photo.png");
    await page.getByTestId("avatar-crop-done").click();
    // banner: downscaled to ≤ 1600 px wide
    await page.getByTestId("banner-file").setInputFiles("e2e/fixtures/banner.png");
    await expect.poll(() => page.evaluate(() => ((window as any).__nook.getState().profile.banner ?? "").length)).toBeGreaterThan(100);
    const bw = await page.evaluate(async () => {
      const img = new Image();
      img.src = (window as any).__nook.getState().profile.banner;
      await img.decode();
      return img.naturalWidth;
    });
    expect(bw).toBe(1600);
    // Mochi talks to you by name (typewriter bubble)
    await expect(page.getByTestId("ob-say")).toHaveAttribute("data-full", /Nice to meet you, Ahmad/);
    // jump to the end: the finale greets with picture + name
    await page.getByRole("tab", { name: /Step 8/ }).click();
    await expect(page.getByTestId("ob-finale-title")).toHaveText("Welcome home, Ahmad!");
    await expect(page.getByTestId("ob-finale-avatar")).toBeVisible();
    await page.getByTestId("ob-finish").click();
    await expect(ob).toHaveCount(0);
    // shown in the title bar, on the dashboard (banner + greeting), and persisted
    await expect(page.locator("header img, .titlebar img").first()).toBeVisible();
    await expect(page.getByTestId("dash-banner")).toBeVisible();
    await expect(page.locator("h1").filter({ hasText: "Ahmad" }).first()).toBeVisible();
    const p = await page.evaluate(() => JSON.parse(localStorage.getItem("nook:prefs") ?? "{}"));
    expect(p.profile.displayName).toBe("Ahmad");
    expect(p.profile.avatar.startsWith("data:image/webp")).toBe(true);
    // AI chat: the user's bubble carries the picture
    await page.evaluate(() => (window as any).__nook.getState().setView("chat"));
    await page.locator("textarea").first().fill("hello there");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("msg-user").first().getByTestId("me-avatar")).toBeVisible({ timeout: 15_000 });
    // Settings ▸ Profile edits the same profile
    await page.evaluate(() => (window as any).__nook.getState().setView("settings"));
    await expect(page.getByTestId("settings-profile")).toBeVisible();
    await expect(page.getByTestId("settings-profile").getByTestId("profile-name")).toHaveValue("Ahmad");
    expect(errors).toEqual([]);
  });

  test("logs viewer: Settings ▸ Logs tails live entries, filters by level, searches, copies and clears; also in the command palette", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await boot(page);
    await ready(page);
    await page.evaluate(() => {
      const s = (window as any).__nook.getState();
      s.set({ settingsSection: "logs" });
      s.setView("settings");
    });
    const v = page.getByTestId("logs-viewer");
    await expect(v).toBeVisible();
    // live: new entries appear without reopening
    await page.evaluate(() => {
      console.warn("e2e warn line kiwi");
      console.error("e2e error line mango");
    });
    await expect(v.getByText("e2e warn line kiwi")).toBeVisible();
    await expect(v.getByText("e2e error line mango")).toBeVisible();
    await page.getByTestId("logs-level-error").click();
    await expect(v.getByText("e2e error line mango")).toBeVisible();
    await expect(v.getByText("e2e warn line kiwi")).toHaveCount(0);
    await page.getByTestId("logs-level-all").click();
    await page.getByTestId("logs-search").fill("kiwi");
    await expect(page.getByTestId("log-row")).toHaveCount(1);
    await page.getByTestId("logs-copy").click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("e2e warn line kiwi");
    await page.getByTestId("logs-search").fill("");
    // verbose toggle (off by default) is persisted
    await expect(page.getByTestId("logs-verbose")).not.toBeChecked();
    await page.getByTestId("logs-verbose").check();
    expect(await page.evaluate(() => localStorage.getItem("nook:verboseLogs"))).toBe("1");
    await page.getByTestId("logs-clear").click();
    await expect(page.getByTestId("log-row")).toHaveCount(0);
    // command palette entries
    await page.evaluate(() => (window as any).__nook.getState().setView("notes"));
    await page.keyboard.press("Control+k");
    await page.keyboard.type("open logs");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("logs-viewer")).toBeVisible();
    await page.keyboard.press("Control+k");
    await page.keyboard.type("report a bug");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("bug-report")).toBeVisible();
  });

  test("bug report: GitHub issue URL is prefilled, trimmed to the URL limit, and never contains a secret", async ({ page }) => {
    await boot(page);
    await ready(page);
    const SECRETS = ["sk-or-v1-0123456789abcdefABCDEF0123456789", "AIzaSyD-THIS_IS_A_FAKE_GOOGLE_KEY_123456", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "hunter2-super-secret-pass"];
    // secrets planted in logs, settings and the description
    await page.evaluate((sec) => {
      console.error(`provider failed apiKey=${sec[0]} while calling`);
      console.warn(`google key ${sec[1]} rejected; Authorization: Bearer ${sec[2]}`);
      localStorage.setItem("nook:test-api-key", sec[3]);
      const s = (window as any).__nook.getState();
      s.patchProfile({ passHash: "abcdef0123456789abcdef0123456789abcdef0123456789" });
      for (let i = 0; i < 400; i++) console.warn(`filler log line ${i} ` + "x".repeat(60));
    }, SECRETS);
    // Settings ▸ About → Report a bug
    await page.evaluate(() => {
      const s = (window as any).__nook.getState();
      s.set({ settingsSection: "about" });
      s.setView("settings");
    });
    await page.getByTestId("about-report-bug").click();
    await expect(page.getByTestId("bug-report")).toBeVisible();
    await page.getByTestId("bug-what").fill(`The onboarding froze. my token: ${SECRETS[3]}`);
    await page.getByTestId("bug-steps").fill("1. open Nook\n2. click Next");
    await page.getByTestId("bug-send").click();
    const url = await page.waitForFunction(() => (window as any).__lastIssueUrl as string).then((h) => h.jsonValue());
    expect(url.startsWith("https://github.com/MrRealORG/Nook/issues/new?title=")).toBe(true);
    expect(url.length).toBeLessThanOrEqual(7800);
    const body = decodeURIComponent(new URL(url).searchParams.get("body") ?? "");
    const title = new URL(url).searchParams.get("title") ?? "";
    expect(title).toContain("The onboarding froze");
    expect(body).toContain("### What happened");
    expect(body).toContain("### Steps to reproduce");
    expect(body).toContain("### System");
    expect(body).toMatch(/truncated/); // 400 filler lines don't fit in a URL
    for (const sec of SECRETS) {
      expect(url).not.toContain(sec);
      expect(body).not.toContain(sec);
    }
    expect(body).not.toContain("abcdef0123456789abcdef0123456789");
    expect(body).toContain("[redacted]");
    // the opened URL was recorded (E2E never spawns tabs)
    expect(await page.evaluate(() => (window as any).__nookOpened)).toContain(url);
    // Copy debug info (About) carries no secret either
    await page.keyboard.press("Escape");
    await page.getByTestId("about-copy-debug").click();
    const dbg = await page.waitForFunction(() => (window as any).__lastDebugInfo as string).then((h) => h.jsonValue());
    for (const sec of SECRETS) expect(dbg).not.toContain(sec);
    // pure builder: a huge body is trimmed under the limit
    const trimmed = await page.evaluate(async () => {
      const mod = "/src/lib/bugreport.ts";
      const m: any = await import(/* @vite-ignore */ mod).catch(() => null);
      return m ? m.githubIssueUrl("t", "y".repeat(50_000)).length : -1;
    });
    if (trimmed !== -1) expect(trimmed).toBeLessThanOrEqual(7800);
  });

  test("error screen + crash on next launch offer the bug report", async ({ page }) => {
    await boot(page);
    await ready(page);
    await page.evaluate(() => {
      (window as any).__nookCrash = "focus";
      (window as any).__nook.getState().setView("focus");
    });
    await page.getByTestId("err-report").click();
    await expect(page.getByTestId("bug-report")).toBeVisible();
    await expect(page.getByTestId("bug-what")).toHaveValue(/crashed: test crash in focus/);
    // the boundary error is remembered → next launch offers the report (after the 3 s defer)
    await page.reload();
    await ready(page);
    // a small dismissible toast, not a blocking modal
    await expect(page.getByTestId("crash-offer")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("bug-report")).toHaveCount(0);
    await page.getByTestId("crash-offer-report").click();
    await expect(page.getByTestId("bug-report")).toBeVisible();
    await expect(page.getByTestId("crash-offer")).toHaveCount(0);
  });

  test("updater (mocked check): card with notes, Later / Skip this version / Update now with progress; never during onboarding; 6 h throttle", async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__nookMockUpdate = {
        check: async () => ({ configured: true, available: true, current: "1.3.1", version: "1.3.2", notes: "- Faster onboarding\n- Bug fixes" }),
        install: async (p: (d: number, t: number) => void) => {
          for (let i = 1; i <= 4; i++) {
            await new Promise((r) => setTimeout(r, 120));
            p(i * 250, 1000);
          }
        },
      };
    });
    await boot(page);
    await ready(page);
    // manual check from Settings ▸ About
    await page.evaluate(() => {
      const s = (window as any).__nook.getState();
      s.set({ settingsSection: "about" });
      s.setView("settings");
    });
    await page.getByTestId("about-check-updates").click();
    const card = page.getByTestId("update-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Nook 1.3.2 is available");
    await expect(page.getByTestId("update-notes")).toContainText("Faster onboarding");
    await page.getByTestId("update-later").click();
    await expect(card).toHaveCount(0);
    expect(Number(await page.evaluate(() => localStorage.getItem("nook:lastUpdateCheck")))).toBeGreaterThan(0);
    await page.getByTestId("about-check-updates").click();
    await page.getByTestId("update-skip").click();
    expect(await page.evaluate(() => localStorage.getItem("nook:skipVersion"))).toBe("1.3.2");
    // Update now: progress bar runs to 100 %
    await page.getByTestId("about-check-updates").click();
    await page.getByTestId("update-now").click();
    await expect(page.getByTestId("update-progress")).toHaveAttribute("style", /width: 100%/, { timeout: 5000 });
    await expect(card).toContainText("relaunching");
    // automatic checks toggle is on by default and persists off
    await expect(page.getByTestId("about-auto-updates")).toBeChecked();
    await page.getByTestId("about-auto-updates").uncheck();
    expect(await page.evaluate(() => localStorage.getItem("nook:autoUpdate"))).toBe("0");
  });

  test("updater: the automatic check is deferred, throttled to 6 h, skipped during onboarding and silent when offline", async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__checks = 0;
      (window as any).__nookMockUpdate = { check: async () => { (window as any).__checks++; return { configured: true, available: false, current: "1.3.1", quietError: "offline", error: "dns error" }; } };
    });
    await boot(page, null);
    // onboarding open → the scheduled check does nothing, even after its delay
    await expect(page.getByTestId("onboarding")).toBeVisible();
    const r = await page.evaluate(async () => {
      const u = await (window as any).__nookLoadUpdater();
      u.scheduleAutoCheck(() => true, 50);
      await new Promise((res) => setTimeout(res, 200));
      const during = (window as any).__checks;
      u.scheduleAutoCheck(() => false, 50);
      await new Promise((res) => setTimeout(res, 200));
      const after = (window as any).__checks;
      // a check just happened → not due again for 6 h
      u.scheduleAutoCheck(() => false, 50);
      await new Promise((res) => setTimeout(res, 200));
      return { during, after, throttled: (window as any).__checks, due: [u.isDue(null, Date.now()), u.isDue(Date.now() - 5 * 3600_000, Date.now()), u.isDue(Date.now() - 7 * 3600_000, Date.now())], delay: u.FIRST_CHECK_DELAY_MS };
    });
    expect(r).toEqual({ during: 0, after: 1, throttled: 1, due: [true, false, true], delay: 30_000 });
    // offline → no toast, no card, just a log line
    await expect(page.getByTestId("update-card")).toHaveCount(0);
    const logged = await page.evaluate(() => JSON.parse(localStorage.getItem("nook:logs") ?? "[]").some((e: any) => /update check skipped: offline/.test(e.msg)));
    expect(logged).toBe(true);
  });
});
