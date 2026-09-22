# R04 独立评审报告 — 候选 ffe4e8d（R03 P1 按"选项二"返修后的复核）

日期：2026-09-22。评审上下文：独立（未参与实现，未参与 R01/R02/R03）。
工作树：`仟流智算-project-allocation-feature-20260921`，分支
`project-allocation/v12-feature-candidate-20260921`。
被评审 HEAD：`ffe4e8d`（"run 幂等限定 current 发布；闸门改'未消费'谓词；余量 authority 分治（R03 P1）"）；
上一候选：`19f4c64`（R03 判 FAIL）→ `98b1a77`（R03 报告落盘）；计划基线 `2b33719`。
评审范围：`git diff 19f4c64..ffe4e8d`（16 文件：迁移 0077、run/闸门/只读/公共仓储、
finance 事件/续订仓储、close 用例、2 份文档与计划 §9、3 份回执）。
被评审方主张文件：`76-CONTRACT-AMENDMENT-01-run-idempotency.md`、`77-R03-P1-fix.md`（按 CLAIMS 处理，逐条实证）。

评审未修改任何生产/测试代码；仓库内**仅新增本文件** `78-R04-review.md`。
降级副本与探针用例仅创建在 `/tmp`（`/tmp/r04`，工作树外，可随时删除）；结束时真实工作树 `git status` 干净。

---

## 0. 结论摘要

| # | 检查项 | 判定 | 关键证据 |
| - | --- | --- | --- |
| A | **R03 P1 闭合（索引限定 current + 短路收紧 + 删除代次对齐）** | **PASS（字面）** | `0077:62-64`、`run-repository.ts:510-518`、`:625-638`、`:640-662`；A→B→A 用例在 19f4c64 与"仅改仓储不改索引"两态均失败，在 HEAD 通过 |
| B | **闸门"未消费"谓词 + 只读状态同谓词** | **FAIL（运行期不一致）** | 谓词字面同形（`freeze.ts:72` / `read-repository.ts:59-61`），但只读侧是 **JS 字符串比较**：脏 10 / 捕获 9 时报 `stale=false`（探针 D），闸门 BigInt 判 stale → 两侧发散（新 **P1**） |
| C | **三条回归存在且有意义** | **部分** | (a)`:403-475`、 (b)`:339-401`、 (c)`:477-504` 均在位；(a) 有区分力（19f4c64 失败），(b)(c) 在 19f4c64 亦通过；(c) 只用 1→2→3 单数字代次，**未覆盖 9→10 边界**，而该边界上守卫实测失效（探针 F） |
| D | **旧 P1-a 路径死亡证明** | **PASS** | 新索引对非 current 行不设约束（探针 C 实证）；旧仓储（2a9185c）配新索引已无 duplicate key（`/tmp/expA`：3 failed / 8 passed，无唯一键报错）；旧索引配旧仓储仍 3 次尝试即 FAILED（`/tmp/expB`） |
| E | **余量 authority 分治（plan-cash 挂钩+入摘要 / 快照接受滞后）** | **PASS** | 三处钩子同事务（`provider-finance-events.ts:119`、`:397-399`、`provider-finance-renewal.ts:106`）；摘要新增 `planCashDigest`（`:456-469`、`:481`）；`provider_finance_event` 全部 7 个写入点已枚举，事件类型/`cash_paid_cny` 逐一对上；快照写入方（`provider-operating-repository.ts:139`、`provider-operating-snapshot-writer.ts:71`）确未挂钩，合同 §3 已写明"接受滞后" |
| F | **合同修订记录与措辞** | **PASS（附 P3）** | `76-CONTRACT-AMENDMENT-01` 有编号/原因（R03 P1）/关联报告/授权；`10-WP01-contract.md` §3 run 行（:29）、§5.2 #3（:51）、附 D5（:69）、计划 v1.2 §9 #5（:347）均与实现一致；`77-R03-P1-fix.md` 内 run-repository 行号引用过期（见 §10-P3） |
| G | **门禁** | **PASS** | 文档原命令 4 文件并行 3 次 **39/39**（第 3 次首次因容器端口超时失败，清理并发后原命令重跑 39/39）；close 单独 11/11；7 文件 52/52；domain 205/205；routes 13/13；typecheck/lint exit 0 |
| H | **新增 P1（bigint 运行期为 string → 三处裸比较按字典序）** | **FAIL（阻断）** | 探针 D/E/F：只读状态误报新鲜、`enqueueAllocationRun` 拒绝登记必要重算（调度被卡死）、条件清除守卫在 9→10 边界吞掉捕获后标记 |

**核心发现（阻断）**：R03 P1 本身（A）已按用户选定的第二种修法闭合，死亡证明成立；
但本轮"闸门与只读状态同谓词"（用户决策 2）在**运行期**不成立，且同一根因（`bigint` 列经
`pg` 返回为 **string**，Kysely 表类型却声明 `number`，三处裸比较退化为字典序）使
`enqueueAllocationRun` / tick 的重算登记、以及条件清除守卫在 **9→10（及同类进位）边界**上失效：

