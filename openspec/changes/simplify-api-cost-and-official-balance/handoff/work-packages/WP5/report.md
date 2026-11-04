# WP5 结包报告：跨服务集成验收（tasks 6.1、6.2、6.4）

包：WP5；总指挥/模型：GLM-5.3（zcode 会话）；实施：glm-flash 子 Agent（GLM-5.3-Flash，thoughtLevel: high）串行 S1→S2A→S2B→S3a-1→S3a-2→S3b→S5（S4＝6.2 并入 S3a-1 X05 与 S3b）；S5 全量跑批与缺陷定性由总指挥亲自执行。日期：2026-11-04。**结论：通过**（50 条矩阵 PASS 48＋X07/X08 可执行半段 PASS、回退/切换时序半段 BLOCKED-WP6；两项环境/基线遗留单列 §5，不冒充通过）。

## 1. 基线与工作区状态

- 起点：`d6550c9`（＝`84c110e` e2e helper 补提交＋两笔 WP5 任务书文档提交；开工复核：分支 `codex/simplify-api-cost-and-official-balance`、工作树净、远端 main 仍 `ae506fed` 且为 HEAD 祖先）。
- 终点：结包两笔提交（业务＋文档，见 §2）；无新增迁移（0096 水位不变，符合 plan 预计）。
- 主仓 `/Users/mac/Projects/仟流智算` 全程零写入（每份子 Agent 合同明示＋总指挥阶段核验）；R11 第 6 个 e2e helper 按用户裁定从主仓未跟踪区逐字复制（diff 验证）。
- 环境事实：本机 colima 全天高负载（W20-10 P95 数据点漂移佐证）；测试容器环境变量 `DOCKER_HOST=unix:///Users/mac/.colima/default/docker.sock`＋`TESTCONTAINERS_RYUK_DISABLED=true`（S2B 趟通，后续沿用）。

## 2. 计划 vs 实际交付（plan.md §5 阶段表对照）

| 阶段 | 计划 | 实际 | 证据 |
|---|---|---|---|
| S1 只读调查 | 50 条覆盖映射＋R1-R3 实施点＋X01-08 可执行性＋命令清单 | 完成：直接 27/部分 23/无覆盖 0，缺口 G1-G30；R1-R3 file:line；总指挥抽核 5/5 属实＋纠正一处勘误（R6：全量 e2e helper 已可运行） | notes/inv-wp5.md |
| S2A＝R1 | purchases 补退役 410＋参数化负向 | 完成：路由 410 分支（鉴权后、zod 后、repo 前，逐字合同）＋既有用例迁移（注释记录裁定）＋W12 合同行；总指挥复跑 43 文件 360/360 | receipts/s2a-receipt.md |
| S2B＝R2+R3 | 聚合价格依据待核实＋settlement 币种透出（仅字段透出） | 完成（前段实施被用户暂停中止，续作 Agent 补验证）：兄弟布尔 `priceBasisUnverified`（breakdown 组级＋overview 窗口级，趋势/排名 Omit）＋`apiCostCurrency`（null 不渲染 ¥）；定向 22/22＋CA 361/361＋web 758/758；混币聚合核实＝NULL 无误导；总指挥逐文件审 diff＋typecheck 归零（含 R11） | receipts/s2b-receipt.md |
| S3a-1＝DB 缺口 | G3/G5/G23/G26＋X05 新文件 | 完成：四缺口用例＋`wp5-upgrade-immutability.integration.test.ts`（0091 水位 F08/F09→0096 升级 sha256 摘要不变＋0093 白名单＋退役写入仍拒＋新库对照）；总指挥复跑 14/14 | receipts/s3a1-receipt.md |
| S3a-2＝web/e2e 缺口 | G1/G2/G6/G9/G10/G11/G14/G15/G16/G19/G24＋seed 扩展＋截图包 | 完成：seed 六类新夹具＋e2e test8-16（9 新）＋G24 组件断言；e2e 16/16（旧 7 保持）；截图 11 张归档；G19 调查＝UI 无"仅按已观察速率"专项句（列签认清单）；总指挥复跑 16/16 | receipts/s3a2-receipt.md |
| S3b＝矩阵装配 | X06 金额核对表＋50 条草案 | 完成：脚本 15 端点 26 行，基准 CNY 3.00104000＋USD 0.50000000 KNOWN_PARTIAL，**待裁定差异 0**；草案 47/1/2 | x06-amount-reconciliation.{ts,md}＋matrix-draft.md |
| S5＝6.4 检查 | 全量跑批＋strict＋typecheck/lint | 总指挥亲自执行：见 §3 表；期间发现并关闭两缺陷（teardown 57P01×6 文件、S2B legacy-schema 回归）＋e2e 三轮夹具修复（全归因） | matrix.md §6＋三份 receipts |

