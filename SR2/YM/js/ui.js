/* YM — 표시 도구. 돈·시간 형식, 토스트, DOM 조립, 소리.
 *
 * 여기 있는 함수는 전부 textContent 로만 쓴다. innerHTML 은 이 파일에
 * 한 번도 등장하지 않는다 — 서버에서 온 문자열이 화면에 꽂히는 경로를
 * 아예 만들지 않기 위해서다.
 */
(function () {
  'use strict';

  // -------------------------------------------------------------------
  // 돈
  // -------------------------------------------------------------------
  // "20000 KRW" 같은 표기는 쓰지 않는다. 교실에서 읽히는 형태는 ₩20,000 이다.
  function won(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return '₩' + Math.round(n).toLocaleString('ko-KR');
  }

  // 큰 화면에서 자릿수가 많아질 때 쓰는 축약. 숫자는 항상 같이 보여 준다.
  function wonShort(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    if (n >= 10000) {
      var man = n / 10000;
      return (man % 1 === 0 ? man : man.toFixed(1)) + '만';
    }
    return won(n);
  }

  // -------------------------------------------------------------------
  // 시간
  // -------------------------------------------------------------------
  function clock(ms) {
    if (ms === null || ms === undefined) return '--:--';
    var s = Math.max(0, Math.ceil(ms / 1000));
    var m = Math.floor(s / 60);
    return String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  function secs(ms) {
    if (ms === null || ms === undefined) return '--';
    return String(Math.max(0, Math.ceil(ms / 1000)));
  }

  // -------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  function $(sel, root) { return (root || document).querySelector(sel); }

  function show(node, on) {
    if (!node) return;
    node.hidden = !on;
  }

  // -------------------------------------------------------------------
  // 토스트
  // -------------------------------------------------------------------
  // 경매 중에는 토스트를 쓰지 않는다 — 타이머를 보고 있는 학생의 시야를
  // 가리면 그 자체가 불이익이 된다. '한 좌석만 1등' 같은 상시 조건은
  // 화면에 계속 떠 있는 문장으로 보여 주고, 토스트는 일회성 사건만 쓴다.
  var toastHost = null;
  function toast(msg, kind) {
    if (!toastHost) {
      toastHost = el('div', 'ym-toasts');
      toastHost.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastHost);
    }
    var t = el('div', 'ym-toast' + (kind ? ' is-' + kind : ''), msg);
    toastHost.appendChild(t);
    setTimeout(function () { t.classList.add('is-out'); }, 2600);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 3200);
  }

  // -------------------------------------------------------------------
  // 소리 — 기본은 꺼짐. 프로젝터에서만 켠다.
  // -------------------------------------------------------------------
  // 교실에서 크롬북 33대가 동시에 울리면 수업이 안 된다. 소리는 교탁
  // 스피커 하나로만 나가고, 그마저도 사람이 한 번 눌러서 켜야 난다.
  // 오디오 파일은 쓰지 않는다 — 저작권과 오프라인 문제를 동시에 없앤다.
  var actx = null, muted = true;

  function soundEnable() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      if (!actx) actx = new AC();
      if (actx.state === 'suspended') actx.resume();
      muted = false;
      return true;
    } catch (e) { return false; }
  }

  function soundMuted(on) { muted = !!on; }
  function isMuted() { return muted; }

  function tone(freq, ms, type, gain) {
    if (muted || !actx) return;
    try {
      var o = actx.createOscillator(), g = actx.createGain();
      o.type = type || 'sine';
      o.frequency.value = freq;
      g.gain.value = 0;
      o.connect(g); g.connect(actx.destination);
      var t = actx.currentTime;
      var peak = gain === undefined ? 0.06 : gain;
      g.gain.linearRampToValueAtTime(peak, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
      o.start(t); o.stop(t + ms / 1000 + 0.02);
    } catch (e) { /* 소리는 없어도 수업은 굴러가야 한다 */ }
  }

  var SFX = {
    tick:    function () { tone(880, 70, 'square', 0.03); },
    go:      function () { tone(1320, 420, 'sawtooth', 0.07); },
    got:     function () { tone(660, 90); setTimeout(function () { tone(990, 160); }, 90); },
    bid:     function () { tone(520, 80, 'triangle', 0.05); },
    extend:  function () { tone(300, 240, 'square', 0.05); },
    close:   function () { tone(220, 520, 'sine', 0.07); },
  };

  // -------------------------------------------------------------------
  // 접근성 보조
  // -------------------------------------------------------------------
  // 색만으로 상태를 구분하지 않는다는 저장소 규칙을 지키기 위한 도구.
  // 좌석은 색과 함께 기호(○ / ×)와 스크린리더용 문장을 같이 준다.
  function seatAria(label, taken, mine) {
    if (mine) return label + ' 번 좌석, 내 좌석';
    return label + ' 번 좌석, ' + (taken ? '이미 나갔습니다' : '선택 가능');
  }

  YM.ui = {
    won: won, wonShort: wonShort, clock: clock, secs: secs,
    el: el, clear: clear, $: $, show: show, toast: toast,
    soundEnable: soundEnable, soundMuted: soundMuted, isMuted: isMuted,
    SFX: SFX, seatAria: seatAria,
  };
})();
