# WP5 S2B 回执：R2/R7 priceBasisUnverified 聚合透出 ＋ R3/R8 settlement apiCostCurrency

日期：2026-11-04；基线：worktree `/Users/mac/Projects/仟流智算-api-decouple`，分支 `codex/simplify-api-cost-and-official-balance`，HEAD `d6550c9`（未提交改动含 S2A＋S2B 两批，开工与收工同 HEAD，未提交 git）。

**说明：S2B 全部代码与测试改动由前一子 Agent 写完后被中止，未执行任何验证、未写回执。本回执由续作 Agent 补齐：测试 diff 审核、R3-4 只读核实、全部验证命令执行。除本回执文件外，续作 Agent 零代码改动（未改任何断言、未放宽任何阈值）。**

## 1. S2B 实际改动清单（被中止 Agent 已写，经本 Agent 逐文件对照 R7/R8 定案审核通过）

### 1.1 后端（R2/R7：资源组级＋窗口级"价格依据待核实"）

1. `packages/database/src/repositories/dashboard-types.ts:135`：`ResourceBreakdownItem` 增 `priceBasisUnverified?: boolean`（注释注明仅 API 汇总行透出、套餐行缺省）。
2. `packages/database/src/repositories/dashboard-breakdown.ts:229-273`：`apiCostFromEstimation` 返回类型增 `priceBasisUnverified`，判定源＝`estimation.priceBasis` 任一 `sourceStatus==='UNVERIFIED'`（:243-244），四个返回分支全部携带；`:277-282` 新增 `resourceGroupPriceBasisField`（`mode==='API'` 才透出，套餐行返回 `{}`）；`:356` 无估算 fallback 增 `priceBasisUnverified:false`；`:417` `buildResourceBreakdown` 组装行时展开 `...resourceGroupPriceBasisField(mode, apiCost)`。金额与 apiCostStatus 聚合语义零改动。
3. `packages/database/src/repositories/usage-overview-repository.ts:36-41`：`UsageOverviewMetrics` 增 `priceBasisUnverified?: boolean`；`:51`/`:58` `UsageOverviewPoint`/`UsageOverviewRankingItem` 以 `Omit<..., "priceBasisUnverified">` 排除（趋势点/主体排名行不拆分主体维度，R7 主体行不拆分定案）；`:133-149` `getOverview` 的 `Promise.all` 增企业级一次 `loadApiCostEstimation(db, enterpriseId, {start: range.range_start, end: range.range_end})`，`:144-147` 合并 `metrics.priceBasisUnverified = estimation.priceBasis.some(...)`。apiCostStatus 五值枚举与金额口径不变。

### 1.2 后端（R3/R8：结算级币种透出）

4. `apps/control-api/src/gateway-requests/routes.ts:66-67`：settlement 投影增 `apiCostCurrency: cost ? cost.costCurrency : null`（处置投影 `costCurrency` 透传；无投影/transaction-only 分支为 null，零新 SQL）。

### 1.3 Web

5. `apps/web/src/lib/usage-cost.ts:4`：新增常量 `PRICE_BASIS_UNVERIFIED_LABEL = "价格依据待核实"`（聚合角标与逐请求角标共用同一文案，不另造措辞）；`:17` `unavailableUsageCostLabel` 的 `PRICE_BASIS_UNVERIFIED` 分支改用常量（文案与语义不变）。
6. `apps/web/src/api/v2-types.ts:102`：`UsageOverview.metrics` 增 `priceBasisUnverified?: boolean`（窗口级，仅汇总级）。
7. `apps/web/src/api/reporting-types.ts:34`：`ResourceBreakdownItem` 镜像增字段。
8. `apps/web/src/api/diagnostic-types.ts:29`：`GatewayRequestDetail.settlement` 增 `apiCostCurrency?: string | null`（注释注明混币也为 null）。
9. `apps/web/src/components/usage/UsageOverviewPanel.tsx:36-39`：指标卡数组改三元组 `[label, value, badge]`，仅"API费用估算"卡携带 `priceBasisBadge`；`:48` 渲染 badge span（`text-[12px]` 副行）。
10. `apps/web/src/components/dashboard/ResourceBreakdown.tsx:80-82`：API 行（`mode==='API'` 守卫）`priceBasisUnverified=true` 时显示 `PRICE_BASIS_UNVERIFIED_LABEL` 副行（false/缺省/套餐行不渲染，即使误传 true）。
11. `apps/web/src/pages/RequestDrilldown.tsx:78-83`：settlement 金额分支——有 `apiCostCurrency` → `costMoneyText(金额, apiCostCurrency)`（USD 显示 `USD x`、CNY 显示 `¥x`）；无币种（无投影/混币 NULL）→ `formatMoney(金额)` 中性无符号展示，**不回退 ¥**（R8 定案废止原回退行为）；"套餐内"分支与行级快照冻结币种路径（:215/:268 走 `costMoneyText(m.apiCost, snapshot.currency)`）不变。

