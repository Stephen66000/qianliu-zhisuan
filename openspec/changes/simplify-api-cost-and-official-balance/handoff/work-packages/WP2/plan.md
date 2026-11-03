# WP2 包计划：API 内部资金管理退出（tasks 4.1～4.4）

版本：v1.0；日期：2026-11-03；总指挥：GLM-5.3（zcode 会话）；实施：glm-flash 子 Agent（GLM-5.3-Flash，thoughtLevel: high，串行）。

## 1. 目标与依据

- 目标：**退出 API 内部资金写管理**（期初/充值/更正/对账/冲销/资源级 readiness 退役），**初始化/激活合同切分为套餐所需范围**，**解除 API 资金 PENDING 调用准入与创建/候选/结算依赖**，并**保留员工/项目/Key/套餐窗口/超额全部使用控制**；同步完成 WP1 移交的缺口码统一与 finance 开路径金额权威处置。
- tasks：4.1（写入口退役＋手填/旧候选旁路）、4.2（初始化/激活切分）、4.3（readiness 解除＋新迁移）、4.4（控制回归＋接口说明）。
- 验收 case（本包负责非浏览器部分）：AT-AFR-02/03/04/05/06/07/08/09/10；AT-X01（资金模式矩阵）/AT-X04（其他门禁）/AT-X05（升级不变）的机制层。AT-AFR-01/11/12/13/14 的浏览器/联调部分 → 待 WP4/WP5，本包不提前填 PASS。
- 依据：proposal/design（D3/D4/D6）、specs/api-funding-retirement、development-plan §4 WP2、WP0 contracts.md C3/C4/C5＋notes/inv-a.md（19 写入口判定表）、WP1/report.md §6 移交与 api-estimation-contract.md §4 裁定 1/2。

## 2. 输入基线与依赖

- worktree：`/Users/mac/Projects/仟流智算-api-decouple`，分支 `codex/simplify-api-cost-and-official-balance`，起点 HEAD `e4477b6`（＝远端 main `ae506fed…933e`＋WP0 文档 2 笔＋WP1 业务 2 笔＋WP1 结包 `a7444ea`＋WP2 任务书 `e4477b6`；2026-11-03 核验包含关系成立、工作树干净、远端 main 未前进）。
- 迁移水位：0000-0093 已占用（0092 员工额度、0093 source_status）；**本包新迁移从 0094 起**。
- WP1 依赖（已通过）：`loadApiCostEstimation` 聚合（金额权威）、合同文档 v1.1（缺口码双权威→本包统一；桥接字段→本包处置后端部分）。
- glm-flash 已探针确认可启动（2026-11-03，返回 OK）。
- 已冻结参数（用户 2026-11-03 确认）：**P4＝`410`＋`{error: "api_funding_management_retired"}`**；**P5＝`resources.operate`**（供 WP3 使用，本包仅记录）。

## 3. 交付物与允许修改范围

