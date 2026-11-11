# S3b 收据：首页 finance 开路径／模型行口径／经营账单当前期／部门·项目·年度对齐＋合同文档（task 2.3 后半）

日期：2026-11-03；执行：glm-flash 子 Agent（WP1 S3b 合同）；分支 `codex/simplify-api-cost-and-official-balance`。
基线核对：`git rev-parse HEAD`＝`62f12de58dff44065399e9cf8ac99faf217809f3`；`git status --porcelain` 开工时含 S1/S2/S3a 全部未提交改动（见 `s3a-worktree-status.txt` 与本目录 `s3b-worktree-status.txt` 交集）；未执行任何 checkout/reset/rebase/stash/push，未回退 S1/S2/S3a 任何文件。

## 1. 调查结论（file:line）

1. **模型行当前口径（S3a 移交项核实）**：`dashboard-resource-usage.ts queryUsageRows` 原 :161 用 `ll.created_at >= start AND created_at < end`、:142 用裸 `COALESCE(SUM(ll.api_cost::numeric),0)`、:145 `COUNT(ll.api_cost)` 为 known_cost_count。理由（历史口径）：该查询服务于"请求账本新增"视角的 Token/24h 速率与模型行金额，早于 settled_at 统一；与 loadApiCostEstimation（settled_at 窗）并存两套口径（inv-b §6 移交项）。消费方共 3 处：`loadDashboardResourceUsage`（月度+24h 窗，经 `dashboard-breakdown.ts:268` 消费 Token 速率/costRate24h）、`resource-model-usage.ts:82-83`（模型行 monthlyCost/costKnown）、`dashboard-home-metrics.ts:73`（tokenTotalsForRange，仅消费 Token/质量，费用字段不消费）。
2. **账单 draft 费用源**：资源级 `providers[].apiCost` 原取 `monthly-operating-cost.ts` 余额桥接 apiSpend（opening+recharge−ending，`calculateMonthlyOperatingCostResource` :198-203）；汇总 `summary.apiCost/apiSpends/totalCost/totalSpends` 经 `operating-bill-monthly-cost.ts monthlySummaryFields` 取 `summarizeMonthlyOperatingCosts` 桥接值；`ledgerApiCost` 已是处置投影（draft usage SQL `operating-bill-draft.ts` :103-106 与 `monthly-operating-cost.ts` :233-241）。finance 开路径另有 `operating-bill-finance-projection.ts` 资金账户覆盖（本包未改，见 §6）。
3. **部门/项目/年度逐项判定**：
   - `operating-department-accounts.ts`：live 路径经 `operating-bill-account-month-lines.ts liveLineFactCtes`，API 金额已是 `effectiveReportedApiCostSql`（:100）；期间为 finance.enabled ? settled_at : created_at 条件式（:16-20）——金额非资金口径，**未改**。CLOSED 路径读 `loadDepartmentBill` 历史口径（AFR-06 保留），**未改**。
   - `department-cost-read-model-query.ts`：costCtes/apiOnlyCostCtes 已用 `effectiveReportedApiCostSql`（:112/:253，created_at 窗）；financeCostCtes 为资金口径（settled_at 窗 + CONFIRMED_ZERO/处置/遗留调整 CASE，:196-230）——资金口径但含 AFR-06 遗留调整事件，**未改**（不在"对齐估算"授权内：其金额源是账本事实+遗留事件，非桥接差）。
   - `operating-bill-project-attribution.ts`：只做 request_attribution_snapshot 归属快照，无 API 费用读取，**未改**。
   - **年度统计＝合同外发现**：`operating-analysis-repository.ts` :41-47 经 `finance.loadResourceFinanceViews`、:230 `account.monthlyApiCost`（资金读模型）产 apiAccounts.apiSpend——属"资金口径读取点"，但该文件不在 S3b 允许清单 → 按纪律停下上报，未改（套件原样通过）。
4. **pool042/w18 夹具现实**：cost=null 与 CODING_PLAN 夹具行不写 settled_at（S1 调查 §4：仅 seed 工具产生 NULL）；生产结算链每条已结算行必写（gateway-ledger-settlement.ts:197 / attempt-usage-settlement.ts:109）。

## 2. 实际改动文件（每文件一句话；全部在允许清单内）

