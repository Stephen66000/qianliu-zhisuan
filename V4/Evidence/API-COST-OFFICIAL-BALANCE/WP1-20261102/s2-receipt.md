# S2 回执：估算聚合的失败 Attempt／重试／重复终态／历史处置语义（合同 S2 / task 2.2）

日期：2026-11-02；实施：glm-flash 子 Agent；工作区：`/Users/mac/Projects/仟流智算-api-decouple`；分支 `codex/simplify-api-cost-and-official-balance`。

## 1. 基线与工作树核对

- 开工时 `git rev-parse HEAD` = `62f12de58dff44065399e9cf8ac99faf217809f3`（＝合同要求的 62f12de）。
- 开工时 `git status --porcelain` 含 S1 全部未提交产物：
  - M：`packages/database/src/exports/delivery-ledger.ts`、`kysely-ledger-tables.ts`、`billing-rule-persistence.ts`、`packages/domain/src/billing-rule.ts`、`apps/gateway/src/pipeline/billing.ts`＋`billing-evidence.test.ts`、`apps/control-api` 三文件；
  - ??：`packages/database/migrations/0093_billing_rule_source_status.js`、`packages/database/src/repositories/api-cost-estimation.ts`、`packages/database/src/__tests-integration__/api-cost-estimation.integration.test.ts`、WP1 openspec 文档。
- 结束时核对：S1 的 9 个 M 文件与 ?? 文件逐一未变（`git diff --name-only` 输出与开工一致）；本次唯一新增 ?? 文件＝合同允许清单内的测试文件＋证据目录内日志。未执行 checkout/reset/commit/stash/push。

## 2. 新增用例清单（编号对应合同 §1.1-§1.5，共 5 条）

文件：`packages/database/src/__tests-integration__/api-cost-estimation-attempts.integration.test.ts`

1. **§1.1 失败 Attempt 与重试都计入（ACE-05 场景1/F03）**：同一请求（IN_PROGRESS、failover 中途）经真实结算入口 `GatewayLedgerRepository.persistAttemptUsageAccountingIfAbsent` 提交 Attempt1（HTTP 502/UPSTREAM_TEMPORARY，已计价 0.01000000 CNY，dedup_key=`<requestId>:attempt1`）＋Attempt2（HTTP 200，0.02000000 CNY）。断言：`amounts=[{CNY,"0.03000000"}]`、`KNOWN_COMPLETE`、`gaps=[]`、`excludedNoRecordedCost=0`；`upstream_attempt` 两行 attempt_no/http_status=[1,502],[2,200] 各自保留；`ledger_line` 两行分别对应两个 attempt 且金额字面值 0.01000000/0.02000000；usage_event 2 行。
2. **§1.2 重复终态只计一次（plan §4 决策2/AT-X03）**：同上 F03 夹具后，对两个 Attempt 分别以**完全相同**的 dedup 证据与终态重放 `persistAttemptUsageAccountingIfAbsent`。断言：两次重放 `created=false`；`ledger_line` count=2、`usage_event` count=2（不落新行）；聚合仍 `[{CNY,"0.03000000"}]`（不得 0.04/0.06）、`KNOWN_COMPLETE`、`gaps=[]`。
3. **§1.3 历史处置不变（ACE-05 场景2/AT-ACE-10）**：1 元已计价行＋0086/0091 合法处置（`provider_finance_usage_cost_disposition`，`original_ledger_fact=to_jsonb(line)` 冻结）。断言：聚合 `amounts=[{CNY,"1.00000000"}]`、`excludedNoRecordedCost=1`、PRICE_MISSING=0、USAGE_UNKNOWN=0、`KNOWN_COMPLETE`（无缺口误报）；聚合读取前后 `ledger_line` 整行与处置记录整行快照逐字段 `toEqual`（读取不改写原始事实）；`loadExcludedUsageCostLineIds` 前后均返回 `Set([lineId])`。
4. **§1.4 请求内混币不被合并（F-020 延伸/ACE-07）**：同一请求两个 attempt 分属 CNY 1.00000000 / USD 2.00000000（真实结算入口）。断言：`amounts=[{CNY,"1.00000000"},{USD,"2.00000000"}]` 两桶分列、`toHaveLength(2)` 无混币总额桶、`KNOWN_COMPLETE`、`gaps=[]`（行级币种已知即完整）。
5. **§1.5 零费用与未知并存（ACE-04 组合）**：同期间 CONFIRMED_ZERO_NO_UPSTREAM＋已计价 1 元＋UNKNOWN_COST/usage_quality=UNKNOWN。断言：`amounts=[{CNY,"1.00000000"}]`、`KNOWN_PARTIAL`、`gaps` 恰为 `[{reason:"USAGE_UNKNOWN",count:1}]`、PRICE_MISSING=0、`excludedNoRecordedCost=0`（零费用行不产生缺口，缺失不补零）。

