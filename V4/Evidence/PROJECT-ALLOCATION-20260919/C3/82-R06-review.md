# 82 · R06 独立复核（80 终审返修复核）

- 日期：2026-09-22
- 复核对象：`/Users/mac/Projects/仟流智算-project-allocation-feature-20260921`，分支 `project-allocation/v12-feature-candidate-20260921`
- 候选 HEAD：`3ae1cc081e9ea34d9f13fa412ff3a7166dbcdd75`（"80 终审返修——推脏账期范围/批次绑定/区间差集/latestRun"）
- 返修基线：`a1a004b`（被 `80-CODEX-final-review.md` 判 FAIL：3×P1 + 1×P2）
- 复核差异面：`git diff a1a004b..3ae1cc0`（17 文件；全部对应四项修复 + 两份文档 + 回执，未发现范围外生产改动）
- 方法：代码证据 + /tmp 副本回退区分力实证（未改动候选生产/测试代码；副本与 /tmp 日志已清理）+ 门禁独立重跑。未跑 e2e/容量/mutation/覆盖率（沿用既有声明）。

## 0. 结论

**四项返修（P1-1/P1-2/P1-3/P2）全部核实闭合，四组区分力实证全部成立；但发现 2 项新 P2，其中一项使文档强制的 workspace lint 门禁确定性失败（返修自身触碰的文件引入，且 81 号返修记录的 lint 回执与现实不符）。候选未通过全部强制门禁，判定 FAIL（窄因：lint 门禁回归，非四项修复本身缺陷）。**

| 项 | 结论 | 关键证据 | 区分力实证 |
| --- | --- | --- | --- |
| P1-1 推脏账期范围 | **闭合** | `provider-finance-cutover-repository.ts:301-309`：同一 `trx` 内 `run ∪ dirty ∪ period` 的 `DISTINCT period_month`；重放早退于钩子之前（`:267-270`，测试 `provider-finance-cutover.integration.test.ts:321-324` 覆盖 `replayed:true`） | ✅ /tmp 回退钩子至 a1a004b（仅枚举 `project_allocation_period`）→ 扩展回归失败于 `:438`，`dirtyMonths.get("2026-10")` 为 `undefined`（月份完全未推脏） |
| P1-2 批次绑定 | **闭合** | `project-allocation-common.ts:83-109` 解析器（同企业+同账期+SUCCEEDED；同月历史批次允许；其余抛 `AllocationRunNotAccessibleError`）；三处读路径全部经解析器（read-repo `:186`、`:277`、`:334`）；路由把 query `run_id` 同时交汇总与明细（`project-allocation-routes.ts:145-147`）并统一 404（`:106-108`、`:156-158`）；Web `useAllocationLines` 首页固定/翻页携带/键切换解除（`apps/web/src/api/project-allocation.ts:173-191`） | ✅ HTTP 探针（/tmp）：QUEUED/FAILED/跨企业/不存在 uuid 的 `run_id` → 两端点均 404 `not_found`；close 仓储级用例 + routes 用例在 a1a004b 语义下即"混用 200"（返修记录陈述，本轮由 404 行为 + 用例存在性反证）。⚠ 畸形/空 `run_id` → 500（新 P2-1） |
| P1-3 区间差集 | **闭合** | `subtractRuleCuts`（`employee-allocation-policy-repository.ts:237-278`）：cuts 排序合并（含相邻/开放段并集）→ 逐段裁剪，左右剩余严格非空才保留；两处调用（`publishProjectIntent :331-343`；`project-membership-repository.ts:287-299`）其他项目段原样保留，且经 `publishEmployeeRulesInTx → validatePolicyRules`（domain `policy.ts:59-120`：参与覆盖/核算窗口/同项目重叠/跨项目 10000 上限）全量重校验 | ✅ /tmp 回退两文件至 a1a004b：foundation 3/3 新回归失败（旧段被整体删除：`4000@[8/1,9/1)` 等期望段缺失）、close 漂移回归失败（`sources` 退化为 `UNALLOCATED`）且两文件其余 19+13 个既有用例全绿（重叠校验/权重上限/生命周期裁剪未回归） |
| P2 latestRun | **闭合** | `project-allocation-read-repository.ts:65-71、86-91`：仅查 `status IN (QUEUED,RUNNING,FAILED)` 按 `created_at desc`；`currentRun` 仍为 `is_current` 查询（`:53-58`）不被覆盖；stale 谓词未改（`:79-81`，与 freeze 同谓词，freeze 文件零改动）；`lastError` 流入 Web 状态卡（`OperatingBillProjectAllocation.tsx:116-122`） | 状态卡由 routes/web 套件间接覆盖；本轮 59/59 + 476/476 全绿 |

## 1. P1-1 详细核查

