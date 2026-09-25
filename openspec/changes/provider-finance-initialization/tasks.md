# Implementation Tasks: 资金账本初始化与严格资金写激活

> 当前状态：`IMPLEMENTATION_AUTHORIZED (tasks 0.2 + WP01～WP08)` — 由 Codex 于 2026-09-21 授权（逐包放行），
> WP06 于 2026-09-22 授权（6.1/6.2/6.4），WP07 于 2026-09-22 授权（6.3，含写入侧最小修复），
> WP08 于 2026-09-22 授权且**仅限本地部署候选验证**（7.1～7.3）。
> Phase 0.1、Phase 1（1.1～1.5）、Phase 2（2.1～2.4）、Phase 3（3.1～3.5）、Phase 4（4.1～4.6）、
> Phase 5（5.1～5.5）、Phase 6（6.1／6.2／6.3／6.4）已按本文件勾选标准完成并附证据；
> 6.1 曾因「`40P01` 未实际注入」被复核 HOLD，已于 2026-09-22 最小补齐（仅改测试）并闭环；
> 6.3 首次执行为 **NO-GO**（发现阻断缺陷 D-1：`MIGRATED` 旧记录被新旧账本重复计入），
> 已按授权在**写入侧**做最小修复（未动四处聚合读模型、未新增迁移）并全量回归后收敛为 **GO**；
> Phase 7（7.1／7.2／7.3）已在本地不可变候选上完成部署候选验证并收敛为 **GO**；
> 但 **P 系列（真实部署、生产库迁移/备份、生产金额录入、生产激活）仍未授权**，不得由 `/apply` 或任何脚本自动执行。

## Phase 0: Authorization and Candidate Baseline

- [x] **0.1 完成 OpenSpec 计划审查**
  - 审查 proposal、三组 delta specs、design 和 tasks（WP00 只读基线审查）。
  - 确认每个任务均可追溯到 Requirement/Scenario。
  - 记录 `PLAN_APPROVED` 回执：Codex 授权 tasks 0.2 + WP01，并给出覆盖性技术裁决
    （基线改锚 `ca533e3`、首迁移 `0078`、legacy→v1 锁序、PFH-07 独立状态表、`0076` 草稿作废）。

- [x] **0.2 创建独立实现 worktree**
  - 仅在收到 `IMPLEMENTATION_AUTHORIZED` 后执行。
  - 记录基线提交、分支、迁移头、dirty 文件归属和工具版本。
  - 基线提交 `ca533e3d790270f2a33b15de73e3417ab8656b76`（Kimi 干净终态；代码 `ac1c6de`）。
  - 分支 `codex/provider-finance-initialization-20260921`，worktree `/Users/mac/Projects/仟流智算-provider-finance-init-20260921`。
  - 起始迁移头 `0077_provider_model_probe_run_identity.js`；原脏工作区 `/Users/mac/Projects/仟流智算` 未改动。
  - 工具版本：node v22.22.2、corepack pnpm@11.11.0、Postgres testcontainer `postgres:17-alpine@sha256:742f40ea…`。
  - `ca533e3` 仅为 development base；WP07 前必须重基于 Kimi 验收后的精确提交并重跑迁移与回归。

## Phase 1: Contracts and Persistence

- [x] **1.1 定义激活领域合同**（PFA-01～PFA-03、PFA-09、PFH-01～PFH-05）
  - 定义完整草稿、旧记录关闭决定、结构化缺口、投影、事实水位和激活回执类型。
  - 金额、日期、证据和数组上限使用 Zod 严格校验。
  - 证据：`apps/control-api/src/provider-finance/activation-contracts.ts`（`ActivationDraftSchema` 严格模式、
    数组上限 500、`.strict()` 拒绝未知字段，故 body 不接受 `enterprise_id`/`admin_id`）；
    `packages/domain/src/provider-finance-activation.ts` 类型面。`activation-contracts.test.ts` 9 项通过。

- [x] **1.2 实现稳定规范化与哈希**（PFA-03）
  - 金额精度、UTC/上海边界、空值和数组排序规范化。
  - 增加顺序无关、金额等价和字段变化测试。
  - 证据：`packages/domain/src/provider-finance-activation.ts`（`normalizeAccountAmount` 8 位小数、
    `normalizeCashPaidCny` 2 位小数、`shanghaiPeriodBounds`、`computeCandidateHash` 排除 UI/身份/幂等字段）。
    `packages/domain/src/__tests__/provider-finance-activation.test.ts` 18 项通过（含顺序无关与金额等价）。

- [x] **1.3 增加企业级候选和激活幂等持久化**（PFA-03、PFA-06）
  - 新增迁移、Kysely 类型、不可变约束和回滚保护。
  - 候选 TTL 固定 30 分钟，状态不包含持久化 `ACTIVATING`。
  - 保存固定修复行主键、允许字段和逐行非目标基准哈希。
  - 确保候选不进入资金与经营账单读取。
  - 证据：迁移 `packages/database/migrations/0078_provider_finance_activation.js`
    （sha256 `d6b9d8854eca6ff36231a3d6b7b848d94c12aa49134aedc0e56d6e00f10bf3fa`）：
    `provider_finance_activation_attempt` 含 TTL 表达式约束、状态 CHECK（无 `ACTIVATING`）、
    `provider_finance_activation_attempt_guard` 触发器（终态不可改、ACTIVATED 不可删）、
    幂等键局部唯一索引；`down()` 在存在激活事实或资源资金状态时拒绝回退。
    仓储 `provider-finance-activation-repository.ts`；集成测试 5 项通过。

