# WP2 结包报告：API 内部资金管理退出（tasks 4.1～4.4）

包：WP2；总指挥/模型：GLM-5.3（zcode 会话）；实施：glm-flash 子 Agent（GLM-5.3-Flash，`thoughtLevel: high`），串行 S1（只读调查）→S2→S3→S4（含 R8 修复轮）→S5→S6，另有两轮中途报备裁定与两轮追加授权。日期：2026-11-03。**结论：通过**（遗留项见 §4.2，均不阻塞 WP3）。

## 1. 基线与工作区状态

- 起点基线：`e4477b6`（分支 `codex/simplify-api-cost-and-official-balance`；＝远端 main `ae506fed…933e`＋WP0 文档 2 笔＋WP1 业务/结包 3 笔＋WP2 任务书；包含关系与远端 SHA 均复核，开工时工作树干净）。
- 终点基线：`52fe37d`（`feat(funding-retirement): retire API internal funding management (WP2 tasks 4.1-4.4)`，48 文件，+3507/−1054）← 本报告文档提交随包另行提交（见 §2）。
- 迁移水位：0094 新增（`0094_retire_api_finance_pending_admission.js`：DROP 0081 种入触发器/函数，表与存量行留档，down 逐字恢复）；0000-0093 未触碰。
- 已冻结参数（用户 2026-11-03 确认）：**P4＝410＋`api_funding_management_retired`**（已落地）；**P5＝`resources.operate`**（WP3 使用，仅记录）。
- glm-flash 探针 OK 后方委派；环境（pnpm 11.11.0/Docker 28.0.1/依赖）复验与 WP1 一致。

## 2. 计划 vs 实际交付（plan.md §5 对照）

| 阶段 | 计划 | 实际 | 提交/证据 |
|---|---|---|---|
| S1 | 只读调查六节 | 完成：inv-wp2.md 八节（19 入口表、激活事实链、旁路审计、缺口码消费方、O1/O2 差集、测试盘点）；总指挥四项抽核属实 | 52fe37d 前置；notes/inv-wp2.md |
| S2 (4.3) | 0094＋:450 解除＋网关三用例 | 完成＋追加一轮 3 例 0083 夹具修复（直插 PENDING，授权清单扩充） | 52fe37d；s2-receipt |
| S3 (4.1) | 七端点 410＋W7/W8 拆分＋O1a 守卫＋O2 文案＋合同文档＋参数化负向 | 完成；"冲销的冲销"核实（应用可达/DB 失败关闭，守卫收敛 409→410） | 52fe37d；s3-receipt；retired-api-funding-contract.md |
| S4 (4.2) | 草稿拒绝＋旧候选拒绝＋投影摘除＋drain 解除＋CP 独立初始化 | 完成＋R8 修复轮（NEGATIVE_BALANCE/BALANCE_FORMULA_MISMATCH 豁免 API 账户，CP 正控钉死）；空草稿＋仅 API 资源实测 GO | 52fe37d；s4-receipt（含 §8） |
| S5 | 缺口码统一＋finance 开路径金额权威＋pool043 迁移 | 完成；新增 wp2-finance-mode-parity（AT-X01/X05 机制）；BRIDGE_UNAVAILABLE 新枚举（总指挥裁定） | 52fe37d；s5-receipt |
| S6 (4.4) | 门禁电池＋跨月/续订＋接口说明＋全量复跑 | 完成：wp2-admission-gates 9 例＋wp2-cross-month-attribution 3 例＋retired 合同 §6 | 52fe37d；s6-receipt |

