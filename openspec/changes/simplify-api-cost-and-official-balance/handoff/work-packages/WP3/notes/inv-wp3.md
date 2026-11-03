# Inv-WP3 调查笔记：官方余额独立同步现状与实施落点（只读）

日期：2026-11-03；基线：worktree `/Users/mac/Projects/仟流智算-api-decouple`，分支 `codex/simplify-api-cost-and-official-balance`，HEAD `67c9aec1cda4fb91e28ec821f38475c76152cce6`（已复核，含远端主线 `ae506fed…933e`，工作树干净）。全文行号均以该 HEAD 为准。

**重要基线修正**：inv-c.md §2"runtime-assurance 调度器未见该任务的周期注册、生产实际触发方式待核实"**已过时**。`provider_operating` 任务自 origin/main 的 `de07cdf`（quota 窗口自动恢复提交）起就注册在调度循环 core 任务中（`apps/worker/src/main.ts:333-336`，历史用 `git log -L 333,336:apps/worker/src/main.ts` 核实）；inv-c 只查了 scheduled-tasks.ts，漏了 main.ts 的 scheduler core。现状＝每轮 tick（默认 30s）都调用 runner，由 attempt 表"每日一次"门禁限流。

---

## 1. runner 三处耦合精确解除点

文件：`apps/worker/src/provider-operating-sync/runner.ts`（当前 258 行，行号与 inv-c 基线不同，以下为 HEAD 实测）。

### 1a. 充值记录依赖（对应 inv-c :58-74）

**现状**：
- `needsPostRechargeSync`（:53-75）：仅 `mode === "API"`（:56）时查 `resource_purchase_record`（`purchase_type='API_RECHARGE'`）与最近 `source='PROVIDER_SYNC'` 快照的 `collected_at`（SQL :57-69），充值晚于快照才返回 true。
- 消费点：`shouldSkipDailySync`（:77-87）——当日已有 attempt 行且**非**充值后补同步（:86）则 skip。
- WP2 后充值 HTTP 写入口已 410（WP2 report §2/§3；AT-AFR-02 参数化断言四表零增量），但表本体保留，DB 直插仍可能（runner.test.ts:58-65 即直插构造场景）。

**解除方式（建议）**：删除 `needsPostRechargeSync` 与 `shouldSkipDailySync` 的充值分支（:86），门禁整体改为周期门禁（见 §2/§3）。**解除后必须保留的行为**：
- 范围选择：`provider_resource` join `provider`，资源 `status in (ACTIVE,DEGRADED,EXHAUSTED)`（:154）、provider `status='ACTIVE'` 且双方 `archived_at is null`（:155-157）——mode 不在此过滤，靠适配器 null 分支与恢复函数的 `mode!=="API"` 早退兜底。
- 静默企业整企业跳过（PFA-09，:162-166，`listQuiescentEnterpriseIds`）——WP2 report §6 明确保留（D2）。
- attempt 记录照写（成功/失败/不支持三种 outcome 都落 `provider_resource_operating_sync_attempt`，:240-254）。
- 成功时 `cost_status='NOT_SUPPORTED'` + `error_code='PROVIDER_COST_API_NOT_SUPPORTED'` 语义（:226-228，DeepSeek 无公开费用接口）。
- 循环内恢复尝试先于门禁（:168 在 :169 之前）——即使当轮被跳过，EXHAUSTED 资源仍可被既有新快照恢复，S2-S5 不得改变该顺序。

### 1b. FINANCE_MODE_INACTIVE skip（对应 inv-c :118-125）

**现状**：`financeModeInactiveSkip`（:120-128）读 `readProviderFinanceMode`（import :2，调用 :123），非 ACTIVE 返回 `skipped:"FINANCE_MODE_INACTIVE"` 结果；入口 `runProviderOperatingSyncTick`（:130-136）:133-135 短路。

**精确解除方式**：`runProviderOperatingSyncTick` 直接返回 `runProviderOperatingSyncTickInActiveMode(input)`（或把两函数合并、删除 `financeModeInactiveSkip` 与 `readProviderFinanceMode` import）；`ProviderOperatingSyncResult.skipped` 字段（:32）可留可删（留则兼容旧断言，删则同步改测试）。

