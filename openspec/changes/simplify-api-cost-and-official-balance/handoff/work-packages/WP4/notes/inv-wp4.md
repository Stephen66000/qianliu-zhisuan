# WP4 S1 只读调查笔记（inv-wp4）

调查人：glm-flash（只读子 Agent）；日期：2026-11-03。
基线：worktree `/Users/mac/Projects/仟流智算-api-decouple`，分支 `codex/simplify-api-cost-and-official-balance`，HEAD `745dae4`。
开工 `git status` 实录：工作树干净，唯一未跟踪文件为本包 `plan.md`（预期内，未提交）。全程零业务文件改动，仅新建本笔记。

证据均以 `file:line` 标注；行号基于 HEAD `745dae4` 的工作树。标注「未核实」处为静态读码无法确证、需运行时验证的点。

---

## 0. 快速结论表（S2-S5 直接可用的判断）

| # | 结论 | 关键证据 |
|---|---|---|
| 1 | C2 `official_balance` 后端已下发，web 客户端类型与刷新端点调用**均未接线** | `apps/control-api/src/providers/routes.ts:330`；`apps/web/src/api/types.ts:143-185`（无该字段）；全 web 源码 grep `official-balance` 零命中 |
| 2 | WP2 遗留①：`OPENING_BALANCE_MISSING` 映射已**后端停产**，web 残留为死映射＋测试锚点 | 后端 `packages/database/src/repositories/monthly-operating-cost.ts:130`、`provider-finance-gaps.ts:11`；web `standard-home-model.ts:87` |
| 3 | WP2 遗留②：`projectFinanceUtilization` 兜底串在 `resource-insights/routes.ts:212-244`，web 消费方 `ResourceUtilizationPanel.tsx` 不渲染 balance/recharge，但 ：109 费用列无估算命名与完整性标注 | `routes.ts:222-224`；`ResourceUtilizationPanel.tsx:109` |
| 4 | WP2 遗留③：`OperatingBillOverview.tsx:103-117` 的"期初余额未登记→补充资金记录"提示消费已停产码；新状态 `BRIDGE_UNAVAILABLE` web 完全未处理（落到 `—`） | `OperatingBillOverview.tsx:103-117,146`；后端 `monthly-operating-cost.ts:200-203`（BRIDGE_UNAVAILABLE、reason=null） |
| 5 | 资源列表"资金列"仍展示内部本月充值/余额/API 成本——D5 要求移除 | `apps/web/src/components/resources/resource-page-display.tsx:4-28` |
| 6 | "充值与订阅"命名集中在 3 个文件；API 充值写表单两处（ProviderFinancePanel API 分支＋账单页 RechargeEntry）；RechargeEntry 走 `POST /provider-resources/:id/purchases`（**不在 WP2 退役 19 入口内**，前端退役后端仍可写） | `ResourceTabs.tsx:11`；`ProviderFinancePanel.tsx:184,192,217-238`；`ResourceOnboardingSection.tsx:325,328`；`OperatingBillRechargeEntry.tsx:21-148`；`department-costs/routes.ts:219-243` |
| 7 | **web e2e 主 spec 当前是坏的**：`wt-web.spec.ts` import 5 个不存在于 HEAD/工作树的 helper（历史从未提交）；S6 浏览器证据前必须处置 | `apps/web/e2e/wt-web.spec.ts:10-14`；`git ls-tree HEAD apps/web/e2e/` 仅 7 文件 |
| 8 | e2e seed 缺估算/C2 夹具：ledger_line 无 `settled_at`（估算半开窗取不到）、快照无 `balance_source='PROVIDER_API'`、无 sync_attempt 行、billing_rule 无 `source_status` | `seed-e2e.ts:249-309`；`seed-e2e-pool043.ts:93-137`；`seed-e2e-pool042.ts:87-99`；schema `migrations/0051...:17`（balance_source 可空） |
| 9 | 报表/通知：worker 报表模板（周报/月报/日报/激励 SVG）**全部纯 Token/额度**，零改动白名单；发送配置在 `reporting/delivery.ts`＋`packages/config/src/index.ts:178`，不碰 | `templates/company-weekly-svg.ts:23-41`；`company-report-presentation.ts`（6 指标全 Token） |
| 10 | 已关账（CLOSED）在 web **无任何版本/状态标识**：Shell 组件有 status/version props 但主页面不传不渲染 | `OperatingBillShell.tsx:70-78`（props 存在）；`OperatingBill.tsx:57`（未传）；`OperatingBillDepartments.tsx:29`（类型有、无渲染） |

---

## 1. 资源/用量/请求明细页面数据流（S2 主战场）

### 1.1 页面组装链

- `apps/web/src/pages/Resources.tsx:10-26`：`ResourceTabs`（:14，`showFinance = providerFinanceMode !== "OFF"`）→ utilization Tab 渲染 `ResourceOnboardingSection`＋`ResourceDialogs`＋`ResourceTable`；其余 Tab 在 `ResourceOtherTabs`。
- finance Tab 挂载点：`apps/web/src/components/resources/ResourceOtherTabs.tsx:76-80` → `FinanceInitializationPanel`。
- 页面模型：`apps/web/src/pages/resources-page-model.ts:21-22`（`useProviderFinanceMode`＋`useResourceTab(mode!=="OFF")`）。

### 1.2 API 费用展示点（现名 → 需改"API费用估算"＋完整性）

| 位置 | 现名/现状 | 数据源 |
|---|---|---|
| `components/usage/UsageOverviewPanel.tsx:36`（指标卡）、`:48`（排名表头 `API 费用`）、`:50`（行值） | "API 费用"；缺失走 `unavailableUsageCostLabel` | `GET /usage/overview`（`v2-types.ts:90-120`，`apiCost`/`apiCostStatus`） |
| `pages/Usage.tsx:440` | 表头 "API 费用" | `GET /usage` 列表 |
| `components/usage/UsageRow.tsx:35` | 展开行费用缺失文案 | 同上 |
| `pages/RequestDrilldown.tsx:74-81`（结算汇总 "API 费用"）、`:210-213`（Attempt 计量 "· 费用 X 元"）、`:263-265`（"最终费用"） | 金额前缀固定 `¥`（:79、:211、:263 硬编码人民币符号，币种字段存在但不展示——混币/币种标注缺口） | `gateway-requests` 读模型（`apps/control-api/src/gateway-requests/routes.ts:66,149,166`） |
| `components/resources/ResourceUtilizationPanel.tsx:109` | "API 花费不可计算"/`currency apiCost`，**无完整性/缺口/价格依据标注** | `GET /provider-resources/utilization`（`v2-hooks.ts:158`；后端 `resource-insights/routes.ts:30-72`） |
| `components/dashboard/ResourceBreakdown.tsx:61` | `monthlyCostReason ?? "API 花费不可计算"` | `GET /provider-resources/usage-overview`（`hooks.ts:192-200`） |

