# W11 Evidence：凭证生命周期与账号池状态机

| 项目 | 内容 |
| --- | --- |
| 工作包 | W11（API Key／OAuth／套餐会话状态机、刷新退避、单资源隔离、冷却、半开恢复） |
| 里程碑 | M3（三厂商、凭证与账号池，W09～W12） |
| Stage | Stage 03 / D2 |
| 日期 | 2026-07-27 |
| pnpm-lock.yaml sha256 | 见下（新增 `@qianliu/database → @qianliu/domain` workspace 依赖，无外部新依赖） |
| 迁移文件 | 新增 `0010_resource_credential_lifecycle.js`（provider_resource 生命周期字段 + resource_status_event 审计表） |
| 结论 | **PASS** —— W11 DoD 达成（状态机离线契约通过；真实凭证刷新仅阻塞上线签字） |

## 1. W11 DoD 达成情况

| DoD 项（详细计划行 287） | 结果 | Evidence |
| --- | --- | --- |
| API Key／OAuth／套餐会话状态机 | ✅ | `packages/domain/src/resource-lifecycle.ts`（确定性纯函数状态机） |
| 刷新退避 | ✅ | `computeCooldownMs` 指数退避（30s 基准 ×2^n，30min 封顶，无随机抖动可回放）+ 单测 |
| 单资源隔离 | ✅ | WT-07/WT-19 集成：401/刷新失败仅隔离对应资源，同池/对照池不受影响 |
| 冷却、半开恢复 | ✅ | `evaluateAdmission`（冷却中拒绝、到期半开探测）+ `deriveSuccessTransition`（半开成功→DEGRADED，一次成功不抹趋势） |
| WT-07/19 | ✅ | `apps/gateway/src/__tests-integration__/w11-resource-pool.test.ts`（6 集成测试） |
| 故障注入 | ✅ | 429 冷却退避、临时故障达阈值熔断、客户端错误不计数、凭证到期隔离 |
| 真实凭证仅阻塞上线签字 | ✅ | DEP-PROVIDER-CREDENTIALS 未解锁；状态机经注入错误分类驱动验证 |

## 2. 本工作包交付物

### 2.1 迁移 0010（`packages/database/migrations/0010_resource_credential_lifecycle.js`）
- `provider_resource` 新增：`resource_pool_id`（同池分组，WT-07）、`credential_expires_at`、`credential_refresh_status`(OK/REFRESHING/FAILED)、`last_refresh_at`、`refresh_error_classification`、`consecutive_failures`、`cooldown_until`、`last_probe_at`。
- 新表 `resource_status_event`：状态迁移审计（from/to/reason/actor/冷却/分类，不可覆盖），TRD §14 行 853 隔离/恢复留痕。

### 2.2 状态机（`packages/domain/src/resource-lifecycle.ts`）
确定性纯函数，时钟注入可回放。处置矩阵（TRD §9）：
- `UPSTREAM_CREDENTIAL_INVALID`(401/403) → **CREDENTIAL_INVALID** 隔离，仅人工恢复
- `UPSTREAM_BILLING_BLOCKED`(402) → **EXHAUSTED** 隔离，仅人工恢复
- `UPSTREAM_RATE_LIMITED`(429) → **UNAVAILABLE** + 指数退避冷却
- `UPSTREAM_TEMPORARY`/`TRANSPORT_ERROR`/`UNKNOWN` → 计数；达阈值 3 → **UNAVAILABLE** 熔断
- 客户端/能力/下游/账本错误 → 不计入资源健康
- 成功 → 清零；UNAVAILABLE 半开成功 → DEGRADED（TRD §9 行 598：一次成功不抹掉长期趋势）
- 凭证到期 → **EXPIRED**；刷新失败 → **CREDENTIAL_INVALID**（WT-19）
- `adminRecover`：仅隔离态可恢复 → DEGRADED（受控，需探测确认后才回 ACTIVE）
- 版本化参数 `RESOURCE_POOL_POLICY`（failureThreshold=3、退避基准/封顶，version `w11-v1`），调整需 Planning Change

### 2.3 仓储（`packages/database/src/repositories/resource-pool-repository.ts`）
`ResourcePoolRepository`：`recordFailure`/`recordSuccess`/`recordRefreshFailure`/`checkCredentialExpiry`/`adminRecover`（行锁 + 状态更新 + 审计事件同事务）；`listServableResources`（硬过滤：ACTIVE/DEGRADED 可服务、冷却到期半开、终态隔离排除，供 W12 评分）；`listStatusEvents`（审计轨迹）。

