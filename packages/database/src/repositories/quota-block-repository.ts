/**
 * CPQW：Coding Plan 窗口额度阻断的条件提交仓储（计划§4/§5/§7，F1/F2/F4）。
 *
 * Worker 与管理员手动额度 GET 共用本入口：
 *   1. GET 前短事务读取 queryToken（资源/凭证/额度代次/incident/端点哈希/查询时刻）；
 *   2. 网络请求在事务外进行；
 *   3. 提交在同一"资源优先"事务内：锁资源 → provider FOR SHARE 核验 → token 全匹配
 *      才允许写入（FIVE_HOUR→WEEKLY 固定顺序）→ 合并/解除 block → 状态迁移 →
 *      仅关闭同 resource+incident 的额度事件 → 刷新关联 Key 模型集合 →
 *      revision+1 与审计；任何不匹配只标 SUPERSEDED（仅元数据），不写当前事实。
 *
 * 同 token 的两个结果只接受首次提交：每个被接受的提交都递增 quota_state_revision，
 * 后到者 token 失配即被丢弃。明确耗尽的故障事实与关联额度事件也在同一资源优先
 * 事务内创建（先建 incident 再绑定事件），不得先独立建事件再回填。
 */
import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import { resolveProviderEndpoint } from "@qianliu/provider-adapters";
import {
  applyQuotaObservation,
  definiteZeroWindows,
  deriveQuotaSyncRecovery,
  deriveResourceTransition,
  mergeQuotaExhaustion,
  nextQuotaCheckAt,
  parseQuotaBlockState,
  quotaObservationConfirmsRecovery,
  serializeQuotaBlockState,
  type QuotaBlockState,
  type QuotaBlockWindowType,
  type ResourceStatus,
  type QuotaExhaustionObservation,
  type QuotaWindowObservation,
} from "@qianliu/domain";
import type { Database } from "../kysely.js";
import { ProviderQuotaWindowRepository } from "./provider-quota-window-repository.js";
import { RuntimeAssuranceRepository } from "./runtime-assurance-repository.js";
import { refreshResourcePrincipalKeyModelsTx, type ProviderResourceRow } from "./resource-pool-repository.js";

/** 额度查询 token：GET 前捕获，提交时逐项匹配；任何一项变化都使旧结果失效。 */
export interface QuotaQueryToken {
  enterpriseId: string;
  resourceId: string;
  providerCode: string;
  resourceVersion: number;
  credentialVersion: number | null;
  quotaStateRevision: number;
  incidentId: string | null;
  endpointHash: string;
  queryStartedAt: string;
}

/** GET 前捕获结果：token + 调用方执行网络请求所需的资源事实。 */
export interface QuotaQueryCapture {
  token: QuotaQueryToken;
  credentialCiphertext: string | null;
  status: string;
}

export type QuotaCommitSupersededReason =
  | "RESOURCE_MISSING"
  | "PROVIDER_UNAVAILABLE"
  | "RESOURCE_VERSION_CHANGED"
  | "CREDENTIAL_ROTATED"
  | "QUOTA_REVISION_CHANGED"
  | "INCIDENT_CHANGED"
  | "ENDPOINT_CHANGED"
  | "RESOURCE_PREREQUISITE_CHANGED";

export type QuotaCommitResult =
  | { status: "COMMITTED"; recovered: boolean; blockActive: boolean; nextCheckAt: Date | null; incidentsClosed: number; block: QuotaBlockState | null }
  | { status: "SUPERSEDED"; reason: QuotaCommitSupersededReason };

/** 额度 GET 成功后的单窗口输入（适配器口径）。 */
export interface QuotaCommitWindow {
  windowType: QuotaBlockWindowType;
  limit: string | null;
  used: string | null;
  remaining: string | null;
  unit: "PERCENT" | "POINT" | null;
  ratio: string | null;
  resetAt: Date | null;
  unsupported: boolean;
}

const DEFAULT_RETRY_INTERVAL_MS = 5 * 60_000;

/** 实际额度端点配置哈希：capture 与 commit 各自重算，端点变化即 token 失配。 */
export function codingPlanQuotaEndpointHash(providerCode: string): string {
  const resolved = resolveProviderEndpoint({
    providerCode,
    resourceMode: "CODING_PLAN",
    operation: "CODING_PLAN_QUOTA",
  });
  return createHash("sha256")
    .update(resolved.ok ? resolved.url : `unresolved:${providerCode}`)
    .digest("hex")
    .slice(0, 16);
}

