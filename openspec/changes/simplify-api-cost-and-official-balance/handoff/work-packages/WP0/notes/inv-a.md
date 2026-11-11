# Inv-A 调查笔记：API 资金写入口、触发器、PENDING 准入（只读）

日期：2026-11-02；基线：origin/main `ae506fed47d21865420afa91137e8b244072933e`（工作树等同，见 baseline.md）。证据均为 file:line，`apps/control-api` 缩写为 CA，`packages/database` 缩写为 DB。

## 1. HTTP 写入口清单（AFR-01 退役范围判定基础）

### 1.1 provider-finance/routes.ts（CA:src/provider-finance/routes.ts）

写守卫 `writeGuards = [requireAuth, requireActive]`（routes.ts:66）；`requireActive` 要求路由模式 ACTIVE 且企业 `strict_writes_enabled`（routes.ts:55-65）。权限来自路由根映射 `resources` 模块：GET=`resources.view`，写=`resources.operate`（activation-routes.ts:24-26 注释）。

| # | 方法+路径 | 行 | 行为 | 退役判定（D3 依据） |
|---|---|---|---|---|
| W1 | POST /provider-resources/:id/finance/opening-balances | :67 | API 期初登记（PENDING 资源限定，:73-89） | **退役**（410） |
| W2 | POST /provider-resources/:id/finance/readiness | :104 | PENDING→READY 资源级资金启用（:101-103 注释：唯一生产入口） | **退役**（410） |
| W3 | POST /provider-resources/:id/finance/opening-balance-corrections | :135 | 期初更正 | **退役**（410） |
| W4 | POST /provider-resources/:id/finance/recharges | :151 | 充值登记 | **退役**（410） |
| W5 | POST /provider-resources/:id/finance/subscriptions | :168 | 套餐登记（Coding Plan 采购，recordSubscription） | **保留**（套餐合同） |
| W6 | POST /provider-resources/:id/finance/auto-renewal/cancel | :224 | 套餐自动续订取消 | **保留** |
| W7 | POST /provider-finance-events/:id/reversal | :255 | 资金事件冲销 | **按事件所属资源模式拆分**：API 资金事件退役；套餐事件保留 |
| W8 | POST /provider-finance-duplicate-candidates/:id/confirm | :268 | 重复候选确认（可产生资金事件） | 同 W7 按事实类型拆分 |
| W9 | POST /provider-resources/:id/finance/reconciliation-cases | :288 | 对账登记（providerConfirmedBalance） | **退役**（410） |
| W10 | POST /provider-finance-reconciliation-cases/:id/confirm | :303 | 对账确认（写调整事件） | **退役**（410） |
| W11 | POST /provider-finance-reconciliation-cases/:id/reject | :317 | 对账拒绝 | **退役**（410） |

读入口（保留为历史只读）：GET balance :190、events :204、auto-renewal :218、subscription-periods :231、period usage :239、reconciliation-cases :249、summary :330、resources :336。

### 1.2 activation-routes.ts（CA:src/provider-finance/activation-routes.ts）

| # | 方法+路径 | 行 | 行为 | 判定 |
|---|---|---|---|---|
| A1 | POST /provider-finance/activation-preview | :309 | 生成初始化候选（只写候选元数据；DARK 下可用 :304-308） | **改造**：候选范围不再含 API 资金事实（AFR-01 场景 3：过时混合候选拒绝而非静默激活） |
| A2 | POST /provider-finance/activate | :344 | 不可逆激活（requireWriteEntry :275-279） | 同上；套餐所需事实保留 |
| A3 | POST /provider-finance/activation-quiescence | :374 | 运维静默租约开始 | **保留**（D2：用途须保留并核实） |
| A4 | POST /provider-finance/activation-quiescence/release | :401 | 租约解除 | **保留** |

GET activation-state :281、activation-quiescence :387（读，保留）。

### 1.3 其他相关写入口

