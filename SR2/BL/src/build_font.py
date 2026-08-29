# -*- coding: utf-8 -*-
"""Pretendard 서브셋. 화면에 실제로 뜰 수 있는 모든 글자를 모아서 자른다.
   이름의 한글 발음("질롤라")과 로마자 악센트(é í š ø)까지 빠짐없이 포함해야
   그 글자만 다른 폰트로 튀는 일이 없다."""
import json, io, sys, os, base64
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

chars = set()

# 1) 국가명 217개
ko = json.load(open('data/country_ko.json', encoding='utf-8'))
chars |= set(''.join(ko.values()))

# 2) 학생 이름 355명
cards = json.load(open('data/cards.json', encoding='utf-8'))
for names in cards['classes'].values():
    chars |= set(''.join(names))

# 3) 국가별 이름 — 로마자 + 한글 발음 (여기가 빠져 있었다)
# 3-1) 종교명 (Pew 보충으로 새 이름이 들어왔다)
rel = json.load(open('data/assets/religion.json', encoding='utf-8'))
for v in rel.values():
    for pair in v: chars.update(pair[0])

nm = json.load(open('data/assets/names.json', encoding='utf-8'))
def eat(d):
    for v in d.values():
        for key in ('m', 'f'):
            for pair in v.get(key, []):
                chars.update(pair[0]); chars.update(pair[1])
eat(nm['byCountry']); eat(nm['byRegion'])

# 4) 화면·포커스카드·베일에 박힌 UI 문구를 template.html 에서 통째로 긁는다
import re
tpl = open('template.html', encoding='utf-8').read()
body = tpl.split('<body>', 1)[1]
chars |= set(re.sub(r'<[^>]*>', ' ', body))          # 태그 제거 후 전부
chars |= set(re.findall(r"'([^'\\]*)'", body))       # JS 문자열 리터럴은 위에서 이미 포함
for lit in re.findall(r"'([^'\\]{1,40})'", tpl):
    chars |= set(lit)

# 5) 숫자·라틴·기호
chars |= set("0123456789"
             "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
             " .,·%/↔—–‘’“”\"'()[]&:;!?+-#→←⛶")
# 위에서 통째 문자열이 섞여 들어오므로 한 글자 단위로 펴 준다
chars = set(''.join(chars))
chars = {c for c in chars if c == ' ' or c.strip()}
kor = sum(1 for c in chars if '가' <= c <= '힣')
print(f"서브셋 대상 {len(chars)}자 (한글 {kor}자)")

from fontTools import subset
from fontTools.ttLib import TTFont
import urllib.request

# Pretendard 원본(SIL OFL). 저장소에는 서브셋만 들어 있으므로 없으면 받아 온다.
PRETENDARD = ('https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/'
              'packages/pretendard/dist/web/static/woff2/Pretendard-{}.woff2')
WEIGHTS = {'Medium': 500, 'SemiBold': 600, 'Bold': 700, 'ExtraBold': 800}
out = {}
for name, wt in WEIGHTS.items():
    raw = f'data/assets/Pretendard-{name}.woff2'
    if not os.path.exists(raw):
        print(f'  {name}: 원본이 없어 내려받는다...')
        req = urllib.request.Request(PRETENDARD.format(name),
                                     headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=60) as r:
            open(raw, 'wb').write(r.read())
    f = TTFont(raw)
    opt = subset.Options(layout_features=['*'], notdef_outline=True,
                         desubroutinize=True, hinting=False)
    opt.flavor = 'woff2'
    s = subset.Subsetter(options=opt)
    s.populate(text=''.join(sorted(chars)))
    s.subset(f)
    buf = io.BytesIO(); f.flavor = 'woff2'; f.save(buf)
    out[wt] = base64.b64encode(buf.getvalue()).decode()
    print(f"  {name}({wt}): 서브셋 {len(buf.getvalue())/1024:.0f}KB")

json.dump(out, open('data/assets/fonts_b64.json', 'w'), separators=(',', ':'))
print(f"→ fonts_b64.json {os.path.getsize('data/assets/fonts_b64.json')/1024:.0f}KB")

# 검증 — 실제로 모든 글자가 폰트에 들어갔는지 되읽어서 확인한다
f = TTFont(io.BytesIO(base64.b64decode(out[700])))
cmap = set()
for t in f['cmap'].tables:
    cmap |= set(t.cmap.keys())
missing = sorted(c for c in chars if ord(c) not in cmap and c != ' ')
print(f"검증: 누락 {len(missing)}자" + (('  ← ' + ''.join(missing[:40])) if missing else '  (전부 포함)'))
