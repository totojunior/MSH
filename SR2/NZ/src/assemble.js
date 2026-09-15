/* assemble.js — SR2/NZ/index.html 을 src/ 의 모듈들에서 만들어 낸다.
 *
 *   사용법:  node SR2/NZ/src/assemble.js
 *   결과물:  SR2/NZ/index.html   (three.js r134 인라인, 완전 오프라인 단일 파일)
 *
 * 왜 번들러를 안 쓰는가: 이 저장소의 SR2 와 같은 방식이다. 교실 크롬북과
 * 인터넷이 안 되는 교실 모두에서 "링크 하나" 또는 "파일 하나"로 굴러가야 하고,
 * 교사가 github.com 웹 편집기에서 src/cases.js 한 줄만 고쳐도 CI가 페이지를
 * 다시 구워 주는 구조라야 하기 때문이다. node 외의 설치물은 없다.
 *
 * 그래서 모듈들은 ES 모듈이 아니라 IIFE 로 window.NZ 에 붙는다.
 * 아래 validate() 가 그 규칙을 기계적으로 강제한다.
 */
const fs = require('fs');
const path = require('path');

const B = __dirname;                       // .../SR2/NZ/src
const OUT_DIR = path.resolve(B, '..');     // .../SR2/NZ
const OUT_NAME = 'index.html';             // GitHub Pages 가 디렉터리 인덱스로 서빙한다

/* 구글 폰트만 외부 링크로 남긴다. 못 받아도 대체 폰트로 떨어질 뿐 수업은 굴러간다.
   그 외 모든 자산은 파일 안에 있다. */
const FONTS =
  'https://fonts.googleapis.com/css2?family=Gowun+Batang:wght@400;700&family=IBM+Plex+Sans+KR:wght@400;500;600;700&family=Spectral:ital,wght@0,400;0,600;1,400&display=swap';

/* 연결 순서가 중요하다. 뒤 모듈이 앞 모듈의 window.NZ.* 를 읽는다.
   cases/copy(데이터) → state(상태) → audio/court3d(장치) → ui(화면) → boot(시작). */
const JS_ORDER = [
  'cases.js',    // 사건 10개 — 수업 내용을 고치려면 여기만 고친다
  'copy.js',     // 화면 문구와 노직의 반응 대사 풀
  'state.js',    // 게임 상태 단일 소스 + localStorage
  'audio.js',    // 짧은 WebAudio 효과음 (기본 OFF)
  'court3d.js',  // three.js 법정 + 노직 캐릭터 (+ 2D 폴백)
  'ui.js',       // DOM 렌더링과 화면 전이
  'boot.js',     // 시작
];

const CSS_ORDER = ['base.css', 'ui.css'];
const HTML_ORDER = ['ui.html'];

function read(f) {
  const p = path.join(B, f);
  if (!fs.existsSync(p)) {
    missing.push(f);
    return '';
  }
  return fs.readFileSync(p, 'utf8');
}

const missing = [];
const problems = [];

function banner(name) {
  return '\n/* ==================== ' + name + ' ==================== */\n';
}

let js = '';
for (const f of JS_ORDER) {
  const src = read(f);
  if (src.trim()) js += banner(f) + src + '\n';
}
js += banner('boot') + 'if (window.NZ && window.NZ.start) { window.NZ.start(); }\n';

let css = '';
for (const f of CSS_ORDER) {
  const s = read(f);
  if (s.trim()) css += '\n/* --- ' + f + ' --- */\n' + s + '\n';
}

let html = '';
for (const f of HTML_ORDER) {
  const s = read(f);
  if (s.trim()) html += '\n<!-- ' + f + ' -->\n' + s + '\n';
}

/* ------------------------------------------------------------- 검증
   빌드 산출물이 아니라 소스 쪽 규칙 위반을 잡는다. CI 가 이 종료 코드를 본다. */
