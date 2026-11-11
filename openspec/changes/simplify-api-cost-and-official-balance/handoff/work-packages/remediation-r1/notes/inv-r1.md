# R1 只读调查笔记：F1/F2/F3 实施点（HEAD 686100f）

日期：2026-11-05；执行：glm-flash 只读调查。未修改任何业务文件；未跑测试；全部 file:line 在 HEAD `686100f` 实测。

---

## A. F1 写旁路

### A1. OperatingSnapshotSchema 全部 HTTP 消费方

schema 定义：`apps/control-api/src/providers/contracts.ts:50-91`。
**line 51：`source: z.enum(["ADMIN", "PROVIDER_SYNC", "BILL_RECONCILIATION"]).default("ADMIN")`** —— 旁路根源：客户端可自报官方来源。

四个 HTTP 入口（无遗漏，见 A2 末尾写入方清点交叉验证）：

| # | 入口 | 路由 file:line | schema | source 是否透传 |
|---|---|---|---|---|
| 1 | 资源创建 POST /provider-resources | `apps/control-api/src/providers/routes.ts:382`（safeParse :383；snapshot 校验 :388-398；落库调用 :406-414） | `CreateResourceSchema`（contracts.ts:168-177，`operating_snapshot` 在 :176） | **透传**。`toOperatingSnapshotInput(operating_snapshot, rest.mode)`（routes.ts:411）→ `...value` 原样展开（contracts.ts:451-452），source 不改 |
| 2 | 资源编辑 PATCH /provider-resources/:id | `apps/control-api/src/admin-writes/resource-route.ts:12`（safeParse :16；校验 :25-35；落库 :39-50） | `UpdateResourceSchema`（admin-writes/contracts.ts:11-17，`operating_snapshot` 在 :15，复用同一 schema） | **透传**（resource-route.ts:46） |
| 3 | onboarding POST /provider-resources/onboard | `apps/control-api/src/providers/model-discovery-routes.ts:107`（safeParse :108；校验 :118-126；落库 :145-170） | `OnboardResourceSchema`（contracts.ts:185-188，继承 CreateResourceSchema） | **透传**（model-discovery-routes.ts:165-166） |
| 4 | 经营账单手填导入 POST /operating-bill-snapshot-imports（O1a） | `apps/control-api/src/operating-bills/routes.ts:120`（safeParse :121；**line 131 服务端硬编码 `{ ...row.snapshot, source: "BILL_RECONCILIATION" }`**；落库 :149-153） | `SnapshotImportSchema`（:67-72，raw record）＋ OperatingSnapshotSchema | **不透传**——服务端强制 BILL_RECONCILIATION，客户端传什么都被覆盖 |

web 前端 `apps/web/src/components/resources/resource-form-contract.ts:114`：`operatingPayload` 恒发 `source: "ADMIN"`——收紧合同不会破坏现有 UI。web 类型 `apps/web/src/api/types.ts:289` 含三值枚举（收紧要同步改）。

**入口 1-3 的现有校验（都不校验 source 合法性）**：`financeManagedOperatingSnapshotError`（contracts.ts:128-146）、`operatingSnapshotModeError`（contracts.ts:104-126）。

### A2. 落库链路与 source 覆写点

落库表：`provider_resource_operating_snapshot`（列定义 kysely：`packages/database/src/kysely-operations-tables.ts:256`，`source` 枚举三值）。

写方法调用方全清点（grep appendOperatingSnapshot|insertOperatingSnapshot，排除测试/种子）：

