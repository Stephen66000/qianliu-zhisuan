import { sql, type Transaction } from "kysely";
import {
  computeCandidateHash,
  normalizeDraftItem,
  projectActivationCandidate,
  summarizeActivationGaps,
  type ActivationDraft,
  type ActivationGap,
  type ActivationReceipt,
  type NormalizedActivationCandidate,
  type ProjectedFinanceSummary,
  type ActivationProjectionResult,
} from "@qianliu/domain";
import type { Database } from "../kysely.js";
import {
  buildFactWatermark, loadActivationScope, loadProjectionFacts,
  type ActivationScope,
} from "./provider-finance-activation-facts.js";
import { ProviderFinanceActivationRepository } from "./provider-finance-activation-repository.js";
import {
  ProviderFinanceActivationError, type ActivationCandidateView,
} from "./provider-finance-activation-types.js";
import {
  closeLegacyPurchaseTx, insertCarryoverPeriodTx, insertOpeningBalanceTx, insertRechargeTx,
  insertSubscriptionTx, legacySourceMarker, writeActivationAuditTx,
} from "./provider-finance-activation-writes.js";
import { applyUsageRepairsTx, type UsageRepairApplyResult } from "./provider-finance-usage-repairs.js";
import { ProviderFinanceError, type FinanceCurrency } from "./provider-finance-types.js";

/**
 * 企业级原子激活协调器（WP03 任务 3.3、3.4；design §7）。
 *
 * 事务边界只有一处：`activate()` 里那一个 `SERIALIZABLE` 事务。
 * 内部全部通过 3.1/3.2 的 Tx 原语落库，因此不存在"被调用方法自行开事务"的裂口。
 *
 * 顺序（design §7）：
 *  1. 校验会话企业二次确认；
 *  2. 先 try 取 legacy 命名空间锁，再 try 取 v1 64 位命名空间锁，任一失败立即
 *     `409 ACTIVATION_IN_PROGRESS`，**不排队等待**；
 *  3. 幂等重放（同键同候选直接返回首次回执）；
 *  4. 锁候选行并校验状态、TTL、候选哈希、GO 结论、未激活；
 *  5. 校验静默租约有效且剩余 ≥5 分钟；
 *  6. 锁内重算事实水位与候选投影，水位不一致立即 `CANDIDATE_STALE`；
 *  7. 排空门禁：豁免**候选已冻结**的固定修复行，其余未结算/未分类行与在途工作一律拒绝；
 *  8. 写入期初、充值、购买、跨切换周期；
 *  9. 关闭旧购买记录；
 * 10. 按固定主键集修复四字段并逐行复验非目标哈希；
 * 11. 对**真实事实**重跑完整窗口守恒（不再携带草稿虚拟事实）；
 * 12. 写入严格写激活、范围资源 READY、候选 `PREVIEWED → ACTIVATED` 与不可变回执 + 审计；
 * 13. 提交。
 *
 * 第 7 步刻意排在第 6 步之后（而不是紧随租约门禁）：豁免集取自候选存档的
 * `usage_repair_baseline`，只有候选行已经 `FOR UPDATE` 锁定、GO 结论 / TTL /
 * 候选哈希 / 完整事实水位全部验证通过之后，这个集合才可信；否则陈旧候选就能
 * 拿一份过期的行集当"免检通行证"绕过排空门禁。
 *
 * 全程不写 `ACTIVATING`：进程在提交前退出时事务回滚，候选保持 `PREVIEWED`。
 * `40001/40P01` 在 `transaction.execute` 之外统一映射为 `409 ACTIVATION_RETRY_REQUIRED`，
 * 协调器、仓储与 HTTP 层均**零次自动重试**。
 */

/** 与既有 `activateStrictWrites` 完全一致的 legacy 命名空间（旧→新锁序要求）。 */
const LEGACY_ACTIVATION_LOCK_NAMESPACE = "provider-finance-activation:";
/** 专用 64 位命名空间（PFA-05）。 */
const V1_ACTIVATION_LOCK_NAMESPACE = "qianliu:provider-finance-activation:v1:";

/** 旧购买记录关闭属于"决定"而非资金事实，其缺口由本事务的关闭审计独立保证。 */
const LEGACY_CLOSURE_CATEGORY = "LEGACY_RECORD";

