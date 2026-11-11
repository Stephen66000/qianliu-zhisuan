# WP2-S4 回执：初始化/激活合同切分为套餐所需范围（task 4.2 / AFR-01 场景3＋AFR-04）

日期：2026-11-03；子 Agent：GLM-5.3-Flash（WP2-S4）；基线：worktree `/Users/mac/Projects/仟流智算-api-decouple`，分支 `codex/simplify-api-cost-and-official-balance`（S2/S3 产物之上：0094、resource-pool-repository、routes/events/types/contracts/operating-bills、gateway wp2-pending-admission、0094 迁移等均未改动或回退，`git status` 核对）。

## 1. 实际改动文件与意图

### A1 草稿层拒绝（CA）
| 文件 | 意图 |
|---|---|
| `apps/control-api/src/provider-finance/activation-contracts.ts` | `ActivationDraftSchema` 新增 superRefine（排在既有 R2 去重 refine 之前）：`api_opening_balances`/`historical_api_recharges`/`historical_api_costs` 三数组**任一非空 → 400**，错误信息逐字为“API 内部资金管理已退役，初始化草稿不再接受 API 资金事实（api_opening_balances/historical_api_recharges/historical_api_costs），请仅提交套餐所需事实”；**不静默剥离**（拒绝发生在哈希与投影之前，不改变 candidate_hash 语义）。空数组（省略或 []）照常通过。三类行 schema 与 `toActivationDraft` 映射保留存档（注明提交入口已退役） |

### A2 过时候选拒绝（DB）
| 文件 | 意图 |
|---|---|
| `packages/database/src/repositories/provider-finance-activation-types.ts` | `ProviderFinanceActivationErrorCode` 联合类型加 `"CANDIDATE_CONTAINS_RETIRED_API_FACTS"`；`QuiescenceDrainReport.unpairedUsageLines/exoneratedUsageLines` 注明恒 0 语义（R3） |
| `packages/database/src/repositories/provider-finance-activation-coordinator.ts` | `validateCandidate` 在 `assertCandidateUsable` 之后、GO/哈希判定之前新增 `assertCandidateFreeOfRetiredApiFacts`（FOR UPDATE 锁内、任何写入前）：候选 `candidate_draft` 三键任一非空 → 抛 `CANDIDATE_CONTAINS_RETIRED_API_FACTS`；`legacy_purchase_resolutions` 引用 `purchase_type='API_RECHARGE'` 旧记录的行（类型以 DB 为准，草稿只有 legacy_record_id）→ 同码拒绝。`commitActivation` 移除 `markScopeResourcesReady` 调用与方法本体（R5）；`promoteResourceFinanceReady` repo 方法保留存档；strict_writes 置位、候选 ACTIVATED、审计、CP 事实写入全部保留 |
| `apps/control-api/src/provider-finance/activation-routes.ts` | `ACTIVATION_FAILURE_STATUS` 映射表加 `CANDIDATE_CONTAINS_RETIRED_API_FACTS: 409`（message 由协调器携带“……请重新预检仅含套餐所需事实的初始化草稿”） |

### R5 投影层 API 资金缺口摘除（domain ＋ facts）
| 文件 | 意图 |
|---|---|
| `packages/domain/src/provider-finance-activation-scope-openings.ts` | `resolveOpeningAccounts` 删除对 scope 内每个 API 资源的必要账户/期初要求循环（REQUIRED_CURRENCY_UNRESOLVED/MISSING_OPENING_BALANCE/MISSING_OPENING_EVIDENCE）；scope 账户推导、草稿期初对账结构、`collectScopeAndModeGaps`（UNKNOWN_RESOURCE/RESOURCE_MODE_MISMATCH）不动 |
| `packages/domain/src/provider-finance-activation-conservation.ts` | `collectUsageClassificationGaps` 删除 API 行四类分类缺口（UNKNOWN_COST/MISSING_API_CURRENCY/CONFLICTING_API_CURRENCY/MISSING_SETTLEMENT_TIME）；Token 守恒（所有行）与 CP 归属缺口不动；`computeMonthlyGapDeltas`/`mapMonthlyGapCode` 原样保留（API 抵消分支自然不可达） |
| `packages/domain/src/provider-finance-activation-projection.ts` | `collectLegacyResolutionGaps`：未被草稿引用的服务端扫描 API_RECHARGE 记录跳过关闭要求（R5 豁免）；**草稿显式引用** API 类旧记录 → 产出 `LEGACY_RECORD_UNCLOSED` 缺口＋退役说明文案（NO_GO，总指挥中途裁定 3 反静默）；PACKAGE_PURCHASE 关闭/MIGRATED 绑定/ALREADY_REPRESENTED 校验照常 |
| `packages/database/src/repositories/provider-finance-activation-facts.ts` | `loadMonthlyGaps` 消费过滤（激活域自己的消费点）：只保留 `SUBSCRIPTION_PERIOD_MISSING`、`CASH_PAID_CNY_MISSING`；**countFinanceGaps 本身不动**（S5 全局层）。预检/锁内复验/激活后守恒复算三个调用方共用同一口径 |

