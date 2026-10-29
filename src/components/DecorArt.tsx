"use client";

import type { CSSProperties } from "react";

/**
 * Pixel-art SVGs for den decorations — theme-aware via CSS vars.
 * All shapes use integer coordinates with shapeRendering="crispEdges".
 */

function Svg({ w, h, size, children, className, style }: { w: number; h: number; size: number; children: React.ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <svg width={size} height={(size * h) / w} viewBox={`0 0 ${w} ${h}`} shapeRendering="crispEdges" className={className} style={style} aria-hidden>
      {children}
    </svg>
  );
}

function Rug() {
  return (
    <Svg w={26} h={12} size={124}>
      <path d="M8 0h10v1h4v1h2v1h1v1h1v4h-1v1h-1v1h-2v1h-4v1H8V11H4v-1H2V9H1V8H0V4h1V3h1V2h2V1h4z" fill="var(--accent)" opacity=".28" />
      <path d="M9 1h8v1h3v1h2v1h1v1h1v2h-1v1h-1v1h-2v1h-3v1H9v-1H6v-1H4V9H3V8H2V6h1V5h1V4h2V3h3V2h1z" fill="var(--accent)" opacity=".4" />
      <path d="M11 3h4v1h2v1h1v2h-1v1h-2v1h-4V8H9V7H8V5h1V4h2z" fill="var(--accent)" opacity=".55" />
      <path d="M12 5h2v2h-2z" fill="var(--accent-ink)" opacity=".7" />
    </Svg>
  );
}

function Fern() {
  return (
    <Svg w={14} h={20} size={56}>
      <path d="M6 0h2v3H6zM4 2h2v3H4zM8 2h2v3H8zM2 4h2v3H2zM10 4h2v3h-2zM6 4h2v6H6z" fill="#7fb069" />
      <path d="M5 3h1v2H5zM9 5h1v2H9zM3 6h1v2H3zM7 1h1v2H7z" fill="#a7c957" />
      <path d="M4 10h6v1h1v2h1v1h1v5h-1v1H2v-1H1v-5h1v-1h1v-2h1z" fill="#c1504e" />
      <path d="M4 11h6v1h1v2H3v-2h1z" fill="#d97c6c" />
      <path d="M3 15h8v1H3zM3 17h8v1H3z" fill="#a03e3c" opacity=".6" />
    </Svg>
  );
}

function Poster() {
  return (
    <Svg w={14} h={18} size={58}>
      <path d="M0 0h14v1H0zM0 17h14v1H0zM0 1h1v16H0zM13 1h1v16h-1z" fill="var(--line)" />
      <path d="M1 1h12v16H1z" fill="var(--paper, var(--panel2))" />
      <path d="M3 3h8v1H3zM3 5h8v1H3zM3 7h5v1H3z" fill="var(--dim)" />
      <path d="M3 10h2v4H3zM5 12h1v2H5zM6 11h1v3H6zM7 9h1v5H7zM8 12h1v2H8zM9 10h2v4H9z" fill="var(--accent)" />
      <path d="M1 1h12v1H1z" fill="#fff" opacity=".12" />
    </Svg>
  );
}

function Cushion() {
  return (
    <Svg w={18} h={11} size={72}>
      <path d="M4 1h4v1h2V1h4v1h2v1h1v1h1v3h-1v1h-1v1h-2v1H6V9H4V8H2V7H1V6H0V3h1V2h1V1h2z" fill="var(--panel-solid)" />
      <path d="M4 2h4v1h2V2h4v1h2v1h1v3h-1v1h-2v1H6V8H4V7H2V6H1V3h1V2h2z" fill="var(--accent)" opacity=".32" />
      <path d="M6 4h6v1H6zM7 5h4v1H7z" fill="var(--accent)" opacity=".5" />
    </Svg>
  );
}

function Lamp() {
  return (
    <Svg w={12} h={22} size={50}>
      <path d="M3 0h6v1H3zM2 1h8v1H2zM4 2h4v3H4z" fill="var(--accent)" opacity=".9" />
      <path d="M4 2h4v1H4z" fill="#fff" opacity=".55" />
      <path d="M5 5h2v9H5z" fill="var(--dim)" />
      <path d="M2 14h8v1H2zM1 15h10v1H1z" fill="var(--ink)" opacity=".55" />
      <path d="M2 16h8v3H2z" fill="var(--dim)" opacity=".35" />
      <path d="M4 5h1v9H4z" fill="#fff" opacity=".25" />
    </Svg>
  );
}

function Window() {
  return (
    <Svg w={18} h={18} size={86}>
      <path d="M0 0h18v1H0zM0 17h18v1H0zM0 1h1v16H0zM17 1h1v16h-1zM8 1h2v16H8zM0 8h18v2H0z" fill="var(--line)" />
      <path d="M1 1h16v16H1z" fill="var(--bg)" opacity=".85" />
      <path d="M1 12h16v5H1z" fill="var(--accent)" opacity=".14" />
      <path d="M4 3h1v1H4zM12 2h1v1h-1zM14 5h1v1h-1zM3 7h1v1H3zM10 5h1v1h-1zM6 10h1v1H6zM13 12h1v1h-1zM2 13h1v1H2z" fill="#fff" opacity=".85" />
      <path d="M9 4h1v1H9z" fill="#fff" className="twinkle" />
      <path d="M5 12h1v1H5z" fill="#fff" className="twinkle" style={{ animationDelay: ".7s" }} />
      <path d="M15 9h1v1h-1z" fill="#fff" className="twinkle" style={{ animationDelay: "1.3s" }} />
      <path d="M1 1h16v1H1z" fill="#fff" opacity=".1" />
    </Svg>
  );
}

