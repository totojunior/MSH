/* ------------------------------------------------------------- Director
   The beat machine. Owns the render loop, the world lifecycle, the timeline
   and every hand-off between modules.
   ---------------------------------------------------------------------- */
var Director = (function () {

  var S = {
    role: null,            // 'student' | 'projector'
    beat: 'boot',
    beatT: 0,              // seconds since the beat began
    running: false,
    world: null,           // active world controller
    worldKind: null,       // 'A' | 'B' | null
    fx: null, cam: null, renderer: null,
    choices: { a: null, b: null },
    auto: { a: false, b: false },   // true when the countdown chose, not the student
    tension: 0,
    speed: 0,
    quality: 3,
    webgl: true,
    fired: {},             // per-beat one-shot flags
    lastFrame: 0,
    rafId: 0,
    contextLost: false     // true between webglcontextlost and webglcontextrestored
  };

  var TT = (window.SCRIPT && SCRIPT.timing) || {};
  function T(k, d) { return (typeof TT[k] === 'number') ? TT[k] / 1000 : d; }

  /* The HUD is lesson copy, not director invention: the speedometer, its unit
     and the two line labels all come out of SCRIPT.*.hud, which nothing read
     before. Cached once; hud() reuses ONE object so the per-frame HUD call
     allocates nothing. */
  var HA = (window.SCRIPT && SCRIPT.sceneA && SCRIPT.sceneA.hud) || {};
  var HB = (window.SCRIPT && SCRIPT.sceneB && SCRIPT.sceneB.hud) || {};
  var HA_SPEED = (+HA.speed) || 60;
  var HUDO = { speed: 60, unit: '', phase: '', warn: null };
  function hud(speed, unit, phase, warn) {
    HUDO.speed = (typeof speed === 'number' && isFinite(speed)) ? speed : null;
    HUDO.unit = unit || '';
    HUDO.phase = phase || '';
    HUDO.warn = warn || null;
    safe(function () { UI.hud(HUDO); });
  }
  function hudOff() { safe(function () { UI.hud(null); }); }

  /* ---------------------------------------------------------- utilities */
  function warn(e) { if (window.console && console.warn) console.warn('[trolley]', e); }
  function safe(fn) { try { return fn(); } catch (e) { warn(e); return null; } }
  function once(key, fn) { if (!S.fired[key]) { S.fired[key] = 1; safe(fn); } }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  /* Wall clock in ms, for throttling DOM repaints. Deliberately NOT beat time:
     it measures how often a rebuild hits the document, not how far the film has
     travelled, and it must keep working while the frame loop is hand stepped. */
  function msNow() {
    try { return (window.performance && performance.now) ? performance.now() : Date.now(); }
    catch (e) { return Date.now(); }
  }

  /* ------------------------------------------- teacher-beat tally repaint
     The class tally is kept rendered BEHIND the teacher console so SHOW THE
     CLASS is an instant cut rather than a rebuild in front of the room. But
     UI.tally() clears and rebuilds its whole subtree AND speaks into the live
     region, and a held stepper emits about nine changes a second (the console
     repeats at 110 ms), so painting it on every emit is nine full rebuilds and
     nine announcements per second on a 2019 Chromebook.
     So: LEADING EDGE, then coalesced. The first change repaints at once (a
     single setManual from anywhere is visible with no timer in the way);
     changes inside the window only raise a dirty flag, and a real setTimeout
     -- not the frame loop -- guarantees the final state lands even if rAF is
     throttled, the tab is backgrounded or the loop is being hand stepped. The
     beat's update() is a second, free safety net.
     The four console cards always repaint synchronously; nothing the teacher
     is looking at ever waits for this. */
  var TALLY_MS = 500;
  var tallyDirty = 0, tallyAt = -1e9, tallyT = 0;
  function tallyStop() {
    try { if (tallyT) clearTimeout(tallyT); } catch (e) {}
    tallyT = 0; tallyDirty = 0;
  }
  function tallyPaint() {
    tallyStop();
    tallyAt = msNow();
    var c = Poll.counts();
    safe(function () { UI.tally(c, { live: c.live, total: c.total }); });
    safe(function () { UI.setLive(c.live); });
  }
  function tallyBump() {
    /* the reveal beat owns the tally once we have left, and it renders it with
       the student's own answer marked; never fight it */
    if (S.beat !== 'teacher') { tallyStop(); return; }
    var since = msNow() - tallyAt;
    if (since >= TALLY_MS) { tallyPaint(); return; }
    tallyDirty = 1;
    if (tallyT) return;
    try {
      tallyT = setTimeout(function () {
        tallyT = 0;
        if (S.beat === 'teacher' && tallyDirty) tallyPaint(); else tallyDirty = 0;
      }, (TALLY_MS - since) + 16);
    } catch (e) { tallyT = 0; }
  }

  /* prefers-reduced-motion. Cached and kept live by a change listener, the way
     mod-ui.js already does it: tick() reads this every frame and matchMedia()
     .matches is not free. Live, not read once, because a student can turn it on
     from the Chromebook's accessibility settings in the middle of the lesson
     and the camera has to stop drifting there and then. */
  var _rm = false;
  (function () {
    try {
      if (!window.matchMedia) return;
      var mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      _rm = !!mq.matches;
      var h = function () { try { _rm = !!mq.matches; } catch (e) {} };
      if (mq.addEventListener) mq.addEventListener('change', h);
      else if (mq.addListener) mq.addListener(h);
    } catch (e) { _rm = false; }
  })();
  function reduced() { return _rm; }

  /* BEAT-SCOPED TIMERS.
     Every call in this file goes through safe(), so a setTimeout that fires
     after the film has already moved on does not throw -- it quietly acts on
     the wrong beat, or on a world mountWorld has since disposed, and the
     console never says a word. That silence is exactly why these survive.
     later() stamps the callback with the beat epoch at SCHEDULE time and drops
     it if the epoch moved; go() cancels whatever is still outstanding. */
  var beatEpoch = 0, timers = [];
  function later(ms, fn) {
    var ep = beatEpoch;
    var id = setTimeout(function () {
      var j = timers.indexOf(id);
      if (j >= 0) timers.splice(j, 1);
      if (ep !== beatEpoch) return;         /* stale: the beat moved on */
      safe(fn);
    }, ms);
    timers.push(id);
    return id;
  }
  function clearBeatTimers() {
    for (var i = 0; i < timers.length; i++) { try { clearTimeout(timers[i]); } catch (e) {} }
    timers.length = 0;
  }

  /* Scene B hesitation / push-attempt state, reset on entering b_choice. */
  var pushPeak = 0, pushMoved = false, hesT = -1, hesSaid = 0;

  /* ------------------------------------------------------------- SKIP
     Narration beats a reader can outrun. Console-game rule: the first press
     finishes the line that is still typing, the next one moves the film on.
     Deliberately a map of explicit destinations rather than "shove beatT past
     the threshold" — jumping the clock would fire every remaining runLines()
     entry at once and flash four subtitles in a frame.
     Beats that are NOT here are the ones where a stray click must never cost
     the student their answer: boot, a_brake, a_choice, b_choice, both
     impacts, submit, and every screen that already has its own buttons. */
  var SKIP_NEXT = {
    cold:       'a_approach',
    a_approach: 'a_brake',
    a_side:     'a_choice',
    a_verdict:  'b_intro',
    b_intro:    'b_approach',
    b_approach: 'b_choice',
    b_verdict:  'submit'
  };
  /* Buttons for a screen the film has finished with. The console button is
     projector-only: a student must not be able to open the console and wipe
     the class tally from their own Chromebook. PLAY AGAIN is for everyone —
     the teacher runs this once per class, and a student may want a second go
     once they have seen what the first one cost. */
  function backActions(withReplay) {
    var out = [];
    if (withReplay) {
      out.push({
        label: 'PLAY AGAIN', ko: '다시 하기', primary: true,
        onClick: function () { resetRun(); go('cold'); }
      });
    }
    if (S.role === 'projector') {
      out.push({
        label: '◀ TEACHER CONSOLE', ko: '◀ 교사 콘솔',
        onClick: function () { go('teacher'); }
      });
    }
    return out;
  }

  /* ------------------------------------------------- THE COLLISION BEAT
     Shared by both impacts, because both were wrong in the same way.

     Before: the picture cut to black 620 ms after the crash, and the silence,
     the settling bodies, the dust and the world's own aftermath() all played
     BEHIND that black screen. Lengthening the dead air did nothing, because
     dead air over a black screen is just a gap — the room has nothing to look
     at while it lasts. Then the mix came back a full second before the
     verdict, so the silence did not even lead anywhere.

     Now the sound dies FIRST and the picture stays up: the class watches the
     wreck in the quiet, which is the only arrangement in which a cut to
     silence means anything. The fade comes after, slow, and the dead air runs
     under it right up to the verdict card.

       0.00  crash: audio, ragdoll, camera kick, red flash
       0.35  the mix is cut — while the wreck is still on screen
       0.36  aftermath(): dust, settling, the trolley grinding to a halt
       1.70  slow fade to black (0.55 s), silence continuing
       3.90  verdict, mix restored just in time for its stinger        */
  var impactEndsAt = 0;          /* beat seconds at which the verdict may land */
  function impactRhythm(offsetMs) {
    offsetMs = offsetMs || 0;
    impactEndsAt = (offsetMs / 1000) + T('impactAfterHoldMs', 3.9);
    later(offsetMs + T('impactSilenceAtMs', 0.35) * 1000, function () {
      safe(function () { SFX.silence(T('silenceMs', 2.6) * 1000); });
      /* WorldB self-triggers aftermath() on its own phase hook; WorldA has no
         phase hook, so nothing ever called it. It must land AFTER the
         collision: impact() only starts a 0.16-0.5 s closing rush and the
         wreck (doContact) fires at the end of it -- calling aftermath any
         earlier would raise the dust before the trolley arrived. */
      safe(function () { if (S.world && S.world.aftermath) S.world.aftermath(); });
    });
    later(offsetMs + T('impactHoldVisibleMs', 1.7) * 1000, function () {
      safe(function () { if (S.fx) S.fx.fadeTo(1, T('impactFadeMs', 0.55)); });
    });
  }

  function skippable() { return !!SKIP_NEXT[S.beat]; }
  function skip() {
    if (!skippable()) return false;
    var r = safe(function () { return UI.subtitleSkip ? UI.subtitleSkip() : 'none'; });
    if (r === 'completed') return true;    /* first press: finish the line */
    go(SKIP_NEXT[S.beat]);
    return true;
  }

  /* KEYBOARD: focus must never be stranded on a control the outgoing screen
     just took out of the layout -- Tab would restart at the top of the
     document and the lesson would be unusable without a mouse. UI.screen()
     sets .inert on the outgoing section, but inert is not supported by every
     Chromebook still in service, so this is the fallback. It is a RESCUE
     only: if focus is still on something visible it is left strictly alone. */
  function shown(n) {
    try { return !!(n && n.getClientRects && n.getClientRects().length); } catch (e) { return false; }
  }
  function focusRescue() {
    try {
      var a = document.activeElement;
      if (a && a !== document.body && shown(a) && !a.disabled) return;   /* never steal focus */
      if (a && a !== document.body && a.blur) a.blur();
      var name = (UI.currentScreen && UI.currentScreen()) || '';
      var scr = name ? document.getElementById('scr-' + name) : null;
      if (!shown(scr)) return;              /* a full-bleed cinematic screen: nothing to focus */
      var list = scr.querySelectorAll('button,[href],input,select,textarea,[tabindex]');
      for (var i = 0; i < list.length; i++) {
        var n = list[i];
        if (n.disabled || n.getAttribute('tabindex') === '-1' || !shown(n)) continue;
        try { n.focus({ preventScroll: true }); } catch (e2) { try { n.focus(); } catch (e3) {} }
        return;
      }
    } catch (e) {}
  }

  /* Fire timed narration lines for the current beat. */
  /* tSec is optional and defaults to the beat clock. SCRIPT.sceneB.hesitateLines
     are timed from the moment hesitation is DETECTED, not from beat start, so
     they need their own clock -- feeding them beat-elapsed time would fire all
     three at once. */
  function runLines(list, key, tSec) {
    if (!list) return;
    var t = (typeof tSec === 'number' && isFinite(tSec)) ? tSec : S.beatT;
    for (var i = 0; i < list.length; i++) {
      var ln = list[i];
      if (!ln) continue;
      if (t >= ln.t && !S.fired[key + i]) {
        S.fired[key + i] = 1;
        (function (l) { safe(function () { UI.subtitle(l.text, (l.hold > 0 ? l.hold : 2.6) * 1000); }); })(ln);
      }
    }
  }

  /* ------------------------------------------------------ world plumbing */
  /* three allocates a WebGLRenderTarget for every shadow-casting light the
     first time it renders one, and hands it to light.shadow.map. NEITHER world
     disposes it: WorldA.dispose() sweeps only the geometry / material / texture
     lists it registered itself and WorldB.dispose() only its own store, so
     swapping A for B orphaned a depth target (512 x 512, or 1024 x 1024 on the
     top quality rung -- mod-worldA turns key.castShadow on at q >= 2 and
     disposes shadow.map ONLY on a quality change) that no traversal will ever
     reach again. Sweep the graph BEFORE the world empties scene.children. */
  function releaseSceneGpu(w) {
    var sc = w && w.scene;
    if (!sc || !sc.traverse) return;
    sc.traverse(function (o) {
      try {
        if (o && o.isLight && o.shadow) {
          if (o.shadow.dispose) o.shadow.dispose();   /* r134: disposes map + mapPass */
          o.shadow.map = null;
          o.shadow.mapPass = null;
        }
      } catch (e) {}
    });
    try { if (sc.background && sc.background.dispose) sc.background.dispose(); } catch (e) {}
    try { if (sc.environment && sc.environment.dispose) sc.environment.dispose(); } catch (e) {}
  }

  function disposeWorld() {
    if (S.cam) { safe(function () { S.cam.dispose(); }); S.cam = null; }
    if (S.world) {
      safe(function () { releaseSceneGpu(S.world); });
      safe(function () { S.world.dispose(); });
    }
    S.world = null; S.worldKind = null;
    /* The render lists still hold a RenderItem for every object in the scene we
       just threw away. They are keyed by that scene in a WeakMap, so they go
       eventually, but not before the second world has built its own. */
    safe(function () {
      if (S.renderer && S.renderer.renderLists && S.renderer.renderLists.dispose) {
        S.renderer.renderLists.dispose();
      }
    });
  }

  function mountWorld(kind) {
    if (S.worldKind === kind) return S.world;
    disposeWorld();
    if (!S.webgl) return null;
    var w = safe(function () {
      return kind === 'A' ? WorldA.build(S.renderer) : WorldB.build(S.renderer);
    });
    if (!w) { return null; }
    S.world = w; S.worldKind = kind;
    safe(function () { if (w.setQuality) w.setQuality(S.quality); });
    safe(function () {
      S.cam = CamRig.create(w.camera);
      /* CamRig writes camera.position AND camera.quaternion every frame, from
         its own base pose, and it runs AFTER world.update. WorldB drives
         camRoot (the parent) so the two compose; WorldA drives the camera
         itself, so without this hand-off the rig silently erased WorldA's
         impact kick and aftermath drift every frame. */
      if (S.cam && !S.cam.isStub && w.setCameraOwned) w.setCameraOwned(false);
    });
    onResize();
    return w;
  }

  /* -------------------------------------------------------------- beats */
  var BEATS = {

    boot: {
      enter: function () {
        /* THE ONE DOOR INTO A NEW RUN. Every path that is not a validated
           resume arrives here, so this is where the lesson forgets the last
           student: both answers, both auto flags, the per-beat one-shots, the
           Scene B gesture state and the two Store keys that persist progress.
           Without it a stale S.choices.a made chooseA() a no-op and a_choice
           never advanced, and a stale S.auto told a student who had clicked
           that they had said nothing. */
        resetRun();
        UI.screen('boot');
        UI.setRoleChoice(function (role) { setRole(role); });
      },
      update: function () {}
    },

    cold: {
      enter: function () {
        UI.screen('cold');
        safe(function () { SFX.ambience('cab'); });
        S.speed = 0.15; S.tension = 0.1;
        safe(function () { if (S.fx) S.fx.fadeTo(1, 0); });
      },
      update: function () {
        runLines(SCRIPT.cold, 'cold');
        /* SCENE SLATE. SCRIPT.sceneA.slate was written for the lesson and no
           code ever read it. Re-timed against the re-timed copy: the three
           cold lines now fire at 0.4 / 3.5 / 5.6 and the last one clears at
           8.35 s once the 38 char/s typewriter is counted, so the slate takes
           the gap after them -- in at 8.4 s, sceneASlateMs (1.2 s) on screen,
           gone by 10.1 s, and the cab fades up at coldMs 10.2 instead of
           13.6. Nothing is overwritten, every word still plays, and the class
           is looking at a picture 3.4 s sooner. */
        var endC = T('coldMs', 10.2), slC = T('sceneASlateMs', 1.2);
        if (S.beatT >= endC - slC - 0.6) {
          once('aSlate', function () { UI.subtitle(SCRIPT.sceneA.slate, slC * 1000); });
        }
        if (S.beatT > endC) go('a_approach');
      }
    },

    a_approach: {
      enter: function () {
        mountWorld('A');
        UI.screen('play');
        safe(function () { if (S.fx) S.fx.fadeTo(0, 1.6); });
        safe(function () { SFX.ambience('cab'); SFX.heartbeat(true); });
        S.speed = 1;
      },
      update: function () {
        S.tension = clamp(S.beatT / 12, 0, 0.45);
        runLines(SCRIPT.sceneA.lines, 'aL');
        /* SCRIPT.sceneA.hud was dead copy and the phase read a hard-coded
           'RUNNING'. hud.mainLine ('MAIN LINE - 5') is the one number the
           class needs on screen while the five are still too far down the
           track to count. hud.speed is the STRING '60', hence the unary +. */
        var HA = SCRIPT.sceneA.hud || {};
        safe(function () { UI.hud({ speed: +HA.speed || 60, phase: HA.mainLine || 'RUNNING', warn: null }); });
        if (S.beatT > T('sceneAApproachMs', 13.8)) go('a_brake');
      }
    },

    a_brake: {
      enter: function () {
        safe(function () { UI.brakePrompt(pullBrake); });
        /* The subtitle was retyping the button's own label. The brake button
           carries 'PULL THE BRAKE' and 'PRESS AND HOLD - OR HOLD SPACE' in the
           markup, so BOTH sceneA.brakePrompt and sceneA.brakePromptSub are
           already on screen; typing one of them again spent the one narration
           surface on a duplicate. (This is the Scene A twin of the pushHint
           duplicate in Scene B.) Say nothing here: the button is the
           instruction, and the silence before the brake fails is the point. */
        safe(function () { UI.subtitleClear(); });
      },
      update: function () {
        S.tension = clamp(0.45 + S.beatT / 14, 0, 0.7);
        /* The window the class gets to pull before the film pulls for them.
           A hard-coded 7 s made this the longest beat in Scene A -- 8.5 s of
           screen with nothing on it but a button. sceneABrakePromptMs owns
           it now: 4.5 s of futile pulling, then pullBrake's 1.5 s of screech
           before the lever gives. 6.0 s, and the failure lands while the
           room is still leaning forward. The fired guard means the beat
           stops re-entering pullBrake (and allocating its closure) on every
           frame between the auto-pull and the failure. */
        if (S.beatT > T('sceneABrakePromptMs', 4.5) && !S.fired.brake) pullBrake();
      }
    },

    a_side: {
      enter: function () {
        safe(function () { UI.brakePrompt(null); });
        /* THE TWO STRINGS WERE IN EACH OTHER'S SURFACES. sceneA.warning is the
           HUD warning strip ('BRAKE FAILURE - SIDE TRACK RIGHT - ONE WORKER');
           it was being typed into the SUBTITLE in the same tick as pullBrake's
           'THE BRAKES DO NOT WORK.', so the brake-failure line was destroyed
           before one character of it had appeared -- and sceneA.sideTrackReveal,
           the line actually written for this moment, was never read at all.
           Now: nothing is said for sceneAFailHoldMs (brakeFail keeps the
           screen), then sideTrackReveal for sceneASideTrackRevealMs; the
           warning goes where it belongs, in the HUD. The beat is the sum of
           its own parts (1.3 + 1.8 + 1.3 = 4.4 s) instead of a hard-coded
           3.2 s that cut the 49-character reveal off mid-sentence. The five
           are held at 30 m with the points still ahead of the cab however
           long the class takes, so the staging and the switch-point
           arithmetic downstream are untouched. */
        safe(function () { if (S.world && S.world.revealSide) S.world.revealSide(); });
        safe(function () { if (S.cam) S.cam.dutch(reduced() ? 0 : 0.035, 1.2); });
      },
      update: function () {
        S.tension = clamp(0.7 + S.beatT / 10, 0, 0.85);
        var HA = SCRIPT.sceneA.hud || {};
        safe(function () {
          UI.hud({ speed: +HA.speed || 60, phase: HA.sideLine || 'RUNNING', warn: SCRIPT.sceneA.warning });
        });
        var hSide = T('sceneAFailHoldMs', 1.3), rSide = T('sceneASideTrackRevealMs', 1.8);
        if (S.beatT >= hSide && !S.fired.aSide) once('aSide', function () {
          UI.subtitle(SCRIPT.sceneA.sideTrackReveal, rSide * 1000);
        });
        /* 1.3 s of silence, the reveal, and the 1.3 s the 49-character line
           spends typing at 38 char/s: 4.4 s, and the reveal finishes its
           hold at 4.39 s, just as the countdown takes the screen. */
        if (S.beatT > hSide + rSide + 1.3) go('a_choice');
      }
    },

    a_choice: {
      enter: function () {
        /* RE-ENTRY SAFETY. chooseA() opens with `if (S.choices.a) return;`, so
           entering this beat with an answer already in the slot turned every
           click into a silent no-op and the beat never advanced. The beat owns
           its slot: entering it clears the answer AND its auto flag together,
           so the first click always commits and the confront screen can never
           read a stale 'silence' beside a fresh answer. */
        clearChoice('a');
        safe(function () { SFX.riser(T('sceneAChoiceMs', 8)); });
        /* The screech has died by now and nothing was being said over the
           eight-second countdown: sceneA.brakeFailSub was written for exactly
           this silence and had never been read. */
        safe(function () { UI.subtitle(SCRIPT.sceneA.brakeFailSub, 2400); });
        safe(function () { UI.choices(SCRIPT.sceneA.choices, function (id) { chooseA(id); }); });
        safe(function () {
          UI.countdown(T('sceneAChoiceMs', 8),
            function (left, frac) { safe(function () { SFX.tick(1 - frac); }); },
            function () { if (S.choices.a) return; safe(function () { UI.subtitle(SCRIPT.sceneA.noChoice, 2200); }); chooseA('stay', true); });
        });
      },
      update: function () { S.tension = clamp(0.85 + S.beatT / 20, 0, 1); }
    },

    a_impact: {
      enter: function () {
        var which = S.choices.a === 'turn' ? 'one' : 'five';
        safe(function () { UI.stopCountdown(); UI.choices(null); UI.brakePrompt(null); });
        safe(function () { SFX.heartbeat(false); SFX.impact(); });
        safe(function () { if (S.world) S.world.impact(which); });
        safe(function () { if (S.fx) { S.fx.hit(1); S.fx.flash(0xc0202a, 0.85, 0.5); S.fx.bloodVeil(0.7, 2.2); } });
        safe(function () { if (S.cam) S.cam.shake(reduced() ? 0.2 : 1, 1.4); });
        impactRhythm();
      },
      update: function () { if (S.beatT > impactEndsAt) go('a_verdict'); }
    },

    a_verdict: {
      enter: function () {
        var v = S.choices.a === 'turn' ? SCRIPT.sceneA.verdictTurn : SCRIPT.sceneA.verdictStay;
        hudOff();      /* the cab HUD is z-40 and the screens are z-30: left on,
                          CASE 1's speedometer paints over the verdict. */
        UI.screen('result');
        safe(function () { UI.verdict({ title: v.title, line: v.line, tone: 'grave' }); });
        safe(function () { SFX.stinger('verdict'); });
      },
      update: function () { if (S.beatT > T('verdictHoldMs', 5)) go('b_intro'); }
    },

    b_intro: {
      enter: function () {
        disposeWorld();
        UI.screen('cold');
        safe(function () { if (S.fx) S.fx.fadeTo(1, 0); });
        safe(function () { SFX.ambience('bridge'); });
        S.speed = 0; S.tension = 0.15;
      },
      update: function () {
        runLines(SCRIPT.sceneB.intro, 'bI');
        /* SCRIPT.sceneB.slate, the twin of the Case 1 slate, was equally dead.
           The intro's last line (t=6.6 hold 2.6) clears at 9.2 s and
           sceneBIntroMs is 9600, so there is no gap to take: the slate is
           given its own 1.6 s at the END of the black instead of being typed
           over a line. This is the one beat that gets longer, by 2.2 s, and it
           is a black interstitial with no world mounted -- nothing measures
           it, and Scene A's beat lengths are untouched. */
        var endB = T('sceneBIntroMs', 9.6), slB = T('sceneBSlateMs', 1.6);
        if (S.beatT >= endB) once('bSlate', function () { UI.subtitle(SCRIPT.sceneB.slate, slB * 1000); });
        if (S.beatT > endB + slB + 0.6) go('b_approach');
      }
    },

    b_approach: {
      enter: function () {
        mountWorld('B');
        UI.screen('play');
        safe(function () { if (S.fx) S.fx.fadeTo(0, 1.8); });
      },
      update: function () {
        S.tension = clamp(S.beatT / 14, 0, 0.6);
        runLines(SCRIPT.sceneB.lines, 'bL');
        var aEnd = T('sceneBApproachMs', 14);
        var f = clamp(S.beatT / aEnd, 0, 1);
        safe(function () { if (S.world && S.world.setTrolleyDistance) S.world.setTrolleyDistance(lerp(320, 150, f)); });
        /* no speedometer on a bridge: you are not driving. BELOW until he turns,
           BESIDE YOU after, and NO SIDE TRACK from the line that says so
           (sceneB.lines[2], t = 6.6). */
        hud(null, null, (S.beatT > aEnd ? HB.beside : HB.below), (S.beatT > 7 ? HB.noSide : null));
        /* EYE CONTACT is its own beat in SCRIPT.timing.autoBeats
           (sceneBEyeContactHoldMs, between the approach and the choice) and it
           never ran. He turns, he sees you, he does not know why you are close
           -- and only THEN are you asked. Holding it here also leaves the whole
           8 s choice window free for the hesitation lines. */
        if (S.beatT > aEnd) {
          var g = clamp((S.beatT - aEnd) / 1.1, 0, 1);
          safe(function () { if (S.world && S.world.manLookBack) S.world.manLookBack(g); });
          once('eyeContact', function () {
            UI.subtitle(SCRIPT.sceneB.eyeContact, 1200);
            safe(function () { SFX.stinger('dread'); });
            safe(function () { if (S.cam) S.cam.shake(0.25, 0.6); });
          });
          if (S.beatT > aEnd + 2.1) once('eyeContactSub', function () {
            UI.subtitle(SCRIPT.sceneB.eyeContactSub, 900);
          });
        }
        if (S.beatT > aEnd + T('sceneBEyeContactHoldMs', 3.4)) go('b_choice');
      }
    },

    b_choice: {
      enter: function () {
        safe(function () { SFX.riser(T('sceneBChoiceMs', 8)); });
        /* The subtitle repeated SCRIPT.sceneB.pushHint word for word while the
           push panel below it was already displaying that same string (and its
           own static 'OR HOLD SPACE - ESC TO REFUSE' line, which is why
           sceneB.pushHintKeyboard stays deliberately unused), so the one
           surface that could carry the pressure was spent on a duplicate. The
           panel keeps the instruction; the subtitle now carries the hesitate
           lines and the eye contact. */
        clearChoice('b');                                   /* re-entry safety: see a_choice */
        pushPeak = 0; pushMoved = false; hesT = -1; hesSaid = 0;
        /* The drag/hold push panel is retired as an INPUT. It stays in the
           build because its hand-reach visuals are driven from the world, but
           nothing arms it any more: a full-screen invisible drag pad sitting
           over the choice buttons would swallow their clicks, and the whole
           point of this change is that one click decides, in both cases.
           sceneB.pushHint / pushHintFail / pushHintRelease / pushHintKeyboard
           belong to that retired path and are deliberately unused. */
        safe(function () { UI.pushGesture(null); });
        safe(function () { if (S.world) { S.world.setHandReach(0); S.world.setPushProgress(0); } });

        /* SAME CONTROL AS CASE 1.
           Scene A committed on a single click; Scene B demanded a 0.9 s hold
           or a drag. That asymmetry is not a difficulty setting, it is a
           measurement error: "did not push" then contains every student who
           could not work the control, and the confront screen's whole claim —
           same arithmetic, opposite answer — is read off those numbers. The
           moral asymmetry has to come from the fiction (your hands are on a
           man), never from the input device. So both cases are one click on
           the same component, with the same weight and the same key hints. */
        safe(function () {
          UI.choices(SCRIPT.sceneB.choices, function (id, item) {
            chooseB(id, item === true);
          });
        });
        safe(function () {
          UI.countdown(T('sceneBChoiceMs', 8),
            function (left, frac) { safe(function () { SFX.tick(1 - frac); }); },
            function () { if (S.choices.b) return; safe(function () { UI.subtitle(SCRIPT.sceneB.noChoice, 2200); }); chooseB('nopush', true); });
        });
      },
      update: function () {
        var f = clamp((S.beatT - 2.2) / 3.4, 0, 1);
        safe(function () { if (S.world && S.world.manLookBack) S.world.manLookBack(f); });
        if (f >= 1) once('eyeContact', function () {
          hesT = -2;                       /* he has turned round: hesitation is over */
          /* eyeContact and eyeContactSub as ONE held line. f reaches 1 at 5.6 s
             of an 8 s beat, so there is no second slot before the countdown
             expires: given its own slot the sub would either have stomped the
             line it belongs to or been cut off by the impact. */
          UI.subtitle(SCRIPT.sceneB.eyeContact + ' ' + SCRIPT.sceneB.eyeContactSub, 2200);
          safe(function () { SFX.stinger('dread'); });
          safe(function () { if (S.cam) S.cam.shake(reduced() ? 0.05 : 0.25, 0.6); });
        });
        /* HESITATE LINES. They run from the moment stillness is DETECTED --
           their t values are relative to that, as the copy says, and feeding
           them scene-elapsed time would show all three at once -- and they stop
           the instant a hand moves or he turns his head. Nothing read them
           before. Measured against the real copy in an 8 s beat: 'You have not
           moved.' at 0.6 s, 'Your hand is still on the rail.' at 3.2 s (clears
           at 5.4 s), then eye contact at 5.6 s, which cancels the third. */
        if (hesT === -1 && !pushMoved && !S.choices.b && S.beatT >= 0.6) hesT = S.beatT;
        if (hesT >= 0) {
          var HL = SCRIPT.sceneB.hesitateLines || [], hk = S.beatT - hesT, hi;
          for (hi = 0; hi < HL.length; hi++) {
            if (!(hesSaid & (1 << hi)) && HL[hi] && hk >= HL[hi].t) {
              hesSaid |= (1 << hi);
              (function (l) {
                safe(function () { UI.subtitle(l.text, (l.hold > 0 ? l.hold : 2.2) * 1000); });
              })(HL[hi]);
            }
          }
        }
        var g = clamp(S.beatT / T('sceneBChoiceMs', 8), 0, 1);
        safe(function () { if (S.world && S.world.setTrolleyDistance) S.world.setTrolleyDistance(lerp(150, 34, g)); });
      }
    },

    b_impact: {
      enter: function () {
        var which = S.choices.b === 'push' ? 'man' : 'five';
        safe(function () { UI.stopCountdown(); UI.choices(null); UI.pushGesture(null); });
        if (which === 'man') {
          safe(function () { SFX.push(); });
          safe(function () { if (S.world) S.world.commitPush(); });
          later(520, function () { safe(function () { SFX.bodyFall(); }); });
          later(980, function () {
            safe(function () { SFX.impact(); });
            safe(function () { if (S.world) S.world.impact('man'); });
            safe(function () { if (S.fx) { S.fx.hit(1); S.fx.flash(0xc0202a, 0.8, 0.5); S.fx.bloodVeil(0.6, 2); } });
            safe(function () { if (S.cam) S.cam.shake(reduced() ? 0.18 : 0.9, 1.2); });
          });
        } else {
          later(700, function () {
            safe(function () { SFX.impact(); });
            safe(function () { if (S.world) S.world.impact('five'); });
            safe(function () { if (S.fx) { S.fx.hit(0.8); S.fx.bloodVeil(0.5, 2); } });
            safe(function () { if (S.cam) S.cam.shake(reduced() ? 0.12 : 0.6, 1.2); });
          });
        }
        /* The crash itself is delayed here — he has to fall first, or the
           trolley has to reach the five — so the whole rhythm is offset to
           the moment of contact rather than to the start of the beat. */
        impactRhythm(which === 'man' ? 980 : 700);
      },
      update: function () { if (S.beatT > impactEndsAt) go('b_verdict'); }
    },

    b_verdict: {
      enter: function () {
        var v = S.choices.b === 'push' ? SCRIPT.sceneB.verdictPush : SCRIPT.sceneB.verdictNoPush;
        hudOff();
        UI.screen('result');
        safe(function () { UI.verdict({ title: v.title, line: v.line, tone: 'grave' }); });
        safe(function () { SFX.stinger('verdict'); });
      },
      update: function () { if (S.beatT > T('verdictHoldMs', 5)) go('submit'); }
    },

    submit: {
      enter: function () {
        disposeWorld();
        UI.screen('submit');
        var combo = comboKey();
        persist();                     /* one whole record, not just its choices half */
        safe(function () { UI.setBusy(true); });
        Poll.submit(combo).then(function (r) {
          safe(function () { UI.setBusy(false); });
          /* A conflict means another device won the race and this view is about
             to reload onto the winning version. The vote is parked in
             localStorage and is re-sent on the next load, so say nothing
             alarming about it. */
          if (!r.ok && r.reason !== 'conflict') {
            safe(function () { UI.toast(SCRIPT.submit.offline, 'info'); });
          }
          /* The 8 s watchdog in update() may already have moved us on. Going
             again rebuilt the hold-up card under the student's hands and threw
             away the screen they were already holding up -- silently, because
             go() never complains. */
          if (S.beat === 'submit') go('card');
        })['catch'](function () {
          safe(function () { UI.setBusy(false); });
          if (S.beat === 'submit') go('card');
        });
      },
      /* the promise always settles, but never strand a student on a spinner */
      update: function () { if (S.beatT > 8) go('card'); }
    },

    /* THE COUNTING AID. When nothing syncs — the normal case in a room of
       thirty anonymous, read-only viewers — this is how the class gets
       counted: every device ends holding up one colour and one letter. */
    card: {
      enter: function () {
        disposeWorld();
        safe(function () { UI.setBusy(false); });
        UI.screen('card');
        safe(function () { SFX.ambience('menu'); });
        safe(function () {
          UI.holdUpCard(comboKey(), {
            kicker: 'HOLD YOUR SCREEN UP',
            nextLabel: 'SHOW ME THE CLASS →',
            onNext: function () { go('reveal'); }
          });
        });
      },
      update: function () {}
    },

    reveal: {
      enter: function () {
        UI.screen('reveal');
        safe(function () { SFX.ambience('menu'); SFX.stinger('reveal'); });
        var mine = (S.role === 'projector') ? null : comboKey();
        /* keyed, so re-entering the beat replaces this listener rather than
           stacking another one behind it */
        Poll.onChange(function (c) {
          safe(function () { UI.tally(c, { mine: mine, live: c.live, total: c.total }); });
        }, 'reveal');
        safe(function () {
          UI.revealAdvance(function () { go('confront'); },
                           S.role === 'projector' ? 'THE QUESTION →' : 'CONTINUE →');
        });
        /* There was no way BACK. Once the projector left the console to show
           the class, the teacher could not return to keep counting — the only
           route was a hidden T shortcut nobody is told about. */
        safe(function () { UI.screenActions('reveal', backActions()); });
      },
      update: function () {}
    },

    confront: {
      enter: function () {
        UI.screen('confront');
        safe(function () {
          /* UI.confront reads a / b / contradiction / question / attribution.
             It was handed combo / copy / afterword / counts, none of which it
             reads, so BOTH statements rendered "YOU MADE NO CHOICE."; and
             closingQuestion is an OBJECT, so String()ing it printed
             "[object Object]" as the closing question on the projector. */
          var CF = SCRIPT.confront || {};
          var cq = CF.closingQuestion || {};
          var cc = (CF.combos && CF.combos[comboKey()]) || CF.fallback || {};
          UI.confront({
            a: S.choices.a,
            b: S.choices.b,
            /* UI.confront appends 'You said nothing. Silence chose for you.'
               when a choice was made by the countdown rather than by the
               student, and renders payload.afterword as its closing line.
               S.auto has always known which; nothing passed it on, so a student
               who froze was told they had decided, and SCRIPT.confront.afterword
               ('Do not answer yet. Open the passage.') never appeared. */
            aAuto: !!S.auto.a,
            bAuto: !!S.auto.b,
            contradiction: cc.tension,
            question: cq.text,
            attribution: cq.cite,
            afterword: CF.afterword
          });
        });
        safe(function () { SFX.stinger('dread'); });
        /* The lesson ended with no way to run it again — the next class, or a
           student who wants a second go, had to reload the file by hand. */
        safe(function () { UI.screenActions('confront', backActions(true)); });
      },
      update: function () {}
    },

    teacher: {
      enter: function () {
        disposeWorld();
        UI.screen('teacher');
        Poll.loadManual();
        safe(function () {
          UI.teacherConsole({
            counts: Poll.counts(),
            live: Poll.live,
            /* every stepper tap lands straight in the tally */
            onChange: function (c) { if (c) Poll.setManual(c); },
            onReset: function () { Poll.reset(); },
            onFullscreen: toggleFullscreen,
            onAdvance: function (c) { if (c) Poll.setManual(c); go('reveal'); }
          });
        });
        /* the tally is kept rendered behind the console, so SHOW THE CLASS is
           an instant cut rather than a rebuild in front of the room */
        Poll.onChange(function (c) {
          /* D5: THE STORE IS THE SINGLE SOURCE OF TRUTH. The console wrote into
             Poll and never read back, so a reload restoring a stored hand count,
             a live vote arriving from another view, and Poll.reset() all left
             the four cards showing whatever they had been built with -- usually
             zero, even with 29 answers in the store. onChange fires once
             immediately on subscribe, so this covers the reload case too, and
             UI.setTeacherCounts only paints (it never calls tcEmit), so the
             steppers cannot feed themselves through it. */
          safe(function () { UI.setTeacherCounts(c); });
          safe(function () { UI.tally(c, { live: c.live, total: c.total }); });
          safe(function () { UI.setLive(c.live); });
        }, 'teacher');
      },
      update: function () {}
    }
  };

  /* ------------------------------------------------------- transitions */
  function go(name) {
    if (!BEATS[name]) { warn('unknown beat ' + name); return; }
    beatEpoch++;                 /* invalidate every callback the last beat scheduled */
    clearBeatTimers();
    S.beat = name; S.beatT = 0; S.fired = {};
    persist();
    safe(function () { BEATS[name].enter(); });
    safe(function () { if (UI.skipHint) UI.skipHint(skippable()); });
    /* after the outgoing screen has finished transitioning out of the layout */
    later(420, focusRescue);
  }

  function pullBrake() {
    once('brake', function () {
      safe(function () { if (S.world && S.world.pullBrake) S.world.pullBrake(); });
      safe(function () { SFX.screech(1.9); });
      later(1500, function () {
        safe(function () { SFX.leverFail(); });
        safe(function () { UI.subtitle(SCRIPT.sceneA.brakeFail, 2800); });
        safe(function () { if (S.fx) S.fx.flash(0xc0202a, 0.28, 0.35); });
        if (S.beat === 'a_brake') go('a_side');
      });
    });
  }

  /* ------------------------------------------------- authoritative reset
     A CHOICE IS A PAIR, NOT A VALUE: the answer, and the flag that says whether
     a human gave it. They are written together and cleared together, always,
     because the one screen whose whole job is to reflect the student's own
     choices back at them reads BOTH -- and reading an answer from this run
     beside an auto flag left over from an earlier one is how the confront
     screen told a student who had clicked 'You said nothing. Silence chose for
     you.' Nothing outside these functions and the validated resume path is
     allowed to write S.choices or S.auto. */
  function clearChoice(k) {
    S.choices[k] = null;
    S.auto[k] = false;
    persist();
  }

  /* A fresh run: everything the film has learned about THIS student, plus the
     Store record of it. Called on entering boot -- the only door into a new
     run -- and on the hard-reset shortcut. It also drops the transient prompts,
     so a live countdown or a half-dragged push bar from an abandoned run cannot
     survive into the next one. */
  function resetRun() {
    S.choices = { a: null, b: null };
    S.auto = { a: false, b: false };
    S.fired = {};
    pushPeak = 0; pushMoved = false; hesT = -1; hesSaid = 0;
    S.tension = 0; S.speed = 0;
    safe(function () {
      UI.stopCountdown(); UI.choices(null); UI.pushGesture(null);
      if (UI.hideBrake) UI.hideBrake();
    });
    Store.del('trolley.progress');
    Store.del('trolley.choices');
  }

  /* `auto` is true ONLY when the countdown expired, and the test is STRICT:
     UI.choices invokes its callback as (id, item), so a truthy second argument
     is one careless `UI.choices(list, chooseA)` away, and !! would have marked
     a clicked answer automatic. An answer a student actually clicked can never
     be reported as silence. */
  function chooseA(id, auto) {
    if (S.choices.a) return;
    S.choices.a = id;
    S.auto.a = (auto === true);
    safe(function () { UI.stopCountdown(); SFX.uiConfirm(); });
    if (id === 'turn') {
      safe(function () { SFX.switchThrow(); });
      safe(function () { if (S.world && S.world.throwSwitch) S.world.throwSwitch(); });
    }
    persist();
    later(id === 'turn' ? 900 : 350, function () { if (S.beat === 'a_choice') go('a_impact'); });
  }

  function chooseB(id, auto) {
    if (S.choices.b) return;
    S.choices.b = id;
    S.auto.b = (auto === true);
    safe(function () { UI.stopCountdown(); SFX.uiConfirm(); });
    persist();
    go('b_impact');
  }

  function comboKey() {
    var a = S.choices.a === 'turn' ? 'turn' : 'stay';
    var b = S.choices.b === 'push' ? 'push' : 'nopush';
    return a + '_' + b;
  }

  /* The teacher console counts per SIDE ('switch'/'stay', 'push'/'dont');
     Poll stores the four COMBINATIONS. Nothing in the room records which
     student paired which two answers, so the sides are recombined as if
     independent: the marginals the class actually sees are exact, and the
     four cells sum back to the total. */
  function teacherCountsFromPoll() {
    var c = Poll.counts();
    return {
      a: { 'switch': c.a.turn | 0, 'stay': c.a.stay | 0 },
      b: { 'push': c.b.push | 0, 'dont': c.b.nopush | 0 }
    };
  }

  function teacherCountsToCombos(c) {
    c = c || {};
    var aT = Math.max(0, (c.a && c.a['switch']) | 0), aS = Math.max(0, (c.a && c.a.stay) | 0);
    var bP = Math.max(0, (c.b && c.b.push) | 0), bD = Math.max(0, (c.b && c.b.dont) | 0);
    var na = aT + aS, nb = bP + bD, n = Math.max(na, nb);
    var out = { turn_nopush: 0, turn_push: 0, stay_nopush: 0, stay_push: 0 };
    if (!n) return out;
    var pT = na ? aT / na : 0, pP = nb ? bP / nb : 0;
    var tp = Math.round(n * pT * pP);
    var tn = Math.max(0, Math.round(n * pT) - tp);
    var sp = Math.max(0, Math.round(n * pP) - tp);
    var sn = Math.max(0, n - tp - tn - sp);
    out.turn_push = tp; out.turn_nopush = tn; out.stay_push = sp; out.stay_nopush = sn;
    return out;
  }

  /* ----------------------------------------------------------- persist
     ONE record, written whole. 'trolley.progress' carries the beat, both
     answers, both auto flags and the role together, and 'trolley.choices' is
     written from the same snapshot in the same call, so the two keys can never
     drift apart. snapshot() returns a COPY: it is handed to Poll and parked in
     sessionStorage to survive a publish conflict, and handing out the live
     S.choices object meant the parked record could change under the caller
     after it had been taken. */
  function persist() {
    var snap = snapshot();
    Store.set('trolley.progress', snap);
    Store.set('trolley.choices', snap.choices);
  }
  function snapshot() {
    return {
      beat: S.beat,
      choices: { a: S.choices.a || null, b: S.choices.b || null },
      auto: { a: !!S.auto.a, b: !!S.auto.b },
      role: S.role
    };
  }

  function toggleFullscreen() {
    try {
      var d = document, e = d.documentElement, isFull = !!(d.fullscreenElement || d.webkitFullscreenElement);
      if (isFull) {
        if (d.exitFullscreen) d.exitFullscreen();
        else if (d.webkitExitFullscreen) d.webkitExitFullscreen();
      } else {
        if (e.requestFullscreen) e.requestFullscreen();
        else if (e.webkitRequestFullscreen) e.webkitRequestFullscreen();
      }
      safe(function () { UI.setFullscreenState(!isFull); });
    } catch (e2) { warn(e2); }
  }

  /* A publish conflict reloads this view onto the version that won the race.
     Poll parked where the film was just before it published, so pick it back
     up here instead of making a student sit through three minutes again. Only
     the post-decision beats are resumable; anything earlier just restarts. */
  function resumeAfterReload() {
    var r = Poll.takeResume();
    if (!r || (r.role !== 'student' && r.role !== 'projector')) return false;
    var jump = (r.beat === 'submit' || r.beat === 'card') ? 'card'
             : (r.beat === 'reveal' || r.beat === 'confront') ? r.beat : null;
    if (!jump) return false;
    S.role = r.role;
    /* ALL OR NOTHING. Every resumable beat is downstream of BOTH decisions, so
       a snapshot that cannot supply both is not a state this film can be in --
       and restoring it half-made would drop the class onto a confront screen
       printing 'YOU MADE NO CHOICE' beside an answer they remember giving. A
       snapshot that does not validate is never repaired: we return false, and
       start() falls through to go('boot'), whose resetRun() is a known-good
       clean state. */
    var ca = r.choices && r.choices.a, cb = r.choices && r.choices.b;
    if ((ca !== 'turn' && ca !== 'stay') || (cb !== 'push' && cb !== 'nopush')) return false;
    var au = r.auto || {};
    resetRun();                    /* clean floor first, then lay the whole state down */
    S.choices = { a: ca, b: cb };
    S.auto = { a: !!au.a, b: !!au.b };
    persist();
    Store.set('trolley.role', S.role);
    safe(function () { UI.setRoleChoice(null); });
    safe(function () { SFX.unlock(); });
    Poll.probe().then(function () {
      /* The probe resolves late. If anything moved us on in the meantime, do
         not drag the film back to the resume point -- the same guard setRole()
         already carries. */
      if (S.beat === 'boot') go(jump);
      Poll.flushPending();
    })['catch'](function () { go(jump); });
    return true;
  }

  /* ------------------------------------------------------- perf ladder */
  var Perf = (function () {
    var acc = 0, n = 0, cool = 0;
    function apply() {
      safe(function () { if (S.world && S.world.setQuality) S.world.setQuality(S.quality); });
      safe(function () { if (S.fx) S.fx.setQuality(S.quality); });
      safe(function () {
        if (S.renderer) S.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, [1, 1.15, 1.4, 1.75][S.quality]));
      });
    }
    function sample(dt) {
      acc += dt; n++; cool -= dt;
      if (n < 45) return;
      var avg = acc / n; acc = 0; n = 0;
      if (cool > 0) return;
      if (avg > 1 / 26 && S.quality > 0) { S.quality--; apply(); cool = 3; }
      else if (avg < 1 / 55 && S.quality < 3) { S.quality++; apply(); cool = 6; }
    }
    return { sample: sample, apply: apply };
  })();

  /* -------------------------------------------------------- main loop */
  /* One frame of simulation + render. Split out of the rAF callback so it can
     also be driven deterministically (Director.step) — needed for automated
     verification, where the tab is hidden and rAF never fires. */
  function tick(dt) {
    if (dt > 0.1) dt = 0.1;            // tab-switch guard
    if (dt <= 0) dt = 0.016;
    S.beatT += dt;

    safe(function () { SFX.setTension(S.tension); SFX.setSpeed(S.speed); });

    var b = BEATS[S.beat];
    if (b && b.update) safe(function () { b.update(dt); });

    if (S.world) {
      safe(function () {
        S.world.update(dt, { t: S.beatT, phase: S.beat, tension: S.tension, thrown: S.choices.a === 'turn' });
      });
      /* The rig re-asserts its OWN fov every frame, so it was silently
         undoing the fov the world had just computed - which killed world B's
         horizontal-FOV lock, the thing that keeps the framing right on a 4:3
         or portrait classroom projector. Hand the world's value to the rig
         first and the two stop fighting. */
      if (S.cam) safe(function () {
        /* Constant handheld drift is exactly the motion prefers-reduced-motion
           asks us to stop, and it ran for the entire film. */
        S.cam.handheld(reduced() ? 0 : (0.25 + S.tension * 0.75));
        if (S.world.camera && S.world.camera.isPerspectiveCamera) S.cam.setBaseFov(S.world.camera.fov);
        S.cam.update(dt);
      });
      /* FX and r134's WebGLRenderer both no-op their GPU work while the context
         is lost, so the render call still runs -- it keeps FX's own fade, veil
         and letterbox clocks in step with the beat clock, which does not stop.
         What must NOT run is the perf ladder: those frames are not evidence
         about this GPU, and reading them as evidence would permanently drop the
         quality rung for the whole class. */
      if (S.fx) safe(function () { S.fx.render(S.world.scene, S.world.camera, dt); });
      if (!S.contextLost) Perf.sample(dt);
    }
  }

  function frame(now) {
    S.rafId = requestAnimationFrame(frame);
    var dt = S.lastFrame ? (now - S.lastFrame) / 1000 : 0.016;
    S.lastFrame = now;
    tick(dt);
  }

  /* Drive n frames by hand at a fixed dt. Returns the frames actually run. */
  function step(n, dt) {
    n = n || 1; dt = dt || 1 / 60;
    for (var i = 0; i < n; i++) tick(dt);
    return n;
  }

  /* ------------------------------------------------------------- setup */
  /* Returns a promise so callers can await the (async) first beat transition.
     The probe resolves late, so it must not stomp a beat the caller already
     moved to in the meantime — hence the 'boot' guard. */
  function setRole(role) {
    S.role = role;
    Store.set('trolley.role', role);
    safe(function () { SFX.unlock(); });
    return Poll.probe().then(function () {
      if (S.beat !== 'boot') return S.beat;      // someone already advanced us
      if (role === 'projector') { go('teacher'); }
      else { Poll.flushPending(); go('cold'); }
      return S.beat;
    })['catch'](function () {
      if (S.beat === 'boot') go(role === 'projector' ? 'teacher' : 'cold');
      return S.beat;
    });
  }

  function initRenderer() {
    var canvas = document.getElementById('gl');
    if (!canvas) return false;
    try {
      S.renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
      S.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
      S.renderer.setSize(window.innerWidth, window.innerHeight, false);
      S.renderer.shadowMap.enabled = true;
      S.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      /* COLOUR MANAGEMENT IS OWNED BY mod-fx.js -- see the contract at the top of
         FX_create(), which runs on the next line. What is set here is only the
         correct standing configuration for the case where FX is a stub or post is
         off: three tone-maps and sRGB-encodes. FX.create() takes it from here and,
         while its composite is live, pins toneMapping to NoToneMapping and
         outputEncoding to LinearEncoding, because the composite does exposure,
         ACES and the ONE sRGB encode itself. Setting sRGBEncoding here AND
         encoding again in FX_FRAG is what was lifting every dark ~19%.
         Do NOT reintroduce the r152+ colour-space API here: every one of those
         names is undefined on the pinned r134 build, which is why the branch that
         used them never ran and the sRGBEncoding fallback is what actually took
         effect. */
      if ('outputEncoding' in S.renderer && THREE.sRGBEncoding !== undefined) S.renderer.outputEncoding = THREE.sRGBEncoding;
      if (THREE.ACESFilmicToneMapping !== undefined) S.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      /* The one exposure knob for the whole app: FX.create() reads it back off the
         renderer and feeds it to fxACES, so the composite and the no-post fallback
         expose identically. Held at a neutral 1.0 rather than starved further --
         the graveness comes from the FX grade (contrast 1.07, crush, cool tint,
         vignette 0.62) which has been dead until now, and removing the double
         encode alone already drops the darks ~19%. This is the knob to re-tune
         once the world's light intensities are corrected; tuning it against the
         present ones would be tuning against a bug. */
      S.renderer.toneMappingExposure = 1.0;
      S.fx = FX.create(S.renderer, {});
      /* CONTEXT LOSS. preventDefault is what makes a restore possible at all;
         what was missing is what happens to the frames either side of it. */
      canvas.addEventListener('webglcontextlost', function (e) {
        e.preventDefault();
        S.contextLost = true;
        S.lastFrame = 0;
      }, false);
      canvas.addEventListener('webglcontextrestored', function () {
        S.contextLost = false;
        S.lastFrame = 0;                       /* no giant dt across the outage */
        /* Re-apply OUR configuration -- pixel ratio, and the world / FX quality
           rung -- and re-measure the drawing buffer the new context allocated.
           Nothing here remounts the world: that would throw away narrative
           state mid-scene, and r134 re-uploads geometry and textures lazily
           while FX rebuilds its own render targets from its own restore
           listener. Exposure, tone mapping and shadowMap.enabled are plain JS
           properties on the renderer and survive the outage untouched --
           re-setting them here would only hard-code values initRenderer above
           is expected to re-tune. */
        safe(function () { Perf.apply(); });
        onResize();
      }, false);
      return true;
    } catch (e) { warn(e); S.webgl = false; return false; }
  }

  function onResize() {
    if (!S.renderer) return;
    var w = window.innerWidth, h = window.innerHeight;
    S.renderer.setSize(w, h, false);
    if (S.fx) safe(function () { S.fx.resize(w, h); });
    if (S.world && S.world.camera) {
      S.world.camera.aspect = w / h;
      S.world.camera.updateProjectionMatrix();
    }
  }

  function start() {
    safe(function () { UI.init('ui-root'); });
    if (typeof THREE === 'undefined') { S.webgl = false; }
    else if (!initRenderer()) { S.webgl = false; }
    if (!S.webgl) safe(function () { UI.toast(SCRIPT.errors.webgl.line, 'warn'); });

    window.addEventListener('resize', onResize, false);
    window.addEventListener('orientationchange', function () { setTimeout(onResize, 250); }, false);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) safe(function () { SFX.suspend(); });
      else { S.lastFrame = 0; safe(function () { SFX.resume(); }); }
    }, false);

    document.addEventListener('keydown', function (e) {
      /* A focused button raises its own click on Enter and Space. Acting on the
         key here as well ran the transition twice and rebuilt the screen the
         student had just advanced away from -- and mod-ui focuses that button
         itself on entering the card screen. So the global shortcut applies only
         when focus is NOT on a control. Space is accepted too: a projector
         driven from a wireless presenter sends it, and nothing else on these
         two screens consumes it. */
      var onCtl = false;
      try {
        var tg = (e.target && e.target.tagName) ? String(e.target.tagName).toLowerCase() : '';
        onCtl = (tg === 'button' || tg === 'a' || tg === 'input' || tg === 'select' || tg === 'textarea');
      } catch (eT) {}
      if (!onCtl && !e.ctrlKey && !e.metaKey && !e.altKey &&
          (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar')) {
        if (S.beat === 'reveal') { e.preventDefault(); go('confront'); }
        else if (S.beat === 'card') { e.preventDefault(); go('reveal'); }
        else if (SKIP_NEXT[S.beat]) { e.preventDefault(); skip(); }
      }
      /* Right arrow reads as "next" on a presenter remote. */
      if (!onCtl && e.key === 'ArrowRight' && SKIP_NEXT[S.beat]) { e.preventDefault(); skip(); }
      /* T takes the PROJECTOR back to the console from anywhere after the film.
         Guarded on the role so a student cannot open the console and erase the
         class tally from their own Chromebook. */
      if ((e.key === 't' || e.key === 'T') && !e.ctrlKey && !e.metaKey && !e.altKey &&
          S.role === 'projector' &&
          (S.beat === 'reveal' || S.beat === 'confront' || S.beat === 'card')) { go('teacher'); }
      if ((e.key === 'r' || e.key === 'R') && e.ctrlKey && e.shiftKey) {
        resetRun();
        try { sessionStorage.removeItem('trolley.resume'); } catch (eR) {}
        location.reload();
      }
    }, false);

    /* Click / tap anywhere to skip a narration beat. Bound on the document so
       it works over the 3D canvas as well as the overlay, and refused when the
       press landed on any real control so a choice button can never be turned
       into a skip. */
    document.addEventListener('click', function (e) {
      if (!skippable()) return;
      try {
        var n = e.target;
        while (n && n !== document.body) {
          var tg = n.tagName ? String(n.tagName).toLowerCase() : '';
          if (tg === 'button' || tg === 'a' || tg === 'input' ||
              tg === 'select' || tg === 'textarea' || tg === 'label') return;
          n = n.parentNode;
        }
      } catch (eC) {}
      skip();
    }, false);

    S.running = true;
    S.rafId = requestAnimationFrame(frame);
    /* A quine that can no longer regenerate the page would destroy the artifact
       on the first vote. Prove it works before anything is allowed to publish. */
    if (window.Shell && Shell.selfTest && !Shell.selfTest()) warn('Shell.selfTest failed');
    if (!resumeAfterReload()) go('boot');
  }

  return {
    start: start, go: go, snapshot: snapshot, setRole: setRole,
    comboKey: comboKey, step: step, mountWorld: mountWorld,
    get state() { return S; }
  };
})();
