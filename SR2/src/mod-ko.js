/* =========================================================================
   KOREAN — a lookup from the authored English string to its Korean line.

   Deliberately a dictionary rather than a parallel SCRIPT: the English copy
   stays the single source of truth, nothing in the lesson structure changes,
   and a string that is missing here simply shows in English alone instead of
   breaking. Keys must match the authored English EXACTLY, including the em
   dashes, middle dots, curly quotes and ellipses.

   Register: the English is terse and grave — short declaratives, no
   softening. The Korean matches that. 해요체 is avoided; plain 합니다/니다
   endings keep the weight. Nothing is explained that the English does not
   explain.
   ========================================================================= */
var KO = (function () {
  var M = {

    /* ---------------------------------------------------------- boot */
    'THE TROLLEY PROBLEM': '트롤리 문제',
    'A moral puzzle, before you read it.': '읽기 전에, 먼저 겪어 보는 도덕적 난제.',
    'Michael Sandel, Justice': '마이클 샌델, 『정의란 무엇인가』',
    'You will make two choices. There are no right answers on this screen.':
      '당신은 두 번 선택합니다. 이 화면에 정답은 없습니다.',
    'I AM A STUDENT': '학생입니다',
    'I AM THE PROJECTOR': '교실 화면입니다',
    'Sound is part of this. Students: headphones on, or leave sound off.':
      '소리도 수업의 일부입니다. 학생은 이어폰을 쓰거나 소리를 꺼 두세요.',
    'SOUND ON': '소리 켬',
    'SOUND OFF': '소리 끔',
    'Mouse, touch, or keyboard. All three work.': '마우스, 터치, 키보드 모두 됩니다.',
    'Two decisions. Eight seconds each.': '두 번의 결정. 각각 8초.',
    'Doing nothing is also a decision.': '아무것도 하지 않는 것도 결정입니다.',
    'Tap anywhere to begin.': '아무 곳이나 눌러 시작하세요.',
    'BEGIN': '시작',
    'One screen, one set of answers. Sound starts off.':
      '화면 하나에 답 한 벌. 소리는 꺼진 채로 시작합니다.',
    'Front of the room. Sound on. Class results shown here.':
      '교실 앞 화면. 소리 켬. 반 전체 결과가 여기 표시됩니다.',
    'This shows a collision. No blood. If you need to look away, look away.':
      '충돌 장면이 나옵니다. 피는 없습니다. 보기 힘들면 고개를 돌려도 됩니다.',

    /* ------------------------------------------------------- scene A */
    'You are the driver of a trolley car.': '당신은 전차 운전사입니다.',
    'Sixty miles an hour.': '시속 60마일.',
    'The line ahead runs straight for a mile.': '앞 선로는 1마일을 곧게 뻗어 있습니다.',
    'CASE 1 — THE DRIVER': '사례 1 — 운전사',
    'Five workers on the line ahead.': '앞 선로에 인부 다섯 명.',
    'Tools in their hands. Backs turned.': '손에 연장을 들고, 등을 돌린 채.',
    'They have not heard you.': '그들은 당신을 듣지 못했습니다.',
    'You are not slowing down.': '속도는 줄지 않습니다.',
    'They are not going to move.': '그들은 비키지 않습니다.',
    'PULL THE BRAKE': '브레이크를 당겨라',
    'Hold it. Or hold SPACE.': '누르고 있으세요. 또는 스페이스를 길게.',
    'THE BRAKES DO NOT WORK.': '브레이크가 듣지 않습니다.',
    'The screaming stops. Nothing has changed.': '쇳소리가 멎습니다. 달라진 것은 없습니다.',
    'BRAKE FAILURE — SIDE TRACK RIGHT — ONE WORKER':
      '브레이크 고장 — 오른쪽 분기 선로 — 인부 한 명',
    'A side track, off to the right. One worker on it.':
      '오른쪽으로 분기 선로. 그 위에 인부 한 명.',
    'DECIDE': '결정하세요',
    'STAY ON COURSE': '그대로 직진',
    'Five men on the main line.': '본선에 다섯 명.',
    'Stay on course. Five workers ahead.': '그대로 직진합니다. 앞에 인부 다섯 명.',
    'THROW THE SWITCH': '선로를 바꾼다',
    'One man on the side track.': '분기 선로에 한 명.',
    'Throw the switch onto the side track. One worker there.':
      '분기 선로로 바꿉니다. 그곳에 인부 한 명.',
    'You did not move. The trolley kept its course.':
      '당신은 움직이지 않았습니다. 전차는 그대로 갔습니다.',
    'YOU KILLED FIVE MEN.': '당신은 다섯 명을 죽였습니다.',
    'You held the course. They never turned around.':
      '당신은 방향을 지켰습니다. 그들은 끝내 돌아보지 않았습니다.',
    'YOU KILLED ONE MAN.': '당신은 한 명을 죽였습니다.',
    'He was working. He never saw the trolley.':
      '그는 일하고 있었습니다. 전차를 보지 못했습니다.',
    'MPH': '마일/시',
    'BRAKE': '브레이크',
    'BRAKE FAIL': '브레이크 고장',
    'MAIN LINE  ·  5': '본선  ·  5명',
    'SIDE TRACK  ·  1': '분기 선로  ·  1명',

    /* ------------------------------------------------------- scene B */
    'CASE 2 — THE BRIDGE': '사례 2 — 다리 위',
    'A second case.': '두 번째 사례.',
    'The same trolley. The same five men.': '같은 전차. 같은 다섯 명.',
    'This time you are not in the cab.': '이번에 당신은 운전석에 없습니다.',
    'You are not driving now.': '당신은 이제 운전하지 않습니다.',
    'You are on a bridge above the track.': '당신은 선로 위 다리에 서 있습니다.',
    'There is no side track.': '분기 선로는 없습니다.',
    'Five workers at the end of the line.': '선로 끝에 인부 다섯 명.',
    'Once again, the brakes do not work.': '이번에도 브레이크는 듣지 않습니다.',
    'Beside you at the railing, a very heavy man.':
      '난간 옆에, 몸집이 아주 큰 남자.',
    'His back is turned. He is breathing.': '등을 돌린 채. 숨을 쉬고 있습니다.',
    'You are too small to stop it.': '당신은 전차를 멈추기엔 너무 작습니다.',
    'He is not.': '그는 아닙니다.',
    'You have not moved.': '당신은 움직이지 않았습니다.',
    'Your hand is still on the rail.': '당신의 손은 아직 난간 위에 있습니다.',
    'The trolley is not slowing down.': '전차는 속도를 줄이지 않습니다.',
    'He turns his head. He sees you.': '그가 고개를 돌립니다. 당신을 봅니다.',
    'He does not know why you are close.': '그는 당신이 왜 가까이 있는지 모릅니다.',
    'PRESS AND DRAG YOUR HAND INTO HIS BACK': '그의 등을 향해 손을 밀어 넣으세요',
    'Or hold SPACE.': '또는 스페이스를 길게 누르세요.',
    'A tap is not enough.': '한 번 톡 눌러서는 안 됩니다.',
    'You let go.': '당신은 손을 놓았습니다.',
    'KEEP YOUR HANDS ON THE RAIL': '난간에서 손을 떼지 않는다',
    'PUSH HIM': '민다',
    'He falls. The trolley stops.': '그가 떨어집니다. 전차가 멈춥니다.',
    'DRAG  /  HOLD SPACE': '드래그  /  스페이스 길게',
    'Push the heavy man onto the track. Drag forward or hold space.':
      '덩치 큰 남자를 선로로 밉니다. 앞으로 드래그하거나 스페이스를 길게 누르세요.',
    'DO NOT PUSH': '밀지 않는다',
    'Your hands stay on the rail.': '당신의 손은 난간에 그대로 둡니다.',
    'Do not push. Keep your hands on the rail.': '밀지 않습니다. 손은 난간에 둡니다.',
    'You did not push. The trolley did not stop.':
      '당신은 밀지 않았습니다. 전차는 멈추지 않았습니다.',
    'You felt him go. The trolley stopped on his body.':
      '그가 넘어가는 감촉이 손에 남았습니다. 전차는 그의 몸 위에서 멈췄습니다.',
    'FIVE MEN ARE DEAD.': '다섯 명이 죽었습니다.',
    'You never touched him. He is still breathing beside you.':
      '당신은 그를 건드리지 않았습니다. 그는 아직 당신 옆에서 숨 쉬고 있습니다.',
    'BELOW  ·  5': '아래  ·  5명',
    'BESIDE YOU  ·  1': '당신 옆  ·  1명',
    'NO SIDE TRACK': '분기 선로 없음',
    'INCOMING': '접근 중',
    'The trolley stopped four hundred feet later.': '전차는 120미터를 더 가서 멈췄습니다.',
    'The trolley stopped.': '전차가 멈췄습니다.',
    'This scene shows a collision. No blood, no gore. Look away if you need to.':
      '충돌 장면입니다. 피나 잔혹한 묘사는 없습니다. 힘들면 고개를 돌리세요.',
    'Press S to skip the collision.': 'S를 누르면 충돌 장면을 건너뜁니다.',
    'SKIP': '건너뛰기',

    /* -------------------------------------------------------- submit */
    'SENDING YOUR TWO ANSWERS…': '두 개의 답을 보내는 중…',
    'RECORDED.': '기록되었습니다.',
    'Wait for the front of the room.': '교실 앞 화면을 기다리세요.',
    'No connection. Your answers stay on this screen.':
      '연결 없음. 당신의 답은 이 화면에만 남습니다.',
    'The teacher can count hands instead.': '선생님이 손을 들게 해 세면 됩니다.',
    'That did not send.': '전송되지 않았습니다.',
    'TRY AGAIN': '다시 시도',
    'CONTINUE WITHOUT SENDING': '보내지 않고 계속',
    'CLASS CODE': '반 코드',
    'Same code on every screen.': '모든 화면에 같은 코드가 뜹니다.',
    'YOU ANSWERED': '당신의 답',

    /* -------------------------------------------------------- reveal */
    'THE ROOM': '이 교실',
    'Every answer in this room, side by side.': '이 교실의 모든 답을 나란히.',
    'Most people would say, "Turn!"': '대부분은 이렇게 말합니다. "바꿔야지!"',
    'Most people would say, "Of course not."': '대부분은 이렇게 말합니다. "당연히 안 되지."',
    'CASE 1 · THE DRIVER': '사례 1 · 운전사',
    'CASE 2 · THE BRIDGE': '사례 2 · 다리 위',
    'STAYED ON COURSE': '그대로 직진했다',
    'THREW THE SWITCH': '선로를 바꿨다',
    'PUSHED HIM': '밀었다',
    'DID NOT PUSH': '밀지 않았다',
    'YOU': '당신',
    'THIS ROOM': '이 교실',
    'THE PASSAGE': '지문',
    'answers': '명 응답',
    'total': '전체',
    'WAITING FOR THE ROOM…': '교실의 답을 기다리는 중…',
    'No answers yet.': '아직 응답이 없습니다.',
    'NO ANSWER': '응답 없음',
    'Sandel says most people turn. Sandel says most people will not push.':
      '샌델은 말합니다. 대부분은 선로를 바꾸고, 대부분은 밀지 않는다고.',
    'Same five lives. Same one life. Two different answers.':
      '같은 다섯 명의 목숨. 같은 한 명의 목숨. 그런데 답이 다릅니다.',

    /* ------------------------------------------------------ confront */
    'This is what you did.': '당신이 한 일입니다.',
    'CASE 1': '사례 1',
    'CASE 2': '사례 2',
    'You turned the trolley onto one man to save five.':
      '당신은 다섯을 구하려고 전차를 한 사람 쪽으로 돌렸습니다.',
    'You would not push one man to save five.':
      '당신은 다섯을 구하려고 한 사람을 밀지는 않았습니다.',
    'Same arithmetic, opposite answer. The only thing that changed was your hands.':
      '산수는 같은데 답은 반대입니다. 달라진 것은 당신의 손뿐입니다.',
    'You let the trolley take five men.': '당신은 전차가 다섯 명을 덮치게 두었습니다.',
    'Then you let it take five more.': '그리고 다시 다섯 명을 더 덮치게 두었습니다.',
    'You held one rule twice. Ten men are dead. Ask what the rule is, and what it cost.':
      '당신은 하나의 원칙을 두 번 지켰습니다. 열 명이 죽었습니다. 그 원칙이 무엇이었는지, 그리고 무엇을 치렀는지 물어보세요.',
    'You pushed one man off a bridge to save five.':
      '당신은 다섯을 구하려고 한 사람을 다리에서 밀었습니다.',
    'You were consistent. Most people are not. Sandel wants to know why they are not.':
      '당신은 일관됐습니다. 대부분은 그렇지 않습니다. 샌델은 왜 그렇지 않은지를 묻습니다.',
    'You would not throw the switch to save five.':
      '당신은 다섯을 구하려고 선로를 바꾸지는 않았습니다.',
    'Then you put your hands on a man and pushed.':
      '그런데 한 사람에게 손을 대고 밀었습니다.',
    'You refused the lever and used your hands. Something changed between the two.':
      '레버는 거부하고 손은 썼습니다. 그 사이에 무언가가 달라졌습니다.',
    'You made two choices about the same five lives.':
      '당신은 같은 다섯 목숨을 두고 두 번 선택했습니다.',
    'They were not the same choice.': '그 둘은 같은 선택이 아니었습니다.',
    'That gap is the whole problem. It is not a mistake. It is the thing to explain.':
      '그 간극이 바로 문제의 전부입니다. 실수가 아닙니다. 설명해야 할 대상입니다.',
    'Do not answer yet. Open the passage.': '아직 답하지 마세요. 지문을 펴세요.',
    'PLAY AGAIN': '다시 하기',
    'OR': '또는',

    /* ------------------------------------------------------- teacher */
    'TEACHER CONTROLS': '교사 컨트롤',
    'Press T to hide. Arrow keys step the lesson. Nothing here is shown to students.':
      'T를 누르면 숨김. 방향키로 수업을 넘깁니다. 여기 있는 것은 학생에게 보이지 않습니다.',
    'LIVE · CLASS TALLY ON': '실시간 · 집계 켜짐',
    'MANUAL · NO NETWORK': '수동 · 네트워크 없음',
    'PAUSED': '일시정지',
    'RUNTIME': '경과 시간',
    'PAUSE': '일시정지',
    'RESUME': '계속',
    'BOOT': '시작 화면',
    'COLD OPEN': '오프닝',
    'CASE 1 · DRIVER': '사례 1 · 운전사',
    'CASE 2 · BRIDGE': '사례 2 · 다리 위',
    'CLASS RESULTS': '반 결과',
    'CONFRONT': '대면',
    'REPLAY IMPACT 1': '충돌 1 다시 보기',
    'REPLAY IMPACT 2': '충돌 2 다시 보기',
    'SKIP THE IMPACT': '충돌 장면 건너뛰기',
    'RESET THE LESSON': '수업 초기화',
    'Press again to wipe all answers.': '한 번 더 누르면 모든 답이 지워집니다.',
    'HOLD THE ROOM · ADVANCE WHEN READY': '교실을 붙잡아 두세요 · 준비되면 넘기세요',
    'FULLSCREEN (F)': '전체화면 (F)',
    'PRESS F11 FOR FULLSCREEN': '전체화면은 F11',
    'Do not explain the dilemma first. Let them choose blind.':
      '딜레마를 먼저 설명하지 마세요. 모르는 채로 고르게 하세요.',
    'Say nothing during the eight seconds. The silence is the lesson.':
      '8초 동안 아무 말도 하지 마세요. 그 침묵이 수업입니다.',
    'After Case 1, do not ask why. Go straight to Case 2.':
      '사례 1이 끝나면 이유를 묻지 마세요. 바로 사례 2로 가세요.',
    'Hold the CONFRONT screen. Let it be uncomfortable for ten seconds.':
      '대면 화면에서 멈추세요. 10초 동안 불편하게 두세요.',
    'The closing question is not rhetorical. Do not answer it for them.':
      '마지막 질문은 수사적 질문이 아닙니다. 대신 답해 주지 마세요.',
    'Then open the handout and read the passage aloud.':
      '그다음 유인물을 펴고 지문을 소리 내어 읽으세요.',
    'Run this before the passage. Do not explain it first. Let them choose blind.':
      '지문보다 먼저 돌리세요. 설명하지 말고, 모르는 채로 고르게 하세요.',

    /* -------------------------------------------------------- errors */
    '3D IS NOT AVAILABLE ON THIS SCREEN': '이 화면에서는 3D를 쓸 수 없습니다',
    'The lesson still works. You will read it instead of seeing it.':
      '수업은 그대로 진행됩니다. 보는 대신 읽게 됩니다.',
    'CONTINUE IN TEXT': '글로 계속하기',
    'NO SOUND': '소리 없음',
    'Sound is blocked on this machine. Everything else still works.':
      '이 기기에서는 소리가 차단돼 있습니다. 나머지는 모두 작동합니다.',
    'CONTINUE': '계속',
    'SOMETHING BROKE': '문제가 생겼습니다',
    'Reload the page. Your answers are not lost until you close the tab.':
      '페이지를 새로고침하세요. 탭을 닫기 전까지 답은 사라지지 않습니다.',
    'RELOAD': '새로고침',
    'RECONNECTING…': '다시 연결하는 중…',
    'The graphics card dropped out. Hold on.': '그래픽 카드가 끊겼습니다. 잠시만요.',
    'ALREADY OPEN IN ANOTHER TAB': '다른 탭에서 이미 열려 있습니다',
    'Use one tab, or the sound will play twice.':
      '탭 하나만 쓰세요. 안 그러면 소리가 두 번 납니다.',
    'USE THIS TAB': '이 탭을 사용',

    /* -------------------------------------------------------- prompts */
    'Click, tap, or press the key.': '클릭, 터치, 또는 키를 누르세요.',
    'Drag. A tap is not enough.': '드래그하세요. 한 번 누르는 것으로는 안 됩니다.',
    'Doing nothing is also a choice.': '아무것도 하지 않는 것도 선택입니다.'
  };

  /* Exact lookup first. Then a whitespace-normalised one, because several
     lines are authored twice — once flowing, once hard-wrapped for the
     projector — and both should get the same Korean. */
  var NORM = {};
  (function () {
    for (var k in M) {
      if (!Object.prototype.hasOwnProperty.call(M, k)) continue;
      NORM[k.replace(/\s+/g, ' ').trim()] = M[k];
    }
  })();

  function get(s) {
    if (typeof s !== 'string') return '';
    if (Object.prototype.hasOwnProperty.call(M, s)) return M[s];
    var n = s.replace(/\s+/g, ' ').trim();
    if (Object.prototype.hasOwnProperty.call(NORM, n)) return NORM[n];
    return '';
  }

  return { get: get, map: M };
})();
