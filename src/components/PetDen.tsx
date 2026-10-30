
import { useEffect, useRef, useState } from "react";
import { PHASE_TINT, PhaseCelestial, phaseOf, useAmbience, type Phase } from "@/lib/ambience";
import { AiChat } from "@/components/AiChat";
import { CatchGame } from "@/components/CatchGame";
import { DecorArt, DenDecorLayer } from "@/components/DecorArt";
import { Icon } from "@/components/Icon";
import { PetLibrary } from "@/components/PetLibrary";
import { PetView } from "@/components/PetView";
import { Bar } from "@/components/ui";
import { ABILITIES, DECOR, FOODS, HATS, SPECIES, TRICKS, abilityOf, levelOf, moodFor, stageOf } from "@/lib/pet";
import { buyDecor, buyHat, equipHat, feedPet, fetchForgotten, learnTrick, napPet, patPet, performTrick, sellOwnedItem, trickPet } from "@/lib/petActions";
import { sfx } from "@/lib/sfx";
import type { Mood } from "@/lib/sprite";
import { useStore } from "@/lib/store";
import type { Species } from "@/lib/types";
import { clamp } from "@/lib/util";

const SCALE = 7.5;
const PW = 32 * SCALE;

type Tab = "care" | "home" | "closet" | "pets" | "play" | "chat";

// ---------- day/night ambience (shared logic lives in src/lib/ambience.ts) ----------
/** deterministic star positions (no Math.random — stable across SSR/CSR) */
const STARS = [
  { x: 8, y: 12, s: 0 }, { x: 17, y: 26, s: 2 }, { x: 26, y: 7, s: 1 }, { x: 34, y: 18, s: 3 }, { x: 44, y: 9, s: 0 },
  { x: 52, y: 22, s: 2 }, { x: 61, y: 6, s: 0 }, { x: 70, y: 16, s: 1 }, { x: 79, y: 10, s: 3 }, { x: 88, y: 20, s: 0 },
  { x: 93, y: 8, s: 2 }, { x: 12, y: 34, s: 1 }, { x: 48, y: 30, s: 0 }, { x: 84, y: 33, s: 1 },
];
/** deterministic drifting particles per phase — fireflies at night, petals at dawn/dusk, leaves by day */
const PARTICLES = [
  { x: 10, y: 40, d: 0 }, { x: 22, y: 62, d: 1.3 }, { x: 35, y: 30, d: 2.6 }, { x: 47, y: 55, d: 0.7 },
  { x: 58, y: 38, d: 3.4 }, { x: 69, y: 60, d: 1.9 }, { x: 80, y: 42, d: 2.9 }, { x: 90, y: 58, d: 4.1 },
];

function Ambience() {
  const phase = useAmbience();
  const meta = PHASE_TINT[phase];
  const night = phase === "night";
  const dusk = phase === "dusk" || phase === "dawn";
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" title={meta.label}>
      <div className="absolute inset-0 transition-all duration-1000" style={{ background: meta.sky }} />
      {/* celestial body — sun by day, pixel moon by night, low warm orb at dawn/dusk */}
      <div className="absolute right-[9%] top-[10%]" style={{ animation: "floaty 5.5s ease-in-out infinite" }}>
        <PhaseCelestial phase={phase} size={night ? 34 : 30} />
      </div>
      {/* stars only when the sky is dark */}
      {(night || dusk) && STARS.map((st, i) => (
        <i
          key={i}
          className="ambience-star"
          data-dim={dusk || st.s === 0}
          style={{ left: `${st.x}%`, top: `${st.y}%`, animationDelay: `${st.s * 0.7 + (i % 4) * 0.35}s` }}
        />
      ))}
      {/* drifting particles — fireflies at night, petals at dawn/dusk, leaves by day */}
      {PARTICLES.map((p, i) => (
        <i
          key={`p${i}`}
          className="ambience-particle"
          data-kind={night ? "firefly" : dusk ? "petal" : "leaf"}
          style={{
            left: `${p.x}%`,
            top: `${p.y}%`,
            animationDelay: `${p.d + i * 0.6}s`,
            animationDuration: `${8.5 + (i % 4) * 2.2}s`,
            ["--sway" as string]: `${(i % 2 === 0 ? 1 : -1) * (10 + (i % 3) * 6)}px`,
            ["--drift" as string]: `${(i % 2 === 0 ? -1 : 1) * (18 + (i % 3) * 9)}px`,
          }}
        />
      ))}
    </div>
  );
}

