# EG-02 文件映射表（v1.5 送审准备 · 新模块覆盖率补齐＋TypeScript 定向变异）

- 基线：worktree `/Users/mac/Projects/仟流智算-api-decouple`，HEAD `7594639` ＋ EG-01 未提交改动（w05 夹具 +2 行、gate-supplement-run2/eg-01/ 证据，保留不动）。
- 生成时间：2026-11-07；执行：EG-02 子 Agent（GLM-5.3-Flash）。
- 全部路径相对仓库根。

## 1. 高风险逻辑 → 实现文件（含 GATE-01 拆分后落点）→ 既有测试 → 覆盖率/变异配置 → 阈值依据

### 1.1 API 费用估算聚合与完整性（含折单批量版）
| 项 | 值 |
| --- | --- |
| 实现文件 | `packages/database/src/repositories/api-cost-estimation.ts`（GATE-01 拆分后落点未变：单资源入口 `loadApiCostEstimation` L293-331、W20-10 折单批量入口 `loadApiCostEstimationByResource` L369-451、共用投影 `estimationLinesSql`/`ESTIMATE_COUNT_PROJECTION`/`ESTIMATE_PRICED_SUM` L161-218、派生 `assembleApiCostEstimation` L241-287） |
| 关联投影依赖 | `provider-finance-usage-dispositions.ts`（effectiveUsageCostDispositionSql）、`usage-cost-disposition-projection.ts`（effectiveReportedApiCostSql）——处置排除/已计价口径来源，随主文件同测 |
| 既有测试 | `packages/database/src/__tests-integration__/api-cost-estimation.integration.test.ts`（单资源：零确认/处置排除/缺口分类/价格依据/快照回退 UNVERIFIED/版本 A-B 冻结）、`api-cost-estimation-by-resource.integration.test.ts`（批量折单 vs 逐资源逐字段一致性）、`api-cost-estimation-attempts.integration.test.ts`（attempts 侧口径） |
| 上游消费方 | `apps/control-api/src/resource-insights/query.ts`（批量版调用）、`apps/control-api/src/providers/finance-usage-overview.ts`、`apps/control-api/src/provider-finance/dashboard-projection.ts`（单资源调用） |
| 覆盖率配置 | 根 `vitest.eg02.config.ts`（EG-02 新建）：include 上列 3 个集成测试＋official-balance 域测试；coverage.include 本文件；报告落 `coverage/eg02/` |
| 变异配置 | `packages/database/stryker.eg02.config.json`（EG-02 新建）：mutate 圈定本文件核心 TS 逻辑行段（派生函数/批量装配/条件分支），SQL 模板字符串行段按 dryRun 实测 mutant 数决定是否收窄 |
| 阈值依据 | V3 全局阈值（根 `vitest.config.ts` L23-28 与 `vitest.pool043.config.ts` L76 同源）：statements 95 / branches 85 / functions 90 / lines 95；变异沿用既有 database 域 stryker 配置惯例 `thresholds { high:100, low:80, break:80 }`（`stryker.w20.config.json`、`stryker.pool039043-resource.config.json`），不另行发明 |

### 1.2 价格依据（billing_rule source_status / 快照冻结）
| 项 | 值 |
| --- | --- |
| 实现落点 | `packages/database/src/repositories/api-cost-estimation.ts` L178-179（`coalesce(l.billing_rule_snapshot->>'sourceStatus','UNVERIFIED') AS rule_source_status`，F3/ACE-02：事后改规则不改历史依据；快照缺键回退 UNVERIFIED）、L208-210（PRICE_BASIS_UNVERIFIED 计数）、L315-322/L400-413（priceBasis DISTINCT 三元组，单/批量两版）；表结构侧 `billing_rule.source_status` 由迁移 0093 定义（不属本轮改动） |
| 既有测试 | `api-cost-estimation.integration.test.ts` 场景 f（UNVERIFIED 触发 PRICE_BASIS_UNVERIFIED、不影响 completeness）＋场景 i（F3/ACE-02 回归：事后改 source_status 不改变历史依据；旧行快照缺键回退 UNVERIFIED）；迁移侧 g 场景（source_status 列/CHECK/down 回滚） |
| 覆盖率/变异配置 | 同 1.1（价格依据逻辑与估算聚合同文件，不单独建配置） |
| 阈值依据 | 同 1.1（V3 全局） |

