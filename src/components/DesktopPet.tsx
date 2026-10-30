
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/icons";
import { PetView } from "@/components/PetView";
import { activity } from "@/lib/activity";
import { FOODS, SPECIES } from "@/lib/pet";
import { feedPet, napPet, trickPet } from "@/lib/petActions";
import type { Mood } from "@/lib/sprite";
import { clamp, parseNote } from "@/lib/util";
import { useStore } from "@/lib/store";
import { everyActive, frameLoop, isLowPower, onPowerChange } from "@/lib/power";

const SCALE = 2.5;
const PW = 32 * SCALE;
const PH = 38 * SCALE;
const FLOOR = 5;

type Mode = "idle" | "walk" | "sleep";

/** actions surfaced by the hover toolbar + right-click menu */
function WidgetActions({ onMenu }: { onMenu?: () => void }) {
  const st = useStore.getState;
  const feed = () => {
    const ok = feedPet("berry");
    if (!ok) st().toast("No pixel berries left — feed from the Den", "alert");
  };
  return (
    <>
      {[
        { icon: "message-text" as IconName, label: "Chat", run: () => st().openQuickChat("desktop") },
        { icon: "sparkles" as IconName, label: "Trick", run: () => trickPet() },
        { icon: "cake" as IconName, label: "Snack", run: feed },
        { icon: "moon" as IconName, label: "Nap", run: () => napPet() },
        { icon: "dog" as IconName, label: "Open den", run: () => st().setView("den") },
      ].map((a) => (
        <button key={a.label} className="icon-btn !h-7 !w-7" title={a.label} aria-label={a.label} onClick={() => { a.run(); onMenu?.(); }}>
          <Icon name={a.icon} size={13} />
        </button>
      ))}
    </>
  );
}

/** an occasional speech bubble from the roaming pet */
function chatLine() {
  const st = useStore.getState();
  if (st.bubble || st.act || Date.now() - activity.lastType < 4000) return;
  const p = st.pet;
  let open = 0;
  for (const n of st.notes) { const m = parseNote(n.content); open += m.tasks.total - m.tasks.done; }
  const speciesSays = SPECIES[p.species]?.says ?? [];
  const pool = [...speciesSays];
  if (p.food < 35) pool.push("My tummy is rumbling…", "Is it snack time?");
  if (p.joy < 35) pool.push("Pet me? Please?");
  if (open > 0) pool.push(`You have ${open} open task${open > 1 ? "s" : ""}. I believe in you.`);
  if (pool.length) st.say(pool[Math.floor(Math.random() * pool.length)]);
}

