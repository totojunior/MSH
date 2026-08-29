/* Assembles the single-file artifact from the module parts in build/.
   Usage: node build/assemble.js  ->  writes trolley.html at the project root. */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const B = __dirname;

const THREE_SRC = fs.existsSync(path.join(B, 'three-src.txt'))
  ? fs.readFileSync(path.join(B, 'three-src.txt'), 'utf8').trim()
  : 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';

const FONTS = 'https://fonts.googleapis.com/css2?family=Saira+Condensed:wght@400;500;600;700&family=Barlow:wght@400;500;600&family=Spectral:ital,wght@0,400;0,600;1,400&display=swap';

/* JS concatenation order matters: SCRIPT first (Director reads it at IIFE time). */
const JS_ORDER = [
  'mod-copy.js',
  'mod-ko.js',        // KO lookup — must precede mod-ui.js, which renders through it
  'mod-audio.js',
  'mod-fx.js',
  'mod-worldA.js',
  'mod-worldB.js',
  'mod-ui.js',
  '00-director.js',
  '01-shell.js',
  '02-director.js',
];

const CSS_ORDER = ['base.css', 'mod-ui.css'];
const HTML_ORDER = ['base.html', 'mod-ui.html'];

function read(f) {
  const p = path.join(B, f);
  if (!fs.existsSync(p)) { console.warn('  (missing) ' + f); return ''; }
  return fs.readFileSync(p, 'utf8');
}

function banner(name) {
  return '\n/* ==================== ' + name + ' ==================== */\n';
}

let js = '';
for (const f of JS_ORDER) {
  const src = read(f);
  if (src.trim()) js += banner(f) + src + '\n';
}
js += banner('boot') + 'Director.start();\n';

let css = '';
for (const f of CSS_ORDER) { const s = read(f); if (s.trim()) css += '\n/* --- ' + f + ' --- */\n' + s + '\n'; }

let html = '';
for (const f of HTML_ORDER) { const s = read(f); if (s.trim()) html += '\n<!-- ' + f + ' -->\n' + s + '\n'; }