| 交付物 | 允许文件/模块 | 对应 requirement |
|---|---|---|
| S1 调查笔记（写入口表＋事实清单） | `handoff/work-packages/WP2/notes/inv-wp2.md`（新增，只读产物） | D3/D4、task 4.1 入口表 |
| 迁移 0094（解除种入触发器） | `packages/database/migrations/0094_*.js`（新增；不改 0000-0093） | AFR-02 |
| 准入解除 | `packages/database/src/repositories/resource-pool-repository.ts`（仅 :435-439 leftJoin/select＋:450 过滤及其联动；**不动 :443/:451**） | AFR-02 |
| 写入口退役 | `apps/control-api/src/provider-finance/routes.ts`（W1/W2/W3/W4/W9/W10/W11 退役；W7/W8 模式拆分）、`packages/database/src/repositories/provider-finance-events.ts` 或相应 repo（API 事实守卫）、contracts.ts（如需错误码类型） | AFR-01 |
| 激活/初始化切分 | `apps/control-api/src/provider-finance/activation-contracts.ts`、`activation-routes.ts`（如需）、`packages/database/src/repositories/provider-finance-activation-*.ts`（候选事实范围＋过时候选拒绝） | AFR-01 场景3、AFR-04 |
| 资源创建/手填旁路 | `apps/control-api/src/providers/routes.ts`（O2 校验调整）、`operating-bills/routes.ts`（O1 核查，仅在发现旁路时最小修补） | AFR-02、AFR-01 |
| 缺口码统一 | `packages/database/src/repositories/provider-finance-gaps.ts`、`operating-bill-finance-quality.ts`、`operating-bill-finance-projection.ts`、`monthly-operating-cost.ts` 及 S1 盘点的消费方；3 个钉死套件断言迁移（standard-home V14-C2/C3、finance-period-cost-integrity、home-cost-comparison） | AFR-07（数据层）、WP1 裁定 1 |
| finance 开路径金额权威 | `operating-bill-finance-projection.ts`（API 分量切估算；CP 投影/分摊/关账不动）、`apps/control-api/src/provider-finance/dashboard-projection.ts`（如需） | WP1 裁定 2、ACE-06 |
| 测试 | 各触及包的单测/集成测试；gateway 准入/额度集成 | 全部 |
| 接口说明 | 本目录 `retired-api-funding-contract.md`（退役响应＋存活入口清单，供 WP4/WP5） | task 4.1"更新停用响应文档" |

范围外（禁止触碰）：W5/W6 套餐合同与其 strict_writes 门禁语义、A3/A4 quiescence、0061/0081/0083/0092/0093 迁移文件本体、员工月度额度与 CPQW（quota_block_state :443）、evaluateAdmission（:451）、官方余额同步/Worker（WP3）、Web 页面与 CSV（WP4）、已关账版本与历史快照、C5 历史只读端点（GET 全部保留）、`strict_writes_enabled` 列与守卫触发器。相邻调用方确需改动时先报总指挥更新本表。

## 4. 总指挥决策（本包内生效）