1. **创建**：routes.ts:406 → `ProviderRepository.createResource` → `packages/database/src/repositories/provider-repository.ts:211-217` → `insertOperatingSnapshot`（provider-operating-repository.ts:165-199，**line 178 `source: input.source`** 原样落库）。
2. **onboard**：model-discovery-routes.ts:145 → `onboardResourceModels` → provider-repository.ts:298-299（version=1，同一 insertOperatingSnapshot）。
3. **编辑**：resource-route.ts:39 → `AdminWriteRepository.updateProviderResource` → `packages/database/src/repositories/admin-write-repository.ts:80-85` → `appendOperatingSnapshot`（**事务版** `packages/database/src/repositories/provider-operating-snapshot-writer.ts:59-100`，**line 75 `source: snapshot.source`**）。
4. **O1a 导入**：operating-bills/routes.ts:149 → `ProviderRepository.appendOperatingSnapshot`（实例方法，provider-operating-repository.ts:135-163）→ insertOperatingSnapshot。
5. **官方余额同步（worker＋手动刷新共用）**：`official-balance-sync-writes.ts:94-110`（见 A5）。

**服务端覆写 source 的位置：不存在。** 唯一的 source 操作是 operating-bills/routes.ts:131 强制 BILL_RECONCILIATION（忽略客户端值）；没有任何路径把客户端值覆写为 ADMIN。writer 的唯一条件逻辑 `bindPlanSnapshotToCurrentPeriod`（snapshot-writer.ts:64-67，CODING_PLAN+ADMIN 才绑定订阅周期，line 65 还在读 `operating.source === "ADMIN"`）不修改 source。

**加重情节（调查新发现，建议入 F1 验收叙述）**：`financeManagedOperatingSnapshotError` contracts.ts:132 `if (snapshot.source !== "ADMIN") return null;` —— 客户端提交 source=PROVIDER_SYNC/BILL_RECONCILIATION 时**同时绕过 AFR-01 资金字段守卫与两位小数校验**（ADMIN_MONEY_FIELDS 校验 contracts.ts:72-80 也只对 ADMIN 生效），可携资金字段冒官方来源落库。

### A3. BILL_RECONCILIATION 的正当写入方

**存在且活跃**：O1a 导入 operating-bills/routes.ts:131（路由经 `registerOperatingBillRoutes` 挂载，`apps/control-api/src/server.ts:320`；contracts.ts:148-154 注释确认 O1a 为保留入口，AFR-01/R1 加了 `retiredApiFundingSnapshotFieldsError`（contracts.ts:155-166，routes.ts:137）守 API 资金字段）。全仓无其他 source=BILL_RECONCILIATION 写入方。读侧引用：`official-balance-sync-writes.ts:33`（inheritCostFacts 读 latest.source==='BILL_RECONCILIATION' 决定 costSource 继承——只读不写）。种子 `seed-e2e-wp4.ts` 有直写但非生产路径。

### A4. 读侧筛 source='PROVIDER_SYNC' 的全部查询与影响面

| 位置 | 过滤条件 | 旁路影响 |
|---|---|---|
| `official-balance-states.ts:98`（listOfficialBalanceStates，官方余额页 OK/EXPIRED/FAILED 判定＋余额展示 :165-171） | 仅 `source='PROVIDER_SYNC'` | **受影响**：冒充行可成为"官方余额" |
| `provider-operating-repository.ts:69-79`（listLatestOfficialOperatingSnapshots，**line 75** 仅 source） | 仅 source | **受影响**。下游 `listCurrentOfficialOperatingSnapshots`（:81-90）→ `supply-forecast-repository.ts:70`（余额预测 officialByResource :84-85）——预测受影响 |
| `apps/worker/src/provider-operating-sync/runner.ts:64-75`（recoverFromFreshPositiveBalance，**line 71**）→ `poolRepo.recordBalanceSyncRecovery`（resource-pool-repository.ts，EXHAUSTED 资源恢复链） | 仅 source | **受影响**：冒充快照可触发耗尽资源自动恢复 |
| `operating-analysis-repository.ts:72-73` | `source='PROVIDER_SYNC'` **且** `balance_source='PROVIDER_API'`（双滤） | 不受影响（HTTP 旁路行 balance_source=NULL 被排除） |
| `resource-pool-repository.ts:264-266` | source＋balance_source 双滤 | 不受影响 |
| `provider-finance-legacy-resolution.ts:76-77` | 双条件正向校验（!==即拒绝） | 不受影响 |

