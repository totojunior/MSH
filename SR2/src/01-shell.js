/* ------------------------------------------------------------------ Shell
   Self-publishing quine. The page can regenerate its own complete document
   with a new STATE payload, so a student's vote becomes a new version that
   every other open view reloads to.
   ------------------------------------------------------------------------ */
var Shell = (function () {
  var FONTS = 'https://fonts.googleapis.com/css2?family=Saira+Condensed:wght@400;500;600;700&family=Barlow:wght@400;500;600&family=Spectral:ital,wght@0,400;0,600;1,400&display=swap';
  var THREEJS = window.__THREE_SRC__ || '';
  var LT = '<' , GT = '>';
  function tag(name, attrs, body) {
    return LT + name + attrs + GT + body + LT + '/' + name + GT;
  }
  function txt(id) { var e = document.getElementById(id); return e ? e.textContent : ''; }

  /* A payload carrying the closing-script sequence would truncate the document
     the moment a browser parsed it, and the artifact would be dead for the
     whole room. HTML allows no whitespace between the slash and the tag name,
     so a plain case-insensitive search is exact. Built at runtime from LT so
     this source file never contains the sequence itself. */
  var CLOSE_SEQ = LT + '/script';
  var BSLASH = String.fromCharCode(92);

  function payload(id) {
    var s = txt(id);
    if (!s) throw new Error('Shell: #' + id + ' is empty - refusing to publish');
    var low = String(s).toLowerCase();
    if (low.indexOf(CLOSE_SEQ) >= 0) {
      throw new Error('Shell: #' + id + ' contains a closing script sequence');
    }
    /* The OTHER way a raw-text section can swallow its own end tag, and nothing
       checked it: an HTML comment open moves the tokenizer into
       script-data-escaped, and an opening script tag after that moves it into
       script-data-DOUBLE-escaped, where the next closing sequence is text and
       not an end tag -- so the document runs on into the next payload. This
       applies to type="text/plain" exactly as it does to real script. The
       payloads legitimately contain HTML comments (APPHTML has ten), so it is
       the PAIR that has to be refused, never either half. Both needles are
       built from LT so this file carries neither sequence itself -- APPJS
       contains this very source, and a literal here would arm the gate against
       the page's own code. */
    var C_OPEN = LT + '!--', S_OPEN = LT + 'script';
    if (low.indexOf(C_OPEN) >= 0 && low.indexOf(S_OPEN) >= 0) {
      throw new Error('Shell: #' + id + ' can double-escape its own script data');
    }
    return s;
  }

  /* Escape every '<' as a JSON unicode escape. JSON only ever puts '<' inside a
     string, where that escape is legal and parses back to the identical value,
     so no seat id can ever close the STATE tag. The backslash is assembled
     from a char code so this file carries none of its own. */
  function stateJson(state) {
    var j = JSON.stringify(state === undefined ? null : state);
    if (typeof j !== 'string') throw new Error('Shell: STATE is not serialisable');
    return j.split(LT).join(BSLASH + 'u003c');
  }

  /* An empty src would make the page load ITSELF as a script. Fall back to the
     src already in the DOM, and refuse outright if we cannot find a real one. */
  function threeSrc() {
    var s = THREEJS;
    if (!s) {
      var e = document.querySelector('script[src]');
      s = e ? e.getAttribute('src') : '';
    }
    s = String(s || '');
    if (s.indexOf('https://cdnjs.cloudflare.com/') !== 0) {
      throw new Error('Shell: three.js source is missing - refusing to publish');
    }
    /* This is the ONE payload interpolated into the document without being
       checked, and it lands in an ATTRIBUTE VALUE: a double quote would end the
       attribute and an angle bracket could open or close a tag inside body. A
       CDN URL needs none of those characters. */
    if (!/^[A-Za-z0-9:\/._~%?=&+-]+$/.test(s)) {
      throw new Error('Shell: three.js source contains unsafe characters');
    }
    return s;
  }

  function renderDoc(state) {
    /* Gather every part BEFORE emitting anything: a throw here leaves the
       published artifact untouched, which is the only safe way to fail. */
    var appHtml = payload('APPHTML');
    var appCss  = payload('APPCSS');
    var appJs   = payload('APPJS');
    var boot    = payload('BOOT');
    var three   = threeSrc();
    var st      = stateJson(state);

    var head =
      '<!doctype html>' + LT + 'html lang="en"' + GT + LT + 'head' + GT +
      LT + 'meta charset="utf-8"' + GT +
      LT + 'meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover"' + GT +
      LT + 'meta name="color-scheme" content="dark"' + GT +
      tag('title', '', 'The Trolley Problem') +
      LT + 'link rel="preconnect" href="https://fonts.gstatic.com" crossorigin' + GT +
      LT + 'link rel="stylesheet" href="' + FONTS + '"' + GT +
      LT + '/head' + GT + LT + 'body' + GT;

    var doc = head +
      tag('script', ' id="APPHTML" type="text/plain"', appHtml) +
      tag('script', ' id="APPCSS" type="text/plain"', appCss) +
      tag('script', ' id="STATE" type="application/json"', st) +
      tag('script', ' src="' + three + '"', '') +
      tag('script', ' id="APPJS" type="text/plain"', appJs) +
      tag('script', ' id="BOOT"', boot) +
      LT + '/body' + GT + LT + '/html' + GT;

    /* FINAL GATE. The round-trip contract was a comment; this enforces it.
       Each payload is sliced back out of the finished document exactly the way
       a parser will and compared byte for byte with what went in -- that is
       what makes rendering again from the reloaded page reproduce THIS
       document rather than a subtly different one.

       The opening tags are REBUILT from LT here instead of being searched for
       as literal text, because the payloads themselves contain the strings
       ' id="APPJS"' and ' id="BOOT"' -- this very file ships inside APPJS --
       so a plain indexOf(' id="BOOT"') finds the copy in the payload, hundreds
       of kilobytes before the real tag. (The ordering check that used to live
       here passed only because that stray hit still landed in ascending
       order.) An LT-built needle cannot collide, because payload() now refuses
       any payload that contains an opening script tag at all. */
    var parts = [
      ['APPHTML', ' id="APPHTML" type="text/plain"',     appHtml],
      ['APPCSS',  ' id="APPCSS" type="text/plain"',      appCss],
      ['STATE',   ' id="STATE" type="application/json"', st],
      ['APPJS',   ' id="APPJS" type="text/plain"',       appJs],
      ['BOOT',    ' id="BOOT"',                          boot]
    ];
    var i, at = -1, open, o0, b0, b1;
    for (i = 0; i < parts.length; i++) {
      open = LT + 'script' + parts[i][1] + GT;
      o0 = doc.indexOf(open);
      if (o0 <= at) throw new Error('Shell: emitted document is malformed at #' + parts[i][0]);
      if (doc.indexOf(open, o0 + 1) >= 0) throw new Error('Shell: #' + parts[i][0] + ' is emitted twice');
      at = o0;
      b0 = o0 + open.length;
      b1 = doc.indexOf(CLOSE_SEQ, b0);
      if (b1 < b0 || doc.slice(b0, b1) !== parts[i][2]) {
        throw new Error('Shell: #' + parts[i][0] + ' does not survive a round trip');
      }
    }
    if (doc.indexOf('<!doctype html>' + LT + 'html') !== 0) throw new Error('Shell: missing doctype');
    if (doc.slice(-7) !== LT + '/html' + GT) throw new Error('Shell: unterminated document');

    /* Six raw-text sections are opened above (APPHTML, APPCSS, STATE, the
       three.js src, APPJS, BOOT), so the finished document may contain exactly
       six closing sequences and not one more. Any other count means something
       got past its own gate, and the browser would truncate the page the
       moment it parsed it -- dead for the whole room. */
    var low = doc.toLowerCase(), from = 0, hit, nClose = 0;
    while ((hit = low.indexOf(CLOSE_SEQ, from)) >= 0) { nClose++; from = hit + CLOSE_SEQ.length; }
    if (nClose !== 6) {
      throw new Error('Shell: emitted document has ' + nClose + ' closing script sequences, expected 6');
    }
    return doc;
  }

  /* Cheap proof the quine still works, callable before we trust it with the
     one artifact 30 Chromebooks are pointed at. */
  function selfTest() {
    try {
      var probe = { v: 1, tally: { turn_nopush: 0, turn_push: 0, stay_nopush: 0, stay_push: 0 }, seats: {} };
      var a = renderDoc(probe);
      if (a.length < 4096) return false;
      if (a.indexOf(LT + '/html' + GT) !== a.length - 7) return false;
      /* the STATE we put in must come back out identically */
      var m = a.indexOf(' id="STATE"');
      var s0 = a.indexOf(GT, m) + 1;
      var s1 = a.indexOf(CLOSE_SEQ + GT, s0);
      var back = JSON.parse(a.slice(s0, s1));
      return !!(back && back.tally && back.tally.turn_push === 0);
    } catch (e) { return false; }
  }

  return { renderDoc: renderDoc, selfTest: selfTest, fonts: FONTS };
})();
