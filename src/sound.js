// ==================================================================
// Nook sound engine — v0.15
// Everything is synthesized live with the Web Audio API: layered
// oscillators, shaped noise, gentle filters and real envelopes, so
// the effects feel warm and physical instead of beepy and cheap.
// Nothing here can ever break the app — every path is guarded.
// ==================================================================

let ctx = null;          // lazily created AudioContext
let master = null;       // sfx master chain: gain -> compressor -> out
let musicBus = null;     // music master chain: gain -> compressor -> out
let unlocked = false;

export const soundState = {
  fxOn: true,
  musicOn: true,
  fxVolume: 0.9,
  musicVolume: 0.55
};

function ac() {
  if (ctx) return ctx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();

    // ---- sfx chain ----
    master = ctx.createGain();
    master.gain.value = soundState.fxVolume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 22;
    comp.ratio.value = 5;
    comp.attack.value = 0.004;
    comp.release.value = 0.24;
    master.connect(comp).connect(ctx.destination);

    // ---- music chain ----
    musicBus = ctx.createGain();
    musicBus.gain.value = 0;
    const mcomp = ctx.createDynamicsCompressor();
    mcomp.threshold.value = -22;
    mcomp.knee.value = 26;
    mcomp.ratio.value = 4;
    mcomp.attack.value = 0.01;
    mcomp.release.value = 0.4;
    musicBus.connect(mcomp).connect(ctx.destination);
  } catch { return null; }
  return ctx;
}

// Browsers (and WebView2) only let audio start after the user touches
// the page — unlock on the first pointer/key event, then we're free.
export function unlockAudio() {
  if (unlocked) return;
  const c = ac();
  if (!c) return;
  const go = () => {
    try {
      if (c.state === 'suspended') c.resume();
      unlocked = true;
      window.removeEventListener('pointerdown', go);
      window.removeEventListener('keydown', go);
      if (soundState.musicOn) startMusic();
    } catch { /* never break the app for audio */ }
  };
  window.addEventListener('pointerdown', go, { once: false });
  window.addEventListener('keydown', go, { once: false });
}

function ready() {
  if (!soundState.fxOn) return false;
  const c = ac();
  if (!c) return false;
  if (c.state === 'suspended') { try { c.resume(); } catch { return false; } }
  return true;
}

// ---------- tiny building blocks ----------

function env(g, t0, a, peak, d, sustain = 0) {
  // exponential-ish attack/decay envelope on a GainNode
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + a);
  if (sustain > 0) {
    g.gain.exponentialRampToValueAtTime(Math.max(sustain, 0.0001), t0 + a + d);
  } else {
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
  }
}

// soft band-passed noise burst — the "breath" inside every physical sound
function noiseBurst(t0, dur, { f = 1200, q = 1.2, type = 'bandpass', gain = 0.2, a = 0.004, sweepTo = null } = {}) {
  const c = ctx;
  const len = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const flt = c.createBiquadFilter();
  flt.type = type; flt.frequency.setValueAtTime(f, t0); flt.Q.value = q;
  if (sweepTo) flt.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur);
  const g = c.createGain();
  env(g, t0, a, gain, dur - a);
  src.connect(flt).connect(g).connect(master);
  src.start(t0); src.stop(t0 + dur + 0.02);
}

// a struck-bar tone (marimba / kalimba family): sine + soft octave harmonic
function bar(t0, freq, { dur = 0.5, gain = 0.2, a = 0.004, harm = 0.24, dest = null } = {}) {
  const c = ctx;
  const o = c.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(freq, t0);
  const o2 = c.createOscillator(); o2.type = 'sine';
  o2.frequency.setValueAtTime(freq * 2.01, t0);
  const g = c.createGain();
  const g2 = c.createGain();
  env(g, t0, a, gain, dur);
  env(g2, t0, a * 0.7, gain * harm, dur * 0.55);
  o.connect(g); o2.connect(g2);
  g.connect(dest || master); g2.connect(dest || master);
  o.start(t0); o.stop(t0 + dur + 0.05);
  o2.start(t0); o2.stop(t0 + dur + 0.05);
}

