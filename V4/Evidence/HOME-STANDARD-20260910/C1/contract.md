# WP01 数据契约与口径矩阵（候选 C1）

日期：2026-09-10。所有结论基于 HEAD `4898df5` 源码逐文件核对（文件:行号见各节）。

## 0. 总原则

- 复用已有后端事实查询，前端只格式化；不复制计价、分摊、健康判定算法。
- 四指标各自以**用户指定目的页的口径为优先参照**；与经营费用的状态范围差异显式列示（§5），不改写既有模块公式强行对齐。
- 统一 asOf（服务器当前时钟，随响应返回）；同期比较一律半开区间 `[上月同期起点, 上月同一当地日+时刻)`，上月无对应日期时截止上月月末（排他边界），截断规则在页面脚注写明。
- 企业时区（用量概览口径）与经营账单北京时间差异按各指标权威来源分别处理，不混用（§1/§2）。

## 1. 四指标权威来源、过滤与下钻一致性矩阵

### 1.1 本月 Token 消耗 → 厂商资源 / 用量总览（`/resources?tab=usage-overview`）

| 项 | 结论 |
| --- | --- |
| 目的页数据链 | `GET /provider-resources/usage-overview` → `DashboardRepository.getResourceUsageOverview` → `buildResourceBreakdown` + `loadDashboardResourceUsage`（`packages/database/src/repositories/dashboard-repository.ts:115-145`） |
| 目的页过滤 | `ledger_line ll` ⋈ `provider_resource` ⋈ `upstream_attempt` ⋈ `ai_request ar`，**`ar.status='SUCCEEDED'`（不筛结算状态）**，`ll.created_at ∈ [上海自然月初, 下月初)`（`dashboard-resource-usage.ts:159-161` + `shanghaiNaturalMonth`，`dashboard-helpers.ts:31-38`） |
| Token 定义 | `raw_input_tokens + raw_output_tokens`（缓存/推理为子集不重复加，`dashboard-resource-usage.ts:137-139`） |
| 首页来源 | **同一 `queryUsageRows(monthStart, monthEnd)` 跨厂商合计**（复用同一 SQL，首页 Token = 目的页各厂商月 Token 之和，逐字节同口径） |
| 质量信息 | `usageQuality()` 汇总（EXACT/ESTIMATED/UNKNOWN）+ `unknownCount`（`dashboard-resource-usage.ts:109-118`） |
| 上月同期 | 同 SQL 以 `[上月上海月初, 上月同一时刻)` 重跑真实聚合；不折算 |

与旧首页差异：旧 `monthlyTokenUsage` 用 `ledger_transaction SETTLED`（`dashboard-helpers.ts:69-70`）。新卡片改用目的页口径（SUCCEEDED、ledger_line）。**两者可能不同**（存在 SUCCEEDED 未结算、或 SETTLED 但请求最终非 SUCCEEDED 的边缘记录），差异属预期并写入模块说明。

### 1.2 本月费用 → 经营账单 / 月度总览（`/operating-bill?month=YYYY-MM`）

