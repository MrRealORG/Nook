// Tiny Web Audio synth engine: all sound effects are procedurally generated.
// No external audio files needed. Respects a global mute flag.

export type SfxName =
  | "click"
  | "open"
  | "close"
  | "coin"
  | "eat"
  | "level"
  | "happy"
  | "sad"
  | "catch"
  | "star"
  | "hit"
  | "gameover"
  | "win"
  | "shoot"
  | "bounce"
  | "flip"
  | "match"
  | "pop"
  | "tick"
  | "send"
  | "receive"
  | "buy"
  | "sell"
  | "error"
  | "achieve"
  | "zoom"
  | "equip"
  | "start"
  | "move"
  | "evolve"
  | "unlock"
  | "trash"
  | "shield";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;
let volume = 0.5;

export function initAudio() {
  if (ctx) return;
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);
  } catch {
    ctx = null;
  }
}

export function setMuted(v: boolean) {
  muted = v;
}
export function isMuted() {
  return muted;
}
export function setVolume(v: number) {
  volume = Math.max(0, Math.min(1, v));
  if (master) master.gain.value = volume;
}
export function getVolume() {
  return volume;
}

/** Resume audio context on first user gesture (browser autoplay policy). */
export function unlockAudio() {
  initAudio();
  if (ctx && ctx.state === "suspended") void ctx.resume();
}

type Wave = OscillatorType;