- **同事务**：钩子 SQL 与 `markAllocationDirty` 均 `.execute(trx)`，位于 `activateStrictWrites` 的 serializable 事务内（`:259` 起），标志位翻转（`:277-287`）、operation_log（`:288-295`）、推脏（`:301-309`）三者同事务。
- **覆盖范围**：`UNION`（自带去重）覆盖 ① 已有任何批次（含非 current/失败批次）的账期、② 已有脏行的账期、③ 起始登记行账期。继承启用但**无任何归集状态**的月份不被标记——该月份首次计算时口径即新口径，且无 run 则结账本就拒绝（`allocation_not_ready`），无旧口径冻结风险。语义安全。
- **重放**：`strict_writes_enabled && activated_at` 时 `:267-270` 早退（`replayed:true`），不重推；既有用例 `:321-324` 断言重放返回原 `activatedAt`。
- **区分力实证（原始输出）**：/tmp 副本仅将 `provider-finance-cutover-repository.ts` 回退至 a1a004b 版本（该文件在 a1a004b..3ae1cc0 间唯一差异即此钩子，已 diff 确认），运行整个 cutover 测试文件：

```text
$ cd packages/database && vitest run --config ../../vitest.config.ts src/__tests-integration__/provider-finance-cutover.integration.test.ts
 ❯ src/__tests-integration__/provider-finance-cutover.integration.test.ts (3 tests | 1 failed) 12418ms
   ✓ provider finance cutover rehearsal > reports manual blockers and only backfills four allowed usage fields  2192ms
   ✓ provider finance cutover rehearsal > returns GO candidate only when opening, monthly and balance conservation are complete  514ms
   × provider finance cutover rehearsal > 口径切换同事务推脏已启用账期 → 重算后归集口径更新（R05 收口项） 259ms
     → expected undefined to be true // Object.is equality
AssertionError: expected undefined to be true
- Expected: true
+ Received: undefined
 ❯ src/__tests-integration__/provider-finance-cutover.integration.test.ts:438:42
    436|       expect(dirtyMonths.get("2026-09")).toBe(true);
    437|       // 关键断言：继承启用的后续账期同样被推脏（只枚举登记行的旧实现会得到 false/缺行）。
    438|       expect(dirtyMonths.get("2026-10")).toBe(true);
 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
```

失败点恰为新断言（2026-10 无登记行、仅有已发布批次的继承账期），其余 2 用例不受影响。区分力成立。

## 2. P1-2 详细核查

- **解析器语义**（`project-allocation-common.ts:83-109`）：显式 `run_id` 谓词 = `id` + `enterprise_id` + `period_month = 路径月` + `status='SUCCEEDED'`（不要求 `is_current` → 同月历史批次可读）；查无 → `AllocationRunNotAccessibleError`。未指定 → 当月 current SUCCEEDED，无则 `null`（空响应而非报错）。
- **三处读路径同源**：`getUnallocatedSummary:186`、`listAllocationLines:277`、`listUnallocatedLines:334` 全部先经解析器；未分配路由（`project-allocation-routes.ts:145-153`）把同一 `query.run_id` 交给汇总与明细，两者必然同一批次。
- **路由错误映射**：两个端点均把 `AllocationRunNotAccessibleError`（连同 `PrincipalNotAccessibleError`）映射为 404 `{"error":"not_found"}`（`:106-108`、`:156-158`）。
- **Web 固定批次分页**（`apps/web/src/api/project-allocation.ts:173-191`）：`pinnedRun` ref 以 `${month}:${projectId}` 为键；`offset>0` 携带首页 `runId`，`offset===0` 不带并回填 `data.runId`；键变化时固定重置。翻页期间重算不会跨批次跳行/重复。
- **边界探针（/tmp HTTP 实证，真实 HEAD 代码）**：

| `run_id` 输入 | project-unallocated | allocation-lines |
| --- | --- | --- |
| QUEUED 批次 | 404 `not_found` | 404 `not_found` |
| FAILED 批次 | 404 `not_found` | 404 `not_found` |
| 他企业 SUCCEEDED 批次 | 404 `not_found` | 404 `not_found` |
| 不存在的合法 uuid | 404 | 404 |
| `not-a-uuid`（畸形） | **500**（`code:"22P02"`，`invalid input syntax for type uuid`） | **500** |
| 空串（`?run_id=`） | **500**（同上） | **500** |
| 字面量 `null` | **500** | **500** |
| 省略 | 200，汇总/明细同 current | — |

- **残余边界（记录，非缺陷）**：首页 `runId=null`（当月尚无任何成功批次）时翻页不携带 `run_id`，若翻页间恰好首次发布批次则第二页取新 current——但此时首页 `lines=[]、total=0`，UI 无第二页可翻，且首页本无内容可混，语义无害。
- **测试覆盖缺口（记录）**：Web 分页固定逻辑无任何自动化测试（`apps/web` 78 个测试文件无一触及 `useAllocationLines`/该页面）；80 §6 放行条件中的"Web 分页相关测试"实际不存在，本轮仅以代码审读核实。