**同 runner 其他 finance mode 读取点**：无（仅 :2/:118/:123/:125 四处，grep 全文件核实）。
**订阅续订 runner 独立性**：`apps/worker/src/subscription-renewal/runner.ts:3`（import）、:6-7（`readProviderFinanceMode(...) !== "ACTIVE"` → `{skipped:"FINANCE_MODE_INACTIVE"}`）——**独立 fail-closed，不得误动**。control-api 侧另有 `apps/control-api/src/server.ts:195`（`readProviderFinanceMode` 装饰 app :258、门控 provider-finance 路由注册 :305-308、注入 OperatingBillRepository :243）——属 WP2/WP1 语义，不在本包解除范围。

### 1c. 耗尽恢复链（对应 inv-c :92-107）

**现状（两个调用点，均 S2-S5 不得改变行为）**：
- `recoverFromFreshPositiveBalance`（:89-101）：API+EXHAUSTED 且存在任意历史 `source='PROVIDER_SYNC'` 快照（按 `collected_at desc, version desc` 取最新，:93-99）→ `recordBalanceSyncRecovery(resource.id, snapshot.id)`（:100）。
- `recoverFromFetchedBalance`（:103-109）：API+EXHAUSTED 且本轮成功产出快照 → 用新快照 id 调用（:106-108，在 :230 成功分支内）。

**DB 侧约束现状**：`packages/database/src/repositories/resource-pool-repository.ts:252-273` `recordBalanceSyncRecovery`——事务内 `forUpdate` 锁资源行（:256-257），状态机 `deriveBalanceSyncRecovery`（:258），**证据约束**（:260-268）：快照须 `source='PROVIDER_SYNC'`（:264）+ `provider_balance_available=true`（:265）+ `balance_source='PROVIDER_API'`（:266）+ `current_balance>0`（:267）+ `collected_at > row.updated_at`（:268，隔离时刻之后）。无证据 → 返回 null 不恢复（:269）。与 inv-c 记录的 :252 一致，未漂移。

**现有测试**：
- worker：`apps/worker/src/provider-operating-sync/runner.test.ts` 用例 1 内嵌恢复断言——恢复 `BALANCE_SYNC_RECOVERED`→`DEGRADED`（:84-90）；证据不足（`provider_balance_available=null`）不恢复保持 EXHAUSTED（:96-108）；旧快照不能解除新隔离（:101-108 段）。
- domain 状态机：`packages/domain/src/__tests__/resource-lifecycle.test.ts:242` 起 `describe("deriveBalanceSyncRecovery API 余额证据恢复")`（文件共 28 个 it）。
- 静默交互：`apps/worker/src/__tests-integration__/provider-finance-quiescence-worker.integration.test.ts`（import runner :12）覆盖静默期零写入。

---

## 2. 周期调度现状

**一次性命令**：`apps/worker/src/main.ts:98-101` 注册 `provider-operating-sync-once`（实现 `runProviderOperatingSyncOnce` :424-434）；用法行 :150。

**周期注册现状（修正 inv-c）**：
- `runtime-assurance-scheduler` 命令（main.ts:78-81 → `runRuntimeAssuranceScheduler` :242-422）：循环间隔 `RUNTIME_ASSURANCE_INTERVAL_MS`，默认 **30000ms**（:251），健康服务端口 :250；`runSchedulerLoop`（`apps/worker/src/runtime-assurance/scheduler.ts:54-78`，pg advisory lock 单实例 :29-40，health :42-52）。
- core 任务每轮执行，`provider_operating` 在其中（main.ts:333-336），完成日志 :355-357；任务隔离捕错 `runIsolatedOperationalTask`（`scheduled-tasks.ts:34-45`）+ 整轮汇总 `summarizeIsolatedOperationalRound`（:48-56）。
- 即：**当前频率控制完全靠 DB 门禁（attempt 表每日一次＋充值补同步），调度器本身每 30s 调一次 runner**。

