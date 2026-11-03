# Inv-WP2 调查笔记：写入口与激活事实范围（WP2-S1 只读）

日期：2026-11-03；基线：worktree `/Users/mac/Projects/仟流智算-api-decouple`，HEAD `e4477b6`（调查期间工作树除本文件外无改动，无 git 写操作）。缩写：CA=apps/control-api，DB=packages/database，GW=apps/gateway。所有结论均 file:line 实证。

## 1. 写入口总表（扩 inv-a §1）

权限总则：路由根 `provider-finance*`/`provider-resources*`/`providers` → `resources` 模块，GET=`resources.view`、写=`resources.operate`（DB packages/contracts/src/admin-permissions.ts:17-33）；`/operating-bill*`（含 O1 两个入口）→ **`billing` 模块**（同文件 :27，O1 写权限是 `billing.operate`，不是 `resources.operate`——S3 若给 O1 补守卫需注意权限语境）。provider-finance 路由 OFF 模式整体不注册（CA:src/server.ts:305-307）。

| # | 方法+路径（行） | 模式 | 旧行为（repo 函数） | 写资金事实/候选 | 退役响应 | 负向测试要点 |
|---|---|---|---|---|---|---|
| W1 | POST /provider-resources/:id/finance/opening-balances（CA routes.ts:67） | API | `recordOpeningBalance`（DB provider-finance-events.ts:27→recordSimpleEvent:102，mode!=="API" 拒 :115） | 是：API_OPENING_BALANCE 事件 | 410 | 410+错误码；事件表/idempotency 表/余额零变化；PENDING 与 READY 资源同样 410 |
| W2 | POST /provider-resources/:id/finance/readiness（routes.ts:104） | API | `assessResourceFinanceEnablement`+`markResourceFinanceReady`（DB provider-finance-activation-repository.ts:483） | 否（写 finance_state 行） | 410 | 410；finance_state 仍 PENDING；gateway 准入语义不变 |
| W3 | POST …/finance/opening-balance-corrections（routes.ts:135） | API | `recordOpeningCorrection`（events.ts:320，API 模式校验 :326） | 是：API_OPENING_BALANCE_CORRECTION | 410 | 410；零事实 |
| W4 | POST …/finance/recharges（routes.ts:151） | API | `recordRecharge`（events.ts:33→recordSimpleEvent） | 是：API_RECHARGE | 410 | 410；重复候选不被创建/消费 |
| W5 | POST …/finance/subscriptions（routes.ts:168） | CODING_PLAN | `recordSubscription`（events.ts:38，CP 模式校验 :59） | 是：CODING_PLAN_PURCHASE/RENEWAL+周期 | **保留** | 原成功/幂等/重复候选行为回归绿 |
| W6 | POST …/finance/auto-renewal/cancel（routes.ts:224） | CODING_PLAN | `cancelSubscriptionAutoRenewal`（DB provider-finance-renewal.ts:60） | 否（更新 subscription_auto_renew_enabled） | **保留** | 幂等取消回归 |
| W7 | POST /provider-finance-events/:id/reversal（routes.ts:255） | 共享 | `reverseFinanceEvent`（events.ts:355） | 是：REVERSAL 事件（源 SYSTEM_REVERSAL） | **拆分** | API 事实冲销 410；CP 事实冲销原 201/200 |
| W8 | POST /provider-finance-duplicate-candidates/:id/confirm（routes.ts:268） | 共享 | `confirmDuplicateCandidate`（events.ts:252，按 candidate.event_type 分派 :297-304） | 视分派：API_RECHARGE→充值；CP_*→订阅 | **拆分** | API_RECHARGE 候选确认 410 且候选状态不变；CP 候选确认原行为 |
| W9 | POST …/finance/reconciliation-cases（routes.ts:288） | API | `createReconciliationCase`（DB provider-finance-reconciliation.ts:12） | 案件行（非事件），依赖 API 余额可算 | 410 | 410；案件表零新增 |
| W10 | POST /provider-finance-reconciliation-cases/:id/confirm（routes.ts:303） | API | `confirmReconciliationCase`（reconciliation.ts:94，写 API_BALANCE_RECONCILIATION 事件 :135-146） | 是 | 410 | 410；案件保持 OPEN |
| W11 | POST …/:id/reject（routes.ts:317） | API | `rejectReconciliationCase`（reconciliation.ts:50，仅状态+审计） | 否（案件状态） | 410 | 410；案件保持 OPEN |
| A1 | POST /provider-finance/activation-preview（CA activation-routes.ts:309） | 全局 | `previewActivation`（DB provider-finance-activation-preview.ts:163） | 候选元数据（attempt 表） | **改造**（见 §2） | api_opening_balances 非空 → 显式错误；纯套餐草稿可出 GO |
| A2 | POST /provider-finance/activate（activation-routes.ts:344） | 全局 | `coordinator.activate`（DB coordinator.ts:116） | 草稿事实+runtime+候选 | **改造** | 含 API 资金事实的持久化旧候选 → 409 类拒绝 |
| A3/A4 | POST /provider-finance/activation-quiescence（:374）/release（:401） | 全局 | startQuiescenceLease/releaseQuiescenceLease（activation-repository.ts:241/:329） | 否 | **保留** | 原门禁（requireWriteEntry、≥5min）回归 |
| O1a | POST /operating-bill-snapshot-imports（CA operating-bills/routes.ts:120） | 全局 | `providerRepo.appendOperatingSnapshot`（routes.ts:143-146） | **否**（写 provider_resource_operating_snapshot） | **核查结果见 §5：缺 finance-managed 校验** | API 行携带 recharge_amount/current_balance 现可 201——补守卫后应 4xx |
| O1b | POST /operating-bills/:month/opening-balances（operating-bills/opening-balance-route.ts:54） | API | `operatingBillRepo.recordOpeningBalance`（DB operating-bill-repository.ts:234 → recordOperatingBillOpeningBalance） | 否（经营账单手工期初，非 provider_finance_event） | inv-a 判定保留（历史录入） | 与 W1 同名不同库：勿误改 |
| O2 | POST /provider-resources（CA providers/routes.ts:362） | 两者 | `providerRepo.createResource`（快照经 toOperatingSnapshotInput :379-381） | 否 | 校验调整见 §5 | API 模式不带快照可创建（现状已可）；ADMIN 快照携带资金字段 → 409 finance_entry_moved |
| O3 | POST /providers（providers/routes.ts:47）、/unified-models（:450）、/model-routes（:475） | — | 厂商/模型/路由管理 | 否 | 不动 | — |