## 3. P1-3 详细核查

- **`subtractRuleCuts` 边界**（逐项推演 + 由四条回归实证）：
  - 相交/相邻 cuts：先按 `from` 排序、`last.until===null || cut.until===null || cut.from<=last.until` 判交并取最大 `until`（或开放）——形成并集，正确；
  - 开放 cut（`until=null`）：`cutUntil=+∞`，吞噬段尾部，右侧剩余因 `cut.until!==null` 守卫不产生——正确；
  - cut 全包含段：两侧条件均不触发 → 段整体消失——正确；
  - cut 完全在段外：`cutUntil<=pieceFrom || cutFrom>=pieceUntil` → 段原样保留——正确；
  - 多个顺序 cut：`pieces` 逐 cut 收缩——正确；
  - 零长剩余：左剩余要求 `cutFrom>pieceFrom`、右剩余要求 `cutUntil<pieceUntil`，均严格不等 → 不产生零长段——正确。
- **调用点**：`publishProjectIntent`（`:324-343`）对当前项目旧段减**提交区间集合**，其他项目行原样（`:335`）；新 stint 带权重路径（`project-membership-repository.ts:267-299`）减新段区间（默认整个 stint）。两处均以完整集合经 `publishEmployeeRulesInTx → validatePolicyRules` 重校验（重叠段会被 `RULE_OVERLAP_SAME_PROJECT` 拒绝并回滚，权重上限跨合并集合仍 ≤10000 强制）。
- **既有行为未破坏**：/tmp 回退实验中 foundation 其余 19 用例、close 其余 13 用例（含重叠拒绝、权重上限、M04 生命周期 ENDED 裁剪、digest 幂等族）全部通过；HEAD 上 59/59。
- **区分力实证（原始输出）**：/tmp 副本将 `employee-allocation-policy-repository.ts`、`project-membership-repository.ts` 回退至 a1a004b（其余含测试在内全部保持 HEAD）：

```text
$ cd packages/database && vitest run --config ../../vitest.config.ts src/__tests-integration__/project-allocation-foundation.integration.test.ts
 Test Files  1 failed (1)
      Tests  3 failed | 19 passed (22)
（3 个失败全部位于 describe "80 终审 P1-3"，形如：）
AssertionError: expected [ Array(1) ] to deeply equal [ …(2) ]
-   "5000@2026-07-31T16:00:00.000Z-2026-08-30T16:00:00.000Z",   ← 旧段被整体删除（期望保留）
    "8000@2026-09-14T16:00:00.000Z-open",

$ cd packages/database && vitest run --config ../../vitest.config.ts src/__tests-integration__/project-allocation-close.integration.test.ts
 ❯ src/__tests-integration__/project-allocation-close.integration.test.ts (14 tests | 1 failed) 6040ms
   × 80 终审 P1-3：修改未来权重后历史月份重算不漂移 > 8 月 40% → 9 月改 60%：8 月重算仍按 40% 归集，不落未分配 363ms
     → expected 'UNALLOCATED' to be 'MEMBERSHIP_RULE,UNALLOCATED'
 ❯ src/__tests-integration__/project-allocation-close.integration.test.ts:784:36
 Test Files  1 failed (1)
      Tests  1 failed | 13 passed (14)
```

四条回归在旧实现下全部失败、失败形态与终审反例一致（历史段删除 / 历史月份重算漂移为全额未分配）。区分力成立。

## 4. P2（latestRun）核查

- `getAllocationRunStatus` 新增独立查询（`read-repo:65-71`）只取 `QUEUED/RUNNING/FAILED`，`created_at desc` 取最近；`currentRun` 查询与消费谓词未动（`:53-58`、`:79-81`），失败任务不覆盖可用 current；`lastError` 在 `latestRun.lastError` 与 `currentRun.lastError` 两处可见并渲染到状态卡（QUEUED/RUNNING/FAILED 文案，`OperatingBillProjectAllocation.tsx:116-122`），API 类型同步（`AllocationStatusView.latestRun`）。
- stale 判定与结账闸门同谓词（未消费脏代次），`project-allocation-freeze.ts` 在本轮零改动——确认未变。