### R3 drain 解除 API 计数（DB）
| 文件 | 意图 |
|---|---|
| `packages/database/src/repositories/provider-finance-activation-repository.ts` | `collectDrainReport`：删除「`api_cost_status IS NULL AND resource_mode='API'`」计数 SQL，`unpairedUsageLines`/`exoneratedUsageLines` 恒 0；在途三项（inProgressRequests/openAttempts/pendingLedgerTransactions）语义不动；`options.excludeLedgerLineIds` 参数保留兼容调用点签名；注释注明 AFR-04/R3 依据 |

### 测试迁移（依据 inv-wp2 §6.1/§6.3，不删用例语义，逐处注明依据）
| 文件 | 意图 |
|---|---|
| `apps/control-api/src/provider-finance/activation-contracts.test.ts` | **偏离项 1（总指挥中途批准）**：API 三类行断言“提交即 400＋退役文案”；空数组/省略照常通过；行级 schema（OpeningBalance/HistoricalRecharge/HistoricalApiCost）转为存档级覆盖（strict 未知字段、UUID、订单号长度、切换时点边界、R2 去重链均保留） |
| `apps/control-api/src/__tests-integration__/provider-finance-activation.http.test.ts` | 混合草稿既有用例迁移：`previewOk` 改纯套餐草稿；API 期初证据断言迁移到 CP 购买行（语义不变）；新增三类 API 草稿“提交即 400＋说明文案”＋零候选断言；activate 成功用例改纯套餐语义（purchases 1/API 事件 0/states 0）；**新增 AT-AFR-03**：纯套餐 preview GO → activate 成功（strict_writes 开）→ W5 订阅写入 201 → W6 双次幂等取消；**新增**直插含 API 期初旧候选 → 409 `candidate_contains_retired_api_facts`＋零写入（strict_writes 仍关、事件/就绪行零增量）；DARK/排空用例改纯套餐载荷；A3/A4/quiescence 原样绿 |
| `packages/database/src/__tests-integration__/provider-finance-activation-preview.integration.test.ts` | 混合草稿 → 纯套餐化（依据 AT-AFR-03）；**新增 R5 用例**：API 资源＋已定价用量（2.00 CNY）＋无任何期初 → 纯套餐预检不因 API 资源出 REQUIRED_CURRENCY_UNRESOLVED/MISSING_OPENING_BALANCE（边界记录：余额投影保留，NEGATIVE_BALANCE 仍出现，见 §3） |
| `packages/database/src/__tests-integration__/provider-finance-activation-apply.integration.test.ts` | 混合草稿成功用例纯套餐化（零金额修复行保持余额守恒不受影响）；API 事实激活叙事三例（充值迁移/无旧记录充值/历史消耗 0084）迁移为 A2 拒绝断言（零写入、候选 PREVIEWED），其 Tx 原语级合同（订单号唯一索引 23505、0084 负金额落账形状）保留为直测（R6 边界）；READY 断言改零行；排空计数断言改 R3 恒 0；**新增** A2 两例（直插含 API 期初候选、纯套餐候选引用 API_RECHARGE 旧记录）＋ **新增 R3 用例**（api_cost_status IS NULL API 行存在时 preview/activate 不被排空阻塞，行分类状态原样保留） |
| `apps/control-api/src/__tests-integration__/provider-finance-wp07-acceptance.http.test.ts` | 全链用例激活部分改纯套餐草稿；DeepSeek 期初/充值历史事实改 SQL 直插（source=MIGRATION，0083 口径不变）→ 余额 107.30/137.30、账单 opening/ending/recharge 读模型断言全部保持成立；NO_GO 缺口精度用例迁移（MISSING_PURCHASE_AMOUNT/UNATTRIBUTED_PLAN_USAGE/LEGACY_RECORD_UNCLOSED(PACKAGE)/OPERATING_BILL SUBSCRIPTION_PERIOD_MISSING；MISSING_OPENING_BALANCE 断言缺席）；W4 相关断言 S3 已迁移（410）原样 |
| `packages/domain/src/__tests__/provider-finance-activation-projection.test.ts` | 夹具 legacy 记录 API_RECHARGE→PACKAGE_PURCHASE（仍在激活合同内的关闭域只剩套餐采购）；MISSING_OPENING_BALANCE/UNKNOWN_COST/MISSING_API_CURRENCY/CONFLICTING_API_CURRENCY/MISSING_OPENING_EVIDENCE 五例迁移为缺席断言（R5）；**新增 R4 反静默用例**（草稿显式引用 API_RECHARGE 记录 → 退役缺口；未引用记录 → 零缺口） |
| `packages/domain/src/__tests__/provider-finance-activation-hardening.test.ts` | `collectUsageClassificationGaps` 四例迁移为缺席断言；排序稳定性改用 TOKEN_CONSERVATION_MISMATCH 行验证（同一“按行 id 稳定排序”性质） |

