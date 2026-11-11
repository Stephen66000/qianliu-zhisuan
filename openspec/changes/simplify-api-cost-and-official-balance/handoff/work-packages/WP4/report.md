# WP4 结包报告：页面、导出与历史阅读（tasks 5.1～5.4）

包：WP4；总指挥/模型：GLM-5.3（zcode 会话）；实施：glm-flash 子 Agent（GLM-5.3-Flash，`thoughtLevel: high`），串行 S1（只读调查）→S2→S3→S4→S6（S5 盘点并入 S1 结论与本报 §3）。日期：2026-11-03～04。**结论：通过**（遗留项见 §4.2，均不阻塞 WP5）。

## 1. 基线与工作区状态

- 起点基线：`745dae4`（分支 `codex/simplify-api-cost-and-official-balance`；＝远端 main `ae506fed…933e`＋WP0-WP3 全部业务与结包提交＋WP4 任务书；开工复核包含关系＋工作树干净）。
- 终点基线：业务提交（本包两笔提交之一，63 文件 M/D＋2 新增，+1102/−683）＋本报告文档提交；迁移水位 **0094 基础上无新增**（本包零迁移，符合 plan 预计）。
- 主仓 `/Users/mac/Projects/仟流智算` 全程完好：S2 曾发生 10 文件误写事故（bash 相对路径），子 Agent 当场反向回滚；总指挥独立比对主仓 status 与会话开始快照逐项一致（5M＋1D 原有在途＋未跟踪 e2e helper 完好），后续阶段（S3/S4/S6）路径纪律生效零再发。
- e2e 环境：colima＋`qianliu-pg` 容器 @55432＋专用 `qianliu_e2e` 库（总指挥准备）；seed 安全门（127.0.0.1/`_e2e` 后缀）全程生效。

## 2. 计划 vs 实际交付（plan.md §4 对照）

| 阶段 | 计划 | 实际 | 证据 |
|---|---|---|---|
| S1 只读调查 | 9 节调查 | 完成：inv-wp4.md（约 120 条 file:line；含报表/通知盘点＝S5 前置）；总指挥抽核 5/5 属实 | notes/inv-wp4.md |
| S2＝5.1 | 官方余额 C2 接线＋命名统一＋缺口文案＋遗留②收口 | 完成：22 文件＋467/−82；`ProviderOfficialBalanceState` 类型＋`useRefreshOfficialBalance`；资源列官方余额（六状态＋expired/last_attempt_failed 叠加＋冷却消费 next_refresh_at 零硬编码）；价格依据待核实角标（发现并消费 WP1 冻结的 `billing_rule_snapshot.sourceStatus`，无需扩合同）；`projectFinanceUtilization` 资金兜底整体退出（预算利用率经核实由 `applyApiBudgetFacts` 承接） | receipts/s2-receipt.md |
| S3＝5.2 | 套餐与订阅＋API 表单退役＋历史只读 | 完成："充值与订阅"→"套餐与订阅"（Tab/标题/引导）；API 充值表单/摘要卡/激活草稿 API 区（含 historicalApiCosts，偏离追认：后端三键任一非空即拒）退役；"历史资金记录（旧口径，只读）"＋来源列；孤儿组件 RechargeEntry 删除；MonthlyPayments"API 充值（历史）" | receipts/s3-receipt.md |
| S4＝5.3 | 首页/账单/年度/部门/项目/CSV＋遗留①③ | 完成：OPENING_BALANCE_MISSING 死映射删除；账单页"待补期初"提示段删除＋BRIDGE_UNAVAILABLE 中性拆格；BillStat/采购复盘表按 `bill.status` 分流（DRAFT 退役期初/充值/期末三卡，CLOSED 保留原三卡＋原列名防冒充）；CLOSED 历史横幅（· vN）；"综合费用（含 API 估算）"措辞；财务账内部余额卡/列退役＋CSV 同步；usage CSV 表头"API费用估算"；口径核实结论表 8 项（s4-receipt §2） | receipts/s4-receipt.md |
| S5＝5.4 | 报表/通知盘点 | 并入 S1 §5＋本包交付：worker 全模板（周/月/日报/激励 SVG）纯 Token 零 API 金额命中（grep 证据），含 API 金额产物集合为空；发送配置（delivery.ts＋config:178）零接触；纯 Token 模板 diff 为零；零消息发送 | notes/inv-wp4.md §5 |
| S6 | 全量复跑＋e2e 浏览器证据＋AT-AFR-03 修复 | 完成：e2e `wp4-cost-official-balance.spec.ts` 7/7（真实 API 联调、指定文件运行绕开坏 spec）；seed 夹具（OK 110/FAILED 保鲜 50/UNSUPPORTED/F01 0.00104/混币/CLOSED 冻结月/历史资金事件）；AT-AFR-03 时间敏感夹具修复（总指挥授权，缺陷窗口内前后对比 1fail→15/15）；七包全量＋typecheck/lint＋openspec strict；证据 32 日志＋10 截图归档 | receipts/s6-receipt.md |

