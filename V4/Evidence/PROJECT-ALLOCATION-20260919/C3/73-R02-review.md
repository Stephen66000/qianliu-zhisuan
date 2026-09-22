# R02 独立评审报告 — 候选 e1c9f89（第三方审核 FAIL 后的返修）

日期：2026-09-22。评审上下文：独立（未参与实现）。
工作树：`仟流智算-project-allocation-feature-20260921`，分支
`project-allocation/v12-feature-candidate-20260921`。
被评审 HEAD：`e1c9f89`（"R02 返修"）；返修前基线：`2a9185c`（第三方审核 FAIL 的候选）；
计划基线：`2b33719`。评审范围：`git diff 2a9185c..e1c9f89`（38 文件，+950/−220）。
被评审方主张文件：`72-R02-rework.md`（按 CLAIMS 处理，逐条实证核对）。
合同依据：`10-WP01-contract.md`。

评审过程仅写入本文件一个仓库文件；未改动任何生产/测试代码；实证脚本只创建于 `/tmp`
（复核后已删除）；结束时 `git status` 干净。

---

## 0. 结论摘要

| # | 授权项 | 判定 | 备注 |
| - | --- | --- | --- |
| 1 | P1-a 幂等短路改 no-op 成功 + digest-HIT 方向回归 | **PASS（字面）** | 分支/断言/旧代码必失败均实证成立；但该改动的"顺带语义"含一个 P1，见 §3-a 与 §4-① |
| 2 | 退避符号写未来 + 退避窗口内不被重认领 | **PASS** | 符号正确、断言成立；合成失败注入**可接受**（附条件，见 §1-2） |
| 3 | P1-b 三条写入路径同事务按账期聚合推脏 | **PASS** | 三条均在同一事务内、按批去重、账期口径与 scan 一致 |
| 4 | `HISTORICAL_UNKNOWN` 需"无参与证据" + 金标用例 | **PASS** | 判定次序与 `:90` 契约注释一致；新用例为真实回归护栏 |
| 5 | 门禁稳定（DB 时钟）+ 并行命令三连跑 | **PASS** | 3×36/36 全绿，逐次结果见 §2 |
| 6 | 顺手项 1–6（余量去重/自登记/口径/端点/Web/删文件/删列） | **PASS** | 逐项 file:line 见 §1-6 |
| a | 代次对齐的附带语义是否安全 | **部分否定** | 核心不变量自洽，但组合出**一个 P1**（§3-a、§4-①） |
| b | tick 每拍自登记"已脏未消费"账期 | **可接受（P2）** | 失败可见、不静默；但无周期级退避上限、run 行无界增长（§3-b） |
| c | 0077 迁移阶梯是否被破坏 | **PASS** | 无残留引用；migrateUp/Down 用例通过（§1-c） |

**核心发现（阻断）**：返修项 1 的 no-op 短路在"输入摘要未覆盖 `project_accounting_profile_version`
（核算窗口）"时会**静默冻结陈旧归集并通过结账**。已在本工作树**外**（`/tmp` 副本）实证复现：
旧代码 `2a9185c` 在同一场景下是 fail-closed（`stale_input` 拒绝结账），返修后变为 fail-open
（结账 CLOSED，但归集目标错误）。定性为 **P1**，详见 §4-①。按评审规则**未修复**，仅记录。

**总判定：核心功能工程候选 FAIL**（因 P1）。百万行生产规模性能：**未验收**。未 push / 未 merge / 未部署。

---

## 1. 逐项证据（item 1–6）

### 1. P1-a 幂等短路 → no-op 成功（PASS，字面要求满足）

- 短路分支：`packages/database/src/repositories/project-allocation-run-repository.ts:584-598`。
  命中已发布摘要时（`:470-477` 查 `status='SUCCEEDED' AND input_digest=:digest AND algorithm_version=:algo`），
  **只**更新 `status='SUCCEEDED' / finished_at / duration_ms / updated_at`（`:589-597`），
  **不写** `input_digest`、**不置** `is_current`、**不写**份额行与余量行（份额/余量写入仅在 `:479-545` 的 `!existing` 分支）。
  既有发布批次保持 `is_current`（`:547-558` 的关旧 current + `:559-583` 的发布均不在短路分支内）。