// warm pad voice — two slightly detuned triangles through a lowpass
function padVoice(t0, freq, dur, { gain = 0.05, dest = null, cutoff = 1100 } = {}) {
  const c = ctx;
  const o1 = c.createOscillator(); o1.type = 'triangle';
  o1.frequency.setValueAtTime(freq * 0.9995, t0);
  const o2 = c.createOscillator(); o2.type = 'sine';
  o2.frequency.setValueAtTime(freq * 1.0018, t0);
  const flt = c.createBiquadFilter();
  flt.type = 'lowpass'; flt.frequency.setValueAtTime(cutoff, t0); flt.Q.value = 0.4;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + dur * 0.3);
  g.gain.setValueAtTime(gain, t0 + dur * 0.62);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o1.connect(flt); o2.connect(flt); flt.connect(g).connect(dest || master);
  o1.start(t0); o2.start(t0);
  o1.stop(t0 + dur + 0.05); o2.stop(t0 + dur + 0.05);
}

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

// ---------- the effects ----------

const FX = {
  // soft interface tick — a tiny wooden tap
  tap() {
    const t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(950, t);
    o.frequency.exponentialRampToValueAtTime(420, t + 0.045);
    const g = ctx.createGain();
    env(g, t, 0.0015, 0.10, 0.05);
    o.connect(g).connect(master);
    o.start(t); o.stop(t + 0.09);
    noiseBurst(t, 0.03, { f: 2600, q: 0.8, gain: 0.05 });
  },

  // switch flipping on / off
  toggleOn() {
    const t = ctx.currentTime;
    bar(t, midi(83), { dur: 0.14, gain: 0.09 });
    bar(t + 0.055, midi(88), { dur: 0.2, gain: 0.11 });
  },
  toggleOff() {
    const t = ctx.currentTime;
    bar(t, midi(88), { dur: 0.13, gain: 0.08 });
    bar(t + 0.05, midi(81), { dur: 0.2, gain: 0.10 });
  },

  // something appeared — a note, a task, a card
  pop() {
    const t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(520, t);
    o.frequency.exponentialRampToValueAtTime(210, t + 0.09);
    const g = ctx.createGain();
    env(g, t, 0.002, 0.22, 0.11);
    o.connect(g).connect(master);
    o.start(t); o.stop(t + 0.16);
    noiseBurst(t, 0.02, { f: 1800, q: 1, gain: 0.06 });
  },

  // message whooshing out of the composer
  send() {
    const t = ctx.currentTime;
    noiseBurst(t, 0.22, { f: 500, sweepTo: 2400, q: 2.2, gain: 0.10, a: 0.02 });
    bar(t + 0.10, midi(84), { dur: 0.3, gain: 0.10 });
    bar(t + 0.16, midi(91), { dur: 0.34, gain: 0.07 });
  },

  // the reply arrived — warm two-note chime
  reply() {
    const t = ctx.currentTime;
    bar(t, midi(76), { dur: 0.42, gain: 0.11 });
    bar(t + 0.12, midi(83), { dur: 0.6, gain: 0.10, harm: 0.3 });
    bar(t + 0.24, midi(88), { dur: 0.7, gain: 0.07, harm: 0.2 });
  },

  // a little win — task done, onboarding finished (soft kalimba arp)
  success() {
    const t = ctx.currentTime;
    const notes = [72, 76, 79, 84];
    notes.forEach((n, i) => {
      bar(t + i * 0.075, midi(n), { dur: 0.5, gain: 0.12, harm: 0.26 });
    });
    noiseBurst(t + 0.28, 0.35, { f: 5200, q: 0.6, type: 'highpass', gain: 0.018, a: 0.02 });
  },

  // something moved to the trash — soft felt thud
  trash() {
    const t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(170, t);
    o.frequency.exponentialRampToValueAtTime(78, t + 0.16);
    const g = ctx.createGain();
    env(g, t, 0.002, 0.26, 0.2);
    o.connect(g).connect(master);
    o.start(t); o.stop(t + 0.28);
    noiseBurst(t, 0.07, { f: 700, q: 0.9, gain: 0.05 });
  },

  // view changed — barely-there air tick
  nav() {
    const t = ctx.currentTime;
    noiseBurst(t, 0.05, { f: 3200, q: 1.4, gain: 0.035, a: 0.002 });
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(1250, t);
    o.frequency.exponentialRampToValueAtTime(880, t + 0.04);
    const g = ctx.createGain();
    env(g, t, 0.001, 0.045, 0.045);
    o.connect(g).connect(master);
    o.start(t); o.stop(t + 0.08);
  },

  // reminder bell — soft struck bell, never shrill
  bell() {
    const t = ctx.currentTime;
    const carrier = ctx.createOscillator(); carrier.type = 'sine';
    carrier.frequency.setValueAtTime(midi(86), t);
    const mod = ctx.createOscillator(); mod.type = 'sine';
    mod.frequency.setValueAtTime(midi(86) * 1.41, t);
    const modG = ctx.createGain();
    modG.gain.setValueAtTime(140, t);
    modG.gain.exponentialRampToValueAtTime(1, t + 0.9);
    mod.connect(modG).connect(carrier.frequency);
    const g = ctx.createGain();
    env(g, t, 0.003, 0.14, 1.1);
    carrier.connect(g).connect(master);
    carrier.start(t); mod.start(t);
    carrier.stop(t + 1.25); mod.stop(t + 1.25);
    bar(t + 0.45, midi(86), { dur: 0.5, gain: 0.05, harm: 0.15 });
  },

  // recorder arms / stops — camera-shutter clicks
  shutter() {
    const t = ctx.currentTime;
    noiseBurst(t, 0.025, { f: 3400, q: 2, gain: 0.16 });
    const o = ctx.createOscillator(); o.type = 'square';
    o.frequency.setValueAtTime(1250, t + 0.06);
    const g = ctx.createGain();
    env(g, t + 0.06, 0.001, 0.07, 0.05);
    o.connect(g).connect(master);
    o.start(t + 0.06); o.stop(t + 0.14);
    bar(t + 0.06, midi(93), { dur: 0.12, gain: 0.05 });
  },
  shutterStop() {
    const t = ctx.currentTime;
    noiseBurst(t, 0.025, { f: 2800, q: 2, gain: 0.14 });
    bar(t + 0.07, midi(81), { dur: 0.16, gain: 0.08 });
    bar(t + 0.13, midi(76), { dur: 0.22, gain: 0.06 });
  },

  // gentle "no" — two soft low blips, nothing harsh
  error() {
    const t = ctx.currentTime;
    [0, 0.14].forEach((dt) => {
      const o = ctx.createOscillator(); o.type = 'triangle';
      o.frequency.setValueAtTime(196, t + dt);
      const g = ctx.createGain();
      env(g, t + dt, 0.004, 0.09, 0.1);
      o.connect(g).connect(master);
      o.start(t + dt); o.stop(t + dt + 0.15);
    });
  },

  // app is up — warm rising pad with a little sunrise chime
  launch() {
    const t = ctx.currentTime;
    padVoice(t, midi(53), 1.7, { gain: 0.05 });
    padVoice(t + 0.08, midi(60), 1.6, { gain: 0.045 });
    padVoice(t + 0.16, midi(65), 1.5, { gain: 0.04 });
    bar(t + 0.55, midi(72), { dur: 0.7, gain: 0.08, harm: 0.2 });
    bar(t + 0.7, midi(79), { dur: 0.9, gain: 0.06, harm: 0.18 });
  }
};

