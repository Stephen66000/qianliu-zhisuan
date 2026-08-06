/** POOL-033：单主体接入配置编排仓储 —— 单人页唯一写入通道。
 *
 * 依据：设计草案 v2（`V3/Handoff/接入配置统一-后端数据合同设计草案v2-20260805.md`）。
 * - GET：装配"按厂商分块 + 池 + 型号开关 + 待接管标记"的读模型；
 * - PUT：单事务完成"校验 → 池 upsert → 型号开关版本化 → 手工接管 → 白名单重算 →
 *   审计 → 幂等存档"，任一步失败整体回滚。
 *
 * 权限模型（决策点④）：厂商下型号默认全开（新接入型号自动并入），掐型号走显式禁用
 * 清单 principal_provider_disabled_model。准入 = 厂商池 ACTIVE AND 型号不在禁用清单。
 *
 * 额度模型（决策点：池挂主体×厂商）：每主体每厂商至多一个 ACTIVE 池 Grant
 * （0039 唯一索引保证）。规则不再承载额度（quota_value 可空）。
 */
import { createHash, randomUUID } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";
import type { Database } from "../kysely.js";
import { EmployeeModelRuleRepository } from "./employee-model-rule-repository.js";
import { mergeDeclaredModelIds } from "./employee-model-authorization-policy.js";

export class PrincipalAccessConfigError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "INVALID_STATE" | "CONFLICT" | "NOT_READY" | "IDEMPOTENCY_CONFLICT" | "INVALID_REQUEST",
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "PrincipalAccessConfigError";
  }
}

function jsonValue<T>(value: T): T {
  return JSON.stringify(value) as unknown as T;
}

/** 规范化请求体（键序无关）用于幂等 hash。 */
function stableHash(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalize);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, val]) => [k, normalize(val)]),
      );
    }
    return v;
  };
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}

export interface PoolSpec {
  provider_code: string;
  quota_value: bigint;
  allow_overage: boolean;
  valid_until: Date | null;
  /** 该厂商下要保留开通的型号（其余进入显式禁用清单）。空数组 = 不开通该厂商。 */
  enabled_model_ids: string[];
}

export interface AccessConfigPutInput {
  enterpriseId: string;
  principalId: string;
  adminUserId: string;
  expectedVersion: number;
  idempotencyKey: string;
  pools: PoolSpec[];
}

interface ModelRow {
  unified_model_id: string;
  display_name: string;
  alias: string;
  provider_code: string;
  provider_name: string;
  provider_resource_id: string;
  resource_name: string;
  mode: "API" | "CODING_PLAN";
  resource_status: string;
  model_status: string;
  route_enabled: boolean;
  ready: boolean;
  unavailable_reasons: string[];
}

interface PoolRow {
  id: string;
  provider: string;
  quota_value: bigint;
  allow_overage: boolean;
  valid_until: Date | null;
  used_value: bigint;
  source: string;
}

export class PrincipalAccessConfigRepository {
  private readonly ruleRepo: EmployeeModelRuleRepository;

  constructor(private readonly db: Kysely<Database>) {
    this.ruleRepo = new EmployeeModelRuleRepository(db);
  }

