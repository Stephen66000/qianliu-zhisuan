import { sql, type RawBuilder } from "kysely";
import { operatingBillMonthRange } from "./operating-bill-month.js";
import { liveProjectMetadataJoins } from "./operating-bill-project-metadata.js";

/** Resolve the whole month's resource denominator before subject, provider or page filters. */
function accountMonthLineCtes(enterpriseId: string, start: Date, end: Date) {
  return sql`
    finance_state AS (
      SELECT COALESCE((SELECT strict_writes_enabled FROM provider_finance_runtime_state
        WHERE enterprise_id=${enterpriseId}::uuid), false) AS enabled
    ), account_month_lines AS (
      SELECT ll.*, finance.enabled AS finance_enabled,
             CASE WHEN finance.enabled THEN ll.settled_at ELSE ll.created_at END AS account_at
        FROM ledger_line ll CROSS JOIN finance_state finance
       WHERE ll.enterprise_id=${enterpriseId}::uuid
         AND ((finance.enabled AND ll.settled_at>=${start} AND ll.settled_at<${end})
           OR (NOT finance.enabled AND ll.created_at>=${start} AND ll.created_at<${end}))
    ), monthly_plan_fees AS (
      SELECT provider_resource_id, SUM(cash_paid_cny) AS amount,
             CASE WHEN ROUND(SUM(cash_paid_cny),2)=SUM(cash_paid_cny) THEN 100 ELSE 100000000 END AS scale
        FROM provider_finance_event
       WHERE enterprise_id=${enterpriseId}::uuid
         AND event_type IN ('CODING_PLAN_PURCHASE','CODING_PLAN_RENEWAL','REVERSAL')
         AND occurred_at>=${start} AND occurred_at<${end}
       GROUP BY provider_resource_id
    ), subject_tokens AS (
      SELECT provider_resource_id, principal_id,
             SUM(raw_input_tokens::numeric+raw_output_tokens::numeric) AS tokens
        FROM account_month_lines WHERE resource_mode='CODING_PLAN'
       GROUP BY provider_resource_id, principal_id
    ), share_units AS (
      SELECT subject.*, COALESCE(fee.scale,100) AS scale, ROUND(GREATEST(COALESCE(fee.amount,0),0)*COALESCE(fee.scale,100)) AS fee_units,
             COALESCE(ROUND(GREATEST(COALESCE(fee.amount,0),0)*COALESCE(fee.scale,100))*subject.tokens
               / NULLIF(SUM(subject.tokens) OVER(PARTITION BY subject.provider_resource_id),0),0) AS exact_units
        FROM subject_tokens subject
        LEFT JOIN monthly_plan_fees fee ON fee.provider_resource_id=subject.provider_resource_id
       WHERE subject.tokens>0
    ), ranked_shares AS (
      SELECT shares.*, FLOOR(exact_units) AS base_units,
             ROW_NUMBER() OVER(PARTITION BY provider_resource_id
               ORDER BY exact_units-FLOOR(exact_units) DESC, principal_id) AS remainder_order,
             fee_units-SUM(FLOOR(exact_units)) OVER(PARTITION BY provider_resource_id) AS remainder
        FROM share_units shares
    ), monthly_subject_fees AS (
      SELECT provider_resource_id, principal_id, tokens,
             (base_units+CASE WHEN remainder_order<=remainder THEN 1 ELSE 0 END)/scale AS amount
        FROM ranked_shares
    )
  `;
}