**P1=15min 周期注册推荐落点**：**复用既有调度循环 core 槽位，不新增调度器**。改法：把 runner 内"每日一次"门禁替换为"距上次同步 ≥P1"门禁，门禁数据源用 attempt 表既有 `next_sync_at` 列（runner 已写 `now+24h`，:143 与 :250——语义改为 `now+P1`）。理由：30s 级 DB 查询门禁与 quota_window/forecast 同款（main.ts:325-336 同构）；新增独立 setInterval 会绕开 advisory lock 单实例保证（scheduler.ts:29-40）与调度健康汇总。

**配置读取模式**：`packages/config/src/index.ts:35-39` `readProviderFinanceMode`＝zod enum parse＋默认值（schema :32-33）——P1/P2/P3 照此模式新增（如 `readProviderOperatingSyncIntervalMs` 等）；整数毫秒/秒值可直接复用同文件 `readPositiveIntEnv`（:166-179，fail-fast 正整数）。contracts.md §2 明确"全部走环境变量/配置（同 PROVIDER_FINANCE_MODE 模式，packages/config）"。worker 侧消费点在 runner（经 `ProviderOperatingSyncInput.env`，:113），control-api 侧消费点在刷新路由（`process.env`）。

**可仿照的周期任务例子**：`supply_forecast`（main.ts:328-329）/`quota_window`（:331-332）均为"每轮 tick 调用＋runner 内自判是否到点/有活干"。续订 renewals 有独立槽位与时间门禁（main.ts:303-310，`runScheduledOperationalTasks` 的 renewals 参数，scheduled-tasks.ts:11-13）。

---

## 3. 快照写入与日内多次

**version 自增逻辑**（对应 inv-c :69-74）——两份同构实现：
- `packages/database/src/repositories/provider-operating-snapshot-writer.ts:68-74`：取该资源 max(version)+1 后插入（:71-99）。供资金/管理端写路径用（含 CODING_PLAN 绑定周期逻辑 :12-57）。
- `packages/database/src/repositories/provider-operating-repository.ts:101-129`：`ProviderRepository`（runner 用）同名方法，:115-125 同款 max+1。runner 经此写入（runner.ts:204）。
- 表约束：唯一索引 `(provider_resource_id, version)`（0026:75-80）——**快照表天然允许同日多行**，日内多次不需要动 0026。

**一次 sync run 写什么（按资源逐个）**：
- 成功：1 行快照（`source='PROVIDER_SYNC'`、`balance_source='PROVIDER_API'`、currency/granted/topped/available、`balance_updated_at=providerDataAt`，runner.ts:204-221）＋1 行 attempt（`balance_status='SUCCESS'`、`snapshot_id`、`provider_data_at`、`started_at/completed_at`、`next_sync_at=now+24h`、`error_code='PROVIDER_COST_API_NOT_SUPPORTED'`、`failure_reason='余额同步成功；厂商未公开费用接口…'`，runner.ts:240-254）。注意：**成功 attempt 也带 error_code/failure_reason**（费用维度），OAB-04 的 last_attempt 展示需按 `balance_status` 区分，不能只看有无 error_code。
- 失败：0 快照＋1 行 attempt（`balance_status='FAILED'`、error_code=适配器错误码或 `UPSTREAM_UNAVAILABLE`，runner.ts:233-239）——失败留痕在 attempt 表，不写快照（0051 文件头 :4"失败不会覆盖最后一次成功经营快照"）。
- 不支持（非 deepseek/无凭证/适配器 null）：0 快照＋1 行 attempt（`NOT_SUPPORTED`，runner.ts:178-200）。
- **同日第二 attempts 全部被吞**：`shouldSkipDailySync` 先拦（:77-87）；即便直达 insert，`(enterprise_id, provider_resource_id, sync_day)` 唯一索引＋`onConflict doNothing`（0051:65-70；runner.ts:254）也会丢弃。attempt 行受不可变触发器保护（`BEFORE UPDATE OR DELETE` 拒绝，0051:117-121）。

