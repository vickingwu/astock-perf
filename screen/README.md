# 全市场「牛熊逻辑」筛选（screen.html）

## 这是什么

基于看板引擎 `app.js`（`analyze()`：CAGR / 最大回撤 / ZigZag 牛熊划分）对 A 股全市场逐只计算牛熊指标并排名的离线筛选器。

- **股票池**：沪深主板 + 创业板 + 科创板（东财 clist 4 个分段：深主板 `m:0+t:6`、创业板 `m:0+t:80`、沪主板 `m:1+t:2`、科创板 `m:1+t:23`），每行带「板块」标签；不含北交所。剔除简称含 ST / 退、上市不足 5 年（以 K 线首末日计）、长期停牌（末根 K 线比上证晚 30 天以上）。
- **三个牛熊阈值**：30% / 40% / 50%；**三个区间**：上市至今、近10年（2016-10-15 起）、近5年（2021-10-15 起）。
- **版本 v3**（2026-10-21）：股票池由沪深主板扩为全市场；指标口径与 v2.1 相同。已提交产出的数据截止 **2026-10-15**（`--data-end 2026-10-15`）。
- **排名 / 百分位 / 综合分 / 分榜 / Pareto 在全部板块的入选个股内统一计算**；板块只是标签，`screen.html` 里勾选板块只筛选显示的行，不重新排名。
- **股票池行来源**：`screen/universe.json` 每行带 `f26From`（该行 clist 数据的拉取日）。已提交产出中主板行取自 2026-10-16 的 clist，创业板 / 科创板行取自 2026-10-21 的 clist（`report.md` 第 1 节「股票池行来源」）。若某些行带 `interim` 标记（clist 不可用时按代码表补入、只有代码 / 名称 / 市场，无上市日 / 行业 / 总市值），入选判定仍以 K 线首末日为准、指标与排名不受影响；clist 恢复后用 `--universe-only` 补全（见下「其他参数」）。

## 在线查看

- 筛选总表：<https://vickingwu.github.io/astock-perf/screen.html>（推送后约 1 分钟生效）
- 看板：<https://vickingwu.github.io/astock-perf/>（总表每行「名称」可点开对应个股的看板页）

## 产出文件

| 文件 | 说明 |
| --- | --- |
| `screen.html`（仓库根目录） | 零依赖单文件网页：区间 × 阈值 × 板块切换、列头排序、文本筛选、年化 × 最大回撤散点、每行链接看板。双击即可本地打开（file://），约 5 MB |
| `screen/report.md` | 中文报告：版本说明、概览、板块构成、各阈值综合榜 Top 50 与稳健 / 进攻 / 穿越榜 Top 20、同窗口榜、Pareto 前沿、跨阈值交集、合理性校验、口径与局限 |
| `screen/metrics_th30.csv` / `metrics_th40.csv` / `metrics_th50.csv` | 上市至今全部股票池（含剔除行与剔除原因）× 单阈值全部指标，UTF-8 BOM，Excel 直接打开；`板块` 为第 4 列 |
| `screen/metrics_w10y.csv` / `metrics_w5y.csv` | 同窗口榜：一行一只窗口入选个股，三阈值列组（`30%_` / `40%_` / `50%_` 前缀） |
| `screen/run_meta.json` | 本次运行参数与统计：版本、数据终点、股票池 / 入选 / 剔除计数（含按板块）、自检结果、20 只合理性校验股名次 |
| `screen/universe.json` | 股票池（代码、名称、市场、板块、上市日、行业、总市值、预剔除原因） |
| `screen/out/`（不入库，`.gitignore`） | 工作目录：`klines/` 日线缓存（每只一个 JSON，约 170 MB）、`results.json`（全部指标，约 85 MB）、`benchmarks.json`、拉数 / 计算日志、`screen_verify.log`、`verify.md` |

CSV / `report.md` 里的「看板」链接为 `../index.html#s=…`（相对 `screen/` 目录）；`screen.html` 里为 `./index.html#s=…`。

## 在 Mac 上运行

需要 Node.js ≥ 18（`node -v`），**不需要 `npm install`**（只用 Node 内置模块）。在仓库根目录执行：