// play one of the named effects — safe everywhere
export function sfx(name) {
  try {
    if (!ready()) return;
    const fn = FX[name];
    if (fn) fn();
  } catch { /* audio must never crash the app */ }
}

// ==================================================================
// AMBIENT MUSIC — generative cozy lofi loop, synthesized live.
// A slow F-lydian-ish chord cycle with soft pads, a lazy pentatonic
// pluck melody and a deep round bass. Never repeats exactly, so it
// never gets on your nerves — and it never leaves this PC.
// ==================================================================

const CHORDS = [
  { root: 41, notes: [53, 57, 60, 64] },   // Fmaj7
  { root: 45, notes: [57, 60, 64, 67] },   // Am7
  { root: 38, notes: [50, 53, 57, 60] },   // Dm7
  { root: 43, notes: [55, 58, 62, 65] }    // Gm7 -> pulls home
];
const PENTA = [65, 67, 69, 72, 74, 77, 79, 81, 84]; // F pentatonic pool

const music = {
  on: false,
  timer: null,
  nextTime: 0,
  step: 0,
  delay: null,
  delayGain: null
};

function musicDelay() {
  if (music.delay) return;
  const c = ctx;
  music.delay = c.createDelay(1.5);
  music.delay.delayTime.value = 0.42;
  music.delayGain = c.createGain();
  music.delayGain.gain.value = 0.32;
  const wet = c.createGain();
  wet.gain.value = 0.5;
  const damp = c.createBiquadFilter();
  damp.type = 'lowpass'; damp.frequency.value = 2200;
  music.delay.connect(music.delayGain).connect(music.delay);
  music.delay.connect(damp).connect(wet).connect(musicBus);
}

