import { sql, type Kysely, type Transaction } from "kysely";
import type { Database, DirectoryImportItemStatus } from "../kysely.js";
import { resolvePoolQuota } from "./employee-model-rule-quota.js";
import { DirectoryRepositoryError } from "./directory-repository-types.js";

const TERMINAL = new Set<DirectoryImportItemStatus>([
  "MATCHED", "CREATED", "UPDATED", "CONFLICT", "SKIPPED", "FAILED",
]);

class ItemConflict extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
    this.name = "ItemConflict";
  }
}

function json(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.stringify(value) as unknown as Record<string, unknown>;
}

function sameText(left: string | null, right: string): boolean {
  return left?.trim().toLocaleLowerCase("en-US") === right.trim().toLocaleLowerCase("en-US");
}

function pathSegments(path: string): string[] {
  return path.split("/").map((item) => item.trim()).filter(Boolean);
}

async function ensureOrganizationPath(
  trx: Transaction<Database>,
  input: {
    enterpriseId: string;
    sourceId: string | null;
    departmentPath: string;
    externalDepartmentId: string | null;
  },
): Promise<{ id: string; name: string; changed: boolean }> {
  const segments = pathSegments(input.departmentPath);
  if (segments.length === 0) throw new ItemConflict("DEPARTMENT_REQUIRED");
  let parentId: string | null = null;
  let changed = false;
  let leaf: { id: string; name: string } | null = null;
  for (let index = 0; index < segments.length; index += 1) {
    const name = segments[index]!;
    if (name.length > 128) throw new ItemConflict("DEPARTMENT_NAME_TOO_LONG");
    const prefix = segments.slice(0, index + 1).join("/");
    const isLeaf = index === segments.length - 1;
    const externalUnitId = input.sourceId
      ? isLeaf && input.externalDepartmentId ? input.externalDepartmentId : `synthetic:${prefix}`
      : prefix;
    const existing = await trx.selectFrom("organization_unit").selectAll()
      .where("enterprise_id", "=", input.enterpriseId)
      .where("external_source_id", input.sourceId === null ? "is" : "=", input.sourceId)
      .where("external_unit_id", "=", externalUnitId)
      .forUpdate().executeTakeFirst();
    if (!existing) {
      leaf = await trx.insertInto("organization_unit").values({
        enterprise_id: input.enterpriseId,
        parent_id: parentId,
        name,
        external_source_id: input.sourceId,
        external_unit_id: externalUnitId,
        status: "ACTIVE",
      }).returning(["id", "name"]).executeTakeFirstOrThrow();
      changed = true;
    } else {
      leaf = { id: existing.id, name: existing.name };
      if (existing.name !== name || existing.parent_id !== parentId || existing.status !== "ACTIVE") {
        leaf = await trx.updateTable("organization_unit").set({
          name,
          parent_id: parentId,
          status: "ACTIVE",
          version: sql`version + 1`,
          updated_at: new Date(),
        }).where("enterprise_id", "=", input.enterpriseId).where("id", "=", existing.id)
          .returning(["id", "name"]).executeTakeFirstOrThrow();
        changed = true;
      }
    }
    parentId = leaf.id;
  }
  return { ...leaf!, changed };
}

/**
 * 新导入员工继承当前生效的 ALL 员工批量规则。规则只生成可配置的厂商池和
 * assignment；Key 仍保持待首次领取，不在后台生成明文。
 * 两层解耦后仅在开通主体（activateEmployeePrincipal / 手工绑定自然人）时调用。
 */
