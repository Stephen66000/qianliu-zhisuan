# Technical Design: 资金账本初始化与严格资金写激活

> 状态：`LOCAL_IMPLEMENTATION_VERIFIED / DEPLOYMENT_AND_PRODUCTION_ACTIVATION_NOT_AUTHORIZED`
>
> 本地实现与本地验证已完成（WP01～WP07：合同与稳定哈希、迁移 0078/0079、领域投影与完整窗口守恒、
> `SERIALIZABLE` 激活协调器与企业级幂等、控制面接口与 Web 向导、OpenSpec Phase 6 门禁）。
> WP08 在本地一次性容器候选上完成部署候选验证（构建不可变候选、迁移兼容性与备份可恢复性、
> 双端停写、激活前静默）后仍**未**获得：真实部署、生产库迁移/备份、生产金额录入、
> 生产激活（生产 `strict_writes_enabled` 置位）的授权。

## 1. Design Goals

1. 复用既有资金事实表和领域约束，不建立第二套余额账本。
2. 让草稿预检与激活复验共享同一套规范化、投影和守恒逻辑。
3. 让激活事务拥有唯一事务边界，避免内部方法自行提交。
4. 用完整事实水位而不是单一资源版本证明候选未漂移。
5. 把历史 API 充值和旧购买记录关闭纳入闭环。

## 2. Component Layout

```text
apps/web/src/components/resources/FinanceInitializationPanel.tsx   （状态与模式切换容器）
        └── apps/web/src/components/resources/ProviderFinanceActivationWizard.tsx （草稿/预检/确认向导）
                         │  仅会话身份；请求体不含权威 enterprise_id / admin_id
                         ▼
apps/control-api/src/provider-finance/activation-routes.ts
        ├── GET  /provider-finance/activation-state
        ├── POST /provider-finance/activation-preview
        ├── POST /provider-finance/activate
        └── POST/GET /provider-finance/activation-quiescence（+ /release）
        （严格请求合同：activation-contracts.ts）
                         │
                         ▼
只读预检
        ProviderFinanceActivationPreviewRepository.buildCandidateProjection / previewActivation
        loadActivationScope / loadProjectionFacts / buildFactWatermark
        normalizeDraftItem / computeCandidateHash / projectActivationCandidate
        / planUsageRepairs / computeFactWatermarkHash / stableStringify
                         │
                         ▼
激活写入（唯一 SERIALIZABLE 事务边界）
        ProviderFinanceActivationCoordinator.activate
        写入原语 insertOpeningBalanceTx / insertRechargeTx / insertSubscriptionTx
        / insertCarryoverPeriodTx / closeLegacyPurchaseTx / writeActivationAuditTx
        ProviderFinanceActivationRepository（候选 / 企业级幂等 / 静默租约 / 资源资金状态）
        provider-finance-quiescence.ts：loadQuiescenceGate / isEnterpriseQuiescent
        / listQuiescentEnterpriseIds（control-api、gateway、worker 共享同一判定）
                         │
                         ▼
transaction-aware finance primitives + existing tables
```

> 命名说明（收口 WP06 披露的 G-2b）：草案中的 `ProviderFinanceActivationPanel` 与
> `ProviderFinanceActivationService` **从未落地**（全仓无该标识符）。实际组件为
> `FinanceInitializationPanel`（状态切换容器）+ `ProviderFinanceActivationWizard`（向导）；
> 服务端按上表拆为「只读预检仓储 / 领域投影与哈希 / 激活协调器与写入原语 / 跨服务静默门禁」四层。

## 3. API Contracts

### 3.1 Activation State

```http
GET /provider-finance/activation-state
```

响应包含：

- `mode: OFF | DARK | ACTIVE`；
- `strict_writes_enabled`；
- 固定 `cutover_at`；
- 激活范围摘要；
- 最近候选的 ID、哈希、结论、创建/过期时间；
- 已激活时的回执摘要。