### 1.4 测试（diff 明细见 §2）

12. `packages/database/src/__tests-integration__/usage-overview.integration.test.ts`（+153/-0，纯新增 1 用例＋1 夹具函数）。
13. `packages/database/src/__tests-integration__/pool042-dashboard-resource-usage.integration.test.ts`（+61/-0：`addLine` helper 增可选 `billingRuleId`/`ruleVersion` 透传参数＋新增 1 用例）。
14. `apps/control-api/src/__tests-integration__/w20-diagnostics-alerts.test.ts`（+175/-0：既有 transaction-only 用例追加 1 条 null 断言＋新增 1 用例）。
15. `apps/web/src/components/usage/UsageOverviewPanel.test.tsx`（+23/-0，新增 2 用例）。
16. `apps/web/src/components/dashboard/ResourceBreakdown.pool042.test.tsx`（+16/-0，新增 1 describe/1 用例）。
17. `apps/web/src/pages/RequestDrilldown.test.tsx`（+23/-4：mock 增 `settlementCurrency` 透传；1 条既有断言按 R8 裁定迁移；新增 1 用例）。

S2A 三文件（`department-costs/routes.ts`、`w20-department-costs.test.ts`、`WP2/retired-api-funding-contract.md`）本阶段零触碰。

## 2. 测试 diff 审核结论

**总体：六文件断言均与 R7/R8 定案一致；除 RequestDrilldown 一处按 R8 裁定文档化的断言迁移外全部为纯新增，无旧断言删除。** 用例声明数增量（git 对照）：usage-overview +1、pool042 +1、w20-diagnostics +1、UsageOverviewPanel +2、ResourceBreakdown.pool042 +1、RequestDrilldown +1。逐文件：

1. **usage-overview.integration.test.ts**：新用例覆盖 UNVERIFIED→`true`、全 VERIFIED→`false`、无 API 账本行企业→`false`；并断言 `trend[0]` 与全部 `ranking` 行 `not.toHaveProperty("priceBasisUnverified")`（对应 :51/:58 的 Omit，R7 主体行不拆分）。夹具 `seedPricedApiLineFixture` 走完整链路（principal_key/provider/provider_resource/billing_rule.source_status/ai_request/upstream_attempt/usage_event/ledger_line），判定源与生产同源。无删除。
2. **pool042**：新用例断言 API 行 UNVERIFIED→`true`＋`monthlyCost` 保持 `"0.10000000"`（R7 金额/口径不变）、VERIFIED→`false`、套餐行 `priceBasisUnverified` 为 `undefined`（仅 API 行透出）。`addLine` 新参数为可选透传，既有调用不受影响。无删除。
3. **w20-diagnostics-alerts.test.ts**：既有 transaction-only 用例仅追加 `expect(body.settlement.apiCostCurrency).toBeNull()`（R8：无投影→null）；新用例构造"已计价 USD 行＋UNKNOWN 排除行＋处置投影"触发 `HAVING bool_or(excluded)` 分支，断言 `totalApiCost/apiCostStatus/apiCostCurrency:'USD'` 三元组。无删除。
4. **UsageOverviewPanel.test.tsx**：新 2 用例——`true` 显示角标；`false` 与旧后端缺省（undefined）都不显示。纯新增。
5. **ResourceBreakdown.pool042.test.tsx**：新 describe 断言仅 API 行渲染角标，`mode:"CODING_PLAN"` 即便误传 `priceBasisUnverified:true` 也不渲染（对应组件 mode 守卫）。纯新增。形式弱点（非缺陷）：套餐行断言用 `?.` 链，若分组行不存在会空洞通过——已核实非空洞：`buildResourceBreakdown` 分组枚举全部非删除 `provider_resource` 行（dashboard-breakdown.ts :300-330 groupBy 含 mode），CODING_PLAN 资源无需快照即产生分组行。
6. **RequestDrilldown.test.tsx**：唯一改动既有断言处——`"结算汇总…无币种时回退 ¥"` 中 `getByText("¥0.00")` 迁移为 `getByText("0.00")`＋`queryByText("¥0.00")` 不存在，属 **R8 裁定明确废止的旧行为**（注释 :97-99 记录迁移原因），非违规删断言；新增 USD→`USD 0.00`、CNY→`¥0.00` 用例。mock 增 `apiCostCurrency` 透传不影响既有场景（默认 undefined）。

