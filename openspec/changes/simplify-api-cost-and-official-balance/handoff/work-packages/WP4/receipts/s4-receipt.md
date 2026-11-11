# WP4 S4 回执（task 5.3：首页/经营账单/年度/部门/项目/CSV）

实施：glm-flash 子 Agent（WP4-S4 合同）；日期：2026-11-04；分支 `codex/simplify-api-cost-and-official-balance`（不 commit，改动留工作树）。
基线复核：开工 `git status --short | grep -v "^??" | wc -l` ＝ **39**（含 2 个 D，与合同预期一致）；全程只在 `/Users/mac/Projects/仟流智算-api-decouple/` 内写文件（bash 均 `cd`＋绝对路径），主仓 `/Users/mac/Projects/仟流智算` 零触碰。收尾 `git status` ＝ 59 个修改（S2 22＋S3 新增＋S4 本阶段）＋2 个 D＋未跟踪 WP4 文档，无 commit。

## 1. S4 改动文件清单（22 个；标 * 者为 S2/S3 已交付文件、本阶段仅追加小改）

| # | 文件 | S4 改动 |
|---|---|---|
| 1 | `apps/web/src/components/dashboard/standard-home-model.ts` | 交付1：`COST_GAP_LABELS` 删 `OPENING_BALANCE_MISSING` 映射（AFR-07／WP2 遗留①，后端停产 provider-finance-gaps.ts:33/:58 恒 0）；:91 `CASH_PAID_CNY_MISSING` 保留不动 |
| 2 | `…/standard-home-model.test.ts` | 断言迁移：`costGapLabel` 全表用例改用仍产码组合（多码拼接改 `CASH_PAID_CNY_MISSING＋API_COST_CURRENCY_MISSING`），OPENING_BALANCE_MISSING 改断言"未知码回退原码"（注明 AFR-07）；:425 组合断言同步 |
| 3 | `apps/web/src/pages/Dashboard.tsx` | 费用卡 label "本月费用"→"本月综合费用（含 API 估算）"（ACE-07；值=套餐＋API 估算按币种，WP1 合同 §3）；头注同步 |
| 4 | `apps/web/src/pages/Dashboard.test.tsx` | fixture `incompleteReason: "期初余额待补"` → `"OPERATING_SNAPSHOT_MISSING"`（AFR-07：待补字样退出；同验证 raw reason 透传行为） |
| 5 | `apps/web/src/components/operating-bill/OperatingBillShell.tsx` | 交付4：解构 `status`/`version` props（原声明未消费），CLOSED 时 nav 下方渲染 `已关账版本（历史口径，只读）`（`role="status"`；version>0 追加 ` · vN`）；DRAFT/未传不渲染 |
| 6 | `…/OperatingBillShell.test.tsx` | "隐藏结账状态"用例迁移为横幅断言（CLOSED+version→`…只读） · v2`；CLOSED 无 version→无 vN；DRAFT/未传→无 status 元素） |
| 7 | `apps/web/src/pages/OperatingBill.tsx` | 交付4：Shell 传 `status`/`version`；bill 查询改全页签启用（横幅全页签可见）；采购复盘页纳入 bill 加载/数据门控与 refresh；提取模块级 `billRequiredFor`/`ledgerTimestamp`（eslint complexity 34→29，max 30） |
| 8 | `apps/web/src/pages/OperatingBillOverview.tsx` | 交付2主战场：①:103-117 "期初余额未登记→补充资金记录"整段删除（AFR-07／遗留③，Link import 保留供 ：119 用量核查提示）；②BillStat 按 `bill.status` 分流——CLOSED 保留期初/充值/期末（暂算）三卡＋"API 花费"/"本月总花费"原标签（数据源零变化），DRAFT 退役三卡、"API 花费"→"API费用估算"（gaps 含 API_COST_UNKNOWN 时 label 附"（含待计价）"，:119 提示段保留）、"本月总花费"→"综合费用（含 API 估算）"（ACE-07）；③厂商表列头按 closed 分流（DRAFT "API费用估算"／CLOSED 保留 "API 花费"）；④:146 拆格：`apiSpendStatus==="BRIDGE_UNAVAILABLE"` → 中性"桥接不可核算（历史资金口径）"，其余 null 值保持 `apiSpendReason ?? "—"`（WP1 合同 §5④ 两域不混格） |
| 9 | `apps/web/src/pages/OperatingBill.test.tsx` | 6 处断言迁移（各注明原因）：首用例改"综合费用（含 API 估算）"＋DRAFT 三卡退役断言；暂算余额用例改"DRAFT 退役暂算卡、冻结旧质量码消息照渲染"；"缺期初余额"用例整体迁为 BRIDGE_UNAVAILABLE（中性说明＋无待补提示＋无 /resources 链接）；"零费用＋旧质量码"用例迁 `status: "CLOSED"`（冻结快照真实可达路径，三卡旧口径保留）；"仍提示登记"用例迁为"历史停产码不再触发登记提示"（AFR-07）；POOL20-039/047 混币用例改新标签＋DRAFT 无资金轨迹卡 |
| 10 | `apps/web/src/components/operating-bill/FinancialLedgerSection.tsx` | 交付5：卡2 "年度用量总花费（实际核算）"→"年度综合费用（含 API 估算）"，副题 "API实际消耗 + 套餐计入费用"→"API 费用估算＋套餐计入费用；币种不可比时不合并"（数据源核实为估算，见 §2）；"仟流内部账本余额"卡退役（grid 5→4）；表列 "API 实际计价消耗"→"API 费用估算"；"月末账本余额"列退役（thead/tbody/tfoot＋colSpan 11→10）；`financialLedgerCsv` headers 同步（"API费用估算"＋删"月末账本余额"，币种列更名"估算币种"）；模型层 `endingBalance` 字段与计算零改动（数据不改写） |
| 11 | `…/FinancialLedgerSection.test.tsx` | 3 处迁移：内部余额卡/列断言改 null＋新列头断言；CSV 断言改"含 API费用估算/估算币种、不含月末账本余额/495.44594516"；多币种用例更名（模型层保守语义断言原样保留） |
| 12 | `apps/web/src/components/operating-bill/OperatingProcurement.tsx` | 交付6：新增 `status` prop（缺省 DRAFT）；API 账户月度复盘表分流——DRAFT 列 [月份/实付（人民币）/API 费用估算]（期初余额/充值到账/期末余额退役，汇总行同步），CLOSED 保留原五列渲染（数据源不变）；年度采购实付表 API 行 "API 充值"→"API 充值（历史）"（对齐 S3 MonthlyPayments）；实付（人民币）保留（现金域 O1a） |
| 13 | `apps/web/src/pages/OperatingBillProcurement.test.tsx` | mock 补 `useOperatingBill` 最小形状（status 可切换）；"分开到账与实付"用例迁为 DRAFT 断言（无期初/充值/期末列头、有实付＋API 费用估算、行内无 ¥20.00）；新增 1 用例：CLOSED 保留期初/充值/期末/API 消耗旧列（AFR-06） |
| 14 | `apps/web/src/components/operating-bill/AccountShared.tsx` | 交付7：MetricGrid "API 消费"→"API 费用估算"（live 行 apiCost=effectiveReportedApiCostSql 同源，WP1 合同 §3） |
| 15 | `…/AccountShared.test.tsx` | label 断言同步（注明 ACE-01） |
| 16 | `apps/web/src/components/operating-bill/SubjectUsageCells.tsx` | 交付7：列头 "API 消费合计"→"API 费用估算合计"；同构措辞清扫："DeepSeek API 消费"→"DeepSeek API 费用估算"（同源估算列） |
| 17 | `…/SubjectUsageCells.test.tsx` | 两列头断言同步 |
| 18 | `apps/web/src/pages/OperatingBillDepartments.tsx` | 交付4：Shell 传 `status={query.data?.status}`（CLOSED 冻结证据 409 机制零改动） |
| 19 | `…/OperatingBillDepartments.test.tsx` | 列头断言 "DeepSeek API 消费"→"DeepSeek API 费用估算" |
| 20 | `apps/control-api/src/usage/routes.ts` | 交付9：CSV 表头 "API费用"→"API费用估算"（1 行＋注释；列宽/列序零变化；无对应后端测试需同步——grep 证实无该表头断言） |
| 21 | *`apps/web/src/components/resources/ProviderFinancePanel.tsx`* | 交付10（S3 移交收口）：摘要卡 "经营成本合计"→"经营成本合计（旧资金口径）"（含 API 分量合成值；"人民币实付"卡保留不动） |
| 22 | *`apps/web/src/components/resources/activation-preflight-model.ts`* | 交付10（S3 移交收口）：`GAP_CATEGORY_LABELS.RECHARGE` "历史 API 充值"→"历史 API 充值（已退役）"（键保留——domain 合同 union 未收缩、Record 类型须全）；`GAP_CODE_LABELS` 删 `MISSING_RECHARGE_AMOUNT`/`MISSING_RECHARGE_CASH_PAID` 两死文案（仅 API 历史充值行可触发，服务端 activation-contracts 已显式拒绝该类草稿；需要时回退服务端 message，与 S3 删 API 期初码文案同法） |