## 2. A2 校验位置选择与理由

**位置**：`coordinator.validateCandidate` 内、`assertCandidateUsable`（状态/TTL）之后、GO 结论/候选哈希判定之前（总指挥中途裁定 2 批准）。
**理由**：(1) 此时候选行已 `FOR UPDATE` 锁定、尚未写入任何事实——最早的拒绝点，保证零写入（AFR-01 场景3“拒绝并说明原因，不静默激活”）；(2) 早于 `assertQuiescent`/`reverifyCandidate`，含 API 事实旧候选不必等待租约/水位复算即快速失败，错误语义独立于 CANDIDATE_STALE/CANDIDATE_NOT_READY（客户端得到明确的“重新预检纯套餐草稿”指引而非误导性的重试循环）；(3) 判定依据是 `candidate_draft` 内容而非候选哈希（哈希覆盖三类字段，改动草稿规范化会改变哈希语义，inv-wp2 §2.2/§7.4）。**legacy API_RECHARGE 行**：类型在 DB `resource_purchase_record.purchase_type`，纯 schema 层不可判定——A2 内一次 `IN` 查询判定并同码拒绝；预检侧反静默由 domain `collectLegacyResolutionGaps` 产出退役缺口（裁定 3）。

## 3. 空草稿＋仅 API 资源的实际行为记录（R5 边界，实测）

只读探针（临时测试文件，运行后已删除，不入 diff）：
1. **从未激活＋仅一个 API 资源＋切换前快照账户（CNY）＋空草稿** → `decision=GO_CANDIDATE, gaps=[], scopeAccounts=1`（`[WP2-S4-PROBE-1]`）。
2. **从未激活＋仅一个 API 资源＋无任何账户来源＋空草稿** → `decision=GO_CANDIDATE, gaps=[], scopeAccounts=0`（`[WP2-S4-PROBE-2]`）。
即：R5 后空草稿对仅 API 资源企业出 **GO**（原 REQUIRED_CURRENCY_UNRESOLVED/MISSING_OPENING_BALANCE 阻塞已消失）。
**边界记录（初审时点）**：已定价有金额的 API 用量且无期初时，余额投影曾报 `NEGATIVE_BALANCE`——总指挥复审认定为 AFR-04 违反，**已由 R8 修复**（见 §8）：API 账户的 NEGATIVE_BALANCE/BALANCE_FORMULA_MISMATCH 缺口随资金守恒退役摘除，上述场景（preview integration 用例）现断言 gaps 为空且 decision=GO_CANDIDATE。