## 5. 门禁（独立重跑，真实工作树）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| database 7 文件全量 | `packages/database` vitest（foundation+compute+close+invariance+cutover+principal-attribution-backfill+migration，一条命令） | **7 files / 59 tests 全绿**，17.4s |
| 4 文件并行 ×3 | vitest（foundation+compute+close+invariance）连跑三次 | **45/45 ×3**（10.5s/11.2s/10.1s），无 unhandled error |
| domain | `pnpm run test` | **13 files / 205 tests 全绿** |
| control-api | vitest run project-allocation-routes | **1 file / 14 tests 全绿** |
| web | `pnpm run test` | **78 files / 476 tests 全绿** |
| 根 typecheck | `corepack pnpm run typecheck` | **11 包 Done，exit 0** |
| 根 lint | `corepack pnpm run lint` | **FAIL：exit 1**（见 P2-2） |
| 根 build | `corepack pnpm run build` | 11 包 Done，exit 0 |

## 6. 新发现问题

### P2-1（新）：畸形/空 `run_id` 触发 500（PG 22P02），未按 400/404 归一

- 复现（/tmp HEAD 代码，HTTP）：`GET /operating-bills/2026-09/project-unallocated?run_id=not-a-uuid`（或 `?run_id=`、`?run_id=null`）→ `500 {"code":"22P02","message":"invalid input syntax for type uuid: \"not-a-uuid\""}`；allocation-lines 端点同样 500。
- 根因：`project-allocation-routes.ts` 对 `employee_id`/`resource_id` 有 `UUID_RE` 校验（`:126-131` → 400），`run_id` 未做同等校验即传入 `resolveAllocationRunRef`（`where("id","=",runId)` → PG uuid 解析失败）。
- 影响：已认证只读端点的输入校验缺口 + 原始 PG 错误外泄（仅回显调用方自身输入，无跨租户泄露、无数据污染）。与 P1-2 的"结构化 400/404"要求相比为边缘缺口。建议：`run_id` 同样过 `UUID_RE`。

### P2-2（新，**门禁失败**）：返修触碰的 Web 文件使根 lint 确定性失败，且 81 号返修记录的 lint 回执不实

- 复现（真实工作树，确定性）：

```text
$ corepack pnpm run lint
apps/web lint: src/pages/OperatingBillProjectAllocation.tsx
apps/web lint:   59:8  error  Function 'OperatingBillProjectAllocationPage' has a complexity of 32. Maximum allowed is 30  complexity
apps/web lint: ✖ 1 problem (1 error, 0 warnings)
[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @qianliu/web@0.3.0 lint: `eslint src --max-warnings=0`
$ echo $?
1
```

- 归因：a1a004b 版本的同文件单独 eslint 通过（/tmp 实证，exit 0）；3ae1cc0 在该组件内新增 latestRun 状态卡条件渲染（+2 复杂度越过阈值 30）。即**由本轮返修自身引入**。
- 回执矛盾：`81-R06-rework.md §5` 记"根 typecheck / lint / build 11 包 Done，exit 0"（`receipts/r06-final/tests-all.txt` 同）——lint 一项与现树不符，无法在 3ae1cc0 上复现通过（eslint 确定性规则，双环境重跑均失败）。
- 影响：80 §6 放行条件明确要求"一次正常的 workspace test/typecheck/lint/build"；lint 红灯使候选未通过全部强制门禁。修法极小（抽小组件或降分支），但按 R06 纪录不修。

### 记录级（不计级）

- Web 分页固定（`useAllocationLines`）无自动化测试；80 §6 所指"Web 分页相关测试"在 78 个 web 测试文件中不存在，固定正确性仅经代码审读核实。
- `getAllocationRunStatus` 的 `latestRun` 查询按 `created_at desc` 取一，同毫秒并列批次无确定性次级排序（展示语义，无正确性影响）。

## 7. 未验收 / 未执行（沿用既有声明）

- 百万行生产规模性能：**未验收**（本轮未执行容量测试）。
- Playwright e2e、mutation、覆盖率专项：未执行（超出本轮范围）。
- 1M-row 之外的既有蓄水池项（快照滞后等）：未重复报告。

## 8. 复核纪律声明

- 未修改候选任何生产/测试代码；唯一仓库写入为本报告文件。
- 两类 /tmp 实验均在副本（rsync 至 /tmp，无 git worktree 登记）完成，结束后副本与 /tmp 日志已删除；`git status` 于复核结束时干净，HEAD 仍为 3ae1cc0；未创建/遗留任何 git worktree。
- 未 push、未合并、未部署。

## 9. 结论

四项终审问题（P1-1/P1-2/P1-3/P2）修复实现正确、回归具区分力、核心套件与 typecheck/build 全绿；但返修自身引入的 lint 门禁确定性失败（P2-2，含回执不实）使候选仍未满足 80 §6 的完整放行条件，另有 `run_id` 畸形输入 500（P2-1）。两项均为小修，但在独立复核通过前维持不可合并。

core feature engineering candidate: FAIL; 1M-row production performance: NOT ACCEPTED; not pushed/merged/deployed