  /** GET 读模型：厂商分块 + 池 + 型号开关 + 待接管标记 + config_version。 */
  async read(enterpriseId: string, principalId: string) {
    const principal = await this.db.selectFrom("principal")
      .select(["id", "name", "status", "department_label", "archived_at"])
      .where("enterprise_id", "=", enterpriseId).where("id", "=", principalId)
      .executeTakeFirst();
    if (!principal) throw new PrincipalAccessConfigError("NOT_FOUND", "主体不存在");

    const key = await this.db.selectFrom("principal_key")
      .select(["id", "key_prefix", "status", "created_at", "allowed_model_ids"])
      .where("enterprise_id", "=", enterpriseId).where("principal_id", "=", principalId)
      .where("status", "=", "ACTIVE").executeTakeFirst();

    // 厂商目录（复用 029 catalog 的 models 部分语义，但按厂商分块）。
    const catalog = await this.ruleRepo.catalog(enterpriseId);
    const models: ModelRow[] = catalog.models as ModelRow[];

    // 该主体的全部 ACTIVE 池。
    const poolRows = await this.db.selectFrom("principal_grant")
      .leftJoin("quota_counter", "quota_counter.grant_id", "principal_grant.id")
      .select([
        "principal_grant.id", "principal_grant.provider", "principal_grant.quota_value",
        "principal_grant.allow_overage", "principal_grant.valid_until",
        "principal_grant.authorization_rule_version_id",
        sql<bigint>`COALESCE(quota_counter.used_value, 0)`.as("used_value"),
      ])
      .where("principal_grant.enterprise_id", "=", enterpriseId)
      .where("principal_grant.principal_id", "=", principalId)
      .where("principal_grant.pool_model_alias", "=", "*")
      .where("principal_grant.status", "=", "ACTIVE")
      .execute();

    // 池来源判定：有 owner_principal_id 的单人规则版本 → MANAGED_SINGLE；否则批量。
    const singleRuleVersionIds = await this.singleRuleVersionIds(enterpriseId, principalId);
    const singleVersionSet = new Set(singleRuleVersionIds);
    const pools: PoolRow[] = poolRows.map((row) => ({
      id: row.id, provider: row.provider, quota_value: row.quota_value,
      allow_overage: row.allow_overage, valid_until: row.valid_until,
      used_value: row.used_value,
      source: row.authorization_rule_version_id === null
        ? "MANUAL_PENDING"
        : singleVersionSet.has(row.authorization_rule_version_id) ? "MANAGED_SINGLE" : "MANAGED_BATCH",
    }));

    // 显式禁用清单。
    const disabledRows = await this.db.selectFrom("principal_provider_disabled_model")
      .select(["provider", "unified_model_id"])
      .where("enterprise_id", "=", enterpriseId).where("principal_id", "=", principalId)
      .execute();
    const disabledSet = new Set(disabledRows.map((r) => `${r.provider}:${r.unified_model_id}`));

    // 待接管手工基线。
    const manualPending = await this.db.selectFrom("principal_model_manual_authorization")
      .select("unified_model_id")
      .where("enterprise_id", "=", enterpriseId).where("principal_id", "=", principalId)
      .execute();

    // config_version。
    const state = await this.db.selectFrom("principal_access_config_state")
      .select("config_version")
      .where("enterprise_id", "=", enterpriseId).where("principal_id", "=", principalId)
      .executeTakeFirst();

    // 装配厂商分块。
    const byProvider = new Map<string, { name: string; models: ModelRow[] }>();
    for (const m of models) {
      const bucket = byProvider.get(m.provider_code) ?? { name: m.provider_name, models: [] };
      bucket.models.push(m);
      byProvider.set(m.provider_code, bucket);
    }
    const providers = [...byProvider.entries()].map(([code, bucket]) => {
      const pool = pools.find((p) => p.provider === code) ?? null;
      return {
        provider_code: code,
        provider_name: bucket.name,
        pool: pool ? {
          grant_id: pool.id,
          quota_value: pool.quota_value.toString(),
          quota_used: pool.used_value.toString(),
          allow_overage: pool.allow_overage,
          valid_until: pool.valid_until,
          source: pool.source,
          over_limit: pool.used_value > pool.quota_value,
        } : null,
        models: bucket.models.map((m) => ({
          unified_model_id: m.unified_model_id,
          display_name: m.display_name,
          alias: m.alias,
          provider_resource_id: m.provider_resource_id,
          resource_name: m.resource_name,
          resource_mode: m.mode,
          ready: m.ready,
          unavailable_reasons: m.unavailable_reasons,
          enabled: pool !== null && !disabledSet.has(`${code}:${m.unified_model_id}`),
        })),
      };
    });

    const totalQuota = pools.reduce((acc, p) => acc + p.quota_value, 0n);
    const enabledModelCount = providers.reduce(
      (acc, p) => acc + p.models.filter((m) => m.enabled).length, 0,
    );

    return {
      principal: {
        id: principal.id, name: principal.name, status: principal.status,
        department_label: principal.department_label,
      },
      key: key ? {
        key_prefix: key.key_prefix, status: key.status, created_at: key.created_at,
        authorization_status: enabledModelCount > 0 ? "AUTHORIZED" : "PENDING",
      } : null,
      providers,
      summary: {
        total_quota: totalQuota.toString(),
        provider_count: pools.length,
        model_count: enabledModelCount,
      },
      manual_pending_takeover: manualPending.map((r) => r.unified_model_id),
      config_version: state?.config_version ?? 1,
    };
  }

