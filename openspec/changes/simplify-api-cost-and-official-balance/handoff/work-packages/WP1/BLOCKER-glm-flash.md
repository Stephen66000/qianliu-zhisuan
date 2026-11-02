# BLOCKER 记录：glm-flash 子 Agent 无法在本会话启动（2026-11-02）

## 现象
以 `subagent_type: glm-flash` 委派（含最小探针"回复 OK"）一律失败：
`Cannot start subagent: No reasoning level selected / 未选择思考档位 [reason=reasoning-level-missing; selection=account:bigmodel-individual-coding-plan/GLM-5.3-Flash]`

## 根因（已核实）
1. ZCode 从 `.zcode/agents/*.md` frontmatter 解析子 Agent 模型：`model:` + **`thoughtLevel:`**（映射 options.reasoningLevel；zcode.cjs 中 `ire()`，键名 `thoughtLevel`）。WP0 生成的定义缺 `thoughtLevel` 键。
2. 该编码套餐的 GLM-5.3-Flash 要求显式思考档位（可用 low/high/max，默认 max 仅在 UI 选择时生效，子 Agent 配置文件里必须写明）。
3. Agent 定义在**会话启动时一次性加载**；本会话内改文件无效（判别实验：把 model 改为不存在的型号后报错仍显示旧型号）。

## 已做修复（供新会话生效）
`/Users/mac/Projects/仟流智算/.zcode/agents/glm-flash.md` frontmatter 已补：
`model: account:bigmodel-individual-coding-plan/GLM-5.3-Flash` + `thoughtLevel: max`（不换型号，取默认档位）。
**新会话须验证**：Agent 列表出现 glm-flash 后先派"回复 OK"探针确认可启动，再派 S1。

## 影响
- WP1 全部业务实现（S1/S2/S3）依赖 glm-flash；本会话被阻塞，未做任何业务代码改动。
- 未用 general-purpose 顶替（运行在 GLM-5.3 主模型，违反"不擅自换型号"）；总指挥也不自行实现业务代码（指令§一）。

## 已就绪产物（新会话直接复用）
- `handoff/work-packages/WP1/plan.md`（本包计划：范围/决策/验证/完成条件）
- `handoff/work-packages/WP1/contracts/S1.md`（task 2.1 完整委派合同，原样可用）
- S2/S3 合同待 S1 落地后按 plan.md §5 拟定。

## 恢复路径
用户新开任务，读取并执行 `openspec/changes/simplify-api-cost-and-official-balance/handoff/work-packages/WP1/task.md`（指令不变），新会话先跑 glm-flash 探针，通过后从 S1 开始。
