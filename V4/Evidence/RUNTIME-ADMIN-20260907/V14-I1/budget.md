# I1 审核收敛预算

- audit_mode: `code_quality`
- audit_round: `i1-initial`
- risk_level: `R3`
- reviewed_object: `candidate-lock-final2.json`
- finding_freeze_rule: `COMPLETE_FROZEN_MATRIX_BEFORE_FIRST_FIX`
- max_fix_batches: `0`（审核会话只报告，不修复）
- max_reaudit_rounds: `0`
- wall_clock_minutes: `30`
- mutation_scope: 仅对本轮核心状态转换做安全、有界、可复查的增量检查；不扩大全仓
- budget_hit_action: `STOP_AND_REPORT`
- callback_target: `/root`
