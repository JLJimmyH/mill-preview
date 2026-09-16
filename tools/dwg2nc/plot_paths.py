# -*- coding: utf-8 -*-
"""把 verify_nc.mjs 倒出的刀具路徑畫成圖：python tools/dwg2nc/plot_paths.py <輸出資料夾>/O2001（不含副檔名）"""
import sys, io, json, math
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.collections import LineCollection
if len(sys.argv) < 2: sys.exit('用法：python tools/dwg2nc/plot_paths.py <輸出資料夾>/O2001（不含副檔名）')
base = sys.argv[1]
d = json.load(open(base + '_paths.json', encoding='utf-8'))
st = d['stock']; segs = d['segs']
tools = sorted({s['t'] for s in segs if s['t'] is not None})
cmap = plt.get_cmap('tab20')
color = {t: cmap(i % 20) for i, t in enumerate(tools)}
def arc_pts(s, n=24):
    c = s['arc']; r = math.hypot(s['x0'] - c['cx'], s['y0'] - c['cy'])
    a0 = math.atan2(s['y0'] - c['cy'], s['x0'] - c['cx']); a1 = math.atan2(s['y1'] - c['cy'], s['x1'] - c['cx'])
    sw = (a1 - a0) % (2 * math.pi)
    if c['cw']: sw = sw - 2 * math.pi
    if abs(sw) < 1e-9 and math.hypot(s['x1'] - s['x0'], s['y1'] - s['y0']) < 1e-6: sw = -2 * math.pi if c['cw'] else 2 * math.pi
    return [(c['cx'] + r * math.cos(a0 + sw * i / n), c['cy'] + r * math.sin(a0 + sw * i / n)) for i in range(n + 1)]
fig, axes = plt.subplots(2, 1, figsize=(26, 20), dpi=90)
FEED = ('feed', 'arc', 'cycle', 'drill')
for ax, title, keep in ((axes[0], '鑽孔／攻牙／倒角／搪孔（固定循環＝點；灰虛線＝快速移動）', lambda s: s['t'] != 9),
                        (axes[1], 'Ø8 平刀（T9）：沉孔、大孔、長圓槽、窗口的補正後進給路徑', lambda s: s['t'] == 9 and s['k'] in FEED)):
    ax.add_patch(plt.Rectangle((st['min']['x'], st['min']['y']), st['max']['x'] - st['min']['x'], st['max']['y'] - st['min']['y'], fill=False, lw=1.5, ec='#333'))
    feed = []; fc = []; rap = []
    for s in segs:
        if not keep(s): continue
        pts = arc_pts(s) if s['arc'] else [(s['x0'], s['y0']), (s['x1'], s['y1'])]
        if s['k'] == 'rapid': rap.append(pts)
        else: feed.append(pts); fc.append(color.get(s['t'], 'k'))
    ax.add_collection(LineCollection(rap, colors='#bbb', linewidths=0.3, linestyles='dotted'))
    ax.add_collection(LineCollection(feed, colors=fc, linewidths=0.6))
    ax.set_aspect('equal'); ax.autoscale(); ax.grid(True, alpha=0.3); ax.set_title(title)
    for t in tools: ax.plot([], [], color=color[t], label='T%d' % t)
    ax.legend(loc='upper right', ncol=7, fontsize=8)
plt.rcParams['font.sans-serif'] = ['Microsoft JhengHei', 'Noto Sans CJK TC', 'sans-serif']
out = base + '_paths.png'; fig.savefig(out, bbox_inches='tight'); print('saved', out, len(segs), 'segs')
