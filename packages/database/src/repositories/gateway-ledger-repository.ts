/**
 * Gateway 账本仓储 —— 请求/Attempt/usage/账本的完整闭环（W07）。
 *
 * 依据：TRD §5.7、§8（请求流程）、§10（计价结算）。
 * 这是 M2 最核心的仓储：把一次请求的 ai_request → route_candidate → upstream_attempt(s)
 * → usage_event(s) → ledger_line(s) → ledger_transaction 完整幂等写入。
 *
 * 重复结算为 0（M2 DoD）：
 *   - createLedgerTransaction 用 ON CONFLICT DO NOTHING（ai_request_id 唯一约束）
 *   - createUsageEvent 用 ON CONFLICT DO NOTHING（dedup_key 唯一约束）
 *
 * 安全：所有方法只存元数据，绝不接受 messages/prompt/system 正文参数。
 */
import type { Kysely } from "kysely";
import type { Database } from "../kysely.js";
import type {
  AiRequest,
  ClaimRequestResult,
  CreateAttemptInput,
  CreateRequestInput,
  LedgerLine,
  LedgerLineInput,
  LedgerTransaction,
  RouteCandidate,
  UpstreamAttempt,
  UsageEvent,
  UsageInput,
} from "./gateway-ledger-types.js";

export type * from "./gateway-ledger-types.js";

export class GatewayLedgerRepository {
  constructor(private db: Kysely<Database>) {}

  // ===== ai_request =====

  /** 创建请求意图（进入上游前；TRD §8.1 行 524）。 */
  async createRequest(input: CreateRequestInput): Promise<AiRequest> {
    const result = await this.claimRequest(input);
    if (result.kind !== "CREATED") {
      throw new Error(`ai_request claim unexpectedly returned ${result.kind}`);
    }
    return result.request;
  }

  /**
   * 原子认领请求意图。
   *
   * 无幂等键时总是以内部 UUID 新建；有幂等键时由数据库唯一索引保证只有一个
   * 调用者成为 CREATED，其余调用者读取原请求并按指纹区分 REPLAY/CONFLICT。
   */
  async claimRequest(input: CreateRequestInput): Promise<ClaimRequestResult> {
    const inserted = await this.db
      .insertInto("ai_request")
      .values({
        id: input.id,
        enterprise_id: input.enterprise_id,
        principal_id: input.principal_id,
        principal_key_id: input.principal_key_id,
        idempotency_key: input.idempotency_key ?? null,
        client_request_id: input.client_request_id ?? null,
        request_fingerprint: input.request_fingerprint ?? null,
        protocol: input.protocol,
        unified_model: input.unified_model,
        stream: input.stream ?? false,
        status: "IN_PROGRESS",
        client_id: input.client_id ?? null,
        agent_family: input.agent_family ?? "UNKNOWN",
        agent_version: input.agent_version ?? null,
        agent_identity_source: input.agent_identity_source ?? "NONE",
        agent_identity_confidence: input.agent_identity_confidence ?? "UNKNOWN",
        client_identity_rule_version: input.client_identity_rule_version ?? "legacy",
        started_at: new Date(),
      })
      .onConflict((oc) => oc
        .columns(["principal_key_id", "idempotency_key"])
        .where("idempotency_key", "is not", null)
        .doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted) return { kind: "CREATED", request: inserted };

    // 只有显式业务幂等键才可能走到冲突分支；并发 INSERT 完成后 PostgreSQL
    // 已保证原行可见，不需要应用层锁或二次上游调用。
    const existing = await this.db
      .selectFrom("ai_request")
      .selectAll()
      .where("principal_key_id", "=", input.principal_key_id)
      .where("idempotency_key", "=", input.idempotency_key!)
      .executeTakeFirstOrThrow();
    return existing.request_fingerprint === input.request_fingerprint
      ? { kind: "REPLAY", request: existing }
      : { kind: "CONFLICT", request: existing };
  }

