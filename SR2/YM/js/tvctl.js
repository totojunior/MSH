/* YM — 교탁 TV 조종판. tv.html 에서만 읽는다.
 *
 * 왜 이 파일이 있는가:
 *   교사는 TV 한 대에 페이지 하나만 열고 마우스로 수업을 넘기고 싶다.
 *   휴대폰 조종석(admin.html)은 그대로 두되, 같은 단계 기계를 중계화면 위에
 *   얹는다. 중계 연출(js/screen.js)은 한 글자도 고치지 않는다 — 그 파일의
 *   안전성은 "토큰이 없다" 는 전제 위에 서 있고, 그 전제를 깨는 코드는
 *   전부 이 파일 안에만 있어야 나중에 읽는 사람이 속지 않는다.
 *
 * 이 파일이 지키는 선:
 *   - 관리자 토큰은 localStorage 에서만 읽고, 화면·주소·DOM 어디에도 쓰지 않는다.
 *   - 평상시 폴링은 공개 테이블(rooms_public/listings)만 읽는다. admin_state 는
 *     별명 전체를 돌려주므로 (1) 암호 확인 (2) 명단 서랍을 열 때만 부른다.
 *   - 학생이 읽으면 활동이 오염되는 숫자(팔겠다/가진다, 투표 진행)는 서랍 안에만.
 *   - confirm()/alert()/prompt() 를 쓰지 않는다. 대화상자가 막히면 버튼이
 *     죽은 것처럼 보이고, TV 에서는 6m 밖에서 읽히지도 않는다.
 */
