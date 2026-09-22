/**
 * 项目核算生命周期仓储（候选 C3 合同 §3.1；计划 v1.2 §3.1）。
 * 结束成员归集 = 新核算版本落 ended_at：不调用停用主体、不撤 Key；
 * 结束时同一事务按员工 ID 字典序裁剪该项目超出结束时点的权重段。
 */
import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "../kysely.js";
import {
  enumerateShanghaiMonths, lockEmployeeAllocationScope, lockProjectAccountingScope,
  markAllocationDirty, resolveAllocationPrincipal,
} from "./project-allocation-common.js";
import { publishEmployeeRulesInTx, type DesiredRuleInput } from "./employee-allocation-policy-repository.js";

export class AccountingVersionConflictError extends Error {
  constructor(public readonly latestVersion: number) {
    super(`accounting lifecycle version conflict (latest ${latestVersion})`);
    this.name = "AccountingVersionConflictError";
  }
}

export class AccountingAlreadyEndedError extends Error {
  constructor() {
    super("project accounting has already ended");
    this.name = "AccountingAlreadyEndedError";
  }
}

export class AccountingEffectiveBeforeStartError extends Error {
  constructor() {
    super("accounting effective time must be after the current start");
    this.name = "AccountingEffectiveBeforeStartError";
  }
}

export interface ReviseAccountingLifecycleInput {
  enterpriseId: string;
  projectId: string;
  /** 生效时点（日期输入已按 +08:00 该日零点解析）。 */
  effectiveAt: Date;
  /** 输入是纯日期：ENDED 模式按"至该日结束"转次日零点（P3-1）。 */
  effectiveAtIsDateOnly?: boolean;
  reason: string;
  expectedVersion: number;
  actorAdminId: string;
}

export interface AccountingLifecycleResult {
  version: number;
  mode: "STARTED" | "ENDED";
  affectedEmployees: number;
  affectedMonths: string[];
}

export interface ProjectAccountingProfileView {
  version: number;
  startedAt: string;
  endedAt: string | null;
}

/**
 * 当前核算窗口（无配置返回 null）。页面提交生命周期修订前先读该版本作为
 * expectedVersion，避免硬编码 0 对已配置项目必然冲突。
 */
export async function getProjectAccountingProfile(
  db: Kysely<Database>,
  enterpriseId: string,
  projectId: string,
): Promise<ProjectAccountingProfileView | null> {
  const current = await db.selectFrom("project_accounting_profile_version")
    .select(["version", "accounting_started_at", "accounting_ended_at"])
    .where("enterprise_id", "=", enterpriseId)
    .where("project_principal_id", "=", projectId)
    .where("is_current", "=", true)
    .executeTakeFirst();
  if (current === undefined) return null;
  return {
    version: current.version,
    startedAt: current.accounting_started_at.toISOString(),
    endedAt: current.accounting_ended_at?.toISOString() ?? null,
  };
}

/**
 * 核算生命周期修订：无配置 + effectiveAt → 开始；开放中 + effectiveAt → 结束（裁剪权重）。
 * 已结束后再修订拒绝（重启核算属新需求，不在本期合同内）。
 */
export async function reviseProjectAccountingLifecycle(
  db: Kysely<Database>,
  input: ReviseAccountingLifecycleInput,
): Promise<AccountingLifecycleResult> {
  await resolveAllocationPrincipal(db, input.enterpriseId, input.projectId, "PROJECT");
  return db.transaction().execute(async (tx) => {
    await lockProjectAccountingScope(tx, input.enterpriseId, input.projectId);

    const current = await tx.selectFrom("project_accounting_profile_version")
      .selectAll()
      .where("enterprise_id", "=", input.enterpriseId)
      .where("project_principal_id", "=", input.projectId)
      .where("is_current", "=", true)
      .executeTakeFirst();
    const currentVersion = current?.version ?? 0;
    if (currentVersion !== input.expectedVersion) {
      throw new AccountingVersionConflictError(currentVersion);
    }

    let mode: "STARTED" | "ENDED";
    let startedAt: Date;
    let endedAt: Date | null;
    if (!current) {
      mode = "STARTED";
      startedAt = input.effectiveAt;
      endedAt = null;
    } else if (current.accounting_ended_at === null) {
      if (input.effectiveAt.getTime() <= current.accounting_started_at.getTime()) {
        throw new AccountingEffectiveBeforeStartError();
      }
      mode = "ENDED";
      startedAt = current.accounting_started_at;
      endedAt = input.effectiveAt;
      if (input.effectiveAtIsDateOnly === true) {
        const nextDay = new Date(endedAt.getTime() + 24 * 3600_000);
        endedAt = nextDay;
      }
    } else {
      throw new AccountingAlreadyEndedError();
    }

    // 先关旧版本再插新版本（is_current 部分唯一要求窗口内至多一行）。
    if (current) {
      await tx.updateTable("project_accounting_profile_version")
        .set({ is_current: false })
        .where("id", "=", current.id)
        .execute();
    }
    const next = await tx.insertInto("project_accounting_profile_version")
      .values({
        enterprise_id: input.enterpriseId,
        project_principal_id: input.projectId,
        accounting_started_at: startedAt,
        accounting_ended_at: endedAt,
        version: currentVersion + 1,
        is_current: true,
        reason: input.reason,
        created_by: input.actorAdminId,
      })
      .returning(["version"])
      .executeTakeFirstOrThrow();

    const affectedMonths = enumerateShanghaiMonths(
      mode === "ENDED" ? endedAt ?? startedAt : startedAt, null, new Date(),
    );
    const affectedEmployees = mode === "ENDED"
      ? await clipRulesAtAccountingEnd(tx, {
        enterpriseId: input.enterpriseId,
        projectId: input.projectId,
        clipBoundary: endedAt ?? startedAt,
        reason: input.reason,
        actorAdminId: input.actorAdminId,
      })
      : 0;
    await markAllocationDirty(tx, input.enterpriseId, affectedMonths);
    return { version: next.version, mode, affectedEmployees, affectedMonths };
  });
}