function check(label, text) {
  /* 인라인 <script id="APPJS" type="text/plain"> 안에 리터럴 "</script" 가 들어가면
     파서가 거기서 블록을 닫아 버려 페이지가 통째로 깨진다. */
  if (/<\/script/i.test(text)) problems.push(label + ': 리터럴 "</script" 시퀀스가 있다');

  const esm = text.match(/^\s*(import\s+[\w{*]|export\s+(default|const|let|var|function|class|\{))/gm);
  if (esm) problems.push(label + ': ES 모듈 문법 -> ' + esm.slice(0, 3).join(' | '));

  if (/(^|[^.\w])require\s*\(/.test(text)) problems.push(label + ': require() 를 쓴다');

  const urls = text.match(/https?:\/\/[^\s'"`)]+/g) || [];
  for (const u of urls) {
    if (u.startsWith('https://fonts.googleapis.com')) continue;
    if (u.startsWith('https://fonts.gstatic.com')) continue;
    if (u.startsWith('http://www.w3.org/')) continue;          // SVG/XML 네임스페이스
    if (u.startsWith('https://totojunior.github.io/')) continue; // 문서용 자기 주소
    problems.push(label + ': 외부 URL -> ' + u);
  }

  if (/\bfetch\s*\(/.test(text)) problems.push(label + ': fetch() 를 쓴다 (오프라인에서 죽는다)');
  if (/XMLHttpRequest/.test(text)) problems.push(label + ': XMLHttpRequest 를 쓴다');

  const todo = text.match(/(TODO|FIXME|\.\.\. rest of|placeholder implementation|not implemented|구현 예정)/gi);
  if (todo) problems.push(label + ': 미완성 마커 -> ' + [...new Set(todo)].join(', '));
}
check('JS', js);
check('CSS', css);
check('HTML', html);

/* three.js r134 에 없는 API 를 쓰면 교실에서 검은 화면이 된다.
   SR2/NZ/src/THREE-CONSTRAINTS.md 의 "NOT available" 목록을 기계로 강제한다. */
const R134_BANNED = [
  'CapsuleGeometry',
  'BufferGeometryUtils',
  'EffectComposer',
  'RenderPass',
  'UnrealBloomPass',
  'ShaderPass',
  'OrbitControls',
  'GLTFLoader',
  'outputColorSpace',
  'SRGBColorSpace',
  'ColorManagement',
  'setColorSpace',
];
for (const api of R134_BANNED) {
  const re = new RegExp('(?:THREE\\.' + api + '\\b|\\b' + api + '\\s*\\()');
  if (re.test(js)) problems.push('JS: three.js r134 에 없는 API -> ' + api);
}
/* texture.colorSpace 는 r152+ 속성. texture.encoding 을 써야 한다. */
if (/\.colorSpace\s*=/.test(js)) problems.push('JS: r134 에 없는 texture.colorSpace 대입 (encoding 을 써라)');

/* 사건 데이터 무결성. 콘텐츠를 고치다 깨뜨리면 빌드가 막아야 한다. */
try {
  const sandbox = { window: {} };
  new Function('window', read('cases.js'))(sandbox.window);
  const CASES = (sandbox.window.NZ || {}).CASES;
  if (!Array.isArray(CASES)) {
    problems.push('cases.js: window.NZ.CASES 배열이 만들어지지 않았다');
  } else {
    if (CASES.length !== 10) problems.push('cases.js: 사건이 ' + CASES.length + '개다 (10개여야 한다)');
    const ids = new Set();
    const optIds = new Set();
    for (const c of CASES) {
      if (ids.has(c.id)) problems.push('cases.js: 사건 id 중복 -> ' + c.id);
      ids.add(c.id);
      if (!Array.isArray(c.options) || c.options.length !== 2) {
        problems.push('cases.js: ' + c.id + ' 선택지가 2개가 아니다');
        continue;
      }
      for (const o of c.options) {
        if (optIds.has(o.id)) problems.push('cases.js: 선택지 id 중복 -> ' + o.id);
        optIds.add(o.id);
        if (/^[ab]$|^[12]$/.test(String(o.id))) problems.push('cases.js: 위치 의존 선택지 id -> ' + o.id);
      }
      if (!c.options.some((o) => o.id === c.answerId)) {
        problems.push('cases.js: ' + c.id + ' 의 answerId(' + c.answerId + ') 가 선택지에 없다');
      }
      const marks = (c.situation || []).join(' ');
      const open = (marks.match(/\[\[/g) || []).length;
      const close = (marks.match(/\]\]/g) || []).length;
      if (open !== close) problems.push('cases.js: ' + c.id + ' 의 [[ ]] 짝이 맞지 않는다 (' + open + '/' + close + ')');
      for (const f of ['title', 'reason', 'wrongLine', 'concept']) {
        if (!c[f] || !String(c[f]).trim()) problems.push('cases.js: ' + c.id + ' 의 ' + f + ' 가 비었다');
      }
    }
  }
} catch (e) {
  problems.push('cases.js: 평가 중 오류 -> ' + e.message);
}

/* ------------------------------------------------------------- 페이지 생성 */
const BOOT = `
(function () {
  var d = document;
  function put() {
    try {
      var st = d.createElement('style');
      st.textContent = d.getElementById('APPCSS').textContent;
      d.head.appendChild(st);
      var root = d.createElement('div');
      root.id = 'root';
      root.innerHTML = d.getElementById('APPHTML').textContent;
      d.body.appendChild(root);
      var sc = d.createElement('script');
      sc.textContent = d.getElementById('APPJS').textContent;
      d.body.appendChild(sc);
    } catch (e) {
      var p = d.createElement('pre');
      p.style.cssText = 'color:#e9e6df;background:#0b1020;padding:24px;font:14px/1.6 monospace;white-space:pre-wrap;';
      p.textContent = '시작하지 못했습니다: ' + (e && e.message) +
        '\\n\\n브라우저를 새로고침해 보세요. 그래도 안 되면 다른 브라우저(크롬)로 열어 보세요.';
      d.body.appendChild(p);
    }
  }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', put);
  else put();
})();
`.trim();

const THREE_LOCAL = path.join(B, 'vendor', 'three.r134.min.js');
if (!fs.existsSync(THREE_LOCAL)) {
  problems.push('vendor/three.r134.min.js 가 없다 — 오프라인 단일 파일을 만들 수 없다');
}

let page = null;
if (!missing.length && fs.existsSync(THREE_LOCAL)) {
  const threeSrc = fs.readFileSync(THREE_LOCAL, 'utf8');
  if (/<\/script/i.test(threeSrc)) {
    problems.push('vendor three.js 안에 "</script" 가 있다 — 인라인 불가');
  } else {
    page =
      '<!doctype html>\n<html lang="ko">\n<head>\n' +
      /* charset 은 첫 1024바이트 안에 있어야 한다. 한국어 로케일 브라우저가
         EUC-KR 로 찍어 버려 본문이 깨진 적이 있다. */
      '<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n' +
      '<meta name="color-scheme" content="dark">\n' +
      '<meta name="description" content="노직의 철학 법정 — 외부지문 2 지문 3(Nozick) 읽기 전 도입 활동">\n' +
      '<title>노직의 철학 법정 — 내 생각 말고, 노직의 생각!</title>\n' +
      '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
      '<link rel="stylesheet" href="' + FONTS + '">\n' +
      '</head>\n<body>\n' +
      '<script id="APPHTML" type="text/plain">' + html + '</scr' + 'ipt>\n' +
      '<script id="APPCSS" type="text/plain">' + css + '</scr' + 'ipt>\n' +
      '<script>' + threeSrc + '</scr' + 'ipt>\n' +
      '<script id="APPJS" type="text/plain">' + js + '</scr' + 'ipt>\n' +
      '<script id="BOOT">' + BOOT + '</scr' + 'ipt>\n' +
      '</body>\n</html>\n';
  }
}

console.log('---------------------------------------------');
for (const m of missing) console.log('  (없음) ' + m);
console.log('  js   ' + js.length.toLocaleString() + ' chars');
console.log('  css  ' + css.length.toLocaleString() + ' chars');
console.log('  html ' + html.length.toLocaleString() + ' chars');

if (problems.length) {
  console.log('\n!! 문제 ' + problems.length + '건:');
  for (const p of problems) console.log('   - ' + p);
  console.log('\n빌드를 중단한다. index.html 은 쓰지 않았다.');
  process.exitCode = 1;
} else if (page) {
  fs.writeFileSync(path.join(OUT_DIR, OUT_NAME), page, 'utf8');
  console.log(
    '\n' + OUT_NAME + ' 작성  ' + (page.length / 1048576).toFixed(2) +
    ' MB  (three.js 인라인 — 더블클릭으로 열리고 오프라인에서 작동)'
  );
  console.log('검증: 통과');
} else {
  console.log('\n소스 파일이 모자라 아직 페이지를 만들지 않았다.');
  process.exitCode = 1;
}