- 缺失文案工具：`apps/web/src/lib/usage-cost.ts:2-11`（`NOT_MIGRATED`/`EXCLUDED_NO_RECORDED_COST`/`NOT_APPLICABLE`/`UNKNOWN_COST`/null→"未知"）。**没有** `PRICE_BASIS_UNVERIFIED`/`PRICE_MISSING`/`CURRENCY_MISSING` 分支；全 web 源码 grep `PRICE_BASIS_UNVERIFIED` 零命中（价格依据待核实角标完全未实现，ACE-02 场景3/AT-ACE-04 落点）。
- 币种：UsageOverview 类型有 `apiCostStatus` 但无多币种分列字段；`usage_cost` 币种在 CSV 导出（`control-api/src/usage/routes.ts:164`）有 "币种" 列，页面无。

### 1.3 内部余额/期初/充值/资金就绪展示点（API 分支，需退场）

| 组件 | 内容 | 证据 |
|---|---|---|
| `resource-page-display.tsx` `ResourceFinanceColumn` | API 分支：`本月充值`/`余额`（balanceState 或金额）/`本月 API 成本`（资金读模型 `resource.finance.accounts`）；无 finance 时 "资金账本未启用" | :4-28（:12-14 API 三行；:27 fallback） |
| `ResourceTable.tsx` :84 | 列渲染 `ResourceFinanceColumn`；:91-107 同步快照版本/时间（`operating_sync` 余额/费用状态在 title 提示 :93-94——旧 operating_sync 通道） | — |
| `ResourceBreakdown.tsx` :34 列头 "余额 / 剩余额度"；:54-56 API 分支 `currentBalance===null → "余额待补"` | 内部余额＋"待补"提示 | :34,:54-56；类型 `reporting-types.ts:13-32`（`rechargeAmount`/`currentBalance`） |
| `FinanceInitializationPanel.tsx` | strict_writes_enabled false→`ProviderFinanceActivationWizard`（含 API 期初草稿）；true→`ActivationReceiptPanel`＋`ProviderFinancePanel` | :98-124 |
| `ActivationDraftEditor.tsx` | 草稿六区含 `apiOpeningBalances`（:325-361 "添加期初行"/补齐必要账户）、`historicalApiRecharges`（:363-379）、历史消耗；`activation-draft-state.ts:101-114`（区标签 "API 期初余额"/"历史 API 充值"/"历史 API 消耗"）；`activation-preflight-model.ts:30,43-46`（期初缺口码文案）；`ProviderFinanceActivationWizard.tsx:196`（"请补齐 API 期初、历史充值…"） | WP2-S4 已在服务端拒绝 API 期初草稿（`provider-finance/activation-routes.ts:56`），前端草稿区仍全量可编辑 |
| `ProviderFinancePanel.tsx` | API 分支：摘要卡 "API 经营成本"/"当前 API 余额"（:204,:207-210）、充值表单 "API 充值" 类型钮（:217）、"当前余额"（:230）、"充值金额"/"充值时间"（:236,:238）、`useRecordProviderFinance` kind="API" → `POST …/finance/recharges`（**W4，已 410**） | :102-107,:215-242；`api/provider-finance.ts:94-105` |

### 1.4 C2/刷新端点接线现状（S2 核心增量）

- 后端：`GET /provider-resources` 每资源附 `official_balance`（`providers/routes.ts:330`，位于 `operating_snapshot` :329 与 `finance` :331 之间）；形状＝`OfficialBalanceState`（`packages/database/src/repositories/official-balance-states.ts:18-39`：`supported/status/expired/last_attempt_failed/total_balance/currency/composition{granted,topped}/available/last_success_at/last_attempt{at,outcome,reason}/next_refresh_at`；status 六值 :13-15）。状态矩阵见 WP3 `receipts/s4-receipt.md` §3。
- 手动刷新：`POST /provider-resources/:id/official-balance/refresh`（WP3 ops-runbook §3：三态 200 `{state, retry_after_seconds?}`；422/409/404 分支；权限 resources.operate）。**web 无任何调用**（grep `official-balance` 零命中）。
- web 客户端类型缺口：`ProviderResourceItem`（`api/types.ts:143-185`）无 `official_balance` 字段；`useProviderResources`（`api/hooks.ts:181-190`）取数层无需改路径，只需类型扩展＋新刷新 mutation hook（建议放 `api/hooks.ts` 或新文件，QUERY_KEYS :55-62 已有 providerResources 命名空间可复用失效）。
- 参考 precedent：quota-sync 手动同步 hook（`hooks.ts:226-236`）的模式（mutation＋invalidate providerResources）可直接复制为刷新按钮实现。

### 1.5 请求明细价格依据

- 后端已回传逐行 `api_cost_status`（`gateway-requests/routes.ts:149,166`）与结算 `apiCostStatus`（:66）；billing rule 合同字段 `source_status`（WP1 合同 §2）在 web 无消费点。AT-ACE-04 "价格依据待核实角标" 需要后端在请求明细/估算读取中透出 `priceBasis[].sourceStatus` 或 gap 码（WP1 `loadApiCostEstimation` 返回已有 `priceBasis`（合同 §1），但请求明细路由未透出——**未核实**是否有现成字段；S2 前先与 WP1 合同 §5 ②核对数据可得性）。

---

## 2. WP2 三项遗留精确改法

### ① `standard-home-model.ts:87` OPENING_BALANCE_MISSING 映射

