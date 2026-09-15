/* =====================================================================
   TEST RUNNER  -  node SR2/NZ/src/test/run.js
   의존성 0. 외부 패키지 0. 실패가 하나라도 있으면 종료 코드 1.

   왜 이 형태인가
   ---------------------------------------------------------------------
   · 교실 배포물(index.html)은 번들러 없이 IIFE 를 이어 붙여 만든다.
     그래서 테스트도 번들러·프레임워크 없이 node 기본 모듈(vm)만으로
     src/*.js 를 "가짜 브라우저" 안에서 평가해 검사한다.
   · 이 파일은 assemble.js 의 JS_ORDER 에 들어가지 않는다. 즉 배포물에
     섞이지 않으므로 여기서는 require() 를 써도 된다(게임 모듈은 금지).
   · document 를 일부러 주지 않는다. state.js 가 document 를 참조하면
     그 자리에서 ReferenceError 로 죽는다 — 계약 §5·§15 가 요구하는 검사가
     별도 코드 없이 성립한다.
   · 모듈이 아직 없으면 건너뛰지 않고 실패로 보고한다. 병렬 구현 중에
     "초록불인데 파일이 없다"가 가장 위험하다.

   검사 근거
   ---------------------------------------------------------------------
   docs/00-요구사항-원본.md §8 (완료 판정), 교사 최종 판정 R1~R10,
   docs/07-인터페이스-계약.md §13(T-01~T-14)·§5.8(I1~I9)·§4.3(화이트리스트).
   ===================================================================== */

'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var SRC_DIR = path.resolve(__dirname, '..');            // .../SR2/NZ/src

/* 빌드 순서 = 전역 정의 순서. 소스 계약 검사(G9)가 이 목록을 돈다. */
var MODULES = ['cases.js', 'copy.js', 'state.js', 'audio.js', 'court3d.js', 'ui.js', 'boot.js'];

/* R7 — window.NZ 아래 허용되는 이름은 이 8개가 전부다. */
var ALLOWED_GLOBALS = ['CASES', 'COPY', 'CONFIG', 'State', 'Audio', 'Court', 'UI', 'start'];

/* 06 §2-1 [심각] / 계약 §4.3 — 화면에 나가면 안 되는 문자열. */
var BANNED_SCREEN = [
  { re: /정답/, label: '정답' },
  { re: /오답/, label: '오답' },
  { re: /맞았습니다/, label: '맞았습니다' },
  { re: /틀렸습니다/, label: '틀렸습니다' },
  { re: /\bCorrect\b/i, label: 'Correct' },
  { re: /\bWrong\b/i, label: 'Wrong' },
  { re: /APPROVED/i, label: 'APPROVED' },
  { re: /롤스/, label: '롤스' },
  { re: /\bRawls\b/i, label: 'Rawls' }
];

/* 요구사항 §3 마지막 문단 — 점수를 정치 성향으로 읽히게 하는 표현.
   "정치 성향"이라는 말 자체는 해명 문구에도 쓰일 수 있으므로,
   학생을 어떤 진영으로 분류하는 표현만 좁게 잡는다. */
var BANNED_POLITICS = [
  { re: /롤스/, label: '롤스' },
  { re: /\bRawls\b/i, label: 'Rawls' },
  { re: /좌파|우파/, label: '좌파/우파' },
  { re: /보수\s*성향|진보\s*성향|성향입니다|성향이야|성향이다/, label: '성향 단정' }
];

/* ============================================================ 하네스 */

var passCount = 0;
var failCount = 0;
var failures = [];
var currentGroup = '(그룹 없음)';

function show(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (v === undefined) return 'undefined';
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg);
}

function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(msg + '\n기대: ' + show(expected) + '\n실제: ' + show(actual));
  }
}

function group(title, fn) {
  currentGroup = title;
  console.log('');
  console.log(title);
  console.log('  ' + repeat('-', 62));
  try {
    fn();
  } catch (e) {
    /* 그룹 준비 단계가 무너져도 "조용히 0건"이 되면 안 된다. */
    failCount++;
    console.log('  ✗ (그룹 전체 중단)');
    console.log('      ' + indent((e && e.message) || String(e)));
    failures.push(title + ' :: 그룹 전체 중단 :: ' + ((e && e.message) || String(e)));
  }
}

function test(name, fn) {
  try {
    fn();
    passCount++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failCount++;
    console.log('  ✗ ' + name);
    console.log('      ' + indent((e && e.message) || String(e)));
    failures.push(currentGroup + ' :: ' + name + ' :: ' + ((e && e.message) || String(e)));
  }
}

function indent(s) {
  return String(s).split('\n').join('\n      ');
}

function repeat(s, n) {
  var out = '';
  for (var i = 0; i < n; i++) out += s;
  return out;
}

/* ============================================================ 샌드박스 */