### 1.1 W7/W8 事实模式判定路径与 repo 层守卫最小落点

- **W7 `reverseFinanceEvent`**（DB provider-finance-events.ts:355-396）：事务内第一读即取原事件行 `provider_finance_event`（:357-359，含 `provider_resource_id`、`event_type`），随后 `lockResource` 取资源行含 `mode`（provider-finance-core.ts 末尾 lockResource，select `["id","mode","created_at"]`）。事件类型即事实类型：`API_OPENING_BALANCE`/`API_OPENING_BALANCE_CORRECTION`/`API_RECHARGE`/`API_BALANCE_RECONCILIATION`/`API_HISTORICAL_USAGE_COST` = API 资金事实；`CODING_PLAN_PURCHASE`/`CODING_PLAN_RENEWAL` = 套餐事实（REVERSAL 本身不可能是原事件类型——冲销按 `reversal_of_event_id` 引用原事件并写新 REVERSAL 行，:377-384；订阅冲销同时置周期 reversed_by_event_id :385-387）。已有模式分叉先例：`if (resource.mode === "CODING_PLAN") markAllocationDirty`（:391-393）。**最小落点**：在 :360 `NOT_FOUND` 判定后按 `original.event_type`（前缀 `API_`）抛新错误码（如 `API_FUNDING_RETIRED`），映射 410；事件行上有 provider_resource_id，无需额外查询。candidate/event 均无 resource_mode 冗余字段，须 join provider_resource 才能拿 mode，但按 event_type 判定已足够且更精确（事件类型与模式一一对应，且 0083 触发器 DB:0083:23-30 已在 DB 层强制 API_*/CODING_PLAN_* 与资源模式一致）。
- **W8 `confirmDuplicateCandidate`**（events.ts:252-306）：候选行 `provider_finance_duplicate_candidate` 有 `event_type`（:297 判 `API_RECHARGE`；:298 判 `CODING_PLAN_*`）与 `provider_resource_id`。分派即事实类型判定。**最小落点**：:297 前对 `candidate.event_type === "API_RECHARGE"` 抛同款错误码（此时候选仍 PENDING、零写入）。备选/兜底：守卫放 `recordSimpleEvent`（覆盖 W1/W4/W8-API 分支）与 `recordOpeningCorrection`（W3），`reverseFinanceEvent` 单独守（W7 不经 recordSimpleEvent）。
- 注意：W10 写的 API_BALANCE_RECONCILIATION 事件、W3 的 CORRECTION、A2 的 MIGRATION 期初/充值/历史消耗都会成为 W7 的可冲销对象；S3 守卫按 event_type 前缀判定可一次性覆盖全部 API 事实类型。

### 1.2 repo 写函数全部生产调用方（非 test；grep apps/ packages/）

- `recordOpeningBalance`：仅 CA routes.ts:90（W1）。同名 `operatingBillRepo.recordOpeningBalance` 是另一 repo 的方法（DB operating-bill-repository.ts:234，O1b 用），**非旁路**。
- `recordRecharge`：routes.ts:156（W4）+ events.ts:297（W8 内部分派）。
- `recordOpeningCorrection`：routes.ts:140（W3）。
- `recordSubscription`：routes.ts:173（W5）+ events.ts:299（W8 内部分派）。
- `createReconciliationCase`/`confirmReconciliationCase`/`rejectReconciliationCase`：仅 routes.ts:293/:308/:322（W9/W10/W11）。
- `cancelSubscriptionAutoRenewal`：仅 routes.ts:227（W6）。
- `reverseFinanceEvent`：仅 routes.ts:259（W7）。
- `confirmDuplicateCandidate`：仅 routes.ts:276（W8）。
- **routes 之外的写调用方（记录在案，均非 API 资金旁路）**：
  - Worker 套餐自动续订：`renewDueSubscription`（DB provider-finance-renewal.ts:75，`runSubscriptionAutoRenewals` :119 被 apps/worker/src/subscription-renewal 调用）经 `insertSubscriptionTx` 直写 CP 事件（source=SYSTEM_RENEWAL，renewal.ts:104）——套餐域，保留域。
  - 激活事务：draft-writer 经 insertOpeningBalanceTx/insertRechargeTx/insertHistoricalUsageCostTx/insertSubscriptionTx（MIGRATION 源）——A2 自身。
  - 结论：**recordOpeningBalance/recordRecharge/recordOpeningCorrection/三个对账函数/reverseFinanceEvent/confirmDuplicateCandidate 均无 routes 之外的生产调用方**；在 repo 层加 API 拒绝守卫不会破坏其他生产路径。

## 2. 激活/初始化事实范围（task 4.2 核心）

