# 79 · R05 独立复核（窄范围：口径切换推脏钩子 / R04-P1 取整 / 根全量对照回执）

- 复核对象：HEAD `972559b`（前序修复 `d4437ee`），worktree
  `/Users/mac/Projects/仟流智算-project-allocation-feature-20260921`，
  分支 `project-allocation/v12-feature-candidate-20260921`。
- 复核范围：仅用户指定的三项，未扩面、未重审整个模块。
- 独立性与纪律：未修改生产/测试代码；除本报告外无任何仓内写入；所有破坏性实验只在 `/tmp`
  的副本 / 临时 worktree 中做，结束后 `git worktree remove --force` 清理，临时目录已删除
  （仅保留 `/tmp/r05-*.txt|log` 原始日志）。仓库 `git status` 复核时为干净（仅本报告新增）。
- 未做（受约束）：未重跑根全量 `pnpm run test`；未跑任何百万行/容量测试。

## 0. 结论表

| 复核项 | 结论 | 关键证据 |
| --- | --- | --- |
| ① 推脏钩子与标志位翻转**同事务** | **PASS** | `cli/provider-finance-activate.ts:26` → `provider-finance-cutover-repository.ts:259` serializable 事务 → `277-287` 标志位 upsert → `288-295` operation_log → `299-302` 钩子传入同一 `trx`；`markAllocationDirty` 的 `execute(db)` 即该 trx（`project-allocation-common.ts:174-181`）。全仓非测试调用方只有 CLI 一处（grep 命中 5 行：实现 1 + CLI 1 + 测试 3） |
| ② 覆盖 + 批量去重 + 重放 | **PASS** | 查询无月份过滤，取该企业 `project_allocation_period` **全部**行（PK `(enterprise_id, period_month)`，migration `0077:189-196`），不限于激活月；`new Set` 去重后**每账期一次 upsert**；重放在 `267-270` 提前返回、不改口径，无需再标记（后续新启用账期由 enable 路径自身推脏，`run-repository.ts:218-227`） |
| ③ 新回归"移除钩子必失败"（实证） | **PASS** | `/tmp` 副本删钩子 7 行后只跑该文件：`1 failed \| 2 passed`，失败于 `provider-finance-cutover.integration.test.ts:422`；同副本未删钩子为 `3 passed`。原始输出见 §2 |
| ④ R04-P1 三处取整 + 全模块扫描 | **PASS** | `read-repository.ts:62`、`run-repository.ts:282`、`run-repository.ts:653` 均经 `allocationGeneration()`；扫描未发现残留裸比较（§3 表；`freeze.ts:72` 用 `BigInt()`、`scan.ts:92` 是 SQL，均不属"裸 JS 比较"） |
| ⑤ 根全量对照回执与原始证据一致性 | **PASS（附 1 项 P2 证据完整性）** | (a) 12 个红灯文件与 `workspace-fail-lists.txt` 完全一致、`3 fails / 7 passes` 与 `root-full-suite.txt` 一致；(b) 两个 flake 的失败点与"两侧同 flake、与候选无关"结论经我独立复跑 + 机制定位确认，但 `r05-close/` 内无基线侧与重跑原始件；(c) 容量文件排除与原始件基本一致，第二个文件仅有正文陈述。详见 §5 |
| ⑥ 门禁 | **PASS** | cutover 3/3（含新回归）、close 12/12、`typecheck` exit 0、`lint` exit 0（§6） |

新 P0/P1：**无**。新增 P2 见 §7。

## 1. 钩子核查（范围①）

调用链（唯一生产入口）：

1. `packages/database/src/cli/provider-finance-activate.ts:26`
   `new ProviderFinanceCutoverRepository(db).activateStrictWrites(enterpriseId, adminId, month)`；
2. `packages/database/src/repositories/provider-finance-cutover-repository.ts:256-305`
   `activateStrictWrites()` 打开 `this.db.transaction().setIsolationLevel("serializable").execute(async (trx) => {...})`（`:259`），
   先取 advisory xact lock（`:260-261`）、`FOR UPDATE` 读运行态（`:262-265`）；