未触碰（核对过）：`BalanceQualityNotice.tsx`（见 §2-4 处置）、`OperatingTrends`/`OperatingPlans`/`ValueRealizationSection`/`MonthlyPayments`（S3 已改）/`ResourceBreakdown.tsx`（S2 已交付，首页面板官方余额列维持"—"降级——总指挥裁定不接通 dashboard-breakdown，零改动记移交确认）、`operating-bill-finance-projection.ts`、packages/database、e2e、其余后端全部文件。

## 2. 各数据源口径核实结论表（动手前逐项核实）

| 数据源 | 核实结论（file:line 证据） | 处置 |
|---|---|---|
| FinancialLedgerSection `apiAccounts[].months[].apiSpend` | **已是估算口径**：`operating-analysis-repository.ts:193-217` S3c 注释＋`loadApiCostEstimation` 注入（:248-271 派生，多币种 null＋complete false）；`:255` 明示"资金域轨迹字段（opening/recharge/paidCny/ending）原样保留" | "API 实际计价消耗"→"API 费用估算"；卡2 措辞改估算口径合法（WP1 合同 §3 末行） |
| 同上 `openingBalance/recharge/paidCny/endingBalance` | **旧资金轨迹口径**（loadResourceFinanceViews，:255 注释；paidCny 为现金实付 O1a） | 台账表保留 "API 现金充值（¥）"（cash_paid）；月末账本余额列＋内部账本余额卡退役（AFR-07 现行视图/导出退出；CLOSED 历史经冻结版本＋历史资金记录入口查看，模型层数据零改写） |
| OperatingProcurement `apiAccounts` | 与上同源（同一 loadOperatingAnalysis：apiSpend 估算、轨迹字段资金口径、paidCny 现金）；且该端点对 CLOSED 月也是实时计算（非冻结）——CLOSED 保留旧列是**展示分流**而非冻结数据 | DRAFT 退役三轨迹列＋"API 消耗"→"API 费用估算"；CLOSED 整表保留原五列＋原列名 |
| BalanceQualityNotice 消费的 `bill.gaps` 码产出 | 现行产出（`operating-bill-finance-quality.ts`）：`monthlyExpenseGaps` → API_COST_UNKNOWN/API_USAGE_COST_NOT_MIGRATED/API_COST_CURRENCY_MISSING/API_COST_CURRENCY_CONFLICT；`balanceQualityGaps`（WP2-S5 后）→ **仅 API_LEGACY_ARCHIVED**（AFR-06 保留）；`apiBalanceGaps`（operating-bill-monthly-cost.ts:17-40）→ API_ENDING_BALANCE_MISSING（"待补期末余额"）/API_CURRENCY_MISMATCH/API_NEGATIVE_BALANCE_BRIDGE；**BRIDGE_UNAVAILABLE 不产任何缺口**（:21-24） | 见下行逐码处置 |
| BalanceQualityNotice 逐码处置 | 组件仅过滤 `API_MONTH_OPENING_COST_UNKNOWN`/`API_BALANCE_COST_UNKNOWN`（notices）＋`API_NEGATIVE_RECONCILIATION_REQUIRED`（negative）——三码对现行期**已停产**（balanceQualityGaps 头注 WP2-S5 明示四码停产） | **零功能改动**：DRAFT 新快照不可达（后端停产＝AFR-07 现行退出已达成）；分支保留供**关账冻结快照**的旧质量码渲染（bill.gaps 对 CLOSED 月来自冻结快照，operating-bill-repository.ts:72-80）——删除分支＝隐藏历史冻结事实，违反 AFR-06/裁定 4"历史保留旧口径"。三个相关组件测试保留并其中 1 例迁 `status:"CLOSED"` 使其落在真实可达路径 |
| `countOperatingExpenseGaps`（standard-home 缺口权威） | 现产：API_USAGE_COST_UNKNOWN、API_COST_CURRENCY_MISSING、API_COST_CURRENCY_CONFLICT、API_USAGE_COST_NOT_MIGRATED、CASH_PAID_CNY_MISSING、SUBSCRIPTION_FEE_MISSING/AMBIGUOUS（SUBSCRIPTION_PERIOD_MISSING 被滤除）；`OPENING_BALANCE_MISSING` 形状保留、count 恒 "0"（provider-finance-gaps.ts:11,33,57-58） | standard-home-model 删该死映射；CASH_PAID_CNY_MISSING 保留（未停产） |
| `ProviderFinancePanel` 摘要卡 operatingCostCny | **含 API 分量合成值**：`provider-finance-repository.ts:271` `operatingCostCny = cnyApi(资金读模型 apiCosts CNY) + planCash` | 加"（旧资金口径）"标注；"人民币实付"卡零改动 |
| Dashboard `mtdCostCard`（FINANCE_READ_MODEL 分支） | `standard-home-model.ts:174-194` 仅渲染 `totalSpends` 金额/同比——**无"本月充值"分量展示**（WP1 合同 §4 裁定 2 的资金读模型充值值未进该卡） | 零改动（回执记录核实结论）；Dashboard 卡 label 加含 API 估算标注（ACE-06/07） |
| usage CSV `totalApiCost` | `usage-repository.ts:310,339,346` 逐行已记录 api_cost（处置投影 effective 值）——与 S2 已改名的用量页列同数据 | 表头改 "API费用估算" |