### 2.1 ActivationDraftSchema 全字段（CA activation-contracts.ts）

顶层（:148-156，`.strict()`+schema_version literal）：`schema_version`、`api_opening_balances[]`、`historical_api_recharges[]`、`historical_api_costs[]`、`coding_plan_purchases[]`、`coding_plan_carryovers[]`、`legacy_purchase_resolutions[]`（各行 DraftRows 上限 ACTIVATION_MAX_DRAFT_ROWS；superRefine 限制同(资源,币种)历史消耗最多一条 :160-175）。API 资金专属三类：
- `api_opening_balances`（OpeningBalanceDraftSchema :36-44）：resource_id、account_currency(CNY|USD)、account_amount(≤8 位)、occurred_at(Instant)、description、evidence_ref、source_record_id?。
- `historical_api_recharges`（:54-65）：+cash_paid_cny(>0,2 位)、external_reference(必填)、description/evidence_ref/record_idempotency_key 可缺省由服务端确定性生成（toActivationDraft :216-229 调 rechargeFactDescription/rechargeEvidenceRef/rechargeRecordIdempotencyKey）。
- `historical_api_costs`（:75-88）：resource_id、account_currency、cost_amount(>0)、cost_until_at(≥切换时点且≤now)；服务端规范化为负向资金事实（draft-writer :223 accountAmount 取负）。
`toActivationDraft`（:204-275）仅补 null/生成内部字段，不做任何 API 资金剥离——API 三类原样进 candidate_draft。

### 2.2 api_opening_balances 从提交到落库链路

1. A1 路由 zod 解析→`toActivationDraft`（activation-routes.ts:311-314）。
2. `previewActivation`（DB activation-preview.ts:163）：只读事务内 `loadActivationScope`+`buildFactWatermark`+`loadProjectionFacts`（facts.ts:97-103），`normalizeDraftItem(input.draft)`（domain projection :104）→`projectActivationCandidate`（:105-123）→`computeCandidateHash`（:125-132）；strict_writes_enabled 已置位则 ALREADY_ACTIVATED 拒绝（:165-168）；随后独立短事务 `recordPreviewCandidate` 把**整个 draft（含 API 三类）JSON 存入 attempt.candidate_draft**（activation-repository.ts:76）。
3. A2 `coordinator.activate`（coordinator.ts:116→runActivation:125）：候选行 FOR UPDATE+哈希/水位复验（reverifyCandidate :279-334，从 candidate_draft 重新 normalize 并重算哈希 :298-318）→ `writeActivationDraftFacts`（draft-writer.ts:22-38）逐类落库：openings→`insertOpeningBalanceTx`（**API_OPENING_BALANCE，source="MIGRATION"**，draft-writer.ts:59-65；已存在同额期初跳过、异额 CANDIDATE_STALE :50-57）；recharges→API_RECHARGE source=MIGRATION（:76-86）；historical costs→**API_HISTORICAL_USAGE_COST 负金额 source=MIGRATION**（writes.ts:214-227）；purchases→CODING_PLAN_* source=MIGRATION（:119-137）；carryovers→insertCarryoverPeriodTx（:150）；legacy closures→closeLegacyPurchaseTx（:181）。
- **candidate_hash 覆盖字段**（domain provider-finance-activation.ts:497-520）：schema_version、enterprise_id、cutover_at、required_accounts（scope 账户 resourceId:currency）、**api_opening_balances、historical_api_recharges、historical_api_costs**（API 资金草稿进哈希）、coding_plan_*、legacy_*、fact_watermark_hash。⇒ 改 draft 规范化或剥离 API 行会改变哈希算法输出；S4 的"拒绝含 API 事实旧候选"必须按 candidate_draft 内容判定而非哈希。
- 事实水位（facts.ts:389-496）10 段含 provider_finance_event 全表段——已激活企业后任何资金事件变化都会使旧候选 CANDIDATE_STALE。

### 2.3 previewActivation 服务端扫描面：哪些是 API 资金专属

`loadActivationScope`（facts.ts:58-158）：资源全量（mode API/CP）；账户必要币种来源四路 SQL（:93-118）：CUTOVER_SNAPSHOT（快照 collected_at≤切换）、FINANCE_EVENT（**任何资金事件**）、PRICED_USAGE（**API ledger 行**）、HISTORICAL_RECHARGE（旧充值记录）——前三路是 API 资金专属语义，套餐资源账户只能来自 FINANCE_EVENT 中的 CP 事件（CP 事件也进 FINANCE_EVENT 路）。
投影缺口收集（domain）中 API 资金专属项：
- `resolveOpeningAccounts`（scope-openings.ts:116-196）：**对 scope 内每个 API 资源**：无任何账户 → REQUIRED_CURRENCY_UNRESOLVED（:176-179）；账户缺原始期初（真实或草稿）→ MISSING_OPENING_BALANCE（:186-189）；缺说明/证据 → MISSING_OPENING_EVIDENCE（:190-193）。这是"仅套餐激活"的最大阻塞点：只要企业存在 API 资源，预检必要求其期初。
- `collectUsageClassificationGaps`（conservation.ts:191-239）：仅 `resourceMode==="API"` 行受 UNKNOWN_COST/MISSING_API_CURRENCY/CONFLICTING_API_CURRENCY/MISSING_SETTLEMENT_TIME 约束（:200-225）；TOKEN 守恒对所有行。
- `computeMonthlyGapDeltas`（conservation.ts:115-170）：权威月度缺口来自 DB `countFinanceGaps`（facts.ts:369-382 逐月调用），码集 API_USAGE_COST_UNKNOWN/API_COST_CURRENCY_MISSING/API_COST_CURRENCY_CONFLICT/OPENING_BALANCE_MISSING（API 资金域）/SUBSCRIPTION_PERIOD_MISSING（CP 域）/CASH_PAID_CNY_MISSING（两域：充值+套餐采购，:158-161）；草稿抵消仅限四字段修复与草稿新账户/草稿现金行。
- `collectLegacyResolutionGaps`（projection.ts:87-155）：legacy_purchase_record 关闭是"历史采购"域，含 API_RECHARGE 与 PACKAGE_PURCHASE 两类（facts.ts:196-209），API 充值迁移也走此域。
- 套餐所需（必须保留）：UNKNOWN_RESOURCE/RESOURCE_MODE_MISMATCH（草稿行模式校验 scope-openings.ts:28-107）、PFH-03 归属（OVERLAPPING_PERIOD/UNATTRIBUTED_PLAN_USAGE，conservation.ts:173-188）、CASH_PAID_CNY_MISSING（CP 采购现金证据）、carryover 跨切换校验、SUBSCRIPTION_PERIOD_MISSING 月度缺口。
- `decision`（preview :141；projection :286）：`gaps.length===0 → GO_CANDIDATE else NO_GO`——即上列任何一类缺口非零都不出 GO。