function isKimiOrZhipu(providerCode: string): providerCode is "kimi" | "zhipu" {
  return providerCode === "kimi" || providerCode === "zhipu";
}

function currentIncidentId(row: Pick<ProviderResourceRow, "quota_block_state">): string | null {
  if (row.quota_block_state === null) return null;
  const parsed = parseQuotaBlockState(row.quota_block_state);
  return parsed?.incidentId ?? null;
}

export class QuotaBlockRepository {
  private readonly assurance: RuntimeAssuranceRepository;

  constructor(private readonly db: Kysely<Database>) {
    this.assurance = new RuntimeAssuranceRepository(db);
  }

  /**
   * GET 前捕获 queryToken（计划§7）。资源不适用（非 CP、厂商停用/归档、无凭证）
   * 返回 null，调用方跳过本次查询。
   */
  async captureQuotaQueryToken(resourceId: string, now: Date = new Date()): Promise<QuotaQueryCapture | null> {
    const row = await this.db
      .selectFrom("provider_resource as resource")
      .innerJoin("provider as provider", "provider.id", "resource.provider_id")
      .selectAll("resource")
      .select(["provider.code as provider_code", "provider.status as provider_status", "provider.archived_at as provider_archived_at"])
      .where("resource.id", "=", resourceId)
      .executeTakeFirst();
    if (!row) return null;
    if (row.mode !== "CODING_PLAN") return null;
    if (row.provider_status !== "ACTIVE" || row.provider_archived_at !== null) return null;
    if (row.archived_at !== null) return null;
    const providerCode = row.provider_code.toLowerCase();
    if (!isKimiOrZhipu(providerCode)) return null;
    if (row.credential_ciphertext === null) return null;
    return {
      token: {
        enterpriseId: row.enterprise_id,
        resourceId: row.id,
        providerCode,
        resourceVersion: row.version,
        credentialVersion: row.credential_version,
        quotaStateRevision: Number(row.quota_state_revision),
        incidentId: currentIncidentId(row),
        endpointHash: codingPlanQuotaEndpointHash(providerCode),
        queryStartedAt: now.toISOString(),
      },
      credentialCiphertext: row.credential_ciphertext,
      status: row.status,
    };
  }

