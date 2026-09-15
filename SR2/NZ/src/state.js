/* =====================================================================
   MODULE: state  -  게임 상태의 단일 출처. 채점·저장·복구·경과 시간.
   DECLARES EXACTLY TWO GLOBAL SLOTS: window.NZ.CONFIG, window.NZ.State

   이 파일은 화면을 모른다. DOM 을 단 한 번도 참조하지 않는다.
   그래야 node 에서 가짜 window 하나만 주고 불변식 테스트를 돌릴 수 있고,
   화면 구현이 뒤집혀도 채점 규칙은 그대로 남는다.
   three.js 도, 오디오도, 문구도 여기서 부르지 않는다.

   ---------------------------------------------------------------------
   이 파일이 지키는 것 (깨지면 교실에서 바로 드러난다)
   ---------------------------------------------------------------------
   I1  done ⊆ keys(firstChoice)        답 안 한 사건이 완료로 잡히지 않는다
   I2  0 ≤ score ≤ 완료 수 ≤ 10        '정확도 5 / 완료 4' 가 나오지 않는다
   I3  firstChoice 는 reset 전까지 불변  재방문으로 점수가 움직이지 않는다
   I4  nextUnanswered===null ⟺ 전부 완료
   I5  screen==='result' ⇒ 전부 완료
   I6  같은 사건을 n번 열어도 점수 변화 0
   I7  경과 시간은 단조 증가이고 음수가 아니다
   I9  reset 후에도 음소거 설정이 보존된다   (교실에서 소리가 터지지 않는다)

   ---------------------------------------------------------------------
   고칠 때 반드시 지킬 것
   ---------------------------------------------------------------------
   1) 채점은 ID 비교뿐이다. firstChoice[caseId] === CASES.byId.answerId.
      선택지 ID 를 문자열로 조합해 만들지 마라(caseId + '_o1' 같은 것).
      화면의 1/2 는 렌더 순서가 붙이는 라벨일 뿐이고, 선택지 배열을
      뒤집어도 채점 결과는 같아야 한다.
   2) localStorage 접근은 전부 try/catch 다. 실패해도 던지지 않는다.
      학교 크롬북에는 사이트 데이터가 정책으로 막힌 기기가 섞여 있고,
      그 기기에서도 사건 10개를 끝까지 풀 수 있어야 한다.
   3) 학생 개인정보를 어떤 형태로도 저장하지 않는다. 저장되는 것은
      사건 ID · 선택지 ID · 숫자 세 개뿐이다. 이름도, 학번도, 기기 식별자도
      만들지 않는다.
   4) 저장 키에 'nz.' 접두사는 필수다. 배포 주소가 같은 origin 아래
      1·2차시 자료와 localStorage 를 공유한다. 접두사가 없으면 앞 차시
      자료의 키를 덮어써 다른 수업을 망가뜨린다.
   ===================================================================== */