- 定义：`apps/web/src/components/dashboard/standard-home-model.ts:87` `["OPENING_BALANCE_MISSING", "有账户缺少期初余额"]`，属 `COST_GAP_LABELS`（:80-92），由 `costGapLabel()`（:94-99）按 `reason.includes(code)` 匹配。
- 消费链：`buildOverviewCards()` :237/:243/:257（费用卡缺口文案）→ 唯一页面消费方 `pages/Dashboard.tsx:65`（`buildOverviewCards`）→ 卡片 footnote/emptyText（`Dashboard.tsx:100-109` 本月费用卡）。
- 数据源：`StandardHomeSummary.monthlyCost.current/previous.incompleteReason`（`api/reporting-types.ts:231-242`），由后端 `countOperatingExpenseGaps`（资金域权威，WP1 合同 §4 裁定 1）产出。
- 后端现状：`OPENING_BALANCE_MISSING` 已停产——`packages/database/src/repositories/provider-finance-gaps.ts:11`（"随 API 内部资金管理退役而停产——恒 0"）；`monthly-operating-cost.ts:130,193`（同口径）。即**现行视图后端已不再产出该码**，web :87 映射成为死代码。
- 正确改法（建议）：从 `COST_GAP_LABELS` 删除 :87 行（现行视图退出该提示）；`costGapLabel` 的 fallback 是原码字符串（:98），删除映射后若历史快照/关账版本经同一函数渲染会露出裸码——但 `costGapLabel` 当前只被 Dashboard 现行视图消费（grep 证实），**已关账历史不经此函数**（账单页直接渲染 `apiSpendReason`/`gap.message`），因此删除 :87 不影响历史口径标识。同文件 :91 `CASH_PAID_CNY_MISSING`（"有充值或套餐采购未登记现金支出"）是资金域另一码，是否保留按 WP2 合同（该码未停产）**保留不动**。
- 测试锚点需同步：`standard-home-model.test.ts:201,206,425`（三处断言 OPENING_BALANCE_MISSING 文案）。任务合同红线"已关账/历史入口的旧口径标识要保留"的落点不在本函数（见 §6）。

### ② `resource-insights/routes.ts` `projectFinanceUtilization`（:212-244）

- 兜底串：`apiCost: resource.apiCost ?? account?.monthlyApiCost ?? null`（:222）；`currentBalance: account?.balanceState === "NORMAL" ? account.balance : null`（:223）；`purchaseCashAmount: account?.monthlyRecharge ?? "0.00000000"`（:224）；利用率分母 `spend = resource.apiCost ?? account.monthlyApiCost`（:236）。
- 调用方：`GET /provider-resources/utilization`（:30-72），仅 :61 一处调用（`financeReadModelEnabled` 门控 :38-44）。
- 消费方：web `useResourceUtilization`（`v2-hooks.ts:158`）→ `ResourceUtilizationPanel.tsx`。**该面板不渲染 currentBalance/purchaseCashAmount**（grep 全 web 仅 `ResourceBreakdown.tsx:55` 用到另一个接口的 `currentBalance`）；消耗的字段只有 `apiCost`（:109）、budget 系（:105,111-112）、tokenUtilization、quota 系。
- `ResourceUtilizationRow.apiCost` 基础层已切估算：`resource-insights/query.ts:330-336`（S3a 注释＋`loadApiCostEstimation` 注入）。
- 精确改法（建议）：在 `projectFinanceUtilization` API 分支删除资金读模型覆盖——:222 去掉 `?? account?.monthlyApiCost`；:223 `currentBalance` 置 null 或不再输出；:224 充值兜底串 `"0.00000000"` 改为不产充值（该端点无消费方，删除字段或恒 null 亦可，但注意 `ResourceUtilization` web 类型 `v2-types.ts:137` 仍声明该字段，需同步）；:236 同步去掉兜底（预算利用率只按估算金额算，`notCalculableReason` 已有 UNKNOWN/NOT_CONFIGURED 路径）。CODING_PLAN 分支（:246-274）**不动**（W5/W6 域）。
- 影响测试：`apps/control-api/src/__tests-integration__/w20-resource-insights.test.ts`（:743 附近有桥接状态断言）——S2/S4 改后需核对该套件断言迁移（改动属展示投影，plan §3 允许）。

### ③ `OperatingBillOverview.tsx:100-110` BRIDGE_UNAVAILABLE/apiSpendStatus

- 现状 :103-117：`bill.gaps.some(code==="API_OPENING_BALANCE_MISSING") || providers.some(mode==="API" && (apiSpendStatus==="OPENING_BALANCE_MISSING" || apiSpendReason==="MISSING_OPENING_BALANCE"))` → 警示 "期初余额未登记，请前往厂商资源补充资金记录。"（:111-116，带 /resources 链接）。
- 后端已停产该码并改产 `BRIDGE_UNAVAILABLE`（`monthly-operating-cost.ts:200-203`：期初事实缺席 → status=BRIDGE_UNAVAILABLE、apiSpend 恒 null、reason null、"不产任何资金缺口/提示"；`operating-bill-finance-quality.ts:28`、`operating-bill-monthly-cost.ts:14,22`）。
- web 对 `BRIDGE_UNAVAILABLE` 完全无处理：厂商行 :146 `row.apiCost === null ? (row.apiSpendReason ?? "—")` → BRIDGE 行显示 "—"（apiCost 现值来自估算，null 时语义混叠——估算缺口文案与桥接不可算共用一格，违反 WP1 合同 §5 ④"不得把桥接缺口文案挂在估算金额上"）。
- 精确改法（建议）：删除 :103-117 整段（现行视图退出"待补期初"提示，AFR-07）；:146 拆分展示——`apiCost===null` 且 `apiSpendStatus==="BRIDGE_UNAVAILABLE"` 时显示中性"桥接不可核算（历史资金口径）"或直接 "—"，估算缺口（多币种 reason "币种不一致…"）才挂估算列；`OperatingBill.test.tsx:136,153,264` 三处 OPENING_BALANCE_MISSING 断言需迁移为 BRIDGE_UNAVAILABLE 或删除。
- 同页其它提示：:119 `API_COST_UNKNOWN` 提示（"存在尚未计价的 API 请求…"）——与估算 `gaps` 域对应，措辞可保留；`BalanceQualityNotice.tsx:8-15`（API_MONTH_OPENING_COST_UNKNOWN/API_BALANCE_COST_UNKNOWN/API_NEGATIVE_RECONCILIATION_REQUIRED）:18-23 "期初结余暂无法确认"、:35-39 "内部账本出现负余额…核对资金记录"——AFR-07 要求现行视图退出的"内部负余额/待补账"提示点，S4 处置（改为估算完整性措辞或移除，历史 CLOSED 版本标识另加）。

