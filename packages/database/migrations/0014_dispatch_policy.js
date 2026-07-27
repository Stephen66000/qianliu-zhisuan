/**
 * 迁移 0014 —— 经营调度策略与决策（W16）。
 *
 * 依据：TRD §9.1 行 609-632（经营调度叠加）、§5.6 行 314-321（dispatch_policy_version）、
 * §5.7 行 342（dispatch_decision 不可覆盖）。
 *
 * dispatch_policy：管理员发布的版本化经营策略。
 *   - 状态机 DRAFT/VALIDATED/PUBLISHED/RETIRED；只有 PUBLISHED 进热路径；
 *   - 匹配条件：统一模型/资源模式/时间窗/价格倍率/剩余额度比例/预计耗尽风险/主体范围；
 *   - 允许动作 ALLOW/SWITCH/RATE_LIMIT/REJECT/ALLOW_OVERAGE；
 *   - SWITCH 只能引用已发布的等价资源组；
 *   - 变更只影响新请求，历史决策继续引用旧版本。
 *
 * dispatch_decision：每次请求前经营决策快照（不可覆盖）。
 *   - 经营输入（命中候选/余额/耗尽风险/价格倍率）+ 命中策略 + 候选动作 + 最终动作 + 理由；
 *   - 反事实基线 + 可证明节省（不可比 → NOT_CALCULABLE）。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  // dispatch_policy：版本化经营策略
  await db.schema
    .createTable("dispatch_policy")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    // 状态机：DRAFT/VALIDATED/PUBLISHED/RETIRED；只有 PUBLISHED 进热路径
    .addColumn("status", "varchar(16)", (c) => c.notNull().defaultTo("DRAFT"))
    // 匹配条件（jsonb；nullable 字段表示"不限"）
    .addColumn("match_unified_model", "varchar(64)") // 统一模型别名（null=任意）
    .addColumn("match_resource_mode", "varchar(16)") // API|CODING_PLAN（null=任意）
    .addColumn("match_provider_resource_id", "uuid") // 指定资源（null=任意；用于成本/额度策略）
    .addColumn("match_timezone", "varchar(32)") // 时区（如 Asia/Shanghai）
    .addColumn("match_days_of_week", "jsonb") // [0..6]（null=任意）
    .addColumn("match_start_time", "varchar(8)") // HH:mm:ss（null=任意）
    .addColumn("match_end_time", "varchar(8)") // HH:mm:ss
    .addColumn("match_price_multiplier_min", "numeric") // 价格倍率下限（≥，命中高峰）
    .addColumn("match_remaining_quota_ratio_max", "numeric") // 剩余额度比例上限（≤，耗尽风险）
    .addColumn("match_forecast_exhaust_risk", "boolean") // 预计耗尽风险（true=仅当 forecastExhaustAt 在周期内）
    .addColumn("match_principal_scope", "jsonb") // 主体范围 [principalId]（null=任意）
    // 动作
    .addColumn("action", "varchar(20)", (c) => c.notNull()) // ALLOW/SWITCH/RATE_LIMIT/REJECT/ALLOW_OVERAGE
    // SWITCH 专用：等价资源组（引用一组可切换的 provider_resource_id）
    .addColumn("switch_equivalent_group", "jsonb") // [resourceId]（仅 SWITCH 使用，引用管理员发布的等价组）
    // RATE_LIMIT 专用：限流速率（请求/分钟；null=不限具体数，仅标记限流）
    .addColumn("rate_limit_per_minute", "integer")
    // 版本与策略标识
    .addColumn("policy_version", "varchar(32)", (c) => c.notNull()) // 策略版本（如 w16-v1）
    .addColumn("priority", "integer", (c) => c.notNull().defaultTo(100)) // 数值越小优先级越高（同请求多命中时）
    .addColumn("description", "text") // 策略说明（来源/合同/依据）
    .addColumn("source", "varchar(128)") // 来源（合同/公开规则/采购渠道）
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .execute();

  await sql`ALTER TABLE dispatch_policy ADD CONSTRAINT dispatch_policy_status_check CHECK (status IN ('DRAFT','VALIDATED','PUBLISHED','RETIRED'))`.execute(db);
  await sql`ALTER TABLE dispatch_policy ADD CONSTRAINT dispatch_policy_action_check CHECK (action IN ('ALLOW','SWITCH','RATE_LIMIT','REJECT','ALLOW_OVERAGE'))`.execute(db);
  await sql`ALTER TABLE dispatch_policy ADD CONSTRAINT dispatch_policy_resource_mode_check CHECK (match_resource_mode IS NULL OR match_resource_mode IN ('API','CODING_PLAN'))`.execute(db);
  // 热路径查询：enterprise + PUBLISHED
  await db.schema
    .createIndex("dispatch_policy_enterprise_published_idx")
    .ifNotExists()
    .on("dispatch_policy")
    .columns(["enterprise_id", "status", "priority"])
    .execute();

  // dispatch_decision：每次请求前经营决策快照（不可覆盖，§5.7 行 342）
  await db.schema
    .createTable("dispatch_decision")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("ai_request_id", "uuid", (c) => c.notNull().references("ai_request.id"))
    // 经营输入快照（冻结本次理由，配置变化不改写）
    .addColumn("dispatch_input", "jsonb") // { selectedResourceId, candidateResourceIds, remainingQuotaRatio, forecastExhaustAt, priceMultiplier, now }
    // 命中策略（引用 + 版本）
    .addColumn("matched_policy_id", "uuid") // 引用 dispatch_policy.id（可空=无命中策略，默认 ALLOW）
    .addColumn("matched_policy_version", "varchar(32)") // 策略版本快照
    .addColumn("matched_policy_action", "varchar(20)") // 策略原始动作
    // 最终动作（结合硬约束后）
    .addColumn("final_action", "varchar(20)", (c) => c.notNull()) // ALLOW/SWITCH/RATE_LIMIT/REJECT/ALLOW_OVERAGE
    // 理由（机器可读 reason code）
    .addColumn("reason_code", "varchar(64)", (c) => c.notNull())
    .addColumn("reason_detail", "text") // 人类可读补充
    // SWITCH 专用：切换目标
    .addColumn("switch_target_resource_id", "uuid") // 等价组内切换到的资源
    // 反事实基线与节省（§9.1 行 620-632）
    .addColumn("counterfactual_cost", "numeric") // 反事实基线成本（decimal）
    .addColumn("actual_cost", "numeric") // 实际执行成本（decimal）
    .addColumn("dispatch_saving", "numeric") // 节省 = 反事实 − 实际（null=未执行；NOT_CALCULABLE 标记见 saving_calculable）
    .addColumn("saving_calculable", "boolean", (c) => c.notNull().defaultTo(true)) // false=NOT_CALCULABLE（基线不可比/仅提示/无价格证据）
    .addColumn("not_calculable_reason", "varchar(64)") // saving_calculable=false 时的原因
    .addColumn("decided_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .execute();

  await sql`ALTER TABLE dispatch_decision ADD CONSTRAINT dispatch_decision_final_action_check CHECK (final_action IN ('ALLOW','SWITCH','RATE_LIMIT','REJECT','ALLOW_OVERAGE'))`.execute(db);
  await sql`ALTER TABLE dispatch_decision ADD CONSTRAINT dispatch_decision_matched_action_check CHECK (matched_policy_action IS NULL OR matched_policy_action IN ('ALLOW','SWITCH','RATE_LIMIT','REJECT','ALLOW_OVERAGE'))`.execute(db);
  // 一个请求一条决策（不可覆盖；幂等重放不重复）
  await db.schema
    .createIndex("dispatch_decision_request_idx")
    .ifNotExists()
    .on("dispatch_decision")
    .columns(["ai_request_id"])
    .unique()
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropTable("dispatch_decision").ifExists().execute();
  await db.schema.dropTable("dispatch_policy").ifExists().execute();
}
