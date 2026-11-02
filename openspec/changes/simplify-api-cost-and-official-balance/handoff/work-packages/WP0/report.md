# WP0 结包报告：基线与契约

包：WP0（tasks 1.1、1.2）；执行人/模型：GLM-5.3 总指挥（zcode 会话，本包未使用子 Agent，原因见 §4.3）；日期：2026-11-02。

## 1. 基线与工作区状态

- 起止源码基线：origin/main `ae506fed47d21865420afa91137e8b244072933e`（PR #7 合并提交，已重新 fetch 核实，与指令给定的 SHA 一致）。本包为只读核查，无代码提交；起止一致。
- 分支：`codex/employee-quota-monthly-reporting`（HEAD `9a5fd56…`＝PR #7 head，origin/main 的祖先）。工作树相对 origin/main 仅 5 M＋1 D＋未跟踪工件（无未合并业务代码；明细 baseline.md §2）。全程未执行 checkout/reset/rebase/commit/stash。
- 迁移水位（源码）：0000-0092；0092 已被员工月度额度占用，本 change 新迁移自 0093 起。
- 生产：未核实（无只读权限；用户声明 PR #7 未部署、0092 未生产执行）→ BLOCKED 记录。

## 2. 计划 vs 实际交付

| 计划（plan.md） | 实际 | 证据 |
|---|---|---|
| 调查 A 资金写入口/触发器/PENDING/候选 | 完成：19 个写入口逐个判定退役/保留/拆分；3 组触发器；PENDING 过滤点 file:line | notes/inv-a.md |
| 调查 B 费用读取/计价/价格来源 | 完成：计价复用基础、月度桥接口径、remainingQuota 覆盖点、价格依据字段缺口 | notes/inv-b.md |
| 调查 C 官方余额同步 | 完成：适配器能力、runner 三处耦合、快照表约束真相、恢复链路、手动刷新不存在 | notes/inv-c.md |
| 调查 D 迁移/测试/CI/环境 | 完成：脚本真实/占位清单、CI 步骤、passWithNoTests 告警、隔离环境要求 | notes/inv-d.md |
| baseline.md（task 1.1） | 完成：基线、工作区差异、入口清单索引、迁移与回退策略、实施起点建议 | baseline.md |
| contracts.md（task 1.2） | 完成（参数除外）：五合同落实际路由/字段、spec 一致性核对、切换顺序、WP1 委派基准；**P1-P6 参数待用户确认** | contracts.md |

变更文件（全部为本包文档/基建，无业务代码）：`handoff/work-packages/WP0/{plan,report}.md`、`notes/inv-{a,b,c,d}.md`、`baseline.md`、`contracts.md`；`.zcode/agents/glm-flash.md`（新会话加载，.gitignore 已忽略）。接口/配置变化：无（纯文档）。提交：无。

## 3. 验证记录

- git 事实：`git fetch`＋`rev-parse`＋`merge-base --is-ancestor`＋`diff origin/main --name-status`＋`ls-tree`（输出在会话记录；结论入 baseline.md §1-§3）。
- 代码事实：全部以 file:line 落 notes/inv-a~d.md；关键行（resource-pool-repository.ts:450、routes.ts:67-317、runner.ts:118-125、provider-operating-facts.ts:51、config/index.ts:35-37）直接读取源文件核实，非引用旧报告。
- 模型可用性：`ListModels` 核实 `account:bigmodel-individual-coding-plan/GLM-5.3-Flash` 存在。
- 本包无测试用例（纯文档），无 PASS/FAIL 用例可报；tasks.md 两项**均未勾选**（见 §4.2）。

## 4. 审核发现、未解决项与范围外检查

### 4.1 审核发现（已按"以代码为准"记录，不改 spec）

1. design 表述与实现的两处差异：0081 文件头注释残留旧编号"0078"；"(企业,资源,同步日)唯一"为读取侧行为约束而非表硬约束（0026 仅 (resource,version) 唯一）。已记录，不改 spec、不改旧迁移。
2. `PROVIDER_FINANCE_MODE` 默认 ACTIVE——WP2/WP6 切换方案必须考虑"默认即开"的现网语义，退役后该开关对 API 资金部分失效但套餐继续使用。
3. billing_rule 无价格来源/核实字段：ACE-02 场景 3 需新增字段（contracts.md C1/P6），属 spec 已含需求，非遗漏。
4. 冲销(W7)/重复候选(W8)与套餐共享路径——WP2 拆分时需逐事件类型负向测试（已在 inv-a.md §6 移交）。

### 4.2 未解决/未核实

| 项 | 状态 | 影响 |
|---|---|---|
| 生产版本/迁移水位/开关 | BLOCKED（无只读权限） | WP6 前必须补核或明确记录 |
| P1-P6 参数 | 待用户确认 | WP2 前冻结 P4/P5；P1-P3 可先以可配置默认承接 |
| tasks.md 1.1/1.2 勾选 | 未勾 | 1.1 因生产核实受阻；1.2 因参数未确认——用户确认参数并接受"生产未核实"记录后可勾选 |
| DeepSeek 限流数值 | 未核实 | 影响 P1 最终值 |

### 4.3 执行方式偏差说明

指令要求调查/实现交 Flash 子 Agent。本会话 Agent 类型列表启动时固定，无法中途加载模型绑定的自定义类型（已试：`glm-flash` not found）。处置：WP0 属总指挥明确有权直接执行的"读代码/核对差异/维护记录"范畴，由总指挥直接完成并留证；**WP1 起必须使用 `glm-flash`**（定义文件已就位，新会话可用）；未用 general-purpose 顶替（模型不可核实，违反"不擅自换型号"）。

### 4.4 范围外改动检查

`git status` 前后对比：本包未触碰任何业务代码/迁移/测试/配置；未动其他任务在途内容（残留工件原样保留）。

## 5. 本包结论

**通过（文档层）**：WP0 退出条件"来源与差异可查；新增字段含义和切换边界明确"已满足——baseline.md（差异可查）＋contracts.md（字段含义 C1/C2、切换边界 §3）。遗留：生产核实 BLOCKED、参数待确认（不阻塞 WP1 的费用读取与夹具工作，per development-plan §2"仅参数待确认时，可以继续独立的费用读取和测试夹具工作"）。

后续联调尚未执行（全部 50 条用例 NOT_RUN，属 WP5）。

## 6. WP1 启动交接

- 基线：新 worktree/分支自 `ae506fed47d21865420afa91137e8b244072933e`；把 `openspec/changes/simplify-api-cost-and-official-balance/`（当前未跟踪）复制入 worktree 并首提交。
- 依赖：contracts.md §5 委派合同基准（范围/禁止/完成条件）；notes/inv-b.md（费用链路事实）。
- 注意：价格依据状态字段是唯一新增迁移（0093）；不动 W5/W6/触发器语义/官方余额/页面；占位脚本不作证据；`passWithNoTests` 陷阱；子 Agent 用 `glm-flash`。
- 下一任务启动指令（复制给新任务，其余指令全文不变，仅改两处参数）：

> ## 任务参数
> - 当前工作包：**WP1**。
> - 上一包交接记录：`openspec/changes/simplify-api-cost-and-official-balance/handoff/work-packages/WP0/report.md`（已通过，遗留项见其 §4.2）。
> - 开发执行子 Agent：`.zcode/agents/glm-flash.md` 已就位（GLM-5.3-Flash）；新会话直接以 `subagent_type: glm-flash` 委派。
> - 其余任务参数与指令全文同 `handoff/zcode-commander-instructions.md`。