- [x] **1.4 加固现有期初合同**（PFH-01、PFH-06、PFH-07）
  - 说明和证据必填。
  - 封闭企业初始化旁路并定义未来资源启用边界。
  - 证据：`contracts.ts` 的 `Common` 要求 `description` 与 `evidence_ref` 非空（PFH-06 原文：
    “强制期初、历史充值、购买、续费和拒绝旧记录具备说明与证据引用，不得由兼容接口绕过”）；
    期初入口校验 `provider_resource_finance_state`，企业级资源返回 409 `resource_finance_scope_conflict`、
    已就绪返回 409 `resource_finance_already_ready`；
    `packages/database/src/cli/provider-finance-activate.ts` 改为失败关闭（exit 2），不再直连 `activateStrictWrites`。
  - 客户端合同断链已收口（复核裁决 F-1，不得推迟到 WP05）：`ProviderFinancePanel.tsx` 日常 API 充值与
    Coding Plan 购买/续费新增“说明”“证据引用”必填校验并如实提交 payload；
    `ProviderFinancePanel.test.tsx`、`Resources.test.tsx` 改为断言完整 payload（不再仅用 `objectContaining` 漏检），
    并新增“缺少说明/证据时阻止提交”的负向用例。仅改现有日常表单，未提前开发初始化向导。

- [x] **1.5 增加企业级静默租约持久化**（PFA-09）
  - 租约最长 60 分钟，记录开始、到期、解除与管理员审计。
  - Gateway/Worker 依据服务端时间自动忽略过期租约。
  - 证据：`provider_finance_activation_quiescence` 表（窗口 CHECK `expires_at <= started_at + 60min`）；
    `startQuiescenceLease`/`releaseQuiescenceLease`/`evaluateQuiescence`/`collectDrainReport`；
    释放要求租约仍为 ACTIVE 且未过期（过期后更新 0 行即抛错）；
    `provider_resource_finance_state` 表 + 种子触发器，`listServableResources` 以 LEFT JOIN 排除 `PENDING`。

## Phase 2: Read-only Projection and Watermark

- [x] **2.1 实现激活范围加载器**（PFA-01）
  - API 资源、在用 Coding Plan、必要币种账户和事实窗口。
  - 覆盖新增、删除、改模式和改状态场景。
  - 证据：`packages/database/src/repositories/provider-finance-activation-facts.ts` 的
    `loadActivationScope`：排除 `DELETED`，登记在用 Coding Plan（切换后 ledger_line / 跨切换快照 /
    切换后购买 / 候选标记）与必要币种账户（切换前快照、资金事件、已定价用量、历史充值四类来源），
    事实窗口为切换时点至 `snapshot_at` 的上海自然月；模式/状态/时点不匹配在投影层失败关闭
    （`RESOURCE_MODE_MISMATCH`、`OPENING_TIME_MISMATCH`、`UNKNOWN_RESOURCE`）。
    集成测试 `provider-finance-activation-preview.integration.test.ts` 断言资源与 CNY 账户纳入范围。

- [x] **2.2 实现完整事实水位**（PFA-01、PFA-03）
  - 覆盖资源、快照、购买、资金、周期、用量、计价和运行状态。
  - 使用稳定集合摘要，不依赖单一 `updated_at`。
  - 证据：`buildFactWatermark` + `FACT_WATERMARK_SECTIONS` 共十段（provider_resource、
    provider_resource_operating_snapshot、resource_purchase_record、provider_finance_event、
    provider_subscription_period、provider_finance_legacy_cost_resolution、ledger_line、
    usage_event、billing_rule、provider_finance_runtime_state），每段 `count` + 全字段 `ORDER BY id`
    的稳定集合摘要，再合成总哈希；与「历史修复固定行集」（domain `usageRepairFieldDigests`）
    分为两个独立合同。集成测试验证重复构建得到同一摘要、新增 `ledger_line` 只令 `ledger_line`
    分段失效并使总哈希变化（其余分段摘要不变）。

- [x] **2.3 实现候选假设投影**（PFA-02、PFH-01～PFH-05）
  - 虚拟期初、历史充值、购买、周期和旧记录关闭。
  - 预检不写资金表、不写周期、不改 `ledger_line`。
  - 只读事务提交后，再由独立控制事务保存候选元数据。
  - 抽取并复用既有余额聚合函数，不重写冲销符号。
  - 证据：`packages/domain/src/provider-finance-activation-projection.ts` 纯投影
    （虚拟期初/充值、`draft:<key>` 虚拟周期、旧记录 MIGRATED/ALREADY_REPRESENTED/REJECTED 关闭）；
    `ProviderFinanceActivationPreviewRepository.buildCandidateProjection` 在
    `REPEATABLE READ` + `SET TRANSACTION READ ONLY` 内执行且零写入；
    `previewActivation` 仅在只读事务提交后由独立短控制事务调用 `recordPreviewCandidate`（TTL 30 分钟）。
    余额公式唯一实现抽取为 `packages/domain/src/provider-finance-balance-components.ts`，
    由 domain 投影、`provider-finance-balances.ts`、`provider-finance-cutover-repository.ts`
    共同复用，后者不再自写 `.plus/.minus` 冲销链。集成测试证明只读零写入、READ ONLY 由
    数据库以 `25006` 强制、候选仅在控制事务落库。

- [x] **2.4 实现完整窗口守恒**（PFH-05）
  - 切换时点至候选水位，覆盖所有涉及月份。
  - 资金、Token、周期归属和经营账单守恒。
  - 证据：`conservationMonths` 从切换时点起算、末月按候选水位截断；`projectAccountBalances`
    用共享公式累加虚拟事实并校验负余额与公式一致性（`formulaMatches`）；
    `collectUsageClassificationGaps` 逐行比对 Usage/Ledger Token；套餐用量唯一归属
    （`OVERLAPPING_PERIOD`/`UNATTRIBUTED_PLAN_USAGE`）；经营账单缺口以 SQL `countFinanceGaps`
    为权威口径并做草稿/修复增量抵消（`computeMonthlyGapDeltas`）。
    domain 单测覆盖跨月一月失败则整体 NO_GO、负余额、UNKNOWN_COST、周期歧义、输入顺序与
    候选哈希稳定性、固定修复行集与非目标哈希。

## Phase 3: Transaction-aware Primitives and Activation