export function liveLineFactCtes(
  enterpriseId: string,
  month: string,
): RawBuilder<unknown> {
  const { start, end } = operatingBillMonthRange(month);
  return sql`
    ${accountMonthLineCtes(enterpriseId, start, end)}, latest_snapshot AS (
      SELECT DISTINCT ON (s.provider_resource_id)
             s.provider_resource_id, s.package_cost, s.effective_from, s.effective_until
        FROM provider_resource_operating_snapshot s
       WHERE s.enterprise_id = ${enterpriseId} AND s.collected_at < ${end}
       ORDER BY s.provider_resource_id, s.collected_at DESC, s.version DESC
    ), resource_deducted AS (
      SELECT ll.provider_resource_id,
             COALESCE(SUM(ll.deducted_quota) FILTER (WHERE ll.resource_mode = 'CODING_PLAN'), 0)::numeric AS total_deducted,
             COUNT(*) FILTER (WHERE ll.resource_mode = 'CODING_PLAN') AS plan_line_count,
             COUNT(*) FILTER (WHERE ll.resource_mode = 'CODING_PLAN' AND ll.usage_quality = 'UNKNOWN') AS unknown_plan_line_count,
             COUNT(ll.deducted_quota) FILTER (WHERE ll.resource_mode = 'CODING_PLAN') AS known_deducted_count
        FROM account_month_lines ll
       WHERE ll.enterprise_id = ${enterpriseId}
         AND ll.account_at >= ${start} AND ll.account_at < ${end}
       GROUP BY ll.provider_resource_id
    ), line_facts AS (
      SELECT ll.ai_request_id AS request_id,
             source.id AS source_principal_id, source.name AS source_principal_name,
             source.type AS source_principal_type,
             project.id AS project_id, project.name AS project_name,
             project_owner.id AS project_owner_person_id,
             COALESCE(accounting_owner.name,project_owner.name) AS project_owner_name,
             project_department.id AS project_department_id,
             project_department.name AS project_department_name,
             p.code AS provider_code, p.name AS provider_name,
             ar.unified_model_id, um.alias AS current_alias,
             ar.unified_model AS historical_alias, ar.status AS request_status,
             attribution.organization_unit_id AS department_id,
             ll.account_at AS created_at, ll.usage_quality, ll.resource_mode,
             ll.raw_input_tokens, ll.raw_output_tokens,
             ll.raw_cache_tokens, ll.raw_reasoning_tokens,
             ll.deducted_quota, ll.api_cost,
             CASE
               WHEN ll.resource_mode <> 'CODING_PLAN' THEN 0::numeric
               WHEN ll.finance_enabled AND COALESCE(month_fee.amount,0) = 0 THEN 0::numeric
               WHEN ll.finance_enabled AND denom.unknown_plan_line_count > 0 THEN NULL
               WHEN ll.finance_enabled THEN CASE WHEN share.tokens > 0
                 THEN share.amount
                   * (ll.raw_input_tokens::numeric+ll.raw_output_tokens::numeric) / share.tokens
                 ELSE 0::numeric END
               WHEN ll.deducted_quota IS NULL OR snap.package_cost IS NULL
                 OR denom.plan_line_count <> denom.known_deducted_count
                 OR (snap.effective_from IS NOT NULL AND snap.effective_from >= ${end})
                 OR (snap.effective_until IS NOT NULL AND snap.effective_until <= ${start})
                 THEN NULL
               WHEN denom.total_deducted > 0
                 THEN snap.package_cost * ll.deducted_quota::numeric / denom.total_deducted
               ELSE 0::numeric
             END AS package_line_cost
        FROM account_month_lines ll
        JOIN ai_request ar ON ar.id = ll.ai_request_id AND ar.enterprise_id = ${enterpriseId}
        JOIN principal source ON source.id = ll.principal_id AND source.enterprise_id = ${enterpriseId}
        JOIN provider_resource resource
          ON resource.id = ll.provider_resource_id AND resource.enterprise_id = ${enterpriseId}
        JOIN provider p ON p.id = resource.provider_id AND p.enterprise_id = ${enterpriseId}
        LEFT JOIN unified_model um
          ON um.id = ar.unified_model_id AND um.enterprise_id = ${enterpriseId}
        LEFT JOIN operating_bill_request_project_assignment assignment
          ON assignment.ai_request_id = ll.ai_request_id AND assignment.enterprise_id = ${enterpriseId}
        ${liveProjectMetadataJoins(enterpriseId)}
        LEFT JOIN monthly_subject_fees share ON share.provider_resource_id=ll.provider_resource_id
          AND share.principal_id=ll.principal_id
        LEFT JOIN monthly_plan_fees month_fee ON month_fee.provider_resource_id=ll.provider_resource_id
        LEFT JOIN latest_snapshot snap ON snap.provider_resource_id = ll.provider_resource_id
        LEFT JOIN resource_deducted denom ON denom.provider_resource_id = ll.provider_resource_id
       WHERE ll.enterprise_id = ${enterpriseId}
         AND ll.account_at >= ${start} AND ll.account_at < ${end}
    )
  `;
}
