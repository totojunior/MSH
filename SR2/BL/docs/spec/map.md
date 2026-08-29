**Equal Earth 정적면적 투영 + 국경 없는 육지 실루엣 + 1인=1점 해바라기 뭉침 + 지도 전용 화면(칩 레일)**로 간다.

- **데이터**: `world-atlas@2 countries-110m.json` 의 `objects.land`(국경 없이 이미 합쳐진 육지)만 쓴다. 중심좌표는 `gavinr` 것을 iso2→iso3 로 옮기고 손으로 고쳤다.
- **파일 3개를 실제로 만들었고 검증까지 끝냈다** (`data/assets/` 아래). `world_path.json` **31.9KB** (목표 60KB의 53%), `centroids.json` **217/217 전부 커버, 누락 0**.
- **투영**: equirectangular 는 **쓰지 말라**. 이 수업에서만큼은 고위도 왜곡이 실제로 문제다 — 아프리카를 상대적으로 줄이는 투영으로 "출생은 아프리카·남아시아에 몰린다"를 보여주면 그림이 주장을 갉는다. Equal Earth 는 닫힌 식 8줄이고 정적면적이라 **화면 위 점 밀도 = 실제 출생 밀도**가 된다. 파이썬/JS 값이 소수점 끝자리까지 일치하는 것을 실측 확인했다.
- **겹침**: 33명 중 한 나라 최다 중복은 **중앙값 6개, 21%의 반에서 8개 이상, 0.5%에서 12개**다(20만 회 시뮬레이션). 원을 키우거나 숫자를 쓰지 말고 **점 크기를 절대 고정한 채 해바라기(피보나치) 배치로 흩뜨린다**. 점 하나 = 사람 하나가 이 수업의 전부이기 때문이다.
- **색**: 나라에는 색이 없다. **주황은 사람에게만 붙는다.** 육지는 무채색 슬레이트 한 톤(#333B4C), 바다는 페이지 배경 그대로(#0D0F14) — 지도가 아니라 사람이 유일한 유채색이다.
- **동선**: 지도는 상시 표시하지 않는다. 카드 그리드(5×7, 국가명 46px)를 줄이면 가독성 예산이 통째로 무너진다. 대신 **4번째 화면**으로 두고, 진입할 때 카드 33장이 점으로 날아가고, 그 뒤엔 하단 33칸 번호 칩을 누르면 그 학생 점이 찍힌다 — 교사 요구 그대로.

---

================================================================
0. 실제로 만든 것 (전부 검증 완료)
================================================================
C:/Users/user/desktop/Making where to be born Hook/data/assets/
  world_path.json   31,957 B   ← 목표 60KB 의 53%
  centroids.json     5,033 B   ← iso3 217개 전부
  map_extra.json     6,902 B   ← 선택. 안 써도 된다

빌더 / 검증 / 작동 데모 (전부 남겨 뒀다) :
  data/_agent_scratch/map/build_map.py     빌더 (재실행 가능, 인자 = 단순화 톨러런스, 최소면적)
  data/_agent_scratch/map/demo.html        작동하는 전체 화면 지도 + 칩 레일 + 미니맵 (87KB, 외부요청 0)
  data/_agent_scratch/map/mini_test.html   미니맵 4가지 안 비교 시트
  data/_agent_scratch/map/shot_dark.html   최악 중복(인도 12개) 어두운 모드
  data/_agent_scratch/map/shot_light.html  최악 중복 밝은(빔) 모드
  data/_agent_scratch/map/test_pts.py      좌표 육지 판정 테스트

================================================================
1. 데이터 소스 — 셋 다 내려받아 보고 고른 결과
================================================================
후보 3종 실측:
  countries-110m.json  105KB  TopoJSON. objects 에 countries(177) 와 **land(합쳐진 육지)** 둘 다 있음.
                              arcs 595개 / 총 8,246점. land 는 그중 268 arc / 5,127점.
  world.geojson        246KB  properties 가 {"name": ...} 뿐. **ISO 코드가 아예 없다.** → 탈락.
  centroids.geojson     47KB  249 feature, ISO2 키. 중심좌표용으로 채택.

**채택: countries-110m.json 의 `objects.land`.**
이유 3개 —
 (a) 국경이 이미 지워져 있다. BRIEF "국가에 가치판단 색·라벨 금지"와 완전히 맞는다.
     국가별 도형을 쓰면 언젠가 누가 칠하고 싶어진다. 칠할 도형 자체를 안 만든다.
 (b) 177개 폴리곤 대신 124개 → path 문자열이 절반 이하.
 (c) world.geojson 은 ISO 가 없어서 어차피 국가 식별을 못 한다.

**TopoJSON 디코딩** (라이브러리 0, 파이썬 20줄):
  transform.scale = [0.0036000360, 0.0016925586], translate = [-180, -85.60903777]
  arcs 는 델타 부호화 정수 → 누적합 후 lon = x*scale[0]+translate[0], lat = y*scale[1]+translate[1]
  음수 arc 인덱스 i 는 arc(~i) 를 뒤집어 쓴다.

가공 파이프라인 (build_map.py):
  1) land MultiPolygon 124개 폴리곤의 모든 링을 lon/lat 로 디코드
  2) **남극 제거** — 링의 max(lat) < -58 이면 버린다 (8개 링). 출생 0명, 세로 25% 낭비, 메시지 0.
  3) **날짜변경선 분할** — 이게 첫 렌더에서 실제로 터졌다. 러시아 추코트카·피지 링이 lon +179 → -179
     로 넘어가면서 **화면을 가로지르는 직선 두 줄**이 그려졌다(스크린샷으로 잡음).
     경도를 언랩한 뒤 Sutherland–Hodgman 으로 [-180,180] 띠에 클리핑, shift ±360 으로 조각 재생성.
  4) Equal Earth 투영 (아래 3절)
  5) **Douglas–Peucker** 톨러런스 0.30 canonical unit (= 1920 화면에서 0.56px)
     닫힌 링이라 시작점 + 최원점 두 곳을 고정하고 반씩 DP.
     ※ 여기서도 버그 하나 잡았다 — 후반부 DP 가 돌려준 인덱스를 원본 배열에 잘못 넣어
       대서양을 가로지르는 거대한 삼각형이 생겼다. 스크린샷으로 확인하고 고쳤다.
  6) 투영면적 1.5 unit² (≈1,785km², 1920화면 3.6px²) 미만 링 제거 → 3개
  7) 상대 델타 `l` 명령 + 소수 1자리로 직렬화 (음수 앞 공백 생략)

