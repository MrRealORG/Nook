
import { useEffect, useState } from "react";

/** time-of-day phase shared by the den stage and the dashboard mini-den */
export type Phase = "dawn" | "day" | "dusk" | "night";

export function phaseOf(h: number): Phase {
  return h < 5 ? "night" : h < 8 ? "dawn" : h < 17 ? "day" : h < 20 ? "dusk" : "night";
}

export const PHASE_TINT: Record<Phase, { label: string; sky: string; glow: string }> = {
  dawn: { label: "morning in the nook", sky: "linear-gradient(to top, rgba(255,183,128,0.10), rgba(255,138,168,0.16) 55%, rgba(148,120,216,0.10))", glow: "rgba(255,190,140,0.55)" },
  day: { label: "a bright day in the nook", sky: "linear-gradient(to top, rgba(255,232,170,0.05), rgba(180,220,255,0.10) 60%, rgba(255,255,255,0.04))", glow: "rgba(255,240,190,0.65)" },
  dusk: { label: "sunset in the nook", sky: "linear-gradient(to top, rgba(255,140,90,0.14), rgba(216,110,170,0.16) 55%, rgba(90,80,170,0.18))", glow: "rgba(255,150,110,0.6)" },
  night: { label: "nighttime in the nook", sky: "linear-gradient(to top, rgba(30,40,90,0.10), rgba(20,26,70,0.30) 60%, rgba(10,14,45,0.38))", glow: "rgba(200,215,255,0.5)" },
};

/** re-check the phase every minute */
export function useAmbience(): Phase {
  const [phase, setPhase] = useState<Phase>(() => phaseOf(new Date().getHours()));
  useEffect(() => {
    const t = setInterval(() => setPhase(phaseOf(new Date().getHours())), 60_000);
    return () => clearInterval(t);
  }, []);
  return phase;
}

/** tiny pixel sun / low warm orb / crescent moon — used in the den and the dashboard mini-den */
export function PhaseCelestial({ phase, size = 30 }: { phase: Phase; size?: number }) {
  const meta = PHASE_TINT[phase];
  const night = phase === "night";
  const s = size / 30;
  if (night) {
    return (
      <svg width={size} height={size} viewBox="0 0 11 11" shapeRendering="crispEdges" style={{ filter: `drop-shadow(0 0 10px ${meta.glow})` }}>
        <path d="M6 0h3v1h1v1h1v3h-1v1h-1v1H6V6h2V5h1V2H7V1H6z" fill="#f4f1de" />
        <path d="M2 2h4v1h1v4H6v1H2V7H1V3h1z" fill="#fdf6c6" />
        <path d="M2 3h1v1H2zM4 5h1v1H4z" fill="#e8df9a" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 11 11" shapeRendering="crispEdges" style={{ filter: `drop-shadow(0 0 12px ${meta.glow})`, opacity: phase === "day" ? 0.9 : 0.75, transform: `scale(${s})` }}>
      <path d="M4 0h3v1H4zM4 10h3v1H4zM0 4h1v3H0zM10 4h1v3h-1z" fill={phase === "day" ? "#ffe9a3" : "#ffb98a"} />
      <path d="M2 2h7v7H2z" fill={phase === "day" ? "#fff3c4" : "#ffc27d"} />
      <path d="M3 3h2v2H3z" fill="#fffbe0" />
    </svg>
  );
}