### 3.2 Preview

```http
POST /provider-finance/activation-preview
```

请求体只包含业务草稿，不接受权威 `enterprise_id` 或 `admin_id`：

```typescript
interface ActivationDraft {
  schema_version: "1";
  api_opening_balances: OpeningDraft[];
  historical_api_recharges: RechargeDraft[];
  coding_plan_purchases: SubscriptionDraft[];
  coding_plan_carryovers: CarryoverDraft[];
  legacy_purchase_resolutions: LegacyPurchaseResolutionDraft[];
}
```

响应：

```typescript
interface ActivationPreviewResponse {
  candidate_id: string;
  candidate_hash: string;
  fact_watermark_hash: string;
  snapshot_at: string;
  expires_at: string;
  decision: "GO_CANDIDATE" | "NO_GO";
  gaps: ActivationGap[];
  projected: ProjectedFinanceSummary;
  usage_repairs: UsageRepairSummary;
}
```

`expires_at` 固定为候选元数据提交成功时间加 30 分钟。读取、失败激活、锁竞争、`40001/40P01` 和重放均不得延长该时间。

### 3.3 Activate

```http
POST /provider-finance/activate
```

```typescript
interface ActivateBody {
  candidate_id: string;
  candidate_hash: string;
  idempotency_key: string;
  confirm_enterprise_id: string;
}
```

权威企业和管理员来自 `req.admin`。`confirm_enterprise_id` 只用于防误操作匹配。

## 4. Candidate Normalization

规范化顺序：

1. 验证字段类型、精度和长度。
2. 账户金额规范为八位小数字符串，人民币实付规范为两位小数字符串。
3. 时间统一为 UTC ISO；周期统一为上海 `[start, endExclusive)`。
4. `undefined` 转为合同规定的 `null` 或删除，禁止混用。
5. 数组按 `resource_id + currency + occurred_at + source_record_id` 等领域键排序。
6. 使用稳定 JSON 序列化和 SHA-256。

候选哈希包含规范化业务草稿和事实水位哈希，不包含 UI 展示字段、请求幂等键、客户端身份或随机 ID。

## 5. Fact Watermark

事实水位由固定查询生成，覆盖：

- 资源及财务相关状态；
- 运营快照；
- 旧购买记录；
- 资金事件和订阅周期；
- 旧费用处置；
- 切换时点后的 `ledger_line` 和对应 `usage_event`；
- 影响费用判断的计价快照；
- 企业运行状态。

每类集合使用稳定排序后的业务关键字段计算摘要；不得只依赖 `MAX(updated_at)`。水位对象再计算总 SHA-256。

预检与激活必须调用同一函数。激活在企业锁内重算，摘要不一致立即冲突。

历史修复另行生成固定资格行基准：

```typescript
interface UsageRepairBaselineRow {
  ledgerLineId: string;
  eligibleRepairs: Array<"settled_at" | "api_cost_currency" | "api_cost_status" | "subscription_period_id">;
  targetFieldsBeforeHash: string;
  nonTargetFieldsBeforeHash: string;
}
```

该数组按 `ledgerLineId` 排序并进入候选哈希。激活只锁定和修复这些主键行；预检后新增行不加入原候选的非目标哈希比较，但会改变完整事实水位或被静默门禁阻止。

## 6. Financially Read-only Projection

预检分两层：

1. 数据库只读事务加载事实快照和修复资格。
2. 纯领域投影器把草稿合并为虚拟期初、充值、购买和周期，然后计算：
   - 账户余额；
   - 每月充值和成本；
   - Coding Plan 固定成本与周期归属；
   - Usage/Ledger Token 差异；
   - 用量修复前后缺口。

候选元数据只能在只读财务计算事务成功提交后，由第二个短控制事务写入控制表。不得在 `SET TRANSACTION READ ONLY` 的事务中插入候选或审计记录，也不得把候选写进任何资金查询路径。

