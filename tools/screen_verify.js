#!/usr/bin/env node
/* v3 产出校验：读取 screen/run_meta.json、screen/universe.json、screen/out/results.json、screen/out/benchmarks.json、screen/metrics_*.csv、
 * screen/report.md、screen.html、screen/README.md 与 screen/out/klines，逐条 PASS/FAIL 写入 screen/out/screen_verify.log（同时打印），
 * 末行 ALL PASS / PASS WITH N WARN（WARN = 已注明的数据缺口，或口径性质导致的合理性界限越界（Y4 股息率 Top 20），不阻断）/ N FAIL；退出码 1 = 有 FAIL。
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
 *   Y. 分红指标（v3.1；run_meta.dividends 存在且未被 --no-dividends 关闭时执行，否则 SKIP）：
 *      Y1 字段 / 单位：600519 事件表含每股税前 30.876@2024-06-19 / 23.882@2024-12-20 / 27.673@2025-06-26、2023-12 恰有一笔补齐（hfq）事件 19.106 ± 0.05、除息日严格递增；全市场无重复 ex|cash|split；
 *         fetch_fieldcheck.md（--fieldcheck <path>，缺省取 --baseline 上级目录的 evidence\fetch_fieldcheck.md）ALL PASS 且含 10派276.73元 / cninfo 公告标题确认
 *      Y2 覆盖：screen/out/dividends 与 raw_monthly 覆盖全部入选（缺失 ≤ 10 / 0，列出代码）、rawCloseDate = DATA_END 占比 ≥ 99%、失败文件长度（失败 secid 均已有缓存）、done 标记
 *      Y3 合理性：divYieldTTM 中位 ∈ [0.5%, 3.5%]（含四分位 / P90）、最大 ≤ 25%（列出前 5 及其近 12 月事件）、601398/601288/601088/600900 ∈ [2%, 9%]、600900/600519 连续分红 ≥ 20、
 *         FY(last−9)–FY(last) 10/10 占比 ∈ [25%, 60%]、零分红个股 ≥ 1、连续分红直方图与 run_meta 一致
 *      Y4 再投资一致性：上市至今 median |cagrTR − cagr| < 0.5pp（P90 / max）、股息率 Top 20 的 cagrTR ≥ cagr − 0.1pp（warn：下跌个股再投资低于加性后复权是口径性质；check 越界者均为下跌型）、
 *         各视图 trFlag 计数与 |cagrTR − cagrHfqAligned| 统计 == run_meta、trFlag 语义（recon_drift / px_missing 置空；hfq_gap ⇔ 差值 > TR_GAP_MAX；divContrib = cagrTR − cagrPx）
 *      Y5 结构：每入选行每视图 div 键集相同（25 键）、dividendRank 1..n 且三阈值相同、门槛（data ok 且连续分红 ≥ STREAK_MIN）、缺失行指标为空、compositeN ≤ 6、比率 ≤ 4 位小数
 *      Y6 数据文件：KEYS.base 以新键结尾（payoutRatio ⇔ hasPayout）、KEYS.th 18、all/10y/5y 分红值逐行 == results.json（r4）、META.hasPayout / div == run_meta
 *      Y7 report.md：红利榜 Top 50（50 行）、2 × 红利榜 Top 20（20 行）、2 × 现有综合榜 Top 50 的分红贡献（50 行）、v3.1 变更说明、分红与股息 为倒数第二节、首行 = 红利榜第 1 名
 *      Y8 壳：#onlyDiv / #minStreak / #showDiv、分红列标签、页脚口径、首屏 gzip（打印字节数）
 *   V. --prev <dir>：与上一版 metrics_th30|40|50.csv / metrics_w10y|w5y.csv 逐只回归（入选个股的 年化 / 最大回撤 / 熊市均跌 等字段逐字相同；名次允许变化）
 *   Z. --baseline <dir>（v3.1）：与 v3 基线产出逐字节 / 逐格比对 —— 5 个 CSV：基线表头是新表头的严格前缀、行数相同、每行前 K 格（K = 基线列数）逐格相同，列出追加的列；
 *      9 个 screen/data/*_th*.js SHA-256 相同；all.js / 10y.js / 5y.js 行数相同、每行前 oldKeys.length 个值相同且空值位置相同（oldKeys 取基线 meta.js 的 KEYS.base / KEYS.winBase）；
 *      meta.js KEYS.th 相同、新 KEYS.base 以旧 KEYS.base 为前缀。<dir> 可以是仓库根目录的镜像（含 screen/…）或 screen/ 目录本身
 * 用法（仓库根目录）：node tools/screen_verify.js [--prev <dir>] [--expect-data-end YYYY-MM-DD] [--baseline <dir>] [--fieldcheck <path>]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const crypto = require('crypto');
const E = require('../app.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'screen', 'out');
const PUB = path.join(ROOT, 'screen');
const argv = process.argv.slice(2);
const argVal = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const PREV = argVal('--prev');
const EXPECT_END = argVal('--expect-data-end');
const BASELINE = argVal('--baseline');
const FIELDCHECK = argVal('--fieldcheck');
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
  check(/^v3(\.\d+)?$/.test(String(meta.version)), 'M. run_meta.version matches v3(.x) (' + meta.version + ')');
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

// ---------------------------------------------------------------- Y. dividends (v3.1; only when run_meta.dividends exists)
// 分红指标校验：Y1 字段 / 单位（600519）、Y2 覆盖（两类缓存）、Y3 合理性区间、Y4 再投资年化与后复权年化的一致性、Y5 结构、Y6 数据文件、Y7 report.md、Y8 壳。
// 区间类断言（Y3 / Y4）是对真实数据的合理性界限：越界时先核对被点名的个股事件，只有确认是代码错误才改代码。
const DS = meta.dividends && meta.dividendsEnabled !== false ? meta.dividends : null;
if (DS) {
  const DCFG = DS.config || {};
  const LAST_FY = DS.lastFY != null ? DS.lastFY : +String(DATA_END).slice(0, 4) - 1;
  const STREAK_MIN = DCFG.STREAK_MIN_FOR_BOARD != null ? DCFG.STREAK_MIN_FOR_BOARD : 3;
  const DIV_DIR = exists(path.join(OUT, 'dividends')) ? path.join(OUT, 'dividends') : DCFG.DIR || path.join(OUT, 'dividends');
  const PX_DIR = exists(path.join(OUT, 'raw_monthly')) ? path.join(OUT, 'raw_monthly') : DCFG.PRICE_DIR || path.join(OUT, 'raw_monthly');
  const VIEWS = [['all', (r) => r]].concat(WINDOWS.map((W) => [W.key, (r) => (r.windows && r.windows[W.key]) || null]));
  const dOf = (r, view) => { const v = view(r); return v && v.div ? v.div : null; };
  const dOk = (d) => !!d && d.data === 'ok';
  const rd4 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
  const quant = (sorted, q) => { const m = sorted.length; if (!m) return null; const pos = q * (m - 1), lo = Math.floor(pos), hi = Math.min(m - 1, lo + 1); return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo); }; // 与 screen_all.js quantile 相同的线性插值
  const stat = (arr) => { const s = arr.slice().sort((a, b) => a - b); return s.length ? { n: s.length, median: rd4(quant(s, 0.5)), p90: rd4(quant(s, 0.9)), max: rd4(s[s.length - 1]) } : { n: 0, median: null, p90: null, max: null }; };
  const byCode = (code) => elig.find((r) => r.code === code);
  const pct = (x) => (x == null ? '—' : (x * 100).toFixed(2) + '%');
  const payingFYs = (r) => { const s = new Set(); for (const e of r.divEvents || []) if (e.cash > 0 && e.fy <= LAST_FY) s.add(e.fy); return s; };
  out('  info: Y. run_meta.dividends: lastFY ' + LAST_FY + ', ttmRange ' + JSON.stringify(DS.ttmRange) + ', dataOk ' + DS.dataOk + ' / dataMissing ' + DS.dataMissing + ' / dataError ' + DS.dataError + ', pxOk ' + DS.pxOk + ' / pxMissing ' + DS.pxMissing + ', synthEvents ' + DS.synthEvents + ' in ' + DS.stocksWithSynth + ' stocks, driftStocks ' + DS.driftStocks + ', hasPayout ' + DS.hasPayout + ' (' + DS.hasPayoutReason + '), boardSizes ' + JSON.stringify(DS.boardSizes));

  // Y1. 字段 / 单位：600519 事件表（每股税前 = PRETAX_BONUS_RMB ÷ 10；补齐事件 src 'hfq'）
  {
    const r = byCode('600519');
    const ev = (r && r.divEvents) || [];
    const has = (ex, cash) => ev.some((e) => e.ex === ex && e.src === 'table' && near(e.cash, cash, 1e-6));
    const want = [['2024-06-19', 30.876], ['2024-12-20', 23.882], ['2025-06-26', 27.673]];
    const missing = want.filter(([ex, c]) => !has(ex, c));
    check(!!r && dOk(r.div) && missing.length === 0, 'Y1. 600519 events carry the per-share pre-tax cash 30.876 @2024-06-19 / 23.882 @2024-12-20 / 27.673 @2025-06-26 (PRETAX_BONUS_RMB ÷ 10; events ' + ev.length + ', table ' + ev.filter((e) => e.src === 'table').length + ', missing: ' + (missing.map((m) => m.join('@')).join(', ') || 'none') + ')');
    const synth = ev.filter((e) => e.src === 'hfq');
    const s2312 = synth.filter((e) => e.ex.startsWith('2023-12'));
    check(s2312.length === 1 && near(s2312[0].cash, 19.106, 0.05) && s2312[0].fy === 2023, 'Y1. 600519 has exactly one synthesised (src hfq) event in 2023-12 with cash 19.106 ± 0.05 and fy 2023 (synth events ' + synth.length + ': ' + synth.map((e) => e.ex + ' ' + e.cash + ' fy' + e.fy).join('; ') + '; divStreak ' + (r && r.div ? r.div.divStreak : '-') + ', dpsTTM ' + (r && r.div ? r.div.dpsTTM : '-') + ', divYieldTTM ' + (r && r.div ? r.div.divYieldTTM : '-') + ')');
    let inc = true; for (let i = 1; i < ev.length; i++) if (!(ev[i].ex > ev[i - 1].ex)) inc = false;
    check(ev.length > 0 && inc, 'Y1. 600519 ex-dates strictly increasing over ' + ev.length + ' events (' + (ev.length ? ev[0].ex + ' … ' + ev[ev.length - 1].ex : '-') + ')');
    let dup = 0, nonMono = 0, nEv = 0, withEv = 0, nSynth = 0;
    for (const x of elig) {
      const es = x.divEvents || []; if (!es.length) continue; withEv++;
      const seen = new Set();
      for (let i = 0; i < es.length; i++) { nEv++; if (es[i].src === 'hfq') nSynth++; const k = es[i].ex + '|' + es[i].cash + '|' + es[i].split; if (seen.has(k)) dup++; seen.add(k); if (i > 0 && es[i].ex < es[i - 1].ex) nonMono++; }
    }
    check(dup === 0 && nonMono === 0 && nSynth === DS.synthEvents, 'Y1. all eligible: no duplicate ex|cash|split event over ' + nEv + ' events in ' + withEv + ' stocks (dup=' + dup + '), ex-dates non-decreasing (violations=' + nonMono + '), synthesised events ' + nSynth + ' == run_meta synthEvents ' + DS.synthEvents);
    const fcPath = FIELDCHECK || (BASELINE ? path.join(path.dirname(path.resolve(BASELINE)), 'evidence', 'fetch_fieldcheck.md') : null);
    if (fcPath && exists(fcPath)) {
      const fc = fs.readFileSync(fcPath, 'utf8');
      check(/ALL PASS \(\d+ pass, 0 fail\)/.test(fc) && fc.includes('10派276.73元') && fc.includes('2024年年度权益分派实施公告') && fc.includes('308.76') && fc.includes('238.82'), 'Y1. fetch_fieldcheck.md present with ALL PASS, the 10派276.73元 / 308.76 / 238.82 confirmations and the cninfo 2024年年度权益分派实施公告 title (' + fcPath + ')');
    } else out('SKIP Y1. fetch_fieldcheck.md not located (' + (fcPath || 'no --fieldcheck / --baseline given') + ')');
  }

  // Y2. 覆盖：两类缓存对全部入选个股的覆盖、不复权收盘日 = DATA_END 的比例、拉数失败 / done 文件
  {
    const missDiv = [], missPx = [];
    for (const r of elig) { if (!exists(path.join(DIV_DIR, r.secid + '.json'))) missDiv.push(r.code); if (!exists(path.join(PX_DIR, r.secid + '.json'))) missPx.push(r.code); }
    const nFiles = (d) => (exists(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json')).length : 0);
    const cnt = { ok: 0, missing: 0, error: 0, pxOk: 0, pxMissing: 0 };
    for (const r of elig) { const d = r.div; if (!d) { cnt.missing++; cnt.pxMissing++; continue; } if (d.data === 'ok') cnt.ok++; else if (d.data === 'error') cnt.error++; else cnt.missing++; if (d.px === 'ok') cnt.pxOk++; else cnt.pxMissing++; }
    check(missDiv.length <= 10 && cnt.missing === missDiv.length && cnt.error === 0 && DS.dataOk === cnt.ok && DS.dataMissing === cnt.missing && DS.dataError === cnt.error, 'Y2. dividend caches (' + DIV_DIR + ': ' + nFiles(DIV_DIR) + ' files) cover eligible ' + elig.length + ': missing ' + missDiv.length + ' (expect 0–10' + (missDiv.length ? ': ' + missDiv.slice(0, 10).join(',') : '') + '); rows div.data ok/missing/error ' + cnt.ok + '/' + cnt.missing + '/' + cnt.error + ' == run_meta ' + DS.dataOk + '/' + DS.dataMissing + '/' + DS.dataError);
    check(missPx.length === 0 && cnt.pxOk === DS.pxOk && cnt.pxMissing === DS.pxMissing, 'Y2. raw_monthly caches (' + PX_DIR + ': ' + nFiles(PX_DIR) + ' files) cover all eligible: missing ' + missPx.length + (missPx.length ? ' (' + missPx.slice(0, 10).join(',') + ')' : '') + '; rows div.px ok/missing ' + cnt.pxOk + '/' + cnt.pxMissing + ' == run_meta ' + DS.pxOk + '/' + DS.pxMissing);
    const okRows = elig.filter((r) => dOk(r.div));
    const atEnd = okRows.filter((r) => r.div.rawCloseDate === DATA_END).length;
    const noEnd = okRows.filter((r) => r.div.rawCloseEnd == null).length;
    const other = okRows.filter((r) => r.div.rawCloseEnd != null && r.div.rawCloseDate !== DATA_END);
    check(okRows.length > 0 && atEnd / okRows.length >= 0.99 && noEnd === DS.rawCloseEndMissing, 'Y2. rawCloseDate === ' + DATA_END + ' for ' + atEnd + '/' + okRows.length + ' = ' + (okRows.length ? (atEnd / okRows.length * 100).toFixed(2) : '0') + '% of data-ok rows (≥ 99%); rawCloseEnd missing ' + noEnd + ' (run_meta ' + DS.rawCloseEndMissing + '); earlier close date ' + other.length + (other.length ? ' e.g. ' + other.slice(0, 5).map((r) => r.code + '@' + r.div.rawCloseDate).join(' ') : ''));
    const failInfo = [], unresolved = [];
    for (const [f, dir] of [['fetch_failures_dividends.json', DIV_DIR], ['fetch_failures_prices.json', PX_DIR]]) {
      const p = path.join(OUT, f);
      if (!exists(p)) { failInfo.push(f + ' absent'); continue; }
      let arr; try { arr = readJSON(p); } catch (e) { failInfo.push(f + ' unparsable'); continue; }
      if (!Array.isArray(arr)) arr = [];
      failInfo.push(f + ' length ' + arr.length);
      for (const x of arr) if (x && x.secid && !exists(path.join(dir, x.secid + '.json'))) unresolved.push(f.replace(/^fetch_failures_|\.json$/g, '') + ':' + (x.code || x.secid));
    }
    check(unresolved.length === 0, 'Y2. fetch failure files: ' + failInfo.join(', ') + '; failed secids still without a cache: ' + unresolved.length + (unresolved.length ? ' (' + unresolved.slice(0, 10).join(',') + ')' : ''));
    for (const f of ['fetch_done_dividends.json', 'fetch_done_prices.json']) { const p = path.join(OUT, f); if (!exists(p)) { out('  info: ' + f + ' absent'); continue; } try { const j = readJSON(p); out('  info: ' + f + ' queue ' + j.queue + ' ok ' + j.ok + ' cached ' + j.cached + ' failed ' + j.failed + (j.empty != null ? ' empty ' + j.empty : '') + ' finishedAt ' + j.finishedAt); } catch (e) { out('  info: ' + f + ' unparsable'); } }
  }

  // Y3. 合理性：股息率分布、四只高股息股、连续分红、FY(last−9)–FY(last) 10/10 占比、零分红个股、直方图
  {
    const okPx = elig.filter((r) => dOk(r.div) && r.div.px === 'ok' && r.div.divYieldTTM != null);
    const ys = okPx.map((r) => r.div.divYieldTTM).sort((a, b) => a - b);
    const med = quant(ys, 0.5), q1 = quant(ys, 0.25), q3 = quant(ys, 0.75), p90 = quant(ys, 0.9);
    const payers = ys.filter((y) => y > 0);
    check(ys.length > 0 && med >= 0.005 && med <= 0.035 && near(rd4(med), DS.ttm.medianAll, 1e-4), 'Y3. median divYieldTTM over ' + ys.length + ' eligible with data ok & px ok = ' + pct(med) + ' ∈ [0.5%, 3.5%] (Q1 ' + pct(q1) + ', Q3 ' + pct(q3) + ', P90 ' + pct(p90) + '; payers (TTM > 0) ' + payers.length + ' median ' + pct(quant(payers, 0.5)) + '; run_meta ttm.medianAll ' + DS.ttm.medianAll + ')');
    const top = okPx.slice().sort((a, b) => b.div.divYieldTTM - a.div.divYieldTTM).slice(0, 5);
    const mx = top[0];
    check(!!mx && mx.div.divYieldTTM <= 0.25 && mx.code === DS.ttm.maxCode, 'Y3. max divYieldTTM ' + (mx ? pct(mx.div.divYieldTTM) + ' (' + mx.name + ' ' + mx.code + ', dpsTTM ' + mx.div.dpsTTM + ' / close ' + mx.div.rawCloseEnd + ')' : '—') + ' ≤ 25%; run_meta ttm.max ' + DS.ttm.max + ' ' + DS.ttm.maxCode);
    for (const r of top) out('  top-yield ' + r.name + ' ' + r.code + ' TTM ' + pct(r.div.divYieldTTM) + ' streak ' + r.div.divStreak + ' events in TTM: ' + (r.divEvents || []).filter((e) => e.ex > DS.ttmRange[0] && e.ex <= DS.ttmRange[1] && e.cash > 0).map((e) => e.ex + ' ' + e.cash + (e.src === 'hfq' ? '(hfq)' : '')).join(', '));
    const four = ['601398', '601288', '601088', '600900'].map((c) => { const r = byCode(c); return [c, r && dOk(r.div) ? r.div.divYieldTTM : null, r ? r.name : '?']; });
    check(four.every(([, y]) => y != null && y >= 0.02 && y <= 0.09), 'Y3. 601398 / 601288 / 601088 / 600900 divYieldTTM ∈ [2%, 9%]: ' + four.map(([c, y, n]) => n + ' ' + c + ' ' + pct(y)).join(', '));
    const st = ['600900', '600519'].map((c) => { const r = byCode(c); return [c, r && dOk(r.div) ? r.div.divStreak : null, r ? r.name : '?']; });
    check(st.every(([, s]) => s != null && s >= 20), 'Y3. 600900 / 600519 divStreak ≥ 20: ' + st.map(([c, s, n]) => n + ' ' + c + ' ' + s).join(', '));
    const fy0 = LAST_FY - 9;
    let listed = 0, n10 = 0, n8 = 0;
    for (const r of elig) { if (!dOk(r.div) || +r.listDate.slice(0, 4) > fy0) continue; listed++; const s = payingFYs(r); let k = 0; for (let fy = fy0; fy <= LAST_FY; fy++) if (s.has(fy)) k++; if (k === 10) n10++; if (k >= 8) n8++; }
    const share = listed ? n10 / listed : 0;
    check(listed > 0 && share >= 0.25 && share <= 0.60 && n10 === DS.paying10of10 && n8 === DS.payingGe8of10 && listed === DS.listedBy2016, 'Y3. share paying all 10 FY' + fy0 + '–FY' + LAST_FY + ' among eligible listed by ' + fy0 + ': ' + n10 + '/' + listed + ' = ' + (share * 100).toFixed(1) + '% ∈ [25%, 60%] (≥ 8/10: ' + n8 + ' = ' + (listed ? (n8 / listed * 100).toFixed(1) : '0') + '%; run_meta paying10of10 ' + DS.paying10of10 + ' / payingGe8of10 ' + DS.payingGe8of10 + ' / listedBy2016 ' + DS.listedBy2016 + ')');
    const zero = elig.filter((r) => dOk(r.div) && payingFYs(r).size === 0);
    const zeroStrict = zero.filter((r) => (r.divEvents || []).filter((e) => e.cash > 0).length === 0);
    check(zero.length >= 1 && zeroStrict.length >= 1 && zero.length === DS.zeroDividendStocks && zero.every((r) => r.div.divYears === 0 && r.div.divStreak === 0), 'Y3. zero-dividend eligible stocks (data ok, no cash event with fy ≤ ' + LAST_FY + '): ' + zero.length + ' (run_meta ' + DS.zeroDividendStocks + '), all with divYears 0 and divStreak 0; with no cash event at all: ' + zeroStrict.length + (zeroStrict.length ? ' e.g. ' + zeroStrict.slice(0, 5).map((r) => r.name + ' ' + r.code + ' ' + r.div.divYears + '/' + r.div.divN).join(', ') : ''));
    const hist = { 0: 0, '1-2': 0, '3-4': 0, '5-9': 0, '10-19': 0, '20+': 0 };
    for (const r of elig) { if (!dOk(r.div)) continue; const s = r.div.divStreak; hist[s === 0 ? '0' : s <= 2 ? '1-2' : s <= 4 ? '3-4' : s <= 9 ? '5-9' : s <= 19 ? '10-19' : '20+']++; }
    check(JSON.stringify(hist) === JSON.stringify(DS.streakHist), 'Y3. divStreak histogram from results ' + JSON.stringify(hist) + ' == run_meta.streakHist ' + JSON.stringify(DS.streakHist));
  }

  // Y4. 再投资年化一致性：上市至今 |cagrTR − cagr| 中位 < 0.5pp；股息率 Top 20 的 cagrTR ≥ cagr − 0.1pp；各视图 trFlag 计数 / |cagrTR − cagrHfqAligned| 统计与 run_meta 一致；trFlag 语义
  {
    const gapsAll = [], hfqNeCagr = [];
    for (const r of elig) { const d = r.div; if (!dOk(d) || d.cagrTR == null || r.cagr == null) continue; gapsAll.push(Math.abs(d.cagrTR - r.cagr)); if (d.cagrHfqAligned != null && Math.abs(d.cagrHfqAligned - r.cagr) > 1e-4 + 1e-9) hfqNeCagr.push(r.code); }
    const sa = stat(gapsAll), vs = (DS.trGap && DS.trGap.all && DS.trGap.all.vsCagr) || {};
    check(sa.n > 0 && sa.median < 0.005 && sa.n === vs.n && near(sa.median, vs.median, 1e-4) && near(sa.p90, vs.p90, 1e-4), 'Y4. all view: median |cagrTR − cagr| = ' + sa.median + ' < 0.005 over ' + sa.n + ' rows with cagrTR (P90 ' + sa.p90 + ', max ' + sa.max + '; run_meta trGap.all.vsCagr ' + JSON.stringify(vs) + ')');
    out('  info: all view cagrHfqAligned ≠ cagr (|Δ| > 1e-4) for ' + hfqNeCagr.length + ' of ' + sa.n + ' rows with cagrTR' + (hfqNeCagr.length ? ' e.g. ' + hfqNeCagr.slice(0, 5).join(',') : '') + ' (non-anchored stocks start at the first month-end instead of the IPO day)');
    // 股息率 Top 20：cagrTR ≥ cagr − 0.1pp 是对「上涨个股」成立的合理性界限 —— 东财后复权把现金按名义值累加（相当于持有现金），再投资则把现金换成股票：
    //   股价上涨 → 再投资 ≥ 加性口径；股价下跌（再投资价位高于终点价）→ 再投资 < 加性口径，是口径性质而非错误（report.md「后复权口径与分红再投资的差异」已说明）。
    //   因此字面界限记为 warn（附数值），而 check 的是精确不变量：越界个股必须都是下跌型（≥ 50% 的再投资价位高于送转调整后的终点收盘）。
    const top20 = elig.filter((r) => dOk(r.div) && r.div.divYieldTTM != null).sort((a, b) => b.div.divYieldTTM - a.div.divYieldTTM).slice(0, 20);
    const bad20 = top20.filter((r) => r.div.cagrTR != null && !(r.div.cagrTR >= r.cagr - 0.001));
    const na20 = top20.filter((r) => r.div.cagrTR == null);
    const reinvProfile = (r) => { // 再投资价位（除息后首个月末不复权收盘）高于 送转调整后终点收盘 的笔数
      const d = r.div, evs = (r.divEvents || []).filter((e) => e.ex > d.trStart && e.ex <= d.trEnd);
      let month;
      try { month = (readJSON(path.join(PX_DIR, r.secid + '.json')).month || []).filter((m) => String(m[0]) <= d.trEnd).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); } catch (e) { return null; }
      let n = 0, above = 0;
      for (let i = 0; i < evs.length; i++) {
        if (!(evs[i].cash > 0)) continue;
        const m = month.find((x) => String(x[0]) >= evs[i].ex); if (!m) continue;
        let sAfter = 1; for (let j = i + 1; j < evs.length; j++) sAfter *= evs[j].split;
        n++; if (+m[1] > d.rawCloseEnd * sAfter) above++;
      }
      return { n, above };
    };
    const prof = bad20.map((r) => [r, reinvProfile(r)]);
    const desc = ([r, p]) => r.name + ' ' + r.code + ' TR ' + pct(r.div.cagrTR) + ' vs cagr ' + pct(r.cagr) + ' (Δ ' + ((r.div.cagrTR - r.cagr) * 100).toFixed(2) + 'pp; reinvestment points above the split-adjusted end price ' + (p ? p.above + '/' + p.n : 'n/a') + ')';
    const anomalies = prof.filter(([, p]) => !(p && p.n > 0 && p.above / p.n >= 0.5));
    warn(bad20.length === 0, 'Y4. top-20 divYieldTTM (all view): cagrTR ≥ cagr − 0.001 holds for ' + (top20.length - na20.length - bad20.length) + '/' + (top20.length - na20.length) + ' rows with cagrTR; below the bound ' + bad20.length + (bad20.length ? ' — all falling-price cases where reinvested dividends lost value while additive hfq keeps the cash nominal: ' + prof.map(desc).join('; ') : '') + '; without cagrTR ' + na20.length + (na20.length ? ' (' + na20.map((r) => r.code + ' ' + r.div.trFlag).join(', ') + ')' : ''));
    check(anomalies.length === 0, 'Y4. top-20 divYieldTTM: every row with cagrTR < cagr − 0.001 is a falling-price case (≥ 50% of its reinvestment points above the split-adjusted end price) — anomalies ' + anomalies.length + (anomalies.length ? ': ' + anomalies.map(desc).join('; ') : '') + '; recon of the ' + bad20.length + ' below-bound rows: ' + (bad20.map((r) => r.code + ' consistent ' + r.div.recon.consistent + '/' + r.div.recon.intervals + ' unexplained ' + r.div.recon.unexplained + ' hfqAligned ' + r.div.cagrHfqAligned).join(', ') || 'none'));
    out('  info: top-20 yield: ' + top20.map((r) => r.name + ' ' + pct(r.div.divYieldTTM) + ' TR ' + (r.div.cagrTR == null ? '—/' + r.div.trFlag : (r.div.cagrTR * 100).toFixed(1) + '%') + ' cagr ' + (r.cagr * 100).toFixed(1) + '%').join('; '));
    for (const [key, view] of VIEWS) {
      const c = { hfq_gap: 0, recon_drift: 0, px_missing: 0, trend_month: 0, none: 0, other: 0 };
      const gaps = []; let n = 0;
      for (const r of elig) { const d = dOf(r, view); if (!dOk(d)) continue; n++; const f = d.trFlag == null ? 'none' : c[d.trFlag] !== undefined ? d.trFlag : 'other'; c[f]++; if (d.cagrTR != null && d.cagrHfqAligned != null) gaps.push(Math.abs(d.cagrTR - d.cagrHfqAligned)); }
      const s = stat(gaps), m = (DS.trGap && DS.trGap[key]) || {};
      const mv = (o) => (o || {})[key];
      const metaOk = c.hfq_gap === mv(DS.hfqGapStocks) && c.recon_drift === mv(DS.driftViews) && c.px_missing === mv(DS.pxMissingStocks) && c.trend_month === mv(DS.trendMonthStocks);
      check(c.other === 0 && metaOk && s.n === m.n && near(s.median, m.median, 1e-4) && near(s.p90, m.p90, 1e-4), 'Y4. view ' + key + ' (' + n + ' data-ok rows): trFlag hfq_gap ' + c.hfq_gap + ' / recon_drift ' + c.recon_drift + ' / px_missing ' + c.px_missing + ' / trend_month ' + c.trend_month + ' / none ' + c.none + ' (unknown ' + c.other + ') == run_meta hfqGapStocks ' + mv(DS.hfqGapStocks) + ' / driftViews ' + mv(DS.driftViews) + ' / pxMissingStocks ' + mv(DS.pxMissingStocks) + ' / trendMonthStocks ' + mv(DS.trendMonthStocks) + '; |cagrTR − cagrHfqAligned| n ' + s.n + ' median ' + s.median + ' P90 ' + s.p90 + ' max ' + s.max + ' (run_meta ' + JSON.stringify({ n: m.n, median: m.median, p90: m.p90, max: m.max }) + ')');
    }
    // trFlag 语义：recon_drift / px_missing → 再投资类指标为空；hfq_gap ⇔ |cagrTR − cagrHfqAligned| > TR_GAP_MAX（4 位小数的舍入容忍 1e-4）；divContrib = cagrTR − cagrPx
    let bad = 0; const ex = [];
    const gapMax = DCFG.TR_GAP_MAX != null ? DCFG.TR_GAP_MAX : 0.02;
    for (const [key, view] of VIEWS) for (const r of elig) {
      const d = dOf(r, view); if (!dOk(d)) continue;
      const nul = d.cagrTR == null && d.cagrPx == null && d.divContrib == null;
      let ok;
      if (d.trFlag === 'recon_drift' || d.trFlag === 'px_missing') ok = nul;
      else if (d.trFlag === 'hfq_gap') ok = !nul && d.cagrHfqAligned != null && Math.abs(d.cagrTR - d.cagrHfqAligned) > gapMax - 1e-4 && near(d.divContrib, d.cagrTR - d.cagrPx, 2e-4);
      else ok = !nul && d.cagrHfqAligned != null && Math.abs(d.cagrTR - d.cagrHfqAligned) <= gapMax + 1e-4 && near(d.divContrib, d.cagrTR - d.cagrPx, 2e-4);
      if (!ok) { bad++; if (ex.length < 5) ex.push(r.code + ' ' + key + ' ' + d.trFlag + ' TR ' + d.cagrTR + ' px ' + d.cagrPx + ' hfqA ' + d.cagrHfqAligned + ' contrib ' + d.divContrib); }
    }
    check(bad === 0, 'Y4. trFlag semantics over all views: recon_drift / px_missing → cagrTR, cagrPx, divContrib null; hfq_gap ⇔ |cagrTR − cagrHfqAligned| > ' + gapMax + '; divContrib = cagrTR − cagrPx (±2e-4) — violations ' + bad + (ex.length ? ': ' + ex.join('; ') : ''));
  }

  // Y5. 结构：每个入选行每个视图都有同键集的 div；dividendRank 1..n 且三阈值相同；门槛；缺失行指标为空；compositeN ≤ 6；比率 ≤ 4 位小数
  {
    const KEYS25 = ['data', 'px', 'rawCloseEnd', 'rawCloseDate', 'dpsTTM', 'divYieldTTM', 'divStreak', 'fyFrom', 'fyTo', 'divN', 'divYears', 'avgDivYield', 'payoutRatio', 'dpsCagr', 'cagrTR', 'cagrPx', 'divContrib', 'cagrHfqAligned', 'trFlag', 'trStart', 'trStartKind', 'trEnd', 'nEvents', 'nSynth', 'recon'];
    const want = JSON.stringify(KEYS25.slice().sort());
    let noDiv = 0, badKeys = 0, views = 0; const exK = [];
    for (const r of elig) for (const [key, view] of VIEWS) { const v = view(r); if (!v) continue; views++; const d = v.div; if (!d) { noDiv++; if (exK.length < 5) exK.push(r.code + ' ' + key + ' no div'); continue; } if (JSON.stringify(Object.keys(d).sort()) !== want) { badKeys++; if (exK.length < 5) exK.push(r.code + ' ' + key + ' keys ' + Object.keys(d).join(',')); } }
    check(noDiv === 0 && badKeys === 0, 'Y5. every eligible row has div in every existing view (' + views + ' views over ' + elig.length + ' rows) with the fixed ' + KEYS25.length + '-key set (missing ' + noDiv + ', wrong key set ' + badKeys + (exK.length ? ': ' + exK.join('; ') : '') + ')');
    for (const [key, view] of VIEWS) {
      const rows = elig.filter((r) => view(r));
      const probs = [];
      let nGated = null;
      for (const T of THS) {
        const gated = rows.filter((r) => view(r).th[T].dividend != null);
        const ranks = gated.map((r) => view(r).th[T].dividendRank).sort((a, b) => a - b);
        if (ranks.some((v, i) => v !== i + 1)) probs.push('T=' + T + ' dividendRank not 1..' + gated.length);
        if (rows.some((r) => (view(r).th[T].dividendRank != null) !== (view(r).th[T].dividend != null))) probs.push('T=' + T + ' dividendRank / dividend null-ness mismatch');
        if (nGated == null) nGated = gated.length; else if (nGated !== gated.length) probs.push('T=' + T + ' gated ' + gated.length + ' != ' + nGated);
        const badGate = gated.filter((r) => { const d = view(r).div; return !dOk(d) || d.divStreak == null || d.divStreak < STREAK_MIN; }).length;
        if (badGate) probs.push('T=' + T + ' ' + badGate + ' gated rows without data ok / divStreak ≥ ' + STREAK_MIN);
        const shouldGate = rows.filter((r) => { const d = view(r).div, th = view(r).th[T]; return dOk(d) && d.divStreak >= STREAK_MIN && th.pct && th.pct.divYieldTTM != null && th.pct.divStreak != null && th.pct.maxDD != null && th.dividend == null; }).length;
        if (shouldGate) probs.push('T=' + T + ' ' + shouldGate + ' rows pass the gate but have no dividend score');
        for (const r of gated) { const th = view(r).th[T]; if (!near(th.dividend, (th.pct.divYieldTTM + th.pct.divStreak + th.pct.maxDD) / 3, 1e-5)) { probs.push('T=' + T + ' dividend score != mean of the 3 pct for ' + r.code); break; } }
      }
      const diffT = rows.filter((r) => { const a = view(r).th['0.3'].dividendRank; return THS.some((T) => view(r).th[T].dividendRank !== a); }).length;
      if (diffT) probs.push('dividendRank differs across thresholds for ' + diffT + ' rows');
      if (nGated !== (DS.boardSizes || {})[key]) probs.push('gated ' + nGated + ' != run_meta boardSizes ' + (DS.boardSizes || {})[key]);
      check(probs.length === 0, 'Y5. view ' + key + ' (n=' + rows.length + '): dividendRank 1..' + nGated + ' (gated = data ok & divStreak ≥ ' + STREAK_MIN + ' & 3 pct present) at every threshold, identical across thresholds, score = mean(pct divYieldTTM, divStreak, maxDD); run_meta boardSizes ' + (DS.boardSizes || {})[key] + (probs.length ? ' -> ' + probs.slice(0, 5).join('; ') : ''));
    }
    const METRIC_KEYS = ['rawCloseEnd', 'rawCloseDate', 'dpsTTM', 'divYieldTTM', 'divStreak', 'divYears', 'avgDivYield', 'payoutRatio', 'dpsCagr', 'cagrTR', 'cagrPx', 'divContrib', 'cagrHfqAligned', 'trStart', 'trStartKind', 'trEnd', 'nEvents', 'nSynth'];
    let nMiss = 0, missBad = 0; const exM = [];
    for (const r of elig) for (const [key, view] of VIEWS) { const d = dOf(r, view); if (!d || d.data === 'ok') continue; nMiss++; const nn = METRIC_KEYS.filter((k) => d[k] != null); if (nn.length) { missBad++; if (exM.length < 5) exM.push(r.code + ' ' + key + ' ' + nn.join(',')); } }
    check(missBad === 0, 'Y5. views with div.data !== ok: ' + nMiss + '; all their metric fields null (violations ' + missBad + (exM.length ? ': ' + exM.join('; ') : '') + ')');
    let maxN = 0, pctMissing = 0;
    for (const r of elig) for (const [, view] of VIEWS) { const v = view(r); if (!v) continue; for (const T of THS) { const th = v.th[T]; if (th.compositeN > maxN) maxN = th.compositeN; if (!th.pct || !('divYieldTTM' in th.pct) || !('divStreak' in th.pct)) pctMissing++; } }
    check(maxN <= 6 && pctMissing === 0, 'Y5. compositeN max ' + maxN + ' ≤ 6 (zero-weight divYieldTTM / divStreak not counted) and th.pct carries divYieldTTM / divStreak in every view × threshold cell (missing ' + pctMissing + ')');
    const RATIO_KEYS = ['dpsTTM', 'divYieldTTM', 'avgDivYield', 'payoutRatio', 'dpsCagr', 'cagrTR', 'cagrPx', 'divContrib', 'cagrHfqAligned'];
    let dpBad = 0, nVals = 0; const exD = [];
    for (const r of elig) for (const [key, view] of VIEWS) { const d = dOf(r, view); if (!d) continue; for (const k of RATIO_KEYS) { const x = d[k]; if (x == null) continue; nVals++; if (typeof x !== 'number' || !isFinite(x) || Math.round(x * 1e4) / 1e4 !== x) { dpBad++; if (exD.length < 5) exD.push(r.code + ' ' + key + ' ' + k + '=' + x); } } }
    check(dpBad === 0, 'Y5. ratios (' + RATIO_KEYS.join('/') + ') have ≤ 4 decimals: ' + nVals + ' values, violations ' + dpBad + (exD.length ? ': ' + exD.join('; ') : ''));
  }

  // Y6. 数据文件：KEYS.base 以新键结尾（payoutRatio ⇔ hasPayout）；KEYS.th 18；all/10y/5y 的分红值与 results.json（r4）逐行相同；META.hasPayout / div 与 run_meta 一致
  {
    const DATA_DIR = path.join(PUB, 'data');
    const loadJSY = (f) => { const ctx = { window: {} }; vm.runInNewContext(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'), ctx); return ctx.window; };
    let META = null, KEYS = null;
    try { const m = loadJSY('meta.js').__SCREEN_META; META = m.META; KEYS = m.KEYS; } catch (e) { out('  meta.js load error: ' + e.message); }
    if (META && KEYS) {
      const tail = ['divYieldTTM', 'divYears', 'divN', 'divStreak', 'avgDivYield'].concat(DS.hasPayout ? ['payoutRatio'] : []).concat(['divContrib', 'dividendRank', 'divMiss']);
      const got = KEYS.base.slice(-tail.length);
      check(JSON.stringify(got) === JSON.stringify(tail) && KEYS.th.length === 18 && KEYS.base.includes('payoutRatio') === !!DS.hasPayout, 'Y6. meta.js KEYS.base (' + KEYS.base.length + ') ends with ' + tail.join(',') + ' (got ' + got.join(',') + '); KEYS.th ' + KEYS.th.length + ' = 18; payoutRatio key present ⇔ hasPayout ' + DS.hasPayout);
      check(META.hasPayout === !!DS.hasPayout && !!META.div && META.div.lastFY === LAST_FY && META.div.ttmFrom === DS.ttmRange[0] && META.div.ttmTo === DS.ttmRange[1] && META.div.streakMin === STREAK_MIN && META.div.dataMissing === DS.dataMissing && META.div.synthEvents === DS.synthEvents, 'Y6. META.hasPayout ' + META.hasPayout + ' == run_meta ' + DS.hasPayout + '; META.div ' + JSON.stringify(META.div) + ' matches run_meta (lastFY ' + LAST_FY + ', ttmRange ' + JSON.stringify(DS.ttmRange) + ', streakMin ' + STREAK_MIN + ', dataMissing ' + DS.dataMissing + ', synthEvents ' + DS.synthEvents + ')');
      const dataOf = (f) => { const d = loadJSY(f).__SCREEN_DATA || {}; return d[f.replace(/\.js$/, '')]; };
      for (const [key, view] of VIEWS) {
        const f = key + '.js', keys = key === 'all' ? KEYS.base : KEYS.winBase, A = dataOf(f) || [];
        const idx = {}; for (const k of tail) idx[k] = keys.indexOf(k);
        let n = 0, bad = 0, chk519 = false; const ex = [];
        for (let i = 0; i < Math.min(A.length, elig.length); i++) {
          const a = A[i], r = elig[i], v = view(r);
          if (!a || !v) continue;
          n++;
          const d = v.div, ok = dOk(d);
          const exp = { divMiss: ok ? 0 : 1, dividendRank: ok && v.th['0.3'].dividendRank != null ? v.th['0.3'].dividendRank : null };
          for (const k of ['divYears', 'divN', 'divStreak']) exp[k] = ok && d[k] != null ? d[k] : null;
          for (const k of ['divYieldTTM', 'avgDivYield', 'payoutRatio', 'divContrib']) exp[k] = ok ? rd4(d[k]) : null;
          for (const k of tail) if (idx[k] < 0 || a[idx[k]] !== exp[k]) { bad++; if (ex.length < 5) ex.push(r.code + ' ' + k + ' ' + JSON.stringify(a[idx[k]]) + ' != ' + JSON.stringify(exp[k])); break; }
          if (r.code === '600519') chk519 = true;
        }
        check(n > 0 && bad === 0 && chk519, 'Y6. ' + f + ': ' + n + ' non-null rows × ' + tail.length + ' dividend values (' + tail.join(',') + ') equal results.json (r4 for ratios, 30% dividendRank, divMiss = data !== ok) incl. 600519 (' + chk519 + '); mismatching rows ' + bad + (ex.length ? ': ' + ex.join('; ') : ''));
      }
    } else check(false, 'Y6. meta.js could not be loaded');
  }

  // Y7. report.md：红利榜 Top 50（50 行）、2 × 红利榜 Top 20（20 行）、2 × 现有综合榜 Top 50 的分红贡献（50 行）、v3.1 变更说明、分红与股息 为倒数第二节、首行 = 红利榜第 1 名、口径关键词
  {
    const mdLines = md.split('\n');
    const tableAt = (idx) => { let j = idx; while (j < mdLines.length && !mdLines[j].startsWith('|')) j++; return j; };
    const rowsAfter = (idx) => { let j = tableAt(idx) + 2, n = 0; while (j < mdLines.length && mdLines[j].startsWith('|')) { n++; j++; } return n; };
    const cnt = { top50: 0, top20: 0, contrib: 0, v31: 0, v3: 0 }, probs = [];
    let top50Idx = -1;
    for (let i = 0; i < mdLines.length; i++) {
      const l = mdLines[i];
      if (l.startsWith('### 红利榜 Top 50')) { cnt.top50++; top50Idx = i; const n = rowsAfter(i); if (n !== 50) probs.push(l + ' -> ' + n + ' rows'); const h = mdLines[tableAt(i)] || ''; if (!h.includes('| 板块 |') || h.includes('| 派息率 |') !== !!DS.hasPayout) probs.push(l + ' header 板块 / 派息率 mismatch'); }
      else if (l.startsWith('### 红利榜 Top 20')) { cnt.top20++; const n = rowsAfter(i); if (n !== 20) probs.push(l + ' -> ' + n + ' rows'); }
      else if (l.startsWith('### 现有综合榜 Top 50 的分红贡献')) { cnt.contrib++; const n = rowsAfter(i); if (n !== 50) probs.push(l + ' -> ' + n + ' rows'); }
      else if (l.startsWith('### v3.1 变更说明')) cnt.v31++;
      else if (l.startsWith('### v3 变更说明')) cnt.v3++;
    }
    check(cnt.top50 === 1 && cnt.top20 === 2 && cnt.contrib === 2 && cnt.v31 === 1 && cnt.v3 === 1 && probs.length === 0, 'Y7. report.md: 1 × "### 红利榜 Top 50" (50 rows, 板块 column, 派息率 column ⇔ hasPayout), 2 × "### 红利榜 Top 20" (20 rows), 2 × "### 现有综合榜 Top 50 的分红贡献" (50 rows), 1 × "### v3.1 变更说明", 1 × "### v3 变更说明" (' + JSON.stringify(cnt) + ')' + (probs.length ? ' -> ' + probs.join('; ') : ''));
    const h2 = mdLines.filter((l) => /^## /.test(l));
    const last = h2[h2.length - 1] || '', prev = h2[h2.length - 2] || '';
    check(/^## \d+\. 分红与股息/.test(prev) && /^## \d+\. 口径与局限/.test(last) && md.includes('### 后复权口径与分红再投资的差异') && md.includes('### 全市场分布'), 'Y7. report.md: "## N. 分红与股息" is the second-to-last section and "## N+1. 口径与局限" the last (' + prev + ' / ' + last + '); has "### 全市场分布" and "### 后复权口径与分红再投资的差异"');
    const r1 = elig.find((r) => r.th['0.3'].dividendRank === 1);
    const row1 = top50Idx >= 0 ? mdLines[tableAt(top50Idx) + 2] || '' : '';
    check(!!r1 && row1.startsWith('| 1 |') && row1.includes('| ' + r1.code + ' |'), 'Y7. report.md 红利榜 Top 50 row 1 is the all-view dividendRank-1 stock ' + (r1 ? r1.name + ' ' + r1.code + ' (TTM ' + pct(r1.div.divYieldTTM) + ', streak ' + r1.div.divStreak + ')' : '?') + ': ' + row1.slice(0, 90));
    const kw = ['税前', '实施', '近12月', '连续分红', '平均股息率', '红利榜', 'recon_drift', 'hfq_gap', String(DS.synthEvents), String(DS.driftStocks)].filter((k) => !md.includes(k));
    check(kw.length === 0, 'Y7. report.md states the dividend definitions and measured gaps (税前 / 实施 / 近12月 / 连续分红 / 平均股息率 / 红利榜 / recon_drift / hfq_gap / synthEvents ' + DS.synthEvents + ' / driftStocks ' + DS.driftStocks + ') — missing: ' + (kw.join(', ') || 'none'));
  }

  // Y8. 壳：控件 id、分红列标签、页脚口径、筛选逻辑、首屏 gzip（打印字节数）
  {
    const hp = path.join(ROOT, 'screen.html');
    const html = fs.readFileSync(hp, 'utf8');
    const ids = ['id="onlyDiv"', 'id="minStreak"', 'id="showDiv"'].filter((s) => !html.includes(s));
    const labels = ['股息率(近12月)', '分红年数', '连续分红', '平均股息率', '分红贡献', '红利#'].concat(DS.hasPayout ? ['派息率'] : []).filter((s) => !html.includes("'" + s + "'"));
    const footer = (html.match(/<footer>([\s\S]*?)<\/footer>/) || [])[1] || '';
    check(ids.length === 0 && labels.length === 0, 'Y8. screen.html has #onlyDiv / #minStreak / #showDiv and the 分红 column labels (missing ids: ' + (ids.join(',') || 'none') + '; missing labels: ' + (labels.join(',') || 'none') + ')');
    check(footer.includes('股息率(近12月)') && footer.includes('连续分红') && footer.includes('红利') && footer.includes('FY' + LAST_FY), 'Y8. screen.html footer defines 股息率(近12月) / 连续分红 / 红利榜 and names FY' + LAST_FY + ' (footer ' + footer.length + ' chars)');
    check(html.includes("grp: 'div'") && html.includes('state.showDiv') && html.includes('state.onlyDiv') && html.includes('state.minStreak') && html.includes('dividendRank <= 50'), 'Y8. screen.html script wires the grp div columns, state.showDiv / onlyDiv / minStreak and the 红利榜 Top 50 filter (dividendRank <= 50)');
    const DATA_DIR = path.join(PUB, 'data');
    const gz = (p) => (exists(p) ? zlib.gzipSync(fs.readFileSync(p), { level: 6 }).length : 0);
    const parts = [hp].concat(['meta.js', 'all.js', 'all_th30.js'].map((f) => path.join(DATA_DIR, f)));
    const sizes = parts.map((p) => [path.basename(p), exists(p) ? fs.statSync(p).size : 0, gz(p)]);
    const total = sizes.reduce((s, x) => s + x[2], 0);
    check(total > 0 && total <= 512000 && Buffer.byteLength(html) < 61440, 'Y8. startup gzip-6 (screen.html + meta.js + all.js + all_th30.js) = ' + total + ' bytes ≤ 512000 (headroom ' + (512000 - total) + '); shell ' + Buffer.byteLength(html) + ' bytes < 61440; parts ' + sizes.map((x) => x[0] + ' ' + x[1] + '→' + x[2]).join(', '));
  }
} else out('SKIP Y. run_meta.dividends absent or dividendsEnabled === false (v3 output)');

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

// ---------------------------------------------------------------- Z. byte / cell identity vs the v3 baseline (--baseline <dir>)
// 现有产出必须保持不变：CSV 旧列逐格相同（新列只能追加在末尾）、9 个阈值数据文件逐字节相同、基础数据文件旧键位逐值相同
if (BASELINE) {
  const BPUB = exists(path.join(BASELINE, 'screen', 'metrics_th30.csv')) ? path.join(BASELINE, 'screen') : BASELINE;
  const BDATA = path.join(BPUB, 'data');
  out('  info: baseline dir ' + BASELINE + ' (csv in ' + BPUB + ', data in ' + BDATA + ')');
  const sameArr = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const name of CSV_TH.concat(CSV_W)) {
    const bp = path.join(BPUB, name);
    if (!exists(bp)) { check(false, 'Z. baseline ' + name + ' missing in ' + BPUB); continue; }
    const base = readCSV(bp), cur = csvs[name];
    const K = base.header.length;
    const prefixOk = cur.header.length >= K && sameArr(cur.header.slice(0, K), base.header);
    let diffRows = 0; const examples = [];
    const n = Math.min(base.rows.length, cur.rows.length);
    for (let i = 0; i < n; i++) {
      const a = base.rows[i], b = cur.rows[i];
      let same = b.length >= K;
      if (same) for (let k = 0; k < K; k++) if (a[k] !== b[k]) { same = false; break; }
      if (!same) { diffRows++; if (examples.length < 5) { let k = 0; while (k < K && a[k] === b[k]) k++; examples.push('row ' + (i + 1) + ' (' + a[0] + ') col ' + (k + 1) + ' ' + (base.header[k] || '?') + ': ' + JSON.stringify(a[k]) + ' -> ' + JSON.stringify(b[k])); } }
    }
    const appended = cur.header.slice(K);
    check(prefixOk && cur.rows.length === base.rows.length && diffRows === 0, 'Z. ' + name + ': baseline header (' + K + ' cols) is a prefix of the new header (' + cur.header.length + ' cols): ' + prefixOk + '; rows ' + cur.rows.length + ' == ' + base.rows.length + '; rows differing in the first ' + K + ' cells: ' + diffRows + '; appended columns (' + appended.length + '): ' + (appended.length ? appended.join(' | ') : '(none)'));
    for (const e of examples) out('  ' + e);
  }
  const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const DATA_DIR = path.join(PUB, 'data');
  const VIEW_KEYS_Z = ['all'].concat(WINDOWS.map((W) => W.key));
  const thFiles = VIEW_KEYS_Z.flatMap((w) => THS.map((T) => w + '_th' + Math.round(+T * 100) + '.js'));
  const thBad = [];
  for (const f of thFiles) {
    const bp = path.join(BDATA, f), cp = path.join(DATA_DIR, f);
    if (!exists(bp) || !exists(cp)) { thBad.push(f + ' missing'); continue; }
    if (sha(bp) !== sha(cp)) thBad.push(f + ' sha256 differs (' + fs.statSync(bp).size + ' -> ' + fs.statSync(cp).size + ' bytes)');
  }
  check(thBad.length === 0, 'Z. ' + thFiles.length + ' threshold data files screen/data/*_th*.js byte-identical to baseline (SHA-256)' + (thBad.length ? ' -> ' + thBad.join('; ') : ''));
  const loadJSZ = (p) => { const ctx = { window: {} }; vm.runInNewContext(fs.readFileSync(p, 'utf8'), ctx); return ctx.window; };
  let oldMeta = null, newMeta = null;
  try { oldMeta = loadJSZ(path.join(BDATA, 'meta.js')).__SCREEN_META; } catch (e) { out('  baseline meta.js load error: ' + e.message); }
  try { newMeta = loadJSZ(path.join(DATA_DIR, 'meta.js')).__SCREEN_META; } catch (e) { out('  meta.js load error: ' + e.message); }
  if (oldMeta && newMeta && oldMeta.KEYS && newMeta.KEYS) {
    const oK = oldMeta.KEYS, nK = newMeta.KEYS;
    check(sameArr(oK.th, nK.th), 'Z. meta.js KEYS.th identical to baseline (' + (nK.th || []).length + ' names)');
    check(nK.base.length >= oK.base.length && sameArr(nK.base.slice(0, oK.base.length), oK.base) && nK.winBase.length >= oK.winBase.length && sameArr(nK.winBase.slice(0, oK.winBase.length), oK.winBase), 'Z. meta.js KEYS.base / KEYS.winBase start with the baseline lists (base ' + oK.base.length + ' -> ' + nK.base.length + ', winBase ' + oK.winBase.length + ' -> ' + nK.winBase.length + '; appended: ' + (nK.base.slice(oK.base.length).join(',') || '(none)') + ')');
    const mDiff = Object.keys(Object.assign({}, oldMeta.META, newMeta.META)).filter((k) => JSON.stringify(oldMeta.META[k]) !== JSON.stringify(newMeta.META[k]));
    out('  info: META keys differing from baseline: ' + (mDiff.join(', ') || '(none)') + ' (version ' + (oldMeta.META && oldMeta.META.version) + ' -> ' + (newMeta.META && newMeta.META.version) + ')');
    const dataOfZ = (dir, f) => { const d = loadJSZ(path.join(dir, f)).__SCREEN_DATA || {}; return d[f.replace(/\.js$/, '')]; };
    for (const w of VIEW_KEYS_Z) {
      const f = w + '.js', oldKeys = w === 'all' ? oK.base : oK.winBase;
      if (!exists(path.join(BDATA, f))) { check(false, 'Z. baseline ' + f + ' missing'); continue; }
      const A = dataOfZ(BDATA, f) || [], B = dataOfZ(DATA_DIR, f) || [];
      const bad = [];
      if (A.length !== B.length) bad.push('length ' + A.length + ' -> ' + B.length);
      let nn = 0;
      for (let i = 0; i < Math.min(A.length, B.length); i++) {
        const a = A[i], b = B[i];
        if ((a == null) !== (b == null)) { bad.push(i + ' null-ness'); continue; }
        if (a == null) continue;
        nn++;
        if (b.length < oldKeys.length || !sameArr(a.slice(0, oldKeys.length), b.slice(0, oldKeys.length))) bad.push(i + ' first ' + oldKeys.length + ' values differ');
      }
      check(bad.length === 0, 'Z. ' + f + ': ' + B.length + ' rows (baseline ' + A.length + '), ' + nn + ' non-null, first ' + oldKeys.length + ' values per row identical and null-ness identical (' + bad.length + ' problems' + (bad.length ? ': ' + bad.slice(0, 5).join('; ') : '') + ')');
    }
  } else check(false, 'Z. baseline / current meta.js could not be loaded');
} else out('SKIP Z. no --baseline given');

// 汇总行：有 FAIL → "N FAIL"；无 FAIL 但有 WARN → "PASS WITH N WARN"（退出码仍为 0，WARN 不阻断）；否则 "ALL PASS"
const summary = (nFail ? nFail + ' FAIL' : nWarn ? 'PASS WITH ' + nWarn + ' WARN' : 'ALL PASS') + ' (' + nPass + ' pass, ' + nFail + ' fail, ' + nWarn + ' warn)';
out(summary);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'screen_verify.log'), lines.join('\n') + '\n', 'utf8');
process.stdout.write(lines.join('\n') + '\n');
process.exit(nFail ? 1 : 0);
