# 全市场「牛熊逻辑」筛选（screen.html）

## 这是什么

基于看板引擎 `app.js`（`analyze()`：CAGR / 最大回撤 / ZigZag 牛熊划分）对 A 股全市场逐只计算牛熊指标并排名的离线筛选器。

- **股票池**：沪深主板 + 创业板 + 科创板（东财 clist 4 个分段：深主板 `m:0+t:6`、创业板 `m:0+t:80`、沪主板 `m:1+t:2`、科创板 `m:1+t:23`），每行带「板块」标签；不含北交所。剔除简称含 ST / 退、上市不足 5 年（以 K 线首末日计）、长期停牌（末根 K 线比上证晚 30 天以上）。
- **三个牛熊阈值**：30% / 40% / 50%；**三个区间**：上市至今、近10年（2016-10-15 起）、近5年（2021-10-15 起）。
- **版本 v3**（2026-10-21）：股票池由沪深主板扩为全市场；指标口径与 v2.1 相同。已提交产出的数据截止 **2026-10-15**（`--data-end 2026-10-15`）。
- **版本 v3.1**（2026-10-29）：新增分红 / 股息率指标（股息率(近12月)、连续分红年数、分红年数 x/N、平均股息率、派息率、年化(分红再投资)、纯价格年化、分红贡献）与**红利榜**；数据来自东财数据中心分红送转明细 + 腾讯不复权月收盘（见下「分红与股息指标（v3.1）」）。现有指标、综合分（新增两项权重 0）、名次与 v3 逐位相同，CSV 新列追加在「数据源」之后，`screen/data/*_th*.js` 逐字节不变；`screen.html` 增加「分红」列组与「只看红利榜 Top 50」「连续分红 ≥ n 年」「显示分红列」三个控件。
- **排名 / 百分位 / 综合分 / 分榜 / Pareto 在全部板块的入选个股内统一计算**；板块只是标签，`screen.html` 里勾选板块只筛选显示的行，不重新排名。
- **股票池行来源**：`screen/universe.json` 每行带 `f26From`（该行 clist 数据的拉取日）。已提交产出中主板行取自 2026-10-16 的 clist，创业板 / 科创板行取自 2026-10-21 的 clist（`report.md` 第 1 节「股票池行来源」）。若某些行带 `interim` 标记（clist 不可用时按代码表补入、只有代码 / 名称 / 市场，无上市日 / 行业 / 总市值），入选判定仍以 K 线首末日为准、指标与排名不受影响；clist 恢复后用 `--universe-only` 补全（见下「其他参数」）。

## 在线查看

- 筛选总表：<https://vickingwu.github.io/astock-perf/screen.html>（推送后约 1 分钟生效）
- 看板：<https://vickingwu.github.io/astock-perf/>（总表每行「名称」可点开对应个股的看板页）

## 产出文件