- 只读状态：脏代次 10、脏标志真、当前批次捕获 9 → `stale=false`（应为 true），而闸门 BigInt 会拒结；
- 登记：同状态下 `enqueue.created=false`、`tick` 已选中该账期但 `runsCreated=0`、无活动批次
  ⇒ **账期被卡死**（闸门拒绝结账且调度永不重登记），直到代次涨到 90（约 80 次标记）或人工改库；
- 清除守卫：捕获 9 / 脏 10 时 `dirty` 被清除（`77-R03-P1-fix.md` 声称"并发推进代次时不吞标记"，
  `75-R03-review.md` §3 声称"不会卡死账期"，两条主张同时被实证否定）。

按评审规则**未修复**，仅记录并停止。

**总判定：核心功能工程候选 FAIL**（因 §5 的 P1）。百万行生产规模性能：**未验收**。未 push / 未 merge / 未部署。

---

## 1. 评审方法与实证环境

- 静态：逐条对照 `76-CONTRACT-AMENDMENT-01`、`77-R03-P1-fix.md`、`75-R03-review.md`、
  `73-R02-review.md`、`10-WP01-contract.md` 与 HEAD 代码。
- 实证：`/tmp/r04`（工作树 `tar` 副本，排除 `.git`）+ 临时探针
  `packages/database/src/__tests-integration__/zz-r04-scratch.integration.test.ts`（**仅存在于 /tmp**）。
  探针 A–F 原文见下各节；降级实验（回退旧仓储/旧迁移）同样只发生在副本内。
- 真实工作树未做任何写入（评审前后 `git status --short` 均为空，唯一新增文件为本报告）。

---

## 2. 用户五项决策的逐条核验

### 决策 1：R03 P1 按"选项二"闭合（放宽幂等索引 + 短路收紧为命中即 current + 删除代次对齐）

| 断言 | 判定 | 证据（HEAD） |
| --- | --- | --- |
| 幂等索引加 `AND is_current` | **属实** | `migrations/0077_project_allocation_compute.js:60-64`：`CREATE UNIQUE INDEX project_allocation_run_published_idem_uq ... WHERE status = 'SUCCEEDED' AND input_digest IS NOT NULL AND is_current`（原地改 0077，无 0078；注释写明"输入回到历史状态时允许确定性重发布为 current"） |
| 短路仅命中 current 才 no-op | **属实** | `project-allocation-run-repository.ts:510-518`，其中 `:517` `.where("is_current", "=", true)` |
| 命中非 current ⇒ 完整确定性重发布 | **属实** | 同一 `if (!existing)` 分支写份额行（`:521-526`）、余量（`:530-586`）、关旧 current（`:587-599`）、发布 `is_current=true + input_digest`（`:600-624`） |
| 代次对齐 hack 已删除 | **属实** | 旧代码 `published`/`publishedCaptured`/`set({ generation: publishedCaptured })` 全部消失；清 dirty 块（`:640-662`）只 `set({ dirty: false })`（`:657`），条件为 `WHERE generation = dirty.generation`（`:660`）；全仓储再无 `generation` 写入 |
| no-op 不写 `input_digest`/不夺 current | **属实** | `:625-638` 仅 `status/finished_at/duration_ms/updated_at` |

补充观察（非缺陷，记录）：新谓词下 `project_allocation_run_published_idem_uq` 被
`project_allocation_run_current_uq`（`0077:58-59`，`(enterprise, period) WHERE is_current`）
**逻辑蕴含**，即"同输入同算法至多一份发布"这一历史不变量实际被替换为"至多一个 current"。
与修订后合同措辞（"当前发布幂等"）一致，属用户授权范围内；但索引现状是冗余约束，
后续若有人依赖它防重会误判（建议在合同注明，不影响本轮判定）。

### 决策 2：闸门陈旧谓词＝"未消费的脏代次"，且只读状态同谓词

- 闸门：`project-allocation-freeze.ts:59-74`，精确谓词 `:72`
  `if (dirtyRows[0]?.dirty === true && BigInt(generation) > BigInt(captured)) throw new AllocationNotReadyError("stale_input")`。
  `generation`/`captured` 均以 `::text` 读出再 `BigInt` 比较（`:65-71`）→ **正确**。
- 只读：`project-allocation-read-repository.ts:47-51` 选 `generation, dirty`；`:59-61`
  `stale: dirty !== undefined && dirty.dirty === true && (run.input_dirty_generation ?? 0) < dirty.generation`。
  谓词**字面同形**，但两侧数值语义不同 → **运行期发散**（见 §5，P1）。

### 决策 3：三条回归用例