  /**
   * 额度 GET 成功的条件提交。任何一步失败整体回滚（计划§7 顺序固定）。
   */
  async commitQuotaQueryResult(input: {
    token: QuotaQueryToken;
    source: "PROVIDER_SYNC" | "MANUAL_SYNC";
    adapterVersion: string;
    providerDataAt: Date | null;
    windows: readonly QuotaCommitWindow[];
    now: Date;
    retryIntervalMs?: number;
  }): Promise<QuotaCommitResult> {
    return this.withCommitRetry(() => this.db.transaction().execute(async (trx) => {
      const verified = await this.verifyTokenTx(trx, input.token);
      if ("reason" in verified) return { status: "SUPERSEDED", reason: verified.reason };
      const row = verified.row;

      // 固定顺序写入窗口快照（FIVE_HOUR → WEEKLY）。
      const windowRepo = new ProviderQuotaWindowRepository(trx);
      for (const windowType of ["FIVE_HOUR", "WEEKLY"] as const) {
        const window = input.windows.find((item) => item.windowType === windowType);
        if (!window) continue;
        await windowRepo.upsertCurrentWindow({
          enterprise_id: row.enterprise_id,
          provider_resource_id: row.id,
          window_type: window.windowType,
          limit_value: window.limit,
          used_value: window.used,
          remaining_value: window.remaining,
          unit: window.unit,
          ratio: window.ratio,
          reset_at: window.resetAt,
          provider_data_at: input.providerDataAt,
          source: input.source,
          adapter_version: input.adapterVersion,
          sync_status: window.unsupported ? "UNSUPPORTED" : "SUCCESS",
          sync_error_code: null,
        }, input.now, trx);
      }

      const observations: QuotaWindowObservation[] = input.windows.map((window) => ({
        windowType: window.windowType,
        known: !window.unsupported && window.remaining !== null,
        unsupported: window.unsupported,
        remaining: window.remaining === null ? null : Number(window.remaining),
        resetAt: window.resetAt ? window.resetAt.toISOString() : null,
      }));
      const parsedBlock = row.quota_block_state === null ? null : parseQuotaBlockState(row.quota_block_state);
      const blockCorrupt = row.quota_block_state !== null && parsedBlock === null;

      // 解除/保留：列非空但解析失败时保持阻断（不清除），仅允许合并新故障。
      const outcome = blockCorrupt
        ? { state: parsedBlock, recovered: false, changed: false }
        : applyQuotaObservation(parsedBlock, input.token.providerCode as "kimi" | "zhipu", observations, input.now);
      let nextState = outcome.state;
      // 存量无 block 记录的 RATE_LIMITED/EXHAUSTED 资源：厂商必需窗口确认正余量即可恢复。
      const legacyNoBlockRecovery = parsedBlock === null && !blockCorrupt
        && quotaObservationConfirmsRecovery(input.token.providerCode as "kimi" | "zhipu", observations)
        && (row.status === "RATE_LIMITED" || row.status === "EXHAUSTED");
      let recovered = outcome.recovered || legacyNoBlockRecovery;

      // 新的明确零值（发布初始化/新周期）在解除之后合并，避免被同次观察立即清除。
      for (const windowType of definiteZeroWindows(observations)) {
        const observation: QuotaExhaustionObservation = (() => {
          const observed = input.windows.find((item) => item.windowType === windowType)!;
          const resetAt = observed.resetAt && observed.resetAt > input.now ? observed.resetAt.toISOString() : null;
          return { windowType, resetAt, resetSource: resetAt ? "UPSTREAM_RESET_AT" : null };
        })();
        nextState = mergeQuotaExhaustion(nextState, {
          incidentId: nextState?.incidentId ?? randomUUID(),
          credentialVersion: row.credential_version,
          now: input.now,
          observation,
        });
        recovered = false;
      }

      return await this.finalizeQuotaStateTx(trx, row, {
        nextState,
        recovered,
        previousIncidentId: input.token.incidentId,
        now: input.now,
        retryIntervalMs: input.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS,
        exhaustedTransition: nextState !== null,
      });
    }));
  }

  /**
   * 额度 GET 失败的条件提交：仅保鲜失败观察与 nextCheck，
   * 保留 block 与未来 reset，不改变鉴权原因（计划§7）。
   */
  async commitQuotaQueryFailure(input: {
    token: QuotaQueryToken;
    source: "PROVIDER_SYNC" | "MANUAL_SYNC";
    adapterVersion: string;
    errorCode: string;
    now: Date;
    retryIntervalMs?: number;
  }): Promise<QuotaCommitResult> {
    return this.withCommitRetry(() => this.db.transaction().execute(async (trx) => {
      const verified = await this.verifyTokenTx(trx, input.token);
      if ("reason" in verified) return { status: "SUPERSEDED", reason: verified.reason };
      const row = verified.row;
      const windowRepo = new ProviderQuotaWindowRepository(trx);
      for (const windowType of ["FIVE_HOUR", "WEEKLY"] as const) {
        await windowRepo.markStale(
          row.enterprise_id, row.id, windowType, input.source, input.adapterVersion,
          input.errorCode, input.now, trx,
        );
      }
      // 失败提交同样递增 revision：同 token 的并发结果只接受首次提交。
      const nextCheckAt = row.quota_block_state !== null && isIsolatedStatus(row.status)
        ? new Date(input.now.getTime() + (input.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS))
        : null;
      await trx.updateTable("provider_resource").set({
        ...(nextCheckAt ? { cooldown_until: nextCheckAt } : {}),
        quota_state_revision: sql`quota_state_revision + 1`,
        updated_at: input.now,
      }).where("id", "=", row.id).execute();
      return {
        status: "COMMITTED",
        recovered: false,
        blockActive: row.quota_block_state !== null,
        nextCheckAt,
        incidentsClosed: 0,
        block: parseQuotaBlockState(row.quota_block_state),
      };
    }));
  }

