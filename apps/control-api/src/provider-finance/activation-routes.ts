import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import {
  ProviderFinanceActivationError,
  type ActivationCandidateView,
  type Database,
  type QuiescenceDrainReport,
  type QuiescenceLeaseRow,
  type ReadOnlyCandidateProjection,
} from "@qianliu/database";
import { PROVIDER_FINANCE_CUTOVER_ISO } from "@qianliu/domain";
import { requireAuth } from "../plugins/auth-guard.js";
import {
  ActivationDraftSchema,
  ActivationRequestBody,
  QuiescenceReleaseBody,
  QuiescenceStartBody,
  toActivationDraft,
} from "./activation-contracts.js";

/**
 * 资金账本初始化激活与静默租约接口（WP04 tasks 4.1～4.5；PFA-02～PFA-09、PFU-01～PFU-06）。
 *
 * 权限：路由根 `provider-finance` 已在 `adminRouteModule` 中映射到 `resources` 模块，
 * 因此 `requireAuth` 会按方法自动施加 `resources.view`（GET）与 `resources.operate`（写）。
 * 服务端权限始终是最终门禁（PFU-06）。
 *
 * 身份：企业、管理员、角色、权限**只**来自认证会话（`req.admin`）。请求体不接受
 * `enterprise_id` / `admin_id`，activate 的 `confirm_enterprise_id` 只用于二次防误操作。
 *
 * 模式：`OFF` 时整个资金路由不注册（PFA-08）；`DARK` 时只读与预检仍可用，
 * 但不可逆激活与静默租约变更被停写门禁拒绝——运维停写流程要求"先预检，再恢复 ACTIVE"。
 */

const ACTIVATION_FAILURE_STATUS: Record<string, number> = {
  INVALID_REQUEST: 400,
  CANDIDATE_NOT_FOUND: 404,
  CANDIDATE_EXPIRED: 409,
  CANDIDATE_STALE: 409,
  CANDIDATE_NOT_READY: 409,
  ACTIVATION_IN_PROGRESS: 409,
  ACTIVATION_NOT_QUIESCENT: 409,
  ACTIVATION_RETRY_REQUIRED: 409,
  ALREADY_ACTIVATED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  SESSION_ENTERPRISE_MISMATCH: 409,
  RESOURCE_FINANCE_NOT_READY: 409,
  RESOURCE_FINANCE_CONFLICT: 409,
  // Tx 原语的确定性输入校验失败：重试/重新预检都不改变结果，按请求错误返回。
  FACT_WRITE_INVALID: 400,
};

const FAILURE_AUDIT_ACTIONS = {
  preview: "provider_finance.activation_preview.failure",
  activate: "provider_finance.activation_activate.failure",
} as const;

function invalid(reply: FastifyReply, message = "请求参数不合法") {
  return reply.code(400).send({ error: "invalid_request", message });
}

/**
 * 激活域错误 → HTTP 映射。`retryable` 只在 `ACTIVATION_RETRY_REQUIRED`（序列化失败/死锁）
 * 为 true；本层**不做任何自动重试**（PFA-04、PFA-07 失败关闭）。
 */
function activationFailure(error: unknown, reply: FastifyReply) {
  if (!(error instanceof ProviderFinanceActivationError)) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String(error.code) : null;
    if (code === "23505" || code === "55000" || code === "23514" || code === "P0001") {
      return reply.code(409).send({
        error: "activation_contract_conflict",
        message: "以现有事实无法完成激活，请重新预检",
      });
    }
    throw error;
  }
  const status = ACTIVATION_FAILURE_STATUS[error.code] ?? 400;
  return reply.code(status).send({
    error: error.code.toLowerCase(),
    message: error.message,
    retryable: error.retryable,
    ...(error.detail ? { detail: error.detail } : {}),
  });
}

/**
 * 失败审计（PFA-07、PFU-06）：只记错误码、候选标识与是否可重试，
 * **不得**写入草稿、证据引用、候选哈希以外的业务载荷或任何凭证。
 * 审计写入失败不得掩盖原始错误，因此调用方必须忽略本函数的异常。
 */
async function writeActivationFailureAudit(
  db: Kysely<Database>,
  input: {
    enterpriseId: string; adminId: string; action: string;
    code: string; candidateId?: string | null; retryable?: boolean;
  },
): Promise<void> {
  await db.insertInto("operation_log").values({
    enterprise_id: input.enterpriseId,
    admin_user_id: input.adminId,
    action: input.action,
    target_type: "enterprise",
    target_id: input.enterpriseId,
    change_summary: {
      code: input.code,
      candidate_id: input.candidateId ?? null,
      retryable: input.retryable === true,
    },
    result: "FAILURE",
    failure_reason: input.code,
  }).execute();
}

