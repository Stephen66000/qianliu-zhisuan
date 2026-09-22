# V1.5 代码质量审核返修实施记录

日期：2026-09-22。工作树：`仟流智算-project-allocation-feature-20260921`，分支
`project-allocation/v12-feature-candidate-20260921`。返修前 HEAD `4266549`。
授权：用户对三项 P1 修法范围与放行门禁的确认（"同意"）。

## 1. P1-1：权重意图段真实校验

- **根因**：preview 与 publish 两个端点对 `segments[]` 只做 TypeScript 类型假设，
  `weightBps ?? 0`、`validFrom ?? Date.now()` 把缺失字段静默补成"当前时间 0%"；
  实测 `{"segments":[{}]}` → preview 200（interval.from=当前时间）。
- **修复**：新增 `parseIntentSegments`（`apps/control-api/src/principals/project-allocation-routes.ts`）：
  - `weightBps` 必须为整数且 ≥0（**不设上界**：单段 >10000 走域级 `weight_exceeded`
    结构化冲突——既有合同用例「超配意图返回 weight_exceeded 冲突段」依赖该口径，路由层
    不得越权拦截，见 §4 取舍说明）；
  - `validFrom` 必须为可解析日期；`validUntil` 可空，若给必须可解析且晚于 `validFrom`；
  - 空数组/非对象元素/任一字段不合法 → 整体 400 `invalid_request`，不再有默认值路径。
- **回归**：routes 用例「80-P1-1」7 组负例 ×（preview+publish）= 14 项 400 断言 +
  合法段 200 正例 + `weightBps:10001` → `weight_exceeded` 委托断言。

## 2. P1-2：定向覆盖率补强（只补新增路径，不做全仓治理）

- **Web 三文件**（审查口径 8% 语句/0% 函数）：新增 3 个测试文件 31 条用例
  （`ProjectMembers.test.tsx` 12、`OperatingBillProjectAllocation.test.tsx` 11、
  `api/project-allocation.test.tsx` 8）。覆盖结果（`--coverage.include` 三文件实测）：
  - `api/project-allocation.ts`：**100% 语句 / 100% 函数**，含 `useAllocationLines`
    分页固定批次契约（首页无 run_id、翻页携带、月份切换重置）；
  - `OperatingBillProjectAllocation.tsx`：**100% 语句 / 100% 函数**（分支 77.4%）；
  - `ProjectMembers.tsx`：**100% 语句 / 83.3% 函数**（分支 82.9%），含
    `accountingProfile.version → expectedVersion` 与 null → 0 回退。
- **Database**：lifecycle 仓储（原 70.1%）新增错误路径与 `getProjectAccountingProfile`
  直读用例；读模型（listProjectAllocationSummaries / getUnallocatedSummary /
  listUnallocatedLines）补"无 run 空形态 + 有 run 同源"用例（独立企业夹具）；
  修订幂等重放（同键 revise 重放返回原修订、不新增修订）。
- **Control API**：routes 分支（原 57.44%）由 P1-1 负例组 + P1-2 的
  `AllocationRunNotAccessibleError` 404/400 组覆盖。
- **复核留证**：`receipts/v15/web-coverage`（子代理实测表）、
  `receipts/v15/database-coverage`（本记录附带的定向覆盖率输出）。

## 3. P1-3：体量门禁（quality:size exit 0）

拆分（均为纯搬移 + 导入整理，行为由既有 45+ 用例守护）：

| 原文件 | 原行数 | 拆分后 |
| --- | --- | --- |
| project-allocation-run-repository.ts | 623 | 271（登记/装载）+ **project-allocation-execution.ts** 355（认领/计算/发布事务）+ **project-allocation-publish.ts** 147（份额行/余量/幂等命中/关旧开新） |
| project-membership-repository.ts | 612 | 196（创建/带权重）+ **project-membership-revise.ts** 303（修订/裁剪/共享助手）+ **project-membership-query.ts** 139（列表读模型） |
| employee-allocation-policy-repository.ts | 490 | 341（发布/意图）+ **employee-allocation-policy-preview.ts** 157（预览/总览，只读） |

登记有期限例外（`V3/仟流智算-质量门禁-v1.0.json`，review_due 2026-10-22）：

- `packages/domain/src/project-allocation/allocation.ts` 450：领域纯函数（分类/权重/分配），
  内聚不拆；
- `packages/database/src/index.ts` 440：包桶导出文件，内聚不拆。

其余归因修复：`apps/worker/src/main.ts` 870→855（归集 tick 包装抽到
`apps/worker/src/project-allocation-tick.ts`，console 按既有豁免注记）；
`operating-bill-repository.ts` 406→399（冻结调用与 version 插入参数收行）。

## 4. 取舍说明（R06/后续复核须知）

1. **weightBps 上界**：路由层只挡负数/非整数/缺失；>10000 委托域级
   `weight_exceeded`（既有合同用例断言 totalBps=16001 的和冲突）。
2. **lint 回执方法**：R06 曾发现"管道 grep 退出码冒充 pnpm 退出码"，本轮起一律
   直接执行并记录 `$?`（`receipts/v15/gates.txt`）。
3. **membership 拆分附注**：修订重放的 `affectedMonths` 按原修订重导出（比首次
   发布更窄），断言按稳定字段（membershipId/revision/replay/policyVersion），
   不做深比较——该语义差异记入蓄水池观察项。

## 5. 门禁（真实退出码，`receipts/v15/gates.txt`）

- 根 typecheck / lint / build / quality:size / apps/web test：**全部 exit 0**；
  web 81 文件 507 用例；
- database 相关 7 套件：foundation 23 + compute 8 + close 16 + invariance 1 +
  cutover 3 + backfill 4 + migration 7 = **62/62**；
- control-api routes：**15/15**。

未运行：e2e、mutation、覆盖率全仓阈值、容量/百万行。

## 6. 状态声明

V1.5 三项 P1 已按授权修法实施；待新的独立上下文复核。百万行生产规模性能
**未验收**；未 push、未合并、未部署。