3. 重放短路：`:267-270`（已启用 + 有 activated_at → 只跑守恒报告，返回 `replayed: true`）；
4. 守恒校验 `:271-275`；
5. 标志位落库 `:277-287`（upsert `provider_finance_runtime_state`）；
6. `operation_log` 写入 `:288-295`；
7. **钩子** `:296-302`：`SELECT to_char(period_month,'YYYY-MM') FROM project_allocation_period WHERE enterprise_id = $1`（`:299-301`）+ `markAllocationDirty(trx, enterpriseId, months)`（`:302`）；
8. `return { ..., replayed: false }`（`:303`）。

同事务判定：钩子调用与 5/6 步骤共用同一个 `trx` 句柄；`markAllocationDirty` 定义在
`project-allocation-common.ts:169-182`，其 `sql\`INSERT ... ON CONFLICT ...\`.execute(db)` 的 `db`
就是传入的 `trx`（类型 `AllocationDb = Kysely | Transaction`，`:11`）。因此标志位翻转、审计行、
全部账期推脏三者**同事务提交/回滚** —— 不存在"标志位已翻转但推脏丢失"的窗口。

覆盖与批量：

- `project_allocation_period` 每行 = 一个已启用账期，PK 为 `(enterprise_id, period_month)`
  （`packages/database/migrations/0077_project_allocation_compute.js:189-196`），
  查询无 `period_month` 过滤，故覆盖该企业**全部已启用账期**（含早于激活月的账期，不限于 `month` 参数所指月份）。
- `markAllocationDirty` 对 `new Set(months)` 逐个 upsert（`common.ts:174`）：**每个不同账期一次**
  `INSERT ... ON CONFLICT DO UPDATE SET generation = generation + 1, dirty = true`（`:175-180`）。
  由于上游查询本身按 PK 唯一，Set 是冗余保险，不改变"一账期一次 upsert"。空集合（无启用账期）时零次写入，无副作用。
- 与"重放不需要再标记"的一致性：重放路径 `:267-270` 在钩子之前返回，此时标志位未变、account_at 口径未变，
  首次激活（同一份代码）已经完成全量推脏；激活之后新启用的账期由 `enableProjectAllocation`
  自身 upsert 脏行（`run-repository.ts:218-227`，generation=1/dirty=true）并登记批次，不依赖本钩子。
  故重放不标记是**语义正确**的（并已由既有用例 `provider-finance-cutover.integration.test.ts:317-325`
  的重放断言覆盖：第二条 `activateStrictWrites` 触发唯一性/守恒报错路径与 `replayed` 分支）。

边界说明（非缺陷，记录）：本钩子只看当前未提交状态；若某企业曾在"无钩子版本"下完成过激活，
再升级到本版本后重放不会补标记。本候选未 push/merge/deploy，该升级路径在候选生命周期内不可达，
不构成 P1；如需给运维留痕，可在重放分支加一行日志/一次性回填说明（建议，非必须）。

## 2. 新回归区分力实证（范围①的"必须失败"验证）

方法：`rsync -a --exclude='.git'` 把 worktree 完整复制到 `/tmp/r05-hook`（副本 `node_modules` 一并复制，
用副本内 `node_modules/.bin/vitest` 直跑，绕开 pnpm 的依赖状态检查），先跑一次**对照**（钩子原样），
再用脚本删除钩子 7 行（`:296-302`：3 行注释 + 查询 3 行 + 调用 1 行；`import` 保留不动），再跑同一文件。
命令（两轮相同）：
`/tmp/r05-hook/node_modules/.bin/vitest run --config ../../vitest.config.ts src/__tests-integration__/provider-finance-cutover.integration.test.ts`

对照（副本、钩子原样）原始输出：

```
 RUN  v3.2.4 /private/tmp/r05-hook/packages/database

 ✓ src/__tests-integration__/provider-finance-cutover.integration.test.ts (3 tests) 9428ms
   ✓ provider finance cutover rehearsal > reports manual blockers and only backfills four allowed usage fields  2989ms
   ✓ provider finance cutover rehearsal > returns GO candidate only when opening, monthly and balance conservation are complete  2441ms
   ✓ provider finance cutover rehearsal > 口径切换同事务推脏已启用账期 → 重算后归集口径更新（R05 收口项）  467ms

 Test Files  1 passed (1)
      Tests  3 passed (3)
```

