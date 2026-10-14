/* 批量分析：复用 app.js 的计算引擎，对下方 ASSETS 列表逐个拉数并输出 results.json + summary.md（写到当前目录）
 * 用法：node tools/batch_report.js   （类型 S=股票 E=ETF 用 市场.代码；F=场外基金 用基金代码，走天天基金复权净值）
 * 区间：最近 20 年（上市不足取全部）；可改 addMonths(last.t, -240) 调整。接口有限流，脚本自带重试与间隔 */
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');
const E = require('../app.js');

const DAY = 86400000;
const ASSETS = [
  ['传媒ETF', 'E', '1.512980', '广发中证传媒ETF'],
  ['天威视讯', 'S', '0.002238'],
  ['中文传媒', 'S', '1.600373'],
  ['养殖ETF', 'E', '0.159865', '国泰中证畜牧养殖ETF'],
  ['前海开源中证大农业指数增强A', 'F', '001027'],
  ['东航物流', 'S', '1.601156'],
  ['医药卫生ETF', 'E', '0.159938', '广发中证全指医药卫生ETF'],
  ['复星医药', 'S', '1.600196'],
  ['医疗ETF', 'E', '1.512170', '华宝中证医疗ETF'],
  ['安琪酵母', 'S', '1.600298'],
  ['太阳纸业', 'S', '0.002078'],
  ['新洋丰', 'S', '0.000902'],
  ['陆家嘴', 'S', '1.600663'],
  ['地产ETF', 'E', '0.159707', '华宝中证800地产ETF'],
  ['索菲亚', 'S', '0.002572'],
  ['海螺水泥', 'S', '1.600585'],
  ['三一重工', 'S', '1.600031'],
  ['富国中证1000指数增强(LOF)A', 'F', '161039'],
  ['西部利得中证500指数增强(LOF)C', 'F', '009300'],
  ['易方达上证50增强C', 'F', '004746'],
  ['苏利股份', 'S', '1.603585'],
  ['旅游ETF', 'E', '0.159766', '富国中证旅游主题ETF'],
  ['南方航空', 'S', '1.600029'],
  ['惠发食品', 'S', '1.603536'],
  ['上汽集团', 'S', '1.600104'],
  ['青岛啤酒', 'S', '1.600600'],
  ['广汽集团', 'S', '1.601238'],
  ['双汇发展', 'S', '0.000895'],
  ['天弘中证食品饮料ETF联接C', 'F', '001632'],
  ['上海家化', 'S', '1.600315'],
  ['韵达股份', 'S', '0.002120'],
  ['中概互联网ETF', 'E', '1.513050', '易方达中概互联网ETF'],
  ['恒生互联网ETF', 'E', '1.513330', '华夏恒生互联网科技业ETF'],
  ['萤石网络', 'S', '1.688475'],
  ['科创50ETF', 'E', '1.588000', '华夏科创50ETF'],
  ['京沪高铁', 'S', '1.601816'],
  ['交通银行', 'S', '1.601328'],
  ['华夏银行', 'S', '1.600015'],
  ['南京银行', 'S', '1.601009'],
  ['农业银行', 'S', '1.601288'],
  ['新能源ETF', 'E', '1.516160', '南方中证新能源ETF'],
  ['券商ETF', 'E', '1.512000', '华宝中证全指证券公司ETF'],
  ['中国平安', 'S', '1.601318'],
  ['金石资源', 'S', '1.603505'],
  ['西藏旅游', 'S', '1.600749'],
];