export interface ActivateInput {
  /** 会话企业（PFA-07：来自认证会话，不来自请求体）。 */
  enterpriseId: string;
  adminId: string;
  candidateId: string;
  candidateHash: string;
  idempotencyKey: string;
  /** 二次防误操作确认；与会话企业不一致时拒绝（PFA-07）。 */
  confirmEnterpriseId: string;
  /**
   * 候选草稿**交叉校验**输入，可选。
   *
   * 权威草稿来自候选存档（`candidate_draft`，0079）：Control API 的 activate 合同
   * 只接受 `candidate_id / candidate_hash / idempotency_key / confirm_enterprise_id`，
   * 不接受草稿。若调用方仍显式传入草稿（例如数据库层测试或离线工具），
   * 它必须与存档草稿**逐字规范化后一致**，否则以 `CANDIDATE_STALE` 失败关闭——
   * 绝不接受"调用方说的草稿"覆盖存档事实。
   */
  draft?: ActivationDraft;
  /** 仅用于测试与复现：固定"当前时间"。 */
  now?: Date;
}

export interface ActivationOutcome {
  candidateId: string;
  receipt: ActivationReceipt;
  /** 提交成功但响应丢失时，同键同候选重放为 true。 */
  replayed: boolean;
}

interface ReverifiedCandidate {
  scope: ActivationScope;
  candidate: NormalizedActivationCandidate;
  projection: ActivationProjectionResult;
  projected: ProjectedFinanceSummary;
}

interface DraftWriteCounts {
  openings: number;
  recharges: number;
  purchases: number;
  carryovers: number;
  legacyResolutions: number;
  periodIdByDraftKey: Map<string, string>;
}

export class ProviderFinanceActivationCoordinator extends ProviderFinanceActivationRepository {
  /**
   * 激活入口。唯一的 `SERIALIZABLE` 事务边界。
   *
   * 用 `try/catch` 包住整个 `transaction.execute(...)` 调用来做故障映射；
   * 这里**没有**重试循环——`ACTIVATION_RETRY_REQUIRED` 必须回到管理员手里。
   */
  async activate(input: ActivateInput): Promise<ActivationOutcome> {
    try {
      return await this.db.transaction().setIsolationLevel("serializable")
        .execute((trx) => this.runActivation(trx, input));
    } catch (error) {
      throw mapActivationFailure(error);
    }
  }

  private async runActivation(
    trx: Transaction<Database>, input: ActivateInput,
  ): Promise<ActivationOutcome> {
    const now = input.now ?? new Date();
    this.assertSessionEnterprise(input);
    await this.acquireActivationLocks(trx, input.enterpriseId);

    const replayed = await this.replayActivation(trx, input);
    if (replayed) return replayed;

    const candidate = await this.validateCandidate(trx, input, now);
    await this.assertQuiescent(trx, input.enterpriseId, now);
    const reverified = await this.reverifyCandidate(trx, input, candidate, now);
    // 排空门禁必须晚于候选复验：只有此时候选固定修复行集才是可信的豁免依据。
    await this.assertDrained(trx, input.enterpriseId, candidate);

    const writes = await this.writeDraftFacts(trx, input, candidate, reverified);
    const repairs = await this.applyCandidateRepairs(trx, input, candidate, reverified, writes);
    const conservation = await this.assertRealFactConservation(trx, input, reverified, now);

    const receipt = await this.commitActivation(trx, input, candidate, reverified, writes, repairs,
      conservation, now);
    return { candidateId: candidate.candidateId, receipt, replayed: false };
  }

  // ===== 步骤 1～3：会话、锁、幂等重放 =====

  private assertSessionEnterprise(input: ActivateInput): void {
    if (input.confirmEnterpriseId !== input.enterpriseId) {
      throw new ProviderFinanceActivationError(
        "SESSION_ENTERPRISE_MISMATCH", "企业二次确认与会话企业不一致");
    }
  }

  /**
   * 先 legacy 后 v1 的 `try` 锁序（PFA-05）。
   *
   * 旧路径 `activateStrictWrites` 用 legacy 命名空间做排他；本协调器必须与它互斥，
   * 否则"旧的单月激活"会在新激活事务中途插进来。两者都用 `try` 版本，
   * 取不到立即失败，绝不等待。
   */
  private async acquireActivationLocks(trx: Transaction<Database>, enterpriseId: string): Promise<void> {
    const legacy = await tryAdvisoryLock(trx, `${LEGACY_ACTIVATION_LOCK_NAMESPACE}${enterpriseId}`);
    if (!legacy) {
      throw new ProviderFinanceActivationError(
        "ACTIVATION_IN_PROGRESS", "该企业已有资金激活流程在进行中（legacy 锁）", null, true);
    }
    const v1 = await tryAdvisoryLock(trx, `${V1_ACTIVATION_LOCK_NAMESPACE}${enterpriseId}`);
    if (!v1) {
      throw new ProviderFinanceActivationError(
        "ACTIVATION_IN_PROGRESS", "该企业已有资金激活流程在进行中", null, true);
    }
  }

