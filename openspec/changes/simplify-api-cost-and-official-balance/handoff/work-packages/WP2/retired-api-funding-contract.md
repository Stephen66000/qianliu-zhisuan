# API 资金写入口退役合同（WP2-S3，task 4.1 / AFR-01 / AT-AFR-02）

版本：v1.1（WP5 追加，2026-11-04：§2 表格增补 W12——purchases R1 补退役）；日期：2026-11-03（v1.0）；基线：worktree `/Users/mac/Projects/仟流智算-api-decouple`，分支 `codex/simplify-api-cost-and-official-balance`（S2 产物之上）。供 WP4/WP5（页面/联调）与后续调用方对照。

## 1. 退役响应合同（P4，已冻结）

所有退役写入口在**认证与权限通过之后**返回：

```
HTTP/1.1 410 Gone
{ "error": "api_funding_management_retired",
  "message": "API 内部资金管理已退出，请使用官方账户余额与 API费用估算" }
```

- **鉴权先行**：`requireAuth` 保留——未认证 401；权限沿用原 URL→模块映射（provider-finance* / provider-resources* / providers → `resources` 模块，写 = `resources.operate`；DB `packages/contracts/src/admin-permissions.ts`）。
- **不再校验 body/params、不再调用任何 repo/资金状态**：原 400（zod 证据校验）、409（scope_conflict / already_ready / 跨模式 INVALID_MODE / 幂等冲突 / 重复外部引用 finance_contract_conflict）、503（finance_write_contract_inactive）、200/201/幂等重放等分支全部不再可达；410 优先于上述一切。
- **模式无关**：退役端点已移除 `requireActive`——DARK 模式同样 410；OFF 模式下 provider-finance 路由整体不注册（`apps/control-api/src/server.ts`，现状不动）→ 404。
- **repo 守卫同码**：W7/W8 共享端点在 repo 层按事实模式拆分，API 资金事实抛 `ProviderFinanceError("API_FUNDING_RETIRED", …)`，CA `financeFailure` 特判映射为**同一 410＋同一 `error` 串**（`API_FUNDING_RETIRED` 小写化为 `api_funding_retired` ≠ 合同码，故特判而非通用小写化）。

## 2. 20 写入口处置总表（v1.0 原 19 项＋v1.1 增补 W12）（转录自 notes/inv-wp2.md §1，S3 落地后口径）