| 要求 | 用例 | 判定 |
| --- | --- | --- |
| (a) A→B→A 重发布为 current 且 close 冻结新批次 | `close.integration.test.ts:403-475` | **PASS**：断言新批次即 current（`:449`）、摘要与历史 A 相同（`:450`）、当前批次来源/目标为 MANUAL_ASSIGNMENT/项目 A（`:452-458`）、dirty 清（`:460-463`）、close CLOSED（`:465-468`）、ref 冻结 == 新批次（`:469-474`）。区分力实证：在 19f4c64 失败（§4） |
| (b) no-op 命中 current 消费脏代次、close 放行 | `:339-401` | **PASS**：脏输入先拒结（`:362-364`）→ 登记执行 SUCCEEDED/error null（`:373-376`）→ 仅 1 个 SUCCEEDED 带摘要、仅 1 个 current（`:379-386`）→ dirty=false（`:389-392`）→ `getAllocationRunStatus.stale===false`（`:394-395`）→ CLOSED（`:397-400`）。**但该用例在 19f4c64 亦通过**，护栏价值为"防止回退"，非本轮区分性证据 |
| (c) 捕获后落下的脏标记不被吞、闸门拒结 | `:477-504` | **部分**：断言在位（dirty 保留 `:495-498`、只读 stale=true `:499-500`、gate 拒结 `:501-503`），但在 19f4c64 亦通过（旧代码同款代次守卫已生效）⇒ 属"性质保持"护栏而非本轮修复的区分证据；更重要的是该用例只用 **1→2→3 单数字代次**，在 9→10 进位边界上守卫实测失效（§5-P1、探针 F），故它**不足以**支撑"不会吞标记"这一主张 |

### 决策 4：余量 authority 分治

- **plan-cash 入摘要**：`run-repository.ts:453-469` 新增 `planCashDigest`
  （`md5(string_agg(resource_id||':'||amount ...))`，过滤 `event_type IN ('CODING_PLAN_PURCHASE','CODING_PLAN_RENEWAL','REVERSAL')`
  + `resource.mode='CODING_PLAN'` + 当月 `occurred_at` 区间），并入 `inputDigest`（`:481`）。与余量 authority 查询
  （`:530-540`）同过滤、同 `SUM(...)::numeric(24,8)`、同月份口径 ⇒ 现金事件变化必改摘要、必走重发布分支（余量随之刷新）。
- **三处同事务钩子**：`provider-finance-events.ts:117-119`（`recordSubscription`，资源 mode 校验在 `:71` 断言 CODING_PLAN）、
  `provider-finance-events.ts:396-399`（`reverseFinanceEvent`，仅 `resource.mode==='CODING_PLAN'`，月份取 `original.occurred_at`）、
  `provider-finance-renewal.ts:105-106`（`renewDueSubscription`，月份取周期起始 `start`）。三处均在既有 `db.transaction()` 内使用同一 `trx`。
  月份助手 `shanghaiMonthOf`（`project-allocation-common.ts:151-155`）与余量按月口径一致。
- **写入方穷举**（`grep insertInto("provider_finance_event")` + 原始 SQL 排查，生产代码共 7 处）：

  | 位置 | event_type | cash_paid_cny | 是否 authority | 需钩子 |
  | --- | --- | --- | --- | --- |
  | `provider-finance-events.ts:94`（recordSubscription，mode 必须 CODING_PLAN） | CODING_PLAN_PURCHASE / CODING_PLAN_RENEWAL | 非空 | 是 | **已有**（`:119`） |
  | `provider-finance-events.ts:149`（recordSimpleEvent，mode 必须 API） | API_OPENING_BALANCE / API_RECHARGE | 非空（RECHARGE） | 否（类型不在列表且资源 mode=API） | 不需要 |
  | `provider-finance-events.ts:343`（recordOpeningCorrection，API） | API_OPENING_BALANCE_CORRECTION | NULL | 否 | 不需要 |
  | `provider-finance-events.ts:381`（reverseFinanceEvent） | REVERSAL | 原值取反 | 仅当原资源 CODING_PLAN | **已有**（`:397-399`） |
  | `provider-finance-legacy-resolution.ts:124` | API_LEGACY_COST_ADJUSTMENT | NULL | 否 | 不需要 |
  | `provider-finance-renewal.ts:94` | CODING_PLAN_RENEWAL | 非空 | 是 | **已有**（`:106`） |
  | `provider-finance-reconciliation.ts:124` | API_BALANCE_RECONCILIATION | NULL | 否 | 不需要 |

  结论：**无遗漏的 CODING_PLAN 现金写入路径**；REVERSAL 的月份取原事件月（与余量/摘要的 `occurred_at` 过滤一致）。
  另：`provider_finance_event` 有 0059 的 append-only 触发器（UPDATE/DELETE 拒绝），历史现金额不可变，摘要口径稳定。
- **快照接受滞后**：两个快照写入方均未挂钩（`provider-operating-repository.ts:139`、`provider-operating-snapshot-writer.ts:71`），
  合同 §3 `project_allocation_resource_residual` 行（`10-WP01-contract.md:31`）与 `77-R03-P1-fix.md` §2 已写明"接受滞后、不入摘要、不挂钩"。
  余量只在非 no-op 分支写入（`run-repository.ts:576-586`）、只被 `getUnallocatedSummary`（`read-repository.ts:181`）读取，
  不进 close ref（`freeze.ts:84-98` 冻结字段仅 run 侧）、不进守恒 ⇒ 不影响结账冻结内容，**判定成立**。

### 决策 5：合同修订记录与措辞

- `76-CONTRACT-AMENDMENT-01-run-idempotency.md` 存在：编号、日期、修订原因（R03 P1，指向 `75-R03-review.md` §4-①）、
  关联报告（73/74/75/77）、用户授权（"选第二种"）、措辞对照表、不变量、影响面齐备。
