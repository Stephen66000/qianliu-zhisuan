# IDE1.5 Stage 01/02 方案文档审核报告

| 项目 | 内容 |
| --- | --- |
| 审核对象 | `IDE1.5_Stage01方案包-v1.0.md`、`IDE1.5_Stage02开发计划-v1.0.md`、`IDE1.5_Stage01高保真原型-v1.0.html`（三份均为 v1.0，日期 2026-08-03） |
| 审核人 | Claude（本机审核会话） |
| 审核日期 | 2026-08-04 |
| 审核性质 | 内容一致性 / 完整性 / 可核验性审核；不替代 SOP 流程中的独立评审与 Owner 签字 |
| 审核结论 | **READY_WITH_ACTIONS（有条件通过）** — 设计合同层面未发现 P0 级缺陷；发现 **P1 × 2（核验性阻断）**、**P2 × 2（合同缝隙）**、**P3/Low × 4（一致性/编辑性）** |

---

## 0. 总结论

三份文档的产品设计质量**显著高于一般 Stage 01 产出**：一句话结果、唯一 Golden Path、最多三个固定场景、明确范围外、五状态 Context 合同、Growth Gate 不变量、四权限模式矩阵、恢复/安全矩阵、Planning Change 触发器、停止条件——治理骨架完整，且"不新建第二状态机、candidate 不进 Context、Evaluation 不升权、outcome unknown 不重放"四条核心红线在方案包、计划、原型三处表述一致、互相咬合。Stage02 的 WP00 结构收敛前置（先锁行为、机械迁移、每步回滚点、不看行数 KPI）是成熟做法。

**但**：文档中所有指向外部代码库的锚点（两个 commit hash、IDE 底座六大文件、`docs/` 相对路径、`14cd` worktree、`_knowledge_base` 调研文件）在已挂载的仟流智算仓库中**全部不可验证**。这不必然构成造假——它们指向的应是独立的"仟流 IDE"产品仓库（本仓库 Planning Change Log PC-20260729-09 确认 IDE 是独立第一方客户端、已移出一期范围），但该仓库未挂载、也无法公开访问，审核人无法区分"真实存在但不可达"与"引用虚构"。按文档自身宣告的 fail-closed 原则，此缺口必须关闭后才能视为可进入 Stage 03 授权流程。

---

## 1. P1 — 核验性阻断（2 项）

### P1-1 全部外部锚点不可验证（Evidence Gap，author-reported）

**事实**：方案包 §2.4/§13、Stage02 §1.1 依赖以下锚点，经在本机仟流智算仓库逐一核验：

| 锚点 | 文档断言 | 核验结果 |
| --- | --- | --- |
| `cee888898c…418b` | IDE 1.4 稳定 commit，六文件行数只读核对的来源 | 本仓库 `git cat-file`：**bad object，不存在** |
| `6e5d6cff…f7b7e` | 当前 Planning worktree 起点 | 本仓库：**bad object，不存在** |
| `apps/ide/src/renderer/App.tsx` 2808 行等六文件 | 结构承载风险事实表 | 本仓库 `apps/` 只有 gateway/control-api/web/worker，**无 apps/ide** |
| `docs/IDE1.5_Stage01高保真原型-v1.0.html`（§4.3） | 原型存放路径 | 本仓库**无 docs/ 目录**；原型实际以附件上传 |
| `/Users/mac/.codex-switcher/shared/.codex/worktrees/14cd/仟流Agent-重建` | 视觉候选只读来源 | 本机**路径不存在**（该宿主目录无此 worktree） |
| `_knowledge_base/IDE1.5-统一Context成长闭环与权限模型-2026年8月.md`（§13） | 官方一手调研已保存 | 本仓库 `_knowledge_base/` 27 个文件中**无此文件** |

**影响**：§2.2"真实缺口"、§2.4 结构风险表、Stage02 WP00 输入（六文件行数）、§13 完成检查第 4/6/7 条，全部建立在不可核验的断言上。若其中任何一项为虚构或已过期，WP00 的输入基线即失效。同时 Stage02 §1.1 规定 Stage 03 启动握手必须校验 base commit/tree——**这两个 hash 现在是文档中唯一记录的值，若记录错误或对应仓库 objects 被 GC，Stage 03 启动时必然 blocked 且无法回溯**。

**处置建议**（文档编辑不可自 fix，需作者侧）：
1. 明确 IDE 产品仓库的身份与位置（路径/remote），并在方案包 YAML 中记录该仓库的 `HEAD`、remote state 与核验时间；
2. 将六文件行数表转为可复算的 Evidence（脚本输出或带 hash 的清单文件），存于本仓库或 IDE 仓库的 Evidence 目录；
3. `_knowledge_base` 调研文件补存到位或修正路径；
4. 三份文档移入其声称的 `docs/` 目录（或与实际存放位置对齐），消除"文档声称在 docs/ 而实际不在"的错位。

