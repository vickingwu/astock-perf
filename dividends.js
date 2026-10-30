/* 分红 / 股息口径（v3.1）—— 个股看板（index.html / app.js）与全市场筛选器（tools/screen_all.js）共用的同一份实现。
 * 浏览器：<script src="dividends.js"> 后以 window.DIV 使用；Node：const DIV = require('./dividends.js')。零依赖、不读 DOM。
 *
 * 输入约定：日期用天数 t = Date.UTC(y, m−1, d) / 86400000（与 app.js 相同）；价格点 / K 线为升序 [{t, c}]（c = 不复权收盘），任意频率均可：
 *   筛选器传月末不复权收盘（+ 上市首日锚点 + 数据截止日收盘），看板传不复权日线。
 * 事件（normalizeEvents）：东财 datacenter RPT_SHAREBONUS_DET 原始行 → 「实施」且除息日 ≤ 数据截止日的记录；每股税前现金 = PRETAX_BONUS_RMB / 10；
 *   送转因子 = 1 + (BONUS_IT_RATIO ?? BONUS_RATIO + IT_RATIO) / 10；会计年度 = REPORT_DATE 年份（无则按除息月：≤ 8 月归上一年）；同日同额同因子去重；按除息日升序。
 * 指标（与 screen/README.md「分红与股息指标」一致）：
 *   每股分红TTM / 股息率(近12月)：(数据截止日 − 365d, 数据截止日] 内除息的每股现金 ÷ 其后送转因子之积，再 ÷ 数据截止日不复权收盘；
 *   连续分红年数：自最近一个完整会计年度向前连续有现金分红的会计年度数；分红年数 x/N：区间会计年度内有现金分红的年度数 / 年度数；
 *     最近完整会计年度：筛选器 fiscalYearRule = 数据截止年 − 1（数据截止日固定在 10 月，年报分红季已结束）；看板是实时页面，用 latestCompleteFY：
 *     9–12 月同样取 当年 − 1；1–8 月为上一年度年报分红的实施季，若 FY(当年 − 1) 尚无已实施的现金分红事件则取 当年 − 2（否则年报分红未实施就会显示为「中断」）。
 *   平均股息率：Σ（每股现金 ÷ 除息月前一月末不复权收盘）÷ N；派息率：Σ 现金 ÷ Σ 年报基本 EPS（只对有分红且有年报 EPS 的年度）；分红增长：拆分调整年度 DPS 的 CAGR（≥ 3 个分红年度）；
 *   年化(分红再投资)：每笔现金在除息日当日或之后的首个价格点按收盘买回、送转按因子调份额；纯价格年化只计送转；分红贡献 = 二者之差（未取整前相减，再保留 4 位）。
 *   看板用日线再投资（除息后首个交易日），筛选器用月末价近似（除息后首个月末），二者的 年化(分红再投资) / 分红贡献 略有差异；后复权对账补齐（src 'hfq'）与 recon_drift 置空只在 tools/screen_all.js 中进行，
 *   看板只在后复权视图下用 summarize(opts.hfqBars)（同一标的的后复权日线）复刻筛选器的 hfq_gap：|年化(分红再投资) − 同区间后复权年化| > TR_GAP_MAX（2 pp）→ flags 含 'hfq_gap'（数值保留，与筛选器 NULL_ON_HFQ_GAP=false 相同）。
 *   前复权序列不能用于此判定：东财对现金分红作加性调整（hfq(t) = S(t)·raw(t) + D(t)，前复权则从历史价中扣减其后全部分红），区间起点价被压低、区间年化被系统性抬高，与再投资年化不可比
 *   （合成 10 年、5% 股息率、无送转个股：后复权差 +1.0 pp 不标，前复权差 −2.7 pp 误标），且分红较多的老股前复权会出现非正价格。
 *   1–8 月若 FY(lastFY) 已有现金事件但尚无年报（报告期 12-31）派息，summarize 另给 partialFY = lastFY（该年度现金暂只含中期 / 季度派息，看板提示「年报分红尚未实施（已含中期）」）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DIV = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  const DAY = 86400000;
  const TTM_DAYS = 365;                 // 近12月 = (数据截止日 − 365d, 数据截止日]
  const pad2 = (n) => (n < 10 ? '0' : '') + n;
  function parseYMD(s) { return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY; }
  function tToDate(t) { return new Date(t * DAY); }
  function fmtDate(t) { const d = tToDate(t); return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()); }
  const yearOf = (t) => tToDate(t).getUTCFullYear();
  const fin = (x) => (x == null || typeof x !== 'number' || !isFinite(x) ? null : x);
  const rd = (x, d = 6) => { x = fin(x); return x == null ? null : Math.round(x * Math.pow(10, d)) / Math.pow(10, d); };
  const isYMD = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && fmtDate(parseYMD(s)) === s;
  const numOr0 = (v) => (v == null || v === '' || !isFinite(+v) ? 0 : +v);

  // 最近一个完整会计年度（筛选器规则）：日期 t 所在年 − 1（LAST_FY = year(DATA_END) − 1；数据截止日在 10 月，年报分红季已结束）
  const fiscalYearRule = (t) => yearOf(t) - 1;
  // 年报分红实施季的最后一个月（含）：1–8 月除息的多为上一年度年报 / 中期派息，9 月起上一年度的年报分红基本已全部实施
  const ANNUAL_SEASON_END_MONTH = 8;
  // 最近一个完整会计年度（看板 / 实时页面规则）：9–12 月 = 当年 − 1（与筛选器相同）；1–8 月若 FY(当年 − 1) 尚无已实施的现金分红事件（年报分红还没除息）则 = 当年 − 2，
  //   否则一只每年只派一次年报股息的公司在 1 月到除息日之间会被记为「连续分红 0 年」。events 须已按数据截止日过滤（normalizeEvents(rows, dataEndT)）。
  function latestCompleteFY(events, endT) {
    const fy1 = fiscalYearRule(endT);
    if (tToDate(endT).getUTCMonth() + 1 > ANNUAL_SEASON_END_MONTH) return fy1;
    for (const e of events || []) if (e.cash > 0 && e.fy === fy1) return fy1;
    return fy1 - 1;
  }
  const TR_GAP_MAX = 0.02; // |年化(分红再投资) − 同区间后复权年化| 超过 2 pp → 'hfq_gap'（与 tools/screen_all.js CONFIG.DIV.TR_GAP_MAX 相同）
  // 无报告期时按除息月归属：1–8 月除息多为上一年度 年度/中期派息；9–12 月除息的中期 / 特别派息归当年
  const fyByExDate = (ex) => { const y = +ex.slice(0, 4), m = +ex.slice(5, 7); return m <= 8 ? y - 1 : y; };

  // 原始行 → 事件（按除息日升序；同日同额同因子去重）：只认「实施」且有除息日且除息日 ≤ 数据截止日的行；现金或送转至少一项 > 0
  function normalizeEvents(rows, dataEndT) {
    const out = [];
    for (const r of rows) {
      if (!r || !/实施/.test(String(r.ASSIGN_PROGRESS || '')) || !r.EX_DIVIDEND_DATE) continue;
      const ex = String(r.EX_DIVIDEND_DATE).slice(0, 10);
      if (!isYMD(ex)) continue;
      const exT = parseYMD(ex);
      if (exT > dataEndT) continue;
      const rep = r.REPORT_DATE ? String(r.REPORT_DATE).slice(0, 10) : null;
      const cash = numOr0(r.PRETAX_BONUS_RMB) / 10;
      const bit = r.BONUS_IT_RATIO != null && r.BONUS_IT_RATIO !== '' && isFinite(+r.BONUS_IT_RATIO) ? +r.BONUS_IT_RATIO : numOr0(r.BONUS_RATIO) + numOr0(r.IT_RATIO);
      const split = 1 + (bit > 0 ? bit : 0) / 10;
      if (!(cash > 0) && !(split > 1)) continue;
      const eps = r.BASIC_EPS != null && r.BASIC_EPS !== '' && isFinite(+r.BASIC_EPS) ? +r.BASIC_EPS : null;
      out.push({ ex, exT, rep, fy: rep && /^\d{4}-/.test(rep) ? +rep.slice(0, 4) : fyByExDate(ex), cash: rd(cash, 6), split: rd(split, 6), eps, isAnnual: !!rep && rep.endsWith('-12-31'), src: 'table' });
    }
    const seen = new Set(), ded = [];
    for (const e of out) { const k = e.ex + '|' + e.cash + '|' + e.split; if (seen.has(k)) continue; seen.add(k); ded.push(e); }
    ded.sort((a, b) => a.exT - b.exT);
    return ded;
  }
  // 每股现金折算到当前股本的除数：sFwd[i] = Π 除息日 ≥ 该事件除息日 的送转因子（同日送转含在内：现金按送转前股数支付）
  function splitForwardFactors(events) {
    const sFwd = new Array(events.length);
    { let s = 1, i = events.length - 1; while (i >= 0) { let j = i; while (j - 1 >= 0 && events[j - 1].exT === events[i].exT) j--; for (let k = j; k <= i; k++) s *= events[k].split; for (let k = j; k <= i; k++) sFwd[k] = s; i = j - 1; } }
    return sFwd;
  }
  // 每股分红TTM（未取整）、按会计年度汇总的现金 / 拆分调整现金 / 年报 EPS（只含 fy ≤ lastFY）、连续分红年数
  function aggregate(events, sFwd, lastFY, ttmFromT) {
    let dpsTTM = 0;
    const cashFY = new Map(), dpsAdjFY = new Map(), epsFY = new Map();
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.exT > ttmFromT) dpsTTM += e.cash / sFwd[i];
      if (e.fy <= lastFY) {
        if (e.cash > 0) { cashFY.set(e.fy, (cashFY.get(e.fy) || 0) + e.cash); dpsAdjFY.set(e.fy, (dpsAdjFY.get(e.fy) || 0) + e.cash / sFwd[i]); }
        if (e.src === 'table' && e.isAnnual && e.eps != null && e.eps > 0 && !epsFY.has(e.fy)) epsFY.set(e.fy, e.eps);
      }
    }
    let streak = 0; for (let fy = lastFY; cashFY.has(fy); fy--) streak++;
    return { dpsTTM, cashFY, dpsAdjFY, epsFY, streak };
  }
  // 股息率(近12月)，保留 4 位（调用方保证 closeEnd > 0）
  const yieldTTM = (dpsTTM, closeEnd) => rd(dpsTTM / closeEnd, 4);
  // 除息前一月末不复权收盘：按日历月查（points 升序、同月取最后一个点）；缺则取除息月之前最近一个点；再缺取上市首日锚点（anchorClose，可为 null）
  function makePrevMonthClose(points, anchorClose) {
    const byYM = new Map(); for (const m of points) byYM.set(fmtDate(m.t).slice(0, 7), m.c);
    return (exT) => {
      const d = tToDate(exT), y = d.getUTCFullYear(), mo = d.getUTCMonth(); // 0 起
      const py = mo === 0 ? y - 1 : y, pm = mo === 0 ? 11 : mo - 1;
      const direct = byYM.get(py + '-' + String(pm + 1).padStart(2, '0'));
      if (direct != null) return direct;
      const firstOfMonth = Date.UTC(y, mo, 1) / DAY;
      let best = null; for (const m of points) { if (m.t < firstOfMonth) best = m.c; else break; }
      if (best != null) return best;
      return anchorClose != null ? anchorClose : null;
    };
  }
  // 每笔现金事件的股息率（现金 ÷ 除息前一月末收盘；fy > lastFY 或无价格的事件为 null，后者计入 skipped）
  function eventYields(events, lastFY, prevMonthClose) {
    let skipped = 0;
    const yields = events.map((e) => { if (!(e.cash > 0) || e.fy > lastFY) return null; const p = prevMonthClose(e.exT); if (!(p > 0)) { skipped++; return null; } return e.cash / p; });
    return { yields, skipped };
  }
  // 区间统计（会计年度 fyFrom..lastFY）：分红年数 / 平均股息率 / 派息率 / 分红增长（均保留 4 位；不可算为 null）
  function windowStats(events, yields, agg, fyFrom, lastFY) {
    const divN = Math.max(0, lastFY - fyFrom + 1);
    let years = 0, sumCash = 0, sumEps = 0, sumYield = 0;
    const payingFys = [];
    for (let fy = fyFrom; fy <= lastFY; fy++) {
      if (!agg.cashFY.has(fy)) continue;
      years++; payingFys.push(fy);
      if (agg.epsFY.has(fy)) { sumCash += agg.cashFY.get(fy); sumEps += agg.epsFY.get(fy); }
    }
    for (let i = 0; i < events.length; i++) if (yields[i] != null && events[i].fy >= fyFrom) sumYield += yields[i];
    const avgDivYield = divN > 0 ? rd(sumYield / divN, 4) : null;
    const payoutRatio = sumEps > 0 ? rd(sumCash / sumEps, 4) : null;
    let dpsCagr = null;
    if (payingFys.length >= 3) { const f0 = payingFys[0], f1 = payingFys[payingFys.length - 1], a = agg.dpsAdjFY.get(f0), b = agg.dpsAdjFY.get(f1); dpsCagr = f1 > f0 && a > 0 && b > 0 ? rd(Math.pow(b / a, 1 / (f1 - f0)) - 1, 4) : null; }
    return { divN, divYears: years, payingFys, avgDivYield, payoutRatio, dpsCagr };
  }
  // 再投资 / 纯价格 年化（未取整）：从价格点 si 走到 endIdx；每笔现金在除息日当日或之后的首个价格点按收盘买回、送转按因子调份额；纯价格只计送转
  function reinvestCagr(points, si, endIdx, events) {
    if (si == null || si < 0 || si >= endIdx) return null;
    const p0 = points[si], p1 = points[endIdx], years = (p1.t - p0.t) / 365.25;
    if (!(years > 0)) return null;
    let shares = 1, cumSplit = 1, ei = 0;
    while (ei < events.length && events[ei].exT <= p0.t) ei++;
    for (let p = si + 1; p <= endIdx; p++) {
      while (ei < events.length && events[ei].exT <= points[p].t) { const e = events[ei++]; const cash = shares * e.cash; shares *= e.split; cumSplit *= e.split; shares += cash / points[p].c; }
    }
    return { cagrTR: Math.pow(shares * p1.c / p0.c, 1 / years) - 1, cagrPx: Math.pow(cumSplit * p1.c / p0.c, 1 / years) - 1, years, shares, cumSplit };
  }

  // 以 t 为界的最近 / 最早 K 线下标（二分）
  function idxOnOrBefore(bars, t) {
    let lo = 0, hi = bars.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (bars[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }
  function idxOnOrAfter(bars, t) {
    let lo = 0, hi = bars.length - 1, ans = bars.length;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (bars[mid].t >= t) { ans = mid; hi = mid - 1; } else lo = mid + 1; }
    return ans;
  }

  // 看板汇总：events = normalizeEvents(...)；bars = 不复权 K 线 [{t, c}] 升序；
  //   opts = { startT, endT, lastFY = latestCompleteFY(events, endT), ttmDays = 365, hfqBars = null（同一标的的后复权 K 线 [{t, c}]，有则复刻筛选器的 hfq_gap 标记；前复权 / 不复权序列不可传入，见文件头）}
  //   区间 = [首根 t ≥ startT 的 K 线, 末根 t ≤ endT 的 K 线]；会计年度区间 = year(startT) .. lastFY
  //   除息前一月末收盘的锚点 = 首根 K 线收盘（上市首日不复权收盘；筛选器只在上市首日锚点与后复权序列对账一致时才用它，否则上市当月除息的事件不计股息率）
  function summarize(events, bars, opts) {
    opts = opts || {};
    events = events || [];
    bars = bars || [];
    const flags = [];
    const endIdx = bars.length ? (opts.endT != null ? idxOnOrBefore(bars, opts.endT) : bars.length - 1) : -1;
    const endT = endIdx >= 0 ? bars[endIdx].t : (opts.endT != null ? opts.endT : null);
    const startT = opts.startT != null ? opts.startT : (bars.length ? bars[0].t : endT);
    const calendarFY = endT != null ? fiscalYearRule(endT) : null;
    const lastFY = opts.lastFY != null ? opts.lastFY : (endT != null ? latestCompleteFY(events, endT) : null);
    const ttmDays = opts.ttmDays != null ? opts.ttmDays : TTM_DAYS;
    const fyFrom = startT != null ? yearOf(startT) : null;
    const closeEnd = endIdx >= 0 ? bars[endIdx].c : null;
    // pendingFY：按日历本应是最近完整年度、但其年报分红尚未实施的会计年度（1–8 月且无 FY(当年 − 1) 现金事件时 = 当年 − 1），否则 null
    const pendingFY = lastFY != null && calendarFY != null && lastFY < calendarFY ? calendarFY : null;
    // partialFY：1–8 月、lastFY 未被后移、FY(lastFY) 已有现金事件（中期 / 季度派息已除息）但尚无年报（报告期 12-31）派息 → 该年度的现金、股息率、分红增长暂只含中期，= lastFY；否则 null
    const inSeason = endT != null && tToDate(endT).getUTCMonth() + 1 <= ANNUAL_SEASON_END_MONTH;
    const partialFY = inSeason && pendingFY == null && lastFY != null && events.some((e) => e.cash > 0 && e.fy === lastFY) && !events.some((e) => e.cash > 0 && e.fy === lastFY && e.isAnnual) ? lastFY : null;
    const S = { dataEndT: endT, lastFY, pendingFY, partialFY, fyFrom, closeEnd, dpsTTM: 0, divYieldTTM: null, divStreak: 0, divYears: { paid: 0, total: 0, years: [] }, avgDivYield: null, payoutRatio: null, dpsCagr: null,
      cagrTR: null, cagrPx: null, divContrib: null, cagrAdj: null, trGap: null, years: null, trStartT: null, trEndT: null, flags, events: [], cashByFY: {} };
    if (endIdx < 0 || endT == null || lastFY == null) { flags.push('insufficient'); return S; }
    const pts = bars.slice(0, endIdx + 1);
    const sFwd = splitForwardFactors(events);
    const agg = aggregate(events, sFwd, lastFY, endT - ttmDays);
    S.dpsTTM = rd(agg.dpsTTM, 4);
    S.divYieldTTM = closeEnd ? yieldTTM(agg.dpsTTM, closeEnd) : null;
    S.divStreak = agg.streak;
    const prevMonthClose = makePrevMonthClose(pts, pts[0].c);
    const ey = eventYields(events, lastFY, prevMonthClose);
    const ws = windowStats(events, ey.yields, agg, fyFrom, lastFY);
    S.divYears = { paid: ws.divYears, total: ws.divN, years: ws.payingFys };
    S.avgDivYield = ws.avgDivYield; S.payoutRatio = ws.payoutRatio; S.dpsCagr = ws.dpsCagr;
    for (const e of events) if (e.cash > 0) S.cashByFY[e.fy] = rd((S.cashByFY[e.fy] || 0) + e.cash, 6);
    S.events = events.map((e, i) => { const p = prevMonthClose(e.exT); return Object.assign({}, e, { yield: ey.yields[i], yieldDisp: e.cash > 0 && p > 0 ? e.cash / p : null }); });
    const si = idxOnOrAfter(pts, startT);
    if (pts.length < 2 || si >= endIdx) { flags.push('insufficient'); return S; }
    const tm = reinvestCagr(pts, si, endIdx, events);
    if (!tm) { flags.push('px_missing'); return S; }
    S.trStartT = pts[si].t; S.trEndT = pts[endIdx].t; S.years = tm.years;
    S.cagrTR = rd(tm.cagrTR, 4); S.cagrPx = rd(tm.cagrPx, 4); S.divContrib = rd(tm.cagrTR - tm.cagrPx, 4);
    // hfq_gap（筛选器同名标记的看板复刻）：同区间两端同一日期的后复权收盘年化 与 年化(分红再投资) 相差 > TR_GAP_MAX → 复权口径差异，或分红表缺送转 / 配股记录；两端日期在后复权序列中缺失则不判
    const adj = opts.hfqBars;
    if (adj && adj.length) {
      const a0 = idxOnOrBefore(adj, S.trStartT), a1 = idxOnOrBefore(adj, S.trEndT);
      if (a0 >= 0 && a1 > a0 && adj[a0].t === S.trStartT && adj[a1].t === S.trEndT && adj[a0].c > 0 && adj[a1].c > 0) {
        const cagrAdj = Math.pow(adj[a1].c / adj[a0].c, 1 / tm.years) - 1;
        S.cagrAdj = rd(cagrAdj, 4); S.trGap = rd(tm.cagrTR - cagrAdj, 4);
        if (Math.abs(tm.cagrTR - cagrAdj) > TR_GAP_MAX) flags.push('hfq_gap');
      }
    }
    return S;
  }

  return { TTM_DAYS, TR_GAP_MAX, ANNUAL_SEASON_END_MONTH, parseYMD, fmtDate, rd, isYMD, fiscalYearRule, latestCompleteFY, fyByExDate, normalizeEvents, splitForwardFactors, aggregate, yieldTTM, makePrevMonthClose, eventYields, windowStats, reinvestCagr, summarize };
});
