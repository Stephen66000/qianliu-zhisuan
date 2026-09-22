# V1.5-R2 独立复核报告（84）

- 复核人：独立复核上下文（未参与返修实施）。
- 日期：2026-09-22。
- 对象：worktree `仟流智算-project-allocation-feature-20260921`，分支
  `project-allocation/v12-feature-candidate-20260921`，HEAD `74fe592`（返修基线 `4266549`）。
- 被审材料：`83-V15-rework.md`（按 CLAIMS 逐条验证）与仓库实际代码、测试、门禁。
- 方法：代码逐行比对 + 真实门禁重跑（记录真实退出码）+ 一次性探针测试（运行后即删）
  + /tmp 副本上的两项判别实验。未修改任何生产/测试代码；本文件是本轮唯一仓库写入。

## 0. 结论总表

| 项 | 结论 | 关键证据 |
| --- | --- | --- |
| P1-1 意图段真实校验 | **关闭（成立）** | `parseIntentSegments` 全部负例路径成立；旧默认值代码已删（diff 证实）；80-P1-1 回归 14 项 400 断言 + 探针 20/20 |
| P1-1 设计取舍（>10000 不在路由拦截） | **按设计验证通过（非缺陷）** | 路由注释 `project-allocation-routes.ts:326`；合同用例 totalBps=16001 在 `4266549` 即存在（该版测试文件 line 258）；HEAD 实测 `weightBps:10001` → 400 `weight_exceeded` |
| P1-2 Web 三文件覆盖率 | **成立** | 实测 3 文件语句 100/100/100，函数 100/100/83.33（分支 100/77.41/82.85），与 83 号记录一致；V1.5 基线 8%/0% 无法直接复核（V1.5 报告不在仓内），方向与量级一致 |
| P1-2 lifecycle 仓储覆盖率 | **成立** | 实测 99.39% 语句 / 88.37% 分支 / 100% 函数（未覆盖 line 210），与声称 99.4/88.4 一致；基线 70.1% |
| P1-2 control-api 路由覆盖率 | **改善成立（基数映射不能精确复核）** | principals/project-allocation-routes.ts 实测 83.87 语句 / 66.93 分支 / 100 函数；operating-bills/project-allocation-routes.ts 70.21/71.42/100 |
| P1-3 体量门禁 | **成立（exit 0）** | `node scripts/check-source-size.mjs` exit 0（564 文件）；两例外已登记且有期限政策字段 |
| P1-3 拆分文件与职责 | **成立** | 6 个新文件全部存在、职责单一（见 §4） |
| 发布抽取（publish）行为保持 | **无语义漂移** | 逐行比对 + 机械化 diff：ZERO_TARGET/插入次序/幂等谓词/余量 SQL/同事务推脏全部保持（见 §5） |
| 判别实验 (a)：撤销 P1-1 修法 | **回归确实"咬人"** | 恢复旧默认值代码后 80-P1-1 FAIL：`preview case 0: expected 200 to be 400`（即原始病灶重现），其余 14 例仍过 |
| 判别实验 (b)：恢复拆分前文件 | **门禁咬人、行为不变** | 门禁 FAIL（623 逻辑行未登记例外，exit 1）；foundation+compute+close+invariance 仍 48/48 PASS |
| 门禁（typecheck/lint/build/size/db7/parallel×3/routes/web） | **全部 exit 0** | 见 §6 |

**无新增 P0/P1。** 新增 3 项 P2（均为文档/测试完备性，不影响门禁与行为，见 §8）。

**结语：core feature engineering candidate: PASS; 1M-row production performance: NOT ACCEPTED; not pushed/merged/deployed.**

## 1. P1-1 权重意图段真实校验——关闭（成立）

### 1.1 代码证据（`apps/control-api/src/principals/project-allocation-routes.ts`）

