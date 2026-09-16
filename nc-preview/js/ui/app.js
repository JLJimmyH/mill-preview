/*
 * 銑床預演台 — 應用程式主控（CONTRACT §8 app）
 *
 * 責任：
 *   1. 開檔（按鈕 + 整頁拖放，UTF-8 → big5 解碼）、存檔（Blob 下載）、複製、載入內建範例、URL hash #sample=…
 *   2. 分析流程：編輯／換檔 → 立刻 analyzeSync（路徑、診斷、模態、刀具表、作業摘要）
 *      → 1 秒後 analyze（含模擬），用版本號丟棄過時結果，進度顯示在狀態列
 *   3. 選取同步：編輯器游標行 ↔ 視圖 ↔ 診斷 ↔ 作業
 *   4. 刀具表／設定存 localStorage（file:// 下可能失敗，全部 try/catch）
 *   5. 刀具表 CSV 匯出／匯入（拿給現場用 Excel 填），刀庫設定（機台層級，key = ncPreview.machine）
 *   6. 版面：左欄 Project 子頁（程式／素材／刀具表／刀庫／機台，整欄全高）＝在這裡「改」；
 *      右欄下方的狀態條（總覽／游標行／作業摘要／錯誤清單＋Project 徽章）＝在這裡「看」。兩條分隔線可拖。
 *   7. 廢料判定（切穿之後跟工件分開的料）的資料流：
 *      state.scrap（設定，跟素材一起存 STOCK_KEY）＋「目前畫面上那份高度陣列」（最終或某個快照）
 *      → chunksFor()（NC.sim.chunks，依陣列快取）→ ChunkResult
 *      → 視圖 setChunks(result, mode)（mode 來自工具列 #selScrap，存 viewPref.scrapMode）
 *      → 素材子頁「目前結果」那行、總覽素材列的「廢料 N 塊」。
 *      設定在素材子頁改（onScrapChange，不走 commit，不會把推估素材翻成手動）、顯示開關留在視圖工具列——
 *      「設定跟顯示分開」。記號（⊙ 工件／✕ 廢料）由視圖 onMark 或素材子頁的迷你預覽點出來，
 *      都塞進 state.scrap.marks 再走同一條路重算。
 *      素材子頁只在素材本身變了才整片重畫；分塊結果回來走 stockPanel.setScrapResult、標記模式切換走
 *      stockPanel.setMarkMode——使用者打到一半的數字不會被洗掉、輸入框不失焦。
 *   8. 素材的來源 state.stockOrigin：'user'（使用者設的，存 localStorage、換 O 號跟著搬）、
 *      'sample'（範例附帶的側車素材，不寫 localStorage、換 O 號不搬）、null（推估）。
 *      對範例按「回到推估」會在 localStorage 留 { estimated: true } 標記，下次載入才不會又套回側車素材。
 *
 * 對 analyze.js / rules.js 尚未載入的情況要容錯：
 *   NC.analyzeSync / NC.analyze 不存在時，本檔自己串 tokenize → interpret → buildSegments（→ sim）。
 */
