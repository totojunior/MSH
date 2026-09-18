/* YM — 봇. 조종석 탭 안에서 돈다.
 *
 * 이게 있어야 선생님이 혼자 전 과정을 연습할 수 있다. 33명 앞에서
 * 버튼 순서를 처음 눌러 보는 일은 없어야 한다.
 *
 * 정산·1인1좌석·빈 시장 분기처럼 사람 손으로는 만들기 어려운 상황도
 * 이걸로만 확인할 수 있다.
 *
 * 봇은 특권이 없다. 학생과 똑같은 RPC 를, 똑같은 토큰 검사를 거쳐 부른다.
 * 서버 입장에서 봇과 학생은 구별되지 않는다 — is_bot 은 표시용일 뿐이다.
 */
(function () {
  'use strict';

  var db = YM.db;
  var running = false;

  function rnd(a, b) { return a + Math.random() * (b - a); }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function stepFor(cur) { return cur < 50000 ? 10000 : cur < 100000 ? 20000 : 50000; }
  function minBid(l) {
    return (l.highest_bid === null || l.highest_bid === undefined)
      ? l.opening_bid : l.highest_bid + stepFor(l.highest_bid);
  }

  // 봇마다 성격을 조금씩 다르게 준다. 전원이 최소 금액만 올리면
  // 가격이 계단처럼 올라가서 연습용으로는 너무 얌전하다.
  function persona(i) {
    return {
      // 지갑의 몇 %까지 쓸 것인가
      cap: rnd(0.45, 0.95),
      // 최소 인상폭의 몇 배로 지를 것인가
      jump: pick([1, 1, 1, 2, 2, 3]),
      // 얼마나 자주 시도하는가 (ms)
      gap: rnd(1500, 6000),
      // 좌석을 팔 것인가
      sells: Math.random() < 0.55,
      price: 20000 + Math.floor(Math.random() * 4) * 10000,
      reason: pick(['need_money', 'wants_more', 'my_seat', 'free_trade']),
      claimAfter: rnd(300, 2600),
    };
  }

  async function drive(room, bot, p, log) {
    // 서버가 'token' 으로 주던 시절이 있었다. 둘 다 받는다 —
    // 한쪽만 읽다가 인증이 조용히 실패해서 봇이 아무것도 안 하는 일이 있었다.
    var tok = bot.player_token || bot.token;
    var me = function (extra) {
      return Object.assign({ p_room_code: room, p_player: bot.player_id, p_token: tok }, extra || {});
    };
    var claimed = false, decided = false, voted = {};
    var errs = 0;

    while (running) {
      var s;
      try {
        s = await db.rpc('get_my_state', me());
        errs = 0;
      } catch (e) {
        // 조용히 재시도만 하면 "봇이 왜 안 움직이지" 를 영영 모른다.
        // 세 번 연속 실패하면 한 번은 크게 알린다.
        if (++errs === 3 && log) log('봇 오류: ' + (e && e.message || e));
        await sleep(2000);
        continue;
      }
      if (!s || !s.ok) { await sleep(1500); continue; }
      var phase = s.room.phase;

      // 예매 — 열리자마자 달려들지 않고 사람처럼 조금씩 늦게 누른다
      if (phase === 'booking' && !s.me.my_seat && !claimed) {
        var left = db.msUntil(s.room.booking_opens_at);
        if (left > 0) { await sleep(Math.min(left + p.claimAfter, 9000)); continue; }
        var free = s.seats.filter(function (x) { return !x.taken; });
        if (free.length) {
          try {
            var r = await db.rpc('claim_seat', me({ p_seat: pick(free).id }));
            if (r && r.ok) claimed = true;
          } catch (e) {}
        }
        await sleep(rnd(250, 900));
        continue;
      }

      // 투표 — 전원이 같은 쪽을 고르면 연습 화면이 의미가 없다
      var vq = phase === 'prevote' ? 'pre'
             : phase === 'results' ? 'post'
             : phase === 'yosemite' ? (!voted.q1_movie ? 'q1_movie' : !voted.q2_campsite ? 'q2_campsite' : !voted.q3_upfront ? 'q3_upfront' : null)
             : null;
      if (vq && !voted[vq]) {
        voted[vq] = true;
        // 문항마다 기울기를 다르게 준다. 요세미티 3문항이 평평하면
        // 연습할 때 프로젝터 그래프가 어떻게 보일지 알 수 없다.
        var w = vq === 'q2_campsite' ? [0.15, 0.7, 0.15]
              : vq === 'q1_movie'    ? [0.55, 0.3, 0.15]
              : [0.35, 0.45, 0.2];
        var x = Math.random();
        var choice = x < w[0] ? 'yes' : x < w[0] + w[1] ? 'no' : 'unsure';
        try { await db.rpc('cast_vote', me({ p_question: vq, p_choice: choice })); } catch (e) {}
        await sleep(rnd(600, 2500));
        continue;
      }

      // 가질까 팔까
      if (phase === 'decide' && s.me.my_seat && !decided) {
        decided = true;
        await sleep(rnd(1500, 12000));
        try {
          await db.rpc('submit_decision', me({
            p_sell: p.sells,
            p_opening: p.sells ? p.price : null,
            p_reason: p.sells ? p.reason : null,
          }));
        } catch (e) {}
        continue;
      }

      // 경매
      // 좌석이 있어도 입찰한다. 한 사람이 여러 개 사는 것이 이 활동의 요점이고,
      // 봇이 그걸 시도하지 않으면 리허설이 실제 수업과 다른 그림을 보여 준다.
      if (phase === 'auction') {
        var myLeads = s.me.leads || (s.me.leading ? [s.me.leading] : []);
        if (myLeads.length >= 2) { await sleep(p.gap); continue; }
        var open = (s.listings || []).filter(function (l) { return l.status === 'open'; });
        if (!open.length) { await sleep(1500); continue; }
        // 서버가 주는 '더 쓸 수 있는 돈' 을 쓴다. 잔액으로 계산하면 다른 매물에
        // 걸어 둔 돈까지 또 걸려고 해서 전부 거절당한다.
        var avail = (typeof s.me.available === 'number') ? s.me.available : s.me.balance;
        var budget = Math.floor(avail * p.cap);
        var afford = open.filter(function (l) { return minBid(l) <= budget; });
        if (!afford.length) { await sleep(2000); continue; }
        var lot = pick(afford);
        var base = minBid(lot);
        var amt = base;
        for (var j = 1; j < p.jump; j++) { var nx = amt + stepFor(amt); if (nx <= budget) amt = nx; }
        try { await db.rpc('place_bid', me({ p_listing: lot.id, p_amount: amt })); } catch (e) {}
        await sleep(rnd(p.gap * 0.5, p.gap));
        continue;
      }

      await sleep(1800);
    }
  }

  YM.bots = {
    run: function (room, bots, log) {
      // 돌고 있으면 먼저 멈춘다. 방을 초기화하면 이전 봇들의 계정이 사라져서
      // 그 반복문은 인증 실패만 반복하는 좀비가 된다. 예전 판본은 여기서
      // 그냥 return 해 버려서, 초기화 뒤에 봇을 다시 불러도 아무 일도 없었다.
      if (running) {
        running = false;
        // 각 반복문이 현재 await 를 빠져나올 시간을 준다
        setTimeout(function () { YM.bots.run(room, bots, log); }, 2200);
        if (log) log('이전 봇 정리 중…');
        return;
      }
      running = true;
      bots.forEach(function (b, i) { drive(room, b, persona(i), log); });
      if (log) log('봇 ' + bots.length + '명이 움직입니다');
    },
    stop: function () { running = false; },
    isRunning: function () { return running; },
  };
})();
