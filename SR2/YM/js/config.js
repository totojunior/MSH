/* YM — 접속 설정
 *
 * 이 파일은 반드시 저장소에 함께 올라가야 한다.
 * GitHub Pages 에는 빌드 단계도 환경변수도 없다. 이 파일을 .gitignore 에
 * 넣으면 배포된 사이트에서 404 가 나고, 학생들은 새까만 화면만 본다.
 * 교사 노트북에서는 멀쩡히 돌기 때문에 원인을 찾는 데 한나절이 걸린다.
 *
 * anon(publishable) 키는 숨기는 키가 아니다. 브라우저에 실려 나가도록
 * 설계된 공개 키이고, 실제 방어선은 데이터베이스의 RLS 와 RPC 다.
 * 반대로 service_role / sb_secret_ 키는 RLS 를 통째로 무시하므로
 * 이 파일에 절대 들어와서는 안 된다. supabase-client.js 가 키를 검사해서
 * 그런 키가 들어오면 앱을 아예 켜지 않는다.
 *
 * 올리기 전 확인:  git grep -nE 'service_role|sb_secret_'
 */
window.YM = window.YM || {};

YM.CONFIG = {
  SUPABASE_URL: 'https://dydudomjpxihksrjjxlq.supabase.co',

  // 새 형식(publishable). 실시간 웹소켓에서 문제가 생기면 아래 레거시 키로
  // 바꿔 끼운다 — 둘 다 같은 프로젝트의 공개 키다.
  SUPABASE_KEY: 'sb_publishable_X_zOlc1XxtPoPR1HSC2WcA_RTn-tICv',

  // 예비용 레거시 anon JWT. SUPABASE_KEY 를 이 값으로 교체하면 된다.
  SUPABASE_KEY_LEGACY:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR5ZHVkb21qcHhpaGtzcmpqeGxxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk2MDg2NjIsImV4cCI6MjEwNTE4NDY2Mn0.f8kX18A8VgwY-Sz5urcl1MX4YdK7voayQm-Rk3WR6Vw',

  // 반별 방 코드. seed-rooms.sql 이 만드는 것과 같아야 한다.
  ROOMS: ['YM2-1','YM2-2','YM2-3','YM2-4','YM2-5','YM2-6',
          'YM2-7','YM2-8','YM2-9','YM2-10','YM2-11','YM2-TEST'],

  // 아래 숫자들은 화면 표시와 클라이언트 검사용 사본이다.
  // 진짜 규칙은 전부 데이터베이스에 있다 — 여기를 개발자도구로 고쳐도
  // 서버가 거절하므로 아무 일도 일어나지 않는다.
  FACE_VALUE: 20000,
  OPENING_MIN: 20000,
  OPENING_MAX: 50000,
  OPENING_STEP: 10000,

  // 재접속·시계 보정 관련
  SNAPSHOT_HEARTBEAT_MS: 10000,   // 조용해도 10초마다 한 번은 진실을 다시 묻는다
  POLL_FALLBACK_MS: 1500,         // 웹소켓이 죽었을 때의 대체 주기
  SUBSCRIBE_TIMEOUT_MS: 5000,     // 이 시간 안에 구독이 안 붙으면 폴링으로 전환
  SETTLE_POLL_MS: 2000,           // 프로젝터·조종석이 정산을 재촉하는 주기
  CLOCK_SAMPLES: 5,               // 서버 시계 표본 수 (RTT 상위 2개는 버린다)
};
