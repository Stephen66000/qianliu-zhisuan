import { sql, type Kysely, type Transaction } from "kysely";
import type {
  Database,
  DirectoryImportItemStatus,
} from "../kysely.js";
import { activateEmployeePrincipal, applyDirectoryItem } from "./directory-import-apply.js";
import {
  createDirectoryRun,
  directorySourceView,
  upsertDirectorySource,
} from "./directory-repository-source-run.js";
import {
  cleanDirectoryValue as clean,
  DIRECTORY_UUID_PATTERN as UUID_PATTERN,
  directoryDuplicateKeys as duplicateKeys,
  directoryValidationReason as validationReason,
} from "./directory-repository-staging-validation.js";
import {
  DirectoryRepositoryError,
  type CreateDirectoryRunInput,
  type DirectoryImportItem,
  type DirectoryImportRun,
  type DirectoryMemberActivationByListResult,
  type DirectoryMemberActivationResult,
  type DirectoryMemberPage,
  type DirectoryMemberQuery,
  type DirectoryMemberView,
  type DirectorySource,
  type DirectorySourceView,
  type OrganizationUnit,
  type StageDirectoryRunInput,
  type UpsertDirectorySourceInput,
} from "./directory-repository-types.js";

const TERMINAL_RUN = new Set(["SUCCEEDED", "PARTIAL", "FAILED"]);
const ITEM_LIMIT = 1_000;
const ACTIVATION_LIMIT = 1_000;

function json(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.stringify(value) as unknown as Record<string, unknown>;
}

