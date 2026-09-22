# 80 终审返修实施记录 — 3 项 P1 + 1 项 P2

日期：2026-09-22。工作树：`仟流智算-project-allocation-feature-20260921`，分支
`project-allocation/v12-feature-candidate-20260921`。返修前 HEAD `a1a004b`（被
`80-CODEX-final-review.md` 判 FAIL）。授权：用户对四项修法与放行门禁的确认（"同意"）。

## 1. P1-1：口径切换推脏漏掉"继承启用"的后续账期

- **根因**：启用模型是"起始月登记一次、后续月按 `period_month<=目标月` 继承"
  （`project-allocation-run-repository.ts:203-210` 只插一行；read-repository:38、freeze:37 按继承判断），
  而钩子只枚举 `project_allocation_period` 实际行——起始月之后已发布的账期不会被推脏，
  结账闸门（只看未消费的脏代次）放行旧口径结果。
- **修复**：`provider-finance-cutover-repository.ts:296-311` 改为按**实际存在归集状态的账期**枚举：
  `project_allocation_run` ∪ `project_allocation_dirty` ∪ `project_allocation_period` 的
  `DISTINCT period_month`（UNION 去重），仍在同一事务内，天然有界。
- **回归**：`provider-finance-cutover.integration.test.ts`「口径切换…」用例扩展——起始月 2026-09
  之外，再为 2026-10（无登记行、仅继承启用）登记并发布一个批次，切换后断言 **两个月都 dirty=true**
  （旧实现只推 2026-09，2026-10 断言失败，具区分力）。

## 2. P1-2：指定 run_id 不绑定企业账期；汇总/明细可混用两个批次

- **修复**：
  - 新增统一解析器 `resolveAllocationRunRef` + `AllocationRunNotAccessibleError`
    （`project-allocation-common.ts:69-100`）：显式 `run_id` 必须是**同企业、同路径账期、SUCCEEDED**
    的批次（允许读取同月历史批次），否则抛错；未指定时取当月 current。
  - `listAllocationLines`、`listUnallocatedLines`、`getUnallocatedSummary`（新增可选 `runId` 参数）
    全部改为复用该解析器（`project-allocation-read-repository.ts`）——汇总与明细必然同源。
  - 路由：`operating-bills/project-allocation-routes.ts` 把 `AllocationRunNotAccessibleError`
    映射为统一 404 `not_found`；未分配端点把 `query.run_id` 同时交给汇总与明细。
  - Web：`useAllocationLines`（`apps/web/src/api/project-allocation.ts:170-191`）分页固定批次——
    首页取得 `runId` 后，后续页显式携带 `run_id`，翻页期间重算不会跨批次跳行/重复；
    月份/项目切换时查询键变化、固定解除。
- **回归**：close 用例「80 终审 P1-2」（仓储级：跨账期 run_id 抛错、同月历史批次汇总/明细同 runId、
  未指定取 current）+ routes 用例「80-P1-2」（HTTP 级：跨账期 `?run_id=` 两个端点均 404；
  同月历史批次 200 且 `runId === detail.runId`）。旧实现下这两个用例分别得到"混用 200"与
  "rejects 未抛"，具区分力。

## 3. P1-3：项目意图/新 stint 带权重会删除同项目历史规则段

- **根因**：`publishProjectIntent` 与"新增 stint 带权重"路径都用
  `project_principal_id <> 当前项目` 保留其他项目、**整体丢弃**当前项目旧段；重算只加载 current
  policy，历史月份因规则消失漂移为 `NO_EFFECTIVE_RULE`/未分配。
- **修复**：新增半开区间差集 `subtractRuleCuts`
  （`employee-allocation-policy-repository.ts:217-282`：cuts 排序合并→逐段裁剪，保留不相交部分、
  裁剪相交边缘、丢弃空段）。两处调用：
  - `publishProjectIntent`（`:324-345`）：其他项目原样保留；当前项目旧段减去**提交区间集合**；
  - 新 stint 带权重（`project-membership-repository.ts:268-302`）：当前项目旧段减去新段区间
    （默认整个新 stint 参与区间）。
  再经 `publishEmployeeRulesInTx` 的全量校验（membership 覆盖/核算窗口/重叠/权重上限）发布。
- **回归**（foundation 三组 + close 一组）：
  1. 开放旧段中途改权重：8 月 40% → 9 月改 60% ⇒ 规则为 `4000@[8/1,9/1)` + `6000@[9/1,∞)`；
  2. 有限区间局部覆盖：9 月起 30% → 提交 `[9/10,9/20)` 70% ⇒ 三段 `30%|70%|30%`；
  3. 退出再加入的新 stint 带权重：旧 stint 段裁剪到新 stint 之前 + 新段 80%；
  4. **历史重算不漂移**（close）：10 月 40% 发布并计算（MEMBERSHIP_RULE@4000）→ 11 月改 60%
     （tick 自动重算 10 月）⇒ 10 月行仍为 MEMBERSHIP_RULE@4000、份额不变（修复前漂移为全额未分配）。
  注：三组用例各自新建项目主体，避免共享 `projectP` 已被生命周期用例设置核算窗口导致段落在窗外被拒。

## 4. P2：状态接口看不到 QUEUED/RUNNING/FAILED

- **修复**：`getAllocationRunStatus` 新增 `latestRun`
  （`project-allocation-read-repository.ts:76-95`：该账期最近一个 `status IN (QUEUED,RUNNING,FAILED)`
  的批次，含 `createdAt/lastError`）。`currentRun` 语义不变（仍为可读的当前成功结果），
  失败任务不覆盖可用结果。Web 状态卡显示"已登记批次，等待执行/批次计算中/批次失败：原因"
  （`OperatingBillProjectAllocation.tsx`），API 类型同步（`AllocationStatusView.latestRun`）。

## 5. 门禁回执（`receipts/r06-final/`）

| 套件 | 结果 |
| --- | --- |
| 根 typecheck / lint / build | 11 包 Done，exit 0 |
| foundation 22 + compute 8 + close 14 + invariance 1 + cutover 3 + backfill 4 + migration 7 | 59/59 |
| domain 205 / control-api routes 14 / web 476 | 全绿 |
| 文档原命令 4 文件并行 ×3 | **45/45 ×3**，无 unhandled error |

未运行：e2e（Playwright）、容量/百万行（按既有口径）。

## 6. 状态声明

80 终审的 3 项 P1 与 1 项 P2 已按授权修法实施；待新的独立上下文（R06）复核。
百万行生产规模性能**未验收**；未 push、未合并、未部署。

## 7. 建议 R06 必检

1. P1-1：钩子枚举集合是否覆盖"继承启用 + 已发布 + 已脏"三类账期；扩展回归在旧实现上的区分力；
2. P1-2：解析器谓词（同企业/同账期/SUCCEEDED）与三处调用一致；路由 404 映射；Web 分页固定的
   正确性（首页固定、翻页携带、键切换解除）；
3. P1-3：`subtractRuleCuts` 的边界（相邻/包含/开放段/多点裁剪）与两组调用路径；四条回归的区分力
   （可按惯例在 /tmp 副本回退 `a1a004b` 版本验证）；
4. P2：`latestRun` 只读非成功批次、不覆盖 current；
5. 三连跑与各套件回执可复现；无范围外改动（diff 面与记录一致）。