| # | 方法＋路径 | 模式 | 处置 | 响应 |
|---|---|---|---|---|
| W1 | POST /provider-resources/:id/finance/opening-balances | API | **退役**（410，AFR-01） | 410 `api_funding_management_retired` |
| W2 | POST /provider-resources/:id/finance/readiness | API | **退役**（410）；`assessResourceFinanceEnablement`/`markResourceFinanceReady` 路由引用移除，模块按 plan §4a-R7 保留存档 | 410 同上 |
| W3 | POST …/finance/opening-balance-corrections | API | **退役** | 410 同上 |
| W4 | POST …/finance/recharges | API | **退役** | 410 同上 |
| W5 | POST …/finance/subscriptions | CODING_PLAN | **保留**（requireAuth＋requireActive 原样） | 原 200/201/409 合同不变 |
| W6 | POST …/finance/auto-renewal/cancel | CODING_PLAN | **保留**（同上） | 原合同不变 |
| W7 | POST /provider-finance-events/:id/reversal | 共享 | **按事实拆分**（路由守卫链原样）：API 资金事实（event_type 前缀 `API_`，含 MIGRATION 期初/充值/历史消耗、对账调整）→ repo 守卫 `API_FUNDING_RETIRED`；REVERSAL 行（冲销的冲销）按原事件所属资源 mode 兜底，API 资源 → 同码拒绝；Coding Plan 事实照常 | API 事实 410 同上；CP 事实原 200/201 |
| W8 | POST /provider-finance-duplicate-candidates/:id/confirm | 共享 | **按事实拆分**（路由守卫链原样）：`candidate.event_type === "API_RECHARGE"` → repo 守卫同码拒绝（候选保持 PENDING、零写入）；CP 候选确认照常 | API 候选 410 同上；CP 候选原 200/201 |
| W9 | POST …/finance/reconciliation-cases | API | **退役** | 410 同上 |
| W10 | POST /provider-finance-reconciliation-cases/:id/confirm | API | **退役** | 410 同上 |
| W11 | POST /provider-finance-reconciliation-cases/:id/reject | API | **退役** | 410 同上 |
| W12 | POST /provider-resources/:id/purchases | 两者 | **R1 补退役（WP5，用户 2026-11-04 裁定）**：purchase_type=API_RECHARGE → 410（优先于幂等回执/closed/mode_mismatch，零写入）；PACKAGE_PURCHASE 保留 | API 类型 410 同上；PACKAGE 原合同 |
| A1 | POST /provider-finance/activation-preview | 全局 | S4 改造（`api_opening_balances` 非空显式拒绝）；S3 不动 | — |
| A2 | POST /provider-finance/activate | 全局 | S4 改造（含 API 资金事实旧候选 409 拒绝）；S3 不动 | — |
| A3 | POST /provider-finance/activation-quiescence | 全局 | **保留**（requireWriteEntry、≥5min 原样） | 原合同不变 |
| A4 | POST /provider-finance/activation-quiescence/release | 全局 | **保留** | 原合同不变 |
| O1a | POST /operating-bill-snapshot-imports | 全局 | **保留入口＋新守卫**（R1）：API 模式资源快照携带 7 个资金字段任一非空 → 400 `invalid_import_row`（message 含"API 内部资金管理已退役、资金字段不再接受手填导入"），不论快照日期；CP 侧字段与既有 `operatingSnapshotModeError` 校验不动；不带资金字段的行照常 201 | 合规行 201；API＋资金字段 400 |
| O1b | POST /operating-bills/:month/opening-balances | API | **保留**（经营账单手工期初，opening-bill 域自洽，不产生 provider_finance_event；inv-a 判定不变） | 原合同不变 |
| O2 | POST /provider-resources（含 PATCH / on-board） | 两者 | **保留＋文案退役口径**：`financeManagedOperatingSnapshotError` 判定逻辑不变，API 分支 message 改"API 内部资金管理已退役，资金字段不接受手填：…"；CP 分支文案不变；仍 409 `finance_entry_moved` | 原状态码不变 |
| O3 | POST /providers、/unified-models、/model-routes | — | 不动 | — |

### 权限模块说明（R2）

- W1-W11 / A1-A4 / GET 资金读端点：`resources` 模块（GET=`resources.view`，写=`resources.operate`）。
- **O1a / O1b 属 `billing` 模块**（`/operating-bill*` URL 根 → billing，写=`billing.operate`）——不是 `resources.operate`。O1a 守卫不改变权限语境，只加字段判定。
- 未认证一律 401（requireAuth）；自定义角色越权一律 403 permission_denied（allowsRoute）。

## 3. 存活入口清单（S3 后可写/可读）

- **写**：W5（CP 购买/续订）、W6（自动续订取消）、W7 对 **Coding Plan** 事实的冲销、W8 对 **CP 候选**的确认、W5 附带的重复候选流程、A3/A4（静默租约）、O1a 不带资金字段的快照导入、O1b、O2/O3（快照/资源管理，受 O2 守卫约束）。
- **读（全部保留）**：GET balance / events / auto-renewal / subscription-periods / period usage / reconciliation-cases / summary / resources；A 系列的 activation-state/preview 只读部分。
- Worker 自动续订经 `insertSubscriptionTx` 直写 CP 事件（source=SYSTEM_RENEWAL）不受任何新守卫影响（R6：守卫不进共享 Tx 原语）。

## 4. 守卫边界说明（已知边界，供评审与后续工作包）