결과: **링 117개 / 점 3,365개 / land path 26,103자**.
톨러런스별 실측: 0.30→26.1KB · 0.45→21.8KB · 0.55→19.2KB · 0.75→15.8KB.
예산이 60KB 이므로 **가장 촘촘한 0.30 을 골랐다.** 3.4배 확대해도 계단이 1.7px 이하다.

================================================================
2. world_path.json 스키마
================================================================
{
 "projection":"equal-earth",
 "lonRange":[-180,180], "latRange":[-58,84],
 "viewBox":[0,0,1000,437.369],      // ← SVG viewBox 그대로
 "aspect":2.2864,
 "consts":{"A1":1.340264,"A2":-0.081106,"A3":0.000893,"A4":0.003796,
           "xMax":2.706629984,"yTop":1.306713139,"yBot":-1.060876459,"k":184.731567673},
 "land":"M…z"      26,103자  117 서브패스   ← fill-rule="evenodd" 필수 (카스피해가 구멍)
 "frame":"M…z"      1,568자  세계 경계(=바다 모양). 자오선 ±180 이 곡선이라 반드시 필요
 "equator":"M…"     1,357자  적도 (선택)
 "tropics":"M…M…"   2,500자  남·북회귀선 (선택, 기본 미사용)
}
검증: 토큰에 NaN/e/Infinity 0건. land 절대좌표 bbox = (75.1, 0.3)–(990.6, 431.1) — viewBox 안.

================================================================
3. 투영법 — equirectangular 는 부족하다. 확정: Equal Earth
================================================================
■ 판단 근거 (수치)
  equirectangular 면적 과장 = 1/cos φ  → 위도 60° 2.0배, 70° 2.9배
  Mercator                 = 1/cos²φ → 위도 60° 4.0배, 70° 8.5배 (논외)
  Equal Earth              = 1.000 (모든 위도)

  이 수업의 그림은 "점이 아프리카·남아시아에 몰린다" 하나다.
  equirectangular 를 쓰면 **점이 없는 러시아·캐나다·그린란드가 2~3배로 부풀고 아프리카는 제 크기**다.
  즉 화면이 "아프리카는 저 정도인데 사람이 많네"가 아니라 "북쪽이 크네"로 먼저 읽힌다.
  롤스 지문 도입에서 아프리카를 축소하는 투영을 쓰는 건 교실에서 실제로 지적당할 수 있는 종류의 실수다.
  Equal Earth 는 정적면적이라 **화면 위 점 밀도 = 실제 출생/km² 밀도**가 성립한다. 이건 그냥 참이다.

  비용: 닫힌 식 8줄, 반복계산 없음, 빌드 때 3,365회 · 런타임 33회. 사실상 0.
  왜 Gall–Peters 가 아닌가: 정적면적이지만 적도 부근이 세로로 늘어나 아프리카가 흉해지고
  정치적 짐이 붙어 있다. Equal Earth(Šavrič·Patterson·Jenny 2018)는 아틀라스 그림에 가깝다.

■ 정식 (Wikipedia 확인, 파이썬·JS 실측 일치)
  A1=1.340264  A2=-0.081106  A3=0.000893  A4=0.003796
  θ  = asin( (√3/2) · sin φ )
  x  = 2√3·λ·cos θ / ( 3·(9A₄θ⁸ + 7A₃θ⁶ + 3A₂θ² + A₁) )
  y  = θ·(A₁ + A₂θ² + θ⁶·(A₃ + A₄θ²))            // = A₄θ⁹+A₃θ⁷+A₂θ³+A₁θ

■ 화면 좌표(= 구운 path 와 같은 좌표계)로 옮기는 식
  xMax = x(λ=π, φ=0)  = 2.706629984
  yTop = y(φ=84°)     = 1.306713139
  k    = 1000 / (2·xMax) = 184.731567673        // canonical 폭을 1000 으로 고정
  X = (x + xMax) · k                            // 0 … 1000
  Y = (yTop − y) · k                            // 0 … 437.369   (y 아래로 증가)
  세로 범위는 위도 [-58, 84] → 높이 437.369, **가로세로비 2.2864 : 1**
  (-58 = 남극 전부 제외 + 칠레 최남단 -55.98 은 보존)

