# R01 独立静态复核报告 — 核心功能工程候选 88d0279

日期：2026-09-21。审核上下文：独立代理（与实施者隔离，只读复核，未修改被审核文件；仅执行只读命令与只读测试）。审核对象：project-allocation/v12-feature-candidate-20260921 @ 88d0279 相对 2b33719 的项目归集功能与证据（104 文件）。

## 1. 总结论

**核心功能工程候选：通过（无 P0 阻断；3 项 P1 修复建议 + 若干非阻断，交回实施者形成新候选后复核）。**

企业边界（复合 FK 全覆盖+哨兵触发器+统一 404）、幂等重放（原修订号）、守恒与精度（BigInt 定点/三级守恒/币种分离/0% 显式段）、结账冻结（close 事务内 no-op/stale/ref RESTRICT）、权限绑定（现有 principals view/operate，零新增实体）、失败恢复（终态不可变+退避租约+SKIP LOCKED 回收）、B02（gateway 零改动，实测 diff 为空）均与冻结合同一致。

审核者独立重验：domain 203/203、归集集成 28/28 全绿。

## 2. A–J 逐项（摘要；全文见审核代理输出）

| 项 | 结论 | 关键证据 |
| --- | --- | --- |
| A 企业边界/A01 | PASS | 0076/0077 复合 FK 全覆盖（profile L26-27、membership L68-70、revision L111-113、policy L171-172、rule L216-219、line L147-153、residual L220-221、ref RESTRICT L242-243）；哨兵触发器 0077 L168-184；根表类型触发器 L76-94 |
| B 幂等 | PASS | replayOutcome 按原修订号（membership-repo L84-112，create L155-161/revise L334-341）；policy 重放原版本（policy-repo L125-133） |
| C 守恒 | PASS | allocation.ts 四值互斥 L99-105、逐行覆盖 L293-307、池/全来源 L381-409、币种分桶；money.ts L43-68；0077 CHECK L143/L155-156；0% 显式段 L250-275+GS-5b |
| D 结账冻结 | PASS | freeze 在 close 事务内（operating-bill-repository.ts:366-374）；no-op L35-38；stale L58-69；409 映射（routes.ts:99-104） |
| E 权限 | PASS | 企业级 GET canAccess(principals,operate)→403（routes.ts:286-288）；admin-permissions 零改动；preview 不含金额 |
| F 失败恢复 | PASS | CHECK 0077:41；终态不可变 L71-75；只进不退 L76-95；退避租约 run-repo L524-550 |
| G 更新机制/B02 | PASS | gateway diff 为空；created_at 水位（scan.ts:47-64）；明细分页固定 run（read-repo L264-294） |
| H 证据 | PASS（小出入） | 回执齐全且经独立重跑；出入：61-FREEZE"当前候选 a97cf1c"应为 88d0279；"71 归集测试"实测口径 28+23+11+2=64 |
| I 候选纯度 | 非阻断问题 | 7 个 diag*.ts 诊断脚本入库（packages/database/diag-{allocation,close,intent,prev,2,3,4}.ts）；其余跨模块改动为正当适配（迁移清单断言/接线/增量列） |
| J 计划符合性 | PASS | 优先级表、匹配时间=started_at、双时间戳、请求去重、§7.2 端点全集、M02/M04/M05 均核验 |

## 3. 问题列表

**P1（3 项，交回实施者修复后形成新候选复核）：**

1. **资源级套餐余量（C08/GS-5 前半）无生产者**：project-allocation-run-repository.ts 全文无 `project_allocation_resource_residual` 写入；仅表+触发器（0077:211-232）与读路径存在。资源整月无 token 行时其套餐费用对归集不可见；40-WP04:11 宣称与事实不符。建议：executeAllocationRun 内按资源聚合写入 residual，或文档显式降级。
2. **date-only 结束核算权重裁剪差一天**：project-accounting-lifecycle-repository.ts:88-94（profile ended_at=输入日+24h）与 :120-130（clipRules 收到未 +24h 的当日零点）边界语义不一致——最后一天请求落入 NO_EFFECTIVE_RULE。与成员退出路径（统一 +1 天，有测试）不一致；date-only 路径无测试覆盖。建议 clip 使用相同转换边界并补用例。
3. **input_digest 仅含行数**：run-repository.ts:403-410（digest=sha256(period, lines.length, …)）；内容不同行数相同的源事实（如 provider-finance-usage-backfill.ts:82-116 原地 UPDATE）digest 碰撞→重算被幂等跳过、dirty 被清、旧值冒充最新。违反计划 §6.5/§8.1.5。建议 digest 纳入逐行内容聚合 hash。

**非阻断（7 项）**：发布缺租约属主校验（唯一约束兜底不腐化）；扫描头注与 attribution 水位列写而不用（已由 R02 返修移除该列并改正头注，见 72-R02-rework.md）；preview 未做类型边界（400 而非 404，无泄露）；30s 冷却未显式实现；diag*.ts ×7 入库；审计 change_summary 缺幂等键/原因/账期；扫描可能为早于 startMonth 的账期建冗余批次。

**信息**：61-FREEZE"当前候选 a97cf1c"笔误应为 88d0279；"24 个归集用例"实测 23；"71 测试"统计口径建议写入 README。

## 4. 门禁回执（receipts/r01/，主上下文实施者跑，审核者独立重跑关键项）

typecheck/lint/web-build exit 0；归集集成 28/28（foundation 19、compute 4、close 4、invariance 1）+ domain 金标 23；迁移阶梯 16 文件全绿；control-api 归集路由 11/11；web 回归 19/19（web 用自身 vitest.config.ts，根 config 的 include 不含 .tsx——执行注意事项已留档）。

## 5. 状态声明

核心功能工程候选**通过**（附 P1 修复建议，交回实施者形成新候选后复核）；**百万行生产规模性能未验收**（已拆分至 performance WIP 分支，见 61-FEATURE-CANDIDATE-FREEZE.md）；本候选**未 push、未合并、未部署**。
