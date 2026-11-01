import { create } from "zustand";
import { localOnboarded } from "@/lib/boot";
import type { IconName } from "@/components/icons";
import { flyCoins } from "@/lib/coinFly";
import { abilityOf, decayed, levelOf, stageOf } from "@/lib/pet";
import { QUESTS, bonusQuestOf, freshQuests, todayKey, yesterdayKey, type QuestsState } from "@/lib/quests";
import { sfx } from "@/lib/sfx";
import type { Mood } from "@/lib/sprite";
import { setIconStyle as applyIconStyle, type IconStyle } from "@/lib/iconStyle";
import { ALL_ON, featureOfView, normFeatures, viewEnabled, type FeatureId, type Features } from "@/lib/features";
import { LEGACY_DEFAULT_THEME, THEMES, isPremiumTheme, type ThemeId } from "@/lib/themes";
import { installLogger, logEvent } from "@/lib/logger";
import { isUiStyle, type UiStyleId } from "@/lib/uiStyles";
import type { AiEffect, AiResult, Canvas, CanvasData, Folder, InitialData, Listing, Note, Pet, PetBlueprint, PetFolderRow, PetLook, PetPack, Species } from "@/lib/types";
import { clamp, parseNote, titleKey, uid } from "@/lib/util";
import { DEFAULT_RULES, matchesRule, verdictFor, type BlockRule, type CatPattern, type RulesState, type Verdict, sha256 } from "@/lib/rules";
import type { AsrModelId } from "@/lib/asr";
import { loadPacksFromLocal, syncPacksFromServer, applyFontPack, persistPackPrefs, usePackStore } from "@/lib/packs";
import type { CustomGameDef } from "@/lib/gameEngines";

const usePackStoreFont = () => usePackStore.getState().fontPack;

export type View = "notes" | "graph" | "canvas" | "den" | "focus" | "arcade" | "team" | "market" | "tasks" | "activity" | "rules" | "settings" | "calendar" | "timelens" | "chat" | "meetings";
export type EditorMode = "write" | "split" | "read";
export type AiMsg = { id: number; role: "user" | "ai"; text: string; res?: AiResult; action?: string; fresh?: boolean };
export type TimerMode = "focus" | "short" | "long";
export const DURATIONS: Record<TimerMode, number> = { focus: 25 * 60, short: 5 * 60, long: 15 * 60 };
export type Streak = { last: string; count: number; best: number };
/** per-game arcade stats, keyed by game id */
export type GameStat = { plays: number; xp: number; last: number };
/** recent run history per game (last 12 scores, oldest → newest) — feeds the trend sparklines */
export type GameRuns = Record<string, number[]>;

// ---------- tasks / todos ----------
export type TaskList = "today" | "upcoming" | "someday";
export type Task = {
  id: string;
  title: string;
  list: TaskList;
  priority: 0 | 1 | 2;
  due: number | null;
  done: boolean;
  noteId: string | null;
  tags: string[];
  by: "you" | "ai" | "agent";
  createdAt: number;
  completedAt: number | null;
  /** kanban column (1.1) */
  status?: "todo" | "doing" | "done";
  /** reminder time (epoch ms) → native notification */
  remindAt?: number | null;
  /** "", daily, weekdays, weekly, monthly */
  repeat?: string;
};
/** app-usage seconds accumulated locally this session, keyed `${day}|${app}` */
export type AppUseMap = Record<string, number>;
export type AppCat = "productive" | "neutral" | "distraction";

type Toast = { id: number; text: string; icon: IconName; action?: { label: string; run: () => void } };
type Bubble = { id: number; text: string; action?: { label: string; noteId: string } } | null;
type Act = { mood: Mood; n: number } | null;

/** one entry in the notification center (bell inbox) */
export type Notice = { id: number; text: string; icon: IconName; kind: "sale" | "achievement" | "quest" | "level" | "info" | "task" | "pet"; at: number; fresh: boolean };
/** consecutive days where EVERY daily quest (incl. bonus) was claimed */
export type PerfectStreak = { last: string; count: number; best: number };
/** the human behind the pet — avatar/name/email/password stay browser-local */
export type Profile = { displayName: string; email: string; avatar: string; passHash: string; banner?: string }; // avatar = dataURL, passHash = sha-256 hex
export type FontId = "sans" | "pixel" | "serif" | "mono" | "round" | "silk" | (string & {});
/** whole-app background wallpaper (Settings → Appearance) */
export type Wallpaper = { id: string; img?: string; dim: number; blur: number };
/** where the sidebar lives: left rail, right rail, bottom dock, or a floating pill anywhere */
export type RailPos = "left" | "right" | "dock" | "float";
export type AttMeta = { id: string; noteId: string; name: string; mime: string; size: number; createdAt: string };
/** live market event feed (recent trades) */
export type MarketEvent = { id: number; text: string; icon: IconName; at: number; kind: "sold" | "listed" | "bought" | "removed" };
/** which notification kinds land in the bell inbox (Settings → Notifications) */
export type NotifKinds = Record<Notice["kind"], boolean>;
/** local voice-model status (transformers.js pipeline) */
export type AsrState = { status: "idle" | "loading" | "ready" | "error"; progress: number; model: AsrModelId | null; error: string | null };

// ---------- daily gift calendar ----------
/** escalating rewards for the 7-day gift cycle — day 7 is the party day */
export const DAILY_REWARDS: { coins: number; joy?: number }[] = [{ coins: 5 }, { coins: 8 }, { coins: 12 }, { coins: 16 }, { coins: 20 }, { coins: 26 }, { coins: 40, joy: 15 }];
/** gift cycle position: { last: day claimed, day: 1-7 } */
export type DailyGift = { last: string; day: number };
/** which gift (1-7) is waiting right now — null when today's was already claimed */
export function pendingGiftDay(g: DailyGift): number | null {
  const today = todayKey();
  if (g.last === today) return null;
  return g.last === yesterdayKey() ? (g.day % 7) + 1 : 1;
}

// ---------- persistence queue ----------
/** v1.4 one-click delete: notes waiting out their undo window before the vault DELETE */
export const UNDO_MS = 6000;
type PendingDelete = { note: Note; index: number; canvases: Canvas[]; wasActive: boolean; wasOpen: boolean; timer: ReturnType<typeof setTimeout> };
const pendingDeletes = new Map<string, PendingDelete>();
/** send every pending delete now (window closing / reload) — keepalive fetches survive unload */
export function flushDeletes() {
  for (const [id, p] of pendingDeletes) {
    clearTimeout(p.timer);
    void api("DELETE", `/api/notes/${id}`);
  }
  pendingDeletes.clear();
}
if (typeof window !== "undefined") window.addEventListener("pagehide", flushDeletes);

function api(method: string, url: string, body?: unknown) {
  const json = body === undefined ? undefined : JSON.stringify(body);
  const p = fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: json,
    keepalive: method === "DELETE" || (!!json && json.length < 60_000),
  }).catch(() => null);
  // keep the desktop widget in sync with task/note edits made here
  if (method !== "GET" && /^\/api\/(tasks|notes)/.test(url)) void p.then(() => import("@/lib/desktop").then((d) => d.broadcast("data-changed", { source: "main" })));
  return p;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const jobs = new Map<string, () => Promise<unknown> | void>();
let savingSetter: (v: boolean) => void = () => {};

async function runJob(key: string) {
  const job = jobs.get(key);
  timers.delete(key);
  jobs.delete(key);
  if (job) await job();
  if (jobs.size === 0) savingSetter(false);
}
function schedule(key: string, job: () => Promise<unknown> | void, delay = 700) {
  const t = timers.get(key);
  if (t) clearTimeout(t);
  jobs.set(key, job);
  savingSetter(true);
  timers.set(key, setTimeout(() => void runJob(key), delay));
}
export function flushAll() {
  for (const key of [...jobs.keys()]) {
    const t = timers.get(key);
    if (t) clearTimeout(t);
    void runJob(key);
  }
}

