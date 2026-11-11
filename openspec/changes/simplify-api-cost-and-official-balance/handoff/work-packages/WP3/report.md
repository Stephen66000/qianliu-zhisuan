# WP3 结包报告：独立官方余额同步（tasks 3.1～3.4）

包：WP3；总指挥/模型：GLM-5.3（zcode 会话）；实施：glm-flash 子 Agent（GLM-5.3-Flash，`thoughtLevel: high`），串行 S1（只读调查）→S2→S3→S4→S5→S6（全量复跑）。日期：2026-11-03。**结论：通过**（遗留项见 §4.2，均不阻塞 WP4）。

## 1. 基线与工作区状态

- 起点基线：`67c9aec`（分支 `codex/simplify-api-cost-and-official-balance`；＝远端 main `ae506fed…933e`＋WP0 文档＋WP1 业务/结包＋WP2 业务 `52fe37d`＋结包 `250d22e`＋WP3 任务书；包含关系开工复核，工作树干净）。
- 终点基线：业务提交 `74b1e0a`（`feat(official-balance): decouple provider balance sync from funding mode (WP3 tasks 3.1-3.4)`，27 文件，+2561/−269）＋本报告文档提交。
- 迁移水位：0095（drop attempt `daily_uq`，down 多行拒绝式守卫）＋0096（`provider_resource_balance_refresh` 请求表，RUNNING 部分唯一＋幂等键＋租约）新增；0000-0094 零触碰；快照表 0026 本体零改动。
- 冻结参数（2026-11-03 用户确认）：**P1＝15 分钟**、**P2＝30 分钟**（env：`PROVIDER_OPERATING_SYNC_INTERVAL_MS`/`PROVIDER_OPERATING_BALANCE_EXPIRE_MS`，默认 900000/1800000ms）；**P3＝30 秒**（用户跳过未逐项确认，按设计建议默认落地、可配置，`PROVIDER_OPERATING_BALANCE_REFRESH_COOLDOWN_MS` 默认 30000ms；config 注释如实标注）；P5＝`resources.operate`（WP2 已冻结，本包落地）。P1 标注"DeepSeek 官方限流数值未核实，按厂商限制可调"（维持 BLOCKED）。
- glm-flash 探针 OK 后方委派；环境与 WP2 一致。

## 2. 计划 vs 实际交付（plan.md §4 对照）

| 阶段 | 计划 | 实际 | 证据 |
|---|---|---|---|
| S1 只读调查 | 9 节调查＋实施建议 | 完成：inv-wp3.md（含 inv-c 过时结论修正：provider_operating 自 `de07cdf` 起在调度循环 core，每 30s tick＋attempt 每日门禁）；总指挥抽核 5/5 属实 | notes/inv-wp3.md |
| S2＝3.1 | runner 三解耦＋P1 周期门禁＋0095 提前（总指挥裁定 A：迁移与门禁同批，否则 P1 名不副实） | 完成：删 FINANCE_MODE skip／充值依赖／onConflict；`shouldSkipUntilNextSync`（next_sync_at>P1）；P1/P2/P3 三读取器一次建齐；DARK/OFF 仍同步＋七资金表零增量钉死 | 52fe37d 后未提交工作树；s2-receipt |
| S3＝3.2 | 0096＋刷新端点＋冷却/在途＋运维文档 | 完成：`POST /provider-resources/:id/official-balance/refresh`（requireAuth→resources.operate）；共享写入原语（runner 换装单一事实来源，行为零变化）；三态 ACCEPTED/IN_PROGRESS/COOLDOWN＋租约收敛＋审计＋凭证双点不泄露断言 | s3-receipt；ops-runbook.md |
| S4＝3.3 | C2 状态读取完整化 | 完成：`listOfficialBalanceStates`（source='PROVIDER_SYNC' 过滤；UNSUPPORTED/NEVER_SYNCED/OK/FAILED/EXPIRED/SYNCING＋expired/last_attempt_failed 布尔叠加；null 不冒充零；无合计字段）；列表路由挂 `official_balance` | s4-receipt（含状态矩阵） |
| S5＝3.4 | 恢复链回归＋预测来源/时效 | 完成：恢复链三套件回归零编辑；API 预测仅官方来源＋P2 时效（`official_source_missing`/`official_balance_expired` 不可计算行，exhaust 恒 null）；CP 预测保持既有输入（W5/W6 域裁定）；AT-OAB-11 机制层 grep 证伪（gateway 准入零余额读取） | s5-receipt |
| S6 | 全量复跑＋终查 | 完成：七包全量＋typecheck/lint＋openspec strict；30→32 项工作树改动终查零越界；一处 WP2 测试头断言（回滚数组恰为 [0094]）按补充授权机械适配（at(-1)＋toContain，语义不变）后复绿 | s6-receipt（含 §1.1 修复 diff） |

