-- =====================================================================
--  YM 설치 — 이 파일 하나만 복사해서 Supabase SQL Editor 에 붙여넣고 Run
-- =====================================================================
--  외부지문 2 · 4차시 — Selling Yosemite (용산 IMAX 교실 시뮬레이션)
--  두 번 돌려도 안전하다. 이 파일 뒤에 seed-rooms.sql 을 한 번만 돌린다.
-- =====================================================================



-- #####################################################################
-- ##  schema.sql
-- #####################################################################

-- =====================================================================
-- YM (외부지문 2 · 4차시 — Selling Yosemite) — 테이블 정의
-- =====================================================================
-- 실행 순서: schema.sql -> functions.sql -> policies.sql
--
-- 이 활동만 서버를 쓴다. 저장소 CLAUDE.md 는 "서버도 DB도 로그인도 없다"
-- 고 못 박아 두었지만, 실시간 멀티플레이는 서버 없이 불가능하다.
-- 대신 개인정보 규칙은 그대로 지킨다 — 실명·학번·점수를 저장하지 않고,
-- 닉네임은 서버가 배정하며, 투표에는 시각조차 기록하지 않는다.
-- 자세한 근거는 docs/00-아키텍처-예외.md.
--
-- 테이블을 "무엇에 대한 것이냐"가 아니라 "누가 볼 수 있느냐"로 나눈 것이
-- 이 스키마의 핵심이다. 학생 33명이 전부 같은 anon 키를 쓰기 때문에
-- auth.uid() 가 NULL 이고, "자기 지갑만 본다" 같은 정책을 쓸 수가 없다.
-- 그래서 공개 테이블 3개(rooms_public / seats / listings)만 열고
-- 나머지는 정책도 권한도 0으로 잠근 뒤 RPC 반환값으로만 내보낸다.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- rev — 클라이언트 재접속 시 스냅샷과 실시간 이벤트의 순서를 맞추는 열쇠
-- ---------------------------------------------------------------------
-- 학생이 새로고침하면 (1) 채널을 먼저 구독하고 (2) 스냅샷을 받는다.
-- 그 사이에 도착한 이벤트를 버릴지 적용할지 판단할 기준이 필요하다.
-- 전역 시퀀스 하나로 모든 공개 행에 단조증가 번호를 박아 두면
-- "스냅샷의 max_rev 보다 큰 이벤트만 재생"으로 끝난다.
create sequence if not exists public.ym_rev_seq;

create or replace function public.ym_bump_rev()
returns trigger
language plpgsql
as $$
begin
  new.rev := nextval('public.ym_rev_seq');
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- rooms_public — 반 하나 = 방 하나. 공개.
-- ---------------------------------------------------------------------
-- 관리자 토큰은 여기 두지 않는다. 학생이 이 테이블을 실시간 구독하므로
-- 토큰 해시가 한 칸이라도 섞이면 교실 전체에 흘러나간다. room_secrets 로 분리.
create table if not exists public.rooms_public (
  id                  uuid primary key default gen_random_uuid(),
  room_code           text        not null unique,
  generation          int         not null default 1,

  -- lobby / booking / prevote / decide / budget / auction / results / yosemite
  phase               text        not null default 'lobby',

  join_open           boolean     not null default false,
  dry_run             boolean     not null default false,

  max_players         int         not null default 45,
  player_count        int         not null default 0,

  face_value          int         not null default 20000,
  seat_count          int,                              -- LOCK ROSTER 시점에 한 번만 확정
  seat_rows           text[]      not null default array['J','K','L','M'],

  -- 단발 가드용 타임스탬프. 전부 "IS NULL 일 때만 UPDATE" 로 잠근다.
  -- 교사가 버튼을 두 번 눌러도 두 번째는 조용히 no-op 이 된다.
  roster_frozen_at    timestamptz,
  wealth_distributed_at timestamptz,
  auction_started_at  timestamptz,
  results_computed_at timestamptz,

  -- 각 단계의 서버 기준 마감. 클라이언트 시계는 절대 믿지 않는다.
  booking_opens_at    timestamptz,
  booking_ends_at     timestamptz,
  prevote_ends_at     timestamptz,
  decide_ends_at      timestamptz,
  budget_ends_at      timestamptz,
  auction_ends_at     timestamptz,                      -- 화면 표시용 상한. 실제 마감은 listings.ends_at
  postvote_ends_at    timestamptz,
  finalvote_ends_at   timestamptz,

  auction_seconds     int         not null default 60,

  -- 한 사람이 경매로 가져갈 수 있는 좌석 수 상한. NULL = 무제한이고 그게 기본값이다.
  -- 교사가 요구한 동작은 '무제한' 이다 — 돈이 많으면 여러 개 살 수 있어야
  -- '경매는 가장 원하는 사람이 아니라 가장 돈 많은 사람에게 준다' 가 보인다.
  -- 이 칸은 11개 반 중 한 반이 뒤집혀 한 명이 좌석을 쓸어가고 교실 절반이
  -- 20분간 구경꾼이 되는 상황에서만 쓰는 손잡이다. SQL 편집기에서 한 줄:
  --   update public.rooms_public set max_seats_per_bidder = 3 where room_code = 'YM2-1';
  -- 다시 풀 때는 같은 줄에 null 을 넣는다. 조종석은 admin_state 가 room 을
  -- to_jsonb 로 통째로 내보내므로 코드를 고치지 않아도 현재 값을 받는다.
  max_seats_per_bidder int,

  -- {"pre":{"yes":0,"no":0,"unsure":0}, "post":{...}, "q1_movie":{...}, ...}
  -- 투표는 잠긴 테이블에 넣고, 화면에는 이 집계 숫자만 보여준다.
  vote_counts         jsonb       not null default '{}'::jsonb,

  -- P4 에서 한 번 계산해 굳힌다. 매번 다시 집계하면 화면마다 숫자가 달라진다.
  results             jsonb,

  expires_at          timestamptz not null default (now() + interval '30 days'),
  created_at          timestamptz not null default now(),
  rev                 bigint      not null default 0,

  constraint rooms_phase_ck check (phase in
    ('lobby','booking','prevote','decide','budget','auction','results','yosemite')),
  constraint rooms_face_ck  check (face_value > 0),
  constraint rooms_seat_ck  check (seat_count is null or seat_count > 0),
  constraint rooms_max_ck   check (max_players between 1 and 60)
);

-- 이미 깔린 프로젝트에 이 파일을 다시 부을 때를 위한 보강.
-- create table if not exists 는 표가 있으면 컬럼을 더해 주지 않는다.
alter table public.rooms_public
  add column if not exists max_seats_per_bidder int;

drop trigger if exists rooms_public_rev on public.rooms_public;
create trigger rooms_public_rev before insert or update on public.rooms_public
  for each row execute function public.ym_bump_rev();

-- ---------------------------------------------------------------------
-- room_secrets — 관리자 토큰 해시. 정책도 권한도 없다.
-- ---------------------------------------------------------------------
-- 컬럼 단위 GRANT 로 가리지 않고 테이블을 통째로 분리한 이유:
-- 컬럼 권한은 PostgREST 의 select=* 를 깨뜨리고, 논리 복제(Realtime)는
-- 컬럼 권한을 아예 무시한다. 테이블을 나누는 쪽만 실제로 안전하다.
create table if not exists public.room_secrets (
  room_id           uuid primary key references public.rooms_public(id) on delete cascade,
  admin_token_hash  bytea not null
);

-- ---------------------------------------------------------------------
-- players — 잠금. 닉네임은 서버가 배정한다.
-- ---------------------------------------------------------------------
create table if not exists public.players (
  id                    uuid primary key default gen_random_uuid(),
  room_id               uuid not null references public.rooms_public(id) on delete cascade,
  nickname              text not null,
  is_bot                boolean not null default false,
  is_house              boolean not null default false,   -- 기기 없는 학생용 교사 대리 계정
  kicked                boolean not null default false,
  -- 연속 탭/자동 클릭 스크립트를 스스로 느려지게 만드는 쿨다운.
  -- 실패할 때마다 400ms 뒤로 밀리므로, 빨리 두드릴수록 손해다.
  next_claim_allowed_at timestamptz,
  joined_at             timestamptz not null default now(),
  constraint players_nick_uq unique (room_id, nickname)
);

create index if not exists players_room_idx on public.players(room_id);

create table if not exists public.player_secrets (
  player_id   uuid primary key references public.players(id) on delete cascade,
  token_hash  bytea not null
);

-- ---------------------------------------------------------------------
-- wallets — 잠금. 실시간으로 절대 흘리지 않는다.
-- ---------------------------------------------------------------------
-- P3A 공개 전에 남의 예산이 보이면 연출이 통째로 죽는다.
-- 학생은 오직 get_my_state() 의 반환값으로만 자기 잔액을 본다.
create table if not exists public.wallets (
  player_id     uuid primary key references public.players(id) on delete cascade,
  room_id       uuid not null references public.rooms_public(id) on delete cascade,
  initial       int  not null default 0,   -- 추첨으로 받은 예산 (좌석 대금 제외)
  balance       int  not null default 0,
  -- 잔액은 0 에서 시작한다. P3A 예산 배정 전까지 아무도 돈이 없다.
  -- (한때 참가 시점에 액면가를 쥐여 주는 설계였으나, 좌석을 못 잡은 학생의
  --  잔액이 그만큼 부풀어 P4 의 'PRICED OUT' 이 늘 0 으로 나왔다.
  --  액면가는 표시용 개념으로만 두고 지갑에서 뺐다.)
  seeded        boolean not null default false,
  constraint wallet_nonneg check (balance >= 0)
);

create index if not exists wallets_room_idx on public.wallets(room_id);

-- ---------------------------------------------------------------------
-- seats — 공개. 실시간 구독 대상.
-- ---------------------------------------------------------------------
-- 좌석에는 등급이 없다. 전부 같은 값이다.
-- 좋은 자리를 만들면 (1) 자동 클릭 스크립트가 이득을 보고
-- (2) 뒤풀이 토론이 "쟤가 반칙했어"로 샌다. 시장 이야기를 하려면
-- 자리 값이 아니라 '희소성'만 남겨야 한다.
create table if not exists public.seats (
  id                uuid primary key default gen_random_uuid(),
  room_id           uuid not null references public.rooms_public(id) on delete cascade,
  row_label         text not null,
  seat_no           int  not null,
  seat_label        text not null,                       -- 'K12'
  current_owner_id  uuid references public.players(id) on delete set null,
  claimed_at        timestamptz,
  -- 이 좌석을 '어떻게' 얻었나. 'booking' = 예매로 잡았다, 'auction' = 낙찰받았다.
  -- 이 한 칸이 "예매는 1인 1석, 경매는 여러 개" 를 표 차원에서 갈라 준다.
  -- 아래 부분 유일 인덱스가 이 값으로 셈에 넣을 좌석을 고른다.
  acquired_via      text not null default 'booking',
  rev               bigint not null default 0,
  constraint seats_room_label_uq unique (room_id, row_label, seat_no),
  constraint seats_via_ck        check (acquired_via in ('booking','auction'))
);

-- 이미 깔린 프로젝트에 이 파일을 다시 부을 때를 위한 보강. 세 줄이 순서대로
-- 컬럼 · 검사 · 의미를 맞춘다. (PG11+ 는 기본값 있는 NOT NULL 컬럼 추가도
-- 메타데이터만 바꾸므로 13행짜리 표에서는 즉시 끝난다.)
alter table public.seats add column if not exists acquired_via text not null default 'booking';

do $$
begin
  -- conrelid 까지 짚는다. 이름만 보면 다른 표의 같은 이름에 속아 건너뛴다.
  if not exists (select 1 from pg_constraint
                  where conname = 'seats_via_ck'
                    and conrelid = 'public.seats'::regclass) then
    alter table public.seats add constraint seats_via_ck
      check (acquired_via in ('booking','auction'));
  end if;
end $$;

-- 과거 수업에서 이미 낙찰된 좌석을 'auction' 으로 되돌린다. 없어도 아래
-- 인덱스는 통과하지만(옛 제약이 1인 1석을 지켜 왔으므로), 의미를 맞춰 두지
-- 않으면 나중 검증 쿼리가 거짓말을 한다.
-- to_regclass 로 감싼 이유: 이 파일에서 listings 는 seats '뒤에' 만들어진다.
-- 새로 설치하는 프로젝트에서는 아직 없는 표를 읽게 되므로 그냥 넘긴다.
do $$
begin
  if to_regclass('public.listings') is not null then
    update public.seats s
       set acquired_via = 'auction'
      from public.listings l
     where l.seat_id = s.id
       and l.status = 'sold'
       and s.current_owner_id is not null
       and s.current_owner_id = l.highest_bidder_id
       and s.acquired_via <> 'auction';
  end if;
end $$;

-- 인덱스를 만들기 '전에' 사람이 읽을 수 있는 말로 끊는다. 여기서 raise 가
-- 나면 원인이 한 줄로 보이고, 통째로 붙여넣어 한 번에 실행한 경우 설치
-- 전체가 취소된다 — 반쯤 바뀐 채 남는 것보다 아무것도 안 바뀐 편이 낫다.
-- 백필 '뒤' 에 오는 것이 중요하다: 다석 낙찰이 한 번이라도 일어난 뒤에는
-- 한 학생이 좌석을 여러 개 갖는 것이 정상이고, 그중 예매 좌석만 하나여야
-- 한다. 그래서 세는 대상이 '예매 좌석' 이다 (이 파일을 두 번 부어도 통과한다).
do $$
declare v int;
begin
  select count(*) into v from (
    select 1 from public.seats
     where current_owner_id is not null and acquired_via = 'booking'
     group by room_id, current_owner_id having count(*) > 1) x;
  if v > 0 then
    raise exception '예매 좌석을 두 개 이상 가진 학생이 % 명 있습니다. 먼저 확인이 필요합니다.', v;
  end if;
end $$;

-- 예매는 1인 1석, 경매는 여러 개.
--
-- 왜 CONSTRAINT 가 아니라 부분 인덱스인가: 옛 제약(seats_one_per_player)은
-- 좌석이 손을 바꾸는 정산 한 문장 '안' 에서 유일성이 순간 깨지기 때문에
-- SET CONSTRAINTS ... DEFERRED 가 필요했다. 새 술어에서는 정산의 UPDATE 가
-- 좌석을 술어 '밖' 으로 내보낸다('booking' -> 'auction'). 술어를 만족하지
-- 않는 새 행 버전은 인덱스에 항목을 만들지 않고, 삽입이 없으면 충돌도 없다.
-- 그래서 지연이 필요 없고, 부분 인덱스는 애초에 지연이 불가능하다는 사실도
-- 문제가 되지 않는다. (정산에서 acquired_via 를 빠뜨리면 그 순간 배치 전체가
-- unique_violation 으로 롤백된다 — 그것만 조심하면 된다.)
--
-- WHERE 절 검사로 대신하지 않는 이유는 옛 주석과 같다: 한 학생의 두 요청이
-- 서로 '다른' 좌석을 동시에 집으면 두 트랜잭션이 서로 다른 행을 건드리므로
-- 행 잠금도 EvalPlanQual 도 걸리지 않고, 두 WHERE 가 각자의 문장 스냅샷에서
-- 나란히 통과한다. 최후의 그물은 인덱스뿐이다.
create unique index if not exists seats_one_booking_per_player
  on public.seats (room_id, current_owner_id)
  where current_owner_id is not null and acquired_via = 'booking';

-- 옛 그물은 새 그물을 건 '뒤에' 뗀다. 한 트랜잭션이라 논리적 차이는 없지만,
-- 사람이 파일을 읽을 때 의도가 드러난다.
alter table public.seats drop constraint if exists seats_one_per_player;

create index if not exists seats_room_idx on public.seats(room_id);

drop trigger if exists seats_rev on public.seats;
create trigger seats_rev before insert or update on public.seats
  for each row execute function public.ym_bump_rev();

-- ---------------------------------------------------------------------
-- listings — 공개. 경매 매물.
-- ---------------------------------------------------------------------
-- 파는 쪽이 매물을 올려도 좌석 소유권은 그대로다. 안 팔리면 그냥 자기 것으로 남는다.
create table if not exists public.listings (
  id                uuid primary key default gen_random_uuid(),
  room_id           uuid not null references public.rooms_public(id) on delete cascade,
  seat_id           uuid not null unique references public.seats(id) on delete cascade,
  seller_id         uuid not null references public.players(id) on delete cascade,
  seat_label        text not null,
  opening_bid       int  not null,
  highest_bid       int,
  highest_bidder_id uuid references public.players(id) on delete set null,
  -- need_money / wants_more / my_seat / free_trade — P4 의 익명 사유 벽에 쓴다.
  -- 시장 편을 드는 논거를 사이트가 대신 말하지 않고 학생 입에서 나오게 하는 장치.
  reason_code       text,
  status            text not null default 'pending',     -- pending/open/sold/unsold
  ends_at           timestamptz,
  settled_at        timestamptz,
  final_price       int,
  created_at        timestamptz not null default now(),
  rev               bigint not null default 0,
  constraint listings_status_ck check (status in ('pending','open','sold','unsold','withdrawn')),
  constraint listings_open_ck   check (opening_bid > 0)
);

-- 한 사람이 동시에 여러 매물의 최고입찰자가 될 수 있다.
--
-- 예전에는 여기에 listings_one_lead_per_bidder 부분 유일 인덱스가 있었고,
-- "한 사람은 한 매물만 선두" 였다. 그 인덱스는 다석 낙찰을 막는 장치이면서
-- 동시에 초과 지출 방어선 '전부' 였다 — 선두 매물이 하나뿐이면
-- 'p_amount <= balance' 한 줄로 회계가 닫혔기 때문이다. 떼면 그 회계가
-- 통째로 사라진다. 그 자리를 대신하는 것이 place_bid 의 약정 규칙이다:
--
--   이번 입찰액 + (이번 매물을 뺀) 내가 선두인 열린 매물들의 합 <= 내 잔액
--
-- 약정은 어디에도 저장하지 않는다. listings.highest_bidder_id / highest_bid
-- 에서 매번 유도하므로, 남이 내 선두를 빼앗는 순간 셈에서 저절로 빠진다.
-- 풀어 주는 코드도, 보상 트랜잭션도, 크론도 없다 — 이 프로젝트에는
-- 스케줄러가 없으니(정적 사이트) 그게 유일하게 성립하는 설계다.
drop index if exists public.listings_one_lead_per_bidder;

create index if not exists listings_room_idx  on public.listings(room_id);
create index if not exists listings_open_idx  on public.listings(room_id, status, ends_at);

drop trigger if exists listings_rev on public.listings;
create trigger listings_rev before insert or update on public.listings
  for each row execute function public.ym_bump_rev();

-- ---------------------------------------------------------------------
-- bids — 잠금. 어떤 클라이언트도 구독하지 않는다.
-- ---------------------------------------------------------------------
-- 프로젝터의 입찰 티커는 이 테이블을 구독하는 게 아니라 place_bid 안에서
-- Broadcast 로 쏜다. 구독자마다 RLS 를 평가하는 비용을 통째로 건너뛴다.
create table if not exists public.bids (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid not null references public.rooms_public(id) on delete cascade,
  listing_id  uuid not null references public.listings(id) on delete cascade,
  bidder_id   uuid not null references public.players(id) on delete cascade,
  amount      int  not null,
  created_at  timestamptz not null default now()
);

create index if not exists bids_listing_idx on public.bids(listing_id);
create index if not exists bids_room_idx    on public.bids(room_id);

-- ---------------------------------------------------------------------
-- votes — 잠금. 시각을 저장하지 않는다.
-- ---------------------------------------------------------------------
-- created_at 이 있으면 "좌석을 언제 잡았나"와 대조해서 누가 뭘 골랐는지
-- 역추적할 수 있다. 교사에게 "선생님도 못 봅니다"라고 말하려면
-- 실제로 못 보게 만들어 두어야 한다.
create table if not exists public.votes (
  room_id   uuid not null references public.rooms_public(id) on delete cascade,
  question  text not null,
  player_id uuid not null references public.players(id) on delete cascade,
  choice    text not null,
  primary key (room_id, question, player_id),
  constraint votes_q_ck      check (question in ('pre','post','q1_movie','q2_campsite','q3_upfront')),
  constraint votes_choice_ck check (choice in ('yes','no','unsure'))
);

-- ---------------------------------------------------------------------
-- room_results — 잠금. 반별 비교용으로 교사만 뽑아 간다.
-- ---------------------------------------------------------------------
create table if not exists public.room_results (
  room_id    uuid primary key references public.rooms_public(id) on delete cascade,
  payload    jsonb not null,
  created_at timestamptz not null default now()
);



-- #####################################################################
-- ##  functions.sql
-- #####################################################################

-- =====================================================================
-- YM — RPC 함수. 게임의 모든 규칙이 여기 있다.
-- =====================================================================
-- 클라이언트는 테이블을 절대 직접 쓰지 않는다. 학생이 개발자도구를 열어
-- 무엇을 하든, 바꿀 수 있는 것은 "어떤 RPC 를 언제 부를까" 뿐이다.
--
-- 모든 함수는 SECURITY DEFINER + search_path='' 이고 식별자를 전부
-- 스키마로 한정한다. 오버로드와 기본값 인자는 쓰지 않는다 —
-- supabase-js 는 인자 '이름'으로 함수를 찾기 때문에, 오버로드가 있으면
-- "could not choose the best candidate function" 이라는, 원인을 알 수
-- 없는 에러가 난다.
-- =====================================================================

