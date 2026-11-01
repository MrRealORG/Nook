import { expect, test, type Page } from "@playwright/test";
import { explainStartError, fmtElapsed, levelBars, localSegments, statusLabel, transcriptPlain, warningChips } from "../src/lib/meetingsCore";

/* v1.4 Meetings: pure helpers + the Meetings view against the real Rust API.
   The recorder needs the dev API started with NOOK_FAKE_AUDIO=1 (synthetic two-track audio);
   without it the start must fail with the friendly "needs the Windows app" explanation. */

const API = "http://127.0.0.1:3210";

test.describe("meetings helpers", () => {
  test("format, levels, labels, errors", () => {
    expect(fmtElapsed(7_400)).toBe("0:07");
    expect(fmtElapsed(754_000)).toBe("12:34");
    expect(fmtElapsed(3_725_000)).toBe("1:02:05");
    expect(levelBars(0)).toBe(0);
    expect(levelBars(0.02)).toBeGreaterThanOrEqual(1);
    expect(levelBars(1)).toBe(12);
    expect(statusLabel({ status: "summarized", error: null }).tone).toBe("ok");
    expect(statusLabel({ status: "transcribed", error: "No AI model" }).text).toBe("Summary failed");
    expect(explainStartError("No audio device could be opened. Microphone: Access is denied. (0x80070005)").title).toBe("Microphone access is blocked");
    expect(explainStartError("No audio device could be opened. Microphone: Element not found. (0x80070490)").title).toBe("No audio device found");
    expect(explainStartError("Meeting recording uses Windows audio (WASAPI) — it works in the Windows app.").title).toMatch(/Windows app/);
    expect(warningChips(["Microphone: no default capture device", "System audio: nothing"])).toEqual(["No mic — only the other side is recorded", "No speaker output — only your mic is recorded"]);
    expect(transcriptPlain([{ speaker: "Them", startMs: 65_000, endMs: 70_000, text: "Ship Friday" }])).toBe("[1:05] Them: Ship Friday");
    expect(localSegments("  hello   world ")).toEqual([{ startMs: 0, endMs: 30_000, text: "hello world" }]);
    expect(localSegments("   ")).toEqual([]);
  });
});

async function boot(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __NOOK_E2E__: boolean }).__NOOK_E2E__ = true;
    if (!sessionStorage.getItem("seeded")) {
      localStorage.clear();
      localStorage.setItem("nook:prefs", JSON.stringify({ tourDone: true, onboarded: true, view: "meetings" }));
      sessionStorage.setItem("seeded", "1");
    }
  });
  await page.goto("/");
  await page.waitForFunction(() => !!(window as unknown as { __nook?: unknown }).__nook, null, { timeout: 30_000 });
  await page.evaluate(() => (window as unknown as { __nook: { getState: () => { setView: (v: string) => void } } }).__nook.getState().setView("meetings"));
  await expect(page.getByTestId("meetings-view")).toBeVisible();
}

test("record → pause → stop → transcript with You/Them → summary → note", async ({ page }) => {
  const live = await (await fetch(`${API}/api/meetings/live`)).json();
  expect(live.state).toBe("idle");
  await boot(page);

  // keep transcription deterministic: seed segments server-side when the UI asks for a transcript
  await page.route("**/api/meetings/*/transcribe", async (route) => {
    const id = route.request().url().split("/api/meetings/")[1].split("/")[0];
    const post = (track: string, segments: unknown[]) =>
      fetch(`${API}/api/meetings/${id}/segments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ track, n: 0, segments, engine: "e2e" }) });
    await post("you", [{ startMs: 0, endMs: 2_000, text: "Thanks for joining, let's plan the launch." }, { startMs: 9_000, endMs: 11_000, text: "I'll send the deck on Thursday." }]);
    await post("them", [{ startMs: 2_500, endMs: 6_000, text: "Can we ship on Friday?" }]);
    await route.fulfill({ json: { ok: true, engine: "groq:whisper-large-v3", done: 2, lines: 3, pending: [] } });
  });
  await page.route("**/api/meetings/*/summarize", (route) => route.fulfill({ json: { ok: false, error: "No AI model for the summary (e2e)" } }));

  await page.getByTestId("meeting-title").fill("Launch sync");
  await page.getByTestId("meeting-start").click();
  const fake = await page.getByTestId("meeting-timer").isVisible({ timeout: 5_000 }).catch(() => false);
  if (!fake) {
    // dev API without NOOK_FAKE_AUDIO: the friendly non-Windows explanation, nothing recorded
    await expect(page.getByTestId("meeting-error")).toContainText("Windows app");
    test.skip(true, "start the dev API with NOOK_FAKE_AUDIO=1 for the recording flow");
    return;
  }
  await expect(page.getByTestId("meter-you")).toBeVisible();
  await expect(page.getByTestId("meter-them")).toBeVisible();
  await expect.poll(async () => page.getByTestId("meeting-timer").textContent(), { timeout: 5_000 }).not.toBe("0:00");
  await page.getByTestId("meeting-pause").click();
  await expect(page.getByTestId("meeting-pause")).toContainText("Resume");
  await page.getByTestId("meeting-pause").click();
  await page.waitForTimeout(800);
  await page.getByTestId("meeting-stop").click();

  await expect(page.getByTestId("meeting-item").first()).toContainText("Launch sync");
  const tr = page.getByTestId("meeting-transcript");
  await page.getByTestId("meeting-tab-transcript").click();
  await expect(tr.locator("li")).toHaveCount(3, { timeout: 15_000 });
  await expect(tr.locator("li").nth(0)).toContainText("You");
  await expect(tr.locator("li").nth(1)).toContainText("Them");
  await expect(tr.locator("li").nth(1)).toContainText("Can we ship on Friday?");
  // summary failure is shown inline, not swallowed
  await expect(page.getByTestId("meeting-detail")).toContainText("No AI model", { timeout: 10_000 });

  // a successful summary → note → Open note
  await page.unroute("**/api/meetings/*/summarize");
  const notes = await (await fetch(`${API}/api/notes`)).json();
  const noteId = notes[0]?.id;
  await page.route("**/api/meetings/*/summarize", (route) => route.fulfill({ json: { ok: true, noteId } }));
  await page.getByTestId("meeting-summarize").click();
  await expect(page.getByText("Meeting summary saved as a note")).toBeVisible();

  // clean up
  const list = await (await fetch(`${API}/api/meetings`)).json();
  for (const m of list) if (m.title === "Launch sync") await fetch(`${API}/api/meetings/${m.id}`, { method: "DELETE" });
});
