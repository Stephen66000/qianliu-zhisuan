# W17 Evidence：对账任务与 M4 收口

| 项目 | 内容 |
| --- | --- |
| 工作包 | W17（对账任务、重复／丢失检测、异常队列、M4 全链回归） |
| 里程碑 | **M4 收口**（额度／预测／调度／账本，W13～W17 全部完成） |
| Stage | Stage 03 / D2 |
| 日期 | 2026-07-27 |
| pnpm-lock.yaml sha256 | `b8f671cae744c24bd8b0731576ebcf6574e0b9586ee4cc3bc1b25dd532bdf1a2`（W17 无新依赖） |
| 迁移文件 | 新增 `0015_reconciliation.js`（reconciliation_run + reconciliation_discrepancy） |
| 结论 | **PASS** —— W17 DoD 达成（重复 0、丢失检测、汇总比对、异常队列、M4 全链回归） |

## 1. W17 DoD 达成情况

| DoD 项（详细计划行 293） | 结果 | Evidence |
| --- | --- | --- |
| 对账任务 | ✅ | `ReconciliationRepository.runReconciliation` + worker CLI（`worker reconciliation`） |
| 重复检测（重复率=0） | ✅ | DUPLICATE_USAGE 扫描（dedup_key GROUP BY HAVING COUNT>1）；约束层 usage_event.dedup_key UNIQUE 保证 |
| 丢失检测（丢失率<0.1%） | ✅ | MISSING_LEDGER_LINE / ORPHAN_LEDGER_LINE 扫描；阈值 0.001（TRD 行 871） |
| 异常队列 | ✅ | reconciliation_discrepancy（OPEN/INVESTIGATING/RESOLVED/IGNORED 流转） |
| M4 全链回归 | ✅ | gateway 61 集成全绿（w12~w16 路由/计价/额度/预测/调度闭环完整） |
| 重复 0 | ✅ | w17 集成测试：正常账本对账 PASS（duplicateCount=0） |
| 已确认丢失<0.1% | ✅ | evaluateReconciliation：丢失率<0.001 → PASS，≥0.001 → FAIL |

## 2. 关键决策

1. **对账是验证层，约束层保证重复为 0**：`usage_event.dedup_key UNIQUE` + `ledger_transaction UNIQUE(ai_request_id)` 是硬保证；对账扫描复核约束生效，并检测约束覆盖不到的丢失/汇总不一致（TRD 行 352、857）。
2. **纯函数 + 仓储分层**（对齐 W12~W16）：`reconciliation.ts`（evaluateReconciliation 判定 PASS/FAIL/REVIEW + severity 分级）+ `reconciliation-repository.ts`（SQL 扫描 5 类差异 + 落库）。
3. **5 类差异**（DISCREPANCY_TYPE）：
   - DUPLICATE_USAGE（同 dedup_key 多条，约束应阻止，复核）
   - MISSING_LEDGER_LINE（usage_event 缺对应 ledger_line）
   - ORPHAN_LEDGER_LINE（ledger_line 缺对应 usage_event）
   - SETTLEMENT_MISMATCH（ledger_transaction.total ≠ line 聚合）
   - MISSING_USAGE（attempt 有消耗缺 usage_event；当前不扫描，避免误报无消耗失败 attempt）
4. **判定阈值对齐 TRD 行 870-871**：重复率=0、丢失率<0.1%（严格 <，非 ≤）。PASS/FAIL/REVIEW 三态。
5. **异常队列载体**：reconciliation_discrepancy（W17 的"异常队列"）；alert_event（告警）归 W25。
6. **worker CLI**：`worker reconciliation --enterprise <id> [--from --to]`，定时调度（每日）在 W25 scheduler 落地。

## 3. 正式工程命令实测（W17 + M4 Audit，2026-07-27 19:35）

| 命令 | 结果 |
| --- | --- |
| typecheck | ✅ 11 包全 Done |
| lint | ✅ 11 包全 Done（--max-warnings=0） |
| test | ✅ domain **108**（reconciliation 10 + 原 98）、database **8**（w17-reconciliation 4 + 迁移 4）、gateway **61**（w12~w16 全链回归）、control-api 23、provider-adapters 35、其他 |
| build | ✅ 11 包全 Done（worker 有真实代码） |
| evidence:canary | ✅ postgres/redis/logs/traces 全 0 |

## 4. M4 全链回归（W13~W17 闭环）

| 工作包 | 核心 | 集成测试 |
| --- | --- | --- |
| W13 计价 | billing_rule 版本化 + 智谱高峰×3 + decimal 计价 | w13-billing 4 |
| W14 额度 | quota-gate 预占/结算 + 并发租约行锁 | w14-quota-gate 7 |
| W15 预测 | computeForecast 多窗口 + 耗尽/恢复/可信度 | w15-supply-forecast 3 |
| W16 调度 | dispatch_policy + 等价切换 + 限流/拒绝 + 反事实节省 | w16-dispatch 7 |
| W17 对账 | reconciliation 重复0/丢失<0.1% + 异常队列 | w17-reconciliation 4 |

**M4 闭环验证**：gateway 61 集成全绿，确认 计价→额度→预测→调度→对账 全链路账本完整、无回归。

## 5. 交付物清单

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `packages/database/migrations/0015_reconciliation.js` | 新增 | reconciliation_run（对账汇总）+ reconciliation_discrepancy（差异/异常队列） |
| `packages/database/src/kysely.ts` | 修改 | ReconciliationRunTable + ReconciliationDiscrepancyTable 类型 + Database 注册 |
| `packages/database/src/__tests-integration__/migration.integration.test.ts` | 修改 | 回滚指针 0014→0015 |
| `packages/domain/src/reconciliation.ts` | 新增 | evaluateReconciliation（PASS/FAIL/REVIEW）+ DISCREPANCY_TYPE/SEVERITY 枚举 |
| `packages/domain/src/index.ts` | 修改 | 导出 W17 模块 |
| `packages/domain/src/__tests__/reconciliation.test.ts` | 新增 | 10 单测（PASS/FAIL/REVIEW/边界/severity） |
| `packages/database/src/repositories/reconciliation-repository.ts` | 新增 | runReconciliation + scanDiscrepancies（5 类 SQL）+ listOpenDiscrepancies + updateDiscrepancyStatus |
| `packages/database/src/index.ts` | 修改 | 导出 ReconciliationRepository |
| `packages/database/src/__tests-integration__/w17-reconciliation.test.ts` | 新增 | 4 集成（PASS + MISMATCH/REVIEW + 异常队列流转 + run 历史） |
| `apps/worker/src/main.ts` | 重写 | 对账任务 CLI（`worker reconciliation`），替代 W01 占位 |

## 6. 边界确认（W17 不做项）

- 每日定时对账调度（→ W25 worker scheduler）；当前支持手动触发。
- alert_event 告警表（→ W25）；W17 异常队列用 reconciliation_discrepancy 承载。
- 对账自动修正（重复/丢失的自动恢复）→ 人工流转（OPEN→RESOLVED），自动修正归 W25。
- 真实凭证（DEP-PROVIDER-CREDENTIALS 解锁后佳哥跑）。

## 7. M4 收口结论

**M4（额度／预测／调度／账本）全部完成**：W13 计价 + W14 额度 + W15 预测 + W16 调度 + W17 对账。
- 重复结算为 0（约束 + 对账双重保证）；
- 正文 canary 0（METADATA_ONLY 贯穿）；
- 经营闭环可复核（对账 + 异常队列 + dispatch_decision 不可覆盖）。

下一步进入 **M5（完整桌面 Web，W18~W20）**。