夹具惯例：沿用 S1 测试文件的独立企业构造（不写资金表/期初，ACE-03 前提）；结算路径沿用 `gateway-compat-cost-status.integration.test.ts` 的 facade 用法；attempt_result 取值依据 `apps/gateway/src/pipeline/runtime-controls.ts` mapToClassification（502→UPSTREAM_TEMPORARY）与 `attempt-usage-settlement.ts`（dedup_key=`${requestId}:attempt${no}`、settled_at 显式传入）。金额断言一律八位小数字面值，无补零期初。

## 3. 实际改动文件

- 新增 `packages/database/src/__tests-integration__/api-cost-estimation-attempts.integration.test.ts`（唯一代码改动）。
- **生产代码零改动**：`api-cost-estimation.ts` 逐项通过 §1.1-§1.5 全部场景，测试未暴露与 plan §4 决策 2/3 相悖的缺口，故未修改聚合实现；`index.ts`/`exports/*` 无需改动（`GatewayLedgerRepository`、`loadExcludedUsageCostLineIds`、`loadApiCostEstimation` 及所需类型均已在 `exports/delivery-ledger.ts` 导出）。
- 证据目录内新增 s2-*.log 与本回执。

## 4. 实际命令、退出码、用例数

| 命令（均在 worktree 根、`corepack pnpm@11.11.0`） | 退出码 | 用例数 |
|---|---|---|
| `--filter @qianliu/database exec vitest run --config ../../vitest.config.ts src/__tests-integration__/api-cost-estimation-attempts.integration.test.ts` | 0 | **5 passed (5)** |
| 同上，文件换 S1 `api-cost-estimation.integration.test.ts`（S1 复跑） | 0 | **10 passed (10)** |
| `--filter @qianliu/database run typecheck` | 0 | — |
| `--filter @qianliu/database run lint` | 0 | — |
| `--filter @qianliu/database exec vitest run … w20-standard-capacity.integration.test.ts`（隔离复跑） | 0 | 2 passed (2) |
| `--filter @qianliu/database run test:integration <新文件路径>`（首次调用，pnpm 把脚本内目录与新文件参数取并集，实际跑了全量集成套件） | 1 | 545 passed / 1 failed（见 §5） |

生产代码零改动 ⇒ 合同 §4 的 `gateway-compat-cost-status`/`home-cost-comparison` 回归为非必需；但全量套件日志已含这两个文件通过（8/8 与全部用例绿），见 `s2-db-full-integration-output.log`。

## 5. 偏离

- 首次跑测命令把整个集成套件（73 文件 546 用例）跑了而非单文件：`test:integration` 脚本已含目录参数，pnpm 追加的文件名参数被 vitest 取并集。结果：仅 `w20-standard-capacity.integration.test.ts` 的 P95 断言失败（`expected 1304.21… to be less than or equal to 1000`），为全量并行（maxWorkers=4）下的性能阈值抖动；S1 曾遇同一现象并留下隔离复跑先例（`s1-w20-capacity-isolated-rerun-output.log`）。本次隔离复跑 2/2 通过（exit 0），证明与 S2 改动无关。全量日志仍归档为回归证据。
- 其余无偏离：未修改生产代码、未改 S1 任何文件、未删旧断言、未 git 提交。

## 6. 剩余问题／移交 S3 注意项

1. **request 终态未发布**：§1.1/§1.2/§1.4 夹具按真实 failover 流程让 `ai_request` 保持 IN_PROGRESS（结算入口 `lockInProgressRequest` 要求 IN_PROGRESS，terminal 后 `finalizeRejectedAttemptSettlement…` 才发布终态）。聚合只读 `ledger_line`，与 request 状态无关；S3 若在读取方对齐中需要"请求完成"语义，请走 `finalizeLedgerSettlementIfAbsent` 另行固化，勿在本批夹具上直接复用。
2. **w20-standard-capacity P95** 在全量并行下会抖动（本次 1304ms vs 1000ms 预算、S1 同样命中）；总指挥复跑全量时建议隔离跑该文件或接受其作为已知环境抖动项。
3. 结算重放语义已被 `assertUsageMatches`/`assertLineMatches` 冻结（dedup_key 唯一＋逐字段核验），S3 对齐读取方时无需再处理重复终态去重。
4. `ledger_line.settled_at` 由结算入口显式接受并可冻结（本批夹具全部显式传入 2026-09 期间）；聚合期间过滤沿用 settled_at 口径（S1 已核实），S3 的期间归集对齐可直接引用。

## 7. 证据路径（均在 `V4/Evidence/API-COST-OFFICIAL-BALANCE/WP1-20261102/`）

- `s2-receipt.md`（本回执）
- `s2-attempts-suite-output.log`：新测试文件定向运行，5 passed (5)，exit 0
- `s2-s1-suite-rerun-output.log`：S1 套件复跑，10 passed (10)，exit 0
- `s2-database-typecheck-output.log`：exit 0
- `s2-database-lint-output.log`：exit 0
- `s2-db-full-integration-output.log`：全量集成套件 545/546（唯一失败为 w20 P95 抖动，含 compat-cost-status 8/8、home-cost-comparison 通过）
- `s2-w20-capacity-isolated-rerun-output.log`：w20 隔离复跑 2 passed (2)，exit 0