function readModule(file) {
  var p = path.join(SRC_DIR, file);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

/* localStorage 스텁. mode==='throw' 면 모든 접근이 던진다
   (크롬 시크릿 모드·사이트 데이터 차단·용량 초과를 흉내 낸다). */
function makeLocalStorage(store, mode) {
  function guard() {
    if (mode === 'throw') throw new Error('localStorage 접근이 차단되었다(테스트 스텁)');
  }
  var ls = {
    getItem: function (k) {
      guard();
      return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
    },
    setItem: function (k, v) { guard(); store[k] = String(v); },
    removeItem: function (k) { guard(); delete store[k]; },
    clear: function () { guard(); Object.keys(store).forEach(function (k) { delete store[k]; }); },
    key: function (i) { guard(); return Object.keys(store)[i] === undefined ? null : Object.keys(store)[i]; }
  };
  Object.defineProperty(ls, 'length', {
    get: function () { guard(); return Object.keys(store).length; }
  });
  return ls;
}

function noop() {}

/* document 를 넣지 않는 것이 이 샌드박스의 핵심이다. */
function mkSandbox(opts) {
  opts = opts || {};
  var store = opts.store || {};
  var log = [];
  var ls = makeLocalStorage(store, opts.storage || 'ok');
  var win = {
    localStorage: ls,
    addEventListener: noop,
    removeEventListener: noop
  };
  var ctx = {
    window: win,
    localStorage: ls,
    console: {
      log: noop,
      info: noop,
      debug: noop,
      warn: function () { log.push('warn: ' + Array.prototype.join.call(arguments, ' ')); },
      error: function () { log.push('error: ' + Array.prototype.join.call(arguments, ' ')); }
    },
    setTimeout: function () { return 0; },
    clearTimeout: noop,
    setInterval: function () { return 0; },
    clearInterval: noop
  };
  vm.createContext(ctx);
  return { ctx: ctx, win: win, ls: ls, store: store, log: log };
}

function load(sb, files) {
  files.forEach(function (f) {
    var src = readModule(f);
    if (src === null) {
      throw new Error('src/' + f + ' 이 아직 없다. (구현 전이면 이 그룹은 실패가 맞다 — 건너뛰지 않는다)');
    }
    try {
      new vm.Script(src, { filename: 'src/' + f }).runInContext(sb.ctx);
    } catch (e) {
      throw new Error('src/' + f + ' 평가 실패: ' + ((e && e.message) || String(e)));
    }
  });
}

/* cases.js 만 필요한 검사용. 여기서 실패하면 뒤 그룹 전체가 의미를 잃는다. */
function loadCases() {
  var sb = mkSandbox({});
  load(sb, ['cases.js']);
  var CASES = (sb.win.NZ || {}).CASES;
  ok(Array.isArray(CASES), 'window.NZ.CASES 배열이 만들어지지 않았다');
  return CASES;
}

function loadCopy() {
  var sb = mkSandbox({});
  load(sb, ['cases.js', 'copy.js']);
  var COPY = (sb.win.NZ || {}).COPY;
  ok(COPY && typeof COPY === 'object', 'window.NZ.COPY 객체가 만들어지지 않았다');
  return COPY;
}

/* state.js 는 cases.js 만 읽는다(계약 §5). copy.js 를 일부러 주지 않아
   의존 방향이 거꾸로 되면 여기서 바로 드러나게 한다. */
function bootState(opts) {
  var sb = mkSandbox(opts);
  load(sb, ['cases.js', 'state.js']);
  var NZ = sb.win.NZ || {};
  ok(NZ.State && typeof NZ.State === 'object', 'window.NZ.State 가 만들어지지 않았다');
  ok(NZ.CONFIG && typeof NZ.CONFIG === 'object', 'window.NZ.CONFIG 가 만들어지지 않았다');
  return { sb: sb, S: NZ.State, C: NZ.CONFIG, CASES: NZ.CASES, store: sb.store, log: sb.log };
}

/* 새 판 시작 상태의 State. */
function freshState(opts) {
  var h = bootState(opts);
  h.S.init();
  h.S.startFresh();
  return h;
}

/* ============================================================ 유틸 */

function chars(s) {
  /* 서러게이트 페어를 1자로 센다. 이모지는 안 쓰지만 세는 법은 맞춰 둔다. */
  return Array.from(String(s)).length;
}

/* 04 §13.1 은 제목 상한을 "24자(한글 환산 22em)"로 적고,
   c06 제목(27자, 20.5em)을 상한 안이라고 명시적으로 검증해 두었다.
   즉 실제 계약은 글자 수가 아니라 가로 폭이다. 숫자·공백·쉼표는 반각이므로
   코드포인트로 세면 설계 문서가 통과시킨 제목이 떨어진다. 폭으로 잰다. */
function emWidth(s) {
  var w = 0;
  Array.from(String(s)).forEach(function (ch) {
    var c = ch.codePointAt(0);
    var wide =
      (c >= 0x1100 && c <= 0x11ff) ||   // 한글 자모
      (c >= 0x2e80 && c <= 0x303e) ||   // CJK 부수·한중일 기호
      (c >= 0x3041 && c <= 0x33ff) ||   // 가나·호환 자모·한글 호환
      (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0x4e00 && c <= 0x9fff) ||   // 한자
      (c >= 0xac00 && c <= 0xd7a3) ||   // 한글 음절
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||   // 전각
      (c >= 0xffe0 && c <= 0xffe6);
    w += wide ? 1 : 0.5;
  });
  return w;
}

function stripMarks(s) {
  return String(s).replace(/\[\[|\]\]/g, '');
}

function optionOf(c, id) {
  var found = null;
  (c.options || []).forEach(function (o) { if (o && o.id === id) found = o; });
  return found;
}

function wrongIdOf(c) {
  var wrong = null;
  (c.options || []).forEach(function (o) { if (o && o.id !== c.answerId) wrong = o.id; });
  return wrong;
}

function walkStrings(node, cb, where) {
  if (typeof node === 'string') { cb(node, where); return; }
  if (typeof node === 'function') return;
  if (Array.isArray(node)) {
    node.forEach(function (v, i) { walkStrings(v, cb, where + '[' + i + ']'); });
    return;
  }
  if (node && typeof node === 'object') {
    Object.keys(node).forEach(function (k) {
      walkStrings(node[k], cb, where ? where + '.' + k : k);
    });
  }
}

/* 주석 안의 낱말이 금지 문구 검사에 걸리면 안 된다(주석은 화면에 안 나간다).
   문자열 상태를 추적하며 // 와 /* *\/ 를 지운다. */
function stripComments(src) {
  var out = '';
  var i = 0;
  var n = src.length;
  var quote = null;
  while (i < n) {
    var ch = src.charAt(i);
    var nx = src.charAt(i + 1);
    if (quote) {
      if (ch === '\\') { out += '  '; i += 2; continue; }
      if (ch === quote) { quote = null; }
      out += ch; i++; continue;
    }
    if (ch === '/' && nx === '*') {
      var e = src.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      out += ' ';
      continue;
    }
    if (ch === '/' && nx === '/') {
      var e2 = src.indexOf('\n', i);
      i = e2 < 0 ? n : e2;
      out += ' ';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; i++; continue; }
    out += ch; i++;
  }
  return out;
}

/* ============================================================ G1 사건 데이터 구조 (T-01) */

group('G1 · 사건 데이터 구조  (T-01 / 요구 §8, R1)', function () {
  var CASES = loadCases();

  test('사건이 정확히 10개다', function () {
    eq(CASES.length, 10, '사건 수가 10개가 아니다');
  });

  test('사건 id 가 중복되지 않는다', function () {
    var seen = {};
    CASES.forEach(function (c, i) {
      ok(c && typeof c.id === 'string' && c.id, i + '번째 사건에 id 가 없다');
      ok(!seen[c.id], '사건 id 중복 -> ' + c.id);
      seen[c.id] = true;
    });
  });

  test('각 사건의 선택지가 정확히 2개다', function () {
    CASES.forEach(function (c) {
      ok(Array.isArray(c.options), c.id + ': options 가 배열이 아니다');
      eq(c.options.length, 2, c.id + ': 선택지가 2개가 아니다');
      c.options.forEach(function (o, i) {
        ok(o && typeof o.id === 'string' && o.id, c.id + ': ' + i + '번 선택지에 id 가 없다');
        ok(typeof o.text === 'string' && o.text.trim(), c.id + ': ' + o.id + ' 의 text 가 비었다');
      });
    });
  });

  test('선택지 id 가 전역에서 중복되지 않는다', function () {
    var seen = {};
    CASES.forEach(function (c) {
      (c.options || []).forEach(function (o) {
        ok(!seen[o.id], '선택지 id 중복 -> ' + o.id + ' (' + seen[o.id] + ' 와 ' + c.id + ')');
        seen[o.id] = c.id;
      });
    });
  });

  test('모든 answerId 가 그 사건의 실제 선택지 안에 있다  (I8)', function () {
    CASES.forEach(function (c) {
      ok(typeof c.answerId === 'string' && c.answerId, c.id + ': answerId 가 없다');
      ok(optionOf(c, c.answerId), c.id + ': answerId(' + c.answerId + ') 가 선택지에 없다');
    });
  });

  test('선택지 id 가 위치 의존적이지 않다  (R1)', function () {
    CASES.forEach(function (c) {
      (c.options || []).forEach(function (o) {
        var id = String(o.id);
        ok(!/^[abAB12]$/.test(id), c.id + ': 위치 의존 선택지 id -> ' + id);
        ok(!/(^|[-_])o?[12]$/.test(id), c.id + ': 순번으로 만든 선택지 id -> ' + id);
        ok(!/(^|[-_])(a|b|first|second|left|right)$/i.test(id), c.id + ': 위치 라벨 선택지 id -> ' + id);
      });
    });
  });

  test('선택지 id 가 사건 id 로 네임스페이스된 내용 기반 ID 다  (R1)', function () {
    CASES.forEach(function (c) {
      (c.options || []).forEach(function (o) {
        ok(o.id.indexOf(c.id + '-') === 0,
          c.id + ': 선택지 id 가 "' + c.id + '-" 로 시작하지 않는다 -> ' + o.id);
        var tail = o.id.slice(c.id.length + 1);
        ok(/[a-z]{2,}/.test(tail), c.id + ': 선택지 id 뒤쪽이 내용을 가리키지 않는다 -> ' + o.id);
      });
    });
  });

  test('사건 번호 n 이 1..10 이고 배열 순서와 같다', function () {
    CASES.forEach(function (c, i) {
      eq(c.n, i + 1, c.id + ': n 이 배열 순서와 다르다');
    });
  });
});

/* ============================================================ G2 사건 텍스트 무결성 */

group('G2 · 사건 텍스트 무결성  (요구 §8, 06 §3)', function () {
  var CASES = loadCases();

  test('situation / title / reason / wrongLine / concept 가 비어 있지 않다', function () {
    CASES.forEach(function (c) {
      ['title', 'reason', 'wrongLine', 'concept', 'conceptKo', 'question'].forEach(function (f) {
        ok(typeof c[f] === 'string' && c[f].trim(), c.id + ': ' + f + ' 가 비었다');
      });
      ok(Array.isArray(c.situation) && c.situation.length >= 2 && c.situation.length <= 3,
        c.id + ': situation 이 2~3문장이 아니다');
      c.situation.forEach(function (s, i) {
        ok(typeof s === 'string' && s.trim(), c.id + ': situation[' + i + '] 이 비었다');
      });
      ok(c.hook === null || (typeof c.hook === 'string' && c.hook.trim()),
        c.id + ': hook 은 null 이거나 비지 않은 문자열이어야 한다');
    });
  });

  test('[[ ]] 하이라이트 짝이 맞고 중첩이 없다', function () {
    CASES.forEach(function (c) {
      var text = (c.situation || []).join(' ');
      var depth = 0;
      var marks = 0;
      var i = 0;
      while (i < text.length) {
        if (text.substr(i, 2) === '[[') {
          depth++;
          ok(depth === 1, c.id + ': [[ ]] 가 중첩되었다');
          i += 2;
          continue;
        }
        if (text.substr(i, 2) === ']]') {
          depth--;
          ok(depth === 0, c.id + ': 열리지 않은 ]] 이 있다');
          marks++;
          i += 2;
          continue;
        }
        i++;
      }
      eq(depth, 0, c.id + ': 닫히지 않은 [[ 가 있다');
      ok(marks >= 2 && marks <= 3, c.id + ': 하이라이트가 ' + marks + '개다 (2~3개여야 한다)');
      /* 빈 강조는 렌더러에서 빈 <mark> 가 된다. */
      ok(!/\[\[\s*\]\]/.test(text), c.id + ': 내용 없는 [[ ]] 가 있다');
    });
  });

  test('선택지 텍스트에는 [[ ]] 를 쓰지 않는다  (강조된 쪽을 고르는 편향 방지)', function () {
    CASES.forEach(function (c) {
      (c.options || []).forEach(function (o) {
        ok(o.text.indexOf('[[') < 0 && o.text.indexOf(']]') < 0,
          c.id + ': 선택지 ' + o.id + ' 에 [[ ]] 가 있다');
      });
    });
  });

  test('wrongLine 이 사건마다 서로 다르다  (요구 §5: 공용 한 줄로 때우지 않는다)', function () {
    var seen = {};
    CASES.forEach(function (c) {
      var line = c.wrongLine.trim();
      ok(!seen[line], 'wrongLine 중복 -> ' + seen[line] + ' 과 ' + c.id + ': ' + line);
      seen[line] = c.id;
    });
    eq(Object.keys(seen).length, CASES.length, '서로 다른 wrongLine 이 사건 수보다 적다');
  });

  test('wrongLine 이 학생의 인격이 아니라 판단 근거를 겨냥한다', function () {
    var slurs = [/바보/, /멍청/, /한심/, /어리석/, /수준/, /정신/];
    CASES.forEach(function (c) {
      slurs.forEach(function (re) {
        ok(!re.test(c.wrongLine), c.id + ': wrongLine 에 인신 공격성 표현 -> ' + c.wrongLine);
      });
    });
  });

  test('사건 데이터 문자열에 화면 금지 문자열이 없다  (T-09 / 06 §2-1)', function () {
    CASES.forEach(function (c) {
      walkStrings(c, function (s, where) {
        BANNED_SCREEN.forEach(function (b) {
          ok(!b.re.test(s), c.id + '.' + where + ' 에 금지 문자열 "' + b.label + '" -> ' + s);
        });
      }, '');
    });
  });
});

/* ============================================================ G3 대조쌍 판단 분리 (T-14) */

/* 왜 정답 "텍스트"를 보는가:
   answerId 만 비교하면 데이터에서 정답을 반대쪽으로 옮겨도 테스트가 통과한다.
   요구 §8 이 잡으라는 회귀는 "두 사건의 정답이 같은 방향이 되어 버리는 것"이므로,
   정답 선택지의 본문이 어느 방향을 말하는지를 직접 읽어야 한다.
   축이 쌍마다 달라서(01/07 = 소유 인정, 04/09 = 국가 개입, 05/10 = 판정 극성)
   범용 분류기 하나로는 c04 의 "개입은 정당하다" 를 c09 의 "부당하지 않다" 와
   같은 방향으로 잘못 묶는다. 그래서 쌍마다 규칙을 따로 못 박는다. */
var PAIRS = [
  {
    title: 'c01(정상 상속: 권리 있음) ↔ c07(훔친 돈 상속: 문제 남음)',
    a: {
      id: 'c01',
      must: /(권리가 있다|정당한 재산이다|인정한다)/,
      mustNot: /(권리가 없다|정당하지 않다|문제(가|는)\s*남|훔친)/
    },
    b: {
      id: 'c07',
      must: /(문제(가|는)\s*남|정당하지 않다|훔친)/,
      mustNot: /(권리가 있다|정당한 재산이다)/
    }
  },
  {
    title: 'c04(사기: 국가 개입 정당) ↔ c09(비싸지만 정직: 부당하지 않음)',
    a: {
      id: 'c04',
      must: /(사기|국가(의)?\s*개입(은|이)?\s*정당|보호)/,
      mustNot: /(개입하면 안 된다|부당하지 않다|정당한 거래)/
    },
    b: {
      id: 'c09',
      must: /(부당하지 않다|정당하다|인정한다)/,
      mustNot: /(부당한 거래|개입|사기)/
    }
  },
  {
    title: 'c05(강제 재분배: 부당) ↔ c10(자발적 반반: 정당)',
    a: {
      id: 'c05',
      must: /(정당해지지 않는|정당하지 않다|부당)/,
      mustNot: /(걷어도 정당|정당하다\.?$)/
    },
    b: {
      id: 'c10',
      must: /(정당하다|부당하지 않다)/,
      mustNot: /(부당하다|정당하지 않다|정당해지지 않는|반대하므로)/
    }
  }
];

group('G3 · 대조쌍이 서로 다른 판단으로 갈린다  (T-14 / 요구 §8)', function () {
  var CASES = loadCases();
  var byId = {};
  CASES.forEach(function (c) { byId[c.id] = c; });

  function answerTextOf(caseId) {
    var c = byId[caseId];
    ok(c, caseId + ' 사건이 없다');
    var o = optionOf(c, c.answerId);
    ok(o, caseId + ': answerId(' + c.answerId + ') 가 선택지에 없다');
    return o.text;
  }

  PAIRS.forEach(function (p) {
    test(p.title, function () {
      var ta = answerTextOf(p.a.id);
      var tb = answerTextOf(p.b.id);

      ok(p.a.must.test(ta),
        p.a.id + ' 의 정답 본문이 기대한 방향을 말하지 않는다.\n본문: ' + ta + '\n기대 패턴: ' + p.a.must);
      ok(!p.a.mustNot.test(ta),
        p.a.id + ' 의 정답 본문이 반대 방향 표현을 담고 있다.\n본문: ' + ta + '\n금지 패턴: ' + p.a.mustNot);
      ok(p.b.must.test(tb),
        p.b.id + ' 의 정답 본문이 기대한 방향을 말하지 않는다.\n본문: ' + tb + '\n기대 패턴: ' + p.b.must);
      ok(!p.b.mustNot.test(tb),
        p.b.id + ' 의 정답 본문이 반대 방향 표현을 담고 있다.\n본문: ' + tb + '\n금지 패턴: ' + p.b.mustNot);

      ok(ta !== tb, p.a.id + ' 과 ' + p.b.id + ' 의 정답 본문이 같다');
    });
  });

  test('대조쌍의 두 사건이 서로 다른 선택지 집합을 쓴다', function () {
    PAIRS.forEach(function (p) {
      var a = byId[p.a.id];
      var b = byId[p.b.id];
      ok(a && b, p.a.id + '/' + p.b.id + ' 사건이 없다');
      ok(a.answerId !== b.answerId, p.a.id + ' 와 ' + p.b.id + ' 의 answerId 가 같다');
    });
  });
});

/* ============================================================ G4 정답 위치 분포 */

group('G4 · 정답 위치 분포  (요구 §8: 한쪽 자리로 쏠리지 않는다)', function () {
  var CASES = loadCases();

  test('첫 번째 자리 정답이 3~7개 사이다', function () {
    var first = 0;
    var where = [];
    CASES.forEach(function (c) {
      var pos = c.options[0] && c.options[0].id === c.answerId ? 1 : 2;
      if (pos === 1) first++;
      where.push(c.id + ':' + pos);
    });
    ok(first >= 3 && first <= 7,
      '첫 자리 정답이 ' + first + '개다 (3~7 이어야 한다)\n' + where.join(' '));
  });

  test('같은 자리 정답이 5연속으로 이어지지 않는다', function () {
    var run = 0;
    var prev = 0;
    CASES.forEach(function (c) {
      var pos = c.options[0] && c.options[0].id === c.answerId ? 1 : 2;
      run = (pos === prev) ? run + 1 : 1;
      prev = pos;
      ok(run < 5, c.id + ' 까지 같은 자리 정답이 ' + run + '연속이다');
    });
  });
});

/* ============================================================ G5 콘텐츠 길이 상한 (T-11) */

group('G5 · 콘텐츠 길이 상한  (T-11 / 04 §13.1)', function () {
  var CASES = loadCases();

  test('사건 제목 ≤ 22em (04 §13.1 "24자 = 한글 환산 22em")', function () {
    CASES.forEach(function (c) {
      var w = emWidth(c.title);
      ok(w <= 22, c.id + ': 제목 ' + w + 'em (상한 22em) -> ' + c.title);
      ok(chars(c.title) <= 30, c.id + ': 제목 글자 수 ' + chars(c.title) + ' (절대 상한 30자)');
    });
  });

  test('상황 본문 합계 ≤ 100자', function () {
    CASES.forEach(function (c) {
      var n = chars(stripMarks((c.situation || []).join(' ')));
      ok(n <= 100, c.id + ': 상황 본문 ' + n + '자 (상한 100자)');
    });
  });

  test('훅 대사 ≤ 30자', function () {
    CASES.forEach(function (c) {
      if (!c.hook) return;
      var n = chars(c.hook);
      ok(n <= 30, c.id + ': 훅 ' + n + '자 (상한 30자) -> ' + c.hook);
    });
  });

  test('선택지 각 ≤ 34자', function () {
    CASES.forEach(function (c) {
      (c.options || []).forEach(function (o) {
        var n = chars(o.text);
        ok(n <= 34, c.id + '/' + o.id + ': 선택지 ' + n + '자 (상한 34자) -> ' + o.text);
      });
    });
  });

  test('wrongLine ≤ 34자 · reason ≤ 45자 · concept ≤ 34자', function () {
    CASES.forEach(function (c) {
      ok(chars(c.wrongLine) <= 34, c.id + ': wrongLine ' + chars(c.wrongLine) + '자 (상한 34자)');
      ok(chars(c.reason) <= 45, c.id + ': reason ' + chars(c.reason) + '자 (상한 45자)');
      ok(chars(c.concept) <= 34, c.id + ': concept ' + chars(c.concept) + '자 (상한 34자)');
      ok(chars(c.conceptKo) <= 12, c.id + ': conceptKo ' + chars(c.conceptKo) + '자 (상한 12자)');
    });
  });
});

/* ============================================================ G6 NZ.COPY (T-09·T-10·T-12) */

/* 요구사항 §3 이 글자 그대로 고정한 문구. 한 글자도 바뀌면 실패다. */
var FIXED_COPY = [
  ['start.note', '네 생각을 고르는 게임이 아닙니다. 노직이라면 어떤 답을 고를지 맞혀 보세요.'],
  ['result.title', '10개 사건 수사 완료!'],
  ['result.score', '노직 예측 정확도: {score}/{total}'],
  ['result.teacher', '노직의 답에 동의하지 않아도 괜찮습니다. 이제 지문에서 그의 판단 기준을 찾아봅시다.'],
  ['result.q1.en', 'Was it rightfully theirs?'],
  ['result.q1.ko', '애초에 정당한 자기 것이었나?'],
  ['result.q1.term', 'justice in initial holdings'],
  ['result.q2.en', 'Was the transfer voluntary?'],
  ['result.q2.ko', '자발적으로 주고받았나?'],
  ['result.q2.term', 'justice in transfer'],
  ['feedback.match', '노직의 판단과 일치'],
  ['feedback.miss', '노직의 판단과 다름']
];

function dig(obj, dotted) {
  var cur = obj;
  var parts = dotted.split('.');
  for (var i = 0; i < parts.length; i++) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[parts[i]];
  }
  return cur;
}