  /** 同键同候选 → 首次回执重放；同键不同候选 → `IDEMPOTENCY_CONFLICT`。 */
  private async replayActivation(
    trx: Transaction<Database>, input: ActivateInput,
  ): Promise<ActivationOutcome | null> {
    const prior = await this.findActivationByIdempotencyKey(input.enterpriseId, input.idempotencyKey, trx);
    if (!prior || prior.status !== "ACTIVATED") return null;
    if (prior.candidateId !== input.candidateId || prior.candidateHash !== input.candidateHash) {
      throw new ProviderFinanceActivationError(
        "IDEMPOTENCY_CONFLICT", "该激活幂等键已绑定其他候选或候选哈希",
        { boundCandidateId: prior.candidateId, boundCandidateHash: prior.candidateHash });
    }
    if (!prior.activationResult || !prior.activatedAt) {
      throw new ProviderFinanceActivationError("ALREADY_ACTIVATED", "该候选已激活但回执缺失");
    }
    return { candidateId: prior.candidateId, receipt: prior.activationResult, replayed: true };
  }

  // ===== 步骤 4：候选复验 =====

  private async validateCandidate(
    trx: Transaction<Database>, input: ActivateInput, now: Date,
  ): Promise<ActivationCandidateView> {
    const candidate = await this.loadCandidateForUpdate(input.enterpriseId, input.candidateId, trx);
    if (!candidate) {
      throw new ProviderFinanceActivationError("CANDIDATE_NOT_FOUND", "候选不存在");
    }
    // 过期与终态判定集中在基座仓储，避免两处各写一遍状态机。
    this.assertCandidateUsable(candidate, now);
    if (candidate.decision !== "GO_CANDIDATE") {
      throw new ProviderFinanceActivationError(
        "CANDIDATE_NOT_READY", "候选预检结论不是 GO_CANDIDATE，不能激活", { gaps: candidate.gaps });
    }
    if (candidate.candidateHash !== input.candidateHash) {
      throw new ProviderFinanceActivationError(
        "CANDIDATE_STALE", "提交的候选哈希与候选存档不一致", { stored: candidate.candidateHash });
    }
    const activated = await this.findActivatedCandidate(input.enterpriseId, trx);
    if (activated) {
      throw new ProviderFinanceActivationError(
        "ALREADY_ACTIVATED", "该企业已由其他候选完成严格资金写激活",
        { activatedCandidateId: activated.candidateId });
    }
    const runtime = await sql<{ strict_writes_enabled: boolean }>`
      SELECT strict_writes_enabled FROM provider_finance_runtime_state
       WHERE enterprise_id=${input.enterpriseId}::uuid`.execute(trx);
    if (runtime.rows[0]?.strict_writes_enabled === true) {
      throw new ProviderFinanceActivationError("ALREADY_ACTIVATED", "该企业已启用严格资金写");
    }
    return candidate;
  }

  // ===== 步骤 5：静默租约 =====

  /** 租约有效性与剩余时间（≥5 分钟）。排空判定见 {@link assertDrained}。 */
  private async assertQuiescent(
    trx: Transaction<Database>, enterpriseId: string, now: Date,
  ): Promise<void> {
    const evaluation = await this.evaluateQuiescence(enterpriseId, now, trx);
    if (!evaluation.active) {
      throw new ProviderFinanceActivationError(
        "ACTIVATION_NOT_QUIESCENT", "企业静默租约未处于有效状态，请重新建立静默期并重新预检");
    }
    if (evaluation.insufficientForActivation) {
      throw new ProviderFinanceActivationError(
        "ACTIVATION_NOT_QUIESCENT", "静默租约剩余时间不足 5 分钟，请重新建立静默期和候选",
        { remainingSeconds: evaluation.remainingSeconds });
    }
  }

  // ===== 步骤 7：排空门禁 =====

  /**
   * 排空门禁（PFA-09）。
   *
   * 唯一的豁免出口是**候选已冻结的固定修复行主键**：切换时点之后创建、
   * `settled_at IS NULL` 但已被候选判定为确定性可修复的终态行，会在同一事务的第 10 步
   * 被按主键 `FOR UPDATE` 修复，因此不应被当成"在途结算"拦下（否则 PFH-04 主路径不可达）。
   *
   * 豁免集严格等于候选存档的 `usage_repair_baseline`，而本方法只在候选复验通过后调用，
   * 所以预检后新增的行、非候选行、以及任何在途工作（`IN_PROGRESS` 请求 /
   * 未结束 `upstream_attempt` / `PENDING` 交易）**一律不豁免**。
   */
  private async assertDrained(
    trx: Transaction<Database>, enterpriseId: string, candidate: ActivationCandidateView,
  ): Promise<void> {
    const drain = await this.collectDrainReport(enterpriseId, trx, {
      excludeLedgerLineIds: candidate.usageRepairBaseline.map((row) => row.ledgerLineId),
    });
    if (!drain.drained) {
      throw new ProviderFinanceActivationError(
        "ACTIVATION_NOT_QUIESCENT", "仍存在在途请求或未结算事实，排空未完成", drain);
    }
  }

