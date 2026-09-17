/* YM — Supabase 연결, 키 검사, RPC 래퍼, 서버 시계 보정
 *
 * window.YM.db 하나만 밖으로 내보낸다.
 */
(function () {
  'use strict';

  var C = YM.CONFIG;

  // -------------------------------------------------------------------
  // 키 검사 — 틀린 키로 조용히 돌아가느니 큰 글씨로 멈추는 편이 낫다
  // -------------------------------------------------------------------
  // 교사가 실수로 service_role / sb_secret_ 키를 붙여넣으면, 앱은 겉보기에
  // 아주 잘 돈다. 그 상태로 배포되면 학생 누구나 데이터베이스를 통째로
  // 조작할 수 있다. 그래서 켜지기 전에 막는다.
  function inspectKey(key, url) {
    if (!key || !url) return { ok: false, why: '설정이 비어 있습니다 (js/config.js).' };
    if (url.indexOf('YOUR-') >= 0 || url.indexOf('example') >= 0) {
      return { ok: false, why: 'js/config.js 의 SUPABASE_URL 이 아직 예시값입니다.' };
    }
    if (key.indexOf('sb_secret_') === 0) {
      return { ok: false, why: '비밀 키(sb_secret_)가 들어 있습니다. 공개 키로 바꾸세요.' };
    }
    if (key.indexOf('sb_publishable_') === 0) return { ok: true, kind: 'publishable' };

    // 레거시 JWT — 가운데 조각을 열어 role 을 확인한다.
    var parts = key.split('.');
    if (parts.length === 3) {
      try {
        var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        var payload = JSON.parse(decodeURIComponent(escape(atob(b64))));
        if (payload.role === 'anon') return { ok: true, kind: 'anon-jwt' };
        return { ok: false, why: '이 키의 role 이 "' + payload.role + '" 입니다. anon 키가 아닙니다.' };
      } catch (e) {
        return { ok: false, why: '키 형식을 읽을 수 없습니다.' };
      }
    }
    return { ok: false, why: '알 수 없는 키 형식입니다.' };
  }

  function fatal(msg) {
    var el = document.createElement('div');
    el.setAttribute('role', 'alert');
    el.style.cssText =
      'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;' +
      'justify-content:center;padding:8vw;background:#0b0b0f;color:#ffd7d7;' +
      'font:600 clamp(16px,2.4vw,24px)/1.6 system-ui,sans-serif;text-align:center;';
    el.textContent = '설정 오류 — ' + msg;
    document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(el); });
    if (document.body) document.body.appendChild(el);
    throw new Error('YM config: ' + msg);
  }

  var check = inspectKey(C.SUPABASE_KEY, C.SUPABASE_URL);
  if (!check.ok) fatal(check.why);
  if (typeof supabase === 'undefined' || !supabase.createClient) {
    fatal('supabase 라이브러리를 불러오지 못했습니다 (js/vendor/supabase.umd.js).');
  }

  var sb = supabase.createClient(C.SUPABASE_URL, C.SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    // 초당 이벤트 상한. 좌석 13개가 20초 안에 다 나가도 충분하고,
    // 폭주했을 때 33대의 크롬북이 같이 버벅이는 것을 막는다.
    realtime: { params: { eventsPerSecond: 10 } },
  });

  // -------------------------------------------------------------------
  // 서버 시계 — 크롬북 시계는 믿을 수 없다
  // -------------------------------------------------------------------
  // 학교 크롬북은 시계가 몇 분씩 어긋나 있는 일이 흔하다. 카운트다운을
  // 각자의 시계로 계산하면 어떤 학생은 이미 열렸고 어떤 학생은 아직이다.
  // 서버 시각을 여러 번 재고, 왕복이 오래 걸린 표본은 버린 뒤 중앙값을 쓴다.
  var clockOffset = 0;      // serverNow - clientNow (ms)
  var clockReady = false;

  function nowMs() { return Date.now() + clockOffset; }

  async function syncClock() {
    var samples = [];
    for (var i = 0; i < C.CLOCK_SAMPLES; i++) {
      var t0 = Date.now();
      var res = await sb.rpc('server_now');
      var t1 = Date.now();
      if (res.error || !res.data) continue;
      var server = new Date(res.data).getTime();
      samples.push({ rtt: t1 - t0, offset: server - (t0 + (t1 - t0) / 2) });
    }
    if (!samples.length) return false;
    samples.sort(function (a, b) { return a.rtt - b.rtt; });
    var keep = samples.slice(0, Math.max(1, samples.length - 2));
    keep.sort(function (a, b) { return a.offset - b.offset; });
    clockOffset = keep[Math.floor(keep.length / 2)].offset;
    clockReady = true;
    return true;
  }

  // 서버가 준 ISO 시각까지 남은 밀리초. 음수면 0.
  function msUntil(iso) {
    if (!iso) return null;
    return Math.max(0, new Date(iso).getTime() - nowMs());
  }

  // -------------------------------------------------------------------
  // RPC 래퍼
  // -------------------------------------------------------------------
  // 규칙 위반(잔액 부족, 이미 팔림 등)은 재시도하지 않는다. 다시 불러 봐야
  // 같은 답이고, 경매 중에 같은 요청을 두 번 보내는 쪽이 더 위험하다.
  // 네트워크가 끊겨서 실패한 경우에만 딱 한 번 다시 시도한다.
  async function rpc(name, args) {
    var attempt = 0;
    for (;;) {
      var res;
      try {
        res = await sb.rpc(name, args || {});
      } catch (e) {
        res = { error: { message: String(e && e.message || e), __network: true } };
      }
      if (!res.error) return res.data;

      var msg = String(res.error.message || '');
      var networky = res.error.__network ||
        /fetch|network|timeout|failed to fetch|load failed/i.test(msg);

      if (networky && attempt === 0) {
        attempt++;
        await new Promise(function (r) { setTimeout(r, 400); });
        continue;
      }
      var err = new Error(msg);
      err.code = res.error.code;
      err.rpc = name;
      throw err;
    }
  }

  // -------------------------------------------------------------------
  // 서버가 돌려주는 오류 코드 -> 학생이 읽을 한국어
  // -------------------------------------------------------------------
  // 단정적인 실패 언어를 쓰지 않는다. 좌석을 못 잡은 학생에게 빨간 글씨로
  // 실패를 선언하면, 그 학생은 남은 20분 내내 그 문장을 보고 앉아 있게 된다.
  var MESSAGES = {
    NO_ROOM:                '방을 찾을 수 없습니다. 주소를 다시 확인해 주세요.',
    JOIN_CLOSED:            '입장이 마감되었습니다. 선생님께 말씀해 주세요.',
    ROOM_FULL:              '이 방은 정원이 찼습니다.',
    BAD_NICK:               '그 별명은 쓸 수 없습니다. 다른 별명으로 해 주세요.',
    NOT_OPEN:               '아직 열리지 않았습니다.',
    CLOSED:                 '시간이 끝났습니다.',
    TOO_EARLY:              '아직 예매 시작 전입니다.',
    COOLDOWN:               '잠깐만요. 연속으로 누르면 오히려 느려집니다.',
    TAKEN:                  '앗! 누군가 먼저 잡았습니다.',
    ALREADY_HAVE_SEAT:      '이미 좌석이 있습니다. 한 사람에 한 자리입니다.',
    NO_SEAT:                '좌석이 없어 선택할 것이 없습니다.',
    BAD_PRICE:              '시작가를 다시 골라 주세요.',
    BAD_REASON:             '이유를 하나 골라 주세요.',
    HAVE_SEAT:              '좌석을 가진 사람은 입찰하지 않습니다. 한 사람에 한 자리입니다.',
    NO_LISTING:             '그 매물을 찾을 수 없습니다.',
    LISTING_CLOSED:         '그 좌석은 마감되었습니다.',
    OWN_LISTING:            '자기 좌석에는 입찰할 수 없습니다.',
    ALREADY_LEADING_THIS:   '이미 이 좌석의 최고 입찰자입니다.',
    ALREADY_LEADING_ANOTHER:'다른 좌석에서 최고 입찰 중입니다. 그 결과가 정해질 때까지 기다려 주세요.',
    TOO_LOW:                '최소 입찰가보다 낮습니다.',
    NO_MONEY:               '가진 금액을 넘는 입찰은 할 수 없습니다.',
    CHANGED:                '그 사이에 값이 바뀌었습니다. 새 금액으로 다시 해 주세요.',
    BAD_VOTE:               '투표를 처리하지 못했습니다.',
    TOO_FEW:                '참가자가 너무 적습니다.',
    BAD_COUNT:              '숫자를 다시 확인해 주세요.',
    BAD_PHASE:              '단계를 바꿀 수 없습니다.',
    NO_PLAYERS:             '참가자가 없습니다.',
  };

  function say(code) { return MESSAGES[code] || '처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'; }

  // -------------------------------------------------------------------
  // 새 버전 자동 감지 — 캐시된 HTML 때문에 고친 코드가 안 가는 것을 막는다
  // -------------------------------------------------------------------
  // GitHub Pages 는 index.html 에 Cache-Control: max-age=600 을 붙인다.
  // js/css 에 ?v= 를 달아도, 그 태그를 '들고 있는 HTML' 자체가 10분간
  // 캐시되면 새 주소가 학생 기기에 영영 도달하지 않는다.
  // 수업 직전에 뭘 고쳤을 때 이게 제일 위험하다 — 교사 기기에서는 우연히
  // 새 걸 받아 잘 되는데 크롬북 33대는 옛 코드를 쓴다.
  //
  // 그래서 페이지가 스스로 확인한다. version.json 은 타임스탬프를 붙여
  // 항상 새로 받고, 페이지가 들고 있는 버전과 다르면 딱 한 번 새로고침한다.
  (function checkVersion() {
    var tag = document.querySelector('script[src*="client.js"]');
    var here = tag ? (tag.getAttribute('src').split('?v=')[1] || '') : '';
    if (!here) return;
    fetch('version.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (v) {
        var latest = v && v.asset_version;
        if (!latest || latest === here) return;
        // 새로고침 고리에 빠지지 않게, 같은 버전으로는 한 번만 시도한다.
        var key = 'ym.reloaded.' + latest;
        try {
          if (sessionStorage.getItem(key)) return;
          sessionStorage.setItem(key, '1');
        } catch (e) { return; }
        location.reload();
      })
      .catch(function () { /* 확인 못 해도 수업은 계속된다 */ });
  })();

  YM.db = {
    sb: sb,
    rpc: rpc,
    say: say,
    keyKind: check.kind,
    nowMs: nowMs,
    msUntil: msUntil,
    syncClock: syncClock,
    isClockReady: function () { return clockReady; },
  };
})();