| 文件 | 说明 |
| --- | --- |
| `screen.html`（仓库根目录） | 零依赖网页壳（约 38 KB）：区间 × 阈值 × 板块切换、列头排序、文本筛选、年化 × 最大回撤散点（canvas）、每行链接看板；表格每次渲染 100 行（滚动到底自动追加，或点「显示全部 N 行」）。v3.1 增加「分红」列组（股息率(近12月) / 分红年数 x/N / 连续分红 / 平均股息率 / 派息率 / 分红贡献 / 红利#，随区间切换）与「只看红利榜 Top 50」（同时按红利# 升序）、「连续分红 ≥ n 年」（留空 = 不筛）、「显示分红列」（默认开）三个控件。数据按需从 `screen/data/*.js` 加载：首屏 `meta.js + all.js + all_th30.js` ≈ 1.3 MB 原始 / Pages gzip 后 ≈ 417 KB；切换区间 / 阈值时再加载对应文件；仍可双击本地打开（file://） |
| `screen/data/`（13 个 `.js`） | 筛选表数据，由 `tools/screen_report.js` 生成、随仓库提交，须与 `screen.html` 一同保留：`meta.js`（META / KEYS / 行业字典；v3.1 加 `META.hasPayout`、`META.div`）；`all.js` / `10y.js` / `5y.js`（各区间基础字段，按入选个股下标对齐，不在窗口的为 `null`；v3.1 在 `KEYS.base` 末尾追加 `divYieldTTM, divYears, divN, divStreak, avgDivYield, payoutRatio（仅 hasPayout 时）, divContrib, dividendRank, divMiss`，旧键不变）；`<区间>_th30.js` / `_th40.js` / `_th50.js`（各阈值 18 项指标，对齐方式相同，v3.1 未改动）。全部 13 个文件约 4.9 MB 原始 / 1.5 MB gzip |
| `screen/report.md` | 中文报告：版本说明、概览、板块构成、各阈值综合榜 Top 50 与稳健 / 进攻 / 穿越榜 Top 20、同窗口榜、Pareto 前沿、跨阈值交集、合理性校验、分红与股息（v3.1：口径、全市场分布、红利榜 Top 50 / 窗口 Top 20、现有综合榜 Top 50 的分红贡献、后复权口径与分红再投资的差异）、口径与局限 |
| `screen/metrics_th30.csv` / `metrics_th40.csv` / `metrics_th50.csv` | 上市至今全部股票池（含剔除行与剔除原因）× 单阈值全部指标，UTF-8 BOM，Excel 直接打开；`板块` 为第 4 列。v3.1 在「数据源」之后追加 24 列：`分红数据`(ok/missing)、`不复权收盘(数据截止日)`、`不复权收盘日`、`每股分红TTM(税前)`、`股息率(近12月)`、`连续分红年数`、`首个会计年度`、`分红年数(上市至今)`、`会计年度数(上市至今)`、`平均股息率(上市至今)`、`派息率(上市至今)`（仅 hasPayout 时）、`分红增长(上市至今)`、`年化(分红再投资)`、`纯价格年化`、`分红贡献`、`分红贡献标记`、`年化(后复权,同起点)`、`再投资起点`、`分红事件数`、`补齐事件数`、`红利分`、`红利排名`、`pct_股息率TTM`、`pct_连续分红` |
| `screen/metrics_w10y.csv` / `metrics_w5y.csv` | 同窗口榜：一行一只窗口入选个股，三阈值列组（`30%_` / `40%_` / `50%_` 前缀）。v3.1 在「数据源」之后追加 16 列：`分红数据`、`每股分红TTM(税前)`、`股息率(近12月)`、`连续分红年数`、`分红年数(窗口)`、`会计年度数(窗口)`、`平均股息率(窗口)`、`派息率(窗口)`（仅 hasPayout 时）、`分红增长(窗口)`、`年化(分红再投资)`、`纯价格年化`、`分红贡献`、`分红贡献标记`、`年化(后复权,同起点)`、`红利分`、`红利排名`（三阈值相同，只存一份） |
| `screen/run_meta.json` | 本次运行参数与统计：版本、数据终点、股票池 / 入选 / 剔除计数（含按板块）、自检结果、20 只合理性校验股名次；v3.1 加 `today`、`dividends`（分红数据覆盖、补齐 / 漂移计数、股息率分布、连续分红分布、`hasPayout` 开关与理由、后复权口径诊断、红利榜入围数）、`config.DIV` |
| `screen/universe.json` | 股票池（代码、名称、市场、板块、上市日、行业、总市值、预剔除原因） |
| `screen/out/`（不入库，`.gitignore`） | 工作目录：`klines/` 日线缓存（每只一个 JSON，约 170 MB）、`results.json`（全部指标，约 90 MB）、`benchmarks.json`、拉数 / 计算日志、`screen_verify.log`；v3.1 加 `dividends/<secid>.json`（东财数据中心分红明细原始行）、`raw_monthly/<secid>.json`（腾讯不复权月收盘 + 数据截止日收盘）、`fetch_dividends.log` / `fetch_prices.log`、`fetch_failures_<pass>.json`、完成标记 `fetch_done_dividends.json` / `fetch_done_prices.json` |