(function (NC) {
  'use strict';
  const ui = (NC.ui = NC.ui || {});
  const U = NC.util;

  // ---------------------------------------------------------------------------
  // 小工具
  // ---------------------------------------------------------------------------
  const SEV_ORDER = { error: 0, warning: 1, needsInput: 2, info: 3 };
  const SETTINGS_KEY = 'ncPreview.appSettings.v1';
  // 刀庫是整台機共用的，不跟著程式號走 → 自己一個 key，換程式不會被洗掉。
  const MACHINE_KEY = 'ncPreview.machine';
  // 第四軸的裝夾參數（迴轉中心、工件直徑）**跟著程式走**，不是機台設定：
  // 現場說「Z 高度不一定，會依案子調整」，放進機台設定的話換一支程式就帶著上一支的值。
  const ROTARY_KEY = 'ncPreview.rotary.v1';
  // 素材（spec＋夾具＋廢料判定設定）也跟著程式走。只存 spec，min/max 每次由 spec 重算——
  // 存包絡盒的話改天改了換算規則，舊資料就跟新規則對不起來。
  // 項目長相：{ spec?, fixtures?, scrap? }；scrap 是預設值就不寫（loadStock 只看 spec，不受影響）。
  const STOCK_KEY = 'ncPreview.stock.v1';
  // 問題回報信箱。拆成兩段再接起來，公開網頁上的爬蟲抓不到完整位址。
  const REPORT_MAIL = 'chenggg0601' + '@' + 'gmail.com';
  // 廢料的顯示方式（視圖工具列 #selScrap）。預設「標示」不「隱藏」：一料多件的程式
  // 「工件」不只一塊，隱藏會把真正要的零件藏掉；標示錯了至少看得到、點一下就能改。
  const SCRAP_MODES = ['off', 'mark', 'hide'];
  const SCRAP_ANCHORS = ['auto', 'origin', 'largest', 'fixture', 'marks'];

  /** 數字顯示（panels.logic.fmt 修掉了 NC.util.fmt 的去尾 0 問題，優先用它）。 */
  const fmt = (NC.ui.panels && NC.ui.panels.logic && NC.ui.panels.logic.fmt)
    || function (v, d) {
      if (v == null || Number.isNaN(v)) return '—';
      d = d == null ? 3 : d;
      const s = (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d);
      return s.indexOf('.') >= 0 ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
    };

  const $ = (id) => document.getElementById(id);
  const show = (el, on) => { if (el) el.classList.toggle('nc-hidden', !on); };
  const clearEl = (el) => { while (el && el.firstChild) el.removeChild(el.firstChild); };

  /**
   * 範例的短代號（下拉選單的 value 與 URL hash 用）：`樣本 C` → `樣本 C`。
   * samples.js 由 tools/make-samples.mjs 產生，只保證有 {name, text}；若日後補了 id 就直接用。
   */
  function sampleId(s) {
    if (!s) return '';
    if (s.id) return String(s.id);
    return String(s.name || '').replace(/\(\d+\)$/, '').replace(/-$/, '') || String(s.name || '');
  }

  /** 依短代號或檔名找範例（不分大小寫，允許前綴）。 */
  function findSample(key) {
    const list = ui.samples || [];
    const k = String(key == null ? '' : key).trim().toLowerCase();
    if (!k) return null;
    return list.find((s) => sampleId(s).toLowerCase() === k)
      || list.find((s) => String(s.name || '').toLowerCase() === k)
      || list.find((s) => String(s.name || '').toLowerCase().indexOf(k) === 0)
      || null;
  }

  /** 程式識別鍵：有 O 號用 O 號，否則用檔名（刀具表存 localStorage 的 key）。 */
  function programKeyOf(tok, fileName) {
    if (tok && tok.programNumber != null) return 'O' + String(tok.programNumber).padStart(4, '0');
    return fileName || '(未命名)';
  }

  /** 解碼：先試 UTF-8（fatal），失敗改 big5；都不行就 latin1。保留原始行尾。 */
  function decodeBytes(buf) {
    const bytes = new Uint8Array(buf);
    try {
      const t = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { text: t.replace(/^﻿/, ''), encoding: 'UTF-8' };
    } catch (e) { /* 不是合法 UTF-8，往下試 big5 */ }
    try {
      return { text: new TextDecoder('big5').decode(bytes), encoding: 'Big5' };
    } catch (e) { /* 瀏覽器不支援 big5 */ }
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return { text: s, encoding: 'Latin-1' };
  }

  function downloadText(fileName, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName || 'program.nc';   // 保留無副檔名與括號的原檔名
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* 退回舊做法 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  const store = {
    get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
    set(key, val) { try { localStorage.setItem(key, val); return true; } catch (e) { return false; } },
  };

  const nowMs = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

  // ---------------------------------------------------------------------------
  // 廢料判定的設定（Scrap，CONTRACT §5）
  //
  // 預設值與正規化以 simulation.js 的 NC.sim.defaultScrap／normalizeScrap 為準；
  // 這裡留一份同義的退路，是因為 app 跟 simulation 分兩個 commit 進——
  // 舊的 simulation.js 配新的 app.js 時，localStorage 裡存的 scrap 還是得讀得回來、存得進去。
  // ---------------------------------------------------------------------------
  function defaultScrap() {
    if (NC.sim && typeof NC.sim.defaultScrap === 'function') return NC.sim.defaultScrap();
    return { anchor: 'auto', marks: [], skinMm: 0, bridgeMm: 0, minAreaMm2: 2 };
  }
  function normalizeScrap(o) {
    if (NC.sim && typeof NC.sim.normalizeScrap === 'function') return NC.sim.normalizeScrap(o);
    const d = defaultScrap();
    o = (o && typeof o === 'object') ? o : {};
    // 門檻都是「毫米」或「平方毫米」，負的沒有意義 → 夾到 0；不是數字就回預設
    const nonNeg = (v, dflt) => { v = Number(v); return Number.isFinite(v) ? Math.max(0, v) : dflt; };
    const marks = Array.isArray(o.marks)
      ? o.marks
        .filter((m) => m && Number.isFinite(Number(m.x)) && Number.isFinite(Number(m.y)))
        .map((m) => ({ x: Number(m.x), y: Number(m.y), kind: m.kind === 'scrap' ? 'scrap' : 'part' }))
      : [];
    return {
      anchor: SCRAP_ANCHORS.indexOf(o.anchor) >= 0 ? o.anchor : d.anchor,
      marks,
      skinMm: nonNeg(o.skinMm, d.skinMm),
      bridgeMm: nonNeg(o.bridgeMm, d.bridgeMm),
      minAreaMm2: nonNeg(o.minAreaMm2, d.minAreaMm2),
    };
  }
  /** 設定的指紋：快取鍵、以及「跟預設一不一樣」都用它比（同一個 normalize 出來的欄位順序一致，字串可直接比） */
  function scrapKey(s) { return JSON.stringify(normalizeScrap(s)); }
  function isDefaultScrap(s) { return scrapKey(s) === scrapKey(defaultScrap()); }
  function normalizeScrapMode(m) { return SCRAP_MODES.indexOf(m) >= 0 ? m : 'mark'; }
  /** 記號要落在素材的 XY 範圍內（含邊）。正本是 panels.logic.markInStock；面板還沒載入時用同義的退路。 */
  function markInStock(stock, x, y) {
    const L = NC.ui.panels && NC.ui.panels.logic;
    if (L && typeof L.markInStock === 'function') return L.markInStock(stock, x, y);
    if (!stock || !stock.min || !stock.max || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    const e = 1e-6;
    return x >= stock.min.x - e && x <= stock.max.x + e && y >= stock.min.y - e && y <= stock.max.y + e;
  }
  /** 記號座標取到 0.01 mm：列表與 localStorage 才不會是一長串小數（迷你預覽點出來的也是這個精度） */
  function roundMark(v) { return Math.round(v * 100) / 100; }
  /** 點到素材外面時的提示（素材子頁的迷你預覽用同一句：panels.logic.MARK_OUT_OF_STOCK） */
  const MARK_OUT_OF_STOCK = '記號要點在素材範圍內';
  /**
   * 素材要存進 localStorage 的項目（STOCK_KEY 底下 programKey 那一格）。純函式，方便測。
   *   stock 帶 spec 且 stockOrigin === 'user'  → { spec, fixtures }（範例附帶的 'sample' 不寫：沒動過的範例不留痕跡）
   *   否則 sampleDeclined                      → { estimated: true }（範例附了素材、使用者按了「回到推估」）
   *   scrap 非預設                             → 加 scrap
   * 什麼都沒有 → null（呼叫端把整格刪掉）
   */
  function stockItemOf(o) {
    const item = {};
    if (o.stock && o.stock.spec && o.stockOrigin === 'user') {
      item.spec = o.stock.spec;
      item.fixtures = o.stock.fixtures || [];
    } else if (o.sampleDeclined) {
      item.estimated = true;
    }
    if (o.scrap && !isDefaultScrap(o.scrap)) item.scrap = normalizeScrap(o.scrap);
    return (item.spec || item.estimated || item.scrap) ? item : null;
  }

  // ---------------------------------------------------------------------------
  // 分析：優先用 NC.analyze / NC.analyzeSync，沒有就自己串
  // ---------------------------------------------------------------------------
  function sortDiagnostics(list) {
    return list.slice().sort((a, b) => {
      const sa = SEV_ORDER[a.severity] == null ? 9 : SEV_ORDER[a.severity];
      const sb = SEV_ORDER[b.severity] == null ? 9 : SEV_ORDER[b.severity];
      if (sa !== sb) return sa - sb;
      if (a.line !== b.line) return a.line - b.line;
      return String(a.ruleId).localeCompare(String(b.ruleId));
    });
  }

  /** tokenize → interpret ×N → buildTable → buildSegments ×N → estimateStock（不含 sim、不含 rules）。 */
  function fallbackCore(request) {
    const settings = request.settings || U.defaultSettings();
    const tok = NC.tokenize(request.text || '');
    const ids = (request.scenarios && request.scenarios.length) ? request.scenarios.slice() : ['off'];
    if (ids.indexOf('off') < 0) ids.unshift('off');

    const runs = {};
    for (const s of ids) runs[s] = NC.interpret(tok.blocks, settings, s);

    const toolTable = NC.tools.buildTable(tok, runs.off, request.toolTable || null, request.programKey || null);

    const scenarios = {};
    const geos = [];
    for (const s of ids) {
      const geometry = NC.buildSegments(runs[s], toolTable, settings);
      scenarios[s] = { run: runs[s], geometry, sim: null };
      geos.push(geometry);
    }
    const stock = request.stock || NC.tools.estimateStock(ids.map((s) => runs[s]), geos, toolTable);
    return { tok, scenarios, toolTable, stock, diagnostics: [], _ids: ids, _settings: settings };
  }

  /** 蒐集所有診斷：tokenizer + interpreter + geometry + sim 事件 + rules（若已載入），去重後排序。 */
  function fallbackDiagnostics(res) {
    const out = [];
    const seen = new Set();
    const push = (d, scenario) => {
      if (!d || !d.ruleId) return;
      const scn = d.scenario || (scenario && scenario !== 'off' ? scenario : undefined);
      const key = d.ruleId + '|' + d.line + '|' + (scn || '') + '|' + d.message;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(scn ? Object.assign({}, d, { scenario: scn }) : d);
    };
    // 同一條規則若在 off 與 on 都出現且訊息一樣，先跑 off（不帶情境標籤）就會蓋掉 on 的重複
    const dedupeAcrossScenarios = new Set();
    const pushRun = (d, scenario) => {
      if (!d || !d.ruleId) return;
      const plain = d.ruleId + '|' + d.line + '|' + d.message;
      if (dedupeAcrossScenarios.has(plain)) return;
      dedupeAcrossScenarios.add(plain);
      push(d, scenario);
    };

    for (const d of (res.tok.diagnostics || [])) pushRun(d, null);
    for (const s of res._ids) {
      const sr = res.scenarios[s];
      if (!sr) continue;
      for (const d of (sr.run.diagnostics || [])) pushRun(d, s);
      for (const d of (sr.geometry.diagnostics || [])) pushRun(d, s);
      if (sr.sim) for (const d of (sr.sim.events || [])) push(d, s);
    }
    if (NC.rules && typeof NC.rules.run === 'function') {
      try {
        const list = NC.rules.run({
          tok: res.tok, scenarios: res.scenarios, toolTable: res.toolTable, stock: res.stock, settings: res._settings,
        }) || [];
        for (const d of list) push(d, d.scenario || null);
      } catch (e) {
        console.warn('rules.run 失敗，略過規則檢查：', e);
      }
    }
    return sortDiagnostics(out);
  }

  function analyzeSyncCompat(request) {
    if (typeof NC.analyzeSync === 'function') return NC.analyzeSync(request);
    const res = fallbackCore(request);
    res.diagnostics = fallbackDiagnostics(res);
    return res;
  }

  async function analyzeCompat(request, onStage) {
    if (typeof NC.analyze === 'function') return NC.analyze(request, onStage);
    const res = fallbackCore(request);
    if (request.sim && request.sim.enabled && NC.sim) {
      for (const s of res._ids) {
        const sr = res.scenarios[s];
        try {
          const sim = NC.sim.create(res.stock, request.sim.cell || 0.5);
          sr.sim = await NC.sim.run(sim, sr, res.toolTable, res._settings, {
            onProgress: (p) => { if (onStage) onStage('sim', s, p); },
          });
        } catch (e) {
          console.warn('模擬失敗（情境 ' + s + '）：', e);
          sr.sim = null;
        }
      }
    }
    res.diagnostics = fallbackDiagnostics(res);
    return res;
  }

  // ---------------------------------------------------------------------------
  // 主程式
  // ---------------------------------------------------------------------------
  function createApp() {
    const el = {
      app: $('app'),
      btnOpen: $('btnOpen'), fileInput: $('fileInput'), selSample: $('selSample'),
      btnSave: $('btnSave'), btnCopy: $('btnCopy'), selScenario: $('selScenario'),
      statusText: $('statusText'), statusCounts: $('statusCounts'),
      progressWrap: $('progressWrap'), progressBar: $('progressBar'),
      fileLabel: $('fileLabel'), editorHost: $('editorHost'),
      modalHost: $('modalHost'), modalLineLabel: $('modalLineLabel'),
      viewCanvas: $('viewCanvas'),
      viewHost: $('viewHost'), view3dHost: $('view3dHost'), viewCanvas3d: $('viewCanvas3d'),
      viewSplit: $('viewSplit'), viewSplitBar: $('viewSplitBar'),
      chkSplit: $('chkSplit'), chkClip: $('chkClip'), lblSplit: $('lblSplit'), lblClip: $('lblClip'),
      btnClipFlip: $('btnClipFlip'),
      btnMode3d: $('btnMode3d'), chkRef: $('chkRef'), rotaryBanner: $('rotaryBanner'),
      btnModeUnroll: $('btnModeUnroll'), chkRotary: $('chkRotary'), lblRotary: $('lblRotary'),
      rngSection: $('rngSection'), secVal: $('secVal'), btnFit: $('btnFit'),
      rngSnapshot: $('rngSnapshot'), snapVal: $('snapVal'), snapTicks: $('snapTicks'),
      chkRapid: $('chkRapid'), chkFeed: $('chkFeed'), chkStock: $('chkStock'),
      selScrap: $('selScrap'),   // 廢料顯示 off|mark|hide（index.html 可能還沒加，用到都要守衛）
      toolFilter: $('toolFilter'),
      // 圖層／刀具 popover（顯示選項收在這兩個裡面；手機版 CSS 讓它變 bottom sheet）
      btnLayers: $('btnLayers'), popLayers: $('popLayers'),
      btnToolsPop: $('btnToolsPop'), popTools: $('popTools'), toolPopCount: $('toolPopCount'),
      popBackdrop: $('popBackdrop'), kbdHelp: $('kbdHelp'),
      btnAbout: $('btnAbout'), btnAboutTitle: $('btnAboutTitle'), btnAboutClose: $('btnAboutClose'),
      aboutBox: $('aboutBox'), aboutVer: $('aboutVer'), aboutMail: $('aboutMail'),
      tabTools: $('tabTools'), tabDiag: $('tabDiag'), tabOps: $('tabOps'),
      stockHost: $('stockHost'), settingsHost: $('settingsHost'), magHost: $('magHost'),
      tabOverview: $('tabOverview'), projectChips: $('projectChips'), miniModal: $('miniModal'),
      appMain: $('appMain'), appRight: $('appRight'), colSplit: $('colSplit'), rowSplit: $('rowSplit'),
      diagBadge: $('diagBadge'), dropOverlay: $('dropOverlay'),
      mnavDiagBadge: $('mnavDiagBadge'),
      viewTools: $('viewTools'), btnBarMore: $('btnBarMore'), btnViewMore: $('btnViewMore'),
    };

    const state = {
      text: '',
      fileName: '',
      programKey: '(未命名)',
      settings: U.defaultSettings(),
      scenario: 'off',
      cell: 0.5,
      userTable: null,   // 使用者編輯過的刀具表（會存 localStorage）
      stock: null,       // null = 用推估；手動值帶 spec，跟著程式存 localStorage（STOCK_KEY）
      stockOrigin: null, // 'user'（使用者設的）| 'sample'（範例附帶，不存、不搬）| null（推估）
      sampleDeclined: false,   // 這支範例附了素材、但使用者按過「回到推估」（localStorage 的 estimated 標記）
      result: null,
      hiddenTools: new Set(),
      tableSaved: true,   // 刀具表最後一次寫入 localStorage 是否成功
      machineSaved: true, // 刀庫設定最後一次寫入 localStorage 是否成功
      stockSaved: true,   // 素材最後一次寫入 localStorage 是否成功
      lineInfo: [],
      execByLine: [],
      selectedLine: 0,
      simCache: {},        // 上一輪完整分析的 SimResult（依情境），編輯途中沿用免得成品圖整片消失
      simStale: false,     // 目前畫面上的 heightmap 是不是上一輪的（HUD 會標「更新中」）
      rotary: null,        // 第四軸裝夾參數（跟著程式走，見 ROTARY_KEY）；null = 用推估值
      scrap: defaultScrap(),   // 廢料判定設定（跟著程式走，存在 STOCK_KEY 的項目裡）
      markMode: null,          // 'part' | 'scrap' | null：正在等使用者到圖上點哪一塊
      chunkResult: null,       // 目前畫面那份高度陣列的 ChunkResult（總覽素材列與素材子頁都讀它）
      // 視圖版面偏好（機台層級，跟著 SETTINGS_KEY 一起存）。ratio = 並排時左邊 2D 佔的比例；
      // leftRatio = 左欄 Project 佔的寬度比例、statusRatio = 下方狀態條佔的高度比例；
      // scrapMode = 廢料顯示 off|mark|hide（是「怎麼看」不是「怎麼判」，所以跟版面偏好放一起，不跟程式走）。
      viewPref: { split: true, clip: true, clipFlip: false, ratio: 0.5, leftRatio: 0.5, statusRatio: 0.3, scrapMode: 'mark' },
    };

    /** 手機版（窄螢幕）判定。800px 這個門檻和 app.css 的 @media 是同一份，要一起改。 */
    function isMobileLayout() {
      return typeof matchMedia === 'function' && matchMedia('(max-width: 800px)').matches;
    }

    // ---- 還原設定 ----
    (function restoreSettings() {
      const raw = store.get(SETTINGS_KEY);
      if (!raw) return;
      try {
        const o = JSON.parse(raw);
        if (o && o.settings) state.settings = Object.assign(U.defaultSettings(), o.settings);
        if (o && o.scenario) state.scenario = o.scenario;
        if (o && o.cell > 0) state.cell = o.cell;
        if (o && o.view) {
          const v = o.view;
          if ('split' in v) state.viewPref.split = !!v.split;
          if ('clip' in v) state.viewPref.clip = !!v.clip;
          if ('clipFlip' in v) state.viewPref.clipFlip = !!v.clipFlip;
          if (v.ratio > 0.15 && v.ratio < 0.85) state.viewPref.ratio = Number(v.ratio);
          if (v.leftRatio > 0.25 && v.leftRatio < 0.8) state.viewPref.leftRatio = Number(v.leftRatio);
          if (v.statusRatio > 0.1 && v.statusRatio < 0.7) state.viewPref.statusRatio = Number(v.statusRatio);
          if (SCRAP_MODES.indexOf(v.scrapMode) >= 0) state.viewPref.scrapMode = v.scrapMode;
        }
      } catch (e) { /* 壞掉就用預設 */ }
    })();
    // 手機上並排 3D 一邊只剩半個手掌寬，什麼都看不出來：每次載入都強制關，
    // 連存過的偏好也不理（在「選項」裡打開只影響這一次瀏覽）
    if (isMobileLayout()) state.viewPref.split = false;
    /** 這支程式存過的第四軸設定（沒有就 null） */
    function loadRotary(key) {
      if (!key) return null;
      try {
        const all = JSON.parse(store.get(ROTARY_KEY) || '{}');
        const o = all && all[key];
        if (!o || !o.center) return null;
        return { center: { y: Number(o.center.y) || 0, z: Number(o.center.z) || 0 }, radius: Number(o.radius) || 0 };
      } catch (e) { return null; }
    }
    function persistRotary() {
      if (!state.programKey || !state.rotary) return;
      let all = {};
      try { all = JSON.parse(store.get(ROTARY_KEY) || '{}') || {}; } catch (e) { all = {}; }
      all[state.programKey] = state.rotary;
      store.set(ROTARY_KEY, JSON.stringify(all));
    }
    /** localStorage 裡這支程式的素材項目（原樣；沒有就 null）。長相 { spec?, fixtures?, scrap?, estimated? }，各讀各的欄位。 */
    function storedStockItem(key) {
      if (!key) return null;
      try {
        const all = JSON.parse(store.get(STOCK_KEY) || '{}');
        const o = all && all[key];
        return (o && typeof o === 'object') ? o : null;
      } catch (e) { return null; }
    }
    /** 這支程式存過的素材（沒有、或存的資料壞掉就 null＝用推估）。只看 spec：estimated 標記也走這裡回 null。 */
    function loadStock(key) {
      if (!NC.analysis || typeof NC.analysis.stockFromSpec !== 'function') return null;
      const o = storedStockItem(key);
      if (!o || !o.spec) return null;
      try { return NC.analysis.stockFromSpec(o.spec, o.fixtures); } catch (e) { return null; }
    }
    /** 這支程式存過的廢料判定設定（沒有、或壞掉就 null＝用預設）。 */
    function loadScrap(key) {
      const o = storedStockItem(key);
      if (!o || !o.scrap || typeof o.scrap !== 'object') return null;
      return normalizeScrap(o.scrap);
    }
    /** 使用者對這支範例按過「回到推估」（persistStock 寫的 estimated 標記）→ 載入時不要再套範例附的素材 */
    function loadSampleDeclined(key) {
      const o = storedStockItem(key);
      return !!(o && o.estimated === true && !o.spec);
    }
    function persistStock() {
      if (!state.programKey) return;
      let all = {};
      try { all = JSON.parse(store.get(STOCK_KEY) || '{}') || {}; } catch (e) { all = {}; }
      // 廢料判定設定跟素材住同一個項目。預設值不寫：這樣「推估素材＋沒調過廢料」的程式
      // 在 localStorage 完全不留痕跡，跟以前一樣；有調過的才存 { scrap }（spec 可以不存在）。
      // 範例附帶的素材（stockOrigin 'sample'）也不寫——沒動過的範例不留痕跡；
      // 對範例按了「回到推估」才留 { estimated: true }，不然下次載入又套回來，按了等於沒按。
      const item = stockItemOf({ stock: state.stock, stockOrigin: state.stockOrigin, sampleDeclined: state.sampleDeclined, scrap: state.scrap });
      if (item) {
        all[state.programKey] = item;
      } else {
        delete all[state.programKey];   // 回到推估＋廢料回預設＝把存過的一起忘掉
      }
      state.stockSaved = store.set(STOCK_KEY, JSON.stringify(all)) !== false;
    }
    /**
     * 素材搬家（O 號出現、key 換名）時清掉舊 key 的記錄，免得下次空白編輯器又冒出來。
     * onlyScrap = true 時只拿掉 scrap 欄位（素材沒搬、只有廢料設定搬家的情況），spec 留著。
     */
    function removeStoredStock(key, onlyScrap) {
      if (!key) return;
      let all = {};
      try { all = JSON.parse(store.get(STOCK_KEY) || '{}') || {}; } catch (e) { all = {}; }
      if (!(key in all)) return;
      if (onlyScrap) {
        const o = all[key];
        if (!o || !o.scrap) return;
        delete o.scrap;
        if (!o.spec && !o.estimated) delete all[key];   // estimated 標記是那支範例的，留著
      } else {
        delete all[key];
      }
      store.set(STOCK_KEY, JSON.stringify(all));
    }
    /**
     * 這支程式目前生效的第四軸參數。
     *
     * **不從程式反推。** 一律「使用者填過就用他的，沒填就用 (0,0)」——
     * (0,0) 對應四軸的標準對刀方式：G54 的 Y0／Z0 就對在夾頭中心線上，
     * 那時候程式裡的 Z 值本身就是「離軸心多遠」，不需要任何額外輸入。
     *
     * 反推的那支演算法（geometry.rotary.estimateCenter）只拿來**檢查**
     * ——查各個分度孔是不是都在同一條母線上（R37），不拿來當設定值。
     * 猜出來的裝夾參數會安靜地把整張圖畫歪，而現場看不出是猜的。
     */
    function effectiveRotary() {
      if (state.rotary) return state.rotary;
      return { center: { y: 0, z: 0 }, radius: 0 };
    }

    /**
     * 素材頁選了躺圓柱（＝第四軸圓棒）時，直徑與軸心同步進第四軸設定。
     * 直徑在「素材」與「第四軸」兩處都看得到，不同步的話現場一定只改其中一邊，
     * 然後對著兩個不一樣的數字猜哪個才算數。
     */
    function syncRotaryFromStock(s) {
      if (!s || !s.spec || s.spec.shape !== 'cylX' || !rotaryUsedNow()) return;
      state.rotary = {
        center: { y: s.spec.pos.y, z: s.spec.pos.z },
        radius: s.spec.size.y / 2,
      };
      persistRotary();
    }

    function persistSettings() {
      // 刀庫（機台層級）與第四軸（程式層級）都另外存，這裡剔掉免得兩邊各留一份、
      // 改了其中一份就對不起來
      const s = Object.assign({}, state.settings);
      delete s.magazine;
      delete s.rotary;
      store.set(SETTINGS_KEY, JSON.stringify({ settings: s, scenario: state.scenario, cell: state.cell, view: state.viewPref }));
    }

    // ---- 還原刀庫設定（機台層級，與程式號無關）----
    (function restoreMachine() {
      const raw = store.get(MACHINE_KEY);
      if (!raw) return;
      try {
        const o = JSON.parse(raw);
        const mag = ui.panels.logic.normalizeMagazine(o && o.magazine);
        if (mag) state.settings.magazine = mag;
      } catch (e) { /* 壞掉就當沒設定過，R30 不跑 */ }
    })();
    function persistMachine() {
      const mag = state.settings.magazine || null;
      state.machineSaved = store.set(MACHINE_KEY, JSON.stringify({ magazine: mag })) !== false;
    }

    // ---- 建立子元件 ----
    const editor = ui.createEditor(el.editorHost, { debounceMs: 300 });
    const view = ui.createView2D(el.viewCanvas);
    const P = ui.panels;

    // 3D 視圖：要用到才建（WebGL context 很貴）。建不起來就把按鈕標成不可用並說明原因。
    let view3d = null;
    let view3dFailed = false;
    let view3dFresh = false;   // 剛建好、還沒餵過資料（refresh 的 eachView 之後就不用再餵）
    let viewMode = 'top';
    function ensureView3D() {
      if (view3d || view3dFailed) return view3d;
      if (!ui.createView3D) { view3dFailed = true; return null; }
      try {
        view3d = ui.createView3D(el.viewCanvas3d);
      } catch (e) { view3d = null; }
      if (!view3d) { view3dFailed = true; return null; }
      view3d.onPick((line) => { if (line > 0) selectLine(line, { scroll: true }); });
      view3dFresh = true;
      return view3d;
    }
    /** 對所有已建立的視圖做同一件事（3D 沒建就只做 2D） */
    function eachView(fn) { fn(view); if (view3d) fn(view3d); }

    let toolsPanel = null, diagPanel = null, modalPanel = null, opsPanel = null, stockPanel = null, settingsPanel = null, magPanel = null;
    let overviewPanel = null, chipsPanel = null;

    modalPanel = P.modal(el.modalHost, null, null);
    stockPanel = P.stock(el.stockHost, {
      stock: { min: { x: -50, y: -50, z: -10 }, max: { x: 50, y: 50, z: 0 }, source: 'estimated', fixtures: [] },
      onChange: (s) => {
        if (s) {
          state.stock = s;
          state.stockOrigin = 'user';   // 改了任何一格（含範例附帶的）就是使用者的，存起來、換 O 號跟著搬
        } else {
          // 「回到推估」。退掉的是範例附帶的素材要記住（persistStock 寫 estimated 標記），
          // 不然下次載入這支範例又套回來，按了等於沒按
          if (state.stockOrigin === 'sample') state.sampleDeclined = true;
          state.stock = null;
          state.stockOrigin = null;
        }
        persistStock();
        syncRotaryFromStock(s);
        refresh();
      },
      // 廢料判定：設定改了不必重新模擬（高度圖沒變），只重算分塊、重餵視圖——
      // 走 refresh() 的話等於每改一格數字就重跑 1 秒模擬
      scrap: state.scrap,
      scrapResult: null,
      markMode: null,
      mobile: isMobileLayout(),   // 手機版右邊沒有視圖，記號提示只指向迷你預覽
      stockOrigin: null,
      onScrapChange: (s) => {
        state.scrap = normalizeScrap(s);
        persistStock();
        applyChunks();   // 設定是面板自己改的、面板已經是新值：只把結果那三行換掉，不整片重畫
      },
      onMarkMode: (kind) => setMarkMode(kind),
    });
    // 狀態條的「總覽」與分頁列右端的徽章是同一份資料（buildOverviewRows），點了都跳到對應的 Project 子頁
    overviewPanel = P.overview(el.tabOverview, { rows: [], onOpen: (key) => openProjectPage(key) });
    chipsPanel = P.overview(el.projectChips, { rows: [], compact: true, onOpen: (key) => openProjectPage(key) });
    settingsPanel = P.settings(el.settingsHost, {
      settings: state.settings, scenario: state.scenario, cell: state.cell,
      onChange: (o) => {
        state.settings = o.settings;
        // 第四軸是「這個案子怎麼裝夾」，抽出來跟著程式存，不要混進機台設定
        if (o.settings && o.settings.rotary) {
          state.rotary = U.deepClone(o.settings.rotary);
          delete state.settings.rotary;
          persistRotary();
          // 素材頁的躺圓柱與第四軸設定講的是同一顆圓棒。素材 spec 會蓋過 rotary 的直徑
          //（analyze 以 spec 優先），所以這邊改了就要寫回 spec，不然設定等於沒改。
          if (state.stock && state.stock.spec && state.stock.spec.shape === 'cylX'
              && NC.analysis && typeof NC.analysis.stockFromSpec === 'function') {
            const sp = U.deepClone(state.stock.spec);
            if (state.rotary.radius > 0) { sp.size.y = state.rotary.radius * 2; sp.size.z = sp.size.y; }
            sp.pos.y = (state.rotary.center && state.rotary.center.y) || 0;
            sp.pos.z = (state.rotary.center && state.rotary.center.z) || 0;
            state.stock = NC.analysis.stockFromSpec(sp, state.stock.fixtures) || state.stock;
            persistStock();
          }
        }
        state.scenario = o.scenario;
        state.cell = o.cell;
        el.selScenario.value = state.scenario;
        persistSettings();
        refresh();
      },
    });
    toolsPanel = P.toolTable(el.tabTools, {
      table: { programKey: '', tools: [], offsets: [], updatedAt: '' },
      ops: [],
      onChange: (table) => {
        state.userTable = table;
        // file:// 下 localStorage 可能被擋，save 內部已 try/catch，這裡只記下有沒有成功
        state.tableSaved = NC.tools.save(state.programKey, table) !== false;
        refresh();
      },
      onExportCSV: () => exportToolCSV(),
      onImportFile: (file) => openToolCSVFile(file),
    });
    magPanel = P.magazine(el.magHost, {
      magazine: state.settings.magazine || null,
      toolTable: { programKey: '', tools: [], offsets: [], updatedAt: '' },
      usedTools: [],
      onChange: (mag) => {
        // 沒啟用時 settings.magazine 必須整個不存在（R30 靠它決定跑不跑）
        if (mag) state.settings.magazine = mag; else delete state.settings.magazine;
        persistMachine();
        // 設定面板手上是另一份 settings 複本，不同步的話它下次 onChange 會把刀庫吃掉
        settingsPanel.update({ settings: state.settings, scenario: state.scenario, cell: state.cell });
        refresh();
      },
    });
    diagPanel = P.diagnostics(el.tabDiag, {
      items: [],
      onJump: (line, item) => jumpToLine(line, { from: 'diag', item }),
      onFix: (item) => applyFix(item),
    });
    opsPanel = P.ops(el.tabOps, {
      ops: [],
      onJump: (line, op) => {
        jumpToLine(line, { from: 'ops' });
        eachView((v) => v.highlightTool(op && op.tool != null ? op.tool : null));
      },
    });

    // -------------------------------------------------------------------------
    // 狀態列
    // -------------------------------------------------------------------------
    let statusBase = '尚未載入程式';
    function setStatus(text) { statusBase = text; el.statusText.textContent = text; }
    function setProgress(p) {
      if (p == null) { show(el.progressWrap, false); return; }
      show(el.progressWrap, true);
      el.progressBar.style.width = Math.round(U.clamp(p, 0, 1) * 100) + '%';
    }
    function renderCounts(diags, pending) {
      clearEl(el.statusCounts);
      const by = { error: 0, warning: 0, needsInput: 0, info: 0 };
      for (const d of diags) if (by[d.severity] != null) by[d.severity]++;
      for (const sev of ['error', 'warning', 'needsInput', 'info']) {
        if (!by[sev]) continue;
        // 可點：跳到錯誤清單、只看這一類（清單自己的勾選框可以再改回來）
        const sp = document.createElement('button');
        sp.type = 'button';
        sp.className = 'nc-pill nc-pill-' + sev;
        sp.textContent = { error: '錯 ', warning: '警 ', needsInput: '需 ', info: '訊 ' }[sev] + by[sev];
        sp.title = '打開錯誤清單，只看這一類';
        sp.addEventListener('click', () => {
          if (diagPanel) diagPanel.setFilter({ severities: [sev] });
          selectTab('diag');
          if (isMobileLayout()) selectMobileView('status');
        });
        el.statusCounts.appendChild(sp);
      }
      if (pending) {
        const sp = document.createElement('span');
        sp.className = 'nc-pill nc-pill-pending';
        sp.textContent = '模擬中，尚未含碰撞檢查';
        sp.title = '碰撞（R27）、重切削（R28）等要等素材模擬跑完才會出現，大約 1 秒。';
        el.statusCounts.appendChild(sp);
      }
      const n = by.error || by.warning;
      // 手機版底部導覽的「資料」鈕也帶同一顆錯誤數徽章（人在視圖頁才知道有錯要看）
      for (const badge of [el.diagBadge, el.mnavDiagBadge]) {
        if (!badge) continue;
        show(badge, n > 0);
        if (n > 0) {
          badge.textContent = String(by.error || by.warning);
          badge.classList.toggle('is-warn', !by.error);
        }
      }
    }

    // -------------------------------------------------------------------------
    // 分析排程（版本號丟棄過時結果）
    // -------------------------------------------------------------------------
    let version = 0;
    let fullTimer = 0;
    let liveSignal = null;   // 目前這一輪的中止旗標（analyze.js 支援 request.signal）

    const STAGE_LABEL = {
      tokenize: '斷字', interpret: '解譯', tools: '刀具', geometry: '路徑',
      stock: '素材', rules: '規則檢查', sim: '模擬', rulesSim: '模擬後檢查', done: '完成',
    };

    function isAbortError(e) {
      if (NC.analysis && typeof NC.analysis.isAbortError === 'function') return NC.analysis.isAbortError(e);
      return !!(e && (e.name === 'AbortError' || e.aborted === true));
    }

    function buildRequest(withSim, signal) {
      const ids = ['off', 'on'];
      if (ids.indexOf(state.scenario) < 0) ids.push(state.scenario);
      return {
        text: state.text,
        // rotary 不存在機台設定裡（見 ROTARY_KEY），但 core/rules 是從 settings 讀，
        // 所以每次組 request 時把「這支程式生效的值」補進去
        settings: Object.assign({}, state.settings, { rotary: effectiveRotary() }),
        toolTable: state.userTable,
        stock: state.stock,
        scenarios: ids,
        sim: { enabled: !!withSim, cell: state.cell },
        programKey: state.programKey,
        signal: signal || null,
      };
    }

    /** 立刻做同步分析（無模擬），並排程 delay ms 之後的完整分析（含模擬）。 */
    function refresh(opts) {
      opts = opts || {};
      const ver = ++version;
      if (liveSignal) liveSignal.aborted = true;   // 讓還在跑的完整分析自己停下來
      liveSignal = { aborted: false };
      if (fullTimer) { clearTimeout(fullTimer); fullTimer = 0; }
      if (!state.text) {
        state.result = null;
        state.lineInfo = [];
        state.execByLine = [];
        setStatus('尚未載入程式');
        setProgress(null);
        renderCounts([]);
        editor.setDiagnostics([]);
        // 「先挑素材、再寫程式」的流程：還沒有程式時，手動設的素材照樣要能在視圖與面板看到
        view.setData({ segments: [], sim: null, stock: state.stock || null, toolTable: null, scenario: state.scenario });
        toolsPanel.update({ table: { programKey: '', tools: [], offsets: [], updatedAt: '' }, ops: [] });
        magPanel.update({ toolTable: { programKey: '', tools: [], offsets: [], updatedAt: '' }, usedTools: [] });
        diagPanel.update({ items: [] });
        opsPanel.update({ ops: [], toolTable: null, time: null });
        // 沒有程式就沒有高度圖，廢料判定跟著清掉（設定留著，先設素材的流程也可以先調廢料）
        shown.sim = null;
        shown.index = null;
        applyChunks({ quiet: true });
        stockPanel.update({ stock: state.stock || null, rotaryUsed: false, stockOrigin: state.stockOrigin, scrap: state.scrap, scrapResult: null, markMode: state.markMode });
        modalPanel.update(null, null);
        renderMiniModal(0, null);
        renderOverview(null, null, false);
        renderToolFilter({ tools: [] }, []);
        show(el.rotaryBanner, false);
        el.rngSnapshot.disabled = true;
        el.snapVal.textContent = '尚未模擬';
        return;
      }
      const t0 = (performance && performance.now) ? performance.now() : Date.now();
      let res = null;
      try {
        res = analyzeSyncCompat(buildRequest(false, null));
      } catch (e) {
        console.error('分析失敗：', e);
        setStatus('分析失敗：' + (e && e.message ? e.message : e));
        return;
      }
      if (ver !== version) return;
      const ms = ((performance && performance.now) ? performance.now() : Date.now()) - t0;
      applyResult(res, false);
      setStatus(describeResult(res) + ' · 分析 ' + Math.round(ms) + ' ms');
      const delay = opts.fullDelay == null ? 1000 : opts.fullDelay;
      fullTimer = setTimeout(() => runFull(ver), delay);
    }

    async function runFull(ver) {
      if (ver !== version) return;
      const signal = liveSignal;
      setProgress(0);
      el.statusText.textContent = statusBase + ' · 模擬中…';
      let res = null;
      try {
        res = await analyzeCompat(buildRequest(true, signal), (stage, scenario, progress) => {
          if (ver !== version) return;
          if (stage === 'sim' && typeof progress === 'number') {
            setProgress(progress);
            el.statusText.textContent = statusBase + ' · 模擬中 ' + Math.round(progress * 100) + '%';
          } else if (STAGE_LABEL[stage] && stage !== 'done') {
            el.statusText.textContent = statusBase + ' · ' + STAGE_LABEL[stage] + '…';
          }
        });
      } catch (e) {
        if (isAbortError(e)) return;   // 已被新的一輪取代
        console.error('完整分析失敗：', e);
        if (ver === version) { setProgress(null); el.statusText.textContent = statusBase + ' · 模擬失敗：' + ((e && e.message) || e); }
        return;
      }
      if (ver !== version) return;   // 已經有新版本，丟棄
      setProgress(null);
      applyResult(res, true);
      const sr = res.scenarios[state.scenario] || res.scenarios.off;
      const secs = sr && sr.sim && sr.sim.time ? sr.sim.time.total : 0;
      setStatus(describeResult(res) + (secs > 0 ? ' · 估時 ' + fmtDuration(secs) : ''));
    }

    function fmtDuration(sec) {
      if (!(sec > 0)) return '—';
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = Math.round(sec % 60);
      if (h > 0) return `${h} 小時 ${m} 分`;
      return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
    }

    function describeResult(res) {
      const n = res.tok.blocks.length;
      const name = state.fileName || state.programKey;
      const on = res.tok.programName ? `（${res.tok.programName}）` : '';
      const key = state.programKey === name ? '' : ' · ' + state.programKey;
      // 存不進去要講出來，不然使用者填了一整天的刀具表／刀庫，關掉分頁就沒了
      const saveNote = (state.tableSaved === false ? ' · 刀具表無法存入瀏覽器' : '')
        + (state.machineSaved === false ? ' · 刀庫設定無法存入瀏覽器' : '')
        + (state.stockSaved === false ? ' · 素材無法存入瀏覽器' : '');
      return `${name}${on} · ${n} 行${key}${saveNote}`;
    }

    // -------------------------------------------------------------------------
    // 套用分析結果
    // -------------------------------------------------------------------------
    function applyResult(res, hasSim) {
      state.result = res;

      // O 號可能被編輯改掉 → 換 key、換存檔位置
      const key = programKeyOf(res.tok, state.fileName);
      let keyChanged = false;
      if (key !== state.programKey) {
        const prevKey = state.programKey;
        state.programKey = key;
        state.rotary = loadRotary(key);
        const savedStock = loadStock(key);
        const savedScrap = loadScrap(key);
        state.sampleDeclined = loadSampleDeclined(key);
        let moveStock = false, moveScrap = false;
        if (savedStock) {
          state.stock = savedStock;
          state.stockOrigin = 'user';
        } else if (state.stock && state.stock.spec && state.stockOrigin === 'user') {
          // 先設素材、後寫程式：打字打到 O 號出現時 key 才會變，
          // 剛設好的素材要跟著搬到新 key，不能被「新 key 沒存過」洗成 null
          moveStock = true;
        } else {
          // 沒存過就推估。範例附帶的素材（'sample'）不跟著搬：那是範例的，改了 O 號就不是那支範例了
          state.stock = null;
          state.stockOrigin = null;
        }
        // 廢料判定設定比照素材：新 key 存過就用存的；沒存過但目前調過 → 跟著搬；否則回預設
        if (savedScrap) {
          state.scrap = savedScrap;
        } else if (!isDefaultScrap(state.scrap)) {
          moveScrap = true;
        } else {
          state.scrap = defaultScrap();
        }
        // 素材搬家時整個項目一起搬；只有廢料設定搬家時舊 key 的 spec 要留著（那可能是另一支程式的）
        if (moveStock) removeStoredStock(prevKey);
        else if (moveScrap) removeStoredStock(prevKey, true);
        if (moveStock || moveScrap) persistStock();
        const saved = NC.tools.load(key);
        // saved 是 null 時一定要把舊程式的手填刀具表清掉，否則 O1004 的 Ø49.5
        // 會跟著跑到 O0999，而且下次存檔會把這份錯的資料存進新的 key。
        const before = state.userTable;
        state.userTable = saved || null;
        keyChanged = before !== state.userTable;
        state.simCache = {};
      }

      const sr = res.scenarios[state.scenario] || res.scenarios.off;
      const run = sr.run;

      // 編輯途中的同步分析沒有模擬結果。直接把 null 丟給視圖的話，成品圖會整片消失一秒鐘，
      // 狀態列的紅字計數也會跟著跳；沿用上一輪的 heightmap（格網對得起來才用）並標成「更新中」。
      let simForView = sr.sim;
      state.simStale = false;
      if (hasSim) {
        state.simCache[state.scenario] = sr.sim || null;
      } else if (!simForView) {
        const cached = state.simCache[state.scenario];
        if (cached && simMatchesStock(cached, res.stock)) { simForView = cached; state.simStale = true; }
      }

      // ---- 編輯器：診斷 + 行旁資訊 ----
      buildLineTables(res, sr);
      editor.setDiagnostics(res.diagnostics);
      editor.setLineInfo((line) => state.lineInfo[line] || '');

      // ---- 視圖 ----
      const viewData = {
        segments: sr.geometry.segments,
        sim: simForView,
        simStale: state.simStale,
        stock: res.stock,
        toolTable: res.toolTable,
        scenario: state.scenario,
        rotaryCenter: rotaryCenterOf(),
        rotary: rotaryOptOf(run),
      };
      eachView((v) => v.setData(viewData));
      if (view3d) view3dFresh = false;   // eachView 已經餵過了，applyViewLayout 不必再重建一次
      // 視圖 setData 之後顯示的是最終高度；快照由下面的 syncSnapshotSlider → applySnapshot 再改 shown.index
      shown.sim = simForView;
      shown.index = null;
      syncRotaryUI(run);
      syncSectionRange(res.stock);
      syncSnapshotSlider(simForView, run.ops, state.simStale);
      renderToolFilter(res.toolTable, sr.geometry.segments);
      applyVisible();
      // 廢料判定：畫面上那份高度陣列定了才能算。quiet＝面板與總覽由下面自己更新，不要各畫兩次
      const chunkResult = applyChunks({ quiet: true });

      // ---- 面板 ----
      toolsPanel.update({ table: res.toolTable, ops: run.ops });
      diagPanel.update({ items: res.diagnostics });
      opsPanel.update({ ops: run.ops, toolTable: res.toolTable, time: sr.sim ? sr.sim.time : null });
      stockPanel.update({
        stock: res.stock, rotaryUsed: !!rotaryOptOf(run), stockOrigin: state.stockOrigin,
        scrap: state.scrap, scrapResult: withFirstScrap(chunkResult), markMode: state.markMode, mobile: isMobileLayout(),
      });
      settingsPanel.update({
        settings: Object.assign({}, state.settings, { rotary: effectiveRotary() }),
        scenario: state.scenario, cell: state.cell, rotaryUsed: !!rotaryOptOf(run),
      });
      magPanel.update({
        magazine: state.settings.magazine || null,
        toolTable: res.toolTable,
        usedTools: usedToolsOf(run),
      });

      renderCounts(res.diagnostics, !hasSim);
      renderOverview(res, run, hasSim);
      renderRotaryBanner(run);
      showModalFor(state.selectedLine || editor.getCursorLine());

      // 換了 O 號 → 刀具表換了一份，得用新的表重算一次（畫面上的結果現在還是舊表算的）
      if (keyChanged) setTimeout(() => { if (state.text) refresh(); }, 0);
    }

    /** 這支程式真的換上主軸過的 T 號（刀庫面板只列這些，不然一次列 24 格沒重點） */
    function usedToolsOf(run) {
      const out = [];
      for (const op of ((run && run.ops) || [])) if (op.tool != null && out.indexOf(op.tool) < 0) out.push(op.tool);
      return out.sort((a, b) => a - b);
    }

    // -------------------------------------------------------------------------
    // 刀具表 CSV（拿給現場用 Excel 填直徑、角度、刃長、D 補正值）
    // -------------------------------------------------------------------------
    function exportToolCSV() {
      const res = state.result;
      if (!res || !res.toolTable || !res.toolTable.tools.length) {
        toolsPanel.setImportStatus('沒有刀具可以匯出（這支程式裡沒有 M6 換刀）', 'error');
        return false;
      }
      let csv;
      try {
        const sr = res.scenarios.off || currentScenario();
        csv = NC.tools.toCSV(res.toolTable, { tok: res.tok, run: sr ? sr.run : null });
      } catch (e) {
        console.error('匯出 CSV 失敗：', e);
        toolsPanel.setImportStatus('匯出失敗：' + ((e && e.message) || e), 'error');
        return false;
      }
      const name = P.logic.csvFileName(state.programKey);
      // BOM 一定要有：少了它 Excel 用系統 ANSI 讀，中文欄名整排變亂碼
      downloadText(name, P.logic.withBOM(csv), 'text/csv;charset=utf-8');
      toolsPanel.setImportStatus(`已匯出 ${res.toolTable.tools.length} 把刀到 ${name}（UTF-8 BOM，Excel 可直接開）`, 'ok');
      setStatus('已匯出 ' + name);
      return true;
    }

    /**
     * CSV 的「程式」欄可能寫 O 號，也可能寫檔名（刀具資料 CSV 寫的是 樣本 A）。
     * 兩個都試過再退回「整份都收」，免得欄位對不上就整份匯不進來。
     */
    function readToolCSV(text) {
      for (const key of [state.programKey, state.fileName]) {
        if (!key) continue;
        const t = NC.tools.fromCSV(text, key);
        if (t && t.tools && t.tools.length) return t;
      }
      return NC.tools.fromCSV(text, null);
    }

    function importToolCSV(text, fileName) {
      if (!state.result) {
        toolsPanel.setImportStatus('請先載入 NC 程式，再匯入刀具表', 'error');
        return false;
      }
      let imported = null;
      try {
        imported = readToolCSV(text);
      } catch (e) {
        console.warn('CSV 解析失敗：', e);
        toolsPanel.setImportStatus('這個 CSV 讀不進來：' + ((e && e.message) || e), 'error');
        return false;
      }
      if (!imported || !imported.tools || !imported.tools.length) {
        toolsPanel.setImportStatus('這個檔案裡找不到刀具資料。第一列要有欄名而且必須包含「T」欄——'
          + '最保險的做法是先按「匯出 CSV」，在那份檔案上直接填。', 'error');
        return false;
      }
      const r = P.logic.mergeCSVTable(state.userTable || state.result.toolTable, imported);
      // 「8?」這種有寫東西但不是純數字的格子，fromCSV 會整格丟掉。不講的話現場會以為填進去了
      let unparsed = [];
      try { unparsed = P.logic.csvUnparsedCells(text); } catch (e) { unparsed = []; }
      const from = fileName ? `（來源 ${fileName}）` : '';
      const msg = P.logic.describeImport(r, unparsed);
      if (!r.tools && !r.offsets) {
        toolsPanel.setImportStatus(msg + '——「請填_」欄位留白時不會覆蓋推測值。' + from, 'warn');
        return false;
      }
      state.userTable = r.table;
      state.tableSaved = NC.tools.save(state.programKey, r.table) !== false;
      toolsPanel.setImportStatus(msg + from, P.logic.importStatusKind(r, unparsed));
      setStatus(msg);
      refresh();
      return true;
    }

    function openToolCSVFile(file) {
      if (!file) return;
      readFile(file).then((r) => importToolCSV(r.text, file.name)).catch((e) => {
        toolsPanel.setImportStatus('讀檔失敗：' + file.name + ((e && e.message) ? '（' + e.message + '）' : ''), 'error');
      });
    }

    /** 舊的 SimResult 和目前素材的格網對不對得起來（對不起來就不能沿用） */
    function simMatchesStock(sim, stock) {
      if (!sim || !stock || !stock.min || !stock.max) return false;
      const cell = sim.cell > 0 ? sim.cell : state.cell;
      const nx = Math.ceil((stock.max.x - stock.min.x) / cell - 1e-9) + 1;
      const ny = Math.ceil((stock.max.y - stock.min.y) / cell - 1e-9) + 1;
      return sim.nx === nx && sim.ny === ny
        && Math.abs(sim.origin.x - stock.min.x) < 1e-9 && Math.abs(sim.origin.y - stock.min.y) < 1e-9;
    }

    /** 建立 行號 → ExecutedBlock、行號 → 行旁資訊字串 兩張表（O(1) 查詢）。 */
    function buildLineTables(res, sr) {
      const blocks = res.tok.blocks || [];
      const info = new Array(blocks.length + 2).fill('');
      const exec = new Array(blocks.length + 2).fill(null);
      const isEmpty = new Array(blocks.length + 2).fill(false);
      for (const b of blocks) isEmpty[b.line] = b.isEmpty;
      for (const eb of (sr.run.executed || [])) {
        exec[eb.line] = eb;
        if (eb.skipped) { info[eb.line] = '（此情境跳過）'; continue; }
        if (eb.ignored) { info[eb.line] = '（多斜線忽略）'; continue; }
        if (isEmpty[eb.line]) continue;
        const s = eb.after;
        const parts = [];
        parts.push(s.motion || '—');
        parts.push(s.distance === 'G91' ? '91' : '90');
        if (s.comp !== 'G40') parts.push(s.comp + (s.d ? 'D' + s.d : ''));
        if (s.cycle) parts.push(s.cycle.code);
        if (s.feed != null) parts.push('F' + fmt(s.feed, 1));
        parts.push('Z' + fmt(s.pos.z, 2));
        info[eb.line] = parts.join(' ');
      }
      state.lineInfo = info;
      state.execByLine = exec;
    }

    /** 刀具表裡有幾把刀還在用預設值（型式／直徑／D 補正是猜的） */
    function countDefaultTools(table, ops) {
      const L = P.logic;
      try {
        const t = U.deepClone(table);
        const dMap = L.dListByTool(t, ops);
        L.ensureOffsets(t, dMap);
        return L.countDefaultTools(t, dMap);
      } catch (e) { return 0; }
    }

    function stockSizeText(stock) {
      if (!stock) return '';
      if (stock.kind === 'cylinder') return `Ø${fmt(stock.radius * 2, 1)} × 長 ${fmt(stock.xMax - stock.xMin, 1)} mm`;
      return `${fmt(stock.max.x - stock.min.x, 1)}×${fmt(stock.max.y - stock.min.y, 1)}×${fmt(stock.max.z - stock.min.z, 1)} mm`;
    }

    const SCENARIO_SHORT = { off: '關', on: '開', multiIgnored: '只跳多斜線' };

    /**
     * 狀態條「總覽」的五列（程式／素材／刀具／刀庫／機台），徽章用同一份（去掉程式那列）。
     * 每列一句話講「現在是什麼狀態」，點了跳到左欄對應的子頁去改——設定在左上改、在下面看。
     *
     * 素材推估與刀具用預設值以前是頂列的兩條橫幅，現在住在這裡：
     * 推估素材造成的誤判比「刀具用預設值」多得多（樣本 B 94 筆 warning 有 90 筆來自推估素材），
     * 所以素材那列在推估時一定是琥珀色，而且寫明有幾筆判定是依它算的。
     */
    function buildOverviewRows(res, run, hasSim) {
      const rows = [];
      const L = P.logic;
      if (!res) {
        // 還沒有程式：素材照樣可以先設（先挑素材、再寫程式是正常流程）
        const s = state.stock;
        rows.push({ key: 'program', label: '程式', level: 'muted', text: '尚未載入程式。按「開檔…」、選範例，或直接開始寫', short: '未載入', go: '編輯 ›' });
        rows.push(s
          ? { key: 'stock', label: '素材', level: 'ok', text: stockOriginLabel() + ' ' + L.stockSummaryText(s), short: stockOriginShort() }
          : { key: 'stock', label: '素材', level: 'muted', text: '尚未設定。可以先把素材設好、再開始寫程式，素材會跟著這支程式存', short: '未設' });
        return rows;
      }
      const sr = res.scenarios[state.scenario] || res.scenarios.off;
      const ops = (run && run.ops) || [];
      const diags = res.diagnostics || [];

      // 程式
      {
        const secs = sr && sr.sim && sr.sim.time ? sr.sim.time.total : 0;
        const parts = [`${res.tok.blocks.length} 行`, `${ops.length} 個作業`];
        if (secs > 0) parts.push('估時 ' + fmtDuration(secs));
        else if (!hasSim) parts.push('模擬中…');
        const name = (state.fileName || state.programKey) + (res.tok.programName ? `（${res.tok.programName}）` : '');
        rows.push({ key: 'program', label: '程式', level: 'ok', text: `${name} · ${parts.join(' · ')}`, short: `${res.tok.blocks.length} 行`, go: '編輯 ›' });
      }

      // 素材
      {
        const st = res.stock;
        const est = !!(st && st.source === 'estimated');
        const k = est ? diags.filter((d) => d.estimatedStock).length : 0;
        if (!st) {
          rows.push({ key: 'stock', label: '素材', level: 'muted', text: '尚未設定', short: '未設' });
        } else if (est) {
          rows.push(decorateStockRow({
            key: 'stock', label: '素材', level: 'warn',
            text: `由程式推估 ${stockSizeText(st)}${k > 0 ? `，${k} 筆判定依此` : ''}`, short: '推估',
            detail: st.kind === 'cylinder'
              ? '第四軸圓棒的直徑是「取切削段離軸心最遠的距離」猜的，不是量出來的；填實際直徑，成品圖與切深才會準。'
              : '推估素材是「用切削範圍往外擴一個刀半徑」猜的，不是真的毛胚；填入真實尺寸，這些判定會重算。',
          }));
        } else {
          rows.push(decorateStockRow({ key: 'stock', label: '素材', level: 'ok', text: stockOriginLabel() + ' ' + L.stockSummaryText(st), short: stockOriginShort() }));
        }
      }

      // 刀具
      {
        const tools = (res.toolTable && res.toolTable.tools) || [];
        const nDef = countDefaultTools(res.toolTable, ops);
        if (!tools.length) {
          rows.push({ key: 'tools', label: '刀具', level: 'muted', text: '沒有換刀（程式裡沒有 M6）', short: '無' });
        } else if (nDef > 0) {
          rows.push({
            key: 'tools', label: '刀具', level: 'warn',
            text: `${tools.length} 把，${nDef} 把使用預設值，成品圖可能不準`, short: `${nDef} 把預設`,
            detail: '把型式、直徑、D 補正值填成實際值，模擬結果才會準。',
          });
        } else {
          rows.push({ key: 'tools', label: '刀具', level: 'ok', text: `${tools.length} 把，型式與直徑都已填`, short: `${tools.length} 把` });
        }
      }

      // 刀庫（整台機共用）
      {
        const mag = L.normalizeMagazine(state.settings.magazine);
        if (!mag) {
          rows.push({
            key: 'mag', label: '刀庫', level: 'muted', text: '未啟用，不檢查刀位衝突', short: '未啟用',
            detail: '刀庫是整台機共用的設定；啟用後會檢查大徑刀的鄰位與同一刀位放兩把刀。',
          });
        } else {
          let ms = null;
          try { ms = L.magazineStatus(mag, res.toolTable, usedToolsOf(run)); } catch (e) { ms = null; }
          const errs = ms ? ms.issues.filter((i) => i.severity === 'error') : [];
          const missing = ms ? ms.unassigned : [];
          if (errs.length) {
            rows.push({ key: 'mag', label: '刀庫', level: 'error', text: `${errs.length} 處會撞刀`, short: `撞刀 ${errs.length}`, detail: errs.map((i) => i.text).join('\n') });
          } else if (missing.length) {
            rows.push({ key: 'mag', label: '刀庫', level: 'warn', text: `${missing.length} 把刀還沒登記刀位（${missing.map((t) => 'T' + t).join('、')}）`, short: `缺 ${missing.length} 位` });
          } else {
            rows.push({ key: 'mag', label: '刀庫', level: 'ok', text: `${mag.size} 個刀位，這支程式的刀都已登記、無衝突`, short: '無衝突' });
          }
        }
      }

      // 機台（第四軸那組跟著程式走）
      {
        const rot = run && run.rotary;
        const rotOn = !!(rot && rot.used && rot.rotateLines.length);
        const parts = [];
        let level = 'ok';
        if (rotOn) {
          const r = effectiveRotary();
          if (rot.mode === 'simultaneous') { parts.push(`${rot.axis} 軸同動切削，這幾段沒有預演`); level = 'warn'; }
          else parts.push(`第四軸 ${rot.axis} 分度 ${rot.angles.length} 個角度`);
          parts.push(`迴轉中心 Y${fmt(r.center.y)} Z${fmt(r.center.z)}`);
          parts.push(r.radius > 0 ? `工件 Ø${fmt(r.radius * 2)}` : '直徑由程式推估');
        } else {
          parts.push('三軸');
        }
        parts.push(`格距 ${state.cell} mm`);
        parts.push(`Block skip ${SCENARIO_SHORT[state.scenario] || state.scenario}`);
        rows.push({ key: 'machine', label: '機台', level, text: parts.join(' · '), short: rotOn ? `${rot.axis} 軸分度` : '三軸' });
      }
      return rows;
    }

    /** 總覽素材列的開頭：手動設的寫「手動指定」，範例附帶的寫「範例附帶」（徽章的短字也跟著分） */
    function stockOriginLabel() { return state.stockOrigin === 'sample' ? '範例附帶' : '手動指定'; }
    function stockOriginShort() { return state.stockOrigin === 'sample' ? '範例' : '手動'; }

    /**
     * 素材那列補上廢料判定的結果。切穿之後有料跟工件分開，現場最想知道的是「哪幾塊會掉」——
     * 這比素材是推估還是手動更急，所以有廢料時這列至少提到琥珀色；工件沒碰到夾具再多提一句。
     * 說明不提顏色：廢料顯示切到「隱藏」或「保留」時視圖裡沒有橘色，寫了反而讓人找不到。
     */
    function decorateStockRow(row) {
      const cr = state.chunkResult;
      if (!cr || !cr.supported || !(cr.scrapCount > 0)) return row;
      row.text += ` · 廢料 ${cr.scrapCount} 塊`;
      if (row.level === 'ok' || row.level === 'muted') row.level = 'warn';
      const lines = [`切穿之後有 ${cr.scrapCount} 塊料跟工件分開，合計 ${fmt(cr.scrapAreaMm2, 0)} mm²；顯示方式在視圖工具列「廢料」下拉。`];
      // 掉落警告要先有工件：唯一一塊被點成 ✕ 時沒有「工件」可言（核心會給 null，這裡也守一次）
      if (cr.partCount > 0 && cr.partTouchesFixture === false && cr.hasFixture) lines.push('工件沒有碰到夾具，切斷後會掉落。');
      lines.push('判定方式在「素材」子頁的「廢料判定」調整；猜錯了在圖上點一下標記。');
      row.detail = (row.detail ? row.detail + '\n' : '') + lines.join('\n');
      return row;
    }

    // 最近一次 renderOverview 的參數：廢料判定變了（設定、記號、快照）要重畫總覽，但分析結果沒變
    let overviewArgs = null;
    function renderOverview(res, run, hasSim) {
      overviewArgs = { res, run, hasSim };
      const rows = buildOverviewRows(res, run, hasSim);
      overviewPanel.update({ rows });
      chipsPanel.update({ rows: rows.filter((r) => r.key !== 'program') });
    }
    function rerenderOverview() {
      if (overviewArgs) renderOverview(overviewArgs.res, overviewArgs.run, overviewArgs.hasSim);
    }

    /**
     * 第四軸的迴轉中心（工件座標的 Y/Z）。
     * 四軸的裝夾慣例是 G54 的 Y0／Z0 對到夾頭中心線，所以預設 (0,0)；
     * 現場對不上時由設定覆寫（settings.rotary.center）。
     */
    function rotaryCenterOf() {
      const c = effectiveRotary().center;
      return { y: Number(c.y) || 0, z: Number(c.z) || 0 };
    }

    /**
     * 3D 視圖的第四軸選項：只有 A 真的轉過才給，否則三軸程式會被當成四軸畫。
     * 給了之後 3D 會把路徑換算到工件座標、素材改畫圓棒、不建高度圖成品。
     */
    function rotaryUsedNow() {
      const sr = currentScenario();
      return !!(sr && rotaryOptOf(sr.run));
    }

    function rotaryOptOf(run) {
      const rot = run && run.rotary;
      if (!rot || !rot.used || !rot.rotateLines.length) return null;
      return { center: rotaryCenterOf(), radius: Number(effectiveRotary().radius) || 0 };
    }

    /**
     * 展開圖只有在第四軸真的轉過的時候才有意義——三軸程式的每一段角度都是 0，
     * 攤平之後會變成一條沒有資訊的橫線，還會讓人以為工具壞了。所以按鈕預設停用。
     */
    function syncRotaryUI(run) {
      const rot = run && run.rotary;
      const on = !!(rot && rot.used && rot.rotateLines.length);
      el.btnModeUnroll.disabled = !on;
      el.btnModeUnroll.title = on
        ? `第四軸展開圖：把圓柱工件的表面攤平（橫軸＝X 軸向位置，縱軸＝${rot.axis} 角度）。分度孔的角度等不等分，這張圖一眼就看得出來。`
        : '這支程式沒有用到第四軸（或 A 從頭到尾沒轉過），展開圖沒有東西可以畫';

      // 四軸時所有視圖必須是同一套座標，不然兩張圖會互相矛盾——三張都畫在**工件座標**上：
      // 剖面 X = 圓棒橫截面、剖面 Y = 沿軸向的縱剖面、俯視 = 從上方看那根圓棒。
      // 圓棒的高度圖攤成直角座標之後（view2d 的 cylToCartesian）這三張都算得出來，
      // 所以按鈕不再停用，只是把說明換成四軸的版本（早期版本沒有圓棒模擬才必須停用）。
      const ROTARY_MODE_TIP = {
        top: '第四軸：從上方看那根圓棒（工件座標）。棒身以外是空的，分度孔排不排得齊看得出來。',
        sectionX: '第四軸：圓棒橫截面（工件座標）。這一刀切在哪個 X，孔就從圓周指向中心。',
        sectionY: '第四軸：沿軸向的縱剖面（工件座標）。這個 Y 上圓棒被削成什麼厚度。',
      };
      for (const b of document.querySelectorAll('.app-seg__btn')) {
        const m = b.dataset.mode;
        if (!ROTARY_MODE_TIP[m]) continue;
        b.disabled = false;
        b.title = on ? ROTARY_MODE_TIP[m] : '';
      }
      // 「工件轉動軌跡」只有四軸才有意義
      show(el.lblRotary, on);
      if (!on && el.chkRotary.checked) { el.chkRotary.checked = false; applyVisible(); }
      if (!on && viewMode === 'unroll') setViewMode('top');
    }

    /**
     * 第四軸橫幅。這條是三條橫幅裡最不能省的一條：
     * 本工具不套用工件旋轉，四軸程式的畫面會把不同角度的加工全部疊在同一面上，
     * 看起來完全正常。錯誤清單裡雖然有 R37，但現場多半是先看圖才看清單——
     * 圖旁邊沒有這句話，等於默認那張圖可以信。
     */
    function renderRotaryBanner(run) {
      const rot = run && run.rotary;
      const on = !!(rot && rot.used && rot.rotateLines.length);
      show(el.rotaryBanner, on);
      if (!on) return;
      const sim = rot.mode === 'simultaneous';
      el.rotaryBanner.textContent = sim
        ? `有 ${rot.axis} 軸同動切削，這幾段沒有預演`
        : `有 ${rot.axis} 軸分度 ${rot.angles.length} 個角度 → 圓棒素材`;
      el.rotaryBanner.title = (sim
        ? `第 ${rot.simLines.slice(0, 8).join('、')} 行是 ${rot.axis} 軸與 XYZ 同時進給的四軸插補，實際刀路是繞著旋轉中心展開的曲面，本工具畫不出來。\n`
        : `這支程式把工件轉到 ${rot.angles.map((v) => rot.axis + fmt(v)).join('、')} 這幾個角度加工，素材當成圓棒模擬。\n\n`
          + '【展開圖】把圓棒表面攤平，各角度分開畫——分度對不對看這張。\n'
          + '【俯視／剖面 X／剖面 Y／3D】都畫在工件座標上（圓棒），成品與殘料看得出來。\n')
        + '仍然有效：G 碼語法、模態、刀長／刀徑補正、固定循環參數、進給轉速、換刀順序、逐行的孔位與深度。\n'
        + '仍然表現不了：側凹——橫向穿孔的內壁、鳩尾槽那種（貫穿孔的兩個開口有，中間的孔道沒有）。\n'
        + '點一下看錯誤清單裡的 R37。';
    }

    // -------------------------------------------------------------------------
    // 視圖控制
    // -------------------------------------------------------------------------
    let sectionTouched = false;
    let snapshotTouched = false;
    let snapshotAfterOp = null;   // 使用者選的「第幾把刀之後」（afterOpIndex），null = 最終
    let snapshotOpCount = 0;   // 這一輪模擬總共有幾個作業（快照可能比它少，見 applySnapshot）
    /**
     * 剖面滑桿只有在剖面模式才有意義。俯視就是從上往下看整塊成品，
     * 沒有「切在哪一刀」這回事；展開圖與 3D 同理。
     */
    function sectionMode() { return viewMode === 'sectionX' || viewMode === 'sectionY'; }

    function syncSectionRange(stock) {
      if (!sectionMode()) {
        el.rngSection.disabled = true;
        el.secVal.textContent = '—';
        syncSection3D();
        return;
      }
      const mode = viewMode;
      const axis = mode === 'sectionY' ? 'y' : 'x';
      const lo = Math.floor(stock.min[axis]);
      const hi = Math.ceil(stock.max[axis]);
      el.rngSection.min = String(lo);
      el.rngSection.max = String(hi);
      el.rngSection.disabled = false;
      let v = Number(el.rngSection.value);
      if (!sectionTouched || !(v >= lo && v <= hi)) {
        v = Math.round(((lo + hi) / 2) * 2) / 2;
        el.rngSection.value = String(v);
      }
      view.setSection(v);
      el.secVal.textContent = (mode === 'sectionY' ? 'Y' : 'X') + fmt(v, 2);
      syncSection3D();
    }

    /** 模擬進度時間軸的刀次刻度：每份快照一個 T 標籤，點了直接跳到該刀完工的畫面。
     * 位置對齊滑桿值（value i＝snaps[i]）；作業多時抽樣顯示，標籤才不會疊成一團。 */
    function renderSnapTicks(snaps) {
      if (!el.snapTicks) return;
      clearEl(el.snapTicks);
      if (!snaps || !snaps.length) return;
      const max = snaps.length;                       // 滑桿 max（value=max 是「最終」）
      const step = Math.max(1, Math.ceil(max / 12));  // 標籤最多 12 個
      for (let i = 0; i < max; i += step) {
        const s = snaps[i];
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'app-scrub__tick';
        b.style.left = (i / max * 100) + '%';
        const opNo = (s && s.afterOpIndex != null ? s.afterOpIndex : i) + 1;
        b.textContent = s && s.tool != null ? 'T' + s.tool : '#' + opNo;
        b.title = `跳到第 ${opNo} 把完工`;
        b.addEventListener('click', () => {
          el.rngSnapshot.value = String(i);
          el.rngSnapshot.dispatchEvent(new Event('input'));
        });
        el.snapTicks.appendChild(b);
      }
    }

    function syncSnapshotSlider(sim, ops, stale) {
      const snaps = sim && sim.snapshots ? sim.snapshots : [];
      if (!snaps.length) {
        el.rngSnapshot.min = '0';
        el.rngSnapshot.max = '0';
        el.rngSnapshot.value = '0';
        el.rngSnapshot.disabled = true;
        el.snapVal.textContent = sim ? '無作業' : '尚未模擬';
        renderSnapTicks([]);
        return;
      }
      el.rngSnapshot.min = '0';
      el.rngSnapshot.max = String(snaps.length);
      el.rngSnapshot.disabled = false;
      renderSnapTicks(snaps);
      snapshotOpCount = (ops && ops.length) || snaps.length;
      // 使用者拉過滑桿的話要記住他選的是「第幾把刀之後」（不是陣列索引——
      // 作業數超過預算時快照是抽樣的），重新模擬後找最接近的那一份還原。
      let v = snaps.length;
      if (snapshotTouched && snapshotAfterOp != null) {
        let best = -1, bestDiff = Infinity;
        for (let i = 0; i < snaps.length; i++) {
          const diff = Math.abs((snaps[i].afterOpIndex == null ? i : snaps[i].afterOpIndex) - snapshotAfterOp);
          if (diff < bestDiff) { bestDiff = diff; best = i; }
        }
        if (best >= 0) v = best;
      }
      el.rngSnapshot.value = String(v);
      applySnapshot(v, snaps, stale);
    }

    function applySnapshot(v, snaps, stale) {
      snaps = snaps || ((state.result && currentScenario() && currentScenario().sim) ? currentScenario().sim.snapshots : []);
      if (!snaps || !snaps.length) return;
      const note = (stale == null ? state.simStale : stale) ? '（更新中）' : '';
      if (v >= snaps.length) {
        eachView((vw) => vw.setSnapshot(null));
        shown.index = null;
        el.snapVal.textContent = `最終（${snapshotOpCount || snaps.length} 把）` + note;
        return;
      }
      eachView((vw) => vw.setSnapshot(v));
      shown.index = v;   // 廢料判定要算「畫面上那一份」，不是最終那份
      // 作業數超過快照預算時 simulation 只存部分快照，所以序號要看 afterOpIndex，不能用陣列索引。
      const s = snaps[v];
      const opNo = (s && s.afterOpIndex != null ? s.afterOpIndex : v) + 1;
      el.snapVal.textContent = `第 ${opNo} 把${s && s.tool != null ? '（T' + s.tool + '）' : ''}後` + note;
    }

    function currentScenario() {
      if (!state.result) return null;
      return state.result.scenarios[state.scenario] || state.result.scenarios.off || null;
    }

    /** 「刀具」popover 鈕上的數字（勾了幾把／共幾把）：全開時不用點開就知道沒在過濾 */
    function updateToolPopCount() {
      if (!el.toolPopCount) return;
      const boxes = el.toolFilter ? el.toolFilter.querySelectorAll('input[type=checkbox]') : [];
      let on = 0;
      for (const b of boxes) if (b.checked) on++;
      el.toolPopCount.textContent = boxes.length ? `${on}/${boxes.length}` : '';
    }

    function renderToolFilter(table, segments) {
      const used = new Set();
      for (const s of segments) if (s.tool != null) used.add(s.tool);
      const list = (table.tools || []).filter((t) => used.has(t.t)).sort((a, b) => a.t - b.t);
      clearEl(el.toolFilter);
      if (!list.length) {
        const sp = document.createElement('span');
        sp.className = 'nc-muted';
        sp.textContent = '（無）';
        el.toolFilter.appendChild(sp);
        updateToolPopCount();
        return;
      }
      const color = (NC.ui.view2dUtil && NC.ui.view2dUtil.toolColor) ? NC.ui.view2dUtil.toolColor : () => '#888';
      for (const t of list) {
        const lab = document.createElement('label');
        lab.className = 'app-toolchk' + (state.hiddenTools.has(t.t) ? ' is-off' : '');
        lab.title = `T${t.t} ${t.label || ''}`;
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !state.hiddenTools.has(t.t);
        cb.addEventListener('change', () => {
          if (cb.checked) state.hiddenTools.delete(t.t); else state.hiddenTools.add(t.t);
          lab.classList.toggle('is-off', !cb.checked);
          applyVisible();
          updateToolPopCount();
        });
        const swatch = document.createElement('i');
        swatch.style.background = color(t.t);
        const span = document.createElement('span');
        span.textContent = 'T' + t.t;
        lab.appendChild(cb);
        lab.appendChild(swatch);
        lab.appendChild(span);
        el.toolFilter.appendChild(lab);
      }
      updateToolPopCount();
    }

    function applyVisible() {
      const sr = currentScenario();
      const all = new Set();
      if (sr) for (const s of sr.geometry.segments) if (s.tool != null) all.add(s.tool);
      let tools = null;
      if (state.hiddenTools.size) {
        tools = new Set();
        for (const t of all) if (!state.hiddenTools.has(t)) tools.add(t);
      }
      const vis = {
        rapid: el.chkRapid.checked,
        feed: el.chkFeed.checked,
        refReturn: el.chkRef.checked,
        stock: el.chkStock.checked,
        rotary: el.chkRotary.checked,
        tools,
      };
      eachView((v) => v.setVisible(vis));
    }

    // -------------------------------------------------------------------------
    // 廢料判定（切穿之後跟工件分開的料；CONTRACT §5 chunks／§8 setChunks）
    //
    // 判定是對「畫面上那份高度陣列」算的：拉到第 3 把刀之後就算第 3 把刀之後的分塊，
    // 跟視圖顯示的一致。設定（state.scrap）改了只重算分塊、不重跑模擬——高度圖沒變。
    // -------------------------------------------------------------------------
    /** 視圖目前拿到的 SimResult 與快照序號（null＝最終）。跟 view2d/view3d 的 setData／setSnapshot 同步。 */
    const shown = { sim: null, index: null };
    function shownHeights() {
      const sim = shown.sim;
      if (!sim) return null;
      const s = (shown.index != null && Array.isArray(sim.snapshots)) ? sim.snapshots[shown.index] : null;
      return s ? s.height : sim.height;
    }
    /**
     * 目前生效的廢料顯示方式＝工具列 #selScrap 現在選的。網址 scrap= 只設下拉、不碰 viewPref
     *（只影響這一次瀏覽）；使用者自己動下拉才寫進 viewPref 存成長期偏好。沒有下拉（舊 index.html）就看偏好。
     */
    function scrapMode() { return normalizeScrapMode(el.selScrap ? el.selScrap.value : state.viewPref.scrapMode); }

    // 依高度陣列快取分塊結果（鍵＝陣列本身，值帶設定指紋）。拉快照滑桿來回看時不用每次重算；
    // 上限 8 份：每份 labels 是一張 Int32Array（0.17 M 格≈ 0.7 MB），照快照數無限留會吃掉幾十 MB。
    const CHUNK_CACHE_MAX = 8;
    const chunkCache = new Map();
    function chunksFor(sim, arr) {
      if (!sim || !arr) return null;
      // simulation.js 可能還是舊版（分兩個 commit）：沒有 chunks 就當「沒有判定」，其他功能照常
      if (!NC.sim || typeof NC.sim.chunks !== 'function') return null;
      const key = scrapKey(state.scrap);
      const hit = chunkCache.get(arr);
      if (hit && hit.key === key) {
        chunkCache.delete(arr);   // Map 保留插入順序：搬到最後＝最近用過，淘汰時先丟最前面的
        chunkCache.set(arr, hit);
        return hit.result;
      }
      let result = null;
      try {
        result = NC.sim.chunks(sim, arr, state.scrap) || null;
      } catch (e) {
        console.warn('廢料判定失敗，這一份不標：', e);
        result = null;
      }
      chunkCache.set(arr, { key, result });
      while (chunkCache.size > CHUNK_CACHE_MAX) chunkCache.delete(chunkCache.keys().next().value);
      return result;
    }
    /** 視圖只吃算得出來的結果；四軸圓棒的 supported:false 對視圖等於「沒有」（面板另外要它來顯示「尚不支援」） */
    function chunksForView(result) { return (result && result.supported) ? result : null; }

    /**
     * 對畫面上那份高度陣列算分塊，餵給視圖、素材子頁與總覽。回傳 ChunkResult（或 null）。
     * opts.quiet：只餵視圖、不動面板與總覽（applyResult 自己會連同其他欄位一次更新，免得各畫兩次）。
     * opts.panel：'full' = 素材子頁整片更新——設定是 app 這邊改的（視圖上點了記號），面板要拿到新的 marks；
     *             預設只換「目前結果」那三行（setScrapResult）：設定是面板自己改的、或只是換了快照／顯示方式，
     *             整片重畫會把使用者打到一半的數字洗掉、輸入框失焦。
     */
    function applyChunks(opts) {
      opts = opts || {};
      const result = chunksFor(shown.sim, shownHeights());
      state.chunkResult = result;
      const mode = scrapMode();
      // view3d 的 setChunks 可能還沒進來（分兩個 commit），一律守衛
      eachView((v) => { if (typeof v.setChunks === 'function') v.setChunks(chunksForView(result), mode); });
      if (typeof view.setMarks === 'function') view.setMarks(state.scrap.marks || []);
      if (!opts.quiet) {
        const shownResult = withFirstScrap(result);
        if (opts.panel === 'full') {
          stockPanel.update({ scrap: state.scrap, scrapResult: shownResult, markMode: state.markMode, mobile: isMobileLayout(), stockOrigin: state.stockOrigin });
        } else {
          stockPanel.setScrapResult(shownResult);
        }
        rerenderOverview();
      }
      return result;
    }

    // ---- 「第 K 把刀之後切斷」----
    // 逐份掃快照找第一份有廢料的。每份要跑一次 chunks（最多 30 ms），大程式一百多份快照
    // 一口氣掃會卡住畫面幾秒，所以切成 12 ms 的片段排在 setTimeout(0) 裡，掃完再補進素材子頁。
    // 以 SimResult 為鍵快取（同一份模擬只掃一次；設定改了指紋不同就重掃）。
    const firstScrapCache = new WeakMap();   // SimResult → { key, text, done }
    function withFirstScrap(result) {
      if (!result) return null;
      return Object.assign({}, result, { firstScrapText: firstScrapTextFor(shown.sim) });
    }
    function firstScrapTextFor(sim) {
      if (!sim || sim.cylinder || !NC.sim || typeof NC.sim.chunks !== 'function') return '';
      const key = scrapKey(state.scrap);
      const c = firstScrapCache.get(sim);
      if (c && c.key === key) return c.done ? c.text : '';
      // 最終結果都沒有廢料就不必掃：中途曾經分開、最後又被削光的情況少見，而且面板也不會顯示這句
      const final = chunksFor(sim, sim.height);
      if (!final || !final.supported || !(final.scrapCount > 0)) {
        firstScrapCache.set(sim, { key, text: '', done: true });
        return '';
      }
      const entry = { key, text: '', done: false };
      firstScrapCache.set(sim, entry);
      scheduleFirstScrapScan(sim, entry);
      return '';
    }
    function scheduleFirstScrapScan(sim, entry) {
      const snaps = Array.isArray(sim.snapshots) ? sim.snapshots : [];
      const scrap = state.scrap;   // 掃到一半設定變了 → entry 會被換掉，下面的守衛會停
      let i = 0;
      const finish = (afterOp, tool) => {
        const ops = (overviewArgs && overviewArgs.run && overviewArgs.run.ops) || [];
        // 沒有任何快照有廢料＝最後一把刀切斷的（最終高度有、快照裡都沒有）
        const k = afterOp != null ? afterOp + 1 : ops.length;
        const t = afterOp != null ? tool : (ops.length ? ops[ops.length - 1].tool : null);
        entry.text = k > 0 ? `第 ${k} 把刀${t != null ? '（T' + t + '）' : ''}之後切斷` : '';
        entry.done = true;
        // 這份模擬還在畫面上才補進面板；換掉了就留在快取裡等它回來。
        // 只換結果那三行——掃完的時候使用者可能正在改門檻，整片重畫會把他打到一半的數字洗掉
        if (shown.sim === sim && state.chunkResult) {
          stockPanel.setScrapResult(withFirstScrap(state.chunkResult));
        }
      };
      const step = () => {
        if (firstScrapCache.get(sim) !== entry || shown.sim !== sim) return;   // 過時了，白掃
        const t0 = nowMs();
        while (i < snaps.length) {
          const s = snaps[i];
          let r = null;
          try { r = NC.sim.chunks(sim, s.height, scrap); } catch (e) { r = null; }
          // 「切斷」＝工件與廢料都有。只看 scrapCount 的話，使用者對唯一的一塊點了 ✕、再拉到切穿之前，
          // 那一整塊都是廢料（partCount 0），會被報成「第 1 把刀之後切斷」——其實什麼都還沒切開。
          if (r && r.supported && r.scrapCount > 0 && r.partCount > 0) { finish(s.afterOpIndex == null ? i : s.afterOpIndex, s.tool); return; }
          i++;
          if (nowMs() - t0 > 12) { setTimeout(step, 0); return; }
        }
        finish(null, null);
      };
      setTimeout(step, 0);
    }

    /**
     * 進入／離開標記模式。桌機：俯視圖游標變十字，點一下回 onMark；手機：人在 Project 頁看不到視圖，
     * 靠素材子頁的迷你預覽點（panels 自己處理），視圖也一併設了，無害。
     */
    function setMarkMode(kind) {
      state.markMode = (kind === 'part' || kind === 'scrap') ? kind : null;
      if (typeof view.setMarkMode === 'function') view.setMarkMode(state.markMode);
      stockPanel.setMarkMode(state.markMode);   // 只更新按鈕與提示，不整片重畫
    }

    // -------------------------------------------------------------------------
    // 選取同步
    // -------------------------------------------------------------------------
    function showModalFor(line) {
      const eb = line > 0 ? state.execByLine[line] : null;
      const blocks = state.result ? state.result.tok.blocks : null;
      const b = (blocks && line > 0) ? blocks[line - 1] : null;
      el.modalLineLabel.textContent = line > 0 ? `第 ${line} 行` : '';
      renderMiniModal(line, eb);
      if (!eb) { modalPanel.update(null, null); return; }
      modalPanel.update(eb.after, {
        line,
        text: b ? (b.text || b.raw) : '',
        comment: b ? b.comment : null,
        opIndex: eb.opIndex,
        skipped: eb.skipped,
        ignored: eb.ignored,
      });
    }

    /**
     * 編輯器底下那一行：游標行執行後的模態摘要。
     * 完整的模態面板搬到下方狀態條的「游標行」分頁之後，人在看錯誤清單時就看不到它了；
     * 這一行把最常要對的幾樣（G 群組、F/S/M、主軸上的刀、位置）留在編輯器旁邊，點了切到完整版。
     */
    function renderMiniModal(line, eb) {
      const host = el.miniModal;
      if (!host) return;
      clearEl(host);
      if (!eb) {
        host.classList.add('is-empty');
        host.textContent = line > 0 ? `第 ${line} 行：尚無執行資訊` : '游標所在行執行後的模態會顯示在這裡';
        return;
      }
      host.classList.remove('is-empty');
      const st = eb.after;
      const sp = st.spindle || {};
      const seg = (text, cls) => {
        const x = document.createElement('span');
        if (cls) x.className = cls;
        x.textContent = text;
        host.appendChild(x);
      };
      const sep = () => seg('·', 'app-mini-modal__sep');
      seg('L' + line, 'app-mini-modal__line');
      if (eb.skipped) { sep(); seg('此情境跳過', 'nc-warn'); }
      if (eb.ignored) { sep(); seg('多斜線忽略', 'nc-warn'); }
      const g = [st.motion || '—', st.distance, st.wcs];
      if (st.comp && st.comp !== 'G40') g.push(st.comp + (st.d ? 'D' + st.d : ''));
      if (st.lengthComp && st.lengthComp !== 'G49') g.push(st.lengthComp + (st.h ? 'H' + st.h : ''));
      if (st.cycle) g.push(st.cycle.code);
      sep(); seg(g.filter(Boolean).join(' '));
      sep();
      seg(st.feed == null ? 'F—' : 'F' + fmt(st.feed), st.feed == null ? 'nc-warn' : '');
      seg(' ');
      seg((sp.dir || 'M5') + (sp.rpm != null ? ' S' + fmt(sp.rpm) : ''), sp.dir === 'M5' || !sp.dir ? 'nc-warn' : '');
      if (st.coolant) seg(' M8');
      sep();
      seg('T' + (st.toolInSpindle != null ? st.toolInSpindle : '—') + (st.toolStaged != null ? '（預選 T' + st.toolStaged + '）' : ''));
      sep();
      let pos = `X${fmt(st.pos.x)} Y${fmt(st.pos.y)} Z${fmt(st.pos.z)}`;
      if (typeof st.a === 'number' && Math.abs(st.a) > 1e-9) pos += ` A${fmt(st.a)}`;
      seg(pos, 'nc-active');
    }

    function selectLine(line, opts) {
      opts = opts || {};
      state.selectedLine = line;
      editor.highlightLine(line);
      eachView((v) => v.highlightLine(line));
      showModalFor(line);
      // 從視圖／錯誤清單／作業摘要跳過來的：左欄要在「程式」頁才看得到那一行
      if (opts.scroll) selectProjectTab('program');
      if (opts.scroll) editor.scrollToLine(line, { center: true });
      // 作業表跟著選
      const sr = currentScenario();
      if (sr && opsPanel) {
        const eb = state.execByLine[line];
        if (eb && eb.opIndex >= 0) opsPanel.select(eb.opIndex);
      }
    }

    function jumpToLine(line, opts) {
      if (!(line > 0)) return;
      selectLine(line, { scroll: true });
      // 手機版：從錯誤清單／作業摘要點行號時人在「狀態」頁，要切回 Project 頁才看得到那一行；
      // 也不搶 focus——手機上 focus 會彈出鍵盤，把半個畫面吃掉
      if (isMobileLayout()) selectMobileView('project');
      else editor.focus();
    }

    function applyFix(item) {
      if (!item || !item.fix || !Array.isArray(item.fix.edits)) return;
      const edits = item.fix.edits.slice().sort((a, b) => b.line - a.line);
      for (const e of edits) editor.replaceLines(e.line, e.line, e.text);
      setStatus('已套用修正：' + (item.fix.label || item.ruleId));
    }

    // -------------------------------------------------------------------------
    // 載入程式
    // -------------------------------------------------------------------------
    /**
     * 範例附的素材（samples.js 的 stock，來自 samples/<name>.stock.json）→ 正準 stock；沒有或不合法就 null（＝推估）。
     * 為什麼範例要附素材：推估素材的底面故意比最深切削低 5 mm（tools.STOCK_Z_MARGIN），推估下永遠不會「切穿」，
     * demo-cutout 要示範外框變廢料就非得知道板厚。不寫進 localStorage——沒動過的範例不留痕跡
     *（stockOrigin 'sample'；只調廢料設定也只存 { scrap }）；使用者改了素材的任何一格才變成 'user' 存起來。
     */
    function defaultStockOf(defaults) {
      const o = defaults && defaults.stock;
      if (!o || !o.spec || !NC.analysis || typeof NC.analysis.stockFromSpec !== 'function') return null;
      return NC.analysis.stockFromSpec(o.spec, o.fixtures) || null;
    }

    /** @param {{stock?:{spec:Object, fixtures?:Object[]}}} [defaults]  沒存過時的預設（目前只有範例附的素材） */
    function loadProgram(text, fileName, note, defaults) {
      state.text = String(text == null ? '' : text);
      state.fileName = fileName || '';
      state.hiddenTools.clear();
      state.stock = null;
      state.stockOrigin = null;
      state.sampleDeclined = false;
      state.rotary = null;   // 第四軸裝夾參數跟著程式走；換程式先清掉，稍後依 programKey 讀回
      state.selectedLine = 0;
      sectionTouched = false;
      // 換程式＝換一塊料：記號是點在上一塊料上的，一起清掉；標記到一半也直接取消
      state.markMode = null;
      if (typeof view.setMarkMode === 'function') view.setMarkMode(null);

      let tok = null;
      try { tok = NC.tokenize(state.text); } catch (e) { tok = null; }
      state.programKey = programKeyOf(tok, state.fileName);
      state.rotary = loadRotary(state.programKey);
      // 素材：存過的優先（'user'）；沒存過、也沒對這支範例按過「回到推估」才套範例附的（'sample'）；否則推估
      state.sampleDeclined = loadSampleDeclined(state.programKey);
      const savedStock = loadStock(state.programKey);
      const sampleStock = (!savedStock && !state.sampleDeclined) ? defaultStockOf(defaults) : null;
      state.stock = savedStock || sampleStock || null;
      state.stockOrigin = savedStock ? 'user' : (sampleStock ? 'sample' : null);
      state.scrap = loadScrap(state.programKey) || defaultScrap();
      state.userTable = NC.tools.load(state.programKey) || null;

      el.fileLabel.textContent = (state.fileName || state.programKey) + (note ? ' · ' + note : '');
      el.fileLabel.title = el.fileLabel.textContent;
      editor.setText(state.text);
      refresh();
    }

    function loadSample(id) {
      const s = findSample(id);
      if (!s) { setStatus('找不到範例：' + id); return false; }
      el.selSample.value = sampleId(s);
      // 範例可以附素材（demo-cutout 的 120×80×10 板）：使用者存過的優先，沒存過才用範例附的
      loadProgram(s.text, s.name, '內建範例', { stock: s.stock || null });
      return true;
    }

    /** 讀成文字（先 UTF-8、失敗改 Big5）。優先用 Blob.arrayBuffer()，沒有才退回 FileReader。 */
    function readFile(file) {
      return new Promise((resolve, reject) => {
        const done = (buf) => { try { resolve(decodeBytes(buf)); } catch (e) { reject(e); } };
        if (typeof file.arrayBuffer === 'function') { file.arrayBuffer().then(done).catch(reject); return; }
        const reader = new FileReader();
        reader.onload = () => done(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(file);
      });
    }

    /**
     * 開檔的總入口。同一個入口要接兩種東西：NC 程式與刀具表 CSV。
     * 先看副檔名，副檔名被改掉時再看第一列的欄名（現場的檔名常常沒有副檔名）。
     */
    /**
     * 素材檔（<名字>.stock.json，格式同 samples/<name>.stock.json：{spec, fixtures?}）拖進來就當成使用者設定的素材，
     * 跟在素材頁手動填一樣：存 localStorage、換 O 號跟著搬。給 DWG→NC 這類外部產生器用，程式、刀具表、素材三個檔各自拖。
     */
    function importStockJSON(text, fileName) {
      let o = null;
      try { o = JSON.parse(String(text).replace(/^﻿/, '')); } catch (e) { setStatus('素材檔不是合法的 JSON：' + fileName); return false; }
      const spec = (o && o.spec) ? o.spec : o;
      let s = null;
      try { s = NC.analysis.stockFromSpec(spec, (o && o.fixtures) || []); } catch (e) { s = null; }
      if (!s || !s.spec) { setStatus('素材檔格式不對（要有 spec.shape／size／anchor）：' + fileName); return false; }
      state.stock = s;
      state.stockOrigin = 'user';
      persistStock();
      syncRotaryFromStock(s);
      refresh();
      setStatus('已套用素材 ' + fileName + '：' + P.logic.stockSummaryText(s));
      return true;
    }

    function openFile(file) {
      if (!file) return;
      readFile(file).then((r) => {
        if (/\.stock\.json$/i.test(file.name)) { importStockJSON(r.text, file.name); return; }
        if (P.logic.looksLikeToolCSV(file.name, r.text)) { importToolCSV(r.text, file.name); return; }
        el.selSample.value = '';
        loadProgram(r.text, file.name, r.encoding);
      }).catch((e) => setStatus('讀檔失敗：' + file.name + (e && e.message ? '（' + e.message + '）' : '')));
    }

    // -------------------------------------------------------------------------
    // 事件接線
    // -------------------------------------------------------------------------
    editor.onChange((text) => {
      state.text = text;
      refresh();
    });
    editor.onCursorLine((line) => {
      state.selectedLine = line;
      editor.highlightLine(line);
      eachView((v) => v.highlightLine(line));
      showModalFor(line);
    });
    view.onPick((line) => {
      if (!(line > 0)) return;
      selectLine(line, { scroll: true });
    });

    el.btnOpen.addEventListener('click', () => el.fileInput.click());
    el.fileInput.addEventListener('change', () => {
      if (el.fileInput.files && el.fileInput.files[0]) openFile(el.fileInput.files[0]);
      el.fileInput.value = '';
    });

    el.selSample.addEventListener('change', () => {
      if (el.selSample.value) loadSample(el.selSample.value);
    });

    el.btnSave.addEventListener('click', () => {
      if (!state.text) { setStatus('沒有內容可以存'); return; }
      downloadText(state.fileName || (state.programKey + '.nc'), editor.getText());
      setStatus('已下載 ' + (state.fileName || state.programKey));
    });

    el.btnCopy.addEventListener('click', async () => {
      const ok = await copyText(editor.getText());
      setStatus(ok ? '已複製到剪貼簿' : '複製失敗（瀏覽器不允許）');
    });

    el.selScenario.addEventListener('change', () => {
      state.scenario = el.selScenario.value;
      settingsPanel.update({ settings: state.settings, scenario: state.scenario, cell: state.cell, rotaryUsed: rotaryUsedNow() });
      persistSettings();
      refresh();
    });

    function setViewMode(mode) {
      if (mode === '3d') {
        const v3 = ensureView3D();
        if (!v3) {
          el.btnMode3d.disabled = true;
          el.btnMode3d.title = ui.view3d && ui.view3d.isSupported && !ui.view3d.isSupported()
            ? '這個瀏覽器／裝置開不了 WebGL，3D 視圖不能用（俯視與剖面照常）'
            : '3D 視圖初始化失敗，請改用俯視或剖面';
          setStatus2('3D 視圖不能用：' + el.btnMode3d.title);
          return false;
        }
      }
      let hit = false;
      for (const b of document.querySelectorAll('.app-seg__btn')) {
        const on = b.dataset.mode === mode;
        if (on) hit = true;
        b.classList.toggle('is-on', on);
      }
      if (!hit) return false;
      viewMode = mode;
      el.rngSection.disabled = !sectionMode() || !state.result;
      // 手機版收合時剖面滑桿只在剖面模式出現（app.css 靠這個 class 切）
      if (el.viewTools) el.viewTools.classList.toggle('is-section', sectionMode());
      if (mode !== '3d') {
        view.setMode(mode);
        if (state.result) syncSectionRange(state.result.stock);
      }
      applyViewLayout({ fit3d: true });
      return true;
    }

    /**
     * 依「目前模式 + 並排開關」決定左右兩塊誰出現。
     *
     * 並排的重點是右邊那張 3D 會跟著左邊的剖面滑桿動：拉滑桿的時候，
     * 3D 上會出現一片橘色的剖面，開了「3D 剖切」還會把擋住斷面的那半邊切掉——
     * 左邊那張斷面圖到底是從哪裡切下來的，這樣一眼就對得起來。
     * 3D 模式本身不並排（左邊沒有東西好放），展開圖也不並排（那不是剖面）。
     */
    function applyViewLayout(opts) {
      opts = opts || {};
      const is3d = viewMode === '3d';
      const want = !is3d && state.viewPref.split;
      const v3 = (is3d || want) ? ensureView3D() : view3d;
      const show3d = is3d || (want && !!v3);
      const split = !is3d && show3d;
      show(el.viewHost, !is3d);
      show(el.view3dHost, show3d);
      if (el.viewSplit) {
        el.viewSplit.classList.toggle('is-split', split);
        el.viewSplit.style.setProperty('--view-split', (state.viewPref.ratio * 100).toFixed(2) + '%');
      }
      // WebGL 開不起來就沒有右半邊可以並排，勾了也沒用——直接把開關關掉並說明原因
      if (want && !v3) {
        el.chkSplit.checked = false;
        el.chkSplit.disabled = true;
        el.lblSplit.title = '這個瀏覽器／裝置開不了 WebGL，沒有 3D 可以並排';
      }
      show(el.lblClip, split && sectionMode());
      show(el.btnClipFlip, split && sectionMode() && state.viewPref.clip);
      if (show3d && v3) {
        // 只有剛建好的才補餵資料——setData 會整組重建網格，每按一次模式鈕就重建太貴了
        // （平常的資料更新走 refresh() 的 eachView）
        if (view3dFresh) feedView3D();
        v3.resize();
        if (opts.fit3d && is3d) v3.fit();
      }
      syncSection3D();
    }

    /** 把左邊那張剖面的位置轉成 3D 的剖面平面；不是剖面模式就整組關掉 */
    function syncSection3D() {
      if (!view3d) return;
      // 區域變數不叫 shown：外層有同名的「畫面上那份高度陣列」物件，撞名會看錯
      const visible3d = el.view3dHost && !el.view3dHost.classList.contains('nc-hidden');
      const on = sectionMode() && visible3d;
      view3d.setSection(on
        ? {
          axis: viewMode === 'sectionX' ? 'x' : 'y',
          value: Number(el.rngSection.value),
          clip: state.viewPref.clip,
          flip: state.viewPref.clipFlip,
        }
        : { axis: null });
    }

    /** 3D 視圖剛建立時補餵目前的資料 */
    function feedView3D() {
      if (!view3d || !state.result) return;
      const sr = currentScenario();
      if (!sr) return;
      view3dFresh = false;
      const sim = sr.sim || state.simCache[state.scenario] || null;
      view3d.setData({
        segments: sr.geometry.segments,
        sim,
        stock: state.result.stock,
        toolTable: state.result.toolTable,
        scenario: state.scenario,
        rotary: rotaryOptOf(sr.run),
      });
      // 2D 正在看某個快照的話 3D 也要看同一份，廢料的標籤才會跟高度對得上（同一份陣列）
      if (shown.sim === sim && shown.index != null) view3d.setSnapshot(shown.index);
      if (typeof view3d.setChunks === 'function') view3d.setChunks(chunksForView(state.chunkResult), scrapMode());
      applyVisible();
    }

    /** 只寫狀態列文字，不動 statusBase（暫時性的提示） */
    function setStatus2(text) { el.statusText.textContent = text; }
    for (const btn of document.querySelectorAll('.app-seg__btn')) {
      btn.addEventListener('click', () => setViewMode(btn.dataset.mode));
    }
    el.rngSection.addEventListener('input', () => {
      sectionTouched = true;
      const v = Number(el.rngSection.value);
      view.setSection(v);
      el.secVal.textContent = (view.getMode() === 'sectionY' ? 'Y' : 'X') + fmt(v, 2);
      syncSection3D();
    });
    el.chkSplit.addEventListener('change', () => {
      state.viewPref.split = el.chkSplit.checked;
      persistSettings();
      applyViewLayout({ fit3d: true });
    });
    el.chkClip.addEventListener('change', () => {
      state.viewPref.clip = el.chkClip.checked;
      persistSettings();
      show(el.btnClipFlip, el.chkClip.checked && sectionMode() && !el.view3dHost.classList.contains('nc-hidden'));
      syncSection3D();
    });
    // 剖切方向刻意不自動判斷——跟相機或跟剖面位置自己換邊，換的那一瞬間會讓人認不出
    // 自己在看哪一面（現場兩種都回報過）。要換就由使用者按。
    el.btnClipFlip.addEventListener('click', () => {
      state.viewPref.clipFlip = !state.viewPref.clipFlip;
      persistSettings();
      syncSection3D();
    });
    el.btnFit.addEventListener('click', () => {
      if (viewMode !== '3d') view.fit();
      if (view3d && el.view3dHost && !el.view3dHost.classList.contains('nc-hidden')) view3d.fit();
    });

    // ---- 並排時中間那條分隔線可以拖 ----
    (function initSplitDrag() {
      const bar = el.viewSplitBar;
      if (!bar || !el.viewSplit || typeof bar.addEventListener !== 'function') return;
      let dragging = false;
      const ratioAt = (clientX) => {
        const r = el.viewSplit.getBoundingClientRect();
        if (!(r.width > 0)) return state.viewPref.ratio;
        return Math.min(0.82, Math.max(0.18, (clientX - r.left) / r.width));
      };
      const setRatio = (v) => {
        state.viewPref.ratio = v;
        el.viewSplit.style.setProperty('--view-split', (v * 100).toFixed(2) + '%');
      };
      bar.addEventListener('pointerdown', (ev) => {
        dragging = true;
        bar.classList.add('is-dragging');
        if (ev.pointerId != null && bar.setPointerCapture) { try { bar.setPointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ } }
        if (ev.preventDefault) ev.preventDefault();
      });
      bar.addEventListener('pointermove', (ev) => { if (dragging) setRatio(ratioAt(ev.clientX)); });
      const stop = () => {
        if (!dragging) return;
        dragging = false;
        bar.classList.remove('is-dragging');
        persistSettings();
        // canvas 的像素尺寸靠各自的 ResizeObserver 跟上，這裡再踢一次確保放手後立刻對齊
        view.render();
        if (view3d) view3d.resize();
      };
      bar.addEventListener('pointerup', stop);
      bar.addEventListener('pointercancel', stop);
      bar.addEventListener('dblclick', () => { setRatio(0.5); persistSettings(); if (view3d) view3d.resize(); });
    })();
    // ---- 左右／上下分隔線可拖（比例存進偏好） ----
    function afterPaneResize() {
      // canvas 的像素尺寸靠各自的 ResizeObserver 跟上，這裡再踢一次確保放手後立刻對齊
      view.render();
      if (view3d) view3d.resize();
    }
    function initPaneSplit(bar, opts) {
      if (!bar || typeof bar.addEventListener !== 'function') return;
      let dragging = false;
      const apply = (v) => {
        opts.set(v);
        document.documentElement.style.setProperty(opts.cssVar, (v * 100).toFixed(2) + '%');
      };
      bar.addEventListener('pointerdown', (ev) => {
        dragging = true;
        bar.classList.add('is-dragging');
        el.app.classList.add('is-resizing');
        if (ev.pointerId != null && bar.setPointerCapture) { try { bar.setPointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ } }
        if (ev.preventDefault) ev.preventDefault();
      });
      bar.addEventListener('pointermove', (ev) => { if (dragging) apply(opts.ratioAt(ev)); });
      const stop = () => {
        if (!dragging) return;
        dragging = false;
        bar.classList.remove('is-dragging');
        el.app.classList.remove('is-resizing');
        persistSettings();
        afterPaneResize();
      };
      bar.addEventListener('pointerup', stop);
      bar.addEventListener('pointercancel', stop);
      bar.addEventListener('dblclick', () => { apply(opts.reset); persistSettings(); afterPaneResize(); });
      apply(opts.get());
    }
    // 左欄 Project 的寬度：預設一半，可拖到 30%～72%（刀具表欄位多，要拉寬時有得拉）
    initPaneSplit(el.colSplit, {
      cssVar: '--app-left-w', reset: 0.5,
      get: () => state.viewPref.leftRatio,
      set: (v) => { state.viewPref.leftRatio = v; },
      ratioAt: (ev) => {
        // flex-basis 的百分比是對主體的內容寬算的，要把 padding 扣掉
        const m = el.appMain;
        const r = m ? m.getBoundingClientRect() : null;
        if (!r || !(r.width > 0)) return state.viewPref.leftRatio;
        const cs = getComputedStyle(m);
        const pl = parseFloat(cs.paddingLeft) || 0, pr = parseFloat(cs.paddingRight) || 0;
        const w = r.width - pl - pr;
        return w > 0 ? U.clamp((ev.clientX - r.left - pl) / w, 0.3, 0.72) : state.viewPref.leftRatio;
      },
    });
    // 右欄下方狀態條的高度（佔右欄）：預設 30%，可拖到 12%～60%
    initPaneSplit(el.rowSplit, {
      cssVar: '--app-status-h', reset: 0.3,
      get: () => state.viewPref.statusRatio,
      set: (v) => { state.viewPref.statusRatio = v; },
      ratioAt: (ev) => {
        const r = el.appRight ? el.appRight.getBoundingClientRect() : null;
        return (r && r.height > 0) ? U.clamp(1 - (ev.clientY - r.top) / r.height, 0.12, 0.6) : state.viewPref.statusRatio;
      },
    });

    // ---- Project 子頁的入口 ----
    /** 切到左欄的某個子頁（手機版順便切到 Project 頁）。key 同總覽列的 key：program/stock/tools/mag/machine */
    function openProjectPage(key) {
      if (!selectProjectTab(key)) return false;
      if (isMobileLayout()) selectMobileView('project');
      else if (key === 'program') editor.focus();
      return true;
    }
    /** 舊名字：以前是全螢幕設定頁，現在就是素材子頁（URL hash setup=1 仍然接受） */
    function openSetup() { return openProjectPage('stock'); }
    el.rotaryBanner.addEventListener('click', () => { selectTab('diag'); if (isMobileLayout()) selectMobileView('status'); });
    // 編輯器底下那一行摘要 → 完整的模態面板
    if (el.miniModal) el.miniModal.addEventListener('click', () => { selectTab('modal'); if (isMobileLayout()) selectMobileView('status'); });
    el.rngSnapshot.addEventListener('input', () => {
      const v = Number(el.rngSnapshot.value);
      const sim = currentScenario() && currentScenario().sim;
      const snaps = (sim && sim.snapshots) || [];
      snapshotTouched = true;
      // 記「第幾把刀之後」而不是陣列索引：作業數超過快照預算時快照是抽樣的
      snapshotAfterOp = (v >= snaps.length || !snaps[v]) ? null
        : (snaps[v].afterOpIndex == null ? v : snaps[v].afterOpIndex);
      applySnapshot(v);
      applyChunks();   // 換了一份高度陣列，廢料要對那一份重算（有快取，拉滑桿不會卡）
    });
    for (const c of [el.chkRapid, el.chkFeed, el.chkRef, el.chkStock, el.chkRotary]) c.addEventListener('change', applyVisible);
    // 廢料顯示開關：只是「怎麼看」，分塊結果不用重算，餵視圖換個 mode 就好。
    // 只有這裡（使用者自己動下拉）才寫進 viewPref 存成長期偏好；網址 scrap= 只設下拉、不存
    if (el.selScrap) {
      el.selScrap.addEventListener('change', () => {
        state.viewPref.scrapMode = normalizeScrapMode(el.selScrap.value);
        persistSettings();
        applyChunks();
      });
    }
    // 標記模式：在俯視圖點一下 → 記號進 state.scrap.marks → 重算。點完就離開標記模式，
    // 不然使用者接下來想點路徑看行號，會一直被當成在標記。
    if (typeof view.onMark === 'function') {
      view.onMark((x, y, kind) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        // 記號要落在素材的 XY 範圍內（含邊）：素材外沒有料，點了也沒有東西可標。留在標記模式讓人再點一次
        const st = (state.result && state.result.stock) || state.stock;
        if (!markInStock(st, x, y)) { setStatus2(MARK_OUT_OF_STOCK); return; }
        const marks = Array.isArray(state.scrap.marks) ? state.scrap.marks.slice() : [];
        marks.push({ x: roundMark(x), y: roundMark(y), kind: kind === 'scrap' ? 'scrap' : 'part' });
        state.scrap = normalizeScrap(Object.assign({}, state.scrap, { marks }));
        state.markMode = null;
        if (typeof view.setMarkMode === 'function') view.setMarkMode(null);
        persistStock();
        applyChunks({ panel: 'full' });   // 記號是 app 這邊加的：面板要整片拿到新的 marks（markMode:null 一起）
      });
    }
    // Esc 離開標記模式（按了「＋ 標工件」又反悔，不必再按一次）
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && state.markMode) setMarkMode(null);
    });

    // 下方狀態條的分頁（總覽／游標行／作業摘要／錯誤清單）
    function selectTab(name) {
      let hit = false;
      for (const t of document.querySelectorAll('.app-tab[data-tab]')) {
        const on = t.dataset.tab === name;
        if (on) hit = true;
        t.classList.toggle('is-on', on);
      }
      if (!hit) return false;
      for (const body of document.querySelectorAll('.app-tab-body[data-panel]')) {
        body.classList.toggle('nc-hidden', body.dataset.panel !== name);
      }
      return true;
    }
    for (const tab of document.querySelectorAll('.app-tab[data-tab]')) {
      tab.addEventListener('click', () => selectTab(tab.dataset.tab));
    }
    // 左欄 Project 的子頁（程式／素材／刀具表／刀庫／機台）。舊名字照收，分享出去的連結不會壞。
    const PTAB_ALIAS = { editor: 'program', settings: 'machine', setup: 'stock', magazine: 'mag' };
    function selectProjectTab(name) {
      name = PTAB_ALIAS[name] || name;
      let hit = false;
      for (const t of document.querySelectorAll('.app-tab[data-ptab]')) {
        const on = t.dataset.ptab === name;
        if (on) hit = true;
        t.classList.toggle('is-on', on);
      }
      if (!hit) return false;
      for (const body of document.querySelectorAll('.app-ptab[data-ppanel]')) {
        body.classList.toggle('nc-hidden', body.dataset.ppanel !== name);
      }
      return true;
    }
    for (const tab of document.querySelectorAll('.app-tab[data-ptab]')) {
      tab.addEventListener('click', () => selectProjectTab(tab.dataset.ptab));
    }
    /** 網址 tab= 參數：先試狀態條，再試 Project 子頁（舊連結的 tools／stock／mag 都還能用）。回傳落在哪一區。 */
    function selectAnyTab(name) {
      if (selectTab(name)) return 'status';
      if (selectProjectTab(name)) return 'project';
      return null;
    }

    // ---- 手機版底部導覽 ----
    // 桌機上 CSS 把導覽藏起來、data-mview 也沒有任何規則吃它，這段等於沒作用。
    function selectMobileView(name) {
      if (!el.app) return;
      el.app.dataset.mview = name;
      for (const b of document.querySelectorAll('.app-mnav__btn')) {
        b.classList.toggle('is-on', b.dataset.mview === name);
      }
      if (name === 'view') {
        // 剛從 display:none 放出來的 canvas 尺寸還是 0；ResizeObserver 會跟上，
        // 這裡再踢一次讓它馬上畫，不要閃一下空白
        view.requestRender();
        if (view3d) view3d.resize();
      }
    }
    for (const b of document.querySelectorAll('.app-mnav__btn')) {
      b.addEventListener('click', () => selectMobileView(b.dataset.mview));
    }
    // 手機版的兩顆收合鈕：頂列 ☰（開檔那些）與視圖「選項」。桌機 CSS 直接把鈕藏起來，
    // is-open 也沒有規則吃它，所以桌機不受影響。
    function wireCollapse(btn, host) {
      if (!btn || !host || typeof btn.addEventListener !== 'function') return;
      btn.addEventListener('click', () => {
        const on = host.classList.toggle('is-open');
        btn.classList.toggle('is-on', on);
        btn.setAttribute('aria-expanded', on ? 'true' : 'false');
      });
    }
    wireCollapse(el.btnBarMore, document.querySelector('.app-bar'));
    wireCollapse(el.btnViewMore, el.viewTools);

    // ---- 圖層／刀具 popover ----
    // 點鈕開關；點外面（#popBackdrop：桌機透明、手機是半透明遮罩）或 Esc 關。一次只開一個。
    const POPOVERS = [[el.btnLayers, el.popLayers], [el.btnToolsPop, el.popTools]];
    function setPopover(btn, pop, on) {
      if (!btn || !pop) return;
      pop.classList.toggle('nc-hidden', !on);
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-expanded', on ? 'true' : 'false');
    }
    function closePopovers() {
      for (const [b, p] of POPOVERS) setPopover(b, p, false);
      if (el.popBackdrop) el.popBackdrop.classList.add('nc-hidden');
    }
    for (const [btn, pop] of POPOVERS) {
      if (!btn || !pop) continue;
      btn.addEventListener('click', () => {
        const wantOpen = pop.classList.contains('nc-hidden');
        closePopovers();
        if (wantOpen) {
          setPopover(btn, pop, true);
          if (el.popBackdrop) el.popBackdrop.classList.remove('nc-hidden');
        }
      });
    }
    if (el.popBackdrop) el.popBackdrop.addEventListener('click', closePopovers);
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closePopovers(); });

    // ---- 鍵盤快捷鍵 ----
    // 1~5 切視圖、F 全覽、? 快捷鍵一覽；Ctrl+O／Ctrl+S 開檔存檔（打字中也吃，蓋掉瀏覽器預設）。
    // 其餘單鍵在打字中（input/textarea/select）不作用，免得在編輯器打數字變成切視圖。
    const VIEW_MODE_KEYS = { 1: 'top', 2: 'sectionX', 3: 'sectionY', 4: '3d', 5: 'unroll' };
    function isTyping(ev) {
      const t = ev.target;
      const tag = t && t.tagName ? t.tagName.toLowerCase() : '';
      return tag === 'input' || tag === 'textarea' || tag === 'select' || (t && t.isContentEditable);
    }
    function showKbdHelp(on) {
      if (el.kbdHelp) el.kbdHelp.classList.toggle('nc-hidden', !on);
    }
    if (el.kbdHelp) el.kbdHelp.addEventListener('click', () => showKbdHelp(false));

    // ---- 關於（點頂列標題開，點任何地方或 Esc 關）----
    // 信箱不寫在 HTML 裡、在這裡組出來：線上版是公開的 GitHub Pages，
    // 明碼的 mailto 會被爬蟲抓去寄垃圾信。畫面與掃碼的效果一樣，爬蟲抓不到。
    function reportMailto() {
      const ver = NC.VERSION || '（不明）';
      const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '（不明）';
      const body = `發生什麼事：

怎麼重現（哪一支程式、按了什麼、第幾行）：

版本：${ver}
瀏覽器：${ua}

—— 不用附整支加工程式，貼出出問題的那幾行就好。
`;
      return 'mailto:' + REPORT_MAIL + '?subject=' + encodeURIComponent('銑床預演台 問題回報 · ' + ver)
        + '&body=' + encodeURIComponent(body);
    }
    function showAbout(on) {
      if (!el.aboutBox) return;
      if (on) {
        if (el.aboutVer) el.aboutVer.textContent = '版本 ' + (NC.VERSION || '—');
        if (el.aboutMail) {
          el.aboutMail.textContent = REPORT_MAIL;
          el.aboutMail.href = reportMailto();
        }
      }
      el.aboutBox.classList.toggle('nc-hidden', !on);
    }
    for (const b of [el.btnAbout, el.btnAboutTitle]) {
      if (b) b.addEventListener('click', () => showAbout(true));
    }
    if (el.btnAboutClose) el.btnAboutClose.addEventListener('click', () => showAbout(false));
    if (el.aboutBox) {
      // 只有點到遮罩本身（方框外面）才關。點方框裡面不關——信箱、網址這些
      // 是要讓人選取複製的，點一下就收起來會很難用。
      el.aboutBox.addEventListener('click', (ev) => { if (ev.target === el.aboutBox) showAbout(false); });
    }
    document.addEventListener('keydown', (ev) => {
      if (ev.ctrlKey && !ev.altKey && !ev.shiftKey && !ev.metaKey) {
        const k = ev.key.toLowerCase();
        if (k === 'o') { ev.preventDefault(); el.btnOpen.click(); }
        else if (k === 's') { ev.preventDefault(); el.btnSave.click(); }
        return;
      }
      if (ev.ctrlKey || ev.altKey || ev.metaKey || isTyping(ev)) return;
      if (ev.key === 'Escape') { showKbdHelp(false); showAbout(false); return; }
      if (VIEW_MODE_KEYS[ev.key]) {
        const b = document.querySelector(`.app-seg__btn[data-mode="${VIEW_MODE_KEYS[ev.key]}"]`);
        if (b && !b.disabled) b.click();
      } else if (ev.key === 'f' || ev.key === 'F') {
        el.btnFit.click();
      } else if (ev.key === '?') {
        showKbdHelp(el.kbdHelp && el.kbdHelp.classList.contains('nc-hidden'));
      }
    });

    // 整頁拖放（只接檔案；在編輯器內拖曳文字不受影響）
    function dragHasFiles(ev) {
      const dt = ev.dataTransfer;
      if (!dt) return false;
      if (dt.types) {
        for (let i = 0; i < dt.types.length; i++) if (dt.types[i] === 'Files') return true;
        return false;
      }
      return true;
    }
    let dragDepth = 0;
    window.addEventListener('dragenter', (ev) => {
      if (!dragHasFiles(ev)) return;
      ev.preventDefault();
      dragDepth++;
      el.app.classList.add('is-dropping');
    });
    window.addEventListener('dragover', (ev) => {
      if (!dragHasFiles(ev)) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', (ev) => {
      if (!dragDepth) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) el.app.classList.remove('is-dropping');
    });
    // 捕獲階段先關掉遮罩：刀具表面板會把 CSV 的 drop 攔下來（stopPropagation），
    // 只靠下面那個冒泡的 handler 的話，拖進刀具表之後遮罩會一直留在畫面上。
    window.addEventListener('drop', () => {
      dragDepth = 0;
      el.app.classList.remove('is-dropping');
    }, true);
    window.addEventListener('drop', (ev) => {
      if (!dragHasFiles(ev)) return;
      ev.preventDefault();
      dragDepth = 0;
      el.app.classList.remove('is-dropping');
      const dt = ev.dataTransfer;
      if (dt && dt.files && dt.files[0]) openFile(dt.files[0]);
    });

    // 範例選單
    (function fillSamples() {
      for (const s of (ui.samples || [])) {
        const op = document.createElement('option');
        op.value = sampleId(s);
        const n = String(s.text || '').split('\n').length;
        op.textContent = `${s.name}（${n} 行）`;
        el.selSample.appendChild(op);
      }
    })();

    // URL hash：#sample=樣本 C（可再加 &scenario=on&mode=sectionY&section=-20&tab=diag&ptab=tools&scrap=hide，
    // 供截圖／分享用）。scrap=off|mark|hide 是廢料的顯示方式（同工具列 #selScrap），只影響這一次瀏覽、不存偏好。
    function hashParams() {
      const out = {};
      const raw = String(location.hash || '').replace(/^#/, '');
      if (!raw) return out;
      for (const part of raw.split('&')) {
        if (!part) continue;
        const i = part.indexOf('=');
        const k = i < 0 ? part : part.slice(0, i);
        const v = i < 0 ? '' : part.slice(i + 1);
        try { out[decodeURIComponent(k)] = decodeURIComponent(v); } catch (e) { out[k] = v; }
      }
      return out;
    }

    function applyHash() {
      const p = hashParams();
      if (p.scenario && ['off', 'on', 'multiIgnored'].indexOf(p.scenario) >= 0 && p.scenario !== state.scenario) {
        state.scenario = p.scenario;
        el.selScenario.value = p.scenario;
        settingsPanel.update({ settings: state.settings, scenario: state.scenario, cell: state.cell });
      }
      // 廢料顯示（截圖用）：要在載入範例**之前**設好，applyResult 第一次餵視圖就用這個模式。
      // 只設下拉（scrapMode() 讀的就是它）、不碰 viewPref——網址參數只影響這一次瀏覽，
      // 不然之後任何 persistSettings 都會把它存成長期偏好
      let scrapChanged = false;
      if (p.scrap !== undefined && SCRAP_MODES.indexOf(p.scrap) >= 0 && el.selScrap && p.scrap !== scrapMode()) {
        el.selScrap.value = p.scrap;
        scrapChanged = true;
      }
      const loaded = p.sample ? loadSample(p.sample) : false;
      if (scrapChanged && !loaded) applyChunks();   // hashchange 只改了 scrap、程式沒換：直接重餵
      // 並排／剖切：截圖時常常要把右半邊關掉，所以也吃網址參數（split=0、clip=0）
      for (const [key, pref, box] of [['split', 'split', el.chkSplit], ['clip', 'clip', el.chkClip]]) {
        if (p[key] === undefined || p[key] === '') continue;
        state.viewPref[pref] = p[key] !== '0' && p[key] !== 'off' && p[key] !== 'false';
        box.checked = state.viewPref[pref];
      }
      if (p.mode) setViewMode(p.mode); else applyViewLayout({ fit3d: true });
      // 手機版一次只看一區；分享的網址帶了 tab 參數就把那一區切出來，不然選了也看不到
      if (p.tab) {
        const where = selectAnyTab(p.tab);
        if (where && isMobileLayout()) selectMobileView(where === 'status' ? 'status' : 'project');
      }
      // #ptab=stock：直接切到 Project 的某個子頁；#setup=1 是舊寫法（以前的全螢幕設定頁），等於 ptab=stock
      if (p.ptab) openProjectPage(p.ptab);
      if (p.setup !== undefined && p.setup !== '' && p.setup !== '0') openSetup();
      if (p.section !== undefined && p.section !== '' && Number.isFinite(Number(p.section)) && sectionMode()) {
        sectionTouched = true;
        const v = Number(p.section);
        el.rngSection.value = String(v);
        view.setSection(v);
        el.secVal.textContent = (viewMode === 'sectionY' ? 'Y' : 'X') + fmt(v, 2);
        syncSection3D();
      }
      return loaded;
    }

    window.addEventListener('hashchange', () => { applyHash(); });

    // ---- 起始狀態 ----
    el.selScenario.value = state.scenario;
    el.chkSplit.checked = state.viewPref.split;
    el.chkClip.checked = state.viewPref.clip;
    if (el.selScrap) el.selScrap.value = normalizeScrapMode(state.viewPref.scrapMode);   // 長期偏好 → 下拉；之後以下拉為準
    if (!applyHash()) {
      const first = (ui.samples || [])[0];
      if (first) loadSample(sampleId(first));
      else setStatus('請按「開檔…」或把 NC 檔拖進視窗');
    }

    return {
      state, editor, view,
      panels: { tools: toolsPanel, diag: diagPanel, modal: modalPanel, ops: opsPanel, stock: stockPanel, settings: settingsPanel, magazine: magPanel, overview: overviewPanel },
      loadProgram, loadSample, refresh, exportToolCSV, importToolCSV,
      selectTab, selectProjectTab, openProjectPage,
      applyChunks, setMarkMode,   // 廢料判定（整合測試用 CDP 直接叫）
    };
  }

  ui.createApp = createApp;
  ui.analyzeSyncCompat = analyzeSyncCompat;
  ui.analyzeCompat = analyzeCompat;
  // 不碰 DOM 的小工具露出來給 Node 測（廢料設定的退路版 normalize、指紋、顯示模式、素材存檔項目、記號範圍）
  ui.appUtil = { defaultScrap, normalizeScrap, scrapKey, isDefaultScrap, normalizeScrapMode, stockItemOf, markInStock, roundMark, SCRAP_MODES, SCRAP_ANCHORS };

  if (typeof document !== 'undefined') {
    const boot = () => {
      try {
        ui.app = createApp();
      } catch (e) {
        console.error('銑床預演台啟動失敗：', e);
        const host = document.getElementById('editorHost');
        if (host) host.innerHTML = '<div class="app-empty">啟動失敗：' + String(e && e.message ? e.message : e) + '</div>';
      }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})(globalThis.NC = globalThis.NC || {});