- 唯一索引佐证：`packages/database/migrations/0077_project_allocation_compute.js:60-62`
  `project_allocation_run_published_idem_uq ... WHERE status='SUCCEEDED' AND input_digest IS NOT NULL`。
  旧代码 `2a9185c` 的 else 分支写入 `input_digest: inputDigest`（旧文件 :581），故旧代码在该场景必撞唯一索引。
- 回归用例：`packages/database/src/__tests-integration__/project-allocation-close.integration.test.ts:338-411`
  （describe「P1-a：digest 命中幂等再发布」）。断言链与指令要求逐条对应：
  STARTED 后 `dirty=true` 且 `generation > 发布的 captured`（:366-371）、脏输入 close 拒绝（:374-377）、
  `enqueue.created===true`（:379-381）、`runDue` 长度 1 且 SUCCEEDED/error 为 null（:382-386）、
  2 个 SUCCEEDED 中仅 1 个带 digest、仅 1 个 current（:388-393）、dirty=false 且代次=发布捕获值（:395-402）、
  close 返回 CLOSED（:404-407）。
- **实证：该回归在旧代码上必失败（评审在 `/tmp` 副本复现，工作树未改）**：
  将 `project-allocation-run-repository.ts` 还原为 `2a9185c` 版本后运行同一用例：
  ```
  failed: expected [ {…}, {…}, {…} ] to have a length of 1 but got 3   (close 用例 :383)
  OLD_CODE_RESULTS [{"status":"FAILED","error":"duplicate key value violates unique constraint \"project_allocation_run_published_idem_uq\""},
                    {"status":"FAILED","error":"duplicate key value violates unique constraint \"project_allocation_run_published_idem_uq\""},
                    {"status":"FAILED","error":"duplicate key value violates unique constraint \"project_allocation_run_published_idem_uq\""}]
  ```
  即在旧代码一次 `runDueAllocationRuns` 内烧完全部尝试额度转终态 FAILED —— 与 `72-R02-rework.md` 的
  "修复前实证"一致，且证明回归用例具备区分力（非改写断言凑绿）。
- 结论：**字面要求 PASS**。但同一分支的"顺带语义"（代次对齐）引入 P1，见 §3-a / §4-①。

### 2. 退避符号（PASS；失败注入机制判定：可接受）

- 符号：`project-allocation-run-repository.ts:656-663`，`:661` `lease_expires_at: new Date(Date.now() + backoffMs)`（`+`）。
  认领条件为 `:309` `status='RUNNING' AND lease_expires_at < now()`；写成过去会被立即回收。
  `backoffMs = min(60_000·2^(attempt-1), 3_600_000)`（:656），attempt=1 → 60s，窗口内不可重认领。
- 回归用例：`packages/database/src/__tests-integration__/project-allocation-compute.integration.test.ts:490-515`（R02-1）。
  断言 `status=RUNNING`（非终态）、`attempt=1`、`last_error` 非空、`lease_expires_at > Date.now()`，
  且紧接的 `runDueAllocationRuns` 返回长度 0（:511-514）。实测通过。
- **失败注入机制可接受性判定：可接受（附条件）**。注入点 `compute.integration.test.ts:494-497`：直接向
  `operating_bill_request_project_assignment` 插入一行 `project_principal_id = <EMPLOYEE>`。
  该状态经正常写路径不可达（`operating-bill-repository.ts:256-258` 校验目标必须是同企业 `PROJECT`，
  否则抛 `OperatingBillReferenceError`），因此它是**合成夹具**。判定为可接受，理由：
  1. 它触发的失败是**通用**的可重试失败路径——发布期 `project_allocation_line` 目标主体触发器拒绝，
     与"业务写失败"在重试/退避语义上等价，并不依赖任何只在该非法状态下才成立的分支；
  2. 用例已在注释中明示"合成/经正常写路径不可达"（`:492-493`），无伪装；
  3. 指令要求"确定性失败"，`numeric` 溢出注入经实施者实测不可行，替代手段有限。
  但**必须承认其局限（记录为 P3，非阻断）**：真实生产中的可重试失败形态（例如 advisory lock 超时、
  真实触发器冲突）**未被覆盖**；且用例断言 `results[0].status==='FAILED'` 而库里是 `RUNNING`，
  暴露 `ExecuteRunResult.status` 对"可重试失败"语义不准（见 §4-⑤）。