  private async singleRuleVersionIds(enterpriseId: string, principalId: string): Promise<string[]> {
    const rows = await this.db.selectFrom("employee_model_rule_version")
      .select("id")
      .where("enterprise_id", "=", enterpriseId)
      .where("owner_principal_id", "=", principalId)
      .execute();
    return rows.map((r) => r.id);
  }

  /** PUT：单事务保存。详见模块头注释。 */
  async put(input: AccessConfigPutInput) {
    return this.db.transaction().execute(async (trx) => {
      // 1. 预校验：主体存在、ACTIVE、未归档、有 ACTIVE Key。
      const principal = await trx.selectFrom("principal")
        .select(["id", "name", "status", "archived_at"])
        .where("enterprise_id", "=", input.enterpriseId).where("id", "=", input.principalId)
        .executeTakeFirst();
      if (!principal) throw new PrincipalAccessConfigError("NOT_FOUND", "主体不存在");
      if (principal.status !== "ACTIVE" || principal.archived_at !== null) {
        throw new PrincipalAccessConfigError("INVALID_STATE", "主体已停用或归档，不能配置接入");
      }
      const activeKey = await trx.selectFrom("principal_key").select("id")
        .where("enterprise_id", "=", input.enterpriseId).where("principal_id", "=", input.principalId)
        .where("status", "=", "ACTIVE").forUpdate().executeTakeFirst();
      if (!activeKey) throw new PrincipalAccessConfigError("INVALID_STATE", "主体尚无有效 Key");

      // 2. 幂等短路。
      const requestHash = stableHash({ pools: input.pools.map((p) => ({
        provider_code: p.provider_code, quota_value: p.quota_value.toString(),
        allow_overage: p.allow_overage, valid_until: p.valid_until, enabled_model_ids: [...p.enabled_model_ids].sort(),
      })) });
      const prior = await trx.selectFrom("principal_access_idempotency")
        .selectAll()
        .where("enterprise_id", "=", input.enterpriseId).where("principal_id", "=", input.principalId)
        .where("idempotency_key", "=", input.idempotencyKey).executeTakeFirst();
      if (prior) {
        if (prior.request_hash !== requestHash) {
          throw new PrincipalAccessConfigError("IDEMPOTENCY_CONFLICT", "该幂等键已用于不同请求");
        }
        return { ...prior.response_snapshot as Record<string, unknown>, replayed: true };
      }

      // 3. config_version 乐观锁（行锁内自增）。
      const locked = await this.lockAndCheckConfigVersion(trx, input);

      // 4. 就绪校验：pools 中每个 enabled_model_id 属该厂商且就绪。
      const catalog = await this.ruleRepo.catalog(input.enterpriseId);
      const models = catalog.models as ModelRow[];
      const modelById = new Map(models.map((m) => [m.unified_model_id, m]));
      const issues: Array<{ code: string; message: string; unified_model_id?: string; provider_code?: string }> = [];
      for (const pool of input.pools) {
        const providerModels = models.filter((m) => m.provider_code === pool.provider_code);
        if (providerModels.length === 0) {
          issues.push({ code: "PROVIDER_UNAVAILABLE", provider_code: pool.provider_code, message: `厂商 ${pool.provider_code} 在本企业无可用型号` });
        }
        for (const modelId of pool.enabled_model_ids) {
          const m = modelById.get(modelId);
          if (!m || m.provider_code !== pool.provider_code) {
            issues.push({ code: "MODEL_UNAVAILABLE", unified_model_id: modelId, provider_code: pool.provider_code, message: `型号不属于厂商 ${pool.provider_code} 或不属于本企业` });
          } else if (!m.ready) {
            issues.push({ code: "MODEL_UNAVAILABLE", unified_model_id: modelId, provider_code: pool.provider_code, message: `型号 ${m.display_name} 未就绪：${m.unavailable_reasons.join("；")}` });
          }
        }
        if (pool.enabled_model_ids.length === 0 && pool.quota_value > 0n) {
          issues.push({ code: "INVALID_REQUEST", provider_code: pool.provider_code, message: `厂商 ${pool.provider_code} 给了额度但未勾选任何型号` });
        }
      }
      if (issues.length > 0) {
        throw new PrincipalAccessConfigError("NOT_READY", "接入配置就绪校验未通过", { issues });
      }

      // 5. 池 upsert。
      const currentPools = await trx.selectFrom("principal_grant")
        .select(["id", "provider", "quota_value", "authorization_rule_version_id"])
        .where("enterprise_id", "=", input.enterpriseId).where("principal_id", "=", input.principalId)
        .where("pool_model_alias", "=", "*").where("status", "=", "ACTIVE")
        .forUpdate().execute();
      const currentByProvider = new Map(currentPools.map((p) => [p.provider, p]));
      const requestedProviders = new Set(input.pools.filter((p) => p.enabled_model_ids.length > 0).map((p) => p.provider_code));
      const changes: { pools_added: string[]; pools_updated: string[]; pools_closed: string[] } = {
        pools_added: [], pools_updated: [], pools_closed: [],
      };

      // 5a. 关闭请求的 providers 之外的现有池。
      for (const [provider, pool] of currentByProvider) {
        if (!requestedProviders.has(provider)) {
          await trx.updateTable("principal_grant")
            .set({ status: "DISABLED", version: sql`version + 1`, updated_at: new Date() })
            .where("id", "=", pool.id).execute();
          changes.pools_closed.push(provider);
        }
      }

      // 5b. upsert 请求的池。
      const singleRuleVersionId = await this.ensureSingleRule(trx, input);
      const poolGrantByProvider = new Map<string, string>();
      for (const pool of input.pools) {
        if (pool.enabled_model_ids.length === 0) continue;
        const existing = currentByProvider.get(pool.provider_code);
        if (existing) {
          await trx.updateTable("principal_grant").set({
            quota_value: pool.quota_value, allow_overage: pool.allow_overage,
            valid_until: pool.valid_until,
            authorization_rule_version_id: singleRuleVersionId,
            version: sql`version + 1`, updated_at: new Date(),
          }).where("id", "=", existing.id).execute();
          poolGrantByProvider.set(pool.provider_code, existing.id);
          changes.pools_updated.push(pool.provider_code);
        } else {
          const grant = await trx.insertInto("principal_grant").values({
            enterprise_id: input.enterpriseId, principal_id: input.principalId,
            provider: pool.provider_code, model_alias: "*", pool_model_alias: "*",
            quota_unit: "TOKEN", quota_value: pool.quota_value, allow_overage: pool.allow_overage,
            valid_until: pool.valid_until, status: "ACTIVE",
            authorization_rule_version_id: singleRuleVersionId,
          }).returning("id").executeTakeFirstOrThrow();
          await trx.insertInto("quota_counter").values({ grant_id: grant.id }).execute();
          poolGrantByProvider.set(pool.provider_code, grant.id);
          changes.pools_added.push(pool.provider_code);
        }
      }

      // 6. 型号开关版本化（单人规则）+ 显式禁用清单重算。
      const allEnabledModelIds = new Set(input.pools.flatMap((p) => p.enabled_model_ids));
      const targets = [...allEnabledModelIds].map((modelId) => {
        const m = modelById.get(modelId)!;
        return { unified_model_id: modelId, provider_resource_id: m.provider_resource_id };
      });
      await this.publishSingleRuleVersion(trx, input, singleRuleVersionId, targets, poolGrantByProvider, modelById);

      // 7. 手工接管：清空基线（权限已由池+开关承载）。
      const manualCleared = await trx.deleteFrom("principal_model_manual_authorization")
        .where("enterprise_id", "=", input.enterpriseId).where("principal_id", "=", input.principalId)
        .executeTakeFirst();

      // 8. 重算白名单。
      await this.ruleRepo.refreshKeyModels(trx, input.enterpriseId, input.principalId);

      // 9. 审计 + 幂等存档。
      const response = {
        config_version: locked.nextVersion,
        changes,
        takeover: { cleared_manual: Number(manualCleared.numDeletedRows ?? 0) },
      };
      await trx.insertInto("operation_log").values({
        enterprise_id: input.enterpriseId, admin_user_id: input.adminUserId,
        action: "principal_access_config.save", target_type: "principal",
        target_id: input.principalId, result: "SUCCESS", failure_reason: null,
        change_summary: jsonValue({
          config_version: locked.nextVersion, pools_added: changes.pools_added,
          pools_updated: changes.pools_updated, pools_closed: changes.pools_closed,
          enabled_models: allEnabledModelIds.size,
        }),
      }).execute();
      await trx.insertInto("principal_access_idempotency").values({
        enterprise_id: input.enterpriseId, principal_id: input.principalId,
        idempotency_key: input.idempotencyKey, request_hash: requestHash,
        response_snapshot: jsonValue(response) as Record<string, unknown>,
      }).execute();
      return response;
    });
  }