group('G6 · NZ.COPY 문구 완결성  (T-09 / T-10 / T-12)', function () {
  var COPY = loadCopy();

  test('§4.1 최상위 키가 전부 있고 타입이 맞다  (T-12)', function () {
    var spec = {
      v: 'number', fill: 'function', app: 'object', start: 'object', resume: 'object',
      hud: 'object', lobby: 'object', file: 'object', 'case': 'object', feedback: 'object',
      approve: 'array', caseNote: 'object', linger: 'object', result: 'object',
      confirm: 'object', flat: 'object', a11y: 'object'
    };
    Object.keys(spec).forEach(function (k) {
      var v = COPY[k];
      ok(v !== undefined && v !== null, 'COPY.' + k + ' 가 없다');
      var t = spec[k] === 'array' ? (Array.isArray(v) ? 'array' : typeof v) : typeof v;
      eq(t, spec[k], 'COPY.' + k + ' 의 타입이 다르다');
    });
  });

  test('COPY.fill 이 {키} 를 치환하고 없는 키는 빈 문자열로 만든다', function () {
    eq(COPY.fill('완료 {done}/{total}', { done: 3, total: 10 }), '완료 3/10', 'fill 치환 결과가 다르다');
    eq(COPY.fill('{a}-{b}', { a: '' }), '-', '없는 키는 빈 문자열이어야 한다');
    eq(COPY.fill('그냥 문자열', {}), '그냥 문자열', '치환할 것이 없으면 원문 그대로여야 한다');
    eq(COPY.fill('완료 {done}', null), '완료 ', 'map 이 없어도 던지지 않아야 한다');
    ok(COPY.fill('<b>{x}</b>', { x: '<i>' }).indexOf('<i>') >= 0, 'fill 은 텍스트 전용이다(이스케이프하지 않는다)');
  });

  test('요구사항이 글자 그대로 고정한 문구가 그대로 있다', function () {
    FIXED_COPY.forEach(function (row) {
      var got = dig(COPY, row[0]);
      ok(typeof got === 'string', 'COPY.' + row[0] + ' 가 문자열이 아니다');
      eq(got, row[1], 'COPY.' + row[0] + ' 가 고정 문구와 다르다');
    });
  });

  test('시작 화면 안내·판사 아님 해명·결과 해석 문구가 비어 있지 않다', function () {
    ['app.title', 'app.subtitle', 'start.title', 'start.btnStart', 'start.judgeNote',
      'result.scoreNote', 'result.caption', 'result.btnLobby',
      'feedback.expectedLabel', 'feedback.btnNext', 'feedback.btnResult',
      'hud.progress', 'lobby.title', 'flat.note'
    ].forEach(function (k) {
      var v = dig(COPY, k);
      ok(typeof v === 'string' && v.trim(), 'COPY.' + k + ' 가 비었다');
    });
    ok(/노직 예측|동의/.test(COPY.result.scoreNote),
      'result.scoreNote 가 점수의 뜻을 설명하지 않는다 -> ' + COPY.result.scoreNote);
  });

  test('정답 반응 대사 풀이 8개 이상이고 중복이 없다', function () {
    var pool = COPY.approve;
    ok(Array.isArray(pool), 'COPY.approve 가 배열이 아니다');
    ok(pool.length >= 8, '반응 대사가 ' + pool.length + '개다 (8개 이상이어야 한다)');
    var seen = {};
    pool.forEach(function (s, i) {
      ok(typeof s === 'string' && s.trim(), 'approve[' + i + '] 가 비었다');
      ok(!seen[s], '반응 대사 중복 -> ' + s);
      seen[s] = true;
      ok(chars(s) <= 20, 'approve[' + i + '] 가 ' + chars(s) + '자다 (상한 20자) -> ' + s);
    });
  });

  test('COPY.caseNote.c05 방어 문장이 있다  (T-10 / 06 §2-4)', function () {
    var note = COPY.caseNote && COPY.caseNote.c05;
    ok(typeof note === 'string' && note.trim(), 'COPY.caseNote.c05 가 없다');
    ok(note.indexOf('모든 세금') >= 0,
      'caseNote.c05 에 "모든 세금" 해명이 없다 -> ' + note);
    var note8 = COPY.caseNote && COPY.caseNote.c08;
    ok(typeof note8 === 'string' && note8.trim(), 'COPY.caseNote.c08 (다수결 해명) 이 없다');
  });

  test('caseNote / linger 의 키가 실제 사건 id 다', function () {
    var CASES = loadCases();
    var ids = {};
    CASES.forEach(function (c) { ids[c.id] = true; });
    ['caseNote', 'linger'].forEach(function (k) {
      Object.keys(COPY[k] || {}).forEach(function (id) {
        ok(ids[id], 'COPY.' + k + ' 에 없는 사건 id -> ' + id);
        ok(typeof COPY[k][id] === 'string' && COPY[k][id].trim(), 'COPY.' + k + '.' + id + ' 가 비었다');
      });
    });
  });

  test('linger 문구에 이론가 이름이 없다  (06 §2-5)', function () {
    Object.keys(COPY.linger || {}).forEach(function (id) {
      var s = COPY.linger[id];
      ok(!/롤스|Rawls|노직|Nozick|마르크스|밀\b/i.test(s),
        'linger.' + id + ' 에 이론가 이름이 있다 -> ' + s);
    });
  });

  test('COPY 전체에 화면 금지 문자열이 0건이다  (T-09 / 06 §2-1)', function () {
    var hits = [];
    walkStrings(COPY, function (s, where) {
      BANNED_SCREEN.forEach(function (b) {
        if (b.re.test(s)) hits.push('COPY.' + where + ' -> "' + b.label + '" in ' + s);
      });
    }, '');
    ok(hits.length === 0, '금지 문자열 ' + hits.length + '건\n' + hits.join('\n'));
  });

  test('COPY 전체에 정치 성향 단정 표현이 0건이다  (요구 §3)', function () {
    var hits = [];
    walkStrings(COPY, function (s, where) {
      BANNED_POLITICS.forEach(function (b) {
        if (b.re.test(s)) hits.push('COPY.' + where + ' -> "' + b.label + '" in ' + s);
      });
    }, '');
    ok(hits.length === 0, '정치 성향 표현 ' + hits.length + '건\n' + hits.join('\n'));
  });
});

