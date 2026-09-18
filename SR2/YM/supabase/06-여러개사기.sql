-- =====================================================================
--  YM 경매 — 좌석을 여러 개 살 수 있게. 예매는 그대로 1인 1석.
-- =====================================================================
--  이 파일이 하는 일 (교사가 요구한 셋)
--    (가) 이미 좌석을 가진 학생도 경매에서 살 수 있다. 지금은 입찰 자체가
--         막혀 있다.
--    (나) 한 사람이 좌석을 여러 개 낙찰받을 수 있다. 돈이 많으면 여러 개.
--    (다) 결과 화면에 좌석별로 '누가 얼마에 샀는지' 가 별명과 함께 나온다.
--
--  왜 이 변경이 수업에 옳은가
--    돈 많은 학생이 두세 개를 쓸어가면 좌석 없는 학생이 늘어난다. 경매가
--    '가장 원하는 사람' 이 아니라 '가장 돈 많은 사람' 에게 준다는 샌델의
--    논점이 더 선명해진다. 1인 1석 제한은 그 논점을 인공적으로 가리고 있었다.
--
--  실행 위치 : Supabase 대시보드 > SQL Editor
--  실행 방법 : 이 파일을 '통째로' 붙여넣고 한 번 Run 하세요. 쪼개지 마세요.
--              왜: SQL Editor 는 붙여넣은 스크립트 전체를 하나의 트랜잭션으로
--              돌린다. 이 파일은 그 성질에 의존한다. 둘로 쪼개 두 번 Run 하면
--              그 사이 몇 초 동안 정산 함수가 42704 로 전멸한다 — 옛 제약은
--              사라졌는데 그 제약을 부르는 옛 함수가 남기 때문이다. 그 몇 초에
--              어느 반의 경매가 돌고 있으면 그 반은 낙찰이 되지 않는다.
--  실행 횟수 : 한 번이면 끝난다. 몇 번을 돌려도 결과가 같게 만들어 두었다.
--  실행 시점 : 수업 중에는 실행하지 마세요. 함수 여섯 개를 교체하는 동안
--              학생용·교사용 RPC 가 순간 잠금에 걸린다. 교시 사이에 하세요.
--
--  먼저 할 일 : 봇으로 한 바퀴 리허설. 조종석에서 봇 소환 → 명단 잠그기 →
--              예매 → 가질까팔까 → 예산 → 경매 시작 → 강제 마감 → 결과.
--              '강제 마감이 실제로 정산되는지' 를 눈으로 보는 것이 이
--              변경에서 가장 중요합니다. 정산이 한 번 막히면 그 반의 경매는
--              되돌릴 방법이 없습니다.
--
--  무엇이 바뀌는가 — 표
--    seats.acquired_via                 새 컬럼. 'booking' | 'auction'
--    seats_one_per_player               제거. 1인 1좌석 절대 금지였다
--    seats_one_booking_per_player       새 부분 유일 인덱스. 예매 좌석만 1인 1석
--    listings_one_lead_per_bidder       제거. 한 사람 한 매물 선두였다
--    rooms_public.max_seats_per_bidder  새 컬럼. NULL = 무제한(기본값)
--
--  무엇이 바뀌는가 — 함수 여섯 개. 인자 이름·형·반환형은 하나도 바뀌지 않는다
--    get_my_state             my_seats / seat_count_mine / my_listings /
--                             leads / committed / available 추가.
--                             my_seat · my_listing · leading 은 호환용으로 남긴다
--    claim_seat               예매 1인 1석을 WHERE 와 인덱스 둘로 지킨다
--    submit_decision          좌석이 여러 개인 학생에게 첫 좌석 하나를 고른다
--    place_bid                HAVE_SEAT 삭제. '약정' 회계 도입
--    settle_expired_listings  set constraints 삭제. 다중 낙찰 · 통합 원장
--    admin_compute_results    seats[].buyer / via + holders / buyers /
--                             swept / swept_seats / max_seats_one_buyer 추가.
--                             기존 키는 하나도 지우지 않았다 — 더하기만 했다
--
--  돈 계산이 어떻게 안전해지는가 (한 문단으로)
--    '한 사람 한 매물 선두' 인덱스를 떼면 초과 지출 방어선이 통째로 사라진다.
--    그 자리를 '약정(committed)' 규칙이 대신한다:
--        이번 입찰액 + (이번 매물을 뺀) 내가 선두인 열린 매물들의 합 <= 내 잔액
--    약정은 어디에도 저장하지 않는다. listings 에서 매번 유도하므로, 남이 내
--    선두를 빼앗는 순간 셈에서 저절로 빠진다 — 풀어 주는 코드도, 보상
--    트랜잭션도, 크론도 없다. 이 프로젝트에는 스케줄러가 없으니 그게 유일하게
--    성립하는 설계다. 그리고 이 판정은 '이기는 UPDATE 의 WHERE 안' 에 있다.
--    검사와 쓰기가 분리되면 33명이 동시에 누를 때 지갑이 음수가 된다.
--
--  화면(JS)은 나중에 배포해도 된다
--    호환용 키 셋(my_seat / my_listing / leading)을 남겨 두었으므로 SQL 을
--    먼저 배포해도 옛 화면이 그대로 돈다. 반대 순서(JS 먼저)는 하지 마세요 —
--    새 키가 아직 서버에 없다.
--
--  한 반이 뒤집혔을 때의 손잡이 (기본값은 '무제한' 이다)
--    한 명이 좌석을 쓸어가 교실 절반이 20분간 구경꾼이 되면, 논점은 선명해도
--    수업 운영이 망가진다. 두 가지 길이 있습니다.
--      1) 좌석을 늘린다 — 조종석의 명단 잠그기에서 좌석 수를 직접 넣는다
--         (55% 상한까지). 이게 먼저 쓸 카드다.
--      2) 상한을 건다 — SQL 편집기에서 한 줄. 그 반에만 걸린다.
--            update public.rooms_public set max_seats_per_bidder = 3
--             where room_code = 'YM2-1';
--         다시 풀 때는 같은 줄에 null 을 넣는다.
--         이 값이 NULL 인 동안에는 교사가 요구한 동작(무제한)이 그대로다.
--
--  되돌리는 법 : 이 파일 맨 아래 [되돌리기] 를 읽으세요.
--    ⚠ 다석 낙찰이 한 번이라도 일어난 뒤에는 자동 롤백이 불가능합니다.
-- =====================================================================


