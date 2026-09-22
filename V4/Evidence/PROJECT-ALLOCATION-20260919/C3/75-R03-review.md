# R03 独立评审报告 — 候选 19f4c64（R02 P1 修复后的复核）

日期：2026-09-22。评审上下文：独立（未参与实现，未参与 R02）。
工作树：`仟流智算-project-allocation-feature-20260921`，分支
`project-allocation/v12-feature-candidate-20260921`。
被评审 HEAD：`19f4c64`（"输入摘要纳入核算窗口/口径/截断，收紧脏代次条件清除（R02 P1）"）；
上一候选：`e1c9f89`（R02 判 FAIL）→ `2a9185c`（第三方审核 FAIL）→ 计划基线 `2b33719`。
评审范围：`git diff e1c9f89..19f4c64`（5 文件：run 仓储 +51/−29、close 用例 +104、2 份回执、1 份返修记录）。
被评审方主张文件：`74-R02-P1-fix.md`（按 CLAIMS 处理，逐条实证）。
合同依据：`10-WP01-contract.md`；R02 复审依据 `73-R02-review.md`。

评审未修改任何生产/测试代码；仓库内**仅新增本文件** `75-R03-review.md`；
实证脚本与降级副本仅创建于 `/tmp`（见 §2/§4），结束时不改动真实工作树。

---

## 0. 结论摘要

| # | 检查项 | 判定 | 关键证据 |
| - | --- | --- | --- |
| A | **R02 P1（核算窗口未进摘要）是否闭合** | **部分闭合 → 未闭合（新 P1）** | 核算窗口确已进摘要（`run-repository.ts:179-184,464`），但 no-op 命中"非 current 的历史批次"时仍 fail-open（§4-①，实证） |
| B | 摘要完备性（决定结果的输入是否全在摘要内） | **部分（1×P2）** | `allocateMonth` 全部领域输入已覆盖；**余量表口径**（`provider_finance_event`/`provider_resource_operating_snapshot`）不在摘要内（§4-② P2） |
| C | 新回归"R02-P1"是否真实区分 | **PASS** | 在 `/tmp` 副本把 run 仓储回退到 `e1c9f89` 后，该用例 **FAIL**（`expected 'MEMBERSHIP_RULE' to be 'UNALLOCATED'`，用例 `:464`；§2 原始输出） |
| D | 条件清除/代次对齐是否 fail-closed | **部分否定** | 并发标记方向确已 fail-closed（`WHERE generation=` 一致守卫，`:646-661`）；但**对齐所依据的"已发布批次"取错**，可主动把代次降到陈旧批次捕获值（§3、§4-①） |
| E | 6 项授权返修未被破坏 | **PASS** | 逐项 file:line 见 §5 |
| F | 门禁 | **PASS** | 4 文件并行 ×3 = **37/37 ×3**；backfill+migration 11；domain 205；routes 13；typecheck/lint exit 0（§6） |

**核心发现（阻断）**：R02 §4-① 的"核算窗口不在摘要内"确已修复（`accountingDigest` 已并入 `inputDigest`，
financeEnabled/earliest 一并计入），**但本轮的 P1 并未闭合**——no-op 短路用"任意摘要命中的已发布批次"
（`existing`，无限定 `is_current`，`:489-496`）判定幂等，而代次对齐依据却取"当前 `is_current` 批次"
（`:639-654`）。当二者不是同一批次时（A→B→A 的输入回退，经公开 API `assignRequestToProject` 可达），
对齐会把脏代次**主动降到陈旧 current 批次**捕获的代次并清 dirty，使结账**冻结陈旧归集**并放行。
已在本工作树**外**（`/tmp` 降级副本，工作树未改）实证：`current` 批次仍指向项目 B、而当前输入已回到项目 A，
`closeMonth` 返回 **CLOSED** 且 ref 冻结的正是那个指向 B 的陈旧批次。定性 **P1**。

按评审规则**未修复**，仅记录。

**总判定：核心功能工程候选 FAIL**（因 §4-① P1）。百万行生产规模性能：**未验收**。未 push / 未 merge / 未部署。

---

## 1. R02 §4-① 修复的核对（accountingDigest 等）— 属实

