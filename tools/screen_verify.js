#!/usr/bin/env node
/* v3 产出校验：读取 screen/run_meta.json、screen/universe.json、screen/out/results.json、screen/out/benchmarks.json、screen/metrics_*.csv、
 * screen/report.md、screen.html、screen/README.md 与 screen/out/klines，逐条 PASS/FAIL 写入 screen/out/screen_verify.log（同时打印），
 * 末行 ALL PASS / PASS WITH N WARN（WARN = 已注明的数据缺口，不阻断）/ N FAIL；退出码 1 = 有 FAIL。
 *   U. 股票池：4 个 clist 分段（universe_fetch.json；缺失则改用 universe_enrich.json 分段事实 + run_meta.universeProvenance 校验拼合股票池）、无北交所；
 *      每行 board ∈ {主板,创业板,科创板}；代码前缀与板块一致；每板块抽 10 只；无 interim 行（有则 WARN 且须在 report.md / screen.html 注明）
 *   M. run_meta：version v3、FIRST_BEAR_DEPTH peak、dataEnd、universeCount = eligible + 剔除、自检 0 违例、boardCounts 与 results 一致、20 只合理性校验股全部入选且名次规则正确、fetchFailures 0
 *   A. 规则一致性（每只入选 × 每个非空视图 × 每个阈值）：合格熊市计数、熊市均跌 / 最深熊市 / 均历时、回退口径、永不为 0、新高率 / 底部抬高率样本规则、link、窗口字段、首段熊 depth 与 lo 关系
 *   B. 指定个股断言：法狮龙 1.605318 avgBearRet ≤ −0.45；华能水电 1.600025 ≠ 0；贵阳银行 1.601997 ≤ −0.5（T=0.3）
 *   C. 独立重算（抽样，含 20 只合理性校验股）：直接用 app.js analyze() 重跑三阈值 + 两窗口，按规则独立实现一遍再比对
 *   R. 排名：每个视图 名次 1..n、综合分随名次单调、百分位 ∈ [0,1]、compositeN 上界、Pareto 非被压制
 *   D. 数据终点：results / benchmarks / CSV / report.md / screen.html 的数据终点一致
 *   S. CSV：BOM、CRLF、行数、板块列（第 4 列）、无 NaN/undefined/null、列数一致、看板链接前缀 ../index.html#s=
 *   P. report.md：表格竖线一致；5 × 综合榜 Top 50 各 50 行；4 × 窗口 Top 20；15 × 分榜 Top 20；含「板块」列；20 只校验股均「入选」；文案
 *   H. screen.html 壳：< 60 KB、无 <link href / fetch(、通过 <script> 注入加载 screen/data/、无残留占位符、DASH_BASE './index.html'、含 #status、<canvas id="scatter">、分页（PAGE = 100 + #showAll）、IME 保护、板块多选、脚本可编译、页脚全局排名说明；
 *      screen/data：恰好 13 个文件（meta / all / 10y / 5y / 各区间 _th30|40|50），KEYS 结构、行数 / 下标对齐 / 名次 1..n / 行业字典 / 抽值与 results.json 一致；首屏 gzip（壳 + meta + all + all_th30）≤ 500 KB
 *   E. 文案：report.md / screen.html / screen/README.md / screen/data/meta.js 不含任何免责声明 / 出处 / 用途类套话（词表 BAD_WORDS，以 \u 转义存放）
 *   V. --prev <dir>：与上一版 metrics_th30|40|50.csv / metrics_w10y|w5y.csv 逐只回归（入选个股的 年化 / 最大回撤 / 熊市均跌 等字段逐字相同；名次允许变化）
 * 用法（仓库根目录）：node tools/screen_verify.js [--prev <dir>] [--expect-data-end YYYY-MM-DD]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const E = require('../app.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'screen', 'out');
const PUB = path.join(ROOT, 'screen');
const argv = process.argv.slice(2);
const argVal = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const PREV = argVal('--prev');
const EXPECT_END = argVal('--expect-data-end');
const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const exists = (p) => fs.existsSync(p);
const lines = [];
let nPass = 0, nFail = 0, nWarn = 0;
const out = (s) => lines.push(s);
const check = (ok, msg) => { if (ok) nPass++; else nFail++; out((ok ? 'PASS ' : 'FAIL ') + msg); return ok; };
// warn：数据缺口类（外部接口不可用导致、不影响指标与排名、已在 report.md / screen.html 中注明）—— 记入日志与汇总行，但不作为 FAIL（退出码不变）
const warn = (ok, msg) => { if (ok) nPass++; else nWarn++; out((ok ? 'PASS ' : 'WARN ') + msg); return ok; };
const near = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= tol;
const rd6 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 1e6) / 1e6);
const mean = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null);
const THS = ['0.3', '0.4', '0.5'];
const BOARDS = ['主板', '创业板', '科创板'];
const PREFIX = { 主板: /^(000|001|002|003|600|601|603|605)/, 创业板: /^30[0-2]/, 科创板: /^68[89]/ };
const BSE = /^(4|8|92)/;
const LINK_PREFIX = '../index.html#s=';
const SANITY = [
  ['600519', '主板'], ['600900', '主板'], ['000333', '主板'], ['600887', '主板'], ['600276', '主板'], ['600436', '主板'], ['000538', '主板'], ['000651', '主板'], ['600036', '主板'], ['600309', '主板'],
  ['300015', '创业板'], ['300760', '创业板'], ['300750', '创业板'], ['300059', '创业板'], ['300124', '创业板'],
  ['688012', '科创板'], ['688111', '科创板'], ['688981', '科创板'], ['688008', '科创板'], ['688036', '科创板'],
];
// 禁用词表（免责声明 / 出处 / 用途类套话，用户要求不得出现在任何产出中）。以 \u 转义存放，使词语本身不以明文出现在仓库任何文件里（grep 不命中）。
const BAD_WORDS = ['\u4e0d\u6784\u6210\u6295\u8d44\u5efa\u8bae', '\u4ec5\u4f9b\u7814\u7a76\u53c2\u8003', '\u4e2a\u4eba\u5b66\u4e60', '\u7075\u611f\u6765\u81ea', '\u8001\u94b1\u65e5\u65e5\u8c08', '\u516c\u5f00\u6e20\u9053'];
const LEGEND21 = '首段（截断）熊市按段内最高点→最低点跌幅计';

const meta = readJSON(path.join(PUB, 'run_meta.json'));
const universe = readJSON(path.join(PUB, 'universe.json'));
const results = readJSON(path.join(OUT, 'results.json'));
const benchmarks = readJSON(path.join(OUT, 'benchmarks.json'));
const elig = results.filter((r) => r.eligible);
const WINDOWS = (meta.config && meta.config.WINDOWS) || [{ key: '10y', start: '2016-10-15' }, { key: '5y', start: '2021-10-15' }];
const DATA_END = meta.dataEnd || meta.dataEndDate;
const EPS = 1e-9;
const bySecid = new Map(results.map((r) => [r.secid, r]));
const wElig = (W) => elig.filter((r) => r.windows && r.windows[W.key]);
out('screen_verify ' + new Date().toISOString() + ' root=' + ROOT + ' results rows=' + results.length + ' eligible=' + elig.length + ' version=' + meta.version + ' dataEnd=' + DATA_END + (PREV ? ' prev=' + PREV : '') + (EXPECT_END ? ' expectDataEnd=' + EXPECT_END : ''));

// ---------------------------------------------------------------- U. universe
{
  const ufPath = path.join(OUT, 'universe_fetch.json');
  if (exists(ufPath)) {
    const uf = readJSON(ufPath);
    const fsList = (uf.segments || []).map((s) => s.fs);
    check(fsList.length === 4 && ['m:0+t:6', 'm:0+t:80', 'm:1+t:2', 'm:1+t:23'].every((f) => fsList.includes(f)) && !fsList.some((f) => /t:81/.test(f)), 'U. universe_fetch.json has exactly the 4 segments 深主板 m:0+t:6 / 创业板 m:0+t:80 / 沪主板 m:1+t:2 / 科创板 m:1+t:23 and no BSE t:81 (' + fsList.join(', ') + ')');
    out('  info: universe_fetch fetchedAt ' + uf.fetchedAt + ' segments ' + JSON.stringify(uf.segments));
  } else {
    // 4 个分段不在同一次运行里拉取（主板来自 v2.1 的 clist 拉取，创业板 / 科创板由 --universe-only 的 enrichF26 补入）：
    // 用 universe_enrich.json 最近一次 ok 运行的分段事实 + run_meta.universeProvenance 代替 universe_fetch.json 校验：
    // 每行都来自 clist（无 interim 行）；创业板 m:0+t:80 / 科创板 m:1+t:23 的 clist total 与 universe 行数一致；主板按市场拆分即 深主板 m:0+t:6 / 沪主板 m:1+t:2；无 t:81
    out('SKIP U. universe_fetch.json absent (4 segments were not fetched in one run) — checking the composite universe instead');
    const enPath = path.join(OUT, 'universe_enrich.json');
    const hist = exists(enPath) ? readJSON(enPath) : [];
    const okRuns = hist.filter((h) => h.ok);
    const lastOk = okRuns.length ? okRuns[okRuns.length - 1] : null;
    out('  info: universe_enrich.json runs=' + hist.length + ' ok=' + okRuns.length + (lastOk ? ' last ok at ' + lastOk.at + ' segments ' + JSON.stringify(lastOk.segmentsDone) : ''));
    const prov0 = meta.universeProvenance || {};
    const provKeys = Object.keys(prov0);
    const allClist = provKeys.length > 0 && provKeys.every((k) => /^clist \d{4}-\d{2}-\d{2}$/.test(k));
    const byBoardCount = {}; for (const u of universe) byBoardCount[u.board] = (byBoardCount[u.board] || 0) + 1;
    const mbByMarket = { 0: universe.filter((u) => u.board === '主板' && u.market === 0).length, 1: universe.filter((u) => u.board === '主板' && u.market === 1).length };
    const segDone = lastOk ? lastOk.segmentsDone || [] : [];
    const segFs = segDone.map((s) => s.fs);
    const segOk = (fsStr, board) => { const s = segDone.find((x) => x.fs === fsStr && x.board === board); return !!s && s.total === byBoardCount[board] && s.rows === byBoardCount[board]; };
    const segsCfg = (meta.config && meta.config.UNIVERSE_SEGMENTS) || [];
    const cfgFs = segsCfg.map((s) => s.fs);
    const noBse = !segFs.some((f) => /t:81/.test(f)) && !cfgFs.some((f) => /t:81/.test(f));
    check(allClist && segOk('m:0+t:80', '创业板') && segOk('m:1+t:23', '科创板') && cfgFs.includes('m:0+t:6') && cfgFs.includes('m:1+t:2') && mbByMarket[0] + mbByMarket[1] === byBoardCount['主板'] && noBse,
      'U. composite universe covers the 4 segments from clist: 主板 ' + byBoardCount['主板'] + ' (深主板 m:0+t:6 → market 0: ' + mbByMarket[0] + ', 沪主板 m:1+t:2 → market 1: ' + mbByMarket[1] + '), 创业板 m:0+t:80 ' + byBoardCount['创业板'] + ', 科创板 m:1+t:23 ' + byBoardCount['科创板'] + '; enrich segments ' + JSON.stringify(segDone.map((s) => s.board + ' ' + s.fs + ' total=' + s.total + ' rows=' + s.rows)) + '; provenance keys ' + JSON.stringify(provKeys) + ' (all clist=' + allClist + '); no BSE t:81=' + noBse);
  }
  const prov = meta.universeProvenance || {};
  out('  info: universe provenance (rows by source × board) ' + JSON.stringify(prov));
  const segs = meta.config && meta.config.UNIVERSE_SEGMENTS;
  const badBoard = universe.filter((u) => !BOARDS.includes(u.board));
  check(badBoard.length === 0, 'U. every universe row has board ∈ {主板,创业板,科创板} (' + universe.length + ' rows, bad=' + badBoard.length + ')');
  const prefixBad = universe.filter((u) => !PREFIX[u.board] || !PREFIX[u.board].test(u.code));
  check(prefixBad.length === 0, 'U. code prefix matches board for all rows (主板 000/001/002/003/600/601/603/605, 创业板 300–302, 科创板 688/689): violations=' + prefixBad.length + (prefixBad.length ? ' e.g. ' + prefixBad.slice(0, 5).map((u) => u.code + '/' + u.board).join(' ') : ''));
  const bse = universe.filter((u) => BSE.test(u.code));
  check(bse.length === 0, 'U. no BSE codes (4xxxxx / 8xxxxx / 92xxxx) in universe (' + bse.length + ')');
  const byB = {}; for (const u of universe) byB[u.board] = (byB[u.board] || 0) + 1;
  out('  info: universe rows by board ' + JSON.stringify(byB) + ' total ' + universe.length);
  check(universe.length === results.length && results.every((r) => BOARDS.includes(r.board)), 'U. results.json rows ' + results.length + ' === universe rows ' + universe.length + ' and every results row carries a board');
  for (const b of BOARDS) {
    const rows = universe.filter((u) => u.board === b);
    const step = Math.max(1, Math.floor(rows.length / 10));
    const sample = []; for (let i = 0; i < rows.length && sample.length < 10; i += step) sample.push(rows[i]);
    out('  samples ' + b + ' (' + rows.length + '): ' + sample.map((u) => u.code + ' ' + u.name + ' ' + (u.listDate || '-')).join(' | '));
  }
  const interimRows = universe.filter((u) => u.interim && u.listDate == null);
  const interimBy = {}; for (const u of interimRows) interimBy[u.board] = (interimBy[u.board] || 0) + 1;
  const md0 = exists(path.join(PUB, 'report.md')) ? fs.readFileSync(path.join(PUB, 'report.md'), 'utf8') : '';
  const html0 = exists(path.join(ROOT, 'screen.html')) ? fs.readFileSync(path.join(ROOT, 'screen.html'), 'utf8') : '';
  const documented = interimRows.length === 0 || (md0.includes('股票池数据缺口') && html0.includes('股票池数据缺口'));
  warn(interimRows.length === 0, 'U. no interim universe rows (clist 上市日 / 行业 / 总市值 missing) left: ' + interimRows.length + (interimRows.length ? ' ' + JSON.stringify(interimBy) + ' — known data gap (eastmoney clist 深交所 segments returned 502 for this IP during the run); 5-year rule uses K-line first/last bar so eligibility / metrics / ranks are unaffected; CSV 上市日(f26)/行业/总市值 empty for these rows; documented in report.md + screen.html: ' + documented + '; fix: node tools/screen_all.js --universe-only when clist answers, then --compute-only' : ''));
  if (interimRows.length) check(documented, 'U. interim-row data gap is stated in report.md (概览 + 口径与局限) and in the screen.html banner');
  if (segs) check(segs.length === 4 && !segs.some((s) => /t:81/.test(s.fs)), 'U. run_meta.config.UNIVERSE_SEGMENTS has 4 segments, none BSE');
}

// ---------------------------------------------------------------- M. run_meta
{
  check(meta.version === 'v3', 'M. run_meta.version === v3 (' + meta.version + ')');
  check(meta.config && meta.config.FIRST_BEAR_DEPTH === 'peak', 'M. run_meta.config.FIRST_BEAR_DEPTH === peak (' + (meta.config && meta.config.FIRST_BEAR_DEPTH) + ')');
  if (EXPECT_END) check(meta.dataEnd === EXPECT_END && meta.config.DATA_END === EXPECT_END && (meta.windows || []).every((w) => w.end === EXPECT_END), 'M. run_meta.dataEnd / config.DATA_END / windows[*].end === ' + EXPECT_END + ' (' + meta.dataEnd + ' / ' + meta.config.DATA_END + ' / ' + (meta.windows || []).map((w) => w.end).join(',') + ')');
  check(meta.dataEndDate === meta.dataEnd, 'M. 上证末根 K 线 dataEndDate ' + meta.dataEndDate + ' === dataEnd ' + meta.dataEnd);
  out('  info: dataEndSpec=' + meta.dataEndSpec + ' dataEndMode=' + meta.dataEndMode + ' truncation=' + JSON.stringify(meta.truncation));
  const excSum = Object.values(meta.exclusionCounts || {}).reduce((a, b) => a + b, 0);
  check(meta.universeCount === meta.eligibleCount + excSum && meta.eligibleCount === elig.length, 'M. universeCount ' + meta.universeCount + ' === eligible ' + meta.eligibleCount + ' + exclusions ' + excSum + ' (' + JSON.stringify(meta.exclusionCounts) + ')');
  const ck = meta.checks || {};
  check(ck.phaseAlternationViolations === 0 && ck.retSignViolations === 0 && ck.nBearMonotoneViolations === 0 && ck.avgBearZeroOrNull === 0 && Array.isArray(ck.errors) && ck.errors.length === 0, 'M. checks all zero: ' + JSON.stringify({ alt: ck.phaseAlternationViolations, sign: ck.retSignViolations, mono: ck.nBearMonotoneViolations, zero: ck.avgBearZeroOrNull, errors: (ck.errors || []).length }));
  out('  info: bearFallback ' + JSON.stringify(ck.bearFallback) + ' rateNullSmallSample ' + JSON.stringify(ck.rateNullSmallSample));
  check(meta.fetchFailures === 0, 'M. fetchFailures === 0 (' + meta.fetchFailures + ')');
  const bc = meta.boardCounts || {};
  const bcProblems = [];
  for (const b of BOARDS) {
    const exp = { universe: results.filter((r) => r.board === b).length, eligible: elig.filter((r) => r.board === b).length };
    for (const W of WINDOWS) exp['w' + W.key] = wElig(W).filter((r) => r.board === b).length;
    for (const k of Object.keys(exp)) if (!bc[b] || bc[b][k] !== exp[k]) bcProblems.push(b + '.' + k + ' ' + (bc[b] && bc[b][k]) + ' != ' + exp[k]);
  }
  check(bcProblems.length === 0, 'M. boardCounts consistent with results (universe / eligible / w10y / w5y per board): ' + JSON.stringify(bc) + (bcProblems.length ? ' -> ' + bcProblems.join('; ') : ''));
  check(bc['科创板'] && bc['科创板'].w10y === 0, 'M. 科创板 近10年窗口入选 === 0 by construction (' + (bc['科创板'] && bc['科创板'].w10y) + ')');
  const san = meta.sanity || [];
  const sanProblems = [];
  for (const [code, board] of SANITY) {
    const s = san.find((x) => x.code === code);
    if (!s) { sanProblems.push(code + ' missing'); continue; }
    if (!s.found || !s.eligible) { sanProblems.push(code + ' not eligible (' + s.excluded_reason + ')'); continue; }
    if (s.board !== board) sanProblems.push(code + ' board ' + s.board + ' != ' + board);
    if (!THS.every((T) => s.ranks[T] != null && s.winRanks['5y'][T] != null)) sanProblems.push(code + ' missing all/5y rank');
    const in10y = s.listDate <= WINDOWS[0].start;
    if (!THS.every((T) => (s.winRanks['10y'][T] != null) === in10y)) sanProblems.push(code + ' 10y rank presence != (listDate ' + s.listDate + ' <= ' + WINDOWS[0].start + ')');
  }
  check(san.length === 20 && sanProblems.length === 0, 'M. run_meta.sanity: 20 stocks, all found & eligible, board correct, ranks for all/5y, 10y rank iff first bar <= ' + WINDOWS[0].start + (sanProblems.length ? ' -> ' + sanProblems.join('; ') : ''));
  out('  info: sanity ranks (上市至今 30% / 近10年 30%): ' + san.map((s) => s.name + ' ' + s.ranks['0.3'] + '/' + (s.winRanks['10y']['0.3'] == null ? '不在窗口' : s.winRanks['10y']['0.3'])).join('; '));
}

// ---------------------------------------------------------------- A. rule consistency
const FIRST_BEAR_DEPTH = (meta.config && meta.config.FIRST_BEAR_DEPTH) || 'start';
const PEAK = FIRST_BEAR_DEPTH === 'peak';
const dep = (p) => (typeof p.depth === 'number' ? p.depth : p.lo);
{
  const agg = { views: 0, cells: 0, fails: [], boundary: 0, info: { fallback: {}, roll5yNull5y: 0, bearPhases: 0, firstBears: 0, firstBearsDeepened: 0 } };
  const addFail = (s) => { agg.fails.push(s); };
  for (const r of elig) {
    const views = [['all', r, null]];
    for (const W of WINDOWS) views.push([W.key, r.windows ? r.windows[W.key] : undefined, W]);
    for (const [key, V, W] of views) {
      if (W) {
        const shouldHave = r.listDate <= W.start;
        if ((V != null) !== shouldHave) addFail(r.secid + ' windows[' + key + '] ' + (V ? 'present' : 'null') + ' but listDate=' + r.listDate + ' vs start ' + W.start);
        if (!V) continue;
        if (!(V.window && V.window.start >= W.start)) addFail(r.secid + ' windows[' + key + '].window.start ' + (V.window && V.window.start) + ' < ' + W.start);
        if (!(V.window && V.window.end === r.lastDate)) addFail(r.secid + ' windows[' + key + '].window.end ' + (V.window && V.window.end) + ' != lastDate ' + r.lastDate);
        if (V.hz !== undefined || V.yearly !== undefined) addFail(r.secid + ' windows[' + key + '] carries hz/yearly');
        if (key === '5y' && V.roll5y == null) agg.info.roll5yNull5y++;
        if (key === '5y' && V.roll5y != null) addFail(r.secid + ' windows[5y].roll5y not null');
      } else if (r.windows === undefined) { addFail(r.secid + ' eligible row has no windows key'); }
      agg.views++;
      if (typeof V.maxDD !== 'number' || !(V.maxDD < 0)) addFail(r.secid + ' ' + key + ' maxDD not negative number: ' + V.maxDD);
      for (const T of THS) {
        const th = V.th[T], Tn = +T, ph = th.phases;
        agg.cells++;
        if (W) { const expBasis = V.years >= 6 ? 'M' : V.years >= 2 ? 'W' : 'D'; if (th.basis !== expBasis) addFail(r.secid + ' windows[' + key + '] th[' + T + '].basis=' + th.basis + ' (expected ' + expBasis + ' for ' + V.years + ' years)'); }
        for (const p of ph) {
          if (p.bull) { if (p.depth !== undefined) addFail(r.secid + ' ' + key + ' T=' + T + ' bull phase carries depth'); continue; }
          if (typeof p.depth !== 'number') { addFail(r.secid + ' ' + key + ' T=' + T + ' bear phase without depth ' + p.s); continue; }
          agg.info.bearPhases++;
          if (!p.first || !PEAK) { if (p.depth !== p.lo) addFail(r.secid + ' ' + key + ' T=' + T + ' non-first bear depth ' + p.depth + ' != lo ' + p.lo + ' ' + p.s); }
          else { agg.info.firstBears++; if (!(p.depth <= p.lo + 1e-9)) addFail(r.secid + ' ' + key + ' T=' + T + ' first bear depth ' + p.depth + ' > lo ' + p.lo); if (p.depth < p.lo - 1e-9) agg.info.firstBearsDeepened++; if (!(p.depth >= V.maxDD - 1e-9)) addFail(r.secid + ' ' + key + ' T=' + T + ' first bear depth ' + p.depth + ' < maxDD ' + V.maxDD); }
        }
        const qual = ph.filter((p) => !p.bull && ((!p.first && !p.ongoing) || -dep(p) >= Tn - 1e-6));
        const comp = ph.filter((p) => !p.bull && !p.first && !p.ongoing);
        const nearBoundary = ph.some((p) => !p.bull && (p.first || p.ongoing) && Math.abs(-dep(p) - Tn) <= 2e-6);
        if (th.nCompletedBear !== comp.length) addFail(r.secid + ' ' + key + ' T=' + T + ' nCompletedBear ' + th.nCompletedBear + ' != ' + comp.length);
        if (th.nBearQualifying !== qual.length) { if (nearBoundary) agg.boundary++; else addFail(r.secid + ' ' + key + ' T=' + T + ' nBearQualifying ' + th.nBearQualifying + ' != recomputed ' + qual.length); }
        if (th.nBearQualifying < th.nCompletedBear) addFail(r.secid + ' ' + key + ' T=' + T + ' nBearQualifying < nCompletedBear');
        const useQ = th.nBearQualifying === qual.length ? qual : null;
        if (th.nBearQualifying > 0) {
          if (th.avgBearSrc !== 'bears') addFail(r.secid + ' ' + key + ' T=' + T + ' avgBearSrc=' + th.avgBearSrc + ' with qualifying bears');
          if (useQ) {
            if (!near(th.avgBearRet, mean(useQ.map(dep)), 2e-6)) addFail(r.secid + ' ' + key + ' T=' + T + ' avgBearRet ' + th.avgBearRet + ' != mean(depth) ' + mean(useQ.map(dep)));
            if (!near(th.deepestBearRet, Math.min(...useQ.map(dep)), 2e-6)) addFail(r.secid + ' ' + key + ' T=' + T + ' deepestBearRet ' + th.deepestBearRet + ' != min(depth)');
            if (!near(th.avgBearDays, mean(useQ.map((p) => p.days)), 0.1)) addFail(r.secid + ' ' + key + ' T=' + T + ' avgBearDays ' + th.avgBearDays + ' != mean(days)');
          }
        } else {
          agg.info.fallback[key + '@' + T] = (agg.info.fallback[key + '@' + T] || 0) + 1;
          if (th.avgBearSrc !== 'maxDD') addFail(r.secid + ' ' + key + ' T=' + T + ' avgBearSrc=' + th.avgBearSrc + ' with no qualifying bear');
          if (th.avgBearRet !== V.maxDD || th.deepestBearRet !== V.maxDD) addFail(r.secid + ' ' + key + ' T=' + T + ' fallback avgBearRet/deepestBearRet ' + th.avgBearRet + '/' + th.deepestBearRet + ' != maxDD ' + V.maxDD);
          if (th.avgBearDays !== null) addFail(r.secid + ' ' + key + ' T=' + T + ' fallback avgBearDays not null');
        }
        if (!(typeof th.avgBearRet === 'number' && th.avgBearRet < 0)) addFail(r.secid + ' ' + key + ' T=' + T + ' avgBearRet not negative number: ' + th.avgBearRet);
        if (!(typeof th.deepestBearRet === 'number' && th.deepestBearRet <= th.avgBearRet + EPS)) addFail(r.secid + ' ' + key + ' T=' + T + ' deepestBearRet ' + th.deepestBearRet + ' > avgBearRet ' + th.avgBearRet);
        if (!(th.deepestBearRet >= V.maxDD - EPS)) addFail(r.secid + ' ' + key + ' T=' + T + ' deepestBearRet ' + th.deepestBearRet + ' < maxDD ' + V.maxDD);
        const nCB = ph.filter((p) => p.bull && !p.first && !p.ongoing).length;
        if ((th.bullNewHighRate == null) !== (nCB < 2)) addFail(r.secid + ' ' + key + ' T=' + T + ' bullNewHighRate null-rule mismatch: rate=' + th.bullNewHighRate + ' nCompletedBull=' + nCB);
        if ((th.bearHigherLowRate == null) !== (th.nBearPairs < 2)) addFail(r.secid + ' ' + key + ' T=' + T + ' bearHigherLowRate null-rule mismatch: rate=' + th.bearHigherLowRate + ' nBearPairs=' + th.nBearPairs);
        if ((th.asymmetry == null) !== (th.avgBullRet == null)) addFail(r.secid + ' ' + key + ' T=' + T + ' asymmetry/avgBullRet null mismatch');
        if (!(typeof th.link === 'string' && th.link.startsWith(LINK_PREFIX + r.secid) && th.link.indexOf('&r=' + key + '&') > 0 && th.link.endsWith('&th=' + T))) addFail(r.secid + ' ' + key + ' T=' + T + ' bad link ' + th.link);
      }
    }
  }
  check(agg.fails.length === 0, 'A. rule consistency over ' + elig.length + ' eligible × ' + agg.views + ' views × 3 thresholds (' + agg.cells + ' cells): ' + agg.fails.length + ' violations' + (agg.boundary ? ' (' + agg.boundary + ' boundary |depth|≈T cases skipped)' : '') + ' [FIRST_BEAR_DEPTH=' + FIRST_BEAR_DEPTH + ': bear phases ' + agg.info.bearPhases + ', first bears ' + agg.info.firstBears + ', first bears deepened (peak after start) ' + agg.info.firstBearsDeepened + ']');
  for (const f of agg.fails.slice(0, 40)) out('  ' + f);
  out('  info: fallback(maxDD) counts ' + JSON.stringify(agg.info.fallback) + '; windows[5y].roll5y null count ' + agg.info.roll5yNull5y);
  let zeros = 0, nulls = 0;
  for (const r of elig) for (const [, V] of [['all', r]].concat(WINDOWS.map((W) => [W.key, r.windows && r.windows[W.key]]))) if (V) for (const T of THS) { if (V.th[T].avgBearRet === 0) zeros++; if (V.th[T].avgBearRet == null) nulls++; }
  check(zeros === 0 && nulls === 0, 'A. no avgBearRet === 0 or null across all eligible stocks × views × thresholds (zeros=' + zeros + ', nulls=' + nulls + ')');
  for (const W of WINDOWS) {
    const have = wElig(W).length, expect = elig.filter((r) => r.listDate <= W.start).length;
    const m = meta.windows && meta.windows.find((x) => x.key === W.key);
    check(have === expect && (!m || m.eligible === have), 'A. windows[' + W.key + '] eligible ' + have + ' == eligible rows with first bar <= ' + W.start + ' (' + expect + ')' + (m ? ' == run_meta ' + m.eligible : ''));
  }
  check(results.filter((r) => !r.eligible && r.windows !== undefined).length === 0, 'A. non-eligible rows carry no windows key');
}

// ---------------------------------------------------------------- B. named stocks (T=0.3, all)
{
  const named = [
    ['1.605318', '法狮龙', (th) => th.avgBearRet <= -0.45, 'avgBearRet <= -0.45'],
    ['1.600025', '华能水电', (th) => th.avgBearRet !== 0 && th.avgBearRet < 0, 'avgBearRet != 0'],
    ['1.601997', '贵阳银行', (th) => th.avgBearRet <= -0.5, 'avgBearRet <= -0.5'],
  ];
  for (const [secid, nm, f, desc] of named) {
    const r = bySecid.get(secid);
    if (!r) { out('SKIP B. ' + nm + ' ' + secid + ' not in results'); continue; }
    if (!r.eligible) { check(false, 'B. ' + nm + ' ' + secid + ' not eligible: ' + r.excluded_reason); continue; }
    const th = r.th['0.3'];
    check(f(th), 'B. ' + nm + ' ' + secid + ' T=0.3 ' + desc + ' (avgBearRet=' + th.avgBearRet + ', deepestBearRet=' + th.deepestBearRet + ', src=' + th.avgBearSrc + ', nBearQualifying=' + th.nBearQualifying + ', maxDD=' + r.maxDD + ', rank30=' + th.rank + ')');
    if (secid === '1.605318' && PEAK) { const fb = th.phases.find((p) => !p.bull && p.first); check(fb && near(fb.depth, r.maxDD, 2e-6) && near(th.avgBearRet, -0.5148, 1e-3), 'B. 法狮龙 v2.1 rule: first bear depth ' + (fb && fb.depth) + ' == maxDD ' + r.maxDD + ', avgBearRet ' + th.avgBearRet + ' ≈ −0.515'); }
  }
}

// ---------------------------------------------------------------- C. independent recomputation (sample)
{
  const DATA_END_T = E.parseYMD(DATA_END);
  const KL = meta.klineDir && exists(meta.klineDir) ? meta.klineDir : path.join(OUT, 'klines');
  function loadBars(secid) { const j = readJSON(path.join(KL, secid + '.json')); const all = []; for (const b of j.bars) { if (b[0] > DATA_END_T) break; all.push({ t: b[0], c: b[1] }); } return all; }
  function segDrawdown(c, s, e) { const seg = c.slice(s, e + 1); let worst = 0; for (let i = 0; i < seg.length; i++) { const peak = Math.max.apply(null, seg.slice(0, i + 1)); const dd = seg[i] / peak - 1; if (dd < worst) worst = dd; } return worst; }
  function indepThreshold(A, Tn) {
    const depth = (p) => (p.first && PEAK ? segDrawdown(A.c, p.s, p.e) : p.lo);
    const bears = A.phases.filter((p) => !p.bull);
    const q = bears.filter((p) => (!p.first && !p.ongoing) || -depth(p) >= Tn - EPS);
    const bulls = A.phases.filter((p) => p.bull && !p.first && !p.ongoing);
    let hlDen = 0, prev = null;
    for (const p of A.phases) { if (p.bull) continue; if (!p.first && !p.ongoing && prev) hlDen++; prev = p; }
    return { avgBearRet: q.length ? mean(q.map(depth)) : A.maxDD.depth, deepestBearRet: q.length ? Math.min(...q.map(depth)) : A.maxDD.depth, nQ: q.length, nCB: bulls.length, hlDen, rateNull: bulls.length < 2, hlNull: hlDen < 2 };
  }
  const sample = new Map();
  for (const [c] of SANITY) { const r = elig.find((x) => x.code === c); if (r) sample.set(r.secid, r); }
  let k = 0; for (const r of elig) { if (THS.some((T) => r.th[T].avgBearSrc === 'maxDD') && k < 30) { sample.set(r.secid, r); k++; } }
  k = 0; for (const r of elig) { if (THS.some((T) => r.th[T].phases.some((p) => !p.bull && (p.first || p.ongoing) && -p.lo >= +T - 1e-6)) && k < 30) { sample.set(r.secid, r); k++; } }
  k = 0; for (const r of elig) { if (THS.some((T) => r.th[T].phases.some((p) => !p.bull && p.first && typeof p.depth === 'number' && p.depth < p.lo - 1e-9)) && k < 30) { sample.set(r.secid, r); k++; } }
  for (const b of ['创业板', '科创板']) { k = 0; for (const r of elig) { if (r.board === b && k < 25) { sample.set(r.secid, r); k++; } } }
  for (const code of ['605318', '601816', '600025']) { const r = elig.find((x) => x.code === code); if (r) sample.set(r.secid, r); }
  const step = Math.max(1, Math.floor(elig.length / 40)); for (let i = 0; i < elig.length; i += step) sample.set(elig[i].secid, elig[i]);
  const cFails = []; let cCells = 0;
  for (const [secid, r] of sample) {
    let all;
    try { all = loadBars(secid); } catch (e) { cFails.push(secid + ' cannot load klines: ' + e.message); continue; }
    const viewsToCheck = [['all', all, r]];
    for (const W of WINDOWS) {
      const V = r.windows && r.windows[W.key];
      const startT = E.parseYMD(W.start);
      const view = all[0].t <= startT ? all.slice(E.idxOnOrAfter(all, startT)) : null;
      if ((view != null) !== (V != null)) { cFails.push(secid + ' windows[' + W.key + '] presence mismatch'); continue; }
      if (view) viewsToCheck.push([W.key, view, V]);
    }
    if (E.fmtDate(all[all.length - 1].t) !== r.lastDate) cFails.push(secid + ' lastDate ' + r.lastDate + ' != truncated cache last bar ' + E.fmtDate(all[all.length - 1].t));
    for (const [key, bars, V] of viewsToCheck) {
      const A0 = E.analyze(bars, 0.3, 'auto');
      if (rd6(A0.cagr) !== V.cagr) cFails.push(secid + ' ' + key + ' cagr ' + V.cagr + ' != indep ' + rd6(A0.cagr));
      if (rd6(A0.maxDD.depth) !== V.maxDD) cFails.push(secid + ' ' + key + ' maxDD ' + V.maxDD + ' != indep ' + rd6(A0.maxDD.depth));
      if (key !== 'all' && E.fmtDate(bars[0].t) !== V.window.start) cFails.push(secid + ' ' + key + ' window.start mismatch');
      for (const T of THS) {
        const Tn = +T, A = Tn === 0.3 ? A0 : E.analyze(bars, Tn, 'auto');
        const x = indepThreshold(A, Tn), th = V.th[T];
        cCells++;
        if (rd6(x.avgBearRet) !== th.avgBearRet) cFails.push(secid + ' ' + key + ' T=' + T + ' avgBearRet ' + th.avgBearRet + ' != indep ' + rd6(x.avgBearRet));
        if (rd6(x.deepestBearRet) !== th.deepestBearRet) cFails.push(secid + ' ' + key + ' T=' + T + ' deepestBearRet mismatch');
        if (x.nQ !== th.nBearQualifying) cFails.push(secid + ' ' + key + ' T=' + T + ' nBearQualifying ' + th.nBearQualifying + ' != indep ' + x.nQ);
        if (x.nCB !== th.nCompletedBull) cFails.push(secid + ' ' + key + ' T=' + T + ' nCompletedBull mismatch');
        if (x.hlDen !== th.nBearPairs) cFails.push(secid + ' ' + key + ' T=' + T + ' nBearPairs mismatch');
        if (x.rateNull !== (th.bullNewHighRate == null)) cFails.push(secid + ' ' + key + ' T=' + T + ' bullNewHighRate null-rule != indep');
        if (x.hlNull !== (th.bearHigherLowRate == null)) cFails.push(secid + ' ' + key + ' T=' + T + ' bearHigherLowRate null-rule != indep');
        if (A.basis !== th.basis) cFails.push(secid + ' ' + key + ' T=' + T + ' basis mismatch');
      }
    }
  }
  check(cFails.length === 0, 'C. independent engine recomputation on ' + sample.size + ' sampled stocks incl. 20 sanity + 25 创业板 + 25 科创板 (' + cCells + ' view×threshold cells, klines truncated at ' + DATA_END + '): ' + cFails.length + ' mismatches');
  for (const f of cFails.slice(0, 40)) out('  ' + f);
}

// ---------------------------------------------------------------- R. ranking per view
{
  const views = [['all', elig, (r) => r]].concat(WINDOWS.map((W) => [W.key, wElig(W), (r) => r.windows[W.key]]));
  for (const [key, rows, view] of views) {
    const probs = [];
    for (const T of THS) {
      const ranks = rows.map((r) => view(r).th[T].rank).filter((x) => x != null).sort((a, b) => a - b);
      if (ranks.length !== rows.length || ranks.some((v, i) => v !== i + 1)) probs.push(key + ' T=' + T + ' ranks not 1..n (n=' + rows.length + ', ranked=' + ranks.length + ')');
      const byRank = rows.slice().sort((a, b) => view(a).th[T].rank - view(b).th[T].rank);
      for (let i = 1; i < byRank.length; i++) if (view(byRank[i]).th[T].composite > view(byRank[i - 1]).th[T].composite + 1e-12) { probs.push(key + ' T=' + T + ' composite increases along rank at ' + i); break; }
      for (const r of rows) {
        const th = view(r).th[T];
        for (const k of Object.keys(th.pct)) if (th.pct[k] != null && (th.pct[k] < 0 || th.pct[k] > 1)) { probs.push(key + ' T=' + T + ' pct out of range ' + r.secid); break; }
        if (th.compositeN > 6 || (key === '5y' && th.compositeN > 5)) probs.push(key + ' T=' + T + ' compositeN ' + th.compositeN + ' ' + r.secid);
      }
    }
    if (key === '5y' && rows.some((r) => view(r).roll5y != null)) probs.push('5y roll5y not null for some rows');
    const flagged = rows.filter((r) => view(r).pareto);
    let dominated = 0;
    for (const p of flagged) { const vp = view(p); for (const q of rows) { if (q === p) continue; const vq = view(q); if (vq.cagr >= vp.cagr && vq.maxDD >= vp.maxDD && (vq.cagr > vp.cagr || vq.maxDD > vp.maxDD)) { dominated++; break; } } }
    if (dominated) probs.push(key + ' pareto: ' + dominated + ' flagged rows are dominated');
    if (rows.some((r) => typeof view(r).pareto !== 'boolean')) probs.push(key + ' pareto flag missing on some rows');
    check(probs.length === 0, 'R. ranking view ' + key + ' (n=' + rows.length + ', boards ' + BOARDS.map((b) => b + ' ' + rows.filter((r) => r.board === b).length).join(' / ') + '): ranks 1..n, composite monotone, pct in [0,1], compositeN bound, pareto non-dominated (' + flagged.length + ' flagged)' + (probs.length ? ' -> ' + probs.slice(0, 5).join('; ') : ''));
  }
}

// ---------------------------------------------------------------- CSV helpers
function splitCSV(line) { const cells = []; let cur = '', q = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; } else if (ch === '"') q = true; else if (ch === ',') { cells.push(cur); cur = ''; } else cur += ch; } cells.push(cur); return cells; }
function readCSV(p) { const buf = fs.readFileSync(p); const bom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF; const txt = buf.toString('utf8').replace(/^\uFEFF/, ''); const crlf = txt.indexOf('\r\n') > 0 && !/[^\r]\n/.test(txt); const rows = txt.split('\r\n').filter((l) => l.length > 0); return { bom, crlf, header: splitCSV(rows[0]), rows: rows.slice(1).map(splitCSV), raw: rows }; }
const CSV_TH = ['metrics_th30.csv', 'metrics_th40.csv', 'metrics_th50.csv'], CSV_W = ['metrics_w10y.csv', 'metrics_w5y.csv'];
const csvs = {}; for (const n of CSV_TH.concat(CSV_W)) csvs[n] = readCSV(path.join(PUB, n));

// ---------------------------------------------------------------- D. DATA_END everywhere
{
  const over = results.filter((r) => r.lastDate && r.lastDate > DATA_END);
  const maxLast = elig.reduce((m, r) => (r.lastDate > m ? r.lastDate : m), '');
  check(over.length === 0 && maxLast === DATA_END, 'D. every results row lastDate <= ' + DATA_END + ' (over=' + over.length + ') and max(lastDate over eligible) === ' + DATA_END + ' (' + maxLast + ')');
  check(benchmarks.every((b) => b.lastDate === DATA_END), 'D. benchmarks lastDate === ' + DATA_END + ' (' + benchmarks.map((b) => b.name + ' ' + b.lastDate).join(', ') + ')');
  const csvOver = [];
  for (const n of CSV_TH) { const c = csvs[n]; const i = c.header.indexOf('末根K线'); for (const row of c.rows) if (row[i] && row[i] > DATA_END) csvOver.push(n + ' ' + row[0]); }
  for (const n of CSV_W) { const c = csvs[n]; const i = c.header.indexOf('窗口末根K线'); for (const row of c.rows) if (row[i] && row[i] > DATA_END) csvOver.push(n + ' ' + row[0]); }
  check(csvOver.length === 0, 'D. every CSV 末根K线 / 窗口末根K线 <= ' + DATA_END + ' (over=' + csvOver.length + ')');
  const md = fs.readFileSync(path.join(PUB, 'report.md'), 'utf8');
  check(md.split('\n').slice(0, 8).join('\n').includes('数据截止：**' + DATA_END + '**'), 'D. report.md header states 数据截止 ' + DATA_END);
}

// ---------------------------------------------------------------- S. CSVs
{
  const windowElig = {}; for (const W of WINDOWS) windowElig[W.key] = wElig(W).length;
  function checkCSV(name, expectLines, headerMust, linkTag, eligCheck) {
    const c = csvs[name];
    const bad = /(^|,)(NaN|undefined|null|Infinity|-Infinity)(,|$)/;
    let badTok = 0, colMismatch = 0, eligBad = 0, linkBad = 0, boardBad = 0;
    const hi = { elig: c.header.indexOf('入选'), bear: c.header.indexOf('熊市均跌'), board: c.header.indexOf('板块') };
    const linkIdx = c.header.map((h, i) => (h.endsWith('看板') ? i : -1)).filter((i) => i >= 0);
    for (let i = 0; i < c.rows.length; i++) {
      const cells = c.rows[i];
      if (bad.test(c.raw[i + 1])) badTok++;
      if (cells.length !== c.header.length) colMismatch++;
      if (!BOARDS.includes(cells[hi.board])) boardBad++;
      if (eligCheck && hi.elig >= 0 && cells[hi.elig] === '1' && (!cells[hi.bear] || cells[hi.bear] === '0')) eligBad++;
      for (const li of linkIdx) if ((!eligCheck || cells[hi.elig] === '1' || cells[li]) && !cells[li].startsWith(linkTag)) linkBad++;
    }
    const hdrOk = headerMust.every((h) => c.header.includes(h)) && hi.board === 3;
    check(c.bom && c.crlf && c.rows.length === expectLines - 1 && hdrOk && badTok === 0 && colMismatch === 0 && eligBad === 0 && linkBad === 0 && boardBad === 0,
      'S. ' + name + ': BOM=' + c.bom + ' CRLF=' + c.crlf + ' rows=' + c.rows.length + '/' + (expectLines - 1) + ' 板块=col4:' + (hi.board === 3) + ' header-ok=' + hdrOk + ' badTokens=' + badTok + ' colMismatch=' + colMismatch + ' boardBad=' + boardBad + (eligCheck ? ' eligibleBearEmptyOrZero=' + eligBad : '') + ' linkNotPrefixed(' + linkTag + ')=' + linkBad);
  }
  for (const n of CSV_TH) checkCSV(n, meta.universeCount + 1, ['代码', '名称', '市场', '板块', '合格熊轮数', '熊市均跌口径', '熊市可比对数', '熊市均跌', '看板'], LINK_PREFIX, true);
  checkCSV('metrics_w10y.csv', windowElig['10y'] + 1, ['30%_综合排名', '40%_综合排名', '50%_综合排名', '窗口首根K线', '窗口起点(约定)', '板块'], LINK_PREFIX, false);
  checkCSV('metrics_w5y.csv', windowElig['5y'] + 1, ['30%_综合排名', '40%_综合排名', '50%_综合排名', '窗口首根K线', '窗口起点(约定)', '板块'], LINK_PREFIX, false);
}

// ---------------------------------------------------------------- P. report.md
const md = fs.readFileSync(path.join(PUB, 'report.md'), 'utf8');
{
  const mdLines = md.split('\n');
  let tables = 0, badPipes = 0, noBoard = 0;
  for (let i = 0; i < mdLines.length; i++) {
    if (mdLines[i].startsWith('|') && (i === 0 || !mdLines[i - 1].startsWith('|'))) {
      tables++;
      const n = (mdLines[i].match(/\|/g) || []).length;
      if (mdLines[i].includes('| 代码 |') && !mdLines[i].includes('| 板块 |')) { noBoard++; out('  table without 板块: ' + mdLines[i].slice(0, 80)); }
      let j = i; while (j < mdLines.length && mdLines[j].startsWith('|')) { if ((mdLines[j].match(/\|/g) || []).length !== n) badPipes++; j++; }
    }
  }
  check(badPipes === 0, 'P. report.md: ' + tables + ' tables, equal pipe counts per row (' + badPipes + ' bad rows)');
  check(noBoard === 0, 'P. report.md: every table with a 代码 column also has a 板块 column (' + noBoard + ' without)');
  check(!/undefined|NaN|\| null \||\| — \| — \| — \| — \| — \| — \| — \|/.test(md), 'P. report.md: no undefined / NaN / | null | / empty sanity rows');
  check(md.startsWith('# A 股全市场'), 'P. report.md title starts with "# A 股全市场" (' + mdLines[0].slice(0, 60) + ')');
  for (const h of ['## 0. 版本变更说明', '### v3 变更说明', '## 1. 概览', '## 2. 板块构成', '近 10 年同窗口榜', '近 5 年同窗口榜', 'Pareto 前沿', '跨阈值交集', '合理性校验', '结构观察', '口径与局限', LEGEND21, '沪深主板 + 创业板 + 科创板', '不含北交所']) check(md.includes(h), 'P. report.md contains "' + h + '"');
  check(!/out\/v1|out\/v2\b|_v21_compare|v1 → /.test(md), 'P. report.md has no session-only v1/v2 snapshot references');
  function tableRowsAfter(idx) { let j = idx; while (j < mdLines.length && !mdLines[j].startsWith('|')) j++; let n = 0; j += 2; while (j < mdLines.length && mdLines[j].startsWith('|')) { n++; j++; } return n; }
  const headCounts = { top50: 0, top20w: 0, boards: 0 }, rowProblems = [];
  for (let i = 0; i < mdLines.length; i++) {
    const l = mdLines[i];
    if (l.startsWith('### 综合榜 Top 50')) { headCounts.top50++; const n = tableRowsAfter(i); if (n !== 50) rowProblems.push(l + ' -> ' + n + ' rows'); }
    else if (l.startsWith('### 综合榜 Top 20 @')) { headCounts.top20w++; const n = tableRowsAfter(i); if (n !== 20) rowProblems.push(l + ' -> ' + n + ' rows'); }
    else if (/^### (稳健榜|进攻榜|穿越榜) Top 20/.test(l)) { headCounts.boards++; const n = tableRowsAfter(i); if (n !== 20) rowProblems.push(l + ' -> ' + n + ' rows'); }
  }
  check(headCounts.top50 === 5 && headCounts.top20w === 4 && headCounts.boards === 15 && rowProblems.length === 0, 'P. report.md: 5 × "综合榜 Top 50" each 50 rows, 4 × 窗口 Top 20 each 20 rows, 15 × 分榜 Top 20 each 20 rows (' + JSON.stringify(headCounts) + ')' + (rowProblems.length ? ' -> ' + rowProblems.join('; ') : ''));
  const sanSec = md.slice(md.indexOf('合理性校验（公认长牛股的名次）'), md.indexOf('### 结构观察'));
  const sanMissing = SANITY.filter(([code, board]) => !new RegExp('\\| [^|]+ \\| ' + code + ' \\| ' + board + ' \\| 入选 \\|').test(sanSec));
  check(sanMissing.length === 0, 'P. report.md 合理性校验: all 20 sanity stocks present as 入选 with board (' + sanMissing.map((x) => x[0]).join(',') + ')');
  check(sanSec.includes('不在近10年窗口'), 'P. report.md 合理性校验 states 科创板 stocks are not in the 近10年 window');
  const secC = md.slice(md.indexOf('### C. 主板 v2.1'), md.indexOf('## 3.'));
  check(['605098', '605167', '000333', '601702', '603662', '605198', '600519', '002595', '002832', '603871'].every((c) => secC.includes('| ' + c + ' |')), 'P. report.md 板块构成 table C lists the 10 main-board v2.1 Top 10 codes');
}

// ---------------------------------------------------------------- H. screen.html shell + screen/data/*.js
{
  const hp = path.join(ROOT, 'screen.html');
  const html = fs.readFileSync(hp, 'utf8');
  const bytes = Buffer.byteLength(html);
  check(bytes < 61440, 'H. screen.html shell bytes ' + bytes + ' < 60 KB (' + (bytes / 1024).toFixed(1) + ' KB)');
  check(!/<link\s+href=|fetch\(/.test(html) && html.includes("'screen/data/'"), 'H. screen.html: no <link href / fetch(; loads screen/data/ via injected <script>');
  check(!/__META__|__KEYS__|__DATA__|__WIN__|__DATA_KB__|__DASH_BASE__/.test(html), 'H. screen.html: no leftover template placeholders');
  check(html.includes("const DASH_BASE = './index.html';"), "H. screen.html: DASH_BASE = './index.html'");
  check(html.includes('id="status"'), 'H. screen.html: #status line present');
  check(html.includes('<canvas id="scatter"'), 'H. screen.html: scatter is a <canvas id="scatter">');
  check(html.includes('id="showAll"') && html.includes('const PAGE = 100'), 'H. screen.html: paged table (const PAGE = 100 + #showAll button)');
  check(html.includes('if (e.isComposing || e.keyCode === 229) return;'), 'H. screen.html: IME guard on Enter in the jump box');
  check(['data-win="all"', 'data-win="10y"', 'data-win="5y"', 'id="winSeg"', 'id="thSeg"', 'data-th="0.3"', 'data-th="0.4"', 'data-th="0.5"'].every((s) => html.includes(s)), 'H. screen.html: 区间 / 阈值 toggle markup present');
  check(html.includes('id="boardSeg"') && ['data-board="主板"', 'data-board="创业板"', 'data-board="科创板"'].every((s) => html.includes(s)), 'H. screen.html: 板块 multi-select (boardSeg + 3 data-board checkboxes)');
  check(html.includes('排名、百分位、综合分在全部板块（沪深主板 + 创业板 + 科创板）的入选个股内统一计算；板块筛选只影响显示的行，不重新排名'), 'H. screen.html footer states ranks are global over all boards');
  check(html.includes(LEGEND21), 'H. screen.html contains v2.1 legend');
  const scr = html.match(/<script>([\s\S]*?)<\/script>/);
  let compiled = false; try { new vm.Script(scr[1]); compiled = true; } catch (e) { out('  script compile error: ' + e.message); }
  check(compiled, 'H. screen.html inline script compiles (vm.Script)');
  check(html.includes("'&r=' + state.win"), 'H. screen.html dash() uses state.win as 看板 range');
  check(html.includes('state.boards.has(r.board)'), 'H. screen.html filters rows by state.boards');
  // screen/data/*.js：纯 JS 赋值文件，在空 window 沙箱里执行后读取
  const DATA_DIR = path.join(PUB, 'data');
  const loadJS = (f) => { const ctx = { window: {} }; vm.runInNewContext(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'), ctx); return ctx.window; };
  const VIEW_KEYS = ['all'].concat(WINDOWS.map((W) => W.key));
  const thName = (w, T) => w + '_th' + Math.round(+T * 100) + '.js';
  const expectFiles = ['meta.js'].concat(VIEW_KEYS.map((w) => w + '.js')).concat(VIEW_KEYS.flatMap((w) => THS.map((T) => thName(w, T)))).sort();
  const haveFiles = exists(DATA_DIR) ? fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.js')).sort() : [];
  check(haveFiles.length === 13 && JSON.stringify(haveFiles) === JSON.stringify(expectFiles), 'H. screen/data has exactly the 13 files ' + expectFiles.join(' ') + ' (found ' + haveFiles.length + ': ' + haveFiles.join(' ') + ')');
  const rd4 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
  const TH18 = ['nBull', 'nBear', 'nCB', 'nBQ', 'bearSrc', 'avgBearRet', 'avgBullRet', 'deepestBearRet', 'bullNewHighRate', 'bearHigherLowRate', 'bullTimeShare', 'curBull', 'curRet', 'composite', 'rank', 'steadyRank', 'attackRank', 'crossRank'];
  let META = null, KEYS = null;
  try { const m = loadJS('meta.js').__SCREEN_META; META = m && m.META; KEYS = m && m.KEYS; } catch (e) { out('  meta.js load error: ' + e.message); }
  check(META && KEYS && Array.isArray(KEYS.base) && Array.isArray(KEYS.th), 'H. meta.js defines window.__SCREEN_META.{META,KEYS}');
  if (META && KEYS) {
    check(KEYS.base[3] === 'board' && JSON.stringify(KEYS.winBase) === JSON.stringify(KEYS.base.slice(6)) && !KEYS.winBase.includes('board'), 'H. KEYS.base has board at index 3; winBase deep-equals base.slice(6) (' + KEYS.winBase.length + ' = ' + KEYS.base.length + ' − 6)');
    check(JSON.stringify(KEYS.th) === JSON.stringify(TH18), 'H. KEYS.th is the 18-name threshold list in order');
    check(!KEYS.base.includes('vol') && !KEYS.base.includes('roll5yMedian') && !KEYS.base.includes('roll5yWin'), 'H. KEYS.base carries no never-read fields (vol / roll5yMedian / roll5yWin)');
    check(KEYS.dict && KEYS.dict.industry === 'industries' && Array.isArray(META.industries) && META.industries.length > 0, 'H. KEYS.dict.industry === industries and META.industries is a non-empty array (' + (META.industries || []).length + ' entries)');
    check(META.version === String(meta.version).replace(/^v/, '') && META.dataEndDate === DATA_END && META.eligible === elig.length && META.universe === results.length && META.boards && BOARDS.every((b) => META.boards[b] && META.boards[b].eligible === elig.filter((r) => r.board === b).length), 'H. META: version ' + META.version + ', dataEndDate ' + META.dataEndDate + ', universe ' + META.universe + ', eligible ' + META.eligible + ', boards ' + JSON.stringify(META.boards));
    check(META.benchmarks && VIEW_KEYS.every((k) => META.benchmarks[k] && META.benchmarks[k].length === 2), 'H. META.benchmarks all/10y/5y × 2');
    const ki = (k) => KEYS.base.indexOf(k), rankIdx = KEYS.th.indexOf('rank'), abrIdx = KEYS.th.indexOf('avgBearRet'), compIdx = KEYS.th.indexOf('composite');
    const dataOf = (f) => { const d = loadJS(f).__SCREEN_DATA || {}; return d[f.replace(/\.js$/, '')]; };
    // all.js
    const ALL = dataOf('all.js') || [];
    const allBad = [];
    if (ALL.length !== elig.length) allBad.push('length ' + ALL.length + ' != ' + elig.length);
    for (let i = 0; i < Math.min(ALL.length, elig.length); i++) {
      const a = ALL[i], r = elig[i];
      if (!a || a.length !== KEYS.base.length) { allBad.push(i + ' row length'); continue; }
      if (a[0] !== r.code || a[2] !== r.secid || a[3] !== r.board || META.industries[a[4]] !== (r.industry || '')) allBad.push(i + ' identity/industry');
      if (a[ki('cagr')] !== rd4(r.cagr) || a[ki('maxDD')] !== rd4(r.maxDD)) allBad.push(i + ' cagr/maxDD');
    }
    check(allBad.length === 0, 'H. all.js: ' + ALL.length + ' rows === eligible ' + elig.length + ', each ' + KEYS.base.length + ' values; code / secid / board / industry(dict) / cagr / maxDD match results.json (' + allBad.length + ' problems' + (allBad.length ? ': ' + allBad.slice(0, 5).join('; ') : '') + ')');
    const bcH = {}; for (const a of ALL) if (a) bcH[a[3]] = (bcH[a[3]] || 0) + 1;
    check(BOARDS.every((b) => bcH[b] === elig.filter((r) => r.board === b).length), 'H. all.js board counts ' + JSON.stringify(bcH) + ' match eligible per board');
    // window base files + all threshold files
    for (const w of VIEW_KEYS) {
      const W = WINDOWS.find((x) => x.key === w);
      const view = (r) => (w === 'all' ? r : r.windows && r.windows[w] ? r.windows[w] : null);
      const nExp = w === 'all' ? elig.length : wElig(W).length;
      if (w !== 'all') {
        const B = dataOf(w + '.js') || [];
        const bad = [];
        if (B.length !== elig.length) bad.push('length ' + B.length);
        let nn = 0;
        for (let i = 0; i < Math.min(B.length, elig.length); i++) {
          const a = B[i], v = view(elig[i]);
          if ((a != null) !== (v != null)) { bad.push(i + ' null-ness'); continue; }
          if (!a) continue;
          nn++;
          if (a.length !== KEYS.winBase.length) bad.push(i + ' row length ' + a.length);
          else if (a[KEYS.winBase.indexOf('cagr')] !== rd4(v.cagr)) bad.push(i + ' cagr');
        }
        check(bad.length === 0 && nn === nExp, 'H. ' + w + '.js: length ' + B.length + ' (aligned to eligible), non-null ' + nn + ' === window eligible ' + nExp + ', each ' + KEYS.winBase.length + ' values, cagr matches (' + bad.length + ' problems' + (bad.length ? ': ' + bad.slice(0, 5).join('; ') : '') + ')');
      }
      for (const T of THS) {
        const f = thName(w, T), A = dataOf(f) || [];
        const bad = [];
        if (A.length !== elig.length) bad.push('length ' + A.length);
        const ranks = [];
        for (let i = 0; i < Math.min(A.length, elig.length); i++) {
          const a = A[i], v = view(elig[i]);
          if ((a != null) !== (v != null)) { bad.push(i + ' null-ness'); continue; }
          if (!a) continue;
          if (a.length !== 18) { bad.push(i + ' length ' + a.length); continue; }
          const t = v.th[T];
          if (a[abrIdx] !== rd4(t.avgBearRet) || a[compIdx] !== rd4(t.composite) || a[rankIdx] !== t.rank) bad.push(i + ' avgBearRet/composite/rank');
          ranks.push(a[rankIdx]);
        }
        ranks.sort((x, y) => x - y);
        const ranksOk = ranks.length === nExp && ranks.every((v, i) => v === i + 1);
        check(bad.length === 0 && ranksOk, 'H. ' + f + ': aligned to eligible (' + A.length + '), ' + ranks.length + ' non-null × 18 values, ranks 1..' + nExp + ' (' + ranksOk + '), avgBearRet / composite / rank match results.json (' + bad.length + ' problems' + (bad.length ? ': ' + bad.slice(0, 5).join('; ') : '') + ')');
      }
    }
  }
  // 首屏传输量：Pages 走 gzip，壳 + meta.js + all.js + all_th30.js 压缩后 ≤ 500 KB
  const startupFiles = ['meta.js', 'all.js', 'all_th30.js'].map((f) => path.join(DATA_DIR, f));
  const gz = (p) => (exists(p) ? zlib.gzipSync(fs.readFileSync(p), { level: 6 }).length : 0);
  const startupGz = gz(hp) + startupFiles.reduce((s, p) => s + gz(p), 0);
  const startupRaw = bytes + startupFiles.reduce((s, p) => s + (exists(p) ? fs.statSync(p).size : 0), 0);
  check(startupGz > 0 && startupGz <= 512000, 'H. startup payload (screen.html + meta.js + all.js + all_th30.js) gzip-6 ' + startupGz + ' bytes <= 512000 (raw ' + startupRaw + ' bytes)');
}

// ---------------------------------------------------------------- E. wording
{
  const files = [['report.md', path.join(PUB, 'report.md')], ['screen.html', path.join(ROOT, 'screen.html')], ['screen/README.md', path.join(PUB, 'README.md')], ['screen/data/meta.js', path.join(PUB, 'data', 'meta.js')]];
  for (const [name, p] of files) {
    if (!exists(p)) { check(false, 'E. ' + name + ' missing'); continue; }
    const txt = fs.readFileSync(p, 'utf8');
    const hits = BAD_WORDS.filter((s) => txt.indexOf(s) >= 0);
    check(hits.length === 0, 'E. ' + name + ' contains none of ' + BAD_WORDS.join(' / ') + (hits.length ? ' -> found: ' + hits.join(', ') : ''));
  }
  check(md.includes('v3 变更说明') && md.includes('## 2. 板块构成'), 'E. report.md has v3 变更说明 and 板块构成 sections');
}

// ---------------------------------------------------------------- V. regression vs previous outputs (--prev)
if (PREV) {
  const TH_COLS = ['年化', '最大回撤', '累计收益', 'Calmar', '熊市均跌', '最深熊市', '牛市均涨', '牛市新高率', '底部抬高率', '合格熊轮数', '熊市均跌口径', '滚动5年P10', '首根K线', '末根K线', 'K线数'];
  const W_COLS = ['年化', '最大回撤', '30%_熊市均跌', '40%_熊市均跌', '50%_熊市均跌'];
  const idx = (c) => { const m = {}; c.header.forEach((h, i) => { m[h] = i; }); return m; };
  for (const [name, cols, isTh] of [['metrics_th30.csv', TH_COLS, true], ['metrics_th40.csv', TH_COLS, true], ['metrics_th50.csv', TH_COLS, true], ['metrics_w10y.csv', W_COLS, false], ['metrics_w5y.csv', W_COLS, false]]) {
    const pp = path.join(PREV, name);
    if (!exists(pp)) { check(false, 'V. prev ' + name + ' missing in ' + PREV); continue; }
    const prev = readCSV(pp), cur = csvs[name];
    const pi = idx(prev), ci = idx(cur);
    const curBy = new Map(cur.rows.map((r) => [r[ci.secid], r]));
    let n = 0, missing = 0, notElig = 0, diff = 0, rankChanged = 0; const diffs = [];
    const rankCol = isTh ? '综合排名' : '30%_综合排名';
    for (const r of prev.rows) {
      if (isTh && r[pi['入选']] !== '1') continue;
      n++;
      const c = curBy.get(r[pi.secid]);
      if (!c) { missing++; diffs.push(r[pi.secid] + ' missing'); continue; }
      if (isTh && c[ci['入选']] !== '1') { notElig++; diffs.push(r[pi.secid] + ' no longer eligible: ' + c[ci['剔除原因']]); continue; }
      for (const k of cols) if (r[pi[k]] !== c[ci[k]]) { diff++; diffs.push(r[pi.secid] + ' ' + k + ' ' + r[pi[k]] + ' -> ' + c[ci[k]]); break; }
      if (r[pi[rankCol]] !== c[ci[rankCol]]) rankChanged++;
    }
    check(missing === 0 && notElig === 0 && diff === 0, 'V. ' + name + ': ' + n + ' previously eligible rows all present & eligible with identical ' + cols.join('/') + ' (missing=' + missing + ', notEligible=' + notElig + ', valueDiffs=' + diff + '); ' + rankCol + ' changed for ' + rankChanged + ' (expected: ranks move, values do not)');
    for (const d of diffs.slice(0, 20)) out('  ' + d);
    if (isTh) { const curElig = cur.rows.filter((r) => r[ci['入选']] === '1' && r[ci['板块']] === '主板').length; check(curElig === n, 'V. ' + name + ': current 主板 eligible rows ' + curElig + ' === previous eligible ' + n); }
  }
} else out('SKIP V. no --prev given');

// 汇总行：有 FAIL → "N FAIL"；无 FAIL 但有 WARN → "PASS WITH N WARN"（退出码仍为 0，WARN 不阻断）；否则 "ALL PASS"
const summary = (nFail ? nFail + ' FAIL' : nWarn ? 'PASS WITH ' + nWarn + ' WARN' : 'ALL PASS') + ' (' + nPass + ' pass, ' + nFail + ' fail, ' + nWarn + ' warn)';
out(summary);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'screen_verify.log'), lines.join('\n') + '\n', 'utf8');
process.stdout.write(lines.join('\n') + '\n');
process.exit(nFail ? 1 : 0);
