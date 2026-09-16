# -*- coding: utf-8 -*-
"""
dwg2nc.py — 把 2D 板件工程圖（DWG）轉成 Fanuc 加工中心的 NC 程式 + 刀具表 CSV + 素材 JSON + 報告。

只處理 2.5D 板件：孔（鑽／攻牙／沉孔／大孔銑）、封閉輪廓（穿透窗口、長圓槽）。
需要 ezdwg（pip install ezdwg）。

用法：
  python tools/dwg2nc/dwg2nc.py 圖.dwg --plate 900x330x15 --onum 2001 --name PART-A --tools 刀具表.csv
  選項見 README.md 或 --help。
"""
import sys, io, os, math, csv, json, argparse, collections, datetime
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import ezdwg

# ---------------------------------------------------------------------------
# 參數
# ---------------------------------------------------------------------------
ap = argparse.ArgumentParser()
ap.add_argument('dwg')
ap.add_argument('--plate', required=True, help='板的 寬x高x厚（mm），例如 900x330x15')
ap.add_argument('--region', default=None, help='零件視圖在紙面上的範圍 x0,y0,x1,y1（不給就自動找）')
ap.add_argument('--origin', default='LB', help='工件原點放板的哪個角：LB 左下（預設）／RB／LT／RT；Z0 一律在上表面')
ap.add_argument('--tools', default=None, help='現有刀具表 CSV（預演台匯出的格式）；配刀只從這裡挑，挑不到標「需新增」。不給就全部標需新增')
ap.add_argument('--onum', type=int, default=2001, help='O 號（預設 2001）')
ap.add_argument('--name', default=None, help='程式名稱註解（預設用檔名）')
ap.add_argument('--subfaces', default='skip', choices=['skip', 'thru'], help='輪廓內被分割出的小區域：skip 不切、列為待確認（預設）／thru 一起切穿')
ap.add_argument('--skin', type=float, default=0.0, help='窗口最後一刀留皮厚度 mm（0 = 切穿到板下 0.3）')
ap.add_argument('--out', default=None, help='輸出資料夾（預設：DWG 所在資料夾下的 out/）')
A = ap.parse_args()
if not A.out: A.out = os.path.join(os.path.dirname(os.path.abspath(A.dwg)), 'out')
PW, PH, PT = [float(v) for v in A.plate.lower().split('x')]
NAME = A.name or os.path.splitext(os.path.basename(A.dwg))[0]
os.makedirs(A.out, exist_ok=True)
notes = []          # 報告用：假設與待確認事項
def note(s): notes.append(s); print('  ! ' + s)

# ---------------------------------------------------------------------------
# 讀圖、找零件視圖、定比例與原點
# ---------------------------------------------------------------------------
doc = ezdwg.read(A.dwg)
ms = list(doc.modelspace().query("*"))
LINES = [e.dxf for e in ms if e.dxftype == 'LINE']
CIRCLES = [e.dxf for e in ms if e.dxftype == 'CIRCLE']
ARCS = [e.dxf for e in ms if e.dxftype == 'ARC']
POLYS = [e.dxf for e in ms if e.dxftype == 'POLYLINE_2D']
print('DWG %s：LINE %d、CIRCLE %d、ARC %d、POLYLINE %d' % (doc.version, len(LINES), len(CIRCLES), len(ARCS), len(POLYS)))

NOM = [2, 3.3, 4.2, 5, 5.3, 5.5, 6.3, 6.5, 6.8, 8.5, 10.5, 12, 25, 28, 30, 35, 37, 40]
def snap(d):
    n = min(NOM, key=lambda v: abs(v - d)); return n if abs(n - d) < 0.2 else None

def find_plate_rect():
    """找和板長寬比相符的矩形（一條水平線 + 端點接一條長度比例正確的垂直線），取內含圓最多的。"""
    horiz = [l for l in LINES if abs(l['start'][1] - l['end'][1]) < 1e-3]
    vert = [l for l in LINES if abs(l['start'][0] - l['end'][0]) < 1e-3]
    vidx = collections.defaultdict(list)
    for v in vert:
        for p in (v['start'], v['end']): vidx[(round(p[0], 2), round(p[1], 2))].append(v)
    cands = []
    for h in horiz:
        w = abs(h['end'][0] - h['start'][0])
        if w < 5: continue
        for p in (h['start'], h['end']):
            for v in vidx.get((round(p[0], 2), round(p[1], 2)), []):
                hgt = abs(v['end'][1] - v['start'][1])
                if abs(hgt / w - PH / PW) < 0.01:
                    x0, x1 = sorted([h['start'][0], h['end'][0]]); ys = sorted([v['start'][1], v['end'][1]])
                    cands.append((x0, ys[0], x1, ys[1]))
    best = None
    for r in set(cands):
        k = PW / (r[2] - r[0])
        inside = [c for c in CIRCLES if r[0] < c['center'][0] < r[2] and r[1] < c['center'][1] < r[3]]
        good = sum(1 for c in inside if snap(2 * c['radius'] * k) is not None)
        score = good - 3 * (len(inside) - good)      # 同一張板畫在好幾張圖紙上時，挑疊了最少雜物的那一張
        if best is None or score > best[0]: best = (score, r)
    return best

if A.region:
    x0, y0, x1, y1 = [float(v) for v in A.region.split(',')]
    REGION = (x0, y0, x1, y1)
    inR = lambda p: x0 < p[0] < x1 and y0 < p[1] < y1
    rect = find_plate_rect()
    if not rect: sys.exit('找不到板外形矩形')
    rect = rect[1]
