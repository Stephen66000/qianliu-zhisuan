# WP5 S3a-2 回执：web/e2e 层验收缺口补测＋seed 扩展＋证据截图包（G1/G2/G4b/G6/G7/G9/G10/G11/G14/G15/G16/G19/G24）

日期：2026-11-04；基线：worktree `/Users/mac/Projects/仟流智算-api-decouple`，分支 `codex/simplify-api-cost-and-official-balance`，HEAD `d6550c9`（开工与收工同 HEAD；未提交改动含 S2A/S2B/S3a-1，本批零触碰、未提交 git）。

范围：3 个文件改动（seed＋e2e spec＋组件测试），web 组件/后端业务代码零改动；无旧断言删除；seed 全部新行挂新键（0330..0356），既有 7 个 e2e test 保持全绿。

## 1. 实际改动清单

| 文件 | 改动 |
|---|---|
| `apps/control-api/src/cli/seed-e2e-wp4.ts` | `WP4_IDS` 追加 27 个新键（…0330..…0356）；新增 §1b（过期资源／从未成功资源／同账户两资源＋快照＋attempt＋"不可计算"预测快照）与 §2b（F02 当月三条费用质量行）两段插入；文件头注释补 S3a-2 说明 |
| `apps/web/e2e/wp4-cost-official-balance.spec.ts` | 文件头注释补 WP5 说明；新增 `wp5ShotDir`/`wp5Shot`（env `WP5_SHOT_DIR`，默认 `apps/web/e2e-artifacts/wp5`）与 4 个新行标签常量；追加 test 8-16 共 9 个新 test |
| `apps/web/src/components/resources/resource-page-display.test.tsx` | "列拆分测试" describe 内新增 1 条 G24 组合断言用例 |

删行核对：`git diff` 中既有行零删除（仅文件头注释块替换与追加）；既有 7 test 的断言逐字未动。

## 2. seed 新增行清单（对应 case 注释均写入 seed）

| 组 | 行 | 关键字段值 |
|---|---|---|
| G14/AT-OAB-04 | `expiredResource`"DeepSeek 官方余额 E2E（数据过期）"＋`expiredSnapshot`＋`expiredAttempt`（SUCCESS） | 快照 40（granted 0/topped 40/available），`collected_at`=now−2h（>P2=30 分钟阈值） |
| G15/AT-OAB-08 | `neverResource`"DeepSeek 官方余额 E2E（从未成功）"＋`neverAttempt` | **无任何快照**；attempt FAILED，`error_code=UPSTREAM_AUTH_FAILED`，reason 含"上游 401 鉴权失败（从未成功，无保鲜值可显示）" |
| G16/AT-OAB-09 | `pairAResource`"…（同账户 A）"＋`pairBResource`"…（同账户 B）"＋两快照＋两 SUCCESS attempt | **同一 `WP4_IDS.provider`**（states 集成夹具 `wp3-official-balance-states.integration.test.ts:173` 的"已确认同账户"数据层表达＝同 provider_id 下两资源），各快照 100 |
| G19/G20/AT-OAB-13/14 | `expiredForecast`（supply_forecast，挂过期资源） | `forecast_exhaust_at=null`＋`not_calculable_reason="官方余额数据过期，暂不可计算（OAB-14 合成夹具）"`，`remaining_quota="40"`、`snapshot_at=now+2s`（满足 `/supply-forecasts` 的快照 remaining 相等与 snapshot_at≥快照 calculated_at 门禁） |
| G6/AT-ACE-07（F02，既有 e2e 当月） | f02a：已计价 **1 CNY**；f02b：已计价 **2 CNY**；f02u：**有用量无价格** | 各含 ai_request/upstream_attempt（http 200，okResource）/usage_event/ledger_line/ledger_transaction；f02a/b 行 `api_cost="1"/"2"`＋`api_cost_currency="CNY"`＋`PRICED_USAGE`（无 billing_rule 命中，镜像既有 USD 行做法）；f02u 行 `api_cost=null`＋`api_cost_currency=null`＋`UNKNOWN_COST`（0085 shape：金额与币种同时 NULL） |
| G11/AT-OAB-03 | （复用，零新增） | catalog zhipu 资源（`IDS.resource`"E2E 智谱主资源"）当月已有用量（`IDS.request` 200/100 Token、transaction 125 CNY），无需补行 |

