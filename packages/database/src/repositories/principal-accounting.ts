import { sql, type Kysely, type Transaction } from "kysely";
import { effectivePrincipalDepartment } from "./principal-department-query.js";
import type { Database } from "../kysely.js";

export class PrincipalAccountingError extends Error {
  constructor(
    public code: "NOT_FOUND" | "CONFLICT" | "INVALID",
    message: string,
  ) {
    super(message);
  }
}
type AccountingInput = {
  enterpriseId: string;
  principalId: string;
  adminId: string;
  departmentId?: string;
  departmentName?: string;
  ownerPrincipalId?: string;
  expectedVersion: number;
};
interface Assignment {
  id: string;
  department_id: string | null;
  owner_principal_id: string | null;
  version: number;
  valid_from: Date;
}
export async function readPrincipalAccounting(
  db: Kysely<Database>,
  enterpriseId: string,
  principalId: string,
) {
  const [principal, assignments, departments, employees] = await Promise.all([
    db
      .selectFrom("principal")
      .select(["id", "name", "type", "department_label"])
      .where("enterprise_id", "=", enterpriseId)
      .where("id", "=", principalId)
      .executeTakeFirst(),
    sql<Assignment>`SELECT id,department_id,owner_principal_id,version,valid_from FROM principal_accounting_assignment
      WHERE enterprise_id=${enterpriseId}::uuid AND principal_id=${principalId}::uuid AND valid_until IS NULL`.execute(
      db,
    ),
    db
      .selectFrom("organization_unit")
      .select(["id", "name"])
      .where("enterprise_id", "=", enterpriseId)
      .where("status", "=", "ACTIVE")
      .orderBy("name")
      .execute(),
    db
      .selectFrom("principal")
      .select(["id", "name"])
      .where("enterprise_id", "=", enterpriseId)
      .where("type", "=", "EMPLOYEE")
      .where("archived_at", "is", null)
      .orderBy("name")
      .execute(),
  ]);
  if (!principal) throw new PrincipalAccountingError("NOT_FOUND", "主体不存在");
  const assignment = assignments.rows[0];
  const effective =
    principal.type === "EMPLOYEE"
      ? ((
          await effectivePrincipalDepartment(
            enterpriseId,
            principalId,
            sql`clock_timestamp()`,
          ).execute(db)
        ).rows[0] as { department_id: string; valid_from: Date } | undefined)
      : undefined;
  return {
    principal,
    assignment:
      assignment || effective
        ? {
            departmentId:
              effective?.department_id ?? assignment?.department_id ?? null,
            ownerPrincipalId: assignment?.owner_principal_id ?? null,
            version: assignment?.version ?? 0,
            validFrom: (
              effective?.valid_from ?? assignment!.valid_from
            ).toISOString(),
          }
        : null,
    departments,
    employees,
  };
}
export async function savePrincipalAccounting(
  db: Kysely<Database>,
  input: AccountingInput,
) {
  return db
    .transaction()
    .execute((trx) => savePrincipalAccountingInTransaction(trx, input));
}
export async function savePrincipalAccountingInTransaction(
  trx: Transaction<Database>,
  input: AccountingInput,
) {
  const principal = await trx
    .selectFrom("principal")
    .selectAll()
    .where("enterprise_id", "=", input.enterpriseId)
    .where("id", "=", input.principalId)
    .forUpdate()
    .executeTakeFirst();
  if (!principal || principal.archived_at)
    throw new PrincipalAccountingError("NOT_FOUND", "主体不存在或已归档");
  const current = (
    await sql<Assignment>`SELECT * FROM principal_accounting_assignment WHERE enterprise_id=${input.enterpriseId}::uuid
    AND principal_id=${input.principalId}::uuid AND valid_until IS NULL FOR UPDATE`.execute(
      trx,
    )
  ).rows[0];
  if ((current?.version ?? 0) !== input.expectedVersion)
    throw new PrincipalAccountingError(
      "CONFLICT",
      "归属已被修改，请刷新后重试",
    );
  let departmentId: string | null = null,
    ownerId: string | null = null;
  if (principal.type === "EMPLOYEE") {
    departmentId = await resolveEmployeeDepartment(trx, input);
  } else {
    const owner = input.ownerPrincipalId
      ? await trx
          .selectFrom("principal")
          .select(["id", "department_label"])
          .where("enterprise_id", "=", input.enterpriseId)
          .where("id", "=", input.ownerPrincipalId)
          .where("type", "=", "EMPLOYEE")
          .where("archived_at", "is", null)
          .executeTakeFirst()
      : null;
    if (!owner)
      throw new PrincipalAccountingError(
        "INVALID",
        "项目必须指定系统内的员工为负责人",
      );
    ownerId = owner.id;
    const department = await effectivePrincipalDepartment(
      input.enterpriseId,
      ownerId,
      sql`clock_timestamp()`,
    ).execute(trx);
    if (
      !(department.rows[0] as { department_id: string } | undefined)
        ?.department_id
    ) {
      if (!owner.department_label?.trim())
        throw new PrincipalAccountingError(
          "INVALID",
          "请先在使用主体中补齐负责人的部门",
        );
      await savePrincipalAccountingInTransaction(trx, {
        enterpriseId: input.enterpriseId,
        principalId: owner.id,
        adminId: input.adminId,
        departmentName: owner.department_label,
        expectedVersion: 0,
      });
    }
  }
  const effective =
    principal.type === "EMPLOYEE"
      ? ((
          await effectivePrincipalDepartment(
            input.enterpriseId,
            input.principalId,
            sql`clock_timestamp()`,
          ).execute(trx)
        ).rows[0] as { department_id: string } | undefined)
      : undefined;
  if (
    current &&
    current.department_id === departmentId &&
    current.owner_principal_id === ownerId &&
    (principal.type === "PROJECT" || effective?.department_id === departmentId)
  )
    return { version: current.version };
  const clock = await sql<{
    now: Date;
  }>`SELECT clock_timestamp() AS now`.execute(trx);
  const now = new Date(
    Math.max(
      clock.rows[0]!.now.getTime(),
      (current?.valid_from.getTime() ?? 0) + 1,
    ),
  );
  if (current)
    await sql`UPDATE principal_accounting_assignment SET valid_until=${now} WHERE id=${current.id}::uuid`.execute(
      trx,
    );
  const version = (current?.version ?? 0) + 1;
  await sql`INSERT INTO principal_accounting_assignment(enterprise_id,principal_id,principal_type,department_id,owner_principal_id,version,valid_from,created_by)
    VALUES(${input.enterpriseId}::uuid,${input.principalId}::uuid,${principal.type},${departmentId}::uuid,${ownerId}::uuid,${version},${now},${input.adminId}::uuid)`.execute(
    trx,
  );
  if (departmentId) {
    const department = await trx
      .selectFrom("organization_unit")
      .select("name")
      .where("enterprise_id", "=", input.enterpriseId)
      .where("id", "=", departmentId)
      .executeTakeFirstOrThrow();
    await trx
      .updateTable("principal")
      .set({ department_label: department.name, updated_at: now })
      .where("enterprise_id", "=", input.enterpriseId)
      .where("id", "=", input.principalId)
      .execute();
  }
  await trx
    .insertInto("operation_log")
    .values({
      enterprise_id: input.enterpriseId,
      admin_user_id: input.adminId,
      action: "principal.accounting.update",
      target_type: "principal",
      target_id: input.principalId,
      result: "SUCCESS",
      failure_reason: null,
      change_summary: {
        department_id: departmentId,
        owner_principal_id: ownerId,
        version,
      },
    })
    .execute();
  return { version };
}