  /** 锁 config_version 行并比对 expectedVersion，通过后自增（在事务内）。 */
  private async lockAndCheckConfigVersion(trx: Transaction<Database>, input: AccessConfigPutInput) {
    await trx.insertInto("principal_access_config_state").values({
      enterprise_id: input.enterpriseId, principal_id: input.principalId, config_version: 1,
    }).onConflict((oc) => oc.doNothing()).execute();
    const state = await trx.selectFrom("principal_access_config_state")
      .select("config_version")
      .where("enterprise_id", "=", input.enterpriseId).where("principal_id", "=", input.principalId)
      .forUpdate().executeTakeFirstOrThrow();
    if (state.config_version !== input.expectedVersion) {
      throw new PrincipalAccessConfigError("CONFLICT", "配置已被其他操作修改，请刷新后重试");
    }
    const nextVersion = state.config_version + 1;
    await trx.updateTable("principal_access_config_state")
      .set({ config_version: nextVersion, updated_at: new Date() })
      .where("enterprise_id", "=", input.enterpriseId).where("principal_id", "=", input.principalId)
      .execute();
    return { nextVersion };
  }

  /** 确保该主体存在单人规则（无则建 version 1 草稿），返回规则版本 id。 */
  private async ensureSingleRule(trx: Transaction<Database>, input: AccessConfigPutInput): Promise<string> {
    const existing = await trx.selectFrom("employee_model_rule_version")
      .select(["id", "rule_id", "version", "status"])
      .where("enterprise_id", "=", input.enterpriseId).where("owner_principal_id", "=", input.principalId)
      .orderBy("version", "desc").forUpdate().executeTakeFirst();
    if (existing) {
      // 有未发布草稿则直接复用（下次保存覆盖）；否则由 publishSingleRuleVersion 开新版本。
      return existing.id;
    }
    const created = await trx.insertInto("employee_model_rule_version").values({
      enterprise_id: input.enterpriseId, rule_id: randomUUID(), version: 1,
      name: `接入配置-${input.principalId}`, employee_scope: "SELECTED",
      principal_ids: jsonValue([input.principalId]), model_scope: "SELECTED",
      model_targets: jsonValue([]), quota_value: null, allow_overage: false,
      valid_from: new Date(), valid_until: null,
      owner_principal_id: input.principalId, created_by_admin_user_id: input.adminUserId,
      status: "DRAFT",
    }).returning("id").executeTakeFirstOrThrow();
    return created.id;
  }