■ 그대로 쓰는 JS (구형 크롬 OK, var 만 씀)
```js
var A1=1.340264,A2=-0.081106,A3=0.000893,A4=0.003796,
    S3=Math.sqrt(3)/2, T3=2*Math.sqrt(3),
    XMAX=2.706629984, YTOP=1.306713139, KK=184.731567673;
/* 경위도 -> world_path.json 의 viewBox 좌표 (1000 x 437.369) */
function project(lon,lat){
  var lam=lon*Math.PI/180, phi=lat*Math.PI/180;
  var th=Math.asin(S3*Math.sin(phi));
  var t2=th*th, t6=t2*t2*t2, t8=t6*t2;
  var x=T3*lam*Math.cos(th)/(3*(9*A4*t8+7*A3*t6+3*A2*t2+A1));
  var y=th*(A1+A2*t2+t6*(A3+A4*t2));
  return [(x+XMAX)*KK, (YTOP-y)*KK];
}
```
■ 실측 대조 (파이썬 빌더 vs 위 JS, 15개 지점)
  (0,0)→500.0000,241.3912   (±180,0)→1000/0   (0,84)→500,0.0000   (0,-58)→500,437.3685
  한국(127.7622,36.4024)→821.3382,110.0996    인도(79.5,22.5)→712.7582,158.3326
  **최대 차 0.000e+00.** 두 구현이 마지막 자리까지 같다.

================================================================
4. centroids.json — 217/217, 누락 0. 몇 개가 비어 있었는지 보고
================================================================
■ gavinr 데이터에 **아예 없던 나라 = 4개** (직접 채웠다)
    HKG 홍콩        [114.150, 22.350]
    MAC 마카오      [113.550, 22.170]
    XKX 코소보      [ 20.903, 42.603]   ← 웹 검색으로 지리 중심 확인
    CHI 채널제도    [ -2.360, 49.370]   ← 저지(-2.13,49.21)·건지(-2.58,49.46) 중간
■ ISO2 중복 3건 (BQ·ES·TF). **ES 가 'Canarias' 로 덮여 있었다** — 스페인 점이 아프리카 앞바다에
   찍히는 버그. COUNTRY==COUNTRYAFF 인 본토 feature 만 남기도록 고쳤다.
■ 110m 육지 폴리곤으로 **217개 전부 점-in-폴리곤 판정**해서 바다에 빠진 것을 잡았다.
   처음 45개 실패(출생비중 합 1.839%) → 큰 것 6개를 손으로 고쳐 **40개 / 0.096%** 로 내렸다.
     PHL 필리핀   시부얀해 → 루손 중부 [121.0, 15.3]   (1.39%p 개선, 단일 최대)
     HTI 아이티   고나브만 → [-72.4, 19.0]
     CUB 쿠바     바타바노만 → [-79.0, 21.9]
     GRC 그리스   에게해 → 테살리아 [22.2, 39.6]
     FIN 핀란드   보트니아만 → 내륙 [26.0, 63.5]
     BHS 바하마   (110m 에 도형 없음. 그대로 둠)
■ 남은 40개는 **버그가 아니다** — 110m 해상도에 육지 도형이 없는 소도서국이다(몰디브·몰타·바레인·
   코모로·투발루…). 실제로 바다 한가운데 있는 나라라 점이 바다에 찍히는 게 지리적으로 맞다.
   **33명 뽑았을 때 그런 점이 한 개라도 나올 확률 = 3.12%**, 나와도 포커스 카드가 이름을 대 준다.
   (map_extra.json 의 `sea` 배열에 40개 iso3 가 들어 있다. 그 점 밑에 반지름 3u 짜리 육지색 원을
    깔면 "섬"처럼 보이게 할 수 있지만, 안 해도 무방하다고 본다.)
■ 사람 사는 쪽으로 옮긴 것 (기하중심이 오독을 부르는 경우만) :
   IDN 자바 · MYS 말레이반도 · CHN 111/33.5(고원 대신 인구 쪽) · RUS 75/58(무인 툰드라 98.7E 대신)
   FRA/ESP/PRT/NLD/DNK/USA/ECU/CHL/NOR 본토 (해외영토 때문에 중심이 바다로 가는 것 방지)
   FJI 비티레부(날짜변경선 회피) · GRL/CAN/AUS/IND/BRA/ARG 등 시각 중심
■ 최종 검증: cards.json 217 iso3 == centroids.json 키 집합, lon∈[-180,180] lat∈[-58,84] 전원 통과.

================================================================
5. 점이 겹치는 문제 — 실제 확률부터
================================================================
■ 20만 회 시뮬레이션 (33명, 출생아 가중)
   한 나라 최다 중복 :  3개 6.1% · 4개 16.5% · **5개 21.2% · 6개 19.4%** · 7개 15.1% · 8개 10.2%
                        9개 6.0% · 10개 3.0% · 11개 1.3% · 12개 0.5% · (13+ 0.2%)
                        → **중앙값 6, 78%가 7개 이하, 99.2%가 11개 이하**
   서로 다른 나라 수  :  평균 21.2개 (하위 5% = 17개, 범위 11~31)
   인도 개수(이항)    :  기대 5.79개, 5개 17.8% / 6개 17.7% / 7개 14.5%
