import { sql, type RawBuilder } from "kysely";

/** Explicit administrator accounting decisions; original usage and pricing facts remain untouched. */
export function effectiveUsageCostDispositionSql(lineAlias = "line"): RawBuilder<boolean> {
  return sql<boolean>`provider_finance_usage_cost_exclusion_applies(
    ${sql.ref(`${lineAlias}.enterprise_id`)}, ${sql.ref(`${lineAlias}.id`)})`;
}