- [x] **3.1 抽取 Tx 资金写入原语**（PFA-04、PFH-01～PFH-03）
  - 期初、充值、订阅、跨切换周期、旧记录关闭和审计均接受同一 `trx`。
  - 日常公开方法复用原语且保持现有合同。
  - 证据：`packages/database/src/repositories/provider-finance-activation-writes.ts` 提供
    `insertFinanceEventTx`/`insertOpeningBalanceTx`/`insertRechargeTx`/`insertSubscriptionTx`/
    `insertCarryoverPeriodTx`/`closeLegacyPurchaseTx`/`writeActivationAuditTx` 七个纯 Tx 原语，
    自身一律不开事务；`provider-finance-events.ts`（期初/充值/订阅/冲销/更正）与
    `provider-finance-renewal.ts`（自动续订）改为委托原语，公开签名与既有合同不变。
    期初强制 `PROVIDER_FINANCE_CUTOVER` 且不写 `cash_paid_cny`；订阅原语校验上海零点边界、
    同自然日扣费与金额符号；跨切换周期用 `source='MIGRATED_CARRYOVER'`、`finance_event_id=NULL`；
    旧记录关闭只写不可变 `operation_log` 审计（`target_type='resource_purchase_record'`、
    `target_id=旧记录 id`、`change_summary` 记录 `resolution`/`migrated_event_id`/`external_reference`）。
    既有 6 个资金集成套件与 83 个资金/账单单测全绿，证明 3.1 重构零回归。

- [x] **3.2 实现四字段历史用量修复原语**（PFH-04）
  - 仅允许 `settled_at`、`api_cost_currency`、`api_cost_status`、`subscription_period_id`。
  - 只锁定候选记录且按 ID 排序的资格行，逐行验证非目标字段哈希。
  - 新增行不进入原候选修复哈希，但受事实水位和静默门禁约束。
  - 证据：`packages/database/src/repositories/provider-finance-usage-repairs.ts` 的
    `applyUsageRepairsTx` 只写 `USAGE_REPAIR_FIELDS` 四列（`narrowCostStatus` 校验枚举），
    先按 `targets` 排序、以 `loadLedgerLines({ledgerLineIds, forUpdate:true})`
    按主键升序 `FOR UPDATE` 锁定固定行集，再逐行比对候选基准
    `nonTargetFieldsBeforeHash`，写后复验非目标哈希；任何不一致抛 `CANDIDATE_STALE` 整体回滚。
    候选之后新增的行不计入修复集合，只作为 `newRowsAfterPreview` 上报并改变完整事实水位。

- [x] **3.3 实现企业级原子激活协调器**（PFA-04、PFA-05）
  - `SERIALIZABLE`、固定 64 位命名空间 `pg_try_advisory_xact_lock`、候选复验和完整回滚。
  - 守恒成功后才写 `strict_writes_enabled=true`。
  - `PREVIEWED → ACTIVATED` 在主事务内原子完成，不提交 `ACTIVATING`。
  - 在事务执行边界外映射 `40001/40P01`，任何层不得自动重试。
  - 证据：`packages/database/src/repositories/provider-finance-activation-coordinator.ts`
    以唯一一个 `SERIALIZABLE` 事务承载 13 步顺序：会话企业二次确认 → 先 `try` legacy
    命名空间锁、再 `try` `hashtextextended('qianliu:provider-finance-activation:v1:'||id,0)`
    锁（任一失败立即 `409 ACTIVATION_IN_PROGRESS`，`retryable=true`，不等待）→ 幂等重放 →
    `FOR UPDATE` 锁候选并校验状态/TTL/哈希/GO/未激活 → 静默租约有效且剩余 ≥5 分钟 →
    锁内重算事实水位与候选哈希 → 排空门禁（`assertDrained`）→ 写期初/充值/购买/跨切换周期 →
    关闭旧记录 → 四字段修复 → 以空草稿对真实事实重跑完整窗口守恒 → 写 `strict_writes_enabled`、
    范围 API 资源 READY、`PREVIEWED→ACTIVATED` 与不可变回执 + 审计 → 提交。
    任一步失败整体回滚，全程不写 `ACTIVATING`；`mapActivationFailure` 在
    `transaction.execute` 之外把 `40001/40P01` 映射为 `409 ACTIVATION_RETRY_REQUIRED` 且零重试。

- [x] **3.4 实现企业级幂等和终态冲突**（PFA-06）
  - 同键同候选重放；同键不同候选冲突；已激活不同请求冲突。
  - 证据：`replayActivation` 命中同键同候选的 `ACTIVATED` 记录时只重放首次回执
    （`replayed=true`，不产生第二组事实）；同键但候选 id 或候选哈希不同抛
    `IDEMPOTENCY_CONFLICT`；已存在 `ACTIVATED` 候选或 `strict_writes_enabled=true`
    时抛 `ALREADY_ACTIVATED`。
    集成测试 `packages/database/src/__tests-integration__/provider-finance-activation-apply.integration.test.ts`
    13 组用例覆盖：激活成功与同键重放、两类幂等/终态冲突、双管理员并发、legacy 与 v1 锁互斥、
    静默未就绪（无租约/剩余不足 5 分钟/企业内存在非候选的未结算行/在途请求）、
    排空豁免边界（候选已冻结的切换后未结算可修复行可通过并在同一事务修复；在途请求与未结束
    Attempt 即使存在对应固定行也不豁免）、预检后新增的同形状行与新行都被挡下且不被修复、
    候选过期与水位漂移/草稿篡改、固定行集冻结与新增行不被吸收、
    允许字段直测（settled_at 可修复 + 非目标字段哈希拦截）、中途故障零写入与进程提交前退出、
    `40001/40P01` 语句与提交边界映射、Coding Plan 购买与跨切换周期唯一归属及旧记录 `MIGRATED`
    关闭不可变映射。

- [x] **3.5 复核收口：排空门禁的候选冻结行豁免**（PFA-09、PFH-04）
  - 复核结论：若候选已冻结且将在同一事务内确定性修复的 `ledger_line` 仍被排空门禁一律
    计为「未结算/未分类」，四字段修复主路径在生产不可达，违反 PFH-04，WP03 暂时 HOLD。
  - `collectDrainReport` 增加 `options.excludeLedgerLineIds`，**只**从 `unpairedUsageLines`
    一个计数中排除这些 ID；`IN_PROGRESS` 请求、未结束 `upstream_attempt`、`PENDING` 交易
    永不豁免。新增 `exoneratedUsageLines` 让豁免数量可审计。
  - 豁免集严格等于候选存档的 `usage_repair_baseline`，且排空门禁移到候选复验之后
    （候选已 `FOR UPDATE` 锁定、GO/TTL/候选哈希/完整事实水位均已验证），
    因此非候选行与预检后新增行拿不到豁免。
  - 证据：`provider-finance-activation-repository.ts` 的 `collectDrainReport`、
    协调器的 `assertDrained`（步骤 7）；集成用例见 3.4 所列第 6、7 组。
    另收口 `operating-snapshot-subscription-period-migration.integration.test.ts` 的硬编码
    回滚头：改用既有 `rollbackTo(db, "0064_quota_pricing_and_policy_archive")` 以目标迁移
    而非当时的迁移头作为锚点（同类收口见 WP02）。