■ 세 안 비교
 (가) 겹친 수만큼 원을 키운다 (r ∝ √n)
      + 화면이 깔끔하다. 면적이 정직하게 수를 나타낸다.
      − **1장=1명이 깨진다.** 카드 6장이 원 1개가 되면 "카드를 누르면 점이 찍힌다"(교사 요구)가
        성립을 안 한다. 6번째 학생을 눌러도 이미 있던 원이 조금 커질 뿐이다.
      − 큰 원이 "큰 나라 / 중요한 나라"로 읽힐 여지가 있다. BRIEF 의 시각 속성 매핑 금지에 걸린다.
      − n=1 대 n=6 의 반지름 비가 2.45 뿐이라 뒤에서 구별이 안 된다.
 (나) 살짝 흩뜨린다 ← **채택**
      + 점 하나 = 사람 하나가 끝까지 유지된다. 카드↔점이 1:1 이라 연출·클릭·되짚기가 전부 자연스럽다.
      + **뭉친 덩어리 자체가 메시지다.** 인도에 점 12개가 쌓인 그림이 "17.55%"라는 숫자보다 세다.
      + 어떤 국가 속성도 시각 속성에 매핑되지 않는다 — 크기·색·모양 전부 33개가 동일하다.
      − 무작위 지터는 지저분하다 → **해바라기(피보나치) 배치로 결정론적으로** 놓는다. 무작위 아님.
      − 작은 나라에서 국경 밖으로 조금 넘친다 → 국경을 안 그리므로 육안으로 오류가 아니다.
 (다) 숫자를 쓴다
      + 정확하다.
      − 8~10m 에서 숫자를 읽히려면 28px 이상이 필요하고, 33개 라벨이 지도를 덮는다.
      − 감정적인 그림이 표로 바뀐다. 이 3분짜리 훅에서 가장 큰 손해다.
   → **(나) 채택.** 정확한 수는 하단 한 줄("33명 중 12명이 인도")이 말한다. 지도는 그림만 한다.

■ 배치식 (해바라기 / 피보나치)
```js
var GA = Math.PI*(3-Math.sqrt(5));   // 2.39996 rad = 137.508°
var SPACING = 12.26;                 // canonical unit (= 22.8px @1920)
function slot(i){                    // i = 그 나라의 몇 번째 점인가 (0부터)
  if(i===0) return [0,0];            // 첫 점은 정확히 중심좌표 위
  var r = SPACING*Math.sqrt(i), a = i*GA;
  return [r*Math.cos(a), r*Math.sin(a)];
}
/* 최종 좌표 */
var p = project(CEN[iso][0], CEN[iso][1]);
var s = slot(k);                     // k = seen[iso]++
var X = p[0]+s[0], Y = p[1]+s[1];    // canonical
```
  성질: 중심→첫 링 거리 = SPACING 이 최소 이웃거리다. 점 지름 20px, 간격 22.8px → **틈 2.8px**.
  뭉치 반지름 R(k) = SPACING·√(k−1) :
     k=6 → 27.4u = 51px (지름 102px)   k=8 → 32.4u = 60px (지름 120px)
     k=12 → 40.7u = 76px (지름 151px)
  인도는 화면상 약 117×130px 이므로 **k=8(누적 79%)까지 나라 안에 정확히 들어가고**,
  k=12(0.5%)에서만 아라비아해·벵골만으로 조금 넘친다 — 실제로 렌더해서 확인했고, 넘치는 그림이
  오히려 "남아시아가 미어터진다"로 읽힌다.
  ※ map_extra.json 의 `rmax`(나라별 안전 반경)를 써서 SPACING 을 조일 수도 있지만 **쓰지 말길 권한다.**
    국경을 안 그리므로 조일 이유가 없고, 조이면 점이 서로 붙어 개수가 안 세어진다.

■ 인접국 주의 (실측, canonical → @1920 px)
   가나↔베냉 21px, 코트디부아르↔가나 22px, 우간다↔케냐 29px, 튀르키예↔시리아 29px …
   **점 하나(20px)보다 나라 사이가 가까운 경우가 있다.** 즉 지도만 보고 어느 나라 점인지 특정하는 건
   원래 불가능하고, 그럴 필요도 없다. 특정은 하단 캡션과 포커스 카드가 한다. 지도는 분포만 말한다.

================================================================
6. 색 — "색은 사람에게만 쓴다"
================================================================
■ 규칙 한 줄: **지도에는 유채색이 없다. 주황은 사람 점에만 붙는다.**
   국가별 채색 0, 대륙별 채색 0, 소득·기대수명·지역 매핑 0, 국경선 0(도형 자체가 없다).
   나이지리아 위 육지와 일본 위 육지는 픽셀 단위로 같은 색이다.

■ 어두운 모드 (기본, TV) — WCAG 상대휘도로 직접 계산
   --sea    #0D0F14   = 페이지 배경 그대로. **바다를 따로 칠하지 않는다.** 육지가 배경 위에 뜬다.
   --land   #333B4C   바다 대비 **1.71 : 1**
   --coast  #454E63   0.6px 스트로크. 바다 대비 2.30 : 1 (해안선이 또렷해진다)
   --grat   #232A36   적도 0.8px (선택. 없어도 됨)
   점       #FF8A5B   육지 대비 **4.83 : 1**, 바다 대비 **8.25 : 1**
   점 테    box-shadow 0 0 0 .18rem var(--bg)  ← 대비용이 아니라 **이웃 점 분리용**
   한국 점  #FFC46B (기존 --gold). 카드가 이미 금색이라 지도도 맞춘다. 등급이 아니라 "여기가 우리"
■ 밝은 모드 (빔, html[data-light])
   --sea #E8E2D6(=paper) / --land #A79E8B (paper 대비 2.05:1) / --coast #8C8371
   점 #E4622F 는 밝은 모드에서 **육지와 휘도가 거의 같다(1.30:1)** — 실측으로 잡았다.
   → 점에 반드시 케이싱을 준다:  box-shadow: 0 0 0 .20rem var(--bg), 0 0 0 .34rem #3A3D46
     (종이색 후광 + 어두운 테. 테가 대비를 책임진다. 렌더해서 확인함)
   한국 점 #B8801E