| 项 | 结论 |
| --- | --- |
| 目的页数据链 | `GET /operating-bills/:month` → `OperatingBillRepository.getBill`（`apps/control-api/src/operating-bills/routes.ts:154-165`；`operating-bill-repository.ts:67-90`） |
| 目的页展示 | 月度总览“本月总花费” = `summary.totalSpends`（多币种）+ 缺口原因（`OperatingBillOverview.tsx:42`，`operating-bill-types.ts:130-153`） |
| 口径 | 已结账月返回冻结快照；未结账月构建草稿（`ledger_line` 北京自然月，**不筛请求状态**——含确有消耗的失败记录）。资金模式（DARK/ACTIVE+strict）启用时 `projectOperatingBillFinance` 覆盖 apiCost/packageCost（`operating-bill-repository.ts:402-420`；`operating-bill-finance-projection.ts:27-125`）；未启用时走余额桥接 + 快照套餐费（`monthly-operating-cost.ts:219-365`） |
| 首页来源 | **直接调用同一 `getBill(enterpriseId, 当前北京月)`**，取 `summary.totalSpends / apiCost / packageCost / apiSpendReason`，保证与目的页逐字段一致；多币种分别展示不换汇，未知不是 0 |
| 上月同期 | **不用整月账单折算**。新增真实同期聚合（WP02）：资金模式 = `ledger_line PRICED_USAGE settled_at ∈ 同期窗` + `provider_finance_event CODING_PLAN_PURCHASE/RENEWAL occurred_at ∈ 同期窗`（镜像 `loadMonthlyFinanceSummary` 查询但显式区间，`provider-finance-repository.ts:197-322`）；非资金模式 = `loadMonthlyOperatingCosts(db, enterpriseId, 上月同期窗)`（该函数本就接受任意 periodStart/periodEnd，`monthly-operating-cost.ts:223`）。缺口/桥接不可比时按 §3 规则不输出百分比 |

### 1.3 本月活跃员工 → 用量账本 / 用量概览（`/usage?tab=overview&subject_type=EMPLOYEE&period=MONTH`）

| 项 | 结论 |
| --- | --- |
| 目的页数据链 | `GET /usage/overview` → `UsageOverviewRepository.getOverview`（`apps/control-api/src/usage/routes.ts:60-79`；`usage-overview-repository.ts:139-142`） |
| 目的页过滤 | `ledger_transaction SETTLED` ⋈ `ai_request SUCCEEDED`，**企业时区**自然月（`usage-overview-facts.ts:28-62, 183-187`） |
| 活跃员工 | `COUNT(DISTINCT subject_id)`，subject=请求发起员工（source.id），**不筛主体启用/归档状态**（`usage-overview-repository.ts:201-219`） |
| 首页来源 | **直接调用同一 `getOverview({subjectType:EMPLOYEE, period:MONTH, anchor:now})`** 取 `metrics.activeSubjects`，与目的页完全一致 |
| 上月同期 | 新增显式区间方法（WP02）：同一过滤/主体解析 SQL 以 `[上月企业时区月初, 上月同一时刻)` 重跑（禁止用上月整月数） |

与旧首页差异：旧 `activeEmployeeCount` = `ai_request SUCCEEDED` + 主体 ACTIVE 未归档（`dashboard-repository.ts:159-179`）。新卡片以目的页口径为准（不去筛主体状态）；差异（停用/归档员工当月仍有用量时两数不同）属预期并写入模块说明。

### 1.4 本月活跃项目 → 经营账单 / 项目账（`/operating-bill/projects?month=YYYY-MM`）

| 项 | 结论 |
| --- | --- |
| 目的页数据链 | `GET /operating-bills/:month/projects` → 项目账列表（`operating-bills/account-routes.ts:44-84`；`operating-bill-account-live.ts:279-350`） |
| 目的页口径 | `ledger_line`（员工发起行）LEFT JOIN `operating_bill_request_project_assignment` → 项目主体；北京自然月、**不筛请求状态**；无归属行以 `__unassigned_project__` 独立列示（`operating-bill-draft.ts:112-140`；页面 `OperatingBillProjects.tsx:136-139`） |
| 首页来源 | 同一归属解析 SQL 的 `COUNT(DISTINCT project.id)`（`project.id IS NOT NULL`，**排除 `__unassigned_project__`**，它不是项目） |
| 上月同期 | 同 SQL 以 `[上月北京月初, 上月同一时刻)` 重跑 |

口径差异报告（供 Codex 判断，不强行对齐）：①目的页分页 total 含“未归属项目”行，首页卡片数不含（未归属不是项目，卡片 hint 注明“未归属请求在项目账单独列示”）；②员工卡（用量概览：SETTLED+SUCCEEDED、企业时区）与项目卡（经营口径：不筛状态、北京时间）是两套权威口径，分别跳各自目的页，互不加总。