### 3. P1-b 人工指定/归属回填/finance 回填同事务推脏（PASS）

公共账期推导与推脏助手：`packages/database/src/repositories/project-allocation-common.ts:129-149`
（`allocationMonthsForRequests`，`CASE WHEN finance.enabled THEN settled_at ELSE created_at END AT TIME ZONE 'Asia/Shanghai'`）
与 `:152-165`（`markAllocationDirty`，`new Set(months)` 去重后逐月 upsert，`generation+1`）。
与扫描/`account_at` 同口径佐证：`operating-bill-account-month-lines.ts:11-19` 同样用
`CASE WHEN finance.enabled THEN ll.settled_at ELSE ll.created_at END AS account_at`。

三条写入路径（同一事务性逐条核对）：

| 路径 | 调用点 | 事务 | 按批聚合 | 账期来源 |
| --- | --- | --- | --- | --- |
| 人工指定 | `operating-bill-project-attribution.ts:70-75` | **是**：`operating-bill-repository.ts:249` 开 `this.db.transaction()`，`:290` 传 `trx` 调用 `appendProjectAttributionCorrection(trx,…)` | 单请求（该操作本就是单请求），`markAllocationDirty` 内去重 | `allocationMonthsForRequests(trx, ent, [requestId])` |
| 归属回填 | `principal-attribution-backfill.ts:175-179` | **是**：显式 `trx`（`:176`） | 是：`ids` 整批 → 去重月集合后一次标记，无逐行标记 | `allocationMonthsForRequests(trx, ent, ids)` |
| finance 原地回填 | `provider-finance-usage-backfill.ts:164-172` | **是**：显式 `trx`（`:167`） | 是：先 `SELECT DISTINCT line.ai_request_id`（`:157-165`）仅取"实际变更行"的请求集 | `allocationMonthsForRequests(trx, ent, changedRequests…)` |

- 无"用新 db 句柄代替 tx"的情形：三条路径均把事务对象透传（人工指定经 `assignRequestToProject` 的 `trx`）。
- 账期口径与 scan/`account_at` 一致（同为 settled_at/created_at 北京自然月）；finance 原地 `UPDATE` 不前进
  `created_at`，故必须由写入方推脏——该点正确。
- 回归：`principal-attribution-backfill.integration.test.ts:36-43`（2026-09 脏行存在且 dirty=true）；
  `compute.integration.test.ts:516-540`（R02-2 finance 原地回填推脏）；
  `close.integration.test.ts:412-483`（P1-b：指定后脏代次前进→close 拒绝→tick 自动重算为 MANUAL_ASSIGNMENT
  且 target=指定项目→close 放行）。均通过。

### 4. `HISTORICAL_UNKNOWN` 需"无参与证据"（PASS）

- 契约注释：`packages/domain/src/project-allocation/allocation.ts:90`
  "启用起始账期（含）之前的请求开始时间**且无参与证据** → HISTORICAL_UNKNOWN"。
- 实现：`allocation.ts:222-238` `unallocatedReasonFor`，次序 `RULE_PENDING_REPAIR` >
  （`!hasMembership && 早于 cutoff`）`HISTORICAL_UNKNOWN` > `hasMembership ? NO_EFFECTIVE_RULE : NO_MEMBERSHIP`；
  在 `:250-253` 取代原内联判定（原实现缺少 `!hasMembership` 前提）。