function Stage() {
  const pet = useStore((s) => s.pet);
  const bubble = useStore((s) => s.bubble);
  const stage = stageOf(levelOf(pet.xp).level);
  const box = useRef<HTMLDivElement>(null);
  const petEl = useRef<HTMLDivElement>(null);
  const ballEl = useRef<HTMLDivElement>(null);
  const mood = useRef<Mood>("idle");
  const facing = useRef<1 | -1>(1);
  const look = useRef({ x: 0, y: 0 });
  const S = useRef({ x: 200, target: 200, until: 0, mx: -1, my: -1, ball: { on: false, x: 0, y: 0, vx: 0, vy: 0 }, catchAt: 0, poi: null as null | "rug" | "cushion" | "boombox" });
  const [hearts, setHearts] = useState(0);
  const [burst, setBurst] = useState(0);
  const prevStage = useRef(stage.id);
  void hearts;

  useEffect(() => {
    if (stage.id > prevStage.current) {
      prevStage.current = stage.id;
      const t1 = setTimeout(() => setBurst((b) => b + 1), 30);
      const t2 = setTimeout(() => setBurst(0), 2300);
      return () => {
        clearTimeout(t1);
        clearTimeout(t2);
      };
    }
    prevStage.current = stage.id;
  }, [stage.id]);

  useEffect(() => {
    const el = box.current!;
    let raf = 0, last = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const s = S.current;
      const st = useStore.getState();
      const W = el.clientWidth, H = el.clientHeight;
      const t = Date.now();
      let m: Mood = moodFor(st.pet);
      const b = s.ball;
      if (b.on) {
        b.vy -= 1500 * dt; b.y += b.vy * dt; b.x += b.vx * dt;
        if (b.y <= 0) { b.y = 0; b.vy = Math.abs(b.vy) > 160 ? -b.vy * 0.55 : 0; b.vx *= 0.8; }
        b.x = clamp(b.x, 16, W - 16);
        s.target = b.x;
      }
      if (st.act) m = st.act.mood;
      else {
        const dx = s.target - (s.x + PW / 2);
        if (Math.abs(dx) > 8) { s.x += Math.sign(dx) * (b.on ? 190 : 52) * dt; facing.current = dx > 0 ? 1 : -1; m = "walk"; }
        else if (s.poi && !b.on) {
          // arrived at a decoration — react to it once, then resume wandering
          const poi = s.poi;
          s.poi = null;
          s.until = t + 4200 + Math.random() * 3600;
          if (poi === "rug") {
            st.doAct("sleep", 5600);
            st.patchPet((p) => ({ ...p, joy: clamp(p.joy + 3, 0, 100), xp: p.xp + 2 }));
            st.say("*curls up on the cozy rug* zzz…", undefined, 3400);
          } else if (poi === "cushion") {
            st.doAct("sleep", 5000);
            st.patchPet((p) => ({ ...p, joy: clamp(p.joy + 2, 0, 100), xp: p.xp + 1 }));
            st.say("*plops onto the cloud cushion*", undefined, 3000);
          } else {
            st.doAct("spin", 2800);
            st.patchPet((p) => ({ ...p, joy: clamp(p.joy + 4, 0, 100), xp: p.xp + 1 }));
            st.say("♪ lo-fi beats ~ dance o'clock ♪", undefined, 3000);
          }
        } else if (b.on && b.y < 30 && Math.abs(b.vy) < 80 && t - s.catchAt > 900) {
          b.on = false; s.catchAt = t;
          st.doAct("happy", 1700);
          st.patchPet((p) => ({ ...p, joy: clamp(p.joy + 4, 0, 100), xp: p.xp + 1 }));
        } else if (t > s.until && !b.on) {
          // pick the next wander target — owned decorations act as points of interest
          const owned = st.pet.owned;
          const roll = Math.random();
          const lonely = st.pet.joy < 45 ? 2.2 : 1; // low joy: the pet seeks comfort decor more often
          s.poi = null;
          if (owned.includes("decor-rug") && roll < 0.2 * lonely) {
            s.poi = "rug";
            s.target = W * 0.5;
          } else if (owned.includes("decor-cushion") && roll < 0.36 * lonely) {
            s.poi = "cushion";
            s.target = W * 0.2 + 36;
          } else if (owned.includes("decor-boombox") && roll < 0.52 * lonely) {
            s.poi = "boombox";
            s.target = W * 0.83 - 38;
          } else {
            s.target = 60 + Math.random() * (W - PW - 120) + PW / 2;
          }
          s.target = clamp(s.target, PW / 2, W - PW / 2);
          s.until = t + 3500 + Math.random() * 5000;
        }
      }
      s.x = clamp(s.x, 0, W - PW);
      mood.current = m;
      const cx = s.x + PW / 2, cy = H - 30 - 120;
      look.current = b.on ? { x: clamp((b.x - cx) / 200, -1, 1), y: clamp(-(b.y - 60) / 200, -1, 1) } : s.mx < 0 ? { x: 0, y: 0 } : { x: clamp((s.mx - cx) / 300, -1, 1), y: clamp((s.my - cy) / 220, -1, 1) };
      if (petEl.current) petEl.current.style.transform = `translate3d(${s.x}px, 0, 0)`;
      if (ballEl.current) {
        ballEl.current.style.opacity = b.on ? "1" : "0";
        ballEl.current.style.transform = `translate3d(${b.x - 11}px, ${-b.y}px, 0)`;
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      ref={box}
      className="relative h-full min-h-[220px] overflow-hidden rounded-[20px] lg:min-h-[360px]"
      style={{ background: "url(/art/den.webp) center bottom / cover", cursor: "crosshair" }}
      onPointerMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); S.current.mx = e.clientX - r.left; S.current.my = e.clientY - r.top; }}
      onPointerLeave={() => { S.current.mx = -1; }}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("[data-pet]")) return;
        const r = e.currentTarget.getBoundingClientRect();
        const s = S.current;
        s.ball = { on: true, x: clamp(e.clientX - r.left, 16, r.width - 16), y: r.height * 0.55, vx: (Math.random() - 0.5) * 160, vy: 260 };
        useStore.getState().say("Ball! Ball ball ball!", undefined, 1600);
      }}
    >
      <div className="absolute inset-0" style={{ background: "linear-gradient(to top, color-mix(in srgb, var(--bg) 55%, transparent), transparent 40%), radial-gradient(600px 300px at 50% 0%, transparent, color-mix(in srgb, var(--bg) 40%, transparent))" }} />
      <Ambience />
      <DenDecorLayer owned={pet.owned} />
      <div className="absolute left-4 top-4 flex gap-2">
        <span className="chip" data-on="true" style={{ height: 26, fontSize: 14 }}>{pet.name}</span>
        <span className="chip" style={{ height: 26, fontSize: 14, background: "var(--panel-solid)" }}>{SPECIES[pet.species].label}</span>
        {stage.id > 1 && (
          <span className="chip" data-on="true" style={{ height: 26, fontSize: 14 }} title={stage.desc}>
            <Icon name="sparkle" size={12} className="text-accent" /> {stage.name}
          </span>
        )}
      </div>
      <div className="pixel-font absolute bottom-3 left-4 rounded-lg bg-black/35 px-2.5 py-1 text-[12.5px] text-white/80">click the floor to throw a ball · click {pet.name} to chat</div>

      {bubble && (
        <div key={bubble.id} className="px-clip px-frame pixel-font absolute left-1/2 top-[14%] w-[min(300px,80%)] -translate-x-1/2" style={{ animation: "bubbleIn .3s var(--ease-soft) both", filter: "drop-shadow(0 8px 14px rgba(0,0,0,.4))" }}>
          <div className="px-clip px-in px-3.5 py-2.5 text-[15px] leading-snug">{bubble.text}</div>
        </div>
      )}

      <div ref={ballEl} className="pointer-events-none absolute bottom-[34px] left-0 opacity-0" style={{ willChange: "transform" }}>
        <svg width="22" height="22" viewBox="0 0 11 11" shapeRendering="crispEdges">
          <path d="M3 0h5v1h2v2h1v5h-1v2H8v1H3v-1H1V8H0V3h1V1h2z" fill="var(--ink)" />
          <path d="M3 1h5v1h1v1h1v5H9v1H8v1H3V9H2V8H1V3h1V2h1z" fill="var(--accent)" />
          <path d="M3 2h2v1H4v1H3z" fill="#fff" opacity=".8" />
        </svg>
      </div>

      <div ref={petEl} data-pet="1" className="absolute bottom-[26px] left-0 cursor-pointer" style={{ width: PW, willChange: "transform" }} onPointerDown={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); useStore.getState().openQuickChat("den", r.left + r.width / 2, window.innerHeight - r.height - 26); setHearts((h) => h + 1); }}>
        {burst > 0 && (
          <div key={burst} className="pointer-events-none absolute bottom-0 left-0" style={{ width: PW, height: PW * 1.6 }}>
            <div className="absolute" style={{ left: "50%", bottom: 44, width: 190, height: 190, marginLeft: -95, borderRadius: "50%", border: "3px solid var(--accent)", boxShadow: "0 0 24px var(--accent), inset 0 0 24px color-mix(in srgb, var(--accent) 40%, transparent)", animation: "evolveRing 1.9s ease-out both" }} />
            <div className="absolute" style={{ left: "50%", bottom: 44, width: 130, height: 130, marginLeft: -65, borderRadius: "50%", border: "2px dashed var(--accent)", animation: "evolveRing 1.9s .25s ease-out both" }} />
            <div className="pixel-font absolute" style={{ left: "50%", bottom: 175, color: "var(--accent)", fontSize: 23, textShadow: "0 2px 0 rgba(0,0,0,.45), 0 0 18px var(--accent)", whiteSpace: "nowrap", animation: "floatUp 2.1s var(--ease-soft) both" }}>EVOLVED!</div>
          </div>
        )}
        {stage.aura > 0 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0" style={{ height: PW * 1.4 }}>
            <div className="absolute" style={{ left: "50%", bottom: 0, width: PW * 1.55, height: PW * 1.55, marginLeft: -PW * 0.775, borderRadius: "50%", background: "radial-gradient(circle, var(--accent) 0%, transparent 60%)", opacity: stage.aura, animation: "auraPulse 2.6s ease-in-out infinite" }} />
          </div>
        )}
        <div style={{ transform: `scale(${stage.scale})`, transformOrigin: "50% 100%", position: "relative" }}>
          <PetView species={pet.species} tint={pet.look} hat={pet.hat} scale={SCALE} fps={14} getPose={() => ({ mood: mood.current, facing: facing.current, look: look.current })} />
        </div>
      </div>
    </div>
  );
}

