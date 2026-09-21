/**
 * 项目归集仓储共享设施（候选 C3 合同 §3/§5）。
 * 锁模型：员工级 advisory lock（同一员工的参与/权重写事务串行化）与项目级
 * advisory lock（核算生命周期）；生命周期结束批量裁剪多员工规则时按员工 ID
 * 字典序加锁，避免锁序死锁。
 */
import { createHash } from "node:crypto";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type { Database, ProjectMembershipRevisionTable } from "../kysely.js";

export type AllocationDb = Kysely<Database> | Transaction<Database>;

export type AllocationPrincipalType = "EMPLOYEE" | "PROJECT";

export class PrincipalNotAccessibleError extends Error {
  constructor(
    public readonly principalId: string,
    public readonly expectedType: AllocationPrincipalType,
    public readonly reason: "not_found" | "type_mismatch",
  ) {
    // 对外统一不可访问语义；具体原因仅存于服务端错误对象/日志。
    super(`principal ${principalId} not accessible as ${expectedType} (${reason})`);
    this.name = "PrincipalNotAccessibleError";
  }
}

export async function lockEmployeeAllocationScope(
  db: AllocationDb,
  enterpriseId: string,
  employeePrincipalId: string,
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`qianliu:project-allocation:${enterpriseId}:${employeePrincipalId}`}::text, 0::bigint))`
    .execute(db);
}

export async function lockProjectAccountingScope(
  db: AllocationDb,
  enterpriseId: string,
  projectPrincipalId: string,
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`qianliu:project-accounting:${enterpriseId}:${projectPrincipalId}`}::text, 0::bigint))`
    .execute(db);
}

export interface AllocationPrincipalRow {
  id: string;
  type: AllocationPrincipalType;
  name: string;
}

/** 企业边界 + 主体类型校验；不匹配与不存在返回同一错误（A01 统一 404 语义）。 */
export async function resolveAllocationPrincipal(
  db: AllocationDb,
  enterpriseId: string,
  principalId: string,
  expectedType: AllocationPrincipalType,
): Promise<AllocationPrincipalRow> {
  const row = await db.selectFrom("principal")
    .select(["id", "type", "name"])
    .where("id", "=", principalId)
    .where("enterprise_id", "=", enterpriseId)
    .executeTakeFirst();
  if (!row) throw new PrincipalNotAccessibleError(principalId, expectedType, "not_found");
  if (row.type !== expectedType) {
    throw new PrincipalNotAccessibleError(principalId, expectedType, "type_mismatch");
  }
  return { id: row.id, type: row.type, name: row.name };
}

export type ActiveMembershipRevision = Selectable<ProjectMembershipRevisionTable>;

/** 员工全部当前有效参与（ACTIVE 修订，含冗余主体列）。 */
export async function listActiveMembershipRevisions(
  db: AllocationDb,
  enterpriseId: string,
  employeePrincipalId: string,
): Promise<ActiveMembershipRevision[]> {
  const { rows } = await sql<ActiveMembershipRevision>`
    SELECT r.id, r.membership_id, r.enterprise_id, r.project_principal_id, r.employee_principal_id,
           r.revision, r.status, r.joined_at, r.left_at, r.idempotency_key, r.reason,
           r.supersedes_id, r.created_by, r.created_at
    FROM project_membership_revision r
    JOIN project_membership m ON m.id = r.membership_id
    WHERE r.enterprise_id = ${enterpriseId}
      AND m.employee_principal_id = ${employeePrincipalId}
      AND r.status = 'ACTIVE'
    ORDER BY r.joined_at`.execute(db);
  return rows;
}

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function shanghaiYearMonth(value: Date): { year: number; month: number } {
  const shifted = new Date(value.getTime() + SHANGHAI_OFFSET_MS);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1 };
}

function monthStartUtc(year: number, month: number): Date {
  return new Date(Date.UTC(year, month - 1, 1) - SHANGHAI_OFFSET_MS);
}

/**
 * 区间覆盖的北京自然月列表（合同 §2：入账月份口径）。
 * 开放区间以 now 封顶：未来月份的失效由启用登记与补偿扫描推进，不做无界标记。
 */
export function enumerateShanghaiMonths(from: Date, until: Date | null, now: Date): string[] {
  const cap = until !== null && until.getTime() <= now.getTime() ? until : now;
  if (cap.getTime() <= from.getTime()) return [];
  const months: string[] = [];
  let { year, month } = shanghaiYearMonth(from);
  while (months.length < 1200) {
    const start = monthStartUtc(year, month);
    if (start.getTime() >= cap.getTime()) break;
    months.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

/** 推进归集脏代次：同事务 upsert，generation+1。month 为 "YYYY-MM"。 */
export async function markAllocationDirty(
  db: AllocationDb,
  enterpriseId: string,
  months: Iterable<string>,
): Promise<void> {
  for (const month of new Set(months)) {
    await sql`INSERT INTO project_allocation_dirty
      (enterprise_id, period_month, generation, dirty, last_marked_at)
      VALUES (${enterpriseId}, ${`${month}-01`}::date, 1, true, now())
      ON CONFLICT (enterprise_id, period_month)
      DO UPDATE SET generation = project_allocation_dirty.generation + 1,
        dirty = true, last_marked_at = now()`.execute(db);
  }
}

/** 规则集合输入摘要：稳定序列化后 SHA-256。 */
export function allocationInputHash(rules: unknown): string {
  return createHash("sha256").update(JSON.stringify(rules)).digest("hex");
}