- 金标用例：`packages/domain/src/__tests__/project-allocation.test.ts:270-286`
  "cutoff 之前但有参与证据且无有效规则 → NO_EFFECTIVE_RULE（份额仍全额未分配 = `10.0000`）"——
  该用例在旧代码上会得到 `HISTORICAL_UNKNOWN`，是**真实回归护栏**。
  `:288-303` 另一条"参与但规则待修复 → RULE_PENDING_REPAIR 优先"成立，但**旧代码同样成立**（旧代码首分支即为
  `rulePendingRepair`），属次序确认而非区分性护栏（记录为 P3）。
- 既有用例 `:261-269`（cutoff 之前且无参与）仍为 HISTORICAL_UNKNOWN，未被破坏。domain 205/205 通过。

### 5. 门禁稳定（DB 时钟）（PASS）

- tick 时钟改从 DB 取：`project-allocation-scan.ts:35-36` `SELECT now() AS now`；候选行比较用同一 DB `now`
  （`:63` `ll.created_at < ${now}`），水位与 `last_marked_at` 亦用 DB 时钟/`now()`（`:76,79,99-103`）。
- 测试种子改用 DB 时钟：`close.integration.test.ts:198-208`（`SELECT now(), to_char(now() AT TIME ZONE 'Asia/Shanghai','YYYY-MM')`），
  断言月份由 DB 时钟推导（原为硬编码 `2026-09`）。
- 三连跑结果见 §2：**3 次均 36/36 全绿**，无 unhandled error。
- 保留意见：3 次通过是样本证据，不等于统计意义上的无 flake；但根因（宿主 JS 时钟 vs DB `now()` 写
  `last_marked_at` 的偏斜）已被消除，方向正确。

### 6. 顺手项 1–6（PASS）

- **余量减数按 `ledger_line_id` 去重**：`project-allocation-run-repository.ts:515-528`
  （`DISTINCT ON (ledger_line_id) … ORDER BY ledger_line_id, provider_resource_id` 后再 `SUM`）。
  修正了多目标拆分时每份都带整行源套餐成本导致减数被放大的问题。
- **tick 自登记已脏未消费账期**：`project-allocation-scan.ts:82-97`（`pendingDirty` 查询 `d.dirty AND
  (r.id IS NULL OR d.generation > COALESCE(r.input_dirty_generation,0))`），结果新增 `monthsEnqueued`
  （`:19-20`），worker 日志随之扩展（`apps/worker/src/main.ts:373` `...allocation`）。
  回归：`close.integration.test.ts:212-271`（P2-c：纯规则变更、无新 ledger 行 → tick 自行登记重算 → close 放行）。
- **项目 allocation-lines 严格项目口径**：`project-allocation-read-repository.ts:290`
  收紧为 `l.target_type='PROJECT' AND l.target_project_principal_id=:projectId`（不再混入企业级 UNALLOCATED）。
  回归：P2-c 用例 `:229-231` 断言重构前 `total=0`、重构后 `total=1`。
- **allocation-lines 端点解析项目主体**：`apps/control-api/src/operating-bills/project-allocation-routes.ts:93-101`
  调 `resolveAllocationPrincipal(app.db, ent, projectId, "PROJECT")`，`PrincipalNotAccessibleError` → 404 `not_found`。
  回归：`apps/control-api/src/__tests-integration__/project-allocation-routes.test.ts:335-353`（不存在/跨企业/员工冒充 → 3×404）。
- **project-unallocated 返回明细 + 过滤**：新增 `listUnallocatedLines`（`read-repository.ts:309-366`，
  支持 reason/employee/resource 过滤，`target_type='UNALLOCATED'`）；路由透出 `detail`
  （`project-allocation-routes.ts:119-150`；员工/资源非法 UUID 400、跨企业员工 404）。
  回归：`project-allocation-routes.test.ts:355-381`（200+detail、跨企业员工 404、非法资源 400）。
- **Web 不再硬编码 `expectedVersion: 0`**：`apps/web/src/pages/ProjectMembers.tsx:342`
  `expectedVersion: memberships.data?.accountingProfile?.version ?? 0`；数据来自同项目的
  `/principals/:projectId/project-memberships`（`apps/control-api/src/principals/project-allocation-routes.ts:147-149`
  新增 `accountingProfile`，查询实现 `project-accounting-lifecycle-repository.ts:64-81`）；类型
  `apps/web/src/api/project-allocation.ts:27`。