else:
    best = find_plate_rect()
    if not best: sys.exit('找不到和 %gx%g 長寬比相符的板外形矩形，請用 --region 指定' % (PW, PH))
    rect = best[1]
    m = (rect[2] - rect[0]) * 0.005     # 只取板外形本身（孔和輪廓都在板內；板外的尺寸線靠剪枝處理）
    REGION = (rect[0] - m, rect[1] - m, rect[2] + m, rect[3] + m)
    inR = lambda p: REGION[0] < p[0] < REGION[2] and REGION[1] < p[1] < REGION[3]
K = PW / (rect[2] - rect[0])
print('板外形（紙面）x %.3f..%.3f y %.3f..%.3f → 比例 1:%.3f（板高核對 %.1f mm）' % (rect[0], rect[2], rect[1], rect[3], 1 / K, (rect[3] - rect[1]) * K))
ORG = {'LB': (rect[0], rect[1]), 'RB': (rect[2], rect[1]), 'LT': (rect[0], rect[3]), 'RT': (rect[2], rect[3])}[A.origin.upper()]
def mm(p): return ((p[0] - ORG[0]) * K, (p[1] - ORG[1]) * K)
note('工件原點：板的%s角、上表面 Z0（--origin %s）；G54 請對到這個角。' % ({'LB': '左下', 'RB': '右下', 'LT': '左上', 'RT': '右上'}[A.origin.upper()], A.origin.upper()))

# ---------------------------------------------------------------------------
# 孔
# ---------------------------------------------------------------------------
TAP = {3.3: ('M4', 0.7), 4.2: ('M5', 0.8), 5: ('M6', 1.0), 6.8: ('M8', 1.25), 8.5: ('M10', 1.5)}
CBORE_DEPTH = {10.5: 6.0, 12: 8.0}     # 圖上文字讀不到，依常見規格假設 → 報告裡列為待確認
raw = []
for c in CIRCLES:
    if not inR(c['center']): continue
    x, y = mm(c['center']); d = 2 * c['radius'] * K
    raw.append(dict(x=round(x, 3), y=round(y, 3), d=snap(d), d_raw=round(d, 2)))
holes = []
for h in sorted(raw, key=lambda h: (h['x'], h['y'])):
    for g in holes:
        if abs(g['x'] - h['x']) < 0.3 and abs(g['y'] - h['y']) < 0.3: g['ds'].append(h['d']); break
    else: holes.append(dict(x=h['x'], y=h['y'], ds=[h['d']]))
# 板外的圓（軸符號之類）丟掉
holes = [g for g in holes if 0.5 < (g['x'] - mm(rect[:2])[0]) < PW - 0.5 and 0.5 < (g['y'] - mm(rect[:2])[1]) < PH - 0.5]
for g in holes:
    ds = sorted(d for d in g['ds'] if d)
    g.update(name='?', drill=None, tap=None, cbore=None, mill=None)
    if not ds: g['name'] = '無法辨識（圓徑 %s）' % g['ds']; continue
    small, big = ds[0], (ds[-1] if len(ds) > 1 else None)
    if small in TAP and big is None:
        g.update(name='%s 牙孔（底孔 Ø%g）' % (TAP[small][0], small), drill=small, tap=TAP[small])
    elif big in CBORE_DEPTH:
        g.update(name='Ø%g 通孔 + Ø%g 沉孔深 %g' % (small, big, CBORE_DEPTH[big]), drill=small, cbore=big)
    elif small >= 25:
        g.update(name='Ø%g 大孔銑穿' % small + ('（+0.025 公差，留 0.3 給搪孔）' if small == 35 else ''), mill=small)
    else:
        g.update(name='Ø%g 通孔' % small, drill=small)
print('孔位 %d 處：' % len(holes))
for n, c in collections.Counter(g['name'] for g in holes).most_common(): print('  %3d  %s' % (c, n))

# ---------------------------------------------------------------------------
# 封閉輪廓（面追蹤）
# ---------------------------------------------------------------------------
def arc_poly(c, r, a0, a1, n=None):
    if a1 < a0: a1 += 360
    n = n or max(8, int((a1 - a0) / 5))
    return [(c[0] + r * math.cos(math.radians(a0 + (a1 - a0) * i / n)), c[1] + r * math.sin(math.radians(a0 + (a1 - a0) * i / n))) for i in range(n + 1)]
segs = []
for l in LINES:
    if inR(l['start']) and inR(l['end']): segs.append(dict(kind='L', p0=l['start'][:2], p1=l['end'][:2], poly=[l['start'][:2], l['end'][:2]]))
for a in ARCS:
    if inR(a['center']):
        pp = arc_poly(a['center'], a['radius'], a['start_angle'], a['end_angle'])
        segs.append(dict(kind='A', p0=pp[0], p1=pp[-1], poly=pp, c=a['center'][:2], r=a['radius']))
