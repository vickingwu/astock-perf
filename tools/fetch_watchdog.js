#!/usr/bin/env node
/* 看门狗：让 `tools/screen_all.js --fetch-only --source <src>` 脱离交互 shell 独立运行，并在其退出而队列尚未完成时自动重启续跑。
 * 用法（在仓库根目录；建议后台 / 分离启动，日志落文件）：
 *   node tools/fetch_watchdog.js --source eastmoney
 *   node tools/fetch_watchdog.js --source tencent
 *   macOS：nohup node tools/fetch_watchdog.js --source eastmoney > screen/out/watchdog_stdout.log 2>&1 &
 *   Windows PowerShell：Start-Process node -ArgumentList "tools\fetch_watchdog.js --source eastmoney" -WorkingDirectory <repo> -WindowStyle Hidden
 * 判定完成：screen/out/fetch_done_<source>.json 存在（由 screen_all.js 在全量队列完成、无限流类失败且非 --codes/--sample 子集时写入）。
 * Windows 东财模式下若已有一个同数据源拉数进程在跑（例如手工启动的那个），看门狗不重复启动，只等待其退出后再接管（macOS 跳过该检查）。
 * 每次（重）启动都写一行到 screen/out/fetch_tx.log（腾讯）/ screen/out/fetch.log（东财），同时写 screen/out/watchdog_<source>.log；
 * 子进程 stdout/stderr 追加到 screen/out/fetch_full_<source>.log。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'screen', 'out');
const args = process.argv.slice(2);
const si = args.indexOf('--source');
const SOURCE = si >= 0 ? String(args[si + 1] || '').toLowerCase() : 'eastmoney';
if (SOURCE !== 'tencent' && SOURCE !== 'eastmoney') { process.stderr.write('--source must be tencent or eastmoney\n'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const DONE = path.join(OUT, 'fetch_done_' + SOURCE + '.json');
const FETCH_LOG = path.join(OUT, SOURCE === 'tencent' ? 'fetch_tx.log' : 'fetch.log');
const WD_LOG = path.join(OUT, 'watchdog_' + SOURCE + '.log');
const CHILD_LOG = path.join(OUT, 'fetch_full_' + SOURCE + '.log');
const RESTART_DELAY_MS = 15000, POLL_MS = 60000;
const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function wlog(s) { const line = nowIso() + ' [watchdog ' + SOURCE + '] ' + s; try { fs.appendFileSync(WD_LOG, line + '\n', 'utf8'); } catch (e) { /* */ } try { fs.appendFileSync(FETCH_LOG, '=== ' + line + '\n', 'utf8'); } catch (e) { /* */ } }

// 是否已有同数据源的 screen_all --fetch-only 进程在跑（仅 Windows；其他平台返回 null = 不检查）
function otherFetcherRunning() {
  if (process.platform !== 'win32') return null;
  try {
    const ps = execFileSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | ForEach-Object { $_.ProcessId.ToString() + ' ' + $_.CommandLine }"], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    const lines = ps.split(/\r?\n/).filter((l) => /screen_all\.js/.test(l) && /--fetch-only/.test(l));
    const mine = lines.filter((l) => (SOURCE === 'tencent') === /--source\s+tencent/.test(l));
    return mine.length ? mine.map((l) => l.trim().slice(0, 80)) : null;
  } catch (e) { wlog('process check failed: ' + e.message); return null; }
}

let child = null, restarts = 0;
async function main() {
  wlog('started pid=' + process.pid + ' node=' + process.version + ' root=' + ROOT);
  for (;;) {
    if (fs.existsSync(DONE)) { wlog('done marker present (' + DONE + '), exiting'); return; }
    const other = otherFetcherRunning();
    if (other) { await sleep(POLL_MS); continue; } // 已有进程在跑，不重复启动
    const fd = fs.openSync(CHILD_LOG, 'a');
    const argv = [path.join(ROOT, 'tools', 'screen_all.js'), '--fetch-only', '--source', SOURCE];
    child = spawn(process.execPath, argv, { cwd: ROOT, stdio: ['ignore', fd, fd], windowsHide: true });
    const startedAt = Date.now();
    wlog((restarts ? 'RESTART #' + restarts : 'start') + ' child pid=' + child.pid + ' argv=' + argv.slice(1).join(' '));
    const code = await new Promise((resolve) => { child.on('exit', (c, sig) => resolve(c == null ? 'signal ' + sig : c)); child.on('error', (e) => { wlog('spawn error ' + e.message); resolve('spawn-error'); }); });
    try { fs.closeSync(fd); } catch (e) { /* */ }
    const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
    if (fs.existsSync(DONE)) { wlog('child exited code=' + code + ' after ' + mins + ' min; done marker present, exiting'); return; }
    restarts++;
    wlog('child exited code=' + code + ' after ' + mins + ' min without done marker; restarting in ' + RESTART_DELAY_MS / 1000 + 's (restart #' + restarts + ')');
    await sleep(RESTART_DELAY_MS);
  }
}
process.on('uncaughtException', (e) => { wlog('uncaughtException ' + (e && e.stack || e)); });
process.on('unhandledRejection', (e) => { wlog('unhandledRejection ' + (e && e.stack || e)); });
main().catch((e) => { wlog('FATAL ' + (e && e.stack || e)); process.exit(1); });