**0095 需要承载什么（建议，不实施）**：
1. **DROP UNIQUE INDEX `provider_resource_operating_sync_attempt_daily_uq`**（0051:66-70；down 逐字重建）。旧尝试全保留（drop index 不动行；不可变触发器只挡 UPDATE/DELETE，INSERT 不受影响）。风险记录：一旦日内多行存在，0095 down 重建唯一索引会因重复失败——down 需带存在性守卫（仿 0051 down :126-135 的拒绝式守卫）或在文档声明"产生多行后禁止 down"。
2. runner 同步去掉 insert 的 `onConflict((oc) => oc.columns([...]).doNothing())`（:254）——唯一索引删除后 `ON CONFLICT (cols)` 会因无匹配唯一约束直接报错，**迁移与 runner 改动必须同阶段上线**。
3. 尝试记录表不需要新表承载"日内多次"（attempt 表即尝试记录表）；如 S3 手动刷新需要"在途/冷却"共享状态，见 §5——可在 0095 一并建 refresh 请求表（0073 模板）。

---

## 4. 余额状态读取落点（C2 字段）

**快照表现有读取方（全列，生产代码）**：
- `ProviderOperatingRepository.listLatestOperatingSnapshots`（provider-operating-repository.ts:35-45）：`DISTINCT ON (provider_resource_id) ... ORDER BY version DESC`——**不筛 source**（ADMIN 手工快照会混入"最新"）。消费：`listCurrentOperatingSnapshots`（:47-62）→ `projectCurrentOperatingSnapshots`（provider-operating.ts:109-171，CP 才重算额度，API 行原样透传 `current_balance`）；调用方：supply-forecast-repository.ts:51、dashboard-repository.ts:66/:130、dispatch-operating-input.ts:62、runner.ts:202、control-api GET /provider-resources 列表（providers/routes.ts:248）。
- `listOperatingSnapshotHistory`（provider-operating-repository.ts:86-99）→ control-api `GET /provider-resources/:id/operating-snapshots`（routes.ts:339-353）。
- 直接 SQL/条件读：operating-analysis-repository.ts:72（**已筛 `source='PROVIDER_SYNC'`**）、resource-pool-repository.ts:260-268（恢复证据）、provider-finance-legacy-resolution.ts:76（`source!=="PROVIDER_SYNC"` 判定）、dashboard-breakdown.ts:115-144/:297-338（跨资源 same-currency 合计 `current_balance`——OAB-05 展示域注意点，WP4）、resource-insights/query.ts:289-293（LATERAL 最新快照，**不筛 source**）。
- attempt 表读取：`listLatestOperatingSyncStates`（provider-operating-repository.ts:64-84）——按 `completed_at DESC, created_at DESC` 取每资源最新一条＋窗口函数 `MAX(provider_data_at) FILTER (WHERE balance_status='SUCCESS')` 得 `last_success_data_at`（:68-70）。**该查询不依赖每日唯一**，0095 放开后语义不变，是 last_attempt/last_success_at 的现成读取原语；已被 GET /provider-resources 列表消费（routes.ts:248）。

**C2 字段数据来源建议**：
| 字段 | 来源 | 说明 |
|---|---|---|
| `supported` | 派生：`canonicalProviderCode==deepseek && mode=="API"`（provider-operating-facts.ts:51 同款判定） | UNSUPPORTED 显示"暂不支持"，不零值冒充 |
| `total_balance`/`currency`/`composition{granted,topped}`/`available` | 最新 `source='PROVIDER_SYNC'` 快照的 `current_balance`/`currency`（0026:22 列已存在）/`granted_balance`+`topped_up_balance`（0051:14-15）/`provider_balance_available`（0051:16） | 必须新建 **source 过滤** 的读取函数——现 `listLatestOperatingSnapshots` 不筛 source，不能直接复用 |
| `last_success_at` | attempt 表 `MAX(completed_at) FILTER (balance_status='SUCCESS')`（:64-84 同款窗口）或最新成功快照 `collected_at`；两口径并存时建议统一用快照 `collected_at`（采集时间） | ≠页面打开时间 |
| `status`（SYNCING/OK/FAILED/EXPIRED/NEVER_SYNCED/UNSUPPORTED，FAILED 可叠 EXPIRED） | 派生计算：最新 attempt outcome＋最新成功快照时间＋P2 阈值比较；SYNCING 依赖 §5 在途标记 | 无新列，纯读侧派生 |
| `last_attempt {at,outcome,reason}` | 最新 attempt 行 `completed_at/balance_status/error_code/failure_reason`（:64-84 现成） | 注意成功行也带费用维度 error_code（runner :227-228），outcome 应取 `balance_status` |
| `next_refresh_at` | 冷却＝最近一次成功/尝试时间＋P3；在途＝§5 请求表 RUNNING 行 | 需 P3 配置注入读侧或由刷新路由写 |

