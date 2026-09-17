/* YM — 교사 조종석.
 *
 * 설계 원칙 하나: 선생님은 33명 앞에서 이 화면을 처음 쓴다.
 * 그래서 "다음에 눌러야 할 버튼" 하나만 크게 띄우고, 나머지는 접어 둔다.
 * 순서를 외우지 않아도 되게 만드는 것이 이 파일의 전부다.
 */
(function () {
  'use strict';

  var U = YM.ui, C = YM.CONFIG, db = YM.db;
  var $ = U.$, el = U.el;

  var params = new URLSearchParams(location.search);
  var ROOM = (params.get('room') || '').toUpperCase();
  var TOKEN = null;
  var state = null;
  var timer = null;
  var startedAt = null;       // 활동 전체 경과 시계
  var busyUntil = 0;          // 이 시각까지는 큰 버튼을 다시 그리지도, 받지도 않는다
  var shownStepId = null;     // 지금 화면에 있는 버튼이 어느 단계인지

  var KEY_T = 'ym.admin_token', KEY_R = 'ym.admin_room';

  // -------------------------------------------------------------------
  // 단계 정의 — 순서가 곧 수업 진행이다
  // -------------------------------------------------------------------
  // target 은 목표 소요 시간(초). 전체 22분 안에 들어오는지 가늠하는 용도.
  var STEPS = [
    { id: 'open',    label: '입장 열기',        sub: '학생들이 들어옵니다',        target: 120,
      when: function (s) { return !s.room.join_open && !s.room.roster_frozen_at; } },
    { id: 'lock',    label: '명단 잠그기',      sub: '좌석 수가 여기서 정해집니다', target: 10,
      when: function (s) { return s.room.join_open; } },
    { id: 'booking', label: '예매 시작',        sub: '8초 뒤 열립니다',           target: 40,
      when: function (s) { return s.room.roster_frozen_at && !s.room.booking_opens_at; } },
    { id: 'prevote', label: '사전 투표 (30초)', sub: '돈 이야기가 나오기 전에',    target: 45,
      when: function (s) { return s.room.booking_opens_at && s.room.phase === 'booking'; } },
    { id: 'decide',  label: '가질까 팔까 (90초)', sub: '좌석 주인들이 정합니다',   target: 100,
      when: function (s) { return s.room.phase === 'prevote'; } },
    { id: 'budget',  label: '예산 배정',        sub: '전원에게 불평등하게',        target: 45,
      when: function (s) { return s.room.phase === 'decide' && !s.room.wealth_distributed_at; } },
    // 예산을 이미 나눠 준 뒤에 '되팔기 30초 더'를 눌러 decide 로 돌아온 경우.
    // 이 줄이 없으면 예산 배정(단발)만 계속 뜨고 경매로 갈 길이 없어진다.
    { id: 'auction', label: '경매 시작 (60초)', sub: '여기가 절정입니다',          target: 90,
      when: function (s) { return s.room.phase === 'decide' && s.room.wealth_distributed_at; } },
    { id: 'auction', label: '경매 시작 (60초)', sub: '여기가 절정입니다',          target: 90,
      when: function (s) { return s.room.phase === 'budget'; } },
    { id: 'results', label: '결과 보기',        sub: '투표 먼저, 통계는 그다음',   target: 240,
      when: function (s) { return s.room.phase === 'auction'; } },
    { id: 'yosemite',label: '요세미티로',       sub: '마지막 3문항 투표까지',      target: 150,
      when: function (s) { return s.room.phase === 'results'; } },
  ];

  function nextStep(s) {
    for (var i = 0; i < STEPS.length; i++) if (STEPS[i].when(s)) return STEPS[i];
    return null;
  }

  // -------------------------------------------------------------------
  // 통신
  // -------------------------------------------------------------------
  function call(fn, extra) {
    var a = Object.assign({ p_room_code: ROOM, p_admin_token: TOKEN }, extra || {});
    return db.rpc(fn, a);
  }

  async function poll() {
    try {
      state = await call('admin_state');
      if (!startedAt && state.room.roster_frozen_at) startedAt = new Date(state.room.roster_frozen_at).getTime();
      render();
      // 정산은 교사 브라우저에 기대지 않지만, 조종석도 한 명의 재촉자로 참여한다.
      if (state.room.phase === 'auction') {
        db.rpc('settle_expired_listings', { p_room_code: ROOM }).catch(function () {});
      }
    } catch (e) {
      $('#connText').textContent = '끊김';
      $('#conn').className = 'ym-conn is-off';
    }
  }

  // -------------------------------------------------------------------
  // 그리기
  // -------------------------------------------------------------------
  function stat(label, value, warn) {
    var b = el('div', 'ym-stat' + (warn ? ' is-warn' : ''));
    b.appendChild(el('span', 'ym-stat__v', value));
    b.appendChild(el('span', 'ym-stat__k', label));
    return b;
  }

  function render() {
    if (!state) return;
    var s = state, r = s.room;

    $('#conn').className = 'ym-conn is-live';
    $('#connText').textContent = '연결됨';
    $('#barRoom').textContent = ROOM + (r.dry_run ? ' · 연습' : '');

    // 경과 시계. 22분이 목표, 25분이 한계.
    if (startedAt) {
      var mins = Math.floor((Date.now() - startedAt) / 60000);
      var secs = Math.floor(((Date.now() - startedAt) % 60000) / 1000);
      var c = $('#barClock');
      c.textContent = String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
      c.className = 'ym-adminbar__clock' + (mins >= 25 ? ' is-over' : mins >= 22 ? ' is-warn' : '');
    }

    // 현황 — 단계마다 봐야 할 숫자가 다르다
    var box = $('#stats'); U.clear(box);
    box.appendChild(stat('참가', s.players));
    if (r.seat_count) box.appendChild(stat('좌석', s.seats_taken + '/' + s.seats_total));
    if (r.phase === 'decide' || r.phase === 'budget') {
      var keep = s.seats_total - s.decided_sell;
      box.appendChild(stat('팔겠다', s.decided_sell, s.decided_sell < 3));
      box.appendChild(stat('가진다', keep));
    }
    if (r.phase === 'auction') {
      box.appendChild(stat('매물', s.listings_open));
      box.appendChild(stat('입찰', s.bids));
      box.appendChild(stat('마감', s.next_close ? U.secs(db.msUntil(s.next_close)) : '—'));
    }
    var vc = r.vote_counts || {};
    ['pre', 'post'].forEach(function (q) {
      if (vc[q]) {
        var n = (vc[q].yes || 0) + (vc[q].no || 0) + (vc[q].unsure || 0);
        box.appendChild(stat(q === 'pre' ? '사전투표' : '사후투표', n + '/' + s.players));
      }
    });

    var PHASE_KO = { lobby: '대기실', booking: '예매', prevote: '사전 투표', decide: '가질까 팔까',
                     budget: '예산 배정', auction: '경매', results: '결과', yosemite: '요세미티' };
    $('#phaseLine').textContent = PHASE_KO[r.phase] || r.phase;

    // 다음 버튼 하나만 크게.
    //
    // 누른 직후 잠깐은 아예 다시 그리지 않는다. 예전에는 1초마다 버튼을
    // 통째로 새로 만들었는데, 그러면 눌러서 잠가 둔 disabled 가 날아간다.
    // 교사가 휴대폰에서 예매 시작을 습관적으로 두 번 탭하면 250ms 뒤에
    // 같은 자리에 '사전 투표' 버튼이 들어와 있고, 두 번째 탭이 그걸 눌러
    // 8초 카운트다운 중에 예매창을 닫아 버린다. 좌석 0개, 되돌릴 방법 없음.
    var step = nextStep(s);
    var host = $('#steps');
    var stepId = step ? step.id : '__end__';

    if (Date.now() < busyUntil) return;          // 누른 직후 — 손대지 않는다
    if (shownStepId === stepId && host.firstChild) return;   // 같은 단계 — 그대로 둔다
    shownStepId = stepId;
    U.clear(host);

    if (step) {
      var b = el('button', 'ym-btn ym-btn--primary ym-btn--step');
      b.appendChild(el('span', 'ym-btn__main', step.label));
      b.appendChild(el('span', 'ym-btn__sub', step.sub));
      b.addEventListener('click', function () { doStep(step.id, b); });
      host.appendChild(b);
    } else {
      // 끝났다고만 하고 끝내면 막다른 길이 된다. 연습을 다시 돌리거나,
      // 실제 수업에서 뭔가 꼬였을 때 되돌릴 길을 여기에 같이 둔다.
      host.appendChild(el('p', 'ym-note', '수업이 끝났습니다. 지문으로 넘어가세요.'));
      var again = el('button', 'ym-btn ym-btn--restart');
      again.appendChild(el('span', 'ym-btn__main', '이 반 다시 시작'));
      again.appendChild(el('span', 'ym-btn__sub', '참가자·좌석·경매·투표를 모두 지웁니다'));
      again.addEventListener('click', function () { doAct('reset'); });
      host.appendChild(again);
    }

    // 상황별 안내 — 여기서 막히는 지점을 미리 말해 준다
    var hint = '';
    if (r.join_open && s.players < 5) hint = '학생들이 들어오는 중입니다. 출석부 인원과 맞으면 잠그세요.';
    else if (r.join_open) hint = s.players + '명 참가 중. 잠그면 좌석은 ' + Math.max(3, Math.round(s.players * 0.4)) + '석이 됩니다.';
    else if (r.phase === 'decide' && s.decided_sell < 3) hint = '매물이 적습니다. 아래 "되팔기 30초 더"로 한 번 더 기회를 줄 수 있습니다.';
    else if (r.phase === 'auction' && s.listings_open === 0) hint = '열린 매물이 없습니다. 결과로 넘어가세요.';
    else if (r.phase === 'booking') hint = '좌석이 다 나가면 사전 투표로 넘어가세요.';
    $('#hint').textContent = hint;

    $('#roster').textContent = (s.roster || []).map(function (p) {
      return p.nickname + (p.bot ? '(봇)' : p.house ? '(대리)' : '');
    }).join(' · ');

    var base = location.href.replace(/admin\.html.*$/, '');
    $('#urls').textContent = '학생 ' + base + '?room=' + ROOM + '   |   프로젝터 ' + base + 'screen.html?room=' + ROOM;
  }

  // -------------------------------------------------------------------
  // 단계 실행
  // -------------------------------------------------------------------
  // 모든 버튼은 누르는 즉시 잠긴다. 교실에서 버튼은 반드시 두 번 눌리고,
  // 서버가 막아 주더라도 화면이 반응하지 않으면 세 번째를 누르게 된다.
  async function doStep(id, btn) {
    btn.disabled = true;
    // 1.2초 동안은 render() 가 이 버튼을 갈아치우지 못하게 막는다.
    busyUntil = Date.now() + 1200;
    try {
      if (id === 'open')     await call('admin_open_join', { p_max: 45 });
      if (id === 'lock')     { var r = await call('admin_lock_roster', { p_seat_override: null });
                               if (r.error === 'TOO_FEW') U.toast('참가자가 너무 적습니다 (' + r.players + '명)', 'warn');
                               else U.toast('좌석 ' + r.seat_count + '석으로 확정'); }
      if (id === 'booking')  { var r2 = await call('admin_start_booking');
                               if (r2.error === 'ROSTER_NOT_LOCKED') U.toast('먼저 명단을 잠가 주세요', 'warn'); }
      if (id === 'prevote')  await call('admin_set_phase', { p_phase: 'prevote', p_seconds: 30 });
      if (id === 'decide')   await call('admin_set_phase', { p_phase: 'decide', p_seconds: 90 });
      if (id === 'budget')   await call('admin_distribute_wealth');
      if (id === 'auction')  await call('admin_start_auction', { p_seconds: 60 });
      if (id === 'results')  { await call('admin_force_settle');
                               await call('admin_compute_results');
                               await call('admin_set_phase', { p_phase: 'results', p_seconds: 45 }); }
      if (id === 'yosemite') await call('admin_set_phase', { p_phase: 'yosemite', p_seconds: 60 });
    } catch (e) {
      U.toast('실패했습니다. 다시 눌러 주세요.', 'warn');
    }
    await poll();
    setTimeout(function () {
      busyUntil = 0;
      shownStepId = null;      // 다음 render 에서 새 단계 버튼을 그린다
      if (state) render();
    }, 1200);
  }

  // -------------------------------------------------------------------
  // 보조 도구
  // -------------------------------------------------------------------
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-act]'); if (!b) return;
    doAct(b.dataset.act, b);
  });

  async function doAct(act, b) {
    if (b) b.disabled = true;
    try {
      if (act === 'spawn') {
        var n = 20;
        var res = await call('admin_spawn_bots', { p_count: n });
        if (res.ok) { YM.bots.run(ROOM, res.bots, function (m) { U.toast(m); }); U.toast('봇 ' + n + '명 합류'); }
      }
      if (act === 'house')        { var h = await call('admin_add_house_player'); U.toast('추가: ' + h.nickname); }
      if (act === 'reopenJoin')   { var j = await call('admin_reopen_join');
                                    U.toast(j.ok ? '입장을 다시 열었습니다' : '예매가 이미 시작돼 되돌릴 수 없습니다', j.ok ? '' : 'warn'); }
      if (act === 'reopenDecide')   await call('admin_reopen_decide');
      if (act === 'forceSettle')  { await call('admin_force_settle'); U.toast('경매를 마감했습니다'); }
      if (act === 'extend')       { var x = await call('admin_extend_room', { p_days: 30 }); U.toast('30일 연장'); }
      if (act === 'copy')           copyResults();
      if (act === 'reset') {
        if (confirm(ROOM + ' 의 참가자·좌석·경매·투표를 모두 지웁니다.\n다른 반은 영향받지 않습니다.\n\n계속할까요?')) {
          if (YM.bots && YM.bots.isRunning()) YM.bots.stop();
          await call('admin_reset_room');
          startedAt = null;
          U.toast('초기화했습니다. 연습하려면 봇을 다시 부르세요.');
        }
      }
      if (act === 'logout') {
        try { localStorage.removeItem(KEY_T); localStorage.removeItem(KEY_R); } catch (e) {}
        location.reload();
      }
    } catch (e) { U.toast('처리하지 못했습니다.', 'warn'); }
    await poll();
    if (b) b.disabled = false;
  }

  // 반별 비교용. 11개 반을 다 하고 나면 어느 반이 얼마까지 갔는지 보고 싶어진다.
  function copyResults() {
    var r = state && state.room && state.room.results;
    if (!r) { U.toast('아직 결과가 없습니다', 'warn'); return; }
    var txt = [
      ROOM,
      '참가 ' + r.players + '명 / 좌석 ' + r.seat_count + '석',
      '매물 ' + r.listed + ' · 팔림 ' + r.sold + ' · 유찰 ' + r.unsold,
      '평균 ' + U.won(r.avg_price) + ' · 최고 ' + U.won(r.max_price) + ' (액면의 ' + r.multiple + '배)',
      '좌석 없음 ' + r.no_seat + '명 · 살 수 없었음 ' + r.priced_out + '명',
      '투표 ' + JSON.stringify(r.votes),
    ].join('\n');
    try {
      navigator.clipboard.writeText(txt);
      U.toast('복사했습니다');
    } catch (e) { prompt('복사하세요', txt); }
  }

  // -------------------------------------------------------------------
  // 시작
  // -------------------------------------------------------------------
  var sel = $('#roomSel');
  C.ROOMS.forEach(function (rc) {
    var o = el('option', null, rc === 'YM2-TEST' ? rc + ' (연습용)' : rc.replace('YM2-', '2학년 ') + '반');
    o.value = rc; sel.appendChild(o);
  });

  try {
    var savedR = localStorage.getItem(KEY_R), savedT = localStorage.getItem(KEY_T);
    if (savedR) { sel.value = savedR; }
    if (ROOM) sel.value = ROOM;
    if (savedR && savedT) { ROOM = savedR; TOKEN = savedT; open(); }
  } catch (e) {}

  $('#authBtn').addEventListener('click', async function () {
    ROOM = sel.value;
    TOKEN = $('#tokenIn').value.trim();
    if (!TOKEN) { $('#authErr').textContent = '토큰을 붙여넣어 주세요.'; $('#authErr').hidden = false; return; }
    try {
      await call('admin_state');
      try { localStorage.setItem(KEY_T, TOKEN); localStorage.setItem(KEY_R, ROOM); } catch (e) {}
      open();
    } catch (e) {
      $('#authErr').textContent = '토큰이 맞지 않습니다. 반과 토큰이 짝이 맞는지 확인해 주세요.';
      $('#authErr').hidden = false;
    }
  });

  function open() {
    $('#authBox').hidden = true;
    $('#deck').hidden = false;
    db.syncClock().then(poll);
    if (!timer) timer = setInterval(poll, 2000);
    setInterval(function () { if (state) render(); }, 1000);
  }
})();