  /** 发布单人规则新版本：禁用不再开通的型号、保留仍开通的、写显式禁用清单。 */
  private async publishSingleRuleVersion(
    trx: Transaction<Database>,
    input: AccessConfigPutInput,
    ruleVersionId: string,
    targets: { unified_model_id: string; provider_resource_id: string }[],
    poolGrantByProvider: Map<string, string>,
    modelById: Map<string, ModelRow>,
  ) {
    const version = await trx.selectFrom("employee_model_rule_version").selectAll()
      .where("id", "=", ruleVersionId).forUpdate().executeTakeFirstOrThrow();

    // 撤掉旧 PUBLISHED 版本（若有）：其 assignment 置 DISABLED。
    const previousPublished = await trx.selectFrom("employee_model_rule_version").select("id")
      .where("enterprise_id", "=", input.enterpriseId).where("rule_id", "=", version.rule_id)
      .where("status", "=", "PUBLISHED").where("id", "!=", version.id).forUpdate().execute();
    for (const prev of previousPublished) {
      await trx.updateTable("employee_model_rule_assignment")
        .set({ status: "DISABLED", disabled_at: new Date() })
        .where("rule_version_id", "=", prev.id).where("status", "=", "ACTIVE").execute();
      await trx.updateTable("employee_model_rule_version")
        .set({ status: "DISABLED", disabled_at: new Date(), updated_at: new Date() })
        .where("id", "=", prev.id).execute();
    }

    // 更新当前版本为 VALIDATED → PUBLISHED，并落 targets。
    await trx.updateTable("employee_model_rule_version").set({
      model_targets: jsonValue(targets), status: "PUBLISHED",
      published_at: new Date(), lock_version: sql`lock_version + 1`, updated_at: new Date(),
    }).where("id", "=", version.id).execute();

    // 建 assignment（指向池 grant_id）。
    const targetKeys = new Set(targets.map((t) => `${t.unified_model_id}:${t.provider_resource_id}`));
    // 修复（POOL-033 回归）：同一规则版本内"掐型号"时，被掐型号的旧 assignment 必须停用。
    // 原实现只为 targets 建 assignment（onConflict doNothing），但不触碰本次未选中的旧 ACTIVE
    // assignment → refreshKeyModels 的 managed 来源仍含被掐型号 → 白名单冗余。
    // 虽 Gateway 禁用清单会兜底拒绝实际调用，但白名单冗余违反"静态授权集即真实可用集"语义，
    // 也让回归测试无法收紧断言。此处停用该规则版本下不在 targets 里的 ACTIVE assignment。
    const targetModelIds = new Set(targets.map((t) => t.unified_model_id));
    // targets 非空时停用被掐型号的旧 assignment（targets 为空时本函数不会走到这里——
    // 就绪校验拒绝 quota>0 但 enabled_model_ids 为空，且 poolGrantByProvider 为空时无池可挂）。
    if (targetModelIds.size > 0) {
      await trx.updateTable("employee_model_rule_assignment")
        .set({ status: "DISABLED", disabled_at: new Date() })
        .where("rule_version_id", "=", ruleVersionId)
        .where("status", "=", "ACTIVE")
        .where("unified_model_id", "not in", [...targetModelIds]).execute();
    }
    for (const target of targets) {
      const m = modelById.get(target.unified_model_id)!;
      const poolGrantId = poolGrantByProvider.get(m.provider_code);
      if (!poolGrantId) continue; // 池未建（enabled_model_ids 为空）则不建开关
      await trx.insertInto("employee_model_rule_assignment").values({
        enterprise_id: input.enterpriseId, rule_version_id: ruleVersionId,
        principal_id: input.principalId, unified_model_id: target.unified_model_id,
        provider_resource_id: target.provider_resource_id, grant_id: poolGrantId, status: "ACTIVE",
      }).onConflict((oc) => oc.doNothing()).execute();
    }

    // 显式禁用清单：该主体该厂商下"不就绪或未被本次保留"的型号。
    // 语义：已开通厂商中，未出现在 targets 里的型号全部进禁用清单。
    const enabledProviderCodes = new Set([...poolGrantByProvider.keys()]);
    for (const providerCode of enabledProviderCodes) {
      const providerModels = [...modelById.values()].filter((m) => m.provider_code === providerCode);
      for (const m of providerModels) {
        const key = `${m.unified_model_id}:${m.provider_resource_id}`;
        if (!targetKeys.has(key)) {
          await trx.insertInto("principal_provider_disabled_model").values({
            enterprise_id: input.enterpriseId, principal_id: input.principalId,
            provider: providerCode, unified_model_id: m.unified_model_id,
            disabled_at: new Date(), disable_rule_version_id: ruleVersionId,
          }).onConflict((oc) => oc.doNothing()).execute();
        }
      }
      // 重新开通的型号从禁用清单移除。
      const reEnabled = providerModels.filter((m) => targetKeys.has(`${m.unified_model_id}:${m.provider_resource_id}`));
      if (reEnabled.length > 0) {
        await trx.deleteFrom("principal_provider_disabled_model")
          .where("enterprise_id", "=", input.enterpriseId).where("principal_id", "=", input.principalId)
          .where("provider", "=", providerCode)
          .where("unified_model_id", "in", reEnabled.map((m) => m.unified_model_id)).execute();
      }
    }

    // 池被关闭的厂商：该厂商所有型号的禁用清单清空（无所谓，池 DISABLED 已整体拒）。
    // 无需额外动作——池 DISABLED 后 findAdmissibleGrant 不再命中。
  }
}

/** 白名单重算的纯函数（供测试与复用）：手工 ∪ 受管开关 ∪ 池内未禁用型号。 */
export function computeAllowedModelIds(input: {
  manualIds: string[];
  managedAssignmentModelIds: string[];
  poolModelIds: string[];      // 已开通厂商的全部就绪型号
  disabledModelIds: string[];  // 显式禁用清单
}): string[] {
  const disabled = new Set(input.disabledModelIds);
  const poolAllowed = input.poolModelIds.filter((id) => !disabled.has(id));
  return mergeDeclaredModelIds(
    mergeDeclaredModelIds(input.manualIds, input.managedAssignmentModelIds),
    poolAllowed,
  );
}
