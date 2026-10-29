#!/usr/bin/env node
/* 分红明细 + 不复权月线拉取（v3.1 股息 / 股息率指标的数据源）—— 两趟独立队列，零依赖，可断点续跑，永不因失败退出
 * 用法（仓库根目录）：
 *   node tools/fetch_dividends.js --pass dividends [--codes 600519,600900] [--limit N] [--data-end 2026-10-15]
 *   node tools/fetch_dividends.js --pass prices    [--codes …] [--limit N] [--data-end 2026-10-15]
 *   脱离 shell 长跑：node tools/fetch_watchdog.js --job dividends | --job prices（崩溃自动重启，done 标记出现即退出）
 * 股票池：screen/universe.json 中 excluded_reason == null 的行（期望 4,116；不在 [4,000, 4,300] 内即中止）。
 * 队列顺序：PRIORITY（screen_all.js 的 20 只 SANITY_CODES + 601398,601288,601088,000001,600036,601318,600028,601857）→ 其余按代码升序。
 * --codes / --limit = 子集运行（不写 done 标记）。已存在且可解析的缓存直接跳过（cached）。
 *
 * pass dividends：东财数据中心 RPT_SHAREBONUS_DET（datacenter-web.eastmoney.com；与 push2* 行情主机无关，不影响 K 线拉数）
 *   每只 1 页（pageSize=200；result.pages > 1 时续页拼接）；从未分红的个股接口返回 success=false code=9201 "返回数据为空"（实测 688981）或 result === null，
 *   均为合法空表（rows [] count 0，缓存带 empty 字段），不触发退避。
 *   缓存 screen/out/dividends/<secid>.json = { secid, code, name, source:'em-datacenter', fetchedAt, count, pages, rows:<原始行、全部列> }
 *   间隔 1.5s；每拉 200 只（不含缓存命中）暂停 60s；任何非 200 / 非 JSON / success!==true：指数退避 60s→120s→…→600s 后重试同一只；
 *   同一只连续 12 次失败后回退新浪 vISSUE_ShareBonus（GBK 表格 #sharebonus_1，映射为数据中心列名，source:'sina'）；仍失败 → 记 kind:'throttle' 继续下一只。
 * pass prices：腾讯 web.ifzq.gtimg.cn kline/kline（不复权；fqkline 不带 fq 后缀是参数错误，不用）
 *   每只 2 个请求：<sym>,month,,,640（全史月线，保留全部行，截断在 compute 阶段）+ <sym>,day,<DATA_END 上月 1 日>,<DATA_END>,640（取 DATA_END 当日不复权收盘）。
 *   缓存 screen/out/raw_monthly/<secid>.json = { secid, sym, name, source:'tencent-kline', fetchedAt, dataEnd, month:[[date, close]…], day:[[date, close]…] }
 *   间隔 0.4s，单并发；退避同 screen_all.js CONFIG.TX（60s→600s，同一请求连续 12 次失败后记失败继续）；无数据对象 / 月线为空 → kind:'invalid'（不退避）；day 为空合法（整段停牌）。
 * 日志：screen/out/fetch_<pass>.log（每只一行：序号 secid 名称 行数 状态 req=请求数 [retries=退避重试数]；每 100 只一行进度；结束一行汇总）；
 *   失败 screen/out/fetch_failures_<pass>.json = [{secid, code, name, error, kind, at}]；
 *   done 标记 screen/out/fetch_done_<pass>.json 只在全量队列完成、failedThrottle === 0 且非子集运行时写入（与 fetch_done_eastmoney.json 同约定）。
 */
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUB_DIR = path.join(ROOT, 'screen');
const OUT_DIR = path.join(ROOT, 'screen', 'out');
const CONFIG = {
  DATA_END: '2026-10-15',               // --data-end 可覆盖；只影响 prices 的 day 区间与缓存里的 dataEnd 字段
  UNIVERSE_MIN: 4000, UNIVERSE_MAX: 4300, // 入选只数合理区间（期望 4,116）
  PRIORITY: ['600519', '600900', '000333', '600887', '600276', '600436', '000538', '000651', '600036', '600309', // screen_all.js SANITY_CODES
    '300015', '300760', '300750', '300059', '300124', '688012', '688111', '688981', '688008', '688036',
    '601398', '601288', '601088', '000001', '600036', '601318', '600028', '601857'],                            // 对账 / 高股息样本
  DIV: {
    DIR: path.join(OUT_DIR, 'dividends'),
    URL: (code, page) => 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=ALL&filter=(SECURITY_CODE%3D%22' + code + '%22)&pageSize=200&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1&pageNumber=' + page,
    HEADERS: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://data.eastmoney.com/' },
    SLEEP_MS: 1500,                     // 请求间隔（含续页）
    BATCH_PAUSE_EVERY: 200, BATCH_PAUSE_MS: 60000,
    BACKOFF_BASE_MS: 60000, BACKOFF_MAX_MS: 600000, MAX_CONSEC: 12,
    MAX_PAGES: 20,
    SINA_URL: (code) => 'https://vip.stock.finance.sina.com.cn/corp/go.php/vISSUE_ShareBonus/stockid/' + code + '.phtml',
    SINA_HEADERS: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://vip.stock.finance.sina.com.cn/' },
  },
  PX: {
    DIR: path.join(OUT_DIR, 'raw_monthly'),
    URL: (sym, period, start, end) => 'https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=' + sym + ',' + period + ',' + start + ',' + end + ',640',
    HEADERS: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' },
    SLEEP_MS: 400,
    BACKOFF_BASE_MS: 60000, BACKOFF_MAX_MS: 600000, MAX_CONSEC: 12,
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const inferMarket = (code) => (/^[569]/.test(code) ? 1 : 0);
const cleanName = (s) => String(s == null ? '' : s).replace(/\s+/g, '');
const isYMD = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
// DATA_END 上一个月的 1 日（2026-10-15 → 2026-09-01）：day 区间起点，保证含 DATA_END 前最近一个交易日
function monthStartBefore(ymd) { const y = +ymd.slice(0, 4), m = +ymd.slice(5, 7); const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1; return py + '-' + String(pm).padStart(2, '0') + '-01'; }

// ------------------------------------------------------------------ io
let PASS = 'dividends', SUBSET_RUN = false, DATA_END = CONFIG.DATA_END;
const P_OUT = (name) => path.join(OUT_DIR, name);
const P_FETCH_LOG = () => P_OUT('fetch_' + PASS + '.log');
const P_FAILURES = () => P_OUT('fetch_failures_' + PASS + '.json');
const P_DONE = () => P_OUT('fetch_done_' + PASS + '.json');
const cacheDir = () => (PASS === 'dividends' ? CONFIG.DIV.DIR : CONFIG.PX.DIR);
const cachePath = (secid) => path.join(cacheDir(), secid + '.json');
function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); }
function writeJSON(p, obj, pretty) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, pretty ? JSON.stringify(obj, null, 1) : JSON.stringify(obj), 'utf8');
  fs.renameSync(tmp, p);
}
function flog(s) { try { fs.appendFileSync(P_FETCH_LOG(), s + '\n', 'utf8'); } catch (e) { /* ignore */ } }
function log(s) { const line = nowIso() + ' ' + s; flog(line); process.stdout.write(line + '\n'); } // 进度 / 退避 / 汇总：同时进日志与 stdout（看门狗把 stdout 追加到 fetch_full_<job>.log）
// 已有缓存可解析即视为完成（dividends 需有 rows 数组，prices 需有 month 数组）
function loadCache(secid) {
  const p = cachePath(secid);
  if (!fs.existsSync(p)) return null;
  try { const j = readJSON(p); if (PASS === 'dividends' ? Array.isArray(j.rows) : Array.isArray(j.month)) return j; } catch (e) { /* 损坏的缓存：重拉 */ }
  return null;
}
const cacheRows = (d) => (PASS === 'dividends' ? d.rows.length : d.month.length + '+' + (d.day ? d.day.length : 0));