-- #####################################################################
-- ##  1단계 — 표 바꾸기
-- #####################################################################

-- ---------------------------------------------------------------------
-- 1-1. digest() 보증
-- ---------------------------------------------------------------------
-- 이미 schema.sql 이 깔아 두었으므로 사실상 아무 일도 안 한다. 그래도 쓰는
-- 이유: 아래 4단계의 자기시험이 digest() 를 쓴다. 없는 함수를 부르다
-- 절반쯤 설치된 상태로 끝나는 것을 막는다.
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- 1-2. seats 에 '이 좌석을 어떻게 얻었나' 를 적는다
-- ---------------------------------------------------------------------
-- 이 한 칸이 "예매는 1인 1석, 경매는 여러 개" 를 표 차원에서 갈라 준다.
-- default 'booking' 인 이유: 기존 행은 전부 예매로 잡힌 좌석이거나 빈
-- 좌석이다. 과거 수업에서 이미 낙찰된 좌석만 1-4 의 백필이 바로잡는다.
-- (PG11+ 는 기본값 있는 NOT NULL 컬럼 추가도 메타데이터만 바꾸므로
--  13행짜리 표에서는 즉시 끝난다. 표가 잠기지 않는다.)
alter table public.seats
  add column if not exists acquired_via text not null default 'booking';

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

