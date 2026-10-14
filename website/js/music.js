/*!
 * Pixel Pro AI - generative keynote score
 * Pixel Pro AI is created by Neelaksh Naithani (NeelOutLoud Website Builders, India).
 *
 * Everything you hear is synthesized live with the Web Audio API: no audio files,
 * no samples, no network. 112 BPM, D major, an 8-bar phrase of
 * Dmaj9 -> Bm11 -> Gmaj9 -> A6sus4 (2 bars each). Layers enter by "intensity":
 *   0.00  pad (detuned saws, lowpass, wide) + a sparse FM bell
 *   0.20  sub bass on the off-beat 8ths + a soft filtered saw
 *   0.40  kick (half-time until 0.55, then four-on-the-floor) + off-beat closed hats
 *   0.55  sidechain pump on pad and bass, keyed to the kick
 *   0.65  claps on 2 and 4, 16th ghost hats, soft air at phrase starts
 *   0.80  16th pluck arpeggio through a dotted-8th ping-pong delay, hat-roll fills
 *   0.90  a sparse high FM lead motif every 4 bars
 *
 * Public API (single global):
 *   PixelMusic.start()            -> AudioContext|null   (call inside a user gesture)
 *   PixelMusic.stop()
 *   PixelMusic.setIntensity(0..1)
 *   PixelMusic.setDuck(bool)
 *   PixelMusic.setVolume(0..1)    default 0.55
 *   PixelMusic.swell()            -> seconds until the impact (0 when not running)
 *   PixelMusic.useFile(url)       '' returns to the generator
 *   PixelMusic.level()            -> 0..1 smoothed output loudness
 *   PixelMusic.isPlaying          getter
 *   PixelMusic.renderOffline(seconds, intensityOrFn[, opts]) -> Promise<AudioBuffer>
 *       opts: { volume, swellAt (s), startAt (s) } and test-only { noDrums, solo: ['pad',...], raw }
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.PixelMusic) return;
  var W = window;
  var AC = W.AudioContext || W.webkitAudioContext;
  var OAC = W.OfflineAudioContext || W.webkitOfflineAudioContext;

  /* ------------------------------------------------------------------ constants */
  var BPM = 112;
  var BEAT = 60 / BPM;              // 0.5357 s
  var STEP = BEAT / 4;              // one 16th note
  var LOOKAHEAD = 0.15;             // seconds scheduled ahead of the audio clock
  var TICK_MS = 25;                 // scheduler wake-up
  var INTENSITY_TC = 0.6;           // smoothing time-constant for setIntensity
  var DUCK_GAIN = Math.pow(10, -11 / 20);
  var DEFAULT_VOLUME = 0.55;
  var MAX_VOICES = 30;              // one-shot voices alive at once (low priority voices yield first)
  var REDUCED = false;
  try { REDUCED = !!(W.matchMedia && W.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) {}

  /* Harmony. pad: 5-voice voicings (D3..A4) that move by small steps;
     root: sub-bass MIDI; arp/bell: chord tones for the plucks and bells. */
  var CHORDS = [
    { name: 'Dmaj9',  pad: [50, 57, 61, 64, 66], root: 38, arp: [62, 66, 69, 73, 76], bell: [69, 73, 76, 78, 81] },
    { name: 'Bm11',   pad: [54, 57, 59, 62, 64], root: 35, arp: [59, 62, 66, 69, 76], bell: [66, 69, 71, 74, 76] },
    { name: 'Gmaj9',  pad: [55, 59, 62, 66, 69], root: 31, arp: [55, 59, 62, 66, 69], bell: [66, 69, 71, 74, 79] },
    { name: 'A6sus4', pad: [52, 57, 62, 66, 69], root: 33, arp: [57, 62, 64, 66, 69], bell: [64, 66, 69, 74, 76] }
  ];
  // 16th-note arpeggio shapes: index into chord.arp, 5..9 = one octave up
  var ARPS = [
    [0, 1, 2, 3, 4, 3, 2, 1, 0, 1, 2, 3, 4, 3, 2, 1],
    [0, 2, 4, 2, 1, 3, 5, 3, 0, 2, 4, 2, 1, 3, 5, 6],
    [0, 4, 1, 4, 2, 4, 3, 4, 0, 4, 1, 4, 2, 5, 3, 4],
    [4, 2, 1, 0, 4, 2, 1, 0, 5, 3, 2, 1, 4, 3, 2, 1]
  ];
  // sparse bell figures for one bar: [step, index into chord.bell]
  var BELLS = [
    [[0, 2], [6, 4], [10, 3]],
    [[0, 3], [10, 1]],
    [[3, 2], [6, 3], [14, 4]],
    [[0, 4], [12, 2]],
    [[6, 1], [10, 2], [12, 4]],
    [[0, 1], [3, 3], [10, 2]]
  ];
  // lead motifs over 4 bars (64 steps): [step, midi, length in steps]
  var MOTIFS = [
    [[0, 81, 3], [3, 78, 3], [6, 76, 10], [32, 74, 3], [35, 76, 3], [38, 78, 14]],   // Dmaj9 -> Bm11
    [[0, 83, 3], [3, 81, 3], [6, 78, 10], [32, 76, 3], [35, 78, 3], [38, 74, 14]],   // Gmaj9 -> A6sus4
    [[0, 78, 2], [2, 81, 2], [4, 85, 12], [16, 83, 8], [32, 81, 6], [38, 78, 12]],   // alt
    [[0, 79, 4], [4, 78, 2], [6, 74, 10], [32, 76, 4], [36, 78, 4], [40, 81, 20]]    // alt, lifts home
  ];
  // bass per bar: [step, semitone offset (saw layer only), length in steps, velocity]
  var BASS_SOFT = [[2, 0, 2.1, 0.72], [6, 0, 2.1, 0.62], [10, 0, 2.1, 0.72], [14, 0, 2.1, 0.62]];
  var BASS_TIGHT = [[2, 0, 1.55, 1], [6, 0, 1.55, 0.9], [10, 0, 1.55, 1], [14, 0, 1.55, 0.9]];
  var BASS_TURN = [[2, 0, 1.55, 1], [6, 0, 1.55, 0.9], [10, 0, 1.55, 1], [14, 0, 0.8, 0.85], [15, 12, 0.8, 0.7]];
  // layer thresholds; tonal layers (1) only change on bar lines, percussion (0) on beats
  var GATES = {
    bass: [0.2, 1], kick: [0.4, 0], hat: [0.4, 0], four: [0.55, 1], pump: [0.55, 1],
    clap: [0.65, 0], ghost: [0.65, 0], arp: [0.8, 1], lead: [0.9, 1]
  };

  /* ------------------------------------------------------------------ helpers */
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function smooth(a, b, v) { var t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function hash2(a, b) {               // deterministic 0..1, so renders are repeatable
    var h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x165667b1, 0x9e3779b1)) | 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function rng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gainNode(ctx, v) { var g = ctx.createGain(); g.gain.value = v; return g; }
  function biquad(ctx, type, f, q) {
    var b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b;
  }
  function panner(ctx, p) {
    if (ctx.createStereoPanner) { var n = ctx.createStereoPanner(); n.pan.value = p; return n; }
    return ctx.createGain();
  }
  function compressor(ctx, thr, knee, ratio, att, rel) {
    var c = ctx.createDynamicsCompressor();
    c.threshold.value = thr; c.knee.value = knee; c.ratio.value = ratio;
    c.attack.value = att; c.release.value = rel;
    return c;
  }
  function osc(ctx, type, f) { var o = ctx.createOscillator(); o.type = type; o.frequency.value = f; return o; }
  function unplug(nodes) {
    for (var i = 0; i < nodes.length; i++) { try { nodes[i].disconnect(); } catch (e) {} }
  }
  // free a one-shot voice's nodes once its source has stopped
  function release(src, nodes) {
    src.onended = function () { src.onended = null; unplug(nodes); };
  }
  function makeNoise(ctx, seconds, seed) {
    var n = Math.floor(ctx.sampleRate * seconds), b = ctx.createBuffer(1, n, ctx.sampleRate);
    var d = b.getChannelData(0), r = rng(seed);
    for (var i = 0; i < n; i++) d[i] = r() * 2 - 1;
    return b;
  }
  // stereo hall: decorrelated noise, exponential decay (RT60 = dur), darkening tail, early taps
  function makeIR(ctx, dur, seed) {
    var sr = ctx.sampleRate, n = Math.floor(sr * dur), b = ctx.createBuffer(2, n, sr), r = rng(seed);
    var pre = Math.floor(0.016 * sr);
    for (var c = 0; c < 2; c++) {
      var d = b.getChannelData(c), lp = 0;
      for (var i = pre; i < n; i++) {
        var t = (i - pre) / sr;
        var damp = 0.18 + 0.74 * Math.min(1, t / dur);
        lp += ((r() * 2 - 1) - lp) * (1 - damp);
        d[i] = lp * Math.exp(-6.9 * t / dur) * Math.min(1, t / 0.008);
      }
      for (var k = 0; k < 12; k++) {
        var at = pre + Math.floor((0.003 + r() * 0.075) * sr);
        if (at < n) d[at] += (r() * 2 - 1) * 0.35 * (1 - k / 12);
      }
    }
    return b;
  }

  /* ==================================================================
     ENGINE: one graph + one scheduler, shared by real-time and offline
     ================================================================== */
  function Engine(ctx, o) {
    var self = this;
    this.ctx = ctx;
    this.iFn = o.intensity;
    this.noDrums = !!o.noDrums;
    this.noise = makeNoise(ctx, 2.5, 7);
    this.nseed = 1;
    this.voices = [];
    this.swells = [];
    this.gate = {};
    this.chord = -1; this.chordT = 0;
    this.step = 0; this.s0 = 0; this.t0 = 0;
    this.origin = 0; this.phraseBase = 0;
    this.leadOn = false; this.leadSet = 0;
    this.bellPat = 0; this.bsawM = -1;

    /* ---- master: mix -> gen gate -> pre -> HP 30 -> glue -> limiter -> trim -> fade -> duck -> volume -> out */
    this.mix = gainNode(ctx, 1);
    this.gen = gainNode(ctx, 1);
    this.pre = gainNode(ctx, 1);
    var hp = biquad(ctx, 'highpass', 32, 0.7);
    var glue = compressor(ctx, -12, 6, 2, 0.02, 0.25);
    var lim = compressor(ctx, -5, 0, 20, 0.002, 0.09);
    this.trim = gainNode(ctx, 0.92);
    this.fade = gainNode(ctx, o.fade);
    this.duck = gainNode(ctx, 1);
    this.out = gainNode(ctx, o.volume);
    this.mix.connect(this.gen); this.gen.connect(this.pre);
    if (o.raw) this.pre.connect(this.fade);   // test hook: bypass the master dynamics
    else { this.pre.connect(hp); hp.connect(glue); glue.connect(lim); lim.connect(this.trim); }
    this.trim.connect(this.fade); this.fade.connect(this.duck); this.duck.connect(this.out);
    this.out.connect(ctx.destination);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.out.connect(this.analyser);
    this.fileIn = gainNode(ctx, 0);          // optional HTMLAudioElement route (file mode)
    this.fileIn.connect(this.fade);

    /* ---- shared reverb (procedural 2.8 s stereo hall) */
    this.rev = gainNode(ctx, 1);
    var rHp = biquad(ctx, 'highpass', 240, 0.6), rLp = biquad(ctx, 'lowpass', 6500, 0.6);
    var conv = ctx.createConvolver();
    conv.buffer = makeIR(ctx, 2.8, 11);
    var rOut = gainNode(ctx, 0.62);
    this.rev.connect(rHp); rHp.connect(conv); conv.connect(rLp); rLp.connect(rOut); rOut.connect(this.pre);

    /* ---- dotted-8th ping-pong delay */
    this.dly = gainNode(ctx, 1);
    var dHp = biquad(ctx, 'highpass', 320, 0.7), dLp = biquad(ctx, 'lowpass', 4200, 0.7);
    var dL = ctx.createDelay(1.5), dR = ctx.createDelay(1.5);
    dL.delayTime.value = BEAT * 0.75; dR.delayTime.value = BEAT * 0.75;
    var fbLp = biquad(ctx, 'lowpass', 3200, 0.6), fb = gainNode(ctx, 0.42);
    var merge = ctx.createChannelMerger(2), dOut = gainNode(ctx, 0.55), dRev = gainNode(ctx, 0.22);
    this.dly.connect(dHp); dHp.connect(dLp); dLp.connect(dL);
    dL.connect(dR); dR.connect(fbLp); fbLp.connect(fb); fb.connect(dL);
    dL.connect(merge, 0, 0); dR.connect(merge, 0, 1);
    merge.connect(dOut); dOut.connect(this.pre); dOut.connect(dRev); dRev.connect(this.rev);

    this.stems = {};
    function bus(name, level, revAmt, dlyAmt, dest) {
      var g = gainNode(ctx, level);
      self.stems[name] = g;
      g.connect(dest || self.mix);
      if (revAmt) { var s = gainNode(ctx, revAmt); g.connect(s); s.connect(self.rev); }
      if (dlyAmt) { var e = gainNode(ctx, dlyAmt); g.connect(e); e.connect(self.dly); }
      return g;
    }
    function chain(nodes, dest) {
      for (var i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
      nodes[nodes.length - 1].connect(dest);
      return nodes[0];
    }

    /* ---- drum buses */
    this.kickBus = bus('kick', 1, 0, 0);
    this.clickBus = chain([biquad(ctx, 'bandpass', 3200, 0.8)], this.kickBus);
    this.hatBus = chain([biquad(ctx, 'highpass', 6600, 0.7), biquad(ctx, 'lowpass', 11500, 0.5), panner(ctx, 0.22)], bus('hat', 1, 0.08, 0));
    this.ghostBus = chain([biquad(ctx, 'highpass', 7000, 0.7), biquad(ctx, 'lowpass', 11000, 0.5), panner(ctx, -0.3)], bus('ghost', 1, 0.1, 0));
    this.clapBus = chain([biquad(ctx, 'highpass', 700, 0.7), biquad(ctx, 'bandpass', 1550, 0.6)], bus('clap', 1, 0.42, 0));
    this.airBus = chain([biquad(ctx, 'highpass', 5200, 0.6), biquad(ctx, 'lowpass', 10000, 0.5)], bus('air', 1, 0.5, 0));
    /* ---- tonal one-shot buses */
    this.bellBus = bus('bell', 1, 0.5, 0.24);
    this.arpBus = chain([biquad(ctx, 'highpass', 180, 0.7)], bus('arp', 1, 0.2, 0.42));
    this.leadBus = bus('lead', 1, 0.55, 0.32);
    /* ---- swell fx bypass the generator gate so they also work over a file */
    this.fxBus = bus('fx', 1, 0.75, 0.12, this.pre);
    this.boomBus = gainNode(ctx, 1); this.boomBus.connect(this.pre);
    this.fxAir = chain([biquad(ctx, 'highpass', 5200, 0.6), biquad(ctx, 'lowpass', 10000, 0.5)], this.fxBus);

    /* ---- pad: 5 voices x 2 detuned saws (L/R), 4-pole lowpass per side, persistent */
    this.padGate = gainNode(ctx, 1);
    this.padPump = gainNode(ctx, 1);
    this.padLvl = gainNode(ctx, 1);
    var padOut = bus('pad', 1, 0.32, 0);
    this.padLvl.connect(this.padGate); this.padGate.connect(this.padPump); this.padPump.connect(padOut);
    this.padF = []; this.padO = [];
    var r = rng(5);
    for (var side = 0; side < 2; side++) {
      var sum = gainNode(ctx, 0.05);
      var f1 = biquad(ctx, 'lowpass', 900, 0.54), f2 = biquad(ctx, 'lowpass', 900, 1.2);
      var pp = panner(ctx, side ? 0.72 : -0.72);
      sum.connect(f1); f1.connect(f2); f2.connect(pp); pp.connect(this.padLvl);
      this.padF.push(f1, f2);
      for (var v = 0; v < 5; v++) {
        var po = osc(ctx, 'sawtooth', mtof(CHORDS[0].pad[v]));
        po.detune.value = (side ? 1 : -1) * (5 + v * 1.7) + (r() - 0.5) * 2;
        po.connect(sum);
        this.padO.push({ o: po, v: v });
      }
    }
    // one automation lane drives all four pad filters (ConstantSource when available)
    this.cutParams = [];
    if (ctx.createConstantSource) {
      this.padCut = ctx.createConstantSource();
      this.padCut.offset.value = 900;
      for (var q = 0; q < this.padF.length; q++) { this.padF[q].frequency.value = 0; this.padCut.connect(this.padF[q].frequency); }
      this.cutParams.push(this.padCut.offset);
    } else {
      for (var q2 = 0; q2 < this.padF.length; q2++) this.cutParams.push(this.padF[q2].frequency);
    }
    // slow filter drift, so long notes breathe
    this.lfo = osc(ctx, 'sine', 0.071);
    var lfoG = gainNode(ctx, 120);
    this.lfo.connect(lfoG);
    for (var k = 0; k < this.padF.length; k++) lfoG.connect(this.padF[k].frequency);

    /* ---- bass: persistent sine sub + filtered saw, gated per note */
    this.bassPump = gainNode(ctx, 1);
    this.bassPump.connect(bus('bass', 1, 0, 0));
    this.sub = osc(ctx, 'sine', mtof(38));
    this.subGate = gainNode(ctx, 0);
    this.sub.connect(this.subGate); this.subGate.connect(this.bassPump);
    this.bsaw = osc(ctx, 'sawtooth', mtof(38));
    this.bsawF = biquad(ctx, 'lowpass', 260, 2.2);
    var bsawHp = biquad(ctx, 'highpass', 85, 0.7);
    this.bsawGate = gainNode(ctx, 0);
    this.bsaw.connect(this.bsawF); this.bsawF.connect(bsawHp); bsawHp.connect(this.bsawGate);
    this.bsawGate.connect(this.bassPump);
  }

  var E = Engine.prototype;

  E.timeOf = function (step) { return this.t0 + (step - this.s0) * STEP; };

  E.begin = function (t) {
    this.t0 = t; this.s0 = 0; this.step = 0;
    var st = Math.max(0, t - 0.05);
    for (var i = 0; i < this.padO.length; i++) this.padO[i].o.start(st);
    this.sub.start(st); this.bsaw.start(st); this.lfo.start(st);
    if (this.padCut) this.padCut.start(st);
    this.setChord(0, st, true);
    var I = clamp(+this.iFn(t) || 0, 0, 1);
    this.gates(I, true);
    for (var k = 0; k < this.cutParams.length; k++) this.cutParams[k].setValueAtTime(this.cutoff(I, 0, -1), st);
    this.padLvl.gain.setValueAtTime(0.66 + 0.34 * I, st);
  };

  /* THE scheduler: every step whose time falls in [t0, t1) gets scheduled.
     Real time calls it every 25 ms with a 150 ms window; offline calls it once. */
  E.scheduleRange = function (t0, t1) {
    for (;;) {
      var t = this.timeOf(this.step);
      if (t >= t1) break;
      if (t >= t0) this.scheduleStep(this.step, t);
      this.step++;
    }
  };

  E.gates = function (I, isBar) {
    for (var k in GATES) {
      if (GATES[k][1] && !isBar) continue;
      var th = GATES[k][0];
      this.gate[k] = this.gate[k] ? I >= th - 0.04 : I >= th;
    }
  };

  E.cutoff = function (I, since, rise) {
    var c = 900 * Math.pow(4000 / 900, I);
    c *= 1 + 0.45 * Math.exp(-since / 0.9);          // gentle bloom on each chord change
    if (rise >= 0) c *= 1 + 1.4 * rise * rise;        // swell opens the pad
    return Math.min(c, 8000);
  };

  E.riseAt = function (t) {
    for (var i = 0; i < this.swells.length; i++) {
      var s = this.swells[i];
      if (t >= s.s - 1e-4 && t < s.t - 1e-4) return (t - s.s) / (s.t - s.s);
    }
    return -1;
  };
  E.preImpact = function (t) {
    for (var i = 0; i < this.swells.length; i++) {
      var s = this.swells[i];
      if (t >= s.t - BEAT - 1e-4 && t < s.t - 1e-4) return true;
    }
    return false;
  };

  E.setChord = function (ci, t, instant) {
    var ch = CHORDS[ci];
    this.chord = ci; this.chordT = t;
    for (var i = 0; i < this.padO.length; i++) {
      var p = this.padO[i], f = mtof(ch.pad[p.v]);
      if (instant) p.o.frequency.setValueAtTime(f, t);
      else p.o.frequency.setTargetAtTime(f, Math.max(0, t - 0.012), 0.022);
    }
    var fr = mtof(ch.root);
    if (instant) { this.sub.frequency.setValueAtTime(fr, t); this.bsaw.frequency.setValueAtTime(fr, t); }
    else {
      this.sub.frequency.setTargetAtTime(fr, Math.max(0, t - 0.014), 0.004);
      this.bsaw.frequency.setTargetAtTime(fr, Math.max(0, t - 0.014), 0.004);
    }
    this.bsawM = ch.root;
  };

  E.claim = function (t, dur, prio) {
    var v = this.voices, n = 0;
    for (var i = 0; i < v.length; i++) if (v[i] > t) v[n++] = v[i];
    v.length = n;
    if (n >= (prio ? MAX_VOICES : MAX_VOICES - 8)) return false;
    v.push(t + dur);
    return true;
  };

  E.noiseAt = function (t, dur) {
    var s = this.ctx.createBufferSource();
    s.buffer = this.noise; s.loop = true;
    this.nseed = (this.nseed * 48271) % 2147483647;
    s.start(t, (this.nseed % 1000) / 1000 * (this.noise.duration - 0.2));
    s.stop(t + dur);
    return s;
  };

  E.scheduleStep = function (step, t) {
    // a swell impact restarts the phrase on the tonic
    for (var i = 0; i < this.swells.length; i++) {
      var sw = this.swells[i];
      if (sw.step === step && !sw.done) {
        sw.done = true;
        this.phraseBase += Math.floor((step - this.origin) / 128) + 1;
        this.origin = step;
      }
    }
    if (this.swells.length && this.swells[0].t < t - 12) this.swells.shift();

    var I = clamp(+this.iFn(t) || 0, 0, 1);
    var pos = step - this.origin, bar = Math.floor(pos / 16), s = pos - bar * 16;
    var pb = bar % 8, phrase = this.phraseBase + Math.floor(bar / 8);
    var rise = this.riseAt(t);
    var ci = rise >= 0 ? 3 : pb >> 1;              // the riser holds the dominant
    var ch = CHORDS[ci];

    if (s === 0) this.gates(I, true); else if (s % 4 === 0) this.gates(I, false);
    var g = this.gate;
    if (ci !== this.chord) this.setChord(ci, t, false);

    /* continuous parameters, one linear segment per 16th */
    var cut = this.cutoff(I, t - this.chordT, rise);
    for (var k = 0; k < this.cutParams.length; k++) this.cutParams[k].linearRampToValueAtTime(cut, t);
    this.padLvl.gain.linearRampToValueAtTime(0.66 + 0.34 * I, t);

    var dropPhrase = phrase % 4 === 3;
    var drop = (dropPhrase && pb === 7 && s >= 8) || this.preImpact(t);
    var fill = !dropPhrase && phrase % 2 === 1 && pb === 7 && s >= 12 && I >= 0.78 && rise < 0;

    /* ---- bell: always present, sparse */
    if (s === 0) this.bellPat = Math.floor(hash2(phrase * 8 + pb, 17) * BELLS.length);
    var bp = BELLS[this.bellPat];
    for (var b = 0; b < bp.length; b++) {
      if (bp[b][0] !== s) continue;
      var dens = this.leadOn ? 0.3 : g.arp ? 0.45 : 0.78;
      if (b > 0 && hash2(phrase * 131 + pb * 16 + s, 5) > dens) continue;
      var bv = 0.105 * (0.8 + 0.35 * hash2(step, 9)) * (1 - 0.1 * smooth(0.6, 1, I));
      this.bell(t, ch.bell[bp[b][1]], bv, (hash2(step, 23) - 0.5) * 0.9, 0.7 + 0.5 * I);
    }

    /* ---- lead motif, decided on 4-bar lines */
    if (s === 0 && pb % 4 === 0) { this.leadOn = !!g.lead && rise < 0; this.leadSet = (phrase % 2) * 2 + (pb >> 2); }
    if (this.leadOn) {
      var mo = MOTIFS[this.leadSet], local = (pb % 4) * 16 + s;
      for (var m = 0; m < mo.length; m++) {
        if (mo[m][0] === local) this.lead(t, mo[m][1], mo[m][2] * STEP, 0.036 * (0.8 + 0.2 * smooth(0.9, 1, I)));
      }
    }

    /* ---- arp */
    if (g.arp) {
      var pat = ARPS[(phrase * 2 + (pb >> 2)) % ARPS.length], ai = pat[s];
      if (ai >= 0) {
        var note = ch.arp[ai % 5] + 12 * Math.floor(ai / 5);
        var acc = s % 4 === 0 ? 1 : s % 2 === 0 ? 0.8 : 0.66;
        var lift = ((pb % 2) * 16 + s) / 32;
        var bright = (2000 + 2600 * smooth(0.8, 1, I)) * (0.82 + 0.36 * lift);
        this.arp(t, note, 0.22 * acc * (0.75 + 0.25 * smooth(0.8, 0.95, I)), (s % 2 ? 0.18 : -0.18), bright);
      }
    }

    if (this.noDrums) return;

    /* ---- bass */
    if (g.bass && !drop) {
      var pat2 = I < 0.55 ? BASS_SOFT : (phrase % 2 === 1 && pb % 2 === 1 ? BASS_TURN : BASS_TIGHT);
      for (var n = 0; n < pat2.length; n++) {
        var bn = pat2[n];
        if (bn[0] !== s) continue;
        var lvl = bn[3] * (0.55 + 0.45 * smooth(0.2, 0.55, I));
        this.bassNote(t, bn[2] * STEP, ch.root, bn[1], lvl, 300 + 900 * smooth(0.2, 1, I));
      }
    }

    /* ---- kick + sidechain */
    if (g.kick && !drop) {
      var kv = 0.9 + 0.1 * smooth(0.4, 0.8, I), hit = 0;
      if (g.four) hit = s % 4 === 0 ? kv : 0;
      else hit = (s === 0 || s === 8) ? kv : (s === 11 && pb % 2 === 1 ? kv * 0.55 : 0);
      if (hit) {
        this.kick(t, hit);
        if (g.pump) this.pump(t, (0.28 + 0.1 * smooth(0.55, 0.9, I)) * (REDUCED ? 0.6 : 1));
      }
    }

    /* ---- hats */
    if (g.hat && !drop && !fill && s % 4 === 2) {
      this.hat(t, 0.27 * (0.85 + 0.15 * hash2(step, 41)) * (0.75 + 0.25 * smooth(0.4, 0.7, I)), this.hatBus, 0.014, 1);
    }
    if (g.ghost && !drop && !fill && s % 2 === 1) {
      this.hat(t + 0.007, 0.09 * (0.6 + 0.6 * hash2(step, 43)), this.ghostBus, 0.009, 0);
    }
    if (fill && s === 12) this.roll(t, 0.11);

    /* ---- claps on 2 and 4 */
    if (g.clap && !drop && (s === 4 || s === 12)) this.clap(t, 0.7 * (0.85 + 0.15 * smooth(0.65, 1, I)));

    /* ---- phrase dressing */
    if (s === 0 && pb === 0 && I >= 0.65 && (phrase > 0 || step > 0)) this.air(t, 0.07 * smooth(0.6, 1, I));
    if (dropPhrase && pb === 7 && s === 8 && I >= 0.55 && rise < 0) this.lift(t, 8 * STEP, 0.06 * smooth(0.5, 1, I));
  };

  /* ------------------------------------------------------------ instruments */
  E.pump = function (t, depth) {
    var pg = this.padPump.gain, bg = this.bassPump.gain;
    pg.setTargetAtTime(1 - depth, t, 0.006); pg.setTargetAtTime(1, t + 0.05, 0.1);
    var bd = Math.min(0.8, depth * 1.4);
    bg.setTargetAtTime(1 - bd, t, 0.004); bg.setTargetAtTime(1, t + 0.06, 0.08);
  };

  E.bassNote = function (t, len, root, offset, v, bright) {
    var sg = this.subGate.gain, wg = this.bsawGate.gain, ff = this.bsawF.frequency;
    var m = root + offset;
    if (m !== this.bsawM) {
      this.bsaw.frequency.setTargetAtTime(mtof(m), Math.max(0, t - 0.008), 0.002);
      this.bsawM = m;
    }
    sg.setTargetAtTime(v * 0.15, t, 0.006); sg.setTargetAtTime(0, t + len, 0.03);
    wg.setTargetAtTime(v * 0.22, t, 0.004); wg.setTargetAtTime(0, t + len, 0.026);
    ff.setTargetAtTime(bright, t, 0.003); ff.setTargetAtTime(240, t + 0.012, 0.085);
  };

  E.kick = function (t, v) {
    if (!this.claim(t, 0.6, 1)) return;
    var c = this.ctx, o = osc(c, 'sine', 160), g = gainNode(c, 0);
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(120, t + 0.012);
    o.frequency.exponentialRampToValueAtTime(55, t + 0.1);
    o.frequency.exponentialRampToValueAtTime(49, t + 0.3);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v * 0.5, t + 0.002);
    g.gain.setTargetAtTime(0, t + 0.035, 0.062);
    o.connect(g); g.connect(this.kickBus);
    o.start(t); o.stop(t + 0.6);
    release(o, [o, g]);
    var n = this.noiseAt(t, 0.03), ng = gainNode(c, 0);
    ng.gain.setValueAtTime(0, t);
    ng.gain.linearRampToValueAtTime(v * 0.34, t + 0.0006);
    ng.gain.setTargetAtTime(0, t + 0.0008, 0.0035);
    n.connect(ng); ng.connect(this.clickBus);
    release(n, [n, ng]);
  };

  E.hat = function (t, v, busNode, dec, prio) {
    if (!this.claim(t, dec * 8, prio)) return;
    var n = this.noiseAt(t, dec * 8), g = gainNode(this.ctx, 0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v, t + 0.001);
    g.gain.setTargetAtTime(0, t + 0.0012, dec);
    n.connect(g); g.connect(busNode);
    release(n, [n, g]);
  };

  E.roll = function (t, v) {             // hat roll: 32nds, rising, into the next phrase
    for (var i = 0; i < 8; i++) {
      var k = i / 7;
      this.hat(t + i * STEP / 2, v * (0.35 + 0.65 * k * k), this.hatBus, 0.008 + 0.006 * k, 1);
    }
  };

  E.clap = function (t, v) {
    if (!this.claim(t, 0.45, 1)) return;
    var n = this.noiseAt(t, 0.45), g = gainNode(this.ctx, 0), p = g.gain;
    for (var k = 0; k < 3; k++) {
      var tk = t + k * 0.0105;
      p.setValueAtTime(v * (0.8 + 0.1 * k), tk);
      p.setTargetAtTime(v * 0.05, tk + 0.0004, 0.0032);
    }
    var tt = t + 0.0315;
    p.setValueAtTime(v * 0.85, tt);
    p.setTargetAtTime(0, tt + 0.0004, 0.055);
    n.connect(g); g.connect(this.clapBus);
    release(n, [n, g]);
  };

  E.air = function (t, v) {             // soft cymbal-like air at a phrase start
    if (!this.claim(t, 3.2, 0)) return;
    var n = this.noiseAt(t, 3.2), g = gainNode(this.ctx, 0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v, t + 0.008);
    g.gain.setTargetAtTime(0, t + 0.01, 0.55);
    n.connect(g); g.connect(this.airBus);
    release(n, [n, g]);
  };

  E.lift = function (t, d, v) {         // short noise uplift inside the half-bar drop
    var c = this.ctx, n = this.noiseAt(t, d + 0.05), f = biquad(c, 'bandpass', 500, 1.1), g = gainNode(c, 0);
    f.frequency.setValueAtTime(500, t);
    f.frequency.exponentialRampToValueAtTime(6000, t + d);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v * 0.15, t + d * 0.5);
    g.gain.linearRampToValueAtTime(v, t + d - 0.02);
    g.gain.linearRampToValueAtTime(0, t + d + 0.02);
    n.connect(f); f.connect(g); g.connect(this.fxBus);
    release(n, [n, f, g]);
  };

  E.bell = function (t, m, v, pan, bright) {   // 2-op FM, harmonic ratio, bright attack, long glassy tail
    if (!this.claim(t, 3.6, 0)) return;
    var c = this.ctx, f = mtof(m);
    var car = osc(c, 'sine', f), mod = osc(c, 'sine', f * 3.002), mg = gainNode(c, 0), g = gainNode(c, 0), p = panner(c, pan);
    mg.gain.setValueAtTime(f * 1.5 * bright, t);
    mg.gain.setTargetAtTime(f * 0.12, t + 0.002, 0.16);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v, t + 0.004);
    g.gain.setTargetAtTime(0, t + 0.006, 0.55);
    mod.connect(mg); mg.connect(car.frequency); car.connect(g); g.connect(p); p.connect(this.bellBus);
    car.start(t); mod.start(t); car.stop(t + 3.6); mod.stop(t + 3.6);
    release(car, [car, mod, mg, g, p]);
  };

  E.arp = function (t, m, v, pan, bright) {
    if (!this.claim(t, 0.5, 0)) return;
    var c = this.ctx, o = osc(c, 'sawtooth', mtof(m)), f = biquad(c, 'lowpass', bright, 2.2), g = gainNode(c, 0), p = panner(c, pan);
    o.detune.value = (hash2(this.step, 3) - 0.5) * 6;
    f.frequency.setValueAtTime(bright, t);
    f.frequency.setTargetAtTime(800, t + 0.002, 0.075);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v, t + 0.003);
    g.gain.setTargetAtTime(0, t + 0.005, 0.09);
    o.connect(f); f.connect(g); g.connect(p); p.connect(this.arpBus);
    o.start(t); o.stop(t + 0.5);
    release(o, [o, f, g, p]);
  };

  E.lead = function (t, m, len, v) {   // shimmering FM: two detuned carriers + a soft octave partial
    var end = t + len + 2.6;
    if (!this.claim(t, end - t, 1)) return;
    var c = this.ctx, f = mtof(m);
    var c1 = osc(c, 'sine', f), c2 = osc(c, 'sine', f), c3 = osc(c, 'sine', f * 2), mod = osc(c, 'sine', f * 2);
    c1.detune.value = -7; c2.detune.value = 7; c3.detune.value = 3;
    var mg = gainNode(c, 0), g = gainNode(c, 0), g3 = gainNode(c, 0.18);
    mg.gain.setValueAtTime(f * 1.3, t);
    mg.gain.setTargetAtTime(f * 0.35, t + 0.005, 0.3);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v, t + 0.014);
    g.gain.setTargetAtTime(v * 0.55, t + 0.02, 0.35);
    g.gain.setTargetAtTime(0, t + len, 0.42);
    mod.connect(mg); mg.connect(c1.frequency); mg.connect(c2.frequency);
    c1.connect(g); c2.connect(g); c3.connect(g3); g3.connect(g); g.connect(this.leadBus);
    var all = [c1, c2, c3, mod];
    for (var i = 0; i < 4; i++) { all[i].start(t); all[i].stop(end); }
    release(c1, [c1, c2, c3, mod, mg, g, g3]);
  };

  /* ------------------------------------------------------------ the swell */
  // riser starts on the next beat after `at`; impact lands on a bar line ~2 bars later
  E.planSwell = function (at) {
    var fs = this.s0 + (at - this.t0) / STEP;
    var first = Math.max(Math.ceil(fs - 1e-6), this.step);
    var minImpact = first + 28;
    var impact = this.origin + Math.ceil((minImpact - this.origin) / 16) * 16;
    var rs = Math.max(first, impact - 32);
    rs = this.origin + Math.ceil((rs - this.origin) / 4) * 4;
    var S = this.timeOf(rs), T = this.timeOf(impact);
    this.swells.push({ step: impact, t: T, s: S, done: false });
    this.riser(S, T);
    this.impact(T);
    return T;
  };

  E.riser = function (S, T) {
    var c = this.ctx, d = T - S, nodes = [];
    var merge = c.createChannelMerger(2), ng = gainNode(c, 0);
    nodes.push(merge, ng);
    var srcs = [];
    for (var ch = 0; ch < 2; ch++) {
      var n = this.noiseAt(S, d + 0.08), f = biquad(c, 'bandpass', 280, 1.3);
      f.frequency.setValueAtTime(280, S);
      f.frequency.exponentialRampToValueAtTime(7200, T);
      n.connect(f); f.connect(merge, 0, ch);
      nodes.push(n, f); srcs.push(n);
    }
    ng.gain.setValueAtTime(0, S);
    ng.gain.linearRampToValueAtTime(0.03, S + d * 0.45);
    ng.gain.exponentialRampToValueAtTime(0.3, T - 0.015);
    ng.gain.linearRampToValueAtTime(0, T + 0.02);
    merge.connect(ng); ng.connect(this.fxBus);
    // rising pad on A sus (V of D): crescendo + opening filter + widening detune
    var notes = [57, 62, 64, 69, 76], pg = gainNode(c, 0), pm = c.createChannelMerger(2);
    var fl = biquad(c, 'lowpass', 350, 0.9), fr = biquad(c, 'lowpass', 350, 0.9);
    [fl, fr].forEach(function (f) {
      f.frequency.setValueAtTime(350, S);
      f.frequency.exponentialRampToValueAtTime(5200, T);
    });
    fl.connect(pm, 0, 0); fr.connect(pm, 0, 1); pm.connect(pg); pg.connect(this.fxBus);
    nodes.push(pg, pm, fl, fr);
    for (var i = 0; i < notes.length; i++) {
      for (var s = 0; s < 2; s++) {
        var o = osc(c, 'sawtooth', mtof(notes[i]));
        o.detune.setValueAtTime((s ? 2 : -2), S);
        o.detune.linearRampToValueAtTime((s ? 1 : -1) * (12 + i * 3), T);
        o.connect(s ? fr : fl);
        o.start(S); o.stop(T + 0.06);
        nodes.push(o); srcs.push(o);
      }
    }
    pg.gain.setValueAtTime(0, S);
    pg.gain.linearRampToValueAtTime(0.016, S + d * 0.5);
    pg.gain.exponentialRampToValueAtTime(0.09, T - 0.02);
    pg.gain.linearRampToValueAtTime(0, T + 0.03);
    release(srcs[0], nodes);
  };

  E.impact = function (T) {
    var c = this.ctx;
    // deep boom
    var o = osc(c, 'sine', 92), g = gainNode(c, 0);
    o.frequency.setValueAtTime(92, T);
    o.frequency.exponentialRampToValueAtTime(34, T + 1.4);
    g.gain.setValueAtTime(0, T);
    g.gain.linearRampToValueAtTime(0.62, T + 0.005);
    g.gain.setTargetAtTime(0, T + 0.06, 0.5);
    o.connect(g); g.connect(this.boomBus);
    o.start(T); o.stop(T + 3.6);
    release(o, [o, g]);
    var n = this.noiseAt(T, 0.5), nf = biquad(c, 'lowpass', 220, 0.8), ng = gainNode(c, 0);
    ng.gain.setValueAtTime(0, T);
    ng.gain.linearRampToValueAtTime(0.5, T + 0.003);
    ng.gain.setTargetAtTime(0, T + 0.006, 0.07);
    n.connect(nf); nf.connect(ng); ng.connect(this.boomBus);
    release(n, [n, nf, ng]);
    // wide bright Dmaj9 stab
    var notes = [50, 62, 69, 73, 76, 78, 81], m = c.createChannelMerger(2), sg = gainNode(c, 0);
    var fl = biquad(c, 'lowpass', 6500, 0.7), fr = biquad(c, 'lowpass', 6500, 0.7), nodes = [m, sg, fl, fr];
    [fl, fr].forEach(function (f) {
      f.frequency.setValueAtTime(6500, T);
      f.frequency.setTargetAtTime(1300, T + 0.01, 0.45);
    });
    fl.connect(m, 0, 0); fr.connect(m, 0, 1); m.connect(sg); sg.connect(this.fxBus);
    var first = null;
    for (var i = 0; i < notes.length; i++) {
      for (var s = 0; s < 2; s++) {
        var so = osc(c, 'sawtooth', mtof(notes[i]));
        so.detune.value = (s ? 1 : -1) * (8 + i);
        so.connect(s ? fr : fl);
        so.start(T); so.stop(T + 3.2);
        nodes.push(so);
        if (!first) first = so;
      }
    }
    sg.gain.setValueAtTime(0, T);
    sg.gain.linearRampToValueAtTime(0.05, T + 0.006);
    sg.gain.setTargetAtTime(0.018, T + 0.01, 0.35);
    sg.gain.setTargetAtTime(0, T + 0.9, 0.5);
    release(first, nodes);
    // air
    var a = this.noiseAt(T, 4.6), ag = gainNode(c, 0);
    ag.gain.setValueAtTime(0, T);
    ag.gain.linearRampToValueAtTime(0.08, T + 0.006);
    ag.gain.setTargetAtTime(0, T + 0.01, 0.85);
    a.connect(ag); ag.connect(this.fxAir);
    release(a, [a, ag]);
  };

  E.setGen = function (on, t) {
    this.gen.gain.setTargetAtTime(on ? 1 : 0, t, 0.25);
    this.padGate.gain.setTargetAtTime(on ? 1 : 0, t, 0.25);
  };

  /* ==================================================================
     REAL-TIME CONTROLLER
     ================================================================== */
  var R = {
    ctx: null, eng: null, timer: 0, stopTimer: 0, playing: false, hiddenPaused: false,
    target: 0, s0: 0, tc: 0,
    volume: DEFAULT_VOLUME, ducked: false,
    mode: 'gen', fileUrl: '', el: null, elNode: null, elSame: true, elVol: 0, elFade: 0, elT: 0,
    lvl: 0, lvlT: 0, buf: null
  };

  function intensityAt(t) {
    if (!R.ctx) return R.target;
    return R.target + (R.s0 - R.target) * Math.exp(-Math.max(0, t - R.tc) / INTENSITY_TC);
  }

  function ensureContext() {
    if (R.ctx) return R.ctx;
    if (!AC) return null;
    var ctx = null;
    try { ctx = new AC({ latencyHint: 'playback' }); } catch (e) {
      try { ctx = new AC(); } catch (e2) { return null; }
    }
    R.ctx = ctx;
    try {
      R.eng = new Engine(ctx, { intensity: intensityAt, volume: R.volume, fade: 0 });
      R.eng.begin(ctx.currentTime + 0.08);
      if (R.ducked) R.eng.duck.gain.value = DUCK_GAIN;
      if (R.mode === 'file') { R.eng.gen.gain.value = 0; R.eng.padGate.gain.value = 0; R.eng.fileIn.gain.value = 1; }
    } catch (e) {
      R.eng = null;
    }
    try {
      ctx.addEventListener('statechange', function () {
        if (ctx.state === 'running') { if (R.playing) tick(); return; }
        // iOS "interrupted" (calls, Siri) or an OS-level suspend while we still want sound: try again
        if (R.playing && !document.hidden && !R.stopTimer) {
          setTimeout(function () {
            if (R.playing && !document.hidden && ctx.state !== 'running' && ctx.state !== 'closed') {
              try { var p = ctx.resume(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
            }
          }, 400);
        }
      });
    } catch (e) {}
    return ctx;
  }

  function tick() {
    var ctx = R.ctx;
    if (R.el && R.mode === 'file' && !elRouted()) elTick();
    if (!ctx || !R.eng || ctx.state !== 'running') return;
    if (R.mode === 'file') return;
    var now = ctx.currentTime;
    try { R.eng.scheduleRange(now - 0.04, now + LOOKAHEAD); } catch (e) { /* never let a bad frame kill the loop */ }
  }

  function unlock(ctx) {
    try {
      var b = ctx.createBuffer(1, 1, ctx.sampleRate), s = ctx.createBufferSource();
      s.buffer = b; s.connect(ctx.destination); s.start(0);
      s.onended = function () { try { s.disconnect(); } catch (e) {} };
    } catch (e) {}
  }

  function start() {
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
    var ctx = ensureContext();
    clearTimeout(R.stopTimer); R.stopTimer = 0;
    var was = R.playing;
    R.playing = true;
    if (!R.timer) R.timer = setInterval(tick, TICK_MS);
    if (R.mode === 'file') { routeEl(); playEl(); }
    if (!ctx || !R.eng) return ctx || null;
    try { var p = ctx.resume(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
    if (!was) unlock(ctx);
    if (!was) {                                   // fade in (or back up, if a stop() was fading out)
      var now = ctx.currentTime, fg = R.eng.fade.gain;
      try {
        fg.cancelScheduledValues(now);
        fg.setValueAtTime(fg.value, now);
        fg.linearRampToValueAtTime(1, now + 2 * (1 - fg.value) + 0.05);
      } catch (e) { fg.value = 1; }
    }
    tick();
    return ctx;
  }

  function stop() {
    if (!R.playing) return;
    R.playing = false;
    var ctx = R.ctx;
    if (ctx && R.eng) {
      var now = ctx.currentTime, fg = R.eng.fade.gain;
      try {
        fg.cancelScheduledValues(now);
        fg.setValueAtTime(fg.value, now);
        fg.linearRampToValueAtTime(0, now + 1.2);
      } catch (e) { fg.value = 0; }
    }
    clearTimeout(R.stopTimer);
    R.stopTimer = setTimeout(function () {
      R.stopTimer = 0;
      if (R.playing) return;
      if (R.timer) { clearInterval(R.timer); R.timer = 0; }
      if (R.el) { try { R.el.pause(); } catch (e) {} }
      if (R.ctx) { try { var p = R.ctx.suspend(); if (p && p.catch) p.catch(function () {}); } catch (e) {} }
    }, 1300);
  }

  function setIntensity(x) {
    x = clamp(+x || 0, 0, 1);
    if (Math.abs(x - R.target) < 1e-4) return;      // cheap to call every animation frame
    if (R.ctx) {
      var now = R.ctx.currentTime;
      R.s0 = intensityAt(now); R.tc = now; R.target = x;
      if (R.elNode) R.elNode.gain.setTargetAtTime(0.55 + 0.45 * x, now, INTENSITY_TC);
    } else { R.target = R.s0 = x; }
  }

  function setDuck(on) {
    on = !!on;
    if (on === R.ducked && R.duckSet) return;
    R.ducked = on; R.duckSet = true;
    if (R.ctx && R.eng) {
      var now = R.ctx.currentTime, p = R.eng.duck.gain;
      try { p.cancelScheduledValues(now); } catch (e) {}
      p.setTargetAtTime(R.ducked ? DUCK_GAIN : 1, now, R.ducked ? 0.038 : 0.2);
    }
  }

  function setVolume(v) {
    v = clamp(+v, 0, 1);
    if (isNaN(v)) v = DEFAULT_VOLUME;
    if (v === R.volume && R.volSet) return;
    R.volume = v; R.volSet = true;
    if (R.ctx && R.eng) R.eng.out.gain.setTargetAtTime(R.volume, R.ctx.currentTime, 0.05);
  }

  function swell() {
    if (!R.ctx || !R.eng || R.ctx.state !== 'running') return 0;
    var now = R.ctx.currentTime, sw = R.eng.swells;
    for (var i = 0; i < sw.length; i++) if (sw[i].t > now) return sw[i].t - now;   // one swell at a time
    try { return Math.max(0, R.eng.planSwell(now + LOOKAHEAD + 0.02) - now); } catch (e) { return 0; }
  }

  /* ---- optional file mode */
  function makeEl() {
    var el = new Audio();
    el.loop = true; el.preload = 'auto';
    el.setAttribute('playsinline', '');
    return el;
  }
  function elRouted() { return !!(R.el && R.el.__pmRouted); }
  // Web Audio routing gives smooth ducking (and works on iOS, where element.volume is read-only),
  // but only for same-origin files: a cross-origin file without CORS would come out silent.
  function routeEl() {
    var el = R.el;
    if (!el || el.__pmRouted || !R.elSame || !R.ctx || !R.eng || !R.ctx.createMediaElementSource) return;
    try {
      var src = R.ctx.createMediaElementSource(el);
      var g = gainNode(R.ctx, 0.55 + 0.45 * R.target);
      src.connect(g); g.connect(R.eng.fileIn);
      el.__pmRouted = true; R.elNode = g;
      el.volume = 1;
    } catch (e) {}
  }
  function playEl() {
    if (!R.el) return;
    try { var p = R.el.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
  }
  function elTick() {                       // element.volume fallback (file not routed through Web Audio)
    var el = R.el; if (!el) return;
    var now = Date.now() / 1000, dt = Math.min(0.2, now - (R.elT || now)); R.elT = now;
    R.elFade += clamp((R.playing ? 1 : 0) - R.elFade, -dt / 1.2, dt / 2);
    var want = R.volume * (0.55 + 0.45 * R.target) * (R.ducked ? DUCK_GAIN : 1);
    R.elVol += (want - R.elVol) * (1 - Math.exp(-dt / (want < R.elVol ? 0.045 : 0.2)));
    try { el.volume = clamp(R.elVol * R.elFade, 0, 1); } catch (e) {}
  }
  function useFile(url) {
    url = url ? String(url) : '';
    if (url === R.fileUrl) return;
    R.fileUrl = url;
    var now = R.ctx ? R.ctx.currentTime : 0;
    if (!url) {
      R.mode = 'gen';
      if (R.el) { try { R.el.pause(); R.el.removeAttribute('src'); R.el.load(); } catch (e) {} }
      if (R.eng) { R.eng.setGen(true, now); R.eng.fileIn.gain.setTargetAtTime(0, now, 0.1); }
      if (R.playing) tick();
      return;
    }
    R.mode = 'file';
    var same = true;
    try { same = location.origin !== 'null' && new URL(url, location.href).origin === location.origin; } catch (e) {}
    if (R.el && R.el.__pmRouted && !same) {   // a routed element cannot play cross-origin audio audibly
      try { R.el.pause(); } catch (e) {}
      R.el = null; R.elNode = null;
    }
    if (!R.el) R.el = makeEl();
    R.elSame = same;
    try { R.el.src = url; } catch (e) {}
    routeEl();
    if (!elRouted()) { R.elVol = 0; R.elFade = 0; try { R.el.volume = 0; } catch (e) {} }
    if (R.eng) { R.eng.setGen(false, now); R.eng.fileIn.gain.setTargetAtTime(1, now, 0.15); }
    if (R.playing) { playEl(); if (!R.timer) R.timer = setInterval(tick, TICK_MS); }
  }

  function level() {
    var now = (W.performance && performance.now) ? performance.now() : Date.now();
    var dt = Math.min(0.25, Math.max(0.001, (now - (R.lvlT || now)) / 1000)); R.lvlT = now;
    var x = 0;
    var unrouted = R.mode === 'file' && R.el && !elRouted();
    if (unrouted) {
      if (R.playing && !R.el.paused) x = 0.5 * (R.el.volume || 0) + 0.15;
    } else if (R.ctx && R.eng && R.ctx.state === 'running') {
      var an = R.eng.analyser;
      var buf = R.buf || (R.buf = new Float32Array(an.fftSize)), sum = 0, i;
      if (an.getFloatTimeDomainData) { an.getFloatTimeDomainData(buf); for (i = 0; i < buf.length; i++) sum += buf[i] * buf[i]; }
      else {
        var bb = new Uint8Array(an.fftSize); an.getByteTimeDomainData(bb);
        for (i = 0; i < bb.length; i++) { var u = (bb[i] - 128) / 128; sum += u * u; }
      }
      var rms = Math.sqrt(sum / buf.length);
      x = clamp((20 * Math.log10(rms + 1e-9) + 48) / 40, 0, 1);
    }
    var k = 1 - Math.exp(-dt / (x > R.lvl ? 0.04 : 0.16));
    R.lvl += (x - R.lvl) * k;
    return R.lvl;
  }

  /* ---- be polite in background tabs */
  try {
    document.addEventListener('visibilitychange', function () {
      if (!R.ctx) return;
      if (document.hidden) {
        if (R.playing) {
          R.hiddenPaused = true;
          try { var p = R.ctx.suspend(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
          if (R.el) { try { R.el.pause(); } catch (e) {} }
        }
      } else if (R.hiddenPaused) {
        R.hiddenPaused = false;
        if (R.playing) {
          try { var q = R.ctx.resume(); if (q && q.catch) q.catch(function () {}); } catch (e) {}
          if (R.mode === 'file') playEl();
        }
      }
    });
  } catch (e) {}

  /* ==================================================================
     OFFLINE RENDER (tests): same Engine, every event scheduled up front
     ================================================================== */
  function renderOffline(seconds, intensityOrFn, opts) {
    opts = opts || {};
    if (!OAC) return Promise.reject(new Error('OfflineAudioContext is not supported'));
    seconds = Math.max(0.1, +seconds || 1);
    var sr = 44100, ctx;
    try { ctx = new OAC(2, Math.ceil(seconds * sr), sr); } catch (e) { return Promise.reject(e); }
    var fn = typeof intensityOrFn === 'function'
      ? function (t) { return clamp(+intensityOrFn(t) || 0, 0, 1); }
      : (function (v) { return function () { return v; }; })(clamp(+intensityOrFn || 0, 0, 1));
    var eng;
    try {
      eng = new Engine(ctx, { intensity: fn, volume: opts.volume != null ? clamp(+opts.volume, 0, 1) : R.volume, fade: 1, noDrums: opts.noDrums, raw: opts.raw });
      if (opts.solo && opts.solo.length) {
        for (var nm in eng.stems) if (opts.solo.indexOf(nm) < 0) eng.stems[nm].gain.value = 0;
        if (opts.solo.indexOf('fx') < 0) eng.boomBus.gain.value = 0;
      }
      eng.begin(opts.startAt != null ? +opts.startAt : 0.02);
      if (opts.swellAt != null) eng.planSwell(+opts.swellAt);
      eng.scheduleRange(0, seconds);
    } catch (e) { return Promise.reject(e); }
    return new Promise(function (resolve, reject) {
      ctx.oncomplete = function (ev) { resolve(ev.renderedBuffer); };
      try {
        var p = ctx.startRendering();
        if (p && p.then) p.then(resolve, reject);
      } catch (e) { reject(e); }
    });
  }

  var API = {
    start: start,
    stop: stop,
    setIntensity: setIntensity,
    setDuck: setDuck,
    setVolume: setVolume,
    swell: swell,
    useFile: useFile,
    level: level,
    renderOffline: renderOffline,
    version: '1.0.0',
    _debug: function () {
      var e = R.eng;
      return {
        state: R.ctx ? R.ctx.state : 'none', time: R.ctx ? R.ctx.currentTime : 0,
        step: e ? e.step : 0, chord: e && e.chord >= 0 ? CHORDS[e.chord].name : '',
        intensity: R.ctx ? intensityAt(R.ctx.currentTime) : R.target, mode: R.mode,
        voices: e ? e.voices.length : 0, gates: e ? JSON.parse(JSON.stringify(e.gate)) : {},
        duck: e ? e.duck.gain.value : 1, fade: e ? e.fade.gain.value : 0, playing: R.playing
      };
    }
  };
  Object.defineProperty(API, 'isPlaying', { get: function () { return R.playing; }, enumerable: true });
  W.PixelMusic = API;
})();