/* ------------------------------------------------------------ validation */
const problems = [];
function check(label, text) {
  if (/<\/script/i.test(text)) problems.push(label + ': contains a literal "</script" sequence');
  const bad = text.match(/^\s*(import\s+[\w{*]|export\s+(default|const|function|class|\{))/gm);
  if (bad) problems.push(label + ': ES module syntax -> ' + bad.slice(0, 3).join(' | '));
  if (/\brequire\s*\(/.test(text)) problems.push(label + ': uses require()');
  const urls = text.match(/https?:\/\/[^\s'"`)]+/g) || [];
  for (const u of urls) {
    if (u.startsWith('https://cdnjs.cloudflare.com')) continue;
    if (u.startsWith('https://fonts.googleapis.com')) continue;
    if (u.startsWith('https://fonts.gstatic.com')) continue;
    if (u.startsWith('http://www.w3.org/')) continue;   // SVG/XML namespaces are fine
    problems.push(label + ': external URL -> ' + u);
  }
  if (/\bfetch\s*\(/.test(text)) problems.push(label + ': uses fetch()');
  if (/XMLHttpRequest/.test(text)) problems.push(label + ': uses XMLHttpRequest');
  const todo = text.match(/(TODO|FIXME|\.\.\. rest of|placeholder implementation|not implemented)/gi);
  if (todo) problems.push(label + ': placeholder marker -> ' + [...new Set(todo)].join(', '));
}
check('JS', js);
check('CSS', css);
check('HTML', html);

/* ------------------------------------------------------------- emit page */
const BOOT = `
(function(){
  window.__THREE_SRC__ = ${JSON.stringify(THREE_SRC)};
  var d = document;
  function put(){
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
      p.style.cssText = 'color:#e8eaec;background:#06080a;padding:24px;font:14px/1.5 monospace;';
      p.textContent = 'Failed to start: ' + (e && e.message);
      d.body.appendChild(p);
    }
  }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', put);
  else put();
})();
`.trim();

const STATE0 = JSON.stringify({ v: 1, tally: { turn_nopush: 0, turn_push: 0, stay_nopush: 0, stay_push: 0 }, seats: {} });

const page =
  /* Belt and braces. The Artifact wrapper supplies a charset, but a page served
     anywhere else without one gets guessed at — a Korean-locale browser picked
     EUC-KR and mangled every em dash in the copy. Must stay inside the first
     1024 bytes to be honoured. */
  '<meta charset="utf-8">\n' +
  '<title>The Trolley Problem</title>\n' +
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
  '<link rel="stylesheet" href="' + FONTS + '">\n' +
  '<script id="APPHTML" type="text/plain">' + html + '</scr' + 'ipt>\n' +
  '<script id="APPCSS" type="text/plain">' + css + '</scr' + 'ipt>\n' +
  '<script id="STATE" type="application/json">' + STATE0 + '</scr' + 'ipt>\n' +
  '<script src="' + THREE_SRC + '"></scr' + 'ipt>\n' +
  '<script id="APPJS" type="text/plain">' + js + '</scr' + 'ipt>\n' +
  '<script id="BOOT">' + BOOT + '</scr' + 'ipt>\n';

/* The artifact-hosted variant (no <html> wrapper, three.js pulled from cdnjs)
   is NOT written any more. The deliverable is the standalone file below, and
   the published artifact was deleted at the teacher's request; emitting a
   second 0.7 MB copy on every build was just clutter.
   To bring it back: fs.writeFileSync(path.join(B,'trolley-artifact.html'), page). */

/* ------------------------------------------------------- standalone build
   The classroom deliverable: a complete document that opens by double-click
   from a USB stick with no server and no internet. three.js is inlined
   (601 KB) rather than fetched, because a school network that blocks cdnjs —
   or simply has no connection in that room — would otherwise leave the
   teacher with a black screen in front of the class. Google Fonts stays as a
   link: it degrades to the declared fallback stacks, which is a cosmetic
   change, not a broken lesson. */
const THREE_LOCAL = path.join(B, 'vendor', 'three.r134.min.js');
let standalone = null;
if (fs.existsSync(THREE_LOCAL)) {
  const threeSrc = fs.readFileSync(THREE_LOCAL, 'utf8');
  if (/<\/script/i.test(threeSrc)) {
    console.warn('  !! vendored three.js contains "</script" — cannot inline');
  } else {
    standalone =
      '<!doctype html>\n<html lang="en">\n<head>\n' +
      '<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">\n' +
      '<meta name="color-scheme" content="dark">\n' +
      '<title>The Trolley Problem</title>\n' +
      '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
      '<link rel="stylesheet" href="' + FONTS + '">\n' +
      '</head>\n<body>\n' +
      '<script id="APPHTML" type="text/plain">' + html + '</scr' + 'ipt>\n' +
      '<script id="APPCSS" type="text/plain">' + css + '</scr' + 'ipt>\n' +
      '<script id="STATE" type="application/json">' + STATE0 + '</scr' + 'ipt>\n' +
      '<script>' + threeSrc + '</scr' + 'ipt>\n' +
      '<script id="APPJS" type="text/plain">' + js + '</scr' + 'ipt>\n' +
      '<script id="BOOT">' + BOOT + '</scr' + 'ipt>\n' +
      '</body>\n</html>\n';
    fs.writeFileSync(path.join(ROOT, 'trolley.html'), standalone, 'utf8');
  }
}

console.log('---------------------------------------------');
console.log('  js   ' + js.length.toLocaleString() + ' chars');
console.log('  css  ' + css.length.toLocaleString() + ' chars');
console.log('  html ' + html.length.toLocaleString() + ' chars');

if (standalone) {
  console.log('wrote trolley.html           ' + (standalone.length / 1048576).toFixed(2) + ' MB  (three.js INLINED — opens by double-click, works offline)');
} else {
  console.log('  (no standalone: build/vendor/three.r134.min.js missing)');
}
if (problems.length) {
  console.log('\n!! ' + problems.length + ' PROBLEM(S):');
  for (const p of problems) console.log('   - ' + p);
  process.exitCode = 1;
} else {
  console.log('\nvalidation: clean');
}