for p in POLYS:
    pts = [q[:2] for q in p['points']]
    if len(pts) < 2 or not all(inR(q) for q in pts): continue
    xs = [q[0] for q in pts]; ys = [q[1] for q in pts]
    if (max(xs) - min(xs)) * K < 10 and (max(ys) - min(ys)) * K < 10: continue    # 文字
    bl = list(p.get('bulges') or [0] * len(pts))
    if p.get('closed'): pts = pts + [pts[0]]; bl.append(0)
    for i in range(len(pts) - 1):
        b = bl[i] if i < len(bl) else 0
        if abs(b) < 1e-9: segs.append(dict(kind='L', p0=pts[i], p1=pts[i + 1], poly=[pts[i], pts[i + 1]]))
        else:
            (x0, y0), (x1, y1) = pts[i], pts[i + 1]
            th = 4 * math.atan(b); d = math.hypot(x1 - x0, y1 - y0); r = d / (2 * math.sin(abs(th) / 2))
            mx, my = (x0 + x1) / 2, (y0 + y1) / 2; h = math.sqrt(max(r * r - (d / 2) ** 2, 0)); ux, uy = (x1 - x0) / d, (y1 - y0) / d
            s = 1 if b > 0 else -1; cx, cy = mx - s * uy * h, my + s * ux * h
            a0 = math.degrees(math.atan2(y0 - cy, x0 - cx)); a1 = math.degrees(math.atan2(y1 - cy, x1 - cx))
            if b > 0: pp = arc_poly((cx, cy), r, a0, a1); segs.append(dict(kind='A', p0=pp[0], p1=pp[-1], poly=pp, c=(cx, cy), r=r))
            else: pp = arc_poly((cx, cy), r, a1, a0); segs.append(dict(kind='A', p0=pp[0], p1=pp[-1], poly=pp, c=(cx, cy), r=r, rev=True))
TOL = 0.02; NODES = []; GRID = {}
def node(p):
    key = (round(p[0] / TOL), round(p[1] / TOL))
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            i = GRID.get((key[0] + dx, key[1] + dy))
            if i is not None and abs(NODES[i][0] - p[0]) < TOL and abs(NODES[i][1] - p[1]) < TOL: return i
    NODES.append(p); GRID[key] = len(NODES) - 1; return len(NODES) - 1
for s in segs: s['a'] = node(s['p0']); s['b'] = node(s['p1'])
alive = [True] * len(segs)
while True:     # 反覆剪掉懸空段（尺寸線、延伸線、引線）
    deg = collections.Counter()
    for i, s in enumerate(segs):
        if alive[i]: deg[s['a']] += 1; deg[s['b']] += 1
    rm = [i for i, s in enumerate(segs) if alive[i] and (deg[s['a']] == 1 or deg[s['b']] == 1)]
    if not rm: break
    for i in rm: alive[i] = False
live = [i for i in range(len(segs)) if alive[i]]
def dpoly(i, frm):
    s = segs[i]; return s['poly'] if s['a'] == frm else s['poly'][::-1]
def dir_out(i, frm): p = dpoly(i, frm); return math.atan2(p[1][1] - p[0][1], p[1][0] - p[0][0])
def dir_in(i, to): p = dpoly(i, segs[i]['a'] if segs[i]['b'] == to else segs[i]['b']); return math.atan2(p[-1][1] - p[-2][1], p[-1][0] - p[-2][0])
out = collections.defaultdict(list)
for i in live: out[segs[i]['a']].append(i); out[segs[i]['b']].append(i)
visited = set(); faces = []
for i in live:
    for frm in (segs[i]['a'], segs[i]['b']):
        if (i, frm) in visited: continue
        face = []; cur = i; cf = frm
        while (cur, cf) not in visited:
            visited.add((cur, cf)); face.append((cur, cf))
            to = segs[cur]['b'] if segs[cur]['a'] == cf else segs[cur]['a']
            ai = dir_in(cur, to); best = None
            for j in out[to]:
                if j == cur and len(out[to]) > 1: continue
                turn = (dir_out(j, to) - ai + math.pi) % (2 * math.pi) - math.pi
                if best is None or turn < best[0]: best = (turn, j)
            cur = best[1]; cf = to
        faces.append(face)
def face_pts(face):
    P = []
    for i, frm in face: P += dpoly(i, frm)[:-1]
    return P
def sarea(P): return 0.5 * sum(P[i][0] * P[(i + 1) % len(P)][1] - P[(i + 1) % len(P)][0] * P[i][1] for i in range(len(P)))
PLATE_AREA = PW * PH
# 去重（同一組線段兩個方向）、去掉板外形與零面積
uniq = {}
for f in faces:
    key = frozenset(i for i, _ in f); Amm = abs(sarea(face_pts(f))) * K * K
    if Amm < 1 or Amm > PLATE_AREA * 0.9: continue
    if key not in uniq or len(f) > len(uniq[key]): uniq[key] = f
faces = list(uniq.values())
# 連通元件：同一元件裡最大的面是「外框」，其餘是子面
comp_of = {}
def root(n):
    while comp_of.get(n, n) != n: n = comp_of[n]
    return n
for i in live:
    a, b = root(segs[i]['a']), root(segs[i]['b'])
    if a != b: comp_of[a] = b
comps = collections.defaultdict(list)
for f in faces: comps[root(segs[f[0][0]]['a'])].append(f)
contours = []      # 要切的
skipped = []       # 待確認的子面
for cid, fs in comps.items():
    fs.sort(key=lambda f: -abs(sarea(face_pts(f))))
    outer = fs[0]; subs = fs[1:]
    # 外框 = 元件的聯集邊界；若有子面，聯集面 = 最大面，主要切的是「最大的子面」
    if subs:
        main = subs[0]; rest = subs[1:]
        contours.append(main)
        for f in rest:
            if A.subfaces == 'thru': contours.append(f)
            else: skipped.append(f)
    else:
        contours.append(outer)
def describe(f):
    P = [mm(p) for p in face_pts(f)]; xs = [p[0] for p in P]; ys = [p[1] for p in P]
    arcs = [segs[i] for i, _ in f if segs[i]['kind'] == 'A']
    rr = collections.Counter(round(s['r'] * K, 1) for s in arcs)
    return dict(area=abs(sarea(P)), x0=min(xs), x1=max(xs), y0=min(ys), y1=max(ys), nseg=len(f), radii=dict(rr))