---

## 3. 套餐与订阅页（S3）

### 3.1 "充值与订阅"命名出现点（区分 Token 充值 vs API 资金充值）

- `components/resources/ResourceTabs.tsx:11`：Tab 标签 `充值与订阅`（showFinance 门控 :60）。
- `components/resources/ProviderFinancePanel.tsx:184`（h2 标题）、`:192`（按钮 `充值／订阅`）、`:186` 副文案 "API 余额与 Coding Plan 费用只认本模块资金账本…"。
- `components/resources/ResourceOnboardingSection.tsx:325`（"订阅金额和服务周期在'充值与订阅'中登记。"）、`:328`（"API 期初、充值、余额和费用统一由'充值与订阅'资金账本管理。"——**API 措辞需退役**）。
- 测试锚点：`Resources.test.tsx:214,225`；`ProviderFinancePanel.test.tsx:33,54,85`；`ProviderFinancePanel.confirmation.test.tsx:24,53,75,93`；e2e `wt-web.spec.ts:61`。
- 全仓无侧边导航级"充值"命名（`Sidebar.tsx:23-32` 八入口均为页面级，无资金入口）。
- Token 充值不存在独立页面（无"Token 充值"文案命中）；套餐采购在 `OperatingPlans`/`MonthlyPayments`。

### 3.2 各组件分工

- `pages/OperatingBillRechargeEntry.tsx`：账单页 DRAFT 期限的 **API 充值登记表单**（:43 DRAFT 门控；:61-68 `purchase_type:"API_RECHARGE"` → `POST /provider-resources/:id/purchases`，`api/operating-bills.ts:209`）。该端点在 `department-costs/routes.ts:219-243` 注册，写 `resource_purchase_record`（`department-costs/writes.ts:282-295`），**不在 WP2 退役 19 入口表内**（mode 校验 :262 只做 API↔API_RECHARGE 匹配）。S3 前端退役该表单后，后端仍可写——需在回报中标注为移交项（是否补 410 由总指挥裁定，本包合同未授权改 department-costs）。
- `components/operating-bill/OperatingProcurement.tsx`：年度采购实付表（:51-73，API 行显示 "API 充值" 现金口径 :58）＋ **API 账户月度复盘表**（:75-123，列头 "期初余额/充值到账/实付（人民币）/API 消耗/期末余额" :83-88——内部资金轨迹列，D5 要求现行视图移除期初/充值/期末、保留估算消耗）＋套餐采购表（:124-137）。
- `components/operating-bill/MonthlyPayments.tsx`：本月采购实付流水（:13-18 事件类型标签含 `API_RECHARGE: "API 充值"`；数据源 `GET …/finance/events`（读端点，WP2 §3 全保留）经 `api/operating-bill-payments.ts:14-55` 聚合）。历史实付事实展示，属可保留的历史只读口径（现金实付），S3 只需措辞核对。
- `ProviderFinancePanel` API 分支退役后保留：Coding Plan 充值/订阅表单（W5/W6 存活）、`SubscriptionAutoRenewal`/`SubscriptionHistory`（:260-261）、资金记录历史表（:262-263，GET events 只读）。
- 旧 API 资金 GET 消费方盘点（保留为只读）：`useProviderFinanceSummary`（`ProviderFinancePanel.tsx:102`，摘要卡含 "API 经营成本"/"当前 API 余额"——现行视图需替换为官方余额/估算，历史入口另设）；`useProviderFinanceBalance`（:103，仅 kind==="API" 时 enabled）；`useProviderFinanceEvents`（:104＋`operating-bill-payments.ts:33`）。`provider-finance-types.ts:9-22` `ProviderFinanceBalance`（balanceState 五值含 MISSING_OPENING_BALANCE/NEGATIVE_RECONCILIATION_REQUIRED）与 :31-41 Summary（gaps 数组）为旧口径类型，只读入口保留来源/版本标识时复用。
- `FinancialLedgerSection` 口径（详见 §4）：期初/充值/期末列来自 `OperatingAnalysis.apiAccounts`（资金轨迹字段，WP1 合同 §3 末行"资金轨迹字段与 loadResourceFinanceViews 调用保留（WP2/WP4 处置）"）。

---

## 4. 首页/账单/年度/部门/项目/CSV（S4）

### 4.1 首页（Dashboard）

- `pages/Dashboard.tsx`：四卡模型 `buildOverviewCards`（:65）；费用卡 "本月费用"（:105）——措辞与估算口径标注（ACE-06）；缺口文案见 §2①。`components/dashboard/ProviderResourcesPanel.tsx:156` "调用状态与额度/余额同步状态分别判断"（中性，保留）。
- `standard-home-model.ts` 金额比较工具（moneyChangePercent :138-145 多币种 null）已符合混币不比规则；`mtdCostCard`（FINANCE_READ_MODEL 分支 :174-194）——finance 开路径卡片，WP1 合同 §5 指出该路径 monthlyRechargeAmount(s) 仍是资金读模型值，S4 需核对展示口径（未核实后端该分支现值字段是否已被 WP1 S3b 覆盖——合同 §3 表"首页汇总（finance 开）"已透传估算，充值保留资金读模型）。

### 4.2 经营账单（OperatingBill*.tsx ＋ operating-bill/**）

