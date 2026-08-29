/* =========================================================================
   MODULE: fx  --  FX AND CAMERA
   Globals declared: FX, CamRig
   three.js r160 UMD (global THREE). No modules, no add-ons, no assets.
   ========================================================================= */

var FX = (function () {

  var FX_HAS3D = (typeof THREE !== 'undefined' &&
                  !!THREE.WebGLRenderTarget && !!THREE.ShaderMaterial &&
                  !!THREE.PlaneGeometry && !!THREE.Vector2 && !!THREE.Vector3);

  var FX_v2   = FX_HAS3D ? new THREE.Vector2() : null;
  var FX_col  = FX_HAS3D ? new THREE.Color()   : null;   /* scratch: never allocate per call */
  var FX_GREF = 480;      /* grain reference height -> ~1.5 device-px cells at 720p */
  var FX_last = null;     /* most recently created live instance (module-level helpers) */

  function FX_clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function FX_num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }

  /* prefers-reduced-motion. Cached and kept live by a change listener, never
     polled: tick() reads it every frame. Only the parts of the composite that
     MOVE answer to it -- the 24 Hz grain re-seed and the impact jitter. The
     grade, the vignette, the crush and the fades are not motion and are left
     exactly as they are, so the picture the room has been colour-matched
     against does not change. */
  var FX_rm = false;
  (function () {
    try {
      if (typeof window === 'undefined' || !window.matchMedia) return;
      var mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      FX_rm = !!mq.matches;
      var h = function () { try { FX_rm = !!mq.matches; } catch (e) {} };
      if (mq.addEventListener) mq.addEventListener('change', h);
      else if (mq.addListener) mq.addListener(h);
    } catch (e) { FX_rm = false; }
  })();
  function FX_reduced() { return FX_rm; }

  var FX_imul = Math.imul || function (a, b) {
    var ah = (a >>> 16) & 0xffff, al = a & 0xffff;
    var bh = (b >>> 16) & 0xffff, bl = b & 0xffff;
    return ((al * bl) + (((ah * bl + al * bh) << 16) >>> 0)) | 0;
  };
  /* deterministic integer hash -> [-1,1]; CPU-side jolt jitter, no per-frame Math.random */
  function FX_hash(n) {
    n = n | 0;
    n = (n << 13) ^ n;
    var m = FX_imul(n, FX_imul(FX_imul(n, n), 15731) + 789221);
    m = (m + 1376312589) & 0x7fffffff;
    return 1.0 - m / 1073741824.0;
  }

  /* ---------------------------------------------------------------- shaders */

  var FX_VERT = [
    'varying vec2 vUv;',
    'void main(){ vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }'
  ].join('\n');

  /* NOTE: every uniform USED below must exist in U, or three throws inside
     WebGLUniforms.upload (it reads values[u.id].needsUpdate). Extra entries in
     U that the shader does not use are harmless. */
  var FX_FRAG = [
    'uniform sampler2D tDiffuse;',
    'uniform sampler2D tBloom;',
    'uniform sampler2D tCrack;',
    'uniform vec2  uCrackOrigin;',
    'uniform vec2  uJit;',
    'uniform vec3  uLift;',
    'uniform vec3  uCool;',
    'uniform vec3  uMid;',
    'uniform vec3  uWarm;',
    'uniform vec3  uVeilCol;',
    'uniform vec3  uFlashCol;',
    'uniform float uAspect;',
    'uniform float uSeed;',
    'uniform float uGrainPx;',
    'uniform float uGrain;',
    'uniform float uChroma;',
    'uniform float uDistort;',
    'uniform float uDesat;',
    'uniform float uContrast;',
    'uniform float uCrush;',
    'uniform float uScan;',
    'uniform float uScanF;',
    'uniform float uSpeed;',
    'uniform float uBloom;',
    'uniform float uVigR;',
    'uniform float uVigS;',
    'uniform float uVig;',
    'uniform float uVeil;',
    'uniform float uFlash;',
    'uniform float uCrack;',
    'uniform float uCrackScale;',
    'uniform float uFade;',
    'uniform float uExposure;',
    'varying vec2 vUv;',

    'float fxh(vec2 p){',
    '  vec3 q = fract(vec3(p.xyx) * 0.1031);',
    '  q += dot(q, q.yzx + 33.33);',
    '  return fract((q.x + q.y) * q.z);',
    '}',

    /* ---- the display transform, transcribed from three.js r134's own GLSL ----
       It lives here as plain source and NOT as #include <tonemapping_fragment> /
       #include <colorspace_fragment>, because r134's ShaderChunk has no chunk
       called colorspace_fragment (before r152 it is encodings_fragment) and
       r134's resolveIncludes THROWS 'Can not resolve #include <...>' while
       building the program -- which took the whole composite down every frame.
       The matrices are file-scope const, exactly as three declares them, so no
       driver has to accept a const matrix constructor inside a function body.
       See the ownership contract in FX_create(). */
    'const mat3 fxACESIn = mat3(vec3(0.59719, 0.07600, 0.02840),',
    '                           vec3(0.35458, 0.90834, 0.13383),',
    '                           vec3(0.04823, 0.01566, 0.83777));',
    'const mat3 fxACESOut = mat3(vec3( 1.60475, -0.10208, -0.00327),',
    '                            vec3(-0.53108,  1.10813, -0.07276),',
    '                            vec3(-0.07367, -0.00605,  1.07602));',
    'vec3 fxRRT(vec3 v){',
    '  vec3 a = v * (v + 0.0245786) - 0.000090537;',
    '  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;',
    '  return a / b;',
    '}',
    'vec3 fxACES(vec3 color){',
    '  color *= uExposure / 0.6;',
    '  color = fxACESIn * color;',
    '  color = fxRRT(color);',
    '  color = fxACESOut * color;',
    '  return clamp(color, 0.0, 1.0);',
    '}',
    /* linear -> sRGB. The ONLY sRGB encode in the whole pipeline. */
    'vec3 fxSRGB(vec3 v){',
    '  return mix(pow(v, vec3(0.41666)) * 1.055 - vec3(0.055),',
    '             v * 12.92,',
    '             vec3(lessThanEqual(v, vec3(0.0031308))));',
    '}',

    'void main(){',
    /* lens: barrel distortion + impact jolt (jitter computed on the CPU) */
    '  vec2 d0 = vUv - 0.5;',
    '  float r2 = dot(d0, d0);',
    '  vec2 uv = 0.5 + d0 * (1.0 + uDistort * r2) + uJit;',
    '  uv = clamp(uv, vec2(0.0008), vec2(0.9992));',
    '  vec2 dd = uv - 0.5;',
    /* chromatic aberration, radial */
    '  float ca = uChroma * (0.30 + r2 * 2.4);',
    '  vec3 c;',
    '  if (ca > 0.0004){',
    '    c.r = texture2D(tDiffuse, uv + dd * ca).r;',
    '    c.g = texture2D(tDiffuse, uv).g;',
    '    c.b = texture2D(tDiffuse, uv - dd * ca).b;',
    '  } else {',
    '    c = texture2D(tDiffuse, uv).rgb;',
    '  }',
    /* radial speed streaks: 8 taps, frame edges only */
    '  if (uSpeed > 0.004){',
    '    float w = smoothstep(0.050, 0.240, r2);',
    '    if (w > 0.002){',
    '      vec2 stp = -dd * (0.030 * min(uSpeed, 2.0));',
    '      vec2 s = uv;',
    '      vec3 acc = vec3(0.0);',
    '      for (int i = 0; i < 8; i++){ s += stp; acc += texture2D(tDiffuse, s).rgb; }',
    '      c = mix(c, acc * 0.125, clamp(w * uSpeed, 0.0, 0.85));',
    '    }',
    '  }',
    /* bloom add, linear + pre-grade so the vests glow THROUGH the fog */
    '  if (uBloom > 0.002){ c += texture2D(tBloom, uv).rgb * uBloom; }',
    /* grade: desaturate, 3-band tint, crush + lift, contrast about linear mid-grey */
    '  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));',
    '  c = mix(c, vec3(lum), uDesat);',
    '  float ls = 1.0 - smoothstep(0.0, 0.30, lum);',
    '  float lh = smoothstep(0.22, 0.90, lum);',
    '  float lm = max(0.0, 1.0 - ls - lh);',
    '  c *= (uCool * ls + uMid * lm + uWarm * lh) / max(ls + lm + lh, 0.0001);',
    '  c = max(c - uCrush, 0.0) + uLift * (1.0 - clamp(lum * 3.0, 0.0, 1.0));',
    '  c = max((c - 0.18) * uContrast + 0.18, 0.0);',
    /* interlace texture */
    '  if (uScan > 0.0005){',
    '    c *= 1.0 - uScan * (0.5 + 0.5 * sin(gl_FragCoord.y * uScanF));',
    '  }',
    /* procedural glass crack */
    '  if (uCrack > 0.002){',
    '    vec2 cu = 0.5 + vec2((vUv.x - uCrackOrigin.x) * uAspect, vUv.y - uCrackOrigin.y) * uCrackScale;',
    '    float m = texture2D(tCrack, cu).r * uCrack;',
    '    c = mix(c, c * 0.26 + vec3(0.70, 0.79, 0.96) * m, clamp(m, 0.0, 1.0));',
    '  }',
    /* blood veil, strongest at the edges */
    '  if (uVeil > 0.002){',
    '    float e = 0.28 + 0.72 * smoothstep(0.010, 0.235, r2);',
    '    c = mix(c, uVeilCol, clamp(uVeil * e, 0.0, 1.0));',
    '  }',
    /* vignette */
    '  float vg = 1.0 - smoothstep(max(uVigR - uVigS, 0.0), max(uVigR, 0.001), sqrt(r2));',
    '  c *= mix(1.0, vg, uVig);',
    /* flash sits mostly on top of the vignette: a lens flash, not a paint bucket */
    '  if (uFlash > 0.002){ c += uFlashCol * uFlash * (0.35 + 0.65 * vg); }',
    /* global fade */
    '  c *= (1.0 - uFade);',
    '  gl_FragColor = vec4(max(c, 0.0), 1.0);',
    '  #include <tonemapping_fragment>',
    /* r134 calls this chunk <encodings_fragment>; it was renamed
       <colorspace_fragment> in r152. An include three.js cannot resolve THROWS
       inside WebGLProgram, which kills the composite pass on every single frame
       and silently drops the whole grade to the bare-scene fallback. Pick the
       name this build actually has. */
    ((window.THREE && THREE.ShaderChunk && THREE.ShaderChunk.colorspace_fragment)
      ? '  #include <colorspace_fragment>' : '  #include <encodings_fragment>'),
    /* grain / dither AFTER the sRGB encode: kills 8-bit banding in the fog gradient */
    '  float g = fxh(floor(gl_FragCoord.xy * uGrainPx) + vec2(uSeed * 7.13, uSeed * 3.71));',
    '  gl_FragColor.rgb += (g - 0.5) * uGrain * (1.0 - uFade);',
    '  gl_FragColor.a = 1.0;',
    '}'
  ].join('\n');

  var FX_BRIGHT_FRAG = [
    'uniform sampler2D tDiffuse;',
    'uniform vec2 uTexel;',
    'uniform float uThresh;',
    'varying vec2 vUv;',
    'void main(){',
    '  vec3 c  = texture2D(tDiffuse, vUv + vec2( uTexel.x,  uTexel.y)).rgb;',
    '  c += texture2D(tDiffuse, vUv + vec2(-uTexel.x,  uTexel.y)).rgb;',
    '  c += texture2D(tDiffuse, vUv + vec2( uTexel.x, -uTexel.y)).rgb;',
    '  c += texture2D(tDiffuse, vUv + vec2(-uTexel.x, -uTexel.y)).rgb;',
    '  c *= 0.25;',
    '  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));',
    '  float k = max(l - uThresh, 0.0) / max(l, 0.0001);',
    '  gl_FragColor = vec4(min(c * k, vec3(12.0)), 1.0);',
    '}'
  ].join('\n');

  var FX_BLUR_FRAG = [
    'uniform sampler2D tDiffuse;',
    'uniform vec2 uDir;',
    'varying vec2 vUv;',
    'void main(){',
    '  vec3 c  = texture2D(tDiffuse, vUv).rgb * 0.2941;',
    '  c += texture2D(tDiffuse, vUv + uDir).rgb * 0.2353;',
    '  c += texture2D(tDiffuse, vUv - uDir).rgb * 0.2353;',
    '  c += texture2D(tDiffuse, vUv + uDir * 2.4).rgb * 0.1176;',
    '  c += texture2D(tDiffuse, vUv - uDir * 2.4).rgb * 0.1176;',
    '  gl_FragColor = vec4(c, 1.0);',
    '}'
  ].join('\n');

  /* ------------------------------------------------- crack texture (canvas) */

  function FX_drawCrack(ctx, S) {
    var cx = S * 0.5, cy = S * 0.5, R = S * 0.5;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, S, S);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    var arms = 9 + Math.floor(Math.random() * 5);
    var i, s, k;
    var ringPts = [];

    for (i = 0; i < arms; i++) {
      var ang = (i / arms) * Math.PI * 2 + (Math.random() - 0.5) * 0.55;
      var x = cx, y = cy;
      var len = R * (0.42 + Math.random() * 0.52);
      var steps = 8;
      var w0 = 3.4 + Math.random() * 2.4;
      var pts = [];
      for (s = 0; s < steps; s++) {
        ang += (Math.random() - 0.5) * 0.34;
        var seg = len / steps;
        var nx = x + Math.cos(ang) * seg;
        var ny = y + Math.sin(ang) * seg;
        var t = s / steps;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(nx, ny);
        ctx.lineWidth = Math.max(0.6, w0 * (1.0 - t * 0.85));
        ctx.strokeStyle = 'rgba(255,255,255,' + (0.95 - t * 0.45).toFixed(3) + ')';
        ctx.stroke();
        pts.push(nx, ny);
        x = nx; y = ny;
        if (s > 1 && Math.random() < 0.42) {
          var ba = ang + (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 0.7);
          var bx = x, by = y;
          var bw = Math.max(0.5, w0 * 0.45 * (1.0 - t));
          for (k = 0; k < 4; k++) {
            ba += (Math.random() - 0.5) * 0.5;
            var bl = seg * (0.5 + Math.random() * 0.7);
            var mx = bx + Math.cos(ba) * bl;
            var my = by + Math.sin(ba) * bl;
            ctx.beginPath();
            ctx.moveTo(bx, by);
            ctx.lineTo(mx, my);
            ctx.lineWidth = Math.max(0.45, bw * (1 - k / 4));
            ctx.strokeStyle = 'rgba(255,255,255,' + (0.55 - k * 0.09).toFixed(3) + ')';
            ctx.stroke();
            bx = mx; by = my;
          }
        }
      }
      ringPts.push(pts);
    }

    /* concentric hoop fractures joining the radial arms: this is what reads as
       tempered glass rather than a cartoon starburst */
    for (k = 1; k < 7; k += 2) {
      ctx.beginPath();
      var started = false;
      for (i = 0; i <= arms; i++) {
        var p = ringPts[i % arms];
        if (!p || p.length < (k + 1) * 2) { started = false; continue; }
        var px = p[k * 2], py = p[k * 2 + 1];
        if (!started) { ctx.moveTo(px, py); started = true; }
        else { ctx.lineTo(px, py); }
      }
      ctx.lineWidth = 1.1 + Math.random() * 1.1;
      ctx.strokeStyle = 'rgba(255,255,255,0.42)';
      ctx.stroke();
    }

    try {
      var gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, S * 0.075);
      gr.addColorStop(0.0, 'rgba(255,255,255,0.95)');
      gr.addColorStop(0.35, 'rgba(255,255,255,0.42)');
      gr.addColorStop(1.0, 'rgba(255,255,255,0.0)');
      ctx.fillStyle = gr;
      ctx.beginPath();
      ctx.arc(cx, cy, S * 0.075, 0, Math.PI * 2);
      ctx.fill();
    } catch (e) {}

    for (i = 0; i < 14; i++) {
      var a2 = Math.random() * Math.PI * 2;
      var rr = S * (0.03 + Math.random() * 0.11);
      var sx = cx + Math.cos(a2) * rr, sy = cy + Math.sin(a2) * rr;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + Math.cos(a2 + 1.2) * S * 0.03, sy + Math.sin(a2 + 1.2) * S * 0.03);
      ctx.lineWidth = 0.9;
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.stroke();
    }

    try {
      ctx.globalCompositeOperation = 'multiply';
      var vg = ctx.createRadialGradient(cx, cy, R * 0.55, cx, cy, R * 0.99);
      vg.addColorStop(0, '#ffffff');
      vg.addColorStop(1, '#000000');
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, S, S);
    } catch (e2) {}
    ctx.globalCompositeOperation = 'source-over';
  }

  /* ------------------------------------------------------------- DOM layer */

  function FX_makeOverlay(zIndex) {
    var root = null, top = null, bot = null, veil = null;
    try {
      var host = (typeof document !== 'undefined') ? (document.body || document.documentElement) : null;
      if (!host) return { root: null, top: null, bot: null, veil: null };
      root = document.createElement('div');
      root.className = 'fx-overlay';
      root.setAttribute('aria-hidden', 'true');
      root.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;' +
        'pointer-events:none;overflow:hidden;z-index:' + zIndex + ';';

      veil = document.createElement('div');
      veil.className = 'fx-veil';
      veil.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;' +
        'background:rgba(0,0,0,0);display:none;';

      top = document.createElement('div');
      top.className = 'fx-bar fx-bar-top';
      top.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:13%;' +
        'background:#05070a;transform:scaleY(0);transform-origin:50% 0%;will-change:transform;';

      bot = document.createElement('div');
      bot.className = 'fx-bar fx-bar-bot';
      bot.style.cssText = 'position:absolute;left:0;bottom:0;width:100%;height:13%;' +
        'background:#05070a;transform:scaleY(0);transform-origin:50% 100%;will-change:transform;';

      root.appendChild(veil);
      root.appendChild(top);
      root.appendChild(bot);
      host.appendChild(root);
    } catch (e) { root = null; top = null; bot = null; veil = null; }
    return { root: root, top: top, bot: bot, veil: veil };
  }

  /* --------------------------------------------------------------- the stub */

  function FX_stub(renderer) {
    var noop = function () {};
    return {
      render: function (scene, camera) {
        try {
          if (renderer && scene && camera && renderer.render) {
            if (renderer.setRenderTarget) renderer.setRenderTarget(null);
            renderer.render(scene, camera);
          }
        } catch (e) {}
      },
      resize: noop, setQuality: noop, set: noop, flash: noop, hit: noop,
      bloodVeil: noop, crackScreen: noop, clearCrack: noop, fadeTo: noop,
      letterbox: noop, attachRig: noop, shake: noop,
      uniforms: function () { return null; },
      target: function () { return null; },
      quality: function () { return 0; },
      fade: function () { return 0; },
      dispose: noop, isStub: true
    };
  }

  /* ------------------------------------------------------------- the engine */

  function FX_create(renderer, opts) {
    opts = opts || {};
    if (!FX_HAS3D || !renderer || !renderer.setRenderTarget || !renderer.render) {
      return FX_stub(renderer);
    }

    var api = {};
    var quality = FX_clamp(FX_num(opts.quality, 2) | 0, 0, 3);
    var allowBloom = (opts.bloom === undefined) ? true : !!opts.bloom;
    var zIndex = FX_num(opts.zIndex, 30) | 0;

    var rt = null, bA = null, bB = null;
    var lost = false, needRebuild = false, disposed = false;
    var compFails = 0;           /* consecutive composite failures - see api.render */
    var postBroken = false;      /* set once by the driver compile probe; permanent */
    var runtimeBroken = false;   /* set by a repeated runtime failure; cleared on restore */
    var T = 0;
    var rig = null;

    /* =====================================================================
       COLOUR MANAGEMENT CONTRACT -- decided HERE, in this one place, because
       two owners means the darks get sRGB-encoded twice and lift ~19%.

         1. scene -> WebGLRenderTarget is LINEAR radiance, NO tone map, NO
            encode. r134 takes a render-target pass's output encoding from
            rt.texture.encoding (pinned to LinearEncoding in rtOpts) but takes
            its tone mapping straight from renderer.toneMapping -- its program
            parameter is literally `material.toneMapped ? renderer.toneMapping
            : NoToneMapping`, with no render-target exemption (that arrived in
            r152). So renderer.toneMapping MUST be NoToneMapping while post is
            live, or every scene material tone-maps on the way INTO the target
            and the composite tone-maps the result a second time.
         2. composite -> default framebuffer: FX_FRAG applies exposure, ACES and
            the linear->sRGB encode EXACTLY ONCE (fxACES / fxSRGB). A
            ShaderMaterial never receives three's linearToOutputTexel call, so
            renderer.outputEncoding cannot touch this pass -- but it is still
            pinned to LinearEncoding so the emergency direct render in
            api.render's catch cannot silently double-encode.
         3. no composite (quality 0, or the compile probe failed): nothing else
            can do the transform, so three does it -- ACES + sRGB on the
            renderer instead. FX_displayPath() owns the encode half of that
            switch; the tone-map half is settled at boot, below.

       toneMapping is chosen ONCE, at boot, before a single scene material has
       compiled, and never touched again: r134's needsProgramChange does not
       test toneMapping, so a later change is a silent no-op on already-compiled
       materials and a mismatch on newly-created ones. outputEncoding IS tested,
       so flipping it does recompile -- which is why it is flipped only on a
       real, sticky path change and never per frame. */
    var displayExposure = FX_num(opts.exposure, FX_num(renderer.toneMappingExposure, 1.0));
    if (!(displayExposure > 0)) displayExposure = 1.0;
    var ownsColour = (opts.configureRenderer !== false);

    /* who performs the display encode: three (direct) or FX_FRAG (composite) */
    function FX_displayPath(direct) {
      if (!ownsColour) return;
      try {
        if (THREE.LinearEncoding === undefined || THREE.sRGBEncoding === undefined) return;
        var want = direct ? THREE.sRGBEncoding : THREE.LinearEncoding;
        if (renderer.outputEncoding !== want) renderer.outputEncoding = want;
      } catch (e) {}
    }

    try {
      if (ownsColour) {
        if (quality < 1) {
          /* booting with no composite: three has to do the whole transform */
          if (THREE.ACESFilmicToneMapping !== undefined) renderer.toneMapping = THREE.ACESFilmicToneMapping;
        } else if (THREE.NoToneMapping !== undefined) {
          renderer.toneMapping = THREE.NoToneMapping;
        }
        /* the single exposure knob, read by fxACES AND by three on the direct
           path, so both paths expose the frame identically */
        renderer.toneMappingExposure = displayExposure;
      }
    } catch (e) {}

    var fsScene = new THREE.Scene();
    var fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    var quadGeo = new THREE.PlaneGeometry(2, 2, 1, 1);

    /* ---- crack canvas texture (procedural, regenerated on demand) ---- */
    var crackCv = null, crackTex = null, crackLast = -1e9;
    try {
      crackCv = document.createElement('canvas');
      crackCv.width = crackCv.height = 512;
      var cctx = crackCv.getContext('2d');
      if (cctx) {
        cctx.fillStyle = '#000000';
        cctx.fillRect(0, 0, 512, 512);
        crackTex = new THREE.CanvasTexture(crackCv);
        crackTex.encoding = THREE.LinearEncoding;   /* a mask, NOT albedo: never decode it */
        crackTex.generateMipmaps = false;
        crackTex.minFilter = THREE.LinearFilter;
        crackTex.magFilter = THREE.LinearFilter;
        crackTex.wrapS = crackTex.wrapT = THREE.ClampToEdgeWrapping;
        crackTex.needsUpdate = true;
      } else { crackCv = null; }
    } catch (e) { crackCv = null; crackTex = null; }

    var U = {
      tDiffuse:     { value: null },
      tBloom:       { value: null },
      tCrack:       { value: crackTex },
      uTexel:       { value: new THREE.Vector2(1 / 1280, 1 / 720) },
      uCrackOrigin: { value: new THREE.Vector2(0.5, 0.5) },
      uJit:         { value: new THREE.Vector2(0, 0) },
      uLift:        { value: new THREE.Vector3(0.008, 0.013, 0.026) },
      uCool:        { value: new THREE.Vector3(0.84, 0.95, 1.20) },
      uMid:         { value: new THREE.Vector3(0.94, 0.99, 1.06) },
      uWarm:        { value: new THREE.Vector3(1.14, 1.02, 0.88) },
      uVeilCol:     { value: new THREE.Vector3(0.55, 0.030, 0.022) },
      uFlashCol:    { value: new THREE.Vector3(1, 1, 1) },
      uAspect:      { value: 16 / 9 },
      uSeed:        { value: 0 },
      uGrainPx:     { value: 0.667 },
      uGrain:       { value: 0.020 },
      uChroma:      { value: 0.0016 },
      uDistort:     { value: 0.075 },
      uDesat:       { value: 0.24 },
      uContrast:    { value: 1.07 },
      uCrush:       { value: 0.006 },
      uScan:        { value: 0.030 },
      uScanF:       { value: Math.PI },
      uSpeed:       { value: 0.0 },
      uBloom:       { value: 0.0 },
      uVigR:        { value: 0.80 },
      uVigS:        { value: 0.58 },
      uVig:         { value: 0.62 },
      uVeil:        { value: 0.0 },
      uFlash:       { value: 0.0 },
      uCrack:       { value: 0.0 },
      uCrackScale:  { value: 0.55 },
      uFade:        { value: 0.0 },
      uExposure:    { value: displayExposure }
    };

    var P = {
      grain: 0.020, chroma: 0.0016, distort: 0.075, desat: 0.24, contrast: 1.07,
      crush: 0.006, scan: 0.030, speed: 0.0, bloom: 0.55, bloomThreshold: 0.62,
      vigRadius: 0.80, vigSoftness: 0.58, vignette: 0.62, crackScale: 0.55
    };

    var flashV = 0, flashT = 0, flashDur = 0.001, flashPk = 0;
    var veilV = 0, veilT = 0, veilDur = 0.001, veilPk = 0, veilHold = 0;
    var hitV = 0;
    var crackV = 0, crackTarget = 0;
    var fadeV = 0, fadeFrom = 0, fadeToV = 0, fadeT = 0, fadeDur = 0.001;
    var lbV = 0, lbFrom = 0, lbTo = 0, lbT = 0, lbDur = 0.001, lbLastApplied = -1;

    var compMat = new THREE.ShaderMaterial({
      uniforms: U,
      vertexShader: FX_VERT,
      fragmentShader: FX_FRAG,
      depthTest: false, depthWrite: false, transparent: false,
      toneMapped: false           /* FX_FRAG tone-maps itself; three must add NOTHING */
    });

    var brightU = {
      tDiffuse: { value: null },
      uTexel:   { value: new THREE.Vector2(1 / 1280, 1 / 720) },
      uThresh:  { value: 0.62 }
    };
    var brightMat = new THREE.ShaderMaterial({
      uniforms: brightU, vertexShader: FX_VERT, fragmentShader: FX_BRIGHT_FRAG,
      depthTest: false, depthWrite: false, transparent: false, toneMapped: false
    });

    var blurU = { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2(0, 0) } };
    var blurMat = new THREE.ShaderMaterial({
      uniforms: blurU, vertexShader: FX_VERT, fragmentShader: FX_BLUR_FRAG,
      depthTest: false, depthWrite: false, transparent: false, toneMapped: false
    });

    var quad = new THREE.Mesh(quadGeo, compMat);
    quad.frustumCulled = false;
    quad.matrixAutoUpdate = false;   /* identity; the vertex shader ignores it anyway */
    fsScene.add(quad);

    var ov = FX_makeOverlay(zIndex);

    /* One-time driver sanity check: compile our hand-written fragment sources on
       the real context. If a driver rejects one we bypass post instead of showing
       a black screen to a class. Never fails closed on an exception. */
    function fragCompiles(src) {
      try {
        var gl = renderer.getContext ? renderer.getContext() : null;
        if (!gl || !gl.createShader) return true;
        var test =
          '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n' +
          src.split('#include <tonemapping_fragment>').join('')
             .split('#include <colorspace_fragment>').join('')
             .split('#include <encodings_fragment>').join('');
        var sh = gl.createShader(gl.FRAGMENT_SHADER);
        if (!sh) return true;
        gl.shaderSource(sh, test);
        gl.compileShader(sh);
        var ok = !!gl.getShaderParameter(sh, gl.COMPILE_STATUS);
        gl.deleteShader(sh);
        return ok;
      } catch (e) { return true; }
    }
    if (!fragCompiles(FX_FRAG)) { postBroken = true; allowBloom = false; }
    else if (!fragCompiles(FX_BRIGHT_FRAG) || !fragCompiles(FX_BLUR_FRAG)) { allowBloom = false; }

    /* The probe may have just taken the composite away. If so three has to do
       the display transform after all -- and this is still boot, before any
       scene material has compiled, which on r134 is the LAST moment at which
       changing renderer.toneMapping actually changes anything. */
    try {
      if (postBroken && ownsColour && THREE.ACESFilmicToneMapping !== undefined) {
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
      }
    } catch (e) {}
    FX_displayPath(!postOn());

    /* ---- context loss ---- */
    var canvasEl = null;
    function onLost(e) {
      try { if (e && e.preventDefault) e.preventDefault(); } catch (er) {}
      lost = true;
      /* the GPU objects are already gone: drop references, do NOT call dispose() */
      rt = null; bA = null; bB = null;
      U.tDiffuse.value = null; U.tBloom.value = null;
    }
    function onRestored() { lost = false; needRebuild = true; runtimeBroken = false; compFails = 0; }
    try {
      canvasEl = renderer.domElement || null;
      if (canvasEl && canvasEl.addEventListener) {
        canvasEl.addEventListener('webglcontextlost', onLost, false);
        canvasEl.addEventListener('webglcontextrestored', onRestored, false);
      }
    } catch (e) {}

    function postOn() { return quality >= 1 && !postBroken && !runtimeBroken; }
    function bloomOn() { return allowBloom && quality >= 2 && !postBroken && !runtimeBroken; }

    function halfFloatOk() {
      try {
        var caps = renderer.capabilities, ext = renderer.extensions;
        if (!caps || !ext || !ext.has) return false;
        if (caps.isWebGL2) return ext.has('EXT_color_buffer_half_float') || ext.has('EXT_color_buffer_float');
        return ext.has('OES_texture_half_float') && ext.has('EXT_color_buffer_half_float');
      } catch (e) { return false; }
    }

    function rtOpts(depth) {
      return {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: halfFloatOk() ? THREE.HalfFloatType : THREE.UnsignedByteType,
        encoding: THREE.LinearEncoding,   /* MUST stay linear -- and on r134 THIS is the
                                             property that says so; the r152+ spelling that
                                             was here is undefined and did nothing */
        depthBuffer: !!depth,
        stencilBuffer: false,
        generateMipmaps: false,
        samples: 0                        /* never MSAA a render target on this hardware */
      };
    }

    function killTargets() {
      try { if (rt) rt.dispose(); } catch (e) {}
      try { if (bA) bA.dispose(); } catch (e) {}
      try { if (bB) bB.dispose(); } catch (e) {}
      rt = null; bA = null; bB = null;
      U.tDiffuse.value = null; U.tBloom.value = null;
    }

    var lastW = 0, lastH = 0;

    /* returns 0 when the drawing buffer has no usable size yet */
    function bufSize() {
      var w = 0, h = 0;
      try {
        renderer.getDrawingBufferSize(FX_v2);
        w = Math.floor(FX_v2.x); h = Math.floor(FX_v2.y);
      } catch (e) { w = 0; h = 0; }
      if (!(w >= 2 && h >= 2 && isFinite(w) && isFinite(h))) {
        try {
          var cv = renderer.domElement;
          if (cv && cv.width >= 2 && cv.height >= 2) { w = cv.width; h = cv.height; }
        } catch (e2) {}
      }
      if (!(w >= 2 && h >= 2)) return 0;
      lastW = w; lastH = h;
      return 1;
    }

    function ensureTargets() {
      if (needRebuild) { killTargets(); needRebuild = false; }
      if (!bufSize()) return false;
      var w = lastW, h = lastH;

      U.uTexel.value.set(1 / w, 1 / h);
      U.uAspect.value = w / h;
      U.uGrainPx.value = Math.max(0.20, FX_GREF / h);
      brightU.uTexel.value.set(1 / w, 1 / h);
      try {
        var pr = renderer.getPixelRatio ? renderer.getPixelRatio() : 1;
        U.uScanF.value = Math.PI / Math.max(1, Math.round(pr || 1));
      } catch (e) { U.uScanF.value = Math.PI; }

      if (!postOn()) return true;

      if (!rt) {
        try { rt = new THREE.WebGLRenderTarget(w, h, rtOpts(true)); }
        catch (e) { rt = null; return false; }
        try { rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping; } catch (e2) {}
      } else if (rt.width !== w || rt.height !== h) {
        try { rt.setSize(w, h); } catch (e) {}
      }
      U.tDiffuse.value = rt.texture;

      if (bloomOn()) {
        var bw = Math.max(2, w >> 2), bh = Math.max(2, h >> 2);
        if (!bA) {
          try {
            bA = new THREE.WebGLRenderTarget(bw, bh, rtOpts(false));
            bA.texture.wrapS = bA.texture.wrapT = THREE.ClampToEdgeWrapping;
          } catch (e) { bA = null; }
        } else if (bA.width !== bw || bA.height !== bh) { try { bA.setSize(bw, bh); } catch (e) {} }
        if (!bB) {
          try {
            bB = new THREE.WebGLRenderTarget(bw, bh, rtOpts(false));
            bB.texture.wrapS = bB.texture.wrapT = THREE.ClampToEdgeWrapping;
          } catch (e) { bB = null; }
        } else if (bB.width !== bw || bB.height !== bh) { try { bB.setSize(bw, bh); } catch (e) {} }
        U.tBloom.value = (bA && bB) ? bA.texture : rt.texture;
      } else {
        if (bA || bB) {
          try { if (bA) bA.dispose(); } catch (e) {}
          try { if (bB) bB.dispose(); } catch (e) {}
          bA = null; bB = null;
        }
        U.tBloom.value = rt.texture;
      }
      return !!rt;
    }

    /* ------------------------------------------------------------- ticking */

    function tick(dt) {
      T += dt;

      if (flashT > 0) {
        flashT -= dt;
        var kf = flashT > 0 ? (flashT / flashDur) : 0;
        flashV = flashPk * kf * kf;
        if (flashT <= 0) { flashT = 0; flashV = 0; }
      }

      if (veilT > 0) {
        veilT -= dt;
        var el = veilDur - veilT;
        if (el < 0.10) veilV = veilPk * FX_clamp(el / 0.10, 0, 1);
        else if (el < 0.10 + veilHold) veilV = veilPk;
        else {
          var rel = veilDur - (0.10 + veilHold);
          var kk = rel > 0.0001 ? (veilT / rel) : 0;
          veilV = veilPk * FX_clamp(kk, 0, 1);
        }
        if (veilT <= 0) { veilT = 0; veilV = 0; }
      }

      if (hitV > 0.0004) { hitV *= Math.exp(-dt * 9.0); } else { hitV = 0; }

      if (crackV < crackTarget) crackV = Math.min(crackTarget, crackV + dt / 0.06);
      else if (crackV > crackTarget) crackV = Math.max(crackTarget, crackV - dt / 0.35);

      if (fadeT > 0) {
        fadeT -= dt;
        var kd = fadeDur > 0.0001 ? FX_clamp(1 - fadeT / fadeDur, 0, 1) : 1;
        kd = kd * kd * (3 - 2 * kd);
        fadeV = fadeFrom + (fadeToV - fadeFrom) * kd;
        if (fadeT <= 0) { fadeT = 0; fadeV = fadeToV; }
      }

      if (lbT > 0) {
        lbT -= dt;
        var kl = lbDur > 0.0001 ? FX_clamp(1 - lbT / lbDur, 0, 1) : 1;
        kl = kl * kl * (3 - 2 * kl);
        lbV = lbFrom + (lbTo - lbFrom) * kl;
        if (lbT <= 0) { lbT = 0; lbV = lbTo; }
      }
      applyLetterbox();

      /* grain re-seeds at a fixed 24 Hz of WALL TIME: film cadence, and it neither
         crawls nor freezes when the frame rate moves */
      U.uSeed.value = FX_reduced() ? 0 : ((Math.floor(T * 24) % 251) * 1.37);

      /* impact jolt: deterministic CPU jitter at 50 Hz -- whole-frame movement,
         so under reduced motion it is dropped and the else branch below zeroes
         the offset that is already there */
      if (hitV > 0.0004 && !FX_reduced()) {
        var jf = Math.floor(T * 50);
        var amp = 0.030 * Math.min(hitV, 2.0);
        U.uJit.value.set(FX_hash(jf * 2 + 1) * amp, FX_hash(jf * 2 + 77) * amp);
      } else if (U.uJit.value.x !== 0 || U.uJit.value.y !== 0) {
        U.uJit.value.set(0, 0);
      }

      /* the veil breathes: a pulse, not a filter */
      var veilOut = veilV * (0.88 + 0.12 * Math.sin(T * 9.2));

      U.uGrain.value = P.grain + hitV * 0.022;
      U.uChroma.value = P.chroma + hitV * 0.020 + flashV * 0.002;
      U.uDistort.value = P.distort + hitV * 0.35;
      U.uDesat.value = FX_clamp(P.desat + hitV * 0.20, 0, 1);
      U.uContrast.value = P.contrast + hitV * 0.10;
      U.uCrush.value = P.crush;
      U.uScan.value = P.scan;
      U.uSpeed.value = Math.max(0, P.speed + hitV * 0.9);
      U.uVigR.value = P.vigRadius;
      U.uVigS.value = P.vigSoftness;
      U.uVig.value = FX_clamp(P.vignette + hitV * 0.25 + veilOut * 0.20, 0, 1.0);
      U.uVeil.value = FX_clamp(veilOut, 0, 1);
      U.uFlash.value = Math.max(0, flashV);
      U.uCrack.value = FX_clamp(crackV, 0, 1);
      U.uCrackScale.value = P.crackScale;
      U.uFade.value = FX_clamp(fadeV, 0, 1);
      U.uBloom.value = bloomOn() ? Math.max(0, P.bloom) : 0;
      brightU.uThresh.value = P.bloomThreshold;

      /* the DOM veil is the ONLY full-screen alpha layer, and only when post is off */
      if (postOn()) applyDomVeil(0, 0, 0);
      else applyDomVeil(fadeV, flashV, veilOut);
    }

    var lastVeilKey = -1;
    function applyDomVeil(f, fl, ve) {
      if (!ov.veil) return;
      var r = 0, g = 0, b = 0, a = 0, na;
      if (ve > 0.002) { r = 140; g = 12; b = 8; a = FX_clamp(ve * 0.72, 0, 1); }
      if (fl > 0.002) {
        var sa = FX_clamp(fl, 0, 1);
        na = sa + a * (1 - sa);
        if (na > 0.0001) {
          r = (255 * sa + r * a * (1 - sa)) / na;
          g = (255 * sa + g * a * (1 - sa)) / na;
          b = (255 * sa + b * a * (1 - sa)) / na;
        }
        a = na;
      }
      if (f > 0.0005) {
        var fa = FX_clamp(f, 0, 1);
        na = fa + a * (1 - fa);
        if (na > 0.0001) {
          r = (r * a * (1 - fa)) / na;
          g = (g * a * (1 - fa)) / na;
          b = (b * a * (1 - fa)) / na;
        }
        a = na;
      }
      /* quantise and compare as one integer: no string is built unless it changed */
      var ri = r | 0, gi = g | 0, bi = b | 0, ai = a < 0.002 ? 0 : Math.round(a * 255);
      var key = ai === 0 ? 0 : (((ri << 24) | (gi << 16) | (bi << 8) | ai) >>> 0);
      if (key === lastVeilKey) return;
      lastVeilKey = key;
      try {
        if (ai === 0) { ov.veil.style.display = 'none'; }
        else {
          ov.veil.style.background = 'rgba(' + ri + ',' + gi + ',' + bi + ',' + (ai / 255).toFixed(3) + ')';
          ov.veil.style.display = 'block';
        }
      } catch (e) {}
    }

    function applyLetterbox() {
      if (!ov.top || !ov.bot) return;
      var v = FX_clamp(lbV, 0, 1);
      if (Math.abs(v - lbLastApplied) < 0.002) return;
      lbLastApplied = v;
      try {
        var s = 'scaleY(' + v.toFixed(4) + ')';
        ov.top.style.transform = s;
        ov.bot.style.transform = s;
      } catch (e) {}
    }

    /* --------------------------------------------------------------- render */

    api.render = function (scene, camera, dt) {
      if (disposed) return;
      dt = FX_num(dt, 1 / 60);
      if (dt < 0) dt = 0;
      if (dt > 0.25) dt = 0.25;      /* tab-switch guard */
      try { tick(dt); } catch (e) {}

      if (!scene || !camera || lost) return;

      try {
        var direct = !postOn();
        FX_displayPath(direct);   /* hand the sRGB encode to three only when there is no composite */
        if (direct) {
          renderer.setRenderTarget(null);
          renderer.render(scene, camera);
          return;
        }

        /* cheap every frame; only reallocates when the size actually changed */
        if (!rt || needRebuild || !bufSize() || rt.width !== lastW || rt.height !== lastH) {
          if (!ensureTargets() || !rt) {
            renderer.setRenderTarget(null);
            renderer.render(scene, camera);
            return;
          }
        }

        renderer.setRenderTarget(rt);
        renderer.render(scene, camera);   /* linear, un-tone-mapped -- r134 forces NEITHER: it is
                                             rt.texture.encoding + NoToneMapping that make it so */

        if (bloomOn() && bA && bB) {
          brightU.tDiffuse.value = rt.texture;
          quad.material = brightMat;
          renderer.setRenderTarget(bA);
          renderer.render(fsScene, fsCam);

          quad.material = blurMat;
          blurU.tDiffuse.value = bA.texture;
          blurU.uDir.value.set(1.35 / bA.width, 0);
          renderer.setRenderTarget(bB);
          renderer.render(fsScene, fsCam);

          blurU.tDiffuse.value = bB.texture;
          blurU.uDir.value.set(0, 1.35 / bA.height);
          renderer.setRenderTarget(bA);
          renderer.render(fsScene, fsCam);

          U.tBloom.value = bA.texture;
        } else if (!U.tBloom.value) {
          U.tBloom.value = rt.texture;
        }

        U.tDiffuse.value = rt.texture;
        quad.material = compMat;
        renderer.setRenderTarget(null);
        renderer.render(fsScene, fsCam);  /* exposure + ACES + the one sRGB encode: all in FX_FRAG */
        compFails = 0;
      } catch (e) {
        /* never let one bad frame kill the lesson */
        compFails++;
        try {
          quad.material = compMat;
          renderer.setRenderTarget(null);
          renderer.render(scene, camera);
        } catch (e2) { runtimeBroken = true; }
        /* A composite that fails EVERY frame is broken, not unlucky, and the
           emergency frame above is drawn while the renderer is still configured
           for the composite -- so it is the wrong display transform, and it was
           being shown for the rest of the lesson with no way back: runtimeBroken
           was set only if the emergency render ALSO threw. Eight consecutive
           failures now hand the frame permanently to this module's own no-post
           path (the next api.render call puts three back on the display
           transform through FX_displayPath) and give the render targets back
           rather than holding VRAM for a composite that will not run. */
        if (compFails >= 8 && !runtimeBroken) { runtimeBroken = true; killTargets(); }
      }
    };

    /* ---------------------------------------------------------------- api */

    api.resize = function (w, h) {
      if (disposed) return;
      try { ensureTargets(); } catch (e) {}
    };

    api.setQuality = function (q) {
      if (disposed) return;
      q = FX_clamp(FX_num(q, quality) | 0, 0, 3);
      if (q === quality) return;
      quality = q;
      P.bloom = (quality >= 3) ? 0.62 : 0.55;
      lastVeilKey = -1;
      try {
        if (!postOn()) killTargets();
        else ensureTargets();
      } catch (e) {}
    };

    api.quality = function () { return quality; };
    api.fade = function () { return fadeV; };

    function toVec3(target, v) {
      if (v === undefined || v === null || !target) return;
      try {
        if (typeof v === 'number') {
          /* A hex literal is authored in sRGB. r134 has no colour-management
             layer, so setHex ignores that second argument and stores sRGB RAW.
             They have to be decoded by hand or every hex colour reaches the
             linear composite ~2x too bright: the blood flash arrived as washed
             pink instead of deep red. convertSRGBToLinear exists in r134. */
          FX_col.setHex(v | 0);
          if (FX_col.convertSRGBToLinear) FX_col.convertSRGBToLinear();
          target.set(FX_col.r, FX_col.g, FX_col.b);
        } else if (v.isColor) {
          target.set(v.r, v.g, v.b);
        } else if (typeof v === 'string') {
          FX_col.setStyle(v);
          if (FX_col.convertSRGBToLinear) FX_col.convertSRGBToLinear();
          target.set(FX_col.r, FX_col.g, FX_col.b);
        } else if (v.length >= 3) {
          target.set(+v[0], +v[1], +v[2]);
        }
      } catch (e) {}
    }

    api.set = function (p) {
      if (disposed || !p) return;
      try {
        if (p.vignette !== undefined) P.vignette = FX_num(p.vignette, P.vignette);
        if (p.vigStrength !== undefined) P.vignette = FX_num(p.vigStrength, P.vignette);
        if (p.vigRadius !== undefined) P.vigRadius = FX_num(p.vigRadius, P.vigRadius);
        if (p.vigSoftness !== undefined) P.vigSoftness = FX_num(p.vigSoftness, P.vigSoftness);
        if (p.grain !== undefined) P.grain = Math.max(0.004, FX_num(p.grain, P.grain));
        if (p.chroma !== undefined) P.chroma = Math.max(0, FX_num(p.chroma, P.chroma));
        if (p.distort !== undefined) P.distort = FX_num(p.distort, P.distort);
        /* `desat` and `sat` are both the DESATURATION amount (0 = full colour, 1 = grey).
           `saturation` is the inverse, for callers who think in saturation. */
        if (p.desat !== undefined) P.desat = FX_clamp(FX_num(p.desat, P.desat), 0, 1);
        if (p.sat !== undefined) P.desat = FX_clamp(FX_num(p.sat, P.desat), 0, 1);
        if (p.saturation !== undefined) P.desat = FX_clamp(1 - FX_num(p.saturation, 1 - P.desat), 0, 1);
        if (p.contrast !== undefined) P.contrast = Math.max(0, FX_num(p.contrast, P.contrast));
        if (p.crush !== undefined) P.crush = Math.max(0, FX_num(p.crush, P.crush));
        if (p.scan !== undefined) P.scan = FX_clamp(FX_num(p.scan, P.scan), 0, 1);
        if (p.speed !== undefined) P.speed = Math.max(0, FX_num(p.speed, P.speed));
        if (p.bloom !== undefined) P.bloom = Math.max(0, FX_num(p.bloom, P.bloom));
        if (p.bloomThreshold !== undefined) P.bloomThreshold = Math.max(0, FX_num(p.bloomThreshold, P.bloomThreshold));
        if (p.crackScale !== undefined) P.crackScale = Math.max(0.05, FX_num(p.crackScale, P.crackScale));
        if (p.crack !== undefined) crackTarget = FX_clamp(FX_num(p.crack, crackTarget), 0, 1);
        if (p.veil !== undefined) {
          veilPk = FX_clamp(FX_num(p.veil, 0), 0, 1);
          veilV = veilPk; veilT = 0;
        }
        if (p.fade !== undefined) {
          fadeV = FX_clamp(FX_num(p.fade, fadeV), 0, 1);
          fadeT = 0; fadeToV = fadeV; fadeFrom = fadeV;
        }
        toVec3(U.uLift.value, p.lift);
        toVec3(U.uCool.value, p.cool);
        toVec3(U.uMid.value, p.mid);
        toVec3(U.uWarm.value, p.warm);
        toVec3(U.uVeilCol.value, p.veilColor);
      } catch (e) {}
    };

    api.flash = function (colorHex, strength, durationSec) {
      if (disposed) return;
      try {
        toVec3(U.uFlashCol.value, (colorHex === undefined || colorHex === null) ? 0xffffff : colorHex);
        flashPk = FX_clamp(FX_num(strength, 1), 0, 6);
        flashDur = Math.max(0.02, FX_num(durationSec, 0.22));
        flashT = flashDur;
        flashV = flashPk;
      } catch (e) {}
    };

    api.hit = function (strength) {
      if (disposed) return;
      var s = FX_clamp(FX_num(strength, 1), 0, 3);
      if (s > hitV) hitV = s;
      if (rig && rig.shake) { try { rig.shake(s * 0.9, 0.45); } catch (e) {} }
    };

    /* convenience passthrough so the director can shake from the FX handle */
    api.shake = function (strength, durationSec) {
      if (disposed) return;
      if (rig && rig.shake) {
        try { rig.shake(FX_num(strength, 1), FX_num(durationSec, 0.5)); } catch (e) {}
      }
    };

    api.bloodVeil = function (strength, durationSec) {
      if (disposed) return;
      veilPk = FX_clamp(FX_num(strength, 0.6), 0, 1);
      veilDur = Math.max(0.25, FX_num(durationSec, 1.6));
      veilHold = Math.min(Math.min(veilDur * 0.35, 0.6), Math.max(0, veilDur - 0.12));
      veilT = veilDur;
      veilV = 0;
    };

    api.crackScreen = function (originX, originY, strength) {
      if (disposed) return;
      var ox = FX_clamp(FX_num(originX, 0.5), 0, 1);
      var oy = FX_clamp(FX_num(originY, 0.5), 0, 1);
      U.uCrackOrigin.value.set(ox, oy);
      try {
        var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (crackCv && crackTex && (now - crackLast) > 400) {
          crackLast = now;
          var ctx = crackCv.getContext('2d');
          if (ctx) { FX_drawCrack(ctx, crackCv.width); crackTex.needsUpdate = true; }
        }
      } catch (e) {}
      crackTarget = FX_clamp(FX_num(strength, 1), 0, 1);
      if (crackV < 0.15 * crackTarget) crackV = 0.15 * crackTarget;
    };

    api.clearCrack = function (immediate) {
      if (disposed) return;
      crackTarget = 0;
      if (immediate === true) crackV = 0;
    };

    api.fadeTo = function (alpha, durationSec) {
      if (disposed) return;
      fadeFrom = fadeV;
      fadeToV = FX_clamp(FX_num(alpha, 1), 0, 1);
      fadeDur = Math.max(0.001, FX_num(durationSec, 0.5));
      fadeT = fadeDur;
      if (fadeDur <= 0.002) { fadeV = fadeToV; fadeT = 0; }
    };

    api.letterbox = function (amount, durationSec) {
      if (disposed) return;
      lbFrom = lbV;
      lbTo = FX_clamp(FX_num(amount, 0), 0, 1);
      lbDur = Math.max(0.001, FX_num(durationSec, 0.6));
      lbT = lbDur;
      if (lbDur <= 0.002) { lbV = lbTo; lbT = 0; applyLetterbox(); }
    };

    api.attachRig = function (r) { rig = (r && typeof r === 'object') ? r : null; };
    api.uniforms = function () { return U; };
    api.target = function () { return rt; };
    api.isStub = false;

    api.dispose = function () {
      if (disposed) return;
      disposed = true;
      try {
        if (canvasEl && canvasEl.removeEventListener) {
          canvasEl.removeEventListener('webglcontextlost', onLost, false);
          canvasEl.removeEventListener('webglcontextrestored', onRestored, false);
        }
      } catch (e) {}
      killTargets();
      try { fsScene.remove(quad); } catch (e) {}
      try { quadGeo.dispose(); } catch (e) {}
      try { compMat.dispose(); } catch (e) {}
      try { brightMat.dispose(); } catch (e) {}
      try { blurMat.dispose(); } catch (e) {}
      try { if (crackTex) crackTex.dispose(); } catch (e) {}
      try { if (ov.root && ov.root.parentNode) ov.root.parentNode.removeChild(ov.root); } catch (e) {}
      crackCv = null; crackTex = null; rig = null;
      if (FX_last === api) FX_last = null;
    };

    try { ensureTargets(); } catch (e) {}

    FX_last = api;
    return api;
  }

  return {
    create: function (renderer, opts) {
      try { return FX_create(renderer, opts); }
      catch (e) { return FX_stub(renderer); }
    },
    /* module-level convenience helpers, per spec -- forward to the live instance */
    letterbox: function (amount, durationSec) {
      try { if (FX_last && FX_last.letterbox) FX_last.letterbox(amount, durationSec); } catch (e) {}
    },
    fadeTo: function (alpha, durationSec) {
      try { if (FX_last && FX_last.fadeTo) FX_last.fadeTo(alpha, durationSec); } catch (e) {}
    },
    instance: function () { return FX_last; },
    available: FX_HAS3D
  };
})();