1. **repo 守卫仅两处**：`reverseFinanceEvent`（`packages/database/src/repositories/provider-finance-events.ts`，NOT_FOUND 判定后）与 `confirmDuplicateCandidate`（PENDING 分派前）。错误码 `API_FUNDING_RETIRED` 已加入 `ProviderFinanceError` code 联合类型。
2. **recordSimpleEvent / recordOpeningCorrection / recordRecharge / recordSubscription / 三个对账函数不加守卫**：W1-W4/W9-W11 已在路由层 410，repo 方法保留存档供测试直插/历史夹具使用（DB 集成测试与 wp07 直插夹具依赖此边界）。
3. **守卫不在 insertSubscriptionTx / insertFinanceEventTx 等共享 Tx 原语上**：worker 自动续订与激活事务（S4）经原语直写，R6 边界。
4. **0083 DB 触发器原样保留**，作为直写防御（RAISE EXCEPTION → 409 finance_contract_conflict）：API_*/CODING_PLAN_* 与资源模式一致、MIGRATION 时点、期初 PENDING/激活前置、REVERSAL 精确负金额（**只允许冲销 API_RECHARGE/CODING_PLAN_***，即"冲销的冲销"在 DB 层也失败关闭）。经核实，W7 的"冲销的冲销"路径在应用层可达（repo 不筛 original.event_type），但即使守卫未命中，0083 也会拒绝落库（409、零写入）；S3 守卫按资源 mode 兜底后返回更精确的 410。
5. **"冲销的冲销"核实结论**：可达（无 event_type 过滤），但 DB 触发器已失败关闭；守卫兜底（REVERSAL 行按 original.provider_resource_id 的资源 mode 判定）把响应从 409 收敛为 410。零写入语义两种路径均成立。
6. W2 退役后 `provider-finance-resource-enablement.ts`（assess/evaluate）无生产调用方，模块与单测保留存档；`markResourceFinanceReady`/`promoteResourceFinanceReady` 的 activate 侧调用由 S4 处置。

## 5. 客户端迁移指引（供 WP4/WP5 文案）

- API 资源：期初/充值/对账/资源级 readiness 操作全部下线；余额参考改用**官方账户余额**（WP3 同步域），费用参考改用 **API 费用估算**（WP1 `loadApiCostEstimation`）。
- 经营快照手填/导入：API 资源不再接受 recharge_amount / current_balance / cumulative_cost / current_period_cost / cost_period_start / cost_period_end / balance_updated_at（O1a 400；O2 409）；Coding Plan 资源快照不受影响。
- 历史资金事实仍可经 GET 只读端点与已关账版本查看（AFR-06/07：历史不改写、当前视图退出资金缺口）。

## 6. 使用控制保留说明（task 4.4 / AFR-05；WP2-S6 回归电池结论，供 WP4/WP5 与后续调用方对照）

API 内部资金管理退役后，以下使用控制**原样生效**，不得被解读为"不限用量"或以官方账户余额替代内部额度。每项附机制锚点与回归证据（S6 新增电池＋既有锚点，2026-11-03 全绿）：