-- ---------------------------------------------------------------------
-- 1-3. 좌석 수 상한 칸 — 기본값 NULL = 무제한
-- ---------------------------------------------------------------------
-- 교사가 요구한 동작이 그대로 기본값이다. 이 칸은 11개 반 중 한 반이
-- 뒤집혔을 때만 쓴다. 머리말의 '손잡이' 를 보세요.
alter table public.rooms_public
  add column if not exists max_seats_per_bidder int;

-- ---------------------------------------------------------------------
-- 1-4. 백필 — 과거 수업에서 이미 낙찰된 좌석을 'auction' 으로
-- ---------------------------------------------------------------------
-- 없어도 1-6 의 인덱스는 통과한다(옛 제약이 1인 1석을 지켜 왔으므로).
-- 그래도 하는 이유: 의미를 맞춰 두지 않으면 4단계의 검증이 거짓말을 한다.
-- 'and s.acquired_via <> ''auction''' 덕에 두 번 돌려도 0행이다.
update public.seats s
   set acquired_via = 'auction'
  from public.listings l
 where l.seat_id = s.id
   and l.status = 'sold'
   and s.current_owner_id is not null
   and s.current_owner_id = l.highest_bidder_id
   and s.acquired_via <> 'auction';

-- ---------------------------------------------------------------------
-- 1-5. 사전 점검 — 인덱스를 만들기 '전에' 사람이 읽을 말로 끊는다
-- ---------------------------------------------------------------------
-- 여기서 raise 가 나면 원인이 한 줄로 보이고, 통째로 한 번 Run 했으므로
-- 설치 전체가 취소된다. 반쯤 바뀐 채 남는 것보다 아무것도 안 바뀐 편이 낫다.
--
-- 세는 대상이 '예매 좌석' 인 것이 중요하다. 백필 '뒤' 에 오기 때문에,
-- 다석 낙찰이 한 번이라도 일어난 뒤에도 이 점검은 통과한다 — 그때는 한
-- 학생이 좌석을 여러 개 갖는 것이 정상이고, 그중 예매 좌석만 하나여야
-- 한다. (이 파일을 두 번 Run 해도 여기서 막히지 않는 이유가 이것이다.)
do $$
declare v int;
begin
  select count(*) into v from (
    select 1 from public.seats
     where current_owner_id is not null and acquired_via = 'booking'
     group by room_id, current_owner_id having count(*) > 1) x;
  if v > 0 then
    raise exception '예매 좌석을 두 개 이상 가진 학생이 이미 % 명 있습니다. 먼저 확인이 필요합니다.', v;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1-6. 새 그물을 먼저 걸고, 옛 그물 둘을 뗀다 — 이 순서
-- ---------------------------------------------------------------------
-- 한 트랜잭션이라 논리적 차이는 없지만, 파일을 사람이 읽을 때 의도가 드러난다.
--
-- create index concurrently 를 쓰지 않는다. 트랜잭션 블록에서는 실행 자체가
-- 안 되고, 전부-또는-전무 성질이 깨진다. 좌석은 한 반에 13행이다.
--
-- 왜 CONSTRAINT 가 아니라 부분 인덱스인가: 옛 제약은 좌석이 손을 바꾸는
-- 정산 한 문장 '안' 에서 유일성이 순간 깨지기 때문에 SET CONSTRAINTS ...
-- DEFERRED 가 필요했다. 새 술어에서는 정산의 UPDATE 가 좌석을 술어 '밖'
-- 으로 내보낸다('booking' -> 'auction'). 술어를 만족하지 않는 새 행 버전은
-- 인덱스에 항목을 만들지 않고, 삽입이 없으면 충돌도 없다. 그래서 지연이
-- 필요 없고, 부분 인덱스는 애초에 지연이 불가능하다는 사실도 문제가 되지 않는다.
create unique index if not exists seats_one_booking_per_player
  on public.seats (room_id, current_owner_id)
  where current_owner_id is not null and acquired_via = 'booking';

