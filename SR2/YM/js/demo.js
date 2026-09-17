/* YM — 데모 모드. screen.html?demo=1
 *
 * Supabase 에 한 번도 접속하지 않는다. 미리 만들어 둔 숫자로 전 과정을 재생한다.
 *
 * 왜 필요한가:
 * 교실에서 만날 가장 흔한 고장은 버그가 아니다. 학교 프록시가 https 는
 * 통과시키면서 wss 업그레이드만 막는 경우, 그리고 무료 플랜 프로젝트가
 * 며칠 놀다 잠든 경우다. 둘 다 "RPC 는 되는데 화면만 안 바뀐다" 라는
 * 가장 헷갈리는 모습으로 나타난다.
 *
 * 그날 선생님은 이 주소를 열고, 학생은 손을 들어 투표한다.
 * 숫자는 가짜지만 질문은 진짜이고, 지문으로 넘어가는 다리는 그대로 남는다.
 *
 * 진행: 클릭 / 스페이스 / 오른쪽 화살표 로 다음 장면.
 */
(function () {
  'use strict';

  // 실제 리허설에서 나온 값을 그대로 옮겼다. 그럴듯하게 지어낸 숫자가 아니라
  // 이 활동이 실제로 만들어낸 모양이어야 교사가 설명할 때 걸리지 않는다.
  var FACE = 20000;
  var SEATS = [
    { row: 'J', no: 1, label: 'J1', price: 110000, state: 'sold' },
    { row: 'J', no: 2, label: 'J2', price: 90000,  state: 'sold' },
    { row: 'J', no: 3, label: 'J3', price: 20000,  state: 'kept' },
    { row: 'J', no: 4, label: 'J4', price: 110000, state: 'sold' },
    { row: 'K', no: 1, label: 'K1', price: 90000,  state: 'sold' },
    { row: 'K', no: 2, label: 'K2', price: 20000,  state: 'kept' },
    { row: 'K', no: 3, label: 'K3', price: 20000,  state: 'unsold' },
    { row: 'K', no: 4, label: 'K4', price: 110000, state: 'sold' },
  ];

  var RESULTS = {
    face_value: FACE, players: 20, seat_count: 8,
    listed: 5, sold: 5, unsold: 0,
    avg_price: 102000, max_price: 110000, min_price: 90000,
    received: 410000, no_seat: 12, priced_out: 6, multiple: 5.5,
    seats: SEATS,
    reasons: { need_money: 2, my_seat: 2, wants_more: 1 },
  };

  // 단계별로 방 상태를 통째로 갈아 끼운다.
  var STAGES = [
    { name: '대기실',       room: { phase: 'lobby', player_count: 20 } },
    { name: '예매 (카운트)', room: { phase: 'booking', booking_opens_at: null }, countdown: 5 },
    { name: '예매 (좌석)',   room: { phase: 'booking' }, fillSeats: 0.5 },
    { name: '예매 (매진)',   room: { phase: 'booking' }, fillSeats: 1 },
    { name: '사전 투표',     room: { phase: 'prevote', vote_counts: { pre: { yes: 6, no: 9, unsure: 5 } } } },
    { name: '가질까 팔까',   room: { phase: 'decide' }, pending: 5 },
    { name: '예산 배정',     room: { phase: 'budget' } },
    { name: '경매',          room: { phase: 'auction' }, live: true },
    { name: '사후 투표',     room: { phase: 'results', vote_counts: { pre: { yes: 6, no: 9, unsure: 5 }, post: { yes: 4, no: 12, unsure: 4 } } }, votePhase: true },
    { name: '결과',          room: { phase: 'results' }, results: true },
    { name: '요세미티',      room: { phase: 'yosemite',
      vote_counts: {
        pre: { yes: 6, no: 9, unsure: 5 }, post: { yes: 4, no: 12, unsure: 4 },
        q1_movie:    { yes: 11, no: 6, unsure: 3 },
        q2_campsite: { yes: 3,  no: 14, unsure: 3 },
        q3_upfront:  { yes: 7,  no: 9,  unsure: 4 },
      } } },
  ];

  var idx = 0, onUpdate = null, hint = null;

  function buildRoom(stage) {
    var base = {
      id: 'demo', room_code: 'DEMO', phase: 'lobby', player_count: 20,
      face_value: FACE, seat_count: SEATS.length, dry_run: true,
      vote_counts: {}, results: null,
      booking_opens_at: null, booking_ends_at: null,
      postvote_ends_at: null, finalvote_ends_at: null,
    };
    var r = Object.assign(base, stage.room || {});
    if (stage.countdown) r.booking_opens_at = new Date(Date.now() + stage.countdown * 1000).toISOString();
    if (stage.results || r.phase === 'yosemite') r.results = RESULTS;
    if (stage.votePhase) r.postvote_ends_at = new Date(Date.now() + 45000).toISOString();
    return r;
  }

  function buildSeats(stage) {
    var n = stage.fillSeats === undefined ? (stage.room.phase === 'lobby' ? 0 : SEATS.length)
                                          : Math.round(SEATS.length * stage.fillSeats);
    return SEATS.map(function (s, i) {
      return {
        id: 'seat' + i, room_id: 'demo', row_label: s.row, seat_no: s.no,
        seat_label: s.label, current_owner_id: i < n ? 'p' + i : null,
      };
    });
  }

  function buildListings(stage) {
    if (stage.pending) {
      return SEATS.slice(0, stage.pending).map(function (s, i) {
        return { id: 'l' + i, room_id: 'demo', seat_id: 'seat' + i, seat_label: s.label,
                 opening_bid: 20000 + i * 10000, highest_bid: null, status: 'pending' };
      });
    }
    if (stage.live) {
      var ends = Date.now() + 42000;
      return [
        { id: 'l0', seat_label: 'J1', opening_bid: 30000, highest_bid: 90000,  status: 'open', ends_at: new Date(ends).toISOString() },
        { id: 'l1', seat_label: 'J2', opening_bid: 20000, highest_bid: 70000,  status: 'open', ends_at: new Date(ends + 4000).toISOString() },
        { id: 'l3', seat_label: 'J4', opening_bid: 40000, highest_bid: 110000, status: 'open', ends_at: new Date(ends + 9000).toISOString() },
        { id: 'l4', seat_label: 'K1', opening_bid: 20000, highest_bid: 50000,  status: 'open', ends_at: new Date(ends + 2000).toISOString() },
        { id: 'l6', seat_label: 'K4', opening_bid: 30000, highest_bid: null,   status: 'open', ends_at: new Date(ends + 6000).toISOString() },
      ];
    }
    return [];
  }

  function emit() {
    var st = STAGES[idx];
    if (onUpdate) onUpdate(buildRoom(st), buildSeats(st), buildListings(st));
    if (hint) hint.textContent = (idx + 1) + ' / ' + STAGES.length + ' · ' + st.name + ' — 클릭하면 다음';
  }

  function next(step) {
    idx = Math.min(STAGES.length - 1, Math.max(0, idx + (step || 1)));
    emit();
  }

  YM.demo = {
    start: function (cb) {
      onUpdate = cb;

      hint = document.createElement('div');
      hint.className = 'ym-demohint';
      document.body.appendChild(hint);

      document.addEventListener('click', function (e) {
        if (e.target.closest('#soundBtn')) return;
        next(1);
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === ' ' || e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next(1); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); next(-1); }
      });

      emit();
      // 경매 화면의 카운트다운이 살아 보이게 한 번씩 다시 그린다.
      setInterval(function () { if (STAGES[idx].live) emit(); }, 1000);
    },
  };
})();
