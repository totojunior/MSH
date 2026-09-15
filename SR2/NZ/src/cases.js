/* =====================================================================
   MODULE: cases  -  사건 10개. 수업 내용의 단일 출처.
   DECLARES EXACTLY ONE GLOBAL SLOT: window.NZ.CASES

   수업 내용(제목·상황·선택지·정답·이유·오답 대사·영어 개념)을 고치려면
   이 파일만 고치면 된다. 화면 로직은 이 데이터를 읽기만 한다.
   DOM 없음, THREE 없음, 타이머 없음. 순수 데이터.

   ---------------------------------------------------------------------
   고칠 때 반드시 지킬 것
   ---------------------------------------------------------------------
   1) id 와 options[].id 는 고정이다. 저장된 진행 기록(localStorage)과
      채점이 전부 이 문자열에 묶여 있다. 문구는 고쳐도 ID 는 바꾸지 마라.
   2) 채점은 오직 answerId 로 한다. 렌더러가 선택지 순서를 섞어도
      정답이 따라 움직인다. 'a' / 'b' 같은 위치 의존 ID 를 만들지 마라.
   3) options 는 정확히 2개. answerId 는 반드시 그 둘 중 하나여야 한다.
   4) situation 은 한 문장 = 배열 한 원소. 2~3문장.
      20~25초 안에 읽고 고를 분량이되, 판정을 좌우하는 사실을 빼지 마라.
      (예: 사건 06 의 "속임수나 강요는 없었다" 를 지우면 사건이 무너진다.)
   5) 하이라이트: 판정을 좌우하는 조건만 [[...]] 로 감싼다. 렌더러가
      <mark> 로 바꾼다. 한 사건당 2~3개. 짝이 맞아야 하고 중첩 금지.
      선택지 텍스트에는 쓰지 않는다 — 강조된 쪽을 고르게 만드는 편향이 생긴다.
   6) 정답 = '지문 속 노직의 판단과 일치'라는 뜻이다. 도덕적 정답이 아니다.
      대사는 전부 교육용 창작이다. 노직의 실제 발언·직접 인용이 아니며,
      실제 법률상 합법/불법 판정도 아니다.

   철학적 근거는 docs/01-지문3-원문.md 에 한정한다.
   두 질문이 열 사건을 관통한다:
     Was it rightfully theirs?  (justice in initial holdings)
     Was the transfer voluntary? (justice in transfer)
   ===================================================================== */

