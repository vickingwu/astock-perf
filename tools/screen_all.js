#!/usr/bin/env node
/* A 股全市场（沪深主板 + 创业板 + 科创板）「牛熊逻辑」筛选 —— 股票池 → 日线缓存 → analyze × 3 阈值 → 指标 → 排名
 *
 * 用法（在仓库根目录执行；路径均相对本文件所在的 tools/ 解析，可在任意 cwd 运行）：
 *   node tools/screen_all.js                      全量：股票池 + 拉数（断点续传）+ 计算
 *   node tools/screen_all.js --fetch-only         只拉数（首次全量约 3–4 小时，可中断续跑；或用 tools/fetch_watchdog.js 托管）
 *   node tools/screen_all.js --compute-only       只用本地缓存重算（不联网）
 *   node tools/screen_all.js --data-end 2026-10-15 --compute-only   固定统一数据终点（默认 auto = 缓存上证末根日期）
 *   node tools/screen_all.js --sample 10          前 10 只 + 合理性校验股
 *   node tools/screen_all.js --codes 600519,300015
 *   node tools/screen_all.js --refresh-universe   强制重拉 clist 股票池（4 个分段）
 *   node tools/screen_all.js --universe-only      只处理股票池（拉取 / 为临时行补 上市日·行业·市值 / 预剔除）并写 screen/universe.json，不拉 K 线不计算
 *   node tools/screen_all.js --source tencent --fetch-only     回退数据源：腾讯 web.ifzq.gtimg.cn 后复权日线（东财限流期间）
 *   node tools/screen_all.js --source tencent --compute-only   用腾讯缓存（screen/out/klines_tx）计算
 *
 * 引擎：../app.js（只 require，不修改）。数据：东方财富 clist（股票池，分段 CONFIG.UNIVERSE_SEGMENTS）+ push2his 日线（后复权 fqt=2，与看板同口径）；
 *       --source tencent 时日线改用腾讯 fqkline（hfq，每页 640 根向前分页、重叠拼接），口径与看板略有差异。
 * 产出（入库，screen/）：screen/universe.json, screen/metrics_th30|40|50.csv, screen/metrics_w10y.csv, screen/metrics_w5y.csv（同窗口榜：一行一只窗口入选个股，三阈值列组）,
 *       screen/run_meta.json（含 source / version / windows / dataEnd / boardCounts / sanity 字段）
 * 工作文件（不入库，screen/out/）：klines/<secid>.json（东财）| klines_tx/<secid>.json（腾讯）, universe_fetch.json（分段事实）, fetch.log | fetch_tx.log, run.log,
 *       fetch_failures.json | fetch_failures_tx.json, fetch_done_<source>.json（全量队列完成且无限流类失败时写入，供看门狗判断）,
 *       results.json（每行含 windows: {'10y','5y'} 同窗口指标，非入选为 null）, benchmarks.json
 *
 * v2（2026-10-16）：
 *   1. 熊市均跌 / 最深熊市：合格熊市 = 已完成熊市 + 实现跌幅 |lo| ≥ 阈值的首段截断 / 进行中熊市；每轮取 lo（起点→最低点）；无合格熊市取最大回撤（不再记 0）。
 *   2. 牛市新高率 / 熊市底部抬高率：样本 < MIN_CYCLES_FOR_RATE（2）记空（不计分）。
 *   3. 同窗口榜：近10年（2016-10-15 →）/ 近5年（2021-10-15 →）各自在窗口入选集合内算百分位 / 综合分 / 分榜 / Pareto。
 * v2.1（2026-10-16）：
 *   首段（截断）熊市按段内最高点→最低点跌幅计（CONFIG.FIRST_BEAR_DEPTH = 'peak'）：引擎 lo 从段起点（第 0 根 = 上市首日 / 窗口首根，而非枢轴高点）量起，
 *   IPO 冲高后回落的个股深度被低估（法狮龙首段熊 lo −31.5% vs 段内峰→谷 −53.2%）。合格判定 |depth| ≥ 阈值、熊市均跌、最深熊市均改用 depth；
 *   已完成 / 进行中熊市仍取 lo（段起点即枢轴高点，二者相同）。'start' = v2 口径（仍可选）。
 * v3（2026-10-19）：
 *   1. 股票池扩为 沪深主板 + 创业板 + 科创板（CONFIG.UNIVERSE_SEGMENTS 分段拉 clist，每行带 board 标签；北交所不含）。排名 / 百分位 / 综合分仍在全部入选个股内统一计算，板块只是标签。
 *   2. --data-end YYYY-MM-DD|auto：统一数据终点改为命令行指定；auto = 缓存上证末根日期（上海时间当日 15:05 前取前一根）。--fetch-only 不解析。
 *   3. fetch_done_<source>.json 只在全量队列（非 --codes / --sample）无限流类失败时写入。指标口径与 v2.1 完全一致。
 *   4. 代码移入 astock-perf/tools/，产出发布到 screen/ 与根目录 screen.html；工作文件在 screen/out/（.gitignore）。
 */
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');            // 仓库根目录（app.js / index.html / screen.html 所在）
const PUB_DIR = path.join(ROOT, 'screen');          // 入库产出
const OUT_DIR = path.join(ROOT, 'screen', 'out');   // 工作目录（不入库）
const CONFIG = {
  THRESHOLDS: [0.3, 0.4, 0.5],          // 牛熊阈值
  MIN_YEARS: 5,                         // 上市年限门槛（以 K 线首末日计）
  STALE_DAYS: 30,                       // 末根 K 线比上证晚于 30 天 → stale（长期停牌）
  DATA_END: 'auto',                     // 统一数据终点（--data-end 可覆盖）：compute 时丢弃所有来源（个股 + 指数）t > DATA_END 的 K 线；'auto' = 缓存上证末根日期（上海时间当日 15:05 前取前一根，见 resolveDataEnd）；'YYYY-MM-DD' = 固定
  SLEEP_MS: 2000,                       // 请求间隔（原 700ms 于 10-15 导致本机 IP 被东财封约 18 小时；1.5s 于 10-16 拉 2,818 只 0 失败；本次 2.0s —— 不要调快）
  FETCH_BOARD_ORDER: ['主板', '科创板', '创业板'], // 东财拉数队列的板块顺序（主板基本已缓存；科创板优先于创业板尾段）
  CLIST_SLEEP_MS: 2500,                 // clist 翻页间隔（≥1.5s；10-19 封禁疑由密集 clist 翻页 + 重试触发）；502 时冷却 60s→120s→240s→300s 重试同一页
  CLIST_HOSTS: ['push2.eastmoney.com', 'push2delay.eastmoney.com'], // clist 主机：同一接口、同一字段；一页失败后换下一台重试（10-20 / 10-21 观察 push2 返回 502 时 push2delay 仍可能 200）
  ENRICH_COOLDOWNS: { startup: 2, recover: 1, universeOnly: 15 }, // enrichF26 补临时行的最大冷却次数：拉数前 / 解封后只试几次（不耽误拉 K 线）；--universe-only 专门补股票池，可多等（15 次 ≈ 最多 55 分钟）
  BATCH_PAUSE_EVERY: 200,               // 每拉取 N 只（不含缓存命中）暂停一次
  BATCH_PAUSE_MS: 60000,                // 暂停时长 60s
  RETRIES: 5,                           // HTTP 层错误（502 / data:null / 非 JSON）重试次数，退避 2s × attempt
  RESET_RETRIES: 12,                    // 连接层 reset（TLS 握手后 0 字节即 ECONNRESET = 东财边缘节点按 IP 限流）每次 HTTP 尝试内的快速重试次数
  RESET_WAIT_MS: 500,                   // reset 后等待（请求根本没到应用层，无需长退避；6 次后加倍）
  COOLDOWN_BASE_MS: 30000,              // 单只股票失败后冷却 30s，连续失败按 2 倍递增，上限 COOLDOWN_MAX_MS（限流会随时间衰减）
  COOLDOWN_MAX_MS: 300000,
  ABORT_AFTER_CONSEC_FAIL: Infinity,    // 用户要求：拉数过程不能中断，东财线每 5 分钟探测一次直到解封，永不因失败退出（看门狗 fetch_watchdog.js 负责崩溃重启）
  SOURCE: 'eastmoney',                  // 'eastmoney'（默认，与看板同口径）| 'tencent'（--source tencent 回退）
  TX: {                                 // 腾讯 fqkline 回退参数（稳定优先于速度：单并发）
    PAGE: 640,                          // 接口单次上限
    END_DATE: null,                     // 固定区间终点（含端点，已验证 end 为闭区间；日期区间形式不返回盘中未结算 K 线）。main() 在 --data-end 给出具体日期时设为该日期，
                                        // 保证全部个股与基准指数终点同日；null 则自动取「明天」（含当日已结算 K 线）。
    OVERLAP: 3,                         // 分页时下一页 end 取本页第 3 根的日期（闭区间 → 重叠 3 根），用于拼接校准
    SLEEP_MS: 500,                      // 每个请求（含分页）之间的间隔
    BACKOFF_BASE_MS: 60000,             // 任何非 200 / 非 JSON / code≠0 / 连接错误：指数退避 60s→120s→…
    BACKOFF_MAX_MS: 600000,             // 退避上限 10 分钟
    MAX_CONSEC_PER_REQ: 12,             // 同一请求连续失败 12 次（累计约 1.6 小时）才放弃该只、记入失败并继续；进程不退出
    HEADERS: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' },
  },
  COMPOSITE_WEIGHTS: { cagr: 1, calmar: 1, maxDD: 1, avgBearRet: 1, bullNewHighRate: 1, roll5yP10: 1 }, // 综合分权重（等权）
  BOARDS: { steady: ['avgBearRet', 'maxDD'], attack: ['cagr', 'avgBullRet'], cross: ['bullNewHighRate', 'bearHigherLowRate'] },
  BOARD_REQUIRE_ALL: { cross: true },   // 穿越榜要求两项都非空
  TOP_N: 50,
  ROLL_MONTHS: 60, ROLL_MIN_N: 12,      // 滚动 5 年持有收益：按月末起点，样本 <12 记空
  VERSION: 'v3',
  WINDOWS: [                            // 同窗口榜：起点固定、终点 = DATA_END；入选 = 全史入选 且 首根 K 线 ≤ start
    { key: '10y', label: '近10年', start: '2016-10-15' },
    { key: '5y', label: '近5年', start: '2021-10-15' },
  ],
  MIN_CYCLES_FOR_RATE: 2,               // 牛市新高率 / 熊市底部抬高率：分母 < 2 记空（不计分）
  FIRST_BEAR_DEPTH: 'peak',             // 首段（截断）熊市深度：'peak' = 段内最高点→最低点（段内最大回撤，v2.1）| 'start' = 段起点→最低点（引擎 lo，v2 口径）
  OUT_DIR,                              // screen/out（工作文件，不入库）
  PUB_DIR,                              // screen（入库产出）
  KLINE_DIR: path.join(OUT_DIR, 'klines'),      // 当前数据源的缓存目录；--source tencent 时在 main() 里切到 KLINE_DIR_TX
  KLINE_DIR_EM: path.join(OUT_DIR, 'klines'),
  KLINE_DIR_TX: path.join(OUT_DIR, 'klines_tx'),
  DASH_BASE: '../index.html',           // CSV / results.json 里的看板链接，相对 screen/ 目录（report.md 同；根目录 screen.html 用 ./index.html）
  FQT: '2',                             // 后复权：所有指标为比率型，与前复权结果一致且全程可用
  UNIVERSE_SEGMENTS: [                  // 分段拉 clist（顺序同 astock-perf/tools/build_stock_list.js）；每行打 board 标签；北交所 m:0+t:81+s:2048 不含
    { board: '主板', fs: 'm:0+t:6' },     // 深主板（含原中小板）
    { board: '创业板', fs: 'm:0+t:80' },
    { board: '主板', fs: 'm:1+t:2' },     // 沪主板
    { board: '科创板', fs: 'm:1+t:23' },
  ],
  BENCHMARKS: [
    { key: 'sz', secid: '1.000001', name: '上证指数' },
    { key: 'hs300', secid: '1.000300', name: '沪深300', minStart: '2005-01-04' },
  ],
  SANITY_CODES: ['600519', '600900', '000333', '600887', '600276', '600436', '000538', '000651', '600036', '600309',
    '300015', '300760', '300750', '300059', '300124', '688012', '688111', '688981', '688008', '688036'],
};

