/* =====================================================================
   MODULE: copy  -  all user-facing text + beat timing for the lesson hook
   DECLARES EXACTLY ONE GLOBAL: SCRIPT
   No DOM, no THREE, no audio, no timers. Pure data + pure helpers.
   Every helper is a property of SCRIPT; nothing else leaves the IIFE.
   All non-ASCII is written as \u escapes so the file survives any
   encoding the artifact host applies.
   ===================================================================== */

var SCRIPT = (function () {
  'use strict';

  var S = {};

  /* Glyphs, once, as escapes. Used everywhere below. */
  var MDASH  = '—';                 /* em dash             */
  var MIDDOT = '·';                 /* middle dot          */
  var ELL    = '…';                 /* ellipsis            */
  var LARR   = '←', RARR = '→'; /* arrows              */
  var TRIL   = '◀', TRIR = '▶'; /* transport triangles */

  /* ------------------------------------------------------------------
     META
     ------------------------------------------------------------------ */
  S.meta = {
    title: 'THE TROLLEY PROBLEM',
    subtitle: 'A moral puzzle, before you read it.',
    source: 'Michael Sandel, Justice',
    teacherNote: 'Run this before the passage. Do not explain it first. Let them choose blind.',
    version: '1.0'
  };

  /* ------------------------------------------------------------------
     BOOT / ROLE SELECT
     ------------------------------------------------------------------ */
  S.boot = {
    title: 'THE TROLLEY PROBLEM',
    sub: 'You will make two choices. There are no right answers on this screen.',
    studentBtn: 'I AM A STUDENT',
    projectorBtn: 'I AM THE PROJECTOR',
    audioNote: 'Sound is part of this. Students: headphones on, or leave sound off.',
    audioOnBtn: 'SOUND ON',
    audioOffBtn: 'SOUND OFF',
    howto: [
      'Mouse, touch, or keyboard. All three work.',
      'Two decisions. Eight seconds each.',
      'Doing nothing is also a decision.'
    ],
    startHint: 'Tap anywhere to begin.',
    startBtn: 'BEGIN',
    roleStudentSub: 'One screen, one set of answers. Sound starts off.',
    roleProjectorSub: 'Front of the room. Sound on. Class results shown here.',
    warning: 'This shows a collision. No blood. If you need to look away, look away.'
  };

  /* ------------------------------------------------------------------
     COLD OPEN  (black screen, low rumble, white type)
     t = seconds from beat start, hold = seconds the line stays up.
     cold[0] is the mandated line; a director may show only that one.

     RE-TIMED. The words are untouched; only the clock moved. The caption
     types at 38 chars/s and the hold starts AFTER the last character, so a
     line really clears at t + chars/38 + hold: 3.55 s, 5.83 s, 8.35 s. The
     slate then takes 8.4 -> 10.1 and the cab fades up at coldMs 10.2.
     Thirteen seconds of black before the first picture was too long to hold
     a room of sixteen-year-olds; the gaps between the lines also close
     (3.1 s, then 2.1 s) so the cold open tightens as it goes.
     ------------------------------------------------------------------ */
  S.cold = [
    { t: 0.4, text: 'You are the driver of a trolley car.', hold: 2.2, hero: true },
    { t: 3.5, text: 'Sixty miles an hour.', hold: 1.8 },
    { t: 5.6, text: 'The line ahead runs straight for a mile.', hold: 1.7 }
  ];

  /* ------------------------------------------------------------------
     SCENE A  -  THE DRIVER'S CAB
     ------------------------------------------------------------------ */
  S.sceneA = {
    slate: 'CASE 1 ' + MDASH + ' THE DRIVER',

    /* Gaps of 2.6, 2.8, 2.4 then 2.2 s: the lines close up as the five do.
       The last one clears at 10.8 + 27/38 + 2.2 = 13.71 s, just inside
       sceneAApproachMs (13800), so nothing is cut off by the brake beat. */
    lines: [
      { t: 0.8,  text: 'Five workers on the line ahead.',      hold: 2.2 },
      { t: 3.4,  text: 'Tools in their hands. Backs turned.',  hold: 2.2 },
      { t: 6.2,  text: 'They have not heard you.',             hold: 2.0 },
      { t: 8.6,  text: 'You are not slowing down.',            hold: 1.9 },
      { t: 10.8, text: 'They are not going to move.',          hold: 2.2 }
    ],

    brakePrompt: 'PULL THE BRAKE',
    brakePromptSub: 'Hold it. Or hold SPACE.',
    brakeFail: 'THE BRAKES DO NOT WORK.',
    brakeFailSub: 'The screaming stops. Nothing has changed.',
    warning: 'BRAKE FAILURE ' + MDASH + ' SIDE TRACK RIGHT ' + MDASH + ' ONE WORKER',
    sideTrackReveal: 'A side track, off to the right. One worker on it.',

    choicePrompt: 'DECIDE',
    choices: [
      { id: 'stay', label: 'STAY ON COURSE', sub: 'Five men on the main line.',
        key: 'A', keys: ['a', 'arrowleft', '1'], keyHint: 'A  /  ' + LARR,
        aria: 'Stay on course. Five workers ahead.' },
      { id: 'turn', label: 'THROW THE SWITCH', sub: 'One man on the side track.',
        key: 'D', keys: ['d', 'arrowright', '2'], keyHint: 'D  /  ' + RARR,
        aria: 'Throw the switch onto the side track. One worker there.' }
    ],

    noChoice: 'You did not move. The trolley kept its course.',

    verdictStay: {
      title: 'YOU KILLED FIVE MEN.',
      line: 'You held the course. They never turned around.'
    },
    verdictTurn: {
      title: 'YOU KILLED ONE MAN.',
      line: 'He was working. He never saw the trolley.'
    },

    hud: {
      speed: '60',
      speedUnit: 'MPH',
      brake: 'BRAKE',
      brakeFailShort: 'BRAKE FAIL',
      mainLine: 'MAIN LINE  ' + MIDDOT + '  5',
      sideLine: 'SIDE TRACK  ' + MIDDOT + '  1'
    }
  };

  /* ------------------------------------------------------------------
     SCENE B  -  THE BRIDGE
     ------------------------------------------------------------------ */
  S.sceneB = {
    slate: 'CASE 2 ' + MDASH + ' THE BRIDGE',

    /* The black interstitial between the two cases: played on the COLD
       screen before WorldB is mounted, so nothing here may depend on a
       picture. Ends at 9.2 s -> timing.sceneBIntroMs. The third line moves
       the CAMERA, not the role, so it hands off to lines[0] ('You are not
       driving now.') instead of pre-empting it. */
    intro: [
      { t: 0.6, text: 'A second case.',                     hold: 2.6, hero: true },
      { t: 3.2, text: 'The same trolley. The same five men.', hold: 3.0 },
      { t: 6.6, text: 'This time you are not in the cab.',    hold: 2.6 }
    ],

    lines: [
      { t: 0.6,  text: 'You are not driving now.',                     hold: 2.6 },
      { t: 3.4,  text: 'You are on a bridge above the track.',         hold: 2.8 },
      { t: 6.6,  text: 'There is no side track.',                      hold: 2.4 },
      { t: 9.2,  text: 'Five workers at the end of the line.',         hold: 2.8 },
      { t: 12.4, text: 'Once again, the brakes do not work.',          hold: 2.8 },
      { t: 15.4, text: 'Beside you at the railing, a very heavy man.', hold: 3.0 },
      { t: 18.8, text: 'His back is turned. He is breathing.',         hold: 2.8 },
      { t: 21.8, text: 'You are too small to stop it.',                hold: 2.4 },
      { t: 24.4, text: 'He is not.',                                   hold: 2.4 }
    ],

    /* t is relative to the moment hesitation is DETECTED, never to scene
       start. Feeding these scene-elapsed time shows them all at once. */
    /* Retimed so all three actually reach the screen. The window they play
       inside is sceneBChoiceMs = 8 s, and detection costs sceneBHesitateAfterMs
       of it: at the old 3.0 s + 5.2 s the third line landed at 8.2 s, after the
       countdown had already answered for the student, so it was never once
       seen. 1.8 + 4.2 puts the last line at 6.0 s, inside the window. */
    hesitateLines: [
      { t: 0.0, text: 'You have not moved.',              hold: 2.0 },
      { t: 2.2, text: 'Your hand is still on the rail.',  hold: 2.0 },
      { t: 4.2, text: 'The trolley is not slowing down.', hold: 2.0 }
    ],

    eyeContact: 'He turns his head. He sees you.',
    eyeContactSub: 'He does not know why you are close.',

    pushHint: 'PRESS AND DRAG YOUR HAND INTO HIS BACK',
    pushHintKeyboard: 'Or hold SPACE.',
    pushHintFail: 'A tap is not enough.',
    pushHintRelease: 'You let go.',
    refuseLabel: 'KEEP YOUR HANDS ON THE RAIL',

    choicePrompt: 'DECIDE',
    choices: [
      { id: 'push', label: 'PUSH HIM', sub: 'He falls. The trolley stops.',
        key: 'SPACE', keys: ['space', 'enter', 'arrowup'],
        keyHint: 'DRAG  /  HOLD SPACE', gesture: true,
        aria: 'Push the heavy man onto the track. Drag forward or hold space.' },
      { id: 'nopush', label: 'DO NOT PUSH', sub: 'Your hands stay on the rail.',
        key: 'X', keys: ['x', 'arrowdown', '0'], keyHint: 'X', gesture: false,
        aria: 'Do not push. Keep your hands on the rail.' }
    ],

    noChoice: 'You did not push. The trolley did not stop.',

    verdictPush: {
      title: 'YOU KILLED ONE MAN.',
      line: 'You felt him go. The trolley stopped on his body.'
    },
    verdictNoPush: {
      title: 'FIVE MEN ARE DEAD.',
      line: 'You never touched him. He is still breathing beside you.'
    },

    hud: {
      below: 'BELOW  ' + MIDDOT + '  5',
      beside: 'BESIDE YOU  ' + MIDDOT + '  1',
      noSide: 'NO SIDE TRACK',
      distance: 'INCOMING'
    }
  };

  /* ------------------------------------------------------------------
     IMPACT FRAMING  (the black cards either side of the collision)
     The blanks are deliberate: nothing is on screen at the moment of
     impact, and the silence card stays empty for the full 0.9 s.
     ------------------------------------------------------------------ */
  S.impact = {
    braceA: '',
    braceB: '',
    silenceCard: '',
    afterA: 'The trolley stopped four hundred feet later.',
    afterB: 'The trolley stopped.',
    contentWarning: 'This scene shows a collision. No blood, no gore. Look away if you need to.',
    skipHint: 'Press S to skip the collision.',
    skipLabel: 'SKIP'
  };

  /* ------------------------------------------------------------------
     SUBMIT
     ------------------------------------------------------------------ */
  S.submit = {
    waiting: 'SENDING YOUR TWO ANSWERS' + ELL,
    sent: 'RECORDED.',
    sentSub: 'Wait for the front of the room.',
    offline: 'No connection. Your answers stay on this screen.',
    offlineSub: 'The teacher can count hands instead.',
    failed: 'That did not send.',
    retry: 'TRY AGAIN',
    skip: 'CONTINUE WITHOUT SENDING',
    codeIntro: 'CLASS CODE',
    codeHint: 'Same code on every screen.',
    yourAnswersLabel: 'YOU ANSWERED'
  };

  /* ------------------------------------------------------------------
     REVEAL  -  the class tally against the passage.
     Long verbatim quotes are pre-split into projector-safe lines.
     .lines always rejoins with a single space to exactly .text.
     ------------------------------------------------------------------ */
  S.reveal = {
    title: 'THE ROOM',
    sub: 'Every answer in this room, side by side.',

    quoteA: {
      text: 'Most people would say, "Turn! Tragic though it is to kill one innocent person, ' +
            'it\'s even worse to kill five."',
      lines: [
        'Most people would say, "Turn! Tragic though it is',
        'to kill one innocent person, it\'s even worse to kill five."'
      ],
      short: 'Most people would say, "Turn!"',
      cite: 'Michael Sandel, Justice'
    },

    quoteB: {
      text: 'Most people would say, "Of course not. It would be terribly wrong to push the man ' +
            'onto the track."',
      lines: [
        'Most people would say, "Of course not.',
        'It would be terribly wrong to push the man onto the track."'
      ],
      short: 'Most people would say, "Of course not."',
      cite: 'Michael Sandel, Justice'
    },

    labels: {
      caseA: 'CASE 1 ' + MIDDOT + ' THE DRIVER',
      caseB: 'CASE 2 ' + MIDDOT + ' THE BRIDGE',
      stay: 'STAYED ON COURSE',
      turn: 'THREW THE SWITCH',
      push: 'PUSHED HIM',
      nopush: 'DID NOT PUSH',
      you: 'YOU',
      classLabel: 'THIS ROOM',
      passage: 'THE PASSAGE',
      votes: 'answers',
      total: 'total',
      percent: '%',
      waiting: 'WAITING FOR THE ROOM' + ELL,
      noData: 'No answers yet.',
      noAnswer: 'NO ANSWER'
    },

    compare: 'Sandel says most people turn. Sandel says most people will not push.',
    prompt: 'Same five lives. Same one life. Two different answers.'
  };

  /* ------------------------------------------------------------------
     CONFRONT  -  the student's own two choices, named, not judged
     ------------------------------------------------------------------ */
  S.confront = {
    title: 'YOU',
    sub: 'This is what you did.',
    yourAnswerA: 'CASE 1',
    yourAnswerB: 'CASE 2',

    combos: {
      turn_nopush: {
        statement: [
          'You turned the trolley onto one man to save five.',
          'You would not push one man to save five.'
        ],
        tension: 'Same arithmetic, opposite answer. The only thing that changed was your hands.',
        consistent: false
      },
      stay_nopush: {
        statement: [
          'You let the trolley take five men.',
          'Then you let it take five more.'
        ],
        tension: 'You held one rule twice. Ten men are dead. Ask what the rule is, and what it cost.',
        consistent: true
      },
      turn_push: {
        statement: [
          'You turned the trolley onto one man to save five.',
          'You pushed one man off a bridge to save five.'
        ],
        tension: 'You were consistent. Most people are not. Sandel wants to know why they are not.',
        consistent: true
      },
      stay_push: {
        statement: [
          'You would not throw the switch to save five.',
          'Then you put your hands on a man and pushed.'
        ],
        tension: 'You refused the lever and used your hands. Something changed between the two.',
        consistent: false
      }
    },

    /* Reachable: fires when a choice is genuinely missing, e.g. a teacher
       jumped straight to CONFRONT. A timed-out choice is NOT missing. */
    fallback: {
      statement: [
        'You made two choices about the same five lives.',
        'They were not the same choice.'
      ],
      tension: 'That gap is the whole problem. It is not a mistake. It is the thing to explain.',
      consistent: false
    },

    closingQuestion: {
      text: 'But this raises a moral puzzle: Why does the principle that seems right in the ' +
            'first case ' + MDASH + ' sacrifice one life to save five ' + MDASH +
            ' seem wrong in the second?',
      lines: [
        'But this raises a moral puzzle: Why does the principle',
        'that seems right in the first case ' + MDASH + ' sacrifice one life',
        'to save five ' + MDASH + ' seem wrong in the second?'
      ],
      cite: 'Michael Sandel, Justice'
    },

    afterword: 'Do not answer yet. Open the passage.'
  };

  /* ------------------------------------------------------------------
     TEACHER PANEL
     ------------------------------------------------------------------ */
  S.teacher = {
    title: 'TEACHER CONTROLS',
    help: 'Press T to hide. Arrow keys step the lesson. Nothing here is shown to students.',
    liveBadge: 'LIVE ' + MIDDOT + ' CLASS TALLY ON',
    manualBadge: 'MANUAL ' + MIDDOT + ' NO NETWORK',
    pausedBadge: 'PAUSED',
    runtimeLabel: 'RUNTIME',
    steppers: {
      back: TRIL + ' BACK',
      next: 'NEXT ' + TRIR,
      pause: 'PAUSE',
      resume: 'RESUME',
      toBoot: 'BOOT',
      toCold: 'COLD OPEN',
      toSceneA: 'CASE 1 ' + MIDDOT + ' DRIVER',
      toSceneB: 'CASE 2 ' + MIDDOT + ' BRIDGE',
      toReveal: 'CLASS RESULTS',
      toConfront: 'CONFRONT',
      replayImpactA: 'REPLAY IMPACT 1',
      replayImpactB: 'REPLAY IMPACT 2',
      skipImpact: 'SKIP THE IMPACT'
    },
    reset: 'RESET THE LESSON',
    resetConfirm: 'Press again to wipe all answers.',
    advance: 'HOLD THE ROOM ' + MIDDOT + ' ADVANCE WHEN READY',
    fullscreen: 'FULLSCREEN (F)',
    fullscreenFallback: 'PRESS F11 FOR FULLSCREEN',
    tips: [
      'Do not explain the dilemma first. Let them choose blind.',
      'Say nothing during the eight seconds. The silence is the lesson.',
      'After Case 1, do not ask why. Go straight to Case 2.',
      'Hold the CONFRONT screen. Let it be uncomfortable for ten seconds.',
      'The closing question is not rhetorical. Do not answer it for them.',
      'Then open the handout and read the passage aloud.'
    ]
  };

  /* ------------------------------------------------------------------
     ERRORS  -  must be readable from the back of a lit room
     ------------------------------------------------------------------ */
  S.errors = {
    webgl: {
      title: '3D IS NOT AVAILABLE ON THIS SCREEN',
      line: 'The lesson still works. You will read it instead of seeing it.',
      action: 'CONTINUE IN TEXT'
    },
    audio: {
      title: 'NO SOUND',
      line: 'Sound is blocked on this machine. Everything else still works.',
      action: 'CONTINUE'
    },
    generic: {
      title: 'SOMETHING BROKE',
      line: 'Reload the page. Your answers are not lost until you close the tab.',
      action: 'RELOAD'
    },
    contextLost: {
      title: 'RECONNECTING' + ELL,
      line: 'The graphics card dropped out. Hold on.',
      action: 'RELOAD'
    },
    duplicateTab: {
      title: 'ALREADY OPEN IN ANOTHER TAB',
      line: 'Use one tab, or the sound will play twice.',
      action: 'USE THIS TAB'
    }
  };

  /* ------------------------------------------------------------------
     ACCESSIBILITY  -  live-region announcements. {n} etc are substituted.
     ------------------------------------------------------------------ */
  S.a11y = {
    screen: {
      boot: 'Start screen. Choose student or projector.',
      cold: 'Black screen. You are the driver of a trolley car.',
      sceneA: 'Case one. You are driving. Five workers on the track ahead.',
      brakeFail: 'The brakes have failed. A side track is on the right with one worker.',
      impactA: 'Collision.',
      verdictA: 'Case one result.',
      sceneB: 'Case two. You are on a bridge. Five workers below. A heavy man beside you.',
      impactB: 'Collision.',
      verdictB: 'Case two result.',
      submit: 'Sending your answers.',
      reveal: 'Class results.',
      confront: 'Your two choices.'
    },
    countdownStart: 'Eight seconds to choose.',
    countdownTick: '{n} seconds remaining.',
    /* Announce only at these marks. Every second is unusable noise. */
    countdownTickAt: [5, 3, 1],
    countdownEnd: 'Time is up.',
    choiceMade: 'You chose {choice}.',
    verdict: '{title} {line}',
    pushProgress: 'Push {n} percent.',
    pushReleased: 'You let go. Nothing happened.',
    gestureHint: 'Press and drag forward, or hold the space bar for one second.',
    chartSummary: '{label}: {n} of {total} answers, {pct} percent.',
    skipHint: 'Press S to skip the collision.'
  };

  /* ------------------------------------------------------------------
     SHARED UI CHROME
     ------------------------------------------------------------------ */
  S.ui = {
    continueBtn: 'CONTINUE',
    skipBtn: 'SKIP',
    againBtn: 'PLAY AGAIN',
    mute: 'SOUND OFF',
    unmute: 'SOUND ON',
    or: 'OR',
    countdownLabel: 'DECIDE',
    seconds: 's',
    keyHintPointer: 'Click, tap, or press the key.',
    keyHintDrag: 'Drag. A tap is not enough.',
    silenceIsAChoice: 'Doing nothing is also a choice.'
  };

  /* ------------------------------------------------------------------
     TIMING  -  milliseconds. The director owns the clock; these are the
     intended durations. Teacher stepping can cut any of them short.
     The estimate fields at the bottom are COMPUTED, never typed, so they
     can never drift away from the table again.
     ------------------------------------------------------------------ */
  S.timing = {
    /* boot (teacher-paced, not auto-advanced) */
    bootMinMs: 1200,
    bootTypicalMs: 22000,
    bootHoldMs: 20000,

    /* cold open. 10.2 s: three lines clearing at 8.35 s, then the slate.
       This is the ONLY black-with-type stretch before the first picture and
       it used to run 13.6 s -- longer than the whole brake beat. */
    coldMs: 10200,
    coldFadeInMs: 900,
    coldFadeOutMs: 1200,

    /* SCENE A, beat by beat (auto path, class touching nothing):
         cold      10.2   black, three lines, slate
         approach  13.8   the five close from 140 m to 30 m, five lines
         brake      6.0   sceneABrakePromptMs to pull + 1.5 s to the failure
         side       4.4   sceneAFailHoldMs + sceneASideTrackRevealMs + 1.3
         choice     8.0   sceneAChoiceMs
       = 42.4 s to the impact, against 50.4 s before. Every second that came
       off came off the title card and the button-holding; the countdown and
       the side-track reveal, where the tension actually lives, got longer. */
    sceneASlateMs: 1200,
    sceneAApproachMs: 13800,      /* lines end at 13.0 s, clear at 13.71 s */
    sceneABrakePromptMs: 4500,    /* the window to pull before the film pulls */
    sceneABrakeMs: 4200,          /* screech length before it sags to nothing */
    sceneAFailHoldMs: 1300,       /* brakeFail holds the screen this long */
    sceneASideTrackRevealMs: 1800,/* 49 chars need 1.29 s to type, then dwell */
    sceneAChoiceMs: 8000,
    sceneANoChoiceHoldMs: 2200,

    /* impact A */
    impactAMs: 4200,
    impactSlowMoMs: 350,
    impactSlowMoScale: 0.25,
    /* The dead-air beat after the collision. 900 ms read as a glitch rather
       than as a held breath; film cuts of this kind sit at 1.5-2.5 s. 2000 ms
       lets the room register that the sound is GONE. impactAfterHold grows
       with it so the silence finishes inside the beat instead of being cut
       off by the verdict card. */
    /* THE DEAD AIR.
       The sound cut is what sells a collision, but it only works if the room
       is still LOOKING at the thing that went quiet. The old cut to black at
       620 ms meant the silence, the settling bodies and the hanging dust all
       played behind a black screen, so 2 s of it read as "it just moved on".
       Now: the sound dies at 350 ms while the wreck is still on screen, the
       picture holds for 1.7 s of that silence, and only then does it fade. */
    impactSilenceAtMs: 350,     /* when the mix is cut, after the crash itself */
    silenceMs: 2600,            /* 350 -> 2950, restored by ~3350 */
    impactHoldVisibleMs: 1700,  /* picture stays up this long: watch it happen */
    impactFadeMs: 550,          /* then a slow fade, not a cut */
    impactAfterHoldMs: 3900,    /* verdict lands after the black has held */

    /* verdicts */
    verdictInMs: 700,
    verdictHoldMs: 7000,
    verdictOutMs: 900,

    /* between the two cases */
    interSceneMs: 3000,

    /* scene B */
    sceneBIntroMs: 9600,            /* intro lines end at 9.2 s */
    sceneBSlateMs: 1600,
    sceneBApproachMs: 28000,        /* lines end at 26.8 s */
    sceneBHesitateAfterMs: 1800,    /* stillness before hesitate lines start */
    sceneBHesitateSpanMs: 6200,     /* hesitate lines end at 6.2 s */
    sceneBEyeContactMs: 7800,       /* after hesitation begins; clears 7.4 */
    sceneBEyeContactHoldMs: 3400,
    sceneBChoiceMs: 8000,
    sceneBNoChoiceHoldMs: 2200,
    pushHoldKeyboardMs: 900,
    pushSpringBackMs: 260,

    /* impact B */
    impactBMs: 4200,

    /* submit */
    submitMs: 4000,
    submitTimeoutMs: 6000,

    /* reveal */
    revealInMs: 1200,
    revealBarGrowMs: 1600,
    revealStaggerMs: 260,
    revealQuoteInMs: 900,
    revealHoldMs: 46000,

    /* confront */
    confrontInMs: 1200,
    confrontLine1Ms: 2800,
    confrontLine2Ms: 2800,
    confrontTensionMs: 8000,
    closingQuestionInMs: 1400,
    closingQuestionMs: 20000,
    afterwordMs: 12000,

    /* generic */
    lineFadeMs: 500,
    countdownWarnMs: 3000,
    countdownTickMs: 1000,

    /* budgets that are NOT beats: student fumbling, teacher talking */
    interactionBudgetMs: 55000,
    teacherHoldBudgetMs: 95000,

    /* computed at the bottom of this IIFE - do not hand-edit */
    autoEstimateMs: 0,
    totalEstimateMs: 0
  };

  /* The automated beats, in order, that make up autoEstimateMs.
     Boot is excluded: it is teacher-paced and lives in the hold budget. */
  S.timing.autoBeats = [
    'coldMs',
    'sceneASlateMs', 'sceneAApproachMs', 'sceneABrakePromptMs', 'sceneABrakeMs',
    'sceneAFailHoldMs', 'sceneASideTrackRevealMs', 'sceneAChoiceMs',
    /* silenceMs is NOT summed: the dead air happens INSIDE the impact hold,
       so counting both put ~2.6 s of phantom runtime on the teacher's clock
       for each collision. impactAfterHoldMs is the beat's real length. */
    'impactAMs', 'impactAfterHoldMs',
    'verdictInMs', 'verdictHoldMs', 'verdictOutMs',
    'interSceneMs', 'sceneBIntroMs',
    'sceneBSlateMs', 'sceneBApproachMs', 'sceneBEyeContactHoldMs', 'sceneBChoiceMs',
    'impactBMs', 'impactAfterHoldMs',
    'verdictInMs', 'verdictHoldMs', 'verdictOutMs',
    'submitMs',
    'revealInMs', 'revealQuoteInMs', 'revealBarGrowMs', 'revealHoldMs',
    'confrontInMs', 'confrontLine1Ms', 'confrontLine2Ms', 'confrontTensionMs',
    'closingQuestionInMs', 'closingQuestionMs', 'afterwordMs'
  ];

  /* ------------------------------------------------------------------
     HELPERS  -  pure, defensive, never throw.
     ------------------------------------------------------------------ */
  var CHOICE_A = { stay: 1, turn: 1 };
  var CHOICE_B = { push: 1, nopush: 1 };
  var MAX_LINE = 90;
  var DEFAULT_HOLD = 2.5;
  var choiceMap = null;   /* lazily built id -> descriptor */

  function safeStr(v) { return (typeof v === 'string') ? v : ''; }
  function isNum(v) { return (typeof v === 'number') && isFinite(v); }

  /* normalize a raw key name from a KeyboardEvent to our vocabulary */
  function normKey(k) {
    var s = safeStr(k).toLowerCase();
    if (s === ' ' || s === 'spacebar' || s === 'space') return 'space';
    if (s === 'esc') return 'escape';
    return s;
  }

  function buildChoiceMap() {
    var m = {}, i, arrs = [S.sceneA.choices, S.sceneB.choices], a, j;
    for (i = 0; i < arrs.length; i++) {
      a = arrs[i];
      if (!a) continue;
      for (j = 0; j < a.length; j++) { if (a[j] && a[j].id) m[a[j].id] = a[j]; }
    }
    return m;
  }

  S.util = {

    MAX_LINE: MAX_LINE,

    /* --- answer identity ------------------------------------------ */

    /* is this a real, recorded scene answer id? */
    isA: function (id) { return !!(id && CHOICE_A[id] === 1); },
    isB: function (id) { return !!(id && CHOICE_B[id] === 1); },

    /* normalize a scene-A answer id; anything unknown becomes 'stay'.
       Silence is a choice, and the default is to stay on course. The
       director should still RECORD a timeout explicitly as 'stay' so
       CONFRONT can tell a timeout apart from a missing answer. */
    normA: function (id) { return S.util.isA(id) ? id : 'stay'; },
    normB: function (id) { return S.util.isB(id) ? id : 'nopush'; },

    /* 'turn' + 'nopush' -> 'turn_nopush' */
    comboKey: function (a, b) { return S.util.normA(a) + '_' + S.util.normB(b); },

    /* the confront block for a pair of answers; never returns null.
       Falls back only when an answer is genuinely absent or unknown. */
    confrontFor: function (a, b) {
      if (!S.util.isA(a) || !S.util.isB(b)) return S.confront.fallback;
      var c = S.confront.combos[S.util.comboKey(a, b)];
      return c ? c : S.confront.fallback;
    },

    /* did the student answer both cases with a recognized id? */
    answeredBoth: function (a, b) { return S.util.isA(a) && S.util.isB(b); },

    /* true when the two answers apply the same rule to both cases */
    isConsistent: function (a, b) {
      var c = S.util.confrontFor(a, b);
      return !!(c && c.consistent);
    },

    /* --- verdicts and labels -------------------------------------- */

    verdictA: function (id) {
      return (S.util.normA(id) === 'turn') ? S.sceneA.verdictTurn : S.sceneA.verdictStay;
    },
    verdictB: function (id) {
      return (S.util.normB(id) === 'push') ? S.sceneB.verdictPush : S.sceneB.verdictNoPush;
    },

    /* human label for an answer id, for charts and the confront header */
    labelFor: function (id) {
      var L = S.reveal.labels;
      if (id === 'stay') return L.stay;
      if (id === 'turn') return L.turn;
      if (id === 'push') return L.push;
      if (id === 'nopush') return L.nopush;
      return L.noAnswer;
    },

    /* 'CASE 1: THREW THE SWITCH  .  CASE 2: DID NOT PUSH' */
    answerSummary: function (a, b) {
      return S.confront.yourAnswerA + ': ' + S.util.labelFor(S.util.isA(a) ? a : null) +
             '  ' + MIDDOT + '  ' +
             S.confront.yourAnswerB + ': ' + S.util.labelFor(S.util.isB(b) ? b : null);
    },

    /* choice descriptor object by id, from either scene; null if unknown */
    choiceById: function (id) {
      if (!choiceMap) { try { choiceMap = buildChoiceMap(); } catch (e) { choiceMap = {}; } }
      return (id && choiceMap[id]) ? choiceMap[id] : null;
    },

    /* does a KeyboardEvent key select this choice? handles ' ' vs 'space' */
    matchKey: function (id, key) {
      var c = S.util.choiceById(id), k = normKey(key), i;
      if (!c || !c.keys || !k) return false;
      for (i = 0; i < c.keys.length; i++) { if (normKey(c.keys[i]) === k) return true; }
      return false;
    },

    /* the choice id a key selects within one scene, or null */
    choiceForKey: function (sceneChoices, key) {
      var i, j, k = normKey(key), c;
      if (!sceneChoices || !k) return null;
      for (i = 0; i < sceneChoices.length; i++) {
        c = sceneChoices[i];
        if (!c || !c.keys) continue;
        for (j = 0; j < c.keys.length; j++) { if (normKey(c.keys[j]) === k) return c.id; }
      }
      return null;
    },

    /* --- strings --------------------------------------------------- */

    /* '{n} seconds remaining.' + {n:5} -> '5 seconds remaining.' */
    fmt: function (tpl, vals) {
      var s = safeStr(tpl);
      if (!vals || !s) return s;
      try {
        return s.replace(/\{(\w+)\}/g, function (m, k) {
          var v = vals[k];
          return (v === undefined || v === null) ? '' : String(v);
        });
      } catch (e) { return s; }
    },

    /* does this string fit one projector line? */
    fits: function (s) { return safeStr(s).length <= MAX_LINE; },

    /* '4:13' from milliseconds, for the teacher panel */
    fmtClock: function (ms) {
      var t = isNum(ms) ? Math.max(0, Math.round(ms / 1000)) : 0;
      var m = Math.floor(t / 60), s = t % 60;
      return m + ':' + (s < 10 ? '0' : '') + s;
    },

    /* --- timed line lists ------------------------------------------ */

    /* THE per-frame call: the single line visible at tSec, or null.
       Picks the latest-STARTING line still inside its hold, so it is
       correct even if the list is not sorted by t. Zero allocation. */
    lineAt: function (arr, tSec) {
      var best = null, i, L, end;
      if (!arr || !arr.length || !isNum(tSec)) return null;
      for (i = 0; i < arr.length; i++) {
        L = arr[i];
        if (!L || !isNum(L.t)) continue;
        end = L.t + (isNum(L.hold) ? L.hold : DEFAULT_HOLD);
        if (tSec >= L.t && tSec < end) {
          if (!best || L.t > best.t) best = L;
        }
      }
      return best;
    },

    /* every line visible at tSec. Pass `out` to reuse an array and keep
       this allocation-free if it must be called per frame. */
    linesAt: function (arr, tSec, out) {
      var res = out || [], i, L, end;
      res.length = 0;
      if (!arr || !arr.length || !isNum(tSec)) return res;
      for (i = 0; i < arr.length; i++) {
        L = arr[i];
        if (!L || !isNum(L.t)) continue;
        end = L.t + (isNum(L.hold) ? L.hold : DEFAULT_HOLD);
        if (tSec >= L.t && tSec < end) res.push(L);
      }
      return res;
    },

    /* seconds at which the last line of a list finishes */
    lastEnd: function (arr) {
      var e = 0, i, L, end;
      if (!arr || !arr.length) return 0;
      for (i = 0; i < arr.length; i++) {
        L = arr[i];
        if (!L || !isNum(L.t)) continue;
        end = L.t + (isNum(L.hold) ? L.hold : DEFAULT_HOLD);
        if (end > e) e = end;
      }
      return e;
    },

    /* --- tallies ---------------------------------------------------- */

    /* integer percentage, safe against zero and garbage totals */
    pct: function (n, total) {
      n = isNum(n) ? n : 0;
      total = isNum(total) ? total : 0;
      if (total <= 0) return 0;
      return Math.round((n / total) * 100);
    },
    pctStr: function (n, total) { return S.util.pct(n, total) + S.reveal.labels.percent; },

    /* one-line spoken summary of a bar, for the live region */
    chartLine: function (label, n, total) {
      return S.util.fmt(S.a11y.chartSummary, {
        label: safeStr(label), n: isNum(n) ? n : 0,
        total: isNum(total) ? total : 0, pct: S.util.pct(n, total)
      });
    },

    /* --- runtime ----------------------------------------------------- */

    /* sum of the automated beats only. Teacher pauses excluded. */
    totalRuntimeMs: function () {
      var t = S.timing, keys = t.autoBeats, sum = 0, i, v;
      if (!keys) return 0;
      for (i = 0; i < keys.length; i++) { v = t[keys[i]]; if (isNum(v)) sum += v; }
      return sum;
    },

    /* honest wall-clock estimate for one class: the automated beats plus
       the boot screen, student fumbling and the holds a teacher takes. */
    classRuntimeMs: function () {
      var t = S.timing;
      return S.util.totalRuntimeMs() +
             (isNum(t.bootTypicalMs) ? t.bootTypicalMs : 0) +
             (isNum(t.interactionBudgetMs) ? t.interactionBudgetMs : 0) +
             (isNum(t.teacherHoldBudgetMs) ? t.teacherHoldBudgetMs : 0);
    },

    /* --- self check (dev / boot guard; never throws, never required) - */

    /* Returns an array of human-readable problems. Empty means clean.
       Cheap enough to call once at boot behind the black screen. */
    selfTest: function () {
      var out = [], seen = 0, MAXNODES = 4000;

      function walk(node, parent, path, depth) {
        if (seen++ > MAXNODES || depth > 8 || node === null || node === undefined) return;
        var i, k, exempt;
        if (typeof node === 'string') {
          /* long-form verbatim quotes are exempt: they carry a .lines
             array that IS the projector-safe wrapping */
          exempt = (path.length > 5 && path.slice(-5) === '.text' &&
                    parent && parent.lines && parent.lines.length);
          if (!exempt && node.length > MAX_LINE) {
            out.push('LONG(' + node.length + ') ' + path);
          }
          return;
        }
        if (Object.prototype.toString.call(node) === '[object Array]') {
          for (i = 0; i < node.length; i++) walk(node[i], node, path + '[' + i + ']', depth + 1);
          return;
        }
        if (typeof node === 'object') {
          for (k in node) {
            if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
            if (k === 'util' || k === 'autoBeats') continue;
            walk(node[k], node, path + '.' + k, depth + 1);
          }
        }
      }

      try { walk(S, null, 'SCRIPT', 0); } catch (e) { out.push('walk failed'); }

      /* verbatim quote integrity: .lines must rejoin to .text exactly */
      try {
        var qs = [
          ['reveal.quoteA', S.reveal.quoteA],
          ['reveal.quoteB', S.reveal.quoteB],
          ['confront.closingQuestion', S.confront.closingQuestion]
        ], qi, q;
        for (qi = 0; qi < qs.length; qi++) {
          q = qs[qi][1];
          if (!q || !q.lines || q.lines.join(' ') !== q.text) {
            out.push('QUOTE MISMATCH ' + qs[qi][0]);
          }
        }
      } catch (e2) { out.push('quote check failed'); }

      /* every combo key must exist */
      try {
        var ids = ['stay', 'turn'], jds = ['nopush', 'push'], a, b;
        for (a = 0; a < 2; a++) {
          for (b = 0; b < 2; b++) {
            if (!S.confront.combos[ids[a] + '_' + jds[b]]) {
              out.push('MISSING COMBO ' + ids[a] + '_' + jds[b]);
            }
          }
        }
      } catch (e3) { out.push('combo check failed'); }

      /* no narration may outlast the window it plays inside */
      try {
        if (S.util.lastEnd(S.sceneA.lines) * 1000 > S.timing.sceneAApproachMs) {
          out.push('sceneA.lines overrun sceneAApproachMs');
        }
        if (S.util.lastEnd(S.sceneB.lines) * 1000 > S.timing.sceneBApproachMs) {
          out.push('sceneB.lines overrun sceneBApproachMs');
        }
        if (S.util.lastEnd(S.sceneB.hesitateLines) * 1000 > S.timing.sceneBEyeContactMs) {
          out.push('hesitateLines collide with eye contact');
        }
        if (S.util.lastEnd(S.cold) * 1000 > S.timing.coldMs) {
          out.push('cold lines overrun coldMs');
        }
      } catch (e4) { out.push('timing check failed'); }

      return out;
    }
  };

  /* Derive the estimates from the table so they can never disagree. */
  try {
    S.timing.autoEstimateMs = S.util.totalRuntimeMs();
    S.timing.totalEstimateMs = S.util.classRuntimeMs();
  } catch (e) {
    S.timing.autoEstimateMs = 0;
    S.timing.totalEstimateMs = 0;
  }

  return S;
})();