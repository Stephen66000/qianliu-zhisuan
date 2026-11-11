# WP2-S6 回执：使用控制与套餐回归电池＋跨月/续订后端＋全量复跑（task 4.4，AFR-03/04/05＋AT-X04）

日期：2026-11-03；执行：glm-flash 子 Agent（WP2-S6）。基线：worktree `/Users/mac/Projects/仟流智算-api-decouple`，分支 `codex/simplify-api-cost-and-official-balance`，开工 `git status` 核对 S2-S5 产物在位（0094、resource-pool-repository、routes/events/activation 系列、wp2-pending-admission、wp2-finance-mode-parity 等未回退）。**生产代码零改动；既有测试文件零改动**（S6 仅新增 2 个测试文件＋合同文档追加 §6＋本回执）。

## 1. 新增用例清单（文件 × 用例 × 对应验收项）

### `apps/gateway/src/__tests-integration__/wp2-admission-gates.test.ts`（新增，9 用例；构造模式复用 cpqw-quota-window：buildGateway＋createRealPipeline＋生产形态 listCandidates（main.ts:67-68 同构过滤）＋调用记录 caller）

| # | 用例 | 对应 |
|---|---|---|
| 1 | AT-AFR-09：员工月额度不足＋禁止超额，快照正余额（账户有钱）仍按额度合同拒绝，原因在额度域，零上游 | AT-AFR-09／AFR-05 场景1／AT-X04 |
| 2 | AT-AFR-10：允许超额授权放行，真实用量与超额继续计量，授权配置不被清零/改写 | AT-AFR-10／AFR-05 场景2 |
| 3 | Key 限制：allowed_model_ids 不含目标模型 → 403 model_not_allowed，零账本事实零上游 | AT-X04（Key） |
| 4 | 项目限制：项目授权停用（grant DISABLED）→ 403 principal_grant_required，零上游 | AT-X04（项目） |
| 5 | CPQW 套餐窗口耗尽（对照项）：quota_block_state 活跃 → 不进可服务集合，手改 status 不放行 | AT-X04（套餐窗口）/AFR-05 |
| 6 | 人工停用（归档）：资源不进候选 → 404 model_not_configured，零上游 | AT-X04（人工停用） |
| 7 | 凭证无效：CREDENTIAL_INVALID 隔离拒绝、503 零上游；额度同步不可解除凭证隔离 | AT-X04（凭证无效）/AT-AFR-06 延伸 |
| 8 | 真实 EXHAUSTED：隔离拒绝零上游；解除仍按原合同恢复路径（额度同步/管理恢复 → DEGRADED） | AT-X04（真实耗尽） |
| 9 | 纯 API 资金 PENDING 不阻断（对照项）：存量 PENDING 留档行资源可服务 | AT-X04"只有纯 API 资金 PENDING 不再阻断" |

关键断言摘录（用例 1）：资源带 ADMIN 源正余额经营快照（recharge 100/current_balance 88.88）且在可服务集合内 → 429 `provider_quota_exhausted`、`message` 含"额度已用完"且**不含**"余额"、`next_reset_at`＝DB `principal_quota_period.period_end`（月度周期合同）、period used/reserved 均 0、`upstream_attempt` 零行、ledger_line 零行（该主体域）。

### `packages/database/src/__tests-integration__/wp2-cross-month-attribution.integration.test.ts`（新增，3 用例）

| # | 用例 | 对应 |
|---|---|---|
| 10 | 估算按 settled_at 归月：11-30 23:59 与 12-01 00:02（上海）结算分列 11/12 月（各自 KNOWN_COMPLETE、金额精确分列、无缺口），企业无任何 provider_finance_event/finance_state 行 | AT-AFR-07／AFR-03 |
| 11 | 员工额度按既有预占月合同：23:59 预占、00:02 结算仍归 11 月周期（SETTLED/actual=1200/settled_at=00:02）；新月预占开 12 月周期（period_key/timezone Asia/Shanghai） | AT-AFR-07／AT-ACE-12 员工侧 |
| 12 | API 无期初的已激活企业：CP 订阅到期 → runSubscriptionAutoRenewals（Worker 同款入口，模拟时间）正常执行：SYSTEM_RENEWAL 事件＋RENEWAL 周期（模板日历顺延）、开关与模板周期行不变、重复 tick 幂等（created 1→0）、全程仅 CODING_PLAN_* 事件 | AT-AFR-08／AFR-04 |