## Phase 4: Control API

- [x] **4.1 实现 activation-state**（PFU-01、PFU-03、PFU-06）
  - 返回运行模式、严格状态、切换时点、范围与必需账号摘要、静默租约、最近候选元数据和激活回执。
  - 只读管理员（`resources.view`）可读；写路径在 `DARK` 模式返回 404（`requireWriteEntry`）。
  - 证据：`apps/control-api/src/provider-finance/activation-routes.ts` 的 `GET /provider-finance/activation-state`
    只暴露候选元数据（id/哈希/事实水位/状态/TTL/缺口与投影摘要**计数**），
    `candidateMetadata`/`scopeSummary`/`drainView`/`quiescenceView` 均做脱敏。
    集成用例断言响应体**不含** `candidate_draft`、`usage_repair_baseline`，
    也不含库中候选行确实存在的证据标记 `evidence://pf04-secret-marker` 与金额 `137.42`。

- [x] **4.2 实现 activation-preview**（PFA-02、PFA-03、PFA-07）
  - 严格 schema，**只**接受业务草稿；不接收可被会话覆盖的 `enterprise_id`/`admin_id`。
  - 先验有效静默租约与排空，再调用 WP02 只读投影，从会话取企业/管理员。
  - 证据：请求体携带 `enterprise_id`/`admin_id` 或未知键一律 `400 invalid_request`；
    证据引用缺失 → 400 `invalid_request`，空串/纯空白 → 400（匹配 `/证据/`）；
    只读管理员 403；租约不足（240s）409；有效租约 201 并返回候选、事实水位、有效期与结构化缺口。

- [x] **4.3 实现 activate**（PFA-04～PFA-07、PFA-09）
  - 只接受 `candidate_id`/`candidate_hash`/`idempotency_key`/`confirm_enterprise_id`；
    权威企业与管理员一律取自 `req.admin`；委派 WP03 协调器，控制面不重复实现事务。
  - 完整映射 `CANDIDATE_EXPIRED`/`CANDIDATE_STALE`、`ACTIVATION_IN_PROGRESS`/`ACTIVATION_NOT_QUIESCENT`、
    `IDEMPOTENCY_CONFLICT`、`ALREADY_ACTIVATED`、`ACTIVATION_RETRY_REQUIRED`（409 + `retryable=true`）；
    **任何层不得自动重试**。
  - 证据：成功激活 + 同键重放（不产生第二组事实）+ `ALREADY_ACTIVATED` 409 + 事实校验
    （1 条期初、资源状态 `READY`）；404 `CANDIDATE_NOT_FOUND`；`CANDIDATE_EXPIRED`/`CANDIDATE_STALE`
    409 且**零写入**；`IDEMPOTENCY_CONFLICT` 409；`ACTIVATION_IN_PROGRESS` 409 `retryable=true`
    （legacy 命名空间锁被持有）；`ACTIVATION_RETRY_REQUIRED` 409 `retryable=true`
    （提交边界 `40001`，DEFERRABLE 触发器）且零写入、随后可恢复。

- [x] **4.4 API 安全与审计测试**（PFA-07、PFU-06）
  - 沿用既有 CSRF/会话/权限门禁：跨企业、伪造身份、只读管理员写入、候选企业不匹配一律失败关闭，
    并写非敏感失败审计。
  - 证据：`apps/control-api/src/__tests-integration__/provider-finance-activation.http.test.ts`
    13 组用例覆盖：未认证/伪造会话 401；跨企业两种形态（`confirm_enterprise_id` 指向他人 →
    404 候选不可见；指向本企业但与会话企业不符 → 409 `SESSION_ENTERPRISE_MISMATCH`，
    且该检查先于候选查询）；只读管理员读取 200 / 写入 403；跨站 `forbidden_origin` 403
    与同源 201（GET 不受 CSRF 约束）；失败审计 `writeActivationFailureAudit` 只落
    `code`/`candidate_id`/`retryable`，不含证据引用与金额。

- [x] **4.5 实现静默租约控制接口和跨服务读取**（PFA-09）
  - Control API 启动、查询和解除租约（上限 60 分钟、以服务器时间为准、全程审计留痕）；
    Gateway admission 与 Worker 执行门禁；到期自动恢复。
  - 证据：`provider-finance-quiescence.ts` 为跨服务共享的服务器时间语义；
    路由层 `POST/GET /provider-finance/quiescence` 与 `.../release`（解除必须填原因，
    只读管理员 403，超长窗口 400，`leaseView` 统一 camelCase → snake_case 暴露面）。
    Gateway：`apps/gateway/src/admission/enterprise-maintenance.ts` 的 `createQuiescenceGate`
    经 `chainGuards(maintenanceGate, authorizeModel)` 接入 chat/messages/responses，
    有效租约下直接返回 503 `enterprise_maintenance`（含 `retry-after`），
    **不触达上游、不写账本事实**；`/v1/models` 不设门禁。
    集成用例断言 pipeline 调用数不变、零新增 `ai_request`、`/v1/models` 仍 200、
    未认证仍 401、租约到期/解除后流量恢复。
    Worker：`operating-bill/runner.ts`、`provider-operating-sync/runner.ts` 跳过目标企业的
    自动续费、开账单与经营同步（`skippedQuiescentEnterprises` 可审计、不调用 `getBill`、
    不产生同步尝试与快照），解除后自动恢复；数据库中另 5 组用例覆盖候选 TTL 30 分钟、
    静默窗口 60 分钟上限、到期不可复活与 `PENDING` 资源不纳入门禁。
    **排空检查**（WP03 既有原语，本包在预检前置调用）覆盖在途请求、未结束 `upstream_attempt`、
    Usage/Ledger 配对与待结算事务。

