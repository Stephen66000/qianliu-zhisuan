import type { Kysely } from "kysely";
import type { Database } from "@qianliu/database";
import { IDS } from "./seed-e2e-ids.js";

export async function seedE2eOperations(db: Kysely<Database>, now: Date): Promise<void> {
  await db.insertInto("supply_forecast").values({
    id: IDS.forecast, enterprise_id: IDS.enterprise, provider_resource_id: IDS.resource,
    rate_1h: "100", rate_24h: "2400", rate_7d: "16800",
    forecast_exhaust_at: new Date(now.getTime() + 12 * 3_600_000),
    next_recover_at: new Date(now.getTime() + 72 * 3_600_000), coverage_hours: "12",
    remaining_quota: "4800", confidence: "HIGH", data_points: 168,
    algorithm_version: "e2e-v1", snapshot_at: now,
  }).execute();
  await db.insertInto("dispatch_policy").values({
    id: IDS.policy, enterprise_id: IDS.enterprise, status: "PUBLISHED", match_unified_model: "qianliu-glm",
    match_resource_mode: "API", match_provider_resource_id: IDS.resource, action: "ALLOW",
    policy_version: "e2e-v1", priority: 10, description: "M5 E2E 固定调度策略", source: "M5_E2E_SEED",
  }).execute();
  await db.insertInto("dispatch_decision").values({
    id: IDS.decision, enterprise_id: IDS.enterprise, ai_request_id: IDS.request,
    dispatch_input: { selectedResourceId: IDS.resource, candidateResourceIds: [IDS.resource], priceMultiplier: 1 },
    matched_policy_id: IDS.policy, matched_policy_version: "e2e-v1", matched_policy_action: "ALLOW",
    final_action: "ALLOW", reason_code: "POLICY_MATCHED", reason_detail: "命中 M5 E2E 固定策略",
    counterfactual_cost: "140", actual_cost: "125", dispatch_saving: "15", saving_calculable: true,
  }).execute();
  await db.insertInto("alert_event").values({
    id: IDS.alert, enterprise_id: IDS.enterprise,
    alert_key: `CREDENTIAL_INVALID:CREDENTIAL_INVALID:${IDS.isolatedResource}`,
    domain: "CREDENTIAL_INVALID", signal: "credential_invalid", severity: "HIGH",
    title: "凭证失效：E2E 待恢复资源", detail: "E2E 固定告警：凭证已失效，需受控恢复",
    resource_id: IDS.isolatedResource, status: "OPEN",
  }).execute();
}
