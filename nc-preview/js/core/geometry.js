/*
 * 銑床預演台 — geometry.js
 * 把 interpreter 產生的 Run（ExecutedBlock/Action）轉成 Segment 清單：
 *   - rapid/linear/arc → programmed 段；refReturn → 兩段 rapid；hole → 固定循環展開
 *   - ,C / ,R 倒角／圓角展開
 *   - 刀徑補正（G41/G42）→ 另外產出 path:'compensated' 的刀心路徑
 *   - bounds、sampleSegment、segmentLength、arcFromR 等工具
 * 刀徑補正演算法以 NIST RS274/NGC 附錄 B 為藍本：直線／圓弧各自平移 r，
 * 外角（轉向與補正側相反）插入以程式轉角為圓心的圓弧，內角求交點截斷；求不到交點 → PS0041。
 * 只支援 G17 平面（XY 補正，Z 直接帶過）。
 */
(function (NC) {
  'use strict';

  const U = NC.util;
  const EPS = 1e-6;          // 距離容差（mm）
  const TANGENT_EPS = 2e-3;  // 補正接點視為相切的折角上限（rad）；見 applyCompensation 的 junction
  // R 指定圓弧的半徑誤差容許量（mm）：和 interpreter 用同一個值（Fanuc 參數 3410 等級，不是浮點容差）
  const ARC_R_TOL = (NC.interpreter && NC.interpreter.ARC_R_TOL > 0) ? NC.interpreter.ARC_R_TOL : 0.01;
  const ANG_EPS = 1e-7;      // 角度容差（rad）
  const TAU = Math.PI * 2;
  const PECK_CLEARANCE = 0.5;  // G83 啄鑽：快速回到上次深度前的餘隙 d（Fanuc 參數 5115，預設 0.5 mm）
  const G73_RETRACT = 0.5;     // G73 高速啄鑽：每次只退刀 d（參數 5114），本版同樣取 0.5 mm

  // ---------------------------------------------------------------------------
  // 2D 向量小工具
  // ---------------------------------------------------------------------------
  const v2 = (x, y) => ({ x, y });
  const sub2 = (a, b) => v2(a.x - b.x, a.y - b.y);
  const add2 = (a, b) => v2(a.x + b.x, a.y + b.y);
  const mul2 = (a, k) => v2(a.x * k, a.y * k);
  const dot2 = (a, b) => a.x * b.x + a.y * b.y;
  const cross2 = (a, b) => a.x * b.y - a.y * b.x;
  const len2 = (a) => Math.hypot(a.x, a.y);
  const norm2 = (a) => { const l = len2(a); return l > 1e-12 ? v2(a.x / l, a.y / l) : v2(0, 0); };
  const left2 = (d) => v2(-d.y, d.x);   // 左轉 90°
  const right2 = (d) => v2(d.y, -d.x);  // 右轉 90°
  const xy = (p) => v2(p.x, p.y);
  const v3 = (x, y, z) => ({ x, y, z });
  const c3 = (p) => v3(p.x, p.y, p.z);
  const isOn = (comp) => comp === 'G41' || comp === 'G42';
  const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v)) ? v : fallback;

  function normAngle(a) { a = a % TAU; if (a < 0) a += TAU; return a; }

  /** 由圓心、起終點、方向算圓弧掃過的角度（0 < sweep <= 2π；起終點重合 = 整圓）。 */
  function arcSweep(center, from, to, cw) {
    const a0 = Math.atan2(from.y - center.y, from.x - center.x);
    const a1 = Math.atan2(to.y - center.y, to.x - center.x);
    let s = normAngle(cw ? a0 - a1 : a1 - a0);
    if (s < ANG_EPS) s = (Math.hypot(from.x - to.x, from.y - to.y) < EPS) ? TAU : 0;
    return s;
  }

  /** 點 p 在圓弧上（從起點沿方向）的角度參數，[0, 2π)。 */
  function arcAngleOf(arc, p) {
    const a0 = Math.atan2(arc.a.y - arc.c.y, arc.a.x - arc.c.x);
    const ap = Math.atan2(p.y - arc.c.y, p.x - arc.c.x);
    return normAngle(arc.cw ? a0 - ap : ap - a0);
  }

  // ---------------------------------------------------------------------------
  // 公用工具：arcFromR / segmentLength / sampleSegment
  // ---------------------------------------------------------------------------
  /**
   * 由 R 算圓心（G17 平面）。r>0 = 小於等於 180° 的弧；r<0 = 大弧。
   * 弦長 > 2|r|（超過容差）→ 回傳 null（interpreter 會退化成直線）。
   * @returns {{center:Vec2}|null}
   */
  function arcFromR(from, to, r, cw) {
    const chord = sub2(xy(to), xy(from));
    const d = len2(chord);
    const ar = Math.abs(r);
    if (d < EPS || ar < EPS) return null;
    if (d > 2 * ar + ARC_R_TOL) return null;
    const h2 = ar * ar - (d / 2) * (d / 2);
    const h = h2 > 0 ? Math.sqrt(h2) : 0;
    const mid = v2((from.x + to.x) / 2, (from.y + to.y) / 2);
    // 順時針小弧：圓心在弦的右側；逆時針小弧：左側；大弧（r<0）反過來
    const sgn = (cw ? -1 : 1) * (r > 0 ? 1 : -1);
    const n = left2(norm2(chord));
    return { center: add2(mid, mul2(n, sgn * h)) };
  }

  /** 段長（弧 = 弧長與 Z 位移的合成）。 */
  function segmentLength(seg) {
    if (!seg.arc) return U.dist3(seg.from, seg.to);
    const sweep = arcSweep(seg.arc.center, seg.from, seg.to, seg.arc.cw);
    const r = num(seg.arc.r, Math.hypot(seg.from.x - seg.arc.center.x, seg.from.y - seg.arc.center.y));
    return Math.hypot(r * sweep, seg.to.z - seg.from.z);
  }

  /** 取樣：直線 → 兩端點；弧依弦差 tol 細分（含兩端點）。 */
  function sampleSegment(seg, tol = 0.05) {
    if (!seg.arc) return [c3(seg.from), c3(seg.to)];
    const c = seg.arc.center;
    const cw = !!seg.arc.cw;
    const r0 = Math.hypot(seg.from.x - c.x, seg.from.y - c.y);
    const r1 = Math.hypot(seg.to.x - c.x, seg.to.y - c.y);
    const r = num(seg.arc.r, r0) || r0;
    const sweep = arcSweep(c, seg.from, seg.to, cw);
    if (sweep <= 0 || r <= EPS) return [c3(seg.from), c3(seg.to)];
    const t = Math.max(tol, 1e-4);
    const step = r > t ? 2 * Math.acos(1 - t / r) : Math.PI / 2;
    const n = Math.max(1, Math.ceil(sweep / step));
    const a0 = Math.atan2(seg.from.y - c.y, seg.from.x - c.x);
    const dir = cw ? -1 : 1;
    const pts = [c3(seg.from)];
    for (let i = 1; i < n; i++) {
      const f = i / n;
      const a = a0 + dir * sweep * f;
      const rr = r0 + (r1 - r0) * f; // 起終點半徑略有差異時線性過渡
      pts.push(v3(c.x + rr * Math.cos(a), c.y + rr * Math.sin(a), seg.from.z + (seg.to.z - seg.from.z) * f));
    }
    pts.push(c3(seg.to));
    return pts;
  }

  // ---------------------------------------------------------------------------
  // 固定循環展開
  // ---------------------------------------------------------------------------
  /**
   * 把 hole 動作展開成段（不含 id/line/opIndex/tool；由 buildSegments 補上）。
   * @param {Action} action  hole 動作（x, y, r, z, q, p, cycle, retract, initialZ, feed?）
   * @param {{pos?:Vec3, feed?:number|null}} [ctx]  目前位置（無 action.from 時使用）、目前 F
   * @returns {Segment[]}  最後一段的 to 即孔完成後的位置
   */
  function expandHole(action, ctx) {
    ctx = ctx || {};
    const cyc = (action.cycle && typeof action.cycle === 'object') ? action.cycle : null;
    const code = cyc ? cyc.code : action.cycle;
    const x = num(action.x, null);
    const y = num(action.y, null);
    const r = num(action.r, cyc ? num(cyc.r, null) : null);
    const z = num(action.z, action.to ? num(action.to.z, null) : (cyc ? num(cyc.z, null) : null));
    const q = num(action.q, cyc ? num(cyc.q, null) : null);
    const retract = action.retract || (cyc && cyc.retract) || 'G98';
    const feed = num(action.feed, num(ctx.feed, null));
    const start = action.from ? c3(action.from) : (ctx.pos ? c3(ctx.pos) : v3(x, y, num(action.initialZ, 0)));
    const initialZ = num(action.initialZ, cyc ? num(cyc.initialZ, start.z) : start.z);
    const segs = [];
    if (x == null || y == null) return segs;

    let cur = start;
    const push = (kind, to, sub, f) => {
      if (U.eq3(cur, to)) return;
      const s = { kind, from: c3(cur), to: c3(to), feed: kind === 'rapid' ? null : f, path: 'programmed' };
      if (sub) s.sub = sub;
      segs.push(s);
      cur = c3(to);
    };
    // 1. 以目前 Z 定位到孔位（前一孔 G99 時就是在 R 點高度移動）
    push('rapid', v3(x, y, cur.z));
    if (r == null || z == null) return segs; // 資料不足（interpreter 已報 R18）
    // 2. 快速到 R 點
    push('rapid', v3(x, y, r));
    const at = (zz) => v3(x, y, zz);
    switch (code) {
      case 'G83': {
        if (q == null || q <= 0) { push('drill', at(z), 'plunge', feed); push('rapid', at(r), 'retract'); break; }
        let depth = r;
        let guard = 0;
        while (depth > z + EPS && guard++ < 100000) {
          let next = Math.max(z, depth - q);
          // q 在二進位下不精確，累減之後永遠差 4e-14 到不了孔底；夾一下，
          // 免得 bounds.min.z 與任何用 === 或門檻比較的下游規則踩到。
          if (next - z < 1e-9) next = z;
          push('drill', at(next), 'peck', feed);
          push('rapid', at(r), 'retract');
          if (next > z + EPS) push('rapid', at(Math.min(r, next + PECK_CLEARANCE)), 'retract');
          depth = next;
        }
        break;
      }
      case 'G73': {
        if (q == null || q <= 0) { push('drill', at(z), 'plunge', feed); push('rapid', at(r), 'retract'); break; }
        let depth = r;
        let guard = 0;
        while (depth > z + EPS && guard++ < 100000) {
          let next = Math.max(z, depth - q);
          if (next - z < 1e-9) next = z;
          push('drill', at(next), 'peck', feed);
          if (next > z + EPS) push('rapid', at(Math.min(r, next + G73_RETRACT)), 'retract');
          depth = next;
        }
        push('rapid', at(r), 'retract');
        break;
      }
      case 'G84':
      case 'G74':
        push('drill', at(z), 'plunge', feed);
        push('drill', at(r), 'tapUp', feed);
        break;
      case 'G85':
      case 'G89':
        push('drill', at(z), 'plunge', feed);
        push('drill', at(r), 'retract', feed);
        break;
      case 'G87': {
        // 背搪孔：主軸定向停 → 偏移 → 快速下到孔底 → 主軸轉 → 進給「往上」搪 → 停 → 偏移退出。
        // 方向和 G81 完全相反，畫成往下扎刀的話模擬會把孔上方的材料整條吃掉。
        // （主軸定向與 Q 偏移量本工具不模擬，interpreter 已發 R18 warning 說明。）
        push('rapid', at(z), 'retract');
        push('drill', at(Math.max(r, initialZ)), 'boreUp', feed);
        break;
      }
      default: // G81 G82 G76 G86 G88：進給到孔底、快速回 R
        push('drill', at(z), 'plunge', feed);
        push('rapid', at(r), 'retract');
        break;
    }
    if (retract === 'G98') push('rapid', at(initialZ), 'retract');
    return segs;
  }

  // ---------------------------------------------------------------------------
  // 第一階段：Action → programmed 段（items 帶內部中繼資料）
  // ---------------------------------------------------------------------------
  function toolFor(run, blk) {
    const op = run.ops && blk.opIndex >= 0 ? run.ops[blk.opIndex] : null;
    if (op && op.tool != null) return op.tool;
    const st = blk.after || blk.before;
    return st && st.toolInSpindle != null ? st.toolInSpindle : null;
  }

  function isPlaneMove(seg) {
    if (!seg) return false;
    if (seg.arc) return true;
    return Math.hypot(seg.to.x - seg.from.x, seg.to.y - seg.from.y) > EPS;
  }

  /**
   * 把動作的第四軸角度標到段上。
   * 注意：這裡**不做**工件旋轉的座標轉換——段的 XYZ 一律是程式座標。
   * `a` 只是「畫這一段時 A 轉到幾度」，供畫面分面顯示與 R37 檢查用（CONTRACT §13）。
   */
  function tagRot(seg, act, withFrom) {
    if (!seg || !act || act.a === undefined) return seg;
    seg.a = act.a;
    // aFrom 代表「這一段期間 A 在轉」。一個動作展開成多段時（固定循環、G28），
    // 轉動只發生在最前面的定位段——Fanuc 是先定位到位（含旋轉）再鑽。
    // 每一段都掛 aFrom 的話，鑽孔段會被當成「邊轉邊鑽」，展開圖上整組孔會差一格角度。
    if (act.aFrom !== undefined && withFrom !== false) seg.aFrom = act.aFrom;
    return seg;
  }

  function makeItem(blk, seg, act, extra) {
    return Object.assign({ blk, seg, act, plane: isPlaneMove(seg), marker: false, flush: false, idx: -1 }, extra || {});
  }

  function collectItems(run, settings, diags) {
    const items = [];
    let cur = c3(settings.refPosition || { x: 0, y: 0, z: 0 });
    for (const blk of run.executed || []) {
      if (blk.skipped || blk.ignored) continue;
      const base = { line: blk.line, opIndex: blk.opIndex, tool: toolFor(run, blk) };
      const acts = blk.actions || [];
      let n = 0;
      for (const act of acts) {
        switch (act.kind) {
          case 'rapid':
          case 'linear':
          case 'arc': {
            const from = act.from ? c3(act.from) : c3(cur);
            const to = act.to ? c3(act.to) : c3(from);
            const seg = Object.assign({}, base, {
              kind: act.kind === 'rapid' ? 'rapid' : (act.kind === 'arc' ? 'arc' : 'feed'),
              from, to, feed: act.kind === 'rapid' ? null : num(act.feed, null), path: 'programmed',
            });
            if (act.nonLinear) seg.nonLinear = true;
            if (act.kind === 'arc') {
              let center = act.center ? v2(act.center.x, act.center.y) : null;
              if (!center && act.r != null) { const c = arcFromR(from, to, act.r, !!act.cw); center = c ? c.center : null; }
              if (center) {
                seg.arc = { center, cw: !!act.cw, r: num(act.r != null ? Math.abs(act.r) : null, Math.hypot(from.x - center.x, from.y - center.y)) };
              } else {
                seg.kind = 'feed'; // 圓心不明 → 退化直線
              }
            }
            tagRot(seg, act);
            items.push(makeItem(blk, seg, act, { corner: act.corner || null, compStart: !!act.compStart, compEnd: !!act.compEnd }));
            cur = c3(to);
            n++;
            break;
          }
          case 'refReturn': {
            const from = act.from ? c3(act.from) : c3(cur);
            const via = act.via ? c3(act.via) : c3(from);
            const to = act.to ? c3(act.to) : c3(via);
            const s1 = Object.assign({}, base, { kind: 'rapid', from, to: via, feed: null, path: 'programmed', refReturn: true });
            const s2 = Object.assign({}, base, { kind: 'rapid', from: c3(via), to, feed: null, path: 'programmed', refReturn: true });
            items.push(makeItem(blk, tagRot(s1, act, true), act, { flush: true }));
            items.push(makeItem(blk, tagRot(s2, act, false), act, { flush: true }));
            cur = c3(to);
            n += 2;
            break;
          }
          case 'hole': {
            const st = blk.after || blk.before || {};
            const segs = expandHole(act, { pos: cur, feed: st.feed });
            for (let si = 0; si < segs.length; si++) {
              const s = segs[si];
              Object.assign(s, base);
              tagRot(s, act, si === 0);   // 只有第一段（定位到孔上方）才是轉動中
              items.push(makeItem(blk, s, act, { flush: true }));
              n++;
            }
            if (segs.length) cur = c3(segs[segs.length - 1].to);
            else if (act.x != null && act.y != null) cur = v3(act.x, act.y, cur.z);
            break;
          }
          case 'toolchange':
          case 'stop':
            items.push(makeItem(blk, null, act, { marker: true, flush: act.kind === 'toolchange' || act.code === 'M30' || act.code === 'M2' }));
            n++;
            break;
          default:
            break;
        }
      }
      if (n === 0) items.push(makeItem(blk, null, null, { marker: true }));
    }
    return items;
  }

  // ---------------------------------------------------------------------------
  // 第二階段：,C / ,R 展開
  // ---------------------------------------------------------------------------
  function nextMotionIndex(items, i) {
    for (let j = i + 1; j < items.length; j++) {
      const it = items[j];
      if (it.marker) { if (it.flush) return -1; continue; }
      if (it.flush) return -1;
      if (it.seg) return j;
    }
    return -1;
  }

  function expandCorners(items, diags) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.corner || !it.seg) continue;
      const line = it.seg.line;
      const c = num(it.corner.c, null);
      const rr = num(it.corner.r, null);
      if ((c == null || c <= 0) && (rr == null || rr <= 0)) continue;
      const label = c != null ? `,C${U.fmt(c)}` : `,R${U.fmt(rr)}`;
      if (it.compStart || it.compEnd) {
        diags.push(U.diag('R22', line, 'error', `${label} 不能寫在刀徑補正啟動／取消節上`, { fanucAlarm: 'PS0039', detail: '機台會發 PS0039 報警。把倒角／圓角移到補正生效中的節，或另外寫一節。' }));
        continue;
      }
      const j = nextMotionIndex(items, i);
      if (j < 0) {
        diags.push(U.diag('R22', line, 'error', `${label} 後面沒有下一個移動節，無法插入倒角／圓角`, { fanucAlarm: 'PS0051', detail: '選擇性倒角／圓角需要下一節是 G01 直線移動。' }));
        continue;
      }
      const nx = items[j];
      const A = it.seg, B = nx.seg;
      if (A.arc || B.arc) {
        diags.push(U.diag('R22', line, 'warning', `${label} 相鄰節含圓弧，本版未展開（路徑照程式原樣顯示）`, { detail: 'Fanuc 允許圓弧接倒角／圓角，但本工具只支援直線對直線。' }));
        continue;
      }
      if (A.kind === 'rapid' || B.kind === 'rapid') {
        diags.push(U.diag('R22', line, 'error', `${label} 的本節或下一節是 G00，不是 G01`, { fanucAlarm: 'PS0052', detail: '倒角／圓角只能插在兩個 G01 之間。' }));
        continue;
      }
      if (Math.abs(A.to.z - A.from.z) > EPS || Math.abs(B.to.z - B.from.z) > EPS) {
        diags.push(U.diag('R22', line, 'warning', `${label} 相鄰節含 Z 軸移動（非 G17 平面內），未展開`, { fanucAlarm: 'PS0054', detail: '倒角／圓角兩側的移動都必須在選定平面內。' }));
        continue;
      }
      const dA = norm2(sub2(xy(A.to), xy(A.from)));
      const dB = norm2(sub2(xy(B.to), xy(B.from)));
      const lenA = U.dist2(A.from, A.to);
      const lenB = U.dist2(B.from, B.to);
      if (lenA < EPS || lenB < EPS) {
        diags.push(U.diag('R22', line, 'error', `${label} 相鄰節在平面內沒有移動量`, { fanucAlarm: 'PS0055' }));
        continue;
      }
      const cr = cross2(dA, dB);
      const dt = dot2(dA, dB);
      if (Math.abs(cr) < 1e-6 && dt > 0) {
        diags.push(U.diag('R22', line, 'info', `${label} 前後兩節共線，倒角／圓角沒有作用`, {}));
        continue;
      }
      if (Math.abs(cr) < 1e-6 && dt < 0) {
        diags.push(U.diag('R22', line, 'warning', `${label} 前後兩節方向相反（180°），無法插入倒角／圓角`, {}));
        continue;
      }
      const P = xy(A.to);
      const z = A.to.z;
      let t, inserted;
      if (c != null) {
        t = c;
        const pa = sub2(P, mul2(dA, t));
        const pb = add2(P, mul2(dB, t));
        inserted = Object.assign({}, A, { from: v3(pa.x, pa.y, z), to: v3(pb.x, pb.y, z), kind: 'feed', inserted: true });
        delete inserted.arc;
      } else {
        const turn = Math.atan2(Math.abs(cr), dt); // 轉向角 (0, π)
        t = rr * Math.tan(turn / 2);            // 切線長
        const pa = sub2(P, mul2(dA, t));
        const pb = add2(P, mul2(dB, t));
        const ccw = cr > 0;
        const nrm = ccw ? left2(dA) : right2(dA);
        const center = add2(pa, mul2(nrm, rr));
        inserted = Object.assign({}, A, { from: v3(pa.x, pa.y, z), to: v3(pb.x, pb.y, z), kind: 'arc', inserted: true, arc: { center, cw: !ccw, r: rr } });
      }
      const kindLabel = c != null ? '倒角' : '圓角';
      const need = U.fmt(t);
      if (lenA < t - EPS || lenB < t - EPS) {
        diags.push(U.diag('R22', line, 'error', `${label} ${kindLabel}需要兩側各 ${need} mm，但本節 ${U.fmt(lenA)} mm、下一節 ${U.fmt(lenB)} mm 不夠`, { fanucAlarm: 'PS0055', detail: '機台會發 PS0055（移動量不足）。縮小倒角量或加長相鄰移動。' }));
        continue;
      }
      if (lenA < t + EPS || lenB < t + EPS) {
        // Fanuc 只有在移動量「小於」倒角量時才發 PS0055；剛好等於是合法的，
        // 而且是 CAM 常見的刻意寫法（下一節縮成零長度、正好接到 G40）。
        // 判成 warning 的話，這種一支程式出現好幾次的正常寫法會排在清單很前面，
        // 現場學會忽略黃字之後，真正該看的就被埋掉了。
        diags.push(U.diag('R22', line, 'info', `${label} ${kindLabel}剛好用掉整節移動量（需要 ${need} mm，本節 ${U.fmt(lenA)} mm、下一節 ${U.fmt(lenB)} mm）`, { detail: '本節或下一節會變成零長度。這是常見的寫法，Fanuc 不會報警（PS0055 只在移動量「小於」倒角量時才發）；列出來只是讓你確認這是本意。' }));
      }
      // 本節縮短、插入、下一節起點後移
      A.to = c3(inserted.from);
      B.from = c3(inserted.to);
      const ins = makeItem(it.blk, inserted, it.act, { corner: null, compStart: false, compEnd: false });
      items.splice(i + 1, 0, ins);
      i++; // 跳過剛插入的段
    }
  }

  // ---------------------------------------------------------------------------
  // 第三階段：刀徑補正
  // ---------------------------------------------------------------------------
  /** 本地 fallback：offsets 有 n=d 且 radGeom+radWear≠0 → 用它；否則 tool.diameter/2；皆無 → null。 */
  function localEffectiveRadius(toolTable, t, d) {
    if (!toolTable) return null;
    const offs = toolTable.offsets || [];
    if (d) {
      const o = offs.find((e) => e && e.n === d);
      if (o) { const v = num(o.radGeom, 0) + num(o.radWear, 0); if (v !== 0) return v; }
    }
    const tools = toolTable.tools || [];
    const tool = (t && typeof t === 'object') ? t : tools.find((e) => e && e.t === t);
    if (tool && num(tool.diameter, 0) > 0) return tool.diameter / 2;
    return null;
  }

  function effectiveRadius(toolTable, t, d) {
    if (NC.tools && typeof NC.tools.effectiveRadius === 'function') {
      let v = null;
      try { v = NC.tools.effectiveRadius(toolTable, t, d); } catch (e) { v = null; }
      if (typeof v === 'number' && Number.isFinite(v) && v !== 0) return v;
      // tools.js 回傳 null/0 是「這把刀沒有可信的補正量」的明確答案（例如倒角刀未輸入 D 值），
      // 不可再用 diameter/2 猜一個值，否則會產生大量假的 PS0041 干涉警報。
      return null;
    }
    return localEffectiveRadius(toolTable, t, d);
  }

  /** 程式段在起點／終點的單位切線（XY）。 */
  function tangentStart(seg) {
    if (seg.arc) { const u = norm2(sub2(xy(seg.from), seg.arc.center)); return seg.arc.cw ? right2(u) : left2(u); }
    return norm2(sub2(xy(seg.to), xy(seg.from)));
  }
  function tangentEnd(seg) {
    if (seg.arc) { const u = norm2(sub2(xy(seg.to), seg.arc.center)); return seg.arc.cw ? right2(u) : left2(u); }
    return norm2(sub2(xy(seg.to), xy(seg.from)));
  }

  /** 偏移曲線：{type:'line', a, b} 或 {type:'arc', c, r, cw, a, b}；a→b。 */
  function curveLen(cv) {
    if (cv.type === 'line') return len2(sub2(cv.b, cv.a));
    return cv.r * arcSweep(cv.c, cv.a, cv.b, cv.cw);
  }
  /** 點在曲線上的參數（沿曲線的距離）；不在曲線範圍內回傳 null。 */
  function curveParam(cv, p, tol) {
    if (cv.type === 'line') {
      const d = norm2(sub2(cv.b, cv.a));
      const L = curveLen(cv);
      const t = dot2(sub2(p, cv.a), d);
      if (t < -tol || t > L + tol) return null;
      return U.clamp(t, 0, L);
    }
    const sweep = arcSweep(cv.c, cv.a, cv.b, cv.cw);
    let ang = arcAngleOf(cv, p);
    const tolAng = ANG_EPS + tol / Math.max(cv.r, 1e-9);
    if (ang > sweep + tolAng) { if (ang >= TAU - tolAng) ang = 0; else return null; }
    return U.clamp(ang, 0, sweep) * cv.r;
  }
  function curvePointAt(cv, s) {
    if (cv.type === 'line') { const d = norm2(sub2(cv.b, cv.a)); return add2(cv.a, mul2(d, s)); }
    const a0 = Math.atan2(cv.a.y - cv.c.y, cv.a.x - cv.c.x);
    const a = a0 + (cv.cw ? -1 : 1) * (s / cv.r);
    return v2(cv.c.x + cv.r * Math.cos(a), cv.c.y + cv.r * Math.sin(a));
  }

  function lineCircleT(a, d, c, R) {
    const f = sub2(a, c);
    const b = dot2(f, d);
    const cc = dot2(f, f) - R * R;
    const disc = b * b - cc;
    if (disc < 0) return [];
    const s = Math.sqrt(disc);
    return s < 1e-12 ? [-b] : [-b - s, -b + s];
  }
  function circleCircle(c1, r1, c2, r2) {
    const dv = sub2(c2, c1);
    const d = len2(dv);
    if (d < 1e-9) return [];
    if (d > r1 + r2 + 1e-6 || d < Math.abs(r1 - r2) - 1e-6) return [];
    const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
    const u = mul2(dv, 1 / d);
    const p = add2(c1, mul2(u, a));
    const n = left2(u);
    return h < 1e-12 ? [p] : [add2(p, mul2(n, h)), sub2(p, mul2(n, h))];
  }
  /** 兩偏移曲線的候選交點。 */
  function curveIntersections(c1, c2) {
    if (c1.type === 'line' && c2.type === 'line') {
      const d1 = norm2(sub2(c1.b, c1.a)), d2 = norm2(sub2(c2.b, c2.a));
      const den = cross2(d1, d2);
      if (Math.abs(den) < 1e-12) return [];
      const w = sub2(c2.a, c1.a);
      const t = cross2(w, d2) / den;
      return [add2(c1.a, mul2(d1, t))];
    }
    if (c1.type === 'line' && c2.type === 'arc') {
      const d = norm2(sub2(c1.b, c1.a));
      return lineCircleT(c1.a, d, c2.c, c2.r).map((t) => add2(c1.a, mul2(d, t)));
    }
    if (c1.type === 'arc' && c2.type === 'line') {
      const d = norm2(sub2(c2.b, c2.a));
      return lineCircleT(c2.a, d, c1.c, c1.r).map((t) => add2(c2.a, mul2(d, t)));
    }
    return circleCircle(c1.c, c1.r, c2.c, c2.r);
  }

  /** 偏移段 → Segment（compensated）。 */
  function curveToSegment(cv, seg, extra) {
    const out = {
      line: seg.line, opIndex: seg.opIndex, tool: seg.tool,
      kind: seg.kind, from: v3(cv.a.x, cv.a.y, cv.z0), to: v3(cv.b.x, cv.b.y, cv.z1),
      feed: seg.feed, path: 'compensated',
    };
    if (cv.type === 'arc') { out.arc = { center: v2(cv.c.x, cv.c.y), cw: cv.cw, r: cv.r }; if (out.kind === 'feed') out.kind = 'arc'; }
    else if (out.kind === 'arc') out.kind = 'feed';
    if (seg.nonLinear) out.nonLinear = true;
    if (seg.inserted) out.inserted = true;
    if (seg.sub) out.sub = seg.sub;
    return Object.assign(out, extra || {});
  }

  function countsAsBlock(blk) {
    if (!blk) return false;
    if (blk.actions && blk.actions.length) return true;
    const a = blk.before, b = blk.after;
    if (!a || !b) return false;
    if (a.feed !== b.feed || a.d !== b.d || a.h !== b.h || a.comp !== b.comp || a.motion !== b.motion || a.distance !== b.distance) return true;
    if ((a.spindle && a.spindle.rpm) !== (b.spindle && b.spindle.rpm)) return true;
    return false;
  }

  function applyCompensation(items, run, toolTable, settings, diags) {
    const out = new Map(); // item idx → compensated segs
    const push = (idx, seg) => { if (!out.has(idx)) out.set(idx, []); out.get(idx).push(seg); };
    const lookahead = num(settings.lookahead, 3);
    const needsInputKeys = new Set();

    const st = {
      active: false, side: 'G41', r: 0, d: 0, tool: null, opIndex: -1,
      startPending: false, cancelPending: false,
      pending: null,    // 尚未定案的偏移段（等下一個平面移動決定轉角）
      deferred: [],     // pending 之後、下一個平面移動之前的非平面移動（Z 軸）
      noPlane: 0, warned12: false,
    };
    const reset = () => { st.active = false; st.startPending = false; st.cancelPending = false; st.pending = null; st.deferred = []; st.noPlane = 0; st.warned12 = false; };

    const resolveRadius = (blk, line) => {
      const d = num(blk.after && blk.after.d, 0);
      st.d = d;
      const r = effectiveRadius(toolTable, st.tool, d);
      if (r == null || !(Math.abs(r) > 0)) {
        st.r = 0;
        const key = `${st.opIndex}:${d}`;
        if (!needsInputKeys.has(key)) {
          needsInputKeys.add(key);
          diags.push(U.diag('R10', line, 'needsInput', `需輸入 D 值：T${st.tool == null ? '?' : st.tool} 的 D${d} 沒有半徑資料，刀徑補正暫以 0 計算`, { detail: '請在刀具表填入刀具直徑或 D 補正值，補正後路徑才會正確。' }));
        }
      } else {
        st.r = Math.abs(r);
      }
    };

    const finalizePending = () => {
      if (!st.pending) return;
      const p = st.pending;
      push(p.idx, curveToSegment(p, p.seg));
      for (const ins of p.inserts || []) push(p.idx, ins);
      st.pending = null;
    };
    const emitDeferred = (at) => {
      for (const d of st.deferred) {
        const s = d.seg;
        push(d.idx, {
          line: s.line, opIndex: s.opIndex, tool: s.tool, kind: s.kind === 'arc' ? 'feed' : s.kind,
          from: v3(at.x, at.y, s.from.z), to: v3(at.x, at.y, s.to.z), feed: s.feed, path: 'compensated',
        });
      }
      st.deferred = [];
    };
    const pendingEnd = () => st.pending ? v2(st.pending.b.x, st.pending.b.y) : null;

    const flush = () => {
      if (st.pending) { const end = pendingEnd(); finalizePending(); emitDeferred(end); }
      st.deferred = [];
      st.startPending = st.active; // 補正仍為模態時，下一個平面移動視為重新啟動
      st.pending = null;
      st.noPlane = 0; st.warned12 = false;
    };

    const nextPlaneDir = (i) => {
      for (let j = i + 1; j < items.length; j++) {
        const it = items[j];
        if (it.flush) return null;
        if (it.marker || !it.seg) continue;
        if (it.plane) return tangentStart(it.seg);
      }
      return null;
    };

    const offsetCurve = (seg, line) => {
      const r = st.r;
      const sgn = st.side === 'G41' ? 1 : -1;
      if (!seg.arc) {
        const d = norm2(sub2(xy(seg.to), xy(seg.from)));
        const n = mul2(sgn > 0 ? left2(d) : right2(d), r);
        return { type: 'line', a: add2(xy(seg.from), n), b: add2(xy(seg.to), n), z0: seg.from.z, z1: seg.to.z, seg, degenerate: false };
      }
      const c = seg.arc.center;
      const R = num(seg.arc.r, Math.hypot(seg.from.x - c.x, seg.from.y - c.y));
      const inward = (sgn > 0) !== !!seg.arc.cw; // G41+G3 或 G42+G2：刀在弧內側
      let R2 = inward ? R - r : R + r;
      let degenerate = false;
      if (inward && R2 <= EPS) {
        // 半徑剛好等於刀具半徑（例：4MM 刀銑 R2 內角）在 Fanuc 上可以跑，補正後縮成一點；小於才是過切。
        if (R2 < -EPS) {
          diags.push(U.diag('R11', line, 'error', `內凹圓弧半徑 R${U.fmt(R)} 小於刀徑補正量 r=${U.fmt(r)}，刀具會過切`, { fanucAlarm: 'PS0041', detail: '刀具半徑必須小於等於內凹圓弧半徑。換小刀或改程式半徑。', pos: v3(seg.from.x, seg.from.y, seg.from.z) }));
        }
        degenerate = true;
        R2 = 0;
      }
      const ra = Math.hypot(seg.from.x - c.x, seg.from.y - c.y) || R;
      const rb = Math.hypot(seg.to.x - c.x, seg.to.y - c.y) || R;
      const a = add2(c, mul2(sub2(xy(seg.from), c), R2 / ra));
      const b = add2(c, mul2(sub2(xy(seg.to), c), R2 / rb));
      if (degenerate) return { type: 'line', a, b, z0: seg.from.z, z1: seg.to.z, seg, degenerate: true };
      return { type: 'arc', c: v2(c.x, c.y), r: R2, cw: !!seg.arc.cw, a, b, z0: seg.from.z, z1: seg.to.z, seg, degenerate: false };
    };

    /** 處理 O1（pending）與 O2 的接合：截斷／插弧／連接線。 */
    const junction = (O1, O2, it2) => {
      O1.inserts = O1.inserts || [];
      const s1 = O1.seg, s2 = it2.seg;
      const P = xy(s1.to);
      const joinLine = () => {
        if (len2(sub2(O2.a, O1.b)) <= EPS) return;
        const kind = s1.kind === 'rapid' ? 'rapid' : 'feed';
        O1.inserts.push({ line: s1.line, opIndex: s1.opIndex, tool: s1.tool, kind, from: v3(O1.b.x, O1.b.y, s1.to.z), to: v3(O2.a.x, O2.a.y, s2.from.z), feed: kind === 'rapid' ? null : s1.feed, path: 'compensated', inserted: true });
      };
      if (O1.isStart || O1.degenerate || O2.degenerate || st.r <= EPS) { joinLine(); return; }
      const t1 = tangentEnd(s1), t2 = tangentStart(s2);
      const cr = cross2(t1, t2), dt = dot2(t1, t2);
      const sgn = st.side === 'G41' ? 1 : -1;
      // 相切／共線。門檻 2e-3 rad（0.11°）：CAM 產出的圓弧接直線，座標取到小數三位後接點會留下
      // 1e-4 rad 等級的折角（R2 弧的 I/J 差 0.0005 就是 2.5e-4 rad），用 1e-6 會把它們全判成內角、
      // 交點又落在容差外 → 一整排假的 PS0041。0.11° 的折角當成相切，過切量 r(1−cosθ) < 1e-4 mm。
      if (Math.abs(cr) < TANGENT_EPS && dt > 0) { joinLine(); return; }
      if (cr * sgn < 0 || (Math.abs(cr) < 1e-6 && dt < 0)) {
        // 外角：以程式轉角為圓心插入半徑 r 的弧
        if (len2(sub2(O2.a, O1.b)) <= EPS) return;
        if (s1.kind === 'rapid') { joinLine(); return; }
        O1.inserts.push({
          line: s1.line, opIndex: s1.opIndex, tool: s1.tool, kind: 'arc',
          from: v3(O1.b.x, O1.b.y, s1.to.z), to: v3(O2.a.x, O2.a.y, s2.from.z),
          arc: { center: v2(P.x, P.y), cw: sgn > 0, r: st.r }, feed: s1.feed, path: 'compensated', inserted: true,
        });
        return;
      }
      // 內角：求交點截斷
      const tol = 1e-4;
      const L1 = curveLen(O1), L2 = curveLen(O2);
      let best = null;
      for (const p of curveIntersections(O1, O2)) {
        const u1 = curveParam(O1, p, tol);
        const u2 = curveParam(O2, p, tol);
        if (u1 == null || u2 == null) continue;
        const score = (L1 - u1) + u2;
        if (!best || score < best.score) best = { p, u1, u2, score };
      }
      if (!best) {
        diags.push(U.diag('R11', s2.line, 'error', `內角找不到補正交點：溝槽或轉角比刀徑（r=${U.fmt(st.r)}）小，刀具會過切`, { fanucAlarm: 'PS0041', detail: '相鄰兩節的偏移路徑沒有交點，Fanuc 會發 PS0041 干涉報警。換小刀或修改程式。', pos: v3(P.x, P.y, s1.to.z) }));
        joinLine();
        return;
      }
      O1.b = best.p;
      O2.a = best.p;
      if (L1 - best.u1 > L1 + tol || best.u2 > L2 + tol) joinLine();
    };

    const enterBlock = (blk) => {
      const bc = blk.before ? blk.before.comp : 'G40';
      const ac = blk.after ? blk.after.comp : bc;
      const acts = blk.actions || [];
      const hasStart = acts.some((a) => a.compStart);
      const hasEnd = acts.some((a) => a.compEnd);
      if (!st.active) {
        if (hasStart || (isOn(ac) && !isOn(bc))) {
          st.active = true; st.startPending = true; st.cancelPending = false;
          st.side = isOn(ac) ? ac : 'G41';
          st.pending = null; st.deferred = []; st.noPlane = 0; st.warned12 = false;
          st.tool = toolFor(run, blk); st.opIndex = blk.opIndex;
        }
        return;
      }
      if (hasEnd || !isOn(ac)) { st.cancelPending = true; return; }
      if (ac !== st.side) { // G41 ↔ G42 直接切換：上一段照舊結束、本節視為新啟動
        flush();
        st.side = ac; st.startPending = true;
      }
      if (blk.after && blk.after.d !== st.d && st.pending) resolveRadius(blk, blk.line);
    };

    let lastBlk = null;
    let planeInBlock = false;
    const leaveBlock = (blk) => {
      if (st.active && st.pending && !planeInBlock && countsAsBlock(blk)) {
        st.noPlane++;
        if (st.noPlane > lookahead - 2 && !st.warned12) {
          st.warned12 = true;
          diags.push(U.diag('R12', blk.line, 'warning', `刀徑補正中連續 ${st.noPlane} 節沒有平面（XY）移動，超過先讀節數 ${lookahead} 可處理的範圍`, { detail: '控制器看不到下一個 XY 移動，轉角向量算不出來，可能過切或少切。把 Z 移動與 M 碼合併或減少連續節數。' }));
        }
      }
    };

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      it.idx = i;
      if (it.blk !== lastBlk) {
        if (lastBlk) leaveBlock(lastBlk);
        planeInBlock = false;
        enterBlock(it.blk);
        lastBlk = it.blk;
      }
      if (it.marker) { if (it.flush && st.active) { flush(); reset(); } continue; }
      if (!st.active) continue;
      const seg = it.seg;
      if (it.flush) { // hole / refReturn：補正在這裡中斷
        flush();
        if (it.act && it.act.kind === 'refReturn') reset();
        continue;
      }
      if (st.cancelPending) {
        const end = pendingEnd();
        const from = end ? v3(end.x, end.y, seg.from.z) : c3(seg.from);
        finalizePending();
        if (end) emitDeferred(end);
        const cs = { line: seg.line, opIndex: seg.opIndex, tool: seg.tool, kind: seg.kind === 'arc' ? 'feed' : seg.kind, from, to: c3(seg.to), feed: seg.feed, path: 'compensated' };
        if (seg.nonLinear) cs.nonLinear = true;
        push(i, cs);
        reset();
        continue;
      }
      if (!seg || !it.plane) {
        if (st.pending) st.deferred.push(it);
        continue;
      }
      planeInBlock = true;
      st.noPlane = 0; st.warned12 = false;
      if (st.startPending) {
        st.startPending = false;
        resolveRadius(it.blk, seg.line);
        const dir = nextPlaneDir(i) || tangentStart(seg);
        const n = mul2(st.side === 'G41' ? left2(dir) : right2(dir), st.r);
        const endXY = add2(xy(seg.to), n);
        const progLen = U.dist2(seg.from, seg.to);
        const netLen = len2(sub2(endXY, xy(seg.from)));
        if (progLen < st.r - EPS) {
          diags.push(U.diag('R10', seg.line, 'warning', `刀徑補正啟動節移動量 ${U.fmt(progLen)} mm 小於補正量 r=${U.fmt(st.r)} mm（補正後實際移動 ${U.fmt(netLen)} mm）`, { detail: '啟動節太短時刀具會斜切進工件。讓啟動節在工件外且長度 ≥ 刀具半徑。' }));
        }
        st.pending = { type: 'line', a: xy(seg.from), b: endXY, z0: seg.from.z, z1: seg.to.z, seg, idx: i, isStart: true, inserts: [] };
        continue;
      }
      const O2 = offsetCurve(seg, seg.line);
      O2.idx = i; O2.inserts = [];
      if (st.pending) {
        junction(st.pending, O2, it);
        finalizePending();
        emitDeferred(O2.a);
      }
      st.pending = O2;
    }
    if (lastBlk) leaveBlock(lastBlk);
    if (st.active) flush();
    return out;
  }

  // ---------------------------------------------------------------------------
  // bounds
  // ---------------------------------------------------------------------------
  function extendBounds(b, seg) {
    const acc = (p) => {
      if (p.x < b.min.x) b.min.x = p.x; if (p.y < b.min.y) b.min.y = p.y; if (p.z < b.min.z) b.min.z = p.z;
      if (p.x > b.max.x) b.max.x = p.x; if (p.y > b.max.y) b.max.y = p.y; if (p.z > b.max.z) b.max.z = p.z;
    };
    acc(seg.from); acc(seg.to);
    if (seg.arc) {
      const c = seg.arc.center;
      const r = num(seg.arc.r, Math.hypot(seg.from.x - c.x, seg.from.y - c.y));
      const sweep = arcSweep(c, seg.from, seg.to, seg.arc.cw);
      const a0 = Math.atan2(seg.from.y - c.y, seg.from.x - c.x);
      const dir = seg.arc.cw ? -1 : 1;
      const zmin = Math.min(seg.from.z, seg.to.z), zmax = Math.max(seg.from.z, seg.to.z);
      for (let k = 0; k < 4; k++) {
        const a = k * Math.PI / 2; // 0°, 90°, 180°, 270°
        const rel = normAngle(dir * (a - a0));
        if (rel <= sweep + ANG_EPS) {
          const p = v2(c.x + r * Math.cos(a), c.y + r * Math.sin(a));
          acc(v3(p.x, p.y, zmin)); acc(v3(p.x, p.y, zmax));
        }
      }
    }
  }

  function computeBounds(segments) {
    const mk = () => ({ min: v3(Infinity, Infinity, Infinity), max: v3(-Infinity, -Infinity, -Infinity) });
    let b = mk();
    let n = 0;
    for (const s of segments) { if (s.kind === 'rapid') continue; extendBounds(b, s); n++; }
    if (n === 0) { b = mk(); for (const s of segments) { extendBounds(b, s); n++; } }
    if (n === 0) return { min: v3(0, 0, 0), max: v3(0, 0, 0) };
    return b;
  }

  // ---------------------------------------------------------------------------
  // 主函式
  // ---------------------------------------------------------------------------
  /**
   * @param {Run} run
   * @param {ToolTable|null} toolTable
   * @param {MachineSettings} [settings]
   * @returns {GeometryResult}
   */
  function buildSegments(run, toolTable, settings) {
    settings = Object.assign(U.defaultSettings(), settings || {});
    const diagnostics = [];
    const items = collectItems(run || { executed: [], ops: [] }, settings, diagnostics);
    expandCorners(items, diagnostics);
    const comp = applyCompensation(items, run || { ops: [] }, toolTable, settings, diagnostics);
    const segments = [];
    // 補正階段會產生一些三軸位移都是 0 的段（內凹圓弧半徑剛好等於刀徑補正量而退化、
    // 或 ,C 把下一節吃光）。幾何上沒有錯，但它們會拿到 id、進入段數統計、
    // 讓 view2d 的 hover/pick 多出點不到的段，所以在收尾時濾掉
    //（跟 expandHole 的 push() 已有的 U.eq3 檢查一致）。
    const isDegenerate = (s) => s.path === 'compensated' && !s.arc
      && Math.abs(s.to.x - s.from.x) < 1e-9 && Math.abs(s.to.y - s.from.y) < 1e-9 && Math.abs(s.to.z - s.from.z) < 1e-9;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.seg) segments.push(it.seg);
      const cs = comp.get(i);
      if (cs) for (const s of cs) { if (!isDegenerate(s)) segments.push(s); }
    }
    segments.forEach((s, i) => { s.id = i; });
    return { segments, diagnostics, bounds: computeBounds(segments) };
  }

  // ---------------------------------------------------------------------------
  // 第四軸：把「機台座標的刀尖位置」換算成「工件上被切到的位置」
  //
  // A 繞 X 軸轉，迴轉中心線平行 X 軸、位在 (y = center.y, z = center.z)。
  // 工件轉 +A 度，等價於刀具繞著工件轉 -A 度，所以把刀尖繞中心線反轉 A 度就是答案。
  // 中心預設 (0,0)：四軸的裝夾慣例是 G54 的 Y0/Z0 對到夾頭中心線。
  //
  // 這一段是「分度視圖」與「3D 圓棒」共用的核心。段本身（`Segment.from/to`）**不會**被改動，
  // 那仍然是程式座標；要看工件上的樣子一律走這裡的函式。
  // ---------------------------------------------------------------------------
  const ROT_STEP_DEG = 3;        // A 轉動時的取樣角距（度）
  const DEG2RAD = Math.PI / 180;
  const RAD2DEG = 180 / Math.PI;

  function rotCenter(opts) {
    const c = (opts && opts.center) || {};
    return { y: num(c.y, 0), z: num(c.z, 0) };
  }

  /**
   * 單點：機台座標 → 工件座標（把刀尖繞迴轉中心線反轉 aDeg）。
   * @param {Vec3} p
   * @param {number} aDeg   第四軸角度（度）
   * @param {{y:number,z:number}} [center]
   * @returns {Vec3}
   */
  function rotaryPoint(p, aDeg, center) {
    const cy = center ? num(center.y, 0) : 0;
    const cz = center ? num(center.z, 0) : 0;
    const t = num(aDeg, 0) * DEG2RAD;
    const cs = Math.cos(t), sn = Math.sin(t);
    const dy = p.y - cy, dz = p.z - cz;
    return { x: p.x, y: cy + dy * cs + dz * sn, z: cz - dy * sn + dz * cs };
  }

  /** 沿取樣折線依索引比例內插（圓弧已被 sampleSegment 細分過，線性內插誤差可忽略） */
  function lerpPoly(pts, t) {
    if (pts.length === 1) return pts[0];
    const f = clamp01(t) * (pts.length - 1);
    const i = Math.min(pts.length - 2, Math.floor(f));
    const u = f - i;
    const a = pts[i], b = pts[i + 1];
    return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u };
  }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  /**
   * 一段 → 工件座標的取樣點。
   * A 沒轉時只是把端點（圓弧仍照 sampleSegment 細分）搬過去；
   * A 有轉時路徑在工件上是曲線，依 ROT_STEP_DEG 補足取樣點。
   * @param {Segment} seg
   * @param {{center?:{y:number,z:number}, tol?:number}} [opts]
   * @returns {Vec3[]}  工件座標
   */
  function rotarySamples(seg, opts) {
    const center = rotCenter(opts);
    const tol = (opts && opts.tol > 0) ? opts.tol : 0.05;
    const a1 = num(seg.a, 0);
    const a0 = seg.aFrom !== undefined ? num(seg.aFrom, a1) : a1;
    const pts = sampleSegment(seg, tol);
    if (Math.abs(a1 - a0) < EPS) return pts.map((p) => rotaryPoint(p, a1, center));
    const need = Math.ceil(Math.abs(a1 - a0) / ROT_STEP_DEG) + 1;
    const n = Math.max(pts.length, need);
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 1 : i / (n - 1);
      out.push(rotaryPoint(lerpPoly(pts, t), a0 + (a1 - a0) * t, center));
    }
    return out;
  }

  /**
   * 工件座標點 → 展開圖座標。
   * 圓柱攤平：橫軸 = X（軸向），縱軸 = 繞一圈的角度，r = 離迴轉中心的距離
   * （r 小於工件半徑就是切進去了）。刀在正上方時 theta 剛好等於程式的 A 值。
   * @returns {{x:number, theta:number, r:number}}  theta 為度，從正上方 +Z 量起、往 +Y 為正
   */
  function unrollPoint(pw, center) {
    const cy = center ? num(center.y, 0) : 0;
    const cz = center ? num(center.z, 0) : 0;
    const dy = pw.y - cy, dz = pw.z - cz;
    return { x: pw.x, theta: Math.atan2(dy, dz) * RAD2DEG, r: Math.hypot(dy, dz) };
  }

  /**
   * 一串工件座標點 → 展開座標，並把路徑連續化。兩件事：
   *
   * 1. **跨 ±180**：補 360，否則展開圖上會憑空多一條橫越整圈的假線。
   * 2. **穿過軸心**：θ 在軸心是未定義的，刀從一側鑽穿過去時 `atan2` 會瞬間跳 180 度、
   *    r 從 0 反彈回升——照字面讀就變成「刀沿著圓周掃了半圈」，完全不是那回事。
   *    正確的描述是**角度不變、半徑變號**：r < 0 代表刀尖已經穿到軸心的另一邊。
   *    模擬靠這個號誌才知道要把對面那半也挖掉（貫穿孔）。
   */
  function unrollPath(pw, center) {
    const out = [];
    let prev = null;
    for (const p of pw) {
      const u = unrollPoint(p, center);
      let th = u.theta, r = u.r;
      if (prev != null) {
        let d = th - prev;
        while (d > 180) { th -= 360; d -= 360; }
        while (d < -180) { th += 360; d += 360; }
        // 剛好落在軸心（鑽到 Z = 迴轉中心）：atan2(0,0) 回 0，θ 沒有意義。
        // 照字面收下的話，展開座標上會從原本的角度瞬間跳到 0，模擬就把它讀成
        // 「刀軸掃過去一大段」，沿路挖掉一整片扇形。沿用前一點的角度才對。
        if (r < 1e-9) th = prev;
        else if (Math.abs(d) >= 90) { th = prev; r = -r; }   // 穿過軸心
      }
      prev = th;
      out.push({ x: u.x, theta: th, r });
    }
    return out;
  }

  /**
   * 全部段 → 展開圖折線。
   * @param {Segment[]} segments
   * @param {{center?:{y:number,z:number}, tol?:number}} [opts]
   * @returns {{polylines:Array, bounds:{minX:number,maxX:number,minT:number,maxT:number,minR:number,maxR:number}|null}}
   *   每條折線帶原段的 line／kind／tool／path／sub／refReturn，點選與著色才對得起來。
   */
  function unrollSegments(segments, opts) {
    const center = rotCenter(opts);
    const polylines = [];
    let minX = Infinity, maxX = -Infinity, minT = Infinity, maxT = -Infinity, minR = Infinity, maxR = -Infinity;
    for (const seg of segments || []) {
      const pw = rotarySamples(seg, { center, tol: (opts && opts.tol) || 0.05 });
      if (!pw.length) continue;
      const pts = unrollPath(pw, center);
      // 對齊到程式寫的 A 值那一圈：atan2 給的是 -180…180，A270 會變成 -90。
      // 現場寫 A270 就想在圖上看到 270，所以整條折線平移到最接近 seg.a 的那一圈
      // （折線內部的連續性不受影響，因為是整條加同一個 360 的倍數）。
      const aRef = seg.a;
      if (typeof aRef === 'number' && pts.length) {
        const k = Math.round((aRef - pts[pts.length - 1].theta) / 360);
        if (k !== 0) for (const p of pts) p.theta += k * 360;
      }
      const pl = {
        id: seg.id, line: seg.line, opIndex: seg.opIndex, tool: seg.tool,
        kind: seg.kind, path: seg.path, pts,
      };
      if (seg.a !== undefined) pl.a = seg.a;
      if (seg.aFrom !== undefined) pl.aFrom = seg.aFrom;
      if (seg.sub) pl.sub = seg.sub;
      if (seg.refReturn) pl.refReturn = true;
      if (seg.inserted) pl.inserted = true;
      polylines.push(pl);
      // bounds 只算切削段，與 CONTRACT §3 的 GeometryResult.bounds 同一個語意：
      // 從換刀點下來的 G0 起點在 Z150，算進去的話整張圖會被壓成一條線。
      if (seg.refReturn || seg.kind === 'rapid') continue;
      for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.theta < minT) minT = p.theta;
        if (p.theta > maxT) maxT = p.theta;
        if (p.r < minR) minR = p.r;
        if (p.r > maxR) maxR = p.r;
      }
    }
    const bounds = polylines.length ? { minX, maxX, minT, maxT, minR, maxR } : null;
    return { polylines, bounds };
  }

  /**
   * 從程式推估工件半徑（3D 圓棒要畫多粗）。
   * 取切削段（feed/arc/drill）端點離中心最遠的距離——下刀是從工件表面開始的，
   * 所以那個最大值就落在表面附近。推估值一律標 `estimated`，由 UI 講明可以改。
   * @returns {{radius:number, source:'cut'|'rapid'|'default'}|null}
   */
  function estimateRotaryRadius(segments, opts) {
    const center = rotCenter(opts);
    // 最可信的線索：**真正垂直鑽下去的孔**（XY 不動、Z 在變、而且刀對準軸心）。
    // 它的起點就是 R 點，落在工件表面上方一點點，是很接近的上界。
    //
    // 不能拿「所有切削段離軸心最遠的距離」當推估——刀偏在側邊的那種段
    // （T.NC 的 X0.Y-21.474 那兩刀），起點離軸心 √(25²+21.5²) ≈ 33，
    // 但那是刀在旁邊的斜距，不是工件半徑。用它推估會把圓棒撐粗一大圈，
    // 於是那兩刀變成「整支穿過側邊」，成品圖就開花了。
    let radial = -Infinity;
    for (const seg of segments || []) {
      if (!seg || seg.refReturn || seg.kind !== 'drill') continue;
      if (Math.abs(seg.to.x - seg.from.x) > EPS || Math.abs(seg.to.y - seg.from.y) > EPS) continue;
      if (Math.abs(seg.from.y - center.y) > 0.01) continue;   // 刀沒對準軸心 → 不是徑向孔
      const r = Math.abs(seg.from.z - center.z);
      if (r > radial) radial = r;
    }
    if (radial > 0 && Number.isFinite(radial)) return { radius: radial, source: 'radial' };

    let cut = -Infinity, rap = -Infinity;
    for (const seg of segments || []) {
      if (seg.refReturn) continue;
      const isCut = seg.kind === 'feed' || seg.kind === 'arc' || seg.kind === 'drill';
      for (const p of rotarySamples(seg, { center, tol: 0.2 })) {
        const r = Math.hypot(p.y - center.y, p.z - center.z);
        if (isCut) { if (r > cut) cut = r; } else if (r > rap) rap = r;
      }
    }
    if (cut > 0 && Number.isFinite(cut)) return { radius: cut, source: 'cut' };
    if (rap > 0 && Number.isFinite(rap)) return { radius: rap, source: 'rapid' };
    return null;
  }

  /**
   * 從程式反推迴轉中心線的位置。
   *
   * 幾何：分度鑽孔在機台座標上是一條沿 Z 的垂直線，位置 (x_i, y_i)。
   * 它在工件上要是「徑向孔」（刀沿半徑往軸心切），條件是這條線通過迴轉中心線，
   * 也就是 **y_i 必須等於 center.y**。代進轉換式可以看得更清楚：dy = 0 時
   *   θ = atan2(dz·sin A, dz·cos A) = A          （dz > 0，刀在中心線上方）
   * 也就是說 **中心的 Z 不影響角度**，只影響「離中心多遠」與會不會穿過軸心。
   *
   * 所以這裡只推 Y，並回報兩件現場會想知道的事：
   *   - 各個鑽孔的 Y 是否一致（不一致 = 這些孔不是徑向的，程式或裝夾有問題）
   *   - 切削最低點（低於中心線代表刀尖穿過軸心，多半是 Z0 沒對在中心線上）
   * @returns {{y:number, consistent:boolean, spread:number, minCutZ:number, holes:number}|null}
   */
  function estimateRotaryCenter(segments) {
    const list = [];   // 每個徑向下刀段：{line, y, x}
    let minCutZ = Infinity;
    for (const seg of segments || []) {
      if (!seg || seg.refReturn) continue;
      const cutting = seg.kind === 'drill' || seg.kind === 'feed' || seg.kind === 'arc';
      if (!cutting) continue;
      if (seg.to.z < minCutZ) minCutZ = seg.to.z;
      if (seg.from.z < minCutZ) minCutZ = seg.from.z;
      // 只有「原地往下扎」的段才是徑向孔的證據（XY 不動、Z 在變）
      if (seg.kind !== 'drill') continue;
      if (Math.abs(seg.to.x - seg.from.x) > EPS || Math.abs(seg.to.y - seg.from.y) > EPS) continue;
      if (Math.abs(seg.to.z - seg.from.z) < EPS) continue;
      list.push({ line: seg.line, y: seg.from.y, x: seg.from.x, a: seg.a });
    }
    if (!list.length) return null;
    const ys = list.map((h) => h.y).sort((a, b) => a - b);
    const spread = ys[ys.length - 1] - ys[0];
    const mid = ys[Math.floor(ys.length / 2)];
    // 偏離「多數孔所在的那條線」的孔——就是這幾行把刀偏到工件側邊了
    const off = [];
    for (const h of list) {
      const d = h.y - mid;
      if (Math.abs(d) > 0.01 && !off.some((o) => o.line === h.line)) off.push({ line: h.line, y: h.y, offset: d });
    }
    off.sort((a, b) => a.line - b.line);
    return {
      y: mid,
      consistent: spread <= 0.01,
      spread,
      minCutZ: Number.isFinite(minCutZ) ? minCutZ : 0,
      holes: list.length,
      offLines: off,
    };
  }

  NC.buildSegments = buildSegments;
  NC.geometry = {
    buildSegments,
    expandHole,
    sampleSegment,
    /** 第四軸：程式座標 → 工件座標 → 展開圖（見上方區塊註解） */
    rotary: {
      point: rotaryPoint,
      samples: rotarySamples,
      unrollPoint,
      unrollPath,
      unrollSegments,
      estimateRadius: estimateRotaryRadius,
      estimateCenter: estimateRotaryCenter,
      STEP_DEG: ROT_STEP_DEG,
    },
    segmentLength,
    arcFromR,
    arcSweep,
    effectiveRadius,
    PECK_CLEARANCE,
    G73_RETRACT,
    /** 內部：對一串 programmed 段做刀徑補正（測試／進階用途）。 */
    _internal: { collectItems, expandCorners, applyCompensation, computeBounds, tangentStart, tangentEnd },
  };
})(globalThis.NC = globalThis.NC || {});
