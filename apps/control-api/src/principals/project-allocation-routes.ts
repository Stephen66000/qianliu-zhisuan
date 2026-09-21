/**
 * 项目归集管理路由（候选 C3；合同 11-WP01-api-schema.md）。
 * /principals 前缀 → principals 模块；写操作要求 operate（方法级守卫）；
 * 企业级完整规则集合读/提交一律 principals operate（P2-2，含 403/404 负例）。
 */
import type { FastifyInstance } from "fastify";
import { canAccess } from "@qianliu/contracts";
import { requireAuth } from "../plugins/auth-guard.js";
import {
  createProjectMembership, listProjectMemberships, reviseProjectMembership,
  reviseProjectAccountingLifecycle,
  getEmployeePolicyOverview, previewPolicyChange, publishProjectIntent,
  MembershipNotFoundError, MembershipOverlapConflictError, MembershipRevisionConflictError,
  AccountingVersionConflictError, AccountingAlreadyEndedError, AccountingEffectiveBeforeStartError,
  AllocationPolicyVersionConflictError, AllocationRuleConflictError,
  PrincipalNotAccessibleError,
} from "@qianliu/database";

interface RouteErrorShape {
  error: string;
  message: string;
  [key: string]: unknown;
}

function errorReply(code: number, payload: RouteErrorShape): { code: number; payload: RouteErrorShape } {
  return { code, payload };
}

/** 仓储错误 → 合同错误码（11 §4）。 */
function mapRepositoryError(error: unknown): { code: number; payload: RouteErrorShape } | null {
  if (error instanceof PrincipalNotAccessibleError) {
    return errorReply(404, { error: "not_found", message: "对象不存在或不可访问" });
  }
  if (error instanceof MembershipOverlapConflictError) {
    return errorReply(400, {
      error: "invalid_interval", message: "参与区间与现有有效区间重叠",
      conflicts: error.conflicts.map((conflict) => ({
        joinedAt: conflict.joinedAt.toISOString(), leftAt: conflict.leftAt?.toISOString() ?? null,
      })),
    });
  }
  if (error instanceof MembershipRevisionConflictError) {
    return errorReply(409, { error: "membership_revision_conflict", message: "参与记录已被修改，请刷新后重试", latestRevision: error.latestRevision });
  }
  if (error instanceof MembershipNotFoundError) {
    return errorReply(404, { error: "not_found", message: "成员关系不存在" });
  }
  if (error instanceof AllocationPolicyVersionConflictError) {
    return errorReply(409, { error: "allocation_policy_conflict", message: "员工规则已被其他管理员修改，请重新预览", latestPolicyVersion: error.latestVersion, retryPreview: true });
  }
  if (error instanceof AllocationRuleConflictError) {
    return errorReply(400, {
      error: error.conflicts.some((conflict) => conflict.kind === "WEIGHT_EXCEEDS_LIMIT") ? "weight_exceeded" : "rule_coverage_invalid",
      message: "规则集合校验未通过",
      conflicts: error.conflicts.map((conflict) => ({
        kind: conflict.kind,
        interval: { from: conflict.interval.from.toISOString(), until: conflict.interval.until?.toISOString() ?? null },
        totalBps: conflict.totalBps ?? null,
        projects: conflict.conflictingProjects ?? null,
      })),
    });
  }
  if (error instanceof AccountingVersionConflictError) {
    return errorReply(409, { error: "accounting_version_conflict", message: "核算配置已被修改，请刷新后重试", latestVersion: error.latestVersion });
  }
  if (error instanceof AccountingAlreadyEndedError) {
    return errorReply(409, { error: "accounting_already_ended", message: "项目核算已结束" });
  }
  if (error instanceof AccountingEffectiveBeforeStartError) {
    return errorReply(400, { error: "invalid_interval", message: "生效时点必须晚于当前核算开始时点" });
  }
  return null;
}

async function writeAudit(app: FastifyInstance, req: { admin?: { enterpriseId: string; adminUserId: string } }, input: {
  action: string; targetType: string; targetId?: string | null; summary?: Record<string, unknown>;
}): Promise<void> {
  await app.auditRepo.write({
    enterprise_id: req.admin!.enterpriseId,
    admin_user_id: req.admin!.adminUserId,
    action: input.action,
    target_type: input.targetType,
    target_id: input.targetId ?? null,
    change_summary: input.summary ?? null,
    result: "SUCCESS",
  });
}