- [x] **4.6 门禁收口：既有基线红与抖动归因**（非 WP04 功能项，建议单独立项）
  - 门禁期间用 `git stash` 在 WP03 基线 `8d568b3`（迁移头 0078、零 WP04 产物）复现，
    确认以下均为**既有**问题，WP04 既未引入也未改变其行为：
    1. **回滚链硬编码迁移头**：`pool015-admin-lifecycle`、`system-settings-v1` 等写死首个回滚项为
       `0072_admin_roles_security`，迁移头增长后必然失效。改用本包新增的
       `apps/control-api/src/__tests-integration__/migration-rollback.ts#rollbackTo`（与
       `packages/database` 同名辅助语义一致，因后者位于测试目录、不属对外导出面），
       `pool025-operating-bill` 一并收口。
    2. **`defaultTo("now()")` 落库为常量默认值**（既有系统性缺陷，WP04 未触碰 schema）：
       实测 `enterprise.created_at` 的 DEFAULT 为 `'<迁移执行时刻>'::timestamp with time zone`，
       同库内所有行 `created_at` 完全相同（2 行插入间隔 1.5s 仍 `count(distinct created_at)=1`）。
       而单企业口径的 `/auth/login` 取「`created_at` 最早、同值按 `id` 排序」的第一条企业，
       同值即退化为按随机 UUID 排序，多企业夹具约 50% 概率把会话落到隔离企业 → 401。
       **共 41 列、16 个迁移受影响**，且仓库内无一处使用 `defaultTo(sql\`now()\`)`。
       建议单独立项（`ALTER COLUMN ... SET DEFAULT now()` 的加法迁移 + 数据回填评估）。
    3. 门禁内按**既有先例**（`pool027`、`system-settings-v2`、此前收口的
       `pool043-operating-bill-accounts` 均已如此）为 6 个夹具显式锚定 `created_at`，
       仅改测试数据、未改任何断言语义，以消除与被测语义无关的随机性。
  - 结果：control-api 集成由「随机 2～7 个文件红」收敛为连续 3 次
    **37/37 文件、295/295 用例**全绿；`w08-e2e`（120s 容器超时）与
    `pool043-operating-bill-settlement`（`api_cost: null` vs `"0.00000000"`）经隔离复跑确认
    分别为并发争用与既有基线差异，均非 WP04 引入。

## Phase 5: Web Initialization Wizard

- [x] **5.1 状态与模式切换**（PFU-01）
  - 未激活显示初始化向导；已激活显示日常面板和回执。
  - 证据：`apps/web/src/components/resources/FinanceInitializationPanel.tsx` 以服务端
    `activation-state.strict_writes_enabled` 为唯一切换口径：`false` ⇒ 渲染
    `ProviderFinanceActivationWizard`；`true` ⇒ 渲染既有 `ProviderFinancePanel` 并在其上方常驻
    `ActivationReceiptPanel`（不可变回执，无任何修改入口）；`mode === "OFF"` ⇒ 不渲染任何内容
    （资金路由本就不注册，保持既有封闭语义）。`ResourceOtherTabs.tsx` 的 finance 标签页改挂本容器，
    日常入账组件本身零改动。服务端模式与前端标志不一致时以服务端为准。
    `FinanceInitializationPanel.test.tsx` 6 项覆盖：未激活→向导、已激活→日常面板+回执、
    OFF→不渲染、状态读取失败→可重试错误态（不伪装成已激活）、无 `resources.operate`→只读、
    DARK→向导保留但写入口不可用。页面证据
    `V4/Evidence/.../page-evidence/01-未激活-*.png`、`05-已激活-*.png`。

- [x] **5.2 完整草稿编辑**（PFU-02、PFU-05、PFH-01～PFH-03）
  - API 期初、历史充值、Coding Plan、跨切换周期和旧记录关闭。
  - 证据：`activation-draft-model.ts`（纯模型，不含 React 与网络）+ `ActivationDraftEditor.tsx`
    五区草稿编辑器。期初时点固定为切换时点且只读；金额**空值与 0 严格区分**（显式 `0` 原样发送，
    留空报「空值与 0 不同」且绝不自动补 0）；整行皆空时整行省略，既不报错也不进入请求体，
    由服务端投影给出 `MISSING_OPENING_BALANCE`；说明与证据对全部资金事实必填（PFH-06）；
    `REJECTED_WITH_EVIDENCE` 强制原因+证据，并在 UI 明示「`UNKNOWN_COST` 仍必须独立处理，
    不能借此关闭」，不提供任何绕过入口；`MIGRATED` 提示需同步登记历史充值。
    请求体只含业务草稿与 `schema_version`，**不含** `enterprise_id`/`admin_id`（PFA-07），
    `buildActivationDraft` 的键集有测试锁定。本地校验只拦「结构上无法构成合法请求体」的行，
    业务缺口一律交给服务端只读投影判定（PFU-03），单类行数上限 500 本地同形提示。
    `activation-draft-model.test.ts` 12 项（8 位小数格式、零值/空值、空行省略、载荷卫生、
    三种关闭决定的必填分支、行数上限）。

- [x] **5.3 结构化预检结果**（PFU-03、PFA-09）
  - 按资源、账户、旧记录、月份和缺口类别定位。
  - 候选过期或漂移后清除可激活状态。
  - 证据：`activation-preflight-model.ts`（纯模型）+ 向导内的 `ActivationGapReport`：
    缺口按固定类别顺序分组（SCOPE/期初/充值/购买/周期/旧记录/用量/Token/余额/经营账单/静默），
    每条给到 资源名 · 币种 · 月份 · 旧记录 · 用量行 的行级定位串，`UNKNOWN_COST` 始终原样展示。
    候选时效：`evaluateHold` 对「本地 TTL 到期、被更新的预检取代、服务端 `expired`、状态非
    `PREVIEWED`、候选哈希变化、事实水位漂移」返回 `cleared=true`，向导用 `useEffect` **立即**
    清除持有的候选并提示重新预检；服务端失败码仅在
    `activation_candidate_{stale,expired,not_found,not_ready}` 时清除，
    `activation_retry_required` **不**清除（事务已整体回滚，候选仍有效）。
    静默与排空在预检**前**展示并可管理（`ActivationQuiescencePanel`：启动/解除租约、剩余时间、
    五项排空计数、阻断清单）。门禁建模与服务端**两段式**一致：
    `prePreviewBlockers`（租约、剩余≥5 分钟、在途请求、未结束尝试、待结算事务）才阻断预检；
    `unpaired_usage_lines` 只属落库门（`assertDrainedForCandidate` 会在预检内按候选修复集豁免重算），
    仅作提示——若把它当预检前置条件，首次预检永远不可达，而这正是初始化存在的场景。
    `activation-preflight-model.test.ts` 8 项 + 向导交互测试 10 项。

