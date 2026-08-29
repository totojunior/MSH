/* =========================================================================
   MODULE: worldB  —  SCENE B, THE BRIDGE
   Declares exactly one global: WorldB
   Everything else lives inside this IIFE. No imports, no requires.
   Works on three.js r134 (UMD, no ColorManagement) and r160 (UMD) alike:
   every version-sensitive API is feature-detected.
   ========================================================================= */
var WorldB = (function () {
  'use strict';

  var TH = (typeof THREE !== 'undefined' && THREE) ? THREE : null;
  /* r155+ is physically correct by default: point lights are in candela and
     need ~20x the old numbers. r134 is not. One flag, checked once. */
  var PHYS_LIGHTS = !!(TH && TH.ColorManagement);
  /* r134 legacy lighting: intensity is a PLAIN MULTIPLIER, not candela. 2.4
     with distance 46 / decay 2 puts a readable pool on the ballast ahead of
     the nose now that the ambient fill has been cut to 0.24. */
  var HEADLAMP_I = PHYS_LIGHTS ? 26 : 2.4;

  /* ======================================================================
     CONSTANTS — the geography of the scene
     ====================================================================== */
  var FOG_HEX      = 0x0b1016;
  var DECK_Y       = 6.90;      // top surface of the bridge deck
  var DECK_HX      = 9.0;       // deck half-length across the track (X)
  var DECK_HZ      = 1.55;      // deck half-width along the track (Z)
  var RAIL_TOP     = DECK_Y + 1.16;
  var GAUGE        = 0.7175;    // half of 1.435 m standard gauge
  var RAILHEAD_Y   = 0.42;      // top of rail above ballast datum (y=0)
  var BALLAST_Y    = 0.26;      // top of sleeper / ballast crown

  /* WHERE THE VIEWER STANDS. Was (-1.10, 0.62): 1.51 m from him and only
     0.44 m behind the line of his shoulders, which is why he filled the left
     HALF of the frame as one dark mass with the top edge cutting his head.
     Round 2 moved to (-1.47, -0.37) - 2.30 m from him - and he STILL filled
     80% of the frame height with his boots 7% off the bottom edge. That is
     what makes a figure read as scenery: no air over the head, no deck
     under the feet, nothing beside him to measure him against.
     Now (-2.09, -0.86): 3.10 m from him, straight back along the SAME ray.
     That is the one move here that costs nothing. The turn he has to make
     to find the lens depends on the BEARING from him to the camera, not on
     the distance, and this is the round-2 bearing to four decimals
     (-0.7846, -0.6199), so the look-back is still 108.3 deg of neck and
     shoulder - not one degree more. What the extra 0.80 m buys is the whole
     man at 61% of the frame height, 21% of clear air over his head, 19% of
     lit deck under his boots, and two thirds of the frame width open past
     him for the rail, the track and the five. Still standing on the deck:
     z -0.86 against a deck edge at -1.55.
     One consequence to hold on to for any later edit: that bearing puts the
     lens 72 deg round from straight behind him - nearer his left side than
     his back - so on screen his DEPTH front-to-back does more of his
     outline than his width across, and his two legs, set side by side
     across his shoulder axis, project almost on top of one another. Both
     are answered below: the coat holds one depth ratio all the way up, and
     his stance is staggered along his facing instead of across it.
     See MAN_YAW. */
  var PLAYER_X     = -2.09, PLAYER_Z = -0.86;
  var EYE_Y        = DECK_Y + 1.62;
  var MAN_X        = 0.34,  MAN_Z    = 1.06;
  /* He does not stand square to the rail: 20 deg turned toward our side of
     the deck. Two things fall out of that one number. (1) We see a rear
     THREE-QUARTER instead of a flat back - the shoulder line reads in
     perspective, the near arm runs away along the rail, the jaw shows at the
     edge of the head. A flat back is a wall; a three-quarter back is a man.
     (2) It PAYS FOR 20 deg of the look-back, which is what lets the camera
     stand 1.43 m behind his shoulders and still have him find the lens on a
     110.9 deg turn - the same neck load, to the degree, as before.
     Body.localSkeleton() compensates the 'lean' hands for it: his hands are
     on a handrail that does not turn with him. */
  var MAN_YAW      = -0.35;
  /* The five, down the line. Was 69 m, then 50. Measured, not estimated: at
     50 m through the old bridge lens their view-axis depth was 40.8 m, so a
     1.8 m worker stood 29 px tall at 1280x720 - but at ndc x +0.66, in the
     outer sixth of the frame, with FogExp2 hiding 0.32 of him. At 44 m
     through the recomposed lens the depth is 40.3 m: 32 px tall, at ndc x
     +0.47, INSIDE the right third and a shade below the line of his
     shoulders, with the fog hiding 0.25. Their vests measure rgb(164,105,48)
     through the ACES composite - the only saturated warm thing in the shot.
     Still plainly far away: 44 m is sixty sleepers between him and them.
     Every other use of this constant is an offset from it (WPOS, the
     trolley's run-past, impact('five')), so nothing else has to move. */
  var WORKERS_Z    = 44.0;
  var TRACK_FAR    = 132.0;     // how far the track is built forward
  var TRACK_BACK   = -96.0;     // and backward

  var COL = {
    /* STRUCTURE IS LAST IN THE VALUE HIERARCHY. r134 hands a material colour
       to the shader as LINEAR, so every hex here is a linear albedo and the
       sRGB output curve lifts it hard - which is why concrete and painted
       steel ended up the lightest things in the bridge shot, above the man's
       rim and above the vests. The whole structural palette comes down here,
       the palest cut hardest (railTop -33%, paintOld -30%, concrete -25%)
       and the already-dark cut least (-17..-21%), so the palette keeps its
       internal separation and only its TOP is removed. Read order in frame
       is now: the orange vests, then his rim, then the world he stands in.
       rust comes down with the rest: it is the only other warm albedo in the
       scene and must never sit near the hi-vis. */
    steel:    0x232a33,
    steelHi:  0x2c3441,
    rust:     0x3c2f26,
    paint:    0x2c3a41,
    paintOld: 0x3a444b,
    concrete: 0x272d34,
    concDark: 0x1d2229,
    ballast:  0x161b23,
    railTop:  0x454e58,
    railWeb:  0x21262d,
    /* HIS ALBEDOS, lifted for the projector. Nothing in this rig lights a
       surface that faces the lens except the sky term, so at the old values
       his coat resolved to rgb(1,3,7) through the ACES + sRGB composite -
       not a dark man, a hole - while his ARMS AND LEGS, which are the shared
       limb material at 0x252c35, sat three times brighter than the coat they
       belong to. Matching the coat to the limbs and lighting him (see the
       rim and bounce below) puts his mass at rgb(14,22,32): still the
       darkest large shape in frame, still far under the fog at rgb(44,60,78),
       but with a front, a back and a shoulder in it. */
    coat:     0x252c37,
    coatHi:   0x323b47,
    trouser:  0x202632,
    skin:     0x8e9aa6,
    hair:     0x232935,
    vest:     0xff6a10,
    /* the emissive floor under the hi-vis. Raised with the ambient cut: the
       hemisphere fill that used to light the workers' fronts was BLUE, so
       replacing it with saturated orange emissive keeps them at the same
       brightness through the fog while making them MORE orange, not less. */
    vestDim:  0x582208,
    tram:     0x232a33,
    tramHi:   0x2f3742,
    glass:    0x0d141c,
    /* r134 has NO colour management: a MeshBasicMaterial colour is handed to
       the framebuffer as LINEAR and the renderer's sRGB output curve lifts it
       hard. 0xdfe9f5 lands at ~rgb(241,244,249) - a clipped white hole that
       out-shouts the one warm colour in the film; 0x2c3440 lands at
       ~rgb(116,125,137) - a pale grey ribbon flapping off the hero's neck
       while his lit coat sits at rgb(14,20,28). Both are authored DOWN so an
       unlit surface lands where a lit surface of the same read would land:
         lamp  0x8aa8cc -> ~rgb(190,207,226) still the brightest thing, but
                           cold and no longer competing with the vests
         scarf 0x030508 -> ~rgb( 30, 38, 50) sits with the coat, not on top
                           of it. (Kept unlit on purpose: the scarf ribbon
                           has no normal attribute, so a lit material would
                           shade from a zero normal.) */
    lamp:     0x8aa8cc,
    scarf:    0x030508,
    bag:      0x3a4048
  };

  /* ======================================================================
     SMALL SAFE HELPERS
     ====================================================================== */
  function safe(fn, d) { try { return fn(); } catch (e) { return d; } }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smooth(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function rnd(a, b) { return a + Math.random() * (b - a); }

  /* scratch — allocated once, reused in every per-frame loop */
  var _v1, _up, _fwd;
  var _scratched = false;
  function scratch() {
    if (_scratched || !TH) return;
    _v1 = new TH.Vector3();
    _up = new TH.Vector3(0, 1, 0);
    _fwd = new TH.Vector3(0, 0, 1);
    _scratched = true;
  }

  function colorOf(hex) { return new TH.Color(hex); }

  function markColorTexture(t) {
    if (!t) return t;
    try {
      if (TH.SRGBColorSpace && ('colorSpace' in t)) t.colorSpace = TH.SRGBColorSpace;
      else if (TH.sRGBEncoding && ('encoding' in t)) t.encoding = TH.sRGBEncoding;
    } catch (e) {}
    return t;
  }
  function markDataTexture(t) {
    if (!t) return t;
    try {
      if (TH.NoColorSpace !== undefined && ('colorSpace' in t)) t.colorSpace = TH.NoColorSpace;
    } catch (e) {}
    return t;
  }

  /* ----------------------------------------------------------------------
     MANUAL GEOMETRY MERGE (BufferGeometryUtils does not exist in the core
     UMD build of either r134 or r160 — we merge by hand).
     parts: [{ g:BufferGeometry, m:Matrix4|null, c:THREE.Color|null }]
     Produces one BufferGeometry with position / normal / uv / color.
     ---------------------------------------------------------------------- */
  function mergeParts(parts) {
    var i, k, total = 0, list = [];
    for (i = 0; i < parts.length; i++) {
      var src = parts[i] && parts[i].g;
      if (!src) continue;
      var g;
      try { g = src.index ? src.toNonIndexed() : src.clone(); } catch (e) { continue; }
      if (parts[i].m) { try { g.applyMatrix4(parts[i].m); } catch (e) {} }
      if (!g.attributes.normal) { try { g.computeVertexNormals(); } catch (e) {} }
      if (!g.attributes.position) continue;
      list.push({ g: g, c: parts[i].c || null });
      total += g.attributes.position.count;
    }
    var pos = new Float32Array(total * 3), nor = new Float32Array(total * 3);
    var uv = new Float32Array(total * 2), col = new Float32Array(total * 3);
    var o = 0;
    for (i = 0; i < list.length; i++) {
      var a = list[i].g;
      var ap = a.attributes.position.array;
      var an = a.attributes.normal ? a.attributes.normal.array : null;
      var au = a.attributes.uv ? a.attributes.uv.array : null;
      var n = a.attributes.position.count;
      pos.set(ap.subarray ? ap.subarray(0, n * 3) : ap, o * 3);
      if (an) nor.set(an.subarray ? an.subarray(0, n * 3) : an, o * 3);
      if (au) uv.set(au.subarray ? au.subarray(0, n * 2) : au, o * 2);
      var c = list[i].c;
      var r = c ? c.r : 1, gg = c ? c.g : 1, bb = c ? c.b : 1;
      for (k = 0; k < n; k++) { col[(o + k) * 3] = r; col[(o + k) * 3 + 1] = gg; col[(o + k) * 3 + 2] = bb; }
      o += n;
      try { a.dispose(); } catch (e) {}
    }
    var out = new TH.BufferGeometry();
    out.setAttribute('position', new TH.BufferAttribute(pos, 3));
    out.setAttribute('normal', new TH.BufferAttribute(nor, 3));
    out.setAttribute('uv', new TH.BufferAttribute(uv, 2));
    out.setAttribute('color', new TH.BufferAttribute(col, 3));
    try { out.computeBoundingSphere(); } catch (e) {}
    return out;
  }

  function mat4(px, py, pz, rx, ry, rz, sx, sy, sz) {
    var m = new TH.Matrix4();
    var q = new TH.Quaternion();
    var e = new TH.Euler(rx || 0, ry || 0, rz || 0, 'XYZ');
    q.setFromEuler(e);
    m.compose(new TH.Vector3(px || 0, py || 0, pz || 0), q,
      new TH.Vector3(sx === undefined ? 1 : sx, sy === undefined ? 1 : sy, sz === undefined ? 1 : sz));
    return m;
  }

  /* ======================================================================
     PROCEDURAL CANVAS TEXTURES
     ====================================================================== */
  function cv(size) {
    var c = document.createElement('canvas');
    c.width = c.height = size;
    return c;
  }

  function texRivetPlate() {
    var s = 256, c = cv(s), g = c.getContext('2d');
    g.fillStyle = '#333c46'; g.fillRect(0, 0, s, s);
    /* mottled steel */
    var i, x, y;
    for (i = 0; i < 2600; i++) {
      x = Math.random() * s; y = Math.random() * s;
      var v = 40 + Math.random() * 40;
      g.fillStyle = 'rgba(' + (v | 0) + ',' + ((v + 8) | 0) + ',' + ((v + 16) | 0) + ',0.35)';
      g.fillRect(x, y, 1 + Math.random() * 3, 1 + Math.random() * 3);
    }
    /* plate seams */
    g.strokeStyle = 'rgba(14,18,24,0.85)'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(0, s * 0.5); g.lineTo(s, s * 0.5);
    g.moveTo(s * 0.5, 0); g.lineTo(s * 0.5, s); g.stroke();
    g.strokeStyle = 'rgba(64,74,86,0.26)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, s * 0.5 + 2); g.lineTo(s, s * 0.5 + 2);
    g.moveTo(s * 0.5 + 2, 0); g.lineTo(s * 0.5 + 2, s); g.stroke();
    /* rivets on the seams */
    function rivet(rx, ry) {
      var grd = g.createRadialGradient(rx - 1.2, ry - 1.2, 0.3, rx, ry, 4.2);
      grd.addColorStop(0, 'rgba(96,106,118,0.88)');
      grd.addColorStop(0.55, 'rgba(52,60,69,0.90)');
      grd.addColorStop(1, 'rgba(20,25,32,0.0)');
      g.fillStyle = grd;
      g.beginPath(); g.arc(rx, ry, 4.2, 0, 6.2832); g.fill();
    }
    for (i = 0; i < 22; i++) { rivet((i + 0.5) * (s / 22), s * 0.5); rivet(s * 0.5, (i + 0.5) * (s / 22)); }
    for (i = 0; i < 22; i++) { rivet((i + 0.5) * (s / 22), 3); rivet(3, (i + 0.5) * (s / 22)); }
    /* anti-slip tread pattern */
    g.strokeStyle = 'rgba(20,26,33,0.30)'; g.lineWidth = 2;
    for (i = 0; i < 26; i++) {
      var yy = i * (s / 26) + 4;
      g.beginPath(); g.moveTo(6, yy); g.lineTo(s - 6, yy); g.stroke();
    }
    /* wear patches */
    for (i = 0; i < 14; i++) {
      x = Math.random() * s; y = Math.random() * s;
      var rr = 8 + Math.random() * 26;
      var gr = g.createRadialGradient(x, y, 0, x, y, rr);
      gr.addColorStop(0, 'rgba(70,60,48,0.25)');
      gr.addColorStop(1, 'rgba(70,60,48,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, rr, 0, 6.2832); g.fill();
    }
    var t = new TH.CanvasTexture(c);
    t.wrapS = t.wrapT = TH.RepeatWrapping;
    t.generateMipmaps = false;
    t.minFilter = TH.LinearFilter; t.magFilter = TH.LinearFilter;
    markColorTexture(t);
    t.needsUpdate = true;
    return t;
  }

  function texBallast() {
    var s = 256, c = cv(s), g = c.getContext('2d');
    g.fillStyle = '#1a212a'; g.fillRect(0, 0, s, s);
    var i;
    for (i = 0; i < 4200; i++) {
      var x = Math.random() * s, y = Math.random() * s, r = 1 + Math.random() * 3.2;
      var v = 26 + Math.random() * 46;
      g.fillStyle = 'rgb(' + (v | 0) + ',' + ((v + 5) | 0) + ',' + ((v + 11) | 0) + ')';
      g.beginPath();
      g.moveTo(x, y - r);
      g.lineTo(x + r * 0.9, y - r * 0.2);
      g.lineTo(x + r * 0.5, y + r * 0.9);
      g.lineTo(x - r * 0.6, y + r * 0.7);
      g.lineTo(x - r, y - r * 0.3);
      g.closePath(); g.fill();
    }
    for (i = 0; i < 500; i++) {
      var x2 = Math.random() * s, y2 = Math.random() * s;
      g.fillStyle = 'rgba(84,94,106,0.14)';
      g.fillRect(x2, y2, 1.5, 1.5);
    }
    var t = new TH.CanvasTexture(c);
    t.wrapS = t.wrapT = TH.RepeatWrapping;
    t.generateMipmaps = false;
    t.minFilter = TH.LinearFilter; t.magFilter = TH.LinearFilter;
    markColorTexture(t);
    t.needsUpdate = true;
    return t;
  }

  function texMeshPanel() {
    var s = 128, c = cv(s), g = c.getContext('2d');
    g.clearRect(0, 0, s, s);
    g.strokeStyle = 'rgba(92,103,115,1)';
    g.lineWidth = 3.2;
    var i, step = s / 8;
    for (i = 0; i <= 8; i++) {
      g.beginPath(); g.moveTo(0, i * step); g.lineTo(s, i * step); g.stroke();
      g.beginPath(); g.moveTo(i * step, 0); g.lineTo(i * step, s); g.stroke();
    }
    /* a little corrosion so it is not a perfect grid */
    for (i = 0; i < 40; i++) {
      g.fillStyle = 'rgba(58,44,32,0.55)';
      g.fillRect(Math.random() * s, Math.random() * s, 2 + Math.random() * 4, 2 + Math.random() * 4);
    }
    var t = new TH.CanvasTexture(c);
    t.wrapS = t.wrapT = TH.RepeatWrapping;
    t.generateMipmaps = false;
    t.minFilter = TH.LinearFilter; t.magFilter = TH.LinearFilter;
    markColorTexture(t);
    t.needsUpdate = true;
    return t;
  }

  function texSoftDot() {
    var s = 64, c = cv(s), g = c.getContext('2d');
    var gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.35, 'rgba(255,255,255,0.62)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
    var t = new TH.CanvasTexture(c);
    t.generateMipmaps = false;
    t.minFilter = TH.LinearFilter; t.magFilter = TH.LinearFilter;
    markColorTexture(t);
    t.needsUpdate = true;
    return t;
  }

  function texBlob() {
    var s = 64, c = cv(s), g = c.getContext('2d');
    var gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, 'rgba(255,255,255,0.95)');
    gr.addColorStop(0.5, 'rgba(255,255,255,0.45)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
    var t = new TH.CanvasTexture(c);
    t.generateMipmaps = false;
    t.minFilter = TH.LinearFilter; t.magFilter = TH.LinearFilter;
    markColorTexture(t);
    t.needsUpdate = true;
    return t;
  }

  /* ======================================================================
     VERLET BODY — 15 particles, 26 constraints.  Used for both the posed
     standing figures and the ragdolls; the same limb writer draws both.
     ====================================================================== */
  var P_HEAD = 0, P_NECK = 1, P_CHL = 2, P_CHR = 3, P_PLL = 4, P_PLR = 5,
      P_ELL = 6, P_ELR = 7, P_HNL = 8, P_HNR = 9, P_KNL = 10, P_KNR = 11,
      P_FTL = 12, P_FTR = 13, P_CORE = 14;

  var LIMBS = [
    [P_PLL, P_CHL, 0.100], [P_PLR, P_CHR, 0.100],
    [P_CHL, P_CHR, 0.078], [P_PLL, P_PLR, 0.088],
    [P_NECK, P_HEAD, 0.062],
    [P_CHL, P_ELL, 0.072], [P_ELL, P_HNL, 0.058],
    [P_CHR, P_ELR, 0.072], [P_ELR, P_HNR, 0.058],
    [P_PLL, P_KNL, 0.098], [P_KNL, P_FTL, 0.078],
    [P_PLR, P_KNR, 0.098], [P_KNR, P_FTR, 0.078]
  ];
  var LIMB_N = LIMBS.length;   /* 13 */

  var RD_G      = -15.0;
  var RD_DAMP   = 0.994;
  /* WHOLE-BODY ground drag. This is the single line that stopped anything in
     this scene from ever tumbling: it lived inside the solver iteration
     loop, so it ran TEN times per 1/60 s substep - 0.86^10 = 0.221 - and the
     instant one toe touched the ballast the entire body stopped dead.
     Now applied once per substep (see collide) AND relaxed: even once per
     substep, 0.86 is a 0.066 s time constant, still a brick wall. 0.988 per
     1/60 s = 0.485 per second, a 1.18 s time constant - a rolling drag. */
  var RD_GDAMP  = 0.988;
  var RD_ITER   = 10;
  /* COULOMB ground friction, m/s of TANGENTIAL velocity removed per second
     of contact, per contacting particle. Velocity independent, so a slide
     decelerates linearly and reaches exact zero rather than decaying
     forever. Applied once per substep, not once per solver iteration: the
     old fractional 0.72 ran ten times a step and removed 99.9997% of the
     slide on first touch. Same value as Scene A, so the two scenes agree
     about what ballast feels like. */
  var RD_FRICA  = 32.0;
  var RD_REST   = 0.20;
  var RD_RAD    = 0.09;
  /* 0.42 m per 1/60 s = 25 m/s. The binding case is not the heavy man - he
     arrives at sqrt(2 * 15 * 1.35 * 6.6) = 16.3 m/s, which 0.30 already
     cleared - it is the five, now launched at up to 17 m/s with a 1.35
     upper-body bias = 23 m/s, and the tram nose, which can now shove at
     20 * 0.85 = 17 m/s. 0.30 would have clipped both back to 18. */
  var RD_MAXSTEP = 0.42;
  var RD_H      = 1 / 60;

  function Body(opts) {
    opts = opts || {};
    this.n = 15;
    this.x = new Float32Array(45);
    this.p = new Float32Array(45);
    this.w = new Float32Array(15);
    this.snap = new Float32Array(45);
    this.c = [];
    this.mode = 'pose';
    this.dead = false;
    this.asleep = false;
    this.stillCount = 0;
    this.grounded = false;
    this.snapAge = 0;

    this.rx = opts.x || 0; this.ry = opts.y || 0; this.rz = opts.z || 0;
    this.yaw = opts.yaw || 0;
    this.hs = (opts.height || 1.78) / 1.78;
    this.wide = opts.wide || 1.0;
    this.heavy = !!opts.heavy;
    this.pose = opts.pose || 'idle';
    this.phase = Math.random() * 6.2832;
    this.lean = 0;         /* extra forward lean, radians (push strain) */
    this.brace = 0;
    this.headYaw = 0;
    this.headPitch = 0;
    this.twist = 0;        /* shoulder twist when he looks back */
    this.tool = (opts.tool !== undefined) ? opts.tool : false;
    this.toolPhase = Math.random() * 6.2832;
    this.support = 0;      /* how long the rail still catches him */
    this.groundY = opts.groundY || 0;
    this.trolleyHit = false;
    /* the heavy man falls under a harder gravity than everyone else: that
       single number is what makes 130 kg read as 130 kg */
    this.gScale = opts.gScale || (this.heavy ? 1.35 : 1.0);
    this.troImmune = 0;   /* seconds during which the tram sweeps past him */
    /* 0..1: how much he knows he is being watched. Drives the breath: it
       gets faster, shallower and higher in the chest as he turns round. */
    this.alert = 0;
    /* 0..1: how much he knows he is being watched. Drives the breath: it
       gets faster, shallower and higher in the chest as he turns round. */
    this.alert = 0;
    /* breath phase, ACCUMULATED (see localSkeleton), plus the t it last
       advanced at, so a change of breathing rate never jumps the phase */
    this.bPh = this.phase * 0.16;
    this.bT = 0;

    /* inverse masses that read as human weight */
    var w = this.w;
    w[P_HEAD] = 1.1; w[P_NECK] = 1.0;
    w[P_CHL] = 0.8; w[P_CHR] = 0.8;
    w[P_PLL] = 0.7; w[P_PLR] = 0.7; w[P_CORE] = 0.6;
    w[P_ELL] = 1.6; w[P_ELR] = 1.6;
    w[P_HNL] = 2.4; w[P_HNR] = 2.4;
    w[P_KNL] = 1.2; w[P_KNR] = 1.2;
    w[P_FTL] = 2.0; w[P_FTR] = 2.0;
    if (this.heavy) { for (var i = 0; i < 15; i++) w[i] *= 0.55; }

    this.local = new Float32Array(45);
    this.writePose(0);
    this.buildConstraints();
    this.p.set(this.x);
    this.snap.set(this.x);
  }

  /* canonical local skeleton, facing +Z, feet at y=0 ------------------- */
  Body.prototype.localSkeleton = function (t) {
    var S = this.hs, W = this.wide;
    var L = this.local;
    /* BREATHING is a cycle, not a sine: a slow draw in, a faster release, a
       pause at the bottom. When the only thing the audience can see is a
       back, this IS the performance. The heavy man breathes deeper (0.031 m
       of chest travel against the workers' 0.012) and slower (a 4.3 s cycle
       against 3.0 s) - the mass is in the timing as much as in the width. */
    var alert = this.alert || 0;
    var bRate = (this.heavy ? 0.233 : 0.335) * (1 + alert * 0.75);
    /* Accumulate the phase from the rate. Computing it as t * bRate looks
       equivalent and is not: alert CHANGES bRate, and t * bRate then jumps
       by t * dRate. Sixty seconds into the beat that is ten whole breath
       cycles crammed into the 1.4 s head turn - his chest flutters like a
       bird at the exact moment the audience is looking at him. */
    var bDt = t - this.bT;
    if (!(bDt > 0) || bDt > 0.5) bDt = 0;
    this.bT = t;
    this.bPh += bDt * bRate;
    var bPh = this.bPh;
    var bf = bPh - Math.floor(bPh);
    var bAmt = bf < 0.42 ? smooth(bf / 0.42)
             : (bf < 0.80 ? 1 - smooth((bf - 0.42) / 0.38) : 0);
    var breathe = bAmt * (this.heavy ? 0.031 : 0.012) * (1 - alert * 0.30);
    /* the ribcage also OPENS on the inhale - from directly behind, the
       shoulders widening is more readable than the chest rising */
    var chestOpen = 1 + bAmt * (this.heavy ? 0.062 : 0.026) * (1 - alert * 0.30);
    /* WEIGHT TRANSFER: he stands on one foot, then the other, with a settle
       at each end. 26 s round trip - slow enough to read as a living body
       rather than a loop. The heavy man's is nearly twice the workers'. */
    var wPh = t * 0.0385 + this.phase * 0.31;
    var wf = wPh - Math.floor(wPh);
    var wshift = (wf < 0.5 ? smooth(wf / 0.5) : 1 - smooth((wf - 0.5) / 0.5)) * 2 - 1;
    var shift = wshift * (this.heavy ? 0.055 : 0.024)
              + Math.sin(t * 0.42 + this.phase * 1.7) * (this.heavy ? 0.013 : 0.009);
    /* contrapposto: the loaded hip rises and the free shoulder drops */
    var hipTilt = wshift * (this.heavy ? 0.028 : 0.013);
    var rock = Math.sin(t * 0.63 + this.phase) * (this.heavy ? 0.022 : 0.008);
    /* and he TENSES as he turns: shoulders up, head settling into them */
    var tense = alert * (this.heavy ? 0.016 : 0.0);

    var hipY = 0.92 * S;
    var chestY = 1.34 * S + breathe + tense * 0.5;
    var neckY = 1.50 * S + breathe * 0.84 + tense;
    /* the heavy man's head sits 0.045 m proud of everyone else's. This is
       the whole neck: his coat now tops out at 1.512 m and his jaw is at
       1.621, so 0.109 m - 24 px in the bridge shot - of the NECK-HEAD limb
       (0.145 m thick against a 0.238 m head) stands bare between the collar
       and the jaw. Without it the jaw sits on the collar and the head reads
       as a dome on a barrel, which is exactly what the round-2 screenshot
       showed. Gated on heavy: the five are untouched. */
    var headY = 1.665 * S + (this.heavy ? 0.045 : 0) + breathe * 0.70 + tense * 0.70;
    var shH = 0.205 * W * S, hipH = 0.135 * W * S;
    var kneeY = 0.50 * S, footY = 0.075 * S;
    var elbowY = 1.09 * S, handY = 0.85 * S;
    var chestZ = (this.heavy ? 0.055 : 0.0);

    function set(i, a, b, c) { L[i * 3] = a; L[i * 3 + 1] = b; L[i * 3 + 2] = c; }

    set(P_HEAD, shift * 0.4, headY, 0.015 + rock * 0.4);
    set(P_NECK, shift * 0.35, neckY, 0.005 + rock * 0.35);
    /* chestOpen is applied HERE and not to shH itself: in the 'lean' pose his
       hands are planted on the handrail and must not slide with each breath */
    set(P_CHL, -shH * chestOpen + shift * 0.3, chestY - hipTilt * 0.6, chestZ + rock * 0.3);
    set(P_CHR, shH * chestOpen + shift * 0.3, chestY + hipTilt * 0.6, chestZ + rock * 0.3);
    set(P_CORE, shift * 0.25, (hipY + chestY) * 0.5, chestZ * 0.7 + rock * 0.2);
    set(P_PLL, -hipH + shift, hipY + hipTilt, rock * 0.15);
    set(P_PLR, hipH + shift, hipY - hipTilt, rock * 0.15);
    set(P_KNL, -hipH - 0.012, kneeY + hipTilt * 0.45, 0.022 + rock * 0.08);
    set(P_KNR, hipH + 0.012, kneeY - hipTilt * 0.45, 0.022 + rock * 0.08);
    set(P_FTL, -hipH - 0.030, footY, 0.055);
    set(P_FTR, hipH + 0.030, footY, 0.055);

    if (this.pose === 'lean') {
      /* both forearms on the handrail: hands forward and slightly out */
      var hy = (RAIL_TOP - DECK_Y) - 0.02;
      var hz = (DECK_HZ - MAN_Z) - 0.06;
      var grip = this.brace;
      set(P_ELL, -shH - 0.085 * W, elbowY - 0.06 - grip * 0.05, 0.26 + grip * 0.05);
      set(P_ELR, shH + 0.085 * W, elbowY - 0.06 - grip * 0.05, 0.26 + grip * 0.05);
      set(P_HNL, -shH - 0.115 * W, hy, hz);
      set(P_HNR, shH + 0.115 * W, hy, hz);
      /* HIS HANDS ARE ON A HANDRAIL, AND THE HANDRAIL DOES NOT TURN WITH HIM.
         writePose() rotates every local point by this.yaw, so the moment he
         stands off square (MAN_YAW) the arms swing with the torso: one hand
         ends 0.16 m short of the rail holding air, the other 0.15 m inside
         it. Counter-rotate the ARM CHAIN ONLY - both elbows and both hands -
         by -yaw, so writePose's +yaw puts them back exactly where the square
         pose had them: both hands on the rail at world z 1.54, level, the
         bag still hanging off the left one.
         Rotating elbow and hand TOGETHER is the point. Solving each hand's
         local z on its own would keep the hands right and stretch the near
         upper arm from 0.40 m to 0.54 m, asking a 0.60 m arm to span 0.65 m
         from its shoulder - it visibly pulls out of the socket in the one
         shot the lesson turns on. This way both forearms keep their exact
         length and what is left is what a turned body actually does: the far
         arm folds (0.40 m shoulder to hand) and the near arm reaches
         (0.56 m, 93% of its span).
         Two sin/cos for one body per frame, no allocation, and at yaw 0
         every line is an exact identity. */
      if (this.yaw !== 0) {
        var ay = this.yaw, acy = Math.cos(ay), asy = Math.sin(ay), ax, az, a3;
        a3 = P_ELL * 3; ax = L[a3]; az = L[a3 + 2];
        L[a3] = ax * acy - az * asy; L[a3 + 2] = ax * asy + az * acy;
        a3 = P_ELR * 3; ax = L[a3]; az = L[a3 + 2];
        L[a3] = ax * acy - az * asy; L[a3 + 2] = ax * asy + az * acy;
        a3 = P_HNL * 3; ax = L[a3]; az = L[a3 + 2];
        L[a3] = ax * acy - az * asy; L[a3 + 2] = ax * asy + az * acy;
        a3 = P_HNR * 3; ax = L[a3]; az = L[a3 + 2];
        L[a3] = ax * acy - az * asy; L[a3 + 2] = ax * asy + az * acy;
      }
      /* HIS STANCE - and this is not decoration, it is the difference
         between two legs and one column. The lens stands 72 deg round from
         straight behind him, near enough his left side, and in THAT
         projection a pair of legs set side by side across his shoulder axis
         collapses onto itself: 0.344 m of real separation becomes 0.108 m
         on screen, less than the 0.229 m width of one thigh, so below the
         coat he ends in a single leg and the barrel comes straight back.
         Stagger them along his FACING instead - the one axis this camera
         can actually see - left foot 0.058 m forward, right 0.058 m back.
         On screen the two columns now stand 0.222 m apart, wider than a
         thigh, with lit deck between them. And it reads as what it is: a
         man leaning on a rail with his weight on one foot. The constraints
         are measured off this pose in the constructor like every other, so
         nothing in the ragdoll changes but where his feet start. Only the
         heavy man has pose 'lean', so only he is staggered. */
      L[P_FTL * 3 + 2] += 0.058; L[P_KNL * 3 + 2] += 0.032;
      L[P_FTR * 3 + 2] -= 0.058; L[P_KNR * 3 + 2] -= 0.032;
      /* he braces: the loaded foot slides back as the pressure grows.
         Written as a subtraction now so the stagger above survives it. */
      if (grip > 0.01) {
        L[P_FTL * 3 + 2] -= grip * 0.24;
        L[P_KNL * 3 + 2] -= grip * 0.10;
      }
    } else if (this.pose === 'talk') {
      /* one hand comes up and turns over on the point he will never finish;
         the other hangs. Two gestures at unrelated rates, both keyed off his
         own phase, so five men never gesture in unison. */
      var t1 = Math.max(0, Math.sin(t * 1.15 + this.phase * 2.3));
      var t2 = Math.max(0, Math.sin(t * 0.83 + this.phase * 4.1 + 1.3));
      set(P_ELL, -shH - 0.070 * W, elbowY + t1 * 0.065, 0.06 + t1 * 0.070);
      set(P_ELR, shH + 0.062 * W, elbowY - t2 * 0.010, 0.03 + t2 * 0.020);
      set(P_HNL, -shH - 0.050 * W, handY + t1 * 0.235, 0.14 + t1 * 0.150);
      set(P_HNR, shH + 0.082 * W, handY + t2 * 0.055, 0.07 + t2 * 0.045);
    } else if (this.pose === 'work') {
      var sw = Math.sin(t * 1.1 + this.phase);
      var raise = this.tool ? 0.30 : 0.0;
      set(P_ELL, -shH - 0.055 * W, elbowY + sw * 0.012, 0.05);
      set(P_ELR, shH + 0.055 * W, elbowY + raise * 0.5 + sw * 0.02, 0.09 + raise * 0.10);
      set(P_HNL, -shH - 0.075 * W, handY + sw * 0.02, 0.11);
      set(P_HNR, shH + 0.085 * W, handY + raise + sw * 0.05, 0.20 + raise * 0.14);
    } else {
      var sw2 = Math.sin(t * 0.9 + this.phase);
      set(P_ELL, -shH - 0.06 * W, elbowY + sw2 * 0.010, 0.02);
      set(P_ELR, shH + 0.06 * W, elbowY - sw2 * 0.010, 0.02);
      set(P_HNL, -shH - 0.085 * W, handY + sw2 * 0.018, 0.08);
      set(P_HNR, shH + 0.085 * W, handY - sw2 * 0.018, 0.08);
    }
    return L;
  };

  /* write the posed skeleton into world-space x[] --------------------- */
  Body.prototype.writePose = function (t) {
    var L = this.localSkeleton(t);
    var a = this.yaw, ca = Math.cos(a), sa = Math.sin(a);
    var lean = this.lean;
    var cl = Math.cos(lean), sl = Math.sin(lean);
    var x = this.x, i, i3, lx, ly, lz, ny, nz;
    var footY = 0.075 * this.hs;
    for (i = 0; i < 15; i++) {
      i3 = i * 3;
      lx = L[i3]; ly = L[i3 + 1]; lz = L[i3 + 2];
      /* forward lean pivots about the feet */
      if (lean !== 0) {
        var dy = ly - footY;
        ny = footY + dy * cl - lz * sl;
        nz = lz * cl + dy * sl;
        ly = ny; lz = nz;
      }
      /* shoulder twist (only the upper body) when he looks back */
      /* His hands are PLANTED on the handrail. Rotating them with the torso
         swung them 0.18 m back off the rail at full turn (measured), so his
         forearms rested on thin air for the rest of the scene. Head and
         shoulders turn, the elbows follow at 0.15, the hands do not move. */
      if (this.twist !== 0 && (i === P_CHL || i === P_CHR || i === P_NECK || i === P_HEAD ||
          i === P_ELL || i === P_ELR)) {
        var tw = this.twist * (i === P_NECK || i === P_HEAD ? 1.0 :
                              ((i === P_ELL || i === P_ELR) ? 0.15 : 0.75));
        var ct = Math.cos(tw), st = Math.sin(tw);
        var tx = lx * ct + lz * st;
        var tz = -lx * st + lz * ct;
        lx = tx; lz = tz;
      }
      x[i3] = this.rx + lx * ca + lz * sa;
      x[i3 + 1] = this.ry + ly;
      x[i3 + 2] = this.rz - lx * sa + lz * ca;
    }
  };

  Body.prototype.buildConstraints = function () {
    var x = this.x, c = this.c;
    function d(a, b) {
      var ax = x[a * 3] - x[b * 3], ay = x[a * 3 + 1] - x[b * 3 + 1], az = x[a * 3 + 2] - x[b * 3 + 2];
      return Math.sqrt(ax * ax + ay * ay + az * az);
    }
    function push(a, b, stiff, type, scale) {
      c.push({ a: a, b: b, rest: d(a, b) * (scale || 1), stiff: stiff, type: type || 0 });
    }
    /* bones */
    push(P_NECK, P_HEAD, 1.0); push(P_CORE, P_NECK, 1.0);
    push(P_CHL, P_CHR, 1.0); push(P_PLL, P_PLR, 1.0);
    push(P_CHL, P_CORE, 1.0); push(P_CHR, P_CORE, 1.0);
    push(P_PLL, P_CORE, 1.0); push(P_PLR, P_CORE, 1.0);
    push(P_CHL, P_ELL, 1.0); push(P_ELL, P_HNL, 1.0);
    push(P_CHR, P_ELR, 1.0); push(P_ELR, P_HNR, 1.0);
    push(P_PLL, P_KNL, 1.0); push(P_KNL, P_FTL, 1.0);
    push(P_PLR, P_KNR, 1.0); push(P_KNR, P_FTR, 1.0);
    /* torso braces */
    push(P_CHL, P_PLL, 0.55); push(P_CHR, P_PLR, 0.55);
    push(P_CHL, P_PLR, 0.55); push(P_CHR, P_PLL, 0.55);
    push(P_HEAD, P_CHL, 0.55); push(P_HEAD, P_CHR, 0.55);
    /* soft joint limits: minimum distances so limbs cannot fold through */
    push(P_CHL, P_HNL, 0.35, 1, 0.72); push(P_CHR, P_HNR, 0.35, 1, 0.72);
    push(P_PLL, P_FTL, 0.35, 1, 0.74); push(P_PLR, P_FTR, 0.35, 1, 0.74);
    /* STRETCH CAP across the elbow and the knee. type 2 was implemented in
       the solver and nothing in either world ever used it. Capped at the two
       bone lengths summed, which the triangle inequality guarantees the rest
       pose can never violate, so it is inert until something tries to pull a
       limb longer than its own bones - which a 17 m/s nose strike does, and
       a limb that stretches reads as rope rather than bone. It cannot detect
       an inverted joint (distance is symmetric about full extension); the
       minimums above and below are what stop a limb folding through itself.
       Measured off the built pose, so it scales with height and build like
       every other constraint here. */
    function span(a, m, b, stiff) {
      c.push({ a: a, b: b, rest: d(a, m) + d(m, b), stiff: stiff, type: 2 });
    }
    span(P_CHL, P_ELL, P_HNL, 0.55); span(P_CHR, P_ELR, P_HNR, 0.55);
    span(P_PLL, P_KNL, P_FTL, 0.55); span(P_PLR, P_KNR, P_FTR, 0.55);
    /* and the legs may not scissor through one another */
    push(P_KNL, P_KNR, 0.35, 1, 0.80); push(P_FTL, P_FTR, 0.35, 1, 0.80);
  };

  Body.prototype.integrate = function (h) {
    var x = this.x, p = this.p, w = this.w, gh = RD_G * this.gScale * h * h;
    var i, i3, vx, vy, vz, L;
    for (i = 0; i < 15; i++) {
      i3 = i * 3;
      if (w[i] === 0) { p[i3] = x[i3]; p[i3 + 1] = x[i3 + 1]; p[i3 + 2] = x[i3 + 2]; continue; }
      vx = (x[i3] - p[i3]) * RD_DAMP;
      vy = (x[i3 + 1] - p[i3 + 1]) * RD_DAMP;
      vz = (x[i3 + 2] - p[i3 + 2]) * RD_DAMP;
      L = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (L > RD_MAXSTEP) { L = RD_MAXSTEP / L; vx *= L; vy *= L; vz *= L; }
      p[i3] = x[i3]; p[i3 + 1] = x[i3 + 1]; p[i3 + 2] = x[i3 + 2];
      x[i3] += vx; x[i3 + 1] += vy + gh; x[i3 + 2] += vz;
    }
  };

  /* env: { railZ, railY, deckY, deckHX, support, tro:{z0,z1,vz,reach,active} } */
  /* vel === true ONLY on the last solver iteration: the earlier passes just
     project positions out of the ground, the last one writes the velocity
     response. Running the response on every iteration multiplied friction,
     restitution and whole-body drag by ten and killed every landing dead. */
  Body.prototype.collide = function (env, h, vel) {
    var x = this.x, p = this.p, i, i3, vx, vy, vz, onGround = false, onDeck = false, pen;
    var gY = this.groundY;
    var cut = RD_FRICA * h * h, tl, sf;
    for (i = 0; i < 15; i++) {
      i3 = i * 3;
      /* the rail head is a little higher than the ballast */
      var floor = gY + RD_RAD;
      var px = x[i3];
      if (Math.abs(Math.abs(px) - GAUGE) < 0.10) floor = gY + RAILHEAD_Y - 0.16 + RD_RAD;
      if (vel) {
        /* 2 cm CONTACT BAND, not strict penetration: by the last iteration
           the constraint solve has lifted a resting particle just clear of
           the floor, so a strict test reports no contact, applies no
           friction, and leaves this.grounded false for a body lying flat on
           the ballast - which also means the sleep test can never fire. */
        if (x[i3 + 1] < floor + 0.02) {
          vx = x[i3] - p[i3]; vy = x[i3 + 1] - p[i3 + 1]; vz = x[i3 + 2] - p[i3 + 2];
          pen = x[i3 + 1] < floor;
          if (pen) x[i3 + 1] = floor;
          if (pen || vy < 0.0015) {
            onGround = true;
            tl = Math.sqrt(vx * vx + vz * vz);
            if (tl > 1e-7) { sf = (tl > cut) ? (1 - cut / tl) : 0; vx *= sf; vz *= sf; }
            if (pen) { if (vy < -0.004) vy = -vy * RD_REST; else if (vy < 0) vy = 0; }
            p[i3] = x[i3] - vx; p[i3 + 1] = x[i3 + 1] - vy; p[i3 + 2] = x[i3 + 2] - vz;
          }
        }
      } else if (x[i3 + 1] < floor) {
        x[i3 + 1] = floor; onGround = true;
      }
      /* the bridge deck he is still standing on. Past the railing line there
         is no deck: that edge, not a scripted animation, is what tips him. */
      if (env && env.support > 0) {
        if (x[i3 + 2] < env.railZ && x[i3 + 2] > -env.railZ - 0.2 &&
            Math.abs(x[i3]) < env.deckHX && x[i3 + 1] < env.deckY + RD_RAD) {
          x[i3 + 1] = env.deckY + RD_RAD; onDeck = true;
          if (vel) {
            /* the same ten-times-per-substep friction, on the surface he is
               standing on at the exact moment he is pushed */
            var dvx = x[i3] - p[i3], dvy = x[i3 + 1] - p[i3 + 1], dvz = x[i3 + 2] - p[i3 + 2];
            var dtl = Math.sqrt(dvx * dvx + dvz * dvz);
            if (dtl > 1e-7) { var ds = (dtl > cut) ? (1 - cut / dtl) : 0; dvx *= ds; dvz *= ds; }
            if (dvy < -0.004) dvy = -dvy * RD_REST; else if (dvy < 0) dvy = 0;
            p[i3] = x[i3] - dvx; p[i3 + 1] = x[i3 + 1] - dvy; p[i3 + 2] = x[i3 + 2] - dvz;
          }
        }
      }
      /* The trolley is a kinematic FRONT FACE sweeping along +Z. Only the
         nose collides: a full box lets a body that is already behind the
         nose get squirted out of the back, which reads as a bug. The nose
         catches, shoves, and carries — which is the whole point. */
      if (env && env.tro && env.tro.active) {
        var NZ = env.tro.z1;
        if (this.troImmune <= 0 && x[i3] > -1.34 && x[i3] < 1.34 &&
            x[i3 + 1] > gY - 0.25 && x[i3 + 1] < gY + 3.4 &&
            x[i3 + 2] < NZ && x[i3 + 2] > NZ - env.tro.reach) {
          x[i3 + 2] = NZ + 0.03;
          /* 0.85, not 1.15: he must NOT outrun the nose, or the tram appears
             to stop for no reason three metres short of a body. */
          /* clamp raised from 14 to 20: at 14 the nose could only ever shove
             a body at 14 * 0.85 = 11.9 m/s, so a tram doing 26.82 m/s struck
             a man like a supermarket trolley meeting a bag of shopping.
             0.85 is kept, so he still cannot outrun the nose. */
          var tvz = env.tro.vz; if (tvz > 20) tvz = 20;   /* cinematic clamp */
          var tv = tvz * h * 0.85;
          p[i3 + 2] = x[i3 + 2] - tv;
          if (x[i3 + 1] > gY + 0.50) p[i3 + 1] = x[i3 + 1] - Math.abs(tv) * 0.18;
          this.trolleyHit = true;
        }
      }
    }
    /* grounded is read ONLY by the sleep test. The extra ground damping below
       stays gated on onGround alone, so deck contact cannot alter the push. */
    this.grounded = onGround || onDeck;
    /* once per substep, not once per solver iteration - see RD_GDAMP */
    if (onGround && vel) {
      for (i = 0; i < 15; i++) {
        i3 = i * 3;
        p[i3] = x[i3] - (x[i3] - p[i3]) * RD_GDAMP;
        p[i3 + 1] = x[i3 + 1] - (x[i3 + 1] - p[i3 + 1]) * RD_GDAMP;
        p[i3 + 2] = x[i3 + 2] - (x[i3 + 2] - p[i3 + 2]) * RD_GDAMP;
      }
    }
  };

  Body.prototype.solve = function (env, h) {
    var x = this.x, w = this.w, c = this.c;
    var it, k, cc, a, b, a3, b3, dx, dy, dz, d, diff, wa, wb, ws, f;
    for (it = 0; it < RD_ITER; it++) {
      for (k = 0; k < c.length; k++) {
        cc = c[k]; a = cc.a; b = cc.b; a3 = a * 3; b3 = b * 3;
        wa = w[a]; wb = w[b]; ws = wa + wb;
        if (ws === 0) continue;
        dx = x[b3] - x[a3]; dy = x[b3 + 1] - x[a3 + 1]; dz = x[b3 + 2] - x[a3 + 2];
        d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < 1e-6) { dx = 1e-6; d = 1e-6; }
        if (cc.type === 1 && d >= cc.rest) continue;
        if (cc.type === 2 && d <= cc.rest) continue;
        diff = (d - cc.rest) / d * cc.stiff;
        f = diff * (wa / ws); x[a3] += dx * f; x[a3 + 1] += dy * f; x[a3 + 2] += dz * f;
        f = diff * (wb / ws); x[b3] -= dx * f; x[b3 + 1] -= dy * f; x[b3 + 2] -= dz * f;
      }
      /* position projection every pass, velocity response on the last only */
      this.collide(env, h, it === RD_ITER - 1);
    }
  };

  Body.prototype.step = function (h, env) {
    if (this.mode !== 'ragdoll' || this.dead || this.asleep) return;
    if (this.troImmune > 0) this.troImmune -= h;
    this.integrate(h);
    this.solve(env, h);
    /* sleeping */
    var s = 0, i, i3, dx, dy, dz;
    for (i = 0; i < 15; i++) {
      i3 = i * 3;
      dx = this.x[i3] - this.p[i3]; dy = this.x[i3 + 1] - this.p[i3 + 1]; dz = this.x[i3 + 2] - this.p[i3 + 2];
      s += dx * dx + dy * dy + dz * dz;
    }
    /* momentarily still is not the same as settled: at the apex of a throw the
       velocity passes through zero. Sleep only on something solid, with a hard
       cap so a body caught on the deck edge cannot spin the solver forever. */
    /* s is the squared per-substep position delta over 15 particles, so a
       whole body moving at v contributes 15 * (v/60)^2 = 0.00417 v^2. 1e-4
       was therefore 0.155 m/s and the solver's own contact jitter sits right
       on it: a body that had plainly settled was never declared asleep and
       went on being solved for the rest of the scene. 2.5e-4 is 0.245 m/s,
       and 40 consecutive substeps is 0.67 s of unbroken ground contact. */
    if (s < 2.5e-4) {
      this.stillCount++;
      if ((this.grounded && this.stillCount > 40) || this.stillCount > 260) this.asleep = true;
    }
    else this.stillCount = 0;
  };

  Body.prototype.validate = function (full) {
    var x = this.x, i, n = full ? 45 : 3;
    var o = full ? 0 : P_CORE * 3;
    for (i = 0; i < n; i++) {
      var v = x[o + i];
      if (!isFinite(v) || v < -900 || v > 900) { this.dead = true; this.x.set(this.snap); return false; }
    }
    return true;
  };

  Body.prototype.addVel = function (i, vx, vy, vz, h) {
    var i3 = i * 3;
    this.p[i3] -= vx * h; this.p[i3 + 1] -= vy * h; this.p[i3 + 2] -= vz * h;
  };

  Body.prototype.goRagdoll = function () {
    if (this.mode === 'ragdoll') return;
    this.mode = 'ragdoll';
    this.p.set(this.x);
    this.snap.set(this.x);
    this.asleep = false;
    this.stillCount = 0;
  };

  /* ======================================================================
     PARTICLE POOL — sparks, debris, dust and breath share one Points mesh
     ====================================================================== */
  function Particles(max, tex) {
    this.max = max;
    this.n = 0;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);   /* attribute array: FADED colour */
    this.base = new Float32Array(max * 3);  /* the colour it was spawned with */
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.ttl = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.geo = new TH.BufferGeometry();
    this.aPos = new TH.BufferAttribute(this.pos, 3);
    this.aCol = new TH.BufferAttribute(this.col, 3);
    try { this.aPos.setUsage(TH.DynamicDrawUsage); this.aCol.setUsage(TH.DynamicDrawUsage); } catch (e) {}
    this.geo.setAttribute('position', this.aPos);
    this.geo.setAttribute('color', this.aCol);
    this.geo.setDrawRange(0, 0);
    var mp = { size: 0.30, map: tex, transparent: true, depthWrite: false,
      blending: TH.AdditiveBlending, sizeAttenuation: true, vertexColors: true, fog: true };
    this.mat = new TH.PointsMaterial(mp);
    this.mesh = new TH.Points(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.budget = max;
  }
  Particles.prototype.spawn = function (x, y, z, vx, vy, vz, r, g, b, ttl, grav) {
    if (this.n >= Math.min(this.max, this.budget)) return;
    var i = this.n++;
    var i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.base[i3] = r; this.base[i3 + 1] = g; this.base[i3 + 2] = b;
    this.col[i3] = r; this.col[i3 + 1] = g; this.col[i3 + 2] = b;
    this.life[i] = ttl; this.ttl[i] = ttl; this.grav[i] = grav;
  };
  Particles.prototype.update = function (dt) {
    var i = 0, i3, k;
    while (i < this.n) {
      i3 = i * 3;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        var l = --this.n, l3 = l * 3;
        if (l !== i) {
          this.pos[i3] = this.pos[l3]; this.pos[i3 + 1] = this.pos[l3 + 1]; this.pos[i3 + 2] = this.pos[l3 + 2];
          this.vel[i3] = this.vel[l3]; this.vel[i3 + 1] = this.vel[l3 + 1]; this.vel[i3 + 2] = this.vel[l3 + 2];
          this.base[i3] = this.base[l3]; this.base[i3 + 1] = this.base[l3 + 1]; this.base[i3 + 2] = this.base[l3 + 2];
          this.life[i] = this.life[l]; this.ttl[i] = this.ttl[l]; this.grav[i] = this.grav[l];
        }
        continue;
      }
      this.vel[i3 + 1] += this.grav[i] * dt;
      this.vel[i3] *= 0.985; this.vel[i3 + 2] *= 0.985;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      if (this.pos[i3 + 1] < 0.05 && this.grav[i] < 0) {
        this.pos[i3 + 1] = 0.05;
        this.vel[i3 + 1] *= -0.24;
        this.vel[i3] *= 0.55; this.vel[i3 + 2] *= 0.55;
      }
      k = this.life[i] / (this.ttl[i] || 1);
      k = k < 0 ? 0 : (k > 1 ? 1 : k);
      /* fade by dimming the vertex colour (additive blending) */
      var f = k * k;
      this.col[i3] = this.base[i3] * f;
      this.col[i3 + 1] = this.base[i3 + 1] * f;
      this.col[i3 + 2] = this.base[i3 + 2] * f;
      i++;
    }
    this.geo.setDrawRange(0, this.n);
    this.aPos.needsUpdate = true;
    this.aCol.needsUpdate = true;
  };
  Particles.prototype.clear = function () { this.n = 0; this.geo.setDrawRange(0, 0); };

  /* ======================================================================
     BUILDERS
     ====================================================================== */

  /* ---------------------------------------------------------- the bridge */
  function buildBridge(store) {
    var g = new TH.Group();
    var parts = [];
    var cSteel = colorOf(COL.steel), cHi = colorOf(COL.steelHi);
    var cConc = colorOf(COL.concrete), cConcD = colorOf(COL.concDark);
    var cPaint = colorOf(COL.paint), cOld = colorOf(COL.paintOld), cRust = colorOf(COL.rust);

    var boxD = new TH.BoxGeometry(1, 1, 1);
    var cylD = new TH.CylinderGeometry(1, 1, 1, 8, 1);
    var cyl6 = new TH.CylinderGeometry(1, 1, 1, 6, 1);

    /* --- deck plate: its own textured mesh so the rivets read --------- */
    var deckGeo = new TH.BoxGeometry(DECK_HX * 2, 0.20, DECK_HZ * 2, 1, 1, 1);
    var deckTex = texRivetPlate();
    deckTex.repeat.set(9, 1.6);
    /* NOT WHITE. Under r134 an unset/white colour pins the albedo multiplier
       at the top of the linear range and hands the whole read of the deck to
       the texture - which is how the plate at the bottom of frame became the
       lightest surface in the shot. 0xa2aab4 is a cold 0.64 multiplier: the
       plate body lands just under the fog instead of on top of it, and the
       (now darker) rivets land under his rim. */
    var deckMat = new TH.MeshLambertMaterial({ map: deckTex, color: 0xa2aab4 });
    var deck = new TH.Mesh(deckGeo, deckMat);
    deck.position.set(0, DECK_Y - 0.10, 0);
    g.add(deck);
    store.push(deckGeo, deckMat, deckTex);

    /* --- structural steel + concrete, all merged, vertex coloured ---- */
    /* main longitudinal girders under the deck */
    parts.push({ g: boxD, m: mat4(0, DECK_Y - 0.46, DECK_HZ - 0.14, 0, 0, 0, DECK_HX * 2, 0.55, 0.20), c: cSteel });
    parts.push({ g: boxD, m: mat4(0, DECK_Y - 0.46, -DECK_HZ + 0.14, 0, 0, 0, DECK_HX * 2, 0.55, 0.20), c: cSteel });
    parts.push({ g: boxD, m: mat4(0, DECK_Y - 0.70, DECK_HZ - 0.14, 0, 0, 0, DECK_HX * 2, 0.10, 0.42), c: cHi });
    parts.push({ g: boxD, m: mat4(0, DECK_Y - 0.70, -DECK_HZ + 0.14, 0, 0, 0, DECK_HX * 2, 0.10, 0.42), c: cHi });
    /* cross beams */
    var i;
    for (i = -6; i <= 6; i++) {
      parts.push({ g: boxD, m: mat4(i * 1.42, DECK_Y - 0.40, 0, 0, 0, 0, 0.14, 0.34, DECK_HZ * 2 - 0.3), c: cSteel });
    }
    /* diagonal bracing under the deck (reads as structure from the wide shot) */
    for (i = -5; i <= 5; i++) {
      parts.push({ g: boxD, m: mat4(i * 1.42 + 0.7, DECK_Y - 0.52, 0, 0.62, 0, 0, 0.08, 0.08, 3.4), c: cHi });
    }

    /* abutment piers, either side of the track cut */
    var pierX = 6.6;
    parts.push({ g: boxD, m: mat4(-pierX, DECK_Y * 0.5 - 0.3, 0, 0, 0, 0, 2.1, DECK_Y + 0.6, 4.2), c: cConc });
    parts.push({ g: boxD, m: mat4(pierX, DECK_Y * 0.5 - 0.3, 0, 0, 0, 0, 2.1, DECK_Y + 0.6, 4.2), c: cConc });
    parts.push({ g: boxD, m: mat4(-pierX, DECK_Y - 0.30, 0, 0, 0, 0, 2.5, 0.36, 4.6), c: cConcD });
    parts.push({ g: boxD, m: mat4(pierX, DECK_Y - 0.30, 0, 0, 0, 0, 2.5, 0.36, 4.6), c: cConcD });
    /* retaining wing walls running along the track — this is what makes the
       ABSENCE of a side track legible: there is nowhere else for it to go. */
    parts.push({ g: boxD, m: mat4(-4.6, 0.95, 44, 0, 0, 0, 0.5, 1.9, 176), c: cConcD });
    parts.push({ g: boxD, m: mat4(4.6, 0.95, 44, 0, 0, 0, 0.5, 1.9, 176), c: cConcD });
    parts.push({ g: boxD, m: mat4(-4.6, 1.94, 44, 0, 0, 0, 0.62, 0.12, 176), c: cConc });
    parts.push({ g: boxD, m: mat4(4.6, 1.94, 44, 0, 0, 0, 0.62, 0.12, 176), c: cConc });

    /* railings, both sides */
    var side, postX;
    for (side = 0; side < 2; side++) {
      var z = side === 0 ? DECK_HZ - 0.08 : -DECK_HZ + 0.08;
      /* posts every 1.2 m */
      for (postX = -8.4; postX <= 8.41; postX += 1.2) {
        parts.push({ g: boxD, m: mat4(postX, DECK_Y + 0.58, z, 0, 0, 0, 0.09, 1.16, 0.09), c: cPaint });
        /* peeling paint: a lighter patch on some posts */
        if ((Math.round(postX * 10) % 24) === 0) {
          parts.push({ g: boxD, m: mat4(postX, DECK_Y + 0.30, z + 0.048, 0, 0, 0, 0.075, 0.30, 0.012), c: cRust });
        }
      }
      /* top handrail — worn, brighter along its top edge */
      parts.push({ g: cylD, m: mat4(0, RAIL_TOP, z, 0, 0, Math.PI / 2, 0.045, DECK_HX * 2, 0.045), c: cOld });
      /* mid rail */
      parts.push({ g: cyl6, m: mat4(0, DECK_Y + 0.62, z, 0, 0, Math.PI / 2, 0.028, DECK_HX * 2, 0.028), c: cPaint });
      /* kerb */
      parts.push({ g: boxD, m: mat4(0, DECK_Y + 0.06, z, 0, 0, 0, DECK_HX * 2, 0.13, 0.14), c: cSteel });
      /* bottom channel that holds the guard mesh */
      parts.push({ g: boxD, m: mat4(0, DECK_Y + 0.14, z, 0, 0, 0, DECK_HX * 2, 0.05, 0.06), c: cHi });
    }
    /* end posts, heavier */
    parts.push({ g: boxD, m: mat4(-8.9, DECK_Y + 0.62, 0, 0, 0, 0, 0.16, 1.24, DECK_HZ * 2), c: cPaint });
    parts.push({ g: boxD, m: mat4(8.9, DECK_Y + 0.62, 0, 0, 0, 0, 0.16, 1.24, DECK_HZ * 2), c: cPaint });

    var structGeo = mergeParts(parts);
    var structMat = new TH.MeshLambertMaterial({ vertexColors: true });
    var struct = new TH.Mesh(structGeo, structMat);
    g.add(struct);
    store.push(structGeo, structMat);

    /* --- the guard mesh panel, alphaTested (no transparency sorting) -- */
    var panTex = texMeshPanel();
    panTex.repeat.set(30, 2);
    var panMat = new TH.MeshLambertMaterial({
      map: panTex, color: 0x3f4751, alphaTest: 0.45, transparent: false,
      side: TH.DoubleSide
    });
    var panGeo = new TH.PlaneGeometry(DECK_HX * 2 - 0.2, 0.46, 1, 1);
    var panA = new TH.Mesh(panGeo, panMat);
    panA.position.set(0, DECK_Y + 0.38, DECK_HZ - 0.08);
    g.add(panA);
    var panB = new TH.Mesh(panGeo, panMat);
    panB.position.set(0, DECK_Y + 0.38, -DECK_HZ + 0.08);
    g.add(panB);
    store.push(panGeo, panMat, panTex);

    boxD.dispose(); cylD.dispose(); cyl6.dispose();
    return { group: g, panels: [panA, panB] };
  }

  /* ------------------------------------------------------------ the track */
  function buildTrack(store) {
    var g = new TH.Group();

    /* ballast bed */
    var balTex = texBallast();
    balTex.repeat.set(6, 120);
    var balGeo = new TH.PlaneGeometry(9.0, TRACK_FAR - TRACK_BACK, 1, 1);
    var balMat = new TH.MeshLambertMaterial({ map: balTex, color: 0xb4bcc6 });
    var bal = new TH.Mesh(balGeo, balMat);
    bal.rotation.x = -Math.PI / 2;
    bal.position.set(0, 0.0, (TRACK_FAR + TRACK_BACK) * 0.5);
    g.add(bal);
    store.push(balGeo, balMat, balTex);

    /* the ballast shoulder — a slightly raised crown under the sleepers */
    var parts = [];
    var boxD = new TH.BoxGeometry(1, 1, 1);
    var cCrown = colorOf(COL.ballast);
    parts.push({ g: boxD, m: mat4(0, 0.10, (TRACK_FAR + TRACK_BACK) * 0.5, 0, 0, 0, 3.5, 0.20, TRACK_FAR - TRACK_BACK), c: cCrown });

    /* rails: web + head, both sides */
    var cWeb = colorOf(COL.railWeb), cTop = colorOf(COL.railTop);
    var zc = (TRACK_FAR + TRACK_BACK) * 0.5, zl = TRACK_FAR - TRACK_BACK;
    parts.push({ g: boxD, m: mat4(-GAUGE, 0.32, zc, 0, 0, 0, 0.055, 0.22, zl), c: cWeb });
    parts.push({ g: boxD, m: mat4(GAUGE, 0.32, zc, 0, 0, 0, 0.055, 0.22, zl), c: cWeb });
    parts.push({ g: boxD, m: mat4(-GAUGE, 0.435, zc, 0, 0, 0, 0.10, 0.045, zl), c: cTop });
    parts.push({ g: boxD, m: mat4(GAUGE, 0.435, zc, 0, 0, 0, 0.10, 0.045, zl), c: cTop });
    parts.push({ g: boxD, m: mat4(-GAUGE, 0.225, zc, 0, 0, 0, 0.15, 0.04, zl), c: cWeb });
    parts.push({ g: boxD, m: mat4(GAUGE, 0.225, zc, 0, 0, 0, 0.15, 0.04, zl), c: cWeb });

    var railGeo = mergeParts(parts);
    var railMat = new TH.MeshLambertMaterial({ vertexColors: true });
    var rails = new TH.Mesh(railGeo, railMat);
    g.add(rails);
    store.push(railGeo, railMat);

    /* sleepers, instanced */
    var SLEEP_MAX = 250;
    var slGeo = new TH.BoxGeometry(2.55, 0.16, 0.26, 1, 1, 1);
    var slMat = new TH.MeshLambertMaterial({ color: 0x1d2229 });
    var sleepers = new TH.InstancedMesh(slGeo, slMat, SLEEP_MAX);
    sleepers.frustumCulled = false;
    var m = new TH.Matrix4(), q = new TH.Quaternion(), p = new TH.Vector3(), s = new TH.Vector3(1, 1, 1);
    var e = new TH.Euler();
    var i, zz;
    for (i = 0; i < SLEEP_MAX; i++) {
      zz = -30 + i * 0.72;   /* -30 .. +150 : covers everything the fog lets us see */
      e.set(0, (Math.random() - 0.5) * 0.035, (Math.random() - 0.5) * 0.02);
      q.setFromEuler(e);
      p.set((Math.random() - 0.5) * 0.05, 0.14, zz);
      m.compose(p, q, s);
      sleepers.setMatrixAt(i, m);
    }
    sleepers.instanceMatrix.needsUpdate = true;
    g.add(sleepers);
    store.push(slGeo, slMat);

    /* catenary / lighting masts, instanced, both sides — depth cues */
    var MAST_MAX = 30;
    var maGeo = new TH.BoxGeometry(0.20, 7.4, 0.20, 1, 1, 1);
    var maMat = new TH.MeshLambertMaterial({ color: 0x1f252d });
    var masts = new TH.InstancedMesh(maGeo, maMat, MAST_MAX);
    masts.frustumCulled = false;
    for (i = 0; i < MAST_MAX; i++) {
      var sd = (i % 2) === 0 ? -1 : 1;
      zz = 6 + Math.floor(i / 2) * 16.5;
      p.set(sd * 5.15, 3.7, zz);
      e.set(0, 0, sd * 0.012); q.setFromEuler(e);
      m.compose(p, q, s);
      masts.setMatrixAt(i, m);
    }
    masts.instanceMatrix.needsUpdate = true;
    g.add(masts);
    store.push(maGeo, maMat);

    return { group: g, sleepers: sleepers, masts: masts, sleepMax: SLEEP_MAX, mastMax: MAST_MAX };
  }

  /* ----------------------------------------------------------- the trolley */
  function buildTrolley(store) {
    var g = new TH.Group();   /* nose at local z = 0, body runs to -z */
    var boxD = new TH.BoxGeometry(1, 1, 1);
    var cylD = new TH.CylinderGeometry(1, 1, 1, 10, 1);
    var cTram = colorOf(COL.tram), cHi = colorOf(COL.tramHi), cDark = colorOf(0x14181e);

    var L = 14.0, W = 1.28, H = 3.05, FLOOR = 0.62;
    var parts = [];
    /* main body */
    parts.push({ g: boxD, m: mat4(0, FLOOR + (H - FLOOR) * 0.5, -L * 0.5, 0, 0, 0, W * 2, H - FLOOR, L - 0.6), c: cTram });
    /* skirt */
    parts.push({ g: boxD, m: mat4(0, 0.46, -L * 0.5, 0, 0, 0, W * 2 - 0.14, 0.60, L - 1.2), c: cDark });
    /* raked nose */
    parts.push({ g: boxD, m: mat4(0, 1.60, -0.30, 0.16, 0, 0, W * 2 - 0.06, 1.95, 0.60), c: cHi });
    parts.push({ g: boxD, m: mat4(0, 0.60, -0.24, 0, 0, 0, W * 2 - 0.10, 0.66, 0.50), c: cDark });
    /* roof */
    parts.push({ g: boxD, m: mat4(0, H + 0.06, -L * 0.5, 0, 0, 0, W * 2 - 0.22, 0.16, L - 1.0), c: cHi });
    parts.push({ g: cylD, m: mat4(0, H + 0.02, -L * 0.5, Math.PI / 2, 0, 0, W - 0.12, L - 1.0, 0.22), c: cHi });
    /* waist band */
    parts.push({ g: boxD, m: mat4(0, 1.02, -L * 0.5, 0, 0, 0, W * 2 + 0.05, 0.10, L - 0.9), c: cHi });
    /* bogies + wheels */
    var b, bz, wi;
    for (b = 0; b < 2; b++) {
      bz = b === 0 ? -2.4 : -11.2;
      parts.push({ g: boxD, m: mat4(0, 0.55, bz, 0, 0, 0, 1.9, 0.44, 2.8), c: cDark });
      for (wi = 0; wi < 4; wi++) {
        var wx = (wi % 2) === 0 ? -GAUGE : GAUGE;
        var wz = bz + ((wi < 2) ? -1.05 : 1.05);
        parts.push({ g: cylD, m: mat4(wx, 0.44, wz, 0, 0, Math.PI / 2, 0.42, 0.10, 0.42), c: cDark });
      }
    }
    /* pantograph */
    parts.push({ g: boxD, m: mat4(0, H + 0.55, -5.4, -0.45, 0, 0, 0.06, 1.15, 0.06), c: cDark });
    parts.push({ g: boxD, m: mat4(0, H + 0.55, -6.6, 0.45, 0, 0, 0.06, 1.15, 0.06), c: cDark });
    parts.push({ g: boxD, m: mat4(0, H + 1.06, -6.0, 0, 0, 0, 1.5, 0.06, 0.10), c: cDark });
    /* buffer beam */
    parts.push({ g: boxD, m: mat4(0, 0.72, -0.05, 0, 0, 0, W * 2 + 0.08, 0.26, 0.16), c: cDark });

    var bodyGeo = mergeParts(parts);
    var bodyMat = new TH.MeshLambertMaterial({ vertexColors: true });
    var body = new TH.Mesh(bodyGeo, bodyMat);
    g.add(body);
    store.push(bodyGeo, bodyMat);

    /* windows — one merged unlit mesh, very dark, faint interior glow */
    var wparts = [];
    var cGlass = colorOf(COL.glass);
    wparts.push({ g: boxD, m: mat4(0, 2.16, -0.52, 0.16, 0, 0, W * 2 - 0.28, 1.10, 0.06), c: cGlass });
    var k;
    for (k = 0; k < 5; k++) {
      var zw = -2.2 - k * 2.2;
      wparts.push({ g: boxD, m: mat4(-W - 0.01, 2.05, zw, 0, 0, 0, 0.06, 1.05, 1.55), c: cGlass });
      wparts.push({ g: boxD, m: mat4(W + 0.01, 2.05, zw, 0, 0, 0, 0.06, 1.05, 1.55), c: cGlass });
    }
    var winGeo = mergeParts(wparts);
    /* The last pure-white MeshBasicMaterial in scene B, white by omission:
       an unset colour is (1,1,1), and on an unlit material under a linear
       pipeline white is the one value that cannot be trusted - it pins the
       multiplier at the top of the range and leaves the whole read to the
       vertex colours. An explicit cold tint does real work here: it drops the
       glass 30% and pulls it blue, so the carriage windows sit at
       ~rgb(38,58,81) at close range - level with the fog, above black, and
       nowhere near competing with the vests. */
    var winMat = new TH.MeshBasicMaterial({ color: 0xb4c4d6, vertexColors: true, fog: true });
    var win = new TH.Mesh(winGeo, winMat);
    g.add(win);
    store.push(winGeo, winMat);

    /* headlamps */
    var lampGeo = new TH.CylinderGeometry(0.17, 0.17, 0.10, 10, 1);
    var lampMat = new TH.MeshBasicMaterial({ color: COL.lamp, fog: true });
    var lampL = new TH.Mesh(lampGeo, lampMat);
    lampL.rotation.x = Math.PI / 2;
    lampL.position.set(-0.78, 1.05, 0.02);
    g.add(lampL);
    var lampR = new TH.Mesh(lampGeo, lampMat);
    lampR.rotation.x = Math.PI / 2;
    lampR.position.set(0.78, 1.05, 0.02);
    g.add(lampR);
    store.push(lampGeo, lampMat);

    /* two volumetric-reading light cones (additive, back faces, no depth write) */
    var CH = 30.0;
    var coneGeo = new TH.ConeGeometry(3.1, CH, 10, 1, true);
    var coneMat = new TH.ShaderMaterial({
      uniforms: {
        uColor: { value: new TH.Color(0x9fc0e6) },
        uOpacity: { value: 0.30 },
        uH: { value: CH }
      },
      vertexShader: [
        'varying vec3 vN; varying vec3 vV; varying float vY;',
        'uniform float uH;',
        'void main(){',
        '  vec4 mv = modelViewMatrix * vec4(position,1.0);',
        '  vN = normalize(normalMatrix * normal);',
        '  vV = normalize(-mv.xyz);',
        '  vY = clamp(position.y / uH + 0.5, 0.0, 1.0);',
        '  gl_Position = projectionMatrix * mv;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uColor; uniform float uOpacity;',
        'varying vec3 vN; varying vec3 vV; varying float vY;',
        'void main(){',
        '  float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));',
        '  f = pow(clamp(f, 0.0, 1.0), 1.6);',
        '  float fade = pow(vY, 1.9);',
        '  float a = f * fade * uOpacity;',
        '  gl_FragColor = vec4(uColor * a, 1.0);',
        '}'
      ].join('\n'),
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: TH.AdditiveBlending,
      side: TH.BackSide,
      fog: false
    });
    var coneL = new TH.Mesh(coneGeo, coneMat);
    coneL.rotation.x = -Math.PI / 2;
    coneL.position.set(-0.78, 1.05, CH * 0.5 + 0.1);
    coneL.renderOrder = 3;
    g.add(coneL);
    var coneR = new TH.Mesh(coneGeo, coneMat);
    coneR.rotation.x = -Math.PI / 2;
    coneR.position.set(0.78, 1.05, CH * 0.5 + 0.1);
    coneR.renderOrder = 3;
    g.add(coneR);
    store.push(coneGeo, coneMat);

    /* one practical light at the nose — created ONCE so no shader recompile
       ever happens at runtime; quality only changes its intensity. */
    var head = new TH.PointLight(0xbcd4f0, 0.0, 46, 2);
    head.position.set(0, 1.4, 2.0);
    head.castShadow = false;
    g.add(head);

    boxD.dispose(); cylD.dispose();
    return { group: g, cones: [coneL, coneR], lamps: [lampL, lampR], light: head, coneMat: coneMat, length: L };
  }

  /* --------------------------------------------- the player's hands rig */
  function buildHands(store) {
    var grp = new TH.Group();
    var boxD = new TH.BoxGeometry(1, 1, 1);
    var cylD = new TH.CylinderGeometry(1, 1, 1, 6, 1);
    /* The player's own hands sit closest to the lens and catch the near fill,
       so their albedo has to be well UNDER everything they must not outrank.
       At 0x7f8a95 their relative luminance was 0.535 against the hi-vis vest
       at 0.516: the brightest thing in the frame was a pair of hands, which
       breaks the one rule the whole look is built on — the orange vest is the
       single signal that says a person is there. 0x4a525d puts them at 0.29,
       comfortably under the vest and under the man's rim, while staying light
       enough against his coat (0.16) to read as hands when they reach. */
    var cSleeve = colorOf(0x1c222a), cCuff = colorOf(0x262d36), cSkin = colorOf(0x4a525d);

    function armGeo(sign) {
      var parts = [];
      /* forearm runs from the hand (local origin) back along +Z */
      parts.push({ g: cylD, m: mat4(0, 0, 0.30, Math.PI / 2, 0, 0, 0.062, 0.46, 0.075), c: cSleeve });
      parts.push({ g: cylD, m: mat4(0, 0, 0.52, Math.PI / 2, 0, 0, 0.078, 0.16, 0.090), c: cSleeve });
      /* cuff */
      parts.push({ g: cylD, m: mat4(0, 0, 0.115, Math.PI / 2, 0, 0, 0.070, 0.075, 0.080), c: cCuff });
      /* palm */
      parts.push({ g: boxD, m: mat4(0, 0, 0.0, 0, 0, 0, 0.098, 0.040, 0.155), c: cSkin });
      /* fingers, one slab plus a thumb — reads at a glance, costs nothing */
      parts.push({ g: boxD, m: mat4(sign * 0.012, -0.004, -0.098, 0.10, 0, 0, 0.090, 0.032, 0.075), c: cSkin });
      parts.push({ g: boxD, m: mat4(-sign * 0.058, 0.006, -0.046, 0, 0.5 * sign, 0, 0.030, 0.028, 0.078), c: cSkin });
      return mergeParts(parts);
    }
    var gl = armGeo(-1), gr = armGeo(1);
    var hmat = new TH.MeshLambertMaterial({ vertexColors: true });
    var armL = new TH.Mesh(gl, hmat), armR = new TH.Mesh(gr, hmat);
    armL.frustumCulled = false; armR.frustumCulled = false;
    armL.renderOrder = 2; armR.renderOrder = 2;
    grp.add(armL); grp.add(armR);
    store.push(gl, gr, hmat);
    boxD.dispose(); cylD.dispose();
    return { group: grp, armL: armL, armR: armR };
  }

  /* ============================ HUMAN CONTROLLERS ======================= */
  function makeHumanCtl(body, idx) {
    return {
      body: body,
      index: idx,
      get position() { return { x: body.x[P_CORE * 3], y: body.x[P_CORE * 3 + 1], z: body.x[P_CORE * 3 + 2] }; },
      setPose: function (p) { body.pose = p; },
      setLean: function (v) { body.lean = v; },
      /* 0 = back turned, 1 = looking straight down the lens */
      lookBack: function (v) {
        v = clamp(v, 0, 1);
        var s = smooth(v);
        /* Two smoothsteps, not one: the head starts round, hesitates, then
           commits. Ends exactly on the lens, and not one degree past it.
           Aim check, bridge eyeline: head (0.34, 8.58, 1.07), camera
           (-1.10, 8.52, 0.62) => required world yaw = atan2(-1.44, -0.45)
           = -1.876 rad. writeBodies() composes that yaw as
           body.yaw + headYaw + twist*0.35 = 0 - 1.74 - 0.14 = -1.88. The old
           -1.87/-0.34 pair summed to -1.99 - seven degrees PAST the camera,
           which at 1.5 m reads as him looking over your shoulder at nothing.
           The -0.40 rad of shoulder twist also keeps the neck inside a human
           limit: 107 deg of turn, 23 of it torso, 84 of it neck. */
        s = s * 0.34 + smooth(s) * 0.66;
        /* RE-AIMED for the recomposed bridge shot. His head at full turn,
           after MAN_YAW, the lean and the shoulder twist have all swung it,
           is (0.30, 8.56, 1.16); the eye is now (-1.47, 8.52, -0.37), 2.33 m
           away in plan instead of 1.53. Required world yaw =
           atan2(-1.77, -1.53) = -2.283 rad. writeBodies() composes it as
           yaw + headYaw + twist*0.35 = -0.350 - 1.795 - 0.140 = -2.285, and
           the required pitch is atan2(0.08, 2.33) = 0.035 down. Residual
           under a quarter of a degree - a centimetre at 2.33 m, less than
           the breath moves his head: he is looking at the lens, not past it.
           The TURN ITSELF is unchanged - 110.9 deg from his own facing, the
           same torso-plus-neck that was verified before. Every extra degree
           the new camera position needed was paid for by standing him at
           MAN_YAW instead of square to the rail. */
        body.headYaw = -1.795 * s;
        body.twist = -0.40 * s;
        body.headPitch = 0.035 * s;   /* down the lens: our eyes are below his */
      },
      ragdoll: function () { body.goRagdoll(); },
      get isRagdoll() { return body.mode === 'ragdoll'; }
    };
  }

  /* ======================================================================
     THE WORLD
     ====================================================================== */
  function build(renderer) {
    if (!TH || !TH.Scene) return null;
    scratch();

    var store = [];               /* disposables */
    var W = {};                   /* the returned world */

    /* ------------------------------------------------------------ scene */
    var scene = new TH.Scene();
    scene.background = new TH.Color(FOG_HEX);
    /* FogExp2: fogFactor = 1 - exp(-(density*d)^2).  This is the LONG shot,
       not the cab, so the density is set from the two distances that carry
       the drama, then checked against the trolley:
         the five, from the bridge eye   d = 44 m  -> 1-exp(-(0.537)^2) = 0.25
         the five, from the wide cut     d = 56 m  -> 1-exp(-(0.680)^2) = 0.37
         headlamps, first smudge         d = 130 m -> 0.92  (a glow, no shape)
         headlamps, closing              d =  70 m -> 0.52  (unmistakable)
         headlamps, choice climax        d =  34 m -> 0.16  (hard and bright)
       25% keeps the vests at ~rgb(164,105,48): visible, but plainly far off.
       Above ~0.016 the 0.43 figure goes past 0.6 and the wide shot - five
       bodies thrown - turns to soup, which is exactly what went wrong in A. */
    scene.fog = new TH.FogExp2(FOG_HEX, 0.0122);

    var aspect = 16 / 9;
    try {
      var el = renderer && renderer.domElement;
      if (el && el.clientHeight > 0) aspect = el.clientWidth / el.clientHeight;
    } catch (e) {}
    var camera = new TH.PerspectiveCamera(58, aspect, 0.35, 700);

    var camRoot = new TH.Group();
    camRoot.add(camera);
    scene.add(camRoot);

    /* ------------------------------------------------------------ light */
    /* r134, physicallyCorrectLights === false: every intensity below is a
       PLAIN MULTIPLIER. No candela, no lux, nothing above 2.4 anywhere.
       The whole look is one ratio: a tiny ambient fill against a large
       backlight. 0.40 : 2.40 is 6:1. It was 10:1 with a near-black ground
       colour, and that put EVERY surface facing the lens - his coat, the
       camera side of every stanchion, the near face of the deck plate -
       between rgb 0 and rgb 7, which is under the floor of a classroom
       projector: not dark, absent.
       The ground colour goes up with the intensity, because a hemisphere
       light weights a VERTICAL face 50/50 sky/ground, so the ground term is
       half of everything pointed at us; up-facing surfaces do not see it at
       all, so the deck and the ballast keep their key-lit falloff.
       Measured through the ACES + sRGB composite at these values: stanchion
       faces rgb(10,20,28), his coat rgb(14,22,32), deck rgb(37,53,68), fog
       rgb(44,60,78). Still cold, still near-black, still a silhouette - but
       a silhouette with detail in it rather than a cut-out. */
    var hemi = new TH.HemisphereLight(0x6d8fb5, 0x2c3744, 0.40);
    scene.add(hemi);

    /* One strong rim/backlight from far down the line, aimed back at us: the
       fog scatters it and the orange vests become the only warm edge. It
       grazes the ballast at N.L ~ 0.175, which is very nearly all the ground
       light there is, and hits +Z-facing edges square - hence the rim. */
    var key = new TH.DirectionalLight(0xa9c9ea, 2.40);
    /* Raised from y=26 to y=46: 10 deg of elevation becomes 18. N.L on every
       HORIZONTAL surface goes 0.175 -> 0.306, so the deck, the ballast, the
       sleepers, five pairs of shoulders and the crown of his head all come
       up 1.75x - exactly the band a projector crushes (deck rgb 24 -> 37 in
       red, 35 -> 53 in green). Vertical faces lose 3.4% (cos 18 against
       cos 10), so every silhouette in the frame keeps its edge, and the
       direction is unchanged in plan so the backlit look is unchanged. */
    key.position.set(9, 46, 128);
    key.target.position.set(0, 1.5, -10);
    key.castShadow = false;
    scene.add(key);
    scene.add(key.target);

    /* One cold practical on the bridge, out of frame off the viewer's left
       shoulder. Its only job is the emotional peak, and it is OFF (intensity
       0) until he starts to turn - update() drives it from lookBack.
       Its previous placement, 0.60 m left and 1.40 m BEHIND him, lit his
       BACK at N.L 0.61 against his face at 0.83: 1.36:1, so it lifted the
       silhouette it was meant to protect almost as much as it lifted the
       face, and it burned all the time. Pushed out to 1.85 m off the
       camera's left and level with it: N.L is 0.99 on the face he turns
       toward us and 0.18 on his back - 5.6:1 - and under r134 legacy
       falloff, (1 - d/7)^2, it dies at 7 m, far above the ballast and well
       left of frame, so it can neither flatten the murk nor pool on the deck
       in shot. It moves with the viewer, and the viewer is now 0.65 m
       further from his head: 4.00 m instead of 3.35, where the legacy
       falloff (1 - d/7)^2 drops from 0.273 to 0.184, so update() drives it
       at 1.00 instead of 0.70. RE-HUNG for the 0.80 m pull-back: carried
       rigidly at the old offset it would have sat 4.76 m from his head and
       (1 - d/7)^2 would have fallen 0.185 -> 0.103, halving the face at the
       exact moment it matters. Swung in to 1.20 m off the camera's left and
       0.18 m forward instead: 4.03 m from his head, falloff 0.180 - the
       same light on the same face - and 13.0 deg off the head-to-lens axis
       rather than 15.0, landing it at ~rgb(58,82,98) against his own coat
       at rgb(14,22,32). Its depth along the view axis is -0.34 m, i.e.
       BEHIND the lens, so it can never appear in shot, and it still dies
       at 7 m, far above the ballast. */
    var fill = new TH.PointLight(0x93b4d4, 0.0, 7.0, 2);
    fill.position.set(PLAYER_X - 1.20, DECK_Y + 1.75, PLAYER_Z + 0.18);
    fill.castShadow = false;
    scene.add(fill);

    /* RIM - the light that turns the mass back into a man. A bridge lamp on
       the far side of the handrail, 0.78 m along the rail from him and out
       over the drop at z DECK_HZ + 0.42, 2.30 m above the deck. It has no
       mesh, so there is nothing of it to see wherever it projects.
       DROPPED AND LENGTHENED this round - 2.55 m up / range 3.60 / 2.40 to
       2.30 m up / range 4.30 / 2.20 - because the old rig lit the top of
       him and abandoned the bottom: (1 - d/3.6)^2 * 2.40 gave 1.08 on the
       crown of his head and 0.14 at his boots, 7.7:1, so his legs and feet
       dissolved into the deck exactly where the eye goes to check whether a
       figure is standing on something. The new numbers give 1.09 on the
       crown, 1.04 on the far shoulder and 0.36 at the boots - 3:1 - so the
       rim runs the WHOLE length of his outline. Lengthening the range while
       lowering the intensity is deliberately self-cancelling at close
       quarters: over the same move the nearest railing stanchion goes 0.89
       -> 1.11, up a quarter, against two and a half times at his boots. And
       this is r134 MeshLambert,
       which lights PER VERTEX, so on the big merged geometry (the deck plate
       is one box, the 18 m handrail one cylinder with rings only at
       x = +-9) it is evaluated metres away and contributes nothing at all.
       It lands on HIM, whose coat, head and limbs are small primitives with
       vertices right there, and on nothing else: no unmotivated pool on the
       planks, no hot spot on the rail.
       It draws his OUTLINE: far shoulder and coat edge ~rgb(66,86,112),
       crown of the head ~rgb(46,63,89), against fog at rgb(44,60,78). One
       side of his silhouette is brighter than the background and the other
       is darker, so the shape cannot dissolve into the murk however badly
       the projector is set up. It is on for the whole scene: it is not a
       moment, it is the read. Nothing here exceeds the key's 2.40. */
    var rim = new TH.PointLight(0x9db9d8, 2.20, 4.30, 2);
    rim.position.set(MAN_X + 0.78, DECK_Y + 2.30, DECK_HZ + 0.42);
    rim.castShadow = false;
    scene.add(rim);

    /* BOUNCE - a lit deck throws light back up, and nothing else in this rig
       does. One weak short-range light at the viewer's own shoulder stands in
       for it. It is the difference between a coat with a form in it (the
       barrel of his back reading round through the 10-segment coat cylinder)
       and a coat that is a hole. Deliberately feeble - 0.90 against the key's
       2.40. Range 5.00 -> 6.80 with the viewer's 0.80 m step back: the throw
       to his torso goes 2.10 -> 2.89 m and (1 - d/r)^2 would have collapsed
       0.337 -> 0.179, flattening the very form it exists to build; at 6.80
       it lands 0.331, the same light it always gave. RANGE, not intensity:
       raising the intensity to 1.70 would have read the same on him and made
       everything within 2 m of the lens - the deck planks and the concrete
       plinths at the bottom of frame - two and a half times brighter, which
       is the last thing this shot needs. It still dies 7.91 m short of the
       ballast, so it lifts him and the two nearest stanchions and leaves the
       rest of the world exactly as cold as it was. */
    var bounce = new TH.PointLight(0x8fa8c4, 0.90, 6.80, 2);
    bounce.position.set(PLAYER_X + 0.15, EYE_Y - 0.35, PLAYER_Z + 0.15);
    bounce.castShadow = false;
    scene.add(bounce);

    /* ------------------------------------------------------------ build */
    var bridge = buildBridge(store);
    scene.add(bridge.group);

    var track = buildTrack(store);
    scene.add(track.group);

    var tro = buildTrolley(store);
    scene.add(tro.group);
    tro.group.position.set(0, 0, -320);

    var hands = buildHands(store);
    camera.add(hands.group);

    /* -------------------------------------------------- instanced bodies */
    var BODIES = 6;                        /* 5 workers + the heavy man    */
    var LIMB_SLOTS = BODIES * LIMB_N + 7;  /* + 5 tools + his 2 boots      */
    var limbGeo = new TH.CylinderGeometry(1, 0.86, 1, 6, 1);
    var limbMat = new TH.MeshLambertMaterial({ color: 0x252c35 });
    var limbs = new TH.InstancedMesh(limbGeo, limbMat, LIMB_SLOTS);
    limbs.frustumCulled = false;
    try { limbs.instanceMatrix.setUsage(TH.DynamicDrawUsage); } catch (e) {}
    scene.add(limbs);
    store.push(limbGeo, limbMat);

    var headParts = [];
    var skullG = new TH.IcosahedronGeometry(0.113, 0);
    var capG = new TH.SphereGeometry(0.118, 8, 4, 0, 6.2832, 0, 1.15);
    var faceG = new TH.BoxGeometry(0.10, 0.07, 0.035);
    headParts.push({ g: skullG, m: mat4(0, 0, 0, 0, 0, 0, 1, 1.06, 0.94), c: colorOf(COL.skin) });
    headParts.push({ g: capG, m: mat4(0, 0.012, 0, 0, 0, 0, 1, 1, 1), c: colorOf(COL.hair) });
    headParts.push({ g: faceG, m: mat4(0, -0.012, 0.098, 0, 0, 0, 1, 1, 1), c: colorOf(0xa8b3bd) });
    var headGeo = mergeParts(headParts);
    skullG.dispose(); capG.dispose(); faceG.dispose();
    var headMat = new TH.MeshLambertMaterial({ vertexColors: true });
    var heads = new TH.InstancedMesh(headGeo, headMat, BODIES);
    heads.frustumCulled = false;
    try { heads.instanceMatrix.setUsage(TH.DynamicDrawUsage); } catch (e) {}
    scene.add(heads);
    store.push(headGeo, headMat);

    /* the one saturated warm colour in the whole scene */
    var vestGeo = new TH.CylinderGeometry(1, 0.94, 1, 8, 1);
    var vestMat = new TH.MeshLambertMaterial({
      color: COL.vest, emissive: COL.vestDim, emissiveIntensity: 1.0
    });
    var vests = new TH.InstancedMesh(vestGeo, vestMat, BODIES);
    vests.frustumCulled = false;
    try { vests.instanceMatrix.setUsage(TH.DynamicDrawUsage); } catch (e) {}
    scene.add(vests);
    store.push(vestGeo, vestMat);

    /* blob shadows */
    var blobTex = texBlob();
    var blobGeo = new TH.PlaneGeometry(1, 1, 1, 1);
    var blobMat = new TH.MeshBasicMaterial({
      map: blobTex, color: 0x000000, transparent: true, opacity: 0.5,
      depthWrite: false, fog: true
    });
    var blobs = new TH.InstancedMesh(blobGeo, blobMat, BODIES + 2);
    blobs.frustumCulled = false;
    blobs.renderOrder = 1;
    try { blobs.instanceMatrix.setUsage(TH.DynamicDrawUsage); } catch (e) {}
    scene.add(blobs);
    store.push(blobGeo, blobMat, blobTex);

    /* particles */
    var dotTex = texSoftDot();
    var parts = new Particles(260, dotTex);
    scene.add(parts.mesh);
    store.push(parts.geo, parts.mat, dotTex);

    /* one low ground-mist band (a single card, quality >= 2 only) */
    var mistGeo = new TH.PlaneGeometry(26, 150, 1, 1);
    var mistMat = new TH.MeshBasicMaterial({
      map: dotTex, color: 0x1a2430, transparent: true, opacity: 0.20,
      depthWrite: false, blending: TH.NormalBlending, fog: true
    });
    var mist = new TH.Mesh(mistGeo, mistMat);
    mist.rotation.x = -Math.PI / 2;
    mist.position.set(0, 0.62, 52);
    mist.renderOrder = 2;
    scene.add(mist);
    store.push(mistGeo, mistMat);

    /* -------------------------------------------------------- the people */
    var bodies = [];
    var workers = [];
    var wi;
    var WPOS = [
      [-1.05, WORKERS_Z - 1.6], [-0.30, WORKERS_Z + 0.5], [0.42, WORKERS_Z - 0.9],
      [1.15, WORKERS_Z + 1.4], [-0.05, WORKERS_Z + 3.0]
    ];
    for (wi = 0; wi < 5; wi++) {
      var b = new Body({
        x: WPOS[wi][0], y: BALLAST_Y, z: WPOS[wi][1],
        yaw: -2.55 + wi * 0.26, height: 1.74 + wi * 0.02,
        pose: (wi === 1 || wi === 3 || wi === 4) ? 'talk' : 'work',
        tool: (wi % 2) === 0, groundY: BALLAST_Y
      });
      bodies.push(b);
      workers.push(makeHumanCtl(b, wi));
    }

    var manBody = new Body({
      x: MAN_X, y: DECK_Y, z: MAN_Z, yaw: MAN_YAW,
      /* wide 1.62 -> 1.26. THIS is what made him a barrel. 'wide' scales the
         SHOULDER AND HIP PARTICLES, not the coat: at 1.62 his shoulder
         sockets stood 0.671 m apart and, with 0.20 m arms hanging off them,
         he measured 0.87 m across the shoulders - a third wider than any
         human being - so no amount of coat detail could make the outline
         read as a person. At 1.26 the sockets are 0.522 m apart and he
         measures 0.691 m across, which is a big man in a heavy coat. The
         MASS moves into the coat, where it belongs: 0.70 m across the hips
         against a worker's 0.36 m vest, 0.70 m across the shoulder yoke
         against their 0.54 m, thighs 0.229 m thick against their 0.198 m.
         Unmistakably the heaviest body in the scene, and unmistakably a
         body. It also brings his hands 0.116 m in along the handrail; they
         are still ON it, at world z 1.49 against a rail at z 1.47. */
      height: 1.80, wide: 1.26, heavy: true, pose: 'lean', groundY: BALLAST_Y
    });
    bodies.push(manBody);
    var manCtl = makeHumanCtl(manBody, 5);

    /* --- his coat, scarf, bag and headphone wire ---------------------- */
    /* HIS SILHOUETTE. The old coat was four straight tubes and a plate: an
       0.81 m barrel from y 1.005 to 1.661 with a 0.61 m COLLAR disc sitting
       at 1.551-1.697, dead level with his head, which it swallowed whole.
       Head inside a collar, collar on a tube, tube on a wider tube: an
       industrial boiler with an arm. No lighting could have rescued it.
       This is a stack of TAPERED sections instead and every join is a
       landmark on a body. Each is quoted below as a WORLD height above the
       deck he stands on and a WORLD radius; updateCoat() carries the mesh
       on the pelvis-to-neck axis and scales it by L * 1.55 = 0.9092, so the
       local offsets written here are (Y - 1.2236) / 0.9092 and the local
       radii are the world radii over his 1.0112 height scale. Bottom to
       top, with what each is worth ON SCREEN in brackets:
         0.760-0.865  hem band, r 0.300 -> 0.318, LIGHTER: the BREAK of the
                      coat [0.50 m]. Below it 0.68 m of bare leg.
         0.865-1.030  skirt, r 0.318 -> 0.352, flaring up over the hips
         1.030-1.140  seat, r 0.352 -> 0.344: the widest of him [0.59 m]
         1.140-1.245  waist, r 0.344 -> 0.292: it PULLS IN [0.50 m]. An
                      outline that narrows and widens again is a body; one
                      that does not is a tank.
         1.245-1.375  chest, r 0.292 -> 0.336: and it widens again
         1.375-1.442  yoke, r 0.336 -> 0.352, LIGHTER: the top of the back,
                      as wide as his hips [0.59 m]
         1.442-1.512  shoulder, r 0.352 -> 0.109, LIGHTER: 0.243 m of radius
                      lost over 0.070 m of height is a SLOPING SHOULDER at
                      21 deg, not a step, and it hands off at 0.218 m across
                      - a collar around a 0.145 m neck, not a tube around a
                      head [0.18 m]
         deltoids     two lumps sitting ON the shoulder sockets, so each arm
                      comes out from under a cap of mass instead of out of a
                      hole in a tube
       Above 1.512 there is nothing but neck. DEPTH is 0.72 of width the
       whole way up and NEVER VARIES, for two reasons. A coat is a slab, and
       a section as round as the old one was half of why he read as a
       cylinder. And the lens stands 72 deg round from straight behind him,
       so depth carries 62% of the outline the audience actually sees: a
       depth ratio that changed from section to section would put a 5-7 px
       STEP in that outline at every join. Held constant, the on-screen
       profile IS the width profile, in brackets above - 0.59 hips, 0.50
       waist, 0.59 shoulder, 0.18 collar, against a 0.24 m head. Every
       section starts at the height and the radius the one below ends at,
       so there is not a step anywhere in him.
       320 triangles against the old 172, on an 8.5k scene. */
    var coatParts = [];
    var coatGeos = [];
    var cCoat = colorOf(COL.coat), cCoatHi = colorOf(COL.coatHi);
    var coatSeg = function (rBot, rTop, o, s, c) {
      var g = new TH.CylinderGeometry(rTop, rBot, 1, 10, 1);
      coatGeos.push(g);
      coatParts.push({ g: g, m: mat4(0, o, 0, 0, 0, 0, 1, s, 0.72), c: c });
    };
    coatSeg(0.2967, 0.3145, -0.4522, 0.1155, cCoatHi);
    coatSeg(0.3145, 0.3480, -0.3037, 0.1815, cCoat);
    coatSeg(0.3480, 0.3402, -0.1524, 0.1210, cCoat);
    coatSeg(0.3402, 0.2888, -0.0342, 0.1155, cCoat);
    coatSeg(0.2888, 0.3323, 0.0950, 0.1430, cCoat);
    coatSeg(0.3323, 0.3480, 0.2034, 0.0737, cCoatHi);
    coatSeg(0.3480, 0.1078, 0.2787, 0.0770, cCoatHi);
    /* the shoulder caps, placed at the SHOULDER SOCKETS as the coat's own
       frame sees them. updateCoat() aligns the mesh to the pelvis-to-neck
       axis only - it carries no yaw at all - so these are WORLD offsets
       with MAN_YAW already worked in, divided by the coat's own scale. */
    var delC = new TH.IcosahedronGeometry(1, 0);
    coatParts.push({ g: delC, m: mat4(-0.2614, 0.1446, -0.0375, 0, 0, 0, 0.116, 0.103, 0.108), c: cCoatHi });
    coatParts.push({ g: delC, m: mat4(0.2240, 0.1446, 0.1397, 0, 0, 0, 0.116, 0.103, 0.108), c: cCoatHi });
    var coatGeo = mergeParts(coatParts);
    for (var cgi = 0; cgi < coatGeos.length; cgi++) coatGeos[cgi].dispose();
    delC.dispose();
    var coatMat = new TH.MeshLambertMaterial({ vertexColors: true });
    var coat = new TH.Mesh(coatGeo, coatMat);
    coat.frustumCulled = false;
    scene.add(coat);
    store.push(coatGeo, coatMat);

    /* scarf: a small verlet strip, 8 nodes, wind driven */
    var SC_N = 8;
    var scX = new Float32Array(SC_N * 3), scP = new Float32Array(SC_N * 3);
    var scVerts = new Float32Array(SC_N * 2 * 3);
    var scGeo = new TH.BufferGeometry();
    var scAttr = new TH.BufferAttribute(scVerts, 3);
    try { scAttr.setUsage(TH.DynamicDrawUsage); } catch (e) {}
    scGeo.setAttribute('position', scAttr);
    var scIdx = [];
    for (wi = 0; wi < SC_N - 1; wi++) {
      var a0 = wi * 2, b0 = wi * 2 + 1, a1 = wi * 2 + 2, b1 = wi * 2 + 3;
      scIdx.push(a0, b0, a1, b0, b1, a1);
    }
    scGeo.setIndex(scIdx);
    var scMat = new TH.MeshBasicMaterial({ color: COL.scarf, side: TH.DoubleSide, fog: true });
    var scarf = new TH.Mesh(scGeo, scMat);
    scarf.frustumCulled = false;
    scene.add(scarf);
    store.push(scGeo, scMat);
    (function initScarf() {
      for (var i = 0; i < SC_N; i++) {
        scX[i * 3] = MAN_X; scX[i * 3 + 1] = DECK_Y + 1.44 - i * 0.10; scX[i * 3 + 2] = MAN_Z - 0.06;
      }
      scP.set(scX);
    })();

    /* shopping bag */
    var bagParts = [];
    var bagB = new TH.BoxGeometry(1, 1, 1);
    bagParts.push({ g: bagB, m: mat4(0, -0.20, 0, 0, 0, 0, 0.26, 0.34, 0.16), c: colorOf(COL.bag) });
    bagParts.push({ g: bagB, m: mat4(0, -0.01, 0, 0, 0, 0, 0.20, 0.06, 0.12), c: colorOf(0x4a525c) });
    var bagGeo = mergeParts(bagParts);
    bagB.dispose();
    var bagMat = new TH.MeshLambertMaterial({ vertexColors: true });
    var bag = new TH.Mesh(bagGeo, bagMat);
    bag.frustumCulled = false;
    scene.add(bag);
    store.push(bagGeo, bagMat);

    /* headphone wire */
    var WIRE_N = 12;
    var wireArr = new Float32Array(WIRE_N * 3);
    var wireGeo = new TH.BufferGeometry();
    var wireAttr = new TH.BufferAttribute(wireArr, 3);
    try { wireAttr.setUsage(TH.DynamicDrawUsage); } catch (e) {}
    wireGeo.setAttribute('position', wireAttr);
    var wireMat = new TH.LineBasicMaterial({ color: 0x0e1218, fog: true });
    var wire = new TH.Line(wireGeo, wireMat);
    wire.frustumCulled = false;
    scene.add(wire);
    store.push(wireGeo, wireMat);

    /* ------------------------------------------------------------ state */
    var S = {
      t: 0,
      quality: 3,
      tension: 0,
      phase: '',
      lastPhase: '',
      handReach: 0, handReachTarget: 0,
      pushProg: 0, pushProgTarget: 0,
      lookBack: 0, lookBackTarget: 0, lookBackTarget: 0,
      pushed: false,
      pushT: -1,
      manSupport: 0,
      trolleyZ: -320,
      trolleyTarget: -320,
      trolleyMode: 'manual',      /* manual | run | grind | stopped */
      trolleySpeed: 0,
      trolleyShownSpeed: 0,
      trolleyGate: Infinity,
      grindDecel: 34,
      grindT: 0,
      hitFive: false,
      hitMan: false,
      landed: false,
      passedUnder: false,
      aftermathT: -1,
      coneFade: 1,
      camMode: 'bridge',
      camCut: 0,
      shake: 0, shakeDecay: 1,
      windPhase: Math.random() * 100,
      breathT: 1.4,
      sparkT: 0,
      alive: true,
      acc: 0
    };

    /* camera poses */
    var CAM = {
      /* THE SHOT THE LESSON TURNS ON. Was p(-1.10,8.52,0.62) l(4.67,5.54,8.87)
         fov 58: 1.51 m from him, pitched 16.5 deg down. Projected on r134 at
         16:9 that put the crown of his head at ndc y +0.80 and his feet at
         -1.43 - a man with no bottom and barely a top, filling the left half
         of the frame as one mass. That is the screenshot the note is about.
         Round 2 went to p(-1.47,8.52,-0.37) l(6.07,3.86,15.30) fov 54 and
         MEASURED, on the r134 camRoot.lookAt + rotateY(PI) basis, at crown
         ndc +0.74 and boots -0.86: he still stood 80% of the frame height
         tall with his feet 7% off the bottom edge, under the vignette, and
         his own hand crossing to ndc -0.18. A wall, not a man beside you.
         Now p(-2.09,8.52,-0.86) l(5.07,4.78,15.22) fov 55: 3.10 m from him
         on the same bearing, yaw 24.0 deg, pitch 12.0 deg down, 1 deg wider
         on the lens. Projected the same way, with MAN_YAW applied, the lean
         in the pose and the rebuilt body below:
           crown      ndc(-0.58, +0.58)  21% of the frame height above him
           head       ndc(-0.57, +0.48)  62 px wide at 1280x720
           neck       24 px of it, bare, between coat collar and jaw
           shoulders  ndc(-0.49 .. -0.57, +0.20 .. +0.23)
           near hand  ndc(-0.31, +0.09)  his arm runs out along the rail
           boots      ndc(-0.44 / -0.53, -0.61 / -0.55), near toe -0.60:
                      IN frame, 19% of the height to spare
           the five   ndc(+0.39 .. +0.44, +0.05 .. +0.09)  27-30 px tall
         So: a whole heavy man standing beside the lens in the left third,
         two thirds of the frame width open past him - deck, rail, track and
         the five over the rail in the right third - and nothing of him
         touching an edge. The margins are the thing to protect on any edit:
         21% over his head, 19% under his boots.
         Re-checked at 4:3, where the horizontal-FOV lock below widens the
         lens to 69.5 deg (crown +0.44, boots -0.44), at 16:10 (+0.53,
         -0.52), and at fov 57.5, the widest tension and speed can push it
         (+0.56, -0.55): every element simply moves toward the middle. */
      bridge: { p: [PLAYER_X, EYE_Y, PLAYER_Z], l: [5.07, 4.78, 15.22], fov: 55 },
      follow: { p: [PLAYER_X + 0.10, EYE_Y + 0.05, PLAYER_Z + 0.55], l: [0.30, 1.0, 5.4], fov: 62 },
      wide: { p: [-1.35, DECK_Y + 5.6, -10.6], l: [0.25, 0.9, 55.0], fov: 52 },
      after: { p: [PLAYER_X + 0.05, EYE_Y - 0.06, PLAYER_Z + 0.30], l: [0.28, 0.7, 9.0], fov: 55 }
    };
    var camP = new TH.Vector3(CAM.bridge.p[0], CAM.bridge.p[1], CAM.bridge.p[2]);
    var camL = new TH.Vector3(CAM.bridge.l[0], CAM.bridge.l[1], CAM.bridge.l[2]);
    var camFov = CAM.bridge.fov;
    camRoot.position.copy(camP);

    /* hand rig rest/target, in CAMERA-LOCAL space */
    var HAND_REST = [[-0.285, -0.300, -0.560], [0.255, -0.300, -0.560]];
    var ELBOW_REST = [[-0.330, -0.560, -0.115], [0.300, -0.560, -0.115]];
    var handCur = [new TH.Vector3(), new TH.Vector3()];
    var elbowCur = [new TH.Vector3(), new TH.Vector3()];
    handCur[0].set(HAND_REST[0][0], HAND_REST[0][1], HAND_REST[0][2]);
    handCur[1].set(HAND_REST[1][0], HAND_REST[1][1], HAND_REST[1][2]);
    elbowCur[0].set(ELBOW_REST[0][0], ELBOW_REST[0][1], ELBOW_REST[0][2]);
    elbowCur[1].set(ELBOW_REST[1][0], ELBOW_REST[1][1], ELBOW_REST[1][2]);

    var _hTarget = new TH.Vector3();
    var _hTmp = new TH.Vector3();

    /* env handed to the ragdoll solver */
    var ENV = {
      railZ: DECK_HZ - 0.08, railY: RAIL_TOP - 0.06, railR: 0.34, support: 0,
      deckY: DECK_Y, deckHX: DECK_HX,
      tro: { active: false, z0: 0, z1: 0, vz: 0, reach: 2.2 }
    };

    /* =================================================================
       PER-FRAME WRITERS
       ================================================================= */
    var _mm = new TH.Matrix4(), _qq = new TH.Quaternion(), _pp = new TH.Vector3(),
        _ss = new TH.Vector3(), _dd = new TH.Vector3(), _ee = new TH.Euler();

    function writeLimb(slot, x, ia, ib, th) {
      var a = ia * 3, b = ib * 3;
      _dd.set(x[b] - x[a], x[b + 1] - x[a + 1], x[b + 2] - x[a + 2]);
      var L = _dd.length();
      if (L < 1e-5) L = 1e-5;
      _dd.multiplyScalar(1 / L);
      _pp.set((x[a] + x[b]) * 0.5, (x[a + 1] + x[b + 1]) * 0.5, (x[a + 2] + x[b + 2]) * 0.5);
      _qq.setFromUnitVectors(_up, _dd);
      _ss.set(th, L, th);
      _mm.compose(_pp, _qq, _ss);
      limbs.setMatrixAt(slot, _mm);
    }

    function writeBodies() {
      var bi, li, slot = 0, b, x, th;
      for (bi = 0; bi < bodies.length; bi++) {
        b = bodies[bi]; x = b.x;
        for (li = 0; li < LIMB_N; li++) {
          th = LIMBS[li][2] * (1 + (b.wide - 1) * 0.60) * b.hs;
          writeLimb(slot++, x, LIMBS[li][0], LIMBS[li][1], th);
        }
        /* head */
        _pp.set(x[P_HEAD * 3], x[P_HEAD * 3 + 1], x[P_HEAD * 3 + 2]);
        if (b.mode === 'ragdoll') {
          _dd.set(x[P_HEAD * 3] - x[P_NECK * 3], x[P_HEAD * 3 + 1] - x[P_NECK * 3 + 1],
                  x[P_HEAD * 3 + 2] - x[P_NECK * 3 + 2]);
          if (_dd.lengthSq() < 1e-8) _dd.set(0, 1, 0);
          _dd.normalize();
          _qq.setFromUnitVectors(_up, _dd);
        } else {
          _ee.set(b.headPitch, b.yaw + b.headYaw + b.twist * 0.35, 0, 'YXZ');
          _qq.setFromEuler(_ee);
        }
        /* 1.12 -> 1.04: at 1.12 his head was 0.256 m across against 0.691 m
           of shoulder - 2.7 head-widths - which reads as a dome sunk into a
           tank. 1.04 gives 0.238 m and 2.9 head-widths, and lifts his jaw a
           further 0.015 m clear of the coat. Still the biggest head in the
           scene, and still the only one this line touches. */
        var hsz = b.hs * (b.heavy ? 1.04 : 1.0);
        _ss.set(hsz, hsz, hsz);
        _mm.compose(_pp, _qq, _ss);
        heads.setMatrixAt(bi, _mm);

        /* vest — the heavy man wears a coat instead, so his slot collapses */
        if (b.heavy) {
          _ss.set(0.0001, 0.0001, 0.0001);
          _pp.set(0, -50, 0);
          _qq.identity();
          _mm.compose(_pp, _qq, _ss);
          vests.setMatrixAt(bi, _mm);
        } else {
          /* the vest spans pelvis -> neck: it IS the torso for the workers */
          var pl = P_PLL * 3, pr = P_PLR * 3, b2 = P_NECK * 3;
          var hx0 = (x[pl] + x[pr]) * 0.5;
          var hy0 = (x[pl + 1] + x[pr + 1]) * 0.5;
          var hz0 = (x[pl + 2] + x[pr + 2]) * 0.5;
          _dd.set(x[b2] - hx0, x[b2 + 1] - hy0, x[b2 + 2] - hz0);
          var L2 = _dd.length(); if (L2 < 1e-5) L2 = 1e-5;
          _dd.multiplyScalar(1 / L2);
          _pp.set((hx0 + x[b2]) * 0.5, (hy0 + x[b2 + 1]) * 0.5, (hz0 + x[b2 + 2]) * 0.5);
          _qq.setFromUnitVectors(_up, _dd);
          var vt = 0.180 * b.wide * b.hs;
          _ss.set(vt, L2 * 1.02, vt * 0.74);
          _mm.compose(_pp, _qq, _ss);
          vests.setMatrixAt(bi, _mm);
        }
      }
      /* tools in the workers' hands */
      for (bi = 0; bi < 5; bi++) {
        b = bodies[bi];
        if (!b.tool || b.mode === 'ragdoll') {
          _ss.set(0.0001, 0.0001, 0.0001); _pp.set(0, -50, 0); _qq.identity();
          _mm.compose(_pp, _qq, _ss);
          limbs.setMatrixAt(slot++, _mm);
          continue;
        }
        var hx = b.x[P_HNR * 3], hy = b.x[P_HNR * 3 + 1], hz = b.x[P_HNR * 3 + 2];
        _pp.set(hx, hy - 0.34, hz + 0.06);
        _dd.set(0.10, 1.0, 0.16).normalize();
        _qq.setFromUnitVectors(_up, _dd);
        _ss.set(0.026, 1.05, 0.026);
        _mm.compose(_pp, _qq, _ss);
        limbs.setMatrixAt(slot++, _mm);
      }
      /* HIS BOOTS. Two more instances of the limb cylinder, and they are
         the difference between a man standing on a bridge and a coat
         hovering over one: the shin cylinders stop dead at the ankle, and
         an ankle that ends in nothing is the clearest tell there is that a
         figure is not a figure. 0.30 m long and 0.196 m across - a shade
         wider than the 0.182 m ankle they swallow - laid along his facing
         with the toe 5.7 deg up, so the sole sits on the planks and the
         heel clips a centimetre into them rather than floating over them.
         The limb cylinder is fatter at its +Y end, which here is the TOE:
         a work boot, broad at the front and narrow at the heel.
         Once he is a ragdoll there is no facing to speak of, so they lie
         along the shin instead and the leg simply ends in a foot - no pop
         at the one moment the class is watching him go over. Scratch
         matrix, quaternion and vectors are the writer's own: nothing here
         allocates. */
      for (bi = 0; bi < 2; bi++) {
        var bft = (bi === 0 ? P_FTL : P_FTR) * 3;
        var bkn = (bi === 0 ? P_KNL : P_KNR) * 3;
        if (manBody.mode === 'ragdoll') {
          _dd.set(manBody.x[bft] - manBody.x[bkn],
                  manBody.x[bft + 1] - manBody.x[bkn + 1],
                  manBody.x[bft + 2] - manBody.x[bkn + 2]);
          if (_dd.lengthSq() < 1e-8) _dd.set(0, -1, 0);
          _dd.normalize();
          _ss.set(0.098, 0.22, 0.098);
          _pp.set(manBody.x[bft] + _dd.x * 0.055,
                  manBody.x[bft + 1] + _dd.y * 0.055,
                  manBody.x[bft + 2] + _dd.z * 0.055);
        } else {
          _dd.set(Math.sin(manBody.yaw), 0.10, Math.cos(manBody.yaw)).normalize();
          _ss.set(0.098, 0.30, 0.098);
          _pp.set(manBody.x[bft] + _dd.x * 0.072,
                  manBody.x[bft + 1] + 0.010,
                  manBody.x[bft + 2] + _dd.z * 0.072);
        }
        _qq.setFromUnitVectors(_up, _dd);
        _mm.compose(_pp, _qq, _ss);
        limbs.setMatrixAt(slot++, _mm);
      }
      while (slot < LIMB_SLOTS) {
        _ss.set(0.0001, 0.0001, 0.0001); _pp.set(0, -50, 0); _qq.identity();
        _mm.compose(_pp, _qq, _ss);
        limbs.setMatrixAt(slot++, _mm);
      }
      limbs.instanceMatrix.needsUpdate = true;
      heads.instanceMatrix.needsUpdate = true;
      vests.instanceMatrix.needsUpdate = true;
    }

    function writeBlobs() {
      var bi, b, x, sc;
      for (bi = 0; bi < bodies.length; bi++) {
        b = bodies[bi]; x = b.x;
        var gy = (b === manBody && !S.pushed) ? DECK_Y + 0.03 : BALLAST_Y + 0.03;
        var cy = x[P_CORE * 3 + 1];
        var h = Math.max(0, cy - gy);
        sc = clamp(1.5 - h * 0.28, 0.35, 1.6) * (b.heavy ? 1.55 : 1.05);
        _pp.set(x[P_CORE * 3], gy, x[P_CORE * 3 + 2]);
        _ee.set(-Math.PI / 2, 0, 0, 'XYZ');
        _qq.setFromEuler(_ee);
        _ss.set(sc, sc, 1);
        _mm.compose(_pp, _qq, _ss);
        blobs.setMatrixAt(bi, _mm);
      }
      for (; bi < BODIES + 2; bi++) {
        _ss.set(0.0001, 0.0001, 0.0001); _pp.set(0, -50, 0); _qq.identity();
        _mm.compose(_pp, _qq, _ss);
        blobs.setMatrixAt(bi, _mm);
      }
      blobs.instanceMatrix.needsUpdate = true;
    }

    /* --------------------------------------------------- coat and scarf */
    function updateCoat() {
      var x = manBody.x;
      var a = P_PLL * 3, a2 = P_PLR * 3, b = P_NECK * 3;
      var px = (x[a] + x[a2]) * 0.5, py = (x[a + 1] + x[a2 + 1]) * 0.5, pz = (x[a + 2] + x[a2 + 2]) * 0.5;
      _dd.set(x[b] - px, x[b + 1] - py, x[b + 2] - pz);
      var L = _dd.length(); if (L < 1e-5) L = 1e-5;
      _dd.multiplyScalar(1 / L);
      _pp.set((px + x[b]) * 0.5, (py + x[b + 1]) * 0.5, (pz + x[b + 2]) * 0.5);
      _qq.setFromUnitVectors(_up, _dd);
      var squash = 1 - 0.13 * S.pushProg;
      _ss.set(1.0 * manBody.hs, L * 1.55, squash * manBody.hs);
      coat.position.copy(_pp);
      coat.quaternion.copy(_qq);
      coat.scale.copy(_ss);
    }

    function updateScarf(dt) {
      var x = manBody.x;
      /* anchor at the neck */
      scX[0] = x[P_NECK * 3] + 0.02;
      scX[1] = x[P_NECK * 3 + 1] + 0.05;
      scX[2] = x[P_NECK * 3 + 2] - 0.03;
      scP[0] = scX[0]; scP[1] = scX[1]; scP[2] = scX[2];

      var wind = 0.55 + 0.45 * Math.sin(S.t * 0.47 + S.windPhase) + 0.22 * Math.sin(S.t * 1.31);
      var h = clamp(dt, 0.002, 0.05);
      var i, i3, vx, vy, vz;
      for (i = 1; i < SC_N; i++) {
        i3 = i * 3;
        vx = (scX[i3] - scP[i3]) * 0.96;
        vy = (scX[i3 + 1] - scP[i3 + 1]) * 0.96;
        vz = (scX[i3 + 2] - scP[i3 + 2]) * 0.96;
        scP[i3] = scX[i3]; scP[i3 + 1] = scX[i3 + 1]; scP[i3 + 2] = scX[i3 + 2];
        scX[i3] += vx + (-0.55 * wind + Math.sin(S.t * 2.7 + i) * 0.20) * h * h * 26;
        scX[i3 + 1] += vy - 7.4 * h * h + Math.sin(S.t * 3.3 + i * 0.7) * 0.10 * h * h * 26;
        scX[i3 + 2] += vz + (0.85 * wind + Math.cos(S.t * 2.1 + i * 0.5) * 0.30) * h * h * 26;
      }
      /* keep the links together */
      var it, seg = 0.115 * manBody.hs;
      for (it = 0; it < 5; it++) {
        for (i = 1; i < SC_N; i++) {
          var p3 = (i - 1) * 3; i3 = i * 3;
          var dx = scX[i3] - scX[p3], dy = scX[i3 + 1] - scX[p3 + 1], dz = scX[i3 + 2] - scX[p3 + 2];
          var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d < 1e-6) { d = 1e-6; dy = -1e-6; }
          var f = (d - seg) / d;
          if (i === 1) { scX[i3] -= dx * f; scX[i3 + 1] -= dy * f; scX[i3 + 2] -= dz * f; }
          else {
            scX[p3] += dx * f * 0.5; scX[p3 + 1] += dy * f * 0.5; scX[p3 + 2] += dz * f * 0.5;
            scX[i3] -= dx * f * 0.5; scX[i3 + 1] -= dy * f * 0.5; scX[i3 + 2] -= dz * f * 0.5;
          }
        }
      }
      /* build the ribbon */
      var wdir = 0.075 * manBody.hs;
      for (i = 0; i < SC_N; i++) {
        i3 = i * 3;
        var nx, ny, nz;
        if (i < SC_N - 1) { nx = scX[i3 + 3] - scX[i3]; ny = scX[i3 + 4] - scX[i3 + 1]; nz = scX[i3 + 5] - scX[i3 + 2]; }
        else { nx = scX[i3] - scX[i3 - 3]; ny = scX[i3 + 1] - scX[i3 - 2]; nz = scX[i3 + 2] - scX[i3 - 1]; }
        /* side vector = dir x up */
        var sx = ny * 0 - nz * 1, sy = nz * 0 - nx * 0, sz = nx * 1 - ny * 0;
        var sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
        if (sl < 1e-6) { sx = 1; sy = 0; sz = 0; sl = 1; }
        sx /= sl; sy /= sl; sz /= sl;
        var o0 = i * 6;
        scVerts[o0] = scX[i3] - sx * wdir; scVerts[o0 + 1] = scX[i3 + 1] - sy * wdir; scVerts[o0 + 2] = scX[i3 + 2] - sz * wdir;
        scVerts[o0 + 3] = scX[i3] + sx * wdir; scVerts[o0 + 4] = scX[i3 + 1] + sy * wdir; scVerts[o0 + 5] = scX[i3 + 2] + sz * wdir;
      }
      scAttr.needsUpdate = true;
    }

    function updateBagAndWire(dt) {
      var x = manBody.x;
      var hx = x[P_HNL * 3], hy = x[P_HNL * 3 + 1], hz = x[P_HNL * 3 + 2];
      var sw = Math.sin(S.t * 1.15 + 0.6) * 0.045;
      bag.position.set(hx + sw, hy - 0.30, hz + sw * 0.4);
      bag.rotation.z = sw * 0.6;
      bag.rotation.x = Math.sin(S.t * 0.9) * 0.05;
      bag.scale.setScalar(manBody.hs);

      /* headphone wire: ear -> a sagging catenary -> coat pocket */
      var ex = x[P_HEAD * 3] - 0.075, ey = x[P_HEAD * 3 + 1] - 0.02, ez = x[P_HEAD * 3 + 2] - 0.02;
      var px = x[P_CORE * 3] - 0.16, py = x[P_CORE * 3 + 1] - 0.10, pz = x[P_CORE * 3 + 2] - 0.14;
      var i;
      for (i = 0; i < WIRE_N; i++) {
        var t = i / (WIRE_N - 1);
        var sag = Math.sin(t * Math.PI) * 0.16;
        var sway = Math.sin(S.t * 1.6 + t * 3.0) * 0.022 * (0.2 + t);
        wireArr[i * 3] = lerp(ex, px, t) + sway;
        wireArr[i * 3 + 1] = lerp(ey, py, t) - sag;
        wireArr[i * 3 + 2] = lerp(ez, pz, t) + sway * 0.5;
      }
      wireAttr.needsUpdate = true;
    }

    /* ------------------------------------------------------------ hands */
    function updateHands(dt) {
      var reach = S.handReach;
      var push = S.pushProg;

      /* target: the middle of his back, converted into camera space */
      var x = manBody.x;
      _hTarget.set(
        (x[P_CHL * 3] + x[P_CHR * 3]) * 0.5,
        (x[P_CHL * 3 + 1] + x[P_CHR * 3 + 1]) * 0.5 - 0.02,
        (x[P_CHL * 3 + 2] + x[P_CHR * 3 + 2]) * 0.5 - 0.24
      );
      camera.updateMatrixWorld();
      camera.worldToLocal(_hTarget);
      /* The push is the whole scene and the hands are drawn AT this point, so
         its DISTANCE is their apparent size. The middle of his back is 2.22 m
         from the eye now instead of 1.49, and unclamped the viewer's own
         hands would shrink by a third - and spread 49% wider apart, since the
         +-0.155 m offset below is applied in camera space - at the exact
         moment they matter.
         Cap the distance at the 1.45 m the shot was verified at and keep the
         DIRECTION, so on screen they land on the middle of his back exactly
         as before (they are nearer than he is, so they cover it) at the size
         and spread of a pair of human hands. Scalar maths on a scratch
         vector: no allocation. */
      var hLen = _hTarget.length();
      if (hLen > 1.45) _hTarget.multiplyScalar(1.45 / hLen);

      var k = smooth(reach);
      var i;
      for (i = 0; i < 2; i++) {
        var sgn = i === 0 ? -1 : 1;
        _hTmp.set(_hTarget.x + sgn * 0.155, _hTarget.y + 0.02, _hTarget.z + push * 0.16);
        handCur[i].x = lerp(HAND_REST[i][0], _hTmp.x, k);
        handCur[i].y = lerp(HAND_REST[i][1], _hTmp.y, k);
        handCur[i].z = lerp(HAND_REST[i][2], _hTmp.z, k);
        /* tremble grows with tension and with strain */
        var tr = (0.0022 + S.tension * 0.0055 + push * 0.010);
        handCur[i].x += Math.sin(S.t * 23.0 + i * 2.1) * tr;
        handCur[i].y += Math.sin(S.t * 19.7 + i * 4.3) * tr * 1.2;
        handCur[i].z += Math.sin(S.t * 27.3 + i * 1.3) * tr * 0.6;

        elbowCur[i].x = lerp(ELBOW_REST[i][0], ELBOW_REST[i][0] + sgn * 0.05, k);
        elbowCur[i].y = lerp(ELBOW_REST[i][1], ELBOW_REST[i][1] + 0.10, k);
        elbowCur[i].z = lerp(ELBOW_REST[i][2], ELBOW_REST[i][2] + 0.02 - push * 0.05, k);

        var arm = i === 0 ? hands.armL : hands.armR;
        arm.position.copy(handCur[i]);
        _dd.copy(elbowCur[i]).sub(handCur[i]);
        var L = _dd.length(); if (L < 1e-5) L = 1e-5;
        _dd.multiplyScalar(1 / L);
        _qq.setFromUnitVectors(_fwd, _dd);
        arm.quaternion.copy(_qq);
        var st = clamp(L / 0.52, 0.6, 1.9);
        arm.scale.set(1, 1, st);
      }
    }

    /* ---------------------------------------------------- camera driving */
    function setCamMode(mode, instant) {
      if (!CAM[mode]) return;
      S.camMode = mode;
      if (instant) {
        camP.set(CAM[mode].p[0], CAM[mode].p[1], CAM[mode].p[2]);
        camL.set(CAM[mode].l[0], CAM[mode].l[1], CAM[mode].l[2]);
        camFov = CAM[mode].fov;
      }
    }

    function updateCamera(dt) {
      var tgt = CAM[S.camMode] || CAM.bridge;
      var sp = (S.camMode === 'wide') ? 1.0 : 0.9;
      var k = 1 - Math.pow(0.0016, dt * sp);
      camP.x = lerp(camP.x, tgt.p[0], k);
      camP.y = lerp(camP.y, tgt.p[1], k);
      camP.z = lerp(camP.z, tgt.p[2], k);
      camL.x = lerp(camL.x, tgt.l[0], k);
      camL.y = lerp(camL.y, tgt.l[1], k);
      camL.z = lerp(camL.z, tgt.l[2], k);

      /* if we are following the falling man, track him */
      if (S.camMode === 'follow' && S.pushed) {
        var x = manBody.x;
        camL.x = lerp(camL.x, x[P_CORE * 3], 1 - Math.pow(0.02, dt));
        camL.y = lerp(camL.y, x[P_CORE * 3 + 1] + 0.2, 1 - Math.pow(0.02, dt));
        camL.z = lerp(camL.z, x[P_CORE * 3 + 2] + 1.0, 1 - Math.pow(0.02, dt));
      }

      /* wind sway + handheld micro drift + impact shake */
      var sway = Math.sin(S.t * 0.63 + S.windPhase) * 0.012 + Math.sin(S.t * 1.37) * 0.005;
      var bob = Math.sin(S.t * 0.81 + 1.2) * 0.009;
      var sh = S.shake;
      if (sh > 0) {
        S.shake = Math.max(0, S.shake - dt * S.shakeDecay);
      }
      var shx = sh * (Math.sin(S.t * 61.0) * 0.5 + Math.sin(S.t * 37.0) * 0.5) * 0.10;
      var shy = sh * (Math.sin(S.t * 53.0) * 0.5 + Math.sin(S.t * 29.0) * 0.5) * 0.09;

      camRoot.position.set(camP.x + sway + shx, camP.y + bob + shy, camP.z + shx * 0.4);
      _v1.set(camL.x, camL.y, camL.z);
      camRoot.lookAt(_v1);
      /* camRoot is a GROUP, not a camera. Object3D.lookAt() aims a plain
         object's +Z at the target, but the child camera looks down its own
         -Z, so without this flip the bridge view faces exactly 180 deg AWAY
         from camL and the entire scene renders behind the viewer. Measured
         on r134: forward.dot(wanted) = -1.0000. rotateY() uses module-level
         scratch, so this costs no per-frame allocation. */
      camRoot.rotateY(Math.PI);
      camRoot.rotation.z += sh * Math.sin(S.t * 41.0) * 0.035 + Math.sin(S.t * 0.41) * 0.004;

      /* horizontal-FOV lock: the framing must survive 1280x720, 1366x768 AND
         a phone in portrait. Widen vertically when the frame gets narrow. */
      var wantFov = tgt.fov + S.tension * 2.0 + clamp(S.trolleyShownSpeed / 46, 0, 1) * 2.5;
      var asp = camera.aspect || (16 / 9);
      if (asp < 16 / 9) {
        wantFov = 2 * Math.atan(Math.tan(wantFov * Math.PI / 360) * (16 / 9) / asp) * 180 / Math.PI;
      }
      wantFov = clamp(wantFov, 45, 92);
      camFov = lerp(camFov, wantFov, 1 - Math.pow(0.05, dt));
      if (Math.abs(camera.fov - camFov) > 0.02) {
        camera.fov = camFov;
        camera.updateProjectionMatrix();
      }
    }

    /* ---------------------------------------------------------- trolley */
    function trolleyBoxUpdate() {
      ENV.tro.z0 = S.trolleyZ - tro.length;
      ENV.tro.z1 = S.trolleyZ;
      ENV.tro.vz = S.trolleyShownSpeed;
      ENV.tro.active = (S.trolleyShownSpeed > 0.5) || S.trolleyMode === 'grind';
    }

    function updateTrolley(dt) {
      var prev = S.trolleyZ;
      if (S.trolleyMode === 'manual') {
        S.trolleyZ = lerp(S.trolleyZ, S.trolleyTarget, 1 - Math.pow(0.0008, dt));
      } else if (S.trolleyMode === 'run') {
        S.trolleyZ += S.trolleySpeed * dt;
      } else if (S.trolleyMode === 'grind') {
        S.grindT += dt;
        S.trolleySpeed = Math.max(0, S.trolleySpeed - S.grindDecel * dt);
        S.trolleyZ += S.trolleySpeed * dt;
        if (S.trolleySpeed <= 0.01) { S.trolleySpeed = 0; S.trolleyMode = 'stopped'; }
      }
      /* It cannot arrive before he has landed. He falls, it closes, and the
         two meet — a 0.2 s hold at 40 m/s in heavy fog is invisible, and it
         guarantees the read: the body stops the trolley. */
      if (isFinite(S.trolleyGate)) {
        var gate = Math.max(prev, S.trolleyGate);
        if (S.trolleyZ > gate) S.trolleyZ = gate;
      }
      if (S.trolleyZ > 126) { S.trolleyZ = 126; S.trolleySpeed = 0; S.trolleyMode = 'stopped'; }
      S.trolleyShownSpeed = Math.abs(S.trolleyZ - prev) / Math.max(dt, 1e-4);
      tro.group.position.z = S.trolleyZ;
      trolleyBoxUpdate();

      /* it passes directly beneath us: the whole bridge takes the hit */
      if (!S.passedUnder && prev < 0 && S.trolleyZ >= 0 && S.trolleyShownSpeed > 8) {
        S.passedUnder = true;
        shake(clamp(S.trolleyShownSpeed / 46, 0.25, 0.75), 1.0);
      }

      /* lamp/cone intensity breathes with speed, dims when stopped */
      var lit = S.trolleyMode === 'stopped' ? 0.42 : 1.0;
      var op = 0.20 + 0.16 * clamp(S.trolleyShownSpeed / 30, 0, 1);
      if (tro.coneMat && tro.coneMat.uniforms) {
        tro.coneMat.uniforms.uOpacity.value = (S.quality >= 1 ? op : op * 0.6) * lit * S.coneFade;
      }
      if (tro.light) tro.light.intensity = (S.quality >= 2 ? HEADLAMP_I : 0) * lit * S.coneFade;

      /* sparks off the rails while it runs, a shower while it grinds */
      if (S.quality >= 1 && S.trolleyShownSpeed > 3) {
        S.sparkT -= dt;
        var rate = S.trolleyMode === 'grind' ? 0.010 : 0.055;
        if (S.sparkT <= 0) {
          S.sparkT = rate;
          var n = S.trolleyMode === 'grind' ? 5 : 2;
          var i;
          for (i = 0; i < n; i++) {
            var sx = (Math.random() < 0.5 ? -GAUGE : GAUGE) + rnd(-0.05, 0.05);
            var sz = S.trolleyZ - rnd(1.0, 12.0);
            parts.spawn(sx, RAILHEAD_Y + 0.02, sz,
              rnd(-2.4, 2.4), rnd(0.6, 4.0), rnd(-3.0, 1.2) + S.trolleyShownSpeed * 0.10,
              1.0, 0.62, 0.26, rnd(0.22, 0.55), -13);
          }
        }
      }
    }

    /* -------------------------------------------------------- the events */
    function shake(a, d) { S.shake = Math.max(S.shake, a); S.shakeDecay = 1 / Math.max(0.12, d || 1); }

    function debrisBurst(x, y, z, amount, warm) {
      var n = Math.round(amount * [0.28, 0.5, 0.78, 1][clamp(S.quality, 0, 3)]);
      var i;
      for (i = 0; i < n; i++) {
        var sp = rnd(2.0, 11.0);
        var a = Math.random() * 6.2832, e = rnd(0.05, 1.15);
        var r = warm ? 1.0 : 0.62, g = warm ? 0.52 : 0.68, b = warm ? 0.24 : 0.78;
        parts.spawn(x + rnd(-0.4, 0.4), y + rnd(0, 1.1), z + rnd(-0.5, 0.5),
          Math.cos(a) * sp * 0.5, Math.sin(e) * sp * 0.75, Math.sin(a) * sp * 0.4 + rnd(2, 9),
          r, g, b, rnd(0.5, 1.7), -11);
      }
    }

    function breathPuff() {
      if (S.quality < 1 || S.pushed) return;
      var x = manBody.x;
      var hx = x[P_HEAD * 3], hy = x[P_HEAD * 3 + 1], hz = x[P_HEAD * 3 + 2];
      var yaw = manBody.yaw + manBody.headYaw;
      var fx = Math.sin(yaw), fz = Math.cos(yaw);
      var i;
      for (i = 0; i < 5; i++) {
        parts.spawn(hx + fx * 0.12 + rnd(-0.03, 0.03), hy - 0.03 + rnd(-0.02, 0.02), hz + fz * 0.12 + rnd(-0.03, 0.03),
          fx * rnd(0.25, 0.7) + rnd(-0.12, 0.12), rnd(0.10, 0.34), fz * rnd(0.25, 0.7) + rnd(-0.12, 0.12),
          0.30, 0.36, 0.44, rnd(0.9, 1.7), 0.22);
      }
    }

    function launchBody(b, vz, vy, spread) {
      b.goRagdoll();
      /* they are thrown clear; the tram must grind ON, not bulldoze them
         seventy metres down the line */
      b.troImmune = 1.7;
      var h = RD_H;
      var i;
      for (i = 0; i < 15; i++) {
        var up = (i === P_HEAD || i === P_NECK || i === P_CHL || i === P_CHR) ? 1.35 :
                 ((i === P_FTL || i === P_FTR) ? 0.75 : 1.0);
        b.addVel(i,
          rnd(-spread, spread),
          (vy + rnd(-0.4, 0.8)) * up,
          (vz + rnd(-1.2, 1.2)) * up, h);
      }
    }

    /* =================================================================
       PUBLIC API
       ================================================================= */
    W.scene = scene;
    W.camera = camera;
    W.camRoot = camRoot;
    W.heavyMan = manCtl;
    W.workers5 = workers;
    W.trolley = tro.group;
    W.hands = hands.group;
    W.bodies = bodies;
    W.particles = parts;

    W.setHandReach = function (v) {
      S.handReachTarget = clamp(v || 0, 0, 1);
    };

    W.setPushProgress = function (v) {
      S.pushProgTarget = clamp(v || 0, 0, 1);
    };

    /* The director hands us a raw 0..1 and is free to hand us a step. This
       only ever sets a TARGET; update() eases toward it. Nothing about the
       most important shot in the piece is allowed to happen in one frame. */
    W.manLookBack = function (v) {
      S.lookBackTarget = clamp(v || 0, 0, 1);
    };

    W.setTrolleyDistance = function (d) {
      if (S.trolleyMode !== 'manual') return;
      if (typeof d !== 'number' || !isFinite(d)) return;
      S.trolleyTarget = -Math.abs(d);
      if (S.trolleyZ < -300 && S.trolleyTarget > -300) S.trolleyZ = S.trolleyTarget;  /* first set: snap */
    };

    W.commitPush = function () {
      if (S.pushed) return;
      S.pushed = true;
      S.pushT = 0;
      S.handReachTarget = 1;
      S.pushProgTarget = 1;
      ENV.support = 1;
      S.manSupport = 0;

      /* he does not fly. He folds over the rail and DROPS. */
      manBody.goRagdoll();
      var h = RD_H;
      var i;
      for (i = 0; i < 15; i++) {
        /* forward, biased to the upper body, and DOWN through the core:
           he does not fly off the bridge, he folds over the rail and drops */
        var fw = 2.55, vy = -0.35;
        if (i === P_HEAD || i === P_NECK || i === P_CHL || i === P_CHR) { fw *= 1.30; vy = -0.20; }
        else if (i === P_CORE || i === P_PLL || i === P_PLR) { fw *= 1.00; vy = -0.95; }
        else if (i === P_KNL || i === P_KNR) { fw *= 0.82; vy = 0.30; }
        else if (i === P_FTL || i === P_FTR) { fw *= 0.72; vy = 1.55; }
        manBody.addVel(i, rnd(-0.14, 0.06), vy + rnd(-0.08, 0.08), fw + rnd(-0.14, 0.20), h);
      }
      /* the hands push through, then withdraw */
      setCamMode('follow', false);
      shake(0.28, 0.55);

      /* the trolley closes on the spot where he will land */
      var landZ = MAN_Z + 2.6;
      var need = landZ - S.trolleyZ;
      S.trolleyMode = 'run';
      S.trolleySpeed = clamp(need / 0.98, 20, 46);
    };

    W.impact = function (which) {
      if (which === 'man') {
        if (S.hitMan) return;
        S.hitMan = true;
        var x = manBody.x;
        debrisBurst(x[P_CORE * 3], x[P_CORE * 3 + 1], x[P_CORE * 3 + 2], 46, true);
        debrisBurst(0, RAILHEAD_Y, S.trolleyZ - 0.4, 34, false);
        /* if the timing slipped, put the trolley on him now */
        if (S.trolleyZ < x[P_CORE * 3 + 2] - 1.2) S.trolleyZ = x[P_CORE * 3 + 2] - 0.5;
        S.trolleyGate = Infinity;
        S.trolleyMode = 'grind';
        /* 34 m/s^2 stopped it in 0.47 s over 3.8 m: that is a cut, not a
           stop - and the stop is the entire reason he was pushed. 12 m/s^2
           grinds for 1.1-1.4 s over 7-12 m, long enough for a class to watch
           it lose the fight while it carries him on the nose in the existing
           spark shower. He lands at z = MAN_Z + 2.6 = 3.66, so the trolley
           comes to rest by z = 15.7 at worst, still 34 m short of the five
           at WORKERS_Z = 50. */
        S.grindDecel = 12;
        S.grindT = 0;
        /* it does not coast to a halt: it bites, screams and stops on him */
        S.trolleySpeed = clamp(S.trolleySpeed, 13, 17);
        shake(0.95, 1.3);
        setCamMode('follow', false);
      } else {
        if (S.hitFive) return;
        S.hitFive = true;
        /* HARD CUT to the wide shot; the trolley is repositioned inside the cut */
        hands.group.visible = false;
        setCamMode('wide', true);
        S.trolleyZ = WORKERS_Z - 9.5;
        S.trolleyMode = 'run';
        S.trolleySpeed = 27;
        shake(0.35, 1.6);
      }
    };

    W.aftermath = function () {
      S.aftermathT = 0;
      S.trolleyGate = Infinity;
      if (S.trolleyMode !== 'stopped') { S.trolleyMode = 'grind'; S.grindDecel = 10; }
      if (S.camMode !== 'wide') setCamMode('after', false);
      S.handReachTarget = 0;
      S.pushProgTarget = 0;
    };

    W.cameraShakeHook = function (amount, dur) { shake(clamp(amount || 0, 0, 1.5), dur || 1); };

    W.setQuality = function (q) {
      q = clamp(Math.round(q === undefined ? 3 : q), 0, 3);
      S.quality = q;
      /* The sleeper count is NOT scaled: they are one draw call of 12-triangle
         boxes and dropping them would open a hole in the track exactly where
         the five workers stand. Only the taller, more expensive masts thin. */
      var ma = [16, 22, 28, 30][q];
      try { track.sleepers.count = track.sleepMax; } catch (e) {}
      try { track.masts.count = Math.min(ma, track.mastMax); } catch (e) {}
      parts.budget = [60, 110, 180, 260][q];
      if (parts.n > parts.budget) parts.n = parts.budget;
      mist.visible = q >= 2;
      scarf.visible = true;
      wire.visible = q >= 1;
      bag.visible = q >= 1;
      blobs.visible = true;
      parts.mat.size = q >= 2 ? 0.30 : 0.26;
      if (tro.cones && tro.cones.length) {
        tro.cones[0].visible = true;
        tro.cones[1].visible = q >= 1;
      }
      if (tro.light) tro.light.intensity = q >= 2 ? HEADLAMP_I : 0;
      /* r134 legacy units. The key-to-ambient RATIO must stay ~6:1 at every
         quality level: below that his silhouette collapses into a flat grey
         doll, above it every surface facing the lens falls off the bottom of
         a projector. Must match the HemisphereLight built above. */
      hemi.intensity = 0.40;
      key.intensity = q === 0 ? 2.15 : 2.40;
      /* the practical is gated on the head turn, not on quality: update()
         owns it. Re-assert the CURRENT value so a quality change mid-scene
         cannot flash it to full. Must match update(). */
      fill.intensity = 1.00 * smooth(S.lookBack);
    };

    /* --------------------------------------------------------- UPDATE */
    W.update = function (dt, state) {
      if (!S.alive) return;
      if (typeof dt !== 'number' || !isFinite(dt)) dt = 0.016;
      /* 0.0666, not 0.1: the ragdoll accumulator below runs at most 4
         substeps of 1/60 s per frame (0.0667 s) and THROWS AWAY the
         remainder, so any frame longer than 67 ms silently dilated the
         physics while the rest of the world ran at full dt. Clamping the
         frame here instead means a tab switch or a stalled projector slows
         the whole world down honestly and can never desynchronise it. */
      dt = clamp(dt, 0.0005, 0.0666);
      S.t += dt;

      if (state) {
        if (typeof state.tension === 'number') S.tension = clamp(state.tension, 0, 1);
        if (state.phase && state.phase !== S.phase) {
          S.lastPhase = S.phase;
          S.phase = state.phase;
          onPhase(S.phase);
        }
      }

      /* once he is gone, the hands come back — slowly, and empty */
      if (S.pushed) {
        S.pushT += dt;
        if (S.pushT > 0.28) { S.handReachTarget = 0; S.pushProgTarget = 0; }
      }

      /* eased interaction values */
      var kk = 1 - Math.pow(0.0006, dt);
      S.handReach = lerp(S.handReach, S.handReachTarget, kk);
      S.pushProg = lerp(S.pushProg, S.pushProgTarget, kk);

      /* THE HEAD TURN. Rate limited to 0.75 /s, so a full turn can never take
         less than ~1.4 s no matter what the director does, then an
         exponential settle (tau ~ 0.29 s, fast enough to stay in step with a
         director ramp), then the double smoothstep inside lookBack(). Three
         stages of easing on one rotation, because it is the shot. */
      var lbD = (S.lookBackTarget - S.lookBack) * (1 - Math.pow(0.03, dt));
      var lbMax = 0.75 * dt;
      if (lbD > lbMax) lbD = lbMax; else if (lbD < -lbMax) lbD = -lbMax;
      S.lookBack += lbD;
      manCtl.lookBack(S.lookBack);
      /* and his breathing changes with it - see Body.localSkeleton */
      manBody.alert = S.lookBack;
      /* (This entire block was here TWICE, pasted end to end, so every frame
         stepped the head turn twice: the documented 0.75 rad/s limit was
         really 1.5, and the exponential settle converged in half its stated
         tau. The duplicate is gone. The turn now takes the ~1.4 s the beat
         is cut to - which is the difference between a man turning round and
         a man snapping round.) */
      /* and the bridge practical comes up with it: black while his back is
         to us, his face out of the dark as he comes round. One uniform
         write per frame - no material, no shader, no allocation. 0.70 -> 1.00
         because the eye moved 0.65 m further from his face and the light
         moved with it: the falloff (1 - d/7)^2 goes 0.273 -> 0.184, so the
         exact restoring value is 0.70 * 0.273/0.184 = 1.04 and 1.00 is
         within 4% of it, which is nothing on a face. Must match
         setQuality(), which re-asserts the same expression. */
      fill.intensity = 1.00 * smooth(S.lookBack);

      /* the man strains under the push, until he is pushed */
      if (!S.pushed) {
        manBody.lean = 0.055 + 0.175 * S.pushProg;
        manBody.brace = S.pushProg;
        manBody.writePose(S.t);
        manBody.p.set(manBody.x);
      }
      var i;
      for (i = 0; i < 5; i++) {
        if (bodies[i].mode === 'pose') {
          bodies[i].writePose(S.t);
          bodies[i].p.set(bodies[i].x);
        }
      }

      /* hold the trolley at his landing spot until he is actually down */
      if (S.pushed && !S.hitMan && manBody.x[P_CORE * 3 + 1] > BALLAST_Y + 0.95) {
        S.trolleyGate = manBody.x[P_CORE * 3 + 2] - 0.85;
      } else {
        S.trolleyGate = Infinity;
      }

      updateTrolley(dt);

      /* the trolley reaching the five */
      if (S.hitFive) {
        for (i = 0; i < 5; i++) {
          var wb = bodies[i];
          if (wb.mode === 'pose' && S.trolleyZ > wb.x[P_CORE * 3 + 2] - 0.8) {
            /* 8.5-11.5 was a shove. The nose arrives at 27 m/s; with the
               1.35 upper-body bias in launchBody, 13-17 puts the shoulders
               at 18-23 m/s and the whole figure near two thirds of vehicle
               speed, which is what the same strike now does in Scene A. */
            launchBody(wb, rnd(13.0, 17.0), rnd(3.4, 5.0), 1.4);
            debrisBurst(wb.x[P_CORE * 3], wb.x[P_CORE * 3 + 1], wb.x[P_CORE * 3 + 2], 22, true);
            shake(0.5, 1.0);
          }
        }
        if (S.trolleyZ > WORKERS_Z + 22 && S.trolleyMode === 'run') {
          S.trolleySpeed = Math.max(11, S.trolleySpeed - 8 * dt);
        }
      }

      /* the trolley reaching HIM: it must visibly slow and stop */
      if (S.pushed && !S.hitMan && S.trolleyMode === 'run') {
        var mz = manBody.x[P_CORE * 3 + 2];
        var my = manBody.x[P_CORE * 3 + 1];
        if (manBody.trolleyHit || (S.trolleyZ > mz - 1.7 && my < BALLAST_Y + 1.35)) {
          W.impact('man');
        }
      }
      /* fixed-timestep physics with an accumulator */
      if (S.pushed || S.hitFive || S.hitMan) {
        if (ENV.support > 0) {
          S.manSupport += dt;
          if (S.manSupport > 1.60 || manBody.x[P_CORE * 3 + 2] > ENV.railZ + 0.25) ENV.support = 0;
        }
        S.acc += dt;
        var n = 0;
        while (S.acc >= RD_H && n < 4) {
          for (i = 0; i < bodies.length; i++) bodies[i].step(RD_H, ENV);
          S.acc -= RD_H; n++;
        }
        if (n === 4) S.acc = 0;
        /* HE LANDS. A hundred and thirty kilos falls 6.6 m at 1.35 g and
           arrives at 16.3 m/s, and until now that happened in complete
           silence with a motionless camera. The drop has to ARRIVE or the
           weight the whole scene is built on is never felt.
           Gated on his core actually being down on the ballast, not merely
           on grounded, because grounded also goes true for deck contact
           while he is still folding over the rail. */
        if (S.pushed && !S.landed && manBody.grounded &&
            manBody.x[P_CORE * 3 + 1] < BALLAST_Y + 1.30) {
          S.landed = true;
          shake(0.55, 0.75);
          debrisBurst(manBody.x[P_CORE * 3], BALLAST_Y + 0.10,
                      manBody.x[P_CORE * 3 + 2], 20, false);
        }
      }

      /* watchdog */
      for (i = 0; i < bodies.length; i++) {
        var b = bodies[i];
        if (b.mode !== 'ragdoll' || b.dead) continue;
        b.snapAge += dt;
        if (!b.validate(false)) continue;
        if (b.snapAge > 0.33) { b.snapAge = 0; if (b.validate(true)) b.snap.set(b.x); }
      }

      if (S.trolleyMode === 'grind' && S.quality >= 1) {
        /* dust and grit under the wheels while it stops */
        if (Math.random() < 0.5) {
          parts.spawn(rnd(-1.2, 1.2), 0.14, S.trolleyZ - rnd(0.5, 6.0),
            rnd(-1.6, 1.6), rnd(0.3, 1.8), rnd(-1.5, 1.5),
            0.42, 0.46, 0.52, rnd(0.8, 1.8), -2.2);
        }
      }

      /* breath vapour in the cold */
      S.breathT -= dt;
      /* vapour on a cold night, and the second half of "he is alive": at
         3.0-4.6 s it fired maybe three times in the whole beat. */
      if (S.breathT <= 0) { S.breathT = rnd(2.1, 3.3); breathPuff(); }

      /* aftermath: the beams sink, nothing else moves */
      if (S.aftermathT >= 0) {
        S.aftermathT += dt;
        S.coneFade = lerp(S.coneFade, 0.45, 1 - Math.pow(0.35, dt));
      }

      /* writers */
      updateCoat();
      updateScarf(dt);
      updateBagAndWire(dt);
      writeBodies();
      writeBlobs();
      parts.update(dt);
      updateCamera(dt);
      /* hands are solved in CAMERA space, so the camera must be current */
      try { camRoot.updateMatrixWorld(true); } catch (e) {}
      updateHands(dt);

      /* the mesh guard panel is rigid, but the wind ripples the mist band */
      if (mist.visible) {
        mist.position.x = Math.sin(S.t * 0.21 + S.windPhase) * 2.4;
        mistMat.opacity = 0.16 + 0.06 * Math.sin(S.t * 0.33);
      }
    };

    function onPhase(p) {
      if (p === 'b_approach') {
        setCamMode('bridge', true);
        hands.group.visible = true;
      } else if (p === 'b_choice') {
        setCamMode('bridge', false);
      } else if (p === 'b_impact') {
        if (!S.pushed) {
          /* he was not pushed: the trolley roars UNDER the bridge */
          var dist = Math.abs(S.trolleyZ);
          S.trolleyMode = 'run';
          S.trolleySpeed = clamp(dist / 0.62, 26, 58);
        }
      } else if (p === 'b_verdict') {
        W.aftermath();
      }
    }

    /* --------------------------------------------------------- DISPOSE */
    W.dispose = function () {
      S.alive = false;
      try { camera.remove(hands.group); } catch (e) {}
      /* every geometry, material and texture this world created was pushed
         into `store` at build time; that list is the whole teardown. */
      var i;
      for (i = 0; i < store.length; i++) {
        try { if (store[i] && store[i].dispose) store[i].dispose(); } catch (e) {}
      }
      store.length = 0;
      try {
        while (scene.children.length) scene.remove(scene.children[0]);
      } catch (e) {}
      bodies.length = 0;
      workers.length = 0;
    };

    /* prime everything so the very first visible frame is correct */
    W.setQuality(3);
    manBody.lean = 0.055;
    manBody.writePose(0);
    manBody.p.set(manBody.x);
    for (var q = 0; q < 5; q++) { bodies[q].writePose(0); bodies[q].p.set(bodies[q].x); }
    updateCoat(); updateScarf(1 / 60); updateBagAndWire(1 / 60);
    writeBodies(); writeBlobs(); updateHands(1 / 60); updateCamera(1 / 60);

    /* compile now, behind whatever is covering the screen, so the first
       dramatic frame is never a 300 ms shader-compile freeze */
    try { if (renderer && renderer.compile) renderer.compile(scene, camera); } catch (e) {}

    return W;
  }

  return {
    build: function (renderer) {
      try { return build(renderer); }
      catch (e) {
        if (window.console && console.warn) console.warn('[WorldB]', e);
        return null;
      }
    }
  };
})();