1. **P4 落地口径**：退役端点（W1/W2/W3/W4/W9/W10/W11——经核实均为 API-only 概念）保留 `requireAuth`（认证＋`resources.operate` 权限照旧）后直接返回 `410 {error: "api_funding_management_retired", message: …迁移指引…}`；不再执行 `requireActive`（停用是既成事实，与模式/开关状态无关）；OFF 模式下路由不注册的现状保留（404）。W7（冲销）/W8（重复候选确认）为共享端点：保留原守卫链，在 repo 层按事实所属资源模式拆分——API 资金事实抛 `API_FUNDING_RETIRED`（映射 410），Coding Plan 事实走原逻辑。
2. **迁移 0094 内容**：DROP `provider_resource_finance_state_seed_trigger` 及函数（新资源不再种 PENDING）；`provider_resource_finance_state` 表与存量行**原样保留**（D4 留档；不批量置 READY、不删行）；down 恢复触发器。不改 0083 校验函数（路由层 410＋repo 守卫为指定攻击面；直接 DB 写非"入口"，且触发器加固会大面积破坏既有直插夹具——记录为已知边界）。
3. **准入解除**：删除 :450 `if (row.finance_state === "PENDING") continue;` 及其专用 leftJoin/select（该 join 仅为过滤服务）；凭证无效/EXHAUSTED/quota_block_state 等其他准入原样（:443/:451 不动）。
4. **激活切分**：`ActivationDraftSchema` 拒绝 `api_opening_balances` 非空提交（显式错误说明退役，不静默剥离）；`previewActivation` 候选事实范围收敛为套餐所需（服务端不再要求/回填 API 资金事实）；`activate` 对已持久化的含 API 资金事实旧候选拒绝并说明（新错误码 `CANDIDATE_CONTAINS_RETIRED_API_FACTS` 类，409）；已激活企业不可逆现状与 W5/W6 门禁不变；从未激活企业的 CP 独立初始化必须可行（AT-AFR-03）。drain/quiescence 语义仅在阻塞 CP 独立初始化时报总指挥裁定，不预改。
5. **缺口码统一（WP1 裁定 1 收口）**：`countFinanceGaps` 停产 `OPENING_BALANCE_MISSING`（恒 0 或移除该行，保形状恒 0 优先）；`API_USAGE_COST_*`/`API_COST_CURRENCY_*`（真实用量/价格缺口）、`SUBSCRIPTION_PERIOD_MISSING`/`CASH_PAID_CNY_MISSING`（套餐域，含历史 API_RECHARGE 现金证据）**保留**。账单 draft/finance 投影的桥接可算性缺口（API_OPENING_BALANCE_MISSING/API_BALANCE_BRIDGE_MISSING 等资金域码）对**当前期 draft** 停产；已关账快照冻结不动。3 个钉死套件按新口径迁移断言并注明依据。
6. **finance 开路径金额权威（WP1 裁定 2 后端部分）**：`projectOperatingBillFinance` 的 API 分量金额（apiCost/ledgerApiCost/totalCost/summary 同步字段）改由 `loadApiCostEstimation` 供给（与 draft 主口径同源）；CP 投影（packageCost/分摊/守恒）与 allocation 原样；opening/recharge/ending 桥接字段继续产出历史值（WP4 处置展示）；`apiSpendStatus/apiSpendReason` 切估算完整性口径。首页 finance 开路径 `monthlyRechargeAmount(s)` 保留资金读模型值（WP4 展示处置）。
7. **O1/O2 旁路**：O2 `financeManagedOperatingSnapshotError` 对 API 的"禁止快照携带资金字段"方向保留（禁止手填期初后门），文案按退役口径调整；O1 手填导入核查是否缺同款校验，缺则补最小同款守卫（仅此，不扩）。O1 整体保留为历史录入通道（inv-a 判定）。

## 4a. S1 调查后总指挥裁定（2026-11-03，依据 notes/inv-wp2.md，抽核 4/4 属实）