- `parseIntentSegments`（line 318-338）：
  - 空数组/非数组 → null（line 321）；
  - 元素 null/非对象 → null（line 324）；
  - `weightBps` 缺失/非整数/负数 → null（line 327）；
  - `validFrom` 缺失/空串/不可解析 → null（line 328）；
  - `validUntil` 给出但非字符串/不可解析 → null（line 330-331）；`validUntil <= validFrom` → null（line 333）；
  - **无任何"缺字段补 now/0"路径**。
- preview 端点 line 348-351、publish 端点 line 395-397 均经 `parseIntentSegments`，
  失败整体 400 `invalid_request`。
- `git diff 4266549..74fe592` 证实旧默认值代码
  （`weightBps ?? 0`、`validFrom ?? Date.now()`）在两端点中被**删除**，非并存。

### 1.2 回归测试（80-P1-1）

`apps/control-api/src/__tests-integration__/project-allocation-routes.test.ts:394-441`：
7 组负例（空对象、缺 weightBps、非整数 1.5、负数 -1、缺 validFrom、不可解析
"not-a-date"、空数组）×（preview+publish）=14 项 400 断言，另含合法段 200 正例
（不误伤）与 `weightBps:10001` → 400 `weight_exceeded` 委托断言。实测该文件
**15/15 通过（exit 0）**。

### 1.3 一次性探针（运行后已删除，申报）

为覆盖 80-P1-1 未直接断言的路径，本轮在
`apps/control-api/src/__tests-integration__/zz-probe-v15r2-p1-1.integration.test.ts`
写入一次性探针（完整路由 harness + 真实 Postgres），运行后**立即删除**（`git status`
恢复 clean）。探针 20/20 通过（10 负例 × preview/publish 全部 400
`invalid_request`）：

- `validUntil:"not-a-date"`、`validUntil:123`（非字符串）；
- `validUntil == validFrom`、`validUntil < validFrom`；
- `segments` 为字符串/对象（非数组）；
- 元素为 `null`/字符串/数组；
- `weightBps:"4000"`（字符串）。

即：任务书要求的全部拒绝项均有真实 HTTP 层证据，且没有把合法请求误伤（80-P1-1
正例 200 + 既有合同用例全过）。

### 1.4 设计取舍验证（>10000 不在路由层拦截）

- 路由层注释 `project-allocation-routes.ts:326` 明示不放上界、走域级冲突；
- 既有合同用例（sum 冲突 `totalBps=16001`）在 `4266549` 版测试文件 line 258
  即存在，HEAD 保持（HEAD line 253-258、line 431-440 追加 10001 委托断言）。
  该取舍与既有合同一致，**验证通过，不计缺陷**。

## 2. P1-2 定向覆盖率——成立（实测复算）

### 2.1 Web 三文件（81 文件 / 507 用例全跑，coverage.include 限定三文件）

```
File               | % Stmts | % Branch | % Funcs | % Lines
api/project-allocation.ts           | 100 | 100   | 100   | 100
pages/OperatingBill...llocation.tsx | 100 | 77.41 | 100   | 100
pages/ProjectMembers.tsx            | 100 | 82.85 | 83.33 | 100
```
（`/tmp` 存档 coverage-web3.txt；exit 0。）与 83 号记录声称的
100/100/100 语句、函数 100/100/83.3、分支 77.4/82.9 **逐项一致**。
3 个新测试文件确实存在：`apps/web/src/api/project-allocation.test.tsx`（8 用例）、
`apps/web/src/pages/OperatingBillProjectAllocation.test.tsx`、
`apps/web/src/pages/ProjectMembers.test.tsx`。

### 2.2 Database lifecycle 仓储（foundation+close 两套件，39 用例）

```
project-accounting-lifecycle-repository.ts | 99.39 | 88.37 | 100 | 99.39（未覆盖 line 210）
```
（exit 0。）与声称 99.4/88.4 一致；V1.5 基线 70.1%。本轮亦独立复核了
`receipts/v15/database-lifecycle-coverage.txt` 存档值 99.39/88.37/100。