```bash
# 1. 拉数：股票池 + 全部日线（首次约 3–4 小时拉 ~4,300 只；可随时 Ctrl+C，重跑只补缺的）
node tools/screen_all.js --fetch-only
#    或交给看门狗托管（子进程异常退出自动续跑，队列全部完成后自行退出）：
nohup node tools/fetch_watchdog.js --source eastmoney > screen/out/watchdog_stdout.log 2>&1 &
#    进度：tail -f screen/out/fetch.log   完成标志：screen/out/fetch_done_eastmoney.json

# 2. 计算 + 排名 → screen/metrics_*.csv, screen/run_meta.json, screen/out/results.json（约 1–3 分钟）
node tools/screen_all.js --compute-only                      # 数据终点 auto = 缓存上证末根 K 线日期
node tools/screen_all.js --compute-only --data-end 2026-10-15 # 或固定某个交易日（所有个股与指数都截到这一天）

# 3. 报告 + 网页 → screen/report.md, screen.html
node tools/screen_report.js

# 4. 校验（逐条 PASS/FAIL，写 screen/out/screen_verify.log；退出码 1 = 有 FAIL）
node tools/screen_verify.js --expect-data-end 2026-10-15
```

其他参数：

- `--sample N`（前 N 只 + 20 只校验股）、`--codes 600519,300015`：小样本试跑（不写 `fetch_done` 标记）。
- `--universe-only`：只处理股票池、不拉 K 线：首次运行拉取 4 个分段；已有 `screen/universe.json` 时只为临时行（`interim`）重拉所在分段、补上市日 / 行业 / 总市值并重算预剔除，**不改动其他行**（补全数据缺口的首选：`--universe-only` → `--compute-only` → `node tools/screen_report.js`）。
- `--refresh-universe`：用当日 clist 重建全部 4 个分段的所有行（含主板的名称 / 上市日），会随 ST 变动等改变预剔除与入选集合，只在确实要刷新整个股票池时使用。
- `--source tencent`：东财限流期间的回退数据源（腾讯 hfq 日线，缓存 `screen/out/klines_tx/`，口径与看板略有差异）。
- 刷新数据：删除 `screen/out/klines/` 里需要更新的文件（或整个目录）后重新 `--fetch-only`；缓存按文件存在即跳过，不会自动追加新 K 线。
- `tools/screen_all.js --data-end auto` 的规则：取缓存上证指数末根 K 线日期；若上海时间当天 15:05 之前运行且末根就是当天（盘中半截 K 线），自动取前一根。

## CONFIG 参数（`tools/screen_all.js` 顶部）

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `THRESHOLDS` | `[0.3, 0.4, 0.5]` | 牛熊阈值（自阶段极值反向运行 ≥ 阈值确认切换） |
| `MIN_YEARS` | `5` | 上市年限门槛（K 线首根 → 末根 ≥ 5 年；clist 上市日 f26 用于预剔除，少拉数） |
| `STALE_DAYS` | `30` | 末根 K 线比上证晚 30 天以上 → stale，剔除 |
| `DATA_END` | `'auto'` | 统一数据终点（`--data-end` 覆盖）；所有个股与指数丢弃其后的 K 线 |
| `WINDOWS` | 近10年 2016-10-15 / 近5年 2021-10-15 | 同窗口榜起点（终点 = DATA_END）；入选 = 上市至今入选且首根 K 线 ≤ 起点 |
| `FIRST_BEAR_DEPTH` | `'peak'` | 首段（截断）熊市深度：段内最高点 → 最低点（`'start'` = 段起点 → 最低点，v2 口径） |
| `MIN_CYCLES_FOR_RATE` | `2` | 牛市新高率 / 底部抬高率的最小样本数，不足记空 |
| `COMPOSITE_WEIGHTS` | 6 项各 1 | 综合分 = 年化、Calmar、最大回撤、熊市均跌、牛市新高率、滚动 5 年 P10 的百分位加权平均（空项不计） |
| `BOARDS` | 稳健 / 进攻 / 穿越 | 分榜：稳健 = 熊市均跌 + 最大回撤；进攻 = 年化 + 牛市均涨；穿越 = 牛市新高率 + 底部抬高率（两项均需非空） |
| `UNIVERSE_SEGMENTS` | 4 个分段 | clist 分段与板块标签（不含北交所） |
| `SANITY_CODES` | 20 只 | 合理性校验股（10 主板 + 5 创业板 + 5 科创板），名次写入 `run_meta.json` |
| `SLEEP_MS` / `BATCH_PAUSE_EVERY` / `BATCH_PAUSE_MS` | `2000` / `200` / `60000` | 拉数节奏，见下 |