let seq = 1;
let wordBank = 0;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface S {
  notes: Note[];
  canvases: Canvas[];
  folders: Folder[];
  listings: Listing[];
  pet: Pet;
  view: View;
  activeId: string | null;
  activeCanvas: string | null;
  activeFolder: string | null;
  theme: ThemeId;
  /** full-app UI style: nook classic · pixelated soft · obsidian (Settings → Appearance) */
  uiStyle: UiStyleId;
  /** ultra-clean mode: hides EVERY side thing (rail + notes list + right panel) for one focused column */
  cleanMode: boolean;
  zen: boolean;
  sidebar: boolean;
  /** the notes list column on the left of the editor (independent of the rail) */
  notesList: boolean;
  /** open editor tabs, Obsidian-style (note ids, left→right) */
  openTabs: string[];
  /** pinned tabs never close on "close others / all" */
  tabPins: string[];
  /** Obsidian light mode (only means something when uiStyle = obsidian) */
  obsLight: boolean;
  /** pet proactive nags ("don't waste your time" etc.) on/off */
  petNag: boolean;
  rightOpen: boolean;
  rightTab: "info" | "ai";
  palette: boolean;
  editorMode: EditorMode;
  roam: boolean;
  follow: boolean;
  muted: boolean;
  volume: number;
  music: boolean;
  saving: boolean;
  tag: string | null;
  bubble: Bubble;
  act: Act;
  toasts: Toast[];
  aiLog: AiMsg[];
  aiBusy: boolean;
  gameScores: Record<string, number>;
  /** plays / total xp / last played per game — feeds the arcade stats center */
  gameStats: Record<string, GameStat>;
  /** last 12 scores per game — trend sparklines in the stats center */
  gameRuns: GameRuns;
  /** focus minutes per day (dateKey -> minutes) for the weekly focus chart */
  focusLog: Record<string, number>;
  achievements: string[];
  quests: QuestsState;
  streak: Streak;
  /** words written per day (dateKey -> words) for the writing heatmap */
  activity: Record<string, number>;
  help: boolean;
  /** arcade stats panel open */
  arcadeStats: boolean;
  /** marketplace sales seen while away — badge on the rail, cleared on entry */
  marketUnread: number;
  /** lifetime rotating-bonus-quest claims (feeds the Bonus Hunter achievement) */
  bonusClaims: number;
  /** bell inbox — history of achievements, sales, quests and milestones */
  notices: Notice[];
  /** notification center panel open */
  noticeOpen: boolean;
  /** consecutive all-quests-claimed days (Perfect Day streak) */
  questStreak: PerfectStreak;
  /** recent market activity for the pulse ticker */
  marketFeed: MarketEvent[];
  /** wishlist — listingId → the price at your last wish/alert; alerts fire when the price drops below it */
  wishlist: Record<string, number>;
  /** 7-day daily gift calendar state */
  dailyGift: DailyGift;
  timer: { mode: TimerMode; total: number; remaining: number; endsAt: number | null; running: boolean; sessions: number };
  // ---------- tasks / todos ----------
  tasks: Task[];
  tasksLoaded: boolean;
  // ---------- app-usage tracking (TimeLens-style) ----------
  appUse: AppUseMap;
  /** hourly category buckets for the timeline strip, keyed `${day}|${hour}|${cat}` → secs */
  appTimeline: Record<string, number>;
  appCat: Record<string, AppCat>;
  /** manual "what am I doing right now" dock app */
  currentApp: string | null;
  /** daily productive-time goal in minutes */
  activityGoal: number;
  // ---------- rules / admin manager (TimeLens-style controls) ----------
  rules: RulesState;
  /** when rules were edited behind a PIN, the unlocked verdict for this session */
  adminUnlocked: boolean;
  /** attempts to use blocked apps, keyed by day — feeds the "bounced" counter */
  blockedAttempts: number;
  // ---------- settings / ux ----------
  grain: boolean;
  effects: boolean;
  /** whole-app font family + UI scale (Settings → Appearance) */
  font: FontId;
  appScale: number;
  profile: Profile;
  /** user-added dock apps for the Activity tracker (persisted) */
  customDock: string[];
  notesDrawer: boolean;
  tourOpen: boolean;
  tourStep: number;
  tourDone: boolean;
  /** pet quick-chat popover: kind anchors the panel, pos is viewport px */
  quickChat: { kind: "desktop" | "den" | "rail"; x: number; y: number } | null;
  // ---------- notifications 2.0 ----------
  /** do-not-disturb: toasts go quiet, the bell keeps recording */
  dnd: boolean;
  /** which kinds are allowed into the bell inbox */
  notifKinds: NotifKinds;
  // ---------- logs & bugs ----------
  /** "report a bug / logs / my reports" modal */
  bugOpen: boolean;
  bugTab: "report" | "logs" | "reports";
  /** settings deep-link: "voice" opens the voice models section directly */
  settingsSection: string | null;
  // ---------- voice input ----------
  /** downloaded/selected local speech model (moonshine/whisper) */
  voiceModel: AsrModelId;
  /** live transformers.js pipeline status for the mic UI */
  asr: AsrState;
  // ---------- mention navigation ----------
  /** set when a task-mention chip is clicked — TasksView highlights + scrolls to it */
  taskJump: string | null;
  // ---------- pet library (registry) ----------
  petFolders: PetFolderRow[];
  petBlueprints: PetBlueprint[];
  registryLoaded: boolean;
  /** pet studio dialog: null = closed, "new" = create, or the blueprint id being edited */
  petStudio: string | null | "new";
  // ---------- customizable sidebar ----------
  railIcons: Partial<Record<View, IconName>>;
  railOrder: View[];
  railHidden: View[];
  /** rail edit mode (in-rail editing) */
  railEdit: boolean;
  /** 1.2 sidebar: collapsed to an icon rail (true) or expanded with labels (false) */
  sidebarCollapsed: boolean;
  /** sidebar position: left rail · right rail · bottom dock · floating pill */
  railPos: RailPos;
  /** floating pill position (viewport px) */
  railFloat: { x: number; y: number };
  /** master feature switches — turn the pet or any tab on/off (Settings → Features) */
  petEnabled: boolean;
  // ---------- 1.3 ----------
  /** icon set, independent of the colour theme */
  iconStyle: IconStyle;
  /** app layout: Nook (rail + panes) or Obsidian (ribbon · file tree · tabs · right sidebar) */
  layout: "nook" | "obsidian";
  /** feature switches (onboarding + Settings ▸ Features); off = hidden + no background work */
  features: Features;
  /** first-run onboarding finished (or skipped) */
  onboarded: boolean;
  onboardingOpen: boolean;
  /** quick switcher (Ctrl+O) */
  switcherOpen: boolean;
  /** whole-app wallpaper */
  wallpaper: Wallpaper;
  /** custom nook-games created/imported in the arcade */
  customGames: CustomGameDef[];
  /** packs studio dialog */
  packStudio: null | "import" | "icons" | "fonts";

  setRailPos: (p: RailPos) => void;
  setIconStyle: (s: IconStyle) => void;
  setLayout: (l: "nook" | "obsidian") => void;
  setFeature: (id: FeatureId, on: boolean) => void;
  isOn: (id: FeatureId) => boolean;
  updateFolder: (id: string, patch: Partial<Pick<Folder, "name" | "color" | "icon" | "pinned" | "parentId" | "position">>) => void;
  setRailFloat: (x: number, y: number) => void;
  setPetEnabled: (on: boolean) => void;
  setWallpaper: (w: Partial<Wallpaper>) => void;
  loadCustomGames: () => Promise<void>;
  addCustomGames: (defs: CustomGameDef[]) => Promise<void>;
  removeCustomGame: (id: string) => Promise<void>;
  setNoteTags: (id: string, tags: string[]) => void;
  setTaskTags: (id: string, tags: string[]) => void;

  hydrate: (d: InitialData) => void;
  loadPrefs: () => void;
  setView: (v: View) => void;
  set: (p: Partial<S>) => void;
  setTheme: (t: ThemeId) => void;
  setUiStyle: (s: UiStyleId, quiet?: boolean) => void;
  setObsLight: (b: boolean) => void;
  toggleClean: () => void;
  // note tabs (Obsidian-style editor tabs)
  closeTab: (id: string) => void;
  closeOtherTabs: (id: string) => void;
  closeAllTabs: () => void;
  toggleTabPin: (id: string) => void;
  moveTab: (id: string, dir: -1 | 1) => void;
  /** create-or-open today's daily note (Obsidian signature feature) */
  openDailyNote: () => void;
  toast: (text: string, icon?: IconName, action?: { label: string; run: () => void }, ms?: number) => void;
  /** v1.4: undo a one-click note delete while its undo window (6 s) is open */
  undoDelete: (id: string) => boolean;
  dismissToast: (id: number) => void;
  say: (text: string, action?: { label: string; noteId: string }, ms?: number) => void;
  doAct: (mood: Mood, ms: number) => void;
  clearAct: () => void;

  createNote: (init?: Partial<Pick<Note, "title" | "content" | "cover" | "folderId" | "tags">>) => string;
  updateNote: (id: string, patch: Partial<Pick<Note, "title" | "content" | "cover" | "pinned" | "folderId">>) => void;
  renameNote: (id: string, title: string) => void;
  deleteNote: (id: string) => void;
  openNote: (id: string) => void;
  openByTitle: (title: string) => void;

  createFolder: (name?: string, parentId?: string | null) => string;
  renameFolder: (id: string, name: string) => void;
  deleteFolder: (id: string) => void;
  setActiveFolder: (id: string | null) => void;

  createCanvas: (name?: string) => string;
  renameCanvas: (id: string, name: string) => void;
  deleteCanvas: (id: string) => void;
  setCanvasData: (id: string, fn: (d: CanvasData) => CanvasData) => void;

  exportNotes: () => void;
  importNotes: (file: File) => Promise<void>;

  patchPet: (fn: (p: Pet) => Pet) => void;
  tickPet: () => void;
  addWords: (n: number) => void;
  gain: (coins: number, xp: number) => void;
  setSpecies: (s: Species) => void;
  applyPetLook: (look: PetLook, name?: string) => void;
  loadRegistry: () => Promise<void>;
  saveBlueprint: (bp: Partial<PetBlueprint> & { name: string; species: Species; look: PetBlueprint["look"] }) => Promise<string | null>;
  removeBlueprint: (id: string) => Promise<void>;
  duplicateBlueprint: (bp: PetBlueprint) => Promise<void>;
  moveBlueprint: (id: string, folderId: string | null) => Promise<void>;
  newPetFolder: (name: string) => Promise<void>;
  renamePetFolder: (id: string, name: string) => Promise<void>;
  deletePetFolder: (id: string) => Promise<void>;
  importPetPack: (file: File) => Promise<void>;
  exportPetPack: (only?: string) => void;
  useBlueprint: (id: string) => void;
  setRailIcon: (view: View, icon: IconName) => void;
  moveRailItem: (view: View, dir: -1 | 1) => void;
  toggleRailHidden: (view: View) => void;
  resetRail: () => void;
  unlock: (key: string, title: string, desc: string, icon: IconName) => void;

  startTimer: () => void;
  pauseTimer: () => void;
  resetTimer: (mode?: TimerMode) => void;
  tick: () => void;

  setListings: (l: Listing[]) => void;
  questProgress: (key: string, delta?: number) => void;
  claimQuest: (id: string) => void;

  runAi: (action: string, opts?: { question?: string; style?: string; label?: string }) => Promise<void>;
  markAiSeen: (id: number) => void;

  notify: (text: string, icon?: IconName, kind?: Notice["kind"]) => void;
  markNoticesRead: () => void;
  markNoticeRead: (id: number) => void;
  markNoticesReadKind: (kind: Notice["kind"] | "all") => void;
  clearNotices: () => void;
  jumpToTask: (id: string) => void;
  pushMarket: (text: string, icon: IconName, kind: MarketEvent["kind"]) => void;
  toggleWish: (id: string, price: number) => void;
  claimDailyGift: () => void;

  // ---------- tasks ----------
  loadTasks: () => Promise<void>;
  createTask: (init?: Partial<Pick<Task, "title" | "list" | "priority" | "due" | "noteId" | "by" | "tags">>) => string;
  updateTask: (id: string, patch: Partial<Pick<Task, "title" | "list" | "priority" | "due" | "done" | "noteId" | "tags" | "status" | "remindAt" | "repeat">>) => void;
  toggleTask: (id: string) => void;
  deleteTask: (id: string) => void;
  clearDoneTasks: () => void;

  // ---------- app usage ----------
  trackApp: (app: string, secs: number) => void;
  syncAppUse: (force?: boolean) => Promise<void>;
  setAppCat: (app: string, cat: AppCat) => void;
  logManualApp: (app: string, mins: number) => Promise<void>;
  setCurrentApp: (app: string | null) => void;

  // ---------- rules / admin ----------
  setRules: (patch: Partial<RulesState>) => void;
  addBlock: (match: string) => void;
  toggleBlock: (id: string) => void;
  removeBlock: (id: string) => void;
  setLimit: (app: string, mins: number) => void;
  addPattern: (match: string, cat: AppCat) => void;
  removePattern: (id: string) => void;
  setAdminPin: (pin: string | null) => Promise<void>;
  /** true when a PIN gate exists and hasn't been unlocked this session */
  adminLocked: () => boolean;
  /** verify a PIN against the stored hash; unlocks admin for the session */
  verifyAdmin: (pin: string) => Promise<boolean>;
  checkAppRules: (app: string) => Verdict;

  // ---------- profile / appearance ----------
  patchProfile: (patch: Partial<Profile>) => void;
  setFont: (f: FontId) => void;
  setAppScale: (n: number) => void;
  addCustomDock: (app: string) => void;
  removeCustomDock: (app: string) => void;

  // ---------- attachments ----------
  attachments: Record<string, AttMeta[]>;
  loadAtts: (noteId: string) => Promise<void>;
  uploadAtt: (noteId: string, file: File) => Promise<void>;
  deleteAtt: (noteId: string, attId: string) => Promise<void>;

  // ---------- harness effects ----------
  applyEffects: (effects: AiEffect[] | undefined) => void;
  openQuickChat: (kind: "desktop" | "den" | "rail", x?: number, y?: number) => void;
  closeQuickChat: () => void;
  startTour: () => void;
  endTour: (done?: boolean) => void;
}

/** default rail (sidebar) layout — customizable in Settings → Sidebar */
export const RAIL_DEFAULT_ICONS: Record<View, IconName> = {
  notes: "notes", graph: "algorithm", canvas: "shapes", tasks: "tasklist", den: "dog", focus: "hourglass",
  arcade: "gamepad", team: "message-text", market: "coins", activity: "activity", rules: "shield", settings: "sliders",
  calendar: "calendar", timelens: "gauge", chat: "sparkles", meetings: "mic",
};
export const RAIL_DEFAULT_ORDER: View[] = ["notes", "calendar", "chat", "graph", "canvas", "tasks", "den", "focus", "arcade", "team", "market", "timelens", "meetings", "activity", "rules", "settings"];
/** saved rail order + any views added in newer versions (appended, never dropped) */
export function railOrderOf(saved: View[]): View[] {
  if (!saved.length) return RAIL_DEFAULT_ORDER;
  const known = saved.filter((v) => RAIL_DEFAULT_ORDER.includes(v));
  return [...known, ...RAIL_DEFAULT_ORDER.filter((v) => !known.includes(v))];
}
/** curated icon palette offered by the rail icon picker */
export const RAIL_ICON_CHOICES: IconName[] = [
  "notes", "notebook", "sticky-note", "algorithm", "shapes", "tasklist", "checkbox-on", "dog", "heart", "hourglass", "clock", "gamepad",
  "message-text", "inbox", "coins", "activity", "shield", "shield-on", "sliders", "sun", "moon", "sparkles", "target", "zap",
  "search", "library", "folder", "star", "fire", "leaf", "cloud", "palette", "pen-ruler", "mic", "book", "crown",
];

const BLANK_PET: Pet = {
  id: "pet-1", name: "Mochi", species: "cat", food: 80, energy: 90, joy: 70, xp: 0, coins: 120, hat: "none", owned: ["none"], tricks: ["wave", "spin"],
  stats: { words: 0, fed: 0, pats: 0, games: 0, focus: 0, best: 0, sold: 0, earned: 0, sales: 0, tricks: 0 }, look: {}, tickAt: 0,
};