### 2.3 Control-api 路由（routes 测试 15/15 + coverage.include 两路由文件）

```
principals/project-allocation-routes.ts   | 83.87 | 66.93 | 100 | 83.87
operating-bills/project-allocation-routes.ts | 70.21 | 71.42 | 100 | 70.21
```
V1.5 基线 78.75/57.44 与 principals 文件口径对应时：语句 +5.12、分支 +9.49
个百分点，改善方向与量级同 P1-1 负例组 + P1-2 404/400 组的描述一致。
（V1.5 报告不在仓内，基数的精确文件映射无法独立核对——见 §9。）

说明：该测量命令因仓库全局阈值（95%/85%）对 2 文件 include 报 exit 1，属
测量方式副产品；任务书明确本轮不以覆盖率为门禁，测试本身 15/15 exit 0。

## 3. P1-3 体量门禁——成立

- `node scripts/check-source-size.mjs` → `source-size gate passed: 564 files,
  default <= 400 logical lines`，**exit 0**。
- 门禁脚本 `scripts/check-source-size.mjs:10-14` 硬性校验 exception_policy 的
  owner/reason/reviewed_on/review_due/exit 五字段，缺一即抛错——例外不是摆设。
- `V3/仟流智算-质量门禁-v1.0.json`：
  - `exception_policy.reviewed_on "2026-09-22"`、`review_due "2026-10-22"`、
    reason 注明"2026-09-22 登记归集两文件"（line 405-411）；
  - `packages/domain/src/project-allocation/allocation.ts` baseline **450**
    （line 490-492，实测逻辑行恰 450，压线合规）；
  - `packages/database/src/index.ts` baseline **440**（line 494-496，实测恰 440）；
  - `apps/worker/src/main.ts` baseline 860（既有例外，实测 855）。
- `operating-bill-repository.ts` 未登记例外，实测逻辑行 **400**（默认上限内，
  合规）；`apps/worker/src/project-allocation-tick.ts` 16 行。
- 实测逻辑行（按门禁同口径）：run-repository 119、execution 355、publish 192、
  membership 212/revise 286/query 139、policy 341/preview 163。

## 4. 拆分文件与职责——成立

| 文件 | 逻辑行 | 职责（读文件头与导出核实） |
| --- | --- | --- |
| `packages/database/src/repositories/project-allocation-run-repository.ts` | 119 | 启用登记/批次登记（enableProjectAllocation、enqueueAllocationRun），并 re-export 执行域符号 |
| `packages/database/src/repositories/project-allocation-execution.ts` | 355 | 源行/上下文装载、认领（SKIP LOCKED+租约）、计算、发布事务、失败退避、worker 入口 |
| `packages/database/src/repositories/project-allocation-publish.ts` | 192 | 份额行写入、资源余量、幂等命中判定、关旧开新 |
| `packages/database/src/repositories/project-membership-repository.ts` | 212 | 成员创建/带权重 |
| `packages/database/src/repositories/project-membership-revise.ts` | 286 | OCC 修订/裁剪/共享助手 |
| `packages/database/src/repositories/project-membership-query.ts` | 139 | 列表读模型（at/区间过滤、人数口径、分页） |
| `packages/database/src/repositories/employee-allocation-policy-repository.ts` | 341 | 发布/意图 |
| `packages/database/src/repositories/employee-allocation-policy-preview.ts` | 163 | 预览/总览（只读） |
| `apps/worker/src/project-allocation-tick.ts` | 16 | tick 包装（结构化日志，main.ts line 15 接线核实） |

## 5. 对抗性比对：publish 抽取是否保真——无语义漂移

以 `git show 4266549:packages/database/src/repositories/project-allocation-run-repository.ts`
（711 行）为基线，与新 `project-allocation-publish.ts` / `project-allocation-execution.ts`
逐行比对，并对可机械化部分做归一化 diff：

