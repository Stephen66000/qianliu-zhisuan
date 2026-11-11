# WP2-S3 回执：API 资金写入口退役（task 4.1 / AFR-01 / AT-AFR-02）

日期：2026-11-03；子 Agent：GLM-5.3-Flash（WP2-S3）；基线：worktree `/Users/mac/Projects/仟流智算-api-decouple`，分支 `codex/simplify-api-cost-and-official-balance`（S2 产物之上，S2 修改未被回退：0094 迁移、resource-pool-repository.ts、provider-finance-activation-migration.integration.test.ts、provider-finance-repository.integration.test.ts 的 S2 段、gateway wp2-pending-admission 均保持原样）。

## 1. 实际改动文件与意图

| 文件 | 意图 |
|---|---|
| `packages/database/src/repositories/provider-finance-types.ts` | `ProviderFinanceError` code 联合类型加 `"API_FUNDING_RETIRED"`（唯一类型层改动） |
| `packages/database/src/repositories/provider-finance-events.ts` | W7 守卫：`reverseFinanceEvent` NOT_FOUND 判定后，`original.event_type` 前缀 `API_` → 抛 `API_FUNDING_RETIRED`；REVERSAL 行（冲销的冲销）按 `original.provider_resource_id` 对应资源 mode 兜底（API → 同码拒绝）。W8 守卫：`confirmDuplicateCandidate` PENDING 分派前 `candidate.event_type === "API_RECHARGE"` → 同码抛出（候选保持 PENDING、零写入，原 API 分派行移除）。守卫未放 insertSubscriptionTx/insertFinanceEventTx 等共享 Tx 原语（R6） |
| `apps/control-api/src/provider-finance/routes.ts` | W1/W2/W3/W4/W9/W10/W11 七个 handler 全部替换为 `preHandler: [requireAuth]`（移除 requireActive）＋ `retiredApiFunding(reply)` 统一 410 合同响应（helper 注明 AFR-01/P4）；不做 body/params 校验、不调 repo。`financeFailure` 特判 `API_FUNDING_RETIRED` → 410＋`api_funding_management_retired`（小写化产出 `api_funding_retired` ≠ 合同码，故特判）。移除 `assessResourceFinanceEnablement` import 与仅 W2 使用的 `activationFailure`/`ProviderFinanceActivationError`；W5/W6/W7/W8 仍走原 `writeGuards`；OFF 不注册现状不动（server.ts 未改） |
| `apps/control-api/src/providers/contracts.ts` | O2：`financeManagedOperatingSnapshotError` API 分支 message 切退役口径（"API 内部资金管理已退役，资金字段不接受手填：…"），判定逻辑与 CP 分支文案不动。新增导出 `retiredApiFundingSnapshotFieldsError(mode, snapshot)`（R1：对 API 模式＋7 资金字段任一非空 → 拒绝文案；不复用 ADMIN-only 的现函数） |
| `apps/control-api/src/operating-bills/routes.ts` | O1a：逐行校验处在 `operatingSnapshotModeError` 之前调用新守卫，命中 → 400 `invalid_import_row`（message 前缀"第 N 行："），CP 侧字段校验不动 |
| `packages/database/src/__tests-integration__/provider-finance-repository.integration.test.ts` | :173 用例冲销步迁移为 `rejects API_FUNDING_RETIRED`＋零事件写入＋余额 160；:262 用例 `cashOutflowCny` 199→299（充值实付不再被冲销）；:381 用例 API 候选确认迁移为同码拒绝＋PENDING 不变，过期分支原样；新增隔离企业用例（API 事实冲销拒绝、CP 冲销照常含 `reversed_by_event_id`、CP 候选确认消费＋幂等重放） |
| `apps/control-api/src/__tests-integration__/provider-finance.test.ts` | 见 §3 逐用例清单 |
| `apps/control-api/src/__tests-integration__/provider-finance-wp07-acceptance.http.test.ts` | 用例 2 激活前写 503→410；用例 5 W4 充值 201→410＋SQL 直插构造该事实（二选一处取"直插"，保持 BALANCE_AFTER_POST_RECHARGE/摘要 50.00 等后续断言成立） |
| `apps/control-api/src/__tests-integration__/pool025-operating-bill.test.ts` | 快照导入（API 资源＋资金字段）201→400＋零写入断言；新增 O1a 守卫用例（7 字段逐一组合 → 400＋退役文案；CP 资源 package 字段 → 201） |
| `openspec/.../WP2/retired-api-funding-contract.md` | 新建：19 入口表、410 响应合同（鉴权先行/OFF 不注册/DARK 也 410）、存活入口与权限模块（R2 billing vs resources）、守卫边界（含 0083 直写防御已知边界） |