### 1.3 官方余额状态 / 同步 / 刷新
| 项 | 值 |
| --- | --- |
| 状态读取实现 | `packages/database/src/repositories/official-balance-states.ts`（`deriveOfficialBalanceStatus` 判定序矩阵 L88-103、`listOfficialBalanceStates` 装配与 next_refresh_at/max/now 过滤 L105-207；F1 双滤 `source='PROVIDER_SYNC' AND balance_source='PROVIDER_API'` L124-125） |
| 同步（周期）实现 | `apps/worker/src/provider-operating-sync/runner.ts`（`runProviderOperatingSyncTick`：周期同步调度/attempt 与成功快照写入）＋写侧仓储 `packages/database/src/repositories/official-balance-sync-writes.ts`（`officialBalanceSyncDay`/`recordOfficialBalanceSyncSuccess`/`recordOfficialBalanceSyncAttempt`） |
| 刷新（手动路由域）实现 | `apps/control-api/src/providers/official-balance-routes.ts`（POST /provider-resources/:id/official-balance/refresh：校验 404/422/409、冷却/在途 200 分态、幂等重放、成功/失败留痕与审计）＋租约仓储 `packages/database/src/repositories/official-balance-refresh-repository.ts`（begin/finish、幂等、23505 兜底、DB 时钟租约收敛） |
| 既有测试 | `packages/database/src/__tests-integration__/wp3-official-balance-states.integration.test.ts`（状态矩阵逐格）、`wp3-official-balance-refresh.integration.test.ts`（begin/finish/租约收敛）、`apps/control-api/src/__tests-integration__/official-balance-refresh.http.test.ts`（路由域：AT-OAB-05/06、AT-X02 冷却/在途、fetch 注入）、`apps/worker/src/provider-operating-sync/runner.test.ts`（周期同步 tick） |
| 覆盖率配置 | 同一根 `vitest.eg02.config.ts`：4 个测试全部 include；coverage.include 上列 4 个实现文件 |
| 变异配置 | 同一 `packages/database/stryker.eg02.config.json`：mutate=official-balance-states.ts（状态判定纯逻辑）＋official-balance-refresh-repository.ts（秒数/冲突/唯一键判定行段，按 dryRun 收窄）；路由/worker 文件以覆盖率＋集成回归为主，不强行入变异（HTTP 装配类变异价值低且每 mutant 全量 HTTP 测试过慢） |
| 阈值依据 | 同 1.1 |

### 1.4 X07 回退域拆分产物（operating-bill-draft-facts 等）
| 项 | 值 |
| --- | --- |
| 实现文件 | `packages/database/src/repositories/operating-bill-draft-facts.ts`（211 行，X07 回退域拆分产物；消费方 `operating-bill-draft.ts`/`operating-bill-repository.ts`/`operating-bill-finance-projection.ts`） |
| 处置 | **已由集成回归覆盖**（`apps/control-api/src/__tests-integration__/pool025-operating-bill.test.ts`、`packages/database/src/__tests-integration__/api-cost-draft-model-alignment.integration.test.ts` 等运营账单/草稿回归链）——按任务合同标注，不进本轮变异、不单独圈覆盖率。注：未逐条核实上述回归对各拆分产物的行级覆盖深度（超出本表合同范围） |

## 2. 配置与证据落点（EG-02 新建，全部不 commit）
| 文件 | 用途 |
| --- | --- |
| `vitest.eg02.config.ts`（仓库根） | 定向覆盖率：include＝1.1/1.3 既有测试 7 个文件；coverage.provider=v8，include＝核心实现 6 文件；reportsDirectory=`coverage/eg02/`；thresholds=V3 全局 95/85/90/95 |
| `packages/database/vitest.eg02.mutation.config.ts` | Stryker vitest runner 用最小测试集（estimation 集成＋by-resource 一致性＋states/refresh 集成），alias `@qianliu/database`→src |
| `packages/database/stryker.eg02.database.config.json` | 定向变异：mutate=api-cost-estimation.ts＋official-balance-states.ts（＋refresh-repository 行段，视预算）；coverageAnalysis perTest；json 报告留档 run2/eg-02/ |
| `gate-supplement-run2/eg-02/` | 命令日志、退出码、起止时间、coverage 报告副本、stryker json 报告副本 |

## 3. 无适用已批阈值的项目（列明，不自行定）
- `apps/control-api/src/providers/official-balance-routes.ts` 与 `apps/worker/src/provider-operating-sync/runner.ts`：本轮仅做覆盖率观测（无独立已批变异阈值）；若覆盖率不达标按任务三规则先补断言。
- `official-balance-sync-writes.ts`：写入函数以集成测试覆盖观测为准，变异仅在其被 states/refresh 测试集触达时随文件入 mutate（不额外扩测试集）。
