import type { Generated } from "kysely";

/**
 * 项目成员与 AI 用量归集（候选 C3，合同 10-WP01-contract.md §3）。
 * 全部为管理归集层；禁止把多项目结果回写为原始 usage/ledger 行。
 */

/** 项目核算生命周期版本：核算起止与 principal.status 分离，结束归集不撤 Key。 */
export interface ProjectAccountingProfileVersionTable {
  id: Generated<string>;
  enterprise_id: string;
  project_principal_id: string;
  accounting_started_at: Date;
  accounting_ended_at: Date | null;
  version: number;
  is_current: Generated<boolean>;
  reason: string;
  created_by: string;
  created_at: Generated<Date>;
}

/** 成员参与身份：同一员工同项目退出再加入 = 新 stint；根行不可变。 */
export interface ProjectMembershipTable {
  id: Generated<string>;
  enterprise_id: string;
  project_principal_id: string;
  employee_principal_id: string;
  stint_index: number;
  created_by: string;
  created_at: Generated<Date>;
}

/** 成员参与修订：[joined_at, left_at) 半开；每 stint 至多一条 ACTIVE（EXCLUDE 仅约束 ACTIVE 行）。 */
export interface ProjectMembershipRevisionTable {
  id: Generated<string>;
  membership_id: string;
  enterprise_id: string;
  project_principal_id: string;
  employee_principal_id: string;
  revision: number;
  status: Generated<"ACTIVE" | "SUPERSEDED" | "VOID">;
  joined_at: Date;
  left_at: Date | null;
  idempotency_key: string | null;
  reason: string;
  supersedes_id: string | null;
  created_by: string;
  created_at: Generated<Date>;
}

/** 员工级归集规则集合版本：整组原子发布，员工维度唯一 current；幂等键重放原版本。 */
export interface EmployeeProjectAllocationPolicyTable {
  id: Generated<string>;
  enterprise_id: string;
  employee_principal_id: string;
  version: number;
  is_current: Generated<boolean>;
  input_hash: string;
  idempotency_key: string | null;
  reason: string;
  published_by: string;
  published_at: Generated<Date>;
}

/** 集合内权重段：基点（10000=100%，0 为显式段）；发布后不可变；绑定 ACTIVE 修订。 */
export interface EmployeeProjectAllocationRuleTable {
  id: Generated<string>;
  policy_id: string;
  enterprise_id: string;
  employee_principal_id: string;
  project_principal_id: string;
  membership_id: string;
  membership_revision_id: string;
  weight_bps: number;
  valid_from: Date;
  valid_until: Date | null;
  created_at: Generated<Date>;
}

/** 归集计算批次：只追加；SUCCEEDED/FAILED 终态不可变（仅 is_current 可被接管）；非成功禁 is_current。 */
export interface ProjectAllocationRunTable {
  id: Generated<string>;
  enterprise_id: string;
  period_month: string;
  schema_version: string;
  algorithm_version: string;
  status: Generated<"QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED">;
  generation: number;
  input_digest: string | null;
  rule_input_digest: string | null;
  membership_input_digest: string | null;
  manual_attribution_input_digest: string | null;
  source_fact_digest: string | null;
  source_snapshot_as_of: Date | null;
  input_dirty_generation: number | null;
  actor_type: "SYSTEM" | "ADMIN";
  actor_admin_id: string | null;
  attempt: Generated<number>;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  last_error: string | null;
  is_current: Generated<boolean>;
  source_line_count: number | null;
  employee_count: number | null;
  project_count: number | null;
  conservation: Record<string, unknown> | null;
  completeness: Record<string, unknown> | null;
  result_hash: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  duration_ms: number | null;
  created_at: Generated<Date>;
  updated_at: Date;
}

/** 源行归集结果：未分配目标零 UUID 哨兵；金额份额沿用源精度；套餐成本币种固定 CNY。 */
export interface ProjectAllocationLineTable {
  id: Generated<string>;
  run_id: string;
  enterprise_id: string;
  ledger_line_id: string;
  ai_request_id: string;
  upstream_attempt_id: string;
  provider_resource_id: string | null;
  unified_model_id: string | null;
  request_started_at: Date;
  accounted_at: Date;
  source_principal_id: string;
  target_type: "PROJECT" | "UNALLOCATED";
  target_project_principal_id: string;
  allocation_source: "PROJECT_DIRECT" | "MANUAL_ASSIGNMENT" | "MEMBERSHIP_RULE" | "UNALLOCATED";
  weight_bps: number | null;
  policy_id: string | null;
  membership_id: string | null;
  membership_revision_id: string | null;
  segment_from: Date | null;
  segment_until: Date | null;
  unallocated_reason:
    | "HISTORICAL_UNKNOWN"
    | "NO_MEMBERSHIP"
    | "NO_EFFECTIVE_RULE"
    | "WEIGHT_REMAINDER"
    | "RULE_PENDING_REPAIR"
    | null;
  source_input_tokens: number | bigint;
  source_output_tokens: number | bigint;
  source_cache_tokens: number | bigint | null;
  source_reasoning_tokens: number | bigint | null;
  share_input_tokens: string;
  share_output_tokens: string;
  share_cache_tokens: string | null;
  share_reasoning_tokens: string | null;
  source_api_cost: string | null;
  share_api_cost: string | null;
  api_cost_currency: string | null;
  source_package_cost: string | null;
  share_package_cost: string | null;
  package_cost_currency: Generated<"CNY">;
  usage_quality: string;
  resource_mode: string;
  created_at: Generated<Date>;
}

/** 启用登记：首次启用同事务登记初始化任务。 */
export interface ProjectAllocationPeriodTable {
  enterprise_id: string;
  period_month: string;
  enabled_by: string;
  enabled_at: Generated<Date>;
}

/** 脏代次：每次失效标记 generation+1；陈旧度由 dirty.generation 与 run.input_dirty_generation 比较推导。 */
export interface ProjectAllocationDirtyTable {
  enterprise_id: string;
  period_month: string;
  generation: Generated<number>;
  dirty: Generated<boolean>;
  last_marked_at: Generated<Date>;
}

/** 补偿扫描水位（按企业一行）：只兜 ledger_line 迟到插入；其余事实变更由写入方同事务推脏。 */
export interface ProjectAllocationScanWatermarkTable {
  enterprise_id: string;
  ledger_line_watermark: Date;
  updated_at: Generated<Date>;
}

/** 资源级套餐待分配成本：无源行可承接的月费余量，不伪造 Token、不入源行守恒公式。 */
export interface ProjectAllocationResourceResidualTable {
  run_id: string;
  provider_resource_id: string;
  enterprise_id: string;
  amount: string;
  currency: Generated<"CNY">;
  note: string | null;
  created_at: Generated<Date>;
}

/** 账单冻结引用：只存不可变 run 引用与核对摘要；RESTRICT 保护被引用 run。 */
export interface OperatingBillProjectAllocationRefTable {
  id: Generated<string>;
  enterprise_id: string;
  bill_version_id: string;
  run_id: string;
  frozen: Record<string, unknown>;
  created_at: Generated<Date>;
}