- **7 个 diag 文件移除**：`packages/database/diag-{allocation,close,intent,prev,2,3,4}.ts` 已不在树中（`git diff --stat` 显示 7 个删除）。
- **`attribution_watermark` 死列移除（四面向）**：迁移建表 `migrations/0077_project_allocation_compute.js:203-206`；
  kysely 类型 `src/kysely-allocation-tables.ts:181-185`；扫描只读 `ledger_line_watermark`（`scan.ts:43-47,99-103`）；
  文档 `10-WP01-contract.md`（§3 表 + §5.2）、`50-WP06-implementation.md`（#2）。
  全仓 `grep attribution_watermark` 仅剩返修记录/文档的说明性文字，无代码引用。

---

## 2. 三个并行门禁运行结果（指令原文命令，逐次）

命令（`packages/database`）：`corepack pnpm vitest run` 四个文件
（foundation + compute + close + invariance）`--reporter=basic`。

| 运行 | 结果 | Test Files | Tests | 用时 |
| --- | --- | --- | --- | --- |
| 第 1 次 | **PASS** | 4 passed (4) | **36 passed (36)** | 30.32s |
| 第 2 次 | **PASS** | 4 passed (4) | **36 passed (36)** | 20.85s |
| 第 3 次 | **PASS** | 4 passed (4) | **36 passed (36)** | 22.21s |

三次均含新增回归（P1-a、P1-b、P2-c、R02-1、R02-2）且无 unhandled error。

其余门禁（评审独立重跑）：

| 套件 | 结果 |
| --- | --- |
| `packages/domain` `pnpm run test` | 205 passed / 13 files |
| `apps/control-api` routes 集成 | 13 passed |
| `packages/database` principal-attribution-backfill | 4 passed |
| `packages/database` migration（migrateUp/Down ladder） | 7 passed |
| 根 `pnpm run typecheck` | exit 0（11 包） |
| 根 `pnpm run lint` | exit 0（`--max-warnings=0`） |

未运行（见 §5）：根全量测试、web 单测、e2e、容量/百万行。

---

## 3. 对抗项 a/b/c 判定

### a. no-op 分支的代次对齐（`run-repository.ts:611-631`）——核心不变量自洽，但组合出 P1

机制：no-op 命中后，若 `dirty.generation > 已发布批次 input_dirty_generation`，把该账期
`generation` 对齐到发布批次捕获值（**条件更新** `WHERE generation = <读取值>`，`:624-629`），再
无条件 `dirty=false`（`:632-636`）。no-op 语义为"摘要相等 ⇒ 当前输入与已发布结果一致"。

- **能否吞掉并发标记？可以，但属既有缺陷。** 条件更新本身安全（并发推进代次后 `WHERE generation=<旧值>`
  不命中，不改动）。但紧随其后的 `dirty=false` **无代次守卫**：若并发写在 `:601` 读之后、`:632` 写之前提交了
  `generation+1`（READ COMMITTED 下两语句各取快照，`UPDATE` 仍按主键命中该行），则结果态为
  `generation=G+1, dirty=false`，标记被吞。后果：该账期被 tick 的 `pendingDirty`（要求 `d.dirty`）永久漏登记，
  而结账闸门仍按 `generation > captured` **拒绝**（`freeze.ts:59-68`），于是"闸门拒绝 + 自动恢复丢失"，
  需人工点重建（存在手动登记端点 `operating-bill/project-allocation-routes.ts:43-48`）才能解。
  **该 `dirty=false` 无守卫在 `2a9185c` 已存在**（旧文件同款），非本轮引入；且方向是 fail-closed（不会静默放行）。
  定性 **P2**，建议后续给 `dirty=false` 也加条件守卫或改为"仅当 `generation` 未变才清 dirty"。
- **是否放宽了 close 闸门？未改闸门代码**（`freeze.ts:59-68` 原样），且对齐后 `generation == captured`，
  对"摘要已覆盖的输入"放行是正确的。