## 3. 核实项 R3-4（只读核实，未改代码）：混币时聚合 costCurrency 取值

**结论：混币（同请求多 ledger 行不同币种）时聚合 `costCurrency` 取 NULL，不是"任一币种"；经 R3 透出后不会造成"多币种总额被标成单一币种"的误导。未发现误导性 bug。**

证据链（`packages/database/src/repositories/usage-cost-disposition-projection.ts`）：

- **:59** 聚合表达式：`CASE WHEN count(DISTINCT line.api_cost_currency)=1 THEN min(line.api_cost_currency) ELSE NULL END AS currency`。
- PostgreSQL `count(DISTINCT expr)` 忽略 NULL 输入。**排除行币种恒为 NULL**：0086 排除函数 `provider_finance_usage_cost_exclusion_applies`（migrations/0086 :93-106，:101-102）要求 `line.api_cost IS NULL AND line.api_cost_currency IS NULL`，故排除行不进 distinct 计数。
- **0085 shape 约束**（migrations/0085 :193-204）：`PRICED_USAGE` 必须 `api_cost` 与 `api_cost_currency` 同时非空；其余四态（CONFIRMED_ZERO_NO_UPSTREAM/UNKNOWN_COST/NOT_APPLICABLE/NOT_MIGRATED）两者同时为 NULL。因此进入 `recorded_cost` 求和的行全部带非空币种。
- 推论分三种：① 两个以上不同非空币种（真混币）→ count≥2 → **ELSE NULL**；② 单一非空币种（可伴 NULL 币种未计价行）→ 该币种，且与求和行币种严格一致；③ 全 NULL → count=0 → NULL。
- `projectRequestCost`（:71-84）：`costCurrency` 仅在 UNKNOWN_COST/PRICED_USAGE 分支透出；NOT_MIGRATED 与 EXCLUDED_NO_RECORDED_COST 分支强制 null。
- 投影仅对含处置排除行的请求产出（:66 `HAVING bool_or(line.excluded)`）；transaction-only 请求无投影 → R3 路由 :67 得 null → web 中性无符号展示（w20-diagnostics 新增 null 断言覆盖该分支）。

**残留观察（非本次改动引入，单列供总指挥裁定，未改）**：混币时 `recorded_cost`（:58 `sum(line.api_cost) FILTER (WHERE resource_mode='API')`）仍是跨币种数值直加（如 CNY 1.00＋USD 2.00 → "3.00000000"）；因此时 `costCurrency=NULL`、R8 中性展示不给币种符号，不存在"标成单一币种"的误导，但"跨币种直加总额"本身的业务口径是投影层既有设计问题，S2B/R3 未触碰。如需收敛（如混币时置 null 或分列）应另立任务。

## 4. 实际执行的验证命令与结果（预期/实际）

### 4.0 环境说明（影响 database/control-api 两组件测试的基础设施，不影响被测代码与断言）

