/** POOL-029：员工使用规则的就绪校验与权限变更预览。 */
import type { Selectable, Transaction } from "kysely";
import { matchApplicableBillingRule, type BillingResourceMode } from "@qianliu/domain";
import type {
  Database,
  EmployeeModelRuleVersionTable,
  EmployeeModelTarget,
} from "../kysely.js";
import { classifyPermissionKeys } from "./employee-model-authorization-policy.js";
import { listEnabledBillingRulesAt } from "./billing-rule-applicability.js";

export type EmployeeModelRuleVersion = Selectable<EmployeeModelRuleVersionTable>;

export interface RuleReadinessIssue {
  code: "NO_EMPLOYEE" | "EMPLOYEE_UNAVAILABLE" | "KEY_UNAVAILABLE" | "NO_MODEL"
    | "MODEL_UNAVAILABLE" | "ROUTE_UNAVAILABLE" | "RESOURCE_UNAVAILABLE" | "BILLING_RULE_UNAVAILABLE";
  message: string;
  principal_id?: string;
  unified_model_id?: string;
  provider_resource_id?: string;
}

export interface RulePermissionChange {
  principal_id: string;
  principal_name: string;
  unified_model_id: string;
  model_name: string;
  provider_resource_id: string;
  resource_name: string;
}