1. **R1 O1a 守卫（新写，不复用现函数）**：`financeManagedOperatingSnapshotError` 仅对 ADMIN 源生效，O1a 硬编码 BILL_RECONCILIATION（operating-bills/routes.ts:135）故恒放行。S3 在 O1a 路由校验中新写判定：**API 模式资源的快照行携带 7 个资金字段（recharge_amount/current_balance/cumulative_cost/current_period_cost/cost_period_start/cost_period_end/balance_updated_at）任一非空即拒绝**（4xx，错误说明资金管理已退役），不论快照日期——依据 AFR-01（旧入口不得新增 API 资金事实）＋design D5（不回填余额桥接金额）。CP 侧字段不受影响；PROVIDER_SYNC 源（Worker 官方同步，WP3 域）不经此路由，无冲突。O1b（经营账单手工期初，operating-bill 域）保留不动。
2. **R2 O1 权限语境**：O1a/O1b 属 `billing` 模块（`billing.operate`），非 resources——合同文档表述修正，守卫本身不改权限。
3. **R3 drain 解除 API 计数**：`collectDrainReport` 的 unpairedUsageLines 仅数 API 行（activation-repository.ts:421-426，`api_cost_status IS NULL AND resource_mode='API'`）。S4 将该计数改为恒 0/移除 API 条件（候选已不含 API 资金事实，API 用量分类状态与激活完整性无关）；在途工作项（inProgressRequests/openAttempts/pendingLedgerTransactions）保持模式无关。依据 AFR-04＋AFR-01 场景3（CP 独立初始化不得被 API 残留阻塞）。
4. **R4 S4 拒绝范围为 API 三类草稿全量**：`api_opening_balances`/`historical_api_recharges`/`historical_api_costs` 三键任一非空即拒绝（非仅 openings）；`legacy_purchase_resolutions` 中引用 API 充值的行同样拒绝（S4 实施时核实 closeLegacyPurchaseTx 是否写 API 事实，报回）。显式拒绝不剥离，与 candidate_hash 覆盖三类字段的事实一致（domain activation.ts:505-507）。
5. **R5 S4 激活投影 API 资金缺口全摘除**：`resolveOpeningAccounts` 的 API 资源段（scope-openings :170-195）、`collectUsageClassificationGaps` 的 API 行分类缺口、月度缺口计算在激活投影层**过滤为套餐/现金码集**（SUBSCRIPTION_PERIOD_MISSING、CASH_PAID_CNY_MISSING、订阅覆盖类）——不依赖 S5 的全局 countFinanceGaps 改动（视图层 API_USAGE_COST_* 保留，激活层不再消费）；四字段 usage repair（API 用量分类修复）随之退出候选。`markScopeResourcesReady`/`promoteResourceFinanceReady` 调用自 activate 移除（repo 方法保留存档）；strict_writes 置位保留。
6. **R6 repo 守卫落点**：仅 `reverseFinanceEvent`（NOT_FOUND 判定后按 `original.event_type` 前缀 `API_` 抛 `API_FUNDING_RETIRED`）与 `confirmDuplicateCandidate`（:297 分派前按 `candidate.event_type === "API_RECHARGE"` 同码）两处；**不得放 insertSubscriptionTx 等共享 Tx 原语**（worker 自动续订经其直写 CP 事件）。W1-W4/W9-W11 路由层 410 已覆盖，recordSimpleEvent 等不加守卫（保持测试直插可用，边界记入合同文档）。
7. **R7 计划范围表补正**：`provider-finance-activation-repository.ts` 与 `provider-finance-activation-facts.ts`/domain 投影文件（scope-openings/projection/conservation 相应段）纳入 S4 允许范围；W2 路由退役后 `assessResourceFinanceEnablement` 无生产调用方，模块保留存档（S3 决策）。0094 编号以本计划为准（inv-a"0093 起"已过时）。

## 4b. 阶段审核记录（随实施追加）

- **S6 复审（2026-11-03）**：生产代码零改动；新增 wp2-admission-gates（9 例：禁超额含"账户有钱仍拒"、allow_overage 计量、Key/项目/CPQW/归档/凭证/EXHAUSTED/PENDING 对照）＋wp2-cross-month-attribution（3 例：settled_at 归月、预占月、API 无期初 CP 续订）；既有锚点引用表齐备；retired 合同 §6 使用控制保留说明补齐。全量：gateway 250/250、database 569/570（唯一 w20 P95 负载 flake 隔离复绿）、control-api 475/475＋352/352、domain 409/409、worker 199/199、四包 typecheck/lint 0、openspec strict 校验通过。总指挥独立复跑 9/9＋3/3。裁定：①"EXHAUSTED→adminRecover 拒绝"为委派合同措辞错误，现行语义（隔离可经恢复流程）与 w11/AT-OAB-12 一致，电池按现状断言正确；②机制映射（归档＝人工停用、grant 禁用＝项目限制）接受；③worker reporting 测试副作用（3 已跟踪文件重渲染＋合成输出）已回置/清理。**关闭**。

- **S5 复审（2026-11-03）**：A1 恒 0 保形状（UNION 首列补别名）、A2 `BRIDGE_UNAVAILABLE`（中途裁定：不接受 CALCULABLE 配 null 谎报；消费方清单已核）、B 块 finance 投影切估算（S3b 同构：按资源＋全企业、estimatedApiCostFields、估算完整性口径）、missingAccountGaps 退役、CP/allocation/桥接字段/API_LEGACY_ARCHIVED 保留——逐项核对通过。中途批准：相邻测试迁移 3 文件＋同性质追加 3 文件（operating-feedback/cutover/w20-resource-insights）。pool043（WP1 遗留）断言已迁移：subjects 层实测 usage 事实口径（MIXED→null fail-closed，与 summary 部分金额并存属层级完整性语义差异，WP4/WP5 联调核对展示）。新增 wp2-finance-mode-parity（AT-X01/X05 机制：OFF/ACTIVE 字面相等＋关账冻结零变化）。总指挥独立复跑：DB 4 文件/44＋gateway pool043 9/9＋control-api pool025 9/9 全绿。**关闭**。`resource-insights/routes.ts:232` 兜底串留 WP4（清单外、无测试钉死）。

