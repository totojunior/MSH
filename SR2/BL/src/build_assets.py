# -*- coding: utf-8 -*-
"""국기 SVG 216개를 내려받아 data/assets/flags.json 을 만든다. (인터넷 필요)

저장소에는 이미 flags.json 이 들어 있으므로 평소에는 돌릴 일이 없다.
국기 도안이 바뀌었거나 flags.json 이 없어졌을 때만 쓴다.
폰트는 build_font.py 가 알아서 받아 온다.
"""
import json, io, sys, os, re, time, urllib.request
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
os.makedirs('data/assets', exist_ok=True)

FLAG = 'https://cdn.jsdelivr.net/npm/flag-icons@7.2.3/flags/4x3/{}.svg'
wb = json.load(open('data/worldbank_raw.json', encoding='utf-8'))

def get(url, tries=3):
    for a in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except Exception:
            if a == tries - 1: return None
            time.sleep(1)

def shrink(svg):
    svg = re.sub(r'<\?xml[^>]*\?>', '', svg)
    svg = re.sub(r'<!--.*?-->', '', svg, flags=re.S)
    svg = re.sub(r'\s+', ' ', svg)
    svg = re.sub(r'>\s+<', '><', svg)
    return svg.replace('xmlns:xlink="http://www.w3.org/1999/xlink"', '').strip()

flags = {}
todo = [(k, v['iso2'].lower()) for k, v in wb.items() if v.get('iso2')]
for i, (iso3, iso2) in enumerate(todo):
    b = get(FLAG.format(iso2))
    if b:
        flags[iso3] = shrink(b.decode('utf-8', 'replace'))
    if (i + 1) % 40 == 0:
        print(f'  {i+1}/{len(todo)}')

json.dump(flags, open('data/assets/flags.json', 'w', encoding='utf-8'),
          ensure_ascii=False, separators=(',', ':'))
print(f'국기 {len(flags)}/{len(todo)}개 · '
      f'{os.path.getsize("data/assets/flags.json")/1024:.0f}KB')
missing = [k for k in wb if k not in flags]
if missing:
    print('  못 받음:', ', '.join(missing[:10]))