(function () {
  'use strict';

  window.NZ = window.NZ || {};

  var hasOwn = Object.prototype.hasOwnProperty;
  function has(obj, key) { return !!obj && hasOwn.call(obj, key); }
  function isArr(v) { return Object.prototype.toString.call(v) === '[object Array]'; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /* ------------------------------------------------------------------ 사건 색인
     cases.js 에서 읽는 것은 id · options[].id · answerId 세 가지뿐이다.
     제목도, 상황문도, 대사도 이 파일은 알 필요가 없다. */
  var CASES = isArr(window.NZ.CASES) ? window.NZ.CASES : [];
  var ORDER = [];
  var BY_ID = {};
  (function indexCases() {
    for (var i = 0; i < CASES.length; i++) {
      var c = CASES[i];
      if (!c || typeof c.id !== 'string' || has(BY_ID, c.id)) continue;
      BY_ID[c.id] = c;
      ORDER.push(c.id);
    }
  })();

  function getCase(id) {
    return (typeof id === 'string' && has(BY_ID, id)) ? BY_ID[id] : null;
  }
  function isOptionOf(c, optionId) {
    if (!c || !isArr(c.options)) return false;
    for (var i = 0; i < c.options.length; i++) {
      if (c.options[i] && c.options[i].id === optionId) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ 상수
     total 은 리터럴 10 이 아니라 CASES 길이에서 뽑는다. 교사가 사건을
     더하거나 빼도 '완료 n/10' 의 분모와 allDone() 판정이 같이 따라간다.
     (CASES 가 통째로 실패했을 때만 10 으로 떨어진다.) */
  var CONFIG = {
    v: 1,
    total: ORDER.length || 10,
    schema: 1,
    KEY_PROGRESS: 'nz.progress',
    KEY_PREFS: 'nz.prefs',
    ARM_MS: 150,
    NEXT_ARM_MS: 600,
    STALE_MS: 7200000,
    CLOCK_MS: 1000,
    MAX_ELAPSED: 86400000,
    REACT_MIN: 600,
    REACT_MAX: 1200
  };

  /* ------------------------------------------------------------------ 저장소
     window.localStorage 로 접근한다(전역 localStorage 가 아니라).
     테스트가 가짜 window 에 스텁을 꽂아 '저장이 통째로 던지는 기기'를
     재현할 수 있어야 하기 때문이다. */
  var storageOkFlag = true;

  function readRaw(key) {
    try {
      var s = window.localStorage.getItem(key);
      if (typeof s !== 'string' || !s) return null;
      return JSON.parse(s);
    } catch (e) {
      /* 읽기 실패는 storageOk 를 내리지 않는다. load() 는 부작용이 없어야
         하고, 저장 불가 안내는 실제로 쓰기가 실패했을 때만 띄운다. */
      return null;
    }
  }
  function writeRaw(key, obj) {
    try {
      window.localStorage.setItem(key, JSON.stringify(obj));
      return true;
    } catch (e) {
      storageOkFlag = false;
      return false;
    }
  }
  function removeRaw(key) {
    try {
      window.localStorage.removeItem(key);
      return true;
    } catch (e) {
      storageOkFlag = false;
      return false;
    }
  }

  /* ------------------------------------------------------------------ prefs
     진행 기록과 별도 키다. '전체 다시 시작'이 이걸 지우면 초기화한 학생의
     크롬북에서 효과음이 되살아나 교실에서 소리가 터진다.
     기본값은 muted:true — 소리는 학생이 직접 켜는 것이다. */
  var prefs = { v: 1, muted: true, motion: null };

  (function loadPrefs() {
    var raw = readRaw(CONFIG.KEY_PREFS);
    if (!raw || typeof raw !== 'object' || isArr(raw)) return;
    if (raw.v !== 1) return;
    if (typeof raw.muted === 'boolean') prefs.muted = raw.muted;
    if (raw.motion === 'reduced' || raw.motion === 'full') prefs.motion = raw.motion;
  })();

  function savePrefs() { return writeRaw(CONFIG.KEY_PREFS, prefs); }

  /* ------------------------------------------------------------------ 상태 */
  function blank() {
    return {
      v: 1,
      startedAt: Date.now(),
      savedAt: 0,
      elapsedMs: 0,
      firstChoice: {},
      done: [],
      current: null,
      phase: 'ask',
      /* 메모리의 출발점은 'start' 다. 저장할 때만 'lobby' 로 내려간다 —
         시작 화면은 복구 대상이 아니다. */
      screen: 'start',
      agree: null
    };
  }

  var st = blank();

  /* init() 이 찾아 둔 복구 후보. resume() 이 부를 때까지 적용하지 않는다.
     부팅하자마자 이어하기가 적용되면 '처음부터'를 고른 학생의 화면에
     남의 기록이 한 프레임 비친다. */
  var pending = null;
  var pendingRepaired = false;
  var initResult = null;

  /* ------------------------------------------------------------------ 경과 시간
     Date.now() - startedAt 으로 계산하지 않는다. 4교시에 시작해 6교시에
     이어한 학생의 결과 화면에 '2:13:00' 이 뜬다.
     탭이 열려 있는 동안만 anchor 와의 차이를 누적하고, resume() 이
     anchor 를 다시 잡는다. */
  var anchor = Date.now();
  var lastReported = 0;

  function sinceAnchor() {
    var d = Date.now() - anchor;
    /* 음수는 시스템 시계가 뒤로 간 것(크롬북 NTP 동기화)이고,
       MAX_ELAPSED 초과는 손상이다. 둘 다 0 으로 본다. */
    if (!isNum(d) || d < 0 || d > CONFIG.MAX_ELAPSED) return 0;
    return d;
  }
  function flushClock() {
    st.elapsedMs += sinceAnchor();
    anchor = Date.now();
  }
  function elapsedMs() {
    var v = st.elapsedMs + sinceAnchor();
    /* 단조 증가를 값 수준에서 한 번 더 붙든다. 시계가 뒤로 튀어도
       HUD 의 초가 거꾸로 가지 않는다. */
    if (v < lastReported) v = lastReported;
    lastReported = v;
    return v;
  }

  /* ------------------------------------------------------------------ 구독
     이벤트 버스를 두지 않는다. 구독자는 사실상 ui.js 하나뿐이고,
     버스를 놓으면 누가 언제 무엇을 바꿨는지 추적이 불가능해진다. */
  var subs = [];

  function snapshot() {
    var fc = {};
    for (var k in st.firstChoice) {
      if (has(st.firstChoice, k)) fc[k] = st.firstChoice[k];
    }
    return {
      v: st.v,
      startedAt: st.startedAt,
      savedAt: st.savedAt,
      elapsedMs: st.elapsedMs,
      firstChoice: fc,
      done: st.done.slice(),
      current: st.current,
      phase: st.phase,
      screen: st.screen,
      agree: st.agree
    };
  }

  function emit() {
    /* 복사본을 순회한다. 콜백 안에서 자기 자신을 해제하면 splice 때문에
       다음 구독자가 통째로 건너뛰어진다(1차시 자료에서 실제로 났던 버그). */
    var list = subs.slice();
    for (var i = 0; i < list.length; i++) {
      try { list[i].fn(snapshot()); } catch (e) { /* 구독자 하나가 죽어도 게임은 계속된다 */ }
    }
  }

  function onChange(fn, key) {
    if (typeof fn !== 'function') return function () {};
    var entry = { fn: fn, key: (key === null || key === undefined) ? null : String(key) };
    if (entry.key !== null) {
      for (var i = 0; i < subs.length; i++) {
        if (subs[i].key === entry.key) { subs.splice(i, 1); break; }
      }
    }
    subs.push(entry);
    /* 구독 즉시 1회 호출 — 구독자가 '첫 렌더'를 따로 부르지 않아도 되게. */
    try { fn(snapshot()); } catch (e) {}
    return function off() {
      var j = -1;
      for (var k = 0; k < subs.length; k++) { if (subs[k] === entry) { j = k; break; } }
      if (j >= 0) subs.splice(j, 1);
    };
  }

  /* ------------------------------------------------------------------ 저장 */
  function serialize() {
    var out = snapshot();
    /* 'start' 는 저장하지 않는다. 저장해 두면 새로고침이 학생을 시작 화면으로
       되돌려 이어하기 패널이 자기 진행을 못 찾는다. */
    if (out.screen === 'start') out.screen = 'lobby';
    return out;
  }

  function save() {
    flushClock();
    st.savedAt = Date.now();
    return writeRaw(CONFIG.KEY_PROGRESS, serialize());
  }

  function load() {
    /* 부작용 없음. 원본 파싱 결과만 돌려준다. */
    return readRaw(CONFIG.KEY_PROGRESS);
  }

  /* ------------------------------------------------------------------ sanitize
     교사가 사건 문구나 선택지를 고친 뒤, 학생 크롬북에 남아 있던 옛 저장이
     로드되는 것이 실제 시나리오다. 대조하지 않으면 존재하지 않는 선택지 ID 가
     채점기에 들어가 '영원히 불일치'로 뜨는 사건이 생긴다.
     손상된 저장은 던지지 않고 조용히 버린다. 콘솔 에러 0건이 목표다. */
  function sanitize(raw) {
    if (!raw || typeof raw !== 'object' || isArr(raw)) return { state: null, repaired: false };
    if (raw.v !== CONFIG.schema) return { state: null, repaired: false };
    if (!raw.firstChoice || typeof raw.firstChoice !== 'object' || isArr(raw.firstChoice)) {
      return { state: null, repaired: false };
    }
    if (!isArr(raw.done)) return { state: null, repaired: false };

    var repaired = false;
    var s = blank();
    var i;

    s.startedAt = (isNum(raw.startedAt) && raw.startedAt > 0) ? raw.startedAt : Date.now();
    s.savedAt = isNum(raw.savedAt) ? raw.savedAt : 0;
    if (isNum(raw.elapsedMs) && raw.elapsedMs >= 0 && raw.elapsedMs <= CONFIG.MAX_ELAPSED) {
      s.elapsedMs = raw.elapsedMs;
    } else {
      s.elapsedMs = 0;
      if (raw.elapsedMs !== undefined && raw.elapsedMs !== 0) repaired = true;
    }

    /* 최초 선택: 사건 ID 와 선택지 ID 를 둘 다 현재 cases.js 와 대조한다. */
    var keys = Object.keys(raw.firstChoice);
    for (i = 0; i < keys.length; i++) {
      var id = keys[i];
      var c = getCase(id);
      var pick = raw.firstChoice[id];
      if (!c || typeof pick !== 'string' || !isOptionOf(c, pick)) { repaired = true; continue; }
      s.firstChoice[id] = pick;
    }

    /* 완료 목록: 모르는 사건·중복·최초 선택 없는 사건을 전부 떨어뜨린다.
       이 루프가 I1(done ⊆ keys(firstChoice))의 복구 쪽 관문이다. */
    var seen = {};
    for (i = 0; i < raw.done.length; i++) {
      var d = raw.done[i];
      if (typeof d !== 'string' || !getCase(d) || !has(s.firstChoice, d) || has(seen, d)) {
        repaired = true;
        continue;
      }
      seen[d] = true;
      s.done.push(d);
    }

    if (typeof raw.current === 'string' && getCase(raw.current)) {
      s.current = raw.current;
    } else {
      s.current = null;
      if (raw.current !== null && raw.current !== undefined) repaired = true;
    }

    /* 위상: lock 은 feedback 으로 승격한다. 새로고침은 되감기가 아니다 —
       학생이 원하는 건 '아까 그 답이 노직과 같았나'이지 도장 장면의 재생이
       아니다. 반응 애니메이션은 다시 재생하지 않는다. */
    var ph = raw.phase;
    if (ph === 'lock') { ph = 'feedback'; repaired = true; }
    if (ph !== 'ask' && ph !== 'feedback') {
      if (ph !== undefined && ph !== 'ask') repaired = true;
      ph = 'ask';
    }
    /* 최초 선택이 없는 사건에서 피드백을 열면 빈 판정문이 뜬다. */
    if (ph === 'feedback' && (!s.current || !has(s.firstChoice, s.current))) {
      ph = 'ask';
      repaired = true;
    }
    s.phase = ph;

    var scr = (raw.screen === 'case' || raw.screen === 'result') ? raw.screen : 'lobby';
    if (scr === 'result' && s.done.length !== CONFIG.total) scr = 'lobby';  /* I5 */
    if (scr === 'case' && !s.current) scr = 'lobby';
    if (scr !== raw.screen) repaired = true;
    s.screen = scr;

    if (raw.agree === 'yes' || raw.agree === 'no') {
      s.agree = raw.agree;
    } else {
      s.agree = null;
      if (raw.agree !== null && raw.agree !== undefined) repaired = true;
    }

    return { state: s, repaired: repaired };
  }

  /* 의미 있는 진행만 이어하기를 묻는다. 로비까지만 갔다가 새로고침한 학생에게
     도입 5분 활동의 첫 10초를 결정에 쓰게 할 이유가 없다. */
  function meaningful(s) {
    if (!s) return false;
    if (s.done.length > 0) return true;
    if (Object.keys(s.firstChoice).length > 0) return true;
    return s.screen === 'result';
  }

  /* ------------------------------------------------------------------ 수명주기 */
  function init() {
    if (initResult) return initResult;
    var res = sanitize(load());
    pending = res.state;
    pendingRepaired = res.repaired;
    var ok = meaningful(pending);
    if (!ok) { pending = null; pendingRepaired = false; }
    initResult = { mode: ok ? 'resumable' : 'fresh', saved: ok ? snapshotOf(pending) : null };
    return initResult;
  }

  function snapshotOf(s) {
    var fc = {};
    for (var k in s.firstChoice) { if (has(s.firstChoice, k)) fc[k] = s.firstChoice[k]; }
    return {
      v: s.v, startedAt: s.startedAt, savedAt: s.savedAt, elapsedMs: s.elapsedMs,
      firstChoice: fc, done: s.done.slice(), current: s.current,
      phase: s.phase, screen: s.screen, agree: s.agree
    };
  }

  function hasResumable() { return meaningful(pending); }

  function resume() {
    if (!pending) return startFresh();
    st = pending;
    pending = null;
    /* startedAt 은 그대로 둔다(최초 시작 시각). anchor 만 지금으로 다시 잡아
       탭이 닫혀 있던 시간이 경과 시간에 섞이지 않게 한다. */
    anchor = Date.now();
    lastReported = st.elapsedMs;
    /* sanitize 가 고친 형태를 승격 직후 한 번 굳힌다(아래 save()).
       그래야 다음 새로고침이 같은 손상을 또 복구하지 않는다. */
    pendingRepaired = false;
    save();
    emit();
    return snapshot();
  }

  function startFresh() {
    st = blank();
    st.screen = 'lobby';
    st.phase = 'ask';
    pending = null;
    pendingRepaired = false;
    anchor = Date.now();
    lastReported = 0;
    save();
    emit();
    return snapshot();
  }

  function reset(opts) {
    st = blank();
    pending = null;
    pendingRepaired = false;
    anchor = Date.now();
    lastReported = 0;
    /* 진행 기록만 지운다. nz.prefs(음소거·모션)는 건드리지 않는다 — I9. */
    removeRaw(CONFIG.KEY_PROGRESS);
    if (!(opts && opts.silent === true)) emit();
    return snapshot();
  }

  /* ------------------------------------------------------------------ 채점
     최초 선택으로만 계산한다. 두 번째 호출부터는 기록을 건드리지 않고
     같은 결과를 돌려준다(멱등). 입력 잠금 네 겹이 전부 뚫려도 채점은
     두 번 되지 않는 마지막 관문이 여기다. */
  function answer(caseId, choiceId) {
    var c = getCase(caseId);
    if (!c) {
      return { accepted: false, choiceId: null, match: false, expectedId: null, reason: 'unknown-case' };
    }
    var expected = c.answerId;

    if (has(st.firstChoice, caseId)) {
      var prev = st.firstChoice[caseId];
      return {
        accepted: false, choiceId: prev, match: prev === expected,
        expectedId: expected, reason: 'already'
      };
    }
    if (typeof choiceId !== 'string' || !isOptionOf(c, choiceId)) {
      return { accepted: false, choiceId: null, match: false, expectedId: expected, reason: 'unknown-choice' };
    }

    st.firstChoice[caseId] = choiceId;
    st.phase = 'lock';
    save();
    emit();
    /* match 는 '노직의 판단과 일치'다. '정답'이 아니다.
       판정은 ID 비교뿐이고, 선택지가 화면 어느 자리에 그려졌는지와 무관하다. */
    return { accepted: true, choiceId: choiceId, match: choiceId === expected, expectedId: expected, reason: null };
  }

  /* 피드백이 화면에 완전히 표시된 직후 ui.js 가 부른다('다음'을 누를 때가
     아니다). score() 가 done 만 세므로 이 순서라야 score ≤ 완료 수 가
     항상 참이다. firstChoice 없는 사건은 받지 않는다 — I1 의 유일한 관문. */
  function markDone(caseId) {
    if (!getCase(caseId)) return false;
    if (!has(st.firstChoice, caseId)) return false;
    for (var i = 0; i < st.done.length; i++) { if (st.done[i] === caseId) return false; }
    st.done.push(caseId);
    save();
    emit();
    return true;
  }

  function isDone(caseId) {
    for (var i = 0; i < st.done.length; i++) { if (st.done[i] === caseId) return true; }
    return false;
  }
  function isAnswered(caseId) { return has(st.firstChoice, caseId); }
  function choiceOf(caseId) { return has(st.firstChoice, caseId) ? st.firstChoice[caseId] : null; }
  function expectedOf(caseId) { var c = getCase(caseId); return c ? c.answerId : null; }
  function matchOf(caseId) {
    if (!has(st.firstChoice, caseId)) return null;
    var c = getCase(caseId);
    if (!c) return null;
    return st.firstChoice[caseId] === c.answerId;
  }
  function stateOf(caseId) {
    if (isDone(caseId)) return 'done';
    if (isAnswered(caseId)) return 'answered';
    return 'unread';
  }
  function indexOfCase(caseId) {
    for (var i = 0; i < ORDER.length; i++) { if (ORDER[i] === caseId) return i; }
    return -1;
  }

  function score() {
    /* done 에 속한 사건만 센다. 답만 하고 피드백이 뜨기 전인 사건은
       아직 완료가 아니므로 점수에도 들어가지 않는다 — I2. */
    var n = 0;
    for (var i = 0; i < st.done.length; i++) {
      var id = st.done[i];
      var c = getCase(id);
      if (c && st.firstChoice[id] === c.answerId) n++;
    }
    return n;
  }
  function completedCount() { return st.done.length; }
  function answeredCount() { return Object.keys(st.firstChoice).length; }
  function total() { return CONFIG.total; }
  function allDone() { return completedCount() === total(); }

  /* '다음 사건'이 로비를 거치지 않는 이유가 이 함수다. 7번을 먼저 열었으면
     8·9·10 → 1·2… 순으로 순환한다. 전부 완료면 null — 그 null 이
     결과 화면으로 가는 신호다(I4). */
  function nextUnanswered(fromId) {
    var n = ORDER.length;
    if (!n) return null;
    var start = indexOfCase(fromId);
    for (var k = 1; k <= n; k++) {
      var id = ORDER[((start + k) % n + n) % n];
      if (!isDone(id)) return id;
    }
    return null;
  }

  /* 로비의 data-current('지금 여기') 자리. 아직 손대지 않은 가장 낮은 번호를
     먼저 주고, 그런 사건이 없으면 답만 하고 안 끝난 사건을 준다. */
  function currentUnread() {
    var i;
    for (i = 0; i < ORDER.length; i++) {
      if (!isDone(ORDER[i]) && !isAnswered(ORDER[i])) return ORDER[i];
    }
    for (i = 0; i < ORDER.length; i++) {
      if (!isDone(ORDER[i])) return ORDER[i];
    }
    return null;
  }

  /* ------------------------------------------------------------------ 접근자 */
  function current() { return st.current; }
  function setCurrent(caseId) {
    if (caseId === null) {
      if (st.current === null) return;
      st.current = null;
    } else {
      if (!getCase(caseId) || st.current === caseId) return;
      st.current = caseId;
    }
    save();
    emit();
  }

  function screen() { return st.screen; }
  function setScreen(s) {
    var next = s;
    if (next !== 'start' && next !== 'lobby' && next !== 'case' && next !== 'result') next = 'lobby';
    /* 미완료 상태의 결과 화면을 만들지 않는다 — I5. */
    if (next === 'result' && !allDone()) next = 'lobby';
    if (st.screen === next) return;
    st.screen = next;
    save();
    emit();
  }

  function phase() { return st.phase; }
  function setPhase(p) {
    var next = (p === 'ask' || p === 'lock' || p === 'feedback') ? p : 'ask';
    if (st.phase === next) return;
    st.phase = next;
    save();
    emit();
  }
  function feedbackOpen() { return st.phase === 'feedback'; }

  function startedAt() { return st.startedAt; }

  /* 동의/비동의는 채점 대상이 아니다. 저장은 하되(지문을 읽은 뒤
     '생각이 바뀐 사람?' 되묻기에 쓴다) 결과 화면에 다시 렌더하지 않는다 —
     크롬북 화면은 옆자리에서 그대로 보인다. */
  function agree() { return st.agree; }
  function setAgree(v) {
    if (v !== 'yes' && v !== 'no' && v !== null) return;
    if (st.agree === v) return;
    st.agree = v;
    save();
    emit();
  }

  function muted() { return prefs.muted === true; }
  function setMuted(b) {
    var next = !!b;
    if (prefs.muted === next) return;
    prefs.muted = next;
    savePrefs();
    emit();
  }

  function motion() { return prefs.motion; }
  function setMotion(v) {
    var next = (v === 'reduced' || v === 'full') ? v : null;
    if (prefs.motion === next) return;
    prefs.motion = next;
    savePrefs();
    emit();
  }

  function storageOk() { return storageOkFlag === true; }

  window.NZ.CONFIG = CONFIG;
  window.NZ.State = {
    init: init,
    hasResumable: hasResumable,
    resume: resume,
    startFresh: startFresh,
    load: load,
    save: save,
    sanitize: sanitize,
    reset: reset,

    answer: answer,
    markDone: markDone,
    isDone: isDone,
    isAnswered: isAnswered,
    choiceOf: choiceOf,
    matchOf: matchOf,
    expectedOf: expectedOf,
    stateOf: stateOf,
    indexOf: indexOfCase,

    score: score,
    completedCount: completedCount,
    answeredCount: answeredCount,
    total: total,
    allDone: allDone,
    nextUnanswered: nextUnanswered,
    currentUnread: currentUnread,

    current: current,
    setCurrent: setCurrent,
    screen: screen,
    setScreen: setScreen,
    phase: phase,
    setPhase: setPhase,
    feedbackOpen: feedbackOpen,

    elapsedMs: elapsedMs,
    startedAt: startedAt,
    agree: agree,
    setAgree: setAgree,
    muted: muted,
    setMuted: setMuted,
    motion: motion,
    setMotion: setMotion,

    storageOk: storageOk,
    snapshot: snapshot,
    onChange: onChange
  };
})();
