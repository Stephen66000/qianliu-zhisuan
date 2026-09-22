# WP06 实施记录 — 候选 C3

日期：2026-09-21。范围：更新失效（补偿扫描）、任务消费、结账冻结、旧账兼容、失败恢复。

## 交付物

1. **结账冻结** `project-allocation-freeze.ts`：close 事务内调用——启用账期（任何 ≤ 目标月的启用记录）要求存在 is_current SUCCEEDED 批次且 `dirty.generation ≤ run.input_dirty_generation`（否则 `AllocationNotReadyError`：no_current_run / stale_input）；通过后写 `operating_bill_project_allocation_ref`（run_id/schema/algorithm/input_digest/result_hash/守恒汇总/完整性/生成时间，不复制逐行明细；RESTRICT 保护被引用 run）。未启用账期 no-op（原结账路径不变，H03）。close 端点映射 409 `allocation_not_ready`。
2. **补偿扫描** `project-allocation-scan.ts`：worker 阶段一变更识别——不接入 Gateway/结算路径（B02 最严格解释）；按企业 `ledger_line.created_at` 水位+10 分钟回看，标记"晚于该月上次标记时间"的新行所在账期（防回看期重复推进代次），推脏→登记（SYSTEM actor）→执行到期批次；水位 per-enterprise upsert（仅 `ledger_line_watermark`，`attribution_watermark` 死列已在 R02 返修移除）。纯配置/回填类变更不产生新 ledger 行，由写入方同事务按账期聚合推脏，tick 再按"已脏且当前批次未消费该代次"补登记。
3. **worker 接线**：`main.ts` aggregate tick 追加 `project_allocation_tick`（失败仅记日志不影响 core；`project_allocation_tick_completed/failed` 事件）。
4. **失败恢复修正**：触发器"状态只进不退"与重试回队冲突——可重试失败保留 RUNNING 并把租约设为退避到期（60s×2^n 上限 1h，由 claim 的租约过期回收路径重新认领），attempt≥3 才转终态 FAILED。

## 测试（receipts/wp06-integration.txt，4/4）

启用无批次 close 拒；执行后 close 写 ref+被引用 run 禁删；重开→规则变更→close 拒（stale_input）；未启用企业 close 无 ref；补偿扫描：新结算→推脏→登记→执行→空闲 tick 零动作。回归：pool043-operating-bill-concurrency 57/57。

## 实施发现（供 R01）

- 测试夹具曾漏 ledger_transaction → 结账屏障判定"有 line 无 tx"拒绝（屏障按合同正确工作）；补齐后通过。
- 补偿扫描按 created_at 水前进是合同语义：回填历史 created_at 的行不触发（测试用当前时间验证真实路径）。