## 3. 命令与用例数

| 命令（worktree 根） | 结果 |
|---|---|
| `corepack pnpm@11.11.0 --filter @qianliu/web run test` | **94 文件 / 754 用例全绿**（末段连续 3 轮全量 754/754；期间 1 次单例首跑抖动，与 S2 回执记录的 ProviderFinanceActivationWizard 抖动同类，该文件本阶段零 diff）。用例净变化：+1（OperatingBillProcurement 新增 CLOSED 保留列用例），即 S3 基线 753→754 |
| `corepack pnpm@11.11.0 --filter @qianliu/web run lint` | 0 error 0 warning（--max-warnings=0；中途 OperatingBillPage complexity 34>30 曾红，提取模块级辅助函数后 29 通过） |
| `corepack pnpm@11.11.0 --filter @qianliu/web run typecheck` | src 0 错误；全项目仅 6 个 e2e 错误（`e2e/global-setup.ts`/`wt-web.spec.ts` 引用 5 个从未提交 helper——inv §7.2 已知基线缺陷，未触碰） |
| `corepack pnpm@11.11.0 --filter @qianliu/control-api run test` | **65 文件通过＋1 文件 1 例失败：481/482 通过**。唯一失败＝`provider-finance-activation.http.test.ts` AT-AFR-03"业务时间不能晚于当前时间"(400≠201)——**时间敏感既有缺陷**：用例以 `Date.now()+8h` 取北京日期后提交 `T02:00:00Z` 业务时间，本地 00:00–10:00（北京）窗口该时间在未来必 400。已证伪与本阶段关联：还原 `usage/routes.ts` 至 HEAD 版本单跑该文件**同样失败**（1 failed | 14 passed），随后恢复 S4 改动（本阶段 control-api 唯一 diff＝usage/routes.ts 表头字符串） |
| `corepack pnpm@11.11.0 --filter @qianliu/control-api run typecheck` ＋ `lint` | 均 0 错误 |
| 补充：`pool025-operating-bill.test.ts` 单套复跑 | 9/9 通过（S4 分流未回归后端账单集成） |
| 未运行 | e2e（S6）、主仓/数据库包测试（零改动）、任何消息发送、任何库写入 |