**关键事实**：`OperatingSnapshotSchema`（contracts.ts:50-71）**没有 balance_source/cost_source 字段**，`toOperatingSnapshotInput`（:446-467）也不注入 → 三入口旁路行 balance_source 恒 NULL。因此 design D2（`design.md:45-47`："读取时明确筛选 PROVIDER_SYNC 与 PROVIDER_API"）的双滤即可免疫既有冒充行；**未带双滤的 3 处（states:98、repository:75、runner:71）即 F1 读侧修复点**。

### A5. 手动刷新与 worker 写侧 source 值；PROVIDER_API 有无写入方

两者共用原语 `recordOfficialBalanceSyncSuccess`（official-balance-sync-writes.ts:84-124）：
- **line 95 `source: "PROVIDER_SYNC"`**；
- **line 103 `balance_source: "PROVIDER_API"`**（另一列，非 source 列）。
调用方：手动刷新 `apps/control-api/src/providers/official-balance-routes.ts:142`（POST /provider-resources/:id/official-balance/refresh，:51-53）；worker `apps/worker/src/provider-operating-sync/runner.ts:172`。**两者 source 值完全一致**（同一函数）。

`PROVIDER_API` 作为 **source 列**取值：全仓无任何写入方，纯 design/合同预留（kysely-operations-tables.ts:256 的 source 枚举不含 PROVIDER_API；provider-types.ts:87 同）。`PROVIDER_API` 作为 **balance_source 列**取值：唯一生产写入方 official-balance-sync-writes.ts:103（另有种子 seed-e2e-wp4.ts:143 等）。其余 PROVIDER_API 出现均在模型发现域（provider-model-discovery-repository.ts:430、provider-adapters/model-discovery.ts 等），与经营快照无关。

### A6. F1 修复候选方案对比

| 方案 | 内容 | 优点 | 缺点/风险 |
|---|---|---|---|
| a. HTTP 合同收紧 | contracts.ts:51 的 source 枚举收紧为仅 ADMIN（客户端合同拒绝 PROVIDER_SYNC/BILL_RECONCILIATION，400） | **满足验收措辞"提交→拒绝且零落库"**（拒绝是显式 400）；web UI 已恒发 ADMIN（resource-form-contract.ts:114）零波及；修复集中单文件 | O1a 导入（routes.ts:131）用同一 schema 且服务端注入 BILL_RECONCILIATION——直接收紧会**弄断导入端点**，必须为该服务端路径保留全枚举（拆分或放行注入值） |
| b. 服务端强制覆写 ADMIN | toOperatingSnapshotInput 强制 source='ADMIN'（三入口共用） | 改动最小（contracts.ts 单函数） | **不满足"拒绝"措辞**（返回 201 且落了库，只是来源改标）；守卫时序问题：finance 守卫在覆写前判定（routes.ts:388-398 先于 :411），携资金字段＋PROVIDER_SYNC 的请求在覆写方案下会先被 :132 的"非 ADMIN 直接放行"跳过守卫、随后以 ADMIN 落库——行为正确但逻辑绕；幂等指纹（见下） |
| c. 拆分内外 schema | 客户端 schema（ADMIN-only）与内部/服务端 schema（全枚举）分离 | 合同最干净；O1a 全枚举合法保留；与 b 不同是显式拒绝 | 文件面最大：contracts.ts、admin-writes/contracts.ts、operating-bills/routes.ts、web types.ts:289 |

