export interface RawLineCostRow {
  department_id: string | null;
  employee_direct_cost: string | null;
  project_cost: string | null;
  api_cost: string | null;
  package_allocated_cost: string | null;
  input_tokens: string;
  output_tokens: string;
}

export interface RawCostRow extends RawLineCostRow {
  request_count: string;
  missing_snapshot_count: string;
}

export interface RawPackageSummary {
  package_cost: string | null;
  unallocated_package_cost: string | null;
  unknown_resource_count: string;
  unallocated_resource_count: string;
}

export interface RawEnterpriseSummary {
  input_tokens: string;
  output_tokens: string;
  api_cost: string | null;
  request_count: string;
}

export interface RawCostAggregateRow extends RawPackageSummary {
  department_id: string | null;
  employee_direct_cost: string | null;
  project_cost: string | null;
  api_cost: string | null;
  package_allocated_cost: string | null;
  input_tokens: string | null;
  output_tokens: string | null;
  cost_row_present: boolean | null;
  timezone: string;
}

export interface RawRequestRow {
  department_id: string | null;
  request_count: string;
  missing_snapshot_count: string;
}

export interface RawBounds {
  timezone: string;
  started_at: Date;
  ended_at: Date;
  has_plan_resources: boolean;
}