被评审方主张"核算窗口进摘要 + financeEnabled + earliest"：

- `loadAllocationContexts` 新增 `accountingDigest`（`packages/database/src/repositories/project-allocation-run-repository.ts:179-184`），
  装载面为 `project_accounting_profile_version` 当前行（`:125-130`），摘要式
  `sha256(JSON([[project_principal_id, started_at, ended_at], …]))`，与 `ruleDigest/membershipDigest` 同构。
- `inputDigest` 现为 `sha256(JSON([period_month, lines.length, factXor, ruleDigest, membershipDigest,
  accountingDigest, manualDigest, finance:on|off, earliest|no-enablement]))`（`:460-467`）。
- `financeEnabled`（`:433-436`）与 `earliest`（`:437-441`）确已计入，覆盖 `account_at` 口径与 `historicalCutoff`。

结论：R02 §4-① 所指的**具体**摘要缺口（核算窗口）已按建议修复，且与 `74-R02-P1-fix.md` §2.1 描述一致。
但该修复的**原则**（"摘要命中 ⇔ 当前输入与已发布结果一致"）仍有反例，见 §4-①。

---

## 2. 检查项 2：新回归是否真实区分（实证）

按指令在 `/tmp/r03` 副本复现（`cp -R` 工作树 → `git show e1c9f89:<file>` 覆盖副本中的 run 仓储 → 单独跑 close 用例）。
工作树未改动。命令与原始输出（副本内直接以 node 调 vitest，规避 corepack 在副本中的 deps 自检）：

```
cd /tmp/r03/packages/database
node /tmp/r03/node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts \
  src/__tests-integration__/project-allocation-close.integration.test.ts --reporter=basic
```

原始结果（回退到 `e1c9f89` 的 run 仓储后，HEAD 的用例文件）：

```
❯ src/__tests-integration__/project-allocation-close.integration.test.ts (9 tests | 1 failed) 7525ms
   ✓ 结账冻结（H02/H04） …（3 条）
   ✓ 补偿扫描 tick（A03 阶段一） …（2 条）
   ✓ P1-2：date-only 结束核算统一排他边界 …
   ✓ P1-a：digest 命中幂等再发布（R02 返修） > 启用→SUCCEEDED→代次前进但摘要未变…   ← 旧代码也过
   × P1-a：digest 命中幂等再发布（R02 返修） > R02-P1 回归：核算窗口变化必须真实重算…
     → expected 'MEMBERSHIP_RULE' to be 'UNALLOCATED' // Object.is equality
       ❯ …close.integration.test.ts:464:36
   ✓ P1-b：人工指定同事务推脏（方案 A） …
 Test Files  1 failed (1)      Tests  1 failed | 8 passed (9)
```

判定 **PASS**：新增的 `R02-P1 回归`（`close.integration.test.ts:402-481`）在修复前代码上**真实失败**
（失败点 `:464`，与实现者 `74-R02-P1-fix.md` §3 的预期一致），是有效护栏，非改写断言凑绿。
附带观察：被**重写**的 P1-a 用例（`:338-400`，改为"摘要未变的代次推进"方向）在旧代码上同样通过，
即它只护栏 no-op 语义，不构成对本次修复的区分性证据（区分力来自 R02-P1 用例）。

---

## 3. 检查项 3：条件清除/代次对齐的并发安全性

代码（`run-repository.ts`）：

- 读取：`dirty.generation`（`:620-624`）、本批次 `captured.input_dirty_generation`（`:625-628`）；
  仅当 `dirty.generation <= captured` 才进入消费块（`:629`）。
- 对齐（仅幂等命中 `existing !== undefined` 时，`:634-654`）：取**当前 `is_current`** 批次的
  `input_dirty_generation`（`:639-644`），若 `dirty.generation > publishedCaptured` 则
  `UPDATE … SET generation = publishedCaptured WHERE generation = <读取值>`（`:646-652`）。
- 清 dirty：`UPDATE … SET dirty=false WHERE generation = clearGeneration`（`:656-661`）。