- 本机 Docker runtime 为 **colima**（`unix:///Users/mac/.colima/default/docker.sock`）；`/var/run/docker.sock` 是指向 Docker Desktop 套接字的**悬空符号链接**（Docker Desktop 未运行）。testcontainers 默认策略报 `Could not find a working container runtime strategy`，需显式 `DOCKER_HOST`。
- colima VM 不支持将套接字挂载进 ryuk 看门狗容器（HTTP 500 `mkdir /Users/mac/.colima/default/docker.sock: operation not supported`），需 `TESTCONTAINERS_RYUK_DISABLED=true`；各测试文件 afterAll 显式 `pg.stop()` 兜底清理（`packages/testing/src/postgres-container.ts`）。
- 两组环境变量仅解决容器发现/挂载，未改任何测试文件、断言或语义。
- **合同命令原样（无环境变量）首次执行结果如实记录**：database 并集 81 文件 → 51 失败/30 过、23 用例失败/277 过/293 skip，失败原因均为上述容器 runtime/连接中断，属环境问题不计入代码结论。

### 4.1 逐条命令

1. **database 合同命令**（`corepack pnpm@11.11.0 --filter @qianliu/database run test:integration -- src/__tests-integration__/usage-overview.integration.test.ts src/__tests-integration__/pool042-dashboard-resource-usage.integration.test.ts`；脚本自带目录参数 `packages/database/package.json:13`，实际并集跑全部 **81 个**集成文件，非仅 2 个指定文件）——带环境变量复跑：**Test Files 79 过/2 失败；Tests 591 过/2 失败（共 593）**。2 个失败均为百万行容量/性能用例（见 §6-1/6-2 的隔离复跑定性）：
   - `w20-standard-capacity.integration.test.ts`：P95 断言 `subjectUsageP95=1325ms > 800ms`（4 worker 争抢同一 colima VM）。
   - `usage-aggregate-migration-capacity.integration.test.ts`：`Test timed out in 600000ms`（百万行迁移种子＋迁移＋回滚，争抢下超时）。
2. **database 指定 2 文件精确运行**（`pnpm exec vitest run --config ../../vitest.config.ts <两文件>`，cwd packages/database，带环境变量）：**2 文件 22/22 全绿**（usage-overview 15/15，含新 S2B 用例"窗口内 UNVERIFIED 规则计价行透出 priceBasisUnverified…"；pool042 7/7，含新用例"S2B：API 资源组级透出 priceBasisUnverified…"）。预期：≥2 新用例通过；实际全绿。
3. **隔离复跑定性（补充证据）**：
   - `usage-aggregate-migration-capacity.integration.test.ts` 单文件：**1/1 过**（Duration 435.82s，600s 超时余量充足）→ 并集失败为争抢所致，非代码回归。
   - `w20-standard-capacity.integration.test.ts` 单文件（`W20_CAPACITY_EVIDENCE=true`）：P95 实测 `commonAdminP95=6.35ms`、**`subjectUsageP95=362.28ms ≤ 800 ✓`**（S2B 触碰的唯一测量路径——getOverview 新增一次企业级估算——隔离下余量 438ms）、`departmentBillP95=944.63ms ≤1000 ✓`（贴近上限）、**`resourceUtilizationP95=1018.68ms > 1000 ✗`**（见 §6-1，该路径 S2B 零触碰）。
