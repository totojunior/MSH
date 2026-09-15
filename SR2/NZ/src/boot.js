/* =====================================================================
   MODULE: boot  -  시작. 계약 07 §11 의 부팅 순서 그대로.
   DECLARES EXACTLY ONE GLOBAL SLOT: window.NZ.start

   assemble.js 가 번들 맨 끝에 window.NZ.start() 호출을 붙인다.
   그 스크립트는 #root 에 마크업을 넣은 뒤에 실행되므로 DOM 은 이미 있다.

       State.init()  ->  Audio.init()  ->  Court.init(#nz-gl)
                     ->  #nz-root[data-three]  ->  UI.start()

   ---------------------------------------------------------------------
   왜 §11 의 여섯 줄보다 길어졌나
   ---------------------------------------------------------------------
   여섯 줄 중 하나라도 throw 하면 그 줄에서 부팅이 멈추고, 학생은 검은
   화면 앞에 앉는다. 5분짜리 도입 활동에서 그것은 곧 수업 손실이다.
   그래서 각 단계를 try/catch 로 감싸고, 실패한 단계는 그 자리에서
   무해한 대역으로 갈아 끼운 뒤 다음 단계로 넘어간다. 목표는 단 하나 -
   무슨 일이 있어도 사건 10건을 끝까지 풀 수 있게 만드는 것이다.

   여기서 하지 않는 것: 렌더링, 상태 변형, 3D 내부 조작, 화면 문구 결정.
   화면에 글자를 쓰는 유일한 경우는 UI 자체가 뜨지 못한 치명적 실패뿐이고,
   그때는 NZ.COPY 가 살아 있다는 보장도 없으므로 문장을 이 파일이 갖는다.
   ===================================================================== */