alter table public.seats drop constraint if exists seats_one_per_player;

-- 한 사람이 동시에 여러 매물의 최고입찰자가 될 수 있게 된다. 이 인덱스가
-- (나) 를 막는 장치이면서 동시에 초과 지출 방어선 전부였다 — 그 자리는
-- place_bid 의 약정 규칙이 대신한다(머리말 참고).
drop index if exists public.listings_one_lead_per_bidder;


-- #####################################################################
-- ##  2단계 — 함수 여섯 개 교체
-- #####################################################################
--
-- create or replace 다. drop 하지 않는다.
--   · 인자 이름·형·반환형을 하나도 바꾸지 않았으므로 replace 로 끝난다.
--   · 그래야 policies.sql 의 GRANT 가 그대로 살아 있고, PostgREST 가 인자
--     '이름' 으로 계속 함수를 찾는다. 오버로드도 DEFAULT 인자도 만들지 않는다.
--
-- 교체 순서: get_my_state -> claim_seat -> submit_decision -> place_bid ->
--            settle_expired_listings -> admin_compute_results.
-- settle_expired_listings 의 교체가 1단계보다 늦어도 안전한 이유: 한
-- 트랜잭션이므로 외부에서는 제약 제거와 함수 교체가 '동시에' 일어난다.
-- 두 파일로 쪼개 두 번 Run 하면 그 사이 몇 초 동안 42704 로 정산이
-- 전멸한다. 절대 쪼개지 마세요.

-- ---------------------------------------------------------------------
-- 2-1. get_my_state — '내 좌석' 을 복수로
-- ---------------------------------------------------------------------
-- 스칼라 서브쿼리로 두면 좌석이 두 개인 학생의 이 함수가 21000
-- (more than one row returned by a subquery used as an expression) 으로
-- 죽는다. 이 함수는 학생 화면의 전부를 실어 오므로 그 학생의 화면이 통째로
-- 멈춘다 — 그것도 경매 도중에, 이 수업이 주인공으로 삼은 부자 학생부터.
-- 그래서 이 함수를 '가장 먼저' 교체한다.
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

-- ---------------------------------------------------------------------
-- 2-2. claim_seat — 예매는 그대로 1인 1석
-- ---------------------------------------------------------------------
-- 인덱스만으로도 기능은 완결되지만, 흔한 경우가 예외 경로를 타는 건 좋지
-- 않다. WHERE 의 not exists 가 평소를 처리하고, 인덱스가 최후의 그물이다.
-- 0행의 이유를 둘로 갈라('남이 먼저' / '내가 이미 가짐') 학생에게 다른
-- 문장을 준다.
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

-- ---------------------------------------------------------------------
-- 2-3. submit_decision — 좌석이 여러 개일 때
-- ---------------------------------------------------------------------
-- 에러는 아니었지만 '임의의 한 좌석' 을 골랐다(비결정적). 경매 뒤에
-- admin_reopen_decide 를 누르면 실제로 도달할 수 있는 경로다.
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

-- ---------------------------------------------------------------------
-- 2-4. place_bid — 좌석이 있어도, 여러 개라도 살 수 있게
-- ---------------------------------------------------------------------
-- 바뀌는 것 넷.
--   (1) 지갑 행 FOR UPDATE -> 플레이어별 자문 잠금. 정산과의 AB-BA 교착을
--       구조적으로 없앤다(정산은 listings -> wallets 순으로 잡는다).
--   (2) HAVE_SEAT 사전 검사 삭제 — 교사 요구 (가).
--   (3) 약정 회계. 잔액이 아니라 '약정을 뺀 가용액' 으로 판정하고, 같은
--       판정을 이기는 UPDATE 의 WHERE 안에서 한 번 더 한다.
--   (4) 40P01 을 BUSY 로 내려앉힌다. 학생에게 빨간 에러를 보이지 않는다.
-- 화면 담당에게: NO_MONEY 문구를 '다른 좌석에 걸어 둔 돈까지 합치면 가진
-- 금액을 넘습니다.' 로, 그리고 새 코드 BUSY / SEAT_LIMIT 를 메시지표에
-- 더해야 한다. HAVE_SEAT 와 ALREADY_LEADING_ANOTHER 는 이제 서버가 내지
-- 않는다(지워도 되고 둬도 무해하다).
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

