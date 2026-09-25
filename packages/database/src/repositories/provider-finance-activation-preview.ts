import { sql, type Transaction } from "kysely";
import {
  normalizeDraftItem,
  projectActivationCandidate,
  sortActivationGaps,
  summarizeActivationGaps,
  computeCandidateHash,
  type ActivationDecision,
  type ActivationDraft,
  type ActivationGap,
  type FactWatermark,
  type NormalizedActivationCandidate,
  type ProjectedFinanceSummary,
  type UsageRepairBaselineRow,
  type UsageRepairSummary,
  type UsageRepairTarget,
} from "@qianliu/domain";
import type { Database } from "../kysely.js";
import { ProviderFinanceActivationRepository } from "./provider-finance-activation-repository.js";
import { ProviderFinanceActivationError } from "./provider-finance-activation-types.js";
import {
  buildFactWatermark,
  loadActivationScope,
  loadProjectionFacts,
  type ActivationScope,
} from "./provider-finance-activation-facts.js";

export interface PreviewActivationInput {
  enterpriseId: string;
  adminId: string;
  /** 已通过 Zod 严格校验并补齐 null 默认值的领域草稿。 */
  draft: ActivationDraft;
  /** 候选水位（默认取当前时间）；显式传入只为测试与复现。 */
  now?: Date;
  /**
   * 候选落库前门禁（WP04 任务 4.2）：静默租约有效性、排空与豁免集判定。
   * 抛出的错误会直接冒泡给调用方，候选不落库。
   */
  beforePersist?: (projection: ReadOnlyCandidateProjection) => Promise<void>;
}

/** 只读财务计算层的完整输出。本结构**不包含任何写入**。 */
export interface ReadOnlyCandidateProjection {
  enterpriseId: string;
  snapshotAt: string;
  candidate: NormalizedActivationCandidate;
  candidateHash: string;
  factWatermark: FactWatermark;
  scope: ActivationScope;
  decision: ActivationDecision;
  gaps: ActivationGap[];
  gapSummary: Array<{ code: string; count: number }>;
  projection: ProjectedFinanceSummary;
  usageRepairs: UsageRepairSummary;
  usageRepairBaseline: UsageRepairBaselineRow[];
  usageRepairTargets: UsageRepairTarget[];
  scopeSummary: {
    apiResources: number;
    codingPlanResources: number;
    requiredAccounts: number;
    legacyRecords: number;
    months: string[];
  };
  strictWritesEnabled: boolean;
}

export interface ActivationPreviewResult extends ReadOnlyCandidateProjection {
  candidateId: string;
  expiresAt: string;
  previewCommittedAt: string;
}

/**
 * 资金账本初始化：候选假设投影（WP02 任务 2.3、2.4）。
 *
 * 对应 OpenSpec PFA-02、PFA-03、PFH-01～PFH-05；计划 v1.2 §4.5；design §6。
 *
 * 分层合同（design §6）：
 *  1. `buildCandidateProjection` 在 `REPEATABLE READ + READ ONLY` 事务内加载事实并做纯投影，
 *     **不写资金事件、不写订阅周期、不修改 ledger_line、不写候选**。
 *     由于 PostgreSQL 的 `SET TRANSACTION READ ONLY` 会直接拒绝任何写语句，
 *     该方法内的任何写入都会以 `25006` 失败，因此「只读」是数据库强制的，而非约定。
 *  2. `previewActivation` 只在步骤 1 的事务**成功提交之后**，用独立的短控制事务写入候选元数据。
 *     候选 TTL 由此刻起算 30 分钟，读取/失败/重放均不滑动续期。
 */
