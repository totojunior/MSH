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

create or replace function public._require_admin(p_room_code text, p_admin_token text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_room uuid;
begin
  v_room := public._auth_admin(p_room_code, p_admin_token);
  if v_room is null then
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
        'my_seat',  (select jsonb_build_object('id', s.id, 'label', s.seat_label)
                       from public.seats s
                      where s.room_id = v_room.id and s.current_owner_id = v_me),
        'my_listing', (select jsonb_build_object(
                          'id', l.id, 'seat_label', l.seat_label, 'opening_bid', l.opening_bid,
                          'highest_bid', l.highest_bid, 'status', l.status,
                          'final_price', l.final_price, 'ends_at', l.ends_at)
                         from public.listings l
                        where l.room_id = v_room.id and l.seller_id = v_me),
        'leading',  (select jsonb_build_object('listing_id', l.id, 'seat_label', l.seat_label,
                                               'amount', l.highest_bid)
                       from public.listings l
                      where l.room_id = v_room.id and l.status = 'open'
                        and l.highest_bidder_id = v_me),
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
           claimed_at = clock_timestamp()
     where s.id = p_seat
       and s.room_id = v_room.id
       and s.current_owner_id is null
    returning s.seat_label into v_label;
  exception
    -- 1인 1좌석 제약에 걸렸다 = 이미 다른 좌석이 있다.
    when unique_violation then
      return jsonb_build_object('ok', false, 'error', 'ALREADY_HAVE_SEAT');
  end;

  if v_label is null then
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

  select s.id, s.seat_label into v_seat, v_label
    from public.seats s where s.room_id = v_room.id and s.current_owner_id = v_me;
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
  v_min     int;
  v_cap     timestamptz;
  v_newend  timestamptz;
  v_ext     boolean := false;
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
  -- 여기서 막힌다. 잔액 검사와 '한 좌석만 1등' 검사가 이 잠금 덕에 안전해진다.
  perform 1 from public.wallets w where w.player_id = v_me for update;

  select w.balance into v_bal from public.wallets w where w.player_id = v_me;

  -- 좌석을 가진 사람은 입찰하지 않는다. 한 사람 한 장.
  if exists (select 1 from public.seats s
              where s.room_id = v_room.id and s.current_owner_id = v_me) then
    return jsonb_build_object('ok', false, 'error', 'HAVE_SEAT');
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
  if p_amount > v_bal then
    return jsonb_build_object('ok', false, 'error', 'NO_MONEY', 'balance', v_bal);
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
  -- 정산 트랜잭션이 커밋되면 "좌석 없음"과 "잔액 충분"이 둘 다 옛날 얘기가
  -- 된다. 그러면 좌석을 이미 받은 학생이 다른 매물의 1등으로 올라앉고,
  -- 정산은 1인 1좌석 제약에 걸려 COMMIT 시점에 통째로 롤백된다 —
  -- 그리고 매물은 만료된 채 계속 남아 영원히 같은 실패를 반복한다.
  -- 그래서 두 조건을 '이기는 UPDATE' 의 WHERE 안에서 다시 확인한다.
  -- 여기서는 EvalPlanQual 이 최신 행을 다시 읽어 주므로 빈틈이 없다.
  begin
    update public.listings l
       set highest_bid = p_amount,
           highest_bidder_id = v_me,
           ends_at = v_newend
     where l.id = p_listing
       and l.status = 'open'
       and clock_timestamp() < l.ends_at
       and coalesce(l.highest_bid, 0) = coalesce(v_row.highest_bid, 0)   -- 낙관적 잠금
       and not exists (select 1 from public.seats s
                        where s.room_id = v_room.id and s.current_owner_id = v_me)
       and p_amount <= (select w.balance from public.wallets w where w.player_id = v_me)
    returning l.* into v_row;
  exception
    -- 이미 다른 매물에서 1등이다. WHERE 가 아니라 인덱스가 잡아낸다.
    when unique_violation then
      return jsonb_build_object('ok', false, 'error', 'ALREADY_LEADING_ANOTHER');
  end;

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

  -- 좌석이 손을 바꾸는 동안만 1인 1좌석 제약을 미룬다.
  set constraints public.seats_one_per_player deferred;

  -- 낙찰 여부를 '입찰 시점의 판단'이 아니라 '지금 이 순간의 실제 상태'로
  -- 다시 정한다. 낙찰자가 그 사이에 다른 좌석을 갖게 되었거나 잔액이
  -- 모자라면 그 매물만 조용히 유찰로 떨어뜨린다.
  --
  -- 이게 핵심이다. 예전 판본은 그런 이상 상태를 만나면 제약 위반으로
  -- 트랜잭션 전체가 롤백됐고, 매물은 만료된 채 그대로 남아 다음 호출이
  -- 똑같이 실패했다. 초당 17번씩, 수업이 끝날 때까지. 교사가 쓸 수 있는
  -- 탈출구도 없었다 — 강제 마감도 같은 함수를 지나가기 때문이다.
  -- 이상은 한 건만 잃고, 배치는 반드시 커밋된다.
  with expired as (
    select l.id, l.seat_id, l.seller_id, l.highest_bid, l.highest_bidder_id,
           (l.highest_bidder_id is not null
            and not exists (select 1 from public.seats s
                             where s.room_id = v_room and s.current_owner_id = l.highest_bidder_id)
            and coalesce((select w.balance from public.wallets w
                           where w.player_id = l.highest_bidder_id), 0) >= l.highest_bid
           ) as wins
      from public.listings l
     where l.room_id = v_room
       and l.status = 'open'
       and l.settled_at is null
       and clock_timestamp() >= l.ends_at
       for update
  ),
  closed as (
    update public.listings l
       set status      = case when e.wins then 'sold' else 'unsold' end,
           final_price = case when e.wins then e.highest_bid else null end,
           settled_at  = clock_timestamp()
      from expired e
     where l.id = e.id
    returning l.id, l.seat_id, l.seller_id, l.final_price, l.highest_bidder_id, l.status
  ),
  moved as (
    update public.seats s
       set current_owner_id = c.highest_bidder_id,
           claimed_at = clock_timestamp()
      from closed c
     where s.id = c.seat_id and c.status = 'sold'
    returning s.id
  ),
  paid as (
    update public.wallets w
       set balance = w.balance - c.final_price
      from closed c
     where w.player_id = c.highest_bidder_id and c.status = 'sold'
    returning w.player_id
  ),
  got as (
    update public.wallets w
       set balance = w.balance + c.final_price
      from closed c
     where w.player_id = c.seller_id and c.status = 'sold'
    returning w.player_id
  )
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
  v_res jsonb; v_minsold int; v_priced_out int; v_noseat int;
begin
  v_room := public._require_admin(p_room_code, p_admin_token);

  select r.face_value, r.player_count into v_face, v_n
    from public.rooms_public r where r.id = v_room;

  select min(l.final_price) into v_minsold
    from public.listings l where l.room_id = v_room and l.status = 'sold';

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
    -- 좌석별 최종 가격. 되팔리지 않은 좌석은 액면가 그대로다.
    'seats', coalesce((
      select jsonb_agg(jsonb_build_object(
               'label', s.seat_label, 'row', s.row_label, 'no', s.seat_no,
               'price', coalesce(l.final_price, v_face),
               'state', case when l.status = 'sold' then 'sold'
                             when l.status = 'unsold' then 'unsold'
                             else 'kept' end)
             order by s.row_label, s.seat_no)
        from public.seats s
        left join public.listings l on l.seat_id = s.id and l.status in ('sold','unsold')
       where s.room_id = v_room), '[]'::jsonb),
    -- 익명 사유 벽. 시장을 옹호하는 논거를 사이트가 아니라 학생이 낸다.
    'reasons', coalesce((
      select jsonb_object_agg(x.reason_code, x.n) from (
        select l.reason_code, count(*) as n from public.listings l
         where l.room_id = v_room and l.reason_code is not null
         group by l.reason_code) x), '{}'::jsonb),
    'votes', (select r.vote_counts from public.rooms_public r where r.id = v_room)
  ) into v_res;

  update public.rooms_public r
     set results = v_res, results_computed_at = clock_timestamp()
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
-- 정산·1인1좌석·빈 시장 분기도 이것 없이는 검증할 방법이 없다.
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
       and (p.proname like '\_%' or p.proname = 'ym_bump_rev')
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



notify pgrst, 'reload schema';
