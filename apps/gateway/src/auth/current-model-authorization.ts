/**
 * 模型目录与调用热路径共用的最终授权事实源。
 *
 * 授权必须同时满足 Key、主体、模型、Route、Provider、资源、Grant 和计费规则；
 * Adapter 调用前再次在数据库快照内复核，避免列表展示与真实调用形成两套口径。
 */
import { sql, type Kysely, type Transaction } from "kysely";

import { listEnabledBillingRulesAt, type Database } from "@qianliu/database";
import {
  matchApplicableBillingRule,
  type BillingResourceMode,
  type BillingRule,
} from "@qianliu/domain";

interface CurrentAuthorizationScope {
  enterpriseId: string;
  principalId: string;
  keyId: string;
  now: Date;
}

/** `/v1/models` 与调用热路径共用的当前模型／route／provider／Grant 授权口径。 */
export async function listCurrentAuthorizedModels(
  db: Kysely<Database>,
  scope: CurrentAuthorizationScope,
): Promise<Array<{ id: string; alias: string; display_name: string }>> {
  const rows = await db.selectFrom("principal_key")
    .innerJoin("principal", (join) => join
      .onRef("principal.id", "=", "principal_key.principal_id")
      .onRef("principal.enterprise_id", "=", "principal_key.enterprise_id"))
    .innerJoin("unified_model", (join) => join
      .onRef("unified_model.enterprise_id", "=", "principal_key.enterprise_id"))
    .innerJoin("model_route", (join) => join
      .onRef("model_route.enterprise_id", "=", "unified_model.enterprise_id")
      .onRef("model_route.unified_model_id", "=", "unified_model.id"))
    .innerJoin("provider_resource", (join) => join
      .onRef("provider_resource.enterprise_id", "=", "model_route.enterprise_id")
      .onRef("provider_resource.id", "=", "model_route.provider_resource_id"))
    .innerJoin("provider", (join) => join
      .onRef("provider.enterprise_id", "=", "provider_resource.enterprise_id")
      .onRef("provider.id", "=", "provider_resource.provider_id"))
    .innerJoin("principal_grant", (join) => join
      .onRef("principal_grant.enterprise_id", "=", "unified_model.enterprise_id")
      .on("principal_grant.principal_id", "=", scope.principalId)
      .onRef("principal_grant.provider", "=", "provider.code")
      .on("principal_grant.status", "=", "ACTIVE"))
    .select([
      "unified_model.id as id",
      "unified_model.alias as alias",
      "unified_model.display_name as display_name",
      "model_route.provider_resource_id as resource_id",
      "model_route.upstream_model as upstream_model",
      "provider_resource.mode as resource_mode",
    ])
    .distinct()
    .where("principal_key.id", "=", scope.keyId)
    .where("principal_key.enterprise_id", "=", scope.enterpriseId)
    .where("principal_key.principal_id", "=", scope.principalId)
    .where("principal_key.status", "=", "ACTIVE")
    .where("principal.status", "=", "ACTIVE")
    .where((eb) => eb.or([
      eb("principal_key.expires_at", "is", null),
      eb("principal_key.expires_at", ">", scope.now),
    ]))
    .where(sql<boolean>`principal_key.allowed_model_ids ? unified_model.id::text`)
    .where("unified_model.enterprise_id", "=", scope.enterpriseId)
    .where("unified_model.status", "=", "ACTIVE")
    .where("model_route.enabled", "=", true)
    .where((eb) => eb.or([
      eb("provider_resource.status", "in", ["ACTIVE", "DEGRADED"]),
      eb.and([
        eb("provider_resource.status", "in", ["RATE_LIMITED", "UNAVAILABLE"]),
        eb("provider_resource.cooldown_until", "is not", null),
        eb("provider_resource.cooldown_until", "<=", scope.now),
      ]),
    ]))
    .where("provider.status", "=", "ACTIVE")
    .where((eb) => eb.exists(
      eb.selectFrom("billing_rule")
        .select("billing_rule.id")
        .whereRef("billing_rule.enterprise_id", "=", "unified_model.enterprise_id")
        .where("billing_rule.enabled", "=", true)
        .where("billing_rule.effective_from", "<=", scope.now)
        .where((rule) => rule.or([
          rule("billing_rule.effective_to", "is", null),
          rule("billing_rule.effective_to", ">", scope.now),
        ]))
        .where((rule) => rule.or([
          rule("billing_rule.provider_resource_id", "is", null),
          rule("billing_rule.provider_resource_id", "=", rule.ref("provider_resource.id")),
        ]))
        .where((rule) => rule.or([
          rule("billing_rule.upstream_model", "is", null),
          rule("billing_rule.upstream_model", "=", rule.ref("model_route.upstream_model")),
        ]))
        .where((rule) => rule.or([
          rule.and([
            rule("provider_resource.mode", "=", "API"),
            rule("billing_rule.rule_type", "=", "API_PRICE"),
            rule.or([
              rule("billing_rule.cache_hit_price", "is not", null),
              rule("billing_rule.cache_miss_price", "is not", null),
              rule("billing_rule.output_price", "is not", null),
            ]),
          ]),
          rule.and([
            rule("provider_resource.mode", "=", "CODING_PLAN"),
            rule("billing_rule.rule_type", "in", ["TIME_WINDOW", "MODEL_TIER"]),
            rule("billing_rule.multiplier", "is not", null),
          ]),
        ])),
    ))
    .where("principal_grant.valid_from", "<=", scope.now)
    .where((eb) => eb.or([
      eb("principal_grant.valid_until", "is", null),
      eb("principal_grant.valid_until", ">", scope.now),
    ]))
    .where((eb) => eb.or([
      eb.and([
        eb("principal_grant.pool_model_alias", "is", null),
        eb("principal_grant.model_alias", "=", eb.ref("unified_model.alias")),
      ]),
      eb.and([
        eb("principal_grant.pool_model_alias", "=", "*"),
        eb.not(eb.exists(
          eb.selectFrom("principal_provider_disabled_model")
            .select("principal_provider_disabled_model.unified_model_id")
            .whereRef("principal_provider_disabled_model.enterprise_id", "=", "unified_model.enterprise_id")
            .where("principal_provider_disabled_model.principal_id", "=", scope.principalId)
            .whereRef("principal_provider_disabled_model.provider", "=", "provider.code")
            .whereRef("principal_provider_disabled_model.unified_model_id", "=", "unified_model.id"),
        )),
      ]),
    ]))
    .orderBy("unified_model.alias", "asc")
    .execute();
  const rules = await listEnabledBillingRulesAt(db, scope.enterpriseId, scope.now);
  const authorized = new Map<string, { id: string; alias: string; display_name: string }>();
  for (const row of rows) {
    if (matchApplicableBillingRule(
      rules,
      row.resource_id,
      row.upstream_model,
      row.resource_mode as BillingResourceMode,
      scope.now.getTime(),
    )) authorized.set(row.alias, { id: row.id, alias: row.alias, display_name: row.display_name });
  }
  return [...authorized.values()].sort((left, right) => left.alias.localeCompare(right.alias));
}