export async function applyPublishedEmployeeRules(
  trx: Transaction<Database>, enterpriseId: string, principalId: string, now: Date,
): Promise<number> {
  const versions = await trx.selectFrom("employee_model_rule_version").selectAll()
    .where("enterprise_id", "=", enterpriseId)
    .where("status", "=", "PUBLISHED")
    .where("employee_scope", "=", "ALL")
    .where("owner_principal_id", "is", null)
    .where("valid_from", "<=", now)
    .where((eb) => eb.or([eb("valid_until", "is", null), eb("valid_until", ">", now)]))
    // 同一厂商多条规则时，已有发布链路以最后发布者决定新池额度。
    .orderBy("published_at", "desc").orderBy("id", "desc").execute();
  let applied = 0;
  for (const version of versions) {
    // 从已发布且仍 ACTIVE 的 assignment 复用冻结型号集，不在导入时重新猜测路由。
    const targets = await trx.selectFrom("employee_model_rule_assignment")
      .innerJoin("provider_resource", (join) => join
        .onRef("provider_resource.enterprise_id", "=", "employee_model_rule_assignment.enterprise_id")
        .onRef("provider_resource.id", "=", "employee_model_rule_assignment.provider_resource_id"))
      .innerJoin("provider", (join) => join
        .onRef("provider.enterprise_id", "=", "provider_resource.enterprise_id")
        .onRef("provider.id", "=", "provider_resource.provider_id"))
      .select([
        "employee_model_rule_assignment.unified_model_id",
        "employee_model_rule_assignment.provider_resource_id",
        "provider.code as provider_code",
      ]).distinct()
      .where("employee_model_rule_assignment.enterprise_id", "=", enterpriseId)
      .where("employee_model_rule_assignment.rule_version_id", "=", version.id)
      .where("employee_model_rule_assignment.status", "=", "ACTIVE")
      .orderBy("provider.code")
      .orderBy("employee_model_rule_assignment.unified_model_id")
      .orderBy("employee_model_rule_assignment.provider_resource_id").execute();
    const byProvider = new Map<string, typeof targets>();
    for (const target of targets) {
      const bucket = byProvider.get(target.provider_code) ?? [];
      bucket.push(target);
      byProvider.set(target.provider_code, bucket);
    }
    for (const [providerCode, providerTargets] of byProvider) {
      let pool = await trx.selectFrom("principal_grant").select("id")
        .where("enterprise_id", "=", enterpriseId).where("principal_id", "=", principalId)
        .where("provider", "=", providerCode).where("pool_model_alias", "=", "*")
        .where("status", "=", "ACTIVE").forUpdate().executeTakeFirst();
      if (!pool) {
        const quota = resolvePoolQuota(version, providerCode);
        pool = await trx.insertInto("principal_grant").values({
          enterprise_id: enterpriseId, principal_id: principalId, provider: providerCode,
          model_alias: "*", pool_model_alias: "*", quota_unit: "TOKEN",
          quota_value: quota.quota_value, allow_overage: quota.allow_overage,
          valid_from: version.valid_from, valid_until: quota.valid_until, status: "ACTIVE",
          authorization_rule_version_id: version.id,
        }).onConflict((oc) => oc.doNothing()).returning("id").executeTakeFirst();
        pool ??= await trx.selectFrom("principal_grant").select("id")
          .where("enterprise_id", "=", enterpriseId).where("principal_id", "=", principalId)
          .where("provider", "=", providerCode).where("pool_model_alias", "=", "*")
          .where("status", "=", "ACTIVE").forUpdate().executeTakeFirstOrThrow();
        await trx.insertInto("quota_counter").values({ grant_id: pool.id })
          .onConflict((oc) => oc.column("grant_id").doNothing()).execute();
      }
      for (const target of providerTargets) {
        const inserted = await trx.insertInto("employee_model_rule_assignment").values({
          enterprise_id: enterpriseId, rule_version_id: version.id, principal_id: principalId,
          unified_model_id: target.unified_model_id,
          provider_resource_id: target.provider_resource_id,
          grant_id: pool.id,
          status: "ACTIVE",
        }).onConflict((oc) => oc.doNothing()).returning("id").executeTakeFirst();
        if (inserted) applied += 1;
      }
    }
  }
  return applied;
}