- 措辞与实现一致（`git diff 19f4c64..ffe4e8d` 逐条核对）：
  - `10-WP01-contract.md:29` §3 run 行："已发布幂等索引限定 `is_current`" + 陈旧度＝
    `dirty.dirty = true AND dirty.generation > run.input_dirty_generation`（闸门与只读同谓词）— 与 `0077:62-64`、`freeze.ts:72`、`read-repository.ts:59-61` 文本一致；
  - `10-WP01-contract.md:51` §5.2 #3："同输入+算法幂等**限定当前发布**（同摘要的历史批次不复活…）"；
  - `10-WP01-contract.md:69` 附 D5："run 幂等键=(企业,账期,input_digest,algorithm_version)**且限定 `is_current`**"；
  - 计划 v1.2 `:347` §9 #5："幂等限定于当前发布…`76-CONTRACT-AMENDMENT-01`"。

---

## 3. 旧 P1-a 路径死亡证明（必检项）

**主张**：原缺陷"短路分支写回 `input_digest` → 撞 `project_allocation_run_published_idem_uq`
→ 一次 `runDue` 内烧完全部尝试额度转终态 FAILED → 账期永久 `stale_input`"不再可能。

**为什么不再可能（两条独立理由）**：

1. 新代码 no-op 分支根本不写 `input_digest`（`run-repository.ts:625-638`）；
2. 即使写了，新索引对**非 current** 行不再设约束（`0077:62-64`），历史批次与当前批次可同摘要共存。

**实证 1（探针 C，索引语义直接验证，`/tmp`）**：同一账期先建旧谓词索引，插 1 条 current SUCCEEDED，
再插同摘要的非 current SUCCEEDED；随后换回新谓词索引重复插入：

```
R04_PROBE_C {"oldIndexError":"duplicate key value violates unique constraint \"project_allocation_run_published_idem_uq\"","oldIndexRowCount":1,"newIndexError":null}
Test Files  1 passed (1)   Tests  3 passed (3)
```

**实证 2（按指令的降级副本实验）**：`/tmp/r04` 内把 `project-allocation-run-repository.ts`
换成旧版 `2a9185c`（短路分支写 `input_digest`），**保留 HEAD 的新迁移/索引**，跑同一条 close 用例文件：

```
$ node /tmp/r04/node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts \
    src/__tests-integration__/project-allocation-close.integration.test.ts
 FAIL ... > 启用→SUCCEEDED→代次前进但摘要未变…→no-op 成功、dirty 清除、close 放行
   → expected [ { …(4) }, { …(4) } ] to have a length of 1 but got 2      ← 仅"1 条带摘要"新语义断言失败
 FAIL ... > R03-P1：人工指定 A→B→A …                                        ← 旧代码命中历史批次即 no-op
   → expected 'dd8a6fad…' to be '3e2be0ab…'
 FAIL ... > R02-P1 回归：核算窗口变化必须真实重算…                            ← 旧代码无 accountingDigest
   → expected 'MEMBERSHIP_RULE' to be 'UNALLOCATED'
 Test Files  1 failed (1)      Tests  3 failed | 8 passed (11)
```

关键点：**输出中不存在 `duplicate key`**，且 `:373-376`（`second` 长度 1、SUCCEEDED、error null）全部通过
——即旧代码在新索引下已能成功 no-op，原"唯一键 → 终态 FAILED"路径在 schema 层已死。

**对照基线（旧仓储 + 旧索引，`/tmp/expB`）**：同一用例文件

```
 FAIL ... > 启用→SUCCEEDED→代次前进但摘要未变… 
   → expected [ { …(4) }, { …(4) }, { …(4) } ] to have a length of 1 but got 3   ← 一次 runDue 内 3 次尝试
 FAIL ... > R03-P1：人工指定 A→B→A > A2: expected 'FAILED' to be 'SUCCEEDED'
 Test Files  1 failed (1)      Tests  4 failed | 7 passed (11)
```

即原缺陷（一次调用烧完全部尝试额度）可复现，反向证明本轮索引改动的承载作用。

---

## 4. 三条回归的区分力（降级副本实证）

同一 close 用例文件在三种降级态下的结果：

| 副本状态 | 结果 | 失败用例 |
| --- | --- | --- |
| 19f4c64 仓储 + 19f4c64 迁移（R03 修复前） | 1 failed / 10 passed | **仅** A→B→A（`backToA` 未成为 current） |
| HEAD 仓储 + 19f4c64 迁移（仅缺索引放宽） | 1 failed / 10 passed | **仅** A→B→A（`A2: expected 'FAILED' to be 'SUCCEEDED'` — 同摘要重发布撞旧索引） |
| 2a9185c 仓储 + 新索引 | 3 failed / 8 passed | P1-a（摘要断言）、A→B→A、R02-P1 |
| 2a9185c 仓储 + 旧索引 | 4 failed / 7 passed | 上述 3 条 + (c) 并发推脏 |
| HEAD（真实候选） | 0 failed / 11 passed | — |