**并发方向：fail-closed，判定 PASS（局部）**。对齐更新与清 dirty 都用 `WHERE generation = <值>` 条件写入，
且 `clearGeneration` 在命中对齐时等于 `publishedCaptured`、未命中时等于读取值，二者语义一致：
若并发 `markAllocationDirty` 在读取之后提交（代次 G→G+1），两条条件更新都会 miss ⇒ 保留 `dirty=true`
且 `generation=G+1` ⇒ 闸门（`project-allocation-freeze.ts:66` `generation > captured → stale_input`）继续拒绝，
而 tick 的 `pendingDirty`（`project-allocation-scan.ts:85-93` 要求 `d.dirty AND generation > current.captured`）
仍能自动重新登记 ⇒ **不会卡死账期**。原 R02 §4-② 的"吞并发标记"已按此收紧，属实。

**但"对齐到什么代次"这一决策是 fail-open 的**：对齐依据是**当前批次**的捕获值，而幂等命中依据是
**任意批次**（见 §4-①），二者可指向不同批次。此时对齐不是"按事实放行"，而是"把闸门迁就到陈旧批次"。
这属于逻辑缺陷而非并发缺陷，故本项**部分否定**。

---

## 4. 新增发现

### ① P1（阻断，本轮仍未闭合）：no-op 命中"非 current 批次"时，代次对齐把闸门迁就到陈旧结果

**根因**：两处读取对象不一致，且都无条件信任"摘要命中"。

- 幂等命中：`existing` 查询**不带 `is_current`**（`run-repository.ts:489-496`）——
  只要求 `(enterprise, period_month, input_digest, algorithm_version, status='SUCCEEDED')`。
  即"历史上**任何**发布过同摘要的批次"。
- 代次对齐：`published` 查询取 `is_current=true`（`:639-644`），并对齐到**该批次**的 `input_dirty_generation`。
- no-op 分支**不改 `is_current`**（`:603-617` 只改 status/finished_at/duration_ms/updated_at）。

因此当"摘要命中的批次 ≠ 当前批次"时：no-op 不重发布、current 仍是**另一个（陈旧）摘要**的批次，
但清 dirty/对齐按 current 批次做，于是闸门 `generation > current.captured` 被抹平 →
**close 冻结陈旧结果并放行**。`74-R02-P1-fix.md` §2.3 的断言"摘要命中 ⇔ 当前输入与已发布结果一致"
在此反例下不成立；正确条件应是 `published.input_digest === inputDigest`（即 current 批次也命中该摘要），
或命中后把 `is_current` 归还给摘要命中的批次。

**可达路径（仅用公开 API，无需新权限）**：`assignRequestToProject` 是 `(enterprise, ai_request)` 唯一键上的
upsert（`operating-bill-repository.ts:282-289`），故"指定 A → 指定 B → 再指回 A"会让 `manualDigest`
（`:448-452`，对该企业全部 assignment 行做有序 `string_agg` 的 `md5`）**精确回到** A 态的取值；
三个动作各自同事务 `markAllocationDirty`（`operating-bill-attribution.ts:72-75`）。于是：

1. 指定到项目 A → 批次 RA 发布（摘要 DA，current）。
2. 指定到项目 B → 批次 RB 发布（摘要 DB，current；RA 置 `is_current=false`）。
3. 指回项目 A → 新批次 R3（捕获代次 g3）执行时 `inputDigest == DA` 命中 **RA（非 current）** ⇒ no-op；
   current 仍是 RB（摘要 DB，陈旧）。
4. 对齐：`dirty.generation=g3 > RB.captured=g2` ⇒ 把 `generation` 降到 `g2`、`dirty=false`。
5. `closeMonth`：`generation(g2) > current.captured(g2)` 为假 ⇒ 放行，ref 冻结 **RB**。

**实证（`/tmp` 降级副本，工作树未改）**：临时用例（未入库，见文末声明）输出：

```
R03_ADV {"runADigest":"b81f8e55…(A)","runBDigest":"ea9a61a4…(B)","runBCaptured":"4",
         "results":[{"status":"SUCCEEDED"}],          ← 第 3 次执行 no-op 成功
         "currentRunId":"fbecb50e…",
         "currentDigest":"ea9a61a4…(B)",               ← current 是 B
         "assignmentProject":"cc2131cb…(A)",           ← 当前输入是 A
         "currentLineTargets":{"target":"b7d04d93…(B)","sources":"MANUAL_ASSIGNMENT"},
         "dirty":{"generation":"4","dirty":false}}     ← 代次被降到 RB 捕获值并清脏
R03_CLOSE {"closedStatus":"CLOSED","frozenRunId":"fbecb50e…","currentRunId":"fbecb50e…"}
```

