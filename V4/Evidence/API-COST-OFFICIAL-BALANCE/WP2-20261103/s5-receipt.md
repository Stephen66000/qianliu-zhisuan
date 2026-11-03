# WP2-S5 回执：缺口码统一＋finance 开路径金额权威（task 4.1 收口＋WP1 移交裁定 1/2）

日期：2026-11-03；子 Agent：GLM-5.3-Flash（WP2-S5）；基线：worktree `/Users/mac/Projects/仟流智算-api-decouple`，分支 `codex/simplify-api-cost-and-official-balance`（S2/S3/S4 产物在位未动：0094、resource-pool-repository、routes/events/activation 系列、gateway wp2-pending-admission 等均未回退，`git status` 核对）。依据：WP2/plan.md §4.5/§4.6＋§4a/§4b、WP1/api-estimation-contract.md §1＋§4 裁定 1/2、inv-wp2.md §4、specs AFR-07＋ACE-04/06/07、总指挥 S5 中途裁定（BRIDGE_UNAVAILABLE）。

## 0. 总指挥中途裁定落实

1. 三处相邻测试迁移批准 → 已按批准执行（见 §2 标注"相邻批准"）。
2. A2 语义修正 → 已落实：期初事实缺席 → 状态 `BRIDGE_UNAVAILABLE`（新增枚举成员，注释注明 AFR-07/WP2 plan §4.5）、apiSpend 恒 null、apiSpendReason 恒 null、不产任何资金缺口/提示；NEGATIVE_BALANCE_BRIDGE/CURRENCY_MISMATCH 仅在期初事实齐全时参与；期初齐全时全部分支与旧口径逐字节一致。**消费方核实清单**（ApiSpendStatus 全部读点）：
   - `monthly-operating-summary.ts:27/:60-61`（firstIncomplete ≠ CALCULABLE → 汇总 fail-closed，状态值透传）；
   - `operating-bill-monthly-cost.ts` apiBalanceGaps 门控（BRIDGE_UNAVAILABLE 加入恒空早退，不产缺口）、monthlyProviderCostFields/monthlySummaryFields（状态值透传至 providers/summary）；
   - `dashboard-home-costs.ts:121-131` bridgeIncompleteReason 与 `dashboard-home.ts:36-44` billIncompleteReason（非 CALCULABLE/NOT_APPLICABLE → 走 apiSpendReason（null）→ 通用文案"同期 API 费用不完整"/"本期费用缺少可计算事实"，无资金待补字样）；
   - `balanceBridgeFacts`（冻结快照 sourceFacts 透传，历史已关账版本零触碰）；
   - dashboard-repository/summarizeDashboardMonthlySpend、dashboard-breakdown（只消费 ledgerApiCost/packageCost，不消费状态位）；
   - `apps/control-api/src/resource-insights/routes.ts:232` 的 `notCalculableReason` 消费 account.balanceState（资金读模型字段，未在本次范围；其 `API_FINANCE_ACCOUNT_NOT_UNIQUE` 兜底串为存量展示兜底，无测试钉死，**留 WP4**）；
   - web `OperatingBillOverview.tsx:105`（string 比较，WP4 范围）。
3. B 块独立路径确认：finance 投影 apiSpendStatus/Reason 已切估算口径（INCOMPLETE/CALCULABLE），与桥接状态位互不引用。

## 1. 生产改动（允许清单内）

