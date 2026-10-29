// Procedural pixel pets: tiny 3D primitives -> z-buffer -> lit + ordered-dithered tones.
// Self contained (no imports) so it can be unit-rendered anywhere.

export type Species =
  | "cat"
  | "bunny"
  | "blob"
  | "dog"
  | "fox"
  | "panda"
  | "frog"
  | "penguin"
  | "ghost"
  | "dragon"
  | "axolotl"
  | "owl";
export type Mood = "idle" | "walk" | "happy" | "sleep" | "eat" | "spin" | "think" | "sad" | "held" | "look";
export type Pose = {
  mood: Mood;
  t: number;
  facing?: 1 | -1;
  look?: { x: number; y: number };
  blink?: boolean;
};
export type RGB = [number, number, number];
export type Palette = { ramp: RGB[]; accent: RGB };

export const SW = 32;
export const SH = 38;
const G = 35; // ground line

export function hexToRgb(h: string): RGB {
  const n = parseInt(h.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function makePalette(ramp: string[], accent: string): Palette {
  return { ramp: ramp.map(hexToRgb), accent: hexToRgb(accent) };
}

type Prim =
  | { k: "e"; cx: number; cy: number; rx: number; ry: number; rz: number; cz: number; layer: number; id: number; tone?: number; mat?: number }
  | { k: "t"; p: [number, number, number, number, number, number]; rz: number; cz: number; layer: number; id: number; tone?: number; mat?: number };
type Decal = { cx: number; cy: number; rx: number; ry: number; tone: number; on: number };

const N = SW * SH;
const KEY = new Float32Array(N);
const ZL = new Float32Array(N);
const OWN = new Uint8Array(N);
const TONE = new Float32Array(N);
const MAT = new Uint8Array(N);

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

function ell(cx: number, cy: number, rx: number, ry: number, rz: number, cz: number, layer: number, id: number, tone = 0, mat = 0): Prim {
  return { k: "e", cx, cy, rx, ry, rz, cz, layer, id, tone, mat };
}
function tri(p: [number, number, number, number, number, number], rz: number, cz: number, layer: number, id: number, tone = 0, mat = 0): Prim {
  return { k: "t", p, rz, cz, layer, id, tone, mat };
}

function put(i: number, key: number, z: number, id: number, tone: number, mat: number) {
  if (key > KEY[i]) {
    KEY[i] = key;
    ZL[i] = z;
    OWN[i] = id;
    TONE[i] = tone;
    MAT[i] = mat;
  }
}

function rasterize(p: Prim) {
  if (p.k === "e") {
    const x0 = Math.max(0, Math.floor(p.cx - p.rx)), x1 = Math.min(SW - 1, Math.ceil(p.cx + p.rx));
    const y0 = Math.max(0, Math.floor(p.cy - p.ry)), y1 = Math.min(SH - 1, Math.ceil(p.cy + p.ry));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const dx = (x + 0.5 - p.cx) / p.rx, dy = (y + 0.5 - p.cy) / p.ry;
        const d = dx * dx + dy * dy;
        if (d >= 1) continue;
        const z = p.cz + p.rz * Math.sqrt(1 - d);
        put(y * SW + x, p.layer * 100 + z, z, p.id, p.tone ?? 0, p.mat ?? 0);
      }
  } else {
    const [ax, ay, bx, by, cx, cy] = p.p;
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-6) return;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(SW - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(SH - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den;
        const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den;
        const l3 = 1 - l1 - l2;
        if (l1 < 0 || l2 < 0 || l3 < 0) continue;
        const z = p.cz + p.rz * Math.min(l1, l2, l3) * 3;
        put(y * SW + x, p.layer * 100 + z, z, p.id, p.tone ?? 0, p.mat ?? 0);
      }
  }
}

type Anim = {
  sq: number; // squash (+ = wider/shorter)
  bob: number; // head offset px
  lift: number; // px above ground
  foot: number; // -1..1 walk phase
  tail: number; // -1..1
  ear: number; // -1..1
  eyes: "open" | "closed" | "happy" | "sad" | "wide" | "sleep";
  mouth: "smile" | "open" | "flat" | "chew";
  look: { x: number; y: number };
  xs: number; // x scale (spin)
  extra: "none" | "hearts" | "zzz" | "dots" | "sweat";
};

function animate(p: Pose): Anim {
  const t = p.t;
  const base: Anim = {
    sq: Math.sin(t * 2.1) * 0.03,
    bob: Math.sin(t * 2.1) * 0.4,
    lift: 0,
    foot: 0,
    tail: Math.sin(t * 2.6),
    ear: Math.sin(t * 1.3) * 0.5,
    eyes: p.blink ? "closed" : "open",
    mouth: "smile",
    look: p.look ?? { x: 0, y: 0 },
    xs: 1,
    extra: "none",
  };
  switch (p.mood) {
    case "walk": {
      const s = Math.sin(t * 10);
      return { ...base, foot: s, bob: -Math.abs(s) * 1.3, lift: Math.abs(s) * 1.1, tail: Math.sin(t * 8), ear: Math.sin(t * 10) * 0.8, sq: -Math.abs(s) * 0.04 };
    }
    case "happy": {
      const j = Math.abs(Math.sin(t * 7));
      return { ...base, lift: j * 3.2, bob: -j * 1.2, sq: j > 0.2 ? -0.07 : 0.12, eyes: "happy", mouth: "open", tail: Math.sin(t * 16), extra: "hearts", ear: Math.sin(t * 7) };
    }
    case "sleep":
      return { ...base, sq: 0.1 + Math.sin(t * 1.4) * 0.03, bob: 1.6 + Math.sin(t * 1.4) * 0.5, eyes: "sleep", mouth: "flat", tail: 0.2, ear: -0.4, extra: "zzz" };
    case "eat": {
      const c = Math.abs(Math.sin(t * 9));
      return { ...base, bob: c * 1.6, eyes: p.blink ? "closed" : "happy", mouth: c > 0.5 ? "chew" : "open", tail: Math.sin(t * 6) };
    }
    case "spin": {
      const j = Math.abs(Math.sin(t * 5));
      return { ...base, xs: Math.cos(t * 12), lift: j * 4, eyes: "happy", mouth: "open", tail: Math.sin(t * 14) };
    }
    case "think":
      return { ...base, look: { x: 0.8, y: -0.9 }, mouth: "flat", extra: "dots", tail: 0.2 };
    case "sad":
      return { ...base, bob: 1.2, sq: 0.05, eyes: "sad", mouth: "flat", tail: 0.1, ear: -0.9, extra: "sweat" };
    case "held":
      return { ...base, sq: -0.12, lift: 0, foot: Math.sin(t * 14) * 0.9, eyes: "wide", mouth: "open", tail: Math.sin(t * 12), ear: 0.9 };
    case "look":
      return { ...base, look: p.look ?? { x: 0, y: 0.8 } };
    default:
      return base;
  }
}

type Rig = { prims: Prim[]; decals: Decal[]; hx: number; hy: number; headTop: number; face: Face };
type Face = {
  eyeDx: number;
  eyeY: number;
  nose: "cat" | "bunny" | "dog" | "none";
  noseY: number;
  mouthY: number;
  whiskers: boolean;
  tongue: boolean;
};

function rig(sp: Species, a: Anim): Rig {
  const by = G - a.lift;
  const prims: Prim[] = [];
  const decals: Decal[] = [];
  const lf = Math.max(0, a.foot) * 1.8;
  const rf = Math.max(0, -a.foot) * 1.8;
  const lx = a.look.x * 0.8;

  if (sp === "cat") {
    const bry = 6.6 * (1 - a.sq), brx = 8.6 * (1 + a.sq * 0.8);
    const cy = by - 2 - bry;
    const hy = cy - bry * 0.55 - 5 + a.bob, hx = 16 + lx;
    const sw = a.tail;
    prims.push(ell(24.4, by - 6, 2.2, 2.4, 2.2, 1, 0, 6, -0.1));
    prims.push(ell(26.6 + sw * 0.8, by - 10.5, 2, 2.6, 2.1, 1, 0, 6, -0.1));
    prims.push(ell(27.4 + sw * 2, by - 15.2, 1.9, 2.6, 2, 1, 0, 6, 0.05));
    prims.push(ell(16, cy, brx, bry, 7, 0, 1, 1));
    prims.push(ell(11.8, by - 1.6 - lf, 3.1, 2.1, 3, 1, 2, 2, 0.12));
    prims.push(ell(20.2, by - 1.6 - rf, 3.1, 2.1, 3, 1, 2, 2, 0.12));
    const es = a.ear * 0.9;
    prims.push(tri([hx - 9.4, hy - 1.5, hx - 2.4, hy - 6.4, hx - 8.2 + es, hy - 12], 3.4, 3, 2, 4, -0.05));
    prims.push(tri([hx + 9.4, hy - 1.5, hx + 2.4, hy - 6.4, hx + 8.2 + es, hy - 12], 3.4, 3, 2, 4, -0.05));
    prims.push(tri([hx - 7.9, hy - 3.3, hx - 4.3, hy - 5.9, hx - 7.6 + es * 0.8, hy - 9.4], 1.2, 5.5, 2.2, 7, 0, 1));
    prims.push(tri([hx + 7.9, hy - 3.3, hx + 4.3, hy - 5.9, hx + 7.6 + es * 0.8, hy - 9.4], 1.2, 5.5, 2.2, 7, 0, 1));
    prims.push(ell(hx, hy, 9.7, 7.5, 8.5, 3, 3, 3, 0.04));
    decals.push({ cx: 16, cy: cy + 1.5, rx: 3.6, ry: 3.8, tone: 0.28, on: 1 });
    return { prims, decals, hx, hy, headTop: hy - 7.5, face: { eyeDx: 4, eyeY: 0.6, nose: "cat", noseY: 3, mouthY: 4.5, whiskers: true, tongue: false } };
  }

  if (sp === "bunny") {
    const bry = 6.9 * (1 - a.sq), brx = 7.8 * (1 + a.sq * 0.8);
    const cy = by - 2 - bry;
    const hy = cy - bry * 0.5 - 4.6 + a.bob, hx = 16 + lx;
    prims.push(ell(23.2, by - 5, 2.9, 2.9, 2.8, 1, 0, 6, 0.3));
    prims.push(ell(16, cy, brx, bry, 6.8, 0, 1, 1));
    prims.push(ell(11.6, by - 1.7 - lf, 3.4, 2.2, 3, 1, 2, 2, 0.12));
    prims.push(ell(20.4, by - 1.7 - rf, 3.4, 2.2, 3, 1, 2, 2, 0.12));
    const e = a.ear * 1.1;
    for (const s of [-1, 1]) {
      const ex = hx + s * 4.4;
      prims.push(ell(ex, hy - 8.6, 2.8, 5.8, 2.7, 3, 2, 4, -0.02));
      prims.push(ell(ex + s * 0.3 + e * s * 0.4, hy - 13.2, 2.6, 4.6, 2.5, 3, 2, 4, -0.02));
      prims.push(ell(ex, hy - 9.4, 1.1, 4.6, 1, 5.6, 2.2, 7, 0, 1));
    }
    prims.push(ell(hx, hy, 8.9, 7.2, 8, 3, 3, 3, 0.06));
    decals.push({ cx: 16, cy: cy + 1.5, rx: 3.4, ry: 3.6, tone: 0.3, on: 1 });
    return { prims, decals, hx, hy, headTop: hy - 7.2, face: { eyeDx: 3.7, eyeY: 0.8, nose: "bunny", noseY: 3, mouthY: 4.5, whiskers: false, tongue: false } };
  }

  if (sp === "blob") {
    const ry = 10.6 * (1 - a.sq), rx = 11.6 * (1 + a.sq * 0.9) + Math.sin(a.look.x * 0 + 1) * 0;
    const cy = by - ry - 0.5 + a.bob * 0.5;
    const top = cy - ry;
    prims.push(ell(16, top - 1.2, 1, 3.2, 1, 1, 0, 6, -0.1));
    prims.push(ell(16 + a.tail * 1.5, top - 5.6, 2.5, 2.5, 2.5, 2, 2, 5, 0.1, 1));
    prims.push(ell(16, cy, rx, ry, 10, 0, 1, 1));
    prims.push(ell(9.4, by - 1.4 - lf, 2.8, 1.9, 2.4, 1, 2, 2, 0.1));
    prims.push(ell(22.6, by - 1.4 - rf, 2.8, 1.9, 2.4, 1, 2, 2, 0.1));
    decals.push({ cx: 10.8, cy: top + 4.8, rx: 3.2, ry: 2, tone: 0.55, on: 1 });
    decals.push({ cx: 21.5, cy: cy + ry * 0.45, rx: 5, ry: 2.3, tone: -0.2, on: 1 });
    return { prims, decals, hx: 16 + lx, hy: cy - 1 + a.bob * 0.4, headTop: top - 1, face: { eyeDx: 4.6, eyeY: 0, nose: "none", noseY: 3, mouthY: 4.4, whiskers: false, tongue: false } };
  }

  if (sp === "fox") {
    const bry = 6.2 * (1 - a.sq), brx = 8.2 * (1 + a.sq * 0.8);
    const cy = by - 2 - bry;
    const hy = cy - bry * 0.55 - 5 + a.bob, hx = 16 + lx;
    const sw = a.tail;
    // long fluffy tail with pale tip
    prims.push(ell(23.6 + sw * 0.5, by - 5.2, 2.4, 2.5, 2.3, 1, 0, 6, -0.08));
    prims.push(ell(26.2 + sw * 1.3, by - 9.8, 2.2, 2.8, 2.2, 1, 0, 6, 0.02));
    prims.push(ell(27.6 + sw * 1.8, by - 14.4, 2, 2.8, 2, 1, 0, 6, 0.1));
    prims.push(ell(28 + sw * 1.8, by - 17.8, 1.7, 2.2, 1.7, 1, 0, 6, 0.16));
    prims.push(ell(16, cy, brx, bry, 6.8, 0, 1, 1));
    prims.push(ell(11.9, by - 1.6 - lf, 3, 2, 2.9, 1, 2, 2, 0.12));
    prims.push(ell(20.1, by - 1.6 - rf, 3, 2, 2.9, 1, 2, 2, 0.12));
    // big pointed ears with accent inner
    const es = a.ear * 1.1;
    prims.push(tri([hx - 9.8, hy - 1.2, hx - 2.8, hy - 6.8, hx - 8.8 + es, hy - 14.2], 3.4, 3, 2, 4, -0.06));
    prims.push(tri([hx + 9.8, hy - 1.2, hx + 2.8, hy - 6.8, hx + 8.8 + es, hy - 14.2], 3.4, 3, 2, 4, -0.06));
    prims.push(tri([hx - 8.2, hy - 3.2, hx - 4.9, hy - 6, hx - 8 + es * 0.8, hy - 11.4], 1.2, 5.5, 2.2, 7, 0, 1));
    prims.push(tri([hx + 8.2, hy - 3.2, hx + 4.9, hy - 6, hx + 8 + es * 0.8, hy - 11.4], 1.2, 5.5, 2.2, 7, 0, 1));
    prims.push(ell(hx, hy, 9.4, 7.2, 8.2, 3, 3, 3, 0.04));
    // white muzzle + cheek fluff
    decals.push({ cx: hx, cy: hy + 2.7, rx: 2.7, ry: 1.8, tone: 0.5, on: 3 });
    decals.push({ cx: hx - 5.9, cy: hy + 2.4, rx: 2.7, ry: 2.1, tone: 0.45, on: 3 });
    decals.push({ cx: hx + 5.9, cy: hy + 2.4, rx: 2.7, ry: 2.1, tone: 0.45, on: 3 });
    decals.push({ cx: 16, cy: cy + 2.2, rx: 3.1, ry: 2.9, tone: 0.32, on: 1 });
    return { prims, decals, hx, hy, headTop: hy - 7.2, face: { eyeDx: 4.2, eyeY: 0.4, nose: "cat", noseY: 2.6, mouthY: 4.2, whiskers: false, tongue: false } };
  }

  if (sp === "panda") {
    const bry = 7 * (1 - a.sq), brx = 9.4 * (1 + a.sq * 0.8);
    const cy = by - 1.6 - bry;
    const hy = cy - bry * 0.5 - 4.6 + a.bob, hx = 16 + lx;
    prims.push(ell(25.2, by - 4.4, 2, 2, 1.9, 1, 0, 6, 0.2)); // tiny tail puff
    prims.push(ell(16, cy, brx, bry, 7.4, 0, 1, 1));
    prims.push(ell(11.4, by - 1.7 - lf, 3.3, 2.2, 3, 1, 2, 2, -0.2)); // dark paws
    prims.push(ell(20.6, by - 1.7 - rf, 3.3, 2.2, 3, 1, 2, 2, -0.2));
    prims.push(ell(hx - 8.5, hy - 5.4 + a.ear * 0.3, 2.9, 2.9, 2.8, 2, 2, 4, -0.26)); // round dark ears
    prims.push(ell(hx + 8.5, hy - 5.4 + a.ear * 0.3, 2.9, 2.9, 2.8, 2, 2, 4, -0.26));
    prims.push(ell(hx, hy, 9.9, 7.4, 8.6, 3, 3, 3, 0.05));
    decals.push({ cx: hx - 4.2, cy: hy + 0.9, rx: 2.7, ry: 3.1, tone: -0.34, on: 3 }); // eye patches
    decals.push({ cx: hx + 4.2, cy: hy + 0.9, rx: 2.7, ry: 3.1, tone: -0.34, on: 3 });
    decals.push({ cx: 16, cy: cy + 2.2, rx: 4.3, ry: 4.2, tone: 0.3, on: 1 }); // light belly
    return { prims, decals, hx, hy, headTop: hy - 7.4, face: { eyeDx: 4.2, eyeY: 0.9, nose: "dog", noseY: 3, mouthY: 4.8, whiskers: false, tongue: false } };
  }

  if (sp === "frog") {
    const bry = 6.6 * (1 - a.sq), brx = 11.4 * (1 + a.sq * 0.9);
    const cy = by - 1.2 - bry;
    const bumpY = cy - bry - 1.6 + a.bob * 0.7;
    prims.push(ell(16, cy, brx, bry, 8, 0, 1, 1)); // wide squat body
    prims.push(ell(10.2, by - 1 - lf, 3.5, 1.8, 2.6, 1, 2, 2, 0.1)); // flat feet
    prims.push(ell(21.8, by - 1 - rf, 3.5, 1.8, 2.6, 1, 2, 2, 0.1));
    prims.push(ell(16 - 5.6, bumpY, 3, 2.9, 2.8, 2.5, 3, 4, -0.02)); // eye bumps on top
    prims.push(ell(16 + 5.6, bumpY, 3, 2.9, 2.8, 2.5, 3, 4, -0.02));
    decals.push({ cx: 16, cy: cy + 3.4, rx: 6, ry: 3.2, tone: 0.32, on: 1 }); // light belly
    decals.push({ cx: 16, cy: bumpY + 5.4, rx: 4.4, ry: 0.9, tone: -0.35, on: 1 }); // wide mouth line
    return { prims, decals, hx: 16 + lx, hy: bumpY, headTop: bumpY - 3.9, face: { eyeDx: 5.6, eyeY: 0.2, nose: "none", noseY: 3, mouthY: 5.2, whiskers: false, tongue: false } };
  }

  if (sp === "penguin") {
    const ry = 10.4 * (1 - a.sq), rx = 7 * (1 + a.sq * 0.8);
    const cy = by - 0.6 - ry;
    const hy = cy - ry + 4.6 + a.bob, hx = 16 + lx;
    prims.push(ell(16, cy, rx, ry, 6.4, 0, 1, 1)); // upright capsule
    prims.push(ell(16 - 7.7, cy + 1.2 + a.ear * 1.2, 2.2, 5, 2, 1.5, 2, 4, -0.15)); // flippers
    prims.push(ell(16 + 7.7, cy + 1.2 + a.ear * 1.2, 2.2, 5, 2, 1.5, 2, 4, -0.15));
    prims.push(ell(12.9, by - 0.9 - lf, 2.3, 1.2, 2, 1, 2, 2, 0.1, 1)); // accent feet
    prims.push(ell(19.1, by - 0.9 - rf, 2.3, 1.2, 2, 1, 2, 2, 0.1, 1));
    prims.push(tri([hx - 1.9, hy + 1.7, hx + 1.9, hy + 1.7, hx, hy + 4.3], 1.4, 7.5, 4, 5, 0.05, 1)); // accent beak
    decals.push({ cx: 16, cy: hy + 1.2, rx: 4.8, ry: 3.6, tone: 0.45, on: 1 }); // light face
    decals.push({ cx: 16, cy: cy + 2.8, rx: 4.7, ry: 6.8, tone: 0.55, on: 1 }); // white belly
    return { prims, decals, hx, hy, headTop: cy - ry, face: { eyeDx: 3.3, eyeY: 0, nose: "none", noseY: 3, mouthY: 4.2, whiskers: false, tongue: false } };
  }

  if (sp === "ghost") {
    const flo = 3.2 + (1 + a.tail) * 0.9; // gentle float wave
    const gy = by - flo;
    a.lift += flo; // smaller, dimmer ground shadow
    if (a.eyes === "open") a.eyes = "happy"; // default cozy closed-happy eyes
    const ry = 6.8 * (1 - a.sq), rx = 8.8 * (1 + a.sq * 0.8);
    const cy = gy - 7.6 + a.bob * 0.4;
    prims.push(ell(16, cy, rx, ry, 7, 0, 1, 1, 0.1)); // rounded dome
    prims.push(ell(9.2, gy - 2.8, 2.6, 2.6, 2.4, 0, 1, 1, 0.1)); // wavy hem scallops
    prims.push(ell(13.2, gy - 1.6, 2.7, 2.7, 2.5, 0, 1, 1, 0.1));
    prims.push(ell(17.2, gy - 1.3, 2.8, 2.8, 2.6, 0, 1, 1, 0.1));
    prims.push(ell(21.2, gy - 1.6, 2.7, 2.7, 2.5, 0, 1, 1, 0.1));
    prims.push(ell(24.4, gy - 2.9, 2.5, 2.5, 2.3, 0, 1, 1, 0.1));
    prims.push(ell(16 - 9.8, cy + 2.2 + a.ear * 1.1, 1.9, 2.5, 1.8, 1.5, 2, 4, 0.12)); // nub arms
    prims.push(ell(16 + 9.8, cy + 2.2 + a.ear * 1.1, 1.9, 2.5, 1.8, 1.5, 2, 4, 0.12));
    const hy = cy - 1 + a.bob * 0.4, hx = 16 + lx;
    return { prims, decals, hx, hy, headTop: cy - ry - 0.5, face: { eyeDx: 4.3, eyeY: 0.6, nose: "none", noseY: 3, mouthY: 4.6, whiskers: false, tongue: false } };
  }

  if (sp === "dragon") {
    const bry = 5.8 * (1 - a.sq), brx = 7.4 * (1 + a.sq * 0.8);
    const cy = by - 2 - bry;
    const hy = cy - bry * 0.5 - 4.8 + a.bob, hx = 16 + lx;
    const tw = a.tail, e = a.ear * 2.2, es = a.ear * 0.5;
    prims.push(ell(24.2 + tw * 1.4, by - 5.2, 2, 3, 2, 1, 0, 6, -0.05)); // tail
    prims.push(ell(26.6 + tw * 2, by - 8.4, 1.6, 1.9, 1.6, 1, 0, 6, 0.02));
    prims.push(tri([26 + tw * 2, by - 9.4, 28.7 + tw * 2, by - 8.8, 27.4 + tw * 2, by - 11.8], 1.1, 3.5, 0.3, 8, 0.12, 1)); // tail spike
    prims.push(tri([hx - 2.2, cy - 2.5, hx - 11.8, cy - 9.5 - e, hx - 10.2, cy + 0.6 + e * 0.4], 2.4, 1, 0.5, 5, -0.12)); // flapping wings
    prims.push(tri([hx + 2.2, cy - 2.5, hx + 11.8, cy - 9.5 - e, hx + 10.2, cy + 0.6 + e * 0.4], 2.4, 1, 0.5, 5, -0.12));
    prims.push(ell(16, cy, brx, bry, 6, 0, 1, 1));
    prims.push(ell(12.2, by - 1.5 - lf, 2.7, 1.9, 2.6, 1, 2, 2, 0.12));
    prims.push(ell(19.8, by - 1.5 - rf, 2.7, 1.9, 2.6, 1, 2, 2, 0.12));
    prims.push(tri([hx - 4.8, hy - 4.4, hx - 2.8, hy - 5, hx - 4.2 + es, hy - 8.2], 1.3, 5, 2, 7, 0.1, 1)); // tiny horns
    prims.push(tri([hx + 4.8, hy - 4.4, hx + 2.8, hy - 5, hx + 4.2 + es, hy - 8.2], 1.3, 5, 2, 7, 0.1, 1));
    prims.push(ell(hx, hy, 8.4, 6.6, 7.6, 3, 3, 3, 0.04));
    decals.push({ cx: hx, cy: hy + 2.8, rx: 3.2, ry: 2, tone: 0.45, on: 3 }); // light snout
    decals.push({ cx: 16, cy: cy + 1.8, rx: 3.5, ry: 3.4, tone: 0.3, on: 1 }); // belly
    return { prims, decals, hx, hy, headTop: hy - 6.6, face: { eyeDx: 4.1, eyeY: 0.3, nose: "dog", noseY: 2.4, mouthY: 4.6, whiskers: false, tongue: false } };
  }

  if (sp === "axolotl") {
    const bry = 5.6 * (1 - a.sq), brx = 8.8 * (1 + a.sq * 0.8);
    const cy = by - 1.8 - bry;
    const hy = cy - bry * 0.5 - 4.2 + a.bob, hx = 16 + lx;
    const wig = a.ear * 1.3; // gill wiggle
    prims.push(ell(22.8, by - 3.4, 2.2, 2.4, 2, 1, 0, 6, 0)); // tail base
    prims.push(ell(25.4, by - 5, 2.9, 3.6, 1.3, 0, 0, 6, -0.02)); // flat tail fin
    prims.push(ell(16, cy, brx, bry, 6.4, 0, 1, 1));
    prims.push(ell(11.6, by - 1.5 - lf, 2.9, 1.9, 2.6, 1, 2, 2, 0.1));
    prims.push(ell(20.4, by - 1.5 - rf, 2.9, 1.9, 2.6, 1, 2, 2, 0.1));
    for (const s of [-1, 1]) {
      prims.push(ell(hx + s * 9.2, hy - 4.4 + wig * 0.4, 1.5, 2.2, 1.4, 2, 2, 4, 0, 1)); // 3 gill fronds
      prims.push(ell(hx + s * 10.6, hy - 1.1 + wig * 0.6, 1.7, 2.4, 1.5, 2, 2, 4, 0, 1));
      prims.push(ell(hx + s * 9.4, hy + 2.2 + wig * 0.5, 1.5, 2.2, 1.4, 2, 2, 4, 0, 1));
    }
    prims.push(ell(hx, hy, 9.2, 6.4, 7.6, 3, 3, 3, 0.05));
    decals.push({ cx: hx, cy: hy + 4.4, rx: 3.4, ry: 0.8, tone: -0.28, on: 3 }); // wide smile line
    decals.push({ cx: 16, cy: cy + 2, rx: 4.2, ry: 3.2, tone: 0.35, on: 1 }); // light belly
    return { prims, decals, hx, hy, headTop: hy - 6.4, face: { eyeDx: 4.6, eyeY: 0.2, nose: "none", noseY: 3, mouthY: 4.6, whiskers: false, tongue: false } };
  }

  if (sp === "owl") {
    const bry = 8.6 * (1 - a.sq), brx = 9.5 * (1 + a.sq * 0.8);
    const cy = by - 1.4 - bry;
    const hy = cy - bry * 0.42 + a.bob, hx = 16 + lx;
    const e = a.ear * 0.5;
    prims.push(ell(16, cy, brx, bry, 7.6, 0, 1, 1)); // one round egg body
    prims.push(tri([hx - 7.8, cy - bry + 2.2, hx - 3.2, cy - bry + 1.4, hx - 6.8 - e, cy - bry - 3.2], 1.8, 2, 0.5, 5, -0.05)); // ear tufts
    prims.push(tri([hx + 7.8, cy - bry + 2.2, hx + 3.2, cy - bry + 1.4, hx + 6.8 + e, cy - bry - 3.2], 1.8, 2, 0.5, 5, -0.05));
    prims.push(tri([hx - 1.5, hy + 2.6, hx + 1.5, hy + 2.6, hx, hy + 5.2], 1.3, 7, 4, 5, 0, 1)); // accent beak
    prims.push(ell(12.9, by - 1 - lf * 0.6, 2.2, 1.2, 2, 1, 2, 2, 0.1, 1)); // accent talons
    prims.push(ell(19.1, by - 1 - rf * 0.6, 2.2, 1.2, 2, 1, 2, 2, 0.1, 1));
    decals.push({ cx: 16, cy: hy + 0.6, rx: 6.3, ry: 5.2, tone: 0.42, on: 1 }); // flat face disc
    decals.push({ cx: hx - 3.5, cy: hy + 0.7, rx: 2.4, ry: 2.6, tone: -0.55, on: 1 }); // big round eyes
    decals.push({ cx: hx + 3.5, cy: hy + 0.7, rx: 2.4, ry: 2.6, tone: -0.55, on: 1 });
    decals.push({ cx: hx - 7.6, cy: cy + 1.8, rx: 1.7, ry: 5.2, tone: -0.2, on: 1 }); // folded wing panels
    decals.push({ cx: hx + 7.6, cy: cy + 1.8, rx: 1.7, ry: 5.2, tone: -0.2, on: 1 });
    return { prims, decals, hx, hy, headTop: cy - bry - 2.6, face: { eyeDx: 3.5, eyeY: 0.7, nose: "none", noseY: 3, mouthY: 5, whiskers: false, tongue: false } };
  }

  // dog
  const bry = 6.5 * (1 - a.sq), brx = 8.3 * (1 + a.sq * 0.8);
  const cy = by - 2 - bry;
  const hy = cy - bry * 0.55 - 5 + a.bob, hx = 16 + lx;
  const tw = a.tail;
  prims.push(ell(24.6 + tw * 1.6, by - 9, 1.9, 3.8, 2, 1, 0, 6, -0.05));
  prims.push(ell(16, cy, brx, bry, 7, 0, 1, 1));
  prims.push(ell(11.8, by - 1.6 - lf, 3.2, 2.1, 3, 1, 2, 2, 0.12));
  prims.push(ell(20.2, by - 1.6 - rf, 3.2, 2.1, 3, 1, 2, 2, 0.12));
  prims.push(ell(hx, hy, 9.3, 7.5, 8.3, 3, 3, 3, 0.04));
  const es = a.ear * 1.2;
  prims.push(ell(hx - 9.6, hy + 1.2 + es * 0.3, 3.4, 5.8, 3, 2, 2, 4, -0.32));
  prims.push(ell(hx + 9.6, hy + 1.2 + es * 0.3, 3.4, 5.8, 3, 2, 2, 4, -0.32));
  prims.push(ell(hx, hy + 3.4, 4.8, 3.5, 3, 7, 5, 5, 0.25));
  decals.push({ cx: hx + 4.6, cy: hy - 1, rx: 3.4, ry: 3.2, tone: -0.32, on: 3 });
  decals.push({ cx: 16, cy: cy + 1.5, rx: 3.5, ry: 3.8, tone: 0.28, on: 1 });
  return { prims, decals, hx, hy, headTop: hy - 7.5, face: { eyeDx: 4.3, eyeY: -1, nose: "dog", noseY: 1.8, mouthY: 4.4, whiskers: false, tongue: true } };
}

const HATS: Record<string, string[]> = {
  beanie: [
    "......aa......",
    ".....aaaa.....",
    "...00000000...",
    "..0aaaaaaaa0..",
    ".0aaAaaAaaAa0.",
    ".0AAAAAAAAAA0.",
  ],
  bow: ["aa.0.aa", "aAa0aAa", "aa.0.aa"],
  crown: ["0.0.0.0.0", "040404040", "044444440", "033333330", "000000000"],
  shades: ["0000000000000", "0044000004400", ".00000.00000."],
  wizard: [
    ".....000.....",
    "....0aaa0....",
    "....0aAa0....",
    "...0aaaaa0...",
    "...0aAAAa0...",
    "..0aaaaaaa0..",
    "0000000000000",
  ],
};

const HEART = [".a.a.", "aaaaa", ".aaa.", "..a.."];

export function renderPetPixels(sp: Species, pose: Pose, pal: Palette, hat: string, out: Uint8ClampedArray): void {
  const a = animate(pose);
  const r = rig(sp, a);
  KEY.fill(-1e9);
  OWN.fill(0);
  for (const p of r.prims) rasterize(p);

  const rgba = new Uint8ClampedArray(N * 4);
  const [r0, r1, r2, r3, r4] = pal.ramp;
  void r2;
  const body = [pal.ramp[1], pal.ramp[2], pal.ramp[3], pal.ramp[4]];
  const mix = (c: RGB, d: RGB, k: number): RGB => [c[0] + (d[0] - c[0]) * k, c[1] + (d[1] - c[1]) * k, c[2] + (d[2] - c[2]) * k];
  const acc = [mix(pal.accent, r0, 0.5), mix(pal.accent, r0, 0.2), pal.accent, mix(pal.accent, r4, 0.4)];
  const has = (i: number) => KEY[i] > -1e8;
  const setpx = (x: number, y: number, c: RGB, alpha = 255) => {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= SW || y >= SH) return;
    const o = (y * SW + x) * 4;
    rgba[o] = c[0];
    rgba[o + 1] = c[1];
    rgba[o + 2] = c[2];
    rgba[o + 3] = alpha;
  };

  // decals
  for (let i = 0; i < N; i++) TONE[i] += 0;
  for (const d of r.decals) {
    const x0 = Math.max(0, Math.floor(d.cx - d.rx)), x1 = Math.min(SW - 1, Math.ceil(d.cx + d.rx));
    const y0 = Math.max(0, Math.floor(d.cy - d.ry)), y1 = Math.min(SH - 1, Math.ceil(d.cy + d.ry));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const i = y * SW + x;
        if (!has(i) || OWN[i] !== d.on) continue;
        const dx = (x + 0.5 - d.cx) / d.rx, dy = (y + 0.5 - d.cy) / d.ry;
        if (dx * dx + dy * dy < 1) TONE[i] += d.tone;
      }
  }

  // ground shadow (dithered)
  const sh = Math.max(0.55, 1 - a.lift / 14);
  for (let y = G + 1; y < SH; y++)
    for (let x = 0; x < SW; x++) {
      const dx = (x + 0.5 - 16) / (11 * sh), dy = (y + 0.5 - (G + 1.8)) / 1.7;
      if (dx * dx + dy * dy < 1 && (x + y) % 2 === 0) setpx(x, y, r0, 110);
    }

  const L = [-0.45, -0.6, 0.66];
  const zAt = (x: number, y: number, i: number, own: number) => {
    if (x < 0 || y < 0 || x >= SW || y >= SH) return ZL[i] - 3;
    const j = y * SW + x;
    return has(j) && OWN[j] === own ? ZL[j] : ZL[i] - 3;
  };
  for (let y = 0; y < SH; y++)
    for (let x = 0; x < SW; x++) {
      const i = y * SW + x;
      if (!has(i)) continue;
      const own = OWN[i];
      // outline: silhouette edge or occlusion edge
      let edge = false;
      let occl = false;
      for (let k = 0; k < 4; k++) {
        const nx = x + (k === 0 ? -1 : k === 1 ? 1 : 0), ny = y + (k === 2 ? -1 : k === 3 ? 1 : 0);
        if (nx < 0 || ny < 0 || nx >= SW || ny >= SH) { edge = true; break; }
        const j = ny * SW + nx;
        if (!has(j)) { edge = true; break; }
        if (OWN[j] !== own && KEY[j] - KEY[i] > 40) occl = true;
      }
      if (edge || occl) { setpx(x, y, edge ? r0 : r0); continue; }
      const dzdx = (zAt(x + 1, y, i, own) - zAt(x - 1, y, i, own)) / 2;
      const dzdy = (zAt(x, y + 1, i, own) - zAt(x, y - 1, i, own)) / 2;
      const nx = -dzdx, ny = -dzdy, nz = 1;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const I = Math.max(0, Math.min(1, (nx * L[0] + ny * L[1] + nz * L[2]) / len));
      const v = 0.05 + 0.74 * I + TONE[i];
      const b = (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
      let lev = Math.floor(v * 4 + 0.5 + (b - 0.5) * 0.6);
      lev = lev < 0 ? 0 : lev > 3 ? 3 : lev;
      setpx(x, y, MAT[i] === 1 ? acc[lev] : body[lev]);
    }

  // face
  const f = r.face;
  const hx = r.hx, hy = r.hy;
  const ex = f.eyeDx;
  const ey = hy + f.eyeY + a.look.y * 1.1;
  const elx = a.look.x * 1.3;
  const drawEye = (cx: number, side: number) => {
    const x = Math.round(cx + elx), y = Math.round(ey);
    switch (a.eyes) {
      case "open":
        setpx(x - 1, y - 1, r0); setpx(x, y - 1, r0); setpx(x - 1, y, r0); setpx(x, y, r0); setpx(x - 1, y + 1, r0); setpx(x, y + 1, r0);
        setpx(x - 1, y - 1, r4);
        break;
      case "wide":
        for (let yy = -2; yy <= 1; yy++) { setpx(x - 1, y + yy, r0); setpx(x, y + yy, r0); }
        setpx(x - 1, y - 2, r4); setpx(x, y - 2, r4);
        break;
      case "closed":
        setpx(x - 1, y + 1, r0); setpx(x, y + 1, r0); setpx(x + 1, y + 1, r0);
        break;
      case "sleep":
        setpx(x - 1, y, r0); setpx(x, y + 1, r0); setpx(x + 1, y, r0);
        break;
      case "happy":
        setpx(x - 1, y + 1, r0); setpx(x, y, r0); setpx(x + 1, y + 1, r0);
        break;
      case "sad":
        setpx(x - 1, y, r0); setpx(x, y, r0); setpx(x - 1, y + 1, r0); setpx(x, y + 1, r0);
        setpx(x - 1 + (side < 0 ? 0 : 1), y - 2 + (side < 0 ? 1 : 0), r0); setpx(x + (side < 0 ? -1 : 1), y - 1, r0);
        break;
    }
  };
  drawEye(hx - ex, -1);
  drawEye(hx + ex, 1);

  const nx0 = Math.round(hx + elx * 0.6);
  if (f.nose === "cat") { setpx(nx0 - 1, hy + f.noseY, pal.accent); setpx(nx0, hy + f.noseY, pal.accent); }
  if (f.nose === "bunny") { setpx(nx0 - 1, hy + f.noseY, pal.accent); setpx(nx0, hy + f.noseY, pal.accent); setpx(nx0 - 1, hy + f.noseY + 1, pal.accent); setpx(nx0, hy + f.noseY + 1, pal.accent); }
  if (f.nose === "dog") { for (let dx = -1; dx <= 1; dx++) { setpx(nx0 + dx, hy + f.noseY, r0); } setpx(nx0, hy + f.noseY + 1, r0); }
  const my = Math.round(hy + f.mouthY);
  if (a.mouth === "smile") {
    if (f.nose === "none") { setpx(nx0 - 1, my, r0); setpx(nx0, my + 1, r0); setpx(nx0 + 1, my, r0); }
    else { setpx(nx0 - 2, my - 1, r0); setpx(nx0 - 1, my, r0); setpx(nx0, my, r0); setpx(nx0 + 1, my - 1, r0); }
  } else if (a.mouth === "open" || a.mouth === "chew") {
    const w = a.mouth === "chew" ? 1 : 2;
    for (let dx = -w; dx < w; dx++) { setpx(nx0 + dx, my, r0); setpx(nx0 + dx, my + 1, a.mouth === "chew" ? r0 : pal.accent); }
    setpx(nx0 - w - 0, my - 1, r0);
    if (a.mouth === "open") { setpx(nx0 - 2, my + 1, r0); setpx(nx0 + 1, my + 1, r0); setpx(nx0 - 1, my + 1, pal.accent); setpx(nx0, my + 1, pal.accent); setpx(nx0 - 1, my + 2, r0); setpx(nx0, my + 2, r0); }
  } else {
    setpx(nx0 - 1, my, r0); setpx(nx0, my, r0);
  }
  if (f.whiskers) {
    for (const s of [-1, 1]) {
      setpx(hx + s * 8, hy + 2.6, r3); setpx(hx + s * 7, hy + 3, r3); setpx(hx + s * 8, hy + 4.2, r3);
    }
  }
  if (a.eyes === "happy" || pose.mood === "eat") {
    for (const s of [-1, 1]) { setpx(hx + s * 6.6, hy + 2.8, pal.accent, 200); setpx(hx + s * 5.6, hy + 2.8, pal.accent, 200); }
  }
  void r1;

  // hat
  if (hat && HATS[hat]) {
    const rows = HATS[hat];
    const w = rows[0].length;
    const shades = hat === "shades";
    const ax = Math.round(hx - w / 2 + (hat === "bow" ? 7 : 0));
    const ay = shades ? Math.round(ey - 1.5) : Math.round(r.headTop + (hat === "bow" ? 1.6 : 1.6) - rows.length + (hat === "bow" ? 1 : 0));
    rows.forEach((row, ry) => {
      for (let rx = 0; rx < row.length; rx++) {
        const ch = row[rx];
        if (ch === ".") continue;
        const c = ch === "a" ? pal.accent : ch === "A" ? acc[1] : ch === "0" ? r0 : pal.ramp[Number(ch)] ?? r0;
        setpx(ax + rx, ay + ry, c);
      }
    });
  }

  // extras
  if (a.extra === "hearts") {
    for (let k = 0; k < 2; k++) {
      const ph = (pose.t * 1.6 + k * 0.5) % 1;
      const hxp = hx + (k ? 8 : -12) + Math.sin(ph * 6) * 1.5;
      const hyp = r.headTop - 1 - ph * 10;
      HEART.forEach((row, ry) => [...row].forEach((ch, rx) => ch === "a" && setpx(hxp + rx, hyp + ry, ph > 0.8 ? acc[3] : pal.accent, Math.round(255 * (1 - Math.max(0, ph - 0.7) * 2.5)))));
    }
  } else if (a.extra === "zzz") {
    for (let k = 0; k < 2; k++) {
      const ph = (pose.t * 0.45 + k * 0.5) % 1;
      const zx = hx + 7 + ph * 5 + k * 2, zy = r.headTop + 1 - ph * 9;
      const s = k ? 3 : 2;
      const al = Math.round(255 * Math.min(1, (1 - ph) * 2));
      for (let i = 0; i < s + 1; i++) { setpx(zx + i, zy, r4, al); setpx(zx + i, zy + s, r4, al); }
      for (let i = 1; i < s; i++) setpx(zx + s - i, zy + i, r4, al);
    }
  } else if (a.extra === "dots") {
    const n = Math.floor(pose.t * 2.5) % 4;
    for (let k = 0; k < 3; k++) if (k < n) { setpx(hx + 8 + k * 3, r.headTop - 2, r4); setpx(hx + 9 + k * 3, r.headTop - 2, r4); }
  } else if (a.extra === "sweat") {
    const ph = (pose.t * 0.9) % 1;
    setpx(hx + 8, hy - 3 + ph * 6, r4, Math.round(255 * (1 - ph)));
    setpx(hx + 8, hy - 2 + ph * 6, r4, Math.round(255 * (1 - ph)));
  }

  // final blit with x scale + facing flip
  const facing = pose.facing ?? 1;
  const xs = a.xs === 0 ? 0.001 : a.xs;
  out.fill(0);
  for (let y = 0; y < SH; y++)
    for (let x = 0; x < SW; x++) {
      const sx = Math.floor(16 + (x + 0.5 - 16) / (xs * facing));
      if (sx < 0 || sx >= SW) continue;
      const o = (y * SW + x) * 4, s = (y * SW + sx) * 4;
      out[o] = rgba[s];
      out[o + 1] = rgba[s + 1];
      out[o + 2] = rgba[s + 2];
      out[o + 3] = rgba[s + 3];
    }
}

let imgCache: ImageData | null = null;
export function drawPet(ctx: CanvasRenderingContext2D, sp: Species, pose: Pose, pal: Palette, hat: string) {
  if (!imgCache) imgCache = ctx.createImageData(SW, SH);
  renderPetPixels(sp, pose, pal, hat, imgCache.data);
  ctx.clearRect(0, 0, SW, SH);
  ctx.putImageData(imgCache, 0, 0);
}