## 4. 偏离点及原因

1. **BalanceQualityNotice 零功能改动**（合同交付 3 字面要求"已停产的退役"）：核实其消费的三码对现行期已停产（DRAFT 不可达），但关账冻结快照的 `bill.gaps` 仍可携带旧码——删除分支会把 CLOSED 历史版本的冻结质量事实从界面上抹掉，与同一合同的裁定 4（CLOSED＝历史，保留旧口径渲染＋历史标识）和 AFR-06 冲突；按"现行退出已由后端停产保证、历史渲染保留"处置并在测试中把 1 例迁到 CLOSED 真实可达路径。
2. **CLOSED 厂商表列头保留 "API 花费"**（合同交付 2 的":127 →API费用估算"仅落地 DRAFT）：CLOSED 冻结行的 apiCost 可能是旧资金桥接值（S3b 前关账快照），改名会违反 AFR-06"不将旧余额桥接金额改名冒充估算"；CLOSED 顶部已有历史横幅标识。
3. **OperatingBillPage bill 查询改为全页签启用**：合同只点名 overview 传 status 与 departments 接线；但财务账/价值/套餐/采购页签同属 Shell，CLOSED 横幅应全页签可见，且采购复盘分流需要 status。附带影响：bill 30s 轮询扩展到全部页签、未授权时 bill 401 在所有页签都会触发重定向（语义更严格）；采购页新增等待 bill 数据的门控（避免 CLOSED/DRAFT 列闪切）。
4. **FinancialLedgerSection 选"退役"而非"（旧资金口径）"标注**（合同二选一）：内部账本余额/月末账本余额为资金轨迹口径（核实结论 §2），AFR-07 明文"经营账单和导出中移除……月末内部余额及其待补提示"，年度台账属现行视图＋其 CSV 属导出，故退役；历史资金仍可经 CLOSED 冻结版本与"历史资金记录（旧口径，只读）"入口查看。模型层数据零改写。
5. **`DeepSeek API 消费` 列头一并改估算命名**（合同仅点名 :60 合计列）：同一函数内同源同口径（live 行 effectiveReportedApiCostSql），属 inv §11.7"三页同构措辞清扫"范围。
6. **`OperatingBillEmployeeDetail` "账本 API 计价" 未改**：三页清扫核实其措辞为"账本证据"框定（非 "API 消费" 家族；CLOSED 月为冻结计价证据），改名会有冒充估算风险，记录为观察项不动。
7. **Dashboard.test fixture "期初余额待补" 迁移**（合同未点名）：该 fixture 是资金域待补字样在现行视图的残留展示路径，AFR-07 语义下迁移为透传型 reason（测试目的＝raw 回退行为，保持不变）。
8. **OperatingBill.tsx 复杂度重构**：新增分支触发 eslint complexity（34>30），提取两个模块级纯函数（行为零变化）。