## 2. 命令与退出码/用例数（真实测试入口，无 passWithNoTests 掩盖）

| 命令 | 结果 |
|---|---|
| `corepack pnpm@11.11.0 --filter @qianliu/control-api run test:integration`（最终复跑） | **Test Files 42 passed (42) / Tests 350 passed (350)**，退出码 0（首跑 1 失败＝wp07 用例 2 的 503→410 断言迁移遗漏，已修复后复跑全绿） |
| 同上（修复后单文件复跑）`vitest run src/__tests-integration__/provider-finance-wp07-acceptance.http.test.ts` | 11/11 通过 |
| `--filter @qianliu/control-api exec vitest run src/__tests-integration__/provider-finance.test.ts` | 19/19 通过（含 7 个参数化负向用例） |
| `--filter @qianliu/control-api exec vitest run src/__tests-integration__/pool025-operating-bill.test.ts` | 9/9 通过 |
| `--filter @qianliu/database exec vitest run src/__tests-integration__/provider-finance-repository.integration.test.ts` | 11/11 通过（原文件 10 例＋新增 1 例；首跑 1 失败＝cashOutflowCny 联动，已迁移） |
| `--filter @qianliu/database exec vitest run src/__tests-integration__/provider-finance-ledger.integration.test.ts src/__tests-integration__/pool043-operating-bill-accounts.integration.test.ts src/__tests-integration__/provider-finance-activation-migration.integration.test.ts` | 3 文件 21/21 通过（0083/0059 合同、CP 冲销、S2 迁移套件回归绿） |
| `--filter @qianliu/database exec vitest run src/repositories/provider-finance-resource-enablement.test.ts` | 6/6 通过（模块存档，测试本就 repo 级、无路由依赖） |
| `--filter @qianliu/control-api run typecheck` / `--filter @qianliu/database run typecheck` | 退出码 0 / 0 |
| `--filter @qianliu/control-api run lint` / `--filter @qianliu/database run lint` | 退出码 0 / 0（`--max-warnings=0`） |
| 全量复跑（§2 第 1 行修复后） | 见回执末尾"复跑记录"（后台任务 `exec_c4e828d4`） |

## 3. 逐用例迁移清单（旧断言 → 新断言 ＋ 依据）

### apps/control-api/src/__tests-integration__/provider-finance.test.ts