function Boombox() {
  return (
    <Svg w={20} h={13} size={76}>
      <path d="M3 0h14v1H3zM2 1h2v3H2zM16 1h2v3h-2z" fill="var(--dim)" />
      <path d="M1 3h18v9H1z" fill="var(--ink)" opacity=".78" />
      <path d="M2 4h16v7H2z" fill="var(--panel2)" />
      <path d="M3 5h6v5H3zM11 5h6v5h-6z" fill="var(--ink)" opacity=".8" />
      <path d="M4 6h4v3H4zM12 6h4v3h-4z" fill="var(--accent)" opacity=".5" />
      <path d="M5 7h2v1H5zM13 7h2v1h-2z" fill="var(--accent)" />
      <path d="M9 4h2v2H9z" fill="var(--accent)" opacity=".8" />
      <path d="M9 7h2v3H9z" fill="var(--accent)" opacity=".35" />
      <path d="M2 11h16v1H2z" fill="var(--accent)" opacity=".6" />
    </Svg>
  );
}

function Trophy() {
  return (
    <Svg w={16} h={18} size={64}>
      <path d="M1 17h14v1H1z" fill="var(--line)" />
      <path d="M2 15h12v2H2z" fill="var(--dim)" opacity=".5" />
      <path d="M4 1h8v2H4z" fill="var(--accent)" />
      <path d="M5 3h6v4H5zM6 7h4v2H6zM7 9h2v3H7zM4 12h8v2H4z" fill="var(--accent)" opacity=".85" />
      <path d="M3 2H1v2h1v1h1zM13 2h2v2h-1v1h-1z" fill="var(--accent)" opacity=".7" />
      <path d="M5 1h2v1H5z" fill="#fff" opacity=".5" />
      <path d="M4 12h8v1H4z" fill="#fff" opacity=".25" />
    </Svg>
  );
}

const ART: Record<string, () => React.JSX.Element> = {
  "decor-rug": Rug,
  "decor-fern": Fern,
  "decor-poster": Poster,
  "decor-cushion": Cushion,
  "decor-lamp": Lamp,
  "decor-window": Window,
  "decor-boombox": Boombox,
  "decor-trophy": Trophy,
};

export function DecorArt({ id, className, style }: { id: string; className?: string; style?: CSSProperties }) {
  const Art = ART[id];
  if (!Art) return null;
  return (
    <span className={className} style={style}>
      <Art />
    </span>
  );
}

export function hasDecorArt(id: string) {
  return !!ART[id];
}

/** Places every owned decoration at its fixed spot inside the den stage. */
export function DenDecorLayer({ owned }: { owned: string[] }) {
  const has = (id: string) => owned.includes(id);
  return (
    <>
      {has("decor-window") && (
        <div className="pointer-events-none absolute left-1/2 top-[6%] -translate-x-1/2" style={{ filter: "drop-shadow(0 4px 8px rgba(0,0,0,.3))" }}>
          <Window />
        </div>
      )}
      {has("decor-poster") && (
        <div className="pointer-events-none absolute left-[6%] top-[15%]" style={{ transform: "rotate(-2.5deg)", filter: "drop-shadow(0 3px 6px rgba(0,0,0,.35))" }}>
          <Poster />
        </div>
      )}
      {has("decor-trophy") && (
        <div className="pointer-events-none absolute right-[6%] top-[13%]" style={{ filter: "drop-shadow(0 3px 6px rgba(0,0,0,.35))" }}>
          <Trophy />
        </div>
      )}
      {has("decor-lamp") && (
        <div className="pointer-events-none absolute bottom-[26px] left-[3%]">
          <div className="absolute" style={{ left: -38, bottom: 34, width: 128, height: 128, borderRadius: "50%", background: "radial-gradient(circle, color-mix(in srgb, var(--accent) 36%, transparent), transparent 66%)", animation: "auraPulse 3.2s ease-in-out infinite" }} />
          <Lamp />
        </div>
      )}
      {has("decor-rug") && (
        <div className="pointer-events-none absolute bottom-[12px] left-1/2 -translate-x-1/2 opacity-95">
          <Rug />
        </div>
      )}
      {has("decor-cushion") && (
        <div className="pointer-events-none absolute bottom-[22px] left-[20%]" style={{ filter: "drop-shadow(0 3px 4px rgba(0,0,0,.3))" }}>
          <Cushion />
        </div>
      )}
      {has("decor-fern") && (
        <div className="pointer-events-none absolute bottom-[24px] right-[4%]" style={{ filter: "drop-shadow(0 3px 5px rgba(0,0,0,.35))" }}>
          <Fern />
        </div>
      )}
      {has("decor-boombox") && (
        <div className="pointer-events-none absolute bottom-[22px] right-[17%]" style={{ filter: "drop-shadow(0 3px 5px rgba(0,0,0,.35))" }}>
          <Boombox />
        </div>
      )}
    </>
  );
}