function scheduleBar(t, chord) {
  // pad voices
  chord.notes.forEach((n, i) => {
    padVoice(t + i * 0.06, midi(n + 12), 7.6, {
      gain: 0.028, dest: musicBus, cutoff: 950
    });
  });
  // deep soft bass
  const b = ctx.createOscillator(); b.type = 'sine';
  b.frequency.setValueAtTime(midi(chord.root), t);
  const bg = ctx.createGain();
  bg.gain.setValueAtTime(0.0001, t);
  bg.gain.linearRampToValueAtTime(0.09, t + 0.9);
  bg.gain.setValueAtTime(0.09, t + 6.4);
  bg.gain.exponentialRampToValueAtTime(0.0001, t + 7.8);
  b.connect(bg).connect(musicBus);
  b.start(t); b.stop(t + 8);

  // lazy plucks on the delay
  musicDelay();
  const beats = [0.9, 2.1, 3.4, 4.6, 5.9];
  beats.forEach((bt) => {
    if (Math.random() < 0.55) {
      const n = PENTA[Math.floor(Math.random() * PENTA.length)] + 12;
      const when = t + bt + (Math.random() < 0.3 ? 0.18 : 0);
      bar(when, midi(n), { dur: 1.4, gain: 0.05, harm: 0.12, dest: music.delay });
    }
  });
}

function musicScheduler() {
  try {
    const ahead = ctx.currentTime + 1.2;
    while (music.nextTime < ahead) {
      const chord = CHORDS[music.step % CHORDS.length];
      scheduleBar(Math.max(music.nextTime, ctx.currentTime + 0.05), chord);
      music.step++;
      music.nextTime += 8; // each chord breathes for 8 seconds
    }
  } catch { /* keep quiet */ }
}

export function startMusic() {
  try {
    if (!soundState.musicOn || music.on) return;
    const c = ac();
    if (!c) return;
    if (c.state === 'suspended') { c.resume(); }
    music.on = true;
    musicBus.gain.cancelScheduledValues(c.currentTime);
    musicBus.gain.setValueAtTime(Math.max(musicBus.gain.value, 0.0001), c.currentTime);
    musicBus.gain.linearRampToValueAtTime(soundState.musicVolume, c.currentTime + 2.2);
    music.nextTime = c.currentTime + 0.15;
    music.step = Math.floor(Math.random() * 4); // start somewhere different each time
    musicScheduler();
    music.timer = setInterval(musicScheduler, 900);
  } catch { music.on = false; }
}

export function stopMusic() {
  try {
    if (!music.on) return;
    music.on = false;
    if (music.timer) { clearInterval(music.timer); music.timer = null; }
    if (ctx && musicBus) {
      musicBus.gain.cancelScheduledValues(ctx.currentTime);
      musicBus.gain.setValueAtTime(musicBus.gain.value, ctx.currentTime);
      musicBus.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 1.4);
    }
  } catch { /* ignore */ }
}

export function applySoundSettings() {
  try {
    if (master) master.gain.value = soundState.fxOn ? soundState.fxVolume : 0;
    if (soundState.musicOn && unlocked) startMusic();
    else if (!soundState.musicOn) stopMusic();
  } catch { /* ignore */ }
}