(function () {
  'use strict';

  var U = YM.ui, C = YM.CONFIG, db = YM.db;
  var $ = U.$, el = U.el;

  var params = new URLSearchParams(location.search);
  var DEMO = params.get('demo') === '1';

  var KEY_ROOM = 'ym.tv.room';   // 이 교탁 PC 가 몰 반
  var KEY_KEYS = 'ym.tv.key';    // 반 -> 암호. 반마다 암호가 다르다(방을 만들 때 각각 생성된다).

  // -------------------------------------------------------------------
  // 데모에서는 조종판을 켜지 않는다
  // -------------------------------------------------------------------
  // demo.js 는 document 의 모든 클릭과 Space/Enter/→ 를 먹어서 스테이지를
  // 넘긴다. 그 위에 진짜 버튼을 얹으면 한 번의 클릭이 'RPC 발사 + 장면 전진'
  // 으로 두 번 울린다. 게다가 데모 방(room_code:'DEMO')은 서버에 없다.
  if (DEMO) {
    var note = el('p', 'tv-demonote', '연습 모드입니다. 조종판은 꺼져 있습니다 — 화면을 클릭하면 다음 장면.');
    document.body.appendChild(note);
    return;
  }

  // -------------------------------------------------------------------
  // 저장소
  // -------------------------------------------------------------------
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  // 암호는 반마다 다르다 — create_room 이 방마다 따로 만든 값이기 때문이다.
  // 그래서 한 칸이 아니라 반->암호 지도로 들고 있는다. 교사가 교시마다
  // 붙여넣지 않아도 되게 하려면 이 방법밖에 없다.
  // 교사 키 하나. 05-교사키.sql 을 돌려 두면 이 한 개로 11개 반이 다 열린다.
  // 아직 안 돌렸다면 지금 붙여넣은 값이 그 반의 반별 토큰으로 동작한다 —
  // 서버의 _require_admin 이 둘 다 받으므로 클라이언트는 구분할 필요가 없다.
  function keyGet() {
    var raw = lsGet(KEY_KEYS);
    if (!raw) return null;
    if (raw.charAt(0) !== '{') return raw;
    // 옛 형식(반 -> 암호 지도). 아무 값이나 하나 꺼내 쓴다.
    try {
      var m = JSON.parse(raw);
      for (var k in m) if (m[k]) return m[k];
    } catch (e) {}
    return null;
  }
  function keySet(v) { lsSet(KEY_KEYS, v); }
  function keyClear() { lsDel(KEY_KEYS); }

  // 같은 암호를 가진 다른 반이 있으면 알려 준다. 값 자체는 절대 화면에 쓰지 않는다.

  // -------------------------------------------------------------------
  // 몰 반 정하기 — 자동 탐색에 기대지 않는다
  // -------------------------------------------------------------------
  // screen.js 의 자동 탐색은 join_open=true 인 방을 찾는다. 그런데 그 스위치를
  // 켜는 것이 바로 이 화면의 첫 버튼이고, 「명단 잠그기」가 다시 꺼 버린다.
  // 즉 수업이 시작된 뒤에는 자동 탐색이 이 반을 영영 못 찾는다 — 수업 도중
  // 버전 자동 새로고침이 한 번만 걸려도 경매 중인 TV 가 "수업을 기다리는 중"
  // 배너로 덮인다. 그래서 반이 정해지는 즉시 주소에 ?room= 을 박아 둔다.
  var urlRoom = (params.get('room') || '').trim().toUpperCase();
  var savedRoom = (lsGet(KEY_ROOM) || '').trim().toUpperCase();
  var ROOM = '';
  var mismatch = null;

  if (urlRoom && savedRoom && urlRoom !== savedRoom) {
    mismatch = { url: urlRoom, saved: savedRoom };
    ROOM = urlRoom;
  } else if (urlRoom) {
    ROOM = urlRoom;
  } else if (savedRoom) {
    ROOM = savedRoom;
    // screen.js 가 이 줄 다음에 location.search 를 읽는다. 새로고침 없이 넘긴다.
    try { history.replaceState(null, '', location.pathname + '?room=' + ROOM); } catch (e) {}
  }

  // -------------------------------------------------------------------
  // 단계 정의 — admin.js 의 STEPS 를 그대로 옮긴다
  // -------------------------------------------------------------------
  // 판단에 쓰는 필드가 전부 rooms_public 의 공개 칼럼이라, 조종판은 상태를
  // 읽기 위해 관리자 RPC 를 부를 필요가 없다. 토큰은 '쓰기' 에만 쓴다.
  //
  // sub 는 TV 용 중립 문구다. 원문(note)은 서랍 안에 둔다 —
  // "전원에게 불평등하게" 를 학생이 6m 밖에서 미리 읽으면 예산 배정의
  // 충격이 반감된다. 연출을 미리 새게 하지 않는다.
  var STEPS = [
    { id: 'open',    label: '입장 열기',        sub: '학생들이 들어옵니다',        note: '학생들이 들어옵니다', target: 120,
      when: function (r) { return !r.join_open && !r.roster_frozen_at; } },
    { id: 'lock',    label: '명단 잠그기',      sub: '좌석 수가 여기서 정해집니다', note: '좌석 수가 여기서 정해집니다', target: 10,
      when: function (r) { return r.join_open; } },
    { id: 'booking', label: '예매 시작',        sub: '8초 뒤 열립니다',           note: '8초 뒤 열립니다', target: 40,
      when: function (r) { return r.roster_frozen_at && !r.booking_opens_at; } },
    { id: 'prevote', label: '사전 투표 (30초)', sub: '30초 투표를 엽니다',        note: '돈 이야기가 나오기 전에', target: 45,
      // 예매가 아직 도는 동안에는 내놓지 않는다. 이 버튼을 누르면 서버가
      // booking_ends_at 을 지금으로 당겨 예매창을 즉시 닫는데, 되돌릴 길이
      // 「이 반 초기화」밖에 없다 — 33명 전원 재입장이다.
      when: function (r) { return r.booking_opens_at && r.phase === 'booking' && db.msUntil(r.booking_ends_at) === 0; } },
    { id: 'decide',  label: '가질까 팔까 (90초)', sub: '좌석 주인들이 정합니다',  note: '좌석 주인들이 정합니다', target: 100,
      when: function (r) { return r.phase === 'prevote'; } },
    { id: 'budget',  label: '예산 배정',        sub: '예산을 나눕니다',           note: '전원에게 불평등하게', target: 45,
      when: function (r) { return r.phase === 'decide' && !r.wealth_distributed_at; } },
    // 예산을 이미 나눠 준 뒤에 「되팔기 30초 더」로 decide 로 돌아온 경우.
    // 이 줄이 없으면 매치되는 단계가 하나도 없어져서, 수업 한가운데에
    // 화면에 남는 유일한 큰 버튼이 「이 반 초기화」가 된다.
    { id: 'auction', label: '경매 시작 (60초)', sub: '60초 경매를 엽니다',        note: '여기가 절정입니다', target: 90,
      when: function (r) { return r.phase === 'decide' && r.wealth_distributed_at; } },
    { id: 'auction', label: '경매 시작 (60초)', sub: '60초 경매를 엽니다',        note: '여기가 절정입니다', target: 90,
      when: function (r) { return r.phase === 'budget'; } },
    { id: 'results', label: '결과 보기',        sub: '투표 먼저, 통계는 그다음',   note: '투표 먼저, 통계는 그다음', target: 240,
      when: function (r) { return r.phase === 'auction'; } },
    { id: 'yosemite',label: '요세미티로',       sub: '마지막 3문항 투표까지',      note: '마지막 3문항 투표까지', target: 150,
      when: function (r) { return r.phase === 'results'; } },
  ];

  function nextStep(r) {
    for (var i = 0; i < STEPS.length; i++) if (STEPS[i].when(r)) return STEPS[i];
    return null;
  }

  var PHASE_KO = {
    lobby: '대기실', booking: '예매', prevote: '사전 투표', decide: '가질까 팔까',
    budget: '예산 배정', auction: '경매', results: '결과', yosemite: '요세미티',
  };
  function phaseKo(p) { return PHASE_KO[p] || p || '—'; }

  // 서버가 {ok:false, error:'...'} 로 돌려주는 값들. 예외가 아니라 정상 응답이라
  // try/catch 로는 안 잡힌다 — 말해 주지 않으면 성공한 것처럼 지나간다.
  var ERR_KO = {
    TOO_FEW: '참가자가 너무 적습니다. 조금 더 기다렸다 눌러 주세요.',
    ROSTER_NOT_LOCKED: '먼저 「명단 잠그기」를 눌러 주세요.',
    BOOKING_ALREADY_RAN: '예매가 이미 시작돼 입장을 되돌릴 수 없습니다.',
    NO_PLAYERS: '참가자가 없습니다. 「입장 열기」부터 다시 해 주세요.',
    ROOM_FULL: '이 방은 정원이 찼습니다.',
    BAD_COUNT: '숫자를 다시 확인해 주세요.',
    BAD_PHASE: '이 단계로는 바꿀 수 없습니다.',
  };

  // -------------------------------------------------------------------
  // 상태
  // -------------------------------------------------------------------
  var TOKEN = null;
  var controlOn = false;
  var room = null;
  var startedAt = null;        // 경과 시계의 기준 — 명단을 잠근 순간
  var sellCount = 0;           // decide/budget 에서만 채운다 (교사 전용)
  var openCount = 0, nextClose = null;   // auction 에서만
  var conn = 'wait';           // wait | live | off | noroom
  var busyUntil = 0;           // 이 시각까지는 큰 버튼을 다시 그리지 않는다
  var shownStepId = null;      // 지금 화면에 있는 버튼이 어느 단계인지
  var armCount = 0;            // 2단계 확인 대기 중인 버튼 수
  var msgUntil = 0;
  var pollTimer = null, tickTimer = null;
  var lastMove = Date.now();
  var barOpen = false, barHover = false, drawerOpen = false, coverOn = false;

  var html = document.documentElement;
  var bar = $('#tvBar'), handle = $('#tvHandle');
  var stepHost = $('#tvStep'), drawer = $('#tvDrawer');

  // 학생에게 주는 주소. 반 코드가 붙지 않는 짧은 주소 하나면 된다 —
  // 학생 화면도 '지금 입장이 열린 방' 을 스스로 찾아간다.
  var JOIN_URL = location.origin + location.pathname.replace(/[^/]*$/, '');

  function call(fn, extra) {
    var a = Object.assign({ p_room_code: ROOM, p_admin_token: TOKEN }, extra || {});
    return db.rpc(fn, a);
  }

  // db.rpc() 는 PostgREST 오류만 throw 한다. RPC 가 {ok:false} 를 '정상 응답'
  // 으로 돌려주는 경우는 예외가 아니다 — 그래서 눈으로 한 번 더 본다.
  // 이걸 빼면 NO_PLAYERS, ROOM_FULL, listings:0 이 전부 '성공' 처럼 지나간다.
  function bad(res) {
    if (!res || res.ok !== false) return null;
    return ERR_KO[res.error] || '되지 않았습니다. 다시 눌러 주세요.';
  }
  function errText(e) {
    if (e && (String(e.code) === '42501' || /unauthorized|permission/i.test(String(e.message || '')))) {
      return '암호가 맞지 않습니다. 「반 바꾸기」로 다시 입력해 주세요.';
    }
    return '실패했습니다. 다시 눌러 주세요.';
  }

  // -------------------------------------------------------------------
  // 말하기 — 토스트를 쓰지 않는다
  // -------------------------------------------------------------------
  // U.toast 는 화면 아래 한가운데에 뜬다. TV 에서는 학생 33명이 읽는 자리다.
  // 실패 문구는 조종 바 안에서만 말한다.
  function say(msg, kind) {
    var n = $('#tvMsg');
    n.textContent = msg;
    n.className = 'tv-msg' + (kind === 'ok' ? ' is-ok' : ' is-warn');
    n.hidden = false;
    msgUntil = Date.now() + 8000;
    openBar();
  }
  function sayDrop() {
    var n = $('#tvMsg');
    if (!n.hidden && Date.now() > msgUntil) { n.hidden = true; n.textContent = ''; }
  }

  // -------------------------------------------------------------------
  // 바 보이기 / 숨기기
  // -------------------------------------------------------------------
  function openBar() {
    if (!controlOn) return;
    barOpen = true;
    html.classList.add('tv-baropen');
    bar.classList.add('is-open');
    handle.hidden = true;
    html.classList.remove('tv-nocursor');
  }
  function closeBar() {
    barOpen = false;
    html.classList.remove('tv-baropen');
    bar.classList.remove('is-open');
    handle.hidden = !controlOn;
  }
  // 바가 내려가면 안 되는 순간들. 하나라도 걸리면 계속 떠 있는다.
  var tipWasHidden = true;

  function mustStay() {
    // #tvTip 도 바 안에 있다. 이걸 빼먹으면 "방 기한이 지났습니다" 같은,
    // 교사만 고칠 수 있는 경고가 3초 뒤 같이 내려가 버린다.
    return coverOn || drawerOpen || barHover || armCount > 0 ||
           Date.now() < busyUntil || !$('#tvMsg').hidden || !$('#tvTip').hidden ||
           conn === 'off' || conn === 'noroom';
  }
  function wake() {
    lastMove = Date.now();
    html.classList.remove('tv-nocursor');
    if (controlOn && !barOpen) openBar();
  }

  document.addEventListener('mousemove', wake, { passive: true });
  document.addEventListener('pointerdown', wake, { passive: true });
  bar.addEventListener('mouseenter', function () { barHover = true; });
  bar.addEventListener('mouseleave', function () { barHover = false; lastMove = Date.now(); });
  handle.addEventListener('click', function () { wake(); openBar(); });

  // -------------------------------------------------------------------
  // 그리기 (1) — 계속 갱신되는 것들
  // -------------------------------------------------------------------
  // 큰 버튼과 분리해 둔다. 조종석에서는 busyUntil 이 render() 전체를 1.2초
  // 멈췄는데, 6m 짜리 화면에서 그러면 전체가 얼어붙은 것처럼 보인다.
  function paintLive() {
    var connText = conn === 'live' ? '연결됨'
                 : conn === 'noroom' ? '방 없음'
                 : conn === 'off' ? '끊김' : '연결 확인 중';
    var c = $('#tvConn');
    c.textContent = connText;
    c.className = 'tv-conn' + (conn === 'live' ? ' is-live' : conn === 'wait' ? '' : ' is-off');

    // 경과 시계. 22분이 목표, 25분이 한계. 색만으로 말하지 않는다.
    var k = $('#tvClock');
    if (startedAt) {
      var ms = Date.now() - startedAt;
      var mins = Math.floor(ms / 60000), secs = Math.floor((ms % 60000) / 1000);
      k.textContent = String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0') +
        (mins >= 25 ? ' 초과' : mins >= 22 ? ' 주의' : '');
      k.className = 'tv-clock' + (mins >= 25 ? ' is-over' : mins >= 22 ? ' is-warn' : '');
    } else {
      k.textContent = '--:--';
      k.className = 'tv-clock';
    }

    if (!room) { paintJoin(); return; }

    $('#tvPhase').textContent = phaseKo(room.phase);

    var meta = [ROOM];
    meta.push('참가 ' + (room.player_count || 0) + '명');
    if (room.seat_count) meta.push('좌석 ' + room.seat_count + '석');
    var left = phaseLeft();
    if (left !== null && left > 0) meta.push('남은 ' + U.secs(left) + '초');
    $('#tvMeta').textContent = meta.join(' · ');

    // 연습방 경고 — 가장 크게. 학생이 먼저 알아채도 좋다.
    var dry = !!room.dry_run || ROOM === 'YM2-TEST';
    var d = $('#tvDry');
    d.hidden = !dry;
    if (dry) d.textContent = ROOM + ' · 연습방입니다 — 실제 수업 기록이 아닙니다';

    // 닫힌 서랍 밖으로도 내보내는 유일한 힌트. 숫자는 말하지 않는다 —
    // "매물이 2개" 를 학생이 읽으면 그때부터 눈치 게임이 된다.
    // decide 가 한창일 때 띄우면 아직 아무도 안 정한 것을 '부족' 이라고
    // 말하는 셈이라, 마감 40초 전부터만 띄운다. 그때 눌러야 의미가 있다.
    var tip = $('#tvTip');
    var dLeft = db.msUntil(room.decide_ends_at);
    // 방 기한이 지나면 학생만 막힌다. 방 행은 그대로 있어서 조종판도 중계도
    // 멀쩡히 돌아가고, 교실에서는 33명이 "방을 찾을 수 없습니다" 만 보며
    // 서 있는다 — 원인을 짐작할 방법이 없는 유일한 고장이라 먼저 말한다.
    if (!db.msUntil(room.expires_at)) {
      tip.textContent = '이 방의 기한이 지났습니다 — 학생은 들어올 수 없습니다. 「복구」의 「방 기한 30일 연장」을 눌러 주세요.';
      tip.hidden = false;
    } else if (sellCount < 3 &&
        (room.phase === 'budget' || (room.phase === 'decide' && dLeft !== null && dLeft < 40000))) {
      tip.textContent = '되팔 좌석이 적습니다 — 「복구」 안에 「되팔기 30초 더」가 있습니다.';
      tip.hidden = false;
    } else if (room.phase === 'auction' && openCount === 0 && room.auction_started_at) {
      tip.textContent = '열린 매물이 없습니다 — 「결과 보기」로 넘어가세요.';
      tip.hidden = false;
    } else {
      tip.hidden = true;
    }

    // 경고가 '없던 상태에서 생긴' 순간에만 바를 올린다. 매 틱 올리면
    // 교사가 일부러 내린 바가 계속 되살아나 연출을 가린다.
    if (!tip.hidden && tipWasHidden) openBar();
    tipWasHidden = tip.hidden;

    // 「되팔기 30초 더」는 단계를 가리지 않는 UPDATE 다. lobby 나 결과
    // 화면에서 잘못 누르면 학생 33명이 갑자기 '가질까 팔까' 로 튄다.
    var rd = document.querySelector('[data-tv="reopenDecide"]');
    if (rd) rd.disabled = !(room.phase === 'decide' || room.phase === 'budget');

    if (drawerOpen) paintDrawer();
    paintJoin();
  }

  // 지금 단계의 남은 시간(ms). 없으면 null.
  function phaseLeft() {
    if (!room) return null;
    var p = room.phase;
    if (p === 'booking') {
      var pre = db.msUntil(room.booking_opens_at);
      if (pre !== null && pre > 0) return pre;
      return db.msUntil(room.booking_ends_at);
    }
    if (p === 'prevote')  return db.msUntil(room.prevote_ends_at);
    if (p === 'decide')   return db.msUntil(room.decide_ends_at);
    if (p === 'auction')  return nextClose ? db.msUntil(nextClose) : db.msUntil(room.auction_ends_at);
    if (p === 'results')  return db.msUntil(room.postvote_ends_at);
    if (p === 'yosemite') return db.msUntil(room.finalvote_ends_at);
    return null;
  }

  // 학생용 QR·주소. screen.js 가 그리는 것은 tv.html 에서 주소가 어긋나므로
  // (파일 이름 'screen.html' 을 전제한 계산이다) 숨기고 여기서 다시 그린다.
  function paintJoin() {
    var box = $('#tvQr');
    if (!box || box.dataset.url === JOIN_URL) return;      // 주소는 바뀌지 않는다 — 한 번만 그린다
    var t = $('#tvJoinUrl');
    if (t) t.textContent = JOIN_URL.replace(/^https?:\/\//, '');
    if (!window.qrcode) return;
    try {
      var q = window.qrcode(0, 'M');
      q.addData(JOIN_URL);
      q.make();
      box.innerHTML = '';                                  // 라이브러리 생성 SVG (사용자 입력 아님)
      box.insertAdjacentHTML('afterbegin', q.createSvgTag({ cellSize: 6, margin: 2, scalable: true }));
      box.dataset.url = JOIN_URL;
    } catch (e) { /* QR 이 없어도 주소는 읽힌다 */ }
  }

  // -------------------------------------------------------------------
  // 그리기 (2) — 큰 버튼 하나
  // -------------------------------------------------------------------
  // 누른 직후 잠깐은 아예 다시 그리지 않는다. 예전 조종석은 1초마다 버튼을
  // 통째로 새로 만들었고, 그때마다 눌러서 잠가 둔 disabled 가 날아갔다.
  // 교사가 「예매 시작」을 습관적으로 두 번 누르면 250ms 뒤 같은 자리에
  // 「사전 투표」 버튼이 들어와 있고, 두 번째 클릭이 그걸 눌러 8초 카운트다운
  // 중에 예매창을 닫아 버린다. 좌석 0개, 되돌릴 방법 없음 — 그 반은 끝난다.
  // 서버 단발 가드가 지켜 주는 것은 lock/booking/budget 셋뿐이고
  // prevote·decide·results·yosemite 는 조건 없는 UPDATE 다. 저 네 단계에서는
  // 아래 두 줄이 유일한 방어선이다. TV 는 마우스 더블클릭이 더 쉽다.
  function paintStep() {
    if (!controlOn || !room) return;
    var step = TOKEN ? nextStep(room) : null;
    // 예매가 도는 28초. 누를 것이 '없는' 게 정답인 유일한 구간이라,
    // "고를 수 없습니다" 같은 경고 대신 기다리는 중임을 그대로 말한다.
    var waiting = !step && TOKEN && room.phase === 'booking' &&
                  room.booking_opens_at && db.msUntil(room.booking_ends_at) > 0;
    var id = !TOKEN ? '__nokey__'
           : step ? step.id
           : waiting ? '__booking__'
           : (room.phase === 'yosemite' ? '__end__' : '__odd__');

    if (Date.now() < busyUntil) return;                     // 누른 직후 — 손대지 않는다
    if (shownStepId === id && stepHost.firstChild) return;   // 같은 단계 — 그대로 둔다
    shownStepId = id;
    U.clear(stepHost);

    if (step) {
      var b = el('button', 'tv-step');
      b.type = 'button';
      // 갓 그려진 버튼은 잠깐 눌리지 않는다.
      //
      // 교사는 누른 뒤 "안 먹었나?" 하고 1~3초 안에 한 번 더 누른다. 그 사이에
      // 폴링이 다음 단계 버튼을 **같은 자리에 같은 모양으로** 깔아 놓으면,
      // 두 번째 클릭이 다음 단계를 발사한다. 예매 시작 직후라면 그 클릭이
      // 예매창을 즉시 닫고, 되돌릴 길은 「이 반 초기화」뿐이다 — 33명 재입장.
      // 버튼이 바뀌는 '모든' 경로를 막으려면 잠금을 버튼 자신에게 건다.
      b.dataset.settle = String(Date.now() + 900);
      b.disabled = true;
      b.appendChild(el('span', 'tv-step__main', step.label));
      b.appendChild(el('span', 'tv-step__sub', step.sub));
      b.addEventListener('click', function () { doStep(step, b); });
      stepHost.appendChild(b);
      return;
    }

    if (id === '__booking__') {
      var w = el('button', 'tv-step');
      w.type = 'button';
      w.disabled = true;
      w.appendChild(el('span', 'tv-step__main', '예매 진행 중'));
      var sub = el('span', 'tv-step__sub', '');
      sub.id = 'tvBookLeft';
      w.appendChild(sub);
      stepHost.appendChild(w);
      return;
    }

    if (id === '__nokey__') {
      stepHost.appendChild(el('p', 'tv-end tv-end--odd',
        '중계만 하고 있습니다. 아래 칸에 교사 암호를 넣으면 조종할 수 있습니다.'));
      return;
    }

    if (id === '__end__') {
      // 끝 화면에 「이 반 초기화」를 큰 버튼으로 두지 않는다.
      // 33명이 보는 화면에서 유일하게 큰 버튼이 '전부 삭제' 인 상황은 만들지 않는다.
      stepHost.appendChild(el('p', 'tv-end', '수업이 끝났습니다. 지문으로 넘어가세요.'));
      return;
    }

    // nextStep() 이 null 이라고 해서 끝난 것이 아니다. 예상 못 한 상태일 뿐이다.
    stepHost.appendChild(el('p', 'tv-end tv-end--odd',
      '다음 단계를 고를 수 없습니다 (' + phaseKo(room.phase) + '). 「복구」를 열어 주세요.'));
  }

  function pressStep() {
    var b = stepHost.querySelector('button.tv-step');
    if (!b || b.disabled) return;
    b.click();
  }

  // -------------------------------------------------------------------
  // 단계 실행
  // -------------------------------------------------------------------
  async function doStep(step, btn) {
    btn.disabled = true;
    // 틱이 400ms 뒤에 이 버튼을 되살리지 못하도록 시각을 버튼에 박는다.
    btn.dataset.settle = String(Date.now() + 1500);
    busyUntil = Date.now() + 1200;     // 왕복 250ms 짜리 폴링이 버튼을 손가락 밑에서 갈아치우는 창을 덮는다
    openBar();
    var msg = null, kind = 'warn', r;
    try {
      if (step.id === 'open') {
        r = await call('admin_open_join', { p_max: 45 });
        msg = bad(r);
      } else if (step.id === 'lock') {
        r = await call('admin_lock_roster', { p_seat_override: null });
        if (r && r.error === 'TOO_FEW') msg = '참가자가 ' + r.players + '명뿐입니다. 조금 더 기다렸다 잠가 주세요.';
        else if (r && r.ok && r.seat_count) { msg = '좌석 ' + r.seat_count + '석으로 확정했습니다.'; kind = 'ok'; }
        else msg = bad(r);
      } else if (step.id === 'booking') {
        r = await call('admin_start_booking');
        msg = bad(r);
      } else if (step.id === 'prevote') {
        r = await call('admin_set_phase', { p_phase: 'prevote', p_seconds: 30 });
        msg = bad(r);
      } else if (step.id === 'decide') {
        r = await call('admin_set_phase', { p_phase: 'decide', p_seconds: 90 });
        msg = bad(r);
      } else if (step.id === 'budget') {
        r = await call('admin_distribute_wealth');
        msg = bad(r);
      } else if (step.id === 'auction') {
        r = await call('admin_start_auction', { p_seconds: 60 });
        msg = bad(r);
        // 서버는 이것을 '성공' 으로 돌려준다. 말해 주지 않으면 교사는 빈 경매를
        // 60초 동안 바라보다 결과가 빈 표인 것을 그때 알게 된다.
        if (!msg && r && !r.listings) msg = '경매에 올라간 좌석이 0개입니다. 「되팔기 30초 더」를 먼저 써 보세요.';
      } else if (step.id === 'results') {
        // 세 번 연속으로 나간다. 중간에 끊겨도 phase 는 auction 에 남고
        // 버튼이 다시 「결과 보기」로 돌아온다 — 다시 누르면 된다.
        // 정산 경로가 하나뿐이라 두 번 정산은 구조적으로 불가능하다.
        msg = bad(await call('admin_force_settle'));
        var cr = await call('admin_compute_results');
        if (!msg) msg = bad(cr);
        if (cr && cr.results) shareBuyers(cr.results);
        if (!msg) msg = bad(await call('admin_set_phase', { p_phase: 'results', p_seconds: 45 }));
      } else if (step.id === 'yosemite') {
        // 95초 = 프로젝터 연출 34초 + 투표 60초.
        r = await call('admin_set_phase', { p_phase: 'yosemite', p_seconds: 95 });
        msg = bad(r);
      }
    } catch (e) {
      msg = errText(e);
    }
    if (msg) say(msg, kind);
    await tvPull();
    // 잠금 창을 '누른 시각' 이 아니라 '응답이 온 시각' 기준으로 다시 건다.
    // 왕복이 1.2초를 넘으면 그 사이에 폴링이 다음 단계 버튼을 같은 자리에
    // 활성 상태로 깔아 버린다. 교사가 "안 먹었나?" 하고 한 번 더 누르는
    // 시각이 정확히 거기다 — 예매 시작 직후면 그 클릭이 예매창을 닫는다.
    busyUntil = Date.now() + 1200;
    // 해제도 명시적으로. shownStepId=null 이 다음 그리기에서 새 버튼을 딱 한 번 만든다.
    setTimeout(function () {
      busyUntil = 0;
      shownStepId = null;
      paintStep();
    }, 1200);
  }

  // -------------------------------------------------------------------
  // 서랍 — 교사 전용
  // -------------------------------------------------------------------
  function paintDrawer() {
    if (!room) return;

    var h = '';
    if (room.join_open && (room.player_count || 0) < 5) h = '학생들이 들어오는 중입니다. 출석부 인원과 맞으면 잠그세요.';
    else if (room.join_open) h = (room.player_count || 0) + '명 참가 중. 잠그면 좌석은 ' +
      Math.max(3, Math.round((room.player_count || 0) * 0.4)) + '석이 됩니다.';
    else if (room.phase === 'decide' && sellCount < 3) h = '팔겠다고 한 좌석이 ' + sellCount + '개입니다. 「되팔기 30초 더」로 한 번 더 기회를 줄 수 있습니다.';
    else if (room.phase === 'auction' && openCount === 0) h = '열린 매물이 없습니다. 결과로 넘어가세요.';
    else if (room.phase === 'booking') h = '좌석이 다 나가면 사전 투표로 넘어가세요.';
    $('#tvHint').textContent = h;

    // 학생이 읽으면 활동이 오염되는 숫자들. 서랍 안에만 둔다.
    var box = $('#tvNums');
    U.clear(box);
    function num(k, v) {
      var n = el('span', 'tv-num');
      n.appendChild(el('span', 'tv-num__v', v));
      n.appendChild(el('span', 'tv-num__k', k));
      box.appendChild(n);
    }
    if (room.phase === 'decide' || room.phase === 'budget') {
      num('팔겠다', sellCount);
      num('가진다', Math.max(0, (room.seat_count || 0) - sellCount));
    }
    if (room.phase === 'auction') {
      num('열린 매물', openCount);
      num('다음 마감', nextClose ? U.secs(db.msUntil(nextClose)) + '초' : '—');
    }
    var vc = room.vote_counts || {};
    ['pre', 'post'].forEach(function (q) {
      if (!vc[q]) return;
      var n = (vc[q].yes || 0) + (vc[q].no || 0) + (vc[q].unsure || 0);
      num(q === 'pre' ? '사전투표' : '사후투표', n + '/' + (room.player_count || 0));
    });

    var step = nextStep(room);
    var foot = ['이 반: ' + ROOM + ' · 단계: ' + phaseKo(room.phase)];
    if (step) foot.push('다음 단계 메모: ' + step.note);
    if (room.phase === 'lobby') foot.push('학생 링크: ' + JOIN_URL.replace(/^https?:\/\//, ''));
    $('#tvNote').textContent = foot.join('   |   ');

    var dry = !!room.dry_run || ROOM === 'YM2-TEST';
    $('[data-tv="spawn"]').hidden = !dry;                       // 실수업 화면에 봇 버튼을 두지 않는다
    $('[data-tv="copy"]').hidden = room.phase !== 'yosemite';   // 다른 반 숫자는 수업 중에 띄우지 않는다
  }

  function toggleDrawer(on) {
    drawerOpen = on === undefined ? !drawerOpen : !!on;
    drawer.hidden = !drawerOpen;
    $('#tvDrawerBtn').textContent = drawerOpen ? '복구 ▼' : '복구 ▲';
    if (drawerOpen) { paintDrawer(); openBar(); }
    else { $('#tvRoster').hidden = true; U.clear($('#tvRoster')); }   // 별명을 화면에 남겨 두지 않는다
  }
  $('#tvDrawerBtn').addEventListener('click', function () { wake(); toggleDrawer(); });

  // -------------------------------------------------------------------
  // 한 번 더 눌러야 실행되는 버튼
  // -------------------------------------------------------------------
  // confirm() 을 쓰지 않는다. 브라우저가 대화상자를 막으면 버튼이 아무 반응
  // 없이 죽은 것처럼 보이고, TV 에서는 시스템 대화상자가 6m 밖에서 읽히지도 않는다.
  function disarm(b) {
    if (b.dataset.armedNow !== '1') return;
    b.dataset.armedNow = '';
    b.classList.remove('is-armed');
    b.textContent = b.dataset.label || b.textContent;
    armCount = Math.max(0, armCount - 1);
  }
  function armOk(b) {
    if (!b.dataset.arm) return true;
    if (b.dataset.armedNow === '1') {
      // OS 더블클릭(≈200ms)의 두 번째 클릭이 그대로 '실행' 이 되면
      // 2단계 확인이 아무것도 막지 못한다. 사람이 글자를 읽을 시간을 준다.
      if (Date.now() - (+b.dataset.armedAt || 0) < 700) return false;
      disarm(b); return true;
    }
    b.dataset.armedAt = String(Date.now());
    b.dataset.armedNow = '1';
    b.dataset.label = b.textContent;
    b.textContent = b.dataset.arm;
    b.classList.add('is-armed');
    armCount++;
    setTimeout(function () { disarm(b); }, 5000);
    return false;
  }

  document.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-tv]');
    if (!b) return;
    wake();
    if (!armOk(b)) return;
    doAct(b.dataset.tv, b);
  });

  async function doAct(act, b) {
    if (b) b.disabled = true;
    try {
      if (act === 'reopenJoin') {
        var j = await call('admin_reopen_join');
        say(j && j.ok ? '입장을 다시 열었습니다.' : (ERR_KO[j && j.error] || '되돌릴 수 없습니다.'),
            j && j.ok ? 'ok' : 'warn');
      } else if (act === 'reopenDecide') {
        var d = await call('admin_reopen_decide');
        say(bad(d) || '되팔기를 30초 더 열었습니다.', bad(d) ? 'warn' : 'ok');
      } else if (act === 'forceSettle') {
        var f = await call('admin_force_settle');
        say(bad(f) || '경매를 마감했습니다.', bad(f) ? 'warn' : 'ok');
      } else if (act === 'extend') {
        var x = await call('admin_extend_room', { p_days: 30 });
        say(bad(x) || '방 기한을 30일 연장했습니다.', bad(x) ? 'warn' : 'ok');
      } else if (act === 'house') {
        // 돌려주는 player_token 은 절대 화면에 쓰지 않는다 — 학생이 받아치면
        // 남의 신분으로 접속한다. 별명만 말한다.
        var hp = await call('admin_add_house_player');
        say(bad(hp) || ('추가했습니다: ' + hp.nickname), bad(hp) ? 'warn' : 'ok');
      } else if (act === 'roster') {
        await loadRoster();
      } else if (act.indexOf('kick:') === 0) {
        var kk = await call('admin_kick_player', { p_player: act.slice(5) });
        say(bad(kk) || '내보냈습니다.', bad(kk) ? 'warn' : 'ok');
        await loadRoster(true);
      } else if (act === 'spawn') {
        var s = await call('admin_spawn_bots', { p_count: 20 });
        var sb2 = bad(s);
        if (sb2) say(sb2, 'warn');
        else if (YM.bots && YM.bots.run) { YM.bots.run(ROOM, s.bots, function () {}); say('연습용 봇 20명이 들어왔습니다.', 'ok'); }
        else say('봇을 움직일 수 없습니다 (js/bots.js 없음).', 'warn');
      } else if (act === 'copy') {
        copyResults();
      } else if (act === 'reset') {
        if (YM.bots && YM.bots.isRunning && YM.bots.isRunning()) YM.bots.stop();
        var rr = await call('admin_reset_room');
        startedAt = null;
        say(bad(rr) || (ROOM + ' 를 초기화했습니다 — 「입장 열기」를 다시 누르세요.'), bad(rr) ? 'warn' : 'ok');
      } else if (act === 'swap') {
        // 암호는 지우지 않는다. 지우면 교시마다 붙여넣기가 부활한다.
        // 아직 아무도 안 쓴 방을 스스로 집어 그리로 다시 연다 —
        // 교사는 반 번호를 볼 일이 없다.
        var nx = await nextCleanRoom();
        if (nx) {
          lsSet(KEY_ROOM, nx);
          location.replace(location.pathname + '?room=' + nx);
        } else {
          lsDel(KEY_ROOM);
          location.replace(location.pathname);
        }
        return;
      } else if (act === 'pickManual') {
        // 자동으로 집은 방이 마음에 안 들 때의 탈출구.
        lsDel(KEY_ROOM);
        showSetup('full');
        return;
      } else if (act === 'forget') {
        // 이 교탁 PC 를 떠나기 전에. 암호는 평문으로 이 기기에 남아 있다.
        keyClear();
        lsDel(KEY_ROOM);
        location.replace(location.pathname);
        return;
      }
    } catch (e) {
      say(errText(e), 'warn');
    }
    await tvPull();
    if (b) b.disabled = false;
  }

  // 명단은 필요할 때만 불러온다. 평상시 폴링이 별명을 들고 있지 않아야
  // 렌더 한 줄 실수로 TV 에 별명이 뜨는 길이 아예 없어진다.
  async function loadRoster(force) {
    var host = $('#tvRoster');
    if (!force && !host.hidden) { host.hidden = true; U.clear(host); return; }
    try {
      var st = await call('admin_state');
      U.clear(host);
      host.appendChild(el('p', 'tv-roster__h',
        '부적절한 별명이나 한 사람의 두 기기만 내보내세요. 한 번 누르면 확인, 한 번 더 누르면 실행됩니다.'));
      var wrap = el('div', 'tv-roster__chips');
      (st.roster || []).forEach(function (p) {
        var chip = el('button', 'tv-kick');
        chip.type = 'button';
        var face = p.nickname + (p.bot ? ' (봇)' : p.house ? ' (대리)' : '');
        chip.appendChild(el('span', null, face));
        chip.appendChild(el('span', 'tv-kick__x', '×'));
        chip.addEventListener('click', function () {
          if (chip.dataset.armedNow !== '1') {
            chip.dataset.armedNow = '1';
            chip.classList.add('is-armed');
            chip.firstChild.textContent = face + ' 내보낼까요?';
            armCount++;
            setTimeout(function () {
              if (chip.dataset.armedNow !== '1') return;
              chip.dataset.armedNow = '';
              chip.classList.remove('is-armed');
              chip.firstChild.textContent = face;
              armCount = Math.max(0, armCount - 1);
            }, 4000);
            return;
          }
          chip.dataset.armedNow = '';
          armCount = Math.max(0, armCount - 1);
          doAct('kick:' + p.id, chip);
        });
        wrap.appendChild(chip);
      });
      if (!(st.roster || []).length) wrap.appendChild(el('p', 'tv-roster__h', '아직 아무도 들어오지 않았습니다.'));
      host.appendChild(wrap);
      host.hidden = false;
    } catch (e) {
      say(errText(e), 'warn');
    }
  }

  function copyResults() {
    var r = room && room.results;
    if (!r) { say('아직 결과가 없습니다.', 'warn'); return; }
    var txt = [
      ROOM,
      '참가 ' + r.players + '명 / 좌석 ' + r.seat_count + '석',
      '매물 ' + r.listed + ' · 팔림 ' + r.sold + ' · 유찰 ' + r.unsold,
      '평균 ' + U.won(r.avg_price) + ' · 최고 ' + U.won(r.max_price) + ' (액면의 ' + r.multiple + '배)',
      '좌석 없음 ' + r.no_seat + '명 · 살 수 없었음 ' + r.priced_out + '명',
    ].join('\n');
    try {
      // 실패해도 prompt() 로 떨어지지 않는다 — 학생 앞에 대화상자가 뜬다.
      navigator.clipboard.writeText(txt).then(
        function () { say('복사했습니다.', 'ok'); },
        function () { say('복사하지 못했습니다. 수업이 끝난 뒤 조종석(휴대폰)에서 복사하세요.', 'warn'); });
    } catch (e) {
      say('복사하지 못했습니다. 수업이 끝난 뒤 조종석(휴대폰)에서 복사하세요.', 'warn');
    }
  }

  // 반 바꾸기 — 다음 교시. 2단계 확인은 유지한다.
  $('#tvSwap').dataset.tv = 'swap';
  $('#tvSwap').dataset.arm = '한 번 더 — 다음 수업 시작';

  // 초기화는 반 이름을 넣어 되묻는다. "이 반" 이 어느 반인지 손이 먼저
  // 움직이는 순간에는 안 보인다 — 글자에 반 코드가 있어야 손이 멈춘다.
  // (마크업에 못 박아 두면 반마다 다른 이름을 쓸 수 없어 여기서 붙인다.
  //  data-arm 이 없는 버튼은 armOk() 가 그냥 통과시키므로 빠뜨리면 1클릭 삭제가 된다.)
  $('[data-tv="reset"]').dataset.arm = (ROOM || '이 반') + ' 를 정말 지웁니다 — 한 번 더';

  // -------------------------------------------------------------------
  // 통신
  // -------------------------------------------------------------------
  function applyRoom(r) {
    room = r;
    // 초기화하면 roster_frozen_at 이 null 로 돌아간다 — 시계도 같이 0 으로.
    startedAt = (r && r.roster_frozen_at) ? new Date(r.roster_frozen_at).getTime() : null;
  }

  // 끊기거나 방을 못 찾으면 바를 스스로 올린다. 교사가 마우스를 만지기
  // 전에는 아무 말도 안 하는 화면이 제일 나쁘다 — 버튼을 세 번 누르게 된다.
  function connChanged(next) {
    var was = conn;
    conn = next;
    if (was !== next && (next === 'off' || next === 'noroom')) openBar();
  }

  // 낙찰자 별명은 공개 결과에서 빠져 있다(학생이 읽는 표라서). 교사 토큰으로
  // 받은 원본에서 좌석->별명 지도를 만들어 screen.js 가 읽을 자리에 놓는다.
  // 서로 다른 IIFE 라 window 를 거치는 것 말고는 길이 없다.
  function shareBuyers(full) {
    if (!full || !full.seats) return;
    var m = {};
    full.seats.forEach(function (s) { if (s.buyer) m[s.label] = s.buyer; });
    YM.tvBuyers = m;
  }

  async function tvPull() {
    if (!ROOM) return;
    try {
      var q = await db.sb.from('rooms_public').select('*').eq('room_code', ROOM).maybeSingle();
      if (q.error) throw new Error(q.error.message);
      if (!q.data) {
        connChanged('noroom');
        say(ROOM + ' 방을 찾을 수 없습니다. 기한이 지났다면 「복구」의 「방 기한 30일 연장」을 눌러 주세요.', 'warn');
        paintLive();
        return;
      }
      connChanged('live');
      applyRoom(q.data);

      // 단계마다 꼭 필요한 것만 더 읽는다. 중계화면이 이미 2.5초마다
      // 세 테이블을 읽고 있으므로, 여기서 한 벌 더 얹으면 요청이 두 배가 된다.
      if (room.phase === 'decide' || room.phase === 'budget') {
        var l1 = await db.sb.from('listings').select('id', { count: 'exact', head: true })
          .eq('room_id', room.id).eq('status', 'pending');
        sellCount = l1.count || 0;
      } else if (room.phase === 'auction') {
        var l2 = await db.sb.from('listings').select('ends_at').eq('room_id', room.id).eq('status', 'open');
        var rows = l2.data || [];
        openCount = rows.length;
        nextClose = null;
        rows.forEach(function (x) { if (!nextClose || x.ends_at < nextClose) nextClose = x.ends_at; });
        // 정산 재촉자로도 참여한다. 몇 번 불려도 되는 함수이고 토큰이 필요 없다.
        db.rpc('settle_expired_listings', { p_room_code: ROOM }).catch(function () {});
      }

      paintStep();
    } catch (e) {
      // 다음 주기에 다시 시도한다. 화면은 '끊김' 이라고 글자로 말한다.
      connChanged('off');
    }
    paintLive();
  }

  // -------------------------------------------------------------------
  // 키보드 — 스페이스바 하나만
  // -------------------------------------------------------------------
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== ' ' && ev.code !== 'Space') return;
    var t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (!controlOn || coverOn) return;
    // 포커스된 버튼이 스페이스로 한 번 더 눌리는 것을 막는다.
    ev.preventDefault();
    wake();
    // 2단계 확인이 필요한 버튼(복구·초기화)은 스페이스로 실행되지 않는다.
    // 큰 버튼만 누른다.
    pressStep();
  });

  // -------------------------------------------------------------------
  // 반 고르기 · 암호
  // -------------------------------------------------------------------
  function roomLabel(rc) {
    if (rc === 'YM2-TEST') return '연습';
    return rc.replace('YM2-', '') + '반';
  }

  var pickedRoom = '';

  // 다음 수업에 쓸 방. 교사는 반 번호를 고르지 않는다 — 아직 아무도 안 쓴
  // 방을 순서대로 집어간다. 방은 '교시를 갈라놓기' 위해 있는 것이지
  // 학생이 몇 반인지와는 아무 상관이 없다.
  async function nextCleanRoom() {
    try {
      var r = await db.sb.from('rooms_public')
        .select('room_code, join_open, roster_frozen_at, player_count, phase')
        .limit(40);
      if (r.error) return null;
      var by = {};
      (r.data || []).forEach(function (x) { by[x.room_code] = x; });
      for (var i = 0; i < C.ROOMS.length; i++) {
        var rc = C.ROOMS[i];
        if (rc === 'YM2-TEST') continue;            // 연습방은 자동으로 집지 않는다
        var x = by[rc];
        if (!x) continue;
        if (!x.join_open && !x.roster_frozen_at && !x.player_count && x.phase === 'lobby') return rc;
      }
      return null;
    } catch (e) { return null; }
  }

  function buildRoomButtons() {
    var host = $('#tvRooms');
    U.clear(host);
    C.ROOMS.forEach(function (rc) {
      var b = el('button', 'tv-room' + (rc === 'YM2-TEST' ? ' tv-room--test' : ''));
      b.type = 'button';
      b.appendChild(el('span', 'tv-room__n', roomLabel(rc)));
      // 암호가 이미 이 기기에 있는 반은 그렇다고만 말한다. 값은 보여 주지 않는다.
      b.appendChild(el('span', 'tv-room__k', keyGet() ? '암호 저장됨' : '암호 필요'));
      b.addEventListener('click', function () { pickRoom(rc); });
      host.appendChild(b);
    });
  }

  function pickRoom(rc) {
    pickedRoom = rc;
    var tok = keyGet();
    if (tok) { enterRoom(rc, tok); return; }
    $('#tvSetupH').textContent = '교사 암호를 한 번만 입력하세요';
    $('#tvPw').hidden = false;
    $('#tvErr').hidden = true;
    var inp = $('#tvKey');
    inp.value = '';
    inp.focus();
  }

  // 반이 정해졌다. 주소의 ?room= 과 같으면 그 자리에서 조종 모드로,
  // 다르면 주소를 바꿔 다시 연다. 새로고침이 가장 안전한 반 전환이다 —
  // screen.js 의 setInterval 과 realtime 채널에는 해제 경로가 없어서,
  // 한 탭에서 반을 갈아타면 앞 반의 pull 결과가 뒤 반 화면에 섞여 들어온다.
  function enterRoom(rc, tok) {
    lsSet(KEY_ROOM, rc);
    keySet(tok);
    // ROOM 은 이미 주소의 ?room= 과 같다(부팅에서 replaceState 로 맞춰 둔다).
    // 다른 반을 골랐으면 주소를 바꿔 다시 연다.
    if (rc !== ROOM) {
      location.replace(location.pathname + '?room=' + rc);
      return;
    }
    TOKEN = tok;
    hideCovers();
    enterControl();
    tvPull();
  }

  async function submitKey() {
    var inp = $('#tvKey');
    var tok = (inp.value || '').trim();
    var errBox = $('#tvErr');
    var rc = pickedRoom || ROOM;
    if (!rc) { errBox.textContent = '먼저 반을 골라 주세요.'; errBox.hidden = false; return; }
    if (!tok) { errBox.textContent = '암호를 입력해 주세요.'; errBox.hidden = false; return; }

    var go = $('#tvKeyGo');
    go.disabled = true;
    go.textContent = '확인 중…';
    try {
      // 이 반에서 관리자 RPC 가 실제로 통하는지 먼저 확인한다.
      await db.rpc('admin_state', { p_room_code: rc, p_admin_token: tok });
      inp.value = '';                                   // 입력칸에 남겨 두지 않는다
      errBox.hidden = true;
      enterRoom(rc, tok);
    } catch (e) {
      if (e && (String(e.code) === '42501' || /unauthorized|permission/i.test(String(e.message || '')))) {
        errBox.textContent = '암호가 맞지 않습니다. 반과 암호가 짝이 맞는지 확인해 주세요.';
      } else {
        errBox.textContent = '확인하지 못했습니다. 인터넷 연결을 확인하고 다시 눌러 주세요.';
      }
      errBox.hidden = false;
      inp.value = '';
      inp.focus();
    }
    go.disabled = false;
    go.textContent = '확인';
  }

  $('#tvKeyGo').addEventListener('click', submitKey);
  $('#tvKey').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); submitKey(); }
  });

  // full = 아직 몰 반이 없다(중계할 것도 없다) → 화면을 덮는다.
  // sheet = 반은 정해졌고 중계는 이미 돌고 있다 → 아래쪽에만 뜬다.
  function showSetup(mode, why) {
    coverOn = true;
    buildRoomButtons();
    var box = $('#tvSetup');
    box.className = 'tv-cover ' + (mode === 'sheet' ? 'is-sheet' : 'is-full');
    box.hidden = false;
    $('#tvSetupFoot').textContent =
      '이 교탁 PC 에 한 번만 저장해 두면 다음 교시부터는 묻지 않습니다.';
    if (mode === 'sheet' && ROOM) {
      pickedRoom = ROOM;
      $('#tvSetupH').textContent = '중계 중 — 조종하려면 교사 암호가 필요합니다';
      $('#tvPw').hidden = false;
      // 방은 이미 정해져 있다. 반 버튼을 같이 띄우면 교사가 "여기서도
      // 골라야 하나" 하고 멈춘다 — 물어보는 것은 암호 하나뿐이어야 한다.
      $('#tvRooms').hidden = true;
    } else {
      $('#tvSetupH').textContent = '반을 고르세요';
      $('#tvPw').hidden = true;
      $('#tvRooms').hidden = false;
    }
    if (why) { $('#tvErr').textContent = why; $('#tvErr').hidden = false; }
  }

  function hideCovers() {
    coverOn = false;
    $('#tvSetup').hidden = true;
    $('#tvMismatch').hidden = true;
  }

  // 조종판이 잡은 반과 중계가 그리는 반이 다르면 화면 전체를 덮는다.
  // 교사가 연습방을 조종하는데 학생 33명은 실제 반에 있는 사고는,
  // 한 화면에 섞여 있으면 오히려 더 알아채기 어렵다.
  function showMismatch() {
    coverOn = true;
    $('#tvMmText').textContent =
      '주소의 반은 ' + roomLabel(mismatch.url) + '(' + mismatch.url + '), ' +
      '이 PC 에 저장된 반은 ' + roomLabel(mismatch.saved) + '(' + mismatch.saved + ') 입니다.';
    var host = $('#tvMmBtns');
    U.clear(host);
    [[mismatch.url, '주소의 반'], [mismatch.saved, '저장된 반']].forEach(function (p) {
      var b = el('button', 'tv-btn tv-btn--primary');
      b.type = 'button';
      b.textContent = p[1] + ' ' + roomLabel(p[0]) + '으로 시작';
      b.addEventListener('click', function () {
        lsSet(KEY_ROOM, p[0]);
        location.replace(location.pathname + '?room=' + p[0]);
      });
      host.appendChild(b);
    });
    $('#tvMismatch').hidden = false;
  }

  // -------------------------------------------------------------------
  // 시작
  // -------------------------------------------------------------------
  function enterControl() {
    if (controlOn) return;                 // 두 번 불려도 타이머를 두 벌 만들지 않는다
    controlOn = true;
    bar.hidden = false;
    handle.hidden = false;
    openBar();
    if (!pollTimer) pollTimer = setInterval(tvPull, 2000);
    if (!tickTimer) {
      tickTimer = setInterval(function () {
        sayDrop();
        paintLive();
        paintStep();

        var bl = $('#tvBookLeft');
        if (bl && room) bl.textContent = '남은 ' + U.secs(db.msUntil(room.booking_ends_at));

        // 끊긴 동안에는 큰 버튼을 잠근다. prevote/decide/results/yosemite 는
        // 서버에 단발 가드가 없어서, 재클릭이 그 단계 타이머를 처음부터
        // 되감는다 — 학생 33명 화면의 남은 시간이 거꾸로 간다.
        // 잠금의 근거는 두 가지뿐이다: 끊겼거나(눈에 보이고 스스로 풀린다),
        // 이 버튼이 그려진/눌린 지 얼마 안 됐거나(시각이 버튼에 박혀 있다).
        // busyUntil 같은 바깥 상태를 여기 섞으면, 그 값이 한 번 어긋났을 때
        // 큰 버튼이 영원히 잠긴 채로 남는다 — 수업이 거기서 멈춘다.
        var sb = stepHost.querySelector('button.tv-step');
        if (sb && shownStepId !== '__booking__') {
          sb.disabled = (conn === 'off') || Date.now() < (+sb.dataset.settle || 0);
        }
        if (!mustStay() && Date.now() - lastMove > 3000) {
          closeBar();
          html.classList.add('tv-nocursor');   // 커서도 쉰다. 마우스를 움직이면 즉시 돌아온다.
        }
      }, 400);
    }
  }

  async function boot() {
    if (mismatch) { showMismatch(); return; }
    if (!ROOM) {
      var auto = await nextCleanRoom();
      if (auto) { lsSet(KEY_ROOM, auto); location.replace(location.pathname + '?room=' + auto); return; }
      showSetup('full', '쓸 수 있는 빈 반이 없습니다. 반을 직접 고르거나, 쓴 반을 「이 반 초기화」 해 주세요.');
      return;
    }

    var tok = keyGet();
    if (!tok) { showSetup('sheet'); return; }

    TOKEN = tok;
    // 확인보다 바를 먼저 띄운다. 학교 인터넷이 죽어 있으면 시계 보정만
    // 수십 초가 걸릴 수 있는데, 그동안 조종판이 아예 없으면 교사는
    // "이 페이지는 조종이 안 되는 화면인가" 하고 다른 것을 찾기 시작한다.
    enterControl();
    try { await db.syncClock(); } catch (e) { /* 시계 보정은 못 해도 진행한다 */ }
    try {
      var st = await db.rpc('admin_state', { p_room_code: ROOM, p_admin_token: TOKEN });
      applyRoom(st.room);                  // roster 는 쓰지 않고 버린다
      shareBuyers(st.results_full);        // 새로고침 뒤에도 낙찰자 이름이 남는다
    } catch (e) {
      if (e && (String(e.code) === '42501' || /unauthorized|permission/i.test(String(e.message || '')))) {
        // 암호가 틀렸다(또는 방을 다시 만들었다). 중계는 계속 돌려 둔다.
        TOKEN = null;
        keyClear();
        shownStepId = null;
        showSetup('sheet', '저장해 둔 암호가 더 이상 통하지 않습니다. 다시 입력해 주세요.');
      } else {
        // 인터넷이 잠깐 끊긴 것뿐일 수 있다. 암호를 버리지 않는다 —
        // 여기서 버리면 교사가 수업 중에 암호를 다시 찾아 헤매게 된다.
        say('연결하지 못했습니다. 계속 다시 시도합니다.', 'warn');
      }
    }
    tvPull();
  }

  boot();
})();
