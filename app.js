/* A股 / 场内ETF 历史表现看板
 * 纯静态、零依赖。数据：东方财富日线接口（JSONP，支持 file:// 直接打开）。
 * 模块：① 对数净值 + CAGR ② 回撤幅度/历时 ③ 牛熊阶段（ZigZag 峰谷法）④ 多尺度涨跌 + 分周期统计
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------ utils
  const DAY = 86400000;
  const FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Segoe UI", Helvetica, Arial, sans-serif';
  const C = { up: '#d93a3f', down: '#2a9d4f', upBg: 'rgba(217,58,63,0.16)', downBg: 'rgba(42,157,79,0.16)', blue: '#3b82f6', blueBg: 'rgba(59,130,246,0.13)', grid: '#e5e7eb', axis: '#6b7280', text: '#374151', muted: '#9ca3af' };
  const $ = (id) => document.getElementById(id);
  const pad2 = (n) => (n < 10 ? '0' : '') + n;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function parseYMD(s) { return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY; }
  function tToDate(t) { return new Date(t * DAY); }
  function fmtDate(t) { const d = tToDate(t); return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()); }
  function fmtYM(t) { const d = tToDate(t); return d.getUTCFullYear() + '.' + pad2(d.getUTCMonth() + 1); }
  function ymd(y, m, d) { return Date.UTC(y, m - 1, d) / DAY; }
  function addMonths(t, k) {
    const d = tToDate(t);
    let y = d.getUTCFullYear(), m = d.getUTCMonth() + k; const day = d.getUTCDate();
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return Date.UTC(y, m, Math.min(day, last)) / DAY;
  }
  function pct(x, digits = 1, sign = true) {
    if (x == null || !isFinite(x)) return '—';
    let v = (x * 100).toFixed(digits);
    if (parseFloat(v) === 0) v = (0).toFixed(digits); // 避免 "-0.0%"
    return (sign && parseFloat(v) > 0 ? '+' : '') + v + '%';
  }
  function fmtDur(days) {
    if (days < 28) return Math.max(1, Math.round(days)) + 'd';
    return Math.max(1, Math.round(days / 30.4375)) + 'm';
  }
  function fmtDurCN(days) {
    if (days == null) return '—';
    if (days < 31) return Math.round(days) + ' 天';
    const m = Math.round(days / 30.4375);
    return m >= 24 ? (m / 12).toFixed(1) + ' 年' : m + ' 个月';
  }
  function fmtMult(v) {
    let s;
    if (v >= 100) s = v.toFixed(0);
    else if (v >= 10) s = (v % 1 ? v.toFixed(1) : v.toFixed(0));
    else if (v >= 1) s = v.toFixed(Math.abs(v * 10 - Math.round(v * 10)) > 1e-6 ? 2 : 1);
    else s = v.toFixed(v < 0.1 ? 3 : 2).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
    return s + 'x';
  }
  function fmtPrice(v) { return v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(3).replace(/0$/, '') : v.toFixed(3); }
  function fmtNum(v) { return v.toLocaleString('zh-CN', { maximumFractionDigits: 2 }); }
  function cls(x) { return x > 0 ? 'up' : x < 0 ? 'down' : 'flat'; }
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  const IN_BROWSER = typeof document !== 'undefined';
  const _ctx = IN_BROWSER ? document.createElement('canvas').getContext('2d') : null;
  function textW(s, size, weight) {
    if (!_ctx) return s.length * size * 0.6;
    _ctx.font = (weight || 400) + ' ' + size + 'px ' + FONT; return _ctx.measureText(s).width;
  }

  // 以 t 为上界的最近一根 K 线（二分）
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

  // ------------------------------------------------------------------ JSONP
  function jsonp(url, param, timeout) {
    param = param || 'cb'; timeout = timeout || 20000;
    return new Promise((resolve, reject) => {
      const name = '__jp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const s = document.createElement('script');
      let done = false;
      const timer = setTimeout(() => { if (!done) { cleanup(); reject(new Error('请求超时')); } }, timeout);
      function cleanup() { done = true; clearTimeout(timer); try { delete window[name]; } catch (e) { window[name] = undefined; } s.remove(); }
      window[name] = (data) => { cleanup(); resolve(data); };
      s.onerror = () => { cleanup(); reject(new Error('网络错误或接口不可达')); };
      s.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + param + '=' + name + '&_=' + Date.now();
      document.head.appendChild(s);
    });
  }

  // ------------------------------------------------------------------ symbol list / search
  // 去空格、全角转半角（"五 粮 液" → "五粮液"，"万  科Ａ" → "万科A"）
  function cleanName(s) { return String(s || '').replace(/\s+/g, '').replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)); }
  function normName(s) { return cleanName(s).toLowerCase(); }
  const LIST = ((typeof window !== 'undefined' && window.STOCK_LIST) || []).map((r) => ({ code: String(r[0]), name: cleanName(r[1]), market: +r[2], type: r[3], py: (r[4] || '').toLowerCase(), nn: normName(r[1]) }));
  const BY_KEY = new Map(LIST.map((it) => [it.market + '.' + it.code, it]));

  function marketTag(it) {
    if (it.type === 'E') return { txt: 'ETF', cls: 'etf' };
    if (it.market === 1) return { txt: '沪A', cls: '' };
    if (/^(8|4|92)/.test(it.code)) return { txt: '北A', cls: 'bj' };
    return { txt: '深A', cls: '' };
  }
  function inferMarket(code) { return /^[569]/.test(code) ? 1 : 0; }

  function searchLocal(q) {
    q = normName(q);
    const pre = q.match(/^(sh|sz|bj)(\d{6})$/); if (pre) q = pre[2];
    if (!q) return [];
    const isNum = /^\d+$/.test(q);
    const res = [];
    for (const it of LIST) {
      let sc = -1;
      if (isNum) { if (it.code === q) sc = 100; else if (it.code.startsWith(q)) sc = 80; else if (it.code.indexOf(q) >= 0) sc = 30; }
      else if (it.nn === q) sc = 100;
      else if (it.py === q) sc = 92;
      else if (it.nn.startsWith(q)) sc = 85;
      else if (it.py.startsWith(q)) sc = 75;
      else if (it.nn.indexOf(q) >= 0) sc = 60;
      else if (it.py.indexOf(q) >= 0) sc = 40;
      if (sc >= 0) res.push({ it, sc });
    }
    res.sort((a, b) => b.sc - a.sc || (a.it.type === b.it.type ? a.it.code.localeCompare(b.it.code) : a.it.type === 'S' ? -1 : 1));
    return res.slice(0, 14).map((r) => r.it);
  }

  // 本地列表没有时，退回东方财富联想接口（覆盖新上市品种）
  async function searchRemote(q) {
    const url = 'https://searchapi.eastmoney.com/api/suggest/get?input=' + encodeURIComponent(q) + '&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=10';
    const j = await jsonp(url, 'cb', 8000);
    const data = (j && j.QuotationCodeTable && j.QuotationCodeTable.Data) || [];
    const out = [];
    for (const d of data) {
      const mk = +d.MktNum; if (mk !== 0 && mk !== 1) continue;
      let type = null;
      if (d.Classify === 'AStock' || d.Classify === 'NEEQ') type = 'S';
      else if (d.Classify === 'Fund' && /ETF/i.test(d.Name)) type = 'E';
      if (!type) continue;
      out.push({ code: d.Code, name: cleanName(d.Name), market: mk, type, py: (d.PinYin || '').toLowerCase(), nn: normName(d.Name), remote: true });
    }
    return out;
  }

  // ------------------------------------------------------------------ data
  const klineCache = new Map();
  async function fetchKlines(market, code, fqt) {
    const key = market + '.' + code + '.' + fqt;
    if (klineCache.has(key)) return klineCache.get(key);
    const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=' + market + '.' + code +
      '&ut=fa5fd1943c7b386f172d6893dbfba10b&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=' + fqt + '&beg=0&end=20500101&lmt=1000000';
    let j = null, lastErr = null;
    for (let attempt = 0; attempt < 2 && !j; attempt++) {
      try { j = await jsonp(url, 'cb', 25000); } catch (e) { lastErr = e; }
    }
    if (!j) throw lastErr || new Error('拉取失败');
    if (!j.data || !Array.isArray(j.data.klines)) throw new Error('接口未返回该代码的数据（代码是否正确？）');
    const bars = [];
    for (const s of j.data.klines) {
      const p = s.split(',');
      const c = +p[2];
      if (!(c > 0)) continue; // 前复权可能出现非正值，跳过
      bars.push({ t: parseYMD(p[0]), o: +p[1], c, h: +p[3], l: +p[4], v: +p[5], a: +p[6] });
    }
    const out = { name: cleanName(j.data.name), code: j.data.code, market: j.data.market, bars, dropped: j.data.klines.length - bars.length };
    klineCache.set(key, out);
    return out;
  }

  // ------------------------------------------------------------------ analytics
  // ZigZag 峰谷：自阶段极值反向运行超过 T 即确认转折。返回转折点下标（峰、谷交替）。
  function zigzagPivots(c, T) {
    const n = c.length, pivots = [];
    if (n < 2) return pivots;
    let trend = 0, extI = 0, maxI = 0, minI = 0, k = 1;
    for (; k < n; k++) {
      if (c[k] > c[maxI]) maxI = k;
      if (c[k] < c[minI]) minI = k;
      if (c[k] <= c[maxI] * (1 - T)) { trend = -1; if (maxI > 0) pivots.push(maxI); extI = k; break; }
      if (c[k] >= c[minI] * (1 + T)) { trend = 1; if (minI > 0) pivots.push(minI); extI = k; break; }
    }
    if (trend === 0) return pivots;
    for (k = k + 1; k < n; k++) {
      if (trend === 1) {
        if (c[k] >= c[extI]) extI = k;
        else if (c[k] <= c[extI] * (1 - T)) { pivots.push(extI); trend = -1; extI = k; }
      } else {
        if (c[k] <= c[extI]) extI = k;
        else if (c[k] >= c[extI] * (1 + T)) { pivots.push(extI); trend = 1; extI = k; }
      }
    }
    return pivots;
  }

  // 采样下标：D=每日，W=每周最后一个交易日，M=每月最后一个交易日（末根 K 线必含）
  function sampleIndices(bars, basis) {
    const n = bars.length, out = [];
    if (basis === 'D') { for (let i = 0; i < n; i++) out.push(i); return out; }
    const key = basis === 'W' ? (t) => Math.floor((t - 4) / 7) : (t) => { const d = tToDate(t); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
    for (let i = 0; i < n; i++) if (i === n - 1 || key(bars[i].t) !== key(bars[i + 1].t)) out.push(i);
    return out;
  }

  // 先在采样序列上识别转折，再在日线上精确定位峰谷（相邻转折之间的日收盘极值）
  function segmentPhases(bars, c, T, basis) {
    const n = c.length;
    if (n < 2) return [];
    const idx = sampleIndices(bars, basis);
    const sc = idx.map((i) => c[i]);
    const sp = zigzagPivots(sc, T);
    const refined = [];
    if (sp.length) {
      const nextRef = sp.length > 1 ? sc[sp[1]] : sc[sc.length - 1];
      let isPeak = sc[sp[0]] > nextRef;
      let prev = -1;
      for (let k = 0; k < sp.length; k++) {
        const lo = prev + 1;
        const hi = k + 1 < sp.length ? idx[sp[k + 1]] - 1 : n - 1;
        let best = idx[sp[k]];
        if (hi >= lo) {
          best = lo;
          for (let i = lo; i <= hi; i++) if (isPeak ? c[i] > c[best] : c[i] < c[best]) best = i;
        }
        refined.push(best); prev = best; isPeak = !isPeak;
      }
    }
    const bounds = [0].concat(refined, [n - 1]);
    const phases = [];
    for (let i = 0; i + 1 < bounds.length; i++) {
      const s = bounds[i], e = bounds[i + 1];
      if (e <= s) continue;
      phases.push({ s, e, bull: c[e] >= c[s], ongoing: i + 2 === bounds.length, first: i === 0 && refined.length > 0 });
    }
    return phases;
  }

  function autoBasis(days) { return days >= 365.25 * 6 ? 'M' : days >= 365.25 * 2 ? 'W' : 'D'; }

  function analyze(bars, T, basisOpt) {
    const n = bars.length;
    const c = bars.map((b) => b.c), t = bars.map((b) => b.t);
    const nav = c.map((x) => x / c[0]);
    const days = t[n - 1] - t[0];
    const total = nav[n - 1] - 1;
    const cagr = days >= 20 ? Math.pow(nav[n - 1], 365.25 / days) - 1 : NaN;

    // drawdown
    const dd = new Array(n), peakIdx = new Array(n);
    let runMax = -Infinity, runMaxI = 0;
    for (let i = 0; i < n; i++) {
      if (c[i] >= runMax) { runMax = c[i]; runMaxI = i; }
      dd[i] = c[i] / runMax - 1; peakIdx[i] = runMaxI;
    }
    const episodes = [];
    let cur = null;
    for (let i = 0; i < n; i++) {
      if (dd[i] < 0) {
        if (!cur) cur = { peak: peakIdx[i], trough: i, depth: dd[i], end: null };
        else if (dd[i] < cur.depth) { cur.depth = dd[i]; cur.trough = i; }
      } else if (cur) { cur.end = i; episodes.push(cur); cur = null; }
    }
    if (cur) episodes.push(cur);
    let maxDD = null;
    for (const ep of episodes) if (!maxDD || ep.depth < maxDD.depth) maxDD = ep;

    // phases
    const basis = basisOpt === 'auto' || !basisOpt ? autoBasis(days) : basisOpt;
    const phases = segmentPhases(bars, c, T, basis).map((p) => {
      const ret = c[p.e] / c[p.s] - 1, d = t[p.e] - t[p.s];
      let lo = Infinity, hi = -Infinity;
      for (let i = p.s; i <= p.e; i++) { const y = c[i] / c[p.s] - 1; if (y < lo) lo = y; if (y > hi) hi = y; }
      return Object.assign(p, { ret, days: d, ann: d >= 365 ? Math.pow(1 + ret, 365.25 / d) - 1 : null, lo, hi });
    });

    // volatility (annualised std of daily log returns)
    let sum = 0, sum2 = 0, m = 0;
    for (let i = 1; i < n; i++) { const r = Math.log(c[i] / c[i - 1]); sum += r; sum2 += r * r; m++; }
    const vol = m > 5 ? Math.sqrt(Math.max(0, sum2 / m - (sum / m) * (sum / m))) * Math.sqrt(242) : NaN;

    return { n, c, t, nav, dd, days, total, cagr, episodes, maxDD, phases, basis, vol, curDD: dd[n - 1], curPeakIdx: peakIdx[n - 1] };
  }

  function computeHorizons(all, A) {
    const n = all.length, last = all[n - 1];
    const base = (t) => { const i = idxOnOrBefore(all, t); return i >= 0 ? all[i] : null; };
    const cell = (k, b, note) => ({ k, v: b ? last.c / b.c - 1 : null, s: b ? ('基准 ' + fmtDate(b.t)) : (note || '上市不足'), base: b });
    const lastD = tToDate(last.t);
    const rows = [];
    rows.push([
      cell('1周', base(last.t - 7)),
      cell('1月', base(addMonths(last.t, -1))),
      cell('3月', base(addMonths(last.t, -3))),
      cell('6月', base(addMonths(last.t, -6))),
      cell('年初至今', base(ymd(lastD.getUTCFullYear() - 1, 12, 31)), '本年上市'),
    ]);
    rows.push([
      { k: '距区间前高', v: A.curDD, s: '前高 ' + fmtDate(A.t[A.curPeakIdx]) },
      cell('1年', base(addMonths(last.t, -12))),
      cell('24年9月24日至今', base(ymd(2024, 9, 23))),
      cell('3年', base(addMonths(last.t, -36))),
      cell('5年', base(addMonths(last.t, -60))),
    ]);
    const first = all[0];
    rows.push([
      cell('10年', base(addMonths(last.t, -120))),
      cell('20年', base(addMonths(last.t, -240))),
      { k: '上市至今', v: last.c / first.c - 1, s: '首日 ' + fmtDate(first.t) },
      cell('15年6月12日至今', base(ymd(2015, 6, 12)), '当时未上市'),
      cell('21年2月18日至今', base(ymd(2021, 2, 18)), '当时未上市'),
    ]);
    return rows;
  }

  function periodStats(bars) {
    const keys = {
      '日': (t) => t,
      '周': (t) => Math.floor((t - 4) / 7),
      '月': (t) => { const d = tToDate(t); return d.getUTCFullYear() * 12 + d.getUTCMonth(); },
      '季': (t) => { const d = tToDate(t); return d.getUTCFullYear() * 4 + Math.floor(d.getUTCMonth() / 3); },
      '年': (t) => tToDate(t).getUTCFullYear(),
    };
    const out = [];
    for (const name in keys) {
      const kf = keys[name];
      const closes = [];
      for (let i = 0; i < bars.length; i++) {
        if (i === bars.length - 1 || kf(bars[i].t) !== kf(bars[i + 1].t)) closes.push(bars[i].c);
      }
      const rets = [];
      for (let i = 1; i < closes.length; i++) rets.push(closes[i] / closes[i - 1] - 1);
      if (rets.length === 0) { out.push({ name, n: 0 }); continue; }
      const sorted = rets.slice().sort((a, b) => a - b);
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      const med = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
      out.push({ name, n: rets.length, win: rets.filter((r) => r > 0).length / rets.length, mean, med, max: sorted[sorted.length - 1], min: sorted[0] });
    }
    return out;
  }

  function yearlyReturns(all) {
    const out = [];
    let prevClose = null, prevYear = null;
    for (let i = 0; i < all.length; i++) {
      const y = tToDate(all[i].t).getUTCFullYear();
      const isLast = i === all.length - 1 || tToDate(all[i + 1].t).getUTCFullYear() !== y;
      if (isLast) {
        const basePrice = prevClose == null ? all[idxOnOrAfter(all, ymd(y, 1, 1))].c : prevClose;
        out.push({ y, v: all[i].c / basePrice - 1, partial: prevClose == null || (i === all.length - 1), fromListing: prevClose == null });
        prevClose = all[i].c; prevYear = y;
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ SVG helpers
  const NS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function txt(parent, x, y, str, attrs) {
    const e = el('text', Object.assign({ x, y, fill: C.text, 'font-size': 11, 'font-family': FONT }, attrs || {}), parent);
    e.textContent = str;
    return e;
  }
  function linScale(d0, d1, r0, r1) {
    const f = (x) => r0 + ((x - d0) / (d1 - d0)) * (r1 - r0);
    f.invert = (y) => d0 + ((y - r0) / (r1 - r0)) * (d1 - d0);
    return f;
  }
  function logScale(d0, d1, r0, r1) {
    const l0 = Math.log(d0), l1 = Math.log(d1);
    return (x) => r0 + ((Math.log(x) - l0) / (l1 - l0)) * (r1 - r0);
  }
  function niceStep(range, n) {
    const raw = range / n;
    const steps = [0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 50];
    return steps.find((s) => s >= raw) || 100;
  }
  function logTicks(lo, hi) {
    const sets = [[1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8], [1, 1.5, 2, 3, 4, 5, 6, 8], [1, 2, 3, 5, 8], [1, 2, 5], [1]];
    const e0 = Math.floor(Math.log10(lo)) - 1, e1 = Math.ceil(Math.log10(hi)) + 1;
    for (const mants of sets) {
      const out = [];
      for (let e = e0; e <= e1; e++) for (const m of mants) { const v = m * Math.pow(10, e); if (v >= lo && v <= hi) out.push(v); }
      if (out.length <= 9) return out;
    }
    return [];
  }
  function timeTicks(t0, t1, pxPerDay) {
    const ticks = [];
    const span = t1 - t0;
    if (span > 365 * 2.2) {
      const y0 = tToDate(t0).getUTCFullYear(), y1 = tToDate(t1).getUTCFullYear();
      const step = [1, 2, 5, 10, 20].find((s) => s * pxPerDay * 365.25 >= 58) || 20;
      for (let y = Math.ceil(y0 / step) * step; y <= y1 + 1; y += step) { const t = ymd(y, 1, 1); if (t >= t0 && t <= t1) ticks.push({ t, label: String(y) }); }
    } else {
      const step = [1, 2, 3, 6].find((s) => s * pxPerDay * 30.44 >= 58) || 6;
      const d0 = tToDate(t0);
      let y = d0.getUTCFullYear(), m = d0.getUTCMonth() + 1; // 0-based next month
      for (let i = 0; i < 400; i++) {
        if (m >= 12) { y++; m -= 12; }
        const t = ymd(y, m + 1, 1);
        if (t > t1) break;
        if (t >= t0 && m % step === 0) ticks.push({ t, label: y + '-' + pad2(m + 1) });
        m++;
      }
    }
    return ticks;
  }
  function pathOf(pts) {
    let d = '';
    for (let i = 0; i < pts.length; i++) d += (i ? 'L' : 'M') + pts[i][0].toFixed(1) + ' ' + pts[i][1].toFixed(1);
    return d;
  }
  function rectsOverlap(a, b, m) {
    m = m || 0;
    return !(a.x + a.w + m <= b.x || b.x + b.w + m <= a.x || a.y + a.h + m <= b.y || b.y + b.h + m <= a.y);
  }

  // ------------------------------------------------------------------ chart
  function renderChart(host, A, meta) {
    host.innerHTML = '';
    const W = Math.max(640, Math.floor(host.clientWidth || 1000));
    const denseChart = A.phases.length > 14; // 阶段多时给底部面板更多空间放标签
    const H = Math.round(clamp(W * 0.8, 560, 880)) + (denseChart ? 110 : 0);
    const M = { l: 72, r: 84, t: 50, b: 30 };
    const plotW = W - M.l - M.r, gap = 16;
    const innerH = H - M.t - M.b - 2 * gap;
    const hs = (denseChart ? [0.35, 0.23, 0.42] : [0.40, 0.27, 0.33]).map((f) => Math.round(innerH * f));
    const tops = [M.t, M.t + hs[0] + gap, M.t + hs[0] + hs[1] + 2 * gap];
    const L = M.l, R = M.l + plotW;

    const svg = el('svg', { xmlns: NS, width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, 'font-family': FONT }, host);
    el('rect', { x: 0, y: 0, width: W, height: H, fill: '#fff' }, svg);

    const { n, t, nav, dd, phases } = A;
    const t0 = t[0], t1 = t[n - 1];
    const span = Math.max(1, t1 - t0);
    const x = linScale(t0 - span * 0.012, t1 + span * 0.012, L, R);
    const pxPerDay = plotW / (span * 1.024);

    // title
    txt(svg, W / 2, 26, meta.name + '（对数）走势、回撤与牛熊周期', { 'text-anchor': 'middle', 'font-size': 19, 'font-weight': 700, fill: '#111827' });
    txt(svg, R, 42, meta.code + ' · ' + fmtDate(t0) + ' ~ ' + fmtDate(t1) + ' · ' + meta.fqtName + ' · ' + n + ' 个交易日', { 'text-anchor': 'end', 'font-size': 10.5, fill: C.muted });

    const xt = timeTicks(t0, t1, pxPerDay);
    const gridG = el('g', {}, svg);
    const panelG = [el('g', {}, svg), el('g', {}, svg), el('g', {}, svg)];

    function frame(top, h) {
      el('rect', { x: L, y: top, width: plotW, height: h, fill: 'none', stroke: '#d1d5db', 'stroke-width': 1 }, gridG);
      for (const tk of xt) el('line', { x1: x(tk.t), x2: x(tk.t), y1: top, y2: top + h, stroke: C.grid, 'stroke-width': 1 }, gridG);
    }
    function yTitle(top, h, s) {
      const cy = top + h / 2;
      txt(svg, 16, cy, s, { 'text-anchor': 'middle', 'font-size': 11.5, fill: C.axis, transform: 'rotate(-90 16 ' + cy + ')' });
    }

    // ===== panel 1: log nav
    {
      const top = tops[0], h = hs[0], g = panelG[0];
      frame(top, h);
      let lo = Infinity, hi = -Infinity;
      for (const v of nav) { if (v < lo) lo = v; if (v > hi) hi = v; }
      const y = logScale(lo * 0.9, hi * 1.12, top + h, top);
      for (const v of logTicks(lo * 0.9, hi * 1.12)) {
        el('line', { x1: L, x2: R, y1: y(v), y2: y(v), stroke: C.grid }, g);
        txt(g, L - 8, y(v) + 3.5, fmtMult(v), { 'text-anchor': 'end', fill: C.axis, 'font-size': 10.5 });
      }
      const pts = []; for (let i = 0; i < n; i++) pts.push([x(t[i]), y(nav[i])]);
      el('path', { d: pathOf(pts) + 'L' + pts[n - 1][0].toFixed(1) + ' ' + (top + h) + 'L' + pts[0][0].toFixed(1) + ' ' + (top + h) + 'Z', fill: C.blueBg, stroke: 'none' }, g);
      // constant-CAGR reference line
      el('line', { x1: pts[0][0], y1: y(1), x2: pts[n - 1][0], y2: y(nav[n - 1]), stroke: '#9ca3af', 'stroke-width': 1, 'stroke-dasharray': '5 4', opacity: 0.8 }, g);
      el('path', { d: pathOf(pts), fill: 'none', stroke: C.blue, 'stroke-width': 1.4, 'stroke-linejoin': 'round' }, g);
      // end marker
      el('circle', { cx: pts[n - 1][0], cy: pts[n - 1][1], r: 2.6, fill: C.blue }, g);
      txt(g, pts[n - 1][0] + 7, pts[n - 1][1] + 4, fmtMult(nav[n - 1]), { 'font-size': 12, 'font-weight': 600, fill: '#1f2937' });
      // CAGR badge: place over the emptier top quadrant
      const q = Math.max(1, Math.floor(n / 4));
      let a1 = 0, a2 = 0; for (let i = 0; i < q; i++) a1 += Math.log(nav[i]); for (let i = n - q; i < n; i++) a2 += Math.log(nav[i]);
      const left = a1 < a2;
      const cagrS = isFinite(A.cagr) ? 'CAGR ' + pct(A.cagr) : 'CAGR —';
      txt(g, left ? L + 14 : R - 14, top + 34, cagrS, { 'text-anchor': left ? 'start' : 'end', 'font-size': 24, 'font-weight': 700, fill: A.cagr >= 0 ? C.up : C.down, opacity: 0.42 });
      txt(g, left ? L + 14 : R - 14, top + 52, '区间 ' + pct(A.total) + ' · ' + (A.days / 365.25).toFixed(1) + ' 年', { 'text-anchor': left ? 'start' : 'end', 'font-size': 11, fill: C.axis, opacity: 0.9 });
      yTitle(top, h, '净值倍数（对数）');
      A._y0 = y;
    }

    // ===== panel 2: drawdown
    {
      const top = tops[1], h = hs[1], g = panelG[1];
      frame(top, h);
      let mn = 0; for (const v of dd) if (v < mn) mn = v;
      const ymin = Math.min(-0.1, Math.floor((mn - 0.03) * 10) / 10);
      const y = linScale(ymin, 0, top + h - 6, top + 8);
      const step = ymin < -0.8 ? 0.2 : 0.1;
      for (let v = 0; v >= ymin - 1e-9; v -= step) {
        el('line', { x1: L, x2: R, y1: y(v), y2: y(v), stroke: v === 0 ? '#9ca3af' : '#cbd5e1', 'stroke-dasharray': v === 0 ? null : '4 4' }, g);
        txt(g, L - 8, y(v) + 3.5, pct(v, 0, false), { 'text-anchor': 'end', fill: C.axis, 'font-size': 10.5 });
      }
      const pts = []; for (let i = 0; i < n; i++) pts.push([x(t[i]), y(dd[i])]);
      el('path', { d: pathOf(pts) + 'L' + pts[n - 1][0].toFixed(1) + ' ' + y(0).toFixed(1) + 'L' + pts[0][0].toFixed(1) + ' ' + y(0).toFixed(1) + 'Z', fill: C.downBg }, g);
      el('path', { d: pathOf(pts), fill: 'none', stroke: C.down, 'stroke-width': 1.2, 'stroke-linejoin': 'round' }, g);
      // major episodes: dashed peak→trough lines with duration
      const major = A.episodes.filter((e) => e.depth <= -0.2 && (t[e.trough] - t[e.peak]) >= 30).sort((a, b) => a.depth - b.depth).slice(0, 6);
      for (const ep of major) {
        const x1 = x(t[ep.peak]), x2 = x(t[ep.trough]), y1 = y(0), y2 = y(ep.depth);
        el('line', { x1, y1, x2, y2, stroke: '#e0565b', 'stroke-width': 1, 'stroke-dasharray': '4 3', opacity: 0.9 }, g);
        const lab = fmtDur(t[ep.trough] - t[ep.peak]);
        txt(g, (x1 + x2) / 2 + 6, (y1 + y2) / 2 + 3, lab, { 'font-size': 10.5, fill: '#c0392b', 'font-weight': 600 });
      }
      if (A.maxDD) {
        const ep = A.maxDD, cx = x(t[ep.trough]), cy = y(ep.depth);
        el('circle', { cx, cy, r: 3, fill: '#c0392b' }, g);
        const s = '最大回撤 ' + pct(ep.depth, 1, false);
        const w = textW(s, 11.5, 700) + 12, bh = 18;
        let bx = cx + 10; if (bx + w > R - 4) bx = cx - 10 - w; bx = clamp(bx, L + 2, R - w - 2);
        const by = clamp(cy - 30, top + 4, top + h - bh - 4);
        el('rect', { x: bx, y: by, width: w, height: bh, rx: 4, fill: 'rgba(255,228,230,0.95)', stroke: '#f1a7ab' }, g);
        txt(g, bx + 6, by + 13, s, { 'font-size': 11.5, 'font-weight': 700, fill: '#b91c1c' });
      }
      el('circle', { cx: pts[n - 1][0], cy: pts[n - 1][1], r: 2.6, fill: C.down }, g);
      txt(g, pts[n - 1][0] + 7, pts[n - 1][1] + 4, pct(dd[n - 1], 1, false), { 'font-size': 12, 'font-weight': 600, fill: '#1f2937' });
      yTitle(top, h, '回撤幅度（%）');
      A._y1 = y;
    }

    // ===== panel 3: bull/bear phases
    {
      const top = tops[2], h = hs[2], g = panelG[2];
      frame(top, h);
      let lo = -0.05, hi = 0.05;
      for (const p of phases) { if (p.lo < lo) lo = p.lo; if (p.hi > hi) hi = p.hi; }
      const dense = phases.length > 14;
      const padT = dense ? 104 : 60, padB = dense ? 98 : 54;
      // 涨幅跨度极大（>300%）时改用 log(1+r) 坐标，使 -50% 与 +100% 等距，避免大牛市把其余阶段压成一条线
      const useLog = hi > 3;
      const tr = useLog ? (r) => Math.log(1 + Math.max(r, -0.97)) : (r) => r;
      const yl = linScale(tr(lo), tr(hi), top + h - padB, top + padT);
      const y = (r) => yl(tr(r));
      // ticks
      el('line', { x1: L, x2: R, y1: y(0), y2: y(0), stroke: '#6b7280', 'stroke-width': 1 }, g);
      txt(g, L - 8, y(0) + 3.5, '0%', { 'text-anchor': 'end', fill: C.axis, 'font-size': 10.5 });
      let posC, negC;
      if (useLog) { posC = [0.25, 0.5, 1, 2, 3, 5, 10, 20, 50, 100, 200, 500]; negC = [-0.25, -0.5, -0.75, -0.9]; }
      else {
        const st = niceStep(hi, 4); posC = []; for (let v = st; v <= hi + 1e-9; v += st) posC.push(v);
        const ns = (y(-0.25) - y(0)) >= 15 ? 0.25 : 0.5; negC = []; for (let v = -ns; v >= lo - 1e-9; v -= ns) negC.push(v);
      }
      const ticks = [];
      let lastY = y(0);
      for (const v of posC) { if (v > hi) break; if (lastY - y(v) >= 16) { ticks.push(v); lastY = y(v); } }
      lastY = y(0);
      for (const v of negC) { if (v < lo) break; if (y(v) - lastY >= 16) { ticks.push(v); lastY = y(v); } }
      for (const v of ticks) {
        el('line', { x1: L, x2: R, y1: y(v), y2: y(v), stroke: C.grid, 'stroke-dasharray': '3 3' }, g);
        txt(g, L - 8, y(v) + 3.5, pct(v, 0), { 'text-anchor': 'end', fill: C.axis, 'font-size': 10.5 });
      }
      // phase curves
      const specs = [];
      const many = phases.length;
      for (let pi = 0; pi < phases.length; pi++) {
        const p = phases[pi];
        const base = A.c[p.s];
        const pts = [];
        for (let i = p.s; i <= p.e; i++) pts.push([x(t[i]), y(A.c[i] / base - 1)]);
        const col = p.bull ? C.up : C.down, bg = p.bull ? C.upBg : C.downBg;
        el('path', { d: pathOf(pts) + 'L' + pts[pts.length - 1][0].toFixed(1) + ' ' + y(0).toFixed(1) + 'L' + pts[0][0].toFixed(1) + ' ' + y(0).toFixed(1) + 'Z', fill: bg }, g);
        el('path', { d: pathOf(pts), fill: 'none', stroke: col, 'stroke-width': 1.2, 'stroke-linejoin': 'round' }, g);
        // label spec: the denser the chart, the more we hide short/minor phases
        let show = true;
        if (many > 40) show = p.days >= 240 || Math.abs(p.ret) >= 0.8;
        else if (many > 24) show = p.days >= 150 || Math.abs(p.ret) >= 0.5;
        else if (many > 16) show = p.days >= 60 || Math.abs(p.ret) >= 0.35;
        if (p.ongoing || pi === 0) show = true;
        if (!show) continue;
        const lines = [{ s: fmtYM(t[p.e]) + (p.ongoing ? ' 至今' : ''), w: 500 }, { s: fmtDur(p.days) + ' · ' + pct(p.ret), w: 700 }];
        if (p.ann != null) lines.push({ s: pct(p.ann) + '/yr', w: 500 });
        const size = 10.5, lh = 12.5;
        const w = Math.max.apply(null, lines.map((l) => textW(l.s, size, l.w))) + 10, bh = lines.length * lh + 6;
        const ax = x(t[p.e]);
        const ay = p.bull ? y(p.hi) : y(p.lo);
        specs.push({ p, lines, w, h: bh, x: clamp(ax - w / 2, L + 2, R - w - 2), ay, up: p.bull, col, size, lh });
      }
      // place labels with collision avoidance (per side): push away from the zero line,
      // then try horizontal shifts, finally accept a clamped position
      const placed = [];
      for (const up of [true, false]) {
        const side = specs.filter((s) => s.up === up).sort((a, b) => a.x - b.x);
        for (const s of side) {
          const minY = top + 2, maxY = top + h - s.h - 2;
          const yInit = up ? s.ay - 7 - s.h : s.ay + 7;
          const free = (bx, by) => by >= minY && by <= maxY && bx >= L + 2 && bx + s.w <= R - 2 && !placed.some((b) => rectsOverlap({ x: bx, y: by, w: s.w, h: s.h }, b, 2));
          let yy = yInit, pos = null;
          for (let iter = 0; iter < 12; iter++) {
            const hit = placed.filter((b) => rectsOverlap({ x: s.x, y: yy, w: s.w, h: s.h }, b, 2));
            if (!hit.length) break;
            yy = up ? Math.min.apply(null, hit.map((b) => b.y)) - s.h - 3 : Math.max.apply(null, hit.map((b) => b.y + b.h)) + 3;
          }
          if (free(s.x, yy)) pos = { x: s.x, y: yy };
          if (!pos) {
            const levels = [yInit, clamp(yy, minY, maxY)];
            outer: for (const lv of levels) for (let dx = 4; dx <= 260; dx += 4) {
              if (free(s.x + dx, lv)) { pos = { x: s.x + dx, y: lv }; break outer; }
              if (free(s.x - dx, lv)) { pos = { x: s.x - dx, y: lv }; break outer; }
            }
          }
          if (!pos) pos = { x: s.x, y: clamp(yy, minY, maxY) };
          s.x = pos.x; s.y = pos.y;
          placed.push({ x: s.x, y: s.y, w: s.w, h: s.h });
        }
      }
      for (const s of specs) {
        el('rect', { x: s.x, y: s.y, width: s.w, height: s.h, rx: 3, fill: 'rgba(255,255,255,0.93)', stroke: s.col, 'stroke-opacity': 0.55 }, g);
        // small connector from box to anchor
        const cx = clamp(x(t[s.p.e]), s.x + 4, s.x + s.w - 4);
        el('line', { x1: cx, y1: s.up ? s.y + s.h : s.y, x2: x(t[s.p.e]), y2: s.ay, stroke: s.col, 'stroke-width': 0.8, opacity: 0.6 }, g);
        s.lines.forEach((l, i) => txt(g, s.x + s.w / 2, s.y + 3 + s.lh * (i + 1) - 2.5, l.s, { 'text-anchor': 'middle', 'font-size': s.size, 'font-weight': l.w, fill: s.col }));
      }
      yTitle(top, h, useLog ? '牛熊阶段涨跌幅（对数）' : '牛熊阶段涨跌幅');
      A._y2 = y;
    }

    // x axis labels (bottom)
    for (const tk of xt) txt(svg, x(tk.t), H - M.b + 18, tk.label, { 'text-anchor': 'middle', 'font-size': 11.5, fill: C.text });

    // ===== hover layer
    const hover = el('g', { style: 'display:none' }, svg);
    const vline = el('line', { y1: tops[0], y2: tops[2] + hs[2], stroke: '#6b7280', 'stroke-width': 1, 'stroke-dasharray': '3 3' }, hover);
    const dots = [0, 1, 2].map(() => el('circle', { r: 3.5, fill: '#fff', stroke: '#111827', 'stroke-width': 1.5 }, hover));
    const overlay = el('rect', { x: L, y: tops[0], width: plotW, height: tops[2] + hs[2] - tops[0], fill: 'transparent', style: 'cursor:crosshair' }, svg);
    const tip = $('tooltip');
    overlay.addEventListener('mousemove', (ev) => {
      const rect = svg.getBoundingClientRect();
      const sx = (ev.clientX - rect.left) * (W / rect.width);
      const tt = x.invert(sx);
      let lo = 0, hi = n - 1, i = 0;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (t[mid] <= tt) { i = mid; lo = mid + 1; } else hi = mid - 1; }
      if (i < n - 1 && Math.abs(t[i + 1] - tt) < Math.abs(t[i] - tt)) i++;
      const px = x(t[i]);
      hover.style.display = '';
      vline.setAttribute('x1', px); vline.setAttribute('x2', px);
      dots[0].setAttribute('cx', px); dots[0].setAttribute('cy', A._y0(nav[i]));
      dots[1].setAttribute('cx', px); dots[1].setAttribute('cy', A._y1(dd[i]));
      const ph = phases.find((p) => i >= p.s && i <= p.e) || phases[phases.length - 1];
      const phRet = ph ? A.c[i] / A.c[ph.s] - 1 : 0;
      dots[2].setAttribute('cx', px); dots[2].setAttribute('cy', A._y2(phRet));
      tip.innerHTML =
        '<div class="d">' + fmtDate(t[i]) + '</div>' +
        '<div class="row"><span>收盘</span><span>' + fmtPrice(A.c[i]) + '</span></div>' +
        '<div class="row"><span>净值倍数</span><span>' + fmtMult(nav[i]) + '</span></div>' +
        '<div class="row"><span>回撤</span><span class="down">' + pct(dd[i], 1, false) + '</span></div>' +
        (ph ? '<div class="row"><span>' + (ph.bull ? '<span class="up">牛市</span>' : '<span class="down">熊市</span>') + ' 自 ' + fmtDate(t[ph.s]) + '</span><span class="' + cls(phRet) + '">' + pct(phRet) + '</span></div>' : '');
      tip.hidden = false;
      const hostRect = host.getBoundingClientRect();
      const tipW = tip.offsetWidth || 180;
      let left = ev.clientX - hostRect.left + 14; if (left + tipW > hostRect.width - 4) left = ev.clientX - hostRect.left - tipW - 14;
      tip.style.left = left + 'px';
      tip.style.top = clamp(ev.clientY - hostRect.top - 20, 0, hostRect.height - 120) + 'px';
    });
    overlay.addEventListener('mouseleave', () => { hover.style.display = 'none'; tip.hidden = true; });
    return svg;
  }

  // ------------------------------------------------------------------ DOM render
  function renderKPIs(A, meta, all) {
    const last = all[all.length - 1], prev = all.length > 1 ? all[all.length - 2] : null;
    const chg = prev ? last.c / prev.c - 1 : 0;
    const tag = marketTag(meta);
    const ep = A.maxDD;
    const lifeDays = last.t - all[0].t;
    const lifeCagr = lifeDays >= 20 ? Math.pow(last.c / all[0].c, 365.25 / lifeDays) - 1 : NaN;
    const cards = [
      { k: esc(meta.code) + ' · ' + esc(tag.txt) + ' · 最新收盘 ' + fmtDate(last.t), v: '<span class="' + cls(chg) + '">' + fmtPrice(last.c) + ' <small>' + pct(chg, 2) + '</small></span>', s: '<b>' + esc(meta.name) + '</b> · ' + meta.fqtName + ' · 上市首日 ' + fmtDate(all[0].t), head: true },
      { k: '区间总收益', v: '<span class="' + cls(A.total) + '">' + pct(A.total) + '</span>', s: fmtDate(A.t[0]) + ' → ' + fmtDate(A.t[A.n - 1]) },
      { k: '年化收益 CAGR', v: '<span class="' + cls(A.cagr) + '">' + pct(A.cagr) + '</span>', s: (A.days / 365.25).toFixed(1) + ' 年 · 终值 ' + fmtMult(A.nav[A.n - 1]) },
      { k: '最大回撤', v: '<span class="down">' + (ep ? pct(ep.depth, 1, false) : '0%') + '</span>', s: ep ? fmtDate(A.t[ep.peak]) + ' → ' + fmtDate(A.t[ep.trough]) : '区间内无回撤' },
      { k: '最大回撤历时', v: ep ? fmtDurCN(A.t[ep.trough] - A.t[ep.peak]) : '—', s: ep ? (ep.end != null ? '修复用时 ' + fmtDurCN(A.t[ep.end] - A.t[ep.trough]) + '（' + fmtDate(A.t[ep.end]) + '）' : '尚未修复（已 ' + fmtDurCN(A.t[A.n - 1] - A.t[ep.trough]) + '）') : '' },
      { k: '当前回撤（距区间前高）', v: '<span class="' + (A.curDD < 0 ? 'down' : 'flat') + '">' + pct(A.curDD, 1, false) + '</span>', s: '前高 ' + fmtDate(A.t[A.curPeakIdx]) + ' · ' + fmtPrice(A.c[A.curPeakIdx]) },
      { k: '年化波动率', v: pct(A.vol, 1, false), s: '日收益标准差 × √242' },
      { k: '牛熊阶段', v: '<span class="up">' + A.phases.filter((p) => p.bull).length + ' 牛</span> / <span class="down">' + A.phases.filter((p) => !p.bull).length + ' 熊</span>', s: '阈值 ' + Math.round(meta.th * 100) + '% · ' + BASIS_NAME[A.basis] + ' · 当前' + (A.phases.length && A.phases[A.phases.length - 1].bull ? '牛市' : '熊市') + '阶段' },
      { k: '上市至今年化', v: '<span class="' + cls(lifeCagr) + '">' + pct(lifeCagr) + '</span>', s: ((last.t - all[0].t) / 365.25).toFixed(1) + ' 年 · 累计 ' + pct(last.c / all[0].c - 1) },
    ];
    $('kpis').innerHTML = cards.map((c) => '<div class="kpi' + (c.head ? ' head' : '') + '"><div class="k">' + c.k + '</div><div class="v">' + c.v + '</div><div class="s">' + c.s + '</div></div>').join('');
  }

  function renderHorizons(rows, fqtName) {
    const html = [];
    rows.forEach((row, ri) => {
      if (ri) html.push('<div class="ret-sep"></div>');
      for (const c of row) {
        const k = c.v == null ? 'na' : cls(c.v);
        html.push('<div class="ret-cell ' + k + '" title="' + esc(c.s) + '"><div class="k">' + esc(c.k) + '</div><div class="v">' + (c.v == null ? '—' : pct(c.v)) + '</div><div class="s">' + esc(c.s) + '</div></div>');
      }
    });
    $('retGrid').innerHTML = html.join('');
    $('tableNote').textContent = '（基于最新收盘 · ' + fqtName + ' · 红涨绿跌）';
  }

  function renderYears(ys) {
    $('yearChips').innerHTML = ys.map((y) => '<div class="chip ' + cls(y.v) + '" title="' + (y.fromListing ? '上市首年（自上市首日）' : '') + '"><div class="k">' + y.y + (y.fromListing ? '*' : '') + '</div><div class="v">' + pct(y.v) + '</div></div>').join('');
  }

  function renderStats(st) {
    const head = '<tr><th>周期</th><th>样本数</th><th>上涨占比</th><th>平均涨跌</th><th>中位数</th><th>最大单期上涨</th><th>最大单期下跌</th></tr>';
    const rows = st.map((s) => s.n ? '<tr><td>' + s.name + '</td><td>' + s.n + '</td><td>' + pct(s.win, 1, false) + '</td><td class="' + cls(s.mean) + '">' + pct(s.mean, 2) + '</td><td class="' + cls(s.med) + '">' + pct(s.med, 2) + '</td><td class="up">' + pct(s.max) + '</td><td class="down">' + pct(s.min) + '</td></tr>'
      : '<tr><td>' + s.name + '</td><td colspan="6" class="muted">样本不足</td></tr>').join('');
    $('statTable').innerHTML = head + rows;
  }

  function renderPhases(A, th) {
    const head = '<tr><th>#</th><th>阶段</th><th>开始</th><th>结束</th><th>历时</th><th>起点价</th><th>终点价</th><th>涨跌幅</th><th>年化</th></tr>';
    const rows = A.phases.map((p, i) => '<tr class="' + (p.bull ? 'bull' : 'bear') + '"><td>' + (i + 1) + '</td><td>' + (p.bull ? '牛市' : '熊市') + (p.ongoing ? '（进行中）' : (i === 0 ? '（截断）' : '')) + '</td><td>' + fmtDate(A.t[p.s]) + '</td><td>' + fmtDate(A.t[p.e]) + '</td><td>' + fmtDurCN(p.days) + '</td><td>' + fmtPrice(A.c[p.s]) + '</td><td>' + fmtPrice(A.c[p.e]) + '</td><td class="' + cls(p.ret) + '">' + pct(p.ret) + '</td><td class="' + cls(p.ann) + '">' + (p.ann == null ? '—' : pct(p.ann)) + '</td></tr>').join('');
    $('phaseTable').innerHTML = head + rows;
    const bulls = A.phases.filter((p) => p.bull && !p.ongoing && !p.first), bears = A.phases.filter((p) => !p.bull && !p.ongoing && !p.first);
    const avg = (arr, f) => arr.length ? arr.reduce((a, p) => a + f(p), 0) / arr.length : null;
    $('phaseNote').textContent = '（阈值 ' + Math.round(th * 100) + '% · 以' + BASIS_NAME[A.basis] + '识别转折、日收盘定位峰谷' +
      (bulls.length ? ' · 完整牛市均值 ' + pct(avg(bulls, (p) => p.ret)) + ' / ' + fmtDurCN(avg(bulls, (p) => p.days)) : '') +
      (bears.length ? ' · 完整熊市均值 ' + pct(avg(bears, (p) => p.ret)) + ' / ' + fmtDurCN(avg(bears, (p) => p.days)) : '') + '）';
  }

  // ------------------------------------------------------------------ state & flow
  const FQT_NAME = { '0': '不复权', '1': '前复权', '2': '后复权' };
  const BASIS_NAME = { D: '日收盘', W: '周收盘', M: '月收盘' };
  const state = { sym: null, range: '10y', fqt: '1', th: 0.2, basis: 'auto', data: null, A: null };

  function setStatus(msg, kind) { const s = $('status'); s.textContent = msg || ''; s.className = 'status' + (kind ? ' ' + kind : ''); s.hidden = !msg; }
  function show(ids, on) { ids.forEach((id) => { $(id).hidden = !on; }); }

  function sliceByRange(bars, range) {
    if (range === 'all') return bars;
    const yrs = parseInt(range, 10);
    const lastT = bars[bars.length - 1].t;
    const i = idxOnOrAfter(bars, addMonths(lastT, -12 * yrs));
    return bars.slice(Math.max(0, Math.min(i, bars.length - 2)));
  }

  function writeHash() {
    if (!state.sym) return;
    const h = '#s=' + state.sym.market + '.' + state.sym.code + '&r=' + state.range + '&fqt=' + state.fqt + '&th=' + state.th + (state.basis !== 'auto' ? '&b=' + state.basis : '');
    try { history.replaceState(null, '', h); } catch (e) { location.hash = h; }
  }
  function readHash() {
    const m = {};
    location.hash.replace(/^#/, '').split('&').forEach((kv) => { const p = kv.split('='); if (p[0]) m[p[0]] = decodeURIComponent(p[1] || ''); });
    return m;
  }
  // 应用 hash 中的参数到控件与状态；返回要加载的标的（或 null）
  function applyHashParams(h) {
    if (h.r && $('rangeSeg').querySelector('[data-range="' + h.r + '"]')) { state.range = h.r; $('rangeSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.range === h.r)); }
    if (h.fqt && FQT_NAME[h.fqt]) { state.fqt = h.fqt; $('fqt').value = h.fqt; }
    if (h.th && !isNaN(parseFloat(h.th))) { state.th = parseFloat(h.th); const opt = Array.from($('threshold').options).find((o) => Math.abs(parseFloat(o.value) - state.th) < 1e-9); if (opt) $('threshold').value = opt.value; }
    state.basis = h.b && BASIS_NAME[h.b] ? h.b : 'auto'; $('basis').value = state.basis;
    if (h.s && /^[01]\.\d{6}$/.test(h.s)) {
      const it = BY_KEY.get(h.s);
      return it ? { code: it.code, name: it.name, market: it.market, type: it.type } : { code: h.s.slice(2), name: '', market: +h.s[0], type: 'S' };
    }
    return null;
  }

  function applyView() {
    const d = state.data; if (!d || d.bars.length < 2) return;
    const view = sliceByRange(d.bars, state.range);
    const A = analyze(view, state.th, state.basis);
    state.A = A;
    const meta = Object.assign({}, state.sym, { name: d.name || state.sym.name, fqtName: FQT_NAME[state.fqt], th: state.th });
    renderKPIs(A, meta, d.bars);
    renderChart($('chart'), A, meta);
    renderHorizons(computeHorizons(d.bars, A), meta.fqtName);
    renderYears(yearlyReturns(d.bars));
    renderStats(periodStats(view));
    renderPhases(A, state.th);
    show(['kpis', 'chartCard', 'tableCard', 'yearCard', 'statCard', 'phaseCard'], true);
    $('btnPng').disabled = false; $('btnLink').disabled = false;
    document.title = meta.name + ' ' + meta.code + ' · 历史表现看板';
    writeHash();
  }

  async function loadSymbol(sym) {
    state.sym = sym;
    $('search').value = sym.name ? sym.name + ' (' + sym.code + ')' : sym.code;
    setStatus('正在拉取 ' + (sym.name || sym.code) + ' 的全部日线数据…', 'loading');
    try {
      let d = await fetchKlines(sym.market, sym.code, state.fqt);
      if (d.dropped > 0 && state.fqt === '1') {
        // 前复权出现非正价格：自动切换为后复权
        state.fqt = '2'; $('fqt').value = '2';
        d = await fetchKlines(sym.market, sym.code, '2');
        setStatus('前复权价格存在非正值，已自动切换为后复权。', '');
      } else setStatus('');
      if (d.bars.length < 2) { setStatus('该代码的历史数据不足（少于 2 个交易日）。', 'error'); return; }
      if (!sym.name) sym.name = d.name;
      state.data = d;
      applyView();
    } catch (e) {
      setStatus('拉取失败：' + (e && e.message ? e.message : e) + '。请检查网络（需要能访问 push2his.eastmoney.com），稍后重试。', 'error');
    }
  }

  // ------------------------------------------------------------------ search UI
  function bindSearch() {
    const input = $('search'), box = $('suggest');
    let items = [], active = -1, timer = null, seq = 0;
    function render() {
      if (!items.length) { box.hidden = true; return; }
      box.innerHTML = items.map((it, i) => {
        const tag = marketTag(it);
        return '<div class="item' + (i === active ? ' active' : '') + '" data-i="' + i + '" role="option"><span class="code">' + esc(it.code) + '</span><span class="name">' + esc(it.name) + '</span><span class="py">' + esc(it.py) + '</span><span class="tag ' + tag.cls + '">' + tag.txt + '</span></div>';
      }).join('');
      box.hidden = false;
    }
    function pick(i) {
      const it = items[i]; if (!it) return;
      box.hidden = true; items = []; active = -1;
      loadSymbol({ code: it.code, name: it.name, market: it.market, type: it.type });
    }
    async function update() {
      const q = input.value.trim();
      const my = ++seq;
      if (!q) { items = []; render(); return; }
      items = searchLocal(q); active = items.length ? 0 : -1; render();
      if (!items.length && q.length >= 2 && !/^\d{1,5}$/.test(q)) {
        box.innerHTML = '<div class="empty">本地列表无结果，正在查询东方财富…</div>'; box.hidden = false;
        try {
          const r = await searchRemote(q);
          if (my !== seq) return;
          items = r; active = r.length ? 0 : -1;
          if (!r.length) { box.innerHTML = '<div class="empty">未找到匹配的 A 股 / ETF。可直接输入 6 位代码回车。</div>'; box.hidden = false; }
          else render();
        } catch (e) { if (my === seq) { box.innerHTML = '<div class="empty">未找到；联想接口不可用。</div>'; } }
      }
    }
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(update, 120); });
    input.addEventListener('focus', () => { input.select(); if (items.length) box.hidden = false; });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { if (items.length) { active = (active + 1) % items.length; render(); } e.preventDefault(); }
      else if (e.key === 'ArrowUp') { if (items.length) { active = (active - 1 + items.length) % items.length; render(); } e.preventDefault(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (items.length && active >= 0) pick(active);
        else {
          const q = input.value.trim().toLowerCase().replace(/^(sh|sz|bj)/, '');
          if (/^\d{6}$/.test(q)) { const it = BY_KEY.get(inferMarket(q) + '.' + q) || BY_KEY.get((1 - inferMarket(q)) + '.' + q); loadSymbol(it ? { code: it.code, name: it.name, market: it.market, type: it.type } : { code: q, name: '', market: inferMarket(q), type: 'S' }); box.hidden = true; }
        }
      }
      else if (e.key === 'Escape') { box.hidden = true; }
    });
    box.addEventListener('mousedown', (e) => { const it = e.target.closest('.item'); if (it) { e.preventDefault(); pick(+it.dataset.i); } });
    document.addEventListener('click', (e) => { if (!e.target.closest('.search-wrap')) box.hidden = true; });
  }

  // ------------------------------------------------------------------ controls
  function bindControls() {
    $('rangeSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      $('rangeSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      state.range = b.dataset.range; applyView();
    });
    $('fqt').addEventListener('change', (e) => { state.fqt = e.target.value; if (state.sym) loadSymbol(state.sym); });
    $('threshold').addEventListener('change', (e) => { state.th = parseFloat(e.target.value); applyView(); });
    $('basis').addEventListener('change', (e) => { state.basis = e.target.value; applyView(); });
    $('btnLink').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(location.href); $('btnLink').textContent = '已复制'; setTimeout(() => ($('btnLink').textContent = '复制链接'), 1200); } catch (e) { prompt('复制下面的链接：', location.href); }
    });
    $('btnPng').addEventListener('click', exportPNG);
    let rt = null;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (state.A) applyView(); }, 160); });
  }

  function exportPNG() {
    const svg = $('chart').querySelector('svg'); if (!svg) return;
    const W = +svg.getAttribute('width'), H = +svg.getAttribute('height');
    const xml = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const scale = 2, cv = document.createElement('canvas');
      cv.width = W * scale; cv.height = H * scale;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      const a = document.createElement('a');
      a.download = state.sym.code + '_' + (state.sym.name || '') + '_' + fmtDate(state.A.t[state.A.n - 1]) + '.png';
      a.href = cv.toDataURL('image/png');
      a.click();
    };
    img.onerror = () => { URL.revokeObjectURL(url); alert('导出失败：当前浏览器不支持 SVG 转图。可尝试使用系统截图。'); };
    img.src = url;
  }

  // ------------------------------------------------------------------ init
  function init() {
    $('listDate').textContent = (window.STOCK_LIST_UPDATED || '—') + '（' + LIST.filter((x) => x.type === 'S').length + ' 只股票 / ' + LIST.filter((x) => x.type === 'E').length + ' 只ETF）';
    bindSearch(); bindControls();
    let sym = applyHashParams(readHash());
    if (!sym) {
      const it = BY_KEY.get('1.510300') || LIST[0];
      sym = it ? { code: it.code, name: it.name, market: it.market, type: it.type } : null;
    }
    if (!LIST.length) setStatus('股票列表（stocks.js）未加载：搜索仅支持直接输入 6 位代码。', 'error');
    else setStatus('');
    if (sym) loadSymbol(sym);
    // 用户手动修改/粘贴 URL 中的 hash 时同步刷新
    window.addEventListener('hashchange', () => {
      const cur = state.sym ? '#s=' + state.sym.market + '.' + state.sym.code + '&r=' + state.range + '&fqt=' + state.fqt + '&th=' + state.th + (state.basis !== 'auto' ? '&b=' + state.basis : '') : '';
      if (location.hash === cur) return;
      const s2 = applyHashParams(readHash());
      if (s2) loadSymbol(s2); else if (state.data) applyView();
    });
  }

  // Node 环境（批量脚本）：只导出计算函数，不触碰 DOM
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { analyze, computeHorizons, periodStats, yearlyReturns, segmentPhases, zigzagPivots, parseYMD, fmtDate, fmtYM, pct, fmtDur, fmtDurCN, fmtMult, cleanName, addMonths, idxOnOrAfter, idxOnOrBefore, ymd, tToDate };
    return;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