**currency 现状**：快照表有 `currency varchar(8)` 列（0026:22），runner 写 `balance.currency`（runner.ts:207）；适配器取 `balance_infos[].currency` 大写并优先 CNY（provider-operating-facts.ts:82-91）。无需新列。

**读取入口建议**：在 `provider-operating-repository.ts` 新增如 `listOfficialBalanceStates(enterpriseId, now, {freshnessMs})`（source='PROVIDER_SYNC' 最新快照＋最新 attempt join＋阈值判定，输出 C2 全字段行对象），control-api 资源列表路由（providers/routes.ts:241-310，该响应已含 `operating_snapshot` :310 与 syncStates）与 forecast/insights 消费方分别挂接；不动既有 `listLatestOperatingSnapshots` 语义（dashboard 等旧消费方在 S4 只按需切换）。

---

## 5. 手动刷新端点挂载

**路由文件与权限**：
- provider-resources 路由全部在 `apps/control-api/src/providers/routes.ts`（注册入口 `registerProviderRoutes` :36-40，server.ts:304 挂载）。现有：GET 列表 :241、GET operating-snapshots :339、POST :362、DELETE :146、archive/unarchive :206/:223、model-routes :537+。**无 GET /provider-resources/:id 详情路由**（列表响应已内嵌快照与同步状态，C2 字段挂列表响应即可）。
- 权限机制：`preHandler: [requireAuth]`（auth-guard.ts:15-60）→ `allowsRoute`（admins/access.ts:13-26）→ `adminRouteModule(route)`（packages/contracts/src/admin-permissions.ts:17-35，:32-34 把 `provider-resources` 映射到模块 `resources`）→ `canAccess(module, read?"view":"operate")`（admin-permissions.ts:10-14）。**新 POST 路由只要挂在 `/provider-resources/:id/...` 下＋requireAuth 即自动要求 `resources.operate`**（与 activation-routes.ts:24-26 注释、contracts.md P5 一致）。
- 单资源操作路由同款先例：`POST /provider-resources/:id/quota-sync`（providers/quota-window-routes.ts:38-126）。

**control-api→worker 触发现状**：**无 HTTP 任务队列**。worker 是独立进程轮询 DB（调度循环）；control-api 对厂商上游的既有模式是**进程内直接调用**：
- `POST /provider-resources/:id/quota-sync`（quota-window-routes.ts:64-70）：解密凭证（`app.credentialKek`，:65-67）→ 进程内 `queryCodingPlanQuota`（:68-70）→ **capture token 条件提交**（`captureQuotaQueryToken` :60 / `commitQuotaQueryResult` :71-87 / `commitQuotaQueryFailure` :107-113）防止与 worker 并发互踩（:57 注释"与 Worker 共用同一条件提交入口"）→ 审计（:88-98）。
- 凭证探测 `POST /provider-resources/:id/credential-probes`（providers/credential-probe-routes.ts:48+）：`repo.begin`（:50）幂等重放/在途/冷却判定 → 进程内调用（:70-76）→ `repo.finish`。共享状态全在 DB：`credential_chat_probe` 表 RUNNING 部分唯一索引（0073:31-32）＋`retry_at` 冷却（0073:28；busy 判定 credential-chat-probe.ts:77-81）＋`expires_at` 租约（:88；过期 RUNNING 由 begin 收敛 :56-58）＋幂等键重放（:59-62）。

**刷新端点可行路径（建议）**：仿 quota-sync＋credential-probe 组合——control-api 进程内解密凭证→`queryProviderOperatingBalance`→写入走 packages/database 共享原语（attempt 行＋快照，provider-operating-repository 已有 `appendOperatingSnapshot`；需补 attempt 写入函数供 control-api 复用）。**在途/冷却状态必须是 DB 行（跨进程），不能用内存**：attempt 表自身不可变且无 IN_PROGRESS 状态（CHECK 限定 SUCCESS/FAILED/NOT_SUPPORTED，0051:58-59），故建议 0095 另建 0073 式 refresh 请求表（部分唯一 RUNNING 索引＋retry_at 冷却＋幂等键），attempt 表只承载终态 outcome。备选（accept 后由 worker 消费）需要 app→app 共享同步核心，当前 runner 在 apps/worker，control-api 跨包 import 不可行，除非把同步核心下沉 packages/database——改动面更大，S3 再定。

