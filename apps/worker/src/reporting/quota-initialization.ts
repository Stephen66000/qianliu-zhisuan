import { EmployeeQuotaRepository, type Database } from "@qianliu/database";
import { sql, type Kysely } from "kysely";

/** Idempotent catch-up: a paused Worker initializes the current month only, never an old month. */
export async function runEmployeeQuotaInitializationTick(input: { db: Kysely<Database>; now: Date; enterpriseId?: string }) {
  const schema = await sql<{ present: boolean }>`SELECT to_regclass('principal_quota_period') IS NOT NULL AS present`.execute(input.db);
  if (!schema.rows[0]?.present) return { initialized: 0 };
  return new EmployeeQuotaRepository(input.db).initializeCurrentQuotaPeriods({ now: input.now, enterpriseId: input.enterpriseId });
}
