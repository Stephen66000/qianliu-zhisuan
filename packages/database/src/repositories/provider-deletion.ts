/**
 * 厂商与厂商资源的安全删除（2026-09-17 自 provider-repository 拆分）。
 *
 * 原则：
 * - 有真实调用或资金/账本事实的资源拒绝物理删除（法定审计与真账一致性）；
 * - 级联删除覆盖全部持有外键的派生配置表，避免 FK 23503 冒泡为 500；
 * - unified_model 仅在确无任何引用（路由、请求、手工授权、禁用清单、保障规则/事件）时才物理删除，否则保留为休眠行。
 */
import type { Kysely } from "kysely";
import type { Database } from "../kysely.js";
import type {
  DeleteProviderResult,
  DeleteResourceSafelyResult,
} from "./provider-types.js";

export async function deleteProviderSafely(
  db: Kysely<Database>,
  enterpriseId: string,
  providerId: string,
): Promise<DeleteProviderResult> {
  return db.transaction().execute(async (trx) => {
    const provider = await trx
      .selectFrom("provider")
      .select(["id", "code", "name"])
      .where("enterprise_id", "=", enterpriseId)
      .where("id", "=", providerId)
      .forUpdate()
      .executeTakeFirst();
    if (!provider) {
      return { found: false, deleted: false };
    }

    const resourceCountRes = await trx
      .selectFrom("provider_resource")
      .select((eb) => eb.fn.count<string>("id").as("count"))
      .where("enterprise_id", "=", enterpriseId)
      .where("provider_id", "=", providerId)
      .executeTakeFirst();
    const resourceCount = Number(resourceCountRes?.count ?? 0);
    if (resourceCount > 0) {
      return {
        found: true,
        deleted: false,
        reason: `该厂商名下存在 ${resourceCount} 个厂商资源，请先删除或迁移相关资源后再删除厂商`,
        provider,
      };
    }

    const ruleCountRes = await trx
      .selectFrom("availability_rule_version")
      .select((eb) => eb.fn.count<string>("id").as("count"))
      .where("provider_id", "=", providerId)
      .executeTakeFirst();
    const ruleCount = Number(ruleCountRes?.count ?? 0);
    if (ruleCount > 0) {
      return {
        found: true,
        deleted: false,
        reason: "该厂商已被运行保障规则引用，无法直接删除",
        provider,
      };
    }

    const eventCountRes = await trx
      .selectFrom("availability_event")
      .select((eb) => eb.fn.count<string>("id").as("count"))
      .where("provider_id", "=", providerId)
      .executeTakeFirst();
    const eventCount = Number(eventCountRes?.count ?? 0);
    if (eventCount > 0) {
      return {
        found: true,
        deleted: false,
        reason: "该厂商存在运行保障事件历史，无法直接删除",
        provider,
      };
    }

    await trx
      .deleteFrom("provider")
      .where("enterprise_id", "=", enterpriseId)
      .where("id", "=", providerId)
      .execute();

    return {
      found: true,
      deleted: true,
      provider,
    };
  });
}

