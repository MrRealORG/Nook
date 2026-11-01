// 1.4 screenshot set (mocked data): Timelens ▸ Websites, Rules (Shield), Meetings (live recording,
// summary, transcript), notes with the one-click delete + Undo toast.
// Needs the dev servers (:3210 with NOOK_FAKE_AUDIO=1 for the live recorder, + :4173).
//   node scripts/shots-v14.mjs <outdir>
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
const OUT = process.argv[2] || "shots/v14";
const API = "http://127.0.0.1:3210";
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const report = [];
const errors = [];
const post = (p, b, m = "POST") => fetch(API + p, { method: m, headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());

// ---------------------------------------------------------------- mock data
const now = Date.now();
const sites = [
  ["github.com", "MrRealORG/Nook: Pull requests", 9, 5, 42], ["docs.rs", "windows::Win32::Media::Audio - Rust", 9, 50, 25],
  ["stackoverflow.com", "WASAPI loopback capture silent output - Stack Overflow", 10, 20, 18], ["youtube.com", "Lo-fi beats to code to - YouTube", 10, 40, 30],
  ["tauri.app", "Global shortcut | Tauri", 11, 15, 16], ["chatgpt.com", "ChatGPT", 11, 35, 22], ["reddit.com", "r/rust", 12, 0, 12],
  ["figma.com", "Nook widget – Figma", 12, 15, 28], ["mail.google.com", "Inbox (3) - Gmail", 12, 45, 9], ["x.com", "Home / X", 12, 55, 7],
];
await post("/api/timelens/seed", {});
await post("/api/timelens/spans", {
  // laid back-to-back ending 5 min ago, so the shot never depends on the sandbox clock
  spans: (() => {
    let t = now - 5 * 60_000 - sites.reduce((a, x) => a + x[4] + 2, 0) * 60_000;
    return sites.map(([domain, title, , , mins]) => {
      const s = { app: "Chrome", title: `${title} - Google Chrome`, start: t, end: t + mins * 60_000, domain };
      t = s.end + 2 * 60_000;
      return s;
    });
  })(),
});
const noteSeeds = [
  ["Launch plan v1.4", "# Launch plan v1.4\n\n- [x] Timelens websites\n- [x] Rules / Shield\n- [ ] Meetings beta\n\nShip **Friday**. See [[Meeting notes]]."],
  ["Meeting notes", "# Meeting notes\n\nAction items from the weekly sync."],
  ["Reading list", "# Reading list\n\n- WASAPI loopback\n- Tauri v2 plugins"],
  ["Grocery run", "# Grocery run\n\n- milk\n- eggs"],
];
const existing = await fetch(API + "/api/notes").then((r) => r.json());
for (const [title, content] of noteSeeds) if (!existing.some((n) => n.title === title)) await post("/api/notes", { title, content });

const T0 = now - 2 * 3600_000;
const transcript = [
  ["You", 0, "Thanks for joining — let's lock the 1.4 launch plan."],
  ["Them", 6_000, "Sure. QA signed off on Timelens websites and the Shield yesterday."],
  ["You", 14_000, "Great. Meetings is the last piece; recording and transcripts work on Windows now."],
  ["Them", 22_000, "Can we ship on Friday? Marketing wants the post out Monday."],
  ["You", 30_000, "Friday works if the installer build is green. I'll send the deck on Thursday."],
  ["Them", 41_000, "I'll book the demo room and draft the changelog."],
  ["You", 50_000, "Perfect. Open question: do we enable auto-summaries by default?"],
  ["Them", 58_000, "Yes, with a clear note that audio stays on the PC."],
].map(([speaker, s, text]) => ({ speaker, startMs: s, endMs: s + 5_500, text }));
const summary = {
  title: "1.4 launch plan",
  summary: "The team agreed to ship Nook 1.4 on Friday once the Windows installer build is green. Timelens websites and the Shield passed QA; Meetings is the last feature.",
  keyPoints: ["QA signed off Timelens websites + Shield", "Meetings recording and transcripts work on Windows", "Marketing post goes out Monday"],
  decisions: ["Ship 1.4 on Friday", "Auto-summaries on by default, audio stays local"],
  actionItems: [{ task: "Send the launch deck", owner: "You", due: "Thursday" }, { task: "Book the demo room", owner: "Them", due: null }, { task: "Draft the changelog", owner: "Them", due: "Wednesday" }],
  openQuestions: ["Do we need a consent banner for recordings?"],
};
const meetings = [
  { id: "m-demo1", title: "Weekly sync — 1.4 launch", startedAt: T0, endedAt: T0 + 1_920_000, durationMs: 1_920_000, status: "summarized", devices: { devices: { you: "Microphone (USB Audio)", them: "Speakers (Realtek)" } }, chunks: [{ track: "you", n: 0, rms: 0.05, silent: false }], transcript, summary, noteId: null, error: null, engine: "groq:whisper-large-v3" },
  { id: "m-demo2", title: "Client call — Tarkplace", startedAt: T0 - 86_400_000, endedAt: T0 - 86_400_000 + 1_260_000, durationMs: 1_260_000, status: "transcribed", devices: null, chunks: [], transcript: transcript.slice(0, 3), summary: null, noteId: null, error: null, engine: "local-whisper-base" },
  { id: "m-demo3", title: "Design review", startedAt: T0 - 3 * 86_400_000, endedAt: T0 - 3 * 86_400_000 + 2_700_000, durationMs: 2_700_000, status: "recorded", devices: null, chunks: [], transcript: null, summary: null, noteId: null, error: null, engine: null },
];

// ---------------------------------------------------------------- helpers
async function snap(page, name, wait = 900) {
  await page.waitForTimeout(wait);
  const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  await page.screenshot({ path: `${OUT}/${name}.png` });
  report.push(`${OUT}/${name}.png${ov.sw > ov.cw ? `  ⚠ horizontal overflow ${ov.sw}>${ov.cw}` : ""}`);
}
async function open(prefs = { theme: "dark", uiStyle: "clean", onboarded: true, tourDone: true, v13: true }) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  await ctx.addInitScript((p) => {
    window.__NOOK_E2E__ = true;
    if (!sessionStorage.getItem("seeded")) {
      localStorage.clear();
      localStorage.setItem("nook:prefs", JSON.stringify(p));
      sessionStorage.setItem("seeded", "1");
    }
  }, prefs);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:4173/");
  await page.waitForFunction(() => !!window.__nook, null, { timeout: 30_000 });
  await page.waitForTimeout(1200);
  return { ctx, page };
}
const view = (page, v) => page.evaluate((v) => window.__nook.getState().setView(v), v);

