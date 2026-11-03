# WP3 S3 回执：手动刷新端点＋冷却/在途＋迁移 0096＋运维文档（task 3.2）

实施：glm-flash；日期：2026-11-03；基线＝S2 工作树（未提交，S2 产物全部保留）。两项裁定（冷却＝attempt.started_at+P3；在途＝0096 RUNNING 租约；0096 表名 `provider_resource_balance_refresh`）已按合同落地。

## 1. 实际改动文件清单

| 文件 | 改动 |
|---|---|
| `packages/database/migrations/0096_official_balance_refresh_request.js` | 新建：refresh 请求表（id/enterprise/provider_resource/actor/idempotency_key/status RUNNING\|SUCCEEDED\|FAILED/expires_at 租约/started/finished/created/updated；`(enterprise,resource,key)` 唯一幂等键；RUNNING 部分唯一索引 `provider_resource_balance_refresh_running_uq`；latest_idx）。down 直接 drop（表为瞬时协调状态非证据，头注释说明；未设数据守卫——偏离 0073 的"有行拒绝"风格，理由见 §6-3） |
| `packages/database/src/repositories/official-balance-refresh-repository.ts` | 新建：`OfficialBalanceRefreshRepository.begin/finish/listLatest`（0073 模板：过期 RUNNING 收敛 FAILED/REFRESH_LEASE_EXPIRED → 幂等重放 → 在途检查 → 冷却检查（attempt started_at+P3，任意 outcome）→ 插 RUNNING；并发兜底 catch 23505→in_progress）＋`OfficialBalanceRefreshConflict{code, retryAfterSeconds}` |
| `packages/database/src/repositories/official-balance-sync-writes.ts` | 新建：共享写入原语（裁定 5）——`recordOfficialBalanceSyncSuccess`（快照继承+SUCCESS attempt，字段映射与 runner 历史成功分支逐字一致，`inheritCostFacts` 从 runner 迁入）＋`recordOfficialBalanceSyncAttempt`（FAILED/NOT_SUPPORTED 只留痕）＋`officialBalanceSyncDay`（自 runner 迁入） |
| `packages/database/src/kysely.ts` | 注册 `provider_resource_balance_refresh` 表类型 |
| `packages/database/src/index.ts` | 导出新模块 |
| `apps/worker/src/provider-operating-sync/runner.ts` | 消费共享原语：成功分支（latest 查找/append/attempt 字段）与尾部 attempt insert 全部换为 `recordOfficialBalanceSync*`；删除本地 `inheritCostFacts`/`shanghaiSyncDay`/`ProviderRepository` 依赖；失败 attempt 保持"插入发生在 try/catch 之后"的历史语义；行为零变化（S2 测试复跑全绿，断言未动） |
| `apps/control-api/src/providers/official-balance-routes.ts` | 新建：`POST /provider-resources/:id/official-balance/refresh`，`preHandler:[requireAuth]`（自动 resources.operate）；404/422/409/400 分态；begin→进程内解密凭证→`queryProviderOperatingBalance`（适配器 8s 超时，租约 60s）→共享原语写快照/attempt→finish→审计（仿 quota-sync）；响应三态 ACCEPTED/IN_PROGRESS/COOLDOWN＋retry_after_seconds；凭证零下发 |
| `apps/control-api/src/providers/routes.ts` | `registerOfficialBalanceRoutes(app)` 注册进 `registerProviderRoutes` |
| `apps/control-api/src/__tests-integration__/official-balance-refresh.http.test.ts` | 新建 6 用例（§4） |
| `packages/database/src/__tests-integration__/wp3-official-balance-refresh.integration.test.ts` | 新建 7 用例：0096 水位/部分唯一索引断言、begin/finish、幂等重放、冷却（SUCCESS 与 FAILED attempt 均计入＋窗口外放行＋retry_after 值断言）、租约收敛、共享原语（两版快照 version 递增＋同日两行 attempt＋cost NOT_SUPPORTED 继承语义）、down/up |
| `packages/database/src/__tests-integration__/wp3-operating-sync-decouple.integration.test.ts` | 机械适配：0096 成为迁移尾后，S2 的 down 断言改用共享助手 `rollbackTo(db, "0095_…")`（migration-rollback.ts，仓库既有"迁移头不写死"模式）——守卫语义断言原样（/0095 down/ rejects、单行重建成功、唯一性恢复），并新增 0096 先行回滚的包含断言 |
| `openspec/…/WP3/ops-runbook.md` | 新建运维文档（触发方式/env 表/三态行为/冷却在途/0095 down 守卫/0096 down 语义/表速查） |

## 2. 实际命令与结果