export async function deleteProviderResourceSafely(
  db: Kysely<Database>,
  enterpriseId: string,
  resourceId: string,
): Promise<DeleteResourceSafelyResult> {
  return db.transaction().execute(async (trx) => {
    const resource = await trx
      .selectFrom("provider_resource")
      .select(["id", "name", "mode", "provider_id"])
      .where("enterprise_id", "=", enterpriseId)
      .where("id", "=", resourceId)
      .forUpdate()
      .executeTakeFirst();
    if (!resource) return { found: false, deleted: false };

    if (await hasResourceFacts(trx, enterpriseId, resourceId)) {
      return {
        found: true,
        deleted: false,
        reason: "该资源已有实际调用或财务账本事实，为保证法定审计与资金真账一致性不可物理删除，请通过模型下架或停用进行管理",
        resource: { id: resource.id, name: resource.name, mode: resource.mode },
      };
    }

    const routes = await trx
      .selectFrom("model_route")
      .select(["id", "unified_model_id"])
      .where("enterprise_id", "=", enterpriseId)
      .where("provider_resource_id", "=", resourceId)
      .execute();
    const routeIds = routes.map((r) => r.id);
    const candidateUnifiedModelIds = [...new Set(routes.map((r) => r.unified_model_id))];

    await trx
      .deleteFrom("employee_model_rule_assignment")
      .where("enterprise_id", "=", enterpriseId)
      .where("provider_resource_id", "=", resourceId)
      .execute();

    await trx
      .deleteFrom("route_candidate")
      .where("enterprise_id", "=", enterpriseId)
      .where("provider_resource_id", "=", resourceId)
      .execute();

    await trx
      .deleteFrom("billing_rule")
      .where("enterprise_id", "=", enterpriseId)
      .where("provider_resource_id", "=", resourceId)
      .execute();

    if (routeIds.length > 0) {
      await trx
        .deleteFrom("model_route")
        .where("id", "in", routeIds)
        .execute();
    }

    // 运行保障事件与规则版本按 provider_resource_id 清理（两表均无 enterprise_id 列，
    // resourceId 已在事务内 forUpdate 校验归属本企业）。
    await trx
      .deleteFrom("availability_event")
      .where("provider_resource_id", "=", resourceId)
      .execute();

    const deletedRuleIds = await trx
      .deleteFrom("availability_rule_version")
      .where("provider_resource_id", "=", resourceId)
      .returning("availability_rule_id")
      .execute();
    // 清理不再拥有任何版本的 availability_rule 父行，避免孤儿规则头。
    const orphanRuleIds = [...new Set(deletedRuleIds.map((r) => r.availability_rule_id))];
    for (const ruleId of orphanRuleIds) {
      const remainingVersions = await trx
        .selectFrom("availability_rule_version")
        .select((eb) => eb.fn.count<string>("id").as("count"))
        .where("availability_rule_id", "=", ruleId)
        .executeTakeFirst();
      if (Number(remainingVersions?.count ?? 0) === 0) {
        await trx
          .deleteFrom("availability_rule")
          .where("id", "=", ruleId)
          .execute();
      }
    }

    await trx
      .deleteFrom("concurrency_lease")
      .where("enterprise_id", "=", enterpriseId)
      .where("provider_resource_id", "=", resourceId)
      .execute();
    await trx
      .deleteFrom("supply_forecast")
      .where("enterprise_id", "=", enterpriseId)
      .where("provider_resource_id", "=", resourceId)
      .execute();
    await trx
      .deleteFrom("provider_quota_window")
      .where("enterprise_id", "=", enterpriseId)
      .where("provider_resource_id", "=", resourceId)
      .execute();

    await trx
      .deleteFrom("provider_model_discovery_item")
      .where("enterprise_id", "=", enterpriseId)
      .where("provider_resource_id", "=", resourceId)
      .execute();
    await trx
      .deleteFrom("provider_model_discovery")
      .where("enterprise_id", "=", enterpriseId)
      .where("provider_resource_id", "=", resourceId)
      .execute();
    await trx
      .deleteFrom("provider_model_onboarding")
      .where("enterprise_id", "=", enterpriseId)
      .where("provider_resource_id", "=", resourceId)
      .execute();
    await trx
      .deleteFrom("provider_model_validation")
      .where("enterprise_id", "=", enterpriseId)
      .where("provider_resource_id", "=", resourceId)
      .execute();

    await trx
      .deleteFrom("provider_resource_operating_sync_attempt")
      .where("enterprise_id", "=", enterpriseId)
      .where("provider_resource_id", "=", resourceId)
      .execute();
    await trx
      .deleteFrom("provider_resource_operating_snapshot")
      .where("enterprise_id", "=", enterpriseId)
      .where("provider_resource_id", "=", resourceId)
      .execute();
    await trx
      .deleteFrom("provider_resource_monthly_budget")
      .where("enterprise_id", "=", enterpriseId)
      .where("provider_resource_id", "=", resourceId)
      .execute();
    await trx
      .deleteFrom("resource_status_event")
      .where("enterprise_id", "=", enterpriseId)
      .where("provider_resource_id", "=", resourceId)
      .execute();

    // unified_model 仅在全部引用清零后物理删除；否则保留为休眠行，
    // 杜绝 FK 23503 冒泡为 500。
    await cleanupOrphanUnifiedModels(trx, enterpriseId, candidateUnifiedModelIds);

    await trx
      .deleteFrom("provider_resource")
      .where("enterprise_id", "=", enterpriseId)
      .where("id", "=", resourceId)
      .execute();

    return {
      found: true,
      deleted: true,
      resource: { id: resource.id, name: resource.name, mode: resource.mode },
    };
  });
}

