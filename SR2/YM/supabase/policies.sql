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
