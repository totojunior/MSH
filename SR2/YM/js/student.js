/* YM — 학생 화면.
 *
 * 규칙 하나: 이 파일은 아무것도 판정하지 않는다. 버튼을 눌러 서버에 묻고,
 * 서버가 돌려준 상태를 그린다. 개발자도구로 여기를 고쳐도 게임은 안 바뀐다.
 *
 * 좌석은 복수다. 예매는 한 사람 한 자리지만 경매에서는 돈이 있는 만큼
 * 몇 개든 살 수 있다. 그래서 '내 좌석'·'내가 1등' 은 전부 배열로 다룬다
 * (me.my_seats / me.leads). 단수 키(my_seat / leading / my_listing)는
 * 서버가 호환용으로 남겨 둔 첫 항목일 뿐이고, 여기서는 옛 서버를 만났을
 * 때의 안전망으로만 쓴다.
 *
 * 돈은 세 개다. 입찰해도 잔액은 줄지 않고 정산에서 빠지므로, '가진 돈'
 * 하나만 보여 주면 학생은 돈이 그대로 보이는데 버튼이 죽은 이유를 영영
 * 모른다. balance(가진 돈) · committed(걸어 둔 돈) · available(더 쓸 수
 * 있는 돈) 셋 다 서버가 계산해서 준다 — 여기서 다시 계산하지 않는다.
 */