CSV / `report.md` 里的「看板」链接为 `../index.html#s=…`（相对 `screen/` 目录）；`screen.html` 里为 `./index.html#s=…`。

## 在 Mac 上运行

需要 Node.js ≥ 18（`node -v`），**不需要 `npm install`**（只用 Node 内置模块）。在仓库根目录执行：

```bash
# 1. 拉数：股票池 + 全部日线（首次约 3–4 小时拉 ~4,300 只；可随时 Ctrl+C，重跑只补缺的）
node tools/screen_all.js --fetch-only
#    或交给看门狗托管（子进程异常退出自动续跑，队列全部完成后自行退出）：
nohup node tools/fetch_watchdog.js --source eastmoney > screen/out/watchdog_stdout.log 2>&1 &
#    进度：tail -f screen/out/fetch.log   完成标志：screen/out/fetch_done_eastmoney.json

# 1b.（v3.1）分红明细 + 不复权月线：两趟独立队列，可同时跑（实测约 3 小时 / 约 1.5 小时），断点续跑，完成标志 screen/out/fetch_done_dividends.json / fetch_done_prices.json
node tools/fetch_dividends.js --pass dividends --data-end 2026-10-15   # 东财数据中心分红送转明细 → screen/out/dividends/
node tools/fetch_dividends.js --pass prices    --data-end 2026-10-15   # 腾讯不复权月收盘 + 数据截止日收盘 → screen/out/raw_monthly/
#    或交给看门狗托管：nohup node tools/fetch_watchdog.js --job dividends > screen/out/watchdog_dividends_stdout.log 2>&1 &
#                      nohup node tools/fetch_watchdog.js --job prices    > screen/out/watchdog_prices_stdout.log 2>&1 &
#    进度：tail -f screen/out/fetch_dividends.log screen/out/fetch_prices.log

# 2. 计算 + 排名 → screen/metrics_*.csv, screen/run_meta.json, screen/out/results.json（约 1–3 分钟）
node tools/screen_all.js --compute-only                      # 数据终点 auto = 缓存上证末根 K 线日期
node tools/screen_all.js --compute-only --data-end 2026-10-15 # 或固定某个交易日（所有个股与指数都截到这一天）
node tools/screen_all.js --compute-only --data-end 2026-10-15 --today 2026-10-21   # 复算早先一次运行：--today 固定 clist f26 预剔除（上市<5年）的判定日，股票池剔除逐行复现

# 3. 报告 + 网页 → screen/report.md, screen.html, screen/data/*.js
node tools/screen_report.js

# 4. 校验（逐条 PASS/FAIL，写 screen/out/screen_verify.log；退出码 1 = 有 FAIL）
node tools/screen_verify.js --expect-data-end 2026-10-15
node tools/screen_verify.js --expect-data-end 2026-10-15 --baseline <上一版产出目录>   # 另加 Z.：旧列 / 旧键 / *_th*.js 与上一版逐格 / 逐字节比对
```

其他参数：