### P1-2 治理登记缺位：Planning Change Log 无 IDE 1.5 条目、SOP 绑定未指明版本

**事实**：本仓库 `V3/Planning-Change-Log.md` 当前 11 条变更（最新 PC-20260729-09 将 IDE 移出一期），**无 IDE 1.5 立项条目**；`V3/仟流智算-stage-state-v0.3.yaml` 仍是 v0.3 产品线的状态（stage=STAGE-03 done, POST-RELEASE-VALIDATION）。方案包 §13 声称"已完整读取 2026-08-01 中央 SOP 总入口与 00/01/02/03""已读取项目 AGENTS、SOP 基线、Planning Change"，但未指明 SOP 版本号，未引用 Planning Change 条目号，且 IDE 1.5 作为新产品线的 Stage 01 未见任何登记。

**影响**：两个可能——(a) IDE 1.5 走独立治理域，则应显式声明其治理锚点（独立 SOP 绑定/独立 stage-state/独立 Planning Change Log 的位置）；(b) 属于本仓库治理域，则缺登记，"P0=0、P1=0"的自声明无对照基线。无论哪种，当前文档都没有把治理关系说清。

**处置建议**：方案包增加"治理绑定"一节：IDE 1.5 适用的 SOP 名称+版本+路径、Planning Change 登记号（或显式声明独立治理域及其锚点）、与 v0.3 产品线 stage-state 的关系声明。

---

## 2. P2 — 合同缝隙（2 项，建议 Stage 02→03 之间关闭，不阻断 Stage 01 结论）

### P2-1 测试计划矩阵覆盖缺口：docs 自身 invariant 缺少对应测试行

Stage02 §11 测试表与 §12 不变量自动门存在以下未闭合映射：

1. **同层 hard 冲突 blocked**（方案包 §5.2"同层 hard constraint 冲突且无法确定胜者时 compile_result=blocked，不得让模型猜"）：WP01 DoD 有 "required same-authority hard conflict fail-closed"，但 §11 测试表无任何一行显式列入该用例族（unit/property 行只写 "priority/strength/budget/reason"）。
2. **候选敏感继承**（方案包 §9"Growth 候选继承源 Evidence 最高 sensitivity，不能通过总结降级"）：WP04 边界与 DoD 全文未出现 sensitivity；§11 negative/security 行无对应用例。
3. **prompt injection→Growth 路由隔离**（方案包 §8 矩阵"外部内容 prompt injection…不能直接路由成规则"）：§11 negative/security 行有 injection，但只落在 Context/Permission 语义，WP04 Growth 测试矩阵（四动作×六 route）未含 injection 用例。
4. **迁移双写禁令**（方案包 §10"不得并行维护两套选中结果"、Stage02 §15"禁止半迁移双写"）：无任何测试行验证"读旧写新、无双写"。

**处置建议**：§11 测试表 negative/security 与 unit/property 行各补一句显式用例枚举；WP04 DoD 增加"sensitivity 继承与降级拒绝有合同测试"。

### P2-2 Growth observe 去向的流转规则未定义

方案包 §6.3 路由表含 `observe`（"证据不足，继续观察"），Stage02 WP04 要求"四动作 × 六 route"测试，但全文（两份文档）未定义：observe 候选如何/何时转为 eligible/suggested、回看条件是什么、是否有时限、是否允许无限滞留。对照 §6.2"defer 有可见回看条件/时间"，observe 的语义空缺是同类问题未同等处理。

**处置建议**：§6.2 不变量或 §6.3 路由表补一条 observe 流转规则（回看触发、升级条件、最长滞留）。

---

## 3. P3 / Low — 一致性与编辑性问题（4 项，可随手修）

| # | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| L1 | Stage02 frontmatter vs §15 | YAML 写 `execution_readiness: true`，§0 正文写 `READY_FOR_EXECUTION=true`，§15 又强调"`READY_FOR_EXECUTION` 不是状态也不是授权"。同一文档出现两个 key 名表达同一含义，且 §15 的"不是状态"声明容易被误读为与 frontmatter 矛盾 | 统一为一个字段名并在 §0 一句话绑定两者 |
| L2 | Stage02 §3.4 | "固定截图无语义变化"对应方案包 §2.4 的"固定视觉截图"；§3.3 又写"固定视觉截图"。同一物三个叫法（固定视觉候选/固定视觉截图/固定截图） | 统一术语，建议沿用方案包"固定视觉截图" |
| L3 | 方案包 §2.4 | `packages/agent-protocol/src/qianliu-app-server-v1.ts` 列入"巨型文件/职责集中风险"，但 971 行与"巨型"定性及其他五文件（1106–2891 行）不一致，Stage02 §3.4 的拆分步骤 00-A~00-F 也未给 agent-protocol 分配任何迁移步 | 要么在 §2.4 说明 971 行入选理由（如公共协议膨胀速率），要么从风险表移除或单列；Stage02 §3.4 补其边界归属 |
| L4 | 原型 vs 方案包 §4.1 | 方案包要求"默认右侧打开 Progress"，原型首屏确为 Progress（符合）；但原型 Composer 的 Context chip 写"7 选入 / 4 未入"，而 Context 面板实际条目为 selected 5 + shadowed 1 + excluded 1 + expired 1 + denied 1 = 9 条（隐藏 v8 显示后 10 条），chip 计数与列表不可对账 | 原型合成数据自洽化：chip 改为"5 选入 / 4 未入"或补齐列表至 11 条；另外 denied 条目 sensitivity 徽标混用 `secret` 与状态色，建议分开标注 |