print('封閉輪廓：切 %d 個、待確認 %d 個' % (len(contours), len(skipped)))
for f in contours + skipped:
    d = describe(f); print('  %s %5d mm²  X %.1f..%.1f Y %.1f..%.1f  %d 段  圓角 %s' % ('切  ' if f in contours else '待確認', d['area'], d['x0'], d['x1'], d['y0'], d['y1'], d['nseg'], d['radii']))

# 輪廓內角檢查：材料的內凹角（圓心在面內）半徑要 ≥ 刀半徑
def min_inner_radius(f):
    P = [mm(p) for p in face_pts(f)]; n = len(P); r_min = None
    for i, _ in f:
        s = segs[i]
        if s['kind'] != 'A': continue
        c = mm(s['c']); inside = False
        for j in range(n):
            x1, y1 = P[j]; x2, y2 = P[(j + 1) % n]
            if (y1 > c[1]) != (y2 > c[1]) and c[0] < (x2 - x1) * (c[1] - y1) / (y2 - y1) + x1: inside = not inside
        if inside: r_min = s['r'] * K if r_min is None else min(r_min, s['r'] * K)
    return r_min
def is_obround(f):
    ss = [segs[i] for i, _ in f]
    arcs = [s for s in ss if s['kind'] == 'A']; lines = [s for s in ss if s['kind'] != 'A']
    if len(ss) == 4 and len(arcs) == 2 and len(lines) == 2 and abs(arcs[0]['r'] - arcs[1]['r']) < 1e-3:
        return dict(c1=mm(arcs[0]['c']), c2=mm(arcs[1]['c']), r=arcs[0]['r'] * K)
    return None

# ---------------------------------------------------------------------------
# 刀具：從現有刀具表挑
# ---------------------------------------------------------------------------
existing = []
if A.tools and not os.path.exists(A.tools): sys.exit('找不到刀具表：' + A.tools)
if not A.tools: note('沒有給 --tools 現有刀具表，所有刀都標成「需新增」。')
if A.tools:
    for r in csv.DictReader(open(A.tools, encoding='utf-8-sig')):
        d = r.get('請填_直徑mm') or r.get('推測直徑mm')
        try: d = float(str(d).replace('?', ''))
        except Exception: d = None
        existing.append(dict(type=r.get('請填_型式確認') or r.get('推測型式'), d=d, comment=r.get('程式註解', ''), prog=r.get('程式', ''), t=r.get('T', '')))
def find_existing(typ, d=None, comment_sub=None):
    for e in existing:
        if e['type'] != typ: continue
        if d is not None and (e['d'] is None or abs(e['d'] - d) > 0.05): continue
        if comment_sub and comment_sub.upper() not in e['comment'].upper(): continue
        return e
    return None
tools = []      # 依使用順序給 T 號
def add_tool(typ, d, comment, angle=None, pitch=None, key=None):
    key = key or (typ, d, comment)
    for t in tools:
        if t['key'] == key: return t
    ex = find_existing(typ, d) if typ != '絲攻' else find_existing('絲攻', None, comment.split('*')[0])
    t = dict(key=key, t=len(tools) + 1, type=typ, d=d, comment=comment, angle=angle, pitch=pitch,
             status=('現有（%s %s）' % (ex['prog'], ex['t'])) if ex else '需新增', dregs=[])
    tools.append(t); return t

# ---------------------------------------------------------------------------
# 切削條件（鋁，保守）——現場程式是切 316 用的數字，鋁可以更快；上機前請看報告調整
# ---------------------------------------------------------------------------
def drill_sf(d):
    s = min(3000, int(25000 / (math.pi * d) / 10) * 10); f = int(s * (0.03 + 0.008 * d) / 5) * 5; return s, max(f, 30)
EM8 = dict(d=8.0, s=2800, f=300, fz=120, doc=3.0, step=4.0)     # Ø8 平刀
EM4 = dict(d=4.0, s=3000, f=150, fz=60, doc=1.5, step=2.0)
SPOT = dict(s=1500, f=60)
SAFE_Z, R_PLANE, THRU_EXTRA = 50.0, 2.0, 0.3

# ---------------------------------------------------------------------------
# NC 產生
# ---------------------------------------------------------------------------
def N(v):
    s = ('%.3f' % v).rstrip('0').rstrip('.')
    if '.' not in s: s += '.'
    if s == '-0.': s = '0.'
    return s
nc = []
def L(s): nc.append(s)
def tool_start(t, x, y, z=10.0):
    L('M6T%d(%s)' % (t['t'], t['comment']))
    L('G0G90G54X%sY%sG43H%dZ%sM3S%d' % (N(x), N(y), t['t'], N(z), t['s']))
def tool_end(cycle=False):
    L('G0Z%sM5' % N(SAFE_Z)); L('M9'); L('G91G28%sZ0.' % ('G80' if cycle else ''))
def snake(pts):
    pts = sorted(pts, key=lambda p: (round(p['x'] / 60), p['y']))
    out = []; band = None; buf = []
    for p in pts:
        b = round(p['x'] / 60)
        if band is not None and b != band:
            out += buf if (band % 2 == 0) else buf[::-1]; buf = []
        band = b; buf.append(p)
    out += buf if (band % 2 == 0) else buf[::-1]
    return out