- [x] **5.4 不可逆激活确认**（PFU-04）
  - 显示候选哈希、水位和影响范围。
  - 企业确认匹配后才能提交。
  - 证据：`ActivationConfirmDialog` 同时展示 目标企业、候选 ID、候选哈希、事实水位、
    候选到期（含剩余秒数）、覆盖月份、影响范围（API/Coding Plan 资源数、必要账户、旧记录、
    账户余额投影）、确定性用量修复行数、影响资源账户明细；管理员须**逐字输入会话企业 ID**，
    完全一致前提交按钮禁用（`confirm_enterprise_id` 只作防误操作匹配，权威企业仍取自会话）。
    幂等键代表「一次人工提交」：弹窗打开时生成，`ACTIVATION_RETRY_REQUIRED` 后人工重试
    **复用同一键**，关闭重开才换键；写操作 `retry: 0`，UI 无任何自动重试或自动循环；
    所有 409 语义（静默不足、进行中、候选失效/过期/不存在/不就绪、已激活、幂等冲突、
    企业不符、合同冲突、资源未就绪/冲突）映射为可读提示并失败关闭，
    未激活成功前不本地修改任何金额事实。向导交互测试 10 项覆盖上述各分支。

- [x] **5.5 缓存刷新和错误态测试**（PFU-03～PFU-06）
  - 刷新资金、资源、账单、分析和首页查询。
  - 覆盖零值、空值、并发、过期、静默排空、可重试冲突和权限场景。
  - 证据：`provider-finance.ts` 新增 `invalidateProviderFinanceCaches` 集中失效
    `["provider-finance"]`、`["provider-resources"]`、`["operating-bill"]`（含 `operating-bill-*`
    前缀谓词）、`["operating-analysis"]`、`["dashboard"]`（首页 `["dashboard","home"]` 同根覆盖），
    日常入账与激活成功共用同一函数，避免调用点各自漏刷一个命名空间；激活成功后另失效
    `activation-state` 使容器切回日常面板。失败路径：状态读取失败展示可重试错误态，
    预检/激活失败只展示服务端消息，不伪造成功、不改本地金额事实。
    测试：新增 4 个测试文件共 **36 项**（draft 模型 12 + preflight 模型 8 + 向导交互 10 +
    容器 6），覆盖 零值/空值、空行省略、载荷不含身份字段、NO_GO/GO_CANDIDATE、
    候选过期与水位漂移即时失效、`CANDIDATE_STALE` 清除、`ACTIVATION_RETRY_REQUIRED`
    同键人工重试、静默未就绪阻断预检、未配对用量行不阻断预检、DARK 与只读权限、
    OFF 封闭、错误态。既有 `Resources.test.tsx` 两个资金标签页用例改为显式声明
    「已激活」账本状态并等待 `activation-state` 异步返回（资金标签页现在按激活状态切换，
    日常面板仅在已激活状态可达），断言语义未变。
    页面证据：`V4/Evidence/.../page-evidence/`（5 张真实构建产物截图 + 可复现脚本 + README）。
    门禁：`@qianliu/web` typecheck / lint（`--max-warnings=0`）/ 全量回归 **82 文件 513 用例**
    全绿 / `vite build` 通过；`@qianliu/control-api` typecheck / lint 通过，资金定向单测
    （activation-contracts / contracts / dashboard-projection / consumer-projection）23 项全绿；
    `scripts/check-architecture.mjs` 通过（568 个生产源文件，无运行时环）。

## Phase 6: Verification and Business Acceptance

- [x] **6.1 数据库与领域验证**（PFA-03～PFA-06、PFH-01～PFH-05）
  - 原子回滚、幂等、并发、不可变约束、固定修复行集和非目标哈希。
  - 在事务语句与提交边界分别注入 `40001`，并注入 `40P01`、进程中断和响应丢失。
  - 验证服务端零次自动重试和同幂等键结果恢复。
  - 证据（复用既有定向套件，绑定补正后内容；`provider-finance-activation-apply` **13/13**（含「中途故障整体回滚；
    进程提交前退出时候选保持 PREVIEWED 且不存在 ACTIVATING」、「同键同候选重放」兼作**响应丢失**、
    `40001` **语句边界**（真实 PG 抛出）与**提交边界**（`DEFERRABLE INITIALLY DEFERRED` 触发器）、
    双管理员并发与 legacy/v1 锁、固定修复行集只锁定候选主键、非目标字段逐行哈希、Coding Plan/跨切换/旧记录关闭）；
    preview+migration+ledger+cutover+repository **22/22**（只读投影零写入 + `25006` 强制只读、TTL 30 分钟与
    终态不可修改、租约 60 分钟与不可复活、不可变事实与精确冲销、破坏性回退阻断、固定修复行集不吸收新行）；
    `@qianliu/domain` 全量 **13 文件 / 221 用例**全绿；`@qianliu/database` 的 `typecheck` 与
    `eslint src --max-warnings=0` 均 EXIT=0。**零自动重试**另由结构证据支撑：协调器以单层 `try/catch`
    包住整个 `transaction.execute(...)`，外无任何重试构造；HTTP 层同。
  - **`40P01` 注入已闭合（原披露 G-1 撤回）**：现有同一用例内新增一次**真实** PostgreSQL `40P01`
    语句边界注入（`DO $$ BEGIN RAISE EXCEPTION 'simulated deadlock detected' USING ERRCODE = '40P01'; END $$`
    在 `SERIALIZABLE` 事务内执行），断言原始 `code === "40P01"` 与消息文本 `simulated deadlock detected`，
    并纳入 `mapActivationFailure` 循环：必须得到 `ACTIVATION_RETRY_REQUIRED` + `retryable=true`，且
    `detail.sqlstate` 逐条回带各自原始 SQLSTATE（证明是逐码映射而非巧合）。**口径同时纠正**：
    `40001` 覆盖语句与提交两个边界，`40P01` **仅覆盖语句边界**（未构造真实行锁互锁，故不声称提交边界）。
    **反「只 grep 到字符串」证据**：(a) 变异对照——把 `40P01` 期望值改写后单测以
    `expected '40P01' to be '…'` 失败，Received 恒为 `40P01`；(b) 独立 `node-postgres` 探针在同一镜像
    digest（`postgres:17-alpine@sha256:742f40ea…`）的一次性实例上直接注入同一 DO 块，原始
    `error.code` 输出 `"40P01"` / `"40001"`。详见 WP06 报告 §1.3 与
    `wp06-logs/6.1-40p01-mutation-control.log`、`6.1-probe-raw-sqlstate.log`。