---

## 6. 预测/告警现状

- **写入侧**：`SupplyForecastRepository.runTick`（supply-forecast-repository.ts:28-152）：快照来自 `listCurrentOperatingSnapshots`（:51，**不筛 source**）；API 模式 `remainingQuota=operating.current_balance`（:72-74）；`computeForecast`（domain）输出含 `not_calculable_reason`（:136 写入 supply_forecast 表）与 `confidence`。
- **读取/展示侧**：`GET /supply-forecasts`（control-api read-models/routes.ts:342-374，暴露 `not_calculable_reason` :359——OAB-07"不可计算"输出通道已存在）；resource-insights/query.ts:289-311——诊断面板已做时效判定但**硬编码 15 分钟**（`sf.snapshot_at >= now() - interval '15 minutes'`，:296）且 is_current 校验 `sf.remaining_quota` 与最新快照余额一致（:301-302）。
- **source 筛选现状**：预测链路（forecast runner＋insights＋read-models）**均未筛快照 source**；全仓生产代码筛 `source='PROVIDER_SYNC'` 的仅三处：operating-analysis-repository.ts:72、resource-pool-repository.ts:264、provider-finance-legacy-resolution.ts:76（另 runner.ts:68/:97 自用）。OAB-07"来源合格"需在 forecast 读入点（supply-forecast-repository.ts:51 或下沉到 listCurrentOperatingSnapshots 的官方变体）落。
- **时效判断现状**：除 insights :296 硬编码 15min 外，forecast runner 无时效判断（旧快照照算）。OAB-07 落点＝S5：读入点筛 source＋`collected_at/balance_updated_at` 距 now 超 P2 → 置 `not_calculable_reason`（"数据待更新"类），`forecast_exhaust_at` 不输出确定值。
- **告警**：`alert-event-*` 全家（packages/database/src/repositories/alert-event-*.ts）**未找到任何 supply_forecast/forecast_exhaust_at/coverage_hours 消费点**（grep 核实）；阈值 `exhaustCoverageHours` 已定义（alert-event-types.ts:45/:52）并在 server.ts:169-172 从 env 构造，但**评估点未找到**（未找到，无法核实其消费链）。OAB-07 的"API 余额告警"在本仓生产代码中的落点以 supply-forecast/insights 读取为主；若存在独立的余额告警评估器，未找到。

---

## 7. 测试盘点

| 套件 | 位置 | 用例数/覆盖 | 跑法 |
|---|---|---|---|
| worker runner | `apps/worker/src/provider-operating-sync/runner.test.ts` | **2 it**（:15 成功/同日幂等/充值补同步/恢复/证据不足不恢复/失败保鲜＋attempt 断言，26 处 expect；:123 资金门禁 DARK/OFF 零写入）。真 Postgres：`startPostgresContainer("pool20_025_operating_sync")`（:11）＋`migrateToLatest`（:18） | `pnpm --filter` 对应包 `test`（vitest run --config ../../vitest.config.ts） |
| worker 静默 | `apps/worker/src/__tests-integration__/provider-finance-quiescence-worker.integration.test.ts` | 静默期经营同步零写入（import runner :12） | 同上 test:integration |
| provider-adapters | `packages/provider-adapters/src/__tests__/provider-operating-facts.test.ts` | **2 it**（:9 只接受 DeepSeek 官方字段；:33 不支持→null、缺字段抛错不补 0） | 包内 vitest |
| database pool010 | `packages/database/src/__tests-integration__/pool010-provider-operating.test.ts` | **5 it**（:39 分列不伪造 0；:191 API 预测按最新余额；:264 重置周期汇总；:370 编辑/重置只追加不重算；:435 0025-0029 连续回滚重升级） | 包 `test:integration`（--maxWorkers=4） |
| database 单元 | `packages/database/src/repositories/provider-operating.test.ts` | **4 it**（:5 套餐重置周期） | 包 test |
| domain 状态机 | `packages/domain/src/__tests__/resource-lifecycle.test.ts` | 28 it，其中 `deriveBalanceSyncRecovery` 专项 describe :242 | domain 包 test |
| control-api 集成 | `src/__tests-integration__/*.http.test.ts` 等 | 模式：`startPostgresContainer`（postgres:17-alpine）＋`migrateToLatest`＋`buildControlApi(db)`（wp07 测试 :139-140）＋真会话 cookie（generateSessionToken/digestSessionToken＋hashPassword 夹具 :220）＋`app.inject`（:293-298） | 包 `test:integration` |
| S2-S5 新测试落点 | runner.test.ts（解耦/周期门禁）、0095 迁移正反（database）、新读取函数（database）、刷新端点（control-api http 测试） | — | — |