/* =========================================================================
   CamRig -- handheld / shake / kick / fov / dutch / breathe
   ========================================================================= */

var CamRig = (function () {

  var CR_HAS3D = (typeof THREE !== 'undefined' && !!THREE.Vector3 &&
                  !!THREE.Quaternion && !!THREE.Matrix4 && !!THREE.Euler);

  /* module-scope scratch -- nothing is allocated per frame */
  var CR_pos  = CR_HAS3D ? new THREE.Vector3() : null;
  var CR_look = CR_HAS3D ? new THREE.Vector3() : null;
  var CR_off  = CR_HAS3D ? new THREE.Vector3() : null;
  var CR_up   = CR_HAS3D ? new THREE.Vector3(0, 1, 0) : null;
  var CR_m4   = CR_HAS3D ? new THREE.Matrix4() : null;
  var CR_q1   = CR_HAS3D ? new THREE.Quaternion() : null;
  var CR_q2   = CR_HAS3D ? new THREE.Quaternion() : null;
  var CR_eul  = CR_HAS3D ? new THREE.Euler(0, 0, 0, 'YXZ') : null;
  var CR_tmp  = CR_HAS3D ? new THREE.Vector3() : null;

  var CR_imul = Math.imul || function (a, b) {
    var ah = (a >>> 16) & 0xffff, al = a & 0xffff;
    var bh = (b >>> 16) & 0xffff, bl = b & 0xffff;
    return ((al * bl) + (((ah * bl + al * bh) << 16) >>> 0)) | 0;
  };

  function CR_h(n) {
    n = n | 0;
    n = (n << 13) ^ n;
    var m = CR_imul(n, CR_imul(CR_imul(n, n), 15731) + 789221);
    m = (m + 1376312589) & 0x7fffffff;
    return 1.0 - m / 1073741824.0;
  }

  /* smooth value noise, continuous in TIME: the shake is identical at 30, 60 and
     144 fps and never strobes the way Math.random()-per-frame does */
  function CR_vn(x, seed) {
    var i = Math.floor(x), f = x - i;
    var u = f * f * (3 - 2 * f);
    var a = CR_h((i + seed * 1013) | 0);
    var b = CR_h((i + 1 + seed * 1013) | 0);
    return a + (b - a) * u;
  }

  function CR_fbm(t, seed) {
    return CR_vn(t, seed) * 0.62 +
           CR_vn(t * 2.17 + 13.7, seed + 31) * 0.27 +
           CR_vn(t * 4.53 + 7.3, seed + 61) * 0.11;
  }

  function CR_num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function CR_clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function CR_fin(v) { return !!v && isFinite(v.x) && isFinite(v.y) && isFinite(v.z); }

  function CR_stub() {
    var noop = function () {};
    return {
      update: noop, setBase: noop, handheld: noop, shake: noop, kick: noop,
      setFov: noop, setBaseFov: noop, dutch: noop, breathe: noop,
      lookAtSmooth: noop, snap: noop, dispose: noop,
      fov: function () { return 62; }, camera: null, isStub: true
    };
  }

  function CR_create(camera) {
    if (!CR_HAS3D || !camera || !camera.isCamera) return CR_stub();

    var api = {};
    var T = 0, disposed = false;

    var baseP = new THREE.Vector3().copy(camera.position);
    var baseL = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).add(camera.position);
    var lookGoal = new THREE.Vector3().copy(baseL);   /* where we are asked to look */
    var lookT = new THREE.Vector3().copy(baseL);      /* where we are actually looking */
    var lookTau = 0;                                  /* 0 = snap to goal */
    var dP = new THREE.Vector3();                     /* instance scratch */

    var hh = 0, hhTarget = 0;
    var br = 0, brTarget = 0;

    var shakeAmp = 0, shakeT = 0, shakeDur = 0.001;

    var kickX = 0, kickY = 0, kickZ = 0;
    var kvX = 0, kvY = 0, kvZ = 0;
    var KICK_K = 88, KICK_C = 11.5;   /* w0 ~ 9.4 rad/s, zeta ~ 0.61: one hard punch, one soft return */
    var KICK_V = 2.2;                 /* strength -> velocity; peak offset ~0.23 m at strength 1 */
    var KICK_MAX = 0.85;              /* metres: the camera never leaves the cab */

    var fovCur = CR_num(camera.fov, 62), fovTarget = fovCur, fovTau = 0.25;
    /* The rig writes camera.fov only once it has actually been asked to.
       Both worlds run their own speed-driven, aspect-corrected FOV every
       frame; a rig that was never given a FOV instruction must not overwrite
       theirs (setBaseFov's own comment: 'so the layout code and the rig never
       fight over camera.fov'). */
    var fovOwned = false;
    var rollCur = 0, rollTarget = 0, rollTau = 0.6;

    var pOffX = 0, pOffY = 0, pOffZ = 0;
    var rOffX = 0, rOffY = 0, rOffZ = 0;

    var isPersp = !!camera.isPerspectiveCamera;

    api.setBase = function (posVec3, lookVec3) {
      if (disposed) return;
      try {
        if (CR_fin(posVec3)) {
          if (!CR_fin(lookVec3)) {
            /* no aim given: carry the aim with the body so the view direction holds */
            dP.set(posVec3.x - baseP.x, posVec3.y - baseP.y, posVec3.z - baseP.z);
            baseL.add(dP); lookGoal.add(dP); lookT.add(dP);
          }
          baseP.set(posVec3.x, posVec3.y, posVec3.z);
        }
        if (CR_fin(lookVec3)) {
          baseL.set(lookVec3.x, lookVec3.y, lookVec3.z);
          lookGoal.copy(baseL);
          lookT.copy(baseL);
          lookTau = 0;
        }
      } catch (e) {}
    };

    /* `weight` keeps its old meaning (a per-60fps-frame lerp factor) but is
       converted to a time constant, so aim damping is identical at any frame rate */
    api.lookAtSmooth = function (v, weight) {
      if (disposed || !CR_fin(v)) return;
      var w = CR_clamp(CR_num(weight, 0.15), 0.0005, 1);
      try {
        lookGoal.set(v.x, v.y, v.z);
        if (w >= 0.999) { lookTau = 0; }
        else {
          lookTau = -1 / (60 * Math.log(1 - w));
          if (!isFinite(lookTau) || lookTau < 0) lookTau = 0;
        }
      } catch (e) {}
    };

    api.handheld = function (amount) {
      if (disposed) return;
      hhTarget = CR_clamp(CR_num(amount, 0), 0, 3);
    };

    api.breathe = function (amount) {
      if (disposed) return;
      brTarget = CR_clamp(CR_num(amount, 0), 0, 3);
    };

    api.shake = function (strength, durationSec) {
      if (disposed) return;
      var s = CR_clamp(CR_num(strength, 1), 0, 6);
      var d = Math.max(0.05, CR_num(durationSec, 0.5));
      var cur = (shakeT > 0 && shakeDur > 0) ? shakeAmp * (shakeT / shakeDur) : 0;
      if (s >= cur) { shakeAmp = s; shakeDur = d; shakeT = d; }
      else { shakeT = Math.max(shakeT, Math.min(d * 0.6, shakeDur)); }
    };

    api.kick = function (dirVec3, strength) {
      if (disposed) return;
      var s = CR_clamp(CR_num(strength, 1), 0, 6);
      var dx = 0, dy = 0, dz = 0;
      if (CR_fin(dirVec3)) { dx = dirVec3.x; dy = dirVec3.y; dz = dirVec3.z; }
      var L = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (L < 1e-6) { dx = 0; dy = 0; dz = 1; L = 1; }
      dx /= L; dy /= L; dz /= L;
      kvX += dx * s * KICK_V;
      kvY += dy * s * KICK_V;
      kvZ += dz * s * KICK_V;
    };

    api.setFov = function (f, smoothSec) {
      if (disposed) return;
      fovTarget = CR_clamp(CR_num(f, fovTarget), 30, 110);
      fovOwned = true;
      fovTau = CR_num(smoothSec, 0.35);
      if (!(fovTau > 0.001)) {
        fovTau = 0.001;
        fovCur = fovTarget;
        if (isPersp) {
          camera.fov = fovCur;
          try { camera.updateProjectionMatrix(); } catch (e) {}
        }
      }
    };

    /* snap the FOV with no easing: call this from the resize / aspect-lock handler
       so the layout code and the rig never fight over camera.fov */
    api.setBaseFov = function (f) {
      if (disposed) return;
      fovOwned = true;
      fovTarget = fovCur = CR_clamp(CR_num(f, fovCur), 30, 110);
      if (isPersp) {
        camera.fov = fovCur;
        try { camera.updateProjectionMatrix(); } catch (e) {}
      }
    };

    api.fov = function () { return fovCur; };

    api.dutch = function (angleRad, smoothSec) {
      if (disposed) return;
      rollTarget = CR_clamp(CR_num(angleRad, 0), -0.9, 0.9);
      rollTau = Math.max(0.001, CR_num(smoothSec, 0.8));
    };

    api.snap = function () {
      if (disposed) return;
      hh = hhTarget; br = brTarget;
      shakeAmp = 0; shakeT = 0;
      kickX = kickY = kickZ = kvX = kvY = kvZ = 0;
      fovCur = fovTarget; rollCur = rollTarget;
      lookT.copy(lookGoal);
    };

    api.update = function (dt) {
      if (disposed) return;
      dt = CR_num(dt, 1 / 60);
      if (dt < 0) dt = 0;
      if (dt > 0.1) dt = 0.1;      /* a 3 s dt after a tab switch must not teleport the camera */
      T += dt;

      var kA = 1 - Math.exp(-dt / 0.30);
      hh += (hhTarget - hh) * kA;
      br += (brTarget - br) * kA;
      if (Math.abs(hh - hhTarget) < 0.0006) hh = hhTarget;
      if (Math.abs(br - brTarget) < 0.0006) br = brTarget;

      if (lookTau > 0) {
        var kL = 1 - Math.exp(-dt / lookTau);
        lookT.x += (lookGoal.x - lookT.x) * kL;
        lookT.y += (lookGoal.y - lookT.y) * kL;
        lookT.z += (lookGoal.z - lookT.z) * kL;
      } else {
        lookT.copy(lookGoal);
      }

      pOffX = 0; pOffY = 0; pOffZ = 0;
      rOffX = 0; rOffY = 0; rOffZ = 0;

      /* handheld: an operator's hands. small translation, larger rotation, all on
         incommensurate rates so the pattern never loops in a 7-minute lesson */
      if (hh > 0.0005) {
        var th = T * 1.35;
        pOffX += CR_fbm(th, 1) * 0.016 * hh;
        pOffY += CR_fbm(th + 5.1, 2) * 0.013 * hh;
        pOffZ += CR_fbm(th + 11.3, 3) * 0.010 * hh;
        rOffX += CR_fbm(T * 1.05 + 2.2, 4) * 0.0046 * hh;
        rOffY += CR_fbm(T * 0.92 + 17.4, 5) * 0.0058 * hh;
        rOffZ += CR_fbm(T * 0.63 + 31.7, 6) * 0.0040 * hh;
        /* an occasional faster twitch: the operator catching the frame */
        var tw = CR_fbm(T * 0.37 + 47.1, 7);
        if (tw > 0.62) {
          var tk = (tw - 0.62) * 2.6 * hh;
          rOffY += CR_fbm(T * 8.3, 8) * 0.0060 * tk;
          rOffX += CR_fbm(T * 7.1 + 3.0, 9) * 0.0045 * tk;
        }
      }

      /* breathe: slow drift plus the chest itself, so a locked-off shot is never dead */
      if (br > 0.0005) {
        var tb = T * 0.17;
        pOffX += CR_fbm(tb, 11) * 0.038 * br;
        pOffY += CR_fbm(tb + 8.9, 12) * 0.030 * br;
        pOffZ += CR_fbm(tb + 21.5, 13) * 0.024 * br;
        pOffY += Math.sin(T * 1.02) * 0.0065 * br;
        rOffX += CR_fbm(T * 0.13 + 3.3, 14) * 0.0030 * br;
        rOffY += CR_fbm(T * 0.11 + 9.7, 15) * 0.0035 * br;
      }

      /* impulse shake: quadratic decay, layered noise, returns to exactly zero */
      if (shakeT > 0) {
        shakeT -= dt;
        if (shakeT <= 0) { shakeT = 0; shakeAmp = 0; }
        else {
          var env = shakeT / shakeDur;
          env = env * env;
          var a = shakeAmp * env;
          var ts = T * 23.0;
          pOffX += CR_fbm(ts, 21) * 0.085 * a;
          pOffY += CR_fbm(ts + 4.7, 22) * 0.075 * a;
          pOffZ += CR_fbm(ts + 9.4, 23) * 0.055 * a;
          rOffX += CR_fbm(T * 19.0 + 1.1, 24) * 0.019 * a;
          rOffY += CR_fbm(T * 21.5 + 6.6, 25) * 0.022 * a;
          rOffZ += CR_fbm(T * 14.5 + 12.2, 26) * 0.026 * a;
        }
      }

      /* directional kick: a real damped spring integrated at a fixed 120 Hz, so it
         behaves identically at any frame rate */
      if (kickX !== 0 || kickY !== 0 || kickZ !== 0 || kvX !== 0 || kvY !== 0 || kvZ !== 0) {
        var rem = dt, hstep;
        while (rem > 0) {
          hstep = rem > 0.008333 ? 0.008333 : rem;
          rem -= hstep;
          kvX += (-KICK_K * kickX - KICK_C * kvX) * hstep;
          kvY += (-KICK_K * kickY - KICK_C * kvY) * hstep;
          kvZ += (-KICK_K * kickZ - KICK_C * kvZ) * hstep;
          kickX += kvX * hstep; kickY += kvY * hstep; kickZ += kvZ * hstep;
        }
        var klen = Math.sqrt(kickX * kickX + kickY * kickY + kickZ * kickZ);
        if (klen > KICK_MAX) {
          var kfac = KICK_MAX / klen;
          kickX *= kfac; kickY *= kfac; kickZ *= kfac;
        }
        if (Math.abs(kickX) < 1e-5 && Math.abs(kvX) < 1e-4) { kickX = 0; kvX = 0; }
        if (Math.abs(kickY) < 1e-5 && Math.abs(kvY) < 1e-4) { kickY = 0; kvY = 0; }
        if (Math.abs(kickZ) < 1e-5 && Math.abs(kvZ) < 1e-4) { kickZ = 0; kvZ = 0; }
        if (!isFinite(kickX) || !isFinite(kickY) || !isFinite(kickZ) ||
            !isFinite(kvX) || !isFinite(kvY) || !isFinite(kvZ)) {
          kickX = kickY = kickZ = kvX = kvY = kvZ = 0;
        }
        pOffX += kickX; pOffY += kickY; pOffZ += kickZ;
        rOffX += kickY * 0.09;
        rOffY += kickX * 0.09;
        rOffZ += kickX * 0.05;
      }

      if (isPersp && fovOwned) {
        var kF = 1 - Math.exp(-dt / Math.max(0.001, fovTau));
        fovCur += (fovTarget - fovCur) * kF;
        if (Math.abs(fovCur - fovTarget) < 0.004) fovCur = fovTarget;
        if (isFinite(fovCur) && Math.abs(camera.fov - fovCur) > 0.002) {
          camera.fov = fovCur;
          try { camera.updateProjectionMatrix(); } catch (e) {}
        }
      }
      var kR = 1 - Math.exp(-dt / Math.max(0.001, rollTau));
      rollCur += (rollTarget - rollCur) * kR;
      if (Math.abs(rollCur - rollTarget) < 0.00015) rollCur = rollTarget;

      if (!CR_fin(baseP) || !CR_fin(lookT)) return;

      CR_off.set(pOffX, pOffY, pOffZ);
      CR_pos.copy(baseP).add(CR_off);
      CR_look.copy(lookT).add(CR_off);

      CR_tmp.subVectors(CR_look, CR_pos);
      if (CR_tmp.lengthSq() < 1e-8) CR_look.set(CR_pos.x, CR_pos.y, CR_pos.z - 1);

      var up = (camera.up && isFinite(camera.up.x) && camera.up.lengthSq() > 1e-8) ? camera.up : CR_up;
      CR_m4.lookAt(CR_pos, CR_look, up);
      CR_q1.setFromRotationMatrix(CR_m4);

      if (rOffX !== 0 || rOffY !== 0 || rOffZ !== 0 || rollCur !== 0) {
        CR_eul.set(rOffX, rOffY, rOffZ + rollCur, 'YXZ');
        CR_q2.setFromEuler(CR_eul);
        CR_q1.multiply(CR_q2);   /* local space: roll about the view axis, which is what dutch means */
      }

      if (!CR_fin(CR_pos) || !isFinite(CR_q1.x) || !isFinite(CR_q1.y) ||
          !isFinite(CR_q1.z) || !isFinite(CR_q1.w)) return;

      camera.position.copy(CR_pos);
      camera.quaternion.copy(CR_q1);
      camera.updateMatrixWorld(true);
    };

    api.dispose = function () { disposed = true; };
    api.isStub = false;
    api.camera = camera;
    return api;
  }

  return {
    create: function (camera) {
      try { return CR_create(camera); }
      catch (e) { return CR_stub(); }
    },
    available: CR_HAS3D
  };
})();