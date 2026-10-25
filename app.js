"use strict";

(() => {
  const SR = 32000;
  const STORE_KEY = "cadence-player-v1";
  const NOTE_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function hz(name) {
    const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
    if (!m) throw new Error("Unknown note " + name);
    const pc = ((NOTE_PC[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0)) % 12 + 12) % 12;
    const midi = 12 * (Number(m[3]) + 1) + pc;
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function fmt(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const total = Math.floor(sec);
    return Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
  }

  function octaveUp(note) {
    return note.replace(/(\d)$/, (_, d) => String(Math.min(8, Number(d) + 1)));
  }

  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------------- synth toolbox ---------------- */

  const noiseCache = new WeakMap();

  function noiseBuffer(ctx) {
    let buf = noiseCache.get(ctx);
    if (!buf) {
      buf = ctx.createBuffer(1, SR * 2, SR);
      const data = buf.getChannelData(0);
      const rand = rng(0x51f15e);
      for (let i = 0; i < data.length; i++) data[i] = rand() * 2 - 1;
      noiseCache.set(ctx, buf);
    }
    return buf;
  }

  function tone(ctx, bus, note, start, dur, opts = {}) {
    const {
      type = "sine",
      gain = 0.1,
      attack = 0.01,
      release = 0.1,
      cutoff = 0,
      q = 0.7,
      detune = 0,
      sustain = false,
      send = null,
      glide = null,
      vibrato = 0,
    } = opts;
    const toFreq = (v) => (typeof v === "number" ? v : hz(v));
    const f = toFreq(note);
    const end = start + dur + release;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f, start);
    if (glide != null) osc.frequency.exponentialRampToValueAtTime(Math.max(20, toFreq(glide)), start + Math.max(0.04, dur * 0.6));
    osc.detune.value = detune;

    let node = osc;
    if (cutoff) {
      const flt = ctx.createBiquadFilter();
      flt.type = "lowpass";
      flt.frequency.setValueAtTime(cutoff, start);
      flt.Q.value = q;
      node.connect(flt);
      node = flt;
    }

    const g = ctx.createGain();
    const peak = Math.max(gain, 0.0002);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(peak, start + attack);
    if (sustain) g.gain.setValueAtTime(peak, Math.max(start + attack, start + dur - 0.03));
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    node.connect(g);
    g.connect(bus);

    if (send) {
      const sendGain = ctx.createGain();
      sendGain.gain.value = 0.55;
      g.connect(sendGain);
      sendGain.connect(send);
    }

    osc.start(start);
    osc.stop(end + 0.03);

    if (vibrato) {
      const lfo = ctx.createOscillator();
      const amount = ctx.createGain();
      lfo.frequency.value = 5.1;
      amount.gain.value = vibrato;
      lfo.connect(amount);
      amount.connect(osc.detune);
      lfo.start(start);
      lfo.stop(end + 0.03);
    }
    return osc;
  }

  function noiseBed(ctx, bus, start, dur, opts = {}) {
    const { gain = 0.01, type = "lowpass", freq = 1200, q = 0.6 } = opts;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    src.loop = true;
    const flt = ctx.createBiquadFilter();
    flt.type = type;
    flt.frequency.value = freq;
    flt.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(gain, start + Math.min(2, dur * 0.2));
    g.gain.setValueAtTime(gain, start + dur * 0.86);
    g.gain.linearRampToValueAtTime(0.0001, start + dur);
    src.connect(flt);
    flt.connect(g);
    g.connect(bus);
    src.start(start);
    src.stop(start + dur + 0.05);
  }

  function noiseSwell(ctx, bus, start, dur, opts = {}) {
    const { gain = 0.02, freq = 700 } = opts;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    src.loop = true;
    const flt = ctx.createBiquadFilter();
    flt.type = "bandpass";
    flt.frequency.setValueAtTime(freq * 0.6, start);
    flt.frequency.linearRampToValueAtTime(freq * 1.4, start + dur * 0.5);
    flt.frequency.linearRampToValueAtTime(freq * 0.7, start + dur);
    flt.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(gain, start + dur * 0.55);
    g.gain.linearRampToValueAtTime(0.0001, start + dur);
    src.connect(flt);
    flt.connect(g);
    g.connect(bus);
    src.start(start);
    src.stop(start + dur + 0.05);
  }

  function makeDelay(ctx, destination, opts = {}) {
    const { time = 0.3, feedback = 0.3, wet = 0.25, cutoff = 2400 } = opts;
    const input = ctx.createGain();
    const delay = ctx.createDelay(3);
    delay.delayTime.value = time;
    const damp = ctx.createBiquadFilter();
    damp.type = "lowpass";
    damp.frequency.value = cutoff;
    const fb = ctx.createGain();
    fb.gain.value = feedback;
    const wetGain = ctx.createGain();
    wetGain.gain.value = wet;
    input.connect(delay);
    delay.connect(damp);
    damp.connect(fb);
    fb.connect(delay);
    damp.connect(wetGain);
    wetGain.connect(destination);
    return input;
  }

  /*
   * The tracks below are arranged as automation on a handful of long-lived
   * voices instead of one node graph per note. It renders far faster and is
   * how a tracker or hardware sequencer would approach the same parts.
   */

  function freqOf(note) {
    return typeof note === "number" ? note : hz(note);
  }

  function monoSeq(ctx, bus, opts) {
    const {
      events,
      step,
      start = 0,
      type = "triangle",
      gain = 0.04,
      attack = 0.005,
      hold = 0.85,
      cutoff = 0,
      detune = 0,
      send = null,
      q = 0.7,
    } = opts;
    const first = events.findIndex((e) => e != null);
    if (first < 0) return;
    const noteOf = (e) => (e && typeof e === "object" ? e.note : e);
    const levelOf = (e) => (e && typeof e === "object" && e.gain != null ? e.gain : gain);

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.detune.value = detune;
    osc.frequency.setValueAtTime(freqOf(noteOf(events[first])), start + first * step);

    let node = osc;
    if (cutoff) {
      const flt = ctx.createBiquadFilter();
      flt.type = "lowpass";
      flt.frequency.value = cutoff;
      flt.Q.value = q;
      osc.connect(flt);
      node = flt;
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    node.connect(g);
    g.connect(bus);
    if (send) {
      const sendGain = ctx.createGain();
      sendGain.gain.value = 0.5;
      g.connect(sendGain);
      sendGain.connect(send);
    }

    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (event == null) continue;
      const t = start + i * step;
      osc.frequency.setValueAtTime(freqOf(noteOf(event)), t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(levelOf(event), 0.0002), t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + step * hold);
    }

    osc.start(start);
    osc.stop(start + events.length * step + 0.1);
  }

  function chordSeq(ctx, bus, opts) {
    const {
      chords,
      chordDur,
      start = 0,
      type = "sawtooth",
      gain = 0.02,
      attack = 0.3,
      release = 0.5,
      cutoff = 1000,
      send = null,
      detunes = [-5, 5, -3, 3, 0],
    } = opts;
    if (!chords.length) return;
    const voices = Math.max(...chords.map((c) => c.length));
    const end = start + chords.length * chordDur;

    const flt = ctx.createBiquadFilter();
    flt.type = "lowpass";
    flt.frequency.value = cutoff;
    flt.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    flt.connect(g);
    g.connect(bus);
    if (send) {
      const sendGain = ctx.createGain();
      sendGain.gain.value = 0.35;
      g.connect(sendGain);
      sendGain.connect(send);
    }

    const oscs = [];
    for (let v = 0; v < voices; v++) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.detune.value = detunes[v % detunes.length];
      osc.connect(flt);
      osc.start(start);
      osc.stop(end + release + 0.2);
      oscs.push(osc);
    }

    for (let c = 0; c < chords.length; c++) {
      const t = start + c * chordDur;
      const chord = chords[c];
      for (let v = 0; v < voices; v++) {
        oscs[v].frequency.setValueAtTime(freqOf(chord[Math.min(v, chord.length - 1)]), t);
      }
      const atk = Math.min(attack, chordDur * 0.45);
      const relStart = Math.max(t + atk + 0.02, t + chordDur - release);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(gain, 0.0002), t + atk);
      g.gain.setValueAtTime(Math.max(gain, 0.0002), relStart);
      g.gain.exponentialRampToValueAtTime(0.0001, t + chordDur);
    }
    g.gain.setValueAtTime(0.0001, end);
  }

  function noiseSeq(ctx, bus, opts) {
    const {
      hits,
      start = 0,
      end = 32,
      type = "highpass",
      freq = 7500,
      q = 0.7,
      gain = 0.02,
      dur = 0.04,
      attack = 0.002,
      release = 0.02,
    } = opts;
    if (!hits.length) return;

    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    src.loop = true;
    const flt = ctx.createBiquadFilter();
    flt.type = type;
    flt.frequency.value = freq;
    flt.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    src.connect(flt);
    flt.connect(g);
    g.connect(bus);

    for (const hit of hits) {
      const t = start + (typeof hit === "number" ? hit : hit.t);
      const level = typeof hit === "number" ? gain : hit.gain == null ? gain : hit.gain;
      const length = typeof hit === "number" ? dur : hit.dur == null ? dur : hit.dur;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(level, 0.0002), t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + length + release);
    }
    src.start(start);
    src.stop(end + 0.1);
  }

  function kickSeq(ctx, bus, hits, gain = 0.35) {
    if (!hits.length) return;
    const first = typeof hits[0] === "number" ? hits[0] : hits[0].t;
    const last = hits[hits.length - 1];
    const lastTime = typeof last === "number" ? last : last.t;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, 0);
    osc.connect(g);
    g.connect(bus);

    for (const hit of hits) {
      const t = typeof hit === "number" ? hit : hit.t;
      const level = typeof hit === "number" ? gain : hit.gain == null ? gain : hit.gain;
      osc.frequency.setValueAtTime(155, t);
      osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(level, 0.0002), t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.29);
    }
    osc.start(first);
    osc.stop(lastTime + 0.35);
  }

  /* ---------------- compositions ---------------- */

  function renderNeonDrift(ctx, rig) {
    const beat = 60 / 100;
    const bar = beat * 4;
    const bars = 13;
    const prog = [
      ["A2", "C3", "E3", "A3"],
      ["F2", "A2", "C3", "F3"],
      ["C3", "E3", "G3", "C4"],
      ["G2", "B2", "D3", "G3"],
    ];
    const arps = [
      ["A3", "C4", "E4", "A4", "E4", "C4", "E4", "A4"],
      ["F3", "A3", "C4", "F4", "C4", "A3", "C4", "F4"],
      ["C4", "E4", "G4", "C5", "G4", "E4", "G4", "C5"],
      ["G3", "B3", "D4", "G4", "D4", "B3", "D4", "G4"],
    ];
    const roots = ["A2", "F2", "C3", "G2"];
    const echo = makeDelay(ctx, rig.music, { time: beat * 0.75, feedback: 0.32, wet: 0.22, cutoff: 2600 });

    const padChords = [];
    for (let b = 0; b < bars; b++) padChords.push(prog[b % 4]);
    chordSeq(ctx, rig.music, {
      chords: padChords,
      chordDur: bar,
      attack: 0.25,
      release: 0.5,
      gain: 0.019,
      cutoff: 1150,
    });

    const bass = [];
    for (let b = 0; b < bars; b++) {
      const root = roots[b % 4];
      const pattern = [root, null, root, octaveUp(root), root, null, root, octaveUp(root)];
      for (let i = 0; i < 8; i++) {
        if (b < 2) bass.push(null);
        else if (b === 12) bass.push(i === 0 || i === 4 ? root : null);
        else bass.push(pattern[i]);
      }
    }
    monoSeq(ctx, rig.music, {
      events: bass,
      step: beat / 2,
      type: "sawtooth",
      gain: 0.075,
      attack: 0.006,
      hold: 0.8,
      cutoff: 520,
    });

    const arpEvents = [];
    const arpPattern = [0, 1, 2, 3, 2, 1, 2, 3];
    for (let b = 0; b < bars; b++) {
      for (let i = 0; i < 16; i++) {
        if (b < 2) {
          arpEvents.push(null);
        } else {
          const note = arps[b % 4][arpPattern[i % 8]];
          arpEvents.push({ note, gain: i % 4 === 0 ? 0.032 : 0.021 });
        }
      }
    }
    monoSeq(ctx, rig.music, {
      events: arpEvents,
      step: beat / 4,
      type: "triangle",
      gain: 0.024,
      attack: 0.003,
      hold: 0.55,
      cutoff: 3300,
      send: echo,
    });

    const kicks = [];
    const snares = [];
    const hats = [];
    for (let b = 4; b < 12; b++) {
      for (let k = 0; k < 4; k++) kicks.push(b * bar + k * beat);
      for (const k of [1, 3]) snares.push(b * bar + k * beat);
      for (let i = 0; i < 8; i++) hats.push({ t: b * bar + (i * beat) / 2, gain: i % 2 ? 0.012 : 0.02 });
    }
    kicks.push(12 * bar);
    kickSeq(ctx, rig.drums, kicks, 0.38);
    noiseSeq(ctx, rig.drums, {
      hits: snares,
      end: 32,
      type: "bandpass",
      freq: 1900,
      q: 0.9,
      gain: 0.1,
      dur: 0.12,
      release: 0.1,
    });
    noiseSeq(ctx, rig.drums, {
      hits: hats,
      end: 32,
      type: "highpass",
      freq: 7800,
      gain: 0.018,
      dur: 0.035,
      release: 0.02,
    });

    const lead = [
      [8, 0, "E4", 1.5],
      [8, 1.5, "A4", 1],
      [8, 2.5, "C5", 1.2],
      [9, 0, "B4", 1.5],
      [9, 1.5, "G4", 0.8],
      [9, 2.5, "E4", 1],
      [10, 0, "A4", 1.2],
      [10, 1.2, "C5", 0.8],
      [10, 2, "E5", 1.6],
      [11, 0, "D5", 1.5],
      [11, 1.5, "B4", 1],
      [11, 2.5, "G4", 1.2],
    ];
    for (const [b, off, note, len] of lead) {
      tone(ctx, rig.music, note, b * bar + off * beat, len * beat, {
        type: "triangle",
        gain: 0.04,
        cutoff: 3800,
        attack: 0.05,
        release: 0.3,
        sustain: true,
        send: echo,
        vibrato: 5,
      });
    }
  }

  function renderRainyWindow(ctx, rig) {
    const beat = 60 / 76;
    const bar = beat * 4;
    const bars = 11;
    const prog = [
      ["F3", "A3", "C4", "E4"],
      ["E3", "G3", "B3", "D4"],
      ["D3", "F3", "A3", "C4"],
      ["C3", "E3", "G3", "B3"],
    ];
    const roots = ["F2", "E2", "D2", "C2"];
    const echo = makeDelay(ctx, rig.music, { time: beat * 1.5, feedback: 0.26, wet: 0.2, cutoff: 1800 });

    const chordGroups = [];
    for (let b = 0; b < bars; b += 2) chordGroups.push(prog[(b / 2) % 4]);

    chordSeq(ctx, rig.music, {
      chords: chordGroups,
      chordDur: bar * 2,
      attack: 1.3,
      release: 1,
      gain: 0.011,
      cutoff: 800,
    });
    chordSeq(ctx, rig.music, {
      chords: chordGroups,
      chordDur: bar * 2,
      attack: 0.006,
      release: 1.4,
      gain: 0.022,
      cutoff: 1900,
      type: "triangle",
      send: echo,
    });

    noiseBed(ctx, rig.music, 0, 36, { gain: 0.01, freq: 1600 });
    const rand = rng(2024);
    const crackle = [];
    for (let t = 0.5; t < 34; t += 0.25 + rand() * 1.1) {
      crackle.push({ t, gain: 0.005 + rand() * 0.009, dur: 0.006 });
    }
    noiseSeq(ctx, rig.music, {
      hits: crackle,
      end: 36,
      type: "highpass",
      freq: 1500,
      gain: 0.008,
      dur: 0.006,
      release: 0.01,
    });

    const bass = [];
    for (let b = 0; b < bars; b++) {
      const root = roots[Math.floor(b / 2) % 4];
      for (let i = 0; i < 8; i++) bass.push(i === 0 || i === 2 || i === 5 ? root : null);
    }
    monoSeq(ctx, rig.music, {
      events: bass,
      step: beat / 2,
      type: "sine",
      gain: 0.08,
      attack: 0.02,
      hold: 0.9,
    });

    const kicks = [];
    const snares = [];
    const hats = [];
    for (let b = 0; b < 9; b++) {
      kicks.push(b * bar);
      kicks.push(b * bar + beat * 1.75);
      snares.push(b * bar + beat * 2);
      if (b % 4 === 3) snares.push(b * bar + beat * 3.5);
      for (let i = 0; i < 8; i++) {
        hats.push({ t: b * bar + (i * beat) / 2 + (i % 2 ? beat * 0.11 : 0), gain: i % 2 ? 0.01 : 0.016 });
      }
    }
    kickSeq(ctx, rig.drums, kicks, 0.26);
    noiseSeq(ctx, rig.drums, {
      hits: snares,
      end: 36,
      type: "bandpass",
      freq: 1700,
      q: 0.8,
      gain: 0.065,
      dur: 0.11,
      release: 0.1,
    });
    noiseSeq(ctx, rig.drums, {
      hits: hats,
      end: 36,
      type: "highpass",
      freq: 6500,
      gain: 0.014,
      dur: 0.05,
      release: 0.03,
    });

    const melody = [];
    for (let b = 0; b < bars; b++) {
      const top = chordGroups[Math.floor(b / 2) % 4].map(octaveUp);
      for (let i = 0; i < 8; i++) {
        if (i === 0) melody.push(top[1]);
        else if (i === 3) melody.push(top[2]);
        else if (i === 5) melody.push(top[3]);
        else melody.push(null);
      }
    }
    monoSeq(ctx, rig.music, {
      events: melody,
      step: beat / 2,
      type: "sine",
      gain: 0.024,
      attack: 0.05,
      hold: 0.95,
      send: echo,
    });
  }

  const TRACKS = [
    {
      id: "neon-drift",
      title: "Neon Drift",
      artist: "Vela",
      genre: "Synthwave",
      mood: "night drive",
      bpm: 100,
      key: "A minor",
      duration: 32,
      fades: [0.2, 1.6],
      colors: ["#ff7a59", "#7c3aed"],
      description: "Neon-lit arpeggios over a patient four-on-the-floor pulse. Built for late drives and empty motorways.",
      keywords: ["synth", "retro", "night", "drive", "arp", "80s", "neon", "electronic"],
      render: renderNeonDrift,
    },
    {
      id: "rainy-window",
      title: "Rainy Window",
      artist: "Mono Lake",
      genre: "Lo-fi",
      mood: "grey afternoon",
      bpm: 76,
      key: "F major",
      duration: 36,
      fades: [0.8, 2.4],
      colors: ["#8fb8d8", "#35506b"],
      description: "Dusty keys, brushed drums and a permanent hiss of vinyl. A slow loop for grey afternoons indoors.",
      keywords: ["lofi", "rain", "study", "chill", "vinyl", "jazz", "mellow"],
      render: renderRainyWindow,
    },
    {
      id: "deep-field",
      title: "Deep Field",
      artist: "North Signal",
      genre: "Ambient",
      mood: "deep space",
      bpm: 56,
      key: "D minor",
      duration: 40,
      level: 0.62,
      fades: [5, 3.5],
      colors: ["#4fd1c5", "#1e3a5f"],
      description: "Chord clouds drifting at half speed, with bells that ring out into a long, dark reverb. No drums, no hurry.",
      keywords: ["ambient", "space", "drone", "calm", "meditation", "focus", "bells"],
      render: renderDeepField,
    },
    {
      id: "pixel-sunrise",
      title: "Pixel Sunrise",
      artist: "Glass Hours",
      genre: "Chiptune",
      mood: "morning arcade",
      bpm: 124,
      key: "C major",
      duration: 32,
      fades: [0.15, 1.4],
      colors: ["#ffd166", "#ef476f"],
      description: "A twelve-bit dawn chorus: square leads, fast arpeggios, and a drum machine that never misses a step.",
      keywords: ["chip", "8bit", "arcade", "game", "bright", "square", "retro"],
      render: renderPixelSunrise,
    },
    {
      id: "midnight-transit",
      title: "Midnight Transit",
      artist: "Vela",
      genre: "Downtempo",
      mood: "last train",
      bpm: 92,
      key: "D minor",
      duration: 36,
      fades: [1.2, 2.2],
      colors: ["#b49bff", "#2b2a5e"],
      description: "Sub bass, half-time drums and plucked echoes for the last train home. The city goes by in soft focus.",
      keywords: ["downtempo", "night", "bass", "chill", "train", "pluck", "electronic"],
      render: renderMidnightTransit,
    },
  ];

  function renderDeepField(ctx, rig) {
    const chords = [
      ["D3", "F3", "A3", "D4", "A4"],
      ["Bb2", "D3", "F3", "Bb3", "F4"],
      ["F3", "A3", "C4", "F4", "C5"],
      ["C3", "E3", "G3", "C4", "G4"],
      ["D3", "F3", "A3", "D4", "A4"],
    ];
    const echo = makeDelay(ctx, rig.music, { time: 3.2, feedback: 0.48, wet: 0.5, cutoff: 1500 });

    chordSeq(ctx, rig.music, { chords, chordDur: 8, attack: 3, release: 2.5, gain: 0.026, cutoff: 700 });
    chordSeq(ctx, rig.music, {
      chords,
      chordDur: 8,
      attack: 4,
      release: 2.5,
      gain: 0.008,
      cutoff: 2800,
      type: "triangle",
      detunes: [0, 4, -4, 2, 0],
    });

    tone(ctx, rig.music, "D2", 0, 37, { type: "sine", gain: 0.05, attack: 4, release: 2, sustain: true });
    tone(ctx, rig.music, "A2", 0, 37, { type: "sine", gain: 0.018, attack: 5, release: 2, sustain: true });
    noiseBed(ctx, rig.music, 0, 40, { gain: 0.006, freq: 450 });

    const bells = ["D5", "F4", "A4", "C5", "G4", "D4", "A4", "F4", "C5", "E4"];
    for (let i = 0; i < 13; i++) {
      const t = 6 + i * 2.6;
      if (t > 38) break;
      const note = bells[i % bells.length];
      tone(ctx, rig.music, note, t, 2.2, { type: "sine", gain: 0.04, attack: 0.01, release: 3, send: echo });
      tone(ctx, rig.music, note, t, 1, {
        type: "sine",
        gain: 0.012,
        attack: 0.01,
        release: 2,
        detune: 11,
        send: echo,
      });
    }

    for (const t of [5, 16, 27, 35]) noiseSwell(ctx, rig.music, t, 8, { gain: 0.015, freq: 750 });
  }

  function renderPixelSunrise(ctx, rig) {
    const beat = 60 / 124;
    const bar = beat * 4;
    const bars = 16;
    const prog = [
      ["C4", "E4", "G4"],
      ["G3", "B3", "D4"],
      ["A3", "C4", "E4"],
      ["F3", "A3", "C4"],
    ];
    const roots = ["C2", "G1", "A1", "F1"];
    const arps = [
      ["C4", "E4", "G4", "C5"],
      ["G3", "B3", "D4", "G4"],
      ["A3", "C4", "E4", "A4"],
      ["F3", "A3", "C4", "F4"],
    ];
    const melody = [
      ["C5", "E5", "G5", "E5", "C5", "G4", "A4", "B4"],
      ["B4", "D5", "G5", "D5", "B4", "G4", "A4", "B4"],
      ["A4", "C5", "E5", "C5", "A4", "E4", "G4", "A4"],
      ["F4", "A4", "C5", "A4", "F4", "C4", "D4", "E4"],
    ];
    const echo = makeDelay(ctx, rig.music, { time: beat * 0.75, feedback: 0.3, wet: 0.2, cutoff: 3500 });

    const chords = [];
    for (let b = 0; b < bars; b++) chords.push(prog[b % 4]);
    chordSeq(ctx, rig.music, {
      chords,
      chordDur: bar,
      attack: 0.05,
      release: 0.15,
      gain: 0.012,
      cutoff: 1900,
      type: "triangle",
    });

    const bass = [];
    for (let b = 0; b < bars; b++) {
      const breakdown = b >= 12 && b <= 13;
      for (let i = 0; i < 8; i++) {
        if (breakdown) bass.push(null);
        else bass.push(i % 4 === 3 ? octaveUp(roots[b % 4]) : roots[b % 4]);
      }
    }
    monoSeq(ctx, rig.music, {
      events: bass,
      step: beat / 2,
      type: "square",
      gain: 0.032,
      attack: 0.004,
      hold: 0.7,
      cutoff: 900,
    });

    const arpEvents = [];
    for (let b = 0; b < bars; b++) {
      for (let i = 0; i < 16; i++) {
        arpEvents.push({ note: arps[b % 4][i % 4], gain: b === 12 || b === 13 ? 0.02 : 0.014 });
      }
    }
    monoSeq(ctx, rig.music, {
      events: arpEvents,
      step: beat / 4,
      type: "triangle",
      gain: 0.016,
      attack: 0.003,
      hold: 0.5,
      cutoff: 5200,
      send: echo,
    });

    const leadEvents = [];
    for (let b = 0; b < bars; b++) {
      for (let i = 0; i < 8; i++) {
        const inLead = (b >= 2 && b <= 11) || b >= 14;
        leadEvents.push(inLead ? { note: melody[b % 4][i], gain: 0.026 } : null);
      }
    }
    monoSeq(ctx, rig.music, {
      events: leadEvents,
      step: beat / 2,
      type: "square",
      gain: 0.026,
      attack: 0.005,
      hold: 0.55,
      cutoff: 4600,
      send: echo,
    });

    const sparkle = ["C6", "E6", "G6", "E6"];
    const sparkEvents = [];
    for (let b = 0; b < bars; b++) {
      for (let i = 0; i < 8; i++) {
        sparkEvents.push(b === 12 || b === 13 ? { note: sparkle[i % 4], gain: 0.012 } : null);
      }
    }
    monoSeq(ctx, rig.music, {
      events: sparkEvents,
      step: beat / 2,
      type: "triangle",
      gain: 0.012,
      attack: 0.003,
      hold: 0.6,
      cutoff: 6000,
      send: echo,
    });

    const kicks = [];
    const snares = [];
    const hats = [];
    for (let b = 0; b < bars; b++) {
      if (!((b >= 2 && b <= 11) || b >= 14)) continue;
      for (let k = 0; k < 4; k++) kicks.push(b * bar + k * beat);
      snares.push(b * bar + beat);
      snares.push(b * bar + beat * 3);
      for (let i = 0; i < 8; i++) hats.push({ t: b * bar + (i * beat) / 2, gain: 0.016 });
    }
    kickSeq(ctx, rig.drums, kicks, 0.28);
    noiseSeq(ctx, rig.drums, {
      hits: snares,
      end: 32,
      type: "bandpass",
      freq: 2100,
      q: 0.8,
      gain: 0.075,
      dur: 0.09,
      release: 0.08,
    });
    noiseSeq(ctx, rig.drums, {
      hits: hats,
      end: 32,
      type: "highpass",
      freq: 8200,
      gain: 0.014,
      dur: 0.03,
      release: 0.02,
    });
  }

  function renderMidnightTransit(ctx, rig) {
    const beat = 60 / 92;
    const bar = beat * 4;
    const bars = 13;
    const prog = [
      ["D3", "F3", "A3", "C4"],
      ["Bb2", "D3", "F3", "A3"],
      ["F2", "A2", "C3", "E3"],
      ["C3", "E3", "G3", "B3"],
    ];
    const roots = ["D2", "Bb1", "F2", "C2"];
    const arps = [
      ["D4", "F4", "A4", "C5"],
      ["Bb3", "D4", "F4", "A4"],
      ["F3", "A3", "C4", "E4"],
      ["C4", "E4", "G4", "B4"],
    ];
    const echo = makeDelay(ctx, rig.music, { time: beat * 1.5, feedback: 0.36, wet: 0.28, cutoff: 2000 });

    const chords = [];
    for (let b = 0; b < bars; b++) chords.push(prog[Math.floor(b / 2) % 4]);
    chordSeq(ctx, rig.music, {
      chords,
      chordDur: bar,
      attack: 0.6,
      release: 0.45,
      gain: 0.016,
      cutoff: 760,
    });

    const bass = [];
    for (let b = 0; b < bars; b++) {
      const root = roots[Math.floor(b / 2) % 4];
      for (let i = 0; i < 8; i++) {
        if (i === 0 || i === 5) bass.push(root);
        else if (i === 3) bass.push(octaveUp(root));
        else bass.push(null);
      }
    }
    monoSeq(ctx, rig.music, {
      events: bass,
      step: beat / 2,
      type: "sine",
      gain: 0.09,
      attack: 0.02,
      hold: 0.95,
    });

    const arpEvents = [];
    for (let b = 0; b < bars; b++) {
      for (let i = 0; i < 8; i++) {
        arpEvents.push({
          note: arps[Math.floor(b / 2) % 4][i % 4],
          gain: i % 4 === 0 ? 0.022 : 0.014,
        });
      }
    }
    monoSeq(ctx, rig.music, {
      events: arpEvents,
      step: beat / 2,
      type: "triangle",
      gain: 0.018,
      attack: 0.004,
      hold: 0.5,
      cutoff: 2800,
      send: echo,
    });

    const kicks = [];
    const snares = [];
    const hats = [];
    for (let b = 2; b < 12; b++) {
      kicks.push(b * bar);
      kicks.push(b * bar + beat * 2.5);
      snares.push(b * bar + beat * 2);
      for (let i = 0; i < 8; i++) {
        hats.push({ t: b * bar + (i * beat) / 2 + (i % 2 ? beat * 0.09 : 0), gain: i % 2 ? 0.01 : 0.017 });
      }
    }
    kickSeq(ctx, rig.drums, kicks, 0.26);
    noiseSeq(ctx, rig.drums, {
      hits: snares,
      end: 36,
      type: "bandpass",
      freq: 1800,
      q: 0.8,
      gain: 0.08,
      dur: 0.1,
      release: 0.09,
    });
    noiseSeq(ctx, rig.drums, {
      hits: hats,
      end: 36,
      type: "highpass",
      freq: 7000,
      gain: 0.014,
      dur: 0.04,
      release: 0.02,
    });

    const lead = [
      [5, 0, "A4", 2],
      [5, 2, "C5", 2],
      [7, 0, "F4", 2.5],
      [7, 2.5, "A4", 1.5],
      [9, 0, "D5", 2],
      [9, 2, "C5", 1.5],
      [11, 0, "Bb4", 1.5],
      [11, 2, "A4", 1.5],
    ];
    for (const [b, off, note, len] of lead) {
      tone(ctx, rig.music, note, b * bar + off * beat, len * beat, {
        type: "sine",
        gain: 0.032,
        attack: 0.2,
        release: 0.7,
        sustain: true,
        send: echo,
        vibrato: 6,
      });
    }
  }

  /* ---------------- offline rendering ---------------- */

  const bufferCache = new Map();
  const renderTimes = new Map();

  function normalize(buffer, target) {
    const data = buffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
    if (peak < 0.02) throw new Error("The render came out silent");
    const scale = target / peak;
    for (let i = 0; i < data.length; i++) data[i] *= scale;
  }

  function applyFades(buffer, inSec, outSec) {
    const data = buffer.getChannelData(0);
    const n = data.length;
    const fin = Math.min(n, Math.floor(inSec * SR));
    const fout = Math.min(n, Math.floor(outSec * SR));
    for (let i = 0; i < fin; i++) data[i] *= i / fin;
    for (let i = 0; i < fout; i++) data[n - 1 - i] *= i / fout;
  }

  async function renderTrack(track) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC) throw new Error("Web Audio is unavailable in this browser");
    const ctx = new OAC(1, Math.ceil(SR * track.duration), SR);
    const master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
    const music = ctx.createGain();
    music.gain.value = 0.9;
    music.connect(master);
    const drums = ctx.createGain();
    drums.gain.value = 0.85;
    drums.connect(master);

    track.render(ctx, { music, drums });
    const buffer = await ctx.startRendering();
    normalize(buffer, 0.85);
    if (track.level) {
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] *= track.level;
    }
    applyFades(buffer, track.fades[0], track.fades[1]);
    return buffer;
  }

  function statsOf(buffer) {
    const data = buffer.getChannelData(0);
    let peak = 0;
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sum += v * v;
    }
    return {
      duration: Number(buffer.duration.toFixed(3)),
      peak: Number(peak.toFixed(4)),
      rms: Number(Math.sqrt(sum / data.length).toFixed(4)),
      samples: data.length,
    };
  }

  function cacheGet(id) {
    if (!bufferCache.has(id)) return null;
    const buf = bufferCache.get(id);
    bufferCache.delete(id);
    bufferCache.set(id, buf);
    return buf;
  }

  function cacheSet(id, buf) {
    bufferCache.delete(id);
    bufferCache.set(id, buf);
    while (bufferCache.size > 3) {
      const oldest = bufferCache.keys().next().value;
      bufferCache.delete(oldest);
    }
  }

  async function getBuffer(track) {
    const cached = cacheGet(track.id);
    if (cached) return cached;
    const started = performance.now();
    const buffer = await renderTrack(track);
    renderTimes.set(track.id, Number(((performance.now() - started) / 1000).toFixed(2)));
    cacheSet(track.id, buffer);
    return buffer;
  }

  const $ = (id) => document.getElementById(id);

  const els = {
    deck: document.querySelector(".deck"),
    cover: $("cover"),
    labelInitial: $("label-initial"),
    coverGenre: $("cover-genre"),
    coverIndex: $("cover-index"),
    eyebrowText: $("eyebrow-text"),
    title: $("track-title"),
    artist: $("track-artist"),
    chipGenre: $("chip-genre"),
    chipBpm: $("chip-bpm"),
    chipKey: $("chip-key"),
    chipLength: $("chip-length"),
    description: $("track-description"),
    likeCurrent: $("like-current"),
    viz: $("viz"),
    timeCurrent: $("time-current"),
    timeTotal: $("time-total"),
    seek: $("seek"),
    shuffle: $("shuffle"),
    prev: $("prev"),
    play: $("play"),
    next: $("next"),
    repeat: $("repeat"),
    mute: $("mute"),
    muteGroup: document.querySelector(".volume-group"),
    volume: $("volume"),
    status: $("status"),
    search: $("search"),
    chips: $("chips"),
    libraryCount: $("library-count"),
    libraryEmpty: $("library-empty"),
    tracklist: $("tracklist"),
    queue: $("queue"),
    queueSkip: $("queue-skip"),
    queueHint: $("queue-hint"),
  };

  const vizCtx = els.viz.getContext("2d");

  const state = {
    currentId: TRACKS[0].id,
    playing: false,
    loading: false,
    seeking: false,
    offset: 0,
    shuffle: false,
    repeat: "off",
    volume: 0.78,
    muted: false,
    filter: "all",
    query: "",
    favorites: [],
    order: TRACKS.map((t) => t.id),
  };

  let audioCtx = null;
  let analyser = null;
  let masterGain = null;
  let freqData = null;
  let currentSource = null;
  let sourceStartedAt = 0;
  let loadToken = 0;
  let lastNonZeroVolume = 0.78;
  let lastStatus = "";
  let rafId = 0;
  const artworkCache = new Map();

  const getTrack = (id) => TRACKS.find((t) => t.id === id) || TRACKS[0];
  const currentTrack = () => getTrack(state.currentId);

  function currentDuration() {
    const buf = bufferCache.get(state.currentId);
    return buf ? buf.duration : currentTrack().duration;
  }

  function elapsed() {
    if (!state.playing || !audioCtx || !currentSource) return state.offset;
    return clamp(state.offset + (audioCtx.currentTime - sourceStartedAt), 0, currentDuration());
  }

  function setStatus(text) {
    if (text === lastStatus) return;
    lastStatus = text;
    els.status.textContent = text;
  }

  /* ---------------- audio graph ---------------- */

  function gainValue() {
    return state.muted ? 0 : Math.pow(state.volume, 1.5) * 0.9;
  }

  function ensureAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error("Web Audio is unavailable in this browser");
    if (!audioCtx) {
      audioCtx = new AC();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.82;
      masterGain = audioCtx.createGain();
      masterGain.gain.value = gainValue();
      analyser.connect(masterGain);
      masterGain.connect(audioCtx.destination);
      freqData = new Uint8Array(analyser.frequencyBinCount);
    }
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  function applyGain() {
    if (!audioCtx || !masterGain) return;
    const now = audioCtx.currentTime;
    masterGain.gain.cancelScheduledValues(now);
    masterGain.gain.setTargetAtTime(gainValue(), now, 0.03);
  }

  function stopSource() {
    if (!currentSource) return;
    const src = currentSource;
    currentSource = null;
    src.onended = null;
    try { src.stop(); } catch {}
    try { src.disconnect(); } catch {}
  }

  function startSource(buffer, offset) {
    ensureAudio();
    stopSource();
    const at = clamp(offset, 0, Math.max(0, buffer.duration - 0.06));
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(analyser);
    src.start(0, at);
    currentSource = src;
    sourceStartedAt = audioCtx.currentTime;
    state.offset = at;
    state.playing = true;
    state.loading = false;
    src.onended = () => {
      if (src === currentSource) handleEnded();
    };
    renderState();
    updateTimeline(true);
    updatePositionState();
    setMediaPlayback(true);
    startLoop();
    setStatus(`Playing ${currentTrack().title} · synthesised in your browser.`);
  }

  async function playCurrent(offset) {
    ensureAudio();
    const track = currentTrack();
    const token = ++loadToken;
    stopSource();
    state.playing = false;
    state.loading = true;
    state.offset = clamp(offset == null ? state.offset : offset, 0, Math.max(0, currentDuration() - 0.06));
    renderState();
    setStatus(`Composing ${track.title} with the Web Audio API…`);
    await new Promise((resolve) => setTimeout(resolve, 40));
    try {
      const buffer = await getBuffer(track);
      if (token !== loadToken) return;
      ensureAudio();
      if (audioCtx.state === "suspended") await audioCtx.resume();
      startSource(buffer, clamp(state.offset, 0, buffer.duration - 0.06));
    } catch (err) {
      if (token !== loadToken) return;
      state.loading = false;
      state.playing = false;
      renderState();
      drawViz();
      setStatus("Could not generate audio: " + err.message);
      console.error(err);
    }
  }

  function pausePlayback() {
    if (state.loading) {
      loadToken++;
      state.loading = false;
      state.playing = false;
      renderState();
      setStatus("Composition cancelled.");
      return;
    }
    if (!state.playing) return;
    state.offset = elapsed();
    stopSource();
    state.playing = false;
    renderState();
    updateTimeline(true);
    cancelAnimationFrame(rafId);
    rafId = 0;
    drawViz();
    setMediaPlayback(false);
    updatePositionState();
    setStatus(`Paused at ${fmt(state.offset)}.`);
  }

  function togglePlay() {
    if (state.loading) {
      pausePlayback();
      return;
    }
    if (state.playing) {
      pausePlayback();
      return;
    }
    try {
      ensureAudio();
    } catch (err) {
      setStatus(err.message);
      return;
    }
    const buf = cacheGet(state.currentId);
    if (buf) {
      startSource(buf, state.offset >= buf.duration - 0.25 ? 0 : state.offset);
    } else {
      playCurrent(state.offset);
    }
  }

  function selectTrack(id, autoplay = true) {
    const track = getTrack(id);
    if (!track || !TRACKS.some((t) => t.id === id)) return;
    if (id === state.currentId) {
      if (autoplay) togglePlay();
      return;
    }
    loadToken++;
    stopSource();
    state.playing = false;
    state.loading = false;
    state.currentId = id;
    state.offset = 0;
    persist();
    renderAll();
    drawViz();
    if (autoplay) {
      playCurrent(0);
    } else {
      setStatus(`Selected ${track.title}. Press play to synthesise it.`);
    }
  }

  function rebuildOrder() {
    const ids = TRACKS.map((t) => t.id);
    if (!state.shuffle) {
      state.order = ids;
      return;
    }
    const rest = ids.filter((id) => id !== state.currentId);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    state.order = [state.currentId, ...rest];
  }

  function neighbor(dir) {
    if (state.order.length < 2) return null;
    const i = state.order.indexOf(state.currentId);
    let j = i + dir;
    if (j >= state.order.length) {
      if (state.repeat === "all") j = 0;
      else return null;
    }
    if (j < 0) {
      if (state.repeat === "all") j = state.order.length - 1;
      else return null;
    }
    return state.order[j];
  }

  function nextTrack() {
    const next = neighbor(1);
    if (next) {
      selectTrack(next, true);
    } else {
      setStatus("End of queue. Repeat is off.");
    }
  }

  function prevTrack() {
    if (!state.playing && state.offset > 3) {
      seekTo(0);
      return;
    }
    if (state.playing && elapsed() > 3) {
      seekTo(0);
      return;
    }
    const prev = neighbor(-1);
    if (prev) selectTrack(prev, true);
    else seekTo(0);
  }

  function handleEnded() {
    if (!state.playing) return;
    currentSource = null;
    state.playing = false;
    const finished = currentTrack();
    if (state.repeat === "one") {
      const buf = cacheGet(finished.id);
      if (buf) {
        startSource(buf, 0);
        return;
      }
    }
    const next = neighbor(1);
    if (next) {
      selectTrack(next, true);
      return;
    }
    state.offset = 0;
    renderState();
    updateTimeline(true);
    drawViz();
    setMediaPlayback(false);
    updatePositionState();
    setStatus("Queue finished. Repeat is off.");
  }

  function seekTo(sec) {
    const dur = currentDuration();
    const target = clamp(sec, 0, Math.max(0, dur - 0.06));
    state.offset = target;
    if (state.playing) {
      const buf = cacheGet(state.currentId);
      if (buf) {
        startSource(buf, target);
        return;
      }
      state.playing = false;
      playCurrent(target);
      return;
    }
    updateTimeline(true);
    updatePositionState();
  }

  function setVolume(value) {
    state.volume = clamp(value, 0, 1);
    if (state.volume > 0) {
      lastNonZeroVolume = state.volume;
      state.muted = false;
    } else {
      state.muted = true;
    }
    applyGain();
    renderVolume();
    persist();
  }

  function toggleMute() {
    state.muted = !state.muted;
    if (!state.muted && state.volume === 0) state.volume = lastNonZeroVolume || 0.6;
    applyGain();
    renderVolume();
    persist();
    setStatus(state.muted ? "Muted." : `Volume ${Math.round(state.volume * 100)}%.`);
  }

  function toggleShuffle() {
    state.shuffle = !state.shuffle;
    rebuildOrder();
    persist();
    renderTransport();
    renderQueue();
    setStatus(state.shuffle ? "Shuffle on. The queue has been reshuffled." : "Shuffle off. Restored track order.");
  }

  function cycleRepeat() {
    state.repeat = state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off";
    persist();
    renderTransport();
    renderQueue();
    setStatus({ off: "Repeat off.", all: "Repeat all.", one: "Repeat one." }[state.repeat]);
  }

  function toggleLiked(id) {
    const at = state.favorites.indexOf(id);
    if (at >= 0) state.favorites.splice(at, 1);
    else state.favorites.push(id);
    persist();
    renderMeta();
    renderLibrary();
    const track = getTrack(id);
    setStatus(state.favorites.includes(id) ? `Liked ${track.title}.` : `Removed ${track.title} from liked tracks.`);
  }

  /* ---------------- persistence ---------------- */

  function persist() {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          currentId: state.currentId,
          volume: state.volume,
          muted: state.muted,
          shuffle: state.shuffle,
          repeat: state.repeat,
          favorites: state.favorites,
        })
      );
    } catch {}
  }

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (Array.isArray(data.favorites)) {
        state.favorites = data.favorites.filter((id) => TRACKS.some((t) => t.id === id));
      }
      if (typeof data.volume === "number" && Number.isFinite(data.volume)) state.volume = clamp(data.volume, 0, 1);
      if (typeof data.muted === "boolean") state.muted = data.muted;
      if (typeof data.shuffle === "boolean") state.shuffle = data.shuffle;
      if (["off", "all", "one"].includes(data.repeat)) state.repeat = data.repeat;
      if (TRACKS.some((t) => t.id === data.currentId)) state.currentId = data.currentId;
    } catch {}
    if (state.volume > 0) lastNonZeroVolume = state.volume;
    if (state.volume === 0) state.muted = true;
  }

  /* ---------------- visualiser ---------------- */

  function drawViz() {
    const width = els.viz.clientWidth || 600;
    const height = els.viz.clientHeight || 118;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pw = Math.max(1, Math.round(width * dpr));
    const ph = Math.max(1, Math.round(height * dpr));
    if (els.viz.width !== pw || els.viz.height !== ph) {
      els.viz.width = pw;
      els.viz.height = ph;
    }
    const g = vizCtx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);

    g.fillStyle = "rgba(255, 255, 255, 0.05)";
    g.fillRect(12, height - 12, Math.max(0, width - 24), 1);

    if (!analyser || !state.playing) {
      g.strokeStyle = "rgba(255, 255, 255, 0.13)";
      g.setLineDash([2, 7]);
      g.beginPath();
      g.moveTo(12, height / 2);
      g.lineTo(width - 12, height / 2);
      g.stroke();
      g.setLineDash([]);
      return;
    }

    analyser.getByteFrequencyData(freqData);
    const count = Math.max(20, Math.min(90, Math.floor(width / 8)));
    const gap = width < 480 ? 2 : 3;
    const barW = Math.max(2, (width - 24 - gap * (count - 1)) / count);
    const maxH = height * 0.78;
    const grad = g.createLinearGradient(0, height, 0, height - maxH);
    grad.addColorStop(0, "rgba(255, 122, 89, 0.95)");
    grad.addColorStop(0.55, "rgba(255, 122, 89, 0.72)");
    grad.addColorStop(1, "rgba(167, 139, 250, 0.9)");
    g.fillStyle = grad;

    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0 : i / (count - 1);
      const bin = Math.min(freqData.length - 1, Math.floor(Math.pow(t, 1.7) * freqData.length * 0.62));
      const v = freqData[bin] / 255;
      const h = 2 + Math.pow(v, 1.45) * maxH;
      const x = 12 + i * (barW + gap);
      const y = height - 12 - h;
      const r = Math.min(barW / 2, 3);
      g.beginPath();
      if (typeof g.roundRect === "function") g.roundRect(x, y, barW, h, r);
      else g.rect(x, y, barW, h);
      g.fill();
    }
  }

  function startLoop() {
    if (!rafId) rafId = requestAnimationFrame(tickLoop);
  }

  function tickLoop() {
    rafId = 0;
    updateTimeline();
    drawViz();
    if (state.playing) rafId = requestAnimationFrame(tickLoop);
  }

  /* ---------------- media session ---------------- */

  function artworkFor(track) {
    if (artworkCache.has(track.id)) return artworkCache.get(track.id);
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const g = canvas.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 512, 512);
    grad.addColorStop(0, track.colors[0]);
    grad.addColorStop(1, track.colors[1]);
    g.fillStyle = grad;
    g.fillRect(0, 0, 512, 512);
    g.fillStyle = "rgba(10, 8, 14, 0.84)";
    g.beginPath();
    g.arc(256, 256, 192, 0, Math.PI * 2);
    g.fill();
    for (let r = 178; r > 70; r -= 14) {
      g.beginPath();
      g.strokeStyle = "rgba(255, 255, 255, 0.055)";
      g.lineWidth = 2;
      g.arc(256, 256, r, 0, Math.PI * 2);
      g.stroke();
    }
    g.fillStyle = track.colors[0];
    g.beginPath();
    g.arc(256, 256, 64, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "rgba(20, 13, 24, 0.82)";
    g.font = "600 64px Georgia, serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(track.title[0], 256, 258);
    const url = canvas.toDataURL("image/png");
    artworkCache.set(track.id, url);
    return url;
  }

  function updateMediaMetadata() {
    if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
    const track = currentTrack();
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: "Cadence · generative sessions",
        artwork: [{ src: artworkFor(track), sizes: "512x512", type: "image/png" }],
      });
    } catch {}
  }

  function setMediaPlayback(playing) {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.playbackState = playing ? "playing" : "paused";
    } catch {}
  }

  function updatePositionState() {
    if (!("mediaSession" in navigator) || typeof navigator.mediaSession.setPositionState !== "function") return;
    const duration = currentDuration();
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: 1,
        position: clamp(elapsed(), 0, Math.max(0, duration - 0.01)),
      });
    } catch {}
  }

  function setupMediaSession() {
    if (!("mediaSession" in navigator)) return;
    updateMediaMetadata();
    const set = (action, handler) => {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch {}
    };
    set("play", () => { if (!state.playing && !state.loading) togglePlay(); });
    set("pause", () => pausePlayback());
    set("previoustrack", () => prevTrack());
    set("nexttrack", () => nextTrack());
    set("seekbackward", (details) => seekTo(elapsed() - ((details && details.seekOffset) || 10)));
    set("seekforward", (details) => seekTo(elapsed() + ((details && details.seekOffset) || 10)));
    set("seekto", (details) => {
      if (details && typeof details.seekTime === "number") seekTo(details.seekTime);
    });
  }

  /* ---------------- renderers ---------------- */

  function renderMeta() {
    const track = currentTrack();
    const index = TRACKS.indexOf(track) + 1;
    els.cover.style.setProperty("--c1", track.colors[0]);
    els.cover.style.setProperty("--c2", track.colors[1]);
    els.labelInitial.textContent = track.title[0];
    els.coverGenre.textContent = track.genre;
    els.coverIndex.textContent = String(index).padStart(2, "0") + " / " + String(TRACKS.length).padStart(2, "0");
    els.title.textContent = track.title;
    els.artist.textContent = track.artist;
    els.chipGenre.textContent = track.genre;
    els.chipBpm.textContent = track.bpm + " BPM";
    els.chipKey.textContent = track.key;
    els.chipLength.textContent = fmt(track.duration);
    els.description.textContent = track.description;

    const liked = state.favorites.includes(track.id);
    els.likeCurrent.classList.toggle("is-liked", liked);
    els.likeCurrent.setAttribute("aria-pressed", String(liked));
    els.likeCurrent.setAttribute("aria-label", liked ? `Remove ${track.title} from liked tracks` : `Like ${track.title}`);
    els.likeCurrent.title = liked ? "Remove from liked" : "Like this track";
    els.viz.setAttribute(
      "aria-label",
      `Live frequency visualiser for ${track.title}. The audio is generated in your browser.`
    );
    document.title = "Cadence — " + track.title;
    updateMediaMetadata();
  }

  function renderState() {
    const track = currentTrack();
    els.deck.classList.toggle("is-playing", state.playing);
    els.deck.classList.toggle("is-loading", state.loading);
    els.deck.classList.toggle("has-audio", state.playing || state.offset > 0 || bufferCache.has(track.id));

    let label;
    if (state.loading) label = "Composing track · " + track.genre;
    else if (state.playing) label = "Now playing · " + track.genre;
    else if (state.offset > 0.5) label = "Paused · " + track.genre;
    else label = "Ready · " + track.genre;
    els.eyebrowText.textContent = label;

    els.play.setAttribute("aria-label", state.loading ? "Cancel composition" : state.playing ? "Pause" : "Play");
    els.play.title = state.loading ? "Cancel · composing audio" : state.playing ? "Pause (Space)" : "Play (Space)";

    const row = els.tracklist.querySelector(`.track[data-id="${state.currentId}"] .track-main`);
    if (row) row.setAttribute("aria-label", (state.playing ? "Pause " : "Play ") + track.title + " by " + track.artist);
    els.tracklist.querySelectorAll(".track.is-current").forEach((li) => {
      li.classList.toggle("is-paused", !state.playing);
    });
  }

  function renderVolume() {
    const pct = Math.round(state.volume * 100);
    els.volume.value = String(pct);
    els.volume.style.setProperty("--fill", pct + "%");
    els.muteGroup.classList.toggle("is-muted", state.muted || state.volume === 0);
    els.mute.setAttribute("aria-pressed", String(state.muted));
    els.mute.setAttribute("aria-label", state.muted ? "Unmute" : "Mute");
    els.mute.title = state.muted ? "Unmute (M)" : "Mute (M)";
  }

  function renderTransport() {
    els.shuffle.setAttribute("aria-pressed", String(state.shuffle));
    els.repeat.setAttribute("aria-pressed", String(state.repeat !== "off"));
    els.repeat.dataset.mode = state.repeat;
    const labels = { off: "Repeat off", all: "Repeat all", one: "Repeat one" };
    els.repeat.setAttribute("aria-label", labels[state.repeat]);
    els.repeat.title = labels[state.repeat] + " (R)";
    renderVolume();
  }

  function matchingTracks() {
    const q = state.query.toLowerCase();
    return TRACKS.filter((track) => {
      if (state.filter === "liked" && !state.favorites.includes(track.id)) return false;
      if (state.filter !== "all" && state.filter !== "liked" && track.genre !== state.filter) return false;
      if (!q) return true;
      const haystack = [track.title, track.artist, track.genre, track.mood, track.description, ...track.keywords]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }

  function renderLibrary() {
    const list = matchingTracks();
    els.chips.querySelectorAll(".chip").forEach((chip) => {
      const on = chip.dataset.filter === state.filter;
      chip.classList.toggle("is-on", on);
      chip.setAttribute("aria-pressed", String(on));
    });
    const filtered = state.filter !== "all" || state.query;
    els.libraryCount.textContent = filtered ? `${list.length} of ${TRACKS.length}` : `${TRACKS.length} tracks`;
    els.libraryEmpty.hidden = list.length > 0;

    const active = document.activeElement;
    const restore =
      active && els.tracklist.contains(active)
        ? { id: active.dataset.id || (active.closest(".track") && active.closest(".track").dataset.id), action: active.dataset.action }
        : null;

    els.tracklist.innerHTML = list
      .map((track) => {
        const index = TRACKS.indexOf(track) + 1;
        const isCurrent = track.id === state.currentId;
        const liked = state.favorites.includes(track.id);
        const action = isCurrent && state.playing ? "Pause" : "Play";
        return `<li class="track${isCurrent ? " is-current" : ""}${isCurrent && !state.playing ? " is-paused" : ""}" data-id="${track.id}">
          <button class="track-main" type="button" data-action="play" data-id="${track.id}" aria-label="${action} ${track.title} by ${track.artist}"${isCurrent ? ' aria-current="true"' : ""}>
            <span class="track-num"><span class="num">${String(index).padStart(2, "0")}</span><span class="eq" aria-hidden="true"><span></span><span></span><span></span></span></span>
            <span class="track-text"><span class="track-title">${track.title}</span><span class="track-sub">${track.artist} · ${track.genre}</span></span>
            <span class="track-time">${fmt(track.duration)}</span>
          </button>
          <button class="heart${liked ? " is-liked" : ""}" type="button" data-action="like" data-id="${track.id}" aria-pressed="${liked}" aria-label="${liked ? "Remove" : "Add"} ${track.title} ${liked ? "from" : "to"} liked tracks" title="${liked ? "Unlike" : "Like"} ${track.title}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.4 4.6 13a4.9 4.9 0 0 1 0-6.9 4.9 4.9 0 0 1 6.9 0l.5.5.5-.5a4.9 4.9 0 0 1 6.9 0 4.9 4.9 0 0 1 0 6.9Z"/></svg>
          </button>
        </li>`;
      })
      .join("");

    if (restore && restore.id) {
      const next = els.tracklist.querySelector(
        `.track[data-id="${restore.id}"] [data-action="${restore.action || "play"}"]`
      );
      if (next) next.focus({ preventScroll: true });
    }
    renderState();
  }

  function upcomingTracks(count = 3) {
    const out = [];
    const len = state.order.length;
    if (!len) return out;
    let i = state.order.indexOf(state.currentId);
    for (let k = 1; k <= count; k++) {
      let j = i + k;
      if (j >= len) {
        if (state.repeat === "all") j %= len;
        else break;
      }
      out.push(getTrack(state.order[j]));
    }
    return out;
  }

  function renderQueue() {
    const upcoming = upcomingTracks();
    els.queue.innerHTML = upcoming.length
      ? upcoming
          .map(
            (track, n) =>
              `<li><span class="q-num">${String(n + 1).padStart(2, "0")}</span><span class="q-title"><b>${track.title}</b> · ${track.artist}</span><span class="q-time">${fmt(track.duration)}</span></li>`
          )
          .join("")
      : '<li class="q-empty">Nothing queued — repeat is off.</li>';
    els.queueSkip.disabled = upcoming.length === 0;
    els.queueHint.textContent = `${state.shuffle ? "Shuffle on" : "Shuffle off"} · repeat ${state.repeat}`;
  }

  function updateTimeline() {
    const duration = Math.max(0.1, currentDuration());
    const position = clamp(state.playing ? elapsed() : state.offset, 0, duration);
    if (!state.seeking) {
      const value = Math.round((position / duration) * 1000);
      els.seek.value = String(value);
      els.seek.style.setProperty("--fill", ((position / duration) * 100).toFixed(2) + "%");
    }
    els.timeCurrent.textContent = fmt(position);
    els.timeTotal.textContent = fmt(duration);
    els.seek.setAttribute("aria-valuetext", `${fmt(position)} of ${fmt(duration)}`);
  }

  function renderAll() {
    renderMeta();
    renderTransport();
    renderLibrary();
    renderQueue();
    updateTimeline();
    drawViz();
  }

  /* ---------------- events ---------------- */

  function buildChips() {
    const genres = [...new Set(TRACKS.map((t) => t.genre))];
    for (const genre of genres) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.dataset.filter = genre;
      chip.textContent = genre;
      chip.setAttribute("aria-pressed", "false");
      els.chips.appendChild(chip);
    }
  }

  function wire() {
    els.play.addEventListener("click", togglePlay);
    els.prev.addEventListener("click", prevTrack);
    els.next.addEventListener("click", nextTrack);
    els.shuffle.addEventListener("click", toggleShuffle);
    els.repeat.addEventListener("click", cycleRepeat);
    els.mute.addEventListener("click", toggleMute);
    els.likeCurrent.addEventListener("click", () => toggleLiked(state.currentId));
    els.queueSkip.addEventListener("click", nextTrack);

    els.volume.addEventListener("input", () => setVolume(Number(els.volume.value) / 100));

    els.seek.addEventListener("pointerdown", () => {
      state.seeking = true;
    });
    els.seek.addEventListener("input", () => {
      const duration = currentDuration();
      const position = (Number(els.seek.value) / 1000) * duration;
      els.timeCurrent.textContent = fmt(position);
      els.seek.style.setProperty("--fill", Number(els.seek.value) / 10 + "%");
    });
    els.seek.addEventListener("change", () => {
      const duration = currentDuration();
      state.seeking = false;
      seekTo((Number(els.seek.value) / 1000) * duration);
    });
    els.seek.addEventListener("pointerup", () => {
      if (!state.seeking) return;
      window.setTimeout(() => {
        if (!state.seeking) return;
        state.seeking = false;
        seekTo((Number(els.seek.value) / 1000) * currentDuration());
      }, 220);
    });

    els.search.addEventListener("input", () => {
      state.query = els.search.value.trim();
      renderLibrary();
    });

    els.chips.addEventListener("click", (event) => {
      const chip = event.target.closest(".chip");
      if (!chip) return;
      state.filter = chip.dataset.filter;
      renderLibrary();
    });

    els.tracklist.addEventListener("click", (event) => {
      const heart = event.target.closest(".heart");
      if (heart) {
        toggleLiked(heart.dataset.id);
        return;
      }
      const main = event.target.closest(".track-main");
      if (!main) return;
      if (main.dataset.id === state.currentId) togglePlay();
      else selectTrack(main.dataset.id, true);
    });

    document.addEventListener("keydown", onKey);
    if (window.ResizeObserver) new ResizeObserver(drawViz).observe(els.viz);
    else window.addEventListener("resize", drawViz);
  }

  function onKey(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    const typing =
      target instanceof HTMLElement && (target.matches("input, textarea, select") || target.isContentEditable);

    if (typing) {
      if (event.key === "Escape" && target === els.search) {
        if (els.search.value) {
          els.search.value = "";
          state.query = "";
          renderLibrary();
        } else {
          els.search.blur();
        }
      }
      return;
    }

    if (event.key === "/") {
      event.preventDefault();
      els.search.focus();
      els.search.select();
      return;
    }
    if (target instanceof HTMLElement && target.closest("button") && (event.code === "Space" || event.key === "Enter")) {
      return;
    }

    switch (event.code) {
      case "Space":
        event.preventDefault();
        togglePlay();
        break;
      case "ArrowRight":
        event.preventDefault();
        seekTo(elapsed() + 5);
        break;
      case "ArrowLeft":
        event.preventDefault();
        seekTo(elapsed() - 5);
        break;
      case "ArrowUp":
        event.preventDefault();
        setVolume(state.volume + 0.05);
        break;
      case "ArrowDown":
        event.preventDefault();
        setVolume(state.volume - 0.05);
        break;
      case "KeyN":
        nextTrack();
        break;
      case "KeyP":
        prevTrack();
        break;
      case "KeyS":
        toggleShuffle();
        break;
      case "KeyR":
        cycleRepeat();
        break;
      case "KeyM":
        toggleMute();
        break;
      default:
        break;
    }
  }

  /* ---------------- boot ---------------- */

  window.__cadence = {
    version: "1.0.0",
    tracks: TRACKS.map((t) => ({
      id: t.id,
      title: t.title,
      artist: t.artist,
      genre: t.genre,
      duration: t.duration,
      bpm: t.bpm,
      key: t.key,
    })),
    state: () => ({
      ...state,
      favorites: [...state.favorites],
      order: [...state.order],
      elapsed: elapsed(),
      duration: currentDuration(),
      buffers: [...bufferCache.keys()],
    }),
    play: () => {
      if (!state.playing && !state.loading) togglePlay();
    },
    pause: () => pausePlayback(),
    select: (id, autoplay = true) => selectTrack(id, autoplay !== false),
    next: () => nextTrack(),
    prev: () => prevTrack(),
    seek: (sec) => seekTo(Number(sec)),
    render: async (id) => statsOf(await getBuffer(getTrack(id))),
    stats: () => Object.fromEntries([...bufferCache].map(([id, buf]) => [id, statsOf(buf)])),
    renderTimes: () => Object.fromEntries(renderTimes),
    clearCache: () => bufferCache.clear(),
  };

  function init() {
    loadPrefs();
    rebuildOrder();
    buildChips();
    wire();
    els.seek.disabled = false;
    renderAll();
    setupMediaSession();
    setMediaPlayback(false);
    updatePositionState();
    setStatus("5 original tracks. Nothing is downloaded.");
    drawViz();
  }

  init();
})();