## 5. 剩余问题/移交

1. **control-api AT-AFR-03 时间敏感既有缺陷**（本阶段证伪关联，证据见 §3）：建议由总指挥裁定修复方式（夹具业务时间取"过去时刻"或将 occurs_at 对齐服务端当前时间）。每日 00:00–10:00（北京）内全量必红，S6 复跑窗口需避开。
2. **e2e 基线缺陷维持**（S2/S3 移交）：`wt-web.spec.ts` 引用 5 个从未提交 helper，`test:e2e` 不可运行；typecheck 6 个 e2e 错误同源。S6 前需用户裁定 helper 处置；届时需补"已关账版本（历史口径，只读）"横幅、DRAFT 退役三卡、BRIDGE_UNAVAILABLE 中性说明的浏览器断言。
3. **ResourceBreakdown 首页面板官方余额列**：按总指挥裁定维持 S2 降级 "—"（未接通 dashboard-breakdown 后端字段）；资源列表页已完整展示——本阶段确认零改动，记移交归档。
4. **`POST /provider-resources/:id/purchases`** 后端仍可写（WP2 域，S3 移交项维持）。
5. **`wt-web.spec.ts:61` "充值与订阅" 字样**仍在坏 spec 内（不碰 e2e，S3 移交项维持）。
6. **员工/项目/部门页 CLOSED 月列头**：live 行语义同源估算故统一命名；CLOSED 冻结行的列头未按月分流（与厂商表不同）——已由 Shell 历史横幅整体标识，若总指挥要求列级旧口径标注再裁定。

## 6. 证据（关键输出行）

- web：`Test Files  94 passed (94)` / `Tests  754 passed (754)`（末段连续 3 轮一致，2026-11-04）。
- web lint：`eslint src --max-warnings=0` 无输出；web typecheck：`grep "error TS" | grep -v e2e` 计数 0。
- control-api：`Tests  1 failed | 481 passed (482)`，唯一失败为既有时间敏感用例；HEAD 版本 usage/routes.ts 单跑该文件复现同一失败（`Tests  1 failed | 14 passed (15)`）；pool025 `9 passed (9)`。
- control-api typecheck/lint：0 错误。
- 工作树：`git status --short | grep -v "^??" | wc -l`＝59（39 基线＋S3 已计入的 22 中部分＋S4 新改 22 项中的新增文件；2 个 D 维持）；`git diff --stat` 全量 57 files / +1081/−678（含 S2/S3 累计）。
- 后端停产证据：`packages/database/src/repositories/provider-finance-gaps.ts:11,33,57-58`（OPENING_BALANCE_MISSING 恒 0）；`monthly-operating-cost.ts:200-203`（BRIDGE_UNAVAILABLE：apiSpend 恒 null、reason null、不产资金缺口）；`operating-bill-finance-quality.ts:27-31`（四资金质量码停产，API_LEGACY_ARCHIVED 保留）；`operating-bill-monthly-cost.ts:17-24`（apiBalanceGaps 对 BRIDGE_UNAVAILABLE 返回空）；`operating-analysis-repository.ts:193-217,248-255`（apiSpend=估算、轨迹字段保留）；`provider-finance-repository.ts:271`（operatingCostCny 合成）。