**推荐：c（实质＝a＋给 O1a 保留服务端 schema）**。最小可行实现：`ClientOperatingSnapshotSchema = OperatingSnapshotSchema` 的 source 改为 `z.literal("ADMIN").default("ADMIN")`（或 `z.never()`/去除字段），仅用于 Create/Update/Onboard 三入口；OperatingSnapshotSchema 原样留给 O1a 注入路径；负向回归 3 条各入口断言 400。
连带注意：
1. **幂等指纹**：`onboardingRequestFingerprint`（contracts.ts:409-431）hash 含 parsed operating_snapshot（含 source）；收紧后 source 恒 ADMIN，跨发版重试的旧指纹（含 PROVIDER_SYNC 字段的 hash）会 miss → 幂等重放变重复资源。风险低（源字段本是客户端乱填），建议记录不处理或在 notes 里注明。
2. **读侧（验收"已冒充行不显示为官方"）**：给 official-balance-states.ts:98、provider-operating-repository.ts:75、worker runner.ts:71 三处补 `balance_source='PROVIDER_API'` 过滤（D2 口径，参照 operating-analysis-repository.ts:72-73 现成写法）。
3. web 类型 types.ts:289 收紧（source: "ADMIN"）；快照展示组件若按 source 分支需核查（未核实前端所有分支）。

影响文件清单（F1，含读侧）：
- `apps/control-api/src/providers/contracts.ts`（schema 收紧；toOperatingSnapshotInput 如需兜底覆写）
- `apps/control-api/src/admin-writes/contracts.ts`（UpdateResourceSchema 复用同一 schema，自动生效）
- `apps/control-api/src/providers/routes.ts`、`admin-writes/resource-route.ts`、`providers/model-discovery-routes.ts`（负向回归断言）
- `apps/control-api/src/operating-bills/routes.ts`（确认 O1a 路径不受收紧影响）
- `packages/database/src/repositories/official-balance-states.ts`（:98 加 balance_source 滤）
- `packages/database/src/repositories/provider-operating-repository.ts`（:75 加滤）
- `apps/worker/src/provider-operating-sync/runner.ts`（:71 加滤）
- `apps/web/src/api/types.ts`（:289）
- 测试落点：`apps/control-api/src/providers/routes.test.ts`、`__tests-integration__/w04-provider-route.test.ts`、`pool027-provider-model-discovery.test.ts`、`official-balance-refresh.http.test.ts`、`w20-*`（读侧）

---

## B. F2 缺价不补零

### B1. computeApiCostFromRule 与调用方

定义：`packages/domain/src/billing-rule.ts:218-239`。**`?? "0"` 共 3 处：line 228（cacheHitPrice）、229（cacheMissPrice）、230（outputPrice）**。MULTIPLIER 模式缺价已抛 `incomplete_multiplier_price`（:231-235）——**仅 ABSOLUTE/legacy 路径补零**。

生产调用方唯一：`apps/gateway/src/pipeline/billing.ts:105`（computeBillingFromRule API 分支；上游入口 computeBilling :26-79）。间接：`calculateDispatchSaving`（billing.ts:189-203，反事实计价同走 computeBillingFromRule）。测试调用方：
- `packages/domain/src/__tests__/billing-rule.test.ts:338,347`
- `packages/domain/src/__tests__/api-multiplier.test.ts:22,27,31,34,35,48,49,50`
- `apps/gateway/src/__tests-integration__/w13-billing.test.ts:138`

### B2. api_cost_status 值域与 NULL/UNKNOWN 写入条件

值域（迁移 CHECK）：`0059_provider_finance_ledger.js:290-303` 初建（PRICED_USAGE / CONFIRMED_ZERO_NO_UPSTREAM / UNKNOWN_COST / NOT_APPLICABLE＋shape 约束），`0085_historical_usage_not_migrated.js:188-196` 扩 NOT_MIGRATED。TS 类型：`packages/database/src/kysely-ledger-tables.ts:53,77`、`kysely-w20-tables.ts:31`。**枚举中没有 PRICE_MISSING**——PRICE_MISSING 是聚合层缺口原因（api-cost-estimation.ts:49），非列值。
shape 约束要点（0059:293-303）：PRICED_USAGE ⇒ api_cost 非空且币种非空；UNKNOWN_COST ⇒ api_cost NULL 且币种 NULL（API 模式）。**复用 UNKNOWN_COST 承载"缺价"可零迁移达成 F2 的 api_cost NULL 语义。**

