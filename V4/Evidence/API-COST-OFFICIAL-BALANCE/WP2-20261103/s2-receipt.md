# S2 回执：解除 API 资金 PENDING 调用准入＋迁移 0094（WP2 task 4.3 前半）

日期：2026-11-03。执行：glm-flash 子 Agent（WP2-S2）。合同：WP2 委派（task 4.3 机制层，AT-AFR-04/05/06 机制部分）。
基线 HEAD：`e4477b6`（开工 `git log --oneline -1` 复核一致；分支 `codex/simplify-api-cost-and-official-balance`；无 git 写操作、无提交）。

## 1. 实际改动文件清单与 diff 摘要

| 文件 | 改动 | 意图 |
|---|---|---|
| `packages/database/migrations/0094_retire_api_finance_pending_admission.js` | 新增 55 行 | up：`DROP TRIGGER IF EXISTS provider_resource_finance_state_seed_trigger ON provider_resource`＋`DROP FUNCTION IF EXISTS provider_resource_finance_state_seed()`（新资源不再种 PENDING）；**不触碰 provider_resource_finance_state 表本体与任何存量行**（D4 留档）。down：逐字复制 0081:185-205（CREATE FUNCTION＋CREATE TRIGGER 原文）恢复种入；down 无任何数据变更。文件头注明 AFR-02 / plan §4.2-§4.3、不动 0081 本体、前向迁移模式 |
| `packages/database/src/repositories/resource-pool-repository.ts` | 修改 10 行（-9/+3 净） | 删除 :435-437 leftJoin（finance_state）、:439 select、:450 `if (row.finance_state === "PENDING") continue;`；:421-427 注释段改写为 AFR-02 退役说明。**:443（quota_block_state where）与 evaluateAdmission 调用（原 :451）逐字未动**（diff 可核） |
| `packages/database/src/__tests-integration__/provider-finance-activation-migration.integration.test.ts` | 修改 137 行（+118/-29 净） | 见 §3 断言迁移清单；新增 1 个用例（0094 down 正反控制）；import 加 `migrateToLatest`；describe 头注释同步 |
| `apps/gateway/src/__tests-integration__/wp2-pending-admission.test.ts` | 新增 175 行 | AT-AFR-04/05/06 机制层三用例，复用 w11 构造模式（Testcontainer PG17＋migrateToLatest＋ResourcePoolRepository） |
| `packages/database/src/__tests-integration__/provider-finance-repository.integration.test.ts` | 修改 14 行（+13/-1，追加授权轮） | 见 §4.1：三个用例的隔离资源各补一条直插 PENDING 行＋依据注释（含替换 ：576 已过时的"0081 自动播种"注释）；断言语义零改动 |

未触及（核对 `git status --porcelain`）：0081/0083/0092/0093 迁移本体、provider-finance 全部 repo/路由、web/worker/control-api 源码、migration.integration.test.ts（全链测试为动态"最后一条迁移"逻辑，0094 自动纳入 up/down/重放，无需登记——已实测，见 §2 命令 6）。

## 2. 验证命令、退出码与用例计数（真实记录）

环境：`corepack pnpm@11.11.0`（node v22.17.1，有 engine WARN `wanted >=22.23.4`，非阻塞）；Testcontainers PG17（Docker 正常）。

