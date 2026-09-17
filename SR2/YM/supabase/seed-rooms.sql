-- =====================================================================
-- YM — 반별 방 만들기. 딱 한 번만 실행한다.
-- =====================================================================
-- 실행 위치: Supabase 대시보드 > SQL Editor
-- 실행 시점: schema.sql -> functions.sql -> functions-admin.sql -> policies.sql
--            네 개를 모두 돌린 뒤
--
-- 방을 만드는 함수는 웹에 열어 두지 않았다. 주소만 아는 사람이 방을
-- 무한정 찍어낼 수 있기 때문이다. 그래서 여기서 한 번만 만든다.
--
-- ⚠ 아래를 실행하면 반마다 '관리자 토큰'이 딱 한 번 표 형태로 찍힌다.
--    이 화면을 닫으면 토큰은 다시 볼 수 없다 (해시만 저장된다).
--    결과를 통째로 복사해서 안전한 곳에 붙여넣어 두세요.
--    분실하면 그 반의 방을 지우고 다시 만드는 수밖에 없다.
--
-- ⚠ 이 토큰은 프로젝터에 절대 띄우지 마세요. 토큰을 가진 사람은
--    단계를 넘기고 명단을 잠그고 경매를 끝낼 수 있다.
-- =====================================================================

-- 반 11개 + 리허설용 방 1개.
-- YM2-TEST 가 따로 있는 이유: 봇을 불러 연습하면 참가자와 좌석과 경매 기록이
-- 남는다. 그걸 실제 반 방에서 하면 그 반의 결과가 더러워진다.
select x.r ->> 'room_code'   as "방 코드",
       x.r ->> 'admin_token' as "관리자 토큰 (한 번만 보임)"
  from unnest(array['YM2-1','YM2-2','YM2-3','YM2-4','YM2-5','YM2-6',
                    'YM2-7','YM2-8','YM2-9','YM2-10','YM2-11','YM2-TEST'])
       with ordinality as t(code, ord)
  cross join lateral (select public.create_room(t.code) as r) as x
 order by t.ord;

-- ---------------------------------------------------------------------
-- 참고 — 나중에 필요할 때 쓰는 것들
-- ---------------------------------------------------------------------

-- 한 반만 다시 만들기 (기존 방을 지운 뒤에)
--   delete from public.rooms_public where room_code = 'YM2-3';
--   select public.create_room('YM2-3');

-- 방 목록과 현재 단계 확인
--   select room_code, phase, player_count, seat_count, expires_at
--     from public.rooms_public order by room_code;

-- 방은 만든 지 12시간이 지나면 학생 접속을 막는다. 수업 당일 아침에
-- 만들거나, 아래로 마감을 미룬다.
--   update public.rooms_public set expires_at = now() + interval '12 hours';

-- 11개 반이 다 끝난 뒤 정리 (결과까지 전부 지운다)
--   delete from public.rooms_public where room_code like 'YM2-%';