### 2.4 activate 写入面清单

MIGRATION 事件类型：API_OPENING_BALANCE、API_RECHARGE、API_HISTORICAL_USAGE_COST、CODING_PLAN_PURCHASE、CODING_PLAN_RENEWAL（draft-writer §2.2）；另写：provider_subscription_period（含 MIGRATED_PURCHASE 绑定 :134）、legacy 关闭审计、四字段 usage repair（applyUsageRepairsTx，coordinator :340-359）、**strict_writes_enabled 置位**（enableStrictWrites :446-457，runtime_state upsert）、**范围资源 READY**（markScopeResourcesReady :460-478：对 scope 每个 API 资源 promoteResourceFinanceReady——activation-repository.ts:566-592，INSERT ON CONFLICT 置 READY）、候选 ACTIVATED+回执（:481-501）、激活审计（:428-442）。真实事实复算守恒（:371-399）用空草稿重跑投影，仅豁免 LEGACY_RECORD 类缺口。

### 2.5 过时候选拒绝落点

已持久化候选中 API 资金事实存于 **`provider_finance_activation_attempt.candidate_draft`（jsonb）** 的 `api_opening_balances`/`historical_api_recharges`/`historical_api_costs` 三键（recordPreviewCandidate activation-repository.ts:76；读取：toCandidateView :227、reverifyCandidate coordinator :294-298 `candidate.candidateDraft`）。activate 现有校验顺序：validateCandidate（:198-228：状态/TTL/GO/哈希/已激活/runtime）→ assertQuiescent → reverifyCandidate（:279：水位、草稿重算）→ assertDrained → 写入。**最合适校验点：`validateCandidate` 拿到候选行后（:206-227 之间）或 reverifyCandidate normalize 之后**——此时已 FOR UPDATE 锁行、尚未写任何事实；按 `candidate.candidateDraft` 三键非空判定并抛新错误码（plan §4.4 的 `CANDIDATE_CONTAINS_RETIRED_API_FACTS` 类，现无同名码，CA ACTIVATION_FAILURE_STATUS 映射表 activation-routes.ts:35-51 需同步加行）。preview 侧对应落点是路由层 ActivationDraftSchema/toActivationDraft 之后（activation-routes.ts:311-314）。

### 2.6 drain/quiescence 对 API 资金概念的依赖

- `collectDrainReport`（activation-repository.ts:400-450）：`unpairedUsageLines` 计数 **`ledger_line.api_cost_status IS NULL AND resource_mode='API' AND created_at>=切换时点`**（:421-426）——**API 资金专属**；inProgressRequests/openAttempts/pendingLedgerTransactions 为真实在途工作，模式无关（PENDING ledger_transaction 由 DB gateway-ledger-guarded-writes.ts:271/gateway-ledger-settlement.ts:391 写，状态默认 SETTLED/PENDING 视路径）。
- `assertPrePreviewQuiescent`（CA activation-routes.ts:230-250）与 coordinator `assertDrained`（:261-271）都用同一 report。⇒ **"仅套餐事实激活"会被残留未分类 API 用量行阻塞 preview/activate 的排空门禁**（plan §4.4 要求：仅在阻塞 CP 独立初始化时报总指挥，本笔记如实记录现状，不裁定）。
- quiescence 租约本身与 API 概念无关（activation-repository.ts:241-348）；GW 准入在租约期内 503 停新流量（GW admission/enterprise-maintenance.ts:29-56）；worker provider-operating-sync 跳过静默企业（apps/worker/src/provider-operating-sync/runner.ts:164-165）。
- 另一 API 专属预检门禁：`isResourceFinancePending`（activation-repository.ts:475-480）**无生产调用方**（仅定义+测试引用），S2/S4 无需考虑。

### 2.7 从未激活企业＋只有 API 资源（无 CP）激活现状（如实记录）

