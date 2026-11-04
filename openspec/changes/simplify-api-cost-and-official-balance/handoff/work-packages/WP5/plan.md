# WP5 计划：跨服务集成验收（tasks 6.1、6.2、6.4）

日期：2026-11-04；总指挥：GLM-5.3（zcode 会话）；实施：glm-flash 子 Agent（串行）。本包＝全量验收，几乎不写新功能；仅三项已授权小范围代码改动（见 §3 裁定）。

## 1. 目标与对应 case

- **6.1**：42 个规格场景（AT-ACE-01~14、AT-OAB-01~14、AT-AFR-01~14）＋8 项集成回归（AT-X01~08）逐条执行，含金额核对表；依据 acceptance-plan §3 夹具 F01-F12、§5/§6 矩阵、§4 证据分层。
- **6.2**：历史不变对比（关账版本/原始用量/规则快照/历史处置迁移前后不变；仅新增必要兼容数据）——落点 AT-X05 双库（新库＋旧数据升级库）执行。
- **6.4**：改动包 typecheck/lint/build＋相关测试＋OpenSpec strict＋实现/测试/发布/业务验收状态分列报告。
- 汇总全部 50 条结果；业务复核层（§7 人工路线＋§8 业务签收）整理成清单交回用户，不冒充完成。

## 2. 输入基线与依赖

- worktree `/Users/mac/Projects/仟流智算-api-decouple`，分支 `codex/simplify-api-cost-and-official-balance`，开工 HEAD `d6550c9`（＝`84c110e`＋两笔 WP5 任务书文档提交；`ae506fed` 包含关系已核验；工作树干净；远端 main 仍 `ae506fed`）。
- 依赖：WP1 合同 v1.1（`loadApiCostEstimation` 唯一金额基准）、WP2 退役合同 v1.0（19 入口表＋§6 使用控制九条）、WP3 ops-runbook（C2 状态/刷新三态/0095-0096）、WP4 报告＋e2e 夹具 `seed-e2e-wp4.ts`（F04/F01/CLOSED 可复用）。
- 环境：colima＋`qianliu-pg`@55432＋`qianliu_e2e` 库已核验（2026-11-04）；e2e 四个环境变量按 `apps/web/e2e/README.md`。
- 遗留口径：w20-standard-capacity P95 flake（隔离复绿处置）；dispatch 全来源保留；无新迁移预计（确需时 0097 起）；生产版本/迁移水位未核实（报告单列，WP6 前补核）。

## 3. 总指挥裁定（开工前固化）

| # | 事项 | 裁定 | 依据 |
|---|---|---|---|
| R1 | purchases 补退役 | **实施**：`POST /provider-resources/:id/purchases`（`apps/control-api/src/department-costs/routes.ts:219`）对 `purchase_type=API_RECHARGE` 写入返回 410 `api_funding_management_retired`（沿用 WP2 合同 §1 响应体与鉴权先行原则；type 在 body，须在 zod 解析后分支）；`PACKAGE_PURCHASE`（Coding Plan）不受影响；参数化负向测试（API_RECHARGE→410＋事实零增量；PACKAGE_PURCHASE 原 201/幂等重放不变） | 用户 2026-11-04 已裁定，直接执行 |
| R2 | 悬项③ 聚合级 PRICE_BASIS_UNVERIFIED | **实施**：后端聚合读取补产出该状态（仅字段透出，web 分支已就绪消费）；不动聚合语义与 0093 | task.md 授权"小范围补后端产出"；否则 AT-ACE-04 聚合展示不可达，§8 口径误解类阻断 |
| R3 | 悬项④ settlement 级币种未透出 | **实施**：RequestDrilldown 币种字段透出（仅字段透出）；混币明细回退 ¥ 会造成口径误解 | 同上；AT-ACE-14 依赖 |
| R4 | AT-X07/AT-X08 回退演练半段 | 在**当前开发候选**上执行可执行半段（无期初消费可读/可结算/受额度约束＋数据保留验证）；正式发布候选切换/回退演练由 WP6 在 6.3 交付后重验（acceptance-plan §1"补充"口径）。WP5 矩阵如实记录执行了哪半段 | 包边界：6.3 属 WP6 |
| R5 | §7 人工路线＋§8 业务签收 | 自动化+浏览器证据做完后，将需用户亲自执行/签认项列成清单交回；截图包由 e2e 自动生成覆盖七类最低要求 | task.md 明示"需用户参与" |
| R6 | S1 勘误：全量 e2e 可运行 | 子 Agent 误报 wt-web.spec.ts helper 未提交（误信 WP4 旧报告）；总指挥亲核 `84c110e` 已提交五 helper 且文件现存 `apps/web/e2e/`。S5 执行全量 `test:e2e` | git show 84c110e＋ls 亲核（2026-11-04） |
| R7 | R2 设计定案 | **兄弟布尔字段**（summary 级 `priceBasisUnverified`＋dashboard-breakdown 资源组级），判定源统一 `loadApiCostEstimation().priceBasis[].sourceStatus==='UNVERIFIED'`；**不扩** apiCostStatus 五值枚举（PRICE_BASIS_UNVERIFIED 与金额可知性正交，WP1 合同已定其为信息项）；web 侧最小接线（复用既有文案分支）；零迁移 | inv-wp5 §2-R2 两方案＋枚举正交性 |
| R8 | R3 语义定案 | settlement 加 `apiCostCurrency`（投影 `costCurrency` 透传，transaction-only 分支 null）；web `costMoneyText` 传币种；**currency=null 时不渲染 ¥**（无符号中性展示，行级已显冻结币种）；S2 须核实 `usage-cost-disposition-projection.ts:72` 混币聚合取值，发现误导性 bug 立即上报而非顺手改 | inv-wp5 §2-R3；ACE-07 不混加 |
| R9 | w20:932 用例迁移 | 批准：正路径迁至 CP 资源＋PACKAGE_PURCHASE（append-only/幂等/审计断言全保留），记录迁移原因；新增 API_RECHARGE 410 参数化负向 | 验收计划 §5"旧用例因新合同调整记录原因及新替代" |
| R10 | e2e seed 扩展授权 | 允许按缺口最小扩 `seed-e2e-wp4.ts`（G15 从未成功行、G16 同账户第二资源等）；DB/GW 已证事实不强制 e2e 重复（WP4 先例：浏览器证据以资源列表页行合成） | plan §4 已含；细化到条目 |
| R11 | 第 6 个 e2e helper | 用户 2026-11-04 裁定"逐字复制补提交"：`apps/web/e2e/seed-local-upstream-credentials.ts` 从主仓未跟踪区逐字复制入库（diff 验证一致），随 WP5 业务提交，提交说明注明来源与理由；web typecheck 归零 | 与 84c110e 五 helper 同类处置；运行时仅 E2E_UPSTREAM_ORIGIN 设置时加载 |
| R12 | S2B 未决项处置 | ①w20-standard-capacity resourceUtilizationP95 隔离 1018.7ms>1000（S2B 零触碰路径）→ 归入既知容量 flake 族，S5 全量后隔离复跑记录，CI 自裁；②混币 recorded_cost 跨币种直加为投影层既有设计（R8 下无展示误导）→ 记录为已知边界，不扩范围 | inv-wp5＋s2b-receipt 证据链 |