结论：
- **(a) 有真实区分力**，且同时证明"短路收紧"与"索引放宽"**两半都是承载件**（任缺其一，A→B→A 都无法正确重发布）。
- **(b)** 在位、断言完整，但在 19f4c64 亦通过 ⇒ 属回退护栏。
- **(c)** 在位，但在 19f4c64 亦通过（旧代码同款代次守卫已生效），区分力来自更早的 2a9185c（无条件清除）；
  其代次只用单位数，**未覆盖进位边界**，而该边界正是 §5-P1 的触发条件。

---

## 5. 门禁 / 只读状态一致性（含新 P1）

### 5.1 消费者清单与语义核对（`grep` 全仓）

| 消费者 | 位置 | 谓词 | 与"未消费"语义 |
| --- | --- | --- | --- |
| 结账闸门 | `project-allocation-freeze.ts:65-74` | `dirty===true && BigInt(gen) > BigInt(captured)` | 一致（BigInt，正确） |
| 只读状态 `stale` | `project-allocation-read-repository.ts:59-61` | `dirty===true && (captured ?? 0) < gen` | **字面一致、运行期发散**（见 5.2） |
| tick 待登记 | `project-allocation-scan.ts:85-93` | SQL：`d.dirty AND (r.id IS NULL OR d.generation > COALESCE(r.input_dirty_generation,0))` | 一致（SQL 数值比较）；**但随后调用 `enqueueAllocationRun` 时改用 JS 比较**（见 5.3） |
| 登记短路 | `project-allocation-run-repository.ts:268-283` | `current.status==='SUCCEEDED' && (current.input_dirty_generation ?? 0) >= generation` | **运行期错判**（见 5.3） |
| Web 呈现 | `apps/web/src/pages/OperatingBillProjectAllocation.tsx:107`；类型 `apps/web/src/api/project-allocation.ts:107` | 直接呈现只读 `stale`（"待更新/可用"） | 随只读状态一起发散 |
| 条件清除 | `project-allocation-run-repository.ts:651` | `dirty.generation <= (captured.input_dirty_generation ?? 0)` | **运行期错判**（见 5.4） |

无任何消费者仍在使用"裸代次比较即陈旧"的**语义**（闸门/tick SQL 已统一）；问题出在 **JS 运行期类型**。

### 5.2 新 P1 之一：只读状态与闸门在运行期发散（探针 D 原文）

```
R04_PROBE_D {"typeofDirtyGeneration":"string","typeofRunCaptured":"string",
 "rawDirtyGeneration":"10","rawRunCaptured":"9",
 "lexicographicLe":true,"numericLe":false,"reportedStale":false,"dirtyFlag":true}
```

事实链：
- `project_allocation_dirty.generation` 与 `project_allocation_run.input_dirty_generation` 均为 `bigint`
  （`0077:33`、`:200`），`pg` 驱动默认把 `int8` 解析为 **string**；`createKysely`（`kysely.ts:135-139`）
  未配置 `setTypeParser`，全仓亦无 `setTypeParser`；Kysely 表类型却声明为 `number`
  （`kysely-allocation-tables.ts:95`、`:176`）→ **类型谎言**。
- 于是 `(run.input_dirty_generation ?? 0) < dirty.generation` 变成字符串字典序：
  `"9" < "10"` 为 **false**（'9' > '1'）⇒ 脏代次 10、脏标志真、捕获 9 时只读状态报 `stale=false`，
  而闸门用 `BigInt` 判 `10 > 9` 为真 ⇒ **同谓词、不同结论**。
- 触发条件（进位边界）：脏代次为 10..19 且捕获为 2..9（同类：3 位 100..199 对 2 位 11..99 捕获）——即
  "上次发布时捕获单位数代次、随后第 10 次标记落下"，属常规运营序列，非构造场景。

影响：GET `project-allocation-status` 与项目归集页显示"可用"，用户在结账时被闸门拒绝（`allocation_stale`），
两侧无任何一处提示"存在未消费脏代次"；与用户决策 2（"只读状态与闸门同谓词，避免页面报'待更新'而结账放行的矛盾"）方向相反。

### 5.3 新 P1 之二：`enqueueAllocationRun` 短路误判 → 账期被卡死（探针 E 原文）

```
R04_PROBE_E {"captured":"9","dirtyGeneration":"10","enqueueCreated":false,"enqueueStatus":"SUCCEEDED",
 "tickSelectedMonth":true,"tickRunsCreated":0,"activeRuns":0,"readModelStale":false}
```

- `run-repository.ts:279-283`：`generation` 来自 `dirty?.generation`（string），
  `current.input_dirty_generation` 亦为 string ⇒ `"9" >= "10"` 为 **true** ⇒ 直接返回
  `{ created: false, status: "SUCCEEDED" }`，**不登记重算批次**。
- tick 的 SQL 选出了该账期（`tickSelectedMonth=true`），但登记入口仍走
  `enqueueAllocationRun`（`scan.ts:111-114`）⇒ `runsCreated=0`、无 QUEUED/RUNNING 批次
  ⇒ 脏代次永不消费 ⇒ 闸门持续拒结；同一状态下 API `POST /project-allocation-runs` 返回
  200/`created:false`，运营点"重建批次"也无效。