// eslint-disable-next-line complexity -- 固定匹配顺序与人/主体/组织/配置必须保持在同一 Item 短事务中。
async function applyItemTransaction(
  trx: Transaction<Database>, enterpriseId: string, runId: string, itemId: string,
): Promise<DirectoryImportItemStatus | null> {
  const run = await trx.selectFrom("directory_import_run").selectAll()
    .where("enterprise_id", "=", enterpriseId).where("id", "=", runId).executeTakeFirst();
  if (!run) return null;
  const item = await trx.selectFrom("directory_import_item").selectAll()
    .where("enterprise_id", "=", enterpriseId).where("run_id", "=", runId)
    .where("id", "=", itemId).forUpdate().executeTakeFirst();
  if (!item || TERMINAL.has(item.status)) return item?.status ?? null;
  if (item.reason_code) throw new ItemConflict(item.reason_code);
  if (!item.normalized_name) throw new ItemConflict("NAME_REQUIRED");
  if (!item.normalized_department_path) throw new ItemConflict("DEPARTMENT_REQUIRED");
  if (run.mode === "SYNC" && (!run.directory_source_id || !item.external_member_id)) {
    throw new ItemConflict("EXTERNAL_MEMBER_ID_REQUIRED");
  }
  if (run.mode === "EXCEL" && !item.employee_number) {
    throw new ItemConflict("EMPLOYEE_NUMBER_REQUIRED");
  }

  await trx.updateTable("directory_import_item").set({
    status: "PROCESSING", attempt: sql`attempt + 1`, lease_until: new Date(Date.now() + 60_000),
    updated_at: new Date(),
  }).where("id", "=", item.id).execute();

  const identity = run.directory_source_id && item.external_member_id
    ? await trx.selectFrom("person_external_identity").selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .where("directory_source_id", "=", run.directory_source_id)
      .where("provider_user_id", "=", item.external_member_id)
      .where("status", "=", "ACTIVE").executeTakeFirst()
    : undefined;
  const explicit = item.existing_principal_id
    ? await trx.selectFrom("principal").selectAll()
      .where("enterprise_id", "=", enterpriseId).where("id", "=", item.existing_principal_id)
      .executeTakeFirst()
    : undefined;
  if (item.existing_principal_id && (!explicit || explicit.type !== "EMPLOYEE")) {
    throw new ItemConflict("EXPLICIT_PRINCIPAL_INVALID");
  }
  if (explicit?.archived_at) throw new ItemConflict("PRINCIPAL_ARCHIVED");
  const employeePerson = item.employee_number
    ? await trx.selectFrom("person").selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .where(sql<boolean>`lower(employee_number) = lower(${item.employee_number})`)
      .executeTakeFirst()
    : undefined;
  const candidatePersonIds = new Set(
    [identity?.person_id, explicit?.person_id, employeePerson?.id].filter((id): id is string => Boolean(id)),
  );
  if (candidatePersonIds.size > 1) throw new ItemConflict("STABLE_ID_CONFLICT");

  let person = identity
    ? await trx.selectFrom("person").selectAll().where("enterprise_id", "=", enterpriseId)
      .where("id", "=", identity.person_id).forUpdate().executeTakeFirstOrThrow()
    : explicit?.person_id
      ? await trx.selectFrom("person").selectAll().where("enterprise_id", "=", enterpriseId)
        .where("id", "=", explicit.person_id).forUpdate().executeTakeFirstOrThrow()
      : employeePerson
        ? await trx.selectFrom("person").selectAll().where("enterprise_id", "=", enterpriseId)
          .where("id", "=", employeePerson.id).forUpdate().executeTakeFirstOrThrow()
        : undefined;
  let created = false;
  let changed = false;
  if (person && item.employee_number && person.employee_number && !sameText(person.employee_number, item.employee_number)) {
    throw new ItemConflict("EMPLOYEE_NUMBER_CONFLICT");
  }
  if (!person) {
    person = await trx.insertInto("person").values({
      enterprise_id: enterpriseId,
      name: item.normalized_name,
      department_label: null,
      employee_number: item.employee_number,
      email: item.normalized_email,
      mobile: item.normalized_mobile,
      status: "ACTIVE",
    }).returningAll().executeTakeFirstOrThrow();
    created = true;
  } else {
    const personPatch = {
      ...(person.employee_number === null && item.employee_number ? { employee_number: item.employee_number } : {}),
      ...(person.email === null && item.normalized_email ? { email: item.normalized_email } : {}),
      ...(person.mobile === null && item.normalized_mobile ? { mobile: item.normalized_mobile } : {}),
    };
    if (Object.keys(personPatch).length > 0) {
      person = await trx.updateTable("person").set({
        ...personPatch, version: sql`version + 1`, updated_at: new Date(),
      }).where("enterprise_id", "=", enterpriseId).where("id", "=", person.id)
        .returningAll().executeTakeFirstOrThrow();
      changed = true;
    }
  }

  // 两层解耦：导入/同步只维护自然人档案；已开通主体仅做显式绑定回填，不再自动创建。
  const currentPrincipal = await trx.selectFrom("principal").selectAll()
    .where("enterprise_id", "=", enterpriseId).where("type", "=", "EMPLOYEE")
    .where("person_id", "=", person.id).forUpdate().executeTakeFirst();
  if (explicit && currentPrincipal && explicit.id !== currentPrincipal.id) {
    throw new ItemConflict("STABLE_ID_CONFLICT");
  }
  let principal = explicit ?? currentPrincipal;
  if (principal && principal.archived_at) throw new ItemConflict("PRINCIPAL_ARCHIVED");
  if (principal && principal.person_id === null) {
    principal = await trx.updateTable("principal").set({
      person_id: person.id, version: sql`version + 1`, updated_at: new Date(),
    }).where("enterprise_id", "=", enterpriseId).where("id", "=", principal.id)
      .returningAll().executeTakeFirstOrThrow();
    changed = true;
  }

  if (run.directory_source_id && item.external_member_id && !identity) {
    const source = await trx.selectFrom("directory_source").select("type")
      .where("enterprise_id", "=", enterpriseId).where("id", "=", run.directory_source_id)
      .executeTakeFirstOrThrow();
    await trx.insertInto("person_external_identity").values({
      enterprise_id: enterpriseId,
      person_id: person.id,
      directory_source_id: run.directory_source_id,
      provider: source.type,
      provider_user_id: item.external_member_id,
      status: "ACTIVE",
      verified_at: new Date(),
    }).execute();
    changed = true;
  }

  const unit = await ensureOrganizationPath(trx, {
    enterpriseId,
    sourceId: run.directory_source_id,
    departmentPath: item.normalized_department_path,
    externalDepartmentId: item.external_department_id,
  });
  changed ||= unit.changed;
  const currentMembership = await trx.selectFrom("organization_membership").selectAll()
    .where("enterprise_id", "=", enterpriseId).where("person_id", "=", person.id)
    .where("is_primary", "=", true).where("valid_until", "is", null)
    .forUpdate().executeTakeFirst();
  if (!currentMembership || currentMembership.organization_unit_id !== unit.id) {
    if (currentMembership) {
      await trx.updateTable("organization_membership").set({
        valid_until: new Date(), version: sql`version + 1`, updated_at: new Date(),
      }).where("id", "=", currentMembership.id).execute();
    }
    await trx.insertInto("organization_membership").values({
      enterprise_id: enterpriseId,
      person_id: person.id,
      organization_unit_id: unit.id,
      is_primary: true,
      source: run.mode === "EXCEL" ? "EXCEL" : (await trx.selectFrom("directory_source")
        .select("type").where("id", "=", run.directory_source_id!).executeTakeFirstOrThrow()).type,
    }).execute();
    changed = true;
  }
  if (principal && principal.department_label !== unit.name) {
    await trx.updateTable("principal").set({
      department_label: unit.name, version: sql`version + 1`, updated_at: new Date(),
    }).where("enterprise_id", "=", enterpriseId).where("id", "=", principal.id).execute();
    changed = true;
  }
  if (principal) {
    await trx.insertInto("principal_access_config_state").values({
      enterprise_id: enterpriseId, principal_id: principal.id, config_version: 1,
    }).onConflict((oc) => oc.doNothing()).execute();
  }

  const outcome: DirectoryImportItemStatus = created ? "CREATED" : changed ? "UPDATED" : "MATCHED";
  await trx.updateTable("directory_import_item").set({
    status: outcome,
    reason_code: null,
    person_id: person.id,
    principal_id: principal?.id ?? null,
    organization_unit_id: unit.id,
    processed_at: new Date(),
    lease_until: null,
    updated_at: new Date(),
  }).where("id", "=", item.id).execute();
  await trx.insertInto("operation_log").values({ actor_source: "SYSTEM",
    enterprise_id: enterpriseId,
    admin_user_id: run.created_by_admin_user_id,
    action: `directory_import_item.${outcome.toLowerCase()}`,
    target_type: "directory_import_item",
    target_id: item.id,
    change_summary: json({
      run_id: run.id, person_id: person.id, principal_id: principal?.id ?? null,
      organization_unit_id: unit.id, outcome,
    }),
    result: "SUCCESS",
    failure_reason: null,
  }).execute();
  return outcome;
}