/** apply the full UI chrome: style dataset + obsidian light/dark + real zoom scale */
/**
 * 1.2 look migration (runs once): new installs and users still on the 1.1 default
 * (classic "nook" style + "graphite") move to the Clean style. A brand-new install follows the OS
 * light/dark setting; a migrated user keeps a dark theme. Anyone who customised keeps their pick.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function migrateTo12(p: Record<string, any>): Record<string, any> {
  if (p.v12) return p;
  const fresh = p.theme === undefined && p.uiStyle === undefined;
  const onOldDefault = (p.uiStyle === undefined || p.uiStyle === "nook") && (p.theme === undefined || p.theme === LEGACY_DEFAULT_THEME);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: Record<string, any> = { ...p, v12: true };
  if (fresh || onOldDefault) {
    out.uiStyle = "clean";
    const dark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
    out.theme = fresh ? (dark ? "dark" : "light") : "dark";
    if (fresh) {
      try {
        if (!localStorage.getItem("nook:themeFollow")) localStorage.setItem("nook:themeFollow", JSON.stringify({ on: true, light: "light", dark: "dark" }));
      } catch {}
    }
  }
  try {
    localStorage.setItem("nook:prefs", JSON.stringify(out));
  } catch {}
  return out;
}

/**
 * 1.3 look migration (runs once): Pixel is the default again. Users that 1.2 moved to Clean
 * automatically go to Pixel (keeping their light/dark choice); anyone who picked Clean
 * themselves (recorded from 1.3 on in `nook:uiPicked`, and visible in 1.2's persisted log as
 * "ui style → clean") keeps it. The icon style follows: Clean pickers keep the lucide icons.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function migrateTo13(p: Record<string, any>, fresh = false): Record<string, any> {
  if (p.v13) return p;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: Record<string, any> = { ...p, v13: true };
  let picked = false;
  try {
    picked = localStorage.getItem("nook:uiPicked") === "clean" || (localStorage.getItem("nook:logs") ?? "").includes("ui style → clean");
  } catch {}
  if (fresh || (p.uiStyle === "clean" && !picked) || p.uiStyle === undefined) {
    out.uiStyle = "pixel";
    // fresh installs keep 1.2's OS-following light/dark pick (→ Pixel light / Pixel dark)
    if (!fresh && out.theme !== "light" && out.theme !== "dark") out.theme = THEMES[out.theme as ThemeId]?.dark === false ? "light" : "dark";
  }
  if (out.iconStyle !== "clean" && out.iconStyle !== "pixel") out.iconStyle = out.uiStyle === "clean" ? "clean" : "pixel";
  try {
    localStorage.setItem("nook:prefs", JSON.stringify(out));
  } catch {}
  return out;
}

function applyUiChrome(style: UiStyleId, obsLight: boolean, scale: number) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.ui = style;
  if (style === "obsidian") root.dataset.obsMode = obsLight ? "light" : "dark";
  else delete root.dataset.obsMode;
  root.style.setProperty("--app-scale", String(scale));
  (root.style as CSSStyleDeclaration & { zoom: string }).zoom = String(scale);
}

export const useStore = create<S>()((set, get) => {
  savingSetter = (v) => set({ saving: v });

  const savePet = () => schedule("pet", () => api("PUT", "/api/pet", get().pet), 1200);
  const saveNote = (id: string) =>
    schedule(`note:${id}`, () => {
      const n = get().notes.find((x) => x.id === id);
      if (n) return api("PATCH", `/api/notes/${id}`, { title: n.title, content: n.content, cover: n.cover, pinned: n.pinned, folderId: n.folderId, tags: n.tags });
    });
  const saveCanvas = (id: string, name = false) =>
    schedule(`canvas:${id}`, () => {
      const c = get().canvases.find((x) => x.id === id);
      if (c) return api("PATCH", `/api/canvases/${id}`, name ? { name: c.name, data: c.data } : { data: c.data });
    }, 900);

  return {
    notes: [],
    canvases: [],
    folders: [],
    listings: [],
    pet: BLANK_PET,
    view: "notes",
    activeId: null,
    activeCanvas: null,
    activeFolder: null,
    theme: "dark",
    uiStyle: "pixel",
    cleanMode: false,
    openTabs: [],
    tabPins: [],
    obsLight: false,
    petNag: true,
    zen: false,
    sidebar: true,
    notesList: true,
    rightOpen: true,
    rightTab: "info",
    palette: false,
    editorMode: "write",
    roam: true,
    follow: false,
    muted: false,
    volume: 0.5,
    music: false,
    saving: false,
    tag: null,
    bubble: null,
    act: null,
    toasts: [],
    aiLog: [],
    aiBusy: false,
    gameScores: {},
    gameStats: {},
    gameRuns: {},
    focusLog: {},
    achievements: [],
    quests: freshQuests(),
    streak: { last: "", count: 0, best: 0 },
    activity: {},
    help: false,
    arcadeStats: false,
    marketUnread: 0,
    bonusClaims: 0,
    notices: [],
    noticeOpen: false,
    questStreak: { last: "", count: 0, best: 0 },
    marketFeed: [],
    wishlist: {},
    dailyGift: { last: "", day: 0 },
    timer: { mode: "focus", total: DURATIONS.focus, remaining: DURATIONS.focus, endsAt: null, running: false, sessions: 0 },
    tasks: [],
    tasksLoaded: false,
    appUse: {},
    appTimeline: {},
    appCat: {},
    currentApp: null,
    activityGoal: 240,
    rules: DEFAULT_RULES,
    adminUnlocked: false,
    blockedAttempts: 0,
    grain: true,
    effects: true,
    font: "sans",
    appScale: 1,
    profile: { displayName: "", email: "", avatar: "", passHash: "" },
    customDock: [],
    notesDrawer: false,
    tourOpen: false,
    tourStep: 0,
    tourDone: false,
    quickChat: null,
    dnd: false,
    notifKinds: { sale: true, achievement: true, quest: true, level: true, info: true, task: true, pet: true },
    bugOpen: false,
    bugTab: "report",
    settingsSection: null,
    voiceModel: "whisper-tiny",
    asr: { status: "idle", progress: 0, model: null, error: null },
    taskJump: null,
    petFolders: [],
    petBlueprints: [],
    registryLoaded: false,
    petStudio: null,
    railIcons: {},
    railOrder: [],
    railHidden: [],
    railEdit: false,
    sidebarCollapsed: false,
    railPos: "left",
    railFloat: { x: 84, y: 120 },
    petEnabled: true,
    iconStyle: "pixel",
    layout: "nook",
    features: { ...ALL_ON },
    onboarded: false,
    onboardingOpen: false,
    switcherOpen: false,
    wallpaper: { id: "none", dim: 0.55, blur: 2 },
    customGames: [],
    packStudio: null,

    hydrate: (d) =>
      set({
        notes: d.notes,
        canvases: d.canvases,
        folders: d.folders,
        listings: d.listings,
        pet: decayed(d.pet),
        activeCanvas: d.canvases[0]?.id ?? null,
      }),

    loadPrefs: () => {
      const narrow = typeof window !== "undefined" && window.innerWidth < 1024;
      try {
        const raw = JSON.parse(localStorage.getItem("nook:prefs") ?? "{}");
        const p = migrateTo13(migrateTo12(raw), raw.theme === undefined && raw.uiStyle === undefined);
        // persisted notices / market feed carry numeric ids from the previous session;
        // the id counter restarts at 1 on reload, which would collide keys — move it past them
        const persistedIds = [
          ...(Array.isArray(p.notices) ? p.notices : []),
          ...(Array.isArray(p.marketFeed) ? p.marketFeed : []),
        ].map((x) => Number(x?.id) || 0);
        seq = Math.max(seq, ...(persistedIds.length ? persistedIds : [0])) + 1;
        // daily streak: bump when first load of the day
        const today = todayKey();
        const st = (p.streak ?? { last: "", count: 0, best: 0 }) as Streak;
        let streak = st;
        if (st.last !== today) {
          const count = st.last === yesterdayKey() ? st.count + 1 : 1;
          streak = { last: today, count, best: Math.max(st.best, count) };
        }
        set({
          theme: p.theme ?? get().theme,
          uiStyle: isUiStyle(p.uiStyle) ? p.uiStyle : "pixel",
          iconStyle: p.iconStyle === "clean" ? "clean" : "pixel",
          layout: p.layout === "obsidian" ? "obsidian" : "nook",
          features: normFeatures(p.features),
          onboarded: localOnboarded() || get().onboarded || (p.onboarded ?? !!p.tourDone),
          cleanMode: p.cleanMode ?? false,
          roam: p.roam ?? true,
          follow: p.follow ?? false,
          editorMode: p.editorMode ?? "write",
          sidebar: narrow ? false : (p.sidebar ?? true),
          notesList: narrow ? false : (p.notesList ?? true),
          rightOpen: narrow ? false : (p.rightOpen ?? true),
          muted: p.muted ?? false,
          volume: p.volume ?? 0.5,
          music: p.music ?? false,
          gameScores: p.gameScores ?? {},
          gameStats: p.gameStats ?? {},
          gameRuns: p.gameRuns ?? {},
          focusLog: p.focusLog ?? {},
          achievements: p.achievements ?? [],
          quests: p.quests && p.quests.date === todayKey() ? p.quests : freshQuests(),
          streak,
          activity: p.activity ?? {},
          bonusClaims: p.bonusClaims ?? 0,
          notices: Array.isArray(p.notices) ? (p.notices as Notice[]).slice(0, 40).map((n) => ({ ...n, id: seq++, fresh: false })) : [],
          questStreak: p.questStreak ?? { last: "", count: 0, best: 0 },
          marketFeed: Array.isArray(p.marketFeed) ? (p.marketFeed as MarketEvent[]).slice(0, 6).map((m) => ({ ...m, id: seq++ })) : [],
          wishlist: p.wishlist && typeof p.wishlist === "object" ? (p.wishlist as Record<string, number>) : {},
          dailyGift: p.dailyGift ?? { last: "", day: 0 },
          appUse: p.appUse && typeof p.appUse === "object" ? (p.appUse as AppUseMap) : {},
          appTimeline: p.appTimeline && typeof p.appTimeline === "object" ? (p.appTimeline as Record<string, number>) : {},
          appCat: p.appCat && typeof p.appCat === "object" ? (p.appCat as Record<string, AppCat>) : {},
          currentApp: typeof p.currentApp === "string" ? p.currentApp : null,
          activityGoal: typeof p.activityGoal === "number" ? p.activityGoal : 240,
          rules: p.rules && typeof p.rules === "object" ? { ...DEFAULT_RULES, ...(p.rules as RulesState) } : DEFAULT_RULES,
          blockedAttempts: typeof p.blockedAttempts === "number" && p.blockedDay === todayKey() ? p.blockedAttempts : 0,
          font: (p.font && ["sans", "pixel", "serif", "mono", "round", "silk"].includes(p.font) ? p.font : "sans") as FontId,
          appScale: typeof p.appScale === "number" && p.appScale >= 0.85 && p.appScale <= 1.3 ? p.appScale : 1,
          profile: p.profile && typeof p.profile === "object" ? { ...get().profile, ...(p.profile as Profile) } : get().profile,
          customDock: Array.isArray(p.customDock) ? (p.customDock as string[]).slice(0, 12) : [],
          grain: p.grain ?? true,
          effects: p.effects ?? true,
          tourDone: p.tourDone ?? false,
          dnd: p.dnd ?? false,
          notifKinds: p.notifKinds && typeof p.notifKinds === "object" ? { ...get().notifKinds, ...(p.notifKinds as NotifKinds) } : get().notifKinds,
          voiceModel: (p.voiceModel && ["moonshine-tiny", "moonshine-base", "whisper-tiny", "whisper-base", "whisper-small"].includes(p.voiceModel) ? p.voiceModel : "whisper-tiny") as AsrModelId,
          railIcons: p.railIcons && typeof p.railIcons === "object" ? (p.railIcons as Partial<Record<View, IconName>>) : {},
          railOrder: Array.isArray(p.railOrder) ? (p.railOrder as View[]).filter((v) => RAIL_DEFAULT_ORDER.includes(v)) : [],
          railHidden: Array.isArray(p.railHidden) ? (p.railHidden as View[]) : [],
          railPos: ["left", "right", "dock", "float"].includes(p.railPos) ? (p.railPos as RailPos) : "left",
          // expanded by default on roomy windows; small screens start as an icon rail
          sidebarCollapsed: typeof p.sidebarCollapsed === "boolean" ? p.sidebarCollapsed : typeof window !== "undefined" && window.innerWidth < 1280,
          openTabs: Array.isArray(p.openTabs) ? (p.openTabs as string[]).filter((x) => typeof x === "string").slice(0, 14) : [],
          tabPins: Array.isArray(p.tabPins) ? (p.tabPins as string[]) : [],
          obsLight: p.obsLight ?? false,
          petNag: p.petNag ?? true,
          railFloat: p.railFloat && typeof p.railFloat.x === "number" ? (p.railFloat as { x: number; y: number }) : { x: 84, y: 120 },
          petEnabled: (p.petEnabled ?? true) && (p.features?.pet ?? true) !== false,
          wallpaper: p.wallpaper && typeof p.wallpaper === "object" && typeof p.wallpaper.id === "string" ? { id: p.wallpaper.id, img: typeof p.wallpaper.img === "string" ? p.wallpaper.img : undefined, dim: typeof p.wallpaper.dim === "number" ? p.wallpaper.dim : 0.55, blur: typeof p.wallpaper.blur === "number" ? p.wallpaper.blur : 2 } : { id: "none", dim: 0.55, blur: 2 },
        });
        loadPacksFromLocal();
        void syncPacksFromServer().then(() => {
          // re-apply the persisted font pack once server packs are loaded (custom fonts need their FontFace)
          const fp = usePackStoreFont();
          if (fp && fp !== "nook") applyFontPack(fp);
        });
        document.documentElement.dataset.grain = get().grain ? "on" : "off";
        document.documentElement.dataset.fx = get().effects ? "on" : "off";
        document.documentElement.dataset.font = get().font;
        applyUiChrome(get().uiStyle, get().obsLight, get().appScale);
        applyIconStyle(get().iconStyle);
        document.documentElement.dataset.layout = get().layout;
        // the server rulebook is the source of truth (AI harness + every browser write there);
        // local prefs keep a mirror for offline use, but a saved server rulebook always wins on boot
        void fetch("/api/rules")
          .then((r) => r.json())
          .then((j) => {
            if (j?.rules) get().set({ rules: { ...DEFAULT_RULES, ...j.rules } });
          })
          .catch(() => {});
        if (streak.count >= 3) get().unlock("streak-3", "Warming Up", "Visited 3 days in a row", "fire");
        if (streak.count >= 7) get().unlock("streak-7", "Week Streak", "Visited 7 days in a row", "fire");
      } catch {
        if (narrow) set({ sidebar: false, notesList: false, rightOpen: false });
      }
    },

    set: (p) => {
      set(p);
      try {
        const s = get();
        const old = JSON.parse(localStorage.getItem("nook:prefs") ?? "{}");
        localStorage.setItem(
          "nook:prefs",
          JSON.stringify({
            ...old, theme: s.theme, uiStyle: s.uiStyle, cleanMode: s.cleanMode, roam: s.roam, follow: s.follow, editorMode: s.editorMode, sidebar: s.sidebar, notesList: s.notesList, rightOpen: s.rightOpen,
            muted: s.muted, volume: s.volume, music: s.music, gameScores: s.gameScores, gameStats: s.gameStats, gameRuns: s.gameRuns, focusLog: s.focusLog, achievements: s.achievements, quests: s.quests, streak: s.streak, activity: s.activity, arcadeStats: s.arcadeStats, bonusClaims: s.bonusClaims, notices: s.notices, questStreak: s.questStreak, marketFeed: s.marketFeed, wishlist: s.wishlist, dailyGift: s.dailyGift,
            appUse: s.appUse, appTimeline: s.appTimeline, appCat: s.appCat, currentApp: s.currentApp, activityGoal: s.activityGoal, grain: s.grain, effects: s.effects, tourDone: s.tourDone,
            rules: s.rules, font: s.font, appScale: s.appScale, profile: s.profile, customDock: s.customDock, blockedAttempts: s.blockedAttempts, blockedDay: todayKey(),
            dnd: s.dnd, notifKinds: s.notifKinds, voiceModel: s.voiceModel, v12: true,
            railIcons: s.railIcons, railOrder: s.railOrder, railHidden: s.railHidden,
            railPos: s.railPos, railFloat: s.railFloat, sidebarCollapsed: s.sidebarCollapsed, petEnabled: s.petEnabled, wallpaper: s.wallpaper, iconPackPref: true, fontPackPref: true,
            openTabs: s.openTabs, tabPins: s.tabPins, obsLight: s.obsLight, petNag: s.petNag,
            iconStyle: s.iconStyle, layout: s.layout, features: s.features, onboarded: s.onboarded, v13: true,
          }),
        );
        persistPackPrefs();
      } catch {}
    },

    setView: (view) => {
      if (!viewEnabled(get().features, view)) view = "notes";
      const prev = get().view;
      set({ view, palette: false, noticeOpen: false, ...(view === "market" && prev !== "market" ? { marketUnread: 0 } : {}) });
      if (prev !== view) sfx("open");
    },

    notify: (text, icon = "sparkle", kind = "info") => {
      // respect the user's per-kind inbox settings (Settings → Notifications)
      if (get().notifKinds[kind] === false) return;
      const id = seq++;
      set((s) => ({ notices: [{ id, text, icon, kind, at: Date.now(), fresh: true }, ...s.notices].slice(0, 40) }));
    },

    jumpToTask: (id) => {
      set({ view: "tasks", taskJump: id, palette: false, noticeOpen: false });
      sfx("open");
      setTimeout(() => get().taskJump === id && set({ taskJump: null }), 3200);
    },

    markNoticesRead: () => set((s) => (s.notices.some((n) => n.fresh) ? { notices: s.notices.map((n) => (n.fresh ? { ...n, fresh: false } : n)) } : {})),

    markNoticeRead: (id) => set((s) => ({ notices: s.notices.map((n) => (n.id === id ? { ...n, fresh: false } : n)) })),

    markNoticesReadKind: (kind) =>
      set((s) => {
        const hit = s.notices.some((n) => n.fresh && (kind === "all" || n.kind === kind));
        if (!hit) return {};
        return { notices: s.notices.map((n) => (n.fresh && (kind === "all" || n.kind === kind) ? { ...n, fresh: false } : n)) };
      }),

    clearNotices: () => {
      set({ notices: [] });
      sfx("pop");
    },

    pushMarket: (text, icon, kind) => {
      const id = seq++;
      set((s) => ({ marketFeed: [{ id, text, icon, at: Date.now(), kind }, ...s.marketFeed].slice(0, 6) }));
    },

    toggleWish: (id, price) => {
      const s = get();
      const had = s.wishlist[id] != null;
      const wishlist = { ...s.wishlist };
      if (had) delete wishlist[id];
      else wishlist[id] = price;
      s.set({ wishlist });
      if (!had) {
        sfx("star");
        s.toast(`Added to your wishlist — you'll be pinged when the price drops`, "star");
        s.unlock("wishful", "Wishful Thinker", "Wishlisted a marketplace item", "star");
      } else {
        sfx("pop");
      }
    },

    claimDailyGift: () => {
      const s = get();
      const day = pendingGiftDay(s.dailyGift);
      if (day === null) return;
      const reward = DAILY_REWARDS[day - 1];
      set({ dailyGift: { last: todayKey(), day } });
      flyCoins(reward.coins);
      get().patchPet((p) => ({ ...p, coins: p.coins + reward.coins, joy: clamp(p.joy + (reward.joy ?? 0), 0, 100) }));
      sfx("win");
      s.toast(`Daily gift day ${day} — +${reward.coins} coins${reward.joy ? ` · +${reward.joy} joy` : ""}`, "gift");
      s.notify(`Daily gift day ${day} claimed — +${reward.coins} coins`, "gift", "quest");
      get().say(day === 7 ? "A full week of gifts! Party time!" : "A gift, just for showing up. I love days.");
      get().doAct("happy", 2800);
      get().unlock("daily-1", "Gifted", "Claimed your first daily gift", "gift");
      if (day === 7) get().unlock("daily-7", "Full Week", "Completed a 7-day gift cycle", "calendar");
    },

    setTheme: (theme) => {
      if (isPremiumTheme(theme) && !get().pet.owned.includes(theme)) {
        sfx("error");
        get().toast(`“${THEMES[theme].name}” is a rare theme — buy it in the Marketplace!`, "lock");
        return;
      }
      document.documentElement.dataset.theme = theme;
      get().set({ theme });
      // "follow system" is on: a pick that matches the OS mode fills that mode's slot; a pick
      // against it (a dark theme while the OS is light, or vice versa) means "keep this one",
      // so following stops — otherwise the next reload would silently undo the choice.
      try {
        const raw = JSON.parse(localStorage.getItem("nook:themeFollow") ?? "{}");
        if (raw.on && THEMES[theme]) {
          const osDark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
          const next = THEMES[theme].dark === osDark ? { ...raw, [osDark ? "dark" : "light"]: theme } : { ...raw, on: false };
          localStorage.setItem("nook:themeFollow", JSON.stringify(next));
        }
      } catch {}
      sfx("pop");
    },

    setObsLight: (b) => {
      get().set({ obsLight: b });
      applyUiChrome(get().uiStyle, b, get().appScale);
      sfx("pop");
      get().toast(b ? "Obsidian light mode" : "Obsidian dark mode", "moon");
      logEvent(`obsidian light → ${b}`, "info", "ui");
    },
    closeTab: (id) =>
      set((s) => {
        const openTabs = s.openTabs.filter((t) => t !== id);
        const activeId = s.activeId === id ? (openTabs[openTabs.length - 1] ?? null) : s.activeId;
        return { openTabs, tabPins: s.tabPins.filter((t) => t !== id), activeId };
      }),
    closeOtherTabs: (id) =>
      set((s) => ({ openTabs: [id], tabPins: s.tabPins.includes(id) ? [id] : [] })),
    closeAllTabs: () =>
      set((s) => ({ openTabs: s.tabPins.slice(0, 1), tabPins: s.tabPins.slice(0, 1), activeId: s.tabPins[0] ?? null })),
    toggleTabPin: (id) =>
      set((s) => ({ tabPins: s.tabPins.includes(id) ? s.tabPins.filter((t) => t !== id) : [...s.tabPins, id] })),
    moveTab: (id, dir) =>
      set((s) => {
        const i = s.openTabs.indexOf(id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= s.openTabs.length) return {};
        const openTabs = [...s.openTabs];
        [openTabs[i], openTabs[j]] = [openTabs[j], openTabs[i]];
        return { openTabs };
      }),
    openDailyNote: () => {
      const d = new Date();
      const title = `Daily — ${d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
      const hit = get().notes.find((n) => n.title.toLowerCase() === title.toLowerCase());
      if (hit) {
        get().openNote(hit.id);
        get().toast("Opened today's daily note", "calendar");
      } else {
        const wd = d.toLocaleDateString(undefined, { weekday: "long" });
        const id = get().createNote({
          title,
          content: `# ${title}\n\n## Wins\n- \n\n## Grateful for\n- \n\n## Today's TODOs\n- [ ] \n\n*Made at ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} · have a great ${wd}!*`,
        });
        get().toast("Daily note created", "calendar");
        void id;
      }
      sfx("pop");
    },

    setUiStyle: (uiStyle, quiet) => {
      applyUiChrome(uiStyle, get().obsLight, get().appScale);
      get().set({ uiStyle });
      try {
        localStorage.setItem("nook:uiPicked", uiStyle);
      } catch {}
      sfx("pop");
      const name = { clean: "Clean", nook: "Classic pixel", pixel: "Pixel", obsidian: "Obsidian" }[uiStyle];
      if (!quiet) get().toast(`UI style: ${name}`, "sparkle");
      logEvent(`ui style → ${uiStyle}`, "info", "ui");
    },

    toggleClean: () => {
      const next = !get().cleanMode;
      get().set({ cleanMode: next });
      sfx(next ? "close" : "open");
      if (next) get().toast("Ultra clean — everything on the sides is hidden. Big button up top brings it back.", "minus");
      logEvent(`clean mode ${next ? "on" : "off"}`, "info", "ui");
    },

    toast: (text, icon = "sparkle", action, ms) => {
      // do-not-disturb: the bell still records via notify(), but popups go quiet —
      // except toasts that carry an action (Undo), which must stay reachable
      if (get().dnd && !action) return;
      const id = seq++;
      set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, icon, action }] }));
      setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms ?? (action ? 6000 : 3200));
    },

    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

    undoDelete: (id) => {
      const p = pendingDeletes.get(id);
      if (!p) return false;
      clearTimeout(p.timer);
      pendingDeletes.delete(id);
      set((s) => {
        const notes = s.notes.some((n) => n.id === id) ? s.notes : [...s.notes.slice(0, p.index), p.note, ...s.notes.slice(p.index)];
        const canvases = s.canvases.map((c) => p.canvases.find((o) => o.id === c.id) ?? c);
        return { notes, canvases, activeId: p.wasActive ? id : s.activeId, openTabs: p.wasOpen && !s.openTabs.includes(id) ? [...s.openTabs, id] : s.openTabs };
      });
      p.canvases.forEach((c) => saveCanvas(c.id));
      get().toast(`Restored “${p.note.title || "Untitled"}”`, "note");
      return true;
    },

    say: (text, action, ms) => {
      const id = seq++;
      set({ bubble: { id, text, action } });
      setTimeout(() => get().bubble?.id === id && set({ bubble: null }), ms ?? 3800 + text.length * 45 + (action ? 3000 : 0));
    },

    doAct: (mood, ms) => {
      const n = seq++;
      set({ act: { mood, n } });
      setTimeout(() => get().act?.n === n && set({ act: null }), ms);
    },
    clearAct: () => set({ act: null }),

    // ---------- notes ----------
    createNote: (init) => {
      const id = uid();
      const now = Date.now();
      const note: Note = { id, title: init?.title ?? "Untitled", content: init?.content ?? "", cover: init?.cover ?? null, pinned: false, folderId: init?.folderId ?? get().activeFolder, tags: init?.tags ?? [], createdAt: now, updatedAt: now };
      set((s) => ({ notes: [note, ...s.notes], activeId: id, view: "notes", palette: false, openTabs: [...s.openTabs, id].slice(-14) }));
      void api("POST", "/api/notes", { id, title: note.title, content: note.content, cover: note.cover, folderId: note.folderId, tags: note.tags });
      sfx("pop");
      return id;
    },

    updateNote: (id, patch) => {
      set((s) => ({ notes: s.notes.map((n) => (n.id === id ? { ...n, ...patch, updatedAt: Date.now() } : n)) }));
      saveNote(id);
    },

    renameNote: (id, raw) => {
      const title = raw.trim() || "Untitled";
      const cur = get().notes.find((n) => n.id === id);
      if (!cur || cur.title === title) return;
      const oldKey = titleKey(cur.title);
      const re = new RegExp(`\\[\\[\\s*${escapeRe(cur.title.trim())}\\s*(?=[\\]|#])`, "gi");
      const changed: string[] = [id];
      const now = Date.now();
      const notes = get().notes.map((n) => {
        if (n.id === id) return { ...n, title, updatedAt: now };
        if (parseNote(n.content).links.some((l) => titleKey(l) === oldKey)) {
          changed.push(n.id);
          return { ...n, content: n.content.replace(re, `[[${title}`), updatedAt: now };
        }
        return n;
      });
      set({ notes });
      changed.forEach(saveNote);
      if (changed.length > 1) get().toast(`Updated ${changed.length - 1} link${changed.length > 2 ? "s" : ""} to the new title`, "link");
    },

    deleteNote: (id) => {
      // v1.4: one click deletes. The note leaves the UI at once and the vault DELETE is sent
      // after a 6 s undo window (or immediately when the window closes — see flushDeletes).
      const s0 = get();
      const index = s0.notes.findIndex((n) => n.id === id);
      if (index < 0) return;
      const note = s0.notes[index];
      const before = s0.canvases.filter((c) => c.data.nodes.some((n) => n.noteId === id));
      const canv: string[] = [];
      set((s) => ({
        notes: s.notes.filter((n) => n.id !== id),
        activeId: s.activeId === id ? null : s.activeId,
        openTabs: s.openTabs.filter((t) => t !== id),
        tabPins: s.tabPins.filter((t) => t !== id),
        canvases: s.canvases.map((c) => {
          const gone = c.data.nodes.filter((n) => n.noteId === id).map((n) => n.id);
          if (!gone.length) return c;
          canv.push(c.id);
          return { ...c, data: { ...c.data, nodes: c.data.nodes.filter((n) => !gone.includes(n.id)), edges: c.data.edges.filter((e) => !gone.includes(e.from) && !gone.includes(e.to)) } };
        }),
      }));
      canv.forEach((c) => saveCanvas(c));
      const prev = pendingDeletes.get(id);
      if (prev) clearTimeout(prev.timer);
      const timer = setTimeout(() => {
        pendingDeletes.delete(id);
        void api("DELETE", `/api/notes/${id}`);
      }, UNDO_MS);
      pendingDeletes.set(id, { note, index, canvases: before, wasActive: s0.activeId === id, wasOpen: s0.openTabs.includes(id), timer });
      sfx("sad");
      get().toast(`Deleted “${note.title || "Untitled"}”`, "trash", { label: "Undo", run: () => void get().undoDelete(id) }, UNDO_MS);
    },

    openNote: (id) =>
    set((s) => ({
      activeId: id,
      view: "notes",
      palette: false,
      openTabs: s.openTabs.includes(id) ? s.openTabs : [...s.openTabs, id].slice(-14),
    })),

    openByTitle: (title) => {
      const hit = get().notes.find((n) => titleKey(n.title) === titleKey(title));
      if (hit) get().openNote(hit.id);
      else {
        get().createNote({ title: title.trim(), content: `# ${title.trim()}\n\n` });
        get().toast(`Created “${title.trim()}”`, "note");
      }
    },

    // ---------- folders ----------
    createFolder: (name = "New folder", parentId = null) => {
      const id = uid();
      const position = get().folders.length;
      const colors = ["#f2c14e", "#6fb4f2", "#5fd29b", "#f27ba0", "#a98bf0", "#ffa06d"];
      const folder: Folder = { id, name: name.trim() || "New folder", icon: "folder", color: colors[position % colors.length], position, parentId, pinned: false };
      set((s) => ({ folders: [...s.folders, folder] }));
      void api("POST", "/api/folders", folder);
      sfx("pop");
      return id;
    },

    renameFolder: (id, name) => {
      set((s) => ({ folders: s.folders.map((f) => (f.id === id ? { ...f, name: name.trim() || f.name } : f)) }));
      void api("PATCH", `/api/folders/${id}`, { name: name.trim() });
    },

    deleteFolder: (id) => {
      const parent = get().folders.find((f) => f.id === id)?.parentId ?? null;
      set((s) => ({
        folders: s.folders.filter((f) => f.id !== id).map((f) => (f.parentId === id ? { ...f, parentId: parent } : f)),
        notes: s.notes.map((n) => (n.folderId === id ? { ...n, folderId: parent } : n)),
        activeFolder: s.activeFolder === id ? null : s.activeFolder,
      }));
      get().notes.filter((n) => n.folderId === null).forEach((n) => saveNote(n.id));
      void api("DELETE", `/api/folders/${id}`);
      sfx("close");
      get().toast("Folder removed — notes kept", "folder");
    },

    setActiveFolder: (id) => set({ activeFolder: id }),

    // ---------- export / import ----------
    exportNotes: () => {
      const s = get();
      if (s.notes.length === 0) {
        s.toast("Nothing to export yet — write a note first", "archive");
        return;
      }
      const data = { app: "nook", version: 1, exportedAt: Date.now(), notes: s.notes, folders: s.folders };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `nook-notes-${todayKey()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      sfx("win");
      s.toast(`Exported ${s.notes.length} notes + ${s.folders.length} folders`, "download");
      s.unlock("archivist", "Archivist", "Exported your notes as JSON", "archive");
    },

    importNotes: async (file) => {
      const s = get();
      if (file.size > 8_000_000) {
        sfx("error");
        s.toast("That archive is too large (8 MB max)", "close");
        return;
      }
      let parsed: { notes?: Note[]; folders?: Folder[] };
      try {
        parsed = JSON.parse(await file.text()) as { notes?: Note[]; folders?: Folder[] };
      } catch {
        sfx("error");
        s.toast("Not a valid Nook export file", "close");
        return;
      }
      const incoming = Array.isArray(parsed.notes) ? parsed.notes.filter((n) => n && typeof n.content === "string" && typeof n.title === "string") : [];
      if (!incoming.length) {
        sfx("error");
        s.toast("No notes found in that file", "close");
        return;
      }
      const existingIds = new Set(s.notes.map((n) => n.id));
      const existingTitles = new Set(s.notes.map((n) => titleKey(n.title)));
      const existingFolders = new Map(s.folders.map((f) => [f.name.toLowerCase(), f]));
      const newFolders: Folder[] = [];
      for (const f of parsed.folders ?? []) {
        const key = (f.name ?? "").toLowerCase();
        if (!key || existingFolders.has(key) || newFolders.some((x) => x.name.toLowerCase() === key)) continue;
        const folder: Folder = { id: uid(), name: f.name, icon: f.icon || "folder", color: f.color || "#b59fd0", position: s.folders.length + newFolders.length };
        newFolders.push(folder);
        existingFolders.set(key, folder);
      }
      const now = Date.now();
      const notesToAdd: Note[] = incoming.slice(0, 500).map((n) => {
        let id = n.id;
        let title = n.title;
        if (!id || existingIds.has(id)) id = uid();
        if (existingTitles.has(titleKey(title))) title = `${title} (imported)`;
        existingTitles.add(titleKey(title));
        const folderId = n.folderId ? existingFolders.get((parsed.folders ?? []).find((f) => f.id === n.folderId)?.name.toLowerCase() ?? "")?.id ?? null : null;
        return {
          id, title, content: n.content.slice(0, 60_000), cover: n.cover ?? null, pinned: false, folderId, tags: [],
          createdAt: n.createdAt ?? now, updatedAt: n.updatedAt ?? now,
        };
      });
      for (const f of newFolders) void api("POST", "/api/folders", f);
      for (const n of notesToAdd) void api("POST", "/api/notes", { id: n.id, title: n.title, content: n.content, cover: n.cover, folderId: n.folderId });
      set((st) => ({ notes: [...notesToAdd, ...st.notes], folders: [...st.folders, ...newFolders] }));
      sfx("achieve");
      s.toast(`Imported ${notesToAdd.length} notes${newFolders.length ? ` + ${newFolders.length} folders` : ""}`, "upload");
      get().unlock("time-traveler", "Time Traveler", "Imported notes into the vault", "upload");
      get().doAct("happy", 2400);
    },

    // ---------- canvases ----------
    createCanvas: (name = "New board") => {
      const id = uid();
      const data: CanvasData = { nodes: [], edges: [], view: { x: 0, y: 0, z: 1 } };
      set((s) => ({ canvases: [...s.canvases, { id, name, data, updatedAt: Date.now() }], activeCanvas: id }));
      void api("POST", "/api/canvases", { id, name, data });
      sfx("pop");
      return id;
    },
    renameCanvas: (id, name) => {
      set((s) => ({ canvases: s.canvases.map((c) => (c.id === id ? { ...c, name: name.trim() || "Board" } : c)) }));
      saveCanvas(id, true);
    },
    deleteCanvas: (id) => {
      set((s) => {
        const rest = s.canvases.filter((c) => c.id !== id);
        return { canvases: rest, activeCanvas: s.activeCanvas === id ? rest[0]?.id ?? null : s.activeCanvas };
      });
      void api("DELETE", `/api/canvases/${id}`);
    },
    setCanvasData: (id, fn) => {
      set((s) => ({ canvases: s.canvases.map((c) => (c.id === id ? { ...c, data: fn(c.data), updatedAt: Date.now() } : c)) }));
      saveCanvas(id);
    },

    // ---------- pet ----------
    patchPet: (fn) => {
      const p0 = decayed(get().pet);
      const p1 = fn(p0);
      set({ pet: p1 });
      savePet();
      const a = levelOf(p0.xp).level, b = levelOf(p1.xp).level;
      if (b > a) {
        sfx("level");
        get().toast(`${p1.name} reached level ${b}!`, "crown");
        get().notify(`${p1.name} reached level ${b}!`, "crown", "level");
        get().say(`Level ${b}! Look at me go!`);
        get().doAct("happy", 2800);
        get().unlock(`level-${b}`, `Level ${b}`, `${p1.name} grew to level ${b}`, "crown");
      }
      const sa = stageOf(levelOf(p0.xp).level).id, sb = stageOf(levelOf(p1.xp).level).id;
      if (sb > sa) {
        const stage = stageOf(levelOf(p1.xp).level);
        sfx("evolve");
        get().toast(`${p1.name} evolved into a ${stage.name} pet!`, "sparkles");
        get().say(`I evolved! ${stage.desc}`, undefined, 4200);
        get().doAct("spin", 3200);
        get().unlock("evolved", "Shiny and New", `${p1.name} reached the ${stage.name} stage`, "sparkles");
      }
    },
    tickPet: () => {
      const p = get().pet;
      const d = decayed(p);
      if (d !== p) set({ pet: d });
    },
    addWords: (n) => {
      if (n <= 0 || n > 250) return;
      get().questProgress("words", n);
      // writing heatmap: accumulate today's words
      const today = todayKey();
      const act = get().activity;
      const todayWords = (act[today] ?? 0) + n;
      const trimmed: Record<string, number> = { [today]: Math.min(todayWords, 20_000) };
      for (const k of Object.keys(act)) if (act[k] > 0 && k !== today) trimmed[k] = act[k];
      const keys = Object.keys(trimmed);
      if (keys.length > 380) keys.sort().slice(0, keys.length - 380).forEach((k) => delete trimmed[k]);
      get().set({ activity: trimmed });
      wordBank += n;
      if (wordBank >= 20) {
        const k = Math.floor(wordBank / 20);
        wordBank -= k * 20;
        flyCoins(k, { count: Math.min(6, k) });
        sfx("coin");
        get().patchPet((p) => ({ ...p, coins: p.coins + k, xp: p.xp + 3 * k, joy: Math.min(100, p.joy + k), stats: { ...p.stats, words: p.stats.words + 20 * k } }));
      }
    },
    gain: (coins, xp) =>
      get().patchPet((p) => {
        // level perk: +4% coins per level (max +40% at Lv 10+)
        const lvl = levelOf(p.xp).level;
        const bonus = 1 + Math.min(10, lvl) * 0.04;
        // species ability multipliers
        const ab = abilityOf(p.species);
        const cMult = bonus * (ab.coinMult ?? 1);
        const xMult = ab.xpMult ?? 1;
        return { ...p, coins: p.coins + Math.max(0, Math.round(coins * cMult)), xp: p.xp + Math.round(xp * xMult) };
      }),
    setSpecies: (species) => {
      get().patchPet((p) => ({ ...p, species }));
      get().doAct("spin", 1200);
      sfx("equip");
    },
    applyPetLook: (look, name) => {
      get().patchPet((p) => ({ ...p, look, name: name ? name.slice(0, 16) : p.name }));
      sfx("equip");
    },

    // ---------- pet library (registry) ----------
    loadRegistry: async () => {
      try {
        const r = await fetch("/api/pet-registry");
        const d = (await r.json()) as { folders: PetFolderRow[]; blueprints: PetBlueprint[] };
        set({ petFolders: d.folders ?? [], petBlueprints: d.blueprints ?? [], registryLoaded: true });
      } catch {
        get().toast("Could not load the pet library", "alert");
      }
    },
    saveBlueprint: async (bp) => {
      try {
        const r = await fetch("/api/pet-registry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bp) });
        if (!r.ok) throw new Error(await r.text());
        const row = (await r.json()) as PetBlueprint;
        set((s) => ({
          petBlueprints: s.petBlueprints.some((x) => x.id === row.id) ? s.petBlueprints.map((x) => (x.id === row.id ? row : x)) : [row, ...s.petBlueprints],
        }));
        return row.id;
      } catch {
        get().toast("Could not save this pet", "alert");
        return null;
      }
    },
    removeBlueprint: async (id) => {
      set((s) => ({ petBlueprints: s.petBlueprints.filter((b) => b.id !== id) }));
      await fetch(`/api/pet-registry/${id}`, { method: "DELETE" }).catch(() => {});
      sfx("trash");
    },
    duplicateBlueprint: async (bp) => {
      await get().saveBlueprint({ name: `${bp.name} copy`.slice(0, 24), species: bp.species, look: bp.look, folderId: bp.folderId, origin: "custom" });
      get().toast(`${bp.name} duplicated`, "copy");
    },
    moveBlueprint: async (id, folderId) => {
      set((s) => ({ petBlueprints: s.petBlueprints.map((b) => (b.id === id ? { ...b, folderId } : b)) }));
      await fetch(`/api/pet-registry/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ folderId }) }).catch(() => {});
    },
    newPetFolder: async (name) => {
      try {
        const r = await fetch("/api/pet-registry/folders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
        const row = (await r.json()) as PetFolderRow;
        set((s) => (s.petFolders.some((f) => f.id === row.id) ? s : { petFolders: [...s.petFolders, row] }));
        sfx("pop");
      } catch {
        get().toast("Could not create the folder", "alert");
      }
    },
    renamePetFolder: async (id, name) => {
      set((s) => ({ petFolders: s.petFolders.map((f) => (f.id === id ? { ...f, name } : f)) }));
      await fetch(`/api/pet-registry/${id}?type=folder`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }).catch(() => {});
    },
    deletePetFolder: async (id) => {
      const r = await fetch(`/api/pet-registry/${id}?type=folder`, { method: "DELETE" }).catch(() => null);
      if (r && !r.ok) {
        get().toast("Move the pets out of the folder first", "alert");
        return;
      }
      set((s) => ({ petFolders: s.petFolders.filter((f) => f.id !== id) }));
      sfx("trash");
    },
    importPetPack: async (file) => {
      try {
        const text = await file.text();
        const pack = JSON.parse(text) as PetPack;
        if (!pack || pack.format !== "nook-pets" || !Array.isArray(pack.pets)) {
          get().toast("That file isn't a nook-pets pack", "alert");
          return;
        }
        const r = await fetch("/api/pet-registry/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ folders: pack.folders ?? [], pets: pack.pets }) });
        if (!r.ok) throw new Error();
        const j = (await r.json()) as { created: number };
        await get().loadRegistry();
        sfx("achieve");
        get().toast(`Imported ${j.created} pet${j.created === 1 ? "" : "s"}!`, "sparkles");
        get().unlock("pet-importer", "Pet Collector", "Imported pets into the library", "sparkles");
      } catch {
        get().toast("Import failed — is that a valid pet pack?", "alert");
      }
    },
    exportPetPack: (only) => {
      const s = get();
      const folderName = new Map(s.petFolders.map((f) => [f.id, f.name]));
      const pets = s.petBlueprints.filter((b) => !only || b.folderId === only);
      const usedIds = new Set(pets.map((b) => b.folderId));
      const pack: PetPack = {
        format: "nook-pets",
        version: 1,
        exportedAt: new Date().toISOString(),
        folders: s.petFolders.filter((f) => usedIds.has(f.id)).map((f) => ({ id: f.id, name: f.name, position: f.position })),
        pets: pets.map((b) => ({ name: b.name, species: b.species, folderName: b.folderId ? folderName.get(b.folderId) : undefined, look: b.look, origin: b.origin })),
      };
      const blob = new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = only ? `nook-pets-${only}.json` : "nook-pets.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      sfx("pop");
      get().toast(`Exported ${pets.length} pet${pets.length === 1 ? "" : "s"}`, "download");
      if (pets.length > 0) get().unlock("pet-exporter", "Pet Dealer", "Exported pets from the library", "download");
    },
    useBlueprint: (id) => {
      const bp = get().petBlueprints.find((b) => b.id === id);
      if (!bp) return;
      get().patchPet((p) => ({ ...p, name: bp.name.slice(0, 16), species: bp.species, look: { ramp: bp.look.ramp, accent: bp.look.accent } }));
      sfx("equip");
      get().doAct("spin", 1600);
      get().toast(`${bp.name} is now your companion!`, "sparkles");
      get().say(bp.look.says?.[0] ?? "Wow, I feel brand new!");
      get().notify(`${bp.name} is your active companion now`, "sparkles", "pet");
      get().questProgress("care");
      get().unlock("pet-swap", "Shapeshifter", "Used a pet from the library as your companion", "sparkles");
    },
    setRailIcon: (view, icon) => {
      get().set({ railIcons: { ...get().railIcons, [view]: icon } });
      sfx("pop");
    },
    moveRailItem: (view, dir) => {
      const order = [...railOrderOf(get().railOrder)];
      const i = order.indexOf(view);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= order.length) return;
      [order[i], order[j]] = [order[j], order[i]];
      get().set({ railOrder: order });
      sfx("pop");
    },
    toggleRailHidden: (view) => {
      const hidden = get().railHidden;
      get().set({ railHidden: hidden.includes(view) ? hidden.filter((v) => v !== view) : [...hidden, view] });
      sfx("pop");
    },
    resetRail: () => {
      get().set({ railIcons: {}, railOrder: [], railHidden: [] });
      get().toast("Sidebar reset to default", "reload");
    },

    // ---------- packs / layout / features ----------
    setRailPos: (p) => {
      get().set({ railPos: p });
      sfx("pop");
      get().toast(p === "dock" ? "Sidebar is now a bottom dock" : p === "float" ? "Sidebar floats — drag it anywhere" : p === "right" ? "Sidebar moved to the right" : "Sidebar back on the left", "layout");
    },
    setRailFloat: (x, y) => get().set({ railFloat: { x: Math.round(x), y: Math.round(y) } }),
    setIconStyle: (iconStyle) => {
      applyIconStyle(iconStyle);
      get().set({ iconStyle });
      sfx("pop");
      logEvent(`icon style → ${iconStyle}`, "info", "ui");
    },
    setLayout: (layout) => {
      document.documentElement.dataset.layout = layout;
      get().set({ layout, ...(layout === "obsidian" ? { view: get().view === "notes" ? "notes" : get().view } : {}) });
      sfx("pop");
      logEvent(`layout → ${layout}`, "info", "ui");
    },
    isOn: (id) => get().features[id] !== false,
    setFeature: (id, on) => {
      const features = { ...get().features, [id]: on };
      const patch: Partial<S> = { features };
      if (id === "pet") patch.petEnabled = on;
      // leaving a view whose feature was just switched off
      if (!on && featureOfView(get().view) === id) patch.view = "notes";
      get().set(patch);
      void import("@/lib/featureEffects").then((m) => {
        void m.syncFeatures(features);
        void m.applyFeature(id, on);
      });
      logEvent(`feature ${id} → ${on ? "on" : "off"}`, "info", "features");
    },
    updateFolder: (id, patch) => {
      set((s) => ({ folders: s.folders.map((f) => (f.id === id ? { ...f, ...patch } : f)) }));
      void api("PATCH", `/api/folders/${id}`, patch);
    },
    setPetEnabled: (on) => {
      get().set({ petEnabled: on, features: { ...get().features, pet: on } });
      sfx(on ? "happy" : "close");
      get().toast(on ? `${get().pet.name} is back!` : `${get().pet.name} is resting — re-enable in Settings → Features`, "heart");
      get().notify(on ? `${get().pet.name} woke up and stretched` : `${get().pet.name} curled up for a long nap`, "heart", "pet");
    },
    setWallpaper: (w) => {
      get().set({ wallpaper: { ...get().wallpaper, ...w } });
      sfx("pop");
    },
    loadCustomGames: async () => {
      try {
        const rows = (await fetch("/api/games").then((r) => r.json())) as CustomGameDef[];
        if (Array.isArray(rows)) get().set({ customGames: rows });
      } catch {}
    },
    addCustomGames: async (defs) => {
      const next = [...get().customGames.filter((g) => !defs.some((d) => d.id === g.id)), ...defs].slice(0, 60);
      get().set({ customGames: next });
      try {
        await fetch("/api/games", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ games: next }) });
      } catch {}
      get().unlock("game-smith", "Game Smith", "Added a custom game to the arcade", "gamepad");
    },
    removeCustomGame: async (id) => {
      const next = get().customGames.filter((g) => g.id !== id);
      get().set({ customGames: next });
      try {
        await fetch("/api/games", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ games: next }) });
      } catch {}
      sfx("trash");
    },
    setNoteTags: (id, tags) => {
      const clean = [...new Set(tags.map((t) => t.trim().toLowerCase().replace(/^#/, "").slice(0, 24)).filter(Boolean))].slice(0, 12);
      set((s) => ({ notes: s.notes.map((n) => (n.id === id ? { ...n, tags: clean, updatedAt: Date.now() } : n)) }));
      void api("PATCH", `/api/notes/${id}`, { tags: clean });
      sfx("pop");
    },
    setTaskTags: (id, tags) => {
      const clean = [...new Set(tags.map((t) => t.trim().toLowerCase().replace(/^#/, "").slice(0, 24)).filter(Boolean))].slice(0, 12);
      set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, tags: clean } : t)) }));
      void api("PATCH", `/api/tasks/${id}`, { tags: clean });
      sfx("pop");
    },

    unlock: (key, title, desc, icon) => {
      const s = get();
      if (s.achievements.includes(key)) return;
      s.set({ achievements: [...s.achievements, key] });
      sfx("achieve");
      s.toast(`Achievement: ${title}`, icon);
      s.notify(`Achievement unlocked — ${title}`, icon, "achievement");
    },

    // ---------- timer ----------
    startTimer: () => {
      const t = get().timer;
      set({ timer: { ...t, running: true, endsAt: Date.now() + t.remaining * 1000 } });
      sfx("start");
      get().say(t.mode === "focus" ? "Focus time! I will guard the fort." : "Break time. Stretch!");
    },
    pauseTimer: () => {
      const t = get().timer;
      if (!t.running) return;
      set({ timer: { ...t, running: false, endsAt: null, remaining: Math.max(1, Math.ceil(((t.endsAt ?? Date.now()) - Date.now()) / 1000)) } });
    },
    resetTimer: (mode) => {
      const t = get().timer;
      const m = mode ?? t.mode;
      set({ timer: { ...t, mode: m, total: DURATIONS[m], remaining: DURATIONS[m], endsAt: null, running: false } });
    },
    tick: () => {
      const t = get().timer;
      if (!t.running || !t.endsAt) return;
      const rem = Math.ceil((t.endsAt - Date.now()) / 1000);
      if (rem > 0) {
        if (rem !== t.remaining) set({ timer: { ...t, remaining: rem } });
        if (rem <= 3) sfx("tick");
        return;
      }
      const wasFocus = t.mode === "focus";
      set({ timer: { ...t, running: false, endsAt: null, remaining: t.total, sessions: t.sessions + (wasFocus ? 1 : 0) } });
      if (wasFocus) {
        get().questProgress("focus");
        flyCoins(10);
        get().patchPet((p) => ({ ...p, coins: p.coins + 10, xp: p.xp + 25, joy: Math.min(100, p.joy + 12), stats: { ...p.stats, focus: p.stats.focus + Math.round(t.total / 60) } }));
        // weekly focus chart: log today's minutes
        const fk = todayKey();
        const fl = get().focusLog;
        const trimmedLog: Record<string, number> = { [fk]: Math.min(600, (fl[fk] ?? 0) + Math.round(t.total / 60)) };
        for (const k of Object.keys(fl)) if (k !== fk) trimmedLog[k] = fl[k];
        const fkeys = Object.keys(trimmedLog);
        if (fkeys.length > 60) fkeys.sort().slice(0, fkeys.length - 60).forEach((k) => delete trimmedLog[k]);
        get().set({ focusLog: trimmedLog });
        // v1.1: count sessions per day (Focus stats) and hand the block to Timelens so it shows as focus time
        try {
          const sk = "nook:focusSessions";
          const ss = JSON.parse(localStorage.getItem(sk) ?? "{}") as Record<string, number>;
          ss[fk] = (ss[fk] ?? 0) + 1;
          const keep = Object.keys(ss).sort().slice(-90);
          localStorage.setItem(sk, JSON.stringify(Object.fromEntries(keep.map((k) => [k, ss[k]]))));
        } catch {}
        const activeTitle = get().notes.find((n) => n.id === get().activeId)?.title;
        void fetch("/api/timelens/focus", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ start: Date.now() - t.total * 1000, end: Date.now(), label: activeTitle ? `Focus: ${activeTitle}` : "Focus session" }),
        }).catch(() => {});
        sfx("win");
        get().toast("Focus session complete  +10 coins", "hourglass");
        get().notify("Focus session complete — +10 coins", "hourglass", "info");
        get().say("Session complete! That was beautiful.");
        get().unlock("first-focus", "First Focus", "Finished your first focus session", "hourglass");
        if (get().timer.sessions >= 5) get().unlock("focus-5", "Deep Worker", "5 focus sessions completed", "hourglass");
      } else {
        get().toast("Break over. Ready when you are.", "clock");
      }
      get().doAct("happy", 3000);
    },

    setListings: (l) => set({ listings: l }),

    questProgress: (key, delta = 1) => {
      const s = get();
      const q = s.quests.date === todayKey() ? s.quests : freshQuests();
      const bump = (id: string, goal: number, title: string) => {
        if (q.claimed[id]) return;
        const before = q.progress[id] ?? 0;
        if (before >= goal) return;
        const after = Math.min(goal, before + delta);
        set({ quests: { ...get().quests, progress: { ...get().quests.progress, [id]: after } } });
        if (before < goal && after >= goal) {
          sfx("achieve");
          s.toast(`Quest complete: ${title} — claim it on the dashboard!`, "flag");
        }
      };
      const def = QUESTS.find((d) => d.id === key);
      if (def) bump(key, def.goal, def.title);
      // the daily bonus quest rides the same progress streams
      const bq = bonusQuestOf();
      if (bq.stream === key) bump("bonus", bq.goal, bq.title);
    },

    claimQuest: (id) => {
      const s = get();
      const def = id === "bonus" ? bonusQuestOf() : QUESTS.find((d) => d.id === id);
      if (!def) return;
      const q = s.quests.date === todayKey() ? s.quests : freshQuests();
      if (q.claimed[id] || (q.progress[id] ?? 0) < def.goal) return;
      set({ quests: { ...q, claimed: { ...q.claimed, [id]: true } } });
      flyCoins(def.coins);
      get().patchPet((p) => ({ ...p, coins: p.coins + def.coins, xp: p.xp + def.xp, joy: Math.min(100, p.joy + 4) }));
      sfx("buy");
      s.toast(`+${def.coins} coins · +${def.xp} XP — ${def.title}`, "coins");
      s.notify(`Quest reward — ${def.title} (+${def.coins} coins)`, "flag", "quest");
      get().unlock("quester", "Quest Seeker", "Claimed your first daily quest", "flag");
      if (id === "bonus") {
        const n = (get().bonusClaims ?? 0) + 1;
        get().set({ bonusClaims: n });
        if (n >= 5) get().unlock("bonus-5", "Bonus Hunter", "Claimed 5 rotating bonus quests", "star");
      }
      const allDone = QUESTS.every((d) => get().quests.claimed[d.id]) && !!get().quests.claimed.bonus;
      if (allDone) get().unlock("perfect-day", "Perfect Day", "Claimed every daily quest", "trophy");
      // perfect-day streak: consecutive days where every quest (incl. bonus) got claimed
      if (allDone && get().questStreak.last !== todayKey()) {
        const prev = get().questStreak;
        const count = prev.last === yesterdayKey() ? prev.count + 1 : 1;
        const streak = { last: todayKey(), count, best: Math.max(prev.best, count) };
        get().set({ questStreak: streak });
        const bonus = Math.min(15, count * 3);
        if (bonus > 0) {
          flyCoins(bonus);
          get().patchPet((p) => ({ ...p, coins: p.coins + bonus }));
          sfx("coin");
          get().toast(`Perfect-day streak ×${count} — +${bonus} bonus coins`, "fire");
          get().notify(`Perfect-day streak ×${count} — +${bonus} bonus coins`, "fire", "quest");
        }
        if (count >= 3) get().unlock("qstreak-3", "Consistent", "Every quest claimed 3 days in a row", "fire");
        if (count >= 7) get().unlock("qstreak-7", "Flawless Week", "7 perfect days in a row", "fire");
      }
    },

    // ---------- AI ----------
    runAi: async (action, opts = {}) => {
      const s = get();
      if (s.aiBusy) return;
      const note = s.notes.find((n) => n.id === s.activeId);
      const labels: Record<string, string> = { summarize: "Summarize this note", continue: "Continue writing", tags: "Suggest tags", title: "Suggest a title", links: "Find links", outline: "Outline", brainstorm: "Brainstorm sparks", rewrite: `Rewrite: ${opts.style ?? "tidy"}`, fetch: "Fetch a forgotten note" };
      const label = opts.question ?? opts.label ?? labels[action] ?? action;
      set((st) => ({ aiLog: [...st.aiLog.slice(-30), { id: seq++, role: "user", text: label, action }], aiBusy: true }));
      get().doAct("think", 20000);
      sfx("click");
      try {
        // streamed straight from the provider when one is configured (Settings → AI)
        const { handleAiRequest } = await import("@/server/aiRoute");
        const streamId = seq++;
        let streamed = false;
        const res = await handleAiRequest(
          {
            action, noteId: note?.id, title: note?.title, text: note?.content, question: opts.question, style: opts.style, persona: { name: s.pet.name, species: s.pet.species },
            // v1.4: conversation memory for follow-up questions in the side panel
            history: s.aiLog.slice(-16).filter((m) => m.text && !m.text.startsWith("> ⚠️")).map((m) => ({ role: m.role === "user" ? ("user" as const) : ("assistant" as const), content: m.role === "user" ? m.text : m.text.slice(0, 4000) })),
          },
          (full) => {
            if (!streamed) {
              streamed = true;
              set((st) => ({ aiLog: [...st.aiLog, { id: streamId, role: "ai", text: full, action }] }));
            } else set((st) => ({ aiLog: st.aiLog.map((m) => (m.id === streamId ? { ...m, text: full } : m)) }));
          },
        );
        if (streamed) set((st) => ({ aiLog: st.aiLog.map((m) => (m.id === streamId ? { ...m, text: res.text, res } : m)) }));
        else set((st) => ({ aiLog: [...st.aiLog, { id: seq++, role: "ai", text: res.text, res, action, fresh: true }] }));
        sfx("receive");
        get().doAct("happy", 1600);
        // harness: real work happened → side effects, quest credit + achievement
        if (res.tools?.length) {
          get().applyEffects(res.effects);
          get().questProgress("agent");
          get().unlock("tool-user", "Teamwork!", "Your AI companion ran a real tool for you", "sparkles");
          get().say(res.tools.length > 1 ? "I used my tools — check what I did!" : "I did the thing! Tools are fun.");
        } else get().applyEffects(res.effects);
      } catch {
        set((st) => ({ aiLog: [...st.aiLog, { id: seq++, role: "ai", text: "My brain wires got tangled. Try again?", action }] }));
        sfx("error");
        get().clearAct();
      } finally {
        set({ aiBusy: false });
      }
    },
    markAiSeen: (id) => set((s) => ({ aiLog: s.aiLog.map((m) => (m.id === id ? { ...m, fresh: false } : m)) })),

    // ---------- tasks ----------
    loadTasks: async () => {
      try {
        const r = await fetch("/api/tasks");
        const rows = (await r.json()) as Task[];
        set({ tasks: Array.isArray(rows) ? rows : [], tasksLoaded: true });
      } catch {
        set({ tasksLoaded: true });
      }
    },
    createTask: (init) => {
      const id = uid();
      const task: Task = {
        id,
        title: (init?.title ?? "").trim() || "New task",
        list: init?.list ?? "today",
        priority: init?.priority ?? 1,
        due: init?.due ?? null,
        done: false,
        noteId: init?.noteId ?? null,
        tags: init?.tags ?? [],
        by: init?.by ?? "you",
        createdAt: Date.now(),
        completedAt: null,
      };
      set((s) => ({ tasks: [task, ...s.tasks] }));
      void api("POST", "/api/tasks", { id, title: task.title, list: task.list, priority: task.priority, due: task.due, noteId: task.noteId, tags: task.tags, by: task.by });
      sfx("pop");
      get().questProgress("tasks");
      return id;
    },
    updateTask: (id, patch) => {
      // done ⇄ kanban status stay in sync locally the same way the Rust side does it
      const p: Partial<Task> = { ...patch };
      if (p.status) p.done = p.status === "done";
      else if (p.done !== undefined) p.status = p.done ? "done" : "todo";
      const before = get().tasks.find((t) => t.id === id);
      set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...p, completedAt: p.done === undefined ? t.completedAt : p.done ? (t.completedAt ?? Date.now()) : null } : t)) }));
      const req = api("PATCH", `/api/tasks/${id}`, patch);
      // finishing a repeating task spawns its next occurrence server-side → pull it in
      if (p.done && before?.repeat) void Promise.resolve(req).then(() => get().loadTasks());
    },
    toggleTask: (id) => {
      const t = get().tasks.find((x) => x.id === id);
      if (!t) return;
      const done = !t.done;
      get().updateTask(id, { done });
      if (done) {
        sfx("achieve");
        flyCoins(2, { count: 2 });
        get().gain(2, 4);
        get().toast(`Task done — +2 coins`, "check");
        get().doAct("happy", 1600);
      } else sfx("click");
    },
    deleteTask: (id) => {
      set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
      void api("DELETE", `/api/tasks/${id}`);
      sfx("close");
    },
    clearDoneTasks: () => {
      const done = get().tasks.filter((t) => t.done);
      set((s) => ({ tasks: s.tasks.filter((t) => !t.done) }));
      for (const t of done) void api("DELETE", `/api/tasks/${t.id}`);
      sfx("pop");
      get().toast(`Cleared ${done.length} finished task${done.length === 1 ? "" : "s"}`, "trash");
    },

    // ---------- app usage (TimeLens-style) ----------
    trackApp: (app, secs) => {
      if (secs <= 0) return;
      const s = get();
      const day = todayKey();
      const key = `${day}|${app}`;
      const nextVal = (s.appUse[key] ?? 0) + secs;
      // keep only today + yesterday buckets to stay tiny; today's data also syncs to the DB
      const next: AppUseMap = { [key]: nextVal };
      const yKey = `${yesterdayKey()}|${app}`;
      if (s.appUse[yKey]) next[yKey] = s.appUse[yKey];
      // hourly category buckets for the timeline strip (keep 2 days)
      const cat = categorize(app, s.appCat, s.rules.patterns);
      const hKey = `${day}|${new Date().getHours()}|${cat}`;
      const yH1 = `${yesterdayKey()}|${new Date().getHours()}`;
      const timeline: Record<string, number> = { [hKey]: (s.appTimeline[hKey] ?? 0) + secs };
      for (const k of Object.keys(s.appTimeline)) if (k.startsWith(yKey.slice(0, 10)) || k.startsWith(yH1)) timeline[k] = s.appTimeline[k];
      set({ appUse: next, appTimeline: timeline });
      get().syncAppUse();
      // tracker achievement: first full hour tracked
      const totalToday = Object.entries(s.appUse).reduce((a, [k, v]) => a + (k.startsWith(day) ? v : 0), 0) + secs;
      if (totalToday >= 3600) get().unlock("tracker-1", "Time Keeper", "Tracked your first hour of app time", "clock");
    },
    syncAppUse: async (force = false) => {
      const s = get();
      const now = Date.now();
      if (!force && now - appSyncAt < 45_000) return;
      appSyncAt = now;
      const entries = Object.entries(s.appUse)
        .filter(([k]) => k.startsWith(todayKey()))
        .map(([k, v]) => {
          const app = k.slice(11);
          return { app, secs: v, day: todayKey(), cat: categorize(app, s.appCat, s.rules.patterns), src: "web" as const };
        });
      if (!entries.length) return;
      try {
        await fetch("/api/activity", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entries }), keepalive: true });
      } catch {}
    },
    setAppCat: (app, cat) => {
      const next = { ...get().appCat, [app]: cat };
      get().set({ appCat: next });
      void api("PATCH", "/api/activity", { app, cat });
    },
    logManualApp: async (app, mins) => {
      const secs = Math.max(1, Math.min(720, Math.round(mins))) * 60;
      const s = get();
      try {
        await fetch("/api/activity", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ entries: [{ app, secs, day: todayKey(), cat: categorize(app, s.appCat, s.rules.patterns), src: "manual" }] }),
        });
        sfx("pop");
        s.toast(`Logged ${mins}m of ${app}`, "clock");
      } catch {}
    },
    setCurrentApp: (app) => {
      get().set({ currentApp: app });
      if (app) {
        const v = get().checkAppRules(app);
        if (v.blocked) get().say(`Hold on — ${app} is on your blocklist! Rules exist for a reason.`);
        else if (v.over) get().say(`You're over your ${app} limit today. How about a swap?`);
        else get().say(`Noted — you're in ${app}. I'll keep the log.`);
      }
    },

    // ---------- rules / admin manager ----------
    setRules: (patch) => {
      const next = { ...get().rules, ...patch };
      get().set({ rules: next });
      // mirror to the server so the AI harness + other browsers see the same rulebook
      rulesDirtyAt = Date.now();
      schedule("rules", () => api("PUT", "/api/rules", { rules: next }), 900);
      get().unlock("gatekeeper", "Gatekeeper", "Created your first activity rule", "shield");
    },
    addBlock: (match) => {
      const m = match.trim().toLowerCase();
      if (!m || get().rules.blocklist.some((b) => b.match === m)) return;
      const rule: BlockRule = { id: uid(), match: m, enabled: true, createdAt: Date.now() };
      get().setRules({ blocklist: [...get().rules.blocklist, rule] });
      sfx("pop");
      get().toast(`Blocked “${m}” — the shield will bounce it`, "shield");
    },
    toggleBlock: (id) => {
      get().setRules({ blocklist: get().rules.blocklist.map((b) => (b.id === id ? { ...b, enabled: !b.enabled } : b)) });
      sfx("pop");
    },
    removeBlock: (id) => {
      get().setRules({ blocklist: get().rules.blocklist.filter((b) => b.id !== id) });
      sfx("trash");
    },
    setLimit: (app, mins) => {
      const limits = { ...get().rules.limits };
      if (mins > 0) limits[app.toLowerCase()] = Math.min(720, Math.round(mins));
      else delete limits[app.toLowerCase()];
      get().setRules({ limits });
      if (mins > 0) {
        sfx("pop");
        get().toast(`${app} limited to ${mins}m per day`, "hourglass");
      }
    },
    addPattern: (match, cat) => {
      const m = match.trim().toLowerCase();
      if (!m) return;
      const patterns: CatPattern[] = [...get().rules.patterns.filter((p) => p.match !== m), { id: uid(), match: m, cat, createdAt: Date.now() }];
      get().setRules({ patterns });
      sfx("pop");
      get().toast(`“${m}” now counts as ${cat}`, "label");
    },
    removePattern: (id) => {
      get().setRules({ patterns: get().rules.patterns.filter((p) => p.id !== id) });
      sfx("trash");
    },
    setAdminPin: async (pin) => {
      const hash = pin ? await sha256(pin) : "";
      get().setRules({ pinHash: hash });
      get().set({ adminUnlocked: !pin });
      get().toast(pin ? "Admin PIN set — rule edits now need it" : "Admin PIN removed", "lock");
    },
    adminLocked: () => !!get().rules.pinHash && !get().adminUnlocked,
    verifyAdmin: async (pin) => {
      const ok = (await sha256(pin)) === get().rules.pinHash;
      if (ok) {
        get().set({ adminUnlocked: true });
        sfx("unlock");
      }
      return ok;
    },
    checkAppRules: (app) => {
      const s = get();
      const key = app.toLowerCase();
      const used = s.appUse[`${todayKey()}|${key}`] ?? 0;
      return verdictFor(key, s.rules, used, (a) => categorize(a, s.appCat, s.rules.patterns), new Date().getHours());
    },

    // ---------- profile / appearance ----------
    patchProfile: (patch) => {
      get().set({ profile: { ...get().profile, ...patch } });
      if (patch.avatar) get().unlock("portrait", "Portrait", "Uploaded a profile avatar", "image");
    },
    setFont: (f) => {
      document.documentElement.dataset.font = f;
      get().set({ font: f });
      sfx("pop");
      get().unlock("font-fiddler", "Font Fiddler", "Changed the whole app's font", "type");
    },
    setAppScale: (n) => {
      const v = Math.min(1.35, Math.max(0.85, n));
      document.documentElement.style.setProperty("--app-scale", String(v));
      // REAL zoom — the whole UI gets bigger/smaller, everywhere, and persists
      (document.documentElement.style as CSSStyleDeclaration & { zoom: string }).zoom = String(v);
      get().set({ appScale: v });
    },
    addCustomDock: (app) => {
      const a = app.trim().slice(0, 18);
      if (!a || get().customDock.some((x) => x.toLowerCase() === a.toLowerCase())) return;
      get().set({ customDock: [...get().customDock, a].slice(0, 12) });
      sfx("pop");
      get().toast(`“${a}” added to your dock`, "app-windows");
    },
    removeCustomDock: (app) => {
      get().set({ customDock: get().customDock.filter((x) => x !== app) });
      sfx("trash");
    },

    // ---------- attachments ----------
    attachments: {},
    loadAtts: async (noteId) => {
      try {
        const rows = (await fetch(`/api/notes/${noteId}/attachments`).then((r) => r.json())) as AttMeta[];
        if (Array.isArray(rows)) get().set({ attachments: { ...get().attachments, [noteId]: rows } });
      } catch {}
    },
    uploadAtt: async (noteId, file) => {
      if (file.size > 8 * 1024 * 1024) {
        get().toast("Files max out at 8MB — that one's too heavy", "alert");
        return;
      }
      const buf = await file.arrayBuffer();
      let bin = "";
      const bytes = new Uint8Array(buf);
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
      const dataB64 = btoa(bin);
      try {
        const att = (await fetch(`/api/notes/${noteId}/attachments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: file.name, mime: file.type || "application/octet-stream", size: file.size, dataB64 }),
        }).then((r) => r.json())) as AttMeta;
        if (att && att.id) {
          get().set({ attachments: { ...get().attachments, [noteId]: [...(get().attachments[noteId] ?? []), att] } });
          sfx("pop");
          get().toast(`Attached “${file.name}”`, "paperclip");
          get().unlock("pack-rat", "Pack Rat", "Attached a file to a note", "paperclip");
        }
      } catch {
        get().toast("Attachment failed to upload", "close");
      }
    },
    deleteAtt: async (noteId, attId) => {
      get().set({ attachments: { ...get().attachments, [noteId]: (get().attachments[noteId] ?? []).filter((a) => a.id !== attId) } });
      void api("DELETE", `/api/attachments/${attId}`);
      sfx("trash");
    },

    // ---------- harness effects + quick chat + tour ----------
    applyEffects: (effects) => {
      if (!effects?.length) return;
      for (const e of effects) {
        if (e.type === "navigate" && VIEWS_ALL.includes(e.view as View)) get().setView(e.view as View);
        else if (e.type === "theme") {
          const th = e.id as ThemeId;
          if (THEMES[th]) get().setTheme(th);
        } else if (e.type === "pet") get().doAct(e.mood === "think" ? "think" : e.mood, 2200);
        else if (e.type === "confetti") flyCoins(8, { count: 8 });
      }
    },
    openQuickChat: (kind, x, y) => {
      sfx("open");
      set({ quickChat: { kind, x: x ?? 0, y: y ?? 0 } });
      get().doAct("happy", 1200);
    },
    closeQuickChat: () => set({ quickChat: null }),
    startTour: () => set({ tourOpen: true, tourStep: 0 }),
    endTour: (done = true) => {
      set({ tourOpen: false, tourStep: 0 });
      // skipping ALSO persists — the tour must never nag again after Skip
      get().set({ tourDone: true });
      if (done) get().unlock("tourist", "Guided by Paw", "Finished the welcome tour", "map-pin");
    },
  };
});

// app-sync throttle + category presets for the activity tracker
let appSyncAt = 0;
/** last local rules write — the server poll won't revert fresh local edits */
export let rulesDirtyAt = 0;
export const VIEWS_ALL: View[] = ["notes", "graph", "canvas", "den", "focus", "arcade", "team", "market", "tasks", "activity", "rules", "settings", "calendar", "timelens", "chat", "meetings"];
export const APP_PRESETS: Record<string, AppCat> = {
  // code / writing → productive
  vscode: "productive", "visual studio code": "productive", code: "productive", terminal: "productive", figma: "productive", notion: "productive", docs: "productive", excel: "productive", calendar: "productive", teams: "productive", slack: "productive", zoom: "productive",
  // study / reading apps default productive-leaning neutral
  wikipedia: "productive", coursera: "productive", udemy: "productive", khan: "productive", chatgpt: "productive", gemini: "productive", claude: "productive",
  // socials / games default distraction
  discord: "distraction", youtube: "neutral", tiktok: "distraction", instagram: "distraction", twitter: "distraction", x: "distraction", reddit: "neutral", twitch: "distraction", netflix: "distraction", spotify: "neutral", steam: "neutral", games: "neutral",
  chrome: "neutral", browser: "neutral", edge: "neutral", firefox: "neutral", safari: "neutral",
};
export function categorize(app: string, overrides: Record<string, AppCat>, patterns?: CatPattern[]): AppCat {
  const key = app.toLowerCase();
  if (overrides[key]) return overrides[key];
  if (patterns) {
    for (const p of patterns) if (p.match && matchesRule(key, p.match)) return p.cat;
  }
  // in-app views: writing/graph/canvas/tasks/focus are productive; arcade/games/team/market lean fun
  if (key.startsWith("nook:")) {
    const v = key.slice(5);
    if (["notes", "tasks", "focus", "graph", "canvas", "rules", "meetings"].includes(v)) return "productive";
    if (["arcade", "team", "market", "den"].includes(v)) return "neutral";
    return "neutral";
  }
  if (APP_PRESETS[key]) return APP_PRESETS[key];
  return "neutral";
}

export const useActiveNote = () => useStore((s) => s.notes.find((n) => n.id === s.activeId) ?? null);

export { THEMES };
