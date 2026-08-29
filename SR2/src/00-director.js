/* =========================================================================
   TROLLEY — DIRECTOR, STORE, POLL, BOOTSTRAP GLUE
   Owned by the integrator. Drives the modules: SFX, WorldA, WorldB,
   FX, CamRig, UI, SCRIPT. (The worlds own their own figures and ragdolls.)
   ========================================================================= */

/* ------------------------------------------------------------------ Store */
var Store = (function () {
  var mem = {};
  function get(k, d) {
    try { var v = window.localStorage.getItem(k); return v === null ? d : JSON.parse(v); }
    catch (e) { return (k in mem) ? mem[k] : d; }
  }
  function set(k, v) {
    try { window.localStorage.setItem(k, JSON.stringify(v)); }
    catch (e) { mem[k] = v; }
  }
  function del(k) {
    try { window.localStorage.removeItem(k); } catch (e) { delete mem[k]; }
  }
  return { get: get, set: set, del: del };
})();

/* ------------------------------------------------------ page state (quine) */
var PageState = (function () {
  var s = { v: 1, tally: { turn_nopush: 0, turn_push: 0, stay_nopush: 0, stay_push: 0 }, seats: {} };
  try {
    var el = document.getElementById('STATE');
    if (el && el.textContent.trim()) {
      var p = JSON.parse(el.textContent);
      if (p && typeof p === 'object') {
        if (p.tally) s.tally = Object.assign(s.tally, p.tally);
        if (p.seats) s.seats = p.seats;
        if (p.v) s.v = p.v;
      }
    }
  } catch (e) {}
  return s;
})();

/* ------------------------------------------------------------------- Poll
   CLASSROOM REALITY THIS IS BUILT AROUND: ~30 students open the same
   published URL on Chromebooks and the teacher projects it. Students are
   almost always ANONYMOUS, READ-ONLY viewers, so publish() rejects with
   not_writer / not_granted / capability_disabled and automatic sync simply
   does not happen. MANUAL is therefore the normal, planned-for mode and the
   badge must never claim LIVE without proof. Live sync is the bonus.
   ---------------------------------------------------------------------- */
