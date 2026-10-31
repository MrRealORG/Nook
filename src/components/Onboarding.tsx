/**
 * First-run onboarding (1.3, reworked in 1.3.1) — shown on first launch, re-runnable from Settings
 * and the command palette.
 *
 * Steps: welcome · profile (picture + name + optional banner) · theme (+ icon style) · layout ·
 * AI setup · features · companion · finale ("Welcome home, <name>!" with confetti).
 *
 * Mochi walks in, talks in a typewriter bubble and reacts: a hop when you pick a theme, a heart
 * when you set your picture, a thinking pose on AI setup. Small particle bursts on Next.
 *
 * Kept light for WebView2: no backdrop-filter anywhere, the sky canvas is capped at 30 fps (20 in
 * low-power mode), pauses when the window is hidden, and drops to "reduced effects" on its own if
 * frames take > 50 ms. Keyboard: ← / → (Enter) to move; Esc always skips. Nothing here awaits:
 * Next / Skip / Esc can never be blocked by a pending request.
 */
import { BrandIcon } from "@/lib/brand";
import { useEffect, useMemo, useRef, useState } from "react";
import "@/onboarding.css";
import { Icon } from "@/components/Icon";
import { PetView } from "@/components/PetView";
import { Scene } from "@/components/ob/Scene";
import { AiSetup } from "@/components/settings/AiSetup";
import { FeatureGrid } from "@/components/settings/FeatureGrid";
import { IconStylePicker, LayoutPicker, ThemePresets } from "@/components/settings/LookPickers";
import { ProfileEditor } from "@/components/ProfileEditor";
import { useStore } from "@/lib/store";
import { THEMES } from "@/lib/themes";
import { sfx } from "@/lib/sfx";
import { markOnboarded } from "@/lib/boot";
import { isTauri } from "@/lib/platform";
import { WindowControls } from "@/components/WindowControls";
import { CrashProbe } from "@/components/ErrorBoundary";
import type { Mood } from "@/lib/sprite";

const STEPS = ["welcome", "profile", "theme", "layout", "ai", "features", "pet", "done"] as const;
type Step = (typeof STEPS)[number];

const PERSONALITIES = [
  { id: "cheerful", label: "Cheerful", emoji: "🌞", hint: "cheers you on" },
  { id: "chill", label: "Chill", emoji: "🍵", hint: "calm, rare nudges" },
  { id: "coach", label: "Coach", emoji: "🏋️", hint: "keeps you on task" },
  { id: "nerdy", label: "Nerdy", emoji: "🤓", hint: "fun facts & ideas" },
  { id: "quiet", label: "Quiet", emoji: "🤫", hint: "only when asked" },
];

function lines(pet: string, you: string): Record<Step, string> {
  const hi = you ? `, ${you}` : "";
  return {
    welcome: `Hi! I'm ${pet}. Welcome to your cozy little Nook!`,
    profile: you ? `Nice to meet you, ${you}! Want a picture? I'll keep it safe right here.` : "First things first — who are you? A name and a picture make this place yours.",
    theme: `Pick a look you love${hi} — it changes right away. Try a few!`,
    layout: "How do you like your desk? Rail and panes, or Obsidian-style tabs?",
    ai: "Hmm… a smarter brain for me? Plug in a free model — or skip, I work offline too.",
    features: "Switch off anything you won't use. Poof — gone, and zero CPU.",
    pet: "And… what should you call me? Pick my vibe too!",
    done: you ? `Welcome home, ${you}! Let's make something great. ✨` : "All set! Let's make something great. ✨",
  };
}

const NEXT_QUIPS = ["Ooh, nice!", "Onward!", "Lookin' good!", "Yay!", "Almost there!", "Ta-da!"];

/** the bubble types its text out (instant in reduced-effects mode) */
function Typewriter({ text, instant }: { text: string; instant: boolean }) {
  const [n, setN] = useState(instant ? text.length : 0);
  useEffect(() => {
    if (instant) return setN(text.length);
    setN(0);
    let i = 0;
    const iv = setInterval(() => {
      i += 2;
      setN(Math.min(text.length, i));
      if (i >= text.length) clearInterval(iv);
    }, 30);
    return () => clearInterval(iv);
  }, [text, instant]);
  return (
    <span data-testid="ob-say" data-full={text}>
      {text.slice(0, n)}
      <span className="ob-caret" aria-hidden data-done={n >= text.length} />
    </span>
  );
}