1. **ZERO_TARGET 保真**：`publish.ts:10` 定义、`:32` 用于
   `target_project_principal_id ?? ZERO_TARGET`，与拆分前 line 344/364 一致。
2. **lineInsertValues 字段级一致**：36 个字段逐一相同（`?? ""`/`?? null`/
   `?? 0n`/`?? "UNKNOWN"`/`?? "API"` 兜底全保留）；仅 `run` 参数类型收窄为
   `{ id; enterprise_id }`（结构兼容，无行为差异）。
3. **插入次序一致**：份额行循环 → 余量 SQL → 余量插入 → 关旧 current
   （含 `previous.id !== run.id` 守卫）→ SUCCEEDED+is_current 更新，与拆分前
   line 522-625 完全同序。
4. **幂等命中谓词一致**：input_digest + algorithm_version + status='SUCCEEDED'
   + `is_current = true`（publish.ts:86-94 = 拆分前 511-519）；no-op 分支只写
   status/finished_at/duration/updated_at，不夺 current、不写份额（publish.ts:201-214
   = 拆分前 626-639）。
5. **余量 SQL 逐字一致**：plan_cash_authority / snapshot_authority / authority
   FULL OUTER JOIN / line_allocated 按 ledger_line_id DISTINCT ON 去重 / 双正差
   WHERE，与拆分前 531-576 逐字符相同；note 的 financeEnabled 分支保留。
6. **推脏消费仍在同一事务**：`execution.ts:337-367` 在同一 `db.transaction()`
   内先 `publishOrNoopRun` 再做代次比较 + 条件清 dirty（= 拆分前 643-664 同事务，
   注释一致）；非无条件清除。
7. **失败路径一致**：attempt>=3 → FAILED，否则退避 lease（execution.ts:369-396
   = 拆分前 667-696）。
8. 机械 diff 结果：loadAllocationSourceLines / loadAllocationContexts /
   claimNextAllocationRun / contentXor / enableProjectAllocation /
   enqueueAllocationRun / monthDate 全部 **IDENTICAL**（diff 输出仅为本脚本
   抽取窗口切到相邻函数的多余行）。

结论：拆分为**纯搬移**，未发现任何语义漂移（无丢失 ZERO_TARGET、无改变插入
次序、无改变推脏口径）。

## 6. 门禁重跑（真实退出码）

| 命令 | 结果 | exit |
| --- | --- | --- |
| `corepack pnpm run typecheck` | 通过 | **0** |
| `corepack pnpm run lint` | 通过 | **0** |
| `corepack pnpm run build` | 通过 | **0** |
| `node scripts/check-source-size.mjs` | 564 files passed | **0** |
| packages/database 七套件一次连跑（foundation 23 + compute 8 + close 16 + invariance 1 + cutover 3 + principal-attribution-backfill 4 + migration 7） | **62/62** | **0** |
| 并行门第 1 次（foundation+compute+close+invariance） | 48/48 | **0** |
| 并行门第 2 次 | 48/48 | **0** |
| 并行门第 3 次 | 48/48 | **0** |
| apps/control-api routes 测试 | 15/15 | **0** |
| apps/web `pnpm run test` | **81 文件 / 507 用例** | **0** |

未运行（按授权豁免）：e2e、mutation、全仓覆盖率阈值、百万行/容量测试。

## 7. 判别实验（证明修复"有意义"）

在 `/tmp/v15-review/wt`（worktree 的 APFS 克隆副本）上实验；原始输出存档
`/tmp`（随本轮清理删除，数字转录于此）。

### (a) 撤销 P1-1 修法 → 新回归必须 FAIL

在副本内对 routes 文件反向应用 `git diff 4266549..74fe592`（即恢复
`weightBps ?? 0` / `validFrom ?? Date.now()` 旧默认值，line 334/384 出现），
删除副本 dist 后跑 routes 测试：

```
FAIL ... > 80-P1-1：意图段真实校验——空对象/缺字段/超范围一律 400，不再静默补默认值
  → preview case 0: expected 200 to be 400 // Object.is equality
Test Files  1 failed (1)
Tests  1 failed | 14 passed (15)
```