1. A1 前置 `assertPrePreviewQuiescent`：无有效租约 → 409 ACTIVATION_NOT_QUIESCENT（必须先 A3）。
2. 租约内：在途工作/未结算 API 行 → 排空拒绝（:243-249）。
3. 空草稿（全部 default []）投影：scope 含该 API 资源 → `resolveOpeningAccounts`：无账户（无快照/事件/定价用量）→ REQUIRED_CURRENCY_UNRESOLVED；有 PRICED_USAGE 币种账户但无期初 → MISSING_OPENING_BALANCE；月度缺口含 OPENING_BALANCE_MISSING/API_USAGE_COST_UNKNOWN 等 → **NO_GO**（未发现"空候选直接 GO"的路径；NO_GO 候选也可落库但 activate 会被 :207-210 CANDIDATE_NOT_READY 拒绝）。
4. 若提交含 api_opening_balances 的草稿补齐期初并四字段修复用量，则现状可 GO 并激活——该路径正是 S3/S4 要退役的入口组合。
5. 激活成功后新 API 资源被 0081 触发器种 PENDING（DB 0081:185-204：仅 API 模式+企业已激活），W2 是唯一 PENDING→READY 生产入口。

## 3. 准入与结算依赖复核（task 4.3）

- `provider_resource_finance_state` 全部非测试读/写方（rg 全仓 apps/ packages/ + migrations 0000-0093）：
  1. DB resource-pool-repository.ts:435-439（leftJoin+select）与 :450（PENDING continue）——唯一调度过滤点；
  2. DB provider-finance-activation-repository.ts:454-592（load/mark/promote/list，`promoteResourceFinanceReady` 为激活写入方 :576-591；`isResourceFinancePending` 无生产调用方）;
  3. CA routes.ts:77/:112（W1/W2 读状态）;
  4. 迁移：0081:151-204（建表+种入触发器）、0083:64-70（ADMIN 期初要求 PENDING）、0081 down 守卫 :216-223;
  5. **无其他**。两处同名 CTE `finance_state`（operating-bill-account-month-lines.ts:11、project-allocation-common.ts:181）实为 `provider_finance_runtime_state.strict_writes_enabled` 别名，**与该表无关**。GW/worker 无直接引用。
- `listServableResources` 生产调用方：仅 GW pipeline-admission.ts:150（dispatch 主链唯一入口；GW 其余 poolRepo 用法为 getResource/half-open/recordSuccess/Failure，均不触 finance_state）。
- 现有测试锚点：
  - :443 quota_block_state：GW `cpqw-quota-window.test.ts`（:280"等待期重复请求：准入拒绝给具体窗口与 EXHAUSTION_RECORD，零上游调用"、:319"管理只改 status 不清 block：仍零生成、零半开"、:351"多 CP 资源阻断：MODEL_POOL 聚合"）；DB quota-block-repository.integration.test.ts（0087 迁移/耗尽/条件提交系列 :101-280）、quota-block-transaction-faults.integration.test.ts。
  - :451 evaluateAdmission：**无按名直测**（rg 仅定义+调用两处）；行为锚点为 GW `w11-resource-pool.test.ts`（:74 WT-07 CREDENTIAL_INVALID 隔离、:146 429 冷却→半开→恢复、:264 EXPIRED、:106 WT-19 adminRecover、:282/:315 厂商额度同步隔离语义）——S2 迁移时以"这些用例回归绿"作为 :451 未动证据。
  - finance_state PENDING 过滤：DB provider-finance-activation-migration.integration.test.ts（:256"资源资金状态：新 API 资源在已激活企业下默认 PENDING…"、:336"Gateway 可服务资源排除 PENDING，就绪后恢复；存在激活事实时拒绝回退"，直接断言 listServableResults 前后差集 :351-360）。
- ledger_line 结算链（GW attempt-usage-settlement.ts :107/:202/:258 写 api_cost_status；pipeline-settlement/pipeline-failure-settlement/revoked-attempt-settlement）：**rg 无任何 finance_state/PENDING/finance 表依赖**（仅写 api_cost_status 三态与 quota 相关字段）；ledger_transaction 写方（DB gateway-ledger-guarded-writes.ts:271、gateway-ledger-settlement.ts:391）与 finance_state 无关。⇒ 解除 :450 不影响结算链。

## 4. 缺口码与读模型消费方（S5 前置）

- `countFinanceGaps`（DB provider-finance-gaps.ts:14-71，码集六类 :24-29/:31-60；OPENING_BALANCE_MISSING=窗口内 PRICED_USAGE 行无对应 API_OPENING_BALANCE 事件 :31-44）调用方：
  1. DB provider-finance-activation-facts.ts:374（激活投影月度缺口 loadMonthlyGaps）；
  2. `countOperatingExpenseGaps`（provider-finance-gaps.ts:73-84：剔除 SUBSCRIPTION_PERIOD_MISSING、并入 subscriptionExpenseGaps）→
     a. provider-finance-repository.ts:241（getMonthlyFinanceSummary——GET /provider-finance/summary 的 incompleteReason 来源）；
     b. dashboard-home-costs.ts:75（loadWindowOperatingFinance——标准首页同期窗口 incompleteReason）。
- `monthly-operating-cost.ts`：状态位产生于 :177-189（opening_balance/currency/at 任一 null → OPENING_BALANCE_MISSING）与文案 :120（"待补期初余额"）；消费方：
  1. operating-bill-monthly-cost.ts:5-22 `apiBalanceGaps`：OPENING_BALANCE_MISSING → 账单缺口码 **API_OPENING_BALANCE_MISSING**（field "opening_balance"，:16）；被 operating-bill-draft.ts:252 消费（draft 缺口）。
  2. dashboard-repository.ts:67/:95/:110-111/:129-141（getSummary/getMonthlyDetail：monthlyRechargeAmount、summarizeDashboardMonthlySpend）；
  3. dashboard-home-costs.ts（同期窗口金额+incompleteReason 组合）；
  4. resource-insights/query.ts:361、dashboard-breakdown.ts:266、resource-insights/projection.ts:9（资源洞察行）；
  5. balanceBridgeFacts（operating-bill-monthly-cost.ts:129-141，draft sourceFacts :402）透传 apiSpendStatus。