export class DirectoryRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async listOrganizationUnits(
    enterpriseId: string, status: "ACTIVE" | "INACTIVE" | "ALL" = "ACTIVE",
  ): Promise<OrganizationUnit[]> {
    let query = this.db.selectFrom("organization_unit").selectAll()
      .where("enterprise_id", "=", enterpriseId);
    if (status !== "ALL") query = query.where("status", "=", status);
    return query.orderBy("name").orderBy("id").execute();
  }

  async listMembers(enterpriseId: string, input: DirectoryMemberQuery = {}): Promise<DirectoryMemberPage> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const offset = Math.max(input.offset ?? 0, 0);
    const latestIdentity = this.db.selectFrom("person_external_identity")
      .select(["person_id", "provider", "provider_user_id", "updated_at"])
      .where("enterprise_id", "=", enterpriseId).where("status", "=", "ACTIVE")
      .distinctOn("person_id").orderBy("person_id").orderBy("updated_at", "desc")
      .as("latest_identity");
    const latestItem = this.db.selectFrom("directory_import_item")
      .select(["person_id", "status", "reason_code", "normalized_department_path", "updated_at"])
      .where("enterprise_id", "=", enterpriseId).where("person_id", "is not", null)
      .distinctOn("person_id").orderBy("person_id").orderBy("updated_at", "desc")
      .as("latest_item");
    let query = this.db.selectFrom("person")
      .leftJoin("principal", (join) => join
        .onRef("principal.enterprise_id", "=", "person.enterprise_id")
        .onRef("principal.person_id", "=", "person.id").on("principal.type", "=", "EMPLOYEE"))
      .leftJoin("organization_membership", (join) => join
        .onRef("organization_membership.enterprise_id", "=", "person.enterprise_id")
        .onRef("organization_membership.person_id", "=", "person.id")
        .on("organization_membership.is_primary", "=", true)
        .on("organization_membership.valid_until", "is", null))
      .leftJoin("organization_unit", (join) => join
        .onRef("organization_unit.enterprise_id", "=", "person.enterprise_id")
        .onRef("organization_unit.id", "=", "organization_membership.organization_unit_id"))
      .leftJoin("principal_access_config_state", (join) => join
        .onRef("principal_access_config_state.enterprise_id", "=", "person.enterprise_id")
        .onRef("principal_access_config_state.principal_id", "=", "principal.id"))
      .leftJoin("principal_key", (join) => join
        .onRef("principal_key.enterprise_id", "=", "person.enterprise_id")
        .onRef("principal_key.principal_id", "=", "principal.id").on("principal_key.status", "=", "ACTIVE"))
      .leftJoin(latestIdentity, "latest_identity.person_id", "person.id")
      .leftJoin(latestItem, "latest_item.person_id", "person.id")
      .select([
        "person.id as person_id", "person.employee_number", "person.name", "person.email", "person.mobile",
        "person.status as person_status", "principal.id as principal_id", "principal.status as principal_status",
        "organization_unit.id as organization_unit_id", "organization_unit.name as department_name",
        "latest_item.normalized_department_path as department_path", "latest_identity.provider as source_type",
        "latest_identity.provider_user_id as external_member_id",
        "principal_access_config_state.config_version as access_config_version",
        "principal_key.id as active_key_id", "latest_item.status as import_status", "latest_item.reason_code",
        sql<number>`count(*) over()::int`.as("total_count"),
      ]).where("person.enterprise_id", "=", enterpriseId);
    if (input.organizationUnitId) {
      query = query.where("organization_unit.id", "=", input.organizationUnitId);
    }
    if (input.importStatus) query = query.where("latest_item.status", "=", input.importStatus);
    if (input.search?.trim()) {
      const pattern = `%${input.search.trim().toLocaleLowerCase("zh-CN")}%`;
      query = query.where(sql<boolean>`(
        lower(person.name) LIKE ${pattern}
        OR lower(COALESCE(person.employee_number, '')) LIKE ${pattern}
        OR lower(COALESCE(principal.name, '')) LIKE ${pattern}
      )`);
    }
    const rows = await query.orderBy("person.name").orderBy("person.id").limit(limit).offset(offset).execute();
    const members: DirectoryMemberView[] = rows.map(({ active_key_id, total_count: _total, ...row }) => ({
      ...row,
      source_type: row.source_type as "WECOM" | "FEISHU" | null,
      import_status: row.import_status as DirectoryImportItemStatus | null,
      key_state: row.principal_id === null ? null : active_key_id ? "ACTIVE" : "PENDING_FIRST_CLAIM",
      department_path: row.department_path ?? row.department_name,
    }));
    return { members, total: rows[0]?.total_count ?? 0, limit, offset };
  }

  /** A 方式：按 Person ID 批量开通 AI 员工主体；已开通人员幂等跳过。 */
  async activateMembers(
    enterpriseId: string, personIds: string[], actorAdminUserId: string,
  ): Promise<DirectoryMemberActivationResult> {
    const uniqueIds = [...new Set(personIds)];
    if (uniqueIds.length === 0) {
      throw new DirectoryRepositoryError("INVALID_REQUEST", "至少选择一名人员");
    }
    if (uniqueIds.length > ACTIVATION_LIMIT) {
      throw new DirectoryRepositoryError("INVALID_REQUEST", `单次最多开通 ${ACTIVATION_LIMIT} 人`);
    }
    return this.db.transaction().execute(async (trx) => {
      const results = [];
      for (const personId of uniqueIds) {
        const outcome = await activateEmployeePrincipal(trx, enterpriseId, personId, actorAdminUserId);
        results.push({
          personId,
          principalId: outcome.principalId,
          status: outcome.created ? "ACTIVATED" as const : "ALREADY_ACTIVE" as const,
        });
      }
      return {
        activatedCount: results.filter((item) => item.status === "ACTIVATED").length,
        alreadyActiveCount: results.filter((item) => item.status === "ALREADY_ACTIVE").length,
        results,
      };
    });
  }

  /** C 方式：按姓名/工号/企微账号匹配候选库后批量开通；未匹配（含同名歧义）原样返回。 */
  async activateMembersByIdentifiers(
    enterpriseId: string, identifiers: string[], actorAdminUserId: string,
  ): Promise<DirectoryMemberActivationByListResult> {
    const cleaned = [...new Set(identifiers.map((value) => value.trim()).filter(Boolean))];
    if (cleaned.length === 0) {
      throw new DirectoryRepositoryError("INVALID_REQUEST", "名单不能为空");
    }
    if (cleaned.length > ACTIVATION_LIMIT) {
      throw new DirectoryRepositoryError("INVALID_REQUEST", `单次最多开通 ${ACTIVATION_LIMIT} 人`);
    }
    return this.db.transaction().execute(async (trx) => {
      const results = [];
      const notFound: string[] = [];
      for (const identifier of cleaned) {
        const personIds = await matchDirectoryIdentifier(trx, enterpriseId, identifier);
        if (personIds.length !== 1) {
          notFound.push(identifier);
          continue;
        }
        const outcome = await activateEmployeePrincipal(trx, enterpriseId, personIds[0]!, actorAdminUserId);
        results.push({
          personId: personIds[0]!,
          principalId: outcome.principalId,
          status: outcome.created ? "ACTIVATED" as const : "ALREADY_ACTIVE" as const,
        });
      }
      return {
        activatedCount: results.filter((item) => item.status === "ACTIVATED").length,
        alreadyActiveCount: results.filter((item) => item.status === "ALREADY_ACTIVE").length,
        results,
        notFound,
      };
    });
  }

  async listSources(enterpriseId: string): Promise<DirectorySourceView[]> {
    const sources = await this.db.selectFrom("directory_source").selectAll()
      .where("enterprise_id", "=", enterpriseId).orderBy("type").execute();
    return sources.map(directorySourceView);
  }

  async getSource(enterpriseId: string, type: "WECOM" | "FEISHU"): Promise<DirectorySourceView | null> {
    const source = await this.db.selectFrom("directory_source").selectAll()
      .where("enterprise_id", "=", enterpriseId).where("type", "=", type).executeTakeFirst();
    return source ? directorySourceView(source) : null;
  }

  /** Worker 专用：密文只在显式内部方法返回，API 不应调用。 */
  async getSourceForWorker(enterpriseId: string, sourceId: string): Promise<DirectorySource | null> {
    return await this.db.selectFrom("directory_source").selectAll()
      .where("enterprise_id", "=", enterpriseId).where("id", "=", sourceId).executeTakeFirst() ?? null;
  }

  async upsertSource(input: UpsertDirectorySourceInput): Promise<DirectorySourceView> {
    return upsertDirectorySource(this.db, input);
  }

  async createRun(input: CreateDirectoryRunInput): Promise<{ run: DirectoryImportRun; replayed: boolean }> {
    return createDirectoryRun(this.db, input);
  }

  async stageRun(input: StageDirectoryRunInput): Promise<DirectoryImportItem[]> {
    if (input.items.length > ITEM_LIMIT) {
      throw new DirectoryRepositoryError("INVALID_REQUEST", `单次导入最多 ${ITEM_LIMIT} 行`);
    }
    const rowNumbers = input.items.map((item) => item.rowNumber);
    if (new Set(rowNumbers).size !== rowNumbers.length) {
      throw new DirectoryRepositoryError("INVALID_REQUEST", "导入行号重复");
    }
    const duplicateEmployees = duplicateKeys(input.items, "employeeNumber");
    const duplicateExternalIds = duplicateKeys(input.items, "externalMemberId");
    return this.db.transaction().execute(async (trx) => {
      const run = await trx.selectFrom("directory_import_run").selectAll()
        .where("enterprise_id", "=", input.enterpriseId).where("id", "=", input.runId)
        .forUpdate().executeTakeFirst();
      if (!run) throw new DirectoryRepositoryError("NOT_FOUND", "导入批次不存在");
      if (TERMINAL_RUN.has(run.status)) throw new DirectoryRepositoryError("INVALID_STATE", "导入批次已结束");
      const existing = await trx.selectFrom("directory_import_item").selectAll()
        .where("enterprise_id", "=", input.enterpriseId).where("run_id", "=", input.runId)
        .orderBy("row_number").execute();
      if (existing.length > 0) return existing;
      const explicitIds = [...new Set(input.items
        .map((item) => clean(item.existingPrincipalId))
        .filter((id): id is string => Boolean(id && UUID_PATTERN.test(id))))];
      const eligibleExplicitIds = explicitIds.length === 0 ? new Set<string>() : new Set(
        (await trx.selectFrom("principal").select("id")
          .where("enterprise_id", "=", input.enterpriseId)
          .where("type", "=", "EMPLOYEE")
          .where("id", "in", explicitIds).execute()).map((principal) => principal.id),
      );
      const values = input.items.map((item) => {
        const explicitPrincipalId = clean(item.existingPrincipalId);
        // 跨企业／非员工主体不得进入复合外键；当前 Item 标记冲突，其他行继续。
        const explicitConflict = Boolean(
          explicitPrincipalId && UUID_PATTERN.test(explicitPrincipalId)
          && !eligibleExplicitIds.has(explicitPrincipalId),
        );
        const reason = explicitConflict
          ? "EXPLICIT_PRINCIPAL_INVALID"
          : validationReason(run.mode, item, duplicateEmployees, duplicateExternalIds);
        return {
          enterprise_id: input.enterpriseId, run_id: input.runId, row_number: item.rowNumber,
          external_member_id: clean(item.externalMemberId), employee_number: clean(item.employeeNumber),
          normalized_name: clean(item.normalizedName),
          normalized_department_path: clean(item.normalizedDepartmentPath),
          external_department_id: clean(item.externalDepartmentId),
          normalized_email: clean(item.normalizedEmail), normalized_mobile: clean(item.normalizedMobile),
          existing_principal_id: explicitConflict ? null : explicitPrincipalId,
          // 显式主体越界交给 apply 记录逐项冲突审计；稳定 reason code 不含越界对象信息。
          status: explicitConflict ? "STAGED" as const : reason ? "FAILED" as const : "STAGED" as const,
          reason_code: reason,
          processed_at: reason ? new Date() : null,
        };
      });
      const staged = values.length === 0 ? [] : await trx.insertInto("directory_import_item")
        .values(values).returningAll().execute();
      await trx.updateTable("directory_import_run").set({
        job_type: "DIRECTORY_IMPORT_APPLY", status: "QUEUED", total_count: staged.length,
        source_snapshot_id: input.sourceSnapshotId ?? run.source_snapshot_id,
        content_sha256: input.contentSha256 ?? run.content_sha256,
        source_data_at: input.sourceDataAt ?? run.source_data_at,
        lease_until: null, updated_at: new Date(),
      }).where("enterprise_id", "=", input.enterpriseId).where("id", "=", input.runId).execute();
      return staged;
    });
  }

  async getRun(enterpriseId: string, runId: string): Promise<DirectoryImportRun | null> {
    return await this.db.selectFrom("directory_import_run").selectAll()
      .where("enterprise_id", "=", enterpriseId).where("id", "=", runId).executeTakeFirst() ?? null;
  }

  async listRunItems(
    enterpriseId: string, runId: string, limit = 100, offset = 0,
  ): Promise<{ items: DirectoryImportItem[]; total: number }> {
    const bounded = Math.min(Math.max(limit, 1), 500);
    const rows = await this.db.selectFrom("directory_import_item").selectAll()
      .select(sql<number>`count(*) over()::int`.as("page_total"))
      .where("enterprise_id", "=", enterpriseId).where("run_id", "=", runId)
      .orderBy("row_number").limit(bounded).offset(Math.max(offset, 0)).execute();
    return {
      items: rows.map(({ page_total: _pageTotal, ...item }) => item as DirectoryImportItem),
      total: rows[0]?.page_total ?? 0,
    };
  }

  async markRunFailed(enterpriseId: string, runId: string, reasonCode: string): Promise<DirectoryImportRun> {
    return this.db.transaction().execute(async (trx) => {
      const run = await trx.updateTable("directory_import_run").set({
        status: "FAILED", failure_reason_code: reasonCode,
        lease_until: null, completed_at: new Date(), updated_at: new Date(),
      }).where("enterprise_id", "=", enterpriseId).where("id", "=", runId)
        .where("status", "in", ["QUEUED", "RUNNING"]).returningAll().executeTakeFirst();
      if (!run) throw new DirectoryRepositoryError("INVALID_STATE", "导入批次不存在或已结束");
      await trx.insertInto("operation_log").values({
        enterprise_id: enterpriseId, admin_user_id: run.created_by_admin_user_id,
        action: "directory_import_run.failed", target_type: "directory_import_run", target_id: run.id,
        change_summary: json({ reason_code: reasonCode }), result: "FAILURE", failure_reason: reasonCode,
      }).execute();
      return run;
    });
  }

  private async claimRun(enterpriseId: string, runId: string): Promise<DirectoryImportRun> {
    return this.db.transaction().execute(async (trx) => {
      const run = await trx.selectFrom("directory_import_run").selectAll()
        .where("enterprise_id", "=", enterpriseId).where("id", "=", runId)
        .forUpdate().executeTakeFirst();
      if (!run) throw new DirectoryRepositoryError("NOT_FOUND", "导入批次不存在");
      if (TERMINAL_RUN.has(run.status)) return run;
      if (run.job_type !== "DIRECTORY_IMPORT_APPLY") {
        throw new DirectoryRepositoryError("INVALID_STATE", "接口快照尚未完成 staging");
      }
      if (run.status === "RUNNING" && run.lease_until && run.lease_until > new Date()) {
        throw new DirectoryRepositoryError("RUN_BUSY", "导入批次正由其他 Worker 处理");
      }
      if (run.directory_source_id) {
        const source = await trx.selectFrom("directory_source").select("status")
          .where("enterprise_id", "=", enterpriseId).where("id", "=", run.directory_source_id)
          .executeTakeFirst();
        if (!source || source.status !== "ACTIVE") {
          throw new DirectoryRepositoryError("SOURCE_INACTIVE", "通讯录来源未启用");
        }
      }
      return trx.updateTable("directory_import_run").set({
        status: "RUNNING", attempt: sql`attempt + 1`, started_at: run.started_at ?? new Date(),
        lease_until: new Date(Date.now() + 5 * 60_000), updated_at: new Date(),
      }).where("enterprise_id", "=", enterpriseId).where("id", "=", runId)
        .returningAll().executeTakeFirstOrThrow();
    });
  }

  private async recordMissingSourceMembers(run: DirectoryImportRun): Promise<void> {
    if (!run.directory_source_id || run.mode !== "SYNC") return;
    await this.db.transaction().execute(async (trx) => {
      const seen = (await trx.selectFrom("directory_import_item").select("external_member_id")
        .where("enterprise_id", "=", run.enterprise_id).where("run_id", "=", run.id)
        .where("external_member_id", "is not", null).execute()).map((row) => row.external_member_id!);
      let query = trx.selectFrom("person_external_identity").select(["person_id", "provider_user_id"])
        .where("enterprise_id", "=", run.enterprise_id)
        .where("directory_source_id", "=", run.directory_source_id)
        .where("status", "=", "ACTIVE");
      if (seen.length > 0) query = query.where("provider_user_id", "not in", seen);
      const missing = await query.execute();
      if (missing.length === 0) return;
      const maxRow = await trx.selectFrom("directory_import_item")
        .select(sql<number>`COALESCE(max(row_number), 0)::int`.as("value"))
        .where("run_id", "=", run.id).executeTakeFirstOrThrow();
      const principalRows = await trx.selectFrom("principal").select(["id", "person_id"])
        .where("enterprise_id", "=", run.enterprise_id).where("type", "=", "EMPLOYEE")
        .where("person_id", "in", missing.map((row) => row.person_id)).execute();
      const principalByPerson = new Map(principalRows.map((row) => [row.person_id!, row.id]));
      await trx.insertInto("directory_import_item").values(missing.map((identity, index) => ({
        enterprise_id: run.enterprise_id, run_id: run.id, row_number: maxRow.value + index + 1,
        external_member_id: identity.provider_user_id, status: "SKIPPED" as const,
        reason_code: "SOURCE_INACTIVE", person_id: identity.person_id,
        principal_id: principalByPerson.get(identity.person_id) ?? null, processed_at: new Date(),
      }))).execute();
    });
  }

  async applyRun(enterpriseId: string, runId: string): Promise<DirectoryImportRun> {
    const claimed = await this.claimRun(enterpriseId, runId);
    if (TERMINAL_RUN.has(claimed.status)) return claimed;
    const itemIds = (await this.db.selectFrom("directory_import_item").select("id")
      .where("enterprise_id", "=", enterpriseId).where("run_id", "=", runId)
      .where((eb) => eb.or([
        eb("status", "=", "STAGED"),
        eb.and([eb("status", "=", "PROCESSING"), eb.or([
          eb("lease_until", "is", null), eb("lease_until", "<", new Date()),
        ])]),
      ])).orderBy("row_number").execute()).map((row) => row.id);
    for (const itemId of itemIds) {
      await applyDirectoryItem(this.db, enterpriseId, runId, itemId);
      await this.db.updateTable("directory_import_run").set({
        lease_until: new Date(Date.now() + 5 * 60_000), updated_at: new Date(),
      }).where("enterprise_id", "=", enterpriseId).where("id", "=", runId)
        .where("status", "=", "RUNNING").execute();
    }
    await this.recordMissingSourceMembers(claimed);
    return this.db.transaction().execute(async (trx) => {
      const grouped = await trx.selectFrom("directory_import_item")
        .select(["status", sql<number>`count(*)::int`.as("count")])
        .where("enterprise_id", "=", enterpriseId).where("run_id", "=", runId)
        .groupBy("status").execute();
      const counts = new Map(grouped.map((row) => [row.status, row.count]));
      const total = grouped.reduce((sum, row) => sum + row.count, 0);
      const matched = counts.get("MATCHED") ?? 0;
      const created = counts.get("CREATED") ?? 0;
      const updated = counts.get("UPDATED") ?? 0;
      const conflict = counts.get("CONFLICT") ?? 0;
      const skipped = counts.get("SKIPPED") ?? 0;
      const failed = counts.get("FAILED") ?? 0;
      const positive = matched + created + updated;
      const status: "SUCCEEDED" | "PARTIAL" | "FAILED" = conflict + failed === 0
        ? "SUCCEEDED" : positive > 0 ? "PARTIAL" : "FAILED";
      const run = await trx.updateTable("directory_import_run").set({
        status, total_count: total, matched_count: matched, created_count: created,
        updated_count: updated, conflict_count: conflict, skipped_count: skipped,
        failed_count: failed, failure_reason_code: status === "FAILED" ? "NO_ITEM_APPLIED" : null,
        lease_until: null, completed_at: new Date(), updated_at: new Date(),
      }).where("enterprise_id", "=", enterpriseId).where("id", "=", runId)
        .where("status", "=", "RUNNING").returningAll().executeTakeFirstOrThrow();
      await trx.insertInto("operation_log").values({
        enterprise_id: enterpriseId, admin_user_id: run.created_by_admin_user_id,
        action: "directory_import_run.complete", target_type: "directory_import_run", target_id: run.id,
        change_summary: json({
          status, total_count: total, matched_count: matched, created_count: created,
          updated_count: updated, conflict_count: conflict, skipped_count: skipped, failed_count: failed,
        }), result: status === "FAILED" ? "FAILURE" : "SUCCESS",
        failure_reason: status === "FAILED" ? "NO_ITEM_APPLIED" : null,
      }).execute();
      return run;
    });
  }
}

