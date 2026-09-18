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

notify pgrst, 'reload schema';