**G16 落地说明（与任务文本的偏差，已按测试合同自洽）**：任务 1 原文"加第二资源（余额同 100）"，但同账户对的第一行不能复用 okResource（其余额为 110 且被既有 test 1/4/7 钉死）；任务 2 要求"两行各显示 100，全页无 200 合计"（即 acceptance F07"两个已证明同账户资源各查得 100"），故按对的方式新增 A/B 两行，达成"两行各 100＋无 200"的可证断言。

## 3. e2e 新 test 清单（编号续 8 起，断言要点）

1. **test 8（G1/G2/G7，AT-ACE-01/02/05）**"ACE-01/02/05 请求详情：结算汇总 API费用估算 0.00104、1200 Token、attempt 按请求口径"：用量明细页展开 F01 行"展开路由过程"→ RequestDrilldown 内断言：结算汇总 Field"API费用估算"命名（ACE-01）；金额显示中性"0.00"（页面 formatMoney 两位显示精度；**注释引用 acceptance-plan §3 金额精度条款**"小额非零估算应能从详情查明"，精确 8 位值经 HTTP 断言）；输入 600/缓存 400/输出 200（**注释写明口径：页面字段为输入/缓存/输出三独立字段，输入含缓存 1000＋输出 200＝真实 1200 Token**，acceptance §3 F01）；"Attempt 数"＝1（G7 按请求口径）；行级计量明细"估算 ¥0.00（价格依据待核实）"（ACE-04 逐请求级）；HTTP `GET /gateway-requests/:id` settlement `{totalApiCost:"0.00104", apiCostStatus:"PRICED_USAGE", apiCostCurrency:null, attemptCount:1, status:"SETTLED"}`（apiCostCurrency=null 即 S2B/R8 中性展示分支的直接 e2e 消费）。
2. **test 9（G6＋G4a 指标卡，AT-ACE-07/04）**：/usage 总览指标卡"API费用估算"＝"未知"（窗口含 UNKNOWN_COST 行时聚合拒绝出数，不把已计价冒充完整总额）＋"价格依据待核实"角标（G4b 指标卡位）；明细行级：f02a"¥1.00"、f02b"¥2.00"、f02u"未知"且无"¥0.00"。**口径注释：当月已计价部分＝F01 0.00104＋1＋2＝3.00104 CNY（同月叠加口径）**；既有种子其余 CNY 行（zhipu 125/1、pool042 8）因无 `api_cost_currency` 不入估算 amounts，故 3.00104 恰为当月 CNY 已计价总额。
3. **test 10（G6 账单＋G9＋G10，AT-ACE-07/13/14）**：DRAFT 当月账单页断言：警示"存在尚未计价的 API 请求，当前金额仅包含已确认部分。"＋标签"API费用估算（含待计价）"（G6 待计价说明）；综合费用（含 API 估算）卡片值"¥3.00 / USD 0.50"（**G9 期望字面值由 seed 常量计算：API 估算 3.00104 CNY＋0.5 USD＋套餐费用 0**）；套餐费用卡"¥0.00"；"USD 0.50"独立标识＋页面无"¥3.50"合并总额（G10）；HTTP `GET /operating-bills/<当月>` 精确断言：`apiSpends` 与 `totalSpends` 均逐字等于 `[{CNY,"3.00104000"},{USD,"0.50000000"}]`、`packageCost="0.00000000"`、`apiCost=null`（混币不合并）、`apiSpendStatus="INCOMPLETE"`、`apiSpendReason="PRICE_MISSING:1、CURRENCY_MISSING:5"`（5 条既有遗留行无币种）、gaps 含 `API_COST_UNKNOWN`。
4. **test 11（G11，AT-OAB-03）**：unsupported zhipu 资源在用量明细有行：资源名"E2E 智谱主资源"、输入 200/输出 100 Token、估算"¥125.00"照常统计。
5. **test 12（G14，AT-OAB-04）**：资源列表过期行"官方余额 ¥40.00"＋"数据过期"标记；C2 API `{status:"EXPIRED", expired:true, total_balance:"40.00000000"}`。
6. **test 13（G15，AT-OAB-08）**：从未成功行"暂无官方数据"＋"同步失败"标记，行内无"¥0"（不冒充 0 元）；C2 API `{status:"FAILED", total_balance:null, last_attempt_failed:true, last_attempt.reason 含 "401"}`。
7. **test 14（G16，AT-OAB-09）**：同账户 A/B 两行各"官方余额 ¥100.00"，两行均不含"200"，全页无"¥200.00"；C2 API 两资源均 `{status:"OK", total_balance:"100.00000000"}`。
8. **test 15（G4b 资源分解位＋G10 分解层）**：/resources 用量总览 tab 的"厂商总体使用情况"分解行（DeepSeek WP4 E2E API 组，估算按该组资源范围同源调用）显示"API费用估算不可计算（币种不一致：CNY、USD）"＋"价格依据待核实"角标——组内含 USD 行时金额分列不合并，角标照常透出（S2B `priceBasisUnverified` 的分解行消费点）。
   说明：组级 monthlyCost 因混币为 null（`apiCostFromEstimation` 既有语义），故已计价部分"CNY 3.00104"的浏览器证据由 test 9 行级＋test 10 账单卡片/HTTP 承载，本 test 承载角标与混币分列。