现有写 NULL/UNKNOWN 的条件（全部已在，F2 无需新增机制）：
- attempt 结算：`attempt-usage-settlement.ts:105-108`——非 pricedApi（无规则/币种非 CNY-USD）→ UNKNOWN_COST；CP → NOT_APPLICABLE；pricedApi 判定 :78-79。
- 用量未知：`resolveBilling` :271-293（quality=UNKNOWN 或无可测 token → null billing → UNKNOWN_COST）。
- 确认未触上游：`rejectedAttemptEvidence` :200-203 → CONFIRMED_ZERO_NO_UPSTREAM（api_cost="0.00000000"）。
- 事务级：`pipeline-settlement.ts:62` 与 `attempt-usage-settlement.ts:255-258`（混合币种或 unknownApiCost → 总额 NULL＋UNKNOWN_COST）；`summarizePricingEvidence`（pricing-evidence.ts:17-53）已把 NULL api_cost 计为 unknownApiCost → **F2 的新 NULL 行天然进入事务级 UNKNOWN 汇总，下游零改动**。
- DB 写入：`gateway-ledger-guarded-writes.ts:246`。

### B3. 适用分项判定素材

结算可得分项用量：`computeApiCostFromRule(rule, input, output, cache)`（billing-rule.ts:218-224）；miss = input − cache（:226）。规则三价：cacheHitPrice/cacheMissPrice/outputPrice（BillingRule :49-51）。**适用判定＝对应用量>0**：cache>0 需 hitPrice；(input−cache)>0 需 missPrice；output>0 需 outputPrice。**cache=0 时 hitPrice 缺失不影响（现行为）**：0×任意价=0（:227），F2 按适用分项语义同样不要求 hitPrice——行为不变（billing-rule.test.ts:347-355 的 cacheHitPrice:null+cache=0 用例预期可保持）。
验收场景对照：完整价 0.00104 不变（`wp4-cost-official-balance.spec.ts:12`）；缺 miss 价＋miss 用量>0 → 现产出完整金额（如 0.00044），F2 后应 api_cost NULL＋UNKNOWN_COST，聚合层归 PRICE_MISSING（api-cost-estimation.ts:167-169：api_cost IS NULL＋未排除＋status≠NOT_MIGRATED＋usage_quality≠'UNKNOWN' → price_missing_rows——**聚合口径无需改**）。

### B4. 会随 F2 改预期的既有断言

1. `packages/domain/src/__tests__/api-multiplier.test.ts:46-51`（"preserves legacy missing-component costs..."）：:48 cacheMissPrice:null→"0.00008200"、:49 outputPrice:null→"0.00001800"——**必改**（改为断言缺价信号；MULTIPLIER 抛错用例 :50 不动）。红线"不删用例不降阈值"→ 重写断言而非删除。
2. `packages/domain/src/__tests__/billing-rule.test.ts:347-355`（cacheHitPrice:null 但 cache=0）——按适用分项语义**预期可保持不变**（实现时复核）。
3. `w13-billing.test.ts:131-145` 全价用例——不变。
4. e2e 断言（种子直写 PRICED_USAGE，不经 computeApiCostFromRule）：`wp4-cost-official-balance.spec.ts:358`（PRICE_MISSING 缺口）等——不受影响；新增负向回归建议落在 gateway 结算集成测试（partial price → UNKNOWN_COST）。

### B5. 历史行兼容（AFR-06）