- 业务改动（结包业务提交）：`department-costs/routes.ts`（R1）；`usage-overview-repository.ts`/`dashboard-breakdown.ts`/`dashboard-types.ts`（R2，含 legacy-schema 兼容门）；`gateway-requests/routes.ts`（R3）；web 六文件（R2/R3 展示）；`seed-e2e-wp4.ts`（夹具）；e2e helper `seed-local-upstream-credentials.ts`（R11 用户裁定逐字复制）；测试改动＝DB 六文件＋新 X05 文件＋CA 八文件＋web 六文件＋e2e 三 spec。
- 接口变化：`POST /provider-resources/:id/purchases` API_RECHARGE→410（合同 v1.1 W12）；usage-overview metrics 可选 `priceBasisUnverified`；ResourceBreakdownItem 可选 `priceBasisUnverified`；gateway-requests settlement 可选 `apiCostCurrency`。零迁移、零配置。

## 3. 验证记录（总指挥独立执行/复跑为准；详表＝matrix.md §6）

| 验证 | 结果 |
|---|---|
| openspec strict | valid |
| domain/adapters | 411/411＋398/398 |
| database 单测 | 843/845（唯二红＝容量族，见 §5-①） |
| database 集成（最终态） | 82 文件 598/600（同容量族）＋定向 29/29 |
| control-api 集成（最终态） | 361/361 exit 0（teardown 修复后） |
| gateway 集成 | 250/250 exit 0 |
| worker | 200/200 exit 0（legacy 修复后） |
| web 单测/e2e 矩阵 spec | 759/759＋16/16×2 次复跑 |
| 全量 e2e（5 spec） | 三轮止于 20P/1F/29 串行中止（§5-②） |
| typecheck/lint（三改动包） | 全 0/全 exit 0 |
| 50 条矩阵 | **PASS 48＋BLOCKED-WP6 半段 2（X07/X08）；FAIL 0、NOT_RUN 0** |
| 金额核对（X06） | 26 行、待裁定差异 0；0.00104000/0.03000000/96.00000000 字面值链齐 |
| 红线证伪（总指挥 git 终查） | 主仓零写入；0092-0096 迁移零触碰；员工额度/CLOSED 冻结/估算-退役-C2 语义零改写（R2/R3 仅字段透出）；无真实付费推理/生产写入/部署/消息发送 |

## 4. 审核发现与缺陷关闭（本包自查自纠）

1. **S2B legacy-schema 回归（本包自引入，已修复）**：S2B 给 `UsageOverviewRepository.getOverview` 挂 `loadApiCostEstimation`（引用 0093 列）破坏 worker"既有生产 schema 独立报表"合同（report-facts-legacy 测试 0091 水位即炸；生产 schema 现状未跑 0093，影响真实）。修复＝列存在性门（information_schema 点查，缺列省略字段＝"无此信息"而非 false）；worker 200/200 恢复。总指挥亲核修复前后。
2. **e2e teardown 57P01×6 文件（环境竞态，已修复）**：361/361 全过但 exit 1（15 个容器停止竞态未捕获异常）；六文件 afterAll 加 200ms 排空（S3a-1 先例）→ exit 0。
3. **全量 e2e 三轮夹具冲突（WP4 seed 与遗留 spec，全归因已修）**：①provider-review 裸插 ledger_line 撞 WP4 seed strict_writes＋0085 触发器→补结算字段＋CP 行挂 MIGRATED_CARRYOVER period（子 Agent 中途请示未达后自行执行，方案与总指挥事后裁定一致，**追认**；纪律偏差已申诫记录）；②wt-web WT-01 厂商代码 "DeepSeek" 撞 WP4 seed 同名 code→改 "E2EDeepSeek"；③WT-01:64 文案断言过期（WP4 改名"套餐与订阅"）→更新断言（归因 file:line 齐全）。
4. **总指挥审核纠错**：S1 勘误"全量 e2e 不可运行"（R6，helper 实已补提交）；S2B 续作时逐文件审 diff 后才放行验证。

## 5. 未解决/未核实项（移交 WP6/用户）

