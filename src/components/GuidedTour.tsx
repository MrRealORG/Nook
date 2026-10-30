
import { useEffect, useLayoutEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { PetView } from "@/components/PetView";
import { useStore, type View } from "@/lib/store";

type Step = {
  title: string;
  text: string;
  view?: View;
  target?: string; // css selector
  at?: "bottom" | "top" | "center";
};

/** The pet leads a first-run tour of every room in the Nook. */
export function GuidedTour() {
  const open = useStore((s) => s.tourOpen);
  const step = useStore((s) => s.tourStep);
  const pet = useStore((s) => s.pet);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const steps: Step[] = [
    {
      title: `Hi, I'm ${pet.name}!`,
      text: "Welcome to your Nook — a tiny world for notes, tasks, focus, games and one very attentive pet (me). Quick tour?",
    },
    {
      title: "The rail — your rooms",
      view: "notes",
      target: "nav.panel",
      text: "Everything lives on this rail: notes, graph, canvas, tasks, my den, focus, arcade, team, market, activity and the rulebook. Alt+1…8 jumps around.",
    },
    {
      title: "Notes & the AI panel",
      view: "notes",
      target: "aside.panel",
      at: "bottom",
      text: "Write markdown, link notes with [[wiki-links]]. This side panel flips between note info and chat with me.",
    },
    {
      title: "I actually DO things",
      view: "tasks",
      text: "Ask me anything in chat — “add task: ship the demo”, “tidy finished tasks”, “research pixel art”, “how's my pet?”. I run real tools and the results land here in Tasks. Try the Plan my day button!",
    },
    {
      title: "Your time, TimeLens-style",
      view: "activity",
      text: "The Activity room tracks where your day went: in-app time, apps you tap on the dock (YouTube, Discord…), a focus score, weekly charts and manual backfills — and the AI can read it too.",
    },
    {
      title: "The rulebook",
      view: "rules",
      text: "Set rules and I'll guard them: block distracting sites, give apps daily budgets, quiet hours — flip the shield up and I'll bounce troublemakers for you.",
    },
    {
      title: "My den",
      view: "den",
      text: "Feed me, dress me, decorate the room, throw a ball. Click me ANYWHERE for a quick chat bubble — even while you write.",
    },
    {
      title: "Arcade & coins",
      view: "arcade",
      text: "12 pixel games. Every point becomes XP, every two points a coin — coins buy snacks, hats and den decor.",
    },
    {
      title: "Make it yours",
      view: "settings",
      text: "Themes, whole-app fonts, UI scale, your profile (avatar, name, email) and backups live in Settings. That's the tour — go make something great!",
    },
  ];

  const s = steps[Math.min(step, steps.length - 1)];
  const last = step >= steps.length - 1;

  // navigate to the step's view
  useEffect(() => {
    if (open && s.view && useStore.getState().view !== s.view) useStore.getState().setView(s.view);
  }, [open, step, s.view, s.target]);

  // locate the target element
  useLayoutEffect(() => {
    if (!open) return;
    const find = () => {
      const el = s.target ? document.querySelector(s.target) : null;
      setRect(el ? el.getBoundingClientRect() : null);
    };
    find();
    const t1 = setTimeout(find, 420); // after view transition
    // 1.2: re-measure 4×/s instead of every frame — enough to follow layout changes
    const iv = setInterval(find, 250);
    window.addEventListener("resize", find);
    return () => {
      clearInterval(iv);
      window.removeEventListener("resize", find);
      clearTimeout(t1);
    };
  }, [open, step, s.view, s.target]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useStore.getState().endTour(false);
      if (e.key === "Enter" || e.key === "ArrowRight") useStore.setState({ tourStep: Math.min(step + 1, steps.length - 1) });
      if (e.key === "ArrowLeft") useStore.setState({ tourStep: Math.max(0, step - 1) });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, step, s.view, s.target]);

  if (!open) return null;

  // tooltip placement
  const cardW = 320;
  let cardStyle: React.CSSProperties = { left: "50%", top: "50%", transform: "translate(-50%,-50%)" };
  if (rect && rect.width > 40) {
    const r = rect;
    const spaceBelow = window.innerHeight - r.bottom;
    const below = spaceBelow > 190 || spaceBelow > r.top;
    cardStyle = {
      left: Math.min(Math.max(12, r.left + r.width / 2 - cardW / 2), window.innerWidth - cardW - 12),
      top: below ? Math.min(r.bottom + 14, window.innerHeight - 220) : Math.max(12, r.top - 206),
      width: cardW,
    };
  }

  return (
    <div className="fixed inset-0 z-[120]" role="dialog" aria-label="Guided tour">
      {/* dim with a cut-out around the target */}
      {rect && rect.width > 40 ? (
        <svg className="pointer-events-none absolute inset-0 h-full w-full">
          <defs>
            <mask id="tour-hole">
              <rect width="100%" height="100%" fill="white" />
              <rect x={rect.left - 8} y={rect.top - 8} width={rect.width + 16} height={rect.height + 16} rx="22" fill="black" />
            </mask>
          </defs>
          <rect width="100%" height="100%" fill="rgba(4,6,8,0.62)" mask="url(#tour-hole)" />
          <rect x={rect.left - 8} y={rect.top - 8} width={rect.width + 16} height={rect.height + 16} rx="22" fill="none" stroke="var(--accent)" strokeWidth="2.5" style={{ filter: "drop-shadow(0 0 10px var(--glow))" }} />
        </svg>
      ) : (
        <div className="absolute inset-0" style={{ background: "rgba(4,6,8,0.62)" }} />
      )}

      {/* pet mascot walking on the card */}
      <div className="tour-card panel panel-solid" style={cardStyle}>
        <div className="flex items-start gap-3">
          <div className="tour-pet">
            <PetView species={pet.species} tint={pet.look} hat={pet.hat} mood={last ? "happy" : "walk"} scale={1.7} fps={9} />
            <i className="tour-paw" style={{ animationDelay: "0s" }} />
            <i className="tour-paw" style={{ animationDelay: ".5s" }} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="pixel-font text-[16.5px] leading-tight">{s.title}</div>
            <div className="mt-1.5 text-[12.8px] leading-relaxed text-dim">{s.text}</div>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
          <div className="flex flex-1 gap-1.5">
            {steps.map((_, i) => (
              <i key={i} className="tour-dot" data-on={i === step} />
            ))}
          </div>
          <button className="btn btn-sm" onClick={() => useStore.getState().endTour(false)}>Skip</button>
          {step > 0 && (
            <button className="btn btn-sm" onClick={() => useStore.setState({ tourStep: step - 1 })}>
              <Icon name="arrow-left" size={12} /> Back
            </button>
          )}
          <button className="btn btn-accent btn-sm" onClick={() => (last ? useStore.getState().endTour(true) : useStore.setState({ tourStep: step + 1 }))}>
            {last ? (<>Let's go <Icon name="sparkle" size={12} /></>) : (<>Next <Icon name="arrow-right" size={12} /></>)}
          </button>
        </div>
      </div>
    </div>
  );
}
