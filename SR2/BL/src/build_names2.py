# -*- coding: utf-8 -*-
"""2차 보강 — 지역 기본값으로 떨어지면 문화가 안 맞는 나라들을 개별로 채운다.
(몽골에 폴리네시아 이름, 우즈베키스탄에 슬라브 이름이 붙던 문제)"""
import json, io, sys, os
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

def P(*pairs):
    return [list(p) for p in pairs]

ADD = {
# --- 중앙아시아·캅카스 : 튀르크·페르시아계 ---
"UZB":{"m":P(("Islom","이슬롬"),("Jasur","자수르"),("Sardor","사르도르"),("Bekzod","벡조드")),
       "f":P(("Zilola","질롤라"),("Nilufar","닐루파르"),("Madina","마디나"),("Gulnora","굴노라"))},
"KAZ":{"m":P(("Alikhan","알리한"),("Nurlan","누를란"),("Yerassyl","예라슬"),("Aibek","아이벡")),
       "f":P(("Aizhan","아이잔"),("Ayaulym","아야울름"),("Dana","다나"),("Zhanel","자넬"))},
"TJK":{"m":P(("Firdavs","피르다우스"),("Rustam","루스탐"),("Behruz","베흐루즈"),("Sherali","셰랄리")),
       "f":P(("Nigina","니기나"),("Farzona","파르조나"),("Shahnoza","샤흐노자"),("Zarina","자리나"))},
"TKM":{"m":P(("Merdan","메르단"),("Serdar","세르다르"),("Batyr","바트르"),("Kerim","케림")),
       "f":P(("Aylar","아일라르"),("Gozel","괴젤"),("Maysa","마이사"),("Jemal","제말"))},
"KGZ":{"m":P(("Nurbek","누르벡"),("Aibek","아이벡"),("Adilet","아딜렛"),("Ulan","울란")),
       "f":P(("Aizada","아이자다"),("Nurgul","누르굴"),("Aiperi","아이페리"),("Meerim","메에림"))},
"AZE":{"m":P(("Elvin","엘빈"),("Orkhan","오르한"),("Rashad","라샤드"),("Tural","투랄")),
       "f":P(("Nigar","니가르"),("Aysel","아이셀"),("Leyla","레일라"),("Gunel","귀넬"))},
"MNG":{"m":P(("Batbayar","바트바야르"),("Ganbold","간볼드"),("Enkhbat","엥흐바트"),("Temuulen","테무렌")),
       "f":P(("Oyunaa","오유나"),("Saruul","사룰"),("Bolormaa","볼로르마"),("Nomin","노민"))},
# --- 아프리카 : 불어권 / 영어권 / 기타 ---
"ZWE":{"m":P(("Tinashe","티나셰"),("Tendai","텐다이"),("Farai","파라이"),("Takudzwa","타쿠드즈와")),
       "f":P(("Rutendo","루텐도"),("Chiedza","치에자"),("Nyasha","냐샤"),("Tariro","타리로"))},
"GIN":{"m":P(("Mamadou","마마두"),("Alpha","알파"),("Ibrahima","이브라히마"),("Sekou","세쿠")),
       "f":P(("Fatoumata","파투마타"),("Mariama","마리아마"),("Aissatou","아이사투"),("Kadiatou","카디아투"))},
"BEN":{"m":P(("Kossi","코시"),("Rodrigue","로드리그"),("Bio","비오"),("Comlan","콤란")),
       "f":P(("Adjovi","아조비"),("Senan","세난"),("Reine","렌"),("Bernadette","베르나데트"))},
"BDI":{"m":P(("Nsengiyumva","응셍기윰바"),("Jean-Bosco","장보스코"),("Gilbert","질베르"),("Elie","엘리")),
       "f":P(("Consolate","콘솔라트"),("Chantal","샹탈"),("Immaculee","이마퀼레"),("Nizigiyimana","니지기이마나"))},
"RWA":{"m":P(("Mugisha","무기샤"),("Kwizera","크위제라"),("Shema","셰마"),("Ishimwe","이심웨")),
       "f":P(("Uwase","우와세"),("Mutoni","무토니"),("Keza","케자"),("Umutesi","우무테시"))},
"SSD":{"m":P(("Deng","뎅"),("Garang","가랑"),("Majok","마조크"),("Wani","와니")),
       "f":P(("Nyandeng","냔뎅"),("Achol","아촐"),("Aluel","알루엘"),("Ayen","아옌"))},
"TGO":{"m":P(("Kodjo","코조"),("Yao","야오"),("Komi","코미"),("Essosimna","에소심나")),
       "f":P(("Akouvi","아쿠비"),("Afi","아피"),("Dela","델라"),("Sena","세나"))},
"SLE":{"m":P(("Mohamed","모하메드"),("Abu","아부"),("Alhaji","알하지"),("Sorie","소리에")),
       "f":P(("Isatu","이사투"),("Mariama","마리아마"),("Kadiatu","카디아투"),("Zainab","자이납"))},
"CAF":{"m":P(("Bienvenu","비앵브뉘"),("Christian","크리스티앙"),("Serge","세르주"),("Fidele","피델")),
       "f":P(("Bernadette","베르나데트"),("Yvonne","이본"),("Clarisse","클라리스"),("Solange","솔랑주"))},
"COG":{"m":P(("Nkounkou","은쿤쿠"),("Christ","크리스트"),("Prince","프랭스"),("Rufin","뤼팽")),
       "f":P(("Divine","디빈"),("Merveille","메르베유"),("Grace","그라스"),("Christelle","크리스텔"))},
"MRT":{"m":P(("Mohamed","모하메드"),("Sidi","시디"),("Ahmedou","아흐메두"),("Cheikh","셰이크")),
       "f":P(("Mariem","마리엠"),("Aicha","아이샤"),("Zeinabou","제이나부"),("Khadijetou","카디제투"))},
"LBR":{"m":P(("Emmanuel","이매뉴얼"),("Prince","프린스"),("Moses","모지스"),("Varney","바니")),
       "f":P(("Musu","무수"),("Korto","코르토"),("Blessing","블레싱"),("Fatu","파투"))},
"GMB":{"m":P(("Lamin","라민"),("Ousman","우스만"),("Modou","모두"),("Ebrima","에브리마")),
       "f":P(("Fatou","파투"),("Awa","아와"),("Isatou","이사투"),("Binta","빈타"))},
"ERI":{"m":P(("Tesfay","테스파이"),("Yohannes","요하네스"),("Samuel","사무엘"),("Fitsum","피춤")),
       "f":P(("Senait","세나이트"),("Rahel","라헬"),("Winta","윈타"),("Feven","페벤"))},
"BWA":{"m":P(("Kagiso","카기소"),("Thabo","타보"),("Lesego","레세고"),("Katlego","카틀레고")),
       "f":P(("Boitumelo","보이투멜로"),("Naledi","날레디"),("Kelebogile","켈레보길레"),("Gorata","고라타"))},
"NAM":{"m":P(("Shikongo","시콩고"),("Petrus","페트루스"),("Tangeni","탕게니"),("Johannes","요하네스")),
       "f":P(("Ndapewa","은다페와"),("Selma","셀마"),("Ndeshi","은데시"),("Loide","로이데"))},
"GNB":{"m":P(("Braima","브라이마"),("Malam","말람"),("Domingos","도밍구스"),("Iaia","이아이아")),
       "f":P(("Aminata","아미나타"),("Bintou","빈투"),("Fatumata","파투마타"),("Maria","마리아"))},
# --- 중남미 ---
"ECU":{"m":P(("Mateo","마테오"),("Santiago","산티아고"),("Alejandro","알레한드로"),("Nicolas","니콜라스")),
       "f":P(("Emilia","에밀리아"),("Camila","카밀라"),("Valentina","발렌티나"),("Domenica","도메니카"))},
"BOL":{"m":P(("Alvaro","알바로"),("Marco","마르코"),("Juan Carlos","후안카를로스"),("Limbert","림베르트")),
       "f":P(("Andrea","안드레아"),("Rosmery","로스메리"),("Nayra","나이라"),("Gabriela","가브리엘라"))},
"HTI":{"m":P(("Jean","장"),("Wisly","위슬리"),("Ricardo","리카르도"),("Peterson","페테르송")),
       "f":P(("Marie","마리"),("Nadege","나데주"),("Guerline","게를린"),("Rose","로즈"))},
"HND":{"m":P(("Jose","호세"),("Kevin","케빈"),("Denis","데니스"),("Marlon","마를론")),
       "f":P(("Keyla","케일라"),("Yesenia","예세니아"),("Maria","마리아"),("Dulce","둘세"))},
"DOM":{"m":P(("Luis","루이스"),("Starling","스탈링"),("Yeuris","예우리스"),("Ramon","라몬")),
       "f":P(("Yaritza","야리차"),("Massiel","마시엘"),("Rosangel","로산헬"),("Ana","아나"))},
"CHL":{"m":P(("Agustin","아구스틴"),("Vicente","비센테"),("Benjamin","벤하민"),("Matias","마티아스")),
       "f":P(("Emilia","에밀리아"),("Isidora","이시도라"),("Antonella","안토넬라"),("Florencia","플로렌시아"))},
"PRY":{"m":P(("Derlis","데를리스"),("Oscar","오스카르"),("Rodrigo","로드리고"),("Alan","알란")),
       "f":P(("Belen","벨렌"),("Rocio","로시오"),("Larissa","라리사"),("Carolina","카롤리나"))},
"NIC":{"m":P(("Jorge","호르헤"),("Elvin","엘빈"),("Byron","바이런"),("Carlos","카를로스")),
       "f":P(("Massiel","마시엘"),("Scarleth","스칼렛"),("Heydi","헤이디"),("Maria","마리아"))},
"SLV":{"m":P(("Josue","호수에"),("Kevin","케빈"),("Diego","디에고"),("Wilber","윌베르")),
       "f":P(("Fatima","파티마"),("Katherine","캐서린"),("Gabriela","가브리엘라"),("Alison","앨리슨"))},
"CUB":{"m":P(("Yoandy","요안디"),("Reinier","레이니에르"),("Adrian","아드리안"),("Lazaro","라사로")),
       "f":P(("Yulieth","율리에트"),("Dayana","다야나"),("Lianet","리아넷"),("Amanda","아만다"))},
"CRI":{"m":P(("Mateo","마테오"),("Santiago","산티아고"),("Dylan","딜런"),("Isaac","이사크")),
       "f":P(("Sofia","소피아"),("Valentina","발렌티나"),("Emma","엠마"),("Amanda","아만다"))},
# --- 중동·북아프리카 ---
"JOR":{"m":P(("Abdullah","압둘라"),("Zaid","자이드"),("Yazan","야잔"),("Omar","오마르")),
       "f":P(("Lana","라나"),("Joud","주드"),("Rania","라니아"),("Dana","다나"))},
"ISR":{"m":P(("Noam","노암"),("David","다비드"),("Ariel","아리엘"),("Yosef","요세프")),
       "f":P(("Tamar","타마르"),("Noa","노아"),("Maayan","마얀"),("Shira","시라"))},
"TUN":{"m":P(("Mohamed","모하메드"),("Aziz","아지즈"),("Yassine","야신"),("Skander","스칸데르")),
       "f":P(("Eya","에야"),("Farah","파라"),("Mariem","마리엠"),("Nour","누르"))},
"LBY":{"m":P(("Mohamed","모하메드"),("Abdulsalam","압둘살람"),("Tarek","타레크"),("Anas","아나스")),
       "f":P(("Fatma","파트마"),("Aya","아야"),("Rania","라니아"),("Hala","할라"))},
"LBN":{"m":P(("Karim","카림"),("Elie","엘리"),("Hadi","하디"),("Georges","조르주")),
       "f":P(("Maya","마야"),("Lea","레아"),("Nour","누르"),("Yara","야라"))},
"ARE":{"m":P(("Mohammed","무함마드"),("Rashid","라시드"),("Khalid","칼리드"),("Saeed","사이드")),
       "f":P(("Maryam","마리암"),("Alia","알리아"),("Shaikha","샤이카"),("Noura","누라"))},
"OMN":{"m":P(("Said","사이드"),("Salim","살림"),("Hamed","하메드"),("Yousuf","유수프")),
       "f":P(("Amal","아말"),("Buthaina","부타이나"),("Muna","무나"),("Zainab","자이납"))},
"KWT":{"m":P(("Abdullah","압둘라"),("Fahad","파하드"),("Yousef","유세프"),("Nasser","나세르")),
       "f":P(("Dana","다나"),("Sara","사라"),("Lulwa","룰와"),("Fatima","파티마"))},
"PSE":{"m":P(("Mohammad","무함마드"),("Ahmad","아흐마드"),("Yousef","유세프"),("Karam","카람")),
       "f":P(("Lian","리안"),("Sila","실라"),("Jana","자나"),("Maryam","마리암"))},
# --- 유럽 ---
"NLD":{"m":P(("Noah","노아"),("Sem","셈"),("Liam","리암"),("Luuk","뤼크")),
       "f":P(("Emma","엠마"),("Julia","율리아"),("Mila","밀라"),("Sophie","소피"))},
"ROU":{"m":P(("Andrei","안드레이"),("David","다비드"),("Luca","루카"),("Matei","마테이")),
       "f":P(("Maria","마리아"),("Sofia","소피아"),("Ana","아나"),("Ioana","이오아나"))},
"BEL":{"m":P(("Arthur","아르튀르"),("Noah","노아"),("Louis","루이"),("Jules","쥘")),
       "f":P(("Olivia","올리비아"),("Emma","엠마"),("Louise","루이즈"),("Mila","밀라"))},
"SWE":{"m":P(("William","빌헬름"),("Noah","노아"),("Hugo","휘고"),("Liam","리암")),
       "f":P(("Alice","알리스"),("Maja","마야"),("Astrid","아스트리드"),("Elsa","엘사"))},
"PRT":{"m":P(("Francisco","프란시스쿠"),("Afonso","아폰수"),("Duarte","두아르트"),("Tomas","토마스")),
       "f":P(("Maria","마리아"),("Leonor","레오노르"),("Matilde","마틸드"),("Beatriz","베아트리스"))},
"GRC":{"m":P(("Georgios","요르요스"),("Dimitrios","디미트리오스"),("Konstantinos","콘스탄티노스"),("Nikolaos","니콜라오스")),
       "f":P(("Maria","마리아"),("Eleni","엘레니"),("Sofia","소피아"),("Katerina","카테리나"))},
"CZE":{"m":P(("Jakub","야쿠프"),("Jan","얀"),("Tomas","토마시"),("Adam","아담")),
       "f":P(("Eliska","엘리슈카"),("Tereza","테레자"),("Anna","안나"),("Sofie","소피에"))},
"HUN":{"m":P(("Bence","벤체"),("Mate","마테"),("Levente","레벤테"),("Dominik","도미니크")),
       "f":P(("Hanna","한나"),("Anna","안나"),("Zoe","조에"),("Lena","레나"))},
"SRB":{"m":P(("Nikola","니콜라"),("Lazar","라자르"),("Vuk","부크"),("Stefan","스테판")),
       "f":P(("Sofija","소피야"),("Dunja","두냐"),("Teodora","테오도라"),("Milica","밀리차"))},
"NOR":{"m":P(("Jakob","야코브"),("Emil","에밀"),("Noah","노아"),("Oliver","올리베르")),
       "f":P(("Nora","노라"),("Emma","엠마"),("Ella","엘라"),("Sofie","소피에"))},
"AUT":{"m":P(("Maximilian","막시밀리안"),("Jakob","야코프"),("Elias","엘리아스"),("Felix","펠릭스")),
       "f":P(("Emilia","에밀리아"),("Anna","안나"),("Marie","마리"),("Valentina","발렌티나"))},
"CHE":{"m":P(("Noah","노아"),("Liam","리암"),("Matteo","마테오"),("Leon","레온")),
       "f":P(("Mia","미아"),("Emma","엠마"),("Sofia","소피아"),("Lina","리나"))},
"BGR":{"m":P(("Georgi","게오르기"),("Aleksandar","알렉산다르"),("Martin","마르틴"),("Ivan","이반")),
       "f":P(("Viktoria","빅토리아"),("Maria","마리아"),("Gabriela","가브리엘라"),("Nikol","니콜"))},
"IRL":{"m":P(("Jack","잭"),("Noah","노아"),("Conor","코너"),("Fionn","핀")),
       "f":P(("Grace","그레이스"),("Fiadh","피아"),("Emily","에밀리"),("Sophie","소피"))},
"DNK":{"m":P(("William","빌리암"),("Oscar","오스카"),("Alfred","알프레드"),("Valdemar","발데마르")),
       "f":P(("Alma","알마"),("Ella","엘라"),("Agnes","아그네스"),("Freja","프레야"))},
"FIN":{"m":P(("Leo","레오"),("Elias","엘리아스"),("Onni","온니"),("Eino","에이노")),
       "f":P(("Aino","아이노"),("Eevi","에에비"),("Venla","벤라"),("Sofia","소피아"))},
# --- 아시아·태평양 ---
"PNG":{"m":P(("John","존"),("Peter","피터"),("Kila","킬라"),("Bomai","보마이")),
       "f":P(("Mary","메리"),("Grace","그레이스"),("Rose","로즈"),("Naime","나이메"))},
"LAO":{"m":P(("Somsak","솜삭"),("Bounmy","분미"),("Khamla","캄라"),("Vilay","빌라이")),
       "f":P(("Phaengsy","팽시"),("Noy","노이"),("Souk","숙"),("Manivanh","마니반"))},
"NZL":{"m":P(("Oliver","올리버"),("Noah","노아"),("Nikau","니카우"),("Leo","레오")),
       "f":P(("Isla","아일라"),("Amelia","아멜리아"),("Mia","미아"),("Aroha","아로하"))},
"SGP":{"m":P(("Ethan","이선"),("Aiden","에이든"),("Wei Jie","웨이제"),("Rayyan","라이얀")),
       "f":P(("Chloe","클로이"),("Sophia","소피아"),("Xin Yi","신이"),("Nur","누르"))},
"TLS":{"m":P(("Domingos","도밍구스"),("Joao","주앙"),("Alberto","알베르투"),("Mateus","마테우스")),
       "f":P(("Maria","마리아"),("Ana","아나"),("Filomena","필로메나"),("Juliana","줄리아나"))},
"BTN":{"m":P(("Karma","카르마"),("Sonam","소남"),("Tashi","타시"),("Ugyen","우겐")),
       "f":P(("Pema","페마"),("Dechen","데첸"),("Choden","초덴"),("Kinley","킨리"))},
"MDV":{"m":P(("Ahmed","아흐메드"),("Mohamed","모하메드"),("Ibrahim","이브라힘"),("Hussain","후사인")),
       "f":P(("Aishath","아이샤트"),("Fathimath","파티마트"),("Mariyam","마리얌"),("Hawwa","하와"))},
}

