/** POOL-029：员工使用规则版本、就绪校验与 Key/Grant 原子发布。 */
import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type {
  Database,
  EmployeeModelTarget,
} from "../kysely.js";
import type { EmployeeModelPoolQuota } from "../employee-model-rule-types.js";
import {
  validateEmployeeModelRule,
  type EmployeeModelRuleVersion,
  type RuleValidationResult,
} from "./employee-model-rule-validation.js";
import { lockActiveProviderPools } from "./principal-access-locks.js";
import { captureManualBaseline, lockRuleFamily, lockVersion, providerCodesForRuleFamily } from "./employee-model-rule-lock-context.js";
import { resolvePoolQuota } from "./employee-model-rule-quota.js";
import { disableEmployeeRuleVersion, refreshEmployeeKeyModels } from "./employee-model-rule-lifecycle.js";

export function publishRequestHash(quotaMode: "SET" | "ADD" | undefined) {
  return createHash("sha256").update(JSON.stringify({ quota_mode: quotaMode ?? "SET" })).digest("hex");
}

export type {
  EmployeeModelRuleVersion,
  RulePermissionChange,
  RuleReadinessIssue,
  RuleValidationResult,
} from "./employee-model-rule-validation.js";

export interface EmployeeModelRuleInput {
  name: string;
  employee_scope: "SELECTED" | "ALL";
  principal_ids: string[];
  model_scope: "SELECTED" | "ALL";
  model_targets: EmployeeModelTarget[];
  quota_value: bigint;
  allow_overage: boolean;
  valid_from: Date;
  valid_until: Date | null;
  /** POOL-035：厂商级池额度；空数组表示无厂商级额度，发布时回退版本级单值。 */
  pool_quotas: EmployeeModelPoolQuota[];
}

export class EmployeeModelRuleError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "CONFLICT" | "NOT_READY" | "INVALID_STATE" | "IDEMPOTENCY_CONFLICT",
    message: string,
    readonly validation?: RuleValidationResult,
  ) {
    super(message);
    this.name = "EmployeeModelRuleError";
  }
}

function jsonValue<T>(value: T): T {
  return JSON.stringify(value) as unknown as T;
}

