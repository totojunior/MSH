/* =========================================================================
   MODULE: worldA  --  SCENE A : THE DRIVER'S CAB
   Global declared: WorldA
   three.js r160 UMD (global THREE). No modules, no add-ons, no external assets.
   ========================================================================= */

var WorldA = (function () {

  var HAS3D = (typeof THREE !== 'undefined' && !!THREE && !!THREE.BufferGeometry &&
               !!THREE.InstancedMesh && !!THREE.MeshLambertMaterial && !!THREE.FogExp2);

  /* ------------------------------------------------------------ constants */
  var FOG_HEX      = 0x0b1016;
  var EYE_Y        = 2.55;
  var GAUGE        = 0.7175;
  var RAIL_Y       = 0.235;
  var RAIL_TOP_Y   = 0.3095;
  var SLEEP_SP     = 0.62;
  var POLE_SP      = 18.0;
  var GRAV_BLOCK   = 6.0;       /* gravel pattern period (seamless scroll)  */
  var GRAV_PER     = 8;         /* gravel stones per block                  */
  var GRAV_BLOCKS  = 24;        /* -> 144 m of lineside ballast             */
  var SLEEP_VARY   = 8;         /* sleeper variation period, in sleepers    */
  var SIDE_SP      = 0.62;      /* side-track sleeper pitch = main track    */
  var SIDE_N       = 190;       /* -> 121 m of sleeper under 128 m of rail  */

  /* The transition must FINISH before the lone worker's plane, not at it, or
     the cab is still slewing when it reaches him: stepping the real filter at
     1/60 gives a 0.31 m / 9.2 deg miss with DIV_L 16 and 0.10 m / 3.1 deg with
     14, because the last two metres are straight and the lag bleeds off. He
     stands 16 m past the points, so 14 saturates diverge() with 2 m to spare.
     2.85 m of offset also keeps the branch clear of the pole line at x = +-4.5
     (branch right rail 3.57 m, pole base 4.23 m, 0.65 m clear) which 4.50 did
     not: at 4.50 the poles stood BETWEEN the side rails and the lone worker
     stood in one -- invisible at 430 m in fog, unmissable at 24 m. */
  var DIV_A        = 2.85;      /* final lateral offset of the side track   */
  var DIV_L        = 14.0;      /* length over which it diverges            */

  /* STAGING. One narrative distance 'narr' drives all three, so the geometry
     is fixed by their spacing and by HOLD_MIN, the distance the five settle
     at. Spacings: the points are 22 m in front of the five and 16 m in front
     of the lone worker; the lone worker is 6 m nearer the cab than the five.
     At the hold that reads: five 30 m, lone worker 24 m, points 8 m -- so the
     points are STILL AHEAD OF THE CAB for every frame of a_side and a_choice,
     however long the class takes. The old numbers put the points 85 m in
     front of a 13 m hold, i.e. 72 m BEHIND the cab by the time the choice was
     offered, so the 'turn' branch only looked right because diverge() was
     already saturated 81 m past them. Starting at 140 m instead of 430 m puts
     the five inside fog the eye can read (54% at t=0) from the first frame.
     Closing: ease = 1 until d = 75, i.e. 2.42 s, then exponential toward
     HOLD_MIN with tau = EASE_BAND/CRUISE = 1.68 s. Stepped at 1/60 that is
     140 / 113 / 86 / 62 / 47 / 37 / 32 / 30 m at t = 0,1,2,3,4,5.6,8,12 s. */
  var FIVE_Z0      = -140.0;    /* start z of the five workers              */
  var SWITCH_Z0    = -118.0;    /* start z of the points (22 m before them) */
  var ONE_Z0       = -134.0;    /* start z of the lone worker (6 m nearer)  */
  var HOLD_MIN     = 30.0;      /* the five asymptote to this many metres   */
  var EASE_BAND    = 45.0;      /* closing eases over the last 45 m         */
  var COMMIT_RAMP  = 0.45;      /* s to release the hold once points thrown */

  var CRUISE       = 26.82;     /* 60 mph in m/s                            */

  /* ragdoll tuning (recon-mandated) */
  var RD_H         = 1 / 60;
  var RD_G         = -15.0;
  var RD_DAMP      = 0.994;
  /* WHOLE-BODY ground drag, once per substep in step(). 0.90 was a body
     killer: 0.90^60 = 0.0018, i.e. a time constant of 0.158 s, so the moment
     a corpse touched the ballast it lost 99.8% of its speed inside one
     second no matter what the friction model said. It never showed up
     because collide() could not detect contact on a resting body at all and
     this.grounded was permanently false. Fixing contact detection without
     fixing this would have frozen every landing solid.
     0.988 per 1/60 s = 0.485 per second, a 1.18 s time constant: a rolling
     drag, not a brake. Coulomb friction below does the actual stopping. */
  var RD_GDAMP     = 0.988;
  var RD_ITER      = 10;
  /* COULOMB ground friction, in m/s of TANGENTIAL velocity removed per
     second of contact, per contacting particle. Velocity independent, so a
     slide decelerates LINEARLY and reaches exact zero instead of decaying
     asymptotically forever.
     Applied ONCE per substep (see collide) and NOT once per solver
     iteration: the old fractional 0.72 ran ten times inside one 1/60 s step
     and removed 1 - 0.28^10 = 99.9997% of the slide on first contact. That
     is why nothing in this scene has ever tumbled.
     Sizing: with 2-3 of the 14 particles in contact at any moment the
     body-level deceleration is about 32 * 0.2 = 6.4 m/s^2, on top of the
     0.72/s drag above. A body landing at 15 m/s then solves
     dv/dt = -0.72 v - 6.4  ->  stops in 1.37 s over 8.6 m. Eight metres of
     tumble is violent and still leaves the wreck inside the fog-free
     foreground (fog hides 1.6% at 20 m), which a 20 m slide would not. */
  var RD_FRICA     = 32.0;
  var RD_REST      = 0.20;
  var RD_RAD       = 0.085;
  /* 0.45 m per 1/60 s = 27 m/s, one tram speed: nothing struck by the tram
     may travel faster than the tram. The old 0.30 was an 18 m/s per-particle
     ceiling sitting BELOW the launch speed, so raising the impulse alone
     would have been silently clipped back to a shove. */
  var RD_MAXSTEP   = 0.45;
  var RD_MAXSUB    = 4;

  /* the cab is a static box in the camera frame: bodies may never enter it */
  var CAB_ZMIN = -2.30, CAB_ZMAX = 1.20, CAB_YMAX = 3.30, CAB_HW = 1.50;

  /* ---------------------------------------------------------- tiny maths  */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function sstep(t) { t = clamp01(t); return t * t * (3 - 2 * t); }
  function rr(a, b) { return a + Math.random() * (b - a); }

  function diverge(s) {
    if (s <= 0) return 0;
    if (s >= DIV_L) return DIV_A;
    var t = s / DIV_L;
    return DIV_A * (t * t * (3 - 2 * t));
  }
  function divSlope(s) {
    if (s <= 0 || s >= DIV_L) return 0;
    var t = s / DIV_L;
    return DIV_A * (6 * t - 6 * t * t) / DIV_L;
  }


  /* The lone worker stands ON the branch, so his lateral offset is the
     divergence at his own arc position along it -- not DIV_A, which is only
     right while he happens to sit past the end of the transition. Deriving it
     keeps him and the cab on the same rails if the staging is retuned again.
     Evaluated once at load, after the constants above are assigned. */
  var ONE_X = diverge(SWITCH_Z0 - ONE_Z0);

  /* ------------------------------------------------------- module scratch */
  var _p0 = null, _q0 = null, _s0 = null, _e0 = null, _m0 = null;
  var _va = null, _vb = null, _UP = null;
  var _scr = null;
  var _scratchReady = false;

  function initScratch() {
    if (_scratchReady) return;
    _p0 = new THREE.Vector3(); _q0 = new THREE.Quaternion();
    _s0 = new THREE.Vector3(1, 1, 1); _e0 = new THREE.Euler();
    _m0 = new THREE.Matrix4();
    _va = new THREE.Vector3(); _vb = new THREE.Vector3();
    _UP = new THREE.Vector3(0, 1, 0);
    _scr = new Float32Array(42);
    _scratchReady = true;
  }

  /* build-time matrix helper (boot only, allocation is fine here) */
  function MTX(px, py, pz, rx, ry, rz, sx, sy, sz) {
    _e0.set(num(rx, 0), num(ry, 0), num(rz, 0));
    _q0.setFromEuler(_e0);
    _p0.set(num(px, 0), num(py, 0), num(pz, 0));
    _s0.set(num(sx, 1), num(sy, 1), num(sz, 1));
    return new THREE.Matrix4().compose(_p0, _q0, _s0);
  }

  /* hand-rolled geometry merge (BufferGeometryUtils is NOT in the UMD build) */
  function mergeGeos(items) {
    var i, total = 0, list = [];
    for (i = 0; i < items.length; i++) {
      var src = items[i].g;
      var g = src.index ? src.toNonIndexed() : src.clone();
      if (items[i].m) g.applyMatrix4(items[i].m);
      list.push(g);
      total += g.attributes.position.count;
      if (src !== g) { try { src.dispose(); } catch (e) {} }
    }
    var pos = new Float32Array(total * 3);
    var nrm = new Float32Array(total * 3);
    var off = 0;
    for (i = 0; i < list.length; i++) {
      var pa = list[i].attributes.position;
      var na = list[i].attributes.normal;
      pos.set(pa.array.subarray ? pa.array.subarray(0, pa.count * 3) : pa.array, off * 3);
      if (na) nrm.set(na.array.subarray ? na.array.subarray(0, na.count * 3) : na.array, off * 3);
      off += pa.count;
      try { list[i].dispose(); } catch (e2) {}
    }
    var out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    out.computeBoundingSphere();
    return out;
  }

  /* ---------------------------------------------------- canvas / textures */
  function mkCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  function mkTex(cv, srgb, mip, repeat) {
    var t = new THREE.CanvasTexture(cv);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.generateMipmaps = !!mip;
    t.minFilter = mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    if (repeat) { t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.RepeatWrapping; }
    else { t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.ClampToEdgeWrapping; }
    t.needsUpdate = true;
    return t;
  }

  function drawGrime(cv) {
    var g = cv.getContext('2d'); if (!g) return;
    var S = cv.width, i;
    g.clearRect(0, 0, S, S);
    g.fillStyle = 'rgba(150,172,198,0.045)'; g.fillRect(0, 0, S, S);
    for (i = 0; i < 170; i++) {
      var x = Math.random() * S, y0 = Math.random() * S * 0.75;
      var len = 30 + Math.random() * 260, w = 0.6 + Math.random() * 2.6;
      var a = 0.02 + Math.random() * 0.075;
      var gr = g.createLinearGradient(x, y0, x, y0 + len);
      gr.addColorStop(0, 'rgba(196,214,238,0)');
      gr.addColorStop(0.28, 'rgba(196,214,238,' + a.toFixed(3) + ')');
      gr.addColorStop(1, 'rgba(196,214,238,0)');
      g.fillStyle = gr; g.fillRect(x, y0, w, len);
    }
    for (i = 0; i < 110; i++) {
      var bx = Math.random() * S, by = Math.random() * S;
      var edge = Math.min(bx, by, S - bx, S - by) / (S * 0.5);
      var r = 8 + Math.random() * 52;
      var al = (0.11 * (1 - edge) + 0.012) * Math.random();
      var rg = g.createRadialGradient(bx, by, 0, bx, by, r);
      rg.addColorStop(0, 'rgba(124,144,166,' + al.toFixed(3) + ')');
      rg.addColorStop(1, 'rgba(124,144,166,0)');
      g.fillStyle = rg; g.beginPath(); g.arc(bx, by, r, 0, 6.2832); g.fill();
    }
    g.strokeStyle = 'rgba(206,224,248,0.05)';
    for (i = 0; i < 8; i++) {
      g.lineWidth = 2 + Math.random() * 8;
      g.beginPath();
      g.arc(S * 0.48, S * 1.18, S * 0.55 + i * 12, Math.PI * 1.16, Math.PI * 1.84);
      g.stroke();
    }
    for (i = 0; i < 520; i++) {
      g.fillStyle = 'rgba(204,220,240,' + (Math.random() * 0.10).toFixed(3) + ')';
      g.fillRect(Math.random() * S, Math.random() * S, 1 + Math.random() * 2, 1 + Math.random() * 2);
    }
  }

  function drawCracks(cv, ox, oy) {
    var g = cv.getContext('2d'); if (!g) return;
    var S = cv.width;
    g.clearRect(0, 0, S, S);
    g.lineCap = 'round'; g.lineJoin = 'round';
    var cx = ox * S, cy = oy * S;

    function branch(x, y, a, len, w, depth) {
      var steps = 5, px = x, py = y, s;
      g.beginPath(); g.moveTo(x, y);
      for (s = 0; s < steps; s++) {
        a += (Math.random() - 0.5) * 0.42;
        px += Math.cos(a) * len / steps;
        py += Math.sin(a) * len / steps;
        g.lineTo(px, py);
      }
      g.lineWidth = w;
      g.strokeStyle = 'rgba(226,240,255,' + (0.88 - depth * 0.24).toFixed(3) + ')';
      g.stroke();
      if (depth < 2 && len > 26) {
        branch(px, py, a + (Math.random() < 0.5 ? 0.65 : -0.65), len * 0.52, w * 0.62, depth + 1);
        if (Math.random() < 0.65) {
          branch((x + px) * 0.5, (y + py) * 0.5,
                 a + (Math.random() < 0.5 ? 1.0 : -1.0), len * 0.40, w * 0.5, depth + 1);
        }
      }
    }

    var i, j, N = 18;
    for (i = 0; i < N; i++) {
      var ang = (i / N) * Math.PI * 2 + Math.random() * 0.32;
      branch(cx, cy, ang, 0.24 * S + Math.random() * 0.34 * S, 2.4 + Math.random() * 1.4, 0);
    }
    /* concentric fracture rings */
    for (i = 0; i < 5; i++) {
      var rad = (0.05 + i * 0.055) * S;
      g.beginPath();
      for (j = 0; j <= 20; j++) {
        var a2 = (j / 20) * Math.PI * 2;
        var rj = rad * (0.82 + Math.random() * 0.36);
        var xx = cx + Math.cos(a2) * rj, yy = cy + Math.sin(a2) * rj;
        if (j === 0) g.moveTo(xx, yy); else g.lineTo(xx, yy);
      }
      g.closePath();
      g.lineWidth = 1.1 + Math.random() * 1.6;
      g.strokeStyle = 'rgba(214,232,252,' + (0.30 + Math.random() * 0.28).toFixed(3) + ')';
      g.stroke();
    }
    /* pulverised centre */
    var rg = g.createRadialGradient(cx, cy, 0, cx, cy, S * 0.115);
    rg.addColorStop(0, 'rgba(238,247,255,0.92)');
    rg.addColorStop(0.35, 'rgba(210,228,248,0.45)');
    rg.addColorStop(1, 'rgba(200,220,244,0)');
    g.fillStyle = rg; g.beginPath(); g.arc(cx, cy, S * 0.115, 0, 6.2832); g.fill();
    for (i = 0; i < 260; i++) {
      var a3 = Math.random() * 6.2832, d3 = Math.pow(Math.random(), 1.7) * S * 0.22;
      g.fillStyle = 'rgba(230,242,255,' + (Math.random() * 0.55).toFixed(3) + ')';
      g.fillRect(cx + Math.cos(a3) * d3, cy + Math.sin(a3) * d3, 1 + Math.random() * 2.4, 1 + Math.random() * 2.4);
    }
  }

  function drawDial(cv) {
    var g = cv.getContext('2d'); if (!g) return;
    var S = cv.width, cx = S * 0.5, cy = S * 0.5, i;
    g.clearRect(0, 0, S, S);
    g.fillStyle = '#0c1117';
    g.beginPath(); g.arc(cx, cy, S * 0.485, 0, 6.2832); g.fill();
    /* muted brass bezel */
    var rg = g.createRadialGradient(cx - S * 0.16, cy - S * 0.19, S * 0.02, cx, cy, S * 0.5);
    rg.addColorStop(0, '#9b8a5c');
    rg.addColorStop(0.72, '#6d6040');
    rg.addColorStop(1, '#3a3427');
    g.strokeStyle = rg; g.lineWidth = S * 0.055;
    g.beginPath(); g.arc(cx, cy, S * 0.462, 0, 6.2832); g.stroke();

    function ang(mph) { return (135 + (mph / 80) * 270) * Math.PI / 180; }

    /* danger arc */
    g.strokeStyle = 'rgba(196,70,44,0.55)'; g.lineWidth = S * 0.028;
    g.beginPath(); g.arc(cx, cy, S * 0.395, ang(55), ang(80)); g.stroke();

    g.strokeStyle = '#b9cbdd';
    for (i = 0; i <= 80; i += 5) {
      var a = ang(i), major = (i % 20 === 0);
      var r1 = S * (major ? 0.325 : 0.360), r2 = S * 0.418;
      g.lineWidth = major ? S * 0.018 : S * 0.008;
      g.globalAlpha = major ? 0.95 : 0.55;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      g.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      g.stroke();
    }
    g.globalAlpha = 1;
    g.fillStyle = '#cfdcea';
    g.font = 'bold ' + Math.round(S * 0.105) + 'px Arial, Helvetica, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (i = 0; i <= 80; i += 20) {
      var a4 = ang(i), rr4 = S * 0.262;
      g.fillText(String(i), cx + Math.cos(a4) * rr4, cy + Math.sin(a4) * rr4);
    }
    g.font = 'bold ' + Math.round(S * 0.062) + 'px Arial, Helvetica, sans-serif';
    g.fillStyle = '#8fa4b8';
    g.fillText('M P H', cx, cy + S * 0.20);
    g.font = Math.round(S * 0.042) + 'px Arial, Helvetica, sans-serif';
    g.fillStyle = '#5f7286';
    g.fillText('CITY TRACTION Co.', cx, cy - S * 0.20);
    /* hub */
    g.fillStyle = '#7a6c48';
    g.beginPath(); g.arc(cx, cy, S * 0.055, 0, 6.2832); g.fill();
  }

  function drawNoise(cv, base, spread, dots, dr, dg2, db) {
    var g = cv.getContext('2d'); if (!g) return;
    var S = cv.width, i, k;
    var img = g.createImageData(S, S), d = img.data;
    for (i = 0; i < S * S; i++) {
      var v = base + (Math.random() - 0.5) * spread;
      if (v < 0) v = 0; if (v > 255) v = 255;
      d[i * 4] = (v * 0.84) | 0;
      d[i * 4 + 1] = (v * 0.93) | 0;
      d[i * 4 + 2] = v | 0;
      d[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    for (i = 0; i < dots; i++) {
      var x = Math.random() * S, y = Math.random() * S, r = 1 + Math.random() * 3.4;
      var l = 0.5 + Math.random() * 0.8;
      g.fillStyle = 'rgba(' + ((dr * l) | 0) + ',' + ((dg2 * l) | 0) + ',' + ((db * l) | 0) + ',0.85)';
      for (k = 0; k < 4; k++) {
        var ox = (k & 1) ? (x < S * 0.5 ? S : -S) : 0;
        var oy = (k & 2) ? (y < S * 0.5 ? S : -S) : 0;
        g.beginPath(); g.arc(x + ox, y + oy, r, 0, 6.2832); g.fill();
      }
    }
  }

  function drawRadial(cv, r0, r1, r2, a0) {
    var g = cv.getContext('2d'); if (!g) return;
    var S = cv.width, c = S * 0.5;
    g.clearRect(0, 0, S, S);
    var rg = g.createRadialGradient(c, c, 0, c, c, c);
    rg.addColorStop(0, 'rgba(' + r0 + ',' + r1 + ',' + r2 + ',' + a0 + ')');
    rg.addColorStop(0.42, 'rgba(' + r0 + ',' + r1 + ',' + r2 + ',' + (a0 * 0.38).toFixed(3) + ')');
    rg.addColorStop(1, 'rgba(' + r0 + ',' + r1 + ',' + r2 + ',0)');
    g.fillStyle = rg; g.fillRect(0, 0, S, S);
  }

  function drawStreak(cv) {
    var g = cv.getContext('2d'); if (!g) return;
    var W = cv.width, H = cv.height, i;
    g.clearRect(0, 0, W, H);
    for (i = 0; i < 90; i++) {
      var y = Math.random() * H;
      var h = 0.7 + Math.random() * 2.2;
      var a = 0.05 + Math.random() * 0.28;
      var x0 = Math.random() * W * 0.5;
      var len = W * (0.3 + Math.random() * 0.7);
      var gr = g.createLinearGradient(x0, y, x0 + len, y);
      gr.addColorStop(0, 'rgba(150,178,208,0)');
      gr.addColorStop(0.5, 'rgba(170,196,226,' + a.toFixed(3) + ')');
      gr.addColorStop(1, 'rgba(150,178,208,0)');
      g.fillStyle = gr; g.fillRect(x0, y, len, h);
    }
  }

  /* =======================================================================
     HUMANOID : 14-particle Verlet body, driven / ragdolled
     ======================================================================= */

  var POSE = [
     0.000, 1.720, 0.020,   /* 0  head    */
     0.000, 1.530, 0.000,   /* 1  neck    */
    -0.200, 1.395, 0.000,   /* 2  chestL  */
     0.200, 1.395, 0.000,   /* 3  chestR  */
    -0.145, 0.960, 0.000,   /* 4  pelvisL */
     0.145, 0.960, 0.000,   /* 5  pelvisR */
    -0.300, 1.105, 0.045,   /* 6  elbowL  */
     0.300, 1.105, 0.045,   /* 7  elbowR  */
    -0.275, 0.855, 0.170,   /* 8  handL   */
     0.275, 0.855, 0.170,   /* 9  handR   */
    -0.150, 0.500, 0.020,   /* 10 kneeL   */
     0.150, 0.500, 0.020,   /* 11 kneeR   */
    -0.135, 0.075, 0.000,   /* 12 footL   */
     0.135, 0.075, 0.000    /* 13 footR   */
  ];

  var INVMASS = [1.10, 0.90, 0.80, 0.80, 0.70, 0.70, 1.60, 1.60, 2.40, 2.40, 1.60, 1.60, 2.40, 2.40];

  /* [a, b, thickness] */
  var LIMB_DARK = [
    [1, 0, 0.072], [2, 6, 0.062], [6, 8, 0.050], [3, 7, 0.062], [7, 9, 0.050],
    [4, 10, 0.082], [10, 12, 0.066], [5, 11, 0.082], [11, 13, 0.066]
  ];
  var LIMB_VEST = [
    [2, 3, 0.112], [1, 2, 0.092], [1, 3, 0.092],
    [2, 4, 0.104], [3, 5, 0.104], [4, 5, 0.100]
  ];

  var CONS = [];
  function poseDist(a, b) {
    var dx = POSE[a * 3] - POSE[b * 3];
    var dy = POSE[a * 3 + 1] - POSE[b * 3 + 1];
    var dz = POSE[a * 3 + 2] - POSE[b * 3 + 2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  function buildCons() {
    if (CONS.length) return;
    var bones = [[1, 0], [1, 2], [1, 3], [2, 3], [2, 4], [3, 5], [4, 5],
                 [2, 6], [6, 8], [3, 7], [7, 9],
                 [4, 10], [10, 12], [5, 11], [11, 13]];
    var braces = [[2, 5], [3, 4], [1, 4], [1, 5]];
    var soft = [[0, 2], [0, 3]];
    var i;
    for (i = 0; i < bones.length; i++) {
      CONS.push({ a: bones[i][0], b: bones[i][1], rest: poseDist(bones[i][0], bones[i][1]), stiff: 1.0, type: 0 });
    }
    for (i = 0; i < braces.length; i++) {
      CONS.push({ a: braces[i][0], b: braces[i][1], rest: poseDist(braces[i][0], braces[i][1]), stiff: 0.55, type: 0 });
    }
    for (i = 0; i < soft.length; i++) {
      CONS.push({ a: soft[i][0], b: soft[i][1], rest: poseDist(soft[i][0], soft[i][1]), stiff: 0.35, type: 0 });
    }
    /* joint limits (minimum distances) -- keeps limbs out of the torso */
    CONS.push({ a: 10, b: 11, rest: 0.17, stiff: 0.35, type: 1 });
    CONS.push({ a: 12, b: 13, rest: 0.16, stiff: 0.35, type: 1 });
    CONS.push({ a: 8, b: 4, rest: 0.22, stiff: 0.35, type: 1 });
    CONS.push({ a: 9, b: 5, rest: 0.22, stiff: 0.35, type: 1 });
    CONS.push({ a: 0, b: 4, rest: 0.55, stiff: 0.30, type: 1 });
    CONS.push({ a: 0, b: 5, rest: 0.55, stiff: 0.30, type: 1 });
    /* ELBOW AND KNEE LIMITS. type 2 (maximum distance) was implemented in
       the solver and no constraint in either world ever used it.
       Honest statement of what each of these does, because it is easy to
       claim more:
         type 2, rest = the two bone lengths summed, is a STRETCH limiter.
         A distance constraint cannot detect an inverted joint (|a-c| is
         symmetric about full extension), so it does not stop hyperextension.
         What it does do is stop the two bones being pulled into a straight
         line LONGER than they are, which at a 16 m/s launch is a real and
         visible failure: a limb that stretches reads as rope, not bone.
         Chained across the joint it is a second, cheaper constraint pulling
         the same way as the two stiff bones.
         type 1 at 0.32 of that span is the FOLD limiter and is the one that
         stops a limb closing through itself. Law of cosines: 0.32 of the
         span is an interior angle of 37 deg, i.e. 143 deg of flexion, which
         is a real elbow and a real knee.
       Both are measured from POSE and multiplied by this.scale in solve(),
       so they track height like every other constraint here. 25 -> 33. */
    var jl = [[2, 6, 8], [3, 7, 9], [4, 10, 12], [5, 11, 13]], sp;
    for (i = 0; i < jl.length; i++) {
      sp = poseDist(jl[i][0], jl[i][1]) + poseDist(jl[i][1], jl[i][2]);
      CONS.push({ a: jl[i][0], b: jl[i][2], rest: sp, stiff: 0.55, type: 2 });
      CONS.push({ a: jl[i][0], b: jl[i][2], rest: sp * 0.32, stiff: 0.45, type: 1 });
    }
  }

  function Human(idx, sc, heavy) {
    this.idx = idx;
    this.scale = num(sc, 1);
    this.x = new Float32Array(42);
    this.p = new Float32Array(42);
    this.w = new Float32Array(14);
    this.snap = new Float32Array(42);
    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.phase = Math.random() * 6.283;
    this.talk = 0;
    this.work = 0;
    this.turn = 0;
    this.turnTarget = 0;
    /* signed yaw, relative to his own facing, that puts his eyes on the camera.
       setLookAt() writes it every frame; 2.35 is the old fixed look-back so an
       un-driven figure still behaves. */
    this.lookDelta = 2.35;
    this.isRagdoll = false;
    this.alive = true;
    this.visible = true;
    this.hasTool = true;
    this.grounded = false;
    this.asleep = 0;
    this.stillFor = 0;
    this.dead = false;
    this.snapAge = 0;
    var i;
    for (i = 0; i < 14; i++) this.w[i] = INVMASS[i] * (heavy ? 0.55 : 1.0);
  }

  Human.prototype.setPos = function (x, y, z) { this.pos.set(x, y, z); };
  Human.prototype.setYaw = function (a) { this.yaw = a; };
  Human.prototype.setTurn = function (v) { this.turnTarget = clamp01(v); };
  /* aim the head-turn at a world point (the cab window). Every worker stands
     at a different yaw, so one hard-coded turn angle sends five people looking
     in five different directions; this lands all of them on the lens. */
  Human.prototype.setLookAt = function (cx, cz) {
    var d = Math.atan2(cx - this.pos.x, cz - this.pos.z) - this.yaw;
    while (d > 3.14159265) d -= 6.28318531;
    while (d < -3.14159265) d += 6.28318531;
    this.lookDelta = clamp(d, -2.90, 2.90);   /* a neck plus a waist, no more */
  };

  Human.prototype.getWorldPos = function (out) {
    if (!out) return null;
    if (this.isRagdoll) {
      out.set((this.x[12] + this.x[15]) * 0.5, (this.x[13] + this.x[16]) * 0.5, (this.x[14] + this.x[17]) * 0.5);
    } else out.copy(this.pos);
    return out;
  };
  Human.prototype.getHeadPos = function (out) {
    if (!out) return null;
    out.set(this.x[0], this.x[1], this.x[2]);
    return out;
  };

  /* kinematic pose -> world particle positions (p == x, zero velocity) */
  Human.prototype.updateAlive = function (t, dt) {
    this.turn += (this.turnTarget - this.turn) * Math.min(1, dt * 2.2);
    var P = POSE, x = this.x, p = this.p, i, i3;
    var sc = this.scale, ph = this.phase;
    /* the alert pose: as the turn completes the conversation stops mid-word,
       the weight-shift plants, and a slow calm breath cross-fades into a fast
       one. Cross-faded, never frequency-modulated: multiplying t by a changing
       rate would jump the phase by hundreds of radians. */
    var al = this.turn;
    var ges = 1 - al * 0.92;
    var bre = (Math.sin(t * 1.75 + ph) * (1 - al * 0.55) +
               Math.sin(t * 4.15 + ph * 1.7) * al * 1.9) * 0.011;
    var swX = Math.sin(t * 0.85 + ph * 1.3) * 0.022 * (1 - al * 0.6);
    var swZ = Math.sin(t * 0.62 + ph * 0.7) * 0.015 * (1 - al * 0.6);
    var gA = this.talk * ges * (0.5 + 0.5 * Math.sin(t * 2.35 + ph * 2.1));
    var gB = this.talk * ges * (0.5 + 0.5 * Math.sin(t * 1.63 + ph * 1.1 + 2.0));
    var wk = this.work * ges * (0.5 + 0.5 * Math.sin(t * 3.05 + ph));
    /* the neck takes the first 1.25 rad and the shoulders are dragged into
       whatever is left over: a head alone at 150 deg reads as a broken doll. */
    var ld = this.lookDelta;
    var uS = ld - clamp(ld, -1.25, 1.25);
    if (uS > 1.65) uS = 1.65; else if (uS < -1.65) uS = -1.65;
    var uA = this.turn * uS, cU = Math.cos(uA), sU = Math.sin(uA);
    var hA = this.turn * ld, cH = Math.cos(hA), sH = Math.sin(hA);
    var cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    var lx, ly, lz, rx, rz, hgt;

    for (i = 0; i < 14; i++) {
      i3 = i * 3;
      lx = P[i3]; ly = P[i3 + 1]; lz = P[i3 + 2];
      if (i === 0) { ly += bre * 0.6 + gA * 0.014; lz += gA * 0.022; }
      else if (i === 1) { ly += bre * 0.6; }
      else if (i === 2 || i === 3) { ly += bre; lz += bre * 0.45; }
      /* alert: both hands come up in front of the chest. The offsets are
         chosen to PRESERVE bone length - upper arm 0.309 -> 0.302, forearm
         0.281 -> 0.280 - so the limb cylinders do not visibly shrink and the
         ragdoll constraints (built from POSE) do not snap on launch. */
      else if (i === 6) { ly += gA * 0.16 + al * 0.035; lz += gA * 0.05 + al * 0.025; lx -= al * 0.045; }
      else if (i === 8) { ly += gA * 0.34 + al * 0.375; lz += gA * 0.17 + al * 0.080; lx += -gA * 0.05 + al * 0.125; }
      else if (i === 7) { ly += gB * 0.14 + wk * 0.22 + al * 0.035; lz += gB * 0.05 + al * 0.025; lx += al * 0.045; }
      else if (i === 9) { ly += gB * 0.30 + wk * 0.44 + al * 0.375; lz += gB * 0.14 - wk * 0.10 + al * 0.080; lx += gB * 0.05 - al * 0.125; }

      hgt = ly * 0.5714;                        /* / 1.75 */
      lx += swX * hgt; lz += swZ * hgt;

      if (i === 0) { rx = lx * cH + lz * sH; rz = -lx * sH + lz * cH; lx = rx; lz = rz; }
      else if (i === 1 || i === 2 || i === 3 || i === 6 || i === 7 || i === 8 || i === 9) {
        rx = lx * cU + lz * sU; rz = -lx * sU + lz * cU; lx = rx; lz = rz;
      }

      lx *= sc; ly *= sc; lz *= sc;
      rx = lx * cy + lz * sy;
      rz = -lx * sy + lz * cy;
      x[i3] = this.pos.x + rx;
      x[i3 + 1] = this.pos.y + ly;
      x[i3 + 2] = this.pos.z + rz;
      p[i3] = x[i3]; p[i3 + 1] = x[i3 + 1]; p[i3 + 2] = x[i3 + 2];
    }
  };

  /* convert to physics and hand it a launch impulse */
  Human.prototype.launch = function (dirZ, power, spread, up) {
    if (this.isRagdoll) return;
    this.isRagdoll = true;
    this.alive = false;
    this.asleep = 0;
    this.stillFor = 0;
    this.dead = false;
    this.hasTool = false;
    var x = this.x, p = this.p, i, i3;
    var bvx = rr(-spread, spread);
    var bvz = dirZ * power * rr(0.86, 1.20);
    var bvy = up * rr(0.82, 1.25);
    /* real rotation, not a wobble. The lever arm here is the particle offset
       from the body axis, ~0.3 m, so +-6 rad/s is +-1.8 m/s of tangential
       velocity across the body: the shoulders and hips are visibly thrown at
       different speeds, which is what makes a body TUMBLE rather than sail
       flat. Kept below 7 so the twist term cannot dominate the launch. */
    var twist = rr(-6.0, 6.0);
    var baseY = this.pos.y;
    for (i = 0; i < 14; i++) {
      i3 = i * 3;
      var hgt = clamp01((x[i3 + 1] - baseY) / 1.75);
      var f = 0.75 + hgt * 0.78;
      var dxc = x[i3] - this.pos.x;
      var vx = bvx * f + twist * (x[i3 + 2] - this.pos.z) * 0.6;
      var vy = bvy * f;
      var vz = bvz * f - twist * dxc * 0.6;
      p[i3] = x[i3] - vx * RD_H;
      p[i3 + 1] = x[i3 + 1] - vy * RD_H;
      p[i3 + 2] = x[i3 + 2] - vz * RD_H;
    }
    for (i = 0; i < 42; i++) this.snap[i] = x[i];
  };

  /* vel === true ONLY on the last solver iteration. The earlier passes just
     project positions out of the ground; the last one writes the velocity
     response. Running the response on every iteration multiplied friction
     and restitution by ten and killed every landing dead on contact.
     The velocity pass tests a 2 cm CONTACT BAND rather than strict
     penetration: by the last iteration the constraint solve has lifted a
     resting particle a hair clear of the floor, so a strict test finds no
     contact on a body lying flat - no friction, this.grounded permanently
     false, no whole-body drag, and the sleep test can never fire. That is
     the state every corpse in this scene has been in. */
  Human.prototype.collide = function (cabX, vel, h) {
    var x = this.x, p = this.p, i, i3, vx, vy, vz, g = false, pen;
    var band = RD_RAD + 0.02;
    var cut = RD_FRICA * h * h, tl, sf;
    for (i = 0; i < 14; i++) {
      i3 = i * 3;
      if (vel) {
        if (x[i3 + 1] < band) {
          vx = x[i3] - p[i3]; vy = x[i3 + 1] - p[i3 + 1]; vz = x[i3 + 2] - p[i3 + 2];
          pen = x[i3 + 1] < RD_RAD;
          if (pen) x[i3 + 1] = RD_RAD;
          /* a particle inside the band but travelling UP has taken off
             again and keeps everything it has */
          if (pen || vy < 0.0015) {
            g = true;
            /* Coulomb: subtract a fixed tangential amount, floor at zero */
            tl = Math.sqrt(vx * vx + vz * vz);
            if (tl > 1e-7) { sf = (tl > cut) ? (1 - cut / tl) : 0; vx *= sf; vz *= sf; }
            /* bounce only what is actually falling. The old line zeroed vy
               for anything not descending fast, which killed every bounce
               the instant the solver pushed a particle back up. */
            if (pen) { if (vy < -0.004) vy = -vy * RD_REST; else if (vy < 0) vy = 0; }
            p[i3] = x[i3] - vx; p[i3 + 1] = x[i3 + 1] - vy; p[i3 + 2] = x[i3 + 2] - vz;
          }
        }
      } else if (x[i3 + 1] < RD_RAD) {
        x[i3 + 1] = RD_RAD; g = true;
      }
      if (x[i3 + 2] > CAB_ZMIN && x[i3 + 2] < CAB_ZMAX && x[i3 + 1] < CAB_YMAX &&
          x[i3] > cabX - CAB_HW && x[i3] < cabX + CAB_HW) {
        vz = x[i3 + 2] - p[i3 + 2];
        x[i3 + 2] = CAB_ZMIN;
        /* anything already travelling AWAY from the cab keeps its speed.
           The old unconditional reflection met every particle of every body
           on the very frame it was launched - contact was staged at 1.9 m
           and this box starts at 2.30 m - and replaced the impulse with
           |vz| * 0.35, about 5 m/s. The collision volume was eating three
           quarters of the impact. */
        if (vz < -0.004) p[i3 + 2] = x[i3 + 2] - vz;
        else p[i3 + 2] = x[i3 + 2] + Math.abs(vz) * 0.35 + 0.015;
      }
    }
    this.grounded = g;
  };

  Human.prototype.solve = function (cabX, h) {
    var x = this.x, w = this.w, it, k, c, a, b, a3, b3;
    var dx, dy, dz, d, diff, wa, wb, ws, f, rest;
    var mul = this.scale, n = CONS.length;
    for (it = 0; it < RD_ITER; it++) {
      for (k = 0; k < n; k++) {
        c = CONS[k]; a = c.a; b = c.b; a3 = a * 3; b3 = b * 3;
        wa = w[a]; wb = w[b]; ws = wa + wb;
        if (ws === 0) continue;
        dx = x[b3] - x[a3]; dy = x[b3 + 1] - x[a3 + 1]; dz = x[b3 + 2] - x[a3 + 2];
        d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < 1e-6) { dx = 1e-6; d = 1e-6; }
        rest = c.rest * mul;
        if (c.type === 1 && d >= rest) continue;
        if (c.type === 2 && d <= rest) continue;
        diff = (d - rest) / d * c.stiff;
        f = diff * (wa / ws); x[a3] += dx * f; x[a3 + 1] += dy * f; x[a3 + 2] += dz * f;
        f = diff * (wb / ws); x[b3] -= dx * f; x[b3 + 1] -= dy * f; x[b3 + 2] -= dz * f;
      }
      /* position projection every pass, velocity response on the last only */
      this.collide(cabX, it === RD_ITER - 1, h);
    }
  };

  Human.prototype.step = function (h, scrollV, cabX) {
    if (this.dead) return;
    if (this.asleep) {
      /* A settled corpse is no longer integrated or solved - but the ground
         it is lying on is still running backwards under the tram, so it has
         to stay pinned to the world or it hangs in mid-air while the ballast
         slides out from under it. Two adds per particle, no solver, no
         allocation. It stops at the cab exclusion plane, because nothing is
         collided here and an asleep body would otherwise be scrolled
         straight through the windscreen and out behind the camera. */
      if (this.grounded && scrollV > 0.05 && this.x[14] < CAB_ZMIN) {
        var az = scrollV * h, ai;
        for (ai = 0; ai < 14; ai++) { this.x[ai * 3 + 2] += az; this.p[ai * 3 + 2] += az; }
      }
      return;
    }
    var x = this.x, p = this.p, w = this.w, i, i3, vx, vy, vz, L;
    var gh = RD_G * h * h;
    var damp = this.grounded ? RD_DAMP * RD_GDAMP : RD_DAMP;
    for (i = 0; i < 14; i++) {
      i3 = i * 3;
      if (w[i] === 0) { p[i3] = x[i3]; p[i3 + 1] = x[i3 + 1]; p[i3 + 2] = x[i3 + 2]; continue; }
      vx = (x[i3] - p[i3]) * damp;
      vy = (x[i3 + 1] - p[i3 + 1]) * RD_DAMP;
      vz = (x[i3 + 2] - p[i3 + 2]) * damp;
      L = vx * vx + vy * vy + vz * vz;
      if (L > RD_MAXSTEP * RD_MAXSTEP) {
        L = RD_MAXSTEP / Math.sqrt(L); vx *= L; vy *= L; vz *= L;
      }
      p[i3] = x[i3]; p[i3 + 1] = x[i3 + 1]; p[i3 + 2] = x[i3 + 2];
      x[i3] += vx; x[i3 + 1] += vy + gh; x[i3 + 2] += vz;
    }
    /* the ground is moving under a settled body: couple it to the world scroll
       (pure translation of x AND p, so it adds no velocity). Done BEFORE the
       solve so the cab-box collision can still push the body clear.          */
    if (this.grounded && scrollV > 0.05) {
      var dz = scrollV * h;
      for (i = 0; i < 14; i++) { x[i * 3 + 2] += dz; p[i * 3 + 2] += dz; }
    }

    this.solve(cabX, h);

    /* sleep + watchdog */
    var sum = 0;
    for (i = 0; i < 14; i++) {
      i3 = i * 3;
      vx = x[i3] - p[i3]; vy = x[i3 + 1] - p[i3 + 1]; vz = x[i3 + 2] - p[i3 + 2];
      sum += vx * vx + vy * vy + vz * vz;
    }
    /* a body at the apex of its arc is momentarily still. Only let something
       the ground is actually holding up fall asleep, or a corpse freezes in
       mid-air; the hard cap stops a body wedged on the cab spinning forever. */
    /* sum is the squared per-substep position delta over 14 particles, so a
       whole body moving at v contributes 14 * (v/60)^2 = 0.00389 v^2.
       1e-4 was therefore 0.16 m/s, and the solver's own contact jitter sits
       right on that number: the detector never fired and corpses were solved
       for the rest of the scene. 2.5e-4 is 0.25 m/s, and 40 consecutive
       substeps is 0.67 s of unbroken ground contact - far too long to catch
       a body merely passing through the apex of its arc. */
    if (sum < 2.5e-4) {
      this.stillFor++;
      if ((this.grounded && this.stillFor > 40) || this.stillFor > 260) this.asleep = 1;
    }
    else this.stillFor = 0;

    this.snapAge++;
    if (this.snapAge > 20) {
      this.snapAge = 0;
      if (this.validate()) { for (i = 0; i < 42; i++) this.snap[i] = x[i]; }
    } else if (!isFinite(x[13]) || Math.abs(x[13]) > 500) {
      this.recover();
    }
  };

  Human.prototype.validate = function () {
    var x = this.x, i;
    for (i = 0; i < 42; i++) {
      if (!isFinite(x[i]) || Math.abs(x[i]) > 600) { this.recover(); return false; }
    }
    return true;
  };
  Human.prototype.recover = function () {
    var i;
    for (i = 0; i < 42; i++) {
      this.x[i] = this.snap[i];
      this.p[i] = this.snap[i];
    }
    this.dead = true;
    this.asleep = 1;
  };

  /* =======================================================================
     PARTICLE POOL (debris / dust) -- one THREE.Points, zero per-frame alloc
     ======================================================================= */
  function Pool(n, size, tex, grav, drag, fogged) {
    this.n = n; this.cap = n; this.live = 0; this.head = 0;
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.base = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.max = new Float32Array(n);
    this.grav = grav; this.drag = drag;
    var i;
    for (i = 0; i < n; i++) this.pos[i * 3 + 1] = -9999;
    var g = new THREE.BufferGeometry();
    var pa = new THREE.BufferAttribute(this.pos, 3);
    var ca = new THREE.BufferAttribute(this.col, 3);
    if (pa.setUsage) pa.setUsage(THREE.DynamicDrawUsage);
    if (ca.setUsage) ca.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', pa);
    g.setAttribute('color', ca);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e5);
    var m = new THREE.PointsMaterial({
      size: size, sizeAttenuation: true, map: tex, vertexColors: true,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      fog: !!fogged
    });
    this.geo = g; this.mat = m;
    this.mesh = new THREE.Points(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }
  Pool.prototype.spawn = function (x, y, z, vx, vy, vz, life, r, gg, b) {
    if (this.live >= this.cap) return;
    var i = this.head, tries = 0;
    while (this.life[i] > 0 && tries < this.n) { i = (i + 1) % this.n; tries++; }
    if (this.life[i] > 0) return;
    this.head = (i + 1) % this.n;
    var i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.base[i3] = r; this.base[i3 + 1] = gg; this.base[i3 + 2] = b;
    this.col[i3] = r; this.col[i3 + 1] = gg; this.col[i3 + 2] = b;
    this.life[i] = life; this.max[i] = life;
    this.live++;
  };
  Pool.prototype.update = function (dt, scrollV) {
    var i, i3, any = false, l;
    var dr = Math.pow(this.drag, dt * 60);
    for (i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) continue;
      i3 = i * 3;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.pos[i3 + 1] = -9999;
        this.col[i3] = 0; this.col[i3 + 1] = 0; this.col[i3 + 2] = 0;
        this.live--; any = true; continue;
      }
      this.vel[i3 + 1] += this.grav * dt;
      this.vel[i3] *= dr; this.vel[i3 + 1] *= dr; this.vel[i3 + 2] *= dr;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      if (this.pos[i3 + 1] < 0.04) {
        this.pos[i3 + 1] = 0.04;
        this.vel[i3 + 1] *= -0.24;
        this.vel[i3] *= 0.55; this.vel[i3 + 2] *= 0.55;
        this.pos[i3 + 2] += scrollV * dt;
      }
      l = this.life[i] / this.max[i];
      l = l * l * (3 - 2 * l);
      this.col[i3] = this.base[i3] * l;
      this.col[i3 + 1] = this.base[i3 + 1] * l;
      this.col[i3 + 2] = this.base[i3 + 2] * l;
      any = true;
    }
    if (any) {
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.color.needsUpdate = true;
    }
  };
  Pool.prototype.clear = function () {
    var i;
    for (i = 0; i < this.n; i++) {
      this.life[i] = 0; this.pos[i * 3 + 1] = -9999;
      this.col[i * 3] = 0; this.col[i * 3 + 1] = 0; this.col[i * 3 + 2] = 0;
    }
    this.live = 0;
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  };

  /* =======================================================================
     BUILD
     ======================================================================= */
  function build(renderer, opts) {
    if (!HAS3D) return stubWorld();
    try {
      return buildReal(renderer, opts || {});
    } catch (err) {
      try { if (window.console && console.warn) console.warn('[worldA] build failed', err); } catch (e2) {}
      return stubWorld();
    }
  }

  function stubWorld() {
    var noop = function () {};
    var cam = null, scn = null;
    try {
      if (typeof THREE !== 'undefined' && THREE.PerspectiveCamera) {
        cam = new THREE.PerspectiveCamera(62, 16 / 9, 0.4, 700);
        scn = new THREE.Scene();
      }
    } catch (e) {}
    return {
      isStub: true, scene: scn, camera: cam, cabRig: null,
      workers5: [], worker1: null, humans: [], brakeLever: null,
      cameraShakeHook: { amount: 0 },
      pullBrake: function () { return 0; },
      throwSwitch: function () { return 0; },
      setSpeed: noop, getSpeed: function () { return 0; },
      update: noop,
      impact: function () { return 0; },
      aftermath: function () { return 0; },
      setQuality: noop, setCameraOwned: noop, setGlassCrack: noop,
      distanceToTarget: function () { return 0; },
      dispose: noop
    };
  }

  function buildReal(renderer, opts) {
    initScratch();
    buildCons();

    var res = { geo: [], mat: [], tex: [] };
    function G(g) { res.geo.push(g); return g; }
    function M(m) { res.mat.push(m); return m; }
    function TX(t) { res.tex.push(t); return t; }

    var quality = clamp(Math.round(num(opts.quality, 2)), 0, 3);
    var maxAniso = 1;
    try { maxAniso = Math.min(4, renderer.capabilities.getMaxAnisotropy()); } catch (e) { maxAniso = 1; }

    /* -------------------------------------------------- scene / camera */
    var scene = new THREE.Scene();
    scene.background = new THREE.Color().setHex(FOG_HEX, THREE.SRGBColorSpace);
    scene.fog = new THREE.FogExp2(FOG_HEX, 0.0067);

    var camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.40, 700);
    var cabRig = new THREE.Group();
    cabRig.position.set(0, EYE_Y, 0);
    scene.add(cabRig);
    cabRig.add(camera);

    /* -------------------------------------------------- lights (3 max) */
    /* r134 LEGACY LIGHT UNITS. renderer.physicallyCorrectLights is false, so
       intensity is a plain multiplier, not lumens/candela. The old values were
       physically-correct-style numbers (point light 55-62) which multiply every
       Lambert term far past 1.0: the whole scene clipped to pale blue-white and
       the near-black industrial world, the fog and the orange vests all
       disappeared into it. These are legacy multipliers, matched to WorldB
       (hemi 0.24 / key 2.40) so the two scenes read as one film. */
    var hemi = new THREE.HemisphereLight(0x5f7f9f, 0x080b10, 0.28);
    scene.add(hemi);

    /* far ahead and high: a cold rim/backlight, so the workers come out of the
       murk as orange-edged silhouettes rather than lit objects */
    var key = new THREE.DirectionalLight(0xbcd6f2, 2.30);
    key.position.set(7, 24, -170);
    key.target.position.set(0, 0.5, 0);
    scene.add(key); scene.add(key.target);

    var lamp = null;
    if (quality >= 2) {
      lamp = new THREE.PointLight(0xcfe2f5, 1.9, 46, 2);
      lamp.position.set(0, -0.35, -1.6);
      cabRig.add(lamp);
    }

    /* -------------------------------------------------- textures */
    var grimeCv = mkCanvas(512, 512); drawGrime(grimeCv);
    var grimeTex = TX(mkTex(grimeCv, true, false, false));

    var crackCv = mkCanvas(512, 512); drawCracks(crackCv, 0.46, 0.44);
    var crackTex = TX(mkTex(crackCv, true, false, false));

    var dialCv = mkCanvas(256, 256); drawDial(dialCv);
    var dialTex = TX(mkTex(dialCv, true, false, false));

    var ballCv = mkCanvas(256, 256); drawNoise(ballCv, 46, 34, 620, 122, 132, 146);
    var ballTex = TX(mkTex(ballCv, true, true, true));
    ballTex.repeat.set(6, 34); ballTex.anisotropy = maxAniso;

    var grdCv = mkCanvas(256, 256); drawNoise(grdCv, 30, 20, 220, 78, 88, 102);
    var grdTex = TX(mkTex(grdCv, true, true, true));
    grdTex.repeat.set(26, 90); grdTex.anisotropy = maxAniso;

    var dotCv = mkCanvas(64, 64); drawRadial(dotCv, 232, 240, 252, 1.0);
    var dotTex = TX(mkTex(dotCv, true, false, false));

    var softCv = mkCanvas(64, 64); drawRadial(softCv, 150, 172, 198, 0.55);
    var softTex = TX(mkTex(softCv, true, false, false));

    var blobCv = mkCanvas(64, 64); drawRadial(blobCv, 0, 0, 0, 0.75);
    var blobTex = TX(mkTex(blobCv, false, false, false));

    var sunCv = mkCanvas(128, 128); drawRadial(sunCv, 184, 208, 236, 0.95);
    var sunTex = TX(mkTex(sunCv, true, false, false));

    var strCv = mkCanvas(256, 128); drawStreak(strCv);
    var strTex = TX(mkTex(strCv, true, false, true));

    /* -------------------------------------------------- materials */
    function lam(hex, emHex, emI) {
      var m = new THREE.MeshLambertMaterial({
        color: new THREE.Color().setHex(hex, THREE.SRGBColorSpace),
        emissive: new THREE.Color().setHex(emHex || 0x000000, THREE.SRGBColorSpace)
      });
      if (emI !== undefined) m.emissiveIntensity = emI;
      return M(m);
    }
    function bas(hex, o) {
      var p = { color: new THREE.Color().setHex(hex, THREE.SRGBColorSpace) };
      if (o) { for (var k in o) if (o.hasOwnProperty(k)) p[k] = o[k]; }
      return M(new THREE.MeshBasicMaterial(p));
    }

    /* EMISSIVE REBALANCE. With the key at 2.7 and the practical at 55 every
       surface clipped, so these emissive floors -- 20% to 55% of their own
       albedo -- were invisible and could be authored arbitrarily high. At the
       new light levels emissive would be the DOMINANT term (matCab emissive
       0x111821 alone is 0.129 linear blue, ~5x what its lit term now
       contributes) and everything would read as a flat self-lit slab. Each is
       scaled through the existing emissiveIntensity argument to roughly 8-13%
       of its own albedo: enough to keep unlit faces off dead black, not enough
       to self-illuminate. matVest is the deliberate exception -- it keeps a
       0.70 floor because the orange is the one signal that must survive the
       fog. */
    var matStruct = lam(0x28303b, 0x080c11, 0.30);
    var matCab    = lam(0x232b35, 0x111821, 0.22);
    var matDarkC  = lam(0x171d25, 0x090d12, 0.28);
    var matRail   = lam(0x3b4653, 0x0d131a, 0.32);
    /* the rail head stays MeshBasicMaterial on purpose: it is a fake specular
       gleam, and a 12 mm Lambert strip under a 7.9 deg light would be black,
       taking the whole receding track with it. Dimmed 0x8ea6bd -> 0x455e6e
       (~49%) so the two cold lines still run into the murk but sit ~3x under
       the vests instead of rivalling them. */
    var matRailTop = bas(0x455e6e);
    var matWood   = lam(0x4a3628, 0x120c07, 0.25);
    /* brass darkened 0x8a7a52 -> 0x5a4f38: at 0.54 linear red the brake lever
       was the second-warmest thing in frame, and it is the closest object to
       camera. Orange has to be the only warm signal, so the lever drops to
       ~0.07 linear -- a dim tarnished metal, ~12x under the vests. */
    var matBrass  = lam(0x5a4f38, 0x1c1710, 0.28);
    var matVest   = lam(0xff6a10, 0x4c1c00, 0.70);
    var matLimb   = lam(0x232a32, 0x080b0e, 0.28);
    var matGlove  = lam(0x2b3139, 0x0d1116, 0.28);

    var matGround = M(new THREE.MeshLambertMaterial({
      color: new THREE.Color().setHex(0x22303c, THREE.SRGBColorSpace), map: grdTex
    }));
    var matBallast = M(new THREE.MeshLambertMaterial({
      color: new THREE.Color().setHex(0x39434f, THREE.SRGBColorSpace), map: ballTex
    }));

    /* THE SIX PURE-WHITE BASICS. MeshBasicMaterial never receives light, so at
       0xffffff each of these was a hole of full-luminance white punched through
       a near-black frame -- which is why the windscreen area read as flat white
       plastic. All six stay unlit, because none of them can meaningfully be
       Lambert: two are transparent overlays sitting on the glass, one is a
       self-luminous instrument and two are additive glows. Each is instead
       re-tinted into the cold palette so it can never exceed the light budget.
       0xe6eef7 is included -- at 0.90 linear it was white in all but name. */
    var matGlass = bas(0x9fb6cc, {
      map: grimeTex, transparent: true, opacity: 0.55,
      depthWrite: false, fog: false
    });
    var matCrack = bas(0x9fbcd6, {
      map: crackTex, transparent: true, opacity: 0.0, side: THREE.DoubleSide,
      depthWrite: false, fog: false, blending: THREE.AdditiveBlending
    });
    /* backlit gauge: legitimately unlit, but tinted so the texture brightest
       markings (0xcfdcea, 0.81 linear) land at ~0.51 -- a dim cold instrument
       instead of a white disc on the dash. */
    var matDial = bas(0x9fb4c8, { map: dialTex, transparent: true, fog: false });
    /* needle kept brighter than the tinted face so it still reads, but
       blue-grey rather than near-white. */
    var matNeedle = bas(0xaebfd0, { fog: false });
    var matBlob = bas(0x000000, {
      map: blobTex, transparent: true, opacity: 0.5, depthWrite: false, fog: true
    });
    /* additive glows: white x additive is the worst offender of the six,
       because it ADDS full luminance on top of whatever is behind it. Tinted to
       the cold end so the sky haze and the speed streaks stay blue-grey. */
    var matSun = bas(0x8fb0cf, {
      map: sunTex, transparent: true, opacity: 0.42, depthWrite: false,
      blending: THREE.AdditiveBlending, fog: false
    });
    var matStreak = bas(0x8ba4bd, {
      map: strTex, transparent: true, opacity: 0.0, depthWrite: false,
      blending: THREE.AdditiveBlending, fog: false
    });
    var matLampRed = bas(0x2a0a06, { fog: false });
    var matLampA = bas(0x1b2b33, { fog: false });
    var matLampB = bas(0x1b2b33, { fog: false });

    /* =============================================== GROUND + BALLAST */
    var groundGeo = G(new THREE.PlaneGeometry(400, 1200, 1, 1));
    groundGeo.rotateX(-Math.PI / 2);
    var ground = new THREE.Mesh(groundGeo, matGround);
    ground.position.set(0, -0.06, -520);
    scene.add(ground);

    var ballGeo = G(new THREE.PlaneGeometry(7.2, 1200, 1, 1));
    ballGeo.rotateX(-Math.PI / 2);
    var ballast = new THREE.Mesh(ballGeo, matBallast);
    ballast.position.set(0, 0.0, -520);
    /* the track bed receives; the 400 x 1200 m ground plane deliberately does
       NOT. The workers stand on the ballast, so every shadow that matters lands
       here, and skipping the ground keeps the PCF-soft taps off what is
       effectively a full-screen quad -- the single biggest shadow cost. */
    ballast.receiveShadow = true;
    scene.add(ballast);

    /* =============================================== MAIN RAILS */
    var railGeo = G(mergeGeos([
      { g: new THREE.BoxGeometry(0.078, 0.15, 1200), m: MTX(-GAUGE, RAIL_Y, -520) },
      { g: new THREE.BoxGeometry(0.078, 0.15, 1200), m: MTX(GAUGE, RAIL_Y, -520) }
    ]));
    var rails = new THREE.Mesh(railGeo, matRail);
    rails.receiveShadow = true;
    scene.add(rails);

    var railTopGeo = G(mergeGeos([
      { g: new THREE.BoxGeometry(0.056, 0.012, 1200), m: MTX(-GAUGE, RAIL_TOP_Y, -520) },
      { g: new THREE.BoxGeometry(0.056, 0.012, 1200), m: MTX(GAUGE, RAIL_TOP_Y, -520) }
    ]));
    var railTops = new THREE.Mesh(railTopGeo, matRailTop);
    scene.add(railTops);

    /* =============================================== SLEEPERS (instanced) */
    var SLEEP_MAX = 176;
    var sleepGeo = G(new THREE.BoxGeometry(2.55, 0.16, 0.24));
    var sleepInst = new THREE.InstancedMesh(sleepGeo, matDarkC, SLEEP_MAX);
    sleepInst.receiveShadow = true;
    sleepInst.frustumCulled = false;
    (function () {
      var i, vy = [], vs = [];
      for (i = 0; i < SLEEP_VARY; i++) { vy.push((Math.random() - 0.5) * 0.035); vs.push(0.96 + Math.random() * 0.09); }
      for (i = 0; i < SLEEP_MAX; i++) {
        var v = i % SLEEP_VARY;
        _m0.copy(MTX(0, 0.08, -(i - 4) * SLEEP_SP, 0, vy[v], 0, vs[v], 1, 1));
        sleepInst.setMatrixAt(i, _m0);
      }
      sleepInst.instanceMatrix.needsUpdate = true;
    })();
    var sleepGroup = new THREE.Group();
    sleepGroup.add(sleepInst);
    scene.add(sleepGroup);

    /* =============================================== GRAVEL (instanced) */
    var GRAV_MAX = GRAV_PER * GRAV_BLOCKS;
    var gravGeo = G(new THREE.TetrahedronGeometry(0.13, 0));
    var gravInst = new THREE.InstancedMesh(gravGeo, matStruct, GRAV_MAX);
    gravInst.frustumCulled = false;
    (function () {
      /* one randomised block, repeated -> scrolling by GRAV_BLOCK is seamless */
      var cfg = [], j, bl, sl = 0;
      for (j = 0; j < GRAV_PER; j++) {
        var side = (j % 2) ? 1 : -1;
        cfg.push({
          x: side * (0.95 + Math.random() * 2.7),
          y: 0.05 + Math.random() * 0.06,
          z: -Math.random() * GRAV_BLOCK,
          rx: Math.random() * 3, ry: Math.random() * 3, rz: Math.random() * 3,
          s: 0.55 + Math.random() * 1.0
        });
      }
      for (bl = 0; bl < GRAV_BLOCKS; bl++) {
        for (j = 0; j < GRAV_PER; j++) {
          var c = cfg[j];
          _m0.copy(MTX(c.x, c.y, c.z - bl * GRAV_BLOCK, c.rx, c.ry, c.rz, c.s, c.s, c.s));
          gravInst.setMatrixAt(sl++, _m0);
        }
      }
      gravInst.instanceMatrix.needsUpdate = true;
    })();
    var gravGroup = new THREE.Group();
    gravGroup.add(gravInst);
    scene.add(gravGroup);

    /* =============================================== POLES (instanced) */
    var POLE_MAX = 18;
    var poleGeo = G(mergeGeos([
      { g: new THREE.CylinderGeometry(0.085, 0.15, 7.3, 6, 1, false), m: MTX(0, 3.65, 0) },
      { g: new THREE.BoxGeometry(2.7, 0.14, 0.14), m: MTX(1.30, 6.85, 0) },
      { g: new THREE.BoxGeometry(0.09, 1.75, 0.09), m: MTX(0.56, 6.06, 0, 0, 0, -0.62) },
      { g: new THREE.CylinderGeometry(0.07, 0.07, 0.18, 6), m: MTX(2.35, 6.66, 0) },
      { g: new THREE.CylinderGeometry(0.06, 0.06, 0.16, 6), m: MTX(1.55, 6.66, 0) },
      { g: new THREE.BoxGeometry(0.55, 0.45, 0.55), m: MTX(0, 0.22, 0) }
    ]));
    var poleInst = new THREE.InstancedMesh(poleGeo, matStruct, POLE_MAX);
    poleInst.frustumCulled = false;
    (function () {
      var i;
      for (i = 0; i < POLE_MAX; i++) {
        var right = (i % 2) === 1;
        _m0.copy(MTX(right ? 4.5 : -4.5, 0, -i * POLE_SP, 0, right ? Math.PI : 0, 0));
        poleInst.setMatrixAt(i, _m0);
      }
      poleInst.instanceMatrix.needsUpdate = true;
    })();
    var poleGroup = new THREE.Group();
    poleGroup.add(poleInst);
    scene.add(poleGroup);

    /* =============================================== WIRES + EMBANKMENT */
    var wireGeo = G(mergeGeos([
      { g: new THREE.BoxGeometry(0.05, 0.05, 900), m: MTX(0, 5.95, -400) },
      { g: new THREE.BoxGeometry(0.05, 0.05, 900), m: MTX(0, 6.75, -400) },
      { g: new THREE.BoxGeometry(0.04, 0.04, 900), m: MTX(-2.6, 6.55, -400) },
      { g: new THREE.BoxGeometry(0.04, 0.04, 900), m: MTX(2.6, 6.55, -400) }
    ]));
    var wires = new THREE.Mesh(wireGeo, matDarkC);
    scene.add(wires);

    var embGeo = G(mergeGeos([
      { g: new THREE.BoxGeometry(0.6, 7.0, 900), m: MTX(-9.4, 2.4, -400, 0, 0, 0.32) },
      { g: new THREE.BoxGeometry(0.6, 7.0, 900), m: MTX(9.4, 2.4, -400, 0, 0, -0.32) },
      { g: new THREE.BoxGeometry(0.5, 3.0, 900), m: MTX(-12.2, 1.4, -400) },
      { g: new THREE.BoxGeometry(0.5, 3.0, 900), m: MTX(12.2, 1.4, -400) }
    ]));
    var emb = new THREE.Mesh(embGeo, matStruct);
    scene.add(emb);

    /* =============================================== SUN / SKY GLOW */
    var sunGeo = G(new THREE.PlaneGeometry(150, 90, 1, 1));
    var sunMesh = new THREE.Mesh(sunGeo, matSun);
    sunMesh.position.set(3.0, 14.0, -240);
    sunMesh.renderOrder = -2;
    cabRig.add(sunMesh);

    /* =============================================== SIDE TRACK + POINTS */
    var switchGroup = new THREE.Group();
    switchGroup.position.set(0, 0, SWITCH_Z0);
    scene.add(switchGroup);

    function sideRailGeo(top) {
      /* NS was tuned for a 62 m transition seen from 150 m and more. A 14 m
         transition seen from 8 m needs finer chords or the rail head visibly
         zigzags: each chord is a straight box tangent at its midpoint, so it
         deviates by kappa*(seg/2)^2/2 at its ends, and shortening DIV_L
         raises kappa to 6*DIV_A/DIV_L^2 = 0.087 /m. At NS 32 (seg 4 m) that
         is 17 cm of lateral kink in a 5.6 cm rail head; at NS 88 (seg 1.45 m)
         it is 2.3 cm. Build-time cost only. */
      var items = [], NS = 88, LEN = 128, seg = LEN / NS, i, k;
      for (i = 0; i < NS; i++) {
        var sm = (i + 0.5) * seg;
        var xm = diverge(sm), sl = divSlope(sm);
        var L = Math.sqrt(1 + sl * sl) * seg * 1.03;
        var ry = -Math.atan(sl);
        for (k = -1; k <= 1; k += 2) {
          items.push({
            g: top ? new THREE.BoxGeometry(0.056, 0.012, L) : new THREE.BoxGeometry(0.078, 0.15, L),
            m: MTX(xm + k * GAUGE, top ? RAIL_TOP_Y : RAIL_Y, -sm, 0, ry, 0)
          });
        }
      }
      return mergeGeos(items);
    }
    var sideRails = new THREE.Mesh(G(sideRailGeo(false)), matRail);
    sideRails.receiveShadow = true;
    switchGroup.add(sideRails);
    var sideTops = new THREE.Mesh(G(sideRailGeo(true)), matRailTop);
    switchGroup.add(sideTops);

    var sideSleepGeo = G(new THREE.BoxGeometry(2.55, 0.16, 0.24));
    var sideSleepInst = new THREE.InstancedMesh(sideSleepGeo, matDarkC, SIDE_N);
    sideSleepInst.receiveShadow = true;
    sideSleepInst.frustumCulled = false;
    (function () {
      var i;
      for (i = 0; i < SIDE_N; i++) {
        var s = 4 + i * SIDE_SP;
        _m0.copy(MTX(diverge(s), 0.075, -s, 0, -Math.atan(divSlope(s)), 0));
        sideSleepInst.setMatrixAt(i, _m0);
      }
      sideSleepInst.instanceMatrix.needsUpdate = true;
    })();
    switchGroup.add(sideSleepInst);

    /* moving switch blades */
    var bladeGroup = new THREE.Group();
    bladeGroup.position.set(0, 0, -1.0);
    switchGroup.add(bladeGroup);
    var bladeGeo = G(mergeGeos([
      { g: new THREE.BoxGeometry(0.05, 0.115, 13), m: MTX(-GAUGE + 0.085, RAIL_Y, -6.5) },
      { g: new THREE.BoxGeometry(0.05, 0.115, 13), m: MTX(GAUGE - 0.085, RAIL_Y, -6.5) },
      { g: new THREE.BoxGeometry(1.7, 0.07, 0.09), m: MTX(0, 0.20, 0.25) },
      { g: new THREE.BoxGeometry(1.7, 0.07, 0.09), m: MTX(0, 0.20, -4.2) }
    ]));
    var blades = new THREE.Mesh(bladeGeo, matRail);
    bladeGroup.add(blades);

    /* point machine + indicator plate */
    var pmGeo = G(mergeGeos([
      { g: new THREE.BoxGeometry(0.55, 0.35, 0.9), m: MTX(1.45, 0.2, -0.5) },
      { g: new THREE.CylinderGeometry(0.055, 0.065, 2.0, 6), m: MTX(1.9, 1.0, -0.5) },
      { g: new THREE.BoxGeometry(1.2, 0.09, 0.09), m: MTX(1.05, 0.30, -0.5) }
    ]));
    var pointMachine = new THREE.Mesh(pmGeo, matStruct);
    switchGroup.add(pointMachine);

    var plateGroup = new THREE.Group();
    plateGroup.position.set(1.9, 1.95, -0.5);
    switchGroup.add(plateGroup);
    var plateGeo = G(new THREE.BoxGeometry(0.52, 0.52, 0.04));
    var plate = new THREE.Mesh(plateGeo, matRailTop);
    plateGroup.add(plate);

    /* dark signal mast (silhouette only) */
    var mastGeo = G(mergeGeos([
      { g: new THREE.CylinderGeometry(0.08, 0.11, 5.2, 6), m: MTX(-2.9, 2.6, -8) },
      { g: new THREE.BoxGeometry(0.42, 1.0, 0.30), m: MTX(-2.9, 5.3, -8) },
      { g: new THREE.BoxGeometry(0.9, 0.09, 0.09), m: MTX(-2.5, 4.4, -8) }
    ]));
    switchGroup.add(new THREE.Mesh(mastGeo, matStruct));

    /* =============================================== HUMANS */
    var NH = 6;
    var humans = [];
    var i;
    for (i = 0; i < NH; i++) humans.push(new Human(i, 0.95 + Math.random() * 0.12, false));
    var workers5 = [humans[0], humans[1], humans[2], humans[3], humans[4]];
    var worker1 = humans[5];

    var FIVE_OFF = [
      [-0.92, 0.55], [0.38, 1.15], [1.02, -0.25], [-0.28, -0.95], [0.12, 0.10]
    ];
    var FIVE_YAW = [3.55, 2.55, 3.90, 2.95, 3.30];
    for (i = 0; i < 5; i++) {
      workers5[i].yaw = FIVE_YAW[i];
      workers5[i].talk = (i === 0 || i === 1 || i === 3) ? 1.0 : 0.35;
      workers5[i].work = (i === 2) ? 0.7 : 0.0;
    }
    worker1.yaw = 2.35;
    worker1.talk = 0.0;
    worker1.work = 1.0;

    var limbGeo = G(new THREE.CylinderGeometry(0.5, 0.42, 1, 6, 1, false));
    var limbInst = new THREE.InstancedMesh(limbGeo, matLimb, NH * LIMB_DARK.length);
    /* the workers are the only casters in the scene: ~1500 tris in the depth
       pass, and the only cast shadow the camera can actually see. The cab casts
       away from the viewer (the key travels toward +z, so the cab shadow falls
       behind the camera), which is why it is not worth a draw call. */
    limbInst.castShadow = true;
    limbInst.receiveShadow = true;
    limbInst.frustumCulled = false;
    if (limbInst.instanceMatrix.setUsage) limbInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(limbInst);

    var vestGeo = G(new THREE.CylinderGeometry(0.5, 0.46, 1, 6, 1, false));
    var vestInst = new THREE.InstancedMesh(vestGeo, matVest, NH * LIMB_VEST.length);
    vestInst.castShadow = true;
    vestInst.receiveShadow = true;
    vestInst.frustumCulled = false;
    if (vestInst.instanceMatrix.setUsage) vestInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(vestInst);

    var headGeo = G(new THREE.IcosahedronGeometry(0.135, 0));
    var headInst = new THREE.InstancedMesh(headGeo, matVest, NH);
    headInst.castShadow = true;
    headInst.receiveShadow = true;
    headInst.frustumCulled = false;
    if (headInst.instanceMatrix.setUsage) headInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(headInst);

    /* A helmet is a ball from every angle: without a front the head-turn is
       literally invisible and the whole beat is thrown away. A pale COLD face
       plate plus the reflective band on the brim - grey, never warm, so the
       vests keep the only saturated warm colour in the frame - both standing
       proud of the 0.135 sphere so the head reads direction from any angle.
       WorldB solves the same problem the same way (skull + cap + pale face
       box at +Z). One extra instanced draw, 24 triangles per figure. */
    var matFace = lam(0x93a0ad, 0x0d1219);
    var faceGeo = G(mergeGeos([
      { g: new THREE.BoxGeometry(0.150, 0.098, 0.050), m: MTX(0, -0.022, 0.112) },
      { g: new THREE.BoxGeometry(0.238, 0.030, 0.126), m: MTX(0, 0.060, 0.070) }
    ]));
    var faceInst = new THREE.InstancedMesh(faceGeo, matFace, NH);
    faceInst.frustumCulled = false;
    if (faceInst.instanceMatrix.setUsage) faceInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(faceInst);

    var toolGeo = G(mergeGeos([
      { g: new THREE.BoxGeometry(0.04, 0.95, 0.04), m: MTX(0, 0, 0) },
      { g: new THREE.BoxGeometry(0.20, 0.07, 0.07), m: MTX(0, 0.46, 0) }
    ]));
    var toolInst = new THREE.InstancedMesh(toolGeo, matStruct, NH);
    toolInst.castShadow = true;
    toolInst.frustumCulled = false;
    if (toolInst.instanceMatrix.setUsage) toolInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(toolInst);

    var blobGeo = G(new THREE.PlaneGeometry(1, 1));
    blobGeo.rotateX(-Math.PI / 2);
    var blobInst = new THREE.InstancedMesh(blobGeo, matBlob, NH);
    blobInst.frustumCulled = false;
    blobInst.renderOrder = 1;
    if (blobInst.instanceMatrix.setUsage) blobInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(blobInst);

    /* =============================================== PARTICLES */
    var debris = new Pool(300, 0.11, dotTex, -16.0, 0.985, false);
    var dust = new Pool(160, 1.00, softTex, -0.55, 0.965, false);
    res.geo.push(debris.geo, dust.geo);
    res.mat.push(debris.mat, dust.mat);
    scene.add(debris.mesh);
    scene.add(dust.mesh);

    /* =============================================== THE CAB */
    var cab = new THREE.Group();
    cabRig.add(cab);

    var cabShellGeo = G(mergeGeos([
      /* windscreen frame */
      { g: new THREE.BoxGeometry(2.55, 0.17, 0.17), m: MTX(0, -0.545, -1.06) },
      { g: new THREE.BoxGeometry(2.55, 0.22, 0.17), m: MTX(0, 0.72, -1.06) },
      { g: new THREE.BoxGeometry(0.19, 1.5, 0.17), m: MTX(-1.21, 0.09, -1.06) },
      { g: new THREE.BoxGeometry(0.19, 1.5, 0.17), m: MTX(1.21, 0.09, -1.06) },
      /* corner brackets */
      { g: new THREE.BoxGeometry(0.30, 0.30, 0.20), m: MTX(-1.10, -0.44, -1.04) },
      { g: new THREE.BoxGeometry(0.30, 0.30, 0.20), m: MTX(1.10, -0.44, -1.04) },
      /* side walls / roof / floor / bulkhead */
      { g: new THREE.BoxGeometry(0.15, 1.85, 1.6), m: MTX(-1.26, 0.0, -0.28) },
      { g: new THREE.BoxGeometry(0.15, 1.85, 1.6), m: MTX(1.26, 0.0, -0.28) },
      { g: new THREE.BoxGeometry(2.75, 0.13, 1.8), m: MTX(0, 0.86, -0.22) },
      { g: new THREE.BoxGeometry(2.75, 0.13, 1.8), m: MTX(0, -1.60, -0.22) },
      { g: new THREE.BoxGeometry(2.75, 2.1, 0.13), m: MTX(0, -0.30, 0.60) },
      /* dashboard */
      { g: new THREE.BoxGeometry(2.30, 0.34, 0.50), m: MTX(0, -0.585, -0.80, 0.30) },
      { g: new THREE.BoxGeometry(2.30, 0.07, 0.11), m: MTX(0, -0.40, -0.585, 0.30) },
      { g: new THREE.BoxGeometry(2.30, 0.5, 0.14), m: MTX(0, -0.86, -0.98, 0.30) },
      /* side console + pedestal */
      { g: new THREE.BoxGeometry(0.42, 0.34, 0.55), m: MTX(0.80, -0.72, -0.60) },
      { g: new THREE.CylinderGeometry(0.07, 0.09, 0.62, 6), m: MTX(-0.62, -0.80, -0.72) },
      { g: new THREE.CylinderGeometry(0.14, 0.14, 0.07, 8), m: MTX(-0.62, -0.49, -0.72) },
      /* rivet strip */
      { g: new THREE.BoxGeometry(2.5, 0.05, 0.05), m: MTX(0, -0.455, -0.985) }
    ]));
    var cabShell = new THREE.Mesh(cabShellGeo, matCab);
    cab.add(cabShell);

    var cabTrimGeo = G(mergeGeos([
      { g: new THREE.TorusGeometry(0.145, 0.016, 5, 14), m: MTX(-0.38, -0.395, -0.79, -0.95) },
      { g: new THREE.BoxGeometry(0.5, 0.03, 0.06), m: MTX(0.32, -0.395, -0.72, 0.30) },
      { g: new THREE.CylinderGeometry(0.032, 0.032, 0.05, 6), m: MTX(0.14, -0.40, -0.735, 0.30) },
      { g: new THREE.CylinderGeometry(0.032, 0.032, 0.05, 6), m: MTX(0.50, -0.40, -0.735, 0.30) },
      { g: new THREE.CylinderGeometry(0.048, 0.048, 0.05, 8), m: MTX(0.32, -0.40, -0.735, 0.30) }
    ]));
    var cabTrim = new THREE.Mesh(cabTrimGeo, matBrass);
    cab.add(cabTrim);

    /* dial face + needle */
    var dialGroup = new THREE.Group();
    dialGroup.position.set(-0.38, -0.385, -0.785);
    dialGroup.rotation.x = -0.95;
    cab.add(dialGroup);
    var dialFaceGeo = G(new THREE.PlaneGeometry(0.255, 0.255));
    var dialFace = new THREE.Mesh(dialFaceGeo, matDial);
    dialFace.position.z = 0.004;
    dialGroup.add(dialFace);
    var needleGeo = G(new THREE.BoxGeometry(0.010, 0.105, 0.004));
    needleGeo.translate(0, 0.048, 0);
    var needle = new THREE.Mesh(needleGeo, matNeedle);
    needle.position.z = 0.012;
    dialGroup.add(needle);

    /* indicator lamps */
    var lampGeo = G(new THREE.SphereGeometry(0.030, 8, 6));
    var lampA = new THREE.Mesh(lampGeo, matLampA);
    lampA.position.set(0.14, -0.378, -0.727);
    cab.add(lampA);
    var lampB = new THREE.Mesh(lampGeo, matLampB);
    lampB.position.set(0.50, -0.378, -0.727);
    cab.add(lampB);
    var failGeo = G(new THREE.SphereGeometry(0.046, 10, 7));
    var failLamp = new THREE.Mesh(failGeo, matLampRed);
    failLamp.position.set(0.32, -0.372, -0.727);
    cab.add(failLamp);

    /* brake lever */
    var leverGroup = new THREE.Group();
    leverGroup.position.set(0.66, -0.86, -0.66);
    leverGroup.rotation.x = -0.22;
    cab.add(leverGroup);
    var leverRodGeo = G(mergeGeos([
      { g: new THREE.CylinderGeometry(0.024, 0.030, 0.66, 6), m: MTX(0, 0.33, 0) },
      { g: new THREE.CylinderGeometry(0.055, 0.055, 0.045, 8), m: MTX(0, 0.04, 0) },
      { g: new THREE.TorusGeometry(0.048, 0.010, 4, 10), m: MTX(0, 0.60, 0, Math.PI / 2) }
    ]));
    var leverRod = new THREE.Mesh(leverRodGeo, matBrass);
    leverGroup.add(leverRod);
    var gripGeo = G(new THREE.CylinderGeometry(0.052, 0.046, 0.19, 8));
    var grip = new THREE.Mesh(gripGeo, matWood);
    grip.position.set(0, 0.70, 0);
    leverGroup.add(grip);

    /* gloved hands */
    var handGeo = G(mergeGeos([
      { g: new THREE.BoxGeometry(0.115, 0.058, 0.155), m: MTX(0, 0, 0) },
      { g: new THREE.BoxGeometry(0.105, 0.048, 0.075), m: MTX(0, -0.006, -0.105) },
      { g: new THREE.BoxGeometry(0.045, 0.048, 0.085), m: MTX(-0.072, 0, -0.030, 0, 0.42, 0) },
      { g: new THREE.BoxGeometry(0.095, 0.075, 0.105), m: MTX(0, 0.008, 0.105) }
    ]));
    var handR = new THREE.Mesh(handGeo, matGlove);
    handR.position.set(0, 0.70, 0.055);
    handR.rotation.x = 0.35;
    leverGroup.add(handR);

    var handL = new THREE.Mesh(handGeo, matGlove);
    handL.position.set(-0.62, -0.435, -0.70);
    handL.rotation.set(0.2, 0.15, 0.1);
    cab.add(handL);

    /* windscreen glass + crack overlay */
    var glassGeo = G(new THREE.PlaneGeometry(2.20, 1.05));
    var glass = new THREE.Mesh(glassGeo, matGlass);
    glass.position.set(0, 0.075, -1.015);
    glass.renderOrder = 6;
    cab.add(glass);

    var crackGeo = G(new THREE.PlaneGeometry(2.00, 1.02));
    var crack = new THREE.Mesh(crackGeo, matCrack);
    crack.position.set(0, 0.075, -1.005);
    crack.renderOrder = 7;
    crack.visible = false;
    cab.add(crack);

    /* motion streaks at the frame edges */
    var strGeo = G(new THREE.PlaneGeometry(0.62, 1.30));
    var streakL = new THREE.Mesh(strGeo, matStreak);
    streakL.position.set(-0.88, 0.05, -1.45);
    streakL.rotation.y = 0.42;
    streakL.renderOrder = 4;
    cab.add(streakL);
    var streakR = new THREE.Mesh(strGeo, matStreak);
    streakR.position.set(0.88, 0.05, -1.45);
    streakR.rotation.y = -0.42;
    streakR.renderOrder = 4;
    cab.add(streakR);

    /* =============================================== STATE */
    var T = 0;
    var dist = 0;
    var narr = 0;
    var speed = CRUISE, speedTarget = CRUISE, speedMul = 1.0;
    var decelRate = 0;
    var thrown = false, switchAnim = -1, commitRamp = -1;
    var brakeSeq = -1, brakeFailed = false;
    var timeScale = 1, tsTarget = 1, tsHold = 0;
    var lateral = 0, yawTrack = 0;
    var sideRevealT = -1, sideRevealDur = 1.6;
    var cameraOwned = true, autoFov = true, glassCrackOn = true;
    var disposed = false;
    var rdAcc = 0, rdAlpha = 0;
    var railPhase = 0;
    var shakeAmt = 0.12, impactShake = 0, failShake = 0;
    var kx = 0, ky = 0, kz = 0, kvx = 0, kvy = 0, kvz = 0;
    var kpx = 0, kpy = 0, kpz = 0, kpvx = 0, kpvy = 0, kpvz = 0;
    var crackAmt = 0, crackTarget = 0, crackSgn = 1;
    var fovCur = 62;
    var aftermathT = -1;
    var contactDone = false;
    var impactWhich = '';
    /* k is the fraction of the closing rush spent at the CURRENT world speed
       before it accelerates: with k = 0 (the old pure rt*rt) the world stops
       dead for one frame at the start of the rush and then slams to 4x cruise,
       which was survivable over the old 11 m rush and is not over the 28 m one
       that a 30 m hold implies. Set per impact so d(dist)/dt is continuous. */
    var rush = { active: false, t: 0, dur: 0.42, d0: 0, d1: 0, s0: 0, k: 0 };
    var cameraShakeHook = { amount: 0 };
    var onContact = null;

    var QTAB = {
      sleep: [64, 96, 136, 176],
      grav: [0, 64, 128, 192],
      pole: [8, 10, 14, 18],
      debris: [80, 150, 220, 300],
      dust: [40, 80, 120, 160],
      /* FogExp2 factor = 1 - exp(-(density*d)^2). The five are now staged at
         140 m and close to a 30 m hold, so the whole approach lives inside the
         band where this density still lets an orange vest through. At 0.0063:
            140 m -> 54% fogged   (t = 0 s: a smudge, but a smudge that reads)
            113 m -> 40%          (t = 1 s)
             86 m -> 25%          (t = 2 s: five separate shapes)
             62 m -> 14%          (t = 3 s: arms, legs, vests)
             37 m ->  5%          (t = 5.6 s: unmistakably human)
             30 m ->  3.5%        (the hold: held large for the rest of it)
         The lone worker sits 6 m nearer than the group at every instant, so
         he is always the least-fogged figure in frame (2.3% at the hold).
         Lower quality keeps slightly denser fog, as before, to hide less. */
      fog: [0.0076, 0.0071, 0.0067, 0.0063]
    };

    function setQuality(q) {
      try {
        q = clamp(Math.round(num(q, 2)), 0, 3);
        quality = q;
        sleepInst.count = QTAB.sleep[q];
        gravInst.count = QTAB.grav[q];
        poleInst.count = QTAB.pole[q];
        debris.cap = QTAB.debris[q];
        dust.cap = QTAB.dust[q];
        if (scene.fog) scene.fog.density = QTAB.fog[q];
        /* shadows only above the low tiers: on a school Chromebook the extra
           depth pass plus the PCF-soft taps are the first thing to cut, and the
           blob shadows under each figure already carry the contact read. */
        key.castShadow = (q >= 2);
        key.shadow.mapSize.width = (q >= 3) ? 1024 : 512;
        key.shadow.mapSize.height = (q >= 3) ? 1024 : 512;
        if (key.shadow.map) { key.shadow.map.dispose(); key.shadow.map = null; }
        streakL.visible = (q >= 1);
        streakR.visible = (q >= 1);
        sunMesh.visible = (q >= 1);
        gravInst.visible = (q >= 1);
        matBlob.opacity = (q >= 1) ? 0.5 : 0.38;
      } catch (e) {}
    }
    setQuality(quality);

    /* =============================================== ACTIONS */
    function pullBrake() {
      if (brakeSeq >= 0) return 1.25;
      brakeSeq = 0;
      return 1.25;
    }

    function throwSwitch() {
      if (thrown) return 0.6;
      thrown = true;
      if (switchAnim < 0) switchAnim = 0;
      /* the decision releases the narrative hold: from here the cab really
         does run through the points and out onto the branch. */
      if (commitRamp < 0) commitRamp = 0;
      return 0.6;
    }

    /* The beat where the driver registers the branch. The points, the side
       rails and the lone worker are all already in the scene, so this is
       staging, not construction: he straightens out of his crouch and turns
       his head toward the noise, which is what makes the one saturated orange
       in the frame read as a person rather than a marker. Returns the length
       of the move in seconds. Idempotent. */
    function revealSide(durationSec) {
      if (sideRevealT >= 0) return sideRevealDur;
      sideRevealDur = clamp(num(durationSec, 1.6), 0.3, 8);
      sideRevealT = 0;
      return sideRevealDur;
    }

    function setSpeed(mps, instant) {
      speedTarget = Math.max(0, num(mps, CRUISE));
      decelRate = 0;
      if (instant) speed = speedTarget;
    }
    function getSpeed() { return speed; }

    function distanceToTarget(which) {
      var z = (which === 'one') ? (ONE_Z0 + narr) : (FIVE_Z0 + narr);
      return Math.max(0, -z);
    }

    function impact(which, immediate) {
      if (contactDone || rush.active) return 0;
      impactWhich = (which === 'one') ? 'one' : 'five';
      var D = distanceToTarget(impactWhich);
      if (D > 46) { narr += (D - 46); D = 46; }
      if (impactWhich === 'one') { thrown = true; if (switchAnim < 0) switchAnim = 0.6; }
      /* 2.6 m, not 1.9 m. The cab exclusion box runs from z = -2.30, so the
         old contact point left every particle of every body INSIDE the cab
         volume on the launch frame, where the box's reflection replaced the
         impulse. 2.6 puts the whole figure clear of the plane; the box's new
         outbound-velocity test is the belt to that pair of braces. */
      var delta = Math.max(0, D - 2.6);
      rush.active = true; rush.t = 0;
      rush.dur = immediate ? 0.06 : clamp(delta / 34, 0.16, 0.5);
      rush.d0 = narr; rush.d1 = narr + delta; rush.s0 = dist;
      /* match the world's current speed at rush.t = 0 (clamped: a short rush
         onto the branch is already slower than cruise and must not reverse) */
      rush.k = (delta > 1e-4) ? clamp(speed * rush.dur / delta, 0, 1) : 1;
      return rush.dur;
    }

    function doContact() {
      contactDone = true;
      var cx = lateral;
      var targets = (impactWhich === 'one') ? [worker1] : workers5;
      var i2, j;
      for (i2 = 0; i2 < targets.length; i2++) {
        var h = targets[i2];
        /* The tram is doing 26.82 m/s. A struck pedestrian leaves the nose
           at roughly two thirds of vehicle speed, and this figure is
           launched with a height gradient (f = 0.75 at the feet, 1.51 at the
           head), so power 13-16 gives a body-centroid speed near 18 m/s =
           67% of the tram, with the head peaking at 27 m/s - exactly the new
           RD_MAXSTEP ceiling, which is one tram speed. 9-13 read as a
           shoulder barge, and RD_MAXSTEP 0.30 would have clipped anything
           larger straight back down to 18 m/s anyway.
           Not pushed higher: at 20 m/s the bodies clear 18 m before they
           even land, and the shot needs them tumbling in the foreground. */
        h.launch(-1, rr(13.0, 16.0), 3.0, rr(3.6, 5.0));
      }
      /* dropped tools */
      for (i2 = 0; i2 < targets.length; i2++) {
        debris.spawn(targets[i2].x[27], targets[i2].x[28], targets[i2].x[29],
                     rr(-3, 3), rr(1.5, 5.0), rr(-9, -2), rr(1.2, 2.2),
                     0.62, 0.66, 0.74);
      }
      /* debris + dust at the contact face */
      var contZ = -2.1;
      var nDeb = (quality >= 2) ? 74 : (quality === 1 ? 48 : 26);
      for (j = 0; j < nDeb; j++) {
        var ang = Math.random() * 6.2832;
        var sp = rr(3, 15);
        debris.spawn(
          cx + rr(-1.4, 1.4), rr(0.35, 2.3), contZ + rr(-0.7, 0.5),
          Math.cos(ang) * sp * 0.55, rr(1.5, 8.5), -Math.abs(rr(2, 12)),
          rr(0.7, 2.1),
          rr(0.55, 1.0), rr(0.55, 0.92), rr(0.6, 1.0)
        );
      }
      /* TORN HI-VIS. The burst was entirely cold grey grit. Safety orange is
         the only saturated warm colour in this world and the only thing in
         the frame that says a person is there; when a person comes apart,
         the frame has to say so. Colours are the vest's own 0xff6a10 in the
         same raw-sRGB space every material here is authored in (FX owns the
         transfer function), jittered so it reads as cloth and grit off a
         body rather than a firework. Deliberately few. */
      var nWarm = (quality >= 2) ? 16 : (quality === 1 ? 10 : 5);
      for (j = 0; j < nWarm; j++) {
        var wang = Math.random() * 6.2832;
        var wsp = rr(2.5, 9.5);
        debris.spawn(
          cx + rr(-0.9, 0.9), rr(0.55, 1.95), contZ + rr(-0.5, 0.35),
          Math.cos(wang) * wsp * 0.5, rr(1.2, 6.0), -Math.abs(rr(1.5, 8.0)),
          rr(0.9, 2.4),
          1.00, rr(0.36, 0.47), rr(0.05, 0.12)
        );
      }
      var nDust = (quality >= 2) ? 52 : (quality === 1 ? 32 : 16);
      for (j = 0; j < nDust; j++) {
        dust.spawn(
          cx + rr(-2.6, 2.6), rr(0.15, 2.8), contZ + rr(-3.5, 0.8),
          rr(-2.2, 2.2), rr(0.3, 2.0), rr(-4.5, -0.4),
          rr(1.6, 3.4),
          rr(0.10, 0.22), rr(0.13, 0.26), rr(0.18, 0.34)
        );
      }
      /* glass */
      if (glassCrackOn) {
        crack.visible = true;
        crack.position.x = (impactWhich === 'one') ? 0.10 : -0.09;
        crack.scale.x = (impactWhich === 'one') ? -1 : 1;
        crackSgn = (impactWhich === 'one') ? -1 : 1;
        crackTarget = 1;
        /* the star GROWS out of the strike point (see update) instead of
           appearing whole in a single frame */
        crackAmt = 0.12;
        matGlass.opacity = 0.72;
      }
      /* camera throw */
      /* The rotation spring is KK=92, KC=11: omega 9.59, zeta 0.573, so the
         peak of its impulse response is v0 / 7.86 * 0.511 = 0.065 * v0 rad.
         At v0 = -6.5 and an output gain of 0.03 that is 0.0127 rad = 0.73
         degrees of pitch - LESS than the idle rail vibration, which reaches
         0.0110 rad at full shake. The impact was literally quieter than the
         ride. Doubling v0 and taking the output gain to 0.058 gives
         0.065 * 12.5 * 0.058 = 0.047 rad = 2.7 deg typical, 3.5 deg worst,
         and the spring is dead inside half a second (zeta 0.57).
         The position spring is PK=70, PC=10: peak 0.0745 * v0 m, so the new
         kpvy takes the camera 5 cm down through the impact - felt, not
         nauseating. */
      kvx += rr(-16.0, -9.0);
      kvy += rr(-7.5, 7.5);
      kvz += rr(-11.0, 11.0);
      kpvx += rr(-4.2, 4.2);
      kpvy += rr(-8.5, -4.0);
      kpvz += rr(2.0, 5.5);
      impactShake = 1.0;
      cameraShakeHook.amount = 1.4;
      /* slow motion */
      tsTarget = 0.26; tsHold = 0.38; timeScale = 0.26;
      /* speed collapse -- short, violent stopping distance so the wreck stays
         in front of the windscreen for the aftermath                        */
      speedTarget = 0; speedMul = 1;
      /* 0.45 s from 26.82 m/s is 60 m/s^2 - six g, a stop in 6 m - and it
         teaches the wrong thing twice: five people do not stop thirty
         tonnes, and the HUD in this very frame says BRAKE FAILURE.
         1.30 s is 20.6 m/s^2 over 17.4 m: still short enough that the beat
         does not sag, but it reads as PLOUGHING THROUGH rather than hitting
         a wall, which leaves Scene B's grinding halt on one heavy body as
         the only moment in the piece where a body stops a tram.
         aftermath() already re-arms decel for any residual speed. */
      decelRate = speed / 1.30;
      if (onContact) { try { onContact(impactWhich); } catch (e) {} }
    }

    function aftermath() {
      aftermathT = 0;
      speedTarget = 0; speedMul = 1;
      if (speed > 0.02) decelRate = Math.max(decelRate, speed / 1.6);
      var j;
      var nDust = (quality >= 2) ? 46 : 22;
      for (j = 0; j < nDust; j++) {
        dust.spawn(
          lateral + rr(-4, 4), rr(0.1, 2.6), rr(-16, -2.5),
          rr(-0.5, 0.5), rr(0.05, 0.5), rr(-0.4, 0.4),
          rr(3.5, 7.0),
          rr(0.07, 0.16), rr(0.09, 0.19), rr(0.13, 0.26)
        );
      }
      return 6.0;
    }

    /* =============================================== instanced writers */
    function writeLimb(inst, slot, arr, ia, ib, th) {
      var a = ia * 3, b = ib * 3;
      _va.set(arr[b] - arr[a], arr[b + 1] - arr[a + 1], arr[b + 2] - arr[a + 2]);
      var L = _va.length();
      if (L < 1e-5) L = 1e-5;
      _va.multiplyScalar(1 / L);
      _vb.set((arr[a] + arr[b]) * 0.5, (arr[a + 1] + arr[b + 1]) * 0.5, (arr[a + 2] + arr[b + 2]) * 0.5);
      _q0.setFromUnitVectors(_UP, _va);
      _s0.set(th, L, th);
      _m0.compose(_vb, _q0, _s0);
      inst.setMatrixAt(slot, _m0);
    }
    function hideSlot(inst, slot) {
      _p0.set(0, -9999, 0); _q0.identity(); _s0.set(0.0001, 0.0001, 0.0001);
      _m0.compose(_p0, _q0, _s0);
      inst.setMatrixAt(slot, _m0);
    }

    function drawHumans(alpha) {
      var hi, li, slot;
      for (hi = 0; hi < NH; hi++) {
        var h = humans[hi];
        var arr;
        if (h.isRagdoll) {
          var x = h.x, p = h.p, q;
          for (q = 0; q < 42; q++) _scr[q] = p[q] + (x[q] - p[q]) * alpha;
          arr = _scr;
        } else {
          arr = h.x;
        }
        if (!h.visible) {
          for (li = 0; li < LIMB_DARK.length; li++) hideSlot(limbInst, hi * LIMB_DARK.length + li);
          for (li = 0; li < LIMB_VEST.length; li++) hideSlot(vestInst, hi * LIMB_VEST.length + li);
          hideSlot(headInst, hi); hideSlot(faceInst, hi);
          hideSlot(toolInst, hi); hideSlot(blobInst, hi);
          continue;
        }
        for (li = 0; li < LIMB_DARK.length; li++) {
          slot = hi * LIMB_DARK.length + li;
          writeLimb(limbInst, slot, arr, LIMB_DARK[li][0], LIMB_DARK[li][1], LIMB_DARK[li][2] * h.scale);
        }
        for (li = 0; li < LIMB_VEST.length; li++) {
          slot = hi * LIMB_VEST.length + li;
          writeLimb(vestInst, slot, arr, LIMB_VEST[li][0], LIMB_VEST[li][1], LIMB_VEST[li][2] * h.scale);
        }
        /* head */
        _p0.set(arr[0], arr[1], arr[2]);
        if (h.isRagdoll) {
          /* a dead head follows its own neck; it does not keep facing the cab */
          _va.set(arr[0] - arr[3], arr[1] - arr[4], arr[2] - arr[5]);
          if (_va.lengthSq() < 1e-8) _va.set(0, 1, 0); else _va.normalize();
          _q0.setFromUnitVectors(_UP, _va);
        } else {
          /* the mesh was left at the body yaw, so the head PARTICLES swung
             round to the camera and the face did not: now it turns with them */
          _e0.set(0, h.yaw + h.turn * h.lookDelta, 0); _q0.setFromEuler(_e0);
        }
        _s0.set(h.scale, h.scale * 1.06, h.scale);
        _m0.compose(_p0, _q0, _s0);
        headInst.setMatrixAt(hi, _m0);
        faceInst.setMatrixAt(hi, _m0);
        /* tool in the right hand */
        if (h.hasTool) {
          _p0.set(arr[27], arr[28] - 0.30 * h.scale, arr[29] + 0.05);
          _e0.set(0.85, h.yaw, 0.1); _q0.setFromEuler(_e0);
          _s0.set(1, h.scale, 1);
          _m0.compose(_p0, _q0, _s0);
          toolInst.setMatrixAt(hi, _m0);
        } else hideSlot(toolInst, hi);
        /* blob shadow under the pelvis */
        var px = (arr[12] + arr[15]) * 0.5;
        var py = (arr[13] + arr[16]) * 0.5;
        var pz = (arr[14] + arr[17]) * 0.5;
        var air = clamp01((py - 0.9) / 1.6);
        var bs = (1.25 - air * 0.85) * h.scale;
        if (bs < 0.05) bs = 0.05;
        _p0.set(px, 0.035, pz);
        _q0.identity();
        _s0.set(bs * 1.05, 1, bs * 1.45);
        _m0.compose(_p0, _q0, _s0);
        blobInst.setMatrixAt(hi, _m0);
      }
      limbInst.instanceMatrix.needsUpdate = true;
      vestInst.instanceMatrix.needsUpdate = true;
      headInst.instanceMatrix.needsUpdate = true;
      faceInst.instanceMatrix.needsUpdate = true;
      toolInst.instanceMatrix.needsUpdate = true;
      blobInst.instanceMatrix.needsUpdate = true;
    }

    /* cheap smooth pseudo-noise */
    function n2(t, f, p) {
      return Math.sin(t * f + p) * 0.62 + Math.sin(t * f * 2.37 + p * 1.7) * 0.38;
    }

    function autoTension() {
      var d = distanceToTarget('five');
      var v = 1 - clamp01((d - 28) / 112);
      if (brakeFailed) v = Math.max(v, 0.55);
      return clamp01(v);
    }

    /* =============================================== UPDATE */
    function update(dt, state) {
      if (disposed) return;
      try {
        dt = num(dt, 1 / 60);
        if (dt <= 0) dt = 1 / 60;
        if (dt > 0.06) dt = 0.06;
        state = state || {};
        T += dt;

        if (state.thrown === true && !thrown) throwSwitch();
        var tension = (typeof state.tension === 'number' && isFinite(state.tension))
          ? clamp01(state.tension) : autoTension();

        /* ---- time scale ---- */
        if (tsHold > 0) {
          tsHold -= dt;
          timeScale += (tsTarget - timeScale) * Math.min(1, dt * 12);
        } else {
          timeScale += (1 - timeScale) * Math.min(1, dt * 2.4);
        }
        if (timeScale > 1) timeScale = 1;
        var sdt = dt * timeScale;

        /* ---- speed ---- */
        if (decelRate > 0) {
          speed -= decelRate * sdt;
          if (speed <= 0.02) { speed = 0; decelRate = 0; }
        } else {
          speed += (speedTarget * speedMul - speed) * Math.min(1, sdt * 1.6);
        }

        if (!isFinite(dist)) dist = 0;
        if (!isFinite(narr)) narr = 0;
        if (!isFinite(speed)) { speed = 0; decelRate = 0; }

        /* ---- distance / rush ---- */
        if (rush.active) {
          rush.t += dt;
          var rt = clamp01(rush.t / rush.dur);
          var e = rush.k * rt + (1 - rush.k) * rt * rt;
          var add = (rush.d1 - rush.d0) * e;
          narr = rush.d0 + add;
          dist = rush.s0 + add;
          if (rush.t >= rush.dur) {
            rush.active = false;
            narr = rush.d1;
            if (!contactDone) doContact();
          }
        } else {
          dist += speed * sdt;
          if (contactDone) {
            narr += speed * sdt;          /* no easing once it has happened */
          } else {
            /* The world closes on the five and then holds them at HOLD_MIN so
               the dilemma can sit still for as long as the class needs. Once
               the points are thrown the hold is released over COMMIT_RAMP
               seconds; without that 'narr' is frozen, the cab never reaches
               the points, and 'lateral' never leaves zero -- it would arrive
               at the lone worker while still on the main line. */
            var dToFive = -(FIVE_Z0 + narr);
            var ease = clamp01((dToFive - HOLD_MIN) / EASE_BAND);
            if (commitRamp >= 0) {
              if (commitRamp < 1) commitRamp = Math.min(1, commitRamp + dt / COMMIT_RAMP);
              ease += (1 - ease) * sstep(commitRamp);
            }
            narr += speed * sdt * ease;
            /* failsafe: a released hold must never carry the cab THROUGH the
               lone worker if the impact beat is late. Stop 3.5 m short. */
            if (commitRamp >= 0) {
              var narrCap = -ONE_Z0 - 3.5;
              if (narr > narrCap) narr = narrCap;
            }
          }
        }

        /* ---- brake sequence ---- */
        if (brakeSeq >= 0) {
          brakeSeq += dt;
          var b = brakeSeq;
          var ang;
          if (b < 0.30) { ang = -0.22 + 0.86 * sstep(b / 0.30); }
          else if (b < 0.85) {
            ang = 0.64 + Math.sin(b * 46) * 0.012 * (1 - (b - 0.30) / 0.55);
            speedMul = 1 - 0.055 * Math.sin(Math.PI * (b - 0.30) / 0.55);
          } else if (b < 1.25) {
            if (!brakeFailed) { brakeFailed = true; failShake = 1; }
            var u = (b - 0.85) / 0.40;
            ang = 0.64 + 0.38 * sstep(u) + Math.sin(b * 30) * 0.03 * (1 - u);
            speedMul = 1;
          } else {
            ang = 1.02 + Math.sin(T * 7.5) * 0.012;
            speedMul = 1;
          }
          leverGroup.rotation.x = ang;
        }
        if (failShake > 0) failShake = Math.max(0, failShake - dt * 1.4);

        /* ---- points animation ---- */
        if (switchAnim >= 0 && switchAnim < 0.6) {
          switchAnim = Math.min(0.6, switchAnim + dt);
          var sp2 = sstep(switchAnim / 0.6);
          bladeGroup.position.x = sp2 * 0.11;
          bladeGroup.rotation.y = -sp2 * 0.030;
          plateGroup.rotation.y = sp2 * Math.PI * 0.5;
        }

        /* ---- scroll ---- */
        sleepGroup.position.z = dist % (SLEEP_SP * SLEEP_VARY);
        gravGroup.position.z = dist % GRAV_BLOCK;
        poleGroup.position.z = dist % (POLE_SP * 2);
        if (grdTex) { grdTex.offset.y = (dist / (1200 / 90)) % 1; }
        if (ballTex) { ballTex.offset.y = (dist / (1200 / 34)) % 1; }

        switchGroup.position.z = SWITCH_Z0 + narr;

        /* ---- lateral (side track) ---- */
        var swz = SWITCH_Z0 + narr;
        var pastS = swz > 0 ? swz : 0;
        var wantLat = thrown ? diverge(pastS) : 0;
        var wantYaw = thrown ? -Math.atan(divSlope(pastS)) : 0;
        /* After the throw the cab has about half a second of branch to slew
           across before contact and wantLat is a moving ramp, so a gain of 5
           (tau = 0.2 s) lags it badly: stepping the real integrator at 1/60
           gives a 1.01 m / 28 deg miss -- the man arrives at the very edge of
           the windscreen. wantLat is continuous at the throw (pastS is still
           negative then), so the filter only has to smooth, not cushion a
           step. Measured misses at contact: 5 -> 1.01 m, 12 -> 0.22 m,
           18 -> 0.10 m, 25 -> 0.05 m. 18 (tau = 0.056 s) is the knee. This
           form can never overshoot, so a low frame rate merely snaps.
           Off the branch nothing changes. */
        var latK = Math.min(1, dt * (thrown ? 18 : 5));
        lateral += (wantLat - lateral) * latK;
        yawTrack += (wantYaw - yawTrack) * latK;

        /* ---- workers ---- */
        var fz = FIVE_Z0 + narr;
        var i2;
        for (i2 = 0; i2 < 5; i2++) {
          var hh = workers5[i2];
          if (!hh.isRagdoll) {
            hh.setPos(FIVE_OFF[i2][0], 0, fz + FIVE_OFF[i2][1]);
            var dF = -fz;
            /* These thresholds are metres and the group now holds at 30 m, so
               every one of them has to fire ABOVE 30 or it never fires at all.
               On the new closing curve: #2 comes round between 62 m and 42 m
               (t = 3.0-4.6 s) and reaches a full 1.0, which is the pose that
               brings both hands up in front of the chest; #3 half-glances from
               36 m; #4 is still turning as the hold closes. All three land
               inside the first third of the approach, which is exactly when
               the figures cross from smudge to legible. */
            if (i2 === 2) { hh.setTurn(clamp01((62 - dF) / 20)); hh.work = 0.7 * (1 - hh.turn); }
            else if (i2 === 4) hh.setTurn(clamp01((42 - dF) / 12) * 0.85);
            else if (i2 === 3) { hh.setTurn(clamp01((36 - dF) / 6) * 0.5); hh.talk = 1.0 - 0.6 * hh.turn; }
            else if (i2 === 0 || i2 === 1) hh.talk = 1.0 - 0.5 * workers5[2].turn;
            hh.setLookAt(lateral, 0);   /* the cab window, wherever it now is */
            hh.updateAlive(T, dt);
          }
        }
        var oz = ONE_Z0 + narr;
        if (!worker1.isRagdoll) {
          worker1.setPos(ONE_X, 0, oz);
          var dO = -oz;
          /* He gets the same beat as worker #2 and finishes fully turned:
             58 m -> 36 m, i.e. t = 2.9-4.6 s, and he holds at 24 m. */
          worker1.setTurn(clamp01((58 - dO) / 22));
          worker1.work = 1 - worker1.turn;      /* he stops working and looks up */
          worker1.setLookAt(lateral, 0);
          worker1.updateAlive(T, dt);
        }

        /* ---- ragdolls: fixed timestep ---- */
        var anyRag = false;
        for (i2 = 0; i2 < NH; i2++) if (humans[i2].isRagdoll) { anyRag = true; break; }
        if (anyRag) {
          var pdt = sdt;
          if (pdt > 0.25) pdt = 0.25;
          rdAcc += pdt;
          var nsub = 0;
          while (rdAcc >= RD_H && nsub < RD_MAXSUB) {
            for (i2 = 0; i2 < NH; i2++) {
              var hr = humans[i2];
              if (hr.isRagdoll) hr.step(RD_H, speed, lateral);
            }
            rdAcc -= RD_H; nsub++;
          }
          if (nsub === RD_MAXSUB) rdAcc = 0;
          rdAlpha = rdAcc / RD_H;
        }

        drawHumans(rdAlpha);

        /* ---- particles ---- */
        debris.update(sdt, speed);
        dust.update(sdt, speed);

        /* ---- dial + lamps ---- */
        var mph = speed / 0.44704;
        var na = 2.356 - clamp(mph, 0, 84) / 80 * 4.712;
        needle.rotation.z += (na - needle.rotation.z) * Math.min(1, dt * 8);
        var pulse = 0.5 + 0.5 * Math.sin(T * 6.2);
        if (brakeFailed) {
          matLampRed.color.setRGB(0.55 + 0.45 * pulse, 0.085 + 0.05 * pulse, 0.04 + 0.03 * pulse);
        } else {
          matLampRed.color.setRGB(0.09, 0.035, 0.025);
        }
        var idle = 0.5 + 0.5 * Math.sin(T * 1.7);
        matLampA.color.setRGB(0.06, 0.16 + 0.05 * idle, 0.21 + 0.06 * idle);
        matLampB.color.setRGB(0.05 + 0.03 * (1 - idle), 0.13, 0.17);

        /* ---- hands idle ---- */
        handL.position.y = -0.435 + Math.sin(T * 1.9) * 0.006 + n2(T, 5.5, 1.3) * 0.004 * (0.3 + tension);
        handL.rotation.z = 0.10 + Math.sin(T * 1.3) * 0.03;

        /* ---- glass ---- */
        if (crackTarget > 0) {
          crackAmt += (1 - crackAmt) * Math.min(1, dt * 5.2);
          var cam2 = clamp01(crackAmt);
          matCrack.opacity = cam2 * 0.88;
          /* The fracture spreads out of the strike point: 49% of full spread
             at t=0 to 100%, tau = 0.19 s, so about 0.35 s to read as done.
             Two scalars written to a mesh that already exists - no material,
             no geometry, no allocation, no extra draw call. */
          var cgr = 0.42 + 0.58 * cam2;
          crack.scale.set(crackSgn * cgr, cgr, 1);
        }

        /* ---- streaks ---- */
        var spN = clamp01(speed / CRUISE);
        var so = 0.10 * spN + 0.10 * tension + impactShake * 0.25;
        matStreak.opacity = clamp(so, 0, 0.45);
        if (strTex) { strTex.offset.x = (strTex.offset.x + dt * (0.8 + 4.0 * spN)) % 1; }

        /* ---- sun glow ---- */
        matSun.opacity = 0.42 * (1 - tension * 0.35);

        /* ---- rail joint rhythm + vehicle body ---- */
        railPhase += (speed / 12) * sdt;
        var jb = Math.sin(railPhase * Math.PI * 2);
        var jb2 = Math.sin(railPhase * Math.PI * 2 * 2.13 + 1.1);

        /* ---- shake accounting ---- */
        if (impactShake > 0) impactShake = Math.max(0, impactShake - dt * 1.15);
        shakeAmt = 0.10 + 0.26 * spN + 0.34 * tension + failShake * 0.45 + impactShake * 1.5;
        if (aftermathT >= 0) {
          aftermathT += dt;
          shakeAmt = 0.06 + Math.max(0, 0.35 - aftermathT * 0.10) + impactShake * 1.2;
        }
        cameraShakeHook.amount = clamp(shakeAmt, 0, 2.0);

        /* ---- camera kick springs ---- */
        var KK = 92, KC = 11.0;
        kvx += (-KK * kx - KC * kvx) * dt; kx += kvx * dt;
        kvy += (-KK * ky - KC * kvy) * dt; ky += kvy * dt;
        kvz += (-KK * kz - KC * kvz) * dt; kz += kvz * dt;
        var PK = 70, PC = 10.0;
        kpvx += (-PK * kpx - PC * kpvx) * dt; kpx += kpvx * dt;
        kpvy += (-PK * kpy - PC * kpvy) * dt; kpy += kpvy * dt;
        kpvz += (-PK * kpz - PC * kpvz) * dt; kpz += kpvz * dt;

        /* ---- rig (the vehicle itself) ---- */
        var vib = (0.004 + 0.010 * spN) * (1 + failShake * 1.6);
        cabRig.position.x = lateral + n2(T, 9.1, 0.4) * vib * 0.8;
        cabRig.position.y = EYE_Y + jb * 0.010 * spN + jb2 * 0.004 * spN + n2(T, 11.3, 2.1) * vib;
        cabRig.rotation.y = yawTrack;
        cabRig.rotation.z = jb * 0.0045 * spN + n2(T, 7.7, 3.3) * 0.004 * (1 + failShake);
        cabRig.rotation.x = jb2 * 0.0025 * spN;

        /* ---- camera (head in the cab) ---- */
        if (cameraOwned) {
          var sa = clamp(shakeAmt, 0, 2.0);
          var driftY = 0, driftX = 0;
          if (aftermathT >= 0) {
            driftX = Math.sin(aftermathT * 0.32) * 0.14;
            driftY = Math.sin(aftermathT * 0.21 + 1.2) * 0.05 - 0.03;
          }
          camera.position.set(
            n2(T, 6.3, 0.0) * 0.010 * sa + kpx * 0.115,
            n2(T, 5.1, 1.7) * 0.013 * sa + kpy * 0.115,
            n2(T, 4.4, 3.1) * 0.008 * sa + kpz * 0.115
          );
          camera.rotation.set(
            n2(T, 3.9, 0.7) * 0.0055 * sa + kx * 0.058 + driftY,
            n2(T, 3.3, 2.3) * 0.0070 * sa + ky * 0.058 + driftX,
            n2(T, 2.7, 4.1) * 0.0060 * sa + kz * 0.058
          );
        }

        /* ---- FOV ---- */
        if (autoFov) {
          var base = 62 + 11 * spN + 5 * tension + impactShake * 6;
          var asp = num(camera.aspect, 16 / 9);
          var f = base;
          if (asp < 16 / 9 && asp > 0.2) {
            f = 2 * Math.atan(Math.tan(base * Math.PI / 360) * ((16 / 9) / asp)) * 180 / Math.PI;
          }
          f = clamp(f, 45, 92);
          fovCur += (f - fovCur) * Math.min(1, dt * 3.2);
          if (Math.abs(fovCur - camera.fov) > 0.02) {
            camera.fov = fovCur;
            camera.updateProjectionMatrix();
          }
        }

        /* ---- headlamp follows speed a touch ---- */
        if (lamp) lamp.intensity = 1.7 + 0.5 * spN;

      } catch (e) {
        /* one thrown error must never kill the lesson */
      }
    }

    /* =============================================== DISPOSE */
    function dispose() {
      if (disposed) return;
      disposed = true;
      try {
        var i3;
        for (i3 = 0; i3 < res.geo.length; i3++) { try { res.geo[i3].dispose(); } catch (e) {} }
        for (i3 = 0; i3 < res.mat.length; i3++) { try { res.mat[i3].dispose(); } catch (e) {} }
        for (i3 = 0; i3 < res.tex.length; i3++) { try { res.tex[i3].dispose(); } catch (e) {} }
        while (scene.children.length) scene.remove(scene.children[0]);
      } catch (e) {}
    }

    /* =============================================== warm the shaders */
    try {
      if (renderer && renderer.compile) renderer.compile(scene, camera);
    } catch (e) {}

    var world = {
      isStub: false,
      scene: scene,
      camera: camera,
      cabRig: cabRig,
      cab: cab,
      keyLight: key,
      workers5: workers5,
      worker1: worker1,
      humans: humans,
      brakeLever: leverGroup,
      brakeGrip: grip,
      cameraShakeHook: cameraShakeHook,
      pullBrake: pullBrake,
      throwSwitch: throwSwitch,
      revealSide: revealSide,
      setSpeed: setSpeed,
      getSpeed: getSpeed,
      update: update,
      impact: impact,
      aftermath: aftermath,
      setQuality: setQuality,
      dispose: dispose,
      distanceToTarget: distanceToTarget,
      setCameraOwned: function (v) { cameraOwned = !!v; },
      setAutoFov: function (v) { autoFov = !!v; },
      setGlassCrack: function (v) { glassCrackOn = !!v; },
      setOnContact: function (fn) { onContact = (typeof fn === 'function') ? fn : null; },
      getState: function () {
        return {
          dist: dist, narr: narr, speed: speed, thrown: thrown,
          brakeFailed: brakeFailed, contact: contactDone, which: impactWhich,
          sideRevealed: (sideRevealT >= 0),
          lateral: lateral, timeScale: timeScale,
          distFive: distanceToTarget('five'), distOne: distanceToTarget('one')
        };
      }
    };
    try {
      Object.defineProperty(world, 'brakeFailed', {
        get: function () { return brakeFailed; },
        set: function (v) { if (v) brakeFailed = true; }
      });
      Object.defineProperty(world, 'thrown', {
        get: function () { return thrown; },
        set: function (v) { if (v) throwSwitch(); }
      });
      Object.defineProperty(world, 'timeScale', {
        get: function () { return timeScale; },
        set: function () {}
      });
    } catch (e) {}
    return world;
  }

  return { build: build, version: 'worldA-1.0' };

})();