1. **员工月度额度（0092）与禁止超额（AT-AFR-09）**：员工 API/套餐月额度按 `EmployeeQuotaRepository.reserveEmployeeQuota` 的 `evaluateQuotaGate` 判定（`packages/database/src/repositories/employee-quota-repository.ts:52-232`，`allow_overage=false` 且预占超限 → `REJECT_EXHAUSTED`），gateway 热路径在 `apps/gateway/src/pipeline/attempt-quota-reservation.ts:73-101`；官方/厂商账户余额（含资源经营快照正余额）不参与该判定——电池用例 `apps/gateway/src/__tests-integration__/wp2-admission-gates.test.ts` 用例 1（快照 recharge 100/balance 88.88 仍 429 `provider_quota_exhausted`、`next_reset_at`=月度周期结束、零上游）；既有锚点 `apps/gateway/src/__tests-integration__/employee-monthly-quota.test.ts:45`＋`packages/database/src/__tests-integration__/employee-monthly-quota.integration.test.ts:233`。
2. **允许超额（AT-AFR-10）**：`allow_overage=true` 时放行并按真实用量/超额继续计量，授权配置与已开周期口径不被清零改写（冻结周期保留创建时授权，`packages/database/src/repositories/employee-quota-period-repository.ts:82-150`）；电池用例 wp2-admission-gates 用例 2（200、`ledger_transaction.overage=true`、grant 四字段前后相等）；既有锚点 employee-monthly-quota.test.ts:45（allow=true 分支）＋w18-quota-pipeline.test.ts:812（F-01-4）。
3. **Key 限制**：`principal_key.allowed_model_ids` 不含目标模型 → 管线前 403 `model_not_allowed`（`apps/gateway/src/auth/principal-auth.ts:133-174`，拒绝不建 ai_request/attempt/ledger、零上游）；Key 级 IP/额度/并发限制在 `apps/gateway/src/pipeline/pipeline-key-limits.ts:26-80`（F-014）；电池用例 wp2-admission-gates 用例 3；既有锚点 w18-quota-pipeline.test.ts:1546 起的 F-014 系列。
4. **项目限制**：现役机制＝主体授权门禁＋legacy 计数——候选需 `hasActiveGrant`（`apps/gateway/src/pipeline/pipeline-admission.ts:101-130`，`principal_grant` ACTIVE/有效期；停用授权 → 403 `principal_grant_required`），项目主体（PROJECT）额度走 legacy `quota_counter`（0092 月度域仅 EMPLOYEE，`employee-quota-period-repository.ts:12-56`）；电池用例 wp2-admission-gates 用例 4（grant DISABLED → 403 零上游）；既有锚点 w14-quota-gate.test.ts（legacy 额度耗尽/`REJECT_NO_GRANT`）＋employee-monthly-quota.test.ts:137（PROJECT 保持 legacy）。
5. **CPQW 套餐额度窗口（:443）**：活跃 `quota_block_state` 阻止候选生成且管理员手改可见 status 不放行（`packages/database/src/repositories/resource-pool-repository.ts:438-440` 硬过滤）；管线级强锚点 `apps/gateway/src/__tests-integration__/cpqw-quota-window.test.ts:280/:319/:351`＋DB `quota-block-repository.integration.test.ts`/`quota-block-transaction-faults.integration.test.ts`；电池对照项 wp2-admission-gates 用例 5。
6. **人工停用/凭证无效/真实耗尽（:451 准入状态机）**：`evaluateAdmission`（`packages/domain/src/resource-lifecycle.ts:306-323`）经 `listServableResources`（resource-pool-repository.ts:429-460）硬过滤——人工停用＝资源归档（`apps/control-api/src/providers/routes.ts:206` archiveResource；生产候选查询在 `apps/gateway/src/main.ts:67-68` 按 `provider.archived_at`/`provider_resource.archived_at` 排除，provider_resource 无 DISABLED 状态，0005/0031 CHECK）；`CREDENTIAL_INVALID`/`EXHAUSTED` 隔离拒绝、零上游，恢复仍按原合同（额度同步 `QUOTA_SYNC_RECOVERED`/管理恢复 `ADMIN_RECOVER` → DEGRADED 待真实调用确认，AT-OAB-12）；电池用例 wp2-admission-gates 用例 6/7/8；既有行为锚点 w11-resource-pool.test.ts:74/:106/:146/:264/:282/:315。
7. **员工月度额度跨月与新月开账（AT-AFR-07 后端）**：额度周期按企业时区月界开账、结算归预占月（`employee-quota-period-repository.ts:12-56` `currentScope` 时区锚定＋`ensureCurrentQuotaPeriod:82-150`；结算归属见 `employee-quota-settlement.ts`），费用估算按 `settled_at` 半开窗口归月（`packages/database/src/repositories/api-cost-estimation.ts:31/:135`，与首页同期窗口同源）；全程无资金页面访问/期初要求；电池用例 `packages/database/src/__tests-integration__/wp2-cross-month-attribution.integration.test.ts`（11-30 23:59 与 12-01 00:02 结算分列 11/12 月＋预占月合同）；既有锚点 employee-monthly-quota.test.ts:81（跨月 failover 归月）＋employee-monthly-quota.integration.test.ts:186/:507。
8. **套餐续订（AT-AFR-08 后端）**：CP 自动续订经 `renewDueSubscription`/`runSubscriptionAutoRenewals`（`packages/database/src/repositories/provider-finance-renewal.ts:75-146`，Worker 入口 `apps/worker/src/subscription-renewal/runner.ts` 按 PROVIDER_FINANCE_MODE 门控）照常执行，不因 API 余额缺失阻断、不自动改开关与周期；电池用例 wp2-cross-month-attribution（"API 无期初的已激活企业"显式前置＋续订一次成周期、模板与开关不变、重复 tick 幂等）；既有锚点 `packages/database/src/__tests-integration__/subscription-auto-renewal.integration.test.ts`（10 例）＋`apps/worker/src/subscription-renewal/runner.test.ts`。
9. **纯 API 资金 PENDING 不阻断（唯一放开项）**：0094 已删种入触发器、准入不再读 `provider_resource_finance_state`（resource-pool-repository.ts:421-460 AFR-02 注释段），存量 PENDING 行仅留档（D4）不参与调度；锚点 `apps/gateway/src/__tests-integration__/wp2-pending-admission.test.ts` (a)(b)(c)＋电池对照项 wp2-admission-gates 用例 9。