| 文件 | 说明 |
|---|---|
| `packages/database/src/repositories/dashboard-resource-usage.ts` | §1.2：queryUsageRows 期间过滤改 settled_at 半开窗、api_cost/known_cost_count 改 `effectiveReportedApiCostSql` 处置投影（头注记录改前口径与消费方） |
| `packages/database/src/repositories/operating-bill-monthly-cost.ts` | §1.3：新增纯函数 `estimatedApiCostFields`＋`groupByCurrency`；`monthlyProviderCostFields`/`monthlySummaryFields` 的 apiCost/apiSpends/totalCost/totalSpends 改估算供给，桥接字段原样 |
| `packages/database/src/repositories/operating-bill-draft.ts` | §1.3：buildOperatingBillDraft 按 API 资源逐个 `loadApiCostEstimation` ＋全企业一次估算，providers/summary 主口径切估算；桥接与完整性机制零改动 |
| `apps/control-api/src/provider-finance/dashboard-projection.ts` | §1.1：projectDashboardFinance 移除 API 分量资金覆盖（透传 getSummary 的估算值），套餐/充值保留资金读模型，总额按币种重合（复用既有 combine 逻辑改名 combineTotals） |
| `apps/control-api/src/provider-finance/dashboard-projection.test.ts` | 断言迁移（注明 C1/ACE-06/07 依据）＋新增 finance 开/关同值、complete=false、混币 3 条 |
| `apps/control-api/src/__tests-integration__/dashboard-finance-estimation.test.ts` | 新增（§4a）：PG 集成证明 finance 开/关两路首页 API 金额同值、总额=套餐+估算、混币透传 |
| `packages/database/src/__tests-integration__/api-cost-draft-model-alignment.integration.test.ts` | 新增（§4b/c）：模型行同批行同值/settled_at 边界/处置投影、draft apiCost=估算字面值+桥接字段在、关账 v1 快照逐字节不变+reopen 后 draft=99.99 |
| `packages/database/src/__tests-integration__/pool042-dashboard-resource-usage.integration.test.ts` | 夹具修正：settled_at 提为全行必写（含 cost=null/CODING_PLAN），注明 S1 调查依据；断言值未改 |
| `apps/control-api/src/__tests-integration__/w18-dashboard-usage.test.ts` | 夹具修正：CODING_PLAN 两处补 settled_at/created_at，注明依据 |
| `apps/control-api/src/__tests-integration__/pool025-operating-bill.test.ts` | 夹具补结算链字段＋8 处断言迁移（无账本行→估算精确 0、reopen 后 draft 反映估算 99.99、v1/v2 冻结值断言），逐处注明 ACE-03 场景2/AFR-06/合同 §1.3 |
| `apps/control-api/src/__tests-integration__/w20-resource-insights.test.ts` | 1 处断言迁移（settled_at NULL 行→估算 0，注明依据） |
| `apps/control-api/src/__tests-integration__/provider-finance-wp07-acceptance.http.test.ts` | 1 处断言迁移（激活前基线：缺期初但已计价 → 估算 1.25 照常透出，AFR-07 场景），注明依据 |
| `openspec/.../WP1/api-estimation-contract.md` | 新增合同文档（§1.5，签名/返回语义/0093/对齐清单/两条裁定/WP3-5 指引）——随 handoff 文档留给总指挥提交，不入本次 commit |

未触碰：dashboard-repository/dashboard-breakdown/dashboard-monthly-spend/dashboard-home-costs（S3a 产物零改动）、resource-model-usage、usage-overview-routes、operating-bill-finance-projection/operating-bill-repository、部门/项目/年度文件（§1.3 判定未改）、迁移、worker、web、resource-pool-repository、员工月度额度。

## 3. 命令与用例数（全部实跑；根 vitest passWithNoTests 陷阱已规避——逐条报数）

| 命令（包目录下） | 结果 | 日志 |
|---|---|---|
| `tsc -p tsconfig.json --noEmit` ＋ `eslint src --max-warnings=0`（database / control-api 双包） | 双双退出码 0 | s3b-db-typecheck-lint.log / s3b-control-api-typecheck-lint.log |
| vitest run api-cost-draft-model-alignment.integration（新增） | 5 通过 | s3b-db-alignment-output.log |
| vitest run dashboard-finance-estimation + dashboard-projection.test（新增/迁移） | 7 通过（2+5） | s3b-control-api-finance-projection-output.log |
| vitest run 估算 4 套件（estimation 10 + attempts 5 + readers-alignment 4 + pool042 6） | 25 通过 | s3b-db-rerun-consumers.log |
| vitest run home-cost-comparison 15 + finance-period-cost-integrity 6 + operating-bill-resource-scope 7 + standard-home 9 | 47 通过（同上 log） | s3b-db-rerun-consumers.log |
| vitest run pool043×2 + pool043-model-identity + operating-analysis + pool010 + operating-feedback | 92 通过（同上 log，14 文件合计 165） | s3b-db-rerun-consumers.log |
| vitest run pf0085 + usage-cost-disposition-read + project-allocation-close/invariance + principal-attribution-backfill + provider-finance-cutover + 5 个单测文件 | 33 通过（前 6 文件）＋18 通过（单测 4 文件）＋17（department-cost-evidence 等） | s3b-db-rerun-disposition-allocation-units.log |
| vitest run control-api 16 文件（pool025 8、w18 19、w20-resource-insights 9、w20-usage-overview、provider-finance、subscription-renewal、w20-department-costs、project-allocation-routes、w19、pf-activation、wp07 11、resource-insights-api-cost-evidence、standard-home-route、pool043-accounts、consumer-projection、provider-review） | 139 通过（16 文件） | s3b-control-api-rerun.log |
| vitest run provider-review（隔离复跑，判定并行 teardown 竞态） | 通过，退出码 0 | s3b-provider-review-isolated-rerun.log |
| gateway vitest run w08-e2e | 13 通过 | s3b-gateway-w08-rerun.log |