即：旧代码下 `{"segments":[{}]}` 重返 200（原始病灶），80-P1-1 精确咬合；
其余 14 例不受影响，证明失败专属性。

### (b) 恢复拆分前 run-repository → 门禁 FAIL 且套件仍 PASS

副本内 `git checkout 4266549 -- .../project-allocation-run-repository.ts`
（711 行）并删除 execution/publish 两文件（全仓无其他引用方，先经 grep 证实）：

```
$ node scripts/check-source-size.mjs
packages/database/src/repositories/project-allocation-run-repository.ts: 623 logical lines，未登记例外
exit=1
```

```
foundation+compute+close+invariance: Test Files 4 passed (4), Tests 48 passed (48), exit=0
```

同时证实：623 逻辑行（83 号记录"原行数 623"）属实；拆分前后行为由既有用例
守护的声明成立。

## 8. 新发现问题（无 P0/P1；3 项 P2）

- **P2-1（文档）**：`83-V15-rework.md` §3 拆分表多处数字与实测不符：
  run-repository 声称 271（实测 119 逻辑行）、publish 声称 147（实测 192）、
  membership 声称 196/303（实测 212/286）、policy-preview 声称 157（实测 163）、
  operating-bill 声称 399（实测 400）。执行域 355、membership-query 139、
  policy 341、worker 855 与原 623 属实。门禁结论不受影响，但回执数字失真，
  建议更正记录。
- **P2-2（证据）**：83 号记录 §2 声称留证 `receipts/v15/web-coverage`（子代理
  实测表），该目录/文件**不存在**（receipts/v15 下仅 gates.txt 与
  database-lifecycle-coverage.txt）。本轮已独立复测并证实 Web 数字，但留证
  缺口应补齐或更正记录。
- **P2-3（测试完备性，轻微）**：80-P1-1 的 badBodies 未含 validUntil 专项负例
  （不可解析/非字符串/`<=validFrom`）与非数组/非对象结构负例。这些路径在
  `parseIntentSegments`（line 321/324/330-333）存在且经本轮探针 20/20 证实，
  但若未来这些具体分支回归，已提交的回归测试不报警。建议并入 badBodies。

## 9. 无法独立复核的事项

- V1.5 审查报告本身不在仓内（在复核方手中），故基线数字（Web 8%/0%、
  lifecycle 70.1%、routes 78.75/57.44）无法从原始出处核对；本轮核实的是
  **当前**实测值与返修声称值的一致性，以及与基线差距的方向/量级合理性。
- 判别实验在 /tmp 副本进行（副本与原 worktree 共享 gitdir 的细节见 §10），
  实验读取的均为副本内文件（行数/内容在运行前后均已验证），结论有效。

## 10. 复核过程事故申报（已完全修复，仓库零残留）

在 /tmp 克隆副本中执行 `git checkout 4266549 -- <path>` 时，因副本的 `.git`
文件与原 worktree 指向**同一 per-worktree gitdir**（共享 index），误改写了
原 worktree 的 index 中该文件条目（原 worktree 工作区文件本身未动、
HEAD 未动、其余文件未动）。发现后立即：切断副本 .git 链接 →
`git restore --source=HEAD --staged --worktree -- <该文件>` → 复验
`git status` 全清、文件为 139 行拆分版（含对 execution 的 re-export 块）、
两拆分文件在位、size 门禁重跑 exit 0、HEAD 仍为 74fe592。本轮净仓库变更
**仅本报告文件**。该事故不涉及任何生产/测试代码变更。

## 11. 状态声明

V1.5 三项 P1 返修经独立复核**全部成立**；判别实验证明回归与门禁均真实有效；
发布抽取无语义漂移。未发现 P0/P1。

**core feature engineering candidate: PASS; 1M-row production performance: NOT ACCEPTED; not pushed/merged/deployed.**