## 4. 交付物与允许修改范围

- 代码（仅 R1/R2/R3 三项＋其测试）：`apps/control-api/src/department-costs/routes.ts`；R2/R3 实施点以 S1 调查为准（预计 usage 聚合/gateway-requests 域字段透出，禁止动聚合语义、0093-0096 迁移、估算/退役/C2 语义、员工额度 0092）。
- 新增测试/e2e：为矩阵缺口补测（S3 按映射确定）；e2e 沿用 `wp4-cost-official-balance.spec.ts` 模式或新增 spec 文件；夹具可扩 `seed-e2e-wp4.ts` 或新建 seed。
- 文档：WP5/plan.md（本文）、notes/、receipts/、report.md、tasks.md 勾选（仅 6.1/6.2/6.4，达标后）。
- 证据：`V4/Evidence/API-COST-OFFICIAL-BALANCE/WP5-20261104/`（目录自建；每条 case 记录九要素）。
- **禁止**：主仓 `/Users/mac/Projects/仟流智算` 任何写操作（他人在途修改）；真实付费推理/生产写入/部署/消息发送；删除用例/放宽断言/降阈值/伪造 fixture/补零期初；勾选 6.3；改 specs 需求文本（发现矛盾上报）。

## 5. 阶段与子 Agent 分工（串行）

| 阶段 | 内容 | 执行 | 退出条件 |
|---|---|---|---|
| S1 只读调查 | ①50 条→现有测试/夹具/证据锚点映射表＋缺口清单；②R1/R2/R3 实施点 file:line 级定位（含现有相关测试）；③AT-X05 双库执行方案；④AT-X01~08 逐条可执行性核查 | glm-flash（只读，notes/inv-wp5.md） | 总指挥抽核映射属实；缺口清单可直接转化为 S2/S3 任务合同 |
| S2 实施 R1-R3 | 三项小改动＋定向测试 | glm-flash | 总指挥审 diff＋独立复跑定向测试绿 |
| S3 矩阵执行 | 42 场景＋8 回归逐条执行（重跑既有映射测试作本候选证据＋缺口补测＋浏览器/e2e 步骤＋截图包＋金额核对表） | glm-flash 执行＋总指挥独立复跑关键项 | 50 条各有证据与状态（PASS/FAIL/BLOCKED/NOT_RUN） |
| S4＝6.2 | AT-X05 双库历史不变对比（与 S3 内 AT-X05 合并执行，单列任务对照） | glm-flash＋总指挥复核 | 前后摘要一致或差异全部归因白名单 |
| S5＝6.4 | 改动包（control-api/database/web 等按实际 diff）typecheck/lint/build＋测试；全仓各包全量；`test:e2e` 全量（helper 已补 84c110e）；openspec strict | glm-flash 跑＋总指挥复跑 | 无未解释新增红；flake 按既例隔离复绿记录 |
| S6 结包 | 汇总 50 条矩阵＋R1-R3 审核记录＋用户签认清单（R5）＋report.md＋tasks 勾选 | 总指挥 | 报告按指令 §8 格式；输出 WP6 启动指令并结束 |

## 6. 验证方法与完成条件

- 每条 case：命令/步骤、预期（规范原文）、实际、状态、证据路径、执行人/日期；金额以 `loadApiCostEstimation` 输出（8 位小数字符串）为唯一基准。
- 完成条件：50 条无 NOT_RUN（BLOCKED 须写明依赖）；阻断缺陷（§8：费用/Token 计算错误、绕过使用限制、套餐损坏、旧资金可写、关账被改、数据丢失）为零；R1-R3 审核通过；6.4 检查全绿（基线遗留 flake 单列）；报告+签认清单交付。
- 测试卫生：worker 测试重跑后 `V4/Evidence` 跟踪文件 checkout 恢复＋新文件手删；e2e 仅指向 `qianliu_e2e`。