- **其它读者是否依赖 generation 单调？否。** 全部读取点（`read-repository.ts:59` stale 判定、
  `run-repository.ts:268-272` 登记去重、`scan.ts:92` 待登记查询、`freeze.ts:66` 闸门）都只做
  `generation` 与 `captured` 的大小比较，无单调假设；对齐后各点结论一致。
- **但它能否让闸门接受"真正陈旧"的结果？能——这是本轮新引入的 P1。** 关键：`inputDigest`
  （`run-repository.ts:440-442` = `sha256([period_month, lines.length, factXor, ruleDigest, membershipDigest, manualDigest])`）
  **不包含核算窗口** `project_accounting_profile_version`，而该窗口经 `loadAllocationContexts`
  （`:120-125`）进入 `accountingByProject`，并在领域层直接决定结果（`allocation.ts:123-130`：
  `accounting === undefined → accountingCovers=true`；窗口存在但请求时点早于 `startedAt` → `false` → `rulePendingRepair`）。
  于是"先发布规则、后月中开始核算"会把同一批行从 `MEMBERSHIP_RULE`（已分摊）改为
  `RULE_PENDING_REPAIR`（100% 未分配），**金额量级变化**，而摘要不变 ⇒ no-op ⇒ 对齐代次清 dirty ⇒ close 放行。
  完整实证与可复现步骤见 §4-①（P1）。

### b. tick 每拍自登记"已脏未消费"账期（可接受，P2）

- **会否对确定性失败的账期无限循环？会。** 失败不消费 dirty（`dirty` 保持 true），超 3 次尝试后 run 转终态
  FAILED（`:650-654`）。下一拍 `pendingDirty` 仍命中（`d.dirty` 且 `generation > 已发布 captured`）⇒
  `enqueueAllocationRun` 因无活动 run 而**新建** QUEUED（`:249-287`）⇒ 再失败 3 次 ⇒ 再新建。
  每轮退避 60s→120s 后转终态，即**约每 3 分钟新建一个 run**，无周期级上限/冷却。
- **是否可接受？可接受，但需跟进。** 方向正确：失败**可见**（`last_error`、worker `project_allocation_tick_completed`
  日志含 `monthsEnqueued`/`runsCreated`），优于静默陈旧冻结——这正是本项返修的目标。但代价是
  `project_allocation_run`（append-only，无清理）**无界增长**，且每轮写 `last_error`。合同 §5.4 的
  "自动刷新最小间隔默认 30s"与 §5.4"失败有界退避"目前**只有 per-run 有界、无 per-period 冷却**；
  实施者已在 `72-R02-rework.md §3.3` 自陈。定性 **P2**（运营议题）：建议加 per-period 冷却 + 失败告警 +
  run 历史保留策略。非阻断。

### c. 0077 迁移编辑是否破坏阶梯（PASS）

- 0077 由本候选线引入（`2a9185c` 已存在，本轮仅删 1 行死列），未部署，编辑安全。
- 迁移 `up` 建表不含 `attribution_watermark`（`0077:203-206`）；`down` 为整表 `DROP TABLE project_allocation_scan_watermark`
  （`0077:275`），与是否含该列无关，回退路径不受影响。
- 无其他引用：全仓 grep `attribution_watermark` 仅命中文档说明文字。
- `migration.integration.test.ts`（含 `migrateToLatest` 建表 + `migrateDown` 回滚最近迁移）**7/7 通过**；
  foundation 用例「0076/0077 迁移后新表存在；触发器与复合 FK 生效」通过。**阶梯完好**。

---

## 4. 新增发现（P0/P1/P2）

### ① P1（阻断，本轮引入）：no-op 短路 + 代次对齐可静默冻结陈旧归集并通过结账

**影响**：结账冻结（`operating_bill_project_allocation_ref`）写入的逐行归集与当前输入不一致，
金额归属错误，且无任何错误/告警；正是合同 §5.5 结账闸门要防的"陈旧归集冻入 ref"。