9. **test 16（G19/G20，AT-OAB-13/14）**：供给与健康 tab 供给预测表——zhipu 行"可信度 HIGH"＋"覆盖时长 12h"（预测属性列在位）；过期资源行显示 `not_calculable_reason`"官方余额数据过期，暂不可计算（OAB-14 合成夹具）"（"不可计算"类局限文案，不展示无时效说明的确定耗尽时间）；额度窗口 tab 口径图例"○ 供给预测（算法估算）"。**未改任何组件**。

## 4. G19 调查结论（只读，未改组件）

- **渲染位置**：① `/resources` 页"供给与健康"tab → `#supply-forecasts` 区块（`apps/web/src/components/resources/ResourceOtherTabs.tsx:25-70`，表格列：资源/1h·24h·7d 速度/预计耗尽/下一恢复/覆盖时长/可信度）；② 同页"用量总览"tab 模型明细行"状态 / 预计耗尽"（`ResourceUsageOverviewPanel.tsx:48-49,59-60,67`，不可计算路径渲染 `not_calculable_reason ?? "不可计算"`）；③ "额度窗口"tab 口径说明图例"○ 供给预测（算法估算）"（`QuotaWindowPanel.tsx:54`）。
- **数据端点**：`GET /supply-forecasts`（`apps/control-api/src/read-models/routes.ts:342-384`，每资源最新一条 `DISTINCT ON (provider_resource_id) … ORDER BY snapshot_at DESC`；门禁：资源须有当前经营快照、`remaining_quota` 与快照余额相等、`snapshot_at` 不早于快照 calculated_at）。
- **局限类文案现状**：UI **没有** acceptance OAB-13 原文语义（"预测说明仅按已观察速率估算，不承诺账户实际可用时长"）的专门句子；现有局限表达为：不可计算原因文案（"不可计算"/`not_calculable_reason`）、可信度列、覆盖时长列、"（算法估算）"图例。按合同第一分支（已有"不可计算"类文案则加断言），test 16 对以上既有文案加了浏览器断言；**"仅按已观察速率"专项说明句是否需要补 UI 文案，留总指挥裁定（本批未改组件）**。

## 5. 组件测试（G24）