alter default privileges in schema public revoke execute on functions from public;

-- ---------------------------------------------------------------------
-- 시계
-- ---------------------------------------------------------------------
-- now() 가 아니라 clock_timestamp() 다. now() 는 '트랜잭션 시작 시각'이라
-- 경매 막판에 10ms 단위로 다투는 상황에서 틀린 답을 준다.
create or replace function public.server_now()
returns timestamptz
language sql stable security definer set search_path = ''
as $$ select clock_timestamp() $$;

-- ---------------------------------------------------------------------
-- 인증
-- ---------------------------------------------------------------------
-- 없는 학생과 토큰이 틀린 학생을 구분해서 알려주지 않는다. 둘 다 NULL.
create or replace function public._auth_player(p_room_code text, p_player uuid, p_token text)
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare v_id uuid;
begin
  select p.id into v_id
    from public.players p
    join public.rooms_public r on r.id = p.room_id
    join public.player_secrets s on s.player_id = p.id
   where p.id = p_player
     and r.room_code = p_room_code
     and r.expires_at > clock_timestamp()
     and p.kicked = false
     and s.token_hash = extensions.digest(p_token, 'sha256');
  return v_id;
end;
$$;

-- 아래 두 함수는 이 파일 맨 끝의 '05-교사키.sql' 구간이 한 번 더 교체한다.
-- 순서가 중요해서 그렇게 두었다: 새 판정부는 teacher_secrets 표를 읽는데
-- 그 표는 맨 끝 구간에서 만들어진다. 여기 있는 것이 반별 토큰 전용 원본이고,
-- 맨 끝 구간이 '반별 토큰 또는 교사 키' 판정으로 바꿔 놓는다.
create or replace function public._auth_admin(p_room_code text, p_admin_token text)
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare v_room uuid;
begin
  select r.id into v_room
    from public.rooms_public r
    join public.room_secrets s on s.room_id = r.id
   where r.room_code = p_room_code
     and s.admin_token_hash = extensions.digest(p_admin_token, 'sha256');
  return v_room;
end;
$$;

-- 교사용 RPC 스물몇 개가 전부 이 두 인자를 이름으로 넘기고 uuid 를 받는다.
-- 인자 이름도 반환형도 바꾸지 않는다 — 바꾸는 순간 create or replace 가
-- 아니라 drop 이 필요해지고, 스물몇 개가 동시에 깨진다.
-- 판정 로직은 _auth_admin 한 곳에만 있고, 이 함수는 NULL 을 42501 로
-- 바꾸는 껍데기다. 그래서 교사 키를 더할 때도 고칠 곳이 한 군데뿐이다.
create or replace function public._require_admin(p_room_code text, p_admin_token text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_room uuid;
begin
  v_room := public._auth_admin(p_room_code, p_admin_token);
  if v_room is null then
    -- 실패는 언제나 같은 메시지, 같은 errcode 다.
    -- "그런 방 없음"과 "키 틀림"을 구분해 주면 대입 공격이 절반으로 줄어든다.
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  return v_room;
end;
$$;

-- ---------------------------------------------------------------------
-- 입찰 단위 — 계단식
-- ---------------------------------------------------------------------
-- ₩10,000 고정으로는 60초 안에 15만원까지 못 간다. 금액이 커질수록
-- 보폭을 키워서, 5번쯤 주고받으면 액면가의 7배에 닿게 만든다.
create or replace function public._increment_for(p_current int)
returns int
language sql immutable security definer set search_path = ''
as $$
  select case
    when p_current <  50000 then 10000
    when p_current < 100000 then 20000
    else 50000
  end;
$$;

create or replace function public._min_bid(p_opening int, p_highest int)
returns int
language sql immutable security definer set search_path = ''
as $$
  select case
    when p_highest is null then p_opening
    else p_highest + public._increment_for(p_highest)
  end;
$$;

-- ---------------------------------------------------------------------
-- 닉네임 — 서버가 배정한다
-- ---------------------------------------------------------------------
-- 자유 입력을 없애면 욕설 필터, XSS, 실명 노출, 명예훼손 위험,
-- 프로젝터 가리기 토글이 한꺼번에 사라진다. 기능을 지워서 얻은 안전이다.
create or replace function public._nickname_for(p_idx int)
returns text
language sql immutable security definer set search_path = ''
as $$
  select coalesce(
    (array[
      'POPCORN FOX','NEON OWL','VELVET CROW','MIDNIGHT DEER','SODA TIGER',
      'PAPER WHALE','COBALT MOTH','AMBER LYNX','QUIET HERON','STATIC BEAR',
      'GLASS HARE','EMBER SEAL','INDIGO WOLF','SILENT KOI','COPPER FINCH',
      'ORBIT PANDA','DUSK OTTER','MARBLE IBIS','SCARLET YAK','LUNAR MOLE',
      'CINEMA CAT','TICKET MOOSE','AISLE SWAN','ROW J RAVEN','BALCONY BAT',
      'POPCORN ELK','SCREEN GOAT','CURTAIN FOX','MATINEE OX','ENCORE JAY',
      'PIXEL BISON','ECHO STORK','FROST MINK','VELVET WREN','CANDY VIPER',
      'NIGHT USHER','REEL RABBIT','SEAT 1 SWIFT','LATE ARRIVAL','FRONT ROW ANT',
      'SILVER SHREW','ONYX PONY','LEMON GULL','RUST BADGER','TIDAL NEWT'
    ])[p_idx],
    '관객 ' || to_char(p_idx, 'FM000')
  );
$$;


-- ---------------------------------------------------------------------
-- 별명 다듬기 — 학생이 직접 짓되, 교실에 띄울 수 있는 형태로만
-- ---------------------------------------------------------------------
-- 자유 입력을 허용하면 재미는 확실히 올라간다. 대신 세 가지를 서버에서 막는다.
--   (1) 길이   — 12자. 프로젝터와 좌석 카드가 무너지지 않는 한계.
--   (2) 제어문자·줄바꿈 — 화면을 깨뜨리는 문자를 아예 지운다.
--   (3) 욕설   — 아래 목록은 완전하지 않다. 완전할 수도 없다.
--                실제 방어선은 교사의 KICK 버튼이고, 이건 게으른 장난만 거른다.
-- XSS 는 여기서 막지 않는다. 화면 쪽이 전부 textContent 로만 그리기 때문에
-- '<script>' 라고 적으면 글자 그대로 '<script>' 가 보일 뿐이다.
create or replace function public._sanitize_nick(p_raw text)
returns text
language sql immutable security definer set search_path = ''
as $$
  -- POSIX 문자클래스만 쓴다. 백슬래시 이스케이프를 손으로 적으면
  -- 진짜 제어문자가 소스에 섞여 들어간다 (저장소 CLAUDE.md 6절의 그 사고).
  -- [:cntrl:] 가 개행·탭을, [:space:] 가 나머지 공백을 한 번에 받는다.
  select nullif(
    left(
      btrim(regexp_replace(coalesce(p_raw, ''), '[[:cntrl:][:space:]]+', ' ', 'g')),
      12),
    '');
$$;

create or replace function public._is_bad_nick(p_nick text)
returns boolean
language sql immutable security definer set search_path = ''
as $$
  select exists (
    select 1
      from unnest(array[
        '시발','씨발','씨팔','시팔','ㅅㅂ','병신','ㅂㅅ','좆','존나','지랄',
        '개새','새끼','썅','미친놈','미친년','창녀','боже',
        'fuck','shit','bitch','cunt','dick','pussy','asshole','nigg','rape',
        '자살','섹스','야동'
      ]) as bad
     where replace(lower(p_nick), ' ', '') like '%' || bad || '%'
  );
$$;

-- =====================================================================
-- 방 만들기 / 참가
-- =====================================================================

-- 관리자 토큰은 여기서 딱 한 번 평문으로 나간다. 이후로는 해시만 남는다.
create or replace function public.create_room(p_room_code text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_room  uuid;
  v_token text;
begin
  if p_room_code is null or length(trim(p_room_code)) < 3 then
    raise exception 'bad_room_code' using errcode = '22023';
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'base64');

  insert into public.rooms_public (room_code)
       values (upper(trim(p_room_code)))
    returning id into v_room;

  insert into public.room_secrets (room_id, admin_token_hash)
       values (v_room, extensions.digest(v_token, 'sha256'));

  return jsonb_build_object(
    'ok', true,
    'room_id', v_room,
    'room_code', upper(trim(p_room_code)),
    'admin_token', v_token,
    'server_now', clock_timestamp()
  );
exception
  when unique_violation then
    raise exception 'room_exists' using errcode = '23505';
end;
$$;

-- 인자가 하나였던 옛 판본이 남아 있으면 오버로드가 되어
-- supabase-js 가 "could not choose the best candidate function" 을 낸다.
drop function if exists public.join_room(text);

create or replace function public.join_room(p_room_code text, p_nickname text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_room   uuid;
  v_open   boolean;
  v_max    int;
  v_face   int;
  v_count  int;
  v_player uuid;
  v_nick   text;
  v_token  text;
  v_suffix int;
begin
  select r.id, r.join_open, r.max_players, r.face_value
    into v_room, v_open, v_max, v_face
    from public.rooms_public r
   where r.room_code = upper(trim(p_room_code))
     and r.expires_at > clock_timestamp();

  if v_room is null then
    return jsonb_build_object('ok', false, 'error', 'NO_ROOM');
  end if;

  -- 참가를 방 단위로 직렬화한다. 33명이 동시에 들어와도 닉네임 번호가
  -- 겹치지 않고 player_count 도 어긋나지 않는다. 참가는 1분에 33번뿐이라
  -- 이 정도 잠금은 비용이 아니다.
  perform pg_advisory_xact_lock(hashtextextended('ym:join:' || v_room::text, 0));

  if not v_open then
    return jsonb_build_object('ok', false, 'error', 'JOIN_CLOSED');
  end if;

  select count(*) into v_count from public.players p where p.room_id = v_room;
  if v_count >= v_max then
    return jsonb_build_object('ok', false, 'error', 'ROOM_FULL');
  end if;

  -- 학생이 적은 별명을 쓴다. 비었으면 목록에서 하나 골라 준다
  -- (수줍은 학생이 빈칸 앞에서 멈추지 않도록).
  v_nick := public._sanitize_nick(p_nickname);
  if v_nick is null then
    v_nick := public._nickname_for(v_count + 1);
  elsif public._is_bad_nick(v_nick) then
    -- 조용히 바꿔치기하지 않는다. 바뀐 줄 모르면 본인만 계속 헷갈린다.
    return jsonb_build_object('ok', false, 'error', 'BAD_NICK');
  end if;

  -- 같은 별명을 두 명이 고르면 뒤에 번호를 붙인다. 참가 자체를 막지 않는다.
  if exists (select 1 from public.players p
              where p.room_id = v_room and p.nickname = v_nick) then
    v_suffix := 2;
    while exists (select 1 from public.players p
                   where p.room_id = v_room
                     and p.nickname = left(v_nick, 10) || ' ' || v_suffix::text) loop
      v_suffix := v_suffix + 1;
    end loop;
    v_nick := left(v_nick, 10) || ' ' || v_suffix::text;
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'base64');

  insert into public.players (room_id, nickname)
       values (v_room, v_nick)
    returning id into v_player;

  insert into public.player_secrets (player_id, token_hash)
       values (v_player, extensions.digest(v_token, 'sha256'));

  -- 잔액 0 으로 시작한다. P3A 전까지 아무도 돈이 없다.
  insert into public.wallets (player_id, room_id, initial, balance, seeded)
       values (v_player, v_room, 0, 0, false);

  update public.rooms_public r
     set player_count = v_count + 1
   where r.id = v_room;

  return jsonb_build_object(
    'ok', true,
    'room_id', v_room,
    'player_id', v_player,
    'player_token', v_token,
    'nickname', v_nick,
    'server_now', clock_timestamp()
  );
end;
$$;

-- =====================================================================
-- 상태 스냅샷 — 학생의 비공개 정보는 오직 이 반환값으로만 나간다
-- =====================================================================
create or replace function public.get_my_state(p_room_code text, p_player uuid, p_token text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_me   uuid;
  v_room public.rooms_public%rowtype;
  v_out  jsonb;
begin
  v_me := public._auth_player(p_room_code, p_player, p_token);
  if v_me is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  select * into v_room from public.rooms_public where room_code = upper(trim(p_room_code));

  select jsonb_build_object(
    'ok', true,
    'server_now', clock_timestamp(),
    'max_rev', coalesce((
        select greatest(
          v_room.rev,
          coalesce((select max(s.rev) from public.seats s where s.room_id = v_room.id), 0),
          coalesce((select max(l.rev) from public.listings l where l.room_id = v_room.id), 0))
      ), 0),
    'room', jsonb_build_object(
        'id', v_room.id,
        'room_code', v_room.room_code,
        'phase', v_room.phase,
        'join_open', v_room.join_open,
        'dry_run', v_room.dry_run,
        'player_count', v_room.player_count,
        'face_value', v_room.face_value,
        'seat_count', v_room.seat_count,
        'seat_rows', v_room.seat_rows,
        'auction_seconds', v_room.auction_seconds,
        -- 보통은 null(무제한)이다. 교사가 한 반만 조였을 때 화면이
        -- '한 사람 최대 n석' 이라고 말할 수 있게 같이 내보낸다.
        'max_seats_per_bidder', v_room.max_seats_per_bidder,
        'booking_opens_at', v_room.booking_opens_at,
        'booking_ends_at', v_room.booking_ends_at,
        'prevote_ends_at', v_room.prevote_ends_at,
        'decide_ends_at', v_room.decide_ends_at,
        'budget_ends_at', v_room.budget_ends_at,
        'auction_ends_at', v_room.auction_ends_at,
        'postvote_ends_at', v_room.postvote_ends_at,
        'finalvote_ends_at', v_room.finalvote_ends_at,
        'vote_counts', v_room.vote_counts,
        'results', v_room.results
      ),
    'me', jsonb_build_object(
        'player_id', v_me,
        'nickname', (select p.nickname from public.players p where p.id = v_me),
        'balance',  (select w.balance  from public.wallets w where w.player_id = v_me),
        'initial',  (select w.initial  from public.wallets w where w.player_id = v_me),
        -- 좌석은 이제 복수다. 여기를 스칼라 서브쿼리로 두면 좌석이 두 개인
        -- 학생의 get_my_state 가 21000 (more than one row returned by a
        -- subquery used as an expression) 으로 죽는다. 이 함수는 학생 화면의
        -- 전부를 실어 오므로, 그 학생의 화면이 통째로 멈춘다 — 그것도
        -- 경매 도중에, 이 수업이 주인공으로 삼은 부자 학생부터.
        'my_seats', coalesce((
            select jsonb_agg(jsonb_build_object(
                     'id', s.id, 'label', s.seat_label,
                     'row', s.row_label, 'no', s.seat_no, 'via', s.acquired_via)
                   order by s.row_label, s.seat_no)
              from public.seats s
             where s.room_id = v_room.id and s.current_owner_id = v_me), '[]'::jsonb),
        'seat_count_mine', (select count(*)::int from public.seats s
                             where s.room_id = v_room.id and s.current_owner_id = v_me),
        -- 옛 화면 호환용 별칭. limit 1 이 없으면 여기서 다시 21000 이 난다.
        -- 이 셋(my_seat / my_listing / leading)을 남겨 두는 덕에 SQL 을 먼저
        -- 배포하고 JS 를 나중에 배포할 수 있다. GitHub Pages 의 HTML 캐시가
        -- 늦게 풀려 옛 화면이 한동안 남아도 교실이 멈추지 않는다.
        -- 반대 순서(JS 먼저)는 하지 마라 — 새 키가 아직 없다.
        'my_seat',  (select jsonb_build_object('id', s.id, 'label', s.seat_label)
                       from public.seats s
                      where s.room_id = v_room.id and s.current_owner_id = v_me
                      order by s.row_label, s.seat_no limit 1),
        'my_listings', coalesce((
            select jsonb_agg(jsonb_build_object(
                     'id', l.id, 'seat_label', l.seat_label, 'opening_bid', l.opening_bid,
                     'highest_bid', l.highest_bid, 'status', l.status,
                     'final_price', l.final_price, 'ends_at', l.ends_at)
                   order by l.seat_label)
              from public.listings l
             where l.room_id = v_room.id and l.seller_id = v_me), '[]'::jsonb),
        'my_listing', (select jsonb_build_object(
                          'id', l.id, 'seat_label', l.seat_label, 'opening_bid', l.opening_bid,
                          'highest_bid', l.highest_bid, 'status', l.status,
                          'final_price', l.final_price, 'ends_at', l.ends_at)
                         from public.listings l
                        where l.room_id = v_room.id and l.seller_id = v_me
                        order by l.seat_label limit 1),
        'leads', coalesce((
            select jsonb_agg(jsonb_build_object('listing_id', l.id,
                     'seat_label', l.seat_label, 'amount', l.highest_bid)
                   order by l.seat_label)
              from public.listings l
             where l.room_id = v_room.id and l.status = 'open'
               and l.highest_bidder_id = v_me), '[]'::jsonb),
        'leading',  (select jsonb_build_object('listing_id', l.id, 'seat_label', l.seat_label,
                                               'amount', l.highest_bid)
                       from public.listings l
                      where l.room_id = v_room.id and l.status = 'open'
                        and l.highest_bidder_id = v_me
                      order by l.seat_label limit 1),
        -- 걸어 둔 돈(약정)과 남은 돈. 화면은 balance 가 아니라 available 로
        -- 버튼을 그려야 한다. 그리고 학생에게는 두 숫자를 '글자로' 병기해야
        -- 한다 — 입찰해도 balance 는 줄지 않으므로, 버튼만 비활성되면
        -- 학생은 "돈이 사라졌다" 가 아니라 "고장났다" 로 읽는다.
        'committed', (select coalesce(sum(l.highest_bid), 0)::int from public.listings l
                       where l.room_id = v_room.id and l.status = 'open'
                         and l.highest_bidder_id = v_me),
        'available', greatest(
            coalesce((select w.balance from public.wallets w where w.player_id = v_me), 0)
            - (select coalesce(sum(l.highest_bid), 0)::int from public.listings l
                where l.room_id = v_room.id and l.status = 'open'
                  and l.highest_bidder_id = v_me), 0),
        'votes',    coalesce((select jsonb_object_agg(v.question, v.choice)
                                from public.votes v
                               where v.room_id = v_room.id and v.player_id = v_me), '{}'::jsonb),
        -- 예산 배정 전에는 '아직'과 '0원'을 구분해야 화면이 거짓말을 안 한다.
        'has_budget', v_room.wealth_distributed_at is not null
      ),
    'seats', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', s.id, 'label', s.seat_label, 'row', s.row_label, 'no', s.seat_no,
                 'taken', s.current_owner_id is not null,
                 'mine', s.current_owner_id = v_me)
               order by s.row_label, s.seat_no)
          from public.seats s where s.room_id = v_room.id), '[]'::jsonb),
    'listings', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', l.id, 'seat_label', l.seat_label, 'opening_bid', l.opening_bid,
                 'highest_bid', l.highest_bid, 'status', l.status, 'ends_at', l.ends_at,
                 'final_price', l.final_price, 'rev', l.rev,
                 'mine', l.seller_id = v_me,
                 'leading', l.highest_bidder_id = v_me)
               order by l.seat_label)
          from public.listings l
         where l.room_id = v_room.id and l.status not in ('pending','withdrawn')), '[]'::jsonb)
  ) into v_out;

  return v_out;
end;
$$;