/* ============================================================ G7 State 채점·불변식 */

group('G7 · NZ.State 채점과 불변식  (T-02~T-06, T-13 / I1~I8)', function () {

  test('NZ.CONFIG 상수가 계약 §3 과 같다', function () {
    var h = bootState({});
    var C = h.C;
    eq(C.total, 10, 'CONFIG.total');
    eq(C.total, h.CASES.length, 'CONFIG.total 이 CASES.length 와 다르다');
    eq(C.KEY_PROGRESS, 'nz.progress', 'CONFIG.KEY_PROGRESS');
    eq(C.KEY_PREFS, 'nz.prefs', 'CONFIG.KEY_PREFS');
    eq(C.schema, 1, 'CONFIG.schema');
    ok(C.REACT_MIN === 600 && C.REACT_MAX === 1200, 'CONFIG.REACT_MIN/MAX 가 600/1200 이 아니다 (R10)');
    ok(typeof C.ARM_MS === 'number' && typeof C.NEXT_ARM_MS === 'number', 'ARM_MS / NEXT_ARM_MS 가 없다');
  });

  test('state.js 가 document 없이 로드되고 동작한다  (계약 §5)', function () {
    var h = freshState({});
    eq(typeof h.S.score, 'function', 'State.score 가 없다');
    eq(h.S.total(), 10, 'total()');
    eq(h.S.completedCount(), 0, '새 판의 completedCount');
    eq(h.S.score(), 0, '새 판의 score');
  });

  test('answer() 가 ID 비교로 채점한다  (R1)', function () {
    var h = freshState({});
    h.CASES.forEach(function (c) {
      var hit = h.S.answer(c.id, c.answerId);
      ok(hit && hit.accepted === true, c.id + ': 첫 answer 가 accepted 가 아니다');
      eq(hit.match, true, c.id + ': 정답 ID 인데 match 가 아니다');
      eq(hit.expectedId, c.answerId, c.id + ': expectedId 가 answerId 와 다르다');
      eq(hit.reason, null, c.id + ': 첫 answer 의 reason 은 null 이어야 한다');
    });
  });

  test('오답 선택도 정상 기록되고 match 만 false 다', function () {
    var h = freshState({});
    h.CASES.forEach(function (c) {
      var w = wrongIdOf(c);
      var r = h.S.answer(c.id, w);
      ok(r && r.accepted === true, c.id + ': 오답 선택이 accepted 가 아니다');
      eq(r.match, false, c.id + ': 오답인데 match 가 true 다');
      eq(r.choiceId, w, c.id + ': choiceId 가 고른 것과 다르다');
      eq(h.S.matchOf(c.id), false, c.id + ': matchOf');
      eq(h.S.choiceOf(c.id), w, c.id + ': choiceOf');
    });
  });

  test('모르는 caseId / optionId 를 던지지 않고 거부한다', function () {
    var h = freshState({});
    var a = h.S.answer('zz99', 'zz99-x');
    ok(a && a.accepted === false, '모르는 사건이 accepted 되었다');
    eq(a.reason, 'unknown-case', 'reason 이 unknown-case 가 아니다');
    var b = h.S.answer('c01', 'c01-nope');
    ok(b && b.accepted === false, '모르는 선택지가 accepted 되었다');
    eq(b.reason, 'unknown-choice', 'reason 이 unknown-choice 가 아니다');
    eq(h.S.choiceOf('c01'), null, '거부된 선택이 기록되었다');
  });

  test('T-02 위치 독립 채점: options 를 뒤집어도 같은 선택 ID 의 결과가 같다  (R2)', function () {
    ['answer', 'wrong'].forEach(function (pick) {
      var base = bootState({});
      base.S.init(); base.S.startFresh();

      /* 뒤집기는 state.js 로드 전에 한다. 내부에서 인덱스를 미리 만들어도
         뒤집힌 배열을 보게 해야 "위치와 무관"을 증명할 수 있다. */
      var rev = mkSandbox({});
      load(rev, ['cases.js']);
      rev.win.NZ.CASES.forEach(function (c) { c.options.reverse(); });
      load(rev, ['state.js']);
      var RS = rev.win.NZ.State;
      RS.init(); RS.startFresh();

      base.CASES.forEach(function (c) {
        var id = pick === 'answer' ? c.answerId : wrongIdOf(c);
        var a = base.S.answer(c.id, id);
        var b = RS.answer(c.id, id);
        eq(b.match, a.match, c.id + '/' + id + ': 뒤집은 배열에서 match 가 달라졌다');
        eq(b.expectedId, a.expectedId, c.id + '/' + id + ': 뒤집은 배열에서 expectedId 가 달라졌다');
        eq(b.choiceId, a.choiceId, c.id + '/' + id + ': 뒤집은 배열에서 choiceId 가 달라졌다');
        base.S.markDone(c.id);
        RS.markDone(c.id);
      });
      eq(RS.score(), base.S.score(), '뒤집은 배열에서 총점이 달라졌다');
      eq(RS.completedCount(), base.S.completedCount(), '뒤집은 배열에서 완료 수가 달라졌다');
    });
  });

  test('T-03 연타 방어: 같은 사건에 100번 answer 해도 최초 선택과 점수가 그대로다  (I3/I6)', function () {
    var h = freshState({});
    var c = h.CASES[0];
    var w = wrongIdOf(c);
    var first = h.S.answer(c.id, c.answerId);
    eq(first.accepted, true, '첫 answer 가 거부되었다');
    h.S.markDone(c.id);
    var s0 = h.S.score();
    var d0 = h.S.completedCount();
    for (var i = 0; i < 100; i++) {
      var r = h.S.answer(c.id, i % 2 ? w : c.answerId);
      eq(r.accepted, false, i + '번째 재시도가 accepted 되었다');
      eq(r.reason, 'already', i + '번째 재시도의 reason');
      eq(r.choiceId, c.answerId, i + '번째 재시도에서 firstChoice 가 바뀌었다');
      eq(r.match, true, i + '번째 재시도의 match 가 최초 선택 기준이 아니다');
    }
    eq(h.S.choiceOf(c.id), c.answerId, 'firstChoice 가 바뀌었다');
    eq(h.S.score(), s0, 'score 가 부풀었다');
    eq(h.S.completedCount(), d0, 'completedCount 가 부풀었다');
  });

  test('완료한 사건을 재방문해 다시 풀어도 완료 수·점수가 부풀지 않는다  (I6)', function () {
    var h = freshState({});
    var expected = 0;
    h.CASES.forEach(function (c, i) {
      var pick = (i % 2 === 0) ? c.answerId : wrongIdOf(c);
      if (pick === c.answerId) expected++;
      h.S.setCurrent(c.id);
      h.S.answer(c.id, pick);
      h.S.markDone(c.id);
    });
    eq(h.S.completedCount(), 10, '완료 수');
    eq(h.S.score(), expected, '점수');
    /* 재방문 3바퀴 */
    for (var round = 0; round < 3; round++) {
      h.CASES.forEach(function (c) {
        h.S.setCurrent(c.id);
        h.S.answer(c.id, c.answerId);
        h.S.markDone(c.id);
        h.S.setPhase('feedback');
      });
    }
    eq(h.S.completedCount(), 10, '재방문 후 완료 수가 변했다');
    eq(h.S.score(), expected, '재방문 후 점수가 변했다');
  });

  test('R4: markDone 전에는 점수에 들어가지 않는다 → score() ≤ completedCount() (I2)', function () {
    var h = freshState({});
    h.S.answer('c01', h.CASES[0].answerId);
    eq(h.S.completedCount(), 0, 'markDone 전에 완료로 잡혔다');
    eq(h.S.score(), 0, 'markDone 전에 점수로 잡혔다');
    ok(h.S.score() <= h.S.completedCount(), 'score > completedCount');
    h.S.markDone('c01');
    eq(h.S.completedCount(), 1, 'markDone 후 완료 수');
    eq(h.S.score(), 1, 'markDone 후 점수');

    /* 모든 단계에서 0 ≤ score ≤ completed ≤ 10 */
    h.CASES.slice(1).forEach(function (c, i) {
      h.S.answer(c.id, i % 3 === 0 ? c.answerId : wrongIdOf(c));
      ok(h.S.score() <= h.S.completedCount(), c.id + ' answer 직후 score > completedCount');
      h.S.markDone(c.id);
      var s = h.S.score();
      var d = h.S.completedCount();
      ok(s >= 0 && s <= d && d <= 10, c.id + ': 0 ≤ ' + s + ' ≤ ' + d + ' ≤ 10 위반');
    });
  });

  test('T-05 markDone 은 답하지 않은 사건을 거부한다  (I1: done ⊆ keys(firstChoice))', function () {
    var h = freshState({});
    eq(h.S.markDone('c04'), false, '답하지 않은 사건이 완료로 들어갔다');
    eq(h.S.isDone('c04'), false, 'isDone 이 true 다');
    eq(h.S.completedCount(), 0, 'completedCount 가 올라갔다');
    eq(h.S.markDone('zz99'), false, '모르는 사건이 완료로 들어갔다');
    h.S.answer('c04', wrongIdOf(h.CASES[3]));
    eq(h.S.markDone('c04'), true, '답한 사건의 markDone 이 false 다');
    eq(h.S.markDone('c04'), false, '두 번째 markDone 이 true 다');
    eq(h.S.completedCount(), 1, '중복 markDone 으로 완료 수가 부풀었다');
    var snap = h.S.snapshot();
    snap.done.forEach(function (id) {
      ok(Object.prototype.hasOwnProperty.call(snap.firstChoice, id), 'done 에 firstChoice 없는 id -> ' + id);
    });
  });

  test('T-04 전부 일치 / 전부 불일치 / 혼합 모두 10개를 끝낸다  (오답도 완료)', function () {
    [['match', 10], ['miss', 0], ['mixed', 5]].forEach(function (row) {
      var mode = row[0];
      var want = row[1];
      var h = freshState({});
      h.CASES.forEach(function (c, i) {
        var pick;
        if (mode === 'match') pick = c.answerId;
        else if (mode === 'miss') pick = wrongIdOf(c);
        else pick = (i % 2 === 0) ? c.answerId : wrongIdOf(c);
        h.S.answer(c.id, pick);
        h.S.markDone(c.id);
      });
      eq(h.S.allDone(), true, mode + ': allDone 이 false 다');
      eq(h.S.completedCount(), 10, mode + ': completedCount');
      eq(h.S.score(), want, mode + ': score');
      ok(h.S.score() <= h.S.completedCount(), mode + ': score > completedCount');
      h.S.setScreen('result');
      eq(h.S.screen(), 'result', mode + ': 10개를 끝냈는데 결과 화면으로 못 간다');
    });
  });

  test('전부 불일치로 끝내도 결과 화면에 도달한다  (10개를 맞혀야 끝나는 구조가 아니다)', function () {
    var h = freshState({});
    h.CASES.forEach(function (c) {
      h.S.answer(c.id, wrongIdOf(c));
      h.S.markDone(c.id);
    });
    eq(h.S.score(), 0, 'score');
    eq(h.S.allDone(), true, 'allDone');
    h.S.setScreen('result');
    eq(h.S.screen(), 'result', '전부 불일치일 때 결과 화면 진입 실패');
  });

  test('I5: 미완료 상태에서는 screen("result") 가 lobby 로 떨어진다', function () {
    var h = freshState({});
    h.S.answer('c01', h.CASES[0].answerId);
    h.S.markDone('c01');
    h.S.setScreen('result');
    eq(h.S.screen(), 'lobby', '미완료인데 결과 화면으로 갔다');
    h.S.setScreen('없는화면');
    eq(h.S.screen(), 'lobby', '미지의 화면 값이 lobby 로 떨어지지 않았다');
    h.S.setPhase('없는위상');
    eq(h.S.phase(), 'ask', '미지의 위상 값이 ask 로 떨어지지 않았다');
  });

  test('T-06 nextUnanswered 가 7번부터 순환하며 10개를 전부 소진한다  (I4)', function () {
    var h = freshState({});
    var cur = 'c07';
    var visited = [];
    for (var i = 0; i < 10; i++) {
      var next = (i === 0) ? cur : h.S.nextUnanswered(cur);
      ok(next !== null, i + '번째에서 nextUnanswered 가 null 이다 (아직 ' + (10 - i) + '개 남았다)');
      ok(visited.indexOf(next) < 0, '이미 끝낸 사건을 다시 줬다 -> ' + next);
      visited.push(next);
      h.S.answer(next, h.S.expectedOf(next));
      h.S.markDone(next);
      cur = next;
    }
    eq(visited.length, 10, '순환으로 10개를 소진하지 못했다');
    eq(h.S.allDone(), true, 'allDone');
    eq(h.S.nextUnanswered(cur), null, '전부 끝났는데 null 이 아니다');
    eq(h.S.nextUnanswered(null), null, 'fromId=null 이어도 null 이어야 한다');
  });

  test('I4: nextUnanswered(x)===null 은 allDone() 과 동치다', function () {
    var h = freshState({});
    h.CASES.forEach(function (c, i) {
      var eqv = (h.S.nextUnanswered(c.id) === null) === h.S.allDone();
      ok(eqv, i + '단계에서 nextUnanswered/allDone 동치가 깨졌다');
      h.S.answer(c.id, c.answerId);
      h.S.markDone(c.id);
    });
    ok((h.S.nextUnanswered('c10') === null) === h.S.allDone(), '마지막 단계에서 동치가 깨졌다');
  });

  test('nextUnanswered 가 모르는 id 를 받아도 처음부터 찾는다', function () {
    var h = freshState({});
    eq(h.S.nextUnanswered('zz99'), 'c01', '모르는 id 일 때 0번부터 찾지 않았다');
    eq(h.S.nextUnanswered(null), 'c01', 'null 일 때 0번부터 찾지 않았다');
    h.S.answer('c01', h.CASES[0].answerId);
    h.S.markDone('c01');
    eq(h.S.nextUnanswered(null), 'c02', '완료한 사건을 다시 줬다');
  });

  test('stateOf / currentUnread / indexOf 가 계약대로 움직인다', function () {
    var h = freshState({});
    eq(h.S.stateOf('c03'), 'unread', 'unread');
    eq(h.S.currentUnread(), 'c01', 'currentUnread 초기값');
    h.S.answer('c03', h.CASES[2].answerId);
    eq(h.S.stateOf('c03'), 'answered', 'answered');
    h.S.markDone('c03');
    eq(h.S.stateOf('c03'), 'done', 'done');
    eq(h.S.indexOf('c03'), 2, 'indexOf');
    eq(h.S.indexOf('zz99'), -1, '모르는 id 의 indexOf');
    eq(h.S.currentUnread(), 'c01', '가장 낮은 미응답 사건');
  });

  test('T-13 elapsedMs() 가 단조 증가하고 음수가 아니다  (I7)', function () {
    var h = freshState({});
    var prev = -1;
    for (var i = 0; i < 50; i++) {
      var v = h.S.elapsedMs();
      ok(typeof v === 'number' && isFinite(v), 'elapsedMs 가 숫자가 아니다 -> ' + v);
      ok(v >= 0, 'elapsedMs 가 음수다 -> ' + v);
      ok(v >= prev, 'elapsedMs 가 감소했다 (' + prev + ' -> ' + v + ')');
      prev = v;
    }
    var t = Date.now();
    while (Date.now() - t < 12) { /* 시계를 실제로 12ms 흘린다 */ }
    ok(h.S.elapsedMs() >= prev, '시간이 흐른 뒤 elapsedMs 가 줄었다');
    ok(h.S.elapsedMs() < h.C.MAX_ELAPSED, 'elapsedMs 가 상한을 넘었다');
  });

  test('snapshot() 은 깊은 복사본이라 밖에서 고쳐도 내부가 안 변한다', function () {
    var h = freshState({});
    h.S.answer('c01', h.CASES[0].answerId);
    h.S.markDone('c01');
    var snap = h.S.snapshot();
    snap.done.push('c02');
    snap.firstChoice.c02 = 'c02-outcome';
    snap.firstChoice.c01 = 'c01-effort';
    eq(h.S.completedCount(), 1, '스냅샷을 고쳤더니 완료 수가 변했다');
    eq(h.S.choiceOf('c01'), h.CASES[0].answerId, '스냅샷을 고쳤더니 firstChoice 가 변했다');
    eq(h.S.isDone('c02'), false, '스냅샷을 고쳤더니 done 이 변했다');
  });

  test('onChange 구독자가 즉시 1회 호출되고 해제된다', function () {
    var h = freshState({});
    var n = 0;
    var off = h.S.onChange(function () { n++; }, 'test');
    eq(n, 1, '구독 즉시 1회 호출되지 않았다');
    h.S.answer('c01', h.CASES[0].answerId);
    ok(n >= 2, 'answer 후 통지되지 않았다');
    var before = n;
    off();
    h.S.markDone('c01');
    eq(n, before, '해제 후에도 통지되었다');
  });

  test('agree 는 채점에 영향이 없다  (06 §2-6)', function () {
    var h = freshState({});
    h.CASES.forEach(function (c) {
      h.S.answer(c.id, c.answerId);
      h.S.markDone(c.id);
    });
    var before = h.S.score();
    h.S.setAgree('yes');
    eq(h.S.agree(), 'yes', 'agree 가 기록되지 않았다');
    h.S.setAgree('아무거나');
    eq(h.S.agree(), 'yes', '유효하지 않은 값이 기록되었다');
    h.S.setAgree('no');
    eq(h.S.agree(), 'no', 'agree 변경 실패');
    eq(h.S.score(), before, 'agree 가 점수를 바꿨다');
  });
});

