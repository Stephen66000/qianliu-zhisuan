# WP3 S4 回执：官方余额状态读取完整化（task 3.3）

实施：glm-flash；日期：2026-11-03；基线＝S3 工作树（未提交）。S2/S3 产物零回退；`listLatestOperatingSnapshots`/`listCurrentOperatingSnapshots`/dashboard/insights 旧消费方未触碰（forecast 留 S5）。

## 1. 实际改动文件清单

| 文件 | 改动 |
|---|---|
| `packages/database/src/repositories/official-balance-states.ts` | 新建：`listOfficialBalanceStates(db, enterpriseId, {now, expireMs, cooldownMs})` — source 过滤（`source='PROVIDER_SYNC'`，DISTINCT ON + collected_at/version 倒序，与恢复链证据查询同序）＋最新 attempt＋RUNNING refresh 行→逐资源 C2 状态行；status 主状态判定＋`expired`/`last_attempt_failed` 布尔承载叠加（OAB-04）；supported 判定与适配器同源（`canonicalProviderCode===deepseek && mode==='API'`）；OAB-05 无任何合计字段 |
| `packages/database/src/index.ts` | 导出新模块 |
| `apps/control-api/src/providers/routes.ts` | GET /provider-resources 列表：Promise.all 并行增加 `listOfficialBalanceStates`（P2/P3 按请求时读 env），每资源附 `official_balance` 字段（`operating_snapshot` 与 `finance` 之间）；`contracts.ts` 未触碰（响应非 schema 校验对象，无需扩展，WP2 守卫区零接触） |
| `packages/database/src/__tests-integration__/wp3-official-balance-states.integration.test.ts` | 新建 7 用例（§4） |
| `apps/control-api/src/__tests-integration__/official-balance-refresh.http.test.ts` | +1 用例：列表 `official_balance` 结构/不含凭证/view-only 可读/不支持资源 UNSUPPORTED |

## 2. 命令与用例数

| 套件 | 结果 |
|---|---|
| database 新状态套件 | **7/7** |
| control-api refresh http 套件（S3 6＋新增 1） | **7/7** |
| 回归：database wp3 decouple＋refresh＋migration.integration | **17/17** |
| 回归：control-api routes.test＋contracts-ready＋w04-provider-route | **22/22** |
| 额外回归：provider-finance-activation.http（重度消费列表路由＋view-only 管理员） | **15/15** |
| database / control-api typecheck＋lint | 0 错误 |

## 3. status 派生规则最终表（状态×条件矩阵，判定序；供 report 与 WP4 引用）

| # | 条件 | status | 叠加字段 |
|---|---|---|---|
| 1 | canonical provider ≠ deepseek 或 mode ≠ API（与适配器 :51 同源） | `UNSUPPORTED` | 全部余额字段/last_attempt/next_refresh_at 恒 null |
| 2 | 存在 RUNNING refresh 行（0096 表） | `SYNCING` | `last_attempt_failed`/`expired` 照常计算 |
| 3 | 无成功（PROVIDER_SYNC）快照 ∧ 最新 attempt `balance_status='FAILED'` | `FAILED` | total_balance/currency/composition/available/last_success_at 全 null（不显 0，AT-OAB-08） |
| 4 | 无成功快照（从未同步，或仅 NOT_SUPPORTED 痕迹） | `NEVER_SYNCED` | 同上行全 null |
| 5 | 有成功快照 ∧ 最新 attempt FAILED | `FAILED` | 旧值保留（total_balance=快照值）；`expired`＝快照超 P2 时 true（FAILED＋EXPIRED 叠加表达，AT-OAB-07） |
| 6 | 有成功快照 ∧ 最新 attempt 非 FAILED ∧ 超过 P2 | `EXPIRED` | `expired=true`；旧值保留 |
| 7 | 其余（有成功快照，最新 attempt SUCCESS/NOT_SUPPORTED，未超 P2） | `OK` | — |

布尔叠加独立于主状态：`expired`＝`有成功快照 ∧ (now − collected_at) > P2`（所有受支持态计算）；`last_attempt_failed`＝最新 attempt `balance_status='FAILED'`。成功行带费用维度 error_code（`PROVIDER_COST_API_NOT_SUPPORTED`）不影响 outcome——`last_attempt.outcome` 取 `balance_status`。

**字段值来源**：total_balance/currency/composition{granted,topped}/available ＝ 最新 `source='PROVIDER_SYNC'` 快照（受支持且有快照时；否则 null）；`last_success_at` ＝ 该快照 `collected_at`；`last_attempt{at,outcome,reason}` ＝ 最新 attempt 的 completed_at/balance_status/failure_reason；`next_refresh_at` ＝ max(最近 attempt started_at+P3, RUNNING 租约 expires_at)，已过期或不适用 → null（立即可刷）。

## 4. 新测试用例（8 用例）

database（7）：a) AT-OAB-07 三段时钟（OK→失败保鲜 50＋FAILED＋冷却内 next_refresh_at=attempt+P3→冷却后 null→超 P2 后 FAILED＋expired=true）；b) AT-OAB-08（401 FAILED 余额 null 不显 0；NOT_SUPPORTED-only→NEVER_SYNCED 规则钉死；从未同步→NEVER_SYNCED）；c) AT-OAB-02（仅 ADMIN 手工快照→官方 null、手工 80 不混入）；d) 不支持厂商（zhipu＋ADMIN 快照＋SUCCESS attempt 也不混入→UNSUPPORTED 全 null）；e) AT-OAB-09/10（同 provider 两资源各 100 两行独立＋键名无合计字段）；f) RUNNING 行→SYNCING＋next_refresh_at=租约到期（max 语义）；g) P2 可配置（15min→EXPIRED / 30min→OK 同数据）。
control-api（1）：刷新成功后 GET 列表 `official_balance` 全结构断言（OK/110/组成/available/last_attempt SUCCESS/冷却内 next_refresh_at 非空）＋zhipu 资源 UNSUPPORTED 全 null＋view-only 管理员可读＋响应不含 `sk-test-secret-123`。

## 5. 与 C2 合同的差异点

1. **`next_refresh_at` "无 attempt→null" 子句**：合同字面与自身公式（max(attempt+P3, RUNNING 租约)）在"有 RUNNING 无 attempt"时矛盾——实现取 max（首刷进行中 → 显示租约到期），且候选已过即输出 null（立即可刷）。已在矩阵注释钉死。
2. **叠加表达**：C2 status 为单值，FAILED/EXPIRED/SYNCING 的叠加按合同括注方案用 `expired`/`last_attempt_failed` 独立布尔承载——WP4 展示层需把布尔渲染为叠加标记。
3. 其余字段与 contracts.md §1 C2 逐项一致（字段名 snake_case 对齐路由既有风格）。

## 6. 剩余问题 / 移交

- `listOfficialBalanceStates` 对 SYNCING 态也输出旧值（RUNNING 期间旧快照仍展示）——符合 OAB-04"失败/同步中不掩盖旧值"，WP4 渲染时以 status 为主标记。
- forecast/告警的来源＋时效筛选是 S5（本包未触碰 supply-forecast-repository/insights）。
- 路由按请求读 env（P2/P3），与其他 config 读取模式一致；启动期不校验（首次请求才 fail-fast）——如需启动期校验可移到 buildControlApi，S6 前可裁定。
