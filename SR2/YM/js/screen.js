/* YM — 프로젝터. 읽기 전용.
 *
 * 토큰이 없다. 공개 테이블 세 개(rooms_public / seats / listings)만 직접 읽는다.
 * 지갑도, 투표한 사람도, 관리자 토큰도 이 화면에서는 애초에 읽을 수가 없다 —
 * 실수로 흘릴 여지를 코드가 아니라 권한으로 없앴다.
 *
 * ?demo=1 을 붙이면 Supabase 없이 미리 만들어 둔 숫자로 전 과정을 보여 준다.
 * 학교 프록시가 wss 를 막거나 인터넷이 죽은 날, 수업을 그대로 진행하기 위한 길이다.
 */
(function () {
  'use strict';

  var U = YM.ui, C = YM.CONFIG, db = YM.db;
  var $ = U.$, el = U.el;

  var params = new URLSearchParams(location.search);
  // 기본 반을 두지 않는다. 주소에 없으면 지금 입장이 열린 방을 찾아간다.
  // 그래야 교사가 매 교시 주소를 고쳐 쓰지 않는다 — 고쳐 쓰다 빠뜨리면
  // TV에 앞 반 데이터가 그대로 뜬다.
  var urlRoom = (params.get('room') || '').trim().toUpperCase();
  var ROOM = urlRoom;
  var DEMO = params.get('demo') === '1';

  var room = null, seats = [], listings = [], shown = null;
  var hotSeat = null, hotUntil = 0;
  var yoStarted = false;
  var yoGen = null;           // 어느 '판'의 연출을 틀었는지
  var yoTimers = [];

  function show(p) {
    if (shown === p) return;
    shown = p;
    document.querySelectorAll('[data-p]').forEach(function (n) {
      n.hidden = n.getAttribute('data-p') !== p;
    });
  }

  // -------------------------------------------------------------------
  // 소리 — 교실 스피커 하나만 울린다
  // -------------------------------------------------------------------
  // 학생 기기는 전부 조용하다. 크롬북 33대가 동시에 울리면 수업이 안 된다.
  // 자동재생은 브라우저가 막으므로 수업 전에 한 번 눌러 둬야 한다.
  $('#soundBtn').addEventListener('click', function () {
    if (U.isMuted()) { U.soundEnable(); this.textContent = '🔊 소리 켜짐'; U.SFX.tick(); }
    else { U.soundMuted(true); this.textContent = '🔇 소리 켜기'; }
  });

  // 교탁에서 무엇을 클릭하든 그 첫 클릭으로 소리를 켠다.
  //
  // '사람이 한 번 눌러야 난다' 는 규칙은 그대로다 — 누르는 대상이 작은
  // 소리 버튼일 필요가 없을 뿐이다. 수업 전에 그 버튼을 못 찾거나 잊으면
  // 카운트다운과 입찰음이 통째로 사라지고, 교사는 수업이 끝날 때까지
  // 그 사실을 모른다. 되돌리는 것은 같은 버튼을 한 번 더 누르는 것이다.
  document.addEventListener('pointerdown', function () {
    if (!U.isMuted()) return;
    if (U.soundEnable()) $('#soundBtn').textContent = '🔊 소리 켜짐';
  }, { passive: true });

  // -------------------------------------------------------------------
  // 데이터 — 공개 테이블만
  // -------------------------------------------------------------------
  var pullFails = 0;

  function fatalScreen(msg, detail) {
    var host = document.querySelector('[data-p="lobby"]');
    if (!host) return;
    U.clear(host);
    host.appendChild(el('p', 'ym-pkick', 'CANNOT OPEN'));
    host.appendChild(el('h1', 'ym-pq', msg));
    host.appendChild(el('p', 'ym-plead', detail));
    host.appendChild(el('p', 'ym-pnote', '주소의 room= 값을 확인하거나, 조종석에서 방 기한을 연장하세요.'));
    show('lobby');
  }

  async function pull() {
    if (DEMO) return;
    try {
      var r1 = await db.sb.from('rooms_public').select('*').eq('room_code', ROOM).maybeSingle();
      // 방이 없는데 대기 화면을 그대로 띄우면, 교사는 '아무도 안 들어오네'
      // 하고 서 있게 된다. 반 코드 오타든 만료든 화면이 말해 줘야 한다.
      if (r1.error || !r1.data) {
        if (++pullFails >= 3) {
          fatalScreen(ROOM + ' 방을 찾을 수 없습니다',
            r1.error ? '데이터베이스에 연결하지 못했습니다.' : '이 반 코드의 방이 없거나 기한이 지났습니다.');
        }
        return;
      }
      pullFails = 0;
      room = r1.data;
      var r2 = await db.sb.from('seats').select('*').eq('room_id', room.id);
      seats = r2.data || [];
      var r3 = await db.sb.from('listings').select('*').eq('room_id', room.id);
      listings = r3.data || [];
      render();
      // 프로젝터도 정산 재촉자 중 하나다. 교사 브라우저 하나에 기대지 않는다.
      if (room.phase === 'auction') {
        db.rpc('settle_expired_listings', { p_room_code: ROOM }).catch(function () {});
      }
    } catch (e) { /* 다음 주기에 다시 시도한다 */ }
  }

  function attach() {
    if (DEMO || !room) return;
    var ch = db.sb.channel('ym:room:' + room.id);
    ['seats', 'listings'].forEach(function (t) {
      ch.on('postgres_changes', { event: '*', schema: 'public', table: t, filter: 'room_id=eq.' + room.id }, pull);
    });
    ch.on('postgres_changes', { event: '*', schema: 'public', table: 'rooms_public', filter: 'id=eq.' + room.id }, pull);
    // 입찰 티커는 브로드캐스트로. 좌석과 금액만 오고 닉네임은 오지 않는다.
    ch.on('broadcast', { event: 'bid' }, function (m) {
      var p = m && m.payload; if (!p) return;
      hotSeat = { label: p.seat_label, amount: p.amount };
      hotUntil = Date.now() + 6000;
      U.SFX.bid();
      if (p.extended) {
        var e = $('#ext'); e.hidden = false; U.SFX.extend();
        setTimeout(function () { e.hidden = true; }, 1600);
      }
      paintAuction();
    });
    ch.subscribe();
  }

  // -------------------------------------------------------------------
  // 각 화면
  // -------------------------------------------------------------------
  function paintLobby() {
    $('#lobbyN').textContent = room.player_count || 0;
    // 방을 스스로 찾아온 경우엔 학생에게도 짧은 주소를 준다. 학생 화면도
    // 같은 방식으로 열린 방을 찾아가므로 room= 을 적어 줄 필요가 없다.
    var base = location.href.replace(/screen\.html.*$/, '');
    var url = urlRoom ? (base + '?room=' + ROOM) : base;
    $('#joinUrl').textContent = url.replace(/^https?:\/\//, '');
    var box = $('#qr');
    if (box.dataset.url !== url && window.qrcode) {
      var q = window.qrcode(0, 'M'); q.addData(url); q.make();
      box.innerHTML = '';                                  // 라이브러리 생성 SVG (사용자 입력 아님)
      box.insertAdjacentHTML('afterbegin', q.createSvgTag({ cellSize: 6, margin: 2, scalable: true }));
      box.dataset.url = url;
    }
    show('lobby');
  }

  function paintMap() {
    var host = $('#pmap');
    var sig = seats.map(function (s) { return s.id; }).join(',');
    if (host.dataset.sig !== sig) {
      U.clear(host);
      var rows = {};
      seats.forEach(function (s) { (rows[s.row_label] = rows[s.row_label] || []).push(s); });
      Object.keys(rows).sort().forEach(function (k) {
        var r = el('div', 'ym-prow');
        rows[k].sort(function (a, b) { return a.seat_no - b.seat_no; }).forEach(function (s) {
          var c = el('div', 'ym-pseat', s.seat_label);
          c.dataset.id = s.id;
          r.appendChild(c);
        });
        host.appendChild(r);
      });
      host.dataset.sig = sig;
    }
    var taken = 0;
    seats.forEach(function (s) {
      var c = host.querySelector('[data-id="' + s.id + '"]'); if (!c) return;
      if (s.current_owner_id) {
        taken++;
        if (!c.classList.contains('is-taken')) { c.classList.add('is-taken', 'is-pop'); setTimeout(function () { c.classList.remove('is-pop'); }, 500); }
      }
    });
    $('#claimed').textContent = taken;
    $('#total').textContent = seats.length;
    $('#soldout').hidden = !(seats.length && taken >= seats.length);
  }

  var VQ = {
    pre:         ['BEFORE WE START', '좌석을 되파는 것을 허용해야 할까요?'],
    post:        ['WAS THIS FAIR?',  '방금 일어난 일은 공정했나요?'],
  };

  function paintVote(key) {
    var d = VQ[key];
    $('#vKick').textContent = d[0];
    $('#vQ').textContent = d[1];
    var c = (room.vote_counts || {})[key] || {};
    var y = c.yes || 0, n = c.no || 0, u = c.unsure || 0, t = y + n + u;
    var host = $('#vBars'); U.clear(host);
    [['YES', y, '그렇다'], ['NO', n, '아니다'], ['NOT SURE', u, '모르겠다']].forEach(function (row) {
      var pct = t ? Math.round(row[1] / t * 100) : 0;
      var b = el('div', 'ym-bar');
      var lab = el('div', 'ym-bar__lab');
      lab.appendChild(el('span', 'ym-bar__en', row[0]));
      lab.appendChild(el('span', 'ym-bar__ko', row[2]));
      b.appendChild(lab);
      var track = el('div', 'ym-bar__track');
      var fill = el('div', 'ym-bar__fill'); fill.style.width = pct + '%';
      track.appendChild(fill);
      b.appendChild(track);
      // 퍼센트와 사람 수를 함께 쓴다. 막대 길이만으로는 뒷자리에서 안 읽힌다.
      b.appendChild(el('div', 'ym-bar__pct', pct + '% · ' + row[1] + '명'));
      host.appendChild(b);
    });
    $('#vCount').textContent = t + ' / ' + (room.player_count || 0) + ' 투표함';
    show('vote');
  }

  function paintDecide() {
    var owned = seats.filter(function (s) { return s.current_owner_id; }).length;
    var sell = listings.filter(function (l) { return l.status === 'pending'; }).length;
    $('#dOwn').textContent = owned;
    $('#dSell').textContent = sell;
    $('#dNone').textContent = Math.max(0, (room.player_count || 0) - owned);
    show('decide');
  }

  function paintAuction() {
    var open = listings.filter(function (l) { return l.status === 'open'; });
    $('#pEmpty').hidden = open.length > 0;

    // 방금 입찰이 들어온 매물을 크게. 교실 전체가 같은 곳을 보는 순간을 만든다.
    var hot = null;
    if (hotSeat && Date.now() < hotUntil) {
      hot = open.filter(function (l) { return l.seat_label === hotSeat.label; })[0];
    }
    if (!hot) {
      hot = open.slice().sort(function (a, b) { return (b.highest_bid || 0) - (a.highest_bid || 0); })[0];
    }
    if (hot) {
      $('#spot').hidden = false;
      $('#spotSeat').textContent = hot.seat_label;
      $('#spotPrice').textContent = U.won(hot.highest_bid || hot.opening_bid);
      $('#spotTime').textContent = U.secs(db.msUntil(hot.ends_at));
    } else { $('#spot').hidden = true; }

    var host = $('#plots'); U.clear(host);
    open.sort(function (a, b) { return a.seat_label < b.seat_label ? -1 : 1; }).forEach(function (l) {
      var c = el('div', 'ym-plot' + (hot && l.id === hot.id ? ' is-hot' : ''));
      c.appendChild(el('span', 'ym-plot__s', l.seat_label));
      c.appendChild(el('span', 'ym-plot__p', U.won(l.highest_bid || l.opening_bid)));
      c.appendChild(el('span', 'ym-plot__t', U.secs(db.msUntil(l.ends_at))));
      host.appendChild(c);
    });
    show('auction');
  }

  // 색과 숫자를 함께 쓴다. 색만으로 가격을 읽게 하지 않는다.
  function heatClass(price, face, max) {
    if (price <= face) return 'h0';
    var t = (price - face) / Math.max(1, max - face);
    return t < 0.25 ? 'h1' : t < 0.5 ? 'h2' : t < 0.75 ? 'h3' : 'h4';
  }

  var REASON_KO = {
    need_money: '돈이 필요해서', wants_more: '나보다 더 원하는 사람이 있으니까',
    my_seat: '내 좌석이니까 내 마음', free_trade: '자유로운 거래인데 뭐가 문제죠',
  };

  // 좌석 한 칸을 소리 내 읽으면 이렇게 된다. 칸 안에서는 자리가 없어
  // 낙찰자 별명은 공개 결과에 없다 — 학생이 읽는 표에 넣으면 'UUID -> 별명'
  // 사전이 만들어져서 판 사람까지 특정된다. 교탁 TV(tv.html)는 교사 토큰으로
  // 원본을 받아 YM.tvBuyers 에 좌석->별명 지도를 놓아 준다. 토큰이 없는
  // screen.html 에서는 이 지도가 비어 있고, 칸에 이름이 그려지지 않는다.
  function buyerOf(s) {
    if (s.buyer) return s.buyer;
    var m = YM.tvBuyers;
    return (m && m[s.label]) || null;
  }

  // 별명이 두 줄로 잘리므로, 온전한 문장은 여기에 남긴다.
  function cellAria(s) {
    if (s.state === 'sold') {
      return s.label + ' 좌석, ' + U.won(s.price) + ' 에 팔림'
           + (buyerOf(s) ? (', 낙찰자 ' + buyerOf(s)) : '');
    }
    if (s.state === 'unsold') return s.label + ' 좌석, 올렸지만 팔리지 않음';
    return s.label + ' 좌석, 팔지 않음, 정가 ' + U.won(s.price);
  }

  function paintResults() {
    var r = room.results;
    if (!r) { show('budget'); return; }
    var face = r.face_value, max = r.max_price || face;

    var host = $('#heat'); U.clear(host);
    var rows = {};
    (r.seats || []).forEach(function (s) { (rows[s.row] = rows[s.row] || []).push(s); });
    Object.keys(rows).sort().forEach(function (k) {
      var rowEl = el('div', 'ym-hrow');
      rows[k].sort(function (a, b) { return a.no - b.no; }).forEach(function (s) {
        var c = el('div', 'ym-hcell is-' + heatClass(s.price, face, max));
        c.appendChild(el('span', 'ym-hcell__l', s.label));
        c.appendChild(el('span', 'ym-hcell__p', U.wonShort(s.price)));
        // 낙찰자 별명. '산 사람' 만 적는다 — 판 사람 이름을 같이 띄우면
        // 익명으로 설계한 '왜 팔았나' 벽에서 그 사람이 특정되고, 교실에
        // 남는 것은 제도에 대한 질문이 아니라 한 학생에 대한 비난이 된다.
        // 같은 별명이 두 칸에 나오는 것이 이 수업이 보여 주려는 그림이다.
        if (s.state === 'sold' && buyerOf(s)) {
          c.appendChild(el('span', 'ym-hcell__w', buyerOf(s)));
        } else if (s.state === 'unsold') {
          c.appendChild(el('span', 'ym-hcell__n', 'UNSOLD'));
        } else if (s.state === 'kept') {
          c.appendChild(el('span', 'ym-hcell__n is-ko', '안 팔았음'));
        }
        c.setAttribute('aria-label', cellAria(s));
        rowEl.appendChild(c);
      });
      host.appendChild(rowEl);
    });

    // 칸 안의 이름이 무엇인지, 그리고 좌석이 몇 명에게 갔는지.
    // 이름만 크게 뜨면 논점이 제도에서 사람으로 옮겨간다 — 예산이 추첨이었다는
    // 사실을 늘 같이 둔다. 두 문장을 두 줄로 쌓지 않는 이유는 세로 공간이다:
    // 1024x768 에서 한 줄을 늘리면 아래 통계 칸과 이유 벽이 잘려 나간다.
    // 낙찰자가 하나도 없으면(옛 결과 페이로드) 앞 문장은 띄우지 않는다.
    var anyBuyer = (r.seats || []).some(function (s) { return s.state === 'sold' && buyerOf(s); });
    if (anyBuyer || r.holders) {
      var note = el('p', 'ym-heatnote');
      if (anyBuyer) {
        note.appendChild(el('span', null,
          '칸 안의 이름은 그 좌석을 낙찰받은 사람입니다 · 예산은 추첨으로 정해졌습니다'));
      }
      // 13석이 9명에게 갔다 — 이 한 줄이 다석 허용의 논점 전부다.
      if (r.holders) {
        var sweep = '좌석 ' + r.seat_count + '개가 ' + r.holders + '명에게 갔습니다';
        if (r.max_seats_one_buyer > 1) sweep += ' — 한 사람이 최대 ' + r.max_seats_one_buyer + '개';
        note.appendChild(el('span', 'ym-heatnote__hot', sweep));
      }
      host.appendChild(note);
    }

    $('#rSold').textContent = r.sold + ' / ' + r.seat_count;
    $('#rRecv').textContent = U.won(r.received);
    $('#rNone').textContent = r.no_seat + '명';
    $('#rPriced').textContent = r.priced_out + '명';
    $('#rPricedNote').textContent = r.min_price
      ? '가진 돈 전부로도 가장 싸게 팔린 ' + U.won(r.min_price) + ' 좌석조차 살 수 없었음'
      : '되팔린 좌석이 없었습니다';

    var rh = $('#rReasons'); U.clear(rh);
    var reasons = r.reasons || {};
    Object.keys(reasons).forEach(function (k) {
      var t = el('span', 'ym-rchip');
      t.appendChild(el('span', 'ym-rchip__n', reasons[k]));
      t.appendChild(el('span', null, REASON_KO[k] || k));
      rh.appendChild(t);
    });
    show('results');
  }

  // -------------------------------------------------------------------
  // P5 — 요세미티
  // -------------------------------------------------------------------
  // 지문의 논증을 미리 풀어 주지 않는다. 숫자 세 개와 질문 두 개만 남기고
  // 나머지는 학생이 곧 읽을 글에 맡긴다.
  function yosemiteScript(r) {
    var mult = (r && r.multiple) || null;
    var maxp = (r && r.max_price) || null;
    return [
      { t: 0,     kind: 'line',  text: 'WHAT IF IT WASN’T' },
      { t: 1400,  kind: 'line',  text: 'A MOVIE TICKET?' },
      { t: 4200,  kind: 'scene' },
      { t: 7200,  kind: 'title', text: 'YOSEMITE NATIONAL PARK' },
      { t: 10000, kind: 'nums',  items: [['900', '예약 가능한 야영지'], ['$20', '1박 정가'], ['$100–150', '2011년 되팔린 값']] },
      { t: 16000, kind: 'bridge', ours: maxp, mult: mult },
      { t: 22000, kind: 'q',     text: 'IS PAYING MORE', text2: 'THE SAME AS WANTING MORE?',
        ko: '더 내는 것과 더 원하는 것은 같은 걸까요?' },
      { t: 28000, kind: 'q',     text: 'IS NOTHING SACRED?', ko: '팔아서는 안 되는 것이 있을까요?' },
      { t: 34000, kind: 'vote' },
    ];
  }

  var YO_VOTE = [
    ['q1_movie',    '1 / 3', '영화표를 되파는 것'],
    ['q2_campsite', '2 / 3', '국립공원 야영지 예약을 되파는 것'],
    ['q3_upfront',  '3 / 3', '영화관이 처음부터 ₩150,000에 파는 것'],
  ];

  function paintYosemite() {
    show('yosemite');
    var host = $('#yo');

    // 반이 바뀌면(초기화로 generation 이 오르면) 연출을 처음부터 다시 튼다.
    // 예전에는 이 플래그가 탭 안에 그대로 남아서, 교탁 PC 를 종일 켜 두는
    // 2반·3반은 요세미티 연출을 아예 못 봤다 — 수업의 마지막 장면인데.
    if (yoStarted && yoGen !== room.generation) resetYosemite();

    if (!yoStarted) {
      yoStarted = true;
      yoGen = room.generation;
      host.dataset.built = '';
      var script = yosemiteScript(room.results);
      script.forEach(function (beat) {
        yoTimers.push(setTimeout(function () { drawBeat(host, beat); }, beat.t));
      });
    }
    // 투표 막대는 계속 갱신된다
    if (host.dataset.mode === 'vote') drawYoVote(host);
  }

  function resetYosemite() {
    yoTimers.forEach(clearTimeout);
    yoTimers = [];
    yoStarted = false;
    yoGen = null;
    var host = $('#yo');
    if (host) { U.clear(host); host.dataset.mode = ''; host.dataset.built = ''; }
  }

  function drawBeat(host, b) {
    if (b.kind === 'vote') { host.dataset.mode = 'vote'; drawYoVote(host); return; }
    host.dataset.mode = b.kind;
    U.clear(host);

    if (b.kind === 'line')  { host.appendChild(el('p', 'ym-yoline', b.text)); }

    if (b.kind === 'scene') {
      // 저작권 걱정 없는 실루엣. 오프라인에서도 그대로 뜬다.
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 200 100');
      svg.setAttribute('class', 'ym-yosvg');
      svg.innerHTML =
        '<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" stop-color="#16233d"/><stop offset="1" stop-color="#3a4a63"/></linearGradient></defs>' +
        '<rect width="200" height="100" fill="url(#sky)"/>' +
        '<circle cx="158" cy="26" r="7" fill="#f2e6c8" opacity=".85"/>' +
        '<path d="M0 84 L26 52 L44 66 L60 44 L78 70 L96 58 L112 78 L200 78 L200 100 L0 100 Z" fill="#0d1526"/>' +
        '<path d="M96 78 C104 48 120 34 134 34 C146 34 152 46 152 78 Z" fill="#17203a"/>' +
        '<path d="M0 88 L200 88 L200 100 L0 100 Z" fill="#070b14"/>';
      host.appendChild(svg);
    }

    if (b.kind === 'title') { host.appendChild(el('p', 'ym-yotitle', b.text)); }

    if (b.kind === 'nums') {
      var wrap = el('div', 'ym-yonums');
      b.items.forEach(function (it) {
        var d = el('div', 'ym-yonum');
        d.appendChild(el('span', 'ym-yonum__v', it[0]));
        d.appendChild(el('span', 'ym-yonum__k', it[1]));
        wrap.appendChild(d);
      });
      host.appendChild(wrap);
    }

    if (b.kind === 'bridge') {
      var w = el('div', 'ym-yobridge');
      var a = el('div', 'ym-yoside');
      a.appendChild(el('p', 'ym-yoside__h', '우리 교실'));
      a.appendChild(el('p', 'ym-yoside__v', b.ours ? U.won(b.ours) : '—'));
      a.appendChild(el('p', 'ym-yoside__k', b.mult ? '정가의 ' + b.mult + '배' : ''));
      var c = el('div', 'ym-yoside');
      c.appendChild(el('p', 'ym-yoside__h', 'YOSEMITE'));
      c.appendChild(el('p', 'ym-yoside__v', '$100–150'));
      c.appendChild(el('p', 'ym-yoside__k', '정가의 5–7.5배'));
      w.appendChild(a); w.appendChild(c);
      host.appendChild(w);
    }

    if (b.kind === 'q') {
      var q = el('div', 'ym-yoq');
      q.appendChild(el('p', 'ym-yoq__en', b.text));
      if (b.text2) q.appendChild(el('p', 'ym-yoq__en', b.text2));
      q.appendChild(el('p', 'ym-yoq__ko', b.ko));
      host.appendChild(q);
    }
  }

  // 세 문항의 막대가 서로 다른 기울기로 서는 것 자체가 지문의 두 번째 반론이다.
  // 사이트가 "어떤 것은 팔면 안 된다"고 말하지 않고, 교실이 그렇게 답하게 둔다.
  function drawYoVote(host) {
    if (host.dataset.built !== '1') {
      U.clear(host);
      host.appendChild(el('p', 'ym-yoq__ko', '되팔아도 괜찮을까요?'));
      var wrap = el('div', 'ym-yovote'); wrap.id = 'yoVote';
      host.appendChild(wrap);
      host.dataset.built = '1';
    }
    var wrap = $('#yoVote'); U.clear(wrap);
    YO_VOTE.forEach(function (q) {
      var c = (room.vote_counts || {})[q[0]] || {};
      var y = c.yes || 0, n = c.no || 0, u = c.unsure || 0, t = y + n + u;
      var box = el('div', 'ym-yov');
      box.appendChild(el('p', 'ym-yov__n', q[1]));
      box.appendChild(el('p', 'ym-yov__q', q[2]));
      var bar = el('div', 'ym-yov__bar');
      [['yes', y], ['no', n], ['unsure', u]].forEach(function (p) {
        var seg = el('div', 'ym-yov__seg is-' + p[0]);
        seg.style.width = (t ? p[1] / t * 100 : 0) + '%';
        bar.appendChild(seg);
      });
      box.appendChild(bar);
      box.appendChild(el('p', 'ym-yov__num',
        t ? ('괜찮다 ' + y + ' · 안 된다 ' + n + ' · 모름 ' + u) : '아직 투표 없음'));
      wrap.appendChild(box);
    });
  }

  // -------------------------------------------------------------------
  // 라우팅
  // -------------------------------------------------------------------
  function render() {
    if (!room) return;
    $('#dryBadge').hidden = !room.dry_run;
    var p = room.phase;

    if (p === 'lobby')   return paintLobby();
    if (p === 'booking') {
      var left = db.msUntil(room.booking_opens_at);
      if (left !== null && left > 0) {
        var n = Math.ceil(left / 1000);
        if ($('#cd').textContent !== String(n)) { $('#cd').textContent = String(n); U.SFX.tick(); }
        return show('countdown');
      }
      // 0 이 되는 순간 딱 한 번. shown 이 아직 countdown 이라는 것이
      // '방금 넘어왔다' 는 뜻이다.
      if (shown === 'countdown') U.SFX.go();
      return (paintMap(), show('booking'));
    }
    if (p === 'prevote')  return paintVote('pre');
    if (p === 'decide')   return paintDecide();
    if (p === 'budget')   return show('budget');
    if (p === 'auction')  return paintAuction();
    if (p === 'results')  {
      if (shown === 'auction') U.SFX.close();
      // 투표를 먼저 받고, 통계는 그다음에 연다. 순서를 뒤집으면 숫자가 표를 끌고 간다.
      var vc = (room.vote_counts || {}).post || {};
      var voted = (vc.yes || 0) + (vc.no || 0) + (vc.unsure || 0);
      var due = db.msUntil(room.postvote_ends_at);
      if (voted < (room.player_count || 0) && due > 0) return paintVote('post');
      return paintResults();
    }
    if (p === 'yosemite') return paintYosemite();

    // 다른 단계로 돌아왔다 = 다음 반이 시작됐다. 연출을 되감아 둔다.
    if (yoStarted) resetYosemite();
    show('lobby');
  }

  // 초 단위 표시는 스스로 센다. 마감 시각은 이미 알고 있다.
  setInterval(function () {
    if (!room) return;
    if (shown === 'countdown' || shown === 'auction' || shown === 'vote') render();
    if (shown === 'auction') paintAuction();
  }, 500);

  // -------------------------------------------------------------------
  // 시작
  // -------------------------------------------------------------------
  // 방을 기다리는 동안 덮는 막. lobby 패널을 지우지 않는다 — 거기엔
  // QR과 접속 주소가 들어 있고, 한 번 지우면 다시 만들어 주지 않는다.
  function waitBanner(msg, sub) {
    var b = document.getElementById('ymWait');
    if (!b) { b = el('div', 'ym-pwait'); b.id = 'ymWait'; document.body.appendChild(b); }
    U.clear(b);
    b.appendChild(el('p', 'ym-pkick', 'YONGSAN IMAX'));
    b.appendChild(el('h1', 'ym-pq', msg));
    b.appendChild(el('p', 'ym-plead', sub));
  }

  function waitDone() {
    var b = document.getElementById('ymWait');
    if (b && b.parentNode) b.parentNode.removeChild(b);
  }

  function startFor(code) {
    ROOM = code;
    waitDone();
    db.syncClock().then(function () {
      return pull();
    }).then(function () {
      attach();
      setInterval(pull, 2500);
    });
  }

  var findTries = 0;

  async function findRoom() {
    var open = await db.openRooms();
    if (open && open.length === 1) { startFor(open[0]); return; }

    if (open === null) {
      waitBanner('연결을 기다리는 중', '학교 인터넷이 막고 있다면 조종석에도 같은 증상이 납니다.');
    } else if (open.length === 0) {
      waitBanner('수업을 기다리는 중', '조종석에서 「입장 열기」를 누르면 이 화면이 저절로 시작됩니다.');
    } else {
      waitBanner('열린 반이 ' + open.length + '개입니다',
                 '앞 반 입장이 아직 열려 있습니다. 주소 끝에 ?room=YM2-번호 를 붙여 주세요.');
    }

    findTries++;
    setTimeout(findRoom, findTries < 30 ? 2000 : 8000);
  }

  if (DEMO) {
    YM.demo.start(function (r, s, l) { room = r; seats = s; listings = l; render(); });
  } else if (urlRoom) {
    startFor(urlRoom);
  } else {
    waitBanner('수업을 찾는 중', '잠시만 기다려 주세요.');
    findRoom();
  }
})();