■ 함정 하나 (실측으로 잡음)
   미니맵처럼 지도를 상자 안에 넣을 때 **상자 배경색을 따로 주면 안 된다.** Equal Earth 는 좌우가
   곡선이라 네 귀퉁이가 지도 밖인데, 거기 다른 색이 깔리면 밝은 모드에서 검은 쐐기가 생긴다.
   → `frame` path 를 --sea 로 칠하고, 상자 배경은 **그 상자가 얹힌 패널 색과 같게** 둔다.

================================================================
7. (가) 전체 화면 지도 — 레이아웃 실측 (헤드리스 크롬 3해상도)
================================================================
기존 규약 유지: :root{font-size:min(100vw/192, 100vh/108)} → 1rem = 10px @1920×1080
```
header      6.4rem  ( 64px)   기존 헤더 그대로 재사용
#mapwrap   85.1rem  (851px)   flex:1
  #mapbox 186rem × 81.35rem  (1860 × 813.5px)  ← 2.2864:1, 세로 여유 37.5px 는 가운데 정렬
#rail      16.5rem  (165px)
────────────────────────── 합 108rem = 1080px  정확
```
실측 (window 1920/1536/1366, viewport 1902×984 / 1518×768 / 1348×672):
  rootPx 9.111 / 7.111 / 6.222   mapAspect **2.28641 / 2.28642 / 2.28643** (설계값 2.28640)
  noScroll **true** 3종 전부. 1920×1080 환산: mapbox 1860.0×813.5, rail 165, chip 51×56, dot 19→20px

SVG 구조 (레이어 4개, 그림자·필터·그라디언트 0):
```html
<div id="mapbox">
  <svg id="wmap" viewBox="0 0 1000 437.369" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <path class="wm-sea"  d="{frame}"/>                        <!-- 바다=배경색. 세계 경계 -->
    <path class="wm-grat" d="{equator}"/>                      <!-- 선택 -->
    <path class="wm-land" d="{land}" fill-rule="evenodd"/>     <!-- evenodd 필수: 카스피해 구멍 -->
  </svg>
  <div id="dots"></div>                                        <!-- 점은 HTML div -->
</div>
```
**점을 SVG circle 이 아니라 HTML div 로 두는 이유**: 애니메이션이 transform/opacity 만으로
컴포지터 스레드에서 처리되어 레이아웃 0·페인트 0 이 된다(기존 animation.md 예산과 동일 원리).
SVG 요소 CSS transform 은 구형 크롬·RDP 에서 승격이 보장되지 않는다.

canonical → rem 변환 (배율이 바뀌어도 자동으로 맞는다):
```js
var VW=1000, VH=437.369, MAPW=186, MAPH=81.35;      /* rem */
function toRem(p){ return [ p[0]*MAPW/VW, p[1]*MAPH/VH ]; }   /* 0.186 / 0.18601 */
el.style.left = x + 'rem';  el.style.top = y + 'rem';
```
점 CSS:
```css
#dots{position:absolute;inset:0;pointer-events:none}
.dot{position:absolute;width:2rem;height:2rem;margin:-1rem 0 0 -1rem;border-radius:50%;
  background:var(--accent);box-shadow:0 0 0 .18rem var(--bg);
  opacity:0;transform:scale(.25);
  transition:opacity .2s ease, transform .42s cubic-bezier(.18,.89,.3,1.12)}
.dot.on{opacity:1;transform:none}          /* 1.12 오버슛 = 기존 카드와 같은 곡선 */
.dot.done{transition:none!important;opacity:1!important;transform:none!important}  /* 백그라운드탭 안전판 */
.dot.kr{background:var(--gold)}
html[data-light] .dot{box-shadow:0 0 0 .2rem var(--bg),0 0 0 .34rem #3A3D46}
@media (prefers-reduced-motion:reduce){ .dot{transition:none} }
```
점 크기 근거 (readability.md 와 같은 방법, θ = 높이mm/거리mm × 3437.75):
  20px @86″/10m = 19.8mm → **6.8′**,  @65″/10m = 15.0mm → **5.2′**  (스넬렌 1.0 판별한계 5′ 초과)
  12개 뭉치 지름 151px @86″/10m = 150mm → **51.5′** — 어느 자리에서든 덩어리는 그냥 보인다.
  18px 도 86″ 이상이면 충분(6.1′)하지만 65″ 최악조건에서 4.6′ 로 미달해 **20px 로 올렸다.**

하단 레일 (165px):
```
캡션  5.6rem(56px)  "12번 김서연 → 나이지리아   기대수명 54.5세"
                     국가명 4.6rem(46px) = 카드 국가명과 같은 급 → 86″@10m 11.3′
칩 33개 6.2rem(62px)  grid-template-columns:repeat(33,minmax(0,1fr)); gap .55rem
                     실측 칩 51×56px, 번호 1.9rem. **칩은 교사 손가락용이지 뒷자리 판독용이 아니다.**
```

================================================================
8. (나) 미니맵 — 4가지 안을 실제로 렌더해 비교했다
================================================================
비교 시트: data/_agent_scratch/map/mini_test.html (대한민국·니제르·말라위·아이티·라오스·피지·
나이지리아·인도 8개국 × 4조건)

 A. 세계 전체 + 십자 조준선, 360×157px  ← **채택**
 B. 3.4배 확대(조준선 없음), 같은 치수    → **탈락.** 니제르·말라위가 정체불명 덩어리가 되고
                                            피지는 텅 빈 바다의 점 하나가 된다. 확대는
                                            **정작 도움이 필요한 작은 나라에서 가장 나쁘다.**
 C. 200×87px 로 축소                      → 조준선 덕에 **여전히 읽힌다.** 하한선 확인.
 D. 밝은 모드                             → 상자 배경색 때문에 검은 쐐기 발생 → 6절 함정 참조

