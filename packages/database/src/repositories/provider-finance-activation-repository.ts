import { sql, type Kysely, type Transaction } from "kysely";
import {
  ACTIVATION_CANDIDATE_TTL_SECONDS,
  ACTIVATION_QUIESCENCE_MAX_SECONDS,
  ACTIVATION_QUIESCENCE_MIN_REMAINING_SECONDS,
  canTransitionCandidateStatus,
  evaluateQuiescenceLease,
  sortUsageRepairBaseline,
  type ActivationCandidateStatus,
  type ActivationCurrency,
  type ActivationDecision,
  type ActivationDraft,
  type ProjectedFinanceSummary,
  type QuiescenceEvaluation,
  type UsageRepairBaselineRow,
} from "@qianliu/domain";
import type { Database } from "../kysely.js";
import { loadQuiescenceGate } from "./provider-finance-quiescence.js";
import {
  ProviderFinanceActivationError,
  type ActivationCandidateView,
  type MarkResourceFinanceReadyInput,
  type QuiescenceDrainReport,
  type QuiescenceLeaseRow,
  type RecordActivationCandidateInput,
  type ResourceFinanceStateView,
  type StartQuiescenceInput,
} from "./provider-finance-activation-types.js";

type Executor = Kysely<Database> | Transaction<Database>;

const QUIESCENCE_ACTIONS = {
  start: "provider_finance.activation_quiescence.start",
  release: "provider_finance.activation_quiescence.release",
  expire: "provider_finance.activation_quiescence.expire",
} as const;

function activationTtlSeconds(): number {
  return ACTIVATION_CANDIDATE_TTL_SECONDS;
}

/**
 * 资金账本初始化控制仓储（WP01：候选/幂等/静默租约/资源资金状态）。
 *
 * 约定：所有写方法接受可选 `Transaction<Database>`；
 * WP03 的激活协调器必须在同一个外层事务内调用它们，禁止自行开启新事务。
 * 本仓储不写入任何资金事实，也不参与余额、成本或经营账单查询。
 */
export class ProviderFinanceActivationRepository {
  constructor(protected readonly db: Kysely<Database>) {}

  private executor(trx?: Transaction<Database>): Executor {
    return trx ?? this.db;
  }

  // ===== 候选与激活幂等（PFA-03、PFA-06） =====

  async recordPreviewCandidate(
    input: RecordActivationCandidateInput, trx?: Transaction<Database>,
  ): Promise<ActivationCandidateView> {
    const expiresAt = new Date(input.previewCommittedAt.getTime() + activationTtlSeconds() * 1000);
    const baseline = sortUsageRepairBaseline(input.usageRepairBaseline);
    const row = await this.executor(trx)
      .insertInto("provider_finance_activation_attempt")
      .values({
        enterprise_id: input.enterpriseId,
        candidate_hash: input.candidateHash,
        fact_watermark_hash: input.factWatermarkHash,
        decision: input.decision,
        status: "PREVIEWED",
        // jsonb 数组必须显式 JSON 序列化：pg 驱动会把 JS 数组当作 Postgres 数组字面量。
        gap_summary: JSON.stringify(input.gapSummary) as unknown as Array<{ code: string; count: number }>,
        projection_summary: JSON.stringify(input.projection) as unknown as ProjectedFinanceSummary,
        usage_repair_baseline: JSON.stringify(baseline) as unknown as UsageRepairBaselineRow[],
        // 草稿载荷与候选哈希一起冻结：激活接口不接受草稿，权威来源只能在这里。
        candidate_draft: JSON.stringify(input.candidateDraft) as unknown as ActivationDraft,
        created_by_admin_user_id: input.adminId,
        created_at: input.previewCommittedAt,
        expires_at: expiresAt,
      })
      .returning(["id", "created_at", "expires_at"])
      .executeTakeFirstOrThrow();
    return {
      candidateId: row.id,
      enterpriseId: input.enterpriseId,
      candidateHash: input.candidateHash,
      factWatermarkHash: input.factWatermarkHash,
      decision: input.decision,
      status: "PREVIEWED",
      gaps: input.gapSummary,
      projection: input.projection,
      usageRepairBaseline: baseline,
      candidateDraft: input.candidateDraft,
      createdByAdminUserId: input.adminId,
      createdAt: row.created_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      expired: false,
      activationIdempotencyKey: null,
      activationResult: null,
      activatedByAdminUserId: null,
      activatedAt: null,
    };
  }