/**
 * 日期输入 → 北京时刻（P3-1）：纯日期按 +08:00 该日零点解析；
 * exclusive=true（退出/结束类边界）转为次日零点，表达"参与/生效至该日结束"。
 */
function parseBoundary(value: string | null | undefined, field: string, exclusive: boolean): Date | null | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) {
      throw new Error(`invalid date: ${field}`);
    }
    const base = new Date(`${value}T00:00:00+08:00`);
    if (!exclusive) return base;
    base.setUTCDate(base.getUTCDate() + 1);
    return base;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`invalid date: ${field}`);
  return parsed;
}

export function registerProjectAllocationRoutes(app: FastifyInstance): void {
  app.get<{ Params: { projectId: string } }>("/principals/:projectId/project-memberships", {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    const query = req.query as { at?: string; from?: string; to?: string; limit?: string; offset?: string };
    try {
      const result = await listProjectMemberships(app.db, {
        enterpriseId: req.admin!.enterpriseId,
        projectId: req.params.projectId,
        at: query.at === undefined ? undefined : new Date(query.at),
        from: query.from === undefined ? undefined : new Date(query.from),
        to: query.to === undefined ? undefined : new Date(query.to),
        limit: Math.min(Math.max(Number(query.limit ?? 25), 1), 100),
        offset: Math.min(Math.max(Number(query.offset ?? 0), 0), 100_000),
      });
      return reply.code(200).send({
        projectId: req.params.projectId,
        rows: result.rows.map((row) => ({
          membershipId: row.membershipId,
          employeePrincipalId: row.employeePrincipalId,
          employeeName: row.employeeName,
          stintIndex: row.stintIndex,
          revision: row.revision,
          status: row.status,
          joinedAt: row.joinedAt.toISOString(),
          leftAt: row.leftAt?.toISOString() ?? null,
          currentWeightBps: row.currentWeightBps,
          weightInterval: row.weightInterval === null ? null : {
            from: row.weightInterval.from.toISOString(),
            until: row.weightInterval.until?.toISOString() ?? null,
          },
          otherProjectsCount: row.otherProjectsCount,
          otherProjectsWeightBps: row.otherProjectsWeightBps,
        })),
        counts: result.counts,
        total: result.total, limit: result.limit, offset: result.offset,
      });
    } catch (error) {
      const mapped = mapRepositoryError(error);
      if (mapped) return reply.code(mapped.code).send(mapped.payload);
      throw error;
    }
  });

  app.post<{ Params: { projectId: string } }>("/principals/:projectId/project-memberships", {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    const body = req.body as {
      employeePrincipalId?: string; joinedAt?: string; leftAt?: string;
      weightBps?: number; weightValidFrom?: string; weightValidUntil?: string;
      expectedPolicyVersion?: number; reason?: string; idempotencyKey?: string;
    };
    if (!body.employeePrincipalId || !body.joinedAt || !body.reason) {
      return reply.code(400).send({ error: "invalid_request", message: "请求参数不合法" });
    }
    try {
      const joinedAt = parseBoundary(body.joinedAt, "joinedAt", false);
      const leftAt = parseBoundary(body.leftAt, "leftAt", true);
      if (joinedAt === undefined || joinedAt === null) {
        return reply.code(400).send({ error: "invalid_interval", message: "joinedAt 不合法" });
      }
      const result = await createProjectMembership(app.db, {
        enterpriseId: req.admin!.enterpriseId,
        projectId: req.params.projectId,
        employeePrincipalId: body.employeePrincipalId,
        joinedAt: joinedAt!,
        leftAt: leftAt ?? null,
        weight: body.weightBps === undefined ? null : {
          weightBps: body.weightBps,
          validFrom: body.weightValidFrom === undefined ? undefined : new Date(body.weightValidFrom),
          validUntil: body.weightValidUntil === undefined ? undefined : new Date(body.weightValidUntil),
        },
        expectedPolicyVersion: body.expectedPolicyVersion ?? null,
        reason: body.reason,
        idempotencyKey: body.idempotencyKey ?? null,
        actorAdminId: req.admin!.adminUserId,
      });
      await writeAudit(app, req, {
        action: "project_allocation.membership.create",
        targetType: "project_membership",
        targetId: result.membershipId,
        summary: {
          projectId: req.params.projectId, employeePrincipalId: body.employeePrincipalId,
          joinedAt: body.joinedAt, leftAt: body.leftAt ?? null,
          weightBps: body.weightBps ?? null, replay: result.replay,
        },
      });
      return reply.code(result.replay ? 200 : 201).send(result);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("invalid date")) {
        return reply.code(400).send({ error: "invalid_interval", message: error.message, field: error.message.split(": ")[1] });
      }
      const mapped = mapRepositoryError(error);
      if (mapped) return reply.code(mapped.code).send(mapped.payload);
      throw error;
    }
  });

  app.post<{ Params: { projectId: string; membershipId: string } }>(
    "/principals/:projectId/project-memberships/:membershipId/revisions",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const body = req.body as {
        expectedRevision?: number; joinedAt?: string; leftAt?: string; reason?: string; idempotencyKey?: string;
      };
      if (body.expectedRevision === undefined || !body.reason) {
        return reply.code(400).send({ error: "invalid_request", message: "请求参数不合法" });
      }
      try {
        const result = await reviseProjectMembership(app.db, {
          enterpriseId: req.admin!.enterpriseId,
          projectId: req.params.projectId,
          membershipId: req.params.membershipId,
          expectedRevision: body.expectedRevision,
          joinedAt: parseBoundary(body.joinedAt, "joinedAt", false) ?? undefined,
          leftAt: parseBoundary(body.leftAt, "leftAt", true) ?? undefined,
          reason: body.reason,
          idempotencyKey: body.idempotencyKey ?? null,
          actorAdminId: req.admin!.adminUserId,
        });
        await writeAudit(app, req, {
          action: "project_allocation.membership.revise",
          targetType: "project_membership",
          targetId: result.membershipId,
          summary: { expectedRevision: body.expectedRevision, joinedAt: body.joinedAt ?? null, leftAt: body.leftAt ?? null, replay: result.replay },
        });
        return reply.code(result.replay ? 200 : 201).send(result);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("invalid date")) {
          return reply.code(400).send({ error: "invalid_interval", message: error.message, field: error.message.split(": ")[1] });
        }
        const mapped = mapRepositoryError(error);
        if (mapped) return reply.code(mapped.code).send(mapped.payload);
        throw error;
      }
    },
  );

  app.post<{ Params: { projectId: string } }>("/principals/:projectId/accounting-lifecycle-revisions", {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    const body = req.body as { effectiveAt?: string; reason?: string; expectedVersion?: number };
    if (!body.effectiveAt || !body.reason || body.expectedVersion === undefined) {
      return reply.code(400).send({ error: "invalid_request", message: "请求参数不合法" });
    }
    try {
      const effectiveAt = parseBoundary(body.effectiveAt, "effectiveAt", false);
      if (effectiveAt === undefined || effectiveAt === null) {
        return reply.code(400).send({ error: "invalid_request", message: "请求参数不合法" });
      }
      const result = await reviseProjectAccountingLifecycle(app.db, {
        enterpriseId: req.admin!.enterpriseId,
        projectId: req.params.projectId,
        effectiveAt: effectiveAt!,
        effectiveAtIsDateOnly: /^\d{4}-\d{2}-\d{2}$/.test(body.effectiveAt),
        reason: body.reason,
        expectedVersion: body.expectedVersion,
        actorAdminId: req.admin!.adminUserId,
      });
      await writeAudit(app, req, {
        action: "project_allocation.lifecycle.revise",
        targetType: "project_accounting_profile",
        targetId: req.params.projectId,
        summary: { mode: result.mode, effectiveAt: body.effectiveAt, affectedEmployees: result.affectedEmployees },
      });
      return reply.code(201).send(result);
    } catch (error) {
      const mapped = mapRepositoryError(error);
      if (mapped) return reply.code(mapped.code).send(mapped.payload);
      throw error;
    }
  });

  // 企业级完整规则集合：读与提交都要求 principals operate（P2-2 负例：403）。
  app.get<{ Params: { employeeId: string } }>("/principals/:employeeId/project-allocation-policy", {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    if (!canAccess(req.admin!.roleCode, req.admin!.permissions, "principals", "operate")) {
      return reply.code(403).send({ error: "permission_denied", message: "需要使用主体操作权限" });
    }
    try {
      const overview = await getEmployeePolicyOverview(app.db, req.admin!.enterpriseId, req.params.employeeId);
      return reply.code(200).send({
      employeePrincipalId: overview.employeePrincipalId,
      currentVersion: overview.currentVersion,
      rules: overview.rules.map((rule) => ({
        ruleId: rule.ruleId,
        policyId: rule.policyId,
        projectPrincipalId: rule.projectPrincipalId,
        membershipId: rule.membershipId,
        membershipRevisionId: rule.membershipRevisionId,
        weightBps: rule.weightBps,
        validFrom: rule.validFrom.toISOString(),
        validUntil: rule.validUntil?.toISOString() ?? null,
      })),
      });
    } catch (error) {
      const mapped = mapRepositoryError(error);
      if (mapped) return reply.code(mapped.code).send(mapped.payload);
      throw error;
    }
  });

  app.post<{ Params: { projectId: string } }>(
    "/principals/:projectId/project-allocation-intents/preview",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const body = req.body as {
        employeePrincipalId?: string; expectedPolicyVersion?: number;
        segments?: Array<{ validFrom?: string; validUntil?: string; weightBps?: number }>;
      };
      if (!body.employeePrincipalId || !Array.isArray(body.segments)) {
        return reply.code(400).send({ error: "invalid_request", message: "请求参数不合法" });
      }
      try {
        const result = await previewPolicyChange(app.db, {
          enterpriseId: req.admin!.enterpriseId,
          employeePrincipalId: body.employeePrincipalId,
          projectPrincipalId: req.params.projectId,
          segments: body.segments.map((segment) => ({
            weightBps: segment.weightBps ?? 0,
            validFrom: new Date(segment.validFrom ?? Date.now()),
            validUntil: segment.validUntil === undefined || segment.validUntil === null ? null : new Date(segment.validUntil),
          })),
          expectedPolicyVersion: body.expectedPolicyVersion ?? null,
        });
        return reply.code(200).send({
          currentVersion: result.currentVersion,
          conflicts: result.conflicts,
          visibleRules: result.visibleRules.map((rule) => ({
            projectPrincipalId: rule.projectPrincipalId,
            weightBps: rule.weightBps,
            validFrom: rule.validFrom.toISOString(),
            validUntil: rule.validUntil?.toISOString() ?? null,
          })),
          hidden: result.hidden,
          segments: result.segments.map((segment) => ({
            weightBps: segment.weightBps,
            validFrom: segment.validFrom.toISOString(),
            validUntil: segment.validUntil?.toISOString() ?? null,
            availableBps: segment.availableBps,
            remainingBps: segment.remainingBps,
          })),
          affectedMonths: result.affectedMonths,
        });
      } catch (error) {
        const mapped = mapRepositoryError(error);
        if (mapped) return reply.code(mapped.code).send(mapped.payload);
        throw error;
      }
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/principals/:projectId/project-allocation-intents/versions",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const body = req.body as {
        employeePrincipalId?: string; expectedPolicyVersion?: number; reason?: string; idempotencyKey?: string;
        segments?: Array<{ validFrom?: string; validUntil?: string | null; weightBps?: number }>;
      };
      if (!body.employeePrincipalId || body.expectedPolicyVersion === undefined || !Array.isArray(body.segments) || !body.reason) {
        return reply.code(400).send({ error: "invalid_request", message: "请求参数不合法" });
      }
      try {
        const outcome = await publishProjectIntent(app.db, {
          enterpriseId: req.admin!.enterpriseId,
          projectId: req.params.projectId,
          employeePrincipalId: body.employeePrincipalId,
          segments: body.segments.map((segment) => ({
            weightBps: segment.weightBps ?? 0,
            validFrom: new Date(segment.validFrom ?? Date.now()),
            validUntil: segment.validUntil === undefined || segment.validUntil === null ? null : new Date(segment.validUntil),
          })),
          expectedPolicyVersion: body.expectedPolicyVersion,
          reason: body.reason,
          idempotencyKey: body.idempotencyKey ?? null,
          actorAdminId: req.admin!.adminUserId,
        });
        await writeAudit(app, req, {
          action: "project_allocation.policy.publish",
          targetType: "employee_project_allocation_policy",
          targetId: body.employeePrincipalId,
          summary: {
            projectId: req.params.projectId, segments: body.segments.length,
            outcome: outcome.outcome, ...(outcome.outcome === "PUBLISHED" ? { version: outcome.version } : {}),
          },
        });
        return reply.code(outcome.outcome === "REPLAY" ? 200 : 201).send(outcome);
      } catch (error) {
        const mapped = mapRepositoryError(error);
        if (mapped) return reply.code(mapped.code).send(mapped.payload);
        throw error;
      }
    },
  );
}