function Stat({ label, v, icon }: { label: string; v: number; icon: "fish" | "zap" | "heart" }) {
  return (
    <div className="grid grid-cols-[22px_62px_1fr_34px] items-center gap-2">
      <Icon name={icon} size={15} className="text-accent" />
      <span className="label">{label}</span>
      <Bar value={v} />
      <span className="pixel-font text-right text-[13px] text-dim">{Math.round(v)}</span>
    </div>
  );
}

function Care() {
  const pet = useStore((s) => s.pet);
  const { level, cur, next, pct } = levelOf(pet.xp);
  const stage = stageOf(level);
  return (
    <div className="scroll min-h-0 flex-1 space-y-5 px-4 pb-5">
      <div className="space-y-2.5">
        <Stat label="Fed" v={pet.food} icon="fish" />
        <Stat label="Energy" v={pet.energy} icon="zap" />
        <Stat label="Joy" v={pet.joy} icon="heart" />
        <div className="grid grid-cols-[22px_62px_1fr_34px] items-center gap-2">
          <Icon name="crown" size={15} className="text-accent" />
          <span className="label">Lv {level}</span>
          <div className="h-[10px] overflow-hidden rounded-[2px] border border-line bg-panel2"><i className="block h-full bg-accent transition-all duration-700" style={{ width: `${pct * 100}%` }} /></div>
          <span className="pixel-font text-right text-[11px] text-faint">{pet.xp - cur}/{next - cur}</span>
        </div>
        <div className="flex items-center justify-between rounded-lg border border-line bg-panel2 px-2.5 py-1.5">
          <span className="flex items-center gap-1.5 text-[11.5px] text-dim"><Icon name="sparkle" size={12} className="text-accent" /> Stage: <b className="pixel-font text-ink">{stage.name}</b></span>
          {stage.id < 3 ? <span className="text-[11px] text-faint">evolves at Lv {stage.id === 1 ? 3 : 5}</span> : <span className="text-[11px] text-accent">max stage!</span>}
        </div>
        {(() => {
          const ab = abilityOf(pet.species);
          return (
            <div className="ability-card mt-1 rounded-lg border border-line px-2.5 py-2" style={{ background: "color-mix(in srgb, var(--accent) 7%, var(--panel2))" }} title={ab.desc}>
              <div className="flex items-center gap-1.5">
                <Icon name={ab.icon} size={13} className="text-accent" />
                <span className="label !text-[9.5px]">ability</span>
                <span className="pixel-font text-[12.5px] text-ink">{ab.name}</span>
              </div>
              <div className="mt-0.5 text-[11.5px] leading-snug text-dim">{ab.desc}</div>
            </div>
          );
        })()}
      </div>

      <div>
        <div className="label mb-2">Play</div>
        <div className="grid grid-cols-4 gap-2">
          {([["Pet", "heart", patPet], ["Nap", "moon", napPet], ["Trick", "star", trickPet], ["Fetch", "archive", () => void fetchForgotten()]] as const).map(([l, ic, fn]) => (
            <button key={l} className="btn flex-col !h-[62px] !gap-1" onClick={fn}><Icon name={ic} size={19} /><span className="text-[13px]">{l}</span></button>
          ))}
        </div>
        <div className="mt-1.5 text-[11.5px] text-faint">Fetch: {pet.name} digs up a note you have not touched in a while.</div>
      </div>

      <div>
        <div className="label mb-2">Trick school · {pet.tricks?.length ?? 0}/{TRICKS.length} learned</div>
        <div className="grid grid-cols-2 gap-1.5">
          {TRICKS.map((t) => {
            const learned = pet.tricks?.includes(t.id);
            return (
              <button
                key={t.id}
                className={learned ? "btn btn-sm !justify-start" : "btn btn-sm inset !justify-start"}
                onClick={() => (learned ? performTrick(t.id) : learnTrick(t.id))}
                title={learned ? `${t.name} — perform it!` : `Teach “${t.name}” for ${t.cost} coins`}
              >
                <Icon name={t.icon} size={13} className={learned ? "text-accent" : "text-faint"} />
                <span className="min-w-0 flex-1 truncate text-left">
                  <span className="pixel-font block text-[12.5px]">{t.name}</span>
                  <span className="block truncate text-[10px] text-faint">{learned ? t.blurb : `${t.cost === 0 ? "free" : `${t.cost} coins`} · tap to learn`}</span>
                </span>
                {learned ? <Icon name="play" size={11} className="text-faint" /> : <Icon name="plus" size={11} className="text-faint" />}
              </button>
            );
          })}
        </div>
        <div className="mt-1.5 text-[11.5px] text-faint">Performing tricks earns XP and joy — the “Trick” button above does a random favorite. {pet.name} also shows off on request in chat!</div>
      </div>

      <div>
        <div className="label mb-2">Kitchen</div>
        <div className="space-y-1.5">
          {FOODS.map((f) => (
            <button key={f.id} className="inset group flex w-full items-center gap-3 p-2.5 text-left transition-all hover:-translate-y-0.5 hover:bg-hl" onClick={() => feedPet(f.id)}>
              <span className="grid h-9 w-9 flex-none place-items-center rounded-xl border border-line bg-panel2 text-accent"><Icon name={f.icon} size={18} /></span>
              <span className="min-w-0 flex-1">
                <span className="pixel-font block text-[15px]">{f.name}</span>
                <span className="block text-[11.5px] text-faint">{f.blurb} {f.food > 6 ? `+${f.food} fed ` : ""}{f.joy > 6 ? `+${f.joy} joy ` : ""}{f.energy ? `+${f.energy} energy` : ""}</span>
              </span>
              <span className="chip" data-on={pet.coins >= f.cost}>{f.cost === 0 ? "free" : <><Icon name="coins" size={11} />{f.cost}</>}</span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="label mb-2">Together so far</div>
        <div className="grid grid-cols-2 gap-2">
          {([["Words written", pet.stats.words], ["Pats given", pet.stats.pats], ["Treats fed", pet.stats.fed], ["Focus minutes", pet.stats.focus]] as const).map(([l, v]) => (
            <div key={l} className="inset px-3 py-2"><div className="pixel-font text-[20px] text-accent">{v.toLocaleString()}</div><div className="text-[11px] text-faint">{l}</div></div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Closet() {
  const pet = useStore((s) => s.pet);
  const [name, setName] = useState(pet.name);
  const st = useStore.getState;
  return (
    <div className="scroll min-h-0 flex-1 space-y-5 px-4 pb-5">
      <div>
        <div className="label mb-2">Name</div>
        <input className="input pixel-font !text-[16px]" maxLength={16} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => { const n = name.trim() || pet.name; setName(n); st().patchPet((p) => ({ ...p, name: n })); }} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
      </div>
      <div>
        <div className="label mb-2">Companion</div>
        <div className="grid grid-cols-4 gap-2">
          {(Object.keys(SPECIES) as Species[]).map((sp) => (
            <button
              key={sp}
              onClick={() => { st().setSpecies(sp); st().patchPet((p) => ({ ...p, look: {} })); st().toast(`${SPECIES[sp].label} form! Ability: ${ABILITIES[sp].name}`, "sparkle"); }}
              className="inset grid place-items-center overflow-hidden pb-2 pt-1 transition-all hover:-translate-y-0.5"
              style={{ borderColor: pet.species === sp ? "var(--accent)" : undefined, boxShadow: pet.species === sp ? "0 0 0 2px var(--hl)" : undefined }}
              title={`Ability: ${ABILITIES[sp].name} — ${ABILITIES[sp].desc}`}
            >
              <PetView species={sp} hat={pet.hat} scale={1.9} fps={6} />
              <span className="pixel-font text-[12.5px]" style={{ color: pet.species === sp ? "var(--accent)" : "var(--dim)" }}>{SPECIES[sp].label}</span>
              <span className="flex items-center gap-0.5 text-[9px] text-faint">
                <Icon name={ABILITIES[sp].icon} size={9} /> {ABILITIES[sp].name}
              </span>
            </button>
          ))}
        </div>
        <div className="mt-1.5 text-[12px] text-faint">{SPECIES[pet.species].blurb} — ability: <b className="text-ink">{abilityOf(pet.species).name}</b> ({abilityOf(pet.species).desc})</div>
      </div>
      <div>
        <div className="label mb-2">Hats</div>
        <div className="grid grid-cols-2 gap-2">
          {HATS.map((h) => {
            const owned = pet.owned.includes(h.id);
            const on = pet.hat === h.id;
            return (
              <button key={h.id} className="inset flex flex-col items-center gap-0.5 overflow-hidden px-2 pb-2.5 pt-1 text-center transition-all hover:-translate-y-0.5" style={{ borderColor: on ? "var(--accent)" : undefined, boxShadow: on ? "0 0 0 2px var(--hl)" : undefined }} onClick={() => (owned ? equipHat(h.id) : buyHat(h.id))}>
                <PetView species={pet.species} hat={h.id} scale={2.1} fps={5} />
                <span className="pixel-font text-[14px]">{h.name}</span>
                <span className="text-[11px] text-faint">{h.blurb}</span>
                <span className="chip mt-1" data-on={on || (!owned && pet.coins >= h.cost)}>
                  {on ? "wearing" : owned ? "equip" : <><Icon name="coins" size={11} />{h.cost}</>}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function HomeTab() {
  const pet = useStore((s) => s.pet);
  const placed = DECOR.filter((d) => pet.owned.includes(d.id)).length;
  const roomRef = useRef<HTMLInputElement>(null);
  const exportRoom = () => {
    const pack = { format: "nook-room", version: 1, exportedAt: new Date().toISOString(), decor: pet.owned.filter((id) => id.startsWith("decor-")) };
    const blob = new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "nook-room.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    useStore.getState().toast("Room pack exported — share it with anyone", "download");
  };
  const importRoom = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as { format?: string; decor?: string[] };
      const decor = Array.isArray(parsed.decor) ? parsed.decor.filter((d) => typeof d === "string" && DECOR.some((x) => x.id === d)) : [];
      if (parsed.format !== "nook-room" || !decor.length) throw new Error("not a room pack");
      useStore.getState().patchPet((p) => ({ ...p, owned: [...new Set([...p.owned, ...decor])] }));
      sfx("buy");
      useStore.getState().toast(`Imported ${decor.length} decorations into the den!`, "home");
      useStore.getState().unlock("room-importer", "Room Importer", "Imported a room pack", "home");
    } catch {
      sfx("error");
      useStore.getState().toast("That file isn't a nook-room pack (.json)", "alert");
    }
  };
  return (
    <div className="scroll min-h-0 flex-1 space-y-3 px-4 pb-5">
      <div className="flex items-center justify-between">
        <span className="text-[12px] text-faint">Decorate the den — your friend naps better in a cozy one.</span>
        <span className="chip flex-none" data-on={placed === DECOR.length}>{placed}/{DECOR.length}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button className="btn btn-sm" onClick={exportRoom} title="Export your den's decorations as a shareable nook-room pack">
          <Icon name="download" size={12} /> Export room
        </button>
        <button className="btn btn-sm" onClick={() => roomRef.current?.click()} title="Import a nook-room pack (.json)">
          <Icon name="upload" size={12} /> Import room
        </button>
        <input ref={roomRef} type="file" accept=".json,application/json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importRoom(f); e.target.value = ""; }} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        {DECOR.map((d) => {
          const owned = pet.owned.includes(d.id);
          return (
            <div
              key={d.id}
              className="inset flex flex-col items-center gap-1 overflow-hidden px-2 pb-2.5 pt-2 text-center transition-all hover:-translate-y-0.5"
              style={{ borderColor: owned ? "var(--accent)" : undefined, boxShadow: owned ? "0 0 0 2px var(--hl)" : undefined }}
            >
              <span className="grid h-[66px] w-full place-items-center rounded-xl border border-line" style={{ background: "color-mix(in srgb, var(--bg) 45%, var(--panel2))" }}>
                <DecorArt id={d.id} />
              </span>
              <span className="pixel-font text-[13.5px]">{d.name}</span>
              <span className="text-[10.5px] leading-tight text-faint">{d.blurb}</span>
              {owned ? (
                <span className="mt-0.5 flex items-center gap-1">
                  <span className="chip" data-on="true"><Icon name="check" size={11} /> placed</span>
                  <button
                    className="icon-btn !h-6 !w-6 !rounded-md"
                    title={`Sell for ${Math.max(2, Math.round(d.cost * 0.85))} coins on the team market`}
                    onClick={() => void sellOwnedItem("decor", d.id, d.name, Math.max(2, Math.round(d.cost * 0.85)), d.blurb)}
                  >
                    <Icon name="coins" size={12} />
                  </button>
                </span>
              ) : (
                <button className="chip mt-0.5" data-on={pet.coins >= d.cost} onClick={() => buyDecor(d.id)}>
                  <Icon name="coins" size={11} />{d.cost}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {placed === DECOR.length && <div className="pixel-font pt-1 text-center text-[12.5px] text-accent">The den is complete — interior designer unlocked!</div>}
      {placed > 0 && (
        <div className="text-center text-[11px] text-faint">
          The coin button on a placed decoration lists it on the team market — {pet.name} waves goodbye (item leaves the den).
        </div>
      )}
    </div>
  );
}

export function PetDen() {
  const [tab, setTab] = useState<Tab>("care");
  const coins = useStore((s) => s.pet.coins);
  const tabs: [Tab, string, "heart" | "home" | "shirt" | "library" | "gamepad" | "sparkles"][] = [["care", "Care", "heart"], ["home", "Den", "home"], ["closet", "Closet", "shirt"], ["pets", "Pets", "library"], ["play", "Game", "gamepad"], ["chat", "Chat", "sparkles"]];
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 lg:flex-row">
      <div className="panel min-h-[300px] min-w-0 p-2 lg:min-h-0 lg:flex-[1.45]"><Stage /></div>
      <div className="panel flex w-full min-h-0 flex-1 flex-col rounded-[20px] lg:w-[400px] lg:flex-none">
        <div className="flex items-center gap-2 p-3">
          <div className="seg seg-compact min-w-0 flex-1">
            {tabs.map(([id, l, ic]) => (
              <button key={id} className="min-w-0 flex-1 justify-center" data-on={tab === id} onClick={() => setTab(id)}>{l}</button>
            ))}
          </div>
          <span className="chip shrink-0" style={{ height: 28, fontSize: 14 }}><Icon name="coins" size={13} className="text-accent" />{coins}</span>
        </div>
        {tab === "care" && <Care />}
        {tab === "home" && <HomeTab />}
        {tab === "closet" && <Closet />}
        {tab === "pets" && <PetLibrary />}
        {tab === "play" && <div className="scroll min-h-0 flex-1 px-4 pb-5"><CatchGame /></div>}
        {tab === "chat" && <AiChat />}
      </div>
    </div>
  );
}