async function auditSafely(
  db: Kysely<Database>, req: FastifyRequest, action: string,
  code: string, candidateId?: string | null, retryable?: boolean,
): Promise<void> {
  try {
    await writeActivationFailureAudit(db, {
      enterpriseId: req.admin!.enterpriseId, adminId: req.admin!.adminUserId,
      action, code, candidateId, retryable,
    });
  } catch {
    // 审计是证据链补充，不得让原始失败原因丢失。
  }
}

/**
 * 候选元数据脱敏投影（任务 4.1）。
 *
 * 候选行同时保存草稿载荷（0079 `candidate_draft`）——那是不具财务权威性的业务输入，
 * 只在激活事务内部消费。状态接口只返回定位与展示所需的元数据：
 * 候选/水位哈希、结论、状态、时间、创建者、缺口摘要与投影摘要，
 * **不含** `candidate_draft`、证据引用与逐行修复基准。
 */
function candidateMetadata(candidate: ActivationCandidateView) {
  return {
    candidate_id: candidate.candidateId,
    candidate_hash: candidate.candidateHash,
    fact_watermark_hash: candidate.factWatermarkHash,
    decision: candidate.decision,
    status: candidate.status,
    created_at: candidate.createdAt,
    expires_at: candidate.expiresAt,
    expired: candidate.expired,
    created_by_admin_user_id: candidate.createdByAdminUserId,
    gap_summary: candidate.gaps,
    activated_at: candidate.activatedAt,
    activated_by_admin_user_id: candidate.activatedByAdminUserId,
  };
}

/** 激活范围 / 必要账户摘要（任务 4.1）：只来自最近候选存档的投影摘要，不含逐行草稿。 */
function scopeSummary(candidate: ActivationCandidateView | null) {
  if (!candidate) return null;
  const accounts = candidate.projection?.accounts ?? [];
  const required = new Map<string, { resource_id: string; currency: string }>();
  for (const account of accounts) {
    required.set(`${account.resourceId}:${account.currency}`,
      { resource_id: account.resourceId, currency: account.currency });
  }
  return {
    account_count: accounts.length,
    required_accounts: [...required.values()],
    months_checked: candidate.projection?.monthsChecked ?? [],
    token_conserved: candidate.projection?.tokenConserved ?? false,
    coding_plan_usage_attributed: candidate.projection?.codingPlanUsageAttributed ?? false,
    operating_bills_complete: candidate.projection?.operatingBillsComplete ?? false,
    usage_repair_rows: candidate.usageRepairBaseline.length,
  };
}

function drainView(drain: QuiescenceDrainReport) {
  return {
    in_progress_requests: drain.inProgressRequests,
    open_attempts: drain.openAttempts,
    unpaired_usage_lines: drain.unpairedUsageLines,
    pending_ledger_transactions: drain.pendingLedgerTransactions,
    exonerated_usage_lines: drain.exoneratedUsageLines,
    drained: drain.drained,
  };
}

/**
 * 租约行 → HTTP 视图。仓储返回的是领域形状（camelCase），HTTP 面统一用 snake_case，
 * 与 `activation-state` / `activation-preview` 的字段风格保持一致，避免同一个窗口
 * 在启动、查询、解除三处出现两套命名。
 */
function leaseView(lease: QuiescenceLeaseRow | null) {
  if (!lease) return null;
  return {
    status: lease.status,
    started_at: lease.startedAt,
    expires_at: lease.expiresAt,
    started_by_admin_user_id: lease.startedByAdminUserId,
    released_at: lease.releasedAt,
    release_reason: lease.releaseReason,
  };
}

function quiescenceView(
  lease: QuiescenceLeaseRow | null,
  evaluation: { active: boolean; remainingSeconds: number; insufficientForActivation: boolean },
  drain: QuiescenceDrainReport,
) {
  return {
    status: lease?.status ?? null,
    active: evaluation.active,
    started_at: lease?.startedAt ?? null,
    expires_at: lease?.expiresAt ?? null,
    released_at: lease?.releasedAt ?? null,
    release_reason: lease?.releaseReason ?? null,
    remaining_seconds: evaluation.remainingSeconds,
    insufficient_for_activation: evaluation.active && evaluation.insufficientForActivation,
    drain: drainView(drain),
  };
}

/**
 * 预检前的静默门禁（任务 4.2）。分两段：
 *
 * 1. 本函数在调用只读投影**之前**执行：租约有效性 + 剩余时间，以及**永不豁免**的
 *    在途工作（`IN_PROGRESS` 请求、未结束 Attempt、待结算交易）。三者任一非零时
 *    连投影都不必算——PFA-09 明确"排空未完成不得生成候选"。
 * 2. 投影之后的豁免集排空判定由 `previewActivation({ beforePersist })` 完成：
 *    未结算/未分类 `ledger_line` 中，只有候选自己冻结、且将在同一激活事务内被
 *    确定性修复的行才被豁免（与 WP03 协调器同一规则），其余行仍然阻断。
 */