虚拟余额投影必须从 `provider-finance-balances.ts` 抽取并复用共享聚合函数，资金余额查询和候选投影不得分别维护冲销正负号或第二套公式。

## 7. Transaction Boundary

新增或抽取以下内部原语：

```typescript
recordOpeningBalanceTx(trx, input)
recordRechargeTx(trx, input)
recordSubscriptionTx(trx, input)
recordCarryoverPeriodTx(trx, input)
applyUsageRepairsTx(trx, input)
closeLegacyPurchaseTx(trx, input)
```

公开的日常写方法可以自行开启事务，但必须委托给相同 Tx 原语。激活协调器禁止调用会自行开启事务的公开方法。

激活顺序：

1. 开启 `SERIALIZABLE` 事务。
2. 校验企业静默租约有效、剩余至少 5 分钟，并确认在途请求和结算已排空。
3. 使用固定 64 位命名空间键立即尝试企业锁：
   ```sql
   pg_try_advisory_xact_lock(
     hashtextextended(
       'qianliu:provider-finance-activation:v1:' || enterprise_id::text,
       0::bigint
     )
   )
   ```
4. 锁候选和运行状态。
5. 校验权限外的领域条件、候选状态、过期和幂等。
6. 重算事实水位和候选投影。
7. 写入期初、充值、购买和周期。
8. 关闭旧购买记录。
9. 按 `ledgerLineId` 排序锁定候选固定修复行，执行四字段修复与逐行非目标哈希验证。
10. 执行完整窗口守恒。
11. 写运行激活状态、把候选从 `PREVIEWED` 原子更新为 `ACTIVATED`，保存操作审计和结果快照。
12. 提交。

不得在主事务前提交 `ACTIVATING`。进程在提交前退出时，事务回滚且候选保持 `PREVIEWED`；提交成功但响应丢失时，同一幂等键从 `ACTIVATED` 结果快照重放。

整个 `transaction.execute(...)` 调用必须由最外层错误映射捕获：

- SQLSTATE `40001` 或 `40P01` → `409 ACTIVATION_RETRY_REQUIRED`、`retryable=true`；
- 不得在协调器、仓储或 HTTP 层自动重试；
- 管理员重试前先读取 activation-state；水位变化再映射为 `CANDIDATE_STALE`。

## 8. Persistence

建议新增 `provider_finance_activation_attempt`：

```text
id uuid primary key
enterprise_id uuid not null
candidate_hash char(64) not null
fact_watermark_hash char(64) not null
decision varchar not null
status varchar not null
gap_summary jsonb not null
projection_summary jsonb not null
usage_repair_baseline jsonb not null
created_by_admin_user_id uuid not null
created_at timestamptz not null
expires_at timestamptz not null
activation_idempotency_key varchar null
activation_result jsonb null
activated_by_admin_user_id uuid null
activated_at timestamptz null
```

约束：

- 企业和候选 ID 唯一；
- 激活幂等键按企业唯一；
- `status` 只允许 `PREVIEWED | ACTIVATED | EXPIRED | REJECTED`，不得持久化 `ACTIVATING`；
- `expires_at = created_at + interval '30 minutes'`，不允许滑动续期；
- `ACTIVATED` 终态不可修改或删除；
- 结果快照不得包含敏感凭证；
- 候选不得参与余额、成本或经营账单 SQL。

**旧购买记录关闭的裁决（收口 WP06 披露的 G-2c）**：**不**新增独立控制表，选定「在候选结果中建立不可变映射」一路。关闭结果的权威载体是激活事务内写入的 `operation_log` 审计行：