## 2. 既有锚点引用表（免重复造的项＋依据）

| 项 | 既有锚点（本轮回跑全绿） | S6 处置 |
|---|---|---|
| CPQW 窗口管线语义（:443） | `cpqw-quota-window.test.ts:280/:319/:351`＋DB `quota-block-repository.integration.test.ts`/`quota-block-transaction-faults.integration.test.ts` | 不重复造重型夹具；仅 DB 层对照项（电池用例 5） |
| 准入状态机（:451 evaluateAdmission） | `w11-resource-pool.test.ts:74/:106/:146/:264/:282/:315` | 电池用例 6/7/8 以 HTTP 管线路径补独立断言（S2 wp2-pending-admission 为 DB 层锚点） |
| 纯 PENDING 准入解除 | `wp2-pending-admission.test.ts` (a)(b)(c) | 对照项（电池用例 9） |
| 员工额度禁/允超额 | gateway `employee-monthly-quota.test.ts:45`＋DB `employee-monthly-quota.integration.test.ts:233` | 电池用例 1/2 补"快照正余额"与"配置不被改写"维度 |
| 跨月额度归月（管线） | `employee-monthly-quota.test.ts:81`（failover 双 attempt 归月） | 电池用例 10/11 补估算 settled_at 归月（该维度全仓无既有用例，已核查 api-cost-estimation/peak-calendar/readers-alignment）＋repo 级预占月合同 |
| 续订机制 | DB `subscription-auto-renewal.integration.test.ts`（10/10 绿）＋worker `subscription-renewal/runner.test.ts`（3/3 绿，OFF/DARK 门控） | 电池用例 12 补"API 无期初"显式前置（既有夹具含该条件但未显式断言） |
| 员工月度额度（0092）初始化/时区 | DB `employee-monthly-quota.integration.test.ts:186/:507/:581` | 引用（未重复） |

## 3. 全量复跑：命令 × 退出码 × 用例数 × 失败归因

| # | 命令 | 退出码 | 结果 |
|---|---|---|---|
| 1 | gateway `test:integration` | **0** | **31 files / 250 tests 全绿**（含新增 wp2-admission-gates 9 例；S5 基线 30/241 → 新增 1 文件 9 例） |
| 2 | database `test:integration` | **1** | **569/570**（77 files，1 failed）——唯一失败＝`w20-standard-capacity` P95 断言（1722ms>1000ms），见命令 3 隔离裁定 |
| 3 | database 隔离复跑 `w20-standard-capacity.integration.test.ts` | **0** | **2/2 绿**——全量失败为并发负载型既有 flake（与 S2 回执 §4.2、S5 回执 §4 同源记录一致；本轮全量跑同期在跑 380s 的 usage-aggregate-migration-capacity 百万行用例）；非回归，不重复大套件 |
| 4 | control-api `test` | **0** | **65 files / 475 tests 全绿** |
| 5 | control-api `test:integration` | **0** | **42 files / 352 tests 全绿** |
| 6 | domain `test` | **0** | **22 files / 409 tests 全绿** |
| 7 | worker `test` | **0** | **36 files / 199 tests 全绿** |
| 8 | gateway typecheck＋lint | 0 / 0 | 通过 |
| 9 | database typecheck＋lint | 0 / 0 | 通过 |
| 10 | control-api typecheck＋lint | 0 / 0 | 通过 |
| 11 | domain typecheck＋lint | 0 / 0 | 通过 |
| 12 | `OPENSPEC_TELEMETRY=0 openspec validate simplify-api-cost-and-official-balance --strict --no-interactive` | **0** | "Change 'simplify-api-cost-and-official-balance' is valid"（文档层校验，仅记录） |

已知既有 flake 裁定：`employee-monthly-quota`（负载期）本轮全量跑中 gateway/database 均未复现（gateway 全量 250/250 含该文件 20 例）；`w20 P95` 按合同隔离复跑裁定（见命令 3）。所有计数非零（规避 `passWithNoTests:true` 陷阱）。运行日志：`/tmp/wp2s6-gw-full.log`、`/tmp/wp2s6-db-full.log`、`/tmp/wp2s6-ca-unit.log`、`/tmp/wp2s6-ca-int.log`、`/tmp/wp2s6-domain.log`、`/tmp/wp2s6-worker.log`。