- `--sample N`（前 N 只 + 20 只校验股）、`--codes 600519,300015`：小样本试跑（不写 `fetch_done` 标记）。注意子集运行会把 `screen/universe.json` 中非目标行的 `excluded_reason` 只写到预剔除一步，提交前务必再跑一次全量 `--compute-only`。
- `--today YYYY-MM-DD`（v3.1）：固定「今天」= clist 上市日 f26 预剔除（上市不足 5 年）的判定日，默认系统日期；复算时给出上一次运行的日期，可让 `screen/universe.json` 与 CSV 的「剔除原因」列逐字节复现。写入 `run_meta.today`。
- `--no-dividends`（v3.1）：关闭分红指标——不读分红 / 不复权缓存、无红利榜、CSV 不加新列、`COMPOSITE_WEIGHTS` 去掉两项 0 权重键，产出与 v3 逐字节一致（`tools/screen_report.js` 随之不输出分红章节 / 分红列）。
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
| `COMPOSITE_WEIGHTS` | 6 项各 1 + `divYieldTTM: 0, divStreak: 0` | 综合分 = 年化、Calmar、最大回撤、熊市均跌、牛市新高率、滚动 5 年 P10 的百分位加权平均（空项不计）；v3.1 新增的两项权重为 0、不计分（`compositeN` 只数正权重项），调成正数即把股息率 / 连续分红纳入综合分 |
| `BOARDS` | 稳健 / 进攻 / 穿越 / 红利 | 分榜：稳健 = 熊市均跌 + 最大回撤；进攻 = 年化 + 牛市均涨；穿越 = 牛市新高率 + 底部抬高率（两项均需非空）；红利（v3.1）= 股息率(近12月) + 连续分红年数 + 最大回撤（三项均需非空，`BOARD_REQUIRE_ALL.dividend`） |
| `BOARD_GATE.dividend` | 分红数据 ok 且连续分红 ≥ `DIV.STREAK_MIN_FOR_BOARD` | 红利榜入围门槛（v3.1）；不满足者红利分 / 红利排名为空 |
| `DIV.ENABLED` | `true` | v3.1 分红指标总开关（`--no-dividends` → `false`） |
| `DIV.DIR` / `DIV.PRICE_DIR` | `screen/out/dividends` / `screen/out/raw_monthly` | 分红明细 / 不复权月线缓存目录（`tools/fetch_dividends.js` 写入） |
| `DIV.STREAK_MIN_FOR_BOARD` | `3` | 红利榜门槛：连续分红年数下限 |
| `DIV.TTM_DAYS` | `365` | 股息率(近12月) 的窗口：(数据截止日 − 365 天, 数据截止日] |
| `DIV.RECON_TOL_ABS` / `DIV.RECON_TOL_REL` | `0.1` / `0.002` | 后复权对账的月末残差容忍：max(0.1 元, 0.2% × 后复权价) |
| `DIV.RECON_DRIFT_MONTHS` / `DIV.RECON_DRIFT_SHARE` | `3` / `0.15` | 近 12 个月末 ≥ 3 个、或全部月末 > 15% 无法解释 → `recon_drift`（再投资类指标置空） |
| `DIV.SYNTH_MAX_YIELD` | `0.25` | 对账补齐一笔现金的上限（≤ 上月末不复权收盘的 25%，且该月无送转），超过视为噪声不补 |
| `DIV.WINDOW_LOCAL_RECON` | `true` | 上市至今对账漂移的个股，在近10年 / 近5年窗口内重新对账（拆分因子按窗口首段拟合），通过者窗口指标照常输出 |
| `DIV.TR_GAP_MAX` / `DIV.NULL_ON_HFQ_GAP` | `0.02` / `false` | 年化(分红再投资) 与 年化(后复权,同起点) 之差 > 2 个百分点 → 标 `hfq_gap`；`true` 时同时把分红贡献置空 |
| `DIV.LAST_FY` | `null`（= 数据截止年 − 1） | 最后一个完整会计年度（连续分红 / 分红年数的终点） |
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

## 分红与股息指标（v3.1）

在不改动任何现有指标与名次的前提下，为每只入选个股、每个区间（上市至今 / 近10年 / 近5年）增加一组分红指标，并新增红利榜。`screen/report.md`「分红与股息」一节给出全市场分布、红利榜与口径差异；`screen.html` 的「分红」列组随区间切换。