/**
 * 统一开通事务：为已存在的自然人创建 EMPLOYEE 主体并继承当前生效的全员规则。
 * 幂等：Person 行锁 + 未归档主体检查，重复调用返回现有主体且不重复授权。
 */
export async function activateEmployeePrincipal(
  trx: Transaction<Database>,
  enterpriseId: string,
  personId: string,
  actorAdminUserId: string,
  now: Date = new Date(),
): Promise<{ principalId: string; created: boolean; rulesApplied: number }> {
  const person = await trx.selectFrom("person").selectAll()
    .where("enterprise_id", "=", enterpriseId).where("id", "=", personId)
    .forUpdate().executeTakeFirst();
  if (!person) throw new DirectoryRepositoryError("NOT_FOUND", "通讯录人员不存在");
  const existing = await trx.selectFrom("principal").selectAll()
    .where("enterprise_id", "=", enterpriseId).where("type", "=", "EMPLOYEE")
    .where("person_id", "=", person.id).where("archived_at", "is", null)
    .forUpdate().executeTakeFirst();
  if (existing) return { principalId: existing.id, created: false, rulesApplied: 0 };
  const membership = await trx.selectFrom("organization_membership")
    .innerJoin("organization_unit", (join) => join
      .onRef("organization_unit.enterprise_id", "=", "organization_membership.enterprise_id")
      .onRef("organization_unit.id", "=", "organization_membership.organization_unit_id"))
    .select("organization_unit.name")
    .where("organization_membership.enterprise_id", "=", enterpriseId)
    .where("organization_membership.person_id", "=", person.id)
    .where("organization_membership.is_primary", "=", true)
    .where("organization_membership.valid_until", "is", null)
    .orderBy("organization_membership.valid_from", "desc")
    .executeTakeFirst();
  const principal = await trx.insertInto("principal").values({
    enterprise_id: enterpriseId,
    type: "EMPLOYEE",
    name: person.name,
    department_label: membership?.name ?? person.department_label ?? null,
    person_id: person.id,
    status: "ACTIVE",
  }).returningAll().executeTakeFirstOrThrow();
  await trx.insertInto("principal_access_config_state").values({
    enterprise_id: enterpriseId, principal_id: principal.id, config_version: 1,
  }).onConflict((oc) => oc.doNothing()).execute();
  const rulesApplied = await applyPublishedEmployeeRules(trx, enterpriseId, principal.id, now);
  await trx.insertInto("operation_log").values({
    enterprise_id: enterpriseId,
    admin_user_id: actorAdminUserId,
    action: "principal.activate_employee",
    target_type: "principal",
    target_id: principal.id,
    change_summary: json({ person_id: person.id, rule_assignment_count: rulesApplied }),
    result: "SUCCESS",
    failure_reason: null,
  }).execute();
  return { principalId: principal.id, created: true, rulesApplied };
}