- `pages/OperatingBill.tsx:92-110`：overview→`OperatingBillOverview`＋`OperatingTrends`；plans→`OperatingPlans`；value→`ValueRealizationSection`；finance→`FinancialLedgerSection`；procurement→`OperatingProcurement`。
- `OperatingBillOverview.tsx` BillStat 数组（:50-95）：`期初余额`（:56-58）、`本月充值`（:60-66）、`期末余额（暂算）`（:67-72）、`API 花费`（:73）、`本月总花费`（:85）——期初/充值/期末三卡为现行内部资金卡（S4 移除或改官方余额卡；"API 花费"→"API费用估算（含完整性）"；`本月总花费`→"综合费用（含 API 估算）"措辞）。:103-117 见 §2③。厂商表 :122-167 列头 "API 花费"（:127）。
- `FinancialLedgerSection.tsx`（财务账＝年度台账）：
  - 五卡：`年度实付总采购` :209、`年度用量总花费（实际核算）` :214-216（"API实际消耗 + 套餐计入费用"——需改估算措辞）、`综合每百万 Token 成本` :219-223、`官方账户可用余额` :226-235（**已消费 officialApiBalances**，多账户不合并，无时效状态）、`仟流内部账本余额` :237-243（内部结余卡，S4 处置）。
  - 台账表列：`API 现金充值（¥）` :256（cash_paid 口径，可保留为实付）、`API 实际计价消耗` :257（**老口径名，改估算**）、`本月用量总花费（¥）` :258、`月末账本余额` :260（内部结余列，S4 处置）。
  - CSV 导出 `financialLedgerCsv` :171-187（headers :173-175 同名英化列；前端 Blob 下载 :196-204，文件名 `仟流智算-财务总台账-*.csv`）。
  - 模型 `buildFinancialLedgerModel` :97-169（`officialBalances` :166-167 按 syncedAt 排序；多币种保守置 null :116-119、:141-143——混币分列已部分实现，"多币种（不合并）" :55）。
- `OperatingAnalysisPartial.test.tsx`：账单分析不完整月处理测试（S4 改列后回归）。
- `OperatingProcurement.tsx`：见 §3.2（期初/充值/期末列处置）。
- `OperatingTrends.tsx`：纯 Token（:22-58 全部 Token 指标）——零改动白名单。
- `OperatingPlans.tsx`：套餐利用率（grep 无金额费用字段）——零改动候选（未核实到行级，S4 时复核）。
- `ValueRealizationSection.tsx`：套餐价值（官方基准价对比，:41-89 纯套餐域；`合计节约` :442）。属套餐分摊口径（D5"保留既有套餐分摊口径"），零改动候选；S4 复核 "等效 API 成本" 注释措辞即可。

### 4.3 年度统计

- "年度统计"在信息架构中即 财务账 Tab（`OperatingBillShell.tsx:30` "财务账"）的年度台账＋`OperatingTrends`。无独立年度页路由（grep 无 /annual）。

### 4.4 部门/项目页

- `pages/OperatingBillDepartments.tsx`：`GET /operating-bills/:month/department-accounts`（:33-48）；`MetricGrid`（:72）来自 `AccountShared.tsx:85-156`——`月度总花费`（:115-124）、`API 消费`（:125，`accountApiMoney` :53-57：apiCost null 时回退 knownApiCost>0）、`套餐分摊`（:126-134）。CLOSED 时该端点走冻结证据（`department-costs/routes.ts:88-111`，缺证据 409 `department_evidence_unavailable` "该历史账期缺少部门冻结数据" :101-108）。
- `pages/OperatingBillEmployees.tsx`/`OperatingBillEmployeeDetail.tsx`/`OperatingBillProjects.tsx`：同用 `MetricGrid`/`AccountTable`/`SubjectUsageCells`（`SubjectUsageCells.tsx:60` 列头 "API 消费合计"、:103 deepseek→apiCost 否则 packageAllocatedCost）。
- WP1 合同 §3：部门账 live 行已是 `effectiveReportedApiCostSql`（同源），CLOSED 走 `department-cost-evidence.ts`（AFR-06 保留）——前端无需改取数，只改措辞。

### 4.5 CSV/导出全量清单

| 导出 | 位置 | 含 API 金额列 |
|---|---|---|
| 用量明细 CSV | 后端 `GET /usage/export`（`apps/control-api/src/usage/routes.ts:109-177`；headers :146-150 含 `API费用`、`币种`；行 :163-164 `totalApiCost`/`costCurrency`） | 是；**注意：该文件不在 plan §3 允许清单**（见 §10 冲突） |
| 财务总台账 CSV | web `FinancialLedgerSection.tsx:171-204` | 是（§4.2） |
| 快照导入解析 | `OperatingBillOverview.tsx:223-263` `parseSnapshotCsv`（导入非导出；O1a 资金字段校验在后端，前端解析零改） | — |
| 通讯录模板下载 | `components/principals/DirectoryPanel.tsx:137-141`（xlsx，无关） | — |

### 4.6 "待补期初/待补账/内部负余额"类提示点全集（S4 退出清单）

1. `standard-home-model.ts:87`（§2①）。
2. `OperatingBillOverview.tsx:103-117`（§2③）。
3. `BalanceQualityNotice.tsx:18-23`（"资金初始余额已登记…期初结余暂无法确认"）＋ :35-39（"内部账本出现负余额…核对资金记录"）。
4. `ResourceBreakdown.tsx:55`（"余额待补"）＋ :61（"API 花费不可计算"挂 monthlyCostReason）。
5. `resource-page-display.tsx:9`（"资金账户币种不唯一"）、:22（套餐 "待补"——套餐域保留）、:27（"资金账本未启用"）。
6. `ResourceUtilizationPanel.tsx:109`（"API 花费不可计算"）、:100（"待补"——套餐分配额度域，保留）。
7. `ProviderFinancePanel.tsx:207-210`（"余额不完整"——Summary `currentApiBalancesComplete`）。
8. `OperatingProcurement.tsx:83-88`（期初/充值列——列级移除而非提示）。

---

## 5. 报表/通知盘点（S5）

### 5.1 含 API 金额的产物（需换名＋完整性标注）

- **静态读码结论：worker 报表模板无任何 API 金额字段。**
  - 模板全集：`apps/worker/src/reporting/templates/`（company-monthly-svg :249 行、company-weekly-svg :297、daily-token-report-svg :240、personal-weekly-svg :116、incentive-over50-svg :110、incentive-top1-svg :114）。`CompanyWeeklyReportData`（`company-weekly-svg.ts:23-41`）字段全为 requests/tokens/quota；grep `apiCost|amount|currency|费用|余额` 于 templates＋company-monthly-metrics＋company-report-presentation＋monthly-reports＋daily-token-report＋report-facts＋model-facts＋quote-library **零命中**（api_cost 仅 `report-jobs.ts:472-473,505-506` 两处零值占位，用于个人排名缺行填充，不渲染金额文本）。
  - `company-report-presentation.ts`（全文 21 行）：月报 6 指标全为 Token 分配额度/使用率/剩余；周报为额度范围/状态/超额策略。纯 Token。