// ------------------------------------------------------------------ http
const AGENT = new https.Agent({ keepAlive: false }); // 每次新建连接（同 screen_all.js：复用被服务端关掉的空闲连接会报 socket hang up）
function rawGet(url, headers, binary) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 30000, agent: AGENT }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); resolve({ status: res.statusCode, body: binary ? buf : buf.toString('utf8') }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
const tagErr = (msg, kind) => { const ex = new Error(msg); ex.kind = kind; return ex; };
let consecFail = 0, totalReq = 0, totalFail = 0, totalBackoffMs = 0;
// 带退避的 JSON GET：parse(j) 返回结果或抛 tagErr；kind 'invalid'（合法 JSON 但无数据）直接抛出不退避；
// 其余（非 200 / 空 / 非 JSON / 业务码异常 / 连接错误）为限流类：指数退避 60s→120s→…→600s 后重试同一请求，连续 P.MAX_CONSEC 次后放弃该请求
async function getWithBackoff(url, headers, parse, P, what) {
  for (let k = 1; ; k++) {
    try {
      totalReq++;
      const r = await rawGet(url, headers);
      if (r.status !== 200) throw tagErr('HTTP ' + r.status, 'throttle');
      if (!r.body) throw tagErr('empty response', 'throttle');
      let j;
      try { j = JSON.parse(r.body); } catch (e) { throw tagErr('non-JSON: ' + r.body.slice(0, 80).replace(/\s+/g, ' '), 'throttle'); }
      const out = parse(j);
      consecFail = 0;
      return out;
    } catch (e) {
      if (e.kind === 'invalid') throw e;
      consecFail++; totalFail++;
      if (k >= P.MAX_CONSEC) throw tagErr((e.message || String(e)) + ' (gave up after ' + k + ' tries)', 'throttle');
      const wait = Math.min(P.BACKOFF_MAX_MS, P.BACKOFF_BASE_MS * Math.pow(2, Math.min(consecFail - 1, 10)));
      totalBackoffMs += wait;
      log('backoff ' + Math.round(wait / 1000) + 's (consecutive failure #' + consecFail + ', try ' + k + '/' + P.MAX_CONSEC + ': ' + (e.code || e.message) + ') ' + what);
      await sleep(wait);
    }
  }
}

// ------------------------------------------------------------------ pass dividends（东财数据中心 → 新浪回退）
async function fetchDividendsEM(code) {
  const parsePage = (j) => {
    // 从未分红 / 无记录：数据中心实测返回 success=false code=9201 message="返回数据为空"（688981 中芯国际，2026-10-29），不是限流 → 合法空表
    if (j.success === false && (j.code === 9201 || /返回数据为空/.test(String(j.message || '')))) return { rows: [], pages: 0, count: 0, empty: 'code ' + j.code + ' ' + (j.message || '') };
    if (j.success !== true || j.code !== 0) throw tagErr('success=' + j.success + ' code=' + j.code + ' ' + (j.message || ''), 'throttle');
    if (j.result == null) return { rows: [], pages: 0, count: 0, empty: 'result null' }; // 合法空表（另一种无记录形态）
    if (!Array.isArray(j.result.data)) throw tagErr('result.data is not an array', 'throttle');
    return { rows: j.result.data, pages: j.result.pages || 1, count: j.result.count };
  };
  const first = await getWithBackoff(CONFIG.DIV.URL(code, 1), CONFIG.DIV.HEADERS, parsePage, CONFIG.DIV, code + ' p1');
  let rows = first.rows;
  for (let p = 2; p <= first.pages && p <= CONFIG.DIV.MAX_PAGES; p++) {
    await sleep(CONFIG.DIV.SLEEP_MS);
    const nx = await getWithBackoff(CONFIG.DIV.URL(code, p), CONFIG.DIV.HEADERS, parsePage, CONFIG.DIV, code + ' p' + p);
    rows = rows.concat(nx.rows);
  }
  return { rows, pages: first.pages, reported: first.count, empty: first.empty };
}
// 新浪分红表（GBK）：#sharebonus_1 列 = 公告日期 / 送股(股) / 转增(股) / 派息(税前)(元) / 进度 / 除权除息日 / 股权登记日 / 红股上市日（均为每 10 股口径，与数据中心一致）
async function fetchDividendsSina(code, name) {
  const r = await rawGet(CONFIG.DIV.SINA_URL(code), CONFIG.DIV.SINA_HEADERS, true);
  if (r.status !== 200) throw tagErr('sina HTTP ' + r.status, 'throttle');
  let html;
  try { html = new TextDecoder('gbk').decode(r.body); } catch (e) { throw tagErr('sina gbk decode: ' + e.message, 'throttle'); }
  const tb = /<table[^>]*id="sharebonus_1"[\s\S]*?<\/table>/i.exec(html);
  if (!tb) throw tagErr('sina table #sharebonus_1 not found', 'throttle');
  const body = (/<tbody[\s\S]*?<\/tbody>/i.exec(tb[0]) || [tb[0]])[0];
  const num = (s) => { const v = parseFloat(String(s).replace(/,/g, '')); return isFinite(v) ? v : null; };
  const date = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + ' 00:00:00' : null);
  const rows = [];
  const trRe = /<tr[\s\S]*?<\/tr>/gi; let tr;
  while ((tr = trRe.exec(body))) {
    const cells = []; const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi; let td;
    while ((td = tdRe.exec(tr[0]))) cells.push(td[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
    if (cells.length < 7) continue;
    const song = num(cells[1]), zhuan = num(cells[2]);
    rows.push({
      SECUCODE: code + (inferMarket(code) === 1 ? '.SH' : '.SZ'), SECURITY_NAME_ABBR: name || null, SECURITY_CODE: code,
      BONUS_IT_RATIO: song == null && zhuan == null ? null : (song || 0) + (zhuan || 0), BONUS_RATIO: song, IT_RATIO: zhuan, PRETAX_BONUS_RMB: num(cells[3]),
      PLAN_NOTICE_DATE: null, EQUITY_RECORD_DATE: date(cells[6]), EX_DIVIDEND_DATE: date(cells[5]), REPORT_DATE: null,
      ASSIGN_PROGRESS: cells[4] || null, IMPL_PLAN_PROFILE: null, NOTICE_DATE: date(cells[0]), BASIC_EPS: null,
    });
  }
  return rows;
}

// ------------------------------------------------------------------ pass prices（腾讯 kline/kline 不复权）
const txSymbol = (row) => (row.market === 1 ? 'sh' : 'sz') + row.code;
async function fetchPricesTX(row) {
  const sym = txSymbol(row);
  const parseK = (key, allowEmpty) => (j) => {
    if (j.code !== 0) throw tagErr('code=' + j.code + ' ' + (j.msg || ''), 'throttle');
    if (!j.data || Array.isArray(j.data) || !j.data[sym]) throw tagErr('no data object (' + (j.msg || 'param error') + ')', 'invalid'); // 参数错误 / 代码不存在：不退避
    const d = j.data[sym];
    const raw = Array.isArray(d[key]) ? d[key] : [];
    if (!raw.length && !allowEmpty) throw tagErr('empty ' + key, 'invalid');
    const rows = [];
    for (const r of raw) { const c = +r[2]; if (c > 0) rows.push([r[0], c]); }
    const name = d.qt && d.qt[sym] && d.qt[sym][1] ? String(d.qt[sym][1]) : '';
    return { rows, dropped: raw.length - rows.length, name };
  };
  const m = await getWithBackoff(CONFIG.PX.URL(sym, 'month', '', ''), CONFIG.PX.HEADERS, parseK('month', false), CONFIG.PX, sym + ' month');
  await sleep(CONFIG.PX.SLEEP_MS);
  const d = await getWithBackoff(CONFIG.PX.URL(sym, 'day', monthStartBefore(DATA_END), DATA_END), CONFIG.PX.HEADERS, parseK('day', true), CONFIG.PX, sym + ' day');
  const out = { secid: row.secid, sym, name: cleanName(row.name || m.name || d.name), source: 'tencent-kline', fetchedAt: nowIso(), dataEnd: DATA_END, month: m.rows, day: d.rows };
  if (m.dropped || d.dropped) out.dropped = m.dropped + d.dropped;
  return out;
}

// ------------------------------------------------------------------ queue
function buildQueue(eligible) {
  const pri = new Map(); CONFIG.PRIORITY.forEach((c, i) => { if (!pri.has(c)) pri.set(c, i); });
  const key = (r) => (pri.has(r.code) ? pri.get(r.code) : CONFIG.PRIORITY.length);
  return eligible.slice().sort((a, b) => key(a) - key(b) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}
async function run(queue) {
  const P = PASS === 'dividends' ? CONFIG.DIV : CONFIG.PX;
  flog('=== fetch start ' + nowIso() + ' pass=' + PASS + ' queue=' + queue.length + (SUBSET_RUN ? ' (subset)' : '') + ' dataEnd=' + DATA_END + ' sleep=' + P.SLEEP_MS + 'ms backoff=' + P.BACKOFF_BASE_MS / 1000 + 's..' + P.BACKOFF_MAX_MS / 1000 + 's maxConsec=' + P.MAX_CONSEC + (PASS === 'dividends' ? ' batchPause=' + P.BATCH_PAUSE_MS / 1000 + 's/' + P.BATCH_PAUSE_EVERY : '') + ' pid=' + process.pid);
  log('fetch queue=' + queue.length + ' pass=' + PASS + (SUBSET_RUN ? ' subset' : ''));
  const failures = [];
  let nOk = 0, nCached = 0, nFail = 0, nSina = 0, nEmpty = 0, consecEmpty = 0;
  async function one(q, i, total, tag) {
    const cached = loadCache(q.secid);
    if (cached) { nCached++; flog(nowIso() + ' ' + i + '/' + total + ' ' + q.secid + ' ' + q.name + ' ' + cacheRows(cached) + ' cached'); return 'cached'; }
    const reqBefore = totalReq, failBefore = totalFail;
    const att = () => ' req=' + (totalReq - reqBefore) + (totalFail > failBefore ? ' retries=' + (totalFail - failBefore) : '');
    try {
      let d;
      if (PASS === 'dividends') {
        try {
          const em = await fetchDividendsEM(q.code);
          d = { secid: q.secid, code: q.code, name: cleanName(q.name || (em.rows[0] && em.rows[0].SECURITY_NAME_ABBR)), source: 'em-datacenter', fetchedAt: nowIso(), count: em.rows.length, pages: em.pages, rows: em.rows };
          if (em.empty) { d.empty = em.empty; nEmpty++; consecEmpty++; if (consecEmpty % 50 === 0) log('WARN ' + consecEmpty + ' consecutive empty dividend tables (last ' + q.secid + ') — verify the datacenter is not answering 9201 for everything'); }
          else consecEmpty = 0;
        } catch (e) {
          if (e.kind === 'invalid') throw e;
          flog(nowIso() + ' ' + i + '/' + total + ' ' + q.secid + ' ' + q.name + ' datacenter gave up (' + e.message + '), trying sina');
          let rows;
          try { rows = await fetchDividendsSina(q.code, q.name); } catch (e2) { throw tagErr(e.message + '; sina: ' + e2.message, 'throttle'); }
          nSina++;
          d = { secid: q.secid, code: q.code, name: cleanName(q.name), source: 'sina', fetchedAt: nowIso(), count: rows.length, pages: 1, rows };
        }
      } else {
        d = await fetchPricesTX(q);
      }
      writeJSON(cachePath(q.secid), d);
      nOk++;
      flog(nowIso() + ' ' + i + '/' + total + ' ' + q.secid + ' ' + (q.name || d.name) + ' ' + cacheRows(d) + ' ok' + (d.empty ? ' empty(' + d.empty + ')' : '') + (d.source === 'sina' ? ' source=sina' : '') + (d.pages > 1 ? ' pages=' + d.pages : '') + (d.dropped ? ' dropped=' + d.dropped : '') + att() + (tag || ''));
      return 'ok';
    } catch (e) {
      nFail++;
      failures.push({ secid: q.secid, code: q.code, name: q.name, error: e.message, kind: e.kind || 'throttle', at: nowIso() });
      flog(nowIso() + ' ' + i + '/' + total + ' ' + q.secid + ' ' + q.name + ' 0 FAILED ' + e.message + ' kind=' + (e.kind || 'throttle') + att() + (tag || ''));
      return e.kind === 'invalid' ? 'nodata' : 'fail';
    }
  }
  const progress = (i, total) => 'fetch progress ' + i + '/' + total + ' ok=' + nOk + ' cached=' + nCached + ' fail=' + nFail + ' req=' + totalReq + ' reqFail=' + totalFail + ' backoffMin=' + Math.round(totalBackoffMs / 60000) + (nEmpty ? ' empty=' + nEmpty : '') + (nSina ? ' sina=' + nSina : '');
  for (let i = 0; i < queue.length; i++) {
    const st = await one(queue[i], i + 1, queue.length, '');
    if (st !== 'cached') {
      await sleep(P.SLEEP_MS);
      if (PASS === 'dividends' && st === 'ok' && nOk > 0 && nOk % P.BATCH_PAUSE_EVERY === 0) { log('batch pause ' + Math.round(P.BATCH_PAUSE_MS / 1000) + 's after ' + nOk + ' fetched'); await sleep(P.BATCH_PAUSE_MS); }
    }
    if ((i + 1) % 100 === 0) log(progress(i + 1, queue.length));
  }
  // 限流类失败的最后再试一轮（无数据 invalid 不重试）
  let retried = 0, recovered = 0;
  const again = failures.filter((f) => f.kind !== 'invalid');
  if (again.length) {
    for (const f of again) failures.splice(failures.indexOf(f), 1);
    nFail -= again.length;
    flog('=== retry ' + again.length + ' failed secids ' + nowIso());
    for (let i = 0; i < again.length; i++) {
      retried++;
      const st = await one({ secid: again[i].secid, code: again[i].code, name: again[i].name, market: inferMarket(again[i].code) }, i + 1, again.length, ' (retry)');
      if (st === 'ok') recovered++;
      await sleep(P.SLEEP_MS);
    }
  }
  writeJSON(P_FAILURES(), failures, true);
  const residual = failures.filter((f) => f.kind !== 'invalid').length;
  const summary = { pass: PASS, dataEnd: DATA_END, queue: queue.length, ok: nOk, cached: nCached, failed: failures.length, failedInvalid: failures.length - residual, failedThrottle: residual, empty: nEmpty, sina: nSina, requests: totalReq, requestFailures: totalFail, backoffMinutes: Math.round(totalBackoffMs / 60000), retried, recovered, subset: SUBSET_RUN, finishedAt: nowIso() };
  log('fetch end ' + JSON.stringify(summary));
  if (residual === 0 && !SUBSET_RUN) { writeJSON(P_DONE(), summary, true); flog('=== DONE marker written ' + P_DONE()); }
  else if (SUBSET_RUN) flog('=== subset run (--codes/--limit): done marker not written');
  else flog('=== ' + residual + ' throttle-type failure(s) remain: done marker not written (watchdog restarts and resumes)');
  return summary;
}

// ------------------------------------------------------------------ main
function parseArgs(argv) {
  const a = { pass: null, codes: null, limit: null, dataEnd: CONFIG.DATA_END };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (s === '--pass') { a.pass = String(argv[++i] || '').toLowerCase(); if (a.pass !== 'dividends' && a.pass !== 'prices') throw new Error('--pass must be dividends or prices'); }
    else if (s === '--codes') a.codes = String(argv[++i]).split(',').map((x) => x.trim()).filter(Boolean);
    else if (s === '--limit') { a.limit = parseInt(argv[++i], 10); if (!(a.limit > 0)) throw new Error('--limit must be a positive integer'); }
    else if (s === '--data-end') { a.dataEnd = String(argv[++i] || ''); if (!isYMD(a.dataEnd)) throw new Error('--data-end must be YYYY-MM-DD (got "' + a.dataEnd + '")'); }
    else throw new Error('unknown argument: ' + s);
  }
  if (!a.pass) throw new Error('--pass dividends|prices is required');
  return a;
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  PASS = args.pass; DATA_END = args.dataEnd; SUBSET_RUN = !!(args.codes || args.limit != null);
  fs.mkdirSync(cacheDir(), { recursive: true });
  log('start ' + JSON.stringify({ pass: PASS, args, node: process.version, pid: process.pid, cacheDir: cacheDir() }));
  const uPath = path.join(PUB_DIR, 'universe.json');
  const universe = readJSON(uPath);
  const eligible = universe.filter((r) => r.excluded_reason == null);
  log('universe ' + uPath + ': rows=' + universe.length + ' eligible=' + eligible.length);
  if (eligible.length < CONFIG.UNIVERSE_MIN || eligible.length > CONFIG.UNIVERSE_MAX) {
    log('ABORT: eligible count ' + eligible.length + ' outside [' + CONFIG.UNIVERSE_MIN + ', ' + CONFIG.UNIVERSE_MAX + '] (expected 4,116) — check screen/universe.json');
    process.exit(2);
  }
  let queue;
  if (args.codes) { // 子集：按给定顺序；不在股票池里的代码合成一行
    queue = args.codes.map((code) => universe.find((r) => r.code === code) || { code, name: '', market: inferMarket(code), secid: inferMarket(code) + '.' + code });
  } else queue = buildQueue(eligible);
  if (args.limit != null) queue = queue.slice(0, args.limit);
  await run(queue);
}
process.on('uncaughtException', (e) => { log('uncaughtException ' + (e && e.stack || e)); });
process.on('unhandledRejection', (e) => { log('unhandledRejection ' + (e && e.stack || e)); });
main().catch((e) => { log('FATAL ' + (e && e.stack || e)); process.exit(1); });