export class EmployeeModelRuleRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async catalog(enterpriseId: string) {
    const [principals, routes] = await Promise.all([
      this.db.selectFrom("principal")
        .leftJoin("principal_key", (join) => join
          .onRef("principal_key.principal_id", "=", "principal.id")
          .onRef("principal_key.enterprise_id", "=", "principal.enterprise_id")
          .on("principal_key.status", "=", "ACTIVE"))
        .select([
          "principal.id", "principal.name", "principal.department_label", "principal.status",
          "principal.archived_at", "principal_key.id as active_key_id",
        ])
        .where("principal.enterprise_id", "=", enterpriseId)
        .where("principal.type", "=", "EMPLOYEE")
        // 排除已归档主体（POOL-008/009 验收遗留），与 validation 的 archived_at 语义一致；
        // DISABLED 但未归档的主体仍列出标灰，那是"临时停用、可恢复"的正常业务状态。
        .where("principal.archived_at", "is", null)
        .orderBy("principal.name")
        .execute(),
      this.db.selectFrom("model_route")
        .innerJoin("unified_model", "unified_model.id", "model_route.unified_model_id")
        .innerJoin("provider_resource", "provider_resource.id", "model_route.provider_resource_id")
        .innerJoin("provider", "provider.id", "provider_resource.provider_id")
        .select([
          "unified_model.id as unified_model_id", "unified_model.alias", "unified_model.display_name",
          "unified_model.status as model_status", "model_route.id as route_id", "model_route.upstream_model",
          "model_route.enabled as route_enabled", "provider_resource.id as provider_resource_id",
          "provider_resource.name as resource_name", "provider_resource.status as resource_status",
          "provider_resource.mode", "provider.code as provider_code", "provider.name as provider_name",
          "provider.status as provider_status",
        ])
        .where("model_route.enterprise_id", "=", enterpriseId)
        // 隐藏未启用 route（pool033 切型号时停用的旧笼统别名，如 K3/zhipu）；
        // 与 validation 的 ALL 范围语义一致（enabled=false 本就不会进 readyTargets 被发布）。
        // 历史用量仍可在用量账本按 alias 查到，不删除。
        .where("model_route.enabled", "=", true)
        .orderBy("provider.name")
        .orderBy("unified_model.display_name")
        .execute(),
    ]);
    const now = new Date();
    const billing = await this.db.selectFrom("billing_rule")
      .select(["provider_resource_id", "upstream_model"])
      .where("enterprise_id", "=", enterpriseId)
      .where("enabled", "=", true)
      .where("effective_from", "<=", now)
      .where((eb) => eb.or([eb("effective_to", "is", null), eb("effective_to", ">", now)]))
      .execute();
    const priced = new Set(billing.map((item) => `${item.provider_resource_id ?? "*"}:${item.upstream_model ?? "*"}`));
    return {
      principals: principals.map((principal) => ({
        ...principal,
        ready: principal.status === "ACTIVE" && principal.archived_at === null && principal.active_key_id !== null,
        unavailable_reason: principal.status !== "ACTIVE" || principal.archived_at !== null
          ? "员工主体未启用"
          : principal.active_key_id === null ? "员工尚无有效 Key" : null,
      })),
      models: routes.map((route) => {
        const hasBilling = priced.has(`${route.provider_resource_id}:${route.upstream_model}`)
          || priced.has(`${route.provider_resource_id}:*`)
          || priced.has(`*:${route.upstream_model}`)
          || priced.has("*:*");
        const reasons = [
          route.model_status !== "ACTIVE" ? "统一模型未启用" : null,
          !route.route_enabled ? "Model Route 未启用" : null,
          !["ACTIVE", "DEGRADED"].includes(route.resource_status) ? "厂商资源不可服务" : null,
          route.provider_status !== "ACTIVE" ? "厂商未启用" : null,
          !hasBilling ? "缺少当前生效的计价或扣减规则" : null,
        ].filter((reason): reason is string => Boolean(reason));
        return { ...route, ready: reasons.length === 0, unavailable_reasons: reasons };
      }),
    };
  }

  async list(enterpriseId: string): Promise<EmployeeModelRuleVersion[]> {
    return this.db.selectFrom("employee_model_rule_version").selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .orderBy("created_at", "desc").execute();
  }

  async history(enterpriseId: string, ruleId: string): Promise<EmployeeModelRuleVersion[]> {
    return this.db.selectFrom("employee_model_rule_version").selectAll()
      .where("enterprise_id", "=", enterpriseId).where("rule_id", "=", ruleId)
      .orderBy("version", "desc").execute();
  }

  async create(enterpriseId: string, adminUserId: string, input: EmployeeModelRuleInput) {
    return this.db.insertInto("employee_model_rule_version").values({
      enterprise_id: enterpriseId,
      rule_id: randomUUID(),
      version: 1,
      name: input.name,
      employee_scope: input.employee_scope,
      principal_ids: jsonValue(input.principal_ids),
      model_scope: input.model_scope,
      model_targets: jsonValue(input.model_targets),
      quota_value: input.quota_value,
      allow_overage: input.allow_overage,
      valid_from: input.valid_from,
      valid_until: input.valid_until,
      pool_quotas: jsonValue(input.pool_quotas),
      created_by_admin_user_id: adminUserId,
    }).returningAll().executeTakeFirstOrThrow();
  }

  async createNextVersion(enterpriseId: string, adminUserId: string, ruleId: string) {
    return this.db.transaction().execute(async (trx) => {
      const latest = await trx.selectFrom("employee_model_rule_version").selectAll()
        .where("enterprise_id", "=", enterpriseId).where("rule_id", "=", ruleId)
        .orderBy("version", "desc").forUpdate().executeTakeFirst();
      if (!latest) throw new EmployeeModelRuleError("NOT_FOUND", "员工使用规则不存在");
      if (latest.status === "DRAFT" || latest.status === "VALIDATED") {
        throw new EmployeeModelRuleError("CONFLICT", "该规则已有未发布版本");
      }
      return trx.insertInto("employee_model_rule_version").values({
        enterprise_id: enterpriseId, rule_id: ruleId, version: latest.version + 1,
        name: latest.name, employee_scope: latest.employee_scope,
        principal_ids: jsonValue(latest.principal_ids), model_scope: latest.model_scope,
        model_targets: jsonValue(latest.model_targets), quota_value: latest.quota_value,
        allow_overage: latest.allow_overage, valid_from: latest.valid_from,
        valid_until: latest.valid_until, pool_quotas: jsonValue(latest.pool_quotas ?? []),
        created_by_admin_user_id: adminUserId,
      }).returningAll().executeTakeFirstOrThrow();
    });
  }

  async updateDraft(enterpriseId: string, versionId: string, expectedLockVersion: number, input: EmployeeModelRuleInput) {
    const updated = await this.db.updateTable("employee_model_rule_version").set({
      name: input.name, employee_scope: input.employee_scope,
      principal_ids: jsonValue(input.principal_ids), model_scope: input.model_scope,
      model_targets: jsonValue(input.model_targets), quota_value: input.quota_value,
      allow_overage: input.allow_overage, valid_from: input.valid_from,
      valid_until: input.valid_until, pool_quotas: jsonValue(input.pool_quotas),
      status: "DRAFT", validation_snapshot: null,
      lock_version: sql`lock_version + 1`, updated_at: new Date(),
    }).where("enterprise_id", "=", enterpriseId).where("id", "=", versionId)
      .where("status", "in", ["DRAFT", "VALIDATED"]).where("lock_version", "=", expectedLockVersion)
      .returningAll().executeTakeFirst();
    if (!updated) throw new EmployeeModelRuleError("CONFLICT", "规则已被修改或当前版本不可编辑，请刷新后重试");
    return updated;
  }

  async validate(enterpriseId: string, versionId: string): Promise<RuleValidationResult> {
    return this.db.transaction().execute(async (trx) => {
      const version = await lockVersion(trx, enterpriseId, versionId);
      if (!version) throw new EmployeeModelRuleError("NOT_FOUND", "员工使用规则版本不存在");
      if (!["DRAFT", "VALIDATED"].includes(version.status)) {
        throw new EmployeeModelRuleError("INVALID_STATE", "只有草稿或已校验版本可以重新校验");
      }
      const validation = await validateEmployeeModelRule(trx, version);
      await trx.updateTable("employee_model_rule_version").set({
        status: validation.ready ? "VALIDATED" : "DRAFT",
        validation_snapshot: jsonValue(validation) as unknown as Record<string, unknown>, lock_version: sql`lock_version + 1`, updated_at: new Date(),
      }).where("id", "=", version.id).execute();
      return validation;
    });
  }

  async publish(input: {
    enterpriseId: string; versionId: string; expectedLockVersion: number;
    idempotencyKey: string; adminUserId: string;
    /** POOL-033 §6：SET（默认）= 池额度设为规则值；ADD = 行锁内追加规则值。 */
    quotaMode?: "SET" | "ADD";
  }): Promise<{ version: EmployeeModelRuleVersion; validation: RuleValidationResult; assignment_count: number }> {
    return this.db.transaction().execute(async (trx) => {
      const requestHash = publishRequestHash(input.quotaMode);
      const { reference, principals } = await lockRuleFamily(
        trx, input.enterpriseId, input.versionId,
        captureManualBaseline,
      );
      if (!reference) throw new EmployeeModelRuleError("NOT_FOUND", "员工使用规则版本不存在");
      const version = await this.lockRuleVersion(trx, input.enterpriseId, input.versionId);
      const reusedKey = await trx.selectFrom("employee_model_rule_version").select(["id", "rule_id"])
        .where("enterprise_id", "=", input.enterpriseId)
        .where("publish_idempotency_key", "=", input.idempotencyKey)
        .where("id", "!=", version.id).executeTakeFirst();
      if (reusedKey) {
        throw new EmployeeModelRuleError("IDEMPOTENCY_CONFLICT", "该发布幂等键已被其他规则版本使用");
      }
      if (version.status === "PUBLISHED") {
        if (version.publish_idempotency_key !== input.idempotencyKey) {
          throw new EmployeeModelRuleError("IDEMPOTENCY_CONFLICT", "该版本已使用其他幂等键发布");
        }
        // 0043 前的历史行没有 request hash，只兼容默认 SET 重放；显式 ADD
        // 必须拿到新的幂等键，避免相同 key 携带不同额度语义时静默 no-op。
        if (version.publish_request_hash !== requestHash
          && (version.publish_request_hash !== null || input.quotaMode === "ADD")) {
          throw new EmployeeModelRuleError("IDEMPOTENCY_CONFLICT", "该发布幂等键对应的额度模式不同");
        }
        const count = await trx.selectFrom("employee_model_rule_assignment")
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .where("rule_version_id", "=", version.id).executeTakeFirstOrThrow();
        return { version, validation: version.validation_snapshot as unknown as RuleValidationResult, assignment_count: Number(count.count) };
      }
      if (version.status !== "VALIDATED") {
        throw new EmployeeModelRuleError("INVALID_STATE", "请先校验通过，再显式发布规则");
      }
      if (version.lock_version !== input.expectedLockVersion) {
        throw new EmployeeModelRuleError("CONFLICT", "规则已被修改，请刷新并重新校验");
      }
      const validation = await validateEmployeeModelRule(trx, version);
      if (!validation.ready) throw new EmployeeModelRuleError("NOT_READY", "规则就绪校验未通过", validation);

      const providerCodes = await providerCodesForRuleFamily(
        trx, input.enterpriseId, version.rule_id, version.model_scope, version.model_targets,
      );
      await lockActiveProviderPools(trx, input.enterpriseId, principals, providerCodes);

      const previous = await trx.selectFrom("employee_model_rule_version").select("id")
        .where("enterprise_id", "=", input.enterpriseId).where("rule_id", "=", version.rule_id)
        .where("status", "=", "PUBLISHED").where("id", "!=", version.id).forUpdate().execute();
      for (const item of previous) await disableEmployeeRuleVersion(trx, input.enterpriseId, item.id);

      for (const principalId of [...validation.principal_ids].sort()) {
        // POOL-033：规则只管型号准入开关，额度归主体×厂商池。每主体每厂商至多一个 ACTIVE 池
        // （由迁移 0039 唯一索引保证）；本规则发布只确保池存在（不存在则建空池待管理员填额度），
        // 随后所有该厂商下的 target 共享同一池 grant_id。
        const targetByProvider = new Map<string, { unified_model_id: string; provider_resource_id: string; alias: string }[]>();
        for (const target of validation.model_targets) {
          const route = await trx.selectFrom("model_route")
            .innerJoin("unified_model", "unified_model.id", "model_route.unified_model_id")
            .innerJoin("provider_resource", "provider_resource.id", "model_route.provider_resource_id")
            .innerJoin("provider", "provider.id", "provider_resource.provider_id")
            .select(["unified_model.alias", "provider.code"])
            .where("model_route.enterprise_id", "=", input.enterpriseId)
            .where("model_route.unified_model_id", "=", target.unified_model_id)
            .where("model_route.provider_resource_id", "=", target.provider_resource_id)
            .where("model_route.enabled", "=", true).executeTakeFirstOrThrow();
          const bucket = targetByProvider.get(route.code) ?? [];
          bucket.push({ unified_model_id: target.unified_model_id, provider_resource_id: target.provider_resource_id, alias: route.alias });
          targetByProvider.set(route.code, bucket);
        }
        for (const [providerCode, targets] of targetByProvider) {
          // POOL-035：该厂商的池额度——优先厂商级 pool_quotas，否则回退版本级单值。
          const providerQuota = (version.pool_quotas ?? []).find((item) => item.provider_code === providerCode);
          const poolQuota = resolvePoolQuota(version, providerCode);
          // 查找或建立该主体×厂商的 ACTIVE 池 Grant。
          let poolGrant = await trx.selectFrom("principal_grant").select("id")
            .where("enterprise_id", "=", input.enterpriseId)
            .where("principal_id", "=", principalId)
            .where("provider", "=", providerCode)
            .where("pool_model_alias", "=", "*")
            .where("status", "=", "ACTIVE")
            .forUpdate()
            .executeTakeFirst();
          if (!poolGrant) {
            // 建池：用该厂商的额度（厂商级优先，回退版本级）。单人页保存时规则额度为 NULL，池额度由
            // 编排端点单独管理。并发安全：唯一索引冲突时重查（另一事务已建池）。
            const inserted = await trx.insertInto("principal_grant").values({
              enterprise_id: input.enterpriseId, principal_id: principalId, provider: providerCode,
              model_alias: "*", pool_model_alias: "*", quota_unit: "TOKEN",
              quota_value: poolQuota.quota_value,
              allow_overage: poolQuota.allow_overage, valid_from: version.valid_from, valid_until: poolQuota.valid_until,
              status: "ACTIVE", authorization_rule_version_id: version.id,
            }).onConflict((oc) => oc.doNothing()).returning("id").executeTakeFirst();
            if (inserted) {
              poolGrant = inserted;
              await trx.insertInto("quota_counter").values({ grant_id: poolGrant.id }).execute();
            } else {
              // 冲突：另一事务已建池，重新查询。
              poolGrant = await trx.selectFrom("principal_grant").select("id")
                .where("enterprise_id", "=", input.enterpriseId)
                .where("principal_id", "=", principalId)
                .where("provider", "=", providerCode)
                .where("pool_model_alias", "=", "*")
                .where("status", "=", "ACTIVE")
                .forUpdate()
                .executeTakeFirstOrThrow();
            }
          } else if (input.quotaMode === "ADD") {
            // POOL-033 §6 + POOL-035：批量"追加额度"——按厂商分别锁内追加；厂商级缺失时要求
            // 版本级 quota_value 非 NULL，否则该厂商无可追加的额度。
            if (!providerQuota && version.quota_value === null) {
              throw new EmployeeModelRuleError("INVALID_STATE", `厂商 ${providerCode} 缺少可追加的额度`);
            }
            await trx.updateTable("principal_grant")
              .set({ quota_value: sql`quota_value + ${poolQuota.quota_value}`, authorization_rule_version_id: version.id,
                version: sql`version + 1`, updated_at: new Date() })
              .where("id", "=", poolGrant.id).execute();
          } else {
            await trx.updateTable("principal_grant").set({
              quota_value: poolQuota.quota_value, allow_overage: poolQuota.allow_overage,
              valid_until: poolQuota.valid_until, authorization_rule_version_id: version.id,
              version: sql`version + 1`, updated_at: new Date(),
            }).where("id", "=", poolGrant.id).execute();
          }
          // 每个 target 建一条型号级行（pool_model_alias=NULL）用于"准入开关 + 池回退查询"，
          // 不再独立计数；assignment 指向池 grant_id。
          for (const t of targets) {
            await trx.insertInto("employee_model_rule_assignment").values({
              enterprise_id: input.enterpriseId, rule_version_id: version.id, principal_id: principalId,
              unified_model_id: t.unified_model_id, provider_resource_id: t.provider_resource_id,
              grant_id: poolGrant.id, status: "ACTIVE",
            }).execute();
          }
        }
        await this.refreshKeyModels(trx, input.enterpriseId, principalId);
      }

      const published = await trx.updateTable("employee_model_rule_version").set({
        status: "PUBLISHED", validation_snapshot: jsonValue(validation) as unknown as Record<string, unknown>,
        publish_idempotency_key: input.idempotencyKey, publish_request_hash: requestHash, published_at: new Date(),
        lock_version: sql`lock_version + 1`, updated_at: new Date(),
      }).where("id", "=", version.id).returningAll().executeTakeFirstOrThrow();
      await trx.insertInto("operation_log").values({
        enterprise_id: input.enterpriseId, admin_user_id: input.adminUserId,
        action: "employee_model_rule.publish", target_type: "employee_model_rule",
        target_id: version.rule_id, result: "SUCCESS", failure_reason: null,
        change_summary: jsonValue({ version: version.version, principal_count: validation.principal_count,
          model_count: validation.model_count, assignment_count: validation.assignment_count,
          quota_mode: input.quotaMode ?? "SET" }),
      }).execute();
      return { version: published, validation, assignment_count: validation.assignment_count };
    });
  }

  async disable(enterpriseId: string, versionId: string, adminUserId: string) {
    return this.db.transaction().execute(async (trx) => {
      const { reference, principals } = await lockRuleFamily(
        trx, enterpriseId, versionId,
        captureManualBaseline,
      );
      if (!reference) throw new EmployeeModelRuleError("NOT_FOUND", "员工使用规则版本不存在");
      const version = await this.lockRuleVersion(trx, enterpriseId, versionId);
      if (version.status === "DISABLED") return version;
      if (version.status !== "PUBLISHED") {
        throw new EmployeeModelRuleError("INVALID_STATE", "只有已发布规则可以停用");
      }
      const providerCodes = await providerCodesForRuleFamily(
        trx, enterpriseId, version.rule_id, version.model_scope, version.model_targets,
      );
      await lockActiveProviderPools(trx, enterpriseId, principals, providerCodes);
      const affected = await disableEmployeeRuleVersion(trx, enterpriseId, version.id);
      await trx.insertInto("operation_log").values({
        enterprise_id: enterpriseId, admin_user_id: adminUserId,
        action: "employee_model_rule.disable", target_type: "employee_model_rule",
        target_id: version.rule_id, result: "SUCCESS", failure_reason: null,
        change_summary: jsonValue({ version: version.version, principal_ids: affected }),
      }).execute();
      return trx.selectFrom("employee_model_rule_version").selectAll().where("id", "=", version.id)
        .executeTakeFirstOrThrow();
    });
  }

  /** 同一业务规则的发布/停用串行化，必须在主体 Key 锁之后调用。 */
  private async lockRuleVersion(trx: Transaction<Database>, enterpriseId: string, versionId: string) {
    const reference = await trx.selectFrom("employee_model_rule_version").select("rule_id")
      .where("enterprise_id", "=", enterpriseId).where("id", "=", versionId).executeTakeFirst();
    if (!reference) throw new EmployeeModelRuleError("NOT_FOUND", "员工使用规则版本不存在");
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`${enterpriseId}:${reference.rule_id}`}))`.execute(trx);
    const version = await lockVersion(trx, enterpriseId, versionId);
    if (!version) throw new EmployeeModelRuleError("NOT_FOUND", "员工使用规则版本不存在");
    return version;
  }

  /** POOL-033：升级为 public，供 PrincipalAccessConfigRepository 同事务复用。 */
  async refreshKeyModels(trx: Transaction<Database>, enterpriseId: string, principalId: string) {
    return refreshEmployeeKeyModels(trx, enterpriseId, principalId);
  }
}