  async loadCandidate(
    enterpriseId: string, candidateId: string, trx?: Transaction<Database>,
  ): Promise<ActivationCandidateView | null> {
    const row = await this.executor(trx)
      .selectFrom("provider_finance_activation_attempt")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .where("id", "=", candidateId)
      .executeTakeFirst();
    return row ? this.toCandidateView(row) : null;
  }

  /**
   * 激活协调器专用：以 `FOR UPDATE` 锁定候选行，把「同一候选的并发激活」
   * 串行化在候选行锁上，再叠加企业级咨询锁做跨候选串行化。
   */
  async loadCandidateForUpdate(
    enterpriseId: string, candidateId: string, trx: Transaction<Database>,
  ): Promise<ActivationCandidateView | null> {
    const row = await trx
      .selectFrom("provider_finance_activation_attempt")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .where("id", "=", candidateId)
      .forUpdate()
      .executeTakeFirst();
    return row ? this.toCandidateView(row) : null;
  }

  async loadLatestCandidate(
    enterpriseId: string, trx?: Transaction<Database>,
  ): Promise<ActivationCandidateView | null> {
    const row = await this.executor(trx)
      .selectFrom("provider_finance_activation_attempt")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst();
    return row ? this.toCandidateView(row) : null;
  }

  /** 只读候选是否可用：状态与过期时间同时判定，绝不滑动续期。 */
  assertCandidateUsable(candidate: ActivationCandidateView | null, now: Date): ActivationCandidateView {
    if (!candidate) throw new ProviderFinanceActivationError("CANDIDATE_NOT_FOUND", "候选不存在");
    if (candidate.status === "ACTIVATED") {
      throw new ProviderFinanceActivationError("ALREADY_ACTIVATED", "该候选已经完成激活");
    }
    if (candidate.status !== "PREVIEWED") {
      throw new ProviderFinanceActivationError("CANDIDATE_EXPIRED", "候选已失效，请重新预检");
    }
    if (new Date(candidate.expiresAt).getTime() <= now.getTime()) {
      throw new ProviderFinanceActivationError("CANDIDATE_EXPIRED", "候选已过期，请重新预检");
    }
    return candidate;
  }

  /** 只允许 PREVIEWED → EXPIRED/REJECTED；ACTIVATED 只能由激活事务写入。 */
  async closeCandidate(
    enterpriseId: string, candidateId: string,
    status: Exclude<ActivationCandidateStatus, "PREVIEWED" | "ACTIVATED">,
    trx?: Transaction<Database>,
  ): Promise<void> {
    const current = await this.loadCandidate(enterpriseId, candidateId, trx);
    if (!current) throw new ProviderFinanceActivationError("CANDIDATE_NOT_FOUND", "候选不存在");
    if (current.status !== "PREVIEWED") return;
    if (!canTransitionCandidateStatus("PREVIEWED", status)) {
      throw new ProviderFinanceActivationError("INVALID_REQUEST", "非法候选状态迁移");
    }
    await this.executor(trx)
      .updateTable("provider_finance_activation_attempt")
      .set({ status })
      .where("enterprise_id", "=", enterpriseId)
      .where("id", "=", candidateId)
      .where("status", "=", "PREVIEWED")
      .execute();
  }

  async findActivatedCandidate(
    enterpriseId: string, trx?: Transaction<Database>,
  ): Promise<ActivationCandidateView | null> {
    const row = await this.executor(trx)
      .selectFrom("provider_finance_activation_attempt")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .where("status", "=", "ACTIVATED")
      .orderBy("activated_at", "desc")
      .executeTakeFirst();
    return row ? this.toCandidateView(row) : null;
  }

