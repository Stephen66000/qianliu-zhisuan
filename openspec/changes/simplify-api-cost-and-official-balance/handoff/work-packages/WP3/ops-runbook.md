# WP3 官方余额同步运维说明（task 3.2 交付）

适用范围：`apps/worker/src/provider-operating-sync`（周期同步）＋ `apps/control-api` 手动刷新端点（task 3.2）。基线：WP3 S3（迁移水位 0096）。

## 1. 触发方式

| 通道 | 入口 | 频率控制 |
|---|---|---|
| 周期同步 | worker `runtime-assurance-scheduler` 的 core 任务 `provider_operating`（`apps/worker/src/main.ts`，advisory lock 单实例） | 调度循环每 `RUNTIME_ASSURANCE_INTERVAL_MS`（默认 30s）tick 一次；每个资源按 P1 周期门禁判定（attempt 表 `next_sync_at > now` 则跳过） |
| 手动一次性 | `worker provider-operating-sync-once` | 同一 tick 逻辑＋同一 P1 门禁 |
| 手动刷新（管理员） | `POST /provider-resources/:id/official-balance/refresh`（control-api，`resources.operate` 权限） | P3 冷却＋0096 在途租约（见 §3） |

调度器健康：`WORKER_HEALTH_PORT`（默认 9191）`/health`。

## 2. 配置（packages/config，均"建议默认值，可配置"）

| env | 读取器 | 默认 | 单位 | 说明 |
|---|---|---|---|---|
| `PROVIDER_OPERATING_SYNC_INTERVAL_MS`（P1） | `readProviderOperatingSyncIntervalMs` | 900000（15 分钟） | 毫秒 | 周期同步节奏＋手动刷新计入节奏；**DeepSeek 官方限流数值未核实，调小前须自行核实厂商配额** |
| `PROVIDER_OPERATING_BALANCE_EXPIRE_MS`（P2） | `readProviderOperatingBalanceExpireMs` | 1800000（30 分钟） | 毫秒 | 官方余额过期阈值（S4 读取/预测侧消费） |
| `PROVIDER_OPERATING_BALANCE_REFRESH_COOLDOWN_MS`（P3） | `readProviderOperatingBalanceRefreshCooldownMs` | 30000（30 秒） | 毫秒 | 手动刷新冷却；**用户未逐项确认，按设计建议默认落地** |

非法值（非正整数）启动期/请求期 fail-fast 抛错。

## 3. 手动刷新端点行为

- 权限：`requireAuth` → 路由根 `provider-resources` 自动映射 `resources` 模块：写操作要求 `resources.operate`（P5 冻结值），只读管理员 `resources.view` 可读余额但 POST 刷新 403。凭证（密文/明文）绝不下发浏览器、不入审计、不入日志。
- 请求体：可选 `{ "idempotency_key": "<uuid>" }`（`.strict()`，非法 → 400）。同键重放复用既有终态，不再触达上游。
- 三态响应（HTTP 200）：`{state: "ACCEPTED"|"IN_PROGRESS"|"COOLDOWN", retry_after_seconds?}`。ACCEPTED 附 `result`：`{outcome: "SUCCEEDED", collected_at, balance{currency,total_balance,granted_balance,topped_up_balance,available}}` 或 `{outcome: "FAILED", error_code}`（失败不覆盖上次成功值；冷却到期后可再次刷新）。
- 错误：404 `not_found`（资源不存在）／422 `official_balance_not_supported`（非 DeepSeek 或非 API 模式，零写入）／409 `credential_missing`（无凭证，零写入）。
- 冷却语义：最近一次 attempt（任意 outcome，手动或周期产生）`started_at` 距 now < P3 → COOLDOWN，`retry_after_seconds` 到下次可刷秒数；冷却内不查上游。
- 在途语义：同资源已有 RUNNING 行（0096 表 `provider_resource_balance_refresh`，RUNNING 部分唯一索引）→ IN_PROGRESS；请求执行插 RUNNING（租约 60s）→ 完成置 SUCCEEDED/FAILED；进程崩溃残留的 RUNNING 在下次 begin 时按 `expires_at` 收敛为 FAILED（`REFRESH_LEASE_EXPIRED`）。
- 审计：`operation_log`，action `provider_resource.official_balance_refresh`，result SUCCESS/FAILURE（仅执行了的刷新留审计；冷却/在途拒绝不留）。
- 手动刷新计入 P1 节奏：attempt `next_sync_at = started_at + P1`，周期调度在该资源下次到点前不重复查询官方。

## 4. 周期同步行为（S2 定稿，S3 仅写入换共享原语）

- 不读 `PROVIDER_FINANCE_MODE`（OAB-03：资金停用仍同步）；静默租约企业整企业跳过（PFA-09）；恢复链（`recordBalanceSyncRecovery`，隔离后 PROVIDER_SYNC＋available＋余额>0 证据）不变。
- 快照/attempt 只追加：失败/不支持只留 attempt（快照保留上次成功值）；0095 放开 `daily_uq` 后同日多次尝试各留一行。
- 纯查询零资金事实写入（provider_finance_*、充值流水零增量）。

## 5. 迁移与回滚注意

- **0095**（drop attempt 表 `daily_uq` 唯一索引）：down 会重建该索引；**生产一旦以 P1 周期运行产生同日多行 attempt，down 将被守卫拒绝**（错误信息含"0095 down"）。回滚前需确认 attempt 表无同键多行（或接受拒绝并人工处理）。
- **0096**（refresh 请求表）：表为瞬时协调状态，非证据；down 直接 drop（可能丢弃仅存的在途标记，不影响任何余额事实）。快照/attempt 表本体（0026/0051 列集）未改动。
- 快照表 0026 的 `(provider_resource_id, version)` 唯一约束保证多版本追加；attempt 表不可变触发器（拒绝 UPDATE/DELETE）不受 0095/0096 影响（refresh 表无不可变触发器，finish/收敛是本表自身的状态推进）。

## 6. 相关表速查

| 表 | 角色 |
|---|---|
| `provider_resource_operating_snapshot` | 官方余额事实（只追加；`source='PROVIDER_SYNC'`＋`balance_source='PROVIDER_API'` 为官方来源） |
| `provider_resource_operating_sync_attempt` | 每次同步尝试留痕（成功/失败/不支持；`next_sync_at` 承载 P1 节奏） |
| `provider_resource_balance_refresh` | 手动刷新请求协调状态（RUNNING/SUCCEEDED/FAILED＋租约） |
| `operation_log` | 管理员手动刷新审计 |