def helix_circle_pocket(cx, cy, R, z_top, z_bot, em, finish_dia=None):
    """圓孔用平刀分層清料：每層先螺旋下刀，再由內往外一圈圈擴到 R（R = 孔半徑）。finish_dia 給的話最後一圈用它。"""
    rt = em['d'] / 2; rf = (finish_dia / 2 if finish_dia else R) - rt
    if rf < 0.3: raise ValueError('孔 Ø%g 比刀還小' % (2 * R))
    rh = min(2.0, rf)
    levels = []; z = z_top
    while z - em['doc'] > z_bot + 1e-6: z -= em['doc']; levels.append(z)
    levels.append(z_bot)
    L('G0X%sY%s' % (N(cx + rh), N(cy))); L('Z%s' % N(R_PLANE))
    zc = R_PLANE
    for z in levels:
        # 螺旋下刀（每圈 1.5 mm）
        while zc - z > 1e-6:
            zn = max(z, zc - 1.5); L('G3X%sY%sZ%sI%sF%d' % (N(cx + rh), N(cy), N(zn), N(-rh), em['fz'])); zc = zn
        L('G3X%sY%sI%sF%d' % (N(cx + rh), N(cy), N(-rh), em['f']))
        r = rh
        while r < rf - 1e-6:
            r = min(rf, r + em['step']); L('G1X%s' % N(cx + r)); L('G3I%s' % N(-r))
        if levels[-1] != z: L('G1X%s' % N(cx + rh))
    L('G1X%sY%s' % (N(cx), N(cy))); L('G0Z%s' % N(R_PLANE))
def obround_pocket(c1, c2, R, z_bot, em):
    """長圓槽分層清料：同心縮小的長圓一圈圈往外。"""
    rt = em['d'] / 2; rf = R - rt
    dx, dy = c2[0] - c1[0], c2[1] - c1[1]; ln = math.hypot(dx, dy); ux, uy = dx / ln, dy / ln; nx, ny = -uy, ux
    rh = min(2.0, rf)
    levels = []; z = 0.0
    while z - em['doc'] > z_bot + 1e-6: z -= em['doc']; levels.append(z)
    levels.append(z_bot)
    L('G0X%sY%s' % (N(c1[0] + rh * nx), N(c1[1] + rh * ny))); L('Z%s' % N(R_PLANE)); zc = R_PLANE
    for z in levels:
        while zc - z > 1e-6:
            zn = max(z, zc - 1.5); L('G3X%sY%sZ%sI%sJ%sF%d' % (N(c1[0] + rh * nx), N(c1[1] + rh * ny), N(zn), N(-rh * nx), N(-rh * ny), em['fz'])); zc = zn
        r = rh
        while True:
            # 長圓：c1 側半圓 → 直線 → c2 側半圓 → 直線，逆時針（材料在右手、G41 方向）
            p1 = (c1[0] + r * nx, c1[1] + r * ny); p2 = (c1[0] - r * nx, c1[1] - r * ny)
            p3 = (c2[0] - r * nx, c2[1] - r * ny); p4 = (c2[0] + r * nx, c2[1] + r * ny)
            L('G1X%sY%sF%d' % (N(p1[0]), N(p1[1]), em['f']))
            L('G3X%sY%sI%sJ%s' % (N(p2[0]), N(p2[1]), N(-r * nx), N(-r * ny)))
            L('G1X%sY%s' % (N(p3[0]), N(p3[1])))
            L('G3X%sY%sI%sJ%s' % (N(p4[0]), N(p4[1]), N(r * nx), N(r * ny)))     # c2 端：圓心在 p3 的 +n 方向
            L('G1X%sY%s' % (N(p1[0]), N(p1[1])))
            if r >= rf - 1e-6: break
            r = min(rf, r + em['step'])
        if levels[-1] != z: L('G1X%sY%s' % (N(c1[0] + rh * nx), N(c1[1] + rh * ny)))
    L('G1X%sY%s' % (N(c1[0]), N(c1[1]))); L('G0Z%s' % N(R_PLANE))
def contour_path(f, ccw=True):
    """把面轉成有向線段清單（mm），逆時針（窗口內側切削、材料在右手 → G41）。從最長直線的中點出發。"""
    P = [mm(p) for p in face_pts(f)]
    order = list(f) if (sarea(P) > 0) == ccw else [(i, (segs[i]['b'] if segs[i]['a'] == frm else segs[i]['a'])) for i, frm in reversed(f)]
    path = []
    for i, frm in order:
        s = segs[i]; pp = dpoly(i, frm); p0 = mm(pp[0]); p1 = mm(pp[-1])
        if s['kind'] == 'A':
            fwd = (s['a'] == frm) != bool(s.get('rev'))     # DWG 弧是逆時針定義；正向走 → G3
            path.append(dict(kind='A', p0=p0, p1=p1, c=mm(s['c']), ccw=fwd, r=s['r'] * K))
        else: path.append(dict(kind='L', p0=p0, p1=p1))
    # 從最長直線中點出發
    li = max((j for j, p in enumerate(path) if p['kind'] == 'L'), key=lambda j: math.hypot(path[j]['p1'][0] - path[j]['p0'][0], path[j]['p1'][1] - path[j]['p0'][1]))
    seg = path[li]; m = ((seg['p0'][0] + seg['p1'][0]) / 2, (seg['p0'][1] + seg['p1'][1]) / 2)
    path = [dict(kind='L', p0=m, p1=seg['p1'])] + path[li + 1:] + path[:li] + [dict(kind='L', p0=seg['p0'], p1=m)]
    return path