- 结论：**当前仓库内实际含 API 金额的通知产物集合为空**。S5 交付物相应收缩为：盘点清单＋"零模板命中"证据；若总指挥要求保留换名能力，唯一点位是 `report-jobs.ts` 排名行（无渲染）。
- `packages/domain/reports/` 仅有 `mutation.html/mutation.json`（变异测试工件，非报表产物）。
- runtime-assurance 告警（wecom）：`runtime-assurance/wecom-client.ts` 为发送通道；告警内容 grep `余额|费用|金额` 零命中（恢复/隔离类文案，`pages/runtime-assurance/alert-presenters.ts:97` "恢复待核实" 是 web 侧展示，与资金无关）。
- supply-forecast：WP3 task 3.4 已改官方来源门控（`packages/database/src/repositories/supply-forecast-repository.ts:34-47` OAB-07 注释）；web 供给健康 Tab 渲染 forecast 表（`ResourceOtherTabs.tsx` :50-72 coverage/confidence 列）——不在 development-plan 七行表内，WP4 不改（观察项：forecast 表无金额列）。

### 5.2 发送配置（零改动证明点）

- 投递：`apps/worker/src/reporting/delivery.ts`（:4 WecomAppClient；:95 endpoint 查询 provider='WECOM'）、`delivery-scheduler.ts`、`user-dispatch.ts`。
- 配置：`packages/config/src/index.ts:178`（`RUNTIME_ASSURANCE_WECOM_NOTIFY`）、:189（WECOM_API_ORIGIN）。
- S5 红线"不发送任何真实消息"核对点：`delivery-cli.ts`/`quota-reconcile-cli.ts` 为手动 CLI，调查阶段不运行。

---

## 6. 历史只读入口（S3/S4）

### 6.1 已关账版本（CLOSED）在 web 的打开方式

- 主账单页月份选择器可指向任意历史月（`OperatingBillShell.tsx:100-112`，min 2000-01）；bill.status 由 `GET /operating-bills/:month` 返回（`api/operating-bills.ts`，类型含 `status: "DRAFT"|"CLOSED"`）。
- **现状无 CLOSED 标识**：`OperatingBillShell` 组件签名有 `status?/version?` props（:70-78）但 `OperatingBill.tsx:57` 调用不传；`OperatingBillDepartments.tsx:29` 类型声明 status 但页面不渲染；`OperatingBillRechargeEntry.tsx:43` 是唯一消费 bill.status 的组件（DRAFT 才显示充值表单）。
- 旧口径标识缺失：无 "历史口径/关账版本 vN" 渲染点（grep `历史口径|关账` 于 web src 零命中）。S4/S3 需新增只读横幅（历史标识＋版本），数据源 `bill.status/version`（`v2-types.ts:205` DepartmentBill 已有 status/version 字段；OperatingBill 类型 `api/operating-bills.ts` 同含）。
- 旧金额在新代码下的表现：CLOSED 月 `GET /operating-bills/:month` 走冻结快照（WP1 合同 §3 末段：已关账历史口径保留，`department-cost-evidence.ts loadDepartmentBill`）；`OperatingProcurement` 期初/充值/期末列在历史月仍渲染资金轨迹值——**历史月保留 vs 现行月移除需要按 bill.status 或月份新旧分流**（D5："已关账旧版本保留原快照…现行视图删除"）。实现要点：以 `bill.status==="CLOSED"` 判定保留旧列＋旧口径标识，DRAFT 现行月移除（建议方案，S4 落地时与总指挥确认分流维度——未核实是否所有历史月均已 CLOSED）。

### 6.2 旧 API 资金历史（provider-finance GET 端点）web 消费方

- `GET /provider-resources/:id/finance/events`：`ProviderFinancePanel.tsx:262-263`（月度资金记录表，含 API 期初/充值/历史消耗类型标签 :35-48）＋ `operating-bill-payments.ts:33`（本月采购聚合）。
- `GET /provider-resources/:id/finance/balance`：`ProviderFinancePanel.tsx:103,230`（仅 API 类型充值表单内）。
- `GET /provider-finance/summary`：`ProviderFinancePanel.tsx:102,202-211`（五卡含 API 经营成本/当前 API 余额）。
- WP2 合同 §3：读端点全部保留。S3 形态建议：充值表单退役后，资金记录表＋summary 改造为"历史资金记录（旧口径，只读）"入口（保留来源/版本——事件含 `source` 字段 `provider-finance-types.ts:28`，余额含 balanceState 口径）。**未核实**：总指挥是否要求独立路由入口（现均为 finance Tab 内区块）。

---

## 7. e2e 基础设施

### 7.1 结构与运行前置

- 目录：`apps/web/e2e/`＝README＋fixtures.ts＋global-setup.ts＋4 个 spec（wt-web 1254 行/39 test、provider-review 153/1、quota-pricing 67/1、project-allocation 37/2；合同写"5 个 spec"与实际 4 个不符，已核实 `git ls-tree` 同为 4）。
- global-setup：`e2e/global-setup.ts:5-18` 每次 `tsx` 执行 `apps/control-api/src/cli/seed-e2e.ts`（无清库失败回退；`E2E_UPSTREAM_ORIGIN` 时追加凭证播种 :14-17）。
- 安全门：`seed-e2e.ts:17-26` 只接受 127.0.0.1/localhost＋库名 `_e2e` 结尾；TRUNCATE 清单 :36-46（含 `provider_resource_operating_snapshot` :43；sync_attempt/refresh 表经 FK CASCADE 随 provider_resource 清空——**未核实** FK 依赖方向，落地 S2 时用 `\d` 复核）。
- env 前置（README §macOS）：`DATABASE_URL=postgres://postgres:qianliu@127.0.0.1:55432/qianliu_e2e`＋`GATEWAY_KEY_PEPPER`＋`CREDENTIAL_KEK`＋`COOKIE_SECRET`；命令 `pnpm --filter @qianliu/web test:e2e`。**调查阶段未运行**（合同禁止）。
- fixtures：`e2e/fixtures.ts:10-38`（login 走真实 /api/auth/login；`apiGet` 同源 fetch；E2E_IDS 固定 UUID 表 :17-28）。

### 7.2 【阻塞项】wt-web.spec.ts 引用不存在的 helper