**根因**：`inputDigest`（`run-repository.ts:440-442`）不含核算窗口（`project_accounting_profile_version`），
但核算窗口直接影响逐行结果（`allocation.ts:123-130`）。窗口发生"改变结果但不动摘要"的变更后，
no-op 分支（`:584-598`）跳过重算，代次对齐（`:611-631`）清掉 dirty，闸门（`freeze.ts:59-68`）放行。

**可复现场景（仅需既有 API/既有测试夹具，无需新权限）**：
1. 项目 P 有成员 + 已发布规则，但**尚无核算窗口**（合法：`validatePolicyRules` 对缺失窗口跳过核算包含校验，
   `policy.ts:86-95` `if (accounting && …)`；`accountingByProject` 缺失项目不报错，`employee-allocation-policy-repository.ts:81-102`）。
   本候选自带用例 `close.integration.test.ts:212-271`（P2-c）即处于该状态，且此时该月已发布
   `MEMBERSHIP_RULE` 归集。
2. 对 P 调 `reviseProjectAccountingLifecycle` 以 **月中生效** 开始核算（例：账期 2026-08、请求在 08-05、
   `effectiveAt=2026-08-15`）。`affectedMonths` 含 2026-08 ⇒ 该账期代次推进（脏）。
3. tick（或手动登记）登记并执行新批次：新批次摘要与已发布批次**相等**（规则/参与/行/人工指定均未变）
   ⇒ 走 no-op 分支，代次对齐、dirty 清除。
4. `closeMonth` 通过，ref 冻结**旧**结果。

**评审实证（在本工作树之外的 `/tmp` 副本；工作树未改动）**：在 P2-c 用例中插入上述 STARTED 步骤后运行，
在当前代码 `e1c9f89` 输出：

```
ADV_STARTED        {"mode":"STARTED","months":["2026-08","2026-09"]}
ADV_GROUND_TRUTH   [{"src":"UNALLOCATED","reason":"RULE_PENDING_REPAIR"}]   ← 领域真值（窗口生效后正确结果）
ADV_TICK           {"…","monthsEnqueued":["…:2026-08","…:2026-09"],"runsCreated":2,"runsExecuted":2}
ADV_RUNS           [{"id":"f85d1cb3","status":"SUCCEEDED","cur":false,"dig":"df85f40a","cap":"1"},
                    {"id":"b871eba4","status":"SUCCEEDED","cur":true, "dig":"e5c10db8","cap":"3"},
                    {"id":"3e84a180","status":"SUCCEEDED","cur":false,"dig":null,     "cap":"4"}]  ← no-op 批次（无摘要、非 current）
ADV_FROZEN_SOURCES [{"sources":"MEMBERSHIP_RULE"}]   ← 仍指向项目（陈旧）
ADV_DIRTY          [{"generation":"3","dirty":false}]  ← 代次对齐到发布捕获值 3 并清脏
   用例结尾 closeMonth ⇒ status CLOSED（测试通过）
```

**对照（证明是本轮引入的 fail-open，而非既有）**：把 `project-allocation-run-repository.ts` 换回 `2a9185c` 版本、
跑同一场景：

```
ADV_RUNS           [{"id":"6330edf2","status":"SUCCEEDED","cur":false,…,"cap":"1"},
                    {"id":"4635c3a4","status":"SUCCEEDED","cur":true, …,"cap":"3"},
                    {"id":"9ba23e16","status":"FAILED",  "cur":false,"dig":null,"cap":"4"}]  ← 撞唯一索引转 FAILED
ADV_DIRTY          [{"generation":"4","dirty":true}]          ← 脏未被消费
closeMonth ⇒ AllocationNotReadyError: stale_input            ← fail-closed，拒绝结账
```

即：旧代码**拒绝结账**（安全但不可用，即 P1-a 原缺陷）；返修后**放行结账并冻结错误归集**（可用但不安全）。
返修以"可用性"换掉了"安全性"。