def emit_path(path):
    for p in path:
        if p['kind'] == 'L': L('G1X%sY%s' % (N(p['p1'][0]), N(p['p1'][1])))
        else: L('%sX%sY%sI%sJ%s' % ('G3' if p['ccw'] else 'G2', N(p['p1'][0]), N(p['p1'][1]), N(p['c'][0] - p['p0'][0]), N(p['c'][1] - p['p0'][1])))
def contour_cut(f, z_bot, em, dreg, feed=None, levels=None, lead=10.0):
    path = contour_path(f, ccw=True)
    s0 = path[0]['p0']; e = path[0]['p1']; dx, dy = e[0] - s0[0], e[1] - s0[1]; ln = math.hypot(dx, dy)
    lead_pt = (s0[0] - dy / ln * lead, s0[1] + dx / ln * lead)     # 左法線 = 面內側（逆時針時內側在左）
    if levels is None:
        levels = []; z = 0.0
        while z - em['doc'] > z_bot + 1e-6: z -= em['doc']; levels.append(z)
        levels.append(z_bot)
    L('G0X%sY%s' % (N(lead_pt[0]), N(lead_pt[1]))); L('Z%s' % N(R_PLANE))
    for z in levels:
        L('G1Z%sF%d' % (N(z), em['fz']))
        L('G1G41D%dX%sY%sF%d' % (dreg, N(s0[0]), N(s0[1]), feed or em['f']))
        emit_path(path)
        L('G1G40X%sY%s' % (N(lead_pt[0]), N(lead_pt[1])))
    L('G0Z%s' % N(R_PLANE))

# ---- 規劃 ----
t_spot = add_tool('V型倒角刀', 10, '10V', angle=90); t_spot.update(s=SPOT['s'], f=SPOT['f'])
drilled = [g for g in holes if g['drill']]
tapped = [g for g in holes if g['tap']]
cbored = [g for g in holes if g['cbore']]
milled = [g for g in holes if g['mill']]
obrounds = []; generic = []
for f in contours:
    ob = is_obround(f)
    (obrounds if ob else generic).append((f, ob))

L('%'); L('O%04d(%s)' % (A.onum, NAME.upper()[:24]))
L('(DWG2NC %s  PLATE %gX%gX%g AL  ORIGIN %s-TOP)' % (datetime.date.today().isoformat(), PW, PH, PT, A.origin.upper()))
L('(SPEEDS FOR ALUMINUM - CHECK BEFORE RUN)')
L('G40G49G80')

# 1. 點鑽
if drilled:
    pts = snake(drilled); p0 = pts[0]
    tool_start(t_spot, p0['x'], p0['y'])
    L('G98R%sG81Z-1.5F%dM8' % (N(R_PLANE), t_spot['f']))
    for p in pts[1:]: L('X%sY%s' % (N(p['x']), N(p['y'])))
    L('G80'); tool_end(True)

# 2. 鑽孔（依直徑分組）
for d in sorted({g['drill'] for g in drilled}):
    grp = snake([g for g in drilled if g['drill'] == d])
    s, f = drill_sf(d); t = add_tool('鑽頭', d, 'SG-%g' % d, angle=118); t.update(s=s, f=f)
    z = -(PT + 0.3 * d + 1.0)
    tool_start(t, grp[0]['x'], grp[0]['y'])
    L('G98R%sG83Q1.Z%sF%dM8' % (N(R_PLANE), N(z), f))
    for p in grp[1:]: L('X%sY%s' % (N(p['x']), N(p['y'])))
    L('G80'); tool_end(True)

# 3. 沉孔（Ø8 平刀）
t_em8 = add_tool('平銑刀', 8, '8MM'); t_em8.update(EM8); t_em8['dregs'] = [t_em8['t']]
if cbored or milled or obrounds or generic:
    first = (cbored + milled)[0] if (cbored or milled) else None
    x0, y0 = (first['x'], first['y']) if first else (0, 0)
    tool_start(t_em8, x0, y0); L('M8'); L('G05.1Q1')
    for g in snake(cbored):
        L('(CBORE D%g X%s Y%s)' % (g['cbore'], N(g['x']), N(g['y'])))
        helix_circle_pocket(g['x'], g['y'], g['cbore'] / 2, 0.0, -CBORE_DEPTH[g['cbore']], EM8)
    # 4. 大孔銑穿
    for g in snake(milled):
        fin = 35 - 0.6 if g['mill'] == 35 else None
        L('(HOLE D%g X%s Y%s%s)' % (g['mill'], N(g['x']), N(g['y']), ' LEAVE 0.3 FOR BORING' if fin else ''))
        helix_circle_pocket(g['x'], g['y'], g['mill'] / 2, 0.0, -(PT + THRU_EXTRA), EM8, finish_dia=fin)
    # 5. 長圓槽
    for f, ob in obrounds:
        L('(SLOT R%g)' % round(ob['r'], 2)); obround_pocket(ob['c1'], ob['c2'], ob['r'], -(PT + THRU_EXTRA), EM8)
    # 6. 窗口輪廓（G41）
    for f, _ in generic:
        rmin = min_inner_radius(f)
        if rmin is not None and rmin < EM8['d'] / 2 - 1e-6:
            note('輪廓內角最小 R%.1f 小於 Ø8 刀半徑，這個輪廓改用 Ø4 刀。' % rmin)
            continue
        d = describe(f); L('(WINDOW %dX%d)' % (d['x1'] - d['x0'], d['y1'] - d['y0']))
        z_bot = -(PT - A.skin) if A.skin > 0 else -(PT + THRU_EXTRA)
        contour_cut(f, z_bot, EM8, t_em8['t'])
    L('G05.1Q0'); tool_end()
