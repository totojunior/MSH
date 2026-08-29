/* ============================================================================
   MODULE: ui  --  DOM / CSS overlay for the Trolley lesson hook.
   Declares exactly ONE global: UI
   No imports, no requires, no fetch, no external assets except Google Fonts CSS.
   Every entry point is wrapped so a failure degrades quietly (contract rule 11).
   ========================================================================== */
var UI = (function () {
  'use strict';

  var U = {};
  var D = document;
  var W = window;

  /* ------------------------------------------------------------------ */
  /* tiny defensive helpers (all closure-local, nothing leaks)           */
  /* ------------------------------------------------------------------ */
  function $(id) { try { return D.getElementById(id); } catch (e) { return null; } }
  function on(n, t, f, o) { try { if (n && n.addEventListener) n.addEventListener(t, f, o === undefined ? false : o); } catch (e) {} }
  function addC(n, c) { try { if (n && n.classList) n.classList.add(c); } catch (e) {} }
  function remC(n, c) { try { if (n && n.classList) n.classList.remove(c); } catch (e) {} }
  function togC(n, c, v) { if (v) addC(n, c); else remC(n, c); }
  function txt(n, s) { try { if (n) n.textContent = (s === null || s === undefined) ? '' : String(s); } catch (e) {} }
  function attr(n, k, v) { try { if (n) n.setAttribute(k, String(v)); } catch (e) {} }
  function mk(tag, klass, text) {
    var n;
    try { n = D.createElement(tag); } catch (e) { return null; }
    if (klass) n.className = klass;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function app(p, c) { try { if (p && c) p.appendChild(c); } catch (e) {} return c; }
  function clear(n) { try { while (n && n.firstChild) n.removeChild(n.firstChild); } catch (e) {} }
  function reflow(n) { try { if (n) { /* jshint ignore:line */ var _x = n.offsetWidth; if (_x === -1) return; } } catch (e) {} }
  function nowMs() { try { return performance.now(); } catch (e) { return Date.now(); } }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function num(v, d) { v = Number(v); return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function call(f) {
    if (typeof f !== 'function') return undefined;
    var args = Array.prototype.slice.call(arguments, 1);
    try { return f.apply(null, args); } catch (e) { return undefined; }
  }

  /* prefers-reduced-motion, live-updated */
  var _reduced = false;
  (function () {
    try {
      if (!W.matchMedia) return;
      var mq = W.matchMedia('(prefers-reduced-motion: reduce)');
      _reduced = !!mq.matches;
      var h = function () { try { _reduced = !!mq.matches; } catch (e) {} };
      if (mq.addEventListener) mq.addEventListener('change', h);
      else if (mq.addListener) mq.addListener(h);
    } catch (e) { _reduced = false; }
  })();
  function reduced() { return _reduced; }

  /* ------------------------------------------------------------------ */
  /* element cache + state                                              */
  /* ------------------------------------------------------------------ */
  var el = {};
  var inited = false;
  var currentScreen = '';

  function injectFonts() {
    try {
      if (D.getElementById('ui-gfonts')) return;
      var head = D.head || D.getElementsByTagName('head')[0];
      if (!head) return;
      var p1 = D.createElement('link'); p1.rel = 'preconnect'; p1.href = 'https://fonts.googleapis.com';
      head.appendChild(p1);
      var p2 = D.createElement('link'); p2.rel = 'preconnect'; p2.href = 'https://fonts.gstatic.com'; p2.crossOrigin = 'anonymous';
      head.appendChild(p2);
      var l = D.createElement('link');
      l.id = 'ui-gfonts';
      l.rel = 'stylesheet';
      l.href = 'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Spectral:ital,wght@0,400;0,600;1,400&display=swap';
      head.appendChild(l);
    } catch (e) {}
  }

  /* two live regions: polite narration, assertive alerts */
  function say(msg) { txt(el.status, msg); }
  /* Join a heading to the line under it for a screen reader. The authored
     copy already ends its titles in a full stop ("YOU KILLED ONE MAN."), so
     a blind ". " joiner read out "ONE MAN.. He was working." */
  function joinSay(a, b) {
    a = String(a === null || a === undefined ? '' : a).replace(/\s+$/, '');
    b = String(b === null || b === undefined ? '' : b).replace(/^\s+/, '');
    if (!a) return b;
    if (!b) return a;
    return a + (/[.!?:;,…—–]$/.test(a) ? ' ' : '. ') + b;
  }
  function alertSay(msg) {
    try {
      if (!el.alert) return;
      /* re-announce identical strings by forcing a change */
      if (el.alert.textContent === String(msg)) el.alert.textContent = '';
      el.alert.textContent = String(msg === null || msg === undefined ? '' : msg);
    } catch (e) {}
  }

  /* deferred hide so fade-outs are visible but never leave a ghost layer */
  var GEN = 0;
  function showEl(node, cls) {
    if (!node) return;
    try { node.__uiGen = ++GEN; } catch (e) {}
    try { node.hidden = false; } catch (e) {}
    reflow(node);
    addC(node, cls || 'on');
  }
  function hideEl(node, cls, delay) {
    if (!node) return;
    var g = ++GEN;
    try { node.__uiGen = g; } catch (e) {}
    remC(node, cls || 'on');
    var d = reduced() ? 60 : (typeof delay === 'number' ? delay : 380);
    setTimeout(function () {
      try { if (node.__uiGen === g) node.hidden = true; } catch (e) {}
    }, d);
  }

  /* ------------------------------------------------------------------ */
  /* AUTHORITATIVE SCREEN VISIBILITY                                      */
  /* The .55s cross-fade still plays, but when it ENDS the outgoing       */
  /* screen leaves the layout entirely (hidden -> the pre-existing        */
  /* `.ui-root [hidden]{display:none!important}` rule). It then cannot be */
  /* focused, cannot be read by assistive technology, cannot report an    */
  /* offsetParent and cannot paint a scrollbar over the screen below it.  */
  /* ------------------------------------------------------------------ */
  var SGEN = 0, screensPrimed = false;
  /* The screen on its way OUT owns a SHORTER fade than the one coming in
     (.26s against .55s, set in mod-ui.css), and the layout removal is driven
     by the real transitionend with the timer only as a backstop. The window
     in which an outgoing screen still occupies the layout is therefore a
     quarter of a second, not six-tenths. */
  var SCREEN_OUT_MS = 320;                /* .26s outgoing fade + slack */
  var FOCUSABLE = 'button,[href],input,select,textarea,[tabindex],[contenteditable]';
  function blurInside(node) {
    try {
      var a = D.activeElement;
      if (a && a !== D.body && node && node.contains && node.contains(a) && a.blur) a.blur();
    } catch (e) {}
  }
  /* `inert` is missing from plenty of the Chromebooks still in service, so
     every tab stop inside an outgoing screen is neutralised by hand and put
     back verbatim when that screen returns. */
  function tabTrap(node, off) {
    try {
      if (!node || !node.querySelectorAll) return;
      var list = node.querySelectorAll(FOCUSABLE), i, n, prev;
      for (i = 0; i < list.length; i++) {
        n = list[i];
        if (off) {
          if (n.getAttribute('data-ui-ti') === null) {
            n.setAttribute('data-ui-ti', n.hasAttribute('tabindex') ? n.getAttribute('tabindex') : '');
          }
          n.setAttribute('tabindex', '-1');
        } else {
          prev = n.getAttribute('data-ui-ti');
          if (prev === null) continue;
          n.removeAttribute('data-ui-ti');
          if (prev === '') n.removeAttribute('tabindex');
          else n.setAttribute('tabindex', prev);
        }
      }
    } catch (e) {}
  }
  function scrEndOff(node) {
    try {
      if (node.__scrEnd) {
        node.removeEventListener('transitionend', node.__scrEnd, false);
        node.__scrEnd = null;
      }
    } catch (e) {}
  }
  function screenShow(node) {
    if (!node) return;
    scrEndOff(node);
    try { node.__scrGen = ++SGEN; node.__scrOff = false; } catch (e) {}
    try { node.hidden = false; } catch (e) {}
    tabTrap(node, false);
    reflow(node);
    addC(node, 'is-on');
  }
  function screenHide(node, instant) {
    if (!node) return;
    try { if (node.__scrOff && node.hidden) return; } catch (e) {}   /* already gone */
    var g = ++SGEN;
    try { node.__scrGen = g; node.__scrOff = true; } catch (e) {}
    remC(node, 'is-on');
    blurInside(node);
    tabTrap(node, true);
    var fin = function () {
      scrEndOff(node);
      try {
        if (node.__scrGen !== g) return;
        if (node.classList && node.classList.contains('is-on')) return;
        blurInside(node);
        node.hidden = true;   /* display:none: no offsetParent, no scrollbar, no a11y */
      } catch (e) {}
    };
    /* first paint, and prefers-reduced-motion, jump straight to the end */
    if (instant || reduced()) { fin(); return; }
    var te = function (ev) {
      try { if (ev && ev.target !== node) return; } catch (e) {}
      fin();
    };
    try { node.__scrEnd = te; node.addEventListener('transitionend', te, false); } catch (e) {}
    setTimeout(fin, SCREEN_OUT_MS);
  }

  /* ================================================================== */
  /* INIT                                                                */
  /* ================================================================== */
  U.init = function (rootArg) {
    if (inited) return U;
    try {
      injectFonts();

      var r = rootArg;
      if (typeof r === 'string') r = $(r);
      el.root = r || $('ui-root');
      if (!el.root) return U;   /* not in the DOM yet: caller may retry */

      el.status    = $('ui-status');
      el.alert     = $('ui-alert');
      el.sub       = $('ui-sub');
      el.subText   = $('ui-sub-text');
      el.subKo     = $('ui-sub-ko');
      el.skipHint  = $('ui-skip');
      el.hud       = $('ui-hud');
      el.hudSpeed  = $('ui-hud-speed');
      el.hudPhase  = $('ui-hud-phase');
      el.hudWarn   = $('ui-hud-warn');
      el.cd        = $('ui-cd');
      el.cdArc     = $('ui-cd-arc');
      el.cdNum     = $('ui-cd-num');
      el.choices   = $('ui-choices');
      el.brake     = $('ui-brake');
      el.brakeBtn  = $('ui-brake-btn');
      el.brakeFill = $('ui-brake-fill');
      el.push      = $('ui-push');
      el.pushPad   = $('ui-push-pad');
      el.pushFx    = $('ui-push-fx');
      el.pushGuide = $('ui-push-guide');
      el.pushFill  = $('ui-push-fill');
      el.pushHand  = $('ui-push-hand');
      el.pushPct   = $('ui-push-pct');
      el.pushRef   = $('ui-push-refuse');
      el.pushHint  = $('ui-push-hint');
      el.pushHintKo = $('ui-push-hint-ko');
      el.pushDo    = $('ui-push-do');
      el.pushDoFill = $('ui-push-dofill');
      el.pushState = $('ui-push-state');
      el.toasts    = $('ui-toasts');
      el.dots      = $('ui-dots');
      el.busy      = $('ui-busy');
      el.scrBoot   = $('scr-boot');
      el.scrCold   = $('scr-cold');
      el.scrResult = $('scr-result');
      el.scrSubmit = $('scr-submit');
      el.scrReveal = $('scr-reveal');
      el.scrConf   = $('scr-confront');
      el.scrTeach  = $('scr-teacher');
      el.scrCard   = $('scr-card');
      el.card      = $('ui-card');
      el.revealActs = $('ui-reveal-actions');
      el.scrCard   = $('scr-card');
      el.card      = $('ui-card');
      el.revealActs = $('ui-reveal-actions');
      el.verdict   = $('ui-verdict');
      el.tally     = $('ui-tally');
      el.confront  = $('ui-confront');
      el.teacher   = $('ui-teacher');
      el.roleS     = $('ui-role-student');
      el.roleP     = $('ui-role-projector');

      /* countdown ring geometry (r = 54 in the 120x120 viewBox) */
      cdCirc = 2 * Math.PI * 54;
      try {
        if (el.cdArc) {
          el.cdArc.style.strokeDasharray = String(cdCirc);
          el.cdArc.style.strokeDashoffset = '0';
        }
      } catch (e) {}

      on(D, 'keydown', onKeyDown, false);
      on(D, 'keyup', onKeyUp, false);
      on(W, 'blur', onWinBlur, false);
      on(D, 'visibilitychange', onVis, false);
      on(el.root, 'contextmenu', function (e) { try { e.preventDefault(); } catch (x) {} }, { passive: false });

      /* role buttons */
      on(el.roleS, 'click', function () { fireRole('student'); }, false);
      on(el.roleP, 'click', function () { fireRole('projector'); }, false);

      /* push gesture surface */
      if (el.pushPad) {
        on(el.pushPad, 'pointerdown', pgDown, { passive: false });
        on(el.pushPad, 'pointermove', pgMove, { passive: false });
        on(el.pushPad, 'pointerup', pgUp, { passive: false });
        on(el.pushPad, 'pointercancel', pgAbort, { passive: false });
        on(el.pushPad, 'lostpointercapture', pgAbort, { passive: false });
        on(el.pushPad, 'wheel', function (e) { try { e.preventDefault(); } catch (x) {} }, { passive: false });
        on(el.pushPad, 'touchstart', function (e) { try { e.preventDefault(); } catch (x) {} }, { passive: false });
        on(el.pushPad, 'dragstart', function (e) { try { e.preventDefault(); } catch (x) {} }, { passive: false });
      }
      on(el.pushRef, 'click', function () { pgRefuse(); }, false);

      /* PUSH as a press-and-HOLD button. It runs the same 0.9 s key-hold path
         the space bar uses, so there is exactly one commit rule. Press-and-
         hold rather than drag because a drag target with no visible surface
         was undiscoverable (students looked for a button and found only the
         refuse one), and because holding is the gesture a Chromebook
         trackpad actually affords. The full-screen drag layer still works
         for anyone who tries it. */
      if (el.pushDo) {
        var pdHold = function (e) {
          try { e.preventDefault(); } catch (x) {}
          if (!pgOnFlag || pgCommitted || pgActive) return;
          pgKey = true; pgSpring = false;
          remC(el.pushDo, 'tooshort');
          if (pdShortT) { try { clearTimeout(pdShortT); } catch (x2) {} pdShortT = 0; }
          txt(el.pushState, PD_HOLDING);
          addC(el.push, 'dragging'); addC(el.pushDo, 'arming');
          try { if (e.pointerId !== undefined) el.pushDo.setPointerCapture(e.pointerId); } catch (x) {}
          ensureTick();
        };
        var pdRelease = function () {
          if (!pgKey) return;
          pgKey = false; pgSpring = true;
          remC(el.push, 'dragging'); remC(el.pushDo, 'arming');
          /* A quick click used to do NOTHING AT ALL — no movement, no message
             — so the control read as broken. Sustained intent is still
             required (a tap must not kill a man), but the button now says why
             it refused, and takes the blame itself. */
          if (!pgCommitted) {
            addC(el.pushDo, 'tooshort');
            txt(el.pushState, PD_SHORT);
            if (pdShortT) { try { clearTimeout(pdShortT); } catch (x) {} }
            pdShortT = setTimeout(function () {
              pdShortT = 0;
              remC(el.pushDo, 'tooshort');
              if (!pgCommitted) txt(el.pushState, PD_IDLE);
            }, 1600);
          }
          ensureTick();
        };
        on(el.pushDo, 'pointerdown', pdHold, { passive: false });
        on(el.pushDo, 'pointerup', pdRelease, { passive: false });
        on(el.pushDo, 'pointercancel', pdRelease, { passive: false });
        on(el.pushDo, 'pointerleave', pdRelease, { passive: false });
        on(el.pushDo, 'lostpointercapture', pdRelease, { passive: false });
        on(el.pushDo, 'touchstart', function (e) { try { e.preventDefault(); } catch (x) {} }, { passive: false });
        /* keyboard: Enter/Space on the focused button holds while held */
        on(el.pushDo, 'keydown', function (e) {
          if (e.repeat) return;
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') pdHold(e);
        }, false);
        on(el.pushDo, 'keyup', function (e) {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') pdRelease();
        }, false);
        on(el.pushDo, 'blur', pdRelease, false);
      }

      /* brake */
      if (el.brakeBtn) {
        on(el.brakeBtn, 'pointerdown', bkDown, { passive: false });
        on(el.brakeBtn, 'pointerup', bkUp, { passive: false });
        on(el.brakeBtn, 'pointercancel', bkUp, { passive: false });
        on(el.brakeBtn, 'lostpointercapture', bkUp, { passive: false });
        on(el.brakeBtn, 'touchstart', function (e) { try { e.preventDefault(); } catch (x) {} }, { passive: false });
      }

      inited = true;
      U.screen('boot');
    } catch (e) {}
    return U;
  };

  U.ready = function () { return inited; };

  /* ================================================================== */
  /* SCREENS                                                             */
  /* ================================================================== */
  var SCREENS = {
    boot: 'scrBoot', cold: 'scrCold', play: null,
    result: 'scrResult', submit: 'scrSubmit', reveal: 'scrReveal',
    confront: 'scrConf', teacher: 'scrTeach', card: 'scrCard'
  };

  U.screen = function (name) {
    try {
      var key = String(name === null || name === undefined ? '' : name).toLowerCase();
      if (!SCREENS.hasOwnProperty(key)) return;
      currentScreen = key;
      for (var k in SCREENS) {
        if (!SCREENS.hasOwnProperty(k)) continue;
        var slot = SCREENS[k];
        if (!slot) continue;
        var node = el[slot];
        if (!node) continue;
        var onNow = (k === key);
        if (onNow) screenShow(node); else screenHide(node, !screensPrimed);
        attr(node, 'aria-hidden', onNow ? 'false' : 'true');
        try { node.inert = !onNow; } catch (e) {}
      }
      screensPrimed = true;
      togC(el.root, 'in-play', key === 'play');
      togC(el.root, 'scr-' + key, true);
      /* strip the other screen markers */
      for (var k2 in SCREENS) {
        if (!SCREENS.hasOwnProperty(k2) || k2 === key) continue;
        remC(el.root, 'scr-' + k2);
      }
      /* leaving play tears down every live interaction */
      if (key !== 'play') {
        U.stopCountdown();
        pgHide();
        bkHide();
        U.hideChoices();
        U.hudHide();        /* "00 / MPH / BRAKE FAILURE" must leave the layout too */
        U.subtitleClear();  /* z-index 45: a stale caption would sit OVER the screen */
      }
      if (key === 'boot') focusFirst(el.scrBoot);
      else if (key === 'teacher') focusFirst(el.scrTeach);
      else if (key === 'card') focusFirst(el.scrCard);
      else if (key === 'card') focusFirst(el.scrCard);
    } catch (e) {}
  };

  U.currentScreen = function () { return currentScreen; };

  function focusFirst(scope) {
    try {
      if (!scope) return;
      var b = scope.querySelector('button:not([disabled]), [tabindex]:not([tabindex="-1"])');
      if (b && b.focus) setTimeout(function () { try { b.focus(); } catch (e) {} }, 60);
    } catch (e) {}
  }

  /* ================================================================== */
  /* ROLE SELECT                                                         */
  /* ================================================================== */
  var roleCb = null, roleFired = false, roleValue = '';

  U.setRoleChoice = function (cb) {
    roleCb = (typeof cb === 'function') ? cb : null;
    roleFired = false;
    roleValue = '';
    try {
      if (el.roleS) el.roleS.disabled = false;
      if (el.roleP) el.roleP.disabled = false;
    } catch (e) {}
    remC(el.scrBoot, 'chosen');
  };
  U.role = function () { return roleValue; };

  function fireRole(which) {
    if (roleFired) return;
    roleFired = true;
    roleValue = which;
    addC(el.root, 'role-' + which);
    addC(el.scrBoot, 'chosen');
    try {
      if (el.roleS) el.roleS.disabled = true;
      if (el.roleP) el.roleP.disabled = true;
    } catch (e) {}
    say(which === 'student' ? 'Student mode. Sound starts muted.' : 'Projector mode. Sound on.');
    call(roleCb, which);
  }

  /* ================================================================== */
  /* SUBTITLE  (letter-by-letter, dt-driven — no second timer)          */
  /* ================================================================== */
  var subStr = '', subChars = 0, subState = 0, subHold = 0, subCps = 38, subShown = -1;
  /* subState: 0 idle, 1 typing, 2 holding, 3 fading */

  U.subtitle = function (text, ms) {
    try {
      var node = el.subText;
      if (!node) return;
      var s = (text === null || text === undefined) ? '' : String(text);
      if (!s) { U.subtitleClear(); return; }
      subStr = s;
      subChars = 0;
      subShown = -1;
      subHold = (typeof ms === 'number' && ms > 0) ? (ms / 1000) : 2.6;
      subCps = reduced() ? 900 : 38;
      subState = 1;
      txt(node, reduced() ? s : '');
      /* The Korean lands immediately rather than typing with the English: a
         student who reads English slowly needs it BEFORE the line finishes,
         not after. Missing translations simply leave the node empty and the
         :empty rule collapses it. */
      txt(el.subKo, (typeof KO !== 'undefined' && KO.get) ? KO.get(s) : '');
      if (reduced()) { subChars = s.length; subShown = s.length; subState = 2; }
      showEl(el.sub, 'on');   /* un-hide, reflow, THEN fade in */
      togC(el.sub, 'typing', subState === 1);
      say(s);
      ensureTick();
    } catch (e) {}
  };

  U.subtitleClear = function () {
    try {
      subState = 0; subStr = ''; subChars = 0; subShown = -1; subHold = 0;
      remC(el.sub, 'typing');
      hideEl(el.sub, 'on', 760);   /* .5s fade, then out of the layout */
      txt(el.subText, '');
      txt(el.subKo, '');
    } catch (e) {}
  };

  /* Console-game skip. One press completes the line that is still typing;
     a second press dismisses it. Returns what it did so the caller can
     decide whether to also advance the beat. */
  U.subtitleSkip = function () {
    try {
      if (subState === 1) {
        subChars = subStr.length; subShown = subStr.length;
        txt(el.subText, subStr);
        subState = 2; remC(el.sub, 'typing');
        return 'completed';
      }
      if (subState === 2) { subHold = 0; return 'dismissed'; }
      return 'none';
    } catch (e) { return 'none'; }
  };

  /* Shown only while the director says the current beat can be skipped. */
  U.skipHint = function (on) {
    try {
      if (!el.skipHint) return;
      el.skipHint.hidden = !on;
    } catch (e) {}
  };

  function subTick(dt) {
    if (subState === 0) return;
    if (subState === 1) {
      subChars += subCps * dt;
      var i = Math.min(subStr.length, Math.floor(subChars));
      if (i !== subShown) { subShown = i; try { el.subText.textContent = subStr.slice(0, i); } catch (e) {} }
      if (i >= subStr.length) { subState = 2; remC(el.sub, 'typing'); }
      return;
    }
    if (subState === 2) {
      subHold -= dt;
      if (subHold <= 0) { subState = 3; remC(el.sub, 'on'); subHold = 0.7; }
      return;
    }
    if (subState === 3) {
      subHold -= dt;
      if (subHold <= 0) { subState = 0; txt(el.subText, ''); hideEl(el.sub, 'on', 40); }
    }
  }

  /* ================================================================== */
  /* HUD                                                                 */
  /* ================================================================== */
  var hudSpeedShown = -1, hudPhaseShown = null, hudUnitShown = null, hudUnitNode = null;
  /* the unit label lives in the markup; looked up once, lazily, never per frame */
  function hudUnitEl() {
    try { if (!hudUnitNode && el.hud) hudUnitNode = el.hud.querySelector('.hud-speed .u'); } catch (e) {}
    return hudUnitNode;
  }

  U.hud = function (o) {
    try {
      if (!el.hud) return;
      if (o === null || o === false) { hideEl(el.hud, 'on', 460); return; }
      o = o || {};
      /* classList read is cheap; showEl() forces a reflow, so pay it only on
         the transition into 'on' */
      if (!el.hud.classList.contains('on')) showEl(el.hud, 'on');
      if (typeof o.speed === 'number' && isFinite(o.speed)) {
        var v = clamp(Math.round(o.speed), 0, 999);
        if (v !== hudSpeedShown) {
          hudSpeedShown = v;
          txt(el.hudSpeed, v < 10 ? '0' + v : String(v));
        }
      } else if (o.speed === null) {
        /* CASE 2 has no speedometer -- you are not driving. Clear it rather
           than leaving CASE 1's 60 standing over the bridge. */
        if (hudSpeedShown !== -2) { hudSpeedShown = -2; txt(el.hudSpeed, ''); }
      }
      if (o.unit !== undefined) {
        var un = (o.unit === null) ? '' : String(o.unit);
        if (un !== hudUnitShown) { hudUnitShown = un; txt(hudUnitEl(), un); }
      }
      if (o.phase !== undefined) {
        /* cached: this is called every frame, and rewriting an identical text
           node sixty times a second is pure waste on a Chromebook. */
        var ph = String(o.phase === null ? '' : o.phase).toUpperCase();
        if (ph !== hudPhaseShown) { hudPhaseShown = ph; txt(el.hudPhase, ph); }
      }
      var warn = !!o.warn;
      if (typeof o.warn === 'string' && o.warn) { txt(el.hudWarn, o.warn.toUpperCase()); warn = true; }
      else if (warn) txt(el.hudWarn, 'BRAKE FAILURE');
      if (warn !== el.hud.classList.contains('warn')) {
        togC(el.hud, 'warn', warn);
        if (warn) alertSay('Brake failure.');
      }
    } catch (e) {}
  };

  U.hudHide = function () { hideEl(el.hud, 'on', 460); };   /* .4s fade, then out of the layout */

  /* ================================================================== */
  /* SCENE SLATE  (CASE 1 / CASE 2, on black, between the beats)         */
  /* SCRIPT.sceneA.slate and SCRIPT.sceneB.slate were written and never     */
  /* shown, and SCRIPT.timing already reserves sceneASlateMs /             */
  /* sceneBSlateMs for them. Built here, once, with its own styles so it    */
  /* needs no new markup and no new rule. It never animates on a frame      */
  /* loop: it is put straight into its final state and taken down by a      */
  /* timer, so it is correct in a backgrounded tab and under               */
  /* prefers-reduced-motion.                                               */
  /* ================================================================== */
  var slNode = null, slText = null, slTok = 0;

  function slBuild() {
    if (slNode || !el.root) return;
    var n = mk('div', 'ui-slate'), rule = mk('span', 'ui-slate-rule'), p = mk('p', 'ui-slate-t');
    if (!n || !rule || !p) return;
    try {
      n.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;' +
        'align-items:center;justify-content:center;z-index:50;pointer-events:none;' +
        'overflow:hidden;opacity:0;';
      rule.style.cssText = 'display:block;width:clamp(44px,9vmin,120px);height:1px;' +
        'background:#ff7020;margin:0 0 clamp(14px,2.6vmin,30px);';
      /* line-height and padding are deliberately loose: this face has real
         descenders and a slate is display type. text-indent cancels the
         trailing letter-space so the line is optically centred. */
      p.style.cssText = 'margin:0;padding:.16em .2em;font-weight:700;text-transform:uppercase;' +
        'font-size:clamp(20px,4.2vmin,46px);letter-spacing:.34em;text-indent:.34em;' +
        'line-height:1.34;color:#eef3f8;text-align:center;max-width:92%;' +
        'text-shadow:0 2px 20px rgba(0,0,0,.95);';
    } catch (e) {}
    attr(n, 'aria-hidden', 'true');
    try { n.hidden = true; } catch (e2) {}
    app(n, rule); app(n, p);
    app(el.root, n);
    slNode = n; slText = p;
  }

  U.slate = function (text, ms) {
    try {
      var s = (text === null || text === undefined) ? '' : String(text);
      if (!s) { U.slateClear(); return; }
      slBuild();
      if (!slNode) return;
      txt(slText, s);
      var tok = ++slTok;
      try {
        slNode.style.transition = reduced() ? 'none' : 'opacity .5s cubic-bezier(.22,.61,.36,1)';
        slNode.hidden = false;
      } catch (e) {}
      reflow(slNode);
      /* final state first, always: if the transition never runs the slate is
         still on the screen and still correct. */
      try { slNode.style.opacity = '1'; } catch (e2) {}
      say(s);
      var hold = num(ms, 1600);
      if (hold < 400) hold = 400;
      setTimeout(function () { if (tok === slTok) U.slateClear(); }, hold);
    } catch (e) {}
  };

  U.slateClear = function () {
    try {
      var tok = ++slTok;
      if (!slNode) return;
      slNode.style.opacity = '0';
      setTimeout(function () {
        try { if (tok === slTok && slNode) slNode.hidden = true; } catch (e) {}
      }, reduced() ? 60 : 520);
    } catch (e) {}
  };

  /* ================================================================== */
  /* COUNTDOWN                                                           */
  /* ================================================================== */
  var cdCirc = 339.292, cdEnd = 0, cdDur = 0, cdRun = false,
      cdLastWhole = -1, cdTickCb = null, cdExpCb = null, cdPausedLeft = -1, cdLastOff = -1;

  U.countdown = function (seconds, onTick, onExpire) {
    try {
      U.stopCountdown();
      var s = num(seconds, 8);
      if (s <= 0) s = 8;
      cdDur = s * 1000;
      cdEnd = nowMs() + cdDur;
      cdTickCb = (typeof onTick === 'function') ? onTick : null;
      cdExpCb = (typeof onExpire === 'function') ? onExpire : null;
      cdLastWhole = -1;
      cdLastOff = -1;
      cdPausedLeft = -1;
      cdRun = true;
      remC(el.cd, 'warn'); remC(el.cd, 'crit'); remC(el.cd, 'beat');
      cdPaint(1, Math.ceil(s));
      showEl(el.cd, 'on');
      ensureTick();
    } catch (e) {}
  };

  U.stopCountdown = function () {
    try {
      cdRun = false; cdTickCb = null; cdExpCb = null; cdPausedLeft = -1;
      remC(el.cd, 'warn'); remC(el.cd, 'crit'); remC(el.cd, 'beat');
      hideEl(el.cd, 'on', 260);
    } catch (e) {}
  };

  U.countdownRunning = function () { return !!cdRun; };
  U.countdownLeft = function () { return cdRun ? Math.max(0, (cdEnd - nowMs()) / 1000) : 0; };

  function cdPaint(frac, whole) {
    try {
      var off = (1 - clamp(frac, 0, 1)) * cdCirc;
      if (cdLastOff < 0 || Math.abs(off - cdLastOff) > 0.4) {
        cdLastOff = off;
        if (el.cdArc) el.cdArc.style.strokeDashoffset = off.toFixed(1);
      }
      if (el.cdNum) {
        var s = String(Math.max(0, whole));
        if (el.cdNum.textContent !== s) el.cdNum.textContent = s;
      }
    } catch (e) {}
  }

  function cdStep() {
    if (!cdRun) return;
    var left = cdEnd - nowMs();
    if (left < 0) left = 0;
    var frac = cdDur > 0 ? (left / cdDur) : 0;
    var whole = Math.ceil(left / 1000);
    cdPaint(frac, whole);
    togC(el.cd, 'warn', left <= 3200 && left > 1400);
    togC(el.cd, 'crit', left <= 1400);
    if (whole !== cdLastWhole) {
      cdLastWhole = whole;
      remC(el.cd, 'beat');
      reflow(el.cd);
      addC(el.cd, 'beat');
      if (whole <= 3 && whole > 0) alertSay(String(whole));
      call(cdTickCb, whole, frac);
    }
    if (left <= 0) {
      cdRun = false;
      var f = cdExpCb; cdExpCb = null; cdTickCb = null;
      remC(el.cd, 'warn'); remC(el.cd, 'crit'); remC(el.cd, 'beat');
      hideEl(el.cd, 'on', 220);
      alertSay('Time.');
      call(f);
    }
  }

  function onVis() {
    try {
      if (D.hidden) {
        if (cdRun) cdPausedLeft = cdEnd - nowMs();
        bkHold = false; remC(el.brake, 'holding');
        pgKey = false;
      } else {
        if (cdRun && cdPausedLeft >= 0) { cdEnd = nowMs() + Math.max(0, cdPausedLeft); cdPausedLeft = -1; }
        tickLast = nowMs();
        ensureTick();
      }
    } catch (e) {}
  }

  function onWinBlur() {
    /* a key held while the window loses focus never gets its keyup */
    try {
      if (bkHold) { bkHold = false; remC(el.brake, 'holding'); }
      if (pgKey) { pgKey = false; pgSpring = true; remC(el.push, 'dragging'); }
      tcHoldStop();
    } catch (e) {}
  }

  /* ================================================================== */
  /* MASTER TICK  (demand-driven: it stops when nothing needs it)        */
  /* ================================================================== */
  var rafId = 0, tickLast = 0;

  function tickBusy() {
    return !!(cdRun || bkOn || pgOnFlag || subState !== 0 || tlBars || cfNodes);
  }

  function ensureTick() {
    if (rafId) return;
    tickLast = nowMs();
    try { rafId = W.requestAnimationFrame(tickLoop); } catch (e) { rafId = 0; }
  }

  /* Deterministic driver, the counterpart of Director.step(). requestAnimation
     Frame does not fire at all in a background tab, so every animated part of
     this layer — the countdown, the brake, the push hold, the typing subtitle,
     the tally bars — is unverifiable without it. Production never calls this;
     the rAF loop above owns the clock. */
  U.pumpTick = function (frames, dt) {
    frames = frames || 1; dt = dt || 1 / 60;
    for (var i = 0; i < frames; i++) {
      try { cdStep(); bkTick(dt); pgTick(dt); subTick(dt); tlTick(); cfTick(); } catch (e) {}
    }
    return frames;
  };

  function tickLoop() {
    rafId = 0;
    var t = nowMs();
    var dt = (t - tickLast) / 1000;
    tickLast = t;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.25) dt = 0.25;          /* tab-switch / GC spike guard */
    try {
      if (!D.hidden) {
        cdStep();
        bkTick(dt);
        pgTick(dt);
        subTick(dt);
        tlTick();
        cfTick();
      }
    } catch (e) {}
    if (tickBusy()) { try { rafId = W.requestAnimationFrame(tickLoop); } catch (e) { rafId = 0; } }
  }

  /* ================================================================== */
  /* CHOICES                                                             */
  /* ================================================================== */
  var chPick = null, chLocked = false, chKeys = null, chActive = false, chNodes = null;

  U.choices = function (list, onPick) {
    try {
      var wrap = el.choices;
      if (!wrap) return;
      if (!list || !list.length) { U.hideChoices(); return; }
      clear(wrap);
      chPick = (typeof onPick === 'function') ? onPick : null;
      chLocked = false;
      chKeys = {};
      chNodes = [];
      chActive = true;

      for (var i = 0; i < list.length; i++) {
        (function (item, idx) {
          if (!item) return;
          var b = mk('button', 'choice');
          if (!b) return;
          b.type = 'button';
          attr(b, 'data-id', String(item.id === undefined ? idx : item.id));
          var kk = item.key ? String(item.key) : String(idx + 1);
          var label = String(item.label || item.id || '');
          var sub = item.sub ? String(item.sub) : '';

          app(b, mk('span', 'choice-fill'));
          app(b, mk('span', 'choice-key', kk.toUpperCase()));
          app(b, mk('span', 'choice-label', label));
          /* Korean on the control the student actually presses. Both scenes
             use this component, so both get it. */
          var kLab = (typeof KO !== 'undefined' && KO.get) ? KO.get(label) : '';
          if (kLab) app(b, mk('span', 'choice-ko', kLab));
          if (sub) app(b, mk('span', 'choice-sub', sub));
          var kSub = (sub && typeof KO !== 'undefined' && KO.get) ? KO.get(sub) : '';
          if (kSub) app(b, mk('span', 'choice-subko', kSub));
          if (item.tone) addC(b, 'tone-' + String(item.tone));

          attr(b, 'aria-label', joinSay(joinSay(label, sub), 'Keyboard shortcut ' + kk));

          on(b, 'pointerdown', function (e) {
            try { if (e.pointerType === 'mouse' && e.button !== 0) return; } catch (x) {}
            addC(b, 'down');
          }, { passive: true });
          on(b, 'pointerup', function () { remC(b, 'down'); }, { passive: true });
          on(b, 'pointerleave', function () { remC(b, 'down'); }, { passive: true });
          on(b, 'pointercancel', function () { remC(b, 'down'); }, { passive: true });
          on(b, 'click', function () { commitChoice(item, b); }, false);

          chKeys[kk.toLowerCase()] = { item: item, node: b };
          if (!chKeys[String(idx + 1)]) chKeys[String(idx + 1)] = { item: item, node: b };
          chNodes.push(b);
          app(wrap, b);
        })(list[i], i);
      }
      /* The subtitle's default lane is where this strip lives, so its last
         line lands across the top of the buttons. Both cases use this
         component, so lifting it here fixes Case 1 and Case 2 together.
         MEASURED rather than a CSS constant: the strip's height depends on how
         many lines of Korean each option carries, and a fixed clamp() left the
         two boxes touching by 2 px at 695 px tall. */
      addC(el.sub, 'lift-choices');
      showEl(wrap, 'on');
      try {
        /* Measure the strip's TOP, not its height: the strip carries its own
           bottom offset (~35 px), and adding only the height left the two
           boxes overlapping by 8 px. */
        var vh = W.innerHeight || 0;
        var top = wrap.getBoundingClientRect().top;
        var lift = Math.round(vh - top) + 24;
        if (lift > 0 && lift < vh * 0.72) el.sub.style.bottom = lift + 'px';
      } catch (eL) {}
    } catch (e) {}
  };

  function commitChoice(item, node) {
    if (chLocked || !chActive) return;
    chLocked = true;
    addC(node, 'picked');
    addC(el.choices, 'locked');
    var i;
    try {
      for (i = 0; i < chNodes.length; i++) {
        if (chNodes[i] !== node) { attr(chNodes[i], 'aria-disabled', 'true'); chNodes[i].disabled = true; }
      }
    } catch (e) {}
    alertSay('Chosen: ' + String(item.label || item.id));
    var f = chPick;
    chPick = null;
    chActive = false;
    setTimeout(function () { call(f, item.id, item); }, reduced() ? 40 : 180);
  }

  U.hideChoices = function () {
    try {
      chActive = false; chPick = null; chKeys = null; chLocked = false; chNodes = null;
      remC(el.choices, 'locked');
      remC(el.sub, 'lift-choices');      /* subtitle back to its normal lane */
      try { el.sub.style.bottom = ''; } catch (eB) {}
      hideEl(el.choices, 'on', 320);
      setTimeout(function () { if (!chActive) clear(el.choices); }, reduced() ? 70 : 340);
    } catch (e) {}
  };

  /* ================================================================== */
  /* BRAKE PROMPT  (press-and-hold, dt-driven)                           */
  /* ================================================================== */
  var bkOn = false, bkCb = null, bkHold = false, bkProg = 0, bkFired = false, bkShown = -1;
  var BK_TIME = 0.62;          /* seconds of sustained hold to pull it */
  var BK_RELEASE = 0.34;       /* seconds to bleed back to zero */

  /* o = { label, sub } -- both are lesson copy (SCRIPT.sceneA.brakePrompt and
     .brakePromptSub); the markup only carries defaults. The sub-line sits in a
     wide-tracked display slot, so the view is what upper-cases it. */
  U.brakePrompt = function (onPull, o) {
    try {
      if (!el.brake) return;
      /* No callback means DISMISS. The director says UI.brakePrompt(null) in
         a_side and again at the collision to take this panel down, exactly the
         way UI.choices(null) and UI.pushGesture(null) work — but this one only
         ever showed, so "PULL THE BRAKE" sat across the wreck while the class
         watched five men die. Only UI.hideBrake() ever hid it, and nothing at
         those two sites called it. */
      if (typeof onPull !== 'function') { U.hideBrake(); return; }
      o = o || {};
      if (o.label || o.sub) {
        try {
          if (!el.brakeLabel && el.brakeBtn) el.brakeLabel = el.brakeBtn.querySelector('.bl');
          if (!el.brakeSub && el.brakeBtn) el.brakeSub = el.brakeBtn.querySelector('.bh');
        } catch (e0) {}
        if (o.label) txt(el.brakeLabel, String(o.label));
        if (o.sub) txt(el.brakeSub, String(o.sub).toUpperCase());
      }
      bkCb = (typeof onPull === 'function') ? onPull : null;
      bkOn = true; bkHold = false; bkProg = 0; bkFired = false; bkShown = -1;
      bkPaint();
      showEl(el.brake, 'on');
      say('Pull the brake. Press and hold, or hold the space bar.');
      ensureTick();
    } catch (e) {}
  };

  function bkHide() {
    bkOn = false; bkHold = false; bkCb = null; bkProg = 0;
    remC(el.brake, 'holding');
    bkPaint();
    hideEl(el.brake, 'on', 320);
  }
  U.hideBrake = bkHide;

  function bkDown(e) {
    if (!bkOn || bkFired) return;
    try { if (e.pointerType === 'mouse' && e.button !== 0) return; } catch (x) {}
    try { e.preventDefault(); } catch (x) {}
    try { if (e.currentTarget && e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId); } catch (x) {}
    bkHold = true; addC(el.brake, 'holding');
    ensureTick();
  }
  function bkUp(e) {
    if (!bkOn) return;
    try { e.preventDefault(); } catch (x) {}
    try {
      if (e.currentTarget && e.currentTarget.hasPointerCapture && e.pointerId !== undefined &&
          e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    } catch (x) {}
    bkHold = false; remC(el.brake, 'holding');
  }
  function bkTick(dt) {
    if (!bkOn || bkFired) return;
    if (bkHold) bkProg = Math.min(1, bkProg + dt / BK_TIME);
    else bkProg = Math.max(0, bkProg - dt / BK_RELEASE);
    bkPaint();
    if (bkProg >= 1) {
      bkFired = true;
      var f = bkCb;
      bkHide();
      alertSay('Brake pulled.');
      call(f);
    }
  }
  function bkPaint() {
    try {
      var v = Math.round(bkProg * 200);
      if (v === bkShown) return;
      bkShown = v;
      if (el.brakeFill) el.brakeFill.style.transform = 'scaleX(' + (v / 200).toFixed(3) + ')';
    } catch (e) {}
  }

  /* ================================================================== */
  /* PUSH GESTURE  (Scene B — the whole point of the lesson)             */
  /* ================================================================== */
  var pgOpts = null, pgOnFlag = false, pgToken = 0, pgKeysNode = null;
  var pgId = -1, pgActive = false, pgX0 = 0, pgY0 = 0, pgLX = 0, pgLY = 0,
      pgT0 = 0, pgPath = 0, pgAlong = 0, pgProg = 0, pgCommitted = false,
      pgAX = 0, pgAY = -1, pgThresh = 140, pgSpring = false, pgKey = false, pgKeyT = 0,
      pgShown = -1, pgLastCb = -1;
  var PG_KEY_HOLD = 0.9;         /* seconds of key hold == full push */
  /* The gauge doubles as the instruction, so its three states are copy. */
  var PD_IDLE = '길게 누르고 계세요';
  var PD_HOLDING = '계속 누르세요';
  var PD_SHORT = '너무 짧습니다 — 끝까지 누르고 계세요';
  var pdShortT = 0;
  var PG_STRAIGHT = 0.62;        /* along / pathLength gate */

  U.pushGesture = function (opts) {
    try {
      if (!el.push) return;
      if (opts === null || opts === false) { pgHide(); return; }
      pgOpts = opts || {};
      pgToken++;
      pgOnFlag = true;
      pgId = -1; pgActive = false; pgCommitted = false; pgSpring = false;
      pgProg = 0; pgAlong = 0; pgPath = 0; pgKey = false; pgKeyT = 0;
      pgShown = -1; pgLastCb = -1;
      remC(el.push, 'committed'); remC(el.push, 'dragging'); remC(el.push, 'near');

      if (pgOpts.axis && pgOpts.axis.length === 2) U.setPushAxis(pgOpts.axis[0], pgOpts.axis[1]);
      else U.setPushAxis(0, -1);

      pgThresh = (typeof pgOpts.threshold === 'number' && pgOpts.threshold > 0)
        ? pgOpts.threshold
        : clamp(0.22 * Math.min(vw(), vh()), 90, 220);

      /* The push panel is two full-height buttons tall; the subtitle's normal
         lane sits inside it. Lift the subtitle clear while the panel is open
         so the Korean line never lands on top of the choices. */
      addC(el.sub, 'lift');
      var pgHintEn = String(pgOpts.hint || 'PRESS AND DRAG YOUR HAND INTO HIS BACK');
      txt(el.pushHint, pgHintEn);
      txt(el.pushHintKo, (typeof KO !== 'undefined' && KO.get) ? KO.get(pgHintEn) : '');
      try { if (el.pushDoFill) el.pushDoFill.style.width = '0%'; } catch (e2) {}
      remC(el.pushDo, 'arming'); remC(el.pushDo, 'tooshort');
      txt(el.pushState, PD_IDLE);
      /* the keyboard alternative is lesson copy (SCRIPT.sceneB.pushHintKeyboard);
         Escape is THIS module's own key binding, so the module is what adds it. */
      try {
        if (!pgKeysNode && el.push) pgKeysNode = el.push.querySelector('.push-keys');
        if (pgKeysNode) {
          var kh = (typeof pgOpts.keyHint === 'string' && pgOpts.keyHint) ? pgOpts.keyHint : 'OR HOLD SPACE';
          txt(pgKeysNode, kh.toUpperCase() +
              (typeof pgOpts.onRefuse === 'function' ? '  ·  ESC TO REFUSE' : ''));
        }
      } catch (e1) {}
      /* The refuse button now carries structured spans (key / EN / KO / hint).
         Writing textContent straight onto it would wipe them, so only the
         English label span is replaced and the Korean is looked up from it. */
      (function () {
        var refEn = String(pgOpts.refuseLabel || "DON'T PUSH HIM");
        var enNode = null, koNode = null;
        try {
          enNode = el.pushRef && el.pushRef.querySelector('.pa-en');
          koNode = el.pushRef && el.pushRef.querySelector('.pa-ko');
        } catch (e2) {}
        if (enNode) {
          txt(enNode, refEn);
          if (koNode) txt(koNode, (typeof KO !== 'undefined' && KO.get) ? KO.get(refEn) : '');
        } else {
          txt(el.pushRef, refEn);      /* markup without spans: old behaviour */
        }
      })();
      pgPaint(true);
      showEl(el.push, 'on');
      say('Press and drag forward to push him. Or hold the space bar. Or press the refuse button to leave him standing.');
      ensureTick();
    } catch (e) {}
  };

  U.setPushAxis = function (x, y) {
    try {
      x = num(x, 0); y = num(y, -1);
      var L = Math.sqrt(x * x + y * y);
      if (!(L > 1e-6)) { x = 0; y = -1; L = 1; }
      pgAX = x / L; pgAY = y / L;
      /* chevrons are drawn pointing UP; rotate them onto the push axis */
      var deg = Math.atan2(pgAX, -pgAY) * 180 / Math.PI;
      if (el.push) el.push.style.setProperty('--pgrot', deg.toFixed(1) + 'deg');
    } catch (e) {}
  };

  U.pushProgress = function () { return pgProg; };

  function pgHide() {
    pgToken++;
    pgOnFlag = false; pgActive = false; pgCommitted = false; pgSpring = false;
    pgProg = 0; pgAlong = 0; pgPath = 0; pgKey = false; pgKeyT = 0; pgId = -1;
    pgPaint(true);
    remC(el.push, 'dragging'); remC(el.push, 'near'); remC(el.push, 'committed');
    remC(el.pushDo, 'arming');
    remC(el.sub, 'lift');          /* subtitle back to its normal lane */
    hideEl(el.push, 'on', 380);
    pgOpts = null;
  }
  U.hidePush = pgHide;

  function vw() {
    try { return (el.root && el.root.clientWidth) || W.innerWidth || 1280; } catch (e) { return 1280; }
  }
  function vh() {
    try { return (el.root && el.root.clientHeight) || W.innerHeight || 720; } catch (e) { return 720; }
  }

  function pgRefuse() {
    if (!pgOnFlag || pgCommitted) return;
    var o = pgOpts;
    pgHide();
    alertSay('You did not push him.');
    if (o && typeof o.onRefuse === 'function') call(o.onRefuse);
    else call(o && o.onCancel, true);
  }

  function pgDown(e) {
    if (!pgOnFlag || pgCommitted) return;
    try { if (e.pointerType === 'mouse' && e.button !== 0) return; } catch (x) {}
    if (pgActive) return;                       /* first finger wins */
    try { e.preventDefault(); } catch (x) {}
    pgActive = true; pgId = e.pointerId; pgSpring = false; pgKey = false;
    pgX0 = e.clientX; pgY0 = e.clientY; pgLX = e.clientX; pgLY = e.clientY;
    pgT0 = nowMs(); pgPath = 0; pgAlong = pgProg * pgThresh;   /* keep any key-built progress */
    addC(el.push, 'dragging');
    try { if (el.pushPad && el.pushPad.setPointerCapture) el.pushPad.setPointerCapture(e.pointerId); } catch (x) {}
    ensureTick();
  }

  function pgMove(e) {
    if (!pgActive || e.pointerId !== pgId || pgCommitted) return;
    try { e.preventDefault(); } catch (x) {}
    var pts = null;
    try { pts = e.getCoalescedEvents ? e.getCoalescedEvents() : null; } catch (x) { pts = null; }
    if (!pts || !pts.length) pts = [e];
    for (var i = 0; i < pts.length; i++) {
      var cx = pts[i].clientX, cy = pts[i].clientY;
      if (typeof cx !== 'number' || typeof cy !== 'number') continue;
      var sx = cx - pgLX, sy = cy - pgLY;
      pgLX = cx; pgLY = cy;
      pgPath += Math.sqrt(sx * sx + sy * sy);
      var dx = cx - pgX0, dy = cy - pgY0;
      var a = dx * pgAX + dy * pgAY;
      if (a > pgAlong) pgAlong = a;
    }
    pgProg = clamp(pgAlong / pgThresh, 0, 1);
    pgPaint(false);
    pgEmit();
    var dur = nowMs() - pgT0;
    if (pgProg >= 1 && dur >= 140 && dur <= 3000 && pgPath > 0 && (pgAlong / pgPath) > PG_STRAIGHT) {
      pgFire();
    }
  }

  function pgUp(e) {
    if (e.pointerId !== pgId) return;
    try { e.preventDefault(); } catch (x) {}
    pgRelease();
  }
  function pgAbort(e) {
    /* pointercancel / lostpointercapture are ALWAYS an abort, never a commit */
    if (e && e.pointerId !== undefined && e.pointerId !== pgId) return;
    pgRelease();
  }
  function pgRelease() {
    try {
      if (el.pushPad && el.pushPad.hasPointerCapture && pgId >= 0 && el.pushPad.hasPointerCapture(pgId))
        el.pushPad.releasePointerCapture(pgId);
    } catch (x) {}
    var wasActive = pgActive;
    pgActive = false; pgId = -1;
    remC(el.push, 'dragging');
    if (pgCommitted || !pgOnFlag || !wasActive) return;
    pgSpring = true;
    /* a stray tap is not a refusal: only report a real, abandoned attempt.
       Both outcomes have a written line -- onRelease for a push that was let
       go, onFail for a tap that was never a push. */
    if (pgProg > 0.05) { call(pgOpts && pgOpts.onCancel, false); call(pgOpts && pgOpts.onRelease, pgProg); }
    else call(pgOpts && pgOpts.onFail);
    ensureTick();
  }

  function pgFire() {
    if (pgCommitted || !pgOnFlag) return;
    pgCommitted = true;
    pgProg = 1; pgPaint(true); pgEmit();
    addC(el.push, 'committed');
    alertSay('You pushed him.');
    var o = pgOpts, tok = pgToken;
    setTimeout(function () {
      if (tok !== pgToken) return;         /* torn down mid-flight: do not fire */
      pgHide();
      call(o && o.onCommit);
    }, reduced() ? 40 : 130);
  }

  function pgTick(dt) {
    if (!pgOnFlag || pgCommitted) return;
    if (pgKey) {
      pgKeyT = Math.min(PG_KEY_HOLD, pgKeyT + dt);
      pgProg = clamp(pgKeyT / PG_KEY_HOLD, 0, 1);
      pgAlong = pgProg * pgThresh;
      pgPaint(false); pgEmit();
      if (pgProg >= 1) pgFire();
      return;
    }
    if (pgSpring && !pgActive) {
      var k = dt / 0.26;
      pgProg = Math.max(0, pgProg - k);
      pgKeyT = Math.max(0, pgKeyT - k * PG_KEY_HOLD);
      pgAlong = pgProg * pgThresh;
      pgPaint(false); pgEmit();
      if (pgProg <= 0) { pgSpring = false; pgPath = 0; }
    }
  }

  function pgEmit() {
    var q = Math.round(pgProg * 200);
    if (q === pgLastCb) return;
    pgLastCb = q;
    call(pgOpts && pgOpts.onProgress, pgProg);
  }

  function pgPaint(force) {
    try {
      var q = Math.round(pgProg * 200);
      if (!force && q === pgShown) return;
      pgShown = q;
      var p = q / 200;
      if (el.pushFill) el.pushFill.style.transform = 'scaleX(' + p.toFixed(3) + ')';
      if (el.pushHand) el.pushHand.style.transform = 'translateX(' + (p * 100).toFixed(2) + '%)';
      if (el.pushPct) {
        var s = Math.round(p * 100) + '%';
        if (el.pushPct.textContent !== s) el.pushPct.textContent = s;
      }
      togC(el.push, 'near', p > 0.72);
      /* the same effort, shown on the button the finger is actually on */
      if (el.pushDoFill) el.pushDoFill.style.width = (p * 100).toFixed(2) + '%';
      if (el.pushState && pgKey && !pgCommitted) {
        var ps = PD_HOLDING + '  ' + Math.round(p * 100) + '%';
        if (el.pushState.textContent !== ps) el.pushState.textContent = ps;
      }
      if (el.push) el.push.style.setProperty('--pg', p.toFixed(3));
    } catch (e) {}
  }

  /* ================================================================== */
  /* KEYBOARD ROUTER                                                     */
  /* ================================================================== */
  function isTypingTarget(t) {
    try {
      if (!t) return false;
      var tag = (t.tagName || '').toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable === true;
    } catch (e) { return false; }
  }
  function isButton(t) {
    try { return !!t && (t.tagName || '').toLowerCase() === 'button'; } catch (e) { return false; }
  }

  function onKeyDown(e) {
    try {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      var k = (e.key || '').toLowerCase();
      if (isTypingTarget(e.target)) return;

      /* never hijack the activation keys of a focused button — that would
         make the REFUSE button unusable from the keyboard */
      var onBtn = isButton(e.target) && (k === ' ' || k === 'spacebar' || k === 'enter');

      /* boot: role select */
      if (currentScreen === 'boot' && !roleFired) {
        if (k === 's') { e.preventDefault(); fireRole('student'); return; }
        if (k === 'p' || k === 't') { e.preventDefault(); fireRole('projector'); return; }
      }

      /* push: refuse */
      if (pgOnFlag && !pgCommitted && (k === 'escape' || k === 'n')) {
        e.preventDefault();
        pgRefuse();
        return;
      }

      /* push: hold to build progress */
      if (pgOnFlag && !pgCommitted && !onBtn &&
          (k === ' ' || k === 'spacebar' || k === 'enter' || k === 'arrowup' || k === 'w')) {
        e.preventDefault();
        if (e.repeat) return;
        if (!pgActive) { pgKey = true; pgSpring = false; addC(el.push, 'dragging'); ensureTick(); }
        return;
      }

      /* brake: hold */
      if (bkOn && !bkFired && !onBtn && (k === ' ' || k === 'spacebar' || k === 'b' || k === 'enter')) {
        e.preventDefault();
        if (e.repeat) return;
        bkHold = true; addC(el.brake, 'holding'); ensureTick();
        return;
      }

      /* choices: number / letter shortcuts */
      if (chActive && chKeys && !chLocked) {
        var hit = chKeys[k];
        if (hit) { e.preventDefault(); commitChoice(hit.item, hit.node); return; }
      }
    } catch (x) {}
  }

  function onKeyUp(e) {
    try {
      var k = (e.key || '').toLowerCase();
      if (pgKey && (k === ' ' || k === 'spacebar' || k === 'enter' || k === 'arrowup' || k === 'w')) {
        pgKey = false; pgSpring = true; remC(el.push, 'dragging');
        if (!pgCommitted && pgProg > 0.05) { call(pgOpts && pgOpts.onCancel, false); call(pgOpts && pgOpts.onRelease, pgProg); }
        ensureTick();
      }
      if (bkHold && (k === ' ' || k === 'spacebar' || k === 'b' || k === 'enter')) {
        bkHold = false; remC(el.brake, 'holding');
      }
    } catch (x) {}
  }

  /* ================================================================== */
  /* VERDICT CARD                                                        */
  /* ================================================================== */
  U.verdict = function (o) {
    try {
      o = o || {};
      var host = el.verdict;
      if (!host) return;
      clear(host);
      remC(host, 'in');
      host.className = 'verdict tone-' + String(o.tone || 'grave');
      app(host, mk('div', 'verdict-rule'));
      if (o.kicker) app(host, mk('p', 'verdict-kicker', String(o.kicker)));
      app(host, mk('h2', 'verdict-title', String(o.title || '')));
      app(host, mk('p', 'verdict-line', String(o.line || '')));
      if (o.foot) app(host, mk('p', 'verdict-foot', String(o.foot)));
      say(joinSay(o.title, o.line));
      /* two frames so the transition actually runs, every time */
      reflow(host);
      try {
        W.requestAnimationFrame(function () {
          W.requestAnimationFrame(function () { addC(host, 'in'); });
        });
      } catch (e) { addC(host, 'in'); }
    } catch (e) {}
  };

  /* ================================================================== */
  /* TALLY  (two grouped bar charts, dt-free eased growth)               */
  /* ================================================================== */
  var META_KEYS = { total: 1, title: 1, label: 1, quote: 1, key: 1, options: 1, n: 1, count: 1 };
  var ORDER_A = ['switch', 'turn', 'stay', 'course', 'nothing'];
  var ORDER_B = ['dont', 'no', 'refuse', 'nopush', 'push', 'yes'];
  var LABELS = {
    'switch': 'THREW THE SWITCH', 'turn': 'THREW THE SWITCH',
    'stay': 'STAYED ON COURSE', 'course': 'STAYED ON COURSE', 'nothing': 'STAYED ON COURSE',
    'push': 'PUSHED HIM', 'yes': 'PUSHED HIM',
    'dont': 'DID NOT PUSH', 'no': 'DID NOT PUSH', 'nopush': 'DID NOT PUSH', 'refuse': 'DID NOT PUSH',
    'nopush': 'DID NOT PUSH'
  };

  /* THE FOUR COMBINATIONS.  Row = case 1, column = case 2. This order and
     these letters are shared by the teacher console and by the full-screen
     hold-up card on every student device, so "hands up if you are A" and the
     A button on the console are guaranteed to mean the same thing. */
  var COMBO_ORDER = ['turn_push', 'turn_nopush', 'stay_push', 'stay_nopush'];
  var COMBO_CODE  = { turn_push: 'A', turn_nopush: 'B', stay_push: 'C', stay_nopush: 'D' };
  var COMBO_A     = { turn_push: 'turn', turn_nopush: 'turn', stay_push: 'stay', stay_nopush: 'stay' };
  var COMBO_B     = { turn_push: 'push', turn_nopush: 'nopush', stay_push: 'push', stay_nopush: 'nopush' };
  function comboParts(k) {
    k = String(k === null || k === undefined ? '' : k);
    return COMBO_CODE[k] ? { key: k, a: COMBO_A[k], b: COMBO_B[k], code: COMBO_CODE[k] } : null;
  }

  /* Integer percentages that ALWAYS sum to exactly 100 (largest remainder).
     Rounding each bar on its own is not good enough: 3 of 8 is 37.5 and 5 of 8
     is 62.5, which round to 38 and 63 -- 101% on a projector in front of a
     class. Both of those splits happen in a room of thirty. A zero can never
     collect a remainder point, because its remainder is 0 and sorts last. */
  function pctInts(vals) {
    var i, total = 0, out = [], rem = [], v;
    for (i = 0; i < vals.length; i++) total += Math.max(0, num(vals[i], 0));
    if (total <= 0) { for (i = 0; i < vals.length; i++) out.push(0); return out; }
    var used = 0;
    for (i = 0; i < vals.length; i++) {
      v = Math.max(0, num(vals[i], 0));
      var exact = v / total * 100;
      var fl = Math.floor(exact);
      out.push(fl); used += fl;
      rem.push({ i: i, r: exact - fl, v: v });
    }
    rem.sort(function (x, y) { return (y.r - x.r) || (y.v - x.v) || (x.i - y.i); });
    var left = 100 - used;
    for (i = 0; i < left && i < rem.length; i++) out[rem[i].i]++;
    return out;
  }

  function normSide(side, order, defTitle, defQuote) {
    if (!side) return null;
    var options = side.options, i, id, seen = {};
    if (!options || !options.length) {
      options = [];
      for (i = 0; i < order.length; i++) {
        id = order[i];
        if (typeof side[id] === 'number' && !seen[id]) {
          seen[id] = 1;
          options.push({ id: id, label: LABELS[id] || id.toUpperCase(), value: side[id] });
        }
      }
      for (id in side) {
        if (!Object.prototype.hasOwnProperty.call(side, id)) continue;
        if (seen[id] || META_KEYS[id]) continue;
        if (typeof side[id] !== 'number') continue;
        seen[id] = 1;
        options.push({ id: id, label: LABELS[id] || String(id).toUpperCase(), value: side[id] });
      }
    }
    if (!options.length) return null;
    return {
      title: String(side.title || side.label || defTitle),
      quote: String(side.quote || defQuote),
      options: options
    };
  }

  var tlBars = null, tlT0 = 0, tlDur = 1000;

  U.tally = function (data, opts) {
    try {
      var host = el.tally;
      if (!host) return;
      opts = opts || {};
      data = data || {};
      tlBars = null;   /* cancel any in-flight growth against detached nodes */

      /* Poll.counts() hands us
         { combos, a:{turn,stay}, b:{push,nopush}, total, mode, live }.
         Older callers hand us { a:{...}, b:{...} } only, so both are accepted. */
      var live = (typeof opts.live === 'boolean') ? opts.live
               : (typeof data.live === 'boolean') ? data.live
               : (String(data.mode || '') === 'live');
      var mineCombo = comboParts(opts.mine || data.mine);
      var yours = opts.yours || (mineCombo ? { a: mineCombo.a, b: mineCombo.b } : {});

      var charts = [];
      if (data.charts && data.charts.length) {
        charts = data.charts;
      } else {
        var a = normSide(data.a, ORDER_A, 'CASE 1 — THE DRIVER', 'Most people would say, “Turn!”');
        var b = normSide(data.b, ORDER_B, 'CASE 2 — THE BRIDGE', 'Most people would say, “Of course not.”');
        if (a) { a.key = 'a'; a.expect = 'turn'; charts.push(a); }
        if (b) { b.key = 'b'; b.expect = 'nopush'; charts.push(b); }
      }
      clear(host);
      if (!charts.length) {
        app(host, mk('p', 'tally-foot', 'No answers recorded yet.'));
        return;
      }

      var head = mk('div', 'tally-head');
      app(head, mk('h2', 'tally-title', String(opts.title || 'THIS ROOM')));
      var meta = mk('div', 'tally-meta');
      var maxTotal = 0, c0, k0, oo, s0;
      for (c0 = 0; c0 < charts.length; c0++) {
        s0 = 0; oo = charts[c0].options || [];
        for (k0 = 0; k0 < oo.length; k0++) s0 += Math.max(0, num(oo[k0].value, 0));
        if (s0 > maxTotal) maxTotal = s0;
      }
      var shownTotal = (typeof opts.total === 'number') ? opts.total
                     : (typeof data.total === 'number') ? data.total : maxTotal;
      app(meta, mk('span', 'tally-count', shownTotal + (shownTotal === 1 ? ' RESPONSE' : ' RESPONSES')));
      app(meta, mk('span', 'badge ' + (live ? 'badge-live' : 'badge-manual'),
                   live ? 'LIVE' : 'HAND COUNT'));
      app(head, meta);
      app(host, head);

      var grid = mk('div', 'tally-grid');
      var bars = [];

      for (var c = 0; c < charts.length; c++) {
        var ch = charts[c] || {};
        var col = mk('section', 'chart');
        app(col, mk('h3', 'chart-title', String(ch.title || '')));
        var q = mk('p', 'chart-quote');
        app(q, mk('span', 'chart-quote-txt', String(ch.quote || '')));
        app(col, q);

        var os = ch.options || [];
        var total = 0, i, lead = -1, leadV = -1, vals = [];
        for (i = 0; i < os.length; i++) {
          var vv = Math.max(0, num(os[i].value, 0));
          vals.push(vv);
          total += vv;
          if (vv > leadV) { leadV = vv; lead = i; }
        }
        var pcts = pctInts(vals);
        var mine = yours[ch.key || ''] || null;

        var listN = mk('div', 'bars');
        for (i = 0; i < os.length; i++) {
          var o = os[i] || {};
          var val = vals[i];
          var isMine = mine && String(mine).toLowerCase() === String(o.id).toLowerCase();

          var row = mk('div', 'bar-row');
          if (isMine) addC(row, 'is-mine');
          if (i === lead && total > 0) addC(row, 'is-lead');

          var top = mk('div', 'bar-top');
          app(top, mk('span', 'bar-label', String(o.label || o.id || '')));
          var pctN = mk('span', 'bar-pct', total > 0 ? '0%' : '—');
          app(top, pctN);
          app(row, top);

          var track = mk('div', 'bar-track');
          var fill = mk('div', 'bar-fill');
          app(track, fill);
          app(row, track);

          var foot = mk('div', 'bar-foot');
          app(foot, mk('span', 'bar-n', val + (val === 1 ? ' student' : ' students')));
          if (isMine) app(foot, mk('span', 'bar-you', 'YOU'));
          app(row, foot);

          app(listN, row);
          if (total > 0) bars.push({ fill: fill, pctN: pctN, pct: pcts[i], last: -1 });
        }
        app(col, listN);

        /* The passage, set against the real number in this room. */
        if (total > 0 && ch.expect) {
          var ei = -1;
          for (i = 0; i < os.length; i++) {
            if (String(os[i].id).toLowerCase() === ch.expect) { ei = i; break; }
          }
          if (ei >= 0) {
            var vs = mk('div', 'chart-vs');
            app(vs, mk('span', 'vs-k', 'THE PASSAGE SAYS MOST PEOPLE'));
            app(vs, mk('span', 'vs-v', String(os[ei].label || '')));
            app(vs, mk('span', 'vs-k', 'IN THIS ROOM'));
            app(vs, mk('span', 'vs-n', pcts[ei] + '%'));
            app(col, vs);
          }
        }
        app(grid, col);
      }
      app(host, grid);

      if (shownTotal <= 0) {
        app(host, mk('p', 'tally-foot', 'No answers yet. Count the room on the teacher console, or wait for the devices.'));
      } else if (opts.foot) {
        app(host, mk('p', 'tally-foot', String(opts.foot)));
      }

      /* What A/B/C/D actually mean. The letters are on the student's screen
         and on the teacher's console, and until now the class chart never
         said what they stood for. */
      U.abcdLegend(host);

      tlBars = bars.length ? bars : null;
      tlT0 = nowMs();
      tlDur = reduced() ? 220 : 1050;
      tlTick();
      ensureTick();
      say('Class results are on screen. ' + shownTotal + (shownTotal === 1 ? ' response.' : ' responses.'));
    } catch (e) { tlBars = null; }
  };

  function tlTick() {
    if (!tlBars) return;
    var k = clamp((nowMs() - tlT0) / tlDur, 0, 1);
    var e2 = 1 - Math.pow(1 - k, 3);
    for (var j = 0; j < tlBars.length; j++) {
      var b = tlBars[j];
      var v = b.pct * e2;
      try {
        /* land exactly on the largest-remainder integer, never on a re-rounded
           animation frame, so the column always reads 100% in total */
        b.fill.style.width = (k >= 1 ? b.pct : v).toFixed(2) + '%';
        var r = (k >= 1) ? b.pct : Math.round(v);
        if (r !== b.last) { b.last = r; b.pctN.textContent = r + '%'; }
      } catch (e) {}
    }
    if (k >= 1) tlBars = null;
  }

  /* ================================================================== */
  /* TEACHER CONSOLE                                                     */
  /* ================================================================== */
  var tcState = null, tcOpts = null, tcRefs = null, tcTotalNode = null,
      tcRepT = 0, tcRepDelay = 0, tcFsBtn = null, tcBadge = null,
      tcDerived = null, tcResetArmed = 0, tcArmT = 0,
      /* D5. tcUnsub drops the console's subscription to the store whenever the
         console is rebuilt, so re-entering the teacher beat can never leave a
         second listener painting into detached nodes. tcWriting is raised only
         while OUR OWN write is travelling out to the store, so the echo that
         comes straight back can be recognised for what it is. */
      tcUnsub = null, tcWriting = 0;

  function tcHoldStop() {
    try { if (tcRepDelay) { clearTimeout(tcRepDelay); tcRepDelay = 0; } } catch (e) {}
    try { if (tcRepT) { clearInterval(tcRepT); tcRepT = 0; } } catch (e) {}
  }
  function tcHoldStart(fn) {
    tcHoldStop();
    call(fn);
    try {
      tcRepDelay = setTimeout(function () {
        tcRepDelay = 0;
        tcRepT = setInterval(function () { call(fn); }, 110);
      }, 420);
    } catch (e) {}
  }

  /* True when a store snapshot carries exactly the four numbers that are
     already on screen. Used to recognise the echo of our own write. We do NOT
     blanket-ignore emits while writing: if the store ever disagrees with us --
     it clamped, it rejected, a vote landed in the same turn -- the STORE wins
     and we repaint. That is what makes it the single source of truth. */
  function tcEcho(snap) {
    if (!tcState || !snap) return false;
    var src = snap.combos || snap;
    for (var i = 0; i < COMBO_ORDER.length; i++) {
      var k = COMBO_ORDER[i];
      var v = Number(src[k]);
      if (!isFinite(v)) return false;
      if (Math.max(0, Math.floor(v)) !== Math.max(0, Math.floor(num(tcState[k], 0)))) return false;
    }
    return true;
  }

  /* The stepper path, and the reason the buttons still feel instant: paint the
     optimistic local value FIRST, then push it to the store. The store re-emits
     synchronously, and tcWriting lets the subscriber below tell that echo apart
     from a genuine change. Every OTHER emit -- a restored hand count, a vote
     from another device, a reset -- lands and repaints. */
  function tcEmit() {
    tcPaint();
    tcWriting++;
    try { call(tcOpts && tcOpts.onChange, U.teacherCounts()); }
    finally { tcWriting--; if (tcWriting < 0) tcWriting = 0; }
  }

  function tcPaint() {
    if (!tcRefs || !tcState) return;
    var i, k, tot = 0;
    for (i = 0; i < tcRefs.length; i++) {
      var r = tcRefs[i];
      try {
        var s = String(Math.max(0, Math.floor(num(tcState[r.id], 0))));
        if (r.node.textContent !== s) r.node.textContent = s;
      } catch (e) {}
    }
    for (k in tcState) {
      if (Object.prototype.hasOwnProperty.call(tcState, k)) tot += Math.max(0, num(tcState[k], 0));
    }
    try { if (tcTotalNode) tcTotalNode.textContent = String(tot); } catch (e) {}

    /* Scene A and Scene B, derived from the four combinations so they always
       add up to the same total and their percentages always make 100. */
    var turn = num(tcState.turn_push, 0) + num(tcState.turn_nopush, 0);
    var stay = num(tcState.stay_push, 0) + num(tcState.stay_nopush, 0);
    var push = num(tcState.turn_push, 0) + num(tcState.stay_push, 0);
    var nop  = num(tcState.turn_nopush, 0) + num(tcState.stay_nopush, 0);
    if (tcDerived) {
      try {
        var pa = pctInts([turn, stay]), pb = pctInts([push, nop]);
        tcDerived.turn.textContent = String(turn);
        tcDerived.stay.textContent = String(stay);
        tcDerived.push.textContent = String(push);
        tcDerived.nop.textContent  = String(nop);
        tcDerived.turnP.textContent = tot > 0 ? pa[0] + '%' : '—';
        tcDerived.stayP.textContent = tot > 0 ? pa[1] + '%' : '—';
        tcDerived.pushP.textContent = tot > 0 ? pb[0] + '%' : '—';
        tcDerived.nopP.textContent  = tot > 0 ? pb[1] + '%' : '—';
      } catch (e) {}
    }
  }

  U.teacherConsole = function (opts) {
    try {
      var host = el.teacher;
      if (!host) return;
      tcOpts = opts || {};
      tcHoldStop();
      tcResetArmed = 0;

      /* The console counts THE FOUR COMBINATIONS, never the two cases
         separately: Scene A and Scene B are derived from these four, so the
         two charts can never disagree with each other or with the total. */
      var c = tcOpts.counts || {};
      var src = c.combos || c;
      tcState = {
        turn_push:   Math.max(0, Math.floor(num(src.turn_push, 0))),
        turn_nopush: Math.max(0, Math.floor(num(src.turn_nopush, 0))),
        stay_push:   Math.max(0, Math.floor(num(src.stay_push, 0))),
        stay_nopush: Math.max(0, Math.floor(num(src.stay_nopush, 0)))
      };
      tcRefs = [];
      tcDerived = null;
      clear(host);

      var head = mk('div', 'tc-head');
      app(head, mk('h2', 'tc-title', 'TEACHER CONSOLE'));
      tcBadge = mk('span', 'badge ' + (tcOpts.live ? 'badge-live' : 'badge-manual'),
                   tcOpts.live ? 'LIVE · DEVICES REPORTING' : 'MANUAL · COUNT THE ROOM');
      app(head, tcBadge);
      app(host, head);
      app(host, mk('p', 'tc-hint',
        'Every student screen ends on these same two lines, on a colour. Call one ' +
        'card at a time — the colour, or the letter — and tap its +. ' +
        'Hold a button down to count fast.'));
      app(host, mk('p', 'tc-hint tc-hint-ko',
        '학생 화면도 아래와 똑같이 ① 한 일, ② 한 일 두 줄로 끝납니다. 색이 같으면 같은 칸입니다. ' +
        '“주황색 든 사람” 또는 “A인 사람” 하고 한 칸씩 부른 뒤 그 칸의 + 를 누르세요. ' +
        '길게 누르면 빠르게 올라갑니다.'));

      var g;
      var grid = mk('div', 'tc-grid tc-grid-4');
      for (g = 0; g < COMBO_ORDER.length; g++) {
        (function (key) {
          var code = COMBO_CODE[key];
          var box = mk('section', 'tc-box tc-combo tc-code-' + code);

          var bh = mk('div', 'tc-combo-head');
          app(bh, mk('span', 'tc-code', code));
          /* Same "1. did this / 2. did that" block the student is holding up,
             so the teacher matches statements to screens instead of decoding
             a letter on both sides. */
          app(bh, comboBlock(key, 'cw-tc'));
          app(box, bh);

          var bump = function (delta) {
            return function () {
              if (!tcState) return;
              tcState[key] = clamp(Math.floor(num(tcState[key], 0)) + delta, 0, 999);
              tcEmit();
            };
          };
          var mkBtn = function (label, delta, cls2) {
            var b = mk('button', 'tc-btn ' + (cls2 || ''), label);
            b.type = 'button';
            attr(b, 'aria-label', (delta > 0 ? 'Add ' : 'Subtract ') + Math.abs(delta) +
                 ' to ' + code + ', ' + LABELS[COMBO_A[key]] + ', ' + LABELS[COMBO_B[key]]);
            var fn = bump(delta);
            on(b, 'pointerdown', function (e) {
              try { if (e.pointerType === 'mouse' && e.button !== 0) return; e.preventDefault(); } catch (x) {}
              try { if (b.setPointerCapture) b.setPointerCapture(e.pointerId); } catch (x) {}
              tcHoldStart(fn);
            }, { passive: false });
            on(b, 'pointerup', tcHoldStop, { passive: true });
            on(b, 'pointercancel', tcHoldStop, { passive: true });
            on(b, 'lostpointercapture', tcHoldStop, { passive: true });
            /* keyboard-generated clicks have detail === 0; pointer clicks are
               already handled by pointerdown, so this never double-counts */
            on(b, 'click', function (e) { if (!e || !e.detail) fn(); }, false);
            return b;
          };

          var stepper = mk('div', 'tc-stepper');
          app(stepper, mkBtn('−5', -5, 'wide'));
          app(stepper, mkBtn('−', -1, 'big'));
          var numN = mk('span', 'tc-num', String(tcState[key]));
          attr(numN, 'aria-live', 'off');
          app(stepper, numN);
          app(stepper, mkBtn('+', 1, 'big'));
          app(stepper, mkBtn('+5', 5, 'wide'));
          app(box, stepper);

          app(grid, box);
          tcRefs.push({ id: key, node: numN });
        })(COMBO_ORDER[g]);
      }
      app(host, grid);

      /* Derived Scene A / Scene B readout — what the class will actually see. */
      var der = mk('div', 'tc-derived');
      var derRow = function (title, l1, l2) {
        var r = mk('div', 'tc-der-row');
        app(r, mk('span', 'tc-der-t', title));
        var cell1 = mk('span', 'tc-der-cell');
        app(cell1, mk('span', 'tc-der-l', l1));
        var n1 = mk('span', 'tc-der-n', '0'); app(cell1, n1);
        var p1 = mk('span', 'tc-der-p', '—'); app(cell1, p1);
        var cell2 = mk('span', 'tc-der-cell');
        app(cell2, mk('span', 'tc-der-l', l2));
        var n2 = mk('span', 'tc-der-n', '0'); app(cell2, n2);
        var p2 = mk('span', 'tc-der-p', '—'); app(cell2, p2);
        app(r, cell1); app(r, cell2);
        app(der, r);
        return [n1, p1, n2, p2];
      };
      var rA = derRow('CASE 1 — THE DRIVER', LABELS['turn'], LABELS['stay']);
      var rB = derRow('CASE 2 — THE BRIDGE', LABELS['push'], LABELS['nopush']);
      tcDerived = {
        turn: rA[0], turnP: rA[1], stay: rA[2], stayP: rA[3],
        push: rB[0], pushP: rB[1], nop: rB[2], nopP: rB[3]
      };
      app(host, der);

      var totRow = mk('div', 'tc-total');
      app(totRow, mk('span', 'tc-total-label', 'TOTAL COUNTED'));
      tcTotalNode = mk('span', 'tc-total-num', '0');
      app(totRow, tcTotalNode);
      app(host, totRow);

      var acts = mk('div', 'tc-actions');
      var addAct = function (label, fn, kind) {
        var b = mk('button', 'tc-act ' + (kind || ''), label);
        b.type = 'button';
        on(b, 'click', fn, false);
        app(acts, b);
        return b;
      };

      /* Reset erases a whole lesson's count in front of a class, so it takes
         two taps. A modal confirm() can be suppressed inside an embedded page;
         an armed button cannot be, and it disarms itself after four seconds. */
      var resetBtn = null;
      resetBtn = addAct('RESET', function () {
        if (!tcResetArmed) {
          tcResetArmed = 1;
          try { resetBtn.textContent = 'TAP AGAIN TO ERASE'; addC(resetBtn, 'armed'); } catch (e) {}
          try { if (tcArmT) clearTimeout(tcArmT); } catch (e) {}
          try {
            tcArmT = setTimeout(function () {
              tcArmT = 0; tcResetArmed = 0;
              try { resetBtn.textContent = 'RESET'; remC(resetBtn, 'armed'); } catch (e) {}
            }, 4000);
          } catch (e) {}
          U.say('Tap reset again to erase the tally.');
          return;
        }
        tcResetArmed = 0;
        try { if (tcArmT) { clearTimeout(tcArmT); tcArmT = 0; } } catch (e) {}
        try { resetBtn.textContent = 'RESET'; remC(resetBtn, 'armed'); } catch (e) {}
        tcState = { turn_push: 0, turn_nopush: 0, stay_push: 0, stay_nopush: 0 };
        tcEmit();
        call(tcOpts.onReset);
        U.toast('Tally erased', 'info');
      }, 'ghost');

      tcFsBtn = addAct('FULLSCREEN', function () { call(tcOpts.onFullscreen); }, 'ghost');
      if (typeof tcOpts.onBack === 'function') addAct('BACK', function () { call(tcOpts.onBack); }, 'ghost');
      /* the jump to the reveal, always present */
      addAct('SHOW THE CLASS →', function () { call(tcOpts.onAdvance, U.teacherCounts()); }, 'primary');
      app(host, acts);

      tcPaint();

      /* ---------------------------------------------------------------- D5
         RENDER FROM THE STORE. The console used to be one-way: taps went into
         Poll and nothing ever came back, so Poll.setManual() from anywhere
         else moved the tally while all four cards, the derived Scene A/B row,
         the total and the badge went on showing whatever they were built with.
         opts.subscribe is Poll.onChange, which fires ONCE IMMEDIATELY with the
         current snapshot -- so a freshly built console is corrected on the
         spot, which is what makes a reload that restored a hand count come up
         right -- and again on every later change, which covers a live vote
         arriving and Poll.reset(). It returns an unsubscribe; drop the previous
         one first so a rebuild never stacks a second listener.
         The subscriber only PAINTS. It never calls tcEmit, so no write-back,
         no loop. */
      try { if (tcUnsub) { tcUnsub(); tcUnsub = null; } } catch (e) {}
      var tcSub = tcOpts.subscribe;
      if (typeof tcSub !== 'function' &&
          window.Poll && typeof window.Poll.onChange === 'function') {
        /* Belt and braces: if a caller ever forgets to hand us a subscription,
           read the store directly rather than silently going one-way again. */
        tcSub = function (fn) { return window.Poll.onChange(fn, 'teacher-console'); };
      }
      if (typeof tcSub === 'function') {
        try {
          tcUnsub = tcSub(function (snap) {
            if (!snap) return;
            if (tcWriting && tcEcho(snap)) return;   /* already on screen */
            U.setTeacherCounts(snap);
            if (typeof snap.live === 'boolean') U.setLive(snap.live);
          });
        } catch (e) { tcUnsub = null; }
      }
    } catch (e) {}
  };

  /* The four entered numbers, plus every total derived from them. */
  U.teacherCounts = function () {
    try {
      if (!tcState) return null;
      var tp = Math.max(0, Math.floor(num(tcState.turn_push, 0)));
      var tn = Math.max(0, Math.floor(num(tcState.turn_nopush, 0)));
      var sp = Math.max(0, Math.floor(num(tcState.stay_push, 0)));
      var sn = Math.max(0, Math.floor(num(tcState.stay_nopush, 0)));
      return {
        combos: { turn_push: tp, turn_nopush: tn, stay_push: sp, stay_nopush: sn },
        turn_push: tp, turn_nopush: tn, stay_push: sp, stay_nopush: sn,
        a: { turn: tp + tn, stay: sp + sn },
        b: { push: tp + sp, nopush: tn + sn },
        total: tp + tn + sp + sn
      };
    } catch (e) { return null; }
  };

  U.setTeacherCounts = function (counts) {
    try {
      if (!tcState || !counts) return;
      var src = counts.combos || counts;
      for (var i = 0; i < COMBO_ORDER.length; i++) {
        var k = COMBO_ORDER[i];
        var v = Number(src[k]);
        if (isFinite(v)) tcState[k] = Math.max(0, Math.floor(v));
      }
      tcPaint();
    } catch (e) {}
  };

  U.setLive = function (live) {
    try {
      if (!tcBadge) return;
      tcBadge.className = 'badge ' + (live ? 'badge-live' : 'badge-manual');
      tcBadge.textContent = live ? 'LIVE · DEVICES REPORTING' : 'MANUAL · COUNT THE ROOM';
    } catch (e) {}
  };

  U.setFullscreenState = function (isFull) {
    try { if (tcFsBtn) tcFsBtn.textContent = isFull ? 'EXIT FULLSCREEN' : 'FULLSCREEN'; } catch (e) {}
  };

  /* ================================================================== */
  /* HOLD-UP CARD — the student-side counting aid                        */
  /* When nothing syncs (the normal case: thirty anonymous, read-only     */
  /* viewers) the teacher has to count the room by eye. Every student     */
  /* device therefore ENDS on one full-screen colour and one huge letter, */
  /* so counting a class of thirty is four glances instead of four        */
  /* hand-counts. Four fields that stay inside the palette: the hi-vis    */
  /* orange the whole piece is built on, bone, the system teal, and a     */
  /* cold slate — all four separable at the back of a classroom, and all  */
  /* four still legible on a bad Chromebook panel.                        */
  /* ================================================================== */
  var CARD_COPY = {
    turn_push:   { a: 'THREW THE SWITCH', b: 'PUSHED HIM' },
    turn_nopush: { a: 'THREW THE SWITCH', b: 'DID NOT PUSH' },
    stay_push:   { a: 'STAYED ON COURSE', b: 'PUSHED HIM' },
    stay_nopush: { a: 'STAYED ON COURSE', b: 'DID NOT PUSH' }
  };

  U.cardCode = function (combo) { return COMBO_CODE[String(combo || '')] || ''; };

  /* ==================================================================
     WHAT THEY DID, numbered by case.

     A/B/C/D is a code the room has to decode before it means anything —
     the student holding the screen, the teacher calling the count and
     anyone reading the class chart all had to remember that B was
     "switch, then no push". Leading with the two numbered statements
     removes that step: the card says what the person did, in order.
     The letter survives only as a small tag, because a one-syllable call
     ("A인 사람") is still the fastest way to count thirty screens, and
     the COLOUR does the real work of being countable across a room.
     ================================================================== */
  var CASE_LABEL = ['CASE 1', 'CASE 2'];
  var CASE_KO = ['사례 1', '사례 2'];
  function comboBlock(key, cls) {
    var g = mk('div', 'cw' + (cls ? ' ' + cls : ''));
    if (!g) return null;
    var en = [LABELS[COMBO_A[key]] || '', LABELS[COMBO_B[key]] || ''];
    for (var i = 0; i < 2; i++) {
      var row = mk('div', 'cw-row');
      app(row, mk('span', 'cw-n', String(i + 1)));
      var t = mk('span', 'cw-t');
      app(t, mk('span', 'cw-case', CASE_KO[i] + '  ·  ' + CASE_LABEL[i]));
      var ko = (typeof KO !== 'undefined' && KO.get) ? KO.get(en[i]) : '';
      app(t, mk('span', 'cw-did', ko || en[i]));
      if (ko) app(t, mk('span', 'cw-did-en', en[i]));
      app(row, t);
      app(g, row);
    }
    return g;
  }
  /* Plain-text form for screen readers and aria labels. */
  function comboWords(key, sep) {
    var ko1 = (typeof KO !== 'undefined' && KO.get) ? KO.get(LABELS[COMBO_A[key]]) : '';
    var ko2 = (typeof KO !== 'undefined' && KO.get) ? KO.get(LABELS[COMBO_B[key]]) : '';
    return '1. ' + (ko1 || LABELS[COMBO_A[key]]) + (sep || '  ') +
           '2. ' + (ko2 || LABELS[COMBO_B[key]]);
  }

  U.holdUpCard = function (combo, opts) {
    try {
      var host = el.card;
      if (!host) return;
      opts = opts || {};
      var key = String(combo || '');
      if (!COMBO_CODE[key]) key = 'stay_nopush';
      var code = COMBO_CODE[key];
      var cp = CARD_COPY[key];

      clear(host);
      var i;
      for (i = 0; i < COMBO_ORDER.length; i++) remC(el.scrCard, 'card-' + COMBO_CODE[COMBO_ORDER[i]]);
      addC(el.scrCard, 'card-' + code);

      app(host, mk('p', 'card-kicker', String(opts.kicker || 'HOLD YOUR SCREEN UP')));
      app(host, mk('p', 'card-kicker-ko', '화면을 들어 주세요'));
      /* The two statements ARE the identity now; the letter is a small tag in
         the corner for the teacher's call, not the headline. */
      app(host, comboBlock(key, 'cw-card'));
      app(host, mk('div', 'card-code', code));

      if (typeof opts.onNext === 'function') {
        var btn = mk('button', 'card-next', String(opts.nextLabel || 'SHOW ME THE CLASS →'));
        btn.type = 'button';
        on(btn, 'click', function () { call(opts.onNext); }, false);
        app(host, btn);
      }

      say('Case one, ' + cp.a + '. Case two, ' + cp.b +
          '. Your card is ' + code + '. Hold your screen up so it can be counted.');
    } catch (e) {}
  };

  /* A visible way off the reveal screen. It lives outside #ui-tally so a
     re-render of the tally (every time the teacher moves a stepper) does not
     wipe the button out from under the projector. */
  U.revealAdvance = function (cb, label) {
    try {
      var host = el.revealActs;
      if (!host) return;
      clear(host);
      if (typeof cb !== 'function') { remC(host, 'on'); return; }
      var b = mk('button', 'reveal-next', String(label || 'CONTINUE →'));
      b.type = 'button';
      on(b, 'click', function () { call(cb); }, false);
      app(host, b);
      addC(host, 'on');
    } catch (e) {}
  };

  /* ================================================================== */
  /* CONFRONT                                                            */
  /* ================================================================== */
  var STMT = {
    'switch': 'YOU THREW THE SWITCH.',
    'turn': 'YOU THREW THE SWITCH.',
    'stay': 'YOU STAYED ON COURSE.',
    'course': 'YOU STAYED ON COURSE.',
    'nothing': 'YOU STAYED ON COURSE.',
    'push': 'YOU PUSHED HIM OFF THE BRIDGE.',
    'yes': 'YOU PUSHED HIM OFF THE BRIDGE.',
    'dont': 'YOU DID NOT PUSH HIM.',
    'nopush': 'YOU DID NOT PUSH HIM.',
    'no': 'YOU DID NOT PUSH HIM.',
    'refuse': 'YOU DID NOT PUSH HIM.',
    'nopush': 'YOU DID NOT PUSH HIM.'
  };
  var SUBT = {
    'switch': 'One worker died. Five went home.',
    'turn': 'One worker died. Five went home.',
    'stay': 'Five workers died. You touched nothing.',
    'course': 'Five workers died. You touched nothing.',
    'nothing': 'Five workers died. You touched nothing.',
    'push': 'One man died. Five went home.',
    'yes': 'One man died. Five went home.',
    'dont': 'Five workers died. Your hands stayed clean.',
    'nopush': 'Five workers died. Your hands stayed clean.',
    'no': 'Five workers died. Your hands stayed clean.',
    'refuse': 'Five workers died. Your hands stayed clean.',
    'nopush': 'Five workers died. Your hands stayed clean.'
  };
  function normId(x) { return String(x === null || x === undefined ? '' : x).toLowerCase(); }
  function killedOne(id) { return id === 'switch' || id === 'turn' || id === 'push' || id === 'yes'; }

  function contradiction(a, b) {
    var A = killedOne(a), B = killedOne(b);
    if (A && !B) return 'You sacrificed one life to save five — and then you refused to sacrifice one life to save five. The arithmetic never changed. Only your hands did.';
    if (!A && B) return 'You would not steer one death onto one man — and then you shoved a man into it with your own hands. The arithmetic never changed. Only your hands did.';
    if (A && B) return 'Twice you chose the arithmetic. Twice you decided a person could be the smaller number. Most people cannot do it the second time. You did.';
    return 'Twice you refused to act. Twice, five people died while you decided that not choosing was cleaner than choosing. Silence was also a choice, and you made it twice.';
  }

  var cfNodes = null, cfT0 = 0, cfGap = 420, cfDone = 0, cfTok = 0;

  /* Put every remaining line into its final state at once. The staggered
     entrance is the nice path, not the only one: these elements start at
     opacity 0, so if the frame loop never runs (hidden tab, throttled rAF,
     an interrupted transition) the closing question would never appear at
     all -- and it is the last thing the room sees. */
  function cfFinishAll() {
    if (!cfNodes) return;
    for (var i = cfDone; i < cfNodes.length; i++) addC(cfNodes[i], 'in');
    cfDone = cfNodes.length;
    cfNodes = null;
  }

  /* SCRIPT.confront.closingQuestion carries .lines: the projector-safe
     wrapping the copy was written to, verified by SCRIPT.util.selfTest to
     rejoin to .text exactly. Honour it exactly -- one authored line per
     line, centred, no orphan word -- but only where there is real width for
     it; on a narrow or portrait screen the authored ~55-character lines
     would wrap a second time and read as rag, so it falls back to the
     paragraph and lets the 34ch measure do the wrapping. */
  function cfQuestionLines(qwrap, lines) {
    try {
      if (!qwrap || !lines || !lines.length) return;
      var p = qwrap.firstChild;
      if (!p || !p.style) return;
      if (vw() < 700 || vw() < vh()) return;
      var i, s, longest = 0, made = [];
      for (i = 0; i < lines.length; i++) {
        s = (lines[i] === null || lines[i] === undefined) ? '' : String(lines[i]);
        if (!s) continue;
        var ln = mk('span', 'cf-qline', s);
        if (!ln) return;
        try { ln.style.display = 'block'; } catch (e1) {}
        made.push(ln);
        if (s.length > longest) longest = s.length;
      }
      if (!made.length) return;
      clear(p);
      for (i = 0; i < made.length; i++) app(p, made[i]);
      try {
        /* one em of slack, and never wider than the column it sits in */
        p.style.maxWidth = 'min(100%,' + (longest + 2) + 'ch)';
        p.style.textAlign = 'center';
      } catch (e2) {}
    } catch (e) {}
  }

  U.confront = function (payload) {
    try {
      var host = el.confront;
      if (!host) return;
      payload = payload || {};
      cfNodes = null;
      /* SCRIPT.confront.closingQuestion is an OBJECT {text, lines, cite}, never
         a string: String()ing it printed '[object Object]' as the closing
         question on the projector. Accept the object, a bare string, or
         nothing, keep the authored line breaks, and take the citation off it. */
      var qLines = null;
      (function () {
        var q = payload.question;
        if (q && typeof q === 'object') {
          if (q.lines && q.lines.length) qLines = q.lines;
          if (!payload.attribution && q.cite) payload.attribution = q.cite;
          q = (typeof q.text === 'string' && q.text) ? q.text
            : (qLines ? qLines.join(' ') : '');
        }
        payload.question = (typeof q === 'string') ? q : '';
      })();
      var a = normId(payload.a), b = normId(payload.b);
      clear(host);

      app(host, mk('p', 'cf-kicker', String(payload.kicker || 'YOUR TWO ANSWERS')));

      var pair = mk('div', 'cf-pair');
      var mkStmt = function (n, id, auto) {
        var box = mk('div', 'cf-stmt' + (killedOne(id) ? ' acted' : ''));
        app(box, mk('span', 'cf-n', n));
        app(box, mk('p', 'cf-line', STMT[id] || 'YOU MADE NO CHOICE.'));
        var s = SUBT[id] || '';
        if (auto) s = (s ? s + ' ' : '') + 'You said nothing. Silence chose for you.';
        app(box, mk('p', 'cf-sub', s));
        return box;
      };
      app(pair, mkStmt('01', a, !!payload.aAuto));
      app(pair, mkStmt('02', b, !!payload.bAuto));
      app(host, pair);

      app(host, mk('div', 'cf-rule'));
      app(host, mk('p', 'cf-verdict', String(payload.contradiction || contradiction(a, b))));

      var qwrap = mk('div', 'cf-question');
      app(qwrap, mk('p', 'cf-q', String(payload.question ||
        'Why does the principle that seems right in the first case — sacrifice one life to save five — seem wrong in the second?')));
      app(host, qwrap);
      app(host, mk('p', 'cf-attr', String(payload.attribution || 'Michael Sandel, “Justice”')));
      cfQuestionLines(qwrap, qLines);
      if (payload.afterword) app(host, mk('p', 'cf-attr cf-after', String(payload.afterword)));

      var list = host.querySelectorAll('.cf-kicker, .cf-stmt, .cf-rule, .cf-verdict, .cf-question, .cf-attr');
      cfNodes = [];
      for (var i = 0; i < list.length; i++) cfNodes.push(list[i]);
      cfT0 = nowMs();
      cfGap = reduced() ? 70 : 430;
      cfDone = 0;
      cfTok++;
      if (reduced() || D.hidden) { cfFinishAll(); }
      else {
        ensureTick();
        /* backstop: timers fire where rAF does not */
        (function (tok, n) {
          setTimeout(function () { if (tok === cfTok) cfFinishAll(); }, 140 + n * cfGap + 800);
        })(cfTok, cfNodes.length);
      }

      /* the closing question is the last thing the room gets: it is read out
         too, not just drawn. */
      say('Your two answers. ' + (STMT[a] || 'You made no choice.') + ' ' + (STMT[b] || 'You made no choice.') +
          (payload.question ? ' ' + payload.question : ''));
    } catch (e) { cfNodes = null; }
  };

  function cfTick() {
    if (!cfNodes) return;
    var t = nowMs() - cfT0;
    while (cfDone < cfNodes.length && t >= 140 + cfDone * cfGap) {
      addC(cfNodes[cfDone], 'in');
      cfDone++;
    }
    if (cfDone >= cfNodes.length) cfNodes = null;
  }

  /* ================================================================== */
  /* REVEAL ADVANCE                                                      */
  /* The director needs a way off the tally screen that is not a keypress
     (a projector is driven by a mouse, and Enter was undocumented).
     Absolutely positioned inside #scr-reveal (which is position:absolute)
     so it never fights the tally's own scroll box for vertical room, and
     it reuses .tc-actions/.tc-act.primary so it needs no new CSS.        */
  /* ================================================================== */
  var raWrap = null, raBtn = null, raCb = null, raFired = false;

  function raHide() {
    raCb = null;
    try { if (raWrap) raWrap.style.display = 'none'; } catch (e) {}
  }
  U.hideRevealAdvance = raHide;

  U.revealAdvance = function (onAdvance, label) {
    try {
      var host = el.scrReveal;
      if (!host) return;
      if (typeof onAdvance !== 'function') { raHide(); return; }
      raCb = onAdvance;
      raFired = false;
      if (!raBtn) {
        raWrap = mk('div', 'tc-actions');
        raBtn = mk('button', 'tc-act primary', 'CONTINUE');
        if (!raWrap || !raBtn) { raWrap = null; raBtn = null; return; }
        raBtn.type = 'button';
        try {
          raWrap.style.position = 'absolute';
          raWrap.style.right = 'clamp(16px,4vmin,54px)';
          raWrap.style.bottom = 'clamp(16px,4vmin,54px)';
          raWrap.style.margin = '0';
          raWrap.style.zIndex = '2';
        } catch (e) {}
        on(raBtn, 'click', function () {
          if (raFired) return;
          var f = raCb;
          if (!f) return;
          raFired = true;
          raHide();
          call(f);
        }, false);
        app(raWrap, raBtn);
        app(host, raWrap);
      }
      txt(raBtn, String(label || 'CONTINUE'));
      attr(raBtn, 'aria-label', joinSay(label || 'Continue', 'Shows the closing question.'));
      try { raWrap.style.display = ''; } catch (e) {}
    } catch (e) {}
  };

  /* ==================================================================
     SCREEN ACTIONS — bottom-left buttons on a screen that has finished.
     The lesson had no way back: once the projector advanced past the
     console there was no return, and the last screen had no way to run
     the film again for the next class.
     ================================================================== */
  var saWraps = {};
  U.screenActions = function (screen, buttons) {
    try {
      var host = ({ reveal: el.scrReveal, confront: el.scrConf, card: el.scrCard, teacher: el.scrTeach })[screen];
      if (!host) return;
      var w = saWraps[screen];
      if (w && w.parentNode) { try { w.parentNode.removeChild(w); } catch (e) {} }
      saWraps[screen] = null;
      if (!buttons || !buttons.length) return;
      w = mk('div', 'scr-actions');
      if (!w) return;
      for (var i = 0; i < buttons.length; i++) {
        (function (b) {
          if (!b || typeof b.onClick !== 'function') return;
          var btn = mk('button', 'scr-act' + (b.primary ? ' primary' : ''));
          if (!btn) return;
          btn.type = 'button';
          app(btn, mk('span', 'sa-en', String(b.label || '')));
          var ko = b.ko || ((typeof KO !== 'undefined' && KO.get) ? KO.get(b.label) : '');
          if (ko) app(btn, mk('span', 'sa-ko', ko));
          attr(btn, 'aria-label', joinSay(b.label, ko));
          on(btn, 'click', function () { call(b.onClick); }, false);
          app(w, btn);
        })(buttons[i]);
      }
      app(host, w);
      saWraps[screen] = w;
    } catch (e) {}
  };

  /* ==================================================================
     A/B/C/D LEGEND
     The four letters appear on the student's screen, on the teacher's
     console and on the class chart, and nothing said what they meant.
     ================================================================== */
  U.abcdLegend = function (host) {
    try {
      if (!host) return null;
      var g = mk('div', 'abcd');
      if (!g) return null;
      for (var i = 0; i < COMBO_ORDER.length; i++) {
        var key = COMBO_ORDER[i], code = COMBO_CODE[key];
        var item = mk('div', 'abcd-item abcd-' + code);
        app(item, mk('span', 'abcd-chip', code));
        app(item, comboBlock(key, 'cw-legend'));
        app(g, item);
      }
      app(host, g);
      return g;
    } catch (e) { return null; }
  };

  /* ================================================================== */
  /* TOAST / DOTS / BUSY                                                 */
  /* ================================================================== */
  U.toast = function (msg, kind) {
    try {
      var host = el.toasts;
      if (!host) return;
      var t = mk('div', 'toast toast-' + String(kind || 'info'), String(msg === null || msg === undefined ? '' : msg));
      if (!t) return;
      app(host, t);
      while (host.childNodes.length > 3) { try { host.removeChild(host.firstChild); } catch (e) { break; } }
      say(String(msg || ''));
      try {
        W.requestAnimationFrame(function () {
          W.requestAnimationFrame(function () { addC(t, 'in'); });
        });
      } catch (e) { addC(t, 'in'); }
      setTimeout(function () {
        remC(t, 'in');
        setTimeout(function () { try { if (t.parentNode) t.parentNode.removeChild(t); } catch (e) {} }, 420);
      }, 2600);
    } catch (e) {}
  };

  U.progressDots = function (n, i) {
    try {
      var host = el.dots;
      if (!host) return;
      var count = Math.max(0, Math.floor(num(n, 0)));
      if (!count) { clear(host); remC(host, 'on'); return; }
      if (host.childNodes.length !== count) {
        clear(host);
        for (var k = 0; k < count; k++) app(host, mk('span', 'dot'));
      }
      var idx = Math.floor(num(i, 0));
      for (var j = 0; j < host.childNodes.length; j++) {
        var d = host.childNodes[j];
        togC(d, 'done', j < idx);
        togC(d, 'now', j === idx);
      }
      addC(host, 'on');
    } catch (e) {}
  };

  U.setBusy = function (v) {
    try {
      togC(el.busy, 'on', !!v);
      attr(el.root, 'aria-busy', v ? 'true' : 'false');
    } catch (e) {}
  };

  /* ================================================================== */
  /* MISC / TEARDOWN                                                     */
  /* ================================================================== */
  U.say = function (m) { say(String(m === null || m === undefined ? '' : m)); };
  U.alert = function (m) { alertSay(String(m === null || m === undefined ? '' : m)); };
  U.root = function () { return el.root; };

  /* full teardown of every live interaction — safe to call any number of
     times (WebGL context loss, replay, scene rebuild). Never throws. */
  U.reset = function () {
    try {
      U.stopCountdown();
      pgHide();
      bkHide();
      raHide();
      U.hideChoices();
      U.subtitleClear();
      U.setBusy(false);
      tcHoldStop();
      tlBars = null;
      cfNodes = null;
      hudSpeedShown = -1; hudPhaseShown = null; hudUnitShown = null;
      U.slateClear();
      hideEl(el.hud, 'on', 460); remC(el.hud, 'warn');
      clear(el.toasts);
    } catch (e) {}
  };

  return U;
})();