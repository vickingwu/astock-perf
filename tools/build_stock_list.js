#!/usr/bin/env node
/**
 * 生成 stocks.js：全部 A 股（沪市主板 / 科创板 / 深市主板 / 创业板 / 北交所）+ 全部场内 ETF 的代码表。
 *
 * 用法：
 *   npm install            # 安装 pinyin-pro（仅构建时需要，页面本身零依赖）
 *   node tools/build_stock_list.js
 *
 * 数据来源：东方财富 clist 接口（每页最多 100 条，脚本自动翻页）。
 * 输出格式：window.STOCK_LIST = [[code, name, market(0=深/北, 1=沪), type('S'=股票,'E'=ETF), pinyinInitials], ...]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

let pinyinFn = null;
try {
  const { pinyin } = require('pinyin-pro');
  pinyinFn = (s) => pinyin(s, { pattern: 'first', toneType: 'none', type: 'array' }).join('').toLowerCase();
} catch (e) {
  console.warn('[warn] pinyin-pro 未安装，列表将不包含拼音首字母（npm install 后重试可补全）');
}

const UT = 'bd1d9ddb04089700cf9c27f6f7426281';
const SOURCES = [
  // A 股：深主板 / 创业板 / 沪主板 / 科创板 / 北交所
  { type: 'S', fs: 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048' },
  // 场内 ETF：股票型 / 债券型 / 商品型 / 货币型 / 跨境型
  { type: 'E', fs: 'b:MK0021,b:MK0022,b:MK0023,b:MK0024,b:MK0827' },
];

function getJSON(url, retries = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' }, timeout: 20000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('JSON parse failed: ' + body.slice(0, 120))); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => {
      if (retries > 0) setTimeout(() => getJSON(url, retries - 1).then(resolve, reject), 800);
      else reject(err);
    });
  });
}

async function fetchAll(fsParam) {
  const out = [];
  let page = 1;
  let total = Infinity;
  while (out.length < total) {
    const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=${page}&pz=100&po=1&np=1&ut=${UT}&fltt=2&invt=2&fid=f12&fields=f12,f13,f14&fs=${encodeURIComponent(fsParam)}`;
    const j = await getJSON(url);
    if (!j || !j.data || !Array.isArray(j.data.diff)) throw new Error('unexpected response on page ' + page);
    total = j.data.total;
    out.push(...j.data.diff);
    process.stdout.write(`\r  page ${page}  ${out.length}/${total}`);
    if (j.data.diff.length === 0) break;
    page++;
  }
  process.stdout.write('\n');
  return out;
}

(async () => {
  const rows = [];
  const seen = new Set();
  for (const src of SOURCES) {
    console.log(`fetching ${src.type === 'S' ? 'A股' : 'ETF'} ...`);
    const list = await fetchAll(src.fs);
    for (const it of list) {
      const code = String(it.f12);
      const key = `${it.f13}.${code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const name = String(it.f14).trim();
      rows.push([code, name, Number(it.f13), src.type, pinyinFn ? pinyinFn(name.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '')) : '']);
    }
  }
  rows.sort((a, b) => (a[3] === b[3] ? a[0].localeCompare(b[0]) : a[3] === 'S' ? -1 : 1));

  const today = new Date().toISOString().slice(0, 10);
  const body = rows.map((r) => JSON.stringify(r)).join(',\n');
  const js = `// 自动生成，请勿手改。生成命令：node tools/build_stock_list.js\n` +
    `// 字段：[代码, 名称, 市场(0=深/北 1=沪), 类型(S=股票 E=ETF), 拼音首字母]\n` +
    `window.STOCK_LIST_UPDATED = "${today}";\n` +
    `window.STOCK_LIST = [\n${body}\n];\n`;
  const outPath = path.join(__dirname, '..', 'stocks.js');
  fs.writeFileSync(outPath, js, 'utf8');
  const nS = rows.filter((r) => r[3] === 'S').length;
  const nE = rows.length - nS;
  console.log(`done: ${nS} 只股票 + ${nE} 只ETF -> ${outPath} (${(js.length / 1024).toFixed(0)} KB)`);
})().catch((e) => {
  console.error('failed:', e.message);
  process.exit(1);
});
