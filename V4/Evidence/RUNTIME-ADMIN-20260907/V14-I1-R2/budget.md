# I1 有界复审预算

- audit_mode: `code_quality`
- audit_round: `i1-reaudit-1`
- risk_level: `R3`
- max_fix_batches: `0`
- max_reaudit_rounds: `1`
- wall_clock_minutes: `30`
- mutation_scope: 原 F-04 的管理员成功审计与最新 Attempt 选择，以及 P1 查询改写的直接关键条件
- budget_hit_action: `STOP_AND_REPORT`
- callback_target: `/root`