4. **control-api 合同命令**（同上并集机制，实际跑全部 **43 个**集成文件；带环境变量）：**Test Files 43/43 全过，Tests 361/361 全绿**（含 `w20-diagnostics-alerts.test.ts` 15/15——14 旧＋1 新，Duration 20.27s；361=S2A 收工 360＋本批新增 1）。预期 ≥1 新用例通过；实际全绿。
5. **web 合同命令**（`--filter @qianliu/web run test -- <4 文件>`；实际 vitest 未收敛过滤，跑全部 **94 个**测试文件）：**94 文件 758/758 全绿**。4 目标文件精确运行（`pnpm exec vitest run --config vitest.config.ts <4 文件>`）：**4 文件 58/58**——usage-cost.test.ts 15/15（未改动，回归确认）、RequestDrilldown.test.tsx 6/6（5 旧＋1 新）、ResourceBreakdown.pool042.test.tsx 13/13（12 声明含 it.each，＋1 新）、UsageOverviewPanel.test.tsx 24/24（17 旧声明＋2 新）。预期：3 处新增行为断言通过、R8 迁移断言通过；实际全绿。
6. **typecheck**：database **exit 0（0 错误）**；control-api **exit 0（0 错误）**；web **FAIL（exit 2，仅 1 错误）**：`e2e/global-setup.ts(15,59): TS2307 Cannot find module './seed-local-upstream-credentials'`。核实：该文件在全部 git 历史中从未存在（`git log --all -- <path>` 为空），HEAD `84c110e`（"restore e2e helpers"）提交了引用它的 wt-web spec 但 helper 本体缺失；S2B 未触碰任何 e2e 文件 → **预先存在的 HEAD 缺陷，非本批引入**；按合同不扩范围未修（src/ 其余代码 0 错误）。
7. **lint**（`eslint src --max-warnings=0`）：database / control-api / web 均 **exit 0，零告警**。
（node v22.17.1 vs wanted >=22.23.4 的 pnpm 引擎 WARN 与本次无关，三包三项均通过。）

## 5. 修复记录

**零代码修复。** 六个测试文件 diff 审核未发现断言错误；S2B 范围内 typecheck/lint 无报错；两条验证失败均为环境/容量测试问题（§4.1-1、§6），按合同未放宽断言、未改语义。运行环境所需的 `DOCKER_HOST`/`TESTCONTAINERS_RYUK_DISABLED` 为命令行环境变量，非文件改动。

## 6. 未决问题

1. **w20-standard-capacity 隔离下 `resourceUtilizationP95=1018.68ms > 1000ms`（超 1.9%）**。该测量路径 `/provider-resources/utilization` → `loadResourceUtilizationSnapshot`＋`sumAllocatedQuota`，经 git diff hunk（仅 :226+/:327+/:388+ 三处）与 import 图核实 **S2B 零触碰**（dashboard-breakdown 仅改 `apiCostFromEstimation`/`buildResourceBreakdown`，:19 `sumAllocatedQuota` 未动；usage-overview-repository 不在该路径）。同轮 `departmentBillP95=944.6ms` 贴近上限，判断为本机 colima Docker VM 性能边际＋自然波动，非 S2B 回归；但本机存在未提交改动不可回退，**无法做 HEAD 基线对照**，请总指挥裁定：在标定环境复测，或复核该阈值标定。并集下另一断言 `subjectUsageP95`（S2B 触碰路径）超 800ms 已由隔离复跑（362ms）证伪为争抢所致。
2. **web typecheck 预先存在缺文件**：`apps/web/e2e/global-setup.ts:15` 动态 import `./seed-local-upstream-credentials`，该文件从未入库（HEAD 84c110e 遗留）。建议后续补交 helper 或改条件引用；属 WP4/基础设施范围，S2B 未动。
3. **混币 `recorded_cost` 跨币种数值直加**的投影层既有口径（§3 残留观察）：R8 中性展示下无单币种误导，如需收敛另立任务裁定。
4. **并集口径提示**：control-api 与 database 的 `test:integration` 脚本自带目录参数，合同命令实际为全量并集；web 的 `test` 命令传文件参数在本机亦未收敛过滤。本回执均如实记录实际文件数/用例数，并补做了精确单文件运行作为指定范围证据。
5. **ryuk 禁用副作用**：测试崩溃（非正常路径）时临时容器可能残留，需手动 `docker rm` 清理；本次收工时 `docker ps` 仅剩既存 `qianliu-pg`，无残留。

## 7. 验证证据文件（本机临时日志，未入库）

- database 并集（环境变量修复后）：`/tmp/wp5-s2b-db-union-run2.log`（79/81 文件、591/593 用例）
- database 指定 2 文件精确运行：会话输出（22/22）
- 迁移容量隔离：`/tmp/wp5-s2b-migration-capacity-isolated.log`（1/1，435.82s）
- 标准容量隔离＋P95 证据：`/tmp/wp5-s2b-capacity-isolated.log`（subjectUsageP95=362ms，resourceUtilizationP95=1018.7ms）
- control-api 并集：`/tmp/wp5-s2b-control-union.log`（43 文件 361/361）