| # | 方法+路径 | 位置 | 行为 | 判定 |
|---|---|---|---|---|
| O1 | POST /operating-bill-snapshot-imports | CA:src/operating-bills/routes.ts:120 | 旧经营数据（期初/余额）手填导入 | WP2 盘点：F08 历史桥接来源；按"历史录入"处理，不产生当前口径资金 |
| O2 | POST /provider-resources | CA:src/providers/routes.ts:362 | 资源创建；:369-371 `financeManagedOperatingSnapshotError` 校验经营快照（期初字段） | **AFR-02 目标**：API 模式不再要求资金快照字段 |
| O3 | POST /providers、/unified-models、/model-routes | providers/routes.ts:47/450/475 | 厂商/模型/路由管理 | 无资金写入，不动 |

## 2. 开关与权限（两层）

1. 路由层：`PROVIDER_FINANCE_MODE` 环境变量（packages/config/src/index.ts:35-37，**默认 ACTIVE**）；OFF 时资金路由整体不注册（CA:src/server.ts:305-307）。
2. 企业层：`strict_writes_enabled` 列（DB:migrations/0061_provider_finance_audit_hardening.js:8，含守卫触发器 :19-29）；`isStrictWritesEnabled`（DB:src/repositories/provider-finance-events.ts:19）。
3. 权限名：`resources.view` / `resources.operate`（§1.1）；OAB 手动刷新建议沿用 `resources.operate`（WP0 契约，待确认）。

## 3. PENDING 调用准入（AFR-02）

- 过滤点：`listServableResources`（DB:src/repositories/resource-pool-repository.ts:428-464），:450 `if (row.finance_state === "PENDING") continue;`。
- 种入：`provider_resource_finance_state_seed_trigger` AFTER INSERT ON provider_resource（DB:migrations/0081_provider_finance_activation.js:202-203）；表 `provider_resource_finance_state`（PENDING|READY，0081 注释 §3）。
- 同函数内必须保留的其他准入：`quota_block_state IS NULL`（:443，CPQW 套餐额度硬阻断）、`evaluateAdmission`（:451，ACTIVE/DEGRADED/UNAVAILABLE 冷却/半开、CREDENTIAL_INVALID/EXHAUSTED/EXPIRED 终态隔离，:421-426 注释）。
- WP2 改造点即 :450 一行及其联动（触发器/合同），不得动 :443/:451。

## 4. 数据库触发器/合同迁移

| 迁移 | 内容 | WP2 处理 |
|---|---|---|
| 0061 | strict_writes_enabled 列＋不可逆守卫触发器 | 保留（不统一关闭） |
| 0081 | activation_attempt/quiescence 表、finance_state 表＋seed 触发器（文件头注释写"0078"为旧计划编号残留） | 新迁移调整 API 资金前提；不重写 |
| 0082 | provider_finance candidate_draft | 混合候选改造相关 |
| 0083 | `provider_finance_validate_event_contract` 函数＋触发器（期初/PENDING/资源模式校验，:20/:163） | 退役 API 写后需保证无旁路；函数按资源模式区分 |
| 0092 | employee_monthly_quota（**已占用，PR #7 合并；不得复用**） | 不动 |

新迁移可用编号：**0093 起**（DB:migrations 共 93 个 0000-0092）。

## 5. Worker 任务面（切换共存，AT-X08）

apps/worker/src 目录：coding-plan-quota、subscription-renewal（**保留**）、provider-operating-sync（WP3 改造）、operating-bill、usage-aggregate、supply-forecast、reporting、project-allocation-tick、directory、runtime-assurance。provider-operating-sync 现有手动命令 `provider-operating-sync-once`（apps/worker/src/main.ts:98）。

## 6. 未尽事项（移交 WP2）

- Gateway 侧是否存在对 finance_state 的二次依赖（dispatch 链路）——WP2 按 §4.3 排查候选构建/结算触发器。
- 旧"共享冲销、对账"路径跨套餐混用的具体拆分粒度——WP2 产出写入口表时逐条负向测试。