| 文件 | 意图 |
|---|---|
| `packages/database/src/repositories/provider-finance-gaps.ts` | A1：`countFinanceGaps` 停产 OPENING_BALANCE_MISSING——删除该码 SQL 计数段，两处返回点保留 `{code:"OPENING_BALANCE_MISSING",count:"0"}`（保形状，位置与退役前一致）；`API_USAGE_COST_*`/`API_COST_CURRENCY_*` 与 `SUBSCRIPTION_PERIOD_MISSING`/`CASH_PAID_CNY_MISSING` 原计数保留；UNION 首列补回 `AS code` 别名（防列名漂移）；头注注明 AFR-07＋WP1 裁定 1。`countOperatingExpenseGaps` 不动 |
| `packages/database/src/repositories/monthly-operating-cost.ts` | A2：状态位 OPENING_BALANCE_MISSING（原 :183 分支）与文案"待补期初余额"（原 :120）停产；新增 `BRIDGE_UNAVAILABLE` 成员（总指挥裁定）；期初事实（balance/currency/at 任一 null）→ BRIDGE_UNAVAILABLE＋apiSpend null＋reason null；期末缺失/CURRENCY_MISMATCH/NEGATIVE_BALANCE_BRIDGE 分支照旧（期初齐全时与旧口径逐字节一致）；桥接金额字段（opening/recharge/ending）照常产出（裁定 2，WP4 处置） |
| `packages/database/src/repositories/operating-bill-monthly-cost.ts` | apiBalanceGaps：OPENING_BALANCE_MISSING 映射恒空（结构保留）；BRIDGE_UNAVAILABLE 加入早退（不产资金缺口，AFR-07 不据此阻断账单）；estimatedApiCostFields/月度字段函数不动 |
| `packages/database/src/repositories/operating-bill-finance-quality.ts` | balanceQualityGaps：API_OPENING_BALANCE_MISSING/API_BALANCE_COST_UNKNOWN/API_NEGATIVE_RECONCILIATION_REQUIRED/API_MONTH_OPENING_COST_UNKNOWN 资金域质量码当前期停产；API_LEGACY_ARCHIVED 保留（AFR-06 反控制，含月初前未计价历史说明） |
| `packages/database/src/repositories/operating-bill-finance-projection.ts` | B：API providers 行 apiCost/ledgerApiCost/totalCost/apiSpendCurrency 改由 `loadApiCostEstimation`（按资源）＋`estimatedApiCostFields` 供给（S3b 模式：按资源逐调用＋全企业一次）；summary apiCost/ledgerApiCost/apiSpends 切估算；totalSpends＝估算 apiSpends＋CP packageCosts 分组、totalCost 估算完整时才出 scalar；apiSpendStatus/Reason 切估算完整性口径；missingAccountGaps 段退役（hasExpenseFacts 函数随之删除）；**保留不动**：CP providers 投影、allocatePlanCostsByCalendarMonthTokens 全部（含 API_LEGACY_COST_ADJUSTMENT 未归属行）、桥接字段（opening/recharge/ending/provisionalEndingBalances）、archivedExpenseGaps、retainedGaps 排除结构、切账前月份（end≤CUTOVER）完整性仍由 API_LEGACY_ARCHIVED 驱动（AFR-06"保留原历史金额及其标签"） |

## 2. 测试迁移（逐断言表：旧→新＋依据）

