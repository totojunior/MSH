/* =====================================================================
   MODULE: audio  -  짧은 WebAudio 합성 효과음 4종. 기본 OFF.
   DECLARES EXACTLY ONE GLOBAL SLOT: window.NZ.Audio

   계약 07 §9 가 이 파일의 전부다:
     NZ.Audio.init()           -> void     구독만. AudioContext 를 만들지 않는다
     NZ.Audio.enabled          -> boolean  현재 켜짐 여부 (기본 false)
     NZ.Audio.setEnabled(bool) -> boolean  실제 적용된 값
     NZ.Audio.play(name)       -> void     목록에 없는 이름은 조용히 무시

   ---------------------------------------------------------------------
   왜 이렇게 만들었나
   ---------------------------------------------------------------------
   1) 오디오 파일이 0개다. 이 페이지는 단일 HTML 하나로 배포되고 인터넷이
      끊긴 교실에서 더블클릭으로도 열려야 한다. base64 음원을 심으면 파일이
      무거워지고, 외부 URL 은 애초에 빌드가 막는다. 그래서 전부 합성이다.
   2) AudioContext 를 로드 시점에 만들지 않는다. 크롬은 사용자 제스처 없이
      만든 컨텍스트를 suspended 로 둔다. 만들어 놓고 안 쓰면 교실 크롬북
      30대에서 오디오 장치만 점유한다. 학생이 '소리 켬' 을 누르는 그 클릭
      안에서 처음 만든다.
   3) 소리는 전부 220ms 이내, 마스터 게인 0.22 상한이다. 30명이 동시에
      다른 타이밍에 눌러도 교실이 견뎌야 한다. 비명·경보·급격한 어택의
      저음은 만들지 않는다. 특히 '반박'은 놀래키는 소리가 아니라 마른
      나무 두드림이다 - 틀린 학생을 놀라게 하는 순간 이 게임은 실패한다.
   4) 여기서 나는 예외는 전부 이 파일 안에서 죽는다. 소리가 안 나는 것은
      수업에서 아무 문제가 아니지만, play() 가 throw 해서 선택 확정이
      끊기면 그 학생은 게임을 못 한다.
   5) 이 파일은 아무도 부르지 않는다(계약 §2.1). DOM 도 상태도 읽지 않는다.
      켜짐/꺼짐의 진실은 NZ.State.muted() 이고, ui.js 가 그것을 읽어
      setEnabled() 로 내려 준다.
   ===================================================================== */