即：**当前输入指向 A，但 current 批次仍归集到 B；close 返回 CLOSED，ref 冻结的正是这个指向 B 的陈旧批次。**
断言 `assignment==A`、`currentTarget==B`、`close==CLOSED`、`frozen==RB` 全部成立（用例通过）。

**影响**：`operating_bill_project_allocation_ref` 冻入错误金额归属（B 而非 A），与 R02 §4-① 同类、
无任何告警；结账前的读取端点（`project-allocation-read-repository.ts:41-46` 按 `is_current` 取）
也会在界面呈现陈旧归集。方向为 fail-open。

**与 R02 的关系**：真实代码路径在 `e1c9f89` 已存在（对齐逻辑为 R02 返修引入），R02 §3-a 只分析了
"并发吞标记"，未覆盖"命中批次≠current 批次"。本轮的摘要修复**没有**触及该逻辑，故 R02 的 P1 未闭合。

**建议修复方向（评审不实施）**：no-op 分支改为"仅当 `is_current` 批次的 `input_digest === inputDigest`
才允许对齐/清脏；否则要么把 `is_current` 切回摘要命中的批次（等同重发布），要么保持 dirty=true 让闸门拒绝"。
或直接以 `existing.is_current` 为对齐依据，并在命中非 current 批次时把 current 指针切过去。

### ② P2：余量表口径（finance 事件/资源快照）不在 `inputDigest` 内，no-op 会使余量陈旧

`executeAllocationRun` 的发布输出除份额行外还包含 `project_allocation_resource_residual`，
其 authority 来自 `provider_finance_event`（当月 CODING_PLAN 现金）与
`provider_resource_operating_snapshot`（`run-repository.ts:508-553`）。**这些输入未被任何 digest 覆盖**
（`inputDigest` 仅由行事实/规则/参与/核算窗口/人工指定/口径/截断构成，`:460-467`），
而余量行**只在未命中分支写入**（`:554-564`；no-op 分支不写）。因此：某资源 authority 变化但源行事实不变时
（例：非 finance 口径下，行 `package_line_cost` 走快照、而余量 authority 优先取现金事件，见
`operating-bill-account-month-lines.ts:100-116` 与 `run-repository.ts:528-533`），一次因其它原因触发的
no-op 不会刷新余量；`getUnallocatedSummary`（`read-repository.ts:179-210`）会读到旧余量。
定性 **P2**：不进入 close ref（`project-allocation-freeze.ts` 冻结字段仅 run_id/schema/algo/digest/result_hash/
守恒/完整性），故不冻结金额；且 plan 现金事件本身不推脏（无写入方钩子），该陈旧在 no-op 之前即已存在。
建议：把余量 authority 的 `(provider_resource_id, Σcash)` 与快照摘要并入 `inputDigest`，或为 finance 事件补推脏钩子。

### ③ P3：次要一致性（记录，非阻断）

- `ruleDigest`（`:171-174`）与 `membershipDigest`（`:175-178`）**均未含 `employee_principal_id`**。
  经核对 0076 触发器（`migrations/0076_project_allocation_relations.js:205-268` 规则仅 INSERT、
  `:132-158` 成员修订仅允许 ACTIVE→SUPERSEDED/VOID 的状态迁移），该列在正常写路径下不可变更，故**不可达**。
- 装载顺序存在并列不确定：规则 `ORDER BY ru.employee_principal_id, ru.valid_from`（`:109-115`）、
  成员 `ORDER BY r.joined_at`（`:116-124`）。并列时摘要可能抖动，方向为"多算一次"（fail-closed 侧），
  但会造成幂等命中率下降/结果按 target 顺序产生分币差异；建议补 `id` 泄泻位。
- no-op 批次 `conservation/result_hash/input_digest` 为 NULL 而 `status='SUCCEEDED'`（R02 §4-⑤ 已记，属实）。