- 卡死区间："数值更大但字典序更小"的进位段（如捕获 9 对脏 10..89、捕获 19 对脏 100..189；
  而捕获 9 对脏 90..99 可正常登记）。以 9→10 为例，需代次涨到 90（约 80 次标记）或人工改库才会恢复。
  ⇒ 直接否定 `75-R03-review.md` §3 的"tick 仍能自动重新登记 ⇒ 不会卡死账期"，
  也否定 `77-R03-P1-fix.md` §1.4 的"条件写入…保留（并发推进代次时不吞标记）"在本边界上的效力。

### 5.4 新 P1 之三：条件清除守卫在进位边界吞掉捕获后的标记（探针 F 原文）

```
R04_PROBE_F {"runStatus":"SUCCEEDED","captured":"9","dirtyGeneration":"10",
 "dirtyFlagAfter":false,"numericGuardWouldClear":false,"readModelStale":false}
```

- 场景：批次登记时捕获 9（`input_dirty_generation=9`），执行前脏代次被推进到 10（`dirty=true`）。
- `run-repository.ts:651` 的守卫按字典序判 `"10" <= "9"` 为 **true** ⇒ 进入清除块；
  `:656-661` 的 `UPDATE ... SET dirty=false WHERE generation = 10`（SQL 数值比较）命中 ⇒ **标记被吞**、
  `dirty=false`；而按数值（`10 <= 9`）本应跳过清除、保留 `dirty=true` 让闸门拒绝。
- 后果：修订记录中的核心不变量"`dirty=false` 只可能由成功执行（发布覆盖或 no-op 证明与当前输入状态一致）
  产生"在此被证伪——清除发生时，该批次的捕获代次并未覆盖代次 10 的输入状态；
  若这次标记对应的输入变更落在本批次**装载输入之后**（发布事务写份额行阶段窗口很长），
  被冻进 ref 的就是变更前的结果，且闸门与只读状态都会放行（fail-open）。
  该窗口即 R02/R03 引入此守卫要防的场景，现仅在进位边界失效。

### 5.5 并发方向（按指令给出两连接实证 + SQL 推理）

**探针 A（两连接、READ COMMITTED、真实行锁）**：

```
R04_PROBE_A {"blockedWhileMarkOpen":true,"rowsAffected":0,"generation":"6","dirty":true}
（正对照：无并发事务持锁时同一条件清除成功 → dirty=false）
```

推理（与实证一致）：`markAllocationDirty` 的 upsert 与输入写入同一事务并持有脏行行锁；
清除侧 `UPDATE ... WHERE generation = <读到值>` 在 READ COMMITTED 下会**阻塞**在标记事务的行锁上，
标记提交后重判谓词（EvalPlanQual）发现代次已变 ⇒ `rowsAffected=0`，标记不被吞。
**因此 5.4 的吞标记不是并发缺陷，而是数值语义缺陷**：只要脏行已是 10（已提交、无锁争用），
字典序守卫就会在**没有任何并发**的情况下清掉标记（探针 F 即单线程顺序执行）。

---

## 6. 摘要完备性对抗枚举（"覆盖 / 显式接受 / 缺口"）

| 输入 | 影响面 | 在 `inputDigest`？ | 写入方推脏？ | 判定 |
| --- | --- | --- | --- | --- |
| `ledger_line` 行事实（token/费用/币种/质量/mode/资源/主体/created_at|settled_at） | 份额行 | 是（`contentXor` `:394-411` + `lines.length`） | 迟到插入由 tick 水位（阶段一接受滞后） | 覆盖 |
| `ai_request.started_at` / `unified_model_id` | 关系匹配时点/模型列 | 是（`requestStartedAt`、`unifiedModelId`） | 写路径不更新 `started_at`（`gateway-ledger-*` 仅更新状态/完成时间） | 覆盖 |
| `principal.type` | `sourcePrincipalType` | 是 | 主体类型不可改（写路径） | 覆盖 |
| `operating_bill_request_project_assignment` | 人工指定 | 是（`manualDigest` `:448-452` + 行内 `manualProjectId`） | 是（`operating-bill-project-attribution.ts:72-75`，同事务） | 覆盖 |
| 规则/政策（current policy 的规则段） | 权重与目标 | 是（`ruleDigest` `:171-174`） | 是（policy 仓储） | 覆盖 |
| 参与（ACTIVE 修订的 joined/left） | 成员匹配 | 是（`membershipDigest` `:175-178`） | 是（membership 仓储） | 覆盖 |
| 核算窗口 `project_accounting_profile_version` | 权重是否生效 | 是（`accountingDigest` `:181-184`） | 是（`project-accounting-lifecycle-repository`） | 覆盖 |
| 启用起始账期 `MIN(period_month)` | `historicalCutoff`→原因码 | 是（`earliest` `:437-441`、`:482`） | 启用事务登记该月；仅回退启用（更早月）只改**原因码**（`allocation.ts:225-235` 金额中性） | 覆盖（回退启用留 P3 见 §9） |
| finance 口径开关 `strict_writes_enabled` | 逐月行集合（`operating-bill-account-month-lines.ts:11-19`） | 是（`:482`） | **否**（`activateStrictWrites` 未推脏） | **缺口（P2）**，见 §9-P2；探针 B 实证 |
| `provider_finance_event` CODING_PLAN 现金 | 余量表 | 是（`planCashDigest`） | 是（三处钩子） | 覆盖 |
| 其余 finance 事件类型（API_RECHARGE / API_OPENING_* / API_LEGACY_COST_ADJUSTMENT / API_BALANCE_RECONCILIATION） | 不参与归集行与余量 authority（类型+资源 mode 双重过滤） | 不需 | 不需 | 显式排除（§2 枚举） |
| `provider_resource_operating_snapshot` | 余量快照 authority；非 finance 时经 `package_line_cost` 间接影响行摘要 | 直接项：否；间接：经 `packageCost` 是 | 否 | **显式接受滞后**（合同 §3、77 §2）；实测两个写入方无钩子 |
| `provider_resource.mode` | authority 集合与行 mode | 经行内 `resourceMode` 覆盖 | 无 UPDATE 写入方（仅创建时设置） | 覆盖（实际不可变） |
| 权重/政策的校验专用字段（`input_hash`/`version`/`reason`/`idempotency_key` 等） | 不影响结果 | 不需（`policy_id` 入摘要，新版本必改摘要，方向 fail-safe） | — | 显式排除 |
| 残余：资源快照的"下次任意输入变更刷新" | 余量 | — | — | 与 77 §2 措辞一致 |