export type {
  CreateDirectoryRunInput,
  DirectoryImportItem,
  DirectoryImportRun,
  DirectoryMemberActivationByListResult,
  DirectoryMemberActivationInput,
  DirectoryMemberActivationItem,
  DirectoryMemberActivationResult,
  DirectoryMemberPage,
  DirectoryMemberQuery,
  DirectoryMemberView,
  DirectorySource,
  DirectorySourceView,
  OrganizationUnit,
  StageDirectoryItemInput,
  StageDirectoryRunInput,
  UpsertDirectorySourceInput,
} from "./directory-repository-types.js";
export { DirectoryRepositoryError } from "./directory-repository-types.js";

/** 精确（忽略大小写）匹配工号 / 企微账号 / 姓名；多条同名视为歧义不开通。 */
async function matchDirectoryIdentifier(
  trx: Transaction<Database>, enterpriseId: string, identifier: string,
): Promise<string[]> {
  const rows = await trx.selectFrom("person").select("person.id")
    .leftJoin("person_external_identity", (join) => join
      .onRef("person_external_identity.enterprise_id", "=", "person.enterprise_id")
      .onRef("person_external_identity.person_id", "=", "person.id")
      .on("person_external_identity.status", "=", "ACTIVE"))
    .where("person.enterprise_id", "=", enterpriseId)
    .where(sql<boolean>`(
      lower(coalesce(person.employee_number, '')) = lower(${identifier})
      OR lower(coalesce(person_external_identity.provider_user_id, '')) = lower(${identifier})
      OR lower(btrim(person.name)) = lower(btrim(${identifier}))
    )`)
    .distinct().execute();
  return rows.map((row) => row.id);
}