指标口径的实现在仓库根目录 `dividends.js`（事件归一化、送转折算、每股分红TTM、连续分红、区间统计、再投资年化），个股看板 `index.html` 与 `tools/screen_all.js` 共用同一份；后复权对账补齐（`reconcileDiv`）、`recon_drift` 置空、标记与 CSV 管道仍只在 `screen_all.js`。看板与筛选器的差异：看板用不复权日线再投资（除息后首个交易日），筛选器用月末价近似，二者的 年化(分红再投资) / 分红贡献 略有差异；看板是实时页面，最近完整会计年度用 `DIV.latestCompleteFY`（9–12 月 = 当年 − 1；1–8 月上一年度尚无已实施现金分红时 = 当年 − 2），筛选器仍为 `DIV.fiscalYearRule` = 数据截止年 − 1（数据截止日在 10 月时两者相同）；看板没有 `recon_drift` 置空，只在后复权视图下用同区间后复权年化复刻 `hfq_gap`（同样的 2 pp 门槛，数值保留、只加提示；前复权因现金加性扣减、区间年化不可比，不复权无可比序列，二者都不判）；看板在 1–8 月对只实施了中期派息的最近年度另提示「年报分红尚未实施（已含中期）」（`summarize().partialFY`）；看板的除息前一月末收盘回退锚点固定为上市首日不复权收盘，筛选器只在该锚点对账一致时使用。

### 数据来源与拉取

| 数据 | 来源 | 脚本 / 缓存 |
| --- | --- | --- |
| 分红送转明细 | 东方财富数据中心 `RPT_SHAREBONUS_DET`（`datacenter-web.eastmoney.com`，与 `push2*` 行情主机无关，不占 K 线拉数的限流额度）；只读数值列 `PRETAX_BONUS_RMB`（每 10 股税前现金）、`BONUS_RATIO` / `IT_RATIO` / `BONUS_IT_RATIO`（每 10 股送 / 转）、`BASIC_EPS`、`REPORT_DATE`、`EX_DIVIDEND_DATE`、`ASSIGN_PROGRESS`；接口不可用时回退新浪 `vISSUE_ShareBonus` 页面表格 | `node tools/fetch_dividends.js --pass dividends` → `screen/out/dividends/<secid>.json`（原始行、全部列） |
| 不复权价格 | 腾讯财经 `web.ifzq.gtimg.cn/appstock/app/kline/kline`：`<sym>,month,,,640` 全史月收盘 + `<sym>,day,<起>,<数据截止日>,640` 取数据截止日收盘（**唯一的不复权价来源**；`fqkline/get` 不带复权后缀是参数错误，不用） | `node tools/fetch_dividends.js --pass prices` → `screen/out/raw_monthly/<secid>.json` |

- 两趟队列彼此独立，可并行：分红约 4,116 × (1.5 s 间隔 + 约 0.8 s 请求) + 每 200 只暂停 60 s ≈ 3 小时（实测 2.35 s / 只）；价格 2 请求 / 只 × (0.4 s 间隔 + 请求耗时) ≈ 1.5 小时（实测 1.4 s / 只）。都可随时中断、重跑只补缺的（缓存文件存在且可解析即跳过）；全量队列完成且无限流类失败时写完成标记 `screen/out/fetch_done_dividends.json` / `fetch_done_prices.json`（子集运行 `--codes` / `--limit` 不写）。失败按指数退避 60 s → 120 s → … → 600 s 重试同一只，永不因失败退出；失败清单 `screen/out/fetch_failures_<pass>.json`。
- `--data-end YYYY-MM-DD`（默认 2026-10-15）只影响 prices 趟取「数据截止日收盘」的日线区间；应与随后 `screen_all.js --compute-only --data-end` 一致。
- 看门狗托管（崩溃自动重启，完成标记出现即退出）：
  - macOS / Linux：`nohup node tools/fetch_watchdog.js --job dividends > screen/out/watchdog_dividends_stdout.log 2>&1 &`，`--job prices` 同理。
  - Windows PowerShell（仓库根目录）：`Start-Process node -ArgumentList 'tools/fetch_watchdog.js --job dividends' -WorkingDirectory (Get-Location) -WindowStyle Hidden`，`--job prices` 同理。
