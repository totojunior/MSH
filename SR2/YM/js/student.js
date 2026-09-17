/* YM — 학생 화면.
 *
 * 규칙 하나: 이 파일은 아무것도 판정하지 않는다. 버튼을 눌러 서버에 묻고,
 * 서버가 돌려준 상태를 그린다. 개발자도구로 여기를 고쳐도 게임은 안 바뀐다.
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
  var ROOM = urlRoom;

  var store = null;           // boot() 전까지는 없다
  var shown = null;           // 지금 떠 있는 화면
  var lastPhase = null;
  var cdRAF = null;
  var chosenPrice = null, chosenReason = null;
  var seatButtons = {};       // seat_id -> button
  var votedThis = {};

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

  function drawAuction(s) {
    var host = $('#listings');
    var open = s.listings.filter(function (l) { return l.status === 'open'; });
    $('#auctionEmpty').hidden = open.length > 0;
    $('#aucBal').textContent = U.won(s.me.balance);

    var iHaveSeat = !!s.me.my_seat;
    var leading = s.me.leading;
    var banner = $('#aucBanner');
    if (iHaveSeat) {
      banner.hidden = false;
      banner.className = 'ym-banner is-quiet';
      banner.textContent = '살 수 있는 것: 없음 — 이미 좌석이 있습니다.';
    } else if (leading) {
      banner.hidden = false;
      banner.className = 'ym-banner is-lead';
      banner.textContent = '지금 ' + leading.seat_label + ' 에서 당신이 1등입니다.';
    } else {
      banner.hidden = true;
    }

    // 카드를 매번 지웠다 새로 만들지 않는다. 입찰이 초당 몇 건씩 들어오면
    // 120ms 마다 화면이 통째로 새로 그려지고, 학생이 막 누르려던 버튼이
    // 손가락 밑에서 사라진다. 탭은 조용히 허공으로 간다.
    // 매물 구성이 달라졌을 때만 다시 만들고, 평소에는 숫자만 고쳐 넣는다.
    open.sort(function (a, b) { return a.seat_label < b.seat_label ? -1 : 1; });
    var sig = open.map(function (l) { return l.id; }).join(',') + '|' + iHaveSeat + '|' + (leading ? leading.listing_id : '');
    if (host.dataset.sig === sig) {
      open.forEach(function (l) { updateLot(host, l, s, leading, iHaveSeat); });
      return;
    }
    host.dataset.sig = sig;
    U.clear(host);
    open.forEach(function (l) {
      var card = el('div', 'ym-lot' + (l.leading ? ' is-lead' : '') + (l.mine ? ' is-mine' : ''));
      card.dataset.lot = l.id;
      card.appendChild(el('p', 'ym-lot__seat', l.seat_label));

      var cur = el('p', 'ym-lot__price');
      cur.textContent = l.highest_bid ? U.won(l.highest_bid) : U.won(l.opening_bid);
      card.appendChild(cur);
      card.appendChild(el('p', 'ym-lot__label', l.highest_bid ? '현재가' : '시작가'));

      var t = el('p', 'ym-lot__time');
      t.dataset.ends = l.ends_at || '';
      t.textContent = U.secs(db.msUntil(l.ends_at));
      card.appendChild(t);

      if (l.mine) {
        card.appendChild(el('p', 'ym-lot__note', '내가 올린 좌석'));
      } else if (iHaveSeat) {
        card.appendChild(el('p', 'ym-lot__note', '—'));
      } else if (l.leading) {
        card.appendChild(el('p', 'ym-lot__note', '내가 1등'));
      } else {
        var base = minBidFor(l);
        var opts = [base, base + stepAt(base), base + stepAt(base) + stepAt(base + stepAt(base))];
        var row = el('div', 'ym-lot__bids');
        opts.forEach(function (amt, idx) {
          var b = el('button', 'ym-bid', U.won(amt));
          b.type = 'button';
          var afford = amt <= s.me.balance;
          var blocked = !!leading;
          b.disabled = !afford || blocked;
          if (!afford) b.title = '가진 금액을 넘습니다';
          if (blocked) b.title = '다른 좌석에서 1등입니다';
          b.dataset.amt = amt;
          b.addEventListener('click', function () {
            // 화면이 갱신됐을 수 있으니 항상 현재 표시 금액을 쓴다
            bid(l.id, parseInt(b.dataset.amt, 10));
          });
          if (idx === 0) b.classList.add('is-min');
          row.appendChild(b);
        });
        card.appendChild(row);
      }
      host.appendChild(card);
    });
  }

  // 카드를 다시 만들지 않고 값만 바꾼다. 버튼 요소가 그대로 살아 있으므로
  // 누르는 중이던 탭이 사라지지 않는다.
  function updateLot(host, l, s, leading, iHaveSeat) {
    var card = host.querySelector('[data-lot="' + l.id + '"]');
    if (!card) return;
    card.className = 'ym-lot' + (l.leading ? ' is-lead' : '') + (l.mine ? ' is-mine' : '');
    var price = card.querySelector('.ym-lot__price');
    var label = card.querySelector('.ym-lot__label');
    if (price) price.textContent = l.highest_bid ? U.won(l.highest_bid) : U.won(l.opening_bid);
    if (label) label.textContent = l.highest_bid ? '현재가' : '시작가';
    var t = card.querySelector('.ym-lot__time');
    if (t) { t.dataset.ends = l.ends_at || ''; t.textContent = U.secs(db.msUntil(l.ends_at)); }

    var btns = card.querySelectorAll('.ym-bid');
    if (!btns.length) return;
    var base = minBidFor(l);
    var opts = [base, base + stepAt(base), base + stepAt(base) + stepAt(base + stepAt(base))];
    for (var i = 0; i < btns.length && i < opts.length; i++) {
      var amt = opts[i];
      btns[i].textContent = U.won(amt);
      btns[i].dataset.amt = amt;
      var afford = amt <= s.me.balance;
      var blocked = !!leading || iHaveSeat;
      btns[i].disabled = !afford || blocked;
      btns[i].title = !afford ? '가진 금액을 넘습니다' : blocked ? '다른 좌석에서 1등입니다' : '';
    }
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
        U.toast(db.say(r && r.error), 'warn');
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
  function drawMyResult(s) {
    var seat = s.me.my_seat, lst = s.me.my_listing, face = s.room.face_value;
    var k = $('#resKicker'), big = $('#resSeat'), line = $('#resLine'), sub = $('#resSub');

    if (lst && lst.status === 'sold') {
      k.textContent = 'SOLD';
      big.textContent = lst.seat_label;
      line.textContent = '받은 금액 ' + U.won(lst.final_price);
      sub.textContent = '정가 ' + U.won(face);
    } else if (seat && lst && lst.status === 'unsold') {
      k.textContent = 'YOUR SEAT';
      big.textContent = seat.label;
      line.textContent = '올렸지만 팔리지 않았습니다.';
      sub.textContent = '좌석은 그대로 당신 것입니다.';
    } else if (seat) {
      k.textContent = 'YOUR SEAT';
      big.textContent = seat.label;
      line.textContent = '정가 ' + U.won(face);
      sub.textContent = '';
      // 안 판 학생에게도 시장이 얼마였는지 보여 준다. 판단은 하지 않는다.
      var res = s.room.results;
      if (res && res.avg_price) {
        sub.textContent = '오늘 팔린 좌석의 평균 가격 ' + U.won(res.avg_price);
      }
    } else {
      k.textContent = 'NO SEAT';
      big.textContent = '—';
      line.textContent = '남은 예산 ' + U.won(s.me.balance);
      sub.textContent = '';
    }
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
      if (me.my_seat) { $('#gotSeat').textContent = me.my_seat.label;
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
      if (!me.my_seat) { screen('waitmarket'); return; }
      buildDecideControls();
      $('#decSeat').textContent = me.my_seat.label;
      $('#decFace').textContent = U.won(s.room.face_value);
      var noSeat = (s.room.player_count || 0) - s.seats.length;
      $('#decDemand').textContent = noSeat > 0 ? (noSeat + '명이 좌석이 없습니다.') : '';
      $('#decTime').textContent = U.secs(db.msUntil(s.room.decide_ends_at));
      if (me.my_listing && me.my_listing.status === 'pending') {
        $('#decDone').hidden = false;
        $('#decDone').textContent = '올렸습니다 — 시작가 ' + U.won(me.my_listing.opening_bid);
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
    location.href = location.pathname;
  });

  // -------------------------------------------------------------------
  // 반 찾기 — 학생은 반 코드를 몰라도 된다
  // -------------------------------------------------------------------
  var savedRoom = null;
  try {
    var _prev = JSON.parse(localStorage.getItem('ym.session') || 'null');
    if (_prev && _prev.room_code) savedRoom = _prev.room_code;
  } catch (e) { savedRoom = null; }

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

  async function findRoom() {
    if (booted) return;
    var open = await db.openRooms();
    if (booted) return;

    // 열린 방이 딱 하나이고 이 기기에 다른 반 세션이 없다 — 거의 모든 경우가
    // 여기다. 학생은 아무것도 고르지 않고 바로 참가 화면으로 간다.
    if (open && open.length === 1 && (!savedRoom || savedRoom === open[0])) {
      boot(open[0]);
      return;
    }

    if (open === null) {
      $('#pickLead').textContent = '연결이 안 됩니다. 잠시 뒤 다시 시도합니다.';
      buildManual(); $('#pickMore').open = true;
    } else if (open.length === 0) {
      $('#pickLead').textContent = savedRoom
        ? '입장이 닫혀 있습니다. 하던 수업을 이어서 하세요.'
        : '선생님이 입장을 열면 자동으로 시작됩니다. 이 화면을 그대로 두세요.';
    } else if (open.length === 1) {
      // 이 기기에 다른 반 세션이 남아 있다. 조용히 고르지 않고 물어본다.
      $('#pickLead').textContent = '어느 쪽인가요?';
      offer('#pickGo', open[0], roomLabel(open[0]) + ' 참가하기');
    } else {
      $('#pickLead').textContent = '우리 반을 고르세요';
      buildManual(); $('#pickMore').open = true;
    }

    if (savedRoom) offer('#resumeBtn', savedRoom, roomLabel(savedRoom) + ' — 이어서 하기');

    // 수업 전에 미리 열어 둔 화면이 선생님의 "입장 열기" 를 기다린다.
    tries++;
    setTimeout(findRoom, tries < 20 ? 3000 : 10000);
  }

  if (urlRoom) { boot(urlRoom); }
  else { screen('pick'); findRoom(); }
})();