  // ===== 步骤 6：锁内重算 =====

  /**
   * 步骤 6：锁内重算。草稿来源是**候选存档**（0079 `candidate_draft`），
   * 不是请求体——activate 合同不接受草稿（PFA-07：请求体不得携带业务载荷）。
   */
  private async reverifyCandidate(
    trx: Transaction<Database>, input: ActivateInput,
    candidate: ActivationCandidateView, now: Date,
  ): Promise<ReverifiedCandidate> {
    const snapshotAt = now.toISOString();
    const scope = await loadActivationScope(trx, { enterpriseId: input.enterpriseId, snapshotAt });
    const [watermark, facts] = await Promise.all([
      buildFactWatermark(trx, { enterpriseId: input.enterpriseId, snapshotAt }),
      loadProjectionFacts(trx, { enterpriseId: input.enterpriseId, scope }),
    ]);
    if (watermark.hash !== candidate.factWatermarkHash) {
      throw new ProviderFinanceActivationError(
        "CANDIDATE_STALE", "预检后的财务事实已变化，完整事实水位不一致，请重新预检",
        { stored: candidate.factWatermarkHash, current: watermark.hash });
    }
    if (!candidate.candidateDraft) {
      throw new ProviderFinanceActivationError(
        "CANDIDATE_STALE", "候选缺少草稿载荷（0079 之前创建的候选不可再激活），请重新预检");
    }
    const normalized = normalizeDraftItem(candidate.candidateDraft, input.enterpriseId);
    if (input.draft) {
      const supplied = normalizeDraftItem(input.draft, input.enterpriseId);
      if (JSON.stringify(supplied) !== JSON.stringify(normalized)) {
        throw new ProviderFinanceActivationError(
          "CANDIDATE_STALE", "调用方草稿与候选存档草稿不一致，请重新预检");
      }
    }
    // 候选哈希复算：使用候选存档的水位哈希作为基准，把"草稿不一致"与"事实漂移"分开判定。
    const recomputedHash = computeCandidateHash({
      enterpriseId: input.enterpriseId, candidate: normalized,
      factWatermarkHash: candidate.factWatermarkHash,
      scopeAccounts: scope.accounts.map((account) => ({
        resourceId: account.resourceId, currency: account.currency,
      })),
    });
    if (recomputedHash !== candidate.candidateHash) {
      throw new ProviderFinanceActivationError(
        "CANDIDATE_STALE", "提交的草稿与候选存档不一致（候选哈希复算不等）",
        { stored: candidate.candidateHash, recomputed: recomputedHash });
    }
    const projection = projectActivationCandidate({
      enterpriseId: input.enterpriseId, snapshotAt, resources: scope.resources, accounts: scope.accounts,
      financeEvents: facts.financeEvents, periods: facts.periods, legacyPurchases: facts.legacyPurchases,
      ledgerLines: facts.ledgerLines, usageEvents: facts.usageEvents,
      accountComponents: facts.accountComponents, monthlyGaps: facts.monthlyGaps,
      strictWritesEnabled: facts.strictWritesEnabled, draft: normalized,
      usageRepairBaseline: [], usageRepairTargets: [],
    });
    assertSameBaseline(projection, candidate);
    if (projection.gaps.length > 0) {
      throw new ProviderFinanceActivationError(
        "CANDIDATE_NOT_READY", "锁内重算投影未通过守恒，不能激活",
        { gaps: summarizeActivationGaps(projection.gaps) });
    }
    return { scope, candidate: normalized, projection, projected: projection.projected };
  }

  // ===== 步骤 7～8：初始化事实与旧记录关闭 =====

  private async writeDraftFacts(
    trx: Transaction<Database>, input: ActivateInput,
    candidate: ActivationCandidateView, reverified: ReverifiedCandidate,
  ): Promise<DraftWriteCounts> {
    const namespace = `activation:${candidate.candidateId}:`;
    const periodIdByDraftKey = new Map<string, string>();
    const openings = await this.writeOpenings(trx, input, reverified, namespace);
    const recharges = await this.writeRecharges(trx, input, reverified, namespace);
    const purchases = await this.writePurchases(trx, input, reverified, namespace, periodIdByDraftKey);
    const carryovers = await this.writeCarryovers(trx, input, reverified, periodIdByDraftKey);
    const legacyResolutions = await this.writeLegacyClosures(trx, input, reverified, namespace);
    return {
      openings, recharges, purchases, carryovers, legacyResolutions, periodIdByDraftKey,
    };
  }