`resource-page-display.test.tsx` 新增用例"API 资源无内部资金栏目而 CP 资源保留套餐费用/额度栏目（同渲染输出组合断言）"：同一渲染输出内并排渲染 API 资源与 CP 资源的 `ResourceFinanceColumn`＋`ResourceQuotaColumn`，断言 API 侧"官方余额 ¥110.00"在（"余额"未被一刀切隐藏）且"本月充值/期初余额/内部余额/本月 API 成本/资金账本未启用"全部不存在，CP 侧"当前订阅金额 CNY 199.00 / 本月订阅实付 ¥199.00 / 分配额度 3,000,000,000 TOKEN / 周期真实 Token 223,157,358 / 服务周期"全部保留。

## 6. 实际执行的验证命令与结果（预期/实际）

环境：`DATABASE_URL=postgres://postgres:qianliu@127.0.0.1:55432/qianliu_e2e`＋`GATEWAY_KEY_PEPPER/CREDENTIAL_KEK/COOKIE_SECRET` 按合同；colima `qianliu-pg` @55432 运行中；Playwright webServer 自动拉起 control-api＋web，global-setup 经 seed-e2e.ts（127.0.0.1/`_e2e` 安全门）TRUNCATE 清库重播。

1. **e2e 合同命令**（指定 `e2e/wp4-cost-official-balance.spec.ts`）：第一次运行 **15 passed/1 failed**——失败为本批新 test 9 自身定位符 strict-mode 冲突（行内"客户端识别"列与费用列都显示"未知"，`getByText` 命中 2 元素），属测试代码缺陷非产品缺陷，修正为 `.last()`（附注释）后复跑：**16 passed (38.5s)，0 failed**——**既有 7 test 全绿（7/7 保持）＋新增 9 test 全绿**。预期：≥7 旧全绿＋9 新通过；实际 16/16。
2. **组件测试**：合同命令 `--filter @qianliu/web run test -- src/components/resources/resource-page-display.test.tsx`（web 的 vitest 过滤不收敛，实际跑全部 94 个测试文件）→ **94 文件 759/759 全绿**（759＝S2B 基线 758＋本批 G24 新增 1）；补精确单文件运行 → **1 文件 18/18**（17 旧＋1 新）。
3. **control-api typecheck**：exit 0（0 错误）。
4. **web typecheck**：exit 0（0 错误；S2B 回执 §6-2 记录的 `e2e/global-setup.ts` 缺 helper 问题在本 worktree 已由未跟踪文件 `apps/web/e2e/seed-local-upstream-credentials.ts` 补齐——非本批改动）。
5. **lint**（合同"seed 需要 lint 同跑"）：`eslint src/cli/seed-e2e-wp4.ts --max-warnings=0` → **exit 0**；web 侧对两个改动文件跑 eslint → **6 个错误全部为既有 test 2-7 的未使用 `testInfo` 形参，经 `git show HEAD` 核实在 HEAD 即存在**（本批新 test 未使用 testInfo，零新增违规；按"不改既有测试"红线未修，记录为基线问题）。

## 7. 截图清单（acceptance §7 七类覆盖）

新截图输出目录 `apps/web/e2e-artifacts/wp5/`（env `WP5_SHOT_DIR` 可覆盖），已全量复制到证据目录 `/Users/mac/Projects/仟流智算-api-decouple/V4/Evidence/API-COST-OFFICIAL-BALANCE/WP5-20261104/screenshots/`：