另注：原型头部"合成演示 · 未连接 Provider · 0 副作用"声明与实际行为一致（纯 DOM 操作、无网络、无 localStorage），§4.3 对原型的全部约束（四入口、五状态、reason/detail、Growth 四动作、四模式、完全访问警告、自定义 policy snapshot）逐项核对**均在**。原型 `confirm()` 用于 Full Access 二次确认，与 Stage02 §5"Full Access 二次确认"一致。

---

## 4. 三份文档交叉一致性核对（通过项）

以下交叉点逐项核对**一致**，作为通过证据记录：

1. 一句话版本结果：方案包 §0 与 Stage02 §0 语义等价（措辞略异、要素相同：看清 Context/权限 → 编辑确认组织规则 → 重启后下一任务采用新版本）。
2. Golden Path 三场景：方案包 §3 三场景 ↔ Stage02 §10 最终真人门三步，一一对应。
3. 四入口：方案包 §4.1/§4.2 ↔ 原型右侧 tabs ↔ Stage02 §6（WP03）一致；默认 Progress 一致。
4. Context 五状态与 reason：方案包 §5.3 表 ↔ 原型徽章/文案（selected/excluded/shadowed/expired/denied，superseded_version、ttl_expired、secret_outbound_denied 等均用冻结 reason code）↔ Stage02 WP01 DoD 一致。
5. 权限四模式默认值与时长：方案包 §7.2 矩阵（ask 默认 / 替我审批 2h / 完全访问 30m / 自定义 24h 上限）↔ Stage02 §5 ↔ 原型 modes 配置，完全一致。
6. 硬不变量：方案包 §7.3 六条 ↔ Stage02 §12 自动门 10 条 ↔ 原型 Full Access 警告文案（无 sandbox 承诺、Secret deny、Agent 不自批）方向一致。
7. Growth 闭环证明链：方案包 §6.2"下一 Run manifest 选中 exact asset version/hash 后完成验证"↔ 原型 adoption proof（gr_8a12 → asset v8/20bd…13c9 → ctx_910c）↔ Stage02 WP05 adoption proof query，一致。
8. 历史不漂移：方案包 §8（原 Run manifest 不变）↔ 原型（当前 Run ctx_7f2a 仍固定 v7）↔ Stage02 WP05 DoD，一致。
9. commit/远端授权边界：方案包 §11 范围外 ↔ Stage02 §1.2/§13 禁止项 ↔ frontmatter `remote_state: LOCAL_ONLY_NOT_PUSHED`，一致。

---

## 5. 审核人判断

**优点（值得保持）**：克制的产品定义（明确"不是什么"）；所有成长/权限动作都有 exact binding（actor/version/hash/intent）；fail-closed 原则贯穿 Context、Growth、Permission、Recovery 四个域且措辞统一；WP00"先锁行为再机械迁移、每步回滚点、不按行数考核"是对巨型文件拆分的正确工程姿势；原型与文档的咬合度高，可直接作为 Stage 03 视觉/交互基线。

**主要风险**：本包最大的风险不在设计而在**可核验性与治理登记**——所有底座断言当前是 author-reported。仟流智算 v0.3 产品线（见本仓库 stage-state）已经演示过完整的"评审→整改→锁→签字→放行"治理链；IDE 1.5 若想沿用同等治理强度，第一步就是把 P1-1/P1-2 关掉。

**建议行动顺序**：
1. 作者侧关闭 P1-1（锚点 Evidence 化）与 P1-2（治理绑定声明）→ 复核后可进入独立评审；
2. Stage 02→03 之间关闭 P2-1/P2-2（测试矩阵补行 + observe 流转）；
3. L1–L4 随手修，不需单独轮次。

---

*本报告为内容审核意见，不构成 Stage 03 授权；SOP 流程要求的独立评审与 Owner 签字仍需按各自闸门执行。*