(function () {
  'use strict';

  window.NZ = window.NZ || {};

  /**
   * @typedef {Object} NZOption
   * @property {string} id    고유 ID. 채점의 기준. 절대 바꾸지 않는다.
   * @property {string} text  한 호흡에 읽는 한국어 선택지 (35자 내외, 최대 45자).
   */

  /**
   * @typedef {Object} NZCase
   * @property {string}         id         고정 ID ('c01'~'c10'). 저장 기록의 키.
   * @property {number}         n          화면 표기용 번호 (1~10).
   * @property {string}         file       사건 파일 라벨 ('FILE 01').
   * @property {string}         title      목록에 뜨는 제목. 읽으면 궁금해야 한다.
   * @property {string[]}       situation  한국어 2~3문장. 한 문장 = 한 원소. [[...]] 강조 2~3개.
   * @property {?string}        hook       훅 대사 1개 이하. 없으면 null.
   * @property {string}         question   짧은 영어 발문. 10개 사건 공통, B1 수준.
   *                                       (요구사항 §1: 영어는 짧은 질문과 핵심 개념에만.)
   * @property {NZOption[]}     options    정확히 2개.
   * @property {string}         answerId   노직의 예상 답. options 중 하나의 id.
   * @property {string}         reason     한 줄 이유.
   * @property {string}         wrongLine  이 사건 전용 오답 대사. 반박 대상은 판단 근거다.
   * @property {string}         concept    짧은 영어 핵심 개념 (지문 용어).
   * @property {string}         conceptKo  개념의 짧은 한국어 병기.
   */

  /** @type {NZCase[]} */
  var CASES = [
    {
      id: 'c01',
      n: 1,
      file: 'FILE 01',
      title: '평생 게임만 했는데 상속 100억',
      situation: [
        '25세 준호는 일해 본 적도 없이 하루 종일 게임만 한다.',
        '아버지가 [[정당하게 사업해서 번]] 100억을 준호에게 [[자발적으로]] 물려줬다.'
      ],
      hook: '노력? 그걸 왜 해? 아빠가 했잖아.',
      question: 'What would Nozick say?',
      options: [
        { id: 'c01-effort', text: '자기 노력으로 번 돈이 아니라면 가질 권리가 없다.' },
        { id: 'c01-gift',   text: '정당한 재산을 자발적으로 받았다면 가질 권리가 있다.' }
      ],
      answerId: 'c01-gift',
      reason: '수령자의 노력보다 재산의 출처와 자발적인 이전이 핵심이다.',
      wrongLine: '얄미운 건 알겠는데, 얄밉다고 소유권이 없어지진 않거든?',
      concept: 'Voluntary transfer.',
      conceptKo: '자발적 이전'
    },

    {
      id: 'c02',
      n: 2,
      file: 'FILE 02',
      title: '부자 돈 훔쳐서 장학금 10억',
      situation: [
        '해커가 어느 부자가 [[정당하게 모은]] 돈 10억을 [[훔쳤다]].',
        '그리고 전액을 형편이 어려운 학생들의 등록금으로 나눠줬다.'
      ],
      hook: '베댓: 이 사람이 진짜 영웅이지!',
      question: 'What would Nozick say?',
      options: [
        { id: 'c02-stolen',  text: '좋은 일에 썼어도 훔친 돈을 나눠준 것은 정당하지 않다.' },
        { id: 'c02-outcome', text: '훔친 돈이어도 많은 학생을 도왔다면 정당하다.' }
      ],
      answerId: 'c02-stolen',
      reason: '좋은 결과가 처음의 부당한 취득을 정당하게 만들지는 않는다.',
      wrongLine: '기부 버튼 누르면 도둑질 기록이 삭제되는 줄 알아?',
      concept: 'Was it rightfully theirs?',
      conceptKo: '정당한 소유'
    },

    {
      id: 'c03',
      n: 3,
      file: 'FILE 03',
      title: '춤 10초에 3억',
      situation: [
        '스트리머가 [[약속한 춤 10초]]를 추고 3억을 벌었다.',
        '[[성인 팬들이 내용을 알고 자발적으로]] 낸 돈이었다.',
        '다른 사람은 한 달 내내 일해서 250만 원을 벌었다.'
      ],
      hook: '춤 10초가 내 한 달 월급의 120배라고?',
      question: 'What would Nozick say?',
      options: [
        { id: 'c03-free', text: '자유롭게 돈을 냈다면 수입 차이만으로 부당하지는 않다.' },
        { id: 'c03-gap',  text: '자유롭게 낸 돈이어도 노력에 비해 너무 많으면 부당하다.' }
      ],
      answerId: 'c03-free',
      reason: '불평등의 크기가 아니라 돈이 이동한 과정이 판단 기준이다.',
      wrongLine: '‘땀 흘린 시간만큼 지급’이라는 조항은 없거든?',
      concept: 'How did they get the money?',
      conceptKo: '이전 과정'
    },

    {
      id: 'c04',
      n: 4,
      file: 'FILE 04',
      title: '짝퉁 300만 원, 결제는 네가 눌렀잖아?',
      situation: [
        '판매자가 짝퉁 운동화를 [[정품이라고 속여]] 300만 원에 팔았다.',
        '구매자는 [[진짜인 줄 알고]] 직접 결제했다.'
      ],
      hook: '내가 협박했어? 네가 결제했잖아!',
      question: 'What would Nozick say?',
      options: [
        { id: 'c04-hands-off', text: '직접 결제했으므로 국가는 개입하면 안 된다.' },
        { id: 'c04-fraud',     text: '사기이므로 사람들을 보호하는 국가 개입은 정당하다.' }
      ],
      answerId: 'c04-fraud',
      reason: '최소 국가도 사기로부터 사람들을 보호한다.',
      wrongLine: '‘정품’이라고 속인 부분은 왜 건너뛰는데?',
      concept: 'Protect people against fraud.',
      conceptKo: '사기 방지'
    },

    {
      id: 'c05',
      n: 5,
      file: 'FILE 05',
      title: '기부 0원, 슈퍼카 30억',
      situation: [
        '[[정당하게 돈을 번]] 부자가 장학금 기부는 거절하고 30억짜리 슈퍼카를 샀다.',
        '정부는 장학금 재분배를 위해 그의 재산에서 10억을 [[강제로]] 걷기로 했다.'
      ],
      hook: '기부는 싫고, 슈퍼카는 좋아!',
      question: 'What would Nozick say?',
      options: [
        { id: 'c05-selfish', text: '이기적인 부자라면 그 재산을 강제로 걷어도 정당하다.' },
        { id: 'c05-forced',  text: '이기적이라는 이유만으로 강제 재분배가 정당해지지 않는다.' }
      ],
      answerId: 'c05-forced',
      reason: '쟁점은 그의 인성이 아니라 돕도록 강제당하지 않을 권리다.',
      wrongLine: '인성 평가랑 재산권 판단은 다른 문제거든?',
      concept: 'Helping should not be forced.',
      conceptKo: '강제 금지'
    },

    {
      id: 'c06',
      n: 6,
      file: 'FILE 06',
      title: '월급 250만 원, 억만장자에게 300만 원 선물',
      situation: [
        '성인 팬이 [[자신이 정당하게 모은]] 300만 원을 부자 스트리머에게 줬다.',
        '상대가 부자인 줄 알았고, [[속임수나 강요는 없었다]].'
      ],
      hook: '내 돈으로 내 최애 챙기는데?',
      question: 'What would Nozick say?',
      options: [
        { id: 'c06-gift',    text: '현명한지는 별개로, 자발적인 선물은 인정한다.' },
        { id: 'c06-reverse', text: '가난한 쪽에서 부자 쪽으로 갔으니 강제로 취소해야 한다.' }
      ],
      answerId: 'c06-gift',
      reason: '받는 사람이 부자라는 이유만으로 자발적 증여가 부당해지지는 않는다.',
      wrongLine: '돈이 네가 원하는 방향으로 안 갔다고 취소할 수는 없거든?',
      concept: 'Gifts voluntarily given.',
      conceptKo: '자발적 선물'
    },

    {
      id: 'c07',
      n: 7,
      file: 'FILE 07',
      title: '상속 100억, 아빠가 도둑이었다',
      situation: [
        '준호는 아버지에게서 100억을 [[자발적으로]] 물려받았다.',
        '그런데 그 돈은 전부 아버지가 [[다른 사람들에게서 훔친]] 것이었다.',
        '준호는 그 사실을 몰랐다.'
      ],
      hook: '난 안 훔쳤는데? 그냥 받았는데?',
      question: 'What would Nozick say?',
      options: [
        { id: 'c07-voluntary', text: '자발적으로 물려줬으므로 준호의 정당한 재산이다.' },
        { id: 'c07-stolen',    text: '물려줬어도 원래 훔친 재산이라는 문제는 남는다.' }
      ],
      answerId: 'c07-stolen',
      reason: '이전이 자발적이어도, 넘겨준 사람이 정당한 소유자였는지 확인해야 한다.',
      wrongLine: '‘정당하게 가진 돈’이라는 조건은 어디 갔어?',
      concept: 'Justice in initial holdings.',
      conceptKo: '최초 취득'
    },

    {
      id: 'c08',
      n: 8,
      file: 'FILE 08',
      title: '찬성률 99%, 부자 한 명 재산 나눠 갖자',
      situation: [
        '한 마을 주민 100명이 투표를 했다.',
        '99명이 [[정당하게 재산을 모은]] 부자 한 명의 재산 절반을 나눠 갖자고 찬성했다.',
        '[[반대한 사람은 부자 본인뿐]]이었다.'
      ],
      hook: '99 대 1이면 따라야지?',
      question: 'What would Nozick say?',
      options: [
        { id: 'c08-consent',  text: '다수가 찬성해도 남의 정당한 재산을 가져갈 권리는 없다.' },
        { id: 'c08-majority', text: '압도적인 다수가 찬성했다면 가져가도 정당하다.' }
      ],
      answerId: 'c08-consent',
      reason: '다수의 찬성은 소유자의 자발적인 동의를 대신하지 않는다.',
      wrongLine: '표가 많다고 남의 지갑 주인이 되는 건 아니거든?',
      concept: 'Consent matters.',
      conceptKo: '동의'
    },

    {
      id: 'c09',
      n: 9,
      file: 'FILE 09',
      title: '원가 3천 원 티셔츠, 판매가 100만 원',
      situation: [
        '유명인이 [[정당하게 소유한]] 티셔츠에 사인해 100만 원에 내놨다.',
        '성인 구매자는 [[원가가 3천 원인 걸 알고]] 사인이 진짜인지 확인한 뒤 [[자발적으로]] 샀다.'
      ],
      hook: '원가 3천 원인데 100만 원?!',
      question: 'What would Nozick say?',
      options: [
        { id: 'c09-overpriced', text: '원가보다 너무 비싸다면 그것만으로 부당한 거래다.' },
        { id: 'c09-honest',     text: '속임수나 강요가 없었다면 비싸다는 이유만으로 부당하지 않다.' }
      ],
      answerId: 'c09-honest',
      reason: '비싼 거래와 속임수가 있는 거래를 구분한다.',
      wrongLine: '네가 안 살 가격과 남도 사면 안 되는 가격은 다르지!',
      concept: 'Free exchange.',
      conceptKo: '자유 교환'
    },

    {
      id: 'c10',
      n: 10,
      file: 'FILE 10',
      title: '한 명은 1억, 한 명은 0원, 그냥 반반',
      situation: [
        '성인인 두 친구 중 한 명만 [[정당하게 번]] 1억을 가지고 있다.',
        '그 친구가 먼저 절반을 주겠다고 했고, [[두 사람 모두 자발적으로 동의]]했다.'
      ],
      hook: '우리 그냥 5천만 원씩 갖자.',
      question: 'What would Nozick say?',
      options: [
        { id: 'c10-voluntary', text: '강요 없이 자발적으로 나눴다면 정당하다.' },
        { id: 'c10-antiequal', text: '똑같이 나누는 것이라면 노직이 반대하므로 부당하다.' }
      ],
      answerId: 'c10-voluntary',
      reason: '정당한 과정의 결과가 평등해지는 것은 문제 삼지 않는다.',
      wrongLine: '평등이 싫다는 말은 안 했거든? 강요가 문제라니까!',
      concept: 'Equality can be fair, too.',
      conceptKo: '평등도 정당'
    }
  ];

  window.NZ.CASES = CASES;
})();