(function () {
  'use strict';

  window.NZ = window.NZ || {};

  var NZ = window.NZ;

  /* UI 자체가 뜨지 못했을 때만 쓰는 문장. 그 외 안내(3D 없음, 저장 불가)는
     전부 ui.js 가 NZ.COPY 로 낸다. 여기서 중복해 띄우지 않는다. */
  var MSG_FATAL = '화면을 여는 중 문제가 생겼습니다. 새로고침(F5) 해 보세요. 그래도 안 되면 선생님을 부르세요.';

  var MAX_ERRORS = 20;      // 콘솔이 아니라 __debug 에 쌓는 양의 상한
  var FALLBACK_REACT = 600; // NZ.CONFIG 조차 없을 때의 반응 길이(계약 §3 REACT_MIN)

  var started = false;
  var steps = {};   // 단계별 결과. __debug 로 들여다본다
  var errors = [];  // 최근 예외. 학생 화면에는 아무 영향이 없다
  var noteEl = null;

  /* --------------------------------------------------------------- 기록 */

  function record(where, err) {
    var msg = '';
    try {
      msg = (err && err.message) ? err.message : String(err);
    } catch (e) {
      msg = '(알 수 없음)';
    }
    if (errors.length >= MAX_ERRORS) errors.shift();
    errors.push({ at: Date.now(), where: where, msg: msg });
    try {
      if (window.console && console.error) console.error('[NZ] ' + where + ': ' + msg, err);
    } catch (e2) {
      /* 콘솔조차 못 쓰는 환경이면 남길 곳이 __debug 밖에 없다. 그것으로 충분하다. */
    }
  }

  /* 한 단계를 안전하게 실행한다. 실패하면 기록하고 fallback 을 돌려준다. */
  function step(name, fn, fallback) {
    try {
      var r = fn();
      steps[name] = 'ok';
      return r;
    } catch (e) {
      steps[name] = 'fail';
      record(name, e);
      return fallback;
    }
  }

  /* --------------------------------------------------------------- 대역

     court3d.js / audio.js 가 통째로 없거나 init 에서 터졌을 때만 쓰인다.
     계약의 API 를 글자 그대로 흉내 내는 것이 목적이다 - ui.js 는 3D/2D 를
     구분하지 않으므로(R9), 여기서 메서드 하나라도 빠지면 ui.js 가 죽는다.
     특히 react() 는 반드시 '숫자'를 돌려줘야 한다. undefined 를 주면
     setTimeout 이 0ms 로 돌거나 타이머가 안 걸려 피드백이 영영 안 열린다. */

  function stubCourt() {
    var last = { scene: 'start', pose: 'idle', paused: false, reacts: 0 };
    var ms = (NZ.CONFIG && typeof NZ.CONFIG.REACT_MIN === 'number') ? NZ.CONFIG.REACT_MIN : FALLBACK_REACT;
    return {
      ok: false,
      mode: 'flat',
      init: function () { return false; },
      react: function () { last.reacts++; return ms; },
      setPose: function (name) { last.pose = String(name); },
      setScene: function (name) { last.scene = String(name); },
      resize: function () { last.resizedAt = Date.now(); },
      pause: function () { last.paused = true; },
      resume: function () { last.paused = false; },
      dispose: function () { last.disposed = true; }
    };
  }

  function stubAudio() {
    var last = { name: null, at: 0 };
    return {
      init: function () { last.name = null; },
      enabled: false,
      /* 소리를 낼 수단이 없으므로 무엇을 넣어도 꺼짐이 실제 값이다. */
      setEnabled: function () { return false; },
      play: function (name) { last.name = String(name); last.at = Date.now(); }
    };
  }

  /* --------------------------------------------------------------- 안내 */

  function note(text) {
    try {
      if (noteEl) {
        noteEl.textContent = text;
        return;
      }
      var p = document.createElement('p');
      p.setAttribute('role', 'alert');
      /* CSS 가 실려 있다는 보장이 없는 상황에서 뜨는 문장이라 색을 직접 쓴다.
         값은 base.css 토큰과 같은 남색/글자색이다. */
      p.style.cssText =
        'position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;margin:0;' +
        'padding:12px 14px;border-radius:8px;background:#101A2E;color:#F2F5FA;' +
        'border:1px solid #5C74A0;font:15px/1.6 system-ui,-apple-system,"Malgun Gothic",sans-serif;';
      p.textContent = text;
      document.body.appendChild(p);
      noteEl = p;
    } catch (e) {
      record('note', e);
    }
  }

  /* --------------------------------------------------------------- 보조 */

  function court(method) {
    try {
      if (NZ.Court && typeof NZ.Court[method] === 'function') NZ.Court[method]();
    } catch (e) {
      record('court.' + method, e);
    }
  }

  function saveNow() {
    try {
      if (NZ.State && typeof NZ.State.save === 'function') NZ.State.save();
    } catch (e) {
      record('state.save', e);
    }
  }

  function screenNow() {
    try {
      if (NZ.State && typeof NZ.State.screen === 'function') return NZ.State.screen();
    } catch (e) {
      record('state.screen', e);
    }
    return '';
  }

  /* --------------------------------------------------------------- 전역 감시

     학생 화면을 죽이지 않는 것이 유일한 목적이다. preventDefault 를 하지
     않으므로 브라우저 기본 로그도 그대로 남는다. */

  function installGuards() {
    try {
      window.addEventListener('error', function (ev) {
        record('window.error', (ev && (ev.error || ev.message)) || ev);
      });
      window.addEventListener('unhandledrejection', function (ev) {
        record('unhandledrejection', ev && ev.reason);
      });
    } catch (e) {
      record('guards', e);
    }
  }

  /* --------------------------------------------------------------- 생명주기

     탭이 숨으면 rAF 루프를 멈추고 진행을 저장한다. 크롬북은 탭을 여러 개
     띄워 두는 일이 잦고, 멈추지 않은 3D 루프는 배터리와 팬으로 돌아온다.
     돌아올 때 결과 화면이면 재개하지 않는다 - 결과 화면의 정지는 ui.js 가
     의도해서 건 것이다(전이표 T11). ui.js 도 같은 저장을 할 수 있지만
     State.save() 는 멱등이라 두 번 불려도 손해가 없다. */

  function installLifecycle() {
    try {
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
          court('pause');
          saveNow();
        } else if (screenNow() !== 'result') {
          court('resume');
        }
      });
      window.addEventListener('pagehide', saveNow);
    } catch (e) {
      record('lifecycle', e);
    }
  }

  /* --------------------------------------------------------------- 부팅 */

  function boot() {
    if (started) return;
    started = true;

    installGuards();

    var root = document.getElementById('nz-root');
    var gl = document.getElementById('nz-gl');
    if (!root) record('dom', '#nz-root 를 찾지 못했다');

    if (!NZ.Audio) {
      steps.audioModule = 'missing';
      NZ.Audio = stubAudio();
    }
    if (!NZ.Court) {
      steps.courtModule = 'missing';
      NZ.Court = stubCourt();
    }

    /* 1) 상태 복구. 저장본을 읽어 스냅샷으로 보관만 한다(적용은 ui.js 가).
          여기서 실패해도 State 자체는 메모리 기본값으로 서 있다. */
    step('state', function () { return NZ.State.init(); }, null);

    /* 2) 소리 준비. 아직 AudioContext 를 만들지 않고 소리도 내지 않는다. */
    step('audio', function () { NZ.Audio.init(); return true; }, false);

    /* 3) 법정 장면. 실패하면 court3d.js 가 같은 API 의 2D 폴백으로 스스로
          갈아탄다(R9). init 이 예외로 터진 경우에만 여기서 대역을 끼운다 -
          그때는 그 객체의 다른 메서드도 믿을 수 없기 때문이다. */
    var ok = false;
    if (gl) {
      ok = step('court', function () { return NZ.Court.init(gl) === true; }, false);
      if (steps.court === 'fail') NZ.Court = stubCourt();
    } else {
      steps.court = 'skip';
      NZ.Court = stubCourt();
    }

    /* data-three 의 주인은 부팅 시점엔 boot.js 다(계약 §8.7). CSS 가 이것만 읽는다. */
    if (root) {
      try {
        root.setAttribute('data-three', ok ? 'on' : 'off');
      } catch (e) {
        record('data-three', e);
      }
    }

    /* 4) 화면. 첫 화면 선택(시작 / 이어하기)은 ui.js 의 몫이다. */
    var uiOk = step('ui', function () { NZ.UI.start(); return true; }, false);
    if (!uiOk) note(MSG_FATAL);

    installLifecycle();
  }

  /* assemble.js 는 DOM 삽입 뒤에 이 스크립트를 실행한다. 그래도 파일을
     다른 방식으로 열었을 때를 대비해 readyState 를 한 번 본다. */
  window.NZ.start = function () {
    try {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
      } else {
        boot();
      }
    } catch (e) {
      record('start', e);
      note(MSG_FATAL);
    }
  };

  /* 개발·수업 전 점검용. NZ 아래 전역은 계약상 8개로 고정이므로(R7)
     열거되지 않게 붙인다 - Object.keys(NZ) 는 그대로 8개다.
     읽기만 하는 진단이라 학생 화면에 영향이 없다. */
  try {
    Object.defineProperty(window.NZ, '__debug', {
      value: {
        v: 1,
        steps: steps,
        errors: errors,
        info: function () {
          var o = { steps: steps, errors: errors.length, court: 'none', sound: false };
          try {
            if (NZ.Court) o.court = NZ.Court.mode + (NZ.Court.ok ? '/ok' : '/down');
            if (NZ.Audio) o.sound = !!NZ.Audio.enabled;
          } catch (e) {
            record('debug.device', e);
          }
          try {
            o.screen = NZ.State.screen();
            o.done = NZ.State.completedCount();
            o.storageOk = NZ.State.storageOk();
          } catch (e2) {
            record('debug.state', e2);
          }
          return o;
        }
      },
      enumerable: false,
      configurable: true,
      writable: false
    });
  } catch (e) {
    record('debug', e);
  }
})();
