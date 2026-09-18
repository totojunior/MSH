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

notify pgrst, 'reload schema';
