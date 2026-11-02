import type { Kysely } from "kysely";
import type { Database } from "../kysely.js";
import { createMigrator } from "../migrator.js";

/** Legacy rollback rehearsals start at 0072: later notification/report/monthly retention FKs are outside their tested interval. */
export const PRE_MONTHLY_FIXTURE_HEAD = "0072_admin_roles_security";
export async function migrateToPreMonthlyFixtureHead(db: Kysely<Database>): Promise<string[]> {
  const result = await createMigrator(db).migrateTo(PRE_MONTHLY_FIXTURE_HEAD);
  if (result.error) throw result.error;
  return (result.results ?? []).filter(row => row.status === "Success").map(row => row.migrationName);
}
