-- =====================================================================
--  YM 교사 키 — 반마다 다른 토큰 대신, 모든 반에 통하는 암호 하나
-- =====================================================================
--  이 파일이 하는 일
--    지금은 반마다 다른 '관리자 토큰'(32바이트 난수)을 붙여넣어야
--    조종석이 열린다. 이 파일을 실행하면 거기에 '교사 키' 하나가 더해진다.
--    교사 키는 11개 반 어디에서나 통한다.
--    반별 토큰은 그대로 살아 있다 — 무엇도 빼앗지 않고 하나를 더할 뿐이다.
--
--  실행 위치 : Supabase 대시보드 > SQL Editor
--  실행 횟수 : 한 번이면 끝난다. (몇 번을 돌려도 결과가 같게 만들어 두었다.)
--  실행 시점 : 수업 중에는 실행하지 마세요.
--              판정 함수를 바꾸는 동안 교사용 RPC 스물몇 개가 잠깐 잠금에
--              걸린다. 60초 경매 중에 돌리면 그 반의 입찰이 밀린다.
--              교시 사이에 하세요.
--
--  먼저 할 일 : 이 파일을 돌리기 '전에' 기존 반별 토큰으로 조종석이 열리는지
--              한 번 확인하세요. 순서가 반대면, 안 열릴 때 그게 이 파일
--              때문인지 원래 토큰이 틀린 것인지 구분할 수 없다.
--
-- ---------------------------------------------------------------------
--  ⚠  암호를 직접 고쳐 적는 줄은 '이 파일 맨 아래' 에 딱 하나 있습니다.
--     → [2단계] select public.ym_set_teacher_key('...')
--
--     이 파일을 통째로 붙여넣고 Run 하면 '장치'만 설치된다.
--     암호는 그 다음에, 맨 아래 그 한 줄을 고쳐서 따로 실행한다.
--     (장치만 설치하고 암호를 안 정하면 아무것도 안 바뀐다 — 지금처럼
--      반별 토큰만 통한다. 그게 이 설계의 기본값이자 되돌아간 상태다.)
--
--  ⚠  이 파일은 GitHub Pages 로 누구에게나 공개된다.
--     .../MSH/SR2/YM/supabase/05-교사키.sql 주소를 치면 그대로 열린다.
--     실제 암호를 이 파일에 적어서 저장하거나 커밋하지 마세요.
--     git 은 지운 뒤에도 이력에 남긴다.
--     고쳐 쓰는 곳은 이 파일이 아니라 SQL 편집기 안이다.
-- ---------------------------------------------------------------------
--
--  이 편의의 값 — 알고 쓰세요
--     반별 토큰이 새면 그 반 하나가 망가진다.
--     교사 키가 새면 11개 반이 한꺼번에 날아간다(방 비우기 · 초기화까지
--     전부 열린다). 32바이트 난수였던 자리에 사람이 정한 문장이 들어오므로
--     길이가 유일한 방어선이다. 그래서 서버가 16자 미만을 거부한다.
--     띄어쓰기를 포함한 16자 이상의 한 문장을 권합니다.
--     한글보다 영문+숫자+띄어쓰기가 안전하다 — 다른 기기에서 칠 때
--     자판이 달라도 같은 글자가 된다.
--
--  되돌리는 법 : 맨 아래 [3단계] 의 한 줄.
--     select public.ym_clear_teacher_key();
--     그 한 줄이면 즉시 예전 방식(반별 토큰만)으로 돌아간다.
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
  --     길이가 유일한 방어선이다. 16자 미만은 거부한다. 학교 이름+연도 같은 추측 가능한 문장은 피한다.
  --     (지연(pg_sleep)으로 대입을 늦추는 방법은 쓰지 않는다. 실패마다
  --      잠들면 공격자가 커넥션을 붙잡고, 같은 풀을 쓰는 학생들의 RPC 가
  --      같이 죽는다. 수업을 멈추는 방어는 방어가 아니다.)
  if length(v_key) < 16 then
    raise exception 'key_too_short' using errcode = '22023',
      hint = '교사 키는 16자 이상이어야 합니다. 띄어쓰기 포함 한 문장을 권합니다.';
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
notify pgrst, 'reload schema';


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
--      select public.ym_set_teacher_key('여기에 교사 키를 적으세요 16자 이상');
--
--  지켜야 할 것
--    · 16자 미만은 서버가 거부한다(22023 key_too_short).
--    · 16자 이상, 띄어쓰기를 포함한 한 문장을 권한다.
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
