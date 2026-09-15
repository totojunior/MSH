/* =====================================================================
   MODULE: ui  -  DOM 렌더링 · 화면 전이 · 입력. 이 게임의 심장.
   DECLARES EXACTLY ONE GLOBAL SLOT: window.NZ.UI   (노출은 start() 하나)

   왜 이렇게 생겼는가
   ---------------------------------------------------------------------
   1) 화면 문자열을 한 개도 갖지 않는다. 전부 NZ.COPY 에서 읽는다.
      교사가 문구를 고칠 때 copy.js 한 파일만 열면 되게 하려는 것이고,
      '정답/오답' 같은 금지 표현이 코드에 숨어드는 것을 구조적으로 막는다.
   2) 애니메이션 길이 상수를 갖지 않는다. 피드백 지연은 Court.react() 가
      돌려준 ms 다(R9). 연출 길이를 두 곳에 적어 두면 3D 를 손볼 때마다
      피드백이 먼저 뜨거나 늦게 뜬다.
   3) Court.ok / Court.mode 로 분기하지 않는다. 3D 가 죽으면 같은 API 의
      2D 폴백이 그 자리에 들어오므로, 여기서 알 필요가 없다.
   4) 상태의 진실은 NZ.State 하나다. data-* 는 그 거울일 뿐이고,
      dataset 을 읽어 분기하지 않는다(주소로만 읽는다).
   5) 입력 잠금은 네 겹이다: 동기 busy → 무장 지연 + disabled → 위상 가드
      → State.answer() 멱등성. 크롬북 트랙패드 연타는 반드시 새기 마련이라
      한 겹이 뚫려도 채점은 두 번 되지 않아야 한다.
   ===================================================================== */