  async findActivationByIdempotencyKey(
    enterpriseId: string, idempotencyKey: string, trx?: Transaction<Database>,
  ): Promise<ActivationCandidateView | null> {
    const row = await this.executor(trx)
      .selectFrom("provider_finance_activation_attempt")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .where("activation_idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    return row ? this.toCandidateView(row) : null;
  }

  private toCandidateView(row: {
    id: string; enterprise_id: string; candidate_hash: string; fact_watermark_hash: string;
    decision: string; status: string; gap_summary: Array<{ code: string; count: number }>;
    projection_summary: ProjectedFinanceSummary; usage_repair_baseline: UsageRepairBaselineRow[];
    candidate_draft: ActivationDraft;
    created_by_admin_user_id: string; created_at: Date; expires_at: Date;
    activation_idempotency_key: string | null; activation_result: ActivationCandidateView["activationResult"];
    activated_by_admin_user_id: string | null; activated_at: Date | null;
  }): ActivationCandidateView {
    return {
      candidateId: row.id,
      enterpriseId: row.enterprise_id,
      candidateHash: row.candidate_hash,
      factWatermarkHash: row.fact_watermark_hash,
      decision: row.decision as ActivationDecision,
      status: row.status as ActivationCandidateStatus,
      gaps: row.gap_summary,
      projection: row.projection_summary,
      usageRepairBaseline: sortUsageRepairBaseline(row.usage_repair_baseline),
      candidateDraft: row.candidate_draft,
      createdByAdminUserId: row.created_by_admin_user_id,
      createdAt: row.created_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      expired: row.expires_at.getTime() <= Date.now(),
      activationIdempotencyKey: row.activation_idempotency_key,
      activationResult: row.activation_result,
      activatedByAdminUserId: row.activated_by_admin_user_id,
      activatedAt: row.activated_at ? row.activated_at.toISOString() : null,
    };
  }

  // ===== 静默租约（PFA-09） =====

  async startQuiescenceLease(input: StartQuiescenceInput): Promise<QuiescenceLeaseRow> {
    const duration = input.durationSeconds ?? ACTIVATION_QUIESCENCE_MAX_SECONDS;
    if (duration <= 0 || duration > ACTIVATION_QUIESCENCE_MAX_SECONDS) {
      throw new ProviderFinanceActivationError(
        "INVALID_REQUEST", `静默租约时长必须在 1～${ACTIVATION_QUIESCENCE_MAX_SECONDS} 秒之间`);
    }
    const expiresAt = new Date(input.now.getTime() + duration * 1000);
    const row = await this.db.insertInto("provider_finance_activation_quiescence")
      .values({
        enterprise_id: input.enterpriseId,
        status: "ACTIVE",
        started_by_admin_user_id: input.adminId,
        started_at: input.now,
        expires_at: expiresAt,
        released_at: null,
        release_reason: null,
      })
      .onConflict((conflict) => conflict.column("enterprise_id").doUpdateSet({
        status: "ACTIVE",
        started_by_admin_user_id: input.adminId,
        started_at: input.now,
        expires_at: expiresAt,
        released_at: null,
        release_reason: null,
      }))
      .returning(["enterprise_id", "status", "started_by_admin_user_id", "started_at", "expires_at",
        "released_at", "release_reason"])
      .executeTakeFirstOrThrow();
    await this.writeQuiescenceAudit(QUIESCENCE_ACTIONS.start, input.enterpriseId, input.adminId,
      { status: "ACTIVE", started_at: input.now.toISOString(), expires_at: expiresAt.toISOString() });
    return this.toLeaseRow(row);
  }

  async loadQuiescenceLease(
    enterpriseId: string, trx?: Transaction<Database>,
  ): Promise<QuiescenceLeaseRow | null> {
    const row = await this.executor(trx)
      .selectFrom("provider_finance_activation_quiescence")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .executeTakeFirst();
    return row ? this.toLeaseRow(row) : null;
  }

  /**
   * 服务端时间判定租约有效性；已到期租约惰性标记 EXPIRED 并写审计。
   * Gateway admission 与 Worker 必须调用本方法，而不是信任客户端时间。
   */
  async evaluateQuiescence(
    enterpriseId: string, now: Date = new Date(), trx?: Transaction<Database>,
  ): Promise<QuiescenceEvaluation & { lease: QuiescenceLeaseRow | null }> {
    const lease = await this.loadQuiescenceLease(enterpriseId, trx);
    const evaluation = evaluateQuiescenceLease(
      lease ? { status: lease.status, expiresAt: lease.expiresAt } : null,
      now,
      ACTIVATION_QUIESCENCE_MIN_REMAINING_SECONDS,
    );
    if (lease && lease.status === "ACTIVE" && !evaluation.active && !trx) {
      await this.markQuiescenceExpired(enterpriseId, lease, now);
      return { ...evaluation, lease: { ...lease, status: "EXPIRED" } };
    }
    return { ...evaluation, lease };
  }

  /**
   * 只读判定：企业当前是否处于**有效**静默租约内（服务端时间；到期即自动失效）。
   *
   * Control API、Gateway admission 与 Worker 共用 `provider-finance-quiescence.ts`
   * 的同一套判定；本方法只是把它挂到仓储上，方便控制路径复用而不引入第二套时间比较。
   */
  async isEnterpriseQuiescent(
    enterpriseId: string, now: Date = new Date(),
  ): Promise<boolean> {
    return (await loadQuiescenceGate(this.db, enterpriseId, now)).quiescent;
  }

  async markQuiescenceExpired(enterpriseId: string, lease: QuiescenceLeaseRow, now: Date,
  ): Promise<void> {
    await this.db.updateTable("provider_finance_activation_quiescence")
      .set({ status: "EXPIRED" })
      .where("enterprise_id", "=", enterpriseId)
      .where("status", "=", "ACTIVE")
      .where("expires_at", "<=", now)
      .execute();
    await this.writeQuiescenceAudit(QUIESCENCE_ACTIONS.expire, enterpriseId, lease.startedByAdminUserId,
      { status: "EXPIRED", expires_at: lease.expiresAt });
  }

  async releaseQuiescenceLease(
    enterpriseId: string, adminId: string, reason: string, now: Date = new Date(),
  ): Promise<void> {
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      throw new ProviderFinanceActivationError("INVALID_REQUEST", "解除静默租约必须填写原因");
    }
    const updated = await this.db.updateTable("provider_finance_activation_quiescence")
      .set({ status: "RELEASED", released_at: now, release_reason: trimmed })
      .where("enterprise_id", "=", enterpriseId)
      .where("status", "=", "ACTIVE")
      .where("expires_at", ">", now)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows ?? 0) === 0) {
      throw new ProviderFinanceActivationError(
        "INVALID_REQUEST", "静默租约未处于有效状态，无法解除");
    }
    await this.writeQuiescenceAudit(QUIESCENCE_ACTIONS.release, enterpriseId, adminId,
      { status: "RELEASED", released_at: now.toISOString(), release_reason: trimmed });
  }

  private async writeQuiescenceAudit(
    action: string, enterpriseId: string, adminId: string, summary: Record<string, unknown>,
  ): Promise<void> {
    await this.db.insertInto("operation_log").values({
      enterprise_id: enterpriseId,
      admin_user_id: adminId,
      action,
      target_type: "enterprise",
      target_id: enterpriseId,
      change_summary: summary,
      result: "SUCCESS",
      failure_reason: null,
    }).execute();
  }

  private toLeaseRow(row: {
    enterprise_id: string; status: "ACTIVE" | "RELEASED" | "EXPIRED";
    started_by_admin_user_id: string; started_at: Date; expires_at: Date;
    released_at: Date | null; release_reason: string | null;
  }): QuiescenceLeaseRow {
    return {
      enterpriseId: row.enterprise_id,
      status: row.status,
      startedByAdminUserId: row.started_by_admin_user_id,
      startedAt: row.started_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      releasedAt: row.released_at ? row.released_at.toISOString() : null,
      releaseReason: row.release_reason,
    };
  }

  /**
   * 排空证据（PFA-09）。任一计数非零即不得激活。
   *
   * `options.excludeLedgerLineIds` **只**豁免「未结算/未分类 ledger 行」这一个计数，
   * 用来放行**候选已经冻结、并将在同一激活事务内被确定性修复**的四字段历史用量行。
   * 没有这个出口，切换时点之后创建、`settled_at IS NULL` 但已判定可修复的终态行
   * 会被一律当作「在途结算」，使 PFH-04 的四字段修复主路径在生产上不可达。
   *
   * 豁免边界是严格的，调用方（协调器）必须同时满足：
   * - 已经锁定候选行并验证 GO 结论、TTL、候选哈希与事实水位；
   * - 传入的 ID 必须逐字等于候选存档的 `usage_repair_baseline` 主键，
   *   因此预检之后新增的行、以及任何非候选行都拿不到豁免；
   * - `IN_PROGRESS` 请求、未结束 `upstream_attempt`、`PENDING` 交易**永不豁免**：
   *   它们是真正的在途工作，不是"等待确定性修复的历史事实"。
   *
   * 真正的安全网不在本方法：候选复验会逐行比对修复基准哈希，四字段修复原语
   * 还会在 `FOR UPDATE` 之后逐行复验非目标哈希，任何变化都会以 `CANDIDATE_STALE`
   * 让整个事务回滚。
   */
  async collectDrainReport(
    enterpriseId: string, trx?: Transaction<Database>,
    options?: { excludeLedgerLineIds?: readonly string[] },
  ): Promise<QuiescenceDrainReport> {
    const executor = this.executor(trx);
    const exonerated = options?.excludeLedgerLineIds ?? [];
    const inProgress = await executor.selectFrom("ai_request")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("enterprise_id", "=", enterpriseId)
      .where("status", "=", "IN_PROGRESS")
      .executeTakeFirst();
    const openAttempts = await executor.selectFrom("upstream_attempt")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("enterprise_id", "=", enterpriseId)
      .where("finished_at", "is", null)
      .executeTakeFirst();
    // 「未结算/未分类」行的唯一豁免出口。`<> ALL(ARRAY[...]::uuid[])` 必须显式包成数组：
    // `sql.join` 只产出逗号列表（行表达式），直接写 `<> ALL(...)` 会被 PostgreSQL 以 42809 拒绝。
    const exclusion = exonerated.length === 0
      ? sql`true`
      : sql`line.id <> ALL(ARRAY[${sql.join(exonerated.map((id) => sql`${id}::uuid`))}]::uuid[])`;
    const countedUsage = sql<{ count: string }>`
      SELECT COUNT(*)::text AS count FROM ledger_line line
       WHERE line.enterprise_id=${enterpriseId}::uuid
         AND line.api_cost_status IS NULL
         AND line.resource_mode='API'
         AND line.created_at>=${new Date("2026-08-31T16:00:00.000Z")}`;
    const inclusion = exonerated.length === 0
      ? sql`false`
      : sql`line.id = ANY(ARRAY[${sql.join(exonerated.map((id) => sql`${id}::uuid`))}]::uuid[])`;
    const [unpairedUsage, exoneratedUsage] = await Promise.all([
      sql<{ count: string }>`${countedUsage} AND ${exclusion}`.execute(executor),
      sql<{ count: string }>`${countedUsage} AND ${inclusion}`.execute(executor),
    ]);
    const pendingTransactions = await executor.selectFrom("ledger_transaction")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("enterprise_id", "=", enterpriseId)
      .where("status", "=", "PENDING")
      .executeTakeFirst();
    const report: QuiescenceDrainReport = {
      inProgressRequests: Number(inProgress?.count ?? 0),
      openAttempts: Number(openAttempts?.count ?? 0),
      unpairedUsageLines: Number(unpairedUsage.rows[0]?.count ?? 0),
      pendingLedgerTransactions: Number(pendingTransactions?.count ?? 0),
      exoneratedUsageLines: Number(exoneratedUsage.rows[0]?.count ?? 0),
      drained: false,
    };
    report.drained = report.inProgressRequests === 0 && report.openAttempts === 0
      && report.unpairedUsageLines === 0 && report.pendingLedgerTransactions === 0;
    return report;
  }

  // ===== 资源级资金就绪（PFH-07） =====

  async loadResourceFinanceState(
    enterpriseId: string, resourceId: string, trx?: Transaction<Database>,
  ): Promise<ResourceFinanceStateView | null> {
    const row = await this.executor(trx)
      .selectFrom("provider_resource_finance_state")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .where("provider_resource_id", "=", resourceId)
      .executeTakeFirst();
    return row ? {
      resourceId: row.provider_resource_id,
      enterpriseId: row.enterprise_id,
      state: row.state,
      requiredCurrencies: row.required_currencies as ActivationCurrency[],
      readyAt: row.ready_at ? row.ready_at.toISOString() : null,
      readyByAdminUserId: row.ready_by_admin_user_id,
      version: row.version,
    } : null;
  }

  /** 资源是否需要资金门禁：只有显式 PENDING 行才阻止调度（PFH-07）。 */
  async isResourceFinancePending(
    enterpriseId: string, resourceId: string, trx?: Transaction<Database>,
  ): Promise<boolean> {
    const state = await this.loadResourceFinanceState(enterpriseId, resourceId, trx);
    return state?.state === "PENDING";
  }

  /** 资源级资金就绪：PENDING → READY，写入必备币种、就绪时间与管理员。 */
  async markResourceFinanceReady(
    input: MarkResourceFinanceReadyInput, trx?: Transaction<Database>,
  ): Promise<ResourceFinanceStateView> {
    const executor = this.executor(trx);
    const current = await this.loadResourceFinanceState(input.enterpriseId, input.resourceId, trx);
    if (!current) {
      throw new ProviderFinanceActivationError(
        "RESOURCE_FINANCE_NOT_READY", "该资源未纳入资金门禁，无法直接登记就绪");
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
      throw new ProviderFinanceActivationError(
        "RESOURCE_FINANCE_CONFLICT", "资源资金状态已被其他操作修改");
    }
    if (current.state === "READY") {
      return current;
    }
    const currencies = [...new Set(input.requiredCurrencies)].sort();
    if (currencies.length === 0) {
      throw new ProviderFinanceActivationError(
        "RESOURCE_FINANCE_NOT_READY", "资源级就绪必须至少登记一个必要币种账户");
    }
    const row = await executor.updateTable("provider_resource_finance_state")
      .set({
        state: "READY",
        required_currencies: JSON.stringify(currencies) as unknown as ActivationCurrency[],
        ready_at: input.now,
        ready_by_admin_user_id: input.adminId,
        version: current.version + 1,
        updated_at: input.now,
      })
      .where("enterprise_id", "=", input.enterpriseId)
      .where("provider_resource_id", "=", input.resourceId)
      .where("state", "=", "PENDING")
      .where("version", "=", current.version)
      .returning(["provider_resource_id", "enterprise_id", "state", "required_currencies",
        "ready_at", "ready_by_admin_user_id", "version"])
      .executeTakeFirst();
    if (!row) {
      throw new ProviderFinanceActivationError(
        "RESOURCE_FINANCE_CONFLICT", "资源资金状态已被其他操作修改");
    }
    return {
      resourceId: row.provider_resource_id,
      enterpriseId: row.enterprise_id,
      state: row.state,
      requiredCurrencies: row.required_currencies as ActivationCurrency[],
      readyAt: row.ready_at ? row.ready_at.toISOString() : null,
      readyByAdminUserId: row.ready_by_admin_user_id,
      version: row.version,
    };
  }

  /** 企业全部待就绪（PENDING）资源，供预检缺口与运维核对使用。 */
  async listPendingResources(
    enterpriseId: string, trx?: Transaction<Database>,
  ): Promise<ResourceFinanceStateView[]> {
    const rows = await this.executor(trx)
      .selectFrom("provider_resource_finance_state")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .where("state", "=", "PENDING")
      .orderBy("provider_resource_id", "asc")
      .execute();
    return rows.map((row) => ({
      resourceId: row.provider_resource_id,
      enterpriseId: row.enterprise_id,
      state: row.state,
      requiredCurrencies: row.required_currencies as ActivationCurrency[],
      readyAt: row.ready_at ? row.ready_at.toISOString() : null,
      readyByAdminUserId: row.ready_by_admin_user_id,
      version: row.version,
    }));
  }

  /**
   * 激活用资源级就绪提升（PFA-04 步骤 11、PFH-07）。
   *
   * 与 `markResourceFinanceReady` 的区别：后者只允许把**已纳入门禁的 PENDING 行**置为 READY，
   * 用于企业激活后新增的 API 资源；而企业激活本身要为激活范围内的历史 API 资源
   * **建立**就绪行（此前它们不在门禁内，没有行）。
   *
   * 幂等：已是 READY 的行不重复写、不加版本；只在 PENDING/缺失时提升。
   */
  async promoteResourceFinanceReady(
    input: {
      enterpriseId: string; resourceId: string; adminId: string;
      requiredCurrencies: readonly ActivationCurrency[]; now: Date;
    },
    trx: Transaction<Database>,
  ): Promise<void> {
    const currencies = [...new Set(input.requiredCurrencies)].sort();
    const current = await this.loadResourceFinanceState(input.enterpriseId, input.resourceId, trx);
    if (current?.state === "READY") return;
    await sql`
      INSERT INTO provider_resource_finance_state
        (enterprise_id, provider_resource_id, state, required_currencies,
         ready_at, ready_by_admin_user_id, version, created_at, updated_at)
      VALUES (${input.enterpriseId}::uuid, ${input.resourceId}::uuid, 'READY',
              ${JSON.stringify(currencies)}::jsonb, ${input.now}, ${input.adminId}::uuid, 1,
              ${input.now}, ${input.now})
      ON CONFLICT (provider_resource_id) DO UPDATE SET
        state='READY',
        required_currencies=EXCLUDED.required_currencies,
        ready_at=EXCLUDED.ready_at,
        ready_by_admin_user_id=EXCLUDED.ready_by_admin_user_id,
        version=provider_resource_finance_state.version + 1,
        updated_at=EXCLUDED.updated_at
      WHERE provider_resource_finance_state.state='PENDING'
    `.execute(trx);
  }
}