---

## 8. inv-c §6 移交核实项

1. **`PROVIDER_API` source 取值**：**作为快照表 `source` 的取值不存在**。0026 的 CHECK 只允许 `ADMIN/PROVIDER_SYNC/BILL_RECONCILIATION`（0026:44-46）。`PROVIDER_API` 实际是 **`balance_source` 列的取值**（0051:26-29 CHECK；runner 写 :213；恢复证据消费 resource-pool-repository.ts:266）。另有一处同名但异域：`provider_model_discovery.source='PROVIDER_API'`（model-discovery.ts:96 等），与快照表无关。**结论：C2/D2 读取筛选应为 `source='PROVIDER_SYNC'`（可选叠加 `balance_source='PROVIDER_API'`），不存在"source=PROVIDER_API"写法。**
2. **`balance_updated_at` 语义**：＝**采集时间**，非官方返回时间。适配器 `providerDataAt = input.now ?? new Date()`（provider-operating-facts.ts:98），runner 传 tick 的 `now`（:220，`balance_updated_at: balance.providerDataAt`）；DeepSeek 响应解析只取 `is_available`＋`balance_infos[]`（:75-94），官方 payload 无余额时间戳字段。attempt 表 `provider_data_at`（runner :247）同值。
3. 生产触发方式：已核实（见 §2 顶部修正——调度循环 core 每 30s 一轮＋DB 每日门禁）。
4. DeepSeek 官方限流数值：**仍未核实（BLOCKED 维持）**，P1=15min 保持"按厂商限制可调"标注。

---

## 9. WP2 交互面

WP2 业务提交 `52fe37d` 共 48 文件（`git show --stat` 核实）：
- **apps/worker：零触碰**；**packages/domain：零触碰**。WP3 的 runner/main.ts 改动与 WP2 无共同文件。
- 共同触碰文件（风险＝同文件不同区域，顺序串行无合并冲突，但实施前需先读 WP2 改后版本）：
  1. `packages/database/src/repositories/resource-pool-repository.ts`——WP2 改 :450 邻域（准入解除，10 行）；WP3 红线要求 :252/:443/:451 逐字不动，S5 只做回归不编辑。
  2. `apps/control-api/src/providers/contracts.ts`——WP2 改 `financeManagedOperatingSnapshotError` 文案区＋新增 `retiredApiFundingSnapshotFieldsError`（AFR-01/R1）；WP3 若扩展资源响应 contract 需避开该区域。
  3. `apps/control-api/src/operating-bills/routes.ts`——WP2 改 8 行；WP3 不计划触碰。
- 语义交叉：runner 充值依赖解除依赖 WP2 已落地事实（充值写入口 410、0094 去 0081 种入触发器），解除后 `resource_purchase_record` 不再有新 API_RECHARGE 流入——`needsPostRechargeSync` 删除安全，无 WP2 文件改动需求。finance mode 读取解除只动 provider-operating-sync runner，不碰 subscription-renewal（:6-7）与 control-api server.ts:195 的 mode 门控。

---

## §10 S2-S5 实施建议汇总（供总指挥定 S2 合同）