var Poll = (function () {
  var api = null;          // resolved artifact capability namespace (may be unusable)
  var mode = 'manual';     // 'live' | 'manual' -- 'live' ONLY on proof of a write
  var listeners = [];
  var probed = false;
  var dead = false;        // a permanent refusal was seen; stop trying to publish
  var lastReason = '';     // why we are in manual, for the console and the log
  var MAX_TRIES = 4;       // re-sends before we hand the room back to the teacher
  var COMBOS = { turn_nopush: 1, turn_push: 1, stay_nopush: 1, stay_push: 1 };

  function counts() {
    var t = PageState.tally;
    return {
      combos: {
        turn_nopush: t.turn_nopush | 0, turn_push: t.turn_push | 0,
        stay_nopush: t.stay_nopush | 0, stay_push: t.stay_push | 0
      },
      a: { turn: (t.turn_nopush | 0) + (t.turn_push | 0), stay: (t.stay_nopush | 0) + (t.stay_push | 0) },
      b: { push: (t.turn_push | 0) + (t.stay_push | 0), nopush: (t.turn_nopush | 0) + (t.stay_nopush | 0) },
      total: (t.turn_nopush | 0) + (t.turn_push | 0) + (t.stay_nopush | 0) + (t.stay_push | 0),
      mode: mode,
      live: mode === 'live',
      reason: lastReason
    };
  }

  function emit() {
    var snap = counts();
    /* A listener may unsubscribe itself from inside its own callback, and the
       splice that does it makes this loop skip whichever listener moved down
       into the freed slot -- so one of the two subscribed views (tally /
       console) would silently stop updating. Iterate a copy: emit runs on votes
       and stepper taps, never per frame, so the allocation costs nothing. */
    var l = listeners.slice();
    for (var i = 0; i < l.length; i++) { try { l[i].fn(snap); } catch (e) {} }
  }

  /* Keyed, so a beat entered twice replaces its listener instead of stacking a
     second one. Returns an unsubscribe. */
  function onChange(fn, key) {
    if (typeof fn !== 'function') return function () {};
    key = key || ('k' + listeners.length + '_' + Math.random());
    for (var i = 0; i < listeners.length; i++) {
      if (listeners[i].key === key) { listeners.splice(i, 1); break; }
    }
    var rec = { key: key, fn: fn };
    listeners.push(rec);
    try { fn(counts()); } catch (e) {}
    return function () {
      var j = listeners.indexOf(rec);
      if (j >= 0) listeners.splice(j, 1);
    };
  }

  function setMode(m, why) {
    if (why !== undefined) lastReason = why;
    mode = m;
    emit();
  }

  function seatCount() {
    var n = 0, k, s = PageState.seats;
    if (!s || typeof s !== 'object') return 0;
    for (k in s) { if (Object.prototype.hasOwnProperty.call(s, k)) n++; }
    return n;
  }

  /* Resolving the capability namespace is NOT evidence of write access: an
     anonymous viewer still gets a publish() and only learns the truth when the
     call rejects. So probe() keeps the handle and stays MANUAL. We flip to LIVE
     on real evidence only: our own publish succeeded, or the STATE we loaded
     already carries seats somebody else managed to publish. */
  function probe() {
    if (probed) return Promise.resolve(mode);
    probed = true;
    if (seatCount() > 0) { setMode('live', ''); }
    if (!(window.claude && typeof window.claude.use === 'function')) {
      lastReason = lastReason || 'no artifact capability on this page';
      emit();
      return Promise.resolve(mode);
    }
    /* window.claude.use is host code. A SYNCHRONOUS throw here escaped probe()
       altogether -- past the .catch below, which only ever sees rejections --
       and took the role button's click handler with it, leaving the class
       looking at a boot screen with a dead button. */
    var used;
    try { used = window.claude.use('artifact'); }
    catch (err0) {
      api = null;
      lastReason = 'capability unavailable' + (err0 && err0.code ? ' (' + err0.code + ')' : '');
      emit();
      return Promise.resolve(mode);
    }
    return Promise.resolve(used).then(function (ns) {
      if (ns && typeof ns.publish === 'function') api = ns;
      else lastReason = 'artifact capability has no publish';
      emit();
      return mode;
    })['catch'](function (err) {
      api = null;
      lastReason = 'capability unavailable' + (err && err.code ? ' (' + err.code + ')' : '');
      emit();
      return mode;
    });
  }

  /* Every documented rejection, sorted by what a classroom can do about it. */
  var PERMANENT = {                       /* nothing this device does will fix it */
    not_writer:          'this device is a read-only viewer',
    not_granted:         'publishing was not granted',
    not_declared:        'the page does not declare publishing',
    capability_disabled: 'publishing is disabled',
    capability_removed:  'publishing was removed',
    consent_required:    'publishing needs consent',
    too_large:           'the page is too large to republish',
    invalid_content:     'the page was rejected as invalid'
  };
  var TRANSIENT = { rate_limited: 1, upstream_error: 1 };

  function nextState(seat, combo) {
    var prev = PageState.seats ? PageState.seats[seat] : null;
    var next = JSON.parse(JSON.stringify(PageState));
    if (!next.tally) next.tally = { turn_nopush: 0, turn_push: 0, stay_nopush: 0, stay_push: 0 };
    if (!next.seats) next.seats = {};
    if (prev && COMBOS[prev] && next.tally[prev] > 0) next.tally[prev]--;
    next.tally[combo] = (next.tally[combo] | 0) + 1;
    next.seats[seat] = combo;
    next.v = 1;
    return next;
  }

  /* A student's own submission. Idempotent per device via a stable seat id. */
  function submit(comboKey, tries) {
    if (!COMBOS[comboKey]) return Promise.resolve({ ok: false, reason: 'bad-combo' });
    var seat = Store.get('trolley.seat', null);
    if (!seat) { seat = 's' + Math.random().toString(36).slice(2, 10); Store.set('trolley.seat', seat); }
    tries = tries | 0;

    if (PageState.seats && PageState.seats[seat] === comboKey) {
      Store.del('trolley.pending');
      setMode('live', '');            /* this seat is already in the published page */
      return Promise.resolve({ ok: true, already: true });
    }
    if (dead || !api || typeof api.publish !== 'function') {
      /* Nothing to flush later, so leave no stale record behind: in the normal
         classroom case EVERY device lands here. */
      Store.del('trolley.pending');
      return Promise.resolve({ ok: false, reason: 'manual', why: lastReason });
    }

    /* Written BEFORE the publish and to localStorage, so it outlives the reload
       a conflict forces on us; flushPending() re-sends it on the next load. */
    Store.set('trolley.pending', { seat: seat, combo: comboKey, tries: tries });

    var next = nextState(seat, comboKey);
    var doc;
    try { doc = Shell.renderDoc(next); }
    catch (e) {
      /* Publishing a broken document would destroy the artifact for the whole
         room. Never do it; count hands instead. */
      dead = true;
      Store.del('trolley.pending');
      setMode('manual', 'the page could not be regenerated safely');
      return Promise.resolve({ ok: false, reason: 'manual', why: 'render failed' });
    }

    /* Survive the reload a conflict causes: where the film was, and what we chose. */
    try { sessionStorage.setItem('trolley.resume', JSON.stringify(Director.snapshot())); } catch (e) {}

    return Promise.resolve(api.publish(doc)).then(function () {
      Store.del('trolley.pending');
      PageState.tally = next.tally;
      PageState.seats = next.seats;
      setMode('live', '');
      return { ok: true };
    })['catch'](function (err) {
      var code = (err && (err.code || err.name)) || 'upstream_error';

      /* CONFLICT: another student won the race. We do NOT retry in place --
         the view is about to reload onto the winning version, and republishing
         our stale document would erase their vote. The pending record stays in
         localStorage and flushPending() re-sends it after the reload, bounded
         so a 30-way stampede cannot loop forever. */
      if (code === 'conflict') {
        if (tries + 1 >= MAX_TRIES) {
          Store.del('trolley.pending');
          setMode('manual', 'too many devices publishing at once');
          return { ok: false, reason: 'manual', why: 'collision', code: code };
        }
        Store.set('trolley.pending', { seat: seat, combo: comboKey, tries: tries + 1 });
        return { ok: false, reason: 'conflict', reload: true, code: code };
      }

      if (PERMANENT[code]) {
        dead = true;
        Store.del('trolley.pending');
        setMode('manual', PERMANENT[code]);
        return { ok: false, reason: 'readonly', why: PERMANENT[code], code: code };
      }

      if (TRANSIENT[code]) {
        if (tries + 1 >= MAX_TRIES) {
          Store.del('trolley.pending');
          setMode('manual', code === 'rate_limited' ? 'too many at once' : 'the server is busy');
          return { ok: false, reason: 'manual', why: code, code: code };
        }
        /* jittered backoff so thirty Chromebooks do not resynchronise */
        var wait = 400 * Math.pow(2, tries) + Math.floor(Math.random() * 500);
        return new Promise(function (res) {
          setTimeout(function () { res(submit(comboKey, tries + 1)); }, wait);
        });
      }

      /* Undocumented code: one retry, then give the room to the teacher. */
      if (tries === 0) {
        return new Promise(function (res) {
          setTimeout(function () { res(submit(comboKey, 1)); }, 700);
        });
      }
      Store.del('trolley.pending');
      setMode('manual', 'unexpected error (' + code + ')');
      return { ok: false, reason: 'error', code: code };
    });
  }

  /* Teacher console, manual mode: set the four combination counts directly.
     Scene A and Scene B totals are always DERIVED from these four, so the two
     charts can never disagree. */
  function setManual(combos) {
    combos = combos || {};
    var src = combos.combos || combos;
    PageState.tally = {
      turn_nopush: Math.max(0, src.turn_nopush | 0), turn_push: Math.max(0, src.turn_push | 0),
      stay_nopush: Math.max(0, src.stay_nopush | 0), stay_push: Math.max(0, src.stay_push | 0)
    };
    Store.set('trolley.manual', PageState.tally);
    emit();
  }

  function loadManual() {
    var m = Store.get('trolley.manual', null);
    if (!m) return;
    /* Real published votes always beat a stale hand count from a previous lesson. */
    if (seatCount() > 0) return;
    PageState.tally = {
      turn_nopush: Math.max(0, m.turn_nopush | 0), turn_push: Math.max(0, m.turn_push | 0),
      stay_nopush: Math.max(0, m.stay_nopush | 0), stay_push: Math.max(0, m.stay_push | 0)
    };
    emit();
  }

  function reset() {
    PageState.tally = { turn_nopush: 0, turn_push: 0, stay_nopush: 0, stay_push: 0 };
    PageState.seats = {};
    Store.del('trolley.manual');
    Store.del('trolley.pending');
    emit();
    /* In live mode the published page still holds the old numbers, so clear it
       too. Best effort: a failure just means we go on counting by hand. */
    if (!dead && api && typeof api.publish === 'function') {
      try {
        return Promise.resolve(api.publish(Shell.renderDoc(PageState)))['catch'](function () { return null; });
      } catch (e) { return Promise.resolve(null); }
    }
    return Promise.resolve(null);
  }

  /* Re-send a vote a conflict dropped, once the page has reloaded onto the
     winning version. Bounded by the try count inside the record. */
  function flushPending() {
    var p = Store.get('trolley.pending', null);
    if (!p || !p.combo || !COMBOS[p.combo]) {
      Store.del('trolley.pending');
      return Promise.resolve({ ok: true, nothing: true });
    }
    if ((p.tries | 0) >= MAX_TRIES) {
      Store.del('trolley.pending');
      setMode('manual', 'too many devices publishing at once');
      return Promise.resolve({ ok: false, reason: 'manual' });
    }
    return submit(p.combo, p.tries | 0);
  }

  function pending() { return Store.get('trolley.pending', null); }

  /* Where the film was when a conflict reloaded us. Consumed exactly once, so a
     genuine restart still starts at the beginning. */
  function takeResume() {
    var raw = null;
    try {
      raw = sessionStorage.getItem('trolley.resume');
      sessionStorage.removeItem('trolley.resume');
    } catch (e) { raw = null; }
    if (!raw) return null;
    try {
      var o = JSON.parse(raw);
      /* SHAPE GATE. A resume record is only worth handing back if it is WHOLE:
         somewhere to return to, the role that was playing, and the choices
         object every post-decision beat reads. Director validates the VALUES
         and refuses anything it cannot restore completely; this refuses
         anything that is not even the right shape, so a truncated or
         hand-edited record can never reach the film as a half state. */
      if (!o || typeof o !== 'object') return null;
      if (!o.beat || !o.role || !o.choices || typeof o.choices !== 'object') return null;
      return o;
    } catch (e) { return null; }
  }

  return {
    probe: probe, submit: submit, onChange: onChange, counts: counts,
    setManual: setManual, loadManual: loadManual, reset: reset,
    flushPending: flushPending, pending: pending, takeResume: takeResume,
    get mode() { return mode; },
    get live() { return mode === 'live'; },
    get reason() { return lastReason; }
  };
})();
