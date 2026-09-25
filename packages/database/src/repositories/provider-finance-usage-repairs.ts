import { sql, type Transaction } from "kysely";
import {
  USAGE_REPAIR_FIELDS,
  usageRepairFieldDigests,
  type LedgerLineFactRow,
  type UsageRepairBaselineRow,
  type UsageRepairField,
  type UsageRepairTarget,
} from "@qianliu/domain";
import type { Database } from "../kysely.js";
import { loadLedgerLines } from "./provider-finance-activation-facts.js";
import { ProviderFinanceActivationError } from "./provider-finance-activation-types.js";
import { PROVIDER_FINANCE_CUTOVER } from "./provider-finance-types.js";

/**
 * 历史用量四字段修复原语（WP03 任务 3.2；PFH-04）。
 *
 * 只允许修改 `settled_at` / `api_cost_currency` / `api_cost_status` / `subscription_period_id`。
 *
 * 三条不可动摇的性质：
 * 1. **只锁定候选固定行集**：行集与基准哈希来自候选（`usage_repair_baseline`），
 *    不允许按条件重新挑选行。激活锁定的行集必须与预检确定的行集逐行一致。
 * 2. **按主键排序**：先 `ORDER BY id` 再 `FOR UPDATE`，双管理员并发时行锁顺序一致，
 *    不会互相死锁；预检后新增的行根本不出现在锁定集合里。
 * 3. **逐行非目标哈希复验**：写前写后各算一次 `usageRepairFieldDigests`，
 *    非目标字段有一个字节变化即失败并整体回滚——即"证明其他字段未变化"。
 *
 * 新增行（`newRowsAfterPreview`）只作为事实报告：它不进入原候选的哈希比较，
 * 由完整事实水位与静默门禁负责让旧候选失效。
 */

const TARGET_COLUMNS = {
  settled_at: "settled_at",
  api_cost_currency: "api_cost_currency",
  api_cost_status: "api_cost_status",
  subscription_period_id: "subscription_period_id",
} as const;

/** 与 0059/0060 的 `api_cost_status` 取值域一致；越界值失败关闭而不是让数据库报错。 */
type LedgerCostStatus = "PRICED_USAGE" | "CONFIRMED_ZERO_NO_UPSTREAM" | "UNKNOWN_COST" | "NOT_APPLICABLE";
const LEDGER_COST_STATUSES: readonly LedgerCostStatus[] = [
  "PRICED_USAGE", "CONFIRMED_ZERO_NO_UPSTREAM", "UNKNOWN_COST", "NOT_APPLICABLE",
];

function narrowCostStatus(value: string | null): LedgerCostStatus | null {
  if (value === null) return null;
  if (!(LEDGER_COST_STATUSES as readonly string[]).includes(value)) {
    throw new ProviderFinanceActivationError("INVALID_REQUEST", `非法用量费用状态：${value}`);
  }
  return value as LedgerCostStatus;
}

export interface UsageRepairApplyInput {
  enterpriseId: string;
  /** 候选水位；用于界定「候选之后新增的行」。 */
  snapshotAt: Date;
  /** 候选固定行集（按 ledgerLineId 排序；与 targets 同源同序）。 */
  baseline: readonly UsageRepairBaselineRow[];
  /** 修复目标（与 baseline 同源；`subscriptionPeriodId` 可能是 `draft:<key>`）。 */
  targets: readonly UsageRepairTarget[];
  /** `draft:<key>` → 激活事务内刚写入的真实周期 id。 */
  periodIdByDraftKey?: ReadonlyMap<string, string>;
}

export interface UsageRepairApplyResult {
  appliedRows: number;
  appliedByField: Record<UsageRepairField, number>;
  newRowsAfterPreview: number;
  nonTargetHashMismatches: number;
}

function zeroByField(): Record<UsageRepairField, number> {
  return Object.fromEntries(USAGE_REPAIR_FIELDS.map((field) => [field, 0])) as Record<UsageRepairField, number>;
}

function resolvePeriodId(
  value: string | null, periodIdByDraftKey: ReadonlyMap<string, string> | undefined,
): string | null {
  if (value === null) return null;
  if (!value.startsWith("draft:")) return value;
  const resolved = periodIdByDraftKey?.get(value.slice("draft:".length));
  if (!resolved) {
    throw new ProviderFinanceActivationError(
      "CANDIDATE_STALE", `用量修复引用的虚拟周期 ${value} 在激活事务内未解析为真实周期`);
  }
  return resolved;
}