async function assertPrePreviewQuiescent(
  app: FastifyInstance, enterpriseId: string, now: Date,
): Promise<void> {
  const evaluation = await app.providerFinanceActivationRepo.evaluateQuiescence(enterpriseId, now);
  if (!evaluation.active) {
    throw new ProviderFinanceActivationError(
      "ACTIVATION_NOT_QUIESCENT", "企业静默租约未处于有效状态，请先启动静默租约并等待排空");
  }
  if (evaluation.insufficientForActivation) {
    throw new ProviderFinanceActivationError(
      "ACTIVATION_NOT_QUIESCENT", "静默租约剩余时间不足 5 分钟，请重新建立静默期",
      { remainingSeconds: evaluation.remainingSeconds });
  }
  const drain = await app.providerFinanceActivationRepo.collectDrainReport(enterpriseId);
  if (drain.inProgressRequests > 0 || drain.openAttempts > 0
    || drain.pendingLedgerTransactions > 0) {
    throw new ProviderFinanceActivationError(
      "ACTIVATION_NOT_QUIESCENT", "仍存在在途请求、未结束尝试或待结算交易，排空未完成",
      drainView(drain));
  }
}

/** 候选落库前的排空门禁：豁免集严格取自刚刚算出的候选固定修复行集。 */
async function assertDrainedForCandidate(
  app: FastifyInstance, enterpriseId: string, projection: ReadOnlyCandidateProjection,
): Promise<void> {
  const drain = await app.providerFinanceActivationRepo.collectDrainReport(enterpriseId, undefined, {
    excludeLedgerLineIds: projection.usageRepairBaseline.map((row) => row.ledgerLineId),
  });
  if (!drain.drained) {
    throw new ProviderFinanceActivationError(
      "ACTIVATION_NOT_QUIESCENT", "仍存在未结算且不在候选修复范围内的用量行，排空未完成",
      drainView(drain));
  }
}

