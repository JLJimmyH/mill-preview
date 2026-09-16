// 用預演台的核心模組（無頭）分析 dwg2nc 產出的程式：刀具表 CSV + 素材 JSON 一起餵進去，列出診斷。
// 用法（repo 根目錄）：node tools/dwg2nc/verify_nc.mjs <輸出資料夾>/O2001   （不含副檔名）
import fs from 'node:fs';
import path from 'node:path';
import { loadNC } from '../../nc-preview/test/load.mjs';

const base = process.argv[2];
if (!base) { console.error('用法：node tools/dwg2nc/verify_nc.mjs <輸出資料夾>/O2001（不含副檔名）'); process.exit(1); }
const NC = loadNC();
const text = fs.readFileSync(base + '.nc', 'utf8');
const csv = fs.readFileSync(base + '_tools.csv', 'utf8');
const stockJson = JSON.parse(fs.readFileSync(base + '.stock.json', 'utf8'));
const table = NC.tools.fromCSV(csv);
const stock = NC.analysis.stockFromSpec(stockJson.spec, stockJson.fixtures || []);
const t0 = Date.now();
const res = await NC.analyze({ text, toolTable: table, stock, sim: { enabled: true, cell: Number(process.env.CELL) || 1.0 } });
const off = res.scenarios ? res.scenarios[res.order ? res.order[0] : Object.keys(res.scenarios)[0]] : res;
console.log(`行 ${res.tok.blocks.length}｜刀 ${res.toolTable.tools.length}｜素材 ${JSON.stringify(res.stock.min)}~${JSON.stringify(res.stock.max)}（${res.stock.source}）｜${Date.now() - t0} ms`);
if (off && off.run) console.log(`作業 ${off.run.ops.length}｜段 ${off.geometry.segments.length}`);
console.log('刀具表：');
for (const t of res.toolTable.tools) console.log(`  T${t.t} ${t.label} ${t.type} Ø${t.diameter} ${t.angle ? t.angle + '°' : ''} src=${t.source.type}/${t.source.diameter}`);
const bySev = {};
for (const d of res.diagnostics) bySev[d.severity] = (bySev[d.severity] || 0) + 1;
console.log('診斷數：', bySev);
const byRule = {};
for (const d of res.diagnostics) { const k = `${d.severity} ${d.rule || d.code || d.id}`; byRule[k] = byRule[k] || { n: 0, msg: d.message, lines: [] }; byRule[k].n++; if (byRule[k].lines.length < 5) byRule[k].lines.push(d.line); }
for (const [k, v] of Object.entries(byRule).sort()) console.log(`  ${v.n.toString().padStart(4)}  ${k}  行 ${v.lines.join(',')}  ${v.msg}`);
if (process.argv.includes('--detail')) for (const d of res.diagnostics.filter((d) => d.severity === 'error' || d.severity === 'needsInput')) console.log(`  L${d.line} ${d.severity} ${d.message} ${d.detail || ''}`);
// 刀具路徑倒成 JSON 給 plot_paths.py 畫圖（補正後的路徑）
if (off && off.geometry) {
  const segs = off.geometry.segments.map((s) => ({ t: s.tool, k: s.kind, x0: s.from.x, y0: s.from.y, z0: s.from.z, x1: s.to.x, y1: s.to.y, z1: s.to.z,
    arc: s.arc ? { cx: s.arc.center.x, cy: s.arc.center.y, cw: !!s.arc.cw } : null }));
  fs.writeFileSync(base + '_paths.json', JSON.stringify({ stock: { min: res.stock.min, max: res.stock.max }, segs }));
  console.log(`路徑已存 ${base}_paths.json（${segs.length} 段）`);
}