# 6b. 需要 Ø4 刀的輪廓
small = [f for f, _ in generic if (min_inner_radius(f) or 99) < EM8['d'] / 2 - 1e-6]
if small:
    t_em4 = add_tool('平銑刀', 4, '4MM'); t_em4.update(EM4); t_em4['dregs'] = [t_em4['t']]
    d = describe(small[0]); tool_start(t_em4, d['x0'], d['y0']); L('M8'); L('G05.1Q1')
    for f in small:
        d = describe(f); L('(CONTOUR %dX%d SMALL CORNERS)' % (d['x1'] - d['x0'], d['y1'] - d['y0']))
        contour_cut(f, -(PT + THRU_EXTRA), EM4, t_em4['t'])
    L('G05.1Q0'); tool_end()

# 7. 攻牙
for (tapname, pitch) in sorted({g['tap'] for g in tapped}):
    grp = snake([g for g in tapped if g['tap'] == (tapname, pitch)])
    s = 300 if pitch <= 0.8 else 250; t = add_tool('絲攻', float(tapname[1:]), '%s*P%g' % (tapname, pitch), pitch=pitch); t.update(s=s, f=int(s * pitch))
    tool_start(t, grp[0]['x'], grp[0]['y'], z=30.0)
    L('M29S%d' % s)
    L('G98R3.G84Z%sF%d' % (N(-(PT + 3.0)), t['f']))
    for p in grp[1:]: L('X%sY%s' % (N(p['x']), N(p['y'])))
    L('G80'); tool_end(True)

# 8. 搪孔（Ø35 公差孔）
bore = [g for g in milled if g['mill'] == 35]
if bore:
    t_b = add_tool('搪孔刀', 35, 'BORING 35'); t_b.update(s=800, f=60)
    tool_start(t_b, bore[0]['x'], bore[0]['y'])
    L('G98R%sG85Z%sF%dM8' % (N(R_PLANE), N(-(PT + 1.0)), t_b['f']))
    for p in bore[1:]: L('X%sY%s' % (N(p['x']), N(p['y'])))
    L('G80'); tool_end(True)

# 9. 倒角 C0.5（10V 倒角刀）：小孔用 G81 到對應深度；大孔／槽／窗口用輪廓走
D_CHAMFER = 21
t_spot['dregs'] = [D_CHAMFER]
CHAMFER_TOOL_D = 10.0
edge_holes = [(g, (g['cbore'] or g['drill'])) for g in holes if (g['drill'] or g['cbore'])]
# 下插倒角的切削直徑 = 孔徑 + 1，不能超過 V 刀直徑（留 1 mm 餘裕）；太大的孔口改走圓
plunge_holes = [(g, dd) for g, dd in edge_holes if dd + 1.0 <= CHAMFER_TOOL_D - 1.0]
circle_edges = [dict(x=g['x'], y=g['y'], mill=dd) for g, dd in edge_holes if dd + 1.0 > CHAMFER_TOOL_D - 1.0] + milled
if edge_holes or milled or obrounds or generic:
    pts = snake([dict(x=g['x'], y=g['y'], d=dd) for g, dd in plunge_holes])
    tool_start(t_spot, pts[0]['x'] if pts else 0, pts[0]['y'] if pts else 0)
    if pts:
        cur = None
        for p in pts:
            z = -(p['d'] / 2 + 0.5)
            if cur is None: L('G98R%sG81Z%sF%dM8' % (N(R_PLANE), N(z), SPOT['f'])); cur = z
            elif abs(z - cur) > 1e-6: L('X%sY%sZ%s' % (N(p['x']), N(p['y']), N(z))); cur = z
            else: L('X%sY%s' % (N(p['x']), N(p['y'])))
        L('G80')
    ZC = -2.0   # 刀尖 Z-2：90° 刀在表面切削半徑 2，路徑往外 0.5 → 圓：半徑 R-1.5；輪廓：G41 D=1.5
    for g in snake(circle_edges):
        r = g['mill'] / 2 - 1.5; L('(CHAMFER D%g)' % g['mill'])
        L('G0X%sY%s' % (N(g['x'] + r), N(g['y']))); L('Z%s' % N(R_PLANE)); L('G1Z%sF%d' % (N(ZC), SPOT['f']))
        L('G3I%sF%d' % (N(-r), SPOT['f'] * 2)); L('G0Z%s' % N(R_PLANE))
    for f, ob in obrounds:
        L('(CHAMFER SLOT)'); contour_cut(f, ZC, dict(d=0, doc=99, fz=SPOT['f'], f=SPOT['f'] * 2), D_CHAMFER, levels=[ZC], lead=6.0)
    for f in [f for f, _ in generic]:
        L('(CHAMFER WINDOW)'); contour_cut(f, ZC, dict(d=0, doc=99, fz=SPOT['f'], f=SPOT['f'] * 2), D_CHAMFER, levels=[ZC], lead=10.0)
    tool_end(True)
L('G91G28Y0.'); L('M30'); L('%')

# ---------------------------------------------------------------------------
# 輸出
# ---------------------------------------------------------------------------
key = 'O%04d' % A.onum
nc_path = os.path.join(A.out, key + '.nc')
open(nc_path, 'w', encoding='utf-8', newline='\n').write('\n'.join(nc) + '\n')
HDR = ['程式', 'T', '程式註解', '推測型式', '推測直徑mm', '用途', '最深Z', '請填_型式確認', '請填_直徑mm', '請填_刀尖或倒角角度',
       '請填_刃長mm', '請填_伸出長mm', '請填_角R半徑mm', '請填_頸徑mm', '用到的D號', '請填_各D補正值', '備註']