---

## 5. 检查项 4：6 项授权返修，未被本轮破坏（PASS）

| 授权项 | 证据（HEAD） |
| --- | --- |
| 1. digest-HIT no-op 不写 `input_digest`/不夺 current | `run-repository.ts:603-617` 仅 set `status/finished_at/duration_ms/updated_at`；用例 `close.integration.test.ts:379-386` 断言两个 SUCCEEDED 中仅 1 个带摘要、仅 1 个 current |
| 2. 退避符号 `+` | `run-repository.ts:686` `lease_expires_at: new Date(Date.now() + backoffMs)`；认领条件 `:320` `lease_expires_at < now()` |
| 3. 三条写入路径同事务、按批推脏 | 人工指定 `operating-bill-project-attribution.ts:72-75`（经 `operating-bill-repository.ts:290` 传 `trx`）；归属回填 `principal-attribution-backfill.ts:176-179`（显式 `trx`，整批一次）；finance 原地回填 `provider-finance-usage-backfill.ts:167-172`（`trx`，先取实际变更请求集） |
| 4. `HISTORICAL_UNKNOWN` 需无参与证据 | `packages/domain/src/project-allocation/allocation.ts:234` `if (!hasMembership && historicalCutoff !== null && …)` |
| 5. tick 用 DB 时钟 | `project-allocation-scan.ts:35` `SELECT now() AS now` |
| 6. 顺手项 | 余量按 `ledger_line_id` 去重 `run-repository.ts:534-547`；tick 自登记 `scan.ts:85-93`；项目口径 `read-repository.ts:290`；404 主体解析 `apps/control-api/src/operating-bills/project-allocation-routes.ts:95-101,133-136`；未分配明细 `read-repository.ts:309+`；Web 版本 `apps/web/src/pages/ProjectMembers.tsx:342`；`packages/database/diag-*.ts` 不存在；全仓 `grep attribution_watermark` 无代码命中 |

---

## 6. 检查项 5：门禁（评审独立重跑，原始命令）

| 命令 | 结果 |
| --- | --- |
| `packages/database` 4 文件并行（foundation+compute+close+invariance）**第 1 次** | PASS 4 files / **37 passed** / 39.48s |
| 同上 **第 2 次** | PASS 4 files / **37 passed** / 46.33s |
| 同上 **第 3 次** | PASS 4 files / **37 passed** / 30.92s |
| `packages/database` principal-attribution-backfill + migration | PASS 2 files / **11 passed** |
| `packages/domain` `pnpm run test` | PASS 13 files / **205 passed** |
| `apps/control-api` project-allocation-routes | PASS 1 file / **13 passed** |
| 根 `pnpm run typecheck` | **exit 0**（11 个 Done） |
| 根 `pnpm run lint` | **exit 0**（`--max-warnings=0`） |

三次并行均无 unhandled error；与 `74-R02-P1-fix.md` §4 的 37/37 回执一致，可复现。
（`basic` reporter 有 Vitest 弃用告警，不影响结果。）

未运行：Playwright e2e、web 单测、根全量测试、`pnpm run build`、容量/百万行性能（明确不要求/未验收）。

---

## 7. 未能验证

- **生产 1M 行规模性能**：未验收（本候选明确未验收）。
- §4-① 的并发窗口：`/tmp` 复现为单线程确定性路径；未在并发压测下验证（但该缺陷是逻辑性的，与并发无关）。
- §4-② 余量陈旧：为代码路径推理，未逐场景实证（不影响主判定）。
- web `expectedVersion` 修复仅代码/类型核对，未跑 web 单测或浏览器实测。

---

## 8. 状态声明

- 评审未修改任何生产/测试代码；仓库内仅新增本文件 `75-R03-review.md`；结束时真实工作树 `git status` 干净。
- `/tmp/r03` 降级副本（含回退实验与临时用例 `zz-r03-scratch.integration.test.ts`）不属于仓库交付，可随时删除。
- 发现 P1 后按规则**只记录、不修复**；未 push、未合并、未部署。

**core feature engineering candidate: FAIL**（因 §4-① P1）；**1M-row production performance: NOT ACCEPTED**；
**not pushed/merged/deployed**。