(function () {
  'use strict';

  var U = YM.ui, C = YM.CONFIG, db = YM.db;
  var $ = U.$, el = U.el;

  // 방 코드는 주소에 있으면 그걸 쓰고, 없으면 지금 입장이 열린 방을 찾아간다.
  //
  // 예전에는 없을 때 'YM2-1'을 기본값으로 썼다. 그런데 학생들은 크롬북을
  // 반마다 돌려 쓰고, 주소창 자동완성은 앞 반이 쓰던 링크를 물어 온다.
  // 그러면 3반 학생이 아무 경고 없이 1반 방에 들어가 앉는다 — 교사도
  // 학생도 원인을 못 찾는다. 기본값은 없앤다.
  var params = new URLSearchParams(location.search);
  var urlRoom = (params.get('room') || '').trim().toUpperCase();
  // ?pick=1 — '반 다시 고르기' 로 돌아온 경우. 이때는 자동 입장을 하지 않는다.
  // 안 그러면 방금 나온 그 방으로 곧장 되돌아가서 버튼이 죽은 것처럼 보인다.
  var forcePick = params.get('pick') === '1';
  var ROOM = urlRoom;

  var store = null;           // boot() 전까지는 없다
  var shown = null;           // 지금 떠 있는 화면
  var lastPhase = null;
  var cdRAF = null;
  var chosenPrice = null, chosenReason = null;
  var seatButtons = {};       // seat_id -> button
  var votedThis = {};

  // -------------------------------------------------------------------
  // 서버가 준 것을 그대로 읽는 도구 — 복수 좌석 · 복수 선두 · 세 가지 돈
  // -------------------------------------------------------------------
  // 단수 키로 되돌리는 갈래를 둔 이유: SQL 을 먼저 배포하고 HTML/JS 를
  // 나중에 배포하는 순서가 정석인데, GitHub Pages 캐시 때문에 그 반대가
  // 잠깐 일어날 수 있다. 그때도 화면이 죽지 않게 한다.
  function mySeats(me) {
    if (me && me.my_seats) return me.my_seats;
    return (me && me.my_seat) ? [me.my_seat] : [];
  }

  function myLeads(me) {
    if (me && me.leads) return me.leads;
    return (me && me.leading) ? [me.leading] : [];
  }

  function myListings(me) {
    if (me && me.my_listings) return me.my_listings;
    return (me && me.my_listing) ? [me.my_listing] : [];
  }

  // 약정과 가용액은 서버가 계산한다. 여기서 balance - sum(leads) 로 다시
  // 구하면, 정산이 방금 돈 순간 화면의 판정과 서버의 판정이 갈린다.
  // 옛 서버(약정 개념 이전)에는 이 키가 없다 — 그 서버에서는 선두가
  // 하나뿐이라 가용액이 잔액과 같으므로 잔액을 그대로 쓴다.
  function money(me) {
    var bal = (me && me.balance) || 0;
    return {
      bal: bal,
      cmt: (me && typeof me.committed === 'number') ? me.committed : 0,
      av:  (me && typeof me.available === 'number') ? me.available : bal,
    };
  }

  // 좌석표를 여러 개 나열한다. 한 줄 텍스트로 이어 붙이면 세 개째부터
  // 옆 화면으로 넘쳐서 어느 좌석인지 안 읽힌다.
  function seatChips(labels) {
    var box = el('span', 'ym-banner__seats');
    labels.forEach(function (lb) { box.appendChild(el('span', 'ym-seatchip', lb)); });
    return box;
  }

  function labelsOf(seats) {
    return seats.map(function (x) { return x.label || x.seat_label; });
  }

  // -------------------------------------------------------------------
  // 화면 전환
  // -------------------------------------------------------------------
  function screen(name) {
    if (shown === name) return;
    shown = name;
    var all = document.querySelectorAll('[data-screen]');
    for (var i = 0; i < all.length; i++) {
      all[i].hidden = all[i].getAttribute('data-screen') !== name;
    }
  }

  function conn(status) {
    var box = $('#conn'), txt = $('#connText');
    if (!box) return;
    box.hidden = false;
    if (status.degraded) {
      box.className = 'ym-conn is-slow';
      txt.textContent = '느린 연결';
    } else if (status.live) {
      box.className = 'ym-conn is-live';
      txt.textContent = '연결됨';
    } else {
      box.className = 'ym-conn is-off';
      txt.textContent = '연결 중…';
    }
  }

  // -------------------------------------------------------------------
  // 참가
  // -------------------------------------------------------------------
  function roomLabel(code) {
    return code === 'YM2-TEST' ? '리허설' : code.replace('YM2-', '2학년 ') + '반';
  }

  // 주사위 — 빈칸 앞에서 멈추는 학생을 위한 탈출구.
  // 서버에도 같은 성격의 목록이 있지만, 여기 것은 눈으로 보고 마음에 안 들면
  // 다시 굴릴 수 있다는 점이 다르다.
  var DICE = ['팝콘도둑','앞자리사수','늦게온사람','매점단골','엔딩크레딧',
              '스포금지','예매전쟁','통로석','자막파','더빙파',
              'IMAX중독','좌석요정','줄서기왕','새벽예매','영화광',
              'POPCORN FOX','NEON OWL','MIDNIGHT DEER','QUIET HERON','ENCORE JAY'];

  $('#diceBtn').addEventListener('click', function () {
    var pick = DICE[Math.floor(Math.random() * DICE.length)];
    $('#nickInput').value = pick;
    $('#nickInput').focus();
  });

  // 엔터로도 들어갈 수 있게. 크롬북은 키보드가 있다.
  $('#nickInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); $('#joinBtn').click(); }
  });

  $('#joinBtn').addEventListener('click', async function () {
    var btn = this;
    btn.disabled = true;
    $('#joinErr').hidden = true;
    try {
      var r = await store.join($('#nickInput').value);
      if (!r || !r.ok) {
        $('#joinErr').textContent = db.say(r && r.error);
        $('#joinErr').hidden = false;
        btn.disabled = false;
      }
    } catch (e) {
      $('#joinErr').textContent = '연결하지 못했습니다. 다시 눌러 주세요.';
      $('#joinErr').hidden = false;
      btn.disabled = false;
    }
  });

  // -------------------------------------------------------------------
  // P1 — 좌석
  // -------------------------------------------------------------------
  function drawSeatMap(s) {
    var host = $('#seatmap');
    var rows = {};
    s.seats.forEach(function (st) { (rows[st.row] = rows[st.row] || []).push(st); });

    // 좌석 목록의 모양이 달라졌을 때만 다시 그린다. 매 스냅샷마다 지웠다
    // 새로 만들면 누르려던 버튼이 손가락 밑에서 사라진다.
    var sig = s.seats.map(function (x) { return x.id; }).join(',');
    if (host.dataset.sig !== sig) {
      U.clear(host); seatButtons = {};
      Object.keys(rows).sort().forEach(function (rk) {
        var rowEl = el('div', 'ym-row');
        rowEl.appendChild(el('span', 'ym-row__label', rk));
        rows[rk].sort(function (a, b) { return a.no - b.no; }).forEach(function (st) {
          var b = el('button', 'ym-seat');
          b.type = 'button';
          b.dataset.id = st.id;
          b.appendChild(el('span', 'ym-seat__no', st.no));
          b.addEventListener('pointerdown', function (ev) { ev.preventDefault(); claim(st.id); });
          seatButtons[st.id] = b;
          rowEl.appendChild(b);
        });
        host.appendChild(rowEl);
      });
      host.dataset.sig = sig;
    }

    var left = 0;
    s.seats.forEach(function (st) {
      var b = seatButtons[st.id]; if (!b) return;
      if (!st.taken) left++;
      b.className = 'ym-seat' + (st.mine ? ' is-mine' : st.taken ? ' is-taken' : '');
      b.disabled = st.taken;
      b.setAttribute('aria-label', U.seatAria(st.label, st.taken, st.mine));
    });
    $('#bookLeft').textContent = String(left);
  }

  var claiming = false;
  async function claim(seatId) {
    if (claiming) return;
    claiming = true;
    try {
      var r = await store.call('claim_seat', { p_seat: seatId });
      if (r && r.ok) {
        U.SFX.got();
        await store.refresh();
      } else {
        // 진 사람은 실시간 이벤트를 기다리지 않는다. 서버가 바로 알려 준다.
        var b = seatButtons[seatId];
        if (b && r && r.error === 'TAKEN') { b.className = 'ym-seat is-taken'; b.disabled = true; }
        U.toast(db.say(r && r.error), 'warn');
        if (r && r.error === 'ALREADY_HAVE_SEAT') store.refresh();
      }
    } catch (e) {
      U.toast('연결이 잠깐 끊겼습니다. 다시 눌러 주세요.', 'warn');
    }
    setTimeout(function () { claiming = false; }, 180);
  }

  // 5-4-3-2-1-GO. 모든 기기가 서버 시각 하나를 보고 세므로 동시에 열린다.
  function runCountdown(openAt) {
    if (cdRAF) return;
    function tick() {
      var left = db.msUntil(openAt);
      if (left === null) { cdRAF = null; return; }
      var n = Math.ceil(left / 1000);
      if (n > 5) { $('#cdNum').textContent = String(n); }
      else if (n > 0) {
        if ($('#cdNum').textContent !== String(n)) { $('#cdNum').textContent = String(n); U.SFX.tick(); }
      } else {
        $('#cdNum').textContent = 'GO!';
        U.SFX.go();
        setTimeout(function () { cdRAF = null; render(store.get(), store.status()); }, 550);
        return;
      }
      cdRAF = requestAnimationFrame(tick);
    }
    cdRAF = requestAnimationFrame(tick);
  }

  // -------------------------------------------------------------------
  // 투표 — 화면 하나를 다섯 문항이 나눠 쓴다
  // -------------------------------------------------------------------
  var QUESTIONS = {
    pre:         { k: 'BEFORE WE START', q: '좌석을 되파는 것을 허용해야 할까요?', g: '' },
    post:        { k: 'WAS THIS FAIR?',  q: '방금 일어난 일은 공정했나요?', g: '' },
    q1_movie:    { k: '1 / 3', q: '영화표를 더 비싸게 되파는 것', g: '허용해도 괜찮을까요?' },
    q2_campsite: { k: '2 / 3', q: '국립공원 야영지 예약을 되파는 것', g: '허용해도 괜찮을까요?' },
    q3_upfront:  { k: '3 / 3', q: '영화관이 처음부터 ₩150,000에 파는 것', g: '허용해도 괜찮을까요?' },
  };

  function showVote(qkey, endsAt, s) {
    var def = QUESTIONS[qkey];
    $('#voteKicker').textContent = def.k;
    $('#voteQ').textContent = def.q;
    $('#voteGloss').textContent = def.g;
    var already = (s.me.votes && s.me.votes[qkey]) || votedThis[qkey];
    $('#voteDone').hidden = !already;
    var btns = document.querySelectorAll('[data-vote]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].disabled = !!already;
      btns[i].classList.toggle('is-picked', already === btns[i].dataset.vote);
    }
    $('#voteTime').textContent = U.secs(db.msUntil(endsAt));
    screen('vote');
  }

  document.querySelectorAll('[data-vote]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var s = store.get(); if (!s) return;
      var qkey = currentQuestion(s); if (!qkey) return;
      votedThis[qkey] = b.dataset.vote;
      $('#voteDone').hidden = false;
      document.querySelectorAll('[data-vote]').forEach(function (x) { x.disabled = true; });
      b.classList.add('is-picked');
      try {
        var vr = await store.call('cast_vote', { p_question: qkey, p_choice: b.dataset.vote });
        if (!vr || !vr.ok) throw new Error('vote');
      } catch (e) {
        // 조용히 삼키면 학생은 투표한 줄 알고, 프로젝터 막대에는 안 잡힌다.
        // 그 막대가 이 수업의 결론이라 한 표도 잃으면 안 된다.
        delete votedThis[qkey];
        $('#voteDone').hidden = true;
        document.querySelectorAll('[data-vote]').forEach(function (x) { x.disabled = false; x.classList.remove('is-picked'); });
        U.toast('투표가 저장되지 않았습니다. 다시 눌러 주세요.', 'warn');
      }
      store.refresh();
    });
  });

  // 최종 3문항은 한 화면에서 순서대로 넘어간다.
  function currentQuestion(s) {
    var p = s.room.phase;
    if (p === 'prevote') return 'pre';
    if (p === 'results') return 'post';
    if (p === 'yosemite') {
      var v = s.me.votes || {};
      if (!v.q1_movie && !votedThis.q1_movie) return 'q1_movie';
      if (!v.q2_campsite && !votedThis.q2_campsite) return 'q2_campsite';
      if (!v.q3_upfront && !votedThis.q3_upfront) return 'q3_upfront';
      return null;
    }
    return null;
  }

  // -------------------------------------------------------------------
  // P2 — 가질까 팔까
  // -------------------------------------------------------------------
  function buildDecideControls() {
    if ($('#priceRow').childElementCount) return;
    for (var p = C.OPENING_MIN; p <= C.OPENING_MAX; p += C.OPENING_STEP) {
      (function (price) {
        var b = el('button', 'ym-chip', U.won(price));
        b.type = 'button';
        b.addEventListener('click', function () {
          chosenPrice = price;
          document.querySelectorAll('#priceRow .ym-chip').forEach(function (x) { x.classList.remove('is-picked'); });
          b.classList.add('is-picked');
          refreshListBtn();
        });
        $('#priceRow').appendChild(b);
      })(p);
    }
    var REASONS = [
      ['need_money',  '돈이 필요해서'],
      ['wants_more',  '나보다 더 원하는 사람이 있으니까'],
      ['my_seat',     '내 좌석이니까 내 마음'],
      ['free_trade',  '자유로운 거래인데 뭐가 문제죠'],
    ];
    REASONS.forEach(function (r) {
      var b = el('button', 'ym-reason', r[1]);
      b.type = 'button';
      b.addEventListener('click', function () {
        chosenReason = r[0];
        document.querySelectorAll('#reasonRow .ym-reason').forEach(function (x) { x.classList.remove('is-picked'); });
        b.classList.add('is-picked');
        refreshListBtn();
      });
      $('#reasonRow').appendChild(b);
    });
  }

  function refreshListBtn() {
    $('#btnList').disabled = !(chosenPrice && chosenReason);
  }

  $('#btnKeep').addEventListener('click', async function () {
    try {
      var r = await store.call('submit_decision',
        { p_sell: false, p_opening: null, p_reason: null });
      if (r && r.ok) { $('#sellForm').hidden = true; store.refresh(); }
      else U.toast(db.say(r && r.error), 'warn');
    } catch (e) { U.toast('다시 눌러 주세요.', 'warn'); }
  });

  $('#btnSell').addEventListener('click', function () {
    $('#sellForm').hidden = false;
    this.classList.add('is-picked');
    $('#btnKeep').classList.remove('is-picked');
  });

  $('#btnList').addEventListener('click', async function () {
    try {
      var r = await store.call('submit_decision',
        { p_sell: true, p_opening: chosenPrice, p_reason: chosenReason });
      if (r && r.ok) store.refresh();
      else U.toast(db.say(r && r.error), 'warn');
    } catch (e) { U.toast('다시 눌러 주세요.', 'warn'); }
  });

  // -------------------------------------------------------------------
  // P3B — 경매
  // -------------------------------------------------------------------
  function minBidFor(l) {
    var cur = l.highest_bid;
    if (cur === null || cur === undefined) return l.opening_bid;
    var step = cur < 50000 ? 10000 : cur < 100000 ? 20000 : 50000;
    return cur + step;
  }
  function stepAt(v) { return v < 50000 ? 10000 : v < 100000 ? 20000 : 50000; }

  // 옆 정보판의 돈 세 줄. 서버가 준 숫자를 그대로 옮긴다.
  function drawMoney(me) {
    var m = money(me);
    var leads = myLeads(me);

    $('#aucAvail').textContent = U.won(m.av);
    $('#aucBal').textContent = U.won(m.bal);
    $('#aucCommitted').textContent = U.won(m.cmt);

    // 어디에 얼마가 걸려 있는지까지 적는다. 합계 하나로는 '어느 좌석'을
    // 말하지 못하고, 그러면 학생은 어느 입찰을 포기해야 할지 모른다.
    var cs = $('#aucCommittedSeats');
    if (leads.length) {
      cs.hidden = false;
      cs.textContent = leads.map(function (x) {
        return x.seat_label + ' ' + U.won(x.amount);
      }).join(' · ');
    } else {
      cs.hidden = true;
      cs.textContent = '';
    }
  }

  // 배너. 판단하지 않는다 — 지금 무엇을 가졌고 어디서 1등인지만 적는다.
  // 예전에는 좌석 보유자에게 '살 수 있는 것: 없음' 을 띄워 시장을 닫았다.
  // 그 한 줄이 (가) 를 막던 화면 쪽 당사자였다.
  function drawBanner(me) {
    var banner = $('#aucBanner');
    var seats = mySeats(me), leads = myLeads(me);
    U.clear(banner);
    banner.className = 'ym-banner';
    banner.hidden = !(seats.length || leads.length);
    if (banner.hidden) return;

    // 두 줄이 동시에 뜰 수 있다. 좌석을 가진 채 다른 좌석에서 1등인 학생이
    // 바로 이 활동의 주인공이므로, 둘 중 하나만 보여 주면 안 된다.
    if (seats.length) {
      var r1 = el('span', 'ym-banner__row is-mine');
      r1.appendChild(el('span', 'ym-banner__k',
        seats.length > 1 ? ('가진 좌석 ' + seats.length + '개') : '가진 좌석'));
      r1.appendChild(seatChips(labelsOf(seats)));
      // 쓸 수 있는 돈이 0 이면 '더 살 수도 있습니다' 는 거짓말이다.
      if (money(me).av > 0) r1.appendChild(el('span', 'ym-banner__note', '더 살 수도 있습니다.'));
      banner.appendChild(r1);
    }
    if (leads.length) {
      var r2 = el('span', 'ym-banner__row is-lead');
      r2.appendChild(el('span', 'ym-banner__k',
        leads.length > 1 ? ('지금 1등 ' + leads.length + '곳') : '지금 1등'));
      r2.appendChild(seatChips(leads.map(function (x) { return x.seat_label; })));
      banner.appendChild(r2);
    }
  }

  function drawAuction(s) {
    var host = $('#listings');
    var open = s.listings.filter(function (l) { return l.status === 'open'; });
    $('#auctionEmpty').hidden = open.length > 0;

    drawMoney(s.me);
    drawBanner(s.me);

    // 카드를 매번 지웠다 새로 만들지 않는다. 입찰이 초당 몇 건씩 들어오면
    // 120ms 마다 화면이 통째로 새로 그려지고, 학생이 막 누르려던 버튼이
    // 손가락 밑에서 사라진다. 탭은 조용히 허공으로 간다.
    // 매물 구성이 달라졌을 때만 다시 만들고, 평소에는 숫자만 고쳐 넣는다.
    //
    // sig 에 '내 상태' 를 섞지 않는다. 예전에는 좌석 보유 여부와 선두
    // 매물을 sig 에 넣었는데, 카드 구조가 더 이상 그것들에 따라 달라지지
    // 않게 고친 지금 그 값을 넣으면 '남에게 밀린 순간' 마다 카드가 전부
    // 다시 만들어진다 — 되지르려고 손을 뻗은 바로 그 순간이다.
    // 잠금과 해제는 아래 updateLot 이 disabled 만 바꿔서 처리한다.
    open.sort(function (a, b) { return a.seat_label < b.seat_label ? -1 : 1; });
    var sig = open.map(function (l) { return l.id; }).join(',');
    if (host.dataset.sig === sig) {
      open.forEach(function (l) { updateLot(host, l, s); });
      return;
    }
    host.dataset.sig = sig;
    // 통째로 지우고 다시 만들지 않는다.
    //
    // 마감된 매물이 정산되면 open 목록에서 하나씩 빠진다. 그때 U.clear 로
    // 전부 날리면 남아 있는 카드까지 새 노드가 되고, 마지막 10초에 되지르려고
    // 손을 뻗은 학생의 탭이 그대로 사라진다. 없어진 것만 지우고 새로 생긴
    // 것만 붙인다.
    var keep = {};
    open.forEach(function (l) { keep[l.id] = true; });
    Array.prototype.slice.call(host.querySelectorAll('[data-lot]')).forEach(function (n) {
      if (!keep[n.dataset.lot]) n.remove();
    });
    open.forEach(function (l) {
      if (host.querySelector('[data-lot="' + l.id + '"]')) { updateLot(host, l, s); return; }
      var card = el('div', 'ym-lot');
      card.dataset.lot = l.id;
      card.appendChild(el('p', 'ym-lot__seat', l.seat_label));
      card.appendChild(el('p', 'ym-lot__price'));
      card.appendChild(el('p', 'ym-lot__label'));
      card.appendChild(el('p', 'ym-lot__time'));
      card.appendChild(el('p', 'ym-lot__note'));

      // 입찰 버튼 행은 조건 없이 만든다. 예전에는 좌석 보유자에게 이 행을
      // 아예 만들지 않았고, updateLot 은 버튼이 없으면 그냥 돌아 나갔다 —
      // 상태가 바뀌어도 버튼이 영영 생기지 않는 구조적 버그였다.
      // 내가 올린 좌석만 예외다(자기 매물 입찰은 계속 막힌다).
      if (!l.mine) {
        var row = el('div', 'ym-lot__bids');
        for (var i = 0; i < 3; i++) {
          var b = el('button', 'ym-bid');
          b.type = 'button';
          if (i === 0) b.classList.add('is-min');
          b.addEventListener('click', function () {
            // 화면이 갱신됐을 수 있으니 항상 지금 적혀 있는 금액을 쓴다
            var amt = parseInt(this.dataset.amt, 10);
            if (amt) bid(l.id, amt);
          });
          row.appendChild(b);
        }
        card.appendChild(row);
      }
      host.appendChild(card);
      updateLot(host, l, s);
    });
  }

  // 카드를 다시 만들지 않고 값만 바꾼다. 버튼 요소가 그대로 살아 있으므로
  // 누르는 중이던 탭이 사라지지 않는다.
  function updateLot(host, l, s) {
    var card = host.querySelector('[data-lot="' + l.id + '"]');
    if (!card) return;
    var m = money(s.me);

    card.className = 'ym-lot' + (l.leading ? ' is-lead' : '') + (l.mine ? ' is-mine' : '');
    var price = card.querySelector('.ym-lot__price');
    var label = card.querySelector('.ym-lot__label');
    if (price) price.textContent = l.highest_bid ? U.won(l.highest_bid) : U.won(l.opening_bid);
    if (label) label.textContent = l.highest_bid ? '현재가' : '시작가';
    var t = card.querySelector('.ym-lot__time');
    if (t) { t.dataset.ends = l.ends_at || ''; t.textContent = U.secs(db.msUntil(l.ends_at)); }

    var base = minBidFor(l);
    var opts = [base, base + stepAt(base), base + stepAt(base) + stepAt(base + stepAt(base))];

    // 비활성은 흐릿함(색)으로만 나타난다 — 그것만으로는 규칙 위반이다.
    // 잠긴 이유를 카드 안에 글자로 같이 적는다.
    var note = card.querySelector('.ym-lot__note');
    if (note) {
      note.textContent = l.mine ? '내가 올린 좌석'
                       : l.leading ? '내가 1등'
                       : base > m.av ? '더 쓸 수 있는 돈으로는 모자랍니다'
                       : '';
    }

    // 이 좌석에서 내가 이미 1등이면 버튼을 감춘다 — 지울 수는 없다.
    // 요소를 지우면 밀려난 순간 되지를 버튼이 없고, 죽은 버튼 세 개를
    // 그대로 두면 이기고 있는 좌석이 잠긴 것처럼 보인다. 감추기만 한다.
    var row = card.querySelector('.ym-lot__bids');
    if (row) row.hidden = !!l.leading;

    var btns = card.querySelectorAll('.ym-bid');
    if (!btns.length) return;             // 내가 올린 좌석 — 입찰 행이 없다
    for (var i = 0; i < btns.length && i < opts.length; i++) {
      var amt = opts[i];
      btns[i].textContent = U.won(amt);
      btns[i].dataset.amt = amt;
      // 여기서 새로 판정하는 것은 없다. 서버가 준 사실 두 개만 옮긴다 —
      // '이 좌석에서 내가 이미 1등'(l.leading)과 '서버가 알려 준 가용액'.
      // 좌석을 가졌는지, 다른 좌석에서 1등인지는 더 이상 보지 않는다.
      var over = amt > m.av;
      btns[i].disabled = over || !!l.leading;
      btns[i].title = l.leading ? '이미 이 좌석에서 1등입니다'
                    : over ? ('더 쓸 수 있는 돈 ' + U.won(m.av) + ' 을 넘습니다')
                    : '';
    }
  }

  // 서버가 거절할 때 숫자까지 같이 준다(balance / committed / available).
  // 문장만 띄우면 학생은 '그럼 얼마까지 되는데?' 를 모른 채 같은 버튼을
  // 다시 누른다. 60초 안에 그건 그냥 잃은 시간이다.
  function bidWhy(r) {
    var msg = db.say(r && r.error);
    if (r && typeof r.available === 'number') {
      msg += ' 지금 쓸 수 있는 돈은 ' + U.won(r.available) + ' 입니다';
      msg += r.committed ? (' (걸어 둔 돈 ' + U.won(r.committed) + ').') : '.';
    }
    return msg;
  }

  var bidding = false;
  async function bid(listingId, amount) {
    if (bidding) return;
    bidding = true;
    try {
      var r = await store.call('place_bid', { p_listing: listingId, p_amount: amount });
      if (r && r.ok) {
        U.SFX.bid();
      } else {
        U.toast(bidWhy(r), 'warn');
      }
      await store.refresh();
    } catch (e) {
      U.toast('다시 눌러 주세요.', 'warn');
    }
    bidding = false;
  }

  // 정산은 교사의 브라우저에 기대지 않는다. 내 카운트다운이 0이 되면
  // 나도 한 번 재촉한다. 33명이 동시에 불러도 서버에서 한 번만 처리된다.
  var settleAsked = {};
  function nudgeSettle(s) {
    var due = s.listings.some(function (l) {
      return l.status === 'open' && db.msUntil(l.ends_at) === 0;
    });
    if (!due) return;
    var key = Math.floor(Date.now() / 2000);
    if (settleAsked[key]) return;
    settleAsked = {}; settleAsked[key] = true;
    db.rpc('settle_expired_listings', { p_room_code: ROOM }).then(function () { store.refresh(); }).catch(function () {});
  }

  // -------------------------------------------------------------------
  // 결과 — 학생 기기는 자기 것만 조용히 보여 준다
  // -------------------------------------------------------------------
  // 내역 한 줄. 좌석표 + 무슨 일이 있었나 + 금액.
  function resRow(host, label, what, detail) {
    var li = el('li', 'ym-reslist__row');
    li.appendChild(el('span', 'ym-reslist__seat', label));
    var box = el('span', 'ym-reslist__body');
    box.appendChild(el('span', 'ym-reslist__what', what));
    if (detail) box.appendChild(el('span', 'ym-reslist__detail', detail));
    li.appendChild(box);
    host.appendChild(li);
  }

  // 한 문장 요약. "1개 팔고 2개를 ₩210,000 에 샀습니다" 처럼
  // 팔기와 사기가 한 학생에게 동시에 일어날 수 있다는 것을 문장이 말한다.
  function resultSummary(soldN, boughtN, spent, keptN, unsoldN, face) {
    var buy = boughtN
      ? (boughtN + '개를 ' + (spent !== null ? U.won(spent) + ' 에 ' : '') + '샀습니다')
      : '';
    if (soldN && boughtN) return soldN + '개 팔고 ' + buy + '.';
    if (buy) return buy + '.';
    if (soldN) return soldN + '개 팔았습니다.';
    // 올렸는데 안 팔린 것과 아예 안 올린 것을 구분한다. 한 문장으로 뭉치면
    // '팔지 않고' 가 되어, 팔려고 내놓았던 학생에게 거짓말이 된다.
    if (unsoldN) return '올렸지만 팔리지 않았습니다. 좌석은 그대로입니다.';
    if (keptN) return '팔지 않고 그대로 가지고 있습니다. 정가 ' + U.won(face) + '.';
    // 이 문장은 약하게 만들지 않는다. 좌석 없이 끝난 학생이 이 수업의 결론이다.
    return '끝까지 좌석이 없었습니다.';
  }

  function drawMyResult(s) {
    var me = s.me, res = s.room.results || null, face = s.room.face_value;
    var k = $('#resKicker'), big = $('#resSeat'), line = $('#resLine'),
        list = $('#resList'), bal = $('#resBal'), sub = $('#resSub');

    var seats = mySeats(me);
    var lst = myListings(me);
    var sold   = lst.filter(function (l) { return l.status === 'sold'; });
    var unsold = lst.filter(function (l) { return l.status === 'unsold'; });

    // 경매로 얻은 좌석과 예매로 지킨 좌석을 나눈다. 서버가 좌석마다
    // '어떻게 얻었나'(via)를 적어 준다 — 그래야 "2개 샀습니다" 를 말할 수 있다.
    var bought = seats.filter(function (x) { return x.via === 'auction'; });
    var kept   = seats.filter(function (x) { return x.via !== 'auction'; });

    // 낸 금액은 공개 결과표에서 좌석표로 찾는다. 교사가 아직 결과를
    // 계산하지 않았으면 금액 없이 좌석만 보여 준다 — 거짓말을 하지 않는다.
    var paid = {}, spent = null;
    if (res && res.seats) {
      res.seats.forEach(function (x) { paid[x.label] = x.price; });
      spent = 0;
      bought.forEach(function (x) { spent += (paid[x.label] || 0); });
      if (!bought.length) spent = null;
    }

    // 머리글 — 좌석이 여러 개면 좌석표를 나란히 적고 글자를 줄인다.
    //
    // 팔고 나간 학생에게 'NO SEAT' 을 띄우지 않는다. 좌석이 없는 것은
    // 사실이지만, 15만원에 팔아 넘긴 학생과 끝까지 한 자리도 못 잡은
    // 학생에게 같은 붉은 글씨를 주면 둘 다 틀리게 읽힌다.
    var labels = labelsOf(seats);
    if (!labels.length && sold.length) labels = sold.map(function (l) { return l.seat_label; });
    var soldOnly = !seats.length && sold.length > 0;

    k.textContent = soldOnly ? 'SOLD'
                  : !labels.length ? 'NO SEAT'
                  : labels.length > 1 ? 'YOUR SEATS' : 'YOUR SEAT';
    big.textContent = labels.length ? labels.join(' · ') : '—';
    big.className = 'ym-seatbig' + (labels.length > 2 ? ' is-many' : labels.length > 1 ? ' is-multi' : '');
    line.textContent = resultSummary(sold.length, bought.length, spent,
                                     kept.length, unsold.length, face);

    // 내역 — 해당하는 것을 전부 적는다. 하나를 골라 보여 주지 않는다.
    U.clear(list);
    var listed = {};
    lst.forEach(function (l) { listed[l.seat_label] = true; });

    sold.forEach(function (l) {
      resRow(list, l.seat_label, '팔았습니다',
             '받은 금액 ' + U.won(l.final_price) + ' · 정가 ' + U.won(face));
    });
    bought.forEach(function (x) {
      resRow(list, x.label, '샀습니다',
             paid[x.label] ? ('낸 금액 ' + U.won(paid[x.label])) : '경매에서 낙찰받았습니다');
    });
    unsold.forEach(function (l) {
      resRow(list, l.seat_label, '안 팔렸습니다',
             '올렸지만 아무도 사지 않았습니다 · 좌석은 그대로입니다');
    });
    kept.filter(function (x) { return !listed[x.label]; }).forEach(function (x) {
      resRow(list, x.label, '가지고 있습니다', '정가 ' + U.won(face));
    });
    list.hidden = !list.childElementCount;

    // 남은 돈은 언제나. 세 자리를 산 학생의 0원과 좌석 없는 학생의 남은 돈이
    // 나란히 놓여야 "돈이 있으면 앉는다" 가 학생 손에서도 읽힌다.
    bal.textContent = '남은 돈 ' + U.won(me.balance);

    // 시장이 얼마였는지. 판단은 하지 않는다.
    var notes = [];
    if (res && res.avg_price) notes.push('오늘 팔린 좌석의 평균 가격 ' + U.won(res.avg_price));
    if (res && res.max_seats_one_buyer > 1) {
      notes.push('한 사람이 최대 ' + res.max_seats_one_buyer + '개를 가져갔습니다');
    }
    sub.textContent = notes.join(' · ');

    screen('results');
  }

  // -------------------------------------------------------------------
  // 그리기
  // -------------------------------------------------------------------
  function render(s, status) {
    conn(status || store.status());
    if (!s) {
      // 참가 화면으로 돌아올 때는 버튼을 반드시 되살린다.
      // 한 번 참가에 성공하면 버튼을 잠근 채 다음 화면으로 넘어가는데,
      // 방이 초기화되면 여기로 되돌아오면서 그 잠금이 남는다. 그러면
      // 학생이 눌러도 아무 일도 안 일어나고 오류도 안 뜬다 — 33명 전원이.
      var jb = $('#joinBtn');
      if (jb) jb.disabled = false;
      var je = $('#joinErr');
      if (je) je.hidden = true;
      screen('join');
      return;
    }

    var p = s.room.phase, me = s.me;
    $('#lobbyNick').textContent = me.nickname || '—';
    $('#bookNick').textContent = me.nickname || '—';
    $('#lobbyCount').textContent = String(s.room.player_count || 0);

    if (p !== lastPhase) { lastPhase = p; votedThis = {}; }

    if (p === 'lobby') { screen('lobby'); return; }

    if (p === 'booking') {
      var left = db.msUntil(s.room.booking_opens_at);
      if (left !== null && left > 0) { screen('countdown'); runCountdown(s.room.booking_opens_at); return; }
      // 예매는 한 사람 한 자리다. 그래도 배열의 첫 항목으로 읽는다 —
      // 좌석이 복수가 된 뒤에도 이 화면이 깨지지 않게.
      var got = mySeats(me);
      if (got.length) { $('#gotSeat').textContent = got[0].label;
                        $('#gotFace').textContent = U.won(s.room.face_value); screen('got'); return; }
      var anyLeft = s.seats.some(function (x) { return !x.taken; });
      var timeLeft = db.msUntil(s.room.booking_ends_at);
      if (!anyLeft || timeLeft === 0) { screen('missed'); return; }
      $('#bookTime').textContent = U.secs(timeLeft);
      drawSeatMap(s);
      screen('booking');
      return;
    }

    if (p === 'prevote') {
      var preLeft = db.msUntil(s.room.prevote_ends_at);
      if (preLeft === null || preLeft > 0) { showVote('pre', s.room.prevote_ends_at, s); return; }
      screen('watch'); return;
    }

    if (p === 'decide') {
      // 이 단계에서는 예매 좌석 하나뿐이다(경매 전이므로). 배열로 읽는 것은
      // 교사가 경매 뒤 이 단계를 다시 열었을 때(admin_reopen_decide)를 위한 방어다.
      var own = mySeats(me);
      if (!own.length) { screen('waitmarket'); return; }
      buildDecideControls();
      $('#decSeat').textContent = own[0].label;
      $('#decFace').textContent = U.won(s.room.face_value);
      var noSeat = (s.room.player_count || 0) - s.seats.length;
      $('#decDemand').textContent = noSeat > 0 ? (noSeat + '명이 좌석이 없습니다.') : '';
      $('#decTime').textContent = U.secs(db.msUntil(s.room.decide_ends_at));
      var pend = myListings(me)[0];
      if (pend && pend.status === 'pending') {
        $('#decDone').hidden = false;
        $('#decDone').textContent = '올렸습니다 — 시작가 ' + U.won(pend.opening_bid);
      } else {
        $('#decDone').hidden = true;
      }
      screen('decide');
      return;
    }

    if (p === 'budget') {
      $('#budgetAmt').textContent = me.has_budget ? U.won(me.balance) : '—';
      if (me.has_budget) {
        $('#budgetCard').classList.add('is-flipped');
        setTimeout(function () { $('#budgetAsk').hidden = false; }, 1400);
      }
      screen('budget');
      return;
    }

    if (p === 'auction') { drawAuction(s); nudgeSettle(s); screen('auction'); return; }

    if (p === 'results') {
      // 투표를 먼저 받고, 통계는 프로젝터가 보여 준다.
      // 단, 시간이 끝나면 안 한 학생도 내보낸다. 예전에는 투표하지 않으면
      // 남은 수업 내내 끝난 투표 화면에 갇혀서 자기 결과도 못 봤다.
      var postLeft = db.msUntil(s.room.postvote_ends_at);
      if (!(me.votes && me.votes.post) && !votedThis.post
          && s.room.postvote_ends_at && postLeft > 0) {
        showVote('post', s.room.postvote_ends_at, s); return;
      }
      drawMyResult(s); return;
    }

    if (p === 'yosemite') {
      var q = currentQuestion(s);
      var finLeft = db.msUntil(s.room.finalvote_ends_at);
      // 프로젝터 연출이 질문에 닿기 전에는 학생 손에 문항을 주지 않는다.
      // 예전에는 단계가 바뀌는 순간 33대에 세 문항이 다 떠서, 학생들이
      // 화면의 질문을 보기도 전에 투표를 끝내 버렸다. 그 막대가 결론인데.
      // 교사는 95초를 주고, 마지막 60초만 투표 시간이다.
      if (finLeft !== null && finLeft > 60000) { screen('watch'); return; }
      if (q && (finLeft === null || finLeft > 0)) {
        showVote(q, s.room.finalvote_ends_at, s); return;
      }
      screen('watch'); return;
    }

    screen('watch');
  }

  // 초 단위 표시는 1초마다 스스로 갱신한다. 스냅샷을 그만큼 자주 받을
  // 필요는 없다 — 마감 시각은 이미 알고 있고 시계는 보정돼 있다.
  setInterval(function () {
    if (!store) return;
    var s = store.get(); if (!s) return;

    // 시간만으로 결정되는 전환은 여기서도 챙긴다. 서버 데이터가 안 바뀌면
    // 실시간 이벤트가 오지 않고, 하트비트는 10초 주기라 학생이 그만큼
    // 늦게 넘어간다 — 투표 마감이나 요세미티 문항 열림이 그렇다.
    var p = s.room.phase;
    var gate =
      (p === 'prevote'  && db.msUntil(s.room.prevote_ends_at) === 0) ||
      (p === 'results'  && db.msUntil(s.room.postvote_ends_at) === 0) ||
      (p === 'yosemite' && shown === 'watch' && db.msUntil(s.room.finalvote_ends_at) <= 60000) ||
      (p === 'yosemite' && db.msUntil(s.room.finalvote_ends_at) === 0);
    if (gate) render(s, store.status());

    if (shown === 'booking') $('#bookTime').textContent = U.secs(db.msUntil(s.room.booking_ends_at));
    if (shown === 'vote') {
      var e = s.room.phase === 'prevote' ? s.room.prevote_ends_at
            : s.room.phase === 'results' ? s.room.postvote_ends_at : s.room.finalvote_ends_at;
      $('#voteTime').textContent = U.secs(db.msUntil(e));
    }
    if (shown === 'decide') $('#decTime').textContent = U.secs(db.msUntil(s.room.decide_ends_at));
    if (shown === 'auction') {
      document.querySelectorAll('.ym-lot__time').forEach(function (t) {
        t.textContent = U.secs(db.msUntil(t.dataset.ends));
      });
      nudgeSettle(s);
    }
  }, 1000);

  // -------------------------------------------------------------------
  // 시작 — 반이 정해진 뒤에야 store 가 생긴다
  // -------------------------------------------------------------------
  var booted = false;

  function boot(code) {
    if (booted) return;
    booted = true;
    ROOM = code;
    store = YM.makeStore(ROOM);
    $('#joinRoomLine').textContent = roomLabel(ROOM);
    $('#backPick').hidden = !!urlRoom;   // 주소로 들어왔으면 되돌아갈 곳이 없다
    screen('join');

    store.subscribe(render);
    store.onBid(function () { if (shown === 'auction') U.SFX.bid(); });

    store.start().then(function (r) {
      if (r && r.needJoin) screen('join');
    }).catch(function () { screen('join'); });
  }

  // 틀린 반을 골랐을 때의 탈출구. 아직 참가 전이라 지울 세션도 없다.
  $('#backPick').addEventListener('click', function () {
    location.href = location.pathname + '?pick=1';
  });

  // -------------------------------------------------------------------
  // 반 찾기 — 학생은 반 코드를 몰라도 된다
  // -------------------------------------------------------------------
  var savedRoom = null;
  try {
    var _prev = JSON.parse(localStorage.getItem('ym.session') || 'null');
    if (_prev && _prev.room_code) savedRoom = _prev.room_code;
  } catch (e) { savedRoom = null; }

  // 비상문을 열어 준다. 평소에는 아예 없는 것처럼 둔다.
  function showManual() {
    var d = $('#pickMore');
    d.hidden = false;
    d.open = true;
  }

  function buildManual() {
    var host = $('#roomPick');
    if (host.firstChild) return;
    for (var i = 1; i <= 11; i++) {
      (function (n) {
        var b = el('button', 'ym-btn ym-room', String(n));
        b.type = 'button';
        b.addEventListener('click', function () { boot('YM2-' + n); });
        host.appendChild(b);
      })(i);
    }
  }

  function offer(sel, code, label) {
    var b = $(sel);
    b.textContent = label;
    b.hidden = false;
    b.onclick = function () { boot(code); };
  }

  var tries = 0;

  async function findRoom(auto) {
    if (booted) return;
    var open = await db.openRooms();
    if (booted) return;

    // 열린 방이 딱 하나이고 이 기기에 다른 반 세션이 없다 — 거의 모든 경우가
    // 여기다. 학생은 아무것도 고르지 않고 바로 참가 화면으로 간다.
    if (auto && open && open.length === 1 && (!savedRoom || savedRoom === open[0])) {
      boot(open[0]);
      return;
    }

    if (open === null) {
      $('#pickLead').textContent = '연결이 안 됩니다. 잠시 뒤 다시 시도합니다.';
      buildManual(); showManual();
    } else if (open.length === 0) {
      $('#pickLead').textContent = savedRoom
        ? '입장이 닫혀 있습니다. 하던 수업을 이어서 하세요.'
        : '선생님이 입장을 열면 자동으로 시작됩니다. 이 화면을 그대로 두세요.';
    } else if (open.length === 1) {
      // 이 기기에 다른 반 세션이 남아 있거나, 학생이 직접 다시 고르러 왔다.
      $('#pickLead').textContent = auto ? '어느 쪽인가요?' : '우리 반을 고르세요';
      offer('#pickGo', open[0], roomLabel(open[0]) + ' 참가하기');
      if (!auto) { buildManual(); showManual(); }
    } else {
      $('#pickLead').textContent = '우리 반을 고르세요';
      buildManual(); showManual();
    }

    if (savedRoom) offer('#resumeBtn', savedRoom, roomLabel(savedRoom) + ' — 이어서 하기');

    // 수업 전에 미리 열어 둔 화면이 선생님의 "입장 열기" 를 기다린다.
    tries++;
    setTimeout(function () { findRoom(auto); }, tries < 20 ? 3000 : 10000);
  }

  if (urlRoom && !forcePick) {
    boot(urlRoom);
  } else {
    screen('pick');
    if (forcePick) {
      $('#pickLead').textContent = '우리 반을 고르세요';
      buildManual();
      showManual();
    }
    findRoom(!forcePick);
  }
})();