  private async writeOpenings(
    trx: Transaction<Database>, input: ActivateInput, reverified: ReverifiedCandidate, namespace: string,
  ): Promise<number> {
    let written = 0;
    for (const opening of reverified.candidate.apiOpeningBalances) {
      const existing = await trx.selectFrom("provider_finance_event").select(["account_amount"])
        .where("enterprise_id", "=", input.enterpriseId)
        .where("provider_resource_id", "=", opening.resourceId)
        .where("account_currency", "=", opening.accountCurrency)
        .where("event_type", "=", "API_OPENING_BALANCE").executeTakeFirst();
      if (existing) {
        // 已存在金额相同的原始期初视为已满足（PFH-01 只允许一条）；金额不同即缺口，不得覆盖。
        if (existing.account_amount !== opening.accountAmount) {
          throw new ProviderFinanceActivationError(
            "CANDIDATE_STALE", "该账户已存在金额不同的原始期初余额，不得覆盖",
            { resourceId: opening.resourceId, accountCurrency: opening.accountCurrency });
        }
        continue;
      }
      await insertOpeningBalanceTx(trx, {
        enterpriseId: input.enterpriseId, resourceId: opening.resourceId, adminId: input.adminId,
        accountAmount: opening.accountAmount, accountCurrency: opening.accountCurrency,
        description: opening.description, evidenceRef: opening.evidenceRef,
        idempotencyKey: `${namespace}opening:${opening.resourceId}:${opening.accountCurrency}`,
        source: "MIGRATION", externalReference: null,
      });
      written += 1;
    }
    return written;
  }

  private async writeRecharges(
    trx: Transaction<Database>, input: ActivateInput, reverified: ReverifiedCandidate, namespace: string,
  ): Promise<number> {
    let written = 0;
    for (const recharge of reverified.candidate.historicalApiRecharges) {
      await insertRechargeTx(trx, {
        enterpriseId: input.enterpriseId, resourceId: recharge.resourceId, adminId: input.adminId,
        accountAmount: recharge.accountAmount, accountCurrency: recharge.accountCurrency,
        cashPaidCny: recharge.cashPaidCny, occurredAt: new Date(recharge.occurredAt),
        // 迁移行写来源标记（旧账本据此排除该记录）；订单引用仍留在草稿与关闭审计里。
        externalReference: legacySourceMarker(recharge.sourceRecordId, recharge.externalReference),
        description: recharge.description,
        evidenceRef: recharge.evidenceRef,
        idempotencyKey: `${namespace}${recharge.recordIdempotencyKey}`,
      }, { source: "MIGRATION" });
      written += 1;
    }
    return written;
  }

  private async writePurchases(
    trx: Transaction<Database>, input: ActivateInput, reverified: ReverifiedCandidate,
    namespace: string, periodIdByDraftKey: Map<string, string>,
  ): Promise<number> {
    let written = 0;
    for (const purchase of reverified.candidate.codingPlanPurchases) {
      const result = await insertSubscriptionTx(trx, {
        enterpriseId: input.enterpriseId, resourceId: purchase.resourceId, adminId: input.adminId,
        kind: purchase.kind, productName: purchase.productName,
        accountAmount: purchase.accountAmount, accountCurrency: purchase.accountCurrency,
        cashPaidCny: purchase.cashPaidCny, occurredAt: new Date(purchase.occurredAt),
        // 迁移行写来源标记（旧账本据此排除该记录）；订单引用仍留在草稿与关闭审计里。
        externalReference: legacySourceMarker(purchase.sourceRecordId, purchase.externalReference),
        description: purchase.description,
        evidenceRef: purchase.evidenceRef,
        idempotencyKey: `${namespace}${purchase.recordIdempotencyKey}`,
        periodStart: new Date(purchase.periodStart),
        periodEndExclusive: new Date(purchase.periodEndExclusive),
      }, {
        source: "MIGRATION",
        // 由旧购买记录迁移而来：周期必须绑定源记录，便于后续审计追溯。
        periodSource: purchase.sourceRecordId === null ? purchase.kind : "MIGRATED_PURCHASE",
        migrationSourceRecordId: purchase.sourceRecordId,
        actorAdminId: input.adminId,
      });
      periodIdByDraftKey.set(purchase.recordIdempotencyKey, result.periodId);
      written += 1;
    }
    return written;
  }

  private async writeCarryovers(
    trx: Transaction<Database>, input: ActivateInput, reverified: ReverifiedCandidate,
    periodIdByDraftKey: Map<string, string>,
  ): Promise<number> {
    let written = 0;
    for (const carryover of reverified.candidate.codingPlanCarryovers) {
      const result = await insertCarryoverPeriodTx(trx, {
        enterpriseId: input.enterpriseId, resourceId: carryover.resourceId, adminId: input.adminId,
        productName: carryover.productName,
        periodStart: new Date(carryover.periodStart),
        periodEndExclusive: new Date(carryover.periodEndExclusive),
        migrationSourceRecordId: carryover.snapshotId,
        description: carryover.description, evidenceRef: carryover.evidenceRef,
      });
      periodIdByDraftKey.set(carryover.snapshotId, result.periodId);
      written += 1;
    }
    return written;
  }

