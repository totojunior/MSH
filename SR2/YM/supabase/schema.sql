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
  rev               bigint not null default 0,
  constraint seats_room_label_uq unique (room_id, row_label, seat_no)
);

-- 1인 1좌석. NULL 은 서로 다르게 취급되므로 빈 좌석끼리는 충돌하지 않는다.
-- 부분 인덱스가 아니라 CONSTRAINT 여야 한다 — 정산 트랜잭션 안에서
-- SET CONSTRAINTS ... DEFERRED 로 잠시 미뤄야 좌석이 손을 바꿀 수 있다.
alter table public.seats drop constraint if exists seats_one_per_player;
alter table public.seats add  constraint seats_one_per_player
  unique (room_id, current_owner_id) deferrable initially immediate;

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

-- 한 사람은 동시에 한 매물에서만 최고입찰자가 될 수 있다.
-- WHERE 절로 검사하면 동시 입찰에서 새어 나간다. 인덱스로 막아야 확실하다.
-- 닫힌 매물은 낙찰자를 그대로 들고 있어야 하므로 여기만 부분 인덱스다.
create unique index if not exists listings_one_lead_per_bidder
  on public.listings (room_id, highest_bidder_id)
  where status = 'open' and highest_bidder_id is not null;

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
