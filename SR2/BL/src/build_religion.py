# -*- coding: utf-8 -*-
"""종교 데이터 커버리지 확대.
   워크플로가 확정한 70개국(Pew + CIA 교차검증, 개신교/천주교/정교회까지 세분)은 그대로 두고,
   나머지는 Pew 원본 CSV(2020, Level 1)에서 채운다. Pew 범주는 더 거칠어서
   '기독교'로만 나오지만, 지어내는 것보다 정확하다."""
import json, io, sys, os, csv, unicodedata
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

SP = ('C:/Users/user/AppData/Local/Temp/claude/'
      'C--Users-user-desktop-Making-where-to-be-born-Hook/'
      'd985e9d1-e5d2-4a52-b3ab-ef8af480655a/scratchpad/pewdata/'
      'Religious Composition 2010-2020 dataset/'
      'Religious Composition 2010-2020 (percentages).csv')

KO = {'Christians': '기독교', 'Muslims': '이슬람교', 'Religiously_unaffiliated': '무종교',
      'Buddhists': '불교', 'Hindus': '힌두교', 'Jews': '유대교', 'Other_religions': '기타'}

wb = json.load(open('data/worldbank_raw.json', encoding='utf-8'))
ko_name = json.load(open('data/country_ko.json', encoding='utf-8'))
cards = json.load(open('data/cards.json', encoding='utf-8'))
weight = {c[0]: c[2] for c in cards['countries']}
tot = cards['total']
verified = json.load(open('data/assets/religion.json', encoding='utf-8'))

# Pew 국가명 → iso3. World Bank 영문명과 대조하고, 다른 것만 손으로 잇는다.
def norm(s):
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode().lower()
    for ch in ".,'()-":
        s = s.replace(ch, '')
    return s.replace('the ', '').replace('&', 'and').replace(' ', '')

by_name = {}
for iso3, v in wb.items():
    by_name[norm(v['name_en'])] = iso3
ALIAS = {
    'unitedstatesofamerica':'USA','russia':'RUS','southkorea':'KOR','northkorea':'PRK',
    'republicofkorea':'KOR','democraticpeoplesrepublicofkorea':'PRK',
    'iran':'IRN','egypt':'EGY','syria':'SYR','yemen':'YEM','laos':'LAO','vietnam':'VNM',
    'venezuela':'VEN','bolivia':'BOL','tanzania':'TZA','gambia':'GMB','bahamas':'BHS',
    'democraticrepublicofcongo':'COD','republicofcongo':'COG','congo':'COG',
    'democraticrepublicofthecongo':'COD','republicofthecongo':'COG',
    'ivorycoast':'CIV','cotedivoire':'CIV','capeverde':'CPV','caboverde':'CPV',
    'swaziland':'SWZ','eswatini':'SWZ','macedonia':'MKD','northmacedonia':'MKD',
    'czechrepublic':'CZE','czechia':'CZE','slovakia':'SVK','moldova':'MDA',
    'kyrgyzstan':'KGZ','kyrgyzrepublic':'KGZ','brunei':'BRN','myanmarburma':'MMR',
    'myanmar':'MMR','burma':'MMR','easttimor':'TLS','timorleste':'TLS',
    'palestinianterritories':'PSE','palestine':'PSE','westbankandgaza':'PSE',
    'hongkong':'HKG','macau':'MAC','macao':'MAC','turkey':'TUR','turkiye':'TUR',
    'stlucia':'LCA','saintlucia':'LCA','stvincentandthegrenadines':'VCT',
    'saintvincentandthegrenadines':'VCT','stkittsandnevis':'KNA',
    'saintkittsandnevis':'KNA','micronesia':'FSM','federatedstatesofmicronesia':'FSM',
    'unitedstatesvirginislands':'VIR','virginislands':'VIR','sainthelena':'SHN',
    'westernsahara':None,'channelislands':'CHI','faeroeislands':'FRO','faroeislands':'FRO',
    'republicofmoldova':'MDA','bosniaherzegovina':'BIH','bosniaandherzegovina':'BIH',
    'lao':'LAO','laopeoplesdemocraticrepublic':'LAO','slovenia':'SVN',
    'antiguaandbarbuda':'ATG','trinidadandtobago':'TTO','saotomeandprincipe':'STP',
    'guineabissau':'GNB','equatorialguinea':'GNQ','centralafricanrepublic':'CAF',
    'southsudan':'SSD','burkinafaso':'BFA','sierraleone':'SLE','newzealand':'NZL',
    'papuanewguinea':'PNG','solomonislands':'SLB','marshallislands':'MHL',
    'unitedarabemirates':'ARE','saudiarabia':'SAU','srilanka':'LKA',
    'dominicanrepublic':'DOM','elsalvador':'SLV','costarica':'CRI','puertorico':'PRI',
    'northerncyprus':None,'kosovo':'XKX','curacao':'CUW','frenchguiana':None,
    'guadeloupe':None,'martinique':None,'reunion':None,'mayotte':None,
}

rows = list(csv.DictReader(open(SP, encoding='utf-8-sig')))
pew = {}
unmatched = []
for r in rows:
    if r['Year'] != '2020' or r['Level'] != '1':
        continue
    n = norm(r['Country'])
    iso = ALIAS.get(n, by_name.get(n, 0))
    if iso == 0:
        unmatched.append(r['Country']); continue
    if iso is None or iso not in wb:
        continue
    pairs = []
    for k, kr in KO.items():
        try: v = float(r[k])
        except (ValueError, TypeError): v = 0.0
        if v >= 0.5:
            pairs.append([kr, round(v, 1)])
    pairs.sort(key=lambda x: -x[1])
    s = sum(x[1] for x in pairs)
    if pairs and s < 97:
        pairs.append(['기타', round(100 - s, 1)])
        pairs.sort(key=lambda x: -x[1])
    if pairs:
        pew[iso] = pairs

added = {k: v for k, v in pew.items() if k not in verified}
merged = dict(verified); merged.update(added)
json.dump(merged, open('data/assets/religion.json', 'w', encoding='utf-8'),
          ensure_ascii=False, separators=(',', ':'))

cov_before = sum(weight.get(k, 0) for k in verified)
cov_after = sum(weight.get(k, 0) for k in merged)
print(f'Pew CSV 2020·Level1 파싱: {len(pew)}개국 매칭, 이름 못 찾음 {len(unmatched)}개')
if unmatched: print('  못 찾음:', ', '.join(unmatched[:12]))
print(f'검증 확정 {len(verified)}개 + Pew 보충 {len(added)}개 = {len(merged)}개국')
print(f'출생아 커버: {100*cov_before/tot:.1f}%  →  {100*cov_after/tot:.1f}%')
rest = sorted(((weight.get(k, 0), ko_name.get(k, k)) for k in wb if k not in merged), reverse=True)[:6]
print('  아직 자료 없음:', ', '.join(f'{k} {100*w/tot:.2f}%' for w, k in rest))
bad = [(k, round(sum(x[1] for x in v), 1)) for k, v in merged.items()
       if abs(sum(x[1] for x in v) - 100) > 4]
print('  합계 100 크게 벗어남:', bad if bad else '없음')
print('  종교명:', sorted({x[0] for v in merged.values() for x in v}))
print(f'  religion.json {os.path.getsize("data/assets/religion.json")/1024:.0f}KB')