AFR-06（specs/api-funding-retirement/spec.md:67-77）：保留原始用量/规则快照，历史重算不属于本次切换。**结论：F2 仅新行生效，旧行（补零落库的 PRICED_USAGE）不动。**
理论检测口径（仅记录、不实施）：零填补只发生在 ABSOLUTE 模式缺价时，而三价已随快照冻结（billing.ts:141-143），行内又有 raw_*_tokens 用量 → `PRICED_USAGE ∧ snapshot.pricingMode='ABSOLUTE' ∧ (cache>0∧hitPrice IS NULL ∨ miss>0∧missPrice IS NULL ∨ output>0∧outputPrice IS NULL)` 可从不可变证据确定性识别"曾补零"的旧行。若未来要回溯标记，也只能以该口径做**读侧重分类/标注**，且需另行报批（改变历史展示金额，AFR-06 风险）；本轮不做。

### B. 实施要点与影响文件

- `packages/domain/src/billing-rule.ts:218-239`：返回类型 string → string|null（或结果对象）；适用分项缺价 → null（语义＝PRICE_MISSING）；MULTIPLIER 抛错保留。
- `apps/gateway/src/pipeline/billing.ts:104-106`：null 传导（apiCost=null → status UNKNOWN_COST 经 attempt-usage-settlement.ts:78/105-108 现成路径；注意 currency 传 rule.currency 但 pricedApi=false → api_cost_currency 落 NULL，满足 shape 约束）。
- 反事实链 billing.ts:189-220（actualPricingEvidenceComplete 已按 complete 判定，NULL 行自动不可比——无需改，复核即可）。
- 测试：api-multiplier.test.ts:46-51 重写；gateway 结算集成补 UNKNOWN_COST/PRICE_MISSING 聚合断言。
- 零迁移、零聚合 SQL 改动。

---

## C. F3 历史依据快照

### C1. billing_rule_snapshot 结构与写入方

**唯一写入方**：`apps/gateway/src/pipeline/billing.ts:120-149`（billingRuleSnapshot），经 `attempt-usage-settlement.ts:114-116` 落 ledger_line.billing_rule_snapshot（追加 pricingAt/apiCost/deductedQuota/usageQuality）。
JSONB 字段清单（billing.ts:124-148）：pricingMode、baseRuleId、baseRuleVersion、windowRuleId、effectiveMultiplier、ruleType、ruleVersion、effectiveFrom、effectiveTo、timezone、daysOfWeek、startTime、endTime、timeWindows、matchedWindow、multiplier、cacheHitPrice、cacheMissPrice、outputPrice、currency、priority、**sourceStatus（line 147：`rule.sourceStatus ?? "UNVERIFIED"`）**＋ settlement 合并 4 字段。
**已含 sourceStatus：是。** 冻结始于提交 `9bf1560`（2026-11-03，WP1 tasks 2.1-2.3，git log -S 验证）；此前行快照无该键。
D-1 修复（715e5d0，2026-11-04）位置：`apps/control-api/src/gateway-requests/routes.ts:140-183`——快照完全缺单价时从 billing_rule **当前单价**回退透出 `billingPrices`（source 标注 "BILLING_RULE"，:178）；只加字段不改语义，不改快照。注意：D-1 的单价回退与 F3 的 sourceStatus 回退是同一性质问题（引用现值冒充当时），F3 改造时可一并审视（D-1 已用 source 标注缓解，是否升级为快照缺失标注由总指挥定）。

### C2. ledger_line 独立快照列

**没有独立列**。ledger_line 仅 `billing_rule_snapshot jsonb` 一列（迁移 `0020_p0_billing_snapshot_and_reasoning_usage.js:18`；kysely 类型 kysely-ledger-tables.ts LedgerLineTable `billing_rule_snapshot: Record<string, unknown> | null`）。source/rule_id/rule_version/multiplier 是独立标量列但无 source_status 列。0045:15 明确"ledger_line 及其 billing_rule_snapshot 是历史结算事实，禁止改写"→ **F3 零迁移可行：只改读取口径，JSONB 内容由既有写入方已冻结**。

### C3. rule_source_status 下游消费面

