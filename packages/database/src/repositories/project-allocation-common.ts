/**
 * 项目归集仓储共享设施（候选 C3 合同 §3/§5）。
 * 锁模型：员工级 advisory lock（同一员工的参与/权重写事务串行化）与项目级
 * advisory lock（核算生命周期）；生命周期结束批量裁剪多员工规则时按员工 ID
 * 字典序加锁，避免锁序死锁。
 */
import { createHash } from "node:crypto";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type { Database, ProjectMembershipRevisionTable } from "../kysely.js";

/** 归集批次的持久化合同版本，由登记、执行与发布共同使用。 */
export const ALLOCATION_SCHEMA_VERSION = "1";
export const ALLOCATION_ALGORITHM_VERSION = "1";

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

/** 指定批次不可用（跨企业/跨账期/非成功或不存在）：对外统一不可访问语义（80 终审 P1-2）。 */
export class AllocationRunNotAccessibleError extends Error {
  constructor(public readonly runId: string, public readonly month: string) {
    super(`allocation run ${runId} not accessible for ${month}`);
    this.name = "AllocationRunNotAccessibleError";
  }
}

/**
 * 归集批次统一解析：显式 run_id 必须是同企业、同路径账期的 SUCCEEDED 批次
 * （允许读取同月历史批次）；否则抛 AllocationRunNotAccessibleError。未指定时取当月 current。
 * 汇总与明细必须复用同一解析结果，避免一个响应混用两个账期/批次。
 */
export async function resolveAllocationRunRef(
  db: AllocationDb,
  enterpriseId: string,
  month: string,
  runId: string | undefined,
): Promise<string | null> {
  if (runId !== undefined) {
    const day = `${month}-01`;
    const row = await db.selectFrom("project_allocation_run")
      .select(["id"])
      .where("id", "=", runId)
      .where("enterprise_id", "=", enterpriseId)
      .where("period_month", "=", day)
      .where("status", "=", "SUCCEEDED")
      .executeTakeFirst();
    if (row === undefined) throw new AllocationRunNotAccessibleError(runId, month);
    return row.id;
  }
  const current = await db.selectFrom("project_allocation_run")
    .select(["id"])
    .where("enterprise_id", "=", enterpriseId)
    .where("period_month", "=", `${month}-01`)
    .where("is_current", "=", true)
    .where("status", "=", "SUCCEEDED")
    .executeTakeFirst();
  return current?.id ?? null;
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

/**
 * 事实写入路径的账期推导（与补偿扫描、account_at 同口径）：
 * finance 严格写开启用 settled_at，否则 created_at，取北京自然月。
 * 供人工指定/归属回填/finance 回填在同一事务内按批去重后标记脏代次。
 */
export async function allocationMonthsForRequests(
  db: AllocationDb,
  enterpriseId: string,
  requestIds: readonly string[],
): Promise<string[]> {
  if (requestIds.length === 0) return [];
  const { rows } = await sql<{ month: string }>`
    WITH finance_state AS (
      SELECT COALESCE((SELECT strict_writes_enabled FROM provider_finance_runtime_state
        WHERE enterprise_id = ${enterpriseId}::uuid), false) AS enabled
    )
    SELECT DISTINCT to_char(
             CASE WHEN finance.enabled THEN ll.settled_at ELSE ll.created_at END
               AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM') AS month
      FROM ledger_line ll CROSS JOIN finance_state finance
     WHERE ll.enterprise_id = ${enterpriseId}::uuid
       AND ll.ai_request_id = ANY(${[...requestIds]}::uuid[])
       AND (CASE WHEN finance.enabled THEN ll.settled_at ELSE ll.created_at END) IS NOT NULL
     ORDER BY month`.execute(db);
  return rows.map((row) => row.month);
}

/** 单时点的北京自然月（"YYYY-MM"）：余量 authority 等按事件时点归月的写入方使用。 */
export function shanghaiMonthOf(value: Date): string {
  const { year, month } = shanghaiYearMonth(value);
  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * 脏代次取整比较。bigint 列经 pg 驱动返回**字符串**（本仓未注册 type parser，
 * Kysely 声明的 number 与运行时不符）：裸比较会退化成字典序，在两位数边界上
 * 方向反转（"10" <= "9" 为真），导致吞标记、登记失效与读模型/闸门不一致（R04 P1）。
 * 所有代次比较必须经此函数。
 */
export function allocationGeneration(value: string | number | bigint | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  return BigInt(value);
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