| 命令 | 结果 |
|---|---|
| `packages/database` typecheck/lint | 0 错误 |
| `apps/worker` typecheck/lint | 0 错误 |
| `apps/control-api` typecheck/lint | 0 错误 |
| worker `pnpm test` 全量 | **36 文件 200/200**（S2 runner 测试复跑全绿，断言未改） |
| worker runner.test 单独复跑 | 3/3（消费共享原语后） |
| control-api 新 http 集成 | **6/6**（详见 §4） |
| database 新 0096 集成 | **7/7** |
| 回归：`migration.integration`＋`api-cost-estimation`（0092→0093 回滚链现含 0096/0095）＋`wp3-operating-sync-decouple` | **20/20** |
| 回归：control-api `providers/routes.test`＋`contracts-ready.test`＋`w04-provider-route.test` | **22/22** |

调试期修复：路由适配器 null 防御分支（INVALID_RESPONSE 留痕，不冒充余额）；测试两处（PG indexdef 规范化断言、同秒并列审计行改按 result 分组计数；测试内部 seed 遮蔽 TDZ）。

## 3. 三态行为说明（实测）

| 态 | 触发 | 响应 | 副作用 |
|---|---|---|---|
| ACCEPTED | 冷却外且无在途；进程内完成查询 | `{state:"ACCEPTED", result:{outcome:"SUCCEEDED", collected_at, balance{…}}}` 或 `{outcome:"FAILED", error_code}` | RUNNING→终态；成功写快照+SUCCESS attempt；失败只写 FAILED attempt（旧快照保留）；审计 SUCCESS/FAILURE |
| IN_PROGRESS | 同资源已有 RUNNING（部分唯一索引兜底并发 23505） | `{state:"IN_PROGRESS", retry_after_seconds}`（至租约到期） | 零上游调用；租约 60s，崩溃残留由下次 begin 收敛 FAILED/REFRESH_LEASE_EXPIRED |
| COOLDOWN | 最近 attempt（任意 outcome）started_at+P3 内 | `{state:"COOLDOWN", retry_after_seconds}` | 零上游调用、零刷新行；冷却外可再刷（AT-X02 失败后可再次刷新已测） |

错误分态：404 not_found／422 official_balance_not_supported（零写入，三表断言）／409 credential_missing／400 invalid_request。

## 4. 新测试用例（13 用例）

control-api http（6）：成功刷新（ACCEPTED＋快照 110.00000000/PROVIDER_API/PROVIDER_SYNC＋SUCCESS attempt+snapshot_id＋审计 SUCCESS＋响应与审计 JSON 不含 `sk-test-secret-123`）；冷却（COOLDOWN＋retry_after 0-30＋fetch 计数不变＋刷新行仍 1）；在途（手动 RUNNING→IN_PROGRESS 零上游；租约过期收敛 REFRESH_LEASE_EXPIRED；冷却压缩后可再刷成功，终行 2）；权限（view-only POST 403＋GET 列表 200 且 operating_snapshot 通道存在、未刷时 null；zhipu API 422 三表零写入；缺凭证 409；未知 404）；上游失败（500→FAILED/UPSTREAM_UNAVAILABLE、旧快照保留、失败 attempt+审计 FAILURE、压缩冷却后重刷成功 90）；请求体校验 400。
database（7）：水位断言（表+部分唯一索引 indexdef）；begin/finish（并发 in_progress、终态后再发起）；幂等重放（同键单行复用）；冷却（SUCCESS/FAILED attempt 均计入、retry_after≈20s 边界、窗外放行）；租约收敛（过期 RUNNING→FAILED/REFRESH_LEASE_EXPIRED＋放行）；共享原语（version 递增、cost_source NOT_SUPPORTED 继承、同日两行 attempt）；down/up（表 drop+重建）。

## 5. 审计与凭证不泄露确认

- 审计：`operation_log` action=`provider_resource.official_balance_refresh`，change_summary 仅含 outcome/snapshot_id/currency（成功）或 outcome/error_code（失败），测试断言审计 JSON 不含凭证明文。
- 凭证：解密仅进程内局部变量（`decryptCredential`→adapter Bearer 头），响应体断言不含 `sk-test-secret-123`；日志无凭证（路由无 console/req.log 输出凭证）。

## 6. 剩余问题 / 移交

1. S2 测试文件机械适配（down 断言改 `rollbackTo` 精确落点）：守卫断言原样＋新增 0096 包含断言——自评不降低强度，请总指挥复核追认。
2. 0096 down 未设数据守卫（合同字面"down drop 表"）：表是瞬时协调状态，drop 只丢在途标记；与 0073"有行拒绝"风格不同，已在迁移头注释与 ops-runbook §5 声明。如总指挥裁定需要守卫，S6 前可补（加性改动）。
3. 手动刷新 attempt 的 `next_sync_at = started_at + P1`（手动计入周期节奏）与 `nextSyncAt` 参数化是共享原语的一部分；若业务要求手动刷新不占 P1 节奏，需要 S4 前裁定调整（仅改 route 传参）。
4. idempotency_key 客户端可选（缺省服务端生成）：重放语义仅对显式传键的客户端生效；冷却/在途已覆盖重复请求防护。
5. 控制台全量 battery（control-api 全套 475+）本阶段未跑（S6 汇总复跑），已跑 provider 相关三套件＋新套件全绿。