- `wt-web.spec.ts:10-14` import：`./legacy-project-assignment`、`./legacy-principal-cleanup`、`./principal-department-flow`、`./operating-bill-legacy-api-flow`、`./finance-subscription-flow`。
- 这 5 个文件**不在 git HEAD**（`git ls-tree HEAD apps/web/e2e/` 仅 7 文件），也**不在任何历史提交**（`git log --all -- apps/web/e2e/finance-subscription-flow.ts` 空），未被 .gitignore（check-ignore exit=1）。
- 推论（未实际运行验证，但模块解析缺失成立）：`test:e2e` 运行时 wt-web.spec.ts 转译即失败 → **整个 e2e 套件不可运行**。WP4 S6 浏览器证据依赖此套件，S2 开工前需总指挥裁定：恢复 helper 文件来源、或将 wt-web 的相关用例拆分/内联。
- 其余 3 spec 仅依赖 fixtures（grep :1-6 核实），可独立运行。

### 7.3 seed-e2e 现状与 S2 需补夹具

现有（`seed-e2e.ts`）：
- billing_rule ×1（:232-247，`source:"M5_E2E_SEED"`；无 `source_status` → 0093 默认 `UNVERIFIED`——正好可做"价格依据待核实"角标夹具；如需对照 VERIFIED 规则需增列）。
- ledger_line ×3＋pool043 ×2（:250-309；`seed-e2e-pool043.ts:93-104`）：**均无 `settled_at`**（列定义 `kysely-ledger-tables.ts:55` `Generated<Date|null>` 无默认）→ WP1 估算半开窗（合同 §1）取不到这些行，估算读取将返回 ZERO_CONFIRMED——S2 必须给 seed 行补 `settled_at`（生产结算链才写，见合同 §1 注）。
- provider_resource_operating_snapshot：pool043 4 行（`seed-e2e-pool043.ts:115-137`，source=PROVIDER_SYNC 但 **balance_source 未设**）＋pool042 2 行（`seed-e2e-pool042.ts:87-99`，同）。`operating-analysis-repository.ts:72-73` officialApiBalances 要求 `source='PROVIDER_SYNC' AND balance_source='PROVIDER_API'` → 现有 seed 不会出现在官方余额卡。
- 无 `provider_resource_operating_sync_attempt` 行 → C2 状态推演：有 PROVIDER_SYNC 快照、无 attempt，按 s4-receipt §3 矩阵落点**未核实**（规则 7 要求"最新 attempt SUCCESS/NOT_SUPPORTED"）；稳妥做法 S2 补 SUCCESS attempt 行＋`balance_source='PROVIDER_API'`。
- 无 deepseek code 资源（pool043 provider code=`pool043-deepseek` :36、pool042=`pool042-deepseek`）→ `canonicalProviderCode==='deepseek'` 判定（official-balance-states.ts supported 判定与适配器同源）是否命中**未核实**——S2 夹具需把 code 调整为 `deepseek` 或验证 canonicalize 规则。
- 无 provider_finance 事件/CODING_PLAN 订阅周期夹具（ProviderFinancePanel 历史表/套餐表单 e2e 需要时补）。

S2-S4 seed 增补清单（建议）：settled_at、balance_source='PROVIDER_API' 快照、SUCCESS sync_attempt（含 next_sync_at）、可选 FAILED/EXPIRED 场景资源（验证 OAB-04 叠加渲染）、VERIFIED+UNVERIFIED 双规则（价格依据角标）、多币种 ledger_line（混币分列 ACE-07）、CLOSED 历史月账单（历史标识）。均属 plan §3 允许的 `seed-e2e.ts` 范围。

---

## 8. 组件测试盘点（S2-S5 需同步调整的现有测试）

Runner：vitest＋@testing-library/react（`apps/web/package.json:12`；样例 `ProviderFinancePanel.test.tsx:1-3`）。全 web src 95 个 `.test.ts(x)`。与本次改动直接相关的：

| 测试文件 | 现有关键断言 | 改动冲击 |
|---|---|---|
| `components/dashboard/standard-home-model.test.ts` | :201/:206/:425 OPENING_BALANCE_MISSING 文案 | §2① 删映射后重写 |
| `pages/Dashboard.test.tsx` | 费用卡渲染（未逐条读，S2 时对照） | 缺口文案变化回归 |
| `components/dashboard/ResourceBreakdown.pool042.test.tsx` | 余额列/费用列渲染 | :54-61 改官方余额后重写 |
| `components/resources/ResourceUtilizationPanel.test.tsx` | 费用列/预算 | §2② 后端字段变化＋命名 |
| `components/resources/ProviderFinancePanel.test.tsx`＋`.confirmation.test.tsx` | "充值／订阅"按钮、API 充值提交流（:33 等） | API 分支退役→删/改用例；CP 用例保留 |
| `components/resources/FinanceInitializationPanel.test.tsx` | strict_writes 分支切换 | 向导 API 区处置后回归 |
| `components/resources/ActivationDraftEditor.test.tsx`、`activation-draft-model.test.ts`、`activation-preflight-model.test.ts`、`draft-autosave.test.ts` | 期初/充值/消耗草稿行校验 | S3 处置 API 区后同步（保留 CP 购买行测试） |
| `components/resources/resource-page-display.test.tsx` | ResourceFinanceColumn 三行文案 | 官方余额列改造重写 |
| `pages/Resources.test.tsx` | :214-248 finance Tab（DARK/ACTIVE） | Tab 改名＋API 分支退役 |
| `pages/OperatingBillRechargeEntry.test.tsx` | 充值登记表单 | 表单退役→删除或改 410 断言 |
| `pages/OperatingBill.test.tsx` | :136/:153 apiSpendStatus=OPENING_BALANCE_MISSING、:264 gaps API_OPENING_BALANCE_MISSING | §2③ 改 BRIDGE 后迁移 |
| `components/operating-bill/FinancialLedgerSection.test.tsx` | 台账列/官方余额卡 | 列名/内部余额卡改动回归 |
| `components/operating-bill/MonthlyPayments.test.tsx` | API_RECHARGE 标签 | 措辞核对 |
| `components/operating-bill/BillStat.test.tsx`、`AccountShared.test.tsx`、`SubjectUsageCells.test.tsx`、`OperatingAnalysisPartial.test.tsx`、`OperatingBillShell.test.tsx`、`ValueRealizationSection.test.tsx` | 通用渲染 | 措辞变化回归 |
| `pages/Usage.test.tsx`、`RequestDrilldown.test.tsx`（＋pool048/pool20） | "API 费用"列/缺失文案 | 命名统一＋价格依据角标 |
| `components/usage/UsageOverviewPanel.test.tsx`、`UsageOverviewRange.test.tsx` | 指标卡 | 同上 |
| `pages/OperatingBillDepartments.test.tsx`、`OperatingBillAccounts.test.tsx`、`OperatingBillProcurement.test.tsx`、`OperatingBillProjectAllocation.test.tsx`、`OperatingBill.pool043-routing.test.tsx` | 页面组装 | S4 回归 |
| `feature-flags.test.ts`、`api/operating-bills.pool043.test.tsx` 等 api 层 | 取数 | 新增 official_balance 类型不破坏 |

