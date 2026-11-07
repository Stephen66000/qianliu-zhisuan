# 审计收敛预算与阶段账本记录（v1.5 §一/§五）

schema_version: "1.1"
budget_id: "cq-v15-api-decouple-20261107"
project: "仟流智算"
stage_or_work_package: "simplify-api-cost-and-official-balance 代码质量预检整改与送审"
audit_mode: "code_quality"
audit_round: 0（整改轮；正式审核未开始）
contract_ref: "handoff/code-quality-v1.5/plan.md（冻结）＋交接/V1.5代码质量预检-20261107/zcode整改与送审指令.md"
risk_level: "R3"（含资金/迁移/删除触发事项；沿用 V3 HIGH 定级）
coding_model: "GLM-5.3-Flash（glm-flash，thoughtLevel high）"
review_model: "正式审核待验收人指定（预检 gpt-6.1-sol）"
independence_check: "待正式审核时按 SOP 3.4 填写"
reviewed_object: "送审候选 38ab493（对象锁见 evidence/candidate-lock.json）"
pre_handshake_state: "READY_FOR_CODE_AUDIT（材料就绪；握手未执行）"
runtime_state: "（未迁移——CODE_AUDIT_IN_PROGRESS 由 Planning 在正式 Reviewer 就绪并重读账本后原子写入）"
audit_status: "NOT_STARTED"

max_fix_batches: 1
max_reaudit_rounds: 2
wall_clock_minutes: 420
budget_hit_action: "STOP_AND_REPORT"

# 运行记录（2026-11-07）
elapsed_wall_clock_minutes: 约 235（08:40 冻结 → 11:20 首轮材料 → 11:35 补证完成；含补证阶段约 75'，总指挥亲跑未委派）
fix_batches_used: 1/1（CQ-01 含一次总指挥返工指令；GATE-01 三串行子合同属同批）
reaudit_rounds_used: 0/2（预留给正式审核复审）
new_uncached_tokens_used: "N/A（平台不提供）"
first_budget_hit: null
# 补证阶段记录（2026-11-07 11:20-11:35）：按指令只跑既有工具——build×3/jscpd/licenses/audit 全 PASS；覆盖率 5/6 池 PASS、pool029 FAIL（w05 配置上下文型，P1）→ratchet 阻断；变异适用性核查＝无适用配置（P2）。
# 开审阻断候选：P1（ratchet 门禁）＋P2（新模块变异/覆盖配置缺）——是否补齐/豁免由验收人裁定；握手维持不执行。

planning_owner: "GLM-5.3 总指挥（zcode 会话）"
execution_dri: "glm-flash 子 Agent×5 合同（CQ-01×2 轮、GATE-01×3 批）"
callback_target: "用户（验收人）"

# 审计需读取的材料（正式 Reviewer 清单）
# 1. 本目录：plan.md（合同/预算）、candidate.md（候选/绑定）、gates-evidence.md（逐门禁）
# 2. V4/Evidence/API-COST-OFFICIAL-BALANCE/CODE-QUALITY-V15-20261107/：red-evidence/（CQ-01 红绿桩证＋三份 diff）、logs/（X07 命令留痕）、candidate-lock.json（对象锁）
# 3. 预检输入：交接/V1.5代码质量预检-20261107/（审核报告/桩证/preflight json）
# 4. X07 沿革：handoff/work-packages/WP6/x07-r3/r4/r5-20261106.md