/* ============================================================ G8 저장·복구·손상 내성 */

group('G8 · 저장 · 복구 · 손상 내성  (T-07 / T-08 / R6 / I9)', function () {

  test('저장 후 새 State 가 firstChoice / done / score 를 복원한다', function () {
    var store = {};
    var a = freshState({ store: store });
    var expected = 0;
    a.CASES.slice(0, 3).forEach(function (c, i) {
      var pick = (i === 2) ? wrongIdOf(c) : c.answerId;
      if (pick === c.answerId) expected++;
      a.S.setCurrent(c.id);
      a.S.answer(c.id, pick);
      a.S.markDone(c.id);
    });
    a.S.setScreen('lobby');
    ok(a.S.save() === true, 'save() 가 true 를 돌려주지 않았다');
    ok(typeof store['nz.progress'] === 'string', 'nz.progress 에 아무것도 저장되지 않았다');

    var b = bootState({ store: store });
    var info = b.S.init();
    ok(info && (info.mode === 'resumable'), 'init().mode 가 resumable 이 아니다 -> ' + show(info));
    eq(b.S.hasResumable(), true, 'hasResumable');
    b.S.resume();
    eq(b.S.completedCount(), 3, '복원된 완료 수');
    eq(b.S.score(), expected, '복원된 점수');
    eq(b.S.choiceOf('c01'), a.S.choiceOf('c01'), '복원된 firstChoice(c01)');
    eq(b.S.choiceOf('c03'), a.S.choiceOf('c03'), '복원된 firstChoice(c03)');
    eq(b.S.isDone('c02'), true, '복원된 done');
    eq(b.S.startedAt(), a.S.startedAt(), 'resume 이 startedAt 을 바꿨다');
  });

  test('로비까지만 갔다 새로고침하면 묻지 않고 새로 시작한다  (§5.7)', function () {
    var store = {};
    var a = freshState({ store: store });
    a.S.setScreen('lobby');
    a.S.save();
    var b = bootState({ store: store });
    var info = b.S.init();
    eq(b.S.hasResumable(), false, '의미 있는 진행이 없는데 이어하기를 제안한다');
    ok(info && info.mode === 'fresh', 'init().mode 가 fresh 가 아니다');
  });

  test('T-07 손상된 저장값을 전부 예외 없이 처리한다 (콘솔 에러 0건)', function () {
    var bad = [
      ['버전 불일치', JSON.stringify({ v: 99, done: ['c01'], firstChoice: { c01: 'c01-gift' } })],
      ['깨진 JSON', '{"v":1,"done":['],
      ['최상위가 배열', '[1,2,3]'],
      ['최상위가 문자열', '"hello"'],
      ['firstChoice 가 배열', JSON.stringify({ v: 1, firstChoice: [], done: [] })],
      ['done 이 객체', JSON.stringify({ v: 1, firstChoice: {}, done: {} })],
      ['빈 문자열', '']
    ];
    bad.forEach(function (row) {
      var store = { 'nz.progress': row[1] };
      var h = bootState({ store: store });
      var info = h.S.init();
      ok(info && typeof info === 'object', row[0] + ': init() 이 객체를 돌려주지 않았다');
      eq(h.S.hasResumable(), false, row[0] + ': 손상된 값으로 이어하기를 제안한다');
      h.S.startFresh();
      eq(h.S.completedCount(), 0, row[0] + ': 손상된 값이 상태에 새어 들어왔다');
      eq(h.log.length, 0, row[0] + ': 콘솔 에러/경고가 났다\n' + h.log.join('\n'));
    });
  });

  test('T-07 sanitize 가 없는 caseId / choiceId 를 걸러 낸다', function () {
    var raw = {
      v: 1,
      startedAt: Date.now() - 60000,
      savedAt: Date.now(),
      elapsedMs: 60000,
      firstChoice: { c01: 'c01-gift', c02: 'c02-없는선택', zz9: 'zz9-x', c03: 'c03-free' },
      done: ['c01', 'c02', 'zz9', 'c03', 'c03', 'c04'],
      current: 'zz9',
      phase: 'feedback',
      screen: 'case',
      agree: '아무거나'
    };
    var h = bootState({ store: { 'nz.progress': JSON.stringify(raw) } });
    h.S.init();
    eq(h.S.hasResumable(), true, '살릴 수 있는 진행인데 버렸다');
    h.S.resume();

    eq(h.S.choiceOf('zz9'), null, '없는 caseId 가 남았다');
    eq(h.S.isDone('zz9'), false, '없는 caseId 가 done 에 남았다');
    eq(h.S.choiceOf('c02'), null, '없는 choiceId 가 남았다');
    eq(h.S.isDone('c02'), false, '없는 choiceId 의 사건이 done 에 남았다');
    eq(h.S.isDone('c04'), false, 'firstChoice 없는 사건이 done 에 남았다  (I1)');
    eq(h.S.completedCount(), 2, '정리 후 완료 수 (c01, c03 만 남아야 한다)');
    eq(h.S.score(), 2, '정리 후 점수');
    eq(h.S.current(), null, '없는 current 가 남았다');
    eq(h.S.screen(), 'lobby', 'current 가 사라졌으면 lobby 여야 한다');
    eq(h.S.agree(), null, '유효하지 않은 agree 가 남았다');
    eq(h.log.length, 0, '콘솔 에러/경고가 났다\n' + h.log.join('\n'));
  });

  test('T-07 phase:"lock" 은 feedback 으로 승격된다', function () {
    var raw = {
      v: 1, startedAt: Date.now(), savedAt: Date.now(), elapsedMs: 1000,
      firstChoice: { c05: 'c05-forced' }, done: ['c05'],
      current: 'c05', phase: 'lock', screen: 'case', agree: null
    };
    var h = bootState({ store: { 'nz.progress': JSON.stringify(raw) } });
    h.S.init();
    h.S.resume();
    eq(h.S.phase(), 'feedback', 'lock 이 feedback 으로 승격되지 않았다');
    eq(h.S.feedbackOpen(), true, 'feedbackOpen 파생값');
    eq(h.S.current(), 'c05', 'current 가 복원되지 않았다');
    eq(h.S.isDone('c05'), true, 'done 이 복원되지 않았다');
    eq(h.log.length, 0, '콘솔 에러/경고가 났다\n' + h.log.join('\n'));
  });

  test('T-07 screen:"result" 인데 미완료면 lobby 로 내려간다  (I5)', function () {
    var raw = {
      v: 1, startedAt: Date.now(), savedAt: Date.now(), elapsedMs: 1000,
      firstChoice: { c01: 'c01-gift' }, done: ['c01'],
      current: 'c01', phase: 'feedback', screen: 'result', agree: null
    };
    var h = bootState({ store: { 'nz.progress': JSON.stringify(raw) } });
    h.S.init();
    h.S.resume();
    eq(h.S.allDone(), false, '1개만 했는데 allDone 이다');
    eq(h.S.screen(), 'lobby', '미완료인데 result 화면으로 복원되었다');
    eq(h.log.length, 0, '콘솔 에러/경고가 났다\n' + h.log.join('\n'));
  });

  test('T-07 elapsedMs 가 음수·비정상이면 0 으로 고친다', function () {
    [-1, 999999999999, 'abc', null].forEach(function (v) {
      var raw = {
        v: 1, startedAt: Date.now(), savedAt: Date.now(), elapsedMs: v,
        firstChoice: { c01: 'c01-gift' }, done: ['c01'],
        current: 'c01', phase: 'feedback', screen: 'case', agree: null
      };
      var h = bootState({ store: { 'nz.progress': JSON.stringify(raw) } });
      h.S.init();
      h.S.resume();
      var e = h.S.elapsedMs();
      ok(e >= 0 && e < 60000, 'elapsedMs=' + show(v) + ' 가 ' + e + ' 로 복원되었다 (0 근처여야 한다)');
    });
  });

  test('T-08 localStorage 가 던져도 10개를 끝까지 풀 수 있다  (R6)', function () {
    var h = bootState({ storage: 'throw' });
    h.S.init();
    h.S.startFresh();
    h.CASES.forEach(function (c, i) {
      var pick = (i % 2 === 0) ? c.answerId : wrongIdOf(c);
      h.S.setCurrent(c.id);
      h.S.answer(c.id, pick);
      h.S.setPhase('feedback');
      h.S.markDone(c.id);
    });
    eq(h.S.allDone(), true, '저장이 막혀도 완주할 수 있어야 한다');
    eq(h.S.completedCount(), 10, 'completedCount');
    eq(h.S.score(), 5, 'score');
    eq(h.S.storageOk(), false, 'storageOk() 가 false 가 아니다');
    eq(h.S.save(), false, '실패한 save() 가 false 를 돌려주지 않았다');
    h.S.setScreen('result');
    eq(h.S.screen(), 'result', '저장이 막히면 결과 화면으로 못 간다');
  });

  test('T-08 저장이 막힌 상태에서도 reset() 이 던지지 않는다', function () {
    var h = bootState({ storage: 'throw' });
    h.S.init();
    h.S.startFresh();
    h.S.answer('c01', 'c01-gift');
    h.S.markDone('c01');
    h.S.reset();
    eq(h.S.completedCount(), 0, 'reset 후 완료 수');
    eq(h.S.score(), 0, 'reset 후 점수');
  });

  test('I9 reset() 후에도 nz.prefs 의 muted 가 보존된다', function () {
    var store = {};
    var h = freshState({ store: store });
    h.S.setMuted(true);
    eq(h.S.muted(), true, 'setMuted(true)');
    h.S.setMotion('reduced');
    h.S.answer('c01', 'c01-gift');
    h.S.markDone('c01');
    h.S.reset();
    eq(h.S.completedCount(), 0, 'reset 후 진행이 남았다');
    eq(h.S.muted(), true, 'reset 이 음소거 설정을 지웠다');
    eq(h.S.motion(), 'reduced', 'reset 이 모션 설정을 지웠다');
    ok(typeof store['nz.prefs'] === 'string', 'nz.prefs 가 저장되지 않았다');
    ok(!store['nz.progress'], 'reset 후에도 nz.progress 가 남아 있다');

    /* 새 세션에서도 유지된다 */
    var b = bootState({ store: store });
    b.S.init();
    eq(b.S.muted(), true, '새 세션에서 음소거 설정이 복원되지 않았다');
  });

  test('저장 키가 nz.progress / nz.prefs 두 개뿐이다  (R6)', function () {
    var store = {};
    var h = freshState({ store: store });
    h.S.setMuted(false);
    h.CASES.forEach(function (c) {
      h.S.answer(c.id, c.answerId);
      h.S.markDone(c.id);
    });
    h.S.save();
    var keys = Object.keys(store).sort();
    eq(keys.join(','), 'nz.prefs,nz.progress', '저장 키 목록이 다르다');
    var saved = JSON.parse(store['nz.progress']);
    eq(saved.v, 1, '저장값에 v 버전 필드가 없다');
    ok(!('order' in saved), '저장 스키마에 order 가 있다 (R2 위반)');
    ok(!('feedbackOpen' in saved), '저장 스키마에 feedbackOpen 이 있다 (phase 파생값이다)');
    var prefs = JSON.parse(store['nz.prefs']);
    eq(prefs.v, 1, 'nz.prefs 에 v 버전 필드가 없다');
  });

  test("screen:'start' 는 저장하지 않는다  (§5.2)", function () {
    var store = {};
    var h = freshState({ store: store });
    h.S.answer('c01', 'c01-gift');
    h.S.markDone('c01');
    h.S.setScreen('start');
    h.S.save();
    var saved = JSON.parse(store['nz.progress']);
    ok(saved.screen !== 'start', "저장값의 screen 이 'start' 다");
  });
});