csv_path = os.path.join(A.out, key + '_tools.csv')
with open(csv_path, 'w', newline='', encoding='utf-8-sig') as fcsv:
    w = csv.writer(fcsv); w.writerow(HDR)
    for t in tools:
        dregs = ','.join('D%d' % n for n in t['dregs'])
        dvals = '；'.join('D%d=%s' % (n, '1.5000' if n == D_CHAMFER else '%.4f' % (t['d'] / 2)) for n in t['dregs'])
        w.writerow([key, 'T%d' % t['t'], t['comment'], t['type'], t['d'], 'G41' if t['dregs'] else '面銑/一般切削', '',
                    t['type'], t['d'], t.get('angle') or '', '', '', '', '', dregs, dvals,
                    t['status'] + ('；D%d 是倒角輪廓用的補正值 1.5，不是刀半徑' % D_CHAMFER if D_CHAMFER in t['dregs'] else '')])
anchor = {'LB': (0, 0), 'RB': (1, 0), 'LT': (0, 1), 'RT': (1, 1)}[A.origin.upper()]
stock_path = os.path.join(A.out, key + '.stock.json')
json.dump({'spec': {'shape': 'box', 'size': {'x': PW, 'y': PH, 'z': PT}, 'anchor': {'x': anchor[0], 'y': anchor[1], 'z': 1}, 'pos': {'x': 0, 'y': 0, 'z': 0}}, 'fixtures': []},
          open(stock_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

# 報告
rep = []
rep.append('# %s → %s 轉檔報告（%s）\n' % (os.path.basename(A.dwg), key, datetime.date.today().isoformat()))
rep.append('素材 %gx%gx%g，原點：板%s角、上表面。程式 %d 行、%d 把刀。\n' % (PW, PH, PT, {'LB': '左下', 'RB': '右下', 'LT': '左上', 'RT': '右上'}[A.origin.upper()], len(nc), len(tools)))
rep.append('## 刀具\n\n| T | 註解 | 型式 | Ø | S | F | 狀態 |\n|---|---|---|---|---|---|---|')
for t in tools: rep.append('| T%d | %s | %s | %g | %s | %s | %s |' % (t['t'], t['comment'], t['type'], t['d'], t.get('s', ''), t.get('f', ''), t['status']))
rep.append('\n## 加工內容\n')
for n, c in collections.Counter(g['name'] for g in holes).most_common(): rep.append('- %d 處 %s' % (c, n))
for f, ob in obrounds: rep.append('- 長圓槽 R%.1f，中心 (%.1f, %.1f)–(%.1f, %.1f)，Ø8 平刀分層清料切穿' % (ob['r'], ob['c1'][0], ob['c1'][1], ob['c2'][0], ob['c2'][1]))
for f, _ in generic:
    d = describe(f); rep.append('- 窗口 %.0f×%.0f mm（X %.1f..%.1f，Y %.1f..%.1f），%d 段，圓角 %s，Ø8 平刀 G41 輪廓分層切穿' % (d['x1'] - d['x0'], d['y1'] - d['y0'], d['x0'], d['x1'], d['y0'], d['y1'], d['nseg'], d['radii']))
rep.append('\n## 假設與待確認\n')
note('沉孔深度圖上文字讀不到，用的是 Ø10.5 深 6、Ø12 深 8（圖上的 ▽6／▽8），請核對。')
note('切削條件是鋁的保守值（S/F 見刀具表），現場程式是切 316 的數字，兩者不同；上機前請調整。')
note('通孔與窗口切到板下 %.1f mm，需要墊板；窗口切穿後中間那塊料會掉，要用吸盤／雙面膠／墊板固定，或用 --skin 0.3 留皮。' % THRU_EXTRA)
note('Ø35 +0.025 軸承孔：Ø8 銑到 Ø34.4，最後用搪孔刀 G85 精搪，搪刀需新增並在機台調到 Ø35。')
note('倒角 C0.5 用 10V 刀（假設刀尖是尖的；若有平刃，下插深度要減掉平刃半徑）：Ø8 以下的孔 G81 下插到「孔半徑+0.5」；更大的孔口、大孔、槽、窗口都用刀尖 Z-2 走輪廓，輪廓用 D%d=1.5 的補正（不是刀半徑）。' % D_CHAMFER)
for f in skipped:
    d = describe(f); note('待確認：窗口內的小區域 %.0f×%.0f mm（X %.1f..%.1f，Y %.1f..%.1f，內角 %s）沒有切。圖上看不出是穿透還是階梯；確認後用 --subfaces thru 切穿，或告訴我深度。' % (d['x1'] - d['x0'], d['y1'] - d['y0'], d['x0'], d['x1'], d['y0'], d['y1'], d['radii']))
for s in notes: rep.append('- ' + s)
rep.append('\n## 怎麼用\n\n1. 把 `%s` 拖進預演台。\n2. 再把 `%s` 拖進去（刀具表匯入）。\n3. 再把 `%s` 拖進去（素材）。\n' % (os.path.basename(nc_path), os.path.basename(csv_path), os.path.basename(stock_path)))
rep_path = os.path.join(A.out, key + '_report.md')
open(rep_path, 'w', encoding='utf-8').write('\n'.join(rep) + '\n')
print('\n輸出：\n  %s（%d 行）\n  %s（%d 把刀）\n  %s\n  %s' % (nc_path, len(nc), csv_path, len(tools), stock_path, rep_path))