产生点：`packages/database/src/repositories/api-cost-estimation.ts:125-137`（estimationLinesSql；**line 128 `rule.source_status AS rule_source_status`**——LEFT JOIN billing_rule 读**现值**，即验收指认的 api-cost-estimation.ts:125 一带；plan.md 写 :125 是 sql 模板起始行，实际取值表达式在 :128）。
直接消费：
- `api-cost-estimation.ts:170-171` basis_unverified_rows → gaps **PRICE_BASIS_UNVERIFIED**（:214）；
- `api-cost-estimation.ts:185-192,228-232` priceBasis[].sourceStatus。
间接消费（全部经 loadApiCostEstimation，改 estimationLinesSql 一处即全体翻转）：
- `dashboard-breakdown.ts:229-282` priceBasisUnverified（:243 判定）；
- `usage-overview-repository.ts:139-153`（窗口级 priceBasisUnverified :151-152）；
- `dashboard-home-costs.ts:56`（gaps）、`dashboard-repository.ts:92`、`operating-analysis-repository.ts:217`、`operating-bill-finance-projection.ts:62-64`、`operating-bill-draft.ts:228-230`、`resource-insights/query.ts:337`（S3a）、`providers/finance-usage-overview.ts`、`exports/delivery-ledger.ts:142`。
前端类型：`apps/web/src/api/reporting-types.ts:34`、`v2-types.ts:102`、`packages/database/src/repositories/dashboard-types.ts:135`。
其它快照 JSONB 读取先例（SQL 读 `billing_rule_snapshot->>'currency'`，缺键得 NULL 不报错）：provider-finance-api-cost-gaps.ts:35,58-59,71-72、provider-finance-usage-backfill.ts:35-36,88-94、provider-finance-activation-facts.ts:303、provider-finance-cutover-repository.ts:46-47。

### C4. 旧行回退语义候选与推荐

| 候选 | 行为 | 对照 ACE-02/ACE-04 |
|---|---|---|
| a. 回退当前规则值 | 现状，验收阻断根因 | 违背 F3 验收标准（改 source_status 后历史变化）；把现值冒充当时证据 |
| b. NULL → UNVERIFIED | `coalesce(snapshot->>'sourceStatus','UNVERIFIED')` | **推荐**。与冻结侧默认（billing.ts:147 对旧构造 `?? "UNVERIFIED"`）同一先例；ACE-02 场景 3（不宣称已核实官方价，缺证据即待核实）；ACE-04（区分状态、不把缺失视为已确认） |
| c. 新增 snapshot_missing 状态/缺口码 | 显式区分"快照太老"与"当时未核实" | 需动 ApiCostEstimationGapReason 枚举＋前端＋文案；聚合语义复杂化；信息增益有限（UNVERIFIED 已保守且真实） |

**推荐 b**：`estimationLinesSql` 改为 `coalesce(l.billing_rule_snapshot->>'sourceStatus','UNVERIFIED') AS rule_source_status`，并**移除 LEFT JOIN billing_rule**（priceBasis 所需 rule_id/rule_version 已在 ledger_line 列 :127）。语义效果：快照含键行＝请求时冻结值（满足验收"改规则后历史不变"）；快照缺键旧行＝UNVERIFIED（诚实保守）。副作用：0093 后、9bf1560 前写入的旧行 priceBasisUnverified 会从（可能的）false 翻为 true——这正是修复意图，需在回归与 release notes 说明。
c 不推荐但可在 priceBasis 结构上加 `snapshotBasis: boolean`（快照是否含键）作为信息字段——可选增强，非必需。

### C5. 与 worker legacy-schema 门（S2B）的交互