- **S3 复审（2026-11-03）**：生产 diff（routes 七端点 410＋financeFailure 特判、events.ts W7 前缀守卫＋REVERSAL 模式兜底、W8 候选分派前拒绝、O1a 新守卫复用 7 字段常量、O2 文案）、retired-api-funding-contract.md、参数化负向用例（401/410/错误码/四表零增量）逐项核对通过；总指挥独立复跑 3 文件/39 用例全绿。**关闭**。"冲销的冲销"核实：应用层可达、DB 层 0083 失败关闭，守卫把 409 收敛为 410。
- **S4 复审（2026-11-03）**：A1 superRefine 三类拒绝（哈希前）、A2 validateCandidate 内 assertCandidateFreeOfRetiredApiFacts（含 legacy API_RECHARGE 引用拒绝）、R3 drain API 计数移除、R5 摘除、legacy 双线反静默、loadMonthlyGaps 过滤（countFinanceGaps 未动）逐项核对通过。中途批准：偏离项 1（activation-contracts.test.ts 迁移）、裁定 3 补充（preview 反静默缺口）。**R8 裁定（复审发现）**：NEGATIVE_BALANCE 为激活 gap 且可达阻断 CP 初始化（AFR-04 违反）——豁免 API 账户的 NEGATIVE_BALANCE/BALANCE_FORMULA_MISMATCH 两类 gap（CP 正控保留），修复轮已回。子 Agent 报告 4 次误覆盖即时恢复，经 diff 统计＋全量绿核可接受。总指挥独立复跑 domain 409＋DB preview/apply 28（见回执）。**关闭**。空草稿＋仅 API 资源实测：GO_CANDIDATE（无账户→gaps=[]；有已定价用量无期初→R8 后亦 GO）。

- **S2 复审（2026-11-03）**：0094/repo diff/网关用例/typecheck 逐项核对通过；总指挥独立复跑迁移套件确认。发现两项非 S2 问题：
  1. **WP1 遗留（gateway `pool043-operating-bill-settlement.test.ts` 1 例失败）**：`expectUnknownApiCostBill` 辅助断言钉旧桥接口径（MIXED→apiCost null）；WP1 提交 9bf1560 已将 draft apiCost 切 `estimatedApiCostFields`（单币种部分金额照出＝ACE-04"展示已计价部分＋缺口说明"），且 WP1 验证清单未跑 gateway pool043 套件。归因：**代码符合 spec，断言未迁移**。处置：随 S5（draft 口径域）迁移该辅助断言并标注依据，不在 S2 静默处理；WP2 报告单独记录为 WP1 验证缺口。
  2. `w20-standard-capacity` P95 计时失败＝WP1 报告 §4.2-4 已记录的本机负载型既有 flake（S2 归因实测与该记录一致），不阻塞。
  3. S2 报告 §3.1 的 3 例 database 夹具失败（0083 要求 PENDING 行、0094 后需显式构造）——总指挥授权最小夹具修复（直插 PENDING 行，同文件既有模式），已派回 S2 执行。

## 5. 子 Agent 分工与顺序（串行，不并行）