  /**
   * 旧购买记录关闭（PFH-02）。
   *
   * MIGRATED 的"金额事实"由第 7 步写出的草稿明细行承载；
   * 这里把「旧记录 → 资金事件」的不可变映射写进关闭审计，
   * 并校验草稿行确实按 `sourceRecordId + externalReference` 绑定了该记录。
   */
  private async writeLegacyClosures(
    trx: Transaction<Database>, input: ActivateInput, reverified: ReverifiedCandidate, namespace: string,
  ): Promise<number> {
    let written = 0;
    for (const resolution of reverified.candidate.legacyPurchaseResolutions) {
      const migratedEventId = resolution.resolution === "MIGRATED"
        ? await this.findMigratedEventId(trx, input, reverified, resolution.legacyRecordId,
          resolution.migratedExternalReference, namespace)
        : null;
      await closeLegacyPurchaseTx(trx, {
        enterpriseId: input.enterpriseId, resourceId: resolution.resourceId, adminId: input.adminId,
        legacyRecordId: resolution.legacyRecordId, resolution: resolution.resolution,
        migratedEventId, representedEventId: resolution.financeEventId,
        externalReference: resolution.migratedExternalReference,
        reason: resolution.reason, evidenceRef: resolution.evidenceRef,
      });
      written += 1;
    }
    return written;
  }

  private async findMigratedEventId(
    trx: Transaction<Database>, input: ActivateInput, reverified: ReverifiedCandidate,
    legacyRecordId: string, externalReference: string | null, namespace: string,
  ): Promise<string | null> {
    const recharge = reverified.candidate.historicalApiRecharges.find((row) =>
      row.sourceRecordId === legacyRecordId && row.externalReference === externalReference);
    const purchase = reverified.candidate.codingPlanPurchases.find((row) =>
      row.sourceRecordId === legacyRecordId && row.externalReference === externalReference);
    const idempotencyKey = recharge
      ? `${namespace}${recharge.recordIdempotencyKey}`
      : purchase ? `${namespace}${purchase.recordIdempotencyKey}` : null;
    if (!idempotencyKey) return null;
    const event = await trx.selectFrom("provider_finance_event").select("id")
      .where("enterprise_id", "=", input.enterpriseId).where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    return event?.id ?? null;
  }

  // ===== 步骤 9：四字段修复 =====

  private async applyCandidateRepairs(
    trx: Transaction<Database>, input: ActivateInput,
    candidate: ActivationCandidateView, reverified: ReverifiedCandidate,
    writes: DraftWriteCounts,
  ): Promise<UsageRepairApplyResult> {
    const recomputedIds = reverified.projection.usageRepairBaseline.map((row) => row.ledgerLineId);
    const storedIds = candidate.usageRepairBaseline.map((row) => row.ledgerLineId);
    if (recomputedIds.join(",") !== storedIds.join(",")) {
      throw new ProviderFinanceActivationError(
        "CANDIDATE_STALE", "历史修复固定行集在锁内重算后与候选存档不一致，请重新预检",
        { stored: storedIds.length, recomputed: recomputedIds.length });
    }
    return applyUsageRepairsTx(trx, {
      enterpriseId: input.enterpriseId,
      snapshotAt: new Date(reverified.scope.snapshotAt),
      baseline: candidate.usageRepairBaseline,
      targets: reverified.projection.usageRepairTargets,
      periodIdByDraftKey: writes.periodIdByDraftKey,
    });
  }

  // ===== 步骤 10：真实事实的完整窗口守恒 =====