export function DesktopPet() {
  const roam = useStore((s) => s.roam);
  const view = useStore((s) => s.view);
  const pet = useStore((s) => s.pet);
  const follow = useStore((s) => s.follow);
  const bubble = useStore((s) => s.bubble);
  const wrap = useRef<HTMLDivElement>(null);
  const mood = useRef<Mood>("idle");
  const facing = useRef<1 | -1>(1);
  const look = useRef({ x: 0, y: 0 });
  const [menu, setMenu] = useState(false);
  const [hover, setHover] = useState(false);
  const S = useRef({ x: 160, y: 0, vy: 0, mode: "idle" as Mode, until: 0, target: 160, held: false, moved: false, dx: 0, dy: 0, sx: 0, sy: 0, mx: -1, my: -1, lastClick: 0, facing: 1 as 1 | -1 });

  const hidden = !roam || view === "den";
  // 1.2 low-power mode (default): the pet sits still — no per-frame loop at all; it still
  // reacts (mood changes redraw the sprite) and keeps its hover toolbar / chat.
  const [low, setLow] = useState(() => isLowPower());
  useEffect(() => onPowerChange(() => setLow(isLowPower())), []);
  const act = useStore((s) => s.act);

  // close the widget context menu on outside click / Escape
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  useEffect(() => {
    if (hidden || !low) return;
    const el = wrap.current;
    const s = S.current;
    const place = () => {
      if (!el) return;
      const W = window.innerWidth;
      s.x = clamp(s.x, 0, W - PW);
      el.style.transform = `translate3d(${s.x}px, 0, 0)`;
      el.style.setProperty("--bl", `${clamp(s.x + PW / 2 - 118, 8, W - 244) - s.x}px`);
      el.style.setProperty("--tl", `${s.x + PW / 2 - clamp(s.x + PW / 2 - 118, 8, W - 244) - 6}px`);
      el.style.setProperty("--popx", `${clamp(s.x + PW / 2, 104, W - 104)}px`);
    };
    place();
    window.addEventListener("resize", place);
    const stopChat = everyActive(() => chatLine(), 120_000);
    return () => {
      window.removeEventListener("resize", place);
      stopChat();
    };
  }, [hidden, low]);

  useEffect(() => {
    if (hidden || low) return;
    const s = S.current;
    let last = performance.now();

    const onMove = (e: PointerEvent) => {
      s.mx = e.clientX;
      s.my = e.clientY;
      activity.lastInput = Date.now();
    };
    const onKey = () => (activity.lastInput = Date.now());
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("keydown", onKey);
    activity.lastInput = Date.now();

    const loop = (now: number) => {
      const el = wrap.current;
      if (!el) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const st = useStore.getState();
      const t = Date.now();
      const W = window.innerWidth;
      const H = window.innerHeight;
      let m: Mood = "idle";

      if (s.held) m = "held";
      else if (s.y > 0 || s.vy !== 0) {
        s.vy -= 1700 * dt;
        s.y += s.vy * dt;
        if (s.y <= 0) {
          s.y = 0;
          s.vy = Math.abs(s.vy) > 380 ? -s.vy * 0.32 : 0;
        }
        m = "held";
      } else if (st.act) m = st.act.mood;
      else {
        const idleFor = t - Math.max(activity.lastInput, activity.lastType);
        const focusing = st.timer.running && st.timer.mode === "focus";
        if (s.mode !== "sleep" && idleFor > 100_000 && !focusing) s.mode = "sleep";
        if (s.mode === "sleep") {
          m = "sleep";
          if (idleFor < 2500) { s.mode = "idle"; s.until = t + 800; st.say("Oh! You're back!"); }
        } else if (s.mode === "walk") {
          const dx = s.target - s.x;
          if (Math.abs(dx) < 3) { s.mode = "idle"; s.until = t + 2500 + Math.random() * 5000; }
          else { s.x += Math.sign(dx) * 44 * dt; s.facing = dx > 0 ? 1 : -1; m = "walk"; }
        } else {
          if (st.follow && s.mx >= 0 && Math.abs(s.mx - PW / 2 - s.x) > 90) { s.target = s.mx - PW / 2 + (s.mx > s.x ? -70 : 70); s.mode = "walk"; }
          else if (t > s.until && !focusing) {
            const r = Math.random();
            if (r < 0.62) { s.target = 30 + Math.random() * (W - PW - 60); s.mode = "walk"; }
            else s.until = t + 2500 + Math.random() * 4500;
          }
        }
      }

      mood.current = m;
      facing.current = s.facing;
      const typing = t - activity.lastType < 1400;
      const cx = s.x + PW / 2;
      const cy = H - FLOOR - s.y - PH / 2;
      look.current = typing
        ? { x: 0.3, y: 0.95 }
        : s.mx < 0 ? { x: 0, y: 0 } : { x: clamp((s.mx - cx) / 380, -1, 1), y: clamp((s.my - cy) / 260, -1, 1) };
      s.x = clamp(s.x, 0, W - PW);
      el.style.transform = `translate3d(${s.x}px, ${-s.y}px, 0)`;
      el.style.setProperty("--bl", `${clamp(s.x + PW / 2 - 118, 8, W - 244) - s.x}px`);
      el.style.setProperty("--tl", `${s.x + PW / 2 - clamp(s.x + PW / 2 - 118, 8, W - 244) - 6}px`);
      // popover anchor: horizontally centered over the pet, clamped to the viewport
      el.style.setProperty("--popx", `${clamp(s.x + PW / 2, 104, W - 104)}px`);
    };
    // full-power mode: 30 fps timer loop (was a 60 Hz rAF), paused while the window is hidden
    const fl = frameLoop(loop, 30);

    const stopChat = everyActive(() => chatLine(), 52_000);

    return () => {
      fl.stop();
      stopChat();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("keydown", onKey);
    };
  }, [hidden]);

  if (hidden) return null;
  const s = S.current;

  return (
    <div
      ref={wrap}
      className="pointer-events-none fixed left-0 z-[70]"
      style={{ bottom: FLOOR, width: PW, height: PH, willChange: "transform" }}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => { setHover(false); }}
    >
      {/* hover toolbar — floats above the pet */}
      {hover && !menu && (
        <div
          className="panel panel-solid pointer-events-auto absolute flex items-center gap-0.5 rounded-xl px-1 py-1"
          style={{ bottom: PH + 6, left: "var(--popx, 100px)", transform: "translateX(-50%)", animation: "pop .18s var(--ease-soft) both", filter: "drop-shadow(0 8px 14px rgba(0,0,0,.35))" }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <WidgetActions />
          <button className="icon-btn !h-7 !w-7" title={follow ? "Stop following my cursor" : "Follow my cursor"} aria-label="Toggle follow" onClick={() => { useStore.setState({ follow: !follow }); }}>
            <Icon name="pointer" size={13} style={follow ? { color: "var(--accent)" } : undefined} />
          </button>
          <button
            className="icon-btn !h-7 !w-7"
            title="Hide the desktop widget (bring it back from the Den)"
            onClick={() => { useStore.setState({ roam: false }); useStore.getState().toast("Widget hidden — open the Den to bring it back", "dog"); }}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      )}

      {/* right-click context menu */}
      {menu && (
        <div
          className="panel panel-solid pointer-events-auto absolute z-10 w-[190px] rounded-xl p-1.5"
          style={{ bottom: PH + 6, left: "var(--popx, 104px)", transform: "translateX(-50%)", animation: "pop .18s var(--ease-soft) both", filter: "drop-shadow(0 8px 14px rgba(0,0,0,.35))" }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2 px-1.5 pb-1.5">
            <span className="pixel-font flex-1 truncate text-[12px]">{pet.name}</span>
            <span className="text-[10px] text-faint">Lv {Math.floor(Math.sqrt(pet.xp / 30)) + 1}</span>
          </div>
          <div className="flex items-center gap-0.5 px-0.5 pb-1"><WidgetActions onMenu={() => setMenu(false)} /></div>
          <div className="my-0.5 h-px bg-line" />
          {[
            { icon: "pointer" as IconName, label: follow ? "Stop following me" : "Follow my cursor", run: () => useStore.setState({ follow: !follow }) },
            { icon: "home" as IconName, label: "Go to the den", run: () => useStore.getState().setView("den") },
            {
              icon: "close" as IconName,
              label: "Hide desktop widget",
              run: () => { useStore.setState({ roam: false }); useStore.getState().toast("Widget hidden — open the Den to bring it back", "dog"); },
            },
          ].map((a) => (
            <button key={a.label} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] hover:bg-panel2" onClick={() => { a.run(); setMenu(false); }}>
              <Icon name={a.icon} size={12} className="text-accent" /> {a.label}
            </button>
          ))}
        </div>
      )}

      {bubble && (
        <div key={bubble.id} className="px-clip px-frame pixel-font pointer-events-auto absolute" style={{ bottom: PH - 6, left: "var(--bl, -60px)", width: 236, animation: "bubbleIn .3s var(--ease-soft) both", filter: "drop-shadow(0 8px 14px rgba(0,0,0,.35))" }}>
          <div className="px-clip px-in px-3 py-2 text-[14px] leading-snug">
            <div>{bubble.text}</div>
            {bubble.action && (
              <button className="btn btn-sm btn-accent mt-2" onClick={() => { useStore.getState().openNote(bubble.action!.noteId); useStore.setState({ bubble: null }); }}>
                {bubble.action.label}
              </button>
            )}
          </div>
          <i className="absolute block h-[6px] w-[6px]" style={{ bottom: -6, left: "var(--tl, 100px)", background: "var(--ink)", clipPath: "polygon(0 0, 100% 0, 50% 100%)", width: 12, height: 6 }} />
        </div>
      )}
      <div
        className="pointer-events-auto cursor-grab touch-none active:cursor-grabbing"
        style={{ width: PW, height: PH }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          s.moved = false;
          s.sx = e.clientX;
          s.sy = e.clientY;
          s.dx = e.clientX - s.x;
          s.dy = s.y;
          activity.lastInput = Date.now();
          if (s.mode === "sleep") s.mode = "idle";
        }}
        onPointerMove={(e) => {
          if (!(e.buttons & 1)) return;
          if (!s.moved && Math.hypot(e.clientX - s.sx, e.clientY - s.sy) > 6) { s.moved = true; s.held = true; }
          if (s.held) {
            s.x = e.clientX - s.dx;
            s.y = clamp(s.dy + (s.sy - e.clientY), 0, window.innerHeight - PH - 70);
            s.vy = 0;
          }
        }}
        onPointerUp={(e) => {
          if (s.held) { s.held = false; s.vy = 1; s.mode = "idle"; s.until = Date.now() + 1500; return; }
          const now = Date.now();
          if (now - s.lastClick < 350) {
            trickPet();
          } else {
            // single click: open the quick-chat bubble anchored to the pet
            const r = e.currentTarget.getBoundingClientRect();
            useStore.getState().openQuickChat("desktop", r.left + r.width / 2, r.bottom);
          }
          s.lastClick = now;
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu((m) => !m);
        }}
        title={`${pet.name} — click to chat, double-click for a trick, drag to move, right-click for the menu`}
      >
        <PetView species={pet.species} tint={pet.look} hat={pet.hat} scale={SCALE} fps={12} animate={!low} mood={low ? (act?.mood ?? "idle") : "idle"} getPose={low ? undefined : () => ({ mood: mood.current, facing: facing.current, look: look.current })} />
      </div>
    </div>
  );
}