-- ---------------------------------------------------------------------
-- 2-5. settle_expired_listings — 다석 낙찰을 견디게
-- ---------------------------------------------------------------------
-- 이 함수가 이 파일에서 가장 위험한 곳이다. 셋을 동시에 고친다.
--   (1) 'set constraints public.seats_one_per_player deferred' 삭제.
--       남겨 두면 42704 로 정산이 매번 죽는다. 학생·프로젝터·조종석이
--       2초마다 부르고 강제 마감도 여기를 지나가므로 탈출구가 없다.
--   (2) 좌석 UPDATE 에 acquired_via = 'auction'. 빠뜨리면 배치 전체가
--       unique_violation 으로 롤백된다.
--   (3) paid / got 두 CTE -> ledger 하나. 다석이 되는 순간 옛 구조에서는
--       교실에 돈이 창조된다(UPDATE ... FROM 의 다중 매칭 함정).
-- 이상 상태는 여전히 '그 매물 하나만 유찰' 로 내려앉고 배치는 반드시 커밋된다.
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

-- ---------------------------------------------------------------------
-- 2-6. admin_compute_results — 낙찰자 별명 (교사 요구 (다))
-- ---------------------------------------------------------------------
-- 기존 키를 하나도 지우거나 이름을 바꾸지 않는다 — 프로젝터가 그 키로
-- 그린다. 더하기만 한다. 산 사람 별명은 넣고 판 사람 별명은 넣지 않는다.
-- 그 판단의 근거 셋은 함수 안 주석에 적어 두었다.
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


-- #####################################################################
-- ##  5단계 — PostgREST 에 알린다. 반드시 맨 마지막.
-- #####################################################################
-- PostgREST 는 스키마를 캐시한다. 컬럼이 늘었고 함수 본문이 바뀌었으므로
-- 필수다. 먼저 알리면 바뀌기 전의 상태가 그대로 캐시된다.
notify pgrst, 'reload schema';


-- #####################################################################
-- ##  눈으로 보고 싶을 때 — 아래 한 덩이만 따로 드래그해서 Run
-- #####################################################################
-- 위의 4단계가 조용히 지나갔으면 이미 다 통과한 것이다. 그래도 숫자로
-- 보고 싶으면 이 주석을 벗겨 실행하세요. 읽기만 합니다.
--
-- select '예매 1인1석 인덱스(1이어야 함)' as 항목,
--        (select count(*) from pg_indexes
--          where schemaname = 'public' and indexname = 'seats_one_booking_per_player') as 값
-- union all select '옛 제약 제거됨(0이어야 함)',
--        (select count(*) from pg_constraint where conname = 'seats_one_per_player')
-- union all select '옛 선두 인덱스 제거됨(0이어야 함)',
--        (select count(*) from pg_indexes
--          where schemaname = 'public' and indexname = 'listings_one_lead_per_bidder')
-- union all select 'acquired_via 컬럼(1이어야 함)',
--        (select count(*) from information_schema.columns
--          where table_schema = 'public' and table_name = 'seats'
--            and column_name = 'acquired_via')
-- union all select 'set constraints 잔재(0이어야 함)',
--        (select count(*) from pg_proc
--          where proname = 'settle_expired_listings'
--            and regexp_replace(prosrc, '--[^[:cntrl:]]*', '', 'g') like '%set constraints%')
-- union all select '경매 좌석을 두 개 이상 가진 학생 수(수업 뒤에는 0이 아닐 수 있다)',
--        (select count(*) from (
--           select 1 from public.seats
--            where current_owner_id is not null and acquired_via = 'auction'
--            group by room_id, current_owner_id having count(*) > 1) z);
--
-- 리허설 뒤에 지갑이 맞는지 보는 쿼리 ('<반코드>' 를 바꿔서 쓰세요).
-- 0이 아니면 정산이 제대로 안 들어간 것입니다.
--
-- select count(*) as 지갑_불일치
--   from public.wallets w
--   join public.players p on p.id = w.player_id
--  where p.room_id = (select id from public.rooms_public where room_code = '<반코드>')
--    and w.balance <> w.initial
--      - coalesce((select sum(l.final_price) from public.listings l
--                   where l.status = 'sold' and l.highest_bidder_id = w.player_id), 0)
--      + coalesce((select sum(l.final_price) from public.listings l
--                   where l.status = 'sold' and l.seller_id = w.player_id), 0);


