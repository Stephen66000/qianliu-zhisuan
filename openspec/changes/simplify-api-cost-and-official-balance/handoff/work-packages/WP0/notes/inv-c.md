# Inv-C 调查笔记：官方余额同步现状（只读）

日期：2026-11-02；基线：origin/main `ae506fed47d21865420afa91137e8b244072933e`。

## 1. 适配器（OAB-01/02 复用对象）

`packages/provider-adapters/src/provider-operating-facts.ts`：
- `queryProviderOperatingBalance`（:42）；**仅 `canonicalProviderCode === "deepseek"` 且 `mode === "API"` 返回数据，否则 null**（:51）——"暂不支持"状态即 null 分支。
- DeepSeek 端点 `https://api.deepseek.com/user/balance`（:30）；解析 `is_available`、`balance_infos[]` 的 total/granted/topped（:76-97）→ `ProviderOperatingBalance { totalBalance, grantedBalance, toppedUpBalance, available }`（:6-11）。
- 适配器版本常量 `pool20-025-v1`（:4）。
- 结论：币种/组成/可用标记已具备；响应校验严格（非布尔/非数组抛错，:76）。

## 2. Worker 同步 runner（OAB-03 改造对象）

`apps/worker/src/provider-operating-sync/runner.ts`：
- 范围：仅 API 模式（:56）、status ∈ ACTIVE/DEGRADED/EXHAUSTED 且 provider ACTIVE（:154-155）。
- **充值记录依赖**：:58-74——仅当 `purchase_created_at > 最近 PROVIDER_SYNC 快照 collected_at` 才纳入同步（充值触发额外查询的机制）。
- **资金模式耦合**：:118-125 `readProviderFinanceMode(env) !== "ACTIVE"` 时整体 skip（`skipped: "FINANCE_MODE_INACTIVE"`，注释：与订阅续订 runner 一致 fail-closed）。
- **耗尽恢复**：:92-107——API+EXHAUSTED 且有快照时调 `recordBalanceSyncRecovery`（DB:src/repositories/resource-pool-repository.ts:252；恢复证据约束＝隔离时间之后的快照，AFR/OAB-12 保留对象）。
- 调度：手动命令 `provider-operating-sync-once`（apps/worker/src/main.ts:98）；runtime-assurance 调度器未见该任务的周期注册（scheduled-tasks.ts 无匹配）——**当前生产实际触发方式待 WP3 核实**（cron/手动/compose）。
- 无冷却、无在途去重、无"下次可刷新时间"概念（OAB-03 均为新增）。

## 3. 快照存储（D2 独立投影基础）

- 表 `provider_resource_operating_snapshot`（DB:migrations/0026_provider_resource_operating_snapshot.js:13）：
  - 唯一索引 `(provider_resource_id, version)`（:76-82）；查询索引 `(enterprise_id, provider_resource_id, collected_at)`（:82-86）。
  - **表层无 (企业,资源,同步日) 唯一约束**；version 由 writer 自增（DB:src/repositories/provider-operating-snapshot-writer.ts:69-74，前值+1）。design 所述"同步日唯一"实际由 runner 的充值触发逻辑＋读取侧 `distinctOn`（supply-forecast-repository.ts:53 等）构成行为约束，非硬约束——WP3 实施时按实际读取路径确认并在迁移中处理尝试记录约束/标识（保留旧尝试）。
- `source` 列区分 `PROVIDER_SYNC` / `PROVIDER_API`(如有) / 手工（MANUAL）——runner :65 只认 `source='PROVIDER_SYNC'` 为官方采集（D2"明确筛选 PROVIDER_SYNC"的依据）。
- 快照字段含 balance/granted/topped/available/balance_updated_at（writer :84）。

## 4. 预测/告警（OAB-07）

`DB:src/repositories/supply-forecast-repository.ts`：读快照（distinctOn 最新）＋活跃订阅周期计算余额预测；现无"来源合格/时效有效"筛选——WP3 增加官方来源与时效判断，过期→不可计算/待更新。

## 5. 手动刷新（OAB-03 新增项）

现状**不存在**任何 HTTP 刷新入口（control-api 无相关路由；worker 仅一次性命令）。WP3 需新增受 `resources.operate` 权限控制的刷新端点＋冷却＋在途复用（参数见 contracts.md 待决清单）。

## 6. 移交 WP3 的核实项

- 生产实际同步触发方式与频率（无法在本环境核实，BLOCKED 记录）。
- DeepSeek 官方限流数值（决定 15 分钟周期建议是否可行）。
- `PROVIDER_API` source 是否实际存在取值（design 提及读取筛选两者）。