| 序 | task | 内容 | 依赖 |
|---|---|---|---|
| S1 | 前置调查 | 只读：完成 19＋入口表（方法/路径/模式/旧行为/退役响应/是否写候选或资金/负向测试）；激活候选事实范围与 activate 写入面（MIGRATION 事件类型、drain/gaps 对 API 的依赖点）；W7/W8 事实模式判定路径；recordOpeningBalance 等 repo 函数全调用方；缺口码全消费方清单（含 monthly-operating-cost 状态位）；O1/O2 校验差集；既有测试盘点（断言旧行为的迁移清单） | 无 |
| S2 | 4.3 | 迁移 0094＋resource-pool-repository 准入解除＋gateway 集成（新资源无账户可服务、存量 PENDING 可服务、凭证错误仍阻断） | S1 |
| S3 | 4.1 | W1-W4/W9-W11 退役 410＋W7/W8 repo 层模式拆分＋O1/O2 旁路处理＋retired-api-funding-contract.md＋control-api 集成负向测试（参数化×退役入口，事实前后比对） | S1+S2 |
| S4 | 4.2 | ActivationDraftSchema 拒绝＋preview 事实范围切分＋activate 旧候选拒绝＋CP 独立初始化/续订集成＋strict writes 门禁不变断言 | S1+S3 |
| S5 | 4.1/移交 | 缺口码统一＋finance 开路径 API 金额切估算＋3 钉死套件迁移＋受影响消费方用例 | S1-S4 |
| S6 | 4.4 | 套餐/额度/门禁回归电池：员工月额度禁超额/允许超额、Key/项目限制、CPQW 窗口、人工停用、凭证无效、真实 EXHAUSTED（AT-X04 机制层）、跨月（AT-AFR-07 后端）、续订（AT-AFR-08 后端）；全量复跑＋typecheck/lint | S2-S5 |

每份委派含：目标/task/case、基线 SHA、允许文件清单、禁止事项、验收方法（真实测试入口＋非零用例数）、必交证据、回报格式。子 Agent 不得自审；提交仅在合同明文授权下进行（计划：S2+S3+S4 复审通过后一笔、S5+S6 复审通过后一笔，具体以复审时指令为准）。

## 6. 验证方法与完成条件

- 总指挥独立复核：逐 diff 对照 §3 范围表；抽读关键断言；独立复跑（database/control-api/gateway 相关 `test:integration`/`test`、触及包 typecheck/lint）；核对非零用例数（`passWithNoTests:true` 陷阱）。
- 证据目录：`V4/Evidence/API-COST-OFFICIAL-BALANCE/WP2-20261103/`（worktree 内新建；含命令、退出码、用例计数、关键断言摘录）。
- 完成条件（全部满足才勾选 tasks.md 4.1-4.4）：
  1. 退役入口参数化负向测试：410＋错误码、资金事实/候选/费用估算零变化（AT-AFR-02）；W5/W6/A3/A4 原行为回归绿；
  2. 混合候选拒绝且说明原因；CP 无 API 期初可独立初始化/购买/续订（AT-AFR-03/08 后端）；
  3. 新建无资金账户 API 资源可产生用量与估算；存量 PENDING 可服务；凭证无效/真实耗尽仍阻断（AT-AFR-04/05/06）；:443/:451 断言原样；
  4. 员工额度禁超额在官方余额充足时仍拒绝；allow_overage 计量不变（AT-AFR-09/10）；CPQW/Key/项目/停用门禁逐项有效（AT-X04 机制层）；
  5. OPENING_BALANCE_MISSING 类当前期缺口停产、用量/价格缺口保留；finance 开路径与 draft 主口径金额同源可核对（AT-X01 机制层）；已关账版本内容零变化（AT-X05）；
  6. 范围外文件零改动（`git diff --name-only` 对照 §3）；不删旧断言无依据；迁移 0094 在新库与升级库均通过。
- 已知边界：页面/浏览器/导出（WP4）、官方余额与刷新（WP3，P5 已冻结）、50 条总验收（WP5）、发布候选与回退演练（WP6）——本包证据不得写成端到端 PASS；生产版本/迁移水位核实仍为 WP0 遗留 BLOCKED（WP6 前补）。