门位置：`usage-overview-repository.ts:184-207`（loadPriceBasisEstimation / hasBillingRuleSourceStatusColumn——information_schema 查 billing_rule.source_status 列存在性，0093 水位；report-facts-legacy 集成测试按 migrateTo 0091 模拟旧 schema）。门注释明确动因：loadApiCostEstimation 的 SQL **引用 billing_rule.source_status** 会在 0091 水位报缺列。
F3 改动若按 C4 移除 JOIN，则 estimation SQL 不再触碰 billing_rule.source_status：
- JSONB 键读取（`billing_rule_snapshot->>'sourceStatus'`）在 0020+ 即可，0091 水位快照列存在、键缺失得 NULL → coalesce 后 UNVERIFIED，不报错——**JSONB 键读取本身不需要新兼容门**（有 currency 先例）。
- 但**建议保留 usage-overview 的门不动**：移除门会让 0091 水位旧库也开始输出 priceBasisUnverified=true（旧行快照无键→全 UNVERIFIED），改变 legacy 报表合同（现合同：省略＝"无此信息"）。保留门则 0091 水位行为完全不变，0093+ 水位获得 F3 新语义——最小波及。
- 若总指挥决定连门一起移除（依赖确实消失），必须同步复审 report-facts-legacy 集成测试期望（`packages/database/src/__tests-integration__/report-facts-legacy.integration.test.ts`，未核实具体文件名/断言，实施时确认）。

### C. 实施要点与影响文件

- `packages/database/src/repositories/api-cost-estimation.ts:125-137`（ estimationLinesSql：去 JOIN、读快照键＋coalesce UNVERIFIED）；接口注释 :29-30（priceBasis "现值"措辞改冻结值）、:66-72（sourceStatus 注释）。
- 测试落点：WP1 聚合测试（9bf1560 引入的 dashboard-finance-estimation.test.ts、resource-insights-api-cost-evidence.test.ts 等）、历史追溯回归（改规则 source_status 后 priceBasis 不变——验收标准）。
- 不动：billing.ts 快照写入（已冻结正确值）、ledger_line 结构、usage-overview 门（建议保留）。
- 零迁移。

---

## 剩余问题／风险清单

1. **F1 幂等指纹**：onboardingRequestFingerprint 含 source 字段（contracts.ts:428），收紧合同后跨发版重试指纹失配 → 幂等重放变新资源（低概率，实施时决定是否备注）。
2. **F1 冒充存量行**：读侧双滤可让既有冒充行退出官方域（验收"已冒充行不显示为官方"），但行本身仍在库（AFR-06 不删不改）；经营账单等**非官方域**消费方（dashboard 旧口径 listLatestOperatingSnapshots、monthly-operating-cost、operating-bill-draft 等）仍会把冒充行当 ADMIN/普通快照读——本次验收口径是"官方域"，非官方域展示是否需要处理**未在合同内，留总指挥裁定**。
3. **F2 反事实节省链**：computeApiCostFromRule 返回 null 后 dispatch saving 的 complete/actualPricingEvidenceComplete 判定自动收紧（更多 NOT_CALCULABLE）——行为更保守，建议在 R4 回归里带一条断言（未核实现有用例覆盖度）。
4. **F3 priceBasisUnverified 翻转面**：9bf1560（2026-11-03）～实施日之间的行快照已含 sourceStatus；更早旧行将全量计入 UNVERIFIED → 上线当期 PRICE_BASIS_UNVERIFIED 计数跳增（诚实但显著），验收人复审时需预告。
5. **D-1 单价回退同性质**：gateway-requests/routes.ts:166-183 仍以 billing_rule 现值回退显示单价（已标注 source="BILLING_RULE"）；F3 落地后是否同步改造为"快照缺失标注"，合同未列，留裁定。
6. **未核实项**：web 前端快照展示组件对 source 的全部分支（仅核实 resource-form-contract.ts:114 恒发 ADMIN）；report-facts-legacy 集成测试的确切断言（文件名与内容未打开核实）；`0059` shape 约束在 0085 后的完整形态（已读 0085:182-196 确认 NOT_MIGRATED 扩展，未见其他改动点）。