function tone(freq: number, dur: number, opts: { type?: Wave; vol?: number; delay?: number; slide?: number; attack?: number } = {}) {
  if (!ctx || !master || muted) return;
  const { type = "square", vol = 0.16, delay = 0, slide, attack = 0.004 } = opts;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(Math.max(20, freq), t0);
  if (slide !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slide), t0 + dur);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(vol, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noise(dur: number, opts: { vol?: number; delay?: number; freq?: number; q?: number } = {}) {
  if (!ctx || !master || muted) return;
  const { vol = 0.14, delay = 0, freq = 1200, q = 1 } = opts;
  const t0 = ctx.currentTime + delay;
  const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = freq;
  filter.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
  src.connect(filter).connect(g).connect(master);
  src.start(t0);
}

const RECIPES: Record<SfxName, () => void> = {
  click: () => tone(660, 0.06, { type: "square", vol: 0.09 }),
  open: () => {
    tone(420, 0.07, { type: "triangle", vol: 0.1 });
    tone(640, 0.08, { type: "triangle", vol: 0.1, delay: 0.05 });
  },
  close: () => {
    tone(640, 0.06, { type: "triangle", vol: 0.09 });
    tone(420, 0.08, { type: "triangle", vol: 0.09, delay: 0.04 });
  },
  coin: () => {
    tone(988, 0.07, { type: "square", vol: 0.12 });
    tone(1319, 0.18, { type: "square", vol: 0.12, delay: 0.06 });
  },
  eat: () => {
    tone(300, 0.07, { type: "triangle", vol: 0.13, slide: 180 });
    tone(260, 0.07, { type: "triangle", vol: 0.13, delay: 0.09, slide: 150 });
    tone(320, 0.06, { type: "triangle", vol: 0.12, delay: 0.18, slide: 200 });
  },
  level: () => {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.14, { type: "square", vol: 0.13, delay: i * 0.09 }));
    tone(1319, 0.3, { type: "triangle", vol: 0.12, delay: 0.38 });
  },
  happy: () => {
    tone(700, 0.08, { type: "triangle", vol: 0.11 });
    tone(940, 0.1, { type: "triangle", vol: 0.11, delay: 0.07 });
  },
  sad: () => {
    tone(360, 0.16, { type: "sine", vol: 0.13, slide: 200 });
  },
  catch: () => tone(880, 0.06, { type: "square", vol: 0.11, slide: 1200 }),
  star: () => {
    tone(1047, 0.07, { type: "square", vol: 0.11 });
    tone(1568, 0.12, { type: "square", vol: 0.1, delay: 0.06 });
  },
  hit: () => {
    tone(200, 0.18, { type: "sawtooth", vol: 0.16, slide: 70 });
    noise(0.1, { vol: 0.1, freq: 500 });
  },
  gameover: () => {
    [523, 466, 415, 349].forEach((f, i) => tone(f, 0.2, { type: "square", vol: 0.12, delay: i * 0.14 }));
  },
  win: () => {
    [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.13, { type: "square", vol: 0.12, delay: i * 0.1 }));
  },
  shoot: () => tone(900, 0.09, { type: "sawtooth", vol: 0.08, slide: 300 }),
  bounce: () => tone(500, 0.05, { type: "square", vol: 0.1, slide: 700 }),
  flip: () => tone(520, 0.05, { type: "triangle", vol: 0.09, slide: 760 }),
  match: () => {
    tone(784, 0.08, { type: "triangle", vol: 0.11 });
    tone(1175, 0.12, { type: "triangle", vol: 0.1, delay: 0.07 });
  },
  pop: () => tone(620, 0.05, { type: "sine", vol: 0.12, slide: 900 }),
  tick: () => tone(880, 0.03, { type: "square", vol: 0.05 }),
  send: () => tone(700, 0.06, { type: "triangle", vol: 0.1, slide: 1000 }),
  receive: () => tone(900, 0.06, { type: "triangle", vol: 0.1, slide: 640 }),
  buy: () => {
    tone(784, 0.08, { type: "square", vol: 0.11 });
    tone(1047, 0.08, { type: "square", vol: 0.11, delay: 0.08 });
    tone(1319, 0.16, { type: "square", vol: 0.1, delay: 0.16 });
  },
  sell: () => {
    tone(1319, 0.07, { type: "square", vol: 0.11 });
    tone(784, 0.14, { type: "square", vol: 0.1, delay: 0.07 });
  },
  error: () => tone(160, 0.22, { type: "sawtooth", vol: 0.13, slide: 90 }),
  achieve: () => {
    [659, 784, 988, 1319, 1568].forEach((f, i) => tone(f, 0.12, { type: "triangle", vol: 0.12, delay: i * 0.08 }));
  },
  zoom: () => tone(440, 0.08, { type: "sine", vol: 0.07, slide: 560 }),
  equip: () => {
    tone(523, 0.06, { type: "square", vol: 0.1 });
    tone(880, 0.1, { type: "square", vol: 0.1, delay: 0.05 });
  },
  start: () => {
    tone(392, 0.1, { type: "square", vol: 0.11 });
    tone(523, 0.1, { type: "square", vol: 0.11, delay: 0.1 });
    tone(659, 0.16, { type: "square", vol: 0.12, delay: 0.2 });
  },
  move: () => tone(340, 0.035, { type: "triangle", vol: 0.05 }),
  evolve: () => {
    [392, 494, 587, 784, 988, 1175].forEach((f, i) => tone(f, 0.15, { type: "square", vol: 0.11, delay: i * 0.1 }));
    tone(1568, 0.5, { type: "triangle", vol: 0.12, delay: 0.62 });
    tone(2093, 0.6, { type: "sine", vol: 0.09, delay: 0.72 });
  },
  unlock: () => {
    tone(523, 0.07, { type: "square", vol: 0.09 });
    tone(784, 0.1, { type: "square", vol: 0.09, delay: 0.08 });
    tone(1047, 0.16, { type: "triangle", vol: 0.11, delay: 0.17 });
  },
  trash: () => {
    tone(220, 0.08, { type: "square", vol: 0.08, slide: 110 });
    tone(140, 0.14, { type: "sawtooth", vol: 0.07, delay: 0.07, slide: 60 });
  },
  shield: () => {
    tone(196, 0.1, { type: "square", vol: 0.1 });
    tone(262, 0.18, { type: "square", vol: 0.1, delay: 0.09 });
    tone(330, 0.22, { type: "triangle", vol: 0.09, delay: 0.2 });
  },
};

export function sfx(name: SfxName) {
  if (muted) return;
  try {
    unlockAudio();
    RECIPES[name]?.();
  } catch {}
}

/** Tiny ambient music loop generator — soft arpeggio pads. Returns stop fn. */
export function startMusic(): () => void {
  unlockAudio();
  if (!ctx || !master) return () => {};
  let stopped = false;
  const scale = [262, 294, 330, 392, 440, 523, 587, 659];
  let step = 0;
  const iv = window.setInterval(() => {
    if (stopped || muted || document.hidden) return;
    const base = scale[(step * 3) % scale.length];
    const fifth = scale[(step * 3 + 4) % scale.length];
    tone(base, 0.5, { type: "sine", vol: 0.028 });
    tone(fifth, 0.5, { type: "sine", vol: 0.02, delay: 0.22 });
    if (step % 4 === 0) tone(base / 2, 0.7, { type: "sine", vol: 0.03 });
    step++;
  }, 620);
  return () => {
    stopped = true;
    window.clearInterval(iv);
  };
}