export function registerProviderFinanceActivationRoutes(
  app: FastifyInstance,
  options: { mode: "DARK" | "ACTIVE" },
): void {
  /**
   * 不可逆写入门禁：`DARK` 停写时**不可逆激活**与静默租约变更不可用（PFA-08）。
   * 预检（`activation-preview`）不在此列——停写恢复流程要求"修复后重新执行完整
   * 预检与业务确认，再恢复 ACTIVE"，且预检不产生任何资金事实。
   */
  const requireWriteEntry = async (_req: FastifyRequest, reply: FastifyReply) => {
    if (options.mode !== "ACTIVE") {
      return reply.code(404).send({ error: "not_found", message: "资金写入口尚未启用" });
    }
  };

  app.get("/provider-finance/activation-state", { preHandler: [requireAuth] }, async (req) => {
    const enterpriseId = req.admin!.enterpriseId;
    const now = new Date();
    const [candidate, activated, runtime, evaluation, drain] = await Promise.all([
      app.providerFinanceActivationRepo.loadLatestCandidate(enterpriseId),
      app.providerFinanceActivationRepo.findActivatedCandidate(enterpriseId),
      app.providerFinanceRepo.isStrictWritesEnabled(enterpriseId),
      app.providerFinanceActivationRepo.evaluateQuiescence(enterpriseId, now),
      app.providerFinanceActivationRepo.collectDrainReport(enterpriseId),
    ]);
    return {
      mode: options.mode,
      cutover_at: PROVIDER_FINANCE_CUTOVER_ISO,
      strict_writes_enabled: runtime,
      scope_summary: scopeSummary(candidate),
      quiescence: quiescenceView(evaluation.lease, evaluation, drain),
      latest_candidate: candidate ? candidateMetadata(candidate) : null,
      activation_receipt: activated?.activationResult ?? null,
      activated_at: activated?.activatedAt ?? null,
      activated_by_admin_user_id: activated?.activatedByAdminUserId ?? null,
    };
  });

  /**
   * 预检不挂 `requireWriteEntry`：DARK 停写期间预检必须保持可用（本文件头部
   * 模式语义、计划 v1.2 §12.2.5 恢复手册——"修复后重新执行完整预检与业务确认，
   * 再恢复 ACTIVE"）。预检只写候选元数据，不产生任何资金事实（PFU-03）。
   */
  app.post("/provider-finance/activation-preview", { preHandler: [requireAuth] },
    async (req, reply) => {
      const body = ActivationDraftSchema.safeParse(req.body);
      if (!body.success) return invalid(reply, body.error.issues[0]?.message);
      const enterpriseId = req.admin!.enterpriseId;
      const draft = toActivationDraft(body.data);
      const now = new Date();
      try {
        await assertPrePreviewQuiescent(app, enterpriseId, now);
        const preview = await app.providerFinanceActivationPreviewRepo.previewActivation({
          enterpriseId, adminId: req.admin!.adminUserId, draft, now,
          beforePersist: (projection) => assertDrainedForCandidate(app, enterpriseId, projection),
        });
        return reply.code(200).send({
          candidate_id: preview.candidateId,
          candidate_hash: preview.candidateHash,
          fact_watermark_hash: preview.factWatermark.hash,
          snapshot_at: preview.snapshotAt,
          preview_committed_at: preview.previewCommittedAt,
          expires_at: preview.expiresAt,
          decision: preview.decision,
          gaps: preview.gaps,
          scope_summary: preview.scopeSummary,
          usage_repairs: preview.usageRepairs,
          projected: preview.projection,
        });
      } catch (error) {
        if (error instanceof ProviderFinanceActivationError) {
          await auditSafely(app.db, req, FAILURE_AUDIT_ACTIONS.preview, error.code, null,
            error.retryable);
        }
        return activationFailure(error, reply);
      }
    });

  app.post("/provider-finance/activate", { preHandler: [requireAuth, requireWriteEntry] },
    async (req, reply) => {
      // 严格 schema：不接受可覆盖会话的 `enterprise_id` / `admin_id`（PFA-07）。
      const parsed = ActivationRequestBody.safeParse(req.body);
      if (!parsed.success) return invalid(reply, parsed.error.issues[0]?.message);
      const input = parsed.data;
      try {
        const outcome = await app.providerFinanceActivationCoordinator.activate({
          // 权威身份只来自会话；confirm 只做二次防误操作匹配（PFA-07）。
          enterpriseId: req.admin!.enterpriseId,
          adminId: req.admin!.adminUserId,
          candidateId: input.candidate_id,
          candidateHash: input.candidate_hash,
          idempotencyKey: input.idempotency_key,
          confirmEnterpriseId: input.confirm_enterprise_id,
        });
        return reply.code(200).send({
          replayed: outcome.replayed,
          candidate_id: outcome.candidateId,
          receipt: outcome.receipt,
        });
      } catch (error) {
        if (error instanceof ProviderFinanceActivationError) {
          await auditSafely(app.db, req, FAILURE_AUDIT_ACTIONS.activate, error.code,
            input.candidate_id, error.retryable);
        }
        return activationFailure(error, reply);
      }
    });

  app.post("/provider-finance/activation-quiescence",
    { preHandler: [requireAuth, requireWriteEntry] }, async (req, reply) => {
      const body = QuiescenceStartBody.safeParse(req.body ?? {});
      if (!body.success) return invalid(reply, body.error.issues[0]?.message);
      try {
        const lease = await app.providerFinanceActivationRepo.startQuiescenceLease({
          enterpriseId: req.admin!.enterpriseId, adminId: req.admin!.adminUserId,
          now: new Date(), durationSeconds: body.data.duration_seconds,
        });
        return reply.code(201).send({ lease: leaseView(lease) });
      } catch (error) { return activationFailure(error, reply); }
    });

  app.get("/provider-finance/activation-quiescence", { preHandler: [requireAuth] },
    async (req) => {
      const enterpriseId = req.admin!.enterpriseId;
      const now = new Date();
      const [evaluation, drain] = await Promise.all([
        app.providerFinanceActivationRepo.evaluateQuiescence(enterpriseId, now),
        app.providerFinanceActivationRepo.collectDrainReport(enterpriseId),
      ]);
      return {
        lease: leaseView(evaluation.lease),
        quiescence: quiescenceView(evaluation.lease, evaluation, drain),
      };
    });

  app.post("/provider-finance/activation-quiescence/release",
    { preHandler: [requireAuth, requireWriteEntry] }, async (req, reply) => {
      const body = QuiescenceReleaseBody.safeParse(req.body);
      if (!body.success) return invalid(reply, body.error.issues[0]?.message);
      try {
        await app.providerFinanceActivationRepo.releaseQuiescenceLease(
          req.admin!.enterpriseId, req.admin!.adminUserId, body.data.reason);
        const lease = await app.providerFinanceActivationRepo
          .loadQuiescenceLease(req.admin!.enterpriseId);
        return reply.code(200).send({ lease: leaseView(lease) });
      } catch (error) { return activationFailure(error, reply); }
    });
}