(function () {
  'use strict';

  window.NZ = window.NZ || {};

  /* 마스터 상한. 이 값 하나가 교실 전체 음량의 천장이다(계약 §9: 피크 -18 dBFS).
     개별 보이스의 피크는 아래에서 전부 0.34 이하로 잡았으므로
     실제 출력은 0.22 * 0.34 ≒ 0.075 (약 -22 dBFS) 가 된다. */
  var MASTER = 0.22;

  /* 같은 소리가 이 간격 안에 다시 오면 버린다. 연타로 같은 파형이 겹쳐
     쌓이면 피크가 합산되어 갑자기 커진다. 다른 이름끼리는 막지 않는다 -
     ui.js 가 선택 확정에서 'pick' 과 'match'/'rebut' 를 잇달아 부른다. */
  var REPEAT_MS = 45;

  var Ctor = null;
  if (typeof window.AudioContext === 'function') Ctor = window.AudioContext;
  else if (typeof window.webkitAudioContext === 'function') Ctor = window.webkitAudioContext;

  var ctx = null;        // 사용자가 소리를 켜기 전에는 null 로 남는다
  var master = null;     // 마스터 게인 노드
  var noiseBuf = null;   // 화이트 노이즈 1회 생성 후 재사용
  var lastAt = {};       // name -> 마지막 재생 시각(ms)

  /* 프라미스를 돌려주는 오디오 API(resume/suspend)의 거부를 삼킨다.
     그대로 두면 unhandledrejection 이 콘솔을 더럽힌다. */
  function swallow(p) {
    if (p && typeof p.then === 'function') {
      p.then(nothing, nothing);
    }
  }
  function nothing() {
    return null;
  }

  function ensureCtx() {
    if (ctx) return true;
    if (!Ctor) return false;
    try {
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = MASTER;
      master.connect(ctx.destination);
      return true;
    } catch (e) {
      ctx = null;
      master = null;
      return false;
    }
  }

  /* 지금이 사용자 제스처 안인가. 저장된 설정을 복원하느라 부팅 중에
     setEnabled(true) 가 불릴 수 있는데, 그때 컨텍스트를 만들면 교실
     크롬북 30대가 로드 직후 오디오 장치를 붙잡는다(04 §10 점검 21).
     판단할 수 없는 브라우저에서는 그냥 시도한다 - 실패해도 조용하다. */
  function inGesture() {
    try {
      var ua = window.navigator && window.navigator.userActivation;
      if (ua && typeof ua.isActive === 'boolean') return ua.isActive;
    } catch (e) {
      return true;
    }
    return true;
  }

  function resumeCtx() {
    if (!ctx) return;
    try {
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') swallow(ctx.resume());
    } catch (e) {
      /* 여기서 실패해도 할 수 있는 일이 없다. 소리만 안 난다. */
    }
  }

  function suspendCtx() {
    if (!ctx) return;
    try {
      if (ctx.state === 'running' && typeof ctx.suspend === 'function') swallow(ctx.suspend());
    } catch (e) {
      /* 위와 같다. */
    }
  }

  function noise() {
    if (noiseBuf) return noiseBuf;
    var n = Math.ceil(ctx.sampleRate * 0.3);
    var buf = ctx.createBuffer(1, n, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    noiseBuf = buf;
    return buf;
  }

  /* 어택-디케이 포락선. 어택 0 으로 시작하는 파형은 '탁' 이 아니라 '틱' 으로
     들리고 저음에서는 스피커를 때린다. 그래서 어택을 최소 3ms 준다. */
  function env(node, t0, peak, attack, decay) {
    var g = node.gain;
    g.setValueAtTime(0.0001, t0);
    g.linearRampToValueAtTime(peak, t0 + attack);
    g.exponentialRampToValueAtTime(0.0008, t0 + attack + decay);
  }

  function osc(type, t0, len) {
    var o = ctx.createOscillator();
    o.type = type;
    o.start(t0);
    o.stop(t0 + len);
    return o;
  }

  function noiseSrc(t0, len) {
    var s = ctx.createBufferSource();
    s.buffer = noise();
    s.start(t0, Math.random() * 0.2, len); // 매번 다른 지점에서 읽어 반복감을 없앤다
    s.stop(t0 + len);
    return s;
  }

  function filt(type, freq, q) {
    var f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    if (typeof q === 'number') f.Q.value = q;
    return f;
  }

  function gain() {
    return ctx.createGain();
  }

  /* --------------------------------------------------------------- 보이스
     각 함수는 t0(스케줄 시각)만 받는다. 타격이 있는 보이스는 자기 안에서
     t0 뒤로 살짝 밀어 3D 연출의 임팩트 순간에 소리가 떨어지게 한다 -
     ui.js 가 애니메이션 길이를 알 필요가 없도록 여기서 끝낸다. */

  /* 재생마다 살짝 흔든다. 같은 파형이 열 번 그대로 반복되면 소리가 있다는
     사실 자체가 피로가 된다. 폭은 반음 이내라 '다른 소리'로 들리지는 않는다. */
  function vary(v, amt) {
    return v * (1 + (Math.random() * 2 - 1) * amt);
  }

  /* 서류철을 여는 소리. 종이가 스치는 짧은 노이즈 한 번. */
  function vOpen(t0) {
    var g = gain();
    var lo = vary(1100, 0.10), hi = vary(2600, 0.10);
    var bp = filt('bandpass', lo, 0.9);
    bp.frequency.setValueAtTime(lo, t0);                 // 앵커가 없으면 램프 시작점이 브라우저마다 다르다
    bp.frequency.linearRampToValueAtTime(hi, t0 + 0.12); // 스치듯 위로 훑는다
    var s = noiseSrc(t0, 0.17);
    env(g, t0, 0.26, 0.014, 0.13);
    s.connect(bp);
    bp.connect(g);
    g.connect(master);
  }

  /* 다음 사건으로 넘길 때. open 보다 짧고 높다 - 같은 종이지만 '여는' 게
     아니라 '넘기는' 동작이라 꼬리가 없어야 한다. */
  function vNext(t0) {
    var g = gain();
    var lo = vary(1800, 0.12);
    var bp = filt('bandpass', lo, 1.1);
    bp.frequency.setValueAtTime(lo, t0);
    bp.frequency.linearRampToValueAtTime(vary(3400, 0.10), t0 + 0.07);
    var s = noiseSrc(t0, 0.1);
    env(g, t0, 0.17, 0.008, 0.075);
    s.connect(bp);
    bp.connect(g);
    g.connect(master);
  }

  /* 선택 확정. 아주 짧은 클릭 하나. 여기가 길면 두 개 고를 때마다 거슬린다. */
  function vPick(t0) {
    var f0 = vary(980, 0.05);
    var o = osc('triangle', t0, 0.06);
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.73, t0 + 0.05);
    var g = gain();
    env(g, t0, 0.15, 0.004, 0.045);
    o.connect(g);
    g.connect(master);

    var s = noiseSrc(t0, 0.03);
    var hp = filt('highpass', 2600, 0.7);
    var gn = gain();
    env(gn, t0, 0.07, 0.003, 0.02);
    s.connect(hp);
    hp.connect(gn);
    gn.connect(master);
  }

  /* 법정을 여는 소리. 낮은 두 번의 노크. 개정(開廷)이지 팡파르가 아니다. */
  function vStart(t0) {
    for (var i = 0; i < 2; i++) {
      var t = t0 + i * 0.145;
      var o = osc('sine', t, 0.17);
      var f0 = vary(i ? 132 : 118, 0.03);
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.62, t + 0.1);
      var lp = filt('lowpass', 520, 0.7);
      var g = gain();
      env(g, t, i ? 0.30 : 0.26, 0.011, 0.13);
      o.connect(lp); lp.connect(g); g.connect(master);

      var s = noiseSrc(t, 0.07);
      var lp2 = filt('lowpass', 1100, 0.8);
      var gn = gain();
      env(gn, t, 0.10, 0.004, 0.055);
      s.connect(lp2); lp2.connect(gn); gn.connect(master);
    }
  }

  /* 도장 '쿵'. 낮게 떨어지고 짧은 꼬리만 남는다.
     어택을 12ms 로 늘려 급격한 저음 어택(계약 §9 금지 항목)을 피한다.
     0.16s 밀어 두는 이유: 3D 도장이 상판에 닿는 순간이 연출 시작 뒤 그쯤이다. */
  function vMatch(t0) {
    var t = t0 + 0.16;
    var f0 = vary(168, 0.06);
    var o = osc('sine', t, 0.21);
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.57, t + 0.12);
    var lp = filt('lowpass', 420, 0.6);
    var g = gain();
    env(g, t, 0.30, 0.012, 0.16);
    o.connect(lp);
    lp.connect(g);
    g.connect(master);

    /* 도장 몸통이 책상에 닿는 마찰음. 리버브 대신 이 한 겹으로 두께를 만든다. */
    var s = noiseSrc(t, 0.1);
    var lp2 = filt('lowpass', vary(900, 0.12), 0.7);
    var gn = gain();
    env(gn, t, 0.11, 0.01, 0.08);
    s.connect(lp2);
    lp2.connect(gn);
    gn.connect(master);

    /* 나무 상판이 잠깐 우는 소리. 이 한 겹이 '쿵'과 '툭'을 가른다. */
    var w = osc('triangle', t, 0.22);
    w.frequency.setValueAtTime(vary(305, 0.05), t);
    var bp = filt('bandpass', vary(430, 0.08), 5.5);
    var gw = gain();
    env(gw, t, 0.075, 0.009, 0.19);
    w.connect(bp); bp.connect(gw); gw.connect(master);
  }

  /* 지휘봉이 칠판을 한 번 치는 소리. 마르고 짧다.
     일부러 'match' 보다 작게 잡았다 - 틀린 쪽이 더 크게 울리면 그게 벌이다.
     0.13s 밀어 둔다 - 지휘봉이 닿는 순간에 맞춘다. */
  function vRebut(t0) {
    var t = t0 + 0.13;
    var s = noiseSrc(t, 0.08);
    var bp = filt('bandpass', vary(1500, 0.14), 3.2);
    var g = gain();
    env(g, t, 0.20, 0.003, 0.06);
    s.connect(bp);
    bp.connect(g);
    g.connect(master);

    var f0 = vary(380, 0.07);
    var o = osc('triangle', t, 0.12);
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.78, t + 0.09);
    var lp = filt('lowpass', 1800, 0.7);
    var go = gain();
    env(go, t, 0.13, 0.004, 0.09);
    o.connect(lp);
    lp.connect(go);
    go.connect(master);

    /* 칠판 판이 한 번 울리고 만다. 길게 끌면 혼내는 소리가 된다. */
    var b = osc('sine', t, 0.16);
    b.frequency.setValueAtTime(vary(196, 0.05), t);
    var gb = gain();
    env(gb, t, 0.06, 0.008, 0.13);
    b.connect(gb); gb.connect(master);
  }

  /* 결과 화면. 중립적인 두 음이다. 점수를 축하하지도 위로하지도 않는다 -
     0/10 인 학생과 10/10 인 학생이 정확히 같은 소리를 듣는다. */
  function vResult(t0) {
    var base = 294;                       // D4
    var steps = [1, 1.3348];              // 완전4도. 해결도 미해결도 아닌 간격
    for (var i = 0; i < steps.length; i++) {
      var t = t0 + i * 0.17;
      var o = osc('sine', t, 0.5);
      o.frequency.setValueAtTime(base * steps[i], t);
      var g = gain();
      env(g, t, 0.14, 0.05, 0.42);
      o.connect(g); g.connect(master);

      var h = osc('sine', t, 0.4);        // 한 옥타브 위를 아주 얇게 얹는다
      h.frequency.setValueAtTime(base * steps[i] * 2, t);
      var gh = gain();
      env(gh, t, 0.035, 0.05, 0.3);
      h.connect(gh); gh.connect(master);
    }
  }

  /* 소리를 켰을 때의 확인음. 이게 없으면 학생이 토글을 눌러 놓고도
     켜졌는지 알 수 없어 한 번 더 누른다. */
  function vOn(t0) {
    var f = [660, 880];
    for (var i = 0; i < 2; i++) {
      var t = t0 + i * 0.075;
      var o = osc('triangle', t, 0.1);
      o.frequency.setValueAtTime(f[i], t);
      var g = gain();
      env(g, t, 0.11, 0.006, 0.075);
      o.connect(g); g.connect(master);
    }
  }

  /* play() 는 여기 없는 이름을 조용히 버린다. */
  var VOICES = {
    open: vOpen,
    next: vNext,
    pick: vPick,
    start: vStart,
    match: vMatch,
    rebut: vRebut,
    result: vResult,
    on: vOn
  };

  /* --------------------------------------------------------------- API */

  var Audio = {
    /* 부팅 때 boot.js 가 한 번 부른다. 컨텍스트를 만들지 않는 것이 핵심이다.
       여기서 만들면 자동재생 정책에 걸려 suspended 상태로 남고,
       나중에 학생이 소리를 켜도 첫 소리가 안 난다. */
    init: function () {
      Audio.enabled = false;
      lastAt = {};
    },

    /* 현재 켜짐 여부. 진실의 원본은 NZ.State.muted() 이고 이것은 그 거울이다. */
    enabled: false,

    /* 반드시 사용자 제스처(클릭/키) 안에서 호출되어야 한다.
       반환값은 '실제로 적용된 값'이다. WebAudio 가 없는 브라우저에서
       true 를 넣어도 false 가 돌아온다 - ui.js 는 이 반환값을 믿으면 된다. */
    setEnabled: function (on) {
      try {
        if (!on) {
          Audio.enabled = false;
          suspendCtx();
          return false;
        }
        if (!Ctor) {
          Audio.enabled = false;   // WebAudio 가 없는 브라우저
          return false;
        }
        if (inGesture()) {
          if (!ensureCtx()) {
            Audio.enabled = false;
            return false;
          }
          resumeCtx();
        }
        /* 제스처 밖이면 '켬' 만 기록하고 컨텍스트는 첫 play() 로 미룬다.
           play() 는 언제나 학생의 클릭/키 입력 직후에 불린다. */
        Audio.enabled = true;
        return true;
      } catch (e) {
        Audio.enabled = false;
        return false;
      }
    },

    /* 절대 throw 하지 않는다. 소리는 장식이고, 게임은 소리 없이 완주 가능하다. */
    play: function (name) {
      try {
        if (!Audio.enabled) return;
        var v = VOICES[name];
        if (!v) return;

        var now = Date.now();
        if (now - (lastAt[name] || 0) < REPEAT_MS) return;
        lastAt[name] = now;

        /* setEnabled() 가 제스처 밖이어서 미뤄 둔 생성이 여기서 일어난다. */
        if (!ensureCtx()) return;

        /* 탭을 다녀오면 컨텍스트가 suspended 로 잠들어 있을 수 있다.
           play() 는 항상 사용자 입력 직후에 불리므로 여기서 깨워도 된다. */
        resumeCtx();

        v(ctx.currentTime + 0.001);
      } catch (e) {
        /* 소리 하나 못 낸 것으로 수업이 멈추지 않는다. */
      }
    }
  };

  window.NZ.Audio = Audio;
})();