结论：摘要对"决定归集结果的输入"已完备（快照滞后为显式接受项）；**唯一未覆盖的是 finance 口径开关的触发侧**（已在 §9-P2 记录）。

---

## 7. 门禁回执（评审独立重跑，原始命令）

`packages/database` 文档原命令（4 文件并行）三连跑：

| 次 | 结果 |
| --- | --- |
| 第 1 次 | `Test Files 4 passed (4)` / **Tests 39 passed (39)** / 22.79s |
| 第 2 次 | `Test Files 4 passed (4)` / **Tests 39 passed (39)** / 38.76s |
| 第 3 次（首次） | `Test Files 1 failed \| 3 passed (4)` / `Tests 31 passed \| 8 skipped (39)` —— **环境性失败**：testcontainers `HostPortWaitStrategy.waitForPort` 超时；当时评审同时在 `/tmp` 跑多个容器化探针（自造负载），非产品缺陷 |
| 第 3 次（清理并发后按原命令重跑） | `Test Files 4 passed (4)` / **Tests 39 passed (39)** / 11.78s |

其余套件（真实工作树）：

| 命令 | 结果 |
| --- | --- |
| `packages/database` close 单独 | `Test Files 1 passed (1)` / **11 passed** |
| `packages/database` compute+foundation+invariance+principal-attribution-backfill+migration+subscription-auto-renewal+provider-finance-ledger | `Test Files 7 passed (7)` / **52 passed** |
| `packages/domain` `pnpm run test` | `Test Files 13 passed (13)` / **205 passed** |
| `apps/control-api` `vitest run project-allocation-routes` | `Test Files 1 passed (1)` / **13 passed** |
| 根 `pnpm run typecheck` | 11 包 `Done`，**exit 0** |
| 根 `pnpm run lint` | 11 包 `Done`，**exit 0** |

与 `receipts/r03p1fix/` 的 39/39×3、11、52、205、13、typecheck/lint exit 0 一致，可复现。
未运行：web 单测（回执称 476）、Playwright e2e、根全量、`build`、覆盖率/变异/架构等质量门、容量与百万行性能。

---

## 8. 新发现

### P1（阻断，本轮不修复，仅记录）：`bigint` 运行期为 string，三处裸比较退化为字典序

- **位置**：`project-allocation-read-repository.ts:61`（只读 `stale`）、
  `project-allocation-run-repository.ts:281`（登记短路）、`project-allocation-run-repository.ts:651`（条件清除守卫）。
- **根因**：`pg` 默认把 `int8` 解析为 string；`createKysely`（`kysely.ts:135-139`）与全仓均无
  `setTypeParser`；Kysely 表类型声明为 `number`（`kysely-allocation-tables.ts:95`、`:176`）掩盖了这一点；
  对照：闸门（`freeze.ts:65-72`）与 tick（`scan.ts:92`）分别在应用层 `BigInt` / SQL 数值比较，**正确**。
- **复现**（三份探针原文已引于 §5.2/5.3/5.4）：探针 D（只读误报新鲜）、探针 E（登记被跳过 + tick 选中却 `runsCreated=0` ⇒ 账期卡死）、探针 F（捕获 9 / 脏 10 时标记被清除）。
- **触发条件**：脏代次与捕获代次位数不同的进位段（9→10 最典型；`markAllocationDirty` 每次配置/事实变更 +1，累计到 10 属常规）。
- **为何定性 P1**：(1) 用户决策 2 要求的"闸门与只读同谓词"在运行期不成立（fail-open 呈现 + fail-closed 拒绝并存）；
  (2) 自动恢复链路（tick/API 登记）在同一状态失效，账期无恢复手段 ⇒ 与计划"不得卡死账期"冲突；
  (3) 修订记录的核心不变量（"`dirty=false` 只能由覆盖当前输入的成功执行产生"）被证伪，
  被吞标记若对应装载后提交的输入变更，即把变更前结果冻入 ref（与 R03 P1 同类 fail-open）。
