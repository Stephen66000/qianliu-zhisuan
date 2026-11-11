# S5 回执：修复 S2B 在既有生产 schema（0093 前）上的独立报表兼容回归

- 执行：WP5 子 Agent（GLM-5.3-Flash）
- 日期：2026-11-04
- worktree：`/Users/mac/Projects/仟流智算-api-decouple`（HEAD `d6550c9` + 未提交改动，未回退任何既有成果）
- 唯一改动文件：`packages/database/src/repositories/usage-overview-repository.ts`

## 修复 diff 摘要（相对 S2B 未提交状态，行号为当前文件行号）

1. `usage-overview-repository.ts:13` — 导入处追加类型：`import { loadApiCostEstimation, type ApiCostEstimation } from "./api-cost-estimation.js"`（helper 返回类型用）。
2. `usage-overview-repository.ts:38-44` — `priceBasisUnverified?: boolean` 的 doc comment 追加：**"仅当 billing_rule.source_status 列存在（0093+）时产出；既有生产 schema（0093 前，如 worker 独立报表的 0091 水位）上省略该字段——旧 schema 无'核实'概念，语义是'无此信息'而非'已核实'，不得回填 false。"**
3. `usage-overview-repository.ts:136-149` — `getOverviewSnapshot` 的 `Promise.all` 中，原对 `loadApiCostEstimation(this.db, ...)` 的直接调用改为 `this.loadPriceBasisEstimation(input, range)`（兼容门），并在原 S2B（R7）注释下追加兼容门注释；`metrics` 构造改为条件展开 `...(estimation && { priceBasisUnverified: estimation.priceBasis.some((b) => b.sourceStatus === "UNVERIFIED") })`，estimation 为 null 时该字段整体省略（保持 undefined，非 false）。
4. `usage-overview-repository.ts:183-219` — 新增两个私有方法：
   - `loadPriceBasisEstimation`：先做列存在性检查，列缺失返回 null；列存在才调用 `loadApiCostEstimation`（该函数本体零改动）。注释说明这是 worker 独立报表（`report-facts.ts` 经 `getOverviewSnapshot`，legacy 合同 migrateTo 0091 水位）在既有生产 schema 上的兼容行为。
   - `hasBillingRuleSourceStatusColumn`：`information_schema.columns` 普通 SELECT（`EXISTS(... table_schema = current_schema() AND table_name = 'billing_rule' AND column_name = 'source_status')`），一次 catalog 点查。

## 取舍说明（缓存与否）

不做缓存，每次快照一查：

- 实例级缓存无收益：`getOverview` 每次调用为新事务新建仓库实例（`usage-overview-repository.ts:119-120`），worker 报表 `report-facts.ts:30` 也是按调用新建实例，实例字段活不过一次快照。
- 模块级缓存有正确性风险：同一进程内多个 testcontainer/多个数据库实例会串状态，且 0093 上线/回滚后有陈旧风险。
- 成本：每次 `getOverviewSnapshot` 多一次 `information_schema.columns` catalog 点查（与 trend/ranking 并行执行，在 `Promise.all` 的第三个分支内先行检查再调估算），可接受。取舍已写入代码注释。

## 回归证据（修复前）

实际执行 worker legacy 用例（修复前）：
`corepack pnpm@11.11.0 --filter @qianliu/worker exec vitest run src/reporting/__tests__/report-facts-legacy.integration.test.ts`
→ `Test Files 1 failed (1)`，`Tests 1 failed | 1 passed (2)`，错误信息 `error: column rule.source_status does not exist`，栈经 `report-facts.ts` → `getOverviewSnapshot` → `loadApiCostEstimation`。

## 验证（修复后实际执行，环境 DOCKER_HOST=unix:///Users/mac/.colima/default/docker.sock，TESTCONTAINERS_RYUK_DISABLED=true）

| 命令 | 预期 | 实际 | 退出码 |
| --- | --- | --- | --- |
| `corepack pnpm@11.11.0 --filter @qianliu/worker run test` | 200/200，exit 0 | Test Files 36 passed (36)，Tests **200 passed (200)**（含 `report-facts-legacy.integration.test.ts` 2/2） | **0** |
| `corepack pnpm@11.11.0 --filter @qianliu/database exec vitest run --config ../../vitest.config.ts src/__tests-integration__/usage-overview.integration.test.ts src/__tests-integration__/pool042-dashboard-resource-usage.integration.test.ts` | 全过，exit 0 | Test Files 2 passed (2)，Tests **22 passed (22)**（usage-overview 15 ＋ pool042 7，既有断言未改，含 `priceBasisUnverified` true/false/不透出断言） | **0** |
| `corepack pnpm@11.11.0 --filter @qianliu/database run typecheck` | exit 0 | `tsc -p tsconfig.json --noEmit` 无错误 | **0** |

## 合同边界遵守情况

- 未改 `loadApiCostEstimation` 本体（`api-cost-estimation.ts` 零改动）。
- 未改 `dashboard-breakdown`（该路径无 legacy 消费方）。
- 未改任何测试断言（仅改 `usage-overview-repository.ts` 一个文件；生产消费方 control-api/worker 主路径均在 0093+ 水位，字段照常产出，行为不变）。

## 未决问题

- 无阻塞项。备注（未核实级观察）：本地 node 为 v22.17.1，pnpm 警告 `Unsupported engine: wanted >=22.23.4 <23`，三条命令在该环境下均通过；与本次修复无关。