  /**
   * 用**真实事实 + 空草稿**重跑投影：草稿里的钱此刻已经落库，
   * 因此守恒必须由真实数据独立成立，而不是靠虚拟事实兜底。
   *
   * 唯一豁免的是 `LEGACY_RECORD` 类缺口：关闭决定保存在本事务的关闭审计里
   * （见 {@link writeLegacyClosures}），不在投影输入里重复声明；
   * 资金、Token、周期归属与经营账单守恒一律不得豁免。
   */
  private async assertRealFactConservation(
    trx: Transaction<Database>, input: ActivateInput, reverified: ReverifiedCandidate, now: Date,
  ): Promise<ProjectedFinanceSummary> {
    // 与复验使用同一 `now`：守恒窗口必须与候选水位一致，否则窗口本身就成了漂移源。
    const snapshotAt = now.toISOString();
    const scope = await loadActivationScope(trx, { enterpriseId: input.enterpriseId, snapshotAt });
    const facts = await loadProjectionFacts(trx, { enterpriseId: input.enterpriseId, scope });
    const empty = normalizeDraftItem(emptyDraft(), input.enterpriseId);
    const projection = projectActivationCandidate({
      enterpriseId: input.enterpriseId, snapshotAt, resources: scope.resources, accounts: scope.accounts,
      financeEvents: facts.financeEvents, periods: facts.periods, legacyPurchases: facts.legacyPurchases,
      ledgerLines: facts.ledgerLines, usageEvents: facts.usageEvents,
      accountComponents: facts.accountComponents, monthlyGaps: facts.monthlyGaps,
      strictWritesEnabled: facts.strictWritesEnabled, draft: empty,
      usageRepairBaseline: [], usageRepairTargets: [],
    });
    const failures: ActivationGap[] = projection.gaps.filter((gap) =>
      gap.category !== LEGACY_CLOSURE_CATEGORY);
    if (failures.length > 0) {
      throw new ProviderFinanceActivationError(
        "CANDIDATE_NOT_READY", "切换时点至候选水位的完整窗口守恒未通过，已整体回滚",
        { gaps: summarizeActivationGaps(failures) });
    }
    if (reverified.projected.monthsChecked.join(",") !== projection.projected.monthsChecked.join(",")) {
      throw new ProviderFinanceActivationError(
        "CANDIDATE_STALE", "守恒窗口在激活期间发生变化，请重新预检");
    }
    return projection.projected;
  }

  // ===== 步骤 11：激活落库 =====

  private async commitActivation(
    trx: Transaction<Database>, input: ActivateInput, candidate: ActivationCandidateView,
    reverified: ReverifiedCandidate, writes: DraftWriteCounts, repairs: UsageRepairApplyResult,
    conservation: ProjectedFinanceSummary, now: Date,
  ): Promise<ActivationReceipt> {
    const receipt: ActivationReceipt = {
      candidateId: candidate.candidateId,
      candidateHash: candidate.candidateHash,
      factWatermarkHash: candidate.factWatermarkHash,
      activatedAt: now.toISOString(),
      activatedByAdminUserId: input.adminId,
      factCounts: {
        openings: writes.openings, recharges: writes.recharges, purchases: writes.purchases,
        carryovers: writes.carryovers, legacyResolutions: writes.legacyResolutions,
        usageRepairs: repairs.appliedRows,
      },
      monthsChecked: conservation.monthsChecked,
      conservationPassed: true,
      conservationFailures: [],
    };
    await this.enableStrictWrites(trx, input, now);
    await this.markScopeResourcesReady(trx, input, reverified, now);
    await this.activateCandidateRow(trx, input, candidate.candidateId, receipt, now);
    await writeActivationAuditTx(trx, {
      enterpriseId: input.enterpriseId, adminId: input.adminId,
      action: "provider_finance.activation.activate",
      targetType: "provider_finance_activation_attempt", targetId: candidate.candidateId,
      summary: {
        candidate_hash: candidate.candidateHash, fact_watermark_hash: candidate.factWatermarkHash,
        fact_counts: receipt.factCounts, months_checked: receipt.monthsChecked,
        usage_repair_summary: {
          applied_rows: repairs.appliedRows, applied_by_field: repairs.appliedByField,
          new_rows_after_preview: repairs.newRowsAfterPreview,
          non_target_hash_mismatches: repairs.nonTargetHashMismatches,
        },
        idempotency_key: input.idempotencyKey,
      },
    });
    return receipt;
  }

  private async enableStrictWrites(
    trx: Transaction<Database>, input: ActivateInput, now: Date,
  ): Promise<void> {
    await sql`
      INSERT INTO provider_finance_runtime_state
        (enterprise_id, strict_writes_enabled, activated_at, activated_by_admin_user_id, updated_at)
      VALUES (${input.enterpriseId}::uuid, true, ${now}, ${input.adminId}::uuid, ${now})
      ON CONFLICT (enterprise_id) DO UPDATE SET
        strict_writes_enabled=true, activated_at=EXCLUDED.activated_at,
        activated_by_admin_user_id=EXCLUDED.activated_by_admin_user_id, updated_at=EXCLUDED.updated_at
    `.execute(trx);
  }

  /** 激活范围内每个 API 资源按必要币种置为 READY（PFH-07）。 */
  private async markScopeResourcesReady(
    trx: Transaction<Database>, input: ActivateInput, reverified: ReverifiedCandidate, now: Date,
  ): Promise<void> {
    const currenciesByResource = new Map<string, FinanceCurrency[]>();
    for (const account of reverified.scope.accounts) {
      const list = currenciesByResource.get(account.resourceId) ?? [];
      list.push(account.currency);
      currenciesByResource.set(account.resourceId, list);
    }
    const apiResourceIds = reverified.scope.resources
      .filter((resource) => resource.mode === "API")
      .map((resource) => resource.resourceId).sort();
    for (const resourceId of apiResourceIds) {
      await this.promoteResourceFinanceReady({
        enterpriseId: input.enterpriseId, resourceId, adminId: input.adminId,
        requiredCurrencies: currenciesByResource.get(resourceId) ?? [], now,
      }, trx);
    }
  }