| 用例（原行号） | 旧断言 | 新断言 | 依据 |
|---|---|---|---|
| :66 "does not expose ACTIVE writes…" | W4 未激活 503 `finance_write_contract_inactive` | 410 `api_funding_management_retired`；更名 "retired API funding writes return 410 regardless of activation state" | AFR-01/plan §4.1：退役与激活状态无关，503 分支不可达 |
| :100 成功链（W1 201→W4 201/幂等 200→余额 150→W3 201→W7 冲销 201→W9 201→W10 200/重放→余额 65→GET 读） | 全部成功路径 | 更名 "retired API funding writes keep historical facts readable and write nothing"：历史事实直插构造（期初 50/更正 10/充值 100/对账案件 OPEN→调整 -95→RESOLVED 同事务，复现余额 65 使 W5 用例读模型断言零改动）；W1/W3/W4/W7(API 事件)/W9/W10 全部 410＋错误码；事件/候选/对账/幂等四表计数前后相等；GET balance=65、events total=1、cases RESOLVED total=1、resources 月视图（monthlyRecharge 0→100，注明"冲销退役后月度充值读数为历史事实原值"） | AFR-01/AT-AFR-02/plan §4.1 |
| :181 "records a Coding Plan…"（W5 回归） | 内嵌 USD 期初经 W1 201 | USD 期初改直插（多币种同点 0083 口径不变）；`cashOutflowCny` 199→299（充值实付不再被冲销）；其余断言原样（W5 成功/周期/摘要/账单） | AFR-01；W5 用例本体"不动"原则 |
| :584 重复候选确认 | W4 充值产生 API_RECHARGE 候选→确认 201→重放 200 | 拆分：CP 候选经 W5（购买→重复 409→确认 201→重放 200→候选 CONSUMED）保留原断言；API_RECHARGE 候选直插夹具（token 哈希复刻 stableHash）→确认 410＋候选 PENDING＋零事件写入 | AFR-01/plan §4.1/inv-wp2 §6.1 |
| :613 跨模式 | W4 on CP 资源 409 INVALID_MODE；重复外部引用 409 `finance_contract_conflict` | 两处均 410＋退役码（410 优先于模式/合同校验）；GET periods 404 与 PATCH 快照 409 `finance_entry_moved` 分支原样保留 | AFR-01/plan §4.1；O2 未动 |
| :643 readiness 闭环 | W2 200 PENDING 阻断/READY 提升/幂等；W1 201 期初 | 更名 "retired readiness and opening endpoints cannot promote a PENDING resource"：readiness 三次均 410、期初 410、状态行保持 PENDING version 1 | AFR-01/plan §4.1；PENDING 调度拦截已由 S2（0094＋准入解除）解除 |
| :697 DARK | W4 写 DARK 404 | W4 写 DARK **410**＋退役码（新增断言）；另加 W1 DARK 410；新增 W5/W6 在 DARK 下仍 **404** 断言（requireActive 原样）；balance GET 200、close 200 原样 | P4 冻结响应/plan §4.1（合同文档写明 DARK 410、OFF 404） |
| :733 初始化旁路 | W1 越权 409 `resource_finance_scope_conflict`；W1 缺证据 400；W4 缺/空证据 400（message 含"证据"） | 四个请求全部 410＋退役码；更名 "retired initialization-bypass entrypoints return 410 without validation"；注明 409/400 分支不可达、旁路语义由 S4 草稿拒绝承接 | AFR-01/plan §4.1/§4.4 |
| 新增 | — | 参数化负向用例 it.each × 7 退役端点（W1/W2/W3/W4/W9/W10/W11）：已认证 → 410＋`api_funding_management_retired`＋固定 message＋四表零增量；未认证 → 401 | AT-AFR-02（合同 §5 验收 1） |

### 其他文件

| 位置 | 旧 → 新 | 依据 |
|---|---|---|
| wp07 用例 2 :453 | 503 `finance_write_contract_inactive` → 410＋退役码（"激活前不得出现任何资金事实"由退役合同承接） | AFR-01/plan §4.1 |
| wp07 用例 5 :610 | W4 充值 201 → 410＋退役码；后续充值事实 SQL 直插（source=ADMIN，0083 校验同前），BALANCE_AFTER_POST_RECHARGE/摘要 apiRecharges 50.00 等下游断言全部保持成立 | AFR-01/AT-AFR-02；合同"二选一"取直插并注明 |
| pool025 :571 | 快照导入（API＋current_balance/current_period_cost/cost_period_*）201 → 400 `invalid_import_row`＋message 含退役文案＋BILL_RECONCILIATION 快照零写入断言 | AFR-01/R1 |
| pool025 新增 | 7 资金字段逐一组合 → 400＋"API 内部资金管理已退役/资金字段不再接受手填导入"；CP 资源 package 字段导入 → 201 | R1/AT-AFR-02 |
| DB repo :173/:207 | `reverseFinanceEvent` 成功＋余额 60 → `rejects API_FUNDING_RETIRED`＋零写入＋余额 160 | AFR-01/plan §4a-R6 |
| DB repo :262/:293 | cashOutflowCny 199 → 299 | 同上联动（充值实付不再被冲销） |
| DB repo :381/:404 | API 候选确认 201/重放 → `rejects API_FUNDING_RETIRED`＋PENDING 不变＋零写入；过期候选 CONFLICT 分支原样 | AFR-01/R6 |
| DB repo 新增隔离用例 | API 冲销同码拒绝零写入；CP 冲销照常（REVERSAL＋period.reversed_by_event_id）；CP 候选确认消费＋幂等重放 | R6（"CP 事件冲销照常；CP 候选照常"） |