/* ============================================================ G9 소스 계약 */

group('G9 · 소스 계약  (모듈 형태 · 금지 API · 금지 문구 · R7)', function () {

  MODULES.forEach(function (file) {
    test(file + ' 이 IIFE 계약과 금지 API 규칙을 지킨다', function () {
      var src = readModule(file);
      ok(src !== null, 'src/' + file + ' 이 없다');

      var esm = src.match(/^\s*(import\s+[\w{*]|export\s+(default|const|let|var|function|class|\{))/m);
      ok(!esm, 'ES 모듈 문법 -> ' + (esm && esm[0]));
      ok(!/(^|[^.\w])require\s*\(/.test(src), 'require() 를 쓴다');
      ok(!/\bfetch\s*\(/.test(src), 'fetch() 를 쓴다 (오프라인에서 죽는다)');
      ok(!/XMLHttpRequest/.test(src), 'XMLHttpRequest 를 쓴다');
      ok(!/<\/script/i.test(src), '리터럴 "</script" 가 있다 (인라인 시 페이지가 깨진다)');

      var todo = src.match(/(TODO|FIXME|placeholder implementation|not implemented|구현 예정|여기에 구현)/i);
      ok(!todo, '미완성 마커 -> ' + (todo && todo[0]));

      var urls = src.match(/https?:\/\/[^\s'"`)]+/g) || [];
      urls.forEach(function (u) {
        var allowed =
          u.indexOf('https://fonts.googleapis.com') === 0 ||
          u.indexOf('https://fonts.gstatic.com') === 0 ||
          u.indexOf('http://www.w3.org/') === 0 ||
          u.indexOf('https://totojunior.github.io/') === 0;
        ok(allowed, '외부 URL -> ' + u);
      });

      ok(/'use strict'|"use strict"/.test(src), "'use strict' 가 없다");
      ok(/\(function\s*\(\s*\)\s*\{/.test(src), 'IIFE 형태가 아니다');
      ok(/window\.NZ\s*=\s*window\.NZ\s*\|\|\s*\{\}/.test(src), 'window.NZ = window.NZ || {} 가 없다');
    });
  });

  test('state.js 가 document 를 한 번도 참조하지 않는다  (계약 §5 / §15)', function () {
    var src = readModule('state.js');
    ok(src !== null, 'src/state.js 가 없다');
    var code = stripComments(src);
    var hit = code.match(/\bdocument\b/);
    ok(!hit, 'state.js 안에 document 참조가 있다');
  });

  test('window.NZ 아래 노출 이름이 8개 계약 안에 있다  (R7)', function () {
    var found = {};
    MODULES.forEach(function (file) {
      var src = readModule(file);
      if (src === null) return;
      var code = stripComments(src);
      var re = /window\.NZ\.([A-Za-z_$][\w$]*)\s*=/g;
      var m;
      while ((m = re.exec(code))) found[m[1]] = file;
    });
    Object.keys(found).forEach(function (name) {
      ok(ALLOWED_GLOBALS.indexOf(name) >= 0,
        '계약에 없는 전역 -> window.NZ.' + name + ' (' + found[name] + ')');
    });
    ok(!found.bus && !found.DATA && !found.layout && !found.motion && !found.a11y,
      '폐기된 전역(bus/DATA/layout/motion/a11y)이 살아 있다');
  });

  test('소스 어디에도 "롤스" 류 정치 성향 단정 표현이 없다  (요구 §3)', function () {
    var hits = [];
    MODULES.forEach(function (file) {
      var src = readModule(file);
      if (src === null) { hits.push('src/' + file + ' 이 없다'); return; }
      var code = stripComments(src);
      BANNED_POLITICS.forEach(function (b) {
        if (b.re.test(code)) hits.push(file + ' -> "' + b.label + '"');
      });
    });
    ok(hits.length === 0, hits.join('\n'));
  });

  test('ui.js 가 3D/2D 분기와 애니메이션 길이 상수를 갖지 않는다  (R9 / 계약 §15)', function () {
    var src = readModule('ui.js');
    ok(src !== null, 'src/ui.js 가 없다');
    var code = stripComments(src);
    ok(!/\bTHREE\b/.test(code), 'ui.js 가 THREE 를 직접 참조한다');
    ok(!/Court\s*\.\s*(ok|mode)\b/.test(code), 'ui.js 가 Court.ok / Court.mode 로 분기한다');
    /* 피드백 타이머 길이는 Court.react() 가 돌려준 값이어야 한다.
       setTimeout 에 세 자리 이상 숫자 리터럴이 박혀 있으면 그 계약이 깨진 것이다.
       (ARM_MS / NEXT_ARM_MS 는 CONFIG 에서 읽으므로 숫자 리터럴이 아니다.) */
    var hardTimer = code.match(/setTimeout\s*\([^,()]*(\([^)]*\))?[^,]*,\s*\d{3,}/);
    ok(!hardTimer, 'ui.js 가 setTimeout 에 길이 상수를 직접 박았다 -> ' + (hardTimer && hardTimer[0]));
  });

  test('어떤 모듈도 선택지 ID 를 문자열 조합으로 만들지 않는다  (R1)', function () {
    MODULES.forEach(function (file) {
      var src = readModule(file);
      if (src === null) throw new Error('src/' + file + ' 이 없다');
      var code = stripComments(src);
      ok(!/['"`]_?o[12]['"`]/.test(code), file + ': 선택지 순번 접미사("_o1" 류)를 만든다');
      ok(!/\+\s*['"`]-?(a|b)['"`]/i.test(code), file + ': 선택지 ID 를 위치 문자로 조합한다');
    });
  });
});

/* ============================================================ 합계 */

console.log('');
console.log(repeat('=', 64));
if (failures.length) {
  console.log('실패 ' + failures.length + '건');
  failures.forEach(function (f, i) {
    console.log('  ' + (i + 1) + ') ' + f.split('\n')[0]);
  });
  console.log('');
}
console.log('통과 ' + passCount + ' / 실패 ' + failCount + ' / 전체 ' + (passCount + failCount));
console.log(repeat('=', 64));

if (failCount > 0) process.exitCode = 1;