控制-api 侧（遗留②改动）：`apps/control-api/src/__tests-integration__/w20-resource-insights.test.ts`（:743 桥接断言）、`pool025-operating-bill.test.ts`（:283-287,:716-718 BRIDGE_UNAVAILABLE 断言，改投影时核对不回归）。

---

## 9. 范围外确认（看似要改、实属其它包/spec 层，本包不动）

1. `POST /provider-resources/:id/purchases`（`department-costs/routes.ts:219-243`）：API_RECHARGE 写路径未在 WP2 退役 19 入口表；WP4 只退前端表单（`OperatingBillRechargeEntry`），端点是否补 410 → 移交总指挥/WP2 域裁定。
2. `apps/control-api/src/usage/routes.ts:146-150` CSV "API费用" 表头：后端导出格式。plan §3 允许清单只含 `resource-insights/routes.ts` 一个展示域后端文件；改 CSV 列名/加完整性列需增补授权（见 §10）。
3. WP1 估算读取语义（`packages/database/src/repositories/api-cost-estimation.ts` 等）：请求明细逐请求 priceBasis 透出如需后端字段（§1.5），归 WP1 合同层，本包只消费。
4. `operating-bill-finance-projection.ts`（finance 开资金覆盖，WP1 合同 §3 表标注"WP2/WP4 处置"）：后端语义，本包不改（§2② 只动 resource-insights 投影）。
5. WP3 forecast/告警来源时效（s4-receipt §6 移交）：supply-forecast 已由 WP3 task 3.4 完成；web forecast 表无金额列，不在七行表。
6. spec 层（specs/*.md）、迁移（预计无新迁移；确需 0097 起先报批）、发送配置（§5.2）、员工月度额度（0092）与 Worker 报表行为：零接触。
7. `provider-finance-activation.ts`（A1/A2 activation 前端调用，`FinanceInitializationPanel.tsx:16,48`）：WP2-S4 已在后端拒绝 API 草稿；前端向导 API 区处置属 S3 UI 范围，activation 请求合同不改。

---

## 10. 与 plan.md §3 允许范围的冲突/需增补清单

1. **`apps/control-api/src/usage/routes.ts`**（用量 CSV 导出表头"API费用"/币种列/完整性标注）——§3 未列，S4 交付"CSV 断言"涉及；建议增补为允许文件（依据 AT-ACE-13/14 与 development-plan "首页/账单/年度/CSV" 行）。
2. **`apps/control-api/src/department-costs/routes.ts`**（purchases 端点处置）——若裁定需要 410/守卫，属 WP2 域增补；本包默认只退前端。
3. **`apps/web/src/lib/usage-cost.ts`**——§3 "components/usage/**" 未含 lib；命名统一与缺口文案（PRICE_BASIS_UNVERIFIED 等新分支）需改它；建议并入允许范围。
4. **`apps/web/src/lib/currency.ts`**（`currencyFacts/currencyMoney`，standard-home-model/OperatingBillOverview 均消费）——混币分列渲染可能需扩展；建议同上。
5. **e2e helper 缺失处置**（§7.2）——无论恢复还是拆分，均超出"web 组件测试、e2e spec 新增"的常规范围，需总指挥先裁决。
6. **`apps/web/src/components/resources/ProviderFinanceActivationWizard.tsx`/`ActivationPreviewPanels.tsx`/`activation-*` 模块簇**——§3 S3 行写 "…等 API 分支处置"，字面可覆盖，列出以确认（涉及文件多、含纯模型测试）。
7. **`apps/web/e2e/finance-subscription-flow.ts` 等 5 个缺失文件**——若选择重建，属新增文件（plan §4 需更新范围表并说明 requirement）。

---

## 11. 未解决问题（带出 S2 的开放项）

1. §7.2 e2e helper 缺失的处置方案（阻塞 S6 浏览器证据；S2 组件测试不受影响）。
2. seed 的 provider code 是否被 `canonicalProviderCode` 归一为 deepseek（§7.3）——影响 official_balance UNsupported/OK 判定，落地时以 `provider-adapters` 实现复核（未核实）。
3. listOfficialBalanceStates 在"有成功快照但无任何 attempt"时的 status 落点（s4-receipt §3 矩阵未显式覆盖）——未核实，S2 渲染时以集成测试钉死。
4. 请求明细页"价格依据待核实"角标的数据可得性：逐请求维度后端是否透出 rule source_status（§1.5）——未核实；若需 WP1 合同增补，提前上报。
5. 历史月分流维度：以 `bill.status` 还是月份阈值区分"现行视图 vs 已关账保留"（§6.1）——未核实是否存在非 CLOSED 的历史月，S4 前裁定。
6. `Dashboard` finance 开路径卡片（`mtdCostCard` FINANCE_READ_MODEL 分支）在后端估算透传后的现网表现（WP1 合同 §3 表已改，但该分支 UI 是否仍可达取决于 financeReadModelEnabled）——未核实，S4 联调确认。
7. `OperatingBillEmployees/Projects/EmployeeDetail` 三页未逐行读（同构 MetricGrid/SubjectUsageCells 已覆盖）——S4 改时逐页过一遍。
8. "充值与订阅"Tab 是否整体改名"套餐与订阅"并保留 API 历史子区块，还是拆分独立历史入口（§6.2 未核实总指挥意向）。