### 1.5 接入资源区 → 厂商资源 / 供给与健康（`/resources?tab=supply-health`）

| 项 | 结论 |
| --- | --- |
| 厂商清单 | `provider` ⋈ `provider_resource`（`status<>'DELETED'`），按厂商聚合资源数与形态（API / Coding Plan），厂商稳定排序（名称升序）（镜像 `dashboard-resource-status.ts:12-27` 的查询面 + `dashboard-breakdown.ts:233-259` 的分组） |
| 调用状态 | 每资源 `provider_resource.status`（ACTIVE/DEGRADED/EXHAUSTED/EXPIRED/CREDENTIAL_INVALID/RATE_LIMITED/UNAVAILABLE，`resource-lifecycle.ts:34-64`）；厂商级 = `worstResourceStatus`。展示：全部 ACTIVE=「正常」；部分非 ACTIVE=「局部异常」+范围（n/m 项）；全部非 ACTIVE=「异常」+最差状态中文标签（标签映射镜像 `health-routes.ts:15-56`，含“额度已恢复，待调用确认”待确认语义） |
| 需要关注 | 固定模板从现有事实生成：非 ACTIVE 资源（状态标签+数量范围）、经营同步失败（`provider_resource_operating_sync.balance_status/cost_status='FAILED'` + `error_code`，`provider-operating-repository.ts:15-18`；调用状态与额度/余额同步**分别判断**——同步失败不抹掉调用正常，同步成功不冒充调用恢复）、同步数据过期（`data_status='STALE'`，36h 阈值，`providers/routes.ts:84`）。不引入大模型生成，不泄露凭证/原始上游内容 |
| 数据更新时间 | 每厂商取 `operating_sync.completed_at` / 快照时间最大值，页脚统一展示 |
| 正常厂商 | 完整列出（不隐藏）；“N 家需关注” pill = 有任一非 ACTIVE 资源或同步失败的厂商数 |
| 行内跳转 | 不伪造资源锚点：行操作与“管理资源”统一去 `/resources?tab=supply-health`（该页有按资源健康证据与处理入口） |

## 2. 时间与同期规则（写实现与测试）

- asOf：单一服务器时钟 `new Date()`，响应携带；页头展示“本月累计截至 …”。
- 当前期：各指标按其权威来源的月界（Token/费用/项目=北京自然月；员工=企业时区自然月），月内自然截至 asOf（未来无事实，不做人为截断）。
- 上月同期窗：上月同一月初 → 上月“同一当地日+时刻”；上月无对应日（如 3 月 31 日 vs 2 月 28 日）时截止上月月末（排他边界）。半开区间。
- 比较输出：金额/Token 上期为 0、未知或不可比 → 不输出正常增长百分比（显示“不可比”/仅显示上期值或不显示 delta）；金额按相同币种分别比较；员工/项目显示数量差（“增加 3 人”）。
- 固定测试时钟：单测以固定 asOf 覆盖月初当日、月中、大小月末界、上期零值、部分当前月。

## 3. 五个跳转核对（计划第 3 节逐条验证）

| 控件 | 目标 URL | 源码验证 |
| --- | --- | --- |
| 本月 Token 消耗 | `/resources?tab=usage-overview` | `ResourceTabs.tsx:4-22`：合法 tab 值含 `usage-overview`（无需 finance 开关）✓ |
| 本月费用 | `/operating-bill?month=YYYY-MM&tab=overview`（`sectionUrl("overview", month)`） | `OperatingBillShell.tsx:39-51` 生成 `/operating-bill?month=…&tab=overview`；`OperatingBill.tsx:27-29` 解析 month+tab ✓ |
| 本月活跃员工 | `/usage?tab=overview&subject_type=EMPLOYEE&period=MONTH` | `Usage.tsx:69-81`：`tab=overview` → 概览；`UsageOverviewPanel.tsx:12-16` 解析 subject_type/period ✓（不传 anchor，避免冻结时钟） |
| 本月活跃项目 | `/operating-bill/projects?month=YYYY-MM`（`sectionUrl("projects", month)`） | `OperatingBillShell.tsx:44-46` 子路由式；`OperatingBillProjects.tsx:60-64` 解析 ✓ |
| 管理资源 / 行操作 / 查看经营账单 | `/resources?tab=supply-health`；经营账单同费用卡 | `ResourceTabs.tsx:14-22` 含 `supply-health` ✓ |

