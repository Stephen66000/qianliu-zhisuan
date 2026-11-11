# 返修轮 R1 计划：验收退回整改（四阻断＋W20-10 归因＋验收资产）

日期：2026-11-05；总指挥：GLM-5.3（zcode 会话）；实施：glm-flash 子 Agent 串行。授权：用户 2026-11-05（"同意，依然采用总指挥＋子 Agent 修复"）。

## 1. 输入

- 验收退回意见：development-summary.md §6（验收人 Kimi Code，2026-11-05，提交 `686100f`）。
- 总指挥核实结论：四项功能阻断（A/B/C/D）＋E（租约过期）＋W20-10 归因错误全部属实（核实记录见会话；file:line：contracts.ts:51/:133、official-balance-states.ts:92/:136、billing-rule.ts computeApiCostFromRule、api-cost-estimation.ts:125、resource-insights/query.ts:330）。
- 基线：HEAD `686100f`（含验收记录）；旧基线 worktree `/Users/mac/Projects/仟流智算-wp6-legacy-ae506fe`（ae506fe）保留，R5 A/B 复用。

## 2. 修复项与验收标准（固定，不得降低）

| 项 | 修复 | 验收标准（对应验收意见） |
|---|---|---|
| F1 写旁路封堵＋读侧来源 | HTTP 合同禁止客户端自报官方来源（PROVIDER_SYNC/BILL_RECONCILIATION 不进客户端合同或服务端强制覆盖）；读侧按 design D2 补 `PROVIDER_API` 过滤 | 创建/编辑/onboarding 三入口提交 PROVIDER_SYNC＋金额→拒绝且零落库；负向回归≥3 条；已冒充行不显示为官方 |
| F2 缺价不补零 | `computeApiCostFromRule` 对**适用分项**（对应用量>0）缺价→PRICE_MISSING 语义（api_cost NULL），不再 `?? "0"` | 验收人复验场景复现：完整价 0.00104000 不变；缺输入价→不再产出 0.00044000 完整金额，而是部分未知/PRICE_MISSING；旧行不重算（AFR-06） |
| F3 历史依据快照 | 聚合改读请求时快照的 sourceStatus（或等效不可变证据）；快照未含依据的旔回退语义不得引用当前规则值冒充当时状态 | 修改规则 source_status 后历史请求依据状态不变；历史追溯回归 |
| F4 租约过期收敛 | `SYNCING` 判定加 `expires_at > now`；过期 RUNNING 回落快照/失败态 | 过期租约行→不再 SYNCING；OAB-04 收敛回归 |
| F5 W20-10 归因＋A/B | 三处文档（release-candidate §7.3、development-summary §4.5、WP5 表述）归因改"尚未闭合"；同机 ae506fe vs 候选 A/B 或耗时分解 | 归因撤回"零触碰"；A/B 数据或分解入档；CI 四项 P95 通过前发布阻断保留 |
| F6 验收资产纠正 | matrix.md 统一口径（受影响条目 ACE-02/04、OAB-01/04 等改 FAIL/REOPEN，撤销 50/50 终态）；页首末矛盾、陈旧行号、修复前/空白截图清理 | 单一口径、可追溯；负向场景入矩阵 |
| F7 整库备份恢复演练 | 隔离库 pg_dump→dropdb→createdb→恢复→核对迁移头＋受保护摘要 | 实际执行证据（非纸面） |

## 3. 阶段（串行，一次一个子 Agent）

| 阶段 | 内容 | 执行 |
|---|---|---|
| R0 | 验收记录提交＋本计划 | 总指挥 ✅ |
| R1 调查 | F1/F2/F3 实施点：三个入口写链路落库点与 schema 共用面；computeApiCostFromRule 调用链与 api_cost_status 值域；billing_rule_snapshot 结构（是否含 sourceStatus）；手动刷新/worker 写侧 source 值；负向回归落点 | glm-flash 只读 |
| R2 | F1＋F4 实施＋回归 | glm-flash |
| R3 | F3 实施＋回归 | glm-flash |
| R4 | F2 实施＋回归（结算链，含 X06 金额链复验） | glm-flash |
| R5 | F5 A/B 演练＋三处文档归因改写 | glm-flash＋总指挥复跑 |
| R6 | F6 矩阵/资产重装配 | glm-flash＋总指挥审定 |
| R7 | F7 备份恢复演练 | glm-flash |
| R8 | 总指挥全面复核＋返修报告＋提交 | 总指挥 |

## 4. 红线（不变）

不改 0092-0096 迁移文件本体（F3 若需冻结新字段只走结算快照 JSONB 内容，不加列则零迁移；确需迁移先报批）；不重算旧行；不动已关账；不删用例不降阈值；主仓零写入；修复后交回验收人复审，不自行宣布验收通过。