- [x] **6.2 API 与 Web 回归**（PFH-06、PFH-07、PFU-01～PFU-06）
  - 日常资金接口、自动续订、余额、周期、经营账单和调度不回退。
  - 证据（全部绑定 `ddd1fc2`）：`@qianliu/control-api` **全量 58 文件 / 396 用例全绿**（含 `provider-finance`
    与 `provider-finance-activation.http` 两个资金集成套件；`--maxWorkers=2`）；`@qianliu/web`
    **82 文件 / 513 用例全绿**（含 WP05 新增 36 项）；`@qianliu/worker` **22 文件 / 97 用例全绿**
    （自动续订与调度）；`@qianliu/database` 全量集成 `17 failed | 32 passed (49)` /
    `20 failed | 252 passed | 55 skipped (327)`，**与 WP04 基线数值一致且失败集内零个 `provider-finance*`
    套件**；`@qianliu/gateway` 全量 `1 failed | 42 passed (43)` / `2 failed | 323 passed (325)`，
    **恰为既有 C-4 的 2 组**零用量 `api_cost` 占位用例。点名面逐一确认全绿：自动续订 10、
    经营账单账户 12、账单并发 57、经营分析 5、资金定向 35。
  - 归因：自 WP05 基线 `b9a1e84` 起 database/domain/control-api/gateway/worker **生产代码零改动**
    （`git diff` 五包均为 0 文件），叠加 WP04 已用全量隔离开证明既有，形成传递链；**未修既有红**
    （授权明令排除）。原始日志见 `V4/Evidence/…/wp06-logs/`。

- [x] **6.3 隔离企业业务验收**（全部 Requirements）
  - DeepSeek 期初、历史充值、后续充值和 API 成本。
  - 智谱购买、周期、实付和套餐用量归属。
  - `NO_GO → GO_CANDIDATE → ACTIVATED` 全链路证据。
  - 静默租约启动、排空、候选生成、激活和流量恢复证据。
  - 证据（一次性 Testcontainer + **明确标注 `SYNTHETIC`** 的隔离测试企业，业务链路全部经真实 Control API
    HTTP，事实注入用 SQL）：`apps/control-api/src/__tests-integration__/provider-finance-wp07-acceptance.http.test.ts`
    **11/11 全绿且零 expected-failure**，覆盖 NO_GO 缺口逐项定位、在途请求/未结束 Attempt 阻断预检→排空→
    `GO_CANDIDATE` 四要素冻结、企业二次确认激活（严格写、不可变回执与审计、范围资源 READY、同键重放零重复）、
    智谱购买/实付/周期/用量唯一归属、经营账单动态与固定成本分列及 Token 守恒、静默跳过月账与释放后恢复；
    另以既有套件复核双端静默（gateway 2/2、worker 3/3）。原始日志见 `V4/Evidence/…/wp07-logs/`。
  - **首轮结论为 NO-GO**：发现阻断缺陷 **D-1** —— 一笔 199.00 的智谱 `MIGRATED` 套餐被
    `provider_finance_event`（新账本）与 `resource_purchase_record`（旧账本）**重复计入**
    （`codingPlanFixedCostCny`/`packageCost` 398.00 应为 199.00；`operatingCost`/`totalCost` 399.25 应为 200.25；
    `cashOutflowCny` 448.00 应为 249.00），违反 v1.2 §11.2 的套餐成本与金额可解释要求。
    根因：激活写入侧把事件 `external_reference` 写成业务订单引用，而四处聚合读模型要求
    `'legacy-purchase:' || sourceRecordId` 才排除旧记录。
  - **修复（授权范围内的写入侧最小改动）**：新增纯 helper `legacySourceMarker()`，历史充值与 Coding Plan
    购买两条写入路径统一按「有源记录写标记、无源记录保留业务引用」落库；**未改 schema/迁移、未改四处聚合读模型**。
    修复后 D-1 的两个缺陷钉已转为**正向断言**，并在 database 激活套件补充值侧同类防线。
    回归：database 激活 apply **14/14**、preview 4/4、migration 5/5、repository 8/8、cutover 2/2、ledger 3/3、
    operating-feedback 8/8、operating-analysis 5/5、subscription-auto-renewal 10/10；control-api 资金回归
    provider-finance 11/11、activation.http 13/13、pool025 8/8、pool043-operating-bill-accounts 5/5、
    subscription-renewal 1/1、w18 19/19；web 资金面 19/19；五包 typecheck／database 与 control-api lint 均 0 错 0 警告。
    `standard-home` 4 例红为**既有债**（A/B 对照失败集逐字一致）。详见
    `V4/Evidence/PROVIDER-FINANCE-INITIALIZATION-20260921/V4-WP07-资金账本初始化-GO-NO-GO报告-20260922.md`（v2）。