- 提交策略调整（总指挥决定，记录依据）：计划原拟 S2-S4/S5+S6 两笔提交，因 pool025 等文件被多阶段先后触碰、hunk 级拆分易错，改为**一笔业务提交＋一笔文档提交**。
- 接口/配置变化：新增 410 退役合同（7 端点＋W7/W8 API 分支）；错误码 `API_FUNDING_RETIRED`（repo）与 `CANDIDATE_CONTAINS_RETIRED_API_FACTS`（409）；O1a 400 `invalid_import_row`（API 资金字段）；draft 桥接状态新增 `BRIDGE_UNAVAILABLE`；finance 投影 apiSpendStatus 切估算口径（CALCULABLE/INCOMPLETE＋估算缺口码）；`OPENING_BALANCE_MISSING` 恒 0。详见 retired-api-funding-contract.md。

## 3. 验证记录（总指挥独立复跑为准；子 Agent 自跑见各回执）

| 验证 | 结果 |
|---|---|
| S2：迁移/夹具/网关（总指挥复跑） | migration 6/6＋repo 10/10、gateway wp2-pending/w11/cpqw 18/18 |
| S3：关键三文件（总指挥复跑） | provider-finance＋wp07＋pool025 39/39 |
| S4：domain 全量＋激活两套件（总指挥复跑） | 409/409＋28/28 |
| S5：parity＋三钉死＋pool043＋pool025（总指挥复跑） | DB 44/44＋gw 9/9＋ca 9/9 |
| S6：新增两文件（总指挥复跑） | gw 9/9＋db 3/3 |
| 全量（S6 期，子 Agent 跑） | gateway 250/250；database 569/570（唯一 w20 P95 负载 flake，隔离 2/2 绿）；control-api 475/475＋352/352；domain 409/409；worker 199/199；四包 typecheck/lint 0；openspec strict 校验通过 |
| case 对照（非浏览器部分） | AT-AFR-02✓（参数化 7 端点 410＋四表零增量）；03✓（纯套餐草稿 GO→activate→W5/W6 可用＋旧候选 409 零写入）；04/05/06✓（wp2-pending-admission＋w11 锚点）；07 后端✓（跨月归集/预占月/无资金页面）；08 后端✓（API 无期初续订，开关周期不变）；09/10✓（账户有钱仍拒＋allow_overage 计量）；AT-X01/X04/X05 机制层✓（parity/门禁电池/关账冻结）。AT-AFR-01/11/12/13/14 浏览器/联调部分＝待 WP4/WP5，本包未填 PASS |

## 4. 审核发现、裁定与未解决项

### 4.1 总指挥裁定（已入 plan §4a/§4b）
R1 O1a 新写守卫（BILL_RECONCILIATION 源不复用 ADMIN-only 函数）；R2 O1 权限属 billing 模块（文档修正）；R3 drain 解除 API 计数；R4 拒绝范围为 API 三类草稿全量＋legacy API 引用；R5 激活投影摘除 API 资金缺口＋markScopeResourcesReady 移除；R6 repo 守卫仅两处、不入共享 Tx 原语；R7 计划范围补正；R8 API 账户豁免 NEGATIVE_BALANCE/BALANCE_FORMULA_MISMATCH（AFR-04 违反修复）；S5 中途：CALCULABLE 配 null 谎报不可接受→BRIDGE_UNAVAILABLE。

### 4.2 未解决/未核实（移交）
| 项 | 状态 | 影响 |
|---|---|---|
| 生产版本/迁移水位/开关（WP0 遗留） | BLOCKED | WP6 前必须补核 |
| P1-P3 同步参数（WP3 前冻结） | 待用户确认 | WP3 开工第一件事 |
| w20-standard-capacity P95 | 本机负载 flake（WP1 §4.2-4 同源，隔离复绿） | 不阻塞；CI 自裁 |
| **WP1 验证缺口（本包发现并补遗）**：gateway pool043 套件未在 WP1 验证清单，其 `expectUnknownApiCostBill` 钉旧桥接口径；WP2 S5 已按 ACE-04 迁移（标注补遗） | 已闭合 | 无 |
| subjects 层 MIXED→null 与 summary 部分金额并存 | 层级完整性语义差异（usage 事实 fail-closed vs 估算部分展示） | WP4/WP5 联调核对展示口径 |
| WP4 展示域遗留：web 层 OPENING_BALANCE_MISSING 映射/横幅、`resource-insights/routes.ts:232` 兜底串、BRIDGE_UNAVAILABLE 行展示 | 待 WP4 | 展示层 |
| `settled_at IS NULL` 行不进估算窗口 | WP1 已知边界维持 | 无 |