export class ProviderFinanceActivationPreviewRepository extends ProviderFinanceActivationRepository {
  /**
   * 只读财务计算层：加载激活范围、完整事实水位与全部事实，然后做纯投影。
   * 调用方可直接调用本方法以证明「预检零写入」。
   */
  async buildCandidateProjection(
    input: PreviewActivationInput,
  ): Promise<ReadOnlyCandidateProjection> {
    const snapshotAt = (input.now ?? new Date()).toISOString();
    return this.db.transaction().setIsolationLevel("repeatable read").execute(async (trx: Transaction<Database>) => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      const scope = await loadActivationScope(trx, {
        enterpriseId: input.enterpriseId, snapshotAt,
      });
      const [factWatermark, facts] = await Promise.all([
        buildFactWatermark(trx, { enterpriseId: input.enterpriseId, snapshotAt }),
        loadProjectionFacts(trx, { enterpriseId: input.enterpriseId, scope }),
      ]);
      const candidate = normalizeDraftItem(input.draft, input.enterpriseId);
      const projection = projectActivationCandidate({
        enterpriseId: input.enterpriseId,
        snapshotAt,
        resources: scope.resources,
        accounts: scope.accounts,
        financeEvents: facts.financeEvents,
        periods: facts.periods,
        legacyPurchases: facts.legacyPurchases,
        ledgerLines: facts.ledgerLines,
        usageEvents: facts.usageEvents,
        accountComponents: facts.accountComponents,
        monthlyGaps: facts.monthlyGaps,
        strictWritesEnabled: facts.strictWritesEnabled,
        draft: candidate,
        // 固定修复行集由投影自身确定；这两个字段是「输入回显」通道，
        // 预检不消费外部传入的基准，避免调用方伪造资格行。
        usageRepairBaseline: [],
        usageRepairTargets: [],
      });
      // 必要币种账户进入候选哈希（计划 v1.2 §5.1）。
      const candidateHash = computeCandidateHash({
        enterpriseId: input.enterpriseId,
        candidate,
        factWatermarkHash: factWatermark.hash,
        scopeAccounts: scope.accounts.map((account) => ({
          resourceId: account.resourceId, currency: account.currency,
        })),
      });
      const gaps = sortActivationGaps(projection.gaps);
      return {
        enterpriseId: input.enterpriseId,
        snapshotAt,
        candidate,
        candidateHash,
        factWatermark,
        scope,
        decision: gaps.length === 0 ? "GO_CANDIDATE" : "NO_GO",
        gaps,
        gapSummary: summarizeActivationGaps(gaps),
        projection: projection.projected,
        usageRepairs: projection.usageRepairs,
        usageRepairBaseline: projection.usageRepairBaseline,
        usageRepairTargets: projection.usageRepairTargets,
        scopeSummary: projection.scopeSummary,
        strictWritesEnabled: facts.strictWritesEnabled,
      };
    });
  }

  /**
   * 预检入口：只读投影提交后，再由独立短控制事务保存候选元数据。
   * TTL 起点是只读事务提交后的时间，不是请求开始时间，也不是候选写入时间。
   *
   * `input.beforePersist` 是候选落库前的最后一道门禁（WP04 任务 4.2）：Control API
   * 用它验证"有效静默租约 + 排空"，未通过时抛错、候选不落库（PFA-09：
   * 排空未完成不得生成 `GO_CANDIDATE`）。门禁放在只读投影之后，是因为排空豁免集
   * 必须取自刚刚算出的候选固定修复行集，否则四字段修复路径再次不可达。
   */
  async previewActivation(input: PreviewActivationInput): Promise<ActivationPreviewResult> {
    const projection = await this.buildCandidateProjection(input);
    if (projection.strictWritesEnabled) {
      throw new ProviderFinanceActivationError(
        "ALREADY_ACTIVATED", "该企业已完成严格资金写激活，不能重复创建初始化候选");
    }
    await input.beforePersist?.(projection);
    // 只读事务已经提交；从这里开始的写入不带任何财务权威性。
    const previewCommittedAt = new Date();
    const candidate = await this.db.transaction().execute((trx) => this.recordPreviewCandidate({
      enterpriseId: projection.enterpriseId,
      adminId: input.adminId,
      candidateHash: projection.candidateHash,
      factWatermarkHash: projection.factWatermark.hash,
      decision: projection.decision,
      gaps: projection.gaps,
      gapSummary: projection.gapSummary,
      projection: projection.projection,
      usageRepairBaseline: projection.usageRepairBaseline,
      candidateDraft: input.draft,
      previewCommittedAt,
    }, trx));
    return {
      ...projection,
      candidateId: candidate.candidateId,
      expiresAt: candidate.expiresAt,
      previewCommittedAt: previewCommittedAt.toISOString(),
    };
  }
}