- 接口/配置变化：**零后端接口/迁移/配置变化**（control-api 仅 5 文件：resource-insights 投影收口×2、usage CSV 表头、activation 测试夹具修复、集成断言迁移；seed 属 e2e 夹具）。web 新增 C2 客户端类型＋刷新 hook。
- 提交策略：沿 WP2/WP3 模式——一笔业务提交＋一笔结包文档提交。

## 3. 验证记录（总指挥独立复跑为准；子 Agent 自跑见各回执）

| 验证 | 结果 |
|---|---|
| web test（总指挥 S2/S3/S4 后三度复跑＋S6 矩阵） | 756→753→754/754 全绿（净变化＝删退役用例＋新增断言，逐条有因） |
| control-api test | 482/482（AT-AFR-03 修复后全绿；修复在缺陷窗口内亲证＋子 Agent HEAD 版本复跑双重证伪 WP4 关联） |
| **e2e（总指挥亲跑）** | **7/7 通过**（15.2s；ACE-01 双页命名/OAB-01 组成不相加/OAB-04 保鲜值＋同步失败/OAB-02 暂不支持/OAB-03 刷新 409 credential_missing 零真实上游/AFR-01 套餐与订阅＋无充值表单＋历史只读来源/AFR-07 DRAFT 无待补＋CLOSED 横幅·v1＋三卡/CSV 表头＋F01 行 0.00104） |
| domain/adapters/gateway/worker | 411/411＋398/398＋integration 8/8＋411/411＋200/200（typecheck/lint 全 0） |
| database | test 835/836＋integration 590/591：唯一红＝W20-10 P95 性能包络（两轮失败均紧随百万行迁移用例；隔离复跑 2/2 通过；packages/database 零 diff；WP3 已记录同款 flake）——非本包回归 |
| openspec strict | valid |
| 红线证伪（总指挥 git status/diff 终查） | packages/database（含 migrations）／gateway／worker／domain／adapters／specs 零改动；员工额度（0092）与 Worker 报表行为零触碰；已关账模型层数据零改写（CLOSED 仅渲染分流） |
| worker 测试副作用 | report-layout-preview 直写 V4 证据目录（12 个随机名新文件）；子 Agent checkout 恢复 M 文件＋总指挥清理新文件残留，工作树洁净 |

case 对照（本包负责的展示层）：ACE-01✓（e2e 1/4）；ACE-02 场景3✓（角标，组件测试＋e2e 佐证）；ACE-04 展示✓（三分支文案）；ACE-06/07 措辞✓（综合费用含 API 估算＋混币分列既有机制）；OAB-01/02/04✓（e2e 1）；OAB-03 手动✓（409 态）；AFR-01 场景1✓（e2e 3）；AFR-04✓（CP 域零语义改动＋测试迁移）；AFR-06✓（CLOSED 冻结渲染＋横幅＋防冒充列名）；AFR-07✓（e2e 5/6）；AT-AFR-03（本包修复其时间敏感夹具，业务断言零变化）。**待 WP5**：AT-X06 全页同源金额核对表、42＋8 全量矩阵汇总（本包浏览器证据覆盖的 case 由 WP5 汇总确认，本包不提前填 PASS）。

## 4. 审核发现、裁定与未解决项

### 4.1 总指挥裁定（S1 后 7 项见 plan §3.1；阶段中追认 4 项）
historicalApiCosts 草稿区一并退役（后端三键同拒，保留＝必然失败表单）；BalanceQualityNotice 零功能改动（现行不可达由后端停产保证，分支保留供 CLOSED 冻结快照渲染，删除违反 AFR-06）；CLOSED 厂商表列头保留"API 花费"（防旧桥接值冒充估算）；FinancialLedgerSection 内部余额选退役而非标注（AFR-07 明文"经营账单和导出中移除"）。AT-AFR-03 夹具修复依"上一包问题最小修复"授权实施（非静默重做：仅时间取值一行＋注释，亲证＋HEAD 复跑双重证伪关联）。