| # | 项 | 状态 | 影响 |
|---|---|---|---|
| ① | W20-10 `resourceUtilizationP95` 本机四数据点 986/1018/1094/1187ms 横跨 1000 阈值（三点超）；路径经 diff＋import 图核实本包零触碰、986 过点反证代码回归 | **本机环境 FAIL 定性**（WP1-WP4 同族 flake，但本轮隔离不复绿） | 不影响本功能正确性；**WP6 发布候选必须复验**（CI/发布环境），不放宽阈值 |
| ② | 全量 e2e：wt-web WT-01:91 需本地合成上游（`E2E_UPSTREAM_ORIGIN` 基建，helper 已随 R11 入库）＋其后续 29 用例三轮无执行证据 | 环境型非产品回归（归因链完整）；非 50 条矩阵项 | 建议单独立项补合成上游基建后跑通 wt-web 全量；不阻塞本包 |
| ③ | 生产版本/迁移水位未核实（WP0 遗留） | 未核实（无只读权限） | WP6 前补核（任务书既定） |
| ④ | OAB-13"仅按已观察速率"专项文案 UI 缺位（现有：算法估算/可信度/覆盖/不可计算） | 列用户签认清单 | 一行文案级改动，待裁定 |
| ⑤ | 请求级/CSV 缺省币种标签 `costCurrency??"CNY"`、部门账 knownApiCost 跨币种直加（既有投影口径，R8 下无展示误导）、年度页 apiAccounts 仅资金视图行键（WP1 合同 §6 既知边界）、pool042 两无事务请求行空金额 | 已知边界记录（X06 表内归因） | 口径类观察，WP6/后续按需收敛 |
| ⑥ | web e2e 目录 6 个 unused-var（HEAD 基线，lint 脚本范围外） | 基线记录 | 不阻塞 |
| ⑦ | provider-review 325/300 瞬态分歧（一轮单跑出现、两轮全量未复现） | 未深查 | 记录备查 |

## 6. 用户签认清单（R5：需用户亲自执行/裁定，不冒充完成）

**§7 人工业务验收路线（6 步＋七类截图——截图已由 e2e 生成于 `V4/Evidence/API-COST-OFFICIAL-BALANCE/WP5-20261104/screenshots/`＋WP4 复用四张，操作确认需用户在测试环境亲自走查）**：
1. 无资金期初 API 资源→不要求初始化；F01 消费→请求明细 1200 Token＋0.00104 元；
2. 同期核对资源/首页/账单，无期初/充值/内部余额/待补账提示，依据可查价格与完整性；
3. 官方余额 110＋成功时间→模拟 160 刷新→超时＋推进时钟保鲜值/失败/过期说明（不走零）；
4. 不支持同步资源费用照常；两个关联 Key 无 200 合计；
5. 套餐与订阅采购/周期/费用/自动续订开关；员工额度禁/允超额各演示（官方有余额不放行）；
6. F08 关账历史与只读旧资金金额/来源不变；当前 CSV 新旧口径不混淆。
**§8 业务签收**：以上走查结果＋对 §5-④ 专项文案是否补加的裁定＋隔离环境验收确认（未部署，不得写发布完成）。


**走查更新（2026-11-04 晚）**：用户亲自完成 §7 六步路线，全部 PASS；发现并修复 D-1~D-4（提交 715e5d0/da36ac4/68d2227），D-5 判为 HMR 现象非缺陷。业务签收：通过。详见 `receipts/walkthrough-signoff-20261104.md`。

## 7. 本包结论

**通过**。退出条件逐项：42 场景＋8 回归全部执行并留证据（§3）；金额核对表零待裁定；6.2 历史不变由 X05 双库摘要对比钉死（0093 白名单显式列明）；6.4 检查全绿（容量 flake 族与全量 e2e 环境缺口单列定性，未降阈值未删用例）；阻断缺陷零（§8 四类阻断均未发生）；范围外零改动（红线证伪）。**未执行**：WP6 发布候选/切换/回退演练（X07/X08 BLOCKED 半段）、生产部署与迁移、业务签收（§6 清单）。

## 8. WP6 启动交接

- 基线：worktree `/Users/mac/Projects/仟流智算-api-decouple`，分支 `codex/simplify-api-cost-and-official-balance`，HEAD＝本包文档提交（含业务提交，见 §2）；迁移水位 0096（0097 起）。
- 输入：本报告＋matrix.md 终稿＋X06 表＋七份回执＋inv-wp5.md；WP1-WP4 合同文档（退役合同已 v1.1 含 W12）。
- WP6（task 6.3）必须项：镜像/版本清单＋迁移说明＋备份恢复＋切换/回退清单与隔离演练；**复验 W20-10 P95（§5-①）与 X07/X08 BLOCKED 半段**；生产版本/迁移水位补核（§5-③）；候选变化时按指令重验受影响场景。
- 红线重申：不动 WP1-WP5 全部语义；0092-0096 零触碰；演练不等于生产部署授权。
- 下一任务启动指令（新会话）：
> 读取并执行 `/Users/mac/Projects/仟流智算-api-decouple/openspec/changes/simplify-api-cost-and-official-balance/handoff/work-packages/WP0/zcode-commander-instructions.md` 同款指令（task.md），当前工作包改为 **WP6**（task 6.3：发布候选、具体切换/回退方案及隔离环境演练），上一包交接记录改为 `handoff/work-packages/WP5/report.md`（已通过；业务 HEAD 见报告 §1/§2）。开发执行子 Agent `glm-flash`（thoughtLevel: high）；开工先复核基线与远端 main 包含关系。
