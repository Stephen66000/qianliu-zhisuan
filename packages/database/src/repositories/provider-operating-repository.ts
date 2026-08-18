import type { Kysely, Selectable } from "kysely";
import { sql } from "kysely";
import type {
  Database,
  ProviderResourceOperatingSnapshotTable,
  ProviderResourceTable,
} from "../kysely.js";
import {
  projectCurrentOperatingSnapshots,
  type CurrentProviderOperatingSnapshot,
} from "./provider-operating.js";
import type { OperatingSnapshotInput } from "./provider-types.js";

export type ProviderResourceOperatingSnapshot = Selectable<ProviderResourceOperatingSnapshotTable>;
export interface ProviderOperatingSyncState {
  provider_resource_id: string;
  balance_status: "SUCCESS" | "FAILED" | "NOT_SUPPORTED";
  cost_status: "SUCCESS" | "FAILED" | "NOT_SUPPORTED";
  provider_data_at: Date | null;
  last_success_data_at: Date | null;
  completed_at: Date;
  next_sync_at: Date;
  error_code: string | null;
  failure_reason: string | null;
  adapter_version: string;
}
type ProviderResource = Selectable<ProviderResourceTable>;

/** 厂商经营快照的不可变历史与当前投影。 */
export abstract class ProviderOperatingRepository {
  constructor(protected db: Kysely<Database>) {}

  abstract listResources(enterpriseId: string): Promise<ProviderResource[]>;

  async listLatestOperatingSnapshots(
    enterpriseId: string,
  ): Promise<ProviderResourceOperatingSnapshot[]> {
    const result = await sql<ProviderResourceOperatingSnapshot>`
      SELECT DISTINCT ON (provider_resource_id) *
        FROM provider_resource_operating_snapshot
       WHERE enterprise_id = ${enterpriseId}
       ORDER BY provider_resource_id, version DESC
    `.execute(this.db);
    return result.rows;
  }

  async listCurrentOperatingSnapshots(
    enterpriseId: string,
    now: Date = new Date(),
  ): Promise<CurrentProviderOperatingSnapshot[]> {
    const [snapshots, resources] = await Promise.all([
      this.listLatestOperatingSnapshots(enterpriseId),
      this.listResources(enterpriseId),
    ]);
    return projectCurrentOperatingSnapshots(
      this.db,
      enterpriseId,
      snapshots,
      new Map(resources.map((resource) => [resource.id, resource.mode])),
      now,
    );
  }

  async listLatestOperatingSyncStates(enterpriseId: string): Promise<ProviderOperatingSyncState[]> {
    const result = await sql<ProviderOperatingSyncState>`
      WITH ranked AS (
        SELECT a.*,
               MAX(provider_data_at) FILTER (WHERE balance_status = 'SUCCESS') OVER (
                 PARTITION BY provider_resource_id
               ) AS last_success_data_at,
               ROW_NUMBER() OVER (
                 PARTITION BY provider_resource_id ORDER BY completed_at DESC, created_at DESC
               ) AS row_no
          FROM provider_resource_operating_sync_attempt a
         WHERE enterprise_id = ${enterpriseId}
      )
      SELECT provider_resource_id, balance_status, cost_status, provider_data_at,
             last_success_data_at, completed_at, next_sync_at, error_code,
             failure_reason, adapter_version
        FROM ranked
       WHERE row_no = 1
    `.execute(this.db);
    return result.rows;
  }

  async listOperatingSnapshotHistory(
    enterpriseId: string,
    providerResourceId: string,
    limit: number = 20,
  ): Promise<ProviderResourceOperatingSnapshot[]> {
    return this.db
      .selectFrom("provider_resource_operating_snapshot")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .where("provider_resource_id", "=", providerResourceId)
      .orderBy("version", "desc")
      .limit(limit)
      .execute();
  }

  async appendOperatingSnapshot(
    enterpriseId: string,
    providerResourceId: string,
    input: OperatingSnapshotInput,
  ): Promise<ProviderResourceOperatingSnapshot | null> {
    return this.db.transaction().execute(async (trx) => {
      const resource = await trx
        .selectFrom("provider_resource")
        .select("id")
        .where("id", "=", providerResourceId)
        .where("enterprise_id", "=", enterpriseId)
        .forUpdate()
        .executeTakeFirst();
      if (!resource) return null;
      const latest = await trx
        .selectFrom("provider_resource_operating_snapshot")
        .select("version")
        .where("provider_resource_id", "=", providerResourceId)
        .orderBy("version", "desc")
        .executeTakeFirst();
      return this.insertOperatingSnapshot(
        trx,
        enterpriseId,
        providerResourceId,
        (latest?.version ?? 0) + 1,
        input,
      );
    });
  }

  protected async insertOperatingSnapshot(
    db: Kysely<Database>,
    enterpriseId: string,
    providerResourceId: string,
    version: number,
    input: OperatingSnapshotInput,
  ): Promise<ProviderResourceOperatingSnapshot> {
    return db
      .insertInto("provider_resource_operating_snapshot")
      .values({
        enterprise_id: enterpriseId,
        provider_resource_id: providerResourceId,
        version,
        source: input.source,
        collected_at: input.collected_at,
        currency: input.currency ?? null,
        recharge_amount: input.recharge_amount ?? null,
        current_balance: input.current_balance ?? null,
        granted_balance: input.granted_balance ?? null,
        topped_up_balance: input.topped_up_balance ?? null,
        provider_balance_available: input.provider_balance_available ?? null,
        balance_source: input.balance_source ?? null,
        cost_source: input.cost_source ?? null,
        cumulative_cost: input.cumulative_cost ?? null,
        current_period_cost: input.current_period_cost ?? null,
        cost_period_start: input.cost_period_start ?? null,
        cost_period_end: input.cost_period_end ?? null,
        balance_updated_at: input.balance_updated_at ?? null,
        package_name: input.package_name ?? null,
        package_cost: input.package_cost ?? null,
        total_quota: input.total_quota ?? null,
        quota_unit: input.quota_unit ?? null,
        used_quota: input.used_quota ?? null,
        remaining_quota: input.remaining_quota ?? null,
        effective_from: input.effective_from ?? null,
        effective_until: input.effective_until ?? null,
        reset_cycle: input.reset_cycle ?? null,
        reset_anchor_at: input.reset_anchor_at ?? null,
        reset_timezone: input.reset_timezone ?? null,
        usage_calculation: input.usage_calculation ?? "MANUAL_SNAPSHOT",
        next_reset_at: input.next_reset_at ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