改完 `CONFIG` 后只需 `--compute-only` → `tools/screen_report.js` 重算，不用重新拉数。

## 口径摘要

CAGR / 最大回撤 / ZigZag 牛熊划分的定义见仓库根目录 README 的「方法说明」，筛选器直接调用同一份 `app.js`，后复权（fqt=2），「看板」链接打开后数字一致。筛选器在此之上定义：

- **合格熊市** = 已完成熊市 + 实现跌幅 ≥ 阈值的首段截断 / 进行中熊市；**熊市均跌 / 最深熊市 / 熊市均历时**只统计合格熊市，每轮取阶段起点（枢轴高点）→ 最低点跌幅，**首段（截断）熊市按段内最高点 → 最低点跌幅计**（`FIRST_BEAR_DEPTH = 'peak'`）；没有合格熊市时取区间最大回撤（表中 `*` / 熊跌口径 maxDD）。
- **牛市均涨 / 牛市均历时**只统计已完成牛市。**牛市新高率** = 阶段高点高于此前全部历史最高收盘的已完成牛市占比；**底部抬高率** = 谷底高于上一轮熊市谷底的已完成熊市占比；样本 < 2 记空、不计分。
- **滚动 5 年持有年化**：每个月末起点 → 5 年后的年化收益分布，取 10 分位；样本 < 12 记空（近5年窗口全部为空，综合分按其余 5 项）。
- **同窗口榜**：起点固定、终点 = 数据终点；所有指标只看窗口内历史；百分位 / 综合分 / 分榜 / Pareto 在各窗口入选集合内计算。
- **综合分** = 6 项百分位等权平均（越高越好）；**Pareto 前沿** = 在（年化 ↑，最大回撤 ↑）上不被任何其他入选个股同时压制。
- **排名在全部板块内统一计算**；板块筛选只筛选显示的行。创业板 2009-10-30 开板、科创板 2019-07-22 开板，科创板个股全部不在近10年窗口。

## 拉数节奏与限流（重要）

东方财富接口对单 IP 限流，触发后会被封约 18 小时（表现为所有请求 ECONNRESET / 502）。脚本的节奏是实测安全值，**请不要调快**：

- 顺序请求（不并发），每只股票之间间隔 `SLEEP_MS = 2000` ms（约 2.0–2.5 s 一只）；每拉取 200 只暂停 60 s；
- 失败按单只冷却 30 s → 60 s → … → 300 s 重试同一只，连接层 reset 快速重试，`ABORT_AFTER_CONSEC_FAIL = Infinity`（永不因失败退出，被封时每 5 分钟探测一次直到解封）；
- clist 股票池翻页间隔 2.5 s，502 时冷却 60 s → 300 s 重试同一页（失败后在 `push2` / `push2delay` 两台主机间轮换，同一接口同一字段）；
- 0.7 s 间隔曾导致本机 IP 被封约 18 小时；1.5–2.0 s 间隔拉 ~4,300 只 0 失败。

## 校验

`node tools/screen_verify.js [--prev <上一版 metrics_*.csv 所在目录>] [--expect-data-end YYYY-MM-DD]` 输出 `screen/out/screen_verify.log`：股票池分段与板块标签、`run_meta` 一致性、规则一致性（每只 × 每视图 × 每阈值）、独立重算抽样、排名 1..n / Pareto、数据终点一致、CSV 结构（BOM / CRLF / 板块列 / 链接前缀）、`report.md` 表格与榜单行数、`screen.html` 结构与可编译性、文案、以及（给出 `--prev` 时）与上一版入选个股的逐字段回归。