## 4. 命令、退出码、用例数

| 命令 | 结果 |
|---|---|
| `corepack pnpm@11.11.0 --filter @qianliu/control-api run test:integration` | **Test Files 42 passed (42) / Tests 352 passed (352)**，退出码 0 |
| `corepack pnpm@11.11.0 --filter @qianliu/database exec vitest run src/__tests-integration__/provider-finance-activation-preview.integration.test.ts src/__tests-integration__/provider-finance-activation-apply.integration.test.ts` | **2 files / 28 tests passed**（preview 5＋apply 23），退出码 0 |
| `corepack pnpm@11.11.0 --filter @qianliu/domain run test` | **22 files / 408 tests passed**，退出码 0 |
| `--filter @qianliu/database exec vitest run`（migration/repository/cutover/resource-opening/ledger 五套件回归） | **5 files / 28 tests passed**，退出码 0 |
| `--filter @qianliu/control-api exec vitest run src/provider-finance/activation-contracts.test.ts` | **22 tests passed**（control-api 单测脚本 `test` 范围，不在 test:integration 内） |
| `--filter @qianliu/{domain,database,control-api} run typecheck` | 三包退出码均 0 |
| `--filter @qianliu/{domain,database,control-api} run lint` | 三包退出码均 0 |

## 5. 偏离处（均已报总指挥并获裁定）

1. **`activation-contracts.test.ts` 迁移（偏离项 1，中途报备获批准）**：不在原允许清单，但 A1 语义变更的直接同源后果（约 20 处断言旧行为）；按“提交即 400＋退役文案”最小迁移，行级 schema 转存档级覆盖。允许清单据此扩充该文件。
2. **中途裁定 3 落地**：preview 投影层（`collectLegacyResolutionGaps`）对草稿显式引用 API_RECHARGE 旧记录产出 `LEGACY_RECORD_UNCLOSED` 退役缺口（NO_GO＋文案）；未引用的服务端扫描记录零缺口（R5 豁免）。复用既有缺口码（合同未允许新增 ActivationGapCode），说明文案点明退役。
3. **实施工具事故（无代码影响）**：会话中三次部分 Write 误覆盖 coordinator/repository/routes/projection 文件，均在下一步立即以完整内容重写恢复，最终以 typecheck/lint/全量测试验证与预期一致；`git diff --stat` 核对各文件改动范围与 §1 意图一一对应。
4. 计划内迁移联动（合同允许清单内、注明依据）：apply 测试的修复行金额改 0（纯套餐下无期初对冲，保持余额守恒不被触发，修复路径断言不变）；wp07 历史事实直插（AFR-01 后草稿不再携带 API 事实的必然联动，与 S3 同模式）。
5. **R8 修复轮（总指挥复审裁定，追加允许清单 `provider-finance-activation-balances.ts` 及其测试）**：见 §8。

## 6. 剩余问题

1. **NEGATIVE_BALANCE 边界已由 R8 修复**（见 §8）：API 账户的两类余额守恒缺口已退役，CP 账户正控保留；无遗留。
2. **S5 待办（未触碰）**：countFinanceGaps 全局层（OPENING_BALANCE_MISSING 停产）、draft/finance 投影桥接口径、3 钉死套件、gateway pool043 断言；视图层 API_USAGE_COST_* 缺口仍保留（本包测试中已注明双口径）。
3. **CA 单测脚本范围**：`activation-contracts.test.ts` 属 `test`（单测）而非 `test:integration`——S6 全量复跑须含 `--filter @qianliu/control-api run test` 与 `--filter @qianliu/domain run test`。
4. 无阻塞项；W5/W6/A3/A4/quiescence/DARK 原行为回归绿。

## 7. 证据路径

- 本回执：`V4/Evidence/API-COST-OFFICIAL-BALANCE/WP2-20261103/s4-receipt.md`
- 关键实现：`apps/control-api/src/provider-finance/activation-contracts.ts`（A1 superRefine）、`packages/database/src/repositories/provider-finance-activation-coordinator.ts`（A2 assertCandidateFreeOfRetiredApiFacts＋markScopeResourcesReady 移除）、`packages/database/src/repositories/provider-finance-activation-facts.ts`（月度缺口消费过滤）、`packages/database/src/repositories/provider-finance-activation-repository.ts`（R3 drain）、`packages/domain/src/provider-finance-activation-{projection,conservation,scope-openings}.ts`（R5）、`packages/domain/src/provider-finance-activation-balances.ts`（R8）
- 测试迁移：上表六个测试文件；R5 边界探针输出 `[WP2-S4-PROBE-1/2]`（本回执 §3 记录，探针文件已删）