export default function Onboarding() {
  const pet = useStore((s) => s.pet);
  const theme = useStore((s) => s.theme);
  const uiStyle = useStore((s) => s.uiStyle);
  const profile = useStore((s) => s.profile);
  const [i, setI] = useState(0);
  const [burst, setBurst] = useState(0);
  const [pop, setPop] = useState(0);
  const [arrived, setArrived] = useState(false);
  const [name, setName] = useState(pet.name);
  const [vibe, setVibe] = useState(() => localStorage.getItem("nook:petPersonality") ?? "cheerful");
  const [react, setReact] = useState<{ kind: "hop" | "heart" | null; n: number }>({ kind: null, n: 0 });
  const [quip, setQuip] = useState<string | null>(null);
  const step = STEPS[i];
  const dark = THEMES[theme]?.dark ?? true;
  const you = profile.displayName.trim().slice(0, 24);
  const say = useMemo(() => lines(name.trim() || pet.name, you), [name, pet.name, you]);
  const cardRef = useRef<HTMLDivElement>(null);
  const [fx, setFx] = useState<"full" | "reduced">(() => (localStorage.getItem("nook:obFx") === "reduced" ? "reduced" : "full"));

  // hide the app-wide grain/noise/backdrop overlays while the onboarding is up
  useEffect(() => {
    document.documentElement.dataset.onboarding = "1";
    return () => {
      delete document.documentElement.dataset.onboarding;
    };
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setArrived(true), fx === "reduced" ? 0 : 2300);
    return () => clearTimeout(t);
  }, [fx]);
  useEffect(() => {
    if (step === "done") setBurst((b) => b + 1);
    cardRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [step]);

  // Mochi reacts: a happy hop when the look changes (theme step)
  const firstLook = useRef(true);
  useEffect(() => {
    if (firstLook.current) {
      firstLook.current = false;
      return;
    }
    setReact((r) => ({ kind: "hop", n: r.n + 1 }));
  }, [theme, uiStyle]);
  useEffect(() => {
    if (!react.kind) return;
    const t = setTimeout(() => setReact((r) => ({ ...r, kind: null })), 1400);
    return () => clearTimeout(t);
  }, [react]);
  useEffect(() => {
    if (!quip) return;
    const t = setTimeout(() => setQuip(null), 1100);
    return () => clearTimeout(t);
  }, [quip]);

  // never blocked: no awaits, every side effect guarded — the overlay always closes
  const finish = () => {
    const st = useStore.getState();
    try {
      const n = name.trim();
      if (n && n !== st.pet.name) st.patchPet((p) => ({ ...p, name: n.slice(0, 24) }));
      localStorage.setItem("nook:petPersonality", vibe);
    } catch {}
    markOnboarded();
    st.set({ onboarded: true, tourDone: true, onboardingOpen: false, ...(vibe === "quiet" ? { petNag: false } : {}) });
    try {
      sfx("win");
    } catch {}
  };
  const next = () => {
    if (i >= STEPS.length - 1) return finish();
    try {
      sfx("pop");
    } catch {}
    setPop((p) => p + 1);
    if (i > 0) setQuip(NEXT_QUIPS[i % NEXT_QUIPS.length]);
    setI(i + 1);
  };
  const back = () => i > 0 && setI(i - 1);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? "");
      if (e.key === "Escape") {
        e.preventDefault();
        finish();
      } else if (!typing && (e.key === "ArrowRight" || (e.key === "Enter" && (e.target as HTMLElement)?.tagName !== "BUTTON"))) {
        e.preventDefault();
        next();
      } else if (!typing && e.key === "ArrowLeft") {
        e.preventDefault();
        back();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const wide = step === "features" || step === "ai" || step === "theme";
  const mood: Mood = !arrived ? "walk" : step === "done" ? "spin" : step === "ai" ? "think" : react.kind || step === "welcome" || step === "pet" ? "happy" : "idle";

  return (
    <div className="ob-root" role="dialog" aria-modal="true" aria-label="Welcome to Nook" data-testid="onboarding" data-step={step} data-dark={dark} data-wide={wide} data-fx={fx}>
      <CrashProbe name="onboarding" />
      <Scene dark={dark} burst={burst} pop={pop} onReduced={() => setFx("reduced")} />
      {/* frameless desktop window: keep it movable/closable during onboarding */}
      {isTauri && (
        <div className="ob-titlebar" data-tauri-drag-region>
          <WindowControls />
        </div>
      )}

      {/* Mochi walks in from the left, talks, and reacts to your choices */}
      <div className="ob-pet" data-arrived={arrived} data-react={react.kind ?? "none"} aria-hidden data-testid="ob-pet">
        <div className="ob-bubble" key={step + (arrived ? "1" : "0")}>
          {arrived ? <Typewriter text={say[step]} instant={fx === "reduced"} /> : "…"}
        </div>
        {react.kind === "heart" && <div className="ob-heart" data-testid="ob-heart">♥</div>}
        {quip && <div className="ob-quip" key={quip + i}>{quip}</div>}
        <div className="ob-sparkles">
          <i /> <i /> <i />
        </div>
        <div className="ob-pet-body" data-react={react.kind ?? "none"} key={`react-${react.n}`}>
          <PetView species={pet.species} tint={pet.look} hat={pet.hat} mood={mood} scale={4} fps={8} animate />
        </div>
      </div>

      <div className="ob-card" ref={cardRef} data-wide={wide} data-step={step} key={step}>
        {step === "welcome" && (
          <div className="ob-welcome">
            <BrandIcon size={104} className="ob-appicon" testId="ob-appicon" />
            <div className="ob-logo" aria-hidden>
              <span>N</span><span>o</span><span>o</span><span>k</span>
            </div>
            <h1 className="ob-h1">Your cozy, <span className="whitespace-nowrap">pixel-soft</span> second brain</h1>
            <p className="ob-p">Notes, tasks, focus, a tiny pet and an AI that lives on your machine. Let's set it up in under a minute.</p>
            <button className="ob-cta" onClick={next} data-autofocus data-testid="ob-start">
              Get Started <Icon name="arrow-right" size={16} />
            </button>
          </div>
        )}
        {step === "profile" && (
          <div>
            <h2 className="ob-h2">Make it yours</h2>
            <p className="ob-p">Your picture and name show in the title bar and next to your messages in AI chat. Stored only on this computer.</p>
            <ProfileEditor compact onAvatar={() => setReact((r) => ({ kind: "heart", n: r.n + 1 }))} />
          </div>
        )}
        {step === "theme" && (
          <div>
            <h2 className="ob-h2">Choose your theme</h2>
            <p className="ob-p">Applied instantly — you can change it anytime in Settings ▸ Appearance.</p>
            <ThemePresets />
            <h3 className="ob-h3">Icon style</h3>
            <IconStylePicker />
          </div>
        )}
        {step === "layout" && (
          <div>
            <h2 className="ob-h2">Choose your layout</h2>
            <p className="ob-p">Switch between them anytime in Settings ▸ Appearance.</p>
            <LayoutPicker />
          </div>
        )}
        {step === "ai" && (
          <div>
            <h2 className="ob-h2">AI setup</h2>
            <p className="ob-p">Pick a provider and test it — keys are stored in your OS keychain and never leave your machine except to that provider. You can always skip this.</p>
            <AiSetup compact />
          </div>
        )}
        {step === "features" && (
          <div>
            <h2 className="ob-h2">Pick your features</h2>
            <p className="ob-p">Everything is on. Turn off what you don't want — it disappears from the app and stops all background work.</p>
            <FeatureGrid compact />
          </div>
        )}
        {step === "pet" && (
          <div>
            <h2 className="ob-h2">Meet your companion</h2>
            <p className="ob-p">Optional — your pet lives in the den and cheers you on.</p>
            <label className="ob-field">
              <span>Name</span>
              <input className="input" value={name} maxLength={24} onChange={(e) => setName(e.target.value)} data-testid="ob-pet-name" data-autofocus />
            </label>
            <div className="ob-vibes" role="radiogroup" aria-label="Personality">
              {PERSONALITIES.map((p) => (
                <button key={p.id} role="radio" aria-checked={vibe === p.id} data-on={vibe === p.id} className="ob-vibe" onClick={() => { setVibe(p.id); setReact((r) => ({ kind: "hop", n: r.n + 1 })); }}>
                  <span className="ob-vibe-emoji">{p.emoji}</span>
                  <span className="ob-vibe-label">{p.label}</span>
                  <span className="ob-vibe-hint">{p.hint}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {step === "done" && (
          <div className="ob-welcome" data-testid="ob-finale">
            {profile.avatar ? (
              <img className="ob-finale-avatar" src={profile.avatar} alt="" data-testid="ob-finale-avatar" />
            ) : (
              <div className="ob-done-badge" aria-hidden>★</div>
            )}
            <h1 className="ob-h1" data-testid="ob-finale-title">{you ? `Welcome home, ${you}!` : "All set!"}</h1>
            <p className="ob-p">Press <span className="kbd">Ctrl K</span> for commands, <span className="kbd">Ctrl O</span> to jump to a note. Re-run this anytime from Settings.</p>
            <button className="ob-cta" onClick={finish} data-autofocus data-testid="ob-finish">
              Enter Nook <Icon name="arrow-right" size={16} />
            </button>
          </div>
        )}
      </div>

      <div className="ob-nav">
        <button className="ob-ghost" onClick={back} disabled={i === 0} data-testid="ob-back">
          <Icon name="arrow-left" size={14} /> Back
        </button>
        <div className="ob-dots" role="tablist" aria-label="Progress">
          {STEPS.map((s, k) => (
            <button key={s} role="tab" aria-selected={k === i} aria-label={`Step ${k + 1}: ${s}`} data-on={k === i} data-done={k < i} onClick={() => setI(k)} />
          ))}
        </div>
        {step !== "done" ? (
          <span className="flex items-center gap-2">
            <button className="ob-ghost" onClick={finish} data-testid="ob-skip" title="Skip setup (Esc)">Skip</button>
            {step !== "welcome" && (
              <button className="ob-next" onClick={next} data-testid="ob-next">
                Next <Icon name="arrow-right" size={14} />
              </button>
            )}
          </span>
        ) : (
          <span />
        )}
      </div>
    </div>
  );
}