-- =====================================================================
-- P1 — 좌석 잡기
-- =====================================================================
-- SELECT 로 확인하고 UPDATE 하면 그 사이에 남이 채 간다. 조건을 전부
-- UPDATE 의 WHERE 에 넣어서 한 문장으로 끝내야 정확히 한 명만 이긴다.
-- 진 사람에게는 실시간 이벤트를 기다리게 하지 않고 이 자리에서 바로 알려준다.
create or replace function public.claim_seat(p_room_code text, p_player uuid, p_token text, p_seat uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_me    uuid;
  v_room  public.rooms_public%rowtype;
  v_label text;
  v_face  int;
begin
  v_me := public._auth_player(p_room_code, p_player, p_token);
  if v_me is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  select * into v_room from public.rooms_public where room_code = upper(trim(p_room_code));
  v_face := v_room.face_value;

  -- 이미 내 좌석이면 성공으로 답한다. 와이파이가 끊겨 재시도한 경우
  -- "남이 먼저 잡았다"고 거짓말하면 안 된다.
  select s.seat_label into v_label
    from public.seats s where s.id = p_seat and s.current_owner_id = v_me;
  if v_label is not null then
    return jsonb_build_object('ok', true, 'already', true, 'seat_label', v_label);
  end if;

  if v_room.phase <> 'booking' then
    return jsonb_build_object('ok', false, 'error', 'NOT_OPEN');
  end if;

  -- 클라이언트가 보낸 시각은 절대 믿지 않는다.
  if v_room.booking_opens_at is null or clock_timestamp() < v_room.booking_opens_at then
    update public.players p
       set next_claim_allowed_at = greatest(clock_timestamp(), v_room.booking_opens_at)
                                   + interval '400 milliseconds'
     where p.id = v_me;
    return jsonb_build_object('ok', false, 'error', 'TOO_EARLY');
  end if;

  if v_room.booking_ends_at is not null and clock_timestamp() > v_room.booking_ends_at then
    return jsonb_build_object('ok', false, 'error', 'CLOSED');
  end if;

  -- 실패할 때마다 400ms 뒤로 밀린다. 20ms 간격으로 두드리는 스크립트는
  -- 스스로를 계속 T+400ms 로 미뤄 아무 이득을 못 본다.
  if exists (select 1 from public.players p
              where p.id = v_me and p.next_claim_allowed_at > clock_timestamp()) then
    return jsonb_build_object('ok', false, 'error', 'COOLDOWN');
  end if;

  begin
    update public.seats s
       set current_owner_id = v_me,
           claimed_at = clock_timestamp(),
           -- 예매로 얻은 좌석임을 못 박는다. 좌석은 명단 잠금 때 이미
           -- 'booking' 으로 태어나므로 평소에는 같은 값을 다시 쓰는 것이다.
           -- 그래도 적어 두는 이유: 낙찰됐던 좌석이 다시 빈 자리가 되는
           -- 경로가 생기면 그 좌석이 'auction' 인 채로 남아 1인 1석 셈에서
           -- 영영 빠진다. 한 줄로 그 구멍을 닫는다.
           acquired_via = 'booking'
     where s.id = p_seat
       and s.room_id = v_room.id
       and s.current_owner_id is null
       -- 예매에서는 한 사람 한 자리다. 출발선은 같아야 한다.
       -- (경매의 다석 허용은 이 조건을 통과한 '뒤' 의 이야기다.)
       and not exists (select 1 from public.seats t
                        where t.room_id = v_room.id and t.current_owner_id = v_me)
    returning s.seat_label into v_label;
  exception
    -- 내 두 요청이 같은 순간에 서로 '다른' 좌석을 집은 경우다. 두 트랜잭션이
    -- 서로 다른 행을 건드리므로 행 잠금도 EvalPlanQual 도 걸리지 않고,
    -- 위의 not exists 는 각자의 문장 스냅샷에서 평가돼 둘 다 통과한다.
    -- 최후의 그물은 seats_one_booking_per_player 인덱스다.
    -- (왕복 100ms 기기 33대가 20초 동안 두드리는 구간이다. 이 경합은
    --  '혹시' 가 아니라 반드시 일어난다.)
    when unique_violation then
      return jsonb_build_object('ok', false, 'error', 'ALREADY_HAVE_SEAT');
  end;

  if v_label is null then
    -- 0행의 이유가 둘이다. "남이 먼저 잡았다" 와 "내가 이미 가졌다" 를
    -- 구분해 줘야 학생이 화면 앞에서 헷갈리지 않는다.
    if exists (select 1 from public.seats t
                where t.room_id = v_room.id and t.current_owner_id = v_me) then
      return jsonb_build_object('ok', false, 'error', 'ALREADY_HAVE_SEAT');
    end if;
    update public.players p
       set next_claim_allowed_at = clock_timestamp() + interval '400 milliseconds'
     where p.id = v_me;
    return jsonb_build_object('ok', false, 'error', 'TAKEN');
  end if;

  -- 액면가는 지갑에서 빼지 않는다. 표시용 개념으로만 둔다 —
  -- 예전 판본은 여기서 차감했는데, 좌석을 못 잡은 학생의 잔액만 부풀어서
  -- P4 의 'PRICED OUT' 이 구조적으로 늘 0 이 되었다.
  return jsonb_build_object('ok', true, 'seat_label', v_label, 'face_value', v_face);
end;
$$;

-- =====================================================================
-- P2 — 가질까 팔까
-- =====================================================================
create or replace function public.submit_decision(
  p_room_code text, p_player uuid, p_token text,
  p_sell boolean, p_opening int, p_reason text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_me    uuid;
  v_room  public.rooms_public%rowtype;
  v_seat  uuid;
  v_label text;
begin
  v_me := public._auth_player(p_room_code, p_player, p_token);
  if v_me is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  select * into v_room from public.rooms_public where room_code = upper(trim(p_room_code));

  if v_room.phase <> 'decide' then
    return jsonb_build_object('ok', false, 'error', 'NOT_OPEN');
  end if;
  if v_room.decide_ends_at is not null and clock_timestamp() > v_room.decide_ends_at then
    return jsonb_build_object('ok', false, 'error', 'CLOSED');
  end if;

  -- 다석 보유자에게 '임의의 한 좌석' 을 고르지 않는다. 정렬 키가 전순서라서
  -- 같은 학생이 다시 눌러도 언제나 같은 좌석이 나온다.
  -- (경매가 끝난 뒤 교사가 admin_reopen_decide 를 누르면 좌석을 여러 개
  --  가진 학생이 이 경로에 들어올 수 있다. 그때 매물로 올라가는 것은
  --  좌석표 순서로 첫 좌석 하나다.)
  select s.id, s.seat_label into v_seat, v_label
    from public.seats s
   where s.room_id = v_room.id and s.current_owner_id = v_me
   order by s.row_label, s.seat_no
   limit 1;
  if v_seat is null then
    return jsonb_build_object('ok', false, 'error', 'NO_SEAT');
  end if;

  -- KEEP — 이미 올린 매물이 있으면 내린다. P2 안에서는 얼마든지 번복할 수 있다.
  if not p_sell then
    -- 행을 지우지 않는다. 발행 중인 테이블의 DELETE 이벤트는 RLS 를 무시하고
    -- room_id 로 걸러지지도 않아서, 구독자가 그 변화를 아예 못 본다.
    -- 상태만 바꾸면 평범한 UPDATE 로 정상 전달된다.
    update public.listings l set status = 'withdrawn'
     where l.seat_id = v_seat and l.status in ('pending','withdrawn');
    return jsonb_build_object('ok', true, 'sell', false);
  end if;

  -- 시작가는 ₩20,000~₩50,000 다섯 칸뿐이다. 헤드라인 숫자는 슬라이더로
  -- 끌어당기는 게 아니라 경매에서 벌어야 한다.
  if p_opening is null or p_opening < v_room.face_value or p_opening > 50000
     or (p_opening % 10000) <> 0 then
    return jsonb_build_object('ok', false, 'error', 'BAD_PRICE');
  end if;
  if p_reason is null or p_reason not in ('need_money','wants_more','my_seat','free_trade') then
    return jsonb_build_object('ok', false, 'error', 'BAD_REASON');
  end if;

  insert into public.listings (room_id, seat_id, seller_id, seat_label, opening_bid, reason_code, status)
       values (v_room.id, v_seat, v_me, v_label, p_opening, p_reason, 'pending')
  on conflict (seat_id) do update
       set opening_bid = excluded.opening_bid,
           reason_code = excluded.reason_code,
           status      = 'pending'
     where public.listings.status in ('pending','withdrawn');

  return jsonb_build_object('ok', true, 'sell', true, 'opening_bid', p_opening, 'seat_label', v_label);
end;
$$;

-- =====================================================================
-- P3B — 입찰
-- =====================================================================
create or replace function public.place_bid(
  p_room_code text, p_player uuid, p_token text, p_listing uuid, p_amount int)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_me      uuid;
  v_room    public.rooms_public%rowtype;
  v_row     public.listings%rowtype;
  v_bal     int;
  v_cmt     int;                  -- 약정: 지금 내가 선두인 '다른' 매물들의 합
  v_min     int;
  v_cap     timestamptz;
  v_newend  timestamptz;
  v_ext     boolean := false;
  v_won     int;                  -- 이미 낙찰받은 좌석 수. 상한이 걸린 반에서만 쓴다
begin
  v_me := public._auth_player(p_room_code, p_player, p_token);
  if v_me is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  select * into v_room from public.rooms_public where room_code = upper(trim(p_room_code));
  if v_room.phase <> 'auction' then
    return jsonb_build_object('ok', false, 'error', 'NOT_OPEN');
  end if;

  -- 같은 학생의 동시 요청을 한 줄로 세운다. 개발자도구에서 Promise.all 로
  -- 두 좌석에 동시에 지르거나, 통신이 느려 같은 버튼이 두 번 나가도
  -- 여기서 막힌다. 아래 약정 검사가 이 잠금 덕에 안전해진다.
  --
  -- 지갑 행을 FOR UPDATE 로 잡지 않는다. 정산은 listings 를 먼저 잠그고
  -- wallets 를 나중에 잠그는데, 입찰이 그 반대 순서로 잡으면 전형적인
  -- AB-BA 교착(40P01)이 된다. 탐지에 1초(기본 deadlock_timeout)가 걸리고,
  -- 그 1초가 마감 10초 전 연장 다툼 중일 수 있다. 다석을 허용하면 한
  -- 입찰자가 걸치는 매물 수와 한 배치가 건드리는 (매물, 지갑) 쌍이 늘어
  -- 창이 더 넓어진다. 잠금 대상을 플레이어 키로 옮기면 두 함수의 잠금
  -- 집합이 아예 겹치지 않는다 — place_bid 는 wallets 를 읽기만 하고
  -- 쓰지 않으므로 이렇게 바꿀 수 있다.
  -- 키 이름은 기존 관례를 따른다 (ym:join: / ym:settle:).
  perform pg_advisory_xact_lock(hashtextextended('ym:bid:' || v_me::text, 0));

  select w.balance into v_bal from public.wallets w where w.player_id = v_me;

  -- 약정(committed) — 지금 내가 선두인 '다른' 매물들의 highest_bid 합.
  -- 이 돈은 이미 걸려 있다. 어디에도 저장하지 않고 매번 여기서 유도한다.
  -- 저장하지 않으므로 "밀려날 때 풀어 주는" 코드가 존재하지 않는다.
  --
  -- clock_timestamp() 로 '마감된' 매물을 빼지 않는 것이 중요하다.
  -- 마감됐지만 아직 정산 전(status='open')인 매물의 돈은 곧 빠져나간다.
  -- 여기서 제외하면 정산 폴링 2초 사이에 같은 돈을 두 번 쓸 수 있고,
  -- 학생은 '낙찰됐다' 는 화면을 본 '뒤에' 그 좌석을 잃는다.
  select coalesce(sum(o.highest_bid), 0)::int into v_cmt
    from public.listings o
   where o.room_id = v_room.id
     and o.status = 'open'
     and o.highest_bidder_id = v_me
     and o.id <> p_listing;

  -- (좌석을 가진 사람의 입찰을 막던 HAVE_SEAT 검사는 사라졌다. 돈이 있으면
  --  좌석이 있어도 살 수 있고, 여러 개도 살 수 있다. 1인 1석 제한은
  --  '경매는 가장 원하는 사람이 아니라 가장 돈 많은 사람에게 준다' 는
  --  이 수업의 논점을 인공적으로 가리고 있었다.)

  -- 좌석 수 상한 — 기본값은 없다(NULL = 무제한). 교사가 rooms_public 의
  -- max_seats_per_bidder 에 값을 넣은 반에서만 동작한다. 이 사전 검사는
  -- '왜 안 되는지' 를 한국어로 돌려주기 위한 것이고, 실제 판정은 아래
  -- '이기는 UPDATE' 의 WHERE 안에 한 번 더 있다.
  if v_room.max_seats_per_bidder is not null then
    select count(*)::int into v_won
      from public.seats s
     where s.room_id = v_room.id and s.current_owner_id = v_me
       and s.acquired_via = 'auction';
    -- 선두인 매물도 이미 '가진 것' 으로 센다. 아래 UPDATE 의 WHERE 와 같은
    -- 식이어야 한국어 문구와 실제 판정이 어긋나지 않는다.
    v_won := v_won + (select count(*)::int from public.listings o3
                       where o3.room_id = v_room.id and o3.status = 'open'
                         and o3.highest_bidder_id = v_me and o3.id <> p_listing);
    if v_won >= v_room.max_seats_per_bidder then
      return jsonb_build_object('ok', false, 'error', 'SEAT_LIMIT',
                                'limit', v_room.max_seats_per_bidder, 'have', v_won);
    end if;
  end if;

  select * into v_row from public.listings l where l.id = p_listing and l.room_id = v_room.id;
  if v_row.id is null then
    return jsonb_build_object('ok', false, 'error', 'NO_LISTING');
  end if;
  if v_row.status <> 'open' or clock_timestamp() >= v_row.ends_at then
    return jsonb_build_object('ok', false, 'error', 'LISTING_CLOSED');
  end if;
  if v_row.seller_id = v_me then
    return jsonb_build_object('ok', false, 'error', 'OWN_LISTING');
  end if;
  if v_row.highest_bidder_id = v_me then
    return jsonb_build_object('ok', false, 'error', 'ALREADY_LEADING_THIS');
  end if;

  v_min := public._min_bid(v_row.opening_bid, v_row.highest_bid);
  if p_amount is null or p_amount < v_min then
    return jsonb_build_object('ok', false, 'error', 'TOO_LOW', 'min', v_min,
                              'current', v_row.highest_bid);
  end if;
  -- 잔액이 아니라 '약정을 뺀 가용액' 으로 판정한다. 예산 10만원인 학생이
  -- 6만·7만 두 곳에서 동시에 선두가 되는 것을 여기서 끊는다. 예전에는
  -- listings_one_lead_per_bidder 인덱스가 "한 사람 한 매물" 을 보장해서
  -- 'p_amount <= v_bal' 한 줄로 회계가 닫혔다. 그 인덱스는 이제 없다.
  if p_amount + v_cmt > v_bal then
    return jsonb_build_object('ok', false, 'error', 'NO_MONEY',
                              'balance', v_bal, 'committed', v_cmt,
                              'available', greatest(v_bal - v_cmt, 0));
  end if;

  -- 막판 입찰은 10초를 되돌려 준다. 안 그러면 55초는 침묵, 5초는 눈치싸움이 된다.
  -- 다만 무한 연장은 수업 시간을 먹으므로 시작 + 120초에서 자른다.
  v_cap := v_room.auction_started_at + (interval '1 second' * 120);
  v_newend := v_row.ends_at;
  if v_row.ends_at - clock_timestamp() < interval '10 seconds' then
    v_newend := least(clock_timestamp() + interval '10 seconds', v_cap);
    if v_newend > v_row.ends_at then v_ext := true; else v_newend := v_row.ends_at; end if;
  end if;

  -- 위의 검사들은 각각 자기 시점의 스냅샷에서 읽은 값이다. 그 사이에
  -- 정산 트랜잭션이 커밋되면 "잔액 이만큼" 과 "약정 이만큼" 이 둘 다 옛날
  -- 얘기가 된다. 그래서 회계 판정을 '이기는 UPDATE' 의 WHERE 안에서 다시
  -- 한다. 검사와 쓰기가 분리되면 33명이 동시에 누를 때 지갑이 음수가 된다.
  --
  -- 두 서브쿼리(약정 합계와 잔액)가 '한 문장 안' 에 있는 것이 핵심이다.
  -- 스냅샷이 하나이므로 찢어진 읽기가 불가능하다. 그리고 정산은 약정과
  -- 잔액을 같은 트랜잭션에서 같은 금액만큼 함께 줄이므로(매물이 open 에서
  -- 빠지면서 지갑에서 final_price 가 빠진다), 정산이 보이든 안 보이든
  -- 판정 결과가 같다 — 둘 다 등호로 통과한다.
  --
  -- 남이 나를 밀어내면 약정이 줄고, 내가 판 좌석 대금이 들어오면 잔액이
  -- 는다. 동시 변경은 전부 '보수적인' 방향이라 최악이 거짓 거절이고,
  -- 그건 다음 스냅샷에서 저절로 풀린다.
  update public.listings l
     set highest_bid = p_amount,
         highest_bidder_id = v_me,
         ends_at = v_newend
   where l.id = p_listing
     and l.room_id = v_room.id
     and l.status = 'open'
     and clock_timestamp() < l.ends_at
     and coalesce(l.highest_bid, 0) = coalesce(v_row.highest_bid, 0)   -- 낙관적 잠금
     -- 판 사람은 자기 매물에 못 지른다. 사전 검사가 이미 있지만 판정을
     -- 이기는 UPDATE 안에도 둔다. 비용은 0이고, 나중에 좌석 재배정 RPC 가
     -- 생겨도 무너지지 않는다. (기계적으로는 이제 무해해졌다 — 아래 정산의
     --  통합 원장에서 판 사람과 산 사람이 같으면 순 델타가 0이다. 그래도
     --  막는 이유는 회계가 아니라 경매의 의미다: 판 사람은 순 지출 0으로
     --  자기 매물 값을 올릴 수 있고, 그러면 결과 화면의 max_price 와
     --  multiple 이 가짜가 된다. 그 숫자가 지문의 배수와 같다고 말하려면
     --  금액이 '제2자의 실제 지불 의사' 여야 한다.)
     and l.seller_id <> v_me
     -- 회계 규칙: 이번 입찰액 + (이번 매물을 뺀) 약정 <= 내 잔액.
     -- o.id <> l.id 인 이유 둘: (1) 같은 매물의 옛 선두액을 중복으로 세지
     -- 않는다. (2) 나중에 '자기 선두액 올리기' 를 허용해도 이 식이 그대로
     -- 맞는다(증분만 검사하는 효과가 된다).
     -- sum(int) 은 bigint 다. ::int 캐스팅을 넣지 마라 — 이론상 오버플로
     -- 경로만 만든다. 비교 대상 int 는 알아서 승격된다.
     and p_amount + coalesce((select sum(o.highest_bid)
                                from public.listings o
                               where o.room_id = l.room_id
                                 and o.status = 'open'
                                 and o.highest_bidder_id = v_me
                                 and o.id <> l.id), 0)
         <= (select w.balance from public.wallets w where w.player_id = v_me)
     -- 좌석 수 상한. NULL(무제한)이면 이 줄은 언제나 참이다.
     and (v_room.max_seats_per_bidder is null
          or (select count(*) from public.seats s2
               where s2.room_id = l.room_id and s2.current_owner_id = v_me
                 and s2.acquired_via = 'auction')
           -- 지금 선두인 매물도 같이 센다. 경매는 매물 마감 시각이 모두 같아서
           -- 60초 내내 낙찰된 좌석이 0개다 — 정산이 끝난 것만 세면 이 상한은
           -- 단 한 번도 걸리지 않고, 돈 많은 학생이 5개를 한 배치에 쓸어간다.
           + (select count(*) from public.listings o2
               where o2.room_id = l.room_id and o2.status = 'open'
                 and o2.highest_bidder_id = v_me and o2.id <> l.id)
           < v_room.max_seats_per_bidder)
  returning l.* into v_row;
  -- exception when unique_violation (ALREADY_LEADING_ANOTHER) 블록은 없다.
  -- 그 예외는 listings_one_lead_per_bidder 가 던지던 것이고 그 인덱스는
  -- 사라졌다. 이제 도달할 수 없는 코드다.

  if v_row.id is null or v_row.highest_bidder_id <> v_me then
    -- 내가 읽은 현재가가 그 사이에 바뀌었다. 클라이언트는 새 값으로 다시 그린다.
    return jsonb_build_object('ok', false, 'error', 'CHANGED');
  end if;

  insert into public.bids (room_id, listing_id, bidder_id, amount)
       values (v_room.id, p_listing, v_me, p_amount);

  -- 프로젝터 티커는 bids 를 구독하지 않는다. 구독자마다 RLS 를 평가하는
  -- 비용을 피하려고 여기서 Broadcast 로 직접 쏜다. 좌석과 금액만, 닉네임은 없다.
  --
  -- 실패해도 입찰은 성립해야 한다. realtime.send 는 프로젝터 연출용이고,
  -- 이 함수가 없거나 권한이 다른 프로젝트에서도 경매 자체는 굴러가야 한다.
  -- listings 테이블 변경이 이미 실시간으로 나가므로 티커가 없어도 값은 맞는다.
  begin
    perform realtime.send(
      jsonb_build_object('listing_id', p_listing, 'seat_label', v_row.seat_label,
                         'amount', p_amount, 'extended', v_ext, 'rev', v_row.rev),
      'bid', 'ym:room:' || v_room.id::text, false);
  exception when others then
    null;
  end;

  return jsonb_build_object('ok', true, 'amount', p_amount, 'seat_label', v_row.seat_label,
                            'ends_at', v_row.ends_at, 'extended', v_ext,
                            'next_min', public._min_bid(v_row.opening_bid, p_amount));
exception
  -- 40P01. 위의 자문 잠금 교체로 place_bid 와 정산 사이의 잠금 순환은
  -- 사라졌지만, 남은 교착이 학생에게 빨간 에러로 보이면 안 된다.
  -- CHANGED 와 같은 '다시 눌러 주세요' 계열로 내려앉힌다.
  when deadlock_detected then
    return jsonb_build_object('ok', false, 'error', 'BUSY');
end;
$$;

-- =====================================================================
-- 정산 — 교사의 브라우저에 기대지 않는다
-- =====================================================================
-- 정적 사이트 + Supabase 에는 스케줄러가 없다. 그래서 아무나 불러도 안전한
-- 함수로 만들고 학생·교사·프로젝터가 모두 주기적으로 부른다. 33명이 동시에
-- 불러도 자문 잠금과 '조건부 UPDATE 로 선점' 덕에 한 번만 정산된다.
create or replace function public.settle_expired_listings(p_room_code text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_room uuid;
  v_n    int := 0;
begin
  select r.id into v_room from public.rooms_public r
   where r.room_code = upper(trim(p_room_code)) and r.expires_at > clock_timestamp();
  if v_room is null then
    return jsonb_build_object('ok', false, 'error', 'NO_ROOM');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('ym:settle:' || v_room::text, 0));

  -- 'set constraints public.seats_one_per_player deferred' 는 사라졌다.
  -- 그 제약 자체가 없기 때문이다. 이 문장을 남겨 두면 정산이 매번
  -- 42704 (constraint does not exist) 로 죽는다. 이 함수는 학생·프로젝터·
  -- 조종석이 2초마다 부르는 것이고 강제 마감도 여기를 지나가므로,
  -- 그 반의 경매는 영원히 정산되지 않고 교사에게 탈출구가 없다.
  -- 새 그물(seats_one_booking_per_player)은 부분 인덱스이고, 아래 moved 가
  -- 좌석을 술어 밖('auction')으로 내보내므로 중간 위반이 생기지 않는다.
  -- 지연할 것이 없다.

  -- 낙찰 여부를 '입찰 시점의 판단'이 아니라 '지금 이 순간의 실제 상태'로
  -- 다시 정한다. 낙찰자가 쫓겨났거나 잔액이 모자라면 그 매물만 조용히
  -- 유찰로 떨어뜨린다.
  --
  -- 이게 핵심이다. 예전 판본은 그런 이상 상태를 만나면 제약 위반으로
  -- 트랜잭션 전체가 롤백됐고, 매물은 만료된 채 그대로 남아 다음 호출이
  -- 똑같이 실패했다. 초당 17번씩, 수업이 끝날 때까지. 교사가 쓸 수 있는
  -- 탈출구도 없었다 — 강제 마감도 같은 함수를 지나가기 때문이다.
  -- 이상은 한 건만 잃고, 배치는 반드시 커밋된다.
  with expired as materialized (
    -- as materialized 를 명시한다. 아래 ranked 와 verdict 가 둘 다 이것을
    -- 참조하므로, FOR UPDATE 가 두 번 평가되는 일을 플래너 판단에 맡기지 않는다.
    select l.id, l.seat_id, l.seller_id, l.highest_bid, l.highest_bidder_id
      from public.listings l
     where l.room_id = v_room
       and l.status = 'open'
       and l.settled_at is null
       and clock_timestamp() >= l.ends_at
       for update
  ),
  -- 한 사람이 여러 개를 낙찰받을 수 있으므로, '비싼 것부터' 누적해서 잔액이
  -- 닿는 데까지만 준다. 누적합이 단조증가하니 낙찰은 언제나 '앞쪽 묶음' 이고
  -- 그 합은 마지막 낙찰의 cum 과 같다 — 그래서 지갑이 음수가 될 수 없다.
  -- 정렬 키가 전순서(금액 desc, id)라서 같은 입력이면 항상 같은 결과가
  -- 나온다. 두 매물이 같은 순간 마감되어도 배치 순서에 흔들리지 않는다.
  ranked as (
    select e.id,
           sum(e.highest_bid) over (
             partition by e.highest_bidder_id
             order by e.highest_bid desc, e.id
             rows between unbounded preceding and current row) as cum
      from expired e
     where e.highest_bidder_id is not null
  ),
  verdict as (
    select e.id, e.seat_id, e.seller_id, e.highest_bid, e.highest_bidder_id,
           (e.highest_bidder_id is not null
            -- 쫓겨난 학생에게 좌석을 주지 않는다. _auth_player 가 kicked 를
            -- 막으므로 새 입찰은 못 하지만, 쫓겨나기 '전' 의 선두는 남아 있다.
            -- 다석 허용으로 선두를 여러 개 들고 있을 수 있어 여파가 커졌다.
            and exists (select 1 from public.players p
                         where p.id = e.highest_bidder_id and p.kicked = false)
            -- 배치 안 내 낙찰액의 '누적합' 기준이다. 좌석 보유 조건은 없다 —
            -- 좌석이 있어도 살 수 있고 여러 개도 살 수 있다.
            -- 이 줄은 §약정 규칙이 이미 보장하는 것을 한 번 더 확인하는
            -- 후위 안전망이다(도달 불가가 정상). 그래도 남기는 이유는 옛
            -- 주석과 같다 — 이상 상태에서 배치 전체를 롤백하지 않고
            -- 한 건만 잃기 위해서다.
            and r.cum <= coalesce((select w.balance from public.wallets w
                                    where w.player_id = e.highest_bidder_id), 0)
           ) as wins
      from expired e
      left join ranked r on r.id = e.id
  ),
  closed as (
    update public.listings l
       set status      = case when v.wins then 'sold' else 'unsold' end,
           final_price = case when v.wins then v.highest_bid else null end,
           settled_at  = clock_timestamp()
      from verdict v
     where l.id = v.id
    returning l.id, l.seat_id, l.seller_id, l.final_price, l.highest_bidder_id, l.status
  ),
  -- 좌석 이동. acquired_via 를 'auction' 으로 바꾸는 것이 예매 1인 1석
  -- 인덱스에서 이 좌석을 빼내는 유일한 장치다. 이 한 칸을 빠뜨리면 배치
  -- 전체가 unique_violation 으로 롤백되고 위의 그 재앙이 그대로 재현된다.
  -- (좌석은 한 낙찰당 한 행이다 — listings.seat_id 가 unique 라서
  --  다중 매칭이 없다. 합산이 필요한 것은 지갑뿐이다.)
  moved as (
    update public.seats s
       set current_owner_id = c.highest_bidder_id,
           claimed_at       = clock_timestamp(),
           acquired_via     = 'auction'
      from closed c
     where s.id = c.seat_id and c.status = 'sold'
    returning s.id
  ),
  -- 돈은 '사람당 한 줄' 로 합쳐서 한 번만 움직인다.
  --
  -- 예전에는 paid(산 사람 차감) / got(판 사람 입금) 두 CTE 였다. 다석이
  -- 되는 순간 그 구조에서 교실에 돈이 창조된다:
  --   (1) UPDATE ... FROM 은 다중 매칭에서 후보 행 '하나' 만 쓴다. 두 개를
  --       낙찰받은 학생은 한 개 값만 내고 좌석 두 개를 가져간다.
  --   (2) 판 사람이 동시에 산 사람이 될 수 있으므로(남의 매물) 두 CTE 가
  --       같은 지갑 행을 한 문장 안에서 갱신하고, 한쪽이 조용히 사라진다.
  -- 둘 다 에러도 경고도 없다. 교실에서는 절대 안 보이고, 반이 끝나고
  -- 결과 숫자가 안 맞을 때야 드러난다. 사람당 순 델타 한 줄로 접으면
  -- 두 함정이 동시에 사라진다.
  ledger as (
    select y.pid, sum(y.delta)::int as delta
      from (
        select c.highest_bidder_id as pid, -c.final_price as delta
          from closed c where c.status = 'sold'
        union all
        select c.seller_id as pid,          c.final_price as delta
          from closed c where c.status = 'sold'
      ) y
     group by y.pid
  ),
  settled_money as (
    update public.wallets w
       set balance = w.balance + g.delta
      from ledger g
     where w.player_id = g.pid and g.delta <> 0
    returning w.player_id
  )
  -- 갱신 순서: closed(매물) -> moved(좌석) -> settled_money(지갑).
  -- 한 문장 안이라 실제 실행 순서는 미정이지만, 셋 다 같은 스냅샷에서
  -- closed 의 결과만 읽으므로 서로 간섭하지 않는다. 데이터 변경 CTE 는
  -- 아래 SELECT 가 참조하지 않아도 반드시 실행된다(원본도 이 성질에
  -- 의존했다). 멱등성도 그대로다 — 자문 잠금 + 'status=open and
  -- settled_at is null' 조건부 UPDATE 로 선점하는 구조를 건드리지 않았다.
  select count(*) into v_n from closed;

  return jsonb_build_object('ok', true, 'settled', v_n, 'server_now', clock_timestamp());
end;
$$;

-- =====================================================================
-- 투표
-- =====================================================================
create or replace function public.cast_vote(
  p_room_code text, p_player uuid, p_token text, p_question text, p_choice text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_me   uuid;
  v_room uuid;
  v_ins  int;
begin
  v_me := public._auth_player(p_room_code, p_player, p_token);
  if v_me is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  select r.id into v_room from public.rooms_public r where r.room_code = upper(trim(p_room_code));

  if p_question not in ('pre','post','q1_movie','q2_campsite','q3_upfront')
     or p_choice not in ('yes','no','unsure') then
    return jsonb_build_object('ok', false, 'error', 'BAD_VOTE');
  end if;

  -- 한 사람 한 표. 두 번째부터는 조용히 무시한다 (바꿔치기 금지).
  insert into public.votes (room_id, question, player_id, choice)
       values (v_room, p_question, v_me, p_choice)
  on conflict do nothing;
  get diagnostics v_ins = row_count;

  if v_ins > 0 then
    -- jsonb_set 을 쓰면 안 된다. 경로의 '앞쪽' 단계가 없으면 아무것도 하지 않고
    -- 원본을 그대로 돌려준다 (create_if_missing 은 마지막 칸만 만든다).
    -- vote_counts 는 '{}' 에서 시작하므로 'pre' 키가 영영 생기지 않고,
    -- 모든 투표가 조용히 0 으로 남는다 — 에러도 로그도 없이.
    -- 객체를 직접 합쳐서 바깥 단계를 만들어 준다.
    update public.rooms_public r
       set vote_counts = coalesce(r.vote_counts, '{}'::jsonb)
           || jsonb_build_object(
                p_question,
                coalesce(r.vote_counts -> p_question, '{}'::jsonb)
                || jsonb_build_object(
                     p_choice,
                     coalesce((r.vote_counts -> p_question ->> p_choice)::int, 0) + 1))
     where r.id = v_room;
  end if;

  return jsonb_build_object('ok', true, 'counted', v_ins > 0);
end;
$$;



-- #####################################################################
-- ##  functions-admin.sql
-- #####################################################################

-- =====================================================================
-- YM — 교사(관리자) RPC. 전부 관리자 토큰을 요구한다.
-- =====================================================================
-- 실행 순서: schema.sql -> functions.sql -> functions-admin.sql -> policies.sql
--
-- 단계를 넘기는 버튼은 전부 "타임스탬프가 NULL 일 때만 UPDATE" 로 잠겨 있다.
-- 교사가 급해서 두 번 눌러도 두 번째는 조용히 아무 일도 하지 않고
-- 현재 상태를 그대로 돌려준다. 교실에서 버튼은 반드시 두 번 눌린다.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 명단 잠그기 — 이 버튼 하나가 활동 전체를 지킨다
-- ---------------------------------------------------------------------
-- 좌석 수와 예산 배분을 '잠근 명단' 기준으로 딱 한 번 계산한다.
-- 실시간 인원수로 계산하면 늦게 들어온 학생 한 명에 좌석 수가 흔들리고,
-- 그 틈으로 명단을 부풀리는 장난이 들어온다.
create or replace function public.admin_lock_roster(
  p_room_code text, p_admin_token text, p_seat_override int)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_room  uuid;
  v_n     int;
  v_seats int;
  v_rows  int;
  v_base  int;
  v_rem   int;
  v_lbl   text[];
  i int; j int; k int := 0; v_in_row int;
begin
  v_room := public._require_admin(p_room_code, p_admin_token);

  select count(*) into v_n from public.players p where p.room_id = v_room and p.kicked = false;
  if v_n < 4 then
    return jsonb_build_object('ok', false, 'error', 'TOO_FEW', 'players', v_n);
  end if;

  -- 좌석은 참가자의 40%. 이 숫자가 활동 전체의 심장이다.
  -- 75%로 주면 팔려는 사람이 사려는 사람보다 많아져서 경매가 시작가에
  -- 전부 낙찰되고, '₩20,000 이 ₩150,000 이 됐다'는 장면이 아예 안 나온다.
  -- 40%면 13석에 입찰자 20명 — 매물당 3명 남짓이 붙는다.
  v_seats := greatest(3, round(0.40 * v_n)::int);

  if p_seat_override is not null then
    -- 교사가 조정하더라도 55% 를 넘기면 시장이 뒤집힌다. 거기서 자른다.
    v_seats := greatest(3, least(p_seat_override, floor(0.55 * v_n)::int));
  end if;

  -- 좌석이 적을 때 4줄로 펴면 한 줄에 서너 개씩 남아 초라해 보인다.
  -- 한 줄에 6개쯤 오도록 줄 수를 정한다.
  v_rows := least(4, greatest(2, ceil(v_seats / 6.0)::int));
  v_base := v_seats / v_rows;
  v_rem  := v_seats % v_rows;
  v_lbl  := (select r.seat_rows from public.rooms_public r where r.id = v_room);

  -- 선점을 '검사'가 아니라 '쓰기'로 한다. 조건부 UPDATE 가 행 잠금을 잡으므로
  -- 교사가 두 번 눌러도 두 번째는 0행을 만나고 조용히 현재 값을 돌려준다.
  -- (exists 로 먼저 확인하는 방식은 왕복이 100ms 쯤 되는 휴대폰에서
  --  두 요청이 나란히 통과해 좌석을 두 벌 만든다.)
  update public.rooms_public r
     set join_open = false,
         roster_frozen_at = clock_timestamp(),
         seat_count = v_seats,
         player_count = v_n
   where r.id = v_room and r.roster_frozen_at is null;

  if not found then
    return jsonb_build_object('ok', true, 'already', true,
      'seat_count', (select seat_count from public.rooms_public where id = v_room));
  end if;

  -- 좌석 생성은 선점에 성공한 쪽만 한다.
  for i in 1..v_rows loop
    v_in_row := v_base + case when i <= v_rem then 1 else 0 end;
    for j in 1..v_in_row loop
      k := k + 1;
      insert into public.seats (room_id, row_label, seat_no, seat_label)
           values (v_room, v_lbl[i], j, v_lbl[i] || j::text)
      on conflict (room_id, row_label, seat_no) do nothing;
    end loop;
  end loop;

  return jsonb_build_object('ok', true, 'players', v_n, 'seat_count', v_seats, 'rows', v_rows);
end;
$$;

-- ---------------------------------------------------------------------
-- 예매 시작
-- ---------------------------------------------------------------------
create or replace function public.admin_start_booking(p_room_code text, p_admin_token text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_room uuid; v_open timestamptz;
begin
  v_room := public._require_admin(p_room_code, p_admin_token);

  -- 좌석은 명단 잠금 안에서만 만들어진다. 순서를 안 지키고 이 버튼을 먼저
  -- 누르면 좌석 0개짜리 방에서 카운트다운이 돌고, 예매 창은 단발 가드에
  -- 걸려 두 번 다시 열리지 않는다. 그 반은 그대로 끝난다.
  if not exists (select 1 from public.rooms_public r
                  where r.id = v_room and r.roster_frozen_at is not null) then
    return jsonb_build_object('ok', false, 'error', 'ROSTER_NOT_LOCKED');
  end if;

  -- 8초 뒤에 열린다. 5-4-3-2-1-GO 가 셀 대상이 실제로 있어야 한다.
  -- 모든 기기가 이 '서버 시각' 하나를 보고 카운트하므로 동시에 열린다.
  update public.rooms_public r
     set phase = 'booking',
         booking_opens_at = clock_timestamp() + interval '8 seconds',
         booking_ends_at  = clock_timestamp() + interval '28 seconds'
   where r.id = v_room and r.booking_opens_at is null
  returning r.booking_opens_at into v_open;

  if v_open is null then
    select r.booking_opens_at into v_open from public.rooms_public r where r.id = v_room;
    return jsonb_build_object('ok', true, 'already', true, 'booking_opens_at', v_open);
  end if;

  return jsonb_build_object('ok', true, 'booking_opens_at', v_open,
                            'server_now', clock_timestamp());
end;
$$;

-- ---------------------------------------------------------------------
-- 단계 넘기기 (예매/경매/정산을 제외한 나머지)
-- ---------------------------------------------------------------------
create or replace function public.admin_set_phase(
  p_room_code text, p_admin_token text, p_phase text, p_seconds int)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_room uuid; v_end timestamptz;
begin
  v_room := public._require_admin(p_room_code, p_admin_token);

  if p_phase not in ('lobby','booking','prevote','decide','budget','auction','results','yosemite') then
    return jsonb_build_object('ok', false, 'error', 'BAD_PHASE');
  end if;

  v_end := clock_timestamp() + (interval '1 second' * coalesce(p_seconds, 0));

  update public.rooms_public r
     set phase = p_phase,
         prevote_ends_at   = case when p_phase = 'prevote' then v_end else r.prevote_ends_at end,
         decide_ends_at    = case when p_phase = 'decide'  then v_end else r.decide_ends_at end,
         budget_ends_at    = case when p_phase = 'budget'  then v_end else r.budget_ends_at end,
         postvote_ends_at  = case when p_phase = 'results' then v_end else r.postvote_ends_at end,
         finalvote_ends_at = case when p_phase = 'yosemite' then v_end else r.finalvote_ends_at end,
         -- 예매를 닫는 순간 매물로 올릴 좌석이 확정된다.
         booking_ends_at   = case when p_phase <> 'booking' and r.booking_ends_at is not null
                                  then least(r.booking_ends_at, clock_timestamp())
                                  else r.booking_ends_at end
   where r.id = v_room;

  return jsonb_build_object('ok', true, 'phase', p_phase, 'ends_at', v_end,
                            'server_now', clock_timestamp());
end;
$$;

-- 매물이 3개 미만일 때 P2 를 30초만 다시 연다. 시장이 안 열리면
-- 활동 자체가 성립하지 않으므로 교사에게 한 번의 만회 기회를 준다.
create or replace function public.admin_reopen_decide(p_room_code text, p_admin_token text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_room uuid;
begin
  v_room := public._require_admin(p_room_code, p_admin_token);
  update public.rooms_public r
     set phase = 'decide', decide_ends_at = clock_timestamp() + interval '30 seconds'
   where r.id = v_room;
  return jsonb_build_object('ok', true, 'decide_ends_at', clock_timestamp() + interval '30 seconds');
end;
$$;

-- ---------------------------------------------------------------------
-- 예산 배정 — 불평등하되 통제된 분포
-- ---------------------------------------------------------------------
-- 독립 난수를 뽑으면 어떤 반은 전원이 비슷해지고 어떤 반은 한 명만 부자가 된다.
-- 분포를 먼저 고정하고 그것을 섞어 나눠 준다. 그래야 11개 반이 같은 수업이 된다.
--
-- 사다리를 33배가 아니라 7.5배로 압축한 이유: 최저층도 최소 두 번은 입찰할 수
-- 있어야 경쟁에 참여하고, 한계 입찰자가 ₩150,000 근처에 서야 지문의
-- $20 -> $100~150 과 같은 배수가 교실에서 재현된다.
create or replace function public.admin_distribute_wealth(p_room_code text, p_admin_token text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_room   uuid;
  v_n      int;
  v_amt    int[]  := array[40000, 60000, 100000, 150000, 220000, 300000];
  v_w      numeric[] := array[0.18, 0.18, 0.21, 0.18, 0.12, 0.13];
  v_cnt    int[]  := array[0,0,0,0,0,0];
  v_rem    numeric[] := array[0,0,0,0,0,0];
  v_pool   int[]  := array[]::int[];
  v_sum    int := 0;
  v_left   int;
  i int; j int; v_best int;
begin
  v_room := public._require_admin(p_room_code, p_admin_token);

  select count(*) into v_n from public.players p where p.room_id = v_room and p.kicked = false;
  if v_n = 0 then
    return jsonb_build_object('ok', false, 'error', 'NO_PLAYERS');
  end if;

  -- 돈을 나눠 주기 '전에' 원자적으로 선점한다. 검사-후-쓰기로 하면
  -- 교사가 반응 없는 화면을 두 번 눌렀을 때 두 요청이 나란히 통과해
  -- 전원에게 예산이 두 번 들어간다 — 그리고 아무도 눈치채지 못한다.
  update public.rooms_public r
     set wealth_distributed_at = clock_timestamp(),
         phase = 'budget',
         budget_ends_at = clock_timestamp() + interval '40 seconds'
   where r.id = v_room and r.wealth_distributed_at is null;

  if not found then
    return jsonb_build_object('ok', true, 'already', true);
  end if;

  -- 최대잉여법(Hamilton). 어떤 인원수에서도 합이 정확히 N 이 된다.
  for i in 1..6 loop
    v_cnt[i] := floor(v_n * v_w[i])::int;
    v_rem[i] := (v_n * v_w[i]) - v_cnt[i];
    v_sum := v_sum + v_cnt[i];
  end loop;

  v_left := v_n - v_sum;
  while v_left > 0 loop
    v_best := 1;
    for i in 2..6 loop
      if v_rem[i] > v_rem[v_best] then v_best := i; end if;
    end loop;
    v_cnt[v_best] := v_cnt[v_best] + 1;
    v_rem[v_best] := -1;                      -- 같은 칸이 두 번 먹지 않게
    v_left := v_left - 1;
  end loop;

  for i in 1..6 loop
    for j in 1..v_cnt[i] loop
      v_pool := v_pool || v_amt[i];
    end loop;
  end loop;

  -- 금액 배열을 섞어서 참가 순서와 무관하게 나눠 준다.
  -- 일찍 들어온 학생이 유리하다는 인상을 주면 안 된다.
  with shuffled as (
    select amount, row_number() over (order by random()) as rn
      from unnest(v_pool) as amount
  ),
  targets as (
    select p.id, row_number() over (order by random()) as rn
      from public.players p
     where p.room_id = v_room and p.kicked = false
  )
  update public.wallets w
     set initial = s.amount,
         balance = w.balance + s.amount
    from shuffled s
    join targets t on t.rn = s.rn
   where w.player_id = t.id;

  return jsonb_build_object('ok', true, 'players', v_n, 'buckets', to_jsonb(v_cnt));
end;
$$;

-- ---------------------------------------------------------------------
-- 경매 시작
-- ---------------------------------------------------------------------
-- 매물마다 각자의 마감 시각을 갖는다. 전체 공통 마감 하나만 두면
-- 55초 침묵 + 5초 스나이핑이 되고, 마지막 순간에 1등이던 사람이
-- 아무도 대응할 틈 없이 그대로 가져간다.
create or replace function public.admin_start_auction(
  p_room_code text, p_admin_token text, p_seconds int)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_room uuid; v_sec int; v_end timestamptz; v_n int;
begin
  v_room := public._require_admin(p_room_code, p_admin_token);
  v_sec := coalesce(p_seconds, 60);
  if v_sec not in (30, 45, 60, 90) then v_sec := 60; end if;

  v_end := clock_timestamp() + (interval '1 second' * v_sec);

  -- 단발 가드는 '방의 타임스탬프'에만 건다. 매물 개방은 언제나 다시 한다.
  -- 예전 판본은 전부를 한 가드로 묶어서, 매물 0개일 때 실수로 누르면
  -- 경매가 '이미 시작됨'으로 굳어 버리고 P2 를 다시 열어도 그 매물들을
  -- 개방할 방법이 영영 없었다 — 교사가 준비해 둔 복구 버튼이 막다른 길이었다.
  update public.listings l
     set status = 'open', ends_at = v_end
   where l.room_id = v_room and l.status = 'pending';
  get diagnostics v_n = row_count;

  update public.rooms_public r
     set phase = 'auction',
         auction_seconds = v_sec,
         auction_started_at = coalesce(r.auction_started_at, clock_timestamp()),
         auction_ends_at = greatest(coalesce(r.auction_ends_at, clock_timestamp()),
                                    v_end + interval '60 seconds')
   where r.id = v_room;

  return jsonb_build_object('ok', true, 'listings', v_n, 'ends_at', v_end, 'seconds', v_sec);
end;
$$;

-- 교사가 직접 끝낼 때. 마감을 현재로 당긴 뒤 같은 정산 함수를 부른다.
-- 정산 경로가 하나뿐이라 '두 번 정산'이 구조적으로 불가능하다.
create or replace function public.admin_force_settle(p_room_code text, p_admin_token text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_room uuid;
begin
  v_room := public._require_admin(p_room_code, p_admin_token);
  update public.listings l
     set ends_at = clock_timestamp()
   where l.room_id = v_room and l.status = 'open';
  return public.settle_expired_listings(p_room_code);
end;
$$;

-- ---------------------------------------------------------------------
-- 결과 계산 — 한 번 계산해서 굳힌다
-- ---------------------------------------------------------------------
-- 화면마다 다시 집계하면 프로젝터와 학생 기기의 숫자가 어긋난다.
create or replace function public.admin_compute_results(p_room_code text, p_admin_token text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_room uuid; v_face int; v_n int;
  v_res jsonb; v_pub jsonb; v_minsold int; v_priced_out int; v_noseat int;
begin
  v_room := public._require_admin(p_room_code, p_admin_token);

  select r.face_value, r.player_count into v_face, v_n
    from public.rooms_public r where r.id = v_room;

  select min(l.final_price) into v_minsold
    from public.listings l where l.room_id = v_room and l.status = 'sold';

  -- 다석이 되어도 식은 그대로다 — '좌석이 하나도 없는 학생 수' 가 정확히
  -- 이것이다. 대신 의미가 커진다: 낙찰 좌석이 소수에게 몰리면
  -- holders < seat_count 가 되어 이 숫자가 구조적으로 늘어난다.
  -- 그리고 priced_out 보다 훨씬 빠르게 는다. 즉 "돈이 없어서 못 산 사람"
  -- 보다 "돈은 있었는데 밀린 사람" 이 늘어난다. 결함이 아니라 더 강한
  -- 논거다 — 경매는 지불 의사가 아니라 지불 능력의 서열로 배분한다.
  select count(*) into v_noseat
    from public.players p
   where p.room_id = v_room and p.kicked = false
     and not exists (select 1 from public.seats s
                      where s.room_id = v_room and s.current_owner_id = p.id);

  -- 가진 돈 전부를 써도 '가장 싸게 팔린 좌석'조차 못 사는 학생 수.
  -- 원래 스펙의 '저소득 절반 vs 고소득 절반' 통계는 9명 남짓으로 내는
  -- 노이즈이고 거꾸로 나올 수도 있다. 지문을 읽기 직전에 논지가 뒤집히면
  -- 수업이 무너지므로, 뒤집힐 수 없는 숫자로 바꿨다.
  if v_minsold is null then
    v_priced_out := 0;
  else
    select count(*) into v_priced_out
      from public.players p
      join public.wallets w on w.player_id = p.id
     where p.room_id = v_room and p.kicked = false
       and w.balance < v_minsold
       and not exists (select 1 from public.seats s
                        where s.room_id = v_room and s.current_owner_id = p.id);
  end if;

  select jsonb_build_object(
    'face_value', v_face,
    'players', v_n,
    'seat_count', (select count(*) from public.seats s where s.room_id = v_room),
    'listed',    (select count(*) from public.listings l where l.room_id = v_room
                   and l.status in ('sold','unsold')),
    'sold',      (select count(*) from public.listings l where l.room_id = v_room and l.status = 'sold'),
    'unsold',    (select count(*) from public.listings l where l.room_id = v_room and l.status = 'unsold'),
    'avg_price', (select round(avg(l.final_price)) from public.listings l
                   where l.room_id = v_room and l.status = 'sold'),
    'max_price', (select max(l.final_price) from public.listings l
                   where l.room_id = v_room and l.status = 'sold'),
    'min_price', v_minsold,
    -- '수익'이라는 말은 앱 어디에도 쓰지 않는다. 받은 금액과 액면가만 보여주고
    -- 그것을 무엇이라 부를지는 학생이 정한다.
    'received',  (select coalesce(sum(l.final_price - v_face), 0) from public.listings l
                   where l.room_id = v_room and l.status = 'sold'),
    'no_seat', v_noseat,
    'priced_out', v_priced_out,
    'multiple', case when v_face > 0 and (select max(l.final_price) from public.listings l
                                           where l.room_id = v_room and l.status = 'sold') is not null
                     then round((select max(l.final_price) from public.listings l
                                  where l.room_id = v_room and l.status = 'sold')::numeric / v_face, 1)
                     else null end,
    -- 좌석별 최종 가격 + '누가 얼마에 샀는지'. 되팔리지 않은 좌석은 액면가 그대로다.
    --
    -- 기존 키(label / row / no / price / state)는 하나도 지우거나 이름을
    -- 바꾸지 않는다. 프로젝터가 그 키로 히트맵을 그린다. buyer 와 via 는
    -- 더하기만 한 것이고, null 이면 화면이 아무것도 그리지 않으면 된다.
    --
    -- players 는 잠긴 표지만 이 함수는 SECURITY DEFINER 라서 읽을 수 있다.
    -- 결과는 rooms_public.results(공개)로 나가므로 여기 넣는 별명은 교실
    -- 전체가 보게 된다. 별명은 학생이 직접 고른 가명이고, 입장 화면이
    -- "반 전체 화면에 보일 수 있습니다" 를 이미 고지한다. 실명·학번·점수·
    -- 순위는 여기에도 없다.
    --
    -- 판 사람 별명은 넣지 않는다 — seller 도, holder 도, owner 도 없다.
    --   (1) reason_code 는 매물당 하나, 매물은 판 사람당 하나다. 좌석 칸에
    --       판 사람 이름이 뜨고 그 옆에 익명 사유 칩이 있으면, 30초 안에
    --       "내 좌석이니까 내 마음" 이라고 말한 사람이 특정된다. 사유 벽을
    --       익명으로 설계한 이유가 그대로 무효가 된다.
    --   (2) state='unsold' 의 현재 주인은 정의상 판 사람이다. 그래서
    --       중립적인 이름의 키조차 쓸 수 없다 — 그건 "팔려고 했는데 아무도
    --       안 사 줬다" 를 이름과 함께 띄우는 것이다.
    --   (3) 산 사람의 이름은 논점을 향한다. 예산은 추첨으로 배정됐고, 그가
    --       이긴 이유는 가장 원해서가 아니라 가장 돈이 많아서다 — 겨냥하는
    --       대상이 제도다. 판 사람의 이름은 논점을 비껴가고, 활동이 시키는
    --       대로 한 학생에게 돌아가는 교실 내 비난만 남긴다.
    -- 교사가 정말 필요하면 조종석에 이미 길이 있다(admin_state.roster 와
    -- 공개 표인 listings). 프로젝터에 띄우는 이 페이로드에만 넣지 않는다.
    'seats', coalesce((
      select jsonb_agg(jsonb_build_object(
               'label', s.seat_label, 'row', s.row_label, 'no', s.seat_no,
               'price', coalesce(l.final_price, v_face),
               'state', case when l.status = 'sold' then 'sold'
                             when l.status = 'unsold' then 'unsold'
                             else 'kept' end,
               'buyer', case when l.status = 'sold' then bp.nickname else null end,
               'via',   s.acquired_via)
             order by s.row_label, s.seat_no)
        from public.seats s
        left join public.listings l on l.seat_id = s.id and l.status in ('sold','unsold')
        left join public.players  bp on bp.id = l.highest_bidder_id and l.status = 'sold'
       where s.room_id = v_room), '[]'::jsonb),
    -- 13석이 9명에게 갔다 — 이 한 줄이 다석 허용의 논점 전부다.
    -- 좌석 없는 학생이 왜 늘었는지를 '돈이 없어서' 가 아니라 '몇 명이
    -- 쓸어갔기 때문' 으로 말할 수 있게 해 준다. 점수도 순위도 아니다.
    -- 분포이고, 그 분포를 만든 것은 추첨으로 배정된 예산이다.
    -- 화면은 이 숫자 옆에 "예산은 추첨으로 정해졌습니다" 를 상설로 둬야
    -- 한다. 이름만 크게 뜨면 논점이 제도에서 사람으로 옮겨간다.
    'holders', (select count(distinct s.current_owner_id)::int from public.seats s
                 where s.room_id = v_room and s.current_owner_id is not null),
    'buyers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'nickname', b.nickname, 'count', b.n, 'spent', b.spent, 'seats', b.labels)
             order by b.n desc, b.spent desc, b.nickname)
        from (select p.nickname,
                     count(*)::int           as n,
                     sum(l.final_price)::int as spent,
                     -- text[] 를 jsonb_build_object 가 JSON 배열로 바꿔 준다.
                     array_agg(l.seat_label order by l.seat_label) as labels
                from public.listings l
                join public.players p on p.id = l.highest_bidder_id
               where l.room_id = v_room and l.status = 'sold'
               -- nickname 으로 묶어도 안전하다 — players_nick_uq 가
               -- (room_id, nickname) 을 유일하게 만든다.
               group by p.nickname) b), '[]'::jsonb),
    -- 두 개 이상 낙찰받은 사람 수, 그 사람들이 가져간 좌석 수, 한 사람의 최대.
    'swept', (select count(*)::int from (
                select 1 from public.listings l
                 where l.room_id = v_room and l.status = 'sold'
                 group by l.highest_bidder_id having count(*) > 1) z),
    'swept_seats', coalesce((select sum(z.c)::int from (
                select count(*) as c from public.listings l
                 where l.room_id = v_room and l.status = 'sold'
                 group by l.highest_bidder_id having count(*) > 1) z), 0),
    'max_seats_one_buyer', coalesce((select max(z.c)::int from (
                select count(*) as c from public.listings l
                 where l.room_id = v_room and l.status = 'sold'
                 group by l.highest_bidder_id) z), 0),
    -- 익명 사유 벽. 시장을 옹호하는 논거를 사이트가 아니라 학생이 낸다.
    'reasons', coalesce((
      select jsonb_object_agg(x.reason_code, x.n) from (
        select l.reason_code, count(*) as n from public.listings l
         where l.room_id = v_room and l.reason_code is not null
         group by l.reason_code) x), '{}'::jsonb),
    'votes', (select r.vote_counts from public.rooms_public r where r.id = v_room)
  ) into v_res;

  -- 공개 테이블에는 별명을 뺀 사본만 넣는다.
  --
  -- rooms_public 은 anon 이 통째로 읽고 실시간으로 발행된다. 낙찰자 별명을
  -- 여기 넣으면, 학생이 results.seats[].label 과 공개 seats.current_owner_id 를
  -- 붙여 'UUID -> 별명' 사전을 만들 수 있다. 그 사전이 생기면 listings.seller_id
  -- 에도 이름이 붙어서, 이 함수가 15줄로 '절대 하면 안 된다' 고 적어 둔 장면 —
  -- "팔려고 했는데 아무도 안 사 줬다" 가 이름과 함께 — 이 그대로 재현된다.
  --
  -- 별명은 두 경로로만 나간다: 이 함수의 반환값(교사 토큰 필요)과
  -- room_results(정책 0개인 잠긴 표). 교탁 TV 는 토큰이 있으므로 볼 수 있다.
  v_pub := (v_res - 'buyers') || jsonb_build_object('seats',
             coalesce((select jsonb_agg(x.v - 'buyer' order by x.i)
                         from jsonb_array_elements(v_res -> 'seats')
                              with ordinality as x(v, i)), '[]'::jsonb));

  update public.rooms_public r
     set results = v_pub, results_computed_at = clock_timestamp()
   where r.id = v_room;

  insert into public.room_results (room_id, payload) values (v_room, v_res)
  on conflict (room_id) do update set payload = excluded.payload, created_at = clock_timestamp();

  return jsonb_build_object('ok', true, 'results', v_res);
end;
$$;

-- ---------------------------------------------------------------------
-- 조종석이 보는 현황
-- ---------------------------------------------------------------------
create or replace function public.admin_state(p_room_code text, p_admin_token text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_room uuid; v_r public.rooms_public%rowtype;
begin
  v_room := public._require_admin(p_room_code, p_admin_token);
  select * into v_r from public.rooms_public where id = v_room;

  return jsonb_build_object(
    'ok', true,
    'server_now', clock_timestamp(),
    'room', to_jsonb(v_r),
    -- 별명이 붙은 원본 결과. rooms_public.results 에는 별명을 뺀 사본만
    -- 들어 있으므로(학생이 읽는 표다), 교탁 TV 가 새로고침된 뒤에도
    -- 낙찰자 이름을 그릴 수 있도록 여기로 함께 내보낸다.
    'results_full', (select rr.payload from public.room_results rr
                      where rr.room_id = v_r.id),
    'players',   (select count(*) from public.players p where p.room_id = v_room and p.kicked = false),
    'bots',      (select count(*) from public.players p where p.room_id = v_room and p.is_bot),
    'seats_total',  (select count(*) from public.seats s where s.room_id = v_room),
    'seats_taken',  (select count(*) from public.seats s
                      where s.room_id = v_room and s.current_owner_id is not null),
    'decided_sell', (select count(*) from public.listings l
                      where l.room_id = v_room and l.status = 'pending'),
    'listings_open',(select count(*) from public.listings l
                      where l.room_id = v_room and l.status = 'open'),
    'bids',         (select count(*) from public.bids b where b.room_id = v_room),
    'next_close',   (select min(l.ends_at) from public.listings l
                      where l.room_id = v_room and l.status = 'open'),
    'roster', (select coalesce(jsonb_agg(jsonb_build_object(
                 'id', p.id, 'nickname', p.nickname, 'bot', p.is_bot, 'house', p.is_house)
               order by p.joined_at), '[]'::jsonb)
                 from public.players p where p.room_id = v_room and p.kicked = false)
  );
end;
$$;

create or replace function public.admin_kick_player(
  p_room_code text, p_admin_token text, p_player uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_room uuid;
begin
  v_room := public._require_admin(p_room_code, p_admin_token);
  update public.players p set kicked = true where p.id = p_player and p.room_id = v_room;
  update public.rooms_public r
     set player_count = (select count(*) from public.players p
                          where p.room_id = v_room and p.kicked = false)
   where r.id = v_room;
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------
-- 봇 — 리허설이 가능해지는 유일한 길
-- ---------------------------------------------------------------------
-- 교사가 33명 앞에서 처음 돌려 보는 일은 없어야 한다. 봇을 불러
-- 혼자 전 과정을 두 번쯤 돌려 보면 버튼 순서가 몸에 익는다.
-- 정산·다중 낙찰·약정 초과·빈 시장 분기도 이것 없이는 검증할 방법이 없다.
create or replace function public.admin_spawn_bots(
  p_room_code text, p_admin_token text, p_count int)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_room uuid; v_face int; v_base int; v_out jsonb := '[]'::jsonb;
  v_id uuid; v_tok text; v_nick text; i int;
begin
  v_room := public._require_admin(p_room_code, p_admin_token);
  select r.face_value into v_face from public.rooms_public r where r.id = v_room;
  select count(*) into v_base from public.players p where p.room_id = v_room;

  if coalesce(p_count, 0) < 1 or p_count > 40 then
    return jsonb_build_object('ok', false, 'error', 'BAD_COUNT');
  end if;

  -- 정원을 지킨다. 예전에는 검사가 없어서 연습 중에 봇을 몇 번 부르면
  -- 참가자가 240명까지 불어났고, 명단을 잠그면 좌석 수가 그 인원 기준으로
  -- 계산돼 버렸다.
  if v_base + p_count > (select r.max_players from public.rooms_public r where r.id = v_room) then
    return jsonb_build_object('ok', false, 'error', 'ROOM_FULL', 'current', v_base);
  end if;

  for i in 1..p_count loop
    v_nick := public._nickname_for(v_base + i);
    v_tok  := encode(extensions.gen_random_bytes(32), 'base64');
    insert into public.players (room_id, nickname, is_bot)
         values (v_room, v_nick, true) returning id into v_id;
    insert into public.player_secrets (player_id, token_hash)
         values (v_id, extensions.digest(v_tok, 'sha256'));
    insert into public.wallets (player_id, room_id, initial, balance, seeded)
         values (v_id, v_room, 0, v_face, true);
    -- 키 이름을 join_room 의 반환값과 똑같이 맞춘다. 다르면 클라이언트가
    -- 조용히 undefined 를 보내고 인증이 계속 실패한다.
    v_out := v_out || jsonb_build_object('player_id', v_id, 'player_token', v_tok, 'nickname', v_nick);
  end loop;

  update public.rooms_public r
     set player_count = (select count(*) from public.players p
                          where p.room_id = v_room and p.kicked = false),
         dry_run = true
   where r.id = v_room;

  return jsonb_build_object('ok', true, 'bots', v_out);
end;
$$;

-- 기기가 없는 학생. 교사가 대신 자리를 만들어 주고 투표에는 참여시킨다.
create or replace function public.admin_add_house_player(p_room_code text, p_admin_token text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_room uuid; v_face int; v_n int; v_id uuid; v_tok text; v_nick text;
begin
  v_room := public._require_admin(p_room_code, p_admin_token);
  select r.face_value into v_face from public.rooms_public r where r.id = v_room;
  select count(*) into v_n from public.players p where p.room_id = v_room;

  v_nick := public._nickname_for(v_n + 1);
  v_tok  := encode(extensions.gen_random_bytes(32), 'base64');

  insert into public.players (room_id, nickname, is_house)
       values (v_room, v_nick, true) returning id into v_id;
  insert into public.player_secrets (player_id, token_hash)
       values (v_id, extensions.digest(v_tok, 'sha256'));
  insert into public.wallets (player_id, room_id, initial, balance, seeded)
       values (v_id, v_room, 0, v_face, true);

  update public.rooms_public r
     set player_count = (select count(*) from public.players p
                          where p.room_id = v_room and p.kicked = false)
   where r.id = v_room;

  return jsonb_build_object('ok', true, 'player_id', v_id, 'player_token', v_tok, 'nickname', v_nick);
end;
$$;

-- 11개 반이 끝난 뒤 정리. 방을 지우면 나머지는 CASCADE 로 따라간다.
create or replace function public.admin_purge_room(p_room_code text, p_admin_token text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_room uuid;
begin
  v_room := public._require_admin(p_room_code, p_admin_token);
  delete from public.rooms_public r where r.id = v_room;
  return jsonb_build_object('ok', true);
end;
$$;

-- =====================================================================
-- 복구 경로 — 교실에서 빠져나갈 길
-- =====================================================================
-- 아래 넷은 "그럴 일 없다"고 생각했다가 검토에서 전부 걸린 것들이다.
-- 교실에서 막다른 길에 몰리면 수업 한 시간이 통째로 날아간다.

-- 입장 다시 열기. 30명에서 잠갔는데 세 명이 늦게 들어오는 일은 반드시 생긴다.
-- 예매가 이미 돌았으면 좌석 수가 그 명단으로 확정돼 있으므로 거절한다.
create or replace function public.admin_reopen_join(p_room_code text, p_admin_token text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_room uuid;
begin
  v_room := public._require_admin(p_room_code, p_admin_token);

  if exists (select 1 from public.rooms_public r
              where r.id = v_room and r.booking_opens_at is not null) then
    return jsonb_build_object('ok', false, 'error', 'BOOKING_ALREADY_RAN');
  end if;

  -- 명단 잠금도 같이 푼다. 다시 잠글 때 늘어난 인원으로 좌석 수를 다시 센다.
  update public.rooms_public r
     set join_open = true, roster_frozen_at = null, phase = 'lobby'
   where r.id = v_room;

  delete from public.seats s where s.room_id = v_room and s.current_owner_id is null;

  return jsonb_build_object('ok', true);
end;
$$;

-- 만료 미루기. seed-rooms.sql 을 며칠 전에 돌려 두면 수업 당일 아침에
-- 학생 전원이 "방을 찾을 수 없습니다"만 보게 된다. 그런데 교사 조종석은
-- 멀쩡히 돌아서(관리자 인증은 만료를 보지 않는다) 원인을 짐작할 수도 없다.
create or replace function public.admin_extend_room(
  p_room_code text, p_admin_token text, p_days int)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_room uuid; v_exp timestamptz;
begin
  v_room := public._require_admin(p_room_code, p_admin_token);
  update public.rooms_public r
     set expires_at = clock_timestamp() + (interval '1 day' * greatest(1, least(coalesce(p_days, 30), 90)))
   where r.id = v_room
  returning r.expires_at into v_exp;
  return jsonb_build_object('ok', true, 'expires_at', v_exp);
end;
$$;

-- 방 초기화. 리허설을 마친 뒤, 또는 첫 반에서 꼬였을 때.
-- 방과 관리자 토큰은 그대로 두고 안의 것만 비운다. 관리자 토큰은 방 하나에만
-- 통하므로 다른 반의 결과는 건드릴 수 없다.
--
-- ("리셋 버튼 없음"으로 정했던 이유가 '다른 반 결과를 날릴까 봐'였는데,
--  토큰이 방에 묶여 있어서 그 위험이 없다. 반대로 복구 경로가 아예 없으면
--  첫 반에서 실수 한 번에 그 반 수업이 끝난다.)
create or replace function public.admin_reset_room(p_room_code text, p_admin_token text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_room uuid; v_gen int;
begin
  v_room := public._require_admin(p_room_code, p_admin_token);

  -- players 를 지우면 wallets/seats/listings/bids/votes 가 CASCADE 로 따라간다.
  delete from public.players  p where p.room_id = v_room;
  delete from public.listings l where l.room_id = v_room;
  delete from public.seats    s where s.room_id = v_room;
  delete from public.room_results rr where rr.room_id = v_room;

  update public.rooms_public r
     set generation = r.generation + 1,
         phase = 'lobby',
         join_open = false,
         dry_run = false,
         player_count = 0,
         seat_count = null,
         roster_frozen_at = null,
         wealth_distributed_at = null,
         auction_started_at = null,
         results_computed_at = null,
         booking_opens_at = null, booking_ends_at = null,
         prevote_ends_at = null, decide_ends_at = null, budget_ends_at = null,
         auction_ends_at = null, postvote_ends_at = null, finalvote_ends_at = null,
         vote_counts = '{}'::jsonb,
         results = null
   where r.id = v_room
  returning r.generation into v_gen;

  return jsonb_build_object('ok', true, 'generation', v_gen);
end;
$$;

-- 입장 열기. 방은 기본적으로 닫혀 있다 — 열려 있는 방은 주소를 아는
-- 누구나 들어와 가짜 참가자를 찍어낼 수 있기 때문이다. 수업 직전에 연다.
create or replace function public.admin_open_join(
  p_room_code text, p_admin_token text, p_max int)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_room uuid;
begin
  v_room := public._require_admin(p_room_code, p_admin_token);
  update public.rooms_public r
     set join_open = true,
         -- 실제 반 인원 + 여유 2명으로 상한을 조인다. 한 학생이 개발자도구로
         -- join_room 을 반복 호출해 가짜 참가자를 만들어도 몇 명에서 멈춘다.
         max_players = greatest(4, least(coalesce(p_max, r.max_players), 60))
   where r.id = v_room;
  return jsonb_build_object('ok', true);
end;
$$;



-- #####################################################################
-- ##  policies.sql
-- #####################################################################

-- =====================================================================
-- YM — RLS · 권한 · 실시간 발행
-- =====================================================================
-- 실행 순서: schema.sql -> functions.sql -> functions-admin.sql -> policies.sql
--
-- 전제: 교실의 학생 33명은 전부 '같은' anon 키를 쓴다. 로그인이 없으므로
-- auth.uid() 는 NULL 이고, "자기 지갑만 읽는다" 같은 정책을 쓸 방법이 없다.
-- 실시간이 돌아갈 만큼 느슨한 SELECT 정책은 곧 '그 행의 모든 칸'을 여는 것이다.
--
-- 그래서 테이블을 주제가 아니라 '가시성'으로 갈랐다.
--   공개 3개 : rooms_public / seats / listings  -> 읽기 허용 + 실시간 발행
--   잠금 6개 : room_secrets / players / player_secrets / wallets / bids / votes
--              -> 정책 0개, 권한 0개, 발행 안 함. RPC 반환값으로만 나간다.
-- =====================================================================

-- 기본값을 먼저 닫는다. 나중에 테이블을 추가해도 저절로 열리지 않는다.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- ---------------------------------------------------------------------
-- RLS 켜기 — 전부. 프로젝트 설정의 자동 RLS 트리거에 기대지 않는다.
-- ---------------------------------------------------------------------
-- 트리거가 있어도 여기 명시하는 이유: 이 파일 하나만 보고도 무엇이 잠겼는지
-- 알 수 있어야 하고, 트리거 없는 프로젝트에 다시 부어도 똑같이 동작해야 한다.
alter table public.rooms_public   enable row level security;
alter table public.seats          enable row level security;
alter table public.listings       enable row level security;
alter table public.room_secrets   enable row level security;
alter table public.players        enable row level security;
alter table public.player_secrets enable row level security;
alter table public.wallets        enable row level security;
alter table public.bids           enable row level security;
alter table public.votes          enable row level security;
alter table public.room_results   enable row level security;

-- ---------------------------------------------------------------------
-- 공개 3개 — 읽기만. 쓰기 정책은 하나도 만들지 않는다.
-- ---------------------------------------------------------------------
-- INSERT/UPDATE/DELETE 정책이 없으므로 학생은 개발자도구로도 이 테이블을
-- 고칠 수 없다. 모든 변경은 SECURITY DEFINER 함수를 통해서만 일어난다.
drop policy if exists ym_rooms_read    on public.rooms_public;
drop policy if exists ym_seats_read    on public.seats;
drop policy if exists ym_listings_read on public.listings;

create policy ym_rooms_read    on public.rooms_public for select to anon using (true);
create policy ym_seats_read    on public.seats        for select to anon using (true);
create policy ym_listings_read on public.listings     for select to anon using (true);

grant select on public.rooms_public to anon;
grant select on public.seats        to anon;
grant select on public.listings     to anon;

-- 잠금 테이블에는 정책도 GRANT 도 주지 않는다. 의도적으로 비워 둔 것이다.
-- 여기에 "읽기만이라도" 정책을 추가하는 순간 P3A 예산 공개 연출이 죽고,
-- 익명 투표가 익명이 아니게 된다.

-- ---------------------------------------------------------------------
-- 실시간 발행 — 세 가지가 다 맞아야 하고, 하나라도 빠지면 조용히 실패한다
-- ---------------------------------------------------------------------
-- (1) 발행 목록에 넣기 (2) 필요한 테이블만 REPLICA IDENTITY FULL
-- (3) anon 에 대한 SELECT 정책 + GRANT — 위에서 이미 했다.
do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public'
                    and tablename = 'rooms_public') then
    alter publication supabase_realtime add table public.rooms_public;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public'
                    and tablename = 'seats') then
    alter publication supabase_realtime add table public.seats;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public'
                    and tablename = 'listings') then
    alter publication supabase_realtime add table public.listings;
  end if;
end $$;

-- 좌석은 '누가 가져갔는지'를 이전 값과 비교해야 하는 순간이 있고 비밀이 없다.
-- listings 와 rooms_public 은 기본값으로 둔다 — 전체 행을 흘릴 이유가 없다.
alter table public.seats replica identity full;

-- ---------------------------------------------------------------------
-- 함수 실행 권한
-- ---------------------------------------------------------------------
-- 보조 함수(_auth_player, _min_bid, _nickname_for 등)에는 권한을 주지 않는다.
-- SECURITY DEFINER 함수 안에서는 소유자 권한으로 돌기 때문에 내부 호출은 된다.
--
-- 그런데 functions.sql 첫 줄의 'alter default privileges ... revoke execute
-- ... from public' 만으로는 부족하다. Supabase 프로젝트에는 자체적으로
-- 'ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon' 이 걸려 있어서,
-- 새로 만든 함수가 anon 에게 그대로 열린 채 /rest/v1/rpc/ 에 노출된다.
-- _auth_admin 까지 외부에서 부를 수 있게 되는 셈이라, 이름을 하나씩 짚어 회수한다.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       -- 밑줄로 시작하는 내부 함수 + 이름으로 짚는 것들.
       -- 교사 키 함수(ym_set_teacher_key / ym_clear_teacher_key)는 밑줄
       -- 그물에 걸리지 않는다. 그 둘은 이 파일 맨 끝 구간이 만들면서 직접
       -- 회수하지만, 이 파일을 다시 부었을 때도 닫혀 있어야 해서 여기
       -- 이름을 적어 둔다. 아직 없는 함수면 이 반복문이 그냥 지나간다.
       and (p.proname like '\_%'
            or p.proname in ('ym_bump_rev', 'ym_set_teacher_key', 'ym_clear_teacher_key'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;
revoke execute on function public.server_now()                          from public;
revoke execute on function public.join_room(text, text)                 from public;
revoke execute on function public.get_my_state(text, uuid, text)        from public;
revoke execute on function public.claim_seat(text, uuid, text, uuid)    from public;
revoke execute on function public.submit_decision(text, uuid, text, boolean, int, text) from public;
revoke execute on function public.place_bid(text, uuid, text, uuid, int) from public;
revoke execute on function public.settle_expired_listings(text)          from public;
revoke execute on function public.cast_vote(text, uuid, text, text, text) from public;

grant execute on function public.server_now()                           to anon;
grant execute on function public.join_room(text, text)                  to anon;
grant execute on function public.get_my_state(text, uuid, text)         to anon;
grant execute on function public.claim_seat(text, uuid, text, uuid)     to anon;
grant execute on function public.submit_decision(text, uuid, text, boolean, int, text) to anon;
grant execute on function public.place_bid(text, uuid, text, uuid, int)  to anon;
grant execute on function public.settle_expired_listings(text)           to anon;
grant execute on function public.cast_vote(text, uuid, text, text, text) to anon;

-- 교사용. 전부 관리자 토큰을 요구하므로 anon 에게 열어도 된다 —
-- 토큰이 없으면 첫 줄에서 42501 로 끊긴다.
revoke execute on function public.admin_lock_roster(text, text, int)       from public;
revoke execute on function public.admin_start_booking(text, text)          from public;
revoke execute on function public.admin_set_phase(text, text, text, int)   from public;
revoke execute on function public.admin_reopen_decide(text, text)          from public;
revoke execute on function public.admin_distribute_wealth(text, text)      from public;
revoke execute on function public.admin_start_auction(text, text, int)     from public;
revoke execute on function public.admin_force_settle(text, text)           from public;
revoke execute on function public.admin_compute_results(text, text)        from public;
revoke execute on function public.admin_state(text, text)                  from public;
revoke execute on function public.admin_kick_player(text, text, uuid)      from public;
revoke execute on function public.admin_spawn_bots(text, text, int)        from public;
revoke execute on function public.admin_add_house_player(text, text)       from public;
revoke execute on function public.admin_purge_room(text, text)             from public;

grant execute on function public.admin_lock_roster(text, text, int)        to anon;
grant execute on function public.admin_start_booking(text, text)           to anon;
grant execute on function public.admin_set_phase(text, text, text, int)    to anon;
grant execute on function public.admin_reopen_decide(text, text)           to anon;
grant execute on function public.admin_distribute_wealth(text, text)       to anon;
grant execute on function public.admin_start_auction(text, text, int)      to anon;
grant execute on function public.admin_force_settle(text, text)            to anon;
grant execute on function public.admin_compute_results(text, text)         to anon;
grant execute on function public.admin_state(text, text)                   to anon;
grant execute on function public.admin_kick_player(text, text, uuid)       to anon;
grant execute on function public.admin_spawn_bots(text, text, int)         to anon;
grant execute on function public.admin_add_house_player(text, text)        to anon;
grant execute on function public.admin_purge_room(text, text)              to anon;


-- 새로 추가된 복구용 교사 RPC
revoke execute on function public.admin_reopen_join(text, text)          from public;
revoke execute on function public.admin_extend_room(text, text, int)     from public;
revoke execute on function public.admin_reset_room(text, text)           from public;
revoke execute on function public.admin_open_join(text, text, int)       from public;

grant execute on function public.admin_reopen_join(text, text)           to anon;
grant execute on function public.admin_extend_room(text, text, int)      to anon;
grant execute on function public.admin_reset_room(text, text)            to anon;
grant execute on function public.admin_open_join(text, text, int)        to anon;

-- create_room 은 일부러 anon 에게 열지 않는다.
-- 방은 11개 반 것을 SQL 편집기에서 한 번만 만들고, 그때 관리자 토큰이
-- 딱 한 번 화면에 찍힌다. 웹에서 방을 만들 수 있게 열어 두면
-- 주소만 아는 사람이 방을 무한정 찍어낼 수 있다. seed-rooms.sql 참고.
revoke execute on function public.create_room(text) from public, anon, authenticated;





-- #####################################################################
-- ##  05-교사키.sql
-- #####################################################################

-- =====================================================================
-- YM 교사 키 — 반마다 다른 토큰 대신, 모든 반에 통하는 암호 하나
-- =====================================================================
-- 이 구간은 supabase/05-교사키.sql 과 같은 내용이다. 이미 설치한 사람은
-- 그 파일만 따로 돌리면 되고, 처음 설치하는 사람은 이 파일 하나로 끝난다.
--
-- 여기까지 실행해도 아직 달라지는 것은 없다. 교사 키를 '정하기 전'에는
-- teacher_secrets 가 비어 있고, 지금까지처럼 반별 토큰만 통한다.
-- 그게 기본값이자 되돌아간 상태다.
--
-- ⚠ 암호를 직접 고쳐 적는 줄은 이 파일 맨 아래 [2단계] 에 하나 있다.
--   이 파일은 GitHub Pages 로 공개되므로, 실제 암호를 여기 적어서
--   저장하거나 커밋하지 마세요. 고쳐 쓰는 곳은 SQL 편집기 안이다.
--
-- ⚠ 수업 중에는 실행하지 마세요. 판정 함수를 바꾸는 동안 교사용 RPC 가
--   잠깐 잠금에 걸린다. 60초 경매 중이면 그 반의 입찰이 밀린다.
-- =====================================================================

-- #####################################################################
-- ##  1단계 — 장치 설치. 이 파일을 통째로 Run 하면 여기까지 끝난다.
-- #####################################################################

-- ---------------------------------------------------------------------
-- 1-1. digest() 보증
-- ---------------------------------------------------------------------
-- 이미 schema.sql 이 깔아 두었으므로 사실상 아무 일도 안 한다.
-- 그래도 쓰는 이유: 이 파일 하나만 따로 돌리는 사람이 있을 때,
-- 없는 함수를 부르다 절반쯤 설치된 상태로 끝나는 것을 막는다.
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- 1-2. 정규화 자기검사 — 판정부를 바꾸기 '전에' 한다
-- ---------------------------------------------------------------------
-- normalize(x, NFC) 는 파서가 pg_catalog 의 함수로 직접 묶어 주는 SQL 표준
-- 구문이라 search_path = '' 안에서도 통한다. 그래도 여기서 한 번 돌려 보는
-- 이유: 이 서버에서 안 된다면 판정부가 교체된 '뒤에' 알게 되고, 그때는
-- 교사 키는 물론 반별 토큰마저 먹지 않는다. 미리 터뜨려서 앞에서 멈춘다.
do $$
declare v_probe text;
begin
  v_probe := normalize(btrim('  YM  '), NFC);
  if v_probe is distinct from 'YM' then
    raise exception '정규화 자기검사 실패 — 이 파일을 실행하지 마세요';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1-3. teacher_secrets — 교사 키 해시. 한 줄뿐이다.
-- ---------------------------------------------------------------------
-- 반별 토큰(room_secrets)은 남겨 둔다. 이 표의 한 줄을 지우면 즉시 예전
-- 방식으로 돌아간다 — 되돌릴 길을 코드가 아니라 데이터로 갖고 있는 편이
-- 안전하다. 코드를 되돌리려면 다시 SQL 을 부어야 하지만, 데이터는 한 줄이다.
--
-- 왜 한 줄(singleton)인가: 여러 줄을 허용하면 수업 3분 전에 "지금 살아 있는
-- 키가 어느 것이냐"를 판단해야 한다. 교체는 같은 줄의 upsert 이고 폐기는
-- delete 다. 판단할 것이 없다.
--
-- 왜 rooms_public 에 컬럼을 더하지 않았나: 그 표는 anon 이 select 로 읽고
-- 실시간으로 33대에 밀려 나간다. 컬럼 하나를 더하면 해시가 크롬북까지
-- 따라간다. 컬럼 단위 GRANT 는 PostgREST 의 select=* 를 깨뜨리고 논리
-- 복제는 컬럼 권한을 아예 무시한다 — 표를 나누는 쪽만 실제로 안전하다.
--
-- 왜 room_secrets 에 컬럼을 더하지 않았나: 교사 키 교체가 12행 UPDATE 가
-- 된다. 중간에 끊기면 반마다 다른 키가 되고, 그게 지금 없애려는 문제다.
--
-- 왜 public 스키마인가: policies.sql 의 'revoke all on all tables in schema
-- public' 과 'alter default privileges' 가 public 스키마에만 걸려 있다.
-- 별도 스키마를 만들면 그 잠금 장치를 통째로 비켜 간다.
create table if not exists public.teacher_secrets (
  id         smallint    primary key default 1,
  key_hash   bytea       not null,
  updated_at timestamptz not null default now(),
  constraint teacher_secrets_singleton_ck check (id = 1)
);

-- ---------------------------------------------------------------------
-- 1-4. 표를 만든 '직후' 잠근다
-- ---------------------------------------------------------------------
-- 순서가 곧 안전이다. 표가 존재하는데 아직 안 잠긴 구간을 만들지 않는다.
-- 'alter default privileges' 는 그것을 실행한 롤이 만든 객체에만 적용되므로,
-- SQL 편집기 롤이 policies.sql 을 돌린 롤과 다르면 조용히 비켜 간다.
-- 명시적 revoke 가 그 가정을 지운다.
alter table public.teacher_secrets enable row level security;

-- 정책은 '하나도' 만들지 않는다. RLS 가 켜져 있고 정책이 0개면 아무도
-- 못 읽는다. 여기에 "읽기만이라도" 정책을 더하는 순간 해시가 밖으로 나간다.
revoke all on public.teacher_secrets from public, anon, authenticated;

-- 실시간 발행 목록에 들어가면 RLS 도 권한도 소용이 없다 — 논리 복제는
-- 그 둘을 다 무시하고 행을 밀어낸다. 들어가 있으면 빼낸다.
do $$
declare v_all boolean;
begin
  select p.puballtables into v_all
    from pg_publication p where p.pubname = 'supabase_realtime';
  if v_all is not true and exists (
       select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public' and tablename = 'teacher_secrets') then
    alter publication supabase_realtime drop table public.teacher_secrets;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1-5. 판정부 — 교실 전체의 자물쇠는 이 함수 하나다
-- ---------------------------------------------------------------------
-- 반별 토큰과 교사 키를 '둘 다' 받는다. 어느 쪽도 아니면 NULL 이고,
-- 왜 아닌지는 알려주지 않는다.
--
-- 시그니처와 반환형을 그대로 둔다. 이 함수를 부르는 _require_admin,
-- 그리고 그것을 부르는 교사용 RPC 스물몇 개가 전부 이 모양에 묶여 있다.
-- 인자 이름이나 반환형을 바꾸면 create or replace 가 아니라 drop 이
-- 필요해지고, 그 순간 스물몇 개가 동시에 깨진다.
create or replace function public._auth_admin(p_room_code text, p_admin_token text)
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_room       uuid;
  v_tok        text;
  v_hash       bytea;
  v_room_ok    boolean;
  v_teacher_ok boolean;
begin
  -- (1) 빈 값을 '후보'로 만들지 않는다.
  --     digest('', 'sha256') 도 멀쩡한 32바이트 해시다. 여기서 안 끊으면
  --     실수로 빈 키가 저장된 날 빈 문자열이 11개 반을 전부 연다.
  --     NULL 은 digest 가 NULL 을 내고 '= NULL' 이 NULL 이라 어차피 안
  --     통하지만, 나중에 누가 'is not distinct from' 으로 바꾸는 순간
  --     뚫린다. 명시적으로 막아 둔다.
  --
  --     아래 한 줄은 ym_set_teacher_key 에 '똑같이' 들어 있다.
  --     한쪽만 고치지 마라 — 어긋나면 조용히, 영원히 안 맞는다.
  --     btrim 은 복사·붙여넣기 뒤에 붙는 공백을 지운다(교사가 겪는 "분명히
  --     맞게 쳤는데 안 돼요"의 1순위 원인). NFC 는 같은 글자가 기기마다
  --     다른 바이트로 들어오는 것을 막는다. 대소문자는 접지 않는다 —
  --     접으면 엔트로피가 깎인다.
  v_tok := normalize(btrim(coalesce(p_admin_token, '')), NFC);
  --     8자 하한이 기존 반별 토큰을 막는 일은 없다 — create_room 이 만드는
  --     반별 토큰은 32바이트 난수의 base64 라서 언제나 44자다.
  if length(v_tok) < 8 then
    return null;
  end if;

  -- (2) 방을 먼저 찾는다. 키가 맞아도 없는 방은 못 연다.
  --     방 코드는 create_room 이 upper(trim()) 으로 저장하므로 여기서도
  --     같이 맞춘다. 이 교체로 소문자 방 코드도 통과하게 된다(느슨해지는
  --     방향이다). 저장된 코드는 전부 대문자라 실질 영향은 없다.
  select r.id into v_room
    from public.rooms_public r
   where r.room_code = upper(btrim(coalesce(p_room_code, '')));
  if v_room is null then
    return null;
  end if;

  -- (3) 다이제스트는 한 번만 계산한다. 두 경로가 같은 값을 쓴다.
  v_hash := extensions.digest(v_tok, 'sha256');

  -- (4) 두 경로를 '둘 다' 끝까지 평가한다.
  --     or 로 단락 평가를 하면 교사 키 사용자와 반별 토큰 사용자의 응답
  --     시간이 갈라지고, 그 차이가 "이 방에 교사 키가 걸려 있나"를
  --     알려 준다.
  --
  --     비교 대상이 해시라는 점이 여기서 중요하다. bytea 비교가 첫 바이트에서
  --     끝나더라도 공격자는 그 바이트를 겨냥할 수 없다 — 겨냥하려면
  --     SHA-256 역상을 풀어야 한다. 조기 종료가 정보를 주지 않는다.
  v_room_ok := exists (
    select 1 from public.room_secrets s
     where s.room_id = v_room and s.admin_token_hash = v_hash);

  v_teacher_ok := exists (
    select 1 from public.teacher_secrets t
     where t.id = 1 and t.key_hash = v_hash);

  -- 교사 키를 아직 안 정했으면 teacher_secrets 가 비어 있고 v_teacher_ok 는
  -- false 다. 즉 아무 변화 없이 반별 토큰만 통한다. 그게 기본값이자
  -- 되돌아간 상태다.
  if v_room_ok or v_teacher_ok then
    return v_room;
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------
-- 1-6. _require_admin — 시그니처 · 반환형 그대로
-- ---------------------------------------------------------------------
-- 교사용 RPC 스물몇 개가 전부 이 두 인자를 이름으로 넘기고 uuid 를 받는다.
-- 인자 이름도 반환형도 바꾸지 않는다. 판정 로직은 _auth_admin 한 곳에만
-- 있고, 이 함수는 NULL 을 42501 로 바꾸는 껍데기다.
create or replace function public._require_admin(p_room_code text, p_admin_token text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_room uuid;
begin
  v_room := public._auth_admin(p_room_code, p_admin_token);
  if v_room is null then
    -- 실패는 언제나 같은 메시지, 같은 errcode 다.
    -- "그런 방 없음"과 "키 틀림"을 구분해 주면 대입 공격이 절반으로 줄어든다.
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  return v_room;
end;
$$;

-- ---------------------------------------------------------------------
-- 1-7. 교사 키를 정하고 · 지우는 함수 — SQL 편집기 전용
-- ---------------------------------------------------------------------
-- 인자 1개, 오버로드 없음, DEFAULT 인자 없음.
create or replace function public.ym_set_teacher_key(p_key text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_key text;
begin
  -- (A) 웹에서 온 호출은 여기서 끝낸다.
  --     아래 1-8 의 EXECUTE 회수가 본 자물쇠이고, 이건 그 자물쇠가 언젠가
  --     풀렸을 때를 위한 두 번째 자물쇠다. 웹 API 는 언제나 authenticator
  --     라는 로그인 롤로 접속한 뒤 set role 로 갈아탄다. 권한 높은 키로
  --     와도 '로그인' 롤은 바뀌지 않으므로 여기서 함께 막힌다.
  --     SECURITY DEFINER 는 current_user 만 바꾸고 session_user 는 못 바꾼다.
  if session_user in ('authenticator', 'anon', 'authenticated') then
    raise exception 'sql_editor_only' using errcode = '42501';
  end if;

  -- 이 한 줄은 _auth_admin 에 '똑같이' 들어 있다. 한쪽만 고치지 마라.
  v_key := normalize(btrim(coalesce(p_key, '')), NFC);

  -- (B) 짧은 키 금지. 이 키 하나가 11개 반 전부를 연다.
  --     32바이트 난수였던 자리에 사람이 정한 문장이 들어온다 —
  --     길이가 유일한 방어선이다. 8자 미만은 거부한다. 4자리 숫자는 만 가지뿐이라 스크립트로 1분에 뚫린다.
  --     (지연(pg_sleep)으로 대입을 늦추는 방법은 쓰지 않는다. 실패마다
  --      잠들면 공격자가 커넥션을 붙잡고, 같은 풀을 쓰는 학생들의 RPC 가
  --      같이 죽는다. 수업을 멈추는 방어는 방어가 아니다.)
  if length(v_key) < 8 then
    raise exception 'key_too_short' using errcode = '22023',
      hint = '교사 키는 8자 이상이어야 합니다. 띄어쓰기 포함 한 문장을 권합니다.';
  end if;

  insert into public.teacher_secrets (id, key_hash, updated_at)
       values (1, extensions.digest(v_key, 'sha256'), now())
  on conflict (id) do update
       set key_hash = excluded.key_hash, updated_at = excluded.updated_at;

  -- (C) 지문(해시 앞자리)을 돌려주지 않는다. 몇 글자만 흘려도 사람이 정한
  --     암호에 대해서는 오프라인 후보 검증기를 쥐여 주는 셈이다.
  --     "됐다"는 ok 와 시각으로 충분하고, 확인은 실제로 반을 열어 보면 된다.
  return jsonb_build_object('ok', true, 'updated_at', now());
end;
$$;

-- 인자 0개. 이 한 줄을 실행하면 즉시 반별 토큰 전용으로 돌아간다.
create or replace function public.ym_clear_teacher_key()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  if session_user in ('authenticator', 'anon', 'authenticated') then
    raise exception 'sql_editor_only' using errcode = '42501';
  end if;

  delete from public.teacher_secrets where id = 1;

  return jsonb_build_object('ok', true, 'cleared', true);
end;
$$;

-- ---------------------------------------------------------------------
-- 1-8. 이름을 짚어 회수 — 반드시 함수를 만든 '뒤'에 온다
-- ---------------------------------------------------------------------
-- policies.sql 의 회수 DO 블록은 이름이 밑줄로 시작하는 함수만 훑는다.
-- ym_set_teacher_key 는 그 그물에 걸리지 않는다. 그런데 이 프로젝트에는
-- 'alter default privileges ... grant all on functions to anon' 이 걸려
-- 있어서, 새 함수는 태어나자마자 /rest/v1/rpc/ 로 열린다.
-- 이름을 짚어 회수하지 않으면 주소만 아는 사람이 교사 키를 바꿀 수 있다.
--
-- 회수가 함수 생성보다 '먼저' 오면 아무 일도 안 한 것이 된다. 순서가 곧 안전이다.
-- (create or replace 는 기존 함수의 권한을 보존하므로 _auth_admin /
--  _require_admin 은 교체해도 다시 열리지 않는다. 아래 마지막 두 줄은 재확인용이다.
--  위험한 것은 '새 이름' 둘뿐이다.)
revoke all on function public.ym_set_teacher_key(text)   from public, anon, authenticated;
revoke all on function public.ym_clear_teacher_key()     from public, anon, authenticated;
revoke all on function public._auth_admin(text, text)    from public, anon, authenticated;
revoke all on function public._require_admin(text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 1-9. 설치 검증 — 조용하면 통과다
-- ---------------------------------------------------------------------
-- 하나라도 어긋나면 예외를 던진다. 통째로 붙여넣어 한 번에 실행하면 전체가
-- 한 트랜잭션으로 돌기 때문에, 여기서 터지면 위의 설치가 통째로 취소된다 —
-- 반쯤 열린 채로 남는 것보다 아무것도 안 바뀐 편이 낫다.
-- 화면에 빨간 글씨가 없으면 아래 아홉 가지가 전부 통과한 것이다.
do $$
declare v_bad text := '';
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    raise exception '이 프로젝트에 anon 롤이 없습니다 — 설치 대상이 맞는지 확인하세요';
  end if;

  -- (1) 표를 학생이 만질 수 있는가
  if has_table_privilege('anon', 'public.teacher_secrets', 'select, insert, update, delete') then
    v_bad := v_bad || ' / teacher_secrets 를 anon 이 만질 수 있음';
  end if;

  -- (2) 정책이 하나라도 생겼는가 (정책이 생기면 그 순간 열린다)
  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'teacher_secrets') then
    v_bad := v_bad || ' / teacher_secrets 에 정책이 생겼음';
  end if;

  -- (3) RLS 가 켜져 있는가
  if not (select c.relrowsecurity from pg_class c
           where c.oid = 'public.teacher_secrets'::regclass) then
    v_bad := v_bad || ' / teacher_secrets 의 RLS 가 꺼져 있음';
  end if;

  -- (4) 실시간 발행 목록에 들어갔는가 (들어가면 RLS 도 권한도 무시된다)
  if exists (select 1 from pg_publication_tables
              where schemaname = 'public' and tablename = 'teacher_secrets') then
    v_bad := v_bad || ' / teacher_secrets 가 실시간 발행 목록에 있음';
  end if;

  -- (5)~(8) 웹에서 부를 수 있게 된 함수가 있는가
  if has_function_privilege('anon', 'public.ym_set_teacher_key(text)', 'execute') then
    v_bad := v_bad || ' / ym_set_teacher_key 가 웹에 열려 있음';
  end if;
  if has_function_privilege('anon', 'public.ym_clear_teacher_key()', 'execute') then
    v_bad := v_bad || ' / ym_clear_teacher_key 가 웹에 열려 있음';
  end if;
  if has_function_privilege('anon', 'public._auth_admin(text,text)', 'execute') then
    v_bad := v_bad || ' / _auth_admin 이 웹에 열려 있음';
  end if;
  if has_function_privilege('anon', 'public._require_admin(text,text)', 'execute') then
    v_bad := v_bad || ' / _require_admin 이 웹에 열려 있음';
  end if;

  -- (9) 빈 암호가 저장되는가 — 말로 확인하지 않고 실제로 시켜 본다.
  --     거부당하는 것이 정상이다. 만에 하나 저장되면 위에서 취소된다.
  begin
    perform public.ym_set_teacher_key('');
    -- 여기까지 왔다면 빈 키가 저장된 것이다. 일부러 예외를 던져 그 쓰기를
    -- 되돌린다 — 검사 하나 때문에 교사의 진짜 키가 빈 값으로 덮이면 안 된다.
    raise exception '빈 키가 저장되었다' using errcode = 'YM001';
  exception
    when sqlstate '22023' or sqlstate '42501' then null;  -- 기대한 거부다
    when sqlstate 'YM001' then v_bad := v_bad || ' / 빈 교사 키가 거부되지 않음';
  end;

  if length(v_bad) > 0 then
    raise exception '설치 검증 실패:%', v_bad;
  end if;
end $$;

-- PostgREST 는 스키마를 캐시한다. 권한을 다 정리한 '뒤' 마지막에 알린다.
-- 먼저 알리면 회수 전의 권한 상태가 그대로 캐시된다.
-- (스키마 알림은 이 파일 맨 끝에서 한 번만 한다.)


-- #####################################################################
-- #####################################################################
-- ##
-- ##   2단계 — 여기가 '암호를 직접 고쳐 적는' 단 한 줄입니다
-- ##
-- #####################################################################
-- #####################################################################
--
--  아래 한 줄을 SQL 편집기에 '새로' 붙여넣고, 따옴표 안을 당신의 교사 키로
--  바꾼 다음, 그 한 줄만 드래그해서 Run 하세요.
--
--      select public.ym_set_teacher_key('여기에 교사 키를 적으세요 8자 이상');
--
--  지켜야 할 것
--    · 8자 미만은 서버가 거부한다(22023 key_too_short).
--    · 8자 이상. 한글 낱말 + 숫자를 섞는다 (예: 팝콘도둑4712).
--    · 영문 + 숫자 + 띄어쓰기로. 한글은 기기마다 자판이 달라 오타를 부른다.
--    · 이 줄을 이 파일에 적어서 저장하지 마세요. 이 파일은 공개된다.
--    · 주소창에 키를 넣지 마세요. 교탁 PC 화면은 TV 에 그대로 미러링된다.
--    · 성공하면 {"ok": true, "updated_at": ...} 가 나온다. 해시는 안 돌려준다 —
--      몇 글자만 흘려도 암호를 맞춰 보는 도구가 된다.
--
--  다 되면 확인 (두 줄을 연달아 실행)
--      select public.ym_set_teacher_key('정한 키를 그대로');
--      select public._require_admin('YM2-TEST', '정한 키를 그대로');
--    두 번째 줄이 uuid 를 뱉으면 성공이다. 42501 이 나오면 두 줄의 키가
--    글자 하나 다른 것이다(앞뒤 공백은 서버가 알아서 지운다).
--    YM2-TEST 방이 아직 없다면 seed-rooms.sql 을 먼저 돌린 뒤에 확인하세요.
--
--  그 다음 : admin.html 의 토큰 칸에 반별 토큰 대신 이 교사 키를 붙여넣는다.
--    반을 고르는 칸은 그대로 두고, 어느 반을 골라도 열린다.
--
--
-- #####################################################################
-- ##   3단계 — 되돌리기 (필요할 때만)
-- #####################################################################
--
--  교사 키를 폐기하고 예전처럼 반별 토큰만 쓰려면 한 줄이면 된다.
--
--      select public.ym_clear_teacher_key();
--
--  키가 샌 것 같을 때는 폐기가 아니라 '교체'가 빠르다 — 2단계를 새 키로
--  한 번 더 실행하면 이전 키는 그 순간 죽는다(표에 한 줄뿐이다).
--
--  키가 샜을 때 실제로 위험한 것 : 방 비우기 · 초기화 RPC 다. 그래서
--  admin.html 의 '한 번 더 눌러야 실행되는' 2단계 버튼이 이제 사실상
--  마지막 방어선이다. 그 버튼을 한 번 누름으로 바꾸지 마세요.
--
--  학기말 정리 (실제 폭발 반경을 줄이는 가장 확실한 방법)
--      delete from public.rooms_public where room_code like 'YM2-%';
-- #####################################################################


notify pgrst, 'reload schema';


-- #####################################################################
-- #####################################################################
-- ##  06-여러개사기.sql  — 경매 다석(多席) 허용
-- #####################################################################
-- #####################################################################
--
--  이 합본에서 06 의 '내용' 은 이미 위 구간에 녹아 있다.
--    · seats.acquired_via 컬럼 + seats_via_ck + 백필 + 사전 점검
--      + seats_one_booking_per_player 인덱스 + 옛 제약 제거
--                                        -> schema.sql 구간의 seats 부분
--    · listings_one_lead_per_bidder 제거 -> schema.sql 구간의 listings 부분
--    · rooms_public.max_seats_per_bidder -> schema.sql 구간의 rooms_public 부분
--    · 함수 여섯 개(get_my_state / claim_seat / submit_decision / place_bid
--      / settle_expired_listings / admin_compute_results)
--                                        -> functions.sql · functions-admin.sql 구간
--
--  그래서 여기서는 두 가지만 한다.
--    (1) 함수 여섯 개의 실행 권한을 한 번 더 확인한다 (멱등).
--    (2) 06-여러개사기.sql 과 '똑같은' 설치 검증을 돌린다. 새로 설치하는
--        사람도 교사와 같은 자기시험을 받아야 한다.
--
--  함수 본문을 여기에 또 적지 않는 이유: 사본이 둘이 되면 반드시 갈라진다.
--  이 합본에서 함수를 고칠 곳은 위의 functions 구간 하나뿐이다.
--
--  바뀐 동작의 요약과 되돌리는 법은 supabase/06-여러개사기.sql 의 머리말을
--  읽으세요. 이미 쓰고 있는 프로젝트에는 이 합본이 아니라 그 파일을 돌립니다.
-- #####################################################################

-- #####################################################################
-- ##  3단계 — 권한 재확인 (멱등)
-- #####################################################################
--
-- create or replace 는 기존 함수의 ACL 을 보존하므로 사실 아무 일도 안 한다.
-- 그래도 적는 이유: 이 프로젝트에는 Supabase 자체의
-- 'alter default privileges ... grant all on functions to anon' 이 걸려
-- 있어서, 어떤 이유로든 함수가 '새로' 만들어지는 경우와 반대로 권한이
-- 빠지는 경우가 모두 조용하다. policies.sql 의 해당 줄을 글자 그대로 옮겼다.
revoke execute on function public.get_my_state(text, uuid, text)        from public;
revoke execute on function public.claim_seat(text, uuid, text, uuid)    from public;
revoke execute on function public.submit_decision(text, uuid, text, boolean, int, text) from public;
revoke execute on function public.place_bid(text, uuid, text, uuid, int) from public;
revoke execute on function public.settle_expired_listings(text)          from public;
revoke execute on function public.admin_compute_results(text, text)        from public;

grant execute on function public.get_my_state(text, uuid, text)         to anon;
grant execute on function public.claim_seat(text, uuid, text, uuid)     to anon;
grant execute on function public.submit_decision(text, uuid, text, boolean, int, text) to anon;
grant execute on function public.place_bid(text, uuid, text, uuid, int)  to anon;
grant execute on function public.settle_expired_listings(text)           to anon;
grant execute on function public.admin_compute_results(text, text)         to anon;


-- #####################################################################
-- ##  4단계 — 설치 검증. 조용하면 통과다.
-- #####################################################################
--
-- 아래 세 블록은 하나라도 어긋나면 예외를 던진다. 통째로 붙여넣어 한 번에
-- 실행하면 전체가 한 트랜잭션으로 돌기 때문에, 여기서 터지면 위의 설치가
-- 통째로 취소된다 — 반쯤 바뀐 채로 남는 것보다 아무것도 안 바뀐 편이 낫다.
-- 화면에 빨간 글씨가 없으면 전부 통과한 것이다.
--
--   4-1  표와 함수의 '모양' 을 본다 (있는가 / 유일한가 / 이름이 그대로인가)
--   4-2  인덱스에 실제로 시켜 본다 (예매 두 개는 막히고 경매 두 개는 되는가)
--   4-3  정산을 실제로 돌려 본다 (돈이 맞는가 / 화면 계약이 맞는가)
--
-- 4-2 와 4-3 은 임시 방을 만들어 진짜로 해 보고, 마지막에 일부러 예외를
-- 던져 흔적을 통째로 되돌린다. 말로 확인하지 않고 시켜 보는 쪽이 낫다 —
-- 이 파일에서 틀리면 교실에서만 드러나는 종류의 실수들이기 때문이다.
-- (되돌린 쓰기는 논리 복제로 나가지 않으므로 학생 화면에 아무것도 안 뜬다.)

-- ---------------------------------------------------------------------
-- 4-1. 모양 검사
-- ---------------------------------------------------------------------
do $$
declare
  v_bad text := '';
  v_has boolean;
  r     record;
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    raise exception '이 프로젝트에 anon 롤이 없습니다 — 설치 대상이 맞는지 확인하세요';
  end if;

  -- (1) 새 컬럼 둘
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'seats'
                    and column_name = 'acquired_via' and is_nullable = 'NO') then
    v_bad := v_bad || ' / seats.acquired_via 가 없거나 NULL 을 허용함';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'rooms_public'
                    and column_name = 'max_seats_per_bidder') then
    v_bad := v_bad || ' / rooms_public.max_seats_per_bidder 가 없음';
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'seats_via_ck'
                    and conrelid = 'public.seats'::regclass) then
    v_bad := v_bad || ' / seats_via_ck 가 없음';
  end if;

  -- (2) 새 그물이 '유일' 하고 '부분' 인덱스인가.
  --     유일하지 않으면 예매 1인 1석이 아무도 지키지 않는 규칙이 되고,
  --     술어가 없으면 다석 낙찰이 커밋 시점에 터진다. 둘 다 확인한다.
  if not exists (select 1 from pg_index i
                  join pg_class c on c.oid = i.indexrelid
                  join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public'
                   and c.relname = 'seats_one_booking_per_player'
                   and i.indisunique
                   and i.indpred is not null) then
    v_bad := v_bad || ' / seats_one_booking_per_player 가 없거나 유일·부분 인덱스가 아님';
  end if;

  -- (3) 옛 그물 둘이 정말 사라졌는가
  if exists (select 1 from pg_constraint
              where conname = 'seats_one_per_player'
                and conrelid = 'public.seats'::regclass) then
    v_bad := v_bad || ' / 옛 제약 seats_one_per_player 가 남아 있음';
  end if;
  if exists (select 1 from pg_indexes
              where schemaname = 'public'
                and indexname = 'listings_one_lead_per_bidder') then
    v_bad := v_bad || ' / 옛 인덱스 listings_one_lead_per_bidder 가 남아 있음';
  end if;

  -- (4) 지금 데이터가 새 규칙과 맞는가
  if exists (select 1 from public.seats
              where current_owner_id is not null and acquired_via = 'booking'
              group by room_id, current_owner_id having count(*) > 1) then
    v_bad := v_bad || ' / 예매 좌석을 두 개 이상 가진 학생이 있음';
  end if;

  -- (5) 함수 여섯 개 — 있는가 / 인자 이름이 그대로인가 / anon 이 부를 수 있는가.
  --     PostgREST 는 인자 '이름' 으로 함수를 찾는다. 이름이 하나라도
  --     달라지면 학생 기기에서 함수를 못 찾고, 원인은 화면에 드러나지 않는다.
  for r in
    select * from (values
      ('public.get_my_state(text, uuid, text)',
       array['p_room_code','p_player','p_token']),
      ('public.claim_seat(text, uuid, text, uuid)',
       array['p_room_code','p_player','p_token','p_seat']),
      ('public.submit_decision(text, uuid, text, boolean, int, text)',
       array['p_room_code','p_player','p_token','p_sell','p_opening','p_reason']),
      ('public.place_bid(text, uuid, text, uuid, int)',
       array['p_room_code','p_player','p_token','p_listing','p_amount']),
      ('public.settle_expired_listings(text)',
       array['p_room_code']),
      ('public.admin_compute_results(text, text)',
       array['p_room_code','p_admin_token'])
    ) as t(sig, names)
  loop
    if to_regprocedure(r.sig) is null then
      v_bad := v_bad || ' / 함수가 없음: ' || r.sig;
    else
      if (select p.proargnames from pg_proc p where p.oid = r.sig::regprocedure)
         is distinct from r.names then
        v_bad := v_bad || ' / 인자 이름이 바뀜: ' || r.sig;
      end if;
      if not has_function_privilege('anon', r.sig, 'execute') then
        v_bad := v_bad || ' / anon 이 부를 수 없음: ' || r.sig;
      end if;
    end if;
  end loop;

  -- (6) 오버로드가 생기지 않았는가. PostgREST 는 오버로드를 만나면
  --     "could not choose the best candidate function" 으로 죽는다.
  for r in
    select p.proname, count(*) as n
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('get_my_state','claim_seat','submit_decision','place_bid',
                         'settle_expired_listings','admin_compute_results')
     group by p.proname having count(*) > 1
  loop
    v_bad := v_bad || ' / 같은 이름의 함수가 둘 이상: ' || r.proname;
  end loop;

  -- (7) 지뢰 — 옛 본문이 남아 있는가, 새 본문이 실제로 들어갔는가.
  --     'set constraints' 한 줄이 남으면 그 반은 정산이 되지 않는다.
  --     want=true 는 있어야 하는 것, want=false 는 없어야 하는 것이다.
  for r in
    select * from (values
      ('settle_expired_listings', 'set constraints',          false),
      ('settle_expired_listings', 'seats_one_per_player defe', false),
      ('settle_expired_listings', 'acquired_via',             true),
      ('settle_expired_listings', 'as materialized',          true),
      ('settle_expired_listings', 'ledger',                   true),
      ('place_bid',               'HAVE_SEAT',                false),
      ('place_bid',               'ALREADY_LEADING_ANOTHER',  false),
      ('place_bid',               'ym:bid:',                  true),
      ('place_bid',               'deadlock_detected',        true),
      ('place_bid',               'max_seats_per_bidder',     true),
      ('claim_seat',              'ALREADY_HAVE_SEAT',        true),
      ('claim_seat',              'not exists',               true),
      ('get_my_state',            'my_seats',                 true),
      ('get_my_state',            'seat_count_mine',          true),
      ('get_my_state',            'my_listings',              true),
      ('get_my_state',            'leads',                    true),
      ('get_my_state',            'committed',                true),
      ('get_my_state',            'available',                true),
      ('submit_decision',         'order by s.row_label, s.seat_no', true),
      ('admin_compute_results',   'buyer',                    true),
      ('admin_compute_results',   'holders',                  true),
      ('admin_compute_results',   'swept',                    true),
      ('admin_compute_results',   'acquired_via',             true),
      ('admin_compute_results',   'no_seat',                  true),
      ('admin_compute_results',   'priced_out',               true),
      ('admin_compute_results',   'multiple',                 true),
      ('admin_compute_results',   'reasons',                  true)
    ) as t(fn, needle, want)
  loop
    -- prosrc 에는 주석도 들어 있다. 그래서 '옛 코드가 남았는가' 를 날것으로
    -- 검사하면, 그 코드를 '지웠다' 고 설명하는 주석 자체에 걸려 언제나
    -- 실패한다(설계 명세의 검증 쿼리가 실제로 이 함정에 빠졌다).
    -- 줄 주석을 먼저 지우고 본다. 정규식에는 POSIX 문자클래스만 쓴다 —
    -- 백슬래시 이스케이프를 손으로 적으면 진짜 제어문자가 소스에 섞인다.
    select (regexp_replace(p.prosrc, '--[^[:cntrl:]]*', '', 'g')
            like '%' || r.needle || '%') into v_has
      from pg_proc p
     where p.proname = r.fn and p.pronamespace = 'public'::regnamespace;
    if v_has is null then
      v_bad := v_bad || ' / 함수 본문을 읽을 수 없음: ' || r.fn;
    elsif v_has <> r.want then
      if r.want then
        v_bad := v_bad || ' / ' || r.fn || ' 에 [' || r.needle || '] 가 없음';
      else
        v_bad := v_bad || ' / ' || r.fn || ' 에 옛 코드 [' || r.needle || '] 가 남아 있음';
      end if;
    end if;
  end loop;

  if length(v_bad) > 0 then
    raise exception '설치 검증 실패(모양):%', v_bad;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 4-2. 인덱스에 실제로 시켜 본다
-- ---------------------------------------------------------------------
-- "예매 좌석 두 개는 거부되고, 경매 좌석 두 개는 허용된다" 를 말로 확인하지
-- 않고 진짜로 해 본다. 술어를 한 글자라도 잘못 적으면 여기서 잡힌다.
-- 끝에서 일부러 예외를 던져 임시 방을 통째로 되돌린다. plpgsql 변수
-- (v_bad)는 서브트랜잭션 롤백으로 되돌아가지 않으므로 판정 결과는 살아남는다.
do $$
declare
  v_bad  text := '';
  v_code text;
  v_room uuid;
  v_p    uuid;
begin
  begin
    v_code := 'YM-CHK-' || upper(substr(md5(random()::text), 1, 8));
    insert into public.rooms_public (room_code) values (v_code) returning id into v_room;
    insert into public.players (room_id, nickname) values (v_room, 'CHK ONE')
    returning id into v_p;

    -- (1) 예매 좌석 하나 — 되어야 한다.
    insert into public.seats (room_id, row_label, seat_no, seat_label, current_owner_id)
         values (v_room, 'Z', 1, 'Z1', v_p);

    -- (2) 예매 좌석 두 개 — 막혀야 한다.
    begin
      insert into public.seats (room_id, row_label, seat_no, seat_label, current_owner_id)
           values (v_room, 'Z', 2, 'Z2', v_p);
      v_bad := v_bad || ' / 예매 좌석을 두 개 가질 수 있음(1인 1석 인덱스가 안 걸렸다)';
    exception
      when unique_violation then null;         -- 기대한 거부다
    end;

    -- (3) 경매 좌석 두 개 — 되어야 한다. 이게 교사 요구 (나) 다.
    begin
      insert into public.seats (room_id, row_label, seat_no, seat_label,
                                current_owner_id, acquired_via)
           values (v_room, 'Z', 3, 'Z3', v_p, 'auction');
      insert into public.seats (room_id, row_label, seat_no, seat_label,
                                current_owner_id, acquired_via)
           values (v_room, 'Z', 4, 'Z4', v_p, 'auction');
    exception
      when unique_violation then
        v_bad := v_bad || ' / 경매 좌석 다석이 막혀 있음(인덱스 술어가 잘못됐다)';
    end;

    -- (4) 'booking' / 'auction' 이 아닌 값 — 막혀야 한다.
    begin
      insert into public.seats (room_id, row_label, seat_no, seat_label, acquired_via)
           values (v_room, 'Z', 5, 'Z5', 'gift');
      v_bad := v_bad || ' / acquired_via 에 아무 값이나 들어감(seats_via_ck 가 없다)';
    exception
      when check_violation then null;          -- 기대한 거부다
    end;

    raise exception '자기시험 되돌리기' using errcode = 'YM060';
  exception
    when sqlstate 'YM060' then null;           -- 흔적을 되돌린다
    when others then
      v_bad := v_bad || ' / 자기시험 중 예상 못한 오류: ' || sqlerrm;
  end;

  if length(v_bad) > 0 then
    raise exception '설치 검증 실패(인덱스):%', v_bad;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 4-3. 정산을 실제로 돌려 본다 — 이 파일에서 가장 중요한 검사
-- ---------------------------------------------------------------------
-- 임시 방에 판 사람 넷, 산 사람 둘, 마감된 매물 넷을 만들고 정산을 부른다.
--
--   B1  잔액 70,000 — Z1(30,000) · Z2(40,000) 선두. 합 70,000 → 둘 다 낙찰
--   B2  잔액 50,000 — Z3(40,000) · Z4(30,000) 선두. 합 70,000 → 비싼 것만
--                      낙찰되고 Z4 는 유찰. 배치는 그래도 커밋된다
--
-- 이 한 번으로 다음이 전부 확인된다.
--   · 'set constraints' 잔재로 42704 가 나지 않는다
--   · 한 사람이 두 개를 낙찰받는다 (교사 요구 (나))
--   · 두 개를 낙찰받은 사람이 두 개 값을 '다' 낸다 (돈이 창조되지 않는다)
--   · 낙찰 좌석의 acquired_via 가 'auction' 이 되어 1인 1석 인덱스를 통과한다
--   · 잔액이 모자란 매물은 배치 전체를 롤백하지 않고 그 한 건만 유찰된다
--   · get_my_state 가 좌석 두 개짜리 학생에게 21000 을 내지 않는다
--   · results 에 기존 키가 하나도 사라지지 않았고 buyer 별명이 들어 있다
do $$
declare
  v_bad  text := '';
  v_code text;
  v_room uuid;
  v_one  uuid;
  v_seat uuid;
  v_p    uuid[] := array[]::uuid[];
  v_s    uuid[] := array[]::uuid[];
  v_b1   uuid;
  v_b2   uuid;
  v_js   jsonb;
  v_res  jsonb;
  v_int  int;
  i      int;
  r      record;
begin
  begin
    v_code := 'YM-CHK-' || upper(substr(md5(random()::text), 1, 8));

    insert into public.rooms_public (room_code, phase, face_value, seat_count, player_count)
         values (v_code, 'auction', 20000, 4, 6)
    returning id into v_room;

    -- 교사 토큰. admin_compute_results 를 실제로 불러 보기 위해서다.
    insert into public.room_secrets (room_id, admin_token_hash)
         values (v_room, extensions.digest('ym-self-check', 'sha256'));

    -- 판 사람 넷. 각자 예매 좌석 하나씩(전부 'booking').
    for i in 1..4 loop
      insert into public.players (room_id, nickname) values (v_room, 'CHK SELL ' || i::text)
      returning id into v_one;
      v_p := v_p || v_one;
      insert into public.wallets (player_id, room_id, initial, balance, seeded)
           values (v_one, v_room, 0, 0, true);
      insert into public.seats (room_id, row_label, seat_no, seat_label, current_owner_id)
           values (v_room, 'Z', i, 'Z' || i::text, v_one)
      returning id into v_seat;
      v_s := v_s || v_seat;
    end loop;

    -- 산 사람 둘.
    insert into public.players (room_id, nickname) values (v_room, 'CHK BUY 1')
    returning id into v_b1;
    insert into public.wallets (player_id, room_id, initial, balance, seeded)
         values (v_b1, v_room, 70000, 70000, true);
    insert into public.player_secrets (player_id, token_hash)
         values (v_b1, extensions.digest('ym-self-check', 'sha256'));

    insert into public.players (room_id, nickname) values (v_room, 'CHK BUY 2')
    returning id into v_b2;
    insert into public.wallets (player_id, room_id, initial, balance, seeded)
         values (v_b2, v_room, 50000, 50000, true);

    -- 마감된 매물 넷. ends_at 이 이미 지났으므로 정산 대상이다.
    insert into public.listings (room_id, seat_id, seller_id, seat_label, opening_bid,
                                 highest_bid, highest_bidder_id, reason_code, status, ends_at)
    values
      (v_room, v_s[1], v_p[1], 'Z1', 20000, 30000, v_b1, 'need_money',  'open',
       clock_timestamp() - interval '2 seconds'),
      (v_room, v_s[2], v_p[2], 'Z2', 20000, 40000, v_b1, 'wants_more',  'open',
       clock_timestamp() - interval '2 seconds'),
      (v_room, v_s[3], v_p[3], 'Z3', 20000, 40000, v_b2, 'free_trade',  'open',
       clock_timestamp() - interval '2 seconds'),
      (v_room, v_s[4], v_p[4], 'Z4', 20000, 30000, v_b2, 'my_seat',     'open',
       clock_timestamp() - interval '2 seconds');

    -- ===== 정산 =====
    v_js := public.settle_expired_listings(v_code);
    if (v_js ->> 'ok') is distinct from 'true' then
      v_bad := v_bad || ' / 정산이 실패했다: ' || coalesce(v_js ->> 'error', '?');
    end if;
    if (v_js ->> 'settled')::int is distinct from 4 then
      v_bad := v_bad || ' / 정산 건수가 4가 아님: ' || coalesce(v_js ->> 'settled', 'null');
    end if;

    -- 낙찰 3건 · 유찰 1건
    select count(*) into v_int from public.listings l
     where l.room_id = v_room and l.status = 'sold';
    if v_int <> 3 then
      v_bad := v_bad || ' / 낙찰이 3건이 아님: ' || v_int::text;
    end if;
    select count(*) into v_int from public.listings l
     where l.room_id = v_room and l.status = 'unsold' and l.seat_label = 'Z4';
    if v_int <> 1 then
      v_bad := v_bad || ' / 잔액 부족분(Z4)이 유찰되지 않았음';
    end if;

    -- 돈. 여기가 틀리면 교실에 돈이 창조된 것이다.
    select w.balance into v_int from public.wallets w where w.player_id = v_b1;
    if v_int <> 0 then
      v_bad := v_bad || ' / 두 개를 낙찰받은 학생이 두 개 값을 다 내지 않았음(잔액 '
               || v_int::text || ', 0이어야 한다)';
    end if;
    select w.balance into v_int from public.wallets w where w.player_id = v_b2;
    if v_int <> 10000 then
      v_bad := v_bad || ' / 한 개만 낙찰받은 학생의 잔액이 10000이 아님: ' || v_int::text;
    end if;
    select w.balance into v_int from public.wallets w where w.player_id = v_p[1];
    if v_int <> 30000 then
      v_bad := v_bad || ' / 판 사람 1의 입금이 30000이 아님: ' || v_int::text;
    end if;
    select w.balance into v_int from public.wallets w where w.player_id = v_p[2];
    if v_int <> 40000 then
      v_bad := v_bad || ' / 판 사람 2의 입금이 40000이 아님: ' || v_int::text;
    end if;
    select w.balance into v_int from public.wallets w where w.player_id = v_p[4];
    if v_int <> 0 then
      v_bad := v_bad || ' / 유찰인데 판 사람 4에게 돈이 들어갔음: ' || v_int::text;
    end if;

    -- 좌석. 다석 + acquired_via.
    select count(*) into v_int from public.seats s
     where s.room_id = v_room and s.current_owner_id = v_b1 and s.acquired_via = 'auction';
    if v_int <> 2 then
      v_bad := v_bad || ' / 낙찰 좌석 두 개가 한 사람에게 가지 않았음: ' || v_int::text;
    end if;
    select count(*) into v_int from public.seats s
     where s.room_id = v_room and s.current_owner_id = v_p[4] and s.acquired_via = 'booking';
    if v_int <> 1 then
      v_bad := v_bad || ' / 유찰 좌석이 판 사람에게 남지 않았음';
    end if;

    -- ===== 화면 계약 — get_my_state =====
    -- 좌석 두 개짜리 학생을 일부러 고른다. 옛 본문이면 여기서 21000 이 난다.
    v_js := public.get_my_state(v_code, v_b1, 'ym-self-check');
    if (v_js ->> 'ok') is distinct from 'true' then
      v_bad := v_bad || ' / get_my_state 가 ok 를 주지 않았음';
    end if;
    if ((v_js -> 'me') ->> 'seat_count_mine')::int is distinct from 2 then
      v_bad := v_bad || ' / me.seat_count_mine 이 2가 아님';
    end if;
    if jsonb_array_length((v_js -> 'me') -> 'my_seats') <> 2 then
      v_bad := v_bad || ' / me.my_seats 가 두 칸이 아님';
    end if;
    if ((v_js -> 'me') -> 'my_seat') = 'null'::jsonb then
      v_bad := v_bad || ' / 호환용 me.my_seat 이 비었음(옛 화면이 깨진다)';
    end if;
    for r in
      select * from (values
        ('player_id'),('nickname'),('balance'),('initial'),('votes'),('has_budget'),
        ('my_seat'),('my_listing'),('leading'),
        ('my_seats'),('seat_count_mine'),('my_listings'),('leads'),
        ('committed'),('available')
      ) as t(k)
    loop
      if not ((v_js -> 'me') ? r.k) then
        v_bad := v_bad || ' / get_my_state.me 에 키가 없음: ' || r.k;
      end if;
    end loop;

    -- ===== 화면 계약 — results =====
    v_res := public.admin_compute_results(v_code, 'ym-self-check') -> 'results';
    for r in
      select * from (values
        -- 기존 키. 하나라도 사라지면 프로젝터가 그리지 못한다.
        ('face_value'),('players'),('seat_count'),('listed'),('sold'),('unsold'),
        ('avg_price'),('max_price'),('min_price'),('received'),('no_seat'),
        ('priced_out'),('multiple'),('seats'),('reasons'),('votes'),
        -- 더한 키.
        ('holders'),('buyers'),('swept'),('swept_seats'),('max_seats_one_buyer')
      ) as t(k)
    loop
      if not (v_res ? r.k) then
        v_bad := v_bad || ' / results 에 키가 없음: ' || r.k;
      end if;
    end loop;
    if (v_res ->> 'sold')::int <> 3 or (v_res ->> 'unsold')::int <> 1 then
      v_bad := v_bad || ' / results 의 낙찰/유찰 수가 3/1이 아님';
    end if;
    if (v_res ->> 'no_seat')::int <> 3 then
      v_bad := v_bad || ' / results.no_seat 이 3이 아님: ' || (v_res ->> 'no_seat');
    end if;
    if (v_res ->> 'holders')::int <> 3 then
      v_bad := v_bad || ' / results.holders 가 3이 아님: ' || (v_res ->> 'holders');
    end if;
    if (v_res ->> 'swept')::int <> 1 or (v_res ->> 'swept_seats')::int <> 2
       or (v_res ->> 'max_seats_one_buyer')::int <> 2 then
      v_bad := v_bad || ' / results 의 쓸어담기 집계가 1/2/2가 아님';
    end if;
    -- 교사 요구 (다) — 좌석 칸에 산 사람 별명이 들어 있는가.
    select count(*) into v_int
      from jsonb_array_elements(v_res -> 'seats') x
     where (x ->> 'state') = 'sold' and (x ->> 'buyer') is not null;
    if v_int <> 3 then
      v_bad := v_bad || ' / results.seats 의 낙찰 칸에 buyer 별명이 없음: ' || v_int::text;
    end if;
    select count(*) into v_int
      from jsonb_array_elements(v_res -> 'seats') x
     where (x ->> 'via') = 'auction';
    if v_int <> 3 then
      v_bad := v_bad || ' / results.seats 의 via 가 auction 인 칸이 3이 아님: ' || v_int::text;
    end if;
    -- 판 사람 별명은 '없어야' 한다. 익명 사유 벽이 그것으로 깨진다.
    if (v_res -> 'seats' -> 0) ?| array['seller','holder','owner'] then
      v_bad := v_bad || ' / results.seats 에 판 사람을 가리키는 키가 들어갔음';
    end if;

    raise exception '자기시험 되돌리기' using errcode = 'YM061';
  exception
    when sqlstate 'YM061' then null;           -- 흔적을 되돌린다
    when others then
      v_bad := v_bad || ' / 자기시험 중 예상 못한 오류: ' || sqlstate || ' ' || sqlerrm;
  end;

  if length(v_bad) > 0 then
    raise exception '설치 검증 실패(정산):%', v_bad;
  end if;
end $$;


-- PostgREST 에 알린다. 합본의 마지막 줄이다.
notify pgrst, 'reload schema';