## 4. W7"冲销的冲销"核实结论

**可达但 DB 层已失败关闭**：`reverseFinanceEvent` 选取 original 时不筛 `event_type`，传入 REVERSAL 事件 id 在应用层可达；但 0083 触发器的 REVERSAL 分支只允许冲销 `API_RECHARGE / CODING_PLAN_PURCHASE / CODING_PLAN_RENEWAL`（`reversal must exactly negate an eligible original event`），故原实现下"冲销的冲销"会在落库时被 0083 拒绝（409 `finance_contract_conflict`、零写入），不存在 API 资金事实复活路径。按合同"若有→mode 兜底"，S3 守卫对 REVERSAL 行按 `original.provider_resource_id` 对应资源 mode 判定：API 资源上的 REVERSAL 返回 410（比 409 更精确），Coding Plan 冲销链不受影响。两种路径零写入语义均成立。

## 5. 偏离与需总指挥知悉的事项

1. **无范围偏离**：改动文件全部在合同允许清单内；`packages/database/src/exports/provider-finance.ts` 未改（无新增导出需求，`ProviderFinanceError` 已导出）；S2 产物零改动（git status 核对）。
2. **计划内迁移联动 2 处**（合同未逐条列出、属"既有断言旧行为"必然联动，已注明依据）：DB repo :262 的 `cashOutflowCny` 199→299；provider-finance.test.ts :181 内嵌 USD 期初改直插＋同用例 `cashOutflowCny` 199→299。均为"冲销退役后充值实付不再被负向抵消"的直接后果，非语义改动。
3. **W2 路由退役后** `assessResourceFinanceEnablement`（CA import）与 `activationFailure`/`ProviderFinanceActivationError`（仅 W2 使用）一并从 routes.ts 移除；`provider-finance-resource-enablement.ts` 模块与单测按 plan §4a-R7 保留存档（单测本就 repo 级、无路由依赖，未改）。
4. **未解决问题**：无阻塞项。WP1 遗留的 gateway pool043 断言迁移（S5 范围）与 O1b/官方余额（WP3）未触碰。

## 6. 复跑记录（修复 wp07 用例 2 后）

- `provider-finance-wp07-acceptance.http.test.ts`：**11/11（退出码 0）**。
- 全量 control-api `test:integration` 复跑：**Test Files 42 passed (42) / Tests 350 passed (350)，退出码 0**（vitest 摘要行：`Test Files  42 passed (42)` / `Tests  350 passed (350)`；含 [WP07-EVIDENCE] 归档输出，其中直插的后续充值事实以 source=ADMIN、external_reference=SYN-API-PAY-2 可见）。
- database 触及套件合计：11（repository）+ 21（ledger/pool043/activation-migration）+ 6（enablement 单测）= **38 例全绿**。
- 最终 `typecheck`：control-api 退出码 0、database 退出码 0；`lint`（--max-warnings=0）：双包退出码 0。

## 7. 证据路径

- 合同文档：`openspec/changes/simplify-api-cost-and-official-balance/handoff/work-packages/WP2/retired-api-funding-contract.md`
- 本回执：`V4/Evidence/API-COST-OFFICIAL-BALANCE/WP2-20261103/s3-receipt.md`
- 关键实现：`apps/control-api/src/provider-finance/routes.ts`（retiredApiFunding/financeFailure 映射）、`packages/database/src/repositories/provider-finance-events.ts`（W7/W8 守卫）、`apps/control-api/src/providers/contracts.ts`（retiredApiFundingSnapshotFieldsError/O2 文案）、`apps/control-api/src/operating-bills/routes.ts`（O1a 守卫）
