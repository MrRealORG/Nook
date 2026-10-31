/**
 * 1.3 first-run onboarding — shown on first launch, re-runnable from Settings (and the command
 * palette). A pixel sky with drifting clouds (ob/Scene), Mochi walking in to wave and talk, and
 * seven steps: welcome · theme (+ icon style) · layout · AI setup · features · pet · all set.
 * Keyboard: ← / → (or Enter) to move, Esc to skip. The scene's loop only exists while this
 * component is mounted.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import "@/onboarding.css";
import { Icon } from "@/components/Icon";
import { PetView } from "@/components/PetView";
import { Scene } from "@/components/ob/Scene";
import { AiSetup } from "@/components/settings/AiSetup";
import { FeatureGrid } from "@/components/settings/FeatureGrid";
import { IconStylePicker, LayoutPicker, ThemePresets } from "@/components/settings/LookPickers";
import { useStore } from "@/lib/store";
import { THEMES } from "@/lib/themes";
import { sfx } from "@/lib/sfx";

const STEPS = ["welcome", "theme", "layout", "ai", "features", "pet", "done"] as const;
type Step = (typeof STEPS)[number];

const PERSONALITIES = [
  { id: "cheerful", label: "Cheerful", emoji: "🌞", hint: "cheers you on" },
  { id: "chill", label: "Chill", emoji: "🍵", hint: "calm, rare nudges" },
  { id: "coach", label: "Coach", emoji: "🏋️", hint: "keeps you on task" },
  { id: "nerdy", label: "Nerdy", emoji: "🤓", hint: "fun facts & ideas" },
  { id: "quiet", label: "Quiet", emoji: "🤫", hint: "only when asked" },
];

function lines(name: string): Record<Step, string> {
  return {
    welcome: `Hi! I'm ${name}. Welcome to your cozy little Nook!`,
    theme: "Pick a look you love — it changes right away. Try a few!",
    layout: "How do you like your desk? Rail and panes, or Obsidian-style tabs?",
    ai: "Want a smarter brain for me? Plug in a free model — or skip, I work offline too.",
    features: "Switch off anything you won't use. It vanishes and costs zero CPU.",
    pet: "And… what should you call me? Pick my vibe too!",
    done: "All set! Let's make something great. ✨",
  };
}

export default function Onboarding() {
  const pet = useStore((s) => s.pet);
  const theme = useStore((s) => s.theme);
  const [i, setI] = useState(0);
  const [burst, setBurst] = useState(0);
  const [arrived, setArrived] = useState(false);
  const [name, setName] = useState(pet.name);
  const [vibe, setVibe] = useState(() => localStorage.getItem("nook:petPersonality") ?? "cheerful");
  const step = STEPS[i];
  const dark = THEMES[theme]?.dark ?? true;
  const say = useMemo(() => lines(name.trim() || pet.name), [name, pet.name]);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setArrived(true), 2300);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (step === "done") setBurst((b) => b + 1);
    cardRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [step]);

  const finish = () => {
    const st = useStore.getState();
    const n = name.trim();
    if (n && n !== st.pet.name) st.patchPet((p) => ({ ...p, name: n.slice(0, 24) }));
    try {
      localStorage.setItem("nook:petPersonality", vibe);
    } catch {}
    st.set({ onboarded: true, tourDone: true, onboardingOpen: false, ...(vibe === "quiet" ? { petNag: false } : {}) });
    sfx("win");
  };
  const next = () => {
    if (i >= STEPS.length - 1) return finish();
    sfx("pop");
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

  return (
    <div className="ob-root" role="dialog" aria-modal="true" aria-label="Welcome to Nook" data-testid="onboarding" data-step={step} data-dark={dark} data-wide={step === "features" || step === "ai" || step === "theme"}>
      <Scene dark={dark} burst={burst} />

      {/* Mochi walks in from the left, waves, and talks */}
      <div className="ob-pet" data-arrived={arrived} aria-hidden>
        <div className="ob-bubble" key={step + (arrived ? "1" : "0")}>
          {arrived ? say[step] : "…"}
        </div>
        <div className="ob-sparkles">
          <i /> <i /> <i />
        </div>
        <PetView species={pet.species} tint={pet.look} hat={pet.hat} mood={!arrived ? "walk" : step === "done" ? "spin" : step === "welcome" || step === "pet" ? "happy" : "idle"} scale={4} fps={8} animate />
      </div>

      <div className="ob-card" ref={cardRef} data-wide={step === "features" || step === "ai" || step === "theme"} data-step={step} key={step}>
        {step === "welcome" && (
          <div className="ob-welcome">
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
            <p className="ob-p">Pick a provider and test it — keys are stored in your OS keychain and never leave your machine except to that provider.</p>
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
                <button key={p.id} role="radio" aria-checked={vibe === p.id} data-on={vibe === p.id} className="ob-vibe" onClick={() => setVibe(p.id)}>
                  <span className="ob-vibe-emoji">{p.emoji}</span>
                  <span className="ob-vibe-label">{p.label}</span>
                  <span className="ob-vibe-hint">{p.hint}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {step === "done" && (
          <div className="ob-welcome">
            <div className="ob-done-badge" aria-hidden>★</div>
            <h1 className="ob-h1">All set!</h1>
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
            <button className="ob-ghost" onClick={finish} data-testid="ob-skip">Skip</button>
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