- `operating-bill-finance-quality.ts` 产出码清单：monthlyExpenseGaps（:12-23）：API_COST_UNKNOWN（由 API_USAGE_COST_UNKNOWN 映射）+其余 loadApiCostGaps 码（API_USAGE_COST_NOT_MIGRATED 等，field ledger_line.api_cost 或 api_cost_currency）；balanceQualityGaps（:26-66，仅 API 资源视图）：**API_OPENING_BALANCE_MISSING**（MISSING_OPENING_BALANCE 映射 :30）、API_BALANCE_COST_UNKNOWN、API_NEGATIVE_RECONCILIATION_REQUIRED、API_LEGACY_ARCHIVED、API_MONTH_OPENING_COST_UNKNOWN（:57）。消费方：operating-bill-finance-projection.ts:45（financeGaps）、:55（expenseGaps）。
- `operating-bill-finance-projection.ts`：:52-54 `missingAccountGaps` 过滤——仅保留"无已登记费用事实账户"的 API_OPENING_BALANCE_MISSING（有 monthlyApiCost 事实的账户不算期初缺口，:30-32 hasExpenseFacts）；:109-120 retainedGaps 过滤——对 finance 覆盖资源剔除桥接/快照类旧码（API_BALANCE_MISSING/API_BALANCE_BRIDGE_MISSING/API_OPENING_BALANCE_MISSING/API_ENDING_BALANCE_MISSING/API_CURRENCY_MISMATCH/API_NEGATIVE_BALANCE_BRIDGE/API_SPEND_NOT_CALCULABLE/OPERATING_SNAPSHOT_MISSING/PLAN_FACT_MISSING/UNALLOCATED_PACKAGE_COST :115-119），因为这些码已由 expenseGaps/financeGaps 新口径重出（:124 合并去重）。
- 3 个钉死套件断言位置：
  1. standard-home（DB __tests-integration__/standard-home.integration.test.ts）：:438 "V14-C2 F-B…"（:447-448 `incompleteReason` contains API_USAGE_COST_UNKNOWN、CASH_PAID_CNY_MISSING）；:745 "V14-C4 G02b：countFinanceGaps 六缺口码正/反控制"，:970-978 逐码 contains（**OPENING_BALANCE_MISSING:2 在 :976**），:980-983 反控制（已解决不计、窗外不计）。WP1 所称 V14-C3 即此组 OPENING_BALANCE_MISSING:2+反控制断言（V4/Evidence/.../s3a-receipt.md:48）。
  2. finance-period-cost-integrity.integration.test.ts：:104 `not.toContain("API_OPENING_BALANCE_MISSING")`；:210 `apiSpendReason:"API_OPENING_BALANCE_MISSING"`；:228 gaps toContainEqual code API_OPENING_BALANCE_MISSING；:202/:274 API_USAGE_COST_NOT_MIGRATED:1。
  3. home-cost-comparison.integration.test.ts：:174 `toEqual({...incompleteReason:"API_USAGE_COST_NOT_MIGRATED:1"})`（精确串）；:205 SUBSCRIPTION_FEE_MISSING:1；:80/:97/:112/:223 incompleteReason:null 精确断言。
  - web 层展示映射：apps/web/src/components/dashboard/standard-home-model.ts:79-91（OPENING_BALANCE_MISSING→"有账户缺少期初余额"、SUBSCRIPTION_PERIOD_MISSING/CASH_PAID_CNY_MISSING 文案）及其测试 :201/:206/:425（WP4 范围，S5 只需保形状）。
- `projectOperatingBillFinance` 唯一调用方：operating-bill-repository.ts:423（buildDraft 内，仅 `financeEnabled`（strict_writes_enabled）为真时执行 :417-421；financeEnabled 读 runtime_state）。即"finance 开路径账单 draft 投影"唯一入口；经 getBill 被 CA operating-bills/routes.ts:170（GET /operating-bills/:month）等读出。
- 首页 finance 开路径 `projectDashboardFinance`（CA provider-finance/dashboard-projection.ts:37）经 WP1 已切估算 API 分量，monthlyRechargeAmount(s) 保留资金读模型值——WP1 contract §4 裁定 2 已落地（dashboard-repository.ts:110-111 来源为 loadMonthlyOperatingCosts.summary）。

## 5. O1/O2 旁路核查

- **两函数差异**（CA providers/contracts.ts）：
  - `operatingSnapshotModeError`（:104-126）：与 source 无关，按模式禁写异侧字段——API 禁 PLAN_ONLY_OPERATING_FIELDS（package_*、quota_*、reset_* :87-93），CP 禁 API_ONLY_OPERATING_FIELDS（recharge_amount/current_balance/cumulative_cost/current_period_cost/cost_period_start/cost_period_end/balance_updated_at :81-88）；另含 CP ADMIN 重置周期校验。
  - `financeManagedOperatingSnapshotError`（:128-142）：**仅 source==="ADMIN"** 时生效（:129 非.ADMIN 直接 return null）；API 禁上述 7 个资金字段，CP 禁 package_cost/effective_from/effective_until。