| # | 命令 | 退出码 | 结果 |
|---|---|---|---|
| 1 | `corepack pnpm@11.11.0 --filter @qianliu/database run typecheck` | 0 | 通过（无错误输出） |
| 2 | `corepack pnpm@11.11.0 --filter @qianliu/gateway run typecheck` | 0 | 通过（收尾复跑亦 0） |
| 3 | `corepack pnpm@11.11.0 --filter @qianliu/database run lint` | 0 | 通过（`eslint src --max-warnings=0`） |
| 4 | `corepack pnpm@11.11.0 --filter @qianliu/gateway run lint` | 0 | 通过 |
| 5 | `vitest run --config ../../vitest.config.ts src/__tests-integration__/provider-finance-activation-migration.integration.test.ts`（database 目录；＝验收命令 1 的等价过滤方式，见下方注） | 0 | **6/6 通过**（含 2 个改写用例＋1 个新增 down 控制用例），独立跑与组合跑各一次均绿 |
| 6 | 同上方式加跑 `migration.integration.test.ts`＋`quota-block-repository.integration.test.ts` | 0 | **24/24 通过**（6＋7＋11；全链迁移 up/down/重放覆盖 0094；:443 quota_block_state 锚点回归绿） |
| 7 | gateway：`vitest run ... src/__tests-integration__/wp2-pending-admission.test.ts src/__tests-integration__/w11-resource-pool.test.ts src/__tests-integration__/cpqw-quota-window.test.ts`（＝验收命令 2） | 0 | **18/18 通过**（新增 3＋w11 9＋cpqw 6；:451 evaluateAdmission 锚点＝w11 全绿） |
| 8 | database 全套件：`pnpm --filter @qianliu/database run test:integration`（注意：脚本后追加 `-- provider-finance-activation-migration` 过滤参数**未生效**，实际跑全量 75 文件；因此改用命令 5/6 的文件级直跑作为等价验收） | 1 | **556/560 通过，4 失败/2 文件**——全部经归因，见 §4 冲突报告 |
| 9 | gateway 全套件：`vitest run ... src/__tests-integration__`（30 文件） | 1 | **240/241 通过，1 失败**——`pool043-operating-bill-settlement`，经基线复跑证实为**既有失败**，与 S2 无关（见 §4.3） |
| 10 | `corepack pnpm@11.11.0 --filter @qianliu/database exec vitest run src/__tests-integration__/provider-finance-repository.integration.test.ts`（追加授权轮，0094 在位） | 0 | **10/10 通过**（修复前同命令：3 失败） |
| 11 | vitest 直跑 `provider-finance-activation-migration.integration.test.ts`（追加授权轮复跑） | 0 | **6/6 通过** |
| 12 | `pnpm --filter @qianliu/database run lint` / `run typecheck`（追加授权轮复跑） | 0 / 0 | 通过 |

所有计数均非零（规避 `passWithNoTests:true` 陷阱）。

## 3. 0094 行为要点与断言迁移清单

### 3.1 0094 up/down 行为

- up：仅两条 `DROP ... IF EXISTS`（触发器挂 `provider_resource`，函数 `provider_resource_finance_state_seed()`）；可重入；对 `provider_resource_finance_state` 表结构、约束、存量行零操作。
- down：0081:185-205 原文逐字（PL/pgSQL 函数体＋AFTER INSERT 触发器），恢复"已激活企业新建 API 资源种 PENDING"旧行为；down 不含任何 INSERT/UPDATE/DELETE（集成测试以行快照断言验证存量行原样保留）。
- 新库路径（migrateToLatest 全链）与回退链（rollbackTo→migrateDown→migrateToLatest 重放）均实测通过。

### 3.2 断言迁移清单（provider-finance-activation-migration.integration.test.ts）

| 旧断言（基线） | 新断言（S2） | 依据 |
|---|---|---|
| :256 用例"新 API 资源在已激活企业下默认 PENDING"：`seeded?.state === "PENDING"`、`isResourceFinancePending=true`、`listPendingResources=[新资源]` | 反转为"0094 后新资源无 finance_state 行"：`loadResourceFinanceState=null`、`isResourceFinancePending=false`、`listPendingResources=[]`，并新增 listServableResources 立即可服务断言 | AFR-02；迁移 0094 删种入触发器；plan §4.2/§4.3 |
| 同用例"就绪登记/版本冲突/形状约束"断言（挂在种入 PENDING 行上） | 构造迁移：改为对**直插存量 PENDING 行**断言（D4 留档行；仓库存档语义逐一保留：必要币种校验、READY v2、expectedVersion 冲突、"未纳入门禁禁止登记就绪"改为断言无行新资源、三个 shape CHECK 拒绝） | 0094 后无种入来源；合同"不得删除任何既有用例" |
| :336 用例"Gateway 可服务资源排除 PENDING"：`beforeReady == [apiResourceId]`（gated 被排除）；markResourceFinanceReady 后恢复 | 改为"存量 PENDING 行不再被排除"：直插存量 PENDING 行后 `listServableResources == [apiResourceId, gated.id]`；就绪登记（存量行）后仍可服务（存量 READY 语义不变） | AFR-02/AT-AFR-05；plan §4.3 |
| （同用例后半）0078/0079 ACTIVATED 回退守卫断言 | **原样保留**；rollbackTo(0083) 回退链自动纳入 0094 down | 合同未要求改动 |
| （新增）"0094 down 恢复种入触发器（正反控制）" | 正控制：0094 头新资源无种入行；rollbackTo(0094) 后（i）存量行快照不变（down 零数据变更）、（ii）新建资源再次被种 PENDING；反控制：migrateToLatest 重放 0094 后种入停止、down 期间种入的行不被清理 | 合同"0094 down 加正反控制（参照 :355-375 rollbackTo 模式）" |

