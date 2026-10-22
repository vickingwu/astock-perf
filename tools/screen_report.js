#!/usr/bin/env node
/* 读取 screen/out/results.json + screen/out/benchmarks.json + screen/run_meta.json，生成：
 *   screen/report.md —— 中文报告 v3：版本变更说明 / 概览 / 板块构成 / 各阈值综合榜 Top50 + 稳健·进攻·穿越榜 Top20 + 牛熊轮数分布 /
 *                       近10年·近5年同窗口榜 / Pareto 前沿 / 跨阈值交集 / 合理性校验（含结构观察）/ 口径与局限
 *   screen.html（仓库根目录）—— 零依赖页面壳（< 60 KB）：区间切换（上市至今 / 近10年 / 近5年）、阈值切换、板块多选、列头排序、文本筛选、CAGR×MaxDD 散点、每行链接看板；
 *                       数据在 screen/data/*.js（13 个纯 JS 赋值文件，<script> 动态注入加载，file:// 可用）：meta.js（META / KEYS / 行业字典）、all.js / 10y.js / 5y.js（各区间基础字段，
 *                       按入选个股下标对齐，不在窗口的为 null）、<区间>_th30|40|50.js（各阈值 18 项指标）；首屏只加载 meta.js + all.js + all_th30.js，其余切换时按需加载
 *   版本号取 run_meta.version（tools/screen_all.js CONFIG.VERSION）；v3 = 股票池扩为 沪深主板 + 创业板 + 科创板，指标口径与 v2.1 相同
 * 用法（仓库根目录）：node tools/screen_report.js [--source eastmoney|tencent]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'screen', 'out');   // results.json / benchmarks.json（工作文件，不入库）
const PUB = path.join(ROOT, 'screen');          // run_meta.json（输入）/ report.md（输出）
const HTML_OUT = path.join(ROOT, 'screen.html');
const DATA_DIR = path.join(ROOT, 'screen', 'data'); // screen.html 按需加载的数据文件（入库）
const TEMPLATE = path.join(__dirname, 'screen_template.html');
const DASH_MD = '../index.html';   // report.md 位于 screen/，看板在仓库根目录
const DASH_HTML = './index.html';  // screen.html 位于仓库根目录，与 index.html 同级（模板占位符 __DASH_BASE__）
const THRESHOLDS = ['0.3', '0.4', '0.5'];
const TOP_N = 50, BOARD_N = 20, WIN_COMPACT_N = 20;
const BOARD_ORDER = ['主板', '创业板', '科创板'];
// 合理性校验股：10 只沪深主板（v1 起）+ 5 只创业板 + 5 只科创板（v3）
const SANITY = [
  ['600519', '贵州茅台', '主板'], ['600900', '长江电力', '主板'], ['000333', '美的集团', '主板'], ['600887', '伊利股份', '主板'], ['600276', '恒瑞医药', '主板'],
  ['600436', '片仔癀', '主板'], ['000538', '云南白药', '主板'], ['000651', '格力电器', '主板'], ['600036', '招商银行', '主板'], ['600309', '万华化学', '主板'],
  ['300015', '爱尔眼科', '创业板'], ['300760', '迈瑞医疗', '创业板'], ['300750', '宁德时代', '创业板'], ['300059', '东方财富', '创业板'], ['300124', '汇川技术', '创业板'],
  ['688012', '中微公司', '科创板'], ['688111', '金山办公', '科创板'], ['688981', '中芯国际', '科创板'], ['688008', '澜起科技', '科创板'], ['688036', '传音控股', '科创板'],
];
// v2.1（2026-10-16，沪深主板 2,819 只入选）上市至今 30% 综合榜 Top 10，按 v2.1 名次 1..10 排列；用于「板块构成」表 C 观察主板榜首在全市场榜中的落点
const MAINBOARD_V21_TOP10 = [['605098', '行动教育'], ['605167', '利柏特'], ['000333', '美的集团'], ['601702', '华峰铝业'], ['603662', '柯力传感'], ['605198', '安德利'], ['600519', '贵州茅台'], ['002595', '豪迈科技'], ['002832', '比音勒芬'], ['603871', '嘉友国际']];
const MAINBOARD_V21_ELIGIBLE = 2819;
const BOARD_OPEN = { 创业板: '2009-10-30', 科创板: '2019-07-22' }; // 开板日（首批上市日）

const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const results = readJSON(path.join(OUT, 'results.json'));
const benchmarks = readJSON(path.join(OUT, 'benchmarks.json'));
const meta = fs.existsSync(path.join(PUB, 'run_meta.json')) ? readJSON(path.join(PUB, 'run_meta.json')) : {};
// --source eastmoney|tencent：校验 results.json 的数据源与期望一致（防止把腾讯口径的结果标成看板口径）
const argv = process.argv.slice(2);
const si = argv.indexOf('--source');
const wantSource = si >= 0 ? String(argv[si + 1] || '').toLowerCase() : null;
const SOURCE = meta.source || 'eastmoney';
if (wantSource && wantSource !== SOURCE) { process.stderr.write('results.json 来自 ' + SOURCE + '，与 --source ' + wantSource + ' 不一致；请先用对应数据源执行 node tools/screen_all.js --compute-only --source ' + wantSource + '\n'); process.exit(2); }
const IS_TX = SOURCE === 'tencent';
const DATA_END = meta.dataEnd || meta.dataEndDate || '';
const DATA_END_SPEC = meta.dataEndSpec || 'auto';
const DATA_END_MODE = meta.dataEndMode || (DATA_END_SPEC === 'auto' ? 'auto' : 'fixed');
const DATA_END_NOTE = DATA_END_MODE === 'fixed'
  ? '本次运行以 `--data-end ' + DATA_END_SPEC + '` 固定；所有个股与指数均丢弃其后的 K 线'
  : '`--data-end auto`：取缓存上证指数末根 K 线日期' + (DATA_END_MODE === 'auto-prev' ? '的前一根（运行时该日尚未收盘）' : '') + '；所有个股与指数均丢弃其后的 K 线';
const SOURCE_LABEL = IS_TX ? '腾讯财经 web.ifzq.gtimg.cn 后复权日线（hfq）' : '东方财富 push2his 日线（fqt=2 后复权，与看板同口径）';
const SOURCE_NOTE = IS_TX
  ? '⚠️ 数据源：腾讯财经后复权日线（hfq）—— 东财 push2his 接口对本机限流期间的回退方案。腾讯与东财（看板）的后复权处理不同（除权除息日复权因子不一致），同一只股票的年化 / 回撤 / 牛熊轮数会与看板略有差异；「看板」链接打开的是东财数据，数字与本表不完全一致。东财解封后执行 `node tools/screen_all.js --fetch-only` → `node tools/screen_all.js --compute-only` → `node tools/screen_report.js` 即可切回看板口径。区间终点固定为 ' + DATA_END + '。'
  : '数据源：东方财富 push2his 日线（fqt=2 后复权），与 astock-perf 看板完全同口径，「看板」链接打开后数字一致。';
const WINDOWS = (meta.windows && meta.windows.length ? meta.windows : [{ key: '10y', label: '近10年', start: '2016-10-15', end: DATA_END }, { key: '5y', label: '近5年', start: '2021-10-15', end: DATA_END }]).map((W) => Object.assign({}, W, { end: W.end || DATA_END }));
const VER = String(meta.version || 'v3');
const FIRST_BEAR_PEAK = !meta.config || meta.config.FIRST_BEAR_DEPTH !== 'start'; // v2.1 首段熊市按段内峰→谷计（'start' 为 v2 口径）
const FIRST_BEAR_NOTE = FIRST_BEAR_PEAK ? '；首段（截断）熊市按段内最高点→最低点跌幅计' : '；首段（截断）熊市按段起点→最低点跌幅计';
const BEAR_LEGEND = '熊市均跌：已完成熊市与已达阈值深度的进行中/首段熊市的平均跌幅；没有任何一轮达到阈值时取上市以来最大回撤' + FIRST_BEAR_NOTE;

// ------------------------------------------------------------------ formatting (same style as batch_report.js)
const P = (x, d = 1) => { if (x == null || !isFinite(x)) return '—'; let v = (x * 100).toFixed(d); if (parseFloat(v) === 0) v = (0).toFixed(d); return (parseFloat(v) > 0 ? '+' : '') + v + '%'; }; // 同 app.js pct()，避免 "-0.0%"
const PN = (x, d = 1) => (x == null || !isFinite(x) ? '—' : (x * 100).toFixed(d) + '%'); // 无正号（比率型）
const M = (days) => (days == null ? '—' : days < 31 ? Math.round(days) + 'd' : Math.round(days / 30.4375) + 'm');
const F = (x, d = 2) => (x == null || !isFinite(x) ? '—' : x.toFixed(d));
const N = (x) => (x == null ? '—' : String(x));
const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '/').replace(/\r?\n/g, ' ');
const thLabel = (T) => Math.round(+T * 100) + '%';
const linkR = (r, T, range) => '[看板](' + DASH_MD + '#s=' + r.secid + '&r=' + (range || 'all') + '&fqt=2&th=' + T + ')';
const link = (r, T) => linkR(r, T, 'all');
const recOf = (v) => (v.ddRecovered ? M(v.ddRecDays) : '未修复(' + M(v.ddSinceTroughDays) + ')');
const rec = (r) => recOf(r);
const bbQ = (t) => t.nBull + '/' + t.nBear + '(' + N(t.nBearQualifying) + ')'; // 牛/熊(合格熊)
const bearSrcTag = (t) => (t.avgBearSrc === 'maxDD' ? 'maxDD' : '');
const star = (t) => (t.avgBearSrc === 'maxDD' ? '*' : '');
function table(headers, rows) {
  const out = ['| ' + headers.map(cell).join(' | ') + ' |', '|' + headers.map(() => '---').join('|') + '|'];
  for (const r of rows) out.push('| ' + r.map(cell).join(' | ') + ' |');
  return out.join('\n');
}
const nameCode = (r) => r.name + '(' + r.code + ')';
const bd = (r) => r.board || '主板';

// ------------------------------------------------------------------ data accessors
const elig = results.filter((r) => r.eligible);
const byRank = (T) => elig.filter((r) => r.th[T].rank != null).sort((a, b) => a.th[T].rank - b.th[T].rank);
const byBoard = (T, b) => elig.filter((r) => r.th[T][b + 'Rank'] != null).sort((a, b2) => a.th[T][b + 'Rank'] - b2.th[T][b + 'Rank']);
const wElig = (W) => elig.filter((r) => r.windows && r.windows[W.key]);
const wByRank = (W, T) => wElig(W).filter((r) => r.windows[W.key].th[T].rank != null).sort((a, b) => a.windows[W.key].th[T].rank - b.windows[W.key].th[T].rank);
const wByBoard = (W, T, b) => wElig(W).filter((r) => r.windows[W.key].th[T][b + 'Rank'] != null).sort((a, b2) => a.windows[W.key].th[T][b + 'Rank'] - b2.windows[W.key].th[T][b + 'Rank']);
const topSet = (T, k) => new Set(elig.filter((r) => r.th[T].rank != null && r.th[T].rank <= k).map((r) => r.secid));
const bucket = (y) => (y < 7 ? '5–7 年' : y < 10 ? '7–10 年' : y < 15 ? '10–15 年' : y < 20 ? '15–20 年' : '20 年+');
const buckets = ['5–7 年', '7–10 年', '10–15 年', '15–20 年', '20 年+'];
const cnt = (arr) => { const c = {}; for (const b of buckets) c[b] = 0; for (const r of arr) c[bucket(r.years)]++; return c; };
const boardCount = (rows, b) => rows.filter((r) => bd(r) === b).length;
const boardCountsOf = (rows) => BOARD_ORDER.map((b) => boardCount(rows, b));
const boardSplit = (rows) => BOARD_ORDER.map((b, i) => b + ' ' + boardCountsOf(rows)[i]).join(' / ');
const nShare = (n, tot) => n + ' (' + PN(tot ? n / tot : null, 0) + ')';
const perT = (f) => THRESHOLDS.map((T) => f(T)).join(' / ');
const uf = meta.universeFetch || null;
const UNIVERSE_DESC = '东财 clist 深主板 m:0+t:6 + 创业板 m:0+t:80 + 沪主板 m:1+t:2 + 科创板 m:1+t:23（不含北交所 m:0+t:81+s:2048）';
// 股票池行来源（run_meta.universeProvenance：{ 'clist YYYY-MM-DD': {板块: 行数}, 'interim:<来源>': {板块: 行数} }）。
// 临时行 = clist 被封时由代码表补入、只有代码 / 名称 / 市场的行：其 上市日(f26) / 行业 / 总市值 为空；5 年门槛仍由 K 线首末日判定（权威口径），不受影响。
const PROV = meta.universeProvenance || null;
const provBoards = (o) => BOARD_ORDER.filter((b) => o[b]).map((b) => b + ' ' + o[b]).join(' / ');
const PROV_DESC = PROV ? Object.keys(PROV).map((k) => (k.startsWith('interim:') ? '临时行（' + k.slice(8) + ' 代码表，仅代码 / 名称 / 市场）：' : k + '：') + provBoards(PROV[k])).join('；') : null;
const INTERIM_BOARDS = PROV ? BOARD_ORDER.filter((b) => Object.keys(PROV).some((k) => k.startsWith('interim:') && PROV[k][b])) : [];
const INTERIM_COUNT = PROV ? Object.keys(PROV).filter((k) => k.startsWith('interim:')).reduce((s, k) => s + Object.values(PROV[k]).reduce((a, b) => a + b, 0), 0) : 0;
// report.md 用（面向运行者，含补全命令）：补全首选 --universe-only（只重拉含临时行的分段、不碰主板行，入选集合不受影响）；--refresh-universe 会用当日 clist 重建全部 4 段（含主板名称 / f26），可能改变主板预剔除
const INTERIM_NOTE = INTERIM_BOARDS.length ? INTERIM_BOARDS.join(' / ') + ' 的上市日期来自 K 线首根：运行当日东财 clist 列表接口对相关分段持续返回 502，`screen/universe.json` 中这 ' + INTERIM_COUNT + ' 行为临时行、没有 clist 的上市日 f26 / 行业 / 总市值，CSV 中「上市日(f26)」「行业」「总市值(亿)」三列为空，报告表中「行业」列为空。入选判定（上市满 5 年）本就以 K 线首末日为准，指标与排名不受影响。clist 恢复后执行 `node tools/screen_all.js --universe-only`（只补这些行；K 线已缓存，不会重新拉数），再 `--compute-only` → `node tools/screen_report.js` 重算即可补全。' : null;
// screen.html 横幅用（面向读者，一句话，不含命令 / 文件名）
const INTERIM_NOTE_HTML = INTERIM_BOARDS.length ? INTERIM_BOARDS.join(' / ') + ' 共 ' + INTERIM_COUNT + ' 只的「行业」暂缺（股票列表接口当日不可用，上市日期取 K 线首根）；入选、指标与排名以 K 线为准，不受影响。' : null;

// ------------------------------------------------------------------ report.md
const L = [];
L.push('# A 股全市场（沪深主板 + 创业板 + 科创板）「牛熊逻辑」筛选报告 ' + VER + (IS_TX ? '（数据源：腾讯 hfq 回退）' : ''));
L.push('');
L.push('> **' + SOURCE_NOTE + '**');
L.push('>');
L.push('> 生成时间：' + new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC · 数据截止：**' + (DATA_END || '—') + '**（' + DATA_END_NOTE + '）· 数据源：' + SOURCE_LABEL + ' · 股票池：沪深主板 + 创业板 + 科创板（除 ST / 退、除北交所、上市满 5 年）' + (uf && uf.fetchedAt ? '，clist 拉取于 ' + uf.fetchedAt.slice(0, 10) : '') + ' · 引擎：astock-perf `app.js analyze()` · 区间：上市首日 → 数据截止日（第 3–5 节）/ 固定起点同窗口（第 6–7 节）· 牛熊划分依据 auto（≥6 年月收盘 / ≥2 年周收盘）');
L.push('>');
L.push('> 版本变更见第 0 节（v3：股票池扩为全市场，指标口径与 v2.1 相同）。排名 / 百分位 / 综合分在全部板块的入选个股内统一计算，「板块」列只是标签。全部数值为比率（如 +24.2% = 年化 24.2%）。每行「看板」链接打开 astock-perf 页面核对（相对路径 `' + DASH_MD + '`，需联网拉取行情' + (IS_TX ? '；看板为东财口径，数字略有差异' : '') + '）。');
L.push('');

// ---- 0. 版本变更说明
const chk = meta.checks || {};
const fb = (chk.bearFallback && chk.bearFallback.all) || {};
const rn = chk.rateNullSmallSample || { bullNewHigh: {}, bearHigherLow: {} };
const crossBoth = (T) => elig.filter((r) => r.th[T].bullNewHighRate != null && r.th[T].bearHigherLowRate != null).length;
const bc = meta.boardCounts || {};
const bcGet = (b, k) => (bc[b] && bc[b][k] != null ? bc[b][k] : boardCount(k === 'universe' ? results : k === 'eligible' ? elig : wElig(WINDOWS.find((W) => 'w' + W.key === k) || WINDOWS[0]), b));
L.push('## 0. 版本变更说明');
L.push('');
L.push('### v3 变更说明（' + (meta.finishedAt ? meta.finishedAt.slice(0, 10) : '') + '）');
L.push('');
// 本次各板块行的实际来源（与第 1 节「股票池行来源」一致）：全部来自 clist 时给出拉取日期；有临时行时点明
const PROV_SRC_NOTE = PROV ? (INTERIM_BOARDS.length ? '本次 ' + INTERIM_BOARDS.join(' / ') + ' 行为临时行（来自代码表，无 clist 上市日 / 行业 / 总市值，见第 1 节「股票池行来源」）' : '本次各板块行均来自 clist（' + PROV_DESC + '）') : '';
L.push('1. **股票池扩为沪深主板 + 创业板 + 科创板**：东财 clist 按 4 个分段拉取（深主板 m:0+t:6、创业板 m:0+t:80、沪主板 m:1+t:2、科创板 m:1+t:23），每行打「板块」标签（主板 / 创业板 / 科创板）；北交所不含。剔除规则不变（简称含 ST / 退、上市不足 5 年、长期停牌 stale）。本次股票池 ' + results.length + ' 只（' + boardSplit(results) + '），入选 ' + elig.length + ' 只（' + boardSplit(elig) + '）。' + (PROV_SRC_NOTE ? PROV_SRC_NOTE + '。' : ''));
L.push('2. **一个股票池、一套排名**：百分位 / 综合分 / 分榜 / Pareto 前沿在全部板块的 ' + elig.length + ' 只入选个股内统一计算，板块只是标签和 screen.html 里的显示筛选（勾掉某板块只隐藏行，不重新排名）。');
L.push('3. **指标口径与 v2.1 完全相同**：CAGR、最大回撤、合格熊市 / 熊市均跌（首段按段内峰→谷）、牛市新高率、底部抬高率、滚动 5 年、同窗口榜、综合分权重均未改动。v2.1 入选的 ' + MAINBOARD_V21_ELIGIBLE + ' 只主板个股在 v3 中年化 / 最大回撤 / 熊市均跌逐位相同，只有名次与百分位因入选集合扩大而变化（见第 2 节表 C）。');
L.push('4. **统一数据终点改为命令行参数** `--data-end YYYY-MM-DD|auto`（默认 auto = 缓存上证末根 K 线日期，上海时间当日 15:05 前取前一根）。' + DATA_END_NOTE + '。');
L.push('5. **代码与产出位置**：脚本移入 `tools/`（`screen_all.js` 拉数 / 计算，`screen_report.js` 报告 + 网页，`screen_verify.js` 校验，`fetch_watchdog.js` 拉数看门狗）；入库产出在 `screen/`（本报告、`metrics_*.csv`、`run_meta.json`、`universe.json`）与仓库根目录 `screen.html`；K 线缓存与 `results.json` 在 `screen/out/`（不入库）。详见 `screen/README.md`。');
L.push('');
L.push('### v2 / v2.1 口径回顾（2026-10-16）');
L.push('');
L.push('1. **熊市均跌 / 最深熊市**：「合格熊市」= 已完成熊市 + 实现跌幅 ≥ 阈值的首段截断 / 进行中熊市；每轮跌幅取阶段起点（枢轴高点）→ 阶段最低点（lo；已完成熊市与 ret 相同），首段（截断）熊市按段内最高点 → 最低点跌幅计（v2.1，`CONFIG.FIRST_BEAR_DEPTH = \'peak\'`' + (FIRST_BEAR_PEAK ? '' : '；本次运行为 \'start\'，即 v2 口径') + '）；没有合格熊市时取上市以来最大回撤（真实序列永不为 0）。熊市均历时按合格熊市统计（进行中段取至今天数）。牛市均涨只统计已完成牛市。');
L.push('2. **牛市新高率 / 熊市底部抬高率需要样本量**：牛市新高率需 ≥2 轮已完成牛市、底部抬高率需 ≥2 对可比熊市，否则记空（表中显示 —，综合分与穿越榜不计该项）。');
L.push('3. **同窗口榜**：' + WINDOWS.map((W) => W.label + '（' + W.start + ' → ' + W.end + '，入选 ' + N(W.eligible) + ' 只' + (W.key === '5y' ? '，窗口 5.0 年按周收盘划分牛熊、滚动 5 年样本不足记空' : '') + '）').join('、') + '。入选 = 上市至今入选且首根 K 线 ≤ 窗口起点；所有指标（含牛市新高率的「新高」）只看窗口内历史，百分位 / 综合分 / 分榜 / Pareto 在各窗口入选集合内计算；看板链接 r=10y / r=5y。');
L.push('4. **首段（截断）熊市深度**：引擎给首段截断熊市的起点是第 0 根 K 线（上市首日；同窗口榜为窗口首根），不是枢轴高点，其 lo = 起点 → 最低点 会低估「上市后先冲高再回落」个股的熊市深度（法狮龙 605318 首段熊 2020-08-03 → 2022-04-28：起点量 −31.5%，段内峰值 2020-08-07 → 谷底 −53.2% = 其最大回撤）。v2.1 起把首段截断熊市的深度定义为段内最大回撤 depth = min(c[i] / max(c[s..i]) − 1)，用于合格判定（|depth| ≥ 阈值）、熊市均跌与最深熊市；已完成 / 进行中熊市的起点本就是枢轴高点，仍取 lo。');
L.push('');

// ---- 1. 概览
L.push('## 1. 概览');
L.push('');
const exc = meta.exclusionCounts || {};
const excOrder = ['ST/退 in name', 'listed<5y (f26)', 'listed<5y (kline)', 'stale', 'fetch_failed', 'too_few_bars', 'not_cached', 'compute_error'];
const excCN = { 'ST/退 in name': '简称含 ST / 退', 'listed<5y (f26)': '上市不足 5 年（clist f26 预判，未拉数）', 'listed<5y (kline)': '上市不足 5 年（K 线首末日）', stale: '长期停牌 / 已退市（末根 K 线比上证晚 30 天以上）', fetch_failed: '拉数失败', too_few_bars: 'K 线不足 2 根', not_cached: '未拉数（缓存缺失）', compute_error: '计算异常' };
const nSH = results.filter((r) => r.market === 1).length, nSZ = results.length - nSH;
L.push(table(['项目', '数值'], [
  ['数据源', SOURCE_LABEL + (IS_TX ? '（回退；缓存 screen/out/klines_tx）' : '（缓存 screen/out/klines）')],
  ['数据截止日', (DATA_END || '—') + '（' + DATA_END_NOTE + (meta.truncation ? '；本次丢弃 ' + meta.truncation.files + ' 只的 ' + meta.truncation.bars + ' 根 K 线' : '') + '；上证指数末根 K 线 ' + (meta.dataEndDate || '—') + '）'],
  ['股票池（' + UNIVERSE_DESC + '）', results.length + ' 只（沪 ' + nSH + ' / 深 ' + nSZ + '；' + boardSplit(results) + '；含 clist 仍保留的历史退市代码，由 stale 规则剔除）' + (uf && uf.fetchedAt ? '，clist 拉取于 ' + uf.fetchedAt.replace('T', ' ').slice(0, 16) + ' UTC' : '')],
  ...(PROV_DESC ? [['股票池行来源', PROV_DESC + (INTERIM_NOTE ? '。' + INTERIM_NOTE : '')]] : []),
  ...excOrder.filter((k) => exc[k]).map((k) => ['剔除：' + (excCN[k] || k), exc[k] + ' 只（' + boardSplit(results.filter((r) => r.excluded_reason === k)) + '）']),
  ['剔除合计', Object.values(exc).reduce((a, b) => a + b, 0) + ' 只'],
  ['**入选（上市 ≥5 年、非 ST、非 stale）**', '**' + elig.length + ' 只**（' + boardSplit(elig) + '）'],
  ...WINDOWS.map((W) => [W.label + '窗口入选（首根 K 线 ≤ ' + W.start + '）', wElig(W).length + ' 只（' + boardSplit(wElig(W)) + '）']),
  ['熊市均跌回退为最大回撤（无合格熊市，30/40/50%）', perT((T) => N(fb[T])) + ' 只'],
  ['牛市新高率为空（已完成牛市 <2 轮，30/40/50%）', perT((T) => N(rn.bullNewHigh[T])) + ' 只'],
  ['底部抬高率为空（可比熊市 <2 对，30/40/50%）', perT((T) => N(rn.bearHigherLow[T])) + ' 只'],
  ['拉数失败（最终）', (meta.fetchFailures || 0) + ' 只' + (meta.failedSecids && meta.failedSecids.length ? '：' + meta.failedSecids.join(', ') : '')],
  ['一致性自检', meta.checks ? '阶段牛熊交替违例 ' + chk.phaseAlternationViolations + ' · 涨跌幅符号违例 ' + chk.retSignViolations + ' · 熊市轮数随阈值非降违例 ' + chk.nBearMonotoneViolations + ' · 熊市均跌为 0/空 ' + N(chk.avgBearZeroOrNull) + ' · 计算异常 ' + chk.errors.length : '—'],
]));
L.push('');
L.push('### 基准指数（同口径：上市/发布首日 → 数据截止日，后复权无关）');
L.push('');
L.push(table(['指数', '起点', '年数', '累计', '年化', '最大回撤', '峰→谷', '修复', '当前回撤', '滚动5年P10 / 中位 / 胜率', ...THRESHOLDS.map((T) => thLabel(T) + ' 牛/熊(合格熊) · 熊市均跌 · 牛市均涨')],
  benchmarks.map((b) => [b.name + ' ' + b.secid, b.listDate, F(b.years, 1), P(b.total, 0), P(b.cagr), P(b.maxDD), M(b.ddDownDays), rec(b), P(b.curDD), b.roll5y ? P(b.roll5y.p10) + ' / ' + P(b.roll5y.median) + ' / ' + PN(b.roll5y.winRate, 0) : '—',
    ...THRESHOLDS.map((T) => { const t = b.th[T]; return bbQ(t) + ' · ' + P(t.avgBearRet) + star(t) + ' · ' + P(t.avgBullRet, 0); })])));
L.push('');
L.push('### 基准指数 · 同窗口');
L.push('');
L.push(table(['指数', '窗口', '起点', '累计', '年化', '最大回撤', '当前回撤', ...THRESHOLDS.map((T) => thLabel(T) + ' 牛/熊(合格熊) · 熊市均跌')],
  [].concat(...WINDOWS.map((W) => benchmarks.map((b) => { const w = b.windows && b.windows[W.key]; if (!w) return [b.name, W.label, '—', '—', '—', '—', '—', ...THRESHOLDS.map(() => '—')]; return [b.name, W.label, w.window.start, P(w.total, 0), P(w.cagr), P(w.maxDD), P(w.curDD), ...THRESHOLDS.map((T) => { const t = w.th[T]; return bbQ(t) + ' · ' + P(t.avgBearRet) + star(t); })]; })))));
L.push('');
L.push('说明：入选个股的「同期上证超额」= 个股区间年化 − 上证指数在同一时间窗（个股首根 K 线日 → 末根 K 线日；同窗口榜为窗口首根 → 末根）的年化。表中 `*` = 该阈值下无合格熊市、熊市均跌回退为最大回撤。');
L.push('');

// ---- 2. 板块构成
L.push('## 2. 板块构成');
L.push('');
L.push('股票池按东财 clist 分段拉取并打板块标签（主板 = 深主板 m:0+t:6 + 沪主板 m:1+t:2；创业板 m:0+t:80；科创板 m:1+t:23；不含北交所）' + (PROV_SRC_NOTE ? '；' + PROV_SRC_NOTE : '') + '。排名 / 百分位 / 综合分 / 分榜 / Pareto 在全部板块的 ' + elig.length + ' 只入选个股内统一计算，板块只是标签。创业板 ' + BOARD_OPEN.创业板 + ' 开板、科创板 ' + BOARD_OPEN.科创板 + ' 开板，因此科创板个股的历史最长约 ' + F((new Date(DATA_END || '2026-10-15') - new Date(BOARD_OPEN.科创板)) / 86400000 / 365.25, 1) + ' 年，**科创板在近10年窗口（起点 ' + WINDOWS[0].start + '）的入选数按定义为 0**。');
L.push('');
L.push('### A. 各板块股票池与入选');
L.push('');
const excIn = (b, keys) => results.filter((r) => bd(r) === b && keys.includes(r.excluded_reason)).length;
const tableA = BOARD_ORDER.map((b) => {
  const u = results.filter((r) => bd(r) === b), e = elig.filter((r) => bd(r) === b);
  return [b, u.length, excIn(b, ['ST/退 in name']), excIn(b, ['listed<5y (f26)', 'listed<5y (kline)']), excIn(b, ['stale', 'fetch_failed', 'too_few_bars', 'not_cached', 'compute_error']), e.length, PN(u.length ? e.length / u.length : null, 0), nShare(e.length, elig.length), ...WINDOWS.map((W) => e.filter((r) => r.windows && r.windows[W.key]).length)];
});
tableA.push(['合计', results.length, excIn('主板', ['ST/退 in name']) + excIn('创业板', ['ST/退 in name']) + excIn('科创板', ['ST/退 in name']), results.filter((r) => ['listed<5y (f26)', 'listed<5y (kline)'].includes(r.excluded_reason)).length, results.filter((r) => ['stale', 'fetch_failed', 'too_few_bars', 'not_cached', 'compute_error'].includes(r.excluded_reason)).length, elig.length, PN(elig.length / results.length, 0), nShare(elig.length, elig.length), ...WINDOWS.map((W) => wElig(W).length)]);
L.push(table(['板块', 'clist 行数', '剔除：ST / 退', '剔除：上市不足 5 年（f26 + K 线）', '剔除：stale / 其他', '入选', '板块内入选率', '占全部入选', ...WINDOWS.map((W) => W.label + '窗口入选')], tableA));
L.push('');
L.push('### B. 各板块在榜单中的份额');
L.push('');
L.push('每格为「该板块只数 (占该榜单 %)」；「入选集合（参照）」行是各板块在对应入选集合中的占比，榜单份额高于参照即该板块在榜单中超配。');
L.push('');
const shareRow = (label, rows) => [label, ...BOARD_ORDER.map((b) => nShare(boardCount(rows, b), rows.length)), rows.length];
const tableB = [shareRow('上市至今 入选集合（参照）', elig)];
for (const T of THRESHOLDS) tableB.push(shareRow('上市至今 综合榜 Top ' + TOP_N + ' @' + thLabel(T), byRank(T).slice(0, TOP_N)));
for (const W of WINDOWS) { tableB.push(shareRow(W.label + '窗口 入选集合（参照）', wElig(W))); tableB.push(shareRow(W.label + '窗口 综合榜 Top ' + TOP_N + ' @30%', wByRank(W, '0.3').slice(0, TOP_N))); }
L.push(table(['榜单 / 集合', ...BOARD_ORDER, '合计'], tableB));
L.push('');
L.push('### C. 主板 v2.1 上市至今 30% Top 10 在全市场榜中的落点');
L.push('');
const v21Rows = MAINBOARD_V21_TOP10.map(([code, nm], i) => {
  const r = elig.find((x) => x.code === code);
  if (!r) { const r0 = results.find((x) => x.code === code); return [i + 1, nm, code, r0 ? bd(r0) : '—', '—', '—', '—', r0 ? '未入选：' + r0.excluded_reason : '不在股票池', '—', '—']; }
  const t = r.th['0.3'];
  return [i + 1, r.name, code, bd(r), P(r.cagr), P(r.maxDD), P(t.avgBearRet) + star(t), THRESHOLDS.map((T) => N(r.th[T].rank)).join(' / '), (t.rank - (i + 1) > 0 ? '+' : '') + (t.rank - (i + 1)), link(r, '0.3')];
});
L.push(table(['v2.1 名次', '名称', '代码', '板块', '年化', '最大回撤', '熊市均跌 30%', VER + ' 综合排名 30% / 40% / 50%', 'Δ30%（' + VER + ' − v2.1）', '看板'], v21Rows));
L.push('');
{
  const found = MAINBOARD_V21_TOP10.map(([code]) => elig.find((x) => x.code === code)).filter(Boolean);
  const in10 = found.filter((r) => r.th['0.3'].rank <= 10).length, in50 = found.filter((r) => r.th['0.3'].rank <= 50).length;
  const top10v3 = byRank('0.3').slice(0, 10);
  L.push('v2.1 名次在 ' + MAINBOARD_V21_ELIGIBLE + ' 只沪深主板入选个股内计算，' + VER + ' 名次在全部 ' + elig.length + ' 只入选个股内计算；这 10 只的年化 / 最大回撤 / 熊市均跌数值与 v2.1 逐位相同，只有名次因加入创业板 / 科创板个股而变化。10 只中仍在 ' + VER + ' 30% Top 10 的 ' + in10 + ' 只、仍在 Top 50 的 ' + in50 + ' 只。' + VER + ' 30% Top 10：' + top10v3.map((r) => r.name + '(' + r.code + '，' + bd(r) + ')').join('、') + '。');
  L.push('');
}

// ---- 3–5. 各阈值（上市至今）
let sec = 3;
const legendComposite = (T, n, isWin) => '综合分 = 6 项百分位等权平均：年化 CAGR、Calmar、最大回撤、熊市平均跌幅（合格熊市 = 已完成 + 实现跌幅 ≥' + thLabel(T) + ' 的首段/进行中熊市；无合格熊市取' + (isWin ? '区间' : '') + '最大回撤，表中「熊跌口径」列标 maxDD）、牛市新高率（已完成牛市 <2 轮为空、不计）、滚动 5 年持有年化 10 分位；百分位在 ' + n + ' 只' + (isWin ? '窗口' : '') + '入选个股（全部板块）内计算，越高越好。' + (isWin ? BEAR_LEGEND.replace('上市以来最大回撤', '区间内最大回撤') : BEAR_LEGEND) + '。';
for (const T of THRESHOLDS) {
  const ranked = byRank(T);
  L.push('## ' + sec++ + '. 阈值 ' + thLabel(T) + '（自阶段极值反向运行 ≥' + thLabel(T) + ' 确认牛熊切换）');
  L.push('');
  L.push('### 综合榜 Top ' + TOP_N);
  L.push('');
  L.push(legendComposite(T, elig.length));
  L.push('');
  L.push(table(['#', '名称', '代码', '板块', '行业', '上市日', '年数', '上市至今', '年化', '最大回撤', '峰→谷', '修复', '当前回撤', '牛/熊(合格熊)', '熊市均跌', '熊跌口径', '牛市均涨', '牛市新高率', '底部抬高率', '滚动5年P10', '同期上证超额', '综合分', '看板'],
    ranked.slice(0, TOP_N).map((r) => { const t = r.th[T]; return [t.rank, r.name, r.code, bd(r), r.industry, r.listDate, F(r.years, 1), P(r.total, 0), P(r.cagr), P(r.maxDD), M(r.ddDownDays), rec(r), P(r.curDD), bbQ(t), P(t.avgBearRet), bearSrcTag(t), P(t.avgBullRet, 0), PN(t.bullNewHighRate, 0), PN(t.bearHigherLowRate, 0), r.roll5y ? P(r.roll5y.p10) : '—', P(r.bench.excessCagr), F(t.composite, 3), link(r, T)]; })));
  L.push('');
  L.push('Top ' + TOP_N + ' 板块构成：' + boardSplit(ranked.slice(0, TOP_N)) + '。');
  L.push('');
  L.push('### 稳健榜 Top ' + BOARD_N + '（熊市平均跌幅 + 最大回撤 百分位均值）');
  L.push('');
  L.push(table(['#', '名称', '代码', '板块', '行业', '年数', '年化', '最大回撤', '熊市均跌', '最深熊市', '完成熊轮数', '合格熊轮数', '熊跌口径', '牛/熊', '稳健分', '综合排名', '看板'],
    byBoard(T, 'steady').slice(0, BOARD_N).map((r) => { const t = r.th[T]; return [t.steadyRank, r.name, r.code, bd(r), r.industry, F(r.years, 1), P(r.cagr), P(r.maxDD), P(t.avgBearRet), P(t.deepestBearRet), t.nCompletedBear, N(t.nBearQualifying), bearSrcTag(t), t.nBull + '/' + t.nBear, F(t.steady, 3), N(t.rank), link(r, T)]; })));
  L.push('');
  L.push('### 进攻榜 Top ' + BOARD_N + '（年化 CAGR + 牛市平均涨幅 百分位均值）');
  L.push('');
  L.push(table(['#', '名称', '代码', '板块', '行业', '年数', '年化', '牛市均涨', '牛市均历时', '牛市时间占比', '最大回撤', '牛/熊', '进攻分', '综合排名', '看板'],
    byBoard(T, 'attack').slice(0, BOARD_N).map((r) => { const t = r.th[T]; return [t.attackRank, r.name, r.code, bd(r), r.industry, F(r.years, 1), P(r.cagr), P(t.avgBullRet, 0), M(t.avgBullDays), PN(t.bullTimeShare, 0), P(r.maxDD), t.nBull + '/' + t.nBear, F(t.attack, 3), N(t.rank), link(r, T)]; })));
  L.push('');
  L.push('### 穿越榜 Top ' + BOARD_N + '（牛市新高率 + 熊市底部抬高率 百分位均值，两项均需非空）');
  L.push('');
  L.push('两项均非空的入选个股：' + crossBoth(T) + ' / ' + elig.length + ' 只（新高率需 ≥2 轮已完成牛市、底部抬高率需 ≥2 对可比熊市）。');
  L.push('');
  L.push(table(['#', '名称', '代码', '板块', '行业', '年数', '年化', '最大回撤', '牛市新高率', '底部抬高率', '完成牛/熊', '可比熊对数', '牛熊非对称比', '穿越分', '综合排名', '看板'],
    byBoard(T, 'cross').slice(0, BOARD_N).map((r) => { const t = r.th[T]; return [t.crossRank, r.name, r.code, bd(r), r.industry, F(r.years, 1), P(r.cagr), P(r.maxDD), PN(t.bullNewHighRate, 0), PN(t.bearHigherLowRate, 0), t.nCompletedBull + '/' + t.nCompletedBear, N(t.nBearPairs), F(t.asymmetry, 2), F(t.cross, 3), N(t.rank), link(r, T)]; })));
  L.push('');
  L.push('### 牛熊轮数分布（入选个股，阈值 ' + thLabel(T) + '）');
  L.push('');
  const dist = (rows, f) => { const c = { 0: 0, 1: 0, 2: 0, '3+': 0 }; for (const r of rows) { const v = f(r.th[T]); c[v >= 3 ? '3+' : v]++; } return c; };
  const dB = dist(elig, (t) => t.nCompletedBear), dQ = dist(elig, (t) => t.nBearQualifying), dBull = dist(elig, (t) => t.nCompletedBull), dAll = dist(elig, (t) => t.nBear);
  L.push(table(['轮数', '0', '1', '2', '3+'], [
    ['已完成熊市轮数（排除首段截断与进行中）', dB[0], dB[1], dB[2], dB['3+']],
    ['合格熊市轮数（已完成 + 实现跌幅 ≥' + thLabel(T) + ' 的首段/进行中）', dQ[0], dQ[1], dQ[2], dQ['3+']],
    ['已完成牛市轮数', dBull[0], dBull[1], dBull[2], dBull['3+']],
    ['全部熊市阶段数（含截断 / 进行中）', dAll[0], dAll[1], dAll[2], dAll['3+']],
  ]));
  const curBull = elig.filter((r) => r.th[T].curPhase.bull).length;
  L.push('');
  L.push('无合格熊市、熊市均跌回退为最大回撤：' + elig.filter((r) => r.th[T].avgBearSrc === 'maxDD').length + ' 只（' + boardSplit(elig.filter((r) => r.th[T].avgBearSrc === 'maxDD')) + '）。当前处于牛市阶段：' + curBull + ' 只（' + PN(curBull / elig.length, 0) + '），熊市阶段：' + (elig.length - curBull) + ' 只。基准：上证 ' + (benchmarks[0].th[T].curPhase.bull ? '牛' : '熊') + ' ' + P(benchmarks[0].th[T].curPhase.ret) + '。');
  L.push('');
}

// ---- 6–7. 同窗口榜
function windowSection(W) {
  const we = wElig(W), n = we.length;
  const v = (r) => r.windows[W.key];
  L.push('## ' + sec++ + '. ' + W.label.replace(/(\d+)/, ' $1 ') + '同窗口榜（' + W.start + ' → ' + W.end + '）');
  L.push('');
  const basisNote = W.key === '5y' ? '牛熊划分依据：周收盘（窗口 5.0 年 <6 年，auto 规则）；滚动 5 年持有年化：窗口内样本不足 12 个记空，综合分按其余 5 项等权。' : '牛熊划分依据：月收盘（窗口 ≥6 年；个别因长期停牌窗口内首根 K 线晚于 ' + (+W.start.slice(0, 4) + 4) + ' 年的个股自动降为周收盘，见「区间起点」列）。';
  L.push('入选 ' + n + ' 只（' + boardSplit(we) + '；上市至今入选且首根 K 线 ≤ ' + W.start + (W.key === '10y' ? '；科创板 ' + BOARD_OPEN.科创板 + ' 开板，按定义不在本窗口' : '') + '）。区间 = 首根 ≥ ' + W.start + ' 的 K 线（通常即 ' + W.start + ' 当日或次一交易日，长期停牌股为复牌首日）→ ' + W.end + '。' + basisNote + ' 牛市新高率的「新高」只看窗口内历史。百分位 / 综合分 / 分榜 / Pareto 在这 ' + n + ' 只（全部板块）内计算。看板链接 `r=' + W.key + '` 以看板最新 K 线倒推 ' + (W.key === '10y' ? 120 : 60) + ' 个月，打开日期晚于数据截止日时起点会比本表漂移几天。');
  L.push('');
  L.push('基准（同窗口）：' + benchmarks.map((b) => { const w = b.windows && b.windows[W.key]; return w ? b.name + ' 年化 ' + P(w.cagr) + ' · 最大回撤 ' + P(w.maxDD) + ' · 当前回撤 ' + P(w.curDD) : b.name + ' —'; }).join('；') + '。');
  L.push('');
  for (const T of THRESHOLDS) {
    const ranked = wByRank(W, T);
    if (T === '0.3') {
      L.push('### 综合榜 Top ' + TOP_N + ' @' + thLabel(T));
      L.push('');
      L.push(legendComposite(T, n, true) + (W.key === '5y' ? '（本窗口滚动 5 年为空，综合分为 5 项）' : ''));
      L.push('');
      L.push(table(['#', '名称', '代码', '板块', '行业', '上市日', '区间起点', '上市年数', '区间累计', '年化', '最大回撤', '峰→谷', '修复', '当前回撤', '牛/熊(合格熊)', '熊市均跌', '熊跌口径', '牛市均涨', '牛市新高率', '底部抬高率', '滚动5年P10', '同期上证超额', '综合分', '全史综合排名', '看板'],
        ranked.slice(0, TOP_N).map((r) => { const w = v(r), t = w.th[T]; return [t.rank, r.name, r.code, bd(r), r.industry, r.listDate, w.window.start, F(r.years, 1), P(w.total, 0), P(w.cagr), P(w.maxDD), M(w.ddDownDays), recOf(w), P(w.curDD), bbQ(t), P(t.avgBearRet), bearSrcTag(t), P(t.avgBullRet, 0), PN(t.bullNewHighRate, 0), PN(t.bearHigherLowRate, 0), w.roll5y ? P(w.roll5y.p10) : '—', P(w.bench.excessCagr), F(t.composite, 3), N(r.th[T].rank), linkR(r, T, W.key)]; })));
      L.push('');
      L.push('Top ' + TOP_N + ' 板块构成：' + boardSplit(ranked.slice(0, TOP_N)) + '。');
      L.push('');
      L.push('### 稳健榜 Top ' + BOARD_N + ' @' + thLabel(T) + '（熊市平均跌幅 + 最大回撤 百分位均值，窗口内）');
      L.push('');
      L.push(table(['#', '名称', '代码', '板块', '区间起点', '年化', '最大回撤', '熊市均跌', '最深熊市', '完成熊轮数', '合格熊轮数', '熊跌口径', '牛/熊', '稳健分', '窗口综合排名', '看板'],
        wByBoard(W, T, 'steady').slice(0, BOARD_N).map((r) => { const w = v(r), t = w.th[T]; return [t.steadyRank, r.name, r.code, bd(r), w.window.start, P(w.cagr), P(w.maxDD), P(t.avgBearRet), P(t.deepestBearRet), t.nCompletedBear, N(t.nBearQualifying), bearSrcTag(t), t.nBull + '/' + t.nBear, F(t.steady, 3), N(t.rank), linkR(r, T, W.key)]; })));
      L.push('');
      L.push('### 进攻榜 Top ' + BOARD_N + ' @' + thLabel(T) + '（年化 CAGR + 牛市平均涨幅 百分位均值，窗口内）');
      L.push('');
      L.push(table(['#', '名称', '代码', '板块', '区间起点', '年化', '牛市均涨', '牛市均历时', '牛市时间占比', '最大回撤', '牛/熊', '进攻分', '窗口综合排名', '看板'],
        wByBoard(W, T, 'attack').slice(0, BOARD_N).map((r) => { const w = v(r), t = w.th[T]; return [t.attackRank, r.name, r.code, bd(r), w.window.start, P(w.cagr), P(t.avgBullRet, 0), M(t.avgBullDays), PN(t.bullTimeShare, 0), P(w.maxDD), t.nBull + '/' + t.nBear, F(t.attack, 3), N(t.rank), linkR(r, T, W.key)]; })));
      L.push('');
      const both = we.filter((r) => v(r).th[T].bullNewHighRate != null && v(r).th[T].bearHigherLowRate != null).length;
      L.push('### 穿越榜 Top ' + BOARD_N + ' @' + thLabel(T) + '（牛市新高率 + 熊市底部抬高率 百分位均值，两项均需非空）');
      L.push('');
      L.push('两项均非空的窗口入选个股：' + both + ' / ' + n + ' 只。');
      L.push('');
      L.push(table(['#', '名称', '代码', '板块', '区间起点', '年化', '最大回撤', '牛市新高率', '底部抬高率', '完成牛/熊', '可比熊对数', '穿越分', '窗口综合排名', '看板'],
        wByBoard(W, T, 'cross').slice(0, BOARD_N).map((r) => { const w = v(r), t = w.th[T]; return [t.crossRank, r.name, r.code, bd(r), w.window.start, P(w.cagr), P(w.maxDD), PN(t.bullNewHighRate, 0), PN(t.bearHigherLowRate, 0), t.nCompletedBull + '/' + t.nCompletedBear, N(t.nBearPairs), F(t.cross, 3), N(t.rank), linkR(r, T, W.key)]; })));
      L.push('');
    } else {
      L.push('### 综合榜 Top ' + WIN_COMPACT_N + ' @' + thLabel(T));
      L.push('');
      L.push(table(['#', '名称', '代码', '板块', '行业', '区间起点', '年化', '最大回撤', '当前回撤', '牛/熊(合格熊)', '熊市均跌', '熊跌口径', '牛市均涨', '牛市新高率', '综合分', '全史综合排名', '看板'],
        ranked.slice(0, WIN_COMPACT_N).map((r) => { const w = v(r), t = w.th[T]; return [t.rank, r.name, r.code, bd(r), r.industry, w.window.start, P(w.cagr), P(w.maxDD), P(w.curDD), bbQ(t), P(t.avgBearRet), bearSrcTag(t), P(t.avgBullRet, 0), PN(t.bullNewHighRate, 0), F(t.composite, 3), N(r.th[T].rank), linkR(r, T, W.key)]; })));
      L.push('');
      const both = we.filter((r) => v(r).th[T].bullNewHighRate != null && v(r).th[T].bearHigherLowRate != null).length;
      L.push('穿越榜两项均非空：' + both + ' / ' + n + ' 只。Top ' + TOP_N + ' 板块构成：' + boardSplit(ranked.slice(0, TOP_N)) + '。');
      L.push('');
    }
  }
  L.push('### 牛熊轮数分布（窗口入选个股）');
  L.push('');
  const dist = (f) => { const c = { 0: 0, 1: 0, 2: 0, '3+': 0 }; for (const r of we) { const x = f(v(r)); c[x >= 3 ? '3+' : x]++; } return c; };
  const rows = [];
  for (const T of THRESHOLDS) {
    const dB = dist((w) => w.th[T].nCompletedBear), dQ = dist((w) => w.th[T].nBearQualifying), dBu = dist((w) => w.th[T].nCompletedBull);
    rows.push([thLabel(T) + ' 已完成熊市轮数', dB[0], dB[1], dB[2], dB['3+']]);
    rows.push([thLabel(T) + ' 合格熊市轮数', dQ[0], dQ[1], dQ[2], dQ['3+']]);
    rows.push([thLabel(T) + ' 已完成牛市轮数', dBu[0], dBu[1], dBu[2], dBu['3+']]);
  }
  L.push(table(['轮数', '0', '1', '2', '3+'], rows));
  L.push('');
  L.push('无合格熊市、熊市均跌回退为最大回撤（30/40/50%）：' + perT((T) => we.filter((r) => v(r).th[T].avgBearSrc === 'maxDD').length) + ' 只；当前处于熊市阶段（30/40/50%）：' + perT((T) => we.filter((r) => !v(r).th[T].curPhase.bull).length) + ' 只。');
  L.push('');
  const inAllW = we.filter((r) => THRESHOLDS.every((T) => v(r).th[T].rank != null && v(r).th[T].rank <= TOP_N)).sort((a, b) => THRESHOLDS.reduce((s, T) => s + v(a).th[T].rank, 0) - THRESHOLDS.reduce((s, T) => s + v(b).th[T].rank, 0));
  L.push('窗口跨阈值交集（三阈值窗口综合榜均进 Top ' + TOP_N + '）：' + inAllW.length + ' 只' + (inAllW.length ? '：' + inAllW.map((r) => nameCode(r) + '·' + bd(r)).join('、') : '') + '。');
  L.push('');
  L.push('与上市至今榜重合：窗口综合榜 Top ' + TOP_N + ' 中同时位于全史综合榜 Top ' + TOP_N + ' 的个股（30/40/50%）：' + perT((T) => { const ts = topSet(T, TOP_N); return wByRank(W, T).slice(0, TOP_N).filter((r) => ts.has(r.secid)).length; }) + ' 只。');
  L.push('');
}
for (const W of WINDOWS) windowSection(W);

// ---- 8. Pareto（上市至今 + 近10年）
const pareto = elig.filter((r) => r.pareto).sort((a, b) => b.cagr - a.cagr);
L.push('## ' + sec++ + '. 收益-回撤 Pareto 前沿（与阈值无关）');
L.push('');
L.push('### Pareto 前沿 · 上市至今');
L.push('');
L.push('在 (年化 CAGR ↑, 最大回撤 ↑) 二维上不被任何其他入选个股（全部板块）同时压制的个股，按年化降序。共 ' + pareto.length + ' 只（' + boardSplit(pareto) + '）。');
L.push('');
L.push(table(['#', '名称', '代码', '板块', '行业', '上市日', '年数', '年化', '最大回撤', 'Calmar', '当前回撤', '滚动5年P10', '同期上证超额', '综合排名 30% / 40% / 50%', '看板'],
  pareto.map((r, i) => [i + 1, r.name, r.code, bd(r), r.industry, r.listDate, F(r.years, 1), P(r.cagr), P(r.maxDD), F(r.calmar), P(r.curDD), r.roll5y ? P(r.roll5y.p10) : '—', P(r.bench.excessCagr), THRESHOLDS.map((T) => N(r.th[T].rank)).join(' / '), link(r, '0.3')])));
L.push('');
{
  const W = WINDOWS[0];
  const pw = wElig(W).filter((r) => r.windows[W.key].pareto).sort((a, b) => b.windows[W.key].cagr - a.windows[W.key].cagr);
  L.push('### Pareto 前沿 · ' + W.label + '窗口（' + W.start + ' → ' + W.end + '）');
  L.push('');
  L.push('在 ' + wElig(W).length + ' 只窗口入选个股内计算。共 ' + pw.length + ' 只（' + boardSplit(pw) + '）。');
  L.push('');
  L.push(table(['#', '名称', '代码', '板块', '行业', '上市日', '区间起点', '年化', '最大回撤', 'Calmar', '当前回撤', '滚动5年P10', '同期上证超额', '窗口综合排名 30% / 40% / 50%', '全史综合排名 30%', '看板'],
    pw.map((r, i) => { const w = r.windows[W.key]; return [i + 1, r.name, r.code, bd(r), r.industry, r.listDate, w.window.start, P(w.cagr), P(w.maxDD), F(w.calmar), P(w.curDD), w.roll5y ? P(w.roll5y.p10) : '—', P(w.bench.excessCagr), THRESHOLDS.map((T) => N(w.th[T].rank)).join(' / '), N(r.th['0.3'].rank), linkR(r, '0.3', W.key)]; })));
  L.push('');
}

// ---- 9. 跨阈值交集（上市至今）
const inAll = elig.filter((r) => THRESHOLDS.every((T) => r.th[T].rank != null && r.th[T].rank <= TOP_N)).sort((a, b) => (a.th['0.3'].rank + a.th['0.4'].rank + a.th['0.5'].rank) - (b.th['0.3'].rank + b.th['0.4'].rank + b.th['0.5'].rank));
L.push('## ' + sec++ + '. 跨阈值交集（上市至今，三个阈值综合榜均进 Top ' + TOP_N + '）');
L.push('');
L.push('共 ' + inAll.length + ' 只（' + boardSplit(inAll) + '），按三阈值名次之和升序。熊市均跌后的 `*` = 该阈值下无合格熊市、回退为最大回撤。');
L.push('');
L.push(table(['#', '名称', '代码', '板块', '行业', '上市日', '年数', '年化', '最大回撤', '滚动5年P10', '排名 30%', '排名 40%', '排名 50%', '熊市均跌 30/40/50', '牛市新高率 30/40/50', '看板'],
  inAll.map((r, i) => [i + 1, r.name, r.code, bd(r), r.industry, r.listDate, F(r.years, 1), P(r.cagr), P(r.maxDD), r.roll5y ? P(r.roll5y.p10) : '—', r.th['0.3'].rank, r.th['0.4'].rank, r.th['0.5'].rank, THRESHOLDS.map((T) => P(r.th[T].avgBearRet, 0) + star(r.th[T])).join(' / '), THRESHOLDS.map((T) => PN(r.th[T].bullNewHighRate, 0)).join(' / '), link(r, '0.3')])));
L.push('');
const pairwise = (a, b) => elig.filter((r) => r.th[a].rank <= TOP_N && r.th[b].rank <= TOP_N).length;
L.push('两两交集：30%∩40% = ' + pairwise('0.3', '0.4') + '，30%∩50% = ' + pairwise('0.3', '0.5') + '，40%∩50% = ' + pairwise('0.4', '0.5') + '。');
L.push('');

// ---- 10. 合理性校验 + 结构观察
L.push('## ' + sec++ + '. 合理性校验（公认长牛股的名次）');
L.push('');
L.push('10 只沪深主板（v1 起）+ 5 只创业板 + 5 只科创板（v3 新增）。近10年窗口要求首根 K 线 ≤ ' + WINDOWS[0].start + '：科创板 ' + BOARD_OPEN.科创板 + ' 开板，**所有科创板个股均不在近10年窗口内**；创业板中 ' + WINDOWS[0].start + ' 之后上市的个股同样不在窗口内（表中注明上市日）。');
L.push('');
const winRanks = (r, W) => (r.windows && r.windows[W.key] ? THRESHOLDS.map((T) => N(r.windows[W.key].th[T].rank)).join(' / ') : '不在窗口（上市 ' + r.listDate + ' 晚于 ' + W.start + '）');
const sanityRows = SANITY.map(([code, nm, board]) => {
  const r = results.find((x) => x.code === code);
  if (!r) return [nm, code, board, '不在股票池', '—', '—', '—', '—', '—', '—', '—', ...WINDOWS.map(() => '—')];
  if (!r.eligible) return [r.name, code, bd(r), '未入选：' + r.excluded_reason, P(r.cagr), P(r.maxDD), '—', '—', '—', '—', '—', ...WINDOWS.map(() => '—')];
  return [r.name, code, bd(r), '入选', P(r.cagr), P(r.maxDD), ...THRESHOLDS.map((T) => N(r.th[T].rank)), '稳 ' + N(r.th['0.3'].steadyRank) + ' / 攻 ' + N(r.th['0.3'].attackRank) + ' / 穿 ' + N(r.th['0.3'].crossRank), r.pareto ? '✓' : '', ...WINDOWS.map((W) => winRanks(r, W))];
});
L.push(table(['名称', '代码', '板块', '状态', '年化', '最大回撤', '综合排名 30%', '综合排名 40%', '综合排名 50%', '分榜名次（30%）', 'Pareto', ...WINDOWS.map((W) => W.label + '综合排名 30 / 40 / 50')], sanityRows));
L.push('');
L.push('科创板 ' + BOARD_OPEN.科创板 + ' 开板，所有科创板个股均不在近10年窗口内。');
L.push('');
const sanityElig = SANITY.map(([code]) => results.find((x) => x.code === code)).filter((r) => r && r.eligible);
const sanityMain = sanityElig.filter((r) => bd(r) === '主板');
const inTop = (rows, k) => THRESHOLDS.map((T) => rows.filter((r) => r.th[T].rank <= k).length);
L.push('入选 ' + sanityElig.length + '/' + SANITY.length + ' 只（主板 ' + sanityMain.length + '/10、创业板 ' + sanityElig.filter((r) => bd(r) === '创业板').length + '/5、科创板 ' + sanityElig.filter((r) => bd(r) === '科创板').length + '/5）。进入上市至今综合榜 Top 50 的数量（30% / 40% / 50%）：全部 20 只 ' + inTop(sanityElig, 50).join(' / ') + '，其中主板 10 只 ' + inTop(sanityMain, 50).join(' / ') + '；Top 100：' + inTop(sanityElig, 100).join(' / ') + '（主板 ' + inTop(sanityMain, 100).join(' / ') + '）；Top 300：' + inTop(sanityElig, 300).join(' / ') + '（主板 ' + inTop(sanityMain, 300).join(' / ') + '）；共 ' + elig.length + ' 只入选。');
for (const W of WINDOWS) {
  const se = sanityElig.filter((r) => r.windows && r.windows[W.key]);
  const inTopW = (k) => THRESHOLDS.map((T) => se.filter((r) => r.windows[W.key].th[T].rank <= k).length);
  L.push(W.label + '窗口（' + se.length + ' 只在窗口内' + (W.key === '10y' ? '：' + boardSplit(se) : '') + '，共 ' + wElig(W).length + ' 只）：进入窗口综合榜 Top 50（30% / 40% / 50%）：' + inTopW(50).join(' / ') + '；Top 100：' + inTopW(100).join(' / ') + '；Top 300：' + inTopW(300).join(' / ') + '。');
}
{
  const byB = BOARD_ORDER.map((b) => { const rows = sanityElig.filter((r) => bd(r) === b); return b + ' ' + rows.length + ' 只中 30% 综合排名 ≤300 的 ' + rows.filter((r) => r.th['0.3'].rank <= 300).length + ' 只（名次 ' + rows.map((r) => r.th['0.3'].rank).sort((x, y) => x - y).join(' / ') + '）'; });
  L.push('按板块（上市至今 30%，共 ' + elig.length + ' 只）：' + byB.join('；') + '。名次方向与常识一致者多，个别高波动成长股（最大回撤深、熊市均跌大）名次靠后属口径所致，见下方结构观察与口径说明。');
}
L.push('');
// 结构观察：综合榜 Top 50 的上市年限 / 无合格熊市 / 当前阶段分布
const all = cnt(elig);
L.push('### 结构观察：综合榜 Top 50 的构成');
L.push('');
L.push('上市年限按上市首日 → 数据截止日计（同窗口榜的行也按上市年限分桶，便于与全史榜比较）；「无合格熊市」= 熊市均跌回退为最大回撤的个股数。');
L.push('');
const structRows = [
  ['全部入选个股', ...buckets.map((b) => all[b] + ' (' + PN(all[b] / elig.length, 0) + ')'), THRESHOLDS.map((T) => elig.filter((r) => r.th[T].avgBearSrc === 'maxDD').length).join(' / '), THRESHOLDS.map((T) => elig.filter((r) => !r.th[T].curPhase.bull).length).join(' / '), boardSplit(elig)],
  ...BOARD_ORDER.map((b) => { const rows = elig.filter((r) => bd(r) === b); const c = cnt(rows); return ['入选 · ' + b, ...buckets.map((k) => c[k] + ' (' + PN(rows.length ? c[k] / rows.length : null, 0) + ')'), THRESHOLDS.map((T) => rows.filter((r) => r.th[T].avgBearSrc === 'maxDD').length).join(' / '), THRESHOLDS.map((T) => rows.filter((r) => !r.th[T].curPhase.bull).length).join(' / '), String(rows.length)]; }),
  ...THRESHOLDS.map((T) => { const top = byRank(T).slice(0, TOP_N); const c = cnt(top); return ['上市至今 Top 50 @' + thLabel(T), ...buckets.map((b) => String(c[b])), String(top.filter((r) => r.th[T].avgBearSrc === 'maxDD').length), String(top.filter((r) => !r.th[T].curPhase.bull).length), boardSplit(top)]; }),
  ...WINDOWS.map((W) => { const T = '0.3'; const top = wByRank(W, T).slice(0, TOP_N); const c = cnt(top); return [W.label + '窗口 Top 50 @30%', ...buckets.map((b) => String(c[b])), String(top.filter((r) => r.windows[W.key].th[T].avgBearSrc === 'maxDD').length), String(top.filter((r) => !r.windows[W.key].th[T].curPhase.bull).length), boardSplit(top)]; }),
];
L.push(table(['', ...buckets, '无合格熊市（熊市均跌回退为最大回撤，30/40/50% 或该行阈值）', '当前处于熊市阶段', '板块构成'], structRows));
L.push('');
L.push('上市不足 10 年的个股在 Top 50 中的数量（30/40/50%）：' + THRESHOLDS.map((T) => byRank(T).slice(0, TOP_N).filter((r) => r.years < 10).length).join(' / ') + '；入选集合中不足 10 年的占 ' + PN((all['5–7 年'] + all['7–10 年']) / elig.length, 0) + '。' + WINDOWS.map((W) => W.label + '窗口 Top 50 @30% 中不足 10 年：' + wByRank(W, '0.3').slice(0, TOP_N).filter((r) => r.years < 10).length + ' 只').join('；') + '。');
L.push('');
L.push('解读：综合分 6 项里有 4 项（最大回撤、Calmar、熊市均跌、滚动 5 年 P10）对历史长度敏感 —— 上市 5–10 年的个股没有经历 2008 / 2015 级别的系统性回撤，最大回撤与熊市均跌天然更浅，因此新股在全史榜中的占比高于其在入选集合中的比例；科创板（最长约 7 年历史）与 2015 年后上市的创业板个股尤其如此。同窗口榜（第 6–7 节）把所有个股放在同一时间窗内比较，是消除这一历史长度差异的对照视角；近10年窗口按定义不含科创板。综合分不含「当前回撤 / 进行中阶段」，榜首可能正处于深度回撤中（见「当前回撤」列）。如需偏向长历史个股，可在 `tools/screen_all.js` 顶部 `CONFIG` 调高 `MIN_YEARS`（如 10）或调整 `COMPOSITE_WEIGHTS` 后 `--compute-only` 重算，一两分钟即可。');
L.push('');

// ---- 11. 口径与局限
L.push('## ' + sec++ + '. 口径与局限');
L.push('');
L.push('- ' + SOURCE_NOTE);
L.push('- 股票池：' + UNIVERSE_DESC + '；每行按分段打「板块」标签（主板 / 创业板 / 科创板）。剔除简称含 ST / *ST / 退、上市不足 5 年（以 K 线首末日计，clist f26 预判）、末根 K 线比上证晚 30 天以上（stale：长期停牌或 clist 仍保留的退市代码）。不剔除历史上曾 ST 后摘帽的（那段回撤如实计入）。');
L.push('- 排名 / 百分位 / 综合分 / 分榜 / Pareto 在全部板块的入选个股内统一计算；板块筛选（screen.html）只筛选显示的行，不重新排名。创业板 ' + BOARD_OPEN.创业板 + ' 开板、科创板 ' + BOARD_OPEN.科创板 + ' 开板：科创板个股历史最长约 7 年，全部不在近10年窗口；「上市年限」相关的局限（见结构观察）对这两个板块更明显。');
if (INTERIM_NOTE) L.push('- 本次股票池数据缺口：' + INTERIM_NOTE);
L.push(IS_TX ? '- 复权：腾讯 hfq 后复权（每页 640 根向前分页、页间重叠 3 根校准拼接，实测分页间复权因子一致）。收益、回撤、ZigZag 全是比率型指标；腾讯与东财在除权除息日的复权因子不同，故与看板数字存在小幅差异。' : '- 复权：后复权 fqt=2。收益、回撤、ZigZag 全是比率型指标，与前复权结果相同；后复权全程为正价格，避免前复权对高分红老股出现非正值。');
L.push('- CAGR = (终值/初值)^(365.25/天数) − 1，初值为上市首日收盘（同窗口榜为窗口首根 K 线收盘）；最大回撤为收盘价相对此前最高收盘的最大跌幅，峰→谷为历时，修复为谷→重回前高用时。');
L.push('- 牛熊划分（ZigZag）：自阶段高点回落 ≥阈值确认熊市、自阶段低点反弹 ≥阈值确认牛市；跌破本轮牛市起点也判牛市结束。先在月收盘（区间 ≥6 年）/ 周收盘（≥2 年）上识别转折、再用日收盘精确定位峰谷；进行中阶段须走出过 ≥阈值行情，否则并入上一阶段。首段为截断阶段。');
L.push('- 阶段均值类指标（v2 / v2.1）：牛市均涨 / 牛市均历时只统计已完成牛市（排除首段截断与进行中段，与 batch_report 的 avgBull 口径一致）。熊市均跌 / 最深熊市 / 熊市均历时统计「合格熊市」= 已完成熊市 + 实现跌幅 ≥ 阈值的首段截断 / 进行中熊市；已完成 / 进行中熊市每轮取阶段起点（枢轴高点）→ 阶段最低点的跌幅 lo（已完成熊市 lo 与 ret 相同），首段（截断）熊市按段内最高点→最低点跌幅计（v2.1，`FIRST_BEAR_DEPTH=\'peak\'`：首段起点是第 0 根 K 线而非枢轴高点，先涨后跌的段用起点量会低估深度）；无合格熊市时熊市均跌 = 最深熊市 = 区间最大回撤（表中 `*` / 熊跌口径 maxDD），熊市均历时记空。');
L.push('- 牛市新高率 = 阶段高点高于阶段起点前全部历史最高收盘（同窗口榜：窗口内历史）的已完成牛市轮数占比，已完成牛市 <2 轮记空；熊市底部抬高率 = 谷底高于上一轮熊市（可为首段）谷底的已完成熊市轮数占比（无上一轮者不计入分母），可比熊市 <2 对记空。为空的项不参与综合分 / 穿越榜。');
L.push('- 滚动 5 年持有年化：以每个月末 K 线为起点、5 年后（不晚于该日的最近 K 线，跨度 ≥ 5 年 − 15 天）为终点的年化收益分布；样本不足 12 个记空（近5年窗口全部为空，综合分按其余 5 项）。');
L.push('- 同窗口榜：起点固定（' + WINDOWS.map((W) => W.label + ' ' + W.start).join(' / ') + '，取首根 ≥ 起点的 K 线；长期停牌股为复牌首日，见「区间起点」列）、终点 = 数据截止日；入选要求上市至今入选且首根 K 线 ≤ 起点；近5年窗口用周收盘划分牛熊。看板 r=10y / r=5y 以看板最新 K 线倒推 120 / 60 个月，打开日期晚于数据截止日时起点会漂移几天，数字与本表略有差异。');
L.push('- 幸存者偏差：只覆盖当前仍在上市、当前非 ST 的股票。');
L.push('- 老股票几乎都经历过 2008 年 −70% 级别回撤，MaxDD 对它们区分度低，所以综合分同时放了「熊市平均跌幅」和「牛市新高率」。');
L.push('- ZigZag 的「牛市」是技术性两态定义（根目录 README 已说明）：多年横盘、反弹后部分回吐都归为「牛」，解读时结合「距阶段高点」和「距区间前高」。');
L.push('- 月收盘识别转折会过滤短反弹，牛熊轮数比按日线少，这是看板的既定口径；阈值越高（40% / 50%）已完成轮次越少，上市刚满 5 年的股票可能一轮都没有。');
L.push('- 数据终点：所有个股与指数统一截至 ' + (DATA_END || '—') + '（' + DATA_END_NOTE + '）；其后的 K 线（含盘中未收盘 K 线、其后几个交易日）在计算前已全部丢弃，`metrics_*.csv` 的「末根K线」列可核对。');
L.push('- 重算与校验：`node tools/screen_all.js --compute-only [--data-end YYYY-MM-DD]` → `node tools/screen_report.js` → `node tools/screen_verify.js`（校验日志 `screen/out/screen_verify.log`）。');
L.push('');
fs.writeFileSync(path.join(PUB, 'report.md'), L.join('\n'), 'utf8');

// ------------------------------------------------------------------ screen.html 壳 + screen/data/*.js（紧凑数组打包：按区间 × 阈值拆文件，首屏 meta + all + all_th30）
const BASE_KEYS = ['code', 'name', 'secid', 'board', 'industry', 'listDate', 'years', 'total', 'cagr', 'maxDD', 'ddPeak', 'ddTrough', 'ddDownDays', 'ddRecDays', 'ddRecovered', 'ddSinceTroughDays', 'curDD', 'calmar', 'roll5yP10', 'excessSz', 'pareto', 'winStart']; // 页面只读这 22 项（vol / roll5yMedian / roll5yWin 不再输出）
const WIN_BASE_KEYS = BASE_KEYS.slice(6); // code/name/secid/board/industry/listDate 六个身份字段来自全史行（按下标对齐；模板 materialize 时复制）
const TH_KEYS = ['nBull', 'nBear', 'nCB', 'nBQ', 'bearSrc', 'avgBearRet', 'avgBullRet', 'deepestBearRet', 'bullNewHighRate', 'bearHigherLowRate', 'bullTimeShare', 'curBull', 'curRet', 'composite', 'rank', 'steadyRank', 'attackRank', 'crossRank'];
const r4 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
// 行业字典：行内存下标，META.industries 存字符串（KEYS.dict 记录需解码的字段）
const INDUSTRIES = [...new Set(elig.map((r) => r.industry || ''))].sort();
const INDUSTRY_IDX = new Map(INDUSTRIES.map((s, i) => [s, i]));
function baseValue(v, baseRow, k) {
  switch (k) {
    case 'code': return baseRow.code; case 'name': return baseRow.name; case 'secid': return baseRow.secid; case 'board': return bd(baseRow); case 'industry': return INDUSTRY_IDX.get(baseRow.industry || ''); case 'listDate': return baseRow.listDate;
    case 'years': return v.years == null ? null : Math.round(v.years * 100) / 100;
    case 'roll5yP10': return v.roll5y ? r4(v.roll5y.p10) : null;
    case 'excessSz': return r4(v.bench.excessCagr); case 'pareto': return !!v.pareto; case 'winStart': return v.window ? v.window.start : null;
    case 'ddPeak': case 'ddTrough': return v[k]; case 'ddDownDays': case 'ddRecDays': case 'ddSinceTroughDays': return v[k]; case 'ddRecovered': return !!v.ddRecovered;
    default: return r4(v[k]);
  }
}
const packBase = (v, baseRow, keys) => keys.map((k) => baseValue(v, baseRow, k));
const packTh = (t) => [t.nBull, t.nBear, t.nCompletedBear, t.nBearQualifying, t.avgBearSrc === 'maxDD' ? 1 : 0, r4(t.avgBearRet), r4(t.avgBullRet), r4(t.deepestBearRet), r4(t.bullNewHighRate), r4(t.bearHigherLowRate), r4(t.bullTimeShare), t.curPhase.bull, r4(t.curPhase.ret), r4(t.composite), t.rank, t.steadyRank, t.attackRank, t.crossRank];
const viewOf = (r, w) => (w === 'all' ? r : r.windows && r.windows[w] ? r.windows[w] : null);
const VIEW_KEYS = ['all'].concat(WINDOWS.map((W) => W.key));
const BASE = {}, TH = {}; // BASE[w] = [行|null…]（与 elig 下标对齐）；TH[w][T] = [18 项数组|null…]（同对齐）
for (const w of VIEW_KEYS) {
  BASE[w] = elig.map((r) => { const v = viewOf(r, w); return v ? packBase(v, r, w === 'all' ? BASE_KEYS : WIN_BASE_KEYS) : null; });
  TH[w] = {}; for (const T of THRESHOLDS) TH[w][T] = elig.map((r) => { const v = viewOf(r, w); return v ? packTh(v.th[T]) : null; });
}
const KEYS = { base: BASE_KEYS, winBase: WIN_BASE_KEYS, th: TH_KEYS, thresholds: THRESHOLDS, boards: BOARD_ORDER, windows: [{ key: 'all', label: '上市至今', range: 'all', start: null }].concat(WINDOWS.map((W) => ({ key: W.key, label: W.label, range: W.key, start: W.start }))), dict: { industry: 'industries' } };
const benchPack = (f) => benchmarks.map((b) => { const v = f(b); return v ? { name: b.name, cagr: v.cagr, maxDD: v.maxDD } : { name: b.name, cagr: null, maxDD: null }; });
const htmlBench = { all: benchPack((b) => b) }; for (const W of WINDOWS) htmlBench[W.key] = benchPack((b) => b.windows && b.windows[W.key]);
const windowEligible = {}; for (const W of WINDOWS) windowEligible[W.key] = wElig(W).length;
const boards = {}; for (const b of BOARD_ORDER) { boards[b] = { universe: boardCount(results, b), eligible: boardCount(elig, b) }; for (const W of WINDOWS) boards[b]['w' + W.key] = boardCount(wElig(W), b); }
const htmlMeta = { version: VER.replace(/^v/i, ''), source: SOURCE, sourceLabel: SOURCE_LABEL, sourceNote: SOURCE_NOTE, universeNote: INTERIM_NOTE_HTML, dataEndDate: DATA_END, dataEndSpec: DATA_END_SPEC, dataEndMode: DATA_END_MODE, universe: results.length, eligible: elig.length, windowEligible, boards, universeFetchedAt: uf && uf.fetchedAt ? uf.fetchedAt.slice(0, 10) : null, generated: new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC', thresholds: THRESHOLDS, benchmarks: htmlBench, industries: INDUSTRIES };
const safeJSON = (o) => JSON.stringify(o).replace(/</g, '\\u003c').replace(/-->/g, '--\\u003e');
// 数据文件：纯 JS 赋值（<script> 注入即可读，file:// 下无需 fetch）；先清掉目录里的旧 *.js，避免残留过期文件
fs.mkdirSync(DATA_DIR, { recursive: true });
for (const f of fs.readdirSync(DATA_DIR)) if (f.endsWith('.js')) fs.unlinkSync(path.join(DATA_DIR, f));
const sizes = {};
const writeData = (name, body) => { const s = body + '\n'; fs.writeFileSync(path.join(DATA_DIR, name), s, 'utf8'); sizes[name] = Buffer.byteLength(s); };
const dataFile = (key, arr) => 'window.__SCREEN_DATA=window.__SCREEN_DATA||{};window.__SCREEN_DATA["' + key + '"]=' + safeJSON(arr) + ';';
const thName = (w, T) => w + '_th' + Math.round(+T * 100);
writeData('meta.js', 'window.__SCREEN_META=' + safeJSON({ META: htmlMeta, KEYS }) + ';');
for (const w of VIEW_KEYS) {
  writeData(w + '.js', dataFile(w, BASE[w]));
  for (const T of THRESHOLDS) writeData(thName(w, T) + '.js', dataFile(thName(w, T), TH[w][T]));
}
const startupBytes = sizes['meta.js'] + sizes['all.js'] + sizes['all_th30.js'];
const html = fs.readFileSync(TEMPLATE, 'utf8').split('__DASH_BASE__').join(DASH_HTML).split('__DATA_KB__').join(String(Math.round(startupBytes / 1024)));
if (/__META__|__KEYS__|__DATA__|__WIN__/.test(html)) throw new Error('screen_template.html still contains an inline data placeholder (__META__ / __KEYS__ / __DATA__ / __WIN__)');
if (Buffer.byteLength(html) >= 60 * 1024) throw new Error('screen.html shell too large: ' + Buffer.byteLength(html) + ' bytes (limit 61440)');
fs.writeFileSync(HTML_OUT, html, 'utf8');
process.stdout.write('report.md lines=' + L.length + ' eligible=' + elig.length + ' boards=' + JSON.stringify(boards) + ' windows=' + JSON.stringify(windowEligible) + ' pareto=' + pareto.length + ' inAll3=' + inAll.length + ' shell bytes=' + Buffer.byteLength(html) + ' data files=' + JSON.stringify(sizes) + ' startup(meta+all+all_th30)=' + startupBytes + ' bytes -> ' + HTML_OUT + ' + ' + DATA_DIR + '\n');
