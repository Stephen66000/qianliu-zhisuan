# 合同修订记录 01 — run 幂等键限定为"当前发布"

- **编号**：76-CONTRACT-AMENDMENT-01
- **日期**：2026-09-22
- **修订原因**：R03 P1（独立评审报告 `75-R03-review.md` §4-①）。原口径下
  no-op 短路用"任意摘要命中的已发布批次"判幂等、代次对齐用"当前批次"，
  当二者不同批次时（人工指定 A→B→A，经公开 API `assignRequestToProject` 可达）
  会把结账闸门迁就到陈旧批次，冻入错误归属（fail-open）。
- **关联报告**：`73-R02-review.md`（R02，P1）、`75-R03-review.md`（R03，P1）、
  实施记录 `74-R02-P1-fix.md`、`77-R03-P1-fix.md`。
- **授权**：用户 2026-09-22 决策"选第二种——放宽幂等索引 + 短路收紧为命中即 current"。

## 修订内容（措辞对照）

| 位置 | 修订前 | 修订后 |
| --- | --- | --- |
| `10-WP01-contract.md` §3 `project_allocation_run` 行 | 活动/当前/已发布幂等三个部分唯一 | 活动/当前/**当前发布幂等**三个部分唯一（已发布幂等索引限定 `is_current`） |
| 同上（陈旧度推导） | 陈旧度不入库，由 `dirty.generation > run.input_dirty_generation` 推导 | 由**未消费的脏代次**推导：`dirty.dirty = true AND dirty.generation > run.input_dirty_generation`；闸门与只读状态同谓词 |
| `10-WP01-contract.md` §5.2 #3 | 同输入+算法幂等 | 同输入+算法幂等**限定当前发布**；同摘要的历史批次不复活，输入回到历史状态时确定性重发布为 current |
| `10-WP01-contract.md` §附 D5 | run 幂等键=(企业,账期,input_digest,algorithm_version) | 同前，**且限定 `is_current`**（不变量：current 批次永远反映当前输入状态） |
| 计划 v1.2 §9 #5 | 同一输入摘要与算法版本重复任务幂等 | 同前，**幂等限定于当前发布**（输入回到历史状态时确定性重发布为 current） |

## 不变量（修订后生效）

> **current 批次永远反映当前输入状态。**

- 输入摘要（`inputDigest`）覆盖全部决定归集结果的输入：行事实、规则、参与、
  **核算窗口**、人工指定、**余量 plan-cash authority**、finance 口径开关、启用起始账期。
- 同输入+同算法的**当前**发布至多一份（部分唯一索引 `... AND is_current`）；
  命中非 current 历史批次 ⇒ 输入回到历史状态 ⇒ 确定性重发布为 current（新行、新份额、
  新余量、关旧 current），不依赖"认出旧状态"。
- 历史批次（SUCCEEDED 行）仍不可复活、不可改写，只允许 `is_current` true→false。
- 陈旧判定＝"未消费的脏代次"；`dirty=false` 只可能由成功执行（发布覆盖或 no-op 证明与
  current 同一输入状态）产生，故 `dirty=false` 一律表示当前输入已反映在当前发布里。

## 影响面

- 迁移 `0077` 的 `project_allocation_run_published_idem_uq` 谓词（候选未合并未部署，
  **选择原地改 0077**：测试库均为临时实例、无既有部署需向前兼容；迁移阶梯用例
  `migration.integration.test.ts` 与 `project-allocation-foundation` 迁移用例改后全绿）。
- `executeAllocationRun`：短路分支收紧为"命中且命中批次即 current"；删除代次对齐 hack
  （R02 §4-② 的并发保留意见随之消失）。
- `project-allocation-freeze.ts`：陈旧谓词改为"未消费"语义；`getAllocationRunStatus.stale`
  同步同谓词（API/页面与闸门一致）。
- 不变：Published run 不可变触发器、`CHECK (NOT is_current OR status='SUCCEEDED')`、
  单活动任务约束、`project_allocation_run_current_uq` 均未改动。
