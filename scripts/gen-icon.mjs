#!/usr/bin/env node
/**
 * Nook icon generator — deterministic, dependency-free (Node >= 19 has zlib).
 *
 * Draws a cozy "nook" mark: rounded-squircle dusk gradient, soft glow, pixel
 * moon + twinkles, a lime pixel bean with a face, and a warm lamp dot. The same
 * vector-ish recipe renders at every size, so 16px stays crisp and 1024px pops.
 *
 * Outputs (overwrites):
 *   src-tauri/icons/{16,32,48,64,128,128x128,256,512,1024}.png
 *   src-tauri/icons/icon.png        (1024)
 *   src-tauri/icons/tray-icon.png   (256 RGBA)
 *   src-tauri/icons/icon.ico        (multi-res Windows icon: 16..256) <- used by tauri-bundler
 *   public/icon-{192,512}.png       (web PWA/favicon art)
 *   build/icon.ico                  (same ICO, legacy location)
 *
 * Usage:  node scripts/gen-icon.mjs
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const OUT_TAURI = path.join(ROOT, "src-tauri", "icons");
const OUT_PUBLIC = path.join(ROOT, "public");
const OUT_BUILD = path.join(ROOT, "build");
for (const d of [OUT_TAURI, OUT_PUBLIC, OUT_BUILD]) mkdirSync(d, { recursive: true });

// ---------------------------------------------------------------------------
// tiny PNG writer (RGBA -> color type 6)
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// drawing helpers (supersampled 4x, normalized coords 0..1)
// ---------------------------------------------------------------------------
const SS = 4;
function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}
function hex(h) {
  const n = parseInt(h.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function mix(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}
// smoothstep-style coverage for anti-aliased shapes
function cover(d, r) {
  const w = 1 / (SS * 2);
  return clamp((r - d) / w + 0.5, 0, 1);
}

const SKY_TOP = hex("#1d2340");
const SKY_MID = hex("#3f3357");
const SKY_BOT = hex("#6b4a63");
const LIME = hex("#a8e05f");
const LIME_DK = hex("#7cc242");
const CREAM = hex("#fff7e8");
const INK = hex("#241f31");
const GOLD = hex("#ffd166");

// The bean is drawn on a 16x16 logical pixel grid. At small canvas sizes we
// skip the eyes so the silhouette stays readable at 16px.
const BEAN_MASK = [
  "................",
  "................",
  ".....######.....",
  "....########....",
  "...##########...",
  "..############..",
  "..############..",
  "..############..",
  "..############..",
  "..############..",
  "...##########...",
  "....########....",
  "................",
  "................",
  "................",
  "................",
];
const EYE_MASK = [
  "................",
  "................",
  "................",
  "................",
  "................",
  "......##...##...",
  "......##...##...",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
];

function drawIcon(size) {
  const S = size * SS;
  const buf = Buffer.alloc(size * size * 4);
  const G = 16;
  const showEyes = size >= 48;

  for (let py = 0; py < S; py++) {
    const y = (py + 0.5) / S;
    for (let pxx = 0; pxx < S; pxx++) {
      const x = (pxx + 0.5) / S;
      // ---- background squircle with vertical dusk gradient ----
      const dx = x - 0.5, dy = y - 0.5;
      const rr = 0.505;
      const n = 4.2;
      const e = Math.pow(Math.pow(Math.abs(dx) / rr, n) + Math.pow(Math.abs(dy) / rr, n), 1 / n);
      const inside = e <= 1;
      let alpha = 0, r = 0, g = 0, b = 0;

      // bean grid geometry (computed once per pixel, also used for the glow)
      const cs = 0.42 / G; // bean occupies ~42% of the icon width (pixel-grid cells)
      const ox = 0.5 - (G * cs) / 2;
      const oy = 0.86 - (G * cs); // bottom row of grid rests near the ground line
      const cxg = Math.floor((x - ox) / cs);
      const cyg = Math.floor((y - oy) / cs);
      const onBean =
        cxg >= 0 && cxg < G && cyg >= 0 && cyg < G && BEAN_MASK[cyg][cxg] === "#";

      if (inside) {
        const t = clamp(y, 0, 1);
        let col = t < 0.55 ? mix(SKY_TOP, SKY_MID, t / 0.55) : mix(SKY_MID, SKY_BOT, (t - 0.55) / 0.45);
        // soft radial glow behind the bean (warm center-bottom light)
        const gd = Math.hypot(x - 0.5, y - 0.66);
        const glow = Math.max(0, 1 - gd / 0.42);
        col = mix(col, [255, 214, 150], glow * 0.35);
        // vignette toward edges
        const vg = clamp(e, 0, 1);
        col = mix(col, [col[0] * 0.72, col[1] * 0.7, col[2] * 0.8], vg * vg * 0.5);

        // ---- crescent moon (top-right): cream disc minus offset cut-out ----
        const mx = 0.72, my = 0.22, mr = 0.085;
        const mdist = Math.hypot(x - mx, y - my);
        const cut = Math.hypot(x - (mx + mr * 0.55), y - (my - mr * 0.25));
        if (mdist < mr && cut > mr * 0.92) {
          col = mix(col, CREAM, cover(mdist, mr) * 0.95);
        }
        // twinkles: small plus-shaped stars
        const tw = [[0.2, 0.18], [0.3, 0.32], [0.82, 0.4]];
        for (const [tx, ty] of tw) {
          const td = Math.hypot(x - tx, y - ty);
          const sz = 0.016;
          if ((td < sz * 2.2 && (Math.abs(x - tx) < sz * 0.45 || Math.abs(y - ty) < sz * 0.45)) || td < sz) {
            col = mix(col, CREAM, 0.9);
          }
        }

        // ---- warm lamp dot (left side) ----
        const ld = Math.hypot(x - 0.24, y - 0.42);
        if (ld < 0.028) col = mix(col, GOLD, cover(ld, 0.028));
        else if (ld < 0.06) col = mix(col, GOLD, (1 - (ld - 0.028) / 0.032) * 0.25);

        // ---- ground shadow under bean (skip pixels on the bean itself) ----
        if (!onBean) {
          const sd = Math.hypot((x - 0.5) / 1.6, y - 0.865);
          if (sd < 0.16) col = mix(col, [20, 16, 30], (1 - sd / 0.16) * 0.35);
        }

        // ---- the bean (pixel creature) ----
        if (cxg >= 0 && cxg < G && cyg >= 0 && cyg < G) {
          const ch = BEAN_MASK[cyg][cxg];
          const eh = showEyes ? EYE_MASK[cyg][cxg] : ".";
          if (eh === "#") {
            col = mix(col, INK, 0.95);
          } else if (ch === "#") {
            const tt = cyg / G;
            const bc = mix(LIME, LIME_DK, tt * 0.7);
            col = mix(col, bc, 0.96);
          }
        }

        r = clamp(col[0], 0, 255); g = clamp(col[1], 0, 255); b = clamp(col[2], 0, 255);
        alpha = 255;
      } else {
        // anti-aliased squircle edge
        const d = (e - 1) * rr;
        const c = cover(-d, 0);
        if (c > 0) {
          const t = clamp(y, 0, 1);
          const col = t < 0.55 ? mix(SKY_TOP, SKY_MID, t / 0.55) : mix(SKY_MID, SKY_BOT, (t - 0.55) / 0.45);
          r = col[0]; g = col[1]; b = col[2]; alpha = Math.round(c * 255);
        }
      }
      const di = (Math.floor(py / SS) * size + Math.floor(pxx / SS)) * 4;
      buf[di] = Math.round(r);
      buf[di + 1] = Math.round(g);
      buf[di + 2] = Math.round(b);
      buf[di + 3] = alpha;
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// ICO writer (PNG-compressed entries, Vista+ style)
// ---------------------------------------------------------------------------
function encodeIco(sizes) {
  const images = sizes.map((s) => ({ s, png: encodePng(s, drawIcon(s)) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const dir = Buffer.alloc(images.length * 16);
  images.forEach((im, i) => {
    const o = i * 16;
    dir[o] = im.s >= 256 ? 0 : im.s;
    dir[o + 1] = im.s >= 256 ? 0 : im.s;
    dir.writeUInt16LE(1, o + 2); // planes
    dir.writeUInt16LE(32, o + 4); // bpp
    dir.writeUInt32LE(im.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += im.png.length;
  });
  return Buffer.concat([header, dir, ...images.map((im) => im.png)]);
}

// ---------------------------------------------------------------------------
// emit everything
// ---------------------------------------------------------------------------
const targets = [
  [path.join(OUT_TAURI, "16.png"), 16],
  [path.join(OUT_TAURI, "32.png"), 32],
  [path.join(OUT_TAURI, "48.png"), 48], // tauri-bundler expects 48px on Linux
  [path.join(OUT_TAURI, "64.png"), 64],
  [path.join(OUT_TAURI, "128.png"), 128],
  [path.join(OUT_TAURI, "128x128.png"), 128],
  [path.join(OUT_TAURI, "256.png"), 256],
  [path.join(OUT_TAURI, "512.png"), 512],
  [path.join(OUT_TAURI, "1024.png"), 1024],
  [path.join(OUT_TAURI, "icon.png"), 1024],
  [path.join(OUT_TAURI, "tray-icon.png"), 256],
  [path.join(OUT_PUBLIC, "icon-192.png"), 192],
  [path.join(OUT_PUBLIC, "icon-512.png"), 512],
];
for (const [file, size] of targets) {
  writeFileSync(file, encodePng(size, drawIcon(size)));
  console.log(`wrote ${path.relative(ROOT, file)} (${size}x${size})`);
}
// Multi-res ICO — written to BOTH locations:
//   src-tauri/icons/icon.ico  -> used by tauri-bundler for Nook.exe / MSI / NSIS
//   build/icon.ico            -> legacy location referenced by docs/scripts
const ico = encodeIco([16, 24, 32, 48, 64, 128, 256]);
writeFileSync(path.join(OUT_TAURI, "icon.ico"), ico);
writeFileSync(path.join(OUT_BUILD, "icon.ico"), ico);
console.log("wrote src-tauri/icons/icon.ico + build/icon.ico (16,24,32,48,64,128,256)");