■ 확정안
  치수  **36rem × 15.74rem (360 × 157.4px)**, 비율 2.2864 고정
  위치  포커스 카드 `.fname` 줄 오른쪽 끝 (`margin-left:auto`). 카드가 약 60px 커진다.
  구성  frame(바다) + land, 그리고 **십자 조준선 2줄 + 점 1개**.
  조준선이 핵심이다. 360px 폭에서 한국은 1.5px 짜리 반도지만, 좌우 끝까지 뻗은 선 두 줄이
  "가로로 여기, 세로로 여기"를 말해 주기 때문에 나라 모양을 못 봐도 위치가 확정된다.
  확대·팬·애니메이션 전부 없다. 정지 그림 하나다.
```html
<div class="mini">
  <svg viewBox="0 0 1000 437.369" preserveAspectRatio="xMidYMid meet">
    <path class="wm-sea" d="{frame}"/><path class="wm-land" d="{land}" fill-rule="evenodd"/>
  </svg>
  <i class="ch"></i><i class="cv"></i><i class="md"></i>
</div>
```
```css
.mini{position:relative;width:36rem;height:15.74rem;flex:0 0 auto;border-radius:1.1rem;
  overflow:hidden;background:var(--card);border:.15rem solid var(--edge)}   /* ← 패널색과 동일 */
.mini svg{position:absolute;inset:0;width:100%;height:100%;display:block}
.mini .wm-sea{fill:var(--card)}  .mini .wm-land{fill:#3A4356;stroke:none}
html[data-light] .mini .wm-land{fill:#B5AC99}
.ch{position:absolute;left:0;right:0;height:.15rem;background:rgba(255,138,91,.45)}
.cv{position:absolute;top:0;bottom:0;width:.15rem;background:rgba(255,138,91,.45)}
.md{position:absolute;width:1.4rem;height:1.4rem;margin:-.7rem 0 0 -.7rem;border-radius:50%;
  background:var(--accent);box-shadow:0 0 0 .3rem var(--card),0 0 0 .85rem rgba(255,138,91,.28)}
```
```js
function setMini(iso){
  var p = project(CEN[iso][0], CEN[iso][1]);
  var xp = p[0]/1000*100 + '%', yp = p[1]/437.369*100 + '%';
  md.style.left = cv.style.left = xp;
  md.style.top  = ch.style.top  = yp;
}
```
※ **%를 쓰기 때문에 미니맵 크기를 바꿔도 코드가 그대로다.** 200×87 까지 내려가도 동작 확인.

================================================================
9. 동선 — 지도는 상시 표시하지 않는다 (4번째 화면)
================================================================
■ 왜 상시 표시가 아닌가
  현재 그리드는 5열×7행, 카드 360.8×116px, 국가명 46px 이고 이게 layout.md 의 가독성 예산 전부다.
  지도(최소 1860×813)를 같은 화면에 넣으려면 그리드를 40% 이하로 줄여야 하고, 그러면 국가명이
  46→28px 로 떨어져 **86″ 교실에서 국가명을 못 읽는다.** 훅의 본체를 죽이고 지도를 얻는 거래다.
  → 지도는 카드가 할 일을 끝낸 뒤 들어오는 **다음 박자**여야 한다.