删除钩子后原始输出（`/tmp/r05-hook-removal-raw.txt` 全文）：

```
 RUN  v3.2.4 /private/tmp/r05-hook/packages/database

 ❯ src/__tests-integration__/provider-finance-cutover.integration.test.ts (3 tests | 1 failed) 9814ms
   ✓ provider finance cutover rehearsal > reports manual blockers and only backfills four allowed usage fields  4950ms
   ✓ provider finance cutover rehearsal > returns GO candidate only when opening, monthly and balance conservation are complete  653ms
   × provider finance cutover rehearsal > 口径切换同事务推脏已启用账期 → 重算后归集口径更新（R05 收口项） 325ms
     → expected false to be true // Object.is equality

⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/__tests-integration__/provider-finance-cutover.integration.test.ts > provider finance cutover rehearsal > 口径切换同事务推脏已启用账期 → 重算后归集口径更新（R05 收口项）
AssertionError: expected false to be true // Object.is equality

- Expected
+ Received

- true
+ false

 ❯ src/__tests-integration__/provider-finance-cutover.integration.test.ts:422:47
    420|         SELECT generation::text, dirty FROM project_allocation_dirty
    421|         WHERE enterprise_id = ${enterpriseId} AND period_month = '2026…
    422|       expect(dirtyAfterSwitch.rows[0]?.dirty).toBe(true);
       |                                               ^
    423|       expect(BigInt(dirtyAfterSwitch.rows[0]!.generation)).toBeGreater…

 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
   Start at  21:49:00
   Duration  12.38s
```

结论：**区分力成立**——钩子被移除后，新回归在第一个钩子依赖断言（`:422` 读取该账期 dirty）
即失败（false≠true）。真实 worktree 未被触碰：`git status --porcelain` 为空，
`provider-finance-cutover-repository.ts` 的 md5 与 `git show HEAD:` 版本一致
（`c0396463c943d4eceda5b08ce8c72add`）。

## 3. R04-P1 取整修复核查 + 全模块扫描（范围②）

三处调用点（逐点核对语义）：

| 位置 | 代码 | 判定 |
| --- | --- | --- |
| `packages/database/src/repositories/project-allocation-read-repository.ts:61-62` | `dirty !== undefined && dirty.dirty === true && allocationGeneration(run.input_dirty_generation) < allocationGeneration(dirty.generation)` | 与结账闸门同谓词（`freeze.ts:72` 是 `dirty===true && BigInt(gen) > BigInt(captured)` 的镜像），取整后两侧同为 bigint，正确 |
| `packages/database/src/repositories/project-allocation-run-repository.ts:281-282` | `current.status === "SUCCEEDED" && allocationGeneration(current.input_dirty_generation) >= allocationGeneration(generation)` | "已消费代次 ≥ 当前代次 → 幂等短路"方向正确；两位数边界不再反转 |
| `packages/database/src/repositories/project-allocation-run-repository.ts:652-653` | `dirty && captured && allocationGeneration(dirty.generation) <= allocationGeneration(captured.input_dirty_generation)` | 条件清脏守卫方向正确；`:662` 的 `where("generation","=",dirty.generation)` 是**等值**谓词（防并发推进），不属排序比较，安全 |

助手本身：`project-allocation-common.ts:163-166`，空值→`0n`，否则 `BigInt(value)`。
运行期前提核实：全仓无 `types.setTypeParser` / `setTypeParser`（grep 全源为空），
故 bigint 列经 `pg` 确实以字符串返回 —— 助手的注释与修复必要性**成立**。

扫描范围与结果（用户指定范围 + 适度外扩）：