  /**
   * Gateway 结算路径：明确 CP 窗口/套餐耗尽的故障事实与关联额度事件在同一
   * 资源优先事务内创建（F2/D4）。凭证或资源版本与 Attempt 实际调用时不一致 →
   * 迟到失败不落新凭证（SUPERSEDED，无任何写入）。
   */
  async recordCodingPlanExhaustionFault(input: {
    resourceId: string;
    expectedResourceVersion: number | null;
    expectedCredentialVersion: number | null;
    /** 同一故障可携带多个窗口归属（如 5 小时与周同时确为零）。 */
    observations: readonly QuotaExhaustionObservation[];
    now: Date;
    runtimeAssurance?: {
      mode: "OFF" | "OBSERVE" | "ENFORCE";
      wecomNotify: boolean;
    } | null;
    signal: {
      providerId: string;
      unifiedModelId: string | null;
      upstreamModel: string;
      upstreamCode: string | null;
      sanitizedSummary: string | null;
      aiRequestId: string;
      principalId: string;
    };
  }): Promise<QuotaCommitResult> {
    return this.withCommitRetry(() => this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("provider_resource")
        .selectAll()
        .where("id", "=", input.resourceId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return { status: "SUPERSEDED", reason: "RESOURCE_MISSING" };
      if (row.mode !== "CODING_PLAN") return { status: "SUPERSEDED", reason: "RESOURCE_PREREQUISITE_CHANGED" };
      // Fencing 为 null 感知严格比较：旧凭证版本为 null 时也必须与当前行一致，
      // 否则轮换后的迟到失败仍会写到新凭证（复审缺陷 1）。
      if ((row.version ?? null) !== input.expectedResourceVersion) {
        return { status: "SUPERSEDED", reason: "RESOURCE_VERSION_CHANGED" };
      }
      if ((row.credential_version ?? null) !== input.expectedCredentialVersion) {
        return { status: "SUPERSEDED", reason: "CREDENTIAL_ROTATED" };
      }
      const parsedBlock = row.quota_block_state === null ? null : parseQuotaBlockState(row.quota_block_state);
      const sameCredential = parsedBlock !== null && parsedBlock.credentialVersion === row.credential_version;
      const incidentId = sameCredential ? parsedBlock.incidentId : randomUUID();
      let merged = parsedBlock;
      for (const observation of input.observations) {
        merged = mergeQuotaExhaustion(merged, {
          incidentId: merged && merged.credentialVersion === row.credential_version ? merged.incidentId : incidentId,
          credentialVersion: row.credential_version,
          now: input.now,
          observation,
        });
      }
      if (merged === null) {
        // 无观察（防御）：不写 block，仅按普通故障处理。
        merged = mergeQuotaExhaustion(null, {
          incidentId, credentialVersion: row.credential_version, now: input.now,
          observation: { resetAt: null, resetSource: null },
        });
      }

      // 状态迁移：EXHAUSTED 幂等；CREDENTIAL_INVALID 的鉴权语义不由额度故障改写。
      const transition = row.status === "CREDENTIAL_INVALID"
        ? null
        : deriveResourceTransition(
          toQuotaRuntimeState(row),
          "UPSTREAM_BILLING_BLOCKED",
          input.now.getTime(),
        );

      await trx.updateTable("provider_resource").set({
        ...(transition ? {
          status: transition.toStatus,
          consecutive_failures: transition.consecutiveFailures,
          cooldown_until: transition.cooldownUntil ? new Date(transition.cooldownUntil) : null,
          last_probe_at: null,
        } : {}),
        quota_block_state: blockStateJsonValue(merged),
        quota_state_revision: sql`quota_state_revision + 1`,
        updated_at: input.now,
      }).where("id", "=", row.id).execute();
      if (transition) {
        await trx.insertInto("resource_status_event").values({
          enterprise_id: row.enterprise_id,
          provider_resource_id: row.id,
          from_status: row.status,
          to_status: transition.toStatus,
          reason: transition.reason,
          error_classification: "UPSTREAM_BILLING_BLOCKED",
          consecutive_failures: transition.consecutiveFailures,
          cooldown_until: null,
          actor: "system",
          created_at: input.now,
        }).execute();
      }

      // 关联额度事件与 incident 同事务创建/合并（不得先建事件后回填）。
      if (input.runtimeAssurance && input.runtimeAssurance.mode !== "OFF") {
        await this.assurance.recordQuotaIncidentSignal(trx, {
          enterpriseId: row.enterprise_id,
          providerId: input.signal.providerId,
          providerResourceId: row.id,
          unifiedModelId: input.signal.unifiedModelId,
          upstreamModel: input.signal.upstreamModel,
          signal: "QUOTA_EXHAUSTED",
          upstreamCode: input.signal.upstreamCode,
          sanitizedSummary: input.signal.sanitizedSummary,
          aiRequestId: input.signal.aiRequestId,
          principalId: input.signal.principalId,
          now: input.now,
          mode: input.runtimeAssurance.mode,
          wecomNotify: input.runtimeAssurance.wecomNotify,
          incidentId: merged.incidentId,
        });
      }

      // 阻断仍在：下一检查取最早未来点，未知取 now+retry。
      const nextCheckAt = isIsolatedStatus(row.status) || transition
        ? new Date(nextQuotaCheckAt(merged, input.now, DEFAULT_RETRY_INTERVAL_MS)!)
        : null;
      if (nextCheckAt) {
        await trx.updateTable("provider_resource")
          .set({ cooldown_until: nextCheckAt, updated_at: input.now })
          .where("id", "=", row.id).execute();
      }
      return {
        status: "COMMITTED",
        recovered: false,
        blockActive: true,
        nextCheckAt,
        incidentsClosed: 0,
        block: merged,
      };
    }));
  }

  /**
   * 收尾：block 写回/清空、状态迁移、事件关闭、Key 模型刷新、revision+1 与审计。
   */
  private async finalizeQuotaStateTx(
    trx: Transaction<Database>,
    row: ProviderResourceRow,
    input: {
      nextState: QuotaBlockState | null;
      recovered: boolean;
      previousIncidentId: string | null;
      now: Date;
      retryIntervalMs: number;
      exhaustedTransition: boolean;
    },
  ): Promise<QuotaCommitResult> {
    let incidentsClosed = 0;
    let transition: ReturnType<typeof deriveQuotaSyncRecovery> = null;
    if (input.recovered) {
      // 全部窗口恢复 → 额度类隔离解除（CREDENTIAL_INVALID 除外），刷新 Key 模型。
      await trx.updateTable("provider_resource").set({
        credential_refresh_status: "OK",
        refresh_error_classification: null,
        updated_at: input.now,
      }).where("id", "=", row.id).execute();
      transition = deriveQuotaSyncRecovery(toQuotaRuntimeState(row));
      if (transition) {
        await trx.updateTable("provider_resource").set({
          status: transition.toStatus,
          consecutive_failures: transition.consecutiveFailures,
          cooldown_until: null,
          last_probe_at: null,
          updated_at: input.now,
        }).where("id", "=", row.id).execute();
        await trx.insertInto("resource_status_event").values({
          enterprise_id: row.enterprise_id,
          provider_resource_id: row.id,
          from_status: row.status,
          to_status: transition.toStatus,
          reason: transition.reason,
          error_classification: null,
          consecutive_failures: transition.consecutiveFailures,
          cooldown_until: null,
          actor: "system",
          created_at: input.now,
        }).execute();
        await refreshResourcePrincipalKeyModelsTx(trx, row);
      }
      if (input.previousIncidentId) {
        incidentsClosed = await this.assurance.recoverQuotaIncidentEventsTx(
          trx, row.id, input.previousIncidentId, input.now,
        );
      }
    } else if (input.exhaustedTransition && row.status !== "EXHAUSTED" && row.status !== "CREDENTIAL_INVALID") {
      // GET 观察到明确零值（发布初始化/新周期）→ EXHAUSTED。
      const exhaustionTransition = deriveResourceTransition(
        toQuotaRuntimeState(row),
        "UPSTREAM_BILLING_BLOCKED",
        input.now.getTime(),
      );
      if (exhaustionTransition) {
        await trx.updateTable("provider_resource").set({
          status: exhaustionTransition.toStatus,
          consecutive_failures: exhaustionTransition.consecutiveFailures,
          cooldown_until: exhaustionTransition.cooldownUntil ? new Date(exhaustionTransition.cooldownUntil) : null,
          last_probe_at: null,
          updated_at: input.now,
        }).where("id", "=", row.id).execute();
        await trx.insertInto("resource_status_event").values({
          enterprise_id: row.enterprise_id,
          provider_resource_id: row.id,
          from_status: row.status,
          to_status: exhaustionTransition.toStatus,
          reason: exhaustionTransition.reason,
          error_classification: "UPSTREAM_BILLING_BLOCKED",
          consecutive_failures: exhaustionTransition.consecutiveFailures,
          cooldown_until: null,
          actor: "system",
          created_at: input.now,
        }).execute();
        transition = exhaustionTransition;
      }
    }

    const blockActive = input.nextState !== null;
    const nextCheckAt = blockActive && (isIsolatedStatus(row.status) || transition)
      ? new Date(nextQuotaCheckAt(input.nextState, input.now, input.retryIntervalMs)!)
      : null;
    await trx.updateTable("provider_resource").set({
      quota_block_state: blockStateJsonValue(input.nextState),
      ...(nextCheckAt ? { cooldown_until: nextCheckAt } : {}),
      quota_state_revision: sql`quota_state_revision + 1`,
      updated_at: input.now,
    }).where("id", "=", row.id).execute();
    return {
      status: "COMMITTED",
      recovered: input.recovered,
      blockActive,
      nextCheckAt,
      incidentsClosed,
      block: input.nextState,
    };
  }

  /**
   * 提交事务内的 token 核验：锁资源 → provider FOR SHARE → 逐项比对。
   * 任何一项失配即 SUPERSEDED（仅元数据），不写当前事实。
   */
  private async verifyTokenTx(
    trx: Transaction<Database>,
    token: QuotaQueryToken,
  ): Promise<{ row: ProviderResourceRow } | { reason: QuotaCommitSupersededReason }> {
    const row = await trx
      .selectFrom("provider_resource")
      .selectAll()
      .where("id", "=", token.resourceId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return { reason: "RESOURCE_MISSING" };
    const provider = await trx
      .selectFrom("provider")
      .select(["status", "archived_at"])
      .where("enterprise_id", "=", row.enterprise_id)
      .where("id", "=", row.provider_id)
      .forKeyShare()
      .executeTakeFirst();
    if (!provider || provider.status !== "ACTIVE" || provider.archived_at !== null) {
      return { reason: "PROVIDER_UNAVAILABLE" };
    }
    if (row.mode !== "CODING_PLAN" || row.archived_at !== null) {
      return { reason: "RESOURCE_PREREQUISITE_CHANGED" };
    }
    if (row.version !== token.resourceVersion) return { reason: "RESOURCE_VERSION_CHANGED" };
    if ((row.credential_version ?? null) !== token.credentialVersion) return { reason: "CREDENTIAL_ROTATED" };
    if (Number(row.quota_state_revision) !== token.quotaStateRevision) return { reason: "QUOTA_REVISION_CHANGED" };
    if (currentIncidentId(row) !== token.incidentId) return { reason: "INCIDENT_CHANGED" };
    if (codingPlanQuotaEndpointHash(token.providerCode) !== token.endpointHash) {
      return { reason: "ENDPOINT_CHANGED" };
    }
    return { row };
  }

  /** PG 冲突最多两次短事务重试（计划§7）；token 在重试事务内重新核验，不重复 GET。 */
  private async withCommitRetry<T>(work: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        if (!isPgConflictError(error) || attempt === 2) return await Promise.reject(error);
        lastError = error;
      }
    }
    return await Promise.reject(lastError);
  }
}

function toQuotaRuntimeState(row: ProviderResourceRow) {
  return {
    status: row.status as ResourceStatus,
    consecutiveFailures: row.consecutive_failures,
    cooldownUntil: row.cooldown_until?.getTime() ?? null,
  };
}

function blockStateJsonValue(state: QuotaBlockState | null): Record<string, unknown> | null {
  return state === null ? null : (JSON.parse(serializeQuotaBlockState(state)) as Record<string, unknown>);
}

function isIsolatedStatus(status: string): boolean {
  return status === "RATE_LIMITED" || status === "EXHAUSTED" || status === "CREDENTIAL_INVALID";
}

function isPgConflictError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "40001" || code === "40P01";
}