export interface RuleValidationResult {
  ready: boolean;
  principal_ids: string[];
  model_targets: EmployeeModelTarget[];
  issues: RuleReadinessIssue[];
  principal_count: number;
  model_count: number;
  assignment_count: number;
  changes: {
    added: RulePermissionChange[];
    retained: RulePermissionChange[];
    removed: RulePermissionChange[];
  };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

async function calculatePermissionChanges(
  trx: Transaction<Database>,
  version: EmployeeModelRuleVersion,
  principalIds: string[],
  targets: EmployeeModelTarget[],
  principalNames: Map<string, string>,
  routeNames: Map<string, { model_name: string; resource_name: string }>,
): Promise<RuleValidationResult["changes"]> {
  const proposed = new Map<string, RulePermissionChange>();
  for (const principalId of principalIds) {
    for (const target of targets) {
      const names = routeNames.get(`${target.unified_model_id}:${target.provider_resource_id}`);
      if (!names) continue;
      const change = {
        principal_id: principalId,
        principal_name: principalNames.get(principalId) ?? principalId,
        unified_model_id: target.unified_model_id,
        model_name: names.model_name,
        provider_resource_id: target.provider_resource_id,
        resource_name: names.resource_name,
      };
      proposed.set(`${principalId}:${target.unified_model_id}:${target.provider_resource_id}`, change);
    }
  }
  const currentRows = await trx.selectFrom("employee_model_rule_assignment")
    .innerJoin("employee_model_rule_version", "employee_model_rule_version.id", "employee_model_rule_assignment.rule_version_id")
    .innerJoin("principal_grant", "principal_grant.id", "employee_model_rule_assignment.grant_id")
    .innerJoin("principal", "principal.id", "employee_model_rule_assignment.principal_id")
    .innerJoin("unified_model", "unified_model.id", "employee_model_rule_assignment.unified_model_id")
    .innerJoin("provider_resource", "provider_resource.id", "employee_model_rule_assignment.provider_resource_id")
    .select([
      "employee_model_rule_assignment.principal_id", "principal.name as principal_name",
      "employee_model_rule_assignment.unified_model_id", "unified_model.display_name as model_name",
      "employee_model_rule_assignment.provider_resource_id", "provider_resource.name as resource_name",
      "employee_model_rule_version.rule_id",
    ])
    .where("employee_model_rule_assignment.enterprise_id", "=", version.enterprise_id)
    .where("employee_model_rule_version.status", "=", "PUBLISHED")
    .where("employee_model_rule_assignment.status", "=", "ACTIVE")
    .where("principal_grant.status", "=", "ACTIVE")
    .where("principal_grant.valid_from", "<=", version.valid_from)
    .where((eb) => eb.or([
      eb("principal_grant.valid_until", "is", null),
      eb("principal_grant.valid_until", ">", version.valid_from),
    ]))
    .execute();
  const manualRows = await trx.selectFrom("principal_model_manual_authorization")
    .select(["principal_id", "unified_model_id"])
    .where("enterprise_id", "=", version.enterprise_id)
    .execute();
  const modelKey = (principalId: string, modelId: string) => `${principalId}:${modelId}`;
  const proposedModelKeys = [...proposed.values()].map((row) => modelKey(row.principal_id, row.unified_model_id));
  const beforeModelKeys = [
    ...manualRows.map((row) => modelKey(row.principal_id, row.unified_model_id)),
    ...currentRows.map((row) => modelKey(row.principal_id, row.unified_model_id)),
  ];
  const otherRuleModelKeys = currentRows
    .filter((row) => row.rule_id !== version.rule_id)
    .map((row) => modelKey(row.principal_id, row.unified_model_id));
  const previousRuleRows = currentRows.filter((row) => row.rule_id === version.rule_id);
  // 批量发布默认只增加：发布后集合必须包含发布前全部权限与本次目标。
  // 模型撤权由独立停用/接入配置承担，校验预览不得承诺“撤销 0”却在发布时覆盖。
  const finalModelKeys = [...beforeModelKeys, ...otherRuleModelKeys, ...proposedModelKeys];
  const classified = classifyPermissionKeys({
    proposed: proposedModelKeys,
    before: beforeModelKeys,
    after: finalModelKeys,
    previousRule: previousRuleRows.map((row) => modelKey(row.principal_id, row.unified_model_id)),
  });
  const proposedByModel = new Map([...proposed.values()].map((row) => [modelKey(row.principal_id, row.unified_model_id), row]));
  const previousByModel = new Map(previousRuleRows.map((row) => [modelKey(row.principal_id, row.unified_model_id), row as RulePermissionChange]));
  const byLabel = (left: RulePermissionChange, right: RulePermissionChange) =>
    `${left.principal_name}:${left.model_name}:${left.resource_name}`
      .localeCompare(`${right.principal_name}:${right.model_name}:${right.resource_name}`, "zh-CN");
  return {
    added: classified.added.map((key) => proposedByModel.get(key)!).filter(Boolean).sort(byLabel),
    retained: classified.retained.map((key) => proposedByModel.get(key)!).filter(Boolean).sort(byLabel),
    removed: classified.removed.map((key) => previousByModel.get(key)!).filter(Boolean).sort(byLabel),
  };
}

export async function validateEmployeeModelRule(
  trx: Transaction<Database>,
  version: EmployeeModelRuleVersion,
): Promise<RuleValidationResult> {
  const issues: RuleReadinessIssue[] = [];
  const principalRows = await trx.selectFrom("principal").leftJoin("principal_key", (join) => join
    .onRef("principal_key.principal_id", "=", "principal.id")
    .onRef("principal_key.enterprise_id", "=", "principal.enterprise_id")
    .on("principal_key.status", "=", "ACTIVE"))
    .select(["principal.id", "principal.name", "principal.status", "principal.archived_at", "principal_key.id as key_id"])
    .where("principal.enterprise_id", "=", version.enterprise_id).where("principal.type", "=", "EMPLOYEE")
    .$if(version.employee_scope === "SELECTED", (qb) => qb.where("principal.id", "in", version.principal_ids))
    .execute();
  if (principalRows.length === 0) issues.push({ code: "NO_EMPLOYEE", message: "没有可发布的员工" });
  for (const principal of principalRows) {
    if (principal.status !== "ACTIVE" || principal.archived_at !== null) {
      issues.push({ code: "EMPLOYEE_UNAVAILABLE", principal_id: principal.id, message: `员工 ${principal.name} 未启用` });
    } else if (!principal.key_id) {
      issues.push({ code: "KEY_UNAVAILABLE", principal_id: principal.id, message: `员工 ${principal.name} 尚无有效 Key` });
    }
  }
  if (version.employee_scope === "SELECTED") {
    const found = new Set(principalRows.map((row) => row.id));
    for (const id of version.principal_ids) if (!found.has(id)) {
      issues.push({ code: "EMPLOYEE_UNAVAILABLE", principal_id: id, message: "所选员工不存在或不属于当前企业" });
    }
  }

  const routeRows = await trx.selectFrom("model_route")
    .innerJoin("unified_model", "unified_model.id", "model_route.unified_model_id")
    .innerJoin("provider_resource", "provider_resource.id", "model_route.provider_resource_id")
    .innerJoin("provider", "provider.id", "provider_resource.provider_id")
    .select(["model_route.unified_model_id", "model_route.provider_resource_id", "model_route.upstream_model",
      "model_route.enabled", "unified_model.status as model_status", "unified_model.display_name",
      "provider_resource.name as resource_name", "provider_resource.status as resource_status",
      "provider_resource.mode as resource_mode", "provider.status as provider_status"])
    .where("model_route.enterprise_id", "=", version.enterprise_id)
    .where("model_route.archived_at", "is", null)
    .where("unified_model.archived_at", "is", null)
    .$if(version.model_scope === "SELECTED", (qb) => qb.where((eb) => eb.or(version.model_targets.map((target) => eb.and([
      eb("model_route.unified_model_id", "=", target.unified_model_id),
      eb("model_route.provider_resource_id", "=", target.provider_resource_id),
    ])))))
    .execute();
  const requestedTargets = version.model_scope === "ALL"
    ? routeRows.map((row) => ({ unified_model_id: row.unified_model_id, provider_resource_id: row.provider_resource_id }))
    : version.model_targets;
  if (requestedTargets.length === 0) issues.push({ code: "NO_MODEL", message: "没有可发布的模型" });
  const rowByTarget = new Map(routeRows.map((row) => [`${row.unified_model_id}:${row.provider_resource_id}`, row]));
  const billingRules = await listEnabledBillingRulesAt(trx, version.enterprise_id, version.valid_from);
  const readyTargets: EmployeeModelTarget[] = [];
  for (const target of requestedTargets) {
    const row = rowByTarget.get(`${target.unified_model_id}:${target.provider_resource_id}`);
    if (!row) {
      if (version.model_scope === "SELECTED") issues.push({ code: "ROUTE_UNAVAILABLE", ...target, message: "所选模型路由不存在或不属于当前企业" });
      continue;
    }
    const selected = version.model_scope === "SELECTED";
    if (selected && row.model_status !== "ACTIVE") issues.push({ code: "MODEL_UNAVAILABLE", ...target, message: `${row.display_name} 尚未启用` });
    if (selected && !row.enabled) issues.push({ code: "ROUTE_UNAVAILABLE", ...target, message: `${row.display_name} 的 Model Route 未启用` });
    if (selected && (!["ACTIVE", "DEGRADED"].includes(row.resource_status) || row.provider_status !== "ACTIVE")) {
      issues.push({ code: "RESOURCE_UNAVAILABLE", ...target, message: `${row.display_name} 的厂商资源不可服务` });
    }
    const billing = matchApplicableBillingRule(
      billingRules,
      target.provider_resource_id,
      row.upstream_model,
      row.resource_mode as BillingResourceMode,
      version.valid_from.getTime(),
    );
    if (selected && !billing) issues.push({ code: "BILLING_RULE_UNAVAILABLE", ...target, message: `${row.display_name} 缺少授权生效时点可用的计价或扣减规则` });
    if (row.model_status === "ACTIVE" && row.enabled && ["ACTIVE", "DEGRADED"].includes(row.resource_status)
      && row.provider_status === "ACTIVE" && billing) readyTargets.push(target);
  }
  if (version.model_scope === "ALL" && readyTargets.length === 0) {
    issues.push({ code: "NO_MODEL", message: "当前没有就绪模型；请先完成路由、计价规则和资源配置" });
  }
  const principalIds = principalRows.filter((row) => row.status === "ACTIVE" && row.archived_at === null && row.key_id)
    .map((row) => row.id);
  const principalNames = new Map(principalRows.map((row) => [row.id, row.name]));
  const routeNames = new Map(routeRows.map((row) => [
    `${row.unified_model_id}:${row.provider_resource_id}`,
    { model_name: row.display_name, resource_name: row.resource_name },
  ]));
  const changes = await calculatePermissionChanges(trx, version, principalIds, readyTargets, principalNames, routeNames);
  return {
    ready: issues.length === 0,
    principal_ids: unique(principalIds),
    model_targets: unique(readyTargets.map((target) => `${target.unified_model_id}:${target.provider_resource_id}`))
      .map((key) => {
        const [unified_model_id, provider_resource_id] = key.split(":");
        return { unified_model_id: unified_model_id!, provider_resource_id: provider_resource_id! };
      }),
    issues,
    principal_count: principalIds.length,
    model_count: readyTargets.length,
    assignment_count: principalIds.length * readyTargets.length,
    changes,
  };
}