const E = require('../app.js'); // 看板引擎（analyze / computeHorizons / yearlyReturns / 日期工具），只读不改
const DAY = 86400000;
const HEADERS = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const fin = (x) => (x == null || typeof x !== 'number' || !isFinite(x) ? null : x);
const rd = (x, d = 6) => { x = fin(x); return x == null ? null : Math.round(x * Math.pow(10, d)) / Math.pow(10, d); };
const inferMarket = (code) => (/^[569]/.test(code) ? 1 : 0);
// 板块回退推断（--codes 合成行 / 旧版无 board 字段的 universe.json）：30x 创业板、688/689 科创板、其余主板
const inferBoard = (code) => (/^30[0-2]/.test(code) ? '创业板' : /^68[89]/.test(code) ? '科创板' : '主板');
const boardOf = (row) => row.board || inferBoard(row.code);

// ------------------------------------------------------------------ io
function ensureDirs() { for (const d of [CONFIG.OUT_DIR, CONFIG.PUB_DIR, CONFIG.KLINE_DIR]) fs.mkdirSync(d, { recursive: true }); }
function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); }
function writeJSON(p, obj, pretty) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, pretty ? JSON.stringify(obj, null, 1) : JSON.stringify(obj), 'utf8');
  fs.renameSync(tmp, p);
}
function writeRows(p, rows) { // 每行一个对象，便于 diff / 流式读取
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, '[\n' + rows.map((r) => JSON.stringify(r)).join(',\n') + '\n]\n', 'utf8');
  fs.renameSync(tmp, p);
}
const RUN_LOG = path.join(CONFIG.OUT_DIR, 'run.log');
function log(s) { const line = nowIso() + ' ' + s; try { fs.appendFileSync(RUN_LOG, line + '\n', 'utf8'); } catch (e) { /* ignore */ } process.stdout.write(line + '\n'); }
// 按数据源区分的文件名（东财保持原名，腾讯加 _tx 后缀）；工作文件在 OUT_DIR，入库产出在 PUB_DIR
const isTx = () => CONFIG.SOURCE === 'tencent';
const P_OUT = (name) => path.join(CONFIG.OUT_DIR, name);
const P_PUB = (name) => path.join(CONFIG.PUB_DIR, name);
const P_UNIVERSE = () => P_PUB('universe.json');
const P_FETCH_LOG = () => P_OUT(isTx() ? 'fetch_tx.log' : 'fetch.log');
const P_FAILURES = () => P_OUT(isTx() ? 'fetch_failures_tx.json' : 'fetch_failures.json');
const P_DONE = () => P_OUT('fetch_done_' + CONFIG.SOURCE + '.json');
const P_FETCH_META = () => P_OUT('run_meta_fetch_' + CONFIG.SOURCE + '.json');
function flog(s) { fs.appendFileSync(P_FETCH_LOG(), s + '\n', 'utf8'); }

// ------------------------------------------------------------------ http
const AGENT = new https.Agent({ keepAlive: false }); // 每次新建连接：Node≥19 全局 agent 默认 keep-alive，复用被服务端关掉的空闲连接会报 socket hang up
function get1(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: HEADERS, timeout: 30000, agent: AGENT }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
// 带重试的 JSON GET：空响应 / HTML / 非 JSON / data:null 均视为失败并退避重试
let lastAttempts = 0, lastResets = 0; // 最近一次 getJSON 的 HTTP 层尝试次数 / 连接 reset 次数（写入日志便于观察链路质量）
const isReset = (e) => e && (e.code === 'ECONNRESET' || /socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/.test(e.message));
async function getJSON(url, validate, opts) {
  const retries = (opts && opts.retries) || CONFIG.RETRIES, backoff = (opts && opts.backoffMs) || 2000;
  const resetRetries = opts && opts.resetRetries != null ? opts.resetRetries : CONFIG.RESET_RETRIES;
  let lastErr = null;
  lastAttempts = 0; lastResets = 0;
  for (let attempt = 1; attempt <= retries; attempt++) {
    lastAttempts = attempt;
    try {
      let r, resets = 0; // 每次 HTTP 尝试内独立计数
      for (;;) { // 连接层 reset：快速重试，不计入 HTTP 层尝试
        try { r = await get1(url); break; } catch (e) {
          if (!isReset(e) || resets >= resetRetries) throw e;
          resets++; lastResets++;
          await sleep(CONFIG.RESET_WAIT_MS * (resets > 6 ? 2 : 1));
        }
      }
      const fail = (msg, kind) => { const ex = new Error(msg); ex.kind = kind; throw ex; };
      if (r.status !== 200) fail('HTTP ' + r.status, 'throttle');
      if (!r.body) fail('empty response', 'throttle');
      let j;
      try { j = JSON.parse(r.body); } catch (e) { fail('non-JSON response: ' + r.body.slice(0, 80).replace(/\s+/g, ' '), 'throttle'); }
      const err = validate ? validate(j) : null;
      if (err) fail(err, 'invalid'); // 合法 JSON 但无数据（如已退市代码）：按单只失败处理，不触发冷却
      return j;
    } catch (e) {
      lastErr = e;
      if (!e.kind) e.kind = 'throttle'; // reset / timeout / DNS 等连接层错误
      if (attempt < retries) await sleep(backoff * attempt);
    }
  }
  throw lastErr || new Error('unknown');
}

// ------------------------------------------------------------------ universe (clist)
function parseF26(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^(19|20)\d{6}$/.test(s)) return null;
  const m = +s.slice(4, 6), d = +s.slice(6, 8);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
}
// 拉一个 clist 分段的全部页（pz=100）。节奏：页间 CONFIG.CLIST_SLEEP_MS；502 / 空数据 / 非 JSON：getJSON 内快速重试 2 次（5s×attempt），
// 仍失败则冷却 60s→120s→240s→300s 后重试同一页；maxCooldowns 用尽则抛错（全量股票池传 Infinity = 永不放弃；f26 补数传有限值 = 失败就放弃）。
// 10-19 封禁很可能由 clist 翻页 + 重试 + 探测在 20 分钟内的密集请求触发，不是 K 线节奏 —— 翻页不要再快。
async function fetchSegment(seg, maxCooldowns) {
  const UT = 'bd1d9ddb04089700cf9c27f6f7426281';
  const raw = [];
  let page = 1, total = Infinity, pages = 0, cool = 0, consec = 0, hostIdx = 0; // cool = 本分段累计冷却次数（受 maxCooldowns 约束）；consec = 连续失败次数（决定退避长度，成功后归零）；hostIdx 失败后轮换 CLIST_HOSTS
  while (raw.length < total) {
    let j, host;
    for (;;) {
      host = CONFIG.CLIST_HOSTS[hostIdx % CONFIG.CLIST_HOSTS.length];
      const url = 'https://' + host + '/api/qt/clist/get?pn=' + page + '&pz=100&po=1&np=1&ut=' + UT + '&fltt=2&invt=2&fid=f12&fields=f12,f13,f14,f26,f100,f20&fs=' + encodeURIComponent(seg.fs);
      try { j = await getJSON(url, (x) => (!x || !x.data || !Array.isArray(x.data.diff) ? 'unexpected clist response' : x.data.diff.length === 0 && raw.length < total && total !== Infinity ? 'empty page' : null), { retries: 2, backoffMs: 5000 }); consec = 0; break; } catch (e) {
        cool++; consec++; hostIdx++;
        if (cool > maxCooldowns) throw new Error('clist ' + seg.board + ' ' + seg.fs + ' page ' + page + ' gave up after ' + maxCooldowns + ' cooldown(s): ' + e.message);
        const wait = Math.min(300000, 60000 * Math.pow(2, Math.min(consec - 1, 2))); // 60s→120s→240s→300s，按连续失败次数退避（10-20 观察到 502 为间歇性、按请求随机落到不同后端，成功后重置）
        log('clist ' + seg.board + ' page ' + page + ' failed (' + e.message + ') @' + host + ', cooldown ' + Math.round(wait / 1000) + 's (#' + cool + (isFinite(maxCooldowns) ? '/' + maxCooldowns : '') + ', consecutive ' + consec + '), next host ' + CONFIG.CLIST_HOSTS[hostIdx % CONFIG.CLIST_HOSTS.length]);
        await sleep(wait);
      }
    }
    total = j.data.total;
    for (const it of j.data.diff) raw.push(Object.assign({ _board: seg.board }, it));
    pages++;
    log('clist ' + seg.board + ' ' + seg.fs + ' page ' + page + ' -> ' + raw.length + '/' + total + ' @' + host);
    if (j.data.diff.length === 0) break;
    page++;
    await sleep(CONFIG.CLIST_SLEEP_MS);
  }
  const f26ok = raw.filter((it) => parseF26(it.f26)).length;
  log('clist ' + seg.board + ' ' + seg.fs + ' total=' + total + ' pages=' + pages + ' rows=' + raw.length + ' f26 valid=' + f26ok + ' cooldowns=' + cool);
  return { raw, total, pages, f26ok, cooldowns: cool };
}
const rowFromClist = (it, board) => ({
  code: String(it.f12), name: E.cleanName(it.f14), market: Number(it.f13), secid: Number(it.f13) + '.' + String(it.f12), board,
  listDate: parseF26(it.f26), industry: typeof it.f100 === 'string' ? it.f100 : '', mcap: typeof it.f20 === 'number' ? it.f20 : null, excluded_reason: null,
});
// 分段拉 clist（CONFIG.UNIVERSE_SEGMENTS），每行带 board；按 secid 去重（先出现的分段优先）；分段事实写入 out/universe_fetch.json
async function fetchUniverse(meta) {
  const raw = [], segments = [];
  for (const seg of CONFIG.UNIVERSE_SEGMENTS) {
    const r = await fetchSegment(seg, Infinity);
    segments.push({ board: seg.board, fs: seg.fs, total: r.total, rows: r.raw.length, pages: r.pages, f26ok: r.f26ok });
    raw.push(...r.raw);
  }
  const f26Usable = raw.filter((it) => parseF26(it.f26)).length >= Math.ceil(raw.length * 0.8); // f26 格式校验（期望 YYYYMMDD 整数；未上市行为 '-'）
  log('clist f26Usable=' + f26Usable);
  const seen = new Set(), rows = [];
  for (const it of raw) {
    const row = rowFromClist(it, it._board);
    if (seen.has(row.secid)) continue;
    seen.add(row.secid);
    if (!f26Usable) row.listDate = null;
    rows.push(row);
  }
  rows.sort((a, b) => a.code.localeCompare(b.code) || a.market - b.market);
  const byBoard = {}; for (const r of rows) byBoard[r.board] = (byBoard[r.board] || 0) + 1;
  log('universe rows=' + rows.length + ' (dedup from ' + raw.length + ') by board ' + JSON.stringify(byBoard));
  const uf = { fetchedAt: nowIso(), segments, rows: rows.length, dedupFrom: raw.length, byBoard };
  writeJSON(P_OUT('universe_fetch.json'), uf, true);
  if (meta) meta.universeSegments = segments;
  return rows;
}
// 临时股票池补 f26（2026-10-19：clist 被封时 创业板/科创板 行来自 astock-perf/stocks.js，带 interim 标记、无上市日）：
//   用带节奏的 clist 只重拉含 interim 行的分段，补上市日 / 行业 / 市值，并立即重算预剔除 —— 上市日晚于 5 年门槛的行不再拉 K 线（约省 700 次请求）。
//   maxCooldowns 有限：clist 仍 502 则放弃、保留临时池继续拉数（K 线 5 年规则兜底，只是多花时间）。已补到的分段即使后一段失败也保留。
async function enrichF26(universe, todayT, maxCooldowns, tag) {
  const need = universe.filter((u) => u.interim && u.listDate == null);
  if (!need.length) return null;
  const boards = new Set(need.map((u) => u.board));
  const segs = CONFIG.UNIVERSE_SEGMENTS.filter((s) => boards.has(s.board));
  log('enrich f26 (' + tag + '): ' + need.length + ' interim rows without listDate; segments ' + segs.map((s) => s.board + ' ' + s.fs).join(', ') + '; maxCooldowns=' + maxCooldowns);
  const bySecid = new Map(universe.map((u) => [u.secid, u]));
  const res = { ok: false, tag, at: nowIso(), updated: 0, added: 0, newlyExcluded: 0, segmentsDone: [], error: null };
  try {
    for (const seg of segs) {
      const r = await fetchSegment(seg, maxCooldowns);
      if (r.f26ok < Math.ceil(r.raw.length * 0.8)) throw new Error('clist ' + seg.board + ' f26 mostly invalid (' + r.f26ok + '/' + r.raw.length + ')');
      for (const it of r.raw) {
        const fresh = rowFromClist(it, seg.board);
        let u = bySecid.get(fresh.secid);
        if (!u) { u = fresh; universe.push(u); bySecid.set(u.secid, u); res.added++; }
        else { u.name = fresh.name; u.listDate = fresh.listDate; u.industry = fresh.industry; u.mcap = fresh.mcap; }
        delete u.interim;
        u.f26From = 'clist ' + res.at.slice(0, 10);
        const was = u.excluded_reason;
        u.excluded_reason = preExclusion(u, todayT);
        res.updated++;
        if (!was && u.excluded_reason) res.newlyExcluded++;
      }
      res.segmentsDone.push({ board: seg.board, fs: seg.fs, total: r.total, rows: r.raw.length });
      log('enrich f26: ' + seg.board + ' done, rows=' + r.raw.length + ' cumulative updated=' + res.updated + ' newlyExcluded=' + res.newlyExcluded);
    }
    res.ok = true;
  } catch (e) { res.error = e.message; log('enrich f26 (' + tag + ') incomplete, keeping interim rows for the rest: ' + e.message); }
  universe.sort((a, b) => a.code.localeCompare(b.code) || a.market - b.market);
  writeJSON(P_UNIVERSE(), universe, true);
  const left = universe.filter((u) => u.interim && u.listDate == null).length;
  log('enrich f26 (' + tag + ') result ' + JSON.stringify(Object.assign({}, res, { segmentsDone: res.segmentsDone.length, interimLeft: left })));
  try { const hp = P_OUT('universe_enrich.json'); const hist = fs.existsSync(hp) ? readJSON(hp) : []; hist.push(res); writeJSON(hp, hist, true); } catch (e) { /* ignore */ }
  return res;
}
// 预剔除（拉数前即可判定）：ST/退；f26 显示上市不足 5 年（K 线年限 ≤ f26 年限，故预剔除不会误杀）
function preExclusion(r, todayT) {
  if (/ST|退/.test(E.cleanName(r.name))) return 'ST/退 in name';
  if (r.listDate && (todayT - E.parseYMD(r.listDate)) / 365.25 < CONFIG.MIN_YEARS) return 'listed<' + CONFIG.MIN_YEARS + 'y (f26)';
  return null;
}