// Timelens ▸ Websites + Rules
{
  const { ctx, page } = await open();
  await view(page, "timelens");
  await page.getByTestId("tl-tab-websites").click();
  await page.getByTestId("tl-site-search").waitFor();
  await snap(page, "timelens-websites", 1500);
  await view(page, "rules");
  await snap(page, "rules-shield", 1200);
  await ctx.close();
}

// Meetings: live recording (fake audio), then the mocked library
{
  const { ctx, page } = await open();
  await page.route(/\/api\/meetings$/, (r) => (r.request().method() === "GET" ? r.fulfill({ json: meetings }) : r.continue()));
  await page.route(/\/api\/meetings\/[^/]+\/(transcribe|summarize)$/, (r) => r.fulfill({ json: { ok: true, engine: "groq", pending: [] } }));
  await view(page, "meetings");
  await page.getByTestId("meeting-title").fill("Weekly sync");
  await page.getByTestId("meeting-start").click();
  const live = await page.getByTestId("meeting-timer").waitFor({ timeout: 8_000 }).then(() => true).catch(() => false);
  if (live) {
    await page.waitForTimeout(4_200);
    await snap(page, "meetings-recording", 300);
    await fetch(API + "/api/meetings/stop", { method: "POST" });
    const real = await fetch(API + "/api/meetings").then((r) => r.json());
    for (const m of real) if (m.title === "Weekly sync") await fetch(`${API}/api/meetings/${m.id}`, { method: "DELETE" });
  } else {
    report.push("(no NOOK_FAKE_AUDIO — skipped the live recorder shot)");
    await snap(page, "meetings-start-error");
  }
  await page.reload();
  await page.waitForFunction(() => !!window.__nook, null, { timeout: 30_000 });
  await view(page, "meetings");
  await page.getByTestId("meeting-item").first().click();
  await page.getByTestId("meeting-summary").waitFor();
  await snap(page, "meetings-summary");
  await page.getByTestId("meeting-tab-transcript").click();
  await snap(page, "meetings-transcript", 600);
  await ctx.close();
}

// Notes: open a note, one-click delete → Undo toast
{
  const { ctx, page } = await open();
  await page.evaluate(() => {
    const s = window.__nook.getState();
    const n = s.notes.find((x) => x.title === "Grocery run") ?? s.notes[0];
    const l = s.notes.find((x) => x.title === "Launch plan v1.4");
    if (l) s.openNote(l.id);
    if (n) s.openNote(n.id);
  });
  await page.getByTestId("note-delete").first().click();
  await snap(page, "notes-delete-undo", 700);
  // undo so the vault keeps the note
  await page.getByRole("button", { name: "Undo" }).first().click().catch(() => {});
  await ctx.close();
}

await browser.close();
console.log(report.join("\n"));
if (errors.length) console.log("PAGE ERRORS:\n" + errors.join("\n"));