- **未修复**（评审规则）。

### P2（新发现，延续 `73-R02-review.md` §4-④ 的定性）：finance 口径开关无写入方推脏

- **位置**：`provider-finance-cutover-repository.ts:255-297`（`activateStrictWrites`，`INSERT/UPDATE provider_finance_runtime_state` 于 `:276-286`）
  未调用 `markAllocationDirty`；`packages/database/src/cli/provider-finance-activate.ts:25-26` 是唯一生产调用路径（需 `--confirm-enterprise`，一次性不可逆，无 HTTP 端点）。
- **后果**：开关改变逐月行集合（`operating-bill-account-month-lines.ts:11-19` 的 `settled_at`/`created_at` 口径），
  但不推进任何账期脏代次 ⇒ 只读 `stale=false`、闸门放行、close 冻结**开关前**的发布。
- **复现（探针 B 原文）**：

  ```
  R04_PROBE_B {"dirtyUnchanged":true,"dirtyBefore":{"generation":"1","dirty":false},
   "dirtyAfter":{"generation":"1","dirty":false},"staleAfterSwitch":false,"closeStatus":"CLOSED",
   "frozenRunIsPreSwitch":true,"preSwitchLines":1,"digestChangedOnRecompute":true,
   "postSwitchRepublishRunIsNew":true,"postSwitchLines":0,"secondStatus":"SUCCEEDED"}
  ```

  即：开关后无脏标记、只读不报陈旧、close 返回 CLOSED 且冻结开关前批次；被强制重算后（需人为推脏）
  摘要变化、新批次发布、该行移出当月（`postSwitchLines=0`）——证明冻结内容是陈旧口径。
- **为何 P2 而非 P1（并给出升级条件）**：仅 CLI 一次性激活可达、无 HTTP 路径、且属 73-R02 已按 P2 记录的同类
  （当时为"摘要未覆盖 + 无钩子"，本轮已修摘要半边）；若用户认为合同 §5.2"配置类变更同事务推脏"字面适用于该开关，
  则应升级为 P1（修复方向：激活事务内 `markAllocationDirty` 覆盖全部启用账期，或在部署前置条件中写明"必须先激活 finance 再启用归集"）。

### P3（记录，非阻断）

1. `77-R03-P1-fix.md` §1.2/§1.3 引用的 run-repository 行号（`:487-497`、`:608-645`）与 HEAD 不符（实际 `:502-518`、`:625-662`），
   属文档滞后（结论不受影响）。
2. 新幂等索引被 `project_allocation_run_current_uq` 逻辑蕴含（§2 补充观察）；建议合同注明其现状，避免后续误用为防重约束。
3. `77-R03-P1-fix.md` §2 与合同 §3 的"资源快照：不入摘要"措辞不精确——finance 关闭时快照经
   `package_line_cost`（`operating-bill-account-month-lines.ts:108-115`）间接进入 `contentXor`；接受滞后的是**触发侧**。
4. `enableProjectAllocation` 的 upsert 只置 `dirty=true` 不推进代次（`run-repository.ts:218-223`）：
   在"回退启用更早账期"场景下，受影响月份（口径只改原因码，金额中性）可能以 `dirty=true 且 gen == captured` 通过闸门；
   与 `historicalCutoff` 的既有 P3 定性一致。
5. R03 §4-③ 的装载并列顺序（`ORDER BY ... valid_from` / `joined_at` 无 `id` 泄泻）未变；新索引下并列抖动只会多产出一个历史批次行，不再撞键。

---

## 9. 未能验证 / 未运行

- **P1 的"金额错误冻入 ref"最坏路径未做强制交错实证**：探针 F 已确定性证明守卫失效（标记被吞），
  但"标记对应装载后提交的输入变更"需在发布事务写份额行期间注入变更；本报告对该窗口仅做代码推理
  （窗口 = `allocateMonth` + 份额行/余量插入，规模越大越长），未做锁定注入式复现。
- 生产 1M 行规模性能：未验收（本候选明确未验收）。
- 探针 B 的 finance 开关写入未走 CLI 全流程（`activateStrictWrites` 需守恒报告通过），
  采用与其收尾写入同形的 SQL（`:277-289`）；影响面为代码路径推理 + 同形写入实证。
- 资源快照滞后的具体业务算例、web 单测、Playwright e2e、`pnpm run build`、覆盖率/变异/架构/依赖等质量门未运行。

---

## 10. 状态声明

- 评审未修改任何生产/测试代码；仓库内仅新增本文件 `78-R04-review.md`；结束时工作树 `git status --short` 为空（仅本文件未跟踪）。
- 全部探针与降级副本仅存在于 `/tmp/r04`（含 `zz-r04-scratch.integration.test.ts`），不属于仓库交付，可随时删除。
- 发现 P1 后按规则**只记录、不修复**；未 push、未合并、未部署。

**core feature engineering candidate: FAIL**；**1M-row production performance: NOT ACCEPTED**；
**not pushed/merged/deployed**。
