import type { Generated } from "kysely";

/** W20-04：可重建的小时／日用量读模型，不是结算事实。 */
export interface UsageBucketAggregateTable {
  id: Generated<string>; enterprise_id: string; bucket_granularity: "HOUR" | "DAY";
  bucket_start: Date; timezone: string; source_principal_id: string;
  project_principal_id: string | null; provider_resource_id: string | null;
  unified_model_id: string | null; request_count: Generated<bigint>;
  input_tokens: Generated<bigint>; output_tokens: Generated<bigint>;
  cache_tokens: Generated<bigint>; reasoning_tokens: Generated<bigint>;
  deducted_quota: Generated<bigint>; api_cost: Generated<string>;
  fact_watermark: Date | null; max_fact_at: Date | null;
  dirty: Generated<boolean>; generated_at: Generated<Date>;
}

export interface UsageAggregateDirtyBucketTable {
  enterprise_id: string; bucket_granularity: "HOUR" | "DAY";
  bucket_start: Date; timezone: string; marked_at: Generated<Date>;
}

export interface UsageAggregateBucketStateTable {
  enterprise_id: string; bucket_granularity: "HOUR" | "DAY";
  bucket_start: Date; timezone: string; fact_watermark: Date | null;
  max_fact_at: Date | null; generated_at: Date;
}

/** W20-06：项目在请求发生时点的有效部门归属。历史行只关闭、不覆盖。 */
export interface ProjectDepartmentAssignmentTable {
  id: Generated<string>; enterprise_id: string; project_principal_id: string;
  organization_unit_id: string; valid_from: Date; valid_until: Date | null;
  source: "EXPLICIT" | "OWNER_DEPARTMENT_DEFAULT";
  owner_person_id_at_assignment: string | null; version: Generated<number>;
  created_by: string | null; reason: string | null; created_at: Generated<Date>;
}

/** W20-06：请求归属不可变快照；人工修正以更高版本追加。 */
export interface RequestAttributionSnapshotTable {
  id: Generated<string>; enterprise_id: string; ai_request_id: string;
  source_principal_id: string; employee_person_id: string | null;
  project_principal_id: string | null; organization_unit_id: string | null;
  cost_category: "EMPLOYEE_DIRECT" | "PROJECT" | "UNASSIGNED";
  attribution_source: "PROJECT_DIRECT" | "EMPLOYEE_PROJECT" | "EMPLOYEE_MEMBERSHIP" | "UNASSIGNED";
  request_occurred_at: Date; version: number; supersedes_id: string | null;
  snapshot_origin: Generated<"MIGRATION_BACKFILL" | "RUNTIME" | "CORRECTION">;
  reason_code: string | null; created_by: string | null; created_at: Generated<Date>;
}