async function recordFailure(
  db: Kysely<Database>, enterpriseId: string, runId: string, itemId: string,
  status: "CONFLICT" | "FAILED", reasonCode: string,
): Promise<DirectoryImportItemStatus | null> {
  return db.transaction().execute(async (trx) => {
    const run = await trx.selectFrom("directory_import_run")
      .select(["created_by_admin_user_id"]).where("enterprise_id", "=", enterpriseId)
      .where("id", "=", runId).executeTakeFirst();
    const item = await trx.selectFrom("directory_import_item").select(["id", "status"])
      .where("enterprise_id", "=", enterpriseId).where("run_id", "=", runId)
      .where("id", "=", itemId).forUpdate().executeTakeFirst();
    if (!run || !item || TERMINAL.has(item.status)) return item?.status ?? null;
    await trx.updateTable("directory_import_item").set({
      status, reason_code: reasonCode, processed_at: new Date(), lease_until: null, updated_at: new Date(),
    }).where("id", "=", item.id).execute();
    await trx.insertInto("operation_log").values({ actor_source: "SYSTEM",
      enterprise_id: enterpriseId,
      admin_user_id: run.created_by_admin_user_id,
      action: "directory_import_item.conflict",
      target_type: "directory_import_item",
      target_id: item.id,
      change_summary: json({ run_id: runId, outcome: status, reason_code: reasonCode }),
      result: status === "FAILED" ? "FAILURE" : "SUCCESS",
      failure_reason: reasonCode,
    }).execute();
    return status;
  });
}

/** 每个 Item 独立短事务；所有异常只落稳定 reason code，不持久化异常正文或 PII。 */
export async function applyDirectoryItem(
  db: Kysely<Database>, enterpriseId: string, runId: string, itemId: string,
): Promise<DirectoryImportItemStatus | null> {
  try {
    return await db.transaction().execute((trx) => applyItemTransaction(trx, enterpriseId, runId, itemId));
  } catch (error) {
    if (error instanceof ItemConflict) {
      return recordFailure(db, enterpriseId, runId, itemId, "CONFLICT", error.reasonCode);
    }
    const constraintConflict = typeof error === "object" && error !== null
      && "code" in error && (error as { code?: string }).code === "23505";
    return recordFailure(
      db, enterpriseId, runId, itemId,
      constraintConflict ? "CONFLICT" : "FAILED",
      constraintConflict ? "CONCURRENT_MATCH_CONFLICT" : "ITEM_APPLY_FAILED",
    );
  }
}