- **O2 现状**：POST /provider-resources（providers/routes.ts:366-377）、PATCH /provider-resources/:id（admin-writes/resource-route.ts:22-33）、POST /provider-resources/onboard（model-discovery-routes.ts:115-125）三处均先 `financeManagedOperatingSnapshotError`（providerFinanceMode!=="OFF" 时，409 finance_entry_moved）再 `operatingSnapshotModeError`（400）。**CreateResourceSchema.operating_snapshot 为 optional**（contracts.ts:145-153），API 模式不要求任何资金快照字段；toOperatingSnapshotInput（contracts.ts:423-441）仅做类型/系统计算标记转换，无资金字段补充。⇒ O2 无"必须提供期初"强制，AFR-02 只需按 plan §4.7 调整文案/口径。
- **O1 旁路确认**：POST /operating-bill-snapshot-imports（operating-bills/routes.ts:120-157）逐行 `OperatingSnapshotSchema.safeParse({...row.snapshot, source:"BILL_RECONCILIATION"})`（:135 **硬编码 BILL_RECONCILIATION**）→ 只调 `operatingSnapshotModeError`（:139-143）→ `appendOperatingSnapshot` 落库（:143-146）。**未调用 `financeManagedOperatingSnapshotError`，且即使调用也因 source 非 ADMIN 而恒 null**。⇒ 手填导入**可以**给 API 资源塞 recharge_amount/current_balance/cumulative_cost 等 7 个资金快照字段（仅受模式互斥约束：不能塞 CP 字段）。这正是 plan §4.7 要补"最小同款守卫"的落点；注意守卫条件需针对 BILL_RECONCILIATION 源另行设计（复用现函数会恒放行），且 O1 整体保留为历史录入通道的判定不变——是否允许资金字段随历史导入进入由总指挥按 §4.7"缺则补最小同款守卫"裁定实施细节。OperatingSnapshotSchema 资金相关字段全集：recharge_amount、current_balance、cumulative_cost、current_period_cost、cost_period_start、cost_period_end、balance_updated_at（contracts.ts:75-81）+ CP 侧 package_cost/effective_from/effective_until。
- O1b（POST /operating-bills/:month/opening-balances）写的是经营账单手工期初（opening-balance-route.ts:66-73 → operating-bill-repository.ts:234），**不产生 provider_finance_event，不进 candidate**，inv-a 判定保留正确；但它是 monthly-operating-cost OPENING_BALANCE_MISSING 状态位的修补入口（operating bill 域自洽），与 provider 资金退役无关。

## 6. 测试盘点（断言旧行为、S2-S5 实施时必须迁移的清单）

### 6.1 control-api provider-finance 路由集成（__tests-integration__/provider-finance.test.ts）

| 用例（行） | 旧行为断言 | 迁移方向 |
|---|---|---|
| :100 "records opening and recharge then returns the same projected balance"（含 :130 期初更正 201、:137-140 冲销 201、:142-167 对账创建/确认 201） | W1/W3/W4/W7/W9/W10 成功路径+余额投影 | 改 410 断言；余额投影改为读历史快照/夹具直插事实（seedPendingFinanceState 模式 :101 已用直插，可保留直插构造历史事实再测 410 与只读） |
| :181 "records a Coding Plan and exposes its service period" | W5 成功 | 不动（回归绿） |
| :84 "automatic renewal control…" | W6 幂等 | 不动 |
| :584 "requires and consumes a persisted duplicate confirmation" | W8 全流程（含 API_RECHARGE 分派 :297） | 拆分：CP 候选确认保留；API_RECHARGE 候选确认改 410 |
| :613 "rejects cross-mode finance writes" | INVALID_MODE 409 | 保留（守卫在 410 之后的语义需在 S3 明确：410 优先于模式错误） |
| :643 "closes the resource-level finance enablement loop…"（:660/:679/:692 readiness） | W2 PENDING→READY | 改 410；种入语义断言移交 0094 后夹具 |
| :697 "DARK模式允许只读但隐藏全部资金写入口" | OFF/DARK 404 | 保留（plan §4.1：OFF 不注册现状不变） |
| :733 "requires evidence and closes the enterprise initialization bypass" | W1 初始化范围 409 拦截 | 410 后此 409 分支不可达，需迁移/删除并注明依据 |
| provider-finance-activation.http.test.ts :261-786（14 例） | A1/A2/A3/A4 全套（含 :343 草稿校验、:405 排空、:425 激活成功重放、:594 CANDIDATE_STALE 零写入、:741 DARK） | A1/A2 用例若用 api_opening_balances/充值/消耗草稿需改纯套餐草稿+新拒绝断言；其余回归绿 |

### 6.2 gateway（__tests-integration__/）

- w11-resource-pool.test.ts：无 PENDING 断言（PENDING 拦截在 DB 侧测试，见 6.3）；:74/:146/:264/:282/:315 为 :451 语义锚点——S2 后必须全绿。
- cpqw-quota-window.test.ts :280/:319/:351 与 w18-quota-pipeline、cpqw-key-recovery-chain：:443 锚点——不动。
- provider-finance-quiescence-gate.test.ts：A3 语义（503 停流量）——不动。

### 6.3 database 集成（__tests-integration__/）