**S2＝3.1（runner 解耦＋周期调度）** 顺序：
1. `packages/config/src/index.ts`：新增 P1/P2 读取器（readProviderFinanceMode 模式，:35-39；整数复用 readPositiveIntEnv :166-179）＋对应 config.test.ts 用例。
2. `apps/worker/src/provider-operating-sync/runner.ts`：删 `financeModeInactiveSkip`（:120-128）与 :133-135 短路；删 `needsPostRechargeSync`（:53-75）；`shouldSkipDailySync`（:77-87）改为基于 attempt `next_sync_at`（语义改 P1）的周期门禁；`nextSyncAt`（:143/:250）改 `now+P1`。保留 §1a/1c 全部行为清单。
3. `apps/worker/src/main.ts`：无需改调度注册（core 槽位已在 :333-336）；如需把 interval 默认值文档化改 :251 邻域注释。
4. 测试：runner.test.ts 改写门禁用例（新增周期门禁用例＋保留恢复/失败/静默断言）；config.test.ts。
**注意**：本阶段 attempt 仍每日一行，周期门禁只能实现"每 15 分钟尝试一次"的上界受 daily_uq 限制——若 S2 就要真 15min 周期，须把 0095（drop daily_uq）提前到 S2，否则 P1 实际生效为"每日首次 tick"。建议总指挥裁定 0095 归属（S2 提前 or S3 与刷新同批；合同初定 S3）。

**S3＝3.2（0095＋手动刷新端点＋运维文档）**：
1. `packages/database/migrations/0095_*.js`：drop `provider_resource_operating_sync_attempt_daily_uq`（down 重建＋多行守卫）＋（建议）新建 refresh 请求表（0073 模板：部分唯一 RUNNING 索引＋retry_at＋幂等键＋expires_at）；0026/0051 本体零改动。
2. runner.ts：去掉 insert `onConflict`（:254）；`shanghaiSyncDay`（:35-40）仅保留作 attempt 分组字段或改弃（评估 attempt latest_idx :71-75 查询路径）。
3. `packages/database/src/repositories/provider-operating-repository.ts`：补共享 attempt 写入原语（供 control-api 复用）；新 refresh 请求 repo（credential-chat-probe.ts:38-93 为模板）。
4. `apps/control-api/src/providers/`（新文件或 quota-window-routes.ts 同款新注册）：`POST /provider-resources/:id/official-balance/refresh`，requireAuth（自动 resources.operate），begin（ACCEPTED/IN_PROGRESS/COOLDOWN＋retry_after_seconds）→进程内 `queryProviderOperatingBalance`→写快照/attempt→finish＋审计（仿 quota-sync :88-98）；凭证不下发。
5. 测试：control-api http 集成（成功/冷却/在途/403/资源不存在）；0095 迁移正反。
6. 运维文档：周期/冷却/触发方式（env 名）。

**S4＝3.3（状态读取完整化）**：
1. `provider-operating-repository.ts`：新增 official balance 状态读取函数（§4 字段表；source 过滤＋P2 时效＋attempt join）。
2. `apps/control-api/src/providers/routes.ts` 列表响应（:241-310）挂 C2 字段；contracts.ts 如需 schema 扩展，避开 WP2 守卫区。
3. 失败保旧值＋EXPIRED 叠加为读侧派生；可控时钟测试（数据库层注入 now）。
**S5＝3.4（恢复链回归＋预测时效）**：
1. 恢复链零改动，仅回归 runner.test.ts＋resource-lifecycle.test.ts。
2. `supply-forecast-repository.ts`：读入点筛 `source='PROVIDER_SYNC'`（:51 处或官方变体）＋P2 过期→`not_calculable_reason`（:136）；resource-insights/query.ts:296 硬编码 15min 换 P2 配置（评估是否本包范围——涉及 insights 展示口径，建议 S5 一并处理或显式移交 WP4）。
3. 测试：预测时效用例（过期→不可计算/待更新）、来源不合格（ADMIN 快照不进预测）用例。

**通用红线提醒**：0026/0051 表本体不重写（只允许 0095 加性/索引调整）；`recordBalanceSyncRecovery`（resource-pool-repository.ts:252-273）与其证据约束逐字不动；订阅续订 runner.ts:6-7 fail-closed 不动；strict_writes/:443/:451 不动；不动 WP2 410/0094/退役合同。