- 从未分红的个股（如 688981 中芯国际）接口返回 `code 9201 返回数据为空`，缓存为合法空表（`rows: []`），不是失败。

### 指标定义（每个区间一套，键集相同；`LAST_FY` = 数据截止年 − 1 = FY2025）

- **事件**：`ASSIGN_PROGRESS` 含「实施」且除息日 ≤ 数据截止日的记录；每股税前现金 = `PRETAX_BONUS_RMB` / 10；送转因子 = 1 + (`BONUS_IT_RATIO` ?? `BONUS_RATIO` + `IT_RATIO`) / 10（只影响拆分，不计入分红）。会计年度 = `REPORT_DATE` 年份（年报 / 中期 / 季度各归其年度）；无报告期的记录与补齐事件按除息月归属：1–8 月 → 上一年度，9–12 月 → 当年。
- **明细补齐（与后复权序列对账）**：东财后复权满足 hfq(t) = S(t)·raw(t) + D(t)（现金加性、送转乘性，锚定上市首日），逐月末计算残差；明细漏掉一笔现金时序列出现干净台阶 → 补一笔现金事件（`src: 'hfq'`，计入所有指标；CSV「补齐事件数」）。残差无法解释的月份过多（近 12 个月末 ≥ 3 个或占比 > 15%）→ `recon_drift`（多为明细缺送转 / 配股），年化(分红再投资) / 纯价格年化 / 分红贡献 置空，股息率 / 分红年数 / 连续分红仍按明细（含补齐）计算；近10年 / 近5年窗口内会再做一次局部对账，通过者窗口指标照常输出。
- **每股分红TTM(税前)** / **股息率(近12月)**：(数据截止日 − 365 天, 数据截止日] 内除息的每股税前现金之和（按其后送转折算到当前股本）÷ 数据截止日不复权收盘。
- **连续分红年数**：自 FY2025 起向前连续有现金分红的会计年度数（不受区间限制，上市前一年度的分红在上市后除息也算，可大于区间年数）。
- **分红年数 x/N**：区间内有现金分红的会计年度数 / 区间会计年度数（上市至今 N = 上市年度 → FY2025；近10年 FY2016–2025，N = 10；近5年 FY2021–2025，N = 5）。
- **平均股息率**：区间内各会计年度股息率之和 ÷ N，年度股息率 = 该年度每股现金 ÷ 除息月前一月末不复权收盘；无分红年度计 0。
- **派息率**：Σ 现金 ÷ Σ 年报基本 EPS，对区间内有现金分红且有年报 EPS（`BASIC_EPS` > 0）的会计年度求和（现金加权）。全局开关 `run_meta.dividends.hasPayout`：≥ 80% 的有分红个股可算出上市至今派息率、且 600519 FY2024 派息率 = (27.673 + 23.882) / 68.64 ∈ [0.70, 0.80] 时为 true，否则 CSV / 数据文件 / 页面一律不输出派息率并在 `hasPayoutReason` 记录原因。
- **分红增长**（CSV）：区间内首末两个分红年度之间、拆分调整后年度每股现金的 CAGR（≥ 3 个分红年度）。
- **年化(分红再投资)**：不复权月收盘序列，起点 = 上市首日收盘（锚定自后复权序列；窗口 = 窗口起点前最后一个月末），每笔现金在除息后首个月末按收盘买回、送转按因子调份额，终点 = 数据截止日收盘。**纯价格年化** = 同一序列只计送转；**分红贡献** = 二者之差（百分点）。**年化(后复权,同起点)** = 东财后复权在同样两个日期的年化（上市至今即现有「年化」）；|年化(分红再投资) − 年化(后复权,同起点)| > `TR_GAP_MAX`（2 pp）标 `hfq_gap`——东财后复权对现金是加性处理（相当于分红不再投资），长历史高分红个股与大跌个股的差值天然较大，这是口径差异不是错误；`NULL_ON_HFQ_GAP = true` 可改为置空。标记列「分红贡献标记」取值 `hfq_gap` / `recon_drift` / `px_missing` / `trend_month`（数据截止日前停牌、终点取最后一个月末）。
- **红利榜**：股息率(近12月)、连续分红年数、最大回撤 三项百分位等权平均（三项均需非空），门槛 `BOARD_GATE.dividend` = 分红数据 ok 且连续分红 ≥ 3 年；每个区间一套名次，三个阈值下相同（窗口 CSV 只存一份）。
- `COMPOSITE_WEIGHTS` 新增 `divYieldTTM: 0, divStreak: 0`：综合分不变（`compositeN` 只数正权重项）；想把股息纳入综合分，把权重调成正数后 `--compute-only` → `tools/screen_report.js` 即可。

