/**
 * Power / visibility governor — the single place that decides whether Nook may spend CPU.
 *
 *  • `isActive()` is false while the window is hidden, minimised or closed to the tray
 *    (document.visibilityState + the Tauri `nook://window-state` event, which also covers
 *    "hidden to tray" where WebView2 may not flip visibility on its own).
 *  • Low-power mode (ON by default) turns off decorative motion: infinite CSS animations,
 *    backdrop blur, grain, the roaming pet, idle canvas loops. Honours prefers-reduced-motion.
 *  • `everyActive(fn, ms)` is the only sanctioned way to poll: it never fires while inactive and
 *    catches up once when the window comes back.
 *  • `frameLoop(draw, fps)` replaces raw requestAnimationFrame loops: capped fps via timers
 *    (no 60 Hz wake-ups), paused while inactive, optionally only while an element is on screen.
 */

type Listener = () => void;

const LS_KEY = "nook:power";
const listeners = new Set<Listener>();

let windowVisible = true; // from the desktop shell (tray hide / minimise)
let lowPower = readLowPower();
const reducedMotion = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;

function readLowPower(): boolean {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw == null) return true; // default ON for every install
    return JSON.parse(raw).lowPower !== false;
  } catch {
    return true;
  }
}

function emit() {
  applyDataset();
  listeners.forEach((f) => f());
}

function applyDataset() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.power = lowPower ? "low" : "full";
  root.dataset.motion = lowPower || reducedMotion?.matches ? "reduced" : "full";
  root.dataset.active = isActive() ? "true" : "false";
}

export function isActive(): boolean {
  return windowVisible && (typeof document === "undefined" || document.visibilityState !== "hidden");
}

export function isLowPower(): boolean {
  return lowPower;
}

/** decorative animation allowed right now (not low power, not reduced motion, window active) */
export function motionAllowed(): boolean {
  return !lowPower && !reducedMotion?.matches && isActive();
}

export function setLowPower(on: boolean) {
  lowPower = on;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ lowPower: on }));
  } catch {}
  emit();
}

export function onPowerChange(f: Listener): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** setInterval that only runs while the window is active; fires once on return if a tick was missed. */
export function everyActive(fn: () => void, ms: number): () => void {
  let missed = false;
  const iv = setInterval(() => {
    if (!isActive()) {
      missed = true;
      return;
    }
    fn();
  }, ms);
  const off = onPowerChange(() => {
    if (missed && isActive()) {
      missed = false;
      fn();
    }
  });
  return () => {
    clearInterval(iv);
    off();
  };
}

/**
 * A capped-fps drawing loop. Uses timers (not 60 Hz rAF) and stops completely while the window
 * is inactive or — when `el` is given — while that element is scrolled/hidden off screen.
 * `draw` returns false to stop the loop (e.g. a settled simulation); `kick()` restarts it.
 */
export function frameLoop(draw: (now: number) => boolean | void, fps: number, el?: Element | null) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onScreen = true;
  let stopped = false;
  let running = false;
  const period = 1000 / Math.max(1, Math.min(60, fps));
  const step = () => {
    timer = null;
    if (stopped || !onScreen || !isActive()) {
      running = false;
      return;
    }
    const keep = draw(performance.now());
    if (keep === false) {
      running = false;
      return;
    }
    timer = setTimeout(step, period);
  };
  const kick = () => {
    if (stopped || running) return;
    running = true;
    timer = setTimeout(step, 0);
  };
  const io =
    el && typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
          onScreen = entries.some((e) => e.isIntersecting);
          if (onScreen) kick();
        })
      : null;
  if (el && io) io.observe(el);
  const off = onPowerChange(() => isActive() && kick());
  kick();
  return {
    kick,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      io?.disconnect();
      off();
    },
  };
}

let installed = false;
/** Wire document visibility + the desktop window-state event. Safe to call many times. */
export function installPower() {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("visibilitychange", emit);
  reducedMotion?.addEventListener?.("change", emit);
  window.addEventListener("storage", (e) => {
    if (e.key === LS_KEY) {
      lowPower = readLowPower();
      emit();
    }
  });
  applyDataset();
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (w.__TAURI_INTERNALS__) {
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ visible: boolean }>("nook://window-state", (ev) => {
          windowVisible = ev.payload?.visible !== false;
          emit();
        }),
      )
      .catch(() => {});
  }
}

/** test/debug hook: simulate the desktop shell hiding the window */
export function __setWindowVisible(v: boolean) {
  windowVisible = v;
  emit();
}