### A. 钉死套件（合同指名）
| 文件:行 | 旧 | 新 | 依据 |
|---|---|---|---|
| standard-home.integration.test.ts:976 | `toContain("OPENING_BALANCE_MISSING:2")` 正控 | `not.toContain("OPENING_BALANCE_MISSING")` | AFR-07＋plan §4.5（恒 0 停产；其余五码 :972-974/:977-978 正控与 :980-987 反控/窗外控制原样绿） |
| standard-home :447-449 | API_USAGE_COST_UNKNOWN/CASH_PAID_CNY_MISSING contains | 不动 | 用量/现金缺口保留 |
| finance-period-cost-integrity :104 | not.toContain API_OPENING_BALANCE_MISSING | 不动（语义照旧，恒真）＋新增三类资金码缺席断言 | AFR-07 |
| finance-period-cost-integrity :96/:141 | totalSpends `[{CNY,0}]` | `[]` | B（估算空分列＋精确 0 标量，ACE-04） |
| finance-period-cost-integrity :100-109 | gaps 含 API_BALANCE_COST_UNKNOWN/API_MONTH_OPENING_COST_UNKNOWN＋消息细节 | gaps 缺席断言＋`toEqual([])` | 资金域质量码当前期停产（AFR-07） |
| finance-period-cost-integrity :120/:124/:132 | apiSpendReason "API_COST_UNKNOWN" | "PRICE_MISSING:1"（UNKNOWN_COST 状态行＝用量已知价格缺失） | B（估算缺口码口径，ACE-04 场景1） |
| finance-period-cost-integrity :124 | apiCost null | "3.25000000"（已知部分照出） | ACE-04"展示已计价部分＋缺口说明" |
| finance-period-cost-integrity :161 | apiCost null | "2.00000000"（缺币种行不入桶不阻止 CNY 已知部分） | ACE-04/07 |
| finance-period-cost-integrity :173（:168-177 切账前 8 月） | apiSpendReason "API_LEGACY_ARCHIVED" | **不变** | preCutoverMonth 完整性仍由 archivedExpenseGaps 驱动（AFR-06） |
| finance-period-cost-integrity :202-203/:247-249/:256-257 | apiSpendReason "API_USAGE_COST_NOT_MIGRATED" | "NOT_MIGRATED:1" | B（估算缺口码） |
| finance-period-cost-integrity :203 | totalSpends `[{CNY,42}]`/`[{CNY,37.2501}]` | `[]` | B（估算分列；历史聚合金额不再并入 summary，AFR-06 域经 gaps/只读历史入口保留） |
| finance-period-cost-integrity :209-210 | apiCost null＋reason "API_OPENING_BALANCE_MISSING" | "0.00000000"/"0.00000000"/CALCULABLE/reason null | AFR-07 场景1（9 月零来自空估算窗口，非 10 月期初推定） |
| finance-period-cost-integrity :228-229 | gaps toContainEqual API_OPENING_BALANCE_MISSING | not.toContain | AFR-07 场景1 |
| finance-period-cost-integrity :271-272 | apiCost "37.25010000" CALCULABLE | null/INCOMPLETE/"NOT_MIGRATED:1"/[] | B＋WP1 裁定 1（历史聚合覆盖属缺口段权威 loadApiCostGaps；金额段权威估算） |
| home-cost-comparison | （:80/:97/:112/:174/:205/:223 核对） | **零改动** | 用量/套餐缺口保留；OPENING_BALANCE_MISSING 在该套件本就不出现（实跑验证） |
| provider-finance-gaps.test.ts | 六码全 0 形状 | 形状不变＋恒 0 注释 | A1 保形状 |
| operating-bill-resource-scope :117-119 | gaps 含 API_OPENING_BALANCE_MISSING（有账户归档资源） | `gaps = []` | 资金码停产＋retainedGaps 对资金覆盖资源排除快照/桥接旧码（既有排除表）；资源与费用保留语义由 :114-116 承担 |

### B. 相邻批准/同性质迁移（逐处注明）
| 文件 | 迁移 | 依据 |
|---|---|---|
| monthly-operating-cost.test.ts（单测，相邻批准） | it.each 三例 OPENING_BALANCE_MISSING→BRIDGE_UNAVAILABLE；:180-195/:229-239/:324-340 合成状态位同步；fail-closed（apiSpends/totalSpends 置空、apiSpend/totalSpend null）保持 | A2＋总指挥裁定 |
| operating-bill-monthly-cost.test.ts（单测，相邻批准） | 映射结构断言保留（恒空语义注释） | A2"结构保留" |
| api-cost-readers-alignment.integration.test.ts（相邻批准） | :179 incompleteReason "OPENING_BALANCE_MISSING:1"→null；:120-129 期初插入改为反控制 | A1（ACE-03 场景1 正面语义） |
| operating-feedback.integration.test.ts | :147/:156 apiCost null→"2.50000000" | B（ACE-04 已知部分不隐藏；用例名"cannot hide known spending"语义增强） |
| provider-finance-cutover.integration.test.ts | :247-249 apiSpends 5.00→1.00 | B（估算只计已计价行；+4 遗留调整不并入金额段，AFR-06 域经 gaps/home 窗口保留） |
| pool025-operating-bill.test.ts（control-api，合同指名 :709-722） | summary OPENING_BALANCE_MISSING/"待补期初余额"→BRIDGE_UNAVAILABLE/null；gaps arrayContaining API_OPENING_BALANCE_MISSING→缺席＋OPERATING_SNAPSHOT_MISSING 正控（7 月关账 409 阻断由无快照缺口承担）；:282 补录前 BRIDGE_UNAVAILABLE | A2＋AFR-07 |
| w20-resource-insights.test.ts（control-api，同性质第 4 例） | :743 apiSpendReason "待补期初余额"→null | A2（resource-insights 消费桥接 reason） |
| pool043-operating-bill-settlement.test.ts（gateway，合同 C 块补遗） | expectUnknownApiCostBill 参数化：summary apiCost/totalCost→已计价部分金额（中断零用量场景 null；failover 场景 "0.00007700"）；资源级按自身账本行估算切分（fixture 资源自身 UNKNOWN 行→null；secondResource 已计价行 "0.00007700" 逐字断言，DRAFT 与 CLOSED 冻结各一）；subjects 保持 usage 事实口径 null（knownAmount fail-closed，不冒充已知）；gaps 仍含 API_COST_UNKNOWN | ACE-04＋WP1 合同 §1＋WP2 plan §4b S2 复审记录 1（WP1 验证缺口补遗）；注：合同"subjects→已计价部分金额"与实测不符——subjects 为主体行 usage 事实口径（含未知行即 null），按实际迁移并在此注明 |
| wp2-finance-mode-parity.integration.test.ts（**新增**，AT-X01/AT-X05 机制层） | 同企业同期间同批消费：strict_writes 关（OFF）与开（ACTIVE）两路径 draft apiCost/apiSpends/资源级 apiCost 逐字面值相等（"12.34000000"）＋INCOMPLETE/PRICE_MISSING:1 口径一致＋四类资金码两路径均缺席；关账冻结后改账本（7.77→99.99）＋切资金模式，读取仍返回冻结内容 | WP2 plan §4.6/§6-5（金额同源可核对；已关账零变化） |

