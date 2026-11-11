# WP6 计划：发布候选与切换/回退演练（task 6.3）

日期：2026-11-04；总指挥：GLM-5.3（zcode 会话）；实施：glm-flash 子 Agent（GLM-5.3-Flash，thoughtLevel: high）串行委派。

## 1. 目标与对应 case

task 6.3：形成具体发布/回退清单，演练切换后无资金账户的新 API 消费与回退兼容；验证旧资金要求不会在回退时意外恢复为调用门槛。

对应验收 case：
- X07 BLOCKED 半段（按发布候选回退方案演练：新消费仍可读/结算/受原额度约束）→ 50 条矩阵补齐。
- X08 BLOCKED 半段（停旧 API 写、在途消费收尾、Worker/服务切换时序、套餐任务与官方刷新共存）→ 50 条矩阵补齐。
- W20-10 `resourceUtilizationP95` 复验（WP5 §5-①：本机四点 986-1187ms 横跨 1000 阈值；候选上复验，如实记录，不放宽阈值）。
- 生产版本/迁移水位补核（WP0 遗留 BLOCKED；只读方式，拿不到即记录未核实）。
- 候选变化重验：D-1~D-4（web 走查修复，提交 715e5d0/da36ac4/68d2227）发生在 WP5 矩阵之后——按指令§六.8 复核受影响场景（走查回执遗留：全栈 e2e 含 D-1~D-4 新断言待 WP6 候选复跑）。
- 6.4 最终候选检查复核（OpenSpec strict＋改动包 typecheck/lint；不假定旧证据适用）。

## 2. 输入基线与依赖

- worktree `/Users/mac/Projects/仟流智算-api-decouple`，分支 `codex/simplify-api-cost-and-official-balance`，HEAD `59f7367`（=WP5 结包 `f6e3c33`＋联审补遗 `5c50aa7`＋走查修复 `715e5d0`/`da36ac4`/`68d2227`＋签收归档 `59f7367`；开工复核：`ae506fe` 为 HEAD 祖先 ✓，远端 main 仍 `ae506fe` ✓，工作树净 ✓，迁移水位 0096 ✓）。
- 依赖：WP5/report.md（50 条矩阵、§5 遗留、§8 交接）、matrix.md 终稿、joint-review.md（通过零返工）、walkthrough-signoff-20261104.md（业务签收 PASS＋D-1~D-4＋遗留清单）、WP1-WP4 合同文档。
- 环境事实：本机 colima 高负载（W20-10 数据点漂移佐证）；容器测试环境变量 `DOCKER_HOST=unix:///Users/mac/.colima/default/docker.sock`＋`TESTCONTAINERS_RYUK_DISABLED=true`。

## 3. 交付物与允许范围

| # | 交付物 | 位置 |
|---|---|---|
| D1 | 发布候选清单（服务/版本/构建、迁移 0093-0096 说明、备份与恢复方案、切换/回退操作单含 0095 down 多行守卫处理） | `WP6/release-candidate.md` |
| D2 | X07 回退半段演练（证据＋矩阵更新） | `V4/Evidence/API-COST-OFFICIAL-BALANCE/WP6-20261104/`＋matrix.md |
| D3 | X08 切换时序半段演练（证据＋矩阵更新） | 同上 |
| D4 | W20-10 P95 复验记录（如实，不放宽阈值） | 同上＋report |
| D5 | 生产版本/迁移水位补核记录（或未核实声明） | report §生产补核 |
| D6 | D-1~D-4 受影响场景复验＋6.4 复核（strict/typecheck/lint） | 同上＋report |
| D7 | 结包报告 | `WP6/report.md` |

允许修改：WP6 目录文档、`V4/Evidence/API-COST-OFFICIAL-BALANCE/WP6-*/` 证据、matrix.md 状态列（X07/X08 半段）、演练必需的测试脚本/文件（新增文件须在范围表登记并对应 case）。**禁止**：业务语义改动、0092-0096 迁移改动、WP1-WP5 已验收语义改写、主仓 `/Users/mac/Projects/仟流智算` 任何写入、真实付费推理/生产写入/部署/消息发送。

### 范围表新增登记（S1 后总指挥裁定，2026-11-04）