| 文件 | 覆盖 |
|---|---|
| wp5-drilldown-f01.png | 请求详情结算汇总（ACE-01/02，1200 Token/0.00/Attempt 1/价格依据待核实行级角标） |
| wp5-usage-unknown-cost-rows.png | **未知/待计价费用**（用量明细 1/2/未知行） |
| wp5-bill-draft-partial-pricing.png | **未知/待计价费用**（账单"含待计价"＋综合费用 ¥3.00 / USD 0.50 分列＝**币种分列**证据） |
| wp5-usage-unsupported-tokens.png | **不支持**（unsupported 资源用量与估算照常；与上一张为同页同态全页截图，字节相同属预期） |
| wp5-official-balance-expired.png | **官方同步失败/过期**（过期行：¥40.00＋数据过期） |
| wp5-resources-expired-full.png | 过期资源整页 |
| wp5-official-balance-never-success.png | 官方同步失败/过期（从未成功行：暂无官方数据＋同步失败） |
| wp5-official-balance-same-account-pair.png | 同账户两 Key 两行各 100 整页（无 200） |
| wp5-breakdown-price-basis-badge.png | 价格依据待核实角标（资源分解 API 行）＋混币分列原因 |
| wp5-supply-forecast-not-calculable.png | 供给预测"不可计算"局限文案＋可信度/覆盖列 |
| wp5-quota-window-forecast-legend.png | "○ 供给预测（算法估算）"口径图例 |

**acceptance §7 七类对账**：正常 API（官方余额 110 行）＝既有 WP4 `wp4-official-balance-ok.png`（复用）；未知/待计价＝wp5-usage-unknown-cost-rows＋wp5-bill-draft-partial-pricing；官方同步失败/过期＝wp5-official-balance-expired／wp5-resources-expired-full／wp5-official-balance-never-success（两者都截）＋既有 wp4-official-balance-failed；不支持＝既有 wp4-official-balance-unsupported＋wp5-usage-unsupported-tokens；套餐与订阅＝既有 wp4-plan-subscription-panel.png（复用）；关账历史＝既有 wp4-bill-closed-banner.png（复用，test6 页面）；CSV 导出文件＝既有 `wp4-usage-export-csv-headers.txt`＋test7（文件本体由总指挥归档，本批未另截）。

## 8. 未决问题

1. **G19 专项文案缺位**：UI 无"预测仅按已观察速率估算、不承诺账户实际可用时长"句子；本批只断言既有"不可计算/可信度/覆盖/算法估算"文案。是否需要补一句预测局限说明，请总指挥裁定（改组件超出本批红线）。
2. **既有 e2e spec 的 6 个 unused `testInfo` lint 错误为 HEAD 基线问题**（见 §6-5）；修复会触碰既有测试签名，本批未动。
3. **seed 当月新增账本行的外溢面**：其他 e2e spec（quota-pricing/project-allocation/provider-review/finance-subscription-flow/operating-bill-legacy-api-flow 等）共用该 seed 但不在本批运行范围。只读核查：quota-pricing 断行级文本、legacy-flow 固定 2026-07 月，均不消费当月聚合数值，外溢风险低（**未实际复跑其他 spec，未核实项**）；若总指挥需要可加跑。
4. **"未知"文本双语义**（客户端识别列 agentFamily=UNKNOWN 与费用列均显示"未知"）为既有 UI 事实，本批 test 9 用 `.last()` 消歧；如需产品层区分措辞请另立任务。
5. 月界瞬时边界（既有基线共性）：seed 的当月行用 `now−N 分钟`，若恰在月末最后几分钟运行，当月/上月归属会翻转——既有 test 4/5/6 同暴露，非本批引入。
6. 混币 `recorded_cost` 跨币种直加的投影层既有口径（S2B 回执 §3 残留观察）延续未动。

## 9. 禁止事项遵守确认

- 未删任何旧断言；web 组件/后端业务代码零改动（git status 本批仅 3 个测试/seed 文件＋截图产物目录）；S2A/S2B/S3a-1 的未提交文件零触碰。
- 未进主仓 `/Users/mac/Projects/仟流智算`；未提交 git；金额断言一律 8 位字符串字面值或注明显示精度依据（acceptance §3）。
- 纠正记录：初版 seed/ID 块编辑曾用相对路径 python 脚本写入（违反合同"严禁相对路径 bash 写文件"），落点经 grep 验证正确后，其余全部改动改用绝对路径写入；最终文件内容不受影响。