- provider-finance-activation-migration.integration.test.ts：:256（0081 种入：激活企业新 API 资源默认 PENDING、CP 不种、形状 CHECK）与 :336（listServableResources 排除 PENDING + 0078/0079 回退守卫）——0094 DROP 触发器后 :256 的"新资源默认 PENDING"断言需反转（新资源无行）；:336 的就绪后恢复断言改为存量 READY 行语义；回退守卫段 :355-375 依赖 0081 down——迁移测试按 0094 新增 down（恢复触发器）补对应正反控制。
- provider-finance-activation-preview.integration.test.ts / -apply.integration.test.ts：混合草稿（API 期初/充值/消耗+CP）成功投影/激活用例——S4 切分后：纯套餐草稿 GO 用例新增；API 草稿用例改拒绝断言。
- provider-finance-wp07-acceptance.http.test.ts（control-api）：:378-:966 全链路（合成事实→NO_GO→GO→激活→后续充值走 W4 :610"激活后后续充值走严格写接口"→账单）——:610 用例断言 W4 可用，S3 后必须迁移（改 410 或改走夹具直插）。
- provider-finance-resource-opening.integration.test.ts :84-151（0083 触发器：ADMIN 期初时点/多币种/MIGRATION 锚定）：0094 不改 0083（plan §4.2），但 W1 退役后 ADMIN 路径不可达——保留为 DB 层合同测试（直插仍受触发器约束，plan 已记录该边界）。
- provider-finance-ledger.integration.test.ts :129 "closes a reconciliation case only with its exact signed adjustment"、provider-finance-cutover.integration.test.ts：0059/0083 合同层——不动。
- 缺口码三钉死套件（见 §4）+ operating-bill-resource-scope.integration.test.ts:118（API_OPENING_BALANCE_MISSING 缺口对象断言）、pool025-operating-bill.test.ts:654-662（apiSpendStatus OPENING_BALANCE_MISSING/API_OPENING_BALANCE_MISSING 桥接断言，control-api）——S5 迁移。
- provider-finance-gaps.test.ts（DB 单测 :24 恒 0 形状断言）——S5 改 OPENING_BALANCE_MISSING 行时同步。

### 6.4 迁移相关

- migration.integration.test.ts / migration-pre-monthly-fixture.ts：全链迁移跑通——0094 加入后自动覆盖 up；down 链（rollbackTo 用例 :355-375 模式）需覆盖 0094 down 恢复触发器。
- quota-block-transaction-faults / quota-block-repository：:443 语义回归——不动。

## 7. 与 WP2/plan.md §4 决策的冲突或计划外事实

1. **O1 守卫不可直接复用现函数**：plan §4.7 说"缺则补最小同款守卫"，但 O1 导入硬编码 source=BILL_RECONCILIATION（operating-bills/routes.ts:135），而 `financeManagedOperatingSnapshotError` 对非 ADMIN 恒放行（contracts.ts:129）——"同款"守卫必须新写判定条件（对 BILL_RECONCILIATION 源的 API 资金字段策略），不是简单复制调用。实施细节未裁定，报总指挥。
2. **O1/O1b 权限模块是 billing 不是 resources**（admin-permissions.ts:27）——若守卫涉及权限语境或文档写"resources.operate"，需修正表述。
3. **drain 的 unpairedUsageLines 仅数 API 行**（activation-repository.ts:421-426）：plan §4.4 预判"drain/quiescence 仅在阻塞 CP 独立初始化时报总指挥"——现状确认：企业存在历史未分类 API 用量行时，即使草稿纯套餐，preview/activate 都会被排空门禁阻塞（421-426 不区分草稿内容）。是否豁免属 §4.4 保留的裁定点，S4 不得预改。
4. **candidate_hash 覆盖 API 三类草稿字段**（domain activation.ts:505-507）：S4 在 preview 侧"拒绝 api_opening_balances 非空"不改变哈希输入（拒绝发生在哈希前）；但若未来剥离字段后再算哈希会改变哈希语义——按 §4.4 显式拒绝（不静默剥离）与该事实一致，无冲突，仅提示。
5. **worker 套餐续订经 insertSubscriptionTx 直写**（renewal.ts:97-104）不经过 recordSubscription：repo 层加守卫若误放在 insertSubscriptionTx 会破坏自动续订——**守卫必须放 recordSimpleEvent/recordOpeningCorrection/reverseFinanceEvent/confirmDuplicateCandidate 分派处，不得放共享 Tx 原语**。
6. **`markResourceFinanceReady` 的"另一调用方只在测试中"**（routes.ts:103 注释）属实：rg 确认无其他生产调用方；但 `promoteResourceFinanceReady`（激活范围 READY，activation-repository.ts:566）是第三个独立写入方（A2 用），plan §3"准入解除"条目未列它——它属于 A2 激活写入面（§2.4），S4 改造 activate 时会触及，需在 S4 委派中明确其去留（现状：对 scope 内每个 API 资源建 READY 行）。
7. inv-a §4 称"新迁移可用编号 0093 起"已过时：**0093 已被 WP1 占用（billing_rule_source_status），0092 为员工额度**——plan §2 的"本包新迁移从 0094 起"正确，笔记与 inv-a 的差异以 plan 为准。

## 8. 未核实/不确定项

- `insertLedgerTransaction`（gateway-ledger-settlement.ts:388-400）写入的 status 默认值未逐行确认（guarded-writes 路径显式 "SETTLED"）；PENDING ledger_transaction 的生产产生方未定位到（drain 计数的真实来源可能只剩异常残留）。未核实，不影响结论 3/§2.6。
- GW `run-codex-e2e.ts` CLI 读取 ledger_transaction 属开发工具，未计入生产链。
- `assessResourceFinanceEnablement` 的余额公式细节未逐行展开（provider-finance-resource-enablement.ts:60-80 已读判定段）——W2 退役后该文件是否随退役属 S3 范围决策，本笔记不裁定。
- 0083 触发器在"直插夹具绕过路由"场景的行为边界（plan §4.2 已记录为已知边界），未实测。
- standard-home V14-C3 命名：仓库内测试名实为 "V14-C4 G02b"（:745），"V14-C3" 是 WP1 证据文档对该组断言的简称（s3a-receipt.md:48）——引用时以断言行号为准。