- 接口/配置变化：新增刷新端点（200+state 三态；422 不支持/409 缺凭证/404/403 分态）；GET /provider-resources 每资源新增 `official_balance` 对象（C2 字段＋叠加布尔）；config 新增三 env；domain 新增两个 `not_calculable_reason` 枚举常量（`official_source_missing`/`official_balance_expired`，computeForecast 数学零改动）。
- 提交策略：沿用 WP2 模式——一笔业务提交＋一笔文档提交（pool022 等文件被多阶段触碰）。

## 3. 验证记录（总指挥独立复跑为准；子 Agent 自跑见各回执）

| 验证 | 结果 |
|---|---|
| S2：config/runner/0095 迁移（总指挥复跑） | 15/15＋3/3＋3/3 |
| S3：刷新 http/0096＋0095/换装后 runner（总指挥复跑） | 6/6＋10/10＋3/3 |
| S4：状态套件/刷新 http（总指挥复跑） | 7/7＋7/7 |
| S5：预测 diff 逐行核对＋dispatch 消费链核实 | 通过 |
| 红线证伪（总指挥 git diff） | resource-pool-repository／subscription-renewal／0000-0094／provider-finance 410 区／web／runner 恢复函数全部零改动 |
| 全量（S6，子 Agent 跑＋总指挥抽复） | config 15/15；domain 411/411（+2＝S5 常量用例）；provider-adapters 398/398；worker 200/200（+1）＋集成 10/10；gateway 411/411（WP2 基线 250 为分层子集口径，git 证伪本包 gateway 零改动）；database 836/836＋集成 591/591（含修复后；基线 569/570 为子集口径）；control-api 482/482（+7）＋集成 359/359（+7）；七包 typecheck/lint 0 错误；openspec strict valid。唯一 flake＝w20 P95 负载（隔离复绿，WP1/WP2 同款处置） |

case 对照（本包负责层）：AT-OAB-02✓（ADMIN 手工不混入）；03✓（DARK/OFF 仍同步＋手动刷新不要求登记充值＋view-only 403/GET 可读/凭证不下发）；07✓（保鲜 50＋FAILED＋expired 叠加）；08✓（FAILED null 不显 0＋NEVER_SYNCED）；09/10✓（两资源独立无合计）；11 机制层✓（准入零余额读取）；12✓（恢复链回归零编辑）；13/14 机制层✓（not_calculable_reason 通道＋过期不可计算）。AT-OAB-01/03/07/08/09/10 浏览器展示、AT-OAB-11 联调＝待 WP4/WP5，本包未填 PASS。AT-X02✓（冷却零上游＋在途租约收敛＋失败后可再刷＋同日多行）。

## 4. 审核发现、裁定与未解决项

### 4.1 总指挥裁定
A：0095 提前至 S2（迁移与周期门禁同批，避免 P1 半残）；B：insights :296 硬编码 15min——子 Agent 报备保留（判的是 forecast 行新鲜度非官方余额时效，替换会语义混淆），追认；手动刷新计入 P1 节奏（spec"不无限触发官方查询"）；CP 预测保持既有输入（OAB-07 文义限 API 余额，W5/W6 红线）；dispatch-operating-input 保留全来源（quota ratio 偏好调度非余额硬拒绝，OAB-07 不覆盖）；S2 静默测试时钟适配追认（断言语义强化）；0096 down 无数据守卫追认（瞬时协调状态非证据）。