### 未改动（核对为零）
- 激活域（S4 产物）、W5-W8/O1a-O2（S3）、countFinanceGaps 激活消费（S4 已过滤）、web（WP4）、worker/官方余额（WP3）、已关账快照内容、resource-insights/routes.ts:232 存量兜底串（WP4）、home-cost-comparison 断言。

## 3. B 块 apiSpendStatus 新口径精确取值定义（供 WP4 对照）

**finance 投影路径（strict_writes 开）——估算完整性口径：**
- `CALCULABLE`：企业级估算 completeness ∈ {KNOWN_COMPLETE, ZERO_CONFIRMED}（含期间无行）；apiSpendReason=null。资源行同（按资源估算）。
- `INCOMPLETE`：completeness=KNOWN_PARTIAL；apiSpendReason=`apiEstimationGapText(gaps)`＝估算缺口码 `<REASON>:<count>` 顿号串联（REASON ∈ NOT_MIGRATED/USAGE_UNKNOWN/PRICE_MISSING/CURRENCY_MISSING；PRICE_BASIS_UNVERIFIED 不参与）。金额语义：单币种已知部分照出（apiCost=金额字面值）、多币种或 KNOWN_PARTIAL 无金额→null、空且非 KNOWN_PARTIAL→精确 "0.00000000"（estimatedApiCostFields）。totalCost 仅 CALCULABLE 时产出（不把纯套餐合计伪装成总费用）。
- 切账前历史月份（end ≤ 2026-08-31T16:00Z）：完整性仍由 API_LEGACY_ARCHIVED 驱动，reason="API_LEGACY_ARCHIVED"（AFR-06 旧口径标签）。

**draft/桥接读模型路径（finance 关）——桥接可算性口径（总指挥裁定后成员集）：**
- `CALCULABLE`：期初＋期末事实齐全、币种一致、桥接值非负；apiSpend=期初+充值−期末（与旧口径逐字节一致）。
- `BRIDGE_UNAVAILABLE`（新增）：期初事实缺席（balance/currency/at 任一 null）——apiSpend 恒 null、apiSpendReason 恒 null、不产任何资金缺口/提示（AFR-07：无资金待补含义，WP4 处置展示）。
- `ENDING_BALANCE_MISSING`（"待补期末余额"）/`CURRENCY_MISMATCH`（"期初余额、本月充值与期末余额币种不一致"）/`NEGATIVE_BALANCE_BRIDGE`（"余额桥接结果为负…"）：仅期初事实齐全时参与，语义与文案照旧。
- `NOT_APPLICABLE`：CP 行（不变）；`OPENING_BALANCE_MISSING`：停产，枚举成员仅为消费方形状保留。

## 4. 命令、退出码、用例数