  async updateRequestStatus(
    id: string,
    status: string,
    errorClassification?: string | null,
    errorCode?: string | null,
  ): Promise<void> {
    await this.db
      .updateTable("ai_request")
      .set({
        status,
        finished_at: new Date(),
        error_classification: errorClassification ?? null,
        error_code: errorCode ?? null,
      })
      .where("id", "=", id)
      .execute();
  }

  async getRequest(id: string): Promise<AiRequest | undefined> {
    return this.db.selectFrom("ai_request").selectAll().where("id", "=", id).executeTakeFirst();
  }

  // ===== route_candidate =====

  async createRouteCandidate(input: {
    ai_request_id: string;
    enterprise_id: string;
    provider_resource_id: string;
    upstream_model: string;
    priority: number;
    weight: number;
    selected?: boolean;
    /** W12：评分因子快照（归一化值数组，WT-18 可解释）。 */
    score_factors?: Record<string, unknown> | null;
    /** W12：加权总分（0..1，字符串 numeric）。 */
    total_score?: string | null;
    reason_code?: string | null;
  }): Promise<RouteCandidate> {
    return this.db
      .insertInto("route_candidate")
      .values({
        ai_request_id: input.ai_request_id,
        enterprise_id: input.enterprise_id,
        provider_resource_id: input.provider_resource_id,
        upstream_model: input.upstream_model,
        priority: input.priority,
        weight: input.weight,
        selected: input.selected ?? true,
        score_factors: input.score_factors
          ? (JSON.stringify(input.score_factors) as unknown as Record<string, unknown>)
          : null,
        total_score: input.total_score ?? null,
        reason_code: input.reason_code ?? null,
        created_at: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** W12：列出一个请求的全部路由候选快照（含未中选者）。 */
  async listRouteCandidates(requestId: string): Promise<RouteCandidate[]> {
    return this.db
      .selectFrom("route_candidate")
      .selectAll()
      .where("ai_request_id", "=", requestId)
      .orderBy("created_at", "asc")
      .execute();
  }

  // ===== upstream_attempt =====

  async createAttempt(input: CreateAttemptInput): Promise<UpstreamAttempt> {
    return this.db
      .insertInto("upstream_attempt")
      .values({
        ai_request_id: input.ai_request_id,
        enterprise_id: input.enterprise_id,
        attempt_no: input.attempt_no,
        provider_resource_id: input.provider_resource_id,
        upstream_model: input.upstream_model,
        started_at: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async updateAttemptResult(
    id: string,
    update: {
      http_status?: number | null;
      response_committed?: boolean;
      first_byte_at?: Date | null;
      finished_at?: Date | null;
      error_classification?: string | null;
      error_code?: string | null;
      failure_layer?: string | null;
      switch_reason?: string | null;
    },
  ): Promise<void> {
    await this.db.updateTable("upstream_attempt").set(update).where("id", "=", id).execute();
  }

  async listAttempts(requestId: string): Promise<UpstreamAttempt[]> {
    return this.db
      .selectFrom("upstream_attempt")
      .selectAll()
      .where("ai_request_id", "=", requestId)
      .orderBy("attempt_no", "asc")
      .execute();
  }

  // ===== usage_event（幂等：dedup_key 唯一）=====

  /**
   * 创建 usage_event。若 dedup_key 已存在（同一计量事实重放），ON CONFLICT DO NOTHING 不新增。
   * @returns 创建的 usage_event（若已存在则返回 undefined）
   */
  async createUsageEventIfAbsent(input: UsageInput): Promise<UsageEvent | undefined> {
    const result = await this.db
      .insertInto("usage_event")
      .values({
        ai_request_id: input.ai_request_id,
        enterprise_id: input.enterprise_id,
        upstream_attempt_id: input.upstream_attempt_id,
        provider_resource_id: input.provider_resource_id,
        input_tokens: input.input_tokens,
        output_tokens: input.output_tokens,
        cache_tokens: input.cache_tokens,
        reasoning_tokens: input.reasoning_tokens ?? 0n,
        usage_quality: input.usage_quality,
        dedup_key: input.dedup_key,
        upstream_usage_id: input.upstream_usage_id ?? null,
        created_at: new Date(),
      })
      .onConflict((oc) => oc.column("dedup_key").doNothing())
      .returningAll()
      .execute();
    return result[0];
  }

  async listUsageEvents(requestId: string): Promise<UsageEvent[]> {
    return this.db
      .selectFrom("usage_event")
      .selectAll()
      .where("ai_request_id", "=", requestId)
      .orderBy("created_at", "asc")
      .execute();
  }

  // ===== ledger_line（不可覆盖明细）=====

  async createLedgerLine(input: LedgerLineInput): Promise<LedgerLine> {
    return this.db
      .insertInto("ledger_line")
      .values({
        ai_request_id: input.ai_request_id,
        enterprise_id: input.enterprise_id,
        usage_event_id: input.usage_event_id,
        upstream_attempt_id: input.upstream_attempt_id,
        provider_resource_id: input.provider_resource_id,
        principal_id: input.principal_id,
        resource_mode: input.resource_mode,
        raw_input_tokens: input.raw_input_tokens,
        raw_output_tokens: input.raw_output_tokens,
        raw_cache_tokens: input.raw_cache_tokens,
        raw_reasoning_tokens: input.raw_reasoning_tokens ?? 0n,
        deducted_quota: input.deducted_quota ?? null,
        api_cost: input.api_cost ?? null,
        usage_quality: input.usage_quality,
        billing_rule_id: input.billing_rule_id ?? null,
        rule_version: input.rule_version ?? null,
        multiplier: input.multiplier ?? null,
        billing_rule_snapshot: input.billing_rule_snapshot ?? null,
        created_at: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async listLedgerLines(requestId: string): Promise<LedgerLine[]> {
    return this.db
      .selectFrom("ledger_line")
      .selectAll()
      .where("ai_request_id", "=", requestId)
      .orderBy("created_at", "asc")
      .execute();
  }

  // ===== ledger_transaction（幂等：ai_request_id 唯一）=====

  /**
   * 创建结算汇总。若该 ai_request 已有结算（重复请求），ON CONFLICT DO NOTHING 不新增。
   * @returns 创建的汇总（若已存在则返回 undefined）—— 重复结算为 0 的硬保证
   */
  async createLedgerTransactionIfAbsent(input: {
    ai_request_id: string;
    enterprise_id: string;
    principal_id: string;
    total_input_tokens: bigint;
    total_output_tokens: bigint;
    total_cache_tokens: bigint;
    total_reasoning_tokens?: bigint;
    total_deducted_quota: bigint;
    total_api_cost: string;
    /** 请求结算时冻结的超额事实。 */
    overage?: boolean;
    usage_quality: string;
    attempt_count: number;
  }): Promise<LedgerTransaction | undefined> {
    const result = await this.db
      .insertInto("ledger_transaction")
      .values({
        ai_request_id: input.ai_request_id,
        enterprise_id: input.enterprise_id,
        principal_id: input.principal_id,
        total_input_tokens: input.total_input_tokens,
        total_output_tokens: input.total_output_tokens,
        total_cache_tokens: input.total_cache_tokens,
        total_reasoning_tokens: input.total_reasoning_tokens ?? 0n,
        total_deducted_quota: input.total_deducted_quota,
        total_api_cost: input.total_api_cost,
        overage: input.overage ?? false,
        usage_quality: input.usage_quality,
        attempt_count: input.attempt_count,
        status: "SETTLED",
        created_at: new Date(),
      })
      .onConflict((oc) => oc.column("ai_request_id").doNothing())
      .returningAll()
      .execute();
    return result[0];
  }

  async getLedgerTransaction(requestId: string): Promise<LedgerTransaction | undefined> {
    return this.db
      .selectFrom("ledger_transaction")
      .selectAll()
      .where("ai_request_id", "=", requestId)
      .executeTakeFirst();
  }

  // ===== billing_rule（W13）=====

  /** 列出企业在某时间点后生效的启用规则（pipeline 按 attempt 时间匹配）。 */
  async listActiveBillingRules(enterpriseId: string, at: Date): Promise<
    Array<{
      id: string;
      rule_type: string;
      rule_version: string;
      provider_resource_id: string | null;
      upstream_model: string | null;
      effective_from: Date;
      effective_to: Date | null;
      timezone: string | null;
      days_of_week: number[] | null;
      start_time: string | null;
      end_time: string | null;
      time_windows: Array<{
        timezone: string;
        days_of_week: number[] | null;
        start_time: string;
        end_time: string;
      }> | null;
      multiplier: string | null;
      cache_hit_price: string | null;
      cache_miss_price: string | null;
      output_price: string | null;
      currency: string;
      priority: number;
    }>
  > {
    return this.db
      .selectFrom("billing_rule")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .where("enabled", "=", true)
      .where("effective_from", "<=", at)
      .execute() as never;
  }

  /** 列出企业全部计价规则（含 disabled/历史，管理后台用）。 */
  async listAllBillingRules(enterpriseId: string): Promise<
    Array<{
      id: string;
      rule_type: string;
      rule_version: string;
      provider_resource_id: string | null;
      upstream_model: string | null;
      effective_from: Date;
      effective_to: Date | null;
      timezone: string | null;
      days_of_week: number[] | null;
      start_time: string | null;
      end_time: string | null;
      time_windows: Array<{
        timezone: string;
        days_of_week: number[] | null;
        start_time: string;
        end_time: string;
      }> | null;
      multiplier: string | null;
      cache_hit_price: string | null;
      cache_miss_price: string | null;
      output_price: string | null;
      currency: string;
      priority: number;
      enabled: boolean;
      source: string | null;
      created_at: Date;
      updated_at: Date;
    }>
  > {
    return this.db
      .selectFrom("billing_rule")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .orderBy("priority", "asc")
      .orderBy("effective_from", "desc")
      .execute() as never;
  }

  async createBillingRule(input: {
    enterprise_id: string;
    rule_type: string;
    rule_version: string;
    provider_resource_id?: string | null;
    upstream_model?: string | null;
    effective_from: Date;
    effective_to?: Date | null;
    timezone?: string | null;
    days_of_week?: number[] | null;
    start_time?: string | null;
    end_time?: string | null;
    time_windows?: Array<{
      timezone: string;
      days_of_week: number[] | null;
      start_time: string;
      end_time: string;
    }> | null;
    multiplier?: string | null;
    cache_hit_price?: string | null;
    cache_miss_price?: string | null;
    output_price?: string | null;
    currency?: string;
    priority?: number;
    source?: string | null;
  }) {
    const firstWindow = input.time_windows?.[0];
    return this.db
      .insertInto("billing_rule")
      .values({
        enterprise_id: input.enterprise_id,
        rule_type: input.rule_type,
        rule_version: input.rule_version,
        provider_resource_id: input.provider_resource_id ?? null,
        upstream_model: input.upstream_model ?? null,
        effective_from: input.effective_from,
        effective_to: input.effective_to ?? null,
        timezone: firstWindow?.timezone ?? input.timezone ?? null,
        days_of_week: (firstWindow?.days_of_week ?? input.days_of_week)
          ? (JSON.stringify(firstWindow?.days_of_week ?? input.days_of_week) as unknown as number[])
          : null,
        start_time: firstWindow?.start_time ?? input.start_time ?? null,
        end_time: firstWindow?.end_time ?? input.end_time ?? null,
        time_windows: input.time_windows
          ? (JSON.stringify(input.time_windows) as unknown as typeof input.time_windows)
          : null,
        multiplier: input.multiplier ?? null,
        cache_hit_price: input.cache_hit_price ?? null,
        cache_miss_price: input.cache_miss_price ?? null,
        output_price: input.output_price ?? null,
        currency: input.currency ?? "CNY",
        priority: input.priority ?? 100,
        source: input.source ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