新增/迁移用例合计：新增 12（S3b 集成 5＋finance 双路集成 2＋projection 单测 3＋迁移重写 2 条保留），断言迁移 10 处、夹具修正 4 文件（逐处注明依据）。并行 16 文件复跑出现 2 条 provider-review teardown 竞态 error（57P01 容器先停，139/139 用例全过），按合同隔离复跑判定通过。

## 4. 偏离与设计选择（需总指挥复核）

1. **§1.3 选择了"按资源调用 loadApiCostEstimation"**（providers 行需要资源级金额字面值；api-cost-estimation.ts 为 S1/S2/S3a 产物不可加按资源分组查询）＋汇总行另取一次全企业估算（资源范围互斥切分，两者恒等）。代价：draft 每次 1+N×3 条聚合 SQL（N=API 资源数），如需优化后续可扩 C1 入口（属 S1 产物，未动）。
2. **§1.1 未改 `dashboard/routes.ts`**（不在允许清单）：projectDashboardFinance 以"summary 已是 getSummary 的估算产出"为前置条件透传 API 字段（唯一生产调用方满足）；未引入 estimation 新参数（避免死参数）。
3. **估算 gaps 未写入账单 draft.gaps / 模型行 reason 沿用既有语义**：账单完整性机制（apiBalanceGaps/unknownApiCostGaps→关账阻断）不动是合同明文；模型行 monthlyCostReason/unknown 语义未扩。估算缺口在账单侧暂以 `apiSpendReason`（桥接）＋后续 WP2 处置表达——已在合同文档 §4 裁定 1 记录双权威。
4. **断言迁移 10 处、夹具修正 4 文件**：全部逐处注明依据（ACE-03 场景2/AFR-06/AFR-07/合同 §1.2/§1.3＋S1 settled_at 调查）；其中 wp07 激活前基线（缺期初但已计价→1.25 照常透出）与 pool025 reopen（draft 反映估算 99.99 而非冻结桥接 12.34）是行为变更本体，请总指挥重点复核。
5. w20-standard-capacity 不消费本包改动函数，未跑（沿 S3a 先例）；全量复跑若遇其抖动按合同隔离复跑判定。

## 5. 剩余问题 / 移交 WP2-WP5 注意项

1. **年度统计资金口径**（operating-analysis-repository.ts :41-47/:230）未对齐——文件不在允许清单，需总指挥裁定归属（WP2 或独立合同）。
2. **经营账单 finance 开路径**（operating-bill-finance-projection.ts）仍用资金账户 monthlyApiCost 覆盖 providers/summary 的 apiCost/totalCost/apiSpends——WP2/WP4 处置时按合同文档 §4 裁定 2 一并切换，DARK/ACTIVE 验收（wp07 phase≥2、finance-period-cost-integrity）当前语义未变。
3. 账单"完整性缺口"仍是资金域权威（裁定 1）；WP2 退役资金缺口码时需同步迁移 standard-home V14-C2/C3、finance-period-cost-integrity、home-cost-comparison 钉死断言。
4. WP4 文案与 WP5 核对指引见 `api-estimation-contract.md` §5；50 条总验收以 loadApiCostEstimation 为唯一金额基准。
5. queryUsageRows 现按 settled_at 归集——`settled_at IS NULL` 的行（仅 seed 工具/未启用 strict writes 直写）不再出现在模型行/Token 汇总；如生产出现此类行属数据链路 bug（0061 触发器应拦截）。

## 6. 收尾提交（合同 §5 授权）

- 提交前 `git status`：暂存＝34 个业务文件（26 修改＋8 新增），V4/Evidence 与 openspec handoff 文档未暂存，无越界文件。
- `git commit -m "feat(cost-estimation): add same-source API cost estimation reading (WP1 tasks 2.1-2.3)"` →
  **commit `9bf156005052f85425b1a2d84c9ff3dec3de2e20`**（34 files changed, 2541 insertions(+), 147 deletions(-)）。
- 提交后 `git status --porcelain` 仅余 V4/Evidence 与 openspec handoff 未跟踪文档（留给总指挥提交）。

## 7. 证据路径（worktree `/Users/mac/Projects/仟流智算-api-decouple`）

- `V4/Evidence/API-COST-OFFICIAL-BALANCE/WP1-20261102/s3b-receipt.md`（本文件）
- `s3b-code-diff.txt`（10 个修改文件 diff）、`s3b-worktree-status.txt`
- `s3b-db-alignment-output.log`、`s3b-control-api-finance-projection-output.log`
- `s3b-db-rerun-consumers.log`、`s3b-db-rerun-disposition-allocation-units.log`、`s3b-control-api-rerun.log`、`s3b-provider-review-isolated-rerun.log`、`s3b-gateway-w08-rerun.log`
- `s3b-db-typecheck-lint.log`、`s3b-control-api-typecheck-lint.log`
- 合同文档：`openspec/changes/simplify-api-cost-and-official-balance/handoff/work-packages/WP1/api-estimation-contract.md`
