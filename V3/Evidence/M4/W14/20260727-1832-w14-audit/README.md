# W14 Evidence：额度、并发与超额

| 项目 | 内容 |
| --- | --- |
| 工作包 | W14（主体／资源额度、Redis 并发租约、预占、释放、耗尽停止、允许超额） |
| 里程碑 | M4（额度／预测／调度／账本，W13～W17） |
| Stage | Stage 03 / D2 |
| 日期 | 2026-07-27 |
| pnpm-lock.yaml sha256 | 无外部新依赖 |
| 迁移文件 | 新增 `0012_concurrency_lease.js`（并发租约表） |
| 结论 | **PASS** —— W14 DoD 达成（耗尽停止、allow_overage 超额、并发不穿透、恢复回收） |

## 1. W14 DoD 达成情况

| DoD 项（详细计划行 290） | 结果 | Evidence |
| --- | --- | --- |
| 主体／资源额度 | ✅ | `quota-gate.ts` 判定 + `quota-gate-repository.ts` 预占/结算（principal_grant + quota_counter，0004 schema） |
| 并发租约 | ✅ | `concurrency_lease` 表 + 行锁获取/释放（并发不穿透硬保证） |
| 预占、释放 | ✅ | reserveQuota（行锁预占 estimated）/ settleQuota（按实际校正多退少补）/ releaseQuota |
| 耗尽停止 | ✅ | WT-06：REJECT_EXHAUSTED，预占不生效 |
| 允许超额 | ✅ | WT-06：allow_overage → ALLOW_OVERAGE + overage_value 超额记录 |
| 并发不穿透 | ✅ | 达 concurrency_limit 拒绝新租约，activeConcurrency 不超限 |
| 恢复任务 | ✅ | reclaimExpiredLeases 回收崩溃残留（幂等） |
| WT-06 | ✅ | `w14-quota-gate.test.ts` 7 集成 |

## 2. 关键决策

1. **额度按 deducted_quota 扣减**（W13 倍率后），不是 raw——quota-gate 输入 estimatedCost 由调用方按倍率预估，结算按实际 deducted_quota 校正。
2. **并发不穿透用 PostgreSQL 行锁**（W14 离线可测）。TRD §5.4 行 269 允许 Redis 短期计数，但「Redis 指标丢失不得伪造高可信分数」——Redis 缓存层作为性能优化在 W25 叠加，正确性以 PG 为准。
3. **quotaRepo 作为 real-pipeline 可选依赖**：门禁判定逻辑+仓储在 W14 落地并独立测试；pipeline 步骤 3b 前的插入点在 W16 经营调度时一并接入（避免 W14 破坏 W08~W13 现有集成形状）。
4. **关键修正**：初版集成测试用 randomUUID 作 concurrency_lease.ai_request_id 触发外键违规；改为先建真实 ai_request（租约本就应挂真实请求）。

## 3. 正式工程命令实测（W14 Audit，2026-07-27 18:32 于佳哥 Mac 执行）

| 命令 | 结果 |
| --- | --- |
| typecheck | ✅ 11 包全 Done |
| lint | ✅ 11 包全 Done（--max-warnings=0） |
| test | ✅ domain **58**（quota-gate 11 + billing 14 + routing 10 + lifecycle 19 + 原 4）、provider-adapters 35、gateway **51**（**w14-quota-gate 7** + w05~w13 回归 44）、control-api 23、database 4、config 4、contracts 2、observability 4 |
| build | ✅ 11 包全 Done |
| evidence:canary | ✅ postgres/redis/logs/traces 全 0 |

## 4. 边界确认（W14 不做项）

- pipeline 热路径的额度门禁插入：W16 经营调度时一并接入（当前 quotaRepo 独立验证）。
- Redis 短期计数缓存：W25（正确性以 PG 行锁为准）。
- 周期重置执行器：W25 worker（reset_marker 幂等字段已在 0004）。
- 供给预测：W15；经营调度策略：W16。

## 5. 残余风险与后续

- **预估值准确性**：额度预占用 estimatedCost（预估 deducted_quota）；真实消耗与预估偏差由 settleQuota 校正。预估函数（按模型/历史）在 W15 供给预测时校准。
- **多实例并发**：PG 行锁在单 PG 下正确；多 gateway 实例共享同一 PG 时行锁仍有效（PG 是事实源）。Redis 分布式租约在 W25 评估。

## 6. 为 W15/W16 预留的集成点

- **W15**：activeConcurrency → capacity_headroom；quota_counter.used_value → 消耗速度。
- **W16**：evaluateQuotaGate 的 REJECT/ALLOW_OVERAGE 是 dispatch_policy 允许动作（ALLOW/RATE_LIMIT/REJECT/ALLOW_OVERAGE）的执行点；quota_repo.reserveQuota 在 pipeline 步骤 3b 前插入。