| 命令 | 结果 |
|---|---|
| `corepack pnpm@11.11.0 --filter @qianliu/database run test:integration` | **Test Files 75 passed + 1 failed（w20-standard-capacity P95）(76) / Tests 566 passed, 1 failed (567)**，退出码 1（仅既有 flake；该用例隔离复跑 2/2 绿，S2 复审已记录为"本机负载型既有 flake，不阻塞"） |
| `corepack pnpm@11.11.0 --filter @qianliu/control-api run test:integration` | **Test Files 42 passed (42) / Tests 352 passed (352)**，退出码 0（含 pool025 9/9、w20-resource-insights 9/9） |
| `corepack pnpm@11.11.0 --filter @qianliu/gateway exec vitest run src/__tests-integration__/pool043-operating-bill-settlement.test.ts` | **Tests 9 passed (9)**，退出码 0 |
| `--filter @qianliu/gateway run test:integration`（全量，健康卫生） | **Test Files 29 passed + 1 failed（employee-monthly-quota 并行负载 flake）(30) / Tests 240 passed, 1 failed (241)**；该失败用例隔离复跑 20/20 绿（与本机负载 flake 家族同源，非本包改动域——本包 gateway 侧仅迁移 pool043 测试断言）；pool043 在全量跑中 9/9 绿 |
| `--filter @qianliu/database exec vitest run src/repositories/provider-finance-gaps.test.ts monthly-operating-cost.test.ts operating-bill-monthly-cost.test.ts` | **Tests 24 passed (24)**，退出码 0 |
| 三包 typecheck（tsc --noEmit） | 退出码均 0 |
| 三包 lint（eslint --max-warnings=0） | 退出码均 0 |

## 5. 偏离与边界记录

1. 相邻迁移第 4/5 例（operating-feedback、provider-finance-cutover、w20-resource-insights）超出中途批准的 3 文件清单，但与批准模式完全同性质（A1/A2 生产改动的直接同源断言迁移，见 §2B 表），已实施并在本回执报备；如需回滚请指示。
2. pool043 subjects 断言：合同预期"subjects 的 apiCost/totalCost→已计价部分金额"，实测主体行为 usage 事实口径（含未知行恒 null，knownAmount fail-closed）——按实际迁移（null）并注明，未改生产代码凑绿。
3. `pool043` 资源级金额按资源自身账本行估算切分：fixture 资源自身全 UNKNOWN 行→资源级 null，已计价部分 0.00007700 落在 failover secondResource 资源行——两行均逐字断言（DRAFT＋CLOSED 冻结各一次）。
4. finance 投影 summary 不并入 API_LEGACY_COST_ADJUSTMENT/API_HISTORICAL_USAGE_COST 遗留金额（合同 B 的组合即"估算 apiSpends＋CP packageCosts"）；遗留金额可见性经 gaps 的 API_LEGACY_ARCHIVED 与 home 同期窗口（loadWindowOperatingFinance 遗留并入，未动）保留——WP4 页面如需并读两条来源，属其处置范围。
5. `apps/control-api/src/resource-insights/routes.ts:232` 存量 `notCalculableReason` 兜底串 `API_FINANCE_ACCOUNT_NOT_UNIQUE`（非本包允许清单，无测试钉死）——留 WP4/后续处置，仅记录。
6. web `OperatingBill.test.tsx` 夹具仍供"待补期初余额"合成字符串（组件级 mock）——web 属 WP4，未触碰。

## 6. 遗留与移交

- w20-standard-capacity P95 本机负载 flake（与 WP1 §4.2-4/S2 复审记录同源）；gateway employee-monthly-quota 全量并行负载 flake（隔离 20/20 绿）。
- WP4：web 层 `costGapLabel` 的 OPENING_BALANCE_MISSING 映射、`OperatingBillOverview.tsx:105` 的 apiSpendStatus==="OPENING_BALANCE_MISSING" 分支与"期初余额未登记"横幅、resource-insights routes 兜底串、桥接列（BRIDGE_UNAVAILABLE 行）展示处置。
- WP5：金额核对以 loadApiCostEstimation 为唯一基准（WP1 合同 §5），本包 B 后 finance 开/关两路径金额已同源（AT-X01 用例）。

## 7. 证据文件

- 本文件；`git diff`（生产 5 文件＋测试迁移）；新增用例 `packages/database/src/__tests-integration__/wp2-finance-mode-parity.integration.test.ts`；运行日志 `/tmp/wp2s5-database-final.log`、`/tmp/wp2s5-control-final.log`、`/tmp/wp2s5-gateway.log`（关键计数摘录见 §4/复审栏）。