■ 화면 상태 (기존 #intro/#veil 과 같은 오버레이 패턴, position:absolute; inset:6.4rem 0 0)
```
[1] INTRO ──[태어나기]──▶ [2] DEAL 카드 33장 3.44초 ──▶ [3] TALLY 푸터 확정(+450ms)
                                                            │
                                          [지도로] / Space ─┤
                                                            ▼
                                                       [4] MAP  ★ 새 화면
                                            ├ [모두 찍기] / Space : 33개 90ms 스태거 = 3.4초
                                            ├ 칩 n 클릭 / ←→     : 그 학생 점 하나 + 캡션
                                            ├ 점·칩 클릭(놓인 것) : FOCUS(미니맵 포함)
                                            ├ [카드로] / Esc      : [3] 으로
                                            └ [베일 덮기]        : [5] VEIL (기존)
```
■ MAP 진입 연출 — "카드가 점이 된다" (교사 요구의 강한 버전)
   1. [지도로] 누르는 순간, 그리드의 33장 위치를 `getBoundingClientRect()` 로 **먼저 기록**한다.
   2. 그리드 opacity 1→0 (300ms) 와 동시에 MAP 레이어 0→1 (300ms). 지도만 남는다. 점은 아직 0개.
   3. t=380ms 부터 점이 하나씩 **기록해 둔 카드 자리에서 출발해** 제 나라로 날아간다.
      스태거 55ms × 33 = 1.82s + 비행 520ms = **총 2.34초.**
      transform: translate(dx,dy) scale(1.5) → translate(0,0) scale(1), opacity 0→1. 그게 전부다.
```js
/* 카드 자리 기록 → 지도 좌표와의 차이를 CSS 변수로 심고 클래스만 붙인다 */
var box = mapbox.getBoundingClientRect();
dots.forEach(function(d,i){
  var r = cardRects[i];                       // 2단계 전에 기록해 둔 카드 중심
  var t = d.getBoundingClientRect();          // 점의 최종 자리 (이미 left/top 이 세팅됨)
  d.style.setProperty('--fx', (r.cx - (t.left+t.width/2)) + 'px');
  d.style.setProperty('--fy', (r.cy - (t.top +t.height/2)) + 'px');
});
/* CSS */
.dot{transform:translate(var(--fx,0),var(--fy,0)) scale(1.5);opacity:0}
.dot.on{transform:none;opacity:1;
  transition:transform .52s cubic-bezier(.2,.86,.28,1.1) var(--d,0s), opacity .3s ease var(--d,0s)}
```
   ※ 이게 끝나면 카드↔점 대응이 한 번 각인된다. 그 다음부터 칩은 그 관계를 다시 짚는 도구다.

■ MAP 기본 상태는 **점 0개**다. 미리 다 찍힌 지도로 시작하지 않는다.
   빈 지도가 차오르는 게 교실에서 훨씬 세고, "누르면 찍힌다"가 문자 그대로 성립한다.
   (진입 연출을 건너뛰고 싶으면 [지도로] 를 길게 누르거나 Shift-클릭 → 빈 지도로 바로.)

■ 안전판 (animation.md 규약 그대로 승계)
   - `draw()`·상태전환 진입 즉시 `timers.forEach(clearTimeout)` — 연타 시 옛 타이머와 섞이는 버그 방지
   - 각 점에 `setTimeout(add 'done', d+900)` 백업. 백그라운드 탭에서 애니메이션이 멎어도 점은 남는다
   - `저사양` 버튼 : 스태거 90→35ms, transition 0.01s → 총 1.2초
   - `prefers-reduced-motion: reduce` 자동 존중

■ 키보드
   Space  MAP 에서 = 모두 찍기 (다 찍혔으면 아무 일 없음)
   → ←    한 명씩 찍기 / 되돌리기
   M      지도 ↔ 카드 토글
   Esc    포커스 닫기 → 다시 Esc 면 카드로
   (전부 화면의 버튼으로도 있어야 한다 — readability.md 의 "키보드 단축키가 아니라 눈에 보이는 버튼")

================================================================
10. 기존 파일에 붙이는 법 (build.py / template.html)
================================================================
build.py 의 parts 에 3줄 추가:
```python
    ('__WORLD__',  open('data/assets/world_path.json',  encoding='utf-8').read()),
    ('__CENT__',   open('data/assets/centroids.json',   encoding='utf-8').read()),
    # map_extra 는 선택. 안 쓰면 넣지 않는다.
```
template.html 의 <script> 안:
```js
const WORLD = __WORLD__;      // {viewBox, land, frame, equator, consts…}
const CEN   = __CENT__;       // {"IND":[79.5,22.5], …} 217개
```
path 는 JS 에서 심는다(HTML 에 직접 박지 않아도 된다):
```js
wmap.innerHTML =
  '<path class="wm-sea" d="'+WORLD.frame+'"/>'+
  '<path class="wm-grat" d="'+WORLD.equator+'"/>'+
  '<path class="wm-land" fill-rule="evenodd" d="'+WORLD.land+'"/>';
wmap.setAttribute('viewBox', WORLD.viewBox.join(' '));
```
용량 영향: 1.93MB → 약 1.96MB (**+1.9%**). 외부 요청 0건 유지.

================================================================
11. 그대로 쓸 수 있는 핵심 JS (작동 확인 완료)
================================================================
```js
/* ---- 1. 투영 (3절과 동일) ---- */
var A1=1.340264,A2=-0.081106,A3=0.000893,A4=0.003796,
    S3=Math.sqrt(3)/2,T3=2*Math.sqrt(3),XMAX=2.706629984,YTOP=1.306713139,KK=184.731567673;
function project(lon,lat){
  var lam=lon*Math.PI/180,phi=lat*Math.PI/180,th=Math.asin(S3*Math.sin(phi));
  var t2=th*th,t6=t2*t2*t2,t8=t6*t2;
  return [(T3*lam*Math.cos(th)/(3*(9*A4*t8+7*A3*t6+3*A2*t2+A1))+XMAX)*KK,
          (YTOP-th*(A1+A2*t2+t6*(A3+A4*t2)))*KK];
}
/* ---- 2. 33명 -> 점 좌표 (rem) ---- */
var VW=1000, VH=437.369, MAPW=186, MAPH=81.35;
var GA=Math.PI*(3-Math.sqrt(5)), SPACING=12.26;
function layout(picks){                 // picks = [{no,name,iso}, ...] 33개, 출석번호 순
  var seen={}, out=[];
  for(var i=0;i<picks.length;i++){
    var iso=picks[i].iso, k=seen[iso]||0; seen[iso]=k+1;
    var b=project(CEN[iso][0],CEN[iso][1]);
    var dx=0,dy=0;
    if(k){ var r=SPACING*Math.sqrt(k), a=k*GA; dx=r*Math.cos(a); dy=r*Math.sin(a); }
    out.push({ x:(b[0]+dx)*MAPW/VW, y:(b[1]+dy)*MAPH/VH, iso:iso, k:k });  // rem
  }
  return out;
}
/* ---- 3. DOM 만들기 ---- */
function buildDots(picks){
  var pos=layout(picks), h='';
  for(var i=0;i<pos.length;i++)
    h+='<i class="dot'+(pos[i].iso==='KOR'?' kr':'')+'" data-i="'+i+'" '+
       'style="left:'+pos[i].x.toFixed(3)+'rem;top:'+pos[i].y.toFixed(3)+'rem"></i>';
  document.getElementById('dots').innerHTML=h;
}
/* ---- 4. 한 명 찍기 ---- */
var timers=[];
function place(i){
  var d=document.querySelectorAll('#dots .dot')[i];
  d.classList.add('on');
  timers.push(setTimeout(function(){ d.classList.add('done'); }, 900));
  document.querySelectorAll('#chips .chip')[i].classList.add('on');
  var p=picks[i];
  cap.innerHTML='<span class="no">'+p.no+'번</span><span class="nm">'+esc(p.name)+'</span>'+
                '<span class="ar">→</span>'+esc(KO[p.iso])+
                '<span class="sub">기대수명 '+p.life+'세</span>';
}
/* ---- 5. 전부 찍기 ---- */
function placeAll(){
  timers.forEach(clearTimeout); timers=[];
  for(var i=0;i<picks.length;i++)
    (function(i){ timers.push(setTimeout(function(){place(i);}, i*90)); })(i);
}
```
빌더 재실행:  `python3 data/_agent_scratch/map/build_map.py 0.30 1.5`
              (첫 인자 = DP 톨러런스, 둘째 = 최소 링 면적. 더 가볍게 하려면 0.55 1.5 → 25KB)

## 화면 문구
- 33명이 어디서 태어났는지
- Where they were born
- 번호를 누르면 그 학생이 지도에 찍힙니다
- 모두 찍기
- 지우기
- 지도로
- 카드로
- 12번 김서연 → 나이지리아
- 기대수명 54.5세
- 33명 중 12명이 인도에서 태어났습니다
- 서로 다른 나라 13개
- 지도에는 나라 이름도, 국경도 없습니다. 점 하나가 사람 한 명입니다.
- 아무도 여기를 고르지 않았습니다
- Nobody chose this.

## 주의
- 세계지도는 정치적 산물이다. Natural Earth 110m 의 국경/영토 표기(카슈미르·서사하라·크림 등)를 그대로 쓴다면 논쟁이 붙을 수 있는데, **objects.land(국경 없는 육지 실루엣)만 쓰기 때문에 이 문제가 원천적으로 사라진다.** 국경선을 그리자는 요구가 나오면 반드시 거절할 것 — BRIEF 방침(체제·정치 논쟁으로 새면 수업이 죽는다)과도 직결된다.
- 110m 해상도에 육지 도형이 없는 소도서국 40개(몰디브·몰타·바레인·코모로·투발루 등)는 점이 바다 위에 찍힌다. 지리적으로는 맞지만 화면에서는 오류처럼 보인다. **33명 뽑을 때 한 개라도 나올 확률 3.12%**, 출생비중 합 0.096%. 신경 쓰이면 map_extra.json 의 `sea` 배열을 읽어 그 점 밑에 반지름 3u 짜리 --land 색 원을 깔면 된다(6줄).
- 지도만 보고 어느 나라 점인지 특정할 수 없다. 가나-베냉 21px, 코트디부아르-가나 22px 로 점 지름(20px)보다 가까운 인접국 쌍이 여럿이다. 이건 세계지도의 물리적 한계지 설계 결함이 아니다 — 특정은 하단 캡션과 포커스 카드가 한다. 다만 교사가 '이 점이 어느 나라예요?'라는 질문을 받을 수 있으니, 칩을 누르면 캡션에 나라 이름이 뜬다는 걸 진행안에 적어 두면 좋다.
- 중심좌표는 '그 나라를 가리키는 표식'이지 '태어난 지점'이 아니다. 인구가 한쪽에 몰린 나라(인도네시아→자바, 말레이시아→반도, 중국→동부, 러시아→서시베리아)는 판독성을 위해 손으로 옮겼다. 학생이 '왜 인도네시아 점이 자바에 있어요?'라고 물으면 답할 근거는 있지만, 교사 진행안에 굳이 쓸 필요는 없다.
- 한국 점을 금색(--gold)으로 한 것은 기존 카드가 이미 금색을 쓰기 때문에 맞춘 것이다. 지시하신 '액센트는 #FF8A5B 하나' 원칙을 엄격히 지키려면 한국 점도 주황으로 하고 점선 링(border-style:dashed 대응)만 다르게 하면 된다. 다만 20px 원에 점선 링은 8~10m 에서 안 보인다 — 색이 아니면 사실상 구별 수단이 없다는 점은 알고 결정해야 한다.
- 지도 화면이 하나 늘면 3~5분 예산에 약 40~60초가 추가된다(진입 연출 2.3초 + 모두 찍기 3.4초 + 교사 멘트). BRIEF 의 '단계 없음, 화면 하나' 원칙과 정면으로 부딪히지는 않지만(지도는 결과를 다시 보는 것이지 새 활동이 아니다), 시간이 빡빡하면 지도를 건너뛸 수 있게 [지도로] 버튼을 선택적으로 두고 베일로 바로 갈 수 있어야 한다.
- map_extra.json 의 `rmax`(나라별 점 흩뜨리기 안전반경)는 계산해서 넣어 뒀지만 **쓰지 말라고 권한다.** 인도네시아·베트남처럼 남북으로 좁은 나라에서 3.0 까지 떨어져 점이 서로 겹쳐 버린다. 국경을 안 그리는 지도에서 '나라 밖으로 나가면 안 된다'는 제약은 애초에 필요 없다.
- 빌드 중 실제로 두 개의 버그를 스크린샷으로 잡아 고쳤다 — (1) Douglas–Peucker 후반부 인덱스를 원본 배열에 잘못 넣어 대서양을 가로지르는 삼각형이 생김, (2) 러시아 추코트카·피지가 날짜변경선을 넘어 화면을 가로지르는 직선 두 줄이 생김. 빌더를 다른 데이터로 재실행할 일이 있으면 **반드시 렌더해서 눈으로 확인**할 것. 두 버그 다 콘솔 에러 없이 조용히 그림만 망가진다.