(function () {
  'use strict';
  window.NZ = window.NZ || {};

  /* ============================================================================
     court3d.js — 법정 배경 + 노직 리그 (three.js r134) + 완전히 같은 API 의 2D 폴백
     소유: docs/03-3D연출-명세.md · docs/07-인터페이스-계약.md §8

     설계 원칙 세 줄.
     1) ui.js 는 3D/2D 를 분기하지 않는다. 그래서 여기서 나가는 것은 "엔진"이 아니라
        언제나 같은 얼굴을 한 파사드 하나다. 엔진(three / flat)만 속에서 갈아 끼운다.
        NZ.Court 객체 자체를 교체하지 않는 이유: ui.js 가 부팅 때 참조를 캐시해 두면
        교체된 객체를 영영 못 본다. 교실에서 그건 "3D 실패 = 게임 정지"가 된다.
     2) react() 는 무슨 일이 있어도 숫자를 돌려준다. undefined 를 돌려주면 ui.js 의
        setTimeout(fn, undefined) 가 되어 반응 연출이 통째로 사라진다(계약 §8.3).
     3) Court 는 State 도 UI 도 부르지 않는다. 읽는 DOM 은 #nz-gl 의 사각형과
        #nz-root 의 data-motion 뿐이고, 쓰는 DOM 은 data-three(계약 §8.7)와
        자기가 만든 폴백 요소뿐이다.
     ========================================================================== */

  /* ---------------------------------------------------------------- 공용 수학 */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smooth(t) { t = clamp01(t); return t * t * (3 - 2 * t); }
  function easeIn(t) { t = clamp01(t); return t * t; }
  function easeOut(t) { t = clamp01(t); return 1 - (1 - t) * (1 - t) * (1 - t); }
  function easeBy(name, t) {
    if (name === 'easeIn') return easeIn(t);
    if (name === 'easeOut') return easeOut(t);
    if (name === 'linear') return clamp01(t);
    return smooth(t);
  }
  function safe(fn, d) { try { return fn(); } catch (e) { return d; } }

  /* 반응 길이(ms). 계약 §8.3 의 표 그대로. 여기 있는 숫자가 ui.js 의 타이머다.
     CONFIG 가 아직 없을 수도 있으므로(빌드 순서상 state.js 가 앞이지만 방어한다)
     하한/상한은 지역 상수로 둔다. */
  var REACT_MIN = 600;
  var REACT_MAX = 1200;
  var MS_APPROVE = 850;
  var MS_APPROVE_REDUCED = 700;
  var MS_REBUT = [1050, 1100, 1150, 950];

  function reactMs(mood, variant, reduced) {
    var ms;
    if (mood === 'approve') ms = reduced ? MS_APPROVE_REDUCED : MS_APPROVE;
    else if (mood === 'rebut') ms = MS_REBUT[variant] || MS_REBUT[0];
    else ms = REACT_MIN;
    return clamp(ms, REACT_MIN, REACT_MAX);
  }

  /* 변주 선택. 3D 와 폴백이 같은 번호를 쓰도록 엔진 바깥에 둔다.
     rebut 에서 streak>=3 이면 무조건 3번(타격 없는 조용한 변주)이다.
     연속으로 틀리는 학생에게 점점 세게 치는 연출은 요구사항이 금지한
     "학생을 몰아붙이는" 연출을 타이밍 차원에서 저지르는 것이다. 이 한 줄이 그걸 막는다.
     그래서 opts.variant(테스트용 강제 지정)보다도 이 규칙이 우선한다. */
  function pickVariant(mood, seed, streak, forced, reduced) {
    if (mood === 'rebut' && streak >= 3) return 3;
    var n = (mood === 'rebut') ? 4 : 3;
    var v;
    if (forced !== null && forced !== undefined && isFinite(forced)) v = Math.abs(forced | 0) % n;
    else v = (Math.abs(seed | 0) * 7 + Math.abs(streak | 0) * 3) % n;
    /* 모션 감소에서 2단 타격(v=2)은 금지. 기본 변주로 치환한다(03 §8.2). */
    if (mood === 'rebut' && reduced && v === 2) v = 0;
    return v;
  }

  /* 같은 seed 면 언제나 같은 미세 변주가 나온다 — 완료 사건을 다시 열어도 재현된다. */
  function jitterOf(seed) {
    var h = ((Math.abs(seed | 0) * 2654435761) >>> 0) % 997;
    return {
      prep: 0.160 + (h % 5) * 0.012,
      headY: ((h >> 3) & 1) ? -0.120 : 0.095,
      browAmp: 0.85 + ((h >> 5) % 4) * 0.10
    };
  }

  /* ------------------------------------------------------- 모션 감소 판정 */
  /* 두 개의 소스가 있다: OS 설정(matchMedia)과 #nz-root[data-motion](ui.js 가 쓰는
     사용자 선택의 최종값). 사용자가 명시적으로 고른 쪽이 언제나 이긴다. */
  var mqReduced = false;
  (function () {
    try {
      if (!window.matchMedia) return;
      var mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      mqReduced = !!mq.matches;
      var h = function () { mqReduced = !!mq.matches; onMotionChanged(); };
      if (mq.addEventListener) mq.addEventListener('change', h);
      else if (mq.addListener) mq.addListener(h);
    } catch (e) { mqReduced = false; }
  })();

  var motionAttr = null;   /* 'reduced' | 'full' | null(=OS 설정 따름) */
  function isReduced() {
    if (motionAttr === 'reduced') return true;
    if (motionAttr === 'full') return false;
    return mqReduced;
  }
  function onMotionChanged() {
    if (flat.built && flat.svg) flat.svg.setAttribute('data-motion', isReduced() ? 'reduced' : 'full');
  }

  /* ----------------------------------------------------------------- 색 토큰 */
  var C = {
    BG: 0x0b1024, WALL: 0x111a3c, BOARD: 0x16302a, BOARD_FR: 0x4a3220, CHALK: 0xe6dcc4,
    WOOD_DK: 0x35211a, WOOD_TOP: 0x5b3a22, PAPER: 0xd8cdb4, LAMP: 0x1f5a3a,
    SUIT: 0x2b3350, SHIRT: 0xe7e3d8, TIE: 0x8c3a3a, SKIN: 0xd9a882, HAIR: 0x4a4038,
    BROW: 0x2a231d, FRAME: 0x2a2a2e, BATON: 0x2a2320, BATON_TIP: 0xe8dcc4,
    STAMP_W: 0x4a2f1e, STAMP_B: 0x2a2a30, INK: 0xb4342c,
    KEY: 0xffd3a0, RIM: 0x6f9fe8, AMB: 0x2a3a6e
  };

  /* ========================================================================
     포즈 · 타임라인 — 3D 엔진이 쓰는 데이터. 폴백은 같은 길이·같은 변주 번호만 쓴다.
     타임라인은 "절대 포즈의 나열"이 아니라 fromPose → 목표값 보간이다.
     그래야 연출 도중에 다른 mood 가 들어와도 튀지 않는다(03 §5.0).
     ====================================================================== */
  /* 얼굴 부품의 기준 좌표. buildRig() 와 applyPose() 가 같은 숫자를 쓴다.
     둘로 나뉘어 있던 탓에 생성자에서 안경을 앞으로 밀어도 applyPose 가 매 프레임
     예전 값으로 되돌려 놓았다(눈썹 y 도 마찬가지).
     깊이 값의 근거: 머리 구는 중심 (0,0.105,0), 반경 0.125x(1,1.12,1.02) 이므로
     피부 표면이 눈 자리(x=+-0.049,y=0.112)에서 z≈0.117, 코 옆(x=0.009)에서 z≈0.127 이다.
     이보다 뒤에 두면 눈·안경이 얼굴 안에 묻혀 한 픽셀도 렌더되지 않는다. */
  var FACE = {
    eyesY: 0.112, eyesZ: 0.120,
    browX: 0.066, browY: 0.150, browZ: 0.126,
    glassesY: 0.096, glassesZ: 0.142
  };

  var BASE = {
    hipsY: 0.860, torsoX: 0, torsoY: 0, torsoSZ: 1,
    headX: 0, headY: 0,
    browL: -0.060, browR: 0.060, browY: 0, eyesSY: 1,
    armRX: -0.477, armRY: 0, armRZ: -0.200, elbowRX: -1.149, batonX: -1.200, batonZ: 0,
    armLX: -0.600, armLY: 0, armLZ: 0.110, elbowLX: -1.416,
    stampY: 0, stampSY: 1, filesY: 0,
    keyMul: 1, stageZ: 0, camKY: 0, camKZ: 0, glassesZ: 0, glintI: 0
  };
  var FIELDS = Object.keys(BASE);

  /* setPose 의 세 자세. 애니메이션 없이 즉시 확정되는 '기준 포즈'이고,
     호흡 사인파는 이 위에 그대로 얹힌다 — 완전히 굳은 사람은 화면이 멈춘 것으로 읽힌다. */
  var POSE = {
    idle: {},
    ready: { headX: -0.030, browL: -0.090, browR: 0.090, torsoX: 0.020, batonX: -1.240 },
    /* review 는 일치/불일치를 구분하지 않는다. 완료 사건 재방문에서 도장과 타격을
       다시 재생하지 않기 위해서다(계약 §8.4). 판정은 DOM 이 이미 말하고 있다. */
    review: { headX: 0.055, browL: -0.020, browR: 0.020, eyesSY: 0.92, torsoX: 0.030, armRX: -0.500 }
  };

  /* 반응이 끝난 뒤 '남는' 자세. 연출은 1초지만 학생이 해설을 읽는 시간은 그 몇 배다.
     타임라인이 전부 BASE 로 되돌아오면 대기·승인·반박이 정지 상태에서 완전히 같아지고,
     상태 구분을 말풍선 텍스트와 우측 패널 색이 통째로 떠맡는다 — 교실 뒤쪽에서 3D 쪽만
     보는 학생에게는 노직이 무엇을 판단했는지 읽히지 않는다(요구 §5).
     그래서 react() 가 끝나는 순간 기준 자세를 여기 값으로 바꾼다. 호흡 사인파는 그 위에
     그대로 얹히므로 '굳은 사람'이 되지는 않는다.
     이 처리는 Court 안에서 끝난다 — setPose 의 이름 목록(계약 §8.1/§8.4 'idle'|'ready'|
     'review')은 고정이고, ui.js 는 자세를 지시하지 않는다(R9). */
  var REST = {
    approve: { headX: 0.030, browL: -0.100, browR: 0.100, torsoX: -0.015 },
    rebut:   { headX: -0.020, browL: 0.090, browR: -0.090, batonX: -1.320, elbowRX: -1.050 }
  };

  function poseBase(name) {
    var out = {}, i, k;
    for (i = 0; i < FIELDS.length; i++) { k = FIELDS[i]; out[k] = BASE[k]; }
    var over = POSE[name] || POSE.idle;
    for (k in over) { if (Object.prototype.hasOwnProperty.call(over, k)) out[k] = over[k]; }
    return out;
  }

  /* poseBase() 위에 mood 잔류값을 얹은 자세. mood 를 모르면 poseBase 와 같다. */
  function restPose(name, mood) {
    var out = poseBase(name), over = REST[mood], k;
    if (over) { for (k in over) { if (Object.prototype.hasOwnProperty.call(over, k)) out[k] = over[k]; } }
    return out;
  }

  /* 진폭 스케일: 목표값을 기준값 쪽으로 당긴다. 모션 감소에서 '무엇이 움직이는가'는
     그대로 두고 '얼마나 움직이는가'만 줄이기 위한 형태다(03 §8.3). */
  function amp(field, target, k) { return BASE[field] + (target - BASE[field]) * k; }

  /* 트랙 한 줄: [시각(초), 값, 이징]. 값이 null 이면 "연출 시작 시점의 현재 값".
     이징 'step' 은 그 시각에 값이 즉시 바뀐다(임팩트 프레임). */
  function tl() { return {}; }
  function track(T, field, keys) { T[field] = keys; }

  function buildApprove(variant, reduced, seed) {
    var T = tl();
    var s = reduced ? (MS_APPROVE_REDUCED / MS_APPROVE) : 1;   /* 모션 감소는 길이도 조금 줄인다 */
    var dur = (reduced ? MS_APPROVE_REDUCED : MS_APPROVE) / 1000;
    function t(x) { return x * s; }
    var bA = reduced ? 1 : 1;   /* 눈썹 각도는 모션 감소에서도 줄이지 않는다(의미의 주 채널) */

    track(T, 'browL', [[0, null], [t(0.12), -0.130 * bA, 'smooth'], [t(0.62), -0.130 * bA], [dur, BASE.browL, 'easeOut']]);
    track(T, 'browR', [[0, null], [t(0.12), 0.130 * bA, 'smooth'], [t(0.62), 0.130 * bA], [dur, BASE.browR, 'easeOut']]);
    track(T, 'browY', [[0, null], [t(0.12), 0.012, 'smooth'], [t(0.62), 0.012], [dur, 0, 'easeOut']]);

    if (reduced) {
      /* 끄덕임 1회. 두 번 끄덕이는 것은 진폭이 아니라 반복이므로 여기서 줄인다. */
      track(T, 'headX', [[0, null], [t(0.12), -0.045, 'smooth'], [t(0.38), 0.100, 'easeIn'], [dur, 0, 'easeOut']]);
    } else {
      track(T, 'headX', [[0, null], [0.12, -0.050, 'smooth'], [0.38, 0.115, 'easeIn'],
        [0.46, -0.020, 'smooth'], [0.62, 0.055, 'smooth'], [dur, 0, 'easeOut']]);
    }

    if (variant === 1) {
      /* 도장 없음. 왼손으로 안경을 밀어 올린다 — 같은 '인정'을 다른 몸짓으로.
         아래 세 각도는 손 원점이 안경테(월드 -0.95, 1.57, 0.21)에 오도록
         역기구학을 수치로 풀어서 얻은 값이다. 눈대중으로 잡으면 손이 턱 밑을 긁는다. */
      track(T, 'armLX', [[0, null], [t(0.30), -1.760, 'smooth'], [t(0.44), -1.760], [dur, BASE.armLX, 'easeOut']]);
      track(T, 'armLZ', [[0, null], [t(0.30), -0.680, 'smooth'], [t(0.44), -0.680], [dur, BASE.armLZ, 'easeOut']]);
      track(T, 'elbowLX', [[0, null], [t(0.30), -1.540, 'smooth'], [t(0.44), -1.540], [dur, BASE.elbowLX, 'easeOut']]);
      track(T, 'glassesZ', [[0, 0], [t(0.34), 0.004, 'smooth'], [t(0.52), 0, 'easeOut']]);
      track(T, 'glintI', [[0, 0], [t(0.36), 0.45, 'smooth'], [t(0.62), 0, 'linear']]);
    } else {
      track(T, 'armLX', [[0, null], [t(0.22), -0.870, 'smooth'], [t(0.38), -0.560, 'easeIn'], [t(0.62), BASE.armLX, 'smooth']]);
      track(T, 'elbowLX', [[0, null], [t(0.22), -1.200, 'smooth'], [t(0.38), -1.470, 'easeIn'], [t(0.62), BASE.elbowLX, 'smooth']]);
      track(T, 'stampY', [[0, null], [t(0.22), 0.055, 'smooth'], [t(0.38), -0.004, 'easeIn'], [t(0.62), 0, 'smooth']]);
      track(T, 'stampSY', [[0, 1], [t(0.38), 0.88, 'step'], [t(0.46), 1, 'easeOut']]);
      track(T, 'keyMul', [[0, 1], [t(0.38), 1.22, 'step'], [t(0.63), 1, 'smooth']]);
    }
    if (variant === 2) {
      /* 도장 + 지휘봉을 살짝 들었다 내리는 가벼운 경례. */
      track(T, 'batonX', [[0, null], [t(0.30), -1.100, 'smooth'], [t(0.58), BASE.batonX, 'easeOut']]);
    }
    return { dur: dur, tracks: T, impactAt: (variant === 1) ? -1 : t(0.38), mood: 'approve' };
  }

  /* 타격 변주에서 왼팔은 반대쪽으로 버티며 상판을 짚는다 — 팔 하나만 움직이면
     사람이 아니라 기계 팔로 읽힌다. */
  function trackLeftBrace(T, ti, k, dur) {
    track(T, 'armLX', [[0, null], [ti, amp('armLX', -0.440, k), 'easeIn'], [dur, BASE.armLX, 'easeOut']]);
    track(T, 'armLZ', [[0, null], [ti, amp('armLZ', 0.042, k), 'easeIn'], [dur, BASE.armLZ, 'easeOut']]);
    track(T, 'elbowLX', [[0, null], [ti, amp('elbowLX', -1.684, k), 'easeIn'], [dur, BASE.elbowLX, 'easeOut']]);
  }

  function buildRebut(variant, reduced, seed) {
    var T = tl();
    var j = jitterOf(seed);
    var sw = reduced ? 0.55 : 1;        /* 스윙 진폭 */
    var ln = reduced ? 0.50 : 1;        /* 몸통 lean */
    var bA = j.browAmp;                 /* 눈썹은 진폭을 줄이지 않는다 */
    var p = j.prep;
    var ti = p + 0.14;                  /* 임팩트 */
    var dur = MS_REBUT[variant] / 1000;
    var quiet = (variant === 3);
    /* v1 은 몸을 자기 오른쪽(칠판 쪽)으로 틀어 상판 왼쪽을 치는 백핸드다.
       03 은 팁이 칠판을 친다고 적었지만, §4.2 의 팔 길이로는 칠판면(z −0.80)에
       손이 닿지 않는다 — 억지로 닿게 하려면 팔을 늘이거나 몸을 통째로 옮겨야 한다.
       그래서 '칠판 쪽으로 도는 몸짓'만 살리고 접촉면은 상판으로 통일했다.
       지휘봉이 닿는 곳은 상판뿐이고, 어떤 변주에서도 사람 쪽으로 오지 않는다. */
    var board = (variant === 1);
    var twice = (variant === 2);
    var hY = j.headY;

    /* 표정은 즉시 바뀐다. 찡그림 유지 시간은 0.70 s 를 넘지 않는다 —
       "노려보는 시간"을 만들지 않기 위한 상한이고 연출 취향이 아니다(03 §5.3). */
    var browPeak = (quiet ? 0.22 : 0.30) * bA;
    track(T, 'browL', [[0, null], [0.06, 0.26 * bA, 'smooth'], [ti, browPeak, 'smooth'], [0.70, browPeak], [0.90, BASE.browL, 'easeOut']]);
    track(T, 'browR', [[0, null], [0.06, -0.26 * bA, 'smooth'], [ti, -browPeak, 'smooth'], [0.70, -browPeak], [0.90, BASE.browR, 'easeOut']]);
    track(T, 'browY', [[0, null], [0.06, -0.008], [0.70, -0.008], [0.90, 0, 'easeOut']]);
    track(T, 'eyesSY', [[0, null], [0.06, 0.86, 'smooth'], [0.34, 0.88], [0.70, 0.88], [0.90, 1, 'easeOut']]);

    /* 임팩트 '지점'은 줄이지 않고 '휘두르는 거리'만 줄인다.
       진폭을 접촉 포즈에까지 곱하면 모션 감소·2단 변주에서 지휘봉이 상판에 닿지 않고
       허공에서 멈춘다 — 그건 작은 동작이 아니라 고장난 동작으로 읽힌다.
       그래서 sw/k2 는 준비 자세(들어올림)에만 걸고, 닿는 각도는 언제나 그대로 둔다.
       아래 숫자들은 §4.2 의 팔 길이로 정기구학을 풀어 팁이 상판(y 1.075)에 떨어지도록
       구한 값이다. 상판 높이를 바꾸면 batonX 의 -1.800 을 다시 풀어야 한다. */
    var upX = board ? -0.850 : -0.140;
    var hitX = board ? -0.980 : -0.690;
    var HIT_BATON = -1.800;             /* 팁 월드 y ≈ 1.077 — 상판 윗면 */
    var QUIET_BATON = -1.700;           /* 팁이 상판 4.5 cm 위에서 멈춘다. 닿지 않는다 */
    var k2 = twice ? 0.60 : 1;          /* 2단 변주는 들어올리는 폭을 60% 로 */

    track(T, 'armRX', [[0, null], [p, amp('armRX', upX, sw * k2), 'smooth'],
      [ti, hitX, 'easeIn'], [0.70, hitX * 0.94], [dur, BASE.armRX, 'easeOut']]);
    if (board) track(T, 'armRY', [[0, null], [p, amp('armRY', -0.300, sw), 'smooth'], [0.70, amp('armRY', -0.300, sw)], [dur, 0, 'easeOut']]);
    track(T, 'armRZ', [[0, null], [ti, -0.230, 'easeIn'], [dur, BASE.armRZ, 'easeOut']]);
    track(T, 'elbowRX', [[0, null], [p, amp('elbowRX', -1.420, sw * k2), 'smooth'],
      [ti, -0.760, 'easeIn'], [dur, BASE.elbowRX, 'easeOut']]);

    if (quiet) {
      /* 조용한 변주: 타격이 없다. 지휘봉을 상판 위에 멈춰 세우고 왼손으로 상판을 짚는다.
         연속 오답에서 여기로 오기 때문에 조명 펄스도 카메라 킥도 없다. */
      track(T, 'batonX', [[0, null], [p, amp('batonX', -0.980, sw), 'smooth'],
        [ti + 0.10, QUIET_BATON, 'easeOut'], [0.70, QUIET_BATON], [dur, BASE.batonX, 'easeOut']]);
      track(T, 'armLX', [[0, null], [ti, amp('armLX', -0.480, sw), 'smooth'], [0.72, amp('armLX', -0.480, sw)], [dur, BASE.armLX, 'easeOut']]);
      track(T, 'elbowLX', [[0, null], [ti, amp('elbowLX', -1.560, sw), 'smooth'], [dur, BASE.elbowLX, 'easeOut']]);
    } else if (twice) {
      /* 2단: 세게 한 번이 아니라 짧게 두 번. 들어올리는 폭만 60% 다. */
      track(T, 'batonX', [[0, null], [p, amp('batonX', -0.900, sw * k2), 'smooth'],
        [ti, HIT_BATON, 'easeIn'],
        [ti + 0.10, -1.420, 'easeOut'],
        [ti + 0.18, HIT_BATON, 'easeIn'],
        [ti + 0.34, -1.360, 'smooth'], [dur, BASE.batonX, 'easeOut']]);
      trackLeftBrace(T, ti, sw * k2, dur);
    } else {
      /* 임팩트 뒤의 오버슛은 상판을 뚫고 내려가는 쪽이 아니라 튀어오르는 쪽이다. */
      track(T, 'batonX', [[0, null], [p, amp('batonX', -0.900, sw * k2), 'smooth'],
        [ti, HIT_BATON, 'easeIn'],
        [ti + 0.12, -1.640, 'easeOut'],
        [ti + 0.32, -1.360, 'smooth'], [dur, BASE.batonX, 'easeOut']]);
      trackLeftBrace(T, ti, sw * k2, dur);
    }

    track(T, 'torsoX', [[0, null], [p, amp('torsoX', -0.045, ln), 'smooth'],
      [ti, amp('torsoX', 0.105, ln * k2), 'easeIn'], [0.34, amp('torsoX', 0.090, ln)],
      [0.70, amp('torsoX', 0.090, ln)], [dur, 0, 'easeOut']]);
    track(T, 'torsoY', [[0, null], [p, amp('torsoY', board ? -0.340 : -0.060, ln), 'smooth'],
      [ti, amp('torsoY', board ? -0.180 : 0.020, ln), 'easeIn'], [dur, 0, 'easeOut']]);
    track(T, 'headX', [[0, null], [p, amp('headX', -0.070, ln), 'smooth'],
      [ti, amp('headX', 0.090, ln), 'easeIn'], [0.34, amp('headX', 0.030, ln)], [0.70, amp('headX', 0.030, ln)], [dur, 0, 'easeOut']]);
    /* 0.34 → 0.70 은 '말하는 구간'이다. 고개가 정면으로 돌아와 학생을 본다.
       내려다보는 각으로 바꾸지 않는다 — 카메라는 §2.3 그대로 수평이다. */
    track(T, 'headY', [[0, null], [p, hY * ln, 'smooth'], [ti, hY * 0.8 * ln, 'easeIn'], [0.70, 0, 'smooth']]);

    if (!quiet) {
      var pulse = reduced ? 1.12 : 1.35;
      if (twice) {
        track(T, 'keyMul', [[0, 1], [ti, pulse, 'step'], [ti + 0.14, 1, 'smooth'],
          [ti + 0.18, pulse * 0.8, 'step'], [ti + 0.42, 1, 'smooth']]);
        track(T, 'filesY', [[0, 0], [ti, 0.010, 'step'], [ti + 0.16, 0, 'easeOut'],
          [ti + 0.18, 0.006, 'step'], [ti + 0.38, 0, 'easeOut']]);
      } else {
        track(T, 'keyMul', [[0, 1], [ti, pulse, 'step'], [ti + 0.25, 1, 'smooth']]);
        if (!board) track(T, 'filesY', [[0, 0], [ti, 0.010, 'step'], [ti + 0.22, 0, 'easeOut']]);
      }
      if (!reduced) {
        /* 다가옴과 카메라 킥은 모션 감소에서 완전히 제거된다. 여기가 그 분기다. */
        track(T, 'stageZ', [[0, null], [ti, 0.075, 'easeIn'], [0.70, 0.075], [dur, 0, 'easeOut']]);
        if (!twice) {
          track(T, 'camKY', [[0, 0], [ti, -0.012, 'step'], [ti + 0.18, 0, 'easeOut']]);
          track(T, 'camKZ', [[0, 0], [ti, -0.010, 'step'], [ti + 0.18, 0, 'easeOut']]);
        }
      }
    }
    return { dur: dur, tracks: T, impactAt: quiet ? -1 : ti, mood: 'rebut' };
  }

  /* 트랙 평가. from 은 연출이 시작된 순간의 포즈 스냅샷이다. */
  function evalTracks(tlObj, from, base, t, out) {
    var i, k, keys, j, a, b, v;
    for (i = 0; i < FIELDS.length; i++) {
      k = FIELDS[i];
      keys = tlObj.tracks[k];
      if (!keys) { out[k] = base[k]; continue; }
      /* 첫 키 이전 */
      a = keys[0];
      var av = (a[1] === null) ? from[k] : a[1];
      if (t <= a[0]) { out[k] = av; continue; }
      v = av;
      var done = false;
      for (j = 1; j < keys.length; j++) {
        b = keys[j];
        var bv = (b[1] === null) ? from[k] : b[1];
        if (t <= b[0]) {
          if (b[2] === 'step') { out[k] = v; }
          else {
            var span = b[0] - a[0];
            out[k] = span <= 0 ? bv : lerp(v, bv, easeBy(b[2], (t - a[0]) / span));
          }
          done = true;
          break;
        }
        a = b; v = bv;
      }
      if (!done) out[k] = v;
    }
    return out;
  }

  /* ========================================================================
     2D 폴백 — 순수 SVG + 자급 CSS.
     ui.html 은 빈 #nz-court-flat 컨테이너만 줄 수도 있고 안 줄 수도 있다.
     없으면 여기서 만든다. 어느 쪽이든 안쪽 내용과 스타일은 전부 이 파일이 만든다.
     ui.css 와 싸우지 않도록 선택자는 전부 #nz-court-flat / #nz-fb-bust 밑으로 잠근다.
     ====================================================================== */
  var FLAT_CSS = [
    /* 컨테이너가 주어진 경우에만 쓰이는 규칙. 없으면 SVG 가 #nz-gl 의 형제로 직접 들어가고
       사각형은 ui.css 가 이미 잡아 준다(같은 선택자로 캔버스와 묶여 있다). */
    '#nz-court-flat{pointer-events:none;overflow:hidden;}',
    '#nz-court-flat #nz-fb-bust{position:absolute;left:0;top:0;width:100%;height:100%;}',
    /* 배경을 여기서 불투명하게 깔아, 폴백일 때 보이는 그림이 언제나 하나가 되게 한다. */
    /* 3D 쪽 카메라가 start/lobby/result 에서 노직을 화면 오른쪽에 세운다.
       폴백도 같은 구도라야 한다 — 안 그러면 WebGL 이 없는 크롬북에서만
       제목이 그의 얼굴 위에 얹힌다. 사건 화면은 패널이 따로 있어 그대로 둔다. */
    '#nz-fb-bust.sc-start,#nz-fb-bust.sc-lobby,#nz-fb-bust.sc-result{',
    'transform:translateX(24%) scale(1.06);transform-origin:80% 100%;}',
    '@media (max-width:1023px){#nz-fb-bust.sc-start,#nz-fb-bust.sc-lobby,',
    '#nz-fb-bust.sc-result{transform:none;}}',
    '#nz-fb-bust{display:block;pointer-events:none;background:',
    'radial-gradient(64% 52% at 20% 24%, rgba(255,196,128,.17), transparent 72%),',
    'linear-gradient(180deg,#0d1433 0%,#0b1024 55%,#070b1c 100%);}',
    /* 포즈(의미)는 transition 으로, 장식은 animation 으로. 04 의 모션 감소 규칙이
       #nz-root 밑의 animation 만 죽이기 때문에, 의미를 animation 에 실으면
       모션 감소에서 승인과 반박이 똑같아진다(03 §9.5). */
    '#fbHead,#fbBrows,#fbBrowL,#fbBrowR,#fbBaton,#fbArmR,#fbArmL,#fbStamp,#fbInk,#fbTorso{',
    'transition:transform 260ms ease-out, opacity 260ms ease-out;}',
    '#fbHead{transform-origin:120px 104px;}',
    '#fbBrowL{transform-origin:146px 58px;}',   /* 노직의 왼쪽 눈썹 = 화면 오른쪽. 피벗은 바깥 끝 */
    '#fbBrowR{transform-origin:94px 58px;}',
    '#fbArmR{transform-origin:88px 124px;}',
    '#fbArmL{transform-origin:152px 124px;}',
    '#fbBaton{transform-origin:78px 152px;}',
    '#fbStamp{transform-origin:196px 163px;}',
    '#fbInk{transform-origin:196px 168px;}',
    '#fbTorso{transform-origin:120px 190px;}',
    '#fbEyes,#fbBlink{transform-origin:120px 70px;}',
    '#fbEyes{transition:transform 200ms ease-out;}',
    /* 대기 — 장식만. 호흡·깜빡임·안경 반짝임이 "화면이 멈추지 않았다"는 유일한 신호다. */
    '#nz-fb-bust.is-idle #fbTorso{animation:nzfbBreath 4.0s ease-in-out infinite;}',
    /* 깜빡임(장식)은 #fbBlink 에, 뜬 정도(포즈=의미)는 #fbEyes 에 건다.
       한 요소에 둘을 같이 걸면 animation 이 transform 을 통째로 이겨서
       반박의 찡그린 눈이 사라진다. */
    '#nz-fb-bust #fbBlink{animation:nzfbBlink 4.4s linear infinite;}',
    '#nz-fb-bust #fbGlint{animation:nzfbGlint 9s ease-in-out infinite;}',
    '#nz-fb-bust.paused #fbTorso,#nz-fb-bust.paused #fbBlink,#nz-fb-bust.paused #fbGlint{animation-play-state:paused;}',
    '@keyframes nzfbBreath{0%,100%{transform:translateY(0) scaleY(1)}50%{transform:translateY(-1.6px) scaleY(1.008)}}',
    '@keyframes nzfbBlink{0%,92%,100%{transform:scaleY(1)}94%,96%{transform:scaleY(.08)}}',
    '@keyframes nzfbGlint{0%,86%,100%{opacity:0}90%{opacity:.85}}',
    '@keyframes nzfbShake{0%,100%{transform:translateX(0)}30%{transform:translateX(-3px)}60%{transform:translateX(2px)}}',
    /* ready / review — 즉시 확정되는 기준 자세 */
    '#nz-fb-bust.pose-ready #fbHead{transform:rotate(-2deg) translateY(-1px);}',
    '#nz-fb-bust.pose-review #fbHead{transform:rotate(3deg);}',
    '#nz-fb-bust.pose-review #fbEyes{transform:scaleY(.86);}',
    /* 승인 — 끄덕임 + 도장 + 잉크. 눈썹은 양쪽 다 바깥으로 올라간다. */
    '#nz-fb-bust.is-approve #fbHead{transform:translateY(5px) rotate(3deg);}',
    '#nz-fb-bust.is-approve #fbBrows{transform:translateY(-3px);}',
    '#nz-fb-bust.is-approve #fbBrowL{transform:rotate(5deg);}',
    '#nz-fb-bust.is-approve #fbBrowR{transform:rotate(-5deg);}',
    '#nz-fb-bust.is-approve #fbArmL{transform:rotate(7deg);}',
    '#nz-fb-bust.is-approve.v1 #fbArmL{transform:rotate(-14deg);}',
    '#nz-fb-bust.is-approve #fbStamp{transform:translateY(3px) scaleY(.86);}',
    '#nz-fb-bust.is-approve.v1 #fbStamp{transform:none;}',
    '#nz-fb-bust.is-approve #fbInk{opacity:.92;transform:scale(1.12);}',
    '#nz-fb-bust.is-approve.v1 #fbInk{opacity:0;}',
    '#nz-fb-bust.ink-hold #fbInk{opacity:.5;transform:scale(1.12);transition:opacity 1.6s linear;}',
    /* 반박 — 지휘봉이 책상(또는 칠판)을 친다. 눈썹 안쪽 끝이 내려간다. */
    '#nz-fb-bust.is-idle #fbBaton{transform:rotate(10deg);}',
    '#nz-fb-bust.is-rebut #fbBaton{transform:rotate(30deg);}',
    '#nz-fb-bust.is-rebut #fbArmR{transform:rotate(-9deg);}',
    '#nz-fb-bust.is-rebut #fbBrowL{transform:rotate(-15deg);}',
    '#nz-fb-bust.is-rebut #fbBrowR{transform:rotate(15deg);}',
    '#nz-fb-bust.is-rebut #fbHead{transform:translateY(3px) rotate(2deg);}',
    '#nz-fb-bust.is-rebut #fbEyes{transform:scaleY(.88);}',
    '#nz-fb-bust.is-rebut #fbTorso{animation:nzfbShake .34s ease-out 1;}',
    '#nz-fb-bust.is-rebut.v1 #fbBaton{transform:rotate(-40deg);}',      /* 칠판 틀을 치는 백핸드 */
    '#nz-fb-bust.is-rebut.v1 #fbArmR{transform:rotate(-26deg);}',
    /* v3 = 조용한 변주: 타격도 흔들림도 없다. 지휘봉은 상판 위에 멈춰 선다. */
    '#nz-fb-bust.is-rebut.v3 #fbBaton{transform:rotate(24deg);}',
    '#nz-fb-bust.is-rebut.v3 #fbTorso{animation:none;}',
    '#nz-fb-bust.is-rebut.v3 #fbBrowL{transform:rotate(-11deg);}',
    '#nz-fb-bust.is-rebut.v3 #fbBrowR{transform:rotate(11deg);}',
    '#nz-fb-bust.is-rebut.v3 #fbArmL{transform:rotate(6deg);}',
    /* 잔류 자세 — 연출이 끝난 뒤에도 승인/반박이 남는다. 3D 의 REST 와 같은 뜻이다.
       is-idle 을 벗기지 않으므로 호흡·깜빡임은 계속 돈다. 이 규칙들이 위의
       pose-* / is-idle 규칙보다 뒤에 있어야 같은 특정도에서 이긴다. */
    '#nz-fb-bust.rest-approve #fbHead{transform:translateY(2px) rotate(2deg);}',
    '#nz-fb-bust.rest-approve #fbBrows{transform:translateY(-2px);}',
    '#nz-fb-bust.rest-approve #fbBrowL{transform:rotate(4deg);}',
    '#nz-fb-bust.rest-approve #fbBrowR{transform:rotate(-4deg);}',
    '#nz-fb-bust.rest-rebut #fbHead{transform:rotate(-1deg);}',
    '#nz-fb-bust.rest-rebut #fbBrowL{transform:rotate(-8deg);}',
    '#nz-fb-bust.rest-rebut #fbBrowR{transform:rotate(8deg);}',
    '#nz-fb-bust.rest-rebut #fbEyes{transform:scaleY(.92);}',
    '#nz-fb-bust.rest-rebut #fbBaton{transform:rotate(19deg);}',
    '#nz-fb-bust.rest-rebut #fbArmR{transform:rotate(-4deg);}',
    /* 모션 감소: 장식은 끄고 흔들림은 없애되, 눈썹·소품의 구분은 그대로 남긴다.
       구분을 transition(포즈) 에 실었기 때문에 여기서 animation 을 전부 꺼도
       승인과 반박은 여전히 다르게 보인다. */
    '#nz-fb-bust[data-motion="reduced"] #fbTorso{animation:none;}',
    '#nz-fb-bust[data-motion="reduced"] #fbGlint{animation:none;opacity:.25;}',
    '#nz-fb-bust[data-motion="reduced"] #fbHead,',
    '#nz-fb-bust[data-motion="reduced"] #fbBaton,',
    '#nz-fb-bust[data-motion="reduced"] #fbArmR,',
    '#nz-fb-bust[data-motion="reduced"] #fbArmL{transition-duration:120ms;}',
    /* 색 */
    '#nz-fb-bust .fb-board{fill:#16302a}',
    '#nz-fb-bust .fb-boardfr{fill:none;stroke:#4a3220;stroke-width:5}',
    '#nz-fb-bust .fb-chalk{fill:none;stroke:#e6dcc4;stroke-width:2;opacity:.42}',
    '#nz-fb-bust .fb-chalk rect{fill:none}',
    '#nz-fb-bust .fb-deskfront{fill:#35211a}',
    '#nz-fb-bust .fb-desktop{fill:#5b3a22}',
    '#nz-fb-bust .fb-paper{fill:#d8cdb4}',
    '#nz-fb-bust .fb-lamp{fill:#1f5a3a}',
    '#nz-fb-bust .fb-lampstem{fill:#2a2a30}',
    '#nz-fb-bust .fb-suit{fill:#2b3350}',
    '#nz-fb-bust .fb-shirt{fill:#e7e3d8}',
    '#nz-fb-bust .fb-tie{fill:#8c3a3a}',
    '#nz-fb-bust .fb-skin{fill:#d9a882}',
    '#nz-fb-bust .fb-hair{fill:#4a4038}',
    '#nz-fb-bust .fb-brow{fill:#3a322c}',
    '#nz-fb-bust .fb-frame{fill:none;stroke:#2a2a2e;stroke-width:3}',
    '#nz-fb-bust .fb-lens{fill:#121d36;opacity:.55}',
    '#nz-fb-bust .fb-white{fill:#f2efe6}',
    '#nz-fb-bust .fb-pupil{fill:#241d18}',
    '#nz-fb-bust .fb-baton{fill:#2a2320}',
    '#nz-fb-bust .fb-batontip{fill:#e8dcc4}',
    '#nz-fb-bust .fb-stampw{fill:#4a2f1e}',
    '#nz-fb-bust .fb-stampb{fill:#2a2a30}',
    '#nz-fb-bust #fbInk{fill:#b4342c;opacity:0}',
    '#nz-fb-bust #fbGlint{fill:#cfe4ff;opacity:0}'
  ].join('');

  /* viewBox 320×220. 3D 쪽 구도와 같은 읽기 순서(좌: 노직·지휘봉 / 우: 도장)를 지킨다.
     글자는 한 자도 없다 — 칠판은 분필 자국 도형뿐이다. */
  var FLAT_SVG = [
    '<svg id="nz-fb-bust" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 220"',
    ' preserveAspectRatio="xMidYMax meet" aria-hidden="true" focusable="false"',
    ' class="sc-lobby pose-idle is-idle v0">',
    '<rect class="fb-board" x="24" y="10" width="152" height="88" rx="3"/>',
    '<g class="fb-chalk">',
    '<path d="M50 26 V88 M126 26 V88 M38 40 H164"/>',
    '<rect x="64" y="50" width="16" height="16"/>',
    '<rect x="64" y="72" width="16" height="16"/>',
    '</g>',
    '<rect class="fb-boardfr" x="21" y="7" width="158" height="94" rx="4"/>',
    '<g id="fbBody">',
    '<g id="fbTorso">',
    '<rect class="fb-skin" x="112" y="88" width="16" height="22" rx="7"/>',
    '<ellipse class="fb-suit" cx="120" cy="150" rx="50" ry="30"/>',
    '<rect class="fb-suit" x="80" y="146" width="80" height="60" rx="8"/>',
    '<path class="fb-shirt" d="M111 118 L129 118 L120 152 Z"/>',
    '<path class="fb-tie" d="M116 126 L124 126 L122 158 L118 158 Z"/>',
    '<rect class="fb-tie" x="115" y="118" width="10" height="9" rx="2"/>',
    '<g id="fbHead">',
    '<ellipse class="fb-skin" cx="120" cy="70" rx="25" ry="29"/>',
    '<path class="fb-hair" d="M94 64 a26 27 0 0 1 52 0 q-8 -13 -26 -13 q-18 0 -26 13 Z"/>',
    '<ellipse class="fb-skin" cx="95" cy="72" rx="4" ry="7"/>',
    '<ellipse class="fb-skin" cx="145" cy="72" rx="4" ry="7"/>',
    '<path class="fb-skin" d="M120 68 L126 84 L114 84 Z"/>',
    '<g id="fbBrows">',
    '<rect id="fbBrowR" class="fb-brow" x="94" y="55" width="22" height="5" rx="2.5"/>',
    '<rect id="fbBrowL" class="fb-brow" x="124" y="55" width="22" height="5" rx="2.5"/>',
    '</g>',
    '<g id="fbEyes"><g id="fbBlink">',
    '<ellipse class="fb-white" cx="107" cy="70" rx="5.5" ry="6.5"/>',
    '<ellipse class="fb-white" cx="133" cy="70" rx="5.5" ry="6.5"/>',
    '<circle class="fb-pupil" cx="107" cy="71" r="2.6"/>',
    '<circle class="fb-pupil" cx="133" cy="71" r="2.6"/>',
    '</g></g>',
    '<g id="fbGlass">',
    '<circle class="fb-lens" cx="107" cy="70" r="11"/>',
    '<circle class="fb-lens" cx="133" cy="70" r="11"/>',
    '<circle class="fb-frame" cx="107" cy="70" r="11"/>',
    '<circle class="fb-frame" cx="133" cy="70" r="11"/>',
    '<path class="fb-frame" d="M118 70 H122 M96 68 L88 65 M144 68 L152 65"/>',
    '<rect id="fbGlint" x="100" y="63" width="5" height="11" rx="2" transform="rotate(-24 102 68)"/>',
    '</g>',
    '</g>',
    '</g>',
    '</g>',
    '<rect class="fb-deskfront" x="0" y="172" width="320" height="48"/>',
    '<rect class="fb-desktop" x="0" y="163" width="320" height="10"/>',
    '<g class="fb-paper">',
    '<rect x="236" y="160" width="46" height="5" rx="1.5"/>',
    '<rect x="233" y="154" width="48" height="5" rx="1.5"/>',
    '<rect x="238" y="148" width="44" height="5" rx="1.5"/>',
    '</g>',
    '<g><rect class="fb-lampstem" x="292" y="126" width="4" height="34" rx="2"/>',
    '<path class="fb-lamp" d="M278 128 L310 128 L302 112 L286 112 Z"/></g>',
    '<ellipse id="fbInk" cx="196" cy="168" rx="13" ry="4.5"/>',
    '<g id="fbStamp">',
    '<rect class="fb-stampb" x="184" y="154" width="24" height="9" rx="2"/>',
    '<rect class="fb-stampb" x="193" y="142" width="6" height="14" rx="3"/>',
    '<rect class="fb-stampw" x="187" y="128" width="18" height="16" rx="5"/>',
    '</g>',
    '<g id="fbArmR">',
    '<rect class="fb-suit" x="68" y="120" width="19" height="40" rx="9" transform="rotate(-9 78 124)"/>',
    '<ellipse class="fb-skin" cx="76" cy="156" rx="10" ry="8"/>',
    '<g id="fbBaton">',
    '<rect class="fb-baton" x="76" y="148" width="58" height="5" rx="2.5" transform="rotate(-18 78 152)"/>',
    '<circle class="fb-batontip" cx="131" cy="135" r="4"/>',
    '</g>',
    '</g>',
    '<g id="fbArmL">',
    '<rect class="fb-suit" x="152" y="120" width="19" height="40" rx="9" transform="rotate(24 160 124)"/>',
    '<ellipse class="fb-skin" cx="189" cy="140" rx="11" ry="8" transform="rotate(18 189 140)"/>',
    '</g>',
    '</svg>'
  ].join('');

  var flat = {
    built: false, host: null, root: null, svg: null, style: null,
    moodTimer: 0, inkTimer: 0, scene: 'lobby', pose: 'idle', mood: 'idle', paused: false
  };

  function flatBuild() {
    if (flat.built) return true;
    try {
      if (!flat.style) {
        var st = document.createElement('style');
        st.id = 'nz-court-flat-css';
        st.textContent = FLAT_CSS;
        document.head.appendChild(st);
        flat.style = st;
      }
      var gl = document.getElementById('nz-gl');
      /* ui.html 이 빈 컨테이너를 줬으면 그 안에, 아니면 계약 §8.2 그대로
         #nz-gl 의 '바로 다음 형제'로 넣는다. 반드시 다음 형제여야 한다 —
         ui.css 가 `#nz-gl[data-split="1"] ~ #nz-fb-bust` 로 세 모드의 사각형을
         캔버스와 묶어 두었기 때문에, 앞에 넣으면 그 규칙이 전부 안 맞는다. */
      var host = document.getElementById('nz-court-flat');
      var box = document.createElement('div');
      box.innerHTML = FLAT_SVG;
      var svg = box.firstElementChild;
      if (host) {
        host.setAttribute('aria-hidden', 'true');
        if (!host.querySelector('#nz-fb-bust')) host.appendChild(svg);
        else svg = host.querySelector('#nz-fb-bust');
        host.setAttribute('hidden', '');
      } else if (gl && gl.parentNode) {
        gl.parentNode.insertBefore(svg, gl.nextSibling);
      } else {
        (document.getElementById('root') || document.body).appendChild(svg);
      }
      flat.host = host || null;
      flat.svg = svg;
      flat.root = host || svg;
      /* SVGElement 에는 hidden IDL 속성이 없다(HTMLElement 것이다).
         프로퍼티로 대입하면 내용 속성이 안 붙고 [hidden]{display:none} 이 안 먹는다.
         그래서 반드시 setAttribute 로 건다. */
      flat.svg.setAttribute('hidden', '');
      flat.svg.setAttribute('data-motion', isReduced() ? 'reduced' : 'full');
      flat.built = true;
      flatScene(flat.scene);
      return true;
    } catch (e) { return false; }
  }

  /* 폴백은 #nz-gl 이 차지하던 사각형 '안에서만' 일어난다(04 §12: 레이아웃은 바뀌지 않는다).
     ui.css 가 #nz-fb-bust 를 캔버스와 같은 선택자로 이미 배치해 두었으면 손대지 않는다 —
     레이아웃 코드를 두 군데 두면 언젠가 한쪽만 고쳐지고 폴백이 화면 밖으로 나간다.
     스타일시트가 자리를 안 잡아 준 경우(이 파일만 떼어 쓴 경우)에만 캔버스 사각형을 베낀다.
     캔버스를 hidden 으로 감추지 않는 이유도 같다 — 감추면 rect 가 0 이 되어 기준을 잃는다.
     컨텍스트가 없는 캔버스는 투명하고, 그 위를 이 SVG 가 불투명하게 덮으므로
     검은 사각형은 남지 않는다. */
  function flatOwnsGeometry() {
    if (flat.host) return true;
    var pos = safe(function () { return window.getComputedStyle(flat.svg).position; }, 'static');
    return pos === 'static';
  }

  function flatSync() {
    if (!flat.built || !flat.root) return;
    if (flatOwnsGeometry()) {
      var gl = document.getElementById('nz-gl');
      var r = gl ? safe(function () { return gl.getBoundingClientRect(); }, null) : null;
      if (r && r.width >= 2 && r.height >= 2) {
        var s = flat.root.style;
        s.position = 'fixed';
        s.left = Math.round(r.left) + 'px';
        s.top = Math.round(r.top) + 'px';
        s.right = 'auto';
        s.bottom = 'auto';
        s.width = Math.round(r.width) + 'px';
        s.height = Math.round(r.height) + 'px';
        var z = safe(function () { return window.getComputedStyle(gl).zIndex; }, '');
        if (z && z !== 'auto') s.zIndex = z;
      }
    }
    flatScene(flat.scene);
  }

  function flatScene(name) {
    flat.scene = name;
    if (!flat.built || !flat.svg) return;
    var box = '0 0 320 220', par = 'xMidYMax meet';
    var r = safe(function () { return flat.svg.getBoundingClientRect(); }, null);
    var short = r && r.height > 0 && r.height < 300 && r.width / r.height > 2.6;
    if (short) {
      /* 밴드(stack)에서는 세로가 희소 자원이다. 머리·어깨·상판 가장자리만 남긴다. */
      box = '46 30 232 150'; par = 'xMidYMax meet';
    } else if (name === 'start' || name === 'lobby' || name === 'result') {
      /* overlay: DOM 이 중앙~우측을 쓴다. 노직을 좌측 1/3 로 민다. */
      par = 'xMinYMax meet';
    }
    flat.svg.setAttribute('viewBox', box);
    flat.svg.setAttribute('preserveAspectRatio', par);
    var cl = flat.svg.classList;
    cl.remove('sc-start'); cl.remove('sc-lobby'); cl.remove('sc-case'); cl.remove('sc-result');
    cl.add('sc-' + name);
  }

  function flatShow(on) {
    if (!flat.built) return;
    if (flat.host) {
      if (on) flat.host.removeAttribute('hidden');
      else flat.host.setAttribute('hidden', '');
    }
    if (on) flat.svg.removeAttribute('hidden');
    else flat.svg.setAttribute('hidden', '');
    if (on) flatSync();
  }

  function flatSetPose(name) {
    flat.pose = name;
    if (!flat.built) return;
    var cl = flat.svg.classList;
    cl.remove('pose-idle'); cl.remove('pose-ready'); cl.remove('pose-review');
    cl.add('pose-' + name);
    flatClearMood();
  }

  /* mood 를 지우고 잔류 자세만 남긴다. rest 가 null 이면 완전한 대기다. */
  function flatClearMood(rest) {
    if (!flat.built) return;
    var cl = flat.svg.classList;
    cl.remove('is-approve'); cl.remove('is-rebut');
    cl.remove('rest-approve'); cl.remove('rest-rebut');
    cl.add('is-idle');
    if (rest) cl.add('rest-' + rest);
    flat.mood = 'idle';
  }

  function flatPlay(mood, variant, ms, hold) {
    if (!flat.built) return;
    var cl = flat.svg.classList;
    if (flat.moodTimer) { clearTimeout(flat.moodTimer); flat.moodTimer = 0; }
    if (flat.inkTimer) { clearTimeout(flat.inkTimer); flat.inkTimer = 0; }
    cl.remove('is-idle'); cl.remove('is-approve'); cl.remove('is-rebut'); cl.remove('ink-hold');
    cl.remove('rest-approve'); cl.remove('rest-rebut');
    cl.remove('v0'); cl.remove('v1'); cl.remove('v2'); cl.remove('v3');
    cl.add('v' + variant);
    /* 같은 클래스를 다시 붙이는 경우에도 transition 이 다시 걸리도록 강제 리플로우한다. */
    safe(function () { return flat.svg.getBoundingClientRect().width; }, 0);
    cl.add(mood === 'approve' ? 'is-approve' : 'is-rebut');
    flat.mood = mood;
    flat.moodTimer = setTimeout(function () {
      flat.moodTimer = 0;
      if (mood === 'approve' && variant !== 1) {
        /* 잉크 자국은 연출이 끝나도 남는다. 학생의 시선이 DOM 패널에 가 있는 동안
           찍힌 흔적이 사라지면 "찍혔구나"가 성립하지 않는다. */
        flat.svg.classList.add('ink-hold');
        flat.inkTimer = setTimeout(function () {
          flat.inkTimer = 0;
          if (flat.svg) flat.svg.classList.remove('ink-hold');
        }, 1700);
      }
      if (!hold) flatClearMood(mood);   /* 대기로 돌아가되 승인/반박의 흔적은 남긴다 */
    }, ms);
  }

  function flatPause(p) {
    flat.paused = p;
    if (!flat.built) return;
    if (p) flat.svg.classList.add('paused');
    else flat.svg.classList.remove('paused');
  }

  function flatDispose() {
    if (flat.moodTimer) { clearTimeout(flat.moodTimer); flat.moodTimer = 0; }
    if (flat.inkTimer) { clearTimeout(flat.inkTimer); flat.inkTimer = 0; }
    try {
      /* #nz-fb-bust 는 Court 소유다. 그래서 dispose 에서 되돌려 놓는다.
         #nz-court-flat 컨테이너가 ui.html 것이면 비우기만 하고 남겨 둔다. */
      if (flat.svg && flat.svg.parentNode) flat.svg.parentNode.removeChild(flat.svg);
      if (flat.style && flat.style.parentNode) flat.style.parentNode.removeChild(flat.style);
    } catch (e) { /* 해제 실패가 게임을 멈추게 두지 않는다 */ }
    flat.built = false; flat.host = null; flat.root = null; flat.svg = null; flat.style = null;
  }

  /* ========================================================================
     three.js 엔진
     ====================================================================== */
  var TH = null;
  var G = {
    canvas: null, renderer: null, scene: null, cam: null, stage: null, rig: null,
    lights: null, geoms: [], mats: [], textures: [], meshes: {},
    raf: 0, running: false, paused: false, hidden: false, offscreen: false,
    quality: 1, mode: 'overlay', sceneName: 'lobby', w: 0, h: 0,
    t: 0, lastFrame: 0, lastDraw: 0, idleHz: 30, throttleHz: 0,
    poseName: 'idle', basePose: null, curPose: null, fromPose: null,
    timeline: null, tlT: 0, blend: 0, blendDir: 0, hold: false, idleFor: 0,
    blinkIn: 2.0, blinkT: -1, glintIn: 7.0, glintT: -1,
    ink: { t: -1, reduced: false },
    ro: null, io: null, mo: null, watchdog: 0, lostTimer: 0, frames: 0,
    perfAcc: 0, perfN: 0, perfCool: 0, contextLost: false, listeners: []
  };

  var DPR = [1.00, 1.25, 1.50];
  var MODE_CAP = { overlay: 1.25, split: 1.50, stack: 1.50 };

  function on(target, type, fn, opts) {
    try { target.addEventListener(type, fn, opts || false); G.listeners.push([target, type, fn, opts || false]); } catch (e) { }
  }
  function offAll() {
    for (var i = 0; i < G.listeners.length; i++) {
      var L = G.listeners[i];
      try { L[0].removeEventListener(L[1], L[2], L[3]); } catch (e) { }
    }
    G.listeners.length = 0;
  }

  function keepGeom(g) { G.geoms.push(g); return g; }
  function keepMat(m) { G.mats.push(m); return m; }

  function P(g, m, c) { return { g: g, m: m || null, c: (c === undefined || c === null) ? null : new TH.Color(c) }; }

  function mat4(px, py, pz, rx, ry, rz, sx, sy, sz) {
    var m = new TH.Matrix4();
    var q = new TH.Quaternion();
    q.setFromEuler(new TH.Euler(rx || 0, ry || 0, rz || 0, 'XYZ'));
    m.compose(new TH.Vector3(px || 0, py || 0, pz || 0), q,
      new TH.Vector3(sx === undefined ? 1 : sx, sy === undefined ? 1 : sy, sz === undefined ? 1 : sz));
    return m;
  }

  /* BufferGeometryUtils 는 r134 코어 UMD 에 없다. SR2/src/mod-worldB.js 와 같은 방식으로
     손으로 합친다. 색은 정점 색으로 구워 재질 인스턴스를 하나로 유지한다. */
  function mergeParts(parts) {
    var i, k, total = 0, list = [];
    for (i = 0; i < parts.length; i++) {
      var src = parts[i] && parts[i].g;
      if (!src) continue;
      var g;
      try { g = src.index ? src.toNonIndexed() : src.clone(); } catch (e) { continue; }
      if (parts[i].m) { try { g.applyMatrix4(parts[i].m); } catch (e) { } }
      if (!g.attributes.normal) { try { g.computeVertexNormals(); } catch (e) { } }
      if (!g.attributes.position) continue;
      list.push({ g: g, c: parts[i].c || null });
      total += g.attributes.position.count;
      try { src.dispose(); } catch (e) { }
    }
    var pos = new Float32Array(total * 3), nor = new Float32Array(total * 3);
    var uv = new Float32Array(total * 2), col = new Float32Array(total * 3);
    var o = 0;
    for (i = 0; i < list.length; i++) {
      var a = list[i].g;
      var ap = a.attributes.position.array;
      var an = a.attributes.normal ? a.attributes.normal.array : null;
      var au = a.attributes.uv ? a.attributes.uv.array : null;
      var n = a.attributes.position.count;
      pos.set(ap.subarray ? ap.subarray(0, n * 3) : ap, o * 3);
      if (an) nor.set(an.subarray ? an.subarray(0, n * 3) : an, o * 3);
      if (au) uv.set(au.subarray ? au.subarray(0, n * 2) : au, o * 2);
      var c = list[i].c;
      var r = c ? c.r : 1, gg = c ? c.g : 1, bb = c ? c.b : 1;
      for (k = 0; k < n; k++) { col[(o + k) * 3] = r; col[(o + k) * 3 + 1] = gg; col[(o + k) * 3 + 2] = bb; }
      o += n;
      try { a.dispose(); } catch (e) { }
    }
    var out = new TH.BufferGeometry();
    out.setAttribute('position', new TH.BufferAttribute(pos, 3));
    out.setAttribute('normal', new TH.BufferAttribute(nor, 3));
    out.setAttribute('uv', new TH.BufferAttribute(uv, 2));
    out.setAttribute('color', new TH.BufferAttribute(col, 3));
    try { out.computeBoundingSphere(); } catch (e) { }
    return keepGeom(out);
  }

  /* 칠판 자국. 글자는 한 획도 없다 — '조건 두 가지'의 그림이다(계약 §4.3). */
  function chalkTexture() {
    var cv = document.createElement('canvas');
    cv.width = 256; cv.height = 128;
    var ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, 256, 128);
    ctx.strokeStyle = 'rgba(230,220,196,0.42)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(40, 22); ctx.lineTo(40, 104);
    ctx.moveTo(150, 22); ctx.lineTo(150, 104);
    ctx.moveTo(24, 40); ctx.lineTo(232, 40);
    ctx.stroke();
    ctx.strokeRect(58, 56, 18, 18);
    ctx.strokeRect(58, 84, 18, 18);
    ctx.beginPath();
    ctx.moveTo(168, 62); ctx.lineTo(212, 62);
    ctx.moveTo(168, 80); ctx.lineTo(200, 80);
    ctx.stroke();
    var tex = new TH.CanvasTexture(cv);
    tex.encoding = TH.sRGBEncoding;   /* r134 — colorSpace 속성은 존재하지 않는다 */
    G.textures.push(tex);
    return tex;
  }

  function buildSet(matBody, matBoard) {
    var st = new TH.Group();
    var parts = [];
    var g;

    g = new TH.PlaneGeometry(9, 7);
    parts.push(P(g, mat4(-0.4, 0, -0.6, -Math.PI / 2, 0, 0), C.BG));
    g = new TH.PlaneGeometry(7.2, 3.4);
    parts.push(P(g, mat4(-0.55, 1.70, -1.35), C.WALL));

    /* 칠판 틀 4개 + 분필 받침 */
    var bx = -0.55, by = 1.80, bz = -0.80, br = -0.12;
    parts.push(P(new TH.BoxGeometry(2.12, 0.06, 0.05), mat4(bx, by + 0.555, bz, 0, br, 0), C.BOARD_FR));
    parts.push(P(new TH.BoxGeometry(2.12, 0.06, 0.05), mat4(bx, by - 0.555, bz, 0, br, 0), C.BOARD_FR));
    parts.push(P(new TH.BoxGeometry(0.06, 1.17, 0.05), mat4(bx - 1.03 * Math.cos(br), by, bz + 1.03 * Math.sin(br), 0, br, 0), C.BOARD_FR));
    parts.push(P(new TH.BoxGeometry(0.06, 1.17, 0.05), mat4(bx + 1.03 * Math.cos(br), by, bz - 1.03 * Math.sin(br), 0, br, 0), C.BOARD_FR));
    parts.push(P(new TH.BoxGeometry(2.12, 0.045, 0.085), mat4(bx, 1.235, -0.765, 0, br, 0), C.BOARD_FR));

    /* 교탁 — 판사석이 아니다. 노직은 칠판 앞 교탁에 선다(계약 §8.8). */
    parts.push(P(new TH.BoxGeometry(2.60, 0.70, 0.06), mat4(-0.55, 0.72, 0.52), C.WOOD_DK));
    parts.push(P(new TH.BoxGeometry(2.72, 0.07, 0.52), mat4(-0.55, 1.04, 0.27), C.WOOD_TOP));
    parts.push(P(new TH.BoxGeometry(2.72, 0.035, 0.03), mat4(-0.55, 1.022, 0.525), C.WOOD_TOP));

    /* 책 3권 + 은행가 램프 */
    parts.push(P(new TH.BoxGeometry(0.04, 0.17, 0.12), mat4(-1.72, 1.16, -0.05), C.WOOD_DK));
    parts.push(P(new TH.BoxGeometry(0.04, 0.17, 0.12), mat4(-1.665, 1.16, -0.05, 0, 0, 0.14), C.WOOD_DK));
    parts.push(P(new TH.BoxGeometry(0.04, 0.17, 0.12), mat4(-1.61, 1.16, -0.05), C.WOOD_DK));
    parts.push(P(new TH.CylinderGeometry(0.055, 0.090, 0.070, 12, 1, true), mat4(-1.78, 1.225, 0.10), C.LAMP));
    parts.push(P(new TH.CylinderGeometry(0.010, 0.014, 0.135, 8), mat4(-1.78, 1.145, 0.10), C.STAMP_B));
    parts.push(P(new TH.CylinderGeometry(0.048, 0.052, 0.016, 12), mat4(-1.78, 1.083, 0.10), C.STAMP_B));

    var setMesh = new TH.Mesh(mergeParts(parts), matBody);
    setMesh.frustumCulled = false;
    st.add(setMesh);

    /* 사건 서류 더미. 03 은 정적 메쉬에 합치라고 했지만 타격 때 0.010 튀어야 하므로
       별도 메쉬로 분리했다. 드로우콜 1 개를 더 쓰고 예산(24) 안에 여전히 여유가 있다. */
    var fparts = [];
    for (var i = 0; i < 4; i++) {
      fparts.push(P(new TH.BoxGeometry(0.22, 0.012, 0.30),
        mat4(-1.55 + (i % 2) * 0.012, 1.082 + i * 0.013, 0.28 - (i % 2) * 0.01, 0, 0.04 + i * 0.023, 0), C.PAPER));
    }
    var files = new TH.Mesh(mergeParts(fparts), matBody);
    st.add(files);
    G.meshes.files = files;

    /* 칠판 면 — 유일한 텍스처 메쉬 */
    var boardGeo = keepGeom(new TH.PlaneGeometry(2.00, 1.05));
    var board = new TH.Mesh(boardGeo, matBoard);
    board.position.set(-0.55, 1.80, -0.80);
    board.rotation.y = -0.12;
    st.add(board);

    /* 승인 도장 — 원점이 받침 바닥이라 scale.y 스쿼시가 '누르는 동작'이 된다.
       손의 자식이 아니라 stage 의 자식이다(팔 회전이 도장을 기울이지 않게). */
    var stamp = new TH.Group();
    stamp.position.set(-0.765, 1.075, 0.412);
    var sparts = [
      P(new TH.CylinderGeometry(0.040, 0.040, 0.022, 14), mat4(0, 0.011, 0), C.STAMP_B),
      P(new TH.CylinderGeometry(0.013, 0.013, 0.040, 10), mat4(0, 0.042, 0), C.STAMP_B),
      P(new TH.CylinderGeometry(0.028, 0.034, 0.055, 12), mat4(0, 0.089, 0), C.STAMP_W)
    ];
    stamp.add(new TH.Mesh(mergeParts(sparts), matBody));
    st.add(stamp);
    G.meshes.stamp = stamp;

    var inkMat = keepMat(new TH.MeshBasicMaterial({ color: C.INK, transparent: true, opacity: 0, depthWrite: false }));
    var ink = new TH.Mesh(keepGeom(new TH.TorusGeometry(0.038, 0.007, 6, 18)), inkMat);
    ink.position.set(-0.765, 1.0755, 0.412);
    ink.rotation.x = -Math.PI / 2;
    ink.visible = false;
    st.add(ink);
    G.meshes.ink = ink;
    G.meshes.inkMat = inkMat;

    return st;
  }

  function buildRig(matBody, matLens) {
    var rig = new TH.Group();
    rig.position.set(-1.00, 0, 0.06);
    /* rig.rotation.y = 0 — 몸은 돌리지 않는다. 3/4 각은 카메라를 비껴 놓아 만든다(03 §3.1). */

    var hips = new TH.Group(); hips.position.set(0, 0.860, 0); rig.add(hips);
    var torso = new TH.Group(); hips.add(torso);

    var tp = [
      P(new TH.CylinderGeometry(0.175, 0.215, 0.46, 16, 1), mat4(0, 0.23, 0), C.SUIT),
      /* CapsuleGeometry 가 r134 에 없으므로 아래쪽 반구만 만들어 실린더에 붙인다. */
      P(new TH.SphereGeometry(0.215, 16, 5, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), mat4(0, 0, 0, 0, 0, 0, 1, 0.55, 1), C.SUIT),
      P(new TH.SphereGeometry(0.30, 18, 12), mat4(0, 0.455, 0, 0, 0, 0, 1, 0.46, 0.72), C.SUIT),
      P(new TH.BoxGeometry(0.115, 0.26, 0.020), mat4(0, 0.340, 0.163), C.SHIRT),
      P(new TH.BoxGeometry(0.048, 0.050, 0.018), mat4(0, 0.425, 0.172), C.TIE),
      P(new TH.BoxGeometry(0.058, 0.190, 0.016), mat4(0, 0.310, 0.176), C.TIE),
      P(new TH.CylinderGeometry(0.058, 0.070, 0.10, 12), mat4(0, 0.515, 0.005), C.SKIN)
    ];
    var torsoMesh = new TH.Mesh(mergeParts(tp), matBody);
    torso.add(torsoMesh);

    var head = new TH.Group(); head.position.set(0, 0.565, 0.005); torso.add(head);
    var hp = [
      P(new TH.SphereGeometry(0.125, 24, 16), mat4(0, 0.105, 0, 0, 0, 0, 1, 1.12, 1.02), C.SKIN),
      P(new TH.SphereGeometry(0.133, 18, 12, 0, Math.PI * 2, 0, 1.45), mat4(0, 0.135, -0.012, 0, 0, 0, 1, 0.94, 1.02), C.HAIR),
      P(new TH.SphereGeometry(0.030, 8, 6), mat4(0.122, 0.095, 0, 0, 0, 0, 0.5, 1, 0.8), C.SKIN),
      P(new TH.SphereGeometry(0.030, 8, 6), mat4(-0.122, 0.095, 0, 0, 0, 0, 0.5, 1, 0.8), C.SKIN),
      P(new TH.ConeGeometry(0.028, 0.065, 8), mat4(0, 0.085, 0.118, 1.35, 0, 0), C.SKIN),
      P(new TH.SphereGeometry(0.105, 12, 8), mat4(0, 0.040, 0.012, 0, 0, 0, 1.05, 0.62, 0.95), C.SKIN)
    ];
    head.add(new TH.Mesh(mergeParts(hp), matBody));

    /* 눈은 하나의 메쉬. 원점이 눈 중심선이라 scale.y 하나로 양쪽이 동시에 감긴다. */
    var ep = [
      P(new TH.SphereGeometry(0.0195, 10, 8), mat4(0.049, 0, -0.011), 0xf2efe6),
      P(new TH.SphereGeometry(0.0195, 10, 8), mat4(-0.049, 0, -0.011), 0xf2efe6),
      P(new TH.SphereGeometry(0.0095, 8, 6), mat4(0.049, 0, 0.004), 0x241d18),
      P(new TH.SphereGeometry(0.0095, 8, 6), mat4(-0.049, 0, 0.004), 0x241d18)
    ];
    var eyes = new TH.Mesh(mergeParts(ep), matBody);
    /* z 는 0 이 아니라 얼굴 앞면이다. 머리 구(중심 (0,0.105,0), 반경 0.125x(1,1.12,1.02))의
       표면은 눈 자리(x=+-0.049, y=0.112)에서 z≈0.117 이다. 0 에 두면 흰자 앞면이 z≈0.0085 라
       눈이 통째로 피부 안에 묻혀 단 한 픽셀도 렌더되지 않는다. */
    eyes.position.set(0, FACE.eyesY, FACE.eyesZ);
    head.add(eyes);

    /* 눈썹 — 감정의 80%. 피벗은 바깥 끝(관자놀이)이다. 안쪽에 잡으면 감정이 통째로 뒤집힌다.
       (browL.rotation.z 양수 = 안쪽 끝이 내려감 = 찡그림.)
       색은 정점에 굽는다 — 재질 인스턴스를 늘리면 셰이더 프로그램이 하나 더 늘어난다. */
    var browL = new TH.Group(); browL.position.set(FACE.browX, FACE.browY, FACE.browZ);
    browL.add(new TH.Mesh(mergeParts([P(new TH.BoxGeometry(0.060, 0.013, 0.018), mat4(-0.030, 0, 0), C.BROW)]), matBody));
    head.add(browL);
    var browR = new TH.Group(); browR.position.set(-FACE.browX, FACE.browY, FACE.browZ);
    browR.add(new TH.Mesh(mergeParts([P(new TH.BoxGeometry(0.060, 0.013, 0.018), mat4(0.030, 0, 0), C.BROW)]), matBody));
    head.add(browR);

    /* 안경테는 코 옆(x≈0.009)에서 피부 표면 z≈0.127 을 넘어야 렌즈 안쪽 호가 보인다.
       0.098 이면 바깥쪽 호만 얼굴 밖으로 나와 '귀 옆 검은 초승달'로 읽힌다. */
    var glasses = new TH.Group(); glasses.position.set(0, FACE.glassesY, FACE.glassesZ); head.add(glasses);
    var gp = [
      P(new TH.TorusGeometry(0.040, 0.0075, 8, 20), mat4(0.049, 0, 0), C.FRAME),
      P(new TH.TorusGeometry(0.040, 0.0075, 8, 20), mat4(-0.049, 0, 0), C.FRAME),
      P(new TH.BoxGeometry(0.022, 0.006, 0.006), mat4(0, 0.004, 0), C.FRAME),
      P(new TH.BoxGeometry(0.006, 0.006, 0.085), mat4(0.083, 0.004, -0.042, 0, -0.20, 0), C.FRAME),
      P(new TH.BoxGeometry(0.006, 0.006, 0.085), mat4(-0.083, 0.004, -0.042, 0, 0.20, 0), C.FRAME)
    ];
    glasses.add(new TH.Mesh(mergeParts(gp), matBody));
    var lp = [
      P(new TH.CylinderGeometry(0.040, 0.040, 0.004, 20), mat4(0.049, 0, -0.002, Math.PI / 2, 0, 0), 0xffffff),
      P(new TH.CylinderGeometry(0.040, 0.040, 0.004, 20), mat4(-0.049, 0, -0.002, Math.PI / 2, 0, 0), 0xffffff)
    ];
    glasses.add(new TH.Mesh(mergeParts(lp), matLens));

    function arm(sx) {
      var a = new TH.Group();
      a.position.set(sx, 0.440, 0.005);
      var up = [P(new TH.CylinderGeometry(0.052, 0.045, 0.240, 10), mat4(0, -0.120, 0), C.SUIT)];
      a.add(new TH.Mesh(mergeParts(up), matBody));
      var el = new TH.Group(); el.position.set(0, -0.240, 0); a.add(el);
      var thumbX = (sx > 0) ? 0.042 : -0.042;
      var fp = [
        P(new TH.CylinderGeometry(0.045, 0.038, 0.225, 10), mat4(0, -0.1125, 0), C.SUIT),
        P(new TH.CylinderGeometry(0.042, 0.042, 0.022, 10), mat4(0, -0.215, 0), C.SHIRT),
        P(new TH.BoxGeometry(0.075, 0.032, 0.105), mat4(0, -0.253, 0.028), C.SKIN),
        P(new TH.BoxGeometry(0.026, 0.026, 0.055), mat4(thumbX, -0.253, 0.010, 0, (sx > 0 ? -0.45 : 0.45), 0), C.SKIN)
      ];
      el.add(new TH.Mesh(mergeParts(fp), matBody));
      var hand = new TH.Group(); hand.position.set(0, -0.235, 0); el.add(hand);
      return { arm: a, elbow: el, hand: hand };
    }

    var R = arm(-0.205), L = arm(0.205);
    torso.add(R.arm); torso.add(L.arm);

    var batonR = new TH.Group();
    batonR.position.set(0, -0.015, 0.035);
    R.hand.add(batonR);
    var bp = [
      P(new TH.SphereGeometry(0.016, 10, 8), mat4(0, 0, -0.010), C.BATON),
      P(new TH.CylinderGeometry(0.0055, 0.0100, 0.440, 8), mat4(0, 0, 0.220, Math.PI / 2, 0, 0), C.BATON),
      P(new TH.SphereGeometry(0.0075, 8, 6), mat4(0, 0, 0.440), C.BATON_TIP)
    ];
    batonR.add(new TH.Mesh(mergeParts(bp), matBody));

    G.meshes.torso = torso;
    G.meshes.torsoMesh = torsoMesh;
    G.meshes.hips = hips;
    G.meshes.head = head;
    G.meshes.eyes = eyes;
    G.meshes.browL = browL;
    G.meshes.browR = browR;
    G.meshes.glasses = glasses;
    G.meshes.armR = R.arm; G.meshes.elbowR = R.elbow; G.meshes.handR = R.hand;
    G.meshes.armL = L.arm; G.meshes.elbowL = L.elbow; G.meshes.handL = L.hand;
    G.meshes.batonR = batonR;
    return rig;
  }

  /* 카메라 프리셋. 시선 높이는 노직과 수평이다 — 올려다보는 앵글은 금지다(계약 §8.8). */
  var CAM = {
    /* 노직을 화면 오른쪽에 세운다. look.x 가 그의 x(-1.00)보다 왼쪽이면
       그는 화면 오른쪽으로 간다 — 글자가 앉는 왼쪽 열이 그만큼 비워진다.
       예전 값(look.x=-0.30)은 그를 정확히 제목 밑에 갖다 놓고 있었다. */
    overlay: { pos: [-1.02, 1.44, 2.18], look: [-1.42, 1.28, 0.24], lock: 'h', deg: 52 },
    /* 결과 화면은 좌우 두 열을 다 쓴다. 더 물러서서 방을 보여 주고
       노직은 오른쪽 아래에 작게 남긴다 — 여기서 주인공은 두 질문이다. */
    wide: { pos: [-1.12, 1.62, 2.86], look: [-1.34, 1.24, 0.18], lock: 'h', deg: 62 },
    /* 로비는 사건 파일 10장이 화면 한복판을 가로지른다. 노직을 눈높이에 두면
       카드가 그의 몸통을 덮어 사고처럼 보인다 — 카메라를 올려 내려다보면
       그는 격자 위로 올라가고 아래쪽은 책상 상판이 받친다. */
    desk: { pos: [-1.06, 2.16, 2.62], look: [-1.34, 1.12, 0.06], lock: 'h', deg: 58 },
    split: { pos: [-0.78, 1.52, 2.05], look: [-1.00, 1.30, 0.22], lock: 'h', deg: 46 },
    stack: { pos: [-0.82, 1.55, 1.45], look: [-1.00, 1.42, 0.12], lock: 'v', deg: 32 }
  };

  function modeFor(sceneName, w, h) {
    if (sceneName === 'result') return 'wide';
    if (sceneName === 'lobby') return 'desk';
    if (sceneName !== 'case') return 'overlay';
    /* 창 폭이 아니라 캔버스 사각형으로 판정한다. window.innerWidth 를 읽지 않는 이유는
       패널 폭이 clamp(...,46vw,...) 라 같은 창 폭에서도 캔버스가 달라지기 때문이다. */
    if (h > 0 && h < 320 && w / Math.max(1, h) > 2.4) return 'stack';
    return 'split';
  }

  function applyQuality(q) {
    G.quality = q;
    if (!G.renderer) return;
    var w = G.w, h = G.h;
    var dpr = Math.min(window.devicePixelRatio || 1, DPR[q], MODE_CAP[G.mode] || 1.5);
    if (w * h * dpr * dpr > 2200000) dpr = Math.sqrt(2200000 / Math.max(1, w * h));
    G.renderer.setPixelRatio(Math.max(0.5, dpr));
    /* 라이트 개수는 절대 바꾸지 않는다 — 개수가 바뀌면 r134 가 모든 셰이더를 다시
       컴파일하고 크롬북에서 그 스톨은 수백 ms 다. intensity 만 건드린다. */
    if (G.lights) {
      G.lights.rim.intensity = [0.18, 0.28, 0.35][q];
      G.lights.desk.intensity = [0.30, 0.45, 0.55][q];
    }
    G.idleHz = [20, 30, 30][q];
  }

  function layout() {
    if (!G.renderer || !G.canvas) return;
    var r = safe(function () { return G.canvas.getBoundingClientRect(); }, null);
    var w = Math.max(1, Math.round(r ? r.width : 1));
    var h = Math.max(1, Math.round(r ? r.height : 1));
    G.w = w; G.h = h;
    G.mode = modeFor(G.sceneName, w, h);
    /* 밴드 높이가 0 으로 접히는 구간(세로 559px 이하)에서는 그릴 이유가 없다.
       실패가 아니라 일시 정지다 — data-three 는 건드리지 않는다. */
    if (h < 90) {
      G.renderer.setSize(w, h, false);
      G.offscreen = true;
      stopLoop();
      flatSync();
      return;
    }
    if (G.offscreen) { G.offscreen = false; startLoop(); }
    G.renderer.setSize(w, h, false);
    applyQuality(G.quality);

    var a = Math.max(0.35, w / h);
    var pre = CAM[G.mode];
    var fovY;
    if (pre.lock === 'v') fovY = pre.deg;
    else fovY = 2 * Math.atan(Math.tan(pre.deg * Math.PI / 360) / a) * 180 / Math.PI;
    G.cam.fov = clamp(fovY, 28, 54);
    G.cam.aspect = a;
    G.cam.updateProjectionMatrix();
    G.camBase = pre.pos;
    G.camLook = pre.look;
    /* 좁은 창에서 노직이 왼쪽으로 잘리지 않도록 스테이지를 안쪽으로 민다. */
    G.stage.position.x = (G.mode === 'overlay' || G.mode === 'wide' || G.mode === 'desk')
      ? clamp((1.45 - a) * 0.62, 0, 0.45) : 0;
    flatSync();
  }

  function applyPose(p) {
    var M = G.meshes;
    M.hips.position.y = p.hipsY;
    M.torso.rotation.x = p.torsoX;
    M.torso.rotation.y = p.torsoY;
    M.torsoMesh.scale.z = p.torsoSZ;
    M.head.rotation.x = p.headX;
    M.head.rotation.y = p.headY;
    M.browL.rotation.z = p.browL;
    M.browR.rotation.z = p.browR;
    M.browL.position.y = FACE.browY + p.browY;
    M.browR.position.y = FACE.browY + p.browY;
    M.eyes.scale.y = Math.max(0.05, p.eyesSY * G.blinkScale);
    M.armR.rotation.x = p.armRX; M.armR.rotation.y = p.armRY; M.armR.rotation.z = p.armRZ;
    M.elbowR.rotation.x = p.elbowRX;
    M.batonR.rotation.x = p.batonX;
    M.batonR.rotation.z = p.batonZ;
    M.armL.rotation.x = p.armLX; M.armL.rotation.y = p.armLY; M.armL.rotation.z = p.armLZ;
    M.elbowL.rotation.x = p.elbowLX;
    M.stamp.position.y = 1.075 + p.stampY;
    M.stamp.scale.y = p.stampSY;
    M.files.position.y = p.filesY;
    M.glasses.position.z = FACE.glassesZ + p.glassesZ;
    G.lights.key.intensity = 0.95 * p.keyMul;
    G.stage.position.z = p.stageZ;
    if (G.mats.lensMat) G.mats.lensMat.emissiveIntensity = Math.max(p.glintI, G.glintV);
  }

  function idlePose(out, base, t) {
    var red = isReduced();
    var bA = red ? 0.35 : 1;
    var per = red ? 5.0 : 3.6;
    var k;
    for (var i = 0; i < FIELDS.length; i++) { k = FIELDS[i]; out[k] = base[k]; }
    var ph = 2 * Math.PI * t / per;
    out.hipsY = base.hipsY + 0.0060 * bA * Math.sin(ph);
    out.torsoX = base.torsoX + 0.0120 * bA * Math.sin(ph + 0.40);
    out.torsoSZ = 1 + 0.0080 * bA * Math.sin(ph + 0.40);
    if (!red) {
      /* 주기가 서로 나누어떨어지지 않게 고른 숫자다. 공배수가 작으면 몇 초마다
         똑같은 모양으로 되돌아오고 사람 눈은 그 반복을 기계로 읽는다. */
      out.headY = base.headY + 0.045 * Math.sin(2 * Math.PI * t / 7.3);
      out.headX = base.headX + 0.020 * Math.sin(2 * Math.PI * t / 5.1);
      out.browL = base.browL + 0.020 * Math.sin(2 * Math.PI * t / 5.7);
      out.browR = base.browR - 0.020 * Math.sin(2 * Math.PI * t / 5.7);
      out.batonZ = base.batonZ + 0.020 * Math.sin(2 * Math.PI * t / 4.4);
    }
    return out;
  }

  function startTimeline(tlObj, hold) {
    G.fromPose = {};
    for (var i = 0; i < FIELDS.length; i++) G.fromPose[FIELDS[i]] = G.curPose[FIELDS[i]];
    G.timeline = tlObj;
    G.tlT = 0;
    G.blend = 1;
    G.blendDir = 0;
    G.hold = !!hold;
    G.idleFor = 0;
    G.throttleHz = 0;
    G.ink.t = -1;
    if (G.meshes.ink) { G.meshes.ink.visible = false; G.meshes.inkMat.opacity = 0; }
    if (!G.running) startLoop();
  }

  function tickInk(dt) {
    var M = G.meshes;
    if (!M.ink) return;
    if (G.ink.t < 0) return;
    G.ink.t += dt;
    var t = G.ink.t, o, s;
    if (G.ink.reduced) {
      /* 모션 감소에서는 스케일 팝을 없애고 투명도만 쓴다. */
      s = 1.12;
      o = (t < 0.36) ? 0.90 : 0.55 * (1 - clamp01((t - 0.47) / 1.6));
    } else if (t < 0.12) {
      o = 0.90; s = lerp(0.60, 1.00, smooth(t / 0.12));
    } else if (t < 0.36) {
      var u = (t - 0.12) / 0.24;
      o = lerp(0.90, 0.55, u); s = lerp(1.00, 1.12, u);
    } else {
      o = 0.55 * (1 - clamp01((t - 0.47) / 1.6)); s = 1.12;
    }
    M.inkMat.opacity = o;
    M.ink.scale.set(s, s, s);
    M.ink.visible = o > 0.004;
    if (o <= 0.004) G.ink.t = -1;
  }

  function tick(dt) {
    G.t += dt;

    /* 깜빡임 — 모션 감소에서도 유지한다. 없으면 마네킹이 된다. */
    if (G.blinkT >= 0) {
      G.blinkT += dt;
      var b = G.blinkT;
      if (b < 0.045) G.blinkScale = lerp(1, 0.08, b / 0.045);
      else if (b < 0.075) G.blinkScale = 0.08;
      else if (b < 0.120) G.blinkScale = lerp(0.08, 1, (b - 0.075) / 0.045);
      else { G.blinkScale = 1; G.blinkT = -1; G.blinkIn = 3.1 + Math.random() * 2.3; }
    } else {
      G.blinkIn -= dt;
      if (G.blinkIn <= 0) { G.blinkT = 0; }
    }

    /* 안경 반짝임 — 이 화면에서 "얼어붙지 않았다"는 유일한 신호다. */
    var red = isReduced();
    if (G.glintT >= 0) {
      G.glintT += dt;
      var peak = red ? 0.30 : 0.55;
      if (G.glintT < 0.18) G.glintV = peak * smooth(G.glintT / 0.18);
      else if (G.glintT < 0.45) G.glintV = peak * (1 - (G.glintT - 0.18) / 0.27);
      else { G.glintV = 0; G.glintT = -1; G.glintIn = (red ? 12 : 6.5) + Math.random() * (red ? 4 : 3); }
    } else {
      G.glintIn -= dt;
      if (G.glintIn <= 0) G.glintT = 0;
    }

    var idle = idlePose(G.scratchIdle, G.basePose, G.t);
    var p = G.curPose;
    var i, k;

    if (G.timeline) {
      G.tlT += dt;
      var tlp = evalTracks(G.timeline, G.fromPose, G.basePose, G.tlT, G.scratchTL);
      if (G.timeline.impactAt >= 0 && G.tlT >= G.timeline.impactAt && G.ink.t < 0 && G.timeline.mood === 'approve') {
        G.ink.t = 0; G.ink.reduced = red;
      }
      if (G.tlT >= G.timeline.dur) {
        if (G.hold) {
          for (i = 0; i < FIELDS.length; i++) { k = FIELDS[i]; p[k] = tlp[k]; }
        } else {
          /* 승인·반박이 자세로 남는다. 아래 blend 가 0.35 s 에 걸쳐 이 기준으로 내려앉는다. */
          G.basePose = restPose(G.poseName, G.timeline.mood);
          G.timeline = null;
          G.blendDir = -1;     /* 기준 자세로 0.35 s easeOut 복귀. 툭 끊기면 인형이 된다. */
          G.holdPose = {};
          for (i = 0; i < FIELDS.length; i++) { k = FIELDS[i]; G.holdPose[k] = tlp[k]; }
        }
      }
      if (G.timeline) {
        for (i = 0; i < FIELDS.length; i++) { k = FIELDS[i]; p[k] = tlp[k]; }
      }
    }
    if (!G.timeline) {
      if (G.blendDir < 0) {
        G.blend -= dt / 0.35;
        if (G.blend <= 0) { G.blend = 0; G.blendDir = 0; }
        var w = easeOut(clamp01(G.blend));
        for (i = 0; i < FIELDS.length; i++) { k = FIELDS[i]; p[k] = lerp(idle[k], G.holdPose[k], w); }
      } else {
        for (i = 0; i < FIELDS.length; i++) { k = FIELDS[i]; p[k] = idle[k]; }
        G.idleFor += dt;
      }
    }

    tickInk(dt);
    applyPose(p);

    /* 카메라 — idle 에서는 절대 움직이지 않는다. 학생이 패널의 한국어 세 문장을
       읽는 동안 배경이 흔들리면 안 된다. 킥은 임팩트 순간의 1.2 device px 뿐이다. */
    var cb = G.camBase, cl = G.camLook;
    G.cam.position.set(cb[0], cb[1] + p.camKY, cb[2] + p.camKZ);
    G.cam.lookAt(cl[0], cl[1], cl[2]);
  }

  function frame(now) {
    G.raf = requestAnimationFrame(frame);
    var dt = G.lastFrame ? (now - G.lastFrame) / 1000 : 0.016;
    var hz = G.throttleHz;
    if (!G.timeline && G.idleFor > 0.6) hz = isReduced() ? 15 : G.idleHz;
    if (hz && (now - G.lastDraw) < (1000 / hz) - 1) return;
    G.lastDraw = now; G.lastFrame = now;
    if (dt > 0.1) dt = 0.1;
    /* 매 프레임 예외를 뿜는 3D 는 교실에서 콘솔만 채우고 아무것도 못 그린다.
       몇 번 연속으로 실패하면 조용히 2D 로 내려간다 — 수업은 계속돼야 한다. */
    try {
      tick(dt);
      G.renderer.render(G.scene, G.cam);
      G.tickErrors = 0;
    } catch (e) {
      G.tickErrors = (G.tickErrors || 0) + 1;
      if (G.tickErrors > 8) goFlat(true);
      return;
    }
    G.frames++;
    /* 자동 품질 사다리. 컨텍스트 소실 중의 프레임은 이 GPU 에 대한 증거가 아니다. */
    if (!G.contextLost) {
      G.perfAcc += dt; G.perfN++; G.perfCool -= dt;
      if (G.perfN >= 45) {
        var avg = G.perfAcc / G.perfN; G.perfAcc = 0; G.perfN = 0;
        if (G.perfCool <= 0) {
          if (avg > 1 / 26 && G.quality > 0) { applyQuality(G.quality - 1); G.perfCool = 3; }
          else if (avg < 1 / 55 && G.quality < 2) { applyQuality(G.quality + 1); G.perfCool = 6; }
        }
      }
    }
  }

  function startLoop() {
    if (G.running || !G.renderer) return;
    if (G.paused || G.hidden || G.offscreen) return;
    G.running = true;
    G.lastFrame = 0; G.lastDraw = 0;
    G.raf = requestAnimationFrame(frame);
  }
  function stopLoop() {
    if (G.raf) cancelAnimationFrame(G.raf);
    G.raf = 0; G.running = false; G.lastFrame = 0;
  }

  function probeWebGL() {
    /* 반드시 별도의 임시 캔버스로 프로브하고 컨텍스트를 반납한다.
       실제 캔버스에서 프로브하면 그 컨텍스트가 점유되어 렌더러 생성이 실패한다. */
    try {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return false;
      var ext = gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
      return true;
    } catch (e) { return false; }
  }

  function setThreeAttr(on) {
    try {
      var root = document.getElementById('nz-root');
      if (root) root.setAttribute('data-three', on ? 'on' : 'off');
    } catch (e) { }
  }

  function buildThree(canvas) {
    TH = window.THREE;
    G.canvas = canvas;

    var creationFailed = false;
    var onCreateErr = function () { creationFailed = true; };
    on(canvas, 'webglcontextcreationerror', onCreateErr);

    G.renderer = new TH.WebGLRenderer({
      canvas: canvas, antialias: true, alpha: false, stencil: false, depth: true,
      preserveDrawingBuffer: false, powerPreference: 'low-power'
    });
    if (creationFailed || !G.renderer.getContext()) return false;

    G.renderer.shadowMap.enabled = false;             /* 드로우콜이 두 배가 되고 얻는 그림이 없다 */
    G.renderer.outputEncoding = TH.sRGBEncoding;      /* r134 — outputColorSpace 는 없다 */
    G.renderer.toneMapping = TH.ACESFilmicToneMapping;
    G.renderer.toneMappingExposure = 1.05;

    G.scene = new TH.Scene();
    G.scene.background = new TH.Color(C.BG);
    G.scene.fog = new TH.Fog(C.BG, 2.4, 5.2);

    G.cam = new TH.PerspectiveCamera(45, 1.6, 0.1, 40);
    G.camBase = CAM.overlay.pos; G.camLook = CAM.overlay.look;

    var matBody = keepMat(new TH.MeshLambertMaterial({ vertexColors: true }));
    var matBoard = keepMat(new TH.MeshLambertMaterial({ color: C.BOARD, map: chalkTexture(), transparent: true }));
    var matLens = keepMat(new TH.MeshPhongMaterial({
      color: 0x121d36, emissive: 0x5a9ae0, emissiveIntensity: 0,
      transparent: true, opacity: 0.55, shininess: 90
    }));
    G.mats.lensMat = matLens;

    G.stage = new TH.Group();
    G.scene.add(G.stage);
    G.stage.add(buildSet(matBody, matBoard));
    G.rig = buildRig(matBody, matLens);
    G.stage.add(G.rig);

    var amb = new TH.AmbientLight(C.AMB, 0.55);
    var key = new TH.DirectionalLight(C.KEY, 0.95);
    key.position.set(-2.20, 3.00, 2.40);
    var rim = new TH.DirectionalLight(C.RIM, 0.35);
    rim.position.set(1.80, 1.60, -2.20);
    var desk = new TH.PointLight(0xffc27a, 0.55, 3.2, 2);
    desk.position.set(-1.78, 1.29, 0.12);
    G.scene.add(amb); G.scene.add(key); G.scene.add(rim); G.scene.add(desk);
    G.lights = { amb: amb, key: key, rim: rim, desk: desk };

    G.basePose = poseBase('idle');
    G.curPose = poseBase('idle');
    G.scratchIdle = poseBase('idle');
    G.scratchTL = poseBase('idle');
    G.holdPose = poseBase('idle');
    G.blinkScale = 1;
    G.glintV = 0;

    var q = 1;
    if ((window.devicePixelRatio || 1) > 1.5 && G.canvas.clientWidth >= 1280) q = 2;
    if ((navigator.hardwareConcurrency || 4) <= 2) q = 0;
    applyQuality(q);
    layout();
    return true;
  }

  function bindThreeEvents() {
    if (window.ResizeObserver) {
      G.ro = new ResizeObserver(function () { layout(); });
      safe(function () { G.ro.observe(G.canvas); }, null);
    } else {
      /* 구형 환경 폴백. resize() 공개 메서드가 언제나 강제 갱신 경로로 남는다. */
      on(window, 'resize', function () { layout(); });
    }
    if (window.IntersectionObserver) {
      G.io = new IntersectionObserver(function (es) {
        for (var i = 0; i < es.length; i++) {
          G.offscreen = !es[i].isIntersecting;
        }
        if (G.offscreen) stopLoop(); else startLoop();
      }, { threshold: 0 });
      safe(function () { G.io.observe(G.canvas); }, null);
    }
    on(document, 'visibilitychange', function () {
      G.hidden = !!document.hidden;
      if (G.hidden) stopLoop();
      else { G.lastFrame = 0; startLoop(); }
    });
    on(G.canvas, 'webglcontextlost', function (e) {
      if (e && e.preventDefault) e.preventDefault();
      G.contextLost = true;
      stopLoop();
      goFlat(false);
      if (G.lostTimer) clearTimeout(G.lostTimer);
      /* 12 초 안에 복구되지 않으면 영구 폴백. 수업 중에 계속 기다리게 두지 않는다. */
      G.lostTimer = setTimeout(function () { G.lostTimer = 0; if (G.contextLost) goFlat(true); }, 12000);
    });
    on(G.canvas, 'webglcontextrestored', function () {
      G.contextLost = false;
      if (G.lostTimer) { clearTimeout(G.lostTimer); G.lostTimer = 0; }
      /* 영구 폴백만 되돌리지 않는다. 그 판정은 renderer 가 남아 있는지로 한다 —
         api.mode 로 보면 일시 폴백인 goFlat(false) 도 mode 를 'flat' 으로 내리므로
         이 분기가 언제나 참이 되어 복구된 컨텍스트로 영영 돌아오지 못한다.
         (SwiftShader 를 쓰는 저사양 크롬북은 시작 직후 컨텍스트를 한 번
          잃었다가 곧바로 복구하는 일이 잦다 — 그때마다 3D 를 버리게 된다.) */
      if (!G.renderer) return;
      backToThree();
    });
    /* data-motion 의 주인은 ui.js 다. 값이 바뀌면 즉시 따라간다. */
    try {
      var root = document.getElementById('nz-root');
      if (root && window.MutationObserver) {
        motionAttr = root.getAttribute('data-motion');
        G.mo = new MutationObserver(function () {
          motionAttr = root.getAttribute('data-motion');
          onMotionChanged();
        });
        G.mo.observe(root, { attributes: true, attributeFilter: ['data-motion'] });
      } else if (root) {
        motionAttr = root.getAttribute('data-motion');
      }
    } catch (e) { }
    /* 3 초 워치독 — 보이는데 한 프레임도 안 그려졌다면 살아 있는 게 아니다. */
    G.watchdog = setTimeout(function () {
      G.watchdog = 0;
      if (api.mode !== 'three') return;
      if (document.hidden || G.offscreen || G.paused || G.h < 90) return;
      if (G.frames === 0) goFlat(true);
    }, 3000);
  }

  /* 3D 를 내려놓고 폴백으로 간다. permanent=true 면 GPU 자원까지 정리한다. */
  function goFlat(permanent) {
    flatBuild();
    api.ok = false;
    api.mode = 'flat';
    setThreeAttr(false);
    stopLoop();
    flatShow(true);
    flatSetPose(G.poseName || 'idle');
    flatScene(G.sceneName || 'lobby');
    if (permanent) {
      disposeThree();
      api.mode = 'flat';
    }
  }

  function backToThree() {
    if (!G.renderer) return;
    api.ok = true;
    api.mode = 'three';
    setThreeAttr(true);
    flatShow(false);
    layout();
    startLoop();
  }

  function disposeThree() {
    stopLoop();
    if (G.watchdog) { clearTimeout(G.watchdog); G.watchdog = 0; }
    if (G.lostTimer) { clearTimeout(G.lostTimer); G.lostTimer = 0; }
    try { if (G.ro) G.ro.disconnect(); } catch (e) { }
    try { if (G.io) G.io.disconnect(); } catch (e) { }
    try { if (G.mo) G.mo.disconnect(); } catch (e) { }
    G.ro = null; G.io = null; G.mo = null;
    var i;
    for (i = 0; i < G.geoms.length; i++) { try { G.geoms[i].dispose(); } catch (e) { } }
    for (i = 0; i < G.mats.length; i++) { try { G.mats[i].dispose(); } catch (e) { } }
    for (i = 0; i < G.textures.length; i++) { try { G.textures[i].dispose(); } catch (e) { } }
    G.geoms.length = 0; G.mats.length = 0; G.textures.length = 0;
    G.mats.lensMat = null;
    if (G.renderer) {
      try { G.renderer.dispose(); } catch (e) { }
      /* forceContextLoss 까지 해야 크롬이 컨텍스트를 실제로 반납한다.
         init/dispose 를 20번 반복해도 컨텍스트가 새지 않아야 한다(계약 §8.5). */
      try { G.renderer.forceContextLoss(); } catch (e) { }
    }
    G.renderer = null; G.scene = null; G.cam = null; G.stage = null; G.rig = null;
    G.lights = null; G.meshes = {}; G.timeline = null;
  }

  /* ========================================================================
     파사드 — ui.js 가 보는 유일한 얼굴. 3D 든 폴백이든 여기서 나가는 값은 같다.
     ====================================================================== */
  var inited = false;
  var cur = { mood: 'idle', endAt: 0, variant: 0 };

  var api = {
    ok: false,
    mode: 'flat',

    init: function (canvasEl) {
      if (inited) return api.ok;
      inited = true;
      try {
        var canvas = canvasEl || document.getElementById('nz-gl');
        flatBuild();                       /* 폴백 뼈대는 성공하든 실패하든 미리 만들어 둔다 */
        var three = false;
        if (canvas && typeof window.THREE !== 'undefined' && window.THREE.WebGLRenderer && probeWebGL()) {
          three = safe(function () { return buildThree(canvas); }, false);
          if (three) { bindThreeEvents(); }
          else { disposeThree(); }
        }
        if (three) {
          api.ok = true;
          api.mode = 'three';
          flatShow(false);
          startLoop();
        } else {
          goFlat(true);
        }
      } catch (e) {
        /* init 은 절대 throw 하지 않는다. 여기서 던지면 boot.js 가 끊기고
           게임 전체가 시작조차 못 한다. */
        safe(function () { goFlat(true); }, null);
        api.ok = false;
        api.mode = 'flat';
      }
      return api.ok;
    },

    react: function (mood, opts) {
      var o = opts || {};
      var reduced = isReduced();
      if (mood !== 'approve' && mood !== 'rebut') {
        /* 알 수 없는 mood 는 조용히 무시한다. 콘솔 경고도 남기지 않는다 —
           수업 중 콘솔 노이즈는 교사에게 "뭔가 고장났다"로 읽힌다. */
        return REACT_MIN;
      }
      var now = Date.now();
      var forced = (o.variant === undefined) ? null : o.variant;
      if (mood === cur.mood && now < cur.endAt && forced === null) {
        /* 같은 반응을 다시 요청하면 재생하지 않고 남은 시간만 돌려준다.
           맞힐 때까지 반복 재생하지 않는다(R10). */
        return Math.max(REACT_MIN, Math.round(cur.endAt - now));
      }
      var seed = (typeof o.seed === 'number' && isFinite(o.seed)) ? o.seed : 0;
      var streak = (typeof o.streak === 'number' && isFinite(o.streak)) ? o.streak : 0;
      var variant = pickVariant(mood, seed, streak, forced, reduced);
      var ms = reactMs(mood, variant, reduced);

      cur.mood = mood; cur.variant = variant; cur.endAt = now + ms;

      if (api.mode === 'three' && G.renderer) {
        var tlObj = (mood === 'approve') ? buildApprove(variant, reduced, seed) : buildRebut(variant, reduced, seed);
        safe(function () { startTimeline(tlObj, !!o.hold); }, null);
      } else {
        safe(function () { flatPlay(mood, variant, ms, !!o.hold); }, null);
      }
      return ms;
    },

    setPose: function (name) {
      if (name !== 'idle' && name !== 'ready' && name !== 'review') name = 'idle';
      G.poseName = name;
      cur.mood = 'idle';
      cur.endAt = 0;
      if (api.mode === 'three' && G.renderer) {
        G.basePose = poseBase(name);
        G.timeline = null;
        G.blendDir = 0;
        G.blend = 0;
        G.idleFor = 0;
        /* 즉시 확정이다 — 애니메이션도, 도장 소리도, 지휘봉 타격도 없다. */
        if (G.meshes.ink) { G.ink.t = -1; G.meshes.ink.visible = false; G.meshes.inkMat.opacity = 0; }
        if (!G.running) startLoop();
      } else {
        safe(function () { flatSetPose(name); }, null);
      }
    },

    setScene: function (name) {
      if (name !== 'start' && name !== 'lobby' && name !== 'case' && name !== 'result') name = 'lobby';
      G.sceneName = name;
      flat.scene = name;
      if (api.mode === 'three' && G.renderer) layout();
      else safe(function () { flatScene(name); }, null);
    },

    resize: function () {
      if (api.mode === 'three' && G.renderer) layout();
      else safe(flatSync, null);
    },

    pause: function () {
      G.paused = true;
      stopLoop();
      /* 멈추기 전에 한 프레임만 더 그린다. setScene() 직후 곧바로 pause() 가
         불리면(결과 화면이 그렇다) 새 카메라가 한 번도 렌더되지 않아
         캔버스에 이전 화면이 남거나 통째로 비어 버린다. */
      if (api.mode === 'three' && G.renderer && !G.offscreen && G.w > 1 && G.h > 1) {
        try {
          tick(0);
          G.renderer.render(G.scene, G.cam);
        } catch (e) {
          /* 마지막 한 장을 못 그렸다고 화면을 죽이지 않는다. */
        }
      }
      flatPause(true);
    },

    resume: function () {
      G.paused = false;
      flatPause(false);
      if (api.mode === 'three' && G.renderer) { G.lastFrame = 0; startLoop(); }
    },

    dispose: function () {
      disposeThree();
      flatDispose();
      offAll();
      api.ok = false;
      api.mode = 'flat';
      inited = false;
      cur.mood = 'idle'; cur.endAt = 0;
    },

    /* 비공개 진단 훅. ui.js 는 호출하지 않는다 — 브라우저 콘솔에서 성능 예산을 볼 때만 쓴다. */
    _probe: function () {
      var info = (G.renderer && G.renderer.info) ? G.renderer.info : null;
      return {
        mode: api.mode, ok: api.ok, quality: G.quality, layoutMode: G.mode,
        w: G.w, h: G.h, running: G.running, reduced: isReduced(),
        calls: info ? info.render.calls : 0,
        triangles: info ? info.render.triangles : 0,
        programs: (info && info.programs) ? info.programs.length : 0
      };
    }
  };

  window.NZ.Court = api;
})();