### 页面（screen.html）

「分红」列组：股息率(近12月)、分红年数 x/N（N 随区间切换）、连续分红、平均股息率、派息率（仅 `hasPayout` 时）、分红贡献（悬停显示定义）、红利#。控件：「只看红利榜 Top 50」（勾上同时按红利# 升序）、「连续分红 ≥ n 年」（留空 = 不筛）、「显示分红列」（默认开）。散点悬停提示附股息率TTM；页脚有一句口径说明。分红数据缺失的行所有分红列显示 —。

## 拉数节奏与限流（重要）

东方财富接口对单 IP 限流，触发后会被封约 18 小时（表现为所有请求 ECONNRESET / 502）。脚本的节奏是实测安全值，**请不要调快**：

- 顺序请求（不并发），每只股票之间间隔 `SLEEP_MS = 2000` ms（约 2.0–2.5 s 一只）；每拉取 200 只暂停 60 s；
- 失败按单只冷却 30 s → 60 s → … → 300 s 重试同一只，连接层 reset 快速重试，`ABORT_AFTER_CONSEC_FAIL = Infinity`（永不因失败退出，被封时每 5 分钟探测一次直到解封）；
- clist 股票池翻页间隔 2.5 s，502 时冷却 60 s → 300 s 重试同一页（失败后在 `push2` / `push2delay` 两台主机间轮换，同一接口同一字段）；
- 0.7 s 间隔曾导致本机 IP 被封约 18 小时；1.5–2.0 s 间隔拉 ~4,300 只 0 失败。

## 校验

`node tools/screen_verify.js [--prev <上一版 metrics_*.csv 所在目录>] [--expect-data-end YYYY-MM-DD] [--baseline <上一版产出目录>]` 输出 `screen/out/screen_verify.log`：股票池分段与板块标签、`run_meta` 一致性、规则一致性（每只 × 每视图 × 每阈值）、独立重算抽样、排名 1..n / Pareto、数据终点一致、CSV 结构（BOM / CRLF / 板块列 / 链接前缀）、`report.md` 表格与榜单行数、`screen.html` 壳 + `screen/data/*.js` 结构 / 计数 / 名次 / 行业字典 / 首屏 gzip 体积（≤ 500 KB）、文案、（给出 `--prev` 时）与上一版入选个股的逐字段回归，以及（给出 `--baseline` 时，v3.1）与上一版产出的逐格 / 逐字节比对：5 个 CSV 旧表头为新表头前缀、每行旧列逐格相同并列出追加列；9 个 `screen/data/*_th*.js` SHA-256 相同；`all.js` / `10y.js` / `5y.js` 旧键取值与空值位置相同；`meta.js` 的 `KEYS.th` 相同、`KEYS.base` 以旧列表为前缀。`<上一版产出目录>` 可以是仓库根目录的镜像（含 `screen/…`）或 `screen/` 目录本身。