### 2.4 测试
- `packages/domain/src/__tests__/resource-lifecycle.test.ts`：17 单测（处置矩阵/退避/准入/幂等/恢复边界）。
- `apps/gateway/src/__tests-integration__/w11-resource-pool.test.ts`：6 集成（WT-07 同池隔离、WT-19 隔离-恢复+审计、429 冷却半开、熔断阈值、凭证到期、canary）。

## 3. 边界确认（W11 不做项）

- **多 Attempt failover / 路由评分**：W12。W11 只提供 `listServableResources` 硬过滤输出（含 probe 标记）作为 W12 评分输入；gateway `real-pipeline` 单资源查找未改。
- **主动健康探测任务**：W11 只有 `evaluateAdmission` 半开判定；探测执行器（worker 定时任务）归 W25 worker 或后续。
- **倍数折算**（W13）、**额度预占/耗尽停止热路径**（W14）：未触碰。
- **真实 OAuth 刷新 HTTP**：状态机由注入的刷新失败事件驱动；真实刷新流程在 DEP-PROVIDER-CREDENTIALS 解锁后接入，仅阻塞上线签字。
- 无外部新依赖（仅 workspace 内部 `@qianliu/database → @qianliu/domain`）。

## 4. WT 覆盖（M3 需求—验收追踪行 315）

| WT | 运行链 | 测试 |
| --- | --- | --- |
| WT-07 套餐账号失效切换同池账号 | A 401 → 仅 A 隔离；同池 B 可服务；对照池 C 不受影响 | w11-resource-pool.test.ts |
| WT-19 凭证到期/刷新失败仅隔离对应资源；重新授权后受控恢复 | B 刷新失败 → 隔离 + refresh 状态落库；C 继续服务；adminRecover（新凭证版本+过期时间）→ DEGRADED 可服务；审计 REFRESH_FAILED→ADMIN_RECOVER | w11-resource-pool.test.ts |
| 故障注入 | 429 退避冷却→到期半开→成功降级恢复；3 次临时故障熔断；客户端错误不计数；凭证到期 EXPIRED | w11-resource-pool.test.ts |
| canary 0 | 凭证明文/正文在 resource_status_event 0 命中 | w11-resource-pool.test.ts |

## 5. 正式工程命令实测（W11 Audit，2026-07-27 17:05–17:06 于佳哥 Mac 执行）

| 命令 | 结果 |
| --- | --- |
| install | ✅ Already up to date（`@qianliu/database → @qianliu/domain` workspace 链接同步；无外部新依赖；lockfile supply-chain 策略通过） |
| typecheck | ✅ 11 包全 Done |
| lint | ✅ 11 包全 Done（--max-warnings=0，无 ESLint error） |
| test（单测+集成） | ✅ domain **23**（resource-lifecycle **19** 新增 + 原 4）、provider-adapters 35（W09/W10 回归）、gateway **34**（**w11-resource-pool 6** + w10 5 + w09 5 + w08 4 + w05/w07 14）、control-api 23、database 4（0010 回滚/重建）、config 4、contracts 2、observability 4 |
| build | ✅ 11 包全 Done |
| evidence:canary | ✅ postgres/redis/logs/traces 全 0（canary `W01_CANARY_PROBE_SECRET_BODY_20260727`） |

执行环境：macOS，corepack pnpm@11.11.0，Docker Desktop 运行中（Testcontainer PostgreSQL 17）。
补充：typecheck/lint 亦在 AI 沙箱先行实测通过（domain/database/gateway/provider-adapters）；vitest 与 Testcontainer 因 macOS 原生模块与 Docker 依赖，按既定分工在佳哥 Mac 执行。

## 6. 残余风险与后续

- **真实 OAuth/套餐刷新回归**：状态机由注入事件驱动验证；真实刷新 HTTP 在 `DEP-PROVIDER-CREDENTIALS` 解锁后由佳哥跑（W11 上线签字门禁）。
- **主动探测执行器**：当前半开由请求路径准入判定触发；后台定时探测任务归 worker（W25）。
- **健康分数/TTFT/错误率**：W11 只有 `consecutive_failures` 计数；`resource_runtime_snapshot` 短窗口指标（TRD §5.4 行 261）归 W15/W16 预测与调度。
- **Redis 短期计数**：当前状态全部落 PostgreSQL；Redis 热路径缓存归 W14 额度门禁时一并考虑。

## 7. 为 W12 预留的集成点

- `listServableResources(enterpriseId, poolId?, now)` → `ServableResource[]`（含 `probe` 半开标记）：W12 多因子评分的硬过滤输入。
- `route_candidate` 已记录候选；W12 按池选多候选 + committed=false 切换下一候选时，用 `recordFailure` 驱动状态迁移。