type Trx = Kysely<Database>;

/** 资源是否已有真实调用或资金/账本事实（有则禁止物理删除）。 */
async function hasResourceFacts(
  trx: Trx,
  enterpriseId: string,
  resourceId: string,
): Promise<boolean> {
  const tables = [
    "upstream_attempt",
    "usage_event",
    "ledger_line",
    "provider_finance_event",
    "provider_subscription_period",
    "operating_bill_resource_confirmation",
  ] as const;
  const counts = await Promise.all(
    tables.map((table) =>
      trx
        .selectFrom(table)
        .select((eb) => eb.fn.count<string>("id").as("count"))
        .where("enterprise_id", "=", enterpriseId)
        .where("provider_resource_id", "=", resourceId)
        .executeTakeFirst(),
    ),
  );
  return counts.some((row) => Number(row?.count ?? 0) > 0);
}

/**
 * 删除不再被任何路由使用且无历史/配置引用的 unified_model；
 * 存在任一引用（请求历史、手工授权、禁用清单、验证记录、保障规则/事件）时保留为休眠行。
 */
async function cleanupOrphanUnifiedModels(
  trx: Trx,
  enterpriseId: string,
  candidateUnifiedModelIds: string[],
): Promise<void> {
  for (const uModelId of candidateUnifiedModelIds) {
    const remainingRoutesRes = await trx
      .selectFrom("model_route")
      .select((eb) => eb.fn.count<string>("id").as("count"))
      .where("enterprise_id", "=", enterpriseId)
      .where("unified_model_id", "=", uModelId)
      .executeTakeFirst();
    if (Number(remainingRoutesRes?.count ?? 0) > 0) continue;

    const uModelReqRes = await trx
      .selectFrom("ai_request")
      .select((eb) => eb.fn.count<string>("id").as("count"))
      .where("enterprise_id", "=", enterpriseId)
      .where("unified_model_id", "=", uModelId)
      .executeTakeFirst();
    if (Number(uModelReqRes?.count ?? 0) > 0) continue;

    const referenceCounts = await Promise.all([
      trx
        .selectFrom("principal_model_manual_authorization")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("enterprise_id", "=", enterpriseId)
        .where("unified_model_id", "=", uModelId)
        .executeTakeFirst(),
      trx
        .selectFrom("principal_provider_disabled_model")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("enterprise_id", "=", enterpriseId)
        .where("unified_model_id", "=", uModelId)
        .executeTakeFirst(),
      trx
        .selectFrom("provider_model_validation")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("enterprise_id", "=", enterpriseId)
        .where("unified_model_id", "=", uModelId)
        .executeTakeFirst(),
      trx
        .selectFrom("availability_rule_version")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("unified_model_id", "=", uModelId)
        .executeTakeFirst(),
      trx
        .selectFrom("availability_event")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("unified_model_id", "=", uModelId)
        .executeTakeFirst(),
    ]);
    if (referenceCounts.some((r) => Number(r?.count ?? 0) > 0)) continue;

    await trx
      .deleteFrom("unified_model")
      .where("enterprise_id", "=", enterpriseId)
      .where("id", "=", uModelId)
      .execute();
  }
}