# 지역 기본값도 문화적으로 덜 어긋나게 다듬는다 — 여러 나라에 두루 쓰이는 이름 위주.
REGION_FIX = {
"Sub-Saharan Africa": {
  "m":P(("Emmanuel","이매뉴얼"),("Samuel","새뮤얼"),("Ibrahim","이브라힘"),("Joseph","조지프"),("Daniel","대니얼")),
  "f":P(("Grace","그레이스"),("Blessing","블레싱"),("Fatou","파투"),("Esther","에스더"),("Mary","메리"))},
"East Asia & Pacific": {
  "m":P(("John","존"),("Peter","피터"),("Samuel","새뮤얼"),("Daniel","대니얼")),
  "f":P(("Mary","메리"),("Grace","그레이스"),("Rose","로즈"),("Anna","안나"))},
"Europe & Central Asia": {
  "m":P(("Aleksandr","알렉산드르"),("Daniel","다니엘"),("Adam","아담"),("Luka","루카")),
  "f":P(("Anna","안나"),("Maria","마리아"),("Sofia","소피아"),("Elena","엘레나"))},
}

nm = json.load(open('data/assets/names.json', encoding='utf-8'))
wb = json.load(open('data/worldbank_raw.json', encoding='utf-8'))
ko = json.load(open('data/country_ko.json', encoding='utf-8'))
cards = json.load(open('data/cards.json', encoding='utf-8'))
weight = {c[0]: c[2] for c in cards['countries']}
tot = cards['total']

before = len(nm['byCountry'])
nm['byCountry'].update(ADD)
nm['byRegion'].update(REGION_FIX)
json.dump(nm, open('data/assets/names.json', 'w', encoding='utf-8'),
          ensure_ascii=False, separators=(',', ':'))

bad = [k for k in ADD if k not in wb]
if bad: print("경고 — World Bank 에 없는 iso3:", bad)
cov = sum(weight.get(k, 0) for k in nm['byCountry'] if k in weight)
print(f"개별 국가 {before} → {len(nm['byCountry'])}개 · 출생아 {100*cov/tot:.1f}% 커버")
rest = sorted(((weight.get(k, 0), ko.get(k, k)) for k in wb if k not in nm['byCountry']),
              reverse=True)[:6]
print("  아직 지역 기본값인 최대 비중:",
      ', '.join(f'{k} {100*w/tot:.2f}%' for w, k in rest))
print(f"  names.json {os.path.getsize('data/assets/names.json')/1024:.0f}KB")