async function get(url, headers) {
  for (let i = 0; ; i++) {
    try { return await get1(url, headers); } catch (e) { if (i >= 4) throw e; await new Promise((r) => setTimeout(r, 2000 * (i + 1))); }
  }
}
function get1(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: Object.assign({ 'User-Agent': 'Mozilla/5.0' }, headers || {}), timeout: 30000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function fetchKline(secid, fqt) {
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=' + secid + '&ut=fa5fd1943c7b386f172d6893dbfba10b&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=' + fqt + '&beg=0&end=20500101&lmt=1000000';
  const j = JSON.parse(await get(url, { Referer: 'https://quote.eastmoney.com/' }));
  const raw = j.data.klines;
  const bars = [];
  for (const s of raw) { const p = s.split(','); const c = +p[2]; if (c > 0) bars.push({ t: E.parseYMD(p[0]), c }); }
  return { name: E.cleanName(j.data.name), bars, dropped: raw.length - bars.length };
}

async function fetchFund(code) {
  const js = await get('https://fund.eastmoney.com/pingzhongdata/' + code + '.js', { Referer: 'https://fund.eastmoney.com/' });
  const name = (js.match(/var fS_name = "([^"]+)"/) || [])[1] || code;
  const k = js.indexOf('var Data_netWorthTrend = ');
  const s = js.indexOf('[', k), e = js.indexOf('];', s);
  const arr = JSON.parse(js.slice(s, e + 1));
  // 用日增长率链式复权（含分红），得到可比的复权净值序列
  const bars = [];
  let nav = null;
  for (const o of arr) {
    if (nav == null) nav = o.y; else nav = nav * (1 + (o.equityReturn || 0) / 100);
    bars.push({ t: Math.round(o.x / DAY), c: nav });
  }
  return { name: E.cleanName(name), bars, dropped: 0 };
}

async function run() {
  const out = [];
  for (const a of ASSETS) {
    const [disp, type, id, note] = a;
    process.stdout.write(disp + ' ... ');
    try {
      let d, fqt = '1';
      if (type === 'F') d = await fetchFund(id);
      else { d = await fetchKline(id, '1'); if (d.dropped > 0) { fqt = '2'; d = await fetchKline(id, '2'); } }
      const all = d.bars;
      const last = all[all.length - 1];
      const i0 = E.idxOnOrAfter(all, E.addMonths(last.t, -240));
      const view = all.slice(Math.max(0, Math.min(i0, all.length - 2)));
      const A = E.analyze(view, 0.2, 'auto');
      const H = E.computeHorizons(all, A);
      const hz = {};
      for (const row of H) for (const c of row) hz[c.k] = c.v;
      const ys = E.yearlyReturns(all);
      const cur = A.phases[A.phases.length - 1];
      const ep = A.maxDD;
      const lifeDays = last.t - all[0].t;
      out.push({
        disp, type, id, note: note || '', name: d.name, fqt: type === 'F' ? '复权净值' : (fqt === '1' ? '前复权' : '后复权'),
        listDate: E.fmtDate(all[0].t), lastDate: E.fmtDate(last.t), lastClose: last.c,
        winStart: E.fmtDate(A.t[0]), years: +(A.days / 365.25).toFixed(1), truncated: i0 > 0,
        total: A.total, cagr: A.cagr, lifeCagr: lifeDays >= 20 ? Math.pow(last.c / all[0].c, 365.25 / lifeDays) - 1 : null, lifeTotal: last.c / all[0].c - 1,
        vol: A.vol,
        maxDD: ep ? ep.depth : 0, ddPeak: ep ? E.fmtDate(A.t[ep.peak]) : '', ddTrough: ep ? E.fmtDate(A.t[ep.trough]) : '',
        ddDownDays: ep ? A.t[ep.trough] - A.t[ep.peak] : null, ddRecDays: ep && ep.end != null ? A.t[ep.end] - A.t[ep.trough] : null, ddRecovered: ep ? ep.end != null : true, ddSinceTroughDays: ep && ep.end == null ? last.t - A.t[ep.trough] : null,
        curDD: A.curDD, curPeakDate: E.fmtDate(A.t[A.curPeakIdx]),
        nBull: A.phases.filter((p) => p.bull).length, nBear: A.phases.filter((p) => !p.bull).length, basis: A.basis,
        curPhase: { bull: cur.bull, start: E.fmtDate(A.t[cur.s]), days: cur.days, ret: cur.ret, ann: cur.ann },
        avgBull: avg(A.phases.filter((p) => p.bull && !p.ongoing && !p.first)), avgBear: avg(A.phases.filter((p) => !p.bull && !p.ongoing && !p.first)),
        hz, yearly: ys.map((y) => [y.y, +(y.v * 100).toFixed(1)]),
        phases: A.phases.map((p) => ({ bull: p.bull, s: E.fmtDate(A.t[p.s]), e: E.fmtDate(A.t[p.e]), days: p.days, ret: p.ret, ann: p.ann, ongoing: p.ongoing })),
        link: type === 'F' ? '' : 'index.html#s=' + id + '&r=20y&fqt=' + fqt + '&th=0.2',
      });
      console.log('ok', d.name, all.length, 'bars, window', E.fmtDate(A.t[0]), '->', E.fmtDate(last.t));
    } catch (err) { console.log('FAILED', err.message); out.push({ disp, type, id, error: err.message }); }
    await new Promise((r) => setTimeout(r, 700));
  }
  fs.writeFileSync(path.join(process.cwd(), 'results.json'), JSON.stringify(out, null, 1), 'utf8');
  writeSummary(out);
}
function avg(arr) { if (!arr.length) return null; return { ret: arr.reduce((a, p) => a + p.ret, 0) / arr.length, days: arr.reduce((a, p) => a + p.days, 0) / arr.length, n: arr.length }; }
const P = (x, d = 1) => (x == null || !isFinite(x) ? '—' : (x > 0 ? '+' : '') + (x * 100).toFixed(d) + '%');
const M = (days) => (days == null ? '—' : days < 31 ? Math.round(days) + 'd' : Math.round(days / 30.4375) + 'm');

function writeSummary(out) {
  const rows = out.filter((r) => !r.error);
  const lines = [];
  lines.push('| # | 名称 | 代码 | 区间起点 | 年数 | 区间总收益 | 年化 | 最大回撤 | 峰→谷 | 修复 | 当前回撤 | 牛/熊 | 当前阶段 | 近1年 | YTD | 24-9-24至今 |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  rows.forEach((r, i) => {
    lines.push(`| ${i + 1} | ${r.disp} | ${r.id} | ${r.winStart}${r.truncated ? '' : '*'} | ${r.years} | ${P(r.total)} | ${P(r.cagr)} | ${P(r.maxDD)} | ${M(r.ddDownDays)} | ${r.ddRecovered ? M(r.ddRecDays) : '未修复(' + M(r.ddSinceTroughDays) + ')'} | ${P(r.curDD)} | ${r.nBull}/${r.nBear} | ${r.curPhase.bull ? '牛' : '熊'} ${M(r.curPhase.days)} ${P(r.curPhase.ret)} | ${P(r.hz['1年'])} | ${P(r.hz['年初至今'])} | ${P(r.hz['24年9月24日至今'])} |`);
  });
  fs.writeFileSync(path.join(process.cwd(), 'summary.md'), lines.join('\n'), 'utf8');
  console.log('\n' + lines.join('\n'));
}
run().catch((e) => { console.error(e); process.exit(1); });