/** 结束核算：裁剪所有员工在该项目上超出结束时点的规则段；员工锁按 ID 字典序防死锁。 */
async function clipRulesAtAccountingEnd(
  tx: Transaction<Database>,
  params: {
    enterpriseId: string;
    projectId: string;
    /** 与 profile.accounting_ended_at 完全一致的排他边界（date-only 输入已含 +1 天）。 */
    clipBoundary: Date;
    reason: string;
    actorAdminId: string;
  },
): Promise<number> {
  const { rows: affected } = await sql<{ employee_principal_id: string }>`
    SELECT DISTINCT ru.employee_principal_id
    FROM employee_project_allocation_rule ru
    JOIN employee_project_allocation_policy pol ON pol.id = ru.policy_id
    WHERE pol.enterprise_id = ${params.enterpriseId}
      AND pol.is_current
      AND ru.project_principal_id = ${params.projectId}
      AND (ru.valid_until IS NULL OR ru.valid_until > ${params.clipBoundary})
    ORDER BY ru.employee_principal_id`.execute(tx);
  if (affected.length === 0) return 0;

  for (const row of affected) {
    const employeeId = row.employee_principal_id;
    await lockEmployeeAllocationScope(tx, params.enterpriseId, employeeId);

    const { rows: employeeRules } = await sql<{
      project_principal_id: string; membership_id: string; weight_bps: number;
      valid_from: Date; valid_until: Date | null;
    }>`
      SELECT ru.project_principal_id, ru.membership_id, ru.weight_bps, ru.valid_from, ru.valid_until
      FROM employee_project_allocation_rule ru
      JOIN employee_project_allocation_policy pol ON pol.id = ru.policy_id
      WHERE pol.enterprise_id = ${params.enterpriseId}
        AND pol.employee_principal_id = ${employeeId}
        AND pol.is_current`.execute(tx);

    const desired: DesiredRuleInput[] = [];
    for (const rule of employeeRules) {
      const isThisProject = rule.project_principal_id === params.projectId;
      if (isThisProject) {
        // 超出核算结束时点的段裁剪到结束点；整段落在结束点之前的直接终止。
        const until = rule.valid_until !== null && rule.valid_until.getTime() < params.clipBoundary.getTime()
          ? rule.valid_until
          : params.clipBoundary;
        if (until.getTime() <= rule.valid_from.getTime()) continue;
        desired.push({
          projectPrincipalId: rule.project_principal_id,
          membershipId: rule.membership_id,
          weightBps: rule.weight_bps,
          validFrom: rule.valid_from,
          validUntil: until,
        });
        continue;
      }
      desired.push({
        projectPrincipalId: rule.project_principal_id,
        membershipId: rule.membership_id,
        weightBps: rule.weight_bps,
        validFrom: rule.valid_from,
        validUntil: rule.valid_until,
      });
    }
    await publishEmployeeRulesInTx(tx, {
      enterpriseId: params.enterpriseId,
      employeePrincipalId: employeeId,
      actorAdminId: params.actorAdminId,
      reason: params.reason,
      idempotencyKey: null,
      expectedPolicyVersion: null,
      rules: desired,
    });
  }
  return affected.length;
}