(function () {
  'use strict';

  window.NZ = window.NZ || {};

  var NZ = window.NZ;
  var D = document;

  /* 모듈 참조는 start() 에서 늦게 잡는다. NZ.Court 는 3D 초기화 실패 시
     폴백 객체로 통째 교체되므로, 캐시하지 않고 매번 NZ 를 통해 읽는다. */
  var CP = null;   // NZ.COPY
  var CFG = null;  // NZ.CONFIG
  var CASES = null;

  /* ---------------------------------------------------------------- 요소 */
  var root, gl, live, alertBox;
  var btnLobby, hudDone, hudDots, hudClock, btnMute, muteText, btnRestart;
  var secStart, secLobby, secCase, secResult;
  var btnStart, resumeBox, resumeLine, btnResume, btnFresh, storageNote;
  var lobbyProgress, lobbyBar, lobbyBarFill, fileList, lobbyHint, btnLobbyResult;
  var caseNo, caseTitle, caseBody, caseHook, caseQ;
  var feedback, fbVerdict, fbWord, fbExpected, fbReason, fbNote, fbEn, fbLinger, btnNext, fbLine;
  var resultTitle, resultScore, resultScoreNote, resultTimeV, resultTeacher, resultCaption;
  var agreeQ, btnAgreeYes, btnAgreeNo, agreeDone, btnResultLobby, flatNote;
  var confirmBox, confirmTitle, confirmText, btnConfirmNo, btnConfirmYes;
  var btnMotion = null;       // COPY 가 문구를 주는 경우에만 만든다 (아래 §모션)

  var choiceBtns = [];        // [#nz-choice-1, #nz-choice-2]
  var fileBtns = [];          // 로비 카드 10개, CASES 와 같은 순서
  var dots = [];              // HUD 진행 도트 10개

  /* ---------------------------------------------------------------- 세션 */
  var curScreen = 'start';    // DOM 의 주인. State 를 되읽지 않는다
  var busy = false;           // ① 동기 잠금
  var choicesArmed = false;   // ② 무장 지연
  var nextArmed = false;
  var tArm = 0, tNext = 0, tReact = 0, tClock = 0;
  var modalOpen = false;
  var focusBeforeModal = null;
  var storageTold = false;
  var audioSynced = false;
  var rafResize = false;

  var lineByCase = {};        // 사건별로 한 번 고른 노직의 한 줄. 재방문에도 같은 줄
  var koShownByCase = {};     // 한국어 병기를 이 사건에서 보여줄지
  var seenKo = {};            // 같은 개념어의 병기는 첫 등장 1회만
  var streakMatch = 0;
  var streakMiss = 0;

  /* ---------------------------------------------------------------- 도구 */

  function q(id) { return D.getElementById(id); }

  function txt(node, s) {
    if (node) node.textContent = (s === null || s === undefined) ? '' : String(s);
  }

  function show(node, on) { if (node) node.hidden = !on; }

  /* COPY.fill 이 계약이지만, copy.js 가 늦게 바뀌어도 화면이 죽지 않게
     같은 규칙(없는 키는 빈 문자열)의 대체 구현을 옆에 둔다. */
  function fill(tpl, map) {
    if (CP && typeof CP.fill === 'function') return CP.fill(tpl, map);
    return String(tpl === undefined || tpl === null ? '' : tpl)
      .replace(/\{(\w+)\}/g, function (all, k) {
        var v = map ? map[k] : '';
        return (v === undefined || v === null) ? '' : String(v);
      });
  }

  function caseById(id) {
    for (var i = 0; i < CASES.length; i++) if (CASES[i].id === id) return CASES[i];
    return null;
  }

  function optionIndex(c, optId) {
    for (var i = 0; i < c.options.length; i++) if (c.options[i].id === optId) return i;
    return -1;
  }

  /* 화면의 ①② 라벨은 렌더 순서가 붙인다(R1). ID 에서 만들지 않는다. */
  function posLabel(i) {
    return i === 1 ? CP.case.keyB : CP.case.keyA;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtClock(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var ss = s % 60;
    if (h > 0) return h + ':' + pad2(m) + ':' + pad2(ss);
    return m + ':' + pad2(ss);
  }

  /* 전이 직후 곧바로 focus() 하면 아직 hidden 이 풀리기 전이라 먹히지 않는다. */
  function focusEl(node) {
    if (!node) return;
    requestAnimationFrame(function () {
      try { node.focus({ preventScroll: true }); }
      catch (e) { try { node.focus(); } catch (e2) { /* 포커스 실패는 치명적이지 않다 */ } }
    });
  }

  /* 같은 문자열을 다시 넣으면 스크린리더가 읽지 않는다. 폭 없는 공백으로 토글한다. */
  function say(s) {
    if (!live || !s) return;
    var t = String(s);
    if (live.textContent === t) t += '​';
    live.textContent = t;
  }

  function alertOnce(s) {
    if (!alertBox || !s) return;
    var t = String(s);
    if (alertBox.textContent === t) t += '​';
    alertBox.textContent = t;
  }

  function clearTimer(id) { if (id) clearTimeout(id); return 0; }

  function clearAllTimers() {
    tArm = clearTimer(tArm);
    tNext = clearTimer(tNext);
    tReact = clearTimer(tReact);
    choicesArmed = false;
    nextArmed = false;
  }

  /* ---------------------------------------------------------------- 상태 반영 */

  function syncSoundDom() {
    var muted = !!NZ.State.muted();
    root.setAttribute('data-sound', muted ? 'off' : 'on');
    if (btnMute) {
      btnMute.setAttribute('aria-pressed', muted ? 'false' : 'true');
      btnMute.setAttribute('aria-label', CP.hud.muteName);
      txt(muteText, muted ? CP.hud.soundOff : CP.hud.soundOn);
    }
  }

  var mqMotion = (typeof window.matchMedia === 'function')
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

  /* 저장된 취향이 있으면 그것이 이기고, 없으면 OS 설정을 따른다.
     렌더 루프 안에서 matchMedia 를 다시 묻지 않도록 결과는 data-motion 에만 적는다. */
  function applyMotion() {
    var pref = NZ.State.motion();
    var reduced = (pref === 'reduced') ? true
      : (pref === 'full') ? false
        : !!(mqMotion && mqMotion.matches);
    root.setAttribute('data-motion', reduced ? 'reduced' : 'full');
    if (btnMotion) {
      btnMotion.setAttribute('aria-pressed', reduced ? 'true' : 'false');
      txt(btnMotion.querySelector('.nz-btn-mute-t'), reduced ? CP.hud.motionOn : CP.hud.motionOff);
    }
  }

  function syncHud() {
    var done = NZ.State.completedCount();
    var total = NZ.State.total();
    txt(hudDone, fill(CP.hud.progress, { done: done, total: total }));

    var cur = NZ.State.current() || NZ.State.currentUnread();
    for (var i = 0; i < dots.length; i++) {
      var id = CASES[i].id;
      var v = NZ.State.isDone(id) ? 'done' : (id === cur ? 'current' : 'unread');
      dots[i].setAttribute('data-dot', v);
    }
    syncSoundDom();

    /* 저장이 막힌 브라우저는 시작 화면에서 한 줄로만 알린다. 게임 중에 다시 묻지 않는다. */
    if (!NZ.State.storageOk() && !storageTold) {
      storageTold = true;
      show(storageNote, true);
      alertOnce(CP.a11y.alertStorage);
    }
  }

  function tickClock() {
    if (hudClock) txt(hudClock, fmtClock(NZ.State.elapsedMs()));
  }

  /* ---------------------------------------------------------------- 화면 전환 */

  var SCREENS = null;   // start() 에서 채운다

  function applyScreen(name) {
    curScreen = name;
    root.setAttribute('data-screen', name);

    for (var k in SCREENS) {
      if (!Object.prototype.hasOwnProperty.call(SCREENS, k)) continue;
      var sec = SCREENS[k];
      if (!sec) continue;
      var on = (k === name);
      sec.hidden = !on;
      /* role="main" 은 현재 화면 하나에만 붙는다(§6.6 규칙 4). */
      if (on) sec.setAttribute('role', 'main');
      else sec.removeAttribute('role');
    }

    /* 캔버스에서 ui.js 가 만지는 유일한 것. 사건 화면에서만 분할 구도가 된다. */
    if (gl) {
      if (name === 'case') gl.setAttribute('data-split', '1');
      else gl.removeAttribute('data-split');
    }

    show(btnLobby, name === 'case');
    /* 결과 화면에 재시작 버튼을 두지 않는다 — 점수 갈이 루프의 입구다(06 §4-5). */
    show(btnRestart, name === 'lobby' || name === 'case');

    syncHud();
    tickClock();
  }

  /* ---------------------------------------------------------------- 시작 화면 */

  function renderStatic() {
    txt(q('nz-start-title'), CP.start.title);
    txt(q('nz-start-sub'), CP.start.subtitle);
    txt(q('nz-start-note'), CP.start.note);
    txt(q('nz-start-judge'), CP.start.judgeNote);
    txt(btnStart, CP.start.btnStart);
    txt(btnResume, CP.resume.btnResume);
    txt(storageNote, CP.start.storageNote);

    txt(btnLobby, CP.hud.btnLobby);
    txt(btnRestart, CP.hud.btnRestart);
    if (hudClock) hudClock.setAttribute('aria-label', CP.a11y.clockName);

    txt(q('nz-lobby-title'), CP.lobby.title);
    txt(lobbyHint, CP.lobby.hint);
    txt(btnLobbyResult, CP.lobby.btnResult);
    if (lobbyBar) lobbyBar.setAttribute('aria-label', CP.a11y.barName);

    txt(btnNext, CP.feedback.btnNext);

    txt(resultTitle, CP.result.title);
    fillResultQ(q('nz-result-q1'), CP.result.q1);
    fillResultQ(q('nz-result-q2'), CP.result.q2);
    txt(resultScoreNote, CP.result.scoreNote);
    txt(resultTeacher, CP.result.teacher);
    txt(resultCaption, CP.result.caption);
    txt(agreeQ, CP.result.agreeQ);
    txt(btnAgreeYes, CP.result.agreeYes);
    txt(btnAgreeNo, CP.result.agreeNo);
    txt(agreeDone, CP.result.agreeDone);
    txt(btnResultLobby, CP.result.btnLobby);
    txt(flatNote, CP.flat.note);

    txt(confirmTitle, CP.confirm.title);
    txt(btnConfirmNo, CP.confirm.no);
    txt(btnConfirmYes, CP.confirm.yes);

    for (var i = 0; i < choiceBtns.length; i++) {
      txt(choiceBtns[i].querySelector('.nz-choice-key'), posLabel(i));
    }
  }

  function fillResultQ(box, qq) {
    if (!box || !qq) return;
    txt(box.querySelector('.nz-q-en'), qq.en);
    txt(box.querySelector('.nz-q-ko'), qq.ko);
    txt(box.querySelector('.nz-q-term'), qq.term);
  }

  /* 이어하기 패널은 '의미 있는 진행'이 있을 때만 뜬다. 로비까지만 갔다가
     새로고침한 학생에게 묻는 것은 의미 없는 질문이다(§5.7). */
  function renderStart() {
    var resumable = NZ.State.hasResumable();
    var raw = resumable ? (NZ.State.load() || {}) : null;

    show(resumeBox, resumable);
    show(btnStart, !resumable);

    if (resumable) {
      var doneN = (Object.prototype.toString.call(raw.done) === '[object Array]') ? raw.done.length : 0;
      var answeredN = (raw.firstChoice && typeof raw.firstChoice === 'object')
        ? Object.keys(raw.firstChoice).length : 0;
      txt(resumeLine, fill(CP.resume.line, { done: doneN, total: NZ.State.total() }));
      txt(btnFresh, fill(CP.resume.btnFresh, { done: answeredN }));
    }

    applyScreen('start');
    NZ.Court.setScene('start');
    NZ.Court.setPose('idle');

    if (!resumable) { focusEl(btnStart); return; }
    /* 한참 전 기록이면 '처음부터'가 기본 포커스다 — 다른 반 학생이 쓰던 크롬북일 수 있다. */
    var savedAt = (typeof raw.savedAt === 'number') ? raw.savedAt : 0;
    focusEl((Date.now() - savedAt) > CFG.STALE_MS ? btnFresh : btnResume);
  }

  /* ---------------------------------------------------------------- 로비 */

  function buildLobby() {
    if (!fileList) return;
    fileList.textContent = '';
    fileBtns.length = 0;

    for (var i = 0; i < CASES.length; i++) {
      var c = CASES[i];
      var li = D.createElement('li');
      li.className = 'nz-file-slot';

      var b = D.createElement('button');
      b.className = 'nz-file';
      b.type = 'button';
      b.setAttribute('data-case-id', c.id);
      b.setAttribute('data-state', 'unread');
      b.setAttribute('data-current', 'false');
      b.tabIndex = -1;

      var no = D.createElement('span');
      no.className = 'nz-file-no';
      no.setAttribute('aria-hidden', 'true');
      no.textContent = pad2(c.n);

      /* 도장 글리프는 CSS 가 data-match 로 그린다 — 여기서 글자를 넣으면
         색만이 아니라 표기까지 두 곳에서 갈린다. */
      var stamp = D.createElement('span');
      stamp.className = 'nz-file-stamp';
      stamp.setAttribute('aria-hidden', 'true');

      var title = D.createElement('span');
      title.className = 'nz-file-title';
      title.textContent = c.title;

      var badge = D.createElement('span');
      badge.className = 'nz-file-badge';
      badge.setAttribute('aria-hidden', 'true');

      b.appendChild(no);
      b.appendChild(stamp);
      b.appendChild(title);
      b.appendChild(badge);
      b.addEventListener('click', onFileClick);

      li.appendChild(b);
      fileList.appendChild(li);
      fileBtns.push(b);
    }
  }

  function updateLobby() {
    var total = NZ.State.total();
    var done = NZ.State.completedCount();
    var all = NZ.State.allDone();
    var cur = all ? null : NZ.State.currentUnread();

    txt(lobbyProgress, fill(CP.lobby.progress, { done: done, total: total }));
    if (lobbyBar) lobbyBar.setAttribute('aria-valuenow', String(done));
    /* 막대 길이는 완료 수의 직접 표현이다. CSS 가 이 값을 알 방법이 없어
       여기서만 인라인으로 넣는다(트랜지션은 ui.css 가 건다). */
    if (lobbyBarFill) lobbyBarFill.style.width = (total ? (done / total) * 100 : 0) + '%';

    var focusIdx = -1;
    for (var i = 0; i < fileBtns.length; i++) {
      var c = CASES[i];
      var b = fileBtns[i];
      var st = NZ.State.stateOf(c.id);
      var isCur = (c.id === cur);
      var label;

      b.setAttribute('data-state', st);
      b.setAttribute('data-current', isCur ? 'true' : 'false');

      if (st === 'done') {
        var m = NZ.State.matchOf(c.id);
        b.setAttribute('data-match', m ? 'true' : 'false');
        label = m ? CP.file.doneMatch : CP.file.doneMiss;
      } else {
        b.removeAttribute('data-match');
        label = isCur ? CP.file.current : CP.file.unread;
      }

      txt(b.querySelector('.nz-file-badge'), label);
      b.setAttribute('aria-label', fill(CP.file.aria, { n: c.n, title: c.title, state: label }));
      b.tabIndex = -1;
      if (isCur && focusIdx < 0) focusIdx = i;
    }

    /* roving tabindex: 그리드 전체가 탭 스톱 1개다. */
    if (focusIdx < 0) focusIdx = 0;
    if (fileBtns[focusIdx]) fileBtns[focusIdx].tabIndex = 0;

    show(lobbyHint, !all);
    show(btnLobbyResult, all);
  }

  function setRoving(idx) {
    for (var i = 0; i < fileBtns.length; i++) fileBtns[i].tabIndex = (i === idx) ? 0 : -1;
  }

  function lobbyCols() {
    if (!fileBtns.length) return 1;
    var top = fileBtns[0].offsetTop;
    var n = 0;
    for (var i = 0; i < fileBtns.length; i++) {
      if (fileBtns[i].offsetTop === top) n++;
      else break;
    }
    return n || 1;
  }

  function moveLobbyFocus(idx) {
    if (idx < 0 || idx >= fileBtns.length) return;
    setRoving(idx);
    fileBtns[idx].focus({ preventScroll: true });
    /* preventScroll 은 화면 전이(계약 §10.4)의 규칙이지 격자 내부 이동의 규칙이 아니다.
       1열로 접히는 좁은 화면에서 End/ArrowDown 을 누르면 포커스만 내려가고 화면은
       그대로라 '아무 일도 안 일어났다'로 읽힌다(요구 §6 포커스 표시).
       block:'nearest' 라 이미 보이는 카드에서는 화면이 흔들리지 않는다. */
    try { fileBtns[idx].scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {}
  }

  function focusedFileIndex() {
    for (var i = 0; i < fileBtns.length; i++) if (fileBtns[i] === D.activeElement) return i;
    for (var j = 0; j < fileBtns.length; j++) if (fileBtns[j].tabIndex === 0) return j;
    return 0;
  }

  function goLobby(focusCaseId) {
    clearAllTimers();
    busy = false;
    NZ.State.setScreen('lobby');
    updateLobby();
    applyScreen('lobby');
    NZ.Court.setScene('lobby');
    NZ.Court.setPose('idle');
    NZ.Court.resume();

    var idx = -1;
    if (focusCaseId) idx = NZ.State.indexOf(focusCaseId);
    if (idx < 0) {
      var cur = NZ.State.currentUnread();
      idx = cur ? NZ.State.indexOf(cur) : 0;
    }
    if (idx < 0) idx = 0;
    setRoving(idx);
    focusEl(fileBtns[idx]);
  }

  function onFileClick(ev) {
    var id = ev.currentTarget.getAttribute('data-case-id');
    if (!id || !caseById(id)) return;
    NZ.Audio.play('open');
    goCase(id, true);
  }

  /* ---------------------------------------------------------------- 사건 화면 */

  /* 원문을 innerHTML 에 넣지 않는다. [[…]] 는 텍스트 노드와 <mark> 로 직접 조립한다.
     사건 데이터는 교사가 웹 편집기에서 고치는 파일이고, 거기 <> 가 섞여도
     화면이 깨지거나 스크립트가 되면 안 된다. */
  function appendMarked(node, s) {
    var re = /\[\[([\s\S]*?)\]\]/g;
    var last = 0;
    var m;
    while ((m = re.exec(s)) !== null) {
      if (m.index > last) node.appendChild(D.createTextNode(s.slice(last, m.index)));
      var mk = D.createElement('mark');
      /* 조건의 종류를 구분하지 않는다. 종류마다 색이 갈리면 그게 정답표다(06 §4-2). */
      mk.className = 'nz-key';
      mk.textContent = m[1];
      node.appendChild(mk);
      last = re.lastIndex;
    }
    if (last < s.length) node.appendChild(D.createTextNode(s.slice(last)));
  }

  function renderSituation(node, lines) {
    if (!node) return;
    node.textContent = '';
    for (var i = 0; i < lines.length; i++) {
      if (i > 0) node.appendChild(D.createTextNode(' '));
      appendMarked(node, String(lines[i]));
    }
  }

  function resetChoices(c, enabled) {
    for (var i = 0; i < choiceBtns.length; i++) {
      var b = choiceBtns[i];
      var o = c.options[i];
      b.setAttribute('data-choice-id', o ? o.id : '');
      b.setAttribute('data-label', posLabel(i));
      b.setAttribute('data-picked', 'false');
      b.setAttribute('data-expected', 'false');
      b.disabled = !enabled;
      txt(b.querySelector('.nz-choice-text'), o ? o.text : '');
      var badge = b.querySelector('.nz-choice-badge');
      txt(badge, '');
      show(badge, false);
    }
  }

  function markChoices(c, pickedId, expectedId) {
    for (var i = 0; i < choiceBtns.length; i++) {
      var b = choiceBtns[i];
      var o = c.options[i];
      if (!o) continue;
      var isPicked = (o.id === pickedId);
      var isExpected = (o.id === expectedId);
      b.setAttribute('data-picked', isPicked ? 'true' : 'false');
      b.setAttribute('data-expected', isExpected ? 'true' : 'false');

      var badge = b.querySelector('.nz-choice-badge');
      var label = '';
      if (isExpected && isPicked) label = CP.feedback.badgeBoth;
      else if (isExpected) label = CP.feedback.badgeExpected;
      else if (isPicked) label = CP.feedback.badgePicked;
      txt(badge, label);
      show(badge, !!label);
    }
  }

  function armChoices() {
    choicesArmed = false;
    for (var i = 0; i < choiceBtns.length; i++) choiceBtns[i].disabled = true;
    tArm = clearTimer(tArm);
    tArm = setTimeout(function () {
      tArm = 0;
      choicesArmed = true;
      for (var j = 0; j < choiceBtns.length; j++) choiceBtns[j].disabled = false;
    }, CFG.ARM_MS);
  }

  function armNext() {
    /* 버튼을 숨기지는 않는다. 어디를 눌러야 하는지 모르는 쪽이 더 나쁘다(06 §4-3).
       대신 armChoices() 와 같은 방식으로 '눌러도 안 되는 상태'를 실제 disabled 로 보인다 —
       활성으로 보이는데 클릭만 무시하면 학생은 버튼이 고장난 줄 안다. */
    nextArmed = false;
    if (btnNext) btnNext.disabled = true;
    tNext = clearTimer(tNext);
    tNext = setTimeout(function () {
      tNext = 0;
      nextArmed = true;
      if (btnNext) btnNext.disabled = false;
    }, CFG.NEXT_ARM_MS);
  }

  function hideFeedback() {
    show(feedback, false);
    show(fbLine, false);
    txt(fbLine, '');
    show(fbNote, false);
    show(fbLinger, false);
  }

  function goCase(id, fromLobby) {
    var c = caseById(id);
    if (!c) return;

    clearAllTimers();
    busy = false;

    NZ.State.setCurrent(id);

    /* 이미 답한 사건은(완료든, lock 상태로 저장됐다 승격됐든) 피드백으로 연다. */
    var answered = NZ.State.isAnswered(id);

    secCase.setAttribute('data-case-id', id);
    secCase.setAttribute('data-review', answered ? 'true' : 'false');

    txt(caseNo, fill(CP.case.noLabel, { n: c.n }));
    txt(caseTitle, c.title);
    renderSituation(caseBody, c.situation || []);
    txt(caseHook, c.hook || '');
    show(caseHook, !!c.hook);
    txt(caseQ, c.question);

    resetChoices(c, !answered);
    hideFeedback();

    NZ.State.setScreen('case');
    NZ.State.setPhase(answered ? 'feedback' : 'ask');
    secCase.setAttribute('data-phase', answered ? 'feedback' : 'ask');
    applyScreen('case');
    NZ.Court.setScene('case');
    NZ.Court.setPose(answered ? 'review' : 'ready');

    if (answered) {
      /* 재방문에는 반응을 다시 재생하지 않는다. 도장 소리를 반복시키지 않기 위해서다(R10). */
      openFeedback(c, {
        match: NZ.State.matchOf(id) === true,
        choiceId: NZ.State.choiceOf(id),
        expectedId: NZ.State.expectedOf(id)
      }, true);
      focusEl(caseTitle);
    } else {
      armChoices();
      focusEl(caseTitle);
    }

    if (fromLobby) say(fill(CP.a11y.liveCaseOpen, { n: c.n, title: c.title }));
  }

  /* 노직의 한 줄. 불일치는 그 사건 전용 대사, 일치는 반응 대사 풀에서 고른다.
     사건 인덱스 + 연속 일치 수로 돌려 같은 줄이 연달아 나오지 않게 한다. */
  function pickLine(c, match) {
    if (Object.prototype.hasOwnProperty.call(lineByCase, c.id)) return lineByCase[c.id];
    var s;
    if (!match) {
      s = c.wrongLine;
    } else {
      var pool = CP.approve || [];
      s = pool.length ? pool[(NZ.State.indexOf(c.id) + streakMatch) % pool.length] : '';
    }
    lineByCase[c.id] = s;
    return s;
  }

  /* 같은 개념어의 한국어 병기는 첫 등장에 한 번만 붙인다.
     사건마다 반복하면 영어 한 줄이 두 줄이 되고, 읽는 데 20초가 더 든다. */
  function koFor(c) {
    if (!Object.prototype.hasOwnProperty.call(koShownByCase, c.id)) {
      var key = String(c.conceptKo || '');
      koShownByCase[c.id] = !!key && !seenKo[key];
      if (key) seenKo[key] = true;
    }
    return koShownByCase[c.id] ? c.conceptKo : '';
  }

  /* 라벨('왜', '핵심 개념')은 스크린리더에만 준다. ui.css 에 이 라벨을 위한
     선택자가 없어서, 보이게 넣으면 스타일 없는 글자가 카드 안에 떠 버린다. */
  function labelled(node, label, body, lang) {
    if (!node) return;
    node.textContent = '';
    if (label) {
      var sr = D.createElement('span');
      sr.className = 'nz-sr';
      sr.setAttribute('lang', 'ko');
      sr.textContent = label + ' ';
      node.appendChild(sr);
    }
    var span = D.createElement('span');
    if (lang) span.setAttribute('lang', lang);
    span.textContent = body;
    node.appendChild(span);
  }

  function openFeedback(c, info, review) {
    var matched = !!info.match;
    var expIdx = optionIndex(c, info.expectedId);

    fbVerdict.setAttribute('data-verdict', matched ? 'match' : 'miss');
    txt(fbWord, matched ? CP.feedback.match : CP.feedback.miss);
    /* 계약이 허용한 단 하나의 인라인 값. 색 자체가 아니라 토큰을 가리킨다. */
    if (feedback) feedback.style.setProperty('--nz-fb-accent', matched ? 'var(--nz-match)' : 'var(--nz-miss)');

    var label = posLabel(expIdx < 0 ? 0 : expIdx);
    txt(fbExpected, fill(CP.feedback.expectedLabel, { label: label }));
    labelled(fbReason, CP.feedback.reasonLabel, c.reason, null);

    var note = (CP.caseNote || {})[c.id];
    txt(fbNote, note || '');
    show(fbNote, !!note);

    var ko = koFor(c);
    labelled(fbEn, CP.feedback.conceptLabel, c.concept, 'en');
    if (ko) {
      var koSpan = D.createElement('span');
      koSpan.className = 'nz-ko';
      koSpan.setAttribute('lang', 'ko');
      koSpan.textContent = ' ' + ko;
      fbEn.appendChild(koSpan);
    }

    var linger = (CP.linger || {})[c.id];
    txt(fbLinger, linger || '');
    show(fbLinger, !!linger);

    markChoices(c, info.choiceId, info.expectedId);
    for (var i = 0; i < choiceBtns.length; i++) choiceBtns[i].disabled = true;

    var line = pickLine(c, matched);
    txt(fbLine, line || '');
    show(fbLine, !!line);

    /* 라벨은 markDone 이 반영된 뒤의 값으로 붙어야 한다. 마지막 사건에서
       '다음 사건'이라고 적힌 버튼이 결과로 튀면 그게 제일 당황스럽다.
       그래서 이 사건이 done 으로 들어간 뒤의 완료 수를 미리 계산한다. */
    var willAll = NZ.State.isDone(c.id)
      ? NZ.State.allDone()
      : (NZ.State.completedCount() + 1 >= NZ.State.total());
    btnNext.setAttribute('data-action', willAll ? 'result' : 'next');
    txt(btnNext, willAll ? CP.feedback.btnResult : CP.feedback.btnNext);

    show(feedback, true);

    /* R4: 피드백이 화면에 완전히 표시된 순간이 완료 시점이다.
       '다음'을 누를 때가 아니다 — 누르지 않고 로비로 나가도 푼 것은 푼 것이다. */
    NZ.State.markDone(c.id);
    NZ.State.setPhase('feedback');
    secCase.setAttribute('data-phase', 'feedback');
    busy = false;

    updateLobby();
    syncHud();

    if (!review) {
      focusEl(fbVerdict);
      /* 낭독에는 선택지 배지가 없다. 위치 번호만 읽어 주면 정보가 0이므로 본문을 붙인다. */
      alertOnce(fill(CP.a11y.liveVerdict, {
        verdict: matched ? CP.feedback.match : CP.feedback.miss,
        label: label,
        text: (expIdx >= 0 && c.options[expIdx]) ? c.options[expIdx].text : ''
      }));
      say(fill(CP.a11y.liveProgress, { done: NZ.State.completedCount(), total: NZ.State.total() }));
    }

    armNext();
  }

  /* T7 — 선택 확정. 여기가 두 번 돌면 채점이 두 번 된다. 네 겹으로 막는다. */
  function onChoice(ev) {
    if (busy || !choicesArmed) return;                 // ① 동기 플래그 ② 무장 지연
    if (NZ.State.phase() !== 'ask') return;            // ③ 위상 가드
    var id = NZ.State.current();
    if (!id) return;
    var c = caseById(id);
    if (!c) return;
    var choiceId = ev.currentTarget.getAttribute('data-choice-id');
    if (!choiceId) return;

    busy = true;
    for (var i = 0; i < choiceBtns.length; i++) choiceBtns[i].disabled = true;
    choicesArmed = false;
    NZ.State.setPhase('lock');
    secCase.setAttribute('data-phase', 'lock');

    var r = NZ.State.answer(id, choiceId);             // ④ 상태 레벨 멱등성
    var matched = !!r.match;

    if (matched) { streakMatch++; streakMiss = 0; }
    else { streakMiss++; streakMatch = 0; }

    NZ.Audio.play('pick');
    NZ.Audio.play(matched ? 'match' : 'rebut');

    /* 말풍선은 지휘봉이 책상을 치는 그 순간 함께 뜬다. 피드백보다 먼저다. */
    var line = pickLine(c, matched);
    txt(fbLine, line || '');
    show(fbLine, !!line);

    var ms = NZ.Court.react(matched ? 'approve' : 'rebut', {
      seed: NZ.State.indexOf(id),
      streak: matched ? streakMatch : streakMiss
    });
    /* 연출 길이는 Court 가 정한다. 다만 숫자가 아니면 피드백이 영원히 안 열리므로
       계약이 보장한 구간으로만 되돌린다. 자체 상수를 만들지는 않는다. */
    if (typeof ms !== 'number' || !isFinite(ms)) ms = CFG.REACT_MIN;
    if (ms < CFG.REACT_MIN) ms = CFG.REACT_MIN;
    if (ms > CFG.REACT_MAX) ms = CFG.REACT_MAX;

    tReact = clearTimer(tReact);
    tReact = setTimeout(function () {
      tReact = 0;
      openFeedback(c, { match: matched, choiceId: r.choiceId, expectedId: r.expectedId }, false);
    }, ms);
  }

  /* T10 / T11 — '다음 사건'은 로비를 거치지 않는다. 마지막 사건에서는 같은 버튼이 결과로 간다. */
  function onNext() {
    if (busy || !nextArmed) return;
    if (NZ.State.phase() !== 'feedback') return;
    if (NZ.State.allDone()) { goResult(); return; }
    var id = NZ.State.nextUnanswered(NZ.State.current());
    if (!id) { goResult(); return; }
    NZ.Audio.play('next');
    goCase(id, false);
  }

  /* ---------------------------------------------------------------- 결과 */

  function renderResult() {
    txt(resultScore, fill(CP.result.score, {
      score: NZ.State.score(), total: NZ.State.total()
    }));
    /* #nz-result-time 은 자식 span 을 갖는다. 부모 textContent 를 덮으면 그 span 이
       사라져 두 번째 렌더에서 시간이 통째로 없어진다. 그래서 span 안에 다 넣는다. */
    txt(resultTimeV, fill(CP.result.timeLabel, { time: fmtClock(NZ.State.elapsedMs()) }));

    /* 고른 쪽을 화면에 남기지 않는다. 옆자리에서 읽히면 설문이 아니라 표명이 된다(06 §2-6). */
    btnAgreeYes.setAttribute('aria-pressed', 'false');
    btnAgreeNo.setAttribute('aria-pressed', 'false');
    show(agreeDone, false);

    show(flatNote, root.getAttribute('data-three') === 'off');
  }

  function goResult() {
    if (!NZ.State.allDone()) { goLobby(null); return; }
    clearAllTimers();
    busy = false;
    NZ.State.setScreen('result');
    renderResult();
    applyScreen('result');
    NZ.Court.setScene('result');
    NZ.Court.pause();
    NZ.Audio.play('result');
    focusEl(resultTitle);
  }

  function onAgree(v) {
    NZ.State.setAgree(v);
    btnAgreeYes.setAttribute('aria-pressed', 'false');
    btnAgreeNo.setAttribute('aria-pressed', 'false');
    show(agreeDone, true);
    say(CP.result.agreeDone);
  }

  /* ---------------------------------------------------------------- 확인 모달 */

  var INERT_OK = ('inert' in D.documentElement);

  function setBackgroundInert(on) {
    var list = [q('nz-hud'), secStart, secLobby, secCase, secResult];
    for (var i = 0; i < list.length; i++) {
      if (!list[i]) continue;
      if (INERT_OK) list[i].inert = on;
      else if (on) list[i].setAttribute('aria-hidden', 'true');
      else list[i].removeAttribute('aria-hidden');
    }
  }

  function openConfirm() {
    if (modalOpen) return;
    if (curScreen !== 'lobby' && curScreen !== 'case') return;
    if (NZ.State.phase() === 'lock') return;
    modalOpen = true;
    focusBeforeModal = D.activeElement;
    txt(confirmText, fill(CP.confirm.text, {
      done: NZ.State.completedCount(), total: NZ.State.total()
    }));
    show(confirmBox, true);
    setBackgroundInert(true);
    /* 파괴적인 쪽을 기본 포커스로 두지 않는다. */
    focusEl(btnConfirmNo);
  }

  function closeConfirm() {
    if (!modalOpen) return;
    modalOpen = false;
    show(confirmBox, false);
    setBackgroundInert(false);
    focusEl(focusBeforeModal);
    focusBeforeModal = null;
  }

  function doReset() {
    modalOpen = false;
    show(confirmBox, false);
    setBackgroundInert(false);
    clearAllTimers();
    busy = false;
    lineByCase = {};
    koShownByCase = {};
    seenKo = {};
    streakMatch = 0;
    streakMiss = 0;
    NZ.State.reset();
    updateLobby();
    hideFeedback();
    NZ.Court.resume();
    renderStart();
    say(CP.a11y.liveReset);
  }

  /* ---------------------------------------------------------------- 소리 · 모션 */

  function toggleSound() {
    var nowMuted = !NZ.State.muted();
    NZ.State.setMuted(nowMuted);
    var applied = NZ.Audio.setEnabled(!nowMuted);
    /* 브라우저가 오디오를 못 켜면 화면 표기도 그 사실을 따라가야 한다. */
    if (applied === false && !nowMuted) NZ.State.setMuted(true);
    if (applied === true) NZ.Audio.play('on');
    audioSynced = true;
    syncSoundDom();
    say(NZ.State.muted() ? CP.a11y.liveSoundOff : CP.a11y.liveSoundOn);
  }

  function toggleMotion() {
    var reduced = root.getAttribute('data-motion') === 'reduced';
    NZ.State.setMotion(reduced ? 'full' : 'reduced');
    applyMotion();
  }

  /* 저장된 취향이 '소리 켬'이어도 로드 시점에 AudioContext 를 만들지 않는다.
     자동 재생 금지는 계약이고, 크롬은 제스처 밖의 컨텍스트를 정지 상태로 만든다.
     그래서 첫 제스처에 한 번 맞춰 준다. */
  function syncAudioOnGesture() {
    if (audioSynced) return;
    audioSynced = true;
    if (!NZ.State.muted()) {
      var applied = NZ.Audio.setEnabled(true);
      if (applied === false) { NZ.State.setMuted(true); syncSoundDom(); }
    }
  }

  function toggleFullscreen() {
    try {
      if (D.fullscreenElement) {
        var p = D.exitFullscreen();
        if (p && p['catch']) p['catch'](function () { /* 실패는 조용히 넘긴다 */ });
      } else if (D.documentElement.requestFullscreen) {
        var r = D.documentElement.requestFullscreen();
        if (r && r['catch']) r['catch'](function () { /* 수업 중 오류 표시 금지 */ });
      }
    } catch (e) { /* 전체화면은 있으면 좋은 기능이지 필수가 아니다 */ }
  }

  /* ---------------------------------------------------------------- 키보드 */

  function digitOf(code) {
    var m = /^(?:Digit|Numpad)([0-9])$/.exec(code || '');
    return m ? Number(m[1]) : -1;
  }

  function isEnterOrSpace(e) {
    return e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar' || e.code === 'Space';
  }

  function activeIsButton() {
    var a = D.activeElement;
    return !!(a && a.tagName === 'BUTTON');
  }

  function onKeyDown(e) {
    if (e.repeat) return;              // 길게 누르기로 두 번 채점되지 않게
    syncAudioOnGesture();

    if (modalOpen) {
      if (e.key === 'Escape') { e.preventDefault(); closeConfirm(); return; }
      if (e.key === 'Tab') {
        e.preventDefault();
        var f = [btnConfirmNo, btnConfirmYes];
        var i = f.indexOf(D.activeElement);
        var n = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i < 0 || i >= f.length - 1 ? 0 : i + 1);
        f[n].focus({ preventScroll: true });
      }
      return;
    }

    /* 반응 연출 중에는 모든 키를 버린다. Tab 은 preventDefault 하지 않으므로 살아 있다. */
    if (curScreen === 'case' && NZ.State.phase() === 'lock') return;

    if (e.code === 'KeyM') { e.preventDefault(); toggleSound(); return; }
    if (e.code === 'KeyF') { e.preventDefault(); toggleFullscreen(); return; }
    if (e.code === 'KeyR' && (curScreen === 'lobby' || curScreen === 'case')) {
      e.preventDefault(); openConfirm(); return;
    }

    if (curScreen === 'start') { onKeyStart(e); return; }
    if (curScreen === 'lobby') { onKeyLobby(e); return; }
    if (curScreen === 'case') { onKeyCase(e); return; }
    if (curScreen === 'result') { onKeyResult(e); return; }
  }

  function onKeyStart(e) {
    if (resumeBox && !resumeBox.hidden) {
      /* 이어하기 패널에서 Esc 는 무시한다 — 반드시 하나를 골라야 한다. */
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        (D.activeElement === btnResume ? btnFresh : btnResume).focus({ preventScroll: true });
      }
      return;
    }
    if (isEnterOrSpace(e) && !activeIsButton()) { e.preventDefault(); btnStart.click(); }
  }

  function onKeyLobby(e) {
    var n = fileBtns.length;
    if (!n) return;
    var d = digitOf(e.code);
    if (d >= 0) {
      e.preventDefault();
      var target = (d === 0) ? n - 1 : d - 1;
      if (target < n && fileBtns[target]) { setRoving(target); fileBtns[target].click(); }
      return;
    }
    var i = focusedFileIndex();
    var cols = lobbyCols();
    if (e.key === 'ArrowRight') { e.preventDefault(); moveLobbyFocus((i + 1) % n); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); moveLobbyFocus((i - 1 + n) % n); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); if (i + cols < n) moveLobbyFocus(i + cols); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); if (i - cols >= 0) moveLobbyFocus(i - cols); return; }
    if (e.key === 'Home') { e.preventDefault(); moveLobbyFocus(0); return; }
    if (e.key === 'End') { e.preventDefault(); moveLobbyFocus(n - 1); return; }
    if (isEnterOrSpace(e) && !activeIsButton()) {
      e.preventDefault();
      moveLobbyFocus(i);
      fileBtns[i].click();
    }
  }

  /* 사건 본문이 지금 포커스를 갖고 있고 실제로 넘치는가. 참이면 스크롤 키는 브라우저 몫이다. */
  function bodyScrollable() {
    return !!caseBody && D.activeElement === caseBody
      && caseBody.scrollHeight > caseBody.clientHeight + 2;
  }

  function onKeyCase(e) {
    var phase = NZ.State.phase();

    if (e.key === 'Escape') {
      e.preventDefault();
      goLobby(NZ.State.current());
      return;
    }

    if (phase === 'ask') {
      var d = digitOf(e.code);
      if (d === 1 || e.code === 'KeyA') { e.preventDefault(); if (choiceBtns[0]) choiceBtns[0].click(); return; }
      if (d === 2 || e.code === 'KeyB') { e.preventDefault(); if (choiceBtns[1]) choiceBtns[1].click(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        /* 좁은/낮은 뷰포트에서 #nz-case-body 는 자기 스크롤을 갖고 Tab 으로 포커스된다.
           거기서 방향키를 뺏으면 답을 고르기 전에 본문 마지막 줄을 읽을 방법이 없어진다. */
        if (bodyScrollable()) return;
        e.preventDefault();
        var cur = choiceBtns.indexOf(D.activeElement);
        var fwd = (e.key === 'ArrowDown' || e.key === 'ArrowRight');
        var next = (cur < 0) ? 0 : (cur + (fwd ? 1 : choiceBtns.length - 1)) % choiceBtns.length;
        if (choiceBtns[next]) choiceBtns[next].focus({ preventScroll: true });
        return;
      }
      if (isEnterOrSpace(e) && !activeIsButton()) {
        /* Space 로 본문을 한 화면 넘긴다. Enter 는 그대로 선택지로 보낸다. */
        if (e.key !== 'Enter' && bodyScrollable()) return;
        e.preventDefault();
        if (choiceBtns[0]) choiceBtns[0].focus({ preventScroll: true });
      }
      return;
    }

    if (phase === 'feedback') {
      /* 숫자·A·B 는 무시한다. 이미 확정된 선택을 다시 누르는 손가락이 많다. */
      if (e.key === 'ArrowRight') { e.preventDefault(); onNext(); return; }
      if (isEnterOrSpace(e) && !activeIsButton()) { e.preventDefault(); onNext(); return; }
    }
  }

  function onKeyResult(e) {
    if (e.key === 'Escape') { e.preventDefault(); goLobby(null); return; }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      (D.activeElement === btnAgreeYes ? btnAgreeNo : btnAgreeYes).focus({ preventScroll: true });
      return;
    }
    if (isEnterOrSpace(e) && !activeIsButton()) { e.preventDefault(); btnResultLobby.click(); }
  }

  /* ---------------------------------------------------------------- 배선 */

  function grabElements() {
    root = q('nz-root');
    gl = q('nz-gl');
    live = q('nz-live');
    alertBox = q('nz-alert');

    btnLobby = q('nz-btn-lobby');
    hudDone = q('nz-hud-done');
    hudDots = q('nz-hud-dots');
    hudClock = q('nz-hud-clock');
    btnMute = q('nz-btn-mute');
    muteText = btnMute ? btnMute.querySelector('.nz-btn-mute-t') : null;
    btnRestart = q('nz-btn-restart');

    secStart = q('nz-start');
    secLobby = q('nz-lobby');
    secCase = q('nz-case');
    secResult = q('nz-result');
    SCREENS = { start: secStart, lobby: secLobby, 'case': secCase, result: secResult };

    btnStart = q('nz-btn-start');
    resumeBox = q('nz-resume');
    resumeLine = q('nz-resume-line');
    btnResume = q('nz-btn-resume');
    btnFresh = q('nz-btn-fresh');
    storageNote = q('nz-storage-note');

    lobbyProgress = q('nz-lobby-progress');
    lobbyBar = q('nz-lobby-bar');
    lobbyBarFill = q('nz-lobby-bar-fill');
    fileList = q('nz-file-list');
    lobbyHint = q('nz-lobby-hint');
    btnLobbyResult = q('nz-btn-lobby-result');

    caseNo = q('nz-case-no');
    caseTitle = q('nz-case-title');
    caseBody = q('nz-case-body');
    caseHook = q('nz-case-hook');
    caseQ = q('nz-case-q');
    choiceBtns = [q('nz-choice-1'), q('nz-choice-2')];

    feedback = q('nz-feedback');
    fbVerdict = q('nz-fb-verdict');
    fbWord = fbVerdict ? fbVerdict.querySelector('.nz-fb-word') : null;
    fbExpected = q('nz-fb-expected');
    fbReason = q('nz-fb-reason');
    fbNote = q('nz-fb-note');
    fbEn = q('nz-fb-en');
    fbLinger = q('nz-fb-linger');
    btnNext = q('nz-btn-next');
    fbLine = q('nz-fb-line');

    resultTitle = q('nz-result-title');
    resultScore = q('nz-result-score');
    resultScoreNote = q('nz-result-score-note');
    resultTimeV = q('nz-result-time-v');
    resultTeacher = q('nz-result-teacher');
    resultCaption = q('nz-result-caption');
    agreeQ = q('nz-agree-q');
    btnAgreeYes = q('nz-btn-agree-yes');
    btnAgreeNo = q('nz-btn-agree-no');
    agreeDone = q('nz-agree-done');
    btnResultLobby = q('nz-btn-result-lobby');
    flatNote = q('nz-flat-note');

    confirmBox = q('nz-confirm');
    confirmTitle = q('nz-confirm-title');
    confirmText = q('nz-confirm-text');
    btnConfirmNo = q('nz-btn-confirm-no');
    btnConfirmYes = q('nz-btn-confirm-yes');
  }

  function buildDots() {
    if (!hudDots) return;
    hudDots.textContent = '';
    dots.length = 0;
    for (var i = 0; i < CASES.length; i++) {
      var s = D.createElement('span');
      s.className = 'nz-dot';
      s.setAttribute('data-dot', 'unread');
      hudDots.appendChild(s);
      dots.push(s);
    }
  }

  /* 모션 감소 토글은 copy.js 가 문구를 줄 때만 만든다.
     ui.js 는 화면 문자열을 갖지 않기로 했고, 라벨 없는 버튼을 HUD 에 세우면
     무엇을 끄는 버튼인지 아무도 모른다. 문구가 없으면 OS 설정만 따른다. */
  function buildMotionToggle() {
    if (!btnMute || !btnMute.parentNode) return;
    var h = CP.hud || {};
    if (!h.motionName || !h.motionOn || !h.motionOff) return;

    btnMotion = D.createElement('button');
    btnMotion.type = 'button';
    btnMotion.id = 'nz-btn-motion';
    btnMotion.setAttribute('aria-label', h.motionName);
    btnMotion.setAttribute('aria-pressed', 'false');

    var icon = D.createElement('span');
    icon.className = 'nz-icon';
    icon.setAttribute('aria-hidden', 'true');
    var t = D.createElement('span');
    t.className = 'nz-btn-mute-t';

    btnMotion.appendChild(icon);
    btnMotion.appendChild(t);
    btnMute.parentNode.insertBefore(btnMotion, btnMute.nextSibling);
    btnMotion.addEventListener('click', toggleMotion);
  }

  function wire() {
    /* click 만 건다. pointerdown 과 같이 걸면 터치에서 두 번 발화한다.
       dblclick 은 아예 바인딩하지 않는다. */
    btnStart.addEventListener('click', function () {
      /* 개정(開廷). 여기서만 울린다 — 사건 화면에서 로비로 돌아올 때는 아니다. */
      NZ.Audio.play('start');
      NZ.State.startFresh();
      goLobby(null);
    });

    btnResume.addEventListener('click', function () {
      var snap = NZ.State.resume();
      resumeTo(snap);
    });

    btnFresh.addEventListener('click', function () {
      /* 패널 자체가 확인 절차다. 여기서 모달을 또 띄우지 않는다. */
      NZ.State.reset();
      NZ.State.startFresh();
      goLobby(null);
    });

    btnLobby.addEventListener('click', function () {
      if (NZ.State.phase() === 'lock') return;
      goLobby(NZ.State.current());
    });
    btnRestart.addEventListener('click', openConfirm);
    if (btnMute) btnMute.addEventListener('click', toggleSound);

    btnLobbyResult.addEventListener('click', goResult);

    for (var i = 0; i < choiceBtns.length; i++) {
      if (choiceBtns[i]) choiceBtns[i].addEventListener('click', onChoice);
    }
    btnNext.addEventListener('click', onNext);

    btnAgreeYes.addEventListener('click', function () { onAgree('yes'); });
    btnAgreeNo.addEventListener('click', function () { onAgree('no'); });
    btnResultLobby.addEventListener('click', function () { goLobby(null); });

    btnConfirmNo.addEventListener('click', closeConfirm);
    btnConfirmYes.addEventListener('click', doReset);

    D.addEventListener('keydown', onKeyDown);
    D.addEventListener('click', syncAudioOnGesture, true);

    /* 캔버스 크기 재계산은 프레임당 한 번이면 충분하다. 크롬북에서 리사이즈가
       연속으로 쏟아지면 렌더러 재설정만으로 프레임을 다 먹는다. */
    window.addEventListener('resize', function () {
      if (rafResize) return;
      rafResize = true;
      requestAnimationFrame(function () {
        rafResize = false;
        NZ.Court.resize();
      });
    });

    D.addEventListener('visibilitychange', function () {
      if (D.hidden) {
        NZ.State.save();      // state.js 는 document 를 모른다. 저장 시점은 여기서 정한다
        NZ.Court.pause();
      } else if (curScreen !== 'result') {
        NZ.Court.resume();
      }
    });
    window.addEventListener('pagehide', function () { NZ.State.save(); });

    if (mqMotion) {
      if (typeof mqMotion.addEventListener === 'function') mqMotion.addEventListener('change', applyMotion);
      else if (typeof mqMotion.addListener === 'function') mqMotion.addListener(applyMotion);
    }

    NZ.State.onChange(function () {
      syncHud();
      applyMotion();
    }, 'ui');
  }

  function resumeTo(snap) {
    var s = snap || NZ.State.snapshot();
    var id = s.current;
    if (s.screen === 'result' && NZ.State.allDone()) { goResult(); return; }
    if (s.screen === 'case' && id && caseById(id)) { goCase(id, false); return; }
    goLobby(id);
  }

  /* ---------------------------------------------------------------- 시작 */

  function start() {
    CP = NZ.COPY;
    CFG = NZ.CONFIG;
    CASES = NZ.CASES;

    grabElements();
    buildDots();
    buildLobby();
    buildMotionToggle();
    renderStatic();
    wire();

    applyMotion();
    syncSoundDom();
    updateLobby();

    /* 저장이 없거나 손상됐거나 의미가 없으면 조용히 새 판으로 맞춘다(T1).
       '기록을 지웠다'고 알릴 일이 아니다 — 지울 기록이 없었다. */
    if (!NZ.State.hasResumable()) NZ.State.reset({ silent: true });

    renderStart();

    /* 경과 시간만 센다. 카운트다운이 아니므로 5분이 지나도 아무 일도 하지 않는다. */
    tickClock();
    tClock = setInterval(tickClock, CFG.CLOCK_MS);
  }

  window.NZ.UI = { start: start };
})();