- [x] **6.4 OpenSpec verify**
  - 检查 completeness、correctness 和 coherence。
  - 未安装 CLI 时执行等价人工映射审查，不伪称自动校验通过。
  - 证据（**人工映射审查，非 CLI 自动校验**）：本环境 `which openspec` → `not found`、
    `openspec --version` → `command not found`，`package.json` 无该依赖，`openspec/` 无 `config.yaml`，
    故 CLI 严格校验**不可用**，按本行第 2 条执行等价人工映射，明确标注人工。
    **completeness**：`PFA-01～09` + `PFH-01～07` + `PFU-01～06` 共 **22 条 ADDED Requirement**
    全部有实现承载与已执行证据（PFA-08/PFA-09 的**双端停写与真实流量静默演练**属 Phase 7.2/7.3，本阶段只覆盖
    实现与自动化断言）。**correctness**：从 `proposal.md`/`design.md`/三份 spec delta/`tasks.md` 机械抽取
    反引号代码文件引用 **40 个，存在性核对 0 缺失**；PFH-05「复用共享聚合、不得第二套余额公式」由
    `provider-finance-activation-projection.ts` 直接 `import` `provider-finance-balance-components.js`
    （文件头注释亦明示其为唯一实现）证明满足；C-1 与新迁移的关系精确化——缺陷写法
    `defaultTo("now()")` 共 **41 处且全部集中在迁移 `0000`–`0015`**，新增 `0077`/`0078`/`0079` 计数为 **0**，
    `0078` 使用**正确**写法 `defaultTo(sql\`now()\`)`，故 C-1 **不影响新增资金激活表**。
    **coherence**：候选 TTL 30 分钟、租约 60 分钟、剩余门槛 5 分钟、`SERIALIZABLE` 外层事务、
    咨询锁命名空间键、四字段修复白名单、错误码集合与权限映射在四处文档与实现中逐项吻合；
    存在 **3 处文档级漂移（G-2a/b/c，未修改）**：`design.md` 状态行仍为
    `DISCUSSION_DRAFT / IMPLEMENTATION_NOT_AUTHORIZED`、§2 组件名 `ProviderFinanceActivationPanel`
    实际不存在（实现为 `FinanceInitializationPanel` + `ProviderFinanceActivationWizard`）、
    §8 旧记录关闭的「独立控制表**或**不可变映射」二选一已在实现中定为后者（0079 `candidate_draft` 列）
    但未回填。详见 WP06 报告 §三。

## Phase 7: Deployment Candidate Only

- [x] **7.1 构建不可变候选与部署回执**
  - 备份、迁移兼容性、镜像、容器、路由和公开接口分别验证。
  - 不执行生产资金录入或激活。
  - 证据：4 镜像 `qianliu-candidate/*:c9bc9b93deb2` 构建于干净 HEAD（`WORKTREE=clean`），
    revision 标签 == `c9bc9b9`、index-sha256 == `30da0d46…`；源码 ↔ 镜像内容指纹逐文件一致；
    0078/0079 回滚 → 前进兼容；`pg_dump`/`pg_restore` 恢复退出码 0 且逐表计数一致；
    端口全部回环、路由/公开接口分流正确、上游唯一指向本地 stub。
    报告 `V4/Evidence/PROVIDER-FINANCE-INITIALIZATION-20260921/V4-WP08-资金账本初始化-GO-NO-GO报告-20260922.md` §一；
    日志 `wp08-logs/8.1-*.log`、清单 `wp08-fingerprint/`。**未执行真实部署或生产激活。**

- [x] **7.2 双端停写演练**（PFA-08）
  - Control API 与 Worker 同时 `DARK`，验证写入停止。
  - 恢复前重新预检。
  - 证据：双端 `DARK` 时写入口全部被拦 + Worker tick `{"skipped":"FINANCE_MODE_INACTIVE"}`，
    `activation-state` 保留只读可观测（200 `mode=DARK`）；恢复前预检前后事实快照逐行一致（只读）；
    恢复 `ACTIVE` 后写入口恢复；`strict_writes_enabled` 与既有资金事实全程不变
    （`fact_fingerprint=29fa3e4668d37b4f34f4fecf8a501fc7`）。日志 `wp08-logs/8.2-dual-dark.log`。

- [x] **7.3 激活前静默演练**（PFA-09）
  - 暂停目标企业 Gateway admission 与 Worker 自动续订，不中断已提交上游请求。
  - 验证排空条件、60 分钟自动恢复、5 分钟剩余门槛和 30 分钟候选 TTL。
  - 证据：本地合成企业演练，**断言 PASS=105 / FAIL=0（`RESULT: GO`）**。
    Gateway admission 零上游（stub 零命中、`ai_request`/`upstream_attempt`/`usage_event`/`ledger_line` 零增量）；
    在途请求继续排空；Worker 共享门禁跳过静默企业；租约上限 60 分钟（DB CHECK）、到期自动恢复；
    激活需剩余 ≥5 分钟；候选 TTL 固定 30 分钟（DB CHECK）；租约过期后旧候选不可继续激活；
    正向激活 + 幂等重放通过。日志 `wp08-logs/8.3-quiescence.log`、脚本 `wp08-scripts/quiescence-drill.sh`。
    **未执行生产激活。**

> **G-2 文档漂移收口（WP08）**：WP06 §6.4 披露的 3 处 `design.md` 漂移（G-2a 状态行、G-2b 组件名、
> G-2c 旧记录关闭裁决）已在本 WP 回填 `design.md`（`1 file changed, 47 insertions(+), 12 deletions(-)`）。
> 上述 6.4 披露文本保留为 WP06 历史记录，此处仅记录收口事实；**未修改任何历史报告或冻结记忆**。

## Production Activation: Explicitly Excluded from Apply

- [ ] **P.1 生产金额与证据确认** — 需要业务负责人签字。
- [ ] **P.2 生产 `GO_CANDIDATE` 回执确认** — 需要独立复核。
- [ ] **P.3 生产静默与排空** — 仅在 `PRODUCTION_FINANCE_ACTIVATION_AUTHORIZED` 后执行。
- [ ] **P.4 生产激活** — 在有效租约和候选 TTL 内人工执行。
- [ ] **P.5 生产业务验收与流量恢复** — 验证余额、充值、套餐归属、完整窗口守恒和流量恢复。

以上 P 系列任务不得由 OpenSpec `/apply`、测试脚本、部署脚本或数据库迁移自动执行。