### 3.3 新增 gateway 用例（wp2-pending-admission.test.ts）

- (a) AT-AFR-04 机制层：已激活企业新建 API 资源 → `provider_resource_finance_state` 无行 → `listServableResources` 包含（status=ACTIVE，probe=false）→ 直插 priced `ledger_line` → `loadApiCostEstimation` 产出 `amounts=[{CNY, 0.00150000}]`、`KNOWN_COMPLETE`、无缺口（全程无任何资金表数据，ACE-03 同源）。
- (b) AT-AFR-05 机制层：直插存量 `PENDING` 行资源仍可服务（行值确认未被迁移改动）。
- (c) AT-AFR-06 机制层：`recordFailure(UPSTREAM_CREDENTIAL_INVALID)` → `CREDENTIAL_INVALID`＋`CREDENTIAL_REJECTED`＋`isolates=true`；不被可服务集合包含；`upstream_attempt` 对该资源零行（零上游调用）；`adminRecover=null`（原恢复流程不变）。

## 4. 冲突与既有失败报告（合同 §纪律 5：不自行放宽）

### 4.1 【已解决——总指挥追加授权轮】provider-finance-repository.integration.test.ts 3 例失败

- 现象（全套件退出码 1 的主因）：`includes historical API usage cost in the monthly summary...`（:71）、`October opening carries September closing...`（:514）、`fails closed when a post-cutover API cost fact is unclassified`（:565）三例报 `resource-level opening balance requires a PENDING resource finance state`（0083 触发器）。
- 归因（实测）：移走 0094 后同文件 **10/10 通过**；恢复 0094 后 3 例失败复现 ⇒ 失败由 0094 引起。
- 根因：该文件 3 例各自在"已激活企业"内新建 API 资源后调 `repo.recordOpeningBalance`（ADMIN 源），0083 要求资源处于 PENDING——旧链路靠 0081 种入触发器隐式满足，0094 删除种入后前置缺失。S1 笔记 §6.3 测试盘点未列出该文件（盘点缺口）。
- 该文件首轮**不在 S2 允许文件清单**，按合同纪律停手报告；总指挥复审后追加授权（仅夹具修复、禁止改断言语义）。已实施：对该 3 例的隔离资源各补一条直插 `provider_resource_finance_state` PENDING 行（与同文件 beforeAll :62-64 既有模式一致），每处附一行依据注释（0094 退役种入触发器后 PENDING 行需夹具显式构造；0083 DB 合同语义不变）；:576 原有"0081 自动播种触发器…无需手工插入"注释已随事实过期一并替换。修复后实测 **10/10**（本轮命令 10），迁移套件复跑 **6/6**（命令 11），lint/typecheck 复跑 exit 0（命令 12）。断言零改动，其他文件零触碰。

### 4.2 【既有环境性 flake，非 S2】w20-standard-capacity P95

`1,000,000 ledger ... P95 达标` 断言 `resourceUtilizationP95 ≤ 1000` 实测 1041/1770/2264 ms（三次运行值大幅波动，含 0094 移除后的运行仍失败）。该文件 import 不含任何 S2 触及代码（resource-pool-repository/0094 均不在其路径）。判定为本机（Docker/Apple Silicon）负载相关的既有边缘 flake，非本包回归；建议 S6 全量复跑时留意。

### 4.3 【基线既有失败，非 S2】gateway pool043-operating-bill-settlement

`前置 UNKNOWN 零用量后 failover 精确成功...` 断言 draft `summary.apiCost: null` 实得 `"0.00007700"`。归因：将仓库与迁移**全部还原至基线**后单独复跑该文件，失败**原样复现**（1 failed | 8 passed）⇒ 基线既有，与 S2 无关；涉及 bill finance 投影 API 分量金额权威（WP1 裁定 2 / S5 域），建议移交总指挥记入 S5 输入。

## 5. 剩余问题与移交

1. ~~§4.1 允许清单扩充决策~~ **已由总指挥追加授权并于本轮实施完毕（10/10）**，S2 无剩余阻塞项。
2. §4.2（w20 P95 flake）/§4.3（pool043 基线既有失败）已由总指挥归因为 WP1 遗留与环境 flake，另行处置（S2 不处理）。
3. w11/cpqw/目标文件/全链迁移/quota-block 锚点在最终状态下全绿；typecheck/lint 双包 exit 0（含追加授权轮复跑）。
4. 证据输出日志：`/tmp/wp2s2-db-full.log`、`/tmp/wp2s2-gw-full.log`（本机临时文件，回执内已摘录关键行）。
