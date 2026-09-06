import type { Kysely } from "kysely";
import type { Database } from "../kysely.js";
import { hasConflictingPricingMode, lockPricingWrites, PricingModeConflictError } from "./pricing-write-guard.js";

/** Billing persistence shared by the ledger facade; the supplied transaction is preserved. */
export class BillingRulePersistence {
  constructor(private db: Kysely<Database>) {}

  // ===== billing_rule（W13）=====

  /** 列出企业在某时间点后生效的启用规则（pipeline 按 attempt 时间匹配）。 */
  async listActiveBillingRules(enterpriseId: string, at: Date): Promise<
    Array<{
      pricing_mode?: "ABSOLUTE" | "MULTIPLIER";
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
      .where("archived_at", "is", null)
      .where("effective_from", "<=", at)
      .execute() as never;
  }

  /** 列出企业全部计价规则（含 disabled/历史，管理后台用）。 */
  async listAllBillingRules(
    enterpriseId: string,
    archived: "exclude" | "only" | "all" = "exclude",
  ): Promise<
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
      version: number;
      archived_at: Date | null;
      archived_by_admin_id: string | null;
      created_at: Date;
      updated_at: Date;
    }>
  > {
    let query = this.db
      .selectFrom("billing_rule")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .orderBy("priority", "asc")
      .orderBy("effective_from", "desc");
    if (archived === "only") query = query.where("archived_at", "is not", null);
    if (archived === "exclude") query = query.where("archived_at", "is", null);
    return query.execute() as never;
  }

  async createBillingRule(input: {
    pricing_mode?: "ABSOLUTE" | "MULTIPLIER";
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
    const create = async (db: Kysely<Database>) => {
    await lockPricingWrites(db, input.enterprise_id);
    if (await hasConflictingPricingMode(db, input.enterprise_id, input)) throw new PricingModeConflictError();
    return db
      .insertInto("billing_rule")
      .values({
        enterprise_id: input.enterprise_id,
        rule_type: input.rule_type,
        pricing_mode: input.pricing_mode ?? "ABSOLUTE",
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
    };
    return this.db.isTransaction ? create(this.db) : this.db.transaction().execute(create);
  }
}