async function resolveEmployeeDepartment(
  trx: Transaction<Database>,
  input: AccountingInput,
): Promise<string> {
  let departmentId: string | null = null;
  if (input.departmentId) {
    const department = await trx
      .selectFrom("organization_unit")
      .select("id")
      .where("enterprise_id", "=", input.enterpriseId)
      .where("id", "=", input.departmentId)
      .where("status", "=", "ACTIVE")
      .executeTakeFirst();
    departmentId = department?.id ?? null;
  } else if (input.departmentName?.trim()) {
    const name = input.departmentName.trim();
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`accounting-department:${input.enterpriseId}:${name}`},0))`.execute(
      trx,
    );
    const matches = await trx
      .selectFrom("organization_unit")
      .select("id")
      .where("enterprise_id", "=", input.enterpriseId)
      .where("name", "=", name)
      .where("status", "=", "ACTIVE")
      .execute();
    if (matches.length > 1)
      throw new PrincipalAccountingError(
        "INVALID",
        "有多个同名部门，请从列表选择",
      );
    departmentId =
      matches[0]?.id ??
      (
        await trx
          .insertInto("organization_unit")
          .values({
            enterprise_id: input.enterpriseId,
            name,
            parent_id: null,
            external_source_id: null,
            external_unit_id: null,
          })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id;
  }
  if (!departmentId)
    throw new PrincipalAccountingError("INVALID", "员工必须指定部门");
  return departmentId;
}