export interface CurrentInvocationAuthorization {
  billingRule: BillingRule;
}

/** Adapter 前最终复核的单一数据库快照；同时冻结本次 Attempt 使用的精确计费规则。 */
async function resolveCurrentInvocationAuthorization(
  db: Kysely<Database> | Transaction<Database>,
  input: CurrentAuthorizationScope & {
    modelAlias: string;
    routeId?: string;
    providerCode: string;
    resourceId: string;
    upstreamModel: string;
    allowHalfOpenProbe?: boolean;
  },
): Promise<CurrentInvocationAuthorization | null> {
  const rows = await db.selectFrom("principal_key")
    .innerJoin("principal", "principal.id", "principal_key.principal_id")
    .innerJoin("unified_model", (join) => join
      .onRef("unified_model.enterprise_id", "=", "principal_key.enterprise_id")
      .on("unified_model.alias", "=", input.modelAlias)
      .on("unified_model.status", "=", "ACTIVE"))
    .innerJoin("model_route", (join) => join
      .onRef("model_route.enterprise_id", "=", "unified_model.enterprise_id")
      .onRef("model_route.unified_model_id", "=", "unified_model.id")
      .on("model_route.enabled", "=", true))
    .innerJoin("provider_resource", (join) => join
      .onRef("provider_resource.enterprise_id", "=", "model_route.enterprise_id")
      .onRef("provider_resource.id", "=", "model_route.provider_resource_id"))
    .innerJoin("provider", (join) => join
      .onRef("provider.enterprise_id", "=", "provider_resource.enterprise_id")
      .onRef("provider.id", "=", "provider_resource.provider_id")
      .on("provider.code", "=", input.providerCode)
      .on("provider.status", "=", "ACTIVE"))
    .innerJoin("principal_grant", (join) => join
      .onRef("principal_grant.enterprise_id", "=", "principal_key.enterprise_id")
      .onRef("principal_grant.principal_id", "=", "principal_key.principal_id")
      .onRef("principal_grant.provider", "=", "provider.code")
      .on("principal_grant.status", "=", "ACTIVE"))
    .innerJoin("billing_rule", "billing_rule.enterprise_id", "unified_model.enterprise_id")
    .select([
      "principal_key.allowed_model_ids as allowed_model_ids",
      "principal_key.expires_at as expires_at",
      "unified_model.id as model_id",
      "provider_resource.mode as resource_mode",
      "billing_rule.id as billing_rule_id",
      "billing_rule.rule_type as billing_rule_type",
      "billing_rule.rule_version as billing_rule_version",
      "billing_rule.provider_resource_id as billing_provider_resource_id",
      "billing_rule.upstream_model as billing_upstream_model",
      "billing_rule.effective_from as billing_effective_from",
      "billing_rule.effective_to as billing_effective_to",
      "billing_rule.timezone as billing_timezone",
      "billing_rule.days_of_week as billing_days_of_week",
      "billing_rule.start_time as billing_start_time",
      "billing_rule.end_time as billing_end_time",
      "billing_rule.time_windows as billing_time_windows",
      "billing_rule.multiplier as billing_multiplier",
      "billing_rule.cache_hit_price as billing_cache_hit_price",
      "billing_rule.cache_miss_price as billing_cache_miss_price",
      "billing_rule.output_price as billing_output_price",
      "billing_rule.currency as billing_currency",
      "billing_rule.priority as billing_priority",
    ])
    .distinct()
    .where("principal_key.id", "=", input.keyId)
    .where("principal_key.enterprise_id", "=", input.enterpriseId)
    .where("principal_key.principal_id", "=", input.principalId)
    .where("principal_key.status", "=", "ACTIVE")
    .where("principal.status", "=", "ACTIVE")
    .where((eb) => input.routeId === undefined
      ? eb("model_route.provider_resource_id", "=", input.resourceId)
      : eb("model_route.id", "=", input.routeId))
    .where("model_route.provider_resource_id", "=", input.resourceId)
    .where("model_route.upstream_model", "=", input.upstreamModel)
    .where((eb) => input.allowHalfOpenProbe
      ? eb.or([
          eb("provider_resource.status", "in", ["ACTIVE", "DEGRADED"]),
          eb.and([
            eb("provider_resource.status", "in", ["RATE_LIMITED", "UNAVAILABLE"]),
            eb("provider_resource.cooldown_until", "is not", null),
            eb("provider_resource.cooldown_until", "<=", input.now),
          ]),
        ])
      : eb("provider_resource.status", "in", ["ACTIVE", "DEGRADED"]))
    .where("billing_rule.enabled", "=", true)
    .where("billing_rule.effective_from", "<=", input.now)
    .where((rule) => rule.or([
      rule("billing_rule.effective_to", "is", null),
      rule("billing_rule.effective_to", ">", input.now),
    ]))
    .where((rule) => rule.or([
      rule("billing_rule.provider_resource_id", "is", null),
      rule("billing_rule.provider_resource_id", "=", rule.ref("provider_resource.id")),
    ]))
    .where((rule) => rule.or([
      rule("billing_rule.upstream_model", "is", null),
      rule("billing_rule.upstream_model", "=", rule.ref("model_route.upstream_model")),
    ]))
    .where((rule) => rule.or([
      rule.and([
        rule("provider_resource.mode", "=", "API"),
        rule("billing_rule.rule_type", "=", "API_PRICE"),
        rule.or([
          rule("billing_rule.cache_hit_price", "is not", null),
          rule("billing_rule.cache_miss_price", "is not", null),
          rule("billing_rule.output_price", "is not", null),
        ]),
      ]),
      rule.and([
        rule("provider_resource.mode", "=", "CODING_PLAN"),
        rule("billing_rule.rule_type", "in", ["TIME_WINDOW", "MODEL_TIER"]),
        rule("billing_rule.multiplier", "is not", null),
      ]),
    ]))
    .where("principal_grant.valid_from", "<=", input.now)
    .where((eb) => eb.or([
      eb("principal_grant.valid_until", "is", null),
      eb("principal_grant.valid_until", ">", input.now),
    ]))
    .where((eb) => eb.or([
      eb.and([
        eb("principal_grant.pool_model_alias", "is", null),
        eb("principal_grant.model_alias", "=", eb.ref("unified_model.alias")),
      ]),
      eb.and([
        eb("principal_grant.pool_model_alias", "=", "*"),
        eb.not(eb.exists(
          eb.selectFrom("principal_provider_disabled_model")
            .select("principal_provider_disabled_model.unified_model_id")
            .whereRef("principal_provider_disabled_model.enterprise_id", "=", "unified_model.enterprise_id")
            .where("principal_provider_disabled_model.principal_id", "=", input.principalId)
            .whereRef("principal_provider_disabled_model.provider", "=", "provider.code")
            .whereRef("principal_provider_disabled_model.unified_model_id", "=", "unified_model.id"),
        )),
      ]),
    ]))
    .execute();
  const authorization = rows[0];
  if (!authorization
    || (authorization.expires_at !== null
      && authorization.expires_at.getTime() <= input.now.getTime())) return null;
  if (!(authorization.allowed_model_ids ?? []).includes(authorization.model_id)) return null;
  const rules: BillingRule[] = rows.map((row) => ({
    id: row.billing_rule_id,
    ruleType: row.billing_rule_type as BillingRule["ruleType"],
    ruleVersion: row.billing_rule_version,
    providerResourceId: row.billing_provider_resource_id,
    upstreamModel: row.billing_upstream_model,
    effectiveFrom: row.billing_effective_from.getTime(),
    effectiveTo: row.billing_effective_to?.getTime() ?? null,
    timezone: row.billing_timezone,
    daysOfWeek: row.billing_days_of_week,
    startTime: row.billing_start_time,
    endTime: row.billing_end_time,
    timeWindows: row.billing_time_windows?.map((window) => ({
      timezone: window.timezone,
      daysOfWeek: window.days_of_week,
      startTime: window.start_time,
      endTime: window.end_time,
    })) ?? null,
    multiplier: row.billing_multiplier,
    cacheHitPrice: row.billing_cache_hit_price,
    cacheMissPrice: row.billing_cache_miss_price,
    outputPrice: row.billing_output_price,
    currency: row.billing_currency,
    priority: row.billing_priority,
  }));
  const billingRule = matchApplicableBillingRule(
    rules,
    input.resourceId,
    input.upstreamModel,
    authorization.resource_mode as BillingResourceMode,
    input.now.getTime(),
  );
  return billingRule ? { billingRule } : null;
}

/** Key／Grant／route 与计费规则在同一 REPEATABLE READ 快照中完成最终复核。 */
export async function getCurrentInvocationAuthorization(
  db: Kysely<Database>,
  input: Parameters<typeof resolveCurrentInvocationAuthorization>[1],
): Promise<CurrentInvocationAuthorization | null> {
  return db.transaction().setIsolationLevel("repeatable read").execute((trx) =>
    resolveCurrentInvocationAuthorization(trx, input));
}

/** 兼容只需布尔结果的调用者与合同测试。 */
export async function hasCurrentInvocationAuthorization(
  db: Kysely<Database>,
  input: Parameters<typeof resolveCurrentInvocationAuthorization>[1],
): Promise<boolean> {
  return (await getCurrentInvocationAuthorization(db, input)) !== null;
}