| 范围 | 结果 |
| --- | --- |
| `packages/database/src/repositories/project-allocation-*.ts` | 仅 `read-repo:62`、`run-repo:282`、`run-repo:653` 三处比较，全部经助手；`freeze.ts:72` 经 `BigInt()`；`scan.ts:92` 为 SQL 内比较；其余为赋值/select/类型声明 |
| `packages/domain/src/project-allocation/*.ts` | 无 `generation` 出现 |
| allocation 路由（`apps/control-api/src/{operating-bills,principals}/project-allocation-routes.ts`） | 无 `generation`/`input_dirty_generation` 出现（stale 由服务端算好返回） |
| allocation Web（`apps/web/src/api/project-allocation.ts`、`pages/OperatingBillProjectAllocation.tsx`） | 无 `generation` 出现 |
| 全仓 `.ts/.tsx` 正则扫 `generation` 与比较符共现（排除 node_modules/dist） | 命中仅上表三处 + SQL/BigInt；`apps/web/src/components/usage/UsageSubjectPicker.tsx:78-80` 的 `exactRequestGeneration` 是前端请求序号计数器（number 自增比较），与 DB 代次无关 |

**残留裸比较：0 处。**（结论按用户判定标准："未过助手且未过 BigInt 的 JS 比较"为违规。）

close 用例"R04-P1 回归：两位数代次边界不退化"（`project-allocation-close.integration.test.ts:506-537`）
确为守护该修复的用例：构造 `captured=9 / generation=10`（`:521-527` 断言两值），
再断言 `enqueued.created===true`（`:532`）、`currentRun.stale===true`、`close` 抛 `AllocationNotReadyError`。

我**重新做了区分力实证**（不只依赖回执）：在 `/tmp/r05-coerce` 副本把助手临时退化为
`String(value)`（即还原为裸字典序比较），只跑该用例：

对照（未退化，副本）：`✓ ... (12 tests | 11 skipped)` / `Tests 1 passed | 11 skipped`。
退化后原始输出：

```
 ❯ src/__tests-integration__/project-allocation-close.integration.test.ts (12 tests | 1 failed | 11 skipped) 5386ms
   ...
   × P1-a：digest 命中幂等再发布（R02 返修） > R04-P1 回归：两位数代次边界不退化（bigint 经 pg 返回字符串） 181ms
     → expected false to be true // Object.is equality
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯⎯⎯
 FAIL  src/__tests-integration__/project-allocation-close.integration.test.ts > P1-a：digest 命中幂等再发布（R02 返修） > R04-P1 回归：两位数代次边界不退化（bigint 经 pg 返回字符串）
AssertionError: expected false to be true // Object.is equality
 ❯ src/__tests-integration__/project-allocation-close.integration.test.ts:532:30
    532|     expect(enqueued.created).toBe(true);
 Test Files  1 failed (1)
      Tests  1 failed | 11 skipped (12)
```

与 `receipts/r04p1fix/tests-and-discriminating-proof.txt` 记载一致（失败于 `enqueued.created`）：
**该回执可信，且我已独立复验**。

## 4. 根全量对照回执审计（范围③）

### 4.1 逐条对照 `receipts/r05-close/`

(a) **候选红灯文件清单**：回执表格 12 行 = 原始件 `workspace-fail-lists.txt` 的三段文件级 FAIL 完全一致
（packages/database 4：exception-center-contract、pool042-dashboard-resource-usage、standard-home、usage-aggregate-migration-capacity；
apps/control-api 7：pool026-deployment-logs、pool027-provider-model-discovery、pool043-operating-bill-accounts、provider-finance、standard-home-route、w02-auth-principal、w20-resource-insights；
apps/gateway 1：pool043-operating-bill-settlement）。**完全吻合，无多报/漏报。**
`root-full-suite.txt` 的 `Summary: 3 fails, 7 passes` 与回执"3 个 workspace 失败 / 7 个通过"一致。
（证据小瑕疵：原始件末尾记 `ROOT_TEST_EXIT=0`，与 3 个 workspace 失败矛盾，疑为管道/`tee` 捕获所致；
回执的失败结论依据的是 `Summary` 与各 workspace `[ERROR]` 行，不依赖该退出码。）

(b) **两个"额外红灯"的 flake 归因**：原始件只显示这两个文件在**候选**侧是文件级 FAIL
（`FAIL path [ path ]`，无逐用例行 → 与 beforeAll 失败一致），**目录内没有**基线侧清单、
没有 3×2 重跑记录、没有 `/auth/login` 报错原文 —— 回执该段的基线证据**未入库**。我做了独立复跑：