  /** `PREVIEWED → ACTIVATED` 与回执在同一事务内原子完成，绝不落 `ACTIVATING`。 */
  private async activateCandidateRow(
    trx: Transaction<Database>, input: ActivateInput, candidateId: string,
    receipt: ActivationReceipt, now: Date,
  ): Promise<void> {
    const updated = await trx.updateTable("provider_finance_activation_attempt")
      .set({
        status: "ACTIVATED",
        activation_idempotency_key: input.idempotencyKey,
        activation_result: receipt,
        activated_by_admin_user_id: input.adminId,
        activated_at: now,
      })
      .where("enterprise_id", "=", input.enterpriseId)
      .where("id", "=", candidateId)
      .where("status", "=", "PREVIEWED")
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows ?? 0) !== 1) {
      throw new ProviderFinanceActivationError(
        "ALREADY_ACTIVATED", "候选状态在激活期间被其他事务改变，请重新读取激活状态");
    }
  }
}

// ===== 辅助 =====

function emptyDraft(): ActivationDraft {
  return {
    schema_version: "1", api_opening_balances: [], historical_api_recharges: [],
    coding_plan_purchases: [], coding_plan_carryovers: [], legacy_purchase_resolutions: [],
  };
}

async function tryAdvisoryLock(trx: Transaction<Database>, key: string): Promise<boolean> {
  const row = await sql<{ acquired: boolean }>`
    SELECT pg_try_advisory_xact_lock(hashtextextended(${key}::text, 0::bigint)) AS acquired
  `.execute(trx);
  return row.rows[0]?.acquired === true;
}

/** 固定修复行集必须与候选存档逐行一致（PFH-04：预检固定，激活只锁定这些主键）。 */
function assertSameBaseline(
  projection: ActivationProjectionResult, candidate: ActivationCandidateView,
): void {
  const recomputed = projection.usageRepairBaseline;
  const stored = candidate.usageRepairBaseline;
  if (recomputed.length !== stored.length) {
    throw new ProviderFinanceActivationError(
      "CANDIDATE_STALE", "历史修复固定行集数量在锁内重算后发生变化，请重新预检",
      { storedRows: stored.length, recomputedRows: recomputed.length });
  }
  for (let index = 0; index < stored.length; index += 1) {
    const left = stored[index]!;
    const right = recomputed[index]!;
    if (left.ledgerLineId !== right.ledgerLineId
      || left.targetFieldsBeforeHash !== right.targetFieldsBeforeHash
      || left.nonTargetFieldsBeforeHash !== right.nonTargetFieldsBeforeHash) {
      throw new ProviderFinanceActivationError(
        "CANDIDATE_STALE", `用量行 ${left.ledgerLineId} 的修复基准在锁内重算后发生变化，请重新预检`);
    }
  }
}

function sqlStateOf(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * 事务执行边界之外的故障映射（design §7）。
 *
 * - `40001`（序列化失败）/ `40P01`（死锁）→ `ACTIVATION_RETRY_REQUIRED`、`retryable=true`；
 * - `ProviderFinanceError`（Tx 原语的确定性输入校验，如"账户金额必须为正"）→
 *   `FACT_WRITE_INVALID`（400）：这类错误是**确定性**的，重试或重新预检都不会改变结果，
 *   不能改写成 `CANDIDATE_STALE`——那会暗示"重新预检可解"，误导管理员陷入无意义循环，
 *   也掩盖了原始错误码；
 * - 其它错误原样抛出；
 * - 本函数**不做任何重试**：协调器、仓储与 HTTP 层都不得自动重试，
 *   管理员必须先重读 activation-state 再决定是否重提（水位变化会变成 `CANDIDATE_STALE`）。
 */
export function mapActivationFailure(error: unknown): unknown {
  const state = sqlStateOf(error);
  if (state === "40001" || state === "40P01") {
    return new ProviderFinanceActivationError(
      "ACTIVATION_RETRY_REQUIRED", "激活事务与并发写入冲突，请重读激活状态后再提交",
      { sqlstate: state, retryable: true }, true);
  }
  if (error instanceof ProviderFinanceError) {
    return new ProviderFinanceActivationError(
      "FACT_WRITE_INVALID", `初始化事实写入参数不合法：${error.message}`, { code: error.code }, false);
  }
  return error;
}