| 项 | 类型 | 对应 case | 依据 |
|---|---|---|---|
| `packages/database/src/__tests-integration__/wp6-rollback-drill.integration.test.ts` | 新增集成测试（长期资产） | X07 回退半段 | down 链 0096→0092 数据保留断言＋0095 守卫两态需可重复验证；复用既有 Testcontainers/migrator 基建 |
| `apps/web` 既有组件测试文件内补 D-3/D-4 文案断言（不新增文件） | 测试补强 | OAB-13/14（D-4）、AFR-01（D-3） | S1 证实走查修复文案无任何自动断言，候选复验须有自动化覆盖（walkthrough 回执"组件测试覆盖"与代码现状不符） |
| `V4/Evidence/API-COST-OFFICIAL-BALANCE/WP6-20261104/scripts/` 演练脚本（X07 旧代码读行为、X08 时序编排） | 证据脚本（不入测试套件） | X07/X08 BLOCKED 半段 | 旧基线代码与多服务时序编排属一次性演练证据，不污染长期测试资产 |
| 旧基线只读 worktree（`git worktree add --detach`，检出 `ae506fe`，路径 worktree 外） | git 操作 | X07 | 旧服务读新数据需旧代码实证；baseline-update 规则 2 允许新建工作区；禁止在旧 worktree 内提交 |

### 总指挥裁定（S1 后）

1. 回退操作单主路线＝整库备份恢复（rollback.sh 先例：pg_dump -Fc＋非空校验＋DESTRUCTIVE 定级）；down 迁移链作为演练验证路线，实证数据保留与 0095 守卫，两者边界写入候选文档。
2. X07 旧代码实证对象＝ae506fe 的资源候选查询与结算读取路径对回退后库（0092 水位）的真实行为；结果如实写入回退方案（若旧代码 PENDING 过滤排除无期初资源，记为已知边界＋回退包要求，不视为演练失败——数据层断言不丢/不补造为准）。
3. X08 时序断言集固定：退役端点 410＋资金四表零增量；在途消费收尾（静默租约语义真实时序下复验）；worker 切换后官方刷新成功＋套餐续订开关/周期不变；全程无真实付款。
4. W20-10 复验＝候选 HEAD 隔离跑原用例原阈值，记录实际数值与样本数；PASS/FAIL 如实。

## 4. 阶段与子 Agent 分工（串行）

| 阶段 | 内容 | 执行 |
|---|---|---|
| S0 探针 | glm-flash 可用性验证（小只读任务） | glm-flash |
| S1 调查 | 发布候选素材盘点（服务清单/构建产物/启动拓扑/迁移 0093-0096 与 down 行为/0095 多行守卫细节/备份点）；WP5 X07/X08 已 PASS 半段与 BLOCKED 半段执行方式回溯；W20-10 测试定位；D-1~D-4 变更面与受影响场景清单 | glm-flash（只读） |
| S2 候选清单 | D1 文档成文 | glm-flash（文档） |
| S3 X07 演练 | 回退半段：候选上无期初新消费 → 按回退方案（含 0096→0093 down、0095 守卫）→ 回退后可读/结算/受原额度约束断言 | glm-flash（实施） |
| S4 X08 演练 | 切换半段：停旧 API 写（410 后无旁路）、在途消费收尾、Worker/服务切换时序、套餐任务与官方刷新共存 | glm-flash（实施） |
| S5 复验 | W20-10 P95＋D-1~D-4 受影响场景（e2e 矩阵 spec＋新断言）＋6.4 strict/typecheck/lint | glm-flash 跑批＋总指挥独立复跑 |
| S6 补核 | 生产版本/迁移水位只读补核 | 总指挥（无权限即记录未核实） |

依赖顺序：S1 → S2/S3/S4（S3/S4 依赖 S1 的执行方式裁定）→ S5（依赖候选定格）。生产补核与 S2-S4 可并行。

## 5. 验证方法与完成条件

- X07/X08 BLOCKED 半段各有可追溯证据（命令、版本、断言、日志路径），矩阵更新为终态（PASS 方可勾选 6.3）。
- 回退演练必须证明：无资金账户新消费回退后仍可读/结算/受原额度约束；不要求补虚构期初；0095 down 多行守卫按发布候选方案处理；不通过回退删除新用量或补造资金。
- 切换演练必须证明：无旧后台继续新增 API 资金；既有消费完成；套餐自动续订开关/周期不变；官方刷新恢复；无真实付款。
- W20-10 P95：候选上实际执行、原阈值记录实际数值；PASS/FAIL 如实，环境定性可解释但不可替代数据。
- 6.4：strict valid＋改动包（含走查修复触及的 web）typecheck/lint 全绿。
- 生产补核：只读证据或明确"未核实"。
- 全程不修改业务语义；范围外零改动（git 终查）。