### 4.2 未解决/未核实（移交 WP5/WP6/用户）
| 项 | 状态 | 影响 |
|---|---|---|
| wt-web.spec.ts 引用 5 个从未提交的 e2e helper（现存主仓未跟踪区＝他人在途修改） | **基线缺陷，需用户裁定**是否补提交 | 全量 `test:e2e` 不可运行；WP4 以指定文件运行绕开；typecheck 6 个 e2e 错误同源 |
| `POST /provider-resources/:id/purchases` 仍可写 API_RECHARGE（前端表单已退役） | 移交 WP2 域裁定（只写采购实付表，不写资金账本，CLOSED 有屏障） | AFR-01 后端完备性存疑点，WP5 AT-AFR-02 复核 |
| W20-10 P95 性能包络 flake（WP3 同源） | 三次隔离记录在案，CI 自裁 | 不阻塞 |
| usage-overview（dashboard-breakdown）链无 C2 字段→首页面板官方余额列降级"—" | 总指挥裁定不接通（资源列表页已完整展示） | WP5 AT-OAB-09/10 以资源列表页为浏览器证据 |
| 聚合维 PRICE_BASIS_UNVERIFIED 后端未在 usage costStatus 产出（web 分支已就绪） | 移交后端域 | 聚合级角标暂不可达（逐请求级已可用） |
| settlement 级币种字段未透出（RequestDrilldown 回退 ¥） | 移交 gateway-requests 域 | 混币结算汇总标注待后端 |
| worker report-layout-preview 测试直写 V4 证据目录（重跑必漂移） | 移交该任务域 | 测试卫生问题 |
| ResourceBreakdown 列级 CLOSED 旧口径标注未做（由横幅整体标识） | 记录 | WP5 视觉验收裁定 |

## 5. 本包结论

**通过**。退出条件逐项：七行表逐行落地（现行页面口径统一✓、历史与当前明确区分✓、浏览器证据为真实 API 联调✓）；界面红线全过（货币余额未进 Token 剩余额度、无一刀切隐藏套餐余额/额度、API 无资金表单、多币种分列、冷却/时效纯消费后端字段——e2e＋组件测试钉死）；报表/通知仅盘点零模板改动（纯 Token 白名单 diff 为零）＋零消息发送；已关账版本金额/来源/版本不变（模型层零改写）；范围外零改动（git 终查证伪）；tasks.md 5.1-5.4 已勾选。**未执行**：WP5 50 条总验收、WP6 候选/回退演练——本包不冒充端到端 PASS。

## 6. WP5 启动交接

- 基线：worktree `/Users/mac/Projects/仟流智算-api-decouple`，分支 `codex/simplify-api-cost-and-official-balance`，HEAD＝本包文档提交（含业务提交，见 §1）；接手先复核 HEAD/分支/status 与远端 main 包含关系。迁移编号 0097 起（本包未占用）。
- 依赖与输入：本报告＋各阶段回执（s2-s6）＋inv-wp4.md；后端合同（WP1 估算 v1.1／WP2 退役 v1.0／WP3 C2 状态矩阵＋ops-runbook）；e2e 夹具 `seed-e2e-wp4.ts`（F04/F01/CLOSED 可直接复用）；证据 `V4/Evidence/API-COST-OFFICIAL-BALANCE/WP4-20261104/`。
- WP5 注意：42＋8 全量矩阵执行（六夹具就绪度先盘点；F02/F03/F05/F06/F07/F10/F11/F12 后端测试已覆盖、浏览器/e2e 侧按需扩展）；§4.2 两项需用户/WP2 域裁定项先确认；浏览器截图至少覆盖 acceptance §7 七类；同源金额核对表以 `loadApiCostEstimation` 为唯一基准。
- 红线重申：不动 WP1-WP4 全部语义（估算/退役/C2 三态/页面分流）；不回退员工月度额度；0092-0096 迁移零触碰。
- 下一任务启动指令（新会话）：

> 读取并执行 `/Users/mac/Projects/仟流智算-api-decouple/openspec/changes/simplify-api-cost-and-official-balance/handoff/work-packages/WP0/zcode-commander-instructions.md` 同款指令（task.md），当前工作包改为 **WP5**（tasks 6.1、6.2、6.4：42 个规格场景＋8 个集成回归、缺陷关闭和证据），上一包交接记录改为 `handoff/work-packages/WP4/report.md`（已通过；业务 HEAD 见报告 §1）。开发执行子 Agent `glm-flash`（thoughtLevel: high）；开工先复核基线与远端 main 包含关系。
