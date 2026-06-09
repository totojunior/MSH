/*
 * Stress Face Simulator — 지문 5 "The Dangers of Long-Term Stress" 독해 도입(hook)
 * three.js(r160) 3D 머리: 스트레스 수치(0~100)에 따라 표정과 증상이 실시간으로 나빠짐.
 *
 * ┌─ 교사가 고치기 쉬운 곳 ───────────────────────────────────────────┐
 * │  BANDS      : 5단계 레벨(이름·색·행동 한 줄·증상 목록). 증상은 지문 5 원문. │
 * │  SCENARIOS  : 시나리오 칩(한국 학생 상황 → 누르면 스트레스 누적).          │
 * │  BRIDGE     : '지문으로' 패널에 보여줄 핵심 키워드.                      │
 * └───────────────────────────────────────────────────────────────┘
 */
(function () {
  "use strict";

  var T = window.THREE;
  var lerp = T.MathUtils.lerp;
  var clamp = T.MathUtils.clamp;
  var deg = T.MathUtils.degToRad;
  var smooth = T.MathUtils.smoothstep;

  /* ===================== 데이터 (교사 편집 영역) ===================== */

  // 5단계 레벨. 증상(en)은 지문 5 본문 표현 그대로.
  var BANDS = [
    {
      name: "Calm", max: 20, color: "#51b9a6",
      behavior: "여유롭게 쉬고 회복할 수 있어요 😌",
      symptoms: [
        { en: "calm & rested", ko: "차분하고 잘 쉼" },
        { en: "able to recuperate", ko: "회복할 수 있음" },
        { en: "positive attitude", ko: "긍정적인 태도" }
      ]
    },
    {
      name: "Mild", max: 40, color: "#8fc15a",
      behavior: "조금 피곤하고 안절부절못해요 😐",
      symptoms: [
        { en: "restlessness", ko: "안절부절못함" },
        { en: "needing a lot of sleep", ko: "잠이 많아짐" },
        { en: "skipping meals", ko: "끼니를 거름" }
      ]
    },
    {
      name: "Moderate", max: 60, color: "#f0b84f",
      behavior: "두통·복통이 생기고 짜증이 나요 😣",
      symptoms: [
        { en: "headaches", ko: "두통" },
        { en: "stomach aches", ko: "복통" },
        { en: "sore muscles", ko: "근육통" },
        { en: "irritability", ko: "짜증, 신경질" }
      ]
    },
    {
      name: "High", max: 80, color: "#e8743b",
      behavior: "손톱을 물어뜯고 사람들을 피해요 😖",
      symptoms: [
        { en: "biting your nails", ko: "손톱을 물어뜯음" },
        { en: "withdrawing from friends", ko: "친구를 멀리함" },
        { en: "anxiety", ko: "불안" },
        { en: "worrying all the time", ko: "늘 걱정함" }
      ]
    },
    {
      name: "Overload", max: 100, color: "#e0483f",
      behavior: "\"Just leave me alone!\" — 한계예요 😱",
      symptoms: [
        { en: "doubling over with cramps", ko: "경련으로 몸을 웅크림" },
        { en: "two-day headaches", ko: "이틀 가는 두통" },
        { en: "yelling at your mom", ko: "엄마에게 소리침" },
        { en: "crying for no apparent reason", ko: "이유 없이 욺" },
        { en: "feeling out of control", ko: "통제 불능감" },
        { en: "depression & sadness", ko: "우울과 슬픔" }
      ]
    }
  ];

  // 시나리오 칩: 누르면 add 만큼 스트레스가 쌓임(지문의 "점점 높은 수준에 적응" 체험).
  // en 은 지문이 말하는 stress factor / 증상과 연결.
  var SCENARIOS = [
    { ko: "중간고사", en: "midterm exam", add: 18 },
    { ko: "기말고사", en: "final exam", add: 22 },
    { ko: "성적", en: "grades", add: 16 },
    { ko: "교우관계", en: "problems with friends", add: 15 },
    { ko: "엄마 잔소리", en: "yelling at your mom", add: 12 },
    { ko: "아빠와 갈등", en: "parental decisions", add: 12 },
    { ko: "과세특", en: "school records", add: 12 },
    { ko: "생기부 작성", en: "homework & school rules", add: 12 },
    { ko: "진로 고민", en: "worrying about the future", add: 14 },
    { ko: "비교과활동", en: "always being productive", add: 10 },
    { ko: "아픔/병", en: "colds & infections", add: 10 }
  ];

  // 지문으로 넘어가기 전 보여줄 핵심 키워드(지문 5 본문 표현).
  var BRIDGE = [
    "long-term stress", "full of tigers", "recuperate",
    "the physical and emotional toll", "a driven culture", "strung out & wrung out",
    "symptoms of overload", "performance edge", "out of control"
  ];

  /* ===================== DOM ===================== */

  var canvas = document.getElementById("stage");
  var levelTitle = document.getElementById("levelTitle");
  var behaviorLine = document.getElementById("behaviorLine");
  var symptomBadge = document.getElementById("symptomBadge");
  var symptomList = document.getElementById("symptomList");
  var slider = document.getElementById("stressSlider");
  var stressValue = document.getElementById("stressValue");
  var resetButton = document.getElementById("resetButton");
  var chipsBox = document.getElementById("chips");
  var startPanel = document.getElementById("startPanel");
  var startButton = document.getElementById("startButton");
  var readingButton = document.getElementById("readingButton");
  var bridgePanel = document.getElementById("bridgePanel");
  var closeBridge = document.getElementById("closeBridge");
  var bridgeGrid = document.getElementById("bridgeGrid");
  // 추가 기능 DOM
  var breatheButton = document.getElementById("breatheButton");
  var soundButton = document.getElementById("soundButton");
  var hairButton = document.getElementById("hairButton");
  var breatheGuide = document.getElementById("breatheGuide");
  var breatheRing = document.getElementById("breatheRing");
  var breatheText = document.getElementById("breatheText");
  var bigSymptom = document.getElementById("bigSymptom");
  var bigEn = document.getElementById("bigEn");
  var bigKo = document.getElementById("bigKo");
  var root = document.documentElement;

  /* ===================== three.js 기본 셋업 ===================== */

  var scene = new T.Scene();
  var camera = new T.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(0, 0.15, 5.0);
  camera.lookAt(0, 0, 0);

  var renderer = new T.WebGLRenderer({ canvas: canvas, antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));

  // 조명 (earth day hook 과 동일 계열)
  var keyLight = new T.DirectionalLight(0xfff3da, 1.15);
  keyLight.position.set(3.5, 4.5, 5.5);
  scene.add(keyLight);
  var fillLight = new T.DirectionalLight(0xbfe2ff, 0.4);
  fillLight.position.set(-4.5, 1.5, 2.5);
  scene.add(fillLight);
  scene.add(new T.HemisphereLight(0xdfefff, 0x2a2f3a, 0.7));
  scene.add(new T.AmbientLight(0xffffff, 0.25));

  // 배경 색 — 스트레스에 따라 차분한 청록 → 따뜻한 크림 → 위험한 빨강 (3단계)
  var BG_STOPS = [
    { t: 0.0, c: new T.Color("#bfe9e2") },
    { t: 0.5, c: new T.Color("#ffe1b0") },
    { t: 1.0, c: new T.Color("#e0483f") }
  ];
  var bgColor = new T.Color();
  function bgAt(s01, out) {
    var p = clamp(s01, 0, 1);
    for (var i = 1; i < BG_STOPS.length; i++) {
      if (p <= BG_STOPS[i].t) {
        var a = BG_STOPS[i - 1], b = BG_STOPS[i];
        return out.copy(a.c).lerp(b.c, (p - a.t) / (b.t - a.t));
      }
    }
    return out.copy(BG_STOPS[BG_STOPS.length - 1].c);
  }
  // 배경 백드롭 평면(unlit) — 머티리얼 색을 직접 입혀 어떤 환경에서도 확실히 칠해짐
  var backdrop = new T.Mesh(new T.PlaneGeometry(80, 80), new T.MeshBasicMaterial({ color: 0xbfe9e2 }));
  backdrop.position.set(0, 0, -14);
  scene.add(backdrop);

  /* ===================== 머리(절차적 메시) ===================== */

  // 외부 3D 모델 없이(오프라인) 머리·눈썹·눈·입을 각각 메시로 만들어
  // 스트레스 값으로 직접 변형(lerp)한다. → 3D인데도 표정이 살아 있음.

  var head = new T.Group();
  scene.add(head);

  var SKIN_CALM = new T.Color("#f2c9a4");
  var SKIN_HOT = new T.Color("#e07a5f");

  var skinMat = new T.MeshStandardMaterial({ color: SKIN_CALM.clone(), roughness: 0.72, metalness: 0.02 });

  // 얼굴(살짝 달걀형)
  var face = new T.Mesh(new T.SphereGeometry(1, 48, 48), skinMat);
  face.scale.set(1.02, 1.16, 0.96);
  head.add(face);

  // 귀
  [-1, 1].forEach(function (s) {
    var ear = new T.Mesh(new T.SphereGeometry(0.2, 20, 20), skinMat);
    ear.position.set(s * 1.0, -0.02, 0);
    ear.scale.set(0.6, 0.9, 0.6);
    head.add(ear);
  });

  // 코
  var nose = new T.Mesh(new T.SphereGeometry(0.13, 20, 20), skinMat);
  nose.position.set(0, -0.08, 0.97);
  nose.scale.set(0.9, 1.2, 1.1);
  head.add(nose);

  // 머리카락 (스타일 토글: 민머리 → 짧은 → 앞머리 → 곱슬)
  var hairMat = new T.MeshStandardMaterial({ color: 0x3a2a20, roughness: 0.92, metalness: 0 });
  var hairGroup = new T.Group();
  head.add(hairGroup);
  var hairPieces = { short: [], bangs: [], curly: [] };

  // 공통 두피 캡(머리 위를 덮는 반구 조각)
  function makeCap() {
    var cap = new T.Mesh(new T.SphereGeometry(1.0, 40, 32, 0, Math.PI * 2, 0, Math.PI * 0.5), hairMat);
    cap.scale.set(1.07, 1.16, 1.05);
    cap.position.y = 0.05;
    cap.rotation.x = -0.16;   // 앞쪽을 살짝 위로 → 이마가 보이게
    return cap;
  }
  // short: 캡만
  hairPieces.short.push(makeCap());
  // bangs: 캡 + 앞머리(이마로 내려오는 곡면)
  hairPieces.bangs.push(makeCap());
  var fringe = new T.Mesh(new T.SphereGeometry(1.0, 40, 22, 0, Math.PI * 2, 0, Math.PI * 0.22), hairMat);
  fringe.scale.set(1.02, 0.95, 1.02);
  fringe.position.set(0, 0.5, 0.05);
  fringe.rotation.x = 0.62;
  hairPieces.bangs.push(fringe);
  // curly: 캡 + 작은 곱슬 구체들
  hairPieces.curly.push(makeCap());
  for (var hc = 0; hc < 24; hc++) {
    var puff = new T.Mesh(new T.SphereGeometry(0.17, 12, 12), hairMat);
    var ang = (hc / 24) * Math.PI * 2;
    var ring = 0.55 + (hc % 3) * 0.16;
    puff.position.set(Math.cos(ang) * ring, 0.78 + (hc % 2) * 0.18, Math.sin(ang) * ring * 0.7 - 0.12);
    hairPieces.curly.push(puff);
  }

  // 모든 조각을 hairGroup 에 넣고 스타일별로 보였다/숨겼다 함
  Object.keys(hairPieces).forEach(function (k) {
    hairPieces[k].forEach(function (m) { m.visible = false; hairGroup.add(m); });
  });
  var HAIR_STYLES = ["none", "short", "bangs", "curly"];
  var HAIR_LABELS = { none: "민머리", short: "짧은 머리", bangs: "앞머리", curly: "곱슬" };
  var hairIndex = 1;   // 기본: 짧은 머리
  function applyHair() {
    var style = HAIR_STYLES[hairIndex];
    Object.keys(hairPieces).forEach(function (k) {
      hairPieces[k].forEach(function (m) { m.visible = (k === style); });
    });
  }

  // 볼 홍조 (투명 → 스트레스 오르면 진해짐)
  var blushMat = new T.MeshStandardMaterial({ color: 0xff6f61, transparent: true, opacity: 0, roughness: 1 });
  var blushes = [-1, 1].map(function (s) {
    var b = new T.Mesh(new T.CircleGeometry(0.27, 28), blushMat);
    b.position.set(s * 0.5, -0.2, 0.9);
    head.add(b);
    return b;
  });

  // 눈 (눈 그룹: 흰자 + 동공 + 눈꺼풀). scale.y 로 가늘게/크게.
  var scleraMat = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 });
  var pupilMat = new T.MeshStandardMaterial({ color: 0x241c19, roughness: 0.3 });
  var SCLERA_WHITE = new T.Color(0xffffff);
  var SCLERA_BLOOD = new T.Color("#ffb3a3");

  function makeEye(sign) {
    var g = new T.Group();
    g.position.set(sign * 0.42, 0.2, 0.66);
    var sclera = new T.Mesh(new T.SphereGeometry(0.23, 28, 28), scleraMat);
    sclera.scale.z = 0.55;
    g.add(sclera);
    var pupil = new T.Mesh(new T.SphereGeometry(0.105, 22, 22), pupilMat);
    pupil.position.set(0, 0, 0.16);
    pupil.scale.z = 0.5;
    g.add(pupil);
    // 윗눈꺼풀(살색): 아래로 내리면 찡그림/긴장
    var lid = new T.Mesh(new T.SphereGeometry(0.245, 28, 20, 0, Math.PI * 2, 0, Math.PI * 0.55), skinMat);
    lid.position.set(0, 0.06, 0.02);
    g.add(lid);
    head.add(g);
    return { group: g, sclera: sclera, pupil: pupil, lid: lid, baseLidY: 0.06 };
  }
  var eyeL = makeEye(-1);
  var eyeR = makeEye(1);

  // 눈썹
  var browMat = new T.MeshStandardMaterial({ color: 0x4a3327, roughness: 0.8 });
  function makeBrow(sign) {
    var b = new T.Mesh(new T.BoxGeometry(0.4, 0.09, 0.1), browMat);
    b.position.set(sign * 0.42, 0.52, 0.82);
    head.add(b);
    return { mesh: b, sign: sign, baseY: 0.52, baseX: sign * 0.42 };
  }
  var browL = makeBrow(-1);
  var browR = makeBrow(1);

  // 입 (곡선 튜브를 매 프레임 다시 생성 → 미소 ↔ 찡그림). + 벌어진 입(쇼크용)
  var mouthMat = new T.MeshStandardMaterial({ color: 0x7d3b34, roughness: 0.6 });
  var mouth = new T.Mesh(new T.BufferGeometry(), mouthMat);
  head.add(mouth);
  var mouthKey = null;

  function setMouth(curveAmt) {
    // curveAmt: +1 환한 미소 … 0 무표정 … -1 찡그림
    var key = Math.round(curveAmt * 40);
    if (key === mouthKey) return;
    mouthKey = key;
    var y = -0.52, z = 0.9, halfW = 0.34;
    var cornerLift = curveAmt * 0.08;           // 미소면 입꼬리 ↑
    var midY = y - curveAmt * 0.2;              // 미소면 가운데 ↓ → U자
    var curve = new T.QuadraticBezierCurve3(
      new T.Vector3(-halfW, y + cornerLift, z),
      new T.Vector3(0, midY, z + 0.04),
      new T.Vector3(halfW, y + cornerLift, z)
    );
    var geo = new T.TubeGeometry(curve, 24, 0.055, 10, false);
    mouth.geometry.dispose();
    mouth.geometry = geo;
  }

  // 벌어진 입(검은 타원) — Overload 에서 커짐
  var mouthOpen = new T.Mesh(new T.CircleGeometry(0.2, 28), new T.MeshStandardMaterial({ color: 0x3a1714, roughness: 1 }));
  mouthOpen.position.set(0, -0.56, 0.9);
  mouthOpen.scale.set(1, 0.6, 1);
  mouthOpen.visible = false;
  head.add(mouthOpen);

  // 이마 핏줄 (고스트레스에서 깜빡이며 등장)
  var veinMat = new T.MeshStandardMaterial({ color: 0xc0392b, transparent: true, opacity: 0, roughness: 0.6 });
  var veinCurve = new T.CatmullRomCurve3([
    new T.Vector3(0.18, 0.78, 0.78),
    new T.Vector3(0.28, 0.66, 0.82),
    new T.Vector3(0.2, 0.54, 0.84),
    new T.Vector3(0.3, 0.44, 0.82)
  ]);
  var vein = new T.Mesh(new T.TubeGeometry(veinCurve, 24, 0.02, 8, false), veinMat);
  head.add(vein);

  /* --- 입자 풀: 땀 · 김 · 눈물 --- */
  function pool(n, make) { var a = []; for (var i = 0; i < n; i++) a.push(make(i)); return a; }

  var SWEAT_N = 6;
  var sweatMat = new T.MeshStandardMaterial({ color: 0x7fc7ff, transparent: true, opacity: 0.9, roughness: 0.2 });
  var sweat = pool(SWEAT_N, function (i) {
    var d = new T.Mesh(new T.SphereGeometry(0.06, 14, 14), sweatMat.clone());
    d.scale.set(1, 1.4, 1);
    // 이마/관자놀이 곳곳에서 시작
    var sx = (i % 2 ? 1 : -1) * (0.5 + (i % 3) * 0.12);
    d.userData = { x: sx, top: 0.7 - (i % 2) * 0.1, phase: i / SWEAT_N };
    d.visible = false;
    head.add(d);
    return d;
  });

  var steamMat = new T.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.0, roughness: 1 });
  var steam = pool(6, function (i) {
    var p = new T.Mesh(new T.SphereGeometry(0.1, 12, 12), steamMat.clone());
    p.userData = { x: (i % 3 - 1) * 0.5, phase: i / 6 };
    p.visible = false;
    head.add(p);
    return p;
  });

  var tearMat = new T.MeshStandardMaterial({ color: 0xaad8ff, transparent: true, opacity: 0.95, roughness: 0.2 });
  var tears = pool(4, function (i) {
    var t = new T.Mesh(new T.SphereGeometry(0.05, 12, 12), tearMat.clone());
    t.scale.set(1, 1.5, 1);
    t.userData = { x: (i < 2 ? -0.42 : 0.42), phase: (i % 2) * 0.5 };
    t.visible = false;
    head.add(t);
    return t;
  });

  // 바닥 접지 그림자(부드러운 원형 텍스처) → 입체감
  var shadowTex = makeShadowTexture();
  var contact = new T.Mesh(
    new T.PlaneGeometry(3.4, 3.4),
    new T.MeshBasicMaterial({ map: shadowTex, transparent: true, opacity: 0.5, depthWrite: false })
  );
  contact.rotation.x = -Math.PI / 2;
  contact.position.y = -1.5;
  scene.add(contact);

  function makeShadowTexture() {
    var c = document.createElement("canvas");
    c.width = c.height = 128;
    var ctx = c.getContext("2d");
    var g = ctx.createRadialGradient(64, 64, 4, 64, 64, 60);
    g.addColorStop(0, "rgba(0,0,0,0.55)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    var tex = new T.CanvasTexture(c);
    tex.colorSpace = T.SRGBColorSpace;
    return tex;
  }

  /* ===================== 상태 ===================== */

  var targetStress = 0;  // 목표 값(슬라이더·칩이 설정)
  var stress = 0;        // 화면 표시 값(목표로 부드럽게 수렴)
  var started = false;
  var bandIndex = -1;
  var sawOverload = false;
  var clock = 0;
  var DEBUG = false;

  // 추가 기능 상태
  var breathing = false;
  var breatheClock = 0;
  var breathInhale = null;

  // 마우스/터치로 머리 돌리기
  var dragging = false, lastX = 0, lastY = 0;
  var yaw = 0, pitch = 0, autoYaw = 0;

  function bandFor(v) {
    for (var i = 0; i < BANDS.length; i++) if (v <= BANDS[i].max) return i;
    return BANDS.length - 1;
  }

  function setTarget(v, fromChip) {
    targetStress = clamp(v, 0, 100);
    slider.value = Math.round(targetStress);
    if (!fromChip) { /* 슬라이더 직접 조작 */ }
  }

  function updateBandUI(i) {
    if (i === bandIndex) return;
    bandIndex = i;
    var b = BANDS[i];
    root.style.setProperty("--mood", b.color);
    levelTitle.textContent = b.name;
    behaviorLine.textContent = b.behavior;
    symptomBadge.textContent = "LV." + (i + 1);
    symptomList.innerHTML = "";
    b.symptoms.forEach(function (s) {
      var li = document.createElement("li");
      li.className = "clickable";
      li.tabIndex = 0;
      li.dataset.en = s.en;
      li.dataset.ko = s.ko;
      li.innerHTML = '<span class="en">' + s.en + '</span><span class="ko">' + s.ko + "</span>";
      symptomList.appendChild(li);
    });
    if (i === BANDS.length - 1 && !sawOverload) {
      sawOverload = true;
      readingButton.classList.add("pulse");  // 한계 도달 → 지문으로 유도
    }
  }

  /* ===================== 매 프레임: 표정 갱신 ===================== */

  function applyFace(s01, t) {
    // 피부색(홍조)
    skinMat.color.copy(SKIN_CALM).lerp(SKIN_HOT, smooth(s01, 0.05, 1) * 0.85);
    blushMat.opacity = clamp(s01 * 1.25, 0, 0.85);

    // 눈썹: 스트레스 ↑ → 안쪽이 아래로 + 모이고 + 내려감
    var ang = lerp(-0.08, 0.62, s01);
    browL.mesh.rotation.z = ang;
    browR.mesh.rotation.z = -ang;
    browL.mesh.position.y = browR.mesh.position.y = lerp(0.52, 0.42, s01);
    browL.mesh.position.x = browL.baseX + s01 * 0.05;
    browR.mesh.position.x = browR.baseX - s01 * 0.05;

    // 눈: 중간에 크게(놀람) → 아주 높으면 가늘게(긴장) + 충혈 + 동공 확대
    var widen = Math.sin(Math.PI * Math.min(s01 / 0.85, 1));
    var strain = Math.max(0, s01 - 0.82) / 0.18;
    var eyeY = (0.9 + widen * 0.32) * (1 - strain * 0.45);
    [eyeL, eyeR].forEach(function (e) {
      e.group.scale.y = eyeY;
      e.lid.position.y = e.baseLidY - strain * 0.12 + (0.06 - widen * 0.05);
      e.sclera.material.color.copy(SCLERA_WHITE).lerp(SCLERA_BLOOD, clamp((s01 - 0.4) / 0.6, 0, 1));
      e.pupil.scale.setScalar(1 + clamp((s01 - 0.5) / 0.5, 0, 1) * 0.3);
    });

    // 입: +1 미소 → -1 찡그림. 아주 높으면 벌어진 입(쇼크)
    var curve = 1 - 2 * smooth(s01, 0.0, 0.85);
    setMouth(curve);
    var openAmt = clamp((s01 - 0.85) / 0.15, 0, 1);
    mouthOpen.visible = openAmt > 0.02;
    mouthOpen.scale.set(0.5 + openAmt, (0.5 + openAmt) * 0.7, 1);
    mouth.visible = openAmt < 0.6;

    // 이마 핏줄: 0.55 부터 등장, 박동
    var veinBase = clamp((s01 - 0.55) / 0.45, 0, 1);
    veinMat.opacity = veinBase * (0.55 + 0.45 * Math.sin(t * 9));

    // 땀: 개수 = 스트레스 비례, 아래로 떨어지며 반복
    var nSweat = Math.round(s01 * sweat.length);
    sweat.forEach(function (d, i) {
      if (i >= nSweat) { d.visible = false; return; }
      d.visible = true;
      var p = (t * 0.5 + d.userData.phase) % 1;
      d.position.set(d.userData.x, d.userData.top - p * 1.5, 0.85);
      d.material.opacity = 0.9 * (1 - p);
    });

    // 김(steam): 0.78 부터 위로 솟으며 사라짐
    var steamOn = clamp((s01 - 0.78) / 0.22, 0, 1);
    steam.forEach(function (p, i) {
      if (steamOn <= 0.02) { p.visible = false; return; }
      p.visible = true;
      var ph = (t * 0.45 + p.userData.phase) % 1;
      p.position.set(p.userData.x, 1.2 + ph * 0.9, 0.2);
      p.scale.setScalar(0.5 + ph * 0.9);
      p.material.opacity = steamOn * 0.55 * (1 - ph);
    });

    // 눈물: 0.85 부터 눈 아래로
    var tearOn = s01 > 0.85;
    tears.forEach(function (tr) {
      if (!tearOn) { tr.visible = false; return; }
      tr.visible = true;
      var ph = (t * 0.6 + tr.userData.phase) % 1;
      tr.position.set(tr.userData.x, 0.05 - ph * 1.1, 0.78);
      tr.material.opacity = 0.95 * (1 - ph);
    });

    // 떨림: 0.7 부터 머리 미세 진동
    var tremble = Math.max(0, s01 - 0.7) / 0.3;
    head.position.x = Math.sin(t * 42) * 0.02 * tremble;
    head.position.y = Math.cos(t * 37) * 0.015 * tremble;
  }

  /* ===================== 렌더 루프 ===================== */

  function resize() {
    var w = canvas.clientWidth || window.innerWidth;
    var h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  var last = 0;
  function animate(now) {
    requestAnimationFrame(animate);
    var dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    clock += dt;

    // 표시 값이 목표로 부드럽게 수렴
    stress += (targetStress - stress) * Math.min(1, dt * 6);
    if (Math.abs(stress - targetStress) < 0.05) stress = targetStress;
    var s01 = stress / 100;

    // UI 갱신
    var rounded = Math.round(stress);
    if (stressValue.textContent !== String(rounded)) stressValue.textContent = rounded;
    updateBandUI(bandFor(stress));

    // 배경색(백드롭 평면 머티리얼 — 환경 무관하게 확실히 반영)
    bgAt(s01, bgColor);
    backdrop.material.color.copy(bgColor);
    renderer.setClearColor(bgColor, 1);

    // 표정
    applyFace(s01, clock);

    // 불안 긴장음: 스트레스 0.5↑ 부터 점점 커짐
    if (audio.on && audio.anxGain) {
      var ax = clamp((s01 - 0.5) / 0.5, 0, 1);
      audio.anxGain.gain.setTargetAtTime(0.0001 + ax * 0.05, audio.ctx.currentTime, 0.4);
    }

    // Breathe(숨 고르기): 천천히 0으로 내려가며 호흡 가이드 표시
    if (breathing) {
      breatheClock += dt;
      var period = 8, ph = (breatheClock % period) / period;
      var inhale = ph < 0.5;
      var amt = inhale ? smooth(ph / 0.5, 0, 1) : smooth(1 - (ph - 0.5) / 0.5, 0, 1);
      breatheRing.style.transform = "translate(-50%,-50%) scale(" + (0.65 + amt * 0.9) + ")";
      if (inhale !== breathInhale) {
        breathInhale = inhale;
        breatheText.innerHTML = inhale
          ? 'Breathe in<span class="ko">천천히 들이쉬기</span>'
          : 'Breathe out<span class="ko">천천히 내쉬기</span>';
      }
      head.scale.setScalar(1 + amt * 0.05);
      targetStress += (0 - targetStress) * Math.min(1, dt * 0.5);
      slider.value = Math.round(targetStress);
      if (targetStress < 1.2 && breatheClock > period * 0.55) {
        targetStress = 0; slider.value = 0;
        stopBreathing();
        readingButton.classList.remove("pulse"); sawOverload = false;
      }
    }

    // 머리 회전(드래그 + 가만히 있으면 천천히 흔들)
    if (!dragging) autoYaw += dt * 0.25;
    head.rotation.y = yaw + (dragging ? 0 : Math.sin(autoYaw) * 0.18);
    head.rotation.x = pitch;

    renderer.render(scene, camera);

    if (DEBUG) {
      document.title = "S=" + rounded + " s01=" + s01.toFixed(2) +
        " bg=" + bgColor.getHexString() + " skin=" + skinMat.color.getHexString() +
        " clear=" + renderer.getClearColor(new T.Color()).getHexString();
    }
  }

  /* ===================== 입력 연결 ===================== */

  // 슬라이더
  slider.addEventListener("input", function () { cancelBreathing(); setTarget(parseInt(slider.value, 10), false); });

  // 리셋
  resetButton.addEventListener("click", function () {
    cancelBreathing();
    setTarget(0, false);
    readingButton.classList.remove("pulse");
    sawOverload = false;
  });

  // 시나리오 칩
  SCENARIOS.forEach(function (sc) {
    var chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.innerHTML = sc.ko + '<span class="en">' + sc.en + "</span>";
    chip.addEventListener("click", function () {
      cancelBreathing();
      setTarget(targetStress + sc.add, true);
      chip.classList.remove("bump");
      void chip.offsetWidth;        // 애니메이션 재시작
      chip.classList.add("bump");
    });
    chipsBox.appendChild(chip);
  });

  // 시작 버튼
  startButton.addEventListener("click", function () {
    startPanel.classList.add("is-hidden");
    started = true;
    canvas.focus();
  });

  // 지문 브리지 패널
  BRIDGE.forEach(function (k) {
    var s = document.createElement("span");
    s.textContent = k;
    bridgeGrid.appendChild(s);
  });
  function openBridge() { bridgePanel.classList.add("is-open"); readingButton.classList.remove("pulse"); }
  function hideBridge() { bridgePanel.classList.remove("is-open"); }
  readingButton.addEventListener("click", openBridge);
  closeBridge.addEventListener("click", hideBridge);
  bridgePanel.addEventListener("click", function (e) { if (e.target === bridgePanel) hideBridge(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") hideBridge(); });

  // 머리 돌리기 (포인터)
  canvas.addEventListener("pointerdown", function (e) {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    yaw = head.rotation.y; // 현재 보이는 각도에서 이어서
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", function (e) {
    if (!dragging) return;
    yaw += (e.clientX - lastX) * 0.01;
    pitch = clamp(pitch + (e.clientY - lastY) * 0.008, -0.6, 0.6);
    lastX = e.clientX; lastY = e.clientY;
  });
  function endDrag() { dragging = false; }
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  // 휠 줌(가벼운 달리)
  canvas.addEventListener("wheel", function (e) {
    e.preventDefault();
    camera.position.z = clamp(camera.position.z + (e.deltaY > 0 ? 0.3 : -0.3), 3.4, 7.0);
  }, { passive: false });

  window.addEventListener("resize", resize);

  /* ===================== 증상 크게 보기 + 발음 ===================== */
  function speak(text) {
    try {
      if (!window.speechSynthesis) return;
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = "en-US"; u.rate = 0.9;
      window.speechSynthesis.speak(u);
    } catch (e) { /* 음성 미지원 환경은 조용히 무시 */ }
  }
  function showBig(en, ko) {
    bigEn.textContent = en;
    bigKo.textContent = ko;
    bigSymptom.classList.add("is-on");
    speak(en);
  }
  function hideBig() { bigSymptom.classList.remove("is-on"); }
  symptomList.addEventListener("click", function (e) {
    var li = e.target.closest("li"); if (!li) return;
    showBig(li.dataset.en, li.dataset.ko);
  });
  symptomList.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    var li = e.target.closest("li"); if (!li) return;
    e.preventDefault(); showBig(li.dataset.en, li.dataset.ko);
  });
  bigEn.addEventListener("click", function (e) { e.stopPropagation(); speak(bigEn.textContent); });
  bigSymptom.addEventListener("click", hideBig);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") hideBig(); });

  /* ===================== Breathe(숨 고르기) ===================== */
  function startBreathing() {
    breathing = true; breatheClock = 0; breathInhale = null;
    breatheGuide.classList.add("is-on");
    breatheButton.classList.add("on");
  }
  function stopBreathing() {
    breathing = false;
    breatheGuide.classList.remove("is-on");
    breatheButton.classList.remove("on");
    head.scale.set(1, 1, 1);
  }
  function cancelBreathing() { if (breathing) stopBreathing(); }
  breatheButton.addEventListener("click", function () {
    if (breathing) stopBreathing(); else startBreathing();
  });

  /* ===================== 소리: 심장박동 + 호흡 + 울음 + 불안(WebAudio, 오프라인) ===================== */
  var audio = { ctx: null, master: null, on: false, noiseGain: null, heartT: null, breathT: null, cryT: null, anxGain: null };
  function ensureAudio() {
    if (audio.ctx) return true;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    audio.ctx = new AC();
    audio.master = audio.ctx.createGain();
    audio.master.gain.value = 0;
    audio.master.connect(audio.ctx.destination);
    // 호흡용 화이트노이즈 → 밴드패스 → 게인 (스트레스 ↑ → 빠르고 거친 숨)
    var sr = audio.ctx.sampleRate;
    var buf = audio.ctx.createBuffer(1, sr * 2, sr);
    var d = buf.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.5;
    var src = audio.ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    var bp = audio.ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 500; bp.Q.value = 0.7;
    audio.noiseGain = audio.ctx.createGain(); audio.noiseGain.gain.value = 0.0001;
    src.connect(bp); bp.connect(audio.noiseGain); audio.noiseGain.connect(audio.master);
    src.start();
    // 불안한 긴장음: 살짝 어긋난 두 음이 만드는 '삐-' 하는 떨리는 드론 (고스트레스에서만 커짐)
    audio.anxGain = audio.ctx.createGain(); audio.anxGain.gain.value = 0.0001;
    var lp = audio.ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 1400;
    [479, 484].forEach(function (f) {
      var o = audio.ctx.createOscillator(); o.type = "triangle"; o.frequency.value = f;
      o.connect(audio.anxGain); o.start();
    });
    audio.anxGain.connect(lp); lp.connect(audio.master);
    return true;
  }
  // 흐느끼는 울음 한 번 (떨리며 올라갔다 내려오는 목소리 같은 음)
  function cryWhimper() {
    var ctx = audio.ctx, t = ctx.currentTime;
    var o = ctx.createOscillator(), g = ctx.createGain(), bp = ctx.createBiquadFilter();
    o.type = "sawtooth";
    bp.type = "bandpass"; bp.frequency.value = 900; bp.Q.value = 5;
    o.frequency.setValueAtTime(420, t);
    o.frequency.linearRampToValueAtTime(530, t + 0.18);
    o.frequency.linearRampToValueAtTime(360, t + 0.7);
    // 비브라토(흐느낌 떨림)
    var lfo = ctx.createOscillator(), lfoG = ctx.createGain();
    lfo.frequency.value = 11; lfoG.gain.value = 16;
    lfo.connect(lfoG); lfoG.connect(o.frequency);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.13, t + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.78);
    o.connect(bp); bp.connect(g); g.connect(audio.master);
    o.start(t); lfo.start(t); o.stop(t + 0.82); lfo.stop(t + 0.82);
  }
  function cryLoop() {
    if (!audio.on) return;
    var s01 = clamp(stress / 100, 0, 1);
    if (s01 > 0.82) { cryWhimper(); audio.cryT = setTimeout(cryLoop, 1700 + Math.random() * 900); }
    else { audio.cryT = setTimeout(cryLoop, 900); }
  }
  function heartBeat() {
    if (!audio.on) return;
    var ctx = audio.ctx, t = ctx.currentTime;
    function thump(at, amp) {
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(72, at);
      o.frequency.exponentialRampToValueAtTime(40, at + 0.12);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(amp, at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
      o.connect(g); g.connect(audio.master);
      o.start(at); o.stop(at + 0.22);
    }
    thump(t, 0.9); thump(t + 0.17, 0.5);   // 두근(lub) - 두근(dub)
    var s01 = clamp(stress / 100, 0, 1);
    var bpm = lerp(60, 150, s01);           // 스트레스 ↑ → 심박 ↑
    audio.heartT = setTimeout(heartBeat, 60000 / bpm);
  }
  function breatheSound() {
    if (!audio.on) return;
    var ctx = audio.ctx, s01 = clamp(stress / 100, 0, 1);
    var period = lerp(5.0, 1.9, s01);       // 스트레스 ↑ → 호흡 ↑
    var amp = lerp(0.05, 0.13, s01);
    var g = audio.noiseGain.gain, t = ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.max(0.0001, g.value), t);
    g.linearRampToValueAtTime(amp, t + period * 0.4);     // 들숨
    g.linearRampToValueAtTime(0.0001, t + period * 0.92); // 날숨
    audio.breathT = setTimeout(breatheSound, period * 1000);
  }
  function setSound(on) {
    if (on && !ensureAudio()) return;       // WebAudio 미지원이면 무시
    audio.on = on;
    soundButton.firstChild.nodeValue = on ? "🔊" : "🔇";
    soundButton.classList.toggle("on", on);
    if (on) {
      if (audio.ctx.state === "suspended") audio.ctx.resume();
      audio.master.gain.cancelScheduledValues(audio.ctx.currentTime);
      audio.master.gain.setTargetAtTime(0.4, audio.ctx.currentTime, 0.2);
      heartBeat(); breatheSound(); cryLoop();
    } else if (audio.ctx) {
      audio.master.gain.setTargetAtTime(0.0, audio.ctx.currentTime, 0.15);
      clearTimeout(audio.heartT); clearTimeout(audio.breathT); clearTimeout(audio.cryT);
      if (audio.anxGain) audio.anxGain.gain.setTargetAtTime(0.0001, audio.ctx.currentTime, 0.2);
    }
  }
  soundButton.addEventListener("click", function () { setSound(!audio.on); });

  /* ===================== 머리 스타일 토글 ===================== */
  hairButton.addEventListener("click", function () {
    hairIndex = (hairIndex + 1) % HAIR_STYLES.length;
    applyHair();
    hairButton.querySelector(".ko").textContent = HAIR_LABELS[HAIR_STYLES[hairIndex]];
  });
  applyHair();   // 기본 스타일(짧은 머리) 적용

  /* ===================== 시작 ===================== */
  // URL 파라미터: ?stress=70 (특정 레벨로 바로) · &go=1 (시작화면 건너뛰기)
  var params = new URLSearchParams(location.search);
  if (params.has("stress")) {
    var sv = clamp(parseInt(params.get("stress"), 10) || 0, 0, 100);
    stress = targetStress = sv;
    slider.value = sv;
  }
  if (params.get("go") === "1") { startPanel.classList.add("is-hidden"); started = true; }
  if (params.get("debug") === "1") { DEBUG = true; }

  resize();
  updateBandUI(bandFor(stress));
  requestAnimationFrame(animate);
})();
