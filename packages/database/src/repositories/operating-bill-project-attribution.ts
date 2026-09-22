import type { Kysely } from "kysely";

import type { Database } from "../kysely.js";
import { allocationMonthsForRequests, markAllocationDirty } from "./project-allocation-common.js";
import { markUsageAggregateDirtyForRequest } from "./usage-aggregate-repository.js";

interface ProjectAttributionInput {
  enterpriseId: string;
  adminId: string;
  requestId: string;
  projectPrincipalId: string;
}

interface SourcePrincipal {
  source_principal_id: string;
  person_id: string | null;
}

/** 项目归属修正只追加快照版本，旧归属与已关闭版本不覆盖。 */
export async function appendProjectAttributionCorrection(
  db: Kysely<Database>,
  input: ProjectAttributionInput,
  source: SourcePrincipal,
  requestOccurredAt: Date,
): Promise<void> {
  const previous = await db.selectFrom("request_attribution_snapshot")
    .select(["id", "version", "source_principal_id", "employee_person_id", "request_occurred_at"])
    .where("enterprise_id", "=", input.enterpriseId)
    .where("ai_request_id", "=", input.requestId)
    .orderBy("version", "desc").forUpdate().executeTakeFirst();
  const projectDepartment = await db.selectFrom("project_department_assignment")
    .select("organization_unit_id")
    .where("enterprise_id", "=", input.enterpriseId)
    .where("project_principal_id", "=", input.projectPrincipalId)
    .where("valid_from", "<=", previous?.request_occurred_at ?? requestOccurredAt)
    .where((eb) => eb.or([
      eb("valid_until", "is", null),
      eb("valid_until", ">", previous?.request_occurred_at ?? requestOccurredAt),
    ])).orderBy("valid_from", "desc").executeTakeFirst();

  if (previous) {
    await db.insertInto("request_attribution_snapshot").values({
      enterprise_id: input.enterpriseId, ai_request_id: input.requestId,
      source_principal_id: previous.source_principal_id,
      employee_person_id: previous.employee_person_id,
      project_principal_id: input.projectPrincipalId,
      organization_unit_id: projectDepartment?.organization_unit_id ?? null,
      cost_category: projectDepartment ? "PROJECT" : "UNASSIGNED",
      attribution_source: projectDepartment ? "EMPLOYEE_PROJECT" : "UNASSIGNED",
      request_occurred_at: previous.request_occurred_at,
      version: previous.version + 1, supersedes_id: previous.id,
      snapshot_origin: "CORRECTION",
      reason_code: projectDepartment ? null : "PROJECT_DEPARTMENT_MISSING",
      created_by: input.adminId,
    }).execute();
  } else {
    // 结算应已生成 v1；兼容迁移前数据只在可证明源主体时补修正快照。
    await db.insertInto("request_attribution_snapshot").values({
      enterprise_id: input.enterpriseId, ai_request_id: input.requestId,
      source_principal_id: source.source_principal_id, employee_person_id: source.person_id,
      project_principal_id: input.projectPrincipalId,
      organization_unit_id: projectDepartment?.organization_unit_id ?? null,
      cost_category: projectDepartment ? "PROJECT" : "UNASSIGNED",
      attribution_source: projectDepartment ? "EMPLOYEE_PROJECT" : "UNASSIGNED",
      request_occurred_at: requestOccurredAt, version: 1, snapshot_origin: "CORRECTION",
      reason_code: projectDepartment ? null : "PROJECT_DEPARTMENT_MISSING",
      created_by: input.adminId,
    }).execute();
  }
  await markUsageAggregateDirtyForRequest(db, input.enterpriseId, input.requestId);
  // 人工指定是归集输入事实：同事务按该请求的归属月推进脏代次（账期口径与扫描一致）。
  await markAllocationDirty(
    db, input.enterpriseId,
    await allocationMonthsForRequests(db, input.enterpriseId, [input.requestId]),
  );
}
