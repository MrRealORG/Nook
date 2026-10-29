"use client";

/**
 * Coin-fly reward animation — pixel coins physically fly from where the user
 * just clicked to the coin counter in the top bar.
 *
 * A capture-phase pointerdown listener remembers the last click point, so any
 * reward path (quest claims, daily gifts, focus payouts, arcade coins, bot
 * sales) can call flyCoins() with zero prop-drilling and the coins originate
 * from the thing the user actually interacted with.
 */

type Pt = { x: number; y: number };

let lastPoint: Pt | null = null;
let inited = false;

/** pixel-art coin (7x7 grid at 2x = 14px), gold with rim + shine */
const COIN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 7 7" shape-rendering="crispEdges" aria-hidden="true">
<rect x="2" y="0" width="3" height="1" fill="#9a742c"/><rect x="1" y="1" width="5" height="1" fill="#9a742c"/>
<rect x="0" y="2" width="1" height="3" fill="#9a742c"/><rect x="6" y="2" width="1" height="3" fill="#9a742c"/>
<rect x="1" y="5" width="5" height="1" fill="#9a742c"/><rect x="2" y="6" width="3" height="1" fill="#9a742c"/>
<rect x="2" y="1" width="3" height="1" fill="#ffd166"/><rect x="1" y="2" width="5" height="1" fill="#ffd166"/>
<rect x="1" y="3" width="5" height="1" fill="#ffd166"/><rect x="1" y="4" width="5" height="1" fill="#f0b64a"/>
<rect x="2" y="5" width="3" height="1" fill="#f0b64a"/>
<rect x="2" y="2" width="1" height="1" fill="#fff3c4"/><rect x="3" y="3" width="1" height="2" fill="#e0a93f"/>
</svg>`;

let coinUrl: string | null = null;
function coinImage(): string {
  if (!coinUrl) coinUrl = `data:image/svg+xml;utf8,${encodeURIComponent(COIN_SVG)}`;
  return coinUrl;
}

export function initCoinFly() {
  if (inited || typeof window === "undefined") return;
  inited = true;
  window.addEventListener(
    "pointerdown",
    (e) => {
      lastPoint = { x: e.clientX, y: e.clientY };
    },
    { capture: true, passive: true },
  );
}

function coinTarget(): Pt {
  const el = document.querySelector<HTMLElement>("[data-coin-counter]");
  if (el) {
    const r = el.getBoundingClientRect();
    if (r.width > 0) return { x: r.left + r.width / 2 - 7, y: r.top + r.height / 2 - 7 };
  }
  return { x: window.innerWidth - 90, y: 24 };
}

function reducedMotion() {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Fly `amount` coins (capped) from the last click point (or a given origin)
 * to the top-bar coin counter. Purely cosmetic — safe to call anywhere.
 */
export function flyCoins(amount: number, opts?: { from?: Pt | null; count?: number }) {
  if (typeof document === "undefined") return;
  const n = Math.max(1, Math.min(opts?.count ?? 10, Math.max(1, Math.round(amount))));
  if (reducedMotion() || n <= 0) return;

  const from = opts?.from ?? lastPoint ?? { x: window.innerWidth / 2 - 7, y: window.innerHeight - 90 };
  const to = coinTarget();
  const layer = document.createElement("div");
  layer.className = "coin-fly-layer";
  layer.setAttribute("aria-hidden", "true");
  document.body.appendChild(layer);

  const src = `url("${coinImage()}")`;
  for (let i = 0; i < n; i++) {
    const c = document.createElement("div");
    c.className = "coin-fly";
    c.style.backgroundImage = src;
    layer.appendChild(c);

    // per-coin arc: a random sideways bulge on the way to the counter
    const t0 = 140 + i * 55;
    const bulgeX = (Math.random() - 0.5) * 130;
    const bulgeY = -30 - Math.random() * 55;
    const dur = 620 + Math.random() * 260;

    const anim = c.animate(
      [
        { transform: `translate(${from.x}px, ${from.y}px) scale(0.4) rotate(0deg)`, opacity: 0, offset: 0 },
        { transform: `translate(${from.x}px, ${from.y}px) scale(1) rotate(0deg)`, opacity: 1, offset: 0.14 },
        { transform: `translate(${(from.x + to.x) / 2 + bulgeX}px, ${(from.y + to.y) / 2 + bulgeY}px) scale(1.12) rotate(${bulgeX > 0 ? 180 : -180}deg)`, opacity: 1, offset: 0.52 },
        { transform: `translate(${to.x}px, ${to.y}px) scale(0.55) rotate(${bulgeX > 0 ? 360 : -360}deg)`, opacity: 0.95, offset: 0.92 },
        { transform: `translate(${to.x}px, ${to.y}px) scale(0.1) rotate(${bulgeX > 0 ? 380 : -380}deg)`, opacity: 0, offset: 1 },
      ],
      { duration: dur, delay: t0, easing: "cubic-bezier(.32,.72,.35,1)", fill: "both" },
    );
    anim.onfinish = () => {
      c.remove();
      // the last coin landing nudges the counter (the counter also self-bumps
      // on value change via key={coins} — this keeps late-arriving flies juicy)
      const el = document.querySelector<HTMLElement>("[data-coin-counter] .coin-bump");
      if (el) {
        el.classList.remove("coin-bump");
        void el.offsetWidth;
        el.classList.add("coin-bump");
      }
    };
  }
  setTimeout(() => layer.remove(), (n * 55 + 1000));
}