## 4. 发现的缺陷/合同表述冲突（报裁定，未自行修）

1. **【表述冲突，非缺陷】"真实 EXHAUSTED：adminRecover 拒绝"与现行 repo 语义不符**：委派合同写"EXHAUSTED 隔离 → 拒绝且 adminRecover 拒绝（w11 锚点语义）"，但现行代码中 `adminRecover` 仅对 `CREDENTIAL_INVALID`（resource-pool-repository.ts:363-365 特判）与非隔离态（`deriveAdminRecovery`，domain resource-lifecycle.ts:360-369）拒绝；**EXHAUSTED 属隔离态，adminRecover 成功产出 DEGRADED/ADMIN_RECOVER**，与 w11 :264（EXPIRED 可 adminRecover）、:282（EXHAUSTED 额度同步恢复 DEGRADED）及验收计划 AT-OAB-12"可按现有流程解除耗尽隔离并等待真实调用确认"一致。电池用例 8 按**原合同回归**断言现状（隔离拒绝零上游＋额度同步/管理恢复→DEGRADED），未按合同字面写反断言（写了必失败）。请总指挥裁定合同措辞更正或确认语义。
2. **【机制映射说明，非缺陷】"资源 DISABLED"不存在该状态值**：`provider_resource.status` CHECK（0005/0031）仅含 ACTIVE/DEGRADED/EXHAUSTED/EXPIRED/CREDENTIAL_INVALID/RATE_LIMITED/UNAVAILABLE；资源级人工停用的现役机制＝**归档**（POST /provider-resources/:id/archive → `archived_at`，providers/routes.ts:206；生产候选查询 main.ts:67-68 排除）。电池用例 6 按实际机制构造并断言 404 model_not_configured＋零上游。
3. **【机制说明，非缺陷】"项目限制"按实际机制构造**：项目主体无 0092 月度域（仅 EMPLOYEE），现役门禁＝主体授权（principal_grant 状态/有效期 → 403 principal_grant_required）＋legacy `quota_counter` 配额（w14 锚点）；API 模式 LEGACY 路径不预占 Token（w18 F-01-5 既有语义）。电池用例 4 构造 grant DISABLED 路径，不确定点已按合同要求标注于此。
4. **【全量复跑副作用，观察项】worker reporting 测试重写既有证据工件**：跑 worker `test` 时 `apps/worker/src/reporting/__tests__/{quota-preflight,report-facts,report-layout-preview}.*` 会把合成预检结果重写回 `V4/Evidence/EMPLOYEE-QUOTA-REPORTING-20261101/reporting/`（3 个文件：2 个 png/svg 二进制重渲染＋2 个 json 内随机 UUID 变化）——属该套件设计内输出行为，非本包改动；是否回置由总指挥裁定（本 Agent 未做任何 git 写操作）。
5. 无新发现的生产代码缺陷：AT-X04 各门禁、AT-AFR-07/08 后端在 S2-S5 产物之上全部按原合同回归通过。

## 5. 剩余问题

1. 合同表述冲突（§4.1）待裁定；如需改电池用例 8 断言方向，待指令。
2. AT-AFR-07 的浏览器/页面部分、AT-AFR-08 的 HTTP/浏览器部分（acceptance-plan §5 标注 F09 多层）不在本包——S6 仅覆盖后端机制层，未填 PASS。
3. WP4 展示域遗留（S5 已记录）：resource-insights/routes.ts:232 兜底串等，不在 S6 范围。

## 6. 证据路径

- 本回执：`V4/Evidence/API-COST-OFFICIAL-BALANCE/WP2-20261103/s6-receipt.md`
- 新增测试：`apps/gateway/src/__tests-integration__/wp2-admission-gates.test.ts`（9 例）、`packages/database/src/__tests-integration__/wp2-cross-month-attribution.integration.test.ts`（3 例）
- 接口说明：`openspec/changes/simplify-api-cost-and-official-balance/handoff/work-packages/WP2/retired-api-funding-contract.md` §6"使用控制保留说明"（9 项，每项机制锚点 file:line＋回归证据）
- 运行日志（本机临时）：`/tmp/wp2s6-*.log`（关键计数摘录见 §3）
