import type { Generated } from "kysely";
import type {
  ActivationCandidateStatus, ActivationCurrency, ActivationDecision, ActivationDraft,
  ActivationReceipt, FactWatermark, ProjectedFinanceSummary, ResourceFinanceState,
  UsageRepairBaselineRow,
} from "@qianliu/domain";

/**
 * 0078 / 0079 资金账本初始化控制表类型（WP01、WP04）。
 *
 * 这些表不是资金事实表：候选（含候选草稿载荷）与静默租约不得参与余额、成本或经营账单查询；
 * 资源资金状态只用于 PFH-07 调度门禁。
 */
export interface ProviderFinanceActivationAttemptTable {
  id: Generated<string>;
  enterprise_id: string;
  candidate_hash: string;
  fact_watermark_hash: string;
  decision: ActivationDecision;
  status: Generated<ActivationCandidateStatus>;
  gap_summary: Array<{ code: string; count: number }>;
  projection_summary: ProjectedFinanceSummary;
  usage_repair_baseline: UsageRepairBaselineRow[];
  /**
   * 候选业务草稿载荷（0079）。激活接口不接受草稿，权威草稿只能来自这里；
   * 与 `candidate_hash` 互为校验，任何篡改都会让激活以 `CANDIDATE_STALE` 失败关闭。
   */
  candidate_draft: ActivationDraft;
  created_by_admin_user_id: string;
  created_at: Generated<Date>;
  expires_at: Date;
  activation_idempotency_key: string | null;
  activation_result: ActivationReceipt | null;
  activated_by_admin_user_id: string | null;
  activated_at: Date | null;
}

export interface ProviderFinanceActivationQuiescenceTable {
  enterprise_id: string;
  status: Generated<"ACTIVE" | "RELEASED" | "EXPIRED">;
  started_by_admin_user_id: string;
  started_at: Date;
  expires_at: Date;
  released_at: Date | null;
  release_reason: string | null;
}

export interface ProviderResourceFinanceStateTable {
  provider_resource_id: string;
  enterprise_id: string;
  state: Generated<ResourceFinanceState>;
  required_currencies: ActivationCurrency[];
  ready_at: Date | null;
  ready_by_admin_user_id: string | null;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type { FactWatermark };