**建议修复方向（评审不实施）**：把核算窗口纳入 `inputDigest`（例如把 `accountingByProject` 的
`(project_principal_id, started_at, ended_at)` 排序后并入摘要），或收紧 no-op 对账期的适用条件
（仅当脏代次确由"摘要已覆盖的输入"推进时才允许对齐/清脏）。测试侧：新增"规则先于核算窗口、
窗口月中开启、close 必须触发真实重算（不得 no-op）"的回归。

### ② P2：`dirty=false` 无代次守卫可在并发下吞标记并卡死账期

见 §3-a。现有手动重建端点可解，闸门方向 fail-closed；`2a9185c` 已存在同款代码，非本轮引入。
`run-repository.ts:632-636`。建议：改为 `WHERE generation=<observed>` 条件清除，或与对齐更新合并为一条语句。

### ③ P2：tick 对确定性失败账期无界重复登记（append-only run 无界增长）

见 §3-b。`scan.ts:82-97` + `run-repository.ts:249-287`。建议 per-period 冷却/失败告警/保留策略。

### ④ P2：`financeEnabled`、`historicalCutoff` 亦不在 `inputDigest` 内（同类潜在陈旧）

`run-repository.ts:440-442` 未含 `provider_finance_runtime_state.strict_writes_enabled`
（影响 `account_at` 口径，`operating-bill-account-month-lines.ts:11-19`）与
`MIN(project_allocation_period.period_month)`（影响 `historicalCutoff` → 仅原因码）。
- `historicalCutoff`：影响仅限"权重为空"分支的原因码（`allocation.ts:250-257`），**金额中性**，定性 P3。
- `financeEnabled`：口径切换会改变逐月行集合 ⇒ `factXor` 通常随之改变，故当前多能自愈；但若切换未改变
  当月行集合，则同样可能被 no-op 跳过。无写入方钩子推进代次。定性 P2（潜在同源风险），建议与 ①同修。

### ⑤ P3：`ExecuteRunResult.status` 语义、"金标"区分力、集成测试不在 typecheck、no-op run 字段缺失

- `run-repository.ts:668` 对"可重试失败"返回 `status: "FAILED"`，而库中 run 实为 `RUNNING`（R02-1 用例
  `:505` 与 `:507` 同时断言二者）。建议改名为 `retryable`/`error` 以免误读。
- `project-allocation.test.ts:288-303` 的 RULE_PENDING_REPAIR 次序用例在旧代码同样通过，非区分性护栏；
  真正有区分力的是 `:270-286`。
- `packages/database/tsconfig.json` 排除 `src/**/__tests-integration__/**`，集成测试不在 typecheck 覆盖内
  （实施者已自陈，`72-R02-rework.md §3.1`）。
- no-op run 行的 `conservation/result_hash/input_digest` 为 NULL 但 `status='SUCCEEDED'`；因 `is_current=false`
  不会被状态/汇总端点选用（`read-repository.ts:41-46` 按 `is_current` 取），暂无读取错误，但 run 历史页面上
  会呈现"成功却无守恒结果"的行，建议加注记或 `no_op` 标记。

---

## 5. 未能验证 / 未运行

- 根全量测试套件（明确不要求）、`apps/web` 单测、Playwright e2e、容量/百万行性能测试：**未运行**。
- `pnpm run build`：**未运行**（时间取舍；typecheck+lint 已 exit 0）。故未验证产物构建。
- 生产 1M 行规模性能：**未验证**（本候选明确未验收）。
- ①的 P1 已在 `/tmp` 副本实证（当前代码 fail-open、旧代码 fail-closed），但**未**在 1M 行/并发压力下验证；
  "并发吞标记"（②）为代码路径推理，未做并发压测复现。
- web 的 `expectedVersion` 修复经代码/路由/类型核对通过，但未跑 web 单测或浏览器实测。

---

## 6. 状态声明

- 评审未修改任何生产/测试代码；仓库内仅新增本文件 `73-R02-review.md`。
- 发现 P1 后按规则**只记录、不修复**；未 push、未合并、未部署。

**core feature engineering candidate: FAIL**（因 §4-① P1）；**1M-row production performance: NOT ACCEPTED**；
**not pushed/merged/deployed**。