### 4.3 执行方式
- 六阶段全部交 glm-flash 串行实施；总指挥只做计划/合同/裁定/审核/独立复跑/记录。子 Agent 未自审；中途两次报备（相邻文件/语义裁定）均先停后批；两轮追加授权（S2 夹具、S4 偏离项 1）。唯一一笔业务提交在全部阶段复审通过后由总指挥执行。
- 范围外改动检查：`52fe37d` 48 文件逐项对照各阶段允许清单，零越界；W5/W6/A3/A4/GET 端点、0081/0083/0092/0093 本体、:443/:451、worker/官方余额、web、已关账快照、strict_writes 语义均未触碰。worker reporting 测试副作用（3 文件重渲染＋合成输出）已回置/清理。

## 5. 本包结论

**通过**。退出条件逐项：7 退役入口参数化负向（410＋零事实增量）✓；混合候选拒绝＋CP 独立初始化/续订✓；新资源无账户可服务、存量 PENDING 可服务、凭证/耗尽仍阻断、:443/:451 原样✓；禁超额"账户有钱仍拒"＋allow_overage 计量✓；OPENING_BALANCE_MISSING 停产＋用量/价格缺口保留＋OFF/ACTIVE 金额同源 parity＋关账零变化✓；范围外零改动✓。tasks.md 4.1-4.4 已勾选。待联调（WP4 页面、WP5 50 条总验收、WP6 候选/回退）未执行，本包未冒充端到端 PASS。

## 6. WP3 启动交接

- 基线：worktree `/Users/mac/Projects/仟流智算-api-decouple`，分支 `codex/simplify-api-cost-and-official-balance`，HEAD＝本包文档提交（含 `52fe37d`）；接手先复核 HEAD/分支/status 与远端 main 包含关系。迁移编号 **0095 起**。
- 依赖与输入：本报告、[retired-api-funding-contract.md](retired-api-funding-contract.md)（退役合同＋§6 使用控制保留）、[api-estimation-contract.md](../WP1/api-estimation-contract.md) v1.1、WP0 contracts.md §1 C2（官方余额读取合同）＋notes/inv-b.md、specs/official-account-balance。
- **WP3 前必须**：P1（同步周期 15min）/P2（过期阈值 30min）/P3（刷新冷却 30s）向用户确认冻结；P5 已冻结（resources.operate）。工作器侧注意：provider-operating-sync 现跳过静默企业的行为保留（D2）；充值事件触发的额外查询逻辑退役（S3 后无新充值事件）；OAB-06 恢复链（recordBalanceSyncRecovery）勿动。
- 红线重申：不动本包 0094/准入/退役合同；不统一关闭 strict_writes；W5/W6 与 quiescence 保留；员工月度额度（0092）不回退。
- 下一任务启动指令（新会话）：

> 读取并执行 `/Users/mac/Projects/仟流智算-api-decouple/openspec/changes/simplify-api-cost-and-official-balance/handoff/work-packages/WP0/zcode-commander-instructions.md` 同款指令（task.md），当前工作包改为 **WP3**（tasks 3.1～3.4：官方余额独立同步/刷新/状态/恢复），上一包交接记录改为 `handoff/work-packages/WP2/report.md`（已通过；业务 HEAD `52fe37d`）。开发执行子 Agent `glm-flash`（thoughtLevel: high）；开工先复核基线与远端 main 包含关系，并向用户确认 P1/P2/P3 后再实施。