| 侧 | 文件 | run1 | run2 | 失败点 |
| --- | --- | --- | --- | --- |
| 候选 972559b | pool043-operating-bill-accounts | FAIL（文件级，5 skipped） | FAIL（同） | `/auth/login` → 401 → `set-cookie` 缺失 → `pool043...test.ts:38` TypeError |
| 候选 972559b | standard-home-route | PASS（2/2） | FAIL（文件级，2 skipped） | 同上，`standard-home-route.integration.test.ts:50` TypeError |
| 基线 2b33719（新 worktree `/tmp/r05-base`，同参数） | pool043-operating-bill-accounts | PASS（5/5） | PASS（5/5） | — |
| 基线 2b33719（同上） | standard-home-route | PASS（2/2） | FAIL（文件级，2 skipped） | 同上 TypeError |

命令与 root 全量同参：`vitest run --config ../../vitest.config.ts --no-file-parallelism --maxWorkers=1 --maxConcurrency=1 <file>`。
两侧都出现同一失败模式（标准版各自 1/2 翻转）；与随机样本量下"同一 flake"完全相容。
更进一步，我定位了**确定性机制**（在 `/tmp` 副本注入探针，随后删除副本）：

- 登录路由取"**第一条** enterprise"：`apps/control-api/src/auth/routes.ts:37-38`
  （`orderBy("created_at","asc").orderBy("id","asc").limit(1)`），再按该企业查管理员
  （`:52` → `admin-repository.ts:16-27` 按 `enterprise_id` 限定）；查不到即 401（`:53-55`）。
- 两个用例都在**同一条 INSERT** 里种两家企业（`created_at` 相同），管理员只属于 A 企业：
  `pool043-operating-bill-accounts.test.ts:85-93`、`standard-home-route.integration.test.ts:25-33`，
  企业 id 是 `randomUUID()`（`:21` / `:17-18`）。
  当 B 的 uuid 字典序小于 A 时，登录必然 401，beforeAll 抛 TypeError，整文件 FAIL —— 每轮约 50% 的**随机决定**，
  不是时序竞态。
- 探针实证：随机一次 entA<entB → `pickedEnterprise=entA, admin=ACTIVE`，登录 200，文件通过；
  把 `otherEnterpriseId` 固定为字典序更小的 uuid 后 → `pickedEnterprise=00000000-...-0001`，
  `username=pool043-owner` 在该企业查不到（探针里 `admin !== null` 对 `undefined` 也为真，`status=null` 即未命中），
  登录 401，`:38` TypeError，5 skipped。
- 归因：这两个测试文件、整个 `apps/control-api/src/auth/**`、`plugins/auth-guard.ts`、`admins/**`
  相对基线 `2b33719` **零 diff**；候选对 control-api 的改动仅为 `server.ts` 中两个新路由模块的注册
  （前缀 `/operating-bills/**`、`/principals/**`）与归集路由文件本身，不会命中 `POST /auth/login`。R01 期已归档的 `receipts/baseline-red-pool027.txt` 在基线 worktree 上
  记录过**同型** beforeAll 登录 401（pool027 8 skipped）。

**结论：回执 (b) 的实质结论成立（同 flake、登录链路、与候选无关），但其"3×2 交替重跑"证据未入库，
仅我这次独立的 2+2 复跑与机制定位可作补强；回执缺原始件（P2，见 §7）。**

(c) **两个容量/百万行文件被排除**：`workspace-fail-lists.txt` 中
`usage-aggregate-migration-capacity.integration.test.ts` 在候选红灯清单内，回执表格明确标注
"**未对照**（百万行生成，遵守禁跑约束）"，与原始件一致；第二个文件 `w20-standard-capacity`
在候选红灯清单中**不存在**（即候选通过），回执正文说明其 R01 期为红、本次通过、按禁跑约束未对照 ——
这一点只能由 R01 期回执 `receipts/root-test-database.txt:261/406`（该文件 1 failed，102481ms）间接支持，
`r05-close/` 目录内没有它的结果行或排除记录。**与原始件不矛盾，但"排除"本身只有正文陈述。**