- `action = 'provider_finance.legacy_purchase.close'`；
- `target_type = 'resource_purchase_record'`、`target_id = 旧记录 id`（旧记录不再有可变的「已关闭」标志位，关闭是**决定**而非资金事实）；
- `change_summary = { resolution, resource_id, migrated_event_id, represented_event_id, external_reference }`，其中 `resolution ∈ {MIGRATED, ALREADY_REPRESENTED, REJECTED_WITH_EVIDENCE}` 并按其语义强制必填项（`MIGRATED` 必须有外部订单引用与对应资金事件；`ALREADY_REPRESENTED` 必须引用既有资金事件；`REJECTED_WITH_EVIDENCE` 必须填原因与证据）。

`MIGRATED` 的金额事实由草稿明细行写出的资金事件承载，并在关闭审计里记录 `migrated_event_id`，形成「旧记录 → 资金事件」不可变映射，可被 `activation-state` 与审计复算。

与之配套的迁移 `0079_provider_finance_candidate_draft`：给 `provider_finance_activation_attempt` 增加
`candidate_draft jsonb NOT NULL`（历史行写入**哨兵空草稿**，必不匹配任何候选哈希，只能重新预检、绝不猜测继承），
并并入既有不可篡改触发器。因此 `activate` 可以在锁内从**候选存档草稿**复算候选哈希，而不依赖客户端重传草稿
（公开 `ActivateBody` 只收 `candidate_id / candidate_hash / idempotency_key / confirm_enterprise_id` 四个字段）。
该迁移不写任何资金事实、不新增控制表。

建议新增企业级静默租约控制表 `provider_finance_activation_quiescence`：

```text
enterprise_id uuid primary key
status ACTIVE | RELEASED | EXPIRED
started_by_admin_user_id uuid not null
started_at timestamptz not null
expires_at timestamptz not null
released_at timestamptz null
release_reason varchar null
```

租约最长 60 分钟。Gateway admission 和 Worker 每次处理目标企业前按服务端当前时间判断 `ACTIVE AND expires_at > now()`；到期自动视为失效。开始、显式解除和到期恢复均写非敏感审计。

## 9. Existing Endpoint Hardening

`OpeningBalanceBody` 对所有新写入强制：

- `description` 必填；
- `evidence_ref` 必填；
- 固定切换时点或资源级启用合同规定的时点；
- 已在企业激活范围内的资源不得绕过企业候选补写；
- 新资源只有在未产生生产用量、无冲突资金事实时才能完成资源级启用。

新资源资金未就绪状态必须进入调度门禁；具体复用字段还是新增字段在 WP01 数据合同中确认。

## 10. Permissions and Audit

- 状态读取映射 `resources.view`。
- 预检与激活映射 `resources.operate`。
- 请求体不得覆盖会话企业和管理员。
- 成功审计记录候选哈希、事实水位、事实计数、守恒摘要和激活结果。
- 失败审计记录错误码与非敏感摘要。

## 11. Pre-activation Quiescence and Operational Stop-write

### 11.1 Pre-activation Quiescence

1. 获得生产激活授权后，为目标企业建立最长 60 分钟静默租约。
2. Gateway 拒绝该企业新 admission；Worker 跳过自动续订和会改变候选事实的任务。
3. 不强制中断已提交上游的请求；等待 `IN_PROGRESS` 请求、未结束 Attempt、未配对 Usage/Ledger 和待结算事务归零。
4. 排空完成后再执行预检；候选 TTL 固定 30 分钟。
5. 激活开始时租约剩余不足 5 分钟则拒绝激活。
6. 成功、放弃或租约到期后恢复流量；到期后旧候选不得继续使用。

### 11.2 Post-activation Stop-write

严格写数据库状态保持不可逆。紧急停写流程：

1. Control API 和 Worker 同时设置 `PROVIDER_FINANCE_MODE=DARK`。
2. 分别替换运行实例并验证有效配置。
3. 验证充值/订阅/自动续订/账本写入停止，读取仍可用。
4. 需要完全关闭资金 HTTP 路由时使用 `OFF`。
5. 修复通过后先预检，再恢复两个服务为 `ACTIVE`。

不得用修改 `provider_finance_runtime_state`、停用触发器或直接改表作为停写方案。