// ------------------------------------------------------------------ klines fetch & cache
function cachePath(secid) { return path.join(CONFIG.KLINE_DIR, secid + '.json'); }
function loadCache(secid) {
  const p = cachePath(secid);
  if (!fs.existsSync(p)) return null;
  try {
    const j = readJSON(p);
    if (!j || !Array.isArray(j.bars)) return null;
    return j;
  } catch (e) { return null; }
}
async function fetchKline(secid, opts) {
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=' + secid + '&ut=fa5fd1943c7b386f172d6893dbfba10b&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=' + CONFIG.FQT + '&beg=0&end=20500101&lmt=1000000';
  const j = await getJSON(url, (x) => (!x.data ? 'data:null' + (x.rc != null ? ' rc=' + x.rc : '') : !Array.isArray(x.data.klines) ? 'no klines' : null), opts);
  const bars = [];
  for (const s of j.data.klines) { const p = s.split(','); const c = +p[2]; if (c > 0) bars.push([E.parseYMD(p[0]), c]); }
  return { name: E.cleanName(j.data.name), secid, fetchedAt: nowIso(), dropped: j.data.klines.length - bars.length, bars };
}
// ------------------------------------------------------------------ tencent fallback (web.ifzq.gtimg.cn fqkline, hfq)
// param=<sh|sz><code>,day,<start>,<end>,640,hfq：返回 end 之前（含/不含端点在不同缓存节点上表现不一致）最近 640 根。
// 分页：下一页 end 取本页第 OVERLAP 根的日期 → 页间至少重叠 2 根；拼接时用重叠日收盘比值的中位数校准旧页（接口分页间复权因子一致时系数恒为 1，
// 若不一致则由此消除页间跳变）。整只股票所有页拼完才落盘，避免半截缓存。
const txSymbol = (secid) => { const [m, code] = secid.split('.'); return (m === '1' ? 'sh' : 'sz') + code; };
function rawGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 30000, agent: AGENT }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
const tagErr = (msg, kind) => { const ex = new Error(msg); ex.kind = kind; return ex; };
let txConsecFail = 0, txTotalFail = 0, txTotalReq = 0;
async function txGetPage(sym, end) {
  const url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + sym + ',day,1990-01-01,' + end + ',' + CONFIG.TX.PAGE + ',hfq';
  for (let k = 1; ; k++) {
    try {
      txTotalReq++;
      const r = await rawGet(url, CONFIG.TX.HEADERS);
      if (r.status !== 200) throw tagErr('HTTP ' + r.status, 'throttle');
      if (!r.body) throw tagErr('empty response', 'throttle');
      let j;
      try { j = JSON.parse(r.body); } catch (e) { throw tagErr('non-JSON: ' + r.body.slice(0, 80).replace(/\s+/g, ' '), 'throttle'); }
      if (j.code !== 0) throw tagErr('code=' + j.code + ' ' + (j.msg || ''), 'throttle');
      if (!j.data || Array.isArray(j.data) || !j.data[sym]) throw tagErr('no data object (' + (j.msg || 'param error') + ')', 'invalid'); // 参数错误 / 代码不存在：不退避
      const d = j.data[sym];
      const rows = d.hfqday || d.qfqday || d.day || [];
      const name = d.qt && d.qt[sym] && d.qt[sym][1] ? String(d.qt[sym][1]) : '';
      txConsecFail = 0;
      return { rows, name };
    } catch (e) {
      if (e.kind === 'invalid') throw e;
      txConsecFail++; txTotalFail++;
      if (k >= CONFIG.TX.MAX_CONSEC_PER_REQ) throw tagErr((e.message || String(e)) + ' (gave up after ' + k + ' tries)', 'throttle');
      const wait = Math.min(CONFIG.TX.BACKOFF_MAX_MS, CONFIG.TX.BACKOFF_BASE_MS * Math.pow(2, Math.min(txConsecFail - 1, 10)));
      flog(nowIso() + ' backoff ' + Math.round(wait / 1000) + 's (consecutive failure #' + txConsecFail + ': ' + (e.code || e.message) + ') ' + sym + ' end=' + end);
      await sleep(wait);
    }
  }
}
function localDatePlus(days) { const d = new Date(Date.now() + days * DAY); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
async function fetchKlineTencent(secid, fallbackName) {
  const sym = txSymbol(secid);
  let end = CONFIG.TX.END_DATE || localDatePlus(1); // 固定终点；或次日（含今日已结算 K 线）
  const pages = [];
  let name = '';
  for (let p = 0; p < 80; p++) {
    const { rows, name: nm } = await txGetPage(sym, end);
    if (nm) name = nm;
    if (!rows.length) break;
    pages.push(rows);
    if (rows.length < CONFIG.TX.PAGE) break; // 已到首根
    const nextEnd = rows[Math.min(CONFIG.TX.OVERLAP - 1, rows.length - 1)][0];
    if (!(nextEnd < end)) break; // 无进展保护
    end = nextEnd;
    await sleep(CONFIG.TX.SLEEP_MS);
  }
  // 拼接：从最新页开始，旧页按重叠日比值的中位数缩放
  const out = new Map(); // date -> close（已校准）
  const scales = [];
  let scale = 1;
  for (let k = 0; k < pages.length; k++) {
    const rows = pages[k];
    if (k > 0) {
      const ratios = [];
      for (const r of rows) { const c = +r[2]; if (c > 0 && out.has(r[0])) ratios.push(out.get(r[0]) / c); }
      if (ratios.length) { ratios.sort((a, b) => a - b); scale = ratios[ratios.length >> 1]; }
      scales.push(ratios.length ? rd(scale, 6) : null);
    }
    for (const r of rows) { const c = +r[2]; if (!(c > 0)) continue; if (!out.has(r[0])) out.set(r[0], c * scale); }
  }
  const dates = Array.from(out.keys()).sort();
  const bars = dates.map((d) => [E.parseYMD(d), out.get(d)]);
  const rawCount = pages.reduce((s, r) => s + r.length, 0);
  const scaleDev = scales.reduce((m, s) => (s == null ? m : Math.max(m, Math.abs(s - 1))), 0);
  return { name: E.cleanName(name || fallbackName || ''), secid, source: 'tencent', fetchedAt: nowIso(), pages: pages.length, pageScales: scales, scaleDev: rd(scaleDev, 6), dropped: rawCount - bars.length, bars };
}

let SUBSET_RUN = false; // --codes / --sample：子集运行不写 done 标记（看门狗以 done 标记判定全量完成）
// opts.onRecover：限流解封后（连续失败 ≥ RECOVER_AFTER_CONSEC 之后首次成功）调用一次，用于补 f26；队列行持有 universe 行引用，补数后被预剔除的行在轮到时跳过
const RECOVER_AFTER_CONSEC = 3;
async function fetchStage(targets, meta, opts) {
  opts = opts || {};
  const queue = [];
  for (const b of CONFIG.BENCHMARKS) queue.push({ secid: b.secid, name: b.name });
  if (isTx()) { // 腾讯线：先拉东财已缓存的那批，便于尽早做口径对比；再按股票池顺序
    const emCached = new Set(fs.existsSync(CONFIG.KLINE_DIR_EM) ? fs.readdirSync(CONFIG.KLINE_DIR_EM).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : []);
    for (const r of targets) if (!r.excluded_reason && emCached.has(r.secid)) queue.push({ secid: r.secid, name: r.name, row: r });
    for (const r of targets) if (!r.excluded_reason && !emCached.has(r.secid)) queue.push({ secid: r.secid, name: r.name, row: r });
  } else {
    // 板块顺序 CONFIG.FETCH_BOARD_ORDER（稳定排序，板块内保持代码序）：2026-10-20 要求解封后先拉科创板（其中约 350 只满 5 年，是入选集合缺的最后一块），再拉创业板尾段
    const ord = (r) => { const i = CONFIG.FETCH_BOARD_ORDER.indexOf(boardOf(r)); return i < 0 ? CONFIG.FETCH_BOARD_ORDER.length : i; };
    const rows = targets.filter((r) => !r.excluded_reason).map((r, i) => [r, i]).sort((a, b) => ord(a[0]) - ord(b[0]) || a[1] - b[1]);
    for (const [r] of rows) queue.push({ secid: r.secid, name: r.name, row: r });
  }
  flog('=== fetch start ' + nowIso() + ' source=' + CONFIG.SOURCE + ' queue=' + queue.length + ' (benchmarks ' + CONFIG.BENCHMARKS.length + ')' + (isTx() ? ' page=' + CONFIG.TX.PAGE + ' sleep=' + CONFIG.TX.SLEEP_MS + 'ms backoff=' + CONFIG.TX.BACKOFF_BASE_MS / 1000 + 's..' + CONFIG.TX.BACKOFF_MAX_MS / 1000 + 's' : ' sleep=' + CONFIG.SLEEP_MS + 'ms'));
  log('fetch queue=' + queue.length + ' source=' + CONFIG.SOURCE);
  const failures = [];
  let consec = 0, nOk = 0, nCached = 0, nFail = 0, nRetriedReq = 0, nResets = 0, aborted = false, nSkipped = 0, wasThrottled = false, recoverCalls = 0;
  async function one(q, i, total, tag) {
    const cached = loadCache(q.secid);
    if (cached && cached.bars.length > 0) { nCached++; flog(nowIso() + ' ' + i + '/' + total + ' ' + q.secid + ' ' + (q.name || cached.name) + ' ' + cached.bars.length + ' cached'); return 'cached'; }
    try {
      let d;
      if (isTx()) {
        d = await fetchKlineTencent(q.secid, q.name);
        if (!d.bars.length) throw tagErr('no klines returned', 'invalid');
        writeJSON(cachePath(q.secid), d);
        nOk++; consec = 0;
        flog(nowIso() + ' ' + i + '/' + total + ' ' + q.secid + ' ' + (q.name || d.name) + ' ' + d.bars.length + ' ok pages=' + d.pages + ' scaleDev=' + d.scaleDev + (d.dropped ? ' dropped=' + d.dropped : '') + (tag || ''));
        return 'ok';
      }
      // 东财：冷却期内只发 1 个探测请求（避免探测本身维持限流）；正常期走完整重试
      d = await fetchKline(q.secid, consec > 0 ? { retries: 1, resetRetries: 0 } : undefined);
      d.source = 'eastmoney';
      writeJSON(cachePath(q.secid), d);
      nOk++; consec = 0; if (lastAttempts > 1) nRetriedReq++; nResets += lastResets;
      flog(nowIso() + ' ' + i + '/' + total + ' ' + q.secid + ' ' + (q.name || d.name) + ' ' + d.bars.length + ' ok' + (d.dropped ? ' dropped=' + d.dropped : '') + (lastAttempts > 1 ? ' attempts=' + lastAttempts : '') + (lastResets ? ' resets=' + lastResets : '') + (tag || ''));
      return 'ok';
    } catch (e) {
      nFail++; nResets += lastResets;
      if (e.kind === 'invalid') consec = 0; else consec++; // 无数据不算限流
      failures.push({ secid: q.secid, name: q.name, error: e.message, kind: e.kind || 'throttle', at: nowIso() });
      flog(nowIso() + ' ' + i + '/' + total + ' ' + q.secid + ' ' + q.name + ' 0 FAILED ' + e.message + ' kind=' + (e.kind || 'throttle') + ' attempts=' + lastAttempts + ' resets=' + lastResets + (tag || ''));
      return e.kind === 'invalid' ? 'nodata' : 'fail';
    }
  }
  const pace = isTx() ? CONFIG.TX.SLEEP_MS : CONFIG.SLEEP_MS;
  for (let i = 0; i < queue.length; i++) {
    if (queue[i].row && queue[i].row.excluded_reason) { nSkipped++; flog(nowIso() + ' ' + (i + 1) + '/' + queue.length + ' ' + queue[i].secid + ' ' + queue[i].name + ' skipped (' + queue[i].row.excluded_reason + ' after f26 enrich)'); continue; }
    const st = await one(queue[i], i + 1, queue.length, '');
    if (st === 'ok' && wasThrottled) { // 解封后首次成功：补 f26（只会真正执行一次：之后 interim 行已清空 → onRecover 返回 null）
      wasThrottled = false;
      if (opts.onRecover) { recoverCalls++; flog('=== throttle recovered at ' + nowIso() + ', running onRecover #' + recoverCalls); try { const r = await opts.onRecover(); flog('=== onRecover result ' + JSON.stringify(r && { ok: r.ok, updated: r.updated, newlyExcluded: r.newlyExcluded, error: r.error })); } catch (e) { flog('=== onRecover error ' + e.message); } await sleep(pace); }
    }
    if (st === 'fail' && !isTx()) {
      if (consec >= RECOVER_AFTER_CONSEC) wasThrottled = true;
      if (consec >= CONFIG.ABORT_AFTER_CONSEC_FAIL) { aborted = true; flog('ABORT: ' + consec + ' consecutive failures at ' + nowIso()); log('ABORT: ' + consec + ' consecutive failures'); break; }
      // 东财被限流：冷却后再试同一只（不跳过），冷却时间随连续失败次数翻倍（腾讯线的退避在 txGetPage 内完成，这里直接进入下一只）
      const cool = Math.min(CONFIG.COOLDOWN_MAX_MS, CONFIG.COOLDOWN_BASE_MS * Math.pow(2, Math.min(consec - 1, 6)));
      flog('cooldown ' + Math.round(cool / 1000) + 's after ' + consec + ' consecutive failure(s), will retry ' + queue[i].secid); log('cooldown ' + Math.round(cool / 1000) + 's (consec=' + consec + ')');
      await sleep(cool);
      failures.pop(); nFail--; i--; // 回退一格重试同一只；最终失败只在 ABORT 时留在 failures 里
      continue;
    }
    if (st !== 'cached') {
      await sleep(pace);
      if (!isTx() && nOk > 0 && nOk % CONFIG.BATCH_PAUSE_EVERY === 0 && st === 'ok') { flog('batch pause ' + Math.round(CONFIG.BATCH_PAUSE_MS / 1000) + 's after ' + nOk + ' fetched'); log('batch pause after ' + nOk + ' fetched'); await sleep(CONFIG.BATCH_PAUSE_MS); }
    }
    if ((i + 1) % 100 === 0) { const s = 'fetch progress ' + (i + 1) + '/' + queue.length + ' ok=' + nOk + ' cached=' + nCached + ' fail=' + nFail + (isTx() ? ' txReq=' + txTotalReq + ' txFail=' + txTotalFail : ' httpRetries=' + nRetriedReq + ' resets=' + nResets); log(s); flog('--- ' + nowIso() + ' ' + s); }
  }
  // 失败的最后再试一轮
  let retried = 0, recovered = 0;
  if (!aborted && failures.length) {
    const again = failures.splice(0, failures.length);
    flog('=== retry ' + again.length + ' failed secids ' + nowIso());
    for (let i = 0; i < again.length; i++) {
      retried++;
      const st = await one({ secid: again[i].secid, name: again[i].name }, i + 1, again.length, ' (retry)');
      if (st === 'ok') recovered++;
      await sleep(pace);
    }
  }
  // 腾讯线：队列跑完后重拉一次基准指数，保证指数末根与个股同日（指数当日 K 线入库比个股略晚）
  let benchRefreshed = 0;
  if (isTx() && !aborted) {
    for (const b of CONFIG.BENCHMARKS) {
      try { const d = await fetchKlineTencent(b.secid, b.name); if (d.bars.length) { writeJSON(cachePath(b.secid), d); benchRefreshed++; flog(nowIso() + ' refreshed benchmark ' + b.secid + ' ' + b.name + ' ' + d.bars.length + ' last=' + E.fmtDate(d.bars[d.bars.length - 1][0])); } } catch (e) { flog(nowIso() + ' benchmark refresh FAILED ' + b.secid + ' ' + e.message); }
      await sleep(pace);
    }
  }
  writeJSON(P_FAILURES(), failures, true);
  const residual = failures.filter((f) => f.kind !== 'invalid').length;
  const summary = { source: CONFIG.SOURCE, queue: queue.length, ok: nOk, cached: nCached, skipped: nSkipped, failed: failures.length, failedInvalid: failures.length - residual, failedThrottle: residual, httpRetries: nRetriedReq, connResets: nResets, txRequests: txTotalReq, txFailures: txTotalFail, retried, recovered, recoverCalls, benchRefreshed, aborted, finishedAt: nowIso() };
  flog('=== fetch end ' + JSON.stringify(summary));
  log('fetch end ' + JSON.stringify(summary));
  if (!aborted && residual === 0 && !SUBSET_RUN) { writeJSON(P_DONE(), summary, true); flog('=== DONE marker written ' + P_DONE()); }
  else if (SUBSET_RUN) flog('=== subset run (--codes/--sample): done marker not written');
  meta.fetch = summary;
  return summary;
}

// ------------------------------------------------------------------ metrics
function quantile(sorted, q) {
  const m = sorted.length; if (!m) return null;
  const pos = q * (m - 1), lo = Math.floor(pos), hi = Math.min(m - 1, lo + 1), f = pos - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * f;
}
const monthKey = (t) => { const d = E.tToDate(t); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
// 滚动 N 月持有年化：每个月末 K 线为起点 i，终点 j = 不晚于 t_i+N 月的最近 K 线，要求跨度 ≥ N 月 − 15 天
function rollingHold(all, t, c) {
  const n = all.length, vals = [];
  const minSpan = (CONFIG.ROLL_MONTHS / 12) * 365.25 - 15;
  for (let i = 0; i < n - 1; i++) {
    if (monthKey(t[i]) === monthKey(t[i + 1])) continue;
    const j = E.idxOnOrBefore(all, E.addMonths(t[i], CONFIG.ROLL_MONTHS));
    if (j <= i) continue;
    const span = t[j] - t[i];
    if (span < minSpan) continue;
    vals.push(Math.pow(c[j] / c[i], 365.25 / span) - 1);
  }
  if (vals.length < CONFIG.ROLL_MIN_N) return null;
  vals.sort((a, b) => a - b);
  return { p10: rd(quantile(vals, 0.1)), median: rd(quantile(vals, 0.5)), winRate: rd(vals.filter((v) => v > 0).length / vals.length), n: vals.length };
}
function benchCagr(bench, t0, t1) {
  if (!bench) return null;
  const i0 = E.idxOnOrBefore(bench, t0), i1 = E.idxOnOrBefore(bench, t1);
  if (i0 < 0 || i1 <= i0) return null;
  const days = bench[i1].t - bench[i0].t;
  if (days < 20) return null;
  return Math.pow(bench[i1].c / bench[i0].c, 365.25 / days) - 1;
}
function thresholdMetrics(A, T, secid, prefixMax, range) {
  range = range || 'all';
  const { t, c, phases } = A;
  const EPS = 1e-9;
  const mean = (arr, f) => (arr.length ? arr.reduce((s, p) => s + f(p), 0) / arr.length : null);
  const completed = phases.filter((p) => !p.first && !p.ongoing);
  const bulls = completed.filter((p) => p.bull);
  const bearsCompleted = completed.filter((p) => !p.bull);
  // v2.1 熊市深度：首段（截断）熊市的 s 是第 0 根而非枢轴高点，lo = c[i]/c[s]−1 会低估先涨后跌的段；FIRST_BEAR_DEPTH='peak' 时改为段内最大回撤
  //   depth = min_{i∈[s,e]} ( c[i] / max(c[s..i]) − 1 )（段起点即段内最高点时与 lo 相等）。已完成 / 进行中熊市 s 为枢轴高点，保持 lo。
  const bearDepth = (p) => {
    if (!p.first || CONFIG.FIRST_BEAR_DEPTH !== 'peak') return p.lo;
    let mx = -Infinity, d = Infinity;
    for (let i = p.s; i <= p.e; i++) { if (c[i] > mx) mx = c[i]; const y = c[i] / mx - 1; if (y < d) d = y; }
    return d;
  };
  // v2 合格熊市：已完成熊市，或 首段/进行中 且 实现跌幅 |depth| ≥ T（用原始值判定，不用四舍五入值；v2.1 首段用 depth）
  const bearsQ = phases.filter((p) => !p.bull && ((!p.first && !p.ongoing) || -bearDepth(p) >= T - EPS));
  const cur = phases[phases.length - 1];
  // 牛市新高率：已完成牛市中，阶段高点 c[extI] > 阶段起点之前的历史最高收盘 max(c[0..s])
  let nh = 0;
  for (const p of bulls) if (c[p.extI] > prefixMax[p.s]) nh++;
  // 熊市底部抬高率：已完成熊市中，谷底高于上一轮熊市（可为首段）谷底；无上一轮熊市者不计入分母
  let hl = 0, hlDen = 0, prevBear = null;
  for (const p of phases) {
    if (p.bull) continue;
    if (!p.first && !p.ongoing && prevBear) { hlDen++; if (c[p.extI] > c[prevBear.extI]) hl++; }
    prevBear = p;
  }
  const avgBullRet = mean(bulls, (p) => p.ret);
  // v2：每轮熊市跌幅取 lo（阶段起点→最低点；已完成熊市 lo === ret）；无合格熊市 → 回退为上市以来最大回撤（真实序列永不为 0）
  // v2.1：首段（截断）熊市改用 bearDepth（段内最高点→最低点），其余不变
  const ddDepth = A.maxDD ? A.maxDD.depth : null;
  const avgBearRet = bearsQ.length ? mean(bearsQ, bearDepth) : ddDepth;
  const deepestBearRet = bearsQ.length ? Math.min.apply(null, bearsQ.map(bearDepth)) : ddDepth;
  const avgBearDays = bearsQ.length ? mean(bearsQ, (p) => p.days) : null; // 进行中段用至今天数
  const avgBearSrc = bearsQ.length ? 'bears' : 'maxDD';
  const bullDays = phases.filter((p) => p.bull).reduce((s, p) => s + p.days, 0);
  return {
    basis: A.basis,
    nBull: phases.filter((p) => p.bull).length, nBear: phases.filter((p) => !p.bull).length,
    nCompletedBull: bulls.length, nCompletedBear: bearsCompleted.length,
    nBearQualifying: bearsQ.length, nBearPairs: hlDen, avgBearSrc,
    curPhase: { bull: cur.bull, start: E.fmtDate(t[cur.s]), days: cur.days, ret: rd(cur.ret), ann: rd(cur.ann), fromExt: rd(cur.fromExt) },
    phases: phases.map((p) => Object.assign({ bull: p.bull, s: E.fmtDate(t[p.s]), e: E.fmtDate(t[p.e]), days: p.days, ret: rd(p.ret), ann: rd(p.ann), lo: rd(p.lo), hi: rd(p.hi), ongoing: p.ongoing, first: p.first, ext: E.fmtDate(t[p.extI]) }, p.bull ? null : { depth: rd(bearDepth(p)) })), // depth：熊市计入均跌的跌幅（v2.1 首段 = 段内峰→谷，其余 = lo）
    avgBullRet: rd(avgBullRet), avgBullDays: rd(mean(bulls, (p) => p.days), 1),
    avgBearRet: rd(avgBearRet), deepestBearRet: rd(deepestBearRet), avgBearDays: rd(avgBearDays, 1),
    bullTimeShare: A.days > 0 ? rd(bullDays / A.days) : null,
    asymmetry: avgBullRet != null && avgBearRet != null && avgBearRet < 0 ? rd(avgBullRet / Math.abs(avgBearRet)) : null,
    bullNewHighRate: bulls.length >= CONFIG.MIN_CYCLES_FOR_RATE ? rd(nh / bulls.length) : null,
    bearHigherLowRate: hlDen >= CONFIG.MIN_CYCLES_FOR_RATE ? rd(hl / hlDen) : null,
    link: CONFIG.DASH_BASE + '#s=' + secid + '&r=' + range + '&fqt=' + CONFIG.FQT + '&th=' + T,
  };
}
// 全部指标：起点 = 首根 K 线（上市首日收盘），终点 = 末根 K 线
// opts.range：'all'（默认，上市至今）| CONFIG.WINDOWS[*].key（同窗口视图：bars 已切到窗口起点，不算 hz / yearly，附 window 字段）
function computeStock(bars, secid, benches, opts) {
  opts = opts || { range: 'all' };
  const isAll = !opts.range || opts.range === 'all';
  const all = bars.map((b) => ({ t: b[0], c: b[1] }));
  const n = all.length, last = all[n - 1];
  const A0 = E.analyze(all, CONFIG.THRESHOLDS[0], 'auto');
  const t = A0.t, c = A0.c, ep = A0.maxDD;
  const prefixMax = new Array(n); let mx = -Infinity; for (let i = 0; i < n; i++) { if (c[i] > mx) mx = c[i]; prefixMax[i] = mx; } // 窗口视图：新高 = 窗口内新高
  let luw = 0; for (const e of A0.episodes) luw = Math.max(luw, (e.end != null ? t[e.end] : t[n - 1]) - t[e.peak]);
  let hz = null;
  if (isAll) { const H = E.computeHorizons(all, A0); hz = {}; for (const row of H) for (const cell of row) hz[cell.k] = rd(cell.v); }
  const szC = benchCagr(benches.sz, t[0], last.t);
  const hsC = benches.hs300 && t[0] >= E.parseYMD(CONFIG.BENCHMARKS[1].minStart) ? benchCagr(benches.hs300, t[0], last.t) : null;
  const cagr = fin(A0.cagr), maxDD = ep ? ep.depth : 0;
  const r = {
    listDate: E.fmtDate(t[0]), lastDate: E.fmtDate(last.t), lastClose: last.c, nBars: n,
    years: rd(A0.days / 365.25, 3), total: rd(A0.total), cagr: rd(cagr), vol: rd(A0.vol),
    maxDD: rd(maxDD), ddPeak: ep ? E.fmtDate(t[ep.peak]) : null, ddTrough: ep ? E.fmtDate(t[ep.trough]) : null,
    ddDownDays: ep ? t[ep.trough] - t[ep.peak] : null, ddRecDays: ep && ep.end != null ? t[ep.end] - t[ep.trough] : null,
    ddRecovered: ep ? ep.end != null : true, ddSinceTroughDays: ep && ep.end == null ? last.t - t[ep.trough] : null,
    longestUnderwaterDays: luw,
    curDD: rd(A0.curDD), curPeakDate: E.fmtDate(t[A0.curPeakIdx]),
    calmar: cagr != null && maxDD < 0 ? rd(cagr / Math.abs(maxDD)) : null,
    roll5y: rollingHold(all, t, c),
    bench: { szCagr: rd(szC), excessCagr: cagr != null && szC != null ? rd(cagr - szC) : null, hs300Cagr: rd(hsC), excessHs300: cagr != null && hsC != null ? rd(cagr - hsC) : null },
    th: {},
  };
  if (isAll) { r.hz = hz; r.yearly = E.yearlyReturns(all).map((y) => [y.y, rd(y.v, 4)]); }
  else r.window = { key: opts.range, startSpec: opts.startSpec, start: E.fmtDate(t[0]), end: E.fmtDate(last.t) };
  for (const T of CONFIG.THRESHOLDS) {
    const A = T === CONFIG.THRESHOLDS[0] ? A0 : E.analyze(all, T, 'auto');
    r.th[String(T)] = thresholdMetrics(A, T, secid, prefixMax, isAll ? 'all' : opts.range);
  }
  return r;
}
// 同窗口视图：首根 K 线必须 ≤ 窗口起点，视图 = 首根 ≥ 起点的 K 线 → 末根（已按 DATA_END 截断）
function windowView(barsTC, startSpec) { // barsTC = 缓存 bars [[t,c],...]
  const startT = E.parseYMD(startSpec);
  if (barsTC[0][0] > startT) return null; // 首根 K 线晚于窗口起点 → 不入选该窗口
  let lo = 0, hi = barsTC.length - 1, i0 = barsTC.length; // idxOnOrAfter（[t,c] 数组版）
  while (lo <= hi) { const m = (lo + hi) >> 1; if (barsTC[m][0] >= startT) { i0 = m; hi = m - 1; } else lo = m + 1; }
  const v = barsTC.slice(i0);
  return v.length >= 2 && v[v.length - 1][0] - v[0][0] >= 20 ? v : null;
}
function computeWindows(barsTC, secid, benches) {
  const w = {};
  for (const W of CONFIG.WINDOWS) { const v = windowView(barsTC, W.start); w[W.key] = v ? computeStock(v, secid, benches, { range: W.key, startSpec: W.start }) : null; }
  return w;
}

// ------------------------------------------------------------------ ranking
// 百分位（0~1，越高越好；并列取平均名次）
function percentiles(vals) {
  const out = new Array(vals.length).fill(null);
  const idx = []; for (let i = 0; i < vals.length; i++) if (fin(vals[i]) != null) idx.push(i);
  const m = idx.length; if (!m) return out;
  idx.sort((a, b) => vals[a] - vals[b]);
  let i = 0;
  while (i < m) {
    let j = i; while (j + 1 < m && vals[idx[j + 1]] === vals[idx[i]]) j++;
    const p = m > 1 ? ((i + j) / 2) / (m - 1) : 0.5;
    for (let k = i; k <= j; k++) out[idx[k]] = rd(p);
    i = j + 1;
  }
  return out;
}
function rankBy(rows, getScore, setRank, view) { // 分数降序 → 1 起名次；空分不排名；同分按年化、代码
  const scored = rows.filter((r) => fin(getScore(r)) != null).sort((a, b) => getScore(b) - getScore(a) || (view(b).cagr || 0) - (view(a).cagr || 0) || a.code.localeCompare(b.code));
  scored.forEach((r, i) => setRank(r, i + 1));
}
// 对一个视图排名：view(r) 返回持有 cagr/calmar/maxDD/roll5y/th/pareto 的记录（上市至今 = r 本身；同窗口 = r.windows[key]）
// 百分位 / 综合分 / 分榜 / Pareto 均只在传入的 rows（该视图的入选集合）内计算
function rankView(rows, view) {
  const metricGetters = {
    cagr: (r) => view(r).cagr, calmar: (r) => view(r).calmar, maxDD: (r) => view(r).maxDD, roll5yP10: (r) => (view(r).roll5y ? view(r).roll5y.p10 : null),
    avgBearRet: (r, T) => view(r).th[T].avgBearRet, bullNewHighRate: (r, T) => view(r).th[T].bullNewHighRate, avgBullRet: (r, T) => view(r).th[T].avgBullRet, bearHigherLowRate: (r, T) => view(r).th[T].bearHigherLowRate,
  };
  for (const Tn of CONFIG.THRESHOLDS) {
    const T = String(Tn);
    const pct = {};
    for (const k of Object.keys(metricGetters)) pct[k] = percentiles(rows.map((r) => metricGetters[k](r, T)));
    rows.forEach((r, i) => {
      const th = view(r).th[T];
      th.pct = {}; for (const k of Object.keys(metricGetters)) th.pct[k] = pct[k][i];
      let ws = 0, s = 0;
      for (const k of Object.keys(CONFIG.COMPOSITE_WEIGHTS)) if (th.pct[k] != null) { ws += CONFIG.COMPOSITE_WEIGHTS[k]; s += CONFIG.COMPOSITE_WEIGHTS[k] * th.pct[k]; }
      th.composite = ws ? rd(s / ws) : null;
      th.compositeN = Object.keys(CONFIG.COMPOSITE_WEIGHTS).filter((k) => th.pct[k] != null).length;
      for (const b of Object.keys(CONFIG.BOARDS)) {
        const ks = CONFIG.BOARDS[b], avail = ks.filter((k) => th.pct[k] != null);
        th[b] = (CONFIG.BOARD_REQUIRE_ALL[b] ? avail.length === ks.length : avail.length > 0) ? rd(avail.reduce((a, k) => a + th.pct[k], 0) / avail.length) : null;
      }
    });
    rankBy(rows, (r) => view(r).th[T].composite, (r, k) => { view(r).th[T].rank = k; }, view);
    for (const b of Object.keys(CONFIG.BOARDS)) rankBy(rows, (r) => view(r).th[T][b], (r, k) => { view(r).th[T][b + 'Rank'] = k; }, view);
  }
  // Pareto 前沿（CAGR↑, MaxDD↑ 均不被压制），与阈值无关
  const sorted = rows.slice().sort((a, b) => view(b).cagr - view(a).cagr || view(b).maxDD - view(a).maxDD);
  let bestDD = -Infinity;
  for (const r of sorted) { const v = view(r); if (v.maxDD > bestDD) { v.pareto = true; bestDD = v.maxDD; } else v.pareto = false; }
  return rows.length;
}
function rankStage(results) {
  const elig = results.filter((r) => r.eligible);
  const out = { eligible: rankView(elig, (r) => r), windows: {} };
  for (const W of CONFIG.WINDOWS) out.windows[W.key] = rankView(elig.filter((r) => r.windows && r.windows[W.key]), (r) => r.windows[W.key]);
  return out;
}

// ------------------------------------------------------------------ csv
function csvCell(v) {
  if (v == null || (typeof v === 'number' && !isFinite(v))) return '';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return String(v);
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvColumns(T) {
  const g = (f) => (r) => { try { return f(r); } catch (e) { return null; } };
  const th = (f) => g((r) => f(r.th[T]));
  return [
    ['代码', (r) => r.code], ['名称', (r) => r.name], ['市场', (r) => (r.market === 1 ? '沪' : '深')], ['板块', (r) => r.board], ['secid', (r) => r.secid], ['行业', (r) => r.industry],
    ['总市值(亿)', (r) => (r.mcap != null ? rd(r.mcap / 1e8, 2) : null)], ['上市日(f26)', (r) => r.listDateF26],
    ['入选', (r) => r.eligible], ['剔除原因', (r) => r.excluded_reason],
    ['首根K线', (r) => r.listDate], ['末根K线', (r) => r.lastDate], ['最新收盘', (r) => r.lastClose], ['K线数', (r) => r.nBars], ['年数', (r) => r.years],
    ['累计收益', (r) => r.total], ['年化', (r) => r.cagr], ['年化波动', (r) => r.vol], ['Calmar', (r) => r.calmar],
    ['最大回撤', (r) => r.maxDD], ['回撤峰日', (r) => r.ddPeak], ['回撤谷日', (r) => r.ddTrough], ['峰谷天数', (r) => r.ddDownDays], ['修复天数', (r) => r.ddRecDays], ['已修复', (r) => r.ddRecovered], ['谷后未修复天数', (r) => r.ddSinceTroughDays],
    ['最长水下天数', (r) => r.longestUnderwaterDays], ['当前回撤', (r) => r.curDD], ['前高日', (r) => r.curPeakDate],
    ['滚动5年P10', g((r) => r.roll5y.p10)], ['滚动5年中位', g((r) => r.roll5y.median)], ['滚动5年胜率', g((r) => r.roll5y.winRate)], ['滚动5年样本', g((r) => r.roll5y.n)],
    ['同期上证年化', g((r) => r.bench.szCagr)], ['上证超额', g((r) => r.bench.excessCagr)], ['同期沪深300年化', g((r) => r.bench.hs300Cagr)], ['沪深300超额', g((r) => r.bench.excessHs300)],
    ['近1年', g((r) => r.hz['1年'])], ['近3年', g((r) => r.hz['3年'])], ['近5年', g((r) => r.hz['5年'])], ['近10年', g((r) => r.hz['10年'])], ['近20年', g((r) => r.hz['20年'])], ['年初至今', g((r) => r.hz['年初至今'])],
    ['Pareto前沿', (r) => r.pareto],
    ['阈值', (r) => (r.th && r.th[T] ? +T : null)], ['划分依据', th((x) => x.basis)],
    ['牛轮数', th((x) => x.nBull)], ['熊轮数', th((x) => x.nBear)], ['完成牛轮数', th((x) => x.nCompletedBull)], ['完成熊轮数', th((x) => x.nCompletedBear)],
    ['合格熊轮数', th((x) => x.nBearQualifying)], ['熊市均跌口径', th((x) => x.avgBearSrc)], ['熊市可比对数', th((x) => x.nBearPairs)],
    ['当前阶段', th((x) => (x.curPhase.bull ? '牛' : '熊'))], ['当前阶段起点', th((x) => x.curPhase.start)], ['当前阶段天数', th((x) => x.curPhase.days)], ['当前阶段涨跌', th((x) => x.curPhase.ret)], ['距阶段极值', th((x) => x.curPhase.fromExt)],
    ['牛市均涨', th((x) => x.avgBullRet)], ['牛市均历时', th((x) => x.avgBullDays)], ['熊市均跌', th((x) => x.avgBearRet)], ['最深熊市', th((x) => x.deepestBearRet)], ['熊市均历时', th((x) => x.avgBearDays)],
    ['牛市时间占比', th((x) => x.bullTimeShare)], ['牛熊非对称比', th((x) => x.asymmetry)], ['牛市新高率', th((x) => x.bullNewHighRate)], ['底部抬高率', th((x) => x.bearHigherLowRate)],
    ['综合分', th((x) => x.composite)], ['综合排名', th((x) => x.rank)], ['综合指标数', th((x) => x.compositeN)],
    ['稳健分', th((x) => x.steady)], ['稳健排名', th((x) => x.steadyRank)], ['进攻分', th((x) => x.attack)], ['进攻排名', th((x) => x.attackRank)], ['穿越分', th((x) => x.cross)], ['穿越排名', th((x) => x.crossRank)],
    ['pct_年化', th((x) => x.pct.cagr)], ['pct_Calmar', th((x) => x.pct.calmar)], ['pct_最大回撤', th((x) => x.pct.maxDD)], ['pct_熊市均跌', th((x) => x.pct.avgBearRet)], ['pct_牛市新高率', th((x) => x.pct.bullNewHighRate)], ['pct_滚动5年P10', th((x) => x.pct.roll5yP10)],
    ['pct_牛市均涨', th((x) => x.pct.avgBullRet)], ['pct_底部抬高率', th((x) => x.pct.bearHigherLowRate)],
    ['看板', th((x) => x.link)],
    ['数据源', () => (isTx() ? '腾讯hfq' : '东财fqt2')],
  ];
}
function writeCSV(p, results, T) {
  const cols = csvColumns(T);
  const lines = [cols.map((c) => csvCell(c[0])).join(',')];
  for (const r of results) lines.push(cols.map((c) => csvCell(c[1](r))).join(','));
  fs.writeFileSync(p, '\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8');
}
// 同窗口榜 CSV：一行一只窗口入选个股；窗口级指标 + 三阈值列组（前缀 30%_ / 40%_ / 50%_）
function csvColumnsWindow(W) {
  const g = (f) => (r) => { try { return f(r, r.windows[W.key]); } catch (e) { return null; } };
  const cols = [
    ['代码', (r) => r.code], ['名称', (r) => r.name], ['市场', (r) => (r.market === 1 ? '沪' : '深')], ['板块', (r) => r.board], ['secid', (r) => r.secid], ['行业', (r) => r.industry],
    ['总市值(亿)', (r) => (r.mcap != null ? rd(r.mcap / 1e8, 2) : null)], ['上市日(f26)', (r) => r.listDateF26], ['首根K线(全史)', (r) => r.listDate],
    ['窗口起点(约定)', () => W.start], ['窗口首根K线', g((r, w) => w.window.start)], ['窗口末根K线', g((r, w) => w.window.end)], ['窗口K线数', g((r, w) => w.nBars)], ['窗口年数', g((r, w) => w.years)],
    ['累计收益', g((r, w) => w.total)], ['年化', g((r, w) => w.cagr)], ['年化波动', g((r, w) => w.vol)], ['Calmar', g((r, w) => w.calmar)],
    ['最大回撤', g((r, w) => w.maxDD)], ['回撤峰日', g((r, w) => w.ddPeak)], ['回撤谷日', g((r, w) => w.ddTrough)], ['峰谷天数', g((r, w) => w.ddDownDays)], ['修复天数', g((r, w) => w.ddRecDays)], ['已修复', g((r, w) => w.ddRecovered)], ['谷后未修复天数', g((r, w) => w.ddSinceTroughDays)],
    ['最长水下天数', g((r, w) => w.longestUnderwaterDays)], ['当前回撤', g((r, w) => w.curDD)], ['前高日', g((r, w) => w.curPeakDate)],
    ['滚动5年P10', g((r, w) => w.roll5y.p10)], ['滚动5年中位', g((r, w) => w.roll5y.median)], ['滚动5年胜率', g((r, w) => w.roll5y.winRate)], ['滚动5年样本', g((r, w) => w.roll5y.n)],
    ['同期上证年化', g((r, w) => w.bench.szCagr)], ['上证超额', g((r, w) => w.bench.excessCagr)], ['同期沪深300年化', g((r, w) => w.bench.hs300Cagr)], ['沪深300超额', g((r, w) => w.bench.excessHs300)],
    ['Pareto前沿(窗口内)', g((r, w) => w.pareto)],
    ...CONFIG.THRESHOLDS.map((T) => ['全史综合排名' + Math.round(T * 100) + '%', g((r) => r.th[String(T)].rank)]),
  ];
  for (const Tn of CONFIG.THRESHOLDS) {
    const T = String(Tn), pre = Math.round(Tn * 100) + '%_';
    const th = (f) => g((r, w) => f(w.th[T]));
    cols.push(
      [pre + '划分依据', th((x) => x.basis)],
      [pre + '牛轮数', th((x) => x.nBull)], [pre + '熊轮数', th((x) => x.nBear)], [pre + '完成牛轮数', th((x) => x.nCompletedBull)], [pre + '完成熊轮数', th((x) => x.nCompletedBear)],
      [pre + '合格熊轮数', th((x) => x.nBearQualifying)], [pre + '熊市均跌口径', th((x) => x.avgBearSrc)], [pre + '熊市可比对数', th((x) => x.nBearPairs)],
      [pre + '当前阶段', th((x) => (x.curPhase.bull ? '牛' : '熊'))], [pre + '当前阶段起点', th((x) => x.curPhase.start)], [pre + '当前阶段天数', th((x) => x.curPhase.days)], [pre + '当前阶段涨跌', th((x) => x.curPhase.ret)], [pre + '距阶段极值', th((x) => x.curPhase.fromExt)],
      [pre + '牛市均涨', th((x) => x.avgBullRet)], [pre + '牛市均历时', th((x) => x.avgBullDays)], [pre + '熊市均跌', th((x) => x.avgBearRet)], [pre + '最深熊市', th((x) => x.deepestBearRet)], [pre + '熊市均历时', th((x) => x.avgBearDays)],
      [pre + '牛市时间占比', th((x) => x.bullTimeShare)], [pre + '牛熊非对称比', th((x) => x.asymmetry)], [pre + '牛市新高率', th((x) => x.bullNewHighRate)], [pre + '底部抬高率', th((x) => x.bearHigherLowRate)],
      [pre + '综合分', th((x) => x.composite)], [pre + '综合排名', th((x) => x.rank)], [pre + '综合指标数', th((x) => x.compositeN)],
      [pre + '稳健分', th((x) => x.steady)], [pre + '稳健排名', th((x) => x.steadyRank)], [pre + '进攻分', th((x) => x.attack)], [pre + '进攻排名', th((x) => x.attackRank)], [pre + '穿越分', th((x) => x.cross)], [pre + '穿越排名', th((x) => x.crossRank)],
      [pre + 'pct_年化', th((x) => x.pct.cagr)], [pre + 'pct_Calmar', th((x) => x.pct.calmar)], [pre + 'pct_最大回撤', th((x) => x.pct.maxDD)], [pre + 'pct_熊市均跌', th((x) => x.pct.avgBearRet)], [pre + 'pct_牛市新高率', th((x) => x.pct.bullNewHighRate)], [pre + 'pct_滚动5年P10', th((x) => x.pct.roll5yP10)],
      [pre + 'pct_牛市均涨', th((x) => x.pct.avgBullRet)], [pre + 'pct_底部抬高率', th((x) => x.pct.bearHigherLowRate)],
      [pre + '看板', th((x) => x.link)],
    );
  }
  cols.push(['数据源', () => (isTx() ? '腾讯hfq' : '东财fqt2')]);
  return cols;
}
function writeWindowCSV(p, rows, W) {
  const cols = csvColumnsWindow(W);
  const lines = [cols.map((c) => csvCell(c[0])).join(',')];
  for (const r of rows) lines.push(cols.map((c) => csvCell(c[1](r))).join(','));
  fs.writeFileSync(p, '\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8');
}

// ------------------------------------------------------------------ compute stage
// 统一数据终点：读缓存后丢弃 t > DATA_END 的 K 线；返回 { bars, truncated }（truncated = 丢弃根数）
const DATA_END_T = () => (CONFIG.DATA_END ? E.parseYMD(CONFIG.DATA_END) : Infinity);
function loadCacheTrunc(secid) {
  const d = loadCache(secid);
  if (!d) return null;
  const endT = DATA_END_T();
  let n = d.bars.length;
  while (n > 0 && d.bars[n - 1][0] > endT) n--;
  return Object.assign({}, d, { bars: n === d.bars.length ? d.bars : d.bars.slice(0, n), truncated: d.bars.length - n });
}
function computeStage(universe, targets, meta, todayT) {
  const benches = {};
  const benchRows = [];
  let truncStats = { files: 0, bars: 0 };
  for (const b of CONFIG.BENCHMARKS) {
    const d = loadCacheTrunc(b.secid);
    if (!d || d.bars.length < 2) throw new Error('benchmark cache missing: ' + b.secid + ' (run without --compute-only first)');
    if (d.truncated) { truncStats.files++; truncStats.bars += d.truncated; }
    benches[b.key] = d.bars.map((x) => ({ t: x[0], c: x[1] }));
  }
  for (const b of CONFIG.BENCHMARKS) {
    const d = loadCacheTrunc(b.secid);
    benchRows.push(Object.assign({ code: b.secid.slice(2), name: b.name, market: +b.secid[0], secid: b.secid, key: b.key, klineName: d.name, source: CONFIG.SOURCE, truncatedBars: d.truncated }, computeStock(d.bars, b.secid, benches), { windows: computeWindows(d.bars, b.secid, benches) }));
  }
  const szLastT = benches.sz[benches.sz.length - 1].t;
  const dataEndDate = E.fmtDate(szLastT);
  if (CONFIG.DATA_END && dataEndDate !== CONFIG.DATA_END) log('WARN: 上证末根 ' + dataEndDate + ' != DATA_END ' + CONFIG.DATA_END + '（指数缓存缺 DATA_END 当日 K 线？）');
  log('benchmarks ok, data end date ' + dataEndDate + ' (DATA_END=' + CONFIG.DATA_END + ')');
  let failures = [];
  try { failures = readJSON(P_FAILURES()); } catch (e) { /* none */ }
  if (!meta.fetch) { try { const prev = readJSON(P_FETCH_META()); if (prev && prev.fetch) meta.fetch = Object.assign({ fromRun: prev.startedAt }, prev.fetch); } catch (e) { /* none */ } } // --compute-only 沿用同数据源上次拉数汇总
  const failed = new Set(failures.map((f) => f.secid));
  const results = [];
  const checks = { phaseAlternationViolations: 0, retSignViolations: 0, nBearMonotoneViolations: 0, computed: 0, errors: [] };
  let i = 0;
  for (const u of targets) {
    i++;
    const row = { code: u.code, name: u.name, market: u.market, board: boardOf(u), secid: u.secid, industry: u.industry, mcap: u.mcap, listDateF26: u.listDate, excluded_reason: preExclusion(u, todayT), eligible: false, stale: false };
    if (!row.excluded_reason) {
      const d = loadCacheTrunc(u.secid);
      if (!d) row.excluded_reason = failed.has(u.secid) ? 'fetch_failed' : 'not_cached';
      else if (d.bars.length < 2) row.excluded_reason = 'too_few_bars';
      else {
        row.klineName = d.name;
        if (d.truncated) { truncStats.files++; truncStats.bars += d.truncated; row.truncatedBars = d.truncated; }
        try {
          Object.assign(row, computeStock(d.bars, u.secid, benches));
          checks.computed++;
          const lastT = d.bars[d.bars.length - 1][0];
          row.stale = szLastT - lastT > CONFIG.STALE_DAYS;
          if (row.years < CONFIG.MIN_YEARS) row.excluded_reason = 'listed<' + CONFIG.MIN_YEARS + 'y (kline)';
          else if (row.stale) row.excluded_reason = 'stale';
          // 同窗口视图（只对入选个股算；窗口入选 = 首根 K 线 ≤ 窗口起点）
          if (!row.excluded_reason) row.windows = computeWindows(d.bars, u.secid, benches);
          // 一致性自检（全史 + 各非空窗口；熊市轮数随阈值非降只在全史上检查）
          const views = [row.th]; if (row.windows) for (const W of CONFIG.WINDOWS) if (row.windows[W.key]) views.push(row.windows[W.key].th);
          for (let vi = 0; vi < views.length; vi++) {
            let prevBear = Infinity;
            for (const T of CONFIG.THRESHOLDS) {
              const th = views[vi][String(T)];
              for (let k = 0; k < th.phases.length; k++) {
                const p = th.phases[k];
                if (k > 0 && th.phases[k - 1].bull === p.bull) checks.phaseAlternationViolations++;
                if ((p.bull && p.ret < 0) || (!p.bull && p.ret >= 0)) checks.retSignViolations++;
              }
              if (vi === 0) { if (th.nBear > prevBear) checks.nBearMonotoneViolations++; prevBear = th.nBear; }
            }
          }
        } catch (e) { row.excluded_reason = 'compute_error'; checks.errors.push({ secid: u.secid, error: e.message }); }
      }
    }
    row.eligible = !row.excluded_reason;
    if (!row.eligible && row.windows) delete row.windows; // 非入选行不带 windows
    u.excluded_reason = row.excluded_reason;
    results.push(row);
    if (i % 500 === 0) log('compute ' + i + '/' + targets.length);
  }
  const elig = results.filter((r) => r.eligible);
  v2Checks(elig, checks);
  const rk = rankStage(results);
  const nElig = rk.eligible;
  log('computed=' + checks.computed + ' eligible=' + nElig + ' windows=' + JSON.stringify(rk.windows) + ' checks=' + JSON.stringify(checks));
  // outputs：results / benchmarks 为工作文件（screen/out，不入库）；universe / CSV / run_meta 入库（screen/）
  writeRows(P_OUT('results.json'), results);
  writeJSON(P_OUT('benchmarks.json'), benchRows, true);
  writeJSON(P_UNIVERSE(), universe, true);
  for (const T of CONFIG.THRESHOLDS) writeCSV(P_PUB('metrics_th' + Math.round(T * 100) + '.csv'), results, String(T));
  for (const W of CONFIG.WINDOWS) writeWindowCSV(P_PUB('metrics_w' + W.key + '.csv'), elig.filter((r) => r.windows && r.windows[W.key]), W);
  const exclusionCounts = {};
  for (const r of results) if (r.excluded_reason) exclusionCounts[r.excluded_reason] = (exclusionCounts[r.excluded_reason] || 0) + 1;
  // 按板块统计：股票池行数 / 入选 / 各窗口入选
  const boardCounts = {};
  for (const r of results) {
    const b = boardCounts[r.board] || (boardCounts[r.board] = { universe: 0, eligible: 0 });
    for (const W of CONFIG.WINDOWS) if (b['w' + W.key] == null) b['w' + W.key] = 0;
    b.universe++;
    if (r.eligible) { b.eligible++; for (const W of CONFIG.WINDOWS) if (r.windows && r.windows[W.key]) b['w' + W.key]++; }
  }
  let universeFetch = null;
  try { universeFetch = readJSON(P_OUT('universe_fetch.json')); } catch (e) { /* none */ }
  // 股票池行来源（按板块计数）：f26From = 'clist YYYY-MM-DD'（该行 clist 数据的拉取日）；'interim:…' = 临时行（无上市日 / 行业 / 市值，仅代码与名称）
  const universeProvenance = {};
  for (const u of universe) {
    const k = u.interim && u.listDate == null ? 'interim:' + u.interim : (u.f26From || 'clist');
    const p = universeProvenance[k] || (universeProvenance[k] = {});
    p[boardOf(u)] = (p[boardOf(u)] || 0) + 1;
  }
  const sanityRow = (code) => {
    const r = results.find((x) => x.code === code);
    if (!r) return { code, found: false };
    const o = { code, name: r.name, board: r.board, listDate: r.listDate, found: true, eligible: r.eligible, excluded_reason: r.excluded_reason, cagr: r.cagr, maxDD: r.maxDD, ranks: {}, winRanks: {} };
    for (const T of CONFIG.THRESHOLDS) o.ranks[String(T)] = r.th && r.th[String(T)] ? r.th[String(T)].rank : null;
    for (const W of CONFIG.WINDOWS) { o.winRanks[W.key] = {}; for (const T of CONFIG.THRESHOLDS) o.winRanks[W.key][String(T)] = r.windows && r.windows[W.key] ? r.windows[W.key].th[String(T)].rank : null; }
    return o;
  };
  Object.assign(meta, {
    version: CONFIG.VERSION,
    source: CONFIG.SOURCE, klineDir: CONFIG.KLINE_DIR, dataEnd: CONFIG.DATA_END, truncation: truncStats,
    finishedAt: nowIso(), dataEndDate, universeCount: universe.length, targetCount: targets.length, computedCount: checks.computed,
    eligibleCount: nElig, exclusionCounts, boardCounts, universeFetch, universeProvenance, fetchFailures: failures.length, failedSecids: failures.map((f) => f.secid), checks,
    windows: CONFIG.WINDOWS.map((W) => ({ key: W.key, label: W.label, start: W.start, end: CONFIG.DATA_END, eligible: rk.windows[W.key] })),
    config: { THRESHOLDS: CONFIG.THRESHOLDS, MIN_YEARS: CONFIG.MIN_YEARS, STALE_DAYS: CONFIG.STALE_DAYS, DATA_END: CONFIG.DATA_END, FQT: CONFIG.FQT, SOURCE: CONFIG.SOURCE, COMPOSITE_WEIGHTS: CONFIG.COMPOSITE_WEIGHTS, BOARDS: CONFIG.BOARDS, ROLL_MONTHS: CONFIG.ROLL_MONTHS, VERSION: CONFIG.VERSION, WINDOWS: CONFIG.WINDOWS, MIN_CYCLES_FOR_RATE: CONFIG.MIN_CYCLES_FOR_RATE, FIRST_BEAR_DEPTH: CONFIG.FIRST_BEAR_DEPTH, UNIVERSE_SEGMENTS: CONFIG.UNIVERSE_SEGMENTS },
    sanity: CONFIG.SANITY_CODES.map(sanityRow),
  });
  writeJSON(P_PUB('run_meta.json'), meta, true);
  log('wrote screen/out/results.json, screen/out/benchmarks.json, screen/universe.json, screen/metrics_th*.csv, screen/metrics_w10y.csv, screen/metrics_w5y.csv, screen/run_meta.json');
}
// v2 自检（只对入选行；入选只在循环结束后才最终确定）：
//   avgBearZeroOrNull：任一视图 × 阈值 avgBearRet 为 null / 0 的个数（必须为 0）
//   bearFallback：avgBearSrc === 'maxDD'（无合格熊市、回退为最大回撤）的个数，按视图 × 阈值
//   rateNullSmallSample：全史视图 牛市新高率 / 底部抬高率 为空的个数，按阈值
function v2Checks(elig, checks) {
  const zeroKey = {}; for (const T of CONFIG.THRESHOLDS) zeroKey[String(T)] = 0;
  const copy = () => Object.assign({}, zeroKey);
  checks.avgBearZeroOrNull = 0;
  checks.bearFallback = { all: copy() }; for (const W of CONFIG.WINDOWS) checks.bearFallback[W.key] = copy();
  checks.rateNullSmallSample = { bullNewHigh: copy(), bearHigherLow: copy() };
  for (const r of elig) {
    const views = [['all', r]]; for (const W of CONFIG.WINDOWS) if (r.windows && r.windows[W.key]) views.push([W.key, r.windows[W.key]]);
    for (const [key, v] of views) for (const Tn of CONFIG.THRESHOLDS) {
      const T = String(Tn), th = v.th[T];
      if (th.avgBearRet == null || th.avgBearRet === 0) checks.avgBearZeroOrNull++;
      if (th.avgBearSrc === 'maxDD') checks.bearFallback[key][T]++;
      if (key === 'all') { if (th.bullNewHighRate == null) checks.rateNullSmallSample.bullNewHigh[T]++; if (th.bearHigherLowRate == null) checks.rateNullSmallSample.bearHigherLow[T]++; }
    }
  }
}

// ------------------------------------------------------------------ main
const isYMD = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && E.fmtDate(E.parseYMD(s)) === s;
function parseArgs(argv) {
  const a = { sample: null, codes: null, fetchOnly: false, computeOnly: false, universeOnly: false, refreshUniverse: false, source: CONFIG.SOURCE, dataEnd: CONFIG.DATA_END };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (s === '--sample') a.sample = parseInt(argv[++i], 10);
    else if (s === '--codes') a.codes = String(argv[++i]).split(',').map((x) => x.trim()).filter(Boolean);
    else if (s === '--fetch-only') a.fetchOnly = true;
    else if (s === '--compute-only') a.computeOnly = true;
    else if (s === '--universe-only') a.universeOnly = true; // 只处理股票池（拉取 / 补临时行 / 预剔除）并写 screen/universe.json，不拉 K 线、不计算
    else if (s === '--refresh-universe') a.refreshUniverse = true;
    else if (s === '--source') { a.source = String(argv[++i] || '').toLowerCase(); if (a.source !== 'eastmoney' && a.source !== 'tencent') throw new Error('--source must be eastmoney or tencent'); }
    else if (s === '--data-end') { a.dataEnd = String(argv[++i] || '').toLowerCase(); if (a.dataEnd !== 'auto' && !isYMD(a.dataEnd)) throw new Error('--data-end must be auto or YYYY-MM-DD (got "' + a.dataEnd + '")'); }
    else throw new Error('unknown argument: ' + s);
  }
  return a;
}
// 解析统一数据终点：'YYYY-MM-DD' 原样使用（mode fixed）；'auto' = 缓存上证序列（不截断）末根日期；若上海时间日期 == 末根日期且时刻 < 15:05，末根仍为盘中半截 bar → 取前一根（mode auto-prev）
function resolveDataEnd(spec) {
  if (spec !== 'auto') return { date: spec, mode: 'fixed' };
  const sz = CONFIG.BENCHMARKS[0];
  const d = loadCache(sz.secid);
  if (!d || d.bars.length < 2) throw new Error('--data-end auto needs cached ' + sz.name + ' (' + cachePath(sz.secid) + '): run --fetch-only first or pass --data-end YYYY-MM-DD');
  const last = E.fmtDate(d.bars[d.bars.length - 1][0]), prev = E.fmtDate(d.bars[d.bars.length - 2][0]);
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date())) parts[p.type] = p.value;
  const shDate = parts.year + '-' + parts.month + '-' + parts.day, shHM = (parts.hour === '24' ? '00' : parts.hour) + ':' + parts.minute;
  if (shDate === last && shHM < '15:05') return { date: prev, mode: 'auto-prev', last, shanghaiNow: shDate + ' ' + shHM };
  return { date: last, mode: 'auto', shanghaiNow: shDate + ' ' + shHM };
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  CONFIG.SOURCE = args.source;
  CONFIG.KLINE_DIR = isTx() ? CONFIG.KLINE_DIR_TX : CONFIG.KLINE_DIR_EM;
  SUBSET_RUN = !!(args.codes || args.sample != null);
  if (args.dataEnd !== 'auto') CONFIG.TX.END_DATE = args.dataEnd; // 腾讯线固定区间终点与 --data-end 对齐
  ensureDirs();
  const meta = { startedAt: nowIso(), args, source: CONFIG.SOURCE, klineDir: CONFIG.KLINE_DIR, mode: args.computeOnly ? 'compute-only' : args.universeOnly ? 'universe-only' : args.fetchOnly ? 'fetch-only' : 'full', dataEndSpec: args.dataEnd, node: process.version, pid: process.pid };
  const todayT = Math.floor(Date.now() / DAY);
  log('start ' + JSON.stringify(meta));
  // 1. 股票池
  const uPath = P_UNIVERSE();
  let universe;
  if (args.computeOnly || (fs.existsSync(uPath) && !args.refreshUniverse)) {
    if (!fs.existsSync(uPath)) throw new Error('--compute-only requires existing ' + uPath);
    universe = readJSON(uPath);
    log('universe loaded from ' + uPath + ': ' + universe.length + ' rows');
  } else {
    universe = await fetchUniverse(meta);
  }
  for (const u of universe) { u.excluded_reason = preExclusion(u, todayT); if (!u.board) u.board = inferBoard(u.code); }
  // 临时股票池（interim 行无 f26）：拉数前先试一次补 f26（startup 最多 2 次冷却 ≈ 3 分钟；clist 仍 502 则按临时池继续）；解封后由 fetchStage 的 onRecover 再试一次；
  // --universe-only 专门补股票池，允许最多 ENRICH_COOLDOWNS.universeOnly 次冷却
  const preEnrich = {}; for (const u of universe) if (u.excluded_reason) preEnrich[u.excluded_reason] = (preEnrich[u.excluded_reason] || 0) + 1;
  log('pre-exclusions (before enrich) ' + JSON.stringify(preEnrich) + ' interim rows without listDate: ' + universe.filter((u) => u.interim && u.listDate == null).length);
  if (!args.computeOnly && !args.codes) { const r = await enrichF26(universe, todayT, args.universeOnly ? CONFIG.ENRICH_COOLDOWNS.universeOnly : CONFIG.ENRICH_COOLDOWNS.startup, args.universeOnly ? 'universe-only' : 'startup'); if (r) meta.enrichStartup = r; }
  writeJSON(uPath, universe, true);
  const pre = {}; for (const u of universe) if (u.excluded_reason) pre[u.excluded_reason] = (pre[u.excluded_reason] || 0) + 1;
  log('pre-exclusions ' + JSON.stringify(pre));
  if (args.universeOnly) {
    const byBoard = {}; for (const u of universe) byBoard[u.board] = (byBoard[u.board] || 0) + 1;
    meta.finishedAt = nowIso(); meta.universeRows = universe.length; meta.universeByBoard = byBoard; meta.interimLeft = universe.filter((u) => u.interim && u.listDate == null).length;
    writeJSON(P_OUT('run_meta_universe.json'), meta, true);
    log('universe-only done: ' + universe.length + ' rows ' + JSON.stringify(byBoard) + ' interimLeft=' + meta.interimLeft + ' -> ' + uPath);
    return;
  }
  const onRecover = async () => { const r = await enrichF26(universe, todayT, CONFIG.ENRICH_COOLDOWNS.recover, 'recover'); if (r) meta.enrichRecover = r; return r; };
  // 目标集合
  let targets = universe;
  const byCode = new Map(universe.map((u) => [u.code, u]));
  if (args.codes) {
    targets = args.codes.map((code) => byCode.get(code) || { code, name: '', market: inferMarket(code), secid: inferMarket(code) + '.' + code, board: inferBoard(code), listDate: null, industry: '', mcap: null, excluded_reason: null, synthetic: true });
  } else if (args.sample != null) {
    const set = new Map();
    for (const u of universe.slice(0, args.sample)) set.set(u.secid, u);
    for (const code of CONFIG.SANITY_CODES) { const u = byCode.get(code); if (u) set.set(u.secid, u); else log('sanity code not in universe: ' + code); }
    targets = Array.from(set.values());
  }
  log('targets=' + targets.length);
  // 2. 拉数
  if (!args.computeOnly) await fetchStage(targets, meta, { onRecover: args.codes ? null : onRecover });
  if (args.fetchOnly) { meta.finishedAt = nowIso(); writeJSON(P_FETCH_META(), meta, true); log('fetch-only done'); return; }
  // 统一数据终点（拉数之后解析：auto 依赖缓存的上证序列）
  const de = resolveDataEnd(args.dataEnd);
  CONFIG.DATA_END = de.date;
  meta.dataEndSpec = args.dataEnd; meta.dataEnd = de.date; meta.dataEndMode = de.mode;
  log('DATA_END ' + de.date + ' (spec=' + args.dataEnd + ' mode=' + de.mode + (de.shanghaiNow ? ' shanghaiNow=' + de.shanghaiNow : '') + ')');
  // 3-6. 计算 / 排名 / 输出
  computeStage(universe, targets, meta, todayT);
  log('done');
}
main().catch((e) => { log('FATAL ' + (e && e.stack || e)); process.exit(1); });