-- #####################################################################
-- ##  [되돌리기] — 필요할 때만
-- #####################################################################
--
--  ⚠ 먼저 읽으세요. 다석 낙찰이 한 번이라도 일어난 뒤에는 자동 롤백이
--    불가능합니다. 한 학생이 좌석을 두 개 들고 있는 상태에서 옛 제약
--    seats_one_per_player 를 다시 만들면 그 문장이 실패합니다. 되돌리려면
--    그 학생들의 좌석을 손으로 정리해야 하고, 그건 '교실에서 일어난 일을
--    없던 것으로 만드는' 일입니다. 수업 뒤에 되돌릴 이유는 거의 없습니다.
--
--  되돌리는 순서 (수업 전, 아직 다석 낙찰이 없을 때만)
--    1) 옛 그물을 다시 만든다.
--         alter table public.seats drop constraint if exists seats_one_per_player;
--         alter table public.seats add  constraint seats_one_per_player
--           unique (room_id, current_owner_id) deferrable initially immediate;
--         create unique index if not exists listings_one_lead_per_bidder
--           on public.listings (room_id, highest_bidder_id)
--           where status = 'open' and highest_bidder_id is not null;
--         drop index if exists public.seats_one_booking_per_player;
--       → 여기서 실패하면 이미 다석이 일어난 것입니다. 멈추세요.
--    2) 함수 여섯 개를 저장소의 옛 판본으로 되돌린다.
--         supabase/functions.sql 과 supabase/functions-admin.sql 의
--         git 이력에서 이 변경 '직전' 판본을 꺼내 그 파일들을 그대로 Run.
--       ⚠ settle_expired_listings 를 되돌리기 전에 1) 이 끝나 있어야 합니다.
--         옛 본문은 'set constraints public.seats_one_per_player deferred' 를
--         부르므로, 제약이 없으면 42704 로 정산이 전멸합니다.
--         1) 과 2) 를 한 번의 Run 으로 붙여서 실행하세요.
--    3) acquired_via 컬럼은 남겨 두어도 무해합니다(아무도 읽지 않게 됩니다).
--       굳이 지우려면:
--         alter table public.seats drop column if exists acquired_via;
--         alter table public.rooms_public drop column if exists max_seats_per_bidder;
--    4) -- ---------------------------------------------------------------------
-- 6단계 — 조종석이 별명 붙은 결과를 받는다
-- ---------------------------------------------------------------------
-- rooms_public.results 에는 이제 별명을 뺀 사본만 들어간다(학생이 읽는
-- 표다). 교탁 TV 는 교사 토큰이 있으므로 잠긴 room_results 의 원본을
-- 함께 받아 낙찰자 이름을 그린다. 새로고침 뒤에도 남는다.

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

notify pgrst, 'reload schema';
--
--  화면(JS)을 이미 배포했다면 그쪽도 함께 되돌려야 합니다. 새 화면은
--  me.available 로 버튼을 그리므로, 옛 서버 + 새 화면 조합에서는 입찰
--  버튼이 영영 비활성됩니다.
-- #####################################################################
