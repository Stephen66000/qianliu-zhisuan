# POOL-039 测试与门禁结果

真实 PostgreSQL Testcontainers 使用 Colima socket；所有命令均在最终生产候选不再变化后执行。

## 定向实库合同

| 检查 | 结果 |
|---|---|
| POOL-039 并发、停用、失败回滚、乐观锁/幂等/隔离/权限 | 4/4 PASS |
| POOL-029 规则与权限回归 | 12/12 PASS |
| 0043 既有数据、up/down/reapply、破坏性 down 阻断 | 1/1 PASS |

并发场景覆盖“已有 manual baseline + 单人 PUT × 批量发布/停用”，无 `40P01`，正常并发无 500；最终规则版本、Grant、Key.allowed_model_ids、pool quota、quota counter、审计一致。注入失败返回预期 500，并断言事务内 Key/baseline/rule/assignment/grant/counter/audit 整体回滚。锁序固定为稳定主体 ACTIVE Key → manual baseline → 稳定 provider pool；乐观锁冲突为明确 409，不静默覆盖。

## POOL-039 正式增量 mutation

| 文件 | mutants | killed | survived | no-coverage | timeout |
|---|---:|---:|---:|---:|---:|
| `dashboard-overages.ts` | 41 | 41 | 0 | 0 | 0 |
| `employee-model-rule-lifecycle.ts` | 160 | 160 | 0 | 0 | 0 |
| `employee-model-rule-lock-context.ts` | 37 | 37 | 0 | 0 | 0 |
| `employee-model-rule-quota.ts` | 11 | 11 | 0 | 0 | 0 |
| `employee-model-rule-repository.ts` | 87 | 87 | 0 | 0 | 0 |
| `principal-access-config-repository.ts` | 130 | 130 | 0 | 0 | 0 |
| `principal-access-locks.ts` | 37 | 37 | 0 | 0 | 0 |
| `principal-access-read-model.ts` | 42 | 42 | 0 | 0 | 0 |
| `principal-single-rule.ts` | 38 | 38 | 0 | 0 | 0 |
| 数据库小计 | 583 | 583 | 0 | 0 | 0 |
| `gateway/real-pipeline.ts` | 3 | 3 | 0 | 0 | 0 |
| **总计** | **586** | **586** | **0** | **0** | **0** |

37 个数据库 mutation 测试与 5 个 Gateway 合同测试通过。没有缩小实际变更范围、降低阈值或登记非等价 mutant。原始 JSON 见同目录两份 `stryker-pool039-*` 报告。

## 全量门禁

- root `quality`：退出 0。typecheck 11/11、lint、build、104 files / 744 tests 全部通过（Web 80、Domain 158、Provider 104、Database 79、Worker 10、Control API 135、Gateway 178）。旧 alias 已按当前 `ql-*` 合同修正，Gateway 49 个失败诊断为 JOIN 把列名当字面量的生产缺陷并以最小修复收敛。
- coverage ratchet：全部 9 个 scope PASS。POOL-029 node 为 95.86/89.40/93.02/95.86，高于 95.73/86.19/92.68/95.73；web 为 100/90.66/97.95/100，高于登记基线。
- source-size：215 production files PASS，默认不超过 400 logical lines；所有职责抽取仍在受检查生产路径，新增语义模块均有测试与 mutation。
- architecture：215 production files、0 cycles PASS；duplication 0.64% < 5% PASS。
- `audit:prod`、license、evidence canary、`git diff --check`：PASS。
- 全量 mutation：退出 0。Domain 726（641 killed、72 survived、13 no-coverage、0 timeout，正式 disposition PASS）；Worker 6（3 killed、0 survived、0 no-coverage、3 timeout，门禁 PASS）；POOL-029 18/18；POOL-039 586/586；Gateway POOL-030 83 killed / 2 已登记 survivor，正式 disposition PASS；Provider POOL-030 6/6。

最终门禁结论：`PASS`；本任务阻断 0，main 基线阻断 0，阻断 Evidence Gap 0。