### 4.2 未解决/未核实（移交）
| 项 | 状态 | 影响 |
|---|---|---|
| DeepSeek 官方限流数值 | BLOCKED 维持 | P1"按厂商限制可调"标注；WP6 前宜核 |
| 生产版本/迁移水位/开关（WP0 遗留） | BLOCKED | WP6 前必须补核 |
| 0095 down 多行守卫＝生产多行后回滚被拒 | 设计意图 | WP6 回退方案须包含 |
| insights 15min 与 P2 双时效阈值并存 | 已记录差异依据 | WP4 如需官方时效展示→消费 `official_balance.expired`，不改该阈值 |
| dispatch-operating-input 全来源 | 已裁定保留 | WP4/WP5 联调观察是否误导 |
| 展示层接线（web） | 待 WP4 | C2 字段已备（含状态矩阵 s4-receipt §3） |
| w20 P95 负载 flake（WP1 同源） | 三次隔离记录在案（红→红→冷却后绿 2/2），CI 自裁 | 不阻塞 |

## 5. 本包结论

**通过**。退出条件逐项：独立余额同步（资金模式/充值依赖解耦，OAB-03 三场景钉死）✓；日内多次＋刷新/冷却/在途（AT-X02）✓；状态完整化＋旧值保持＋不合计（OAB-04/05 字段层）✓；恢复链/预测时效（OAB-06/07 机制层）✓；0092-0094/WP2 合同/恢复链/web 零触碰（git diff 证伪）✓。待联调（WP4 页面、WP5 50 条总验收、WP6 候选/回退——0095/0096 回退语义见 ops-runbook）未执行，本包未冒充端到端 PASS。tasks.md 3.1-3.4 已勾选。

## 6. WP4 启动交接

- 基线：worktree `/Users/mac/Projects/仟流智算-api-decouple`，分支 `codex/simplify-api-cost-and-official-balance`，HEAD＝本包文档提交（含业务 `74b1e0a`）；接手先复核 HEAD/分支/status 与远端 main 包含关系。迁移编号 **0097 起**。
- 依赖与输入：本报告、[ops-runbook.md](ops-runbook.md)（P1/P2/P3 env 与三态行为）、s4-receipt §3 状态矩阵（WP4 渲染依据：status 主状态＋`expired`/`last_attempt_failed` 布尔叠加）、C2 合同字段（`official_balance` 对象已挂 GET /provider-resources）、[retired-api-funding-contract.md](../WP2/retired-api-funding-contract.md)、[api-estimation-contract.md](../WP1/api-estimation-contract.md) v1.1。
- WP4 注意：页面字段消费 C2 新字段（不解析中文文案判态）；同账户多 Key 不做余额合计展示（OAB-05）；insights 时效如需官方口径→消费 `expired` 布尔而非改 15min 阈值；web 层 WP2 遗留（OPENING_BALANCE_MISSING 映射/横幅、`resource-insights/routes.ts:232` 兜底串、BRIDGE_UNAVAILABLE 行展示）一并处理。
- 红线重申：不动本包 0095/0096 语义、恢复链、三态契约；不回退 WP2 退役合同；员工月度额度（0092）不回退。
- 下一任务启动指令（新会话）：

> 读取并执行 `/Users/mac/Projects/仟流智算-api-decouple/openspec/changes/simplify-api-cost-and-official-balance/handoff/work-packages/WP0/zcode-commander-instructions.md` 同款指令（task.md），当前工作包改为 **WP4**（tasks 5.1～5.4：页面、导出、报表与历史只读），上一包交接记录改为 `handoff/work-packages/WP3/report.md`（已通过；业务 HEAD 见报告 §1）。开发执行子 Agent `glm-flash`（thoughtLevel: high）；开工先复核基线与远端 main 包含关系。