(d) 附带发现（非候选问题）：`workspace-fail-lists.txt` 只有候选侧；因此回执表格的"基线同期结果"
整列（10 行"同红"）在 `r05-close/` 内**均无原始件**。可被既有已归档证据部分佐证的行有 5 行
（exception-center-contract / pool042 / standard-home 见 `receipts/baseline-red-database.txt`；
pool043-operating-bill-settlement 见 `baseline-red-gateway.txt`；pool027 见 `baseline-red-pool027.txt`），
其余 5 行（pool026-deployment-logs、provider-finance、w02-auth-principal、w20-resource-insights
及两个 flake 文件的基线侧）本次未能从归档中核到；按范围我未重跑根全量，不做判定。回执结论
"候选红灯集合 ⊆ 基线红灯集合、零候选归因回归"在本轮证据下**未被推翻**，但"基线同期列"应标注为
"复核者现场观察、原始件未归档"。

## 5. 门禁（范围外但按用户允许复跑）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| cutover 集成（含新回归） | `corepack pnpm exec vitest run --config ../../vitest.config.ts src/__tests-integration__/provider-finance-cutover.integration.test.ts`（packages/database） | `Test Files 1 passed (1)` / `Tests 3 passed (3)` |
| close 集成 | 同上，`project-allocation-close.integration.test.ts` | `Test Files 1 passed (1)` / `Tests 12 passed (12)` |
| 类型 | `corepack pnpm run typecheck` | `TYPECHECK_EXIT=0` |
| 静态 | `corepack pnpm run lint` | `LINT_EXIT=0` |

## 6. 新增问题清单

- **P0/P1：无。**
- **P2-1（证据完整性）**：`receipts/r05-close/` 缺少对照的**基线侧**原始件（基线逐文件红灯清单、
  两文件 3×2 重跑日志、`/auth/login` 报错原文）与两个容量文件的"排除记录"。回执表格"基线同期结果"整列
  与 §"两个疑似新增红灯"段落当前**无法仅凭入库件自证**。建议：补存基线日志（或标注"现场观察、件未归档"），
  并把 `workspace-fail-lists.txt` 增加基线段。功能无影响，但影响收口证据链的可复核性。
- **P2-2（文档准确性，无功能影响）**：新回归用例内注释与提交信息同代码不符：
  - 用例注释（`provider-finance-cutover.integration.test.ts` 归集侧注释）写"`settled_at` 为空，
    切换口径后其 `account_at` 变化"，但实际插入 `settled_at = 2026-10-03T09:00:00+08:00`（非空），
    真实机制是"切换到 strict writes 后 `account_at=settled_at`（10 月）→ 该行移出 9 月账期"；
  - 提交信息写 `created_at 2026-09-05`，代码实际为 `2026-09-20T10:00:00+08:00`。
  断言本身自洽（该行确实移出账期、批次 0 行、摘要变化），仅描述需订正。
- **P2-3（基线/测试种子缺陷，非本候选缺陷）**：`/auth/login` 以"第一条 enterprise"解析租户
  （`auth/routes.ts:37-38`），而 `pool043-operating-bill-accounts`、`standard-home-route` 两家企业
  同语句种入且管理员只属随机 uuid 的 A 企业 → 约 50% 概率登录 401、beforeAll TypeError、整文件 FAIL。
  建议在测试种子固定企业 uuid 顺序/只种一家企业，或让登录支持企业限定；不属于本次候选改动，
  但会让根全量长期保持随机红灯。

## 7. 结论

- 收口三项（钩子同事务与覆盖、新回归区分力、R04-P1 取整与扫描）**均通过**，且关键项为**实证**通过：
  删钩子→回归失败；退化助手→边界用例失败；两处实证均在 `/tmp` 副本内完成，真实 worktree 未被改动。
- 根全量对照的**结论**成立（候选红灯集合与原始件一致；两个额外红灯确认与候选无关），
  **证据链**有缺口（基线侧与重跑原始件未入库）——记为 P2-1，不阻断收口。
- 未复核/未验证：基线其余 10 行的"同红"未重跑；未跑根全量；未跑任何百万行/容量测试。

core feature engineering candidate: PASS; 1M-row production performance: NOT ACCEPTED; not pushed/merged/deployed
