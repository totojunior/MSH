/* YM — 상태. 진실은 서버에 있고, 이 파일은 그것을 늦지 않게 따라간다.
 *
 * 설계의 핵심 두 가지:
 *
 * 1) 구독을 먼저 붙이고 스냅샷을 나중에 받는다.
 *    반대로 하면 그 사이에 일어난 변화를 영영 놓친다. 먼저 구독해서
 *    들어오는 이벤트를 쌓아 두고, 스냅샷이 도착하면 스냅샷보다 나중 것
 *    (rev 가 더 큰 것)만 다시 적용한다.
 *
 * 2) 웹소켓이 죽어도 수업은 계속된다.
 *    학교 프록시는 https 는 통과시키면서 wss 업그레이드만 막는 경우가
 *    흔하다. 그러면 RPC 는 멀쩡히 되는데 화면만 영영 안 바뀐다 —
 *    교실에서 만날 수 있는 가장 헷갈리는 고장이다. 그래서 5초 안에
 *    구독이 안 붙으면 조용히 폴링으로 갈아탄다.
 */
(function () {
  'use strict';

  var C = YM.CONFIG, db = YM.db;

  function makeStore(roomCode) {
    var listeners = [];
    var snap = null;             // 마지막 get_my_state 결과
    var buffer = [];             // 스냅샷 도착 전에 들어온 실시간 이벤트
    var haveSnap = false;
    var channel = null;
    var pollTimer = null, beatTimer = null, subTimer = null;
    var degraded = false;        // 폴링으로 내려간 상태
    var live = false;            // 웹소켓이 붙어 있나
    var session = null;          // {player_id, player_token}
    var bidFeed = [];            // 프로젝터 티커용 최근 입찰
    var onBid = null;

    function emit() {
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](snap, { live: live, degraded: degraded }); } catch (e) { /* 한 화면의 오류가 전체를 멈추지 않게 */ }
      }
    }

    function subscribe(fn) { listeners.push(fn); if (snap) fn(snap, { live: live, degraded: degraded }); }

    // -----------------------------------------------------------------
    // 스냅샷 — 유일한 진실
    // -----------------------------------------------------------------
    async function refresh() {
      if (!session) return null;
      try {
        var data = await db.rpc('get_my_state', {
          p_room_code: roomCode,
          p_player: session.player_id,
          p_token: session.player_token,
        });
        if (!data || !data.ok) return null;
        snap = data;
        haveSnap = true;

        // 스냅샷보다 나중에 일어난 일만 남겨서 다시 적용한다.
        if (buffer.length) {
          var pending = buffer.filter(function (e) { return (e.rev || 0) > (snap.max_rev || 0); });
          buffer = [];
          if (pending.length) { /* 다음 refresh 가 정본을 가져오므로 신호만 남긴다 */ }
        }
        emit();
        return snap;
      } catch (e) {
        if (e && e.code === '42501') {
          // 토큰이 안 먹는다 — 다른 반의 크롬북을 물려받았거나 방이 지워졌다.
          clearSession();
          emit();
        }
        return null;
      }
    }

    // -----------------------------------------------------------------
    // 실시간
    // -----------------------------------------------------------------
    function attach(roomId) {
      if (channel) return;
      channel = db.sb.channel('ym:room:' + roomId);

      // 공개 3개 테이블의 변화는 "뭔가 바뀌었다"는 신호로만 쓰고,
      // 실제 값은 스냅샷에서 가져온다. 이벤트 본문을 그대로 믿고 화면을
      // 조립하면, 놓친 이벤트 하나에 화면이 영구히 어긋난다.
      ['rooms_public', 'seats', 'listings'].forEach(function (t) {
        channel.on('postgres_changes',
          { event: '*', schema: 'public', table: t, filter: 'room_id=eq.' + roomId },
          function (p) {
            var rev = (p['new'] && p['new'].rev) || 0;
            if (!haveSnap) { buffer.push({ rev: rev }); return; }
            scheduleRefresh();
          });
      });

      // rooms_public 은 room_id 컬럼이 없다. id 로 따로 건다.
      channel.on('postgres_changes',
        { event: '*', schema: 'public', table: 'rooms_public', filter: 'id=eq.' + roomId },
        function () { scheduleRefresh(); });

      // 입찰 티커는 브로드캐스트로 온다 (좌석과 금액만, 닉네임 없음).
      channel.on('broadcast', { event: 'bid' }, function (m) {
        var p = m && m.payload; if (!p) return;
        bidFeed.unshift(p);
        if (bidFeed.length > 24) bidFeed.pop();
        if (onBid) { try { onBid(p); } catch (e) {} }
        scheduleRefresh();
      });

      subTimer = setTimeout(function () { if (!live) degrade('구독 시간 초과'); }, C.SUBSCRIBE_TIMEOUT_MS);

      channel.subscribe(function (status) {
        if (status === 'SUBSCRIBED') {
          live = true;
          clearTimeout(subTimer);
          if (degraded) recover();
          refresh();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          live = false;
          degrade(status);
        }
      });
    }

    // 짧은 시간에 여러 이벤트가 몰려도 스냅샷을 한 번만 다시 받는다.
    // 좌석 13개가 3초 만에 나가면 이벤트가 수십 개 쏟아진다.
    var refreshPending = false;
    function scheduleRefresh() {
      if (refreshPending) return;
      refreshPending = true;
      setTimeout(function () { refreshPending = false; refresh(); }, 120);
    }

    function degrade(why) {
      if (degraded) return;
      degraded = true;
      if (!pollTimer) pollTimer = setInterval(refresh, C.POLL_FALLBACK_MS);
      emit();
    }

    function recover() {
      degraded = false;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      emit();
    }

    // -----------------------------------------------------------------
    // 세션 — 크롬북은 공용일 수 있다
    // -----------------------------------------------------------------
    // 앞 반 학생의 세션이 남아 있는 기기를 다음 반 학생이 집어 들 수 있다.
    // 방 코드가 다르면 조용히 재사용하지 않고 지운다. 남의 반 게임에
    // 학생을 떨어뜨리는 일은 절대 없어야 한다.
    var KEY = 'ym.session';

    function loadSession() {
      try {
        var raw = localStorage.getItem(KEY);
        if (!raw) return null;
        var s = JSON.parse(raw);
        if (!s || s.room_code !== roomCode || !s.player_id || !s.player_token) {
          localStorage.removeItem(KEY);
          return null;
        }
        return s;
      } catch (e) { return null; }
    }

    function saveSession(s) {
      session = s;
      try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* 시크릿 모드 */ }
    }

    function clearSession() {
      session = null;
      try { localStorage.removeItem(KEY); } catch (e) {}
    }

    // -----------------------------------------------------------------
    // 시작
    // -----------------------------------------------------------------
    async function start() {
      await db.syncClock();
      session = loadSession();

      if (session) {
        var ok = await refresh();
        if (!ok) { clearSession(); }
      }
      if (!session) { emit(); return { needJoin: true }; }

      attach(snap.room.id);
      beat();
      wakeHooks();
      return { needJoin: false };
    }

    async function join(nickname) {
      var r = await db.rpc('join_room', {
        p_room_code: roomCode,
        p_nickname: (nickname || '').slice(0, 12),
      });
      if (!r || !r.ok) { return r; }
      saveSession({ room_code: roomCode, player_id: r.player_id, player_token: r.player_token });
      await refresh();
      if (snap) attach(snap.room.id);
      beat();
      wakeHooks();
      return r;
    }

    // 조용해도 10초에 한 번은 진실을 다시 묻는다. 이벤트를 놓쳤거나
    // 웹소켓이 살아 있는 척만 하고 있을 때 스스로 회복하는 경로.
    function beat() {
      if (beatTimer) return;
      beatTimer = setInterval(refresh, C.SNAPSHOT_HEARTBEAT_MS);
    }

    // 노트북을 덮었다 열면 그 사이 세상이 바뀌어 있다. 시계도 틀어진다.
    function wakeHooks() {
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') { db.syncClock().then(refresh); }
      });
      window.addEventListener('online', function () { db.syncClock().then(refresh); });
      window.addEventListener('focus', refresh);
    }

    return {
      subscribe: subscribe,
      refresh: refresh,
      start: start,
      join: join,
      clearSession: clearSession,
      hasSession: function () { return !!session; },
      get: function () { return snap; },
      session: function () { return session; },
      bidFeed: function () { return bidFeed; },
      onBid: function (fn) { onBid = fn; },
      status: function () { return { live: live, degraded: degraded }; },
      // 학생 화면에서 직접 부르는 동작들 — 전부 서버가 판정한다.
      call: function (name, args) {
        var a = Object.assign({
          p_room_code: roomCode,
          p_player: session && session.player_id,
          p_token: session && session.player_token,
        }, args || {});
        return db.rpc(name, a);
      },
    };
  }

  YM.makeStore = makeStore;
})();
