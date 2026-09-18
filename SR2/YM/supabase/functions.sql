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

-- 교사 키(모든 반에 통하는 암호 하나)를 쓰고 싶으면 05-교사키.sql 을 이어서
-- 돌린다. 그 파일이 이 함수를 '반별 토큰 또는 교사 키' 판정으로 통째로
-- 교체한다. 여기 있는 것이 반별 토큰 전용 원본이다.
-- 왜 새 본문을 이 파일에 넣지 않았나: 새 본문은 teacher_secrets 표를 읽는데,
-- 그 표는 05-교사키.sql 이 만든다. 여기에 넣어 두면 네 파일만 부은 프로젝트에서
-- 교사용 RPC 전부가 "그런 표 없음"으로 죽는다 — 교사 키는커녕 반별 토큰도
-- 못 쓰게 된다. 없는 기능은 없는 채로 두고, 있는 기능은 반드시 살려 둔다.
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

notify pgrst, 'reload schema';