/** 本轮窗口内、但不在候选固定行集里的用量行数量（事实报告，不参与哈希比较）。 */
async function countNewRowsAfterPreview(
  trx: Transaction<Database>, input: UsageRepairApplyInput,
): Promise<number> {
  const ids = input.targets.map((target) => target.ledgerLineId);
  // `ALL(...)` 的右操作数必须是数组；`sql.join` 只产生逗号列表（(a, b) 是行表达式），
  // 必须显式包成 `ARRAY[...]`，否则 PostgreSQL 报 42809。
  const exclusion = ids.length === 0
    ? sql`true`
    : sql`line.id <> ALL(ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`))}]::uuid[])`;
  const row = await sql<{ count: string }>`
    SELECT count(*)::text AS count FROM ledger_line line
     WHERE line.enterprise_id=${input.enterpriseId}::uuid
       AND COALESCE(line.settled_at,line.created_at)>=${PROVIDER_FINANCE_CUTOVER}
       AND COALESCE(line.settled_at,line.created_at)<=${input.snapshotAt}
       AND ${exclusion}`.execute(trx);
  return Number(row.rows[0]?.count ?? 0);
}

/**
 * 执行四字段修复。调用方必须已持有 `SERIALIZABLE` 外层事务；本函数从不提交。
 * 任一行的非目标哈希不匹配、行集与候选不一致、或修复字段仍被并发改动，都立即抛错整体回滚。
 */
export async function applyUsageRepairsTx(
  trx: Transaction<Database>, input: UsageRepairApplyInput,
): Promise<UsageRepairApplyResult> {
  const baselineById = new Map(input.baseline.map((row) => [row.ledgerLineId, row]));
  const targets = [...input.targets]
    .sort((left, right) => (left.ledgerLineId < right.ledgerLineId ? -1
      : left.ledgerLineId > right.ledgerLineId ? 1 : 0));
  const newRowsAfterPreview = await countNewRowsAfterPreview(trx, input);
  if (targets.length === 0) {
    return { appliedRows: 0, appliedByField: zeroByField(), newRowsAfterPreview, nonTargetHashMismatches: 0 };
  }

  // 候选必须有逐行基准；缺基准绝不允许"顺手修一行"。
  for (const target of targets) {
    if (!baselineById.has(target.ledgerLineId)) {
      throw new ProviderFinanceActivationError(
        "CANDIDATE_STALE", `修复目标 ${target.ledgerLineId} 不在候选固定行集内`);
    }
  }

  const ids = targets.map((target) => target.ledgerLineId);
  // 按主键排序 + FOR UPDATE：锁定集合恰好等于候选行集，且锁序确定。
  const locked = await loadLedgerLines(trx, {
    enterpriseId: input.enterpriseId, snapshotAt: input.snapshotAt,
    ledgerLineIds: ids, forUpdate: true,
  });
  if (locked.length !== ids.length) {
    throw new ProviderFinanceActivationError(
      "CANDIDATE_STALE", `候选固定修复行集在激活期间发生变化（期望 ${ids.length} 行，实际锁定 ${locked.length} 行）`);
  }
  const lockedById = new Map(locked.map((row) => [row.id, row]));

  const appliedByField = zeroByField();
  let appliedRows = 0;
  for (const target of targets) {
    const before = lockedById.get(target.ledgerLineId);
    if (!before) {
      throw new ProviderFinanceActivationError("CANDIDATE_STALE", `用量行 ${target.ledgerLineId} 在激活期间消失`);
    }
    const expected = baselineById.get(target.ledgerLineId)!;
    // 写前复验：非目标字段与目标字段都必须与候选基准一致。
    const beforeDigests = usageRepairFieldDigests(before);
    assertDigestMatches(beforeDigests.nonTargetFieldsBeforeHash, expected.nonTargetFieldsBeforeHash,
      target.ledgerLineId, "非目标字段");
    assertDigestMatches(beforeDigests.targetFieldsBeforeHash, expected.targetFieldsBeforeHash,
      target.ledgerLineId, "目标字段");

    const settledAt = target.settledAt === null ? null : new Date(target.settledAt);
    const subscriptionPeriodId = resolvePeriodId(target.subscriptionPeriodId, input.periodIdByDraftKey);
    const changed = await trx.updateTable("ledger_line")
      .set({
        settled_at: settledAt,
        api_cost_currency: target.apiCostCurrency,
        api_cost_status: narrowCostStatus(target.apiCostStatus),
        subscription_period_id: subscriptionPeriodId,
      })
      .where("enterprise_id", "=", input.enterpriseId)
      .where("id", "=", target.ledgerLineId)
      .executeTakeFirst();
    if (Number(changed.numUpdatedRows ?? 0) !== 1) {
      throw new ProviderFinanceActivationError(
        "CANDIDATE_STALE", `用量行 ${target.ledgerLineId} 在激活期间被其他事务修改`);
    }
    for (const field of expected.eligibleRepairs) appliedByField[field] += 1;
    appliedRows += 1;
  }

  // 写后复验：非目标字段哈希必须逐行不变（PFH-04 的"证明其他字段未变化"）。
  const after = await loadLedgerLines(trx, {
    enterpriseId: input.enterpriseId, snapshotAt: input.snapshotAt, ledgerLineIds: ids,
  });
  let nonTargetHashMismatches = 0;
  const afterById = new Map(after.map((row) => [row.id, row]));
  for (const target of targets) {
    const row = afterById.get(target.ledgerLineId) as LedgerLineFactRow | undefined;
    const expected = baselineById.get(target.ledgerLineId)!;
    if (!row || usageRepairFieldDigests(row).nonTargetFieldsBeforeHash !== expected.nonTargetFieldsBeforeHash) {
      nonTargetHashMismatches += 1;
    }
  }
  if (nonTargetHashMismatches > 0) {
    throw new ProviderFinanceActivationError(
      "CANDIDATE_STALE", `历史用量修复改动了非目标字段（${nonTargetHashMismatches} 行），已整体回滚`,
      { nonTargetHashMismatches });
  }
  return { appliedRows, appliedByField, newRowsAfterPreview, nonTargetHashMismatches };
}

function assertDigestMatches(actual: string, expected: string, ledgerLineId: string, label: string): void {
  if (actual !== expected) {
    throw new ProviderFinanceActivationError(
      "CANDIDATE_STALE", `用量行 ${ledgerLineId} 的${label}在预检后发生变化`, { ledgerLineId });
  }
}

/** 目标字段名 → 数据库列名（供审计摘要与回执使用，避免调用方各写一份）。 */
export function usageRepairColumn(field: UsageRepairField): string {
  return TARGET_COLUMNS[field];
}