## 8. R8 修复轮（总指挥复审裁定，2026-11-03）

**裁定依据**：`NEGATIVE_BALANCE`/`BALANCE_FORMULA_MISMATCH` 是激活投影 gap（balances.ts，gaps 非空 → NO_GO）；可达路径「从未激活企业先产生无期初的 API 计价用量 → 纯套餐草稿 preview → API 账户投影余额为负 → NO_GO」使套餐初始化被 API 余额缺失阻断，违反 AFR-04 与 task 4.2 验收项。

**Diff（改动最小实现：在 `projectAccountBalances` 内按资源 mode 判定）**：
- `packages/domain/src/provider-finance-activation-balances.ts`：函数首部由 `input.resources` 构建 API 资源 id 集；余额证据循环内，API 资源账户**不再发射** `NEGATIVE_BALANCE` 与 `BALANCE_FORMULA_MISMATCH` 两类 gap（`continue` 跳过发射段）；CP 资源账户两项检查原样保留；`accounts` 证据数组照常产出（`formulaMatches` 字段照常计算，供读侧观察）。注释注明 R8/AFR-04 依据。
- 测试同步（逐处注明 R8/AFR-04 依据）：
  - `packages/database/src/__tests-integration__/provider-finance-activation-preview.integration.test.ts`：R5 新用例反转——已定价 2.00 用量无期初场景断言 gaps **不含** NEGATIVE_BALANCE/BALANCE_FORMULA_MISMATCH、`gaps=[]` 且 `decision=GO_CANDIDATE`；用例名改注 R5＋R8。
  - `packages/domain/src/__tests__/provider-finance-activation-projection.test.ts`：零期初负余额用例迁移（API 账户 → decision GO、gaps 空、balance 字段保留 -5）；BALANCE_FORMULA_MISMATCH 用例迁移（API → 无缺口、formulaMatches 字段保留 false）＋**新增 CP 正控**（PLAN 账户漂移 → NO_GO＋缺口 detail “重算 0.00000000 ≠ 已落库 -9.00000000”）。
  - `packages/domain/src/__tests__/provider-finance-activation-hardening.test.ts`：`projectAccountBalances` 两例正控迁移为「API → 无缺口（字段保留）＋ CP 正控保留原精确断言」（夹具补 scope 资源 mode；CP 公式失配正控用正数 components 保证只触发一种缺口）。其余 balances 用例（叠加/空分量/排序）不受影响。

**命令、退出码、用例数（R8 复跑）**：

| 命令 | 结果 |
|---|---|
| `corepack pnpm@11.11.0 --filter @qianliu/domain run test` | **22 files / 409 tests passed**（较初审 +1：CP 正控新用例），退出码 0 |
| `--filter @qianliu/database exec vitest run src/__tests-integration__/provider-finance-activation-preview.integration.test.ts src/__tests-integration__/provider-finance-activation-apply.integration.test.ts` | **2 files / 28 tests passed**，退出码 0 |
| `corepack pnpm@11.11.0 --filter @qianliu/control-api run test:integration` | **42 files / 352 tests passed**，退出码 0 |
| `--filter @qianliu/{domain,database,control-api} run typecheck` | 三包退出码均 0 |
| `--filter @qianliu/{domain,database,control-api} run lint` | 三包退出码均 0 |

**R8 后行为结论**：从未激活企业存在无期初的 API 计价用量（任意金额）时，纯套餐草稿 preview 出 GO、activate 可完成（AT-AFR-03/AFR-04 满足）；API 账户余额/公式漂移仅保留在 `projected.accounts` 证据字段（formulaMatches/balance）供读侧观察，不再构成激活前置；CP 资源账户的两类守恒缺口正控由 domain 两测试文件钉死。