不携带目标页不解析的参数；月份参数仅用于经营账单两处（真实解析能力已验证）。

## 4. 权限与开关边界

- 新聚合端点沿用 `requireAuth` + `enterpriseId` 租户隔离（`auth-guard.ts:14-51`），不新增权限、不提升权限。
- 不启用任何全局开关：`FEATURE_USAGE_OVERVIEW_V2` 关闭时目的页 `/usage?tab=overview` 自身报加载失败（既有行为，非本任务引入）；首页卡片数据由服务端直接调用仓储函数获取，不经该 flag 门控的 HTTP 路由，不改变 flag 语义。
- 资金模式（OFF/DARK/ACTIVE）照旧由 `PROVIDER_FINANCE_MODE` + strict writes 判定，首页只读取结果。

## 5. 关键口径差异清单（显式报告，不隐瞒）

1. **Token 目的页 vs 经营费用集合**：厂商资源/用量总览筛 `ai_request SUCCEEDED`（不筛结算）；经营账单费用集合不筛请求状态（含确有消耗的失败行）。首页 Token 数与首页费用数**不是同一集合**，与计划 §4.1 预期一致。
2. **员工卡 vs 项目卡**：员工=用量概览口径（SETTLED+SUCCEEDED、企业时区、不去筛主体状态）；项目=经营口径（不筛状态、北京时间、按请求归属快照）。两数不可加。
3. **首页 Token vs 旧首页 Token**：SETTLED（ledger_transaction）→ SUCCEEDED（ledger_line）权威来源切换，数字可能小幅不同。
4. **首页活跃员工 vs 旧首页活跃人数**：新增主体状态过滤差异（旧筛 ACTIVE 未归档；新以目的页口径不去筛）。
5. **项目卡数 vs 项目账分页 total**：后者含“未归属项目”行。
6. **时区**：Token/费用/项目=北京时间；员工=企业时区。页脚分别注明。

## 6. 查询计划（WP02 实现约束）

- 单个新端点 `GET /dashboard/home`（requireAuth）一次返回四指标+同期+资源区；后端并行聚合，查询数量固定（不随厂商数循环发查询）；复用 `queryUsageRows`、`getBill`（费用当前期）、`loadMonthlyOperatingCosts`（费用同期，非资金模式）、finance 同期镜像查询、usage-overview 员工口径、经营项目归属 SQL。
- 无逐请求前端计算；无每厂商一轮的重查询（资源区为单条 GROUP BY 查询 + 单条同步状态查询）。
- 默认无 migration。

## 7. 与原型的差异（显式列出）

- 原型为弹窗演示跳转意图；正式页面直接路由导航（AC05）。
- 原型示例数字、厂商（Kimi/智谱/DeepSeek/OpenAI/Anthropic/通义千问）、状态组合不入正式代码；正式页面厂商数量、资源数、状态均来自真实数据。
- 原型侧栏/顶栏为示意；正式页面复用现有 AppLayout/Sidebar/Topbar 壳层与语义令牌，不复制原型整套侧栏。
- 原型 Token 卡为唯一青色焦点（`text-ql-accent-text`/大数字 `accent-visual` 按规范落地）；变化量保持中性色。
- 原型深色 Logo 白底缺陷不照搬（壳层沿用现有资产）。
