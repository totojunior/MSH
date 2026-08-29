/* ============================================================================
   MODULE: audio  --  "TROLLEY" procedural sound engine.
   DECLARES EXACTLY ONE GLOBAL:  SFX
   No external assets. No file loading. ONE AudioContext. Everything synthesised.
   Every public method is a silent no-op until unlock() succeeds, and never throws.
   ============================================================================ */
var SFX = (function () {
  'use strict';

  var api = {};
  api.ready = false;

  /* ------------------------------------------------------------------ state */
  var ctx = null;              /* the ONE AudioContext for the page life       */
  var built = false;           /* graph constructed                            */
  var dead = false;            /* audio permanently unavailable                */
  var unlockP = null;          /* memoised unlock promise (nulled on failure)  */
  var polling = false;

  var BUF_W = null, BUF_P = null, BUF_B = null;   /* white / pink / brown      */

  /* master chain */
  var preGain, masterHP, comp, makeup, limiter, softClip, masterGain, outGain;
  /* buses */
  var sfxBus, musicBus, ambBus, rumbleBus;
  /* bass reinforcement (always on) */
  var subBus, subLP, subGain, harmLP, harmWS, harmHP, harmBP, harmGain;
  /* reverb send */
  var revSend, revPre, conv, revWet;
  /* ambience narrowing chain */
  var ambLP, ambSend, clackBus, clackWet, clackDry;

  /* rumble graph */
  var rumBrownSrc, rumLP, rumShelf, rumPinkSrc, rumPinkBP, rumPinkG,
      rumSub1, rumSub2, rumSub3, rumSubG1, rumSubG2, rumSubG3, rumSubLP,
      rumWhineOsc, rumWhineBP, rumWhineG,
      rumMix, rumTrem, rumGain, rumAmb, rumSubTap,
      rumLfoA, rumLfoAG, rumLfoB, rumLfoBG;

  /* wind graph */
  var wPinkSrc, wPinkBP, wPinkG, wBrownSrc, wBrownLP, wBrownG,
      wWhiteSrc, wWhiteHP, wWhiteG,
      wMix, wTrem, windGain, windAmb, windPan,
      wL1, wL1G, wL2, wL2G, wRnd, wRndLP, wRndG, wQL, wQLG,
      wGust, wGustG, wGust2, wGust2LP, wGust2G;

  /* drone / riser graph */
  var drMix, drLP, drTrem, drGain, drOscs = [], drPulse, drPulseG,
      drNoiseSrc, drNoiseBP, drNoiseG,
      shepOscs = [], shepGains = [], shepMix;

  /* heartbeat */
  var hbGain, hbDry;

  /* runtime scalars */
  var userVol = 1.0, muted = false, tiny = false;
  var speed = 0, tension = 0;
  var ambKind = 'none';
  var clackOn = false;
  var hbOn = false, hbNext = 0;
  var clackNext = 0;
  var riserActive = false, riserEnd = 0;
  var lastSpeedApply = -1, lastSweep = -1;
  var schedTimer = 0;
  var intentionalSuspend = false;
  var gestureArmed = false;
  var silenceEnd = -1;
  var screechEnd = -1;
  var dopplerEnd = -1;

  /* one-shot voice bookkeeping */
  var live = [];               /* {n:[nodes], g:gainOrNull, t:endTime}          */
  var liveNodes = 0;
  var MAX_NODES = 460;         /* soft budget; impact deliberately bypasses     */
  var MAX_VOICES = 200;

  /* cached waveshaper curves */
  var CURVE = {};

  /* Rail-joint geometry, hoisted to module scope: schedTick() runs 40x a
     second and must not allocate, and doppler() rebuilt the same two arrays
     up to 200 times per call. AXLE holds the four axles of a two-bogie
     vehicle as an offset in metres from the leading axle. RAIL_LEN must be
     comfortably LONGER than the 11.6 m wheelbase or the trailing axle and the
     next joint's leading axle collapse into one flam -- see schedTick(). */
  var RAIL_LEN = 18.29;                     /* 60 ft standard jointed rail    */
  var AXLE     = [0, 2.6, 9.0, 11.6];       /* axle gap 2.6 m, bogie gap 9 m  */
  var AXLE_LVL = [1.0, 0.92, 0.75, 0.60];

  /* ------------------------------------------------------------------ utils */
  function ok() { return !!(ctx && built && !dead); }
  function T() { return ctx ? ctx.currentTime : 0; }

  function clamp(v, a, b) { v = +v; if (!isFinite(v)) return a; return v < a ? a : (v > b ? b : v); }
  function fin(v, d) { v = +v; return isFinite(v) ? v : d; }

  /* Math.tanh exists everywhere we target, but never assume */
  function th_(x) {
    if (x > 20) return 1; if (x < -20) return -1;
    if (Math.tanh) return Math.tanh(x);
    var e = Math.exp(2 * x); return (e - 1) / (e + 1);
  }

  function tanhCurve(k, n) {
    n = n || 4096;
    var key = 'T' + k + '_' + n;
    if (CURVE[key]) return CURVE[key];
    var c = new Float32Array(n), d = th_(k) || 1, i, x;
    for (i = 0; i < n; i++) { x = i * 2 / (n - 1) - 1; c[i] = th_(k * x) / d; }
    CURVE[key] = c; return c;
  }
  function harmonicCurve() {
    if (CURVE.HARM) return CURVE.HARM;
    var n = 4096, c = new Float32Array(n), i, x;
    for (i = 0; i < n; i++) {
      x = i * 2 / (n - 1) - 1;
      c[i] = 0.60 * th_(3.0 * x) + 0.40 * (x * x * (x < 0 ? -1 : 1));
    }
    CURVE.HARM = c; return c;
  }
  function clipCurve() {
    if (CURVE.CLIP) return CURVE.CLIP;
    /* A mastering safety clipper must have UNITY slope at the origin. The old
       curve was th_(1.6x)/th_(1.6)*0.98: slope 1.6/0.921669*0.98 = 1.7013 at
       zero, so the FINAL stage of the master bus put +4.60 dB of gain and
       progressive saturation on the ENTIRE mix, ambience bed included.
       Measured gain through the old curve: x=0.05 -> +4.60 dB, x=0.25 ->
       +4.17 dB, x=0.50 -> +3.00 dB, x=0.70 -> +1.77 dB. That 2.8 dB of
       level-dependent gain IS harmonic distortion on every quiet bed in the
       lesson.
       New curve: exactly linear (0.00 dB, bit-transparent) below |x| = 0.70
       (-3.1 dBFS), tanh knee above it. Endpoint y(1) = 0.70 + 0.64*th_(0.46875)
       = 0.9798, and because WaveShaper clamps its input to [-1,1] and reads
       the endpoint, that is a HARD absolute ceiling (-0.18 dBFS) however far
       the limiter overshoots. Old endpoint was 0.9800: same ceiling.
       n is ODD so x = 0 lands exactly on sample 4096: no DC offset. */
    var n = 8193, c = new Float32Array(n), TH = 0.70, A = 0.64, i, x, ax, y;
    for (i = 0; i < n; i++) {
      x = i * 2 / (n - 1) - 1;
      ax = x < 0 ? -x : x;
      y = (ax <= TH) ? ax : (TH + A * th_((ax - TH) / A));
      c[i] = x < 0 ? -y : y;
    }
    CURVE.CLIP = c; return c;
  }

  function G(v) { var g = ctx.createGain(); g.gain.value = (v === undefined ? 1 : v); return g; }
  function BQ(type, f, q) {
    var b = ctx.createBiquadFilter(); b.type = type;
    b.frequency.value = clamp(f, 0.05, ctx.sampleRate * 0.48);
    if (q !== undefined) b.Q.value = q; return b;
  }
  function WS(curve, over) {
    var w = ctx.createWaveShaper(); w.curve = curve;
    try { w.oversample = over || '2x'; } catch (e) {}
    return w;
  }
  function PAN(v) {
    if (!ctx.createStereoPanner) return null;
    var p;
    try { p = ctx.createStereoPanner(); } catch (e) { return null; }
    v = +v; if (!isFinite(v)) v = 0;
    p.pan.value = v < -1 ? -1 : (v > 1 ? 1 : v);
    return p;
  }
  function OSC(type, f, t) {
    var o = ctx.createOscillator();
    try { o.type = type; } catch (e) { try { o.type = 'sine'; } catch (e2) {} }
    try { o.frequency.setValueAtTime(clamp(f, 0.01, ctx.sampleRate * 0.45), t); } catch (e) {}
    return o;
  }
  /* a one-shot slice of a shared noise buffer -- never allocates a buffer */
  function NZ(buf, t, dur, rate) {
    var s = ctx.createBufferSource();
    s.buffer = buf;
    if (rate) { try { s.playbackRate.value = rate; } catch (e) {} }
    var d = clamp(dur, 0.005, Math.max(0.01, buf.duration - 0.05));
    var maxOff = buf.duration - d - 0.02;
    if (!(maxOff > 0)) maxOff = 0;
    try { s.start(t, Math.random() * maxOff, d); } catch (e) { try { s.start(t); } catch (e2) {} }
    try { s.stop(t + d + 0.05); } catch (e) {}
    return s;
  }
  function NZLOOP(buf, t, endT, rate) {
    var s = ctx.createBufferSource();
    s.buffer = buf; s.loop = true;
    if (rate) { try { s.playbackRate.value = rate; } catch (e) {} }
    try { s.start(t, Math.random() * Math.max(0.001, buf.duration - 0.5)); }
    catch (e) { try { s.start(t); } catch (e2) {} }
    try { s.stop(endT); } catch (e) {}
    return s;
  }

  /* click-free absolute ramp with an explicit anchor */
  function ramp(p, v, dur, when) {
    if (!p) return;
    var now = (when === undefined) ? T() : when;
    try {
      if (p.cancelAndHoldAtTime) { try { p.cancelAndHoldAtTime(now); } catch (e) { p.cancelScheduledValues(now); } }
      else p.cancelScheduledValues(now);
      p.setValueAtTime(fin(p.value, 0.0001), now);
      p.linearRampToValueAtTime(fin(v, 0.0001), now + Math.max(0.005, dur));
    } catch (e) {}
  }
  function cancelParam(p, hold) {
    if (!p) return;
    var now = T();
    try {
      if (p.cancelAndHoldAtTime) { try { p.cancelAndHoldAtTime(now); } catch (e) { p.cancelScheduledValues(now); } }
      else p.cancelScheduledValues(now);
      if (hold !== false) p.setValueAtTime(fin(p.value, 0), now);
    } catch (e) {}
  }
  function tgt(p, v, tau) {
    if (!p) return;
    try { p.setTargetAtTime(fin(v, 0.0001), T(), Math.max(0.005, tau)); } catch (e) {}
  }
  /* attack / exponential-decay envelope on a gain node */
  function env(g, t, peak, atk, dec) {
    if (!g) return;
    var p = g.gain;
    var a = Math.max(0.0008, fin(atk, 0.003));
    var d = Math.max(0.01, fin(dec, 0.05));
    try {
      p.setValueAtTime(0.0001, t);
      p.linearRampToValueAtTime(Math.max(0.0002, fin(peak, 0.1)), t + a);
      p.exponentialRampToValueAtTime(0.0001, t + a + d);
    } catch (e) {}
  }
  /* register a finished voice for disconnection */
  function reap(nodes, endTime, gainNode) {
    if (!nodes || !nodes.length) return;
    liveNodes += nodes.length;
    live.push({ n: nodes, g: gainNode || null, t: endTime + 0.08 });
    if (live.length > 600) sweep();          /* pathological guard */
  }
  function sweep() {
    var now = T(), i, j, a;
    for (i = live.length - 1; i >= 0; i--) {
      if (live[i].t < now) {
        a = live[i].n;
        for (j = 0; j < a.length; j++) { try { a[j].disconnect(); } catch (e) {} }
        liveNodes -= a.length;
        live.splice(i, 1);
      }
    }
    if (liveNodes < 0) liveNodes = 0;
  }
  function busy() { return liveNodes > MAX_NODES || live.length > MAX_VOICES; }

  /* A short duck of one bus. NEVER reads p.value as the base -- a second duck
     landing mid-ramp would otherwise ratchet the bus down permanently. */
  function duck(g, base, amt, down, hold, up) {
    if (!g) return;
    var p = g.gain, now = T(), lo = Math.max(0.0001, base * amt);
    try {
      if (p.cancelAndHoldAtTime) { try { p.cancelAndHoldAtTime(now); } catch (e) { p.cancelScheduledValues(now); } }
      else p.cancelScheduledValues(now);
      p.setValueAtTime(fin(p.value, base), now);
      p.linearRampToValueAtTime(lo, now + down);
      p.setValueAtTime(lo, now + down + hold);
      p.linearRampToValueAtTime(base, now + down + hold + up);
    } catch (e) {}
  }

  /* --------------------------------------------------------- noise buffers */
  function mkNoise(secs, type) {
    var n = Math.floor(ctx.sampleRate * secs);
    var b = ctx.createBuffer(1, n, ctx.sampleRate);
    var d = b.getChannelData(0), i, w;
    if (type === 'white') {
      for (i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    } else if (type === 'pink') {
      var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (i = 0; i < n; i++) {
        w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.0168980;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
    } else {
      var last = 0;
      for (i = 0; i < n; i++) { w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
      /* strip the DC wander -- brown noise is used as a modulation source and a
         standing offset would permanently bias every filter it drives */
      var mean = 0;
      for (i = 0; i < n; i++) mean += d[i];
      mean /= n;
      for (i = 0; i < n; i++) d[i] -= mean;
    }
    return b;
  }

  /* ------------------------------------------------------------- tunnel IR */
  function makeTunnelIR() {
    var sr = ctx.sampleRate, len = Math.floor(sr * 2.2);
    var ir = ctx.createBuffer(2, len, sr);
    var er = [[11, 0.42], [19, 0.31], [27, 0.24], [38, 0.18], [52, 0.13], [71, 0.09]];
    var coef = 1 - Math.exp(-2 * Math.PI * 2600 / sr);
    var TAU = Math.PI * 2;
    for (var ch = 0; ch < 2; ch++) {
      var d = ir.getChannelData(ch), lp = 0, skew = ch ? 1.07 : 0.93, i, t, e, nz;
      for (i = 0; i < len; i++) {
        t = i / sr;
        e = Math.pow(1 - i / len, 2.6) * Math.exp(-t * 2.1);
        nz = (Math.random() * 2 - 1) * e;
        lp += (nz - lp) * coef;
        d[i] = lp + Math.sin(TAU * 92 * t) * e * 0.05;
      }
      for (var k = 0; k < er.length; k++) {
        var idx = Math.floor(er[k][0] * skew * sr / 1000);
        if (idx > 0 && idx < len - 64) {
          for (var j = 0; j < 64; j++) d[idx + j] += (Math.random() * 2 - 1) * er[k][1] * (1 - j / 64);
        }
      }
      d[0] = 0;   /* no direct impulse -- the dry path supplies that */
    }
    return ir;
  }

  /* ------------------------------------------------------------ master bus */
  function buildMaster() {
    outGain = G(muted ? 0.0001 : Math.max(0.0001, userVol));
    masterGain = G(1.0);                       /* reserved for silence() only  */
    softClip = WS(clipCurve(), '2x');

    /* Brickwall. 0.6 ms attack so impact()'s 0.8 ms crack is caught almost at
       once; 110 ms release so it recovers between debris hits instead of
       breathing. Threshold -1.5 (was -3): softClip no longer supplies the
       +1.8 dB of make-up it used to smuggle in at this level, so with -3 the
       whole chain topped out 1.35 dB quieter than the build it replaces --
       audible loss on a projector speaker. -1.5 restores the old ceiling
       exactly (limiter out 0.899 -> softClip 0.893 = -0.98 dBFS, against the
       old chain's -0.98 dBFS), and anything past it lands in softClip's tanh
       knee, which is what a limiter/clipper pair is for. */
    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1.5; limiter.knee.value = 0; limiter.ratio.value = 20;
    limiter.attack.value = 0.0006; limiter.release.value = 0.11;

    /* 3.2, not 1.9. softClip used to contribute +4.60 dB at the origin; that
       parasitic gain is gone, and this replaces it CLEANLY. Derived, not
       guessed -- static-curve level through the whole chain, new vs old:
         preGain out  -40 -34 -30 -26 -22 -19 -16.5 -13 -10.5  -8  -6  -3   0
         delta (dB) -0.08 -.08 -.06 -.02 -.19 -.45 -.42 0.00 +.46 +.92 +1.3 +1.9 +2.5
       i.e. the bed sits within half a dB of the build everyone has already
       signed off, and every dB of the removed saturation comes back as
       HEADROOM for the loud moments instead. (At makeup 2.4 the entire mix,
       bed included, would have dropped 2.0-2.9 dB.) */
    makeup = G(3.2);

    /* Glue, NOT a transient catcher. The old 4 ms attack clamped down on the
       impact crack and the 180 ms release pumped audibly after every rail
       clack. 10 ms attack deliberately lets transients past (the limiter owns
       peaks); 300 ms release rides the rumble bed instead of chewing it.
       -20 / 2.5:1 / 10 dB knee is very close to the old curve's gain
       reduction at bed level (5.7 dB vs 5.6 dB at -10.5 dBFS in) but 1.0 dB
       less at -3 dBFS in, so loud-to-quiet range widens by ~1.3 dB. */
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20; comp.knee.value = 10; comp.ratio.value = 2.5;
    comp.attack.value = 0.010; comp.release.value = 0.30;

    preGain = G(0.85);                         /* scene ducking lives here     */

    /* Subsonic guard, at the HEAD of the chain. impact()'s mass layers sweep
       to 25 Hz, the boom sits at 40 Hz, and the rumble bed is brown noise
       through a 55 Hz lowpass with NO highpass at all -- so there is a large,
       permanent pile of sub-20 Hz energy in this mix. On a Chromebook driver
       or a ceiling projector speaker that is 100% inaudible and 100% limiter
       gain-reduction: it ducks the whole mix and eats the crack that is doing
       the actual work. 22 Hz, Q 0.707 = Butterworth, maximally flat, no
       resonant bump right where the mass thud lives. Computed |H| for a
       2nd-order Butterworth HP, r = f/22, |H| = r^2/sqrt(1+r^4):
       -7.5 dB at 15 Hz, -4.47 at 19, -2.04 at 25, -0.38 at 40, -0.08 at 60.
       The felt weight survives; only what no speaker in a school could ever
       reproduce is removed. One BiquadFilter is the only DSP node this whole
       audit adds. */
    masterHP = BQ('highpass', 22, 0.707);

    preGain.connect(masterHP); masterHP.connect(comp); comp.connect(makeup); makeup.connect(limiter);
    limiter.connect(softClip); softClip.connect(masterGain);
    masterGain.connect(outGain); outGain.connect(ctx.destination);

    sfxBus = G(1.0); musicBus = G(0.75); ambBus = G(1.0); rumbleBus = G(1.0);
    sfxBus.connect(preGain); musicBus.connect(preGain);
    ambBus.connect(preGain); rumbleBus.connect(preGain);

    /* ---- always-on bass reinforcement for tinny Chromebook speakers ----
       A 45 Hz thump is inaudible on a 1 cm driver but still eats limiter
       headroom. The parallel branch throws away the fundamental and spends
       the energy at 90/135/180/225 Hz, where the speaker actually moves air. */
    subBus = G(1.0);
    subLP = BQ('lowpass', 120, 0.7); subGain = G(tiny ? 0.55 : 0.90);
    subBus.connect(subLP); subLP.connect(subGain); subGain.connect(sfxBus);

    /* The synthesised harmonics have to land where the speaker actually
       radiates. A 2019 Chromebook driver is ~40 mm and 15-20 dB down by
       200 Hz; a ceiling-mounted classroom projector speaker is worse.
       130 Hz feed LP (was 110) so impact()'s 90-130 Hz mass drives the shaper
       and not just the 41 Hz drone; 175 Hz HP to strip the fundamental the
       speaker cannot reproduce anyway; 380 Hz / Q 1.0 has -3 dB edges at
       380*(sqrt(1+1/4Q^2) -/+ 1/2Q) = 235 and 615 Hz, i.e. the 3rd/5th/7th of
       a 45-90 Hz thud land squarely in 250-650 Hz, which every speaker in a
       school reproduces. (Old 300 Hz / Q 0.8 spanned 167-542 Hz, a third of
       it below what the driver moves.) */
    harmLP = BQ('lowpass', 130, 0.7);
    harmWS = WS(harmonicCurve(), '2x');
    harmHP = BQ('highpass', 175, 0.7);
    harmBP = BQ('bandpass', 380, 1.0);
    /* grep confirms setTinySpeaker() is never called anywhere in the build, so
       the 'else' branch is the only one that ever runs -- and the default
       deployment IS a tinny speaker. 0.55 -> 0.72. */
    harmGain = G(tiny ? 0.95 : 0.72);
    subBus.connect(harmLP); harmLP.connect(harmWS); harmWS.connect(harmHP);
    harmHP.connect(harmBP); harmBP.connect(harmGain); harmGain.connect(sfxBus);

    /* ---- one shared convolver, procedurally generated tunnel tail ---- */
    revSend = G(1.0);
    revPre = ctx.createDelay(0.2); revPre.delayTime.value = 0.012;
    try { conv = ctx.createConvolver(); conv.normalize = true; } catch (e) { conv = null; }
    revWet = G(0.24);
    if (conv) {
      try { conv.buffer = makeTunnelIR(); } catch (e) { conv = null; }
    }
    if (conv) {
      revSend.connect(revPre); revPre.connect(conv); conv.connect(revWet);
      revWet.connect(preGain);
    }

    /* ---- ambience narrowing chain: tension closes the world down ---- */
    ambLP = BQ('lowpass', 18000, 0.7);
    ambLP.connect(ambBus);
    ambSend = G(0.10); ambLP.connect(ambSend); ambSend.connect(revSend);

    /* rail clacks: mostly inside the narrowing world, a little dry on top so
       they never disappear entirely when the lowpass closes */
    clackBus = G(1.0);
    clackWet = G(0.80); clackBus.connect(clackWet); clackWet.connect(ambLP);
    clackDry = G(0.32); clackBus.connect(clackDry); clackDry.connect(sfxBus);
  }

  /* ------------------------------------------------------- rumble (SCENE A) */
  function buildRumble() {
    var t = T();
    /* mix -> trem (LFO, base 1.0) -> gain (speed) -> amb (scene) -> ambLP
       The LFOs modulate a UNITY node, never the level node: summing an LFO
       into a level param that idles at 0.0001 drives the gain through zero
       and phase-flips the whole rumble. */
    rumMix  = G(1.0);
    rumTrem = G(1.0);
    rumGain = G(0.0001);
    rumAmb  = G(0.0001);
    rumMix.connect(rumTrem); rumTrem.connect(rumGain); rumGain.connect(rumAmb);
    rumAmb.connect(ambLP);
    rumAmb.connect(rumbleBus);
    rumSubTap = G(0.45); rumAmb.connect(rumSubTap); rumSubTap.connect(subBus);

    rumBrownSrc = ctx.createBufferSource();
    rumBrownSrc.buffer = BUF_B; rumBrownSrc.loop = true;
    rumBrownSrc.playbackRate.value = 0.80;
    rumLP = BQ('lowpass', 55, 0.7);
    rumShelf = BQ('lowshelf', 80); rumShelf.gain.value = 6;
    rumBrownSrc.connect(rumLP); rumLP.connect(rumShelf); rumShelf.connect(rumMix);

    rumPinkSrc = ctx.createBufferSource();
    rumPinkSrc.buffer = BUF_P; rumPinkSrc.loop = true;
    /* 4.3 / 0.87 = 4.94 s loop, against the brown bed's 6.7 / (0.80..1.30) =
       5.15..8.38 s -- and that one is speed-modulated by applySpeed() so it
       never sits still. Nothing in the rumble now repeats on a period the ear
       can latch on to. */
    rumPinkSrc.playbackRate.value = 0.87;
    rumPinkBP = BQ('bandpass', 190, 1.1); rumPinkG = G(0.12);
    rumPinkSrc.connect(rumPinkBP); rumPinkBP.connect(rumPinkG); rumPinkG.connect(rumMix);

    /* 27.5 : 41.0 : 55.0 = 1 : 1.49 : 2.0 -- deliberately not a chord.
       The ear reads mass, not pitch. */
    rumSubLP = BQ('lowpass', 140, 0.8);
    rumSub1 = OSC('sine', 27.5, t); rumSubG1 = G(0.38);
    rumSub2 = OSC('sine', 41.0, t); rumSubG2 = G(0.24);
    rumSub3 = OSC('triangle', 55.0, t); rumSubG3 = G(0.14);
    try { rumSub3.detune.value = 7; } catch (e) {}
    rumSub1.connect(rumSubG1); rumSub2.connect(rumSubG2); rumSub3.connect(rumSubG3);
    rumSubG1.connect(rumSubLP); rumSubG2.connect(rumSubLP); rumSubG3.connect(rumSubLP);
    rumSubLP.connect(rumMix);

    rumWhineOsc = OSC('sawtooth', 176, t);
    rumWhineBP = BQ('bandpass', 1100, 6); rumWhineG = G(0.0001);
    rumWhineOsc.connect(rumWhineBP); rumWhineBP.connect(rumWhineG); rumWhineG.connect(rumMix);

    /* breathing (0.7 Hz) + bogie chatter (3.1 Hz) into the UNITY trem node */
    rumLfoA = OSC('sine', 0.7, t); rumLfoAG = G(0.09);
    rumLfoB = OSC('sine', 3.1, t); rumLfoBG = G(0.05);
    rumLfoA.connect(rumLfoAG); rumLfoAG.connect(rumTrem.gain);
    rumLfoB.connect(rumLfoBG); rumLfoBG.connect(rumTrem.gain);

    rumBrownSrc.start(t); rumPinkSrc.start(t);
    rumSub1.start(t); rumSub2.start(t); rumSub3.start(t);
    rumWhineOsc.start(t); rumLfoA.start(t); rumLfoB.start(t);
  }

  /* ---------------------------------------------------------- wind (BRIDGE) */
  function buildWind() {
    var t = T();
    wMix    = G(1.0);
    wTrem   = G(1.0);            /* gusts modulate THIS, base 1.0              */
    windGain = G(0.55);          /* fixed body level                            */
    windAmb  = G(0.0001);        /* scene level                                 */
    windPan  = PAN(0);
    wMix.connect(wTrem); wTrem.connect(windGain); windGain.connect(windAmb);
    if (windPan) { windAmb.connect(windPan); windPan.connect(ambLP); }
    else windAmb.connect(ambLP);

    /* Loop periods 4.3/0.71 = 6.06 s, 6.7/0.63 = 10.63 s, 3.1/1.13 = 2.74 s.
       Mutually incommensurate, so the three layers never re-align and the
       bridge bed -- the longest and most exposed beat in the lesson -- never
       repeats audibly. All three ran at 1.0 before.
       Slowing the brown layer also pushes more of its energy below 20 Hz;
       the new 22 Hz Butterworth on the master bus takes care of that. */
    wPinkSrc = ctx.createBufferSource(); wPinkSrc.buffer = BUF_P; wPinkSrc.loop = true;
    wPinkSrc.playbackRate.value = 0.71;
    wPinkBP = BQ('bandpass', 500, 1.6); wPinkG = G(0.30);
    wPinkSrc.connect(wPinkBP); wPinkBP.connect(wPinkG); wPinkG.connect(wMix);

    wBrownSrc = ctx.createBufferSource(); wBrownSrc.buffer = BUF_B; wBrownSrc.loop = true;
    wBrownSrc.playbackRate.value = 0.63;
    wBrownLP = BQ('lowpass', 900, 0.7); wBrownG = G(0.18);
    wBrownSrc.connect(wBrownLP); wBrownLP.connect(wBrownG); wBrownG.connect(wMix);

    wWhiteSrc = ctx.createBufferSource(); wWhiteSrc.buffer = BUF_W; wWhiteSrc.loop = true;
    wWhiteSrc.playbackRate.value = 1.13;
    wWhiteHP = BQ('highpass', 3000, 0.7); wWhiteG = G(0.05);
    wWhiteSrc.connect(wWhiteHP); wWhiteHP.connect(wWhiteG); wWhiteG.connect(wMix);

    /* three incommensurate LFOs + a true random walk -> never repeats */
    wL1 = OSC('sine', 0.070, t); wL1G = G(180);
    wL2 = OSC('sine', 0.230, t); wL2G = G(70);
    wL1.connect(wL1G); wL1G.connect(wPinkBP.frequency);
    wL2.connect(wL2G); wL2G.connect(wPinkBP.frequency);
    wRnd = ctx.createBufferSource(); wRnd.buffer = BUF_B; wRnd.loop = true;
    wRnd.playbackRate.value = 0.01;
    wRndLP = BQ('lowpass', 0.6, 0.7); wRndG = G(140);
    wRnd.connect(wRndLP); wRndLP.connect(wRndG); wRndG.connect(wPinkBP.frequency);

    wQL = OSC('sine', 0.041, t); wQLG = G(0.5);
    wQL.connect(wQLG); wQLG.connect(wPinkBP.Q);

    wGust = OSC('sine', 0.11, t); wGustG = G(0.35);
    wGust.connect(wGustG); wGustG.connect(wTrem.gain);
    wGust2 = ctx.createBufferSource(); wGust2.buffer = BUF_B; wGust2.loop = true;
    wGust2.playbackRate.value = 0.005;
    wGust2LP = BQ('lowpass', 0.5, 0.7); wGust2G = G(0.20);
    wGust2.connect(wGust2LP); wGust2LP.connect(wGust2G); wGust2G.connect(wTrem.gain);

    wPinkSrc.start(t); wBrownSrc.start(t); wWhiteSrc.start(t);
    wL1.start(t); wL2.start(t); wRnd.start(t); wQL.start(t);
    wGust.start(t); wGust2.start(t);
  }

  /* ------------------------------------------------------- drone / riser bed */
  function buildDrone() {
    var t = T();
    drMix  = G(1.0);
    drLP   = BQ('lowpass', 260, 3);
    drTrem = G(1.0);              /* pulse LFO modulates THIS, base 1.0        */
    drGain = G(0.0001);           /* level                                      */
    drMix.connect(drLP); drLP.connect(drTrem); drTrem.connect(drGain);
    drGain.connect(musicBus);
    var ds = G(0.22); drGain.connect(ds); ds.connect(revSend);

    function addDr(type, f, det, g) {
      var o = OSC(type, f, t);
      try { o.detune.value = det; } catch (e) {}
      var gg = G(g); o.connect(gg); gg.connect(drMix); o.start(t);
      drOscs.push(o); return o;
    }
    /* E1 pair 18 cents apart -> 0.43 Hz beat, slow unease.
       58.3 Hz sits a tritone under the B: dread, for free. */
    addDr('sine', 41.2, 9, 0.30);
    addDr('sine', 41.2, -9, 0.30);
    addDr('sine', 61.7, 0, 0.18);
    addDr('sawtooth', 82.4, 0, 0.10);
    addDr('sine', 58.3, 0, 0.10);

    drPulse = OSC('sine', 1.2, t); drPulseG = G(0.0001);
    drPulse.connect(drPulseG); drPulseG.connect(drTrem.gain); drPulse.start(t);

    drNoiseSrc = ctx.createBufferSource(); drNoiseSrc.buffer = BUF_P; drNoiseSrc.loop = true;
    drNoiseBP = BQ('bandpass', 400, 2.5); drNoiseG = G(0.0001);
    drNoiseSrc.connect(drNoiseBP); drNoiseBP.connect(drNoiseG); drNoiseG.connect(musicBus);
    drNoiseSrc.start(t);

    /* Shepard stack -- only audible during a riser. The three gains are
       windowed across the glide (low fades IN, high fades OUT) so the octave
       reset at the end of the ramp is inaudible. */
    shepMix = G(1.0); shepMix.connect(drLP);
    var sf = [41.2, 82.4, 164.8], i;
    for (i = 0; i < 3; i++) {
      var o = OSC('sawtooth', sf[i], t);
      var g = G(0.0001);
      o.connect(g); g.connect(shepMix); o.start(t);
      shepOscs.push(o); shepGains.push(g);
    }

    /* heartbeat sums into the sub bus so it survives a laptop speaker */
    hbGain = G(0.0001);
    hbGain.connect(subBus);
    hbDry = G(0.55); hbGain.connect(hbDry); hbDry.connect(sfxBus);
  }

  /* -------------------------------------------------------------- scheduler */
  function schedTick() {
    if (!ok()) return;
    if (ctx.state !== 'running') return;      /* frozen clock: schedule nothing */
    var now = T();
    if (lastSweep < 0 || now - lastSweep > 1.0 || now < lastSweep) { lastSweep = now; sweep(); }

    if (riserActive && now > riserEnd) { riserActive = false; applyTension(); }

    /* ---- heartbeat, 200 ms lookahead ---- */
    if (hbOn) {
      if (hbNext < now || hbNext > now + 4) hbNext = now + 0.06;
      var guard = 0;
      while (hbNext < now + 0.20 && guard++ < 8) {
        var bpm = 60 + 105 * Math.pow(tension, 1.35);
        var cyc = 60 / bpm;
        /* systole barely shortens; diastole absorbs the compression.
           That is real cardiac physiology and it is why a fast heart
           feels URGENT rather than merely fast. */
        /* Systole (S1 -> S2) does NOT scale with the cycle: it shortens as
           roughly 1/sqrt(rate) while diastole absorbs all the compression.
           0.300 s at 60 bpm, 0.209 s at 124 bpm, 0.181 s at 165 bpm, against
           a diastole collapsing 0.700 -> 0.183 s. 15.6/bpm made systole scale
           LINEARLY with cycle length and then hit a hard 0.10 s floor:
           measured 0.260 s at 60 bpm, 0.119 s at 131, 0.100 s at 165. At
           100 ms the dub is a flam on the lub, not a second heart sound --
           and the exact opposite of what the comment two lines up claims the
           code does. A wide lub-dub over a vanishing gap is precisely why a
           racing heart reads as URGENT rather than merely fast.
           The clamp is defensive only: over the real 60-165 bpm range the
           expression spans 0.181-0.300 and never touches either bound. */
        var gap = clamp(0.30 * Math.sqrt(60 / bpm), 0.17, 0.32);
        var amp = (0.55 + 0.55 * tension) * (0.94 + Math.random() * 0.12);
        if (tension > 0.7) hbThump(hbNext - 0.045, 70, amp * 0.15);
        hbThump(hbNext, 62, amp);
        hbThump(hbNext + gap, 74, amp * 0.62);
        hbNext += cyc * (0.985 + Math.random() * 0.03);
      }
    }

    /* ---- rail clacks, 200 ms lookahead ---- */
    if (clackOn && speed > 0.02) {
      var mph = 60 * speed;
      var v = Math.max(0.5, mph * 0.44704);
      if (v >= 1.5) {
        /* per = seconds between successive rail joints. The old guard threw
           the anchor back to now+0.05 whenever clackNext sat more than 4 s
           ahead -- but v = 26.82*speed, so below speed 0.112 the period IS
           more than 4 s (7.46 s at speed 0.06, 4.47 s at 0.10), and the clack
           bed opens at speed 0.056. Through the ENTIRE low-speed run-up the
           anchor was therefore reset forty times a second and a fresh
           four-axle burst scheduled each time: a machine-gun of clacks.
           The window has to scale with the period, not be a constant. It
           still self-corrects the other way -- when speed rises, per shrinks,
           clackNext falls outside now+per+1 and is re-anchored exactly once. */
        var per = RAIL_LEN / v;
        if (clackNext < now || clackNext > now + per + 1.0) clackNext = now + 0.05;
        var g2 = 0;
        while (clackNext < now + 0.20 && g2++ < 6) {
          var base = 0.30 * (0.45 + 0.55 * speed);
          /* 18.29 m of rail against an 11.6 m wheelbase leaves 6.69 m of plain
             rail between the trailing axle and the next joint: at 26.82 m/s
             that is 249 ms of silence against 97 ms inside each da-dum pair.
             THAT ratio is the rhythm. The old 12.0 m rail left 0.4 m = 15 ms,
             well under the ~30 ms at which two transients fuse, so the
             trailing axle and the next leading axle merged into a flam and the
             figure flattened into an even patter. */
          for (var i = 0; i < 4; i++) {
            if (Math.random() < 0.06) continue;                 /* worn joint  */
            var off = AXLE[i] / v;
            var lvl = base * AXLE_LVL[i] * (0.65 + Math.random() * 0.70);
            /* +/-1.5 ms of independent scatter per axle and +/-3% on the ring
               pitch: no two joints are struck on the same spacing or at the
               same pitch, so even at dead-constant speed the pattern cannot
               settle into something heard as a loop. */
            clack(clackNext + off + (Math.random() - 0.5) * 0.003, lvl,
                  0.97 + Math.random() * 0.06,
                  (i & 1) ? 0.32 : -0.30, 0.18, clackBus);
            if (Math.random() < 0.05) clack(clackNext + off + 0.021, lvl * 0.55, 1.0, 0.1, 0.14, clackBus);
          }
          clackNext += per * (0.94 + Math.random() * 0.12);
        }
      }
    }
  }

  function startScheduler() {
    if (schedTimer) return;
    try {
      schedTimer = setInterval(function () { try { schedTick(); } catch (e) {} }, 25);
    } catch (e) { schedTimer = 0; }
  }

  /* ------------------------------------------------------------- heartbeat */
  function hbThump(t, F, amp) {
    /* The heartbeat is the spine of both scenes and must NEVER be the layer
       that thins out under load -- the rail clacks are. At 165 bpm with the
       pre-thump active this is 8.25 thumps/s x 9 nodes = 74 nodes/s, live for
       0.63 s, so ~47 concurrent nodes: comfortably inside budget. It gets its
       own ceiling well above busy(). */
    if (!ok() || !isFinite(t) || t < T() - 0.05) return;
    if (liveNodes > MAX_NODES + 140 || live.length > MAX_VOICES + 60) return;
    var out = G(1.0); out.connect(hbGain);

    var o = OSC('sine', F, t);
    var lp = BQ('lowpass', 180, 1.2);
    var g = G(0.0001);
    /* the fast pitch drop is what makes it a THUMP and not a bass note */
    try { o.frequency.exponentialRampToValueAtTime(Math.max(20, F * 0.55), t + 0.09); } catch (e) {}
    o.connect(lp); lp.connect(g); g.connect(out);
    try {
      var p = g.gain;
      p.setValueAtTime(0.0001, t);
      p.linearRampToValueAtTime(Math.max(0.0002, amp), t + 0.006);
      p.exponentialRampToValueAtTime(0.0001, t + 0.16 + (F > 70 ? 0.12 : 0));
    } catch (e) {}
    o.start(t); o.stop(t + 0.42);

    /* 2nd harmonic: pure audibility insurance on a Chromebook speaker */
    var o2 = OSC('triangle', F * 2, t);
    var g2 = G(0.0001);
    o2.connect(g2); g2.connect(out);
    env(g2, t, 0.18 * amp, 0.005, 0.13);
    o2.start(t); o2.stop(t + 0.30);

    /* the wet/flesh component. Without it, this is a kick drum. */
    var n = NZ(BUF_W, t, 0.04);
    var nlp = BQ('lowpass', 220, 4);
    var ng = G(0.0001);
    n.connect(nlp); nlp.connect(ng); ng.connect(out);
    env(ng, t, 0.12 * amp, 0.002, 0.05);

    reap([o, lp, g, o2, g2, n, nlp, ng, out], t + 0.55, out);
  }

  /* ------------------------------------------------------------ rail clack */
  function clack(t, lvl, pmul, pan, send, dest) {
    if (!ok() || !isFinite(t) || busy()) return;
    pmul = pmul || 1;
    var fc = 2400 * (0.85 + Math.random() * 0.30) * pmul;
    var ringF = 1180 * (0.92 + Math.random() * 0.16) * pmul;

    var out = G(1.0);
    var target = dest || sfxBus;
    var pn = PAN(pan === undefined ? 0 : pan);
    if (pn) { out.connect(pn); pn.connect(target); } else out.connect(target);
    var nodes = [out]; if (pn) nodes.push(pn);
    if (send) { var sg = G(send); out.connect(sg); sg.connect(revSend); nodes.push(sg); }

    var n = NZ(BUF_W, t, 0.055);
    var hp = BQ('highpass', 800, 0.7);
    var bp = BQ('bandpass', clamp(fc, 200, 16000), 8);
    var gn = G(0.0001);
    n.connect(hp); hp.connect(bp); bp.connect(gn); gn.connect(out);
    try {
      var p = gn.gain;
      p.setValueAtTime(0.0001, t);
      p.linearRampToValueAtTime(Math.max(0.0002, lvl), t + 0.0015);
      p.exponentialRampToValueAtTime(0.0001, t + 0.055);
    } catch (e) {}
    nodes.push(n, hp, bp, gn);

    /* circular-plate modes 1 : 2.76 : 5.40 -- INHARMONIC, so it reads as
       struck steel and not as a pitched note */
    var rf = [ringF, ringF * 2.76, ringF * 5.40];
    var rg = [0.30, 0.18, 0.10], rd = [0.18, 0.10, 0.06];
    for (var i = 0; i < 3; i++) {
      if (rf[i] > ctx.sampleRate * 0.45) continue;
      var o = OSC('sine', rf[i], t);
      var g = G(0.0001);
      o.connect(g); g.connect(out);
      env(g, t, lvl * rg[i], 0.001, rd[i]);
      o.start(t); o.stop(t + rd[i] + 0.06);
      nodes.push(o, g);
    }
    reap(nodes, t + 0.32, out);
  }

  /* --------------------------------------------------- speed / tension maps */
  function applySpeed(force) {
    if (!ok()) return;
    var now = T();
    if (!force && lastSpeedApply >= 0 && now - lastSpeedApply < 0.05 && now >= lastSpeedApply) return;
    lastSpeedApply = now;
    var s = speed;
    /* s^1.6 keeps the low end from swamping the mix at mid speed; the cutoff
       rise is what the ear actually reads as "faster", more than the level. */
    tgt(rumGain.gain, 0.0001 + 0.55 * Math.pow(s, 1.6), 0.15);
    tgt(rumLP.frequency, 55 + 420 * s, 0.12);
    tgt(rumBrownSrc.playbackRate, 0.80 + 0.50 * s, 0.20);
    var det = -300 + 500 * s;
    tgt(rumSub1.detune, det, 0.20);
    tgt(rumSub2.detune, det, 0.20);
    tgt(rumSub3.detune, det + 7, 0.20);
    tgt(rumWhineG.gain, s > 0.45 ? 0.05 * (s - 0.45) / 0.55 : 0.0001, 0.25);
    tgt(rumWhineOsc.detune, det * 0.6, 0.25);
    tgt(rumPinkG.gain, 0.05 + 0.11 * s, 0.20);
    if (ambKind === 'cab') tgt(windAmb.gain, 0.10 + 0.45 * s, 0.25);
  }

  function applyTension() {
    if (!ok()) return;
    var x = tension;
    /* the world narrows: 18 kHz wide open -> 1.4 kHz at full dread */
    tgt(ambLP.frequency, 18000 - 16600 * Math.pow(x, 0.85), 0.35);
    if (!riserActive) {
      tgt(drGain.gain, 0.0001 + 0.16 * Math.pow(x, 1.3) + (ambKind === 'menu' ? 0.08 : 0), 0.5);
      tgt(drLP.frequency, 260 + 520 * x, 0.5);
      tgt(drPulseG.gain, 0.0001 + 0.05 * x, 0.5);
      tgt(drPulse.frequency, 1.0 + 3.0 * x, 0.6);
    }
  }

  /* the linkage giving up: scheduled on the AUDIO clock, never setTimeout */
  function clunkAt(t, level) {
    if (!ok() || !isFinite(t)) return;
    var lv = (level === undefined) ? 1 : level;
    var out = G(1.0); out.connect(sfxBus);
    var sd = G(0.10); out.connect(sd); sd.connect(revSend);

    var o = OSC('sine', 90, t);
    var g = G(0.0001);
    try { o.frequency.exponentialRampToValueAtTime(55, t + 0.12); } catch (e) {}
    o.connect(g); g.connect(out);
    var sub = G(0.6); g.connect(sub); sub.connect(subBus);
    env(g, t, 0.60 * lv, 0.003, 0.13);
    o.start(t); o.stop(t + 0.32);

    var n = NZ(BUF_W, t, 0.05);
    var bp = BQ('bandpass', 320, 2.2);
    var ng = G(0.0001);
    n.connect(bp); bp.connect(ng); ng.connect(out);
    env(ng, t, 0.34 * lv, 0.001, 0.05);

    /* one dead little latch tick, then nothing at all */
    var n2 = NZ(BUF_W, t + 0.085, 0.014);
    var bp2 = BQ('bandpass', 3100, 5);
    var ng2 = G(0.0001);
    n2.connect(bp2); bp2.connect(ng2); ng2.connect(out);
    env(ng2, t + 0.085, 0.10 * lv, 0.001, 0.02);

    reap([o, g, sub, n, bp, ng, n2, bp2, ng2, out, sd], t + 0.50, out);
  }

  /* ================================================================= PUBLIC */

  function applyPending() {
    try {
      ramp(outGain.gain, muted ? 0.0001 : Math.max(0.0001, userVol), 0.05);
      ramp(harmGain.gain, tiny ? 0.95 : 0.72, 0.05);
      ramp(subGain.gain, tiny ? 0.55 : 0.90, 0.05);
      applySpeed(true);
      api.ambience(ambKind);           /* also calls applyTension()            */
      if (hbOn) { hbNext = T() + 0.10; ramp(hbGain.gain, 1.0, 0.25); }
    } catch (e) {}
  }

  api.unlock = function () {
    if (dead) return Promise.resolve(false);

    /* The gesture work runs on EVERY call, not just the first: the first
       gesture can fail and a later one must still be able to rescue us. */
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { dead = true; return Promise.resolve(false); }
      if (!ctx) {
        try { ctx = new AC({ latencyHint: 'interactive' }); }
        catch (e) { try { ctx = new AC(); } catch (e2) { dead = true; return Promise.resolve(false); } }
      }
    } catch (e) { dead = true; return Promise.resolve(false); }

    /* iOS / old WebView: a source must actually START inside the gesture.
       Only while we are still locked, and DISCONNECTED on ended: the gesture
       safety net below calls unlock() from pointerdown AND touchend AND
       keydown AND click, up to 30 attempts, and the old code leaked one
       permanently-connected BufferSource on ctx.destination every time --
       before a single sound had played. */
    if (ctx.state !== 'running') {
      try {
        var b = ctx.createBuffer(1, 1, ctx.sampleRate), s = ctx.createBufferSource();
        s.buffer = b; s.connect(ctx.destination);
        s.onended = function () { try { s.disconnect(); } catch (e) {} };
        s.start(0); s.stop(ctx.currentTime + 0.001);
      } catch (e) {}
    }
    intentionalSuspend = false;
    try { var pr = ctx.resume(); if (pr && pr.catch) pr.catch(function () {}); } catch (e) {}

    if (!built) {
      try {
        /* These three are LOOPED under the wind and rumble beds for the whole
           lesson. A 2 s pink loop through a resonant bandpass is plainly
           audible as a repeating chuff -- six repeats across the 13 s
           approach alone, hundreds across the bridge scene. Lengthened, and
           given mutually irrational lengths (3.1 / 4.3 / 6.7 s) so that with
           the playback rates set below no two layers ever re-align.
           14.1 s of mono Float32 at 48 kHz = 2.71 MB, generated once, inside
           the unlock gesture (was 8.0 s / 1.54 MB). */
        BUF_W = mkNoise(3.1, 'white');
        BUF_P = mkNoise(4.3, 'pink');
        BUF_B = mkNoise(6.7, 'brown');
        buildMaster();
        buildRumble();
        buildWind();
        buildDrone();
        built = true;
        try {
          ctx.onstatechange = function () {
            try {
              if (!ctx) return;
              /* do NOT fight a deliberate suspend() */
              if (intentionalSuspend) return;
              if (ctx.state !== 'running') { var q = ctx.resume(); if (q && q.catch) q.catch(function () {}); }
              else { api.ready = true; }
            } catch (e) {}
          };
        } catch (e) {}
        startScheduler();
        applyPending();
      } catch (e) { dead = true; return Promise.resolve(false); }
    }

    if (unlockP) return unlockP;

    unlockP = new Promise(function (resolve) {
      var tries = 0;
      polling = true;
      (function poll() {
        if (!ctx) { polling = false; resolve(false); return; }
        if (ctx.state === 'running') {
          api.ready = true; polling = false;
          try { applyPending(); } catch (e) {}
          resolve(true); return;
        }
        try { var q = ctx.resume(); if (q && q.catch) q.catch(function () {}); } catch (e) {}
        if (++tries < 40) { setTimeout(poll, 120); }
        else {
          polling = false;
          api.ready = (ctx.state === 'running');
          /* allow a later gesture to try again */
          if (!api.ready) unlockP = null;
          resolve(api.ready);
        }
      })();
    });
    return unlockP;
  };

  api.setMaster = function (v) {
    userVol = clamp(v, 0, 1);
    if (!ok()) return;
    ramp(outGain.gain, muted ? 0.0001 : Math.max(0.0001, userVol), 0.12);
  };
  api.setMuted = function (m) {
    muted = !!m;
    if (!ok()) return;
    ramp(outGain.gain, muted ? 0.0001 : Math.max(0.0001, userVol), 0.10);
  };
  api.isMuted = function () { return muted; };
  api.setTinySpeaker = function (on) {
    tiny = !!on;
    if (!ok()) return;
    ramp(harmGain.gain, tiny ? 0.95 : 0.72, 0.25);
    ramp(subGain.gain, tiny ? 0.55 : 0.90, 0.25);
  };

  api.ambience = function (kind) {
    ambKind = (kind === 'cab' || kind === 'bridge' || kind === 'menu') ? kind : 'none';
    if (!ok()) return;
    var tau = 0.27;   /* ~0.8 s crossfade (3*tau) */
    var r = 0.0001, w = 0.0001, wet = 0.18;
    clackOn = false;
    if (ambKind === 'cab') { r = 1.0; w = 0.10 + 0.45 * speed; wet = 0.32; clackOn = true; }
    else if (ambKind === 'bridge') { r = 0.20; w = 1.0; wet = 0.16; }
    else if (ambKind === 'menu') { r = 0.14; w = 0.18; wet = 0.22; }
    tgt(rumAmb.gain, r, tau);
    tgt(windAmb.gain, w, tau);
    tgt(revWet.gain, wet, tau);
    if (ambKind === 'bridge') {
      /* up on the footbridge the structure channels the air: higher, more
         resonant band than the cab's dull roar */
      tgt(wPinkBP.frequency, 640, 0.5);
      tgt(wPinkBP.Q, 2.1, 0.5);
      tgt(wWhiteG.gain, 0.075, 0.5);
    } else {
      tgt(wPinkBP.frequency, 450, 0.5);
      tgt(wPinkBP.Q, 1.4, 0.5);
      tgt(wWhiteG.gain, 0.04, 0.5);
    }
    if (!clackOn) clackNext = 0;
    applyTension();
  };

  api.setSpeed = function (v) {
    speed = clamp(v, 0, 1);
    applySpeed(false);
  };

  api.setTension = function (v) {
    tension = clamp(v, 0, 1);
    applyTension();
  };

  api.heartbeat = function (on) {
    hbOn = !!on;
    if (!ok()) return;
    if (hbOn) { hbNext = T() + 0.08; ramp(hbGain.gain, 1.0, 0.25); }
    else ramp(hbGain.gain, 0.0001, 0.25);
  };

  /* ------------------------------------------------------- BRAKE SCREECH */
  api.screech = function (durationSec) {
    var D = clamp(durationSec === undefined ? 3.6 : durationSec, 0.8, 9.0);
    if (!ok()) return D;
    var now = T();
    if (now < screechEnd) return Math.max(0, screechEnd - now);   /* no pile-up */
    var t = now + 0.01, sc = D / 3.6;
    screechEnd = t + D + 0.35;

    var out = G(1.0);
    var pn = PAN(-0.15);
    var envG = G(0.0001);
    envG.connect(out);
    if (pn) { out.connect(pn); pn.connect(sfxBus); } else out.connect(sfxBus);
    var sg = G(0.30); out.connect(sg); sg.connect(revSend);

    var mixG = G(1.0);
    var ws = WS(tanhCurve(12), '2x');
    var bp = BQ('bandpass', 1200, 8.0);
    mixG.connect(ws); ws.connect(bp); bp.connect(envG);

    /* three saws. 3070/2050 = 1.4976 -- deliberately NOT a fifth. The A/B pair
       40 cents apart beats at ~48 Hz: that is the buzz-saw edge. */
    var oA = OSC('sawtooth', 2050, t); try { oA.detune.setValueAtTime(-17, t); } catch (e) {}
    var oB = OSC('sawtooth', 2050, t); try { oB.detune.setValueAtTime(23, t); } catch (e) {}
    var oC = OSC('sawtooth', 3070, t); try { oC.detune.setValueAtTime(-9, t); } catch (e) {}
    var gA = G(0.33), gB = G(0.33), gC = G(0.33);
    oA.connect(gA); oB.connect(gB); oC.connect(gC);
    gA.connect(mixG); gB.connect(mixG); gC.connect(mixG);

    /* CHAOS: stick-slip wander. WITHOUT THIS IT IS A SYNTH PAD. */
    var chaos = ctx.createBufferSource();
    chaos.buffer = BUF_B; chaos.loop = true; chaos.playbackRate.value = 0.02;
    var chLP = BQ('lowpass', 12, 0.7);
    var chG = G(45);
    chaos.connect(chLP); chLP.connect(chG);
    chG.connect(oA.detune); chG.connect(oB.detune); chG.connect(oC.detune);

    /* SQUARE, not sine. A sine on detune is vibrato, and vibrato is exactly
       what makes a screech read as a synth pad. Stick-slip friction is
       DISCONTINUOUS: the shoe grabs, the pitch jumps, it releases, it jumps
       back. 9.7 and 17.3 Hz are mutually irrational so the two-square sum
       never repeats; +/-55 and +/-40 cents is a jump of a bit over a
       semitone, which reads as metal rather than as music. OscillatorNode
       phase is continuous across a frequency step, so the jumps are
       click-free.
       oC already had the brown-noise chaos on its detune but NO periodic
       jitter at all, so it sat under the pair as a comparatively steady
       3070 Hz saw -- the component most responsible for the pad character.
       Both LFOs now feed it as well. Worst-case total detune on oC is
       -9 (base) -180 (the give-up ramp) -45 (chaos) -95 (both LFOs) =
       -329 cents, i.e. 3070 -> 2538 Hz: well inside the bandpass sweep and
       nowhere near aliasing. */
    var j1 = OSC('square', 9.7, t), j1g = G(55);
    var j2 = OSC('square', 17.3, t), j2g = G(40);
    j1.connect(j1g); j1g.connect(oA.detune); j1g.connect(oC.detune);
    j2.connect(j2g); j2g.connect(oB.detune); j2g.connect(oC.detune);

    /* grit beds -- the broadband scrape under the tone */
    var nb1 = NZLOOP(BUF_W, t, t + D + 0.25);
    var nb1f = BQ('bandpass', 4200, 14); var nb1g = G(0.15);
    nb1.connect(nb1f); nb1f.connect(nb1g); nb1g.connect(envG);
    var nb2 = NZLOOP(BUF_W, t, t + D + 0.25);
    var nb2f = BQ('highpass', 2200, 0.7); var nb2g = G(0.07);
    nb2.connect(nb2f); nb2f.connect(nb2g); nb2g.connect(envG);

    /* the filter strains up to 5200 Hz -- the peak of hope -- then sags */
    try {
      bp.frequency.setValueAtTime(1200, t);
      bp.frequency.exponentialRampToValueAtTime(5200, t + 0.9 * sc);
      bp.frequency.exponentialRampToValueAtTime(2600, t + Math.min(D, 3.2 * sc));
      bp.Q.setValueAtTime(8.0, t);
      bp.Q.linearRampToValueAtTime(3.0, t + D);
    } catch (e) {}

    /* the pitch gives up: -180 cents from the peak onward */
    var dOs = [oA, oB, oC], dBase = [-17, 23, -9], k;
    for (k = 0; k < 3; k++) {
      try {
        dOs[k].detune.setValueAtTime(dBase[k], t + 0.9 * sc);
        dOs[k].detune.linearRampToValueAtTime(dBase[k] - 180, t + D);
      } catch (e) {}
    }

    /* "screams then achieves nothing": stepped 30 ms chatter over the shape */
    var pts = [[0, 0.0001], [0.035, 1.00], [0.35, 0.92], [0.9, 1.00],
               [1.6, 0.78], [2.2, 0.55], [3.0, 0.18], [3.6, 0.0001]];
    function shape(x) {
      x = x / sc;
      if (x <= pts[0][0]) return pts[0][1];
      for (var i = 1; i < pts.length; i++) {
        if (x <= pts[i][0]) {
          var a = pts[i - 1], b2 = pts[i];
          var u = (x - a[0]) / Math.max(1e-6, b2[0] - a[0]);
          return a[1] + (b2[1] - a[1]) * u;
        }
      }
      return 0.0001;
    }
    /* Stick-slip chatter. Every 30 ms the level jumps to a new value -- but it
       is RAMPED there over 8 ms and then HELD flat for the remaining 22 ms,
       never assigned. A bare setValueAtTime on a full-band gain is a step
       discontinuity in the waveform: across ~120 steps, with jumps of up to
       38% of level, that is a 33 Hz tick train laid over the whole screech.
       8 ms is short enough that the chatter still reads as grab-and-release
       and long enough to be silent. Event times run
       +0.008, +0.030, +0.038, +0.060, ... : strictly increasing, as the
       automation timeline requires.
       14% of steps now drop to 0.18-0.40 instead of the flat 0.62-1.00 band:
       that is the shoe actually LETTING GO for a moment, and it is the single
       biggest cue separating metal from a filtered pad.
       The loop stops 40 ms short of D so the last held event lands strictly
       BEFORE t + D -- otherwise the trailing setValueAtTime would be
       scheduled after the final ramp to silence below and leave envG.gain
       parked at a non-zero value for the life of the node. */
    var p = envG.gain, x2 = 0, vv, ch;
    try { p.setValueAtTime(0.0001, t); } catch (e) {}
    while (x2 < D - 0.04) {
      ch = (Math.random() < 0.14) ? (0.18 + Math.random() * 0.22)
                                  : (0.62 + Math.random() * 0.38);
      vv = Math.max(0.0001, shape(x2) * ch * 0.62);
      try {
        p.linearRampToValueAtTime(vv, t + x2 + 0.008);
        p.setValueAtTime(vv, t + x2 + 0.030);
      } catch (e) {}
      x2 += 0.03;
    }
    try { p.linearRampToValueAtTime(0.0001, t + D); } catch (e) {}

    oA.start(t); oB.start(t); oC.start(t);
    chaos.start(t); j1.start(t); j2.start(t);
    var endT = t + D + 0.06;
    oA.stop(endT); oB.stop(endT); oC.stop(endT);
    chaos.stop(endT); j1.stop(endT); j2.stop(endT);

    var nn = [oA, oB, oC, gA, gB, gC, mixG, ws, bp, envG, out, chaos, chLP, chG,
              j1, j1g, j2, j2g, nb1, nb1f, nb1g, nb2, nb2f, nb2g, sg];
    if (pn) nn.push(pn);
    reap(nn, endT, envG);

    /* The linkage gives up 100 ms after the scream dies. The RUMBLE IS
       UNCHANGED -- the whole brake-failure story is told by that one
       contradiction, on the audio clock so a tab-hide cannot desync it. */
    clunkAt(t + D + 0.10, 1);
    return D;
  };

  /* ------------------------------------------------- LEVER FAIL (dry clunk) */
  api.leverFail = function () {
    if (!ok() || busy()) return;
    clunkAt(T() + 0.01, 1);
  };

  /* --------------------------------------------------- RAILWAY POINTS THROW */
  api.switchThrow = function () {
    if (!ok()) return;
    var t = T() + 0.01;
    var out = G(1.0); out.connect(sfxBus);
    var sd = G(0.25); out.connect(sd); sd.connect(revSend);
    var nodes = [out, sd];

    /* t+0  CLUNK: the lever leaves the detent */
    var o1 = OSC('sine', 140, t), g1 = G(0.0001);
    try { o1.frequency.exponentialRampToValueAtTime(70, t + 0.05); } catch (e) {}
    o1.connect(g1); g1.connect(out);
    var s1 = G(0.7); g1.connect(s1); s1.connect(subBus);
    env(g1, t, 0.70, 0.003, 0.14);
    o1.start(t); o1.stop(t + 0.32);
    var n1 = NZ(BUF_W, t, 0.03), b1 = BQ('bandpass', 340, 2.5), ng1 = G(0.0001);
    n1.connect(b1); b1.connect(ng1); ng1.connect(out);
    env(ng1, t, 0.40, 0.0012, 0.03);
    nodes.push(o1, g1, s1, n1, b1, ng1);

    /* t+95ms TRAVEL: the rod slides. This gap is what makes it feel HEAVY.
       A clunk and a clang with nothing between reads as a light switch. */
    var n2 = NZ(BUF_W, t + 0.095, 0.09), b2 = BQ('bandpass', 1200, 1.2), ng2 = G(0.0001);
    n2.connect(b2); b2.connect(ng2); ng2.connect(out);
    try {
      ng2.gain.setValueAtTime(0.0001, t + 0.095);
      ng2.gain.linearRampToValueAtTime(0.04, t + 0.110);
      ng2.gain.linearRampToValueAtTime(0.14, t + 0.170);
      ng2.gain.linearRampToValueAtTime(0.0001, t + 0.190);
    } catch (e) {}
    nodes.push(n2, b2, ng2);

    /* t+190ms CLANG: blades seat. Free-free bar modes 1 : 2.26 : 3.77 : 6 : 8.34 */
    var tc = t + 0.190;
    var n3 = NZ(BUF_W, tc, 0.02), b3 = BQ('highpass', 2500, 0.7), ng3 = G(0.0001);
    n3.connect(b3); b3.connect(ng3); ng3.connect(out);
    env(ng3, tc, 0.55, 0.0008, 0.05);
    nodes.push(n3, b3, ng3);

    var mf = [523, 1180, 1970, 3140, 4360];
    var md = [1.1, 0.8, 0.55, 0.32, 0.20];
    var mg = [0.30, 0.22, 0.16, 0.10, 0.06];
    for (var i = 0; i < 5; i++) {
      var o = OSC('sine', mf[i] * (0.99 + Math.random() * 0.02), tc);
      var g = G(0.0001);
      o.connect(g); g.connect(out);
      env(g, tc, mg[i], 0.0015, md[i]);
      o.start(tc); o.stop(tc + md[i] + 0.10);
      nodes.push(o, g);
    }
    var o4 = OSC('sine', 96, tc), g4 = G(0.0001);
    try { o4.frequency.exponentialRampToValueAtTime(70, tc + 0.35); } catch (e) {}
    o4.connect(g4); g4.connect(out);
    var s4 = G(0.8); g4.connect(s4); s4.connect(subBus);
    env(g4, tc, 0.50, 0.003, 0.35);
    o4.start(tc); o4.stop(tc + 0.58);
    nodes.push(o4, g4, s4);

    /* t+260ms latch tick */
    var n5 = NZ(BUF_W, t + 0.26, 0.012), b5 = BQ('bandpass', 5200, 6), ng5 = G(0.0001);
    n5.connect(b5); b5.connect(ng5); ng5.connect(out);
    env(ng5, t + 0.26, 0.20, 0.001, 0.02);
    nodes.push(n5, b5, ng5);

    reap(nodes, t + 1.7, out);
  };

  /* ------------------------------------------------------------------ HORN */
  api.horn = function () {
    if (!ok()) return;
    var t = T() + 0.01;
    var out = G(1.0); out.connect(sfxBus);
    var sd = G(0.35); out.connect(sd); sd.connect(revSend);
    var nodes = [out, sd];

    /* two blasts, the second higher and shorter: desperation, not a signal */
    var blasts = [[t, 0.55, 0], [t + 0.72, 0.80, 18]];
    var chord = [311.1, 370.0, 466.2, 622.3];
    var lev = [0.34, 0.26, 0.20, 0.09];
    for (var b = 0; b < blasts.length; b++) {
      var bt = blasts[b][0], bd = blasts[b][1], bdet = blasts[b][2];
      var lp = BQ('lowpass', 2200, 0.9);
      var eg = G(0.0001);
      lp.connect(eg); eg.connect(out);
      try {
        var p = eg.gain;
        p.setValueAtTime(0.0001, bt);
        p.linearRampToValueAtTime(0.95, bt + 0.030);
        p.linearRampToValueAtTime(0.80, bt + bd * 0.7);
        p.linearRampToValueAtTime(0.62, bt + bd);
        p.exponentialRampToValueAtTime(0.0001, bt + bd + 0.22);
      } catch (e) {}
      nodes.push(lp, eg);
      for (var i = 0; i < chord.length; i++) {
        var o = OSC(i < 2 ? 'sawtooth' : 'square', chord[i], bt);
        try {
          o.detune.setValueAtTime(bdet + (Math.random() * 8 - 4), bt);
          o.detune.linearRampToValueAtTime(bdet - 45, bt + bd + 0.2);
        } catch (e) {}
        var g = G(lev[i]);
        o.connect(g); g.connect(lp);
        o.start(bt); o.stop(bt + bd + 0.32);
        nodes.push(o, g);
      }
      /* air blast underneath the reed */
      var n = NZ(BUF_P, bt, Math.min(1.5, bd + 0.1));
      var nb = BQ('bandpass', 900, 1.0), ng = G(0.0001);
      n.connect(nb); nb.connect(ng); ng.connect(out);
      env(ng, bt, 0.09, 0.02, bd);
      nodes.push(n, nb, ng);
      /* sub body so it reads on a laptop speaker */
      var os = OSC('sine', chord[0] * 0.5, bt), gs = G(0.0001);
      os.connect(gs); gs.connect(subBus);
      env(gs, bt, 0.30, 0.02, bd);
      os.start(bt); os.stop(bt + bd + 0.28);
      nodes.push(os, gs);
    }
    reap(nodes, t + 2.3, out);
  };

  /* --------------------------------------------------------------- DOPPLER */
  api.doppler = function (durationSec) {
    var D = clamp(durationSec === undefined ? 5.0 : durationSec, 1.5, 14.0);
    if (!ok()) return D;
    var now = T();
    if (now < dopplerEnd) return Math.max(0, dopplerEnd - now);
    var t0 = now + 0.02;
    dopplerEnd = t0 + D;
    var v = 26.82;                     /* 60 mph                              */
    var half = v * D * 0.5;
    var offAxis = 8.0;                 /* metres from the listener            */
    var C = 343;

    var out = G(1.0);
    var pn = PAN(-1);
    var airLP = BQ('lowpass', 500, 0.7);
    var distG = G(0.0001);
    airLP.connect(distG); distG.connect(out);
    if (pn) { out.connect(pn); pn.connect(sfxBus); } else out.connect(sfxBus);
    var sd = G(0.20); out.connect(sd); sd.connect(revSend);
    /* sub tap must sit AFTER the distance gain, or a distant trolley still
       thumps your chest */
    var subTap = G(0.40); distG.connect(subTap); subTap.connect(subBus);

    var endT = t0 + D + 0.12;
    var brown = NZLOOP(BUF_B, t0, endT, 1.0);
    var blp = BQ('lowpass', 420, 0.7); var bg = G(0.5);
    brown.connect(blp); blp.connect(bg); bg.connect(airLP);

    var s1 = OSC('sine', 27.5, t0), s1g = G(0.30);
    var s2 = OSC('sine', 41.0, t0), s2g = G(0.22);
    s1.connect(s1g); s2.connect(s2g); s1g.connect(airLP); s2g.connect(airLP);

    var wh = OSC('sawtooth', 176, t0), whbp = BQ('bandpass', 1100, 6), whg = G(0.0001);
    wh.connect(whbp); whbp.connect(whg); whg.connect(airLP);

    var whoosh = NZLOOP(BUF_P, t0, endT);
    var wbp = BQ('bandpass', 300, 1.2), wg = G(0.0001);
    whoosh.connect(wbp); wbp.connect(wg); wg.connect(out);

    /* trajectory, scheduled at 50 ms. Chrome removed PannerNode.setVelocity
       and dopplerFactor, so the Doppler shift is computed by hand:
       cents = 1200 * log2( c / (c - vRadial) )  -> +141c approaching,
       -130c receding: a 271-cent swing across the pass. */
    var step = 0.05;
    var steps = Math.min(280, Math.ceil(D / step));
    step = D / steps;
    var prevDist = -1, i;
    var dp = distG.gain, ap = airLP.frequency, pp = pn ? pn.pan : null;
    try {
      dp.setValueAtTime(0.0001, t0);
      ap.setValueAtTime(500, t0);
      if (pp) pp.setValueAtTime(-1, t0);
    } catch (e) {}
    for (i = 0; i <= steps; i++) {
      var tt = i * step;
      var x = -half + v * tt;
      var dist = Math.sqrt(x * x + offAxis * offAxis);
      var vr = (prevDist < 0) ? v : (prevDist - dist) / step;
      prevDist = dist;
      vr = clamp(vr, -C * 0.5, C * 0.5);
      var cents = 1200 * Math.log(C / (C - vr)) / Math.LN2;
      var mul = Math.pow(2, cents / 1200);
      var g = 1 / (1 + dist / 12);
      var air = clamp(22050 * Math.exp(-dist / 45), 400, 14000);
      var pan = clamp(x / (Math.abs(x) + offAxis), -1, 1);
      var whoo = Math.max(0, 1 - Math.abs(x) / 14);
      var at = t0 + tt;
      try {
        dp.linearRampToValueAtTime(Math.max(0.0001, g * 0.9), at);
        ap.linearRampToValueAtTime(air, at);
        if (pp) pp.linearRampToValueAtTime(pan, at);
        brown.playbackRate.linearRampToValueAtTime(clamp(mul, 0.25, 3.5), at);
        s1.detune.linearRampToValueAtTime(cents, at);
        s2.detune.linearRampToValueAtTime(cents, at);
        wh.detune.linearRampToValueAtTime(cents, at);
        whg.gain.linearRampToValueAtTime(dist < 25 ? 0.05 : 0.0001, at);
        wg.gain.linearRampToValueAtTime(Math.max(0.0001, 0.35 * whoo * whoo), at);
      } catch (e) {}
    }
    try { dp.linearRampToValueAtTime(0.0001, t0 + D + 0.06); } catch (e) {}

    /* clacks along the pass -- the accelerating tick is more than half the
       effect. Gated by distance so a 14 s pass cannot flood the voice pool. */
    var jt = RAIL_LEN / v, ct = 0.02, guard = 0;
    while (ct < D && guard++ < 200) {
      var xx = -half + v * ct;
      var dd = Math.sqrt(xx * xx + offAxis * offAxis);
      if (dd < 75) {
        var vrr = clamp(v * (-xx) / Math.max(1, dd), -C * 0.5, C * 0.5);
        var cc = 1200 * Math.log(C / (C - vrr)) / Math.LN2;
        var pm = Math.pow(2, cc / 1200);
        var lv = 0.34 / (1 + dd / 12);
        var pa = clamp(xx / (Math.abs(xx) + offAxis), -1, 1);
        var hits = (dd < 30) ? 4 : 2;
        for (var k = 0; k < hits; k++) {
          if (Math.random() < 0.06) continue;
          /* same hoisted geometry as schedTick(), and the same +/-1.5 ms /
             +/-3% scatter, applied ON TOP of the doppler pitch multiplier */
          clack(t0 + ct + AXLE[k] / v + (Math.random() - 0.5) * 0.003,
                lv * AXLE_LVL[k] * (0.7 + Math.random() * 0.6),
                pm * (0.97 + Math.random() * 0.06), pa, 0.16, sfxBus);
        }
      }
      ct += jt * (0.94 + Math.random() * 0.12);
    }

    s1.start(t0); s2.start(t0); wh.start(t0);
    s1.stop(endT); s2.stop(endT); wh.stop(endT);
    var nn = [brown, blp, bg, s1, s1g, s2, s2g, subTap, wh, whbp, whg,
              whoosh, wbp, wg, airLP, distG, out, sd];
    if (pn) nn.push(pn);
    reap(nn, endT + 0.1, distG);
    return D;
  };

  /* ------------------------------------------------------------------ PUSH */
  api.push = function () {
    if (!ok()) return;
    var t = T() + 0.005;
    var out = G(1.0); out.connect(sfxBus);
    var sd = G(0.16); out.connect(sd); sd.connect(revSend);
    var nodes = [out, sd];

    /* CLOTH -- two swells, not one. A single swell reads as a swipe. */
    var c1 = NZ(BUF_W, t, 0.22);
    var cb1 = BQ('bandpass', 2200, 1.1), cg1 = G(0.0001);
    try {
      cb1.frequency.setValueAtTime(2200, t);
      cb1.frequency.exponentialRampToValueAtTime(900, t + 0.22);
    } catch (e) {}
    c1.connect(cb1); cb1.connect(cg1); cg1.connect(out);
    try {
      var p1 = cg1.gain;
      p1.setValueAtTime(0.0001, t);
      p1.linearRampToValueAtTime(0.09, t + 0.02);
      p1.linearRampToValueAtTime(0.22, t + 0.06);
      p1.linearRampToValueAtTime(0.11, t + 0.11);
      p1.linearRampToValueAtTime(0.20, t + 0.15);
      p1.exponentialRampToValueAtTime(0.0001, t + 0.24);
    } catch (e) {}
    var c2 = NZ(BUF_W, t + 0.09, 0.14);
    var cb2 = BQ('bandpass', 4200, 0.9), cg2 = G(0.0001);
    c2.connect(cb2); cb2.connect(cg2); cg2.connect(out);
    env(cg2, t + 0.09, 0.10, 0.02, 0.12);
    nodes.push(c1, cb1, cg1, c2, cb2, cg2);

    /* MASS shift -- he is heavy and he does not want to move */
    var m = OSC('sine', 110, t), mlp = BQ('lowpass', 200, 0.8), mg = G(0.0001);
    try { m.frequency.exponentialRampToValueAtTime(48, t + 0.18); } catch (e) {}
    m.connect(mlp); mlp.connect(mg); mg.connect(out);
    var ms = G(0.9); mg.connect(ms); ms.connect(subBus);
    env(mg, t, 0.35, 0.004, 0.50);
    m.start(t); m.stop(t + 0.78);
    nodes.push(m, mlp, mg, ms);

    /* GASP -- two formants (700 / 1100 Hz) are what turn filtered noise into
       a HUMAN breath. The 190 Hz voiced edge stays under 0.06 or the scene
       tips from "shoved" into "screamed". */
    var ge = G(0.0001); ge.connect(out);
    var gn1 = NZ(BUF_W, t, 0.30);
    var gb1 = BQ('bandpass', 700, 3.5);
    try {
      gb1.frequency.setValueAtTime(700, t);
      gb1.frequency.linearRampToValueAtTime(1500, t + 0.12);
      gb1.frequency.linearRampToValueAtTime(600, t + 0.30);
    } catch (e) {}
    gn1.connect(gb1); gb1.connect(ge);
    var gn2 = NZ(BUF_W, t, 0.30);
    var gb2 = BQ('bandpass', 1100, 5.0), gg2 = G(0.4);
    gn2.connect(gb2); gb2.connect(gg2); gg2.connect(ge);
    var vo = OSC('sine', 190, t), vog = G(0.05), vlfo = OSC('sine', 6.2, t), vlg = G(30);
    vlfo.connect(vlg); vlg.connect(vo.detune);
    vo.connect(vog); vog.connect(ge);
    try {
      var pg = ge.gain;
      pg.setValueAtTime(0.0001, t);
      pg.linearRampToValueAtTime(0.30, t + 0.045);
      pg.setValueAtTime(0.30, t + 0.135);
      pg.exponentialRampToValueAtTime(0.0001, t + 0.36);
    } catch (e) {}
    vo.start(t); vo.stop(t + 0.42); vlfo.start(t); vlfo.stop(t + 0.42);
    nodes.push(ge, gn1, gb1, gn2, gb2, gg2, vo, vog, vlfo, vlg);

    /* SCUFF -- a heel that tried to hold */
    var sn = NZ(BUF_W, t + 0.14, 0.10), sb = BQ('bandpass', 900, 1.5), sgn = G(0.0001);
    sn.connect(sb); sb.connect(sgn); sgn.connect(out);
    env(sgn, t + 0.14, 0.12, 0.006, 0.09);
    nodes.push(sn, sb, sgn);

    reap(nodes, t + 1.1, out);
  };

  /* -------------------------------------------------------------- BODYFALL */
  api.bodyFall = function () {
    if (!ok()) return;
    var t = T() + 0.005;
    var out = G(1.0); out.connect(sfxBus);
    var sd = G(0.30); out.connect(sd); sd.connect(revSend);
    var nodes = [out, sd];

    /* dull, wet mass on steel */
    var o1 = OSC('sine', 120, t), l1 = BQ('lowpass', 160, 0.9), gg1 = G(0.0001);
    try { o1.frequency.exponentialRampToValueAtTime(38, t + 0.26); } catch (e) {}
    o1.connect(l1); l1.connect(gg1); gg1.connect(out);
    var sb1 = G(1.0); gg1.connect(sb1); sb1.connect(subBus);
    env(gg1, t, 0.95, 0.004, 0.70);
    o1.start(t); o1.stop(t + 1.05);
    nodes.push(o1, l1, gg1, sb1);

    /* speaker layer -- 190 -> 85 Hz, actually audible on a Chromebook */
    var o2 = OSC('triangle', 190, t), gg2 = G(0.0001);
    try { o2.frequency.exponentialRampToValueAtTime(85, t + 0.30); } catch (e) {}
    o2.connect(gg2); gg2.connect(out);
    env(gg2, t, 0.40, 0.004, 0.40);
    o2.start(t); o2.stop(t + 0.75);
    nodes.push(o2, gg2);

    /* flesh-on-steel slap: 240 Hz is where a small driver reads WEIGHT */
    var n1 = NZ(BUF_W, t, 0.07), b1 = BQ('bandpass', 240, 2.4), ng1 = G(0.0001);
    n1.connect(b1); b1.connect(ng1); ng1.connect(out);
    env(ng1, t, 0.34, 0.0012, 0.07);
    nodes.push(n1, b1, ng1);

    /* the rail rings, inharmonic */
    var rf = 420, rr = [1, 2.76, 5.40], rg = [0.16, 0.10, 0.06], rd = [0.55, 0.30, 0.18];
    for (var i = 0; i < 3; i++) {
      var o = OSC('sine', rf * rr[i] * (0.98 + Math.random() * 0.04), t + 0.004);
      var g = G(0.0001);
      o.connect(g); g.connect(out);
      env(g, t + 0.004, rg[i], 0.0015, rd[i]);
      o.start(t + 0.004); o.stop(t + rd[i] + 0.12);
      nodes.push(o, g);
    }

    /* gravel scatter */
    var bp = BQ('bandpass', 2000, 3.5); bp.connect(out);
    nodes.push(bp);
    for (var k = 0; k < 14; k++) {
      var tk = t + 0.02 + 0.42 * Math.pow(k / 14, 1.6) + Math.random() * 0.03;
      var n = NZ(BUF_W, tk, 0.02 + Math.random() * 0.03);
      var g3 = G(0.0001);
      n.connect(g3); g3.connect(bp);
      env(g3, tk, 0.16 * Math.pow(1 - k / 14, 1.3) * (0.5 + Math.random() * 0.5) + 0.008, 0.0012, 0.04);
      nodes.push(n, g3);
    }
    reap(nodes, t + 1.7, out);
  };

  /* ---------------------------------------------------------------- IMPACT */
  api.impact = function () {
    if (!ok()) return;
    /* 45 ms of pre-roll so the air-compression layer can sit BEFORE the hit.
       The lead has to clear that 45 ms with margin: impact() is called from
       the same frame that spawns the ragdoll, flashes the FX and shakes the
       camera, so ctx.currentTime can easily advance 10-30 ms (a GC pause, a
       long frame) between the read below and the events reaching the audio
       thread. At the old +55 ms the pre-roll sat at T()+0.010 -- under four
       render quanta -- and on any loaded Chromebook it landed in the past and
       was silently dropped: the one layer whose entire job is to arrive
       first. +80 ms puts it at T()+0.035 (~13 quanta of margin) while keeping
       the hit itself only 80 ms behind the picture, comfortably under the
       ~100-125 ms at which audio lag becomes detectable -- which matters,
       because a projector's own HDMI audio path adds latency on top. */
    var t = T() + 0.080;
    var out = G(1.0); out.connect(sfxBus);
    var sd = G(0.55); out.connect(sd); sd.connect(revSend);
    var nodes = [out, sd];
    /* explicit bases: never read p.value, or a second impact ratchets the
       buses down and never restores them */
    duck(ambBus, 1.0, 0.22, 0.02, 0.55, 1.3);
    duck(rumbleBus, 1.0, 0.30, 0.02, 0.45, 1.1);

    /* -45 ms  the wall of air arriving just ahead of the mass */
    var tpre = t - 0.045;
    var np = NZ(BUF_P, tpre, 0.05), bpp = BQ('bandpass', 420, 1.0), gpp = G(0.0001);
    np.connect(bpp); bpp.connect(gpp); gpp.connect(out);
    try {
      var ppre = gpp.gain;
      ppre.setValueAtTime(0.0001, tpre);
      ppre.linearRampToValueAtTime(0.16, t - 0.004);
      ppre.linearRampToValueAtTime(0.0001, t + 0.010);
    } catch (e) {}
    nodes.push(np, bpp, gpp);

    /* +0 transient crack -- 0.8 ms attack. On a tiny driver perceived loudness
       IS transient energy, so this layer runs ~4 dB hot vs a headphone mix. */
    var n0 = NZ(BUF_W, t, 0.10);
    var hp0 = BQ('highpass', 1800, 0.7);
    var ws0 = WS(tanhCurve(30), '2x');
    var g0 = G(0.0001);
    n0.connect(hp0); hp0.connect(ws0); ws0.connect(g0); g0.connect(out);
    env(g0, t, 1.60, 0.0008, 0.09);
    nodes.push(n0, hp0, ws0, g0);

    /* +0 metal ping */
    var op = OSC('sine', 3200, t), gp = G(0.0001);
    op.connect(gp); gp.connect(out);
    env(gp, t, 0.50, 0.0005, 0.05);
    op.start(t); op.stop(t + 0.14);
    nodes.push(op, gp);

    /* +6 ms mass thud 90 -> 25 Hz. The 6 ms IS the trick: the ear localises
       from the transient and judges MASS from what arrives just behind it. */
    var tm = t + 0.006;
    var om = OSC('sine', 90, tm), lm = BQ('lowpass', 140, 0.9), gm = G(0.0001);
    try {
      om.frequency.setValueAtTime(90, tm);
      om.frequency.exponentialRampToValueAtTime(25, tm + 0.30);
    } catch (e) {}
    om.connect(lm); lm.connect(gm); gm.connect(out);
    var smb = G(1.0); gm.connect(smb); smb.connect(subBus);
    env(gm, tm, 1.00, 0.004, 0.85);
    om.start(tm); om.stop(tm + 1.25);
    nodes.push(om, lm, gm, smb);

    /* +6 ms speaker layer 190 -> 85 Hz (2nd harmonic at 170 Hz survives) */
    var os2 = OSC('sine', 190, tm), ot2 = OSC('triangle', 190, tm), gs2 = G(0.0001);
    try {
      os2.frequency.exponentialRampToValueAtTime(85, tm + 0.30);
      ot2.frequency.exponentialRampToValueAtTime(85, tm + 0.30);
    } catch (e) {}
    os2.connect(gs2); ot2.connect(gs2); gs2.connect(out);
    env(gs2, tm, 0.45, 0.004, 0.45);
    os2.start(tm); os2.stop(tm + 0.85); ot2.start(tm); ot2.stop(tm + 0.85);
    nodes.push(os2, ot2, gs2);

    /* +6 ms 220 Hz body thump -- single highest-return layer on a laptop */
    var nb = NZ(BUF_W, tm, 0.05), bb = BQ('bandpass', 220, 2.5), gb = G(0.0001);
    nb.connect(bb); bb.connect(gb); gb.connect(out);
    env(gb, tm, 0.30, 0.0015, 0.06);
    nodes.push(nb, bb, gb);

    /* +18 ms second mass 62 -> 19 Hz */
    var t2 = t + 0.018;
    var om2 = OSC('sine', 62, t2), gm2 = G(0.0001);
    try { om2.frequency.exponentialRampToValueAtTime(19, t2 + 0.42); } catch (e) {}
    om2.connect(gm2); gm2.connect(out);
    var smb2 = G(0.9); gm2.connect(smb2); smb2.connect(subBus);
    env(gm2, t2, 0.60, 0.005, 1.20);
    om2.start(t2); om2.stop(t2 + 1.7);
    nodes.push(om2, gm2, smb2);

    /* +14 ms deformation cluster. Inharmonic 1 : 1.33 : 1.78 : 2.36 : 3.11,
       drifting -40 cents over 1.5 s = steel bent PERMANENTLY. */
    var td = t + 0.014;
    var cl = G(1.0), cws = WS(tanhCurve(25), '2x'), cbp = BQ('bandpass', 900, 1.4), cg = G(0.0001);
    cl.connect(cws); cws.connect(cbp); cbp.connect(cg); cg.connect(out);
    try {
      cbp.frequency.setValueAtTime(900, td);
      cbp.frequency.exponentialRampToValueAtTime(400, td + 0.6);
    } catch (e) {}
    env(cg, td, 0.55, 0.010, 1.40);
    var cf = [148, 197, 263, 349, 461];
    var i;
    for (i = 0; i < 5; i++) {
      var oc = OSC('square', cf[i], td);
      var d0 = Math.random() * 70 - 35;
      try {
        oc.detune.setValueAtTime(d0, td);
        oc.detune.linearRampToValueAtTime(d0 - 40, td + 1.5);
      } catch (e) {}
      var gc = G(0.20);
      oc.connect(gc); gc.connect(cl);
      oc.start(td); oc.stop(td + 1.65);
      nodes.push(oc, gc);
    }
    nodes.push(cl, cws, cbp, cg);

    /* +14 ms bell modes */
    var bf = [320, 545, 883, 1214, 1697];
    var bdd = [1.9, 1.4, 1.0, 0.7, 0.5];
    var bgg = [0.26, 0.19, 0.14, 0.09, 0.06];
    for (i = 0; i < 5; i++) {
      var ob = OSC('sine', bf[i] * (0.995 + Math.random() * 0.01), td);
      var gbo = G(0.0001);
      ob.connect(gbo); gbo.connect(out);
      env(gbo, td, bgg[i], 0.002, bdd[i]);
      ob.start(td); ob.stop(td + bdd[i] + 0.12);
      nodes.push(ob, gbo);
    }

    /* +30..+120 ms glass, through one shared bandpass */
    var gbp = BQ('bandpass', 5000, 2); gbp.connect(out);
    nodes.push(gbp);
    for (i = 0; i < 9; i++) {
      var tg = t + 0.030 + Math.random() * 0.09;
      var f = 2600 + Math.random() * 4800;
      var og2 = OSC(Math.random() < 0.5 ? 'sine' : 'triangle', f, tg);
      var gg3 = G(0.0001);
      og2.connect(gg3); gg3.connect(gbp);
      var dec = 0.12 + Math.random() * 0.33;
      env(gg3, tg, 0.10 * (1 - i / 9) + 0.02, 0.0015, dec);
      og2.start(tg); og2.stop(tg + dec + 0.10);
      nodes.push(og2, gg3);
    }

    /* +60..+900 ms debris cloud, front-loaded, 4 shared bandpasses */
    var dbp = [BQ('bandpass', 700, 4), BQ('bandpass', 1400, 4),
               BQ('bandpass', 2300, 4), BQ('bandpass', 3500, 4)];
    for (i = 0; i < 4; i++) { dbp[i].connect(out); nodes.push(dbp[i]); }
    var N = 26;
    for (var k = 0; k < N; k++) {
      var tk = t + 0.06 + 0.84 * Math.pow(k / N, 1.7) + Math.random() * 0.03;
      var dur = 0.02 + Math.random() * 0.04;
      var nn2 = NZ(BUF_W, tk, dur);
      var gn2 = G(0.0001);
      var pnn = PAN(Math.random() * 1.6 - 0.8);
      nn2.connect(gn2);
      if (pnn) { gn2.connect(pnn); pnn.connect(dbp[k & 3]); nodes.push(pnn); }
      else gn2.connect(dbp[k & 3]);
      env(gn2, tk, 0.30 * Math.pow(1 - k / N, 1.4) * (0.5 + Math.random() * 0.5) + 0.01, 0.0012, dur);
      nodes.push(nn2, gn2);
    }

    /* +120 ms room boom -- bonus texture for the projector rig only */
    var tb = t + 0.120;
    var ob2 = OSC('sine', 40, tb), gbm = G(0.0001);
    ob2.connect(gbm); gbm.connect(out);
    var sbm = G(1.0); gbm.connect(sbm); sbm.connect(subBus);
    env(gbm, tb, 0.25, 0.006, 0.50);
    ob2.start(tb); ob2.stop(tb + 0.85);
    nodes.push(ob2, gbm, sbm);

    reap(nodes, t + 3.1, out);
  };

  /* --------------------------------------------------------------- SILENCE */
  api.silence = function (ms) {
    var hold = clamp((ms === undefined ? 900 : ms) / 1000, 0.05, 12.0);
    if (!ok()) return;
    var p = masterGain.gain, now = T();
    silenceEnd = now + 0.015 + hold + 0.400;
    try {
      if (p.cancelAndHoldAtTime) { try { p.cancelAndHoldAtTime(now); } catch (e) { p.cancelScheduledValues(now); } }
      else p.cancelScheduledValues(now);
      /* the anchor is mandatory: without it the ramp interpolates from the
         last SCHEDULED event, not from where we actually are = a click */
      var v0 = Math.max(0.0001, fin(p.value, 1.0));
      p.setValueAtTime(v0, now);
      /* 15 ms to silence, but NOT as one straight line. The director calls
         silence(900) 620 ms after impact(), while impact's mass layers are
         still sounding at 25-40 Hz -- and one period of 25 Hz is 40 ms, so a
         15 ms gate is a third of a cycle. A single linear ramp has a hard
         corner in the envelope at BOTH ends (slope 0 -> -66.7/s at the start,
         where the signal is still at full amplitude, and -66.7/s -> 0 at the
         end): that pair of corners is the low thump heard exactly where the
         design wants absolute nothing.
         This is a raised-cosine (Hann) fade, g(u) = (1 + cos(pi*u))/2,
         sampled at u = 0.2 .. 1.0: it has ZERO slope at both ends, so both
         corners disappear. Worst envelope-slope discontinuity anywhere in it
         is 51.5/s against the straight line's 66.7/s at full amplitude, and
         the total duration is unchanged at exactly 15 ms -- the cut is just
         as abrupt, it simply no longer thumps.
         Each segment is floored at 0.0001 so a silence() landing on top of an
         existing silence() cannot schedule a non-monotonic ramp. */
      p.linearRampToValueAtTime(Math.max(0.0001, v0 * 0.90451), now + 0.003);
      p.linearRampToValueAtTime(Math.max(0.0001, v0 * 0.65451), now + 0.006);
      p.linearRampToValueAtTime(Math.max(0.0001, v0 * 0.34549), now + 0.009);
      p.linearRampToValueAtTime(Math.max(0.0001, v0 * 0.09549), now + 0.012);
      p.linearRampToValueAtTime(0.0001, now + 0.015);
      p.setValueAtTime(0.0001, now + 0.015 + hold);
      p.linearRampToValueAtTime(1.0, now + 0.015 + hold + 0.400);
    } catch (e) {}
  };

  /* -------------------------------------------------------------------- UI */
  function uiVoice(t, f, type, peak, atk, dec, filt, fq, q, pan, sub) {
    var out = G(1.0);
    var pn = PAN(pan || 0);
    if (pn) { out.connect(pn); pn.connect(sfxBus); } else out.connect(sfxBus);
    var o = OSC(type, f, t), g = G(0.0001);
    var extra = [];
    if (filt) { var b = BQ(filt, fq, q); o.connect(b); b.connect(g); extra.push(b); }
    else o.connect(g);
    g.connect(out);
    if (sub) { var sg = G(sub); g.connect(sg); sg.connect(subBus); extra.push(sg); }
    env(g, t, peak, atk, dec);
    o.start(t); o.stop(t + atk + dec + 0.10);
    var nn = [o, g, out].concat(extra); if (pn) nn.push(pn);
    reap(nn, t + atk + dec + 0.25, out);
    return o;
  }

  api.uiHover = function () {
    if (!ok() || busy()) return;
    var t = T() + 0.002;
    uiVoice(t, 2100, 'sine', 0.045, 0.002, 0.045, 'bandpass', 2100, 2, 0, 0);
    var n = NZ(BUF_W, t, 0.012), b = BQ('highpass', 4000, 0.7), g = G(0.0001);
    n.connect(b); b.connect(g); g.connect(sfxBus);
    env(g, t, 0.020, 0.001, 0.012);
    reap([n, b, g], t + 0.12, g);
  };

  api.uiClick = function () {
    if (!ok()) return;
    var t = T() + 0.002;
    var n = NZ(BUF_W, t, 0.03), b = BQ('bandpass', 2600, 3), g = G(0.0001);
    n.connect(b); b.connect(g); g.connect(sfxBus);
    env(g, t, 0.22, 0.0009, 0.03);
    reap([n, b, g], t + 0.22, g);
    uiVoice(t, 660, 'square', 0.10, 0.002, 0.055, 'lowpass', 1800, 0.9, 0, 0.4);
  };

  api.uiConfirm = function () {
    if (!ok()) return;
    var t = T() + 0.002;
    /* cold, not cheerful: a low fourth under a dark filter */
    uiVoice(t, 174.6, 'triangle', 0.24, 0.006, 0.26, 'lowpass', 1200, 0.8, -0.1, 0.7);
    uiVoice(t + 0.085, 233.1, 'triangle', 0.22, 0.006, 0.34, 'lowpass', 1400, 0.8, 0.1, 0.6);
    var n = NZ(BUF_W, t, 0.02), b = BQ('highpass', 3000, 0.7), g = G(0.0001);
    n.connect(b); b.connect(g); g.connect(sfxBus);
    env(g, t, 0.12, 0.001, 0.02);
    reap([n, b, g], t + 0.22, g);
  };

  api.uiDeny = function () {
    if (!ok()) return;
    var t = T() + 0.002;
    var out = G(1.0); out.connect(sfxBus);
    var ws = WS(tanhCurve(18), '2x');
    var lp = BQ('lowpass', 900, 3);
    var g = G(0.0001);
    ws.connect(lp); lp.connect(g); g.connect(out);
    var sub = G(0.5); g.connect(sub); sub.connect(subBus);
    var f = [110, 116.5];   /* minor 2nd in the bass: physically ugly */
    var nodes = [ws, lp, g, out, sub];
    for (var i = 0; i < 2; i++) {
      var o = OSC('sawtooth', f[i], t);
      try { o.detune.setValueAtTime(0, t); o.detune.linearRampToValueAtTime(-160, t + 0.30); } catch (e) {}
      var gg = G(0.3);
      o.connect(gg); gg.connect(ws);
      o.start(t); o.stop(t + 0.45);
      nodes.push(o, gg);
    }
    env(g, t, 0.42, 0.004, 0.32);
    reap(nodes, t + 0.75, out);
  };

  /* ------------------------------------------------------------------ TICK */
  api.tick = function (strength) {
    if (!ok() || busy()) return;
    var s = clamp(strength === undefined ? 0 : strength, 0, 1);
    var t = T() + 0.002;
    var out = G(1.0); out.connect(sfxBus);
    var sdv = G(0.06 + 0.14 * s); out.connect(sdv); sdv.connect(revSend);
    var nodes = [out, sdv];

    var n = NZ(BUF_W, t, 0.02 + 0.02 * (1 - s));
    var b = BQ('bandpass', 1700 + 2600 * s, 3 + 6 * s);
    var g = G(0.0001);
    var chain = b;
    if (s > 0.45) { var w = WS(tanhCurve(8 + Math.round(20 * s)), '2x'); b.connect(w); chain = w; nodes.push(w); }
    n.connect(b); chain.connect(g); g.connect(out);
    env(g, t, 0.18 + 0.42 * s, 0.0009, 0.030 + 0.020 * (1 - s));
    nodes.push(n, b, g);

    var o = OSC('sine', 1300 + 900 * s, t), og = G(0.0001);
    o.connect(og); og.connect(out);
    env(og, t, 0.10 + 0.20 * s, 0.001, 0.045 + 0.05 * (1 - s));
    o.start(t); o.stop(t + 0.22);
    nodes.push(o, og);

    /* past halfway the tick grows a body -- the clock starts hitting back */
    if (s > 0.35) {
      var os = OSC('sine', 140 - 40 * s, t), osg = G(0.0001);
      try { os.frequency.exponentialRampToValueAtTime(58, t + 0.12); } catch (e) {}
      os.connect(osg); osg.connect(subBus);
      env(osg, t, 0.20 + 0.45 * s, 0.003, 0.14);
      os.start(t); os.stop(t + 0.32);
      nodes.push(os, osg);
    }
    reap(nodes, t + 0.65, out);
  };

  /* --------------------------------------------------------------- STINGER */
  api.stinger = function (kind) {
    if (!ok()) return;
    var t = T() + 0.004;
    var out = G(1.0);
    var nodes = [out];
    var i, j;

    if (kind === 'reveal') {
      out.connect(musicBus);
      var sdr = G(0.35); out.connect(sdr); sdr.connect(revSend); nodes.push(sdr);
      var lp = BQ('lowpass', 300, 1.2), g = G(0.0001);
      lp.connect(g); g.connect(out);
      try {
        lp.frequency.setValueAtTime(300, t);
        lp.frequency.exponentialRampToValueAtTime(2600, t + 1.1);
        lp.frequency.exponentialRampToValueAtTime(900, t + 2.4);
        var pg = g.gain;
        pg.setValueAtTime(0.0001, t);
        pg.linearRampToValueAtTime(0.55, t + 0.35);
        pg.linearRampToValueAtTime(0.42, t + 1.4);
        pg.exponentialRampToValueAtTime(0.0001, t + 2.6);
      } catch (e) {}
      var f = [110, 164.8, 220, 329.6];
      var lv = [0.30, 0.22, 0.18, 0.10];
      for (i = 0; i < 4; i++) {
        var o = OSC(i < 2 ? 'sine' : 'triangle', f[i], t);
        try { o.detune.setValueAtTime(i * 4 - 6, t); } catch (e) {}
        var gg = G(lv[i]);
        o.connect(gg); gg.connect(lp);
        o.start(t); o.stop(t + 2.85);
        nodes.push(o, gg);
      }
      var n = NZLOOP(BUF_P, t, t + 2.85);
      var nb = BQ('bandpass', 600, 2.2), ng = G(0.0001);
      n.connect(nb); nb.connect(ng); ng.connect(out);
      try {
        nb.frequency.setValueAtTime(600, t);
        nb.frequency.exponentialRampToValueAtTime(3200, t + 1.1);
        ng.gain.setValueAtTime(0.0001, t);
        ng.gain.linearRampToValueAtTime(0.10, t + 0.9);
        ng.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
      } catch (e) {}
      nodes.push(lp, g, n, nb, ng);
      reap(nodes, t + 3.1, g);
      return;
    }

    if (kind === 'verdict') {
      out.connect(musicBus);
      var sdv = G(0.55); out.connect(sdv); sdv.connect(revSend); nodes.push(sdv);
      /* one heavy strike, an inharmonic bell, and a very long tail */
      var ol = OSC('sine', 55, t), gl = G(0.0001);
      try { ol.frequency.exponentialRampToValueAtTime(31, t + 0.9); } catch (e) {}
      ol.connect(gl); gl.connect(out);
      var sbv = G(1.0); gl.connect(sbv); sbv.connect(subBus);
      env(gl, t, 0.90, 0.005, 1.8);
      ol.start(t); ol.stop(t + 2.3);
      nodes.push(ol, gl, sbv);

      var nv = NZ(BUF_W, t, 0.06), hb = BQ('highpass', 1400, 0.7), ngv = G(0.0001);
      nv.connect(hb); hb.connect(ngv); ngv.connect(out);
      env(ngv, t, 0.55, 0.0009, 0.07);
      nodes.push(nv, hb, ngv);

      var bfv = [196, 320, 545, 883, 1214];
      var bdv = [2.6, 2.0, 1.5, 1.0, 0.7];
      var bgv = [0.24, 0.20, 0.14, 0.09, 0.05];
      for (j = 0; j < 5; j++) {
        var ob = OSC('sine', bfv[j] * (0.995 + Math.random() * 0.01), t + 0.006);
        var gb = G(0.0001);
        ob.connect(gb); gb.connect(out);
        env(gb, t + 0.006, bgv[j], 0.002, bdv[j]);
        ob.start(t + 0.006); ob.stop(t + bdv[j] + 0.22);
        nodes.push(ob, gb);
      }
      reap(nodes, t + 3.3, out);
      return;
    }

    /* 'dread' -- minor 2nd, 13.8 Hz beat, gliding down 300 cents */
    out.connect(musicBus);
    var sd = G(0.30); out.connect(sd); sd.connect(revSend); nodes.push(sd);
    var ws = WS(tanhCurve(18), '2x');
    var lp2 = BQ('lowpass', 1400, 4);
    var g2 = G(0.0001);
    ws.connect(lp2); lp2.connect(g2); g2.connect(out);
    var sb2 = G(0.6); g2.connect(sb2); sb2.connect(subBus);
    try {
      lp2.frequency.setValueAtTime(1400, t);
      lp2.frequency.exponentialRampToValueAtTime(300, t + 0.7);
    } catch (e) {}
    var fr = [233.1, 246.9, 116.5], lvv = [0.30, 0.30, 0.24];
    for (var m = 0; m < 3; m++) {
      var oo = OSC('sawtooth', fr[m], t);
      try { oo.detune.setValueAtTime(0, t); oo.detune.linearRampToValueAtTime(-300, t + 0.9); } catch (e) {}
      var ggg = G(lvv[m]);
      oo.connect(ggg); ggg.connect(ws);
      oo.start(t); oo.stop(t + 1.35);
      nodes.push(oo, ggg);
    }
    try {
      var pp = g2.gain;
      pp.setValueAtTime(0.0001, t);
      pp.linearRampToValueAtTime(0.70, t + 0.008);
      pp.linearRampToValueAtTime(0.20, t + 0.25);
      pp.exponentialRampToValueAtTime(0.0001, t + 1.10);
    } catch (e) {}
    var nn = NZ(BUF_W, t, 0.02), hh = BQ('highpass', 3000, 0.7), nng = G(0.0001);
    nn.connect(hh); hh.connect(nng); nng.connect(out);
    env(nng, t, 0.30, 0.0008, 0.03);
    nodes.push(ws, lp2, g2, sb2, nn, hh, nng);
    reap(nodes, t + 1.7, out);
  };

  /* ----------------------------------------------------------------- RISER */
  api.riser = function (durationSec) {
    var D = clamp(durationSec === undefined ? 8 : durationSec, 1, 30);
    if (!ok()) return D;
    var t = T() + 0.01;
    riserActive = true; riserEnd = t + D + 0.40;
    try {
      var p = drGain.gain;
      p.cancelScheduledValues(t); p.setValueAtTime(Math.max(0.0001, fin(p.value, 0.0001)), t);
      p.linearRampToValueAtTime(0.12, t + 0.25);
      p.linearRampToValueAtTime(0.34, t + D);
      p.linearRampToValueAtTime(0.06, t + D + 0.30);

      var f = drLP.frequency;
      f.cancelScheduledValues(t); f.setValueAtTime(Math.max(20, fin(f.value, 260)), t);
      f.exponentialRampToValueAtTime(260, t + 0.2);
      f.exponentialRampToValueAtTime(1800, t + D);
      f.exponentialRampToValueAtTime(400, t + D + 0.35);

      var pf = drPulse.frequency;
      pf.cancelScheduledValues(t); pf.setValueAtTime(Math.max(0.05, fin(pf.value, 1.2)), t);
      pf.exponentialRampToValueAtTime(1.2, t + 0.2);
      pf.exponentialRampToValueAtTime(6.0, t + D);      /* accelerating pulse */
      var pgd = drPulseG.gain;
      pgd.cancelScheduledValues(t); pgd.setValueAtTime(Math.max(0.0001, fin(pgd.value, 0.0001)), t);
      pgd.linearRampToValueAtTime(0.10, t + D * 0.6);
      pgd.linearRampToValueAtTime(0.0001, t + D + 0.30);

      var nf = drNoiseBP.frequency;
      nf.cancelScheduledValues(t); nf.setValueAtTime(Math.max(20, fin(nf.value, 400)), t);
      nf.exponentialRampToValueAtTime(400, t + 0.2);
      nf.exponentialRampToValueAtTime(4000, t + D);
      var ngd = drNoiseG.gain;
      ngd.cancelScheduledValues(t); ngd.setValueAtTime(Math.max(0.0001, fin(ngd.value, 0.0001)), t);
      ngd.linearRampToValueAtTime(0.03, t + 0.3);
      ngd.linearRampToValueAtTime(0.14, t + D);
      ngd.linearRampToValueAtTime(0.0001, t + D + 0.30);

      /* Shepard: three octaves glide up exactly 1200 cents. The gain window
         (low fades IN, high fades OUT) is what hides the octave reset and
         makes the rise feel like it never resolves. */
      var peak = [0.052, 0.048, 0.040];
      for (var i = 0; i < 3; i++) {
        var o = shepOscs[i], g = shepGains[i];
        o.detune.cancelScheduledValues(t);
        o.detune.setValueAtTime(0, t);
        o.detune.linearRampToValueAtTime(1200, t + D);
        var gp2 = g.gain;
        gp2.cancelScheduledValues(t);
        gp2.setValueAtTime(Math.max(0.0001, fin(gp2.value, 0.0001)), t);
        if (i === 0) {                      /* lowest: fades in as it rises   */
          gp2.linearRampToValueAtTime(0.0001, t + 0.12);
          gp2.linearRampToValueAtTime(peak[0], t + D * 0.85);
          gp2.linearRampToValueAtTime(0.0001, t + D + 0.22);
        } else if (i === 1) {               /* middle: the body               */
          gp2.linearRampToValueAtTime(peak[1] * 0.35, t + 0.30);
          gp2.linearRampToValueAtTime(peak[1], t + D * 0.55);
          gp2.linearRampToValueAtTime(0.0001, t + D + 0.22);
        } else {                            /* highest: fades out as it rises */
          gp2.linearRampToValueAtTime(peak[2], t + 0.30);
          gp2.linearRampToValueAtTime(0.0001, t + D * 0.9);
        }
        o.detune.setValueAtTime(0, t + D + 0.32);
      }
    } catch (e) {}
    return D;
  };

  /* --------------------------------------------------------------- STOPALL */
  api.stopAll = function () {
    hbOn = false; clackOn = false; riserActive = false;
    screechEnd = -1; dopplerEnd = -1;
    if (!ok()) return;
    var now = T(), i;
    /* duck every live one-shot's own output, then let the sweep reap it */
    for (i = 0; i < live.length; i++) {
      if (live[i].g && live[i].g.gain) {
        try {
          var p = live[i].g.gain;
          if (p.cancelAndHoldAtTime) { try { p.cancelAndHoldAtTime(now); } catch (e) { p.cancelScheduledValues(now); } }
          else p.cancelScheduledValues(now);
          p.setValueAtTime(Math.max(0.0001, fin(p.value, 0.0001)), now);
          p.linearRampToValueAtTime(0.0001, now + 0.07);
        } catch (e) {}
      }
      live[i].t = Math.min(live[i].t, now + 0.22);
    }
    /* kill every long-lived automation, not just the levels */
    cancelParam(drLP.frequency); cancelParam(drPulse.frequency);
    cancelParam(drNoiseBP.frequency); cancelParam(ambLP.frequency);
    cancelParam(ambBus.gain); cancelParam(rumbleBus.gain);
    ramp(ambBus.gain, 1.0, 0.12); ramp(rumbleBus.gain, 1.0, 0.12);
    ramp(hbGain.gain, 0.0001, 0.08);
    ramp(drGain.gain, 0.0001, 0.15);
    ramp(drNoiseG.gain, 0.0001, 0.15);
    ramp(drPulseG.gain, 0.0001, 0.10);
    for (i = 0; i < shepGains.length; i++) {
      ramp(shepGains[i].gain, 0.0001, 0.15);
      try { shepOscs[i].detune.cancelScheduledValues(now); shepOscs[i].detune.setValueAtTime(0, now + 0.2); } catch (e) {}
    }
    ramp(rumAmb.gain, 0.0001, 0.25);
    ramp(windAmb.gain, 0.0001, 0.25);
    ambKind = 'none';
    /* stopAll() is an explicit teardown, so it MUST leave the mix audible.
       Deferring to an in-flight silence() meant masterGain could sit at
       0.0001 for up to 12 s into whatever came next, with nothing scheduled
       to bring it back and nothing else in the module that touches
       masterGain -- unrecoverable in a classroom. (stopAll already resets
       screechEnd and dopplerEnd; silenceEnd was simply missed.) Restore
       either way; just take 0.4 s rather than 0.25 s when cutting a silence
       short, so it still reads as a fade and not as a hole punched in the
       hold. ramp() anchors with cancelAndHoldAtTime, so the pending restore
       ramp that silence() scheduled is cancelled cleanly. */
    var inSilence = now <= silenceEnd;
    silenceEnd = -1;
    ramp(masterGain.gain, 1.0, inSilence ? 0.40 : 0.25);
  };

  /* ------------------------------------------------------ suspend / resume */
  api.suspend = function () {
    if (!ctx) return;
    intentionalSuspend = true;
    try { var p = ctx.suspend(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
  };
  api.resume = function () {
    if (!ctx) return;
    intentionalSuspend = false;
    try { var p = ctx.resume(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
    /* currentTime froze while hidden -> re-anchor every lookahead scheduler,
       or we dump a burst of back-scheduled beats and clacks */
    try {
      hbNext = T() + 0.12;
      clackNext = T() + 0.12;
      lastSweep = -1;
      lastSpeedApply = -1;
    } catch (e) {}
    /* Re-assert every gain the mix could be stuck at zero on. ctx.suspend()
       freezes currentTime, so a silence() caught mid-hold should resume its
       own automation correctly -- but nothing GUARANTEES that, and a mix
       stuck silent for the rest of a lesson is unrecoverable in a classroom.
       This is two ramps and costs nothing. */
    try {
      if (ok()) {
        ramp(outGain.gain, muted ? 0.0001 : Math.max(0.0001, userVol), 0.12);
        if (T() > silenceEnd) ramp(masterGain.gain, 1.0, 0.20);
      }
    } catch (e) {}
    var tries = 0;
    (function poll() {
      if (!ctx) return;
      if (ctx.state === 'running') {
        api.ready = true;
        try { if (ok() && T() > silenceEnd) ramp(masterGain.gain, 1.0, 0.20); } catch (e) {}
        return;
      }
      if (++tries < 20) { setTimeout(poll, 120); return; }
      /* Chrome refuses resume() without a gesture if the context was never
         properly unlocked. Say so instead of leaving api.ready true over a
         dead mix, drop the memoised promise so a later unlock() really
         retries, and re-arm the first-gesture listener so the next tap
         anywhere in the room rescues the audio. (Nothing in the build reads
         SFX.ready, so setting it false cannot gate any UI -- it is purely an
         honest report.) */
      api.ready = false;
      unlockP = null;
      try { armGesture(); } catch (e) {}
    })();
  };

  /* ---------------------------------------------- visibility + statechange */
  try {
    document.addEventListener('visibilitychange', function () {
      try {
        if (document.hidden) { api.suspend(); }
        else { api.resume(); }
      } catch (e) {}
    }, false);
  } catch (e) {}

  /* Safety net: bind unlock to the first gesture. The director should still
     call SFX.unlock() explicitly from the role-select button. */
  /* Re-armable, so api.resume() can put it back after Chrome has refused a
     resume() -- otherwise a context that fails to come back from a tab-hide
     is silent for the rest of the lesson with no way for anyone to fix it.
     This is a function DECLARATION, so it is hoisted and api.resume (defined
     earlier in the file) can call it. gestureArmed stops a re-arm stacking a
     second set of listeners. Behaviour on first load is unchanged. */
  function armGesture() {
    if (gestureArmed || dead) return;
    gestureArmed = true;
    var attempts = 0;
    function once() {
      attempts++;
      try { api.unlock(); } catch (e) {}
      if ((ctx && ctx.state === 'running') || dead || attempts > 30) {
        gestureArmed = false;
        try {
          window.removeEventListener('pointerdown', once, true);
          window.removeEventListener('touchend', once, true);
          window.removeEventListener('keydown', once, true);
          window.removeEventListener('click', once, true);
        } catch (e) {}
      }
    }
    try {
      window.addEventListener('pointerdown', once, { capture: true, passive: true });
      window.addEventListener('touchend', once, { capture: true, passive: true });
      window.addEventListener('keydown', once, { capture: true, passive: true });
      window.addEventListener('click', once, { capture: true, passive: true });
    } catch (e) {
      try {
        window.addEventListener('pointerdown', once, true);
        window.addEventListener('keydown', once, true);
      } catch (e2) {}
    }
  }
  armGesture();

  return api;
})();