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
import type { Kysely, Selectable } from "kysely";
import type {
  Database,
  AiRequestTable,
  UpstreamAttemptTable,
  UsageEventTable,
  LedgerLineTable,
  LedgerTransactionTable,
  RouteCandidateTable,
} from "../kysely.js";

export type AiRequest = Selectable<AiRequestTable>;
export type UpstreamAttempt = Selectable<UpstreamAttemptTable>;
export type UsageEvent = Selectable<UsageEventTable>;
export type LedgerLine = Selectable<LedgerLineTable>;
export type LedgerTransaction = Selectable<LedgerTransactionTable>;
export type RouteCandidate = Selectable<RouteCandidateTable>;

export interface CreateRequestInput {
  id: string;
  enterprise_id: string;
  principal_id: string;
  principal_key_id: string;
  idempotency_key?: string | null;
  protocol: string;
  unified_model: string;
  stream?: boolean;
  client_id?: string | null;
}

export interface CreateAttemptInput {
  ai_request_id: string;
  enterprise_id: string;
  attempt_no: number;
  provider_resource_id: string;
  upstream_model: string;
}

export interface UsageInput {
  ai_request_id: string;
  enterprise_id: string;
  upstream_attempt_id: string;
  provider_resource_id: string;
  input_tokens: bigint;
  output_tokens: bigint;
  cache_tokens: bigint;
  usage_quality: string;
  dedup_key: string;
  upstream_usage_id?: string | null;
}

export interface LedgerLineInput {
  ai_request_id: string;
  enterprise_id: string;
  usage_event_id: string;
  upstream_attempt_id: string;
  provider_resource_id: string;
  principal_id: string;
  resource_mode: string;
  raw_input_tokens: bigint;
  raw_output_tokens: bigint;
  raw_cache_tokens: bigint;
  deducted_quota?: bigint | null;
  api_cost?: string | null;
  usage_quality: string;
  /** W13：冻结命中的计价规则（历史不重算）。 */
  billing_rule_id?: string | null;
  rule_version?: string | null;
  multiplier?: string | null;
}

export class GatewayLedgerRepository {
  constructor(private db: Kysely<Database>) {}

  // ===== ai_request =====

  /** 创建请求意图（进入上游前；TRD §8.1 行 524）。 */
  async createRequest(input: CreateRequestInput): Promise<AiRequest> {
    return this.db
      .insertInto("ai_request")
      .values({
        id: input.id,
        enterprise_id: input.enterprise_id,
        principal_id: input.principal_id,
        principal_key_id: input.principal_key_id,
        idempotency_key: input.idempotency_key ?? null,
        protocol: input.protocol,
        unified_model: input.unified_model,
        stream: input.stream ?? false,
        status: "IN_PROGRESS",
        client_id: input.client_id ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
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
        usage_quality: input.usage_quality,
        dedup_key: input.dedup_key,
        upstream_usage_id: input.upstream_usage_id ?? null,
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
        deducted_quota: input.deducted_quota ?? null,
        api_cost: input.api_cost ?? null,
        usage_quality: input.usage_quality,
        billing_rule_id: input.billing_rule_id ?? null,
        rule_version: input.rule_version ?? null,
        multiplier: input.multiplier ?? null,
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
    total_deducted_quota: bigint;
    total_api_cost: string;
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
        total_deducted_quota: input.total_deducted_quota,
        total_api_cost: input.total_api_cost,
        usage_quality: input.usage_quality,
        attempt_count: input.attempt_count,
        status: "SETTLED",
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
    multiplier?: string | null;
    cache_hit_price?: string | null;
    cache_miss_price?: string | null;
    output_price?: string | null;
    currency?: string;
    priority?: number;
    source?: string | null;
  }) {
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
        timezone: input.timezone ?? null,
        days_of_week: input.days_of_week
          ? (JSON.stringify(input.days_of_week) as unknown as number[])
          : null,
        start_time: input.start_time ?? null,
        end_time: input.end_time ?? null,
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
