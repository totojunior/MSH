# -*- coding: utf-8 -*-
"""template.html 에 데이터·국기·폰트·이름·종교·지도를 심어 ../index.html 을 만든다.

    cd src
    python build.py

학생 이름은 들어가지 않는다. 선생님이 화면의 [명렬표] 버튼으로 한 번 붙여넣으면
그 브라우저에만 저장된다(localStorage). 서버로도 이 저장소로도 나가지 않는다.
"""
import json, io, sys, os, re
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
os.chdir(os.path.dirname(os.path.abspath(__file__)))

OUT = '../index.html'
ASSETS = [('__FLAGS__', 'data/assets/flags.json'),
          ('__NAMES__', 'data/assets/names.json'),
          ('__RELIG__', 'data/assets/religion.json'),
          ('__MAP__',   'data/assets/world_path.json'),
          ('__CEN__',   'data/assets/centroids.json')]

for p in ['template.html', 'data/cards.json', 'data/assets/fonts_b64.json'] + [a[1] for a in ASSETS]:
    if not os.path.exists(p):
        sys.exit(f'없는 파일: {p}\n'
                 f'  국기가 없으면  python build_assets.py\n'
                 f'  폰트가 없으면  python build_font.py')

s = open('template.html', encoding='utf-8').read()
cards = json.load(open('data/cards.json', encoding='utf-8'))
cards['classes'] = {}                      # 명렬표는 넣지 않는다
s = s.replace('__DATA__', json.dumps(cards, ensure_ascii=False, separators=(',', ':')))
for key, path in ASSETS:
    s = s.replace(key, open(path, encoding='utf-8').read())
fonts = json.load(open('data/assets/fonts_b64.json'))
for key, w in [('__F500__', '500'), ('__F600__', '600'),
               ('__F700__', '700'), ('__F800__', '800')]:
    s = s.replace(key, fonts[w])

left = re.findall(r'__[A-Z0-9]+__', re.sub(r'[A-Za-z0-9+/=]{200,}', '', s))
assert not left, f'치환 안 된 자리표시자: {set(left)}'
ext = [u for u in re.findall(r'https?://[^\s"\'<>)]+', s) if 'w3.org' not in u]
assert not ext, f'외부 요청이 생겼다: {ext[:3]}'

open(OUT, 'w', encoding='utf-8').write(s)
print(f'{OUT}  {os.path.getsize(OUT)/1024/1024:.2f} MB · 외부 요청 0건')
print(f'  국가 {len(cards["countries"])}개 · 전 세계 연간 출생아 {cards["total"]:,}명')
