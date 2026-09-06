import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../kysely.js";
import { hasConflictingPricingMode, lockPricingWrites } from "./pricing-write-guard.js";

/** Billing lifecycle writes retain their transaction, version and tenant boundaries. */
export class AdminBillingWrites {
  constructor(private db: Kysely<Database>) {}

  /** 更新计价规则（version 乐观锁；历史账本仍冻结原 rule_version）。 */
  async updateBillingRule(
    enterpriseId: string,
    id: string,
    expectedVersion: number,
    patch: {
      effective_to?: Date | null;
      enabled?: boolean;
    },
  ) {
    return this.db.transaction().execute(async (trx) => {
      await lockPricingWrites(trx, enterpriseId);
      const before = await trx.selectFrom("billing_rule").selectAll().where("id", "=", id)
        .where("enterprise_id", "=", enterpriseId).forUpdate().executeTakeFirst();
      if (!before || before.version !== expectedVersion) return undefined;
      const prospective = { ...before, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) };
      if (prospective.enabled && await hasConflictingPricingMode(trx, enterpriseId, prospective)) return undefined;
    return trx
      .updateTable("billing_rule")
      .set({ ...patch, version: sql`version + 1`, updated_at: new Date() })
      .where("id", "=", id)
      .where("enterprise_id", "=", enterpriseId)
      .where("archived_at", "is", null)
      .where(sql<boolean>`version = ${expectedVersion}`)
      .returningAll()
      .executeTakeFirst();
    });
  }

  async setBillingRuleArchived(
    enterpriseId: string,
    id: string,
    expectedVersion: number,
    archived: boolean,
    actorAdminId: string,
  ) {
    let query = this.db.updateTable("billing_rule").set({
      archived_at: archived ? new Date() : null,
      archived_by_admin_id: archived ? actorAdminId : null,
      version: sql`version + 1`,
      updated_at: new Date(),
    }).where("id", "=", id).where("enterprise_id", "=", enterpriseId)
      .where(sql<boolean>`version = ${expectedVersion}`);
    if (archived) query = query.where("enabled", "=", false).where("archived_at", "is", null);
    else query = query.where("archived_at", "is not", null);
    return query.returningAll().executeTakeFirst();
  }

}
